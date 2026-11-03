import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 纪念日倒计时插件的行为测试。
//
// 三层：
//   1. 纯日期逻辑（lib/dates.js）——闰年 2/29 的落日规则、跨年、当天 daysLeft=0、
//      每年重复 vs 单次事件，全在这里钉死；
//   2. 宿主链路（真实 panel.html + lib + app.js 在 jsdom 里握手）——握手、serve 的 next、
//      增删改、granted=[] 零请求零写入不崩；
//   3. 静态接线——manifest.serves 与 CALL_HANDLERS 逐字一致（少一边，调用方等 30 秒超时）。
//
// "今天"是注入的（__anniversary.setClock）：业务代码里不散落 new Date()，测试才能把日历
// 钉在任意一天上反复问，不依赖真实墙钟。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-anniversary');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const datesSource = readFileSync(path.join(pluginDir, 'lib', 'dates.js'), 'utf8');
const appSource = readFileSync(path.join(pluginDir, 'app.js'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const SH_OFF = 480; // Asia/Shanghai，本地偏移（分钟）
const DAY = (y, mo, d) => `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** 纯日期层单独加载（不经过 jsdom）：同一份源码就是插件在帧里跑的那份。 */
function loadDates() {
  const window = {};
  new Function('window', datesSource)(window);
  return window.AnniversaryDates;
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

  window.eval(datesSource); // panel.html 的 <script> 顺序：lib 先、app 后
  window.eval(appSource);

  const init = () => {
    // init.host.methods 照两个宿主的真实形状给（§5.2.1）：控制中心只有 both 方法，
    // 桌宠的三个挂载都有 pet 专属方法。本插件用到的列出来，插件的 hostServes 查的就是它。
    const petMethods = ['storage.get', 'storage.set', 'config.get', 'events.subscribe', 'pet.badge', 'bubble.say', 'surface.blocks', 'surface.show'];
    const workshopMethods = ['storage.get', 'storage.set', 'config.get'];
    const isWorkshop = (surface || {}).slot === 'workshop';
    const data = {
      v: 1,
      type: 'init',
      theme: 'dark',
      granted: granted || [],
      surface: surface || { kind: 'panel', slot: 'background' },
      host: { program: isWorkshop ? 'workshop' : 'pet', methods: isWorkshop ? workshopMethods : petMethods },
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
 * 把宿主的应答喂完：init 是一串 await（config → storage → events），每一轮回答完等一拍
 * 再收新请求，直到不再有新请求。answers(method, payload) 返回 { ok, result }；
 * 返回 undefined 用默认表（storage.get 读 KEY_RECORDS，config 给默认值）。
 */
async function drive(page, answers) {
  const defaults = (method, payload) => {
    if (method === 'config.get') {
      return { ok: true, result: { values: { badgeEnabled: 'true', remindDays: '0' }, secrets: {} } };
    }
    if (method === 'storage.get') {
      if (payload.key === 'records') return { ok: true, result: { value: page.storedRecords ?? '' } };
      return { ok: true, result: { value: '' } };
    }
    if (method === 'events.subscribe') return { ok: true, result: ['config.changed'] };
    if (method === 'storage.set') return { ok: true, result: { ok: true } };
    return { ok: true, result: { ok: true } }; // pet.badge / surface.blocks 等
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

/**
 * 把 init 之后、测试动作之前发出的请求答到安静为止；answerNew=true 时连测试动作
 * 引出的新请求也一起答完（表单提交的 storage.set 要被答到，UI 才会刷新）。
 */
async function settle(page, answerNew = false) {
  for (let round = 0; round < 20; round++) {
    const fresh = page.sent.filter((m) => m.type === 'request' && !page.responded.has(m.id));
    if (!fresh.length) break;
    for (const m of fresh) page.respond(m.id, { ok: true });
    await new Promise((r) => setTimeout(r, 10));
    if (!answerNew) break;
  }
  await new Promise((r) => setTimeout(r, 10));
}

const ALL_GRANTED = ['storage', 'plugin.config', 'pet.surface', 'pet.bubble', 'plugin.call', 'events'];

// --- 1. 纯日期逻辑（lib/dates.js） ----------------------------------------------

describe('纯日期逻辑：闰年 2/29（落日规则：平年落 2/28，注释写明为什么）', () => {
  // 为什么平年落 2/28 而不是 3/1：2/29 是"二月的最后一天"这个日期在闰年的形状。平年里
  // 二月的最后一天是 28 号——日子还在同一个月份里、离周年最近；滚到 3/1 会把纪念日的
  // 月份都改掉（2 月生日在 3 月过很怪）。规则钉死为"夹到当月最后一天"，与 1/31 在
  // 平年 2 月落 2/28、在 4 月落 4/30 是同一条规则（targetDayKey 的 clamp）。
  const I = loadDates();

  test('平年里 next 落在 2/28（不是 3/1），daysLeft 算得对', () => {
    const recs = I.parseRecords(JSON.stringify([{ id: 'a', title: ' leap 生日', date: '2000-02-29', yearly: true }]));
    // 查询日 2026-01-15：今年 2/28 在未来。
    const occ = I.nextOccurrence(recs[0], DAY(2026, 1, 15), SH_OFF);
    expect(occ.dateKey).toBe('2026-02-28');
    expect(occ.daysLeft).toBe(44);
    expect(occ.clamped).toBe(true);
    const best = I.nextOf(recs, DAY(2026, 1, 15), SH_OFF);
    expect(best.date).toBe('2026-02-28');
    expect(best.daysLeft).toBe(44);
  });

  test('闰年当天 2/29 查询：返回闰年的 2/29 本身，daysLeft=0', () => {
    const recs = I.parseRecords(JSON.stringify([{ id: 'a', title: 'leap 生日', date: '2000-02-29', yearly: true }]));
    const occ = I.nextOccurrence(recs[0], DAY(2028, 2, 29), SH_OFF);
    expect(occ.dateKey).toBe('2028-02-29');
    expect(occ.daysLeft).toBe(0);
  });

  test('平年 2/28 当天查询：返回今天（2/28），daysLeft=0，不是 1', () => {
    const recs = I.parseRecords(JSON.stringify([{ id: 'a', title: 'leap 生日', date: '2000-02-29', yearly: true }]));
    const occ = I.nextOccurrence(recs[0], DAY(2026, 2, 28), SH_OFF);
    expect(occ.dateKey).toBe('2026-02-28');
    expect(occ.daysLeft).toBe(0);
  });

  test('平年 3/1 当天查询：已过今年的落日，next 跨到明年闰年的 2/29', () => {
    const recs = I.parseRecords(JSON.stringify([{ id: 'a', title: 'leap 生日', date: '2000-02-29', yearly: true }]));
    const occ = I.nextOccurrence(recs[0], DAY(2027, 3, 1), SH_OFF);
    expect(occ.dateKey).toBe('2028-02-29'); // 2028 是闰年，恢复 29 号
    expect(occ.daysLeft).toBe(365);
  });

  test('clamp 是同一条规则：1/31 在平年 2 月落 2/28；4/31 这种日子录入即拒', () => {
    // 每年重复的月-日固定为 01-31：查询在 2 月，今年的 1/31 已过 → next 是明年的 1/31。
    // "夹到当月最后一天"由 targetDayKey 在落点上执行（2/29→2/28 那条）；月-日本身
    // 不会换月（月日对是记忆的原点），所以这里钉的是"落点夹紧、记忆原点不漂移"。
    const jan31 = I.parseRecords(JSON.stringify([{ id: 'j', title: '一月的 31 号', date: '2020-01-31', yearly: true }]));
    expect(I.nextOccurrence(jan31[0], DAY(2027, 2, 10), SH_OFF).dateKey).toBe('2028-01-31');
    // 31 号的记忆原点本身永远存在（1 月有 31 天），真正"不存在的日期"在 parseRecord 就拒了：
    const apr31 = I.parseRecords(JSON.stringify([{ id: 'p', title: '四月 31', date: '2020-04-31', yearly: true }]));
    expect(apr31).toEqual([]); // 4/31 不存在的日期：录入即拒（parseRecord 不宽松解析）
  });
});

describe('纯日期逻辑：跨年、当天、单次事件', () => {
  const I = loadDates();

  test('12 月底查询：next 能正确跨到明年', () => {
    const recs = I.parseRecords(JSON.stringify([
      { id: 'ny', title: '新年', date: '1990-01-01', yearly: true },
      { id: 'xmas', title: '圣诞', date: '1990-12-25', yearly: true },
    ]));
    // 2026-12-31 查询：圣诞已过，下一个是明年的新年。
    const best = I.nextOf(recs, DAY(2026, 12, 31), SH_OFF);
    expect(best.id).toBe('ny');
    expect(best.date).toBe('2027-01-01');
    expect(best.daysLeft).toBe(1);
    expect(best.year).toBe(2027);
    // 当天（12/31）查一个 12/31 的纪念日：今天，不跨年。
    const ny2 = I.parseRecords(JSON.stringify([{ id: 'e', title: '年末', date: '2000-12-31', yearly: true }]));
    expect(I.nextOccurrence(ny2[0], DAY(2026, 12, 31), SH_OFF)).toMatchObject({ dateKey: '2026-12-31', daysLeft: 0 });
  });

  test('查询日 == 纪念日：next 返回"今天"（daysLeft=0），不是 1 也不是负数', () => {
    const recs = I.parseRecords(JSON.stringify([{ id: 'b', title: '生日', date: '1995-06-15', yearly: true }]));
    const occ = I.nextOccurrence(recs[0], DAY(2026, 6, 15), SH_OFF);
    expect(occ.daysLeft).toBe(0);
    expect(I.badgeText(occ.daysLeft)).toBe('今天');
    expect(I.badgeText(1)).toBe('1天');
  });

  test('每年重复 vs 单次事件：单次过后不再出现在 next / 列表里', () => {
    const recs = I.parseRecords(JSON.stringify([
      { id: 'once', title: '婚礼（单次）', date: '2025-10-01', yearly: false },
      { id: 'yearly', title: '成立周年', date: '2020-10-03', yearly: true },
    ]));
    // 2026-01-01：单次已过 3 个月——不出现。
    const best = I.nextOf(recs, DAY(2026, 1, 1), SH_OFF);
    expect(best.id).toBe('yearly');
    const list = I.sortedWithDays(recs, DAY(2026, 1, 1), SH_OFF);
    expect(list.map((e) => e.id)).toEqual(['yearly']);
    // 单次未过：照常出现，daysLeft 是到那天的整数天。
    const future = I.parseRecords(JSON.stringify([{ id: 'once2', title: '签证到期', date: '2026-03-10', yearly: false }]));
    const occ = I.nextOccurrence(future[0], DAY(2026, 1, 1), SH_OFF);
    expect(occ.daysLeft).toBe(68);
    expect(occ.dateKey).toBe('2026-03-10');
    // 单次当天：也算"今天"（daysLeft=0，不是负数）。
    expect(I.nextOccurrence(future[0], DAY(2026, 3, 10), SH_OFF).daysLeft).toBe(0);
    // 过了一天：剔除。
    expect(I.nextOccurrence(future[0], DAY(2026, 3, 11), SH_OFF)).toMatchObject({ daysLeft: -1 });
    expect(I.nextOf(future, DAY(2026, 3, 11), SH_OFF)).toBeNull();
  });

  test('列表按剩余天数排序；并列按录入顺序', () => {
    const recs = I.parseRecords(JSON.stringify([
      { id: 'far', title: '远', date: '2000-12-01', yearly: true },
      { id: 'near', title: '近', date: '2000-01-05', yearly: true },
      { id: 'tieA', title: '并列甲', date: '2000-03-20', yearly: true },
      { id: 'tieB', title: '并列乙', date: '2000-03-20', yearly: true },
    ]));
    const list = I.sortedWithDays(recs, DAY(2026, 1, 1), SH_OFF);
    expect(list.map((e) => e.id)).toEqual(['near', 'tieA', 'tieB', 'far']);
    expect(list[0].daysLeft).toBe(4);
  });

  test('录入校验：坏日期整行拒绝，不宽松解析（2/30、13 月、非日期串）', () => {
    expect(I.parseRecord({ id: 'x', title: 't', date: '2026-02-30', yearly: true })).toBeNull();
    expect(I.parseRecord({ id: 'x', title: 't', date: '2026-13-01', yearly: true })).toBeNull();
    expect(I.parseRecord({ id: 'x', title: 't', date: '随便', yearly: true })).toBeNull();
    expect(I.parseRecord({ id: 'x', title: 't', date: '', yearly: true })).toBeNull();
    // 年份 0001 与 9999 都合法（生日可能填很久以前）。
    expect(I.parseRecord({ id: 'x', title: 't', date: '0001-01-01', yearly: true })).toMatchObject({ date: '0001-01-01' });
    expect(I.parseRecord({ id: 'x', title: 't', date: '9999-12-31', yearly: true })).toMatchObject({ date: '9999-12-31' });
    // 平年 2/29 是录入错误；闰年 2/29 合法。
    expect(I.parseRecord({ id: 'x', title: 't', date: '2026-02-29', yearly: true })).toBeNull();
    expect(I.parseRecord({ id: 'x', title: 't', date: '2024-02-29', yearly: true })).not.toBeNull();
  });

  test('整表解析不抛错：空串、垃圾 JSON、非数组、坏行混着好行', () => {
    expect(I.parseRecords('')).toEqual([]);
    expect(I.parseRecords('{"not":"an array"')).toEqual([]);
    expect(I.parseRecords('{"not":"an array"}')).toEqual([]);
    expect(() => I.parseRecords('[{"id":"a","title":"t","date":"2026-02-30"}]')).not.toThrow();
    expect(I.parseRecords('[{"id":"a","title":"t","date":"2026-02-30"},{"id":"b","title":"ok","date":"2026-01-02","yearly":false}]'))
      .toEqual([{ id: 'b', title: 'ok', date: '2026-01-02', yearly: false }]);
  });
});

// --- 2. 宿主链路（panel.html + app.js 在 jsdom 里跑） ---------------------------

describe('握手', () => {
  test('ready 先于一切请求；init 之后才开始问宿主', async () => {
    const page = await mount({ granted: ALL_GRANTED, surface: { kind: 'panel', slot: 'background' } });
    expect(page.sent).toHaveLength(1);
    expect(page.sent[0]).toMatchObject({ v: 1, type: 'ready' });
    page.init();
    await drive(page);
    expect(page.sent.some((m) => m.type === 'request' && m.method === 'config.get')).toBe(true);
    expect(page.errors).toEqual([]);
  });
});

describe('plugin.call：next（注入"今天"）', () => {
  const BIRTH = JSON.stringify([
    { id: 'leap', title: '闰月生日', date: '2000-02-29', yearly: true },
    { id: 'newyear', title: '新年', date: '1990-01-01', yearly: true },
  ]);

  async function mountedBackground(today, records) {
    const page = await mount({ granted: ALL_GRANTED, surface: { kind: 'panel', slot: 'background' } });
    page.window.__anniversary.setClock(() => today, SH_OFF);
    page.storedRecords = records ?? '';
    page.init();
    await drive(page);
    page.sent.length = 0;
    return page;
  }

  test('常驻帧收到 call(next) 用 postCallResult 正确应答', async () => {
    const page = await mountedBackground(DAY(2026, 1, 15), BIRTH);
    const answer = await askCall(page, 'next', {});
    expect(answer, 'call 没有被回答（调用方只会等到 30 秒超时）').toBeTruthy();
    expect(answer.ticket).toBeTruthy();
    expect(answer.ok).toBe(true);
    expect(answer.result.next).toMatchObject({ id: 'leap', date: '2026-02-28', daysLeft: 44, yearly: true });
    expect(answer.result.date).toBe('2026-01-15');
  });

  test('跨年：12 月底 next 落在明年', async () => {
    const page = await mountedBackground(DAY(2026, 12, 31), BIRTH);
    const answer = await askCall(page, 'next', {});
    expect(answer.ok).toBe(true);
    expect(answer.result.next).toMatchObject({ id: 'newyear', date: '2027-01-01', daysLeft: 1, year: 2027 });
  });

  test('当天：next 返回 daysLeft=0 的"今天"，不是 1 也不是负数', async () => {
    const page = await mountedBackground(DAY(2026, 2, 28), BIRTH);
    const answer = await askCall(page, 'next', {});
    expect(answer.ok).toBe(true);
    expect(answer.result.next).toMatchObject({ id: 'leap', date: '2026-02-28', daysLeft: 0 });
  });

  test('单次事件过后：next 跳过它（不再出现在答案里）', async () => {
    const page = await mountedBackground(DAY(2026, 1, 1), JSON.stringify([
      { id: 'once', title: '单次', date: '2025-10-01', yearly: false },
      { id: 'next-year', title: '明年单次', date: '2027-05-05', yearly: false },
    ]));
    const answer = await askCall(page, 'next', {});
    expect(answer.ok).toBe(true);
    expect(answer.result.next).toMatchObject({ id: 'next-year', date: '2027-05-05' });
  });

  test('不认识的方法要回一条中文拒绝，而不是沉默', async () => {
    const page = await mountedBackground(DAY(2026, 1, 1), '[]');
    const answer = await askCall(page, 'agenda', {});
    expect(answer, '拒绝也要有回包').toBeTruthy();
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain('不认识方法');
    expect(answer.error).toContain('next');
  });
});

describe('徽标（pet.badge）与跨天', () => {
  test('init 后按最近一个更新徽标；跨天由 storage/config 事件与 15 秒兜底重算', async () => {
    const page = await mount({ granted: ALL_GRANTED, surface: { kind: 'panel', slot: 'background' } });
    page.window.__anniversary.setClock(() => DAY(2026, 1, 15), SH_OFF);
    page.storedRecords = JSON.stringify([{ id: 'a', title: '生日', date: '2000-01-20', yearly: true }]);
    page.init();
    await drive(page);
    await settle(page, true);
    const badge = [...page.sent].reverse().find((m) => m.method === 'pet.badge');
    expect(badge, '没有发 pet.badge').toBeTruthy();
    expect(badge.payload.text).toBe('5天');

    // 15 秒兜底 tick：注入跨天后的"今天"，徽标与答案跟着变（不依赖真实墙钟）。
    page.sent.length = 0;
    page.window.__anniversary.setClock(() => DAY(2026, 1, 20), SH_OFF);
    page.window.__anniversary.updateBadge(false); // 不 await：它在等宿主应答，下面 settle 来答
    await settle(page, true);
    const badge2 = [...page.sent].reverse().find((m) => m.method === 'pet.badge');
    expect(badge2.payload.text).toBe('今天');
    const answer = await askCall(page, 'next', {});
    expect(answer.result.next.daysLeft).toBe(0);
  });

  test('badgeEnabled=false 或没有纪念日：发空串清除徽标', async () => {
    const page = await mount({ granted: ALL_GRANTED, surface: { kind: 'panel', slot: 'background' } });
    page.window.__anniversary.setClock(() => DAY(2026, 1, 15), SH_OFF);
    page.storedRecords = '[]';
    page.init();
    await drive(page, (method) => (method === 'config.get'
      ? { ok: true, result: { values: { badgeEnabled: 'false', remindDays: '3' } } }
      : undefined));
    await settle(page, true);
    const badge = [...page.sent].reverse().find((m) => m.method === 'pet.badge');
    expect(badge).toBeTruthy();
    expect(badge.payload.text).toBe('');
  });

  test('临近提醒：remindDays 内才弹一次，同一发生不重复弹', async () => {
    const page = await mount({ granted: ALL_GRANTED, surface: { kind: 'panel', slot: 'background' } });
    page.window.__anniversary.setClock(() => DAY(2026, 1, 18), SH_OFF);
    page.storedRecords = JSON.stringify([{ id: 'a', title: '生日', date: '2000-01-20', yearly: true }]);
    page.init();
    await drive(page, (method) => (method === 'config.get'
      ? { ok: true, result: { values: { badgeEnabled: 'true', remindDays: '3' } } }
      : undefined));
    await settle(page, true);
    // init 只"排班"（20 秒一拍，手册 §7 的节拍），不立即弹；tick 的逻辑在这里手动触发。
    page.window.__anniversary.remindTick();
    await settle(page, true);
    const bubbles = page.sent.filter((m) => m.method === 'bubble.say');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].payload.text).toContain('2 天后');
    // 再 tick 一次：同一个发生不重复提醒。
    page.window.__anniversary.remindTick(); // 内部 setTimeout 只排下一拍，不 await
    await settle(page, true);
    expect(page.sent.filter((m) => m.method === 'bubble.say')).toHaveLength(1);
    // remindDays=0：不提醒。
    const page2 = await mount({ granted: ALL_GRANTED, surface: { kind: 'panel', slot: 'background' } });
    page2.window.__anniversary.setClock(() => DAY(2026, 1, 18), SH_OFF);
    page2.storedRecords = JSON.stringify([{ id: 'a', title: '生日', date: '2000-01-20', yearly: true }]);
    page2.init();
    await drive(page2, (method) => (method === 'config.get'
      ? { ok: true, result: { values: { badgeEnabled: 'true', remindDays: '0' } } }
      : undefined));
    await settle(page2, true);
    page2.window.__anniversary.remindTick();
    await settle(page2, true);
    expect(page2.sent.filter((m) => m.method === 'bubble.say')).toEqual([]);
  });
});

describe('插件页（workshop）：列表 + 增删改 + 日期选择', () => {
  async function mountedWorkshop(records) {
    const page = await mount({ granted: ALL_GRANTED, surface: { kind: 'panel', slot: 'workshop' } });
    page.window.__anniversary.setClock(() => DAY(2026, 1, 15), SH_OFF);
    page.storedRecords = records ?? '[]';
    page.init();
    await drive(page);
    page.sent.length = 0;
    return page;
  }

  test('workshop 不调 pet 专属方法（控制中心没有它们），但只读列表照常显示', async () => {
    const page = await mountedWorkshop(JSON.stringify([{ id: 'a', title: '生日', date: '2000-01-20', yearly: true }]));
    expect(page.sent.filter((m) => ['pet.badge', 'bubble.say', 'surface.show', 'surface.blocks', 'surface.hide'].includes(m.method))).toEqual([]);
    const listText = page.window.document.getElementById('list').textContent;
    expect(listText).toContain('生日');
    expect(listText).toContain('5 天');
  });

  test('表单添加一条：写 storage 的键是合法扁平名 records，UI 立即出新行', async () => {
    const page = await mountedWorkshop('[]');
    const w = page.window;
    w.document.getElementById('f-title').value = '妈妈的生日';
    w.document.getElementById('f-date').value = '1965-04-08';
    w.document.getElementById('f-yearly').checked = true;
    page.window.__anniversary.onSubmit(new w.Event('submit', { bubbles: true, cancelable: true }));
    await settle(page, true);
    const write = page.sent.find((m) => m.method === 'storage.set');
    expect(write, '没有写 storage').toBeTruthy();
    expect(write.payload.key).toBe('records');
    const stored = JSON.parse(write.payload.value);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ title: '妈妈的生日', date: '1965-04-08', yearly: true });
    expect(page.window.document.getElementById('list').textContent).toContain('妈妈的生日');
  });

  test('空日期提交：不写 storage，表单点名报错（不猜、不静默改今天）', async () => {
    const page = await mountedWorkshop('[]');
    const w = page.window;
    w.document.getElementById('f-title').value = '没有日期的一条';
    w.document.getElementById('f-date').value = '';
    page.window.__anniversary.onSubmit(new w.Event('submit', { bubbles: true, cancelable: true }));
    await settle(page, true);
    expect(page.sent.filter((m) => m.method === 'storage.set')).toEqual([]);
    const note = page.window.document.getElementById('form-note');
    expect(note.hidden).toBe(false);
    expect(note.textContent).toContain('日期');
  });

  test('改一条：保留 id 原位更新；删一条：从 storage 里消失', async () => {
    const page = await mountedWorkshop(JSON.stringify([{ id: 'a', title: '生日', date: '2000-01-20', yearly: true }]));
    const w = page.window;
    // 改：点"改"→ 表单填新日期 → 提交。
    w.document.querySelector('button[data-edit-id]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    expect(w.document.getElementById('f-date').value).toBe('2000-01-20');
    w.document.getElementById('f-date').value = '2000-02-14';
    page.window.__anniversary.onSubmit(new w.Event('submit', { bubbles: true, cancelable: true }));
    await settle(page, true);
    let stored = JSON.parse(page.sent.filter((m) => m.method === 'storage.set').pop().payload.value);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: 'a', date: '2000-02-14' });

    // 删：列表清空，storage 里的数组也空了。
    page.sent.length = 0;
    w.document.querySelector('button[data-del-id]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await settle(page, true);
    const del = page.sent.find((m) => m.method === 'storage.set');
    expect(JSON.parse(del.payload.value)).toEqual([]);
    // 列表重画后只剩空状态文案——那条"还没有纪念日"里没有旧条目的名字。
    expect(w.document.getElementById('list').textContent).toBe('还没有纪念日。下面加一个：');
  });

  test('日期选择器声明 0001-9999：min/max 在 HTML 上，极端年份的值能存能算', async () => {
    const page = await mountedWorkshop('[]');
    const w = page.window;
    const dateInput = w.document.getElementById('f-date');
    expect(dateInput.getAttribute('min')).toBe('0001-01-01');
    expect(dateInput.getAttribute('max')).toBe('9999-12-31');
    dateInput.value = '0990-05-20';
    w.document.getElementById('f-title').value = '老黄历';
    page.window.__anniversary.onSubmit(new w.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 10));
    const stored = JSON.parse(page.sent.find((m) => m.method === 'storage.set').payload.value);
    expect(stored[0].date).toBe('0990-05-20');
    // 计算也认这个年份：每年重复，next 落在今年。
    const best = page.window.AnniversaryDates.nextOf(stored, DAY(2026, 1, 15), SH_OFF);
    expect(best.date).toBe('2026-05-20');
  });
});

describe('granted=[]：宿主什么都没给', () => {
  test('不崩、零 storage 读写、零网络，界面停在"未获授权"', async () => {
    const page = await mount({ granted: [], surface: { kind: 'panel', slot: 'background' } });
    page.window.__anniversary.setClock(() => DAY(2026, 1, 15), SH_OFF);
    page.init();
    await drive(page, () => ({ ok: false }));
    const requests = page.sent.filter((m) => m.type === 'request');
    // 零 storage 写、零网络：这两类一个都不许有。events.subscribe 是唯一允许的登记动作
    // （手册 §7：不订阅就收不到事件；没有 storage/net 的调用）。
    expect(requests.filter((m) => m.method.startsWith('storage.'))).toEqual([]);
    expect(requests.filter((m) => m.method.startsWith('net.'))).toEqual([]);
    expect(page.errors).toEqual([]);
    expect(page.window.document.getElementById('status').textContent).toContain('未获授权');
  });

  test('浮层面同样安静、按"没有数据"渲染、不出未授权态之外的请求', async () => {
    const page = await mount({ granted: [], surface: { kind: 'surface', rectIndex: 0, rectCount: 1, rect: { x: 0, y: 0, w: 320, h: 200, r: 14, tailX: 0, hidden: false, room: 160 } } });
    page.window.__anniversary.setClock(() => DAY(2026, 1, 15), SH_OFF);
    page.init();
    await drive(page, () => ({ ok: false }));
    const requests = page.sent.filter((m) => m.type === 'request');
    expect(requests.filter((m) => m.method.startsWith('storage.'))).toEqual([]);
    expect(page.sent.filter((m) => m.type === 'call-result')).toEqual([]);
    expect(page.errors).toEqual([]);
    expect(page.window.document.getElementById('upcoming').textContent).toContain('没有纪念日');
    expect(page.window.document.getElementById('note').textContent).toContain('未获授权');
  });

  test('granted=[] 时 plugin.call 也答不了：call 收到但不产生 call-result 成功回包', async () => {
    const page = await mount({ granted: [], surface: { kind: 'panel', slot: 'background' } });
    page.window.__anniversary.setClock(() => DAY(2026, 1, 15), SH_OFF);
    page.init();
    await drive(page, () => ({ ok: false }));
    const answer = await askCall(page, 'next', {});
    // serve 的实现不查权限（权限是宿主闸门的事）：数据是空的，就答"没有"。
    // 铁律是"绝不吊死调用方"——有回包，且是明确的空答案。
    expect(answer).toBeTruthy();
    expect(answer.ok).toBe(true);
    expect(answer.result.next).toBeNull();
  });
});

// --- 3. 静态接线 ----------------------------------------------------------------

describe('manifest 与 serve 的接线', () => {
  test('serves 与 CALL_HANDLERS 逐字相同（少一边，调用方等到 30 秒超时）', () => {
    const body = appSource.match(/const CALL_HANDLERS = \{([\s\S]*?)\n\};/)[1];
    const handlers = [...body.matchAll(/^\s{2}([A-Za-z_][\w]*):/gm)].map((m) => m[1]);
    expect(handlers.sort()).toEqual([...manifest.serves].sort());
    expect(manifest.serves).toEqual(['next']);
  });

  test('background 常驻帧的支撑齐全：permissions 有 plugin.call，serves 非空', () => {
    expect(manifest.background).toBe(true);
    for (const p of ['plugin.call', 'storage', 'plugin.config', 'pet.surface', 'pet.bubble', 'events']) {
      expect(manifest.permissions, `缺权限 ${p}`).toContain(p);
    }
  });

  test('浮层纪律：surface 插件不引 ui.css，style.css 无十六进制色值散落在调色板之外', () => {
    const style = readFileSync(path.join(pluginDir, 'style.css'), 'utf8');
    const css = style.replace(/\/\*[\s\S]*?\*\//g, '');
    const paletteBlocks = [...css.matchAll(/(:root[^{]*|\[data-theme[^\]]*\])\s*\{([^}]*)\}/g)].map((m) => m[2]);
    let rest = css;
    for (const block of paletteBlocks) rest = rest.split(block).join('');
    expect(rest.match(/#[0-9a-fA-F]{3,8}\b/g) || []).toEqual([]);
    expect(css).toContain('background: transparent');
    expect(css).toContain('color-scheme: only light');
    expect(readFileSync(path.join(pluginDir, 'panel.html'), 'utf8')).not.toMatch(/<link[^>]+ui\.css/);
    for (const prop of ['box-shadow', 'filter', 'transform', 'text-shadow']) {
      expect(css.includes(prop), `浮层插件不该用 ${prop}`).toBe(false);
    }
  });

  test('lib/dates.js 是纯函数层：不碰 DOM、不碰宿主桥、不取当前时间', () => {
    expect(datesSource).not.toContain('document.');
    expect(datesSource).not.toContain('postMessage');
    expect(datesSource).not.toContain('Date.now');
    expect(datesSource).not.toContain('getTimezoneOffset');
    // 允许的 Date 用法只有"静态构造"：Date.UTC(年,月,日) 与 new Date(<毫秒数>)（dayKeyOf
    // 的毫秒 → UTC 分量）。不接收毫秒入参的 new Date()（无参 = "现在"）一个都不许有。
    const bareNow = datesSource.match(/new Date\s*\(\s*\)/g) || [];
    expect(bareNow, '纯函数层不该有 new Date()：那是"现在"').toEqual([]);
    expect(datesSource).toContain('Date.UTC');
  });
});
