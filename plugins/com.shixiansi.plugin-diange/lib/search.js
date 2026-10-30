// lib/search.js —— plugin.call 的两个方法：`song` 与 `song_link`
//
// 两个方法名，一件事的两种说法：
//
//   song        "把这句话变成一首歌"（用户说的往往是一句人话：点歌 晴天 周杰伦 / 来首周杰伦的老歌）
//   song_link   "我知道是哪首，给我一条链接"（调用方已经有歌名与歌手，只要 url）
//
// 为什么值得分成两个而不是一个：`song_link` 的入参是**结构化的**（song + singer），所以它能
// 精确地要"周杰伦的晴天"而不是"包含晴天两个字的什么东西"；而 `song` 的入参是一句话，
// 它得猜。语义不同就分两个入口——把两种意图塞进一个通道，调用方最后一定会给错字段。
//
// 名字里没有 `search`：那是「网页搜索」的能力名（联网搜索、B 站插件都答它），而记忆核心按
// 能力名发现提供方。一个叫 search 的点歌插件会让"搜一下今天天气"被问成"没找到这首歌"。
//
// 返回形状（谁调用都拿到这一个形状）：
//   { query, provider:"kuwo", count, tookMs, text, results:[song], cached }
//   song = { title, singer, album, url, cover, bitrate, format, size, durationSec, probe, br }
//
// `text` 是给**模型**读的（记忆核心会拼进 system），`results` 是给**代码**读的。

'use strict';

const CACHE_DIR = 'cache/song';
const HISTORY_KEY = 'history/recent';
/** 历史表的总条数上限（设置里的 maxHistory 只能更小）。 */
const HISTORY_CAP = 200;

/** FNV-1a：给中文查询算一个合法的存储段（键的每一段只允许 [A-Za-z0-9_-]，长度 ≤64）。 */
function hashKey(input) {
  let hash = 0x811c9dc5;
  const body = String(input || '');
  for (let i = 0; i < body.length; i += 1) {
    hash ^= body.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

/**
 * 入参清洗。
 *
 * `singer` 会拼到 query 后面（接口不吃"歌手"这个独立参数，它只吃一句话），除非那句话里
 * 已经带着它——重复一遍会让"晴天 周杰伦 周杰伦"这种查询词变长，命中率反而下降。
 */
function cleanSongPayload(payload, { requireQuery = true } = {}) {
  const raw = text((payload && (payload.query || payload.song)) || '', 200).trim();
  if (requireQuery && !raw) {
    throw new Error('需要 query（或 song）：歌名，最好带上歌手，例如「晴天 周杰伦」');
  }
  const singer = text(payload && payload.singer, 80).trim();
  const query = singer && !raw.includes(singer) ? `${raw} ${singer}`.trim() : raw;
  // 没给预算就**不传**（undefined），不传 0：0 会被下游夹到下限，等于"只给 2 秒"，
  // 而那个预算连一次搜索都不够开——症状是"点歌什么都不查就说没找到"。
  const timeoutMs = payload && payload.timeoutMs ? clampInt(payload.timeoutMs, 1000, 28000, 0) || undefined : undefined;
  const br = payload && payload.br ? clampInt(payload.br, 1, 4096, 0) : 0;
  const fresh = Boolean(payload && payload.fresh);
  return { query, singer, timeoutMs, br, fresh };
}

// --- 缓存 ---------------------------------------------------------------------
//
// 为什么按查询缓存而不是只留"上一条"：群里一晚上会点好几首，而且"点歌 X"重复出现得比
// 想象中频繁。TTL 默认 15 分钟——直链带签名，放一整天就失效了，缓存太久的"成功"是最糟的
// 那种结果（它看起来没问题）。

async function readCache(query) {
  const ttlMin = num('cacheTtlMin', 0, 1440, 15);
  if (ttlMin <= 0) return null;
  const hit = await readJSON(`${CACHE_DIR}/${hashKey(query)}`, null);
  if (!hit || hit.query !== query || !hit.song) return null;
  const age = now() - (Number(hit.at) || 0);
  if (!Number.isFinite(age) || age < 0 || age > ttlMin * 60000) return null;
  return hit;
}

async function writeCache(query, song) {
  if (num('cacheTtlMin', 0, 1440, 15) <= 0) return;
  try {
    await writeJSON(`${CACHE_DIR}/${hashKey(query)}`, { query, song, at: now() });
  } catch {
    // 写不进去不算失败：下一次多问一次接口而已。
  }
}

// --- 历史（插件页的"最近点过"）--------------------------------------------------

async function appendHistory(entry) {
  const keep = num('maxHistory', 0, 200, 30);
  if (keep <= 0) return;
  try {
    const list = await readJSON(HISTORY_KEY, []);
    const next = (Array.isArray(list) ? list : [])
      .concat([entry])
      .slice(-Math.max(HISTORY_CAP, keep));
    await writeJSON(HISTORY_KEY, next.slice(-keep));
  } catch {
    // 历史是给人看的，写不进去不影响点歌本身。
  }
}

async function loadHistory() {
  const list = await readJSON(HISTORY_KEY, []);
  return Array.isArray(list) ? list : [];
}

async function clearHistory() {
  await request('storage.remove', { key: HISTORY_KEY });
}

// --- `song` -----------------------------------------------------------------

/**
 * 把一句话解析成一首歌。
 *
 * 找不到**不是错误**：返回 count:0 与一句实话（`text`），让调用方（记忆核心）如实回答
 * "没找到这首歌"。抛错的只有"这次请求本身没法完成"（网络、HTTP、参数缺失）——两种情况
 * 调用方的处理完全不同，混在一起就永远分不清"没有这首歌"和"网断了"。
 */
async function handleSong(payload) {
  const { query, timeoutMs, br, fresh } = cleanSongPayload(payload);
  await refreshConfig();

  if (!fresh) {
    const cached = await readCache(query);
    if (cached) {
      return {
        query,
        provider: 'kuwo',
        count: 1,
        tookMs: 0,
        text: renderSongText(cached.song),
        results: [cached.song],
        cached: true,
      };
    }
  }

  const { song, tried, tookMs } = await resolveSong({ query, br, timeoutMs });
  if (!song) {
    void appendHistory({ at: now(), query, title: '', singer: '', ok: false, tookMs });
    return { query, provider: 'kuwo', count: 0, tookMs, text: renderNotFound(query), results: [], tried };
  }

  await writeCache(query, song);
  void appendHistory({
    at: now(),
    query,
    title: song.title,
    singer: song.singer,
    ok: true,
    tookMs,
    probe: song.probe ? song.probe.checked && song.probe.ok : false,
  });

  return {
    query,
    provider: 'kuwo',
    count: 1,
    tookMs,
    text: renderSongText(song),
    results: [song],
    tried,
  };
}

// --- `song_link` -------------------------------------------------------------------

/**
 * 已知歌名（+ 歌手）→ 一条直链。
 *
 * 与 song 的三点差别：
 *   · 入参是结构化的（song / singer），不猜；
 *   · 默认**绕过缓存**（`fresh: false` 时才用）——要链接的人往往正是因为"上一条失效了"；
 *   · 返回把 url 提到顶层，调用方不必再翻 results[0]。
 */
async function handleSongLink(payload) {
  const { query, timeoutMs, br } = cleanSongPayload(payload);
  const fresh = payload && payload.fresh !== undefined ? Boolean(payload.fresh) : true;
  const out = await handleSong({ query, br, timeoutMs, fresh });
  const song = out.results[0] || null;
  if (!song) {
    return {
      query: out.query,
      provider: 'kuwo',
      url: '',
      title: '',
      singer: '',
      album: '',
      cover: '',
      probe: { checked: false, reason: 'not-found' },
      text: out.text,
      tookMs: out.tookMs,
      cached: Boolean(out.cached),
    };
  }
  return {
    query: out.query,
    provider: 'kuwo',
    url: song.url,
    title: song.title,
    singer: song.singer,
    album: song.album,
    cover: song.cover,
    bitrate: song.bitrate,
    format: song.format,
    size: song.size,
    durationSec: song.durationSec,
    probe: song.probe,
    // 给"要不要重试一次"用：false 表示验过但播不通，null/undefined 表示没验。
    verified: song.probe && song.probe.checked ? Boolean(song.probe.ok) : null,
    text: out.text,
    tookMs: out.tookMs,
    cached: Boolean(out.cached),
  };
}
