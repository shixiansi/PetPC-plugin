// lib/core.js —— 文档骨架、宿主桥、配置、私有存储
//
// 这个插件是**薄**的：它不认识人设，也不存任何记忆。人设、记忆、模型预算都在
// `com.shixiansi.plugin-memcore` 里，所以接一个新平台只是加一层管道，改一次人设全平台生效。
// 反过来，这一层一旦开始自己记东西，同一份记忆就有两个副本，而两个副本迟早会说出不一样的话。

'use strict';

// --- DOM ---------------------------------------------------------------------
//
// 常驻帧（slot:"background"）里这些全都不存在——那一面只挂脚本、不画界面——所以一律可选访问。

const els = {
  root: document.getElementById('root'), workshop: document.getElementById('workshop'),
  chipState: document.getElementById('chip-state'), chipToken: document.getElementById('chip-token'),
  chipPoll: document.getElementById('chip-poll'), chipAllow: document.getElementById('chip-allow'),
  warn: document.getElementById('warn'), warnCard: document.getElementById('warn-card'),
  facts: document.getElementById('facts'), settings: document.getElementById('settings'),
  log: document.getElementById('log'), logEmpty: document.getElementById('log-empty'),
  refresh: document.getElementById('refresh'), status: document.getElementById('status'),
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

// --- state -------------------------------------------------------------------

const granted = new Set();
let self = { pluginId: '', slot: '' };
let ready = false;
let cfg = {};
/** `config.get` 回的 `secrets`：secret 项只有 `{set, mask}`，没有明文。 */
let secrets = {};
/** 上一次成功重读设置的时刻：常驻帧据此决定要不要再读一次（见 refreshConfigIfDue）。 */
let configReadAt = 0;

// --- helpers -----------------------------------------------------------------

function now() {
  return Date.now();
}

function text(value, max) {
  const s = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  const limit = Number.isFinite(max) && max > 0 ? max : 2000;
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value === undefined || value === null ? '' : value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function num(key, min, max, fallback) {
  return clampInt(cfg[key], min, max, fallback);
}

function flag(key, fallback) {
  const v = cfg[key];
  if (v === undefined || v === null || v === '') return fallback;
  return v === true || v === 'true' || v === '1' || v === 1;
}

/**
 * 把 token 从任何一行要出门的文本里抹掉。
 *
 * 为什么需要：宿主的 `net.fetch` 连不上时把 Go 的 `*url.Error` 原文交回来，那段文本**带着整个
 * URL**（也就是 `/bot<token>/getUpdates`）；它进面板没人在意，进 `plugin.log` 就进了诊断报告
 * （用户会把它贴给别人）。正则是兜底：token 没配置过时也要能认出来。
 */
function redact(line) {
  let s = String(line === undefined || line === null ? '' : line);
  const token = String(cfg.botToken || '').trim();
  if (token) s = s.split(token).join('<token>');
  return s.replace(/bot[0-9]+:[A-Za-z0-9_-]{8,}/g, 'bot<token>');
}

// --- 配置 --------------------------------------------------------------------

/**
 * Bot Token。
 *
 * WHY 它是 `text` 而不是 `secret`：token 必须出现在请求**路径**里（`/bot<token>/getUpdates`），
 * 而 secret 项对插件只回 `{set, mask}`（明文永不出宿主进程），`net.fetch` 唯一能用 secret 的
 * 地方是 Cookie 头（还要 `net.credentials`），覆盖不到 URL。取舍与代价见 README。
 */
function botToken() {
  return String(cfg.botToken || '').trim();
}

/**
 * 「这个 secret 配没配好」的唯一正确读法：`config.get` 回的 `{set:true}`。
 * 现在没有 secret 项用它，但这个例子必须留着——否则下一个人会以为"读回明文"是一条存在的路。
 */
function secretSet(key) {
  const row = secrets && secrets[key];
  return Boolean(row && row.set === true);
}

/** 允许的 chat id。**留空 = 谁的都不收**（不是"全都收"，这里刻意不做成通配）。 */
function chatAllowList() {
  return String(cfg.allowedChats || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

function chatAllowed(chatId) {
  return chatAllowList().includes(String(chatId));
}

function pollEnabled() {
  return flag('pollEnabled', false);
}

function pollBatch() {
  return num('pollCount', 1, 100, 20);
}

/** 重读设置。设置可以在**另一个进程**里改（控制中心的插件页），而这个文档是常驻的：
 *  缓存到天荒地老的结果是"我改了 token，它还在用旧的那个"，而界面上看不出原因。 */
async function refreshConfig() {
  if (!granted.has('plugin.config')) return false;
  try {
    const out = await request('config.get', {});
    cfg = Object.assign({}, cfg, (out && out.values) || {});
    secrets = (out && out.secrets) || {};
    configReadAt = now();
    return true;
  } catch {
    // 读不到就沿用上一次的：一次 config.get 失败不该让管道停摆。
    return false;
  }
}

// --- 私有存储 ----------------------------------------------------------------

const KEY_OFFSET = 'state/offset';
const KEY_STATUS = 'state/status';
const KEY_NOTES = 'state/notes';

async function readJSON(key, fallback) {
  if (!granted.has('storage')) return fallback;
  try {
    const out = await request('storage.get', { key });
    const raw = out && typeof out.value === 'string' ? out.value : '';
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

async function writeJSON(key, value) {
  if (!granted.has('storage')) return;
  // 写不进去不是致命错误：游标与状态都还有内存里那一份。
  await request('storage.set', { key, value: JSON.stringify(value) }).catch(() => {});
}

// --- 事件行 ------------------------------------------------------------------

/** 面板上的尾巴（只放"发生了什么"，不放消息正文，也不放 token）。 */
const notes = [];

function note(line) {
  const entry = { at: now(), line: text(redact(line), 200) };
  notes.push(entry);
  while (notes.length > 40) notes.shift();
  if (els.log && els.log.parentElement) renderNotes();
  void writeJSON(KEY_NOTES, notes);
}

/**
 * 往宿主日志里写一行（`plugin.log`，借 `storage` 权限）。用它而不是 `note` 的场合：用户在
 * 看不见界面时也要留证据的事（忽略的消息类型、网络失败、记忆核心报错）。宿主编会节流。
 */
function logLine(level, message) {
  if (!granted.has('storage')) return;
  void request('plugin.log', { level, message: text(redact(message), 400) }).catch(() => {});
}

function renderNotes() {
  if (!els.log) return;
  els.log.textContent = '';
  const recent = notes.slice(-12).reverse();
  if (els.logEmpty) els.logEmpty.hidden = recent.length > 0;
  for (const item of recent) {
    const row = document.createElement('li');
    const pad = (x) => `${x}`.padStart(2, '0');
    const when = new Date(item.at);
    row.textContent = `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())} · ${item.line}`;
    els.log.append(row);
  }
}

function say(line) {
  if (els.status) els.status.textContent = line || '';
}

/** 芯片：这几格里每一格都是"没反应"时第一个该看的东西。 */
function renderStatus() {
  const allow = chatAllowList();
  if (els.chipState) els.chipState.textContent = pollState.message || '状态：还没开始';
  if (els.chipToken) els.chipToken.textContent = botToken() ? 'Bot Token：已保存' : 'Bot Token：没填';
  if (els.chipPoll) {
    els.chipPoll.textContent = pollEnabled() ? '收消息：开' : '收消息：关（设置里的「轮询开关」）';
  }
  if (els.chipAllow) {
    els.chipAllow.textContent = allow.length ? `允许的 chat：${allow.length} 个` : '允许的 chat：空（谁的都不收）';
  }
}
