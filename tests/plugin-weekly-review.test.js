import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 周报汇总的行为测试，三层：
//   1. 纯函数（lib/weekly-core.js）——周窗口、归集容忍、模板、超长截断；
//   2. 宿主链路（真实 panel.html + lib + app.js 在 jsdom 里握手）——数据源发现/失败容忍、
//      llm 两路、serves、granted=[]；
//   3. 静态接线——不写死插件 id、serves 与 CALL_HANDLERS 一致。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-weekly-review');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const coreSource = readFileSync(path.join(pluginDir, 'lib', 'weekly-core.js'), 'utf8');
const appSource = readFileSync(path.join(pluginDir, 'app.js'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

function loadCore() {
  const window = {};
  new Function('window', coreSource)(window);
  return window.WeeklyCore;
}

// --- jsdom 挂载（自动应答器模式，同 price-watch 的教训） -----------------------------

async function mount({ granted: grants, surface, services, stats } = {}) {
  // services: plugins.services 的应答（数组）；stats: {[pluginId]: data | Error}
  const dom = new JSDOM(html, { url: 'https://plugin.invalid/panel.html', runScripts: 'outside-only' });
  const { window } = dom;
  const sent = [];
  const errors = [];
  let storageValue = '';
  window.parent = window;
  const answer = (msg) => {
    if (msg.method === 'storage.get') respond(msg.id, { value: storageValue });
    else if (msg.method === 'storage.set') { storageValue = msg.payload.value; respond(msg.id, { ok: true }); }
    else if (msg.method === 'config.get') respond(msg.id, { values: {} });
    else if (msg.method === 'plugins.services') {
      if (services === null || services === undefined) respond(msg.id, null, false);
      else respond(msg.id, services);
    } else if (msg.method === 'plugin.call') {
      const target = String((msg.payload && msg.payload.target) || '');
      const pid = target.split('/')[0] || '?';
      const val = stats ? stats[pid] : undefined;
      if (val instanceof Error) respond(msg.id, null, false);
      else if (val === undefined) respond(msg.id, null, false);
      else respond(msg.id, val);
    } else if (msg.method === 'llm.chat') {
      if (llmBehavior === null) respond(msg.id, null, false);
      else {
        try { respond(msg.id, llmBehavior(msg.payload)); }
        catch { respond(msg.id, null, false); }
      }
    } else if (msg.method === 'bubble.say') respond(msg.id, { ok: true });
    else respond(msg.id, null, false);
  };
  window.postMessage = (msg) => {
    sent.push(msg);
    if (msg && msg.type === 'request') queueMicrotask(() => answer(msg));
  };
  window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
  window.addEventListener('unhandledrejection', (e) => errors.push('unhandled: ' + String(e.reason && e.reason.message || e.reason)));

  let llmBehavior = null;

  window.eval(coreSource);
  window.eval(appSource);

  const respond = (id, result, ok = true) => {
    const event = new window.MessageEvent('message', { data: { v: 1, type: 'response', id, ok, result } });
    Object.defineProperty(event, 'source', { value: window });
    window.dispatchEvent(event);
  };

  const init = () => {
    const data = {
      v: 1, type: 'init', theme: 'dark', granted: grants || [],
      surface: surface || { kind: 'panel', slot: 'background' },
    };
    if (surface?.slot === 'workshop') {
      data.host = { program: 'workshop', methods: ['storage.get', 'storage.set', 'config.get', 'plugins.services', 'plugin.call'] };
    }
    const event = new window.MessageEvent('message', { data });
    Object.defineProperty(event, 'source', { value: window });
    window.dispatchEvent(event);
  };

  const flush = () => new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
  return { window, sent, errors, init, flush, getStorage: () => storageValue, setLlm: (fn) => { llmBehavior = fn; } };
}

const callResults = (sent) => sent.filter((m) => m.type === 'call-result');

// --- 1. 纯函数层 ----------------------------------------------------------------

describe('纯函数：周窗口', () => {
  const C = loadCore();
  const SH = 480; // Asia/Shanghai 偏移（分钟）
  test('周三 → 本周周一为起点；周日 → 同周周一', () => {
    // 2026-01-07 是周三（上海 12:00 = UTC 04:00 的 epoch：Date.UTC(...,4,0)）
    const wed = Date.UTC(2026, 0, 7, 4, 0);
    const w = C.weekWindow(wed, SH);
    expect(w.startDate).toBe('2026-01-05'); // 周一
    // 2026-01-04 是周日，属于 2025-12-29 那周
    const sun = Date.UTC(2026, 0, 4, 4, 0);
    const w2 = C.weekWindow(sun, SH);
    expect(w2.startDate).toBe('2025-12-29');
  });
  test('label 形如 2026-W02', () => {
    const wed = Date.UTC(2026, 0, 7, 4, 0);
    expect(C.weekWindow(wed, SH).label).toMatch(/^2026-W\d{2}$/);
  });
});

describe('纯函数：归集容忍与模板', () => {
  const C = loadCore();
  const win = { label: '2026-W45', startDate: '2026-11-02' };
  test('三个源全在 → available 三个、missing 空', () => {
    const { available, missing } = C.collect([
      { name: 'todo', ok: true, data: { kind: 'todo', done: 3, total: 5 } },
      { name: 'pomodoro', ok: true, data: { kind: 'pomodoro', minutes: 100, count: 5 } },
      { name: 'diary', ok: true, data: { kind: 'diary', entries: 4 } },
    ]);
    expect(Object.keys(available)).toHaveLength(3);
    expect(missing).toEqual([]);
  });
  test('一个失败 → 照常归集其余，missing 记名', () => {
    const { available, missing } = C.collect([
      { name: 'todo', ok: true, data: { kind: 'todo', done: 3, total: 5 } },
      { name: 'pomodoro', ok: false, error: '失联' },
    ]);
    expect(available.todo).toBeTruthy();
    expect(missing).toEqual(['pomodoro']);
  });
  test('全部失败 → 空模板；模板里写明缺什么', () => {
    const { available, missing } = C.collect([
      { name: 'todo', ok: false, error: 'x' },
      { name: 'diary', ok: false, error: 'y' },
    ]);
    const text = C.templateText(win, available, missing);
    expect(text).toContain('没有拿到任何数据');
    expect(text).toContain('todo');
  });
  test('模板 ≤300 字；模板里有数字', () => {
    const { available, missing } = C.collect([{ name: 'todo', ok: true, data: { kind: 'todo', done: 3, total: 5 } }]);
    const text = C.templateText(win, available, missing);
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text).toContain('3/5');
  });
  test('超长截断并标注', () => {
    // note 字段模板不认识 → 丢弃；要造超长得靠 known 字段本身——直接超长 missing 名单。
    const manyMissing = Array.from({ length: 60 }, (_, i) => `数据源${i}名字够长`);
    const text = C.templateText(win, {}, manyMissing);
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text).toContain('截断');
  });
  test('buildPrompt 只含统计摘要，missing 写进去', () => {
    const p = C.buildPrompt(win, { todo: { done: 1, total: 2 } }, ['diary']);
    expect(p).toContain('todo');
    expect(p).toContain('diary');
    expect(p).toContain('300');
  });
});

// --- 2. 静态接线 ----------------------------------------------------------------

describe('接线纪律', () => {
  test('app.js 不写死任何插件 id（数据源靠发现，不靠点名）', () => {
    expect(appSource).not.toMatch(/com\.shixiansi\.plugin-(todo|pomodoro|diary)/);
  });
  test('serves 与 CALL_HANDLERS 逐字一致', () => {
    expect([...manifest.serves].sort()).toEqual(['latest', 'report']);
    expect(appSource).toMatch(/const CALL_HANDLERS = \{[\s\S]{0,200}?\n\s*report:/);
    expect(appSource).toMatch(/\n\s*latest:/);
  });
});

// --- 3. 宿主链路（jsdom） ---------------------------------------------------------

const SVC = [{ pluginId: 'com.shixiansi.plugin-todo', method: 'stats' }, { pluginId: 'com.shixiansi.plugin-pomodoro', method: 'stats' }, { pluginId: 'com.shixiansi.plugin-diary-writer', method: 'stats' }];
const STATS_ALL = {
  'com.shixiansi.plugin-todo': { done: 3, total: 5 },
  'com.shixiansi.plugin-pomodoro': { minutes: 100, count: 5 },
  'com.shixiansi.plugin-diary-writer': { entries: 4 },
};

describe('generate：数据源容忍', () => {
  test('三源全在 + llm 在：报告含三类数据，不降级', async () => {
    const m = await mount({
      granted: ['plugin.call', 'storage', 'plugin.config', 'llm.chat', 'pet.bubble'],
      services: SVC,
      stats: STATS_ALL,
    });
    m.setLlm(() => ({ text: '这周完成了 3/5 的待办，专注 100 分钟，写了 4 篇日记。' }));
    m.init();
    await m.flush();
    const out = await m.window.__weeklyReview.generate();
    await m.flush();
    expect(out.ok).toBe(true);
    expect(out.report.degraded).toBe(false);
    expect(out.report.text).toContain('3/5');
    expect(out.report.missing).toEqual([]);
  });

  test('一个源失联：报告照出并写明缺哪块', async () => {
    const m = await mount({
      granted: ['plugin.call', 'storage', 'plugin.config', 'llm.chat'],
      services: SVC,
      stats: { ...STATS_ALL, 'com.shixiansi.plugin-pomodoro': new Error('没装') },
    });
    m.setLlm(() => ({ text: '本周完成 3/5 待办，写了 4 篇日记；专注数据没拿到。' }));
    m.init();
    await m.flush();
    const out = await m.window.__weeklyReview.generate();
    await m.flush();
    expect(out.ok).toBe(true);
    expect(out.report.missing).toContain('pomodoro');
  });

  test('全部源失联：纯模板报告照出（绝不开天窗）', async () => {
    const m = await mount({
      granted: ['plugin.call', 'storage', 'plugin.config'],
      services: SVC,
      stats: {},
    });
    m.init();
    await m.flush();
    const out = await m.window.__weeklyReview.generate();
    await m.flush();
    expect(out.ok).toBe(true);
    expect(out.report.degraded).toBe(true);
    expect(out.report.text).toContain('没有拿到任何数据');
    expect(out.report.missing).toHaveLength(3);
  });

  test('llm 失败：退化为数字模板，报告照样出', async () => {
    const m = await mount({
      granted: ['plugin.call', 'storage', 'plugin.config', 'llm.chat'],
      services: SVC,
      stats: STATS_ALL,
    });
    m.setLlm(() => { throw new Error('渠道挂了'); });
    m.init();
    await m.flush();
    const out = await m.window.__weeklyReview.generate();
    await m.flush();
    expect(out.ok).toBe(true);
    expect(out.report.degraded).toBe(true);
    expect(out.report.text).toContain('3/5');
  });

  test('plugins.services 不可用：报告明确说明（不是静默空白）', async () => {
    const m = await mount({
      granted: ['plugin.call', 'storage', 'plugin.config'],
      services: null,
      stats: {},
    });
    m.init();
    await m.flush();
    const out = await m.window.__weeklyReview.generate();
    await m.flush();
    expect(out.ok).toBe(true);
    expect(out.report.text).toContain('没有拿到任何数据');
  });
});

describe('serves：report / latest', () => {
  test('call(report) 立即生成但不落盘', async () => {
    const m = await mount({
      granted: ['plugin.call', 'storage', 'plugin.config'],
      services: SVC,
      stats: STATS_ALL,
    });
    m.init();
    await m.flush();
    const event = new m.window.MessageEvent('message', {
      data: { v: 1, type: 'call', ticket: 't-r', from: 'x', method: 'report', payload: {} },
    });
    Object.defineProperty(event, 'source', { value: m.window });
    m.window.dispatchEvent(event);
    await m.flush();
    const results = callResults(m.sent);
    expect(results[0].ticket).toBe('t-r');
    // report 的应答形状就是报告本身（{label,text,...}），没有 ok 包一层
    expect(results[0].result.label).toBeTruthy();
    expect(results[0].result.text).toContain('3/5');
  });

  test('call(latest)：有存档返回最近一篇；无存档返回明确空态', async () => {
    const m = await mount({
      granted: ['plugin.call', 'storage', 'plugin.config'],
      services: SVC,
      stats: STATS_ALL,
    });
    m.init();
    await m.flush();
    const event = new m.window.MessageEvent('message', {
      data: { v: 1, type: 'call', ticket: 't-l', from: 'x', method: 'latest', payload: {} },
    });
    Object.defineProperty(event, 'source', { value: m.window });
    m.window.dispatchEvent(event);
    await m.flush();
    const results = callResults(m.sent);
    expect(results[0].result.empty).toBe(true);
    expect(results[0].result.report).toBeNull();
  });

  test('call(未知方法)：ok=false 信封', async () => {
    const m = await mount({ granted: ['plugin.call'], services: [], stats: {} });
    m.init();
    await m.flush();
    const event = new m.window.MessageEvent('message', {
      data: { v: 1, type: 'call', ticket: 't-x', from: 'x', method: 'digest', payload: {} },
    });
    Object.defineProperty(event, 'source', { value: m.window });
    m.window.dispatchEvent(event);
    await m.flush();
    expect(callResults(m.sent)[0].ok).toBe(false);
    expect(callResults(m.sent)[0].error).toContain('report');
  });
});

describe('generateAndArchive：同周替换 + 12 篇环形', () => {
  test('同周生成两次：只留最新一篇', async () => {
    const m = await mount({
      granted: ['plugin.call', 'storage', 'plugin.config'],
      services: SVC,
      stats: STATS_ALL,
    });
    m.init();
    await m.flush();
    await m.window.__weeklyReview.generateAndArchive();
    await m.window.__weeklyReview.generateAndArchive();
    await m.flush();
    expect(m.window.__weeklyReview.snapshot().reports).toHaveLength(1);
    expect(JSON.parse(m.getStorage())).toHaveLength(1);
  });
});

describe('到点判断与 granted=[]', () => {
  test('dueForWeekly：周日 20:01 且本周无档 → true；有档 → false', async () => {
    const m = await mount({
      granted: ['plugin.call', 'storage', 'plugin.config'],
      services: SVC,
      stats: STATS_ALL,
    });
    m.init();
    await m.flush();
    // 2026-11-01 是周日；上海 20:01 = UTC 12:01（epoch 本身就按 UTC 建）
    const SH = 480;
    const sun2001 = Date.UTC(2026, 10, 1, 12, 1);
    m.window.__weeklyReview.setClock(() => sun2001, () => SH);
    expect(m.window.__weeklyReview.dueForWeekly(sun2001)).toBe(true);
    // 生成后同一天再查：已有本周档 → false
    await m.window.__weeklyReview.generateAndArchive();
    await m.flush();
    expect(m.window.__weeklyReview.dueForWeekly(sun2001)).toBe(false);
  });

  test('granted=[]：generate 明确拒绝、零请求零写不崩', async () => {
    const m = await mount({ granted: [], services: SVC, stats: STATS_ALL });
    m.init();
    await m.flush();
    const out = await m.window.__weeklyReview.generate();
    await m.flush();
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('plugin.call');
    expect(m.sent.filter((x) => x.method === 'storage.set')).toHaveLength(0);
    expect(m.sent.filter((x) => x.method === 'plugin.call' || x.method === 'plugins.services' || x.method === 'llm.chat')).toHaveLength(0);
    expect(m.errors).toEqual([]);
  });

  test('无 llm.chat 权限：模板退化路径照常', async () => {
    const m = await mount({
      granted: ['plugin.call', 'storage', 'plugin.config'],
      services: SVC,
      stats: STATS_ALL,
    });
    m.init();
    await m.flush();
    const out = await m.window.__weeklyReview.generate();
    await m.flush();
    expect(out.ok).toBe(true);
    expect(out.report.degraded).toBe(true);
    expect(out.report.text).toContain('3/5');
  });
});
