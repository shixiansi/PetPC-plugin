import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 习惯打卡插件的行为测试：驱动的是 panel.html 里真实加载的那几支脚本。
//
// harness 与 imgbed / websearch / memcore 那几份同型：vitest 的 jsdom 全局 window 当作插件的
// window，拼起来的源码用 new Function 丢进一个新函数作用域（等于浏览器里那几支经典 script 共享
// 一个作用域），出站 postMessage 用 spy 记下来。区别是**这一次 new Function 会把内部函数也交出来**
// （`return {...}` 那一行），因为换日、结算、提醒这些东西必须直接喂时间测——用真时钟测不了
// 「12/31 → 1/1 算连续」。
//
// 这个文件钉住的几件事：
//
//   1. manifest 的形状：五项权限、background 由 events/plugin.call 撑着、serves 只有 streak/today、
//      三项 config（提醒时刻 / 徽标显示 / 提醒开关），没有 secret、没有 hostWhitelist；
//   2. 换日按本机 04:00：03:59 仍属于前一天，04:00 属于新的一天；
//   3. 连续天数：跨月（1/31 → 2/1）与跨年（12/31 → 1/1）都算连续，靠 Date 运算而不是日期串相减；
//   4. 断签只重置一次：同一份状态重复结算不会把 streak 反复清零，同一格重复打卡也不会记两次；
//   5. 提醒按"今天这天提醒过没有"去重（lastRemindDay 落盘），重挂帧不会重复提醒；
//   6. serves.streak / serves.today 的形状，未知方法回一句说得清的中文；
//   7. 未授予 pet.surface 时**一个 pet.badge 请求都不发**，界面明写缺的是哪一项；
//   8. 宿主拒绝一切时不崩、不写数据，界面进入可理解的降级态。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-habits');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');
const source = scriptSources.map((src) => readFileSync(path.join(pluginDir, src), 'utf8')).join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-habits';
const STATE_KEY = 'habits/v1';

/** 把插件内部的东西交出来：纯函数要直接喂时间，常驻帧的定时器要能手动拍一拍。 */
const EXPORTS = [
  'dayKey', 'addDays', 'nextDay', 'dayGap', 'settle', 'normalizeState', 'serializeState',
  'emptyState', 'streakInfo', 'todayInfo', 'toggleDone', 'setDone', 'addHabit', 'removeHabit',
  'badgeText', 'reminderDue', 'parseClock', 'isDayComplete', 'pendingCount', 'BADGE_MAX',
  'bgTick', 'checkReminder', 'pushBadge', 'serveAnswer', 'renderAll',
];

// --- 一个可注入的"现在" -------------------------------------------------------

/** 本机时间（Date 的月份从 0 开始，写测试时太容易错，所以这里收 1 起）。 */
function at(year, month, day, hour = 9, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

function stateWith(overrides = {}) {
  return Object.assign(
    { version: 1, habits: [], streak: 0, best: 0, closedThrough: '', done: {}, lastRemindDay: '' },
    overrides,
  );
}

describe('manifest', () => {
  test('只申请用得到的五项，常驻帧由 events / plugin.call 撑着，serves 就那两个', () => {
    expect([...manifest.permissions].sort()).toEqual(
      ['events', 'pet.surface', 'plugin.call', 'plugin.config', 'storage'],
    );
    // 零网络：没有任何 netHosts / hostWhitelist / secret。
    expect(manifest.netHosts).toBeUndefined();
    expect(manifest.permissions).not.toContain('net.fetch');
    expect(manifest.background).toBe(true);
    // serves 里点名的必须是自己真的答得了的方法（plugin.call 也要有）。
    expect(manifest.serves).toEqual(['streak', 'today']);
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.author).toBe('shixiansi');
    expect(Array.from(manifest.description).length).toBeLessThanOrEqual(512);
    expect(manifest.description).toMatch(/习惯/);
  });

  test('三项设置：提醒时刻 / 徽标显示 / 提醒开关，没有 secret 也没有 hostWhitelist', () => {
    const byKey = Object.fromEntries(manifest.config.map((item) => [item.key, item]));
    expect(Object.keys(byKey).sort()).toEqual(['badgeMode', 'remindAt', 'remindEnabled']);

    expect(byKey.remindAt.type).toBe('text');
    expect(byKey.remindAt.default).toBe('20:00');

    expect(byKey.badgeMode.type).toBe('select');
    expect(byKey.badgeMode.default).toBe('streak');
    expect(byKey.badgeMode.options.map((o) => o.value)).toEqual(['streak', 'pending']);

    expect(byKey.remindEnabled.type).toBe('bool');
    expect(byKey.remindEnabled.default).toBe('true');

    for (const item of manifest.config) {
      expect(item.secret).toBeUndefined();
      expect(item.hostWhitelist).toBeUndefined();
    }
  });

  test('一块浮层面（280×140），页面引用的每个文件都进了包', () => {
    expect(manifest.surface).toHaveLength(1);
    expect(manifest.surface[0]).toMatchObject({ w: 280, h: 140, radius: 14 });
    // 卡片是声明死的矩形：内容长高不会被发现，所以宽度高度都写在用例里当断言。
    const fixed = ['panel.html', 'app.js', 'style.css'];
    for (const src of scriptSources) {
      // 打包器总是带那三个固定资源；其余被页面引用的（lib/*.js）必须写进 assets。
      if (fixed.includes(src)) continue;
      expect(manifest.assets).toContain(src);
    }
    for (const asset of manifest.assets) {
      expect(existsSync(path.join(pluginDir, asset)), `manifest.assets 里的 ${asset} 不存在`).toBe(true);
    }
    expect(existsSync(path.join(pluginDir, manifest.entry))).toBe(true);
    expect(existsSync(path.join(pluginDir, 'style.css'))).toBe(true);
  });
});

// --- harness -----------------------------------------------------------------

let store;
let configValues;
let denyAll;
let answered;
let postedFrom;
let windowListeners;
let timers;
let scope;

function posted() {
  return window.postMessage.mock.calls.map((call) => call[0]).slice(postedFrom);
}

function byType(type) {
  return posted().filter((m) => m && m.type === type);
}

function requests() {
  return byType('request').map((m) => ({ id: m.id, method: m.method, payload: m.payload }));
}

function requestsOf(method) {
  return requests().filter((r) => r.method === method);
}

function hostSends(data) {
  window.dispatchEvent(new MessageEvent('message', { data, source: window }));
}

function answer(id, result, { ok = true, error = '' } = {}) {
  answered.add(id);
  hostSends({ v: 1, type: 'response', id, ok, result, error });
}

/** 逐拍把还没答的请求答掉，再让出一拍——每个答复都可能引出下一个请求。 */
async function drain(rounds = 24) {
  for (let i = 0; i < rounds; i += 1) {
    for (const req of requests().filter((r) => !answered.has(r.id))) {
      if (denyAll) {
        answer(req.id, null, { ok: false, error: `模拟拒绝：未获权限 ${req.method}` });
        continue;
      }
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
          answer(req.id, { ok: true });
          break;
        case 'events.subscribe':
          answer(req.id, payload.names || []);
          break;
        case 'pet.badge':
          answer(req.id, { text: String(payload.text || '') });
          break;
        case 'surface.show':
        case 'surface.hide':
          answer(req.id, { ok: true });
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
  for (const id of timers) clearInterval(id);
  timers = [];
  postedFrom = window.postMessage.mock.calls.length;
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
  // eslint-disable-next-line no-new-func
  return new Function(`${source}\n;return {${EXPORTS.join(', ')}};`)();
}

/** 装一份帧：`slot` 决定它是控制中心的页、宠物旁的卡片，还是常驻帧。 */
async function boot({ slot = 'workshop', granted = manifest.permissions } = {}) {
  const surface =
    slot === 'surface'
      ? { kind: 'surface', rectIndex: 0, rectCount: 1, rect: { x: 0, y: 0, w: 280, h: 140, r: 14, tailX: 0, hidden: false, room: 160 } }
      : slot === 'background'
        ? { kind: 'panel', slot: 'background' }
        : { kind: 'panel', slot: 'workshop' };
  // host.methods 就是这个窗口真正服务的方法表：workshop 没有宠物，也就没有 pet.badge。
  const methods =
    slot === 'workshop'
      ? ['config.get', 'storage.get', 'storage.set']
      : ['config.get', 'events.subscribe', 'pet.badge', 'storage.get', 'storage.set', 'surface.hide', 'surface.show'];
  scope = loadApp();
  hostSends({
    v: 1,
    type: 'init',
    pluginId: PLUGIN_ID,
    permissions: manifest.permissions,
    granted: [...granted],
    surface,
    host: { program: slot === 'workshop' ? 'workshop' : 'pet', methods },
  });
  await drain(8);
  return scope;
}

function click(selector) {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`找不到 ${selector}`);
  node.click();
}

/**
 * 拍一拍常驻帧。
 *
 * 它的每一拍都会发请求，所以"等它跑完"与"把请求答掉"必须同时进行——先 await 再 drain 是
 * 死锁（插件在等一个永远不会来的 response）。
 */
async function tick(bg, rounds = 10) {
  const running = bg.bgTick();
  await drain(rounds);
  await running;
}

function stored() {
  const raw = store.get(STATE_KEY);
  return raw ? JSON.parse(raw) : null;
}

beforeEach(() => {
  store = new Map();
  configValues = { remindAt: '20:00', badgeMode: 'streak', remindEnabled: 'true' };
  denyAll = false;
  windowListeners = [];
  timers = [];
  scope = null;
  const originalAdd = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(function (type, fn, opts) {
    windowListeners.push([type, fn, opts]);
    return originalAdd(type, fn, opts);
  });
  const originalTimeout = window.setTimeout.bind(window);
  const originalInterval = window.setInterval.bind(window);
  // 只记账、不拦：vitest 自己的超时也走 setTimeout，整套换掉会让挂住的用例永远不超时。
  vi.spyOn(window, 'setTimeout').mockImplementation((fn, ms, ...rest) => {
    const id = originalTimeout(fn, ms, ...rest);
    timers.push(id);
    return id;
  });
  vi.spyOn(window, 'setInterval').mockImplementation((fn, ms, ...rest) => {
    const id = originalInterval(fn, ms, ...rest);
    timers.push(id);
    return id;
  });
  vi.spyOn(window, 'postMessage').mockImplementation(() => {});
});

afterEach(() => {
  for (const id of timers) clearTimeout(id);
  for (const id of timers) clearInterval(id);
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  vi.restoreAllMocks();
});

// --- 换日：本机 04:00 ---------------------------------------------------------

describe('换日按本机 04:00', () => {
  test('03:59 仍属于前一天，04:00 属于新的一天', () => {
    const { dayKey } = loadApp();
    expect(dayKey(at(2026, 3, 1, 3, 59))).toBe('2026-02-28');
    expect(dayKey(at(2026, 3, 1, 4, 0))).toBe('2026-03-01');
    // 同一个日历日内的其它时刻没有歧义。
    expect(dayKey(at(2026, 3, 1, 23, 59))).toBe('2026-03-01');
    expect(dayKey(at(2026, 3, 1, 0, 30))).toBe('2026-02-28');
  });

  test('日期加减走 Date 运算，跨月与跨年都对', () => {
    const { addDays, nextDay, dayGap } = loadApp();
    expect(nextDay('2026-01-31')).toBe('2026-02-01');
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
    expect(nextDay('2026-02-28')).toBe('2026-03-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(dayGap('2026-01-31', '2026-02-01')).toBe(1);
    expect(dayGap('2026-12-31', '2027-01-01')).toBe(1);
  });
});

// --- 连续天数 ----------------------------------------------------------------

describe('连续天数', () => {
  const habits = [{ id: 'h1', name: '早读' }];

  test('1/31 → 2/1 连续', () => {
    const { settle } = loadApp();
    const state = stateWith({
      habits,
      done: { '2026-01-31': ['h1'], '2026-02-01': ['h1'] },
      closedThrough: '2026-01-30',
      streak: 0,
    });
    // 站在 2/2 早上：1/31 与 2/1 都应该被结算成"完成"。
    const settled = settle(state, at(2026, 2, 2, 9));
    expect(settled.streak).toBe(2);
    expect(settled.closedThrough).toBe('2026-02-01');
  });

  test('12/31 → 1/1 连续', () => {
    const { settle } = loadApp();
    const state = stateWith({
      habits,
      done: { '2025-12-31': ['h1'], '2026-01-01': ['h1'] },
      closedThrough: '2025-12-30',
      streak: 0,
    });
    expect(settle(state, at(2026, 1, 2, 9)).streak).toBe(2);
  });

  test('漏掉一天就断，断之后重新数', () => {
    const { settle } = loadApp();
    const state = stateWith({
      habits,
      done: { '2026-11-01': ['h1'], '2026-11-03': ['h1'] },
      closedThrough: '2026-10-31',
      streak: 4,
    });
    // 11/01 完成 → 5；11/02 空 → 0；11/03 还没结算（今天）。
    const settled = settle(state, at(2026, 11, 3, 9));
    expect(settled.streak).toBe(0);
    expect(settled.best).toBe(5);
  });

  test('今天打满时，显示出来的连续天数包含今天', () => {
    const { streakInfo } = loadApp();
    const state = stateWith({
      habits,
      done: { '2026-11-01': ['h1'], '2026-11-02': ['h1'], '2026-11-03': ['h1'] },
      closedThrough: '2026-10-31',
      streak: 0,
    });
    const info = streakInfo(state, at(2026, 11, 3, 9));
    // 1、2 号已结算（2），3 号今天打满 → 显示 3。
    expect(info.streak).toBe(3);
    expect(info.lastDay).toBe('2026-11-03');
    expect(info.todayComplete).toBe(true);
  });

  test('今天还没打满时，显示的是截至昨天的连续天数', () => {
    const { streakInfo } = loadApp();
    const state = stateWith({
      habits,
      done: { '2026-11-01': ['h1'], '2026-11-02': ['h1'] },
      closedThrough: '2026-10-31',
      streak: 0,
    });
    const info = streakInfo(state, at(2026, 11, 3, 9));
    expect(info.streak).toBe(2);
    expect(info.lastDay).toBe('2026-11-02');
    expect(info.todayComplete).toBe(false);
  });
});

// --- 幂等 ---------------------------------------------------------------------

describe('断签只重置一次', () => {
  test('同一份状态结算两遍，连续天数不会反复清零', () => {
    const { settle } = loadApp();
    const live = stateWith({
      habits: [{ id: 'h1', name: '早读' }],
      done: { '2026-11-01': ['h1'], '2026-11-02': ['h1'] },
      closedThrough: '2026-10-31',
      streak: 6,
    });
    const once = settle(live, at(2026, 11, 3, 9));
    const twice = settle(once, at(2026, 11, 3, 9));
    expect(once.streak).toBe(8);
    expect(twice.streak).toBe(8);
    expect(twice.closedThrough).toBe(once.closedThrough);

    // 断签的那一份也一样：第一遍把 streak 归零，第二遍不该做任何事。
    const broken = stateWith({
      habits: [{ id: 'h1', name: '早读' }],
      done: {},
      closedThrough: '2026-10-31',
      streak: 6,
    });
    const a = settle(broken, at(2026, 11, 3, 9));
    const b = settle(a, at(2026, 11, 3, 9));
    expect(a.streak).toBe(0);
    expect(b.streak).toBe(0);
    expect(b.closedThrough).toBe('2026-11-02');
  });

  test('同一格重复打卡不会记两次，重复取消也不会', () => {
    const { setDone, toggleDone, isDayComplete } = loadApp();
    const habits = [{ id: 'h1', name: '早读' }];
    const state = stateWith({ habits });
    const day = '2026-11-03';

    const first = setDone(state, 'h1', day, true);
    expect(first.done[day]).toEqual(['h1']);
    // 第二次是"没有改动"，而不是"再记一条"。
    expect(setDone(first, 'h1', day, true)).toBeNull();
    expect(isDayComplete(first, day)).toBe(true);

    const off = setDone(first, 'h1', day, false);
    expect(off.done[day]).toEqual([]);
    expect(setDone(off, 'h1', day, false)).toBeNull();
    expect(isDayComplete(off, day)).toBe(false);

    // toggle 也是一样的：点了两下回到原样，中间不产生第二格。
    const tolled = toggleDone(toggleDone(state, 'h1', at(2026, 11, 3, 9)), 'h1', at(2026, 11, 3, 9));
    expect(tolled.done['2026-11-03'] || []).toEqual([]);
  });

  test('时钟被拨回去之后，结算不会凭空加一天', () => {
    const { settle } = loadApp();
    const state = stateWith({
      habits: [{ id: 'h1', name: '早读' }],
      done: { '2026-11-03': ['h1'] },
      closedThrough: '2026-11-03',
      streak: 5,
    });
    const settled = settle(state, at(2026, 11, 3, 9));
    expect(settled.streak).toBe(5);
    expect(settled.closedThrough).toBe('2026-11-03');
  });
});

// --- 提醒 ---------------------------------------------------------------------

describe('到点提醒', () => {
  test('20:00 之后才算到点，且同一天只提醒一次', () => {
    const { reminderDue } = loadApp();
    const state = stateWith({ habits: [{ id: 'h1', name: '早读' }] });
    expect(reminderDue(state, at(2026, 11, 3, 19, 59), '20:00')).toBe(false);
    expect(reminderDue(state, at(2026, 11, 3, 20, 0), '20:00')).toBe(true);
    // 已经提醒过（落盘的那一格）就安静了——这就是"重挂帧不重复提醒"的那一半。
    expect(reminderDue(stateWith({ ...state, lastRemindDay: '2026-11-03' }), at(2026, 11, 3, 21), '20:00')).toBe(false);
  });

  test('都打完了就不提醒；没有习惯也不提醒', () => {
    const { reminderDue } = loadApp();
    const done = stateWith({ habits: [{ id: 'h1', name: '早读' }], done: { '2026-11-03': ['h1'] } });
    expect(reminderDue(done, at(2026, 11, 3, 21), '20:00')).toBe(false);
    expect(reminderDue(stateWith({}), at(2026, 11, 3, 21), '20:00')).toBe(false);
  });

  test('提醒时刻写成凌晨 03:30 也属于同一个习惯日', () => {
    const { reminderDue, dayKey } = loadApp();
    const state = stateWith({ habits: [{ id: 'h1', name: '早读' }] });
    // 03:30 在 04:00 之前 → 属于前一天；那一天还没提醒过，所以到点该提醒。
    expect(reminderDue(state, at(2026, 11, 3, 3, 30), '03:30')).toBe(true);
    expect(dayKey(at(2026, 11, 3, 3, 30))).toBe('2026-11-02');
    // 前一天已提醒 → 安静。
    expect(reminderDue(stateWith({ ...state, lastRemindDay: '2026-11-02' }), at(2026, 11, 3, 3, 30), '03:30')).toBe(false);
  });

  test('常驻帧一拍一拍地看，最终只提醒一次，并把 lastRemindDay 落盘', async () => {
    const now = at(2026, 11, 3, 20, 30);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    store.set(
      STATE_KEY,
      JSON.stringify(stateWith({ habits: [{ id: 'h1', name: '早读' }], closedThrough: '2026-11-02' })),
    );
    const bg = await boot({ slot: 'background' });

    // 第一拍：到点、还没提醒过 → 打开卡片并把"今天提醒过"写进存储。
    await tick(bg);
    expect(requestsOf('surface.show')).toHaveLength(1);
    expect(stored().lastRemindDay).toBe('2026-11-03');

    // 后面几拍：定时器每 30 秒都会看一次，但同一份状态只提醒一次。
    await tick(bg);
    await tick(bg);
    expect(requestsOf('surface.show')).toHaveLength(1);
  });

  test('提醒关掉之后一拍都不提醒', async () => {
    configValues.remindEnabled = 'false';
    vi.spyOn(Date, 'now').mockReturnValue(at(2026, 11, 3, 21));
    store.set(STATE_KEY, JSON.stringify(stateWith({ habits: [{ id: 'h1', name: '早读' }] })));
    const bg = await boot({ slot: 'background' });
    await tick(bg);
    expect(requestsOf('surface.show')).toHaveLength(0);
  });
});

// --- 头顶那行字 ---------------------------------------------------------------

describe('头顶那行字', () => {
  test('两种模式各说一句话，最长不超过 16 字符', () => {
    const { badgeText, BADGE_MAX } = loadApp();
    expect(BADGE_MAX).toBe(16);
    const state = stateWith({
      habits: [
        { id: 'h1', name: '早读' },
        { id: 'h2', name: '喝水' },
      ],
      done: { '2026-11-02': ['h1', 'h2'] },
      closedThrough: '2026-11-02',
      streak: 11,
    });
    expect(badgeText(state, at(2026, 11, 3, 9), 'streak')).toBe('连续 11 天');
    expect(badgeText(state, at(2026, 11, 3, 9), 'pending')).toBe('今天还差 2 件');
    // 没有习惯时给空串：那是宿主的"清除"语义，不是一句话。
    expect(badgeText(stateWith({}), at(2026, 11, 3, 9), 'streak')).toBe('');
    // 数字再大也顶不到 16：这里只是把上限钉住（宿主只画、不解析）。
    const many = stateWith({ habits: [{ id: 'h1', name: 'x' }], closedThrough: '2026-11-02', streak: 12345 });
    expect(Array.from(badgeText(many, at(2026, 11, 3, 9), 'streak')).length).toBeLessThanOrEqual(16);
  });

  test('常驻帧把这一行推上去（且只在文字变了的时候推）', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(at(2026, 11, 3, 9));
    store.set(
      STATE_KEY,
      JSON.stringify(
        stateWith({
          habits: [{ id: 'h1', name: '早读' }],
          done: { '2026-11-01': ['h1'], '2026-11-02': ['h1'] },
          closedThrough: '2026-11-01',
          streak: 1,
        }),
      ),
    );
    const bg = await boot({ slot: 'background' });
    const pushes = requestsOf('pet.badge');
    expect(pushes.length).toBeGreaterThan(0);
    expect(pushes[pushes.length - 1].payload.text).toBe('连续 2 天');
    // 再拍两下：文字没变就不该再推（否则日志里全是同一行）。
    const before = requestsOf('pet.badge').length;
    await tick(bg);
    await tick(bg);
    expect(requestsOf('pet.badge').length).toBe(before);
  });

  test('没授予 pet.surface 时一个 pet.badge 请求都不发，界面写明缺的是哪一项', async () => {
    await boot({ slot: 'workshop', granted: ['storage', 'plugin.config', 'events', 'plugin.call'] });
    expect(requestsOf('pet.badge')).toHaveLength(0);
    expect(document.getElementById('badge-note').textContent).toContain('头顶那行字需要「在桌宠身上显示」这项授权');
  });

  test('控制中心那一面即使有授权也不碰宠物（那里没有宠物）', async () => {
    await boot({ slot: 'workshop' });
    expect(requestsOf('pet.badge')).toHaveLength(0);
    // 说清"这件事在桌宠上"，而不是让用户对着一个点了没反应的开关。
    expect(document.getElementById('badge-note').textContent).toContain('只在桌宠上显示');
  });
});

// --- 协议与主路径 -------------------------------------------------------------

describe('握手与主路径', () => {
  test('ready → init，granted 装上之后才去读设置与存储', async () => {
    store.set(STATE_KEY, JSON.stringify(stateWith({ habits: [{ id: 'h1', name: '早读' }] })));
    await boot({ slot: 'workshop' });

    const ready = byType('ready');
    expect(ready).toHaveLength(1);
    expect(ready[0].v).toBe(1);
    expect(requestsOf('config.get')).toHaveLength(1);
    expect(requestsOf('storage.get').length).toBeGreaterThan(0);
    // init 里没授予的权限，连问都不问。
    expect(requestsOf('pet.badge')).toHaveLength(0);
    expect(document.getElementById('stat-streak').textContent).toBe('连续 0 天');
  });

  test('插件页里点一下就打卡，写进存储的形状对得上', async () => {
    const now = at(2026, 11, 3, 9);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    store.set(
      STATE_KEY,
      JSON.stringify(stateWith({ habits: [{ id: 'h1', name: '早读' }, { id: 'h2', name: '喝水' }], closedThrough: '2026-11-02' })),
    );
    await boot({ slot: 'workshop' });

    const rows = [...document.querySelectorAll('#today-list .task')];
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('.name').textContent).toBe('早读');

    click('#today-list button[data-act="done"]');
    await drain(10);

    const saved = stored();
    expect(saved.done['2026-11-03']).toEqual(['h1']);
    // 界面上那一行变成"已打卡"，统计里还差一件。
    expect(document.querySelector('#today-list .task.done .check').textContent).toBe('已打卡');
    expect(document.getElementById('stat-pending').textContent).toBe('今天还差 1 件');
  });

  test('卡片只列今天还没打的，点一下就打上', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(at(2026, 11, 3, 9));
    store.set(
      STATE_KEY,
      JSON.stringify(
        stateWith({
          habits: [{ id: 'h1', name: '早读' }, { id: 'h2', name: '喝水' }],
          // 昨天两件都打了、今天只打了 h1：卡片列一行，顶部写着截至昨天的连续天数。
          done: { '2026-11-02': ['h1', 'h2'], '2026-11-03': ['h1'] },
          closedThrough: '2026-11-01',
        }),
      ),
    );
    await boot({ slot: 'surface' });

    const rows = [...document.querySelectorAll('#card-list .row')];
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('.row-name').textContent).toBe('喝水');
    expect(document.getElementById('card-streak').textContent).toBe('连续 1 天');

    click('#card-list .row');
    await drain(10);
    expect(stored().done['2026-11-03']).toEqual(['h1', 'h2']);
    // 都打完了：列表清空，换一行说明（140px 里不能两样都有）。
    expect(document.querySelectorAll('#card-list .row')).toHaveLength(0);
    expect(document.getElementById('card-note').textContent).toContain('都打完了');
    // 今天打满之后，卡片顶部那一行立刻把今天算进去。
    expect(document.getElementById('card-streak').textContent).toBe('连续 2 天');
  });

  test('加习惯与删习惯都落在同一个键上', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(at(2026, 11, 3, 9));
    store.set(STATE_KEY, JSON.stringify(stateWith({ habits: [{ id: 'h1', name: '早读' }], closedThrough: '2026-11-02' })));
    await boot({ slot: 'workshop' });

    document.getElementById('add-name').value = '练琴';
    document.getElementById('add-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await drain(10);
    expect(stored().habits.map((h) => h.name)).toEqual(['早读', '练琴']);
    expect(document.getElementById('add-name').value).toBe('');

    click('#habit-list button[data-act="remove"]');
    await drain(10);
    expect(stored().habits.map((h) => h.name)).toEqual(['练琴']);
  });
});

describe('serves.streak 与 serves.today', () => {
  function call(method, payload = {}) {
    const before = byType('call-result').length;
    const ticket = `t-${Math.random().toString(36).slice(2, 8)}`;
    hostSends({ v: 1, type: 'call', ticket, from: 'com.shixiansi.plugin-chat', method, payload });
    return () => {
      const list = byType('call-result').slice(before);
      expect(list.length, `${method} 一直没有回包`).toBeGreaterThan(0);
      return list[list.length - 1];
    };
  }

  test('streak 回 {streak, lastDay, best}', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(at(2026, 11, 3, 9));
    store.set(
      STATE_KEY,
      JSON.stringify(
        stateWith({
          habits: [{ id: 'h1', name: '早读' }],
          done: { '2026-11-01': ['h1'], '2026-11-02': ['h1'] },
          closedThrough: '2026-10-31',
          streak: 0,
          best: 9,
        }),
      ),
    );
    await boot({ slot: 'background' });
    const taken = call('streak');
    await drain(6);
    const packet = taken();
    expect(packet.ok).toBe(true);
    expect(Object.keys(packet.result).sort()).toEqual(['best', 'lastDay', 'streak']);
    expect(packet.result).toEqual({ streak: 2, lastDay: '2026-11-02', best: 9 });
  });

  test('today 回 {day, items:[{id,name,done}], pending}', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(at(2026, 11, 3, 9));
    store.set(
      STATE_KEY,
      JSON.stringify(
        stateWith({
          habits: [{ id: 'h1', name: '早读' }, { id: 'h2', name: '喝水' }],
          done: { '2026-11-03': ['h1'] },
          closedThrough: '2026-11-02',
        }),
      ),
    );
    await boot({ slot: 'background' });
    const taken = call('today');
    await drain(6);
    const packet = taken();
    expect(packet.ok).toBe(true);
    expect(packet.result.day).toBe('2026-11-03');
    expect(packet.result.pending).toBe(1);
    expect(packet.result.items).toEqual([
      { id: 'h1', name: '早读', done: true },
      { id: 'h2', name: '喝水', done: false },
    ]);
  });

  test('未知方法回一句说得清的中文，而不是沉默', async () => {
    await boot({ slot: 'background' });
    const taken = call('weekly', {});
    await drain(4);
    const packet = taken();
    expect(packet.ok).toBe(false);
    expect(packet.error).toContain('weekly');
    expect(packet.error).toContain('streak');
  });
});

describe('宿主拒绝一切', () => {
  test('不崩、不写数据，界面进入可理解的降级态', async () => {
    denyAll = true;
    configValues = { remindAt: '20:00', badgeMode: 'streak', remindEnabled: 'true' };
    store.set(STATE_KEY, JSON.stringify(stateWith({ habits: [{ id: 'h1', name: '早读' }] })));
    const before = store.get(STATE_KEY);

    await boot({ slot: 'workshop' });
    await drain(8);

    // 什么都没写：拒绝的那一次是"整个请求不执行"，不是"写了但失败"。
    expect(store.get(STATE_KEY)).toBe(before);
    expect(requestsOf('storage.set')).toHaveLength(0);
    // 界面把宿主那句中文原样显示出来（不包装成"出错了"）。
    expect(document.getElementById('page-status').textContent).toContain('读不到打卡记录');
    expect(document.getElementById('page-status').textContent).toContain('模拟拒绝');
  });

  test('点打卡也一样：写不进去就只报一句，不留下半个状态', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(at(2026, 11, 3, 9));
    store.set(STATE_KEY, JSON.stringify(stateWith({ habits: [{ id: 'h1', name: '早读' }], closedThrough: '2026-11-02' })));
    await boot({ slot: 'workshop' });
    const before = store.get(STATE_KEY);

    denyAll = true;
    click('#today-list button[data-act="done"]');
    await drain(8);

    expect(store.get(STATE_KEY)).toBe(before);
    expect(document.getElementById('page-status').textContent).toContain('模拟拒绝');
  });
});
