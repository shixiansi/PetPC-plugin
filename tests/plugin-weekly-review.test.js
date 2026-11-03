import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 周报插件的行为测试：驱动的是 panel.html 里真实加载的那几支脚本。
//
// harness 与 imgbed / diary-writer 那几份同型：vitest 的 jsdom 全局 window 当作插件的 window，
// 拼起来的源码用 new Function 丢进一个新函数作用域（等于浏览器里那几支经典 script 共享一个作用域），
// 出站 postMessage 用 spy 记下来，假宿主逐条应答。
//
// 这个文件钉住的几件事（都是"错了也看不出来"的那种）：
//
//   1. manifest 的形状：六项权限、三个静态 callTargets、serves 只有 report / latest、一块浮层面，
//      配置项的默认值（尤其"日记默认不进报告"这个隐私取舍）；
//   2. 周区间是纯函数：跨月那一周、跨年那一周、周日最后一毫秒与周一第一毫秒；
//   3. 三个来源各自**三种**失败的写法（没装 / 答得不对 / 报错）都还能出报告，并且写明缺哪一块；
//   4. llm.chat 被拒时退回模板周报（三个数写成几句人话），不崩、不空着；
//   5. 同一天只生成一次：重复判定不再生成、不再冒泡，重启之后靠 storage 里的 lastReportDay 也认得；
//   6. 正文 ≤300 字，而且素材在**喂模型之前**就被截断（不是事后截）；
//   7. serves.latest 在还没生成过时回 {text:'', at:0}；未知方法回一句中文；
//   8. 宿主拒绝一切时不崩、不写数据。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-weekly-review');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');
const source = scriptSources.map((src) => readFileSync(path.join(pluginDir, src), 'utf8')).join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-weekly-review';
const TODO_KEY = 'com.shixiansi.plugin-todo/stats';
const FOCUS_KEY = 'com.shixiansi.plugin-pomodoro/stats';
const DIARY_KEY = 'com.shixiansi.plugin-diary-writer/get_recent';

// --- 用例自己的日期算术（不复用插件那份，否则等于用它验证它自己）--------------------

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function todayKey() {
  return dayKey(new Date());
}

/** 本周一到周日七个日键。 */
function thisWeekDays() {
  const at = new Date();
  const sinceMonday = (at.getDay() + 6) % 7;
  const out = [];
  for (let i = 0; i < 7; i += 1) {
    out.push(dayKey(new Date(at.getFullYear(), at.getMonth(), at.getDate() - sinceMonday + i, 12)));
  }
  return out;
}

function defaultConfig() {
  const values = {};
  for (const item of manifest.config) if (item.default !== undefined) values[item.key] = item.default;
  return values;
}

function sampleDiary() {
  const days = thisWeekDays();
  return {
    entries: [
      { day: days[0], mood: 'calm', text: '周一清了几件杂事，下午开会。' },
      { day: days[3], mood: 'happy', text: '周四把周报插件的前半段写完了。' },
      // 上周那一篇：不在本周区间里，必须被筛掉。
      { day: '2020-01-01', mood: 'tired', text: '这是上古的一篇，不属于本周。' },
    ],
  };
}

function sampleTodo() {
  return { total: 12, done: 7, open: 5, dueToday: 2, completionRate: 58, at: Date.now() };
}

function sampleFocus() {
  return { focusMinutesToday: 150, focusSessions: 3, focusSessionsTotal: 40, at: Date.now() };
}

// --- manifest ------------------------------------------------------------------

describe('manifest', () => {
  test('只要七项权限，落点是浮层面一块 + 常驻帧（面板页由 workshop 提供）', () => {
    expect([...manifest.permissions].sort()).toEqual(
      ['events', 'llm.chat', 'pet.bubble', 'pet.surface', 'plugin.call', 'plugin.config', 'storage'],
    );
    // 没有 plugin.share：三条素材都走 plugin.call，牌盘是另一件事（用处是"贴便条"，没有回答）。
    expect(manifest.permissions).not.toContain('plugin.share');
    expect(manifest.permissions).not.toContain('net.fetch');
    expect(manifest.background).toBe(true);
    expect(manifest.surface).toHaveLength(1);
    const rect = manifest.surface[0];
    expect(rect.w).toBe(300);
    expect(rect.h).toBe(140);
    expect(rect.radius).toBe(14);
    // 浮层面里的内容不许画到矩形外：能长高的块在这里没有声明（也没有 surface.blocks 的授权）。
    expect(rect.maxH).toBeUndefined();
    expect(manifest.entry).toBe('panel.html');
  });

  test('声明了 surface 就必须申请 pet.surface；反过来，没有一项权限是代码里从不出现的', () => {
    // 宿主硬判 hasPermission(granted, pet.surface) 才肯开浮层面（app_plugin_surface.go）；
    // 声明了 surface 却不申请它，那张卡片在真机上永远打不开——manifest 却"看起来合法"。
    expect(manifest.surface.length).toBeGreaterThan(0);
    expect(manifest.permissions).toContain('pet.surface');
    // 另一个方向：用户点头却什么也不做的开关是这个项目明令禁止的，所以每一项都要真的被用到。
    for (const perm of manifest.permissions) {
      expect(source.includes(`'${perm}'`), `权限 ${perm} 在代码里从未出现`).toBe(true);
    }
  });

  test('serves 与 callTargets 是三个已经上线的方法，静态写清（不用 services 发现）', () => {
    expect(manifest.serves).toEqual(['report', 'latest']);
    expect([...manifest.callTargets].sort()).toEqual([DIARY_KEY, FOCUS_KEY, TODO_KEY].sort());
    // 不写版本下限：这三个 stats 都不带"后加字段"的风险，硬写一个没核对过的数字只会训练作者乱抄。
    for (const target of manifest.callTargets) expect(target).not.toContain('@');
  });

  test('四个配置项的默认值：周日 20:00、用模型润色、日记默认不进报告', () => {
    const byKey = Object.fromEntries(manifest.config.map((item) => [item.key, item]));
    expect(byKey.reportTime.type).toBe('text');
    expect(byKey.reportTime.default).toBe('20:00');

    expect(byKey.reportWeekday.type).toBe('select');
    expect(byKey.reportWeekday.default).toBe('0');           // 0 = 周日，与 Date.getDay 同一套词
    expect(byKey.reportWeekday.options.map((o) => o.label)).toEqual(
      ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
    );

    expect(byKey.useModel.type).toBe('bool');
    expect(byKey.useModel.default).toBe('true');

    // 隐私取舍：日记正文默认不出现在报告里，用户勾了才带。
    expect(byKey.includeDiary.type).toBe('bool');
    expect(byKey.includeDiary.default).toBe('false');
  });

  test('页面加载的每个本地文件都写进了 assets，且都在磁盘上', () => {
    const fixed = ['panel.html', 'app.js', 'style.css'];
    for (const src of scriptSources) {
      if (fixed.includes(src)) continue;
      expect(manifest.assets).toContain(src);
    }
    for (const asset of manifest.assets) {
      expect(existsSync(path.join(pluginDir, asset)), `manifest.assets 里的 ${asset} 不存在`).toBe(true);
    }
    expect(existsSync(path.join(pluginDir, manifest.entry))).toBe(true);
  });
});

// --- harness -----------------------------------------------------------------

let store;
let configValues;
let callReplies;
let llm;
let llmCalls;
let bubbles;
let answered;
let postedFrom;
// 出站消息的收件窗口。默认就是本 window（jsdom 里父窗口也是自己，简化到只剩一支），
// 但真宿主是"插件在 iframe、宿主在父文档"——那一条由「真宿主拓扑」那条用例把父窗口换掉来钉住。
let hostWindow;
let windowListeners;
let intervals;
let runtimeErrors;
let denyEverything;
let storageSets;
let dueAfterBoot;

function posted() {
  return hostWindow.postMessage.mock.calls.map((call) => call[0]).slice(postedFrom);
}

function byType(type) {
  return posted().filter((m) => m && m.type === type);
}

function requests() {
  return byType('request').map((m) => ({ id: m.id, method: m.method, payload: m.payload }));
}

function hostSends(data) {
  window.dispatchEvent(new MessageEvent('message', { data, source: hostWindow }));
}

function answer(id, result, { ok = true, error = '' } = {}) {
  answered.add(id);
  hostSends({ v: 1, type: 'response', id, ok, result, error });
}

/** 每拍把还没答的请求答掉，再让出一拍——一次生成里"一个答复引出下一个请求"要好几拍。 */
async function drain(rounds = 30) {
  for (let i = 0; i < rounds; i += 1) {
    for (const req of requests().filter((r) => !answered.has(r.id))) {
      const payload = req.payload || {};
      if (denyEverything) {
        answer(req.id, null, { ok: false, error: `模拟拒绝：未获权限 ${req.method}` });
        continue;
      }
      switch (req.method) {
        case 'config.get':
          answer(req.id, { values: configValues, secrets: {} });
          break;
        case 'storage.get': {
          const key = String(payload.key);
          answer(req.id, { value: store.has(key) ? store.get(key) : '' });
          break;
        }
        case 'storage.set': {
          const key = String(payload.key);
          storageSets.push(key);
          store.set(key, String(payload.value === undefined ? '' : payload.value));
          answer(req.id, { ok: true });
          break;
        }
        case 'storage.remove':
          store.delete(String(payload.key));
          answer(req.id, { ok: true });
          break;
        case 'events.subscribe':
          answer(req.id, Array.isArray(payload.names) ? payload.names : []);
          break;
        case 'bubble.say':
          bubbles.push(String(payload.text || ''));
          answer(req.id, { ok: true });
          break;
        case 'llm.chat':
          llmCalls.push(payload);
          if (llm.ok) answer(req.id, { requestId: 'r1', text: llm.text });
          else answer(req.id, null, { ok: false, error: llm.error });
          break;
        case 'plugin.call': {
          const key = `${payload.target}/${payload.method}`;
          const reply = callReplies[key];
          if (!reply) answer(req.id, null, { ok: false, error: `未安装或未启用插件 ${payload.target}` });
          else if (reply.ok === false) answer(req.id, null, { ok: false, error: reply.error });
          else answer(req.id, reply.result);
          break;
        }
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
  postedFrom = hostWindow.postMessage.mock.calls.length;
  runtimeErrors = [];
  window.addEventListener('error', (e) => runtimeErrors.push(String(e.message || e.error)));
  window.addEventListener('unhandledrejection', (e) => {
    runtimeErrors.push(`unhandled: ${String((e.reason && e.reason.message) || e.reason)}`);
  });
  // eslint-disable-next-line no-new-func
  new Function(source)();
}

function initMessage(slot) {
  const surface = slot === 'workshop'
    ? { kind: 'panel', slot: 'workshop' }
    : slot === 'card'
      ? {
        kind: 'surface',
        rectIndex: 0,
        rectCount: 1,
        rect: { x: 0, y: 0, w: 300, h: 140, r: 14, tailX: 0, hidden: false, room: 160 },
      }
      : { kind: 'panel', slot: 'background' };
  return {
    v: 1,
    type: 'init',
    pluginId: PLUGIN_ID,
    permissions: manifest.permissions,
    granted: [...(initMessage.granted || manifest.permissions)],
    surface,
    host: {
      program: slot === 'workshop' ? 'workshop' : 'pet',
      methods: slot === 'workshop'
        ? ['config.get', 'storage.get', 'storage.set', 'storage.remove']
        : [
          'bubble.say', 'config.get', 'events.subscribe', 'llm.chat',
          'plugin.call', 'storage.get', 'storage.remove', 'storage.set', 'surface.show',
        ],
    },
  };
}

/** 装一份帧。`slot` 决定它是插件页、浮层面那块卡片，还是桌宠那边的常驻帧。 */
async function boot({ slot = 'background', granted = manifest.permissions } = {}) {
  // 启动这一拍先按"不是今天"跑：init 里那次补判定（宿主半夜重启会错过 20:00）如果当场就生成，
  // 用例就再也拍不到"第一次"了。要它到点的用例在 boot 之后用 makeDue() 声明。
  configValues.reportWeekday = String((new Date().getDay() + 1) % 7);
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
  initMessage.granted = granted;
  loadApp();
  hostSends(initMessage(slot));
  await drain(6);
  if (dueAfterBoot) {
    configValues.reportWeekday = String(new Date().getDay());
    configValues.reportTime = '00:00';
    const refreshing = window.__weekly.refreshConfig();
    await drain(4);
    await refreshing;
  }
  return window.__weekly;
}

function api() {
  return window.__weekly;
}

/** 起一拍并把它推完（定时判定是"发请求 → 等答复"的链，不能先 await 再 drain）。 */
async function tick() {
  const running = api().weeklyTick();
  await drain();
  return running;
}

function latest() {
  const raw = store.get('reports/latest');
  return raw ? JSON.parse(raw) : null;
}

function callHost(method, payload) {
  const before = byType('call-result').length;
  const ticket = `t-${Math.random().toString(36).slice(2, 8)}`;
  hostSends({ v: 1, type: 'call', ticket, from: 'com.shixiansi.plugin-chat', method, payload });
  return async () => {
    await drain(12);
    const list = byType('call-result').slice(before);
    expect(list.length, `plugin.call ${method} 一直没有回包`).toBeGreaterThan(0);
    return list[list.length - 1];
  };
}

/** 让"到点"成立：boot 之前声明，boot 会在 init 之后把配置改成"今天 + 00:00"（任何现在都过了）。 */
function makeDue() {
  dueAfterBoot = true;
}

function makeNotDue() {
  dueAfterBoot = false;
}

beforeEach(() => {
  store = new Map();
  configValues = defaultConfig();
  callReplies = {
    [TODO_KEY]: { result: sampleTodo() },
    [FOCUS_KEY]: { result: sampleFocus() },
    [DIARY_KEY]: { result: sampleDiary() },
  };
  llm = { ok: true, text: '这一周把待办收了大部分，专注也稳，日记写了两篇。', error: '' };
  llmCalls = [];
  bubbles = [];
  storageSets = [];
  windowListeners = [];
  intervals = [];
  runtimeErrors = [];
  denyEverything = false;
  dueAfterBoot = false;
  hostWindow = window;

  const originalAdd = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(function (type, fn, opts) {
    windowListeners.push([type, fn, opts]);
    return originalAdd(type, fn, opts);
  });
  const originalInterval = window.setInterval.bind(window);
  // 只记账不拦：一分钟的定时器在用例里没有机会自己响，_清掉它是为了别污染后面那份文档_。
  vi.spyOn(window, 'setInterval').mockImplementation((fn, ms, ...rest) => {
    const id = originalInterval(fn, ms, ...rest);
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

// --- 周区间（纯函数）------------------------------------------------------------

describe('周区间是纯函数：周一 00:00 → 周日 23:59:59.999（本地时区）', () => {
  test('跨月的那一周：2026-09-30（周三）落在 09-28 → 10-04', async () => {
    await boot();
    const range = api().week.weekRangeOf(new Date(2026, 8, 30, 12, 0, 0).getTime());
    expect(api().week.dayKeyOf(range.start)).toBe('2026-09-28');
    expect(api().week.dayKeyOf(range.end)).toBe('2026-10-04');
    expect(new Date(range.start).getHours()).toBe(0);
    expect(new Date(range.start).getMinutes()).toBe(0);
    expect(new Date(range.end).getHours()).toBe(23);
    expect(new Date(range.end).getMinutes()).toBe(59);
    expect(new Date(range.end).getSeconds()).toBe(59);
    expect(new Date(range.end).getMilliseconds()).toBe(999);
    expect(range.days).toEqual([
      '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
    ]);
    expect(api().week.weekLabel(range)).toBe('09.28–10.04');
  });

  test('跨年的那一周：2026-12-30（周三）落在 2026-12-28 → 2027-01-03', async () => {
    await boot();
    const range = api().week.weekRangeOf(new Date(2026, 11, 30, 9, 0, 0).getTime());
    expect(api().week.dayKeyOf(range.start)).toBe('2026-12-28');
    expect(api().week.dayKeyOf(range.end)).toBe('2027-01-03');
    expect(range.days[0]).toBe('2026-12-28');
    expect(range.days[6]).toBe('2027-01-03');
  });

  test('周日的最后一毫秒属于本周，周一的第一毫秒属于新的一周', async () => {
    await boot();
    const sunday = api().week.weekRangeOf(new Date(2026, 9, 4, 23, 59, 59, 999).getTime());
    expect(api().week.dayKeyOf(sunday.start)).toBe('2026-09-28');
    expect(api().week.dayKeyOf(sunday.end)).toBe('2026-10-04');

    const justBeforeMonday = api().week.weekRangeOf(new Date(2026, 8, 28, 0, 0, 0, 0).getTime() - 1);
    expect(api().week.dayKeyOf(justBeforeMonday.start)).toBe('2026-09-21');
    expect(api().week.dayKeyOf(justBeforeMonday.end)).toBe('2026-09-27');

    const monday = api().week.weekRangeOf(new Date(2026, 8, 28, 0, 0, 0, 0).getTime());
    expect(api().week.dayKeyOf(monday.start)).toBe('2026-09-28');
  });

  test('日记按日键挑：本周那几天在内，别的一律在外', async () => {
    await boot();
    const range = api().week.weekRangeOf(new Date(2026, 8, 30, 12, 0, 0).getTime());
    expect(api().week.dayInRange(range, '2026-09-28')).toBe(true);
    expect(api().week.dayInRange(range, '2026-10-04')).toBe(true);
    expect(api().week.dayInRange(range, '2026-09-27')).toBe(false);
    expect(api().week.dayInRange(range, '2026-10-05')).toBe(false);
  });

  test('时刻解析的兜底是 20:00（手滑不该变成"每天零点生成"）', async () => {
    await boot();
    expect(api().week.parseClock('20:00')).toEqual({ h: 20, min: 0 });
    expect(api().week.parseClock('7:05')).toEqual({ h: 7, min: 5 });
    expect(api().week.parseClock('')).toEqual({ h: 20, min: 0 });
    expect(api().week.parseClock('25:00')).toEqual({ h: 20, min: 0 });
    expect(api().week.parseClock('晚上八点')).toEqual({ h: 20, min: 0 });
  });

  test('到点判定只管"这一刻过了没有"：20:00 整点算到点，19:59 不算，之后一直算', async () => {
    await boot();
    const sunday = (h, m) => new Date(2026, 10, 1, h, m, 0, 0).getTime();   // 2026-11-01 是周日
    expect(api().week.dueNow(sunday(19, 59), 0, '20:00').due).toBe(false);
    expect(api().week.dueNow(sunday(20, 0), 0, '20:00').due).toBe(true);
    expect(api().week.dueNow(sunday(23, 30), 0, '20:00').due).toBe(true);
    // 不是配置的那一天：再晚也不到点。
    expect(api().week.dueNow(sunday(23, 30), 1, '20:00').due).toBe(false);
    expect(api().week.dueNow(sunday(20, 0), 0, '20:00').day).toBe('2026-11-01');
  });
});

// --- 握手 ----------------------------------------------------------------------

describe('握手', () => {
  test('常驻帧：ready → init，granted 装上，定时器只在这一面起', async () => {
    await boot({ slot: 'background' });
    const readyMsg = byType('ready');
    expect(readyMsg).toHaveLength(1);
    const snapshot = api().snapshot();
    expect(snapshot.ready).toBe(true);
    expect(snapshot.role).toBe('background');
    expect(snapshot.granted.sort()).toEqual([...manifest.permissions].sort());
    // 常驻帧会订阅 config.changed（改了时刻不必等下一分钟才生效）。
    expect(requests().some((r) => r.method === 'events.subscribe')).toBe(true);
    // 常驻帧看不见：两面都藏起来。
    expect(document.getElementById('card').classList.contains('hidden')).toBe(true);
    expect(document.getElementById('workshop').classList.contains('hidden')).toBe(true);
  });

  test('浮层面那一块：认得出来自己是卡片（kind:surface，没有 slot）', async () => {
    await boot({ slot: 'card' });
    expect(api().snapshot().role).toBe('card');
    expect(document.getElementById('card').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('workshop').classList.contains('hidden')).toBe(true);
    // 卡片只读 + 手动触发：它**不**起定时器（两个文档各跑一个 = 同一天两份周报、两个气泡）。
    expect(requests().some((r) => r.method === 'events.subscribe')).toBe(false);
  });

  test('控制中心插件页：常驻在桌宠上的按钮禁用并说明去哪做', async () => {
    await boot({ slot: 'workshop' });
    expect(api().snapshot().role).toBe('workshop');
    expect(document.getElementById('workshop').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('make-now').disabled).toBe(true);
    // workshop 里一个 plugin.call 都不发（那里没人答，真宿主会回「本程序不支持该方法」）。
    expect(requests().some((r) => r.method === 'plugin.call')).toBe(false);
  });
});

// --- 真宿主的拓扑 ---------------------------------------------------------------
//
// 这一条是 2026-11-03 那次「浮层面卡片一片空白」的回归网。事故的形状：桥写在 `window.postMessage`
// 上，而它的收件人是**被调用的那个 window**——插件文档活在宿主挂的 iframe 里，于是 ready 与
// request 全都发给了自己，宿主一条也收不到，init 永远不来，卡片停在那块白矩形里。
//
// 为什么之前的用例全绿：jsdom 里假宿主和插件文档住在同一个 window，`window.postMessage` 正好
// 送达——测试替真宿主说了一个谎。所以这条用例**把父窗口换成一个别的对象**（真宿主的形状），
// 并且 init 只喂真宿主真会给的字段：`kind:'surface'` + rectIndex / rectCount / rect，
// **没有 slot**（slot 是 workshop / background / pomodoro 那一类落点才有的）。
describe('真宿主拓扑：插件在 iframe、宿主在父文档', () => {
  test('浮层面 init（不带 slot）之后，卡片不在 .hidden 里，并且里面有一行字', async () => {
    // 真宿主给的那一份 init：把它先钉住，免得用例自己又"多带一个 slot"。
    const initPayload = initMessage('card');
    expect(initPayload.surface).toEqual({
      kind: 'surface',
      rectIndex: 0,
      rectCount: 1,
      rect: { x: 0, y: 0, w: manifest.surface[0].w, h: manifest.surface[0].h, r: manifest.surface[0].radius, tailX: 0, hidden: false, room: 160 },
    });
    expect('slot' in initPayload.surface).toBe(false);

    // 父窗口是**另一个**对象：和真浏览器里 iframe 的那条边界一样。
    const parentWindow = { postMessage: vi.fn() };
    const originalParent = Object.getOwnPropertyDescriptor(window, 'parent');
    Object.defineProperty(window, 'parent', { configurable: true, writable: true, value: parentWindow });
    try {
      hostWindow = parentWindow;
      await boot({ slot: 'card' });

      // 出站真的到了宿主：ready 与后续的 request 都在父窗口上（旧代码这里一条都没有）。
      const sent = parentWindow.postMessage.mock.calls.map((call) => call[0]);
      expect(sent.some((m) => m && m.type === 'ready'), 'ready 没有发给 window.parent').toBe(true);
      expect(sent.some((m) => m && m.type === 'request'), 'request 没有发给 window.parent').toBe(true);
      // 而且一个字节都没发给自己——发给自己正是那次事故。
      expect(window.postMessage).not.toHaveBeenCalled();

      const card = document.getElementById('card');
      expect(card.classList.contains('hidden'), '卡片还在 .hidden 里：init 收到了却没画出那一面').toBe(false);
      expect(document.getElementById('workshop').classList.contains('hidden')).toBe(true);
      // 卡片的根元素本身要有文字（不是"元素在、字没画"），并且至少能说清现在有没有周报。
      expect(card.textContent.trim().length).toBeGreaterThan(0);
      expect(document.getElementById('card-week').textContent).toContain('周报');
      expect(document.getElementById('card-line').textContent.trim().length).toBeGreaterThan(0);
    } finally {
      hostWindow = window;
      if (originalParent) Object.defineProperty(window, 'parent', originalParent);
      else delete window.parent;
    }
  });
});

// --- 主路径 --------------------------------------------------------------------

describe('主路径：三个来源汇成一份周报', () => {
  test('三个数都进报告（模板路径），storage 只留最新一份，气泡一次', async () => {
    makeDue();
    configValues.useModel = 'false';
    await boot();

    const record = await tick();
    expect(record).toBeTruthy();
    expect(record.source).toBe('template');
    expect(record.numbers.todoTotal).toBe(12);
    expect(record.numbers.todoRate).toBe(58);
    expect(record.numbers.focusMinutes).toBe(150);
    expect(record.numbers.diaryCount).toBe(2);       // 上古那一篇被周区间筛掉了
    expect(record.missing).toEqual([]);
    expect(record.text).toContain('12');
    expect(record.text).toContain('58%');
    expect(record.text).toContain('150');
    expect(record.text).toContain('2 篇');
    expect(record.week).toBe(api().week.weekLabel(api().week.weekRangeOf(Date.now())));

    // 只留最新一份：一个 reports/latest，没有"每周一个键"。
    expect([...store.keys()].filter((k) => k.startsWith('reports/'))).toEqual(['reports/latest']);
    expect(JSON.parse(store.get('reports/latest')).text).toBe(record.text);
    expect(JSON.parse(store.get('state/last-report-day')).day).toBe(todayKey());
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toContain('58%');
  });

  test('模型润色：素材里带着三个数与缺块状态，正文取模型那一份', async () => {
    makeDue();
    await boot();
    const record = await tick();

    expect(record.source).toBe('model');
    expect(record.text).toContain('这一周把待办收了大部分');
    expect(llmCalls).toHaveLength(1);
    const prompt = llmCalls[0].text;
    expect(prompt).toContain('12');
    expect(prompt).toContain('150');
    expect(prompt).toContain('完成率 58%');
    // 系统提示里写着字数上限：那是模型唯一能看到的约束。
    expect(llmCalls[0].system).toContain('300');
  });

  test('卡片上是三个数与一句结论，数字与报告同源', async () => {
    makeDue();
    configValues.useModel = 'false';
    await boot({ slot: 'card' });

    document.getElementById('card-now').click();
    await drain(32);

    expect(document.getElementById('num-todo').textContent).toBe('58%');
    expect(document.getElementById('num-focus').textContent).toBe('150');
    expect(document.getElementById('num-diary').textContent).toBe('2');
    expect(document.getElementById('card-line').textContent.length).toBeGreaterThan(0);
    expect(document.getElementById('card-missing').classList.contains('hidden')).toBe(true);
    expect(latest()).toBeTruthy();
  });
});

// --- 缺一块：三个来源 × 三种失败 ------------------------------------------------

const FAILURES = [
  {
    name: '对方没装（未安装 / 无此目标）',
    reply: (key) => ({ ok: false, error: `问不到 ${key.split('/')[0]}：目标插件未安装或未启用` }),
    cause: '没装或没启用',
  },
  {
    name: '对方答了但字段不对',
    reply: () => ({ result: { nope: true } }),
    cause: '答得不对',
  },
  {
    name: '对方报错',
    reply: () => ({ ok: false, error: '插件内部错误：storage 读不到 p/todos' }),
    cause: '报错了',
  },
];

const SOURCES = [
  { key: TODO_KEY, label: '待办', plugin: '待办插件' },
  { key: FOCUS_KEY, label: '专注', plugin: '番茄钟插件' },
  { key: DIARY_KEY, label: '日记', plugin: '日记插件' },
];

describe('三个来源任缺一块都还能出报告，并且写明缺的是哪一块', () => {
  for (const source of SOURCES) {
    for (const failure of FAILURES) {
      test(`${source.label}：${failure.name}`, async () => {
        configValues.useModel = 'false';
        callReplies[source.key] = failure.reply(source.key);
        // 用卡片那一面驱动：它一次走完"点「生成」→ 问三个插件 → 画三个数与缺块"，而且
        // "缺哪块"在这张 300×140 的卡片上必须看得见（不是只写在报告正文里）。
        await boot({ slot: 'card' });
        document.getElementById('card-now').click();
        await drain(32);

        const record = latest();
        expect(record, '缺一块不该让整份周报生不出来').toBeTruthy();
        expect(record.text.length).toBeGreaterThan(0);
        // 报告正文点名：
        expect(record.text).toContain(`这周没拿到${source.label}数据`);
        expect(record.text).toContain(failure.cause);
        expect(record.missing.map((m) => m.key)).toContain(
          source.key === TODO_KEY ? 'todo' : source.key === FOCUS_KEY ? 'focus' : 'diary',
        );
        // 另外两块照常写着，不因为一块缺了就整份改口。
        for (const other of SOURCES) {
          if (other.key === source.key) continue;
          expect(record.text).not.toContain(`这周没拿到${other.label}数据`);
        }
        // 缺的那一块的数字是 null，不是 0（0 会被当成"这周真的没有"）。
        const numbers = record.numbers;
        if (source.key === TODO_KEY) expect(numbers.todoRate).toBeNull();
        if (source.key === FOCUS_KEY) expect(numbers.focusMinutes).toBeNull();
        if (source.key === DIARY_KEY) expect(numbers.diaryCount).toBeNull();

        // UI 上也点名（卡片与插件页各说一次，不只写在正文里）。
        expect(document.getElementById('card-missing').textContent).toBe(`缺：${source.label}`);
      });
    }
  }

  test('三块全缺也出得来，并且三句都在', async () => {
    makeDue();
    configValues.useModel = 'false';
    for (const source of SOURCES) callReplies[source.key] = { ok: false, error: '问不到：未安装' };
    await boot();

    const record = await tick();
    expect(record.text).toContain('这周没拿到待办数据');
    expect(record.text).toContain('这周没拿到专注数据');
    expect(record.text).toContain('这周没拿到日记数据');
    expect(record.text.length).toBeLessThanOrEqual(300);
    expect(record.summary).toContain('三个来源');
  });

  test('缺块那句话在模型润色之后也还在（那是需求，不是模型的自由）', async () => {
    makeDue();
    callReplies[FOCUS_KEY] = { ok: false, error: '问不到 com.shixiansi.plugin-pomodoro' };
    llm = { ok: true, text: '这周挺安静的，慢慢来。', error: '' };
    await boot();

    const record = await tick();
    expect(record.source).toBe('model');
    expect(record.text).toContain('这周挺安静的');
    expect(record.text).toContain('这周没拿到专注数据');
    expect(record.text.length).toBeLessThanOrEqual(300);
  });
});

// --- 模型不可用 ---------------------------------------------------------------

describe('llm.chat 被拒：退回不用模型的模板周报', () => {
  test('ok:false 时说人话的那一份照旧出来，不崩、不空着', async () => {
    makeDue();
    llm = { ok: false, text: '', error: '模拟拒绝：未获权限 llm.chat' };
    await boot();

    const record = await tick();
    expect(record.source).toBe('template');
    expect(record.text.length).toBeGreaterThan(20);
    expect(record.text).toContain('12');      // 三个数都在
    expect(record.text).toContain('150');
    expect(record.text).toContain('2 篇');
    expect(record.text).toContain('本周');
    expect(llmCalls).toHaveLength(1);         // 试过一次，被拒就退，不反复重试
    expect(bubbles).toHaveLength(1);          // 气泡照样有
  });

  test('没授予 llm.chat 时一个模型请求都不发', async () => {
    makeDue();
    await boot({ granted: manifest.permissions.filter((p) => p !== 'llm.chat') });

    const record = await tick();
    expect(record.source).toBe('template');
    expect(llmCalls).toHaveLength(0);
    expect(record.text.length).toBeGreaterThan(0);
  });

  test('模型回一句空话也退回模板（不空着）', async () => {
    makeDue();
    llm = { ok: true, text: '   ', error: '' };
    await boot();

    const record = await tick();
    expect(record.source).toBe('template');
    expect(record.text.length).toBeGreaterThan(20);
  });
});

// --- 一天只生成一次 -----------------------------------------------------------

describe('20:00 只触发一次', () => {
  test('同一天重复判定不再生成、不再冒泡、不再反复开卡片', async () => {
    makeDue();
    configValues.useModel = 'false';
    await boot();

    const first = await tick();
    expect(first).toBeTruthy();
    const setsAfterFirst = storageSets.filter((k) => k === 'reports/latest').length;
    expect(setsAfterFirst).toBe(1);
    expect(bubbles).toHaveLength(1);
    // 20:00 那一份是这一周唯一的产品：冒一句气泡，再把卡片打开（后打开的那个留下）。
    const showsAfterFirst = requests().filter((r) => r.method === 'surface.show');
    expect(showsAfterFirst).toHaveLength(1);

    const second = await tick();
    const third = await tick();
    expect(second).toBeNull();
    expect(third).toBeNull();
    expect(storageSets.filter((k) => k === 'reports/latest')).toHaveLength(1);
    expect(bubbles).toHaveLength(1);
    expect(requests().filter((r) => r.method === 'surface.show')).toHaveLength(1);
    expect(api().snapshot().lastReportDay).toBe(todayKey());
  });

  test('跨过 20:00 之后重启：按 storage 里的 lastReportDay 去重', async () => {
    makeDue();
    configValues.useModel = 'false';
    // 模拟"上一次运行已经生成过今天这一份"。
    store.set('reports/latest', JSON.stringify({
      day: todayKey(), at: Date.now(), week: '10.26–11.01', text: '上一份。', source: 'template',
      numbers: {}, missing: [],
    }));
    store.set('state/last-report-day', JSON.stringify({ day: todayKey() }));
    await boot();

    const record = await tick();
    expect(record).toBeNull();
    expect(storageSets.filter((k) => k === 'reports/latest')).toHaveLength(0);
    expect(bubbles).toHaveLength(0);
    expect(requests().filter((r) => r.method === 'plugin.call')).toHaveLength(0);
  });

  test('不是配置的那一天：到点判定为假，什么都不做', async () => {
    makeNotDue();
    await boot();

    const record = await tick();
    expect(record).toBeNull();
    expect(requests().filter((r) => r.method === 'plugin.call')).toHaveLength(0);
    expect(storageSets).toHaveLength(0);
    expect(bubbles).toHaveLength(0);
  });

  test('气泡权限被拿走后照常生成，只是不冒泡', async () => {
    makeDue();
    configValues.useModel = 'false';
    await boot({ granted: manifest.permissions.filter((p) => p !== 'pet.bubble') });

    const record = await tick();
    expect(record).toBeTruthy();
    expect(bubbles).toHaveLength(0);
    expect(requests().some((r) => r.method === 'bubble.say')).toBe(false);
  });
});

// --- 字数上限 -----------------------------------------------------------------

describe('正文 ≤300 字，素材在喂模型之前就截断', () => {
  test('模型写了一千字，报告正文也只有 300 以内', async () => {
    makeDue();
    llm = { ok: true, text: '啰'.repeat(1000), error: '' };
    await boot();

    const record = await tick();
    expect(record.text.length).toBeLessThanOrEqual(300);
    expect(record.source).toBe('model');
  });

  test('模板那一份也在 300 以内（数字再大也一样）', async () => {
    makeDue();
    configValues.useModel = 'false';
    callReplies[TODO_KEY] = { result: { total: 999999, done: 888888, open: 111111, completionRate: 89, dueToday: 7 } };
    callReplies[FOCUS_KEY] = { result: { focusMinutesToday: 99999, focusSessions: 9999, focusSessionsTotal: 1 } };
    await boot();

    const record = await tick();
    expect(record.text.length).toBeLessThanOrEqual(300);
    expect(record.text).toContain('999999');
  });

  test('七篇五百字的日记：喂模型的素材被截在预算内，正文也 ≤300', async () => {
    makeDue();
    configValues.includeDiary = 'true';
    const days = thisWeekDays();
    callReplies[DIARY_KEY] = {
      result: {
        entries: days.map((day) => ({ day, mood: 'calm', text: '日'.repeat(500) })),
      },
    };
    await boot();

    const record = await tick();
    expect(record.text.length).toBeLessThanOrEqual(300);
    expect(llmCalls).toHaveLength(1);
    const prompt = llmCalls[0].text;
    // 素材在发出去之前就砍过了：500 字那一段不会整段出现在 prompt 里。
    expect(prompt).not.toContain('日'.repeat(200));
    expect(prompt.length).toBeLessThan(api().report.MATERIAL_BUDGET + 200);
    // buildPrompt 自己也知道它截过（这个标记是给调用方与用例的）。
    const built = api().report.buildPrompt(
      {
        range: api().week.weekRangeOf(Date.now()),
        numbers: { todoTotal: null, todoDone: null, todoOpen: null, todoRate: null, focusMinutes: null, focusSessions: null, diaryCount: 7 },
        missing: [],
        diary: days.map((day) => ({ day, mood: '', text: '日'.repeat(500) })),
      },
      true,
      300,
    );
    expect(built.truncated).toBe(true);
    expect(built.material.length).toBeLessThanOrEqual(api().report.MATERIAL_BUDGET);
  });
});

// --- 隐私：日记默认不进报告 -----------------------------------------------------

describe('日记默认不进报告（隐私取舍）', () => {
  test('默认那一份里没有日记正文，但有篇数', async () => {
    makeDue();
    configValues.useModel = 'false';
    await boot();

    const record = await tick();
    expect(record.numbers.diaryCount).toBe(2);
    expect(record.text).not.toContain('周一清了几件杂事');
    expect(record.text).not.toContain('周四把周报插件');
    expect(record.diaryIncluded).toBe(false);
  });

  test('勾了 includeDiary 才带一篇片段', async () => {
    makeDue();
    configValues.useModel = 'false';
    configValues.includeDiary = 'true';
    await boot();

    const record = await tick();
    expect(record.diaryIncluded).toBe(true);
    expect(record.text).toContain('周四把周报插件');
    expect(record.text.length).toBeLessThanOrEqual(300);
  });
});

// --- plugin.call --------------------------------------------------------------

describe('plugin.call：serves 只有 report / latest', () => {
  test('还没生成过任何一份时，latest 回 {text:"", at:0} 而不是报错', async () => {
    await boot();
    const take = callHost('latest', {});
    const packet = await take();
    expect(packet.ok).toBe(true);
    expect(packet.result).toEqual({ text: '', at: 0 });
  });

  test('report：现在生成一份并原样回给问的人', async () => {
    configValues.useModel = 'false';
    await boot();
    const take = callHost('report', {});
    const packet = await take();

    expect(packet.ok).toBe(true);
    expect(packet.result.text.length).toBeGreaterThan(0);
    expect(packet.result.at).toBeGreaterThan(0);
    expect(packet.result.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(packet.result.numbers.todoRate).toBe(58);
    expect(latest()).toBeTruthy();
  });

  test('latest 拿得到刚才那一份（含缺块清单与三个数）', async () => {
    configValues.useModel = 'false';
    callReplies[DIARY_KEY] = { ok: false, error: '问不到：未安装' };
    await boot();

    await (await callHost('report', {}))();
    const packet = await (await callHost('latest', {}))();

    expect(packet.ok).toBe(true);
    expect(packet.result.text).toContain('这周没拿到日记数据');
    expect(packet.result.missing).toHaveLength(1);
    expect(packet.result.missing[0].key).toBe('diary');
    expect(packet.result.at).toBeGreaterThan(0);
  });

  test('不认识的方法回一句中文，并且点名它会的那两个', async () => {
    await boot();
    const packet = await (await callHost('weekly', {}))();

    expect(packet.ok).toBe(false);
    expect(packet.error).toContain('weekly');
    expect(packet.error).toContain('report');
    expect(packet.error).toContain('latest');
    expect(packet.error).toMatch(/周报不认识/);
  });

  test('没授予 plugin.call 时 report 回一条说得清的错误，而不是静默', async () => {
    await boot({ granted: manifest.permissions.filter((p) => p !== 'plugin.call') });
    const packet = await (await callHost('report', {}))();

    expect(packet.ok).toBe(false);
    expect(packet.error).toContain('plugin.call');
    expect(storageSets.filter((k) => k === 'reports/latest')).toHaveLength(0);
  });
});

// --- 宿主拒绝一切 -------------------------------------------------------------

describe('宿主拒绝一切时', () => {
  test('不崩、不写数据，界面说清楚缺什么', async () => {
    denyEverything = true;
    await boot({ slot: 'card' });

    // 连"现在几点/星期几"都读不到（config.get 也被拒），所以直接驱动生成那一段。
    const running = api().generateReport();
    await drain(24);
    const record = await running;
    expect(runtimeErrors).toEqual([]);
    // 一个字节都没写进去（storage.set 全被拒）。
    expect(store.size).toBe(0);
    expect(bubbles).toHaveLength(0);
    // 报告仍然出得来（三块全缺），只是保存不下来。
    expect(record).toBeTruthy();
    expect(record.missing).toHaveLength(3);
    expect(record.text).toContain('这周没拿到待办数据');
    expect(record.text.length).toBeLessThanOrEqual(300);

    // 卡片那一面也一样：不缺行、不抛错。
    api().renderCard(record);
    expect(document.getElementById('card-missing').textContent).toBe('缺：待办、专注、日记');
    expect(document.getElementById('card-line').textContent.length).toBeGreaterThan(0);
  });

  test('拒绝一切之后 latest 仍然能从进程内那一份答上话', async () => {
    denyEverything = true;
    await boot();
    const first = await (await callHost('report', {}))();
    expect(first.ok).toBe(true);
    const second = await (await callHost('latest', {}))();
    expect(second.ok).toBe(true);
    expect(second.result.text.length).toBeGreaterThan(0);
    expect(store.size).toBe(0);
  });

  test('granted 是空的时候一个请求都不发', async () => {
    await boot({ granted: [] });
    expect(requests()).toHaveLength(0);
    expect(runtimeErrors).toEqual([]);
  });
});

// --- 插件页 ------------------------------------------------------------------

describe('控制中心插件页', () => {
  test('显示完整的一份、缺块那一行、以及三个来源各自的状态', async () => {
    store.set('reports/latest', JSON.stringify({
      day: todayKey(),
      at: new Date(2026, 10, 1, 20, 0, 0).getTime(),
      weekStart: '2026-10-26',
      weekEnd: '2026-11-01',
      week: '10.26–11.01',
      title: '周报 · 10.26–11.01',
      text: '本周（10.26–11.01）：待办共 12 件，完成 7 件。',
      source: 'template',
      summary: '待办过半。',
      missing: [{ key: 'focus', label: '专注', line: '这周没拿到专注数据（番茄钟插件没装或没启用）' }],
      numbers: { todoTotal: 12, todoDone: 7, todoOpen: 5, todoRate: 58, focusMinutes: null, focusSessions: null, diaryCount: 2 },
      diaryIncluded: false,
    }));
    await boot({ slot: 'workshop' });

    expect(document.getElementById('latest-title').textContent).toBe('周报 · 10.26–11.01');
    expect(document.getElementById('latest-text').textContent).toContain('待办共 12 件');
    expect(document.getElementById('latest-meta').textContent).toContain('模板');
    expect(document.getElementById('latest-meta').textContent).toMatch(/\d+ 字/);
    // 缺哪块不只在正文里：这一页自己有一行。
    expect(document.getElementById('latest-missing').textContent).toContain('这周没拿到专注数据');
    expect(document.getElementById('latest-missing').classList.contains('hidden')).toBe(false);

    const rows = [...document.querySelectorAll('#sources li')];
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('待办');
    expect(rows[0].textContent).toContain('12');
    expect(rows[1].textContent).toContain('这周没拿到专注数据');
    expect(rows[2].textContent).toContain('2');
    expect(rows[2].textContent).toContain('正文没进报告');
  });

  test('还没有任何一份时是空状态，不是一行报错', async () => {
    await boot({ slot: 'workshop' });
    expect(document.getElementById('latest-title').textContent).toBe('还没有周报');
    expect(document.getElementById('latest-text').textContent).toContain('桌宠');
    expect([...document.querySelectorAll('#sources li')]).toHaveLength(3);
  });
});
