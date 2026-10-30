// lib/engines.js —— 三家引擎的「一次查询」
//
// 为什么三个引擎放在一个文件里：它们之间只有"怎么问、怎么读结果"两件事不同，重试、超时、
// 归一化都是同一套。分开三个文件只会让"加一家引擎要改几处"变成三处。
//
// 宿主 net.fetch 的硬约束（手册 §6.10）直接决定了每一家的接法：
//
//   · 请求头白名单只有 accept / authorization / content-type / user-agent 四个；
//   · 所以 Bing 的订阅密钥走 `subscription-key` 查询参数（网关原生支持，实测 401 文案
//     证明它参与鉴权），而不是 Ocp-Apim-Subscription-Key 头；
//   · Tavily 的 api_key 放请求体（它的文档两种都收，body 里的那种不占头）；
//   · SearXNG 是自建实例，鉴权（如果有）靠实例自己的 reverse proxy，这里只管 format=json。
//
// 归一化的目标形状（谁调用都拿到这一个形状）：
//   { query, engine, results: [{title, url, snippet}], tookMs }

'use strict';

// 超时预算：三家的"正常"不是一个量级，所以不能共用一个数字。
//
//   · SearXNG 是**自建实例**，一次查询会在它那边并发打十几个引擎，冷缓存时十几秒很常见
//     （用户实测 10 秒以上）。所以给它 25 秒——上面的天花板是宿主的 `plugin.call` 30 秒与
//     `net.fetch` 的 http.Client 30 秒，25 留出余量。原来是 12 秒，正好卡在实测值上，
//     稍慢一点就报"超过 12 秒没有响应"，看起来像实例坏了。
//   · Tavily / Bing 是商业 API，正常几百毫秒；12 秒还没回来基本是网络问题，早点报错更好。
//     所以它们保持 12 秒。
//
// 结果有缓存（`cacheTtlMin`，默认 30 分钟），所以"慢"只在第一次查询上付一次。
const SEARXNG_TIMEOUT_MS = 25000;
const API_TIMEOUT_MS = 12000;
const TAVILY_URL = 'https://api.tavily.com/search';
const BING_URL = 'https://api.bing.microsoft.com/v7.0/search';

/** 引擎能不能用：配置齐不齐。插件页用它说实话，search 也用它给一句能修的原因。 */
function engineStatus() {
  const engine = String(cfg.engine || 'searxng');
  if (engine === 'tavily') {
    const key = String(cfg.tavilyApiKey || '').trim();
    return { engine, ready: Boolean(key), reason: key ? '' : '还没有填 Tavily API Key（在设置里填）' };
  }
  if (engine === 'bing') {
    const key = String(cfg.bingKey || '').trim();
    return { engine, ready: Boolean(key), reason: key ? '' : '还没有填 Bing 订阅密钥（在设置里填）' };
  }
  const base = String(cfg.searxngUrl || '').trim().replace(/\/+$/, '');
  if (!base) return { engine, ready: false, reason: '还没有填 SearXNG 实例地址（在设置里填）' };
  if (!/^https?:\/\//i.test(base)) {
    return { engine, ready: false, reason: 'SearXNG 地址要以 http:// 或 https:// 开头' };
  }
  return { engine, ready: true, reason: '' };
}

/** 带超时的 net.fetch：宿主没有超时参数，用 Promise.race 自己掐。 */
function fetchWithTimeout(url, options, timeoutMs, what) {
  let timer = null;
  const go = request('net.fetch', options).then((out) => {
    if (timer) clearTimeout(timer);
    return out;
  }, (err) => {
    if (timer) clearTimeout(timer);
    throw err;
  });
  const limit = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} 超过 ${Math.round(timeoutMs / 1000)} 秒没有响应`)), timeoutMs);
  });
  return Promise.race([go, limit]);
}

/** 宿主返回的 body 解析成 JSON；解析不出来时把开头几行带给调用方看。 */
function parseJSONBody(out, what) {
  const body = out && typeof out.body === 'string' ? out.body : '';
  try {
    const parsed = JSON.parse(body);
    return parsed;
  } catch {
    const head = text(body.replace(/\s+/g, ' ').trim(), 120);
    throw new Error(`${what} 返回的不是 JSON（HTTP ${out && out.status ? out.status : '?'}）${head ? `：${head}` : ''}`);
  }
}

// --- SearXNG -----------------------------------------------------------------
//
// GET <base>/search?q=…&format=json&language=…&safesearch=1
// 实例必须在 settings.yml 里开 json format（默认关着），403 是最常见的一手症状。

async function searchSearxng(query, count, timeoutMs) {
  const base = String(cfg.searxngUrl || '').trim().replace(/\/+$/, '');
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&language=zh-CN&safesearch=1`;
  const out = await fetchWithTimeout(url, {
    method: 'GET',
    url,
    headers: { accept: 'application/json' },
  }, timeoutMs || SEARXNG_TIMEOUT_MS, 'SearXNG');
  if (out.status === 403) {
    throw new Error('SearXNG 拒绝了 JSON 输出（HTTP 403）：在实例的 settings.yml 里把 search.formats 加上 json');
  }
  if (out.status < 200 || out.status >= 300) {
    throw new Error(`SearXNG 返回 HTTP ${out.status}`);
  }
  const body = parseJSONBody(out, 'SearXNG');
  const rows = Array.isArray(body && body.results) ? body.results : [];
  const results = [];
  for (const row of rows) {
    const item = normalizeRow(row);
    if (item) results.push(item);
    if (results.length >= count) break;
  }
  return results;
}

// --- Tavily ------------------------------------------------------------------
//
// POST https://api.tavily.com/search  {"api_key":"…","query":"…","max_results":N}
// 401 时把原因说清楚：多半是 key 抄错了。

async function searchTavily(query, count, timeoutMs) {
  const key = String(cfg.tavilyApiKey || '').trim();
  const out = await fetchWithTimeout(TAVILY_URL, {
    method: 'POST',
    url: TAVILY_URL,
    body: JSON.stringify({ api_key: key, query, max_results: count, search_depth: 'basic' }),
    headers: { 'content-type': 'application/json', accept: 'application/json' },
  }, timeoutMs || API_TIMEOUT_MS, 'Tavily');
  if (out.status === 401 || out.status === 403) {
    throw new Error('Tavily 拒绝了这个 Key（HTTP ' + out.status + '）：检查 API Key 是否抄全');
  }
  if (out.status === 432 || out.status === 433) {
    throw new Error('Tavily 额度用完了（HTTP ' + out.status + '）');
  }
  if (out.status < 200 || out.status >= 300) {
    throw new Error(`Tavily 返回 HTTP ${out.status}`);
  }
  const body = parseJSONBody(out, 'Tavily');
  const rows = Array.isArray(body && body.results) ? body.results : [];
  const results = [];
  for (const row of rows) {
    const item = normalizeRow(row, row && typeof row.content === 'string' ? row.content : '');
    if (item) results.push(item);
    if (results.length >= count) break;
  }
  return results;
}

// --- Bing --------------------------------------------------------------------
//
// GET /v7.0/search?q=…&mkt=zh-CN&count=N&subscription-key=…
// 密钥走查询参数（见文件头）；响应里的 webPages.value 是结果列表。

async function searchBing(query, count, timeoutMs) {
  const key = String(cfg.bingKey || '').trim();
  const url = `${BING_URL}?q=${encodeURIComponent(query)}&mkt=zh-CN&count=${count}&responseFilter=Webpages&subscription-key=${encodeURIComponent(key)}`;
  const out = await fetchWithTimeout(url, {
    method: 'GET',
    url,
    headers: { accept: 'application/json' },
  }, timeoutMs || API_TIMEOUT_MS, 'Bing');
  if (out.status === 401) {
    throw new Error('Bing 拒绝了这个订阅密钥（HTTP 401）：检查 Key 与资源区域');
  }
  if (out.status === 429) {
    throw new Error('Bing 限流了（HTTP 429）：稍后再试，或升级定价层');
  }
  if (out.status < 200 || out.status >= 300) {
    throw new Error(`Bing 返回 HTTP ${out.status}`);
  }
  const body = parseJSONBody(out, 'Bing');
  const pages = body && body.webPages && Array.isArray(body.webPages.value) ? body.webPages.value : [];
  const results = [];
  for (const row of pages) {
    const item = normalizeRow(row, row && typeof row.snippet === 'string' ? row.snippet : '');
    if (item) results.push(item);
    if (results.length >= count) break;
  }
  return results;
}

// --- 归一化 --------------------------------------------------------------------

/** 一行引擎结果 → {title,url,snippet}；没有 url 或 title 的行直接丢掉。 */
function normalizeRow(row, fallbackSnippet) {
  if (!row || typeof row !== 'object') return null;
  // Bing 的结果标题叫 name，SearXNG/Tavily 叫 title。
  const title = text(row.title !== undefined ? row.title : row.name, 200).trim();
  const url = text(row.url || row.link, 500).trim();
  if (!title || !url || !/^https?:\/\//i.test(url)) return null;
  const rawSnippet = typeof fallbackSnippet === 'string' && fallbackSnippet
    ? fallbackSnippet
    : (typeof row.content === 'string' ? row.content : (typeof row.snippet === 'string' ? row.snippet : ''));
  // 摘要去掉换行与多余空白：它要进 prompt，多行会撑爆行数。
  const snippet = text(rawSnippet.replace(/\s+/g, ' ').trim(), 300);
  return { title, url, snippet };
}

/** 一次查询，按当前设置选引擎。失败抛出的错误都是「能拿去修」的那句中文。 */
/**
 * `timeoutMs` 可选：调用方（比如记忆核心）要在一句话里凑出"搜索 + 两轮模型"，而宿主 `plugin.call`
 * 只有 30 秒——它能给的预算比本插件的默认 25 秒小得多。不给就按各引擎的默认值。
 */
async function runEngine(query, count, timeoutMs) {
  const status = engineStatus();
  if (!status.ready) throw new Error(status.reason);
  const started = now();
  let results;
  if (status.engine === 'tavily') results = await searchTavily(query, count, timeoutMs);
  else if (status.engine === 'bing') results = await searchBing(query, count, timeoutMs);
  else results = await searchSearxng(query, count, timeoutMs);
  return { results, tookMs: now() - started };
}
