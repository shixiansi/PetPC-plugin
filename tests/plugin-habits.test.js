import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 习惯打卡插件的行为测试。
//
// 三层：
//   1. 纯函数（lib/habit-core.js）——04:00 换日、断签重置、跨月连续天数在这里钉住；
//   2. 宿主链路（真实 panel.html + lib + app.js 在 jsdom 里握手）——serves 应答、打卡写盘、
//      徽标、granted=[] 零请求；
//   3. 静态接线——manifest.serves 与 CALL_HANDLERS 逐字一致（少一边，调用方等 30 秒超时）。
//
// "现在几点"是注入的（__habits.setClock）：业务代码里不散落 new Date()，测试才能把日历钉在
// 任意时刻反复问，不依赖真实墙钟。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-habits');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const coreSource = readFileSync(path.join(pluginDir, 'lib', 'habit-core.js'), 'utf8');
const appSource = readFileSync(path.join(pluginDir, 'app.js'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const SH_OFF = 480; // Asia/Shanghai，本地偏移（分钟）
const MS_MIN = 60000;

/** 本地墙钟 → epoch 毫秒：localMs(2026,1,31,23,0) = 上海 2026-01-31 23:00。 */
function localMs(y, mo, d, h = 0, mi = 0) {
  return Date.UTC(y, mo - 1, d, h, mi) - SH_OFF * MS_MIN;
}

/** 纯函数层单独加载（不经过 jsdom）：同一份源码就是插件在帧里跑的那份。 */
function loadCore() {
  const window = {};
  new Function('window', coreSource)(window);
  return window.HabitCore;
}

// --- jsdom 挂载（模仿 tests/plugin-todo.test.js 的 mount） ---------------------

async function mount({ granted: grants, surface } = {}) {
  const dom = new JSDOM(html, { url: 'https://plugin.invalid/panel.html', runScripts: 'outside-only' });
  const { window } = dom;
  const sent = [];
  const errors = [];
  const responded = new Set();
  window.parent = window;
  window.postMessage = (msg) => sent.push(msg);
  window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
  window.addEventListener('unhandledrejection', (e) => errors.push('unhandled: ' + String(e.reason && e.reason.message || e.reason)));

  window.eval(coreSource); // panel.html 的 <script> 顺序：lib 先、app 后
  window.eval(appSource);

  const init = () => {
    const data = {
      v: 1,
      type: 'init',
      theme: 'dark',
      granted: grants || [],
      surface: surface || { kind: 'panel', slot: 'background' },
    };
    if (surface?.slot === 'workshop') {
      // 控制中心只服务插件页能用的方法：host.methods=[] 就是"这里没有桌宠专属能力"。
      data.host = { program: 'workshop', methods: [] };
    }
    // 其余挂载不给 host：插件按 slot 兜底（背景帧在桌宠进程里，pet 专属方法可用）。
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

// 带存储的宿主：storage.get 回仓库里的值，storage.set 记下来（打卡写盘就是主路径）。
function makeStore() {
  const data = new Map();
  return {
    get: (k) => (data.has(k) ? { ok: true, result: { value: data.get(k) } } : { ok: true, result: { value: '' } }),
    set: (k, v) => { data.set(k, String(v)); return { ok: true, result: { ok: true } }; },
    keys: () => [...data.keys()],
    raw: (k) => data.get(k),
  };
}

/** 把 init 引出的一串请求喂完，直到不再有新请求。answers 优先于默认表。 */
async function drive(page, { store = null, clockMs = null, offsetMin = SH_OFF, answer } = {}) {
  if (clockMs !== null) page.window.__habits.setClock(() => clockMs, offsetMin);
  const defaults = (method, payload) => {
    if (method === 'config.get') {
      return { ok: true, result: { values: { dayChangeHour: '4', showBadge: 'true', hideWhenDone: 'false' }, secrets: {} } };
    }
    if (method === 'storage.get') return store ? store.get(payload.key) : { ok: true, result: { value: '' } };
    if (method === 'storage.set') return store ? store.set(payload.key, payload.value) : { ok: true, result: { ok: true } };
    if (method === 'events.subscribe') return { ok: true, result: ['config.changed'] };
    if (method === 'pet.badge') return { ok: true, result: { text: payload.text } };
    return { ok: false };
  };
  for (let round = 0; round < 30; round++) {
    const fresh = page.sent.filter((m) => m.type === 'request' && !page.responded.has(m.id));
    for (const m of fresh) {
      const a = (answer && answer(m.method, m.payload || {})) || defaults(m.method, m.payload || {});
      if (a) page.respond(m.id, a.result, a.ok !== false);
    }
    const waiting = page.sent.some((m) => m.type === 'request' && !page.responded.has(m.id));
    if (!waiting && fresh.length === 0) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 10));
}

/** 问一次 plugin.call 并拿回 call-result。 */
async function askCall(page, method, payload, ticket) {
  page.say({ v: 1, type: 'call', ticket: ticket || `tk-${Math.random().toString(36).slice(2)}`, from: 'com.shixiansi.plugin-test', method, payload: payload || {} });
  await new Promise((r) => setTimeout(r, 10));
  return page.sent.filter((m) => m.type === 'call-result').pop() || null;
}

/** 背景挂载 + 存储就绪 + 时钟固定在 atMs。返回 page 与 store（断言写盘用）。 */
async function mountedBackground(atMs, seedState) {
  const page = await mount({
    granted: ['storage', 'plugin.config', 'pet.surface', 'events', 'plugin.call'],
    surface: { kind: 'panel', slot: 'background' },
  });
  const store = makeStore();
  if (seedState) store.set('habits/state', JSON.stringify(seedState));
  page.init();
  await drive(page, { store, clockMs: atMs });
  page.sent.length = 0;
  return { page, store };
}

const HABITS2 = {
  habits: [{ id: 'h-water', name: '喝水' }, { id: 'h-run', name: '锻炼' }],
  log: {
    'h-water': ['2026-01-29', '2026-01-30', '2026-01-31'],
    'h-run': ['2026-01-29', '2026-01-30'],
  },
};

// --- 1. 纯函数 ------------------------------------------------------------------

describe('换日按本机换日钟点切（默认 04:00）', () => {
  const C = loadCore();

  test('昨天 23:00 打的卡：今天 03:59 仍算"昨天"，04:01 算新的一天', () => {
    // 2026-01-31 23:00 与 2026-02-01 03:59 属于同一个习惯日 2026-01-31。
    expect(C.dayKeyOf(localMs(2026, 1, 31, 23, 0), 4, SH_OFF)).toBe('2026-01-31');
    expect(C.dayKeyOf(localMs(2026, 2, 1, 3, 59), 4, SH_OFF)).toBe('2026-01-31');
    // 04:01 起就是新的一天（跨月也没问题）。
    expect(C.dayKeyOf(localMs(2026, 2, 1, 4, 1), 4, SH_OFF)).toBe('2026-02-01');
    // 同一天里 04:00 整算新的一天（[04:00, 次日 04:00) 是一个习惯日）。
    expect(C.dayKeyOf(localMs(2026, 2, 1, 4, 0), 4, SH_OFF)).toBe('2026-02-01');
  });

  test('换日钟点可配置：0=自然日，23=当天 23 点才换日；非法值回落 4', () => {
    expect(C.dayKeyOf(localMs(2026, 2, 1, 1, 0), 0, SH_OFF)).toBe('2026-02-01');
    expect(C.dayKeyOf(localMs(2026, 2, 1, 1, 0), 23, SH_OFF)).toBe('2026-01-31');
    expect(C.dayKeyOf(localMs(2026, 2, 1, 1, 0), 99, SH_OFF)).toBe('2026-01-31');
    expect(C.dayKeyOf(localMs(2026, 2, 1, 1, 0), NaN, SH_OFF)).toBe('2026-01-31');
  });
});

describe('断签与连续天数（纯函数）', () => {
  const C = loadCore();

  test('断签归零且只重置一次：昨天漏卡 → 今天 streak=0，连续两次查询结果一致', () => {
    // h-water 在 01-31 之后没有 02-01……卡停在 01-31，今天已是 02-02 → 断了。
    const days = ['2026-01-29', '2026-01-30', '2026-01-31'];
    const first = C.streakOf(days, '2026-02-02');
    const second = C.streakOf(days, '2026-02-02');
    expect(first).toBe(0);
    expect(second).toBe(0); // 纯函数没有"已重置"标记，第二次不可能再扣
    // 今天（02-01）问：昨天没卡但今天还没过完 → 按最后一次打卡算 3 天。
    expect(C.streakOf(days, '2026-02-01')).toBe(3);
  });

  test('跨月连续天数：1月31日 → 2月1日 连续打卡 streak 正确 +1', () => {
    // 1 月只有 31 天：1/30、1/31、2/1 连着打 → 2/1 那天连 3 天。
    const days = ['2026-01-30', '2026-01-31', '2026-02-01'];
    expect(C.streakOf(days, '2026-02-01')).toBe(3);
    // 从 2/1 往前数正好跨过 1/31→2/1 的月界；补上 2/2 变 4。
    days.push('2026-02-02');
    expect(C.streakOf(days, '2026-02-02')).toBe(4);
  });

  test('补录乱序不影响：去重 + 无序的天数列表算出同一个 streak', () => {
    expect(C.streakOf(['2026-01-31', '2026-01-30', '2026-01-31', '2026-02-01'], '2026-02-01')).toBe(3);
    expect(C.streakOf([], '2026-02-01')).toBe(0);
    expect(C.streakOf(['not-a-day'], '2026-02-01')).toBe(0);
  });
});

// --- 2. 宿主链路 ----------------------------------------------------------------

describe('握手', () => {
  test('ready 先于一切请求；init 之后才开始问宿主', async () => {
    const page = await mount({
      granted: ['storage', 'plugin.config', 'pet.surface', 'events', 'plugin.call'],
      surface: { kind: 'panel', slot: 'background' },
    });
    expect(page.sent).toHaveLength(1);
    expect(page.sent[0]).toMatchObject({ v: 1, type: 'ready' });
    page.init();
    await drive(page, { clockMs: localMs(2026, 2, 1, 9, 0) });
    expect(page.sent.some((m) => m.type === 'request' && m.method === 'config.get')).toBe(true);
    expect(page.sent.some((m) => m.type === 'request' && m.method === 'storage.get' && m.payload.key === 'habits/state')).toBe(true);
    expect(page.errors).toEqual([]);
  });
});

describe('plugin.call：streak / today（注入今天 = 2026-02-01 09:30）', () => {
  const AT = localMs(2026, 2, 1, 9, 30);

  test('streak：喝水的 3 天连击、锻炼断签归 0，还差 2 个', async () => {
    // 今天是 2026-02-01：water 最后打卡 01-31 且今天没打 → 按"最后一次"算 3 天连击；
    // run 今天没打、昨天（01-31）也没打 → 断签，streak 从 0 重算。
    const { page } = await mountedBackground(AT, HABITS2);
    const answer = await askCall(page, 'streak', {});
    expect(answer, 'call 没有被回答').toBeTruthy();
    expect(answer.ok).toBe(true);
    expect(answer.result.day).toBe('2026-02-01');
    const water = answer.result.habits.find((h) => h.id === 'h-water');
    const run = answer.result.habits.find((h) => h.id === 'h-run');
    expect(water).toMatchObject({ name: '喝水', streak: 3, doneToday: false });
    expect(run.streak).toBe(0); // 01-31 之后断了，连击从 0 重算
    expect(answer.result.remaining).toBe(2);
    expect(answer.result.total).toBe(2);
  });

  test('断签只重置一次：连问两次 streak，结果逐字相同', async () => {
    const { page } = await mountedBackground(AT, HABITS2);
    const first = await askCall(page, 'streak', {}, 'tk-a');
    const second = await askCall(page, 'streak', {}, 'tk-b');
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.result).toEqual(first.result); // 不会反复扣、不会漂移
  });

  test('today：total/done/remaining/allDone 是徽标那句话的数据源', async () => {
    const { page } = await mountedBackground(AT, HABITS2);
    const answer = await askCall(page, 'today', {});
    expect(answer.ok).toBe(true);
    expect(answer.result).toEqual({ day: '2026-02-01', done: 0, total: 2, remaining: 2, allDone: false });
  });

  test('不认识的方法要回一条中文拒绝，而不是沉默', async () => {
    const { page } = await mountedBackground(AT, HABITS2);
    const answer = await askCall(page, 'habit', {});
    expect(answer, '拒绝也要有回包').toBeTruthy();
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain('不认识方法');
    expect(answer.error).toContain('streak');
  });
});

describe('打卡（04:00 换日在整条链路上成立）', () => {
  // 打卡场景的种子：h-water 今天（无论"今天"被钉在哪个习惯日）还没打。
  const CHECK_SEED = {
    habits: [{ id: 'h-water', name: '喝水' }, { id: 'h-run', name: '锻炼' }],
    log: { 'h-water': ['2026-01-29', '2026-01-30'], 'h-run': [] },
  };

  test('03:59 打卡落在昨天（2026-01-31），04:01 打卡落在今天（2026-02-01）', async () => {
    // 03:59：写的 key 是 01-31。
    const early = await mountedBackground(localMs(2026, 2, 1, 3, 59), CHECK_SEED);
    await early.page.window.__habits.setCheck('h-water', true, false);
    const earlyWrite = early.page.sent.filter((m) => m.method === 'storage.set').pop();
    expect(earlyWrite, '打卡没有写 storage').toBeTruthy();
    const earlyState = JSON.parse(earlyWrite.payload.value);
    expect(earlyState.log['h-water']).toContain('2026-01-31');

    // 04:01：写的 key 是 02-01（换日切过去了）。种子补上 01-31 那张卡。
    const seeded = {
      habits: CHECK_SEED.habits,
      log: { 'h-water': ['2026-01-29', '2026-01-30', '2026-01-31'], 'h-run': [] },
    };
    const late = await mountedBackground(localMs(2026, 2, 1, 4, 1), seeded);
    await late.page.window.__habits.setCheck('h-water', true, false);
    const lateWrite = late.page.sent.filter((m) => m.method === 'storage.set').pop();
    const lateState = JSON.parse(lateWrite.payload.value);
    expect(lateState.log['h-water']).toContain('2026-02-01');
    // 于是 2/1 打上卡之后，streak 从 3 变 4（1/31 → 2/1 跨月连续 +1）。
    const after = await askCall(late.page, 'streak', {});
    expect(after.result.habits.find((h) => h.id === 'h-water').streak).toBe(4);
  });

  test('重复打卡是幂等的：第二次不产生 storage.set', async () => {
    const { page } = await mountedBackground(localMs(2026, 2, 1, 9, 30), CHECK_SEED);
    const first = await page.window.__habits.setCheck('h-water', true, false);
    const writes1 = page.sent.filter((m) => m.method === 'storage.set').length;
    const second = await page.window.__habits.setCheck('h-water', true, false);
    const writes2 = page.sent.filter((m) => m.method === 'storage.set').length;
    expect(first.unchanged).toBe(false);
    expect(second.unchanged).toBe(true);
    expect(writes2).toBe(writes1); // 幂等：已打过卡的再打一次不落盘
  });

  test('工坊页点「打卡」按钮走同一条写盘路径，同一个 key 只有一个写者', async () => {
    const page = await mount({
      granted: ['storage', 'plugin.config', 'pet.surface', 'events', 'plugin.call'],
      surface: { kind: 'panel', slot: 'workshop' },
    });
    const store = makeStore();
    store.set('habits/state', JSON.stringify(HABITS2));
    page.init();
    await drive(page, { store, clockMs: localMs(2026, 2, 1, 9, 30) });
    const btn = page.window.document.querySelector('#list .row[data-habit-id="h-water"] .check');
    expect(btn, '工坊页没有渲染出打卡按钮').toBeTruthy();
    btn.dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    const write = page.sent.filter((m) => m.method === 'storage.set').pop();
    expect(write, '点打卡没有写 storage').toBeTruthy();
    expect(write.payload.key).toBe('habits/state');
    expect(JSON.parse(write.payload.value).log['h-water']).toContain('2026-02-01');
  });

  test('工坊页能添加与删除习惯（storage 授权时）', async () => {
    const page = await mount({
      granted: ['storage', 'plugin.config', 'pet.surface', 'events', 'plugin.call'],
      surface: { kind: 'panel', slot: 'workshop' },
    });
    const store = makeStore();
    store.set('habits/state', JSON.stringify(HABITS2));
    page.init();
    await drive(page, { store, clockMs: localMs(2026, 2, 1, 9, 30) });
    // 添加
    page.window.document.getElementById('new-name').value = '读书';
    page.window.document.getElementById('add-form').dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 20));
    let write = page.sent.filter((m) => m.method === 'storage.set').pop();
    const added = JSON.parse(write.payload.value);
    expect(added.habits).toHaveLength(3);
    expect(added.habits[2].name).toBe('读书');
    // 删除（连同它的打卡记录）
    const newId = added.habits[2].id;
    page.window.document.querySelector(`#list .row[data-habit-id="${newId}"] .remove`)
      .dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    write = page.sent.filter((m) => m.method === 'storage.set').pop();
    const removed = JSON.parse(write.payload.value);
    expect(removed.habits).toHaveLength(2);
    expect(removed.log[newId]).toBeUndefined();
  });
});

describe('头顶徽标（pet.badge，走 pet.surface）', () => {
  const AT = localMs(2026, 2, 1, 9, 30);

  test('今日还差几个：写「还差 2 个」；全打完按开关清空或写「全完成」', async () => {
    const page = await mount({
      granted: ['storage', 'plugin.config', 'pet.surface', 'events', 'plugin.call'],
      surface: { kind: 'panel', slot: 'background' },
    });
    const store = makeStore();
    store.set('habits/state', JSON.stringify(HABITS2));
    page.init();
    await drive(page, { store, clockMs: AT }); // 不清 outbox：init 时的第一条徽标也要看到
    let badge = page.sent.filter((m) => m.method === 'pet.badge').pop();
    expect(badge, '徽标没有更新').toBeTruthy();
    expect(badge.payload.text).toBe('还差 2 个');

    // 两个都打上：默认（hideWhenDone=false）清空徽标。
    await page.window.__habits.setCheck('h-water', true, false);
    await page.window.__habits.setCheck('h-run', true, false);
    badge = page.sent.filter((m) => m.method === 'pet.badge').pop();
    expect(badge.payload.text).toBe('');
  });

  test('没有习惯时不占头顶那一行（清空）', async () => {
    const page = await mount({
      granted: ['storage', 'plugin.config', 'pet.surface', 'events', 'plugin.call'],
      surface: { kind: 'panel', slot: 'background' },
    });
    const store = makeStore();
    store.set('habits/state', JSON.stringify({ habits: [], log: {} }));
    page.init();
    await drive(page, { store, clockMs: AT });
    const badge = page.sent.filter((m) => m.method === 'pet.badge').pop();
    expect(badge, '没有习惯时也应发一次空徽标把旧字清掉').toBeTruthy();
    expect(badge.payload.text).toBe('');
  });

  test('换日点过了、还没重画（兜底 tick 未到）：换日后的下一次调用按新的一天回答', async () => {
    // 兜底 tick 是 15 秒一拍；这里直接验证 recompute（tick 每拍做的同一件事）：
    // 03:59 挂载 → 时钟拨到 04:01 → 重算后 day 变成 2026-02-01。
    const page = await mount({
      granted: ['storage', 'plugin.config', 'pet.surface', 'events', 'plugin.call'],
      surface: { kind: 'panel', slot: 'background' },
    });
    const store = makeStore();
    store.set('habits/state', JSON.stringify(HABITS2));
    page.init();
    await drive(page, { store, clockMs: localMs(2026, 2, 1, 3, 59) });
    expect(page.window.__habits.snapshot().todayKey).toBe('2026-01-31');
    page.window.__habits.setClock(() => localMs(2026, 2, 1, 4, 1), SH_OFF);
    page.window.__habits.recompute();
    expect(page.window.__habits.snapshot().todayKey).toBe('2026-02-01');
  });
});

describe('granted=[]：宿主什么都没给', () => {
  test('不崩、零 storage 写、零网络请求，界面出未授权态', async () => {
    const page = await mount({
      granted: [],
      surface: { kind: 'panel', slot: 'background' },
    });
    page.init();
    await drive(page, { clockMs: localMs(2026, 2, 1, 9, 30), answer: () => ({ ok: false }) });
    const requests = page.sent.filter((m) => m.type === 'request');
    expect(requests, 'granted=[] 时发出了请求').toEqual([]);
    expect(page.errors).toEqual([]);
    expect(page.window.document.getElementById('status').textContent).toContain('未获授权');
  });

  test('浮层面那一面同样安静：零请求、不写 storage、界面出未授权态', async () => {
    const page = await mount({
      granted: [],
      surface: { kind: 'surface', rectIndex: 0, rectCount: 1, rect: { x: 0, y: 0, w: 300, h: 190, r: 14, tailX: 0, hidden: false, room: 160 } },
    });
    page.init();
    await drive(page, { clockMs: localMs(2026, 2, 1, 9, 30), answer: () => ({ ok: false }) });
    expect(page.sent.filter((m) => m.type === 'request')).toEqual([]);
    expect(page.errors).toEqual([]);
    const note = page.window.document.getElementById('note');
    expect(note.hidden).toBe(false);
    expect(note.textContent).toContain('未获授权');
    // 未授权的视图里没有可点的打卡按钮（没有授权 = 没有可用的控件）。
    expect(page.window.document.querySelector('#list .check')).toBeNull();
  });

  test('带授权但被宿主逐条拒绝（deny）：打卡的写盘请求落空也不崩', async () => {
    const page = await mount({
      granted: ['storage', 'plugin.config', 'pet.surface', 'events', 'plugin.call'],
      surface: { kind: 'panel', slot: 'background' },
    });
    page.init();
    await drive(page, { clockMs: localMs(2026, 2, 1, 9, 30), answer: () => ({ ok: false }) });
    page.sent.length = 0;
    // 宿主连 storage.set 都拒：写不进去，但不该抛未捕获错误。
    await page.window.__habits.setCheck('h-water', true, false).catch(() => {});
    expect(page.errors).toEqual([]);
  });
});

describe('config：换日钟点是可配置的', () => {
  test('换日钟点可配置：config.get 回 23 → 22:59 仍是前一天', async () => {
    const page = await mount({
      granted: ['storage', 'plugin.config', 'pet.surface', 'events', 'plugin.call'],
      surface: { kind: 'panel', slot: 'background' },
    });
    page.init();
    await drive(page, {
      clockMs: localMs(2026, 2, 1, 22, 59),
      answer: (method) => {
        if (method === 'config.get') return { ok: true, result: { values: { dayChangeHour: '23' }, secrets: {} } };
        return undefined;
      },
    });
    expect(page.window.__habits.snapshot().todayKey).toBe('2026-01-31');
  });
});

// --- 3. 静态接线 ----------------------------------------------------------------

describe('manifest 与 serve 的接线', () => {
  test('serves 与 CALL_HANDLERS 逐字相同（少一边，调用方等到 30 秒超时）', () => {
    const body = appSource.match(/const CALL_HANDLERS = \{([\s\S]*?)\n\};/)[1];
    const handlers = [...body.matchAll(/^\s{2}([A-Za-z_][\w]*):/gm)].map((m) => m[1]);
    expect(handlers.sort()).toEqual([...manifest.serves].sort());
    expect(manifest.serves).toEqual(['streak', 'today']);
  });

  test('background 常驻帧的支撑齐全：permissions 含 plugin.call / events / storage / pet.surface', () => {
    expect(manifest.background).toBe(true);
    for (const p of ['plugin.call', 'events', 'storage', 'plugin.config', 'pet.surface']) {
      expect(manifest.permissions, `缺权限 ${p}`).toContain(p);
    }
    expect(manifest.id).toBe('com.shixiansi.plugin-habits');
    expect(manifest.author).toBe('shixiansi');
    expect(manifest.version).toBe('0.1.0');
  });

  test('不引 ui.css（声明了 surface：自带调色板），且浮层块的 maxH 已声明', () => {
    expect(manifest.surface.length).toBeGreaterThan(0);
    expect(manifest.surface[0].maxH).toBeGreaterThan(0);
    expect((manifest.assets || []).join(' ')).toContain('lib/habit-core.js');
    // 注释里解释"为什么不引 ui.css"是允许的；真正禁止的是 <link>/引用。
    expect(/<link[^>]+ui\.css/.test(html)).toBe(false);
    expect(/(?:^|[^.\w])['"`]ui\.css['"`]/.test(appSource.replace(/\/\*[\s\S]*?\*\//g, ''))).toBe(false);
  });
});
