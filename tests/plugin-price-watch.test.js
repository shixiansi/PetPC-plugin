import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 网页变化监控插件的行为测试：驱动 panel.html 里真实加载的那几支脚本。
//
// harness 与 imgbed / rss-reader 那几份同型：vitest 的 jsdom 全局 window 当作插件的 window，
// 拼起来的源码用 new Function 丢进一个新函数作用域（等于浏览器里那几支经典 script 共享一个
// 作用域），出站 postMessage 用 spy 记下来，再由 drain() 逐条应答。
//
// 这里钉住的六件事（对应 lib/watch.js 文件头 A–D 与题面）：
//
//   1. 首次抓取只建基线，**一条气泡都不发**；
//   2. 变化要连续两轮抓到同样的内容才报，且**只报一次**；
//   3. A→B→A→B 的横跳被去抖**全部吃掉**（0 个气泡，基线还是 A）；
//   4. **未配置时不发任何请求**（连 storage.get 都不发）；
//   5. 抓不到（网络失败 / 4xx / 选择器没命中）**不覆盖旧快照**，界面写「上次成功是 …」；
//   6. 免打扰**跨午夜**判定正确，段内**不发气泡但仍然更新快照**。
//
// 另外还钉着：改间隔立刻生效（旧计时器必须被清掉）、控制中心那一面不抓取不弹气泡、
// 宿主拒绝一切时不崩也不写数据、以及"噪声不算变化"（script/样式/缩进变了 ≠ 内容变了）。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-price-watch');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');
const source = scriptSources
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-price-watch';

/** 控制中心服务的方法（没有 bubble.say / events.subscribe）。 */
const WORKSHOP_METHODS = ['config.get', 'config.set', 'storage.get', 'storage.set', 'net.fetch', 'plugin.log'];
/** 桌宠服务的方法：比上面多一个气泡。 */
const PET_METHODS = [...WORKSHOP_METHODS, 'bubble.say'];

// --- manifest -----------------------------------------------------------------

describe('manifest', () => {
  test('asks for exactly the four permissions it uses, and mounts a headless frame', () => {
    expect([...manifest.permissions].sort()).toEqual(
      ['net.fetch', 'pet.bubble', 'plugin.config', 'storage'],
    );
    // 落点：panel + background（background 由 net.fetch 撑着，见手册 §4）。
    expect(manifest.panel).toBe(true);
    expect(manifest.background).toBe(true);
    // 没有浮层面：这个插件不占宠物旁边的位置。
    expect(manifest.surface).toBeUndefined();
    expect(manifest.sidecar).toBeUndefined();
    // 不答 plugin.call（没有 serves），也不需要 events。
    expect(manifest.serves).toBeUndefined();
    expect(manifest.permissions).not.toContain('events');
  });

  test('netHosts is a documented placeholder and the settings carry the real hosts', () => {
    // 静态清单写不出"用户想盯的站"，所以只留一个合法占位；真正的域名靠 hostWhitelist 那一项。
    expect(manifest.netHosts).toEqual(['example.com']);
    const whitelist = manifest.config.filter((item) => item.hostWhitelist === true);
    expect(whitelist).toHaveLength(1);
    expect(whitelist[0].key).toBe('entries');
    expect(readFileSync(path.join(pluginDir, 'README.md'), 'utf8')).toContain('占位');
  });

  test('config declares entries / interval / quiet hours with the agreed defaults', () => {
    const byKey = Object.fromEntries(manifest.config.map((item) => [item.key, item]));
    expect(Object.keys(byKey).sort()).toEqual(['entries', 'intervalMin', 'quietFrom', 'quietTo']);
    expect(byKey.entries.type).toBe('text');
    expect(byKey.intervalMin.type).toBe('number');
    expect(byKey.intervalMin.default).toBe('60');
    expect(byKey.quietFrom.type).toBe('text');
    expect(byKey.quietFrom.default).toBe('22:00');
    expect(byKey.quietTo.default).toBe('08:00');
    // 条目的 label 必须说清格式与那一句"这里填的域名会进白名单"。
    expect(byKey.entries.label).toContain('名字 | URL');
    expect(byKey.entries.label).toContain('白名单');
  });

  test('every file the page loads ships in the package, and ui.css is the byte-identical copy', () => {
    const fixed = ['panel.html', 'app.js', 'style.css'];
    for (const src of scriptSources) {
      if (fixed.includes(src)) continue;
      expect(manifest.assets).toContain(src);
    }
    expect(manifest.assets).toContain('ui.css');
    for (const asset of manifest.assets) {
      expect(existsSync(path.join(pluginDir, asset)), `manifest.assets 里的 ${asset} 不存在`).toBe(true);
    }
    expect(existsSync(path.join(pluginDir, manifest.entry))).toBe(true);
    expect(readFileSync(path.join(pluginDir, 'ui.css'), 'utf8')).toBe(
      readFileSync(path.join(here, '..', 'docs', 'ui', 'petpc-ui.css'), 'utf8'),
    );
    // ui.css 必须排在 style.css 之前（否则自己的布局会被 token 覆盖）。
    expect(html.indexOf('href="ui.css"')).toBeLessThan(html.indexOf('href="style.css"'));
  });
});

// --- harness ------------------------------------------------------------------

let store;
let configValues;
let fetchCalls;
let fetchQueue;
let pages;
let bubbles;
let answered;
let mode;
let windowListeners;
let timers;
let clearedTimers;
let rejections;
let clock;

function posted() {
  return window.postMessage.mock.calls.map((call) => call[0]);
}

function byType(type) {
  return posted().filter((m) => m && m.type === type);
}

function requests() {
  return byType('request').map((m) => ({ id: m.id, method: m.method, payload: m.payload }));
}

function methodsCalled() {
  return requests().map((r) => r.method);
}

function hostSends(data) {
  window.dispatchEvent(new MessageEvent('message', { data, source: window }));
}

function answer(id, result, { ok = true, error = '' } = {}) {
  answered.add(id);
  hostSends({ v: 1, type: 'response', id, ok, result, error });
}

/** 快照们（键以 snap/ 开头的那些），解析后的对象数组。 */
function snapshots() {
  return [...store.entries()]
    .filter(([key]) => key.startsWith('snap/'))
    .map(([, value]) => JSON.parse(value));
}

function onlySnapshot() {
  const list = snapshots();
  expect(list, '应当正好有一条监控的快照').toHaveLength(1);
  return list[0];
}

/** 一轮应答：把还没答的请求答掉，再让出一拍（promise 链在下一拍产生新请求）。 */
async function drain(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    for (const req of requests().filter((r) => !answered.has(r.id))) {
      answerOne(req);
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * 把一条"会中途发请求"的 promise 跑完。
 *
 * 不能直接 await 它：插件的每一支能力调用都要**先**被这里应答才会往下走，而应答发生在 drain
 * 里——先 await 就是一个谁也等谁的死锁。
 */
async function settle(promise) {
  let state = 'pending';
  const wrapped = Promise.resolve(promise).then(
    (value) => { state = 'ok'; return value; },
    (err) => { state = 'err'; return { error: err }; },
  );
  for (let i = 0; i < 24 && state === 'pending'; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await drain(3);
  }
  const out = await wrapped;
  if (state === 'err') throw out.error;
  return out;
}

const api = () => window.__priceWatch;
const cycle = () => settle(api().runCycle());
const renderPage = () => settle(api().renderWorkshop());
const reschedule = () => settle(api().reloadAndReschedule());

function answerOne(req) {
  const payload = req.payload || {};
  if (mode === 'deny') {
    // 逐方法给一句像真宿主的中文（手册 §5.3 第 5 条：原文要显示出来，别包成"操作失败"）。
    const perm = {
      'config.get': 'plugin.config',
      'storage.get': 'storage',
      'storage.set': 'storage',
      'storage.remove': 'storage',
      'net.fetch': 'net.fetch',
      'bubble.say': 'pet.bubble',
    }[req.method] || 'storage';
    answer(req.id, null, { ok: false, error: `模拟拒绝：未获权限 ${perm}` });
    return;
  }
  switch (req.method) {
    case 'config.get':
      answer(req.id, { values: { ...configValues }, secrets: {} });
      break;
    case 'storage.get':
      answer(req.id, { value: store.has(String(payload.key)) ? store.get(String(payload.key)) : '' });
      break;
    case 'storage.set':
      store.set(String(payload.key), String(payload.value === undefined ? '' : payload.value));
      answer(req.id, { ok: true });
      break;
    case 'storage.remove':
      store.delete(String(payload.key));
      answer(req.id, { ok: true });
      break;
    case 'net.fetch':
      fetchCalls.push(payload);
      answerNetFetch(req.id, payload);
      break;
    case 'bubble.say':
      bubbles.push(String(payload.text || ''));
      answer(req.id, { ok: true });
      break;
    default:
      answer(req.id, null, { ok: false, error: `本程序不支持该方法 ${req.method}` });
  }
}

function answerNetFetch(id, payload) {
  let reply = fetchQueue.length ? fetchQueue.shift() : null;
  if (!reply) {
    const page = pages.get(String(payload.url));
    reply = { status: 200, body: page === undefined ? '<html><body>没有为这个地址准备页面</body></html>' : page };
  }
  if (reply.fail) {
    answer(id, null, { ok: false, error: reply.fail });
    return;
  }
  const result = { status: reply.status, body: reply.body === undefined ? '' : reply.body };
  if (reply.truncated) result.truncated = true;
  answer(id, result);
}

/** 装一份帧。`slot` 决定它是插件页（workshop）还是桌宠那边的常驻帧（background）。 */
async function boot({ slot = 'background', granted = manifest.permissions } = {}) {
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
  loadApp();
  hostSends({
    v: 1,
    type: 'init',
    pluginId: PLUGIN_ID,
    permissions: manifest.permissions,
    granted: [...granted],
    surface: { kind: 'panel', slot },
    host: {
      program: slot === 'workshop' ? 'workshop' : 'pet',
      methods: slot === 'workshop' ? [...WORKSHOP_METHODS] : [...PET_METHODS],
    },
  });
  await drain(10);
}

function loadApp() {
  answered = new Set();
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  for (const entry of timers) clearTimeout(entry.id);
  timers = [];
  clearedTimers = [];
  bubbles = [];
  fetchCalls = [];
  window.postMessage.mockClear();
  // eslint-disable-next-line no-new-func
  new Function(source)();
}

/** 一段页面（真正会被抓到的 HTML）。 */
function page(priceText, extra = '') {
  return `<!doctype html><html><head><title>商品</title>
  <style>.p { color: red }</style>
  <script>window.__AB = "${Math.random()}"; track("bucket-9f3");</script>
  <!-- rendered at 2026-11-03T12:00:03Z -->
  </head><body>
    <div class="noise">广告位 ${Math.random().toString(36).slice(2)}</div>
    <div class="price">${priceText}</div>
    ${extra}
  </body></html>`;
}

/** 一个带选择器的条目（只看 .price 那一块）。 */
const PRICE_URL = 'https://shop.example.com/item/1';

function configured(overrides = {}) {
  configValues = {
    entries: `显卡 | ${PRICE_URL} | .price`,
    intervalMin: '60',
    quietFrom: '22:00',
    quietTo: '08:00',
    ...overrides,
  };
}

function pageAt(priceText) {
  pages.set(PRICE_URL, page(priceText));
}

function localClock(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(clock);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

beforeEach(() => {
  store = new Map();
  pages = new Map();
  fetchQueue = [];
  fetchCalls = [];
  bubbles = [];
  answered = new Set();
  mode = 'ok';
  pages.set(PRICE_URL, page('¥3,999'));
  configured();
  windowListeners = [];
  timers = [];
  clearedTimers = [];
  rejections = [];
  clock = new Date('2026-11-03T10:00:00').getTime();

  vi.spyOn(Date, 'now').mockImplementation(() => clock);

  const originalAdd = window.addEventListener.bind(window);
  // 这两条**绕过**下面的 spy：它们是测试自己的探针，不该被当成"插件注册的监听器"清掉。
  originalAdd('error', (event) => rejections.push(String((event && event.message) || 'error')));
  originalAdd('unhandledrejection', (event) => rejections.push(`unhandled: ${String(event && event.reason)}`));
  vi.spyOn(window, 'addEventListener').mockImplementation(function (type, fn, opts) {
    windowListeners.push([type, fn, opts]);
    return originalAdd(type, fn, opts);
  });
  const originalTimeout = window.setTimeout.bind(window);
  // 只记账，不拦：vitest 自己的"测试超时"也走 setTimeout，把整套语义换掉会让挂住的用例
  // 永远不超时（表现是整份测试无输出地停在那里）。所以 defer 一次原始实现，其余原样放行。
  vi.spyOn(window, 'setTimeout').mockImplementation((fn, ms, ...rest) => {
    const id = originalTimeout(fn, ms, ...rest);
    timers.push({ id, ms: Number(ms) || 0 });
    return id;
  });
  const originalClear = window.clearTimeout.bind(window);
  vi.spyOn(window, 'clearTimeout').mockImplementation((id) => {
    clearedTimers.push(id);
    return originalClear(id);
  });
  vi.spyOn(window, 'postMessage').mockImplementation(() => {});
});

afterEach(() => {
  for (const entry of timers) clearTimeout(entry.id);
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  vi.restoreAllMocks();
});

// --- 内容指纹与"噪声不算变化" ---------------------------------------------------

describe('content fingerprint', () => {
  test('is stable, 16 hex chars, order-sensitive, and different for different content', async () => {
    await boot();
    const { hashText } = api();
    const one = hashText('¥3,999 有货');
    expect(one).toMatch(/^[0-9a-f]{16}$/);
    expect(hashText('¥3,999 有货')).toBe(one);
    expect(hashText('¥3,999 缺货')).not.toBe(one);
    // 顺序变了就是变了（位置进第二条链，见 lib/hash.js）。
    expect(hashText('3.50 库存 2')).not.toBe(hashText('2 库存 3.50'));
  });

  test('script / style / comment / whitespace noise is not a change', async () => {
    await boot();
    pageAt('¥3,999');
    await cycle();
    const baseline = onlySnapshot().hash;

    // 同一段价格，但脚本、注释、缩进、随机广告 token 全变了——真实页面每刷新一次都这样。
    pages.set(PRICE_URL, `<!doctype html><html><head>
      <style>.p{color:blue}</style>
      <script>window.__AB = "another-${Date.now()}";</script>
      <!-- rendered at ${new Date().toISOString()} -->
      </head><body>
        <div class="noise">广告位 ${Math.random()}</div>
        <div class="price">   ¥3,999   </div>
      </body></html>`);
    await cycle();

    expect(fetchCalls).toHaveLength(2);
    expect(onlySnapshot().hash).toBe(baseline);
    expect(bubbles).toEqual([]);

    // 不写选择器时（整页正文）同样只丢噪声、不丢内容。
    const { extractContent } = api();
    const a = extractContent('<html><body>\n\n  <p>¥3,999</p>\n <script>x=1</script><style>.a{}</style></body></html>', '');
    const b = extractContent('<html><body><p>¥3,999</p><script>y=2</script><!-- note --></body></html>', '');
    expect(a.text).toBe('¥3,999');
    expect(a.text).toBe(b.text);
  });

  test('a selector narrows the hash to that block, and a miss is a failed round', async () => {
    await boot();
    const { extractContent } = api();
    const doc = page('¥3,999', '<div class="stock">只剩 2 件</div>');
    const narrow = extractContent(doc, '.price');
    expect(narrow.ok).toBe(true);
    expect(narrow.text).toBe('¥3,999');
    // 整页正文里两块都在。
    const whole = extractContent(doc, '');
    expect(whole.text).toContain('¥3,999');
    expect(whole.text).toContain('只剩 2 件');
    // 只有库存动了：只看 .price 的那一条不该算变化。
    const moved = extractContent(page('¥3,999', '<div class="stock">只剩 1 件</div>'), '.price');
    expect(moved.text).toBe(narrow.text);

    expect(extractContent(doc, '.不存在的块').ok).toBe(false);
    expect(extractContent(doc, '.没有这个').reason).toContain('没有命中');
    expect(extractContent(doc, '::bad(').ok).toBe(false);
    expect(extractContent('', '.price').ok).toBe(false);
  });

  test('entry lines: three segments, empty selector, comments, and the eight-line cap', async () => {
    await boot();
    const { parseEntries } = api();
    const list = parseEntries([
      '# 这一行是注释',
      `显卡 | ${PRICE_URL} | .price`,
      '公告 | https://example.com/notice',
      '坏的 | ftp://example.com/x',
      '没地址 |',
      '价格|https://a.example.com/1|.p',
    ].join('\n'));
    expect(list).toHaveLength(5); // 注释行不算
    expect(list[0]).toMatchObject({ name: '显卡', url: PRICE_URL, selector: '.price', problem: '' });
    expect(list[0].id).toMatch(/^[0-9a-f]{16}$/);
    // 名字可空 → 用域名；选择器可空 → 整页。
    expect(list[1]).toMatchObject({ name: '公告', url: 'https://example.com/notice', selector: '', problem: '' });
    expect(list[2].problem).toContain('http/https');
    expect(list[3].problem).toContain('URL');
    // 换一个选择器就是另一条监控（id 不同），所以"缩到更小的块"不会继承旧的基线。
    expect(list[4].id).not.toBe(list[0].id);

    const many = parseEntries(Array.from({ length: 10 }, (_, i) => `n${i} | https://example.com/${i}`).join('\n'));
    expect(many.filter((e) => !e.problem)).toHaveLength(8);
    expect(many[9].problem).toContain('8');
  });
});

// --- 主路径：首次抓取、变化只报一次、横跳被吃掉 ---------------------------------

describe('抓取与播报', () => {
  test('the first capture only stores a baseline and says nothing', async () => {
    await boot();
    expect(methodsCalled()).toContain('config.get');

    pageAt('¥3,999');
    const out = await cycle();

    expect(out.ok).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].method).toBe('GET');
    expect(fetchCalls[0].url).toBe(PRICE_URL);
    expect(fetchCalls[0].headers.accept).toContain('text/html');

    const snap = onlySnapshot();
    expect(snap.ok).toBe(true);
    expect(snap.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(snap.excerpt).toBe('¥3,999');
    expect(snap.lastOkAt).toBe(clock);
    // 首次抓取：一条气泡都不发。
    expect(bubbles).toEqual([]);
    // 也没有历史（没有"变化"这回事）。
    expect(store.has('hist/changes')).toBe(false);
  });

  test('a change is announced once, after two consecutive captures agree', async () => {
    await boot();
    pageAt('¥3,999');
    await cycle();

    // 第一轮看到新价格：只记候选，不打扰。
    pageAt('¥3,499');
    await cycle();
    expect(bubbles).toEqual([]);
    expect(onlySnapshot().pending).toMatchObject({ count: 1 });

    // 第二轮还是它 → 确认，说一句。
    await cycle();
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toContain('显卡');
    expect(bubbles[0]).toContain('¥3,499');
    expect(onlySnapshot().hash).toMatch(/^[0-9a-f]{16}$/);
    expect(onlySnapshot().pending).toBe(null);

    // 之后还是同一份内容：基线已经更新，所以不再算变化、不再说。
    await cycle();
    await cycle();
    expect(bubbles).toHaveLength(1);
  });

  test('a flapping page (A→B→A→B) produces no bubble at all and keeps the A baseline', async () => {
    await boot();
    pageAt('¥3,999');
    await cycle();
    const baseline = onlySnapshot().hash;

    for (const price of ['¥3,499', '¥3,999', '¥3,499']) {
      pageAt(price);
      await cycle();
    }
    // 每一次"新内容"都被下一次抓到的东西否掉：0 个气泡，基线还是 A。
    expect(bubbles).toEqual([]);
    expect(onlySnapshot().hash).toBe(baseline);
  });

  test('the change history records which part changed', async () => {
    await boot();
    pageAt('¥3,999 现货');
    await cycle();
    pageAt('¥3,499 现货');
    await cycle();
    await cycle();

    const history = JSON.parse(store.get('hist/changes'));
    expect(history).toHaveLength(1);
    expect(history[0].name).toBe('显卡');
    expect(history[0].url).toBe(PRICE_URL);
    expect(history[0].quiet).toBe(false);
    expect(history[0].before).toContain('3,999');
    expect(history[0].after).toContain('3,499');
    // "哪一段变了"：公共前缀之后的这一小段。
    expect(history[0].snippet).toContain('3,499');
    expect(history[0].snippet.length).toBeLessThanOrEqual(60);
  });

  test('with nothing configured, not a single request goes out', async () => {
    configured({ entries: '' });
    pages.set(PRICE_URL, page('¥3,999'));
    await boot();
    const out = await cycle();

    expect(out.skipped).toContain('还没有配置');
    expect(fetchCalls).toEqual([]);
    expect(store.size).toBe(0);
    // 常驻帧也不该为"没有条目"排一个每 15 分钟撞一次的计时器。
    expect(timers.filter((t) => t.ms >= 1000)).toEqual([]);
    // 一次都没读过快照（没有条目就没有要读写的东西）。
    expect(methodsCalled()).not.toContain('storage.get');
  });

  test('lines that cannot be parsed are shown as 未配置 and never fetched', async () => {
    configured({ entries: '坏行\n公告 | ftp://example.com/x' });
    await boot();
    await cycle();
    expect(fetchCalls).toEqual([]);

    await renderPage();
    const box = document.getElementById('entries');
    expect(box.textContent).toContain('未配置');
    expect(box.textContent).toContain('URL');
    expect(box.textContent).toContain('http/https');
  });
});

// --- 抓不到：不报警、不覆盖旧快照 -----------------------------------------------

describe('抓取失败', () => {
  test('HTTP 500 keeps the old snapshot and reports how long ago success was', async () => {
    await boot();
    pageAt('¥3,999');
    await cycle();
    const good = onlySnapshot();

    clock += 23 * 60 * 1000; // 23 分钟之后
    fetchQueue.push({ status: 500, body: 'boom' });
    await cycle();

    const after = onlySnapshot();
    expect(after.hash).toBe(good.hash);
    expect(after.excerpt).toBe(good.excerpt);
    expect(after.ok).toBe(false);
    expect(after.error).toContain('500');
    expect(after.lastOkAt).toBe(good.lastOkAt); // 上次成功的时间不动
    expect(bubbles).toEqual([]);

    // 页面说得出"上次成功是 23 分钟前"。
    await renderPage();
    const box = document.getElementById('entries');
    expect(box.textContent).toContain('失败');
    expect(box.textContent).toContain('上次成功是 23 分钟前');
    expect(box.textContent).toContain('500');
  });

  test('a network failure keeps the old snapshot too', async () => {
    await boot();
    pageAt('¥3,999');
    await cycle();
    const good = onlySnapshot();

    fetchQueue.push({ fail: '连不上 shop.example.com（网络错误）' });
    await cycle();

    const after = onlySnapshot();
    expect(after.hash).toBe(good.hash);
    expect(after.ok).toBe(false);
    expect(after.error).toContain('连不上');
    expect(bubbles).toEqual([]);
  });

  test('a selector that stops matching does not blank the baseline', async () => {
    await boot();
    pageAt('¥3,999');
    await cycle();
    const good = onlySnapshot();

    // 页面改版：.price 改名叫 .price-new。
    pages.set(PRICE_URL, '<html><body><div class="price-new">¥2,999</div></body></html>');
    await cycle();
    expect(onlySnapshot().hash).toBe(good.hash);
    expect(onlySnapshot().error).toContain('没有命中');

    // 而且它**没有**把"从空变成内容"当成一次变化：改回来时内容没变 → 不报。
    pageAt('¥3,999');
    await cycle();
    await cycle();
    expect(bubbles).toEqual([]);
  });

  test('the first round may fail without inventing a baseline', async () => {
    await boot();
    fetchQueue.push({ status: 404, body: 'not found' });
    await cycle();

    const snap = onlySnapshot();
    expect(snap.hash).toBe('');
    expect(snap.ok).toBe(false);
    expect(snap.error).toContain('404');
    expect(bubbles).toEqual([]);

    await renderPage();
    expect(document.getElementById('entries').textContent).toContain('还没有成功过');
  });
});

// --- 免打扰 -------------------------------------------------------------------

describe('免打扰时段', () => {
  test('crosses midnight correctly (22:00 → 08:00)', async () => {
    await boot();
    const { isQuietAt } = api();
    const at = (hhmm) => localClock(hhmm);
    expect(isQuietAt(at('23:30'))).toBe(true);
    expect(isQuietAt(at('07:59'))).toBe(true);
    expect(isQuietAt(at('08:00'))).toBe(false);
    expect(isQuietAt(at('12:00'))).toBe(false);
    expect(isQuietAt(at('21:59'))).toBe(false);
    expect(isQuietAt(at('22:00'))).toBe(true);

    // 白天的窗口（12:00 → 14:00）是普通区间，不跨午夜（测试时钟停在 10:00，所以此刻不在段内）。
    configValues.quietFrom = '12:00';
    configValues.quietTo = '14:00';
    const out = await cycle();
    expect(out.quiet).toBe(false);
    expect(isQuietAt(at('12:30'))).toBe(true);
    expect(isQuietAt(at('15:00'))).toBe(false);
  });

  test('inside the quiet window the snapshot still updates, but nothing is said', async () => {
    clock = localClock('23:30');
    await boot();
    pageAt('¥3,999');
    await cycle();
    const baseline = onlySnapshot().hash;

    pageAt('¥3,499');
    await cycle();
    await cycle();

    // 快照更新了（否则第二天早上会攒一堆"变化"一次性炸出来）……
    const snap = onlySnapshot();
    expect(snap.ok).toBe(true);
    expect(snap.hash).not.toBe(baseline);
    // ……但一句话都没说。
    expect(bubbles).toEqual([]);

    // 历史里记着它是"免打扰时段发生的"，界面上看得见。
    const history = JSON.parse(store.get('hist/changes'));
    expect(history[0].quiet).toBe(true);
  });

  test('the same content after the quiet window ends is not a new change', async () => {
    clock = localClock('23:30');
    await boot();
    pageAt('¥3,999');
    await cycle();
    pageAt('¥3,499');
    await cycle();
    await cycle();
    expect(bubbles).toEqual([]);

    // 第二天早上：抓到的还是那一份内容 → 不报（这正是"更新快照"换来的）。
    clock = localClock('09:00');
    await cycle();
    await cycle();
    expect(bubbles).toEqual([]);
  });

  test('outside the quiet window the same change does bubble', async () => {
    clock = localClock('10:00');
    await boot();
    pageAt('¥3,999');
    await cycle();
    pageAt('¥3,499');
    await cycle();
    await cycle();
    expect(bubbles).toHaveLength(1);
  });
});

// --- 间隔 ---------------------------------------------------------------------

describe('抓取间隔', () => {
  test('is clamped to a 15 minute floor and to one day at the top', async () => {
    configured({ intervalMin: '1' });
    await boot();
    expect(api().intervalMs()).toBe(15 * 60000);

    configValues.intervalMin = '9999';
    await cycle();
    expect(api().intervalMs()).toBe(24 * 60 * 60000);

    configValues.intervalMin = '60';
    await cycle();
    expect(api().intervalMs()).toBe(60 * 60000);
  });

  test('the headless frame schedules the first round and then the configured interval', async () => {
    await boot();
    const scheduled = timers.filter((t) => t.ms >= 1000);
    expect(scheduled).toHaveLength(1);
    // 第一轮是"启动后 20 秒"，不是 0：桌宠启动时不该同时发 8 个请求。
    expect(scheduled[0].ms).toBe(20000);

    configured({ intervalMin: '15' });
    const out = await reschedule();
    expect(out.ok).toBe(true);
    // 旧计时器必须被清掉——留着它就会按旧间隔再抓一次，而用户以为改动没生效。
    expect(clearedTimers).toContain(scheduled[0].id);
    const fresh = timers.filter((t) => t.ms >= 1000).slice(-1)[0];
    expect(fresh.ms).toBe(15 * 60000);
  });

  test('the settings beacon from the workshop page reschedules the headless frame', async () => {
    await boot();
    const first = timers.filter((t) => t.ms >= 1000)[0];
    expect(first).toBeTruthy();

    configured({ intervalMin: '15' });
    // 插件页保存设置之后写的那一条（storage.changed 是 storage 权限自带的推送）。
    hostSends({ v: 1, type: 'event', name: 'storage.changed', payload: { key: 'cmd/reload', at: clock } });
    await drain(10);

    expect(clearedTimers).toContain(first.id);
    expect(timers.filter((t) => t.ms >= 1000).slice(-1)[0].ms).toBe(15 * 60000);

    // 与计时器无关的键不该触发重排。
    clearedTimers.length = 0;
    hostSends({ v: 1, type: 'event', name: 'storage.changed', payload: { key: 'snap/0123456789abcdef' } });
    await drain(6);
    expect(clearedTimers).toEqual([]);
  });
});

// --- 控制中心那一面 -----------------------------------------------------------

describe('插件页（workshop）', () => {
  async function renderWithFixture() {
    const list = api().parseEntries(`显卡 | ${PRICE_URL} | .price`);
    const id = list[0].id;
    store.set(`snap/${id}`, JSON.stringify({
      id, name: '显卡', url: PRICE_URL, selector: '.price',
      hash: 'aaaaaaaaaaaaaaaa', excerpt: '¥3,999 现货',
      at: clock, ok: true, error: '', lastOkAt: clock - 3600000,
    }));
    store.set('hist/changes', JSON.stringify([
      { at: clock - 60000, name: '显卡', url: PRICE_URL, before: '¥3,999', after: '¥3,499', snippet: '¥3,499 现货', quiet: false },
    ]));
    configValues.entries = `显卡 | ${PRICE_URL} | .price\n公告 | https://example.com/notice\n坏行`;
    await renderPage();
    return document.getElementById('entries');
  }

  test('shows every entry: name, last fetch time, status, and the change history', async () => {
    await boot({ slot: 'workshop' });
    const box = await renderWithFixture();

    expect(box.textContent).toContain('显卡');
    expect(box.textContent).toContain('正常');
    expect(box.textContent).toContain('上次抓取');
    expect(box.textContent).toContain('.price');
    expect(box.textContent).toContain('¥3,999');
    // 第二条还没抓过，第三条读不出来。
    expect(box.textContent).toContain('还没抓过');
    expect(box.textContent).toContain('未配置');

    const changes = document.getElementById('changes').textContent;
    expect(changes).toContain('显卡');
    expect(changes).toContain('¥3,499');

    expect(document.getElementById('chip-count').textContent).toContain('2');
    expect(document.getElementById('chip-interval').textContent).toContain('60');
    expect(document.getElementById('chip-quiet').textContent).toContain('22:00');
  });

  test('the workshop page neither fetches nor bubbles', async () => {
    await boot({ slot: 'workshop' });
    await renderWithFixture();

    // 它只读设置与快照：一个 net.fetch、一个 bubble.say 都没有。
    expect(methodsCalled()).not.toContain('net.fetch');
    expect(methodsCalled()).not.toContain('bubble.say');
    expect(bubbles).toEqual([]);
    // 也没有排抓取的计时器（只有那条 15 秒兜底重绘）。
    expect(timers.filter((t) => t.ms >= 60000)).toEqual([]);
  });

  test('a settings change in the workshop page beacons the pet side', async () => {
    await boot({ slot: 'workshop' });
    await renderWithFixture();
    store.clear();

    hostSends({ v: 1, type: 'event', name: 'config.changed', payload: { pluginId: PLUGIN_ID } });
    await drain(12);

    expect(store.has('cmd/reload')).toBe(true);
    // 并且重画了一屏（读设置 + 读快照）。
    expect(methodsCalled().filter((m) => m === 'config.get').length).toBeGreaterThan(1);
  });
});

// --- 宿主拒绝一切 -------------------------------------------------------------

describe('宿主拒绝一切', () => {
  test('the headless frame does not crash, writes nothing, and says why', async () => {
    mode = 'deny';
    await boot();

    const out = await cycle();
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/未获权限/);
    expect(bubbles).toEqual([]);
    // 一条数据都没写（连"失败记录"都没有：拒绝的是能力，不是这一条抓不到）。
    expect(store.size).toBe(0);
    expect(methodsCalled()).not.toContain('storage.set');
    expect(methodsCalled()).not.toContain('net.fetch');
    expect(rejections).toEqual([]);
    expect(document.getElementById('status').textContent).toMatch(/未获权限/);
  });

  test('the workshop page shows the host sentence and does not throw', async () => {
    mode = 'deny';
    await boot({ slot: 'workshop' });
    await renderPage();

    const status = document.getElementById('status').textContent;
    expect(status).toMatch(/未获权限|读不到/);
    expect(store.size).toBe(0);
    expect(rejections).toEqual([]);
  });

  test('without the bubble permission it still tracks content but stays quiet', async () => {
    await boot({ granted: ['net.fetch', 'storage', 'plugin.config'] });
    pageAt('¥3,999');
    await cycle();
    pageAt('¥3,499');
    await cycle();
    await cycle();

    // 快照照更（用户没给气泡权限，但监控本身还在跑）……
    expect(onlySnapshot().excerpt).toBe('¥3,499');
    // ……而且一次 bubble.say 都不发（发出去必被拒，那就是一行白写的 WARN）。
    expect(methodsCalled()).not.toContain('bubble.say');
  });

  test('granted=[] sends nothing at all from the headless frame', async () => {
    await boot({ granted: [] });
    await cycle().catch(() => {});
    await drain(8);
    expect(requests()).toEqual([]);
    expect(timers.filter((t) => t.ms >= 1000)).toEqual([]);
  });
});
