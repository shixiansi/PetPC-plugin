// 网页变化监控：常驻帧按 tick 抓页面、判定变化、发气泡；插件页增删监控项、看历史。
//
// 一个文档，两种挂载（见 panel.html 顶部注释）。纯逻辑全在 window.PriceCore。
//
// 抓取节律（反爬自觉，注释即承诺）：
//   · tick 每 60 秒一跳（重绘例外），但**每一项**只按自己的 nextAt 到期才发请求——
//     默认间隔 15 分钟、可配、最小 15 分钟；
//   · 失败退避：连续失败 n 次 → 间隔 ×2^n，封顶 60 分钟；成功清零；
//   · 不伪装 UA、不加请求头花样、一次 tick 只抓到期的那几项。
//
// 报警语义：首次抓取（lastValue===null）只立基线；值没变=安静；变了=恰一条气泡；
// 提取/抓取失败≠变化（不气泡），状态在插件页可读。
//
// 域名白名单：监控项的域名来自用户输入——hostWhitelist 的 config 项（extraHosts）让用户
// 把常用域名交给宿主；**每抓一项之前**都把该 URL 的主机名发给宿主（config.set 到
// hostWhitelist 键），新域名下一次 tick 生效——本 tick 若被宿主拒绝，按失败退避处理。

'use strict';

// --- 宿主桥 ------------------------------------------------------------------

const PROTOCOL = 1;
const PLUGIN_ID = 'com.shixiansi.plugin-price-watch';
const HOST = window.parent;
let nextId = 1;
const pending = new Map();
const granted = new Set();

function request(method, payload) {
  const id = `p${nextId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    HOST.postMessage({ v: PROTOCOL, type: 'request', id, method, payload: payload || {} }, '*');
  });
}

function postCallResult(ticket, ok, valueOrErr) {
  const msg = ok
    ? { v: PROTOCOL, type: 'call-result', ticket, ok, result: valueOrErr }
    : { v: PROTOCOL, type: 'call-result', ticket, ok, error: String((valueOrErr && valueOrErr.message) || valueOrErr) };
  HOST.postMessage(msg, '*');
}

// --- 时钟（测试接缝） ----------------------------------------------------------

const clock = { nowMs: () => Date.now() };
function nowMs() { return clock.nowMs(); }

// --- 状态 --------------------------------------------------------------------

let self = { slot: '', kind: '', hostMethods: null };
let ready = false;
let cfg = { pollMin: 15 };
let items = [];
let loaded = false;          // init 的 loadItems 完成后才叫 loaded（runOnce 的启动门）
let loadPromise = null;      // init 进行中时，runOnce/doAdd 等它收口再动手
let busy = false; // 一次只跑一轮抓取（tick 重入保护）

const KEY_ITEMS = 'items/all'; // 唯一存储键

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
  const m = Number(res.values.pollMin);
  cfg.pollMin = Number.isFinite(m) ? Math.max(15, Math.floor(m)) : 15;
}

// --- 存取 --------------------------------------------------------------------

async function loadItems() {
  if (!granted.has('storage')) { loaded = true; return; }
  const res = await request('storage.get', { key: KEY_ITEMS }).catch(() => ({ value: '' }));
  items = window.PriceCore.parseItems(res && res.value);
  loaded = true;
}

/** init 是异步的：外部动作（runOnce/doAdd）等它收口，避免"盘还没读就动手"。 */
function whenLoaded() {
  if (loaded) return Promise.resolve();
  if (!loadPromise) loadPromise = loadItems();
  return loadPromise;
}

async function saveItems() {
  if (!granted.has('storage')) return;
  const json = window.PriceCore.serialize(items);
  if (json.length > window.PriceCore.SIZE_LIMIT) return; // 极端防线：宁可不写也不截断
  void request('storage.set', { key: KEY_ITEMS, value: json }).catch(() => {});
}

// --- 白名单 ------------------------------------------------------------------

/**
 * 把监控项用到的主机名归并进 hostWhitelist config 项。用户填的 URL 不该被白名单卡死——
 * 宿主的 netHosts 静态表是"申请时"的，config 的 hostWhitelist 项是"运行时"的口子。
 */
function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

async function syncWhitelist() {
  if (!granted.has('plugin.config') || !granted.has('net.fetch')) return;
  const hosts = [...new Set(items.map((it) => hostOf(it.url)).filter(Boolean))];
  if (hosts.length === 0) return;
  // 只加不减：删了监控项的域名留在白名单里无害（宿主按域名放行，不泄数据）。
  await request('config.set', { values: { extraHosts: hosts.join(',') } }).catch(() => {});
}

// --- 抓取与判定 ----------------------------------------------------------------

/** 抓一个 URL。返回 html 或 null（网络失败）。 */
async function fetchPage(url) {
  try {
    const res = await request('net.fetch', { url, method: 'GET' });
    const text = res && typeof res.text === 'string' ? res.text : (res && typeof res.body === 'string' ? res.body : '');
    return text || null;
  } catch {
    return null;
  }
}

/** 气泡文案：变化才有。 */
function alertText(item, from, to) {
  const fromShort = String(from).slice(0, 24);
  const toShort = String(to).slice(0, 24);
  return `${item.name}：${fromShort} → ${toShort}`;
}

async function say(text) {
  if (!granted.has('pet.bubble') || !hostServes('bubble.say')) return;
  void request('bubble.say', { text: text.slice(0, 120) }).catch(() => {});
}

/** 一轮抓取：只抓到期项。返回发生变化的项数（测试断言用）。 */
async function runOnce() {
  if (busy) return 0;
  // 启动门在 busy 之外：init 未收口时这里等 loadItems 的应答；锁着 busy 等会让
  // 调用方（tick/测试）与应答方互等，三方死锁。
  try { await whenLoaded(); } catch { return 0; }
  if (busy) return 0;
  busy = true;
  let alerts = 0;
  try {
    const now = nowMs();
    const due = items.filter((it) => it.nextAt <= now);
    for (const item of due) {
      if (!granted.has('net.fetch') || !hostServes('net.fetch')) break; // 宿主拒绝一切：停手
      const html = await fetchPage(item.url);
      let value = null;
      if (html !== null) value = window.PriceCore.extract(item, html);
      const out = window.PriceCore.observe(item, value, nowMs(), cfg.pollMin);
      const idx = items.indexOf(item);
      items[idx] = out.item;
      if (out.action === 'alert') {
        alerts += 1;
        await say(alertText(item, item.lastValue, out.item.lastValue));
      }
      // 判完立即落盘——但 quiet（值没变）除外：没有状态变化就没有可写的差异，
      // 这也是"值没变=零写"的去抖承诺（测试钉住）。
      if (out.action !== 'quiet') await saveItems();
    }
    // 白名单只在有到期项**且状态确实变了**时同步（quiet 轮连写盘都没有——
    // 值没变就是无事发生；saveItems 在 quiet 轮也没被调，语义一致）。
    if (due.length > 0 && alerts > 0) await syncWhitelist();
  } finally {
    busy = false;
  }
  return alerts;
}

// --- 供 UI 与测试共用的动作 -----------------------------------------------------

async function doAdd(form) {
  if (!granted.has('storage')) return { ok: false, reason: '未获授权 storage' };
  await whenLoaded();
  const url = String(form.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, reason: 'URL 要以 http(s):// 开头' };
  if (!form.regex && !form.selector) return { ok: false, reason: '正则与选择器至少填一个' };
  const item = window.PriceCore.newItem(form, nowMs());
  items.push(item);
  await saveItems();
  void syncWhitelist();
  return { ok: true, id: item.id };
}

async function doRemove(id) {
  if (!granted.has('storage')) return { ok: false, reason: '未获授权 storage' };
  items = items.filter((it) => it.id !== id);
  await saveItems();
  return { ok: true, id };
}

// --- 视图 ---------------------------------------------------------------------

const els = {};
function grabEls() {
  for (const id of ['root', 'workshop', 'chip-items', 'add-form', 'add-name', 'add-url', 'add-regex', 'add-selector', 'add-btn', 'add-note', 'items', 'items-empty', 'status']) {
    const key = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    els[key] = document.getElementById(id);
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

function stateText(item) {
  if (item.lastError) return `失败 ×${item.failCount}（下次自动重试）`;
  if (!item.lastValue) return '等待首次抓取';
  return `当前 ${String(item.lastValue).slice(0, 30)}`;
}

function renderItems() {
  const box = els.items;
  if (!box) return;
  box.textContent = '';
  if (els.chipItems) els.chipItems.textContent = `${items.length} 项`;
  for (const item of items) {
    const div = document.createElement('div');
    div.className = 'item';
    div.dataset.id = item.id;

    const row1 = document.createElement('div');
    row1.className = 'row1';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.name;
    const state = document.createElement('span');
    state.className = 'state' + (item.lastError ? ' failing' : item.lastValue ? ' alerting' : '');
    state.textContent = stateText(item);
    row1.appendChild(name);
    row1.appendChild(state);

    const url = document.createElement('p');
    url.className = 'url';
    url.textContent = item.url;
    const rule = document.createElement('p');
    rule.className = 'rule';
    rule.textContent = item.regex ? `/${item.regex}/` : item.selector;

    div.appendChild(row1);
    div.appendChild(url);
    div.appendChild(rule);

    if (item.history.length > 0) {
      const ul = document.createElement('ul');
      ul.className = 'history';
      for (const h of [...item.history].reverse()) {
        const li = document.createElement('li');
        li.textContent = `${new Date(h.at).toISOString().slice(5, 16).replace('T', ' ')} → ${h.value.slice(0, 40)}`;
        ul.appendChild(li);
      }
      div.appendChild(ul);
    }

    const actions = document.createElement('div');
    actions.className = 'actions';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn soft';
    del.textContent = '删';
    del.disabled = !granted.has('storage');
    del.addEventListener('click', () => { void doRemove(item.id).then(() => paint()); });
    actions.appendChild(del);
    div.appendChild(actions);

    box.appendChild(div);
  }
  if (els.itemsEmpty) els.itemsEmpty.hidden = items.length > 0;
}

function paint() {
  if (self.slot === 'background') return; // 常驻帧什么都不画
  renderItems();
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

  if (els.root) {
    els.root.classList.remove('view-workshop');
    if (self.slot === 'background') els.root.classList.add('view-background');
    else els.root.classList.add('view-workshop');
  }
  if (els.status) {
    els.status.textContent = !granted.has('storage')
      ? '未获授权 storage'
      : self.slot === 'background' ? '常驻帧就绪' : '就绪';
  }

  await refreshConfig().catch(() => {});
  loadPromise = loadItems();
  await loadPromise.catch(() => {});
  if (self.slot !== 'background') paint();
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

if (els.addForm) {
  els.addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const form = {
      name: els.addName ? els.addName.value : '',
      url: els.addUrl ? els.addUrl.value : '',
      regex: els.addRegex ? els.addRegex.value : '',
      selector: els.addSelector ? els.addSelector.value : '',
    };
    void doAdd(form)
      .then((out) => {
        if (out.ok) {
          if (els.addName) els.addName.value = '';
          if (els.addUrl) els.addUrl.value = '';
          if (els.addRegex) els.addRegex.value = '';
          if (els.addSelector) els.addSelector.value = '';
          if (els.addNote) els.addNote.textContent = '已添加；下一轮抓取立基线，再往后才会报警';
          paint();
        } else if (els.addNote) els.addNote.textContent = out.reason || '没加上';
      })
      .catch(() => {});
  });
}

// 兜底 tick：60 秒一跳，只查"谁到期了"——每项自己的 nextAt 才决定发不发请求。
// 休眠后墙钟失准是已知限制（路线图 M4 的宿主定时会修）。
setInterval(() => {
  if (!ready || self.slot === 'workshop') return;
  void runOnce();
}, 60000);

// **监听器装好之后**才握手：init 可能在 post 完的下一个任务就到达。
HOST.postMessage({ v: PROTOCOL, type: 'ready' }, '*');

/**
 * 测试接缝：抓取与判定发生在看不见的那一面（常驻帧）。setClock 注入时间，runOnce 可直调。
 */
window.__priceWatch = Object.freeze({
  doAdd,
  doRemove,
  runOnce,
  setClock: (fn) => { clock.nowMs = fn || clock.nowMs; },
  say,
  fetchPage,
  hostOf,
  syncWhitelist,
  snapshot: () => ({
    slot: self.slot,
    kind: self.kind,
    ready,
    loaded,
    granted: [...granted],
    cfg: { ...cfg },
    items: items.map((it) => ({ ...it, history: it.history.slice() })),
  }),
  core: window.PriceCore,
});
