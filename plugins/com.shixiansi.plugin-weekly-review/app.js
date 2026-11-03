// 周报汇总：常驻帧到点生成、答 plugin.call 的 report/latest；插件页看历史、立即生成。
//
// 一个文档，两种挂载（见 panel.html 顶部注释）。纯逻辑全在 window.WeeklyCore。
//
// 数据源发现（铁律）：**用 plugins.services 按能力名找提供方，不写死插件 id**——
// 源码里不许出现任何具体插件的 id 作为调用目标（测试钉住）。哪个插件提供
// stats 是安装状态决定的，写死只会在新插件出现时失效。
//
// 容忍语义（任务书核心）：每个数据源独立成败；失联=报告里一句「缺什么」；全失联=数字
// 模板照出。llm.chat 失败=退化为模板。周报 ≤300 字，超长截断并标注。
//
// 生成时机：常驻帧 15 分钟兜底 tick 判断「本地时间已过 config 的 reviewDay+reviewHour
// 且本周还没生成」（墙钟失准是已知限制，路线图 M4 会修；测试用注入时钟）。不写 1 秒轮询。
//
// 存档：storage 留最近 12 篇（环形，新的挤最旧的）。

'use strict';

// --- 宿主桥 ------------------------------------------------------------------

const PROTOCOL = 1;
const PLUGIN_ID = 'com.shixiansi.plugin-weekly-review';
const HOST = window.parent;
let nextId = 1;
const pending = new Map();
const granted = new Set();

function request(method, payload) {
  const id = `w${nextId++}`;
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

const clock = { nowMs: () => Date.now(), offsetMin: () => -new Date().getTimezoneOffset() };
function nowMs() { return clock.nowMs(); }
function localOffsetMin() { return clock.offsetMin(); }

// --- 状态 --------------------------------------------------------------------

let self = { slot: '', kind: '', hostMethods: null };
let ready = false;
let cfg = { reviewDay: 7, reviewHour: 20 };
let reports = [];        // [{label, text, at, missing:[...] }] 环形 12
let loaded = false;
let loadPromise = null;
let busy = false;
let subscribed = false;

const KEY_REPORTS = 'reports/all';

const ARCHIVE_MAX = 12;

function hostServes(method) {
  if (self.hostMethods) return self.hostMethods.indexOf(method) >= 0;
  if (self.slot === 'workshop') return false;
  return true;
}

// --- 配置与存取 ----------------------------------------------------------------

async function refreshConfig() {
  if (!granted.has('plugin.config')) return;
  const res = await request('config.get', {}).catch(() => null);
  if (!res || !res.values) return;
  const d = Number(res.values.reviewDay);
  cfg.reviewDay = Number.isFinite(d) ? Math.max(1, Math.min(7, Math.floor(d))) : 7;
  const h = Number(res.values.reviewHour);
  cfg.reviewHour = Number.isFinite(h) ? Math.max(0, Math.min(23, Math.floor(h))) : 20;
}

function parseReports(text) {
  if (!text) return [];
  try {
    const v = JSON.parse(String(text));
    if (!Array.isArray(v)) return [];
    return v
      .filter((r) => r && typeof r === 'object' && typeof r.label === 'string' && typeof r.text === 'string')
      .slice(-ARCHIVE_MAX)
      .map((r) => ({ label: r.label, text: r.text, at: Number(r.at) || 0, missing: Array.isArray(r.missing) ? r.missing.map(String) : [] }));
  } catch { return []; }
}

async function loadReports() {
  if (!granted.has('storage')) { loaded = true; return; }
  const res = await request('storage.get', { key: KEY_REPORTS }).catch(() => ({ value: '' }));
  reports = parseReports(res && res.value);
  loaded = true;
}

function whenLoaded() {
  if (loaded) return Promise.resolve();
  if (!loadPromise) loadPromise = loadReports();
  return loadPromise;
}

async function saveReports() {
  if (!granted.has('storage')) return;
  const json = JSON.stringify(reports);
  if (json.length > 1024 * 1024) return; // 12 篇 × 300 字到不了，纯防线
  void request('storage.set', { key: KEY_REPORTS, value: json }).catch(() => {});
}

// --- 数据源发现与调用（plugins.services，不写死 id） ------------------------------

/**
 * 问宿主「谁提供 stats」，对每个提供方发一次调用。单个失败不拖累别的：
 * 返回 sources=[{name, ok, data, error}]——name 用对方的 pluginId 截短的尾巴。
 */
async function gatherSources() {
  const sources = [];
  let providers = [];
  try {
    const res = await request('plugins.services', {});
    // 宿主形状：[{pluginId, method, version}]（能力名的提供方列表）。按 pluginId 去重。
    providers = (Array.isArray(res) ? res : (res && res.services) || [])
      .map((s) => (typeof s === 'string' ? { pluginId: s, method: 'stats' } : s))
      .filter((s) => s && s.pluginId && (!s.method || s.method === 'stats'));
  } catch {
    return [{ name: '能力发现', ok: false, error: 'plugins.services 不可用' }];
  }
  for (const p of providers) {
    const shortName = String(p.pluginId).replace(/^com\.shixiansi\.plugin-/, '');
    try {
      const data = await request('plugin.call', { target: `${p.pluginId}/stats`, payload: {} });
      sources.push({ name: shortName, ok: true, data: (data && typeof data === 'object') ? data : {}, error: '' });
    } catch (err) {
      sources.push({ name: shortName, ok: false, error: String((err && err.message) || err) });
    }
  }
  return sources;
}

// --- 生成 ---------------------------------------------------------------------

/** 归一各家 stats 的形状：todo/pomodoro/diary 三类，别的源透传字段。 */
function normalize(source) {
  const d = source.data || {};
  // 待办类：{done,total} 或 {stats:{done,total}}
  if (Number.isFinite(d.done) || Number.isFinite(d.stats && d.stats.done)) {
    const s = d.stats || d;
    return { kind: 'todo', done: Number(s.done), total: Number(s.total) };
  }
  // 番茄类：{minutes,count} 或 {stats:{minutes,count}}
  if (Number.isFinite(d.minutes) || Number.isFinite(d.stats && d.stats.minutes)) {
    const s = d.stats || d;
    return { kind: 'pomodoro', minutes: Number(s.minutes), count: Number(s.count) };
  }
  // 日记类：{entries,count,length}
  if (Number.isFinite(d.entries) || Number.isFinite(d.count) || Number.isFinite(d.stats && d.stats.entries)) {
    const s = d.stats || d;
    return { kind: 'diary', entries: Number(s.entries ?? s.count) };
  }
  return { kind: 'unknown', raw: d };
}

/** 生成一篇。返回 {ok, report} 或 {ok:false, reason}。 */
async function generate() {
  if (!granted.has('plugin.call') || !hostServes('plugin.call')) {
    return { ok: false, reason: '未获授权 plugin.call：问不到任何数据源' };
  }
  const win = window.WeeklyCore.weekWindow(nowMs(), localOffsetMin());
  const sources = await gatherSources();
  const normalized = sources.map((s) => (s.ok ? { ...s, data: normalize(s) } : s));
  const { available, missing } = window.WeeklyCore.collect(normalized.map((s) => ({
    name: s.name,
    ok: s.ok,
    data: s.ok && s.data.kind !== 'unknown' ? s.data : null,
    error: s.error,
  })));
  // llm 优先；不可用/失败退化为模板。
  let text = null;
  let degraded = false;
  if (granted.has('llm.chat') && hostServes('llm.chat')) {
    try {
      const res = await request('llm.chat', {
        messages: [
          { role: 'system', content: '你是周报助手。只依据给出的统计写周报，不编造数字。' },
          { role: 'user', content: window.WeeklyCore.buildPrompt(win, available, missing) },
        ],
      });
      if (res && typeof res.text === 'string' && res.text.trim()) text = res.text.trim();
    } catch { degraded = true; }
  } else degraded = true;
  if (!text) {
    text = window.WeeklyCore.templateText(win, available, missing);
    degraded = true;
  }
  if (text.length > window.WeeklyCore.LIMIT) {
    text = text.slice(0, window.WeeklyCore.LIMIT - 7) + '…（超长截断）';
  }
  const report = { label: win.label, text, at: nowMs(), missing, degraded };
  return { ok: true, report };
}

async function generateAndArchive() {
  const out = await generate();
  if (!out.ok) return out;
  // 同一周重复生成：替换那一篇（不是追加——历史里同一周只留最新）。
  reports = reports.filter((r) => r.label !== out.report.label);
  reports.push(out.report);
  if (reports.length > ARCHIVE_MAX) reports = reports.slice(-ARCHIVE_MAX);
  await saveReports();
  return out;
}

/** 到点判断：本地时间过了 reviewDay+reviewHour，且本周还没有存档。 */
function dueForWeekly(nowMsValue) {
  const win = window.WeeklyCore.weekWindow(nowMsValue, localOffsetMin());
  if (reports.some((r) => r.label === win.label)) return false;
  const off = localOffsetMin();
  const local = new Date(nowMsValue + off * 60000);
  const day = (local.getUTCDay() + 6) % 7 + 1; // 1=周一…7=周日
  if (day !== cfg.reviewDay) return false;
  return local.getUTCHours() >= cfg.reviewHour;
}

// --- serves：report / latest ---------------------------------------------------

const CALL_HANDLERS = {
  // report → 立即生成一篇（不落盘：落盘是"我自己生成"的语义，问方要的是当次的答案）。
  report: async () => {
    const out = await generate();
    return out.ok ? out.report : { ok: false, reason: out.reason };
  },
  // latest → 最近一篇（没有就明确空态）。
  latest: async () => {
    await whenLoaded();
    if (reports.length === 0) return { ok: true, empty: true, report: null };
    const r = reports[reports.length - 1];
    return { ok: true, empty: false, report: r };
  },
};

/** 必须与 manifest 的 serves 逐字相同（测试里钉住）。 */
async function onCall(data) {
  const ticket = typeof data.ticket === 'string' ? data.ticket : '';
  if (!ticket) return;
  const method = typeof data.method === 'string' ? data.method : '';
  const handler = CALL_HANDLERS[method];
  if (!handler) {
    postCallResult(ticket, false, new Error(`周报汇总不认识方法 ${method || '(空)'}：它只回答 ${Object.keys(CALL_HANDLERS).join(' / ')}`));
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
  for (const id of ['root', 'workshop', 'chip-week', 'gen-btn', 'current', 'gen-note', 'list', 'list-empty', 'clear-btn', 'status']) {
    els[id] = document.getElementById(id);
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

function renderList() {
  const box = els.list;
  if (!box) return;
  box.textContent = '';
  if (els.listEmpty) els.listEmpty.hidden = reports.length > 0;
  for (const r of [...reports].reverse()) {
    const div = document.createElement('div');
    div.className = 'week-item';
    const head = document.createElement('div');
    head.className = 'head';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = r.label;
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = r.at ? new Date(r.at).toISOString().slice(0, 16).replace('T', ' ') : '';
    head.appendChild(label);
    head.appendChild(when);
    const body = document.createElement('p');
    body.className = 'body';
    body.textContent = r.text + (r.missing && r.missing.length ? `\n（缺：${r.missing.join('、')}）` : '');
    div.appendChild(head);
    div.appendChild(body);
    box.appendChild(div);
  }
}

function showCurrent(report) {
  if (!els.current) return;
  if (!report) { els.current.textContent = '本周还没生成。'; return; }
  els.current.textContent = report.text + (report.degraded ? '\n（模型不在，这是数字模板）' : '');
  if (els.chipWeek) els.chipWeek.textContent = report.label;
}

async function runGenerate() {
  if (els.genNote) els.genNote.textContent = '生成中…（问数据源、再让模型写）';
  if (els.genBtn) els.genBtn.disabled = true;
  try {
    const out = await generateAndArchive();
    if (out.ok) {
      showCurrent(out.report);
      renderList();
      if (els.genNote) {
        els.genNote.textContent = out.report.degraded
          ? `已生成（模板${out.report.missing.length ? '；缺 ' + out.report.missing.join('、') : ''}）`
          : '已生成';
      }
      await say('本周周报好了');
    } else if (els.genNote) els.genNote.textContent = out.reason || '没生成出来';
  } finally {
    if (els.genBtn) els.genBtn.disabled = false;
  }
}

async function say(text) {
  if (!granted.has('pet.bubble') || !hostServes('bubble.say')) return;
  void request('bubble.say', { text: text.slice(0, 60) }).catch(() => {});
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
    els.status.textContent = !granted.has('plugin.call')
      ? '未获授权 plugin.call：生成不出周报'
      : self.slot === 'background' ? '常驻帧就绪' : '就绪';
  }

  await refreshConfig().catch(() => {});
  loadPromise = loadReports();
  await loadPromise.catch(() => {});
  if (self.slot !== 'background') {
    showCurrent(reports.length ? reports[reports.length - 1] : null);
    renderList();
  }
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
    case 'call': void onCall(data); break;
    default: break;
  }
}

window.addEventListener('message', onMessage);

grabEls();

if (els.genBtn) els.genBtn.addEventListener('click', () => void runGenerate());
if (els.clearBtn) {
  els.clearBtn.addEventListener('click', () => {
    reports = [];
    void saveReports().then(() => { renderList(); showCurrent(null); });
  });
}

// 兜底 tick：15 分钟一跳，只做"到点了吗"的判断（dueForWeekly 里查档与钟点）。
// 不写 1 秒轮询；墙钟失准是已知限制（路线图 M4 的宿主定时会修）。
setInterval(() => {
  if (!ready || self.slot === 'workshop') return;
  if (dueForWeekly(nowMs())) void generateAndArchive().then(() => say('本周周报好了')).catch(() => {});
}, 15 * 60000);

// **监听器装好之后**才握手：init 可能在 post 完的下一个任务就到达。
HOST.postMessage({ v: PROTOCOL, type: 'ready' }, '*');

/**
 * 测试接缝：数据源发现、llm 调用、到点判断都发生在看不见的那一面。
 */
window.__weeklyReview = Object.freeze({
  handlers: CALL_HANDLERS,
  generate,
  generateAndArchive,
  gatherSources,
  normalize,
  dueForWeekly,
  setClock: (nowFn, offsetFn) => { clock.nowMs = nowFn || clock.nowMs; clock.offsetMin = offsetFn || clock.offsetMin; },
  snapshot: () => ({
    slot: self.slot,
    kind: self.kind,
    ready,
    loaded,
    granted: [...granted],
    cfg: { ...cfg },
    reports: reports.map((r) => ({ ...r, missing: [...r.missing] })),
  }),
  core: window.WeeklyCore,
});
