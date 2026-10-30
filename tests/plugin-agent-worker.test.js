import { afterEach, beforeEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 后台任务执行器的行为测试：驱动 panel.html 里真实加载的那几支脚本。
//
// 钉住的几件事：
//
//   1. 队列语义：先进先出、10 个任务一口气提交后严格按提交顺序串行执行（压测）、
//      任何时刻最多一个 running；
//   2. 失败重试：第一次失败回 pending（attempts=1），第二次失败终态 failed；
//   3. 断点恢复：盘上的 running 在启动时被判死，按剩余重试次数回 pending / failed；
//   4. 状态发布：执行中 share.set agent/status {status:'working', progress,...}，结束清掉；
//   5. 播报：完成后经 memcore/chat 说一句；add_background_task / queue_status 的回包形状。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-agent-worker');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');
const source = scriptSources
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-agent-worker';
const MEMCORE_ID = 'com.shixiansi.plugin-memcore';

describe('manifest', () => {
  test('background gated by plugin.call; serves the two queue methods', () => {
    expect(manifest.background).toBe(true);
    expect(manifest.permissions).toContain('plugin.call');
    expect(manifest.permissions).toContain('plugin.share');
    expect(manifest.permissions).toContain('events');
    expect(manifest.serves).toEqual(['add_background_task', 'queue_status']);
    expect(manifest.callTargets).toEqual([`${MEMCORE_ID}/chat`]);
  });
});

// --- 纯函数部分：队列语义（隔离挂载） ---------------------------------------------

async function mountIsolated() {
  const dom = new JSDOM(html, { url: 'https://plugin.invalid/panel.html' });
  const win = dom.window;
  win.postMessage = () => {};
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
    `return (function () { ${source}\n; return window.__agent; })();`,
  )(
    win, win.document, win.location, win.URLSearchParams, win.MessageEvent,
    injectedSetTimeout, injectedSetInterval, win.clearInterval.bind(win), win.clearTimeout.bind(win),
  );
  return win.__agent;
}

describe('queue semantics (pure functions)', () => {
  let agent;
  beforeAll(async () => {
    agent = await mountIsolated();
  });

  test('cleanTaskPayload accepts task_description and rejects empties', () => {
    expect(agent.queue.cleanTaskPayload({ task_description: ' 整理链接 ' }).description).toBe('整理链接');
    expect(agent.queue.cleanTaskPayload({ description: '别名也行' }).description).toBe('别名也行');
    expect(() => agent.queue.cleanTaskPayload({})).toThrow('task_description');
    expect(() => agent.queue.cleanTaskPayload({ task_description: '   ' })).toThrow('task_description');
  });

  test('pickNextTask is strict FIFO over pending only', () => {
    const tasks = [
      { id: 't1', status: 'done' },
      { id: 't2', status: 'running' },
      { id: 't3', status: 'pending' },
      { id: 't4', status: 'pending' },
    ];
    expect(agent.queue.pickNextTask(tasks).id).toBe('t3');
    expect(agent.queue.pickNextTask([])).toBeNull();
    expect(agent.queue.pickNextTask([{ id: 'x', status: 'failed' }])).toBeNull();
  });

  test('summarize counts by status', () => {
    const s = agent.queue.summarize([
      { status: 'pending' }, { status: 'pending' },
      { status: 'running' }, { status: 'done' }, { status: 'failed' },
    ]);
    expect(s).toEqual({ total: 5, pending: 2, running: 1, done: 1, failed: 1 });
  });
});

// --- 行为部分：jsdom 驱动真实链路 ---------------------------------------------------

let store;
let configValues;
let callCalls;
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

// 回复按 hint 全分派：执行（executeTask 的 chat）与系统通知（announce）各有各的表，
// 不共享隐式队列——否则通知会把执行要吃的应答偷走（2026-10-31 修掉的测试坑）。
const REPLY_TABLE = { execute: [], announce: [] };

function callReplyFor(payload) {
  // pump 传进来的是 plugin.call 的**信封**（{target, method, payload}）；
  // 内层的 payload.hint 才是 hint。
  const inner = (payload && payload.payload) || {};
  const hint = String(inner.hint || '');
  if (hint.includes('系统通知')) {
    return REPLY_TABLE.announce.length
      ? REPLY_TABLE.announce.shift()
      : { text: '收到，我会转告。' };
  }
  if (REPLY_TABLE.execute.length) {
    const next = REPLY_TABLE.execute.shift();
    if (typeof next === 'function') return next(payload);
    if (typeof next === 'string') return { text: next };
    return next;
  }
  return { text: '任务做完了：这是结果。' };
}

async function pump(maxRounds = 120) {
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
        case 'plugin.call':
          callCalls.push(payload);
          {
            const reply = callReplyFor(payload);
            if (reply instanceof Error) answer(req.id, null, { ok: false, error: reply.message });
            else answer(req.id, reply);
          }
          break;
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
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const macro = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 并发驱动一次 drain（内部 request 都要有人答，答完会引发下一批）。 */
async function runDrain() {
  const p = window.__agent.drainQueue();
  return withPump(p);
}

/** 与一个 promise 并发泵宿主应答：seam 调用（enqueue/recover）内部也要走 storage。 */
async function withPump(p) {
  let settled = false;
  p.then(() => {}, () => {}).finally(() => { settled = true; });
  for (let i = 0; i < 120 && !settled; i += 1) {
    await pump(8);
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
  return p;
}

/** 入队一个任务（并发泵）。 */
async function enqueue(description) {
  return withPump(window.__agent.enqueueTask({ task_description: description }, { maxTasks: 20 }));
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
  // 立刻校验失败的路径（如 task_description 为空）走的是 async 拒绝——回包落在
  // pump 返回之后的**微任务**里。取包前先多泵几拍 + 让宏任务跑完。
  return async () => {
    await pump(10);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await pump(4);
    const list = byType('call-result').slice(before);
    expect(list.length, `${method} 一直没有回包（call-result 缺失）`).toBeGreaterThan(0);
    return list[list.length - 1];
  };
}

/** 往 storage 里直接塞一份队列（模拟已存在的任务）。 */
async function seedTasks(tasks) {
  store.set('queue/tasks', JSON.stringify(tasks));
}

function tasksFromStore() {
  return JSON.parse(store.get('queue/tasks') || '[]');
}

beforeEach(() => {
  store = new Map();
  configValues = { pollSec: '300', maxTasks: '20', execTimeoutSec: '120', announce: 'true', showStatus: 'true' };
  callCalls = [];
  REPLY_TABLE.execute = [];
  REPLY_TABLE.announce = [];
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
  for (const id of intervals) clearInterval(id);
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  vi.restoreAllMocks();
});

describe('enqueue and the call surface', () => {
  test('add_background_task enqueues and answers {id, queueLength}; garbage is rejected', async () => {
    await boot();
    await pump();
    const add1 = callApi({ task_description: '整理今天群里的链接' }, 'add_background_task');
    await pump();
    const packet1 = await add1();
    expect(packet1.ok).toBe(true);
    expect(packet1.result.id).toBe('t0001');
    expect(packet1.result.queueLength).toBe(1);

    const add2 = callApi({ task_description: '把这份清单写成周报' }, 'add_background_task');
    await pump();
    expect((await add2()).result.queueLength).toBe(2);

    const bad = callApi({ task_description: '   ' }, 'add_background_task');
    await pump();
    const badPacket = await bad();
    expect(badPacket.ok).toBe(false);
    expect(badPacket.error).toContain('task_description');
  });

  test('queue_status returns the summary', async () => {
    await boot();
    await pump();
    await callApiAndPump({ task_description: '任务一' }, 'add_background_task');
    await callApiAndPump({ task_description: '任务二' }, 'add_background_task');
    const packet = await callApiAndPump({}, 'queue_status');
    expect(packet.ok).toBe(true);
    expect(packet.result).toEqual({ total: 2, pending: 2, running: 0, done: 0, failed: 0 });
  });

  async function callApiAndPump(payload, method) {
    const get = callApi(payload, method);
    return get();
  }

  test('unknown call method: answered with an error, never silence', async () => {
    await boot();
    const getResult = callApi({}, 'run_task');
    const packet = await getResult();
    expect(packet.ok).toBe(false);
    expect(packet.error).toContain('add_background_task');
  });
});

describe('the runner', () => {
  test('drain executes tasks strictly FIFO: 10 submitted, 10 run in order (stress)', async () => {
    await boot();
    await pump();
    for (let i = 1; i <= 10; i += 1) {
      await enqueue(`任务 ${i}`);
    }

    const ran = await runDrain();
    expect(ran).toHaveLength(10);
    expect(ran.map((r) => r.status)).toEqual(Array.from({ length: 10 }, () => 'done'));
    // FIFO：执行序（chat 的 payload 顺序）与提交一致。
    const chatDescs = callCalls.filter((c) => c.payload && c.payload.roleId === 'agent-worker' && /请把下面这件后台任务/.test(c.payload.text || ''))
      .map((c) => c.payload.text.match(/任务 (\d+)/)[1]);
    expect(chatDescs).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    const ids = ran.map((r) => r.id);
    expect(ids[0]).toBe('t0001');
    expect(ids[9]).toBe('t0010');
  });

  test('the working status is published during execution and cleared after', async () => {
    await boot();
    await pump();
    await enqueue('搬砖任务');

    // 截获 share.set 的时序：执行中 working、结束后 idle。
    const shareTimeline = [];
    const originalAnswer = answer;
    void originalAnswer;
    REPLY_TABLE.execute.push(() => {
      // 这一刻：任务正在执行（chat 回包之前）。
      const sets = requests().filter((r) => r.method === 'share.set' && r.payload.name === 'agent/status');
      const last = JSON.parse(sets[sets.length - 1].payload.value);
      shareTimeline.push(last.status);
      return { text: '结果一份。' };
    });
    await runDrain();

    const sets = requests().filter((r) => r.method === 'share.set' && r.payload.name === 'agent/status');
    const values = sets.map((r) => JSON.parse(r.payload.value));
    // 第一条是 working（带 taskId 与 progress），最后一条是 idle。
    expect(values[0].status).toBe('working');
    expect(values[0].taskId).toBe('t0001');
    expect(typeof values[0].progress).toBe('number');
    expect(values[values.length - 1].status).toBe('idle');
    expect(shareTimeline).toEqual(['working']);
  });

  test('a failed first attempt retries once; a second failure is terminal', async () => {
    await boot();
    await pump();
    await enqueue('会失败两次的任务');

    REPLY_TABLE.execute.push(new Error('记忆核心没有返回内容'));
    REPLY_TABLE.execute.push(new Error('记忆核心没有返回内容'));
    console.log('DIAG table before:', REPLY_TABLE.execute.length, REPLY_TABLE.announce.length);
    const origCallReply = callReplyFor;
    void origCallReply;
    const ran = await runDrain();
    console.log('DIAG calls:', callCalls.map((c) => (c.payload && c.payload.hint || '').slice(0, 10)));
    console.log('DIAG table after:', REPLY_TABLE.execute.length, REPLY_TABLE.announce.length);
    // drain 跑到没有 pending：第一次失败回 pending（同轮重试），第二次失败终态。
    // ran[i].status 是**那一次执行结束**时盘上的状态——中间那次是 pending（等待重试），
    // 最后一次是终态。终态以 store 为准。
    expect(ran).toHaveLength(2);
    expect(ran[ran.length - 1].status).toBe('failed');
    const stored = tasksFromStore()[0];
    expect(stored.status).toBe('failed');
    expect(stored.attempts).toBe(2);
    expect(stored.error).toContain('没有返回内容');
  });

  test('a first failure goes back to pending and a later drain completes it', async () => {
    await boot();
    await pump();
    await enqueue('先失败后成功的任务');

    REPLY_TABLE.execute.push(new Error('临时故障'));
    const ran1 = await runDrain();
    // drain 把重试也跑掉了（回 pending 后仍在同一轮排空里）——这里它第二次就成功了。
    expect(ran1).toHaveLength(2);
    expect(ran1[ran1.length - 1].status).toBe('done');
    expect(tasksFromStore()[0].attempts).toBe(2);
    expect(tasksFromStore()[0].status).toBe('done');
  });

  test('recoverOrphans: a running task left by a dead process resumes (or fails terminally)', async () => {
    await boot();
    await pump();
    // 中断时的样子：一个 running、attempts=1（还有一次重试机会）。
    await seedTasks([
      { id: 't0001', description: '被中断的任务', status: 'running', attempts: 1, createdAt: 1, startedAt: 2, finishedAt: 0, result: '', error: '' },
    ]);
    const recovered = await withPump(window.__agent.recoverOrphans());
    expect(recovered).toBe(1);
    const stored = tasksFromStore()[0];
    expect(stored.status).toBe('pending');
    expect(stored.error).toContain('中断');

    // 之后再跑一轮就能完成。
    const ran = await runDrain();
    expect(ran[0].status).toBe('done');
  });

  test('recoverOrphans sends an exhausted running task to failed', async () => {
    await boot();
    await pump();
    await seedTasks([
      { id: 't0001', description: '重试也耗尽的任务', status: 'running', attempts: 2, createdAt: 1, startedAt: 2, finishedAt: 0, result: '', error: '' },
    ]);
    await withPump(window.__agent.recoverOrphans());
    expect(tasksFromStore()[0].status).toBe('failed');
  });

  test('announce goes through memcore/chat after completion and failure', async () => {
    await boot();
    await pump();
    await enqueue('要播报的任务');
    const ran = await runDrain();
    expect(ran[0].status).toBe('done');
    const announces = callCalls.filter((c) => /\[系统通知\]/.test(c.payload && c.payload.text || ''));
    expect(announces).toHaveLength(1);
    expect(announces[0].payload.text).toContain('完成');
  });

  test('empty queue: drain is a no-op and no status is published', async () => {
    await boot();
    await pump();
    const ran = await runDrain();
    expect(ran).toHaveLength(0);
    expect(requests().filter((r) => r.method === 'share.set')).toHaveLength(0);
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
