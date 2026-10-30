// lib/workshop.js —— 工坊页渲染 + 机器人总装配
//
// 机器人主循环住在这里（背景帧与工坊页共用这份代码，app.js 只负责按 slot 分发）：
//   事件(ws.message) → onSocketFrame(gateway) → handleDispatch → inbound.onMessage
//   → composeReply(llm) → sendPassiveReply(sender) → logEvent
//
// 工坊页是"另一个进程看同一批文件的眼睛"：状态卡、会话列表、日志。它是只读的
// （用户在宿主的插件设置里改配置），每 5 秒重读一次，让另一边的动静显示出来。
'use strict';

// --- 机器人总装配 -------------------------------------------------------------

let botStarted = false;

function startBot() {
  if (botStarted) return;
  botStarted = true;
  setInboundHandler(onInboundMessage);
  startGateway({
    onDispatch: handleEventType,
    onState: renderState,
  });
  renderState(gw.state);
  note('机器人已启动（QQ 官方开放平台）');
}

/** 一条进来的 QQ 消息 → 生成 → 回复。 */
async function onInboundMessage(msg) {
  const reply = shouldReply(msg);
  if (!reply) return;
  // 没授权就别发请求：宿主会拒绝，而且历史也写不进去（storage 同样被拒）。
  if (!granted.has('net.fetch') || !granted.has('llm.chat')) {
    note('缺少 net.fetch 或 llm.chat 授权，无法回复');
    return;
  }
  const state = await loadSessionState(msg.openid);
  const cooldown = num(cfg.cooldownSec, 3);
  if (withinCooldown(state, cooldown)) {
    note(`会话 ${truncate(msg.openid, 10)} 冷却中，忽略`);
    return;
  }
  const text = await composeReply(msg);
  if (!text) return;
  const result = await sendPassiveReply(msg, text, state);
  if (result.ok) {
    state.lastReplyAt = Date.now();
    await saveSessionState(msg.openid, state);
    await logEvent('已回复', `${msg.kind} ${truncate(msg.openid, 10)} → ${truncate(text, 60)}`);
  } else {
    // 保存 seq 计数（即使失败也要记：部分失败场景下计数仍前进）。
    await saveSessionState(msg.openid, state);
    await logEvent('回复失败', `${msg.kind} ${truncate(msg.openid, 10)}：${result.detail}`);
  }
}

// --- 主题 ---------------------------------------------------------------------

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

applyTheme(new URLSearchParams(location.search).get('theme'));

// --- 状态卡 -------------------------------------------------------------------

const STATE_LABEL = {
  closed: ['未连接', 'off'],
  connecting: ['连接中', 'wait'],
  open: ['在线', 'on'],
  error: ['异常', 'off'],
};

function renderState(state, extra) {
  if (view === 'background') return;
  const [label, kind] = STATE_LABEL[state] || STATE_LABEL.closed;
  if (els.chipState) {
    els.chipState.textContent = label;
    els.chipState.dataset.state = kind;
  }
  if (els.chipSelf) {
    // 工坊页与后台是两个进程，gw.bot 在工坊页里永远是 null。
    // 机器人名从 READY 事件写入 storage 'bot/info' 的 extra 里读取。
    if (extra && extra.username) {
      els.chipSelf.textContent = `机器人：${extra.username}`;
    } else {
      els.chipSelf.textContent = '机器人：未鉴权';
    }
  }
  if (state === 'error' && extra && extra.reason && els.statusError) {
    els.statusError.hidden = false;
    els.statusError.textContent = extra.reason;
  } else if (els.statusError) {
    els.statusError.hidden = true;
  }
  if (els.statusNote) {
    els.statusNote.textContent = String(cfg.appId || '').trim()
      ? `AppID ${cfg.appId} · 订阅 ${cfg.intentsPreset} · 会话历史存在插件自己的目录里`
      : '先在插件设置里填 AppID 与 AppSecret，机器人才能上线。';
  }
}

// --- 会话列表 ------------------------------------------------------------------
//
// 会话历史键是 `s/<8位十六进制哈希>`（见 core.js 的 flatKey），节流状态是 `m/<同一个哈希>`
// （metaKey）——两个**同级**目录，因为 `s/<哈希>` 是文件，它不可能是 `s/<哈希>/meta` 的父目录
// （那正是 2026-10-29 那 6 次 mkdir 失败）。所以这一页只列 `s/`，看到的就是往来，不需要再按
// 名字长度把 meta 筛出去。

async function renderSessions() {
  if (view === 'background' || !els.botList) return;
  if (!granted.has('storage')) return;
  const res = await request('storage.list', { sub: 's' }).catch(() => ({ files: [], dirs: [] }));
  const files = (res && res.files) || [];
  if (!files.length) {
    els.botEmpty.hidden = false;
    els.botList.hidden = true;
    return;
  }
  els.botEmpty.hidden = true;
  els.botList.hidden = false;
  const rows = [];
  for (const f of files) {
    if (f.name.length !== 8) continue; // 只认 8 位哈希：别的名字不是会话键
    const raw = await storageGet(`s/${f.name}`).catch(() => '');
    let history = [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) history = parsed;
    } catch { /* 坏键跳过，不让一个键拖死整个列表 */ }
    if (!history.length) continue;
    const last = history[history.length - 1];
    rows.push({
      key: `s/${f.name}`,
      // The throttling state lives in a SIBLING folder, not under the transcript key:
      // `s/<hash>` is a file, so `s/<hash>/meta` could never be created.
      stateKey: metaKeyForFlat(`s/${f.name}`),
      turns: history.length,
      at: Number(last.at) || 0,
      preview: truncate(String(last.text || ''), 40),
    });
  }
  rows.sort((a, b) => b.at - a.at);
  els.botList.textContent = '';
  for (const row of rows.slice(0, 20)) {
    const li = document.createElement('li');
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = row.key.replace(/^s\//, '');
    const what = document.createElement('span');
    what.className = 'what';
    what.textContent = `${row.turns} 条 · ${row.preview}`;
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = row.at ? new Date(row.at).toLocaleString('zh-CN', { hour12: false }) : '';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ghost small';
    del.textContent = '忘掉';
    del.addEventListener('click', () => {
      void (async () => {
        await request('storage.remove', { key: row.key }).catch(() => {});
        await request('storage.remove', { key: row.stateKey }).catch(() => {});
        await renderSessions();
      })();
    });
    li.append(who, what, when, del);
    els.botList.appendChild(li);
  }
  if (!rows.length) {
    els.botEmpty.hidden = false;
    els.botList.hidden = true;
  }
}

// --- 日志 ---------------------------------------------------------------------

async function renderLog() {
  if (view === 'background' || !els.log) return;
  const list = await loadLog();
  if (!list.length) {
    els.logEmpty.hidden = false;
    els.log.hidden = true;
    return;
  }
  els.logEmpty.hidden = true;
  els.log.hidden = false;
  els.log.textContent = '';
  for (const item of list.slice(-40).reverse()) {
    const li = document.createElement('li');
    const t = document.createElement('time');
    t.textContent = item.at ? new Date(item.at).toLocaleTimeString('zh-CN', { hour12: false }) : '';
    const k = document.createElement('b');
    k.textContent = item.kind;
    const x = document.createElement('span');
    x.textContent = item.text;
    li.append(t, k, x);
    els.log.appendChild(li);
  }
}

async function renderWorkshop() {
  // 工坊页与后台是两个进程，gw.state 在工坊页里永远是 'closed'。
  // 机器人是否在线，以 storage 'bot/info' 是否存在为准（后台 READY 时写入）。
  let botInfo = null;
  if (granted.has('storage')) {
    botInfo = await loadBotInfo();
  }
  renderState(botInfo ? 'open' : 'closed', botInfo ? { username: botInfo.username || botInfo.id || '' } : {});

  // 没授予 storage 时这两块就是空的；控件降级而不是停在半截。
  if (granted.has('storage')) {
    await renderSessions();
    await renderLog();
  }
  // 模型是谁的：控制中心不提供 llm.profile，只在桌宠背景帧才查；
  // 工坊页只做降级展示，不发 llm.profile 请求（否则每 5 秒一条 WARN）。
  if (els.chipModel) {
    if (view === 'background' && (granted.has('llm.borrow') || granted.has('llm.chat'))) {
      const profile = await llmProfile();
      const src = profile.source === 'own' ? '自己的配置' : profile.source === 'borrowed' ? `借用 ${profile.lender ? profile.lender.name : '对话插件'}` : '未配置';
      els.chipModel.textContent = `模型：${profile.ready ? `${profile.model || '默认'}（${src}）` : `不可用（${src}）`}`;
    } else if (view === 'background') {
      els.chipModel.textContent = '模型：未获授权（llm.chat）';
    } else {
      els.chipModel.textContent = '模型：在桌宠那边（工坊页只做展示）';
    }
  }
}

function bindWorkshop() {
  if (view === 'background') return;
  if (els.clearLog) {
    els.clearLog.addEventListener('click', () => {
      void (async () => {
        await storageSet(LOG_KEY, '[]');
        await renderLog();
      })();
    });
  }
  if (els.clearSessions) {
    els.clearSessions.addEventListener('click', () => {
      void (async () => {
        const res = await request('storage.list', { sub: 's' }).catch(() => ({ files: [] }));
        for (const f of (res && res.files) || []) {
          await request('storage.remove', { key: `s/${f.name}` }).catch(() => {});
          await request('storage.remove', { key: metaKeyForFlat(`s/${f.name}`) }).catch(() => {});
        }
        await renderSessions();
      })();
    });
  }
  setInterval(() => void renderWorkshop(), 5000);
  void renderWorkshop();
}
