// lib/core.js —— 文档骨架、DOM 引用、宿主桥
//
// 经典 script，与同目录其它文件共享一个全局作用域；加载顺序写在 panel.html 里，
// 所以这里不用 import/export。
//
// 这个文档有两副面孔，由 init.surface.slot 决定（不是 kind：常驻帧的 kind 也是 panel）：
//
//   background  桌宠挂的常驻帧：持有 WebSocket 连接、缓冲队列与互动循环，什么都不画。
//   workshop    控制中心插件页：直播间状态、在线人数、滚动的精简弹幕列表，只读 + 开关。
//
// WHY 弹幕插件必须常驻
//
// 弹幕流在用户关掉界面之后照样要收（防抖队列攒着的弹幕不会因为面板关了就消失），
// 而 net.ws 的事件只送到挂载着的帧——声明 background:true 是唯一能让这条连接
// "一直有人听"的方式（手册 §7 的送达条件）。

'use strict';

// --- DOM ---------------------------------------------------------------------
//
// 常驻帧里这些元素全都不存在（那个文档只加载脚本，不画界面），所以每个都用可选访问。

const els = {
  root: document.getElementById('root'),
  workshop: document.getElementById('workshop'),
  chipState: document.getElementById('chip-state'),
  chipModel: document.getElementById('chip-model'),
  statusNote: document.getElementById('status-note'),
  statusError: document.getElementById('status-error'),
  statOnline: document.getElementById('stat-online'),
  statWatched: document.getElementById('stat-watched'),
  statAccepted: document.getElementById('stat-accepted'),
  statDropped: document.getElementById('stat-dropped'),
  statQueue: document.getElementById('stat-queue'),
  statReplies: document.getElementById('stat-replies'),
  statLlmCalls: document.getElementById('stat-llm-calls'),
  dmList: document.getElementById('dm-list'),
  dmEmpty: document.getElementById('dm-empty'),
  log: document.getElementById('log'),
  replyList: document.getElementById('reply-list'),
  replyEmpty: document.getElementById('reply-empty'),
  startStop: document.getElementById('start-stop'),
};

// --- the bridge --------------------------------------------------------------
//
// 和别的插件同一个信封：{v,type,id,method,payload}。被宿主拒绝时 reject 的是宿主自己那句
// 中文（"插件 X 未获权限 …"），原样显示——包装成"操作失败"就把用户要修的东西藏起来了。

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

/** 宿主授予了什么（init.granted）。只用来解释界面；能不能做由宿主的闸门说了算。 */
const granted = new Set();
let self = { pluginId: '', slot: '' };
let ready = false;

/** 设置项的值（config.get 的 values）。workshop 每次刷新时重读。 */
let cfg = {};

// --- helpers -----------------------------------------------------------------

/** 把一个外来的 id 压成合法的存储段（字母/数字/下连字符/下划线，≤48）。 */
function keyOf(raw, fallback) {
  const cleaned = String(raw === undefined || raw === null ? '' : raw)
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || fallback;
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

function now() {
  return Date.now();
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

function say(line) {
  if (els.statusNote) els.statusNote.textContent = line || '';
}

function noteError(line) {
  if (els.statusError) els.statusError.textContent = line || '';
  else say(line);
}

/** 本地日期键（每日预算/统计按天重置时用）。 */
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}

/** UI 里用的房间号：配置为 0/空 时显示「未设置」。 */
function roomLabel() {
  const raw = String(cfg.roomId || '').trim();
  return raw && raw !== '0' ? raw : '';
}
