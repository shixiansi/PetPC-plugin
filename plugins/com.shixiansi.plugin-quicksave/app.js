// 速记盒子：常驻帧答 plugin.call 的 add/recent；插件页记、搜、置顶、删、让模型整理。
//
// 一个文档，两种挂载（由 init 的 surface.slot 决定，见 panel.html 顶部注释）。
// 纯逻辑全在 window.QuickCore（lib/quicksave-core.js）——淘汰顺序、合并、标签都在那里
// 被测试钉死；本文件只做"接宿主"的部分。
//
// 写者唯一（§6.3）：entries 这一个键只由这个文档写（两种挂载是同一个文档的不同面，都走
// saveEntries）。常驻帧被 serve(add) 远程记一条、插件页手记一条，行为完全一致。
//
// 轮询纪律（§7）：没有任何 setInterval；无 events 订阅（不值得为它多申请一项权限——
// 两种挂载各自在 init 时读一次盘，改动即时写盘，跨面可见性靠 storage 是唯一写者）。
//
// "让模型整理"：llm.chat 是 where:'pet' 的方法，插件页（workshop）拿不到 → 按
// init.host.methods 降级：按钮置灰 + 说明（手册 §9 的两宿主差异表）。

'use strict';

// --- 宿主桥 ------------------------------------------------------------------

const PROTOCOL = 1;
const PLUGIN_ID = 'com.shixiansi.plugin-quicksave';
const HOST = window.parent;
let nextId = 1;
const pending = new Map();
const granted = new Set();

function request(method, payload) {
  const id = `q${nextId++}`;
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
let cfg = { cap: 500 };
let entries = [];            // 内存态：QuickCore.parseState 的产物
let loaded = false;          // init 后读过盘才叫 loaded：serve 不该在空盘时写空数组
const picked = new Set();    // 插件页里勾选的条目 id

const KEY_ENTRIES = 'entries/all'; // 唯一的存储键

// 这一面有没有"宿主服务这个方法"的权威答案（§5.2.1）。
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
  const c = Number(res.values.cap);
  cfg.cap = Number.isFinite(c) ? Math.max(50, Math.min(500, Math.floor(c))) : 500;
}

// --- 存取 --------------------------------------------------------------------

async function loadEntries() {
  if (!granted.has('storage')) { loaded = true; return; }
  const res = await request('storage.get', { key: KEY_ENTRIES }).catch(() => ({ value: '' }));
  entries = window.QuickCore.parseState(res && res.value);
  loaded = true;
}

async function saveEntries() {
  paint();
  if (!granted.has('storage')) return;
  const json = window.QuickCore.serialize(entries);
  // 1 MiB 防线：状态体超限时拒绝写入并说出口（淘汰由 cap 管，这条只防"配置被改小后
  // 旧状态塞不回去"的极端情形——比静默截断诚实）。
  if (json.length > window.QuickCore.SIZE_LIMIT) {
    note('状态超过 1 MiB 写不进去：删几条或把上限调小');
    return;
  }
  void request('storage.set', { key: KEY_ENTRIES, value: json }).catch(() => {});
}

// --- 供 UI 与 serve 共用的动作（写者唯一） --------------------------------------

async function doAdd(text) {
  // 没有 storage 权限就拒绝：内存态记进去、盘上永远没有，重启即丢——
  // 这比"界面看着记上了"诚实（宿主拒绝一切时插件不写数据，DoD 第 3 条）。
  if (!granted.has('storage')) return { ok: false, reason: '未获授权 storage：记不了' };
  const now = Date.now();
  const out = window.QuickCore.add(entries, text, now, { cap: cfg.cap });
  if (!out.added && !out.merged) return { ok: false, reason: out.reason || '没记下' };
  entries = out.entries;
  await saveEntries();
  return {
    ok: true,
    added: out.added,
    merged: out.merged,
    evicted: out.evicted ? { id: out.evicted.id, text: out.evicted.text } : null,
    count: entries.length,
  };
}

async function doTogglePin(id) {
  entries = window.QuickCore.togglePin(entries, id);
  await saveEntries();
  return { ok: true, id };
}

async function doRemove(id) {
  entries = window.QuickCore.removeEntry(entries, id);
  picked.delete(id);
  await saveEntries();
  return { ok: true, id };
}

// --- serves：add / recent -----------------------------------------------------

/** add → 远程记一条。与面板输入走同一个 doAdd（写者唯一）。 */
function answerAdd(payload) {
  const text = payload && typeof payload.text === 'string' ? payload.text : '';
  return doAdd(text);
}

/** recent → 最近 N 条（可带 tag/query）。只读，不写盘。 */
function answerRecent(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const list = window.QuickCore.recent(entries, { limit: p.limit, tag: p.tag, query: p.query });
  return { ok: true, count: entries.length, items: list.map((e) => ({ id: e.id, text: e.text, tags: e.tags, pinned: e.pinned, at: e.at })) };
}

const CALL_HANDLERS = {
  add: (payload) => answerAdd(payload),
  recent: (payload) => answerRecent(payload),
};

/** 必须与 manifest 的 serves 逐字相同（测试里钉住）：少一边，调用方等到 30 秒超时。 */
async function onCall(data) {
  const ticket = typeof data.ticket === 'string' ? data.ticket : '';
  if (!ticket) return;
  const method = typeof data.method === 'string' ? data.method : '';
  const handler = CALL_HANDLERS[method];
  if (!handler) {
    postCallResult(ticket, false, new Error(`速记盒子不认识方法 ${method || '(空)'}：它只回答 ${Object.keys(CALL_HANDLERS).join(' / ')}`));
    return;
  }
  try {
    postCallResult(ticket, true, await handler(data.payload));
  } catch (err) {
    postCallResult(ticket, false, err);
  }
}

// --- "让模型整理"（llm.chat，仅桌宠侧） -----------------------------------------

/**
 * 把选中的速记交给模型整理成要点。ids 可传（测试接缝 / 远程整理），缺省用插件页勾选。
 * 失败退化为原文拼接（不崩、不丢内容）：整理是锦上添花，原文永远在列表里。
 */
async function tidyPicked(ids) {
  const wanted = Array.isArray(ids) ? ids : [...picked];
  const picks = entries.filter((e) => wanted.indexOf(e.id) >= 0);
  if (picks.length === 0) return { ok: false, reason: '没有选中任何一条' };
  const source = picks.map((e, i) => `${i + 1}. ${e.text}`).join('\n');
  if (!hostServes('llm.chat') || !granted.has('llm.chat')) {
    return { ok: true, degraded: true, text: source, reason: '模型只在桌宠侧可用，这里是原文' };
  }
  try {
    const res = await request('llm.chat', {
      messages: [
        { role: 'system', content: '把用户给的速记整理成要点列表，保留原意，不超过 200 字，不要编造。' },
        { role: 'user', content: source },
      ],
    });
    const text = res && typeof res.text === 'string' && res.text.trim() ? res.text.trim() : source;
    return { ok: true, degraded: false, text };
  } catch (err) {
    return { ok: true, degraded: true, text: source, reason: String((err && err.message) || err) };
  }
}

// --- 视图 ---------------------------------------------------------------------

const els = {};
function grabEls() {
  for (const id of ['root', 'workshop', 'chip-count', 'add-form', 'add-input', 'add-btn', 'add-note', 'tag-chips', 'search-input', 'search-clear', 'pick-bar', 'pick-count', 'llm-tidy', 'pick-none', 'llm-note', 'list', 'list-empty', 'status']) {
    const key = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    els[key] = document.getElementById(id);
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

function note(text) { if (els.addNote) els.addNote.textContent = text || ''; }
function llmNote(text) { if (els.llmNote) els.llmNote.textContent = text || ''; }

function allTags() {
  const tags = [];
  for (const e of entries) for (const t of e.tags) if (tags.indexOf(t) < 0) tags.push(t);
  return tags;
}

let activeTag = '';
let activeQuery = '';

function renderChips() {
  const box = els.tagChips;
  if (!box) return;
  box.textContent = '';
  for (const t of allTags()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip-btn' + (t === activeTag ? ' on' : '');
    b.textContent = '#' + t;
    b.addEventListener('click', () => { activeTag = activeTag === t ? '' : t; paint(); });
    box.appendChild(b);
  }
}

function renderRow(e) {
  const row = document.createElement('div');
  row.className = 'row' + (e.pinned ? ' pinned' : '');
  row.dataset.id = e.id;

  const pick = document.createElement('input');
  pick.type = 'checkbox';
  pick.className = 'pick';
  pick.checked = picked.has(e.id);
  pick.setAttribute('aria-label', '选中这条速记');
  pick.addEventListener('change', () => {
    if (pick.checked) picked.add(e.id); else picked.delete(e.id);
    paint();
  });

  const body = document.createElement('div');
  body.className = 'body';
  const text = document.createElement('p');
  text.className = 'text';
  text.textContent = e.text;
  const meta = document.createElement('p');
  meta.className = 'meta';
  const when = document.createElement('span');
  when.textContent = e.at ? new Date(e.at).toISOString().slice(0, 10) : '';
  meta.appendChild(when);
  for (const t of e.tags) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = '#' + t;
    meta.appendChild(tag);
  }
  if (e.pinned) {
    const pin = document.createElement('span');
    pin.textContent = '置顶';
    meta.appendChild(pin);
  }
  body.appendChild(text);
  body.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const pinBtn = document.createElement('button');
  pinBtn.type = 'button';
  pinBtn.className = 'btn soft';
  pinBtn.textContent = e.pinned ? '取消置顶' : '置顶';
  pinBtn.disabled = !granted.has('storage');
  pinBtn.addEventListener('click', () => void doTogglePin(e.id));
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'btn soft';
  delBtn.textContent = '删';
  delBtn.disabled = !granted.has('storage');
  delBtn.addEventListener('click', () => void doRemove(e.id));
  actions.appendChild(pinBtn);
  actions.appendChild(delBtn);

  row.appendChild(pick);
  row.appendChild(body);
  row.appendChild(actions);
  return row;
}

function paint() {
  if (els.chipCount) els.chipCount.textContent = `${entries.length} 条 / 上限 ${cfg.cap}`;
  renderChips();
  const list = els.list;
  if (!list) return;
  const shown = window.QuickCore.recent(entries, { limit: 100, tag: activeTag, query: activeQuery });
  list.textContent = '';
  if (els.listEmpty) els.listEmpty.hidden = shown.length > 0;
  // recent 反转了顺序（新的在前），勾选行保持可交互
  for (const e of shown) list.appendChild(renderRow(e));
  if (els.pickBar) {
    els.pickBar.hidden = picked.size === 0;
    if (els.pickCount) els.pickCount.textContent = `已选 ${picked.size} 条`;
    if (els.llmTidy) {
      const usable = granted.has('llm.chat') && hostServes('llm.chat');
      els.llmTidy.disabled = picked.size === 0 || !usable;
      els.llmTidy.title = usable ? '' : '模型只在桌宠侧可用';
    }
  }
}

async function runTidy() {
  llmNote('整理中…');
  const out = await tidyPicked();
  if (out.ok) {
    llmNote((out.degraded ? `（${out.reason}）\n` : '') + out.text);
  } else {
    llmNote(out.reason || '没整理出来');
  }
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
      ? '未获授权 storage：记不了'
      : self.slot === 'background' ? '常驻帧就绪' : '就绪';
  }

  await refreshConfig().catch(() => {});
  await loadEntries();
  // 插件页才画：常驻帧什么都不画，等被问。
  if (self.slot !== 'background') paint();
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
    default: break; // event / surface / 未知类型：忽略是协议要求的宽容
  }
}

window.addEventListener('message', onMessage);

// 元素抓取必须在绑监听器之前（convert-kit 的教训）：常驻帧里这些控件大多不存在。
grabEls();

// 插件页的表单与按钮（常驻帧没有这些控件）
if (els.addForm) {
  els.addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = els.addInput;
    if (!input || !granted.has('storage')) { note('未获授权 storage：记不了'); return; }
    const text = input.value;
    input.disabled = true;
    void doAdd(text)
      .then((out) => {
        if (out.ok) {
          input.value = '';
          note(out.merged ? '重复内容：已合并并提到最前'
            : out.evicted ? `已记下；挤掉了一条最旧的未置顶（${out.evicted.text.slice(0, 20)}…）`
            : '已记下');
          paint();
        } else note(out.reason || '没记下');
      })
      .catch(() => note('没记下'))
      .finally(() => { input.disabled = false; });
  });
}
if (els.searchInput) {
  els.searchInput.addEventListener('input', () => {
    activeQuery = els.searchInput.value;
    if (els.searchClear) els.searchClear.hidden = !activeQuery;
    paint();
  });
}
if (els.searchClear) {
  els.searchClear.addEventListener('click', () => {
    if (els.searchInput) els.searchInput.value = '';
    activeQuery = '';
    els.searchClear.hidden = true;
    paint();
  });
}
if (els.llmTidy) els.llmTidy.addEventListener('click', () => void runTidy());
if (els.pickNone) els.pickNone.addEventListener('click', () => { picked.clear(); paint(); });

// **监听器装好之后**才握手：init 可能在 post 完的下一个任务就到达。
HOST.postMessage({ v: PROTOCOL, type: 'ready' }, '*');

/**
 * 测试接缝：常驻帧被 plugin.call 问（行为发生在看不见的那一面）。
 * 纯逻辑在 window.QuickCore；这里的函数是"接了宿主的那些"。
 */
window.__quicksave = Object.freeze({
  handlers: CALL_HANDLERS,
  doAdd,
  doTogglePin,
  doRemove,
  tidyPicked,
  paint,
  snapshot: () => ({
    slot: self.slot,
    kind: self.kind,
    ready,
    loaded,
    granted: [...granted],
    cfg: { ...cfg },
    count: entries.length,
    picked: [...picked],
    entries: entries.map((e) => ({ ...e, tags: [...e.tags] })),
  }),
  core: window.QuickCore,
});
