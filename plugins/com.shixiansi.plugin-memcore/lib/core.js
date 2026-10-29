// lib/core.js —— 文档骨架与宿主桥
//
// 经典 script，与同目录其它文件共享一个全局作用域；加载顺序写在 panel.html 里，
// 所以这里不用 import/export。
//
// WHAT THIS DOCUMENT IS
//
// 它有两副面孔，由 init.surface.slot 决定（不是 kind：常驻帧的 kind 也是 panel）：
//
//   background   桌宠挂的常驻帧。没有界面，也不该画任何东西。这是"记忆核心"真正工作的地方：
//                等别的插件用 plugin.call 问它、回答、把这一轮记下来。
//   workshop     控制中心插件页里那一份。只读的人设与记忆浏览，加上"清掉某个会话"。
//
// 为什么要有第二副面孔：记忆是用户的数据，看不见的数据等于不在。而它**不能**改人设——
// 人设是 config，编辑器由宿主按 manifest 画，插件自己再画一个只会有两套真话。
//
// WHY THE ANSWER GOES BACK THROUGH `call-result` AND NOT `response`
//
// `call` / `call-result` 是宿主对 plugin.call 的转发（手册 §6.8），不是普通的 request：
// 一次调用只认一个回包，并且 ticket 必须原样带回——它是把回包配给"哪一次提问"的唯一线索。

'use strict';

// --- DOM ---------------------------------------------------------------------
//
// 常驻帧里这些元素全都不存在（那个文档只加载脚本，不画界面），所以每个都用可选访问。

const els = {
  root: document.getElementById('root'),
  workshop: document.getElementById('workshop'),
  chipSlot: document.getElementById('chip-slot'),
  chipModel: document.getElementById('chip-model'),
  facts: document.getElementById('facts'),
  personas: document.getElementById('persona-preview'),
  roles: document.getElementById('roles'),
  rolesBody: document.getElementById('roles-body'),
  rolesEmpty: document.getElementById('roles-empty'),
  detail: document.getElementById('detail'),
  detailTitle: document.getElementById('detail-title'),
  detailSummary: document.getElementById('detail-summary'),
  detailEpisodes: document.getElementById('detail-episodes'),
  detailProfile: document.getElementById('detail-profile'),
  detailChain: document.getElementById('detail-chain'),
  forget: document.getElementById('forget'),
  status: document.getElementById('status'),
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

/**
 * 把一次 plugin.call 的答案交回去。
 *
 * `ticket` 是宿主发给我们的关联号，原样带回；带错了宿主不认（那一侧只会等到超时），
 * 所以这里不做任何"重新生成"。
 */
function postCallResult(ticket, ok, value) {
  // `ok` 必须显式写出来：宿主的判定是 `data.ok === true`（手册 §6.8），少了这个字段它会把
  // 一个成功的回答当成拒绝——症状是调用方拿到"目标没有说为什么拒绝"。
  const message = { v: PROTOCOL, type: 'call-result', ticket, ok: Boolean(ok) };
  if (ok) message.result = value === undefined ? null : value;
  else message.error = String(value && value.message ? value.message : value);
  postToHost(message);
}

// --- state -------------------------------------------------------------------

/** 宿主授予了什么（init.granted）。**不**用它判断能不能做：宿主会拒绝。它只用来解释界面。 */
const granted = new Set();
let self = { pluginId: '', slot: '' };
let ready = false;

/** 设置项的值（config.get 的 values）。每次用之前重新读一次成本不低，所以缓存； */
/** 但摘要/画像这些长期动作会跨很多天，所以在每次 plugin.call 开始时**重读**。 */
let cfg = {};

// --- storage -----------------------------------------------------------------
//
// 键是相对路径（最多 4 段，每段只有字母/数字/下划线/连字符）。宿主管的是"写完就落盘"，
// 插件这边只负责形状。

async function readJSON(key, fallback) {
  try {
    const out = await request('storage.get', { key });
    const raw = out && typeof out.value === 'string' ? out.value : '';
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    // 读不出来 = 当作没有。一个坏掉的文件不该让整场对话失败。
    return fallback;
  }
}

async function writeJSON(key, value) {
  await request('storage.set', { key, value: JSON.stringify(value) });
}

async function removeKey(key) {
  try {
    await request('storage.remove', { key });
  } catch {
    // 已经不在了也算成功。
  }
}

// --- helpers -----------------------------------------------------------------

function now() {
  return Date.now();
}

/** 把一个外来的 id 压成合法的存储段（字母/数字/下划线/连字符，≤48）。 */
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

/** 今天（本地时区）的日期键，用于每日预算是按天重置的。 */
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}

function say(line) {
  if (els.status) els.status.textContent = line || '';
}
