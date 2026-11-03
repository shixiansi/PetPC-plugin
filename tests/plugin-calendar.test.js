import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 日程日历插件的行为测试。
//
// 三层：
//   1. 纯 ICS 解析（lib/ics.js）——TZID、RRULE 展开与"解析不了的跳过"都在这里钉住；
//   2. 宿主链路（真实 panel.html + lib + app.js 在 jsdom 里握手）——握手、plugin.call 三方法、
//      断网落缓存、granted=[] 不发请求；
//   3. 静态接线——manifest.serves 与 CALL_HANDLERS 逐字一致（少一边，调用方等 30 秒超时）。
//
// "今天"是注入的（__calendar.setClock）：业务代码里不散落 new Date()，测试才能把日历
// 钉在 2026-01-01 上反复问。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-calendar');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const icsSource = readFileSync(path.join(pluginDir, 'lib', 'ics.js'), 'utf8');
const appSource = readFileSync(path.join(pluginDir, 'app.js'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

// 样例日历：一个 TZID 单次事件、一个每日 COUNT=5、一个纽约时区事件（验证换算不差一小时）、
// 一个 FREQ=YEARLY（不支持→只留第一次）、一个没有 DTSTART（解析不了→跳过并计数）。
const SAMPLE_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//PetPC//Calendar Sprint//CN',
  'BEGIN:VTIMEZONE',
  'TZID:Asia/Shanghai',
  'BEGIN:STANDARD',
  'DTSTART:19700101T000000',
  'TZOFFSETFROM:+0800',
  'TZOFFSETTO:+0800',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VTIMEZONE',
  'TZID:America/New_York',
  'BEGIN:STANDARD',
  'DTSTART:19700101T000000',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0500',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:meeting-2026@petpc',
  'SUMMARY:新年例会',
  'LOCATION:大会议室',
  'DTSTART;TZID=Asia/Shanghai:20260101T100000',
  'DTEND;TZID=Asia/Shanghai:20260101T110000',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:daily-standup@petpc',
  'SUMMARY:晨会',
  'DTSTART;TZID=Asia/Shanghai:20260101T090000',
  'DTEND;TZID=Asia/Shanghai:20260101T093000',
  'RRULE:FREQ=DAILY;COUNT=5',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:release@petpc',
  'SUMMARY:版本发布窗口',
  'DTSTART;TZID=America/New_York:20260101T090000',
  'DTEND;TZID=America/New_York:20260101T100000',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:yearly@petpc',
  'SUMMARY:周年纪念日',
  'DTSTART;VALUE=DATE:20260102',
  'RRULE:FREQ=YEARLY;BYMONTH=1',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:broken@petpc',
  'SUMMARY:没有开始时间',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const SH_OFF = 480;            // Asia/Shanghai，本地偏移（分钟）
const MS_MIN = 60000;
const DAY0 = Date.UTC(2026, 0, 1) - SH_OFF * MS_MIN; // 2026-01-01 本地零点（epoch 毫秒）
const NOW = Date.UTC(2026, 0, 1, 1, 30);             // 本地 09:30：晨会将散、例会未开

/** 纯解析层单独加载（不经过 jsdom）：同一份源码就是插件在帧里跑的那份。 */
function loadIcs() {
  const window = {};
  new Function('window', icsSource)(window);
  return window.CalendarICS;
}

// --- jsdom 挂载（模仿 tests/plugin-todo.test.js 的 mount） ---------------------

async function mount({ granted, surface } = {}) {
  const dom = new JSDOM(html, { url: 'https://plugin.invalid/panel.html', runScripts: 'outside-only' });
  const { window } = dom;
  const sent = [];
  const errors = [];
  const responded = new Set();
  window.parent = window;
  window.postMessage = (msg) => sent.push(msg);
  window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
  window.addEventListener('unhandledrejection', (e) => errors.push('unhandled: ' + String(e.reason && e.reason.message || e.reason)));

  window.eval(icsSource); // panel.html 的 <script> 顺序：lib 先、app 后
  window.eval(appSource);

  const init = () => {
    const data = {
      v: 1,
      type: 'init',
      theme: 'dark',
      granted: granted || [],
      surface: surface || { kind: 'panel', slot: 'background' },
      host: { program: surface?.slot === 'workshop' ? 'workshop' : 'pet', methods: [] },
    };
    const event = new window.MessageEvent('message', { data });
    Object.defineProperty(event, 'source', { value: window });
    window.dispatchEvent(event);
  };
  const respond = (id, result, ok = true) => {
    responded.add(id);
    const event = new window.MessageEvent('message', { data: { v: 1, type: 'response', id, ok, result } });
    Object.defineProperty(event, 'source', { value: window });
    window.dispatchEvent(event);
  };
  const say = (data) => {
    const event = new window.MessageEvent('message', { data });
    Object.defineProperty(event, 'source', { value: window });
    window.dispatchEvent(event);
  };
  return { window, sent, errors, responded, init, respond, say };
}

/**
 * 把宿主的应答喂完：init 是一串 await（config → storage → events → net.fetch），
 * 每一轮回答完等一拍再收新请求，直到不再有新请求。answers(method, payload) 返回
 * { ok, result }；返回 undefined 用默认表。
 */
async function drive(page, answers) {
  const defaults = (method, payload) => {
    if (method === 'config.get') {
      return { ok: true, result: { values: { icsUrl: 'https://calendar.google.com/calendar/ical/demo/basic.ics', refreshMin: '0', remindMin: '0' }, secrets: {} } };
    }
    if (method === 'storage.get') {
      if (payload.key === 'ics/cache') return { ok: true, result: { value: SAMPLE_ICS } };
      if (payload.key === 'ics/fetched-at') return { ok: true, result: { value: String(NOW - 4 * 86400000) } };
      return { ok: true, result: { value: '' } };
    }
    if (method === 'events.subscribe') return { ok: true, result: ['config.changed'] };
    if (method === 'storage.set') return { ok: true, result: { ok: true } };
    return { ok: false }; // net.fetch 默认失败：断网场景就是主场景
  };
  for (let round = 0; round < 30; round++) {
    const fresh = page.sent.filter((m) => m.type === 'request' && !page.responded.has(m.id));
    for (const m of fresh) {
      const a = (answers && answers(m.method, m.payload || {})) || defaults(m.method, m.payload || {});
      if (a) page.respond(m.id, a.result, a.ok !== false);
    }
    const waiting = page.sent.some((m) => m.type === 'request' && !page.responded.has(m.id));
    if (!waiting && fresh.length === 0) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 10));
}

/** 问一次 plugin.call 并拿回 call-result。 */
async function askCall(page, method, payload) {
  page.say({ v: 1, type: 'call', ticket: `tk-${Math.random().toString(36).slice(2)}`, from: 'com.shixiansi.plugin-test', method, payload });
  await new Promise((r) => setTimeout(r, 10));
  return page.sent.filter((m) => m.type === 'call-result').pop() || null;
}

// --- 1. 纯 ICS 解析 -------------------------------------------------------------

describe('ICS 解析（lib/ics.js，纯函数）', () => {
  const I = loadIcs();
  const parsed = I.parseICS(SAMPLE_ICS);
  const expand = (fromMs, toMs) => I.expandWindow(parsed.events, parsed.zones, { fromMs, toMs, offsetMin: SH_OFF });

  test('TZID=Asia/Shanghai 的单次事件落在本地的 2026-01-01 10:00（毫秒也对）', () => {
    expect(parsed.events).toHaveLength(4); // 没有 DTSTART 的那条被跳过
    expect(parsed.skipped).toBe(1);
    const out = expand(DAY0, DAY0 + 86400000);
    const m = out.find((e) => e.title === '新年例会');
    expect(m, '单次事件不在今天窗口里').toBeTruthy();
    expect(m.startMs).toBe(Date.UTC(2026, 0, 1, 2, 0)); // 10:00 +08:00
    expect(m.endMs).toBe(Date.UTC(2026, 0, 1, 3, 0));
    expect(I.fmtLocal(m.startMs, SH_OFF)).toBe('2026-01-01 10:00');
  });

  test('每日重复 COUNT=5：第 1、3、5 天在，第 6 天不在（COUNT 从 DTSTART 起数）', () => {
    const out = expand(DAY0, DAY0 + 8 * 86400000);
    const days = out.filter((e) => e.title === '晨会').map((e) => I.dayKeyOf(e.startMs, SH_OFF));
    expect(days).toEqual(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05']);
    expect(days).not.toContain('2026-01-06');
  });

  test('跨时区（America/New_York，1 月是 -05:00）换到上海本地不差一小时：22:00 不是 21:00', () => {
    const out = expand(DAY0, DAY0 + 86400000);
    const m = out.find((e) => e.title === '版本发布窗口');
    expect(m, '纽约时区的事件没进今天窗口').toBeTruthy();
    // 09:00 -05:00 = 14:00Z = 上海 22:00。夏令时错算会得到 21:00（差一小时）。
    expect(I.fmtLocal(m.startMs, SH_OFF)).toBe('2026-01-01 22:00');
    expect(m.startMs).toBe(Date.UTC(2026, 0, 1, 14, 0));
  });

  test('不支持的 RRULE（YEARLY）不展开也不崩：只留第一次发生（VALUE=DATE 全天）', () => {
    expect(parsed.events.find((e) => e.title === '周年纪念日').rrule).toBeNull();
    const out = expand(DAY0, DAY0 + 8 * 86400000);
    const days = out.filter((e) => e.title === '周年纪念日').map((e) => I.dayKeyOf(e.startMs, SH_OFF));
    expect(days).toEqual(['2026-01-02']);
    const m = out.find((e) => e.title === '周年纪念日');
    expect(m.allDay).toBe(true);
  });

  test('INTERVAL=2 的每周 BYDAY 与 UNTIL：隔周补齐同周的 MO/WE，UNTIL（Z）截在第二周中间', () => {
    const one = I.parseICS([
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:w@x',
      'SUMMARY:双周会',
      'DTSTART;TZID=Asia/Shanghai:20260107T140000', // 周三
      'DTEND;TZID=Asia/Shanghai:20260107T150000',
      'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20260120T000000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n'));
    const out = I.expandWindow(one.events, one.zones, { fromMs: DAY0, toMs: DAY0 + 30 * 86400000, offsetMin: SH_OFF });
    // 首周只有 DTSTART（同周的周一在它之前，不算发生）；隔两周的周一 1/19 14:00 +08:00
    // 早于 UNTIL（1/20 00:00Z = 上海 08:00），周三 1/21 晚于它——正好截在中间。
    expect(out.map((e) => I.dayKeyOf(e.startMs, SH_OFF))).toEqual(['2026-01-07', '2026-01-19']);
  });

  test('畸形输入不抛错：空串、垃圾文本、垃圾行都给出空结果', () => {
    expect(() => I.parseICS('')).not.toThrow();
    expect(() => I.parseICS('这不是 ICS')).not.toThrow();
    expect(I.parseICS('').events).toEqual([]);
    expect(I.parseICS('这不是 ICS').skipped).toBe(0);
  });
});

// --- 2. 宿主链路（panel.html + app.js 在 jsdom 里跑） ---------------------------

describe('握手', () => {
  test('ready 先于一切请求；init 之后才开始问宿主', async () => {
    const page = await mount({ granted: ['net.fetch', 'storage', 'plugin.config', 'events', 'plugin.call', 'pet.bubble', 'pet.surface'], surface: { kind: 'panel', slot: 'background' } });
    expect(page.sent).toHaveLength(1);
    expect(page.sent[0]).toMatchObject({ v: 1, type: 'ready' });
    page.init();
    await drive(page);
    expect(page.sent.some((m) => m.type === 'request' && m.method === 'config.get')).toBe(true);
    expect(page.errors).toEqual([]);
  });
});

describe('plugin.call：today / next / agenda（注入今天 = 2026-01-01）', () => {
  async function mountedBackground() {
    const page = await mount({
      granted: ['net.fetch', 'storage', 'plugin.config', 'events', 'plugin.call', 'pet.bubble', 'pet.surface'],
      surface: { kind: 'panel', slot: 'background' },
    });
    page.window.__calendar.setClock(() => NOW, SH_OFF);
    page.init();
    // 断网主场景：net.fetch 一律失败，答案全部来自 storage 缓存里上一次拉到的 ICS。
    await drive(page, (method) => (method === 'net.fetch' ? { ok: false } : undefined));
    page.sent.length = 0;
    return page;
  }

  test('today：TZID 单次事件出现在今天，本地时间 10:00', async () => {
    const page = await mountedBackground();
    const answer = await askCall(page, 'today', {});
    expect(answer, 'call 没有被回答').toBeTruthy();
    expect(answer.ok).toBe(true);
    expect(answer.result.date).toBe('2026-01-01');
    const meeting = answer.result.events.find((e) => e.title === '新年例会');
    expect(meeting, '今天的日程里没有新年例会').toBeTruthy();
    expect(meeting.start).toBe('2026-01-01 10:00');
    expect(meeting.location).toBe('大会议室');
  });

  test('next：09:30 时下一个未结束的是 10:00 的例会', async () => {
    const page = await mountedBackground();
    const answer = await askCall(page, 'next', {});
    expect(answer.ok).toBe(true);
    expect(answer.result.title).toBe('新年例会');
    expect(answer.result.start).toBe('2026-01-01 10:00');
    expect(answer.result.ongoing).toBe(false);
  });

  test('agenda(7)：一天一幕都在——例会 1、晨会 5、发布 1、周年 1，共 8 条', async () => {
    const page = await mountedBackground();
    const answer = await askCall(page, 'agenda', { days: 7 });
    expect(answer.ok).toBe(true);
    expect(answer.result.days).toBe(7);
    expect(answer.result.count).toBe(8);
    expect(answer.result.events.map((e) => e.title).filter((t) => t === '晨会')).toHaveLength(5);
  });

  test('断网 4 天：缓存里上一次的 ICS 仍答得出今天有什么，且不再写 storage', async () => {
    const page = await mountedBackground();
    expect(page.window.__calendar.snapshot().eventCount).toBe(4);
    // net.fetch 全程失败（drive 的默认表），期间一个 storage.set 都不该发生。
    expect(page.sent.filter((m) => m.type === 'request' && m.method === 'storage.set')).toEqual([]);
    const answer = await askCall(page, 'today', {});
    expect(answer.result.stale).toBe(true); // 上次成功拉取已是 4 天前：答案要标成"可能过时"
    expect(answer.result.events.length).toBeGreaterThan(0);
  });
});

describe('granted=[]：宿主什么都没给', () => {
  test('不崩、不发 net.fetch、不写 storage，界面停在"未获授权"', async () => {
    const page = await mount({
      granted: [],
      surface: { kind: 'panel', slot: 'background' },
    });
    page.window.__calendar.setClock(() => NOW, SH_OFF);
    page.init();
    await drive(page, () => ({ ok: false }));
    const requests = page.sent.filter((m) => m.type === 'request');
    expect(requests, 'granted=[] 时发出了请求').toEqual([]);
    expect(page.errors).toEqual([]);
    expect(page.window.document.getElementById('status').textContent).toContain('未获授权');
  });

  test('浮层面那一面同样安静，且视图按"没有数据"渲染', async () => {
    const page = await mount({ granted: [], surface: { kind: 'surface', rectIndex: 0, rectCount: 1, rect: { x: 0, y: 0, w: 320, h: 200, r: 14, tailX: 0, hidden: false, room: 160 } } });
    page.init();
    await drive(page, () => ({ ok: false }));
    expect(page.sent.filter((m) => m.type === 'request')).toEqual([]);
    expect(page.errors).toEqual([]);
    expect(page.window.document.getElementById('today').textContent).toContain('没有日程');
  });
});

// --- 3. 静态接线 ----------------------------------------------------------------

describe('manifest 与 serve 的接线', () => {
  test('serves 与 CALL_HANDLERS 逐字相同（少一边，调用方等到 30 秒超时）', () => {
    const body = appSource.match(/const CALL_HANDLERS = \{([\s\S]*?)\n\};/)[1];
    const handlers = [...body.matchAll(/^\s{2}([A-Za-z_][\w]*):/gm)].map((m) => m[1]);
    expect(handlers.sort()).toEqual([...manifest.serves].sort());
    expect(manifest.serves).toEqual(['today', 'next', 'agenda']);
  });

  test('background 常驻帧的支撑齐全：permissions 有 plugin.call / events / net.fetch，serves 非空', () => {
    expect(manifest.background).toBe(true);
    for (const p of ['plugin.call', 'events', 'net.fetch', 'storage', 'plugin.config', 'pet.bubble', 'pet.surface']) {
      expect(manifest.permissions, `缺权限 ${p}`).toContain(p);
    }
    expect(manifest.netHosts.length).toBeGreaterThan(0);
  });
});
