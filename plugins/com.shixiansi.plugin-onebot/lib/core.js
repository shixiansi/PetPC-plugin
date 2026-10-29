// lib/core.js —— 文档骨架、宿主桥、共享状态
//
// 这个插件是**薄**的：它不认识人设，也不存任何记忆。它的全部职责是
//
//   OneBot 协议端 ──ws──▶ 宿主(net.ws) ──event──▶ 这里 ──plugin.call──▶ 记忆核心
//                                                   ◀── 回答 ──
//   协议端 ◀── ws.send(send_group_msg) ── 宿主 ────────┘
//
// 为什么"薄"是要紧的：人设、记忆、模型预算都在记忆核心里，所以换一个接入端（QQ 官方机器人、
// 别的聊天协议）只是换这一层；改一次人设，所有接入端同时生效，不需要搬任何数据。
//
// 反过来说，这一层**不**该长出记忆：一旦它开始自己记东西，同一份记忆就会有两个副本，
// 而两个副本迟早会说出不一样的话。

'use strict';

// --- DOM ---------------------------------------------------------------------
//
// 常驻帧里这些都不存在（那一面只加载脚本，不画界面），所以一律可选访问。

const els = {
  root: document.getElementById('root'),
  workshop: document.getElementById('workshop'),
  chipSlot: document.getElementById('chip-slot'),
  chipWs: document.getElementById('chip-ws'),
  chipSelf: document.getElementById('chip-self'),
  facts: document.getElementById('facts'),
  groups: document.getElementById('groups-body'),
  groupsEmpty: document.getElementById('groups-empty'),
  log: document.getElementById('log'),
  logEmpty: document.getElementById('log-empty'),
  status: document.getElementById('status'),
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

/** 连接状态：`closed` / `connecting` / `open` / `error`，来自宿主的 ws.state 事件。 */
let wsState = 'closed';
/** 协议端告诉我们的机器人 QQ 号（或用户在设置里填的那个）。 */
let selfId = '';
/** 同会话冷却：会话键 -> 上次回答的时刻。 */
const lastReplyAt = new Map();
/** 面板上的日志尾巴（只放"发生了什么"，不放消息正文）。 */
const notes = [];

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

/** 把一个平台 id 压成可以当存储段与 roleId 用的形状。 */
function keyOf(raw, fallback) {
  const cleaned = String(raw === undefined || raw === null ? '' : raw)
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned || fallback;
}

async function readJSON(key, fallback) {
  try {
    const out = await request('storage.get', { key });
    const raw = out && typeof out.value === 'string' ? out.value : '';
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

async function writeJSON(key, value) {
  await request('storage.set', { key, value: JSON.stringify(value) });
}

/**
 * 重读设置。
 *
 * 设置可以在**另一个进程**里改（控制中心的插件页），而这个文档是常驻的：缓存到天荒地老的
 * 结果是"我改了地址，它还在连旧的那个"，而且没有任何地方看得出原因。
 */
async function refreshConfig() {
  try {
    const out = await request('config.get', {});
    cfg = Object.assign({}, (out && out.values) || {});
  } catch {
    // 读不到就沿用上一次的。
  }
}

/** 记一行"发生了什么"：面板看得见，日志文件里也有（插件调用本身会被宿主记一行）。 */
function note(line) {
  const entry = { at: now(), line: text(line, 200) };
  notes.push(entry);
  while (notes.length > 40) notes.shift();
  if (els.log && els.log.parentElement) renderNotes();
  void writeJSON('state/notes', notes).catch(() => {});
}

function renderNotes() {
  if (!els.log) return;
  els.log.textContent = '';
  const recent = notes.slice(-12).reverse();
  if (els.logEmpty) els.logEmpty.hidden = recent.length > 0;
  for (const item of recent) {
    const row = document.createElement('li');
    const when = new Date(item.at);
    const pad = (x) => `${x}`.padStart(2, '0');
    row.textContent = `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())} · ${item.line}`;
    els.log.append(row);
  }
}

function say(line) {
  if (els.status) els.status.textContent = line || '';
}

/** 把当前状态写进面板：芯片 + 统计。 */
function renderStatus() {
  if (els.chipWs) {
    els.chipWs.textContent = wsState === 'open'
      ? '连接：已连上'
      : wsState === 'connecting'
        ? '连接：正在连'
        : wsState === 'error'
          ? '连接：出错（宿主会自动重试）'
          : '连接：未连接';
  }
  if (els.chipSelf) els.chipSelf.textContent = selfId ? `机器人：${selfId}` : '机器人：未知（等协议端说）';
  if (els.chipSlot) els.chipSlot.textContent = self.slot === 'workshop' ? 'OneBot 接入端 · 插件页' : 'OneBot 接入端';
}
