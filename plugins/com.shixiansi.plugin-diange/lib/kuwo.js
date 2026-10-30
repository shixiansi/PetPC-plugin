// lib/kuwo.js —— 酷我搜索与直链（这一层只管"问一次、读回来、探一下"）
//
// 这一层来自一个 Koishi 的 QQ 点歌插件（`点歌 发如雪` → 一张 QQ 音乐卡片）。那个插件里有
// 四件事，其中两件在这里、两件不在：
//
//   在  · 拿歌名去查一首歌（酷我，经过 `oiapi.net` 那个公开接口）；
//   在  · 链接可能带签名会失效，所以按码率逐档回退、能探就探一次；
//   不在· `api.s01s.cn` 的 QQ 音乐卡片：那是「把一首歌塞进 QQ 消息」的格式，桌宠没有那个
//        通道，硬搬过来只会变成一串谁都不认的 JSON；
//   不在· 群里 @ 机器人的消息路由：那是接入端（QQ / OneBot）的事，这里只回答"哪首歌、
//        链接是什么"，由调用方决定怎么发出去。
//
// ## 这个接口的形状（2026-10-30 实测）
//
//   GET {apiBase}/api/Kuwo?msg=<歌名>&n=1&br=<128|192|320>
//   → {"code":1,"message":"…歌名：发如雪…音乐链接：http://…","data":{…}}
//
// 两个坑：
//
//   1. `data` 既可能是一个对象，也可能是数组（同一个接口两种都返回过）——两种都要认，
//      否则会出现"昨天还好好的"。
//   2. `n` 参数**没有用**：传 n=5 也只回一条最匹配的结果。所以 song 的能力边界是
//      "把一句话解析成一首歌"，不是"列出一堆候选"。别在文档里把它写成后者。
//
// 另外 `br` 也基本被忽略（实测请求 320 回的还是 128 的那条 mp3）。保留逐档回退不是为了
// 音质，而是为了**换一条签名不同的链接**：某一条播不通时，换一档常常就通了。这就是原插件
// 那个 `for (const br of [320, 192, 128, 3])` 的真实用途。
//
// ## 为什么探测要自己算白名单
//
// 宿主 `net.fetch` 的请求头白名单只有 accept / authorization / content-type / user-agent
// （手册 §6.10），**没有 Range**——所以"试播一下"只能是完整 GET，不能只要前 1KB。
// 而音频域名是接口当场给的（`kw-er.kuwo.cn` / `kw-lv.kuwo.cn` …），宿主的白名单是
// manifest.netHosts ∪ hostWhitelist 配置项，我们知道的只有这两份。于是：
//
//   · 域名在 `probeHosts()` 里 → 发一次 GET 看状态码，拿到"能播/不能播"的实话；
//   · 不在 → **不发**，标"未验证"。（发一次注定被拒的请求只会往宿主日志里写一条 WARN，
//     然后我们还是一样不知道它能不能播。）

'use strict';

const API_DEFAULT = 'http://oiapi.net';
/** 单次搜索的上限（毫秒）。宿主 net.fetch 与 plugin.call 都是 30 秒，这里留足余量。 */
const API_TIMEOUT_MS = 12000;
/** 单次探测的上限。探测是"顺手确认一下"，不该比搜索本身还慢。 */
const PROBE_TIMEOUT_MS = 6000;
/** 一整次 resolveSong 的默认预算：搜索 + 最多两次回退探测都装得下。 */
const RESOLVE_BUDGET_MS = 18000;
/**
 * 实测见过的音频域名。`manifest.netHosts` 里必须有它们（测试盯着这两份不许漂），
 * 否则这里会以为"不在白名单里"而不去探测——一个不报错的静默降级。
 */
const KNOWN_CDN_HOSTS = ['kw-er.kuwo.cn', 'kw-lv.kuwo.cn'];
/** 码率回退链。按"离首选最近"排序见 brPlan()。 */
const BR_PLAN = [320, 192, 128];

/** 接口地址：设置里那个，缺省是公开实例。 */
function apiBase() {
  const raw = String(cfg.apiBase === undefined || cfg.apiBase === null || cfg.apiBase === '' ? API_DEFAULT : cfg.apiBase)
    .trim()
    .replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(raw)) {
    throw new Error('搜索接口地址要以 http:// 或 https:// 开头（在插件设置里改）');
  }
  return raw;
}

/**
 * 码率回退顺序：首选在前，其余按"离首选的距离"排。
 *
 * 128 → [128, 192, 320]；320 → [320, 192, 128]。这样"换一档再试"总是先动最小的一步，
 * 不会为了绕开一条坏链就把 320 的文件甩给一个只有 128 的歌。
 */
function brPlan(preferred) {
  const want = clampInt(preferred === undefined || preferred === null || preferred === '' ? cfg.br : preferred, 1, 4096, 128);
  return BR_PLAN.slice().sort((a, b) => Math.abs(a - want) - Math.abs(b - want));
}

/** 一次搜索的 URL。`n` 是原插件留下的参数（接口只认 1），保留它免得换个镜像就变脸。 */
function searchURL(name, br) {
  return `${apiBase()}/api/Kuwo?msg=${encodeURIComponent(String(name || ''))}&n=1&br=${br}`;
}

/** 带超时的 net.fetch。宿主没有超时参数，用 Promise.race 自己掐。 */
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

/** 只认 http(s) 的链接：接口是第三方的，别把 `javascript:` 之类的东西带进 prompt 与页面。 */
function httpURL(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!/^https?:\/\//i.test(raw)) return '';
  return raw;
}

function hostOf(url) {
  try {
    return new URL(String(url || '')).host.toLowerCase();
  } catch {
    return '';
  }
}

/** 把"用户填的一串域名"拆开（与宿主 ConfigHosts 的分隔符一致：逗号/分号/空白）。 */
function parseHostList(value) {
  return String(value === undefined || value === null ? '' : value)
    .split(/[,;\s]+/)
    .map((seg) => seg.trim())
    .filter(Boolean)
    .map((seg) => {
      if (seg.includes('://')) {
        const host = hostOf(seg);
        return host;
      }
      const bare = seg.replace(/\/.*$/, '').toLowerCase();
      return /^[a-z0-9][a-z0-9.-]*(:[0-9]+)?$/.test(bare) ? bare : '';
    })
    .filter(Boolean);
}

/**
 * 我们会去探测的域名集合 = 已知 CDN ∪ 用户在设置里填的那串。
 *
 * 注意它**不是**宿主的白名单本身：宿主那边还有 manifest.netHosts 与默认值，而插件读不到
 * 自己的 manifest。所以这里只能列全（KNOWN_CDN_HOSTS 与 netHosts 的一致性由测试钉住）。
 */
function probeHosts() {
  const extra = parseHostList(cfg.probeHosts);
  return new Set([...KNOWN_CDN_HOSTS, ...extra].map((host) => host.toLowerCase()));
}

function canProbe(url) {
  const host = hostOf(url);
  return Boolean(host) && probeHosts().has(host);
}

/** 接口返回体 → 归一化的一首歌（读不出来就是 {song:null, reason}）。 */
function normalizeSong(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = text(raw.song || raw.title || raw.name, 120).trim();
  const url = httpURL(raw.url || raw.link);
  if (!title || !url) return null;
  return {
    title,
    singer: text(raw.singer || raw.artist, 120).trim(),
    album: text(raw.album, 120).trim(),
    url,
    cover: httpURL(raw.picture || raw.pic || raw.cover),
    bitrate: text(raw.bitrate, 8).trim(),
    format: text(raw.format, 8).trim(),
    size: text(raw.size, 16).trim(),
    // `time` 是秒（"299"），不是毫秒。有些镜像给 duration，两个都认。
    durationSec: clampInt(raw.time || raw.duration, 0, 36000, 0),
    level: text(raw.level, 8).trim(),
  };
}

/**
 * 解析搜索返回。`data` 是对象或数组都认（见文件头第 1 个坑）。
 *
 * 解析不出来**不抛异常**：一次返回体坏了和"没有这首歌"对调用方是同一件事——它会去换一个
 * 写法或者如实说没找到。真正的网络错误才抛。
 */
function parseKuwo(body) {
  let parsed;
  try {
    parsed = JSON.parse(String(body || ''));
  } catch {
    return null;
  }
  const data = parsed && parsed.data;
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  for (const row of rows) {
    const song = normalizeSong(row);
    if (song) return song;
  }
  return null;
}

/** 查一次：返回一首歌或 null。网络/HTTP 问题抛错（调用方决定是回退还是如实报错）。 */
async function searchOnce(name, br, timeoutMs) {
  const url = searchURL(name, br);
  const out = await fetchWithTimeout(url, {
    method: 'GET',
    url,
    headers: { accept: 'application/json' },
  }, Math.max(1000, timeoutMs || API_TIMEOUT_MS), '酷我搜索');
  if (!out || out.status < 200 || out.status >= 300) {
    throw new Error(`酷我搜索返回 HTTP ${out && out.status ? out.status : '?'}（接口地址：${apiBase()}）`);
  }
  return parseKuwo(out.body);
}

/**
 * 试播一下：一次完整 GET，只看状态码。
 *
 * 三种结局都要能说清：
 *   {checked:true,  ok:true,  code}   能播
 *   {checked:true,  ok:false, code}   播不通（404/403 一般是签名过期）
 *   {checked:false, reason:'skip-host'|'error'|'off'}  没验（不是"不能播"）
 */
async function probeLink(url, timeoutMs) {
  if (!canProbe(url)) return { checked: false, reason: 'skip-host' };
  try {
    const out = await fetchWithTimeout(url, { method: 'GET', url }, Math.max(1000, timeoutMs || PROBE_TIMEOUT_MS), '试播');
    const code = out && Number.isFinite(out.status) ? out.status : 0;
    return { checked: true, ok: code === 200 || code === 206, code };
  } catch {
    // 超时、域名不在宿主白名单（我们算错了）、连接被拒：都只是"没验成"。
    return { checked: false, reason: 'error' };
  }
}

/**
 * 把一句话解析成一首歌，并按需要换档重试。
 *
 * 什么时候会多问一次接口：**只有**"探测发现这条链接播不通"时。探测不可用（没开、域名不
 * 在白名单里）就直接用第一条——否则为了"换一条可能更差的链接"多花一次往返，纯粹浪费。
 *
 * @returns {Promise<{song:object|null, tried:Array<{br:number, url:string, probe:object}>, tookMs:number}>}
 */
async function resolveSong({ query, br, timeoutMs } = {}) {
  const name = text(query, 200).trim();
  if (!name) throw new Error('需要一句话去查：歌名，最好带上歌手（例如「晴天 周杰伦」）');
  // 没给预算（undefined / 0）就用默认的 18 秒；给了就按它的来，但至少留 2 秒。
  const budget = timeoutMs ? clampInt(timeoutMs, 2000, 28000, RESOLVE_BUDGET_MS) : RESOLVE_BUDGET_MS;
  const started = now();
  const deadline = started + budget;
  const plan = brPlan(br);
  const tried = [];
  /** 最后一条"有链接但没验通"的候选：三档都不通时，至少还给调用方一个链接，并说明它没验通。 */
  let candidate = null;

  for (let index = 0; index < plan.length; index += 1) {
    const level = plan[index];
    const left = deadline - now();
    // 第一档只要还剩 0.8 秒就值得问一次（预算紧的调用方不该得到"什么都没查"）；
    // 后面几档还要留出探测与换链的时间，所以门槛更高。
    if (left < (index === 0 ? 800 : 2500)) break;
    const song = await searchOnce(name, level, Math.min(left, API_TIMEOUT_MS));
    if (!song) {
      // 接口明确没给这首歌（换码率不会变出结果）：立刻收工，别把三档都问一遍。
      break;
    }
    song.br = level;

    const left2 = deadline - now();
    song.probe = flag('probe', true) && left2 > 1200
      ? await probeLink(song.url, Math.min(left2, PROBE_TIMEOUT_MS))
      : { checked: false, reason: flag('probe', true) ? 'error' : 'off' };
    tried.push({ br: level, url: song.url, probe: song.probe });

    if (!song.probe.checked || song.probe.ok) {
      // 验不了（未知域名）或验通了 → 就是它。验不了时把"未验证"如实写在结果里。
      return { song, tried, tookMs: Math.max(1, now() - started) };
    }
    // 验了、播不通 → 换下一档（换一条签名不同的链接再试）。
    candidate = song;
  }

  return { song: candidate, tried, tookMs: Math.max(1, now() - started) };
}

/** 秒数 → `4:29`。0 或读不出来返回空串（宁可少写一句，也不编一个时长）。 */
function formatDuration(sec) {
  const total = clampInt(sec, 0, 36000, 0);
  if (!total) return '';
  const pad = (x) => `${x}`.padStart(2, '0');
  return `${Math.floor(total / 60)}:${pad(total % 60)}`;
}

/** 探测结果的一句话（给模型读，也给人看）。 */
function describeProbe(probe) {
  if (!probe) return '未验证';
  if (probe.checked) return probe.ok ? `已验证可播（HTTP ${probe.code}）` : `试播失败（HTTP ${probe.code}），链接可能已过期`;
  if (probe.reason === 'off') return '未验证（探测已关掉）';
  if (probe.reason === 'skip-host') return '未验证（这个音频域名不在探测白名单里）';
  return '未验证（试播没有完成）';
}

/**
 * 一首歌 → 给模型读的紧凑文本。
 *
 * WHY 是文本而不是 JSON：记忆核心会把这段拼进 system（≤4000 字），JSON 的括号与引号花的是
 * 同一个预算，换不来任何东西。直链独占一行、不加任何包装，是为了让模型"原样转发"时不会
 * 顺手把一个引号或半个括号带进去。
 */
function renderSongText(song) {
  if (!song) return '';
  const facts = [];
  if (song.album) facts.push(`专辑《${song.album}》`);
  const quality = [song.format, song.bitrate ? `${song.bitrate}kbps` : '', song.size].filter(Boolean).join(' ');
  if (quality) facts.push(quality);
  const dur = formatDuration(song.durationSec);
  if (dur) facts.push(dur);
  const who = song.singer ? `——${song.singer}` : '';
  const lines = [
    `【点歌】「${song.title}」${who}${facts.length ? `（${facts.join('；')}）` : ''}`,
    `直链：${song.url}`,
  ];
  if (song.cover) lines.push(`封面：${song.cover}`);
  lines.push(`链接状态：${describeProbe(song.probe)}`);
  return lines.join('\n');
}

/** 没找到时给模型读的一句话（它据此如实回答，而不是编一首歌）。 */
function renderNotFound(query) {
  return `没有找到「${text(query, 60)}」：酷我那边没有匹配的结果。换一个写法再试（歌名 + 歌手更好命中），不要编造歌名或链接。`;
}
