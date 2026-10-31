import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 屏幕视觉插件的行为测试：驱动的是 panel.html 里真实加载的那几支脚本。
//
// harness 与 websearch 的测试同型：vitest 的 jsdom 全局 window 当作插件的 window，
// 拼起来的源码用 new Function 丢进一个新函数作用域（等于浏览器里那几支经典脚本
// 共享同一个作用域），出站 postMessage 用 spy 记下来。
//
// 这个文件钉住的几件事：
//
//   1. 截图任务文件与完成判定（capture.ask 的形状；meta.at > since 才算完成；超时的中文）；
//   2. Base64 / 上传结果 → 白名单判定（只有 http(s)、host 精确匹配的 URL 才进 images）；
//   3. 多模态请求体：带图时 plugin.call 的 payload 里有图片地址与问题；图没传上去时的降级；
//   4. analyze_screen 的回包形状、cooldown、历史记录与 share 快照；
//   5. 每一次 plugin.call 都有回包，包括「我不认识这个方法」。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-screen-vision');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');
const source = scriptSources
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-screen-vision';
const MEMCORE_ID = 'com.shixiansi.plugin-memcore';

describe('manifest', () => {
  test('declares background gated by process, and serves only analyze_screen', () => {
    expect(manifest.background).toBe(true);
    expect(manifest.permissions).toContain('process');
    expect(manifest.permissions).toContain('plugin.call');
    // 截图自己不发网络（上传在脚本侧），所以不需要 net.fetch——少一项授权是一项。
    expect(manifest.permissions).not.toContain('net.fetch');
    expect(manifest.permissions).not.toContain('events');
    expect(manifest.serves).toEqual(['analyze_screen']);
  });

  test('calls exactly memcore/chat', () => {
    expect(manifest.callTargets).toEqual([`${MEMCORE_ID}/chat`]);
  });

  test('helper script is shipped as an asset and referenced by config', () => {
    expect(manifest.assets).toContain('vision-helper.ps1');
    const keys = manifest.config.map((item) => item.key);
    expect(keys).toContain('helperPath');
    expect(keys).toContain('helperScript');
    const whitelist = manifest.config.filter((item) => item.hostWhitelist === true);
    expect(whitelist).toHaveLength(1);
    expect(whitelist[0].key).toBe('visionBaseUrl');
  });

  test('memcore actually serves chat (the pair check)', () => {
    const coreManifest = JSON.parse(
      readFileSync(path.join(here, '..', 'plugins', MEMCORE_ID, 'manifest.json'), 'utf8'));
    expect(coreManifest.serves).toContain('chat');
  });
});

// --- harness -----------------------------------------------------------------

let store;
let configValues;
let callCalls;
let callReplies;
let answered;
let postedFrom;
let windowListeners;
let intervals;
let sleepMs;
let launchCalls;

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

async function pump(maxRounds = 200) {
  for (let i = 0; i < maxRounds; i += 1) {
    const list = requests().filter((r) => !answered.has(r.id));
    if (!list.length) return;
    for (const req of list) {
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
          // capture.ask 被写入 → 辅助脚本"拍好了"：立刻放一张新 meta 与上传结果。
          if (payload.key === 'capture.ask') {
            const task = JSON.parse(String(payload.value || '{}'));
            const lastMeta = store.has('capture.meta') ? JSON.parse(store.get('capture.meta')) : null;
            const seq = (lastMeta && lastMeta.seq ? lastMeta.seq : 0) + 1;
            store.set('capture.meta', JSON.stringify({ ...mockMeta, at: task.at + 50, seq, sha256: `hash-${seq}` }));
            store.set('capture.upload', JSON.stringify({ url: mockUpload.url, raw: 'ok' }));
          }
          answer(req.id, { ok: true });
          break;
        case 'storage.remove':
          store.delete(String(payload.key));
          answer(req.id, { ok: true });
          break;
        case 'storage.dir':
          answer(req.id, { dir: 'C:/plugin-data/screen-vision' });
          break;
        case 'process.launch':
          launchCalls.push(payload);
          answer(req.id, { pid: 4242 });
          break;
        case 'plugin.call':
          callCalls.push(payload);
          answer(req.id, callReplyFor(payload));
          break;
        case 'share.set':
          answer(req.id, { ok: true, key: `${PLUGIN_ID}/${payload.name}` });
          break;
        default:
          answer(req.id, null, { ok: false, error: `本程序不支持该方法 ${req.method}` });
      }
    }
    // pollMeta 的 sleep(25) 是真实宏任务：让一轮事件循环跑完再收下一批请求。
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

/** 每一次 plugin.call 的应答（按队列取）。 */
function callReplyFor(payload) {
  if (callReplies.length) {
    const next = callReplies.shift();
    return typeof next === 'function' ? next(payload) : next;
  }
  return { text: '屏幕上是一个终端窗口。', meta: {} };
}

const macro = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 一张"拍好了"的截图 meta（真实脚本写的字段）。 */
const mockMeta = {
  at: 0, w: 2560, h: 1440, bytes: 482133, base64Length: 642844,
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  tookMs: 412, uploaded: true,
};
/** 上传服务回的 JSON。约定：它把图回挂到与上传端点同一个 host（127.0.0.1:8321 存图并
 * 按 /shots/… 回拉），所以这个 URL 能过插件的白名单判定。 */
const mockUpload = { url: 'http://127.0.0.1:8321/shots/abc123.png' };

/** 装一份新的常驻帧文档。 */
function loadApp() {
  answered = new Set();
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  for (const id of intervals) clearInterval(id);
  intervals = [];
  postedFrom = window.postMessage.mock.calls.length;
  // 拼起来的源码放进一个新的函数作用域（websearch 测试同款）。
  // eslint-disable-next-line no-new-func
  new Function(source)();
}

function boot(slot = 'background') {
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
  loadApp();
  hostSends({
    v: 1, type: 'init', pluginId: PLUGIN_ID, permissions: manifest.permissions,
    granted: [...manifest.permissions], surface: { kind: 'panel', slot },
  });
  return macro();
}

/** 发一次 plugin.call 的 analyze_screen，返回「取回包」的函数。 */
function callAnalyze(payload, method = 'analyze_screen') {
  const before = byType('call-result').length;
  const ticket = `t-${Math.random().toString(36).slice(2, 8)}`;
  hostSends({ v: 1, type: 'call', ticket, from: MEMCORE_ID, method, payload });
  return () => {
    const list = byType('call-result').slice(before);
    expect(list.length, 'analyze_screen 一直没有回包（call-result 缺失）').toBeGreaterThan(0);
    return list[list.length - 1];
  };
}

beforeEach(() => {
  store = new Map();
  configValues = { helperPath: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', helperScript: 'C:/plugins/vision/vision-helper.ps1', visionBaseUrl: 'http://127.0.0.1:8321/put', region: 'full', cooldownSec: '0', maxHistory: '20' };
  callCalls = [];
  callReplies = [];
  launchCalls = [];
  windowListeners = [];
  intervals = [];
  const originalAdd = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(function (type, fn, opts) {
    windowListeners.push([type, fn, opts]);
    return originalAdd(type, fn, opts);
  });
  const originalInterval = window.setInterval.bind(window);
  vi.spyOn(window, 'setInterval').mockImplementation((fn, ms) => {
    const id = originalInterval(fn, ms);
    intervals.push(id);
    return id;
  });
  vi.spyOn(window, 'postMessage').mockImplementation(() => {});
});

afterEach(() => {
  for (const id of intervals) clearInterval(id);
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  vi.restoreAllMocks();
});

// --- 截图任务与完成判定 ---------------------------------------------------------

test('a capture task is written with region+uploadUrl, and the meta that answers it is accepted', async () => {
  await boot();
  const getResult = callAnalyze({ question: '屏幕上这个报错是什么意思' });
  await pump();
  const packet = getResult();

  const task = JSON.parse(store.get('capture.ask'));
  expect(task.region).toBe('full');
  expect(task.uploadUrl).toBe('http://127.0.0.1:8321/put');
  expect(typeof task.at).toBe('number');
  // meta 必须比任务新（at > since）才算"这是这一次的截图"。
  const meta = JSON.parse(store.get('capture.meta'));
  expect(meta.at).toBeGreaterThan(task.at);

  expect(packet.ok).toBe(true);
  expect(packet.result.text).toContain('终端窗口');
  expect(packet.result.meta.sha256).toBe('hash-1');
  expect(packet.result.meta.bytes).toBe(mockMeta.bytes);
});

test('timeout without a fresh meta: a fixable Chinese error (driven at unit level with a short deadline)', async () => {
  await boot();
  // 辅助脚本没在跑：store 里永远不出现新 meta。25s 的真实上限在测试里等不起，
  // 直接用测试接缝调 pollMeta，给一个 300ms 的短截止——注意 pollMeta 的每次 storage.get
  // 都要有人答，所以 pump 必须与它并发跑。
  const pending = expect(
    window.__vision.screenshot.pollMeta(Date.now(), 300, 25),
  ).rejects.toThrow('PowerShell 路径');
  await pump();
  await pending;
});

// --- 上传结果 → 白名单 → 多模态请求体 ---------------------------------------------

test('multimodal body: the question and the uploaded URL ride one plugin.call to memcore/chat', async () => {
  await boot();
  const getResult = callAnalyze({ question: '屏幕上这个报错是什么意思' });
  await pump();
  expect(getResult().ok).toBe(true);

  expect(callCalls).toHaveLength(1);
  const sent = callCalls[0];
  expect(sent.target).toBe(MEMCORE_ID);
  expect(sent.method).toBe('chat');
  expect(sent.payload.roleId).toBe('screen-vision');
  expect(sent.payload.text).toContain('屏幕上这个报错是什么意思');
  expect(sent.payload.text).toContain(mockUpload.url);
});

test('an upload URL outside http(s) or the whitelist never reaches the model; analysis degrades to text-only', async () => {
  await boot();
  // 上传服务被人改成了 ftp；白名单判定必须把它拦下来。
  mockUpload.url = 'ftp://127.0.0.1:8321/shots/abc123.png';
  const getResult = callAnalyze({});
  await pump();
  const packet = getResult();
  expect(packet.ok).toBe(true);
  expect(callCalls).toHaveLength(1);
  expect(callCalls[0].payload.text).not.toContain('ftp://');
  expect(callCalls[0].payload.text).toContain('截图没传上去');
  mockUpload.url = 'http://127.0.0.1:8321/shots/abc123.png';
});

test('cooldown blocks a second analysis within the window and says so', async () => {
  configValues = { ...configValues, cooldownSec: '60' };
  await boot();
  const first = callAnalyze({ question: 'a' });
  await pump();
  expect(first().ok).toBe(true);

  const second = callAnalyze({ question: 'b' });
  await pump();
  const packet = second();
  expect(packet.ok).toBe(false);
  expect(packet.error).toContain('60 秒');
  expect(callCalls).toHaveLength(1);
});

// --- 历史 / share / 协议 ----------------------------------------------------------

test('history records the exchange; share publishes the snapshot under vision-last', async () => {
  await boot();
  const getResult = callAnalyze({ question: '屏幕上有什么' });
  await pump();
  expect(getResult().ok).toBe(true);

  const saved = JSON.parse(store.get('history/recent'));
  expect(saved).toHaveLength(1);
  expect(saved[0].question).toBe('屏幕上有什么');
  expect(saved[0].answer).toContain('终端窗口');

  const shareMsg = byType('request').find((m) => m.method === 'share.set');
  expect(shareMsg.payload.name).toBe('vision-last');
  const snapshot = JSON.parse(shareMsg.payload.value);
  expect(snapshot.answer).toContain('终端窗口');
});

test('unknown call method: answered with an error, never silence', async () => {
  await boot();
  const getResult = callAnalyze({}, 'other');
  await pump();
  const packet = getResult();
  expect(packet.ok).toBe(false);
  expect(packet.error).toContain('analyze_screen');
});

test('background frame starts the helper through process.launch with the storage dir', async () => {
  await boot();
  await pump();
  expect(launchCalls).toHaveLength(1);
  expect(launchCalls[0].path).toBe(configValues.helperPath);
  const args = launchCalls[0].args.join(' ');
  expect(args).toContain('vision-helper.ps1');
  expect(args).toContain('C:/plugin-data/screen-vision');
});

test('every request has a unique non-empty id; says ready first', async () => {
  await boot();
  const getResult = callAnalyze({ question: 'x' });
  await pump();
  getResult();

  const ids = requests().map((r) => r.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);

  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
  loadApp();
  const first = posted()[0];
  expect(first && first.type).toBe('ready');
});
