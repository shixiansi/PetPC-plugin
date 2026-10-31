import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 记账插件的行为测试。钉住的几件事：
//
//   1. 模型输出容错矩阵：标准 JSON / 围栏+废话 / 平衡块截取 / 全角+尾逗号+单引号修复 /
//      金额带单位 / 类别同义词 / 类型中文 —— 全部能进账；
//   2. 脏数据防线：汉字金额、0 元、未知类型、荒谬日期 → 拒绝（返回 reason，重试）；
//      **绝不写猜测值**；
//   3. 重试链：第一次坏输出 → 第二次带错误反馈重试成功；模型挂掉不重试；
//   4. 账本：JSONL 追加、月索引、坏行跳过计数、按 id 删除、月度聚合（分类降序、缺日补 0）；
//   5. 预筛：像记账的话才调模型（省额度）；
//   6. 图表几何：环形图段数=分类数、折线图点数=天数、峰值标注；
//   7. 完整链路：假宿主泵 chat_on_message → llm.chat → 入账 → 看板渲染。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-expense-tracker');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((m) => m[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');
const source = scriptSources
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-expense-tracker';
const NOW = Date.parse('2026-10-31T12:00:00Z');

// --- 消息泵 -----------------------------------------------------------------------

let store;
let configValues;
let llmReplies;       // llm.chat 的回复队列（字符串或 Error）
let llmCalls;
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
        case 'llm.chat': {
          llmCalls.push(payload);
          const reply = llmReplies.length ? llmReplies.shift() : '{"amount":1,"type":"expense","category":"其他","date":"2026-10-31"}';
          if (reply instanceof Error) answer(req.id, null, { ok: false, error: reply.message });
          else answer(req.id, { requestId: 'sim', text: reply });
          break;
        }
        case 'storage.get':
          answer(req.id, { value: store.has(String(payload.key)) ? store.get(String(payload.key)) : '' });
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
  configValues = { bubbleOnRecord: 'true' };
  llmReplies = [];
  llmCalls = [];
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
  test('permissions: storage/config/call/llm.chat/llm.borrow/bubble', () => {
    expect([...manifest.permissions].sort()).toEqual([
      'llm.borrow', 'llm.chat', 'pet.bubble', 'plugin.call', 'plugin.config', 'storage',
    ]);
  });

  test('背景帧由 llm.chat 门控；llmApiKey 是第一个 secret', () => {
    expect(manifest.background).toBe(true);
    const secret = manifest.config.find((c) => c.type === 'secret');
    expect(secret.key).toBe('llmApiKey');
  });

  test('serves 三个方法', () => {
    expect(manifest.serves).toEqual(['chat_on_message', 'month', 'stats']);
  });
});

describe('parse: 模型输出容错矩阵', () => {
  let P;
  beforeEach(async () => {
    await bootSettled('background');
    P = window.__expenses.parse;
  });

  test('标准 JSON 直接过', () => {
    const r = P.parseModelReply('{"amount": 25, "type": "expense", "category": "交通", "date": "2026-10-31", "note": "打车", "raw": "打车25块"}', NOW);
    expect(r.ok).toBe(true);
    expect(r.entry.amount).toBe(25);
    expect(r.entry.category).toBe('交通');
    expect(r.entry.type).toBe('expense');
    expect(r.entry.day).toBe('2026-10-31');
    expect(r.entry.raw).toBe('打车25块');
  });

  test('围栏 + 前后废话：剥围栏取 JSON；金额带单位被抠出', () => {
    const r = P.parseModelReply('好的，解析结果：\n```json\n{"amount": "¥25.5", "type": "expense", "category": "打车", "date": "今天"}\n```\n希望有帮助', NOW);
    expect(r.ok).toBe(true);
    expect(r.entry.amount).toBe(25.5);
    expect(r.entry.category).toBe('交通'); // 打车 → 交通
    expect(r.entry.day).toBe('2026-10-31'); // 今天 → 当天
  });

  test('JSON 外裹话：平衡块截取', () => {
    const r = P.parseModelReply('这是 { 结果：{"amount": 12, "type": "expense", "category": "餐饮", "date": "2026-10-30"} } 完毕', NOW);
    expect(r.ok).toBe(true);
    expect(r.entry.amount).toBe(12);
  });

  test('宽松修复：无引号键 + 单引号 + 尾逗号 + 全角标点', () => {
    const r = P.parseModelReply('{amount： 25， type: \'expense\', category: \'吃饭\', date: \'2026-10-31\',}', NOW);
    expect(r.ok).toBe(true);
    expect(r.entry.amount).toBe(25);
    expect(r.entry.category).toBe('餐饮');
  });

  test('中文键也能解析（模型自由发挥）', () => {
    const r = P.parseModelReply('{"金额": "30块", "类型": "expense", "分类": "地铁", "日期": "2026-10-31"}', NOW);
    expect(r.ok).toBe(true);
    expect(r.entry.amount).toBe(30);
    expect(r.entry.category).toBe('交通');
  });

  test('收入：同义词映射进收入类目', () => {
    const r = P.parseModelReply('{"amount": 5000, "type": "income", "category": "薪水", "date": "2026-10-31"}', NOW);
    expect(r.entry.type).toBe('income');
    expect(r.entry.category).toBe('工资');
  });

  test('退款类型', () => {
    const r = P.parseModelReply('{"amount": 20, "type": "refund", "category": "报销", "date": "2026-10-31"}', NOW);
    expect(r.entry.type).toBe('refund');
  });

  test('脏数据拒绝（返回 reason，绝不猜）', () => {
    const cases = [
      ['{"amount": "二十五", "type": "expense", "category": "餐饮", "date": "2026-10-31"}', '金额'],
      ['{"amount": 0, "type": "expense", "category": "餐饮", "date": "2026-10-31"}', '金额'],
      ['{"amount": -5, "type": "expense", "category": "餐饮", "date": "2026-10-31"}', '金额'],
      ['{"amount": 5, "type": "转账支出", "category": "餐饮", "date": "2026-10-31"}', '类型'],
      ['{"amount": 5, "type": "expense", "category": "餐饮", "date": "上周三"}', '日期'],
      ['今天天气不错', 'JSON'],
      ['', '没有返回'],
    ];
    for (const [reply, part] of cases) {
      const r = P.parseModelReply(reply, NOW);
      expect(r.ok, reply).toBe(false);
      expect(r.reason, reply).toContain(part);
    }
  });

  test('白名单外类目归"其他"，不拒绝', () => {
    const r = P.parseModelReply('{"amount": 88, "type": "expense", "category": "宠物用品", "date": "2026-10-31"}', NOW);
    expect(r.ok).toBe(true);
    expect(r.entry.category).toBe('其他');
  });

  test('荒谬大金额拒（>1000 万）', () => {
    const r = P.parseModelReply('{"amount": 99999999, "type": "expense", "category": "其他", "date": "2026-10-31"}', NOW);
    expect(r.ok).toBe(false);
  });

  test('looksLikeExpense 预筛', () => {
    expect(P.looksLikeExpense('帮我记一下，打车花了 25 块')).toBe(true);
    expect(P.looksLikeExpense('今天发了 5000 工资')).toBe(true);
    expect(P.looksLikeExpense('今天心情不错')).toBe(false);
    expect(P.looksLikeExpense('没有数字')).toBe(false);
    expect(P.looksLikeExpense('一段很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长的不是记账的话 25')).toBe(false);
  });

  test('prompt 要求严格 JSON 且带原话', () => {
    const prompt = P.buildParsePrompt('打车25块');
    expect(prompt).toContain('JSON');
    expect(prompt).toContain('打车25块');
    expect(prompt).toContain('expense');
  });
});

describe('ledger: 账本', () => {
  let L;
  beforeEach(async () => {
    await bootSettled('background');
    L = window.__expenses.ledger;
  });

  function makeStore() {
    const mem = new Map();
    const gw = async (m, p2) => {
      if (m === 'storage.get') return { value: mem.has(p2.key) ? mem.get(p2.key) : '' };
      if (m === 'storage.set') { mem.set(p2.key, String(p2.value ?? '')); return { ok: true }; }
      throw new Error(`nope ${m}`);
    };
    gw.mem = mem;
    return { store: L.ledgerCreateStore(gw), mem };
  }

  test('追加：入当月文件 + 维护索引', async () => {
    const { store, mem } = makeStore();
    await L.ledgerAppend(store, { id: 'e1', day: '2026-10-31', type: 'expense', amount: 25, category: '交通', at: 1, note: '', raw: '' });
    await L.ledgerAppend(store, { id: 'e2', day: '2026-10-15', type: 'expense', amount: 15, category: '餐饮', at: 2, note: '', raw: '' });
    expect(mem.get('ledger/index')).toBe('["2026-10"]');
    const raw = mem.get('ledger/2026-10.jsonl');
    expect(raw.split('\n')).toHaveLength(2);
    expect(JSON.parse(raw.split('\n')[0]).id).toBe('e1');
  });

  test('坏行跳过并计数（脏数据不崩账本）', async () => {
    const { store, mem } = makeStore();
    mem.set('ledger/2026-09.jsonl', [
      '{broken',
      '{"id":"x","day":"2026-09-01","type":"expense","amount":5,"category":"其他","at":1}',
      '{"noAmount":true}',
      '',
    ].join('\n'));
    const { entries, badLines } = await L.ledgerMonthEntries(store, '2026-09');
    expect(entries).toHaveLength(1);
    expect(badLines).toBe(2);
    // 坏行之后正常追加不炸。
    await L.ledgerAppend(store, { id: 'y', day: '2026-09-02', type: 'expense', amount: 6, category: '其他', at: 2, note: '', raw: '' });
    const after = await L.ledgerMonthEntries(store, '2026-09');
    expect(after.entries).toHaveLength(2);
  });

  test('月度聚合：分类降序、share、缺日补 0、收入不计入支出分类', async () => {
    const { store } = makeStore();
    const entries = [
      { id: 'a', day: '2026-10-01', type: 'expense', amount: 300, category: '购物', at: 1 },
      { id: 'b', day: '2026-10-02', type: 'expense', amount: 700, category: '餐饮', at: 2 },
      { id: 'c', day: '2026-10-02', type: 'expense', amount: 100, category: '餐饮', at: 3 },
      { id: 'd', day: '2026-10-05', type: 'income', amount: 5000, category: '工资', at: 4 },
    ];
    const agg = L.ledgerAggregate(entries, '2026-10');
    expect(agg.totals.expense).toBe(1100);
    expect(agg.totals.income).toBe(5000);
    expect(agg.totals.count).toBe(4);
    expect(agg.byCategory[0].category).toBe('餐饮');
    expect(agg.byCategory[0].total).toBe(800);
    expect(agg.byCategory[0].share).toBeCloseTo(800 / 1100, 5);
    expect(agg.byDay).toHaveLength(31); // 10 月 31 天
    expect(agg.byDay[0]).toEqual({ day: '2026-10-01', total: 300 });
    expect(agg.byDay[1]).toEqual({ day: '2026-10-02', total: 800 });
    expect(agg.byDay[4]).toEqual({ day: '2026-10-05', total: 0 }); // 收入不算支出
    expect(agg.byDay[10].total).toBe(0); // 缺日补 0
  });

  test('删除：按 id 全索引找，删后文件更新', async () => {
    const { store } = makeStore();
    await L.ledgerAppend(store, { id: 'e1', day: '2026-10-31', type: 'expense', amount: 25, category: '交通', at: 1, note: '', raw: '' });
    const out = await L.ledgerRemove(store, 'e1');
    expect(out.removed).toBe(true);
    const { entries } = await L.ledgerMonthEntries(store, '2026-10');
    expect(entries).toHaveLength(0);
    expect((await L.ledgerRemove(store, 'nope')).removed).toBe(false);
  });

  test('append 拒绝缺 day/amount 的账目', async () => {
    const { store } = makeStore();
    await expect(L.ledgerAppend(store, { id: 'x', type: 'expense', amount: 5 })).rejects.toThrow('day');
    await expect(L.ledgerAppend(store, { id: 'x', day: '2026-10-01', type: 'expense', amount: NaN })).rejects.toThrow('day');
  });
});

describe('charts: SVG 几何', () => {
  let C;
  beforeEach(async () => {
    await bootSettled('background');
    C = window.__expenses.charts;
  });

  test('环形图：每分类一段 + 底环 + 中心文字；空数据只有底环', () => {
    const svg = C.chartDonut([
      { category: '餐饮', total: 800, share: 0.72 },
      { category: '交通', total: 300, share: 0.28 },
    ], 1100);
    // 底环 1 + 数据段 2。
    expect((svg.match(/<circle/g) || []).length).toBe(3);
    expect(svg).toContain('月支出');
    const empty = C.chartDonut([], 0);
    expect((empty.match(/<circle/g) || []).length).toBe(1);
    expect(empty).toContain('月支出');
  });

  test('环形图段色循环使用 token 变量', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ category: `c${i}`, total: 1, share: 1 / 12 }));
    const svg = C.chartDonut(many, 12);
    expect(svg).toContain('var(--accent)');
  });

  test('图例：每类一项带百分比', () => {
    const legend = C.chartLegend([
      { category: '餐饮', total: 800, share: 0.72 },
      { category: '交通', total: 300, share: 0.28 },
    ]);
    expect(legend).toContain('餐饮 72%');
    expect(legend).toContain('交通 28%');
  });

  test('折线图：31 个点的 polyline + 网格 + 峰值标注', () => {
    const byDay = Array.from({ length: 31 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, total: i === 14 ? 500 : (i % 7) * 10 }));
    const svg = C.chartTrend(byDay);
    const line = svg.match(/<polyline[^>]*points="([^"]+)"/);
    expect(line).toBeTruthy();
    expect(line[1].split(' ')).toHaveLength(31);
    expect(svg).toContain('trend-peak');
    expect(svg).toContain('500');
  });

  test('全 0 月：折线在基线、max 取 1 防除零', () => {
    const byDay = Array.from({ length: 30 }, (_, i) => ({ day: `2026-11-${String(i + 1).padStart(2, '0')}`, total: 0 }));
    const svg = C.chartTrend(byDay);
    expect(svg).toContain('polyline');
    expect(svg).not.toContain('NaN');
  });
});

describe('完整链路（假宿主泵）', () => {
  test('chat_on_message：像记账的话 → llm 解析 → 入账 → 气泡确认', async () => {
    await bootSettled('background');
    llmReplies.push('{"amount": 25, "type": "expense", "category": "打车", "date": "2026-10-31", "note": "打车", "raw": "打车25块"}');
    const out = await drive(() => window.__expenses.handlers.chat_on_message({ text: '帮我记一下，打车花了 25 块' }));
    expect(out.ok).toBe(true);
    expect(out.entry.amount).toBe(25);
    expect(out.entry.category).toBe('交通');
    expect(llmCalls).toHaveLength(1);
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toContain('交通');
    const raw = store.get('ledger/2026-10.jsonl');
    expect(JSON.parse(raw).amount).toBe(25);
  });

  test('不像记账的话：不调模型直接回 not-expense', async () => {
    await bootSettled('background');
    const out = await drive(() => window.__finance === undefined ? window.__expenses.handlers.chat_on_message({ text: '今天天气不错' }) : null);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('not-expense');
    expect(llmCalls).toHaveLength(0);
  });

  test('第一次坏输出 → 带反馈重试成功（prompt 里点名问题）', async () => {
    await bootSettled('background');
    llmReplies.push('我觉得这笔是二十五块钱左右'); // 第一次：不可解析
    llmReplies.push('{"amount": 25, "type": "expense", "category": "餐饮", "date": "2026-10-31"}'); // 第二次：好
    const out = await drive(() => window.__expenses.parseWithRetry('午饭花了 25 块', NOW));
    expect(out.ok).toBe(true);
    expect(out.attempts).toBe(2);
    expect(llmCalls).toHaveLength(2);
    // 第二次 prompt 带上了第一次的坏输出与原因。
    expect(llmCalls[1].text).toContain('二十五');
    expect(llmCalls[1].text).toContain('重新输出');
  });

  test('两次都失败：放弃并返回原因，账本不写', async () => {
    await bootSettled('background');
    llmReplies.push('第一次不行');
    llmReplies.push('第二次也不行');
    const out = await drive(() => window.__expenses.recordEntry('买了个东西', 'chat', NOW));
    expect(out.ok).toBe(false);
    expect(llmCalls).toHaveLength(2);
    expect(store.has('ledger/2026-10.jsonl')).toBe(false);
  });

  test('模型挂掉（未配置）：不重试，直接失败', async () => {
    await bootSettled('background');
    llmReplies.push(new Error('未获权限 llm.chat'));
    const out = await drive(() => window.__expenses.recordEntry('打车 25 块', 'chat', NOW));
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('模型调用失败');
    expect(llmCalls).toHaveLength(1);
  });

  test('手动记账：金额校验、入账、看板刷新', async () => {
    await bootSettled('workshop');
    document.getElementById('manual-amount').value = '42.5';
    document.getElementById('manual-category').value = '餐饮';
    document.getElementById('manual-note').value = '午饭';
    await drive(() => window.__expenses.addManual());
    const raw = store.get('ledger/2026-10.jsonl');
    const entry = JSON.parse(raw);
    expect(entry.amount).toBe(42.5);
    expect(entry.category).toBe('餐饮');
    // 看板渲染出了环形图与流水。
    expect(document.getElementById('donut').innerHTML).toContain('circle');
    expect(document.querySelectorAll('.ledger-item').length).toBe(1);
    // 非法金额被拒。
    document.getElementById('manual-amount').value = 'abc';
    await drive(() => window.__expenses.addManual());
    expect(document.getElementById('status').textContent).toContain('数字');
  });

  test('账本里有坏行：看板照常渲染并提示', async () => {
    store.set('ledger/2026-10.jsonl', '{broken\n{"id":"x","day":"2026-10-01","type":"expense","amount":9.9,"category":"餐饮","at":1}\n');
    await bootSettled('workshop');
    expect(document.querySelectorAll('.ledger-item').length).toBe(1);
    expect(document.getElementById('status').textContent).toContain('坏数据');
  });

  test('月切换：上月/下月按钮换文件', async () => {
    store.set('ledger/2026-09.jsonl', '{"id":"s","day":"2026-09-10","type":"expense","amount":66,"category":"娱乐","at":1}\n');
    await bootSettled('workshop');
    expect(document.getElementById('chip-month').textContent).toBe('2026-10');
    document.getElementById('month-prev').click();
    await pump(10);
    expect(document.getElementById('chip-month').textContent).toBe('2026-09');
    expect(document.getElementById('ledger-list').textContent).toContain('66');
  });

  test('plugin.call month/stats', async () => {
    await bootSettled('background');
    await drive(() => window.__expenses.handlers.chat_on_message({ text: 'x' })).catch(() => {});
    store.set('ledger/2026-10.jsonl', '{"id":"x","day":"2026-10-01","type":"expense","amount":9.9,"category":"餐饮","at":1}\n{broken\n');
    const month = await drive(() => window.__expenses.handlers.month({ month: '2026-10' }));
    expect(month.totals.expense).toBe(9.9);
    expect(month.badLines).toBe(1);
    const stats = await drive(() => window.__expenses.handlers.stats({}));
    expect(stats.count).toBe(1);
    expect(stats.badLines).toBe(1);
  });

  test('未知 call 方法回中文错误（handler 缺失 = 方法没实现）', async () => {
    await bootSettled('background');
    expect(window.__expenses.handlers.bogus).toBeUndefined();
    // 走协议层：onCall 对未实现方法要回一条 call-result 错误（不挂 30 秒超时）。
    let done = false;
    const before = posted.mock.calls.length;
    hostSends({ v: 1, type: 'call', ticket: 't1', from: 'other', method: 'bogus', payload: {} });
    await pump(4);
    const results = posted.mock.calls.slice(before).map((c) => c[0]).filter((m) => m.type === 'call-result');
    expect(results.length).toBe(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('只回答');
    void done;
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
