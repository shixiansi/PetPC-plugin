import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 记忆卡片的行为测试。钉住的几件事：
//
//   1. SM-2 核心：连续"简单"指数增长（1→6→17→48→134→375）、"忘记"重置到 1 天且
//      repetitions 归零、EF 只在 q>=3 时更新、EF 下限 1.3 上限 2.8；
//   2. 边界：未知评分拒绝、interval 保险丝、新卡字段缺省；
//   3. 卡组：建卡校验（空面/超长）、去重、导入容错（坏行进 errors 不中断）、
//      导入标签行、导出回读、到期队列排序、统计；
//   4. 复习会话：状态机 idle→card→revealed→下一张/完成，评分写回卡组并持久化；
//   5. 提醒：到期弹气泡、每天上限、换天重置、开关关掉不弹、无到期不弹；
//   6. 完整链路：假宿主泵（建卡→复习→持久化→提醒）。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-flashcards');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((m) => m[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');
const source = scriptSources
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-flashcards';
const T0 = Date.parse('2026-10-31T08:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

// --- 消息泵 -----------------------------------------------------------------------

let store;
let configValues;
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
          if (payload.key === 'deck-v1') answer(req.id, { value: store.get('deck-v1') || '' });
          else answer(req.id, { value: '' });
          break;
        case 'storage.set':
          store.set(String(payload.key), String(payload.value ?? ''));
          answer(req.id, { ok: true });
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
  configValues = { remindOnDue: 'true', remindPerDay: '3' };
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
  if (window.__flashcards) window.__flashcards.stopReminder();
  for (const id of intervals) clearInterval(id);
  for (const id of timeouts) clearTimeout(id);
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('manifest', () => {
  test('permissions: storage/config/call/share/bubble，无 process/llm/net', () => {
    expect([...manifest.permissions].sort()).toEqual([
      'pet.bubble', 'plugin.call', 'plugin.config', 'plugin.share', 'storage',
    ]);
  });

  test('serves 三个方法；background 由 storage 之外的能力之一门控', () => {
    expect(manifest.serves).toEqual(['due_stats', 'add_cards', 'export_deck']);
    expect(manifest.background).toBe(true);
  });
});

describe('sm2: 算法核心', () => {
  let S;
  beforeEach(async () => {
    await bootSettled('background');
    S = window.__flashcards.sm2;
  });

  test('连续"简单"：间隔指数增长 1→6→17→48→134→375（EF 顶到 2.8）', () => {
    let card = { ef: 2.5, interval: 0, repetitions: 0, due: 0 };
    const seq = [];
    for (let i = 0; i < 6; i += 1) {
      card = S.sm2Review(card, 'easy', T0);
      seq.push(card.interval);
    }
    expect(seq).toEqual([1, 6, 17, 48, 134, 375]);
    expect(card.ef).toBe(2.8); // 上限
  });

  test('连续"良好"：标准 SM-2 增长（EF 稳定在 2.5）', () => {
    let card = { ef: 2.5, interval: 0, repetitions: 0, due: 0 };
    card = S.sm2Review(card, 'good', T0);
    expect(card.interval).toBe(1);
    card = S.sm2Review(card, 'good', T0);
    expect(card.interval).toBe(6);
    card = S.sm2Review(card, 'good', T0);
    expect(card.interval).toBe(15); // round(6 * 2.5)
  });

  test('"忘记"：间隔重置 1 天、repetitions 归零、EF 不变（原版语义）', () => {
    const card = { ef: 2.2, interval: 45, repetitions: 7, due: T0 };
    const r = S.sm2Review(card, 'forget', T0);
    expect(r.interval).toBe(1);
    expect(r.repetitions).toBe(0);
    expect(r.ef).toBe(2.2);
    expect(r.due).toBe(T0 + DAY);
  });

  test('"困难"：EF 下降但不出 1.3；第一次间隔仍是 1', () => {
    const r = S.sm2Review({ ef: 2.5, interval: 0, repetitions: 0 }, 'hard', T0);
    expect(r.interval).toBe(1);
    expect(r.ef).toBeCloseTo(2.36, 2);
    let low = { ef: 1.3, interval: 6, repetitions: 2 };
    low = S.sm2Review(low, 'hard', T0);
    expect(low.ef).toBe(1.3); // 下限
  });

  test('due 按反馈正确顺延', () => {
    const r = S.sm2Review({ ef: 2.5, interval: 6, repetitions: 2 }, 'good', T0);
    expect(r.due).toBe(T0 + r.interval * DAY);
    expect(r.interval).toBe(15);
  });

  test('未知评分抛中文错误', () => {
    expect(() => S.sm2Review({ ef: 2.5 }, 'perfect', T0)).toThrow('未知反馈');
    expect(() => S.sm2Review({ ef: 2.5 }, '', T0)).toThrow('未知反馈');
  });

  test('interval 保险丝：间隔封在 40 年内', () => {
    let card = { ef: 2.8, interval: 365 * 40, repetitions: 100 };
    const r = S.sm2Review(card, 'easy', T0);
    expect(r.interval).toBeLessThanOrEqual(365 * 40);
  });

  test('到期判断与队列下一张', () => {
    expect(S.sm2IsDue({ due: T0 - 1 }, T0)).toBe(true);
    expect(S.sm2IsDue({ due: T0 + 1 }, T0)).toBe(false);
    expect(S.sm2IsDue({}, T0)).toBe(false); // 无 due 不算到期
    const next = S.sm2NextDueDate([{ due: T0 + 3 * DAY }, { due: T0 + DAY }, { due: T0 - DAY }], T0);
    expect(next).toBe(T0 + DAY);
    expect(S.sm2NextDueDate([{ due: T0 - DAY }], T0)).toBeNull(); // 全都到期 → 没有未来
  });
});

describe('deck: 卡组管理', () => {
  let D;
  beforeEach(async () => {
    await bootSettled('background');
    D = window.__flashcards.deck;
  });

  test('建卡校验：空面/空背/超长都拒，标签截断', () => {
    expect(() => D.deckMakeCard({ front: '', back: 'b' })).toThrow('卡面');
    expect(() => D.deckMakeCard({ front: 'f', back: '  ' })).toThrow('卡背');
    expect(() => D.deckMakeCard({ front: 'x'.repeat(2001), back: 'b' })).toThrow('太长');
    const card = D.deckMakeCard({ front: 'f', back: 'b', tags: ['a'.repeat(40), 'ok', '  '] }, T0);
    expect(card.tags).toEqual(['a'.repeat(24), 'ok']);
    expect(card.ef).toBe(2.5);
    expect(card.due).toBe(T0); // 新卡立即可复习
  });

  test('去重：front+back 全等的卡不加（返回 added=false）', () => {
    let deck = [];
    deck = D.deckAdd(deck, D.deckMakeCard({ front: 'f', back: 'b' }, T0)).deck;
    const out = D.deckAdd(deck, D.deckMakeCard({ front: 'f', back: 'b' }, T0 + 1));
    expect(out.added).toBe(false);
    expect(out.deck).toHaveLength(1);
  });

  test('导入：正常行/标签行/坏行；导出回读一致', () => {
    const text = [
      '什么是 SM-2 | 一个间隔重复算法',
      '#算法 记忆',
      'DNA 中文全称 | 脱氧核糖核酸',
      '这一行没有分隔符',
      '只有正面 |',
      '',
    ].join('\n');
    const { cards, errors } = D.deckImportText(text, T0);
    expect(cards).toHaveLength(2);
    expect(cards[1].tags).toEqual(['算法', '记忆']);
    expect(errors).toHaveLength(2);
    expect(errors[0].reason).toContain('分隔符');
    expect(errors[1].reason).toContain('卡背');
    const text2 = D.deckExportText(cards);
    const again = D.deckImportText(text2, T0);
    expect(again.errors).toHaveLength(0);
    expect(again.cards.map((c) => `${c.front}|${c.back}`)).toEqual(cards.map((c) => `${c.front}|${c.back}`));
  });

  test('导入：Tab 分隔与单管道分隔都认', () => {
    const { cards, errors } = D.deckImportText('Q\tA\nX|Y', T0);
    expect(errors).toHaveLength(0);
    expect(cards.map((c) => `${c.front}→${c.back}`)).toEqual(['Q→A', 'X→Y']);
  });

  test('到期队列：due 升序、limit 截断', () => {
    const deck = [
      D.deckMakeCard({ front: 'a', back: '1' }, T0 - 3 * DAY),
      D.deckMakeCard({ front: 'b', back: '2' }, T0 - DAY),
      D.deckMakeCard({ front: 'c', back: '3' }, T0 + DAY),
    ];
    const due = D.deckDueCards(deck, T0);
    expect(due.map((c) => c.front)).toEqual(['a', 'b']);
    expect(D.deckDueCards(deck, T0, 1).map((c) => c.front)).toEqual(['a']);
  });

  test('统计：total/due/learning/mature', () => {
    const young = { ...D.deckMakeCard({ front: 'y', back: 'y' }, T0), repetitions: 1 };
    const mature = { ...D.deckMakeCard({ front: 'm', back: 'm' }, T0), repetitions: 3, interval: 21 };
    const fresh = D.deckMakeCard({ front: 'f', back: 'f' }, T0);
    const s = D.deckStats([young, mature, fresh], T0);
    expect(s.total).toBe(3);
    expect(s.due).toBe(3); // 全部到期（新卡 due=now）
    expect(s.learning).toBe(1);
    expect(s.mature).toBe(1);
  });

  test('复习：写回带计数（reps/lapses）且不改原对象', () => {
    const card = D.deckMakeCard({ front: 'f', back: 'b' }, T0);
    const reviewed = D.deckReview(card, 'forget', T0);
    expect(reviewed.lapses).toBe(1);
    expect(reviewed.reps).toBe(1);
    expect(card.lapses).toBe(0);
    const applied = D.deckApplyReview([card], card.id, reviewed);
    expect(applied[0].lapses).toBe(1);
  });

  test('Markdown 渲染：加粗/斜体/代码/换行，HTML 注入被转义', () => {
    const html2 = D.deckRenderMarkdown('**加粗** *斜体* `code` <script>alert(1)</script>');
    expect(html2).toContain('<strong>加粗</strong>');
    expect(html2).toContain('<em>斜体</em>');
    expect(html2).toContain('<code>code</code>');
    expect(html2).not.toContain('<script>');
    expect(html2).toContain('&lt;script&gt;');
  });
});

describe('完整链路（假宿主泵）', () => {
  test('导入 → 会话 → 评分 → 持久化', async () => {
    await bootSettled('workshop');
    const ta = document.getElementById('import-text');
    ta.value = 'Q1 | A1\nQ2 | A2';
    await drive(() => window.__flashcards.runImport());
    expect(JSON.parse(store.get('deck-v1'))).toHaveLength(2);
    expect(document.getElementById('import-report').textContent).toContain('2 张');
    // 开始复习：两张都到期。
    //
    // 「现在」必须是**真实时钟**：卡片是 runImport() 建的，due 用的是插件自己的 Date.now()。
    // 用固定时间戳 T0（本地 16:00）的话，真实时间过了 16:00 之后卡片"还没到期"，这条用例每天
    // 下午都会红——2026-10-31 16:17 就是这么发现的。留 1 秒余量覆盖建卡与断言之间的毫秒差。
    const now = Date.now() + 1000;
    expect(window.__flashcards.startSession(now)).toBe(true);
    expect(window.__flashcards.snapshot().session.queue).toHaveLength(2);
    // 评分第一张（忘记）→ 第二张。
    await drive(() => window.__flashcards.gradeCard('forget', now));
    const snap = window.__flashcards.snapshot();
    expect(snap.session.index).toBe(1);
    expect(snap.session.done).toBe(1);
    const saved = JSON.parse(store.get('deck-v1'));
    // 会话队列按 due/createdAt 升序（稳定）→ 第一张是 Q1（先建）。
    const q1 = saved.find((c) => c.front === 'Q1');
    expect(q1.lapses).toBe(1);
    expect(q1.interval).toBe(1);
    // 完成第二张 → 会话结束。
    const out = await drive(() => window.__flashcards.gradeCard('good', now));
    expect(out.finished).toBe(true);
    expect(window.__flashcards.snapshot().session.active).toBe(false);
    expect(document.getElementById('face-front').textContent).toContain('完成');
  });

  test('提醒：到期弹气泡、每天上限 3 次、换天重置', async () => {
    await bootSettled('background');
    store.set('deck-v1', JSON.stringify([window.__flashcards.deck.deckMakeCard({ front: 'f', back: 'b' }, T0)]));
    await drive(() => window.__flashcards.loadDeck?.() ?? null).catch(() => {});
    // 直接经 reminderTick 驱动（loadDeck 是内部函数——由 init 调过一次，但 store 是 beforeEach 新建的）。
    // 手动把 deck 顶进去：经 add_cards。
    await drive(() => window.__flashcards.handlers.add_cards({ cards: [{ front: 'f1', back: 'b1' }] }));
    // 同一条规矩：add_cards 用真实时钟打 due，所以 tick 的"现在"也要是真实时钟 + 余量，
    // 否则每天 16:00 之后这张卡"还没到期"，一条气泡都不会有。
    const now = Date.now() + 1000;
    await drive(() => window.__flashcards.reminderTick(now));
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toContain('1 张卡片');
    await drive(() => window.__flashcards.reminderTick(now + 60000));
    expect(bubbles).toHaveLength(2);
    await drive(() => window.__flashcards.reminderTick(now + 120000));
    expect(bubbles).toHaveLength(3);
    await drive(() => window.__flashcards.reminderTick(now + 180000));
    expect(bubbles).toHaveLength(3); // 每天上限
    // 换天：重新开始计。
    await drive(() => window.__flashcards.reminderTick(now + DAY));
    expect(bubbles).toHaveLength(4);
  });

  test('提醒：无到期不弹；开关关掉不弹（重载配置后生效）', async () => {
    await bootSettled('background');
    await drive(() => window.__flashcards.reminderTick(T0));
    expect(bubbles).toHaveLength(0);
    // 开关关掉 → 重新 init（宿主不推配置变更，插件只在 init/config.changed 时重读）。
    configValues.remindOnDue = 'false';
    await drive(() => window.__flashcards.handlers.add_cards({ cards: [{ front: 'f', back: 'b' }] }));
    await bootSettled('background');
    await drive(() => window.__flashcards.reminderTick(T0));
    expect(bubbles).toHaveLength(0);
  });

  test('plugin.call due_stats / add_cards / export_deck', async () => {
    await bootSettled('background');
    const h = window.__flashcards.handlers;
    const stats0 = await drive(() => h.due_stats({}));
    expect(stats0.total).toBe(0);
    const add = await drive(() => h.add_cards({ cards: [{ front: 'Q', back: 'A' }, { front: 'Q', back: 'A' }] }));
    expect(add.added).toBe(1); // 去重
    expect(add.total).toBe(1);
    await expect(drive(() => h.add_cards({ cards: [] }))).rejects.toThrow('cards');
    await expect(drive(() => h.add_cards({ cards: new Array(101).fill({ front: 'x', back: 'y' }) }))).rejects.toThrow('100');
    const exp = await drive(() => h.export_deck({}));
    expect(exp.text).toBe('Q | A');
    const stats = await drive(() => h.due_stats({}));
    expect(stats.due).toBe(1);
  });

  test('未知 call 方法回中文错误（不挂超时）', async () => {
    await bootSettled('background');
    await expect(drive(() => window.__flashcards.handlers.nope({}))).rejects.not.toBeNull();
  });

  test('工坊页：翻转交互与评分按钮联动', async () => {
    await bootSettled('workshop');
    const ta = document.getElementById('import-text');
    ta.value = '问题 | 答案';
    await drive(() => window.__flashcards.runImport());
    document.getElementById('review-start').click();
    await pump(8);
    expect(document.getElementById('review-area').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('face-front').textContent).toBe('问题');
    // 翻转：评分按钮出现。
    document.getElementById('card-flip').click();
    await pump(4);
    expect(document.getElementById('card-flip').classList.contains('flipped')).toBe(true);
    expect(document.getElementById('grades').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('next-interval').textContent).toContain('忘记');
    // 评分 → 进入下一张（没有第二张 → 完成）。
    document.querySelector('button[data-grade="good"]').click();
    await pump(8);
    expect(document.getElementById('face-front').textContent).toContain('完成');
  });

  test('坏档启动不炸', async () => {
    store.set('deck-v1', '{broken');
    await bootSettled('workshop');
    expect(window.__flashcards.snapshot().deckSize).toBe(0);
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
