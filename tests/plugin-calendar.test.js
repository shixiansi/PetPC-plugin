import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 日程日历插件的行为测试：驱动的是 panel.html 里真实加载的那几支脚本。
//
// harness 与 imgbed / rss-reader 那几份同型：vitest 的 jsdom 全局 window 当作插件的 window，
// 拼起来的源码用 new Function 丢进一个新函数作用域（等于浏览器里那几支经典 script 共享一个
// 作用域），出站 postMessage 用 spy 记下来，宿主应答由 drain 循环发。
//
// 这个文件钉住的几件事（每一条都对应一次真实的失败形态）：
//
//   1. manifest 的七项权限、background 由 plugin.call 撑着、订阅地址是 hostWhitelist 项；
//   2. ICS 解析：单次（TZID=Asia/Shanghai）、每日重复（RRULE:FREQ=DAILY）、跨时区
//      （TZID=America/New_York 换算成绝对时刻）——断言的是 epoch 毫秒，与跑测试这台机器的
//      时区无关；
//   3. 断网时仍能出"今天有什么"，而且界面**自己说**这是缓存；
//   4. 提醒只发一次；
//   5. plugin.call 的 today / next / agenda 形状，以及未知方法回一句中文而不是沉默；
//   6. 没填地址时一个 net.fetch 都不发；
//   7. 控制中心那一面不碰桌宠专属能力，并写明"提醒在桌宠上"。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-calendar');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');
const source = scriptSources.map((src) => readFileSync(path.join(pluginDir, src), 'utf8')).join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-calendar';
const GOOGLE_URL = 'https://calendar.google.com/calendar/ical/pet%40example/basic.ics';

// 两个宿主的能力表（手册 §9 那张表的子集）。workshop 里没有 bubble.say / surface.* /
// events.subscribe / plugin.call —— 这一份就是"发出去会不会被拒"的答案。
const PET_METHODS = [
  'bubble.say',
  'config.get',
  'config.set',
  'events.subscribe',
  'net.fetch',
  'pet.badge',
  'plugin.call',
  'storage.get',
  'storage.remove',
  'storage.set',
  'surface.blocks',
  'surface.hide',
  'surface.show',
];
const WORKSHOP_METHODS = [
  'config.get',
  'config.set',
  'net.fetch',
  'plugins.services',
  'storage.get',
  'storage.remove',
  'storage.set',
];

// --- ICS 样本 -------------------------------------------------------------------

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/** 一个本机时刻 → ICS 的 UTC 写法（"20261105T060000Z"）：值本身与时区无关。 */
function icsUtc(date) {
  return (
    date.getUTCFullYear() +
    pad2(date.getUTCMonth() + 1) +
    pad2(date.getUTCDate()) +
    'T' +
    pad2(date.getUTCHours()) +
    pad2(date.getUTCMinutes()) +
    pad2(date.getUTCSeconds()) +
    'Z'
  );
}

function localAt(hours, minutes, dayOffset = 0) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hours, minutes, 0, 0);
}

function icsDoc(bodies) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PetPC//calendar test//EN', ...bodies, 'END:VCALENDAR', ''].join(
    '\r\n',
  );
}

function icsEvent(lines) {
  return ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
}

/**
 * 三条真样本。时刻都用 TZID 或 Z 写，因为那正是"日历导出"的样子：
 *   ① 上海 14:00  = 06:00 UTC
 *   ② 上海 09:00 每日站会（RRULE:FREQ=DAILY）
 *   ③ 纽约 14:00  = 19:00 UTC（2026-11-05 已在 EST，UTC-5），并且 SUMMARY 被折了行
 */
const ICS_PARSING = icsDoc([
  ...icsEvent([
    'UID:single-1@test',
    'DTSTAMP:20261101T000000Z',
    'DTSTART;TZID=Asia/Shanghai:20261105T140000',
    'DTEND;TZID=Asia/Shanghai:20261105T150000',
    'SUMMARY:产品评审',
    'LOCATION:三楼会议室',
  ]),
  ...icsEvent([
    'UID:daily-1@test',
    'DTSTART;TZID=Asia/Shanghai:20261102T090000',
    'DTEND;TZID=Asia/Shanghai:20261102T091500',
    'RRULE:FREQ=DAILY',
    'SUMMARY:站会',
  ]),
  ...icsEvent([
    'UID:ny-1@test',
    'DTSTART;TZID=America/New_York:20261105T140000',
    'DTEND;TZID=America/New_York:20261105T150000',
    // 折行是这个格式的常态：续行以空格开头，解开之后才是完整标题。
    'SUMMARY:纽约那边的',
    ' 一对一',
  ]),
]);

/** 今天的两场（00:05 与 23:59），用来验"今天有什么"。 */
function todayFeed() {
  const early = localAt(0, 5);
  const late = localAt(23, 59);
  return icsDoc([
    ...icsEvent([
      'UID:today-early@test',
      'DTSTART:' + icsUtc(early),
      'DTEND:' + icsUtc(new Date(early.getTime() + 30 * 60000)),
      'SUMMARY:今天的早会',
    ]),
    ...icsEvent([
      'UID:today-late@test',
      'DTSTART:' + icsUtc(late),
      'DTEND:' + icsUtc(new Date(late.getTime() + 30 * 60000)),
      'SUMMARY:今天的总结',
    ]),
  ]);
}

/** 只有一场，开始于 minutes 分钟之后。 */
function upcomingFeed(minutes, title = '快到了的评审') {
  const start = new Date(Date.now() + minutes * 60000);
  start.setSeconds(0, 0);
  return icsDoc([
    ...icsEvent([
      'UID:upcoming-1@test',
      'DTSTART:' + icsUtc(start),
      'DTEND:' + icsUtc(new Date(start.getTime() + 45 * 60000)),
      'SUMMARY:' + title,
    ]),
  ]);
}

// --- harness -------------------------------------------------------------------

let store;
let configValues;
let fetchCalls;
let fetchReplies;
let fetchBody;
let bubbles;
let answered;
let postedFrom;
let windowListeners;
let timeouts;
let intervals;
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

function hostSends(data) {
  window.dispatchEvent(new MessageEvent('message', { data, source: window }));
}

function answer(id, result, { ok = true, error = '' } = {}) {
  answered.add(id);
  hostSends({ v: 1, type: 'response', id, ok, result, error });
}

function fetchReplyFor() {
  if (fetchReplies.length) {
    const next = fetchReplies.shift();
    return typeof next === 'function' ? next() : next;
  }
  return { status: 200, body: fetchBody };
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
        case 'net.fetch':
          fetchCalls.push(payload);
          answer(req.id, fetchReplyFor());
          break;
        case 'events.subscribe':
          answer(req.id, payload.names || []);
          break;
        case 'bubble.say':
          bubbles.push(payload);
          answer(req.id, { ok: true });
          break;
        case 'surface.show':
        case 'surface.hide':
        case 'surface.blocks':
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
  for (const id of timeouts) clearTimeout(id);
  timeouts = [];
  postedFrom = window.postMessage.mock.calls.length;
  // eslint-disable-next-line no-new-func
  new Function(source)();
}

/** 装一份帧。slot 决定它是插件页、常驻帧，还是那块 300×132 的卡片。 */
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
          rect: { x: 0, y: 0, w: 300, h: 132, r: 14, tailX: 150, hidden: false, room: 160 },
        }
      : { kind: 'panel', slot };
  hostSends({
    v: 1,
    type: 'init',
    pluginId: PLUGIN_ID,
    permissions: manifest.permissions,
    granted: [...granted],
    surface,
    host: { program: slot === 'workshop' ? 'workshop' : 'pet', methods: slot === 'workshop' ? WORKSHOP_METHODS : PET_METHODS },
  });
  await drain(10);
}

/** 走一次 plugin.call（宿主发 `call`，我们等 `call-result`）。 */
async function hostCall(method, payload) {
  const before = byType('call-result').length;
  const ticket = 't-' + Math.random().toString(36).slice(2, 8);
  hostSends({ v: 1, type: 'call', ticket, from: 'com.shixiansi.plugin-todo', method, payload });
  await drain(8);
  const list = byType('call-result').slice(before);
  expect(list.length, `plugin.call ${method} 一直没有回包`).toBeGreaterThan(0);
  return list[list.length - 1];
}

/** 手动走一拍定时器（间隔由真实代码声明，测试只负责"到点了"）。 */
async function runTick(ms = 20000) {
  const timer = intervals.find((item) => item.ms === ms);
  expect(timer, `没有找到 ${ms}ms 的定时器`).toBeTruthy();
  timer.fn();
  await drain(8);
}

function seedFeed(ics, fetchedAt = Date.now()) {
  store.set('feed/ics', ics);
  store.set('feed/meta', JSON.stringify({ fetchedAt, url: GOOGLE_URL, events: 0 }));
}

// 一次注册，多轮复用（数组本身在 beforeEach 里被换掉，所以监听器读到的永远是当前这一份）。
window.addEventListener('error', (event) => runtimeErrors.push(String(event.message || event.error)));
window.addEventListener('unhandledrejection', (event) =>
  runtimeErrors.push('unhandled: ' + String((event.reason && event.reason.message) || event.reason)),
);

beforeEach(() => {
  store = new Map();
  configValues = {
    calendarUrl: GOOGLE_URL,
    remindMinutes: '10',
    remindEnabled: 'true',
  };
  fetchCalls = [];
  fetchReplies = [];
  fetchBody = todayFeed();
  bubbles = [];
  windowListeners = [];
  timeouts = [];
  intervals = [];
  runtimeErrors = [];
  denyAll = false;

  const originalAdd = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(function (type, fn, opts) {
    windowListeners.push([type, fn, opts]);
    return originalAdd(type, fn, opts);
  });
  const originalTimeout = window.setTimeout.bind(window);
  // 只记账，不拦：vitest 自己的"测试超时"也走 setTimeout，把整套语义换掉会让挂住的用例
  // 永远不超时。所以 defer 一次原始实现，其余原样放行。
  vi.spyOn(window, 'setTimeout').mockImplementation((fn, ms, ...rest) => {
    const id = originalTimeout(fn, ms, ...rest);
    timeouts.push(id);
    return id;
  });
  // 定时器**只记录不创建**：这样每一拍都由测试按需触发，用例不会因为真实时钟而漂。
  vi.spyOn(window, 'setInterval').mockImplementation((fn, ms) => {
    const id = 9000 + intervals.length;
    intervals.push({ id, ms, fn });
    return id;
  });
  vi.spyOn(window, 'clearInterval').mockImplementation(() => {});
  vi.spyOn(window, 'postMessage').mockImplementation(() => {});
});

afterEach(() => {
  for (const id of timeouts) clearTimeout(id);
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  vi.restoreAllMocks();
});

// --- manifest ------------------------------------------------------------------

describe('manifest', () => {
  test('asks for exactly the seven permissions it uses', () => {
    expect([...manifest.permissions].sort()).toEqual([
      'events',
      'net.fetch',
      'pet.bubble',
      'pet.surface',
      'plugin.call',
      'plugin.config',
      'storage',
    ]);
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.author).toBe('shixiansi');
    // 常驻帧靠 plugin.call 撑着：别的插件半夜问"今天有什么"，得有人答。
    expect(manifest.background).toBe(true);
    expect(manifest.serves).toEqual(['today', 'next', 'agenda']);
  });

  test('the feed host is static and the address is also a hostWhitelist setting', () => {
    expect(manifest.netHosts).toEqual(['calendar.google.com', 'outlook.live.com']);
    const whitelist = manifest.config.filter((item) => item.hostWhitelist === true);
    expect(whitelist).toHaveLength(1);
    expect(whitelist[0].key).toBe('calendarUrl');
    expect(whitelist[0].type).toBe('text');
    // 另外两样：提前几分钟、要不要提醒。
    const lead = manifest.config.find((item) => item.key === 'remindMinutes');
    expect(lead.type).toBe('number');
    expect(lead.default).toBe('10');
    const enabled = manifest.config.find((item) => item.key === 'remindEnabled');
    expect(enabled.type).toBe('bool');
    expect(enabled.default).toBe('true');
  });

  test('one surface block sized for a compact card, and every file it loads ships', () => {
    expect(manifest.surface).toHaveLength(1);
    const rect = manifest.surface[0];
    expect(rect.w).toBe(300);
    expect(rect.h).toBe(132);
    // 声明了 maxH 才有资格请求长高（surface.blocks 的 sizes 只对它生效）。
    expect(rect.maxH).toBeGreaterThan(rect.h);
    const fixed = ['panel.html', 'app.js', 'style.css'];
    for (const src of scriptSources) {
      if (fixed.includes(src)) continue;
      expect(manifest.assets).toContain(src);
    }
    for (const asset of manifest.assets) {
      expect(existsSync(path.join(pluginDir, asset)), `manifest.assets 里的 ${asset} 不存在`).toBe(true);
    }
    expect(existsSync(path.join(pluginDir, manifest.entry))).toBe(true);
    // 整份引 ui.css 会让浮层面继承 box-shadow / hover 位移，那些在矩形裁剪下会被切掉。
    // （入口文档里那句注释解释的就是这件事，所以这里查的是 <link>，不是文本。）
    expect(manifest.assets).not.toContain('ui.css');
    expect(html).not.toMatch(/href="\.?\/?ui\.css"/);
  });
});

// --- 抓取与缓存 ----------------------------------------------------------------

test('一次成功的抓取把原始 ICS 文本与 fetchedAt 写进 storage', async () => {
  fetchBody = todayFeed();
  await boot({ slot: 'background' });

  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0].url).toBe(GOOGLE_URL);
  expect(store.get('feed/ics')).toContain('BEGIN:VCALENDAR');
  expect(store.get('feed/ics')).toContain('今天的早会');
  const meta = JSON.parse(store.get('feed/meta'));
  expect(meta.fetchedAt).toBeGreaterThan(Date.now() - 60000);
  expect(meta.url).toBe(GOOGLE_URL);
});

test('webcal:// 订阅链接按 https:// 发出去（日历应用给出的就是这个协议）', async () => {
  await boot({ slot: 'background', config: { calendarUrl: 'webcal://calendar.google.com/calendar/ical/a/basic.ics' } });
  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0].url).toBe('https://calendar.google.com/calendar/ical/a/basic.ics');
});

test('没填订阅地址时一个 net.fetch 都不发，界面上写明先去设置里填', async () => {
  await boot({ slot: 'workshop', config: { calendarUrl: '' } });
  expect(fetchCalls).toHaveLength(0);
  const need = document.getElementById('ws-need-url');
  expect(need.classList.contains('hidden')).toBe(false);
  expect(document.getElementById('ws-need-text').textContent).toContain('先去设置里填日历地址');
});

test('地址填得不像链接时也不发请求，并说清哪里不对', async () => {
  await boot({ slot: 'workshop', config: { calendarUrl: 'calendar.google.com/foo' } });
  expect(fetchCalls).toHaveLength(0);
  expect(document.getElementById('ws-need-text').textContent).toContain('http(s)');
});

test('断网时仍能列出今天的日程，而且界面上自己说这是缓存', async () => {
  seedFeed(todayFeed(), Date.now() - 42 * 60000);
  fetchReplies.push({ status: 500, body: 'boom' });
  await boot({ slot: 'workshop' });

  // 缓存旧了 → 会试着刷一次，然后失败。
  expect(fetchCalls).toHaveLength(1);
  const days = document.getElementById('ws-days').textContent;
  expect(days).toContain('今天的早会');
  expect(days).toContain('今天的总结');
  const cacheLine = document.getElementById('ws-cache').textContent;
  expect(cacheLine).toContain('缓存');
  expect(cacheLine).toContain('42 分钟前');
  expect(cacheLine).toContain('HTTP 500');
  // 缓存不能假装是新的。
  expect(cacheLine).not.toContain('刚刚更新');
});

test('断网时 plugin.call 也照常回答，并带上 fromCache', async () => {
  seedFeed(todayFeed(), Date.now() - 90 * 60000);
  fetchReplies.push({ status: 502, body: 'bad gateway' });
  await boot({ slot: 'background' });

  expect(fetchCalls).toHaveLength(1);
  const packet = await hostCall('today', {});
  expect(packet.ok).toBe(true);
  expect(packet.result.fromCache).toBe(true);
  expect(packet.result.events.map((event) => event.title)).toEqual(['今天的早会', '今天的总结']);
});

test('缓存还新的时候不抓网络：卡片那一面只读缓存', async () => {
  seedFeed(todayFeed(), Date.now());
  await boot({ slot: 'surface' });
  expect(fetchCalls).toHaveLength(0);
  expect(document.getElementById('sf-what').textContent.length).toBeGreaterThan(0);
});

// --- ICS 解析 ------------------------------------------------------------------

describe('ICS 解析', () => {
  test('单次 / 每日重复 / 跨时区三条真样本都换算成正确的绝对时刻', async () => {
    fetchBody = ICS_PARSING;
    await boot({ slot: 'background' });
    const packet = await hostCall('agenda', { from: '2026-11-01T00:00:00Z', to: '2026-11-30T00:00:00Z' });
    expect(packet.ok).toBe(true);
    const events = packet.result.events;

    // ① 单次：上海 14:00（UTC+8）→ 06:00Z
    const single = events.find((event) => event.uid.startsWith('single-1'));
    expect(single.title).toBe('产品评审');
    expect(single.start).toBe(Date.UTC(2026, 10, 5, 6, 0, 0));
    expect(single.end).toBe(Date.UTC(2026, 10, 5, 7, 0, 0));
    expect(single.allDay).toBe(false);
    expect(single.location).toBe('三楼会议室');

    // ② 每日重复：11-02 起每天 09:00（= 01:00Z），窗口里 11-02…11-29 共 28 场
    const daily = events.filter((event) => event.uid.startsWith('daily-1'));
    expect(daily).toHaveLength(28);
    expect(daily[0].start).toBe(Date.UTC(2026, 10, 2, 1, 0, 0));
    expect(daily[1].start - daily[0].start).toBe(24 * 3600 * 1000);
    expect(daily[1].title).toBe('站会');

    // ③ 跨时区：纽约 14:00（2026-11-05 已在 EST，UTC-5）→ 19:00Z；标题跨折行拼接
    const ny = events.find((event) => event.uid.startsWith('ny-1'));
    expect(ny.start).toBe(Date.UTC(2026, 10, 5, 19, 0, 0));
    expect(ny.end).toBe(Date.UTC(2026, 10, 5, 20, 0, 0));
    expect(ny.title).toBe('纽约那边的一对一');
  });

  test('serves.today 只回今天的，每条都带 title / start / end / allDay', async () => {
    fetchBody = todayFeed();
    await boot({ slot: 'background' });
    const packet = await hostCall('today', {});
    expect(packet.ok).toBe(true);
    expect(Array.isArray(packet.result.events)).toBe(true);
    expect(packet.result.events).toHaveLength(2);
    for (const event of packet.result.events) {
      expect(typeof event.title).toBe('string');
      expect(typeof event.start).toBe('number');
      expect(typeof event.end).toBe('number');
      expect(typeof event.allDay).toBe('boolean');
      expect(event.end).toBeGreaterThan(event.start);
    }
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    for (const event of packet.result.events) {
      expect(event.start).toBeGreaterThanOrEqual(midnight.getTime());
      expect(event.start).toBeLessThan(midnight.getTime() + 24 * 3600 * 1000);
    }
  });

  test('serves.next 回下一场，serves.agenda 回一段区间', async () => {
    const start = new Date(Date.now() + 90 * 60000);
    start.setSeconds(0, 0);
    fetchBody = upcomingFeed(90);
    await boot({ slot: 'background' });

    const next = await hostCall('next', {});
    expect(next.ok).toBe(true);
    expect(next.result.event).toBeTruthy();
    expect(next.result.event.title).toBe('快到了的评审');
    expect(next.result.event.start).toBe(start.getTime());

    const agenda = await hostCall('agenda', { from: Date.now(), to: Date.now() + 7 * 24 * 3600 * 1000 });
    expect(agenda.ok).toBe(true);
    expect(agenda.result.events).toHaveLength(1);
    expect(agenda.result.events[0].start).toBe(start.getTime());
  });

  test('空的一段时间回空数组，不是错误', async () => {
    fetchBody = todayFeed();
    await boot({ slot: 'background' });
    const packet = await hostCall('agenda', { from: '2030-01-01T00:00:00Z', to: '2030-02-01T00:00:00Z' });
    expect(packet.ok).toBe(true);
    expect(packet.result.events).toEqual([]);
  });

  test('未知方法回一句说得清的中文（点出方法名与它会答的那几个），不是沉默', async () => {
    fetchBody = todayFeed();
    await boot({ slot: 'background' });
    const packet = await hostCall('tomorrow', {});
    expect(packet.ok).toBe(false);
    expect(packet.error).toContain('tomorrow');
    expect(packet.error).toContain('today');
    expect(packet.error).toContain('agenda');
  });
});

// --- 提醒 ---------------------------------------------------------------------

test('会前提醒只发一次：跨过"会前 10 分钟"之后再拍也不重发', async () => {
  seedFeed(upcomingFeed(8, '八分钟后的评审'));
  await boot({ slot: 'background' });

  // 缓存是新的，所以这一轮不该有网络请求。
  expect(fetchCalls).toHaveLength(0);

  const said = () => bubbles.filter((bubble) => String(bubble.text).includes('八分钟后的评审'));
  expect(said()).toHaveLength(1);
  expect(said()[0].text).toContain('还有');
  expect(said()[0].text).toContain('分钟');

  await runTick();
  await runTick();
  await runTick();
  expect(said()).toHaveLength(1);

  // 说过的那一场落盘了：宿主重启也不会从头再说一遍。
  const reminded = JSON.parse(store.get('feed/reminded'));
  expect(Object.keys(reminded).length).toBe(1);
});

test('提前量按设置项走：改成 30 分钟后，还有 20 分钟的会才提醒', async () => {
  const feed = upcomingFeed(20, '二十分钟后的评审');
  seedFeed(feed);
  fetchBody = feed;
  await boot({ slot: 'background', config: { remindMinutes: '10' } });
  expect(bubbles).toHaveLength(0);

  // 用户改了设置 → 宿主推 config.changed → 重新判定（不需要重挂帧）。
  configValues.remindMinutes = '30';
  hostSends({ v: 1, type: 'event', name: 'config.changed', payload: { pluginId: PLUGIN_ID } });
  await drain(8);
  await runTick();

  expect(bubbles.filter((bubble) => String(bubble.text).includes('二十分钟后的评审'))).toHaveLength(1);
});

test('提醒关掉之后一句都不说', async () => {
  seedFeed(upcomingFeed(5, '五分钟后的评审'));
  await boot({ slot: 'background', config: { remindEnabled: 'false' } });
  await runTick();
  expect(bubbles).toHaveLength(0);
});

test('定时器都按分钟粒度跑（没有 1 秒轮询），常驻帧那一拍是 20 秒', async () => {
  await boot({ slot: 'background' });
  expect(intervals.length).toBeGreaterThan(0);
  for (const timer of intervals) expect(timer.ms).toBeGreaterThanOrEqual(15000);
});

// --- 三种面孔 ----------------------------------------------------------------

test('控制中心那一面不碰桌宠专属能力，并把"提醒在桌宠上"写出来', async () => {
  await boot({ slot: 'workshop' });
  const methods = requests().map((req) => req.method);
  expect(methods).not.toContain('bubble.say');
  expect(methods).not.toContain('events.subscribe');
  expect(methods).not.toContain('surface.show');
  expect(methods).not.toContain('plugin.call');

  const note = document.getElementById('ws-note');
  expect(note.classList.contains('hidden')).toBe(false);
  expect(note.textContent).toContain('提醒在桌宠上');
  // 只读的部分照常显示：日程列表在。
  expect(document.getElementById('ws-days').classList.contains('hidden')).toBe(false);
  expect(document.getElementById('ws-days').textContent).toContain('今天的早会');
});

test('插件页的按天分组：今天在最上面，跨零点的事件落到各自那一天', async () => {
  fetchBody = icsDoc([
    ...icsEvent([
      'UID:today-x@test',
      'DTSTART:' + icsUtc(localAt(9, 0)),
      'DTEND:' + icsUtc(localAt(10, 0)),
      'SUMMARY:今天九点',
    ]),
    ...icsEvent([
      'UID:tomorrow-x@test',
      'DTSTART:' + icsUtc(localAt(9, 0, 1)),
      'DTEND:' + icsUtc(localAt(10, 0, 1)),
      'SUMMARY:明天九点',
    ]),
  ]);
  await boot({ slot: 'workshop' });
  const heads = [...document.querySelectorAll('#ws-days .day-head')].map((node) => node.textContent);
  expect(heads).toHaveLength(2);
  expect(heads[0].startsWith('今天')).toBe(true);
  expect(heads[1].startsWith('明天')).toBe(true);
  const rows = [...document.querySelectorAll('#ws-days .ev-title')].map((node) => node.textContent);
  expect(rows).toEqual(['今天九点', '明天九点']);
});

test('浮层面卡片同一时刻只有一组可见：#sf-main 或 #sf-empty', async () => {
  seedFeed(upcomingFeed(90, '卡片上的评审'), Date.now());
  await boot({ slot: 'surface' });

  expect(document.getElementById('sf-main').classList.contains('hidden')).toBe(false);
  expect(document.getElementById('sf-empty').classList.contains('hidden')).toBe(true);
  expect(document.getElementById('sf-what').textContent).toBe('卡片上的评审');
  // 这一面不抓网络：卡片是视图，不是引擎。
  expect(fetchCalls).toHaveLength(0);
});

test('没配置地址时卡片只显示一句引导，没有第二组内容', async () => {
  await boot({ slot: 'surface', config: { calendarUrl: '' } });
  expect(document.getElementById('sf-main').classList.contains('hidden')).toBe(true);
  expect(document.getElementById('sf-empty').classList.contains('hidden')).toBe(false);
  expect(document.getElementById('sf-empty').textContent).toContain('设置');
  expect(fetchCalls).toHaveLength(0);
});

test('在插件页保存地址会写进 config 并立刻抓一次', async () => {
  await boot({ slot: 'workshop', config: { calendarUrl: '' } });
  expect(fetchCalls).toHaveLength(0);

  const settings = document.getElementById('ws-settings');
  settings.open = true;
  const input = document.getElementById('ws-url');
  input.value = GOOGLE_URL;
  document.getElementById('ws-save').click();
  await drain(12);

  expect(configValues.calendarUrl).toBe(GOOGLE_URL);
  expect(fetchCalls).toHaveLength(1);
  expect(document.getElementById('ws-days').textContent).toContain('今天的早会');
  // 保存成功之后设置面板收起来，界面回到列表。
  expect(settings.open).toBe(false);
});

test('宿主拒绝一切时不崩，也不写任何数据', async () => {
  denyAll = true;
  await boot({ slot: 'background' });
  await runTick(20000);
  await runTick(20000);

  expect(runtimeErrors).toEqual([]);
  // 没有一次成功的写入：拒绝等于"什么都没发生"，不是"写了个空的"。
  expect([...store.keys()]).toEqual([]);
  expect(bubbles).toHaveLength(0);
  expect(fetchCalls).toHaveLength(0);
  // 定时器还在跑（被拒的是能力，不是插件本身）。
  expect(intervals.length).toBeGreaterThan(0);
});

test('一张授权都没给时不发任何请求，只把缺的那几项写在界面上', async () => {
  await boot({ slot: 'workshop', granted: [] });
  expect(requests()).toHaveLength(0);
  expect(document.getElementById('boot-note').textContent).toContain('未获授权');
  expect(runtimeErrors).toEqual([]);
});
