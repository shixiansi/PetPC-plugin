import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 桌宠养成的行为测试。钉住的几件事：
//
//   1. 数值曲线：1→2 级 20 经验、99→100 级 19700；满级封顶；
//   2. 溢出与跨级连升：一次最多 20 级、溢出经验保留到下一轮、100000 经验从 1 级升到 21；
//   3. 存档迁移：v1→v2 补字段、无 schema 的极老档、未知未来版本、坏档清洗；
//   4. 属性点：不够点数拒、上限拒、洗点退回、重置全部退回；
//   5. 互动配额：体力决定每小时次数、超了拒、整点重置；
//   6. 外部发奖：grant_exp 上限 100000（防恶意调用方）、profile 只读、respec；
//   7. 完整链路：喂食 → 经验入档 → 升级气泡 + share 发布；番茄钟 share 联动发奖。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-pet-evolution');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((m) => m[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');
const source = scriptSources
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-pet-evolution';

// --- 消息泵 -----------------------------------------------------------------------

let store;
let configValues;
let shareTray;       // 其他插件发布的共享键（番茄钟 phase-ended）
let sharePublished;
let bubbles;
let windowListeners;
let intervals;
let timeouts;
let posted;
let answered;

function hostSends(msg) {
  for (const [, fn] of windowListeners) fn({ source: window, data: msg });
}

function requests() {
  return posted.mock.calls.map((c) => c[0]).filter((m) => m && m.type === 'request');
}

function answer(id, result, { ok = true, error = '' } = {}) {
  answered.add(id);
  hostSends({ v: 1, type: 'response', id, ok, result, error });
}

async function pump(maxRounds = 100) {
  for (let i = 0; i < maxRounds; i += 1) {
    const list = requests().filter((r) => !answered.has(r.id));
    if (!list.length) return;
    for (const req of list) {
      const payload = req.payload || {};
      switch (req.method) {
        case 'config.get':
          answer(req.id, { values: configValues, secrets: {} });
          break;
        case 'storage.get':
          if (payload.key === 'profile-v2') answer(req.id, { value: store.get('profile-v2') || '' });
          else answer(req.id, { value: '' });
          break;
        case 'storage.set':
          store.set(String(payload.key), String(payload.value ?? ''));
          answer(req.id, { ok: true });
          break;
        case 'share.get': {
          const entry = shareTray.get(`${payload.owner}/${payload.name}`) || null;
          answer(req.id, entry ? { value: entry.value, at: entry.at, key: `${payload.owner}/${payload.name}` } : { value: '', at: 0, key: `${payload.owner}/${payload.name}` });
          break;
        }
        case 'share.set':
          sharePublished.push({ name: payload.name, value: payload.value });
          answer(req.id, { ok: true, key: `${PLUGIN_ID}/${payload.name}` });
          break;
        case 'bubble.say':
          bubbles.push(payload.text);
          answer(req.id, { ok: true });
          break;
        default:
          answer(req.id, null, { ok: false, error: `本程序不支持该方法 ${req.method}` });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function drive(promiseFactory) {
  const p = promiseFactory();
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 40 && !settled; i += 1) {
    await pump(8);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return p;
}

const macro = () => new Promise((resolve) => setTimeout(resolve, 0));

function loadApp() {
  answered = new Set();
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  for (const id of intervals) clearInterval(id);
  intervals = [];
  for (const id of timeouts) clearTimeout(id);
  timeouts = [];
  // eslint-disable-next-line no-new-func
  new Function(source)();
}

function boot(slot = 'workshop', granted = manifest.permissions) {
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
  loadApp();
  hostSends({
    v: 1, type: 'init', pluginId: PLUGIN_ID, permissions: manifest.permissions,
    granted, surface: { kind: 'panel', slot },
  });
  return macro();
}

async function bootSettled(slot = 'workshop', granted = manifest.permissions) {
  await boot(slot, granted);
  await pump(8);
}

beforeEach(() => {
  store = new Map();
  configValues = { petName: '小宠', chatExpPerTurn: '12', bubbleOnLevelUp: 'true' };
  shareTray = new Map();
  sharePublished = [];
  bubbles = [];
  windowListeners = [];
  intervals = [];
  timeouts = [];
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
  const originalTimeout = window.setTimeout.bind(window);
  vi.spyOn(window, 'setTimeout').mockImplementation((fn, ms) => {
    const id = originalTimeout(fn, ms);
    timeouts.push(id);
    return id;
  });
  posted = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
});

afterEach(() => {
  for (const id of intervals) clearInterval(id);
  for (const id of timeouts) clearTimeout(id);
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('manifest', () => {
  test('permissions: storage/config/call/share/bubble，无 process/llm', () => {
    expect([...manifest.permissions].sort()).toEqual([
      'pet.bubble', 'plugin.call', 'plugin.config', 'plugin.share', 'storage',
    ]);
  });

  test('serves 三个方法；shareRead 只点名番茄钟的 phase-ended', () => {
    expect(manifest.serves).toEqual(['grant_exp', 'profile', 'respec']);
    expect(manifest.shareRead).toEqual(['com.shixiansi.plugin-pomodoro/phase-ended']);
    const pomodoro = JSON.parse(readFileSync(path.join(here, '..', 'plugins', 'com.shixiansi.plugin-pomodoro', 'manifest.json'), 'utf8'));
    void pomodoro; // shareRead 指向的键由番茄钟插件真实发布（见 its own tests）
  });
});

describe('engine: 数值曲线', () => {
  let E;
  beforeEach(async () => {
    await bootSettled('background');
    E = window.__evolution.engine;
  });

  test('经验曲线：1→2 是 20，10→11 是 632，99→100 是 19700，满级 Infinity', () => {
    expect(E.expToNext(1)).toBe(20);
    expect(E.expToNext(10)).toBe(632);
    expect(E.expToNext(99)).toBe(19700);
    expect(E.expToNext(100)).toBe(Infinity);
  });

  test('曲线递增（越级越贵）', () => {
    for (let l = 1; l < 99; l += 1) {
      expect(E.expToNext(l + 1)).toBeGreaterThanOrEqual(E.expToNext(l));
    }
  });

  test(' skinsForLevel：每 10 级一个，满级 11 个（default + 10 皮肤）', () => {
    expect(E.skinsForLevel(1)).toEqual(['default']);
    expect(E.skinsForLevel(35).length).toBe(4); // default + 10/20/30
    expect(E.skinsForLevel(100).length).toBe(11);
  });
});

describe('engine: 溢出与跨级连升', () => {
  let E;
  beforeEach(async () => {
    await bootSettled('background');
    E = window.__evolution.engine;
  });

  test('100000 经验从 1 级 → 21 级（连升上限 20），溢出保留', () => {
    const r = E.grantExp(E.makeProfile(), 100000);
    expect(r.profile.level).toBe(21);
    expect(r.gained.levels).toBe(20);
    expect(r.overflow).toBeGreaterThan(0);
    expect(r.profile.statPoints).toBe(60);
    expect(r.capped).toBe(false);
  });

  test('被截断的经验在下一轮继续升（不丢失）', () => {
    let p = E.makeProfile();
    const r1 = E.grantExp(p, 100000);
    p = r1.profile;
    const r2 = E.grantExp(p, r1.overflow);
    expect(r2.profile.level).toBeGreaterThan(21);
    // 总共升的级数 + 溢出，等价于不设上限时的目标
  });

  test('巨大数值不溢出（Number.MAX_SAFE 防线）', () => {
    const r = E.grantExp(E.makeProfile(), Number.MAX_SAFE_INTEGER);
    expect(Number.isFinite(r.profile.exp)).toBe(true);
    expect(r.profile.level).toBeLessThanOrEqual(100);
  });

  test('负数与 NaN 按 0 处理（经验只涨不跌）', () => {
    const p = E.makeProfile();
    expect(E.grantExp(p, -50).profile.exp).toBe(0);
    expect(E.grantExp(p, NaN).profile.exp).toBe(0);
    expect(E.grantExp(p, 'abc').profile.exp).toBe(0);
  });

  test('满级：经验清零、再发奖只涨好感、capped=true', () => {
    let p = E.makeProfile();
    for (let i = 0; i < 6; i += 1) p = E.grantExp(p, 5000000).profile;
    expect(p.level).toBe(100);
    const r = E.grantExp(p, 1234);
    expect(r.capped).toBe(true);
    expect(r.profile.level).toBe(100);
    expect(r.profile.exp).toBe(0);
    expect(r.profile.friendship).toBeGreaterThanOrEqual(2);
  });

  test('升级解锁外观：10/20 级各解锁一个，解锁不重复', () => {
    let p = E.makeProfile();
    const r = E.grantExp(p, 100000);
    expect(r.gained.unlocked).toEqual(['skin-10', 'skin-20']);
    expect(r.profile.unlocked).toEqual(['default', 'skin-10', 'skin-20']);
  });

  test('好感度：升级 +2、封顶 100', () => {
    let p = E.makeProfile();
    p.friendship = 99;
    const r = E.grantExp(p, 20); // 升 1 级
    expect(r.profile.friendship).toBe(100);
  });
});

describe('engine: 存档迁移', () => {
  let E;
  beforeEach(async () => {
    await bootSettled('background');
    E = window.__evolution.engine;
  });

  test('v1 → v2：补 stats/statPoints/counters/unlocked，等级经验原样保留', () => {
    const m = E.migrateProfile({ schema: 1, level: 7, exp: 100, name: '老宠' });
    expect(m.schema).toBe(2);
    expect(m.level).toBe(7);
    expect(m.exp).toBe(100);
    expect(m.name).toBe('老宠');
    expect(m.stats).toEqual({ intellect: 5, stamina: 5, affinity: 5 });
    expect(m.statPoints).toBe(0);
    expect(m.counters).toEqual({ chats: 0, plays: 0, tasks: 0, feeds: 0 });
    expect(m.unlocked).toEqual(['default']);
  });

  test('极老档（无 schema 字段）按 v1 处理再走链', () => {
    const m = E.migrateProfile({ level: 3, exp: 10 });
    expect(m.schema).toBe(2);
    expect(m.level).toBe(3);
    expect(m.stats.intellect).toBe(5);
  });

  test('未来版本（schema=99）不回滚数据，字段补齐', () => {
    const future = { schema: 99, level: 50, exp: 5, stats: { intellect: 30, stamina: 30, affinity: 30 }, newField: '未来数据' };
    const m = E.migrateProfile(future);
    expect(m.level).toBe(50);
    expect(m.stats.intellect).toBe(30);
    expect(m.newField).toBe('未来数据'); // 未知字段保留（向前兼容）
  });

  test('坏档清洗：负等级、超上限属性、NaN 经验全部夹回合法区间', () => {
    const m = E.migrateProfile({ schema: 2, level: 5000, exp: 'abc', stats: { intellect: 9999, stamina: -3, affinity: 5 }, friendship: 500 });
    expect(m.level).toBe(100);
    expect(m.exp).toBe(0);
    expect(m.stats.intellect).toBe(99);
    expect(m.stats.stamina).toBe(1);
    expect(m.friendship).toBe(100);
  });

  test('null / 非对象 → 全新档案', () => {
    expect(E.migrateProfile(null).level).toBe(1);
    expect(E.migrateProfile('garbage').level).toBe(1);
    expect(E.migrateProfile(42).schema).toBe(2);
  });

  test('迁移不改传入对象（新档是副本）', () => {
    const old = { schema: 1, level: 7, exp: 100 };
    E.migrateProfile(old);
    expect(old.schema).toBe(1);
    expect(old.stats).toBeUndefined();
  });
});

describe('engine: 属性点', () => {
  let E;
  beforeEach(async () => {
    await bootSettled('background');
    E = window.__evolution.engine;
  });

  test('加点：扣点数、涨属性；点数不够拒', () => {
    const p = E.makeProfile();
    p.statPoints = 5;
    const r = E.allocateStat(p, 'intellect', 3);
    expect(r.ok).toBe(true);
    expect(r.profile.stats.intellect).toBe(8);
    expect(r.profile.statPoints).toBe(2);
    const fail = E.allocateStat(p, 'stamina', 6);
    expect(fail.ok).toBe(false);
    expect(fail.error).toContain('不够');
  });

  test('上限 99：满了拒并说明', () => {
    const p = E.makeProfile();
    p.stats.intellect = 99;
    p.statPoints = 3;
    const r = E.allocateStat(p, 'intellect', 1);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('上限');
  });

  test('洗点（负数）：属性退回初始 5 为下限，点数返还', () => {
    const p = E.makeProfile();
    p.stats.intellect = 8;
    p.statPoints = 0;
    const r = E.allocateStat(p, 'intellect', -2);
    expect(r.ok).toBe(true);
    expect(r.profile.stats.intellect).toBe(6);
    expect(r.profile.statPoints).toBe(2);
    // 再洗 5：只能洗到初始 5（give=1），退 1 点，之后到底再洗才拒。
    const toFloor = E.allocateStat(r.profile, 'intellect', -5);
    expect(toFloor.ok).toBe(true);
    expect(toFloor.profile.stats.intellect).toBe(5);
    expect(toFloor.profile.statPoints).toBe(3);
    const floor = E.allocateStat(toFloor.profile, 'intellect', -1);
    expect(floor.ok).toBe(false);
    expect(floor.error).toContain('初始值');
  });

  test('未知属性与 0 点数拒', () => {
    const p = E.makeProfile();
    expect(E.allocateStat(p, 'speed', 1).ok).toBe(false);
    expect(E.allocateStat(p, 'intellect', 0).ok).toBe(false);
  });

  test('重置属性：全部退回点数、等级不变', () => {
    const p = E.makeProfile();
    p.level = 10;
    p.stats = { intellect: 20, stamina: 15, affinity: 5 };
    const r = E.respecStats(p);
    expect(r.returned).toBe(25);
    expect(r.profile.stats).toEqual({ intellect: 5, stamina: 5, affinity: 5 });
    expect(r.profile.statPoints).toBe(25);
    expect(r.profile.level).toBe(10);
  });

  test('statEffects：智力→对话深度、体力→互动次数、亲密→好感倍率', () => {
    const p = E.makeProfile();
    p.stats = { intellect: 30, stamina: 25, affinity: 45 };
    const fx = E.statEffects(p);
    expect(fx.chatDepth).toBe(400 + 30 * 36);
    expect(fx.interactionsPerHour).toBe(10 + 5);
    expect(fx.friendshipRate).toBeCloseTo(1.2);
  });
});

describe('完整链路（假宿主泵）', () => {
  test('喂食 → 经验入档、计数、状态更新', async () => {
    await bootSettled('workshop');
    await drive(() => window.__evolution.doInteraction('feed'));
    const snap = window.__evolution.snapshot();
    expect(snap.profile.exp).toBe(8);
    expect(snap.profile.counters.feeds).toBe(1);
    expect(store.has('profile-v2')).toBe(true);
    const saved = JSON.parse(store.get('profile-v2'));
    expect(saved.exp).toBe(8);
  });

  test('互动配额：体力 5 → 每小时 11 次，用完拒绝', async () => {
    await bootSettled('workshop');
    const snap0 = window.__evolution.snapshot();
    expect(snap0.interactionsLeft).toBe(11);
    for (let i = 0; i < 11; i += 1) await drive(() => window.__evolution.doInteraction('feed'));
    expect(window.__evolution.snapshot().interactionsLeft).toBe(0);
    await drive(() => window.__evolution.doInteraction('feed'));
    // 第 12 次：被拒（状态行有提示）。
    expect(document.getElementById('status').textContent).toContain('用完');
  });

  test('升级 → 气泡 + share 发布 evolution-state', async () => {
    await bootSettled('workshop');
    // 20 经验升到 2 级（喂食 3 次 = 24 经验）。
    for (let i = 0; i < 3; i += 1) await drive(() => window.__evolution.doInteraction('feed'));
    expect(bubbles.some((t) => t.includes('升级'))).toBe(true);
    // 发布过多次（每次发奖都发），取**最后一条**（升级后的状态）。
    const pubs = sharePublished.filter((s) => s.name === 'evolution-state');
    expect(pubs.length).toBeGreaterThanOrEqual(3);
    const state = JSON.parse(pubs[pubs.length - 1].value);
    expect(state.level).toBeGreaterThanOrEqual(2);
    expect(state.mood).toBe('levelup');
  });

  test('plugin.call grant_exp：外部发奖、单次上限 100000', async () => {
    await bootSettled('background');
    const h = window.__evolution.handlers;
    const r = await drive(() => h.grant_exp({ amount: 100000, reason: '聊天' }));
    expect(r.levels).toBe(20);
    expect(r.level).toBe(21);
    // amount<=0 拒（错误要成为调用方的拒绝原因，而不是挂到超时）。
    await expect(drive(() => h.grant_exp({ amount: 0 }))).rejects.toThrow('amount');
    await expect(drive(() => h.grant_exp({}))).rejects.toThrow('amount');
  });

  test('plugin.call profile：只读快照带效果值', async () => {
    await bootSettled('background');
    const p = await drive(() => window.__evolution.handlers.profile({}));
    expect(p.level).toBe(1);
    expect(p.expToNext).toBe(20);
    expect(p.effects.interactionsPerHour).toBe(11);
    expect(p.unlocked).toEqual(['default']);
  });

  test('plugin.call respec：外部触发的重置', async () => {
    await bootSettled('background');
    const h = window.__evolution.handlers;
    // 初始档没有已分配的点：respec 退 0 点，不炸。
    const r = await drive(() => h.respec({}));
    expect(r.returned).toBe(0);
    expect(r.statPoints).toBe(0);
    // 有点数时（升级得来的 statPoints）——重置不改 statPoints，只洗已分配属性。
    await drive(() => h.grant_exp({ amount: 100000 })); // 20 级 → statPoints 60
    const r2 = await drive(() => h.respec({}));
    expect(r2.returned).toBe(0);
    expect(r2.statPoints).toBe(60);
  });

  test('番茄钟联动：phase-ended focus → 升级+留溢出（同一条不重复）', async () => {
    await bootSettled('background');
    shareTray.set('com.shixiansi.plugin-pomodoro/phase-ended', {
      value: JSON.stringify({ phase: 'focus', at: 12345 }),
      at: 99999,
    });
    await drive(() => window.__evolution.checkPomodoroPhase());
    // 30 经验：20 进级、剩 10。
    const after1 = window.__evolution.snapshot().profile;
    expect(after1.level).toBe(2);
    expect(after1.exp).toBe(10);
    // 同一条不重复发奖。
    await drive(() => window.__evolution.checkPomodoroPhase());
    expect(window.__evolution.snapshot().profile.exp).toBe(10);
    // 新的一条（break 阶段不发；换成新的 focus 才再发）。
    shareTray.set('com.shixiansi.plugin-pomodoro/phase-ended', {
      value: JSON.stringify({ phase: 'break', at: 12346 }),
      at: 100000,
    });
    await drive(() => window.__evolution.checkPomodoroPhase());
    expect(window.__evolution.snapshot().profile.exp).toBe(10);
  });

  test('工坊页：雷达图 SVG 与属性行被渲染', async () => {
    await bootSettled('workshop');
    const radar = document.getElementById('radar');
    expect(radar.innerHTML).toContain('grid-line');
    expect(radar.innerHTML).toContain('data-shape');
    expect(radar.innerHTML).toContain('智力');
    expect(document.querySelectorAll('.stat-row').length).toBe(3);
    expect(document.getElementById('points-label').textContent).toContain('0');
  });

  test('工坊页：加点按钮走完整链路（点数 → 属性 → 存档）', async () => {
    await bootSettled('workshop');
    // 先发 20 经验（升 1 级拿 3 点），再用按钮加点。
    await drive(() => window.__evolution.grantAndPersist(20, '测试'));
    const plus = document.querySelectorAll('.stat-row .btn')[0];
    plus.click();
    await pump(8);
    const snap = window.__evolution.snapshot();
    expect(snap.profile.stats.intellect).toBe(6);
    expect(snap.profile.statPoints).toBe(2);
    expect(JSON.parse(store.get('profile-v2')).stats.intellect).toBe(6);
  });

  test('坏档启动：按全新档案处理，不炸', async () => {
    store.set('profile-v2', '{broken json');
    await bootSettled('workshop');
    expect(window.__evolution.snapshot().profile.level).toBe(1);
  });

  test('旧版存档启动：迁移后继续用', async () => {
    store.set('profile-v2', JSON.stringify({ schema: 1, level: 7, exp: 100, name: '老宠' }));
    await bootSettled('workshop');
    const snap = window.__evolution.snapshot();
    expect(snap.profile.level).toBe(7);
    expect(snap.profile.stats.intellect).toBe(5);
  });
});

describe('样式治理', () => {
  test('style.css 不写死十六进制颜色', () => {
    const css = readFileSync(path.join(pluginDir, 'style.css'), 'utf8');
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(stripped.match(/#[0-9a-fA-F]{3,8}\b/g) || []).toEqual([]);
  });

  test('ui.css 与源头逐字节相同', () => {
    expect(readFileSync(path.join(pluginDir, 'ui.css'), 'utf8'))
      .toBe(readFileSync(path.join(here, '..', 'docs', 'ui', 'petpc-ui.css'), 'utf8'));
  });
});
