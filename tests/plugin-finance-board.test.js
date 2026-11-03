import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 行情看板的行为测试：驱动的是 panel.html 里真实加载的那几支脚本。
//
// harness 与 anniversary / imgbed 那几份同型：vitest 的 jsdom 全局 window 当作插件的 window，
// 拼起来的源码用 new Function 丢进一个新函数作用域（等于浏览器里那几支经典 script 共享一个
// 作用域），出站 postMessage 用 spy 记下来，宿主的应答由 drain 循环发。
//
// 这个文件钉住的几件事（每一条都对应一次会静默出错的地方）：
//
//   1. manifest 的形状：四项权限、一块 300×150 的浮层面、三个 netHosts、四条设置（label 都
//      ≤64 字符——宿主会拒超长的），页面引的每个文件都在 assets 里；
//   2. 三个源的响应**字段名各不相同**（meta.regularMarketPrice / 字符串 price / 嵌套 usd），
//      归一化之后是同一个 {symbol, price, change, points}；
//   3. 行情源可切换：换源之后请求的**域名与路径都变了**（断言 net.fetch 的 url）；
//   4. 周末（周六）的 Yahoo 标的**一个 net.fetch 都不发**，表格写「休市」并保留上一次的收盘价；
//      加密是 7×24，同一天照常刷；
//   5. 失败不清空：status ≥ 400、请求被拒、429 —— 价格留在原地，界面写「上次成功是 X 前」，
//      429 另外写「被限流」，快照不被空数据覆盖；
//   6. sparkline 是真的 SVG（<svg> + <polyline>），**点数与数据点数一致**；
//   7. 宿主拒绝一切时：不崩、不写数据、价格显示「—」而不是 0。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-finance-board');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');
const source = scriptSources.map((src) => readFileSync(path.join(pluginDir, src), 'utf8')).join('\n');
// 纯函数那一层（lib/*.js）单独加载一次：解析与画线要能直接喂数据，不必绕一圈 DOM。
const libSource = scriptSources
  .filter((src) => src !== 'app.js')
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-finance-board';
const SNAPSHOT_KEY = 'market/snapshot';
const VIEW_KEY = 'market/view';

// 两个宿主的能力表（手册 §9 那张表的子集）。workshop 里没有 surface.* / pet.badge /
// bubble.say / events.subscribe —— 这一份就是"发出去会不会被拒"的答案。
const PET_METHODS = [
  'config.get',
  'config.set',
  'net.fetch',
  'storage.get',
  'storage.set',
  'surface.blocks',
  'surface.hide',
  'surface.show',
];
const WORKSHOP_METHODS = ['config.get', 'config.set', 'net.fetch', 'storage.get', 'storage.set'];

// --- 假宿主喂进来的三段真实形状的 JSON ------------------------------------------
//
// 抄的是三个接口**真正**的响应骨架，不是"归一化之后的形状"。三个源的报价字段名没有一个相同：
// Yahoo 在 meta.regularMarketPrice（数字），币安在 price（**字符串**），CoinGecko 在
// [coinId].usd（嵌套）。

const YAHOO_AAPL = {
  chart: {
    result: [
      {
        meta: {
          currency: 'USD',
          symbol: 'AAPL',
          exchangeName: 'NMS',
          regularMarketPrice: 189.32,
          chartPreviousClose: 187.01,
          previousClose: 187.01,
        },
        timestamp: [1730000000, 1730086400, 1730172800, 1730259200, 1730345600],
        indicators: {
          quote: [
            {
              open: [185.1, 186.2, null, 187.6, 188.9],
              high: [186.4, 187.1, null, 188.4, 190.1],
              low: [184.8, 185.9, null, 187.2, 188.5],
              // 中间那个 null 是停牌/没成交：留着会让 sparkline 掉到 0，看起来像一次暴跌。
              close: [185.62, 186.71, null, 187.95, 189.32],
              volume: [51000000, 48200000, null, 55300000, 60100000],
            },
          ],
        },
      },
    ],
    error: null,
  },
};

const BINANCE_TICKER = { symbol: 'BTCUSDT', price: '68123.45000000' };

const BINANCE_KLINES = [
  [1730000000000, '67000.10000000', '68200.00000000', '66900.00000000', '68000.50000000', '1234.5', 1730086399999, '84000000', 50000, '600.1', '41000000', '0'],
  [1730086400000, '68000.50000000', '68100.00000000', '67300.00000000', '67450.00000000', '998.2', 1730172799999, '67000000', 42000, '500.2', '33000000', '0'],
  [1730172800000, '67450.00000000', '68050.00000000', '67200.00000000', '67980.25000000', '1100.7', 1730259199999, '74000000', 45000, '540.7', '36000000', '0'],
  [1730259200000, '67980.25000000', '68400.00000000', '67800.00000000', '68310.75000000', '1305.4', 1730345599999, '89000000', 51000, '620.4', '43000000', '0'],
  [1730345600000, '68310.75000000', '68350.00000000', '67900.00000000', '68123.45000000', '1010.9', 1730431999999, '69000000', 47000, '560.9', '38000000', '0'],
];

const COINGECKO_BTC = { bitcoin: { usd: 68123 } };

// 归一化之后，每一项都必须是这四个键、四种类型——这正是"三个源同一个形状"的意思。
const QUOTE_KEYS = ['change', 'points', 'price', 'symbol'];

// --- 纯函数那一层 ----------------------------------------------------------------

function loadLibs() {
  // eslint-disable-next-line no-new-func
  return new Function(
    `${libSource}
     return {
       parseTargets, coingeckoIdFor, sourceLabel, isSourceId,
       yahooUrl, binanceTickerUrl, binanceKlinesUrl, coingeckoUrl,
       parseYahoo, parseBinanceTicker, parseBinanceKlines, binanceQuote, parseCoingecko,
       closedReason, percentBetween, CLOSED_TEXT,
       sparkPoints, sparkSvg,
       fmtPrice, fmtChange, agoText, changeSide,
     };`,
  )();
}

const lib = loadLibs();

/** 时钟：用例要能站在周六。周六/工作日都从"今天"推出来，不写死日期。 */
function weekendAt(hour = 10) {
  const day = new Date();
  day.setHours(hour, 0, 0, 0);
  while (day.getDay() !== 6) day.setDate(day.getDate() + 1);
  return day.getTime();
}

function weekdayAt(hour = 10) {
  const day = new Date();
  day.setHours(hour, 0, 0, 0);
  while (day.getDay() === 0 || day.getDay() === 6) day.setDate(day.getDate() + 1);
  return day.getTime();
}

function snapshotJSON(at, items, source = 'yahoo') {
  return JSON.stringify({ at, source, items });
}

// --- harness -------------------------------------------------------------------

let store;
let configValues;
let fetchCalls;
let fetchReplies;
// 一次刷新的每一步都可以单独弄坏：整台宿主拒绝（denyAll）与只有 net.fetch 被拒（denyFetch）。
let denyAll;
let denyFetch;
let surfaceCalls;
let answered;
let postedFrom;
let windowListeners;
let timeouts;
let runtimeErrors;
let scope;

function posted() {
  return window.postMessage.mock.calls.map((call) => call[0]).slice(postedFrom);
}

function byType(type) {
  return posted().filter((m) => m && m.type === type);
}

function requests() {
  return byType('request').map((m) => ({ id: m.id, method: m.method, payload: m.payload }));
}

function methodCalls(method) {
  return requests().filter((req) => req.method === method);
}

function hostSends(data) {
  window.dispatchEvent(new MessageEvent('message', { data, source: window }));
}

function answer(id, result, { ok = true, error = '' } = {}) {
  answered.add(id);
  hostSends({ v: 1, type: 'response', id, ok, result, error });
}

function nextFetchReply() {
  if (fetchReplies.length) {
    const next = fetchReplies.shift();
    return typeof next === 'function' ? next() : next;
  }
  // 没排队就回一个错误：任何"不该发出的请求"都会立刻变成一条能看见的失败，而不是静默成功。
  return { status: 500, body: 'no reply queued' };
}

/** 每拍把还没答的请求答掉，再让出一拍——刷新链是"一个答复引出下一个请求"。 */
async function drain(rounds = 16) {
  for (let i = 0; i < rounds; i += 1) {
    for (const req of requests().filter((r) => !answered.has(r.id))) {
      const payload = req.payload || {};
      if (denyAll) {
        answer(req.id, null, { ok: false, error: `模拟拒绝：未获权限 ${req.method}` });
        continue;
      }
      switch (req.method) {
        case 'config.get':
          answer(req.id, { values: configValues, secrets: {} });
          break;
        case 'config.set':
          Object.assign(configValues, payload.values || {});
          answer(req.id, { ok: true });
          break;
        case 'storage.get':
          answer(req.id, { value: store.has(String(payload.key)) ? store.get(String(payload.key)) : '' });
          break;
        case 'storage.set':
          store.set(String(payload.key), String(payload.value ?? ''));
          answer(req.id, { ok: true });
          break;
        case 'net.fetch':
          fetchCalls.push(payload);
          if (denyFetch) {
            answer(req.id, null, { ok: false, error: '模拟拒绝：未获权限 net.fetch' });
          } else {
            answer(req.id, nextFetchReply());
          }
          break;
        case 'surface.show':
        case 'surface.hide':
        case 'surface.blocks':
          surfaceCalls.push({ method: req.method, payload });
          answer(req.id, { ok: true });
          break;
        default:
          answer(req.id, null, { ok: false, error: `本程序不支持该方法 ${req.method}` });
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function loadApp() {
  answered = new Set();
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  for (const timer of timeouts) clearTimeout(timer.id);
  timeouts = [];
  postedFrom = window.postMessage.mock.calls.length;
  // 返回值是这一份文档的作用域：setClock / market / cfg 都在里面（真实浏览器里没有这条路）。
  // eslint-disable-next-line no-new-func
  return new Function(
    `${source}
     return { setClock, nowMs, market, view, cfg, granted, mountInfo,
              marketIntervalMs, pointsWanted, defaultSource, statusText, lastOkText,
              sparkSvg, fmtPrice, parseTargets, refreshMarket };`,
  )();
}

/** 装一份帧。slot 决定它是插件页、卡片，还是一个没声明的落点。 */
async function boot({ slot = 'workshop', granted = manifest.permissions, config = {}, now = null, rectSlot = '' } = {}) {
  Object.assign(configValues, config);
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
  scope = loadApp();
  // 时钟要在 init 之前装好：init 的处理链第一步就会读"现在"（休市判定）。
  if (now !== null) scope.setClock(() => now);
  const surface =
    slot === 'surface'
      ? {
          kind: 'surface',
          rectIndex: 0,
          rectCount: 1,
          rect: { x: 0, y: 0, w: 300, h: 150, r: 14, tailX: 150, hidden: false, room: 160 },
        }
      : { kind: 'panel', slot };
  // 被面板槽打开的浮层面：init 里**有** slot，而它的值是槽名（`pomodoro`），不是 'surface'。
  if (rectSlot) surface.slot = rectSlot;
  hostSends({
    v: 1,
    type: 'init',
    pluginId: PLUGIN_ID,
    permissions: manifest.permissions,
    granted: [...granted],
    surface,
    host: {
      program: slot === 'workshop' ? 'workshop' : 'pet',
      methods: slot === 'workshop' ? WORKSHOP_METHODS : PET_METHODS,
    },
  });
  await drain(12);
  return scope;
}

function cardRows() {
  return [...document.querySelectorAll('#sf-rows .sf-row')];
}

function wsRows() {
  return [...document.querySelectorAll('#ws-list .ws-row')];
}

// 一次注册，多轮复用（数组本身在 beforeEach 里被换掉，所以监听器读到的永远是当前这一份）。
window.addEventListener('error', (event) => runtimeErrors.push(String(event.message || event.error)));
window.addEventListener('unhandledrejection', (event) =>
  runtimeErrors.push('unhandled: ' + String((event.reason && event.reason.message) || event.reason)),
);

beforeEach(() => {
  store = new Map();
  configValues = {
    targets: 'yahoo:AAPL\nyahoo:0700.HK\nbinance:BTCUSDT',
    source: 'yahoo',
    refreshMinutes: '30',
    points: '30',
  };
  fetchCalls = [];
  fetchReplies = [];
  surfaceCalls = [];
  windowListeners = [];
  timeouts = [];
  runtimeErrors = [];
  denyAll = false;
  denyFetch = false;
  scope = null;

  const originalAdd = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(function (type, fn, opts) {
    windowListeners.push([type, fn, opts]);
    return originalAdd(type, fn, opts);
  });
  const originalTimeout = window.setTimeout.bind(window);
  // 只记账，不拦：vitest 自己的"测试超时"也走 setTimeout，把整套语义换掉会让挂住的用例永远不超时。
  vi.spyOn(window, 'setTimeout').mockImplementation((fn, ms, ...rest) => {
    const id = originalTimeout(fn, ms, ...rest);
    timeouts.push({ id, fn, ms: Number(ms) });
    return id;
  });
  // 定时器**只记录不创建**：每一拍由用例按需触发，结果不会因为真实时钟而漂。
  vi.spyOn(window, 'setInterval').mockImplementation((fn, ms) => 9000 + ms);
  vi.spyOn(window, 'clearInterval').mockImplementation(() => {});
  vi.spyOn(window, 'postMessage').mockImplementation(() => {});
});

afterEach(() => {
  for (const timer of timeouts) clearTimeout(timer.id);
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  vi.restoreAllMocks();
});

// --- manifest ------------------------------------------------------------------

describe('manifest', () => {
  test('只申请用得到的四项权限，没有 background / panel / serves / pet.bubble', () => {
    expect([...manifest.permissions].sort()).toEqual(['net.fetch', 'pet.surface', 'plugin.config', 'storage']);
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.author).toBe('shixiansi');
    expect(Array.from(manifest.description).length).toBeLessThanOrEqual(512);
    // 落点只有两个：一块浮层面 + 控制中心的插件页。常驻帧、宠物本体、bubble.say 都不声明。
    expect(manifest.background).toBeUndefined();
    expect(manifest.body).toBeUndefined();
    expect(manifest.panel).toBeUndefined();
    expect(manifest.panelSlot).toBeUndefined();
    expect(manifest.serves).toBeUndefined();
    expect(manifest.sidecar).toBeUndefined();
    expect(manifest.permissions).not.toContain('events');
    expect(manifest.permissions).not.toContain('pet.bubble');
  });

  test('一块 300×150 的浮层面（就一块，卡片最多三行）', () => {
    expect(manifest.surface).toHaveLength(1);
    const rect = manifest.surface[0];
    expect([rect.dx, rect.dy, rect.w, rect.h, rect.radius]).toEqual([160, -150, 300, 150, 14]);
    // 声明了浮层面就不许 box-shadow / filter / transform（窗口按矩形裁剪）——见 style.css。
    const css = readFileSync(path.join(pluginDir, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const prop of ['box-shadow', 'filter', 'transform', 'text-shadow']) {
      expect(css.includes(prop + ':'), `style.css 里出现了 ${prop}`).toBe(false);
    }
    // 浮层面的帧必须透明，否则矩形里"没画东西"的地方是一条黑带。
    expect(css).toMatch(/:root[^{]*\{[^}]*background:\s*transparent/);
    expect(css).toMatch(/color-scheme:\s*only\s+light/);
    // 不整份引宿主那份 ui.css（它带着阴影与 hover 位移）。
    expect(html).not.toMatch(/href="ui\.css"/);
  });

  test('三个域名都在 netHosts 里（net.fetch 的每个 host 都要静态声明）', () => {
    expect(manifest.netHosts).toEqual([
      'query1.finance.yahoo.com',
      'api.binance.com',
      'api.coingecko.com',
    ]);
    // 界面上的三个按钮与清单里的三个源是同一份词表。
    for (const id of ['yahoo', 'binance', 'coingecko']) {
      expect(html).toContain(`data-source="${id}"`);
    }
  });

  test('四条设置：标的 / 默认行情源 / 刷新间隔 ≥10 / 点数 5–120，label 都 ≤64 字符', () => {
    const byKey = new Map(manifest.config.map((item) => [item.key, item]));
    expect([...byKey.keys()]).toEqual(['targets', 'source', 'refreshMinutes', 'points']);

    const targets = byKey.get('targets');
    expect(targets.type).toBe('text');
    // 默认值一行一个「源:代码」，两种源各来一条。
    expect(targets.default.split('\n')).toContain('yahoo:AAPL');
    expect(targets.default.split('\n')).toContain('binance:BTCUSDT');

    const sourceItem = byKey.get('source');
    expect(sourceItem.type).toBe('select');
    expect(sourceItem.default).toBe('yahoo');
    expect(sourceItem.options.map((option) => option.value)).toEqual(['yahoo', 'binance', 'coingecko']);

    expect(byKey.get('refreshMinutes').type).toBe('number');
    expect(byKey.get('refreshMinutes').default).toBe('30');
    expect(byKey.get('points').type).toBe('number');
    expect(byKey.get('points').default).toBe('30');

    // 宿主的校验：label ≤64 字符（超长的清单**装不上**，而这件事在插件仓里是看不见的）。
    for (const item of manifest.config) {
      expect(Array.from(item.label).length, `${item.key} 的 label 太长`).toBeLessThanOrEqual(64);
    }
    // 没有 secret 也没有 hostWhitelist：三个域名是静态的，用户没有可填的地址。
    expect(manifest.config.filter((item) => item.secret === true)).toHaveLength(0);
    expect(manifest.config.filter((item) => item.hostWhitelist === true)).toHaveLength(0);
  });

  test('页面引的每个文件都进包了，而且没有第二个 <script> 源（不引图表库）', () => {
    const fixed = ['panel.html', 'app.js', 'style.css'];
    for (const src of scriptSources) {
      if (fixed.includes(src)) continue;
      expect(manifest.assets).toContain(src);
    }
    for (const asset of manifest.assets) {
      expect(existsSync(path.join(pluginDir, asset)), `manifest.assets 里的 ${asset} 不存在`).toBe(true);
    }
    expect(existsSync(path.join(pluginDir, manifest.entry))).toBe(true);
    // sparkline 是手写 SVG：没有 CDN、没有打包进来的图表库。
    expect(html).not.toMatch(/<script[^>]+src="https?:/);
    expect(html).not.toContain('chart.js');
    expect(html).not.toContain('d3');
  });

  test('app.js + lib/*.js 合计 ≤1000 行（不引第三方库的代价是它得自己小）', () => {
    const files = ['app.js', ...readdirSync(path.join(pluginDir, 'lib')).map((name) => 'lib/' + name)];
    let lines = 0;
    for (const file of files) {
      // 末尾那个换行不算一行：`wc -l` 与"文件里有多少行文字"是同一件事。
      const parts = readFileSync(path.join(pluginDir, file), 'utf8').split('\n');
      lines += parts.length - (parts[parts.length - 1] === '' ? 1 : 0);
    }
    expect(lines).toBeLessThanOrEqual(1000);
  });
});

// --- 三个源：字段名各不相同，归一化之后同一个形状 ---------------------------------

describe('三个源归一化', () => {
  test('Yahoo：meta.regularMarketPrice + quote.close[]，null 收盘价被丢掉', () => {
    const quote = lib.parseYahoo(YAHOO_AAPL, 'AAPL');
    expect(Object.keys(quote).sort()).toEqual(QUOTE_KEYS);
    expect(quote.symbol).toBe('AAPL');
    expect(quote.price).toBe(189.32);
    // 昨收用 meta.chartPreviousClose：(189.32 - 187.01) / 187.01 ≈ +1.24%
    expect(quote.change).toBeCloseTo(1.2352, 3);
    // 五个收盘价里有一个 null，画线时不许留着（留着会掉到 0）。
    expect(quote.points).toEqual([185.62, 186.71, 187.95, 189.32]);
  });

  test('币安：price 是字符串，klines[i][4] 也是字符串', () => {
    const price = lib.parseBinanceTicker(BINANCE_TICKER, 'BTCUSDT');
    expect(price).toBe(68123.45);
    const points = lib.parseBinanceKlines(BINANCE_KLINES);
    expect(points).toEqual([68000.5, 67450, 67980.25, 68310.75, 68123.45]);

    const quote = lib.binanceQuote('BTCUSDT', price, points);
    expect(Object.keys(quote).sort()).toEqual(QUOTE_KEYS);
    expect(quote.price).toBe(68123.45);
    // 昨收是倒数第二根日线的收盘价：(68123.45 - 68310.75) / 68310.75 ≈ -0.27%
    expect(quote.change).toBeCloseTo(-0.2741, 3);
    expect(quote.points).toHaveLength(5);
  });

  test('CoinGecko：嵌套的 [coinId].usd，只取现价（涨跌与走势留空，不假装 0）', () => {
    const quote = lib.parseCoingecko(COINGECKO_BTC, 'bitcoin');
    expect(Object.keys(quote).sort()).toEqual(QUOTE_KEYS);
    expect(quote.symbol).toBe('bitcoin');
    expect(quote.price).toBe(68123);
    expect(quote.change).toBeNull();
    expect(quote.points).toEqual([]);
    // BTCUSDT 这种写法在 CoinGecko 那一边要换成 coin id。
    expect(lib.coingeckoIdFor('BTC')).toBe('bitcoin');
    expect(lib.coingeckoIdFor('BTCUSDT')).toBe('btcusdt');
  });

  test('三条归一化之后形状与类型完全一致——界面因此不需要知道数据是哪个源给的', () => {
    const quotes = [
      lib.parseYahoo(YAHOO_AAPL, 'AAPL'),
      lib.binanceQuote('BTCUSDT', lib.parseBinanceTicker(BINANCE_TICKER, 'BTCUSDT'), lib.parseBinanceKlines(BINANCE_KLINES)),
      lib.parseCoingecko(COINGECKO_BTC, 'bitcoin'),
    ];
    // 上游的字段名与类型**确实**各不相同——否则这组用例什么也没证明。
    expect(typeof BINANCE_TICKER.price).toBe('string');
    expect(typeof YAHOO_AAPL.chart.result[0].meta.regularMarketPrice).toBe('number');
    expect(Object.keys(COINGECKO_BTC)).toEqual(['bitcoin']);
    expect(COINGECKO_BTC.bitcoin.usd).toBe(68123);

    for (const quote of quotes) {
      expect(Object.keys(quote).sort()).toEqual(QUOTE_KEYS);
      expect(typeof quote.symbol).toBe('string');
      // 价格与涨跌要么是数字、要么是 null（"没有"），永远不是字符串或 0 冒充。
      expect(quote.price === null || typeof quote.price === 'number').toBe(true);
      expect(quote.change === null || typeof quote.change === 'number').toBe(true);
      expect(Array.isArray(quote.points)).toBe(true);
      for (const point of quote.points) expect(typeof point).toBe('number');
    }
  });

  test('响应形状不对时抛一句中文，而不是把 undefined 当成价格画出去', () => {
    expect(() => lib.parseYahoo({ chart: { result: null, error: { description: 'No data found, symbol may be delisted' } } }, 'ZZZZ')).toThrow(
      /Yahoo/,
    );
    expect(() => lib.parseBinanceTicker({ code: -1121, msg: 'Invalid symbol.' }, 'NOPE')).toThrow(/币安/);
    expect(() => lib.parseBinanceKlines({ code: -1121, msg: 'Invalid symbol.' })).toThrow(/币安/);
    expect(() => lib.parseCoingecko({}, 'dogecoin')).toThrow(/CoinGecko/);
  });
});

// --- 行情源可切换：域名与路径都变了 -----------------------------------------------

test('换行情源之后请求的域名与路径都变了（config 的 source 不是装饰）', async () => {
  await boot({ config: { targets: 'AAPL', source: 'yahoo' }, now: weekdayAt() });
  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0].url).toBe(
    'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1mo&interval=1d',
  );
  // UA 是 net.fetch 头白名单里允许的那一个（yahoo 偶发会拒没有 UA 的请求）。
  expect(fetchCalls[0].headers['user-agent']).toContain('Mozilla/5.0');
  expect(fetchCalls[0].headers.accept).toBe('application/json');

  // 点插件页上的「币安」：同一个标的，域名与路径都换掉（币安要两条路径：现价 + 走势）。
  fetchReplies.push({ status: 200, body: JSON.stringify(BINANCE_TICKER) });
  fetchReplies.push({ status: 200, body: JSON.stringify(BINANCE_KLINES) });
  document.querySelector('[data-source="binance"]').click();
  await drain(16);
  expect(configValues.source).toBe('binance');
  const binanceCalls = fetchCalls.slice(1).map((call) => call.url);
  expect(binanceCalls[0]).toBe('https://api.binance.com/api/v3/ticker/price?symbol=AAPL');
  expect(binanceCalls[1]).toBe('https://api.binance.com/api/v3/klines?symbol=AAPL&interval=1d&limit=30');

  // 再切到第三个源：又是一个域名、又是一条路径。
  fetchReplies.push({ status: 200, body: JSON.stringify(COINGECKO_BTC) });
  document.querySelector('[data-source="coingecko"]').click();
  await drain(16);
  expect(configValues.source).toBe('coingecko');
  const coingeckoCalls = fetchCalls.slice(1 + binanceCalls.length).map((call) => call.url);
  expect(coingeckoCalls[0]).toBe('https://api.coingecko.com/api/v3/simple/price?ids=aapl&vs_currencies=usd');
});

test('带前缀的标的不受默认行情源影响：yahoo:AAPL 在 source 是 binance 时仍走 Yahoo', async () => {
  await boot({ config: { targets: 'yahoo:AAPL', source: 'binance' }, now: weekdayAt() });
  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0].url).toContain('query1.finance.yahoo.com');
});

// --- 休市：周末不刷 -------------------------------------------------------------

test('周六的 Yahoo 标的：一个 net.fetch 都不发，表格写「休市」并保留上一次的收盘价', async () => {
  const saturday = weekendAt();
  const fridayAt = saturday - 18 * 60 * 60 * 1000;
  store.set(
    SNAPSHOT_KEY,
    snapshotJSON(fridayAt, [
      { code: 'AAPL', source: 'yahoo', symbol: 'AAPL', price: 187.01, change: 0.53, points: [185.62, 186.71, 187.95, 187.01] },
    ]),
  );

  await boot({ config: { targets: 'yahoo:AAPL' }, now: saturday });

  // 这就是那条规则的全部：交易所没开门，去问一次只是浪费配额、给限流添一笔。
  expect(fetchCalls).toHaveLength(0);
  expect(scope.market.closed).toBe(true);

  const row = wsRows();
  expect(row).toHaveLength(1);
  expect(row[0].querySelector('.ws-code').textContent).toBe('AAPL');
  // 上一次的收盘价还在（不是「—」、更不是 0）。
  expect(row[0].querySelector('.ws-price').textContent).toBe('187.01');
  expect(row[0].querySelector('.ws-flag').textContent).toBe('休市');
  expect(document.getElementById('ws-state').textContent).toContain('休市');
  expect(document.getElementById('ws-state').textContent).toContain('上次成功是');
});

test('同一个周六：加密照常刷新（7×24，休市不适用）', async () => {
  const saturday = weekendAt();
  store.set(SNAPSHOT_KEY, snapshotJSON(saturday - 3 * 60 * 60 * 1000, []));
  fetchReplies.push({ status: 200, body: JSON.stringify(BINANCE_TICKER) });

  await boot({ config: { targets: 'binance:BTCUSDT' }, now: saturday });
  // 两条路径（现价 + 走势）都发出去了。
  expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
  expect(fetchCalls[0].url).toContain('api.binance.com');
  expect(scope.market.closed).toBe(false);
});

test('工作日：Yahoo 照常请求（周末那一条不是"Yahoo 永远不刷"）', async () => {
  await boot({ config: { targets: 'yahoo:AAPL' }, now: weekdayAt() });
  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0].url).toContain('/v8/finance/chart/AAPL');
});

// --- 失败不清空 ----------------------------------------------------------------

function seedStaleSnapshot(at) {
  store.set(
    SNAPSHOT_KEY,
    snapshotJSON(at, [
      { code: 'AAPL', source: 'yahoo', symbol: 'AAPL', price: 187.01, change: 0.53, points: [185.62, 186.71, 187.95, 187.01] },
    ]),
  );
}

test('status 500：价格留在原地，界面写「上次成功是 40 分钟前」', async () => {
  const when = weekdayAt();
  const lastOk = when - 40 * 60 * 1000;
  seedStaleSnapshot(lastOk);
  fetchReplies.push({ status: 500, body: 'upstream is down' });

  await boot({ config: { targets: 'yahoo:AAPL' }, now: when });

  expect(fetchCalls).toHaveLength(1);
  const row = wsRows();
  expect(row[0].querySelector('.ws-price').textContent).toBe('187.01');
  expect(row[0].querySelector('.ws-flag').textContent).toBe('未更新');
  const bad = document.getElementById('ws-bad').textContent;
  expect(bad).toContain('500');
  expect(document.getElementById('ws-state').textContent).toContain('上次成功是 40 分钟前');
  // 失败不落盘：快照里的 at 还是上一次成功的那一个。
  expect(JSON.parse(store.get(SNAPSHOT_KEY)).at).toBe(lastOk);
});

test('net.fetch 被拒：宿主的原话显示出来，价格不清空', async () => {
  const when = weekdayAt();
  seedStaleSnapshot(when - 45 * 60 * 1000);
  denyFetch = true;

  await boot({ config: { targets: 'yahoo:AAPL' }, now: when });

  expect(wsRows()[0].querySelector('.ws-price').textContent).toBe('187.01');
  expect(document.getElementById('ws-bad').textContent).toContain('模拟拒绝：未获权限 net.fetch');
  expect(document.getElementById('ws-state').textContent).toContain('上次成功是 45 分钟前');
});

test('429：额外写「被限流」，快照仍然不被覆盖', async () => {
  const when = weekdayAt();
  const lastOk = when - 2 * 60 * 60 * 1000;
  seedStaleSnapshot(lastOk);
  fetchReplies.push({ status: 429, body: '{"message":"Too Many Requests"}' });

  await boot({ config: { targets: 'yahoo:AAPL' }, now: when });

  const state = document.getElementById('ws-state').textContent;
  expect(state).toContain('被限流');
  expect(state).toContain('上次成功是 2 小时前');
  expect(wsRows()[0].querySelector('.ws-price').textContent).toBe('187.01');
  expect(JSON.parse(store.get(SNAPSHOT_KEY)).at).toBe(lastOk);
});

test('全都成功才推进时间戳并落盘；坏 JSON 不算成功', async () => {
  const when = weekdayAt();
  fetchReplies.push({ status: 200, body: JSON.stringify(YAHOO_AAPL) });
  await boot({ config: { targets: 'yahoo:AAPL' }, now: when });
  expect(scope.market.at).toBe(when);
  expect(JSON.parse(store.get(SNAPSHOT_KEY)).items[0].price).toBe(189.32);

  // 第二次：宿主给了一段不是 JSON 的正文。
  fetchReplies.push({ status: 200, body: '<html>not json</html>' });
  scope.setClock(() => when + 60 * 60 * 1000);
  // 不 await：refreshMarket 要等 drain 送答复，先等它就死在这儿了。
  void scope.refreshMarket({ force: true });
  await drain(12);
  expect(scope.market.at).toBe(when); // 没有新成功 → 时间戳不动
  expect(JSON.parse(store.get(SNAPSHOT_KEY)).items[0].price).toBe(189.32);
  expect(wsRows()[0].querySelector('.ws-price').textContent).toBe('189.32');
});

// --- sparkline：真的 SVG，点数与数据点数一致 -------------------------------------

describe('sparkline', () => {
  test('polyline 的点数与数据点数一致，全平的一段画在中间', () => {
    const flat = lib.sparkPoints([5, 5, 5, 5], 100, 20, 2);
    expect(flat.count).toBe(4);
    expect(flat.attr.split(' ')).toHaveLength(4);
    // 四个 y 都一样，而且是竖直中间（20/2 = 10）。
    const ys = flat.attr.split(' ').map((pair) => Number(pair.split(',')[1]));
    expect(new Set(ys).size).toBe(1);
    expect(ys[0]).toBeCloseTo(10, 5);

    const line = lib.sparkPoints([1, 2, 3], 100, 20, 2);
    expect(line.attr.split(' ')).toHaveLength(3);
    // 价高者在上面：y 随数值单调递减。
    const y0 = Number(line.attr.split(' ')[0].split(',')[1]);
    const y2 = Number(line.attr.split(' ')[2].split(',')[1]);
    expect(y2).toBeLessThan(y0);
  });

  test('没有数据时画基线而不是一条"刚好是平的"线', () => {
    const empty = lib.sparkSvg([], 84, 20, 'sf-spark');
    expect(empty).toContain('<svg');
    expect(empty).not.toContain('<polyline');
    const one = lib.sparkSvg([1, 2], 84, 20, 'sf-spark');
    expect(one).toContain('<polyline');
  });

  test('卡片里的 sparkline 是真的 SVG 元素，点数与快照里的点数一致', async () => {
    const when = weekdayAt();
    fetchReplies.push({ status: 200, body: JSON.stringify(YAHOO_AAPL) });
    await boot({ slot: 'surface', config: { targets: 'yahoo:AAPL', points: '30' }, now: when });

    const svg = document.querySelector('#sf-rows .sf-row svg');
    expect(svg).toBeTruthy();
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
    const line = svg.querySelector('polyline');
    expect(line).toBeTruthy();
    // 五根日线里有一个 null 被丢掉 → 四个点，polyline 就四个坐标。
    expect(line.getAttribute('points').split(' ')).toHaveLength(4);
    // 卡片那一行的文字形状：代码 · 现价 · ±x%
    const row = cardRows()[0];
    expect(row.querySelector('.sf-code').textContent).toBe('AAPL');
    expect(row.querySelector('.sf-price').textContent).toBe('189.32');
    expect(row.querySelector('.sf-chg').textContent).toBe('+1.24%');
  });

  test('config 的 points 决定留几个点（七个点只画最后五个）', async () => {
    const when = weekdayAt();
    const wide = JSON.parse(JSON.stringify(YAHOO_AAPL));
    wide.chart.result[0].indicators.quote[0].close = [180.1, 181.2, 182.3, 183.4, 184.5, 185.6, 189.32];
    fetchReplies.push({ status: 200, body: JSON.stringify(wide) });
    await boot({ slot: 'surface', config: { targets: 'yahoo:AAPL', points: '5' }, now: when });
    const line = document.querySelector('#sf-rows .sf-row svg polyline');
    expect(line.getAttribute('points').split(' ')).toHaveLength(5);
    // 点数本身也是夹过的：设置成 1 会按 5 算。
    expect(scope.pointsWanted()).toBe(5);
  });
});

// --- 数字格式 -------------------------------------------------------------------

test('涨跌永远带 +/- 与两位小数；没有数据写「—」，不写 0', () => {
  expect(lib.fmtChange(1.2352)).toBe('+1.24%');
  expect(lib.fmtChange(-0.2741)).toBe('-0.27%');
  expect(lib.fmtChange(0)).toBe('+0.00%');
  expect(lib.fmtChange(null)).toBe('—');
  expect(lib.fmtPrice(189.316)).toBe('189.32');
  expect(lib.fmtPrice(0.000012345)).toBe('0.00001234');
  expect(lib.fmtPrice(null)).toBe('—');
  expect(lib.fmtPrice(undefined)).toBe('—');
  expect(lib.agoText(30 * 1000)).toBe('刚刚');
  expect(lib.agoText(12 * 60 * 1000)).toBe('12 分钟');
  expect(lib.agoText(3 * 60 * 60 * 1000)).toBe('3 小时');
  expect(lib.changeSide(1)).toBe('up');
  expect(lib.changeSide(-1)).toBe('down');
  expect(lib.changeSide(null)).toBe('flat');
});

test('刷新间隔最少 10 分钟，排下去的那一拍不会小于 600 000 ms', async () => {
  await boot({ config: { targets: 'yahoo:AAPL', refreshMinutes: '1' }, now: weekdayAt() });
  expect(scope.marketIntervalMs()).toBe(10 * 60 * 1000);
  // 定时器真的按"分钟"排：没有任何 1 秒的轮询（drain 自己那些 0ms 的拍子会混进来，先滤掉）。
  const scheduled = timeouts.map((timer) => timer.ms).filter((ms) => ms >= 1000);
  expect(scheduled.length).toBeGreaterThan(0);
  expect(Math.min(...scheduled)).toBe(600000);

  scope.cfg.refreshMinutes = '30';
  expect(scope.marketIntervalMs()).toBe(30 * 60 * 1000);
});

test('快照还新鲜时一个请求都不发（重开插件页不该再打一遍上游）', async () => {
  const when = weekdayAt();
  store.set(
    SNAPSHOT_KEY,
    snapshotJSON(when - 5 * 60 * 1000, [
      { code: 'AAPL', source: 'yahoo', symbol: 'AAPL', price: 187.01, change: 0.53, points: [185.62, 186.71] },
    ]),
  );
  await boot({ config: { targets: 'yahoo:AAPL' }, now: when });
  expect(fetchCalls).toHaveLength(0);
  expect(wsRows()[0].querySelector('.ws-price').textContent).toBe('187.01');
});

// --- 标的列表的解析 -------------------------------------------------------------

test('「源:代码」的解析：一行一个，最多 8 个，没有前缀的跟随默认源', () => {
  const parsed = lib.parseTargets('yahoo:AAPL\nbinance:BTCUSDT\nEURUSD=X');
  expect(parsed).toEqual([
    { source: 'yahoo', code: 'AAPL' },
    { source: 'binance', code: 'BTCUSDT' },
    { source: '', code: 'EURUSD=X' },
  ]);
  // 设置表单里那个框是单行 input：换行被压成一行时也得认得出来。
  expect(lib.parseTargets('yahoo:AAPL, binance:BTCUSDT')).toHaveLength(2);
  expect(lib.parseTargets('yahoo:AAPL | binance:BTCUSDT')).toHaveLength(2);
  // 八个封顶。
  expect(lib.parseTargets('a,b,c,d,e,f,g,h,i,j')).toHaveLength(8);
  // 空行与注释不算标的。
  expect(lib.parseTargets('\n# 我的持仓\nyahoo:AAPL\n')).toEqual([{ source: 'yahoo', code: 'AAPL' }]);
  expect(lib.parseTargets('')).toEqual([]);
});

test('插件页保存标的：config.set 写原文，然后重取一次', async () => {
  await boot({ config: { targets: 'yahoo:AAPL' }, now: weekdayAt() });
  fetchCalls = [];
  fetchReplies.push({ status: 200, body: JSON.stringify(YAHOO_AAPL) });

  document.getElementById('ws-targets').value = 'yahoo:AAPL\nyahoo:0700.HK';
  document.getElementById('ws-save').click();
  await drain(16);

  expect(configValues.targets).toBe('yahoo:AAPL\nyahoo:0700.HK');
  expect(methodCalls('config.set').length).toBeGreaterThan(0);
  // 两个标的 → 两次请求，界面上的行也跟着变成两行。
  expect(fetchCalls).toHaveLength(2);
  expect(wsRows()).toHaveLength(2);
});

// --- 空状态与落点 ---------------------------------------------------------------

test('标的一个都没有时：空状态，没有行，也不发请求', async () => {
  await boot({ config: { targets: '' }, now: weekdayAt() });
  expect(fetchCalls).toHaveLength(0);
  expect(wsRows()).toHaveLength(0);
  expect(document.getElementById('ws-empty').classList.contains('hidden')).toBe(false);
});

test('卡片视口里最多三行，脚注说"还有 N 个"', async () => {
  const when = weekdayAt();
  const items = ['AAPL', 'MSFT', '0700.HK', 'NVDA', 'TSLA'].map((code, index) => ({
    code,
    source: 'yahoo',
    symbol: code,
    price: 100 + index,
    change: index - 2,
    points: [1, 2, 3],
  }));
  store.set(SNAPSHOT_KEY, snapshotJSON(when - 5 * 60 * 1000, items));
  await boot({ slot: 'surface', config: { targets: 'AAPL\nMSFT\n0700.HK\nNVDA\nTSLA' }, now: when });

  expect(cardRows()).toHaveLength(3);
  expect(document.getElementById('sf-foot').textContent).toContain('还有 2 个');
});

test('浮层面的 slot 是槽名（pomodoro）时照样画卡片：判断只看 kind', async () => {
  // 手册 §5.2：slot 只在宿主手里有槽名时才出现，而一块被面板槽打开的浮层面拿到的是那个槽名。
  // 第一版拿 `slot === 'surface'` 判，矩形裁出来了、卡片还停在 .hidden 里，屏幕上什么都没有。
  const when = weekdayAt();
  store.set(
    SNAPSHOT_KEY,
    snapshotJSON(when - 5 * 60 * 1000, [
      { code: 'AAPL', source: 'yahoo', symbol: 'AAPL', price: 187.01, change: 0.53, points: [185.62, 186.71] },
    ]),
  );
  await boot({ slot: 'surface', rectSlot: 'pomodoro', config: { targets: 'yahoo:AAPL' }, now: when });

  expect(document.getElementById('surface').classList.contains('hidden')).toBe(false);
  expect(cardRows()).toHaveLength(1);
  expect(cardRows()[0].querySelector('.sf-price').textContent).toBe('187.01');
  // 卡片那一面要有自己的底色（浮层面的帧本身是透明的，"画出来了"等于卡片被铺满了）。
  expect(document.body.dataset.view).toBe('surface');
});

test('桌宠那边（surface）的卡片画的是休市里的上一份价格', async () => {
  const saturday = weekendAt();
  store.set(
    SNAPSHOT_KEY,
    snapshotJSON(saturday - 20 * 60 * 60 * 1000, [
      { code: 'AAPL', source: 'yahoo', symbol: 'AAPL', price: 187.01, change: 0.53, points: [185.62, 186.71] },
    ]),
  );
  await boot({ slot: 'surface', config: { targets: 'yahoo:AAPL' }, now: saturday });

  expect(fetchCalls).toHaveLength(0);
  const row = cardRows()[0];
  expect(row.querySelector('.sf-price').textContent).toBe('187.01');
  // 休市那一格写「休市」，不是「+0.53%」——没成交不是"涨了 0.53%"。
  expect(row.querySelector('.sf-chg').textContent).toBe('休市');
  expect(document.getElementById('sf-foot').textContent).toContain('休市');
});

// --- 握手 ----------------------------------------------------------------------

test('握手：先发 ready，init 之前一个请求都不发，init 之后 granted 才装上', async () => {
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
  scope = loadApp();

  expect(byType('ready')).toHaveLength(1);
  expect(byType('ready')[0]).toEqual({ v: 1, type: 'ready' });
  expect(requests()).toHaveLength(0);
  expect(scope.granted.size).toBe(0);

  hostSends({
    v: 1,
    type: 'init',
    pluginId: PLUGIN_ID,
    permissions: manifest.permissions,
    granted: [...manifest.permissions],
    surface: { kind: 'panel', slot: 'workshop' },
    host: { program: 'workshop', methods: WORKSHOP_METHODS },
  });
  await drain(12);

  expect(scope.granted.has('net.fetch')).toBe(true);
  expect(methodCalls('config.get').length).toBe(1);
  // 同一个文档只握手一次：第二条 init 不该再引出第二轮请求。
  const before = requests().length;
  hostSends({ v: 1, type: 'init', granted: [], surface: { kind: 'panel', slot: 'workshop' } });
  await drain(4);
  expect(requests().length).toBe(before);
  expect(runtimeErrors).toEqual([]);
});

// --- 宿主拒绝一切 ---------------------------------------------------------------

test('宿主拒绝一切：不崩、不写数据、价格显示「—」而不是 0', async () => {
  denyAll = true;
  await boot({ config: { targets: 'yahoo:AAPL\nbinance:BTCUSDT' }, now: weekdayAt() });

  expect(runtimeErrors).toEqual([]);
  // 一条都不写：读失败时把"没有数据"写进 storage，等于用失败覆盖用户上一次的成功。
  expect(store.has(SNAPSHOT_KEY)).toBe(false);
  expect(store.has(VIEW_KEY)).toBe(false);

  const rows = wsRows();
  // config.get 也被拒了，所以列表来自代码里那份默认值（三个标的）——界面照样画得出来，只是每一格
  // 都是「—」。
  expect(rows).toHaveLength(3);
  for (const row of rows) {
    expect(row.querySelector('.ws-price').textContent).toBe('—');
    expect(row.querySelector('.ws-chg').textContent).toBe('—');
    expect(row.querySelector('.ws-flag').textContent).toBe('未更新');
  }
  expect(document.getElementById('ws-bad').textContent).toContain('模拟拒绝');
  expect(document.getElementById('ws-state').textContent).toContain('还没有成功过');
});

test('granted=[] 时连请求都不发（未授权的控件不装成能用）', async () => {
  await boot({ granted: [], now: weekdayAt() });
  expect(requests()).toHaveLength(0);
  expect(runtimeErrors).toEqual([]);
  // 界面照样能看，写的是"没授权"，而不是"你还没有标的"。
  expect(document.getElementById('ws-bad').textContent).toContain('net.fetch');
});
