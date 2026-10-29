// lib/search.js —— search 方法、缓存、历史
//
// plugin.call 的 `search`：别的插件（记忆核心）用它把「先查再答」的那一步交给这里。
// 返回形状是给**模型读**的，不是给人看的：紧凑的块状文本 + 机读的两样计数。
//
// WHY 结果文本而不是 JSON：memcore 把它拼进 prompt（≤4000 字的 system），JSON 的括号
// 和引号花的是同一个预算，换不来任何东西。

'use strict';

const CACHE_KEY = 'cache/results';
const HISTORY_KEY = 'history/recent';
const HISTORY_CAP = 200;

/** search 的入参清洗：query 必填；count 上限 10（再多 prompt 也吃不下）。 */
function cleanSearchPayload(payload) {
  const query = text(payload && payload.query, 300).trim();
  if (!query) throw new Error('search 需要 query：要查的那句话');
  const count = clampInt(payload && payload.count, 1, 10, num('resultCount', 1, 10, 5));
  return { query, count };
}

/** 同一个查询在 TTL 内直接用上一次的结果：省钱、省次数，也省那 12 秒。 */
async function readCache(query) {
  const ttlMin = num('cacheTtlMin', 0, 1440, 30);
  if (ttlMin <= 0) return null;
  const cache = await readJSON(CACHE_KEY, null);
  if (!cache || cache.query !== query || !Array.isArray(cache.results)) return null;
  const age = now() - (Number(cache.at) || 0);
  if (!Number.isFinite(age) || age < 0 || age > ttlMin * 60000) return null;
  return cache;
}

async function writeCache(query, results) {
  const ttlMin = num('cacheTtlMin', 0, 1440, 30);
  if (ttlMin <= 0) return;
  try {
    await writeJSON(CACHE_KEY, { query, results, at: now() });
  } catch {
    // 缓存写不进去不算失败：下一次多等一次网络而已。
  }
}

/** 记一条历史（插件页的「最近查过」）。记录关闭（maxHistory=0）时不写。 */
async function appendHistory(query, engine, count, tookMs) {
  const keep = num('maxHistory', 0, 200, 50);
  if (keep <= 0) return;
  try {
    const list = await readJSON(HISTORY_KEY, []);
    const next = (Array.isArray(list) ? list : [])
      .concat([{ at: now(), query: text(query, 120), engine, count, tookMs }])
      .slice(-Math.max(HISTORY_CAP, keep));
    await writeJSON(HISTORY_KEY, next.slice(-keep));
  } catch {
    // 历史是给人看的，写不进去不影响搜索本身。
  }
}

/** 结果数组 → 给模型读的紧凑文本块。空结果有自己的一句话，让调用方好判断。 */
function renderResults(query, engine, results, tookMs) {
  if (!results.length) {
    return `没有搜到「${query}」相关的结果。`;
  }
  const lines = [`「${query}」的网页搜索结果（${engine}，${results.length} 条，${Math.max(1, Math.round(tookMs / 1000))} 秒内）：`];
  results.forEach((item, index) => {
    lines.push(`[${index + 1}] ${item.title}`);
    lines.push(`    ${item.url}`);
    if (item.snippet) lines.push(`    ${item.snippet}`);
  });
  return lines.join('\n');
}

/**
 * `search` 方法本体。
 *
 * @param {object} payload {query, count?}
 * @returns {Promise<object>} {query, engine, count, tookMs, text, results}
 */
async function handleSearch(payload) {
  const { query, count } = cleanSearchPayload(payload);
  await refreshConfig();

  const cached = await readCache(query);
  if (cached) {
    const body = renderResults(query, cached.engine || cfg.engine || 'searxng', cached.results, 0);
    return { query, engine: cached.engine || 'cache', count: cached.results.length, tookMs: 0, text: body, results: cached.results, cached: true };
  }

  const status = engineStatus();
  if (!status.ready) throw new Error(status.reason);

  const { results, tookMs } = await runEngine(query, count);
  await writeCache(query, results);
  void appendHistory(query, status.engine, results.length, tookMs);

  return {
    query,
    engine: status.engine,
    count: results.length,
    tookMs,
    text: renderResults(query, status.engine, results, tookMs),
    results,
  };
}

async function clearHistory() {
  await request('storage.remove', { key: HISTORY_KEY });
}

async function loadHistory() {
  const list = await readJSON(HISTORY_KEY, []);
  return Array.isArray(list) ? list : [];
}
