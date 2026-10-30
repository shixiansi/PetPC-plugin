/*
 * B 站刷视频插件 —— 一份 app.js，两个出场（先例：QQ 插件）。
 *
 *   surface.slot === 'background'  桌宠里的常驻帧。它什么都不画，只负责「到点去看一眼」：
 *                                  宿主只在挂载过的帧里投事件，而一个定时插件最需要的是
 *                                  「没有窗口的时候也活着」。
 *   surface.slot === 'workshop'    插件市场的工坊：状态、单条调试、收件箱、登录、日志。
 *
 * 为什么单文件：包只装 manifest + entry + 三个固定资源（market/tools/package.ps1），
 * `assets` 是给二进制资源的通道，把它当模块系统用会让 MIME 路由和打包规则都为一件小事服务。
 * 所以这里用**分节 banner + 命名前缀**维持可读性：bili* 客户端、sub* 字幕、digest* 摘要、
 * gate* 四道闸、ui* 渲染。
 *
 * 三条不能破的纪律（都写进了 openspec/changes/bilibili-plugin/design.md §10）：
 *   1. Cookie 明文永远不进这个文档：net.fetch 里传的是配置项**名字**，宿主自己填请求头。
 *   2. 字幕原文不落盘：清洗、压缩都在内存里，storage 里只有摘要。
 *   3. 评论是唯一会以主人账号对外说话的路径：默认关，默认只出草稿。
 */

// --- §0 常量与默认值 ---------------------------------------------------------

const PROTOCOL = 1;

/**
 * Bumped by hand while developing, logged once per frame.
 *
 * It answers a question nothing else can: "is the frame running the file I just copied
 * into the data directory, or a cached copy?" A plugin is served from disk by the host,
 * but the WebView in front of it is a browser and browsers cache.
 */
const APP_VERSION = '1.0.0';

/** 一次请求到下一次请求的最小间隔。并发是最容易被判「机器人」的形状。 */
const MIN_GAP_MS = 1200;

/** 字幕切块：每块 180 秒，且单块不超过 3500 字（宿主 llm.chat 的单条上限是 4000）。 */
const CHUNK_SECONDS = 180;
const CHUNK_MAX_RUNES = 3500;

/** map 阶段每块笔记的上限。 */
const NOTE_MAX_RUNES = 250;
/** system 提示词的总上限。宿主自己的上限是 4000，留 100 字余量给措辞。 */
const SYSTEM_MAX_RUNES = 3900;

/** 气泡是一句话，不是一篇摘要。 */
const BUBBLE_MAX_RUNES = 40;
const INBOX_MAX = 200;
const INBOX_PAGE = 20;
const LOG_MAX = 200;
const SEEN_MAX = 2000;
const SEEN_TTL_DAYS = 30;

/** 评论：字数与两次之间的最小间隔固定，不做配置项（见 proposal §5 尾注）。 */
const COMMENT_MAX_RUNES = 60;
const COMMENT_GAP_MS = 30 * 60 * 1000;
/** 风控命中后停多久。连撞只会把窗口拉长。 */
const RISK_PAUSE_MS = 6 * 60 * 60 * 1000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';

/** 接口表：改 B 站接口只需要动这一处。 */
const API_HOST = 'https://api.bilibili.com';
const PASSPORT_HOST = 'https://passport.bilibili.com';
const ENDPOINTS = {
  view: { path: '/x/web-interface/view', sign: false },
  player: { path: '/x/player/wbi/v2', sign: true },
  nav: { path: '/x/web-interface/nav', sign: false },
  ranking: { path: '/x/web-interface/ranking/v2', sign: false },
  region: { path: '/x/web-interface/dynamic/region', sign: false },
  search: { path: '/x/web-interface/wbi/search/type', sign: true },
  space: { path: '/x/space/wbi/arc/search', sign: true },
  tag: { path: '/x/web-interface/view/detail/tag', sign: false },
  replyList: { path: '/x/v2/reply', sign: false },
  replyAdd: { path: '/x/v2/reply/add', sign: false },
  // 取播放流：DASH 给视频轨/音频轨两组地址，durl 给一个整文件。两者都要 wbi 签名。
  playurl: { path: '/x/player/wbi/playurl', sign: true },
  // 扫码登录在 passport 上，不是 api 上。
  qrGenerate: { path: '/x/passport-login/web/qrcode/generate', sign: false, host: PASSPORT_HOST },
  qrPoll: { path: '/x/passport-login/web/qrcode/poll', sign: false, host: PASSPORT_HOST },
};

const STORAGE = {
  state: 'state',
  seen: 'seen',
  inbox: 'inbox',
  usage: 'usage',
  log: 'log',
  wbi: 'wbi',
  qrcode: 'qrcode',
  // 处理失败的候选（内容被审核拒、模型没给 JSON…）。
  //
  // 单独记一份、单独一个 TTL：只写 `seen` 会让一次网络抖动把这条视频永久跳过；
  // 完全不记又会每轮重抓同一批失败品（真机就是这样「次次都是同一批」）。
  failed: 'failed',
};

/** 失败记录的有效期：6 小时内不再取它，之后还给一次机会。 */
const FAILED_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * manifest.json 里声明的默认值的镜像。
 *
 * 由 manifest 提供时以配置为准；这里的值只负责「读不到配置时也能跑」，以及单条调试
 * 不必等配置同步。两处不一致就是两条真相，所以 market/tests 里有一条测试逐项比对它们。
 */
const DEFAULTS = {
  rids: '36,188,181',
  source: 'ranking',
  keywordsInclude: '',
  keywordsExclude: '手游,明星,吃瓜',
  upWhitelist: '',
  upBlacklist: '',
  minDurationSec: '60',
  maxDurationSec: '1800',
  minPlay: '10000',
  persona: '你是一只话少、只讲事实的桌宠助手。自称「我」，不客套、不吹捧、不用「作为一个AI」这类句式。摘要只写视频里真有的内容，没听懂就直说没听懂。',
  preferences: '',
  summaryLength: 'medium',
  pushThreshold: '70',
  llmModel: '',
  llmBaseUrl: '',
  enabled: 'false',
  perRound: '3',
  intervalMinutes: '120',
  activeHours: '09:00-23:00',
  dailyVideoCap: '12',
  pushDailyCap: '5',
  minPushGapMin: '90',
  summaryMaxCalls: '6',
  ownerUID: '',
  biliJct: '',
  commentEnabled: 'false',
  commentMode: 'draft',
  commentMinScore: '85',
  commentMaxPerDay: '2',
};

// --- §1 桥 -------------------------------------------------------------------

const pendingRequests = new Map();
let nextRequestID = 1;

function postToHost(message) {
  if (!window.parent) return;
  window.parent.postMessage({ v: PROTOCOL, ...message }, '*');
}

/**
 * One request to the host.
 *
 * A refusal rejects with the host's own Chinese sentence ("插件 X 未获权限 net.fetch"),
 * and that sentence is shown verbatim: a generic "操作失败" would hide exactly the thing
 * the user has to fix.
 */
function request(method, payload) {
  const id = String(nextRequestID++);
  postToHost({ type: 'request', id, method, payload: payload === undefined ? {} : payload });
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
  });
}

function onResponse(data) {
  const entry = pendingRequests.get(data.id);
  if (!entry) return;
  pendingRequests.delete(data.id);
  if (data.ok) entry.resolve(data.result);
  else entry.reject(new Error(data.error || '宿主拒绝了这次调用'));
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// --- §2 状态与存储 -----------------------------------------------------------

const granted = new Set();
let self = { pluginId: '', surface: {} };
let view = 'workshop';

const state = {
  cfg: { ...DEFAULTS },
  /** secrets 只有 {set, mask}，永远没有明文。 */
  secrets: {},
  /** [{bvid, at, score, title}] */
  seen: [],
  /** 最近处理失败的候选 [{bvid, at, title, reason}]：6 小时内不再取（见 FAILED_TTL_MS） */
  failed: [],
  /** [{id, bvid, title, up, duration, pic, rid, score, summary, points, why, at, draft, comment}] */
  inbox: [],
  /** {'YYYY-MM-DD': {videos, pushes, comments, llmCalls}} */
  usage: {},
  log: [],
  wbi: null,
  nextRunAt: 0,
  lastPushAt: 0,
  lastCommentAt: 0,
  pausedUntil: 0,
  pauseReason: '',
  account: { mid: '', uname: '' },
  roundBusy: false,
  debugBusy: false,
  cmdBusy: false,
  lastCmdId: '',
  shownDebugId: '',
  modelProbeDone: false,
  inboxPage: 0,
  started: false,
  /** The QR login in flight: {key, url, at}. */
  qr: null,
  /** The last report written to storage, so the workshop can draw it. */
  qrReport: null,
  qrTimer: null,
  /** 'qr' | 'paste' — which login card is showing. */
  loginTab: 'qr',
  /** The cross-plugin tray: in-flight guard, answered job ids, once-per-key warnings. */
  shareBusy: false,
  doneJobs: [],
  shareWarned: [],
};

let logWriteInFlight = false;
let logDirty = false;

async function readJSON(key, fallback) {
  try {
    const res = await request('storage.get', { key });
    const raw = String((res && res.value) || '');
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    // A missing or unreadable value is an empty one: the plugin's own first run is the
    // normal case, and a corrupt file must not stop the workshop from opening.
    return fallback;
  }
}

async function writeJSON(key, value) {
  try {
    const raw = JSON.stringify(value);
    if (raw.length > 400000) {
      // storage has no hard cap, but a 10 MB value would make the workshop's first read
      // slow. Refuse the write and say so once, rather than growing forever.
      logLine('warn', `「${key}」已经太大（${raw.length} 字节），这次没有落盘`);
      return false;
    }
    await request('storage.set', { key, value: raw });
    return true;
  } catch (err) {
    logLine('error', `保存「${key}」失败：${err && err.message ? err.message : err}`);
    return false;
  }
}

/** A log line, kept to LOG_MAX and persisted without waiting. */
function logLine(kind, text) {
  const entry = { at: Date.now(), kind, text: String(text) };
  state.log.unshift(entry);
  if (state.log.length > LOG_MAX) state.log.length = LOG_MAX;
  if (view === 'workshop') renderLog();
  logDirty = true;
  void flushLog();
}

/**
 * Writes the log until nothing new arrived while a write was in flight.
 *
 * The first version simply skipped the write when one was in flight, and the real machine
 * showed what that costs: the last line of a session ("命令通道就绪") was recorded in memory
 * and never reached the disk, because the write it would have ridden on had already
 * started. A log whose last line is missing is worse than no log - it reads like the
 * plugin stopped working at that point.
 */
async function flushLog() {
  if (logWriteInFlight) return;
  logWriteInFlight = true;
  try {
    while (logDirty) {
      logDirty = false;
      await writeJSON(STORAGE.log, state.log);
    }
  } finally {
    logWriteInFlight = false;
  }
}

function todayKey(now = Date.now()) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Today's counters, created on demand and trimmed to the last 7 days on save. */
function usageToday(now = Date.now()) {
  const key = todayKey(now);
  if (!state.usage[key]) state.usage[key] = { videos: 0, pushes: 0, comments: 0, llmCalls: 0 };
  return state.usage[key];
}

function trimUsage(now = Date.now()) {
  const keep = new Set();
  for (let i = 0; i < 7; i += 1) keep.add(todayKey(now - i * 24 * 60 * 60 * 1000));
  for (const key of Object.keys(state.usage)) {
    if (!keep.has(key)) delete state.usage[key];
  }
}

/** Small readers, so a string from a config item never becomes `undefined` maths. */
function cfgText(key) {
  const value = state.cfg[key];
  return value === undefined || value === null ? DEFAULTS[key] || '' : String(value);
}

function cfgNum(key, fallback, min, max) {
  const raw = Number(cfgText(key));
  const value = Number.isFinite(raw) ? raw : fallback;
  if (min !== undefined && value < min) return min;
  if (max !== undefined && value > max) return max;
  return value;
}

function cfgFlag(key, fallback) {
  const value = cfgText(key);
  if (value === '') return fallback;
  return value.toLowerCase() === 'true';
}

function cfgList(key) {
  return cfgText(key)
    .split(/[,，;；\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

// --- §3 B 站客户端 -----------------------------------------------------------

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42,
  19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51,
  30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

/**
 * MD5.
 *
 * Hand-written because SubtleCrypto has no MD5 and B 站的 wbi signature is MD5 over a
 * reordered key + query. Input is UTF-8 encoded first: `md5('中文')` must hash six
 * bytes, not four UTF-16 chars - the classic way this breaks for Chinese values and
 * only for Chinese values, which makes it look like a key problem at the far end.
 */
function md5(text) {
  const bytes = new TextEncoder().encode(String(text));
  const size = bytes.length;
  const padded = new Uint8Array((((size + 8) >>> 6) + 1) << 6);
  padded.set(bytes);
  padded[size] = 0x80;
  const view16 = new DataView(padded.buffer);
  view16.setUint32(padded.length - 8, (size * 8) >>> 0, true);
  view16.setUint32(padded.length - 4, Math.floor((size * 8) / 0x100000000) >>> 0, true);

  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i += 1) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
  }
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const M = new Uint32Array(16);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let j = 0; j < 16; j += 1) M[j] = view16.getUint32(offset + j * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f;
      let g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const sum = (a + f + K[i] + M[g]) >>> 0;
      const shifted = ((sum << S[i]) | (sum >>> (32 - S[i]))) >>> 0;
      const next = (b + shifted) >>> 0;
      a = d;
      d = c;
      c = b;
      b = next;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return Array.from(out, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function mixinKey(imgKey, subKey) {
  return MIXIN_TAB.map((index) => (imgKey + subKey).charAt(index)).join('').slice(0, 32);
}

/**
 * The wbi query string for one call.
 *
 * Values are stripped of `!'()*` BEFORE encoding and keys are sorted, both because that
 * is what the server does when it recomputes the signature: a client that skips either
 * step gets -403 on every signed endpoint and no hint about which rule it broke.
 */
function encWbi(params, imgKey, subKey, wts) {
  const stamp = wts === undefined ? Math.floor(Date.now() / 1000) : wts;
  const all = { ...params, wts: stamp };
  const query = Object.keys(all)
    .sort()
    .map((key) => {
      const value = String(all[key] === undefined || all[key] === null ? '' : all[key]).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    })
    .join('&');
  return `${query}&w_rid=${md5(query + mixinKey(imgKey, subKey))}`;
}

function queryString(params) {
  return Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== '')
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]))}`)
    .join('&');
}

class BiliError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = 'BiliError';
    this.code = code;
    this.hint = hint || '';
  }
}

/**
 * The B 站 error codes worth naming.
 *
 * `-352/-412/-509` mean "you are being rate limited or risk-controlled" and must stop the
 * round rather than be retried: retrying is what extends the window. `-101` is not an
 * error at all - it is "not logged in", which the caller turns into a state.
 */
function biliErrorFor(code, message) {
  const text = String(message || '');
  switch (code) {
    case -101:
      return new BiliError(code, '需要登录', '这个接口要求登录态');
    case -352:
      return new BiliError(code, '被风控拦下了（-352）', '降低频率或稍后再试');
    case -412:
      return new BiliError(code, '请求被限制（-412）', '通常是请求太密');
    case -509:
      return new BiliError(code, '超出限制（-509）', '今天先别刷了');
    case -400:
      return new BiliError(code, `请求参数不对：${text}`, '');
    case -404:
    case 62002:
      return new BiliError(code, '视频不存在或不可见', '');
    case -403:
      return new BiliError(code, '签名或权限不对（-403）', 'wbi 可能已经变化');
    default:
      return new BiliError(code, text || `接口返回 ${code}`, '');
  }
}

function isRiskCode(code) {
  return code === -352 || code === -412 || code === -509 || code === 412;
}

let lastCallAt = 0;

/**
 * Serialises one call at a time, >= MIN_GAP_MS apart, with a little jitter.
 *
 * `state.minGapMs` exists ONLY so a test can zero the politeness delay: a behaviour test
 * that waited 1.2 s per request would take half a minute to run the pipeline. Nothing in
 * the shipped plugin ever assigns it.
 */
async function throttle() {
  const gap = typeof state.minGapMs === 'number' ? state.minGapMs : MIN_GAP_MS;
  const now = Date.now();
  const earliest = lastCallAt + gap + Math.floor(Math.random() * 300 * (gap ? 1 : 0));
  if (now < earliest) await sleep(earliest - now);
  lastCallAt = Date.now();
}

/**
 * One net.fetch, returning the whole reply: body, status and (optionally) cookies.
 *
 * `credentials: 'biliCookie'` is a CONFIG KEY, not a value: the host reads the secret's
 * plaintext from encrypted storage and sets the Cookie header itself, so nothing in this
 * document ever sees it. The Referer goes through the same allow-list check on the host
 * side, which is why `www.bilibili.com` is in netHosts.
 *
 * `readCookies` is the one flow that needs the RESPONSE headers: B 站's QR login answers
 * "success" with the session in Set-Cookie and nothing usable in the body. The host
 * reduces them to `name=value` pairs and requires net.credentials for it.
 */
async function httpRaw(url, options) {
  const opts = options || {};
  await throttle();
  const payload = {
    method: opts.method || 'GET',
    url,
    headers: { 'user-agent': UA, ...(opts.headers || {}) },
    referer: REFERER,
  };
  if (opts.body !== undefined) payload.body = opts.body;
  if (opts.credentials) payload.credentials = opts.credentials;
  if (opts.readCookies) payload.readCookies = true;
  if (opts.contentType) payload.headers['content-type'] = opts.contentType;
  const res = await request('net.fetch', payload);
  const status = Number((res && res.status) || 0);
  if (status >= 400) {
    throw new BiliError(status, `HTTP ${status}`, status === 412 ? '请求被限制' : '');
  }
  return {
    status,
    body: String((res && res.body) || ''),
    cookies: Array.isArray(res && res.cookies) ? res.cookies.map((item) => String(item)) : [],
  };
}

async function httpText(url, options) {
  const res = await httpRaw(url, options);
  return res.body;
}

/**
 * Parses one B 站 reply.
 *
 * `allowCodes` exists because B 站 says `code: -101` ("账号未登录") on a reply that is
 * still USEFUL: `nav` answers -101 and yet carries `data.wbi_img`, and without those keys
 * no signed endpoint works at all. Treating every non-zero code as fatal would make the
 * whole subtitle path fail for every user who never logged in - which is almost everyone.
 */
function parseBiliJSON(text, allowCodes) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BiliError(-1, '返回的不是 JSON', '接口可能变了，或被风控页拦了');
  }
  const code = parsed && typeof parsed.code === 'number' ? parsed.code : 0;
  if (code !== 0 && !(allowCodes && allowCodes.indexOf(code) >= 0)) {
    throw biliErrorFor(parsed.code, parsed.message || parsed.msg);
  }
  return parsed;
}

/** wbi keys, cached for 30 minutes in memory and on disk (a restart should not refetch). */
async function wbiKeys(force) {
  const now = Date.now();
  if (!force && state.wbi && state.wbi.exp > now) return state.wbi;
  if (!force && !state.wbi) {
    const stored = await readJSON(STORAGE.wbi, null);
    if (stored && stored.exp > now && stored.img && stored.sub) {
      state.wbi = stored;
      return stored;
    }
  }
  // Deliberately WITHOUT credentials: `nav` hands out the wbi key pair to anonymous
  // callers, and requiring a login to sign a request would make every subtitle fail for
  // a user who never logged in - i.e. for almost everyone.
  //
  // It answers `code: -101` ("账号未登录") WITH the keys in `data`, so -101 is tolerated
  // here: the keys are the point, the login state is not.
  const data = await biliGet('nav', {}, { allowCodes: [-101] });
  const image = data && data.data && data.data.wbi_img;
  if (!image || !image.img_url || !image.sub_url) {
    throw new BiliError(-1, '拿不到 wbi key', 'nav 的返回里没有 wbi_img');
  }
  const base = (url) => String(url).slice(String(url).lastIndexOf('/') + 1).replace(/\.\w+$/, '');
  const keys = { img: base(image.img_url), sub: base(image.sub_url), exp: now + 30 * 60 * 1000 };
  state.wbi = keys;
  void writeJSON(STORAGE.wbi, keys);
  return keys;
}

/**
 * One API call.
 *
 * `credentials: true` asks the host to send the stored cookie, which is only meaningful
 * for `nav` (to learn who we are) and the comment endpoint. Everything else is public.
 */
async function biliGet(name, params, options) {
  const opts = options || {};
  const endpoint = ENDPOINTS[name];
  if (!endpoint) throw new Error(`未知接口：${name}`);
  const credentials = opts.credentials ? 'biliCookie' : '';
  const base = endpoint.host || API_HOST;
  let url;
  if (endpoint.sign) {
    const keys = await wbiKeys();
    url = `${base}${endpoint.path}?${encWbi(params || {}, keys.img, keys.sub)}`;
  } else {
    const query = queryString(params || {});
    url = `${base}${endpoint.path}${query ? `?${query}` : ''}`;
  }
  let raw;
  try {
    raw = await httpRaw(url, { credentials, readCookies: opts.readCookies });
  } catch (err) {
    if (err && err.code === -403 && endpoint.sign) {
      // A stale key pair is the one failure worth exactly one retry: refetch, re-sign,
      // and if that fails too, report it rather than looping.
      const keys = await wbiKeys(true);
      const retry = `${base}${endpoint.path}?${encWbi(params || {}, keys.img, keys.sub)}`;
      raw = await httpRaw(retry, { credentials, readCookies: opts.readCookies });
    } else {
      throw err;
    }
  }
  const parsed = parseBiliJSON(raw.body, opts.allowCodes);
  if (opts.readCookies) parsed.__cookies = raw.cookies;
  return parsed;
}

/** POST form body, with the cookie injected by the host. */
async function biliPostForm(name, form, options) {
  const opts = options || {};
  const endpoint = ENDPOINTS[name];
  if (!endpoint) throw new Error(`未知接口：${name}`);
  const body = new URLSearchParams(form).toString();
  const text = await httpText(`https://api.bilibili.com${endpoint.path}`, {
    method: 'POST',
    body,
    contentType: 'application/x-www-form-urlencoded',
    credentials: opts.credentials ? 'biliCookie' : '',
  });
  return parseBiliJSON(text);
}

// --- §3.5 二维码（扫码登录用） ------------------------------------------------

/**
 * 为什么自己写编码器。
 *
 * B 站扫码登录给的是一个 **URL**（`account.bilibili.com/...?qrcode_key=…`），要变成能扫的
 * 图形只有三条路：① 打包一个 JS 库——包里只装四个固定文件（`package.ps1`），装不进来；
 * ② 让第三方服务渲染——等于把 `qrcode_key` 发给别人，而那个 key 就是登录权，绝对不行；
 * ③ 自己在插件里编码。所以是 ③。
 *
 * 只做**必要的那一档**：byte 模式、纠错等级 M、版本 1–12（131 字的登录 URL 落在 v8），
 * 足够覆盖登录二维码，也不需要支持汉字模式——内容本来就是 URL。
 *
 * 正确性不靠「看起来像」：`market/tests/plugin-bilibili.test.js` 拿本机另一个仓库里真实存在的
 * `qrcode` 包离线生成的矩阵做夹具，逐位比对（v1/v2/v8 与实际登录 URL）。
 */
const QR_TOTAL_CW = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466];
const QR_M_ECC = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22];
const QR_M_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8];
const QR_ALIGN = [
  null, [],
  [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58],
];

/** GF(256) 上的乘法，本原多项式 0x11d（QR 规范的那一个）。 */
function gfMul(a, b) {
  let result = 0;
  let x = a;
  let y = b;
  while (y) {
    if (y & 1) result ^= x;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
    y >>= 1;
  }
  return result & 0xff;
}

const GF_EXP = (() => {
  const table = new Array(256).fill(0);
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    table[i] = value;
    value = gfMul(value, 2);
  }
  return table;
})();

/** Reed–Solomon 余数，也就是一个块的纠错码字。 */
function rsEcc(data, eccLen) {
  let gen = [1];
  for (let i = 0; i < eccLen; i += 1) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j += 1) {
      next[j] ^= gen[j];
      next[j + 1] ^= gfMul(gen[j], GF_EXP[i]);
    }
    gen = next;
  }
  const remainder = new Array(eccLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    for (let i = 0; i < eccLen; i += 1) remainder[i] ^= gfMul(gen[i + 1], factor);
  }
  return remainder;
}

function qrDataCodewords(version) {
  return QR_TOTAL_CW[version] - QR_M_ECC[version] * QR_M_BLOCKS[version];
}

/** Byte 模式的字符计数位数：v1–9 是 8 位，v10 起是 16 位。 */
function qrCountBits(version) {
  return version < 10 ? 8 : 16;
}

function qrPickVersion(byteLength) {
  for (let version = 1; version < QR_TOTAL_CW.length; version += 1) {
    const capacityBits = qrDataCodewords(version) * 8;
    if (4 + qrCountBits(version) + byteLength * 8 <= capacityBits) return version;
  }
  throw new Error('这段内容太长，二维码放不下');
}

/** 15 位格式信息：2 位纠错等级 + 3 位掩码，加 BCH(15,5)，再异或 0x5412。 */
function qrFormatBits(eccBits, mask) {
  const data = (eccBits << 3) | mask;
  let remainder = data << 10;
  for (let i = 4; i >= 0; i -= 1) {
    if ((remainder >> (10 + i)) & 1) remainder ^= 0x537 << i;
  }
  return ((data << 10) | remainder) ^ 0x5412;
}

/** 18 位版本信息（v7 起）：6 位版本号 + BCH(18,6)。 */
function qrVersionBits(version) {
  let remainder = version << 12;
  for (let i = 5; i >= 0; i -= 1) {
    if ((remainder >> (12 + i)) & 1) remainder ^= 0x1f25 << i;
  }
  return (version << 12) | remainder;
}

function qrMaskBit(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

/** 规范里那四条罚分，用来挑掩码；挑错不会让码失效，但会难扫。 */
function qrPenalty(rows, size) {
  let score = 0;
  const at = (x, y) => rows[y][x];
  for (let y = 0; y < size; y += 1) {
    let run = 1;
    for (let x = 1; x < size; x += 1) {
      if (at(x, y) === at(x - 1, y)) run += 1;
      else { if (run >= 5) score += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  for (let x = 0; x < size; x += 1) {
    let run = 1;
    for (let y = 1; y < size; y += 1) {
      if (at(x, y) === at(x, y - 1)) run += 1;
      else { if (run >= 5) score += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const colour = at(x, y);
      if (colour === at(x + 1, y) && colour === at(x, y + 1) && colour === at(x + 1, y + 1)) score += 3;
    }
  }
  const pattern = [true, false, true, true, true, false, true];
  const looks = (get) => {
    for (let i = 0; i < 7; i += 1) if (get(i) !== pattern[i]) return false;
    return true;
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x + 7 <= size; x += 1) {
      if (looks((i) => at(x + i, y))) {
        const before = x >= 4 && [1, 2, 3, 4].every((d) => at(x - d, y) === false);
        const after = x + 11 <= size && [7, 8, 9, 10].every((d) => at(x + d, y) === false);
        if (before || after) score += 40;
      }
    }
  }
  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y + 7 <= size; y += 1) {
      if (looks((i) => at(x, y + i))) {
        const before = y >= 4 && [1, 2, 3, 4].every((d) => at(x, y - d) === false);
        const after = y + 11 <= size && [7, 8, 9, 10].every((d) => at(x, y + d) === false);
        if (before || after) score += 40;
      }
    }
  }
  let dark = 0;
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (at(x, y)) dark += 1;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

/**
 * The final codeword stream for one text: data codewords, then the interleaved ECC.
 *
 * Split out of `qrMatrix` so it can be checked on its own: the Reed–Solomon layer is the
 * one part whose mistakes are invisible in the finished picture (a code with bad ECC still
 * looks like a QR code, it just does not scan).
 */
function qrCodewords(text, version) {
  const bytes = Array.from(new TextEncoder().encode(String(text)));
  const target = version || qrPickVersion(bytes.length);
  const eccLen = QR_M_ECC[target];
  const blockCount = QR_M_BLOCKS[target];
  const dataCapacity = qrDataCodewords(target);

  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };
  push(0b0100, 4); // byte 模式
  push(bytes.length, qrCountBits(target));
  for (const byte of bytes) push(byte, 8);
  const capacityBits = dataCapacity * 8;
  push(0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const dataCw = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i + j];
    dataCw.push(value);
  }
  const pads = [0xec, 0x11];
  for (let i = 0; dataCw.length < dataCapacity; i += 1) dataCw.push(pads[i % 2]);

  const shortLen = Math.floor(dataCapacity / blockCount);
  const longCount = dataCapacity - shortLen * blockCount;
  const dataBlocks = [];
  const eccBlocks = [];
  let offset = 0;
  for (let i = 0; i < blockCount; i += 1) {
    const length = shortLen + (i >= blockCount - longCount ? 1 : 0);
    const block = dataCw.slice(offset, offset + length);
    offset += length;
    dataBlocks.push(block);
    eccBlocks.push(rsEcc(block, eccLen));
  }
  const codewords = [];
  const widest = Math.max(...dataBlocks.map((block) => block.length));
  for (let i = 0; i < widest; i += 1) {
    for (const block of dataBlocks) if (i < block.length) codewords.push(block[i]);
  }
  for (let i = 0; i < eccLen; i += 1) {
    for (const block of eccBlocks) codewords.push(block[i]);
  }
  return { version: target, dataCw, dataBlocks, eccBlocks, codewords };
}

/**
 * One QR matrix.
 *
 * Returns rows of booleans, so the workshop can draw it with an `<svg>` path and the tests
 * can compare it bit for bit against the reference fixtures.
 */
function qrMatrix(text, options) {
  const opts = options || {};
  const bytes = Array.from(new TextEncoder().encode(String(text)));
  const version = opts.version || qrPickVersion(bytes.length);
  if (!QR_TOTAL_CW[version]) throw new Error(`不支持的二维码版本 ${version}`);
  const size = version * 4 + 17;
  const codewords = qrCodewords(text, version).codewords;

  // ③ 功能图形
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const place = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y][x] = dark;
    reserved[y][x] = true;
  };
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        place(cx + dx, cy + dy, ring !== 2 && ring !== 4);
      }
    }
  }
  for (let i = 8; i < size - 8; i += 1) {
    place(i, 6, i % 2 === 0);
    place(6, i, i % 2 === 0);
  }
  const align = QR_ALIGN[version] || [];
  for (const cy of align) {
    for (const cx of align) {
      const onFinder = (cx === 6 && cy === 6)
        || (cx === 6 && cy === size - 7)
        || (cx === size - 7 && cy === 6);
      if (onFinder) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          place(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
  // 格式信息占位（之后再写真实比特）
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      place(8, i, false);
      place(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i += 1) {
    place(8, size - 1 - i, false);
    place(size - 1 - i, 8, false);
  }
  place(8, size - 8, true); // 永远的暗模块
  if (version >= 7) {
    const info = qrVersionBits(version);
    for (let i = 0; i < 18; i += 1) {
      const bit = ((info >> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      place(a, b, bit);
      place(b, a, bit);
    }
  }

  // ④ 数据按之字形填进去（跳过功能模块）
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  const nextBit = () => {
    const value = (codewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
    bitIndex += 1;
    return value === 1;
  };
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (reserved[y][x]) continue;
        modules[y][x] = bitIndex < totalBits ? nextBit() : false;
      }
    }
  }

  // ⑤ 掩码（挑罚分最低的那个）
  const applyMask = (mask) => {
    const rows = modules.map((row) => row.slice());
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (!reserved[y][x] && qrMaskBit(mask, x, y)) rows[y][x] = !rows[y][x];
      }
    }
    return rows;
  };
  const writeFormat = (rows, mask) => {
    const info = qrFormatBits(0, mask); // eccBits 0 = 等级 M
    const bit = (i) => ((info >> i) & 1) === 1;
    for (let i = 0; i <= 5; i += 1) rows[i][8] = bit(i);
    rows[7][8] = bit(6);
    rows[8][8] = bit(7);
    rows[8][7] = bit(8);
    for (let i = 9; i < 15; i += 1) rows[8][14 - i] = bit(i);
    for (let i = 0; i < 8; i += 1) rows[8][size - 1 - i] = bit(i);
    for (let i = 8; i < 15; i += 1) rows[size - 15 + i][8] = bit(i);
    rows[size - 8][8] = true;
    return rows;
  };

  if (opts.mask !== undefined) return writeFormat(applyMask(opts.mask), opts.mask);
  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    const rows = writeFormat(applyMask(mask), mask);
    const score = qrPenalty(rows, size);
    if (score < bestScore) {
      bestScore = score;
      best = rows;
    }
  }
  return best;
}

/**
 * The function-module map for one version, exposed so a test can read a matrix back.
 *
 * It is the other half of the placement contract: `qrMatrix` writes data only into
 * `reserved === false` cells in the documented zigzag order, and a test that reads a
 * REFERENCE matrix with this same map proves the two agree about which cells carry data.
 */
function qrReservedMap(version) {
  const size = version * 4 + 17;
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (x, y) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    reserved[y][x] = true;
  };
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) mark(cx + dx, cy + dy);
    }
  }
  for (let i = 8; i < size - 8; i += 1) {
    mark(i, 6);
    mark(6, i);
  }
  const align = QR_ALIGN[version] || [];
  for (const cy of align) {
    for (const cx of align) {
      const onFinder = (cx === 6 && cy === 6)
        || (cx === 6 && cy === size - 7)
        || (cx === size - 7 && cy === 6);
      if (onFinder) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) mark(cx + dx, cy + dy);
      }
    }
  }
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      mark(8, i);
      mark(i, 8);
    }
  }
  for (let i = 0; i < 8; i += 1) {
    mark(8, size - 1 - i);
    mark(size - 1 - i, 8);
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      mark(a, b);
      mark(b, a);
    }
  }
  return { size, reserved };
}

/** Reads the codewords back out of a matrix, in the same order `qrMatrix` wrote them. */
function qrReadCodewords(rows, version, mask) {
  const { size, reserved } = qrReservedMap(version);
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (reserved[y][x]) continue;
        let dark = rows[y][x];
        if (qrMaskBit(mask, x, y)) dark = !dark;
        bits.push(dark ? 1 : 0);
      }
    }
  }
  const codewords = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i + j];
    codewords.push(value);
  }
  return codewords;
}

/** The SVG the workshop draws: one path, no external anything. */
function qrSvgPath(rows, size) {
  const parts = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (rows[y][x]) parts.push(`M${x} ${y}h1v1h-1z`);
    }
  }
  return parts.join('');
}

// --- §4 候选与本地初筛 -------------------------------------------------------

/**
 * One list entry, normalised.
 *
 * The four sources return four different shapes (`owner.mid` vs `mid`, `stat.view` vs
 * `play`, `pubdate` vs `created`), and every later stage would otherwise carry four
 * branches. Anything that is not a BV id is dropped here rather than three functions
 * later, because a wrong id becomes a 404 in the middle of a paid round.
 */
function normaliseItem(raw, rid) {
  if (!raw || typeof raw !== 'object') return null;
  const bvid = String(raw.bvid || '').trim();
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return null;
  const owner = raw.owner || {};
  return {
    bvid,
    title: String(raw.title || '').trim(),
    up: String(owner.name || raw.author || raw.uname || '').trim(),
    upMid: String(owner.mid || raw.mid || raw.uid || ''),
    duration: Number(raw.duration || 0),
    pic: String(raw.pic || raw.cover || raw.first_frame || ''),
    play: Number((raw.stat && raw.stat.view) || raw.play || 0),
    pubdate: Number(raw.pubdate || raw.created || 0),
    rid: String(raw.rid || raw.typeid || rid || ''),
    tname: String(raw.tname || ''),
  };
}

async function fetchSource(name, cfg) {
  const items = [];
  const rids = cfgList('rids').slice(0, 4);
  if (name === 'ranking' || name === 'region') {
    if (!rids.length) throw new Error('没有配置分区（rids）');
    for (const rid of rids) {
      const data = name === 'ranking'
        ? await biliGet('ranking', { rid, type: 'all' })
        : await biliGet('region', { rid, pn: 1, ps: 20 });
      const payload = (data && data.data) || {};
      const list = payload.list || payload.archives || [];
      for (const raw of list) {
        const item = normaliseItem(raw, rid);
        if (item) items.push(item);
      }
    }
  } else if (name === 'search') {
    const words = cfgList('keywordsInclude').slice(0, 3);
    if (!words.length) {
      logLine('warn', '来源里有 search，但「必须包含的关键词」是空的，这个来源这一轮跳过');
      return items;
    }
    for (const word of words) {
      const data = await biliGet('search', { search_type: 'video', keyword: word, page: 1, page_size: 20 });
      const list = (data && data.data && data.data.result) || [];
      for (const raw of list) {
        const item = normaliseItem(raw, '');
        if (item) items.push(item);
      }
    }
  } else if (name === 'up') {
    const mids = cfgList('upWhitelist').slice(0, 4);
    if (!mids.length) {
      logLine('warn', '来源里有 up，但 UP 白名单是空的，这个来源这一轮跳过');
      return items;
    }
    for (const mid of mids) {
      const data = await biliGet('space', { mid, pn: 1, ps: 10, order: 'pubdate' });
      const list = (data && data.data && data.data.list && data.data.list.vlist) || [];
      for (const raw of list) {
        const item = normaliseItem(raw, '');
        if (item) items.push(item);
      }
    }
  } else {
    logLine('warn', `未知来源 ${name}，跳过`);
  }
  return items;
}

/**
 * Six local rules, no network and no money.
 *
 * The order is deliberate: the cheapest and most common reasons come first so the
 * `dropped` tally in the log explains the round in the same order the user reads it.
 */
function filterCandidates(items, seen) {
  const include = cfgList('keywordsInclude').map((word) => word.toLowerCase());
  const exclude = cfgList('keywordsExclude').map((word) => word.toLowerCase());
  const upBlock = new Set(cfgList('upBlacklist'));
  const upAllow = new Set(cfgList('upWhitelist'));
  const ownerUID = cfgText('ownerUID').trim();
  const minDur = cfgNum('minDurationSec', 60, 0);
  const maxDur = cfgNum('maxDurationSec', 1800, 1);
  const minPlay = cfgNum('minPlay', 0, 0);
  const picked = [];
  const dropped = { dup: 0, seen: 0, own: 0, up: 0, duration: 0, play: 0, keyword: 0 };
  const walked = new Set();

  for (const item of items) {
    if (walked.has(item.bvid)) {
      dropped.dup += 1;
      continue;
    }
    walked.add(item.bvid);
    if (seen.has(item.bvid)) {
      dropped.seen += 1;
      continue;
    }
    if (ownerUID && item.upMid === ownerUID) {
      dropped.own += 1;
      continue;
    }
    if (upBlock.has(item.upMid)) {
      dropped.up += 1;
      continue;
    }
    if (upAllow.size && !upAllow.has(item.upMid)) {
      dropped.up += 1;
      continue;
    }
    if (item.duration < minDur || item.duration > maxDur) {
      dropped.duration += 1;
      continue;
    }
    if (minPlay > 0 && item.play < minPlay) {
      dropped.play += 1;
      continue;
    }
    const title = item.title.toLowerCase();
    if (exclude.some((word) => title.includes(word))) {
      dropped.keyword += 1;
      continue;
    }
    if (include.length && !include.some((word) => title.includes(word))) {
      dropped.keyword += 1;
      continue;
    }
    picked.push(item);
  }

  // Newest first, then most played. "新" leads because a recommendation that is a week
  // old is usually a recommendation the user already saw somewhere else.
  picked.sort((a, b) => (b.pubdate - a.pubdate) || (b.play - a.play));
  return { picked, dropped };
}

function seenSet(now) {
  const at = now || Date.now();
  const cutoff = at - SEEN_TTL_DAYS * 24 * 60 * 60 * 1000;
  const set = new Set(state.seen.filter((row) => row && row.at >= cutoff).map((row) => row.bvid));
  // 最近失败的也排除：失败不写 seen（免得一次网络抖动就永久跳过），但也不能每轮重抓。
  const failedCutoff = at - FAILED_TTL_MS;
  for (const row of state.failed || []) {
    if (row && row.bvid && row.at >= failedCutoff) set.add(row.bvid);
  }
  return set;
}

function rememberSeen(rows, score, now) {
  const at = now || Date.now();
  for (const row of rows) {
    state.seen.unshift({ bvid: row.bvid, at, score: score === undefined ? 0 : score, title: String(row.title || '').slice(0, 80) });
    // 成功了就把失败记录清掉：同一条视频不该既「成功过」又「失败过」。
    state.failed = (state.failed || []).filter((entry) => entry && entry.bvid !== row.bvid);
  }
  const cutoff = at - SEEN_TTL_DAYS * 24 * 60 * 60 * 1000;
  state.seen = state.seen.filter((entry) => entry && entry.at >= cutoff).slice(0, SEEN_MAX);
}

/** 记一条失败：6 小时内不再取它（TTL 见 FAILED_TTL_MS）。 */
function rememberFailure(row, reason, now) {
  const at = now || Date.now();
  const bvid = String((row && row.bvid) || '');
  if (!bvid) return;
  state.failed = [
    { bvid, at, title: String((row && row.title) || '').slice(0, 80), reason: String(reason || '').slice(0, 120) },
    ...(state.failed || []).filter((entry) => entry && entry.bvid !== bvid),
  ].slice(0, 200);
}

// --- §5 字幕：三步接口 -------------------------------------------------------

function runeLen(text) {
  return Array.from(String(text === undefined || text === null ? '' : text)).length;
}

function truncateRunes(text, max) {
  const chars = Array.from(String(text === undefined || text === null ? '' : text));
  if (chars.length <= max) return chars.join('');
  return chars.slice(0, max).join('');
}

async function fetchVideoInfo(bvid) {
  const data = await biliGet('view', { bvid });
  const d = (data && data.data) || {};
  const pages = Array.isArray(d.pages) ? d.pages : [];
  const cid = Number(d.cid || (pages[0] && pages[0].cid) || 0);
  if (!cid) throw new BiliError(-1, '这条视频没有 cid', '可能是多 P 视频或已失效');
  return {
    bvid,
    aid: Number(d.aid || 0),
    cid,
    title: String(d.title || ''),
    desc: String(d.desc || ''),
    duration: Number(d.duration || 0),
    tname: String(d.tname || ''),
    pic: String(d.pic || ''),
    up: String((d.owner && d.owner.name) || ''),
    upMid: String((d.owner && d.owner.mid) || ''),
    play: Number((d.stat && d.stat.view) || 0),
  };
}

/**
 * The subtitle tracks of one video.
 *
 * `loggedIn` is not decoration: as of this writing B 站 answers an ANONYMOUS
 * `player/wbi/v2` with `subtitles: []` for every video tried (20/20 across four
 * partitions), and the old `need_login_subtitle` flag is no longer in the reply at all.
 * So "no tracks" has two very different meanings - "this video has no CC" and "you are
 * not logged in" - and only the caller knows which one it is looking at, because only the
 * caller knows whether a credential exists. The plugin says so in the card instead of
 * pretending the first.
 */
async function fetchSubtitleTracks(bvid, cid) {
  const params = { bvid, cid };
  // 带凭据：字幕轨列表对匿名请求基本是空的（真机 20/20 条都是 0 轨），登录之后才有。
  // 和 `playurl` 是同一个坑 —— 第一版两处都忘了带，于是每条视频都走「非字幕」降级。
  let data;
  try {
    data = await biliGet('player', params, { credentials: true });
  } catch (err) {
    const message = String((err && err.message) || '');
    if (message.includes('凭据') || message.includes('未保存') || message.includes('还没有保存')) {
      logLine('warn', `取字幕轨没带凭据（${message}），这一条大概率没有字幕`);
      data = await biliGet('player', params, {});
    } else {
      throw err;
    }
  }
  const sub = (data && data.data && data.data.subtitle) || {};
  const tracks = (Array.isArray(sub.subtitles) ? sub.subtitles : [])
    .map((item) => ({
      lan: String(item.lan || ''),
      lanDoc: String(item.lan_doc || ''),
      aiType: Number(item.ai_type || 0),
      url: String(item.subtitle_url || ''),
    }))
    .filter((track) => track.url);
  return {
    tracks,
    loggedIn: Boolean(state.secrets && state.secrets.biliCookie && state.secrets.biliCookie.set),
  };
}

/** The track to read: human Chinese first, then AI Chinese, then any Chinese, then first. */
function pickTrack(tracks) {
  const exact = (lan) => tracks.find((track) => track.lan === lan);
  return exact('zh-CN')
    || exact('zh-Hans')
    || exact('ai-zh')
    || tracks.find((track) => /^zh/i.test(track.lan))
    || tracks.find((track) => /中文/.test(track.lanDoc))
    || tracks[0]
    || null;
}

async function fetchSubtitleBody(url) {
  // `subtitle_url` comes back protocol-relative (`//aisubtitle…`), and a URL without a
  // scheme is not http(s) - the host would refuse it before it ever left the process.
  const full = url.startsWith('//') ? `https:${url}` : url;
  const text = await httpText(full, {});
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BiliError(-1, '字幕文件不是 JSON', '这条字幕可能已经过期');
  }
  const body = Array.isArray(parsed && parsed.body) ? parsed.body : [];
  return body.map((seg) => ({
    from: Number(seg.from || 0),
    to: Number(seg.to || 0),
    content: String(seg.content || ''),
  }));
}

/**
 * Drop the noise a subtitle layer carries: `[音乐]`, `[掌声]`, `♪`, doubled spaces.
 *
 * The bracket rule is bounded to 1–12 characters on purpose: it eats the annotation
 * tokens that are pure noise, and leaves a bracketed phrase inside a sentence alone.
 */
function stripTags(text) {
  return String(text || '')
    .replace(/\[[^\]]{1,12}\]/g, ' ')
    .replace(/[♪♫]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Join the subtitle's fragments into sentence-ish segments.
 *
 * Auto-generated subtitles arrive in 2–4 second pieces that break mid-clause, so a
 * summary of them reads like a telegram. Two pieces are merged when the gap is under
 * 400 ms AND the earlier one does not end on punctuation - the second condition is what
 * keeps a full stop a boundary.
 */
function mergeSegments(segments, gapMs) {
  const gap = gapMs === undefined ? 400 : gapMs;
  const merged = [];
  for (const seg of segments) {
    const content = stripTags(seg.content);
    if (!content) continue;
    const prev = merged[merged.length - 1];
    if (prev && (seg.from - prev.to) * 1000 < gap && !/[。！？…!?]$/.test(prev.content)) {
      prev.content += content;
      prev.to = seg.to;
    } else {
      merged.push({ from: seg.from, to: seg.to, content });
    }
  }
  return merged;
}

/**
 * Cut the merged segments into digest-sized chunks.
 *
 * Cutting happens on segment boundaries, which after `mergeSegments` are punctuation
 * boundaries - a chunk therefore never starts or ends mid-sentence, and the chunk cap is
 * what keeps a single `llm.chat` under the host's 4000-rune limit.
 */
function chunkSegments(segments, options) {
  const opts = options || {};
  const seconds = opts.seconds || CHUNK_SECONDS;
  const maxRunes = opts.maxRunes || CHUNK_MAX_RUNES;
  const chunks = [];
  let current = { from: 0, to: 0, parts: [], runes: 0 };
  const flush = () => {
    if (!current.parts.length) return;
    chunks.push({ from: current.from, to: current.to, text: current.parts.join('') });
    current = { from: 0, to: 0, parts: [], runes: 0 };
  };
  for (const seg of segments) {
    if (!current.parts.length) current.from = seg.from;
    current.parts.push(seg.content);
    current.runes += runeLen(seg.content);
    current.to = seg.to;
    if (current.to - current.from >= seconds || current.runes >= maxRunes) flush();
  }
  flush();
  return chunks;
}

/**
 * The material used when there is no readable subtitle track.
 *
 * Deliberately NOT audio-to-text: that is tens of megabytes plus a local model or a paid
 * service, and the caller is told the digest is second-hand so it cannot pretend it
 * heard the video.
 */
async function fallbackMaterial(info) {
  const parts = [
    `标题：${info.title}`,
    `UP：${info.up}`,
    `时长：${Math.round((info.duration || 0) / 60)} 分钟`,
  ];
  if (info.desc) parts.push(`简介：${truncateRunes(info.desc, 500)}`);
  try {
    const tagData = await biliGet('tag', { aid: info.aid, cid: info.cid });
    const tags = ((tagData && tagData.data) || [])
      .map((tag) => String((tag && tag.tag_name) || ''))
      .filter(Boolean)
      .slice(0, 8);
    if (tags.length) parts.push(`标签：${tags.join('、')}`);
  } catch {
    // Tags are a bonus, not a requirement: a failure here must not lose the fallback.
  }
  try {
    const reply = await biliGet('replyList', { type: 1, oid: info.aid, sort: 2, ps: 20 });
    const list = (reply && reply.data && reply.data.replies) || [];
    const hot = list
      .map((row) => String((row && row.content && row.content.message) || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 5);
    if (hot.length) parts.push(`热评：\n${hot.map((text, index) => `${index + 1}. ${truncateRunes(text, 80)}`).join('\n')}`);
  } catch {
    // Same as above.
  }
  return parts.join('\n');
}

// --- §5b 播放流与画质降级 -----------------------------------------------------

/**
 * 在体积上限内挑**画质最高**的那条流。
 *
 * 这里刻意不看时长。第一版照抄了 xunlu 阶梯的前半段（按时长定起始画质），结果 13 分钟的
 * 视频一律 360p —— 哪怕 80 MB 的预算明明放得下 720p。用户的原话是「在有限的大小和时长内
 * 追求最高画质」，所以时长只决定**能不能发**（硬上限），画质完全由预算决定：
 *
 *   1. 按 qn 从高到低；
 *   2. 同一个 qn 优先 `avc1`（codecid 7）—— `-c copy` 不重编码，选到 AV1/HEVC 会让一部分
 *      手机放不出来；
 *   3. 取第一条「预估 ≤ 上限」的；一条都放不下就返回 null（调用方改成发链接）。
 */
function pickVideoStream(videos, seconds, maxVideoBytes) {
  const avc = (stream) => (Number(stream.codecid) === 7 ? 1 : 0);
  const usable = (videos || [])
    .filter((stream) => stream && stream.url)
    .sort((a, b) => (Number(b.id) - Number(a.id))
      || (avc(b) - avc(a))
      || (Number(b.bandwidth) - Number(a.bandwidth)));
  for (const stream of usable) {
    const bytes = estimateStreamBytes(stream.bandwidth, seconds);
    if (!maxVideoBytes || bytes <= maxVideoBytes) return { stream, bytes };
  }
  return null;
}

/** 一条 DASH 流的预估字节数：bandwidth 是 bit/s。 */
function estimateStreamBytes(bandwidth, seconds) {
  return Math.round(((Number(bandwidth) || 0) / 8) * (Number(seconds) || 0));
}

/** DASH 流的两种字段名（camelCase / snake_case）统一成一种，下游只看一种。 */
function normaliseDashStream(stream) {
  if (!stream) return null;
  return {
    id: Number(stream.id) || 0,
    url: String(stream.baseUrl || stream.base_url || ''),
    backups: (stream.backupUrl || stream.backup_url || []).map((item) => String(item)),
    bandwidth: Number(stream.bandwidth) || 0,
    // 7 = avc1. 同一档里优先它：`-c copy` 不重编码，选到 AV1/HEVC 会让一部分手机放不出来。
    codecid: Number(stream.codecid) || 0,
    codecs: String(stream.codecs || ''),
  };
}

/** qn → 人看得懂的画质名（群里那条消息里显示这个，而不是 `qn 64`）。 */
const QN_LABELS = {
  127: '8K',
  126: '杜比视界',
  125: 'HDR',
  120: '4K',
  116: '1080p60',
  112: '1080p60',
  80: '1080p',
  74: '720p60',
  64: '720p',
  32: '480p',
  16: '360p',
  6: '240p',
};

function qnLabel(qn) {
  return QN_LABELS[Number(qn)] || `qn ${qn}`;
}

/**
 * 在体积上限内挑一条视频流（旧签到版，已由上面那个按「画质优先」的实现取代）。
 *
 * 保留说明而不保留代码：`targetQn` 这个参数就是「按时长定档」的残留，正是它让长视频
 * 一律 360p。见文件里 `pickVideoStream` 的新签名。
 */

/** 音频：取带宽最高的那条（不挑杜比/无损，它们常常单独鉴权）。 */
function pickAudioStream(audios) {
  return (audios || [])
    .filter((stream) => stream && stream.url)
    .sort((a, b) => Number(b.bandwidth) - Number(a.bandwidth))[0] || null;
}

/**
 * 一条视频的「能发出去的流」。
 *
 * 输入里的 `maxMB` 来自 QQ 插件的设置（谁发谁定上限），缺省 80；`maxMinutes` 由调用方
 * 先判（超长直接不发视频），这里只管流与体积。
 */
async function resolveStreams(info, limits) {
  const options = limits || {};
  const maxBytes = Math.max(1, Number(options.maxMB) || 80) * 1024 * 1024;
  const params = {
    bvid: info.bvid,
    cid: info.cid,
    fnval: 16, // DASH
    fnver: 0,
    fourk: 1,
    qn: 120,
  };
  // 带上凭据：`playurl` 对匿名用户只给到 480p 左右，登录后才会有 1080p/4K。
  // 没贴凭据时宿主会拒绝注入，那就退回匿名请求 —— 480p 也比什么都没有好。
  let data;
  try {
    data = await biliGet('playurl', params, { credentials: true });
  } catch (err) {
    const message = String((err && err.message) || '');
    if (message.includes('凭据') || message.includes('未保存') || message.includes('还没有保存')) {
      logLine('warn', `取流没带凭据（${message}），这一条只能拿到匿名画质`);
      data = await biliGet('playurl', params, {});
    } else {
      throw err;
    }
  }
  const d = (data && data.data) || {};
  const dash = d.dash;
  if (dash && Array.isArray(dash.video) && dash.video.length) {
    // Normalise BEFORE picking: the raw entries use baseUrl/backupUrl, and a picker that
    // looked for `.url` on them would find nothing and silently return no audio.
    const audio = pickAudioStream((dash.audio || []).map(normaliseDashStream));
    const audioBytes = audio ? estimateStreamBytes(audio.bandwidth, info.duration) : 0;
    // 画质只由预算决定：时长已经在调用方按硬上限判过了。
    const picked = pickVideoStream(
      dash.video.map(normaliseDashStream).filter(Boolean),
      info.duration,
      maxBytes - audioBytes,
    );
    if (!picked) {
      return {
        ok: false,
        reason: `连最低画质都超过 ${Math.round(maxBytes / 1048576)} MB，只发链接`,
      };
    }
    return {
      ok: true,
      kind: 'dash',
      qn: picked.stream.id,
      video: picked.stream,
      audio,
      sizeBytes: picked.bytes + audioBytes,
    };
  }
  const durl = Array.isArray(d.durl) ? d.durl : [];
  if (durl.length) {
    const first = durl[0] || {};
    const size = Number(first.size) || 0;
    if (size && size > maxBytes) {
      return { ok: false, reason: `单文件预估 ${Math.round(size / 1048576)} MB，超过上限` };
    }
    return {
      ok: true,
      kind: 'durl',
      qn: Number(d.quality) || 0,
      video: { id: Number(d.quality) || 0, url: String(first.url || ''), backups: (first.backup_url || []).map(String), bandwidth: 0, codecs: '' },
      audio: null,
      sizeBytes: size,
    };
  }
  return { ok: false, reason: '这条视频没有可下载的流（会员/付费/地区限制）' };
}

// --- §6 摘要：map / reduce / 解析 --------------------------------------------

function lengthHint(length) {
  switch (String(length || 'medium')) {
    case 'short':
      return '3 句以内';
    case 'long':
      return '6–10 句';
    default:
      return '3–6 句';
  }
}

/**
 * The prompt every call of one round shares.
 *
 * Persona and preferences are SEPARATE inputs because they answer different questions -
 * "how do you talk" and "what counts as useful" - and merging them produces a prompt
 * that is vague about both. The fixed block stays short so the two user fields keep the
 * room they were promised (1500 runes each).
 */
function buildSystem(cfg) {
  const persona = truncateRunes(cfgText('persona').trim(), 1500);
  const preferences = truncateRunes(cfgText('preferences').trim(), 1500);
  const fixed = [
    '你在帮主人筛 B 站视频。只输出一个 JSON 对象，不要代码块，不要解释。',
    '字段：',
    '{"summary":"摘要","points":["要点1","要点2","要点3"],"useful":true,"score":0,"why":"为什么对主人有用","tags":["标签"],"comment":"评论草稿或空串"}',
    'summary：说清这条视频讲了什么、结论是什么；只写素材里真有的内容。',
    'points：3 条要点，每条 30 字以内。',
    'score：0-100 的「对主人有用程度」。why：一句话（40 字以内），用第一人称对主人说。',
    'comment：只有能指出视频里具体的某个点时才写（60 字以内），否则给空串；不要夸奖式空话。',
    '如果素材是简介与评论而不是逐字稿，必须在 summary 里说清这一点，不许假装听过。',
  ].join('\n');
  const parts = [fixed];
  if (persona) parts.push(`人设（决定你怎么说话）：\n${persona}`);
  if (preferences) parts.push(`主人的偏好（决定什么算有用）：\n${preferences}`);
  return truncateRunes(parts.join('\n\n'), SYSTEM_MAX_RUNES);
}

function metaLine(info) {
  const minutes = Math.round((info.duration || 0) / 60);
  const lines = [
    `标题：${info.title}`,
    `UP：${info.up || '未知'}`,
    `时长：${minutes} 分钟`,
  ];
  if (info.tname) lines.push(`分区：${info.tname}`);
  if (info.desc) lines.push(`简介：${truncateRunes(info.desc, 300)}`);
  return lines.join('\n');
}

function mapPrompt(info, chunk, index, total) {
  return [
    metaLine(info),
    `这是第 ${index + 1}/${total} 段字幕。只写事实笔记（250 字以内），不要评价，不要用「这段讲了」开头。`,
    '',
    '字幕：',
    chunk.text,
  ].join('\n');
}

function finalPrompt(info, material, note, length) {
  return [
    metaLine(info),
    note || '',
    `摘要长度：${lengthHint(length)}。`,
    '',
    '素材：',
    material,
    '',
    '按 system 里的 JSON 格式输出。',
  ].join('\n');
}

/** One map answer, squeezed to a bullet: the reduce step must fit several of these. */
function chunkNote(text) {
  return truncateRunes(
    String(text || '')
      .replace(/^(这段|本段)(视频)?(主要)?(讲|说)了?[:：]?/, '')
      .replace(/\s+/g, ' ')
      .trim(),
    NOTE_MAX_RUNES,
  );
}

/**
 * Pull the JSON object out of an answer.
 *
 * Models wrap it in ```json, prepend "好的，", or both. Everything outside the outermost
 * braces is discarded rather than "repaired": a digest that is half-parsed is worse than
 * no digest, because the user would see an empty card that looks like a real verdict.
 */
function parseDigest(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const summary = truncateRunes(String(parsed.summary || '').trim(), 800);
  if (!summary) return null;
  const rawScore = Number(parsed.score);
  const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(100, Math.round(rawScore))) : 0;
  const useful = typeof parsed.useful === 'boolean' ? parsed.useful : score >= 70;
  const points = Array.isArray(parsed.points)
    ? parsed.points.map((point) => truncateRunes(String(point || '').trim(), 60)).filter(Boolean).slice(0, 5)
    : [];
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.map((tag) => truncateRunes(String(tag || '').trim(), 20)).filter(Boolean).slice(0, 6)
    : [];
  return {
    summary,
    points,
    score,
    useful,
    why: truncateRunes(String(parsed.why || '').trim(), 60),
    tags,
    comment: truncateRunes(String(parsed.comment || '').trim(), COMMENT_MAX_RUNES),
  };
}

/**
 * 模型服务的内容审核拒绝。
 *
 * 真机日志：`小说推荐：服务端返回错误：The request contains sensitive content. Please modify
 * your input and try again.` —— 视频标题里带「性转/雌堕/鼎炉」这类词，**输入**就被服务商拦了。
 * 这不是我们的 bug，也不是网络错误，重试没有意义（同样的输入还会被拒），所以单独认出来，
 * 当作「这条跳过」处理，别把它混进「摘要失败」里。
 */
function isContentRejection(message) {
  const text = String(message || '');
  return /sensitive content|content[_ ]?policy|inappropriate|flagged|审核|敏感|违规/i.test(text);
}

/** 模型在正文里「拒绝」的样子：这类回复不该被当成 JSON 解析失败。 */
function looksLikeRefusal(text) {
  const value = String(text || '');
  if (!value || value.includes('{')) return false;
  return /抱歉|无法(提供|协助|回答|处理|生成)|不能(提供|协助|回答|生成)|as an AI|I can't|I cannot|I'm sorry/i.test(value);
}

/** One llm.chat, counted against the day's budget before it is sent. */
async function chatOnce(system, text) {
  usageToday().llmCalls += 1;
  let reply;
  try {
    reply = await request('llm.chat', { text, system });
  } catch (err) {
    const message = String((err && err.message) || err);
    if (isContentRejection(message)) {
      const rejected = new Error('内容被模型服务拒绝（标题或简介触发了审核）');
      rejected.contentRejected = true;
      throw rejected;
    }
    throw err;
  }
  const answer = String((reply && reply.text) || reply || '');
  if (looksLikeRefusal(answer)) {
    const rejected = new Error('模型拒绝摘要这条内容（它只回了一句「无法协助」之类的话）');
    rejected.contentRejected = true;
    throw rejected;
  }
  return answer;
}

/** Split into (system, text) pairs without sending them: what the budget test needs. */
function planDigest(info, chunks, options) {
  const opts = options || {};
  const limit = Math.max(1, Math.floor(opts.limit || 4));
  const isTranscript = opts.isTranscript !== false;
  if (!isTranscript || chunks.length <= 1) {
    return { calls: 1, clipped: false, mapChunks: [] };
  }
  const mapBudget = Math.max(1, limit - 1);
  const usable = chunks.slice(0, mapBudget);
  return { calls: usable.length + 1, clipped: usable.length < chunks.length, mapChunks: usable };
}

/**
 * The whole digest for one video.
 *
 * `summaryMaxCalls` covers EVERY call this video makes - map, reduce and the JSON retry -
 * because that is the number the user set to bound the cost. When the transcript needs
 * more map steps than the budget allows, the video is summarised from its first N chunks
 * and the card says so.
 */
async function digestVideo(input) {
  const info = input.info;
  const isTranscript = input.isTranscript !== false;
  const limit = Math.max(1, Math.floor(cfgNum('summaryMaxCalls', 4, 1, 8)));
  const system = buildSystem(state.cfg);
  const length = cfgText('summaryLength');
  const chunks = input.chunks || [];
  const plan = planDigest(info, chunks, { limit, isTranscript });
  let calls = 0;
  let material;
  let note = '';

  if (!isTranscript) {
    material = input.material || '';
    note = '（素材是标题、简介、标签与热评，不是逐字稿。摘要里必须说清这一点。）';
  } else if (chunks.length <= 1) {
    material = chunks.length ? chunks[0].text : '';
    if (!material) throw new Error('字幕是空的，没法摘要');
  } else {
    const notes = [];
    for (let i = 0; i < plan.mapChunks.length; i += 1) {
      const chunk = plan.mapChunks[i];
      calls += 1;
      const answer = await chatOnce(system, mapPrompt(info, chunk, i, chunks.length));
      notes.push(chunkNote(answer));
    }
    material = notes.map((text, index) => `${index + 1}. ${text}`).join('\n');
    // 说清「读全了」还是「只读了前面」：模型会照着这句话决定要不要在摘要里声明局限。
    // 原来一律写「N 段笔记的汇总」，于是它常常自作主张加一句「素材不完整」。
    note = plan.clipped
      ? `（只读了前 ${plan.mapChunks.length} 段，约 ${Math.round(plan.mapChunks[plan.mapChunks.length - 1].to / 60)} 分钟；后面的没有读。）`
      : `（下面是全部 ${notes.length} 段字幕笔记的汇总，覆盖整条视频。）`;
  }

  calls += 1;
  let answer = await chatOnce(system, finalPrompt(info, material, note, length));
  let digest = parseDigest(answer);
  if (!digest && calls < limit) {
    // ONE retry, and only inside the budget: a model that answered prose twice will
    // answer prose three times, and each attempt is money.
    calls += 1;
    answer = await chatOnce(`${system}\n\n只输出 JSON 对象本身。`, finalPrompt(info, material, note, length));
    digest = parseDigest(answer);
  }
  return { digest, calls, clipped: plan.clipped, isTranscript };
}

// --- §7 四道闸 ---------------------------------------------------------------

/** "HH:MM-HH:MM" → minutes-of-day pair, or null when the setting is unusable. */
function parseWindow(spec) {
  const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(spec || '').trim());
  if (!match) return null;
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  if (start > 24 * 60 || end > 24 * 60) return null;
  return { start, end };
}

function minutesOfDay(now) {
  const date = new Date(now);
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Inside the active hours?
 *
 * Returns null when the setting cannot be read - and null means "no window", which lets
 * the round run. The other direction would be a silent all-day off switch triggered by a
 * typo, and "why did it stop" is much harder to notice than "why did it run".
 */
function inWindow(now, spec) {
  const win = parseWindow(spec);
  if (!win) return null;
  const minute = minutesOfDay(now);
  if (win.start === win.end) return true;
  if (win.start < win.end) return minute >= win.start && minute < win.end;
  return minute >= win.start || minute < win.end; // 22:00-02:00 这种跨零点
}

/**
 * The push gate: four conditions, and each refusal has a sentence for the log.
 *
 * It is a pure function of numbers and the digest so the rule can be tested without a
 * clock, a network or a bubble, and so the workshop can explain "why it stayed quiet"
 * instead of showing an empty inbox as if nothing had been looked at.
 */
function decidePush(input) {
  const now = input.now || Date.now();
  const digest = input.digest;
  const threshold = cfgNum('pushThreshold', 70, 0, 100);
  const cap = cfgNum('pushDailyCap', 5, 0);
  const gapMs = cfgNum('minPushGapMin', 90, 0) * 60 * 1000;
  const usage = usageToday(now);
  if (!digest) return { ok: false, reason: '没有可用的摘要' };
  if (!digest.useful) return { ok: false, reason: '模型判断这条对你没用' };
  if (digest.score < threshold) return { ok: false, reason: `分数 ${digest.score} 低于阈值 ${threshold}` };
  if (usage.pushes >= cap) return { ok: false, reason: `今天已经打扰 ${usage.pushes} 次（上限 ${cap}）` };
  if (inWindow(now, cfgText('activeHours')) === false) return { ok: false, reason: '不在活跃时段，只入收件箱' };
  const last = input.lastPushAt === undefined ? state.lastPushAt : input.lastPushAt;
  if (last && now - last < gapMs) return { ok: false, reason: '离上次推送太近' };
  return { ok: true, reason: '' };
}

const COMMENT_BANNED = ['加微信', '加v', '扫码', '二维码', '点击链接', '私信我', '作为一个观众', '作为一个路人', '作为一个网友', '此评论由'];

/**
 * Local checks on a comment before anything leaves the machine.
 *
 * The one that matters is "specificity": a comment that cannot name anything in the
 * video is the kind of praise a spam filter is right to delete, and it is also what a
 * model writes when it has nothing to say. Self-identifying as an AI and ads are banned
 * for the same reason - this text appears under the user's own name.
 */
function commentTextOk(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (runeLen(value) > COMMENT_MAX_RUNES) return false;
  const lower = value.toLowerCase();
  if (COMMENT_BANNED.some((word) => lower.includes(word))) return false;
  if (/(https?:\/\/|www\.)/i.test(value)) return false;
  if (/\bAI\b/.test(value)) return false;
  return true;
}

function decideComment(input) {
  const now = input.now || Date.now();
  const digest = input.digest;
  if (!cfgFlag('commentEnabled', false)) return { ok: false, reason: '评论总开关是关的' };
  if (cfgText('commentMode') !== 'auto') return { ok: false, reason: 'draft 模式：只出草稿' };
  if (!digest || !digest.comment) return { ok: false, reason: '没有落到具体细节的评论草稿' };
  if (!commentTextOk(digest.comment)) return { ok: false, reason: '评论草稿没通过本地检查' };
  const minScore = cfgNum('commentMinScore', 85, 0, 100);
  if (digest.score < minScore) return { ok: false, reason: `分数 ${digest.score} 低于评论门槛 ${minScore}` };
  const usage = usageToday(now);
  const cap = cfgNum('commentMaxPerDay', 2, 0);
  if (usage.comments >= cap) return { ok: false, reason: `今天已经评论 ${usage.comments} 条（上限 ${cap}）` };
  if (state.lastCommentAt && now - state.lastCommentAt < COMMENT_GAP_MS) return { ok: false, reason: '离上一条评论太近' };
  if (!cfgText('biliJct').trim()) return { ok: false, reason: '没有 bili_jct，评论发不出去' };
  if (!(state.secrets.biliCookie && state.secrets.biliCookie.set)) return { ok: false, reason: '还没有登录凭据' };
  return { ok: true, reason: '' };
}

/** Risk-control answers stop the whole round; they are states, not errors to retry. */
function noteRiskFailure(err) {
  if (!err) return false;
  if (!isRiskCode(err.code)) return false;
  state.pausedUntil = Date.now() + RISK_PAUSE_MS;
  state.pauseReason = `${err.message}${err.hint ? `（${err.hint}）` : ''}：暂停 6 小时`;
  logLine('error', state.pauseReason);
  void persistState();
  return true;
}

// --- §8 推送：气泡 + 收件箱 ---------------------------------------------------

/** The bubble is one sentence in the persona's voice; the model wrote it as `why`. */
function bubbleLine(digest, info) {
  const why = String((digest && digest.why) || '').trim();
  return truncateRunes(why || `刷到一条：${info.title}`, BUBBLE_MAX_RUNES);
}

async function pushToOwner(card) {
  usageToday().pushes += 1;
  state.lastPushAt = Date.now();
  const text = bubbleLine({ why: card.why }, card);
  try {
    await request('bubble.say', { text });
  } catch (err) {
    // The bubble is a courtesy; a refused one must not lose the card.
    logLine('error', `气泡没弹出来：${err && err.message ? err.message : err}`);
  }
  logLine('push', `推送：${card.title}`);
  // The QQ plugin decides whether to announce it and where; this side only says "worth it".
  void shareRecommend(card);
  await persistState();
  return text;
}

function addToInbox(card) {
  state.inbox.unshift(card);
  if (state.inbox.length > INBOX_MAX) state.inbox.length = INBOX_MAX;
}

// --- §9 评论 -----------------------------------------------------------------

async function sendComment(card) {
  const text = String(card.draft || '').trim();
  if (!commentTextOk(text)) throw new Error('这段评论文案没通过本地检查');
  const data = await biliPostForm('replyAdd', {
    oid: card.aid,
    type: 1,
    message: text,
    plat: 1,
    csrf: cfgText('biliJct').trim(),
  }, { credentials: true });
  const payload = (data && data.data) || {};
  const rpid = String(payload.rpid || payload.rpid_str || '');
  usageToday().comments += 1;
  state.lastCommentAt = Date.now();
  card.comment = { text, rpid, at: Date.now() };
  logLine('info', `已评论：${card.title}（rpid ${rpid || '未知'}）`);
  await writeJSON(STORAGE.usage, state.usage);
  await persistState();
  return card.comment;
}

// --- §10 一轮、命令通道与调度 ------------------------------------------------

/**
 * One video, end to end.
 *
 * Steps are returned alongside the card so the workshop's debug card can show where a
 * run stopped: "没有字幕" and "模型没给出 JSON" look identical from the outside, and
 * both need different fixes.
 */
async function processVideo(item, options) {
  const opts = options || {};
  // The caller may pass the steps object in, so a run that throws halfway still tells the
  // debug card WHERE it stopped: "取不到字幕轨" and "模型没给 JSON" need different fixes,
  // and an empty card says neither.
  const steps = opts.steps || {
    view: { state: 'idle', text: '未开始' },
    player: { state: 'idle', text: '未开始' },
    subtitle: { state: 'idle', text: '未开始' },
    digest: { state: 'idle', text: '未开始' },
  };
  const info = await fetchVideoInfo(item.bvid);
  steps.view = {
    state: 'ok',
    text: `cid ${info.cid} · ${info.title} · ${Math.round((info.duration || 0) / 60)} 分钟 · UP ${info.up || '未知'}`,
  };

  let trackInfo = { tracks: [], loggedIn: false };
  try {
    trackInfo = await fetchSubtitleTracks(info.bvid, info.cid);
  } catch (err) {
    // A failed subtitle-track call is NOT a failed video: the fallback path still has a
    // job, and a -404 here is common (some videos expose no track list at all). Only a
    // risk-control answer is worth aborting the round for.
    if (noteRiskFailure(err)) throw err;
    trackInfo = {
      tracks: [],
      loggedIn: Boolean(state.secrets && state.secrets.biliCookie && state.secrets.biliCookie.set),
      error: err && err.message ? err.message : String(err),
    };
  }
  steps.player = {
    state: trackInfo.tracks.length ? 'ok' : 'warn',
    text: trackInfo.tracks.length
      ? `${trackInfo.tracks.length} 条轨（${trackInfo.tracks.map((track) => track.lan || '?').join('/')}）`
      : trackInfo.error
        ? `字幕轨取不到（${trackInfo.error}），走降级`
        : trackInfo.loggedIn
          ? '没有字幕轨（这条大概真没有 CC 字幕），走降级'
          : '没有字幕轨（B 站对未登录请求不返回字幕列表：贴上凭据后才会有），走降级',
  };

  const track = pickTrack(trackInfo.tracks);
  let segments = [];
  if (track) {
    try {
      segments = mergeSegments(await fetchSubtitleBody(track.url));
    } catch (err) {
      steps.subtitle = { state: 'bad', text: `字幕下载失败：${err.message}` };
    }
  }
  const isTranscript = segments.length > 0;
  let chunks = [];
  let material = '';
  if (isTranscript) {
    chunks = chunkSegments(segments);
    const totalRunes = chunks.reduce((sum, chunk) => sum + runeLen(chunk.text), 0);
    steps.subtitle = {
      state: 'ok',
      text: `${segments.length} 段 → ${chunks.length} 块 · ${totalRunes} 字`,
    };
  } else {
    material = await fallbackMaterial(info).catch(() => `${info.title}\n${info.desc}`);
    if (steps.subtitle.state === 'idle') {
      steps.subtitle = {
        state: 'warn',
        text: trackInfo.loggedIn
          ? '没有可读字幕，改用简介与热评（摘要会标明「非字幕」）'
          : '没有可读字幕（未登录，B 站不给字幕列表），改用简介与热评（摘要会标明「非字幕」）',
      };
    }
  }

  const result = await digestVideo({ info, chunks, isTranscript, material }).catch((err) => {
    // 内容审核拒绝不是「摘要失败」：同样的输入重试还会被拒，所以直接跳过这条视频。
    if (err && err.contentRejected) {
      steps.digest = { state: 'warn', text: `跳过：${err.message}` };
      const skip = new Error(err.message);
      skip.skip = true;
      throw skip;
    }
    throw err;
  });
  const digest = result.digest;
  if (!digest) {
    steps.digest = { state: 'bad', text: `${result.calls} 次调用，模型没给出可解析的 JSON` };
    throw new Error('模型没有返回可解析的摘要');
  }
  steps.digest = {
    state: 'ok',
    text: `${result.calls} 次调用 · 分数 ${digest.score}${result.clipped ? ' · 只读了前半段' : ''}`,
  };

  const card = {
    id: `${info.bvid}-${Date.now()}`,
    bvid: info.bvid,
    aid: info.aid,
    title: info.title,
    up: info.up,
    pic: info.pic,
    duration: info.duration,
    tname: info.tname,
    score: digest.score,
    useful: digest.useful,
    summary: digest.summary,
    points: digest.points,
    why: digest.why,
    tags: digest.tags,
    draft: digest.comment || '',
    comment: null,
    transcript: isTranscript,
    calls: result.calls,
    clipped: result.clipped,
    at: Date.now(),
  };
  // The day's counter is what the cap is measured against, so a DEBUG run must not count:
  // pressing "跑一遍" five times would otherwise spend the whole day's budget on
  // experiments and leave the automatic round with nothing.
  if (opts.debug !== true) usageToday().videos += 1;
  if (opts.debug !== true) {
    rememberSeen([info], digest.score, card.at);
    addToInbox(card);
  }
  return { card, steps, isTranscript };
}

/**
 * One round.
 *
 * The candidate fetch is where -352 lives, so a risk answer aborts the round instead of
 * being logged and retried against the next source: three sources would mean three
 * consecutive risk hits, which is how an account earns a longer quiet period.
 */
async function runRound(options) {
  const opts = options || {};
  if (state.roundBusy) return { skipped: 'busy' };
  state.roundBusy = true;
  const startedAt = Date.now();
  try {
    const usage = usageToday(startedAt);
    const cap = cfgNum('dailyVideoCap', 12, 0);
    if (cap > 0 && usage.videos >= cap) {
      logLine('warn', `今天已经总结 ${usage.videos} 条（上限 ${cap}），这一轮不跑`);
      return { skipped: 'cap' };
    }
    const perRound = Math.max(1, Math.min(10, Math.floor(cfgNum('perRound', 3, 1, 10))));
    const pool = [];
    for (const name of cfgList('source')) {
      try {
        const items = await fetchSource(name, state.cfg);
        pool.push(...items);
      } catch (err) {
        if (noteRiskFailure(err)) return { stopped: true };
        logLine('error', `取候选（${name}）失败：${err && err.message ? err.message : err}`);
      }
    }
    const { picked, dropped } = filterCandidates(pool, seenSet(startedAt));
    const queue = picked.slice(0, perRound);
    logLine('info', `候选 ${pool.length} 条 → ${JSON.stringify(dropped)} → 取 ${queue.length} 条`);
    if (!queue.length) return { pushed: 0 };

    let pushed = 0;
    for (const item of queue) {
      try {
        const { card } = await processVideo(item);
        const gate = decidePush({ digest: card, now: Date.now() });
        if (gate.ok) {
          await pushToOwner(card);
          pushed += 1;
        } else {
          logLine('info', `${card.title}：不打扰（${gate.reason}）`);
        }
        const commentGate = decideComment({ digest: { ...card, comment: card.draft }, now: Date.now() });
        if (commentGate.ok) {
          try {
            await sendComment(card);
          } catch (err) {
            if (!noteRiskFailure(err)) logLine('error', `评论失败：${err && err.message ? err.message : err}`);
          }
        } else if (card.draft) {
          logLine('info', `评论没发：${commentGate.reason}`);
        }
      } catch (err) {
        // One bad video must not end the round: log why and keep the rest.
        if (noteRiskFailure(err)) return { stopped: true };
        const message = err && err.message ? err.message : err;
        // 失败也要记账，否则每一轮都会重新抓同一批失败品 —— 真机上就是「次次都是同一批」。
        // 用短 TTL（6 小时）而不是写 `seen`：一次网络抖动不该让一条视频永久跳过。
        rememberFailure(item, message);
        // 「跳过」不是错误：内容审核拒绝、模型拒绝摘要这类，重试也没用，只记一行 info。
        if (err && err.skip) {
          logLine('info', `${item.title || item.bvid}：跳过 —— ${message}`);
          continue;
        }
        logLine('error', `${item.title || item.bvid}：${message}`);
      }
    }
    state.nextRunAt = Date.now() + Math.max(1, Math.floor(cfgNum('intervalMinutes', 120, 30, 720))) * 60 * 1000;
    logLine('info', `这一轮结束：推送 ${pushed} 条`);
    return { pushed };
  } finally {
    state.roundBusy = false;
    usageToday();
    trimUsage();
    await writeJSON(STORAGE.inbox, state.inbox);
    await writeJSON(STORAGE.seen, state.seen);
    await writeJSON(STORAGE.failed, state.failed || []);
    await writeJSON(STORAGE.usage, state.usage);
    await persistState();
  }
}

function persistState() {
  return writeJSON(STORAGE.state, {
    nextRunAt: state.nextRunAt,
    lastPushAt: state.lastPushAt,
    lastCommentAt: state.lastCommentAt,
    pausedUntil: state.pausedUntil,
    pauseReason: state.pauseReason,
    account: state.account,
  });
}

async function verifyAccount() {
  try {
    // -101 is the expected answer for "no credential", and it carries `isLogin: false`
    // rather than an error worth throwing: reading the flag is simpler than catching.
    const data = await biliGet('nav', {}, { credentials: true, allowCodes: [-101] });
    const d = (data && data.data) || {};
    if (d.isLogin && d.mid) {
      state.account = { mid: String(d.mid), uname: String(d.uname || '') };
      logLine('info', `已登录：${state.account.uname || '（无昵称）'}（${state.account.mid}）`);
    } else {
      state.account = { mid: '', uname: '' };
      logLine('warn', '凭据没生效：nav 说没有登录');
    }
  } catch (err) {
    state.account = { mid: '', uname: '' };
    if (!noteRiskFailure(err)) logLine('error', `验证登录失败：${err && err.message ? err.message : err}`);
  }
  await persistState();
  return state.account;
}

/**
 * 命令通道（cmd 这个 storage key）。
 *
 * The market program is a DIFFERENT process from the pet, and it implements neither
 * llm.chat nor bubble.say (its net.fetch carries no headers or credentials either). So
 * "跑一遍" cannot execute where the button is: the workshop leaves a command in storage,
 * the pet's headless frame picks it up, runs it, and writes the result back. Same files,
 * no protocol - which is also why the workshop keeps polling them.
 */
/**
 * 扫码登录。
 *
 * 为什么整段都在常驻帧里：`passport` 的两步都要带 UA/Referer，而**市场程序那份 `net.fetch`
 * 不接受请求头与凭据**（design §9.1）。所以工坊点「扫码登录」只是投一条命令，真正 generate /
 * poll 的是桌宠那个帧，凭据也只落在它手里（`config.set` 的 secret 项），页面从头到尾没有明文。
 *
 * 成功时凭据从 `data.url` 的查询串里取：那是 B 站的 crossDomain 跳转地址，带
 * `SESSDATA/DedeUserID/bili_jct`。这条比「读 Set-Cookie」更省事，也不需要再给宿主加能力。
 */
const QR_STATUS_TEXT = {
  wait: '等待手机扫码',
  scanned: '已扫码，请在手机上点确认',
  ok: '已登录',
  expired: '二维码已过期',
  cancelled: '已取消',
  error: '出错',
};

/** The two cookies the API needs, pulled out of the crossDomain URL. */
function credentialFromCrossDomain(rawUrl) {
  const text = String(rawUrl || '');
  const query = text.includes('?') ? text.slice(text.indexOf('?') + 1) : '';
  return credentialFromPairs(new URLSearchParams(query));
}

/**
 * The same credentials, taken from the reply's Set-Cookie pairs.
 *
 * Both sources exist because B 站 has answered both ways: the older flow puts the session
 * in `data.url`, the current one hands it over as cookies and leaves the URL empty. The
 * plugin accepts either rather than betting on one - and says which one it got, so a
 * future change is visible in the log instead of showing up as "login did nothing".
 */
function credentialFromCookies(cookies) {
  const params = new URLSearchParams();
  for (const pair of cookies || []) {
    const text = String(pair || '');
    const index = text.indexOf('=');
    if (index <= 0) continue;
    const name = text.slice(0, index).trim();
    if (!['SESSDATA', 'DedeUserID', 'DedeUserID__ckMd5', 'bili_jct'].includes(name)) continue;
    params.set(name, text.slice(index + 1));
  }
  return credentialFromPairs(params);
}

function credentialFromPairs(params) {
  const pick = (name) => {
    const value = params.get(name);
    return value === null ? '' : value;
  };
  const parts = [];
  if (pick('SESSDATA')) parts.push(`SESSDATA=${pick('SESSDATA')}`);
  if (pick('DedeUserID')) parts.push(`DedeUserID=${pick('DedeUserID')}`);
  if (pick('DedeUserID__ckMd5')) parts.push(`DedeUserID__ckMd5=${pick('DedeUserID__ckMd5')}`);
  return { cookie: parts.join('; '), jct: pick('bili_jct'), hasSession: Boolean(pick('SESSDATA')) };
}

async function writeQrReport(report) {
  state.qrReport = report;
  await writeJSON(STORAGE.qrcode, report);
  if (view === 'workshop') renderQr();
}

function qrStop() {
  if (state.qrTimer) {
    clearTimeout(state.qrTimer);
    state.qrTimer = null;
  }
}

async function qrStart() {
  qrStop();
  const data = await biliGet('qrGenerate', {}, {});
  const payload = (data && data.data) || {};
  if (!payload.url || !payload.qrcode_key) throw new BiliError(-1, '没拿到二维码', 'generate 的返回里没有 url/qrcode_key');
  state.qr = { key: String(payload.qrcode_key), url: String(payload.url), at: Date.now() };
  await writeQrReport({
    id: state.qr.key,
    url: state.qr.url,
    at: state.qr.at,
    status: 'wait',
    message: QR_STATUS_TEXT.wait,
  });
  logLine('info', '扫码登录：二维码已生成，等手机确认');
  qrPollLoop(state.qr.key);
}

/**
 * Polls until the user does something.
 *
 * 3 秒一次、最多 5 分钟（B 站自己的二维码有效期就是 180 秒左右，这里留足余量）。
 * 每次结果都写进 `qrcode`，所以工坊那边只是「读状态」，不需要自己算轮询节奏 —— 两个程序
 * 各有一个定时器去猜对方，一定会错开。
 */
function qrPollLoop(key) {
  qrStop();
  let attempts = 0;
  // 3 秒一次；`state.qrPollDelayMs` 只给测试把它归零用，成品里没有任何代码写这个字段。
  const delay = typeof state.qrPollDelayMs === 'number' ? state.qrPollDelayMs : 3000;
  const tick = async () => {
    attempts += 1;
    if (attempts > 100) {
      qrStop();
      await writeQrReport({ id: key, status: 'expired', message: QR_STATUS_TEXT.expired, at: Date.now(), url: state.qr && state.qr.url });
      return;
    }
    try {
      const res = await biliGet('qrPoll', { qrcode_key: key }, { readCookies: true });
      const d = (res && res.data) || {};
      const code = Number(d.code === undefined ? d : d.code);
      if (code === 0) {
        qrStop();
        const fromUrl = credentialFromCrossDomain(d.url);
        const fromCookies = credentialFromCookies(res.__cookies);
        const creds = fromCookies.hasSession ? fromCookies : fromUrl;
        if (!creds.hasSession) {
          // Say what came back WITHOUT saying what it contained: field names, whether the
          // URL was there, how many cookies arrived. That is enough to diagnose the shape
          // without ever putting a credential in the log.
          const fields = Object.keys(d).join(',');
          const cookieNames = (res.__cookies || [])
            .map((pair) => String(pair).split('=')[0])
            .filter(Boolean)
            .join(',');
          logLine('error', `扫码成功但没解析出凭据：data 字段 [${fields}]，url ${d.url ? '有' : '空'}，set-cookie [${cookieNames || '无'}]`);
          await writeQrReport({
            id: key,
            status: 'error',
            message: '登录成功，但返回里没有可用的凭据（B 站可能又改了返回形状，日志里有字段名）',
            at: Date.now(),
          });
          return;
        }
        // Cookie values from `Set-Cookie` are already plain; the ones inside `data.url` are
        // percent-encoded and URLSearchParams has decoded them. Both are usable as-is, and
        // decoding either a second time would corrupt a `%` that is genuinely part of it.
        await request('config.set', { values: { biliCookie: creds.cookie, biliJct: creds.jct } });
        state.secrets = { ...state.secrets, biliCookie: { set: true, mask: '••••' } };
        state.cfg.biliJct = creds.jct;
        const account = await verifyAccount();
        await writeQrReport({
          id: key,
          status: 'ok',
          message: '已登录',
          at: Date.now(),
          account,
        });
        logLine('info', `扫码登录成功${account && account.uname ? `：${account.uname}` : ''}`);
        return;
      }
      if (code === 86038) {
        qrStop();
        await writeQrReport({ id: key, status: 'expired', message: QR_STATUS_TEXT.expired, at: Date.now(), url: state.qr && state.qr.url });
        return;
      }
      if (code === 86090) {
        await writeQrReport({
          id: key,
          status: 'scanned',
          message: QR_STATUS_TEXT.scanned,
          at: Date.now(),
          url: state.qr && state.qr.url,
        });
      }
      // 86101 = 还没扫：不改状态，继续等。
    } catch (err) {
      if (noteRiskFailure(err)) {
        qrStop();
        await writeQrReport({ id: key, status: 'error', message: err.message, at: Date.now() });
        return;
      }
      logLine('warn', `扫码轮询出错（会继续试）：${err && err.message ? err.message : err}`);
    }
    state.qrTimer = setTimeout(() => {
      void tick();
    }, delay);
  };
  state.qrTimer = setTimeout(() => {
    void tick();
  }, delay);
}

const CMD_KEY = 'cmd';
const DEBUG_KEY = 'debug';

async function pollCommand() {
  if (state.cmdBusy) return;
  const cmd = await readJSON(CMD_KEY, null);
  if (!cmd || !cmd.id) return;
  if (Date.now() - Number(cmd.at || 0) > 120000) {
    await request('storage.remove', { key: CMD_KEY }).catch(() => {});
    return;
  }
  if (cmd.id === state.lastCmdId) return;
  state.lastCmdId = cmd.id;
  state.cmdBusy = true;
  try {
    if (cmd.kind === 'debug') {
      await runDebugCommand(cmd);
    } else if (cmd.kind === 'round') {
      logLine('info', '收到「立刻跑一轮」');
      await runRound({ reason: 'manual' });
    } else if (cmd.kind === 'verify') {
      await verifyAccount();
    } else if (cmd.kind === 'qr-start') {
      await qrStart().catch(async (err) => {
        if (!noteRiskFailure(err)) logLine('error', `生成二维码失败：${err && err.message ? err.message : err}`);
        await writeQrReport({ id: '', status: 'error', message: err && err.message ? err.message : String(err), at: Date.now() });
      });
    } else if (cmd.kind === 'qr-cancel') {
      qrStop();
      await writeQrReport({ id: '', status: 'cancelled', message: QR_STATUS_TEXT.cancelled, at: Date.now() });
    } else if (cmd.kind === 'comment') {
      await runCommentCommand(cmd);
    }
  } finally {
    state.cmdBusy = false;
    await request('storage.remove', { key: CMD_KEY }).catch(() => {});
  }
}

/**
 * A comment the user asked for from the inbox.
 *
 * It goes through the SAME local checks as the automatic path (`commentTextOk`) - a
 * button is a permission to send, not a permission to skip the rules - and the card is
 * re-read from storage so a stale page cannot send something the user has since edited.
 */
async function runCommentCommand(cmd) {
  const report = { id: cmd.id, at: Date.now(), ok: false, error: '' };
  try {
    const inbox = await readJSON(STORAGE.inbox, []);
    const card = (Array.isArray(inbox) ? inbox : []).find((row) => row && row.id === cmd.cardId);
    if (!card) throw new Error('收件箱里已经没有这条');
    if (card.comment) throw new Error('这条已经评论过了');
    if (!commentTextOk(card.draft)) throw new Error('草稿没通过本地检查（太长、含广告词或没有具体信息）');
    await sendComment(card);
    await writeJSON(STORAGE.inbox, inbox);
    report.ok = true;
  } catch (err) {
    report.error = err && err.message ? err.message : String(err);
    if (!noteRiskFailure(err)) logLine('error', `发送评论失败：${report.error}`);
  }
  await writeJSON('comment', report);
}

async function runDebugCommand(cmd) {
  const bvid = String(cmd.bvid || '');
  const steps = {
    view: { state: 'idle', text: '未开始' },
    player: { state: 'idle', text: '未开始' },
    subtitle: { state: 'idle', text: '未开始' },
    digest: { state: 'idle', text: '未开始' },
  };
  const report = { id: cmd.id, at: Date.now(), ok: false, steps, error: '', card: null };
  try {
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) throw new Error('这不是一个 BV 号');
    const outcome = await processVideo({ bvid, title: bvid }, { debug: true, steps });
    report.ok = true;
    report.card = outcome.card;
    logLine('info', `单条调试完成：${outcome.card.title}（${outcome.card.score} 分）`);
  } catch (err) {
    report.error = err && err.message ? err.message : String(err);
    noteRiskFailure(err);
    logLine('error', `单条调试失败：${report.error}`);
  }
  await writeJSON(DEBUG_KEY, report);
}

// --- §10c 跨插件托盘（与 QQ 插件的联动） --------------------------------------

/**
 * 两个插件之间唯一的那条路：宿主的小托盘（`share.*`，权限 `plugin.share`）。
 *
 * 方向是**单向且分工明确**的：QQ 插件把「帮我看这条链接」放进 `bili-jobs`（它自己的名下的键），
 * 这个插件读它（manifest 的 `shareRead` 里点了名）、解析出**能下载的流地址**，写回自己名下的
 * `bili-results`。cookie 从头到尾没有离开这个插件——这正是当初否掉「借凭据」方案的原因。
 */
const SHARE_JOBS = { owner: 'com.shixiansi.plugin-qq', name: 'bili-jobs' };
const SHARE_RESULTS = 'bili-results';
const SHARE_RECOMMEND = 'recommend';
/** 宿主给共享值的上限是 64 KiB；留一点余量给 JSON 包装。 */
const SHARE_MAX_BYTES = 60 * 1024;

/**
 * Keeps a shared ARRAY under the byte budget by dropping the OLDEST entries.
 *
 * The results carry signed CDN URLs (1–3 KB each), so twenty of them overflow the host's
 * 64 KiB cap — and the real machine showed what that costs: the whole write is refused,
 * so the newest answers never reach the QQ plugin and the videos silently never appear.
 * Trimming keeps the newest, which is the only part anybody is waiting for.
 */
function trimShared(value, maxBytes) {
  if (!Array.isArray(value)) return value;
  const list = value.slice();
  while (list.length > 1 && JSON.stringify(list).length > maxBytes) list.pop();
  return list;
}

async function readShared(owner, name) {
  try {
    const res = await request('share.get', owner ? { owner, name } : { name });
    const raw = String((res && res.value) || '');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    // Logged once per session per kind: a plugin that lacks the permission would
    // otherwise write this line every three seconds.
    const key = `${owner || 'self'}/${name}`;
    if (!state.shareWarned.includes(key)) {
      state.shareWarned.push(key);
      logLine('warn', `读共享值 ${key} 失败：${err && err.message ? err.message : err}`);
    }
    return null;
  }
}

async function writeShared(name, value) {
  try {
    const trimmed = trimShared(value, SHARE_MAX_BYTES);
    if (Array.isArray(value) && trimmed.length < value.length) {
      logLine('warn', `共享值 ${name} 太大，只保留最新的 ${trimmed.length} 条`);
    }
    await request('share.set', { name, value: JSON.stringify(trimmed) });
    return true;
  } catch (err) {
    logLine('error', `写共享值 ${name} 失败：${err && err.message ? err.message : err}`);
    return false;
  }
}

/**
 * BV 号，或者 b23.tv / bili2233.cn 短链要跟一次跳转（短链页面的正文里带着真正的 BV）。
 *
 * 失败时返回**原因**而不是空串：QQ 那边会把它原样发到群里，而「短链解析失败：net.fetch
 * 未声明的域名：b23.tv」比「没认出 BV 号」有用得多 —— 后者让人以为是卡片格式的问题，
 * 实际是白名单少了一个域名（真机上正是这么发生的）。
 */
async function resolveBvid(text) {
  const raw = String(text || '');
  // 边界是必须的：卡片负载里全是 base64/URL 噪声，`BV` + 10 位字母数字在随机串里也会命中
  // （真机上就从一条卡片里蒙出了 `BVlkbstVNrVJ`，于是群里多了一条「请求参数不对」的噪声）。
  const direct = /(?<![0-9A-Za-z])BV[0-9A-Za-z]{10}(?![0-9A-Za-z])/.exec(raw);
  if (direct) return { bvid: direct[0], reason: '' };
  const short = /https?:\/\/(?:b23\.tv|bili2233\.cn)\/[0-9A-Za-z]+/.exec(raw);
  if (!short) return { bvid: '', reason: '没认出 BV 号，也不是 b23.tv / bili2233.cn 短链' };
  try {
    const body = await httpText(short[0], {});
    const found = /(?<![0-9A-Za-z])BV[0-9A-Za-z]{10}(?![0-9A-Za-z])/.exec(body);
    if (found) return { bvid: found[0], reason: '' };
    // 跳转成功但没有 BV 号：多半指向 UP 主主页 / 专栏 / 动态，不是视频。
    // 真机：`b23.tv/jJKBcEG` → `space.bilibili.com/3747…`。
    logLine('warn', `短链 ${short[0]} 跳转后没有 BV 号，可能指向主页而不是视频`);
    return { bvid: '', notVideo: true, reason: '这个短链指向的不是视频（跳转后没找到 BV 号）' };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    // 重定向被白名单挡住时，从域名就能判断它指向哪：space 是 UP 主主页，不是视频。
    if (/space\.bilibili\.com|\/space\//.test(message)) {
      logLine('warn', `短链 ${short[0]} 指向 UP 主主页，不是视频`);
      return { bvid: '', notVideo: true, reason: '这个短链指向的是 UP 主主页，不是视频' };
    }
    logLine('warn', `短链解析失败：${message}`);
    return { bvid: '', reason: `短链解析失败：${message}` };
  }
}

/**
 * One job from the QQ plugin.
 *
 * It answers with a RESULT either way: a silent failure would leave the group with a
 * link nobody explained. The result carries the streams (not the bytes) - downloading
 * belongs to the side that owns the file and knows the group it goes to.
 */
async function handleShareJob(job) {
  const started = Date.now();
  const base = { id: String(job.id), at: started, maxMB: job.maxMB, maxMinutes: job.maxMinutes };
  try {
    const resolved = await resolveBvid(job.url || job.text || '');
    if (!resolved.bvid) {
      // `notVideo` 让 QQ 那边只记日志、不往群里发「失败」：指向主页/专栏的短链不是用户的错。
      return { ...base, ok: false, notVideo: Boolean(resolved.notVideo), reason: resolved.reason || '没认出 BV 号' };
    }
    const bvid = resolved.bvid;
    let info;
    try {
      info = await fetchVideoInfo(bvid);
    } catch (err) {
      // -400 请求错误 = 这个 BV 不存在。多半是正则从卡片噪声里蒙出来的，所以标成
      // `notVideo`：QQ 那边看到它就不往群里发「失败」了 —— 那本来就不是用户发的视频。
      const code = err && err.code;
      const message = String((err && err.message) || '');
      if (code === -400 || message.includes('请求参数不对') || message.includes('请求错误')) {
        logLine('warn', `${bvid} 不是能打开的视频（${message}），当噪声忽略`);
        return { ...base, ok: false, notVideo: true, bvid, reason: '这不是一个能打开的视频' };
      }
      throw err;
    }
    const maxMinutes = Number(job.maxMinutes) || 25;
    if (info.duration > maxMinutes * 60) {
      return {
        ...base,
        ok: false,
        bvid,
        title: info.title,
        up: info.up,
        duration: info.duration,
        reason: `时长 ${Math.round(info.duration / 60)} 分钟超过上限 ${maxMinutes} 分钟`,
      };
    }
    const streams = await resolveStreams(info, { maxMB: job.maxMB });
    if (!streams.ok) {
      return { ...base, ok: false, bvid, title: info.title, up: info.up, duration: info.duration, reason: streams.reason };
    }
    return {
      ...base,
      ok: true,
      bvid,
      title: info.title,
      up: info.up,
      duration: info.duration,
      qn: streams.qn,
      quality: qnLabel(streams.qn),
      kind: streams.kind,
      sizeBytes: streams.sizeBytes,
      // 每个流只带**一个**备用地址：真机上 CDN 节点会抽风（同一条直链一会儿 0 字节、
      // 一会儿 6 秒下完），QQ 那边换一个节点重试常常就好。三条备用会把共享值撑爆
      // （64 KiB 上限，见 T11），一条不会。
      video: { url: streams.video.url, backups: (streams.video.backups || []).slice(0, 1) },
      audio: streams.audio
        ? { url: streams.audio.url, backups: (streams.audio.backups || []).slice(0, 1) }
        : null,
      reason: '',
    };
  } catch (err) {
    noteRiskFailure(err);
    return { ...base, ok: false, reason: err && err.message ? err.message : String(err) };
  }
}

/** Drains the job tray and publishes the answers. */
async function pollShare() {
  if (state.shareBusy) return;
  state.shareBusy = true;
  try {
    const jobs = await readShared(SHARE_JOBS.owner, SHARE_JOBS.name);
    const list = Array.isArray(jobs) ? jobs : (jobs && Array.isArray(jobs.jobs) ? jobs.jobs : []);
    const now = Date.now();
    const fresh = list
      .filter((job) => job && job.id && !state.doneJobs.includes(String(job.id)))
      // 超过 10 分钟的 job 不再处理：QQ 那边的去重窗口是 5 分钟，比这更旧的一定是
      // 上一次会话留下的。不加这条，每重启一次就把旧 job 全部重新解析一遍
      // （真机日志里那一串「给 QQ 的答复」就是它）。
      .filter((job) => !job.at || now - Number(job.at) < 10 * 60 * 1000)
      // Three per poll at most: a burst of twenty links must not turn into twenty
      // playurl calls against a rate-limited API.
      .slice(0, 3);
    if (!fresh.length) return;
    const results = (await readShared(null, SHARE_RESULTS)) || [];
    const answers = [];
    for (const job of fresh) {
      state.doneJobs.push(String(job.id));
      if (state.doneJobs.length > 50) state.doneJobs.shift();
      const answer = await handleShareJob(job);
      answers.push(answer);
      logLine(answer.ok ? 'info' : 'warn',
        `给 QQ 的答复：${answer.bvid || job.url || job.id} ${answer.ok ? `ok（qn ${answer.qn}）` : `失败（${answer.reason}）`}`);
    }
    // 10, not 20: each answer carries two signed URLs (~1.4 KB), so twenty of them
    // overflow the host's 64 KiB tray. `writeShared` trims as a backstop, but keeping
    // the list short means the trim does not have to happen every time.
    const merged = [...answers, ...(Array.isArray(results) ? results : [])].slice(0, 10);
    await writeShared(SHARE_RESULTS, merged);
  } finally {
    state.shareBusy = false;
  }
}

/**
 * Publishes a recommendation for the QQ plugin to announce.
 *
 * This plugin says "this is worth your time" and stops there: WHICH group, whether to
 * @ the owner, and how loud to be are all the QQ plugin's settings.
 */
async function shareRecommend(card) {
  if (!card || !card.bvid) return;
  const list = (await readShared(null, SHARE_RECOMMEND)) || [];
  const entry = {
    bvid: card.bvid,
    title: card.title,
    up: card.up,
    score: card.score,
    why: card.why,
    summary: truncateRunes(String(card.summary || ''), 200),
    at: Date.now(),
  };
  const merged = [entry, ...(Array.isArray(list) ? list : [])].slice(0, 10);
  await writeShared(SHARE_RECOMMEND, merged);
}

async function tick() {
  if (view !== 'background') return;
  if (state.roundBusy) return;
  const now = Date.now();
  if (state.pausedUntil > now) return;
  await refreshConfig();
  if (!cfgFlag('enabled', false)) return;
  if (inWindow(now, cfgText('activeHours')) === false) return;
  if (state.nextRunAt && now < state.nextRunAt) return;
  await runRound({ reason: 'schedule' });
}

// --- §11 工坊界面 ------------------------------------------------------------

const el = (id) => document.getElementById(id);

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
}

function fmtClock(ms) {
  if (!ms) return '—';
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function renderStatus() {
  const usage = usageToday();
  const enabled = cfgFlag('enabled', false);
  const paused = state.pausedUntil > Date.now();
  const run = el('st-run');
  if (run) {
    run.textContent = paused ? '已暂停（风控）' : enabled ? '自动刷：开' : '自动刷：关';
    run.dataset.state = paused ? 'paused' : enabled ? 'live' : 'off';
  }
  const next = el('st-next');
  if (next) next.textContent = `下次：${enabled ? fmtClock(state.nextRunAt) : '—'}`;
  const today = el('st-today');
  if (today) today.textContent = `今日：${usage.videos} / ${cfgNum('dailyVideoCap', 12, 0)} 条`;
  const push = el('st-push');
  if (push) push.textContent = `打扰：${usage.pushes} / ${cfgNum('pushDailyCap', 5, 0)} 次`;
  const account = el('st-account');
  if (account) {
    account.textContent = state.account.mid ? `账号：${state.account.uname || state.account.mid}` : '账号：未登录';
    account.dataset.state = state.account.mid ? 'live' : 'off';
  }
  const pausedNote = el('st-paused');
  if (pausedNote) {
    pausedNote.hidden = !paused;
    pausedNote.textContent = paused ? `${state.pauseReason || '被风控暂停'}（到 ${fmtClock(state.pausedUntil)}）` : '';
  }
  const toggle = el('st-toggle');
  if (toggle) toggle.textContent = enabled ? '暂停自动刷' : '开启自动刷';
  const loginState = el('login-state');
  if (loginState) {
    loginState.textContent = state.account.mid
      ? `已登录 ${state.account.uname || state.account.mid}`
      : state.secrets.biliCookie && state.secrets.biliCookie.set ? '有凭据（待验证）' : '未登录';
    loginState.dataset.state = state.account.mid ? 'live' : 'off';
  }
  const cookie = el('login-cookie');
  if (cookie && state.secrets.biliCookie && state.secrets.biliCookie.set && !cookie.value) {
    cookie.placeholder = `已保存 ${state.secrets.biliCookie.mask || '••••'}，粘新的会覆盖`;
  }
}

/**
 * Draws whatever the headless frame last reported about the QR login.
 *
 * The QR is drawn dark-on-white regardless of the window theme, with a four-module quiet
 * zone inside the viewBox: a scanner needs both, and neither is a matter of taste.
 */
function renderQr() {
  const report = state.qrReport || {};
  const status = el('qr-status');
  if (status) {
    const key = report.status;
    status.textContent = key ? (report.message || QR_STATUS_TEXT[key] || key) : '未开始';
    status.dataset.state = key === 'ok' ? 'live' : (key === 'expired' || key === 'error') ? 'paused' : 'off';
  }
  const hint = el('qr-hint');
  const svg = el('qr-svg');
  if (!svg) return;
  const drawable = report.url && (report.status === 'wait' || report.status === 'scanned');
  if (!drawable) {
    svg.textContent = '';
    svg.setAttribute('viewBox', '0 0 1 1');
    if (hint) {
      hint.textContent = report.status === 'ok'
        ? `已登录${report.account && report.account.uname ? `：${report.account.uname}` : ''}`
        : report.status === 'expired'
          ? '二维码过期了，点「生成二维码」换一张。'
          : report.status === 'error'
            ? (report.message || '出错了，再试一次。')
            : '点「生成二维码」，然后用 B 站手机客户端扫。';
    }
    return;
  }
  let rows;
  try {
    rows = qrMatrix(report.url);
  } catch (err) {
    if (hint) hint.textContent = `二维码画不出来：${err && err.message ? err.message : err}`;
    return;
  }
  const size = rows.length;
  const quiet = 4;
  const box = size + quiet * 2;
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('x', String(-quiet));
  rect.setAttribute('y', String(-quiet));
  rect.setAttribute('width', String(box));
  rect.setAttribute('height', String(box));
  rect.setAttribute('fill', '#ffffff');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', qrSvgPath(rows, size));
  path.setAttribute('fill', '#000000');
  svg.setAttribute('viewBox', `${-quiet} ${-quiet} ${box} ${box}`);
  svg.textContent = '';
  svg.append(rect, path);
  if (hint) {
    hint.textContent = report.status === 'scanned'
      ? '已经扫到了，请在手机上点「确认登录」。'
      : '用 B 站手机客户端扫码。二维码 3 分钟内有效，过期了再点一次。';
  }
}

function setLoginTab(tab) {
  state.loginTab = tab === 'paste' ? 'paste' : 'qr';
  const qrPane = el('login-qr-pane');
  const pastePane = el('login-paste-pane');
  if (qrPane) qrPane.hidden = state.loginTab !== 'qr';
  if (pastePane) pastePane.hidden = state.loginTab !== 'paste';
  for (const id of ['login-tab-qr', 'login-tab-paste']) {
    const button = el(id);
    if (button) button.dataset.active = String(button.dataset.tab === state.loginTab);
  }
  if (state.loginTab === 'qr') renderQr();
}

function renderLog() {  const list = el('log-list');
  if (!list) return;
  const empty = el('log-empty');
  if (empty) empty.hidden = state.log.length > 0;
  list.textContent = '';
  for (const entry of state.log.slice(0, 50)) {
    const row = document.createElement('li');
    row.dataset.kind = entry.kind || 'info';
    const at = document.createElement('span');
    at.className = 'at';
    at.textContent = fmtClock(entry.at);
    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = entry.text;
    row.append(at, text);
    list.append(row);
  }
}

function renderInbox() {
  const list = el('inbox-list');
  if (!list) return;
  const empty = el('inbox-empty');
  const pager = el('inbox-pager');
  const pages = Math.max(1, Math.ceil(state.inbox.length / INBOX_PAGE));
  if (state.inboxPage >= pages) state.inboxPage = pages - 1;
  if (state.inboxPage < 0) state.inboxPage = 0;
  if (empty) empty.hidden = state.inbox.length > 0;
  if (pager) pager.hidden = state.inbox.length === 0;
  const pageLabel = el('inbox-page');
  if (pageLabel) pageLabel.textContent = `第 ${state.inbox.length ? state.inboxPage + 1 : 0} / ${state.inbox.length ? pages : 0} 页`;
  list.textContent = '';
  const slice = state.inbox.slice(state.inboxPage * INBOX_PAGE, (state.inboxPage + 1) * INBOX_PAGE);
  for (const card of slice) {
    const row = document.createElement('li');
    row.className = 'card-row';
    row.dataset.bvid = card.bvid;

    const head = document.createElement('div');
    head.className = 'row-head';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = card.title || card.bvid;
    const score = document.createElement('span');
    score.className = 'score';
    score.textContent = `${card.score} 分`;
    head.append(title, score);

    const meta = document.createElement('p');
    meta.className = 'meta';
    const minutes = Math.round((card.duration || 0) / 60);
    meta.textContent = [
      card.up || '未知 UP',
      `${minutes} 分钟`,
      card.tname || '',
      fmtClock(card.at),
      card.transcript === false ? '非字幕' : '',
      card.clipped ? '只读了前半段' : '',
    ].filter(Boolean).join(' · ');

    const summary = document.createElement('p');
    summary.className = 'summary';
    summary.textContent = card.summary || '';

    const why = document.createElement('p');
    why.className = 'why';
    why.textContent = card.why ? `为什么推给你：${card.why}` : '';

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = '复制链接';
    copy.addEventListener('click', () => {
      const url = `https://www.bilibili.com/video/${card.bvid}`;
      if (navigator.clipboard && navigator.clipboard.writeText) void navigator.clipboard.writeText(url);
      logLine('info', `链接已复制：${url}`);
    });
    const draft = document.createElement('button');
    draft.type = 'button';
    draft.className = 'outline';
    draft.textContent = card.comment ? '已评论' : card.draft ? '发送评论草稿' : '无评论草稿';
    draft.disabled = Boolean(card.comment) || !card.draft;
    draft.addEventListener('click', () => {
      void sendCommentFromWorkshop(card);
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = '删除';
    remove.addEventListener('click', () => {
      state.inbox = state.inbox.filter((row2) => row2.id !== card.id);
      void writeJSON(STORAGE.inbox, state.inbox);
      renderInbox();
    });
    actions.append(copy, draft, remove);

    row.append(head, meta, summary);
    if (card.why) row.append(why);
    if (card.comment) {
      const sent = document.createElement('div');
      sent.className = 'draft';
      sent.textContent = `已发出：${card.comment.text}`;
      row.append(sent);
    } else if (card.draft) {
      const box = document.createElement('div');
      box.className = 'draft';
      box.textContent = `草稿：${card.draft}`;
      row.append(box);
    }
    row.append(actions);
    list.append(row);
  }
}

/**
 * "发送" from the workshop.
 *
 * The comment POST needs the cookie, which only the PET can inject - so this is another
 * command: mark the card as requested, let the headless frame send it and write the
 * result back. The button can therefore be honest about being asynchronous.
 */
async function sendCommentFromWorkshop(card) {
  if (!commentTextOk(card.draft)) {
    logLine('error', '这段草稿没通过本地检查，没有发送');
    renderLog();
    return;
  }
  const cmd = { id: `c${Date.now()}`, kind: 'comment', bvid: card.bvid, cardId: card.id, at: Date.now() };
  await writeJSON(CMD_KEY, cmd);
  logLine('info', `已请桌宠发送评论：${card.title}（等它回话）`);
  renderLog();
}

function renderDebug(report) {
  if (!report) return;
  const steps = report.steps || {};
  for (const key of ['view', 'player', 'subtitle', 'digest']) {
    const row = document.querySelector(`#dbg-steps li[data-step="${key}"]`);
    if (!row) continue;
    const step = steps[key] || { state: 'idle', text: '未开始' };
    row.dataset.state = step.state;
    const span = row.querySelector('span');
    if (span) span.textContent = step.text;
  }
  const error = el('dbg-error');
  if (error) {
    error.hidden = !report.error;
    error.textContent = report.error || '';
  }
  const box = el('dbg-digest');
  if (!box) return;
  if (!report.card) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const summary = el('dbg-summary');
  if (summary) summary.textContent = report.card.summary || '';
  const points = el('dbg-points');
  if (points) {
    points.textContent = '';
    for (const point of report.card.points || []) {
      const li = document.createElement('li');
      li.textContent = point;
      points.append(li);
    }
  }
  const verdict = el('dbg-verdict');
  if (verdict) {
    verdict.textContent = `分数 ${report.card.score} · ${report.card.useful ? '模型认为有用' : '模型认为没用'} · `
      + `${report.card.calls} 次调用${report.card.clipped ? ' · 只读了前半段' : ''}`
      + `${report.card.transcript === false ? ' · 非字幕' : ''}`;
  }
}

function renderAll() {
  renderStatus();
  renderInbox();
  renderLog();
}

/** Reads everything the headless frame writes, and renders it. */
async function refreshFromStorage() {
  const [stored, inbox, seen, failed, usage, log, debug, qrcode] = await Promise.all([
    readJSON(STORAGE.state, null),
    readJSON(STORAGE.inbox, []),
    readJSON(STORAGE.seen, []),
    readJSON(STORAGE.failed, []),
    readJSON(STORAGE.usage, {}),
    readJSON(STORAGE.log, []),
    readJSON(DEBUG_KEY, null),
    readJSON(STORAGE.qrcode, null),
  ]);
  if (stored) {
    state.nextRunAt = Number(stored.nextRunAt || 0);
    state.lastPushAt = Number(stored.lastPushAt || 0);
    state.lastCommentAt = Number(stored.lastCommentAt || 0);
    state.pausedUntil = Number(stored.pausedUntil || 0);
    state.pauseReason = String(stored.pauseReason || '');
    state.account = stored.account || { mid: '', uname: '' };
  }
  if (Array.isArray(inbox)) state.inbox = inbox;
  if (Array.isArray(seen)) state.seen = seen;
  if (Array.isArray(failed)) state.failed = failed;
  if (usage && typeof usage === 'object') state.usage = usage;
  if (Array.isArray(log)) state.log = log;
  renderAll();
  if (qrcode && qrcode !== state.qrReport) {
    state.qrReport = qrcode;
    if (state.loginTab === 'qr') renderQr();
  }
  if (debug && debug.id && debug.id !== state.shownDebugId) {
    state.shownDebugId = debug.id;
    renderDebug(debug);
  }
  // The model source is a HOST answer, and only the pet implements llm.profile. Probed
  // once per session: a request every five seconds to answer a question whose answer
  // only changes when the user edits two different programs is pure noise.
  //
  // In the control center it is not asked AT ALL. That program serves no llm.* (manual §9),
  // so the request could only ever be refused - and "ask once, then fall back" fixes the
  // label while leaving a WARN line in the host log every five seconds, which is exactly how
  // this plugin spent a real machine's log budget (37 lines on 2026-10-30, all from the
  // workshop). `surface.slot` is the only supported way to tell the two windows apart:
  // `kind` is 'panel' in both.
  if (!state.modelProbeDone) {
    state.modelProbeDone = true;
    const label = el('st-model');
    if (self.surface && self.surface.slot === 'workshop') {
      if (label) label.textContent = '模型：看桌宠那边';
    } else {
      try {
        const profile = await request('llm.profile', {});
        if (label) {
          label.textContent = profile && profile.source === 'borrowed' && profile.lender
            ? `模型：借用「${profile.lender.name || profile.lender.id}」`
            : profile && profile.model ? `模型：${profile.model}` : '模型：未配置';
        }
      } catch {
        if (label) label.textContent = '模型：看桌宠那边';
      }
    }
  }
}

// --- §12 启动 ----------------------------------------------------------------

function applyView() {
  const bg = el('background');
  const shop = el('workshop');
  if (bg) bg.hidden = view !== 'background';
  if (shop) shop.hidden = view !== 'workshop';
}

async function loadCfg() {
  try {
    const res = await request('config.get', {});
    const values = (res && res.values) || {};
    state.cfg = { ...DEFAULTS, ...values };
    state.secrets = (res && res.secrets) || {};
  } catch (err) {
    logLine('error', `读配置失败：${err && err.message ? err.message : err}`);
  }
}

async function refreshConfig() {
  try {
    const res = await request('config.get', {});
    state.cfg = { ...DEFAULTS, ...((res && res.values) || {}) };
    state.secrets = (res && res.secrets) || {};
  } catch {
    // A failed re-read keeps the previous settings: they were the user's, and dropping
    // them would silently turn the schedule off.
  }
}

async function loadStoredState() {
  const [stored, inbox, seen, failed, usage, log, wbi] = await Promise.all([
    readJSON(STORAGE.state, null),
    readJSON(STORAGE.inbox, []),
    readJSON(STORAGE.seen, []),
    readJSON(STORAGE.failed, []),
    readJSON(STORAGE.usage, {}),
    readJSON(STORAGE.log, []),
    readJSON(STORAGE.wbi, null),
  ]);
  if (stored) {
    state.nextRunAt = Number(stored.nextRunAt || 0);
    state.lastPushAt = Number(stored.lastPushAt || 0);
    state.lastCommentAt = Number(stored.lastCommentAt || 0);
    state.pausedUntil = Number(stored.pausedUntil || 0);
    state.pauseReason = String(stored.pauseReason || '');
    state.account = stored.account || { mid: '', uname: '' };
  }
  if (Array.isArray(inbox)) state.inbox = inbox;
  if (Array.isArray(seen)) state.seen = seen;
  if (Array.isArray(failed)) state.failed = failed;
  if (usage && typeof usage === 'object') state.usage = usage;
  if (Array.isArray(log)) state.log = log;
  if (wbi && wbi.exp) state.wbi = wbi;
}

let tickTimer = null;
let cmdTimer = null;
let refreshTimer = null;

async function startBackground() {
  state.started = true;
  if (!state.nextRunAt) {
    // 90 秒后再跑第一轮：开机瞬间不要抢网络，也不要和用户的其它程序抢。
    state.nextRunAt = Date.now() + 90 * 1000;
    await persistState();
  }
  tickTimer = setInterval(() => {
    void tick();
  }, 60 * 1000);
  cmdTimer = setInterval(() => {
    void pollCommand();
    // The same beat drains the cross-plugin tray: one timer, two inboxes, so the two
    // never drift into different schedules.
    void pollShare();
  }, 3000);
  logLine('info', `常驻帧起来了（${APP_VERSION}）`);
  // One poll immediately, and a line when it comes back.
  //
  // Both halves are diagnostics rather than ceremony: a polling plugin can lose its
  // timer to a throttled or frozen page and lose its storage calls to a refusal, and
  // neither leaves an error behind. "起来了" proves the frame mounted; this line proves
  // the command channel actually answered.
  void pollCommand().finally(() => {
    logLine('info', '命令通道就绪（工坊的「跑一遍 / 立刻跑一轮」由这里执行）');
  });
}

function wireWorkshop() {
  const toggle = el('st-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const next = !cfgFlag('enabled', false);
      state.cfg.enabled = next ? 'true' : 'false';
      void request('config.set', { values: { enabled: next ? 'true' : 'false' } })
        .then(() => logLine('info', next ? '已开启自动刷（桌宠那边下一分钟接手）' : '已暂停自动刷'))
        .catch((err) => logLine('error', `保存开关失败：${err.message}`))
        .finally(() => {
          renderStatus();
          renderLog();
        });
    });
  }

  const round = el('st-round');
  if (round) {
    round.addEventListener('click', () => {
      void writeJSON(CMD_KEY, { id: `r${Date.now()}`, kind: 'round', at: Date.now() })
        .then(() => logLine('info', '已请桌宠立刻跑一轮（等它回话）'));
      renderLog();
    });
  }

  const run = el('dbg-run');
  if (run) {
    run.addEventListener('click', () => {
      const input = el('dbg-bvid');
      const bvid = String((input && input.value) || '').trim();
      const error = el('dbg-error');
      if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
        if (error) {
          error.hidden = false;
          error.textContent = 'BV 号形如 BV1xx411c7mD（12 位）';
        }
        return;
      }
      if (error) error.hidden = true;
      void writeJSON(CMD_KEY, { id: `d${Date.now()}`, kind: 'debug', bvid, at: Date.now() })
        .then(() => logLine('info', `已请桌宠跑一遍 ${bvid}`));
      renderLog();
    });
  }

  const loginSave = el('login-save');
  if (loginSave) {
    loginSave.addEventListener('click', () => {
      void saveLogin();
    });
  }
  for (const id of ['login-tab-qr', 'login-tab-paste']) {
    const button = el(id);
    if (button) {
      button.addEventListener('click', () => {
        setLoginTab(button.dataset.tab);
      });
    }
  }
  const qrStart = el('qr-start');
  if (qrStart) {
    qrStart.addEventListener('click', () => {
      void writeJSON(CMD_KEY, { id: `q${Date.now()}`, kind: 'qr-start', at: Date.now() })
        .then(() => logLine('info', '已请桌宠生成登录二维码（等它回话）'));
      renderLog();
    });
  }
  const qrCancel = el('qr-cancel');
  if (qrCancel) {
    qrCancel.addEventListener('click', () => {
      void writeJSON(CMD_KEY, { id: `qc${Date.now()}`, kind: 'qr-cancel', at: Date.now() });
      logLine('info', '已取消扫码登录');
      renderLog();
    });
  }
  const loginClear = el('login-clear');
  if (loginClear) {
    loginClear.addEventListener('click', () => {
      void request('config.set', { values: { biliCookie: '', biliJct: '' } })
        .then(() => {
          state.secrets = { ...state.secrets, biliCookie: { set: false } };
          state.cfg.biliJct = '';
          state.account = { mid: '', uname: '' };
          logLine('warn', '已清除 B 站凭据');
        })
        .catch((err) => logLine('error', `清除失败：${err.message}`))
        .finally(() => {
          renderStatus();
          renderLog();
        });
    });
  }

  const inboxPrev = el('inbox-prev');
  if (inboxPrev) {
    inboxPrev.addEventListener('click', () => {
      state.inboxPage = Math.max(0, state.inboxPage - 1);
      renderInbox();
    });
  }
  const inboxNext = el('inbox-next');
  if (inboxNext) {
    inboxNext.addEventListener('click', () => {
      state.inboxPage += 1;
      renderInbox();
    });
  }
  const inboxClear = el('inbox-clear');
  if (inboxClear) {
    inboxClear.addEventListener('click', () => {
      state.inbox = [];
      state.inboxPage = 0;
      void writeJSON(STORAGE.inbox, state.inbox);
      renderInbox();
    });
  }
  const logClear = el('log-clear');
  if (logClear) {
    logClear.addEventListener('click', () => {
      state.log = [];
      void writeJSON(STORAGE.log, state.log);
      renderLog();
    });
  }
}

/**
 * Splits one pasted cookie string into the two settings it belongs in.
 *
 * The SESSDATA half must go through the SECRET path (the host encrypts it and never shows
 * it to this page); `bili_jct` is a CSRF token that is useless on its own, so it stays a
 * plain setting the page can read back when it builds the comment form.
 */
async function saveLogin() {
  const box = el('login-cookie');
  const note = el('login-note');
  const raw = String((box && box.value) || '').trim();
  if (!raw) {
    if (note) note.textContent = '先把整串 Cookie 粘进来。';
    return;
  }
  const parts = raw.split(/;\s*/).map((pair) => pair.trim()).filter(Boolean);
  const keep = [];
  let jct = '';
  for (const pair of parts) {
    const [name] = pair.split('=');
    if (name === 'bili_jct') {
      jct = pair.slice('bili_jct='.length);
      continue;
    }
    // Only the fields the API actually needs: copying a browser's whole cookie jar
    // would put a dozen unrelated site cookies into the encrypted blob.
    if (['SESSDATA', 'DedeUserID', 'DedeUserID__ckMd5', 'buvid3', 'buvid4', 'b_nut'].includes(name)) {
      keep.push(pair);
    }
  }
  if (!keep.some((pair) => pair.startsWith('SESSDATA='))) {
    if (note) note.textContent = '这串 Cookie 里没有 SESSDATA，粘错了吧？';
    return;
  }
  try {
    await request('config.set', { values: { biliCookie: keep.join('; '), biliJct: jct } });
    state.secrets = { ...state.secrets, biliCookie: { set: true, mask: '••••' } };
    state.cfg.biliJct = jct;
    if (box) box.value = '';
    if (note) note.textContent = jct ? '已保存，正在请桌宠验证…' : '已保存，但没有 bili_jct：评论会发不出去。';
    logLine('info', '已保存 B 站凭据');
    await writeJSON(CMD_KEY, { id: `v${Date.now()}`, kind: 'verify', at: Date.now() });
  } catch (err) {
    if (note) note.textContent = `保存失败：${err && err.message ? err.message : err}`;
    return;
  }
  renderStatus();
  renderLog();
}

async function onInit(payload) {
  self = { pluginId: payload.pluginId || '', surface: payload.surface || {} };
  applyTheme(payload.theme);
  granted.clear();
  for (const name of payload.granted || []) granted.add(name);
  view = self.surface && self.surface.slot === 'background' ? 'background' : 'workshop';
  applyView();
  await loadCfg();
  await loadStoredState();
  if (view === 'background') {
    await startBackground();
    // The frame exists to work, but a first round 90s later: see startBackground.
  } else {
    wireWorkshop();
    setLoginTab(state.loginTab);
    renderAll();
    void refreshFromStorage();
    refreshTimer = setInterval(() => {
      void refreshFromStorage();
    }, 5000);
  }
}

function onMessage(event) {
  const data = event && event.data;
  if (!data || typeof data !== 'object' || data.v !== PROTOCOL) return;
  switch (data.type) {
    case 'init':
      void onInit(data);
      break;
    case 'theme':
      applyTheme(data.theme);
      break;
    case 'response':
      onResponse(data);
      break;
    case 'event':
      // This plugin subscribes to no host events: its schedule is its own.
      break;
    case 'call':
      // 别的插件问 `search`（见 onCall）：这是本插件唯一的对外出口。
      void onCall(data);
      break;
    default:
      break;
  }
}

/**
 * `plugin.call` 的 `search`：把**站内搜索**借给别的插件。
 *
 * 为什么要这个出口：搜索引擎对"网络梗 / 二创术语 / UP 主黑话"经常搜不到，而 B 站站内搜索恰好是
 * 这些词的富矿——视频标题与简介就是"大家平时怎么用这个词"的现场记录。记忆核心的联网档位里
 * 「搜索引擎没结果 → 换一家再试」就是接在这里（它的 callTargets 点名了本插件的 search）。
 *
 * 返回形状与「联网搜索」插件**逐字一致**（{query, engine, count, tookMs, text, results}），
 * 调用方不需要知道资料来自哪一家；`engine` 写 `bilibili`，meta 里能看出来。
 */
async function onCall(data) {
  const ticket = data && data.ticket;
  const method = String((data && data.method) || '');
  const reply = (ok, value) => {
    const message = { type: 'call-result', ticket, ok: Boolean(ok) };
    if (ok) message.result = value === undefined ? null : value;
    else message.error = String(value && value.message ? value.message : value);
    postToHost(message);
  };
  if (method !== 'search') {
    reply(false, new Error(`这个插件只提供 search，不认识 ${method || '(空)'}`));
    return;
  }
  try {
    const payload = (data && data.payload) || {};
    const query = String(payload.query || '').trim().slice(0, 120);
    if (!query) throw new Error('search 需要 query：要查的那句话');
    const count = Math.min(10, Math.max(1, Number(payload.count) || 5));
    const started = Date.now();
    const dataOut = await biliGet('search', {
      search_type: 'video',
      keyword: query,
      page: 1,
      page_size: Math.min(30, count * 2),
    });
    const rows = (dataOut && dataOut.data && dataOut.data.result) || [];
    const results = [];
    for (const raw of rows) {
      const item = normaliseItem(raw, '');
      if (!item) continue;
      // B 站搜索会把命中的词用 <em> 包起来：那是给页面看的，给模型的应该是一句干净的标题。
      results.push({
        title: item.title.replace(/<[^>]+>/g, ''),
        url: `https://www.bilibili.com/video/${item.bvid}`,
        snippet: [item.up ? `UP：${item.up}` : '', item.play ? `播放 ${item.play}` : '', item.tname]
          .filter(Boolean).join(' · '),
      });
      if (results.length >= count) break;
    }
    const tookMs = Date.now() - started;
    reply(true, {
      query,
      engine: 'bilibili',
      count: results.length,
      tookMs,
      results,
      text: renderSearchText(query, results, tookMs),
    });
  } catch (err) {
    reply(false, err);
  }
}

/** 给模型读的结果文本：与「联网搜索」插件同一版式，调用方拼 prompt 时不必区分来源。 */
function renderSearchText(query, results, tookMs) {
  if (!results.length) return `没有搜到「${query}」相关的视频。`;
  const lines = [`「${query}」的 B 站搜索结果（bilibili，${results.length} 条，${Math.max(1, Math.round(tookMs / 1000))} 秒内）：`];
  results.forEach((item, index) => {
    lines.push(`[${index + 1}] ${item.title}`);
    lines.push(`    ${item.url}`);
    if (item.snippet) lines.push(`    ${item.snippet}`);
  });
  return lines.join('\n');
}

window.addEventListener('message', onMessage);
postToHost({ type: 'ready' });

/**
 * The test seam.
 *
 * The other bundled plugins are driven purely through the bridge, and so is this one -
 * except for the pipeline's pure functions. `md5` against a known vector, the chunker,
 * the digest parser and the four gates are exactly the places where a bug is invisible
 * from the outside and expensive in tokens, and a classic script's locals are not
 * importable. So they are published on the plugin's OWN window (a sandboxed document
 * nobody else can reach) for the tests in market/tests.
 *
 * It is not a capability and it proves nothing about permissions: everything that talks
 * to the host still goes through `request`, i.e. through the dispatcher's gate.
 */
window.__bili = Object.freeze({
  md5,
  mixinKey,
  encWbi,
  queryString,
  stripTags,
  mergeSegments,
  chunkSegments,
  chunkNote,
  parseDigest,
  buildSystem,
  planDigest,
  decidePush,
  decideComment,
  commentTextOk,
  inWindow,
  parseWindow,
  normaliseItem,
  filterCandidates,
  seenSet,
  rememberFailure,
  truncateRunes,
  runeLen,
  fmtClock,
  bubbleLine,
  pollCommand,
  runRound,
  qrMatrix,
  qrSvgPath,
  qrCodewords,
  qrReadCodewords,
  qrReservedMap,
  credentialFromCrossDomain,
  credentialFromCookies,
  trimShared,
  qnLabel,
  estimateStreamBytes,
  pickVideoStream,
  pickAudioStream,
  normaliseDashStream,
  resolveBvid,
  handleShareJob,
  pollShare,
  rsEcc,
  gfMul,
  GF_EXP,
  DEFAULTS,
  state,
});




