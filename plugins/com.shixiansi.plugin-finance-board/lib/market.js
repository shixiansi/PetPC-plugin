// lib/market.js —— 一份快照 + 一次刷新
//
// 两条规则决定了这一支的形状：**失败不清空**（请求被拒 / status ≥ 400 / JSON 坏掉 / 429 都不许把
// 界面清成"没有数据"——那会把一次网络失败说成"这只股票不存在了"；每行都有"保留上一份"的退路），
// **休市就一个请求都不发**（周末交易所不开门，问一次只是浪费配额；判定是纯函数，用例才能把周六
// 喂进来）。快照落盘只在至少一条成功之后发生：全失败时写盘等于用"空"覆盖"有"。
'use strict';

// yahoo 偶尔会拒绝没有 UA 的请求。net.fetch 的头白名单里有 user-agent（手册 §6.10），所以带一个
// 正常的 UA 是允许的——这也是这里除 accept 之外唯一设置的头。
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PetPC-finance-board/0.1.0';

const PERIODS = [
  { value: '1mo', label: '1 个月', days: 30 },
  { value: '3mo', label: '3 个月', days: 90 },
  { value: '6mo', label: '6 个月', days: 180 },
];

// 屏幕上那一份。`at` 是**上一次成功**的时间，不是上一次尝试——「上次成功是 X 前」只能这么算。
const market = { loaded: false, at: 0, source: '', items: [], error: '', rateLimited: false, closed: false };
// 浏览偏好（周期）：插件页写，卡片读。
const view = { loaded: false, period: '1mo' };

// 清单里那份默认值的代码副本。它不是"第二份真相"：`config.get` 在用户没存过时可以回一个空的
// values（假宿主就只回 {}），那时界面上得看得见东西；用户真的清空了列表，值就是 `''`，这里的
// 兜底不会把它变回来（cfgText 只对"没有这个键"兜底）。
const DEFAULT_TARGETS = 'yahoo:AAPL\nyahoo:0700.HK\nbinance:BTCUSDT';

function periodSpec(value) {
  for (const spec of PERIODS) {
    if (spec.value === value) return spec;
  }
  return null;
}

function periodOf() {
  return periodSpec(view.period) || PERIODS[0];
}

/** 刷新间隔：最少 10 分钟。行情不是秒级数据，1 秒一刷会把配额和日志一起烧掉。 */
function marketIntervalMs() {
  return cfgNum('refreshMinutes', 10, 1440, 30) * 60 * 1000;
}

function pointsWanted() {
  return cfgNum('points', 5, 120, 30);
}

function defaultSource() {
  const raw = cfgText('source', 'yahoo').trim().toLowerCase();
  return isSourceId(raw) ? raw : 'yahoo';
}

/** 当前标的列表的**原文**（给插件页那个编辑框用，保留用户自己写的分隔符）。 */
function targetsText() {
  return cfgText('targets', DEFAULT_TARGETS);
}

function trimPoints(points, keep) {
  const list = Array.isArray(points) ? points : [];
  const limit = Math.max(1, Number(keep) || 1);
  return list.length > limit ? list.slice(list.length - limit) : list.slice();
}

/** 快照里的一行（磁盘上的东西不可信：类型与点数都要重新夹一遍）。 */
function cleanRow(row) {
  if (!row || typeof row !== 'object' || !row.code) return null;
  return {
    code: String(row.code), source: String(row.source || ''), symbol: String(row.symbol || row.code),
    price: numberOrNull(row.price), change: numberOrNull(row.change),
    points: trimPoints(row.points, 120), closed: String(row.closed || ''), stale: false,
  };
}

async function loadView() {
  view.loaded = true;
  const raw = await readKey(KEY_VIEW, '');
  if (!raw) return;
  try {
    const spec = periodSpec((JSON.parse(raw) || {}).period);
    if (spec) view.period = spec.value;
  } catch {
    // 偏好坏了就用默认周期：它只影响取多长的窗口。
  }
}

async function setPeriod(value) {
  const spec = periodSpec(value);
  if (!spec) return false;
  view.loaded = true;
  view.period = spec.value;
  return writeKey(KEY_VIEW, JSON.stringify({ period: spec.value }));
}

async function loadSnapshot() {
  market.loaded = true;
  const raw = await readKey(KEY_SNAPSHOT, '');
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) || {};
    market.at = numberOrNull(parsed.at) || 0;
    market.source = String(parsed.source || '');
    market.items = (Array.isArray(parsed.items) ? parsed.items : []).map(cleanRow).filter(Boolean);
  } catch {
    // 快照坏了就当没有：界面写「还没有成功过」，而不是一张少了半边的表。
  }
}

async function saveSnapshot() {
  return writeKey(KEY_SNAPSHOT, JSON.stringify({ at: market.at, source: market.source, items: market.items }));
}

function shortHost(url) {
  const match = /^https?:\/\/([^/]+)/.exec(String(url || ''));
  return match ? match[1] : String(url || '');
}

/**
 * 一次 GET → JSON。HTTP 错误**不抛异常**（net.fetch 只在请求发不出去时拒绝），所以 status 要在
 * 这里自己看；429 单独认出来——它不是"这个标的不存在"，是"先停一会儿"。
 */
async function fetchJson(url) {
  const out = await request('net.fetch', {
    method: 'GET',
    url,
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
  });
  const status = Number.isFinite(Number(out && out.status)) ? Number(out.status) : 200;
  const body = out && typeof out.body === 'string' ? out.body : '';
  if (status === 429) {
    const err = new Error(shortHost(url) + ' 被限流（429）：等一会儿再刷新，别连点');
    err.rateLimited = true;
    throw err;
  }
  if (status >= 400) throw new Error(shortHost(url) + ' 返回 ' + status);
  if (!body) throw new Error(shortHost(url) + ' 返回了空响应');
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(shortHost(url) + ' 的响应不是 JSON');
  }
}

function rowOf(code, source, symbol, price, change, points, closed, stale) {
  return { code, source, symbol, price, change, points, closed, stale };
}

function finishRow(code, source, quote, keep) {
  const price = numberOrNull(quote.price);
  return rowOf(code, source, quote.symbol || code, price, numberOrNull(quote.change), trimPoints(quote.points, keep), '', false);
}

/** 上一条同名同源的行（没有就 null）。这是"失败不清空"那一半的全部实现。 */
function findRow(code, source) {
  for (const row of market.items) {
    if (row && row.code === code && row.source === source) return row;
  }
  return null;
}

/** 这一行拿不到新数据时显示什么：上一次的价格 + 一个说明（休市 / 未更新）。 */
function carryRow(code, source, reason, keep, stale) {
  const old = findRow(code, source);
  const points = old ? trimPoints(old.points, keep) : [];
  return rowOf(code, source, (old && old.symbol) || code, old ? numberOrNull(old.price) : null,
    old ? numberOrNull(old.change) : null, points, reason || '', Boolean(stale));
}

/** 一个标的 → 一条行情。失败就抛（外层记下来并保留上一次的）。 */
async function fetchTarget(code, source, period) {
  if (source === 'yahoo') return parseYahoo(await fetchJson(yahooUrl(code, period.value)), code);
  if (source === 'binance') {
    // 现价与走势是两条路径：ticker/price 给的是"此刻"，klines 给的是"最近 N 根日线"。
    const price = parseBinanceTicker(await fetchJson(binanceTickerUrl(code)), code);
    return binanceQuote(code, price, parseBinanceKlines(await fetchJson(binanceKlinesUrl(code, period.days))));
  }
  return parseCoingecko(await fetchJson(coingeckoUrl(coingeckoIdFor(code))), code);
}

/**
 * 一次完整的刷新。
 *
 * `options.force` 跳过"还没到间隔"那一步（用户按了「刷新一次」）；
 * `options.reload === false` 表示调用方刚刚读过设置，别读第二遍。
 */
async function refreshMarket(options) {
  const opts = options || {};
  if (opts.reload !== false) await refreshConfig();
  if (!view.loaded) await loadView();
  if (!market.loaded) await loadSnapshot();

  // 快照还新鲜就一个请求都不发：挂载、切窗口、重开插件页都会走到这里。
  if (!opts.force && market.at > 0 && nowMs() - market.at < marketIntervalMs()) {
    paint();
    return market;
  }

  const targets = parseTargets(targetsText());
  const source = defaultSource();
  const period = periodOf();
  const keep = pointsWanted();
  const when = new Date(nowMs());
  const rows = [];
  let fresh = 0;
  let rateLimited = false;
  let error = '';
  let closed = false;

  for (const target of targets) {
    const src = target.source || source;
    const reason = closedReason(src, when);
    if (reason) {
      closed = true;
      rows.push(carryRow(target.code, src, reason, keep, false));
      continue;
    }
    if (!can('net.fetch')) {
      // 没授权就连请求都不发（一次被拒的请求是一行 WARN，而这里每天会撞很多次）。
      error = '未获权限 net.fetch：取不到行情，显示的是上一次的快照';
      rows.push(carryRow(target.code, src, '', keep, true));
      continue;
    }
    try {
      // 一个标的一条，串行发：别把 8 个标的 × 2 条路径同时甩出去——那正是被限流的姿势。
      rows.push(finishRow(target.code, src, await fetchTarget(target.code, src, period), keep));
      fresh += 1;
    } catch (err) {
      if (err && err.rateLimited) rateLimited = true;
      if (!error) error = errorText(err);
      rows.push(carryRow(target.code, src, '', keep, true));
    }
  }

  Object.assign(market, { items: rows, source, error, rateLimited, closed: closed && fresh === 0 && rows.length > 0 });
  // 只有"有新的成功"才推进时间戳并落盘：全失败时写盘就是用空覆盖有。
  if (fresh > 0) {
    market.at = nowMs();
    await saveSnapshot();
  }
  paint();
  return market;
}

function lastOkText() {
  if (!market.at) return '还没有成功过';
  const ago = agoText(nowMs() - market.at);
  return ago === '刚刚' ? '上次成功是刚刚' : '上次成功是 ' + ago + '前';
}

/** 一行状态：限流 / 失败 / 休市 + 上次成功是什么时候。两副面孔都用它。 */
function statusText() {
  const bits = [];
  if (market.rateLimited) bits.push('被限流');
  else if (market.error) bits.push('取数失败');
  if (market.closed) bits.push(CLOSED_TEXT);
  bits.push(lastOkText());
  return bits.join(' · ');
}
