// lib/core.js —— 文档骨架与宿主桥
//
// 经典 script，与同目录其它文件共享一个全局作用域；加载顺序写在 panel.html 里。
// 与 memcore 的 core.js 同一封信封：{v, type, id, method, payload}，宿主拒绝时 reject
// 的是宿主那句中文，原样显示。
//
// 两副面孔（由 init.surface.slot 决定）：
//
//   background   桌宠挂的常驻帧。不画任何东西，等着被 plugin.call 问。
//   workshop     控制中心插件页。手动搜索 + 最近记录 + 引擎状态。
//
// 控制中心不服务 net.fetch（手册 §9），所以「试一下」按钮只出现在桌宠那一面——
// 这里没有桌宠窗口，发一次注定被拒的请求只会往宿主日志里多写一条 WARN。

'use strict';

// --- DOM ---------------------------------------------------------------------
//
// 常驻帧里这些元素全都不存在，每个都按可选访问。

const els = {
  root: document.getElementById('root'),
  workshop: document.getElementById('workshop'),
  chipEngine: document.getElementById('chip-engine'),
  chipSlot: document.getElementById('chip-slot'),
  query: document.getElementById('query'),
  go: document.getElementById('go'),
  results: document.getElementById('results'),
  resultsEmpty: document.getElementById('results-empty'),
  history: document.getElementById('history'),
  historyBody: document.getElementById('history-body'),
  historyEmpty: document.getElementById('history-empty'),
  historyClear: document.getElementById('history-clear'),
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

/** 一次 plugin.call 的回包。ticket 原样带回——带错了宿主不认，调用方只会等到超时。 */
function postCallResult(ticket, ok, value) {
  const message = { v: PROTOCOL, type: 'call-result', ticket, ok: Boolean(ok) };
  if (ok) message.result = value === undefined ? null : value;
  else message.error = String(value && value.message ? value.message : value);
  postToHost(message);
}

// --- state -------------------------------------------------------------------

const granted = new Set();
let self = { pluginId: '', slot: '' };
let ready = false;
let cfg = {};

// --- storage -----------------------------------------------------------------

async function readJSON(key, fallback) {
  // 没有 storage 权限就连问都不问：宿主会拒绝，而一次被拒的请求在自检里就是一条
  // `ungranted-request`。插件该在**发请求之前**知道自己没有这个能力。
  if (!granted.has('storage')) return fallback;
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

/** 重读设置。搜索与界面各用各的时机：每次 search、每次重画都读一遍最新的。 */
async function refreshConfig() {
  // 同上：没有 plugin.config 就别问。
  if (!granted.has('plugin.config')) {
    cfg = {};
    return;
  }
  try {
    const out = await request('config.get', {});
    cfg = Object.assign({}, (out && out.values) || {});
  } catch {
    // 读不到沿用上一次：一次 config.get 失败不该让搜索停摆。
  }
}

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

function say(line) {
  if (els.status) els.status.textContent = line || '';
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

applyTheme(new URLSearchParams(location.search).get('theme'));
