import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Behaviour tests for the web-dashboard plugin.
//
// Four groups:
//   manifest+css   host pairing rules (callTargets all three plugins) + CSS house rules.
//   collect        stats aggregation through plugin.call: both plugins present, one
//                  missing, memcore passthrough from storage, and the persisted shape
//                  the bridge reads for /api/data.
//   the frame      handshake, workshop render with cards, granted=[] silence.
//   e2e-shape      THE /api/data JSON contract: run the aggregation the way the bridge
//                  does (read the plugin's persisted state file) and assert every
//                  section the SPA renders is present with the right shape.

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-web-dashboard');
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

const PLUGIN_ID = 'com.shixiansi.plugin-web-dashboard';
const TODO = 'com.shixiansi.plugin-todo';
const POMODORO = 'com.shixiansi.plugin-pomodoro';
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
const calls = [];
/** 每个 target 的应答表；缺失的 target = 插件不在。 */
let statsByTarget = new Map();
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
      case 'plugin.call': {
        calls.push(payload);
        const target = String(payload.target || '');
        if (target === MEMCORE && payload.method === 'chat') {
          if (!memcoreOnline) answer(req.id, null, { ok: false, error: '问不到 memcore' });
          else answer(req.id, { text: '（不应发生）' });
          break;
        }
        if (!statsByTarget.has(target)) {
          answer(req.id, null, { ok: false, error: `模拟拒绝：问不到 ${target}` });
          break;
        }
        answer(req.id, statsByTarget.get(target));
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

beforeEach(() => {
  installPanel();
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  bootValues = {};
  storageMap.clear();
  intervals = [];
  answered.clear();
  statsByTarget = new Map();
  memcoreOnline = true;
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

/** 两台插件都在场的默认应答表。 */
function withBothPlugins() {
  statsByTarget.set(TODO, {
    total: 8, done: 6, open: 2, dueToday: 1, completionRate: 75,
  });
  statsByTarget.set(POMODORO, {
    focusSessions: 3, focusMinutesToday: 75, focusSessionsTotal: 41,
    runningPhase: 'focus', runState: 'running',
  });
}

// --- manifest & css ----------------------------------------------------------

describe('manifest', () => {
  test('targets exactly the two stats plugins and memcore passthrough', () => {
    expect(manifest.callTargets).toEqual([
      `${MEMCORE}/chat`,
      `${TODO}/stats`,
      `${POMODORO}/stats`,
    ]);
    expect(manifest.background).toBe(true);
  });

  test('the bridge port and api base are configurable and whitelisted', () => {
    expect(manifest.netHosts).toEqual(expect.arrayContaining(['127.0.0.1:8080', '127.0.0.1:23260']));
    const api = manifest.config.find((item) => item.key === 'apiBase');
    expect(api.hostWhitelist).toBe(true);
  });
});

describe('style.css', () => {
  test('ships no hardcoded colour', () => {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const hex = stripped.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    expect(hex, `style.css 写死了颜色：${hex.join(', ')}`).toEqual([]);
  });

  test('the chart bars are pure CSS (no canvas, no external chart lib)', () => {
    expect(source).not.toMatch(/<canvas|\bChart\s*\(|from\s+['\"]chart\.js/i);
    expect(source).not.toMatch(/new\s+Canvas/i);
    expect(css).toMatch(/\.bar-fill\s*\{/);
    expect(css).toMatch(/\.bar-track\s*\{/);
  });
});

// --- collect -----------------------------------------------------------------

describe('collect：stats 聚合', () => {
  test('asks both plugins, stores the aggregated shape for the bridge', async () => {
    withBothPlugins();
    await loadApp();
    hostSends(initFrame({ slot: 'workshop' }));
    await pump(12);
    const data = await (async () => {
      const p = window.__dash.collectOnce();
      await pump(30);
      return p;
    })();
    expect(data.todo).toEqual({ total: 8, done: 6, open: 2, dueToday: 1, completionRate: 75 });
    expect(data.pomodoro.focusMinutesToday).toBe(75);
    expect(data.pomodoro.runningPhase).toBe('focus');
    // 落盘给桥读（/api/data 的来源）。
    const persisted = JSON.parse(storageMap.get('state/last-data') || 'null');
    expect(persisted.todo.total).toBe(8);
    expect(persisted.pomodoro.focusSessionsTotal).toBe(41);
    expect(persisted.chat).toBeNull();
    expect(persisted.at).toBeGreaterThan(0);
  }, 20000);

  test('a missing plugin shows null without sinking the rest', async () => {
    statsByTarget.set(TODO, { total: 1, done: 0, open: 1, dueToday: 0, completionRate: 0 });
    await loadApp();
    hostSends(initFrame({ slot: 'workshop' }));
    await pump(12);
    const data = await (async () => {
      const p = window.__dash.collectOnce();
      await pump(30);
      return p;
    })();
    expect(data.todo.total).toBe(1);
    expect(data.pomodoro).toBeNull();
    expect(window.__dash.state().lastError).toContain('pomodoro');
  }, 20000);

  test('memcore passthrough comes from the bridge-written storage key', async () => {
    withBothPlugins();
    await loadApp();
    hostSends(initFrame({ slot: 'workshop' }));
    await pump(12);
    storageMap.set('state/chat-stats', JSON.stringify({ turns: 42, lastDay: '2026-10-30' }));
    const data = await (async () => {
      const p = window.__dash.collectOnce();
      await pump(30);
      return p;
    })();
    expect(data.chat).toEqual({ turns: 42, lastDay: '2026-10-30' });
  }, 20000);
});

// --- the frame ---------------------------------------------------------------

describe('the frame', () => {
  test('workshop renders cards with real numbers and CSS bars', async () => {
    withBothPlugins();
    await loadApp();
    hostSends(initFrame({ slot: 'workshop' }));
    await pump(12);
    await (async () => {
      const p = window.__dash.refreshNow();
      await pump(40);
      return p;
    })();
    const rendered = window.__dash.renderCards();
    await pump(20);
    await rendered;
    expect(document.getElementById('workshop').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('card-todo').textContent).toContain('6/8');
    expect(document.getElementById('card-pomodoro').textContent).toContain('75 分钟');
    const fills = [...document.querySelectorAll('.bar-fill')];
    expect(fills.length).toBeGreaterThanOrEqual(3);
    // 柱宽是百分比、来自数据。
    expect(fills[0].style.width).toMatch(/%$/);
  }, 20000);

  test('an absent plugin renders the 未安装 card instead of an empty page', async () => {
    statsByTarget.set(TODO, { total: 1, done: 1, open: 0, dueToday: 0, completionRate: 100 });
    await loadApp();
    hostSends(initFrame({ slot: 'workshop' }));
    await pump(12);
    await (async () => {
      const p = window.__dash.refreshNow();
      await pump(30);
      return p;
    })();
    const rendered = window.__dash.renderCards();
    await pump(20);
    await rendered;
    expect(document.getElementById('card-pomodoro').textContent).toContain('未安装');
    expect(document.getElementById('card-todo').textContent).toContain('1/1');
  }, 20000);

  test('the reverse-control buttons write the pomodoro command key and bubble', async () => {
    await loadApp();
    hostSends(initFrame({ slot: 'workshop' }));
    await pump(12);
    document.getElementById('cmd-pause-todo').click();
    await pump(10);
    const sets = requestsFor('share.set').filter((r) => r.payload.name === 'pomodoro-command');
    expect(sets).toHaveLength(1);
    expect(JSON.parse(sets[0].payload.value).op).toBe('pause');
    document.getElementById('cmd-say-hi').click();
    await pump(10);
    expect(requestsFor('bubble.say')).toHaveLength(1);
  }, 20000);

  test('granted=[] sends nothing that needs a permission', async () => {
    await loadApp();
    hostSends(initFrame({ slot: 'workshop', granted: [] }));
    await pump(12);
    expect(requests()).toEqual([]);
  });
});

// --- /api/data 契约（桥的 E2E 形状） ---------------------------------------------

describe('e2e-shape：/api/data JSON 契约', () => {
  test('the bridge contract: read the persisted file the way /api/data does', async () => {
    // 模拟"三方都有"的一轮：todo/pomodoro 由 plugin.call 现答，chat 由桥写入的
    // chat-stats 透传。持久化之后，桥的 /api/data 就是把这个文件原样吐出去——
    // 所以这里断言的就是浏览器 SPA 依赖的完整 JSON 结构。
    withBothPlugins();
    await loadApp();
    hostSends(initFrame({ slot: 'workshop' }));
    await pump(12);
    storageMap.set('state/chat-stats', JSON.stringify({ turns: 12, lastDay: '2026-10-31' }));
    await (async () => {
      const p = window.__dash.collectOnce();
      await pump(30);
      return p;
    })();

    const persisted = JSON.parse(storageMap.get('state/last-data') || 'null');
    expect(persisted).not.toBeNull();
    // 顶层形状（SPA 渲染的全部依赖）。
    expect(Object.keys(persisted).sort()).toEqual(['at', 'chat', 'pomodoro', 'todo']);
    // todo 分区。
    expect(persisted.todo).toEqual({ total: 8, done: 6, open: 2, dueToday: 1, completionRate: 75 });
    // pomodoro 分区。
    expect(persisted.pomodoro).toMatchObject({
      focusSessions: 3,
      focusMinutesToday: 75,
      focusSessionsTotal: 41,
      runningPhase: 'focus',
      runState: 'running',
    });
    // chat 分区（桥写入 → 插件透传）。
    expect(persisted.chat).toEqual({ turns: 12, lastDay: '2026-10-31' });
  }, 20000);

  test('the degrade path: every section null is still a valid /api/data payload', async () => {
    await loadApp();
    hostSends(initFrame({ slot: 'workshop' }));
    await pump(12);
    await (async () => {
      const p = window.__dash.collectOnce();
      await pump(30);
      return p;
    })();
    const persisted = JSON.parse(storageMap.get('state/last-data') || 'null');
    expect(persisted.todo).toBeNull();
    expect(persisted.pomodoro).toBeNull();
    expect(persisted.chat).toBeNull();
    expect(typeof persisted.at).toBe('number');
  }, 20000);
});
