// 换算工具：常驻帧答 plugin.call 的 convert；插件页手动换算、看单位表与历史。
//
// 一个文档，两种挂载（由 init 的 surface.slot 决定，见 panel.html 顶部注释）。
// **零网络**：换算表全内置（lib/convert.js），本插件没有任何"要联网才算得出来"的路径——
// 这也是它敢被模型随便调的原因：不花钱、不泄数据、不怕断网。
//
// storage 只做一件事：插件页的"最近换过"（环形上限 50 条，新的挤旧的）。常驻帧不写盘——
// 问它换算的调用方要的是答案，不是日志；写盘失败也不影响应答。
//
// 轮询纪律（§7）：没有任何 setInterval。precision 配置在下次挂载时生效——为这一点显示
// 精度去申请 events 权限（config.changed）不值得：权限是用户要授权的开关，能省则省。

'use strict';

// --- 宿主桥 ------------------------------------------------------------------

const PROTOCOL = 1;
const PLUGIN_ID = 'com.shixiansi.plugin-convert-kit';
const HOST = window.parent;
let nextId = 1;
const pending = new Map();
const granted = new Set();

function request(method, payload) {
  const id = `c${nextId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    HOST.postMessage({ v: PROTOCOL, type: 'request', id, method, payload: payload || {} }, '*');
  });
}

/** 一次 plugin.call 的回包。ticket 原样带回——带错了宿主不认，调用方只会等到超时。 */
function postCallResult(ticket, ok, valueOrErr) {
  const msg = ok
    ? { v: PROTOCOL, type: 'call-result', ticket, ok, result: valueOrErr }
    : { v: PROTOCOL, type: 'call-result', ticket, ok, error: String((valueOrErr && valueOrErr.message) || valueOrErr) };
  HOST.postMessage(msg, '*');
}

// --- 状态 --------------------------------------------------------------------

let self = { slot: '', kind: '', hostMethods: null };
let ready = false;
let cfg = { precision: 10 };

const KEY_HISTORY = 'history/recent'; // [{text, result, ok, at}] 环形 50 条

const HISTORY_MAX = 50;

// 这一面有没有"宿主服务这个方法"的权威答案（§5.2.1）：有 host 表就查表，没有退回 slot 猜。
function hostServes(method) {
  if (self.hostMethods) return self.hostMethods.indexOf(method) >= 0;
  if (self.slot === 'workshop') return false; // 控制中心没有 pet 专属方法（§9 的表）
  return true;
}

// --- 配置 --------------------------------------------------------------------

async function refreshConfig() {
  if (!granted.has('plugin.config')) return;
  const res = await request('config.get', {}).catch(() => null);
  if (!res || !res.values) return;
  const p = Number(res.values.precision);
  cfg.precision = Number.isFinite(p) ? Math.max(2, Math.min(12, Math.floor(p))) : 10;
  window.ConvertCore_setPrecision(cfg.precision);
}

// --- 历史（插件页用） -----------------------------------------------------------

async function loadHistory() {
  if (!granted.has('storage')) return [];
  const res = await request('storage.get', { key: KEY_HISTORY }).catch(() => ({ value: '' }));
  const parsed = parseHistory(res && res.value);
  return parsed;
}

function parseHistory(text) {
  if (!text) return [];
  try {
    const v = JSON.parse(String(text));
    if (!Array.isArray(v)) return [];
    return v
      .filter((e) => e && typeof e === 'object' && typeof e.text === 'string' && typeof e.result === 'string')
      .slice(-HISTORY_MAX)
      .map((e) => ({ text: e.text, result: e.result, ok: e.ok !== false, at: Number(e.at) || 0 }));
  } catch {
    return [];
  }
}

async function rememberCall(text, out) {
  if (!granted.has('storage')) return;
  try {
    const list = await loadHistory();
    const entry = {
      text: String(text).slice(0, 120),
      // 结果给人看：ok 用 formatted，失败用 reason（都截断，防一条超长理由占满 1 MiB）
      result: String(out.ok ? out.formatted : out.reason).slice(0, 160),
      ok: Boolean(out.ok),
      at: Date.now(),
    };
    // 同一输入去重：重复换算同一句话，把它提到最前而不是堆两条。
    const dedup = list.filter((e) => e.text !== entry.text);
    const next = [...dedup, entry].slice(-HISTORY_MAX);
    await request('storage.set', { key: KEY_HISTORY, value: JSON.stringify(next) });
  } catch { /* 历史是锦上添花：写不进去就算了 */ }
}

async function clearHistory() {
  if (!granted.has('storage')) return;
  await request('storage.set', { key: KEY_HISTORY, value: '[]' }).catch(() => {});
}

// --- serves：convert ------------------------------------------------------------

/**
 * convert → {ok, value, from, to, formatted} 或 {ok:false, reason}。
 * 失败也走 ok:true 的信封（result.ok=false）：对调用方这是"一次成功的换算尝试，结论是
 * 换不了"——reason 要点名单位；真正的错误（内部异常）才走 error 信封。
 */
function answerConvert(payload) {
  const out = window.ConvertCore.convert(payload === undefined ? {} : payload);
  if (granted.has('storage') && self.slot !== 'background') {
    // 常驻帧不写历史（见文件头）；插件页的手动换算走这里。
    void rememberCall(payloadText(payload), out);
  }
  return out;
}

function payloadText(p) {
  if (p && typeof p.text === 'string') return p.text;
  if (p && p.from !== undefined) return `${p.value} ${p.from} → ${p.to}`;
  return '(无输入)';
}

const CALL_HANDLERS = {
  convert: (payload) => answerConvert(payload),
};

/** 必须与 manifest 的 serves 逐字相同（测试里钉住）：少一边，调用方等到 30 秒超时。 */
async function onCall(data) {
  const ticket = typeof data.ticket === 'string' ? data.ticket : '';
  if (!ticket) return;
  const method = typeof data.method === 'string' ? data.method : '';
  const handler = CALL_HANDLERS[method];
  if (!handler) {
    postCallResult(ticket, false, new Error(`换算工具不认识方法 ${method || '(空)'}：它只回答 ${Object.keys(CALL_HANDLERS).join(' / ')}`));
    return;
  }
  try {
    postCallResult(ticket, true, await handler(data.payload));
  } catch (err) {
    postCallResult(ticket, false, err);
  }
}

// --- 视图 ---------------------------------------------------------------------

const els = {};
function grabEls() {
  for (const id of ['root', 'workshop', 'chipSlot', 'chipState', 'convForm', 'convValue', 'convFrom', 'convTo', 'convGo', 'convResult', 'unitsBody', 'historyBody', 'historyEmpty', 'historyClear', 'status']) {
    els[id] = document.getElementById(id);
  }
  // panel.html 里的 id 是 kebab-case，映射成 camelCase 再抓一遍
  for (const id of ['conv-form', 'conv-value', 'conv-from', 'conv-to', 'conv-go', 'conv-result', 'units-body', 'history-body', 'history-empty', 'history-clear', 'chip-state']) {
    const key = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (!els[key]) els[key] = document.getElementById(id);
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

function chipText() {
  if (!ready) return '读取中…';
  if (!granted.has('plugin.call')) return '未获授权 plugin.call';
  return self.slot === 'background' ? '常驻帧' : '就绪';
}

function renderUnits() {
  const tbody = els.unitsBody;
  if (!tbody) return;
  const cats = window.ConvertCore.CATS;
  tbody.textContent = '';
  for (const cat of Object.keys(cats)) {
    const units = cats[cat].units;
    const row = document.createElement('tr');
    const name = document.createElement('td');
    name.className = 'cat';
    name.textContent = { length: '长度', weight: '重量', temperature: '温度', data: '数据量', time: '时间' }[cat] || cat;
    const list = document.createElement('td');
    list.textContent = Object.keys(units).join('、');
    row.appendChild(name);
    row.appendChild(list);
    tbody.appendChild(row);
  }
  const extra = document.createElement('tr');
  const catName = document.createElement('td');
  catName.className = 'cat';
  catName.textContent = '进制';
  const catList = document.createElement('td');
  catList.textContent = 'bin、oct、dec、hex（或 2/8/10/16）';
  extra.appendChild(catName);
  extra.appendChild(catList);
  tbody.appendChild(extra);
  const zone = document.createElement('tr');
  const zoneName = document.createElement('td');
  zoneName.className = 'cat';
  zoneName.textContent = '时区';
  const zoneList = document.createElement('td');
  zoneList.textContent = 'UTC+8、UTC-05:30（写法必须是这个形状）';
  zone.appendChild(zoneName);
  zone.appendChild(zoneList);
  tbody.appendChild(zone);
}

async function renderHistory() {
  const tbody = els.historyBody;
  if (!tbody) return;
  const list = await loadHistory();
  tbody.textContent = '';
  if (els.historyEmpty) els.historyEmpty.hidden = list.length > 0;
  for (const entry of [...list].reverse()) {
    const tr = document.createElement('tr');
    const time = document.createElement('td');
    time.textContent = entry.at ? new Date(entry.at).toISOString().slice(5, 16).replace('T', ' ') : '';
    const expr = document.createElement('td');
    expr.className = 'expr';
    expr.textContent = entry.text;
    const result = document.createElement('td');
    result.className = 'expr';
    result.textContent = (entry.ok ? '' : '✗ ') + entry.result;
    tr.appendChild(time);
    tr.appendChild(expr);
    tr.appendChild(result);
    tbody.appendChild(tr);
  }
}

function showResult(out) {
  const el = els.convResult;
  if (!el) return;
  el.classList.toggle('bad', !out.ok);
  el.textContent = out.ok ? out.formatted : `✗ ${out.reason}`;
}

async function runConvert() {
  const value = els.convValue ? els.convValue.value : '';
  const from = els.convFrom ? els.convFrom.value : '';
  const to = els.convTo ? els.convTo.value : '';
  // 面板的三个框正好对应 {value, from, to}；一句话形状（"1km to mi"）让 value 框收全部。
  let payload;
  if (/\s/.test(value.trim()) && !from.trim() && !to.trim()) {
    payload = { text: value };
  } else {
    payload = { value, from, to };
  }
  const out = window.ConvertCore.convert(payload);
  showResult(out);
  if (out.ok || (out && out.reason)) {
    await rememberCall(payloadText(payload), out);
    void renderHistory();
  }
  return out;
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
  if (els.chipState) els.chipState.textContent = chipText();
  if (els.status) {
    els.status.textContent = !granted.has('plugin.call')
      ? '未获授权 plugin.call：别的插件与模型问不到它'
      : '就绪';
  }

  await refreshConfig().catch(() => {});

  // 常驻帧：什么都不画，等被问。插件页：画单位表与历史。
  if (self.slot !== 'background') {
    renderUnits();
    void renderHistory();
  }
}

function onResponse(data) {
  const waiter = pending.get(data.id);
  if (!waiter) return; // 迟到的 response：安全丢弃
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
    case 'call': void onCall(data); break;
    default: break; // surface / 未知类型：忽略是协议要求的宽容
  }
}

window.addEventListener('message', onMessage);

// 元素抓取必须在绑监听器之前：常驻帧里这些控件大多不存在，grabEls 按可选访问设计。
grabEls();

// 插件页的表单与示例按钮（常驻帧没有这些控件）
if (els.convForm) {
  els.convForm.addEventListener('submit', (e) => {
    e.preventDefault();
    void runConvert();
  });
}
for (const btn of document.querySelectorAll('.linkish')) {
  btn.addEventListener('click', () => {
    const q = btn.getAttribute('data-q') || '';
    if (els.convValue) els.convValue.value = q;
    if (els.convFrom) els.convFrom.value = '';
    if (els.convTo) els.convTo.value = '';
    void runConvert();
  });
}
if (els.historyClear) {
  els.historyClear.addEventListener('click', () => {
    void clearHistory().then(() => renderHistory());
  });
}

// **监听器装好之后**才握手：init 可能在 post 完的下一个任务就到达。
HOST.postMessage({ v: PROTOCOL, type: 'ready' }, '*');

/**
 * 测试接缝：常驻帧被 plugin.call 问（行为发生在看不见的那一面），纯逻辑在 window.ConvertCore。
 */
window.__convertKit = Object.freeze({
  handlers: CALL_HANDLERS,
  runConvert,
  answerConvert,
  clearHistory,
  renderUnits,
  renderHistory,
  snapshot: () => ({
    slot: self.slot,
    kind: self.kind,
    ready,
    granted: [...granted],
    cfg: { ...cfg },
  }),
  core: window.ConvertCore,
});
