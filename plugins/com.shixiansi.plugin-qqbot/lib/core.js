// lib/core.js —— 文档骨架、宿主桥、配置与存储助手
//
// 本插件是 QQ **官方机器人**（QQ 开放平台，q.qq.com）的接入端，与走 Milky 协议端的
// `com.shixiansi.plugin-qq`（个人号）是两个东西：
//
//   QQ 开放平台网关  ──wss──▶  宿主 (net.ws)  ──event──▶  lib/gateway.js
//                                                          │
//        llm.chat（默认借用对话插件的模型配置）◀────────────┤
//                                                          │
//        net.fetch POST https://api.bot.qq.com/v2/... ────▶ 被动回复进群/进单聊
//
// 整个机器人住在桌宠挂载的常驻帧（slot:"background"）里；控制中心的工坊页
// （slot:"workshop"）只做只读的展示与清理。两个进程读写同一批 storage 键，
// 所以每份状态都在**读的那一刻**重新从盘上拿，不做跨进程缓存。
//
// 关键的官方协议事实（写代码时逐条对照过开放平台文档，2026-10 版）：
//   - AccessToken 用 appId+appSecret POST /app/getAppAccessToken 换取，7200 秒有效，
//     每次调用带 `Authorization: QQBot <token>`；
//   - 网关地址 GET /gateway 返回腾讯分配的正式网关（如 `wss://api.sgroup.qq.com/websocket`），不一定是 api.bot.qq.com，必须把它加进 manifest netHosts；
//   - Hello(op10) 给心跳间隔 → Identify(op2, token="QQBot <token>", intents) →
//     READY(op0, t=READY, d.session_id) → 之后按周期发心跳(op1, d=最新 s)；
//   - 断线重连可以 Resume(op6, session_id+seq) 补发遗漏事件；服务端要求重连(op7)、
//     参数错误(op9) 时按它的指示走（op9 清掉会话重新 Identify）；
//   - 群事件 GROUP_AT_MESSAGE_CREATE / 单聊事件 C2C_MESSAGE_CREATE 都在
//     intents GROUP_AND_C2C_EVENT (1<<25) 里；频道公域在 PUBLIC_GUILD_MESSAGES (1<<30)；
//   - 被动回复：POST /v2/groups/{group_openid}/messages 或
//     /v2/users/{user_openid}/messages，body 带 `msg_id`（事件 d.id，群 5 分钟内有效）、
//     `msg_seq`（同一 msg_id 每多回一次就递增，相同 msg_id+msg_seq 会失败）；
//   - 群被动回复每条消息最多回 5 次、单聊 4 次；有效期内回不了就算了，不重试到骚扰。
'use strict';

// --- DOM ---------------------------------------------------------------------

const els = {
  root: document.getElementById('root'),
  background: document.getElementById('background'),
  workshop: document.getElementById('workshop'),
  chipState: document.getElementById('chip-state'),
  chipSelf: document.getElementById('chip-self'),
  chipModel: document.getElementById('chip-model'),
  statusNote: document.getElementById('status-note'),
  statusError: document.getElementById('status-error'),
  botCard: document.getElementById('bot-card'),
  botList: document.getElementById('bot-list'),
  botEmpty: document.getElementById('bot-empty'),
  logCard: document.getElementById('log-card'),
  log: document.getElementById('log'),
  logEmpty: document.getElementById('log-empty'),
  clearLog: document.getElementById('clear-log'),
  clearSessions: document.getElementById('clear-sessions'),
};

// --- the bridge --------------------------------------------------------------

const PROTOCOL = 1;
let nextRequestID = 1;
const pending = new Map();

function postToHost(message) {
  if (!window.parent) return;
  window.parent.postMessage({ v: PROTOCOL, ...message }, '*');
}

function request(method, payload) {
  const id = String(nextRequestID++);
  postToHost({ type: 'request', id, method, payload: payload === undefined ? {} : payload });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

/** Resolves after ms; the gateway's reconnect ladder waits in steps. */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Everything the host granted; ids are exact strings. */
const granted = new Set();
let self = { pluginId: '', surface: {} };
let view = 'workshop';

// --- 配置 --------------------------------------------------------------------

// config.get 的 values 只含非 secret 项；appSecret 是 secret，永远拿不到明文，
// 只能通过 net.fetch 的 credentials 点名使用（见 gateway.js 的 token 调用）。
let cfg = {
  appId: '',
  apiDomain: '',
  intentsPreset: 'group+c2c',
  groupAllow: '',
  replyMaxChars: '300',
  contextTurns: '8',
  cooldownSec: '3',
  persona: '',
  echoUnknownEvents: 'true',
  llmBaseUrl: '',
  llmModel: '',
  llmDailyBudget: '200',
};
let cfgSecrets = {};

function num(v, fallback) {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

async function loadConfig() {
  // 没授予 plugin.config 时这一个请求也会被拒——那不是错误，是"没有配置可读"。
  // 界面据此把"设置"相关的展示降级（背景帧则不会启动机器人）。
  if (!granted.has('plugin.config')) {
    cfgSecrets = {};
    return;
  }
  const res = await request('config.get', {}).catch(() => ({ values: {}, secrets: {} }));
  cfg = { ...cfg, ...(res.values || {}) };
  cfgSecrets = res.secrets || {};
}

// **不能在这里就 loadConfig()**：granted 要等 init 才有值，模块加载时它还是空集，
// 于是 loadConfig 会按"没授权"直接跳过，配置永远读不进来（真机上表现为机器人
// 一直说"还没有配置 AppID"）。所以第一次需要配置时才加载，并复用同一个 promise。
let configReady = null;

function ensureConfig() {
  if (!configReady) configReady = loadConfig();
  return configReady;
}

/** 用户改了设置（工坊表单或宿主里）之后重读。 */
async function refreshConfig() {
  await ensureConfig().catch(() => {});
  await loadConfig();
}

// --- 小工具 ------------------------------------------------------------------

/** 官方事件里的时间戳是 RFC3339；解析不了就回 0，由调用方决定要不要用。 */
function parseTimestamp(value) {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function truncate(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * 打平一段文本喂给模型：换行压成空格，去掉 QQ 客户端夹带的零宽字符。
 * 模型的 history 有总长上限，长消息在这里就该瘦下来。
 */
function flatten(text) {
  return String(text ?? '')
    .replace(/[\u200b\u200e\u200f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- storage：一个会话一个键 -------------------------------------------------
//
// 会话键 = 群 OpenID 或单聊用户 OpenID。它们是官方发下来的不透明字符串
//（"1B2C3D4E…"），字母数字组成，但长度不受扁平名 64 字符的约束没有保证，
// 所以进 storage 前先哈希成定长的扁平名，原文存在 JSON 里。

function flatKey(openid) {
  let h = 0x811c9dc5;
  const s = String(openid || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `s/${h.toString(16).padStart(8, '0')}`;
}

async function storageGet(key) {
  const res = await request('storage.get', { key }).catch(() => ({ value: '' }));
  return String(res?.value || '');
}

async function storageSet(key, value) {
  await request('storage.set', { key, value }).catch(() => {});
}

/** 每个会话的最新往来：[{role, text, at}]，读取时按 contextTurns 截断。 */
async function loadHistory(openid, turns) {
  if (turns <= 0) return [];
  const raw = await storageGet(flatKey(openid));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(-turns);
  } catch {
    return [];
  }
}

async function saveHistory(openid, history, turns) {
  if (turns <= 0) return;
  await storageSet(flatKey(openid), JSON.stringify(history.slice(-turns)));
}

/** 每个会话的回复节流与 msg_seq 计数：{lastReplyAt, seq:{msgId:seq}}。 */
async function loadSessionState(openid) {
  const raw = await storageGet(`${flatKey(openid)}/meta`);
  if (!raw) return { lastReplyAt: 0, seq: {} };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { lastReplyAt: 0, seq: {} };
    return { lastReplyAt: Number(parsed.lastReplyAt) || 0, seq: parsed.seq || {} };
  } catch {
    return { lastReplyAt: 0, seq: {} };
  }
}

async function saveSessionState(openid, state) {
  // msg_id 只在 5 分钟内有效，超过 10 分钟的计数直接删掉，别让对象无限长大。
  const now = Date.now();
  const seq = {};
  for (const [k, v] of Object.entries(state.seq || {})) {
    if (now - (Number(v.at) || 0) < 600000) seq[k] = v;
  }
  await storageSet(`${flatKey(openid)}/meta`, JSON.stringify({ lastReplyAt: state.lastReplyAt || 0, seq }));
}

/** 机器人身份（READY 事件里来）：[{id, username, at}]，给工坊页展示。 */
async function loadBotInfo() {
  const raw = await storageGet('bot/info');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// --- 日志（工坊页看的环形缓冲，落在自己的 storage 里） ------------------------

const LOG_KEY = 'bot/log';
const LOG_MAX = 80;

/** note 只进内存（工坊页渲染时合并）；log 持久化，跨进程也能看到。 */
async function logEvent(kind, text) {
  const at = Date.now();
  note(`${kind} ${text}`);
  const raw = await storageGet(LOG_KEY).catch(() => '');
  let list = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) list = parsed;
  } catch {
    list = [];
  }
  list.push({ at, kind, text: truncate(text, 200) });
  while (list.length > LOG_MAX) list.shift();
  await storageSet(LOG_KEY, JSON.stringify(list)).catch(() => {});
}

const memNotes = [];

function note(text) {
  memNotes.push(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${text}`);
  while (memNotes.length > 200) memNotes.shift();
  if (view !== 'background') {
    // 工坊页里 console 就是宿主日志页的一行（控制中心能打开调试窗口）。
    console.log(`[qqbot] ${text}`);
  }
}

async function loadLog() {
  const raw = await storageGet(LOG_KEY).catch(() => '');
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
