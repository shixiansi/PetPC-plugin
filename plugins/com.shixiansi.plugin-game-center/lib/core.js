// lib/core.js —— 文档骨架与宿主桥
//
// 与 websearch / memcore / screen-vision / rss-reader 的 core.js 同一封信封。
//
// 这份文档只有一种挂载：surface 块（宠物旁的浮层卡）。没有 background——游戏只在
// 用户看着的时候有意义，合上浮层就停（surface.blocks 的 hidden 会把帧整个卸掉）。

'use strict';

// --- DOM ---------------------------------------------------------------------

const els = {
  root: document.getElementById('root'),
  card: document.getElementById('game-card'),
  menu: document.getElementById('menu'),
  play: document.getElementById('play'),
  board: document.getElementById('board'),
  hud: document.getElementById('hud'),
  hudScore: document.getElementById('hud-score'),
  hudLives: document.getElementById('hud-lives'),
  hudEffects: document.getElementById('hud-effects'),
  pause: document.getElementById('pause'),
  result: document.getElementById('result'),
  resultTitle: document.getElementById('result-title'),
  resultDetail: document.getElementById('result-detail'),
  resultBest: document.getElementById('result-best'),
  again: document.getElementById('again'),
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

// --- storage -----------------------------------------------------------------

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
