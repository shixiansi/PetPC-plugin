// 行情看板：常驻帧按 tick 拉行情、判休市；浮层面画 sparkline；插件页管理代码清单。
//
// 一个文档，三种挂载（见 panel.html 顶部注释）。纯逻辑全在 window.QuoteCore。
//
// "休市/无新数据不刷"的实现：每轮抓完先算 snapshotHash（全部代码的 price+changePct 串），
// 与上次相同 → 不写盘、不重画（画布静止正是"休市"的样子）；不同 → 写盘 + 重画。
// 没有交易日历（节假日是"行情源没给新数"的特例，同一条路兜住）——真日历等宿主机制，open。
//
// 轮询纪律：tick 60 秒一跳，每项按自己的 nextAt（≥15 分钟）到期才发请求；垃圾响应不算
// 失败也算"无数据"——不追打；连续失败退避翻倍封顶一小时（与 price-watch 同款）。
//
// 展示语义：解析不出的一律"无数据"，绝不编数字；config 的 apiBase 走 hostWhitelist。

'use strict';

// --- 宿主桥 ------------------------------------------------------------------

const PROTOCOL = 1;
const PLUGIN_ID = 'com.shixiansi.plugin-finance-board';
const HOST = window.parent;
let nextId = 1;
const pending = new Map();
const granted = new Set();

function request(method, payload) {
  const id = `f${nextId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    HOST.postMessage({ v: PROTOCOL, type: 'request', id, method, payload: payload || {} }, '*');
  });
}

// --- 时钟（测试接缝） ----------------------------------------------------------

const clock = { nowMs: () => Date.now() };
function nowMs() { return clock.nowMs(); }

// --- 状态 --------------------------------------------------------------------

let self = { slot: '', kind: '', hostMethods: null };
let ready = false;
let cfg = { symbols: 'sh000001', apiBase: 'https://qt.gtimg.cn/q=', upColorIsRed: true, showBadge: false };
let state = { lastHash: '', quotes: {}, history: {}, failCount: 0, nextAt: 0 };
let loaded = false;
let loadPromise = null;
let busy = false;
let viewKey = '';

const KEY_STATE = 'state/v1'; // {lastHash, quotes:{code:q}, history:{code:[price,...]}, failCount, nextAt}
const HISTORY_MAX = 30;

function hostServes(method) {
  if (self.hostMethods) return self.hostMethods.indexOf(method) >= 0;
  if (self.slot === 'workshop') return false;
  return true;
}

// --- 配置 --------------------------------------------------------------------

async function refreshConfig() {
  if (!granted.has('plugin.config')) return;
  const res = await request('config.get', {}).catch(() => null);
  if (!res || !res.values) return;
  cfg.symbols = String(res.values.symbols || 'sh000001');
  cfg.apiBase = String(res.values.apiBase || 'https://qt.gtimg.cn/q=');
  cfg.upColorIsRed = String(res.values.upColorIsRed ?? 'true') !== 'false';
  cfg.showBadge = String(res.values.showBadge ?? 'false') === 'true';
}

function symbolList() {
  return cfg.symbols.split(/[,，\s]+/).map((s) => s.trim().toLowerCase()).filter(/./.test.bind(/^(sh|sz|bj)\d{5,6}$/));
}

// --- 存取 --------------------------------------------------------------------

function parseState(text) {
  const empty = { lastHash: '', quotes: {}, history: {}, failCount: 0, nextAt: 0 };
  if (!text) return empty;
  try {
    const v = JSON.parse(String(text));
    if (!v || typeof v !== 'object') return empty;
    return {
      lastHash: String(v.lastHash || ''),
      quotes: v.quotes && typeof v.quotes === 'object' ? v.quotes : {},
      history: v.history && typeof v.history === 'object' ? v.history : {},
      failCount: Number(v.failCount) || 0,
      nextAt: Number(v.nextAt) || 0,
    };
  } catch { return empty; }
}

async function loadState() {
  if (!granted.has('storage')) { loaded = true; return; }
  const res = await request('storage.get', { key: KEY_STATE }).catch(() => ({ value: '' }));
  state = parseState(res && res.value);
  loaded = true;
}

function whenLoaded() {
  if (loaded) return Promise.resolve();
  if (!loadPromise) loadPromise = loadState();
  return loadPromise;
}

async function saveState() {
  if (!granted.has('storage')) return;
  void request('storage.set', { key: KEY_STATE, value: JSON.stringify(state) }).catch(() => {});
}

// --- 抓取 --------------------------------------------------------------------

/** 拉一轮行情。返回 quotes 数组或 null（网络失败）。 */
async function fetchQuotes() {
  const symbols = symbolList();
  if (symbols.length === 0) return [];
  // 权限自查：没授权 net.fetch 就不发请求（宿主会拒，但"明知被拒还要打门"是噪音；
  // granted=[] 的三零承诺靠这一行兑现）。
  if (!granted.has('net.fetch') || !hostServes('net.fetch')) return null;
  const url = cfg.apiBase + symbols.join(',');
  try {
    const res = await request('net.fetch', { url, method: 'GET' });
    const text = res && typeof res.text === 'string' ? res.text : '';
    const out = window.QuoteCore.parseResponse(cfg.apiBase, text);
    return out.ok ? out.quotes : null;
  } catch {
    return null;
  }
}

/** 一轮抓取：到期才抓；抓完比哈希；变了才写才画。返回本轮"有新数据"与否。 */
async function runOnce() {
  if (busy) return { fresh: false, skipped: 'busy' };
  try { await whenLoaded(); } catch { return { fresh: false, skipped: 'load' }; }
  if (busy) return { fresh: false, skipped: 'busy' };
  busy = true;
  try {
    const now = nowMs();
    if (state.nextAt > now) return { fresh: false, skipped: 'not-due' };
    const quotes = await fetchQuotes();
    if (quotes === null) {
      state.failCount += 1;
      const backoffMin = Math.min(60, 15 * Math.pow(2, Math.min(5, state.failCount)));
      state.nextAt = now + backoffMin * 60000;
      await saveState();
      paint();
      return { fresh: false, skipped: 'fetch-failed' };
    }
    state.failCount = 0;
    state.nextAt = now + Math.max(15, Number(cfg.pollMinOverride) || 15) * 60000;
    // 历史与快照。**键用用户填的符号（sh000001），不用源返回的代码（000001）**：
    // 换行情源时返回的代码形状会变（腾讯 000001 / 新浪 sh000001），用户填的符号才是
    // 本插件的稳定标识——键跟着源走，换一次源历史就断一次。
    const symbols = symbolList();
    for (const q of quotes) {
      // 源按请求顺序返回；代码匹配不上时按位置兜底（多代码一次拉取的正常情形）。
      const byCode = symbols.find((s) => s.toLowerCase().endsWith(String(q.code).toLowerCase()) || s === q.code);
      const key = byCode || q.code;
      const hist = state.history[key] || [];
      hist.push(q.price);
      state.history[key] = hist.slice(-HISTORY_MAX);
      state.quotes[key] = q;
    }
    const hash = window.QuoteCore.snapshotHash(quotes);
    const fresh = hash !== state.lastHash;
    state.lastHash = hash;
    if (fresh) {
      await saveState();
      paint();
      updateBadge();
    }
    return { fresh, skipped: fresh ? null : 'same' };
  } finally {
    busy = false;
  }
}

// --- 徽标 ---------------------------------------------------------------------

let lastBadge = null;
function updateBadge() {
  if (!cfg.showBadge || !granted.has('pet.surface') || !hostServes('pet.badge')) return;
  const first = symbolList()[0];
  const q = first && state.quotes[first];
  const text = q ? `${q.name || q.code} ${q.price}` : '';
  if (text === lastBadge) return;
  lastBadge = text;
  void request('pet.badge', { text: text.slice(0, 16) }).catch(() => {});
}

// --- 视图 ---------------------------------------------------------------------

const els = {};
function grabEls() {
  for (const id of ['root', 'status', 'card', 'rows', 'empty', 'manage']) {
    els[id] = document.getElementById(id);
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

/** 涨跌类名：中国习惯红涨绿跌，可配反转。 */
function dirClass(changePct) {
  if (changePct === null || changePct === undefined || changePct === 0) return 'flat';
  const up = changePct > 0;
  return up === cfg.upColorIsRed ? 'up' : 'down';
}

function quoteRow(code) {
  const q = state.quotes[code];
  const row = document.createElement('div');
  row.className = 'qrow';
  if (!q) {
    row.classList.add('nodata');
    row.textContent = `${code}：无数据`;
    return row;
  }
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = q.name || code;
  const price = document.createElement('span');
  price.className = 'price ' + dirClass(q.changePct);
  price.textContent = String(q.price);
  const pct = document.createElement('span');
  pct.className = 'pct ' + dirClass(q.changePct);
  pct.textContent = q.changePct === null || q.changePct === undefined
    ? ''
    : `${q.changePct > 0 ? '+' : ''}${q.changePct}%`;
  const hist = state.history[code] || [];
  const d = window.QuoteCore.sparkline(hist.slice(-20), 60, 18);
  const spark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  spark.setAttribute('class', 'spark');
  spark.setAttribute('width', '60');
  spark.setAttribute('height', '18');
  if (d) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    spark.appendChild(path);
  }
  row.appendChild(name);
  row.appendChild(spark);
  row.appendChild(price);
  row.appendChild(pct);
  return row;
}

function paint() {
  if (!els.card || self.slot === 'background') return;
  const codes = symbolList();
  const key = JSON.stringify([codes, state.lastHash, cfg.upColorIsRed, ready ? 1 : 0]);
  if (key === viewKey) return;
  viewKey = key;
  if (els.rows) {
    els.rows.textContent = '';
    for (const code of codes) els.rows.appendChild(quoteRow(code));
  }
  if (els.empty) els.empty.hidden = codes.length > 0;
  reportHeight();
}

// 卡片高度跟内容走（§6.5）：代码多时按 scrollHeight 请求高度，manifest 已声明 maxH=300。
let heightTimer = null;
function reportHeight() {
  if (self.kind !== 'surface' || !granted.has('pet.surface') || !els.card) return;
  clearTimeout(heightTimer);
  heightTimer = setTimeout(() => {
    request('surface.blocks', { sizes: { '0': Math.min(300, Math.ceil(document.body.scrollHeight) + 2) } }).catch(() => {});
  }, 120);
}

// --- 启动 ---------------------------------------------------------------------

async function onInit(data) {
  granted.clear();
  for (const name of data.granted || []) granted.add(name);
  const surf = data.surface || {};
  self = {
    kind: surf.kind || 'panel',
    slot: surf.slot || '',
    hostMethods: data.host && Array.isArray(data.host.methods) ? data.host.methods : null,
  };
  applyTheme(data.theme);
  ready = true;
  viewKey = '';
  lastBadge = null;

  if (els.root) {
    els.root.classList.remove('view-boot');
    if (self.kind === 'surface') els.root.classList.add('view-surface');
    else if (self.slot === 'background') els.root.classList.add('bg');
  }
  if (els.status) {
    els.status.textContent = !granted.has('net.fetch')
      ? '未获授权 net.fetch'
      : self.slot === 'workshop' ? '在设置里改代码清单' : '已就绪';
  }

  await refreshConfig().catch(() => {});
  loadPromise = loadState();
  await loadPromise.catch(() => {});
  paint();
  updateBadge();
}

function onResponse(data) {
  const waiter = pending.get(data.id);
  if (!waiter) return;
  pending.delete(data.id);
  if (data.ok) waiter.resolve(data.result);
  else waiter.reject(new Error(data.error || '宿主拒绝了这次调用'));
}

function onMessage(event) {
  if (event.source !== HOST) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.v !== PROTOCOL) return;
  switch (data.type) {
    case 'init': void onInit(data); break;
    case 'response': onResponse(data); break;
    case 'theme': applyTheme(data.theme); break;
    default: break;
  }
}

window.addEventListener('message', onMessage);

grabEls();

// 兜底 tick：60 秒一跳；每轮只按 nextAt 到期才发请求（≥15 分钟）。
// 休眠墙钟失准是已知限制（路线图 M4）。
setInterval(() => {
  if (!ready || self.slot === 'workshop') return;
  void runOnce();
}, 60000);

// **监听器装好之后**才握手：init 可能在 post 完的下一个任务就到达。
HOST.postMessage({ v: PROTOCOL, type: 'ready' }, '*');

/**
 * 测试接缝：抓取与"休市不刷"的判定发生在看不见的那一面。
 */
window.__financeBoard = Object.freeze({
  runOnce,
  fetchQuotes,
  setClock: (fn) => { clock.nowMs = fn || clock.nowMs; },
  snapshot: () => ({
    slot: self.slot,
    kind: self.kind,
    ready,
    granted: [...granted],
    cfg: { ...cfg },
    symbols: symbolList(),
    state: {
      lastHash: state.lastHash,
      quotes: { ...state.quotes },
      history: Object.fromEntries(Object.entries(state.history).map(([k, v]) => [k, [...v]])),
      failCount: state.failCount,
      nextAt: state.nextAt,
    },
  }),
  core: window.QuoteCore,
});
