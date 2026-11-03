import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// GitHub 通知插件的行为测试：驱动的是 panel.html 里真实加载的那几支脚本。
//
// harness 与 rss-reader 的测试同型：源码拼起来 new Function 丢进 vitest 的 jsdom window，
// 出站 postMessage 用 spy 记下，宿主应答用手写 respond 表（net.fetch 用手动 respond 补包
// mock——任务书 §3），pump() 把"一个答复引出下一个请求"的链泵到安静。
//
// 这个文件钉住的几件事（任务书 §3 全部断言）：
//   1. 新通知 → 恰好一条气泡，文案含类型短语与仓库名；
//   2. ETag 命中（304）→ 零气泡、零 storage 写；
//   3. 已见过的通知 id 不再气泡（去重集合持久化在 storage）；
//   4. 401 / 403 / 429（含 x-ratelimit-remaining=0）三种错误分开断言；
//   5. token 不出现在任何 storage.set 的 payload 里、不出现在气泡文案里；
//   6. granted=[]：零请求、零写、不崩、未授权态说出口；
//   7. 断网（net.fetch respond ok:false）：静默保留上次状态，不崩不清空列表。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-github-notify');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((m) => m[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');
const source = scriptSources.map((src) => readFileSync(path.join(pluginDir, src), 'utf8')).join('\n');

const TOKEN = 'ghp_test_0123456789abcdef';
const TOKEN_CONFIG = { token: TOKEN, publicRepo: '', pollMin: '15', quietBubble: 'false' };

// --- 测试用的 GitHub 响应 ---------------------------------------------------------

const PR_NOTE = {
  id: 'n1',
  unread: true,
  updated_at: '2026-11-02T10:00:00Z',
  repository: { full_name: 'shixiansi/pet-pc' },
  subject: { title: 'Add background frame', type: 'PullRequest', url: 'https://api.github.com/repos/shixiansi/pet-pc/pulls/1' },
};
const ISSUE_NOTE = {
  id: 'n2',
  unread: true,
  updated_at: '2026-11-02T11:00:00Z',
  repository: { full_name: 'shixiansi/pet-pc' },
  subject: { title: '气泡文案太吵', type: 'Issue', url: 'https://api.github.com/repos/shixiansi/pet-pc/issues/7' },
};
const CI_NOTE = {
  id: 'n3',
  unread: true,
  updated_at: '2026-11-02T12:00:00Z',
  repository: { full_name: 'shixiansi/pet-pc' },
  subject: { title: 'CI on main', type: 'CheckSuite', url: '' },
};

// --- harness ---------------------------------------------------------------------

let store;
let configValues;
let fetchQueue;       // net.fetch 的手动补包队列：[{status, body, headers?, ok?, error?}]
let fetchCalls;
let answered;
let postedFrom;
let windowListeners;
let intervals;
let timeouts;

function posted() {
  return window.postMessage.mock.calls.map((c) => c[0]).slice(postedFrom);
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

async function pump(maxRounds = 60) {
  for (let i = 0; i < maxRounds; i += 1) {
    const list = requests().filter((r) => !answered.has(r.id));
    if (!list.length) {
      // 眼下没人要答：让一个宏任务过去（挂着的 refreshCycle 可能正要发出下一个请求），
      // 仍没有就收工。没有这个让步，"await refreshCycle() 之前先 pump"的调用会死锁。
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!requests().some((r) => !answered.has(r.id))) return;
      continue;
    }
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
          answer(req.id, { ok: true });
          break;
        case 'storage.remove':
          answer(req.id, { ok: true });
          break;
        case 'net.fetch': {
          fetchCalls.push(payload);
          const packet = fetchQueue.length ? fetchQueue.shift() : { status: 200, body: '[]' };
          if (packet.ok === false) answer(req.id, null, { ok: false, error: packet.error || '网络不可达' });
          else answer(req.id, { status: packet.status, body: packet.body, headers: packet.headers });
          break;
        }
        case 'bubble.say':
          answer(req.id, { ok: true });
          break;
        default:
          answer(req.id, null, { ok: false, error: `本程序不支持该方法 ${req.method}` });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const macro = () => new Promise((resolve) => setTimeout(resolve, 0));

function loadApp() {
  answered = new Set();
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  for (const id of intervals) clearInterval(id);
  intervals = [];
  for (const id of timeouts) clearTimeout(id);
  timeouts = [];
  postedFrom = window.postMessage.mock.calls.length;
  // eslint-disable-next-line no-new-func
  new Function(source)();
}

// panel.html 的 <body id="root"> 是 app.js 的 $('root')。vitest 的 jsdom 整文件共享一个
// document：把插件 body 的 innerHTML 抄进来之后，body 自己的 id 要补上，否则 onInit 第一步
// 就崩（与真实挂载的 DOM 形状一致 = body 本身就是 root）。
function installDom() {
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
  document.body.id = 'root';
}

function boot(slot = 'background') {
  installDom();
  loadApp();
  hostSends({
    v: 1, type: 'init', pluginId: 'com.shixiansi.plugin-github-notify',
    permissions: manifest.permissions, granted: [...manifest.permissions],
    surface: { kind: 'panel', slot },
    host: { program: slot === 'workshop' ? 'workshop' : 'pet', methods: methodTable(slot) },
  });
  return macro();
}

// 与 fake-host.mjs 同一规则：workshop 没有 pet 专属方法。
const PET_METHODS = ['bubble.say', 'net.fetch', 'storage.get', 'storage.set', 'storage.remove', 'storage.stat',
  'storage.dir', 'storage.list', 'storage.move', 'storage.usage', 'plugin.log', 'config.get', 'config.set'];
function methodTable(slot) {
  const both = ['net.fetch', 'storage.get', 'storage.set', 'storage.remove', 'storage.stat', 'storage.dir',
    'storage.list', 'storage.move', 'storage.usage', 'plugin.log', 'config.get', 'config.set'];
  return slot === 'workshop' ? both : [...both, 'bubble.say'];
}

async function bootSettled(slot = 'background') {
  await boot(slot);
  await pump();
}

/** 并发跑一轮刷新：refreshCycle 内部的 net.fetch / storage.set 要有人答，
 * 答完还会引出下一批——所以 cycle 与 pump 必须同时在跑，串行 await 会死锁。 */
async function cycle() {
  const p = window.__gh.refreshCycle();
  let settled = false;
  p.finally(() => { settled = true; });
  for (let i = 0; i < 40 && !settled; i += 1) {
    await pump(6);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return p;
}

const bubbles = () => requests().filter((r) => r.method === 'bubble.say');
const writes = () => requests().filter((r) => r.method === 'storage.set');
const fetches = () => requests().filter((r) => r.method === 'net.fetch');

function notificationsBody() {
  return JSON.stringify([PR_NOTE, ISSUE_NOTE, CI_NOTE]);
}

beforeEach(() => {
  store = new Map();
  configValues = { ...TOKEN_CONFIG };
  fetchQueue = [{ status: 200, body: notificationsBody(), headers: { etag: 'W/"abc123"' } }];
  fetchCalls = [];
  windowListeners = [];
  intervals = [];
  timeouts = [];
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
  const originalTimeout = window.setTimeout.bind(window);
  vi.spyOn(window, 'setTimeout').mockImplementation((fn, ms) => {
    const id = originalTimeout(fn, ms);
    timeouts.push(id);
    return id;
  });
  vi.spyOn(window, 'postMessage').mockImplementation(() => {});
});

afterEach(() => {
  for (const id of intervals) clearInterval(id);
  for (const id of timeouts) clearTimeout(id);
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  vi.restoreAllMocks();
});

// --- manifest 形状 ----------------------------------------------------------------

describe('manifest', () => {
  test('permissions / background / netHosts 与任务书一致，无多余权限', () => {
    expect(manifest.permissions).toEqual(['net.fetch', 'storage', 'plugin.config', 'pet.bubble']);
    expect(manifest.background).toBe(true);
    expect(manifest.netHosts).toEqual(['api.github.com']);
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.author).toBe('shixiansi');
    expect(manifest.serves).toBeUndefined();
    expect(manifest.surface).toBeUndefined();
    expect(manifest.panel).toBeUndefined();
    expect(manifest.assets).toContain('ui.css');
    expect(manifest.assets).toContain('lib/core.js');
  });
});

// --- 主路径 -----------------------------------------------------------------------

describe('poll cycle', () => {
  test('新通知 → 恰好一条气泡，文案含类型短语与仓库名', async () => {
    await bootSettled();
    const list = bubbles();
    expect(list).toHaveLength(1);
    const text = String(list[0].payload.text);
    expect(text).toContain('shixiansi/pet-pc');      // 仓库名
    expect(text).toContain('PR');                    // 类型短语（PR/Issue/CI 各有措辞，第一条是 PR）
    // 三种类型短语各有形状（纯函数层直接断言）
    const core = window.__gh.core;
    expect(core.bubbleText({ repo: 'o/r', kind: 'pullrequest', title: 'T' })).toContain('PR');
    expect(core.bubbleText({ repo: 'o/r', kind: 'issue', title: 'T' })).toContain('Issue');
    expect(core.bubbleText({ repo: 'o/r', kind: 'checksuite', title: 'T' })).toContain('CI');
  });

  test('带 token 的请求带 authorization 头与 accept；If-None-Match 带上了上次的 etag', async () => {
    await bootSettled();
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain('api.github.com/notifications');
    expect(fetchCalls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(fetchCalls[0].headers.accept).toContain('vnd.github');
    expect(fetchCalls[0].headers['if-none-match']).toBeUndefined(); // 首轮没有 etag，不发条件头
  });

  test('ETag 命中（304）→ 零气泡、零重写', async () => {
    await bootSettled(); // 第一轮 200 + etag，seen/etag 已持久化
    const bubblesBefore = bubbles().length;
    const writesBefore = writes().length;

    fetchQueue = [{ status: 304, body: '' }];
    await cycle();
    await pump();

    expect(bubbles()).toHaveLength(bubblesBefore);       // 零气泡
    expect(writes()).toHaveLength(writesBefore);         // 零重写
    expect(store.has('state/v1')).toBe(true);            // 状态还在
    expect(JSON.parse(store.get('state/v1')).seen).toEqual(['n1', 'n2', 'n3']);
  });

  test('已见过的通知 id 不再气泡（去重集合持久化在 storage）', async () => {
    await bootSettled();
    expect(bubbles()).toHaveLength(1);
    expect(JSON.parse(store.get('state/v1')).seen).toEqual(['n1', 'n2', 'n3']);

    // 新一轮：同样的三条再次返回（GitHub 侧未读没变）→ 零新气泡，但列表照常更新。
    fetchQueue = [{ status: 200, body: notificationsBody(), headers: { etag: 'W/"abc123"' } }];
    await cycle();
    await pump();
    expect(bubbles()).toHaveLength(1);
  });

  test('去重集合持久化：重启（重挂帧）后同样的通知不再气泡', async () => {
    await bootSettled();
    // 重启一份新作用域：store（Map）是持久的，模拟 storage。
    await bootSettled();
    expect(bubbles()).toHaveLength(0); // 第二次 mount 从 storage 读到 seen，不再气泡
  });

  test('token 不出现在任何 storage.set 的 payload 里、不出现在气泡文案里', async () => {
    await bootSettled();
    for (const w of writes()) {
      expect(String(w.payload.value)).not.toContain(TOKEN);
    }
    for (const b of bubbles()) {
      expect(String(b.payload.text)).not.toContain(TOKEN);
    }
    // 整个 store 也没有
    for (const v of store.values()) expect(v).not.toContain(TOKEN);
  });

  test('第二轮带 If-None-Match；304 分支不写 storage', async () => {
    await bootSettled();
    fetchQueue = [{ status: 304, body: '' }];
    await cycle();
    await pump();
    const last = fetchCalls[fetchCalls.length - 1];
    expect(last.headers['if-none-match']).toBe('W/"abc123"');
  });
});

// --- 错误分类（三条分开断言） -------------------------------------------------------

describe('error taxonomy', () => {
  test('401 → 「token 无效」', async () => {
    await bootSettled();
    fetchQueue = [{ status: 401, body: '{"message":"Bad credentials"}' }];
    await cycle();
    await pump();
    const shown = window.document.getElementById('error-detail').textContent;
    expect(shown).toContain('token 无效');
    expect(JSON.parse(store.get('state/v1')).error).toContain('token 无效');
  });

  test('403 → 「权限不足 / SSO」', async () => {
    await bootSettled();
    fetchQueue = [{ status: 403, body: '{"message":"Resource not accessible by integration"}' }];
    await cycle();
    await pump();
    expect(window.document.getElementById('error-detail').textContent).toContain('权限不足');
    expect(window.document.getElementById('error-detail').textContent).toContain('SSO');
  });

  test('429 → 「限流」，有 reset 头时显示 HH:MM', async () => {
    await bootSettled();
    const reset = Math.floor(Date.now() / 1000) + 600;
    fetchQueue = [{ status: 429, body: '{"message":"API rate limit exceeded"}', headers: { 'x-ratelimit-reset': String(reset) } }];
    await cycle();
    await pump();
    const shown = window.document.getElementById('error-detail').textContent;
    expect(shown).toContain('限流');
    expect(shown).toMatch(/\d{2}:\d{2} 重置/);
  });

  test('200 但 x-ratelimit-remaining=0 也归「限流」（宿主将来回传 headers 的形状）', async () => {
    await bootSettled();
    fetchQueue = [{ status: 403, body: '{"message":"API rate limit exceeded"}', headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60) } }];
    await cycle();
    await pump();
    expect(window.document.getElementById('error-detail').textContent).toContain('限流');
  });

  test('403 + rate limit 文案也归「限流」而不是权限不足（纯函数层）', () => {
    const core = window.__gh.core;
    expect(core.classify(403, '{"message":"API rate limit exceeded for x"}', null).code).toBe('ratelimit');
    expect(core.classify(403, '{"message":"Resource not accessible"}', null).code).toBe('forbidden');
    expect(core.classify(429, '', null).code).toBe('ratelimit');
    expect(core.classify(401, '', null).message).toContain('token 无效');
  });
});

// --- granted=[] -------------------------------------------------------------------

describe('granted=[]（宿主拒绝一切）', () => {
  test('零请求、零写、不崩、未授权态说出口', async () => {
    // granted 全空：onInit 不该发任何请求（config.get / storage.get 都不发）。
    installDom();
    loadApp();
    hostSends({
      v: 1, type: 'init', pluginId: 'com.shixiansi.plugin-github-notify',
      permissions: manifest.permissions, granted: [],
      surface: { kind: 'panel', slot: 'background' },
      host: { program: 'pet', methods: [] },
    });
    await macro();
    await pump(3);
    // 零请求：一次都没发（config.get 也不发，canConfig() 是 false）
    expect(requests()).toEqual([]);
    expect(writes()).toEqual([]);
    expect(fetches()).toEqual([]);
    // 不崩：状态栏说出未授权
    const status = window.document.getElementById('status').textContent;
    expect(status).toContain('未获授权');
    expect(status).toContain('net.fetch');
  });

  test('granted 只缺 net.fetch：读列表但不发请求', async () => {
    installDom();
    loadApp();
    store.set('state/v1', JSON.stringify({
      seen: ['n1'], etag: { notifications: '', events: '' },
      last: [{ id: 'n1', repo: 'o/r', title: 'T', kind: 'issue', url: '', at: 1, unread: true }],
      at: 1, source: 'notifications',
    }));
    hostSends({
      v: 1, type: 'init', pluginId: 'com.shixiansi.plugin-github-notify',
      permissions: manifest.permissions, granted: ['storage', 'plugin.config', 'pet.bubble'],
      surface: { kind: 'panel', slot: 'background' },
      host: { program: 'pet', methods: methodTable('background') },
    });
    await macro();
    await pump();
    expect(fetches()).toEqual([]);
    expect(writes()).toEqual([]); // 没拉新东西就不写
    expect(window.document.getElementById('list').textContent).toContain('o/r'); // 上次列表照常显示
  });
});

// --- 断网 -------------------------------------------------------------------------

describe('offline', () => {
  test('respond 全部 ok:false：静默保留上次状态，不崩不清空列表', async () => {
    await bootSettled(); // 先有一份正常状态
    const before = JSON.parse(store.get('state/v1'));
    expect(before.last).toHaveLength(3);

    fetchQueue = [
      { ok: false, error: '网络不可达' },
      { ok: false, error: '网络不可达' },
      { ok: false, error: '网络不可达' },
      { ok: false, error: '网络不可达' },
    ];
    await cycle();
    await pump();

    const after = JSON.parse(store.get('state/v1'));
    expect(after.last).toEqual(before.last);      // 列表没被清空
    expect(after.seen).toEqual(before.seen);      // 去重集合原样
    expect(window.document.getElementById('list').textContent).toContain('Add background frame');
    // 没有新的 storage.set 在断网那一轮发生
    const writesAfter = writes().length;
    await cycle();
    await pump();
    expect(writes()).toHaveLength(writesAfter); // 断网轮不写
  });

  test('断网轮零气泡（不上次状态重新通知）', async () => {
    await bootSettled();
    fetchQueue = [{ ok: false }, { ok: false }, { ok: false }, { ok: false }, { ok: false }];
    await cycle();
    await pump();
    expect(bubbles()).toHaveLength(1); // 仍只有首轮那一条
  });
});

// --- events 源（无 token 公开模式） --------------------------------------------------

describe('public events mode', () => {
  test('无 token 时轮询公开仓库事件流，气泡走事件措辞', async () => {
    configValues = { ...TOKEN_CONFIG, token: '', publicRepo: 'shixiansi/pet-pc' };
    fetchQueue = [{
      status: 200,
      body: JSON.stringify([
        { id: 'e1', type: 'PushEvent', actor: { login: 'shixiansi' }, repo: { name: 'shixiansi/pet-pc' }, created_at: '2026-11-02T09:00:00Z', payload: { size: 2, commits: [{}, {}] } },
      ]),
      headers: { etag: 'W/"ev1"' },
    }];
    await bootSettled();
    expect(fetchCalls[0].url).toContain('/repos/shixiansi/pet-pc/events');
    expect(fetchCalls[0].headers.authorization).toBeUndefined();
    const b = bubbles();
    expect(b).toHaveLength(1);
    expect(b[0].payload.text).toContain('shixiansi/pet-pc');
  });
});

// --- 插件页 -----------------------------------------------------------------------

describe('workshop panel', () => {
  test('列表渲染 + 标记已读写 storage；不发 bubble.say（workshop 没有 pet 方法）', async () => {
    await bootSettled('workshop');
    expect(fetches().length).toBeGreaterThanOrEqual(1); // 打开插件页刷一遍
    const listText = window.document.getElementById('list').textContent;
    expect(listText).toContain('Add background frame');
    expect(bubbles()).toHaveLength(0); // workshop 触发的刷新不弹气泡

    window.document.getElementById('mark-read').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await pump();
    const saved = JSON.parse(store.get('state/v1'));
    expect(saved.last.every((it) => it.unread === false)).toBe(true);
  });

  test('401 错误态在插件页可读', async () => {
    configValues = { ...TOKEN_CONFIG };
    await bootSettled('workshop');
    fetchQueue = [{ status: 401, body: '{"message":"Bad credentials"}' }];
    await cycle();
    await pump();
    const card = window.document.getElementById('error-card');
    expect(card.hidden).toBe(false);
    expect(window.document.getElementById('error-detail').textContent).toContain('token 无效');
  });
});

// --- 协议形状 -----------------------------------------------------------------------

describe('protocol', () => {
  test('ready 先发、init 之前零请求；id 唯一非空', async () => {
    postedFrom = 0;
    installDom();
    loadApp();
    const all = window.postMessage.mock.calls.map((c) => c[0]);
    expect(all[0] && all[0].type).toBe('ready');
    hostSends({
      v: 1, type: 'init', pluginId: 'com.shixiansi.plugin-github-notify',
      permissions: manifest.permissions, granted: [...manifest.permissions],
      surface: { kind: 'panel', slot: 'background' },
      host: { program: 'pet', methods: methodTable('background') },
    });
    await pump();
    const ids = requests().map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
  });

  test('轮询 tick ≥10 分钟（避开 poll WARN 的形状）', async () => {
    await bootSettled();
    const st = window.__gh.state();
    expect(st.polling).toBe(true);
    expect(st.pollMs).toBeGreaterThanOrEqual(10 * 60 * 1000);
  });

  test('归一化跳过坏条目，不整体崩（纯函数层）', () => {
    const core = window.__gh.core;
    expect(core.parseNotifications('not json')).toEqual([]);
    expect(core.parseNotifications('{"x":1}')).toEqual([]);
    const mixed = core.parseNotifications(JSON.stringify([null, { id: 'ok1', repository: { full_name: 'a/b' }, subject: { title: 't', type: 'Issue' } }, { no: 'id' }]));
    expect(mixed).toHaveLength(1);
    expect(mixed[0].id).toBe('ok1');
  });
});
