// lib/state.js —— 运行时状态、小工具、日志、Milky API
//
// 一处放运行状态，一处放纯函数工具，一处放 note/persist，一处放协议端调用。
//
// 从原来的 app.js 按节**原样搬出来**（1.12 的重构）：内容逐字未改，只是换了个文件。
// 经典 script 共享同一个全局作用域，所以这里不用 import/export；
// 加载顺序写在 panel.html 里（顺序 = 原来的文件顺序，所以原有的依赖关系不变）。
'use strict';

// --- plugin state ------------------------------------------------------------

/** The settings declared in manifest.json, as strings, with these fallbacks. */
const DEFAULTS = {
  server: '127.0.0.1:3000',
  accessToken: '',
  atOnly: 'true',
  replyChance: '0',
  proactiveMinutes: '0',
  // 攒批自主插话（P3）：一批消息最多一次调用，且大多数时候那次调用会以沉默收场。
  // 三个旋钮是"花多少钱"的直接控制；最少条数(3)与能量下限(0.35)是设计决定，不做成配置。
  batchEnabled: 'true',
  batchWindowSec: '120',
  batchMaxPerHour: '8',
  prefix: '',
  groupAllow: '',
  persona: '',
  // 三层人格第二层（personaBehavior，"何时接话/何时安静"）：进 systemPromptFor /
  // proactivePromptFor / batchSystemPrompt 的规则区。manifest 的 config 已用满宿主
  // 上限（README「为什么不放 config」），所以 QQ 这边它走 workshop 存储而不进 config。
  personaBehavior: '',
  contextTurns: '8',
  // 记忆与状态（参考 nonebot-plugin-aigf）：长期记忆条数上限、社交能量基线。
  memoryNotesMax: '20',
  energyBaseline: '70',
  // 表情包：给模型看的候选条数（越多越准、越费 token），以及自动收藏开关。
  // 自动收藏每张图要一次识图请求，所以它是个开关而不是"总是开"。
  stickerCandidateMax: '12',
  autoCollectStickers: 'true',
  // 被戳一戳时"戳回去"的概率（其余情况回一句话）。协议端不支持戳人时自动退回回话。
  pokeBackChance: '40',
  replyMaxChars: '300',
  cooldownSec: '5',
  // 引用提问那条消息的概率。以前是 bool（引用/不引用）：真机上"每条都引用"显得机械，
  // "从不引用"又接不住"你说的那句"，中间那段才是想要的 —— 所以它是个 0-100 的概率。
  quoteChance: '60',
  llmProvider: '',
  llmBaseUrl: '',
  llmModel: '',
  // 宿主执行这个上限（它读 `llm-usage` 计数），插件只负责声明：没有这一项时上限是 0，
  // 也就是**不限**——真机上就是这么没有上限地跑了 96 次，工坊能看见却拦不住。
  llmDailyBudget: '300',
  // The protocol side (Yogurt) itself: where its exe lives, what to pass it, and
  // whether this plugin may start it. Empty + off by default - starting a program is
  // the user's decision, never the default.
  clientPath: '',
  clientArgs: '',
  autoStartClient: 'false',
  // B 站联动：群里出现链接时发视频、刷到值得看的时在群里 @ 主人。
  //
  // The caps and the switch live HERE rather than in the Bilibili plugin because this is
  // the side that owns a group: how much a group will tolerate is not a property of the
  // video, and the plugin that decides "send to whom" should own "how big".
  biliLinkReply: 'false',
  biliLinkAtOwner: 'true',
  biliMaxMB: '80',
  biliMaxMinutes: '25',
  biliRecommendGroup: '',
  // Absolute path of ffmpeg.exe. Empty means "no video": a video that cannot be muxed is
  // sent as a link instead, never as a broken message.
  ffmpegPath: '',
};

const state = {
  cfg: { ...DEFAULTS },
  base: '',
  eventUrl: '',
  ws: 'closed',
  wsError: '',
  selfID: '',
  selfName: '',
  counts: { frames: 0, asked: 0, replies: 0, errors: 0 },
  /** peer_id -> { id, name, count, lastAt } - the memory index the workshop reads. */
  groups: new Map(),
  /**
   * Whether `groups` has been READ from storage yet.
   *
   * The index is published by every persist, so writing it before it has been read would
   * publish the empty map and wipe the file - which is exactly what the first release did
   * on every restart. Until this is true the bot simply does not write that key.
   */
  groupsLoaded: false,
  /** peer_id -> epoch ms of the last answer, for the cooldown. */
  lastAnswer: new Map(),
  /** groupID -> {entries, self}: 回复门控的 60 秒滑动窗口（见 lib/reply_gate.js）。 */
  gateWindows: new Map(),
  /** 最近一次门控判定 {decision, probability, threshold}：静默日志引用它，不落盘。 */
  lastGate: null,
  /** 门控打分时"当前在给哪个群打分"（takeTurn 应答路径设置）。 */
  gateCurrentGroup: '',
  /** peer_id -> epoch ms of the last "I stayed silent" log line, so it is rate-limited. */
  ignoredAt: new Map(),
  /** peer_id -> epoch ms of the last sticker, for the per-group cooldown. */
  lastStickerAt: new Map(),
  /** peer_id -> epoch ms list of the images auto-collected, for the hourly cap. */
  collectLog: new Map(),
  /** groupID -> {at, list}: 群成员名单缓存，只用来把 @昵称 换成真 @。 */
  members: new Map(),
  /** groupID -> [{text, at}]: 刚刚发生的群系统通知，进下一次 prompt，不进历史。 */
  notices: new Map(),
  /** 已经记过日志的"认不出的东西"，避免同样的行刷屏。 */
  unknownEvents: new Set(),
  /** 工坊显示用的今日用量（宿主写在 `llm-usage` 里的那份）。 */
  usage: null,
  /** 「删除残图」是否已经在等第二次确认。 */
  pendingPurge: false,
  /** 是否正在翻群历史补图（防止重复点）。 */
  recovering: false,
  /** 工坊显示的"最近一次模型原话"（`state/probe` 的最后一条）。 */
  probe: null,
  /** 记忆卡当前打开的是哪个群（空=没打开）。 */
  memoryGroup: '',
  memoryName: '',
  /** groupID -> {energy, notes}：工坊直接读文件得到的，补机器人没写进索引的那些。 */
  groupStats: new Map(),
  /** groupID -> 上次为"模型没带围栏"记日志的时间，避免刷屏。 */
  noFenceAt: new Map(),
  /** groupID -> 上次被服务商内容安全拦住的时间（10 分钟内改用最小上下文）。 */
  moderationAt: new Map(),
  /** groupID -> 正在排队的提问（这个群一次只答一条，其余的按顺序等着）。 */
  asks: new Map(),
  /** groupID -> 已经挂上的"到点再答下一条"定时器，一个群只留一个。 */
  drainTimers: new Map(),
  /** groupID -> 上次说"待收藏满了"的时间（30 分钟一次，别刷屏）。 */
  collectFullAt: new Map(),
  /** groupID -> 上次说"这条带了视频"的时间（10 分钟一次）。 */
  videoSkippedAt: new Map(),
  /** groupID -> 上次回应"戳一戳"的时间（每群 60 秒一次，连点的人不会刷屏）。 */
  pokedAt: new Map(),
  /** groupID -> 群主 QQ 号（`@群主` 要用；协议端给不了就缓存空串）。 */
  groupOwner: new Map(),
  /** groupID -> 背景聊天缓冲（攒批自主插话用；只有没被回答的消息才进来）。 */
  chatter: new Map(),
  /** groupID -> {at, hourStart, count}：攒批的窗口与每小时配额。 */
  batchAt: new Map(),
  /** peer_id set: one answer in flight per group. */
  busy: new Set(),
  log: [],
  started: false,
  // --- B 站联动 -------------------------------------------------------------
  /** link -> epoch ms it was requested, so one link is not requested twice. */
  biliLinks: new Map(),
  /** job id -> { groupID, senderID, at }: a result carries no group, and it must not. */
  biliPending: new Map(),
  /** Result / recommendation ids already announced. */
  biliSeenResults: [],
  biliSeenRecommends: [],
  /** groupID -> epoch ms of the last "cannot send, here is the link" note. */
  biliNoticeAt: new Map(),
  /** True while the bridge is mid-flight, so two 5 s ticks cannot double-send. */
  bridgeBusy: false,
  bridgeStartedAt: 0,
  bridgeTimer: null,
};

const maxLogEntries = 60;

// --- small helpers -----------------------------------------------------------

function flag(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function number(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Splits a "list typed into one field" setting; accepts both comma kinds. */
function listOf(value) {
  return String(value || '')
    .split(/[,，;；\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Splits the `clientArgs` setting into an argument list.
 *
 * Whitespace only, unlike listOf: a comma or a Chinese comma can legitimately appear
 * INSIDE one argument (a path, a token), so splitting on it would silently break the
 * invocation. The host caps the list at 32 arguments and refuses the call rather than
 * dropping the extras, so an over-long list is reported instead of half-applied.
 */
function argsOf(value) {
  return String(value || '')
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function trimTo(text, max) {
  const runes = Array.from(String(text || ''));
  if (runes.length <= max) return runes.join('');
  return runes.slice(0, max).join('');
}

/**
 * Derives the two endpoints from ONE setting.
 *
 * `server` may be `host:port`, `http://host:port/prefix` or `ws://host:port/prefix`.
 * Milky's own config has a `prefix` field, and a deployment that sets it must be
 * reachable; asking for two URLs would make it possible to change one and not the
 * other, and the failure ("events arrive, answers do not") is hard to read.
 */
function endpointsFor(server, token) {
  const raw = String(server || '').trim() || DEFAULTS.server;
  let scheme = 'http';
  let host = raw;
  let path = '';
  const withScheme = /^([a-z]+):\/\/(.*)$/i.exec(raw);
  if (withScheme) {
    const given = withScheme[1].toLowerCase();
    const rest = withScheme[2];
    scheme = given === 'https' || given === 'wss' ? 'https' : 'http';
    const slash = rest.indexOf('/');
    host = slash >= 0 ? rest.slice(0, slash) : rest;
    path = slash >= 0 ? rest.slice(slash).replace(/\/+$/, '') : '';
  }
  const secure = scheme === 'https';
  const base = `${secure ? 'https' : 'http'}://${host}${path}`;
  const wsScheme = secure ? 'wss' : 'ws';
  // A token may only travel as a query parameter on a WebSocket: the browser API
  // has no headers, and the host's dialer sends `Authorization` as well - Milky
  // accepts either, and sending both is what the SDK does.
  const query = token ? `?access_token=${encodeURIComponent(token)}` : '';
  return { base, eventUrl: `${wsScheme}://${host}${path}/event${query}` };
}

// --- logging / persistence ---------------------------------------------------

function note(line) {
  const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  state.log.push(`${stamp} ${line}`);
  if (state.log.length > maxLogEntries) state.log.splice(0, state.log.length - maxLogEntries);
  if (view === 'workshop') renderLog();
  schedulePersist();
}

/**
 * Writes the three cross-process files, coalescing while a write is in flight.
 *
 * The workshop runs in the MARKET's process, so the only way it can show what the
 * bot is doing is through the plugin's own storage. Writes are driven by the events
 * worth showing - a state change, an answer, a refusal - and never by inbound frames
 * as such, so the cost is a handful of small files per answered message rather than
 * a write per group message.
 *
 * There is no debounce timer on purpose: a timer means the interesting entry (a
 * permission refusal, a dropped connection) can be the one still sitting in the
 * buffer, and "the dashboard was blank for a second" is indistinguishable from "it
 * did not react". An in-flight flag does the coalescing instead, so a burst of notes
 * costs one write plus one follow-up.
 */
let persisting = false;
let persistDirty = false;

function schedulePersist() {
  if (view !== 'background') return;
  if (!granted.has('storage')) return;
  if (persisting) {
    persistDirty = true;
    return;
  }
  void persistNow();
}

async function persistNow() {
  persisting = true;
  persistDirty = false;
  try {
    await request('storage.set', {
      key: DATA.status,
      value: JSON.stringify({
        state: state.ws,
        error: state.wsError,
        selfID: state.selfID,
        selfName: state.selfName,
        at: Date.now(),
        counts: state.counts,
      }),
    });
    // The index is only published once it has been READ: see state.groupsLoaded.
    if (state.groupsLoaded) {
      await request('storage.set', {
        key: DATA.groups,
        value: JSON.stringify([...state.groups.values()]),
      });
    }
    await request('storage.set', { key: DATA.log, value: JSON.stringify(state.log) });
  } catch (err) {
    // A storage failure is worth one line, not a loop: the bot keeps answering.
    console.warn('qq plugin: could not persist', err && err.message);
  } finally {
    persisting = false;
    if (persistDirty) {
      persistDirty = false;
      void persistNow();
    }
  }
}

// --- Milky API ---------------------------------------------------------------

/**
 * Calls one Milky API endpoint.
 *
 * Milky's transport is `POST {base}/api/{name}` with a JSON body and an optional
 * `Authorization: Bearer` header, and the reply is `{status, retcode, message, data}`
 * - a 200 with `status: "failed"` is a real failure, which is why both are checked.
 */
async function api(name, params) {
  const headers = { accept: 'application/json', 'content-type': 'application/json' };
  if (state.cfg.accessToken) headers.authorization = `Bearer ${state.cfg.accessToken}`;
  const res = await request('net.fetch', {
    method: 'POST',
    url: `${state.base}/api/${name}`,
    body: JSON.stringify(params || {}),
    headers,
  });
  let payload = null;
  try {
    payload = JSON.parse(String(res && res.body ? res.body : ''));
  } catch {
    payload = null;
  }
  if (payload && payload.status === 'failed') {
    throw new Error(payload.message || `${name} 失败（retcode ${payload.retcode}）`);
  }
  if (!res || res.status >= 400) {
    throw new Error(`${name} 返回 HTTP ${res ? res.status : '?'}`);
  }
  return payload ? payload.data : null;
}

