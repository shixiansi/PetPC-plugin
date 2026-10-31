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
