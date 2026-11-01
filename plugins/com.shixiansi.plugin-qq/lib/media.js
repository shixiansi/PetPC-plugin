// lib/media.js —— 私有目录空间管理的**边界**。
//
// ============================================================================
// 这个文件的前三版都错，错在同一个地方：**替用户决定了什么可以删。**
// ============================================================================
//
// 2026-10-31 第一版：按 `modified` 从旧到新删，真机上删掉 318 个图片文件（458 MiB），全是用户
// 手工导入的。
// 2026-11-01 第二版：补了"手工导入不许删"，但把"自动收集的表情"当成缓存继续删。
// 2026-11-01 第三版：又把索引里的空记录删了——用户的原话是「28 KB 能清出什么内存」。
//
// 第四版是最后一次，规则只剩一条，而且是用户定的：
//
//   **表情包是用户主动消费的数据。除非用户自己清，程序在任何时候都不能自动清它。**
//   —— 手工导入的、自动收集的，一视同仁。CDN 链接早已过期，删掉就是永久消失。
//
// 索引同理（它是识图花钱换来的，删掉等于让用户重付费），记忆/历史/状态更不用说。
//
// 所以这个文件现在只做一件事：**清那些"删了能自动重新产生"的下载中间产物。** 白名单只有
// two 个目录，而且都是"程序自己刚生出来的东西"，不是用户的东西。
//
// # 超额怎么办（这是前几版没回答的问题）
//
// 宿主的上限（64 MiB）确实存在，表情库真的可能把它撑满。那种情况下**正确的行为不是偷偷删**，
// 而是：写不进去 → 告诉用户"装不下了，去工坊清理或搬走" → 把决定权交给用户。
// 界面上要有入口（`mediaBreakdown()` 给的分级清单就是为此准备的）。
// 让写入失败并说明原因，远好过让用户的图凭空少一半。
//
// 一句话：**这个文件永远不删表情包，也不删索引。** 加代码时请先读这一段。

/**
 * 允许按大小淘汰的目录。加一条进来，必须先回答两个问题：
 *   1. 它是程序自己生成的吗（而不是用户放进来的）？
 *   2. 删了以后能自动重新产生吗？
 * 两个都答"是"才能进这个白名单。表情包**永远不满足第 2 条**（原图链接已过期），别加它。
 */
const EVICTABLE_DIRS = [
  // 视频下载的中间产物：合并完成后就没用了，程序自己产生的。
  'media/video/tmp',
];

/**
 * 可淘汰部分的预算。只管 EVICTABLE_DIRS 里的字节。
 *
 * 这个数不是"目录总容量上限"，是一个自我约束：中间产物别堆积到几十兆。
 * 表情包**不在**这个预算的计算范围里——它们不计入、也永远不会因为超预算被删。
 */
const MEDIA_BUDGET_BYTES = 24 << 20;

/** 表情包字节的目录（只读用途：体检、统计；**绝不**进淘汰候选）。 */
const MEDIA_STICKER_DIR = 'media/stickers/bytes';

/**
 * 该删哪些键才能让可淘汰部分回到预算内。纯函数。
 *
 * `files` 只应包含 EVICTABLE_DIRS 里的文件，而且这里再做一次硬过滤——不依赖调用方"记得传对"。
 * 返回 `[]` 表示什么都不删（含"超着也不删"）。
 */
function planEviction(files, budget, protectedKeys) {
  const rows = Array.isArray(files) ? files : [];
  const protectedSet = new Set(
    Array.isArray(protectedKeys) ? protectedKeys.map((key) => String(key || '')).filter(Boolean) : [],
  );
  const candidates = rows
    .map((file) => ({
      key: String((file && file.key) || ''),
      dir: String((file && file.dir) || ''),
      bytes: Number(file && file.bytes) || 0,
      modified: Number(file && file.modified) || 0,
    }))
    .filter((file) => file.key && !protectedSet.has(file.key) && EVICTABLE_DIRS.includes(file.dir));
  const total = candidates.reduce((n, file) => n + file.bytes, 0);
  if (total <= budget) return [];
  candidates.sort((a, b) => a.modified - b.modified);
  const out = [];
  let left = total;
  for (const file of candidates) {
    if (left <= budget) break;
    out.push(file.key);
    left -= file.bytes;
  }
  return out;
}

/** 列出某个目录的文件（键是 `<sub>/<name>`，和 storage.remove 要的形状一致）。 */
async function listMediaDir(sub) {
  const listing = await request('storage.list', { sub }).catch(() => null);
  if (!listing) return []; // 老宿主没有 storage.list：什么都不做，别把插件搞挂
  return ((listing && listing.files) || []).map((file) => ({
    key: `${sub}/${String((file && file.name) || '')}`,
    dir: sub,
    bytes: Number(file && file.bytes) || 0,
    modified: Number(file && file.modified) || 0,
  }));
}

/**
 * 清可淘汰的那部分。返回 `{deleted, freed, left, skipped}`。
 *
 * 它列的是 EVICTABLE_DIRS，所以表情包字节根本不在射程内。这不是"调用时小心一点"，
 * 是这个函数的定义域。
 */
async function trimMedia() {
  if (!granted.has('storage')) return { deleted: 0, freed: 0, left: 0, skipped: true };
  const all = [];
  for (const dir of EVICTABLE_DIRS) {
    for (const row of await listMediaDir(dir)) all.push(row);
  }
  const plan = planEviction(all, MEDIA_BUDGET_BYTES, []);
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
  return { deleted, freed, left: total - freed, skipped: false };
}

// 上一句"清理了多少"说过没有：一个会话里只说一次。
let mediaTrimNoted = false;

/**
 * 清理 + 说一句（一次会话一次）。
 *
 * 消息只说可淘汰那部分，并且明说"表情包与数据不在此列"——免得用户看到"清理了 N 个文件"，
 * 又去检查自己的图库。前几版就是这句话说得含糊，才让人以为图被清过。
 */
async function trimMediaAndNote() {
  const result = await trimMedia().catch(() => null);
  if (!result || !result.deleted || mediaTrimNoted) return result;
  mediaTrimNoted = true;
  const mib = (n) => Math.round((Number(n) || 0) / (1 << 20) * 10) / 10;
  const noteText = `清理了 ${result.deleted} 个视频下载中间产物，腾出 ${mib(result.freed)} MiB。表情包与数据不在此列，从不自动清理。`;
  note(noteText);
  void request('plugin.log', { level: 'info', message: noteText }).catch(() => {});
  return result;
}

/**
 * 私有目录体检：把每一块占多少、什么等级、删了能不能拿回来，摆给用户看。只读，不删。
 *
 * 这是"超额时把决定权交给用户"的那一半：插件自己不再动手，但用户需要知道能清什么。
 * `grade` 是给界面用的三档，别把表情包标成 `evictable`。
 */
async function mediaBreakdown() {
  const out = [];
  for (const dir of EVICTABLE_DIRS) {
    const rows = await listMediaDir(dir);
    out.push({
      key: dir,
      bytes: rows.reduce((n, file) => n + file.bytes, 0),
      count: rows.length,
      grade: 'evictable',
      gradeLabel: '中间产物（程序自己产生，可清理）',
    });
  }
  const stickers = await listMediaDir(MEDIA_STICKER_DIR);
  out.push({
    key: MEDIA_STICKER_DIR,
    bytes: stickers.reduce((n, file) => n + file.bytes, 0),
    count: stickers.length,
    grade: 'user-data',
    gradeLabel: '你的表情包（删了拿不回来，只有你能清）',
  });
  return out;
}

/**
 * 把分级写给宿主：`occupancy/hints`。
 *
 * 宿主能量出"这个目录占了多少字节"，但它**不知道**那是用户的图还是能重下的中间产物。
 * 这件知识的唯一合法来源是插件自己（它知道 `media/stickers/bytes` 是 CDN 早就过期的原图、
 * `media/video/tmp` 是下载中间产物）。所以这里把分级写成一个普通的值，控制中心的占用页读它。
 *
 * 格式见 internal/plugins/occupancy.go：`[{key, label, grade}]`，`grade` 只有
 * `evictable` / `user-data` 两种有意义（别的会被宿主忽略，等于未知）。
 *
 * 幂等：内容没变就不写，免得每次开机都多一次写。等级错了的代价是界面给出错误的清理按钮，
 * 所以**表情包永远是 `user-data`**，不给任何"可清理"的可能。
 */
const OCCUPANCY_HINTS_KEY = 'occupancy/hints';
const OCCUPANCY_HINTS = [
  { key: 'media/video/tmp', grade: 'evictable', label: '视频下载的中间产物（删了会自动重下）' },
  { key: 'media/video', grade: 'evictable', label: '视频产物（发链接会重新生成）' },
  // 这一条是这次事故的核心：表情包是用户的数据，删了永久拿不回（CDN 链接已过期）。
  { key: 'media/stickers/bytes', grade: 'user-data', label: '你的表情包（删了拿不回来，只有你能清）' },
  { key: 'media/stickers', grade: 'user-data', label: '表情包的索引与待收藏区（识图花掉的钱）' },
  { key: 'state', grade: 'user-data', label: '运行状态与群设置' },
  { key: 'history', grade: 'user-data', label: '群聊记忆的历史' },
  { key: 'memory', grade: 'user-data', label: '好友与你相关的记忆' },
];

/** 写一次分级。内容与上次相同时不发写请求。 */
async function publishOccupancyHints() {
  if (!granted.has('storage')) return;
  // 老宿主（1.10 的桌宠）拒绝带斜杠的键。`occupancy/hints` 是带斜杠的，写下去会被顶回来
  // ——而顶回来的那一次会让 `migrateDataLayout` 判定"这台宿主不认目录"，把整个插件的布局
  // 退回平铺键。为了一条可选的显示信息赌上整个数据布局，不值得：老宿主上不写就是了。
  if (typeof useFolders !== 'undefined' && !useFolders) return;
  const text = JSON.stringify(OCCUPANCY_HINTS);
  const current = await readKeyText(OCCUPANCY_HINTS_KEY).catch(() => '');
  if (current === text) return;
  try {
    await request('storage.set', { key: OCCUPANCY_HINTS_KEY, value: text });
  } catch {
    // 写不进去只是占用页少一份分级（那些目录会显示成"未分类"），不影响任何功能。
  }
}