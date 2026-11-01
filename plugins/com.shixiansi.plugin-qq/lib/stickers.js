// lib/stickers.js —— 发表情与自动收藏
//
// 候选里挑一张发出去、群图收藏、残图补标记与历史找回。
//
// 从原来的 app.js 按节**原样搬出来**（1.12 的重构）：内容逐字未改，只是换了个文件。
// 经典 script 共享同一个全局作用域，所以这里不用 import/export；
// 加载顺序写在 panel.html 里（顺序 = 原来的文件顺序，所以原有的依赖关系不变）。
'use strict';

// --- 从导入的图库里挑一张发出去 ------------------------------------------------

/**
 * The MIME type of a base64 image, sniffed from its first bytes.
 *
 * Needed because the importer stored BYTES: net.fetch returns a base64 body with no
 * content-type, and `data:` URIs must carry one. A GIF announced as image/png is
 * rejected by some protocol sides and silently broken by others.
 */
function stickerMime(base64) {
  const head = String(base64 || '').slice(0, 16);
  if (head.startsWith('iVBORw0KGgo')) return 'image/png';
  if (head.startsWith('/9j/')) return 'image/jpeg';
  if (head.startsWith('R0lGOD')) return 'image/gif';
  if (head.startsWith('UklGR')) return 'image/webp';
  return 'image/png';
}

/**
 * Picks a sticker for this mood: the imported library first, the URL list as fallback.
 *
 * Matching is by category only, and a mood with no stickers yields NOTHING rather than
 * a random unrelated picture - a "无语" reply illustrated with someone's celebratory
 * gif is worse than no sticker at all.
 */
async function pickStickerForTag(tag, urlLibrary, rows) {
  try {
    const index = Array.isArray(rows) ? rows : await loadStickerIndex();
    const matches = index.filter((row) => row && row.tag === tag);
    if (matches.length) {
      // 优先挑用得少的：一屋子图库里总有几张被反复发，剩下的永远见不到。
      const fresh = matches.filter((row) => (Number(row.usageCount) || 0) === 0);
      const pool = fresh.length ? fresh : matches;
      const row = pool[Math.floor(Math.random() * pool.length)];
      const base64 = await readKeyText(stickerBytesKey(row.hash));
      if (base64) {
        // Yogurt rejects the `data:` scheme outright ("Unsupported URI scheme"), so the
        // bytes go out as a OneBot-style `base64://` payload instead.
        return { uri: `base64://${base64}`, kind: 'library', hash: row.hash, tag: row.tag };
      }
    }
  } catch (err) {
    note(`读取图库失败：${(err && err.message) || err}`);
  }
  if (urlLibrary && urlLibrary.length) {
    return { uri: urlLibrary[Math.floor(Math.random() * urlLibrary.length)], kind: 'url' };
  }
  return null;
}

/** 按 id 取一张图库里的表情。不存在（或字节丢了）就返回 null，绝不用错图。 */
async function stickerByID(rows, hash) {
  const id = cleanSegment(hash);
  if (!id) return null;
  const row = (Array.isArray(rows) ? rows : []).find((item) => item && item.hash === id);
  if (!row) return null;
  try {
    const base64 = await readKeyText(stickerBytesKey(id));
    if (!base64) {
      note(`图库里的 ${id} 没有字节，跳过`);
      return null;
    }
    return { uri: `base64://${base64}`, kind: 'library', hash: id, tag: row.tag || '' };
  } catch (err) {
    note(`读取表情 ${id} 失败：${(err && err.message) || err}`);
    return null;
  }
}

/** Sends the updated usage counter back, so "pick a fresh one" actually rotates. */
async function bumpStickerUsage(rows, hash) {  if (!Array.isArray(rows)) return;
  let touched = false;
  const out = rows.map((row) => {
    if (!row || row.hash !== hash) return row;
    touched = true;
    return { ...row, usageCount: (Number(row.usageCount) || 0) + 1, lastUsedAt: Date.now() };
  });
  if (!touched) return;
  try {
    await request('storage.set', { key: DATA.stickerIndex, value: JSON.stringify(out) });
  } catch (err) {
    note(`表情使用计数没写回去：${(err && err.message) || err}`);
  }
}

/** 字符二元组：没有分词器时的通用近似（中文两字一个词，够用来算重合度）。 */
function bigrams(text) {
  const clean = String(text || '').replace(/[\s\p{P}\p{S}]/gu, '');
  const chars = Array.from(clean);
  const out = new Set();
  for (let i = 0; i + 1 < chars.length; i += 1) out.add(chars[i] + chars[i + 1]);
  return out;
}

/**
 * 给模型挑的候选表情。
 *
 * 317 张全塞进 prompt 要 ~4K token/次，所以只给它最多 `stickerCandidateMax` 条。挑法是
 * "和这句话字面重合度高的优先，其次用得少的优先"——不是随机，也不是全量。
 *
 * 为什么不让模型先要一个情绪再挑：那需要第二次调用（钱翻倍），而它看一眼候选就知道
 * 该挑哪张；实在都不合适，`meme` 留空就行。
 */
function pickStickerCandidates(index, text, max) {
  const rows = (Array.isArray(index) ? index : []).filter((row) => row && row.hash);
  if (!rows.length) return [];
  const cap = Math.max(1, Math.min(24, number(max !== undefined ? max : state.cfg.stickerCandidateMax, 12, 1, 24)));
  const query = bigrams(text);
  const scored = rows.map((row) => {
    const hay = bigrams(`${row.tag || ''} ${row.description || ''} ${(row.keywords || []).join(' ')}`);
    let score = 0;
    for (const gram of query) if (hay.has(gram)) score += 1;
    return { row, score, usage: Number(row.usageCount) || 0 };
  });
  scored.sort((a, b) => (b.score - a.score) || (a.usage - b.usage));
  return scored.slice(0, cap).map((item) => ({
    hash: item.row.hash,
    tag: item.row.tag || '',
    description: String(item.row.description || '').slice(0, 24),
  }));
}

// --- 自动收藏：群里的图 → 描述 → 候选 → 模型决定收不收 --------------------------
//
// 参考项目（aigf）的做法：图先被识图模型描述，下一次回复时模型看到"候选表情"，由它决定
// 收藏哪张。我们照抄这个分工，但把"决定"压进同一次调用（尾部的 `save_meme`），因为平台
// 不支持 function calling，多一轮调用就是翻倍的钱。
//
// 三条自我约束，都是钱：
//   · 每个群每小时最多描述 COLLECT_PER_HOUR 张（一张图一次识图请求）；
//   · 待收藏区最多 10 张，超了丢最旧的；
//   · 太大的图（base64 超过 COLLECT_MAX_BASE64）直接跳过，因为要整段塞进 storage 和
//     postMessage，一张 8 MiB 的图会让这一步比回复本身还慢。

const COLLECT_PENDING_INDEX = 'media/stickers/pending-index';
const COLLECT_PENDING_DIR = 'media/stickers/pending';
const COLLECT_PENDING_MAX = 10;
const COLLECT_PER_HOUR = 3;
const COLLECT_MAX_BASE64 = 6_000_000;

/** 待收藏区的索引：`[{hash, tag, description, at}]`。 */
async function loadPending() {
  const raw = await readKeyText(COLLECT_PENDING_INDEX);
  let parsed = null;
  try {
    parsed = JSON.parse(raw || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((row) => row && row.hash)
    .map((row) => ({
      hash: String(row.hash),
      tag: String(row.tag || ''),
      description: String(row.description || '').slice(0, 24),
      at: Number(row.at) || 0,
    }));
}

async function savePending(rows) {
  await writeJSON(COLLECT_PENDING_INDEX, rows.slice(-COLLECT_PENDING_MAX));
}

/** 每群每小时的限速：自动收藏是唯一会为"别人发的图"花 VLM 钱的地方。 */
function collectAllowed(groupID) {
  const now = Date.now();
  const log = (state.collectLog.get(groupID) || []).filter((at) => now - at < 3_600_000);
  if (log.length >= COLLECT_PER_HOUR) {
    state.collectLog.set(groupID, log);
    return false;
  }
  log.push(now);
  state.collectLog.set(groupID, log);
  return true;
}

/**
 * 群消息里的图片：下载 → 识图 → 进"待收藏"。
 *
 * 不在这里决定收不收（那是模型的事，而且它眼下还不知道这张图是什么）。下载与识图放在
 * 收到消息的当下，是为了让"下次说话"那一刻手里已经有描述——否则要么等（用户看到延迟），
 * 要么把识图也塞进回复那一轮（多一次串行请求）。
 */
async function collectFromSegments(groupID, segments, selfID) {
  if (!flag(state.cfg.autoCollectStickers, true)) return 0;
  if (!granted.has('storage') || !granted.has('net.fetch')) return 0;
  // 没有识图模型就不收藏：没有描述的表情包对模型来说只是一串 hash，收进来也用不上。
  if (!String(state.cfg.visionModel || '').trim()) return 0;
  const urls = [];
  for (const seg of segments || []) {
    if (!seg || seg.type !== 'image' || !seg.data) continue;
    const url = String(seg.data.temp_url || seg.data.url || '');
    if (!url || !/^https?:\/\//i.test(url)) continue;
    urls.push(url);
    if (urls.length >= 2) break;
  }
  if (!urls.length) return 0;
  if (!collectAllowed(groupID)) {
    note(`群 ${groupID}：这一小时已经存过 ${COLLECT_PER_HOUR} 张图了，先不存`);
    return 0;
  }
  const index = await loadStickerIndex();
  const known = new Set(index.map((row) => row && row.hash));
  const pending = await loadPending();
  for (const row of pending) known.add(row.hash);
  // 待收藏区满了就不再识图。
  //
  // 这一条是真机数据逼出来的：满了之后原来的实现照样下载 + 识图，再把最旧的挤掉，
  // 于是每群每小时白花 3 次识图、图库一张没进（318 行里 collected 一直是 0）。
  // 花钱之前先看一眼有没有地方放。
  if (pending.length >= COLLECT_PENDING_MAX) {
    const now = Date.now();
    if (now - (state.collectFullAt.get(String(groupID)) || 0) > 30 * 60_000) {
      state.collectFullAt.set(String(groupID), now);
      note(`群 ${groupID}：待收藏区已经满了（${COLLECT_PENDING_MAX} 张），这张先不识别——去工坊的「待收藏」里收掉或丢掉几张`);
    }
    return 0;
  }
  let added = 0;
  for (const url of urls) {
    try {
      const fetched = await request('net.fetch', { url, encoding: 'base64' });
      const base64 = String((fetched && fetched.body) || '');
      if (!base64) continue;
      if (fetched && fetched.truncated) {
        note(`群 ${groupID}：这张图超过宿主单次下载上限被截断了，没有收藏`);
        continue;
      }
      if (base64.length > COLLECT_MAX_BASE64) {
        note(`群 ${groupID}：这张图太大（${Math.round(base64.length / 1024)} KB base64），没有收藏`);
        continue;
      }
      const hash = hashOf(base64);
      if (known.has(hash)) continue;
      const { tag, description } = await classifySticker(url);
      if (!tag) continue;
      await request('storage.set', { key: `${COLLECT_PENDING_DIR}/${hash}`, value: base64 });
      pending.push({ hash, tag, description, at: Date.now() });
      known.add(hash);
      added += 1;
      note(`群 ${groupID}：存了一张候选表情（${tag}），下次说话时决定收不收`);
    } catch (err) {
      note(`收藏候选失败：${(err && err.message) || err}`);
    }
  }
  if (added) await savePending(pending);
  return added;
}

/**
 * 把一张候选搬进图库：写字节、进索引、从待收藏里删掉。
 *
 * 只有模型明确说要收（`save_meme`）才会走到这里——"看见什么就存什么"会在一周内把图库
 * 塞满无关的截图。
 */
async function saveCollectedSticker(hash) {
  const id = cleanSegment(hash);
  if (!id) return false;
  const pending = await loadPending();
  const row = pending.find((item) => item.hash === id);
  if (!row) return false;
  const base64 = await readKeyText(`${COLLECT_PENDING_DIR}/${id}`);
  if (!base64) return false;
  await request('storage.set', { key: stickerBytesKey(id), value: base64 });
  const index = await loadStickerIndex();
  if (!index.some((item) => item && item.hash === id)) {
    index.push({
      hash: id,
      tag: row.tag,
      description: row.description,
      collected: true,
      usageCount: 0,
      lastUsedAt: 0,
      at: Date.now(),
    });
  }
  // 写进索引就完事——**不做任何"顺手修剪"**。这里曾经是 `pruneCollected(index)`，
  // 也就是说用户点了一次"收进图库"，插件会顺手把另外几张按"用得少"删掉。
  // 用户的决定只该影响用户指的那一张。
  await writeStickerIndex(index);
  await savePending(pending.filter((item) => item.hash !== id));
  try {
    await request('storage.remove', { key: `${COLLECT_PENDING_DIR}/${id}` });
  } catch {
    // 删不掉只是占一点空间，下次覆盖同一张时会写回同一个键。
  }
  return true;
}

/** Writes the whole sticker index back. One key, so it is one write. */
async function writeStickerIndex(rows) {
  try {
    await request('storage.set', { key: DATA.stickerIndex, value: JSON.stringify(rows) });
    return true;
  } catch (err) {
    note(`表情索引写入失败：${(err && err.message) || err}`);
    return false;
  }
}

/**
 * 1 MiB 的 base64 正好是 1,398,104 个字符。
 *
 * 旧宿主的上限就是 1 MiB，而它是**静默**截断的：那批准好等于这个长度的图，就是被切过的。
 * 用它当"残图"的判据，比"猜文件名/大小"都可靠——多一个字节的图不会出现这个长度。
 */
const LEGACY_TRUNCATED_BASE64 = 1398104;

/**
 * 一张图的"指纹"：只看前 64K 个 base64 字符。
 *
 * 为什么不整串：残图是被截断的**前缀**，同一张图的完整版与前缀版整串不同、前缀相同。
 * 64K 个字符（≈48 KB 图像）足够把两张表情包区分开，又远小于任何被截断的位置
 * （1 MiB 处才切）。
 */
const STICKER_SIGNATURE_CHARS = 65536;

function stickerSignature(base64) {
  return hashOf(String(base64 || '').slice(0, STICKER_SIGNATURE_CHARS));
}

/** 一个消息段里的图片地址（历史消息里的字段名叫 temp_url / url / file 的都有）。 */
function imageSegUrls(segments) {
  const out = [];
  for (const seg of segments || []) {
    if (!seg || seg.type !== 'image' || !seg.data) continue;
    const url = String(seg.data.temp_url || seg.data.url || seg.data.file || '');
    if (/^https?:\/\//i.test(url)) out.push(url);
  }
  return out;
}

/**
 * "残图指纹 → 索引行" 的表；没有 `sig` 的现算一次（读一遍那张 1.4 MB 的字节），
 * 算完写进 `row.sig`，下次导入就不用再读了。
 *
 * 这张表就是"重新发一遍旧表情包时不用重新识图"的全部依据：同一张图的完整版与前缀版
 * 前 48 KB 相同，所以一比就知道"这不是新图，是把那张残图补齐了"。
 */
async function truncatedSignatureMap(index) {
  const map = new Map();
  for (const row of index) {
    if (!row || !row.truncated) continue;
    let sig = String(row.sig || '');
    if (!sig) {
      try {
        const base64 = await readKeyText(stickerBytesKey(row.hash));
        if (!base64) continue;
        sig = stickerSignature(base64);
        row.sig = sig;
      } catch {
        continue;
      }
    }
    map.set(sig, row);
  }
  return map;
}

/**
 * 去群历史里把"完整的同一张图"捞回来，替换掉被截断的残图。
 *
 * WHY：残图缺的是**数据**，不是描述——重新识图只会再描述一遍那半张，救不回来。唯一能补的
 * 办法是拿到原始字节，而用户手上往往已经没有原件。协议端一般留着群历史，历史里的图还能
 * 取到新的临时地址，所以这件事可以让程序自己干：
 *
 *   1. 把每张残图的前 64K 字符算成指纹（"这是同一张图"的判据）；
 *   2. 逐个群翻历史，收集图片地址；
 *   3. 逐张下载、算指纹、命中就写回**同一个 key**（hash 不变，索引行不用重建），清掉标记。
 *
 * 全程**不调识图**（标签和描述早就有），只花下载。历史接口的名字各家不同，所以按几个常见
 * 名字挨个试；都不可用时如实说"这个协议端没提供历史"，而不是假装找过。
 */
async function recoverTruncatedStickers() {
  const report = { broken: 0, groups: 0, images: 0, matched: 0, history: true };
  if (!granted.has('storage')) return report;
  const index = await loadStickerIndex();
  const broken = index.filter((row) => row && row.truncated);
  report.broken = broken.length;
  if (!broken.length) return report;

  // 指纹表：一张残图 1.4 MB，156 张就是 220 MB 的读——只读一遍，之后只比指纹。
  const bySignature = new Map();
  let done = 0;
  let sigAdded = 0;
  for (const row of broken) {
    done += 1;
    if (els.stickerStatus) {
      els.stickerStatus.hidden = false;
      els.stickerStatus.dataset.tone = 'info';
      els.stickerStatus.textContent = `正在读取残图 ${done}/${broken.length}…`;
    }
    try {
      let sig = String(row.sig || '');
      if (!sig) {
        const base64 = await readKeyText(stickerBytesKey(row.hash));
        if (!base64) continue;
        sig = stickerSignature(base64);
        row.sig = sig;
        sigAdded += 1;
      }
      bySignature.set(sig, row.hash);
    } catch {
      // 读不出来就跳过这一张，不影响别的
    }
  }
  if (!bySignature.size) return report;

  const fixed = new Set();
  const groups = [...state.groups.keys()];
  for (const groupID of groups) {
    if (fixed.size >= bySignature.size) break;
    const urls = await historyImageUrls(groupID);
    if (urls === null) {
      report.history = false;
      continue;
    }
    report.groups += 1;
    for (const url of urls) {
      if (fixed.size >= bySignature.size) break;
      if (els.stickerStatus) {
        els.stickerStatus.textContent =
          `群 ${groupID}：看了 ${report.images} 张图，补回 ${report.matched} 张…`;
      }
      const fetched = await request('net.fetch', { url, encoding: 'base64' }).catch(() => null);
      const base64 = String((fetched && fetched.body) || '');
      if (!base64 || (fetched && fetched.truncated)) continue;
      report.images += 1;
      const hash = bySignature.get(stickerSignature(base64));
      if (!hash || fixed.has(hash)) continue;
      try {
        await request('storage.set', { key: stickerBytesKey(hash), value: base64 });
        fixed.add(hash);
        report.matched += 1;
      } catch (err) {
        note(`补图写回失败（${hash}）：${(err && err.message) || err}`);
      }
    }
  }

  if (fixed.size || sigAdded) {
    const next = index.map((row) => {
      if (!row) return row;
      if (row.truncated && fixed.has(row.hash)) {
        const { truncated, ...rest } = row;
        return { ...rest, recoveredAt: Date.now() };
      }
      return row;
    });
    await writeStickerIndex(next);
    if (fixed.size) note(`从群历史里补回了 ${fixed.size} 张被截断的表情包`);
  }
  return report;
}

/**
 * 某个群历史里的图片地址；协议端没提供历史接口时返回 null（区分"没有图"和"没有接口"）。
 *
 * 接口名按几个常见写法试：Milky 风格（get_history_messages）、OneBot 风格
 * （get_group_msg_history / get_group_messages）。试不通就往下走，全都不通才算没有。
 */
async function historyImageUrls(groupID) {
  const attempts = [
    { name: 'get_history_messages', params: { peer_id: Number(groupID) || groupID, message_scene: 'group', limit: 300 } },
    { name: 'get_group_msg_history', params: { group_id: Number(groupID), count: 300 } },
    { name: 'get_group_messages', params: { group_id: Number(groupID), count: 300 } },
  ];
  for (const attempt of attempts) {
    let res = null;
    try {
      res = await api(attempt.name, attempt.params);
    } catch {
      continue;
    }
    const rows = Array.isArray(res)
      ? res
      : (res && (Array.isArray(res.messages) ? res.messages : (Array.isArray(res.data) ? res.data : null)));
    if (!rows) continue;
    const urls = [];
    const seen = new Set();
    for (const row of rows) {
      const segments = (row && (row.segments || row.message)) || [];
      for (const url of imageSegUrls(Array.isArray(segments) ? segments : [])) {
        if (seen.has(url)) continue;
        seen.add(url);
        urls.push(url);
      }
    }
    return urls;
  }
  return null;
}

/**
 * 给 1.12 之前导入的图补上"被截断"标记。
 *
 * 那时既没有 `truncated` 字段，宿主也不告诉调用方自己截断了，所以只能靠字节数认：一次
 * `storage.list` 拿到全部大小（317 个文件一次调用），正好等于 1,398,104 的就是残图。
 * 只写一次（已经有标记的不动），之后工坊的「残图」筛选和摘要就能用真实数据说话。
 */
async function backfillTruncated() {
  let index = null;
  try {
    index = await loadStickerIndex();
  } catch {
    return 0;
  }
  if (!Array.isArray(index) || !index.length) return 0;
  let listing = null;
  try {
    listing = await request('storage.list', { sub: STICKER_BYTES_DIR });
  } catch {
    return 0;
  }
  const sizes = new Map(((listing && listing.files) || [])
    .map((file) => [String(file.name), Number(file.bytes) || 0]));
  let changed = 0;
  const out = index.map((row) => {
    if (!row || !row.hash || row.truncated) return row;
    if (sizes.get(String(row.hash)) !== LEGACY_TRUNCATED_BASE64) return row;
    changed += 1;
    return { ...row, truncated: true };
  });
  if (changed) await writeStickerIndex(out);
  return changed;
}