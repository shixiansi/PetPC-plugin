import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Behaviour tests for the todo plugin, driven through its real panel.html in jsdom.
//
// What this file exists for: 1.1.0 made the LIST this plugin's own data. It used to be the host's
// (`todos.*`), and the host's store was the single source of truth; now `storage` is, `share` is a
// snapshot published for the pomodoro's picker, and the headless frame must never write. Those three
// sentences are exactly the kind of thing that can be true in the source and false in the running
// document - a wrong `role` check, a forgotten `publishList()`, a `storage.set` left in the reminder
// loop - so they are asserted here against the messages the frame actually posts.

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-todo');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const source = readFileSync(path.join(pluginDir, 'app.js'), 'utf8');

/** Boots the plugin in a fresh jsdom and returns the frame's outbox. */
async function mount({ granted, surface }) {
  const dom = new JSDOM(html, { url: 'https://plugin.invalid/panel.html', runScripts: 'outside-only' });
  const { window } = dom;
  const sent = [];
  window.parent = window;
  window.postMessage = (msg) => sent.push(msg);

  window.eval(source);

  const init = (extra = {}) => {
    const data = {
      v: 1,
      type: 'init',
      theme: 'dark',
      granted,
      surface,
      ...extra,
    };
    const event = new window.MessageEvent('message', { data });
    Object.defineProperty(event, 'source', { value: window });
    window.dispatchEvent(event);
  };
  const respond = (id, result, ok = true) => {
    const event = new window.MessageEvent('message', { data: { v: 1, type: 'response', id, ok, result } });
    Object.defineProperty(event, 'source', { value: window });
    window.dispatchEvent(event);
  };

  // The handshake is one of the things asserted below, so it is read before init.
  await Promise.resolve();
  return { window, sent, init, respond };
}

const listGrant = ['storage', 'plugin.share', 'plugin.config', 'pet.surface', 'pet.bubble'];
const lastOf = (sent, method) => [...sent].reverse().find((m) => m.method === method);

describe('todo plugin 1.1.0: the list is this plugin\'s data', () => {
  test('it asks storage for its own key, never the host\'s todo methods', async () => {
    const { sent, init } = await mount({ granted: listGrant, surface: { kind: 'surface' } });
    init();
    const read = lastOf(sent, 'storage.get');
    expect(read, 'no storage.get after init').toBeTruthy();
    expect(read.payload.key).toBe('todos-v1');
    // The capability it used to depend on is gone from the host entirely; a frame that still asked
    // would get "本程序不支持该方法" and show an empty list forever.
    expect(sent.filter((m) => String(m.method || '').startsWith('todos.'))).toEqual([]);
  });

  test('a stored list is parsed, rendered, and published as the shared snapshot', async () => {
    const { window, sent, init, respond } = await mount({
      granted: listGrant,
      surface: { kind: 'surface' },
    });
    init();
    const read = lastOf(sent, 'storage.get');
    respond(read.id, {
      value: JSON.stringify([
        { id: 'a', title: '写周报', done: false, due: '' },
        { id: 'b', title: '整理纸箱', done: true, due: '' },
      ]),
    });

    expect(window.document.getElementById('list').textContent).toContain('写周报');
    expect(window.document.getElementById('status').textContent).toBe('1 件未完成');

    const shared = lastOf(sent, 'share.set');
    expect(shared, 'the list was not published to share').toBeTruthy();
    expect(shared.payload.name).toBe('todo-list');
    expect(JSON.parse(shared.payload.value).map((t) => t.id)).toEqual(['a', 'b']);
  });

  test('an unreadable stored value falls back to an empty list instead of going mute', async () => {
    const { window, sent, init, respond } = await mount({
      granted: listGrant,
      surface: { kind: 'surface' },
    });
    init();
    respond(lastOf(sent, 'storage.get').id, { value: '{"not":"an array"' }, false);
    expect(window.document.getElementById('status').textContent).toBe('都做完了');
    // Still published: a fresh install must have a snapshot, even an empty one.
    expect(lastOf(sent, 'share.set')).toBeTruthy();
  });

  test('adding a todo writes storage AND republishes the snapshot', async () => {
    const { window, sent, init, respond } = await mount({
      granted: listGrant,
      surface: { kind: 'surface' },
    });
    init();
    respond(lastOf(sent, 'storage.get').id, { value: '[]' });
    sent.length = 0;

    const title = window.document.getElementById('title');
    title.value = '买菜';
    window.document.getElementById('add').dispatchEvent(
      new window.MouseEvent('click', { bubbles: true }),
    );

    const write = lastOf(sent, 'storage.set');
    expect(write, 'adding did not write storage').toBeTruthy();
    expect(write.payload.key).toBe('todos-v1');
    const stored = JSON.parse(write.payload.value);
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe('买菜');
    expect(stored[0].id).toBeTruthy();
    // The snapshot travels with the write, or the pomodoro's picker stays one edit behind.
    expect(JSON.parse(lastOf(sent, 'share.set').payload.value)).toHaveLength(1);
  });

  test('ticking a todo flips done in the stored copy', async () => {
    const { window, sent, init, respond } = await mount({
      granted: listGrant,
      surface: { kind: 'surface' },
    });
    init();
    respond(lastOf(sent, 'storage.get').id, {
      value: JSON.stringify([{ id: 'a', title: '写周报', done: false, due: '' }]),
    });
    sent.length = 0;

    const tick = window.document.querySelector('#list .tick');
    tick.checked = true;
    tick.dispatchEvent(new window.Event('change', { bubbles: true }));

    const stored = JSON.parse(lastOf(sent, 'storage.set').payload.value);
    expect(stored[0].done).toBe(true);
  });

  test('the headless frame reads the list and writes nothing', async () => {
    const { sent, init } = await mount({
      granted: listGrant,
      surface: { kind: 'panel', slot: 'background' },
    });
    init();
    // It does read: the reminder needs to know whether anything is undone.
    expect(lastOf(sent, 'storage.get').payload.key).toBe('todos-v1');
    // And it never writes - two writers to one key is a read-modify-write race over the whole list.
    expect(sent.filter((m) => m.method === 'storage.set')).toEqual([]);
    expect(sent.filter((m) => m.method === 'share.set')).toEqual([]);
  });
});

describe('todo plugin 1.2.0: one list, two windows', () => {
  // 1.2.0 exists because the control center's 插件 page mounts THIS document: the list can be on
  // screen twice (the pet's column and a real window). A mount-time read was enough while the
  // surface was the only writer, and is wrong the moment a second window can add or tick a row.
  const reads = (sent) => sent.filter((m) => m.method === 'storage.get').length;

  // 2026-11-01：轮询换成事件。这个插件的一份列表会同时出现在桌宠的列、控制中心的插件页和常驻的
  // 提醒帧里，而**两个宿主**现在都会推 `storage.changed`（手册 §7.2）。以前 2 秒一次的
  // `storage.get` 是它最大的一笔调用量。
  const storageChanged = (window, key) => {
    const event = new window.MessageEvent('message', {
      data: { v: 1, type: 'event', name: 'storage.changed', payload: { key } },
    });
    Object.defineProperty(event, 'source', { value: window });
    window.dispatchEvent(event);
  };

  test('storage.changed 到了就立刻重读，别的键不动', async () => {
    const { window, sent, init, respond } = await mount({ granted: listGrant, surface: { kind: 'surface' } });
    init();
    respond(lastOf(sent, 'storage.get').id, { value: '[]' });
    sent.length = 0;

    // 别人的键：一次都不读。
    storageChanged(window, 'state/other');
    await new Promise((r) => setTimeout(r, 50));
    expect(reads(sent), 'a foreign key triggered a read').toBe(0);

    // 自己的键：立刻读。
    storageChanged(window, 'todos-v1');
    await new Promise((r) => setTimeout(r, 50));
    expect(reads(sent), 'storage.changed did not trigger a read').toBeGreaterThan(0);
  });

  test('写入还在飞的时候，事件也不读', async () => {
    const { window, sent, init, respond } = await mount({ granted: listGrant, surface: { kind: 'surface' } });
    init();
    respond(lastOf(sent, 'storage.get').id, { value: '[]' });

    // 加一行，并且**故意不回答**随之而来的 storage.set：写入"在飞"，此刻读回来的还是旧的那份。
    window.document.getElementById('title').value = '买菜';
    window.document.getElementById('add').dispatchEvent(
      new window.MouseEvent('click', { bubbles: true }),
    );
    const afterWrite = reads(sent);
    storageChanged(window, 'todos-v1');
    await new Promise((r) => setTimeout(r, 50));
    expect(reads(sent), 'a read ran on top of an unanswered write').toBe(afterWrite);

    // 回答之后，同一个事件就能读了——所以那是"暂停"，不是"停掉"。
    respond(lastOf(sent, 'storage.set').id, null);
    storageChanged(window, 'todos-v1');
    await new Promise((r) => setTimeout(r, 50));
    expect(reads(sent)).toBeGreaterThan(afterWrite);
  });

  test('兜底是 30 秒，不是 2 秒', () => {
    expect(source, 'the fallback went back to a fast poll').toContain('}, 30_000);');
    expect(source).not.toContain('}, 2000);');
  });
});

// --- answering other plugins -------------------------------------------------

describe('todo answers plugin.call stats（看板每 30 秒问一次）', () => {
  /** 往窗口里塞一条宿主发来的消息：call 不是 init/response，harness 里没有现成的入口。 */
  function say(window, data) {
    const event = new window.MessageEvent('message', { data });
    Object.defineProperty(event, 'source', { value: window });
    window.dispatchEvent(event);
  }

  const threeItems = JSON.stringify([
    { id: 'a', title: '写周报', done: false, due: '18:00' },
    { id: 'b', title: '整理纸箱', done: true, due: '' },
    { id: 'c', title: '交电费', done: false, due: '' },
  ]);

  test('stats 回四个数：total / done / open / dueToday / completionRate', async () => {
    const { window, sent, init, respond } = await mount({
      granted: [...listGrant, 'plugin.call'],
      surface: { slot: 'background' },
    });
    init();
    respond(lastOf(sent, 'storage.get').id, { value: threeItems });
    await Promise.resolve();

    say(window, {
      v: 1, type: 'call', ticket: 'tk-1',
      from: 'com.shixiansi.plugin-web-dashboard', method: 'stats', payload: {},
    });
    await new Promise((r) => setTimeout(r, 0));

    const answer = sent.find((m) => m.type === 'call-result');
    expect(answer, 'call 没有被回答（调用方只会等到 30 秒超时）').toBeTruthy();
    expect(answer.ticket).toBe('tk-1');
    expect(answer.ok).toBe(true);
    expect(answer.result).toMatchObject({ total: 3, done: 1, open: 2, dueToday: 1, completionRate: 33 });
  });

  test('不认识的方法要回一条中文拒绝，而不是沉默', async () => {
    const { window, sent, init } = await mount({
      granted: [...listGrant, 'plugin.call'],
      surface: { slot: 'background' },
    });
    init();
    say(window, { v: 1, type: 'call', ticket: 'tk-2', from: 'x', method: 'todos', payload: {} });
    await new Promise((r) => setTimeout(r, 0));

    const answer = sent.find((m) => m.type === 'call-result');
    expect(answer, '拒绝也要有回包').toBeTruthy();
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain('不认识方法');
    expect(answer.error).toContain('stats');
  });
});

// --- 1.3.0：代别人读写（`serves`: add_task / toggle / list）-------------------

describe('todo 1.3.0: add_task / toggle / list（别的插件用 plugin.call 问）', () => {
  // 这一组钉的是「别人能不能替用户记一件事」，以及三条新方法**失败时的样子**。
  //
  // 为什么值得单独一组：49 个 `serves` 里带写入的只有六个，而待办 1.3.0 之前只 serve `stats`——
  // 于是"把会议纪要里的待办加进列表"这类最常见的助手动作做不到。可是一个会**写**的接口比只读的
  // 危险一个量级：回了 `{id, text, total, open}` 却什么都没写，调用方（往往是个模型）会把它写进
  // 摘要，用户的列表一动没动，而没人会去查。所以每个方法都有一条反例钉在下面。
  const callGrant = [...listGrant, 'plugin.call'];
  const flush = () => new Promise((r) => setTimeout(r, 0));

  /** 宿主发来的 `call`：harness 里只搭了 init / response / event 三个入口。 */
  function call(m, method, payload, ticket) {
    const event = new m.window.MessageEvent('message', {
      data: {
        v: 1,
        type: 'call',
        ticket,
        from: 'com.shixiansi.plugin-meeting-notes',
        method,
        payload,
      },
    });
    Object.defineProperty(event, 'source', { value: m.window });
    m.window.dispatchEvent(event);
  }

  /**
   * 宿主的**拒绝**长这样：`{ok:false, error}`。
   *
   * 用自己拼的一条而不是 harness 的 `respond(id, result, false)`：后者把文案塞进 `result`，而真
   * 宿主把失败原因放在 `error`（手册第 5 节）。这个区别就是"插件有没有把原因转回给调用方"。
   */
  function respondError(m, id, message) {
    const event = new m.window.MessageEvent('message', {
      data: { v: 1, type: 'response', id, ok: false, error: message },
    });
    Object.defineProperty(event, 'source', { value: m.window });
    m.window.dispatchEvent(event);
  }

  /** 常驻帧（background）—— `plugin.call` 优先由它答。 */
  async function boot(granted = callGrant) {
    const m = await mount({ granted, surface: { slot: 'background' } });
    m.done = new Set();
    m.init();
    // init 会读两次（上次提醒时间 + 列表）：先都答应掉，后面的计数才是从零开始的。
    for (const req of m.sent.filter((x) => x.type === 'request' && x.method === 'storage.get')) {
      m.done.add(req.id);
      m.respond(req.id, { value: '[]' });
    }
    await flush();
    m.sent.length = 0;
    return m;
  }

  /** 等到帧发出下一条**还没被回答过**的某种请求（写方法是异步的：先读、再写、再回包）。 */
  async function waitRequest(m, method) {
    for (let i = 0; i < 50; i += 1) {
      const hit = [...m.sent].reverse().find(
        (x) => x.type === 'request' && x.method === method && !m.done.has(x.id),
      );
      if (hit) {
        m.done.add(hit.id);
        return hit;
      }
      await flush();
    }
    return null;
  }

  async function waitAnswer(m, ticket) {
    for (let i = 0; i < 50; i += 1) {
      const hit = [...m.sent].reverse().find((x) => x.type === 'call-result' && x.ticket === ticket);
      if (hit) return hit;
      await flush();
    }
    return null;
  }

  /** 跑一次**成功**的写方法：回答它现读的底稿，再回答它的写入。 */
  async function runWrite(m, method, payload, ticket, stored) {
    call(m, method, payload, ticket);
    const read = await waitRequest(m, 'storage.get');
    expect(read, `${method} 没有先读一次底稿就写`).toBeTruthy();
    expect(read.payload.key).toBe('todos-v1');
    m.respond(read.id, { value: stored });
    const write = await waitRequest(m, 'storage.set');
    expect(write, `${method} 没有写 storage`).toBeTruthy();
    expect(write.payload.key).toBe('todos-v1');
    m.respond(write.id, null);
    const answer = await waitAnswer(m, ticket);
    expect(answer, 'call 没有被回答（调用方只会等到 30 秒超时）').toBeTruthy();
    expect(answer.ticket).toBe(ticket);
    return { answer, write, read };
  }

  const twoItems = JSON.stringify([
    { id: 'a', title: '写周报', done: false, due: '' },
    { id: 'b', title: '整理纸箱', done: true, due: '' },
  ]);

  test('add_task：回 {id, text, total, open}，并且真的写进 storage', async () => {
    const stored = JSON.stringify([
      { id: 'a', title: '写周报', done: false, due: '' },
      { id: 'b', title: '整理纸箱', done: true, due: '' },
    ]);
    const m = await boot();
    const { answer, write } = await runWrite(
      m,
      'add_task',
      { text: '  买牛奶  ', due: ' 2026-11-05 18:00 ' },
      'tk-add',
      stored,
    );

    expect(answer.ok).toBe(true);
    expect(answer.result.text).toBe('买牛奶');
    expect(answer.result.total).toBe(3);
    expect(answer.result.open).toBe(2);
    expect(answer.result.id, 'id 是插件自己生成的').toBeTruthy();

    const saved = JSON.parse(write.payload.value);
    expect(saved).toHaveLength(3);
    expect(saved[2]).toMatchObject({ id: answer.result.id, title: '买牛奶', done: false, due: '2026-11-05 18:00' });

    // 快照跟着走：番茄钟的挑选器读的是它，少一次发布就少一条可选。
    const shared = [...m.sent].reverse().find((x) => x.method === 'share.set');
    expect(shared, '写入之后没有重新发布 share 快照').toBeTruthy();
    expect(JSON.parse(shared.payload.value)).toHaveLength(3);
  });

  test('add_task：text 为空要中文 error 点名 text，且一个字节都不写', async () => {
    const m = await boot();
    call(m, 'add_task', { text: '   \n\t ' }, 'tk-empty');
    const answer = await waitAnswer(m, 'tk-empty');

    expect(answer, '拒绝也要有回包').toBeTruthy();
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain('text 为空');
    expect(m.sent.filter((x) => x.method === 'storage.set')).toEqual([]);
  });

  test('add_task：超长 text 被拒（200 是上限，200 本身可以）', async () => {
    const m = await boot();

    call(m, 'add_task', { text: 'x'.repeat(201) }, 'tk-long');
    const rejected = await waitAnswer(m, 'tk-long');
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toContain('text 太长');
    expect(rejected.error).toContain('200');
    expect(m.sent.filter((x) => x.method === 'storage.set')).toEqual([]);

    // 边界值的另一侧：正好 200 是一个正常的待办，不是错误。少查这一条，上限就会被写成 199。
    const { answer } = await runWrite(m, 'add_task', { text: 'y'.repeat(200) }, 'tk-edge', '[]');
    expect(answer.ok).toBe(true);
    expect(answer.result.text).toHaveLength(200);
    expect(answer.result.total).toBe(1);
  });

  test('toggle：按 id 精确命中，回 {id, done, open}', async () => {
    const m = await boot();
    const { answer, write } = await runWrite(m, 'toggle', { id: 'b' }, 'tk-toggle-id', twoItems);

    expect(answer.ok).toBe(true);
    expect(answer.result).toMatchObject({ id: 'b', done: false, open: 2 });
    const saved = JSON.parse(write.payload.value);
    expect(saved[1]).toMatchObject({ id: 'b', done: false });
    expect(saved[0].done, '没点名的行不该被动').toBe(false);
  });

  test('toggle：index 是兼容路径（0 基），越界要中文 error', async () => {
    const m = await boot();
    const { answer, write } = await runWrite(m, 'toggle', { index: 0 }, 'tk-toggle-index', twoItems);
    expect(answer.ok).toBe(true);
    expect(answer.result).toMatchObject({ id: 'a', done: true, open: 0 });
    expect(JSON.parse(write.payload.value)[0].done).toBe(true);

    const before = m.sent.filter((x) => x.method === 'storage.set').length;
    const reads = m.sent.filter((x) => x.type === 'request' && x.method === 'storage.get').length;
    call(m, 'toggle', { index: 5 }, 'tk-toggle-range');
    const read = await waitRequest(m, 'storage.get');
    expect(read, '越界要读完列表才能判').toBeTruthy();
    m.respond(read.id, { value: twoItems });
    const out = await waitAnswer(m, 'tk-toggle-range');
    expect(out.ok).toBe(false);
    expect(out.error).toContain('越界');
    expect(m.sent.filter((x) => x.method === 'storage.set').length, '越界的 index 不该写 storage').toBe(before);

    // 形状错的 index 连读都不该读：那一次读只是把时间花在一个注定失败的调用上。
    call(m, 'toggle', { index: -1 }, 'tk-toggle-neg');
    const neg = await waitAnswer(m, 'tk-toggle-neg');
    expect(neg.ok).toBe(false);
    expect(neg.error).toContain('非负整数');
    expect(
      m.sent.filter((x) => x.type === 'request' && x.method === 'storage.get').length,
      '形状错的 index 不值得读一次 storage',
    ).toBe(reads + 1);
  });

  test('toggle：id 找不到要点名那个 id，不许静默成功', async () => {
    const m = await boot();
    call(m, 'toggle', { id: 'nope-42' }, 'tk-toggle-miss');
    const read = await waitRequest(m, 'storage.get');
    expect(read, '不知道存不存在就回答"翻好了"，是这次调用最坏的结局').toBeTruthy();
    m.respond(read.id, { value: twoItems });

    const answer = await waitAnswer(m, 'tk-toggle-miss');
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain('nope-42');
    expect(answer.error).toContain('找不到');
    expect(m.sent.filter((x) => x.method === 'storage.set')).toEqual([]);
  });

  test('list：三种 filter 与缺省，形状固定且只读', async () => {
    const stored = JSON.stringify([
      { id: 'a', title: '写周报', done: false, due: '18:00' },
      { id: 'b', title: '整理纸箱', done: true, due: '' },
      { id: 'c', title: '交电费', done: false, due: '' },
    ]);
    const m = await boot();
    const cases = [
      [{}, ['a', 'c']],
      [{ filter: 'open' }, ['a', 'c']],
      [{ filter: 'done' }, ['b']],
      [{ filter: 'all' }, ['a', 'b', 'c']],
    ];
    const answers = [];
    for (let i = 0; i < cases.length; i += 1) {
      const [payload, ids] = cases[i];
      const ticket = `tk-list-${i}`;
      call(m, 'list', payload, ticket);
      const read = await waitRequest(m, 'storage.get');
      expect(read, 'list 没有读 storage').toBeTruthy();
      m.respond(read.id, { value: stored });
      const answer = await waitAnswer(m, ticket);
      expect(answer, `list ${JSON.stringify(payload)} 没有回包`).toBeTruthy();
      expect(answer.ok, `list ${JSON.stringify(payload)} 被拒了：${answer.error}`).toBe(true);
      expect(answer.result.items.map((t) => t.id)).toEqual(ids);
      expect(answer.result.total).toBe(3);
      expect(answer.result.open).toBe(2);
      answers.push(answer.result);
    }

    // 每一项的字段是**定死的四个**：多一个少一个，调用方那边的 `item.text` 就是 undefined。
    for (const item of answers[3].items) {
      expect(Object.keys(item).sort()).toEqual(['done', 'due', 'id', 'text']);
    }
    expect(answers[3].items[0]).toMatchObject({ id: 'a', text: '写周报', done: false, due: '18:00' });

    // 只读：不写 storage、不重新发布快照、不弹气泡、不碰界面。
    expect(m.sent.filter((x) => ['storage.set', 'share.set', 'bubble.say'].includes(x.method))).toEqual([]);

    // 拼错的 filter 要报错，而不是悄悄当成缺省 open：那看起来像"完成的任务全丢了"。
    call(m, 'list', { filter: 'pending' }, 'tk-list-bad');
    const bad = await waitAnswer(m, 'tk-list-bad');
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('filter');
    expect(bad.error).toContain('open');
  });

  test('toggle / add_task 都不给参数时也是中文 error，不是抛栈', async () => {
    const m = await boot();
    call(m, 'toggle', {}, 'tk-toggle-none');
    const answer = await waitAnswer(m, 'tk-toggle-none');
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain('id');
    expect(answer.error).toContain('index');
  });

  test('不认识的方法：回包，并且把那句话里的四个方法名都列出来', async () => {
    const m = await boot();
    call(m, 'delete_task', {}, 'tk-unknown');
    const answer = await waitAnswer(m, 'tk-unknown');
    expect(answer, '拒绝也要有回包').toBeTruthy();
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain('不认识方法');
    // CALL_HANDLERS 加满之后那句话仍然要通顺：它自动列出全部四个方法名。
    for (const name of ['stats', 'add_task', 'toggle', 'list']) {
      expect(answer.error).toContain(name);
    }
  });

  test('未获权限（granted 里没有 storage）：三条都回中文 error，不发任何请求', async () => {
    const m = await boot([...callGrant].filter((p) => p !== 'storage'));
    const tickets = ['tk-deny-add', 'tk-deny-toggle', 'tk-deny-list'];
    const calls = [
      ['add_task', { text: '买菜' }],
      ['toggle', { id: 'a' }],
      ['list', {}],
    ];
    for (let i = 0; i < calls.length; i += 1) {
      call(m, calls[i][0], calls[i][1], tickets[i]);
      const answer = await waitAnswer(m, tickets[i]);
      expect(answer, `${calls[i][0]} 没有回包`).toBeTruthy();
      expect(answer.ok).toBe(false);
      expect(answer.error).toContain('未获权限');
      expect(answer.error).toContain('storage');
    }
    expect(m.sent.filter((x) => x.type === 'request')).toEqual([]);
  });

  test('宿主拒绝一切（storage.get 被拒）：三条都回中文 error，且一次都没写', async () => {
    // 这是这一组里最要紧的一条：读被拒时**绝不能**当成"空列表"继续——那会把用户整张列表覆盖成
    // 一条新待办，而且他第二天才会发现。
    const m = await boot();
    const tickets = ['tk-rj-add', 'tk-rj-toggle', 'tk-rj-list'];
    const calls = [
      ['add_task', { text: '买菜' }],
      ['toggle', { id: 'a' }],
      ['list', {}],
    ];
    for (let i = 0; i < calls.length; i += 1) {
      call(m, calls[i][0], calls[i][1], tickets[i]);
      const read = await waitRequest(m, 'storage.get');
      expect(read, `${calls[i][0]} 没有读 storage`).toBeTruthy();
      respondError(m, read.id, '未获授权：storage');
      const answer = await waitAnswer(m, tickets[i]);
      expect(answer, `${calls[i][0]} 没有回包`).toBeTruthy();
      expect(answer.ok).toBe(false);
      expect(answer.error).toContain('读不到列表');
      expect(answer.error).toContain('未获授权');
    }
    expect(m.sent.filter((x) => x.method === 'storage.set'), '读不到底稿就写 = 覆盖用户数据').toEqual([]);
  });

  test('宿主拒绝 storage.set：回中文 error，且不发布一份没存进去的快照', async () => {
    const m = await boot();
    call(m, 'add_task', { text: '买菜' }, 'tk-write-denied');
    const read = await waitRequest(m, 'storage.get');
    m.respond(read.id, { value: twoItems });
    const write = await waitRequest(m, 'storage.set');
    respondError(m, write.id, '磁盘写不进去');

    const answer = await waitAnswer(m, 'tk-write-denied');
    expect(answer.ok, '写失败了还回成功，就是把"没做成"报成"做好了"').toBe(false);
    expect(answer.error).toContain('写入 storage 失败');
    expect(answer.error).toContain('磁盘写不进去');
    expect(m.sent.filter((x) => x.method === 'share.set'), '没写进 storage 的列表不许发布').toEqual([]);
  });
});
