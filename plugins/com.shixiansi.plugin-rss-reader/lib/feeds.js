// lib/feeds.js —— 订阅源的抓取、去重与状态
//
// 一份订阅源在 storage 里是两半：
//
//   feeds/list    [{url, title, addedAt, lastFetchedAt, lastStatus, lastError, itemCount}]
//   feeds/seen    { "<url>\n<itemLink|itemTitle>": publishedAt }   已见过的条目（去重）
//
// seen 用"地址 + 条目标识"做键：不同源的同一条转载不算重；标识优先用 link（稳定），
// 没有 link 的源退化用 title。值是首次见到的时间——"新"的判定是**本插件记不记得它**，
// 不是 published 时间（源的时间戳经常撒谎）。

'use strict';

const KEY_LIST = 'feeds/list';
const KEY_SEEN = 'feeds/seen';
const KEY_DIGEST = 'digest/last';
const KEY_HISTORY = 'digest/history';
const HISTORY_CAP = 50;

/** 订阅源入参清洗：http(s)、≤300 字、一行一个。 */
function cleanFeedUrl(value) {
  const url = String(value || '').trim();
  if (!url) throw new Error('订阅地址是空的');
  if (url.length > 300) throw new Error('订阅地址太长（≤300 字）');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`订阅地址不是合法的 URL：${text(url, 60)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('订阅地址必须是 http(s)');
  }
  return parsed.href;
}

/** 用户配置里的源列表（每行一个 → 去重、清洗）。 */
function configuredFeeds() {
  const raw = String(cfg.feedUrls || '');
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const url = line.trim();
    if (!url) continue;
    try {
      out.push(cleanFeedUrl(url));
    } catch {
      // 单行坏了不拖累整份配置：跳过，加源的时候界面会讲清楚。
    }
  }
  return [...new Set(out)];
}

async function loadFeedList() {
  const list = await readJSON(KEY_LIST, []);
  return Array.isArray(list) ? list : [];
}

async function saveFeedList(list) {
  await writeJSON(KEY_LIST, list);
}

async function loadSeen() {
  const seen = await readJSON(KEY_SEEN, {});
  return seen && typeof seen === 'object' ? seen : {};
}

async function saveSeen(seen) {
  // seen 只增不减会无界膨胀：保留最近的 5000 条（按时间截尾）。
  const entries = Object.entries(seen).sort((a, b) => (a[1] || 0) - (b[1] || 0));
  const trimmed = entries.slice(-5000);
  await writeJSON(KEY_SEEN, Object.fromEntries(trimmed));
}

function seenKey(feedUrl, item) {
  return `${feedUrl}\n${item.link || item.title || ''}`;
}

/** 抓一个源（net.fetch → parseFeed），失败抛"能拿去修"的中文。 */
async function fetchOne(feedUrl, timeoutSec) {
  const budget = clampInt(timeoutSec, 10, 120, 30);
  const out = await request('net.fetch', { url: feedUrl, method: 'GET' });
  const raw = out && typeof out.body === 'string' ? out.body : '';
  if (out && out.truncated) throw new Error(`源内容超过 8 MiB 被截断：${text(feedUrl, 80)}`);
  const parsed = parseFeed(raw);
  if (!parsed.kind) throw new Error(`这不是一份能认出的 RSS/Atom：${text(feedUrl, 80)}`);
  if (budget && !raw) throw new Error(`源返回了空内容：${text(feedUrl, 80)}`);
  return parsed;
}

/** 把一份源与 seen 对账：返回这份源里**没见过**的条目（已顺手记入 seen）。 */
function pickNew(parsed, feedUrl, seen, at) {
  const fresh = [];
  for (const item of parsed.items) {
    const key = seenKey(feedUrl, item);
    if (seen[key]) continue;
    seen[key] = at;
    fresh.push(item);
  }
  return fresh;
}

/** 抓一份源并记账（列表状态 + seen）。返回新条目数组；错误记录在列表里并抛给调用方。 */
async function fetchAndRecord(feedUrl, { markSeen = true } = {}) {
  const at = now();
  const list = await loadFeedList();
  const entry = list.find((f) => f.url === feedUrl)
    || { url: feedUrl, title: '', addedAt: at };
  try {
    const parsed = await fetchOne(feedUrl, num('timeoutSec', 10, 120, 30));
    const seen = await loadSeen();
    const fresh = markSeen ? pickNew(parsed, feedUrl, seen, at) : [];
    if (markSeen) await saveSeen(seen);
    entry.title = parsed.title || entry.title;
    entry.itemCount = parsed.items.length;
    entry.lastFetchedAt = at;
    entry.lastStatus = 'ok';
    entry.lastError = '';
    const next = list.filter((f) => f.url !== feedUrl).concat(entry);
    await saveFeedList(next);
    return { parsed, fresh };
  } catch (err) {
    entry.lastFetchedAt = at;
    entry.lastStatus = 'error';
    entry.lastError = text(err && err.message ? err.message : err, 200);
    const next = list.filter((f) => f.url !== feedUrl).concat(entry);
    await saveFeedList(next);
    throw err;
  }
}

/** 最近一次晨报（面板显示用）。 */
async function loadLastDigest() {
  const digest = await readJSON(KEY_DIGEST, null);
  return digest && typeof digest === 'object' ? digest : null;
}

async function saveLastDigest(digest) {
  await writeJSON(KEY_DIGEST, digest);
  const history = await readJSON(KEY_HISTORY, []);
  const next = (Array.isArray(history) ? history : []).concat([{ at: digest.at, headline: text(digest.headline, 160) }]).slice(-HISTORY_CAP);
  await writeJSON(KEY_HISTORY, next);
}

/** plugin.call 的 fetch_now：立刻抓全部源并生成晨报（面板按钮与别的插件走同一条）。 */
async function handleFetchNow() {
  await refreshConfig();
  const result = await runDigestCycle();
  return {
    at: result.at,
    freshCount: result.freshCount,
    feeds: result.feeds.map((f) => ({ url: f.url, status: f.status, fresh: f.fresh, error: f.error || '' })),
    headline: result.headline,
    spoken: Boolean(result.spoken),
  };
}
