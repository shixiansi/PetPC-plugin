import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 纪念日倒计时的行为测试：驱动的是 panel.html 里真实加载的那几支脚本。
//
// harness 与 calendar / imgbed 那几份同型：vitest 的 jsdom 全局 window 当作插件的 window，
// 拼起来的源码用 new Function 丢进一个新函数作用域（等于浏览器里那几支经典 script 共享一个
// 作用域），出站 postMessage 用 spy 记下来，宿主应答由 drain 循环发。
//
// 这个文件钉住的几件事（每一条都对应一次会静默出错的地方）：
//
//   1. manifest 的形状：五项权限、background 由 plugin.call 撑着、serves 只有 next、
//      三个设置项（bool / select / number），没有 secret 也没有 hostWhitelist（零网络）；
//   2. 日期：**本地**整天差（跨年 12-31 → 1-1 是 1 天）、**2 月 29 日只在闰年出现**
//      （2027-02-28 看它还有 366 天）、夏令时那两天不会把天数算错一位；
//   3. 当天：remaining === 0、文案里有「今天」、气泡**一天只弹一次**（重算不再弹）；
//   4. 徽标：≤16 个字（按码点）、离得太远就不占头顶、空清单一个 pet.badge 请求都不发；
//   5. plugin.call 的 next 形状，未知方法回一句中文而不是沉默；
//   6. 宿主拒绝一切：不崩、也不写数据。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-anniversary');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');
const source = scriptSources.map((src) => readFileSync(path.join(pluginDir, src), 'utf8')).join('\n');
// 纯函数那一层（lib/*.js）单独加载一次：日期逻辑要能直接喂日期字符串，不必绕一圈 DOM。
const libSource = scriptSources
  .filter((src) => src !== 'app.js')
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-anniversary';
const LIST_KEY = 'anniversary/list';
const SEEN_KEY = 'anniversary/seen';

// 两个宿主的能力表（手册 §9 那张表的子集）。workshop 里没有 bubble.say / surface.* /
// pet.badge / plugin.call —— 这一份就是"发出去会不会被拒"的答案。
const PET_METHODS = [
  'bubble.say',
  'config.get',
  'config.set',
  'pet.badge',
  'plugin.call',
  'storage.get',
  'storage.remove',
  'storage.set',
  'surface.blocks',
  'surface.hide',
  'surface.show',
];
const WORKSHOP_METHODS = ['config.get', 'config.set', 'plugins.services', 'storage.get', 'storage.remove', 'storage.set'];

// --- 纯函数那一层 ----------------------------------------------------------------

function loadLibs() {
  // eslint-disable-next-line no-new-func
  return new Function(`${libSource}\nreturn { Dates, Agenda };`)();
}

/** 本机日历上的"今天 + n 天"，写成 YYYY-MM-DD。测试自己算，不借被测算法的实现。 */
function isoInDays(n) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + n);
  const pad = (v) => (v < 10 ? '0' + v : String(v));
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function listJSON(items) {
  return JSON.stringify({ version: 1, items });
}

// --- harness -------------------------------------------------------------------

let store;
let configValues;
let bubbles;
let badges;
let surfaceCalls;
let answered;
let postedFrom;
let windowListeners;
let timeouts;
let runtimeErrors;
// 让 drain 把每一条请求都拒掉：用户把每一项授权都取消之后的形状。
let denyAll;

function posted() {
  return window.postMessage.mock.calls.map((call) => call[0]).slice(postedFrom);
}

function byType(type) {
  return posted().filter((m) => m && m.type === type);
}

function requests() {
  return byType('request').map((m) => ({ id: m.id, method: m.method, payload: m.payload }));
}

function methodCalls(method) {
  return requests().filter((r) => r.method === method);
}

function hostSends(data) {
  window.dispatchEvent(new MessageEvent('message', { data, source: window }));
}

function answer(id, result, { ok = true, error = '' } = {}) {
  answered.add(id);
  hostSends({ v: 1, type: 'response', id, ok, result, error });
}

/** 每拍把还没答的请求答掉，再让出一拍——握手之后的链条是"一个答复引出下一个请求"。 */
async function drain(rounds = 24) {
  for (let i = 0; i < rounds; i += 1) {
    for (const req of requests().filter((r) => !answered.has(r.id))) {
      const payload = req.payload || {};
      if (denyAll) {
        answer(req.id, null, { ok: false, error: `模拟拒绝：未获权限 ${req.method}` });
        continue;
      }
      switch (req.method) {
        case 'config.get':
          answer(req.id, { values: configValues, secrets: {} });
          break;
        case 'config.set':
          Object.assign(configValues, payload.values || {});
          answer(req.id, { ok: true });
          break;
        case 'storage.get':
          answer(req.id, { value: store.has(String(payload.key)) ? store.get(String(payload.key)) : '' });
          break;
        case 'storage.set':
          store.set(String(payload.key), String(payload.value ?? ''));
          answer(req.id, { ok: true });
          break;
        case 'storage.remove':
          store.delete(String(payload.key));
          answer(req.id, { ok: true });
          break;
        case 'bubble.say':
          bubbles.push(payload);
          answer(req.id, { ok: true });
          break;
        case 'pet.badge':
          badges.push(payload);
          answer(req.id, { text: payload.text });
          break;
        case 'surface.show':
        case 'surface.hide':
        case 'surface.blocks':
          surfaceCalls.push({ method: req.method, payload });
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
  for (const timer of timeouts) clearTimeout(timer.id);
  timeouts = [];
  postedFrom = window.postMessage.mock.calls.length;
  // eslint-disable-next-line no-new-func
  new Function(source)();
}

/** 装一份帧。slot 决定它是插件页、常驻帧，还是那块 280×132 的卡片。 */
async function boot({ slot = 'workshop', granted = manifest.permissions, config = {} } = {}) {
  Object.assign(configValues, config);
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
  loadApp();
  const surface =
    slot === 'surface'
      ? {
          kind: 'surface',
          rectIndex: 0,
          rectCount: 1,
          rect: { x: 0, y: 0, w: 280, h: 132, r: 14, tailX: 140, hidden: false, room: 160 },
        }
      : { kind: 'panel', slot };
  hostSends({
    v: 1,
    type: 'init',
    pluginId: PLUGIN_ID,
    permissions: manifest.permissions,
    granted: [...granted],
    surface,
    host: {
      program: slot === 'workshop' ? 'workshop' : 'pet',
      methods: slot === 'workshop' ? WORKSHOP_METHODS : PET_METHODS,
    },
  });
  await drain(10);
}

/** 往插件推一条 storage.changed（宿主发现私有目录变了就是这么说的）。 */
async function storageChanged(key = LIST_KEY) {
  hostSends({ v: 1, type: 'event', name: 'storage.changed', payload: { key, at: Date.now() } });
  await drain(10);
}

/** 走一次 plugin.call（宿主发 `call`，我们等 `call-result`）。 */
async function hostCall(method, payload) {
  const before = byType('call-result').length;
  const ticket = 't-' + Math.random().toString(36).slice(2, 8);
  hostSends({ v: 1, type: 'call', ticket, from: 'com.shixiansi.plugin-chat', method, payload });
  await drain(8);
  const list = byType('call-result').slice(before);
  expect(list.length, `plugin.call ${method} 一直没有回包`).toBeGreaterThan(0);
  return list[list.length - 1];
}

/** 触发一次用这个毫秒数登记的 setTimeout（卡片那 60 秒就是靠它）。 */
async function runTimeout(ms) {
  const hits = timeouts.filter((timer) => timer.ms === ms);
  expect(hits.length, `没有找到 ${ms}ms 的 setTimeout`).toBeGreaterThan(0);
  for (const timer of hits) {
    timeouts = timeouts.filter((item) => item !== timer);
    timer.fn();
  }
  await drain(8);
}

// 一次注册，多轮复用（数组本身在 beforeEach 里被换掉，所以监听器读到的永远是当前这一份）。
window.addEventListener('error', (event) => runtimeErrors.push(String(event.message || event.error)));
window.addEventListener('unhandledrejection', (event) =>
  runtimeErrors.push('unhandled: ' + String((event.reason && event.reason.message) || event.reason)),
);

beforeEach(() => {
  store = new Map();
  configValues = {
    sayOnDay: 'true',
    badgeMode: 'nearest',
    advanceDays: '30',
  };
  bubbles = [];
  badges = [];
  surfaceCalls = [];
  windowListeners = [];
  timeouts = [];
  runtimeErrors = [];
  denyAll = false;

  const originalAdd = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(function (type, fn, opts) {
    windowListeners.push([type, fn, opts]);
    return originalAdd(type, fn, opts);
  });
  const originalTimeout = window.setTimeout.bind(window);
  // 只记账，不拦：vitest 自己的"测试超时"也走 setTimeout，把整套语义换掉会让挂住的用例永远不超时。
  // 记下 fn 与 ms 是为了让用例按需触发那一拍（否则卡片那次 60 秒的延迟只能靠真实时钟等）。
  vi.spyOn(window, 'setTimeout').mockImplementation((fn, ms, ...rest) => {
    const id = originalTimeout(fn, ms, ...rest);
    timeouts.push({ id, fn, ms: Number(ms) });
    return id;
  });
  // 定时器**只记录不创建**：每一拍由用例按需触发，结果不会因为真实时钟而漂。
  vi.spyOn(window, 'setInterval').mockImplementation((fn, ms) => 8000 + ms);
  vi.spyOn(window, 'clearInterval').mockImplementation(() => {});
  vi.spyOn(window, 'postMessage').mockImplementation(() => {});
});

afterEach(() => {
  for (const timer of timeouts) clearTimeout(timer.id);
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  vi.restoreAllMocks();
});

// --- manifest ------------------------------------------------------------------

describe('manifest', () => {
  test('asks for exactly the five permissions it uses, and plugin.call is what fills the headless frame', () => {
    expect([...manifest.permissions].sort()).toEqual([
      'pet.bubble',
      'pet.surface',
      'plugin.call',
      'plugin.config',
      'storage',
    ]);
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.author).toBe('shixiansi');
    expect(Array.from(manifest.description).length).toBeLessThanOrEqual(512);
    // 常驻帧靠 plugin.call 撑着：别的插件问 next 时得有人答，而头顶那行字也是它推的。
    expect(manifest.background).toBe(true);
    expect(manifest.serves).toEqual(['next']);
    // serves 里点名的必须正好是实现了的那一个；反过来没实现的方法会把调用方吊到 30 秒超时。
    expect(manifest.callTargets).toBeUndefined();
  });

  test('zero network: no netHosts, no secret, no hostWhitelist', () => {
    expect(manifest.netHosts).toBeUndefined();
    expect(manifest.permissions).not.toContain('net.fetch');
    expect(manifest.config.filter((item) => item.secret === true)).toHaveLength(0);
    expect(manifest.config.filter((item) => item.hostWhitelist === true)).toHaveLength(0);
  });

  test('the three settings: say it out loud, what the badge shows, how early it starts', () => {
    const byKey = new Map(manifest.config.map((item) => [item.key, item]));
    expect(byKey.get('sayOnDay').type).toBe('bool');
    expect(byKey.get('sayOnDay').default).toBe('true');
    const mode = byKey.get('badgeMode');
    expect(mode.type).toBe('select');
    expect(mode.default).toBe('nearest');
    expect(mode.options.map((option) => option.value)).toEqual(['nearest', 'count']);
    const advance = byKey.get('advanceDays');
    expect(advance.type).toBe('number');
    expect(advance.default).toBe('30');
  });

  test('one compact surface card, and every file the page loads ships in the package', () => {
    expect(manifest.surface).toHaveLength(1);
    const rect = manifest.surface[0];
    expect(rect.w).toBe(280);
    expect(rect.h).toBe(132);
    expect(rect.radius).toBe(14);
    // 内容真装不下时要能请求长高；宿主只对声明了 maxH 的块应用 sizes（手册 8.2）。
    expect(rect.maxH).toBeGreaterThan(rect.h);

    const fixed = ['panel.html', 'app.js', 'style.css'];
    for (const src of scriptSources) {
      if (fixed.includes(src)) continue;
      expect(manifest.assets, `${src} 没写进 assets`).toContain(src);
    }
    for (const asset of manifest.assets) {
      expect(existsSync(path.join(pluginDir, asset)), `manifest.assets 里的 ${asset} 不存在`).toBe(true);
    }
    expect(existsSync(path.join(pluginDir, manifest.entry))).toBe(true);
  });
});

// --- 日期：本地整天差、跨年、2 月 29 日 ----------------------------------------------

describe('dates', () => {
  const { Dates } = loadLibs();

  test('12 月 31 日距 1 月 1 日是 1 天（不是 0，也不是 365）', () => {
    expect(Dates.dayDiff('2026-12-31', '2027-01-01')).toBe(1);
    // 同一天是 0，这是"今天"的判据。
    expect(Dates.dayDiff('2026-12-31', '2026-12-31')).toBe(0);
    expect(Dates.dayDiff('2027-01-01', '2026-12-31')).toBe(-1);
  });

  test('两个方向、跨年的整月整年都对得上', () => {
    expect(Dates.dayDiff('2026-01-01', '2027-01-01')).toBe(365);
    expect(Dates.dayDiff('2028-01-01', '2029-01-01')).toBe(366); // 2028 是闰年
    expect(Dates.dayDiff('2026-05-02', '2026-07-01')).toBe(60);
  });

  test('夏令时那两天不会把天数算错一位（两边都归一到本地 00:00 再相减）', () => {
    // 这三段跨过北半球/南半球常见的切换日：任何一天按 23/25 小时算，floor 都会差一。
    expect(Dates.dayDiff('2026-03-01', '2026-04-01')).toBe(31);
    expect(Dates.dayDiff('2026-10-01', '2026-11-01')).toBe(31);
    expect(Dates.dayDiff('2026-03-08', '2026-03-09')).toBe(1);
    expect(Dates.dayDiff('2026-11-01', '2026-11-02')).toBe(1);
  });

  test('2 月 29 日只在闰年出现：平年跳过那一年，从 2027-02-28 看它还有 366 天', () => {
    // 这条是那句规则的可执行版本：**平年的 2 月 29 日当年不出现**（不折算到 3 月 1 日）。
    expect(Dates.isLeapYear(2028)).toBe(true);
    expect(Dates.isLeapYear(2027)).toBe(false);
    expect(Dates.parts('2027-02-29')).toBeNull(); // 平年里这个日期根本不存在
    expect(Dates.nextYearly('2027-02-28', 2, 29)).toBe('2028-02-29');
    expect(Dates.dayDiff('2027-02-28', '2028-02-29')).toBe(366);
    // 平年的 2 月 28 日之后不是 3 月 1 日，而是下一个 2 月 29 日。
    expect(Dates.nextYearly('2027-03-01', 2, 29)).toBe('2028-02-29');
    // 闰年里它就是普通的一天：前一天 1 天、当天 0 天。
    expect(Dates.nextYearly('2028-02-28', 2, 29)).toBe('2028-02-29');
    expect(Dates.nextYearly('2028-02-29', 2, 29)).toBe('2028-02-29');
    // 过了闰年那一天，下一次就得等下一个闰年。
    expect(Dates.nextYearly('2028-03-01', 2, 29)).toBe('2032-02-29');
  });

  test('世纪年不闰的日子也跨得过去（1900 / 2100 不是闰年）', () => {
    expect(Dates.isLeapYear(1900)).toBe(false);
    expect(Dates.isLeapYear(2000)).toBe(true);
    expect(Dates.isLeapYear(2100)).toBe(false);
    expect(Dates.nextYearly('2099-02-28', 2, 29)).toBe('2104-02-29');
  });

  test('普通日期：当天算当天，过了就是明年', () => {
    expect(Dates.nextYearly('2026-05-10', 5, 10)).toBe('2026-05-10');
    expect(Dates.nextYearly('2026-05-09', 5, 10)).toBe('2026-05-10');
    expect(Dates.nextYearly('2026-05-11', 5, 10)).toBe('2027-05-10');
    expect(Dates.nextYearly('2026-12-31', 1, 1)).toBe('2027-01-01');
  });
});

// --- 清单与视图模型 -------------------------------------------------------------

describe('agenda', () => {
  const { Dates, Agenda } = loadLibs();

  test('排序：还没到的在前（最近的先），已经过去的在后（刚过去的先），nearest 是下一个', () => {
    const list = [
      { name: '昨天过的', date: '2026-05-01', yearly: false },
      { name: '一个月后', date: '2026-06-01', yearly: false },
      { name: '八天后', date: '2026-05-10', yearly: false },
    ];
    const agenda = Agenda.build(list, '2026-05-02');
    expect(agenda.items.map((row) => row.name)).toEqual(['八天后', '一个月后', '昨天过的']);
    expect(agenda.nearest.name).toBe('八天后');
    expect(agenda.nearest.days).toBe(8);
    expect(agenda.nearest.text).toBe('八天后 · 还有 8 天');
    // remaining 是 days 的同义词：卡片按它说话，plugin.call 的消费方按 days 读。
    expect(agenda.nearest.remaining).toBe(agenda.nearest.days);
    expect(agenda.items[2].days).toBe(-1);
    expect(agenda.items[2].text).toBe('昨天过的 · 已过 1 天');
  });

  test('当天：remaining === 0，文案里有「今天」', () => {
    const agenda = Agenda.build([{ name: '母亲节', date: '2026-05-10', yearly: true }], '2026-05-10');
    expect(agenda.items).toHaveLength(1);
    expect(agenda.items[0].remaining).toBe(0);
    expect(agenda.items[0].days).toBe(0);
    expect(agenda.items[0].text).toContain('今天');
    expect(Agenda.bubbleText(agenda)).toContain('今天');
    expect(Agenda.bubbleText(agenda)).toContain('母亲节');
  });

  test('空清单：没有 nearest、没有徽标、没有话说', () => {
    const agenda = Agenda.build([], '2026-05-02');
    expect(agenda.items).toEqual([]);
    expect(agenda.nearest).toBeNull();
    expect(agenda.total).toBe(0);
    expect(Agenda.badgeText(agenda, 'nearest', 30)).toBe('');
    expect(Agenda.badgeText(agenda, 'count', 30)).toBe('');
    expect(Agenda.bubbleText(agenda)).toBe('');
  });

  test('徽标不超过 16 个字（按码点），离得太远就不占头顶', () => {
    const long = '一个特别特别特别长的纪念日名字';
    const near = Agenda.build([{ name: long, date: '2026-05-10', yearly: true }], '2026-05-02');
    const text = Agenda.badgeText(near, 'nearest', 30);
    expect(Array.from(text).length).toBeLessThanOrEqual(Agenda.BADGE_MAX);
    expect(Array.from(text).length).toBeLessThanOrEqual(16); // 宿主 app_pet_badge.go 的 MaxBadgeRunes
    expect(text.endsWith('…')).toBe(true);

    // 40 天之外：不占徽标（空串 = 清除）。
    const far = Agenda.build([{ name: '远', date: '2026-06-11', yearly: true }], '2026-05-02');
    expect(Agenda.badgeText(far, 'nearest', 30)).toBe('');
    expect(Agenda.badgeText(far, 'nearest', 60)).toBe('远 还有 40 天');
    // 全部条数那一档说的是"有几条"，不是"最近的那个"。
    expect(Agenda.badgeText(far, 'count', 30)).toBe('纪念日 1 个');
  });

  test('2 月 29 日那一条：平年不出现，下一次按下一个闰年算', () => {
    const list = [{ name: '闰年生日', date: '2024-02-29', yearly: true }];
    const at2027 = Agenda.build(list, '2027-02-28');
    expect(at2027.items[0].date).toBe('2028-02-29');
    expect(at2027.items[0].remaining).toBe(366);
    // 平年的 2 月 28 日当天不算"今天"——那个日子今年不存在。
    expect(at2027.items[0].remaining).not.toBe(0);
    const at2028 = Agenda.build(list, '2028-02-29');
    expect(at2028.items[0].remaining).toBe(0);
  });

  test('坏数据当"没有这一条"，不让一屏报错把用户挡在外面', () => {
    expect(Agenda.parseList('')).toEqual([]);
    expect(Agenda.parseList('not json')).toEqual([]);
    expect(Agenda.parseList('{"items":[{"name":"","date":"2026-05-10"}]}')).toEqual([]);
    expect(Agenda.parseList('{"items":[{"name":"a","date":"2026-02-30"}]}')).toEqual([]);
    expect(Agenda.parseList('{"items":[{"name":"a","date":"2027-02-29"}]}')).toEqual([]);
    // 也认"直接一个数组"这种老形状。
    expect(Agenda.parseList('[{"name":"a","date":"2026-05-10","yearly":true}]')).toEqual([
      { name: 'a', date: '2026-05-10', yearly: true },
    ]);
    // 往返：写出去再读回来是同一份。
    const list = [{ name: '母亲节', date: '2026-05-10', yearly: true }];
    expect(Agenda.parseList(Agenda.serializeList(list))).toEqual(list);
    expect(Dates.parts('2026-05-10')).toEqual({ y: 2026, m: 5, d: 10 });
  });
});

// --- 握手与主路径 ---------------------------------------------------------------

test('握手：ready → init 之后 granted 装上，常驻帧读一次设置与清单', async () => {
  store.set(LIST_KEY, listJSON([{ name: '母亲节', date: isoInDays(8), yearly: true }]));
  await boot({ slot: 'background' });

  expect(byType('ready')).toHaveLength(1);
  const methods = requests().map((req) => req.method);
  expect(methods).toContain('config.get');
  expect(methods).toContain('storage.get');
  expect(methodCalls('storage.get')[0].payload.key).toBe(LIST_KEY);
  // 没有订阅事件（manifest 没有 events 授权），也没有任何被拒的调用。
  expect(methods).not.toContain('events.subscribe');
  expect(byType('request').every((req) => PET_METHODS.includes(req.method))).toBe(true);
});

test('还有 8 天：头顶就是「母亲节 还有 8 天」，没有气泡', async () => {
  store.set(LIST_KEY, listJSON([{ name: '母亲节', date: isoInDays(8), yearly: true }]));
  await boot({ slot: 'background' });

  expect(badges).toHaveLength(1);
  expect(badges[0].text).toBe('母亲节 还有 8 天');
  expect(Array.from(badges[0].text).length).toBeLessThanOrEqual(16);
  expect(bubbles).toHaveLength(0);
  // 没到当天就不该弹卡片。
  expect(surfaceCalls).toHaveLength(0);
});

test('当天：徽标换成「今天」，气泡说一句，重复重算不再弹', async () => {
  store.set(LIST_KEY, listJSON([{ name: '母亲节', date: isoInDays(0), yearly: true }]));
  await boot({ slot: 'background' });

  expect(badges).toHaveLength(1);
  expect(badges[0].text).toBe('今天 母亲节');
  expect(bubbles).toHaveLength(1);
  expect(bubbles[0].text).toContain('今天');
  expect(bubbles[0].text).toContain('母亲节');
  // 记账落在 storage 里：跨重启也认，所以重启之后不会再弹一次。
  expect(JSON.parse(store.get(SEEN_KEY)).day).toBe(isoInDays(0));

  // 主路径的重算（宿主说"你的目录变了"）不该再说第二遍，也不该重推同一行徽标。
  await storageChanged();
  await storageChanged();
  expect(bubbles).toHaveLength(1);
  expect(badges).toHaveLength(1);
});

test('当天说完那句之后一分钟，卡片自己摊开一次（气泡与浮层面同一时刻只能有一个）', async () => {
  store.set(LIST_KEY, listJSON([{ name: '母亲节', date: isoInDays(0), yearly: true }]));
  await boot({ slot: 'background' });
  expect(bubbles).toHaveLength(1);
  expect(surfaceCalls).toHaveLength(0);

  await runTimeout(60000);
  expect(surfaceCalls).toHaveLength(1);
  expect(surfaceCalls[0].method).toBe('surface.show');
});

test('卡片那一面：最近三条，带「名称 · 还有 N 天」，空清单是空状态', async () => {
  store.set(
    LIST_KEY,
    listJSON([
      { name: '八天后', date: isoInDays(8), yearly: true },
      { name: '一个月后', date: isoInDays(30), yearly: true },
      { name: '三个月后', date: isoInDays(90), yearly: true },
      { name: '半年后', date: isoInDays(180), yearly: true },
    ]),
  );
  await boot({ slot: 'surface' });

  const rows = [...document.querySelectorAll('#sf-rows .sf-row')];
  expect(rows).toHaveLength(3); // 固定矩形只放得下三条
  expect(rows[0].querySelector('.sf-name').textContent).toBe('八天后');
  expect(rows[0].querySelector('.sf-when').textContent).toBe('还有 8 天');
  expect(document.getElementById('sf-count').textContent).toBe('共 4 条');
  expect(document.getElementById('sf-empty').classList.contains('hidden')).toBe(true);
  // 卡片只是视图：不推徽标、不说话（那是常驻帧的活）。
  expect(badges).toHaveLength(0);
  expect(bubbles).toHaveLength(0);
});

test('空清单：界面上是空状态，一个 bubble / badge 请求都不发', async () => {
  await boot({ slot: 'background' });
  expect(methodCalls('bubble.say')).toHaveLength(0);
  expect(methodCalls('pet.badge')).toHaveLength(0);
  expect(bubbles).toHaveLength(0);
  expect(badges).toHaveLength(0);

  await boot({ slot: 'surface' });
  expect(document.getElementById('sf-empty').classList.contains('hidden')).toBe(false);
  expect(document.getElementById('sf-empty').textContent).toContain('还没有纪念日');
  expect(document.getElementById('sf-rows').classList.contains('hidden')).toBe(true);

  await boot({ slot: 'workshop' });
  expect(document.getElementById('ws-empty').classList.contains('hidden')).toBe(false);
  expect(document.getElementById('ws-list').classList.contains('hidden')).toBe(true);
  expect(methodCalls('pet.badge')).toHaveLength(0);
});

// --- 控制中心那一面 -------------------------------------------------------------

test('插件页：加一条会写进 storage，删一条会写回一份更短的清单', async () => {
  await boot({ slot: 'workshop' });
  document.getElementById('ws-name').value = '母亲节';
  document.getElementById('ws-date').value = '2026-05-10';
  document.getElementById('ws-yearly').checked = true;
  document.getElementById('ws-add').click();
  await drain(10);

  const saved = JSON.parse(store.get(LIST_KEY));
  expect(saved.items).toEqual([{ name: '母亲节', date: '2026-05-10', yearly: true }]);
  const rows = [...document.querySelectorAll('#ws-list .ws-row')];
  expect(rows).toHaveLength(1);
  expect(rows[0].querySelector('.ws-name').textContent).toBe('母亲节');
  expect(rows[0].querySelector('.ws-meta').textContent).toContain('每年 5 月 10 日');
  expect(document.getElementById('ws-status').textContent).toContain('加好了');

  rows[0].querySelector('[data-remove]').click();
  await drain(10);
  expect(JSON.parse(store.get(LIST_KEY)).items).toEqual([]);
  expect(document.getElementById('ws-empty').classList.contains('hidden')).toBe(false);
  // 这一面从不碰桌宠专属能力（workshop 里它们会被拒，且会在日志里留一行 WARN）。
  expect(requests().every((req) => WORKSHOP_METHODS.includes(req.method))).toBe(true);
});

test('插件页：没选日期时先说清楚，而且什么都不写；2 月 29 日的规则写在表单上', async () => {
  await boot({ slot: 'workshop' });
  document.getElementById('ws-name').value = '闰年生日';
  // jsdom（和真浏览器的日期控件一样）不会接受 2027-02-29：平年里这一天不存在，value 直接被清空。
  document.getElementById('ws-date').value = '2027-02-29';
  document.getElementById('ws-add').click();
  await drain(6);

  expect(document.getElementById('ws-status').textContent).toContain('日期');
  expect(store.has(LIST_KEY)).toBe(false);
  // 用户要写"每年 2 月 29 日"时，能读到的规则就在表单上（选了哪个方案也要写在看得见的地方）。
  const hint = [...document.querySelectorAll('#workshop .field-sub')].map((node) => node.textContent).join(' ');
  expect(hint).toContain('2 月 29 日');
  expect(hint).toContain('闰年');
  // 写成一个真的闰年就通过——那正是这条规则的正常用法。
  document.getElementById('ws-date').value = '2028-02-29';
  document.getElementById('ws-add').click();
  await drain(10);
  expect(JSON.parse(store.get(LIST_KEY)).items).toEqual([{ name: '闰年生日', date: '2028-02-29', yearly: true }]);
});

test('插件页没有 storage 授权时：说清楚、不写、也不硬发请求', async () => {
  await boot({ slot: 'workshop', granted: ['plugin.config'] });
  expect(document.getElementById('ws-bad').classList.contains('hidden')).toBe(false);
  expect(document.getElementById('ws-bad').textContent).toContain('storage');
  expect(document.getElementById('ws-add').disabled).toBe(true);
  expect(methodCalls('storage.get')).toHaveLength(0);
});

// --- plugin.call ---------------------------------------------------------------

test('plugin.call next：形状是 {items, nearest}，每一行带 name / date / days / text', async () => {
  store.set(
    LIST_KEY,
    listJSON([
      { name: '八天后', date: isoInDays(8), yearly: true },
      { name: '昨天过的', date: isoInDays(-1), yearly: false },
    ]),
  );
  await boot({ slot: 'background' });
  const packet = await hostCall('next', {});

  expect(packet.ok).toBe(true);
  const result = packet.result;
  expect(Array.isArray(result.items)).toBe(true);
  expect(result.items).toHaveLength(2);
  expect(result.items[0]).toMatchObject({
    name: '八天后',
    date: isoInDays(8),
    days: 8,
    remaining: 8,
    yearly: true,
    text: '八天后 · 还有 8 天',
  });
  expect(result.nearest.name).toBe('八天后');
  expect(result.nearest.days).toBe(8);
  expect(result.count).toBe(2);
  expect(result.today).toBe(isoInDays(0));
  // 已经过去的那一条也还在（用户可能想回头看），排在后面。
  expect(result.items[1].days).toBe(-1);
});

test('plugin.call 问一个不存在的方法：回一条说得清的中文，不是沉默', async () => {
  store.set(LIST_KEY, listJSON([{ name: '母亲节', date: isoInDays(8), yearly: true }]));
  await boot({ slot: 'background' });
  const packet = await hostCall('tomorrow', {});

  expect(packet.ok).toBe(false);
  expect(packet.error).toContain('tomorrow');
  expect(packet.error).toContain('next');
});

// --- 宿主拒绝一切 ---------------------------------------------------------------

test('宿主拒绝一切：不崩，也不写任何数据', async () => {
  store.set(LIST_KEY, listJSON([{ name: '母亲节', date: isoInDays(0), yearly: true }]));
  denyAll = true;
  await boot({ slot: 'background' });
  await storageChanged();
  expect(runtimeErrors).toEqual([]);
  // 一个字节都没落地：清单还在原地，"当天说过"的记号没被写出来。
  expect([...store.keys()]).toEqual([LIST_KEY]);

  await boot({ slot: 'workshop' });
  document.getElementById('ws-name').value = '母亲节';
  document.getElementById('ws-date').value = '2026-05-10';
  document.getElementById('ws-add').click();
  await drain(10);
  expect(runtimeErrors).toEqual([]);
  expect([...store.keys()]).toEqual([LIST_KEY]);
  // 界面进入可理解的降级态（读失败 ≠ 你还没有纪念日）。
  expect(document.getElementById('ws-bad').classList.contains('hidden')).toBe(false);
});
