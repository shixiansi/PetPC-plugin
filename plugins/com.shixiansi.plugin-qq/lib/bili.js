// lib/bili.js —— B 站联动
//
// 群里出现视频链接时下载、合成、发送，以及投稿推荐。
//
// 从原来的 app.js 按节**原样搬出来**（1.12 的重构）：内容逐字未改，只是换了个文件。
// 经典 script 共享同一个全局作用域，所以这里不用 import/export；
// 加载顺序写在 panel.html 里（顺序 = 原来的文件顺序，所以原有的依赖关系不变）。
'use strict';

// --- B 站联动（共享托盘） ----------------------------------------------------
//
// 两个插件之间只有 L 形的一条路：宿主的小托盘（`plugin.share`）。分工是刻意的 ——
//
//   · B 站插件知道「这条链接的流在哪」（它有 cookie、有 wbi 签名、有画质阶梯），
//     但它**从不决定发给谁**；
//   · 这个插件知道「发给哪个群、要不要 @ 主人、多大就不发了」，但它**从不碰 B 站接口**，
//     也读不到那个 cookie。
//
// 所以视频要下到**本地**这件事落在这一侧：`storage.dir` 拿到自己目录里的 `media/video/`，
// `process.launch` 起 ffmpeg，`process.state` 每两秒问一次「下完了吗」。
const BILI_OWNER = 'com.shixiansi.plugin-bilibili';
const BILI_JOBS = 'bili-jobs';
const BILI_LINK_GAP_MS = 5 * 60 * 1000;
const BILI_NOTICE_GAP_MS = 5 * 60 * 1000;
/**
 * 下载用的 UA —— **故意不是浏览器 UA**。
 *
 * 真机实测，对同一个 `*.bilivideo.com` 直链，用 ffmpeg 请求：
 *
 *   User-Agent: UA-TEST-123                       → 200
 *   User-Agent: Mozilla/5.0 … Chrome/124 …        → **403**
 *   User-Agent: curl/8.4.0                        → **403**
 *
 * 反过来（先 Chrome 后任意 UA）结果一样，所以不是限流也不是顺序。最像的解释是：CDN 对
 * 「看起来像浏览器/已知客户端、但没带 cookie」的请求直接拒掉，而对一个它不认识的客户端
 * 正常服务。所以这里诚实地报一个自己的名字，不假装是浏览器 —— 装浏览器反而要不到文件。
 * （API 调用仍然用浏览器 UA，那边正好相反。）
 */
const BILI_DOWNLOAD_UA = 'PetPC-bili-bridge/1.0';
/** 宿主对 `process.launch` 单个参数的上限是 4096 字符；留一点余量。
 *  512 曾经是这个数，而真机的 B 站 CDN 直链有 600–700 字符 —— 于是「能起 ffmpeg、却永远
 *  指不到东西」。宿主的上限已经提到 4096，这里跟着放宽。 */
const BILI_MAX_ARG_CHARS = 4000;

async function readSharedValue(owner, name) {
  const res = await request('share.get', owner ? { owner, name } : { name });
  const raw = String((res && res.value) || '');
  return raw ? JSON.parse(raw) : null;
}

async function writeSharedValue(name, value) {
  await request('share.set', { name, value: JSON.stringify(value) });
}

/**
 * The B 站 link in one message, searched in the TEXT **and inside the card segments**.
 *
 * B 站 的分享卡片到 QQ 里不是文字，而是一个 `json` / `xml` / `light_app` 段：BV 号在
 * `meta.detail_1.qqdocurl`、`meta.news.jumpUrl` 或者 XML 的 `<url>` 里。只读 `plainText`
 * 的版本对卡片**完全没反应**——它连 `[卡片]` 都不产出，因为段类型不在它的 switch 里。
 *
 * 所以这里换一种做法：把每个非文字段里的**所有字符串**都翻出来（卡片负载是嵌套对象，
 * 或者一段被转义过的 JSON 字符串），再在它们里面找 BV 号 / b23 短链。类型无关，
 * 将来冒出第四种卡片类型也不用改这里。
 */
function collectStrings(value, out, depth) {
  if (out.length > 200 || depth > 6 || value === null || value === undefined) return out;
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return out;
  }
  if (typeof value === 'object') {
    for (const key of Object.keys(value)) collectStrings(value[key], out, depth + 1);
  }
  return out;
}

function biliLinkIn(text, segments) {
  const candidates = [String(text || '')];
  for (const seg of segments || []) {
    if (!seg || !seg.data || seg.type === 'text') continue;
    collectStrings(seg.data, candidates, 0);
  }
  for (const raw of candidates) {
    // A card payload is often a JSON string inside a JSON string, so escapes have to be
    // unwound before the URL can be recognised: `https:\/\/www.bilibili.com\/video\/BV…`.
    const value = String(raw).replace(/\\\//g, '/').replace(/\\u0026/gi, '&');
    // 边界是必须的：卡片负载里全是 base64/URL 噪声，`BV` + 10 位字母数字在随机串里也会命中
    // （真机上就从一条卡片里蒙出了 `BVlkbstVNrVJ`，于是群里多了一条「请求参数不对」的噪声）。
    const direct = /(?<![0-9A-Za-z])BV[0-9A-Za-z]{10}(?![0-9A-Za-z])/.exec(value);
    if (direct) return { url: `https://www.bilibili.com/video/${direct[0]}`, bvid: direct[0] };
    // b23.tv 是常见的那个，bili2233.cn 是同一套短链的另一个域名。
    const short = /https?:\/\/(?:b23\.tv|bili2233\.cn)\/[0-9A-Za-z]+/.exec(value);
    if (short) return { url: short[0], bvid: '' };
  }
  return null;
}

function biliJobID() {
  return `b${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;
}

/**
 * Asks the Bilibili plugin to resolve one link.
 *
 * The caps travel WITH the job: the plugin that owns the streams does not own the group,
 * so "how big is too big" has to be asked rather than assumed.
 */
async function maybeRequestBiliVideo(text, segments, groupID, senderID) {
  if (!flag(state.cfg.biliLinkReply, false)) return;
  const link = biliLinkIn(text, segments);
  if (!link) return;
  const now = Date.now();
  const lastAt = state.biliLinks.get(link.url) || 0;
  if (now - lastAt < BILI_LINK_GAP_MS) {
    note(`群 ${groupID}：这条链接 5 分钟内已经请求过了`);
    return;
  }
  state.biliLinks.set(link.url, now);
  const job = {
    id: biliJobID(),
    url: link.url,
    bvid: link.bvid,
    maxMB: number(state.cfg.biliMaxMB, 80, 1, 2048),
    maxMinutes: number(state.cfg.biliMaxMinutes, 25, 1, 300),
    at: now,
  };
  try {
    const existing = await readSharedValue(null, BILI_JOBS);
    const list = Array.isArray(existing) ? existing : [];
    await writeSharedValue(BILI_JOBS, [job, ...list].slice(0, 20));
    state.biliPending.set(job.id, { groupID, senderID, at: now, url: link.url });
    note(`群 ${groupID}：已请求解析 ${link.bvid || link.url}（job ${job.id}）`);
  } catch (err) {
    note(`写 ${BILI_JOBS} 失败：${(err && err.message) || err}`);
  }
}

/**
 * 产物文件的保留清单。
 *
 * 真机上踩到的坑：`send_group_message` 返回 ok 之后**立刻**删文件，群里那条视频却显示
 * 「已过期」—— 协议端的上传是异步的，等它去读文件时文件已经不在了。
 *
 * 所以改成「记账 + 延迟清理」：发完先把 `{key, at}` 记下来，下一次轮询时删掉超过
 * 10 分钟的。文件名没有扩展名（`storage.remove` 的 key 不允许点），`-f mp4` 已经告诉
 * ffmpeg 容器格式，协议端也不按扩展名判类型（用不存在的路径探过，三种都只说 File not found）。
 *
 * 清单本身在 `state/video`，产物在 `media/video/`：一个文件夹里只放能删的东西。
 */
const BILI_KEEP_MS = 10 * 60 * 1000;

async function readVideoFiles() {
  try {
    const res = await request('storage.get', { key: DATA.videoFiles });
    const raw = String((res && res.value) || '');
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((entry) => entry && entry.key) : [];
  } catch {
    return [];
  }
}

async function rememberVideoFile(key) {
  const list = await readVideoFiles();
  list.push({ key, at: Date.now() });
  try {
    await request('storage.set', { key: DATA.videoFiles, value: JSON.stringify(list.slice(-40)) });
  } catch (err) {
    note(`记录产物失败：${(err && err.message) || err}`);
  }
}

/** 删掉够旧的产物。留着是为了让协议端把上传做完，不是为了占盘。 */
async function pruneVideoFiles() {
  const list = await readVideoFiles();
  if (!list.length) return;
  const now = Date.now();
  const keep = [];
  for (const entry of list) {
    if (now - Number(entry.at || 0) < BILI_KEEP_MS) {
      keep.push(entry);
      continue;
    }
    try {
      await request('storage.remove', { key: entry.key });
    } catch (err) {
      note(`清理 ${entry.key} 失败：${(err && err.message) || err}`);
    }
  }
  if (keep.length !== list.length) {
    try {
      await request('storage.set', { key: DATA.videoFiles, value: JSON.stringify(keep) });
    } catch {
      // 记不住就下次再清一遍，不算错。
    }
  }
}
/** Drains the result tray and announces recommendations. */
async function pollBridge() {
  if (state.bridgeBusy || !state.started) return;
  if (!flag(state.cfg.biliLinkReply, false) && !String(state.cfg.biliRecommendGroup || '').trim()) return;
  state.bridgeBusy = true;
  try {
    // 清理够旧的产物：这里而不是发完就删，见 readVideoFiles 上面的注释。
    await pruneVideoFiles();
    // 顺手扫掉很久没有回音的待办：结果丢过一次（共享值超限那次），那条待办就再也不会
    // 被消费，留着只会越积越多。
    const nowMs = Date.now();
    for (const [id, entry] of state.biliPending) {
      if (nowMs - Number(entry.at || 0) > 30 * 60 * 1000) state.biliPending.delete(id);
    }
    if (state.biliPending.size || flag(state.cfg.biliLinkReply, false)) {
      const results = await readSharedValue(BILI_OWNER, 'bili-results');
      for (const result of Array.isArray(results) ? results : []) {
        if (!result || !result.id || state.biliSeenResults.includes(result.id)) continue;
        state.biliSeenResults.push(result.id);
        if (state.biliSeenResults.length > 40) state.biliSeenResults.shift();
        // Anything older than this session's start is stale: announcing a video from
        // yesterday's job the moment the bot reconnects would be worse than losing it.
        if (result.at && state.bridgeStartedAt && result.at < state.bridgeStartedAt) continue;
        await onBiliResult(result);
      }
    }
    if (String(state.cfg.biliRecommendGroup || '').trim()) {
      const recommends = await readSharedValue(BILI_OWNER, 'recommend');
      for (const entry of Array.isArray(recommends) ? recommends : []) {
        if (!entry || !entry.bvid) continue;
        const id = `${entry.bvid}@${entry.at}`;
        if (state.biliSeenRecommends.includes(id)) continue;
        state.biliSeenRecommends.push(id);
        if (state.biliSeenRecommends.length > 40) state.biliSeenRecommends.shift();
        if (entry.at && state.bridgeStartedAt && entry.at < state.bridgeStartedAt) continue;
        await announceRecommend(entry);
      }
    }
  } catch (err) {
    note(`B 站联动轮询失败：${(err && err.message) || err}`);
  } finally {
    state.bridgeBusy = false;
  }
}

/** One answered job: download it, or say why not. */
async function onBiliResult(result) {
  const id = String(result.id);
  const pending = state.biliPending.get(id);
  if (!pending) return;
  state.biliPending.delete(id);
  const groupID = pending.groupID;
  const link = result.bvid ? `https://www.bilibili.com/video/${result.bvid}` : '';
  if (!result.ok) {
    // 失败就**忘掉这条链接**：5 分钟的去重是为了防刷屏，不是为了让「刚才那次没成功」
    // 也一起被禁掉 5 分钟。真机上正是这样卡住过一次重试。
    if (pending.url) state.biliLinks.delete(pending.url);
    // 「这不是视频」不是用户的错，也不值得在群里说一句：多半是我的正则从卡片噪声里
    // 蒙出了一个 BV 号（真机：BVlkbstVNrVJ → 请求参数不对）。记日志就够了。
    if (result.notVideo || /没认出 BV 号/.test(String(result.reason || ''))) {
      note(`群 ${groupID}：${result.bvid || '那段文本'} 不是视频，静默忽略`);
      return;
    }
    await notifyGroupThrottled(groupID, `这条视频没法直接发：${result.reason || '未知原因'}${result.title ? `\n标题：${result.title}` : ''}${link ? `\n${link}` : ''}`);
    return;
  }
  const muxed = await runFfmpeg(result);
  if (!muxed.ok) {
    note(`群 ${groupID}：${result.bvid} 没发成视频 —— ${muxed.reason}`);
    await notifyGroupThrottled(groupID, `${muxed.reason}${result.title ? `\n标题：${result.title}` : ''}${link ? `\n${link}` : ''}`);
    return;
  }
  const sent = await sendBiliVideo(groupID, result, muxed.path, muxed.key);
  // 产物已经在 `runFfmpeg` 里记过账了（每次尝试都记，失败的那次可能是 0 字节），
  // 这里不再重复记；10 分钟后由 `pruneVideoFiles` 收走。
  if (!sent) return;
}

/**
 * ffmpeg: download the two tracks and mux them, without re-encoding (`-c copy`).
 *
 * Everything here is bounded by facts the host enforces: one argument is at most 512
 * characters, and `process.launch` does not wait. So the URL length is checked here
 * (a signed B 站 CDN URL can be long) and completion is POLLED rather than awaited -
 * awaiting would freeze this frame's message handling for a minute.
 */
/**
 * ffmpeg 的等待预算，按**预估体积**给：最少 90 秒，最多 15 分钟。
 *
 * 原来写死 90 秒。真机上 59 MB 的 720p 在普通家宽下就要两三分钟，于是必然超时，
 * 用户看到的就是「下载超过 90 秒」——预算按体积给才合理：大约按 250 KB/s 的保守速度算，
 * 小文件仍走 90 秒下限，大文件自动放宽。
 */
function ffmpegBudgetMs(sizeBytes) {
  const sizeMB = Math.max(0, Number(sizeBytes) || 0) / 1048576;
  return Math.min(15 * 60 * 1000, Math.max(90 * 1000, Math.round(sizeMB * 4000)));
}

/**
 * 用**体积**判断产物能不能发，而不是用时间。
 *
 * xunlu-core 就是这么做的（`fs.statSync(resultPath).size` 与上限比），因为它手里已经有
 * 预估字节（`estimateMuxedVideoBytes`）。时间不是判据：同样 60 MB，一条宽带要四分钟、
 * 一条千兆四十秒，用秒数卡必然一边误杀一边白等。
 *
 * 三种情况拒发（都改成发链接 + 一句原因）：
 *   · 文件是空的 —— ffmpeg 退 0 但没写出东西；
 *   · 只有预估的一半不到 —— 下载被截断，发出去也是坏视频；
 *   · 超过 job 给的上限 —— 预估不准时由真实体积兜底。
 */
async function verifyMuxedSize(key, result) {
  let stat = null;
  try {
    stat = await request('storage.stat', { key });
  } catch (err) {
    // 问不到大小不算失败：ffmpeg 已经退 0，文件就在那儿。宁可信它。
    note(`查不到 ${key} 的大小：${(err && err.message) || err}`);
    return { ok: true, bytes: 0 };
  }
  const bytes = Number((stat && stat.bytes) || 0);
  if (!stat || !stat.exists || bytes <= 0) {
    return { ok: false, reason: 'ffmpeg 说成功了，但产物是空的，只发链接。' };
  }
  const mb = (value) => `${Math.round((Number(value) || 0) / 1048576 * 10) / 10} MB`;
  const estimate = Number(result.sizeBytes) || 0;
  if (estimate > 0 && bytes < estimate * 0.5) {
    return { ok: false, bytes, reason: `产物只有 ${mb(bytes)}，预估 ${mb(estimate)}，像是没下完，只发链接。` };
  }
  const cap = Number(result.maxMB) || 0;
  if (cap > 0 && bytes > cap * 1048576 * 1.05) {
    return { ok: false, bytes, reason: `产物 ${mb(bytes)} 超过上限 ${cap} MB，只发链接。` };
  }
  return { ok: true, bytes };
}

/** 系统自带的 curl（Windows 10 1803 起随系统）。路径由自己的私有目录推盘符得到。 */
function curlPath(dir) {
  const match = /^([A-Za-z]:)/.exec(String(dir || ''));
  return match ? `${match[1]}\\Windows\\System32\\curl.exe` : '';
}

/** The last segment of a storage key: the name a program writing by PATH needs. */
function fileNameOf(key) {
  const text = String(key || '');
  const at = text.lastIndexOf('/');
  return at < 0 ? text : text.slice(at + 1);
}

/**
 * One folder of this plugin's own directory, created by the host on demand.
 *
 * Needed because a program the plugin starts can only be pointed at a PATH: the plugin
 * can name `media/video/tmp/<file>` when IT writes, but curl and ffmpeg have to be handed a
 * real path, and neither of them creates the folder it writes into.
 */
async function storageDir(sub) {
  let res = null;
  try {
    res = await request('storage.dir', sub ? { sub } : {});
  } catch (err) {
    throw new Error(`拿不到自己的目录${sub ? `（${sub}）` : ''}：${(err && err.message) || err}`);
  }
  const dir = String((res && res.dir) || '');
  if (!dir) throw new Error(`拿不到自己的目录${sub ? `（${sub}）` : ''}`);
  return dir;
}

/**
 * 用 curl 下一条流到本地。**下载归 curl，ffmpeg 只负责合并**。
 *
 * 上一版让 ffmpeg 自己当 HTTP 客户端，于是网络问题全变成 ffmpeg 问题：UA、Referer、
 * 读超时、断线重连都要用参数表达，一条命令 38 个参数，直接撞穿宿主的 32 个上限。
 * curl 这些都有现成开关，退出码也有明确含义（6/7 解析或连接失败、28 超时、22 HTTP 错）。
 */
async function downloadStream(dir, key, url, label, budgetMs) {
  const curl = curlPath(dir);
  if (!curl) return { ok: false, key, reason: `找不到 curl.exe（盘符未知）` };
  const out = `${dir}\\${fileNameOf(key)}`;
  const args = [
    '-sS', '-L', '--fail',
    '--max-time', '900',
    '--retry', '2', '--retry-delay', '2',
    '-A', BILI_DOWNLOAD_UA,
    '-e', 'https://www.bilibili.com/',
    '-o', out,
    url,
  ];
  let pid = 0;
  try {
    const launched = await request('process.launch', { path: curl, args });
    pid = Number((launched && launched.pid) || 0);
  } catch (err) {
    return { ok: false, key, reason: `${label} 启动 curl 失败：${(err && err.message) || err}` };
  }
  if (!pid) return { ok: false, key, reason: `${label} curl 没起来` };

  const pollMs = typeof state.biliPollMs === 'number' ? state.biliPollMs : 2000;
  // 预算按预估体积给（ffmpegBudgetMs），curl 自己还有 --max-time 900 兜底。
  const deadline = Date.now() + Math.max(Number(budgetMs) || 0, 5 * 60 * 1000);
  let lastBytes = -1;
  let lastGrowth = Date.now();
  while (Date.now() < deadline) {
    await sleep(pollMs);
    let status = null;
    try {
      status = await request('process.state', { pid });
    } catch {
      continue;
    }
    if (status && status.known && !status.running) {
      if (Number(status.exitCode) !== 0) {
        return { ok: false, key, reason: `${label} curl 退出码 ${status.exitCode}` };
      }
      const stat = await request('storage.stat', { key }).catch(() => null);
      const bytes = Number((stat && stat.bytes) || 0);
      if (!stat || !stat.exists || bytes <= 0) {
        return { ok: false, key, reason: `${label} 下载结果是空文件` };
      }
      return { ok: true, key, path: out, bytes };
    }
    // 进度看门狗：45 秒没涨就认定这条连接废了（真机：死连接两分钟只写 0 字节）。
    const stat = await request('storage.stat', { key }).catch(() => null);
    const bytes = Number((stat && stat.bytes) || 0);
    if (bytes > lastBytes) {
      lastBytes = bytes;
      lastGrowth = Date.now();
    } else if (Date.now() - lastGrowth > 45 * 1000) {
      return { ok: false, key, reason: `${label} 连接卡住了（45 秒没有数据）` };
    }
  }
  return { ok: false, key, reason: `${label} 下载超过 15 分钟` };
}

/** 把两条本地流合成一个 mp4。**只有这一步用 ffmpeg**，参数少到不会再撞上限。 */
async function muxStreams(dir, key, videoPath, audioPath) {
  const ffmpeg = String(state.cfg.ffmpegPath || '').trim();
  const out = `${dir}\\${fileNameOf(key)}`;
  const args = audioPath
    ? ['-y', '-i', videoPath, '-i', audioPath, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-f', 'mp4', out]
    : ['-y', '-i', videoPath, '-c', 'copy', '-f', 'mp4', out];
  let pid = 0;
  try {
    const launched = await request('process.launch', { path: ffmpeg, args });
    pid = Number((launched && launched.pid) || 0);
  } catch (err) {
    return { ok: false, reason: `启动 ffmpeg 失败：${(err && err.message) || err}` };
  }
  if (!pid) return { ok: false, reason: 'ffmpeg 没起来' };

  const pollMs = typeof state.biliPollMs === 'number' ? state.biliPollMs : 2000;
  // 本地文件合成是纯 I/O，几十秒足够；这里给 3 分钟纯粹是卡死兜底。
  const deadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    let status = null;
    try {
      status = await request('process.state', { pid });
    } catch {
      continue;
    }
    if (status && status.known && !status.running) {
      if (Number(status.exitCode) !== 0) return { ok: false, reason: `ffmpeg 退出码 ${status.exitCode}` };
      return { ok: true, path: out, key };
    }
  }
  return { ok: false, reason: 'ffmpeg 合成超过 3 分钟' };
}

// 视频用的两个文件夹。中间流（media/video/tmp）和成品（media/video/）分开：成品要活到
// 协议端把它上传完（10 分钟），中间流合成完就删 —— 混在一个文件夹里，谁也说不清哪个能删。
const VIDEO_DIR = 'media/video';
const VIDEO_TMP_DIR = 'media/video/tmp';

async function runFfmpeg(result) {
  const ffmpeg = String(state.cfg.ffmpegPath || '').trim();
  if (!ffmpeg) return { ok: false, reason: '没配置 ffmpeg 路径，只发链接。' };
  const videoUrl = String((result.video && result.video.url) || '');
  const audioUrl = String((result.audio && result.audio.url) || '');
  if (!videoUrl) return { ok: false, reason: '这条视频没有可下载的地址。' };
  let dir = '';
  let tmpDir = '';
  try {
    // 旧宿主认不了 `sub`：它把参数忽略掉、返回根目录，于是文件和以前一样平铺在那儿，
    // 后面用的键也退回不带斜杠的名字（见 videoKeyIn）。
    dir = await storageDir(useFolders ? VIDEO_DIR : '');
    tmpDir = await storageDir(useFolders ? VIDEO_TMP_DIR : '');
  } catch (err) {
    return { ok: false, reason: `${(err && err.message) || err}，发不了文件。` };
  }

  // 候选：主地址一次，备用 CDN 再一次（CDN 抽风是按节点来的）。
  const candidates = [{ video: videoUrl, audio: audioUrl, label: '主地址' }];
  const backupVideo = String(((result.video && result.video.backups) || [])[0] || '');
  const backupAudio = String(((result.audio && result.audio.backups) || [])[0] || '');
  if (backupVideo) candidates.push({ video: backupVideo, audio: backupAudio || audioUrl, label: '备用 CDN' });

  const budget = ffmpegBudgetMs(result.sizeBytes);
  const stamp = Date.now().toString(36);
  let lastReason = '';
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const suffix = index ? `b${index}` : '';
    const videoKey = videoKeyIn(VIDEO_TMP_DIR, `bili${stamp}${suffix}v`);
    const audioKey = videoKeyIn(VIDEO_TMP_DIR, `bili${stamp}${suffix}a`);
    const outKey = videoKeyIn(VIDEO_DIR, `bilivideo${stamp}${suffix}`);
    const video = await downloadStream(tmpDir, videoKey, candidate.video, `${candidate.label}视频`, budget);
    await rememberVideoFile(videoKey);
    if (!video.ok) {
      lastReason = video.reason;
      note(`群里的视频第 ${index + 1} 次下载失败（${lastReason}）`);
      continue;
    }
    let audio = { ok: true, path: '' };
    if (candidate.audio) {
      audio = await downloadStream(tmpDir, audioKey, candidate.audio, `${candidate.label}音频`, budget);
      await rememberVideoFile(audioKey);
    }
    if (!audio.ok) {
      lastReason = audio.reason;
      note(`群里的视频第 ${index + 1} 次下载失败（${lastReason}）`);
      continue;
    }
    const muxed = await muxStreams(dir, outKey, video.path, audio.path || '');
    await rememberVideoFile(outKey);
    // 两条中间文件用完就删：它们已经没用了，留着只是占盘。
    for (const key of [videoKey, audioKey]) {
      if (key) await request('storage.remove', { key }).catch(() => {});
    }
    if (!muxed.ok) {
      lastReason = muxed.reason;
      note(`群里的视频第 ${index + 1} 次合成失败（${lastReason}）`);
      continue;
    }
    const check = await verifyMuxedSize(outKey, result);
    if (!check.ok) {
      lastReason = check.reason;
      note(`群里的视频第 ${index + 1} 次体积验收不过（${lastReason}）`);
      continue;
    }
    return { ok: true, path: muxed.path, key: outKey, bytes: check.bytes };
  }
  const sizeMB = Math.round((Number(result.sizeBytes) || 0) / 1048576);
  return { ok: false, reason: `${lastReason}（预估 ${sizeMB} MB），只发链接。` };
}

async function sendBiliVideo(groupID, result, path, _key) {
  const owner = String(state.cfg.ownerQQ || '').trim();
  const atOwner = flag(state.cfg.biliLinkAtOwner, true) && owner;
  const minutes = Math.round((Number(result.duration) || 0) / 60);
  // `quality` 是插件算好的画质名（720p / 480p…）；老结果里没有就退回 qn。
  const quality = result.kind === 'dash' ? (result.quality || `qn ${result.qn}`) : '单文件';
  // 正文里**不放链接**：群里往往还有别的「B 站链接解析」机器人，看到 URL 就会自己再解析
  // 一遍，于是我们发一条视频、它回一张卡片。链接只在「发不出视频」的说明里出现。
  const text = `【B 站】${result.title || result.bvid}\nUP：${result.up || '未知'} · ${minutes} 分钟 · ${quality}`;
  const message = [];
  if (atOwner) message.push({ type: 'mention', data: { user_id: Number(owner) } });
  message.push({ type: 'text', data: { text } });

  /**
   * 三种 `uri` 形式，按「这个协议端最可能接受的」排：
   *
   *   file://C:/…    ← 首选。真机两条报错拼起来就是这个：`file:///C:/…` 被截成
   *                    `/C:/…`（多一个前导斜杠 → File not found），裸路径没有 scheme
   *                    （→ Unsupported URI scheme）。也就是说它按 `file://` 前缀截断后
   *                    把剩下的部分直接当路径，所以「两个斜杠 + 盘符」才是对的。
   *   file:///C:/…   ← 规范形式，给按 URL 解析的实现（u.Path 带前导斜杠的那种）。
   *   裸路径          ← 给根本不看 scheme、直接 stat 的实现。
   *
   * 一个 `video` 段只能带一个 uri，所以每次重试都重建整条消息。
   */
  const slashed = path.replace(/\\/g, '/');
  const forms = [`file://${slashed}`, `file:///${slashed}`, path];
  let lastError = null;
  for (const uri of forms) {
    try {
      const res = await api('send_group_message', { group_id: Number(groupID), message: [...message, { type: 'video', data: { uri } }] });
      state.counts.replies += 1;
      // message_seq 记进日志：协议端（Yogurt）的日志里也是这个号，两边对得上才查得动
      // 「视频显示已过期」这类问题。
      const seq = res && res.message_seq ? `，seq ${res.message_seq}` : '';
      note(`群 ${groupID}：已发出视频 ${result.bvid}（uri=${uri}${seq}）`);
      return true;
    } catch (err) {
      lastError = (err && err.message) || String(err);
      note(`发视频失败（uri=${uri}）：${lastError}`);
    }
  }
  note(`文件留在 ${path}，可以直接手动发一次看看`);
  // 只有这条「发不出去」的说明里才带链接 —— 这时候链接是唯一的交付物。
  const link = result.bvid ? `\nhttps://www.bilibili.com/video/${result.bvid}` : '';
  await notifyGroupThrottled(groupID, `视频发不出去：${lastError}${link}`);
  return false;
}

/** A one-line explanation in the group, at most once per five minutes per group. */
async function notifyGroupThrottled(groupID, text) {
  const now = Date.now();
  if (now - (state.biliNoticeAt.get(groupID) || 0) < BILI_NOTICE_GAP_MS) {
    note(`群 ${groupID}：5 分钟内已经解释过一次，这次不重复`);
    return;
  }
  state.biliNoticeAt.set(groupID, now);
  try {
    await api('send_group_message', { group_id: Number(groupID), message: [{ type: 'text', data: { text } }] });
  } catch (err) {
    note(`发说明失败：${(err && err.message) || err}`);
  }
}

/** A recommendation from the Bilibili plugin: text + @ the owner, never a video. */
async function announceRecommend(entry) {
  const groupID = String(state.cfg.biliRecommendGroup || '').trim();
  if (!groupID) return;
  const owner = String(state.cfg.ownerQQ || '').trim();
  const message = [];
  if (flag(state.cfg.biliLinkAtOwner, true) && owner) message.push({ type: 'mention', data: { user_id: Number(owner) } });
  message.push({
    type: 'text',
    data: {
      text: `【刷到值得看的】${entry.title || entry.bvid}\n${entry.why || ''}\n${entry.summary || ''}\nhttps://www.bilibili.com/video/${entry.bvid}`,
    },
  });
  try {
    await api('send_group_message', { group_id: Number(groupID), message });
    note(`群 ${groupID}：已发出 B 站推荐 ${entry.bvid}`);
  } catch (err) {
    note(`发推荐失败：${(err && err.message) || err}`);
  }
}

/** One inbound `message_receive` event. */
async function onGroupMessage(event) {
  const data = event.data || {};
  if (data.message_scene !== 'group') return;
  const groupID = String(data.peer_id || '');
  if (!groupID) return;
  const selfID = String(event.self_id || state.selfID || '');
  const senderID = String(data.sender_id || '');
  // The protocol side reports the bot's OWN messages too (Yogurt's config has
  // `reportSelfMessage`), so this is not an optimisation: without it every answer
  // would be answered.
  if (selfID && senderID === selfID) return;
  if (!groupAllowed(groupID)) return;

  const segments = Array.isArray(data.segments) ? data.segments : [];
  // The quote and any forwarded block are resolved here rather than in plainText:
  // one needs the event's own payload, the other an API round trip.
  const enriched = await enrichSegments(segments, selfID, groupID);
  const raw = enriched.text;
  const mentioned = mentionsBot(segments, selfID);
  // The room is alive whether or not this message is for the bot: the proactive path
  // decides from this index, and an unanswered message is exactly the evidence it
  // needs that there is a conversation worth joining.
  touchGroup(groupID, groupNameOf(data));
  // 戳一戳有时不是独立事件，而是消息里的一个 `poke` 段：戳的是它，就当场回一句。
  const pokeSeg = (segments || []).find((seg) => seg && String(seg.type) === 'poke');
  if (pokeSeg) {
    void reactToPoke(groupID, {
      user_id: senderID,
      target_id: (pokeSeg.data && (pokeSeg.data.target_id || pokeSeg.data.user_id)) || '',
    });
  }
  // 谁说自己是群主，就顺手记下来：`@群主` 靠它认人（真机上 get_group_info 不可用，
  // 而消息里自带 role —— 这是最便宜也最准的来源）。
  const role = String((data.group_member && (data.group_member.role || data.group_member.member_role)) || '').toLowerCase();
  if (role === 'owner' && senderID) {
    state.groupOwner.set(String(groupID), String(senderID));
  }
  // 带视频的消息一律不回（画面看不到，答起来只能是瞎猜）。放在触发规则之前：连"被 @"都挡。
  if (hasVideoSegment(segments)) {
    noteVideoSkipped(groupID, segments);
    noteChatter(groupID, speakerOf(data), enriched.text);
    return;
  }
  // 群里出现的图片：不管这条是不是在跟机器人说话，都先下载 + 识图，存进"待收藏"。
  // 不 await —— 一次识图要几百毫秒到几秒，让一句提问等它是不划算的。
  void collectFromSegments(groupID, segments, selfID);
  // A link is worth resolving whoever posted it and whether or not the bot is being
  // addressed, so this sits BEFORE the chat trigger rules - and it is not awaited, so a
  // long round trip cannot delay the answer to a real question. The SEGMENTS travel with
  // the text because B 站 的分享卡片把链接放在段里，纯文本里没有。
  void maybeRequestBiliVideo(raw, segments, groupID, senderID);
  // 点歌是**命令**，不是聊天：命中了当场发卡片，绝不喂给模型（和下面的 `#状态` 同一类）。
  // 放在 B 站链接之后：那条是不 await 的旁路，而点歌要自己发消息、还要决定"这条消息到此为止"。
  //
  // **先用同步的 `songCommandOf` 判一次**：`maybeHandleSongCommand` 是 async，直接 await 会给
  // 每一条普通消息平白加一个微任务（真机上无所谓，但测试里"跑几个 tick 再断言"的写法就少一拍，
  // 于是 65 个用例一起红）。不是点歌就一步都不多走。
  if (songCommandOf(raw) && (await maybeHandleSongCommand(raw, groupID))) return;
  // 群内管理命令在触发规则之前处理：`#状态` / `#忘掉` 不是聊天，不该喂给模型。
  const command = groupCommandOf(raw);
  if (command) {
    await handleGroupCommand(command, groupID, data);
    return;
  }
  if (!shouldAnswer(raw, mentioned)) {
    // 没被叫到的消息进"背景聊天"缓冲：攒批自主插话靠它决定要不要接一句。
    // 只放**没被回答**的那些——被回答的那条已经在这轮提问里了，重复带一遍只会让它自言自语。
    noteChatter(groupID, speakerOf(data), raw);
    // SAY why it stayed silent, once per group per minute.
    //
    // This line exists because its absence cost an afternoon: the market edits the
    // STORED settings, the running frame kept the ones it read at startup, and the
    // only observable difference was "it answers @ but not anything else" - which
    // looks exactly like a broken trigger rule rather than a stale config. A bot
    // that explains its own silence is a bot you can debug from a dashboard.
    const now = Date.now();
    const last = state.ignoredAt.get(groupID) || 0;
    if (now - last > 60_000) {
      state.ignoredAt.set(groupID, now);
      note(`群 ${groupID}：这条没被 @，按当前设置不回（atOnly=${flag(state.cfg.atOnly, true)}, 插话概率=${number(state.cfg.replyChance, 0, 0, 100)}%）`);
    }
    return;
  }

  const ask = stripPrefix(raw);
  if (!ask) return;

  state.counts.asked += 1;
  const groupName = groupNameOf(data);
  const asker = speakerOf(data);

  // ---- 排队 ------------------------------------------------------------------
  // 这个群正忙着回答时，新问题**排队**而不是丢掉：两个人前后脚问，第二个人不该听不到回应。
  // 队列存的是"这条提问"本身（段、引用、发问者、解析后的正文），轮到它时按当时的状态回答。
  const job = { data, segments, enriched, ask, asker, groupName, mentioned };
  // 有人明确在跟它说话：背景缓冲里那些"刚才聊的"就当作这一轮的上下文，攒批也不再重复消费。
  const chatter = (state.chatter.get(String(groupID)) || []).slice(-6);
  state.chatter.delete(String(groupID));
  job.chatter = chatter;
  const waiting = state.asks.get(groupID) || [];
  if (state.busy.has(groupID) || waiting.length) {
    if (waiting.length >= MAX_ASK_QUEUE) {
      // 排满了说明这不是"接着问一句"，而是在刷屏；宁可丢新的，也不丢排队里的。
      note(`群 ${groupID}：已经排了 ${waiting.length} 条，这条只好丢掉`);
      return;
    }
    waiting.push(job);
    state.asks.set(groupID, waiting);
    note(`群 ${groupID}：上一条还在回答，这条排上了（排第 ${waiting.length} 位）`);
    return;
  }
  const cooldown = number(state.cfg.cooldownSec, 5, 0, 600) * 1000;
  if (cooldown > 0 && Date.now() - (state.lastAnswer.get(groupID) || 0) < cooldown) {
    // 冷却期内也不丢：排进队列，drainGroupAsks 会等到间隔够了再答。
    state.asks.set(groupID, [job]);
    note(`群 ${groupID}：还在冷却里，这条排上了`);
    void drainGroupAsks(groupID);
    return;
  }
  await takeTurn(groupID, job);
}

/** 每个群最多排几条：再多就是刷屏，那条消息本来也不是在等一个回答。 */
const MAX_ASK_QUEUE = 4;

/**
 * 处理这个群排队里的下一条（正忙/没排队就什么都不做）。
 *
 * 间隔仍然遵守 `cooldownSec`：排队是为了"不丢话"，不是为了"连环轰炸"。
 */
async function drainGroupAsks(groupID) {
  if (state.busy.has(groupID)) return;
  const queue = state.asks.get(groupID) || [];
  if (!queue.length) return;
  const gap = number(state.cfg.cooldownSec, 5, 0, 600) * 1000;
  const wait = gap - (Date.now() - (state.lastAnswer.get(groupID) || 0));
  if (wait > 0) {
    // 一个群只留一个定时器：否则每来一条消息就多一个，最后同时醒过来一起抢。
    if (state.drainTimers.has(groupID)) return;
    const timer = setTimeout(() => {
      state.drainTimers.delete(groupID);
      void drainGroupAsks(groupID);
    }, wait);
    state.drainTimers.set(groupID, timer);
    return;
  }
  const job = queue.shift();
  if (!queue.length) state.asks.delete(groupID);
  await takeTurn(groupID, job);
}

/** 轮到这条提问了：占住这个群、回答、放下，然后看还有没有排队的。 */
async function takeTurn(groupID, job) {
  state.busy.add(groupID);
  state.lastAnswer.set(groupID, Date.now());
  const { data, segments, enriched, ask, asker, groupName, mentioned } = job;
  const chatter = Array.isArray(job.chatter) ? job.chatter : [];
  try {
    // 记忆核心模式：这一句"怎么回"交给另一个插件（见 lib/memcore.js）。开关默认关着，
    // 关着的时候下面这条路一行都没变——这就是为什么它是一条早退，而不是把原路径改造成两用。
    if (coreEnabled()) {
      await takeTurnViaCore(groupID, job);
      return;
    }
    const turns = number(state.cfg.contextTurns, 8, 0, 40);
    const history = await loadHistory(groupID, turns);
    // Diagnostic: a message that LOOKS like it carries a picture must say how many
    // URLs were collected. Without this line "the model says it cannot see the image"
    // is indistinguishable from "no image was ever attached", and the two need
    // completely different fixes.
    const images = imagesOf([...(segments || []), ...enriched.quoteSegments]);
    const pictureSegments = [...(segments || []), ...enriched.quoteSegments].filter((seg) => {
      if (!seg) return false;
      if (seg.type === 'image') return true;
      return seg.type === 'reply' &&
        (seg.data && Array.isArray(seg.data.segments)) &&
        seg.data.segments.some((inner) => inner && inner.type === 'image');
    });
    if (pictureSegments.length) {
      note(`收到含图片的消息：采集到 ${images.length} 张（visionModel=${String(state.cfg.visionModel || '').trim() || '未设置'}）`);
    }
    // The speaker's name travels WITH the question, exactly as it does in the history
    // (`昵称：内容`). It used to be added only when remembering, so the prompt said
    // "消息前面会带上说话人的昵称" and then handed over a question with no name in
    // front of it: the model answered "你们" instead of 阿棠, and a group member who
    // does not know who just spoke is the tell that it is not reading the room.
    const asked = `${asker}：${ask}`;
    const senderID = String(data.sender_id || '');
    // 记忆与状态：能量先按"又收到一条消息"结算，再把需要注入的东西读出来。
    // 群友卡片只注入**发问者**这一张：翻出全群的人要逐个读文件，而 system 只有 4000 字符，
    // 把预算花在"这一句话是谁说的"上更值。
    const energy = await settleEnergy(groupID, mentioned);
    const notes = await loadNotes(groupID);
    const card = await touchFriend(senderID, asker, groupID);
    const library = flag(state.cfg.autoCollectStickers, true) ? await loadStickerIndex() : [];
    const candidates = pickStickerCandidates(library, `${ask} ${history.slice(-2).map((turn) => turn.text).join(' ')}`);
    const pending = await loadPending();
    const system = systemPromptFor(groupID, groupName, {
      energy,
      notes,
      // 短期记忆（待办/约好的事）单独一段注入：它只活 24 小时，不该混进长期记忆里。
      todo: await loadTodo(groupID),
      friend: card,
      candidates,
      pending,
      notices: takeNotices(groupID),
      chatter,
    });
    const maxChars = number(state.cfg.replyMaxChars, 300, 20, 2000);
    let res = await askWithFallback({
      asked,
      system,
      history,
      images,
      groupID,
      groupName,
    });
    let rawReply = String((res && res.text) || '');
    let parsed = parseReply(rawReply);
    let say = tidyReply(parsed.text, maxChars);
    if (!say && !parsed.silent) {
      // A reasoning model can spend the whole token budget on reasoning and return an
      // EMPTY content with finish_reason "stop" - seen live on qwen3.8-27b. One more
      // draw is cheap and usually answers; saying nothing in a group is worse than a
      // mediocre line, because nobody can tell it apart from a broken bot.
      note(`群 ${groupID} 的回复是空的，重试一次`);
      res = await askWithFallback({
        asked,
        system,
        history,
        images,
        groupID,
        groupName,
      });
      rawReply = String((res && res.text) || '');
      parsed = parseReply(rawReply);
      say = tidyReply(parsed.text, maxChars);
    }
    // 原话留一份（工坊里能看），并在模型漏了围栏时说一次——这是"记忆为什么一直是空的"
    // 唯一能自查的线索。
    await recordProbe(groupID, rawReply);
    noteMissingFence(groupID, rawReply);
    // 指令先落地：模型可能只想记一句话（silent），那也要把记忆写进去。
    const memoryResult = await applyMemoryWrites(groupID, parsed);
    if (parsed.friend) await applyFriendWrite(senderID, asker, parsed.friend);
    if (memoryResult.added || memoryResult.removed) {
      note(`群 ${groupID} 的记忆更新：+${memoryResult.added} / -${memoryResult.removed}`);
    }
    // 短期记忆（待办/约好的事）另一本账：不写进 notes，也不会一直粘在 prompt 里。
    const todoResult = await applyTodoWrites(groupID, parsed);
    if (todoResult.added || todoResult.done) {
      note(`群 ${groupID} 的待办：+${todoResult.added} / -${todoResult.done}`);
    }
    const armed = await applyReminders(groupID, parsed.remind, { name: asker, id: senderID });
    if (armed) note(`群 ${groupID}：记下了 ${armed} 条定时提醒`);
    for (const hash of parsed.saveMeme) {
      if (await saveCollectedSticker(hash)) note(`群 ${groupID}：把一张候选表情收进了图库`);
    }
    // 模型偶尔把表情编号当正文发出来（真机：群里连着出现 "694ee580"）。编号只该在围栏的
    // `meme` 里，正文是给群里看的话 —— 整条就是一个图库编号时，就当成"要发这张图"。
    const absorbed = await absorbStickerIdText(groupID, say);
    say = absorbed.text;
    if (absorbed.meme) parsed.meme = absorbed.meme;
    if (parsed.silent || !say) {
      await adjustEnergy(groupID, parsed.energy);
      publishGroupState(groupID, { energy: await loadEnergy(groupID), notes: (await loadNotes(groupID)).length });
      // 只挑了表情、没写字，也是"说话"的一种：图要发出去，不然群里什么都收不到。
      if (parsed.meme && !parsed.silent) await maybeSendSticker(groupID, parsed.meme, parsed.tag);
      // 有人 @ 了它、它却选择不说话：一点反应都没有等于"这机器人坏了"。给那条消息贴个表情
      // 回应（`send_group_message_reaction`）—— 表示"看见了"，但一个字都不发。
      if (mentioned && !parsed.meme) await reactToMessage(groupID, data.message_seq);
      note(`群 ${groupID} 这次没说话${parsed.silent ? '（模型选择沉默）' : parsed.meme ? '（只发表情）' : '（正文为空）'}${mentioned ? '，已给那条消息贴了表情回应' : ''}`);
      return;
    }
    // 正文里只该有"要发进群的话"：围栏和情绪标记都在 parseReply 里剥掉了。
    // 模型点名要 @ 谁：能解析的（群主/全体成员/我/QQ 号）发成段，认不出的当普通文字 @ 出去。
    const mention = await mentionSegmentsFor(groupID, parsed.at, senderID);
    const outgoing = mention.leftovers.length
      ? `${mention.leftovers.map((name) => `@${name}`).join(' ')} ${say}`
      : say;
    await sendGroupReply(groupID, data.message_seq, outgoing, mention.segments);
    await remember(groupID, groupName, asked, say, turns);
    const spent = await spendEnergy(groupID, Array.from(outgoing).length, parsed.energy);
    publishGroupState(groupID, { energy: spent, notes: (await loadNotes(groupID)).length });
    note(`群 ${groupID} 回复了 ${asker}（${Array.from(say).length} 字，能量 ${Math.round(spent * 100)}${parsed.at.length ? '，@了 ' + parsed.at.join('、') : ''}）`);
    await maybeSendSticker(groupID, parsed.meme, parsed.tag);
  } catch (err) {
    state.counts.errors += 1;
    // The host's refusal is already a readable sentence ("「X」还没有可用的大模型配置…");
    // it goes into the log rather than into the group, because a group full of
    // people should not be told how the bot is configured.
    note(`群 ${groupID} 回答失败：${(err && err.message) || err}`);
  } finally {
    state.busy.delete(groupID);
    // 放下的同时看还有没有排队的：有就按"同群最小间隔"接着答。
    void drainGroupAsks(groupID);
  }
}

/** One inbound text frame from the socket. */
function onSocketFrame(text) {
  state.counts.frames += 1;
  let event = null;
  try {
    event = JSON.parse(text);
  } catch {
    note('收到一个不是 JSON 的帧，已忽略');
    return;
  }
  if (!event || typeof event !== 'object') return;
  if (event.self_id && !state.selfID) state.selfID = String(event.self_id);
  switch (event.event_type) {
    case 'message_receive':
      // Private messages are the OWNER's import channel (see onPrivateMessage);
      // group messages are the conversation channel. Both arrive as message_receive.
      if (event.data && event.data.message_scene === 'group') void onGroupMessage(event);
      else void onPrivateMessage(event);
      break;
    case 'bot_offline':
      note(`协议端报告机器人下线：${(event.data && event.data.reason) || '未说明'}`);
      break;
    default: {
      // 戳一戳先处理，**不能**塞在 noticeFor 的分支里。
      //
      // 真机上踩过：协议端把戳一戳叫 `group_nudge`，它不在通知表里，于是先掉进"未识别的事件
      // 类型"那条日志，`reactToPoke` 一次都没被调用——日志里明明看到 group_nudge，群里却毫无反应。
      if (isPokeEvent(event)) {
        const data = event.data || {};
        const gid = String(data.group_id || data.peer_id || (data.group && data.group.group_id) || '');
        if (gid) {
          pushNotice(gid, '有人戳了一戳');
          void reactToPoke(gid, data);
        }
        break;
      }
      // 群系统通知（撤回/进群/退群…）：进那个群的下一次 prompt，不进历史 ——
      // 历史是"谁说了什么"的转写，一条撤回通知混进去会永远留在上下文里。
      const line = noticeFor(event);
      if (line) {
        const data = event.data || {};
        const gid = String(data.group_id || data.peer_id || '');
        if (gid) pushNotice(gid, line);
        break;
      }
      // 认不出的事件类型：每种只记一次。这不是噪声，而是下个版本该支持什么的线索 ——
      // Milky 的事件名以协议端文档为准，猜不如看日志。
      const type = String(event.event_type || '');
      if (type && !state.unknownEvents.has(type) && state.unknownEvents.size < 12) {
        state.unknownEvents.add(type);
        note(`收到未识别的事件类型：${type}（如果是群通知，名字报出来就能渲染它）`);
      }
      break;
    }
  }
}

/**
 * 事件 → 一句 `[系统] …`，认不出就返回空串。
 *
 * 名字按 Milky/OneBot 最常见的一组猜的；猜错不会出问题（走"未识别"那条日志），猜对就能让
 * 模型知道"刚才有人退群了"。字段也一律按可选处理。
 */
const NOTICE_TYPES = {
  message_recall: () => '有人撤回了一条消息',
  group_member_increase: () => '有新人进群了',
  group_member_decrease: () => '有人退群了',
  // 戳一戳**不在这里**：它要当场回一句，由 `onSocketFrame` 里的 isPokeEvent 分支处理
  // （那里也会 pushNotice）。两处都写就是两份会漂移的清单。
  group_mute: () => '有人被禁言了',
  group_whole_mute: () => '全员禁言状态变了',
  group_admin_change: () => '管理员变了',
  group_name_change: () => '有人改了群名',
  group_message_reaction: (data) => (data && data.is_add === false ? '有人取消了表情回应' : '有人给消息加了个表情回应'),
};

function noticeFor(event) {
  const build = NOTICE_TYPES[event.event_type];
  if (!build) return '';
  try {
    return build(event.data || {});
  } catch {
    return '';
  }
}

/** 存进那个群的"刚刚发生的事"，最多 6 条、10 分钟内有效。 */
function pushNotice(groupID, line) {
  const id = String(groupID);
  const now = Date.now();
  const list = (state.notices.get(id) || []).filter((item) => now - item.at < 10 * 60_000);
  list.push({ text: line, at: now });
  state.notices.set(id, list.slice(-6));
}

/** 取出并清空：通知只该被"下一次回答"看到，之后就该忘掉。 */
function takeNotices(groupID) {
  const id = String(groupID);
  const list = (state.notices.get(id) || []).filter((item) => Date.now() - item.at < 10 * 60_000);
  state.notices.delete(id);
  return list;
}

