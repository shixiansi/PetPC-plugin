import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { METHODS, hostServes } from '../docs/plugin-testkit/fake-host.mjs';

// 健康提醒的行为测试。harness 与 imgbed / diary-writer 同型：驱动的是 panel.html 里真实加载
// 的那几支脚本，出站 postMessage 用 spy 记下来，假宿主逐条应答。
//
// 这个文件钉住的几件事（每一条都是这个插件最容易翻车的地方）：
//
//   1. 钟与判定：**到点只说一次**、下一拍不再说、下个间隔到点再说；
//   2. 免打扰跨午夜（22:00 → 08:00 这一段用纯函数直接喂 HH:MM）；
//   3. 跨日：过了本机 04:00 是"新的一天"，当天次数清零、重新起算；
//   4. 关掉开关**立刻**停（config.changed 那一拍就不再说话，徽标改成"已停"）；
//   5. 徽标 ≤16 字符；没授予 pet.surface 时一个 pet.badge 都不发；
//   6. events.subscribe 被拒（以及没有授予 events 时宿主不挂常驻帧）时的降级：
//      浮层面自己跑钟，界面上写一行说明；
//   7. 宿主拒绝一切时不崩、不写数据，界面上是宿主那句中文。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-health-reminder');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const PLUGIN_ID = 'com.shixiansi.plugin-health-reminder';

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');
const source = scriptSources
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

// 纯函数那一份单独拿出来喂时间：`new Function('window','module', src)` 与 media-sync 的
// nowplaying.js 是同一条路，浏览器里没有 module，那段导出不会执行。
const scheduleSrc = readFileSync(path.join(pluginDir, 'lib', 'schedule.js'), 'utf8');
const sandbox = { exports: {} };
new Function('window', 'module', scheduleSrc)({}, sandbox);
const S = sandbox.exports;

const KEYS = { state: 'state/v1', pause: 'pause/today' };
const STORE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}(\/[A-Za-z0-9_-]{1,64}){0,3}$/;

/** 设置项原文（config.get 回来的就是这种全字符串的形状）。 */
function cfgRaw(over = {}) {
  return {
    sitMinutes: '45',
    waterMinutes: '60',
    eyeMinutes: '20',
    quietStart: '22:00',
    quietEnd: '08:00',
    sitEnabled: 'true',
    waterEnabled: 'true',
    eyeEnabled: 'true',
    ...over,
  };
}

/** 本机时间戳（本地时区，和插件里 `new Date()` 的字段一致）。 */
function at(hour, minute, day = 4) {
  return new Date(2026, 10, day, hour, minute, 0, 0).getTime(); // 2026-11-04
}

const DAY4 = at(12, 0);
const DAY_ROLL = S.DAY_ROLL_HOUR;

describe('manifest', () => {
  test('只申请五件事：events 撑 background，pet.surface 撑浮层面与徽标', () => {
    expect([...manifest.permissions].sort()).toEqual(
      ['events', 'pet.bubble', 'pet.surface', 'plugin.config', 'storage'],
    );
    // 不申请的东西也要点名：网络与模型跟这个插件无关，process 是"全屏检测"最容易走错的那条路。
    for (const p of ['net.fetch', 'net.credentials', 'llm.chat', 'llm.borrow', 'process', 'audio', 'net.ws', 'plugin.share', 'plugin.call']) {
      expect(manifest.permissions, `不该申请 ${p}`).not.toContain(p);
    }
    expect(manifest.background).toBe(true);
  });

  test('只声明一块浮层面，尺寸就是卡片算出来的那个（280×112）', () => {
    expect(manifest.surface).toHaveLength(1);
    const rect = manifest.surface[0];
    expect(rect).toMatchObject({ dx: 160, dy: -120, w: 280, h: 112, radius: 14 });
    expect(rect.maxH).toBeUndefined(); // 内容不长高，就不要 maxH 那个空承诺
  });

  test('不 serves、不 callTargets、不引 ui.css（有 surface 的插件自带调色板）', () => {
    expect(manifest.serves).toBeUndefined();
    expect(manifest.callTargets).toBeUndefined();
    expect(manifest.netHosts).toBeUndefined();
    expect(manifest.sidecar).toBeUndefined();
    expect(manifest.assets).not.toContain('ui.css');
    expect(existsSync(path.join(pluginDir, 'ui.css'))).toBe(false);
  });

  test('八个设置项：三个间隔、免打扰起止、三个总开关', () => {
    const byKey = new Map(manifest.config.map((item) => [item.key, item]));
    expect([...byKey.keys()].sort()).toEqual(
      ['eyeEnabled', 'eyeMinutes', 'quietEnd', 'quietStart', 'sitEnabled', 'sitMinutes', 'waterEnabled', 'waterMinutes'],
    );
    expect(byKey.get('sitMinutes')).toMatchObject({ type: 'number', default: '45' });
    expect(byKey.get('waterMinutes')).toMatchObject({ type: 'number', default: '60' });
    expect(byKey.get('eyeMinutes')).toMatchObject({ type: 'number', default: '20' });
    expect(byKey.get('quietStart')).toMatchObject({ type: 'text', default: '22:00' });
    expect(byKey.get('quietEnd')).toMatchObject({ type: 'text', default: '08:00' });
    for (const key of ['sitEnabled', 'waterEnabled', 'eyeEnabled']) {
      expect(byKey.get(key), `${key} 必须是 bool 且默认 true`).toMatchObject({ type: 'bool', default: 'true' });
    }
    for (const item of manifest.config) expect(item.secret).toBeUndefined();
  });

  test('页面引用的每个本地文件都在包里，私有键是宿主认得的形状', () => {
    const fixed = ['panel.html', 'app.js', 'style.css'];
    for (const src of scriptSources) {
      if (fixed.includes(src)) continue;
      expect(manifest.assets, `${src} 必须写进 assets，否则装好的插件里没有它`).toContain(src);
    }
    for (const asset of manifest.assets) {
      expect(existsSync(path.join(pluginDir, asset)), `manifest.assets 里的 ${asset} 不存在`).toBe(true);
    }
    expect(existsSync(path.join(pluginDir, manifest.entry))).toBe(true);
    // 键不是文件名：带扩展名会被宿主整条拒绝（连请求都不执行）。
    for (const key of Object.values(KEYS)) expect(key).toMatch(STORE_KEY_PATTERN);
  });
});

// --- 纯函数：免打扰、切日、到点只说一次 ----------------------------------------

describe('lib/schedule.js 的判定（纯函数）', () => {
  test('免打扰跨午夜：半开区间 [22:00, 08:00)', () => {
    const start = 22 * 60;
    const end = 8 * 60;
    expect(S.isQuiet(23 * 60 + 30, start, end), '23:30 在段内').toBe(true);
    expect(S.isQuiet(7 * 60 + 59, start, end), '07:59 在段内').toBe(true);
    expect(S.isQuiet(8 * 60, start, end), '08:00 出了（端点算结束）').toBe(false);
    expect(S.isQuiet(21 * 60 + 59, start, end), '21:59 还没进').toBe(false);
    expect(S.isQuiet(12 * 60, start, end), '中午不在段内').toBe(false);
    expect(S.isQuiet(0, start, end), '午夜在段内').toBe(true);
  });

  test('不跨午夜的段也判对；起止相同 = 不设免打扰', () => {
    expect(S.isQuiet(12 * 60 + 30, 12 * 60, 13 * 60)).toBe(true);
    expect(S.isQuiet(13 * 60, 12 * 60, 13 * 60)).toBe(false);
    expect(S.isQuiet(11 * 60 + 59, 12 * 60, 13 * 60)).toBe(false);
    // 两边相同：24 小时静音会让用户以为插件坏了，所以按"没设"处理（界面上会写出来）。
    expect(S.isQuiet(9 * 60, 9 * 60, 9 * 60)).toBe(false);
  });

  test('HH:MM 的认法与兜底：半角/全角冒号都认，认不出来回兜底', () => {
    expect(S.hhmm('22:00', -1)).toBe(1320);
    expect(S.hhmm('8:00', -1)).toBe(480);
    expect(S.hhmm('08：00', -1), '全角冒号是中文输入法的常态').toBe(480);
    expect(S.hhmm('24:00', -1)).toBe(-1);
    expect(S.hhmm('22:60', -1)).toBe(-1);
    expect(S.hhmm('晚上八点', -1)).toBe(-1);
    expect(S.hhmm('', -1)).toBe(-1);
    expect(S.mmhh(1320)).toBe('22:00');
    expect(S.mmhh(480)).toBe('08:00');
  });

  test('跨日：过了本机 04:00 才是新的一天', () => {
    expect(S.dayKey(at(3, 59), DAY_ROLL)).toBe('2026-11-03');
    expect(S.dayKey(at(4, 0), DAY_ROLL)).toBe('2026-11-04');
    expect(S.dayKey(at(23, 59), DAY_ROLL)).toBe('2026-11-04');
    expect(S.dayKey(at(0, 30, 5), DAY_ROLL), '凌晨两点仍算前一天').toBe('2026-11-04');
  });

  test('到点只提醒一次：说过的这一刻就把计时推到 now', () => {
    const t0 = at(10, 0);
    const state = { day: S.dayKey(t0), last: { sit: t0 - 45 * 60000, water: t0, eye: t0 }, counts: {} };

    const first = S.step(state, cfgRaw(), t0, false);
    expect(first.fires.map((f) => f.key)).toEqual(['sit']);
    expect(first.fires[0].text).toContain('45');
    expect(first.state.counts.sit).toBe(1);
    expect(first.remaining.sit, '说完之后是新的一整段').toBe(45 * 60000);

    // 下一拍（30 秒后）：不再说。
    const second = S.step(first.state, cfgRaw(), t0 + 30000, false);
    expect(second.fires).toEqual([]);
    expect(second.state.counts.sit).toBe(1);

    // 下个间隔到点：再说一次，次数 +1。
    const third = S.step(second.state, cfgRaw(), t0 + 45 * 60000, false);
    expect(third.fires.map((f) => f.key)).toContain('sit');
    expect(third.state.counts.sit).toBe(2);
  });

  test('第一次判定（或刚打开某一项）以此刻为起点，不会一开机就连发三条', () => {
    const t0 = at(10, 0);
    const fresh = S.step({ day: S.dayKey(t0), last: {}, counts: {} }, cfgRaw(), t0, false);
    expect(fresh.fires).toEqual([]);
    expect(fresh.remaining.sit).toBe(45 * 60000);
    expect(fresh.remaining.water).toBe(60 * 60000);
    expect(fresh.remaining.eye).toBe(20 * 60000);

    // 关掉的那一条不留计时（last=0）：再打开时也是从那一刻起算。
    const off = S.step({ day: S.dayKey(t0), last: { sit: t0 - 90 * 60000 }, counts: {} }, cfgRaw({ sitEnabled: 'false' }), t0, false);
    expect(off.fires).toEqual([]);
    expect(off.state.last.sit, '关掉的一条不该留着"早该说了"').toBe(0);
    const back = S.step(off.state, cfgRaw(), t0, false);
    expect(back.fires, '刚打开不该立刻补一句').toEqual([]);
  });

  test('免打扰里到点：跳过并且重新起算（08:00 不会连发三条）', () => {
    const t0 = at(23, 30);
    const state = { day: S.dayKey(t0), last: { sit: t0 - 46 * 60000, water: t0 - 61 * 60000, eye: t0 - 21 * 60000 }, counts: {} };
    const quiet = S.step(state, cfgRaw(), t0, false);
    expect(quiet.quiet).toBe(true);
    expect(quiet.fires, '免打扰里一个字都不说').toEqual([]);
    expect(quiet.state.last.sit).toBe(t0);
    expect(quiet.badge).toBe('免打扰中');

    // 到 08:00（同一份 state 之后的 8.5 小时）也不该补发：静音里那一段已经过去了。
    const wake = S.step(quiet.state, cfgRaw(), at(8, 0, 5), false);
    expect(wake.quiet).toBe(false);
    expect(wake.fires).toEqual([]);
  });

  test('暂停（今天先别提醒我）同样跳过，且不影响次数的记账口径', () => {
    const t0 = at(15, 0);
    const state = { day: S.dayKey(t0), last: { sit: t0 - 46 * 60000, water: t0, eye: t0 }, counts: {} };
    const paused = S.step(state, cfgRaw(), t0, true);
    expect(paused.fires).toEqual([]);
    expect(paused.paused).toBe(true);
    expect(paused.badge).toBe('今天不提醒');
    expect(paused.state.last.sit).toBe(t0);
  });

  test('跨日重置：过了 04:00 是新的 day，次数清零、重新起算', () => {
    const yesterday = at(22, 0, 3);
    const today = at(9, 0, 4);
    const state = { day: S.dayKey(yesterday), last: { sit: yesterday, water: yesterday, eye: yesterday }, counts: { sit: 5, water: 3, eye: 9 } };
    const plan = S.step(state, cfgRaw(), today, false);
    expect(plan.day).toBe('2026-11-04');
    expect(plan.state.day).toBe('2026-11-04');
    expect(plan.state.counts, '当天的次数从零开始').toEqual({});
    expect(plan.fires, '新的一天从"现在"起算，不补发昨天的').toEqual([]);
    expect(plan.state.last.sit).toBe(today);

    // 第二天之内照常计数。
    const later = S.step(plan.state, cfgRaw(), today + 45 * 60000, false);
    expect(later.fires.map((f) => f.key)).toContain('sit');
    expect(later.state.counts.sit).toBe(1);
  });

  test('徽标：≤16 字符，且先说最要紧的那一句', () => {
    const t0 = at(15, 0);
    const state = { day: S.dayKey(t0), last: { sit: t0 - 10 * 60000, water: t0 - 10 * 60000, eye: t0 - 5 * 60000 }, counts: {} };
    const plan = S.step(state, cfgRaw(), t0, false);
    // 最近的是护眼那一条（还剩 15 分钟）。
    expect(plan.badge).toBe('护眼 15 分');
    for (const badge of [
      plan.badge,
      S.step(state, cfgRaw({ sitEnabled: 'false', waterEnabled: 'false', eyeEnabled: 'false' }), t0, false).badge,
      S.step(state, cfgRaw({ quietStart: '00:00', quietEnd: '23:59' }), t0, false).badge,
      S.step(state, cfgRaw(), t0, true).badge,
      S.step(state, cfgRaw({ sitMinutes: '600', waterEnabled: 'false', eyeEnabled: 'false' }), t0, false).badge,
    ]) {
      expect([...badge].length, `徽标「${badge}」超过 16 字符`).toBeLessThanOrEqual(16);
    }
    // 三条都关掉：不是"什么都不显示"，而是承认它停了。
    expect(S.step(state, cfgRaw({ sitEnabled: 'false', waterEnabled: 'false', eyeEnabled: 'false' }), t0, false).badge).toBe('已停');
  });

  test('坏数据降级成空状态：坏 JSON / 缺字段 / 手改过的值都不抛错', () => {
    expect(S.normalizeState('nope')).toEqual({ day: '', last: {}, counts: {} });
    expect(S.normalizeState('')).toEqual({ day: '', last: {}, counts: {} });
    expect(S.normalizeState(null)).toEqual({ day: '', last: {}, counts: {} });
    expect(S.normalizeState({ day: 7, last: { sit: 'x', water: -5 }, counts: { eye: 'a' } })).toEqual({
      day: '',
      last: {},
      counts: {},
    });
    expect(S.normalizeState(JSON.stringify({ day: '2026-11-04', last: { sit: 5 } })).last).toEqual({ sit: 5 });
  });

  test('sameState 只看值：last 的键序不同不算"变了"（否则每拍都会写一次存储）', () => {
    expect(S.sameState({ day: 'd', last: { sit: 1, water: 2 } }, { day: 'd', last: { water: 2, sit: 1 } })).toBe(true);
    expect(S.sameState({ day: 'd', last: { sit: 1 } }, { day: 'd', last: { sit: 2 } })).toBe(false);
    expect(S.sameState({ day: 'd', counts: {} }, { day: 'd2', counts: {} })).toBe(false);
  });
});

// --- harness -----------------------------------------------------------------

let store;
let configValues;
let answered;
let postedFrom;
let windowListeners;
let intervals;
/** 假宿主观测到的动作（已经答应过的请求不会重复答应）。 */
let bubbles;
let badges;
let subscribes;
let mode; // 'ok' | 'deny'

function posted() {
  return window.postMessage.mock.calls.map((call) => call[0]).slice(postedFrom);
}

function requests() {
  return posted()
    .filter((m) => m && m.type === 'request')
    .map((m) => ({ id: m.id, method: m.method, payload: m.payload }));
}

function methods() {
  return requests().map((r) => r.method);
}

function hostSends(data) {
  window.dispatchEvent(new MessageEvent('message', { data, source: window }));
}

function answer(id, result, { ok = true, error = '' } = {}) {
  answered.add(id);
  hostSends({ v: 1, type: 'response', id, ok, result, error });
}

function hostEvent(name, payload) {
  hostSends({ v: 1, type: 'event', name, payload });
}

/** 每拍把还没答的请求答掉，再让出一拍——一条答复常常引出下一个请求。 */
async function drain(rounds = 30) {
  for (let i = 0; i < rounds; i += 1) {
    for (const req of requests().filter((r) => !answered.has(r.id))) {
      const payload = req.payload || {};
      if (mode === 'deny') {
        answer(req.id, null, { ok: false, error: `模拟拒绝：未获权限 ${req.method}` });
        continue;
      }
      switch (req.method) {
        case 'config.get':
          answer(req.id, { values: configValues, secrets: {} });
          break;
        case 'storage.get':
          answer(req.id, { value: store.has(String(payload.key)) ? store.get(String(payload.key)) : '' });
          break;
        case 'storage.set':
          store.set(String(payload.key), String(payload.value === undefined ? '' : payload.value));
          answer(req.id, { ok: true });
          break;
        case 'storage.remove':
          store.delete(String(payload.key));
          answer(req.id, { ok: true });
          break;
        case 'events.subscribe':
          subscribes.push(payload);
          if (subscribes.deny) answer(req.id, null, { ok: false, error: '模拟拒绝：未获权限 events' });
          else answer(req.id, payload.names || []);
          break;
        case 'bubble.say':
          bubbles.push(String(payload.text || ''));
          answer(req.id, { ok: true });
          break;
        case 'pet.badge':
          badges.push(String(payload.text === undefined ? '' : payload.text));
          answer(req.id, { text: String(payload.text === undefined ? '' : payload.text) });
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
  for (const id of intervals) clearInterval(id);
  intervals = [];
  postedFrom = window.postMessage.mock.calls.length;
  // eslint-disable-next-line no-new-func
  new Function(source)();
}

/** 这个挂载的 init.surface。surface 与 background 的 kind/slot 形状不同，别用 kind 判窗口。 */
function surfaceFor(slot) {
  if (slot === 'workshop') return { kind: 'panel', slot: 'workshop' };
  if (slot === 'background') return { kind: 'panel', slot: 'background' };
  return {
    kind: 'surface',
    rectIndex: 0,
    rectCount: 1,
    rect: { x: 0, y: 0, w: 280, h: 112, r: 14, tailX: 140, hidden: false, room: 160 },
  };
}

/** init.host.methods 照 fake-host 的规则算：和真宿主的闸门是同一个答案，不背表。 */
function hostFor(surface) {
  return {
    program: surface.slot === 'workshop' ? 'workshop' : 'pet',
    methods: Object.keys(METHODS).filter((name) => hostServes(name, surface)).sort(),
  };
}

/** 种一份"刚刚起算"的状态：boot 那一拍不会说话，用例自己决定什么时候到点。 */
function seedFreshState(now) {
  store.set(
    KEYS.state,
    JSON.stringify({
      day: S.dayKey(now),
      last: { sit: now, water: now, eye: now },
      counts: {},
    }),
  );
}

async function boot({ slot = 'background', granted = [...manifest.permissions], ready = true } = {}) {
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
  loadApp();
  const surface = surfaceFor(slot);
  if (ready) {
    hostSends({
      v: 1,
      type: 'init',
      pluginId: PLUGIN_ID,
      permissions: [...manifest.permissions],
      granted: [...granted],
      surface,
      host: hostFor(surface),
    });
  }
  await drain();
}

/** 测试接缝：钟与判定都在看不见的那一面。 */
function health() {
  return window.__health;
}

function snapshot() {
  return health().snapshot();
}

/**
 * 走一拍钟，并让假宿主把这一拍要的请求都答完。
 *
 * 顺序很重要：**先**发起 tick 再答（tick 内部是"发一个请求 → 等答复 → 再发下一个"），
 * 先 await tick 再 drain 会互相等到超时——tick 在等一个还没人答的请求。
 */
async function tickAt(now) {
  const run = health().tick(now);
  for (let i = 0; i < 24; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await drain(1);
  }
  await run;
  await drain(2);
}

beforeEach(() => {
  // 钟钉在本机 15:00（2026-11-04）。不这么做，用例会在凌晨 03:19–04:05 之间跨过 04:00 那道
  // 日界而随机变红——而"跨日"恰好是被测的东西之一。`new Date(...)` 带参数的构造不受影响。
  vi.spyOn(Date, 'now').mockReturnValue(at(15, 0));
  store = new Map();
  configValues = cfgRaw();
  mode = 'ok';
  bubbles = [];
  badges = [];
  subscribes = [];
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

// --- 握手与主路径 --------------------------------------------------------------

describe('握手与主路径（background：界面上看不见的那一面）', () => {
  test('ready → init：授权到手、设置读到、常驻帧跑起钟', async () => {
    seedFreshState(Date.now());
    await boot();

    expect(posted()[0]).toMatchObject({ v: 1, type: 'ready' });
    expect(methods()).toContain('config.get');
    expect(methods()).toContain('events.subscribe');
    expect(subscribes[0].names).toEqual(['config.changed']);
    const snap = snapshot();
    expect(snap.view).toBe('background');
    expect(snap.granted.sort()).toEqual([...manifest.permissions].sort());
    expect(snap.subscribed).toBe(true);
    expect(snap.clock, '常驻帧必须起钟，否则界面关掉之后就没有提醒了').toBe(true);
    // 每一条 request 的 id 都唯一非空。
    const ids = requests().map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(typeof id === 'string' && id.length > 0).toBe(true);
  });

  test('到点只说一次：越过那一刻发一句 bubble.say，下一拍一个字都不发', async () => {
    const now = Date.now();
    // sit 上一句是 46 分钟前 → 已经到点；另两条刚起算（不会跟着一起响）。
    store.set(
      KEYS.state,
      JSON.stringify({ day: S.dayKey(now), last: { sit: now - 46 * 60000, water: now, eye: now }, counts: {} }),
    );
    await boot();

    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toContain('45 分钟');
    expect(bubbles[0]).toContain('起来');
    // 徽标跟着换（最近的是护眼那一条）。
    expect(badges[badges.length - 1]).toBe('护眼 20 分');

    // 状态落盘：说过的这一刻就是新的起点，次数 +1。
    const saved = JSON.parse(store.get(KEYS.state));
    expect(saved.counts.sit).toBe(1);
    expect(saved.last.sit).toBeGreaterThanOrEqual(now);

    // 下一拍：什么都不发（没有第二句，也没有重复的徽标）。
    const before = requests().length;
    await tickAt(Date.now() + 30 * 1000);
    expect(requests().slice(before), '下一拍不该有任何请求').toEqual([]);
    expect(bubbles).toHaveLength(1);

    // 下个间隔到点：再说一次。
    await tickAt(saved.last.sit + 45 * 60000 + 1000);
    expect(bubbles).toHaveLength(2);
    expect(JSON.parse(store.get(KEYS.state)).counts.sit).toBe(2);
  });

  test('同一拍里两条都到点：合成一句说（气泡只有一个）', async () => {
    const now = Date.now();
    store.set(
      KEYS.state,
      JSON.stringify({ day: S.dayKey(now), last: { sit: now - 50 * 60000, water: now - 61 * 60000, eye: now }, counts: {} }),
    );
    await boot();
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toContain('起来');
    expect(bubbles[0]).toContain('喝水');
    expect(bubbles[0]).toContain('；');
  });

  test('关掉开关立刻停：config.changed 那一拍就不再说话，徽标改成「已停」', async () => {
    const now = Date.now();
    store.set(
      KEYS.state,
      JSON.stringify({ day: S.dayKey(now), last: { sit: now - 46 * 60000, water: now, eye: now }, counts: {} }),
    );
    await boot();
    expect(bubbles).toHaveLength(1);

    // 用户在设置表单里把三条全关了——宿主推一条 config.changed 过来。
    configValues = cfgRaw({ sitEnabled: 'false', waterEnabled: 'false', eyeEnabled: 'false' });
    const before = requests().length;
    hostEvent('config.changed', { pluginId: PLUGIN_ID });
    await drain();

    const after = requests().slice(before);
    expect(after.filter((r) => r.method === 'bubble.say'), '关掉之后一句都不该再说').toEqual([]);
    expect(badges[badges.length - 1]).toBe('已停');
    expect(snapshot().state.counts.sit, '已经说过的次数留着（那是历史，不是待办）').toBe(1);

    // 再走一拍：状态与徽标都没变，于是**一个请求都不发**。
    const quietFrom = requests().length;
    await tickAt(Date.now() + 60 * 1000);
    expect(requests().slice(quietFrom)).toEqual([]);
    expect(bubbles).toHaveLength(1);
  });

  test('别的插件改了设置不该惊动我（payload.pluginId 是别人的）', async () => {
    seedFreshState(Date.now());
    await boot();
    const before = requests().length;
    hostEvent('config.changed', { pluginId: 'com.shixiansi.plugin-other' });
    await drain();
    expect(requests().slice(before)).toEqual([]);
  });

  test('免打扰跨午夜：23:30 到点不说，免打扰结束也不补发', async () => {
    seedFreshState(Date.now());
    await boot();

    const late = at(23, 30);
    store.set(KEYS.state, JSON.stringify({ day: S.dayKey(late), last: { sit: late - 46 * 60000, water: late, eye: late }, counts: {} }));
    hostEvent('storage.changed', { key: KEYS.state });
    await drain();

    await tickAt(late);
    expect(bubbles, '免打扰里一个字都不说').toEqual([]);
    expect(badges[badges.length - 1]).toBe('免打扰中');
    // 跳过也是重新起算：08:00 一出门不会连发三条。
    const rebased = JSON.parse(store.get(KEYS.state));
    expect(rebased.last.sit).toBe(late);

    await tickAt(at(8, 0, 5));
    expect(bubbles, '08:00 不该补发').toEqual([]);
  });

  test('08:00 那一刻已经出段：该说的话照说', async () => {
    seedFreshState(Date.now());
    await boot();
    const t = at(8, 0);
    store.set(KEYS.state, JSON.stringify({ day: S.dayKey(t), last: { sit: t - 46 * 60000, water: t, eye: t }, counts: {} }));
    hostEvent('storage.changed', { key: KEYS.state });
    await drain();

    await tickAt(t);
    expect(bubbles).toHaveLength(1);
  });

  test('跨日重置：过了本机 04:00，当天次数清零并重新起算', async () => {
    seedFreshState(Date.now());
    await boot();

    const today = at(9, 0);
    const yesterday = at(22, 0, 3);
    store.set(
      KEYS.state,
      JSON.stringify({ day: S.dayKey(yesterday), last: { sit: yesterday, water: yesterday, eye: yesterday }, counts: { sit: 5, water: 3, eye: 9 } }),
    );
    hostEvent('storage.changed', { key: KEYS.state });
    await drain();

    await tickAt(today);
    expect(bubbles, '新的一天从"现在"起算，不补发昨天的').toEqual([]);
    const saved = JSON.parse(store.get(KEYS.state));
    expect(saved.day).toBe('2026-11-04');
    expect(saved.counts).toEqual({});
    expect(saved.last.sit).toBeGreaterThanOrEqual(today);

    // 当天之内照常提醒、照常计数。
    await tickAt(today + 45 * 60000 + 1000);
    expect(bubbles).toHaveLength(1);
    expect(JSON.parse(store.get(KEYS.state)).counts.sit).toBe(1);
  });
});

// --- 徽标 ---------------------------------------------------------------------

describe('宠物头顶的徽标', () => {
  test('文字一律 ≤16 字符（间隔拉到 600 分钟也一样）', async () => {
    seedFreshState(Date.now());
    await boot();
    configValues = cfgRaw({ sitMinutes: '600', waterEnabled: 'false', eyeEnabled: 'false' });
    hostEvent('config.changed', { pluginId: PLUGIN_ID });
    await drain();
    expect(badges.length).toBeGreaterThan(0);
    for (const badge of badges) expect([...badge].length).toBeLessThanOrEqual(16);
    expect(badges[badges.length - 1]).toBe('久坐 600 分');
  });

  test('没授予 pet.surface：一个 pet.badge 都不发（提醒本身照旧）', async () => {
    const now = Date.now();
    store.set(
      KEYS.state,
      JSON.stringify({ day: S.dayKey(now), last: { sit: now - 46 * 60000, water: now, eye: now }, counts: {} }),
    );
    await boot({ granted: ['events', 'pet.bubble', 'plugin.config', 'storage'] });

    expect(methods()).not.toContain('pet.badge');
    expect(badges).toEqual([]);
    // 提醒不该跟着一起消失：气泡只需要 pet.bubble。
    expect(bubbles).toHaveLength(1);

    // 再走两拍（到点的那一刻包含在内）也一个都不发。
    await tickAt(Date.now() + 45 * 60000 + 1000);
    expect(methods()).not.toContain('pet.badge');
  });
});

// --- 降级 ---------------------------------------------------------------------

describe('降级：没有 events / 订阅被拒 / 宿主拒绝一切', () => {
  test('没授予 events：宿主的判据是不挂常驻帧，于是浮层面自己跑钟', async () => {
    const now = Date.now();
    store.set(
      KEYS.state,
      JSON.stringify({ day: S.dayKey(now), last: { sit: now - 46 * 60000, water: now, eye: now }, counts: {} }),
    );
    await boot({ slot: 'surface', granted: ['pet.bubble', 'pet.surface', 'plugin.config', 'storage'] });

    const snap = snapshot();
    expect(snap.view).toBe('surface');
    expect(health().isTicker(), '没有常驻帧时，这块卡片就是唯一的钟').toBe(true);
    expect(snap.subscribed).toBe(false);
    expect(methods(), '没授予 events 就不该去订阅').not.toContain('events.subscribe');
    expect(bubbles, '界面开着的时候照样提醒').toHaveLength(1);
    expect(document.getElementById('sf-pause').disabled).toBe(false);
  });

  test('events.subscribe 被拒：不崩，提醒照跑，设置改成每拍重读', async () => {
    const now = Date.now();
    store.set(
      KEYS.state,
      JSON.stringify({ day: S.dayKey(now), last: { sit: now - 46 * 60000, water: now, eye: now }, counts: {} }),
    );
    subscribes.deny = true;
    await boot();

    expect(subscribes[0].names).toEqual(['config.changed']);
    expect(snapshot().subscribed).toBe(false);
    // 订阅失败不该拦住提醒：它靠的是钟表，不是事件。
    expect(bubbles).toHaveLength(1);
    // 宿主那句中文（"模拟拒绝：未获权限 events.subscribe"）原样出现在页面上，没有崩。
    expect(document.getElementById('status').textContent).toContain('events.subscribe');

    // 降级的代价说清楚：没有订阅就自己重读设置（否则改了设置永远不会生效）。
    const before = requests().length;
    await tickAt(Date.now() + 60 * 1000);
    expect(requests().slice(before).map((r) => r.method)).toContain('config.get');
  });

  test('控制中心那一面说明：这一页改设置是立刻生效的（宿主直达 config.changed）', async () => {
    await boot({ slot: 'workshop' });
    const note = document.getElementById('ws-note-sub').textContent;
    expect(note).toContain('立刻');
    expect(note).toContain('config.changed');
    // 这一页不该出现"订阅被拒"这种它自己根本没做过的事。
    expect(note).not.toContain('被拒绝');
  });

  test('没有授予 events 时，控制中心那一面说明"提醒只在界面开着时生效"', async () => {
    await boot({ slot: 'workshop', granted: ['pet.bubble', 'pet.surface', 'plugin.config', 'storage'] });
    const note = document.getElementById('ws-note-sub').textContent;
    expect(note).toContain('没有授予 events');
    expect(note).toContain('常驻帧');
    expect(document.getElementById('ws-state').textContent).toBe('运行中');
  });

  test('宿主拒绝一切：不崩、不写数据，界面上是宿主那句中文', async () => {
    mode = 'deny';
    const now = Date.now();
    await boot();

    // 一次 storage.set 都没成功：拒绝之后什么都不该落地。
    expect(store.size, '拒绝一切时不该有数据被写下去').toBe(0);
    expect(document.getElementById('status').textContent).toContain('未获权限');
    // 帧还活着：钟与快照都还在（下一拍还能继续）。
    const snap = snapshot();
    expect(snap.view).toBe('background');
    expect(snap.clock).toBe(true);
    await tickAt(now + 60 * 1000);
    expect(store.size).toBe(0);
  });
});

// --- 控制中心那一面 ------------------------------------------------------------

describe('workshop（控制中心的插件页）', () => {
  test('只读：一个桌宠专属的方法都不发，并写出"这件事在桌宠上"', async () => {
    await boot({ slot: 'workshop' });
    const sent = methods();
    for (const forbidden of ['bubble.say', 'pet.badge', 'events.subscribe', 'surface.show', 'surface.blocks', 'surface.hide']) {
      expect(sent, `控制中心不服务 ${forbidden}，发出去就是一行 WARN`).not.toContain(forbidden);
    }
    expect(sent).toContain('config.get');
    const page = document.getElementById('workshop').textContent;
    expect(page).toContain('桌宠');
    expect(page).toContain('这个窗口没有宠物');
  });

  test('三行都画出来：每一条的间隔、还剩多久、今天的次数', async () => {
    const now = Date.now();
    store.set(
      KEYS.state,
      JSON.stringify({ day: S.dayKey(now), last: { sit: now - 30 * 60000, water: now - 10 * 60000, eye: now - 5 * 60000 }, counts: { sit: 2 } }),
    );
    await boot({ slot: 'workshop' });

    expect(document.getElementById('ws-row-sit').textContent).toContain('每 45 分钟');
    expect(document.getElementById('ws-row-sit').textContent).toContain('还有 15 分');
    expect(document.getElementById('ws-row-sit').textContent).toContain('今天已提醒 2 次');
    expect(document.getElementById('ws-row-water').textContent).toContain('每 60 分钟');
    expect(document.getElementById('ws-row-eye').textContent).toContain('每 20 分钟');
    expect(document.getElementById('ws-counts').textContent).toContain('久坐 2 次');
    expect(document.getElementById('ws-quiet').textContent).toContain('22:00 – 08:00');
  });

  test('关掉的那一条写"已关掉"，全部关掉时状态写"三条都关掉了"', async () => {
    configValues = cfgRaw({ sitEnabled: 'false', waterEnabled: 'false', eyeEnabled: 'false' });
    await boot({ slot: 'workshop' });
    expect(document.getElementById('ws-row-sit').textContent).toContain('已关掉');
    expect(document.getElementById('ws-state').textContent).toBe('三条都关掉了');
  });

  test('诚实说明：全屏检测这件事现在是做不到的，不假装做到了', async () => {
    await boot({ slot: 'workshop' });
    const page = document.getElementById('workshop').textContent;
    expect(page).toContain('全屏');
    expect(page).toContain('宿主今天没有全屏检测这个能力');
    // 免打扰是现在唯一的兜底，得说清是哪一段。
    expect(document.getElementById('ws-quiet').textContent).toContain('免打扰');
  });
});

// --- 「今天先别提醒我」 --------------------------------------------------------

describe('今天先别提醒我', () => {
  test('写的是日期本身，所以明天自动作废；点了之后这一拍就不再说话', async () => {
    const now = Date.now();
    store.set(
      KEYS.state,
      JSON.stringify({ day: S.dayKey(now), last: { sit: now, water: now, eye: now }, counts: {} }),
    );
    await boot({ slot: 'surface', granted: ['pet.bubble', 'pet.surface', 'plugin.config', 'storage'] });

    document.getElementById('sf-pause').click();
    await drain();

    expect(store.get(KEYS.pause)).toBe(S.dayKey(now));
    const pausedAt = now + 46 * 60000;
    await tickAt(pausedAt);
    expect(bubbles, '暂停之后到点也不说').toEqual([]);
    expect(badges[badges.length - 1]).toBe('今天不提醒');
    expect(document.getElementById('sf-pause').textContent).toBe('今天先不提醒');

    // 第二天（过了 04:00）自己恢复：那个键还在，但它写的日期已经不是"今天"了。
    const tomorrow = at(9, 0, 5);
    await tickAt(tomorrow);
    expect(store.get(KEYS.pause)).toBe(S.dayKey(now));
    expect(snapshot().pauseDay).toBe(S.dayKey(now));
    expect(bubbles, '新的一天从"现在"起算，不补发').toEqual([]);

    await tickAt(tomorrow + 45 * 60000 + 1000);
    expect(bubbles, '第二天照常提醒').toHaveLength(1);
  });
});
