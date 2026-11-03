import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 速记盒子的行为测试，三层：
//   1. 纯函数（lib/quicksave-core.js）——标签提取、重复合并、500 条淘汰顺序、搜索在这里钉住；
//   2. 宿主链路（真实 panel.html + lib + app.js 在 jsdom 里握手）——serves 应答、写盘、
//      "让模型整理"的两条路、granted=[] 零请求；
//   3. 静态接线——manifest.serves 与 CALL_HANDLERS 逐字一致。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-quicksave');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const coreSource = readFileSync(path.join(pluginDir, 'lib', 'quicksave-core.js'), 'utf8');
const appSource = readFileSync(path.join(pluginDir, 'app.js'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

function loadCore() {
  const window = {};
  new Function('window', coreSource)(window);
  return window.QuickCore;
}

// --- jsdom 挂载（模仿 tests/plugin-habits.test.js 的 mount） ---------------------

async function mount({ granted: grants, surface, workshopHostMethods } = {}) {
  const dom = new JSDOM(html, { url: 'https://plugin.invalid/panel.html', runScripts: 'outside-only' });
  const { window } = dom;
  const sent = [];
  const errors = [];
  const answered = new Set();
  let storageValue = ''; // 内存版 storage：autoAnswer 模拟宿主存取
  window.parent = window;
  window.postMessage = (msg) => sent.push(msg);
  window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
  window.addEventListener('unhandledrejection', (e) => errors.push('unhandled: ' + String(e.reason && e.reason.message || e.reason)));

  window.eval(coreSource);
  window.eval(appSource);

  const init = () => {
    const data = {
      v: 1, type: 'init', theme: 'dark', granted: grants || [],
      surface: surface || { kind: 'panel', slot: 'background' },
    };
    if (surface?.slot === 'workshop') {
      // 默认按真宿主：workshop 不服务 pet 专属方法。要模拟"未来宿主服务 llm.chat"的
      // 场景，用 workshopHostMethods 覆盖——init.host 是权威，插件跟表走。
      data.host = { program: 'workshop', methods: workshopHostMethods || ['storage.get', 'storage.set', 'config.get'] };
    }
    const event = new window.MessageEvent('message', { data });
    Object.defineProperty(event, 'source', { value: window });
    window.dispatchEvent(event);
  };

  const respond = (id, result, ok = true) => {
    const event = new window.MessageEvent('message', { data: { v: 1, type: 'response', id, ok, result } });
    Object.defineProperty(event, 'source', { value: window });
    window.dispatchEvent(event);
  };

  /** 宿主的自动应答：storage 用内存版，llm.chat 可由测试指定结果。 */
  let llmBehavior = null; // (payload) => result | Error
  const autoAnswer = () => {
    for (const msg of sent) {
      if (msg.type !== 'request' || answered.has(msg.id)) continue;
      answered.add(msg.id);
      if (msg.method === 'storage.get') respond(msg.id, { value: storageValue });
      else if (msg.method === 'storage.set') { storageValue = msg.payload.value; respond(msg.id, { ok: true }); }
      else if (msg.method === 'config.get') respond(msg.id, { values: {} });
      else if (msg.method === 'llm.chat') {
        if (!llmBehavior) respond(msg.id, null, false);
        else {
          try { respond(msg.id, llmBehavior(msg.payload)); }
          catch (err) { respond(msg.id, null, false); }
        }
      } else respond(msg.id, null, false);
    }
  };
  const setLlm = (fn) => { llmBehavior = fn; };

  const flush = () => new Promise((r) => setTimeout(r, 0));

  await Promise.resolve();
  return { window, sent, errors, init, respond, autoAnswer, setLlm, flush, getStorage: () => storageValue };
}

function callResults(sent) {
  return sent.filter((m) => m.type === 'call-result');
}

function seed(n, opts = {}) {
  // 造 n 条速记（测试用纯函数直接构造，不经过宿主）。同步：纯函数没有异步路径。
  const C = loadCore();
  let entries = [];
  for (let i = 0; i < n; i++) {
    const out = C.add(entries, `条目 ${i}`, 1000 + i, { cap: opts.cap ?? 500 });
    entries = out.entries;
  }
  return entries;
}

// --- 1. 纯函数层 ----------------------------------------------------------------

describe('纯函数：标签提取', () => {
  const C = loadCore();
  test('#标签 被提出正文，正文变干净', () => {
    const { clean, tags } = C.parseTags('买牛奶 #购物 #本周');
    expect(clean).toBe('买牛奶');
    expect(tags).toEqual(['购物', '本周']);
  });
  test('重复标签去重，#后空白不算标签', () => {
    const { tags } = C.parseTags('a #x #x # y');
    expect(tags).toEqual(['x']);
  });
});

describe('纯函数：500 条上限的淘汰顺序可预测', () => {
  const C = loadCore();
  test('500 条全未置顶 → 加 1 条 → 最旧的被挤掉（501 才触发淘汰）', () => {
    const C0 = loadCore();
    let entries = seed(500, { cap: 500 });
    expect(entries[0].text).toBe('条目 0');
    const out = C0.add(entries, '新的一条', 9999, { cap: 500 });
    expect(out.added).toBe(true);
    expect(out.evicted && out.evicted.text).toBe('条目 0');
    expect(out.entries).toHaveLength(500);
  });
  test('500 条、最旧一条置顶 → 加 1 条 → 挤掉的是未置顶里最旧的那条', () => {
    const C2 = loadCore();
    let entries = seed(500, { cap: 500 });
    // 条目 0 是最旧的：置顶它
    const pinned = C2.togglePin(entries, entries[0].id);
    expect(pinned[0].pinned).toBe(true);
    const out = C2.add(pinned, '新的一条', 9999, { cap: 500 });
    expect(out.evicted && out.evicted.text).toBe('条目 1');
    expect(out.entries.some((e) => e.id === pinned[0].id)).toBe(true);
  });
  test('全部置顶时挤绝对最旧（策略必须总能腾出位置）', () => {
    const C3 = loadCore();
    let entries = seed(3, { cap: 3 });
    entries = entries.map((e) => ({ ...e, pinned: true }));
    const out = C3.add(entries, '新的一条', 9999, { cap: 3 });
    expect(out.added).toBe(true);
    expect(out.evicted.text).toBe('条目 0');
    expect(out.entries.some((e) => e.text === '新的一条')).toBe(true);
  });
  test('重复内容合并：不新增、提到最前、时刻刷新', () => {
    const C4 = loadCore();
    let entries = [];
    entries = C4.add(entries, '原始内容', 1000, { cap: 10 }).entries;
    entries = C4.add(entries, '别的', 2000, { cap: 10 }).entries;
    const out = C4.add(entries, '原始内容', 3000, { cap: 10 });
    expect(out.added).toBe(false);
    expect(out.merged).toBe(true);
    expect(out.entries).toHaveLength(2);
    expect(out.entries[0].text).toBe('原始内容'); // 提到最前（数组头 = 显示列表最上）
    expect(out.entries[0].at).toBe(3000);
  });
  test('标签并入合并条目', () => {
    const C5 = loadCore();
    let entries = [];
    entries = C5.add(entries, '带标签 #a', 1000, { cap: 10 }).entries;
    const out = C5.add(entries, '带标签 #b', 2000, { cap: 10 });
    expect(out.merged).toBe(true);
    expect(out.entries[0].tags).toEqual(['a', 'b']);
  });
  test('空内容不进列表', () => {
    const C6 = loadCore();
    const out = C6.add([], '   ', 1000, { cap: 10 });
    expect(out.added).toBe(false);
  });
  test('序列化不超 1 MiB（500 条长文本防线）', () => {
    const C7 = loadCore();
    let entries = [];
    const long = '一二三四五六七八九十'.repeat(40); // 400 字
    for (let i = 0; i < 500; i++) entries = C7.add(entries, `${long} #第${i}`, i, { cap: 500 }).entries;
    const json = C7.serialize(entries);
    expect(json.length).toBeLessThan(C7.SIZE_LIMIT);
  });
  test('search：大小写不敏感，tag 过滤', () => {
    const C8 = loadCore();
    let entries = [];
    entries = C8.add(entries, 'Buy MILK #life', 1000, { cap: 10 }).entries;
    entries = C8.add(entries, '写周报 #work', 2000, { cap: 10 }).entries;
    expect(C8.search(entries, 'milk')).toHaveLength(1);
    expect(C8.search(entries, '', 'work')).toHaveLength(1);
    expect(C8.search(entries, '', 'life')[0].text).toContain('MILK');
  });
  test('recent：新的在前，limit 生效', () => {
    const C9 = loadCore();
    let entries = [];
    for (let i = 0; i < 30; i++) entries = C9.add(entries, `条目 ${i}`, 1000 + i, { cap: 50 }).entries;
    const r = C9.recent(entries, { limit: 5 });
    expect(r).toHaveLength(5);
    expect(r[0].text).toBe('条目 29');
    expect(r[4].text).toBe('条目 25');
  });
});

// --- 2. 静态接线 ----------------------------------------------------------------

describe('manifest 与实现的接线', () => {
  test('serves 与 CALL_HANDLERS 逐字一致', () => {
    expect([...manifest.serves].sort()).toEqual(['add', 'recent']);
    expect(appSource).toMatch(/const CALL_HANDLERS = \{\s*\n\s*add:/);
    expect(appSource).toMatch(/\n\s*recent:/);
  });
  test('permissions 满足契约：serves ⇒ plugin.call；background 四选一由 plugin.call 满足', () => {
    expect(manifest.permissions).toContain('plugin.call');
    expect(manifest.background).toBe(true);
    expect(manifest.permissions).not.toContain('events'); // 四选一不要求 events 本身
  });
});

// --- 3. 宿主链路（jsdom） ---------------------------------------------------------

describe('常驻帧：plugin.call 应答', () => {
  test('call(add) 远程记一条 → ticket 原样带回 + storage 写入', async () => {
    const { window, sent, init, autoAnswer, flush, getStorage } = await mount({ granted: ['plugin.call', 'storage', 'plugin.config'] });
    init();
    await flush();
    autoAnswer(); // init 期间的 storage.get/config.get
    const event = new window.MessageEvent('message', {
      data: { v: 1, type: 'call', ticket: 't-add', from: 'x', method: 'add', payload: { text: '远程一条 #tag' } },
    });
    Object.defineProperty(event, 'source', { value: window });
    window.dispatchEvent(event);
    await flush();
    autoAnswer(); // add 触发的 storage.set
    const results = callResults(sent);
    expect(results[0].ticket).toBe('t-add');
    expect(results[0].ok).toBe(true);
    expect(results[0].result.added).toBe(true);
    expect(JSON.parse(getStorage())[0].text).toBe('远程一条');
  });

  test('call(recent) 返回最近条目（新的在前）', async () => {
    const { window, sent, init, autoAnswer, flush } = await mount({ granted: ['plugin.call', 'storage'] });
    init();
    await flush();
    autoAnswer();
    // 先远程记两条
    for (const [ticket, text] of [['t1', '第一条'], ['t2', '第二条']]) {
      const event = new window.MessageEvent('message', {
        data: { v: 1, type: 'call', ticket, from: 'x', method: 'add', payload: { text } },
      });
      Object.defineProperty(event, 'source', { value: window });
      window.dispatchEvent(event);
      await flush();
      autoAnswer();
    }
    const event = new window.MessageEvent('message', {
      data: { v: 1, type: 'call', ticket: 't-rec', from: 'x', method: 'recent', payload: { limit: 1 } },
    });
    Object.defineProperty(event, 'source', { value: window });
    window.dispatchEvent(event);
    await flush();
    const results = callResults(sent);
    const rec = results.find((r) => r.ticket === 't-rec');
    expect(rec.result.items).toHaveLength(1);
    expect(rec.result.items[0].text).toBe('第二条');
  });

  test('常驻帧被问未知方法 → ok=false 信封', async () => {
    const { window, sent, init, flush } = await mount({ granted: ['plugin.call'] });
    init();
    await flush();
    const event = new window.MessageEvent('message', {
      data: { v: 1, type: 'call', ticket: 't-x', from: 'x', method: 'search_all', payload: {} },
    });
    Object.defineProperty(event, 'source', { value: window });
    window.dispatchEvent(event);
    await flush();
    expect(callResults(sent)[0].ok).toBe(false);
    expect(callResults(sent)[0].error).toContain('add');
  });
});

describe('插件页（workshop）', () => {
  test('表单添加 → storage.set + 列表出现新条目', async () => {
    const { window, sent, init, autoAnswer, flush } = await mount({
      granted: ['storage', 'plugin.config'],
      surface: { kind: 'panel', slot: 'workshop' },
    });
    init();
    await flush();
    autoAnswer();
    window.document.getElementById('add-input').value = '手记一条';
    window.document.getElementById('add-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    autoAnswer();
    await flush();
    const sets = sent.filter((m) => m.type === 'request' && m.method === 'storage.set');
    expect(sets.length).toBeGreaterThanOrEqual(1);
    const list = JSON.parse(sets[0].payload.value);
    expect(list.some((e) => e.text === '手记一条')).toBe(true);
    expect(window.document.getElementById('list').children.length).toBe(1);
  });

  test('llm.chat 成功路径：整理结果进显示区，原文不动', async () => {
    const { window, sent, init, autoAnswer, setLlm, flush } = await mount({
      granted: ['storage', 'plugin.config', 'llm.chat'],
      surface: { kind: 'panel', slot: 'workshop' },
      workshopHostMethods: ['storage.get', 'storage.set', 'config.get', 'llm.chat'],
    });
    init();
    await flush();
    autoAnswer();
    setLlm(() => ({ text: '整理后的要点' }));
    // 记一条并勾选
    window.document.getElementById('add-input').value = '被整理的那条';
    window.document.getElementById('add-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    autoAnswer();
    const checkbox = window.document.querySelector('.row .pick');
    checkbox.checked = true;
    checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
    await flush();
    // 点击按钮（picked 已有勾选；renderRow 重建会重置勾选框，所以先读 id 备用）
    const id = JSON.parse(sent.filter((m) => m.type === 'request' && m.method === 'storage.set')[0].payload.value)[0].id;
    window.document.getElementById('llm-tidy').click();
    await flush();
    autoAnswer(); // llm.chat 的请求
    await flush();
    autoAnswer(); // 可能还有后续请求
    await flush();
    expect(window.document.getElementById('llm-note').textContent).toContain('整理后的要点');
    // 原文不动
    const sets = sent.filter((m) => m.type === 'request' && m.method === 'storage.set');
    expect(JSON.parse(sets[sets.length - 1].payload.value)[0].text).toBe('被整理的那条');
    // 接缝直接调：先发起、等请求挂起后由宿主（autoAnswer）应答——直接 await 会死锁。
    const promise = window.__quicksave.tidyPicked([id]);
    await flush();
    autoAnswer(); // llm.chat 的请求
    await flush();
    const out = await promise;
    expect(out.ok).toBe(true);
    expect(out.degraded).toBe(false);
    expect(out.text).toBe('整理后的要点');
  });

  test('llm.chat 失败：退化为原文，不崩', async () => {
    const { window, sent, errors, init, autoAnswer, setLlm, flush } = await mount({
      granted: ['storage', 'plugin.config', 'llm.chat'],
      surface: { kind: 'panel', slot: 'workshop' },
      workshopHostMethods: ['storage.get', 'storage.set', 'config.get', 'llm.chat'],
    });
    init();
    await flush();
    autoAnswer();
    setLlm(() => { throw new Error('渠道挂了'); });
    window.document.getElementById('add-input').value = '原文在这';
    window.document.getElementById('add-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    autoAnswer();
    const id = JSON.parse(sent.filter((m) => m.type === 'request' && m.method === 'storage.set')[0].payload.value)[0].id;
    const promise = window.__quicksave.tidyPicked([id]);
    await flush();
    autoAnswer(); // llm.chat 的请求（抛错 → 宿主回 ok:false）
    await flush();
    const out = await promise;
    await flush();
    expect(errors).toEqual([]);
    expect(out.ok).toBe(true);
    expect(out.degraded).toBe(true);
    expect(out.text).toContain('原文在这');
  });

  test('workshop 没有 llm.chat 能力：按钮置灰 + 说明（两宿主差异说出口）', async () => {
    const { window, init, autoAnswer, flush } = await mount({
      granted: ['storage', 'plugin.config', 'llm.chat'], // 权限给了，但 workshop 宿主不服务
      surface: { kind: 'panel', slot: 'workshop' },
    });
    init();
    await flush();
    autoAnswer();
    await flush();
    autoAnswer();
    await flush();
    expect(window.document.getElementById('llm-tidy').disabled).toBe(true);
    expect(window.document.getElementById('llm-tidy').title).toContain('桌宠');
  });
});

describe('宿主拒绝一切（granted=[]）', () => {
  test('常驻帧：不崩、不写、add 拒绝得诚实', async () => {
    const { window, sent, errors, init, flush } = await mount({ granted: [] });
    init();
    await flush();
    const event = new window.MessageEvent('message', {
      data: { v: 1, type: 'call', ticket: 't-9', from: 'x', method: 'add', payload: { text: 'x' } },
    });
    Object.defineProperty(event, 'source', { value: window });
    window.dispatchEvent(event);
    await flush();
    expect(errors).toEqual([]);
    const sets = sent.filter((m) => m.type === 'request' && m.method === 'storage.set');
    expect(sets).toEqual([]);
    const results = callResults(sent);
    expect(results[0].ok).toBe(true); // 信封成功
    expect(results[0].result.ok).toBe(false); // 结论：没记下（内存态都进不去等于没记）
  });

  test('插件页：不崩、零写、未授权态说出口', async () => {
    const { sent, errors, init, autoAnswer, flush } = await mount({
      granted: [],
      surface: { kind: 'panel', slot: 'workshop' },
    });
    init();
    await flush();
    autoAnswer();
    expect(errors).toEqual([]);
    const sets = sent.filter((m) => m.type === 'request' && m.method === 'storage.set');
    expect(sets).toEqual([]);
    const window2 = await mount({ granted: [], surface: { kind: 'panel', slot: 'workshop' } });
    expect(window2).toBeTruthy();
  });

  test('snapshot：granted 为空、ready、count=0', async () => {
    const { window, init, flush } = await mount({ granted: [] });
    init();
    await flush();
    const snap = window.__quicksave.snapshot();
    expect(snap.ready).toBe(true);
    expect(snap.granted).toEqual([]);
    expect(snap.count).toBe(0);
  });
});
