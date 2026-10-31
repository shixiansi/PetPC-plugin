import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Behaviour tests for the ast-coder plugin.
//
// Four groups:
//   parser         the structure extractor in isolation: functions, arrows, classes
//                  with methods, exports, TODOs, comment/string immunity.
//   manifest+css   host pairing rules + CSS house rules.
//   the frame      handshake through the real markup; workshop renders; no socket.
//   plumbing       scan/index through a fake bridge, review → plugin.call,
//                  genTests → write-only-when-absent (THE overwrite rule).

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-ast-coder');
const panelPath = path.join(pluginDir, 'panel.html');
const cssPath = path.join(pluginDir, 'style.css');
const manifestPath = path.join(pluginDir, 'manifest.json');

const html = readFileSync(panelPath, 'utf8');
const css = readFileSync(cssPath, 'utf8');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');

const source = scriptSources
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-ast-coder';
const PERMISSIONS = manifest.permissions;
const ALL_GRANTED = [...PERMISSIONS];
const MEMCORE = 'com.shixiansi.plugin-memcore';

// --- harness -----------------------------------------------------------------

let windowListeners = [];
let bootValues = {};
const storageMap = new Map();
const shareMap = new Map();
let intervals = [];
const answered = new Set();
let postedFrom = 0;
/** 桥的状态：目录清单、文件内容、写入请求与拒绝开关。 */
let bridgeFiles = new Map();   // path → content
let bridgeListResult = [];
let bridgeWrites = [];
let writeRefuses = false;
/** plugin.call 的回答与记录。 */
let memcoreAnswer = { text: '（模拟审查）找到 1 个 Bug…' };
let memcoreFails = false;
const calls = [];

function installPanel() {
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
}

async function loadApp() {
  answered.clear();
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  for (const id of intervals) window.clearInterval(id);
  intervals = [];
  vi.resetModules();
  postedFrom = window.postMessage.mock.calls.length;
  calls.length = 0;
  bridgeWrites.length = 0;
  // eslint-disable-next-line no-new-func
  new Function(source)();
}

function posted() {
  return window.postMessage.mock.calls.map((call) => call[0]).slice(postedFrom);
}

function byType(type) {
  return posted().filter((m) => m && m.type === type);
}

function requests() {
  return byType('request').map((m) => ({ id: m.id, method: m.method, payload: m.payload }));
}

function requestsFor(method) {
  return requests().filter((r) => r.method === method);
}

function hostSends(data) {
  window.dispatchEvent(new MessageEvent('message', { data, source: window }));
}

function answer(id, result, { ok = true, error = '' } = {}) {
  answered.add(id);
  hostSends({ v: 1, type: 'response', id, ok, result, error });
}

/** manifest 的默认值 → boot 时 config.get 回的 values（真宿主在用户没改过设置时就是这样）。 */
function defaultValues() {
  const values = {};
  for (const item of manifest.config) {
    if (item.secret) continue;
    if (item.default !== undefined) values[item.key] = item.default;
  }
  return values;
}

function initFrame({ slot = 'background', granted = ALL_GRANTED } = {}) {
  return {
    v: 1, type: 'init', pluginId: PLUGIN_ID, permissions: PERMISSIONS,
    granted, surface: { kind: 'panel', slot },
  };
}

async function pump(ticks = 30) {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve();
    answerPlumbing();
  }
}

/**
 * 等一个插件的 promise，同时持续泵宿主的回包。
 * 插件的异步链要等回包才能继续，而 pump 是有限拍——两边得同时转。
 */
async function pumpUntil(promise, ticks = 60) {
  let done = false;
  const tracked = promise.then(
    (value) => { done = true; return value; },
    (err) => { done = true; throw err; },
  );
  for (let i = 0; i < ticks && !done; i += 1) {
    await Promise.race([tracked, Promise.resolve()]);
    answerPlumbing();
    await Promise.resolve();
  }
  return tracked;
}

/** 桥的 HTTP 应答形状：net.fetch 的 url 决定走哪一支。 */
function bridgeReply(method, payload) {
  const url = String(payload.url || '');
  if (url.includes('/ping')) return { status: 200, body: 'ok' };
  if (url.includes('/list')) {
    return { status: 200, body: JSON.stringify({ files: bridgeListResult }) };
  }
  if (url.includes('/read')) {
    const target = new URL(url).searchParams.get('path') || '';
    if (bridgeFiles.has(target)) return { status: 200, body: JSON.stringify({ content: bridgeFiles.get(target), truncated: false }) };
    return { status: 404, body: 'no such file' };
  }
  if (url.includes('/write')) {
    const body = JSON.parse(String(payload.body || '{}'));
    if (writeRefuses) return { status: 403, body: 'write refused by bridge' };
    const existed = bridgeFiles.has(body.path) && Boolean(bridgeFiles.get(body.path).trim());
    if (existed && !body.overwrite) {
      return { status: 200, body: JSON.stringify({ ok: false, existedBefore: true, bytes: 0 }) };
    }
    bridgeFiles.set(body.path, String(body.content || ''));
    bridgeWrites.push({ path: body.path, bytes: String(body.content || '').length, overwrite: Boolean(body.overwrite), existedBefore: existed });
    return { status: 200, body: JSON.stringify({ ok: true, bytes: String(body.content || '').length, existedBefore: existed }) };
  }
  return { status: 404, body: 'no route' };
}

function answerPlumbing() {
  for (const req of requests()) {
    if (answered.has(req.id)) continue;
    const payload = req.payload || {};
    switch (req.method) {
      case 'config.get':
        answer(req.id, { values: bootValues, secrets: {} });
        break;
      case 'storage.get': {
        const key = String(payload.key || '');
        answer(req.id, { value: storageMap.has(key) ? storageMap.get(key) : '' });
        break;
      }
      case 'storage.set':
        storageMap.set(String(payload.key || ''), String(payload.value || ''));
        answer(req.id, { ok: true });
        break;
      case 'share.get': {
        const name = String(payload.name || '');
        answer(req.id, { value: shareMap.has(`${PLUGIN_ID}/${name}`) ? shareMap.get(`${PLUGIN_ID}/${name}`) : '', at: Date.now(), key: `${PLUGIN_ID}/${name}` });
        break;
      }
      case 'share.set':
        shareMap.set(`${PLUGIN_ID}/${String(payload.name || '')}`, String(payload.value || ''));
        answer(req.id, { ok: true });
        break;
      case 'net.fetch':
        answer(req.id, bridgeReply('net.fetch', payload));
        break;
      case 'plugin.call': {
        calls.push(payload);
        if (memcoreFails) answer(req.id, null, { ok: false, error: '模拟拒绝：等 com.shixiansi.plugin-memcore/chat 的回答超时' });
        else answer(req.id, memcoreAnswer);
        break;
      }
      default:
        answer(req.id, { ok: true });
        break;
    }
  }
}

beforeEach(() => {
  installPanel();
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  bootValues = {};
  storageMap.clear();
  shareMap.clear();
  intervals = [];
  answered.clear();
  bridgeFiles = new Map();
  bridgeListResult = [];
  writeRefuses = false;
  memcoreAnswer = { text: '（模拟审查）找到 1 个 Bug…' };
  memcoreFails = false;
  window.postMessage = vi.fn();
  const originalSetInterval = window.setInterval.bind(window);
  const originalClearInterval = window.clearInterval.bind(window);
  window.setInterval = (fn, ms, ...rest) => {
    const id = originalSetInterval(fn, ms, ...rest);
    intervals.push(id);
    return id;
  };
  window.clearInterval = (id) => {
    const at = intervals.indexOf(id);
    if (at >= 0) intervals.splice(at, 1);
    return originalClearInterval(id);
  };
  const addEventListener = window.addEventListener.bind(window);
  window.addEventListener = (type, fn, opts) => {
    windowListeners.push([type, fn, opts]);
    return addEventListener(type, fn, opts);
  };
});

afterEach(() => {
  for (const id of intervals) window.clearInterval(id);
  intervals = [];
});

// --- parser ------------------------------------------------------------------

describe('parser：结构提取', () => {
  beforeEach(async () => {
    await loadApp();
  });

  test('finds functions, arrows, classes with methods, and exports', () => {
    const src = [
      'import { x } from "./x.js";',
      'export function alpha(a, b) { return a + b; }',
      'async function beta() {}',
      'const gamma = async (n) => n * 2;',
      'const delta = (n) => n + 1;',
      'export const ANSWER = 42;',
      'export default class Widget extends Base {',
      '  constructor(el) { super(); }',
      '  render() {}',
      '  static make() {}',
      '}',
      'export { x };',
    ].join('\n');
    const s = window.__ast.parser.parse(src, 'demo.js');
    const names = s.functions.map((f) => f.name);
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
    expect(names).toContain('gamma');
    expect(names).toContain('delta');
    expect(s.imports).toBe(1);
    const widget = s.classes.find((c) => c.name === 'Widget');
    expect(widget).toBeTruthy();
    expect(widget.methods).toEqual(expect.arrayContaining(['render', 'make']));
    const kinds = new Map(s.exports.map((e) => [e.name, e.kind]));
    expect(kinds.get('alpha')).toBe('decl');
    expect(kinds.get('ANSWER')).toBe('value');
    expect(kinds.get('Widget')).toBe('decl');
    expect(kinds.get('x')).toBe('named');
  });

  test('keeps line numbers honest across multi-line constructs', () => {
    const src = ['line one', '', 'function two() {', '  return 2;', '}', '', 'class Three {}'].join('\n');
    const s = window.__ast.parser.parse(src, 'a.js');
    expect(s.functions[0].line).toBe(3);
    expect(s.classes[0].line).toBe(7);
    expect(s.lines).toBe(7);
  });

  test('ignores functions and strings inside comments', () => {
    const src = [
      '// function ghost() {}',
      '/* class AlsoGhost extends Nothing {} */',
      'const real = "function fakeInString() {}";',
      'function realFn() {}',
    ].join('\n');
    const s = window.__ast.parser.parse(src, 'c.js');
    expect(s.functions.map((f) => f.name)).toEqual(['realFn']);
    expect(s.classes).toEqual([]);
  });

  test('records TODOs and never throws on garbage', () => {
    const withTodo = window.__ast.parser.parse('function a() {}\n// TODO: 修这里\n// FIXME(hack) 另一处', 't.js');
    expect(withTodo.todos.length).toBe(2);
    expect(() => window.__ast.parser.parse('}{ 张三 李四 ][ 𝄞 随便什么', 'g.js')).not.toThrow();
    expect(window.__ast.parser.parse('', 'e.js').lines).toBe(1);
  });

  test('summarize clamps to the rune cap', () => {
    // 方法按真实形状写（每行一个，类体缩进两格）——单行类体的方法是提取器明确不追的形状。
    const big = window.__ast.parser.parse(
      ['class C {', ...Array.from({ length: 40 }, (_, i) => `  m${i}() {}`), '}'].join('\n'),
      'big.js',
    );
    const text = window.__ast.parser.summarize(big, 80);
    expect(Array.from(text).length).toBeLessThanOrEqual(81);
    expect(text.endsWith('…')).toBe(true);
  });
});

// --- manifest & css ----------------------------------------------------------

describe('manifest', () => {
  test('declares the headless frame and serves exactly what the code answers', () => {
    expect(manifest.background).toBe(true);
    expect(manifest.permissions).toContain('net.fetch');
    expect(manifest.serves).toEqual(['analyze', 'review', 'genTests']);
  });

  test('targets only memcore, and netHosts covers the bridge default', () => {
    expect(manifest.callTargets).toEqual([`${MEMCORE}/chat`]);
    expect(manifest.netHosts).toContain('127.0.0.1:23180');
    const bridge = manifest.config.find((item) => item.key === 'bridgeUrl');
    expect(bridge.hostWhitelist).toBe(true);
  });

  test('write-to-disk is opt-out but review is always available', () => {
    const byKey = new Map(manifest.config.map((item) => [item.key, item]));
    expect(byKey.get('testsWriteEnabled').default).toBe('true');
    expect(byKey.get('watchEnabled').default).toBe('false');
  });
});

describe('style.css', () => {
  test('ships no hardcoded colour', () => {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const hex = stripped.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    expect(hex, `style.css 写死了颜色：${hex.join(', ')}`).toEqual([]);
  });
});

// --- the frame ---------------------------------------------------------------

describe('the frame', () => {
  test('workshop renders and never opens a socket or a bridge by itself', async () => {
    await loadApp();
    hostSends(initFrame({ slot: 'workshop' }));
    await pump(12);
    expect(requestsFor('ws.open')).toHaveLength(0);
    expect(requestsFor('net.fetch')).toHaveLength(0);
    expect(document.getElementById('workshop').classList.contains('hidden')).toBe(false);
  });

  test('background boot probes the bridge and starts the watcher when enabled', async () => {
    bridgeListResult = [];
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    bootValues = { ...defaultValues(), watchEnabled: 'true', watchDir: 'C:/proj' };
    await pump(24);
    // 直接驱动一次扫描（轮询定时器等不起）：空目录 → 0 个文件。扫描内部要等
    // 宿主的回包，所以用 pumpUntil 边等边答。
    const scan = await pumpUntil(window.__ast.scanOnce());
    expect(scan.total).toBe(0);
    expect(window.__ast.state().bridge.ok).toBe(true);
    expect(requestsFor('net.fetch').length).toBeGreaterThan(0);
  });

  test('granted=[] sends nothing that needs a permission', async () => {
    await loadApp();
    hostSends(initFrame({ slot: 'background', granted: [] }));
    await pump(12);
    bootValues = defaultValues();
    const gated = requests().filter((r) => r.method !== 'net.fetch');
    // net.fetch 是桥探测（background 的资格权限），配置为空时它不会被发出。
    expect(gated).toEqual([]);
    expect(requestsFor('net.fetch')).toHaveLength(0);
  });
});

// --- plumbing ----------------------------------------------------------------

const SAMPLE = [
  'export function clamp(n, min, max) {',
  '  if (n < min) return min;',
  '  return n;',
  '}',
].join('\n');

describe('plumbing：扫描、审查、生成测试', () => {
  beforeEach(() => {
    bootValues = defaultValues();
  });
  test('scan indexes only code files, honors caps, and persists the index', async () => {
    bridgeListResult = [
      { path: 'C:/proj/a.js', bytes: SAMPLE.length, mtime: 1 },
      { path: 'C:/proj/notes.txt', bytes: 10, mtime: 2 },
      { path: 'C:/proj/huge.js', bytes: 10 * 1024 * 1024, mtime: 3 },
    ];
    bridgeFiles.set('C:/proj/a.js', SAMPLE);
    await loadApp();
    bootValues = defaultValues();
    hostSends(initFrame({ slot: 'background' }));
    await pump(24);
    window.__ast.setCfg({ watchDir: 'C:/proj', maxFileKB: '256', bridgeUrl: '127.0.0.1:23180' });
    const scan = await pumpUntil(window.__ast.scanOnce());
    expect(scan.added).toBe(1);
    expect(scan.total).toBe(1);
    const hit = window.__ast.index.get('C:/proj/a.js');
    expect(hit.structure.functions.map((f) => f.name)).toEqual(['clamp']);
    // 索引落盘（工坊页重启后立即可用；只存摘要，不存源码）。
    const saved = JSON.parse(storageMap.get('state/index') || '{}');
    expect(saved.entries[0].path).toBe('C:/proj/a.js');
    expect(saved.entries[0].summary).toContain('clamp');
    expect(JSON.stringify(saved)).not.toContain('if (n < min)');
  });

  test('review sends the clamped code to memcore with the reviewer prompt', async () => {
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    await pump(24);
    window.__ast.setCfg({ reviewMaxChars: '500' });
    const out = await pumpUntil(window.__ast.handleReview({ code: 'x'.repeat(900), note: '工具函数' }));
    expect(out.clipped).toBe(true);
    expect(out.roleId).toBe('coder-review');
    const call = calls[calls.length - 1];
    expect(call.target).toBe(MEMCORE);
    expect(call.method).toBe('chat');
    expect(call.payload.roleId).toBe('coder-review');
    expect(call.payload.text).toContain('代码审查专家');
    expect(call.payload.text).toContain('Bug');
    expect(call.payload.text).toContain('已截断');
  });

  test('review surfaces memcore failures without throwing away the loop', async () => {
    memcoreFails = true;
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    await pump(24);
    await expect(pumpUntil(window.__ast.handleReview({ code: 'let a = 1;' }))).rejects.toThrow('com.shixiansi.plugin-memcore');
    expect(window.__ast.state().review.lastError).toContain('记忆核心');
  });

  test('genTests writes NAME.test.js next to the watched dir — once', async () => {
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    await pump(24);
    window.__ast.setCfg({ watchDir: 'C:/proj' });
    memcoreAnswer = { text: '好的：\n```js\nimport { describe, test, expect } from "vitest";\ntest("clamp 边界", () => { expect(true).toBe(true); });\n```\n请查收。' };
    const out = await pumpUntil(window.__ast.handleGenTests({ code: SAMPLE, name: 'clamp.js' }));
    expect(out.wrote).toBe(true);
    expect(out.target).toBe('clamp.test.js');
    expect(bridgeWrites).toHaveLength(1);
    expect(bridgeWrites[0].path).toBe('C:/proj/clamp.test.js');
    expect(bridgeWrites[0].overwrite).toBe(true);
    expect(out.code).toContain('test(');

    // 再来一次：目标已存在且非空 → 不覆盖。
    memcoreAnswer = { text: '```js\ntest("another", () => {});\n```' };
    const second = await pumpUntil(window.__ast.handleGenTests({ code: SAMPLE, name: 'clamp.js' }));
    expect(second.wrote).toBe(false);
    expect(second.existedBefore).toBe(true);
    expect(bridgeWrites).toHaveLength(1);
    expect(bridgeFiles.get('C:/proj/clamp.test.js')).toContain('clamp 边界');
  });

  test('genTests refuses to write anything but .test.js targets and honors the switch', async () => {
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    await pump(24);
    window.__ast.setCfg({ watchDir: 'C:/proj', testsWriteEnabled: 'false' });
    memcoreAnswer = { text: '```\ntest("x", () => {});\n```' };
    const out = await pumpUntil(window.__ast.handleGenTests({ code: SAMPLE, name: 'clamp.js' }));
    expect(out.wrote).toBe(false);
    expect(bridgeWrites).toHaveLength(0);
    // 目标路径永远以 .test.js 结尾——名字里塞什么都改不了这一点。
    const weird = await pumpUntil(window.__ast.handleGenTests({ code: SAMPLE, name: '../../evil' }));
    expect(weird.target).toBe('evil.test.js');
  });

  test('genTests fails loudly when the model output is not a test file', async () => {
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    await pump(24);
    window.__ast.setCfg({ watchDir: 'C:/proj' });
    memcoreAnswer = { text: '这段代码看起来不错，不需要测试。' };
    await expect(pumpUntil(window.__ast.handleGenTests({ code: SAMPLE, name: 'm' }))).rejects.toThrow('测试文件');
  });

  test('analyze answers from pasted code OR the index, and rejects the empty case', async () => {
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    await pump(24);
    const pasted = await window.__ast.handleAnalyze({ code: SAMPLE, path: 'C:/proj/a.js' });
    expect(pasted.structure.functions[0].name).toBe('clamp');
    expect(pasted.summary).toContain('clamp');

    window.__ast.index.set('C:/proj/b.js', { structure: window.__ast.parser.parse(SAMPLE, 'b.js'), summary: 'S' });
    const fromIndex = await window.__ast.handleAnalyze({ path: 'C:/proj/b.js' });
    expect(fromIndex.structure.file).toBe('b.js');
    await expect(window.__ast.handleAnalyze({})).rejects.toThrow('code 或 path');
  });

  test('the share command starts/stops the watcher exactly once per at', async () => {
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    await pump(24);
    window.__ast.setCfg({ watchDir: 'C:/proj' });
    shareMap.set(`${PLUGIN_ID}/coder-command`, JSON.stringify({ op: 'watch-start', at: 1000 }));
    const poll = window.__ast.pollCommand();
    await pump(8);
    await poll;
    expect(window.__ast.state().watcher.running).toBe(true);
    const poll2 = window.__ast.pollCommand();
    await pump(8);
    await poll2;
    expect(window.__ast.state().watcher.running).toBe(true);
    shareMap.set(`${PLUGIN_ID}/coder-command`, JSON.stringify({ op: 'watch-stop', at: 1001 }));
    const poll3 = window.__ast.pollCommand();
    await pump(8);
    await poll3;
    expect(window.__ast.state().watcher.running).toBe(false);
  });

  test('the serves list and CALL_HANDLERS stay pinned together', async () => {
    await loadApp();
    expect(Object.keys(window.__ast.handlers).sort()).toEqual([...manifest.serves].sort());
  });
});

// --- share.changed 接线（宿主事件 → 立刻读命令） --------------------------------
//
// 命令键是同一个插件的两个帧之间的通道：工坊页写，常驻帧读。以前靠 3 秒轮询，现在宿主在
// share.set 之后发 share.changed（手册 §7.1），这里只留 15 秒兜底。两条都在源码里钉住：
// 一条丢了就退回轮询，而轮询的症状只是"慢"和日志变吵——测试不盯就没人发现。

test('share.changed 接线：事件分支在、兜底是 15 秒', () => {
  // 消息泵把 event 交给 onHostEvent（而不是落进 default 被忽略）。
  expect(source).toMatch(/case 'event':\s*\n\s*onHostEvent\(data\)/);
  // onHostEvent 只认自己名下的键：别人的键变了不该触发读。
  expect(source).toMatch(/function onHostEvent\(data\)/);
  expect(source).toContain("key.startsWith(self.pluginId + '/')");
  // 兜底不再是 3 秒。
  expect(source).toContain('}, 15000);');
  expect(source).not.toContain('}, 3000);');
});

// --- 变化通知（config.changed） ----------------------------------------------
//
// 工坊页在控制中心里，而控制中心现在也会推 `config.changed`（手册 §7，两个宿主都发）。
// 以前这一页 5 秒一次 `config.get` —— 真机上那是这个插件最大的一笔调用量，而用户改设置
// 一天也就几次。
describe('设置变化走事件', () => {
  test('config.changed（自己的）到了就重读设置', async () => {
    loadApp();
    hostSends(initFrame({ slot: 'workshop' }));
    await pump(20);
    const before = requestsFor('config.get').length;
    hostSends({ v: 1, type: 'event', name: 'config.changed', payload: { pluginId: PLUGIN_ID } });
    await pump(10);
    expect(requestsFor('config.get').length, 'config.changed 没有触发 config.get').toBeGreaterThan(before);
  });

  test('不是自己那份设置时不重读', async () => {
    loadApp();
    hostSends(initFrame({ slot: 'workshop' }));
    await pump(20);
    const before = requestsFor('config.get').length;
    hostSends({ v: 1, type: 'event', name: 'config.changed', payload: { pluginId: 'com.example.someone-else' } });
    await pump(10);
    expect(requestsFor('config.get').length).toBe(before);
  });

  test('兜底是 60 秒，不是 5 秒', () => {
    const source = readFileSync(path.join(pluginDir, 'app.js'), 'utf8');
    expect(source, '工坊页又退回 5 秒一轮了').toContain('}, 60_000);');
    expect(source).not.toContain('}, 5000);');
  });
});
