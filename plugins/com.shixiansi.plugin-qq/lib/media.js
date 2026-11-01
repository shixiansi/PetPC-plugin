// lib/media.js —— media/ 的字节预算，由一个插件自己守。
//
// # 为什么需要它
//
// 2026-10-31 的真机：这个插件的私有目录是 497.7 MiB，其中 media/ 占全部（391 个文件：表情
// 原图 + 下载的视频）。宿主的上限是 64 MiB，而"超了就拒绝写入"在真机上直接把它卡死——连一个
// 129 字节的账本都存不下去（宿主删不了它的数据，那是死锁，见 checkStorageBudget 的注释）。
//
// 所以清理只能由插件自己做。这件事需要两样东西：一个预算，和一份"谁最旧"的答案。
// `storage.list` 从 2026-10-31 起返回每个文件的 `modified`（毫秒），所以"删最旧的直到装得下"
// 才真的可做——在那之前插件只能按文件名（没有意义）或者自己维护一份索引（497 MiB 证明没人维护）。
//
// # 只删这三个目录
//
// state/ memory/ history/ config.json 是**数据**，不是缓存，一个都不能碰。MEDIA_DIRS 是唯一的
// 白名单，planEviction 只会从传进去的那份清单里选，而清单只由这三个目录装配。
//
// # 手工导入的表情是用户的，不是缓存的（2026-11-01 的教训）
//
// 第一版只按 `modified` 从旧到新删。真机上 10-31 21:59 那一次删掉了 318 个文件、458 MiB——
// 而这 318 张**全是手工导入的**：用户 10-24/25 从合并转发里导进来，所以"最旧"；自动收集的是
// 10-31 才收的，反而全活下来。索引里一条都没少（删除只动字节），于是插件以为图还在，
// 选中它去发表情时才发现字节没了。
//
// 这条和 `stickers.js` 的 `pruneCollected` 是同一个道理，两份文件现在说的是同一句话：
// **带 `collected` 标记的才是自动收集的，可以淘汰；没有标记的是用户自己的东西，轮不到清理
// 替用户做决定**。所以 planEviction 收一份"受保护的键"（手工条目的字节键），永不选它们；
// 预算不够时它宁可留着超出，也不动它们——超出只会让宿主记一条 WARN，动它们会让用户丢东西。
const MEDIA_BUDGET_BYTES = 24 << 20; // 24 MiB：够放几百张表情，离宿主的 64 MiB 也还很远
const MEDIA_DIRS = ['media/stickers/bytes', 'media/video', 'media/video/tmp'];
/** 淘汰时要跳过的目录：里面的文件一律由索引说了算，不按字节预算删。 */
const PROTECTED_PREFIX = 'media/stickers/bytes/';

/**
 * 该删哪些键，才能让总量回到预算内。纯函数（测试直接喂数据）。
 *
 * 返回 `[]` 表示什么都不用删。
 *
 * 两条规则，顺序是硬的：
 *  1. `protectedKeys`（手工导入的字节键）**永远不进候选**，哪怕预算已经超了。用户的导入不是
 *     缓存，超出预算的代价（一条 WARN）远小于"图突然没了"。
 *  2. 其余按 `modified` 从旧到新——没有时间的（0）排在最前，因为"不知道多旧"在这种时候等于
 *     "最可能是遗留物"。
 */
function planEviction(files, budget, protectedKeys) {
  const rows = Array.isArray(files) ? files : [];
  const protectedSet = new Set(
    Array.isArray(protectedKeys) ? protectedKeys.map((key) => String(key || '')).filter(Boolean) : [],
  );
  const total = rows.reduce((n, file) => n + (Number(file && file.bytes) || 0), 0);
  if (total <= budget) return [];
  const oldestFirst = rows
    .map((file) => ({
      key: String((file && file.key) || ''),
      bytes: Number(file && file.bytes) || 0,
      modified: Number(file && file.modified) || 0,
    }))
    .filter((file) => file.key && !protectedSet.has(file.key))
    .sort((a, b) => a.modified - b.modified);
  const out = [];
  let left = total;
  for (const file of oldestFirst) {
    if (left <= budget) break;
    out.push(file.key);
    left -= file.bytes;
  }
  return out;
}

/** 列出白名单里某个目录的文件（键是 `<sub>/<name>`，和 storage.remove 要的形状一致）。 */
async function listMediaDir(sub) {
  const listing = await request('storage.list', { sub }).catch(() => null);
  if (!listing) return []; // 老宿主没有 storage.list：什么都不做，别把插件搞挂
  return ((listing && listing.files) || []).map((file) => ({
    key: `${sub}/${String((file && file.name) || '')}`,
    bytes: Number(file && file.bytes) || 0,
    modified: Number(file && file.modified) || 0,
  }));
}

/**
 * 手工导入的表情的字节键——预算清理永远不许碰的那些。
 *
 * 判据与 `stickers.js` 的 `pruneCollected` 同源：索引里**没有** `collected` 标记的条目是用户
 * 自己导进来的。那份索引读不到就当"没有手工条目"，但那只发生在 storage.get 失败时，而那种情况下
 * 后面 listMediaDir 也必然失败——不会有任何键被删。读得到索引时，条目有 `collected` 才是自动的。
 */
async function protectedStickerKeys() {
  // DATA 由 lib/store.js 提供（它先加载）。这里仍然做一次兜底：万一有人改了加载顺序，
  // "读不到键名"必须让清理**停手**，而不是当成"没有手工条目"去删——真机上那次事故正是
  // 这个方向的错误。
  const key = typeof DATA !== 'undefined' && DATA && DATA.stickerIndex ? DATA.stickerIndex : '';
  if (!key) return null; // null = 不知道，调用方据此不做任何淘汰
  let res = null;
  try {
    res = await request('storage.get', { key });
  } catch {
    return null;
  }
  let rows = [];
  try {
    const parsed = JSON.parse((res && res.value) || '[]');
    if (Array.isArray(parsed)) rows = parsed;
  } catch {
    return null;
  }
  return rows
    .filter((row) => row && row.hash && !row.collected)
    .map((row) => `${PROTECTED_PREFIX}${String(row.hash).replace(/[^0-9A-Za-z_-]/g, '')}`)
    .filter((key2) => key2 !== PROTECTED_PREFIX);
}

/**
 * 把 media/ 压回预算内。返回 `{deleted, freed, left, kept}`——调用方用它决定要不要说一句。
 *
 * `kept` 是"因为属于手工导入而没有删"的字节数：超出预算时它就是那句说明里的"还剩多少是用户的"。
 *
 * **读不到表情索引就完全不淘汰**（`protectedStickerKeys` 返回 null）：在不知道哪些是用户自己的
 * 时候删文件，正是 2026-10-31 在真机上删掉 318 张手工表情的那个方向。超预算本身只是宿主的一条
 * WARN，删错东西是用户的损失——这两者的量级不对等。
 */
async function trimMedia() {
  if (!granted.has('storage')) return { deleted: 0, freed: 0, left: 0, kept: 0, skipped: true };
  const all = [];
  for (const dir of MEDIA_DIRS) {
    const rows = await listMediaDir(dir);
    for (const row of rows) all.push(row);
  }
  const protectedKeys = await protectedStickerKeys();
  if (protectedKeys === null) {
    return { deleted: 0, freed: 0, left: all.reduce((n, f) => n + f.bytes, 0), kept: 0, skipped: true };
  }
  const plan = planEviction(all, MEDIA_BUDGET_BYTES, protectedKeys);
  let deleted = 0;
  let freed = 0;
  for (const key of plan) {
    try {
      await request('storage.remove', { key });
      deleted += 1;
      const row = all.find((file) => file.key === key);
      freed += row ? row.bytes : 0;
    } catch {
      // 删不掉就算了：下一轮再来。
    }
  }
  const total = all.reduce((n, file) => n + file.bytes, 0);
  const protectedBytes = all
    .filter((file) => protectedKeys.includes(file.key))
    .reduce((n, file) => n + file.bytes, 0);
  return { deleted, freed, left: total - freed, kept: protectedBytes, skipped: false };
}

// 上一句"清理了多少"说过没有：一个会话里只说一次，别让每半小时的清理都变成一条日志。
let mediaTrimNoted = false;

/**
 * 清理 + 说一句（一次会话一次）。接在启动整理和那个半小时的定时器后面。
 *
 * 那句话要能把"超预算但没删"讲清楚：预算不够时一个文件都不删，而"什么都没删"如果不说出来，
 * 用户只会看到宿主的 WARN，以为插件坏了。所以两种情况都说：删了 N 个；或者"全是手工导入的，
 * 留着"。
 */
async function trimMediaAndNote() {
  const result = await trimMedia().catch(() => null);
  if (!result || mediaTrimNoted) return result;
  if (!result.deleted && !result.kept) return result;
  mediaTrimNoted = true;
  const mib = (n) => Math.round((Number(n) || 0) / (1 << 20) * 10) / 10;
  const noteText = result.deleted
    ? `清理了 media/ 里 ${result.deleted} 个旧文件，腾出 ${mib(result.freed)} MiB（剩 ${mib(result.left)} MiB，预算 ${mib(MEDIA_BUDGET_BYTES)} MiB）`
    : `media/ 超出预算 ${mib(MEDIA_BUDGET_BYTES)} MiB，但里面 ${mib(result.kept)} MiB 是你自己导入的表情，不删；自动收集的已经清空`;
  note(noteText);
  void request('plugin.log', { level: 'info', message: noteText }).catch(() => {});
  return result;
}
