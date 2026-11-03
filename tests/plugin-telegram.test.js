import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Telegram 接入端的行为测试：驱动的是 panel.html 里真实加载的那几支脚本。
//
// harness 与 imgbed / onebot 那几份同型：vitest 的 jsdom 全局 window 当作插件的 window，
// 拼起来的源码用 new Function 丢进一个函数作用域（等于浏览器里那几支经典 script 共享一个作用域），
// 出站 postMessage 用 spy 记下来。
//
// 这个文件钉住的几件事：
//
//   1. manifest 的形状：四项权限、`background` 由 net.fetch 撑着（不是 events）、serves 只有
//      on_message、callTargets 只点名记忆核心的 chat、netHosts 只有 api.telegram.org；
//   2. **未配置时一个 net.fetch 都不发**：没 token 或开关关着，两条路各一遍；
//   3. 主路径：getUpdates 的形状（offset / timeout=25 / limit）、plugin.call 的 payload、
//      sendMessage 的 body、游标写进 storage；
//   4. 401 / 409 / 429 各自说清（429 还要按 retry_after 等）；
//   5. 断网退避 15 → 30 → 60，成功一次就重置回 15；
//   6. offset 防重复：同一个 update 喂两次，只有一次 sendMessage；
//   7. 只处理 message.text：贴图 / 语音 / 频道消息安全忽略并留一行 plugin.log；
//   8. 记忆核心报错时只发「我这边出错了，稍后再试」，内部错误原文不外泄；
//   9. 宿主拒绝一切时不崩、不写数据；
//  10. plugin.call 的 on_message：回答、可以顺带发出去、未知方法回一句人话。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-telegram');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');
const source = scriptSources
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-telegram';
const MEMCORE = 'com.shixiansi.plugin-memcore';
const TOKEN = '123456:AAFakeTokenForTests';
const CHAT = '42';

describe('manifest', () => {
  test('asks for exactly what it uses, and the background frame is gated by net.fetch', () => {
    expect([...manifest.permissions].sort()).toEqual(
      ['net.fetch', 'plugin.call', 'plugin.config', 'storage'],
    );
    // 没有 events（收不到 config.changed，所以靠重读设置）、没有 net.ws、没有 process。
    expect(manifest.permissions).not.toContain('events');
    expect(manifest.permissions).not.toContain('net.credentials');
    expect(manifest.background).toBe(true);
    // 落点是「常驻帧 + 工坊页」，**不声明 surface**：没有浮层面，也就没有矩形裁剪那一整套麻烦。
    expect(manifest.surface).toBeUndefined();
    expect(manifest.body).toBeUndefined();
    expect(manifest.serves).toEqual(['on_message']);
    expect(manifest.callTargets).toEqual([`${MEMCORE}/chat`]);
    expect(manifest.netHosts).toEqual(['api.telegram.org']);
  });

  test('the four settings the brief asks for, with the empty-allow-list default that blocks everyone', () => {
    const byKey = Object.fromEntries(manifest.config.map((item) => [item.key, item]));
    expect(Object.keys(byKey).sort()).toEqual(['allowedChats', 'botToken', 'pollCount', 'pollEnabled']);
    expect(byKey.botToken.type).toBe('text');
    expect(byKey.allowedChats.type).toBe('text');
    expect(byKey.allowedChats.default).toBe('');
    expect(byKey.allowedChats.label).toContain('留空');
    expect(byKey.pollEnabled.type).toBe('bool');
    expect(byKey.pollEnabled.default).toBe('false');
    expect(byKey.pollCount.type).toBe('number');
    expect(byKey.pollCount.default).toBe('20');
  });

  test('every file the page loads ships in the package, and ui.css is a byte-for-byte copy', () => {
    const fixed = ['panel.html', 'app.js', 'style.css'];
    for (const src of scriptSources) {
      if (fixed.includes(src)) continue;
      expect(manifest.assets).toContain(src);
    }
    expect(manifest.assets).toContain('ui.css');
    for (const asset of manifest.assets) {
      expect(existsSync(path.join(pluginDir, asset)), `manifest.assets 里的 ${asset} 不存在`).toBe(true);
    }
    expect(existsSync(path.join(pluginDir, manifest.entry))).toBe(true);
    // 没有 surface 的插件整份引 ui.css，那份副本必须与源头逐字节相同（分叉就是第三套色板）。
    const master = readFileSync(path.join(here, '..', 'docs', 'ui', 'petpc-ui.css'));
    expect(readFileSync(path.join(pluginDir, 'ui.css')).equals(master)).toBe(true);
  });

  test('no timer in the source polls faster than 10 seconds', () => {
    // 1 秒轮询是反模式（AGENTS §3.9）：长轮询由服务器替我们等，工坊页的兜底是 15 秒。
    for (const match of source.matchAll(/setInterval\s*\([^;]*?,\s*([0-9_]+)\s*\)/g)) {
      expect(Number(match[1].replace(/_/g, ''))).toBeGreaterThanOrEqual(10000);
    }
  });
});

// --- harness -----------------------------------------------------------------

let store;
let configValues;
let fetchCalls;
let fetchReplies;
let logLines;
let memcoreReply;
let memcoreCalls;
let answered;
let postedFrom;
let windowListeners;
let timers;
let sleepCalls;

function posted() {
  return window.postMessage.mock.calls.map((call) => call[0]).slice(postedFrom);
}

function byType(type) {
  return posted().filter((m) => m && m.type === type);
}

function requests() {
  return byType('request').map((m) => ({ id: m.id, method: m.method, payload: m.payload }));
}

function hostSends(data) {
  window.dispatchEvent(new MessageEvent('message', { data, source: window }));
}

function answer(id, result, { ok = true, error = '' } = {}) {
  answered.add(id);
  hostSends({ v: 1, type: 'response', id, ok, result, error });
}

/** getUpdates 的那几次请求（sendMessage 混在同一个方法里，靠 URL 分辨）。 */
function polls() {
  return fetchCalls.filter((call) => String(call.url).includes('/getUpdates'));
}

function sends() {
  return fetchCalls.filter((call) => String(call.url).includes('/sendMessage'));
}

function sentTexts() {
  return sends().map((call) => JSON.parse(call.body).text);
}

function fetchReplyFor() {
  if (fetchReplies.length) {
    const next = fetchReplies.shift();
    return typeof next === 'function' ? next() : next;
  }
  return { status: 200, body: JSON.stringify({ ok: true, result: [] }) };
}

/** 每拍把还没答的请求答掉，再让出一拍——Promise 链都在下一拍产生新请求。 */
async function drain(rounds = 24) {
  for (let i = 0; i < rounds; i += 1) {
    for (const req of requests().filter((r) => !answered.has(r.id))) {
      const payload = req.payload || {};
      switch (req.method) {
        case 'config.get':
          answer(req.id, { values: configValues, secrets: {} });
          break;
        case 'storage.get':
          answer(req.id, { value: store.has(String(payload.key)) ? store.get(String(payload.key)) : '' });
          break;
        case 'storage.set':
          store.set(String(payload.key), String(payload.value || ''));
          answer(req.id, { ok: true });
          break;
        case 'storage.remove':
          store.delete(String(payload.key));
          answer(req.id, { removed: true });
          break;
        case 'net.fetch': {
          fetchCalls.push(payload);
          const reply = fetchReplyFor();
          if (reply && reply.throws) answer(req.id, null, { ok: false, error: String(reply.throws) });
          else answer(req.id, reply);
          break;
        }
        case 'plugin.call':
          memcoreCalls.push(payload);
          if (memcoreReply && memcoreReply.error) answer(req.id, null, { ok: false, error: memcoreReply.error });
          else answer(req.id, memcoreReply || { text: '答：好', meta: { roleId: 'x' } });
          break;
        case 'plugin.log':
          logLines.push({ level: String(payload.level || 'info'), message: String(payload.message || '') });
          answer(req.id, { ok: true, swallowed: 0 });
          break;
        default:
          answer(req.id, null, { ok: false, error: `本程序不支持该方法 ${req.method}` });
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function loadApp() {
  answered = new Set();
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  for (const id of timers) clearTimeout(id);
  timers = [];
  postedFrom = window.postMessage.mock.calls.length;
  // eslint-disable-next-line no-new-func
  new Function(source)();
}

/**
 * 把常驻帧的等待换成"记一笔、然后永远等下去"。
 *
 * 这个插件一半的行为是"等多久才再试一次"，而等 15 秒在用例里没法过。换掉的只是**等待**：
 * 退避怎么算、下一拍等多久仍然是被测的那段真代码（tick() 的返回值 = snapshot().retryIn）。
 */
function parkSleep(ms) {
  sleepCalls.push(Number(ms));
  return new Promise(() => {});
}

async function boot({ slot = 'background', granted = manifest.permissions, config, park = true } = {}) {
  if (config) configValues = { ...configValues, ...config };
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
  loadApp();
  if (park) window.__telegram.setSleep(parkSleep);
  hostSends({
    v: 1,
    type: 'init',
    pluginId: PLUGIN_ID,
    permissions: manifest.permissions,
    granted: [...granted],
    surface: slot === 'workshop'
      ? { kind: 'panel', slot: 'workshop' }
      : { kind: 'panel', slot: 'background' },
    host: {
      program: slot === 'workshop' ? 'workshop' : 'pet',
      methods: slot === 'workshop'
        ? ['config.get', 'storage.get', 'storage.list', 'storage.stat']
        : ['config.get', 'storage.get', 'storage.set', 'net.fetch', 'plugin.call', 'plugin.log'],
    },
  });
  await drain(6);
}

/** 手动驱动一拍（真实的那段 pollOnce），并把它发起的请求答完。 */
async function tickOnce() {
  const pendingTick = window.__telegram.tick();
  await drain(12);
  return await pendingTick;
}

function snapshot() {
  return window.__telegram.snapshot();
}

function configured({ poll = true } = {}) {
  configValues = {
    botToken: TOKEN,
    allowedChats: CHAT,
    pollEnabled: poll ? 'true' : 'false',
    pollCount: '20',
  };
}

function textUpdate(updateId = 10, text = '你好') {
  return {
    update_id: updateId,
    message: {
      message_id: 100 + updateId,
      chat: { id: Number(CHAT), type: 'private' },
      from: { id: 7, first_name: '张三', is_bot: false },
      text,
    },
  };
}

function okUpdates(list) {
  return { status: 200, body: JSON.stringify({ ok: true, result: list }) };
}

beforeEach(() => {
  store = new Map();
  configValues = { botToken: '', allowedChats: '', pollEnabled: 'false', pollCount: '20' };
  fetchCalls = [];
  fetchReplies = [];
  logLines = [];
  memcoreCalls = [];
  memcoreReply = null;
  sleepCalls = [];
  windowListeners = [];
  timers = [];
  const originalAdd = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(function (type, fn, opts) {
    windowListeners.push([type, fn, opts]);
    return originalAdd(type, fn, opts);
  });
  const originalTimeout = window.setTimeout.bind(window);
  // 只记账 + 只 park 长等待：短的（0ms 让出一拍）必须真的跑，否则 drain 不动；
  // 长的（15 秒起的退避、15 秒的工坊兜底）一律不排程，免得用例跑成 15 秒。
  vi.spyOn(window, 'setTimeout').mockImplementation((fn, ms, ...rest) => {
    if (Number(ms) >= 1000) {
      sleepCalls.push(Number(ms));
      return 1;
    }
    const id = originalTimeout(fn, ms, ...rest);
    timers.push(id);
    return id;
  });
  vi.spyOn(window, 'postMessage').mockImplementation(() => {});
});

afterEach(() => {
  for (const id of timers) clearTimeout(id);
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  vi.restoreAllMocks();
});

// --- 握手 --------------------------------------------------------------------

test('握手：发一次 ready，装上 granted，常驻帧开始拉之前先问设置', async () => {
  configured();
  await boot();

  expect(byType('ready')).toHaveLength(1);
  const asked = requests().map((r) => r.method);
  expect(asked[0]).toBe('config.get');
  // 常驻帧拿到了游标（storage.get 是 loadCursor）——那是它启动的第一件事。
  expect(requests().some((r) => r.method === 'storage.get' && r.payload.key === 'state/offset')).toBe(true);
  expect(snapshot().slot).toBe('background');
});

// --- 未配置：一个 net.fetch 都不发 --------------------------------------------

test('没有 Bot Token 时一个 net.fetch 都不发，界面写「先去设置里填 Bot Token」', async () => {
  configValues = { botToken: '', allowedChats: CHAT, pollEnabled: 'true', pollCount: '20' };
  await boot();

  expect(fetchCalls).toHaveLength(0);
  expect(snapshot().message).toContain('先去设置里填 Bot Token');
  // 再驱动三拍也一样：没配置就是没配置，不许拿空 token 去撞 api.telegram.org。
  await tickOnce();
  await tickOnce();
  await tickOnce();
  expect(fetchCalls).toHaveLength(0);
});

test('轮询开关关着时一个 net.fetch 都不发（token 填了也不行）', async () => {
  configured({ poll: false });
  await boot();

  expect(fetchCalls).toHaveLength(0);
  expect(snapshot().message).toContain('轮询开关关着');
  expect(sleepCalls).toContain(15000);
});

test('工坊页把「还差一步」写在最上面：没 token 的那一句与「留空=谁的都不收」', async () => {
  await boot({ slot: 'workshop' });
  const page = document.body.textContent;
  expect(page).toContain('先去设置里填 Bot Token');
  expect(page).toContain('留空 = 谁的都不收');
  // 这一页不发任何 net.fetch（控制中心不持有那条循环）。
  expect(fetchCalls).toHaveLength(0);
});

// --- 主路径 ------------------------------------------------------------------

test('主路径：getUpdates → plugin.call 记忆核心 → sendMessage 发回同一个 chat，游标写进 storage', async () => {
  configured();
  fetchReplies.push(okUpdates([textUpdate(10, '你好')]));
  memcoreReply = { text: '答：你也好', meta: { roleId: 'telegram:42' } };
  await boot();

  const got = polls();
  expect(got).toHaveLength(1);
  // 长轮询：25 秒让服务器等（宿主的 net.fetch 超时是 30 秒），limit 来自设置项。
  expect(got[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/getUpdates?offset=0&timeout=25&limit=20`);
  expect(got[0].method).toBe('GET');

  expect(memcoreCalls).toHaveLength(1);
  expect(memcoreCalls[0]).toMatchObject({ target: MEMCORE, method: 'chat' });
  expect(memcoreCalls[0].payload).toEqual({
    roleId: 'telegram:42',
    userId: '7',
    userName: '张三',
    text: '你好',
    platform: 'telegram',
  });

  const out = sends();
  expect(out).toHaveLength(1);
  expect(out[0].method).toBe('POST');
  expect(out[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
  expect(out[0].headers['content-type']).toBe('application/json');
  expect(JSON.parse(out[0].body)).toEqual({ chat_id: '42', text: '答：你也好' });

  // 游标 = 这条 update 的 id + 1，落盘（活过重启才不会重放）。
  expect(store.get('state/offset')).toBe('11');
  expect(snapshot()).toMatchObject({ cursor: 11, answered: 1, failed: 0 });
});

// --- offset 防重复 -----------------------------------------------------------

test('offset 防重复：同一个 update 喂两次，只发一次 sendMessage', async () => {
  configured();
  fetchReplies.push(okUpdates([textUpdate(10)]));
  await boot();
  expect(sends()).toHaveLength(1);

  // Telegram 重发上一轮那个 update（还没确认成功时就会这样）。
  fetchReplies.push(okUpdates([textUpdate(10)]));
  const wait = await tickOnce();

  expect(sends()).toHaveLength(1);
  expect(memcoreCalls).toHaveLength(1);
  expect(snapshot().skipped).toBe(1);
  // 下一条的 offset 已经越过它了，所以下一次会拿 11 去问。
  expect(polls()[1].url).toContain('offset=11');
  expect(wait).toBe(0);
});

test('游标从 storage 里恢复：重启之后 update_id 更小的消息根本不会被处理', async () => {
  configured();
  store.set('state/offset', '11');
  fetchReplies.push(okUpdates([textUpdate(10)]));
  await boot();

  expect(fetchCalls.filter((c) => String(c.url).includes('/sendMessage'))).toHaveLength(0);
  expect(memcoreCalls).toHaveLength(0);
  expect(snapshot().skipped).toBe(1);
});

// --- 401 / 409 / 429 ---------------------------------------------------------

test('401 说「token 不对」，并且 60 秒后才再试（不拿错 token 每 15 秒撞墙）', async () => {
  configured();
  fetchReplies.push({ status: 401, body: JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }) });
  await boot();

  const state = snapshot();
  expect(state.phase).toBe('auth');
  expect(state.message).toContain('token 不对');
  expect(state.retryIn).toBe(60000);
  expect(sends()).toHaveLength(0);
  expect(logLines.some((l) => l.level === 'warn' && l.message.includes('401'))).toBe(true);
});

test('409 说清「另一个进程在用同一个 bot 的长轮询（同一个 token 只允许一个 getUpdates）」', async () => {
  configured();
  fetchReplies.push({
    status: 409,
    body: JSON.stringify({
      ok: false,
      error_code: 409,
      description: 'Conflict: terminated by other getUpdates request',
    }),
  });
  await boot();

  const state = snapshot();
  expect(state.phase).toBe('conflict');
  expect(state.message).toContain('另一个进程在用同一个 bot 的长轮询');
  expect(state.message).toContain('同一个 token 只允许一个 getUpdates');
  expect(state.retryIn).toBe(30000);
  expect(sends()).toHaveLength(0);
});

test('429 读出 retry_after 并等那么久', async () => {
  configured();
  fetchReplies.push({
    status: 429,
    body: JSON.stringify({
      ok: false,
      error_code: 429,
      description: 'Too Many Requests: retry after 7',
      parameters: { retry_after: 7 },
    }),
  });
  await boot();

  const state = snapshot();
  expect(state.phase).toBe('throttle');
  expect(state.message).toContain('7 秒');
  expect(state.retryIn).toBe(7000);
});

test('429 的 retry_after 只在 description 里时也能读出来', async () => {
  configured();
  fetchReplies.push({
    status: 429,
    body: JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 12' }),
  });
  await boot();
  expect(snapshot().retryIn).toBe(12000);
});

// --- 断网退避 ----------------------------------------------------------------

test('断网：退避 15 → 30 → 60，封顶 300；成功一次就重置回 15', async () => {
  configured();
  // 连着八次失败：阶梯一路走到封顶（一次成功就会把阶梯踩回原点，所以必须连续）。
  for (let i = 0; i < 8; i += 1) fetchReplies.push({ throws: 'dial tcp: connect: network is unreachable' });
  await boot();
  expect(snapshot().retryIn).toBe(15000);
  await tickOnce();
  expect(snapshot().retryIn).toBe(30000);
  await tickOnce();
  expect(snapshot().retryIn).toBe(60000);
  // 30 与 60 是**下一拍要等多久**：手工驱动的 tick 不真的去睡，所以 sleepCalls 里只有循环
  // 自己排的那一次（15 秒）。两者的值是同一个（pollOnce 的返回值就是 sleep 的入参）。
  expect(sleepCalls).toContain(15000);

  // 阶梯继续翻倍，但封顶 5 分钟。
  await tickOnce();
  expect(snapshot().retryIn).toBe(120000);
  await tickOnce();
  expect(snapshot().retryIn).toBe(240000);
  await tickOnce();
  expect(snapshot().retryIn).toBe(300000);
  await tickOnce();
  expect(snapshot().retryIn).toBe(300000);

  // 成功一次 → 回到 15。
  fetchReplies.length = 0;
  fetchReplies.push(okUpdates([]));
  await tickOnce();
  expect(snapshot().backoffMs).toBe(15000);
  expect(snapshot().retryIn).toBe(0);
  fetchReplies.push({ throws: 'again' });
  await tickOnce();
  expect(snapshot().retryIn).toBe(15000);
});

test('退避是由循环真的排进 setTimeout 的（不是只写在状态里）', async () => {
  configured();
  fetchReplies.push({ throws: 'connect: network is unreachable' });
  // 这一遍**不**换掉等待：走 window.setTimeout 的真实那条路（beforeEach 把 ≥1 秒的排程
  // 换成"记一笔、不真等"，否则用例要跑 15 秒）。
  await boot({ park: false });

  expect(sleepCalls).toContain(15000);
  expect(JSON.parse(store.get('state/status'))).toMatchObject({ phase: 'retry', retryIn: 15000 });
});

test('HTTP 502/503 也走同一条退避（不是"立刻重试"）', async () => {
  configured();
  await boot();
  fetchReplies.push({ status: 503, body: 'Service Unavailable' });
  await tickOnce();
  expect(snapshot().phase).toBe('retry');
  expect(snapshot().retryIn).toBe(15000);
  fetchReplies.push({ status: 502, body: '' });
  await tickOnce();
  expect(snapshot().retryIn).toBe(30000);
});

test('网络失败的原文里带 token 时，日志与面板都看不到它', async () => {
  configured();
  await boot();
  fetchReplies.push({
    throws: `Get "https://api.telegram.org/bot${TOKEN}/getUpdates?offset=0&timeout=25": dial tcp: i/o timeout`,
  });
  await tickOnce();

  const leaked = JSON.stringify({
    message: snapshot().message,
    lastError: snapshot().lastError,
    notes: store.get('state/notes') || '',
    logs: logLines.map((l) => l.message),
  });
  expect(leaked).not.toContain(TOKEN);
  expect(leaked).not.toContain('AAFakeTokenForTests');
});

// --- 只处理 message.text -----------------------------------------------------

test('贴图被安全忽略，并留一行 plugin.log 说明跳过的是哪种', async () => {
  configured();
  fetchReplies.push(okUpdates([{
    update_id: 20,
    message: {
      message_id: 220,
      chat: { id: Number(CHAT), type: 'private' },
      from: { id: 7, first_name: '张三', is_bot: false },
      sticker: { file_id: 'CAAC', emoji: '🙂' },
    },
  }]));
  await boot();

  expect(fetchCalls.filter((c) => String(c.url).includes('/sendMessage'))).toHaveLength(0);
  expect(memcoreCalls).toHaveLength(0);
  expect(snapshot().skipped).toBe(1);
  expect(logLines.some((l) => l.message.includes('sticker'))).toBe(true);
  // 游标仍然前进：忽略不等于"下一轮再处理一次"。
  expect(store.get('state/offset')).toBe('21');
});

test('语音消息同样被忽略', async () => {
  configured();
  fetchReplies.push(okUpdates([{
    update_id: 21,
    message: {
      message_id: 221,
      chat: { id: Number(CHAT), type: 'private' },
      from: { id: 7, first_name: '张三' },
      voice: { file_id: 'AwAC', duration: 3 },
    },
  }]));
  await boot();

  expect(sends()).toHaveLength(0);
  expect(logLines.some((l) => l.message.includes('voice'))).toBe(true);
});

test('频道消息（channel_post）与别的 update 类型都不进管道', async () => {
  configured();
  fetchReplies.push(okUpdates([
    {
      update_id: 30,
      channel_post: {
        message_id: 1,
        chat: { id: -100123, type: 'channel', title: '一个频道' },
        text: '频道里的一句话',
      },
    },
    { update_id: 31, my_chat_member: { chat: { id: 1 }, new_chat_member: {} } },
  ]));
  await boot();

  expect(sends()).toHaveLength(0);
  expect(memcoreCalls).toHaveLength(0);
  expect(logLines.some((l) => l.message.includes('channel_post'))).toBe(true);
  expect(logLines.some((l) => l.message.includes('my_chat_member'))).toBe(true);
  expect(store.get('state/offset')).toBe('32');
});

// --- 白名单 ------------------------------------------------------------------

test('不在允许名单里的 chat 一句话都不回，但把它的 id 写进日志（用户靠它找到自己的 id）', async () => {
  configured();
  configValues.allowedChats = '999';
  fetchReplies.push(okUpdates([textUpdate(40)]));
  await boot();

  expect(sends()).toHaveLength(0);
  expect(memcoreCalls).toHaveLength(0);
  const line = logLines.map((l) => l.message).join('\n');
  expect(line).toContain('42');
  // 正文不许进日志（那是用户自己的话，而 plugin.log 会进诊断报告）。
  expect(line).not.toContain('你好');
});

test('允许名单留空 = 谁的都不收（但照样拉，否则用户永远看不到自己的 chat id）', async () => {
  configured();
  configValues.allowedChats = '';
  fetchReplies.push(okUpdates([textUpdate(41)]));
  await boot();

  expect(polls()).toHaveLength(1);
  expect(sends()).toHaveLength(0);
  expect(snapshot().allow).toEqual([]);
});

// --- 记忆核心报错：不发原文 --------------------------------------------------

test('记忆核心报错时只发「我这边出错了，稍后再试」，内部错误原文不外泄', async () => {
  configured();
  fetchReplies.push(okUpdates([textUpdate(50)]));
  memcoreReply = { error: '本程序不支持该方法 llm.chat（插件 com.shixiansi.plugin-memcore 未启用）' };
  await boot();

  expect(sentTexts()).toEqual(['我这边出错了，稍后再试']);
  expect(sentTexts()[0]).not.toContain('llm.chat');
  expect(sentTexts()[0]).not.toContain('memcore');
  // 原文进了宿主日志（那是给这台机器上的人看的）。
  expect(logLines.some((l) => l.level === 'warn' && l.message.includes('llm.chat'))).toBe(true);
  expect(snapshot().failed).toBe(1);
});

// --- 宿主拒绝一切 ------------------------------------------------------------

/**
 * 宿主拒绝一切：每一条 request 都回 `ok:false` + 中文 error。
 * 真宿主在「用户什么都没授予」时就是这个形状，而它是最容易被插件写崩的一条路。
 */
async function bootDeny({ slot = 'background' } = {}) {
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
  loadApp();
  window.__telegram.setSleep(parkSleep);
  hostSends({
    v: 1,
    type: 'init',
    pluginId: PLUGIN_ID,
    permissions: manifest.permissions,
    granted: [...manifest.permissions],
    surface: slot === 'workshop'
      ? { kind: 'panel', slot: 'workshop' }
      : { kind: 'panel', slot: 'background' },
    host: { program: slot === 'workshop' ? 'workshop' : 'pet', methods: [] },
  });
  for (let i = 0; i < 12; i += 1) {
    for (const req of requests().filter((r) => !answered.has(r.id))) {
      answer(req.id, null, { ok: false, error: `拒绝：${req.method}` });
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test('宿主拒绝一切时不崩、不写数据，界面进入可理解的降级态', async () => {
  configured();
  await bootDeny();

  // 什么都没写进去（storage.set 一次都没成功，所以盘上是空的）。
  expect(store.size).toBe(0);
  // 一个 net.fetch 都没发（配置读不到 = 没 token）。
  expect(fetchCalls).toHaveLength(0);
  // 状态仍然可读，而且是"没在拉"。
  expect(snapshot().phase).toBe('idle');
  expect(snapshot().token).toBe(false);
});

test('宿主拒绝一切时工坊页照样画出来：不白屏、不写盘、不发请求', async () => {
  await bootDeny({ slot: 'workshop' });

  expect(document.getElementById('workshop').classList.contains('hidden')).toBe(false);
  // 读不到设置就说"没填"，而不是停在"等待宿主初始化"。
  expect(document.body.textContent).toContain('先去设置里填 Bot Token');
  expect(fetchCalls).toHaveLength(0);
  expect(store.size).toBe(0);
});

test('没有 net.fetch 权限时常驻帧不发请求，并把原因写进状态', async () => {
  configured();
  await boot({ granted: ['storage', 'plugin.config', 'plugin.call'] });

  expect(fetchCalls).toHaveLength(0);
  expect(snapshot().message).toContain('net.fetch');
  expect(sleepCalls).toContain(15000);
});

// --- plugin.call: on_message -------------------------------------------------

function callPlugin(payload, method = 'on_message') {
  const before = byType('call-result').length;
  const ticket = `t-${Math.random().toString(36).slice(2, 8)}`;
  hostSends({ v: 1, type: 'call', ticket, from: 'com.shixiansi.plugin-voice', method, payload });
  return async () => {
    await drain(8);
    const list = byType('call-result').slice(before);
    expect(list.length, 'plugin.call 一直没有回包').toBeGreaterThan(0);
    expect(list[list.length - 1].ticket).toBe(ticket);
    return list[list.length - 1];
  };
}

test('on_message：只回答（send:false），不发任何 sendMessage', async () => {
  configured();
  await boot();
  memcoreReply = { text: '今天是 11 月 3 日' };
  const taken = callPlugin({ text: '今天几号', roleId: 'telegram:42', send: false });
  const packet = await taken();

  expect(packet.ok).toBe(true);
  expect(packet.result).toMatchObject({ reply: '今天是 11 月 3 日', sent: false, roleId: 'telegram:42' });
  expect(sends()).toHaveLength(0);
});

test('on_message：带 chatId 时顺带让 bot 在那个 chat 里说出来', async () => {
  configured();
  await boot();
  memcoreReply = { text: '到点了' };
  const taken = callPlugin({ text: '提醒我', chatId: CHAT });
  const packet = await taken();

  expect(packet.ok).toBe(true);
  expect(packet.result.sent).toBe(true);
  expect(sentTexts()).toEqual(['到点了']);
  expect(memcoreCalls[0].payload.roleId).toBe('telegram:42');
});

test('on_message：名单外的 chat 拒绝发出去（那是别人），但回答照给', async () => {
  configured();
  await boot();
  memcoreReply = { text: '好' };
  const taken = callPlugin({ text: '说句话', chatId: '999' });
  const packet = await taken();

  expect(packet.ok).toBe(false);
  expect(packet.error).toContain('999');
  expect(sends()).toHaveLength(0);
});

test('on_message：没有 text 时直接说清楚要什么，而不是空跑一遍', async () => {
  configured();
  await boot();
  const taken = callPlugin({ text: '   ' });
  const packet = await taken();

  expect(packet.ok).toBe(false);
  expect(packet.error).toContain('text');
  expect(memcoreCalls).toHaveLength(0);
});

test('plugin.call 问一个没声明的方法：回一句人话，不静默等到超时', async () => {
  configured();
  await boot();
  const taken = callPlugin({}, 'send_photo');
  const packet = await taken();

  expect(packet.ok).toBe(false);
  expect(packet.error).toContain('send_photo');
  expect(packet.error).toContain('on_message');
});

// --- 工坊页 ------------------------------------------------------------------

test('工坊页读盘上的状态：设置摘要不显示 token 明文，卡片里写清「留空=谁的都不收」', async () => {
  configured();
  store.set('state/status', JSON.stringify({
    phase: 'polling',
    message: '在等消息（长轮询 25 秒一轮）',
    retryIn: 0,
    at: Date.now(),
    cursor: 88,
    answered: 3,
    skipped: 1,
    failed: 0,
    lastError: '',
  }));
  await boot({ slot: 'workshop', park: true });

  const page = document.body.textContent;
  expect(page).toContain('在等消息');
  expect(page).toContain('88');
  expect(page).toContain('42');
  expect(page).toContain('留空 = 谁的都不收');
  // token 不画在页面上——连掩码都不画（这一页会被截图）。
  expect(page).not.toContain('AAFakeTokenForTests');
  expect(page).not.toContain(TOKEN);
  // 这一页一个 net.fetch 都不发。
  expect(fetchCalls).toHaveLength(0);
});
