// lib/sources.js —— 三个行情源：URL 的构造，与三种**互不相同**的响应的归一化
//
// 这里是唯一关住"上游形状差异"的地方。三个源报价格的字段名与类型都不一样：
//   Yahoo chart            meta.regularMarketPrice（数字）/ indicators.quote[0].close[]（有 null）
//   币安 ticker/price      price（**字符串**）；走势在 klines[i][4]（也是字符串，按下标取）
//   CoinGecko simple/price [coinId].usd（嵌套；只取现价）
// 出去的时候一律是同一个形状 {symbol, price, change, points}，界面因此不需要知道数据来自哪个源。
// 这一支是**纯函数**：不碰宿主、不发请求、不读时钟（`closedReason` 的"现在"是参数）。
'use strict';

const SOURCE_IDS = ['yahoo', 'binance', 'coingecko'];
const SOURCE_LABELS = { yahoo: 'Yahoo 财经', binance: '币安', coingecko: 'CoinGecko' };
const MAX_TARGETS = 8;
// 休市时表格里那一格的字。写死成常量，用例与界面读的是同一份。
const CLOSED_TEXT = '休市';
// CoinGecko 的路径要的是 **coin id**（bitcoin），不是交易对（BTCUSDT）。常见的那几个直接认，
// 认不出来的按"用户写的就是 id"处理（小写化）——它的 id 本来就是小写单词。
const COIN_IDS = {
  BTC: 'bitcoin', ETH: 'ethereum', BNB: 'binancecoin', SOL: 'solana', XRP: 'ripple',
  ADA: 'cardano', DOGE: 'dogecoin', TRX: 'tron', TON: 'the-open-network', LTC: 'litecoin',
  DOT: 'polkadot', AVAX: 'avalanche-2', LINK: 'chainlink', MATIC: 'matic-network',
};

function isSourceId(value) {
  return SOURCE_IDS.indexOf(String(value || '').toLowerCase()) >= 0;
}

function sourceLabel(id) {
  return SOURCE_LABELS[id] || String(id || '');
}

/**
 * 「源:代码」的文本 → 标的列表。
 *
 * 分隔符接受换行（文档里的写法）、逗号、分号和空格：设置表单里那个框是**单行** input，用户改一次
 * 就可能把换行压掉，只认换行的话他会看到"一个标的"而配置里明明是三个。没有前缀的标的跟随默认
 * 行情源——那正是「行情源可切换」这条规则能成立的地方。
 */
function parseTargets(raw) {
  const out = [];
  const seen = Object.create(null);
  // 注释整行忽略（先从行内去掉，否则 `# 我的持仓` 会被拆成两个"标的"）。
  const text = String(raw === undefined || raw === null ? '' : raw).replace(/#[^\n]*/g, ' ');
  for (const piece of text.split(/[\s,;|]+/)) {
    const token = piece.trim();
    if (!token) continue;
    let source = '';
    let code = token;
    const colon = token.indexOf(':');
    if (colon > 0 && isSourceId(token.slice(0, colon))) {
      source = token.slice(0, colon).toLowerCase();
      code = token.slice(colon + 1);
    }
    code = code.trim();
    if (!code) continue;
    const key = source + '|' + code.toUpperCase();
    if (seen[key]) continue;
    seen[key] = true;
    out.push({ source, code });
    if (out.length >= MAX_TARGETS) break;
  }
  return out;
}

function coingeckoIdFor(code) {
  const upper = String(code || '').toUpperCase();
  return COIN_IDS[upper] || String(code || '').toLowerCase();
}

// --- URL ---------------------------------------------------------------------
// 三个域名都静态写进了 manifest.netHosts。路径与查询串在这里拼，用例直接断言它们。

function yahooUrl(symbol, range) {
  const sym = encodeURIComponent(String(symbol));
  return `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=${encodeURIComponent(String(range || '1mo'))}&interval=1d`;
}

function binanceTickerUrl(symbol) {
  return `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(String(symbol).toUpperCase())}`;
}

function binanceKlinesUrl(symbol, limit) {
  const pair = encodeURIComponent(String(symbol).toUpperCase());
  return `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d&limit=${encodeURIComponent(String(limit || 30))}`;
}

function coingeckoUrl(id) {
  return `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(String(id))}&vs_currencies=usd`;
}

// --- 归一化 -------------------------------------------------------------------

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(n) ? n : null;
}

function percentBetween(price, base) {
  const p = toNumber(price);
  const b = toNumber(base);
  return p === null || b === null || b === 0 ? null : ((p - b) / b) * 100;
}

function quoteOf(symbol, price, change, points) {
  return { symbol: String(symbol), price: toNumber(price), change: toNumber(change), points: Array.isArray(points) ? points.slice() : [] };
}

/**
 * Yahoo chart 的响应 → 一条行情。
 *
 * 收盘价数组里**有 null**（停牌、当天没成交），所以要把它们滤掉再画线：留着会让 sparkline 掉到
 * 0，看起来像一次暴跌。
 */
function parseYahoo(payload, code) {
  const chart = payload && payload.chart;
  const result = chart && Array.isArray(chart.result) ? chart.result[0] : null;
  if (!result || typeof result !== 'object') {
    const why = chart && chart.error && chart.error.description ? String(chart.error.description) : '响应里没有 chart.result';
    throw new Error(`Yahoo 没有返回 ${code} 的走势：${why}`);
  }
  const quote = result.indicators && Array.isArray(result.indicators.quote) ? result.indicators.quote[0] : null;
  const points = [];
  for (const close of quote && Array.isArray(quote.close) ? quote.close : []) {
    const value = toNumber(close);
    if (value !== null) points.push(value);
  }
  const meta = result.meta || {};
  const marketPrice = toNumber(meta.regularMarketPrice);
  const price = marketPrice !== null ? marketPrice : points.length ? points[points.length - 1] : null;
  // 昨收：meta.chartPreviousClose 是交易所给的那一个，比"数组倒数第二个"准（最后一天可能还没收
  // 盘）。拿不到才退回数组。
  let previous = toNumber(meta.chartPreviousClose);
  if (previous === null) previous = toNumber(meta.previousClose);
  if (previous === null && points.length > 1) previous = points[points.length - 2];
  return quoteOf(code, price, percentBetween(price, previous), points);
}

/** 币安 ticker/price 的响应 → 一个数字（它把价格写成字符串）。 */
function parseBinanceTicker(payload, code) {
  const price = toNumber(payload && payload.price);
  if (price === null) throw new Error(`币安没有返回 ${code} 的现价：${(payload && payload.msg) || '响应里没有 price'}`);
  return price;
}

/** 币安 klines 的响应 → 收盘价数组（第 4 个下标，也是字符串）。 */
function parseBinanceKlines(payload) {
  if (!Array.isArray(payload)) throw new Error(`币安没有返回走势：${(payload && payload.msg) || 'klines 应该是数组'}`);
  const points = [];
  for (const row of payload) {
    const close = Array.isArray(row) ? toNumber(row[4]) : null;
    if (close !== null) points.push(close);
  }
  return points;
}

/** 现价（ticker）+ 走势（klines）→ 一条行情。昨收取日线数组的倒数第二根，那才是"日涨跌"。 */
function binanceQuote(code, price, points) {
  const previous = points.length > 1 ? points[points.length - 2] : null;
  return quoteOf(code, price, percentBetween(price, previous), points);
}

/**
 * CoinGecko simple/price 的响应 → 一条行情。
 *
 * 这个源只取现价：涨跌与走势留 **null / 空数组**，界面按「—」画，而不是假装 0。它是第三个备选
 * 源，存在的意义是证明"换行情源真的换了域名"；要完整走势得再请求 market_chart 那条路径，那是
 * 另一件事（README 里写着）。
 */
function parseCoingecko(payload, code) {
  const id = coingeckoIdFor(code);
  const price = toNumber(payload && payload[id] && payload[id].usd);
  if (price === null) {
    const why = payload && payload.status && payload.status.error_message ? String(payload.status.error_message) : `响应里没有 ${id}.usd`;
    throw new Error(`CoinGecko 没有返回 ${id} 的现价：${why}`);
  }
  return quoteOf(code, price, null, []);
}

/**
 * 现在这个时刻，这个源开不开市。
 *
 * 只有 Yahoo 会休市：它背后是交易所，周六和周日不开。币安与 CoinGecko 是加密，7×24。节假日
 * （元旦、圣诞…）与各交易所不同的收盘时间这里**不猜**——猜错的代价是明明开着却整天不刷新，而
 * "照着周末停一下"要简单得多，也说得清（README 里写明）。
 */
function closedReason(source, when) {
  if (source !== 'yahoo') return '';
  const day = when instanceof Date ? when.getDay() : new Date(when).getDay();
  return day === 0 || day === 6 ? CLOSED_TEXT : '';
}
