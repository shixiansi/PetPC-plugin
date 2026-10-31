import { afterEach, beforeEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 日记插件的行为测试：驱动 panel.html 里真实加载的那几支脚本。
//
// 钉住的几件事：
//
//   1. 三路聚合：memcore/export-state（plugin.call）、todo-list（share）、
//      pomodoro/phase-ended（share）各自独立降级——缺谁日记就少哪段，不拖死；
//   2. Prompt 长度：素材超出预算从对话尾部砍（最旧的先丢），prompt 永不超限；
//   3. JSON 解析健壮性：裸 JSON / ```json 围栏 / 前后有废话都接；坏 JSON 抛中文；
//   4. 情绪标签：词表外的 mood 归 calm；昨天的日记被注入 prompt（连续性）；
//   5. get_recent / write_now 的回包形状；「我不认识这个方法」也有回包。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-diary-writer');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');
const source = scriptSources
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-diary-writer';
const MEMCORE_ID = 'com.shixiansi.plugin-memcore';
const TODO_ID = 'com.shixiansi.plugin-todo';
const POMODORO_ID = 'com.shixiansi.plugin-pomodoro';

// --- 测试素材 -------------------------------------------------------------------

const TODAY = '2026-10-31';
/** 把"今天"固定住：插件的 dayKeyOf 读宿主时钟。 */
const TODAY_MS = Date.parse(`${TODAY}T12:00:00`);

const MEM_SNAPSHOT = {
  version: 2, at: TODAY_MS, kind: 'memcore-state',
  entries: [
    { key: 'mem/role/qq-group/chain', value: [
      { at: TODAY_MS - 3600e3, roleId: 'qq-group', kind: 'in', who: '主人', text: '今天跑了个大模型本地部署' },
      { at: TODAY_MS - 3500e3, roleId: 'qq-group', kind: 'out', who: 'bot', text: '哇，跑起来了吗' },
      { at: TODAY_MS - 86400e3, roleId: 'qq-group', kind: 'in', who: '主人', text: '昨天的话不该出现' },
    ] },
    { key: 'mem/role/qq-group/episodes', value: [{ at: TODAY_MS, text: '阿岚在折腾本地部署' }] },
    { key: 'mem/user/u1/prefs', value: ['喜欢短句'] },
  ],
};

const TODO_SNAPSHOT = [
  { id: 'a', title: '写周报', done: true },
  { id: 'b', title: '整理纸箱', done: true },
  { id: 'c', title: '买菜', done: false },
];

const POMODORO_SNAPSHOT = { phase: 'focus', at: TODAY_MS - 1800e3 };

const GOOD_DIARY = '今天主人折腾本地大模型，跑起来的那一刻我们一起欢呼。周报也写完了，安静的一天。';

describe('manifest', () => {
  test('background frame gated by plugin.call; serves get_recent and write_now', () => {
    expect(manifest.background).toBe(true);
    expect(manifest.permissions).toContain('plugin.call');
    expect(manifest.permissions).toContain('plugin.share');
    expect(manifest.permissions).toContain('events');
    expect(manifest.serves).toEqual(['get_recent', 'write_now']);
  });

  test('calls memcore/export-state and reads exactly the two published snapshots', () => {
    expect(manifest.callTargets).toEqual([`${MEMCORE_ID}/export-state`]);
    expect(manifest.shareRead).toEqual([
      `${TODO_ID}/todo-list`,
      `${POMODORO_ID}/phase-ended`,
    ]);
  });

  test('the partners actually serve / publish what we consume', () => {
    const coreManifest = JSON.parse(readFileSync(path.join(here, '..', 'plugins', MEMCORE_ID, 'manifest.json'), 'utf8'));
    expect(coreManifest.serves).toContain('export-state');
    const todoApp = readFileSync(path.join(here, '..', 'plugins', TODO_ID, 'app.js'), 'utf8');
    expect(todoApp).toContain("SHARE_LIST = 'todo-list'");
    const pomodoroApp = readFileSync(path.join(here, '..', 'plugins', POMODORO_ID, 'app.js'), 'utf8');
    expect(pomodoroApp).toContain("SHARE_PHASE_ENDED = 'phase-ended'");
  });
});

// --- 纯函数部分：聚合 / Prompt / JSON 解析（隔离挂载，不碰行为测试的 window） ------

async function mountIsolated() {
  // **参数注入的隔离挂载**：在一个独立的 jsdom window 上跑插件源码，全部全局引用
  // （window/document/location/URLSearchParams/定时器/MessageEvent）都由形参遮蔽——
  // 源码顶层的 addEventListener 与 postToHost(ready) 落在那个一次性 world 里，
  // 与行为测试共享的 vitest window 完全无关（rss 的教训：共享 window 上的陈旧作用域
  // 会收到行为测试的 init，request id 撞车）。
  const dom = new JSDOM(html, { url: 'https://plugin.invalid/panel.html' });
  const win = dom.window;
  win.postMessage = () => {}; // 隔离 world 的出站消息没有 spy 可看，也不需要
  const timers = [];
  const winSetTimeout = win.setTimeout.bind(win);
  const injectedSetTimeout = (fn, ms, ...rest) => {
    const id = winSetTimeout(fn, ms, ...rest);
    timers.push(id);
    return id;
  };
  const injectedSetInterval = (fn, ms, ...rest) => {
    const id = win.setInterval(fn, ms, ...rest);
    timers.push(id);
    return id;
  };
  // eslint-disable-next-line no-new-func
  new Function(
    'window', 'document', 'location', 'URLSearchParams', 'MessageEvent',
    'setTimeout', 'setInterval', 'clearInterval', 'clearTimeout',
    'Date', 'Math', 'JSON',
    `return (function () { ${source}\n; return window.__diary; })();`,
  )(
    win, win.document, win.location, win.URLSearchParams, win.MessageEvent,
    injectedSetTimeout, injectedSetInterval, win.clearInterval.bind(win), win.clearTimeout.bind(win),
    Date, Math, JSON,
  );
  return win.__diary;
}

describe('collect: three-route aggregation', () => {
  let collect;
  beforeAll(async () => {
    collect = (await mountIsolated()).collect;
  });

  test('memcore chain events are filtered to today and compressed into lines', () => {
    const events = collect.eventsTodayFromSnapshot(MEM_SNAPSHOT, TODAY);
    expect(events).toHaveLength(2); // 昨天那条被滤掉
    const lines = collect.summarizeEvents(events, 600);
    expect(lines.some((l) => l.includes('本地部署'))).toBe(true);
    expect(lines.some((l) => l.includes('昨天的话'))).toBe(false);
  });

  test('todos: done ones become material, pending counted', () => {
    const todos = collect.todosFromSnapshot(TODO_SNAPSHOT);
    expect(todos.done).toEqual(['写周报', '整理纸箱']);
    expect(todos.pending).toBe(1);
    // 坏快照按空处理。
    expect(collect.todosFromSnapshot(null)).toEqual({ done: [], pending: 0 });
    expect(collect.todosFromSnapshot('garbage')).toEqual({ done: [], pending: 0 });
  });

  test('dayKeyOf/yesterdayKey are local-date stable', () => {
    expect(collect.dayKeyOf(TODAY_MS)).toBe(TODAY);
    expect(collect.yesterdayKey(TODAY_MS)).toBe('2026-10-30');
    // 非法输入落回今天，不抛。
    expect(collect.dayKeyOf('x')).toBe(collect.dayKeyOf(Date.now()));
  });

  test('msUntilNext lands on the configured time (today or tomorrow)', () => {
    const noon = Date.parse(`${TODAY}T12:00:00`);
    const toEvening = collect.msUntilNext('23:00', noon);
    expect(toEvening).toBe(11 * 3600e3);
    // 过了当天的点 → 等明天。
    const late = Date.parse(`${TODAY}T23:30:00`);
    const nextDay = collect.msUntilNext('23:00', late);
    expect(nextDay).toBe(23.5 * 3600e3);
    // 非法配置回 23:00。
    expect(collect.parseDiaryTime('abc')).toEqual({ h: 23, min: 0 });
  });
});

describe('diary: prompt budget and JSON parsing', () => {
  let diary;
  beforeAll(async () => {
    diary = (await mountIsolated()).diary;
  });

  test('parseDiaryJSON accepts bare JSON, fenced JSON, and JSON with chatter', () => {
    expect(diary.parseDiaryJSON('{"text":"你好","mood":"happy"}')).toEqual({ text: '你好', mood: 'happy' });
    expect(diary.parseDiaryJSON('```json\n{"text":"围栏","mood":"tired"}\n```')).toEqual({ text: '围栏', mood: 'tired' });
    expect(diary.parseDiaryJSON('好的，这是日记：{"text":"废话版","mood":"excited"} 请查收')).toEqual({ text: '废话版', mood: 'excited' });
    // 词表外的 mood 归 calm；空 text 拒收。
    expect(diary.parseDiaryJSON('{"text":"x","mood":"ecstatic"}').mood).toBe('calm');
    expect(diary.parseDiaryJSON('{"mood":"happy"}')).toBeNull();
    expect(diary.parseDiaryJSON('完全不是 JSON')).toBeNull();
    expect(diary.parseDiaryJSON('')).toBeNull();
  });

  test('the prompt carries the material, yesterday quote, and stays under budget', () => {
    const material = {
      day: TODAY,
      chat: Array.from({ length: 120 }, (_, i) => `主人说：第 ${i} 句，${'内容比较长'.repeat(20)}`),
      todosDone: ['写周报'],
      todosPending: 1,
      focusCount: 3,
      memOk: true,
    };
    const yesterdayDiary = { day: '2026-10-30', text: '昨天也是好的一天', mood: 'calm' };
    const { prompt, truncated, system } = diary.buildPrompt(structuredClone(material), 300, yesterdayDiary);

    expect(truncated).toBe(true); // 素材被砍过
    expect(prompt.length).toBeLessThanOrEqual(diary.PROMPT_BUDGET);
    expect(prompt).toContain('写周报');
    expect(prompt).toContain('3 段番茄钟');
    expect(prompt).toContain('昨天你写过');
    expect(system).toContain('300');
    expect(system).toContain('JSON');
  });

  test('an empty day still builds an honest prompt (no invention requested)', () => {
    const material = { day: TODAY, chat: [], todosDone: [], todosPending: 0, focusCount: 0, memOk: false };
    const { prompt } = diary.buildPrompt(material, 300, null);
    expect(prompt).toContain('记忆核心没装或没说话');
    expect(diary.DIARY_SYSTEM).toContain('不要编造');
  });
});

// --- 行为部分：jsdom 里驱动真实链路 ---------------------------------------------

let store;
let shareBoard;
let configValues;
let callCalls;
let callReplies;
let failExport;
let memSnapshotOverride;
let answered;
let postedFrom;
let windowListeners;
let intervals;

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

function callReplyFor(payload) {
  if (callReplies.length) {
    const next = callReplies.shift();
    if (typeof next === 'function') return next(payload);
    if (typeof next === 'string') return { text: next };
    return next;
  }
  return { text: `{"text":"${GOOD_DIARY}","mood":"happy"}` };
}

async function pump(maxRounds = 80) {
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
          answer(req.id, { value: store.has(String(payload.key)) ? store.get(String(payload.key)) : '' });
          break;
        case 'storage.set':
          store.set(String(payload.key), String(payload.value || ''));
          answer(req.id, { ok: true });
          break;
        case 'storage.remove':
          store.delete(String(payload.key));
          answer(req.id, { ok: true });
          break;
        case 'plugin.call': {
          callCalls.push(payload);
          // export-state（聚合）永远回快照；chat（日记生成）才走测试的 reply 队列——
          // 两个方法在同一条链上，按 method 分派，否则队列头会被聚合消费掉。
          if (payload.method === 'export-state') {
            if (failExport > 0) {
              failExport -= 1;
              answer(req.id, null, { ok: false, error: '问不到 com.shixiansi.plugin-memcore' });
            } else {
              answer(req.id, memSnapshotOverride || MEM_SNAPSHOT);
            }
            break;
          }
          const reply = callReplyFor(payload);
          if (reply instanceof Error) answer(req.id, null, { ok: false, error: reply.message });
          else answer(req.id, reply);
          break;
        }
        case 'share.get': {
          const key = `${payload.owner}/${payload.name}`;
          const value = shareBoard.get(key) || '';
          answer(req.id, { value, at: value ? TODAY_MS : 0, key });
          break;
        }
        case 'share.set':
          answer(req.id, { ok: true, key: `${PLUGIN_ID}/${payload.name}` });
          break;
        case 'bubble.say':
          answer(req.id, { ok: true });
          break;
        default:
          answer(req.id, null, { ok: false, error: `本程序不支持该方法 ${req.method}` });
      }
    }
    await vi.advanceTimersByTimeAsync(1);
  }
}

/** 并发跑一次写日记：内部的 call/share/storage 都要有人答，且答完会引发下一批。 */
async function runWrite() {
  const p = window.__diary.writeDiary();
  let settled = false;
  p.then(() => {}, () => {}).finally(() => { settled = true; });
  for (let i = 0; i < 60 && !settled; i += 1) {
    await pump(8);
    await vi.advanceTimersByTimeAsync(4);
  }
  return p;
}

function boot(slot = 'background') {
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
  loadApp();
  hostSends({
    v: 1, type: 'init', pluginId: PLUGIN_ID, permissions: manifest.permissions,
    granted: [...manifest.permissions], surface: { kind: 'panel', slot },
  });
  return macro();
}

const macro = () => vi.advanceTimersByTimeAsync(0);

function loadApp() {
  answered = new Set();
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  for (const id of intervals) clearInterval(id);
  intervals = [];
  postedFrom = window.postMessage.mock.calls.length;
  // eslint-disable-next-line no-new-func
  new Function(source)();
}

function callApi(payload, method) {
  const before = byType('call-result').length;
  const ticket = `t-${Math.random().toString(36).slice(2, 8)}`;
  hostSends({ v: 1, type: 'call', ticket, from: MEMCORE_ID, method, payload });
  return () => {
    const list = byType('call-result').slice(before);
    expect(list.length, `${method} 一直没有回包（call-result 缺失）`).toBeGreaterThan(0);
    return list[list.length - 1];
  };
}

beforeEach(() => {
  // 手动推进（不用 shouldAdvanceTime）：它与 jsdom window 的 setInterval spy 组合时，
  // 自动推进的 native tick 会被下一轮的 clearInterval 误伤——第二个测试的钟就停了。
  vi.useFakeTimers({ now: TODAY_MS });
  store = new Map();
  shareBoard = new Map([
    [`${TODO_ID}/todo-list`, JSON.stringify(TODO_SNAPSHOT)],
    [`${POMODORO_ID}/phase-ended`, JSON.stringify(POMODORO_SNAPSHOT)],
  ]);
  configValues = { diaryTime: '23:00', maxChars: '300', bubbleDiary: 'true', keepDays: '90' };
  callCalls = [];
  callReplies = [];
  failExport = 0;
  memSnapshotOverride = null;
  windowListeners = [];
  intervals = [];
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
  vi.spyOn(window, 'postMessage').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  for (const id of intervals) clearInterval(id);
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  vi.restoreAllMocks();
});

describe('writeDiary (the real chain)', () => {
  test('aggregates all three routes, writes the entry, publishes, and bubbles', async () => {
    await boot();
    await pump();
    const entry = await runWrite();

    expect(entry.day).toBe(TODAY);
    expect(entry.text).toContain('本地大模型');
    expect(entry.mood).toBe('happy');
    expect(entry.prevMood).toBe(''); // 第一天没有昨天

    // 模型调用：走 memcore/chat，带日记专用会话。
    const chat = callCalls.find((c) => c.method === 'chat');
    expect(chat).toBeTruthy();
    expect(chat.payload.roleId).toBe('diary');
    // 素材进 prompt：待办与专注都在。
    expect(chat.payload.text).toContain('写周报');
    expect(chat.payload.text).toContain('番茄钟');

    // 落盘 + 索引。
    const saved = JSON.parse(store.get(`diary/${TODAY}`));
    expect(saved.text).toContain('本地大模型');
    const index = JSON.parse(store.get('diary/index'));
    expect(index).toContain(TODAY);

    // 快照与气泡。
    const shareMsg = requests().find((r) => r.method === 'share.set' && r.payload.name === 'diary-latest');
    expect(shareMsg).toBeTruthy();
    const bubble = requests().find((r) => r.method === 'bubble.say');
    expect(bubble, '日记写完没有弹气泡').toBeTruthy();
    expect(bubble.payload.text).toContain('日记');

    // 本测试启动过 scheduleDiary（boot 的 background 分支）：显式停掉，
    // 免得 60s 的 fake interval 泄漏进下一个测试的 timer 队列。
    window.__diary.stopDiaryTimer();
  });

  test('yesterday\'s diary is injected the next day (continuity)', async () => {
    await boot();
    await pump();
    // 先写今天（假装今天是 30 号：把时钟拨回一天）。
    vi.setSystemTime(Date.parse('2026-10-30T12:00:00'));
    const entry30 = await runWrite();
    expect(entry30.day).toBe('2026-10-30');

    // 拨到 31 号再写：prompt 里应该带上 30 号那篇。
    vi.setSystemTime(TODAY_MS);
    callReplies.push(`{"text":"新的一天","mood":"calm"}`);
    const chatCallsBefore = callCalls.length;
    await runWrite();
    const chat = callCalls.slice(chatCallsBefore).find((c) => c.method === 'chat');
    expect(chat.payload.text).toContain('昨天你写过');
  });

  test('a memcore outage degrades the chat route but the diary still gets written', async () => {
    await boot();
    await pump();
    shareBoard.set(`${POMODORO_ID}/phase-ended`, JSON.stringify({ phase: 'focus', at: TODAY_MS - 600e3 }));
    // memcore 不可达：export-state（聚合）被拒一次，chat 正常回。
    failExport = 1;
    callReplies.push(() => ({ text: `{"text":"今天很安静，专注了几段。","mood":"calm"}` }));
    const entry = await runWrite();
    expect(entry.text).toContain('很安静');
    // prompt 里明确说了"别提对话的事"。
    const chat = callCalls.find((c) => c.method === 'chat');
    expect(chat.payload.text).toContain('记忆核心没装或没说话');
  });

  test('a non-JSON model answer fails loudly in Chinese and writes nothing', async () => {
    await boot();
    await pump();
    callReplies.push('我觉得今天挺不错的，就不按格式来了。');
    await expect(runWrite()).rejects.toThrow('不是 JSON');
    expect(store.has(`diary/${TODAY}`)).toBe(false);
  });

  test('prompt length never exceeds the budget even with a huge chat history', async () => {
    await boot();
    await pump();
    // 巨量素材：60 条很长的对话行。
    const huge = {
      version: 2, at: TODAY_MS, kind: 'memcore-state',
      entries: [{
        key: 'mem/role/x/chain',
        value: Array.from({ length: 60 }, (_, i) => ({
          at: TODAY_MS - i * 1000, roleId: 'x', kind: 'in', who: '主人',
          text: '很长很长的对话内容'.repeat(12),
        })),
      }],
    };
    shareBoard.set(`${TODO_ID}/todo-list`, JSON.stringify([]));
    let seenPrompt = '';
    callReplies.push((payload) => {
      seenPrompt = payload.text || '';
      return { text: `{"text":"长日记","mood":"calm"}` };
    });
    // 巨量素材走 export-state（pump 的 export-state 分支固定回 MEM_SNAPSHOT），
    // 这里临时换成巨量快照。
    const savedSnapshot = MEM_SNAPSHOT;
    memSnapshotOverride = huge;
    try {
      await runWrite();
    } finally {
      memSnapshotOverride = null;
      void savedSnapshot;
    }
    expect(seenPrompt.length).toBeLessThanOrEqual(4000); // llm.chat 的 text 硬上限
  });
});

describe('plugin.call surface', () => {
  test('get_recent returns the latest entries; write_now writes one', async () => {
    await boot();
    await pump();

    // 先有一篇。
    await runWrite();

    const getRecent = callApi({ limit: 3 }, 'get_recent');
    await pump();
    const packet = getRecent();
    expect(packet.ok).toBe(true);
    expect(packet.result.entries).toHaveLength(1);
    expect(packet.result.entries[0].day).toBe(TODAY);
    expect(packet.result.entries[0].mood).toBe('happy');

    callReplies.push(() => ({ text: `{"text":"再来一篇","mood":"excited"}` }));
    const writeNow = callApi({}, 'write_now');
    await pump();
    const packet2 = writeNow();
    expect(packet2.ok).toBe(true);
    expect(packet2.result.mood).toBe('excited');
  });

  test('unknown call method: answered with an error, never silence', async () => {
    await boot();
    const getResult = callApi({}, 'read_diary');
    await pump(10);
    const packet = getResult();
    expect(packet.ok).toBe(false);
    expect(packet.error).toContain('get_recent');
  });

  test('says ready first, and nothing before init', async () => {
    const parsed = new JSDOM(html);
    document.body.innerHTML = parsed.window.document.body.innerHTML;
    loadApp();
    const first = posted()[0];
    expect(first && first.type).toBe('ready');
    expect(requests()).toHaveLength(0);
  });
});
