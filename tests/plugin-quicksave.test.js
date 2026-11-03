import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 速记盒子的行为测试：驱动的是 panel.html 里真实加载的那两支脚本。
//
// harness 与 todo / imgbed 那几份同型：每个用例开一个干净的 jsdom，把 `<script src>` 里那几支
// 经典 script 拼成一份源码 `window.eval` 进去（等于浏览器里它们共享一个全局作用域），出站的
// postMessage 记进 `sent`，宿主的每一条回答由用例自己给——所以断言的是**帧真的发了什么**，
// 而不是"源码里看起来写了什么"。
//
// 这个文件钉住的几件事：
//
//   1. manifest 的形状：五项权限（声明了浮层面就必须有 pet.surface）、serves 是 add/recent、
//      常驻帧由 plugin.call 撑着、三项设置的默认值、assets 覆盖了页面引用的每个文件；
//   2. 握手：监听器先装、`init` 之前一个请求都不发、授权缺哪一项控件就是禁用的；
//   3. `serves.add`：回包形状、去空白、1..500 字的上限、标签归一、默认标签；
//   4. 重复内容合并：不新增、只更新 at 并置顶、merged:true；
//   5. 上限淘汰：按 at 升序（最久没被碰过的先走）、一次只淘汰到刚好不超、合并过的不该先走；
//   6. `serves.recent`：最新在前、limit 默认 10 / 上限 50、query 大小写不敏感、tag 筛、
//      搜不到回空数组、参数错了说清楚；
//   7. `plugin.call`：未知方法回一句中文，而不是沉默（沉默只能让调用方等 30 秒超时）；
//   8. `pet.bubble`：设置打开后 add 成功会说一句（带条数），默认关着就一句都不说；
//   9. 控制中心里不请求只有桌宠才服务的方法，并把"这里说不了话"写出来；
//  10. 宿主拒绝一切时：三条路都回"未获权限"、一条数据都不写、界面上草稿还在。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-quicksave');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');
const source = scriptSources
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

// 两个宿主的服务表（照抄 init.host.methods 的真实形状）：控制中心没有宠物窗口、没有浮层面。
const PET_METHODS = [
  'bubble.say', 'config.get', 'pet.badge', 'plugin.call',
  'storage.get', 'storage.remove', 'storage.set',
  'surface.blocks', 'surface.hide', 'surface.show',
];
const WORKSHOP_METHODS = ['config.get', 'storage.get', 'storage.remove', 'storage.set'];

const KEY = 'notes-v1';

describe('manifest', () => {
  test('五项权限，而且声明了浮层面就有 pet.surface 撑着', () => {
    expect([...manifest.permissions].sort()).toEqual(
      ['pet.bubble', 'pet.surface', 'plugin.call', 'plugin.config', 'storage'],
    );
    // 声明 surface 却不申请 pet.surface 的清单会被宿主拒绝，而表现是"那张卡片在真机上永远打不开"。
    expect(manifest.permissions).toContain('pet.surface');
    expect(manifest.surface).toHaveLength(1);
  });

  test('浮层面那一块是 300×132、圆角 14、最多长到 152', () => {
    const rect = manifest.surface[0];
    expect([rect.w, rect.h, rect.radius, rect.maxH]).toEqual([300, 132, 14, 152]);
    expect([rect.dx, rect.dy]).toEqual([160, -140]);
  });

  test('serves 是 add / recent，常驻帧由 plugin.call 撑着', () => {
    expect(manifest.serves).toEqual(['add', 'recent']);
    expect(manifest.background).toBe(true);
    // background 的四个依据之一是 plugin.call —— 没有它，常驻帧根本不会挂，serves 也就没人答。
    expect(manifest.permissions).toContain('plugin.call');
  });

  test('三项设置：条数默认 500（20–2000）、说一句默认关、默认标签是空串', () => {
    const byKey = Object.fromEntries(manifest.config.map((item) => [item.key, item]));
    expect(Object.keys(byKey).sort()).toEqual(['defaultTag', 'maxItems', 'sayOnSave']);
    expect(byKey.maxItems.type).toBe('number');
    expect(byKey.maxItems.default).toBe('500');
    expect(byKey.sayOnSave.type).toBe('bool');
    // 默认关：一张每次保存都说一句的嘴会让人关掉整个插件。
    expect(byKey.sayOnSave.default).toBe('false');
    expect(byKey.defaultTag.type).toBe('text');
    expect(byKey.defaultTag.default).toBe('');
  });

  test('页面引用的每个本地文件都写进了 assets，而且真的在磁盘上', () => {
    const fixed = ['panel.html', 'app.js', 'style.css'];
    for (const src of scriptSources) {
      if (fixed.includes(src)) continue;
      expect(manifest.assets, `${src} 没写进 assets：装好的插件里它是 404`).toContain(src);
    }
    for (const asset of manifest.assets) {
      expect(existsSync(path.join(pluginDir, asset)), `assets 里的 ${asset} 不存在`).toBe(true);
    }
    expect(existsSync(path.join(pluginDir, manifest.entry))).toBe(true);
  });

  test('description 是给安装对话框看的中文，不超过 512 字', () => {
    expect([...manifest.description].length).toBeLessThanOrEqual(512);
    expect(manifest.description).toContain('速记');
  });
});

// --- harness -----------------------------------------------------------------

let store;
let doms;

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function surfaceFor(role) {
  if (role === 'card') {
    return {
      kind: 'surface', rectIndex: 0, rectCount: 1,
      rect: { x: 0, y: 0, w: 300, h: 132, r: 14, tailX: 150, hidden: false, room: 160 },
    };
  }
  return { kind: 'panel', slot: role };
}

/** 装一份帧。`role` 决定它是浮层面卡片、控制中心的插件页，还是桌宠那边的常驻帧。 */
function boot({ role = 'card', granted = manifest.permissions, theme } = {}) {
  const dom = new JSDOM(html, { url: 'https://plugin.invalid/panel.html', runScripts: 'outside-only', pretendToBeVisual: true });
  doms.push(dom);
  const { window } = dom;
  const sent = [];
  const answered = new Set();
  const errors = [];
  window.parent = window;
  window.postMessage = (msg) => sent.push(msg);
  window.addEventListener('error', (event) => errors.push(String(event.message || event.error)));
  // eslint-disable-next-line no-underscore-dangle
  window.eval(source);

  const send = (data) => {
    const event = new window.MessageEvent('message', { data });
    Object.defineProperty(event, 'source', { value: window });
    window.dispatchEvent(event);
  };

  const frame = {
    window,
    sent,
    answered,
    errors,
    send,
    doc: () => window.document,
    requests: () => sent.filter((msg) => msg && msg.type === 'request'),
    lastOf: (method) => [...sent].reverse().find((msg) => msg && msg.type === 'request' && msg.method === method),
    respond: (id, result, { ok = true, error = '' } = {}) => {
      answered.add(id);
      send({ v: 1, type: 'response', id, ok, result, error });
    },
    init(patch = {}) {
      send({
        v: 1,
        type: 'init',
        pluginId: manifest.id,
        permissions: [...manifest.permissions],
        granted: [...granted],
        theme,
        surface: surfaceFor(role),
        host: {
          program: role === 'workshop' ? 'workshop' : 'pet',
          methods: role === 'workshop' ? [...WORKSHOP_METHODS] : [...PET_METHODS],
        },
        ...patch,
      });
    },
  };
  return frame;
}

/**
 * 把还没答的请求答掉，再让出一拍——promise 链与事件监听都在下一拍产生新请求。
 * `mode: 'deny'` 是"宿主拒绝一切"那一遍：每条都回一条中文拒绝，而且**不碰 store**。
 */
async function drain(frame, { mode = 'ok', config = {}, rounds = 14 } = {}) {
  for (let i = 0; i < rounds; i += 1) {
    for (const req of frame.requests()) {
      if (frame.answered.has(req.id)) continue;
      if (mode === 'deny') {
        frame.respond(req.id, undefined, { ok: false, error: `模拟拒绝：未获权限 ${req.method}` });
        continue;
      }
      const payload = req.payload || {};
      switch (req.method) {
        case 'config.get':
          frame.respond(req.id, { values: { ...config }, secrets: {} });
          break;
        case 'storage.get':
          frame.respond(req.id, { value: store.has(String(payload.key)) ? store.get(String(payload.key)) : '' });
          break;
        case 'storage.set':
          store.set(String(payload.key), String(payload.value === undefined ? '' : payload.value));
          frame.respond(req.id, { ok: true });
          break;
        case 'bubble.say':
        case 'surface.blocks':
          frame.respond(req.id, { ok: true });
          break;
        default:
          frame.respond(req.id, null, { ok: false, error: `本程序不支持该方法 ${req.method}` });
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await tick();
  }
}

/** 发一条 `plugin.call`；`take()` 拿这次的回包（可以反复调，取的都是这一次的）。 */
function call(frame, method, payload) {
  const before = frame.sent.filter((msg) => msg && msg.type === 'call-result').length;
  frame.send({
    v: 1, type: 'call', ticket: `t-${Math.random().toString(36).slice(2, 8)}`,
    from: 'com.shixiansi.plugin-chat', method, payload,
  });
  return {
    take() {
      const list = frame.sent.filter((msg) => msg && msg.type === 'call-result').slice(before);
      expect(list.length, 'plugin.call 一直没有回包').toBeGreaterThan(0);
      return list[list.length - 1];
    },
  };
}

function click(frame, id) {
  const node = frame.doc().getElementById(id);
  node.dispatchEvent(new frame.window.MouseEvent('click', { bubbles: true }));
}

/** 手里那份 JSON 的 items（断言用）。 */
function savedItems() {
  return JSON.parse(store.get(KEY)).items;
}

/** 一份已经存好的盒子。`at` 决定"谁最久没被碰过"。 */
function seed(rows) {
  const items = rows.map((row, i) => ({
    id: `n${i + 1}-${row.at.toString(36)}`,
    text: row.text,
    tag: row.tag || '',
    at: row.at,
    seq: i + 1,
  }));
  store.set(KEY, JSON.stringify({ v: 1, seq: items.length, items }));
}

beforeEach(() => {
  store = new Map();
  doms = [];
});

afterEach(() => {
  for (const dom of doms) {
    try {
      dom.window.close();
    } catch {
      /* 已经关了 */
    }
  }
});

// --- 握手 ---------------------------------------------------------------------

describe('握手', () => {
  test('监听器装好之后发 ready，init 之前一个请求都不发，init 之后卡片可用', async () => {
    const frame = boot({ role: 'card' });
    expect(frame.sent[0]).toMatchObject({ v: 1, type: 'ready' });
    expect(frame.requests()).toHaveLength(0);

    frame.init();
    await drain(frame);

    expect(frame.doc().getElementById('quick').disabled).toBe(false);
    expect(frame.doc().getElementById('save').disabled).toBe(false);
    const read = frame.lastOf('storage.get');
    expect(read, 'init 之后应当读一次盒子').toBeTruthy();
    expect(read.payload.key).toBe(KEY);
  });

  test('granted 里没有 storage：控件禁用、写清原因、一个请求都不发', async () => {
    const frame = boot({ role: 'card', granted: ['plugin.config', 'pet.surface', 'pet.bubble', 'plugin.call'] });
    frame.init();
    await drain(frame);

    expect(frame.doc().getElementById('quick').disabled).toBe(true);
    expect(frame.doc().getElementById('save').disabled).toBe(true);
    expect(frame.doc().getElementById('quick-status').textContent).toContain('未获权限 storage');
    // 只问了配置（它还在授权里），一个 storage 请求都没发。
    expect(frame.requests().map((req) => req.method)).toEqual(['config.get']);
  });
});

// --- 主路径：卡片里记一句 ------------------------------------------------------

describe('卡片里记一句', () => {
  test('「记下」写一条、清空输入框、最近三条里出现它', async () => {
    const frame = boot({ role: 'card' });
    frame.init();
    await drain(frame);

    const input = frame.doc().getElementById('quick');
    input.value = '  周五交周报  ';
    click(frame, 'save');
    await drain(frame);

    const write = frame.lastOf('storage.set');
    expect(write, '点了「记下」却没写 storage').toBeTruthy();
    expect(write.payload.key).toBe(KEY);
    expect(savedItems()).toHaveLength(1);
    // 存的是去首尾空白之后的那一句（用户手滑的空格不该变成数据的一部分）。
    expect(savedItems()[0].text).toBe('周五交周报');
    expect(input.value).toBe('');
    expect(frame.doc().getElementById('recent').textContent).toContain('周五交周报');
    expect(frame.doc().getElementById('quick-status').textContent).toContain('共 1 条');
  });

  test('空输入不写任何东西，也不清空（没什么可清的）', async () => {
    const frame = boot({ role: 'card' });
    frame.init();
    await drain(frame);

    click(frame, 'save');
    await drain(frame);
    expect(frame.lastOf('storage.set')).toBeUndefined();
    expect(frame.doc().getElementById('quick-status').textContent).toContain('先写一句话');
  });

  test('卡片只显示最近三条，最新在前', async () => {
    seed([
      { text: '第一条', at: 1000 },
      { text: '第二条', at: 2000 },
      { text: '第三条', at: 3000 },
      { text: '第四条', at: 4000 },
    ]);
    const frame = boot({ role: 'card' });
    frame.init();
    await drain(frame);

    const rows = [...frame.doc().querySelectorAll('#recent .recent-row')];
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('第四条');
    expect(rows[2].textContent).toContain('第二条');
  });
});

// --- serves.add ---------------------------------------------------------------

describe('plugin.call add', () => {
  test('回 {id, at, total, merged}，并且真的写进了 storage', async () => {
    const frame = boot({ role: 'background' });
    frame.init();
    await drain(frame);

    const took = call(frame, 'add', { text: '  记一下：周五交周报  ', tag: '#工作' });
    await drain(frame);

    const packet = took.take();
    expect(packet.ok).toBe(true);
    expect(typeof packet.result.id).toBe('string');
    expect(packet.result.id.length).toBeGreaterThan(0);
    expect(typeof packet.result.at).toBe('number');
    expect(packet.result.total).toBe(1);
    expect(packet.result.merged).toBe(false);

    const items = savedItems();
    expect(items).toHaveLength(1);
    // 去首尾空白；标签去掉了用户顺手打的 `#`（否则 `#工作` 和 `工作` 会变成两个标签）。
    expect(items[0]).toMatchObject({ text: '记一下：周五交周报', tag: '工作' });
  });

  test('写前现读：一次 add 里 storage.get 先于 storage.set', async () => {
    seed([{ text: '盒子里原来的一条', at: 1000 }]);
    const frame = boot({ role: 'background' });
    frame.init();
    await drain(frame);

    const from = frame.requests().length;
    const took = call(frame, 'add', { text: '新加的一条' });
    await drain(frame);

    const after = frame.requests().slice(from).map((req) => req.method);
    const readAt = after.indexOf('storage.get');
    const writeAt = after.indexOf('storage.set');
    expect(readAt, 'add 之前必须先读一次底稿（否则会覆盖掉盒子里已有的条目）').toBeGreaterThanOrEqual(0);
    expect(writeAt).toBeGreaterThan(readAt);
    // 底稿里那一条还在：这次写是"读到的 + 新的"，不是"只有新的"。
    expect(savedItems().map((item) => item.text)).toEqual(['盒子里原来的一条', '新加的一条']);
    expect(took.take().result.total).toBe(2);
  });

  test('text 为空点名「text 为空」；501 字点名 500', async () => {
    const frame = boot({ role: 'background' });
    frame.init();
    await drain(frame);

    const empty = call(frame, 'add', { text: '   ' });
    await drain(frame);
    const emptyPacket = empty.take();
    expect(emptyPacket.ok).toBe(false);
    expect(emptyPacket.error).toContain('text 为空');

    const tooLong = call(frame, 'add', { text: '字'.repeat(501) });
    await drain(frame);
    const longPacket = tooLong.take();
    expect(longPacket.ok).toBe(false);
    expect(longPacket.error).toContain('500');

    // 两次都没有落盘：拒绝发生在写之前。
    expect(store.has(KEY)).toBe(false);
  });

  test('默认标签：没给 tag 的速记用设置里的那一项', async () => {
    const config = { defaultTag: '#工作' };
    const frame = boot({ role: 'background' });
    frame.init();
    await drain(frame, { config });

    call(frame, 'add', { text: '没写标签的一句' });
    await drain(frame, { config });

    expect(savedItems()[0].tag).toBe('工作');
  });
});

// --- 重复内容合并 -------------------------------------------------------------

describe('同样的话不新增', () => {
  test('去空白 + 大小写不敏感地命中，只更新 at 并置顶，merged:true', async () => {
    seed([
      { text: '买牛奶', at: 1000 },
      { text: 'Hello World', at: 2000 },
    ]);
    const frame = boot({ role: 'background' });
    frame.init();
    await drain(frame);

    const before = Date.now();
    const took = call(frame, 'add', { text: '  HELLO WORLD  ' });
    await drain(frame);

    const packet = took.take();
    expect(packet.ok).toBe(true);
    expect(packet.result.merged).toBe(true);
    expect(packet.result.total).toBe(2); // 没有多出第三条

    const items = savedItems();
    expect(items).toHaveLength(2);
    const merged = items.find((item) => item.text === 'Hello World');
    expect(merged.at).toBeGreaterThanOrEqual(before);
    // 原文保留第一次写进来的那个写法：每次重复都改写用户的数据是个意外。
    expect(merged.text).toBe('Hello World');

    // 置顶：最近一条就是它。
    const recent = call(frame, 'recent', { limit: 1 });
    await drain(frame);
    expect(recent.take().result.items[0].text).toBe('Hello World');
  });

  test('合并时给了新标签才覆盖，没给就留着原来的', async () => {
    seed([{ text: '整理书架', tag: '家务', at: 1000 }]);
    const frame = boot({ role: 'background' });
    frame.init();
    await drain(frame);

    call(frame, 'add', { text: '整理书架' });
    await drain(frame);
    expect(savedItems()[0].tag).toBe('家务');

    call(frame, 'add', { text: '整理书架', tag: '愿望' });
    await drain(frame);
    expect(savedItems()[0].tag).toBe('愿望');
  });
});

// --- 上限淘汰 -----------------------------------------------------------------

describe('盒子满了', () => {
  test('最久没被碰过的先走，一次只淘汰到刚好不超；合并过的不该先走', async () => {
    const rows = [];
    for (let i = 0; i < 20; i += 1) rows.push({ text: `第 ${i} 条`, at: 1000 + i });
    seed(rows);
    const config = { maxItems: '20' };
    const frame = boot({ role: 'background' });
    frame.init();
    await drain(frame, { config });

    // 第 0 条是最久没被碰过的（at 最小）。
    call(frame, 'add', { text: '新的第 21 条' });
    await drain(frame, { config });
    let texts = savedItems().map((item) => item.text);
    expect(texts).toHaveLength(20); // 只淘汰一条，不是成批清空
    expect(texts).not.toContain('第 0 条');
    expect(texts).toContain('第 1 条');

    // 把第 1 条重新记一次：它被碰过了，于是队尾换成了第 2 条。
    const merged = call(frame, 'add', { text: '第 1 条' });
    await drain(frame, { config });
    expect(merged.take().result.merged).toBe(true);

    call(frame, 'add', { text: '新的第 22 条' });
    await drain(frame, { config });
    texts = savedItems().map((item) => item.text);
    expect(texts).toHaveLength(20);
    expect(texts, '刚被合并过的那条不该先走').toContain('第 1 条');
    expect(texts).not.toContain('第 2 条');
  });

  test('条数设置被夹到 20–2000（写错了不至于把盒子清空）', async () => {
    const rows = [];
    for (let i = 0; i < 25; i += 1) rows.push({ text: `第 ${i} 条`, at: 1000 + i });
    seed(rows);
    // 5 低于下限：夹到 20，于是这一条写进去只淘汰一条，而不是把盒子砍成 5 条。
    const config = { maxItems: '5' };
    const frame = boot({ role: 'background' });
    frame.init();
    await drain(frame, { config });

    call(frame, 'add', { text: '再加一条' });
    await drain(frame, { config });
    expect(savedItems()).toHaveLength(20);
  });
});

// --- serves.recent ------------------------------------------------------------

describe('plugin.call recent', () => {
  function seedMany() {
    const rows = [];
    for (let i = 0; i < 57; i += 1) rows.push({ text: `第 ${i} 条`, at: 1000 + i });
    rows.push({ text: '喝牛奶', tag: '健康', at: 5000 });
    rows.push({ text: 'Milk 到了', tag: '健康', at: 5001 });
    rows.push({ text: '买面包', tag: '家务', at: 5002 });
    seed(rows);
  }

  test('最新在前、limit 默认 10、上限 50，回包里带 total', async () => {
    seedMany();
    const frame = boot({ role: 'background' });
    frame.init();
    await drain(frame);

    const plain = call(frame, 'recent', {});
    await drain(frame);
    const byDefault = plain.take().result;
    expect(byDefault.items).toHaveLength(10);
    expect(byDefault.total).toBe(60);
    expect(byDefault.items[0].text).toBe('买面包');
    expect(Object.keys(byDefault.items[0]).sort()).toEqual(['at', 'id', 'tag', 'text']);

    const big = call(frame, 'recent', { limit: 500 });
    await drain(frame);
    expect(big.take().result.items).toHaveLength(50); // 上限就是 50
  });

  test('query 是大小写不敏感的子串；tag 精确；搜不到回空数组', async () => {
    seedMany();
    const frame = boot({ role: 'background' });
    frame.init();
    await drain(frame);

    const byQuery = call(frame, 'recent', { query: 'milk' });
    await drain(frame);
    const queryResult = byQuery.take().result;
    expect(queryResult.items.map((item) => item.text)).toEqual(['Milk 到了']);
    expect(queryResult.total).toBe(60); // total 是盒子里一共几条，不是命中几条
    expect(queryResult.matched).toBe(1);

    const byTag = call(frame, 'recent', { tag: '#健康' });
    await drain(frame);
    expect(byTag.take().result.items.map((item) => item.tag)).toEqual(['健康', '健康']);

    const nothing = call(frame, 'recent', { query: '这句话盒子里没有' });
    await drain(frame);
    const none = nothing.take();
    expect(none.ok).toBe(true);
    expect(none.result.items).toEqual([]);
    expect(none.result.total).toBe(60);
  });

  test('limit 不是数字时说清楚，而不是悄悄当成默认值', async () => {
    const frame = boot({ role: 'background' });
    frame.init();
    await drain(frame);

    const bad = call(frame, 'recent', { limit: '十条' });
    await drain(frame);
    const packet = bad.take();
    expect(packet.ok).toBe(false);
    expect(packet.error).toContain('limit');
  });

  test('未知方法回一句点名的话，而不是沉默', async () => {
    const frame = boot({ role: 'background' });
    frame.init();
    await drain(frame);

    const took = call(frame, 'clear', {});
    await drain(frame);
    const packet = took.take();
    expect(packet.ok).toBe(false);
    expect(packet.error).toContain('clear');
    expect(packet.error).toContain('add');
  });
});

// --- pet.bubble ---------------------------------------------------------------

describe('保存成功说一句（pet.bubble）', () => {
  test('设置打开后，add 成功会让桌宠说一句，文字里带条数', async () => {
    seed([{ text: '旧的一条', at: 1000 }]);
    const config = { sayOnSave: 'true' };
    const frame = boot({ role: 'background' });
    frame.init();
    await drain(frame, { config });

    const took = call(frame, 'add', { text: '新的一条' });
    await drain(frame, { config });

    const said = frame.lastOf('bubble.say');
    expect(said, '开关打开了却没有 bubble.say').toBeTruthy();
    expect(said.payload.text).toContain('2');
    expect(said.payload.text).toContain('条');
    expect(took.take().result.total).toBe(2);
  });

  test('默认关着就一句都不说', async () => {
    const frame = boot({ role: 'background' });
    frame.init();
    await drain(frame);

    call(frame, 'add', { text: '安静地记下' });
    await drain(frame);
    expect(frame.lastOf('bubble.say')).toBeUndefined();
  });
});

// --- 控制中心：完整页 ---------------------------------------------------------

describe('控制中心的完整页', () => {
  test('不请求只有桌宠才服务的方法，并把「这里说不了话」写出来', async () => {
    const config = { sayOnSave: 'true' };
    const frame = boot({ role: 'workshop' });
    frame.init();
    await drain(frame, { config });

    const input = frame.doc().getElementById('note');
    expect(input.disabled).toBe(false);
    input.value = '在控制中心记一句';
    click(frame, 'add');
    await drain(frame, { config });

    const methods = frame.requests().map((req) => req.method);
    expect(methods).not.toContain('bubble.say'); // 这个窗口没有宠物
    expect(methods).not.toContain('surface.blocks'); // 也没有浮层面
    const hint = frame.doc().getElementById('page-hint');
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain('桌宠');
    expect(savedItems()).toHaveLength(1);
    expect(frame.doc().getElementById('count').textContent).toContain('1');
  });

  test('页面能搜：大小写不敏感的子串，搜不到是空状态而不是一片空白', async () => {
    seed([
      { text: '买牛奶', at: 1000 },
      { text: 'Milk 到了', at: 2000 },
    ]);
    const frame = boot({ role: 'workshop' });
    frame.init();
    await drain(frame);

    const query = frame.doc().getElementById('query');
    query.value = 'milk';
    query.dispatchEvent(new frame.window.Event('input', { bubbles: true }));
    expect(frame.doc().querySelectorAll('#all .note-row')).toHaveLength(1);
    expect(frame.doc().getElementById('all').textContent).toContain('Milk 到了');

    query.value = '没有这几个字';
    query.dispatchEvent(new frame.window.Event('input', { bubbles: true }));
    expect(frame.doc().querySelectorAll('#all .note-row')).toHaveLength(0);
    expect(frame.doc().getElementById('all').textContent).toContain('没有含这几个字');
  });
});

// --- 宿主拒绝一切 -------------------------------------------------------------

describe('宿主拒绝一切时', () => {
  test('add / recent 都回「未获权限」，一条数据都不写', async () => {
    const frame = boot({ role: 'background' });
    frame.init();
    await drain(frame, { mode: 'deny' });

    const addTook = call(frame, 'add', { text: '写不进去的一句' });
    const recentTook = call(frame, 'recent', {});
    await drain(frame, { mode: 'deny' });

    const addPacket = addTook.take();
    expect(addPacket.ok).toBe(false);
    expect(addPacket.error).toContain('未获权限');

    const recentPacket = recentTook.take();
    expect(recentPacket.ok).toBe(false);
    expect(recentPacket.error).toContain('未获权限');

    // 读不到底稿就**不写**：一次盲写会把整盒覆盖成一条。
    expect(frame.requests().filter((req) => req.method === 'storage.set')).toHaveLength(0);
    expect(store.size).toBe(0);
    expect(frame.errors).toEqual([]);
  });

  test('界面上草稿不丢，也不是一片空白', async () => {
    const frame = boot({ role: 'card' });
    frame.init();
    await drain(frame, { mode: 'deny' });

    const input = frame.doc().getElementById('quick');
    input.value = '别弄丢我';
    click(frame, 'save');
    await drain(frame, { mode: 'deny' });

    // 草稿还在：被拒绝时用户最需要的正是"别把我这句话弄丢"。
    expect(input.value).toBe('别弄丢我');
    expect(store.size).toBe(0);
    const status = frame.doc().getElementById('quick-status').textContent;
    expect(status).toContain('未获权限');
    expect(status).toContain('还在输入框里');
    // 空间里也写清状态，而不是留一个空的列表。
    expect(frame.doc().getElementById('recent').textContent).toContain('未获权限');
    expect(frame.errors).toEqual([]);
  });
});

// --- 卡片长高 -----------------------------------------------------------------

describe('卡片长高', () => {
  test('内容比声明高时请求 surface.blocks，并且被夹在 maxH 以内', async () => {
    const frame = boot({ role: 'card' });
    // 只桩这一层的高度（jsdom 没有排版）：要断言的是"量到 620 之后报了几"，不是"看起来多高"。
    Object.defineProperty(frame.doc().getElementById('card'), 'scrollHeight', {
      configurable: true,
      get: () => 620,
    });
    frame.init();
    await drain(frame);
    await new Promise((resolve) => setTimeout(resolve, 220)); // 防抖 120ms 到期

    const asked = frame.lastOf('surface.blocks');
    expect(asked, '内容更高了却没请求长高：多出来的部分会被矩形裁掉').toBeTruthy();
    expect(asked.payload.sizes).toEqual({ 0: 152 });
  });

  test('内容没超时不打扰宿主（声明的 132 就是常态）', async () => {
    const frame = boot({ role: 'card' });
    frame.init();
    await drain(frame);
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(frame.lastOf('surface.blocks')).toBeUndefined();
  });
});
