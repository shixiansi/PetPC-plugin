import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 定时记忆压缩（memcore 0.3.0）的测试 + 压力测试。
//
// 与 plugin-memcore.test.js 同一 harness（jsdom + 假宿主 + settle()），但这里钉的是压缩：
//
//   1. 判定纯函数：dayKeyOf / previousDayKey / dayOfTurn / parseL3 / compactPrompt；
//   2. compactRoleDay：材料齐 → 一次请求产出 ≤200 字 L3；没材料 → skipped:'no-material'；
//   3. 幂等：同一天重复触发跳过；state/compact.lastDay 推进；
//   4. 定时 tick：本地日期一变才跑，同一天内反复 tick 不跑；
//   5. 压力：模拟 100 轮对话（L1 反复滚动、L2 反复晋升），逐日压缩后验证上下文连贯——
//      第 N 天的 L3 接得上第 N-1 天的故事线（测试用模型脚本返回"接前文"的摘要），
//      且 L3 存档 ≤ L3_MAX、每条 ≤200 字。
//
// "连贯性"的可测定义：压缩请求的 prompt 里**必须**带着已有最后一段 L3（除非它是第一条），
// 且 L3 存档按天有序、去重（同一天只有一段）。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-memcore');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((m) => m[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');
const source = scriptSources
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-memcore';

// --- harness（与 memcore 主测试同型，这里只留需要的部分） ------------------------------

let store = new Map();
let configValues = {};
let llmReplies = [];
let llmCalls = [];
let answered = new Set();
let postedFrom = 0;
let windowListeners = [];
let intervals = [];
let timeouts = [];

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

function answerPlumbing() {
  let answeredNow = 0;
  for (const req of requests()) {
    if (answered.has(req.id)) continue;
    answeredNow += 1;
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
        answer(req.id, { removed: true });
        break;
      case 'storage.list': {
        const sub = String(payload.sub || '');
        const prefix = sub ? `${sub}/` : '';
        const files = [];
        const dirs = new Set();
        for (const [key, value] of store) {
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          if (!rest) continue;
          const slash = rest.indexOf('/');
          if (slash < 0) files.push({ name: rest, bytes: String(value).length });
          else dirs.add(rest.slice(0, slash));
        }
        answer(req.id, { dir: 'C:\\data\\memcore', files, dirs: [...dirs] });
        break;
      }
      case 'llm.chat': {
        llmCalls.push(payload);
        const reply = llmReplies.length ? llmReplies.shift() : '（模拟回答）';
        answer(req.id, { requestId: 'sim', text: reply });
        break;
      }
      default:
        answer(req.id, null, { ok: false, error: `本程序不支持该方法 ${req.method}` });
        break;
    }
  }
  return answeredNow;
}

const macro = () => new Promise((resolve) => setTimeout(resolve, 0));

async function settle(maxRounds = 80) {
  let idle = 0;
  for (let i = 0; i < maxRounds; i += 1) {
    const before = posted().length;
    const answeredNow = answerPlumbing();
    await macro();
    if (answeredNow === 0 && before === posted().length) {
      idle += 1;
      if (idle >= 3) return;
    } else {
      idle = 0;
    }
  }
}

function installPanel() {
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
}

async function loadApp() {
  answered = new Set();
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  for (const id of intervals) window.clearInterval(id);
  for (const id of timeouts) window.clearTimeout(id);
  intervals = [];
  timeouts = [];
  vi.resetModules();
  postedFrom = window.postMessage.mock.calls.length;
  // eslint-disable-next-line no-new-func
  new Function(source)();
}

async function boot({ slot = 'background' } = {}) {
  installPanel();
  await loadApp();
  await macro();
  hostSends({
    v: 1, type: 'init', pluginId: PLUGIN_ID,
    permissions: manifest.permissions, granted: [...manifest.permissions],
    surface: { kind: 'panel', slot }, theme: 'dark',
  });
  await settle();
}

async function call(method, payload, ticket = `t${Math.random().toString(36).slice(2, 8)}`) {
  hostSends({ v: 1, type: 'call', ticket, from: 'com.example.tester', method, payload });
  await settle();
  const result = byType('call-result').filter((m) => m.ticket === ticket);
  return result.length ? result[result.length - 1] : null;
}

/** 把所有时间走查（压缩的 setTimeout(15s) 补跑与 setInterval(60s) 都在这里收掉）。 */
function drainTimers() {
  for (const id of intervals) window.clearInterval(id);
  for (const id of timeouts) window.clearTimeout(id);
  intervals = [];
  timeouts = [];
}

beforeEach(() => {
  document.body.innerHTML = '';
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  for (const id of intervals) window.clearInterval(id);
  for (const id of timeouts) window.clearTimeout(id);
  intervals = [];
  timeouts = [];
  store = new Map();
  configValues = {
    personaName: '小记',
    persona: '',
    replyMaxChars: '240',
    bufferTurns: '8',
    summaryChars: '500',
    episodeMax: '40',
    profileEvery: '0', // 压力测试里不要画像，避免它抢模型回复的序列
    compactEnabled: 'true',
    llmDailyBudget: '0', // 0 = 不限（本插件 0.2.0 的语义是不限？不——手册：0=不限）
  };
  llmReplies = [];
  llmCalls = [];
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
  vi.spyOn(window, 'postMessage').mockImplementation(() => {});
});

afterEach(() => {
  drainTimers();
  vi.restoreAllMocks();
});

/** 从纯函数模块里取判定函数。
 *
 * compact.js 依赖 core.js 的 parseObject/text/now 与 memory.js 的 rolePath/readJSON
 * ——它们是同一文档里的经典脚本全局。按 panel.html 的顺序把 core + memory + compact
 * 拼进同一作用域，CJS 导出分支把判定函数带出来（memory.js 没有 exports 分支也无妨）。
 */
function pure() {
  const sandbox = { exports: {} };
  const libs = ['lib/core.js', 'lib/memory.js', 'lib/compact.js']
    .map((f) => readFileSync(path.join(pluginDir, f), 'utf8'));
  // eslint-disable-next-line no-new-func
  const documentStub = { getElementById: () => null };
  new Function('window', 'module', 'document', libs.join('\n'))(
    { setInterval() { return 0; }, clearInterval() {} },
    sandbox,
    documentStub,
  );
  return sandbox.exports;
}

// --- 判定纯函数 -----------------------------------------------------------------

describe('判定纯函数', () => {
  const P = pure();

  test('dayKeyOf / previousDayKey：本地时区的 YYYY-MM-DD', () => {
    expect(P.dayKeyOf(new Date(2026, 9, 30, 7, 30))).toBe('2026-10-30');
    expect(P.previousDayKey(new Date(2026, 9, 30, 0, 5).getTime())).toBe('2026-10-29');
    // 跨月：3 月 1 日的昨天是 2 月 28/29（Date 自己算）
    expect(P.previousDayKey(new Date(2026, 2, 1, 0, 5).getTime())).toBe('2026-02-28');
  });

  test('dayOfTurn：按轮次的 at 归天', () => {
    const at = new Date(2026, 9, 29, 23, 59).getTime();
    expect(P.dayOfTurn({ at })).toBe('2026-10-29');
    expect(P.dayOfTurn({ at: 0 })).toBe('');
    expect(P.dayOfTurn(null)).toBe('');
  });

  test('parseL3：取 JSON 的 summary；解析不出整段当摘要；都截到 200 字', () => {
    expect(P.parseL3('{"summary":"今天聊了考试"}')).toBe('今天聊了考试');
    expect(P.parseL3('好的：{"summary":"今天聊了考试"} done')).toBe('今天聊了考试');
    expect(P.parseL3('一段没有 JSON 的话')).toBe('一段没有 JSON 的话');
    expect(P.parseL3('')).toBe('');
    const long = P.parseL3(`{"summary":"${'长'.repeat(300)}"}`);
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith('…')).toBe(true);
  });

  test('turnsOf：只挑当天的往来', () => {
    const d29 = new Date(2026, 9, 29, 12).getTime();
    const d30 = new Date(2026, 9, 30, 12).getTime();
    const turns = [
      { role: 'user', text: '29 的话', at: d29 },
      { role: 'assistant', text: '29 的答', at: d29 + 1000 },
      { role: 'user', text: '30 的话', at: d30 },
    ];
    expect(P.turnsOf(turns, '2026-10-29')).toHaveLength(2);
    expect(P.turnsOf(turns, '2026-10-30')).toHaveLength(1);
  });

  test('compactPrompt：带上一段 L3 与 L2 摘要；没材料返回 null', () => {
    const turns = [{ role: 'user', text: '今天考试考砸了', who: '阿明', at: 1 }];
    const withPrev = P.compactPrompt(turns, '2026-10-29', { text: '最近在准备考试' }, '昨天吵架了');
    expect(withPrev.system).toContain('上一段长期摘要');
    expect(withPrev.text).toContain('昨天吵架了');
    expect(withPrev.text).toContain('最近在准备考试');
    expect(withPrev.text).toContain('考试考砸了');

    const noPrev = P.compactPrompt(turns, '2026-10-29', null, '');
    expect(noPrev.text).not.toContain('上一段长期摘要');

    expect(P.compactPrompt([], '2026-10-29', null, '')).toBeNull();
  });
});

// --- 端到端：compact 的 plugin.call ---------------------------------------------

describe('compact 的 plugin.call', () => {
  test('有材料：一次请求产出 ≤200 字的 L3，写进 mem/role/<会话>/l3', async () => {
    await boot({ slot: 'background' });
    const day = new Date();
    day.setDate(day.getDate() - 1);
    const at = day.getTime();
    // L1 里的"昨天"
    store.set('mem/role/test-1/turns', JSON.stringify([
      { role: 'user', text: '我今天考砸了，好难过', at, who: '阿明' },
      { role: 'assistant', text: '别急，一次考试而已。', at: at + 1000 },
    ]));
    llmReplies.push(JSON.stringify({ summary: '阿明考试失利，情绪低落；我安慰了他一次。' }));

    const out = await call('compact', { daysBack: 1 });
    expect(out.ok).toBe(true);
    expect(out.result.ok).toBe(1);
    expect(out.result.skipped).toBe(0);

    const l3 = JSON.parse(store.get('mem/role/test-1/l3'));
    expect(l3).toHaveLength(1);
    expect(l3[0].day).toBe(Pure_day(at));
    expect(l3[0].text).toContain('考试');
    expect(l3[0].text.length).toBeLessThanOrEqual(200);
    // 状态推进
    expect(JSON.parse(store.get('state/compact')).lastDay).toBe(Pure_day(at));
    // 模型只被请了一次
    expect(llmCalls).toHaveLength(1);
  });

  test('没材料：skipped=no-material，不发模型请求', async () => {
    await boot({ slot: 'background' });
    const out = await call('compact', { daysBack: 1 });
    expect(out.ok).toBe(true);
    expect(out.result.days.every((d) => d.skipped && d.reason === 'no-material')).toBe(true);
    expect(llmCalls).toHaveLength(0);
  });

  test('同一天重复触发：第二次直接跳过（幂等）', async () => {
    await boot({ slot: 'background' });
    const day = new Date();
    day.setDate(day.getDate() - 1);
    store.set('mem/role/test-2/turns', JSON.stringify([
      { role: 'user', text: '明天见', at: day.getTime(), who: '阿花' },
    ]));
    llmReplies.push(JSON.stringify({ summary: '阿花约定明天见面。' }));
    const first = await call('compact', { daysBack: 1 });
    expect(first.result.ok).toBe(1);

    llmReplies.length = 0;
    llmCalls.length = 0;
    const second = await call('compact', { daysBack: 1 });
    expect(second.result.days).toHaveLength(0); // lastDay 已推进到昨天，没有"到期"的天
    expect(llmCalls).toHaveLength(0);
  });

  test('同一天的旧 L3 被替换而不是堆叠（去重）', async () => {
    await boot({ slot: 'background' });
    const day = new Date();
    day.setDate(day.getDate() - 1);
    const at = day.getTime();
    store.set('mem/role/test-3/turns', JSON.stringify([
      { role: 'user', text: '开始new内容', at, who: '阿明' },
    ]));
    // 预置一段旧的当天 L3
    store.set('mem/role/test-3/l3', JSON.stringify([{ at: at - 1000, day: Pure_day(at), text: '旧版本' }]));
    llmReplies.push(JSON.stringify({ summary: '新版本摘要' }));
    const out = await call('compact', { daysBack: 1 });
    expect(out.result.ok).toBe(1);
    const l3 = JSON.parse(store.get('mem/role/test-3/l3'));
    expect(l3.filter((e) => e.day === Pure_day(at))).toHaveLength(1);
    expect(l3[0].text).toBe('新版本摘要');
  });
});

/** Pure_day 的测试侧别名（避免与 harness 变量重名）。 */
function Pure_day(atMs) {
  const d = new Date(Number(atMs));
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}

// --- 压力测试：100 轮对话 + 逐日压缩 + 连贯性 ---------------------------------------

describe('压力测试：100 轮对话后的定时压缩与连贯性', () => {
  test('100 轮（L1 滚动 + L2 晋升）之后逐日压缩：L3 有序、≤200 字、prompt 接得上前文', async () => {
    await boot({ slot: 'background' });
    drainTimers(); // 手动逐日压缩，不要定时器插进来

    // --- 第一幕：100 轮对话，轮次的 at 分布在 10 个自然日里 -------------------------
    //
    // 每轮模型给一个带轮号的回答（检验"回答不串轮"）；L1 每轮都会滚动，bufferTurns=8
    // 意味着大约每 4 轮触发一次 L1→L2 晋升（晋升也花模型请求——统一用同一个回复序列）。
    const DAYS = 10;
    const TURNS_PER_DAY = 10; // 10 天 × 每天轮次 = 100 轮
    const base = new Date();
    base.setHours(12, 0, 0, 0);
    const dayAt = (d, i) => new Date(base.getFullYear(), base.getMonth(), base.getDate() - (DAYS - d), 12, i).getTime();

    // 直接把 100 轮灌进 L1 的键（走真实的 chat 100 次会花 100+ 次模型请求、耗时不可控；
    // 这里灌数据后用 2 次 chat 验证链路活着，压缩走它自己的路径）。
    const turns = [];
    for (let d = 1; d <= DAYS; d += 1) {
      for (let i = 1; i <= TURNS_PER_DAY; i += 1) {
        const at = dayAt(d, i);
        turns.push({ role: 'user', text: `D${d}-第${i}轮：我在准备第${(d - 1) * 10 + i}章的复习`, at, who: '阿明' });
        turns.push({ role: 'assistant', text: `D${d}-第${i}轮收到，记下了`, at: at + 500 });
      }
    }
    // L1 上限 bufferTurns=8 → 16 条：只装得下最后的往来。为了压缩"能压到每一天"，
    // 把 L1 的滚动历史摊开：每天只留当天的 2 轮（模拟"凌晨时 L1 还有昨天"的现实约束下，
    // 我们改为逐日触发压缩——这正是 compactDue 的用法）。
    store.set('mem/role/stress/turns', JSON.stringify(turns.slice(-16)));
    store.set('mem/role/stress/summary', JSON.stringify({ text: '此前摘要：阿明在按章节复习，进度顺利。', at: Date.now(), digests: 12 }));

    // --- 第二幕：模拟 100 轮的真实 chat（省模型次数：用 3 轮真跑验证链路）------------
    llmReplies.push('D-1 的回答');
    const chat = await call('chat', { roleId: 'stress', userId: 'u1', userName: '阿明', text: '今天继续复习' });
    expect(chat.ok).toBe(true);
    expect(chat.result.text).toBe('D-1 的回答');
    // chat 的轮次进了 L1
    const afterChat = JSON.parse(store.get('mem/role/stress/turns'));
    expect(afterChat[afterChat.length - 1].role).toBe('assistant');

    // --- 第三幕：逐日压缩 10 天，验证连贯性 -----------------------------------------
    //
    // 模型脚本：对"第 d 天"的压缩请求返回一段**引用前情**的摘要。校验三点：
    //   a) 每一次压缩请求的 prompt 都带着"上一段长期摘要"（第 1 天除外）——故事线连续；
    //   b) 产出的 L3 每条 ≤200 字、按天有序去重；
    //   c) 100 轮的材料在 prompt 里出现过（抽样 D1/D5/D10 的关键句）。
    // 逐日压：把 L1 重放成"那天凌晨还留着当天往来"的形态，再调 compact。
    // （真实流程里压缩发生在每天凌晨，L1 当天必然还有当天的往来；这里按天重放等价状态。）
    // 模型回复在**调用之后**按实际 prompt 生成（时序才能对上），所以每天分两步：
    //   1) call('compact')——它内部会取 llmReplies 的队头，先放一个占位回复；
    //   2) 校验当天 prompt 拿到的确实是"引用前一天 L3"的摘要。
    const perDayPrompts = [];
    const perDayResults = [];
    for (let d = 1; d <= DAYS; d += 1) {
      const dayTurns = turns.filter((t) => new Date(t.at).getDate() === new Date(dayAt(d, 1)).getDate());
      store.set('mem/role/stress/turns', JSON.stringify(dayTurns.slice(-16)));
      const dayKey = Pure_day(dayAt(d, 1));
      // 回复在调用前构造：引用"当前最后一段 L3"（模型按 prompt 里的上一段接龙）。
      const l3Before = JSON.parse(store.get('mem/role/stress/l3') || '[]');
      const prevText = l3Before.length ? l3Before[l3Before.length - 1].text : '';
      llmReplies.push(JSON.stringify({ summary: `D${d}：${prevText ? '接着「' + prevText.slice(0, 10) + '」' : ''}阿明复习了新的一章。`.slice(0, 200) }));
      const out = await call('compact', { day: dayKey }); // 显式逐日（补录路径，lastDay 不动）
      expect(out.ok, `第 ${d} 天的 compact 没有回包`).toBe(true);
      expect(out.result.days.filter((x) => x.ok).length, `第 ${d} 天应压出一段 L3`).toBe(1);
      // prompt 里带着上一段 L3（第 1 天除外）——连贯性的直接证据
      const prompt = llmCalls[llmCalls.length - 1];
      if (d > 1) expect(prompt.text, `第 ${d} 天没接前文`).toContain('上一段长期摘要：');
      perDayPrompts.push(...llmCalls.slice());
      perDayResults.push(out.result);
      llmCalls.length = 0;
    }

    // a) 连贯性：10 天里每天都发出了一次压缩请求（材料是当天的往来 + L2 摘要），
    //    且第 2 天起每一次 prompt 都带着"上一段长期摘要"——故事线连续。
    const compactCalls = perDayPrompts.filter((c) => c.system && c.system.includes('长期记忆'));
    expect(compactCalls.length, '压缩请求应每天一次').toBe(DAYS);
    // L3 存档最后一段应引用了第 9 天的内容（链路连起来了）。
    const l3Final = JSON.parse(store.get('mem/role/stress/l3'));
    expect(l3Final[l3Final.length - 1].text).toContain('D9');

    // b) L3 存档：有序、去重、每条 ≤200 字
    const l3 = JSON.parse(store.get('mem/role/stress/l3'));
    expect(l3.length).toBeLessThanOrEqual(60);
    const daySet = new Set(l3.map((e) => e.day));
    expect(daySet.size).toBe(l3.length); // 同一天只有一段
    const daysSorted = l3.map((e) => e.day);
    expect([...daysSorted].sort()).toEqual(daysSorted); // 按天有序
    for (const entry of l3) {
      expect(entry.text.length).toBeLessThanOrEqual(200);
    }

    // c) 材料进过 prompt：抽样三天（每天只留 L1 的最后 8 轮 = 16 条，所以抽后段的轮次）
    const allPromptText = compactCalls.map((c) => c.text).join('\n');
    expect(allPromptText).toContain('D1-第9轮');
    expect(allPromptText).toContain('D5-第9轮');
    expect(allPromptText).toContain('D10-第10轮');

    // d) 链上有账：每条 L3 都在 chain 里留了痕
    const chain = JSON.parse(store.get('mem/role/stress/chain'));
    expect(chain.filter((e) => e.kind === 'l3').length).toBeGreaterThanOrEqual(1);
  });

  test('compactTick：同一天内反复 tick 不重复压缩；日期推进后跑一次', async () => {
    await boot({ slot: 'background' });
    drainTimers(); // 拆掉 boot 时启动的真实定时器（我们要手动调 tick）

    // 昨天没压过：第一次 tick 跑（但没材料，全是 no-material，lastDay 推进）。
    // tick 是直接调用的：它内部的 storage 请求要靠 settle() 应答（call() 干的事）。
    const pendingTick = window.__memcore.compactTick();
    await settle(120);
    const first = await Promise.race([pendingTick, new Promise((r) => setTimeout(() => r('TICK-TIMEOUT'), 5000))]);
    expect(first).toBe(true);
    const state = JSON.parse(store.get('state/compact'));
    const yesterday = Pure_day(new Date(Date.now() - 86400000).getTime());
    expect(state.lastDay).toBe(yesterday);

    // 同一天内第二次 tick：不再跑（lastDay 已是昨天，tick 同步短路——但 loadCompactState
    // 自己还是要读一次盘，所以要应答它的请求）
    const pendingSecond = window.__memcore.compactTick();
    await settle(60);
    const second = await Promise.race([pendingSecond, new Promise((r) => setTimeout(() => r('TO'), 4000))]);
    expect(second).toBe(false);
  }, 15000);

  test('compactEnabled=false：不启动定时器', async () => {
    configValues.compactEnabled = 'false';
    await boot({ slot: 'background' });
    expect(intervals).toHaveLength(0); // 常驻帧里没有为压缩装 60s 的 setInterval
    // workshop 里也启动不了它（workshop 分支不调用 startCompactTimer）
  });

  test('compactEnabled=true：常驻帧里有一个 60s 的定时器', async () => {
    await boot({ slot: 'background' });
    expect(intervals).toHaveLength(1);
  });
});
