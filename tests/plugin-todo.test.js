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

  test('the list role re-reads on a slow tick', async () => {
    const { sent, init, respond } = await mount({ granted: listGrant, surface: { kind: 'surface' } });
    init();
    respond(lastOf(sent, 'storage.get').id, { value: '[]' });
    const before = reads(sent);

    await new Promise((r) => setTimeout(r, 2300));

    expect(reads(sent), 'the list never re-read: the other window is invisible').toBeGreaterThan(before);
  });

  test('the poll pauses while a write of its own is in flight', async () => {
    const { window, sent, init, respond } = await mount({
      granted: listGrant,
      surface: { kind: 'surface' },
    });
    init();
    respond(lastOf(sent, 'storage.get').id, { value: '[]' });

    // Add a row and deliberately do NOT answer the resulting storage.set: the write is "in
    // flight", and a read issued now would come back with the copy from before it.
    window.document.getElementById('title').value = '买菜';
    window.document.getElementById('add').dispatchEvent(
      new window.MouseEvent('click', { bubbles: true }),
    );
    const afterWrite = reads(sent);

    await new Promise((r) => setTimeout(r, 2300));
    expect(reads(sent), 'a poll ran on top of an unanswered write').toBe(afterWrite);

    // Answering it lets the poll resume, so this is a pause and not a stop.
    const write = lastOf(sent, 'storage.set');
    respond(write.id, null);
    sent.length = 0;
    respond(lastOf(sent, 'storage.get')?.id ?? 'no-read', { value: '[]' });
    await new Promise((r) => setTimeout(r, 2300));
    expect(reads(sent)).toBeGreaterThan(0);
  });
});
