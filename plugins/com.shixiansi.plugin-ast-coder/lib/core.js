// lib/core.js —— 文档骨架、DOM 引用、宿主桥（与 live-danmaku 同一形状）
//
// 经典 script，与同目录其它文件共享一个全局作用域；加载顺序写在 panel.html 里。

'use strict';

const els = {
  root: document.getElementById('root'),
  workshop: document.getElementById('workshop'),
  chipState: document.getElementById('chip-state'),
  statusNote: document.getElementById('status-note'),
  statusError: document.getElementById('status-error'),
  statFiles: document.getElementById('stat-files'),
  statScans: document.getElementById('stat-scans'),
  indexList: document.getElementById('index-list'),
  indexEmpty: document.getElementById('index-empty'),
  codeBox: document.getElementById('code-box'),
  codeName: document.getElementById('code-name'),
  reviewBtn: document.getElementById('review-btn'),
  genBtn: document.getElementById('gen-btn'),
  result: document.getElementById('result'),
  resultEmpty: document.getElementById('result-empty'),
  watchToggle: document.getElementById('watch-toggle'),
};

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

/** 把一次 plugin.call 的答案交回去（ticket 原样带回；ok 必须显式）。 */
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

// --- helpers -----------------------------------------------------------------

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
