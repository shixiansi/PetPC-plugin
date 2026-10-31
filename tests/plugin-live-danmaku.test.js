import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Behaviour tests for the live-danmaku plugin.
//
// Five groups, each existing because the others cannot see its failure:
//
//   queue          the debounce/throttle container in isolation: caps, filters,
//                  dedupe, scoring, drain. A bug here is invisible from outside
//                  (the workshop shows aggregate counters, not per-item truth).
//   manifest+css   the pairing rules the host enforces and the CSS house rules.
//   the frame      handshake through the real panel.html markup in jsdom.
//   flood          1000 danmaku in one go: memory bounded, queue not stuck,
//                  throttle effective, and the interact loop answers at most
//                  maxRepliesPerMinute.
//   plumbing       ws.open with the derived URL, share command polling, TTS
//                  request shape.

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-live-danmaku');
const panelPath = path.join(pluginDir, 'panel.html');
const cssPath = path.join(pluginDir, 'style.css');
const manifestPath = path.join(pluginDir, 'manifest.json');

const html = readFileSync(panelPath, 'utf8');
const css = readFileSync(cssPath, 'utf8');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// The scripts to evaluate come from panel.html, not from a list kept here: the
// plugin is a set of classic scripts loaded in order, and a second copy of that
// order in the test harness would drift the first time someone adds a file.
const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');

const source = scriptSources
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-live-danmaku';
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
/** plugin.call 的回答：每个测试自己决定记忆核心说什么。 */
let memcoreAnswer = { text: '（模拟回应）' };
/** plugin.call 抛错（模拟"对方没在"或超时）。 */
let memcoreFails = false;
/** 记录每一次成功的 plugin.call。 */
const calls = [];
/** net.fetch（TTS）的应答与记录。 */
const fetches = [];
let ttsStatus = 200;
let ttsBody = 'd09HTg==';
let ttsFails = false;
/** ws.state 的应答。 */
let wsState = { state: 'open', received: 0, sent: 0 };

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
  fetches.length = 0;
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
window.__allReqLog = window.__allReqLog || [];
const __origAnswerPlumbing = null;

function requestsFor(method) {
  return requests().filter((r) => r.method === method);
}

function hostSends(data, { source = window } = {}) {
  window.dispatchEvent(new MessageEvent('message', { data, source }));
}

function answer(id, result, { ok = true, error = '' } = {}) {
  answered.add(id);
  hostSends({ v: 1, type: 'response', id, ok, result, error });
}

function hostEmits(name, payload) {
  hostSends({ v: 1, type: 'event', name, payload });
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

/** Boots the background frame far enough to have a socket and a running loop. */
async function bootBot({ values = {}, granted = ALL_GRANTED } = {}) {
  bootValues = values;
  await loadApp();
  hostSends(initFrame({ slot: 'background', granted }));
  await pump(24);
}

async function bootWorkshop() {
  bootValues = {};
  await loadApp();
  hostSends(initFrame({ slot: 'workshop' }));
  await pump(12);
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
      case 'share.get': {
        const name = String(payload.name || '');
        const owner = String(payload.owner || PLUGIN_ID);
        answer(req.id, { value: shareMap.has(`${owner}/${name}`) ? shareMap.get(`${owner}/${name}`) : '', at: Date.now(), key: `${owner}/${name}` });
        break;
      }
      case 'share.set':
        shareMap.set(`self/${String(payload.name || '')}`, String(payload.value || ''));
        shareMap.set(`${PLUGIN_ID}/${String(payload.name || '')}`, String(payload.value || ''));
        answer(req.id, { ok: true });
        break;
      case 'ws.state':
        answer(req.id, { ...wsState, url: payload.url || 'ws://mock' });
        break;
      case 'ws.open':
        answer(req.id, { ok: true, state: 'open', url: payload.url });
        break;
      case 'ws.send':
        answer(req.id, { ok: true });
        break;
      case 'ws.close':
        answer(req.id, { ok: true });
        break;
      case 'plugin.call': {
        calls.push(payload);
        if (memcoreFails) answer(req.id, null, { ok: false, error: '模拟拒绝：等 com.shixiansi.plugin-memcore/chat 的回答超时' });
        else answer(req.id, memcoreAnswer);
        break;
      }
      case 'net.fetch': {
        fetches.push(payload);
        if (ttsFails) answer(req.id, null, { ok: false, error: '模拟拒绝：语音服务连不上' });
        else answer(req.id, { status: ttsStatus, body: ttsBody });
        break;
      }
      case 'bubble.say':
        answer(req.id, { ok: true });
        break;
      case 'audio.save':
        answer(req.id, { name: payload.name, bytes: 16 });
        break;
      case 'audio.play':
        answer(req.id, { ok: true });
        break;
      default:
        answer(req.id, { ok: true });
        break;
    }
  }
}

beforeEach(() => {
  // 上一个文档的监听器先摘掉，再清数组：数组一旦清空，loadApp 就再也摘不掉它们，
  // 旧文档会活着收下一个测试的 init（症状：旧文档用旧 cfg 发 ws.open）。
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  installPanel();
  bootValues = {};
  storageMap.clear();
  shareMap.clear();
  intervals = [];
  answered.clear();
  memcoreAnswer = { text: '（模拟回应）' };
  memcoreFails = false;
  ttsStatus = 200;
  ttsBody = 'd09HTg==';
  ttsFails = false;
  wsState = { state: 'closed', received: 0, sent: 0 };
  window.postMessage = vi.fn();
  // 定时器属于上一个文档：不清理的话，前一个 boot 的心跳/命令轮询会一直跑进下一个
  // 测试（症状是"上一个测试的轮询把这一个的请求数撑爆"）。
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
  vi.useRealTimers();
  // 上一个文档的定时器在这里统一停掉（beforeEach 里也兜底一次）。
  for (const id of intervals) window.clearInterval(id);
  intervals = [];
});

// --- manifest & css ----------------------------------------------------------

describe('manifest', () => {
  test('declares the headless frame with a permission that fills one', () => {
    // background needs events / net.ws / net.fetch / plugin.call; this plugin's
    // reason to live while unseen is the socket.
    expect(manifest.background).toBe(true);
    expect(manifest.permissions).toContain('net.ws');
  });

  test('asks for every capability the code uses', () => {
    for (const needed of ['net.ws', 'net.fetch', 'llm.borrow', 'storage', 'plugin.config', 'plugin.share', 'plugin.call', 'audio', 'pet.bubble']) {
      expect(manifest.permissions, `manifest does not ask for ${needed}`).toContain(needed);
    }
  });

  test('calls only memcore, and memcore serves chat', () => {
    // callTargets is exact-match and self-calls are refused by the host; a typo
    // here is a call that dies with "问不到 <id>" for a reason no screen shows.
    expect(manifest.callTargets).toEqual([`${MEMCORE}/chat`]);
    expect(manifest.serves, 'danmaku is the asking side').toBeUndefined();
  });

  test('the mock bridge and the TTS service are on the allow-list', () => {
    expect(manifest.netHosts).toContain('127.0.0.1:23100');
    expect(manifest.netHosts).toContain('127.0.0.1:9880');
    const mock = manifest.config.find((item) => item.key === 'mockUrl');
    const voice = manifest.config.find((item) => item.key === 'voiceBaseUrl');
    expect(mock.hostWhitelist).toBe(true);
    expect(voice.hostWhitelist).toBe(true);
  });

  test('the FIRST secret is the model credential', () => {
    const secrets = manifest.config.filter((item) => item.secret === true);
    expect(secrets).toHaveLength(1);
    expect(secrets[0].key).toBe('llmApiKey');
  });

  test('interaction starts OFF by default', () => {
    // A plugin that starts talking on the user's stream after a silent update is
    // the danmaku version of "commenting on by default": the switch must be opt-in.
    const byKey = new Map(manifest.config.map((item) => [item.key, item]));
    expect(byKey.get('listenEnabled').default).toBe('false');
    expect(byKey.get('speakEnabled').default).toBe('false');
    expect(byKey.get('bubbleEnabled').default).toBe('true');
  });
});

describe('style.css', () => {
  test('ships no hardcoded colour', () => {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const hex = stripped.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    expect(hex, `style.css 写死了颜色：${hex.join(', ')}`).toEqual([]);
  });

  test('scrolling lives on the element that grows, with min-height 0', () => {
    // ui.css's own rule covers the page; the danmaku list is this page's growing
    // element and must carry overflow itself.
    expect(css).toMatch(/\.dm-list\s*\{[^}]*overflow:\s*auto/s);
    expect(css).toMatch(/\.dm-list\s*\{[^}]*min-height:\s*0/s);
  });
});

// --- the queue ---------------------------------------------------------------

describe('queue：防抖、过滤、去重、抽取', () => {
  let q;

  beforeEach(async () => {
    await loadApp();
    q = window.__danmaku.queue.create(100);
  });

  const rules = (over = {}) => ({
    minTextLen: 2, maxTextLen: 40, dedupeWindowSec: 120,
    keywords: '问题,点歌', blockedWords: '', ...over,
  });

  test('accepts a normal danmaku and counts stats', () => {
    const outcome = window.__danmaku.queue.push(q, { uid: 'u1', name: '小明', text: '这首歌叫什么' }, rules());
    expect(outcome).toBe('accepted');
    expect(q.items).toHaveLength(1);
    expect(q.stats.accepted).toBe(1);
  });

  test('caps the queue and drops the OLDEST when overflowing', () => {
    for (let i = 0; i < 150; i += 1) {
      window.__danmaku.queue.push(q, { uid: `u${i}`, name: `人${i}`, text: `第${i}条弹幕内容`, at: 1000 + i }, rules());
    }
    expect(q.items).toHaveLength(100);
    expect(q.items[0].text).toBe('第50条弹幕内容');
    expect(q.stats.dropped).toBe(50);
  });

  test('filters blocked words, too-short and too-long text', () => {
    expect(window.__danmaku.queue.push(q, { uid: 'u1', text: '加微信看福利' }, rules({ blockedWords: '微信' }))).toBe('filtered');
    expect(window.__danmaku.queue.push(q, { uid: 'u1', text: '好' }, rules({ minTextLen: 2 }))).toBe('filtered');
    expect(window.__danmaku.queue.push(q, { uid: 'u1', text: '字'.repeat(50) }, rules({ maxTextLen: 40 }))).toBe('filtered');
    expect(q.items).toHaveLength(0);
  });

  test('drops blank and symbol-only danmaku', () => {
    expect(window.__danmaku.queue.push(q, { uid: 'u1', text: '   ' }, rules())).toBe('dropped');
    expect(window.__danmaku.queue.push(q, { uid: 'u1', text: '？？?' }, rules())).toBe('dropped');
    expect(q.stats.dropped).toBe(2);
  });

  test('dedupes the same person saying the same thing inside the window', () => {
    const r = rules({ dedupeWindowSec: 60 });
    expect(window.__danmaku.queue.push(q, { uid: 'u1', text: '主播好强', at: 1000 }, r)).toBe('accepted');
    expect(window.__danmaku.queue.push(q, { uid: 'u1', text: '主播好强', at: 2000 }, r)).toBe('duplicate');
    expect(q.items).toHaveLength(1);
    expect(q.items[0].count).toBe(2);
    // 窗口按「同内容最近一次出现」算：每次命中都会把 seen.at 刷新到最新，
    // 所以刷屏弹幕的窗口会一路顺延——61s 与 62.1s 都仍在窗口内。
    expect(window.__danmaku.queue.push(q, { uid: 'u1', text: '主播好强', at: 61_000 }, r)).toBe('duplicate');
    expect(window.__danmaku.queue.push(q, { uid: 'u1', text: '主播好强', at: 62_100 }, r)).toBe('duplicate');
    // 182.1s：最后一次出现（62.1s）之后的 60s 窗口（含边界）终于过去，算新的。
    expect(window.__danmaku.queue.push(q, { uid: 'u1', text: '主播好强', at: 182_100 }, r)).toBe('accepted');
    expect(q.items).toHaveLength(2);
  });

  test('different people saying the same thing are NOT deduped', () => {
    const r = rules();
    window.__danmaku.queue.push(q, { uid: 'u1', text: '主播好强', at: 1000 }, r);
    expect(window.__danmaku.queue.push(q, { uid: 'u2', text: '主播好强', at: 1100 }, r)).toBe('accepted');
  });

  test('scores keyword hits and questions above plain chatter', () => {
    window.__danmaku.queue.push(q, { uid: 'u1', text: '这个问题怎么解决', at: 1000 }, rules());
    window.__danmaku.queue.push(q, { uid: 'u2', text: '哈哈哈', at: 1100 }, rules({ maxTextLen: 4, minTextLen: 3 }));
    const plain = window.__danmaku.queue.create(100);
    window.__danmaku.queue.push(plain, { uid: 'u3', text: '今天天气不错', at: 1200 }, rules());
    const scored = (qq) => qq.items[0].score;
    expect(scored(q)).toBeGreaterThan(scored(plain));
  });

  test('drain picks the best N and clears the queue (nothing stale survives)', () => {
    // 一条高分、一条低分：limit=1 时必须挑高分。
    window.__danmaku.queue.push(q, { uid: 'u1', text: '哈哈哈哈', at: 1000 }, rules({ maxTextLen: 4, minTextLen: 3 }));
    window.__danmaku.queue.push(q, { uid: 'u2', text: '求助，这个问题怎么办？', at: 1100 }, rules());
    const picked = window.__danmaku.queue.drain(q, 1, 1200);
    expect(picked).toHaveLength(1);
    expect(picked[0].text).toContain('问题');
    expect(q.items).toHaveLength(0);
    expect(q.stats.drains).toBe(1);
  });

  test('a flood of 1000 leaves the queue at cap and stats exact', () => {
    for (let i = 0; i < 1000; i += 1) {
      window.__danmaku.queue.push(q, { uid: `u${i % 7}`, name: `人${i}`, text: `第${i}条弹幕`, at: 1000 + i }, rules());
    }
    expect(q.items).toHaveLength(100);
    // 记账不变量：accepted = 留在队里的 + 因容量被挤掉的。1000 条内容各不相同，
    // 没有去重命中；入队节奏不受任何外力，内存上界就是 cap。
    expect(q.stats.accepted).toBe(1000);
    expect(q.stats.dropped).toBe(900);
    expect(q.stats.duplicates + q.stats.filtered).toBe(0);
    expect(q.items[0].text).toBe('第900条弹幕');
  });
});

// --- the frame ---------------------------------------------------------------

describe('the frame', () => {
  test('opens the socket on the mock URL derived from config, sends the hello', async () => {
    await bootBot({ values: { mockUrl: '127.0.0.1:23100', roomId: '123', platform: 'mock' } });
    const opens = requestsFor('ws.open');
    expect(opens).toHaveLength(1);
    expect(opens[0].payload.url).toBe('ws://127.0.0.1:23100');
    const sends = requestsFor('ws.send');
    const hello = JSON.parse(sends[0].payload.text);
    expect(hello).toEqual({ op: 1, data: { room: '123' } });
  });

  test('the workshop view renders and does NOT open a second socket', async () => {
    await bootWorkshop();
    expect(requestsFor('ws.open')).toHaveLength(0);
    expect(document.getElementById('workshop').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('chip-state').textContent).toContain('未连接');
  });

  test('the workshop start button publishes a command to share', async () => {
    await bootWorkshop();
    document.getElementById('start-stop').click();
    await pump(6);
    const sets = requestsFor('share.set').filter((r) => r.payload.name === 'live-command');
    expect(sets).toHaveLength(1);
    expect(JSON.parse(sets[0].payload.value).op).toBe('start');
  });

  test('granted=[] sends nothing that needs a permission', async () => {
    await loadApp();
    hostSends(initFrame({ slot: 'background', granted: [] }));
    await pump(12);
    const gated = requests().filter((r) => r.method !== 'ws.state');
    expect(gated).toEqual([]);
  });
});

// --- 高并发：1000 条弹幕 --------------------------------------------------------

describe('flood：瞬间 1000 条弹幕', () => {
  const frame = (i) => JSON.stringify({
    op: 5,
    data: { uid: `u${i % 50}`, name: `观众${i % 50}`, text: i % 20 === 0 ? `第${i}条弹幕，这个问题怎么解决？` : `普通弹幕${i}` },
  });

  test('memory is bounded, nothing crashes, stats add up', async () => {
    await bootBot({ values: { queueCap: '300', listenEnabled: 'false' } });
    for (let i = 0; i < 1000; i += 1) {
      hostEmits('ws.message', { text: frame(i) });
    }
    await pump(40);
    const snap = window.__danmaku.state();
    expect(snap.queue.size).toBeLessThanOrEqual(300);
    expect(snap.queue.stats.accepted).toBe(1000);
    // 队列没有卡死：抽取还能正常工作。
    const picked = window.__danmaku.interactTick === null ? [] : window.__danmaku.queue.drain(
      { items: snap.queue.items, cap: 300, stats: snap.queue.stats }, 5, Date.now(),
    );
    expect(picked.length).toBeGreaterThan(0);
  }, 20000);

  test('the interact loop answers at most maxRepliesPerMinute, in batch', async () => {
    vi.useFakeTimers();
    try {
      await loadApp();
      hostSends(initFrame({ slot: 'background' }));
      await pump(24);
      window.__danmaku.setCfg({ interactIntervalSec: '5', maxRepliesPerMinute: '6', maxBatch: '2' });
      window.__danmaku.startInteractLoop();
      // 瞬间塞 1000 条（每 20 条一条带关键词的）。
      for (let i = 0; i < 1000; i += 1) {
        hostEmits('ws.message', { text: frame(i) });
      }
      // 三个抽取拍（15 秒），每拍最多 2 条回应。
      for (let t = 0; t < 3; t += 1) {
        await vi.advanceTimersByTimeAsync(5000);
        await pump(30);
      }
      // 停止之后不再有新的调用。
      const before = calls.length;
      window.__danmaku.stopInteractLoop();
      await vi.advanceTimersByTimeAsync(20000);
      await pump(20);
      expect(calls.length).toBe(before);
      expect(calls.length).toBeLessThanOrEqual(6);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.target).toBe(MEMCORE);
        expect(call.method).toBe('chat');
        expect(call.payload.roleId).toBe('live-0');
        expect(call.payload.text.length).toBeLessThanOrEqual(4000);
      }
    } finally {
      vi.useRealTimers();
    }
  }, 20000);

  test('the throttle window blocks a burst beyond maxRepliesPerMinute', async () => {
    vi.useFakeTimers();
    try {
      await loadApp();
      hostSends(initFrame({ slot: 'background' }));
      await pump(24);
      window.__danmaku.setCfg({ maxRepliesPerMinute: '2', interactIntervalSec: '1' });
      window.__danmaku.startInteractLoop();
      // 源源不断的弹幕：每拍都能抽到内容，但一分钟只放行 2 次。
      let seq = 0;
      for (let t = 0; t < 20; t += 1) {
        for (let k = 0; k < 10; k += 1) {
          seq += 1;
          hostEmits('ws.message', { text: JSON.stringify({ op: 5, data: { uid: `u${seq}`, name: `人${seq}`, text: `求助问题${seq}，怎么解决？` } }) });
        }
        await vi.advanceTimersByTimeAsync(1000);
        await pump(20);
      }
      expect(calls.length).toBeLessThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  }, 20000);

  test('a poisoned frame (bad JSON, empty text) never breaks the feed', async () => {
    await bootBot({ values: {} });
    const good = () => hostEmits('ws.message', { text: JSON.stringify({ op: 5, data: { uid: 'u1', name: 'n', text: '正常弹幕内容' } }) });
    // 同一个人发同一句：第二条是 duplicate（计数 +1），不占新位置——这是队列的行为，
    // 不是坏帧。坏帧（非 JSON / 空文本 / 未知 op）各被丢弃，不改变队列。
    hostEmits('ws.message', { text: '这不是 JSON' });
    hostEmits('ws.message', { text: JSON.stringify({ op: 5, data: { text: '   ' } }) });
    hostEmits('ws.message', { text: JSON.stringify({ op: 9 }) });
    good();
    good();
    await pump(10);
    expect(window.__danmaku.state().queue.size).toBe(1);
    expect(window.__danmaku.state().queue.items[0].count).toBe(2);
  });
});

// --- plumbing -----------------------------------------------------------------

describe('plumbing', () => {
  test('an interaction goes: drain → plugin.call → bubble, and is recorded', async () => {
    await bootBot({ values: { listenEnabled: 'true', interactIntervalSec: '2', bubbleEnabled: 'true', roomId: '42' } });
    hostEmits('ws.message', { text: JSON.stringify({ op: 5, data: { uid: 'u1', name: '小明', text: '这个问题怎么解决？' } }) });
    // 循环的抽取拍挂在真定时器上（2 秒一拍）；测试直接驱动同一函数，不等墙钟。
    const tick = window.__danmaku.interactTick();
    await pump(30);
    await tick;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].payload.roleId).toBe('live-42');
    const bubbles = requestsFor('bubble.say');
    expect(bubbles.length).toBeGreaterThan(0);
    expect(bubbles[0].payload.text).toBe('（模拟回应）');
    // 回应落盘（工坊页要显示最近几条）。
    const log = JSON.parse(storageMap.get('state/replies') || '[]');
    expect(log.length).toBeGreaterThan(0);
    expect(log[0].answer).toBe('（模拟回应）');
  }, 20000);

  test('memcore being down leaves the loop alive and the error on the record', async () => {
    memcoreFails = true;
    await bootBot({ values: { listenEnabled: 'true', interactIntervalSec: '2' } });
    hostEmits('ws.message', { text: JSON.stringify({ op: 5, data: { uid: 'u1', name: 'n', text: '问个问题？' } }) });
    const tick = window.__danmaku.interactTick();
    await pump(30);
    await tick;
    const snap = window.__danmaku.state();
    expect(snap.lastError).toContain('记忆核心');
    // 循环还活着：下一拍照常执行。
    expect(snap.running).toBe(true);
  }, 20000);

  test('speak sends a GPT-SoVITS shaped TTS request, saves and plays the WAV', async () => {
    await bootBot({ values: { listenEnabled: 'true', interactIntervalSec: '2', speakEnabled: 'true', bubbleEnabled: 'false', voiceBaseUrl: '127.0.0.1:9880', voiceRefPath: 'ref.wav' } });
    hostEmits('ws.message', { text: JSON.stringify({ op: 5, data: { uid: 'u1', name: 'n', text: '这个问题怎么解决？' } }) });
    const tick = window.__danmaku.interactTick();
    await pump(40);
    await tick;
    const tts = fetches.find((f) => String(f.url).includes('/tts'));
    expect(tts, 'TTS request was never sent').toBeTruthy();
    expect(tts.url).toBe('http://127.0.0.1:9880/tts');
    expect(tts.encoding).toBe('base64');
    const body = JSON.parse(tts.body);
    expect(body.ref_audio_path).toBe('ref.wav');
    expect(body.text_lang).toBe('zh');
    const saves = requestsFor('audio.save');
    const plays = requestsFor('audio.play');
    expect(saves.length).toBeGreaterThan(0);
    expect(plays.length).toBe(saves.length);
  }, 20000);

  test('speak with incomplete voice config records the failure instead of throwing', async () => {
    await bootBot({ values: { listenEnabled: 'true', interactIntervalSec: '2', speakEnabled: 'true', bubbleEnabled: 'false', voiceBaseUrl: '', voiceRefPath: '' } });
    hostEmits('ws.message', { text: JSON.stringify({ op: 5, data: { uid: 'u1', name: 'n', text: '这个问题怎么解决？' } }) });
    const tick = window.__danmaku.interactTick();
    await pump(30);
    await tick;
    expect(window.__danmaku.state().lastError).toContain('语音');
    expect(fetches).toHaveLength(0);
  }, 20000);

  test('the command key is executed once per at-timestamp', async () => {
    await bootBot({ values: {} });
    // startInteractLoop 会排一个抽取定时器：测试结束时它得停下来，否则 worker 里的
    // 下一个测试会被这个僵尸心跳拖到超时。
    shareMap.set(`${PLUGIN_ID}/live-command`, JSON.stringify({ op: 'start', at: 1000 }));
    // pollCommand 内部要等宿主的 share.get 回包：直接 await 会挂在半路，先泵几拍。
    const poll = window.__danmaku.pollCommand();
    await pump(8);
    await poll;
    expect(window.__danmaku.interactState.running).toBe(true);
    // 同一个 at 再次到达：不重复执行（去重按 at）。
    const poll2 = window.__danmaku.pollCommand();
    await pump(8);
    await poll2;
    expect(window.__danmaku.interactState.counters.interactions).toBe(0);
    window.__danmaku.stopInteractLoop();
  });

  test('protocol parsers read both platforms', async () => {
    await loadApp();
    const parse = window.__danmaku.parseDanmakuFrame;
    // Mock 在默认 platform 下。
    expect(parse(JSON.stringify({ op: 3, data: { online: 77 } }))).toEqual({ kind: 'stats', online: 77 });
    expect(parse(JSON.stringify({ op: 5, data: { uid: 'u1', name: 'n', text: 'hi' } }))).toEqual({ kind: 'dm', dm: { uid: 'u1', name: 'n', text: 'hi' } });
    expect(parse('垃圾帧')).toBeNull();
    // B 站开放平台。
    window.__danmaku.liveConn.platform = 'bilibili-open';
    expect(parse(JSON.stringify({ type: 'LIVE_OPEN_PLATFORM_DM', data: { uid: 9, uname: '张三', msg: '你好呀' } }))).toEqual({ kind: 'dm', dm: { uid: '9', name: '张三', text: '你好呀' } });
    expect(parse(JSON.stringify({ type: 'LIVE_OPEN_PLATFORM_LIVE_ROOM_INFO', data: { online_count: 5 } }))).toEqual({ kind: 'stats', online: 5 });
    window.__danmaku.liveConn.platform = 'mock';
  });

  test('heartbeat sends op:2 and ws.state is polled every tick', async () => {
    // 连接开着（openDanmaku 成功）才有心跳可发：boot 必须带 mockUrl。
    await bootBot({ values: { mockUrl: '127.0.0.1:23100', roomId: '1' } });
    const before = requestsFor('ws.send').length;
    const tick = window.__danmaku.danmakuTick();
    await pump(8);
    await tick;
    const sends = requestsFor('ws.send');
    expect(sends.length).toBeGreaterThan(before);
    expect(JSON.parse(sends[sends.length - 1].payload.text)).toEqual({ op: 2 });
  });

  test('the memcore role key follows the room id and survives weird input', async () => {
    await loadApp();
    window.__danmaku.setCfg({ roomId: '123' });
    expect(window.__danmaku.memcoreRoleKey()).toBe('live-123');
    // 非 [A-Za-z0-9_-] 的输入被 keyOf 压空（存储段规则如此，与 memcore 的 keyOf 一致），
    // 压空之后落到 fallback '0' → live-0。键可预期比"看着像原房号"更重要。
    window.__danmaku.setCfg({ roomId: '房间/号!' });
    expect(window.__danmaku.memcoreRoleKey()).toBe('live-0');
    window.__danmaku.setCfg({ roomId: 'room_42-x' });
    expect(window.__danmaku.memcoreRoleKey()).toBe('live-room_42-x');
    window.__danmaku.setCfg({ roomId: '' });
    expect(window.__danmaku.memcoreRoleKey()).toBe('live-0');
  });

  test('the buildPrompt stays inside llm.chat limits and names the latest lines', async () => {
    await loadApp();
    const picked = Array.from({ length: 10 }, (_, i) => ({
      uid: `u${i}`, name: `观众${i}`, text: `这是第${i}条弹幕的内容`, at: 1000 + i, score: 10, count: 1,
    }));
    const prompt = window.__danmaku.buildPrompt(picked);
    expect(prompt).toContain('观众9');
    expect(Array.from(prompt).length).toBeLessThanOrEqual(4000);
  });
});
