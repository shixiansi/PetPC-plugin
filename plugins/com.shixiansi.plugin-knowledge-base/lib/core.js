// lib/core.js —— 文档骨架与宿主桥（与 websearch / memcore / rss-reader / diary 同一封信封）

'use strict';

const els = {
  root: document.getElementById('root'),
  workshop: document.getElementById('workshop'),
  docText: document.getElementById('doc-text'),
  docTitle: document.getElementById('doc-title'),
  docAdd: document.getElementById('doc-add'),
  fetchNow: document.getElementById('fetch-now'),
  ask: document.getElementById('ask'),
  question: document.getElementById('question'),
  answer: document.getElementById('answer'),
  answerMeta: document.getElementById('answer-meta'),
  docList: document.getElementById('doc-list'),
  docEmpty: document.getElementById('doc-empty'),
  indexBar: document.getElementById('index-bar'),
  status: document.getElementById('status'),
};

const PROTOCOL = 1;
let nextRequestID = 1;
const pending = new Map();

function postToHost(message) {
  if (!window.parent) return;
  window.postMessage({ v: PROTOCOL, ...message }, '*');
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

function say(line) {
  if (els.status) els.status.textContent = line || '';
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

applyTheme(new URLSearchParams(location.search).get('theme'));
