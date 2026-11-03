// lib/core.js —— 轮询引擎：配置门、getUpdates 循环、收件箱、sendMessage、on_message 应答。
//
// 三条铁律在这里落地：
//   1. 未配置（botToken 或 chatId 缺）⇒ configured() 为 false ⇒ 不发任何请求：
//      不 getUpdates、不 sendMessage、连 plugins.services 都不问（必测第一条）。
//   2. 薄适配器不主动调别的插件（manifest 无 callTargets）：收到的消息只发布到
//      share 键 telegram-inbox（环形 20 条），谁想要谁读。
//   3. 断网退避：连续失败 15s 起步、每次翻倍、上限 5 分钟；成功即回 15s。
//
// 本文件不定义宿主桥——桥归 app.js（经典 script 共享全局作用域时它本可以在这里，
// 但把"收发消息的唯一通道"放在入口文件里，与 habits / anniversary / convert-kit
// 的分层一致：lib 是纯 IIFE，app 自洽）。app.js 启动时调 useBridge() 把
// request / can / hostServes 递进来，本文件对宿主的全部调用都走那三个函数。

'use strict';

(function () {
  // --- 配置与持久状态 ---------------------------------------------------------

  const KEY_OFFSET = 'tg-offset';   // Telegram update 游标（数字字符串）
  const KEY_LASTMSG = 'tg-last-at'; // 最后一次收到消息的时刻（数字字符串）
  const SHARE_INBOX = 'telegram-inbox';
  const INBOX_MAX = 20;
  const BACKOFF_BASE_MS = 15000;
  const BACKOFF_MAX_MS = 300000;
  const ERROR_LIMIT = 200;

  let cfg = { botToken: '', chatId: '', pollTimeout: '25' };
  let offset = 0;              // 下一次 getUpdates 的游标（= 上次最大 update_id + 1，已持久化）
  let failCount = 0;           // 连续失败次数：退避 15s → 30s → 60s …上限 5 分钟
  let lastError = '';          // 插件页可读的错误态（409/401/断网…）
  let lastPollAt = 0;
  let pollRunning = false;
  let stopped = false;
  const notes = [];            // 面板事件（不含消息正文）
  const inbox = [];            // 环形收件箱（本帧内存态；share 上是快照）

  /** 时钟注入点：测试用 __telegram.setClock 换掉。 */
  let clock = () => Date.now();

  /** paint 钩子：app.js 接上（轮询循环每拍后刷新可见状态）。 */
  let paintFn = () => {};

  // --- 桥（app.js 注入）--------------------------------------------------------

  const bridge = {
    request: () => Promise.reject(new Error('宿主桥还没接线（useBridge）')),
    can: () => false,
    hostServes: () => true,
  };

  function useBridge(b) {
    if (b && typeof b.request === 'function') bridge.request = b.request;
    if (b && typeof b.can === 'function') bridge.can = b.can;
    if (b && typeof b.hostServes === 'function') bridge.hostServes = b.hostServes;
  }

  // --- 小工具 ------------------------------------------------------------------

  function text(value, max) {
    const s = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
    const limit = Number.isFinite(max) && max > 0 ? max : ERROR_LIMIT;
    return s.length > limit ? `${s.slice(0, limit)}…` : s;
  }

  function now() { return clock(); }

  /** 配置门：token 与 chat id 都有才算配置齐。**任何网络请求前都要过这道门。** */
  function configured() {
    return Boolean(String(cfg.botToken || '').trim()) && Boolean(String(cfg.chatId || '').trim());
  }

  function apiBase() {
    return `https://api.telegram.org/bot${String(cfg.botToken || '').trim()}`;
  }

  function backoffMs() {
    const ms = BACKOFF_BASE_MS * Math.pow(2, Math.max(0, failCount - 1));
    return Math.min(BACKOFF_MAX_MS, ms);
  }

  function note(line) {
    notes.push({ at: now(), line: text(line, 160) });
    while (notes.length > 40) notes.shift();
  }

  // --- 配置与持久化 ------------------------------------------------------------

  async function refreshConfig() {
    if (!bridge.can('plugin.config')) return; // 没授予就不问（granted=[] 零请求）
    const out = await bridge.request('config.get', {});
    const values = (out && out.values) || {};
    cfg = {
      botToken: String(values.botToken || ''),
      chatId: String(values.chatId || ''),
      pollTimeout: String(values.pollTimeout || '25'),
    };
  }

  async function loadState() {
    if (!bridge.can('storage')) return; // 没授予就不问（granted=[] 零请求）
    const [a, b] = await Promise.all([
      bridge.request('storage.get', { key: KEY_OFFSET }).catch(() => ({ value: '' })),
      bridge.request('storage.get', { key: KEY_LASTMSG }).catch(() => ({ value: '' })),
    ]);
    const n = Number.parseInt(String((a && a.value) || ''), 10);
    offset = Number.isFinite(n) && n > 0 ? n : 0;
    lastPollAt = Number.parseInt(String((b && b.value) || ''), 10) || 0;
  }

  async function saveOffset() {
    await bridge.request('storage.set', { key: KEY_OFFSET, value: String(offset) }).catch(() => {});
  }

  async function saveLastAt() {
    await bridge.request('storage.set', { key: KEY_LASTMSG, value: String(now()) }).catch(() => {});
  }

  // --- 收件箱（share 环形 20 条）------------------------------------------------

  function inboxValue() {
    return JSON.stringify({ at: now(), messages: inbox });
  }

  /** 发布一条新消息：环形保留最近 INBOX_MAX 条。没授予 plugin.share 就只留内存（不报错）。 */
  async function publishInbox(msg) {
    inbox.push(msg);
    while (inbox.length > INBOX_MAX) inbox.shift();
    if (!bridge.can('plugin.share')) return;
    try {
      await bridge.request('share.set', { name: SHARE_INBOX, value: inboxValue() });
    } catch (err) {
      note(`发布收件箱失败：${text(err && err.message, 120)}`);
    }
  }

  // --- 轮询 --------------------------------------------------------------------

  /**
   * 一轮 getUpdates。返回 true 表示"这轮成功了"（哪怕零消息）。
   * **调用方必须先过 configured() 门**——这个函数自己不发未配置的请求。
   */
  async function pollOnce() {
    const timeoutSec = Math.max(0, Math.min(50, Number.parseInt(cfg.pollTimeout, 10) || 0));
    const url = `${apiBase()}/getUpdates?timeout=${timeoutSec}&offset=${offset}`
      + `&allowed_updates=${encodeURIComponent('["message","edited_message","channel_post","edited_channel_post"]')}`;
    let res;
    try {
      res = await bridge.request('net.fetch', { method: 'GET', url });
    } catch (err) {
      failCount += 1;
      lastError = text(`getUpdates 失败：${(err && err.message) || err}`, ERROR_LIMIT);
      note(lastError);
      return false;
    }
    if (res && res.truncated) {
      failCount += 1;
      lastError = 'getUpdates 响应被截断（truncated），本轮丢弃';
      note(lastError);
      return false;
    }
    let data;
    try {
      data = JSON.parse((res && res.body) || '{}');
    } catch {
      failCount += 1;
      lastError = 'getUpdates 返回不是 JSON';
      note(lastError);
      return false;
    }
    if (!data.ok) {
      failCount += 1;
      // Telegram 的 error_code / description 原样上屏：401（token 错）、409（Conflict，
      // 另一个进程在轮询同一个 bot）、429（限流）都在这里能看见。
      lastError = text(`getUpdates ${data.error_code || ''}: ${data.description || '未知错误'}`, ERROR_LIMIT);
      note(lastError);
      return false;
    }
    failCount = 0;
    lastError = '';
    lastPollAt = now();
    const { messages, nextOffset } = window.TelegramConvert.batchToMessages(data.result || [], offset);
    for (const msg of messages) {
      void publishInbox(msg).catch(() => {});
    }
    if (messages.length > 0) {
      note(`收到 ${messages.length} 条消息（chat ${messages[0].chatId}）`);
      void saveLastAt().catch(() => {});
    }
    if (nextOffset !== offset) {
      offset = nextOffset;
      void saveOffset().catch(() => {});
    }
    return true;
  }

  /** 常驻循环的下一拍：成功睡 15s，失败睡 backoffMs()（15s 起步、翻倍、上限 5 分钟）。 */
  function scheduleNext(ok) {
    if (stopped) return;
    const delay = ok ? BACKOFF_BASE_MS : backoffMs();
    setTimeout(() => { void pollLoop(); }, delay);
  }

  async function pollLoop() {
    if (pollRunning || stopped) return;
    pollRunning = true;
    try {
      if (!configured()) { stopped = true; paintFn(); return; } // 配置被清空：停下，不发请求
      const ok = await pollOnce();
      paintFn();
      scheduleNext(ok);
    } finally {
      pollRunning = false;
    }
  }

  /** 启动（只由 init 路径调用；已配置才真的开始）。 */
  function startPolling() {
    stopped = false;
    if (!configured()) { paintFn(); return; }
    if (pollRunning) return;
    void pollLoop();
  }

  function stopPolling() {
    stopped = true;
  }

  // --- 发送（手动一条路）--------------------------------------------------------

  /**
   * 手动 sendMessage。未配置 / 无 net.fetch 授权时直接抛中文原因，一个请求都不发。
   * chatId 缺省用配置里的默认目标。
   */
  async function sendMessage(chatId, msgText) {
    if (!bridge.can('net.fetch')) throw new Error('未获权限 net.fetch：发不了消息（安装时未勾选）');
    if (!bridge.hostServes('net.fetch')) {
      throw new Error('本程序不支持该方法 net.fetch：这一面没有网络能力（手册 §9）。');
    }
    if (!String(cfg.botToken || '').trim()) throw new Error('还没有配置 Bot Token：在设置里填好再发');
    const target = String(chatId || '').trim() || String(cfg.chatId || '').trim();
    if (!target) throw new Error('没有发送目标：填一个 chat id（或先在设置里填默认目标）');
    const body = window.TelegramConvert.sendBody(target, msgText);
    if (!body || body === '{}') throw new Error('消息文本为空');
    let res;
    try {
      res = await bridge.request('net.fetch', {
        method: 'POST',
        url: `${apiBase()}/sendMessage`,
        headers: { 'content-type': 'application/json' },
        body,
      });
    } catch (err) {
      const msg = text(`sendMessage 失败：${(err && err.message) || err}`, ERROR_LIMIT);
      lastError = msg;
      note(msg);
      throw new Error(msg);
    }
    let data;
    try {
      data = JSON.parse((res && res.body) || '{}');
    } catch {
      const msg = 'sendMessage 返回不是 JSON';
      lastError = msg;
      note(msg);
      throw new Error(msg);
    }
    if (!data.ok) {
      const msg = text(`sendMessage ${data.error_code || ''}: ${data.description || '未知错误'}`, ERROR_LIMIT);
      lastError = msg;
      note(msg);
      throw new Error(msg);
    }
    note(`已发送到 ${target}`);
    return { ok: true, messageId: data.result && data.result.message_id };
  }

  // --- on_message serve（查询接口：返回自某下标起的新消息）-------------------------
  //
  // 这里的 offset 是收件箱里的**数组下标**语义（0 = 全部、返回值里给"下次从哪读"），
  // 不是 Telegram 的 update 游标——查询方按自己上次读到的位置问，不消耗轮询游标。

  function serveOnMessage(payload) {
    const from = Number.parseInt(String((payload && payload.offset) || 0), 10) || 0;
    const messages = from > 0 ? inbox.slice(from) : inbox.slice();
    return {
      messages,
      offset: from + messages.length, // 下一次带这个值来，只拿增量
      total: inbox.length,
      at: now(),
    };
  }

  /** plugin.call 的入口：不认识的方法回中文拒绝（调用方拿到的就是这句）。 */
  async function answerCall(method, payload) {
    if (method !== 'on_message') {
      throw new Error(`不认识方法 ${method}：本插件只答 on_message（payload {offset} → {messages, offset, total}）`);
    }
    return serveOnMessage(payload);
  }

  // --- 面板状态（app.js 读它渲染）------------------------------------------------

  function snapshot() {
    return {
      configured: configured(),
      offset,
      failCount,
      backoffMs: backoffMs(),
      lastError,
      lastPollAt,
      inboxCount: inbox.length,
      notes: notes.slice(-12),
      pollRunning,
      stopped,
      keys: { KEY_OFFSET, KEY_LASTMSG, SHARE_INBOX, INBOX_MAX },
    };
  }

  // --- 测试接缝 ----------------------------------------------------------------

  window.TelegramCore = Object.freeze({
    useBridge,
    setPaint: (fn) => { paintFn = typeof fn === 'function' ? fn : () => {}; },
    setClock: (fn) => { clock = typeof fn === 'function' ? fn : () => Date.now(); },
    setConfigured: (token, chat) => {
      cfg.botToken = token === undefined ? cfg.botToken : String(token);
      cfg.chatId = chat === undefined ? cfg.chatId : String(chat);
    },
    ingestUpdate: (update) => {
      const msg = window.TelegramConvert.updateToMessage(update);
      if (msg) void publishInbox(msg).catch(() => {});
      return msg;
    },
    refreshConfig,
    loadState,
    pollOnce,
    scheduleNext,
    startPolling,
    stopPolling,
    sendMessage,
    serveOnMessage,
    answerCall,
    configured,
    chatDefault: () => String(cfg.chatId || ''), // 插件页预填用（不含 token）
    backoffMs: () => backoffMs(),
    snapshot,
    reset: () => {
      inbox.length = 0;
      notes.length = 0;
      failCount = 0;
      lastError = '';
      offset = 0;
      stopped = false;
    },
  });

  window.__telegram = window.TelegramCore; // 测试接缝别名
})();
