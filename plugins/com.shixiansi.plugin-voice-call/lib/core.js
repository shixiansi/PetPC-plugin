// lib/core.js —— 文档骨架、DOM 引用、宿主桥（与前几个插件同一形状）

'use strict';

const els = {
  root: document.getElementById('root'),
  workshop: document.getElementById('workshop'),
  chipState: document.getElementById('chip-state'),
  statusNote: document.getElementById('status-note'),
  statusError: document.getElementById('status-error'),
  callToggle: document.getElementById('call-toggle'),
  stateNow: document.getElementById('state-now'),
  levelNow: document.getElementById('level-now'),
  statInterrupts: document.getElementById('stat-interrupts'),
  statUtterances: document.getElementById('stat-utterances'),
  statReplies: document.getElementById('stat-replies'),
  statAborted: document.getElementById('stat-aborted'),
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

function say(line) {
  if (els.statusNote) els.statusNote.textContent = line || '';
}
