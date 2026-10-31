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
const MEDIA_BUDGET_BYTES = 24 << 20; // 24 MiB：够放几百张表情，离宿主的 64 MiB 也还很远
const MEDIA_DIRS = ['media/stickers/bytes', 'media/video', 'media/video/tmp'];

/**
 * 该删哪些键，才能让总量回到预算内。纯函数（测试直接喂数据）。
 *
 * 返回 `[]` 表示什么都不用删。选择顺序是 `modified` 从旧到新——没有时间的（0）排在最前，
 * 因为"不知道多旧"在这种时候等于"最可能是遗留物"。
 */
function planEviction(files, budget) {
  const rows = Array.isArray(files) ? files : [];
  const total = rows.reduce((n, file) => n + (Number(file && file.bytes) || 0), 0);
  if (total <= budget) return [];
  const oldestFirst = rows
    .map((file) => ({
      key: String((file && file.key) || ''),
      bytes: Number(file && file.bytes) || 0,
      modified: Number(file && file.modified) || 0,
    }))
    .filter((file) => file.key)
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
 * 把 media/ 压回预算内。返回 `{deleted, freed, left}`——调用方用它决定要不要说一句。
 *
 * 失败不抛：一个删不掉的旧表情不值得让机器人的一拍崩掉，下一轮会再试。
 */
async function trimMedia() {
  if (!granted.has('storage')) return { deleted: 0, freed: 0, left: 0 };
  const all = [];
  for (const dir of MEDIA_DIRS) {
    const rows = await listMediaDir(dir);
    for (const row of rows) all.push(row);
  }
  const plan = planEviction(all, MEDIA_BUDGET_BYTES);
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
  return { deleted, freed, left: total - freed };
}

// 上一句"清理了多少"说过没有：一个会话里只说一次，别让每半小时的清理都变成一条日志。
let mediaTrimNoted = false;

/**
 * 清理 + 说一句（一次会话一次）。接在启动整理和那个半小时的定时器后面。
 */
async function trimMediaAndNote() {
  const result = await trimMedia().catch(() => null);
  if (!result || !result.deleted || mediaTrimNoted) return result;
  mediaTrimNoted = true;
  const mib = (n) => Math.round((Number(n) || 0) / (1 << 20) * 10) / 10;
  const noteText = `清理了 media/ 里 ${result.deleted} 个旧文件，腾出 ${mib(result.freed)} MiB（剩 ${mib(result.left)} MiB，预算 ${mib(MEDIA_BUDGET_BYTES)} MiB）`;
  note(noteText);
  void request('plugin.log', { level: 'info', message: noteText }).catch(() => {});
  return result;
}
