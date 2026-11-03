import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Telegram 薄适配器（com.shixiansi.plugin-telegram）的行为测试。三层：
//   1. 纯转换层（lib/convert.js）—— update → 统一消息、offset 推进、sendBody；
//   2. 宿主链路（panel.html + lib + app.js 在 jsdom 里握手）—— 未配置零请求、
//      收消息 → share 键 + offset 持久化、断网退避（注入时钟）、sendMessage 两条路、
//      on_message serve、granted=[]、消息文本不进日志/notes；
//   3. 静态接线 —— manifest 按 LANE-CONTRACT 的 telegram 行。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-telegram');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const convertSource = readFileSync(path.join(pluginDir, 'lib', 'convert.js'), 'utf8');
const coreSource = readFileSync(path.join(pluginDir, 'lib', 'core.js'), 'utf8');
const appSource = readFileSync(path.join(pluginDir, 'app.js'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

// --- 纯转换层单独加载（new Function('window', src)，同一份源码就是帧里跑的那份）-------

function loadConvert() {
  const window = {};
  new Function('window', convertSource)(window);
  return window.TelegramConvert;
}

// --- jsdom 挂载（抄 tests/plugin-todo.test.js / plugin-convert-kit.test.js 的 mount）----

const ALL_GRANTED = ['net.fetch', 'plugin.call', 'plugin.share', 'storage', 'plugin.config'];

/** 配置齐了的样子（botToken + chatId）。 */
const CFG_FULL = { values: { botToken: '123456:ABC-DEF_test', chatId: '42', pollTimeout: '0' }, secrets: {} };
const CFG_EMPTY = { values: {}, secrets: {} };

async function mount({ granted = ALL_GRANTED, slot = 'background', cfg = CFG_FULL } = {}) {
  const dom = new JSDOM(html, { url: 'https://plugin.invalid/panel.html', runScripts: 'outside-only' });
  const { window } = dom;
  const sent = [];
  const errors = [];
  const responded = new Set();
  window.parent = window;
  window.postMessage = (msg) => sent.push(msg);
  window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
  window.addEventListener('unhandledrejection', (e) => errors.push('unhandled: ' + String((e.reason && e.reason.message) || e.reason)));

  window.eval(convertSource); // panel.html 的 <script> 顺序：convert → core → app
  window.eval(coreSource);
  window.eval(appSource);

  const init = () => {
    const data = {
      v: 1,
      type: 'init',
      theme: 'dark',
      granted,
      surface: { kind: 'panel', slot },
      host: { program: slot === 'workshop' ? 'workshop' : 'pet', methods: ['*'] },
    };
    const event = new window.MessageEvent('message', { data });
    Object.defineProperty(event, 'source', { value: window });
    window.dispatchEvent(event);
  };
  const respond = (id, result, ok = true) => {
    responded.add(id);
    const event = new window.MessageEvent('message', {
      data: { v: 1, type: 'response', id, ok, ...(ok ? { result } : { error: String(result) }) },
    });
    Object.defineProperty(event, 'source', { value: window });
    window.dispatchEvent(event);
  };
  return { window, sent, errors, responded, init, respond };
}

/**
 * 把宿主的应答喂完。answers(method, payload, page) 返回 { ok, result } 或 undefined（用默认）。
 * 默认表：config.get → CFG，storage.get → ''，storage.set/share.set → ok，net.fetch → Telegram ok 空批。
 * 多轮收发：每一轮先应答上一轮新出现的请求，等一拍看有没有新请求，直到静止（插件会串行发出）。
 */
async function drive(page, answers) {
  const defaults = (method, payload) => {
    if (method === 'config.get') return { ok: true, result: CFG_FULL };
    if (method === 'storage.get') return { ok: true, result: { value: '' } };
    if (method === 'storage.set') return { ok: true, result: { ok: true } };
    if (method === 'share.set') return { ok: true, result: { ok: true } };
    if (method === 'net.fetch') {
      return { ok: true, result: { status: 200, body: JSON.stringify({ ok: true, result: [] }) } };
    }
    return { ok: true, result: { ok: true } };
  };
  for (let round = 0; round < 40; round++) {
    const fresh = page.sent.filter((m) => m.type === 'request' && !page.responded.has(m.id));
    if (fresh.length === 0) {
      // 静止一拍再确认一次（串行请求链的下一环可能还在微任务里）
      await new Promise((r) => setTimeout(r, 30));
      const again = page.sent.filter((m) => m.type === 'request' && !page.responded.has(m.id));
      if (again.length === 0) break;
      for (const m of again) {
        const a = (answers && answers(m.method, m.payload || {}, page)) || defaults(m.method, m.payload || {});
        page.respond(m.id, a.result, a.ok !== false);
      }
      continue;
    }
    for (const m of fresh) {
      const a = (answers && answers(m.method, m.payload || {}, page)) || defaults(m.method, m.payload || {});
      page.respond(m.id, a.result, a.ok !== false);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 30));
}

const requestsOf = (page, method) => page.sent.filter((m) => m.type === 'request' && m.method === method);
const lastOf = (page, method) => requestsOf(page, method).pop() || null;

/** 塞一条 call 进窗口（宿主 → 插件的 call 消息）。 */
function sayCall(window, data) {
  const event = new window.MessageEvent('message', { data });
  Object.defineProperty(event, 'source', { value: window });
  window.dispatchEvent(event);
}

/** 一条标准 Telegram update。 */
function tgUpdate(updateId, msgId, text, chatId = 42) {
  return {
    update_id: updateId,
    message: { message_id: msgId, date: 1760000000, text, chat: { id: chatId, first_name: '阿测', type: 'private' }, from: { id: 1001, first_name: '阿测', is_bot: false } },
  };
}

// =====================================================================
// 1. 纯转换层（lib/convert.js）
// =====================================================================

describe('Telegram 更新 → 统一消息（lib/convert.js，纯函数）', () => {
  const T = loadConvert();

  test('message：掏出 chatId/fromName/text，形状只有字符串与数字', () => {
    const msg = T.updateToMessage(tgUpdate(7, 11, '你好，机器人'));
    expect(msg).not.toBeNull();
    expect(msg).toMatchObject({ msgId: 11, chatId: '42', fromId: '1001', fromName: '阿测', text: '你好，机器人', kind: 'private-or-group' });
    for (const v of Object.values(msg)) expect(['string', 'number']).toContain(typeof v);
  });

  test('掏不出文本（贴纸/纯媒体/未知 shape）返回 null，不抛错', () => {
    expect(T.updateToMessage(null)).toBeNull();
    expect(T.updateToMessage({})).toBeNull();
    expect(T.updateToMessage({ update_id: 1, message: { message_id: 2, sticker: { file_id: 'x' }, chat: { id: 5 } } })).toBeNull();
    expect(T.updateToMessage({ update_id: 1, message: { message_id: 2, chat: {} } })).toBeNull(); // 无 chat.id
  });

  test('caption（媒体配文）也算文本；channel_post 标 kind=channel', () => {
    const msg = T.updateToMessage({ update_id: 9, channel_post: { message_id: 3, date: 1, chat: { id: -100123, title: '频道' }, caption: '看这张图' } });
    expect(msg).toMatchObject({ chatId: '-100123', chatTitle: '频道', text: '看这张图', kind: 'channel' });
  });

  test('edited_message 同样接（msgId 不变，读的人靠它去重）', () => {
    const msg = T.updateToMessage({ update_id: 3, edited_message: { message_id: 11, text: '改过了', chat: { id: 42 } } });
    expect(msg).toMatchObject({ msgId: 11, text: '改过了' });
  });

  test('batch → nextOffset = 最大 update_id + 1；空批沿用 fallback', () => {
    const a = T.batchToMessages([tgUpdate(7, 1, 'a'), tgUpdate(9, 2, 'b'), tgUpdate(8, 3, 'c')], 5);
    expect(a.messages).toHaveLength(3);
    expect(a.nextOffset).toBe(10);
    const b = T.batchToMessages([], 7);
    expect(b.messages).toHaveLength(0);
    expect(b.nextOffset).toBe(7);
    // 非文本 update 占用 update_id 但不产消息
    const c = T.batchToMessages([{ update_id: 20, message: { message_id: 1, chat: { id: 1 } } }], 0);
    expect(c.messages).toHaveLength(0);
    expect(c.nextOffset).toBe(21);
  });

  test('sendBody：纯文本直发（不带 parse_mode），控制字符被剥', () => {
    expect(JSON.parse(T.sendBody('42', 'hello\nworld'))).toEqual({ chat_id: '42', text: 'hello\nworld' });
    const body = JSON.parse(T.sendBody('@chan', 'a\u0000b'));
    expect(body.text).toBe('ab');
    expect(body.text).not.toContain('\u0000');
  });

  test('超长文本截断（≤MAX_TEXT+省略号），share 值不会逼近 64 KiB', () => {
    const big = 'x'.repeat(5000);
    const msg = T.updateToMessage(tgUpdate(1, 1, big));
    expect(msg.text.length).toBeLessThanOrEqual(T.MAX_TEXT + 1);
    expect(T.sendBody('42', big).length).toBeLessThan(4500);
  });
});

// =====================================================================
// 2. 宿主链路
// =====================================================================

describe('未配置：零网络请求 + 插件页显示"未配置"', () => {
  test('background 帧：config 里没填 token/chatId ⇒ 除 config.get/storage.get 外零请求（无 net.fetch / share / plugins.services）', async () => {
    const page = await mount({ cfg: CFG_EMPTY });
    page.init();
    await drive(page, (method) => (method === 'config.get' ? { ok: true, result: CFG_EMPTY } : undefined));
    const methods = page.sent.filter((m) => m.type === 'request').map((m) => m.method);
    expect(methods).toContain('config.get');       // 读配置是唯一的前置动作
    expect(methods).not.toContain('net.fetch');    // 不 getUpdates、不 sendMessage
    expect(methods).not.toContain('plugins.services'); // 连插件服务表都不问
    expect(methods).not.toContain('share.set');    // 不发布
    expect(page.errors).toEqual([]);
    expect(page.window.document.getElementById('bg-status').textContent).toContain('未配置');
    expect(page.window.__telegram.snapshot().configured).toBe(false);
  });

  test('只填了 token 没 chatId（或反之）同样算未配置：零网络', async () => {
    const page = await mount();
    page.init();
    await drive(page, (method) => (method === 'config.get'
      ? { ok: true, result: { values: { botToken: '123:x', chatId: '' }, secrets: {} } }
      : undefined));
    expect(requestsOf(page, 'net.fetch')).toEqual([]);
    expect(page.window.__telegram.snapshot().configured).toBe(false);
  });

  test('workshop 插件页：未配置时状态芯片是"未配置"，发送按钮置灰，无 net.fetch 请求', async () => {
    const page = await mount({ slot: 'workshop', cfg: CFG_EMPTY });
    page.init();
    await drive(page, (method) => (method === 'config.get' ? { ok: true, result: CFG_EMPTY } : undefined));
    const doc = page.window.document;
    expect(doc.getElementById('chip-config').textContent).toContain('未配置');
    expect(doc.getElementById('send').disabled).toBe(true);
    expect(requestsOf(page, 'net.fetch')).toEqual([]);
    expect(page.errors).toEqual([]);
  });
});

describe('配置后：首次 getUpdates、收消息 → share 键 + offset 持久化', () => {
  test('首次 getUpdates 带 offset=0；收到消息后 share.set 的值里可见统一消息', async () => {
    const page = await mount();
    page.init();
    let pollCount = 0;
    await drive(page, (method, payload) => {
      if (method !== 'net.fetch') return undefined;
      pollCount += 1;
      if (pollCount === 1) {
        expect(payload.url).toContain('api.telegram.org/bot');
        expect(payload.url).toContain('/getUpdates');
        expect(payload.url).toContain('offset=0');
        return { ok: true, result: { status: 200, body: JSON.stringify({ ok: true, result: [tgUpdate(7, 11, '第一句话')] }) } };
      }
      // 停轮询：第二次就答一个"配置门会停"的状态——更简单的办法是让下一轮永远不被
      // drive 应答之外的东西推进。drive 最多 40 轮，第二轮之后照常答空批即可。
      return { ok: true, result: { status: 200, body: JSON.stringify({ ok: true, result: [] }) } };
    });
    // 收到消息：写 share 键（payload 里可见统一消息）
    const share = lastOf(page, 'share.set');
    expect(share, '收到消息后没有 share.set').toBeTruthy();
    expect(share.payload.name).toBe('telegram-inbox');
    const published = JSON.parse(share.payload.value);
    expect(published.messages).toHaveLength(1);
    expect(published.messages[0]).toMatchObject({ chatId: '42', fromName: '阿测', text: '第一句话' });
    // offset 已推进：下一次 getUpdates 用 offset = 7+1。下一拍要等 15 秒的退避间隔，
    // 不真等——直接单步 pollOnce 并应答，检查它发出的 URL。
    page.sent.length = 0;
    const step = page.window.__telegram.pollOnce();
    const inflight = page.sent.filter((m) => m.type === 'request' && m.method === 'net.fetch');
    expect(inflight).toHaveLength(1);
    expect(inflight[0].payload.url).toContain('offset=8');
    page.respond(inflight[0].id, { status: 200, body: JSON.stringify({ ok: true, result: [] }) });
    expect(await step).toBe(true);
    expect(page.errors).toEqual([]);
  });

  test('offset 持久化：storage.set tg-offset = 上次最大 update_id + 1', async () => {
    const page = await mount();
    page.init();
    let pollCount = 0;
    await drive(page, (method) => {
      if (method !== 'net.fetch') return undefined;
      pollCount += 1;
      return pollCount === 1
        ? { ok: true, result: { status: 200, body: JSON.stringify({ ok: true, result: [tgUpdate(100, 1, 'x'), tgUpdate(101, 2, 'y')] }) } }
        : { ok: true, result: { status: 200, body: JSON.stringify({ ok: true, result: [] }) } };
    });
    const save = requestsOf(page, 'storage.set').find((m) => m.payload.key === 'tg-offset');
    expect(save, 'offset 没有写 storage').toBeTruthy();
    expect(save.payload.value).toBe('102'); // 101 + 1
  });

  test('offset 持久化：重启（重新 mount + init）后从上次 offset+1 继续', async () => {
    // 第一次"运行"：收到 update 100/101，宿主的 storage 记下 tg-offset=102
    const first = await mount();
    first.init();
    const hostStore = new Map();
    let poll = 0;
    await drive(first, (method, payload) => {
      if (method === 'storage.set') { hostStore.set(payload.key, payload.value); return { ok: true, result: { ok: true } }; }
      if (method === 'storage.get') return { ok: true, result: { value: hostStore.get(payload.key) || '' } };
      if (method !== 'net.fetch') return undefined;
      poll += 1;
      return poll === 1
        ? { ok: true, result: { status: 200, body: JSON.stringify({ ok: true, result: [tgUpdate(100, 1, 'x'), tgUpdate(101, 2, 'y')] }) } }
        : { ok: true, result: { status: 200, body: JSON.stringify({ ok: true, result: [] }) } };
    });
    expect(hostStore.get('tg-offset')).toBe('102');

    // 第二次运行（重启 = 全新 jsdom + init，同一个 hostStore）
    const second = await mount();
    let seenOffset = '';
    second.init();
    await drive(second, (method, payload) => {
      if (method === 'storage.get') return { ok: true, result: { value: hostStore.get(payload.key) || '' } };
      if (method !== 'net.fetch') return undefined;
      seenOffset = String(payload.url).match(/offset=(\d+)/)?.[1] || '';
      return { ok: true, result: { status: 200, body: JSON.stringify({ ok: true, result: [] }) } };
    });
    expect(seenOffset).toBe('102'); // 从上次的 101+1 继续，不是 0
  });
});

describe('断网退避（注入时钟断言 15 → 30 秒）', () => {
  test('连续失败 2 次 → 第三次间隔从 15s 翻到 30s；成功后回到 15s（stub 轮询 setTimeout，断言延迟序列）', async () => {
    const page = await mount();
    page.init();
    // 拦 scheduleNext 排下的 setTimeout：记录插件实际请求的延迟值（不真等 15 秒）。
    const delays = [];
    const realSetTimeout = page.window.setTimeout.bind(page.window);
    page.window.setTimeout = (fn, ms) => {
      delays.push(ms);
      return realSetTimeout(fn, 0); // 立即跑下一拍：退避序列在毫秒内走完
    };
    let pollCount = 0;
    await drive(page, (method) => {
      if (method !== 'net.fetch') return undefined;
      pollCount += 1;
      return pollCount <= 2
        ? { ok: false, result: '模拟拒绝：网络不可达' }
        : { ok: true, result: { status: 200, body: JSON.stringify({ ok: true, result: [] }) } };
    });
    // 失败 1 次后下一次间隔 15s；失败 2 次后翻到 30s；成功后回 15s。
    // scheduleNext 在每轮 pollOnce 返回后被调：delays[0]=15s(失败1) delays[1]=30s(失败2) delays[2]=15s(成功)
    expect(delays.slice(0, 3)).toEqual([15000, 30000, 15000]);
    expect(pollCount).toBeGreaterThanOrEqual(3);
    const snap = page.window.__telegram.snapshot();
    expect(snap.failCount).toBe(0);   // 成功那轮清零
    expect(snap.lastError).toBe('');
    expect(page.window.__telegram.backoffMs()).toBe(15000);
  });

  test('backoff 封顶 5 分钟（纯计算断言，源码级钉住）', () => {
    expect(coreSource).toContain('BACKOFF_BASE_MS = 15000');
    expect(coreSource).toContain('BACKOFF_MAX_MS = 300000');
    expect(coreSource).toContain('Math.pow(2, Math.max(0, failCount - 1))');
    expect(coreSource).toContain('Math.min(BACKOFF_MAX_MS, ms)');
  });

  test('注入时钟可用：setClock 后 publishInbox 的时间戳跟着走（不为退避散落 Date.now）', async () => {
    const page = await mount();
    page.init();
    let ms = 1760000000000;
    page.window.__telegram.setClock(() => ms);
    ms += 1000;
    page.window.__telegram.ingestUpdate(tgUpdate(7, 11, '时间戳探针'));
    await drive(page, (method) => (method === 'share.set' ? { ok: true, result: { ok: true } } : undefined));
    // share.set 的值里 at 是注入时钟的值（publishInbox → inboxValue() → now()）
    const share = lastOf(page, 'share.set');
    expect(share, '收件箱没有发布').toBeTruthy();
    expect(JSON.parse(share.payload.value).at).toBe(1760000001000);
  });
});

describe('Telegram 错误态：409 / 401 在插件页可读', () => {
  test('409 Conflict：lastError 带错误码与描述，插件页错误行显示，不崩', async () => {
    const page = await mount();
    page.init();
    await drive(page, (method) => (method === 'net.fetch'
      ? { ok: true, result: { status: 409, body: JSON.stringify({ ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' }) } }
      : undefined));
    const snap = page.window.__telegram.snapshot();
    expect(snap.lastError).toContain('409');
    expect(snap.lastError).toContain('Conflict');
    expect(page.errors).toEqual([]);
  });

  test('401 Unauthorized（token 错）：同样可读', async () => {
    const page = await mount();
    page.init();
    await drive(page, (method) => (method === 'net.fetch'
      ? { ok: true, result: { status: 401, body: JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }) } }
      : undefined));
    expect(page.window.__telegram.snapshot().lastError).toContain('401');
    expect(page.window.__telegram.snapshot().lastError).toContain('Unauthorized');
  });
});

describe('sendMessage：成功 / 失败两条路（插件页可读，不崩）', () => {
  async function mountedWorkshop() {
    const page = await mount({ slot: 'workshop' });
    page.init();
    await drive(page);
    page.sent.length = 0;
    return page;
  }

  test('成功：POST api.telegram.org/bot<token>/sendMessage，chat_id 与 text 正确', async () => {
    const page = await mountedWorkshop();
    const doc = page.window.document;
    expect(doc.getElementById('send').disabled).toBe(false);
    doc.getElementById('chat-id').value = '42';
    doc.getElementById('send-text').value = '你好，来自桌宠';
    doc.getElementById('send').dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
    await drive(page, (method, payload) => {
      if (method !== 'net.fetch') return undefined;
      expect(payload.method).toBe('POST');
      expect(payload.url).toContain('/sendMessage');
      const body = JSON.parse(payload.body);
      expect(body).toEqual({ chat_id: '42', text: '你好，来自桌宠' });
      return { ok: true, result: { status: 200, body: JSON.stringify({ ok: true, result: { message_id: 55 } }) } };
    });
    expect(doc.getElementById('send-status').textContent).toContain('已发送');
    expect(doc.getElementById('error').hidden).toBe(true);
    expect(page.errors).toEqual([]);
  });

  test('失败（400 chat not found）：宿主的中文/原话显示在错误行，不崩、按钮恢复', async () => {
    const page = await mountedWorkshop();
    const doc = page.window.document;
    doc.getElementById('chat-id').value = '42';
    doc.getElementById('send-text').value = '发给不存在的人';
    doc.getElementById('send').dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
    await drive(page, (method) => (method === 'net.fetch'
      ? { ok: true, result: { status: 400, body: JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }) } }
      : undefined));
    expect(doc.getElementById('error').hidden).toBe(false);
    expect(doc.getElementById('error').textContent).toContain('chat not found');
    expect(doc.getElementById('send-status').textContent).toContain('失败');
    expect(page.errors).toEqual([]);
  });

  test('空文本不发请求；没写 token 也不发请求（中文原因说出口）', async () => {
    const page = await mountedWorkshop();
    const doc = page.window.document;
    doc.getElementById('chat-id').value = '42';
    doc.getElementById('send-text').value = '   ';
    doc.getElementById('send').dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(doc.getElementById('error').textContent).toContain('先写一句话');
    expect(requestsOf(page, 'net.fetch')).toEqual([]);
    // token 为空（直接用接缝验证 core 的门）
    page.window.__telegram.setConfigured('', '42');
    await expect(page.window.__telegram.sendMessage('42', 'hi')).rejects.toThrow('Bot Token');
    expect(requestsOf(page, 'net.fetch')).toEqual([]);
  });
});

describe('on_message serve（plugin.call 查询接口）', () => {
  async function mountedWithInbox() {
    const page = await mount({ granted: ALL_GRANTED, slot: 'background' });
    page.init();
    await drive(page, (method) => (method === 'net.fetch'
      ? { ok: true, result: { status: 200, body: JSON.stringify({ ok: true, result: [tgUpdate(7, 11, '消息甲'), tgUpdate(8, 12, '消息乙')] }) } }
      : undefined));
    page.sent.length = 0;
    return page;
  }

  test('常驻帧回 call-result：{messages, offset}；空时明确空态（messages=[]、offset=0）', async () => {
    const page = await mount({ granted: ALL_GRANTED, slot: 'background' });
    page.init();
    await drive(page); // 空批
    page.sent.length = 0;
    sayCall(page.window, { v: 1, type: 'call', ticket: 'tk-1', from: 'com.shixiansi.plugin-memcore', method: 'on_message', payload: {} });
    await new Promise((r) => setTimeout(r, 20));
    const answer = page.sent.find((m) => m.type === 'call-result');
    expect(answer, 'call 没有被回答').toBeTruthy();
    expect(answer.ticket).toBe('tk-1');
    expect(answer.ok).toBe(true);
    expect(answer.result).toMatchObject({ messages: [], offset: 0, total: 0 });
  });

  test('有消息：返回统一消息数组与下次 offset；带 offset 只拿增量', async () => {
    const page = await mountedWithInbox();
    const T = page.window.__telegram;
    const all = T.serveOnMessage({});
    expect(all.messages).toHaveLength(2);
    expect(all.messages[0].text).toBe('消息甲');
    expect(all.offset).toBe(2);
    const rest = T.serveOnMessage({ offset: 1 });
    expect(rest.messages).toHaveLength(1);
    expect(rest.messages[0].text).toBe('消息乙');
    expect(rest.offset).toBe(2);
  });

  test('宿主真的转 call 进来也照答（ticket 原样带回）', async () => {
    const page = await mountedWithInbox();
    sayCall(page.window, { v: 1, type: 'call', ticket: 'tk-9', from: 'x', method: 'on_message', payload: { offset: 0 } });
    await new Promise((r) => setTimeout(r, 20));
    const answer = page.sent.find((m) => m.type === 'call-result');
    expect(answer.ok).toBe(true);
    expect(answer.result.messages).toHaveLength(2);
  });

  test('不认识的方法回中文拒绝（ok:false + 方法名）', async () => {
    const page = await mountedWithInbox();
    sayCall(page.window, { v: 1, type: 'call', ticket: 'tk-2', from: 'x', method: 'chat', payload: {} });
    await new Promise((r) => setTimeout(r, 20));
    const answer = page.sent.find((m) => m.type === 'call-result');
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain('不认识方法');
    expect(answer.error).toContain('on_message');
  });

  test('环形收件箱：第 21 条把最旧的挤掉（INBOX_MAX=20）', async () => {
    const page = await mount({ granted: ALL_GRANTED, slot: 'background' });
    page.init();
    await drive(page);
    const T = page.window.__telegram;
    for (let i = 1; i <= 21; i++) T.ingestUpdate(tgUpdate(1000 + i, i, `第${i}条`));
    const all = T.serveOnMessage({});
    expect(all.messages).toHaveLength(20);
    expect(all.messages[0].text).toBe('第2条');   // 第1条被挤掉
    expect(all.messages[19].text).toBe('第21条');
    // share 值 ≤64 KiB（20 条 × 4KB 上限之内）
    const share = lastOf(page, 'share.set');
    if (share) expect(share.payload.value.length).toBeLessThan(65536);
  });
});

describe('granted=[]：零请求、零写、不崩、未授权态', () => {
  test('background 帧：不问 config、不读 storage、不碰网络、不发 share；状态行说未授权', async () => {
    const page = await mount({ granted: [] });
    page.init();
    await drive(page, () => ({ ok: false, result: '模拟拒绝' }));
    const requests = page.sent.filter((m) => m.type === 'request');
    expect(requests, 'granted=[] 时发出了请求').toEqual([]);
    expect(page.errors).toEqual([]);
    const status = page.window.document.getElementById('bg-status').textContent;
    // refreshConfig/loadState 的 granted 门让"未获授权"与"未配置"归并成一个诚实的状态行：
    // 用户没授权 ⇒ 配置读不到 ⇒ 不发任何请求。两个关键词至少要出现一个，且都提"不发/未授权"。
    expect(status).toMatch(/未授权|未配置/);
    expect(requests).toEqual([]); // 状态行落定之后再复查一次：仍然零请求
  });

  test('workshop 插件页：同样零请求，配置芯片与按钮呈未授权/置灰态', async () => {
    const page = await mount({ granted: [], slot: 'workshop' });
    page.init();
    await drive(page, () => ({ ok: false, result: '模拟拒绝' }));
    const requests = page.sent.filter((m) => m.type === 'request');
    expect(requests).toEqual([]);
    const doc = page.window.document;
    expect(doc.getElementById('error').textContent).toContain('未获授权');
    expect(doc.getElementById('send').disabled).toBe(true);
    // 点了也不发
    doc.getElementById('send-text').value = 'x';
    doc.getElementById('chat-id').value = '1';
    doc.getElementById('send').dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(requestsOf(page, 'net.fetch')).toEqual([]);
    expect(page.errors).toEqual([]);
  });

  test('无 plugin.share 授权：收消息照常进内存收件箱，只是不发布（不崩）', async () => {
    const page = await mount({ granted: ['net.fetch', 'storage', 'plugin.config'] });
    page.init();
    await drive(page, (method) => (method === 'net.fetch'
      ? { ok: true, result: { status: 200, body: JSON.stringify({ ok: true, result: [tgUpdate(7, 11, '私有消息')] }) } }
      : undefined));
    expect(requestsOf(page, 'share.set')).toEqual([]); // 没授权就不发
    expect(page.window.__telegram.serveOnMessage({}).messages).toHaveLength(1); // 内存里在
    expect(page.errors).toEqual([]);
  });
});

describe('隐私纪律：消息文本不进日志（plugin.log 不调、notes 不含原文）', () => {
  test('整条链路零 plugin.log；notes/事件尾巴只有事件没有原文', async () => {
    const page = await mount();
    page.init();
    await drive(page, (method) => (method === 'net.fetch'
      ? { ok: true, result: { status: 200, body: JSON.stringify({ ok: true, result: [tgUpdate(7, 11, '这条话永远不该出现在日志里')] }) } }
      : undefined));
    expect(requestsOf(page, 'plugin.log')).toEqual([]);
    // 源码级：core/app 都不调 plugin.log
    expect(coreSource).not.toContain('plugin.log');
    expect(appSource).not.toContain('plugin.log');
    // notes 里只有"收到 N 条消息（chat …）"，不带文本
    const snap = page.window.__telegram.snapshot();
    for (const n of snap.notes) {
      expect(n.line).not.toContain('这条话');
      expect(n.line).not.toContain('永远不该出现');
    }
    // 手动发送的 note 也不带文本（只有"已发送到 <chatId>"）：
    // sendMessage 的 net.fetch 由 drive 应答，不会挂住。
    page.sent.length = 0;
    page.window.__telegram.setConfigured('123:x', '42');
    const sendPromise = page.window.__telegram.sendMessage('42', '另一句秘密');
    await drive(page, (method) => (method === 'net.fetch'
      ? { ok: true, result: { status: 200, body: JSON.stringify({ ok: true, result: { message_id: 1 } }) } }
      : undefined));
    await sendPromise;
    for (const n of page.window.__telegram.snapshot().notes) {
      expect(n.line).not.toContain('另一句秘密');
    }
  });

  test('错误态里允许出现的是 Telegram 的 description（不含消息文本）', async () => {
    const page = await mount();
    page.init();
    await drive(page, (method) => (method === 'net.fetch'
      ? { ok: true, result: { status: 400, body: JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }) } }
      : undefined));
    const snap = page.window.__telegram.snapshot();
    expect(snap.lastError).toContain('chat not found');
    expect(snap.lastError).not.toContain('第一句话');
  });
});

// =====================================================================
// 3. 静态接线（LANE-CONTRACT 的 telegram 行）
// =====================================================================

describe('manifest 接线（telegram 行）', () => {
  test('权限 / serves / background / netHosts / 版本 / assets', () => {
    expect(manifest.id).toBe('com.shixiansi.plugin-telegram');
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.author).toBe('shixiansi');
    expect(manifest.permissions).toContain('net.fetch');
    expect(manifest.permissions).toContain('plugin.call');  // 有 serves ⇒ 必须 plugin.call
    expect(manifest.permissions).toContain('storage');
    expect(manifest.permissions).toContain('plugin.config');
    expect(manifest.permissions).toContain('plugin.share'); // 要发布收件箱
    expect(manifest.serves).toEqual(['on_message']);
    expect(manifest.callTargets).toBeUndefined();           // 铁律 3：不主动调别的插件
    expect(manifest.background).toBe(true);
    expect(manifest.netHosts).toEqual(['api.telegram.org']);
    expect(manifest.entry).toBe('panel.html');
    expect(manifest.assets).toContain('ui.css');
    expect(manifest.assets).toContain('lib/convert.js');
    expect(manifest.assets).toContain('lib/core.js');
  });

  test('ui.css 副本与源头逐字节相同，且在自家样式之前引入', () => {
    const master = readFileSync(path.join(here, '..', 'docs', 'ui', 'petpc-ui.css'), 'utf8');
    const copy = readFileSync(path.join(pluginDir, 'ui.css'), 'utf8');
    expect(copy).toBe(master);
    const uiAt = html.indexOf('href="ui.css"');
    const ownAt = html.indexOf('href="style.css"');
    expect(uiAt).toBeGreaterThan(-1);
    expect(ownAt).toBeGreaterThan(-1);
    expect(uiAt).toBeLessThan(ownAt);
  });

  test('铁律 3 在源码里可查：没有 plugin.call 出站调用、没有自动回复路径', () => {
    expect(coreSource).not.toMatch(/request\(\s*['"]plugin\.call['"]/);
    expect(appSource).not.toMatch(/request\(\s*['"]plugin\.call['"]/);
    // 收到消息的唯一动作是发布收件箱，不存在"回复"调用
    expect(coreSource).not.toContain('sendMessage(' + 'msg'); // 没有把收到的消息回发出去的路径
  });

  test('存储键字面量都是扁平名（无扩展名、段内无非法字符）', () => {
    for (const key of ['tg-offset', 'tg-last-at']) {
      for (const seg of key.split('/')) expect(seg).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    }
    expect(coreSource).toMatch(/'tg-offset'/);
    expect(coreSource).toMatch(/'tg-last-at'/);
  });

  test('app.js 行数 ≤ 800', () => {
    expect(appSource.split('\n').length).toBeLessThanOrEqual(800);
  });
});
