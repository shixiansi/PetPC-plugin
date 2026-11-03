// 纪念日倒计时：常驻帧跨天重算、更新徽标、答 plugin.call 的 next；浮层面/插件页画列表。
//
// 一个文档，三种挂载（由 init 的 surface 决定，见 panel.html 顶部注释）。"今天几号"统一走
// clock()：常驻帧给真实时钟，测试注入固定值——业务逻辑里不散落 new Date()。
//
// 轮询纪律（§7）：配置与数据的变化由 events（config.changed / storage.changed）即时反应；
// 15 秒兜底拉起可能错过的变化。没有一秒级的轮询——跨天才需要重算，15 秒一次的检查在
// dayKey 没变时直接返回。

'use strict';

// --- 宿主桥 ------------------------------------------------------------------

const PROTOCOL = 1;
const PLUGIN_ID = 'com.shixiansi.plugin-anniversary';
const HOST = window.parent;
let nextId = 1;
const pending = new Map();
const granted = new Set();

function request(method, payload) {
  const id = `a${nextId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    HOST.postMessage({ v: PROTOCOL, type: 'request', id, method, payload: payload || {} }, '*');
  });
}

// --- 时钟（测试接缝：__anniversary.setClock 注入"今天 = 2026-03-01"） ----------------
//
// nowKey 本地日期串、nowStart 本地零点毫秒、offsetMin 本地偏移（分钟）。

const clock = {
  nowKey: () => window.AnniversaryDates.dayKeyOf(Date.now(), -new Date().getTimezoneOffset()),
  offsetMin: () => -new Date().getTimezoneOffset(),
};
function todayKey() { return clock.nowKey(); }
function localOffsetMin() { return clock.offsetMin(); }

// --- 状态 --------------------------------------------------------------------

let self = { slot: '', kind: '', hostMethods: null };
let cfg = { badgeEnabled: true, remindDays: 3 };
let records = [];          // parseRecords 之后的合法记录（ storage 的真相）
let ready = false;
let viewKey = '';
let badgeText = '';        // 上次发出去的徽标文案；空串 = 宠物头顶没字
let storageSeq = 0;        // storage.changed 的写侧去重：自己刚写完就不要再读一遍
const KEY_RECORDS = 'records';        // 扁平键：每段只能是 [A-Za-z0-9_-]（§6.3，不能带扩展名）

// 这一面有没有"宿主服务这个方法"的权威答案（§5.2.1）：有 host 表就查表，没有退回 slot 猜。
function hostServes(method) {
  if (self.hostMethods) return self.hostMethods.indexOf(method) >= 0;
  if (self.slot === 'workshop') return false; // 控制中心没有 pet 专属方法（§9 的表）
  return true;
}

// 提醒（bubble.say）只有桌宠服务。
function canBubble() {
  return granted.has('pet.bubble') && hostServes('bubble.say');
}

// --- 数据与配置 -----------------------------------------------------------------

async function loadRecords() {
  if (!granted.has('storage')) return;
  const seq = ++storageSeq; // 自己写的 storage.changed 不触发这次读之后的再读
  const res = await request('storage.get', { key: KEY_RECORDS }).catch(() => null);
  if (!res || seq !== storageSeq) return; // 读在飞时又来了一次写/读：旧答案作废
  const parsed = window.AnniversaryDates.parseRecords(res.value);
  if (JSON.stringify(parsed) !== JSON.stringify(records)) records = parsed;
}

async function saveRecords() {
  if (!granted.has('storage')) return;
  storageSeq += 1; // 这是写侧：它引出的 storage.changed 会被上面的 seq 判掉
  await request('storage.set', { key: KEY_RECORDS, value: JSON.stringify(records) }).catch(() => {});
}

async function refreshConfig() {
  if (!granted.has('plugin.config')) return;
  const res = await request('config.get', {}).catch(() => null);
  if (!res || !res.values) return;
  cfg.badgeEnabled = String(res.values.badgeEnabled ?? 'true') !== 'false';
  const rd = Number(res.values.remindDays);
  cfg.remindDays = Number.isFinite(rd) && rd >= 0 ? Math.floor(rd) : 3;
}

// config.changed / storage.changed 只发给订阅过的帧（§7）：订阅一次，失败不致命——兜底还在。
let subscribed = false;
async function subscribeEvents() {
  if (subscribed || !granted.has('events') || !hostServes('events.subscribe')) return;
  subscribed = true;
  await request('events.subscribe', { names: ['config.changed'] }).catch(() => { subscribed = false; });
}

// --- next 的三种形态 -----------------------------------------------------------

/** serve 'next' 的答案：最近的下一个纪念日（当天 = daysLeft 0）。 */
function answerNext() {
  const key = todayKey();
  const off = localOffsetMin();
  const best = window.AnniversaryDates.nextOf(records, key, off);
  return { date: key, next: best, count: records.length };
}

/** 浮层面 / 插件页的列表：按剩余天数排序（单次已过的不出现）。 */
function upcoming() {
  return window.AnniversaryDates.sortedWithDays(records, todayKey(), localOffsetMin());
}

const CALL_HANDLERS = {
  next: answerNext,
};

// --- plugin.call 的应答 --------------------------------------------------------

function postCallResult(ticket, ok, valueOrErr) {
  const msg = ok
    ? { v: PROTOCOL, type: 'call-result', ticket, ok, result: valueOrErr }
    : { v: PROTOCOL, type: 'call-result', ticket, ok, error: String((valueOrErr && valueOrErr.message) || valueOrErr) };
  HOST.postMessage(msg, '*');
}

/** 必须与 manifest 的 serves 逐字相同（测试里钉住）：少一边，调用方等到 30 秒超时。 */
async function onCall(data) {
  const ticket = typeof data.ticket === 'string' ? data.ticket : '';
  if (!ticket) return;
  const method = typeof data.method === 'string' ? data.method : '';
  const handler = CALL_HANDLERS[method];
  if (!handler) {
    postCallResult(ticket, false, new Error(`纪念日不认识方法 ${method || '(空)'}：它只回答 ${Object.keys(CALL_HANDLERS).join(' / ')}`));
    return;
  }
  try {
    postCallResult(ticket, true, await handler(data.payload === undefined ? {} : data.payload));
  } catch (err) {
    postCallResult(ticket, false, err);
  }
}

// --- 徽标与临近提醒 -------------------------------------------------------------

async function updateBadge(force) {
  if (!granted.has('pet.surface') || !hostServes('pet.badge')) return;
  const best = window.AnniversaryDates.nextOf(records, todayKey(), localOffsetMin());
  let text = '';
  if (cfg.badgeEnabled && best) text = window.AnniversaryDates.badgeText(best.daysLeft);
  if (!force && text === badgeText) return;
  badgeText = text;
  await request('pet.badge', { text }).catch(() => { badgeText = ''; });
}

// 气泡只有一个；最吵的翻车就是提醒风暴。remindedKey 记住"已经提过的那个发生"。
let remindTimer = null;
let remindedKey = '';

function scheduleRemindTick() {
  if (remindTimer) { clearTimeout(remindTimer); remindTimer = null; }
  if (!canBubble() || cfg.remindDays <= 0) return;
  remindTimer = setTimeout(() => { remindTick(); }, 20000);
}

function remindTick() {
  scheduleRemindTick();
  if (!canBubble() || cfg.remindDays <= 0) return;
  const list = upcoming();
  const hit = list.find((e) => e.daysLeft <= cfg.remindDays);
  if (!hit) return;
  const key = `${hit.date}|${hit.id}`;
  if (remindedKey === key) return;
  remindedKey = key;
  const when = hit.daysLeft === 0 ? '就是今天' : hit.daysLeft === 1 ? '就是明天' : `${hit.daysLeft} 天后`;
  void request('bubble.say', { text: `${hit.title || '纪念日'}${when}（${hit.date}）` }).catch(() => {});
}

// --- 视图 ---------------------------------------------------------------------

const els = {};
function grabEls() {
  for (const id of ['root', 'status', 'card', 'note', 'upcoming', 'editor', 'list', 'add-form', 'f-title', 'f-date', 'f-yearly', 'b-save', 'b-cancel', 'form-note']) {
    els[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = document.getElementById(id);
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

/** 浮层面 / 插件页里 daysLeft 的措辞：今天 / 明天 / N 天 / -N 天前。 */
function daysWord(daysLeft) {
  if (daysLeft === 0) return '今天';
  if (daysLeft === 1) return '明天';
  return `${daysLeft} 天`;
}

function renderUpcoming(node, list) {
  node.textContent = '';
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = '没有纪念日';
    node.appendChild(p);
    return;
  }
  for (const e of list) {
    const row = document.createElement('div');
    row.className = 'row' + (e.daysLeft === 0 ? ' today' : '');
    const days = document.createElement('span');
    days.className = 'days';
    days.textContent = daysWord(e.daysLeft);
    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = e.title || '（未命名）';
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = `${e.date}${e.yearly ? ' · 每年' : ' · 一次'}${e.clamped && e.yearly ? '（平年按 2/28 过）' : ''}`;
    text.appendChild(sub);
    row.appendChild(days);
    row.appendChild(text);
    node.appendChild(row);
  }
}

/** 重画视图。15 秒的兜底 tick 也会调它，但 dayKey/条数没变时在这里直接返回。 */
function paint() {
  if (!els.card || !els.upcoming || self.kind !== 'surface') return;
  const key = `${todayKey()}|${records.length}`;
  if (key === viewKey) return;
  viewKey = key;
  const list = upcoming();
  renderUpcoming(els.upcoming, list);
  if (els.note) {
    if (!granted.has('storage')) {
      els.note.hidden = false;
      els.note.textContent = '未获授权 storage：读不到你的纪念日';
    } else if (!granted.has('pet.surface')) {
      els.note.hidden = false;
      els.note.textContent = '未获授权 pet.surface：徽标不显示';
    } else if (records.length === 0) {
      els.note.hidden = false;
      els.note.textContent = '还没有纪念日：到控制中心的插件页里添加';
    } else {
      els.note.hidden = true;
    }
  }
  reportHeight();
}

// 浮层面的高度跟内容走（§6.5）：宿主只对声明了 maxH 的块应用 sizes，maxH=300 在 manifest 里。
let heightTimer = null;
function reportHeight() {
  if (self.kind !== 'surface' || !granted.has('pet.surface') || !els.card) return;
  clearTimeout(heightTimer);
  // 防抖到期一定会发（不是"窗口内只发一次"）：每条消息都表示"这是现在的高度"。
  heightTimer = setTimeout(() => {
    request('surface.blocks', { sizes: { '0': Math.min(300, Math.ceil(document.body.scrollHeight) + 2) } }).catch(() => {});
  }, 120);
}

// --- 插件页（workshop）的增删改 --------------------------------------------------
//
// pet 专属的方法（pet.badge / bubble.say / surface.show）在控制中心不存在（§9）：这一面
// 从一开始就不调它们，徽标由常驻帧在 storage.changed 里自己刷新。

let editingId = '';

function renderEditor() {
  if (!els.editor || self.slot !== 'workshop') return;
  const list = upcoming();
  els.list.textContent = '';
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = '还没有纪念日。下面加一个：';
    els.list.appendChild(p);
  }
  for (const e of list) {
    const rec = records.find((r) => r.id === e.id);
    const row = document.createElement('div');
    row.className = 'row-item';
    const main = document.createElement('div');
    main.className = 'row-main';
    const title = document.createElement('div');
    title.className = 'row-title';
    title.textContent = e.title || '（未命名）';
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = `${e.date}${e.yearly ? ' · 每年' : ' · 一次'}`;
    main.appendChild(title);
    main.appendChild(sub);
    const days = document.createElement('span');
    days.className = 'row-days';
    days.textContent = daysWord(e.daysLeft);
    const edit = document.createElement('button');
    edit.className = 'btn';
    edit.type = 'button';
    edit.dataset.editId = e.id;
    edit.textContent = '改';
    const del = document.createElement('button');
    del.className = 'btn';
    del.type = 'button';
    del.dataset.delId = e.id;
    del.textContent = '删';
    row.appendChild(main);
    row.appendChild(days);
    row.appendChild(edit);
    row.appendChild(del);
    els.list.appendChild(row);
  }
}

function startEdit(id) {
  const rec = records.find((r) => r.id === id);
  if (!rec) return;
  editingId = id;
  els.fTitle.value = rec.title;
  els.fDate.value = rec.date;
  els.fYearly.checked = rec.yearly;
  els.bCancel.hidden = false;
  els.bSave.textContent = '更新';
  els.formNote.hidden = true;
  els.fTitle.focus();
}

function resetForm() {
  editingId = '';
  els.fTitle.value = '';
  els.fDate.value = '';
  els.fYearly.checked = true;
  els.bCancel.hidden = true;
  els.bSave.textContent = '保存';
  els.formNote.hidden = true;
}

function formError(text) {
  els.formNote.hidden = false;
  els.formNote.textContent = text;
}

function newId() {
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function onSubmit(ev) {
  ev.preventDefault();
  if (!els.fTitle || self.slot !== 'workshop') return;
  const title = els.fTitle.value.trim();
  const date = els.fDate.value;
  const parsed = window.AnniversaryDates.parseRecord({ title, date, yearly: els.fYearly.checked });
  if (!parsed) {
    // <input type="date"> 的空/非法值就是空串：点名让用户补，不猜、不静默改成今天。
    formError(!date ? '请先选一个日期（年可以一直翻到 0001）' : `日期不对：${date || '(空)'}（要 YYYY-MM-DD，且日子真实存在）`);
    return;
  }
  if (editingId) {
    const i = records.findIndex((r) => r.id === editingId);
    if (i >= 0) records[i] = { ...parsed, id: editingId };
    else records.push({ ...parsed, id: newId() });
  } else {
    records.push({ ...parsed, id: newId() });
  }
  resetForm();
  await saveRecords();
  paint();
  renderEditor();
}

function onListClick(ev) {
  const t = ev.target instanceof Element ? ev.target.closest('button') : null;
  if (!t) return;
  if (t.dataset.editId) startEdit(t.dataset.editId);
  else if (t.dataset.delId) {
    const before = records.length;
    records = records.filter((r) => r.id !== t.dataset.delId);
    if (records.length !== before) {
      if (editingId === t.dataset.delId) resetForm();
      void saveRecords().then(() => { paint(); renderEditor(); });
    }
  }
}

function wireWorkshop() {
  if (self.slot !== 'workshop') return;
  els.editor.hidden = false;
  els.addForm.addEventListener('submit', onSubmit);
  els.list.addEventListener('click', onListClick);
  els.bCancel.addEventListener('click', resetForm);
  renderEditor();
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
  editingId = '';
  remindedKey = '';

  if (els.root) {
    els.root.classList.remove('view-boot');
    if (self.kind === 'surface') els.root.classList.add('view-surface');
    else if (self.slot === 'background') els.root.classList.add('bg');
  }
  if (els.status) {
    els.status.textContent = granted.has('storage')
      ? (self.slot === 'workshop' ? '在这里管理你的纪念日' : '已就绪')
      : '未获授权：storage';
  }

  await refreshConfig().catch(() => {});
  await loadRecords().catch(() => {});
  await subscribeEvents();
  paint();
  if (self.slot === 'workshop') wireWorkshop();
  void updateBadge(true);
  scheduleRemindTick();
}

// events（config.changed / storage.changed）做即时反应，不轮询。
function onHostEvent(name, payload) {
  if (name === 'config.changed' && (!payload || payload.pluginId === PLUGIN_ID)) {
    void (async () => {
      await refreshConfig().catch(() => {});
      await loadRecords().catch(() => {});
      paint();
      renderEditor();
      void updateBadge(true);
      scheduleRemindTick();
    })();
  }
  if (name === 'storage.changed' && payload && payload.key === KEY_RECORDS) {
    void (async () => {
      await loadRecords().catch(() => {});
      paint();
      renderEditor();
      void updateBadge(false);
    })();
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
    case 'event': onHostEvent(String(data.name || ''), data.payload); break;
    case 'call': void onCall(data); break;
    default: break; // surface / 未知类型：忽略是协议要求的宽容
  }
}

window.addEventListener('message', onMessage);
// 兜底间隔：跨天重算 + "可能错过的变化"的最后一道。15 秒是手册给的兜底拍子（§7.2）；
// dayKey 没变时 paint/updateBadge 直接返回——这不是每 15 秒一次的重排。
let lastDay = '';
setInterval(() => {
  if (!ready) return;
  const k = todayKey();
  if (k === lastDay) return;
  lastDay = k;
  viewKey = '';
  paint();
  renderEditor();
  void updateBadge(false);
}, 15000);

grabEls();
// **监听器装好之后**才握手：init 可能在 post 完的下一个任务就到达。
HOST.postMessage({ v: PROTOCOL, type: 'ready' }, '*');

/**
 * 测试接缝：常驻帧被 plugin.call 问、徽标在没人看着时更新——行为发生在看不见的那一面。
 * 纯日期逻辑在 window.AnniversaryDates（lib/dates.js）；这里的函数是"接了宿主的那些"。
 */
window.__anniversary = Object.freeze({
  answerNext,
  upcoming,
  handlers: CALL_HANDLERS,
  refreshConfig,
  loadRecords,
  saveRecords,
  updateBadge,
  remindTick,
  renderEditor,
  onSubmit,
  setClock: (nowKeyOverride, offsetMinOverride) => {
    if (nowKeyOverride) clock.nowKey = nowKeyOverride;
    if (offsetMinOverride != null) clock.offsetMin = () => offsetMinOverride;
  },
  snapshot: () => ({
    slot: self.slot,
    kind: self.kind,
    ready,
    granted: [...granted],
    cfg: { ...cfg },
    records: records.map((r) => ({ ...r })),
    badgeText,
    editingId,
    storageSeq,
  }),
});
