import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Behaviour tests for the state-snapshot plugin (and memcore's export/import-state).
//
// THE test of the whole feature is the A/B rollback: write 10 memories, snapshot A,
// write 10 more, snapshot B, roll back to A — memcore must hold exactly the first
// ten and nothing else. The memcore half runs through its real lib/snapshot.js
// against a fake storage; the snapshot-plugin half runs through its real panel.html
// markup with a fake memcore behind plugin.call.

const here = path.dirname(fileURLToPath(import.meta.url));
const marketRoot = path.join(here, '..');
const pluginDir = path.join(marketRoot, 'plugins', 'com.shixiansi.plugin-state-snapshot');
const memcoreDir = path.join(marketRoot, 'plugins', 'com.shixiansi.plugin-memcore');
const panelPath = path.join(pluginDir, 'panel.html');
const cssPath = path.join(pluginDir, 'style.css');
const manifestPath = path.join(pluginDir, 'manifest.json');

const html = readFileSync(panelPath, 'utf8');
const css = readFileSync(cssPath, 'utf8');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// memcore's snapshot library is evaluated in the SAME jsdom window as the snapshot
// plugin's tests: it needs the bridge helpers from memcore's lib/core.js.
const memcoreCore = readFileSync(path.join(memcoreDir, 'lib', 'core.js'), 'utf8');
const memcoreSnapshot = readFileSync(path.join(memcoreDir, 'lib', 'snapshot.js'), 'utf8');

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');

const source = scriptSources
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-state-snapshot';
const MEMCORE = 'com.shixiansi.plugin-memcore';
const PERMISSIONS = manifest.permissions;
const ALL_GRANTED = [...PERMISSIONS];

// --- harness -----------------------------------------------------------------

let windowListeners = [];
let bootValues = {};
const storageMap = new Map();
let intervals = [];
const answered = new Set();
let postedFrom = 0;
/** 记忆核心的私有库（模拟它的 storage 空间——与插件的 storageMap 分开）。 */
let memcoreStorage = new Map();
/** plugin.call 的分发：按 method 走 memcore 的真实现（export/import-state）。 */
const calls = [];
let memcoreOnline = true;

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
  // eslint-disable-next-line no-new-func
  new Function(source)();
}

/** 把 memcore 的 core+snapshot 评进同一个全局（它们是经典 script，共享作用域）。 */
async function loadMemcoreSnapshotLib() {
  // memcore/core.js 定义 request/postToHost 等；为了让它的 request 落到我们的
  // memcoreStorage 上，先塞一个最小的桥再评 snapshot.js。
  // eslint-disable-next-line no-new-func
  new Function(`
    const els = {};
    const PROTOCOL = 1;
    let nextRequestID = 1;
    const pending = new Map();
    const granted = new Set(['storage']);
    let self = { pluginId: '${MEMCORE}', slot: 'background' };
    let ready = true;
    let cfg = {};
    function postToHost() {}
    async function __fakeRequest(method, payload) {
      payload = payload || {};
      if (method === 'storage.list') {
        const sub = String(payload.sub || '');
        const prefix = sub ? sub + '/' : '';
        const files = [];
        const dirs = new Set();
        for (const key of globalThis.__memcoreStore.keys()) {
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          if (rest.includes('/')) dirs.add(rest.split('/')[0]);
          else files.push({ name: rest, bytes: String(globalThis.__memcoreStore.get(key)).length });
        }
        return { dir: prefix, files, dirs: [...dirs] };
      }
      if (method === 'storage.get') {
        return { value: globalThis.__memcoreStore.has(payload.key) ? globalThis.__memcoreStore.get(payload.key) : '' };
      }
      if (method === 'storage.set') {
        globalThis.__memcoreStore.set(payload.key, String(payload.value ?? ''));
        return { ok: true };
      }
      if (method === 'storage.remove') {
        globalThis.__memcoreStore.delete(payload.key);
        return { ok: true };
      }
      throw new Error('fake memcore host: ' + method);
    }
    function text(v, m) { const s = String(v ?? ''); const l = Number.isFinite(m) && m > 0 ? m : 2000; return s.length > l ? s.slice(0, l) + '…' : s; }
    function clampInt(v, min, max, f) { const n = parseInt(String(v ?? ''), 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : f; }
    function num(key, min, max, f) { return clampInt(cfg[key], min, max, f); }
    function flag(key, f) { const v = cfg[key]; if (v === undefined || v === null || v === '') return f; return v === true || v === 'true' || v === '1' || v === 1; }
    function now() { return Date.now(); }
    async function readJSON(key, fallback) {
      if (!granted.has('storage')) return fallback;
      try {
        const out = await __fakeRequest('storage.get', { key });
        const raw = out && typeof out.value === 'string' ? out.value : '';
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        return parsed === null || parsed === undefined ? fallback : parsed;
      } catch { return fallback; }
    }
    async function writeJSON(key, value) { await __fakeRequest('storage.set', { key, value: JSON.stringify(value) }); }
    const request = __fakeRequest;
    ${memcoreSnapshot}
    globalThis.__memcoreSnap = { handleExportState, handleImportState, compactStateKey };
  `)();
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

function initFrame({ slot = 'workshop', granted = ALL_GRANTED } = {}) {
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

/** 等一个插件的 promise，同时持续泵宿主的回包（插件的异步链要等回包才能继续）。 */
async function pumpUntil(promise, ticks = 80) {
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

/** 直接调 memcore 的快照实现（测试半边）。 */
async function memcoreExport() {
  return globalThis.__memcoreSnap.handleExportState({});
}

async function memcoreImport(snapshot) {
  return globalThis.__memcoreSnap.handleImportState({ snapshot });
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
      case 'storage.remove':
        storageMap.delete(String(payload.key || ''));
        answer(req.id, { ok: true });
        break;
      case 'plugin.call': {
        calls.push(payload);
        if (!memcoreOnline) {
          answer(req.id, null, { ok: false, error: `模拟拒绝：等 ${MEMCORE}/chat 的回答超时` });
          break;
        }
        if (payload.target !== MEMCORE) {
          answer(req.id, null, { ok: false, error: `问不到 ${payload.target}` });
          break;
        }
        // answered 先记下：memcore 的 export/import 是异步的，不等它完成就把 id 标记掉，
        // 否则 pump 的每一拍都会把同一条调用再分发一遍（症状：一次 create 触发四次 export）。
        answered.add(req.id);
        const inner = payload.payload || {};
        if (payload.method === 'export-state') {
          globalThis.__memcoreSnap.handleExportState(inner).then(
            (result) => hostSends({ v: 1, type: 'response', id: req.id, ok: true, result }),
            (err) => hostSends({ v: 1, type: 'response', id: req.id, ok: false, error: String(err && err.message) }),
          );
        } else if (payload.method === 'import-state') {
          globalThis.__memcoreSnap.handleImportState(inner).then(
            (result) => hostSends({ v: 1, type: 'response', id: req.id, ok: true, result }),
            (err) => hostSends({ v: 1, type: 'response', id: req.id, ok: false, error: String(err && err.message) }),
          );
        } else {
          answer(req.id, null, { ok: false, error: `${MEMCORE} 不认识方法 ${payload.method}` });
        }
        break;
      }
      case 'bubble.say':
        answer(req.id, { ok: true });
        break;
      default:
        answer(req.id, { ok: true });
        break;
    }
  }
}

beforeEach(async () => {
  // 上一个文档的监听器先摘掉，再清数组：数组一旦清空，loadApp 就再也摘不掉它们，
  // 旧文档会活着收下一个测试的回包（症状：旧闭包把新文档的请求答到旧 pending 上）。
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  installPanel();
  bootValues = {};
  storageMap.clear();
  memcoreStorage = new Map();
  globalThis.__memcoreStore = memcoreStorage;
  intervals = [];
  answered.clear();
  memcoreOnline = true;
  await loadMemcoreSnapshotLib();
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

/** 往 memcore 的库里写 n 条记忆（模拟"又聊了 n 轮"）。 */
function seedMemories(prefix, count) {
  for (let i = 0; i < count; i += 1) {
    memcoreStorage.set(`mem/role/conv-${prefix}/episodes`, JSON.stringify(
      (JSON.parse(memcoreStorage.get(`mem/role/conv-${prefix}/episodes`) || '[]')).concat([{ at: Date.now() + i, text: `${prefix}-${i}` }]),
    ));
  }
  memcoreStorage.set(`mem/role/conv-${prefix}/turns`, JSON.stringify([{ role: 'user', text: `${prefix} 的一句话` }]));
}

function readEpisodes(prefix) {
  return JSON.parse(memcoreStorage.get(`mem/role/conv-${prefix}/episodes`) || '[]');
}

// --- memcore 侧：export / import ----------------------------------------------

describe('memcore export/import-state', () => {
  test('export packages every mem/** key plus compact state, counts included', async () => {
    seedMemories('a', 3);
    memcoreStorage.set('mem/user/u1/profile', JSON.stringify({ name: '小明', prefs: [], habits: [], stage: '', at: 1 }));
    memcoreStorage.set('mem/global/chain', JSON.stringify([{ at: 1, kind: 'in' }]));
    memcoreStorage.set('compact/state', JSON.stringify({ lastDay: '2026-10-30', lastAt: 1 }));
    memcoreStorage.set('state/unrelated', JSON.stringify({ nope: true }));

    const snap = await memcoreExport();
    expect(snap.kind).toBe('memcore-state');
    expect(snap.version).toBe(1);
    const keys = snap.entries.map((e) => e.key);
    expect(keys).toContain('mem/role/conv-a/episodes');
    expect(keys).toContain('mem/role/conv-a/turns');
    expect(keys).toContain('mem/user/u1/profile');
    expect(keys).toContain('mem/global/chain');
    expect(keys).toContain('compact/state');
    expect(keys).not.toContain('state/unrelated');
    expect(snap.counts.roles).toBe(3);
    expect(snap.counts.roleSessions).toBe(1);
    expect(snap.counts.users).toBe(1);
    expect(snap.counts.globalChain).toBe(1);
    expect(snap.counts.compactState).toBe(1);
  });

  test('export works on an empty library (first-run snapshot)', async () => {
    const snap = await memcoreExport();
    expect(snap.entries).toEqual([]);
    expect(snap.counts.keys).toBe(0);
  });

  test('import replaces the whole library: nothing of the present survives', async () => {
    seedMemories('a', 3);
    const snap = await memcoreExport();
    // 现在的世界继续演进：新的会话、新的记忆、改过的 profile。
    seedMemories('b', 5);
    memcoreStorage.set('mem/role/conv-a/episodes', JSON.stringify([{ at: 1, text: '污染' }]));
    memcoreStorage.set('mem/user/u2/profile', JSON.stringify({ name: '别人' }));

    const out = await memcoreImport(snap);
    expect(out.removed).toBeGreaterThan(0);
    expect(out.restored).toBe(snap.entries.length);
    expect([...memcoreStorage.keys()].filter((k) => k.startsWith('mem/role/conv-b'))).toEqual([]);
    expect(readEpisodes('a').map((e) => e.text)).toEqual(['a-0', 'a-1', 'a-2']);
    // u2 是回滚目标之外的新世界：整库替换后不再存在。
    expect(memcoreStorage.has('mem/user/u2/profile')).toBe(false);
  });

  test('import refuses an empty or foreign snapshot instead of wiping the library', async () => {
    seedMemories('a', 2);
    await expect(memcoreImport(null)).rejects.toThrow('snapshot');
    await expect(memcoreImport({ kind: 'other-tool', entries: [] })).rejects.toThrow('类型不对');
    await expect(memcoreImport({ kind: 'memcore-state', entries: [] })).rejects.toThrow('拒绝整库清空');
    // 拒绝 = 现有记忆原封不动。
    expect(readEpisodes('a')).toHaveLength(2);
  });

  test('A/B rollback: 10 memories, snapshot A, 10 more, snapshot B, roll back to A', async () => {
    const chatKey = 'mem/role/conv-chat/episodes';
    const appendChat = (i) => {
      memcoreStorage.set(chatKey, JSON.stringify(
        (JSON.parse(memcoreStorage.get(chatKey) || '[]')).concat([{ at: 1000 + i, text: `记忆${i}` }]),
      ));
    };
    // —— 快照 A 之前：写 10 条记忆。
    for (let i = 0; i < 10; i += 1) appendChat(i);
    const snapshotA = await memcoreExport();
    expect(snapshotA.counts.roles).toBe(10);

    // —— 快照 A 之后：再写 10 条 + 一个新会话。
    for (let i = 10; i < 20; i += 1) appendChat(i);
    seedMemories('fresh', 2);
    const snapshotB = await memcoreExport();
    expect(snapshotB.counts.roles).toBe(22); // chat 20 + fresh 2
    expect(snapshotB.counts.roleSessions).toBe(2);

    // —— 回滚到 A。
    const out = await memcoreImport(snapshotA);
    expect(out.restored).toBe(snapshotA.entries.length);
    const episodes = readEpisodes('chat');
    expect(episodes).toHaveLength(10);
    expect(episodes.map((e) => e.text)).toEqual(Array.from({ length: 10 }, (_, i) => `记忆${i}`));
    // 脏数据检查：B 时代的会话与记忆都不在。
    expect([...memcoreStorage.keys()].filter((k) => k.startsWith('mem/role/conv-fresh'))).toEqual([]);
    expect(memcoreStorage.get(chatKey)).not.toContain('记忆10');
    // 回滚到 A 之后再回 B 也可以（快照不会因为回滚而失效）。
    await memcoreImport(snapshotB);
    expect(readEpisodes('chat')).toHaveLength(20);
    expect(readEpisodes('fresh')).toHaveLength(2);
  });
});

// --- 快照插件侧 ---------------------------------------------------------------

describe('manifest', () => {
  test('targets exactly the two memcore snapshot methods and serves nothing', () => {
    expect(manifest.callTargets).toEqual([
      `${MEMCORE}/export-state`,
      `${MEMCORE}/import-state`,
    ]);
    expect(manifest.serves).toBeUndefined();
  });

  test('is a panel plugin (a workshop tool), with the rollback switch on', () => {
    expect(manifest.panel).toBe(true);
    const byKey = new Map(manifest.config.map((item) => [item.key, item]));
    expect(byKey.get('confirmRollback').default).toBe('true');
    expect(byKey.get('bubbleOnRollback').default).toBe('true');
    expect(byKey.get('maxSnapshots').default).toBe('20');
  });
});

describe('style.css', () => {
  test('ships no hardcoded colour', () => {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const hex = stripped.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    expect(hex, `style.css 写死了颜色：${hex.join(', ')}`).toEqual([]);
  });
});

describe('the frame', () => {
  test('workshop renders the timeline and only asks memcore on demand', async () => {
    await loadApp();
    hostSends(initFrame({ slot: 'workshop' }));
    await pump(12);
    expect(document.getElementById('workshop').classList.contains('hidden')).toBe(false);
    expect(requestsFor('plugin.call')).toHaveLength(0);
    // 空库：时间线空状态可见。
    expect(document.getElementById('timeline-empty').hidden).toBe(false);
  });

  test('create stores the snapshot; rollback replaces memcore and logs the record', async () => {
    seedMemories('a', 3);
    await loadApp();
    hostSends(initFrame({ slot: 'workshop' }));
    await pump(12);
    // 建档 A。
    const entryA = await pumpUntil(window.__snaps.create({ name: '第一版' }));
    expect(entryA.name).toBe('第一版');
    expect(entryA.counts.roles).toBe(3);
    // 世界继续走。
    seedMemories('a', 2);
    // 建档 B（自动命名）。
    const entryB = await pumpUntil(window.__snaps.create({}));
    expect(entryB.name).toContain('存档');
    expect(readEpisodes('a')).toHaveLength(5);

    // 回滚到 A。
    const record = await pumpUntil(window.__snaps.rollback({ id: entryA.id }));
    expect(record.restored).toBeGreaterThan(0);
    expect(readEpisodes('a').map((e) => e.text)).toEqual(['a-0', 'a-1', 'a-2']);
    // 回滚痕迹落盘。
    const log = JSON.parse(storageMap.get('state/rollback-log') || '[]');
    expect(log).toHaveLength(1);
    expect(log[0].name).toBe('第一版');
    // 时间线渲染两条（新→旧）。rollbackButton 里的 renderTimeline 是射后不理的异步，
    // 给它几拍把 storage 往返和 DOM 更新跑完。
    const rendered = window.__snaps.renderTimeline();
    await pump(20);
    await rendered;
    // B 建档时已经有 5 条记忆（3+2）与一个会话：自动命名反映的是建档那一刻的统计。
    const names = [...document.querySelectorAll('.snap-name')].map((el) => el.textContent);
    expect(names).toEqual(['存档（1 会话，5 条长期记忆）', '第一版']);
  }, 20000);

  test('rollback with memcore down fails loudly and the store keeps the snapshot', async () => {
    memcoreOnline = false;
    seedMemories('a', 2);
    await loadApp();
    hostSends(initFrame({ slot: 'workshop' }));
    await pump(12);
    await expect(pumpUntil(window.__snaps.create({ name: '离线存档' }))).rejects.toThrow('模拟拒绝');
    expect(window.__snaps.state().lastError).toContain('快照没有建成');
    // 没建成 = 没有清单条目（半张快照比没有更糟）。
    expect(await pumpUntil(window.__snaps.store.list())).toEqual([]);
  }, 20000);

  test('capacity evicts the OLDEST snapshot with its data', async () => {
    await loadApp();
    hostSends(initFrame({ slot: 'workshop' }));
    await pump(12);
    window.__snaps.setCfg({ maxSnapshots: '2' });
    const a = await pumpUntil(window.__snaps.create({ name: 'A' }));
    const b = await pumpUntil(window.__snaps.create({ name: 'B' }));
    const c = await pumpUntil(window.__snaps.create({ name: 'C' }));
    const list = await pumpUntil(window.__snaps.store.list());
    expect(list.map((e) => e.name)).toEqual(['B', 'C']);
    expect(await pumpUntil(window.__snaps.store.load(a.id))).toBeNull(); // 数据也没了，不只是清单
    expect(await pumpUntil(window.__snaps.store.load(c.id))).not.toBeNull();
    // 保存 C 时把最旧的 A 挤了出去（b/c 都还留得住）。
    expect(c.evicted.id).toBe(a.id);
    expect(b.evicted).toBeNull();
  }, 20000);

  test('rename changes the index entry only; delete removes both index and data', async () => {
    seedMemories('a', 2);
    await loadApp();
    hostSends(initFrame({ slot: 'workshop' }));
    await pump(12);
    const entry = await pumpUntil(window.__snaps.create({ name: '原名' }));
    const renamed = await pumpUntil(window.__snaps.store.rename(entry.id, '新名字'));
    expect(renamed.name).toBe('新名字');
    const pack = await pumpUntil(window.__snaps.store.load(entry.id));
    expect(pack.snapshot.entries.length).toBeGreaterThan(0);
    expect(await pumpUntil(window.__snaps.store.remove(entry.id))).toBe(true);
    expect(await pumpUntil(window.__snaps.store.load(entry.id))).toBeNull();
    expect(await pumpUntil(window.__snaps.store.list())).toEqual([]);
  }, 20000);

  test('a poisoned snapshot id never reaches storage', async () => {
    await loadApp();
    hostSends(initFrame({ slot: 'workshop' }));
    await pump(12);
    expect(await window.__snaps.store.load('../escape')).toBeNull();
    expect(await window.__snaps.store.remove('../escape')).toBe(false);
  });

  test('granted=[] sends nothing that needs a permission', async () => {
    await loadApp();
    hostSends(initFrame({ slot: 'workshop', granted: [] }));
    await pump(12);
    expect(requests()).toEqual([]);
  });
});
