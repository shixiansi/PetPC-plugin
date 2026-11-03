// lib/core.js —— 文档骨架与宿主桥
//
// 与 diary-writer / rss-reader / websearch 同一封信封：四种入站（init / response / event / call），
// 出站只有 ready 与 request。这一层只放**协议**与**配置读法**，业务在 week / collect / report / views。

'use strict';

const PROTOCOL = 1;
let nextRequestID = 1;
const pending = new Map();

/** init 里那一份授权。**只在收到 init 的那一刻是权威的**（授权变了宿主会重挂帧，手册 §9.1）。 */
const granted = new Set();
let self = { pluginId: '', role: '', slot: '' };
let ready = false;
let cfg = {};

const els = Object.fromEntries(Object.entries({
  card: 'card', cardWeek: 'card-week', cardNow: 'card-now', cardMissing: 'card-missing',
  cardLine: 'card-line', numTodo: 'num-todo', numFocus: 'num-focus', numDiary: 'num-diary',
  workshop: 'workshop', makeNow: 'make-now', latestTitle: 'latest-title', latestMeta: 'latest-meta',
  latestText: 'latest-text', latestMissing: 'latest-missing', sources: 'sources', status: 'status',
}).map(([key, id]) => [key, document.getElementById(id)]));

/**
 * 出站**必须**打在 `window.parent` 上。`window.postMessage` 的收件人是"被调用的那个 window"，
 * 所以写在 `window` 上等于把 ready / request 发给了自己：宿主（父文档）一条都收不到，帧永远
 * 拿不到 init，浮层面就一直停在那块没有内容的矩形里。
 *
 * 这个错误在 jsdom 里看不出来——假宿主和插件文档住在同一个 window，`window.postMessage` 正好
 * 送达；只有真浏览器里"插件在 iframe、宿主在外"这个拓扑才暴露它。所以除了这一行，用例里还有
 * 一条把父窗口换成另一个对象的回归用例（tests/plugin-weekly-review.test.js 的「真宿主拓扑」）。
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
  else message.error = msgOf(value);
  postToHost(message);
}

/**
 * 读一个 JSON 值。三道兜底是刻意的：没授权、宿主拒绝、值不是 JSON 都回 fallback——
 * 一篇周报不该因为存储读不出来就整页空白。
 */
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

async function refreshConfig() {
  if (!granted.has('plugin.config')) return;
  try {
    const out = await request('config.get', {});
    cfg = Object.assign({}, cfg, (out && out.values) || {});
  } catch {
    // 读不到就沿用上一次；每一项都有清单里的默认值兜着。
  }
}

function now() { return Date.now(); }

/** 截断到 max 个字符（省略号算一个）。字符而不是字节：300 字是用户数得出来的。 */
function clip(value, max) {
  const s = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 300;
  return s.length > limit ? `${s.slice(0, Math.max(0, limit - 1))}…` : s;
}

function msgOf(err) {
  if (!err) return '未知错误';
  if (typeof err === 'string') return err;
  return String(err.message || err);
}

/** 非负整数；别的都算"这个字段没有"（null，不是 0——0 与"没拿到"在周报里是两件事）。 */
function numOr(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function flag(key, fallback) {
  const v = cfg[key];
  return v === undefined || v === null || v === '' ? fallback : v === true || v === 'true' || v === '1' || v === 1;
}

/** 状态行：卡片写结论那一行，插件页写底部的 .status（两个落点没有共同的元素）。 */
function say(line) {
  const node = self.role === 'workshop' ? els.status : els.cardLine;
  if (node) node.textContent = line || '';
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

applyTheme(new URLSearchParams(location.search).get('theme'));
