// lib/core.js —— 文档骨架与宿主桥（与 websearch / memcore / rss-reader 同一封信封）

'use strict';

const els = {
  root: document.getElementById('root'),
  workshop: document.getElementById('workshop'),
  writeNow: document.getElementById('write-now'),
  latest: document.getElementById('latest'),
  latestMeta: document.getElementById('latest-meta'),
  list: document.getElementById('diary-list'),
  status: document.getElementById('status'),
};

const PROTOCOL = 1;
let nextRequestID = 1;
const pending = new Map();

/**
 * 出站**必须**打在 `window.parent` 上。`window.postMessage` 的收件人是"被调用的那个 window"，
 * 写在 `window` 上等于把 ready / request 发给了自己：宿主（父文档）一条都收不到，帧永远拿不到
 * init。jsdom 里假宿主与插件文档同住一个 window，所以这条错误只在真浏览器的 iframe 拓扑里现形。
 */
function postToHost(message) {
  if (!window.parent) return;
  window.parent.postMessage({ v: PROTOCOL, ...message }, '*');
}

function request(method, payload) {
  const id = String(nextRequestID++);
  postToHost({ type: 'request', id, method, payload: payload === undefined ? {} : payload });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

/** 一次 plugin.call 的回包。ticket 原样带回——带错了宿主不认。 */
function postCallResult(ticket, ok, value) {
  const message = { v: PROTOCOL, type: 'call-result', ticket, ok: Boolean(ok) };
  if (ok) message.result = value === undefined ? null : value;
  else message.error = String(value && value.message ? value.message : value);
  postToHost(message);
}

const granted = new Set();
let self = { pluginId: '', slot: '' };
let ready = false;
let cfg = {};

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

async function refreshConfig() {
  try {
    const out = await request('config.get', {});
    cfg = Object.assign({}, (out && out.values) || {});
  } catch {
    // 读不到沿用上一次。
  }
}

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
