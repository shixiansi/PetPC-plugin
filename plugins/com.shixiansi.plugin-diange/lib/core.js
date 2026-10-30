// lib/core.js —— 文档骨架与宿主桥
//
// 经典 script，与同目录其它文件共享一个全局作用域；加载顺序写在 panel.html 里。
// 与其它插件同一封信封：{v, type, id, method, payload}，宿主拒绝时 reject 的是宿主那句
// 中文（"未获权限 net.fetch"、"域名不在白名单"），原样显示——包装成"操作失败"就把要修
// 的东西藏起来了。
//
// 两副面孔（由 init.surface.slot 决定，不猜 kind：常驻帧的 kind 也是 panel）：
//
//   background   桌宠挂的常驻帧。不画任何东西，等着被 plugin.call 问 song / song_link。
//                这才是这个插件真正工作的地方——用户在群里点歌时，没有一个界面是开着的。
//   workshop     控制中心插件页。手动点一首（能不能真跑，看宿主服务不服务 net.fetch）。

'use strict';

// --- DOM ---------------------------------------------------------------------
//
// 常驻帧里这些元素全都不存在（那个文档只加载脚本，不画界面），所以每个都按可选访问。

const els = {
  root: document.getElementById('root'),
  workshop: document.getElementById('workshop'),
  chipApi: document.getElementById('chip-api'),
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

/** 宿主授予了什么（init.granted）。只用来解释界面，不用来决定能不能做——宿主会拒绝。 */
const granted = new Set();
let self = { pluginId: '', slot: '', host: null };
let ready = false;
let cfg = {};

// --- storage -----------------------------------------------------------------

async function readJSON(key, fallback) {
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

/** 重读设置：每次 song / song_link 之前都读一遍（设置可能在控制中心里被改过）。 */
async function refreshConfig() {
  if (!granted.has('plugin.config')) {
    // 没有这项权限就连问都不问：一次注定被拒的请求在自检与日志里都是一条噪音。
    cfg = {};
    return;
  }
  try {
    const out = await request('config.get', {});
    cfg = Object.assign({}, (out && out.values) || {});
  } catch {
    // 读不到沿用上一次：一次 config.get 失败不该让点歌停摆。
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
