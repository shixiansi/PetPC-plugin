// 习惯打卡：常驻帧算换日与徽标、答 plugin.call 的 streak/today；浮层面与工坊页打卡。
//
// 一个文档，三种挂载（由 init 的 surface 决定，见 panel.html 顶部注释）。"现在几点"统一走
// clock()：常驻帧给真实时钟，测试注入固定值——业务逻辑里不散落 new Date()。
//
// 写者唯一（§6.3）：state 这一个键只由这个文档写（三种挂载是同一个文档的不同面，
// 都走同一个 saveState）。徽标、浮层、工坊共享同一份内存态，改动后写盘并广播重绘。
//
// 轮询纪律（§7）：配置变化由 events（config.changed）即时反应；15 秒兜底只做"跨换日点
// 重绘 + 徽标校正"，dayKey 没变且完成情况没变时什么都不发。

'use strict';

// --- 宿主桥 ------------------------------------------------------------------

const PROTOCOL = 1;
const PLUGIN_ID = 'com.shixiansi.plugin-habits';
const HOST = window.parent;
let nextId = 1;
const pending = new Map();
const granted = new Set();

function request(method, payload) {
  const id = `h${nextId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    HOST.postMessage({ v: PROTOCOL, type: 'request', id, method, payload: payload || {} }, '*');
  });
}

// --- 时钟（测试接缝：__habits.setClock 注入固定时刻） ---------------------------

const clock = { nowMs: () => Date.now(), offsetMin: () => -new Date().getTimezoneOffset() };
function nowMs() { return clock.nowMs(); }
function localOffsetMin() { return clock.offsetMin(); }

// --- 状态 --------------------------------------------------------------------

let self = { slot: '', kind: '', hostMethods: null };
let cfg = { dayChangeHour: 4, showBadge: true, hideWhenDone: false };
let state = window.HabitCore.parseState('');
let summary = null;          // summarize(state, todayKey) 的缓存，paint/answer 共用
let ready = false;
let todayKey = '';
let subscribed = false;
// 徽标上一次写的内容：内容没变就不重复发（pet.badge 是全量文本，去重靠这里）。
let lastBadge = null;
// 打卡记录在内存里的落盘时刻：换日检查用它区分"磁盘是新的"与"磁盘是旧的"。
let viewKey = '';

const KEY_STATE = 'habits/state'; // 唯一的存储键：{habits:[{id,name}], log:{id:[day,...]}}

// 这一面有没有"宿主服务这个方法"的权威答案（§5.2.1）：有 host 表就查表，没有退回 slot 猜。
function hostServes(method) {
  if (self.hostMethods) return self.hostMethods.indexOf(method) >= 0;
  if (self.slot === 'workshop') return false; // 控制中心没有 pet 专属方法（§9 的表）
  return true;
}

// 徽标只有桌宠画得了（pet.badge 是 where:'pet' 的方法）。
function canBadge() {
  return granted.has('pet.surface') && hostServes('pet.badge');
}

function dayKeyNow() {
  return window.HabitCore.dayKeyOf(nowMs(), cfg.dayChangeHour, localOffsetMin());
}

function refreshSummary() {
  todayKey = dayKeyNow();
  summary = window.HabitCore.summarize(state, todayKey);
  return summary;
}

// --- 配置 --------------------------------------------------------------------

async function refreshConfig() {
  if (!granted.has('plugin.config')) return;
  const res = await request('config.get', {}).catch(() => null);
  if (!res || !res.values) return;
  const hour = Number(res.values.dayChangeHour);
  cfg.dayChangeHour = Number.isFinite(hour) ? Math.max(0, Math.min(23, Math.floor(hour))) : 4;
  cfg.showBadge = String(res.values.showBadge ?? 'true') !== 'false';
  cfg.hideWhenDone = String(res.values.hideWhenDone ?? 'false') === 'true';
}

async function subscribeEvents() {
  if (subscribed || !granted.has('events') || !hostServes('events.subscribe')) return;
  subscribed = true;
  await request('events.subscribe', { names: ['config.changed'] }).catch(() => { subscribed = false; });
}

// --- 存取 --------------------------------------------------------------------

async function loadState() {
  if (!granted.has('storage')) return;
  const res = await request('storage.get', { key: KEY_STATE }).catch(() => ({ value: '' }));
  state = window.HabitCore.parseState(res && res.value);
}

async function saveState(next) {
  state = next;
  refreshSummary();
  // 先画再写：视图反映的是内存态（已是新状态），落盘只是它的副作用。挂载侧的
  // storage.set 若被宿主拒绝，UI 保持新状态但不写坏任何东西——用户下次改动会再写。
  viewKey = '';
  paint();
  updateBadge();
  if (!granted.has('storage')) return;
  void request('storage.set', { key: KEY_STATE, value: JSON.stringify(state) }).catch(() => {});
}

// --- 供 UI 与 serve 共用的动作 -------------------------------------------------

/** 打卡/取消打卡。UI 按钮与 plugin.call 都走这里（写者唯一）。 */
async function setCheck(id, on, byCall) {
  const target = state.habits.find((h) => h.id === id);
  if (!target) throw new Error(`没有这个习惯：${id || '(空)'}`);
  const key = dayKeyNow();
  const before = (state.log[id] || []).indexOf(key) >= 0;
  if (before === Boolean(on)) {
    refreshSummary();
    return { id, day: key, done: Boolean(on), unchanged: true, byCall: Boolean(byCall) };
  }
  await saveState(window.HabitCore.withCheck(state, id, key, Boolean(on)));
  return { id, day: key, done: Boolean(on), unchanged: false, byCall: Boolean(byCall) };
}

async function addHabit(name) {
  const clean = String(name || '').trim().slice(0, 24);
  if (!clean) throw new Error('习惯的名字不能是空的');
  // id 由名字派生 + 随机尾巴：重名、改名、删除后重建都不冲突。
  const id = 'h' + Math.random().toString(36).slice(2, 8);
  await saveState(window.HabitCore.withHabitAdded(state, id, clean));
  return { id, name: clean };
}

async function removeHabit(id) {
  const target = state.habits.find((h) => h.id === id);
  if (!target) throw new Error(`没有这个习惯：${id || '(空)'}`);
  await saveState(window.HabitCore.withHabitRemoved(state, id));
  return { id, name: target.name };
}

// --- serves：streak / today ----------------------------------------------------

/** streak → 每个习惯的连续天数（连击断了就从 0 报，两次查询结果一致）。 */
function answerStreak() {
  const s = summary || refreshSummary();
  return {
    day: s.day,
    habits: s.habits.map((h) => ({ id: h.id, name: h.name, streak: h.streak, doneToday: h.doneToday })),
    done: s.done,
    total: s.total,
    remaining: s.remaining,
  };
}

/** today → 今天的整体进度（徽标那句话的数据源）。 */
function answerToday() {
  const s = summary || refreshSummary();
  return { day: s.day, done: s.done, total: s.total, remaining: s.remaining, allDone: s.total > 0 && s.remaining === 0 };
}

const CALL_HANDLERS = {
  streak: () => answerStreak(),
  today: () => answerToday(),
};

// --- plugin.call 的应答（§6.10 的唯一回法）--------------------------------------

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
    postCallResult(ticket, false, new Error(`习惯打卡不认识方法 ${method || '(空)'}：它只回答 ${Object.keys(CALL_HANDLERS).join(' / ')}`));
    return;
  }
  try {
    postCallResult(ticket, true, await handler(data.payload === undefined ? {} : data.payload));
  } catch (err) {
    postCallResult(ticket, false, err);
  }
}

// --- 徽标 ----------------------------------------------------------------------

/** 「今日还差几个」：全部完成按开关写「全完成」或清空；没有习惯也清空。 */
function badgeText() {
  const s = summary || refreshSummary();
  if (s.total === 0) return '';
  if (s.remaining === 0) return cfg.hideWhenDone ? '全完成' : '';
  return `还差 ${s.remaining} 个`;
}

function updateBadge() {
  if (!canBadge() || !cfg.showBadge) {
    // 关掉徽标开关：至少要把上一次的字清掉（清不掉就说明这一面做不了这件事）。
    if (lastBadge && canBadge()) {
      lastBadge = '';
      void request('pet.badge', { text: '' }).catch(() => {});
    }
    return;
  }
  const text = badgeText().slice(0, 16);
  if (text === lastBadge) return;
  lastBadge = text;
  void request('pet.badge', { text }).catch(() => {});
}

// --- 视图 ---------------------------------------------------------------------

const els = {};
function grabEls() {
  for (const id of ['root', 'status', 'card', 'progress', 'list', 'note', 'manage', 'add-form', 'new-name', 'add-btn']) {
    els[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = document.getElementById(id);
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

function renderRow(h) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.habitId = h.id;

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = h.name;

  const streak = document.createElement('span');
  streak.className = 'streak' + (h.streak >= 3 ? ' hot' : '');
  streak.textContent = h.doneToday ? `连 ${h.streak} 天` : `${h.streak} 天`;

  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'check' + (h.doneToday ? ' on' : '');
  check.textContent = h.doneToday ? '已打卡' : '打卡';
  check.disabled = !granted.has('storage');
  check.addEventListener('click', () => {
    check.disabled = true;
    void setCheck(h.id, !h.doneToday, false).finally(() => { check.disabled = false; });
  });

  row.appendChild(name);
  row.appendChild(streak);
  row.appendChild(check);
  return row;
}

function renderWorkshopRow(h) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.habitId = h.id;

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = h.name;

  const streak = document.createElement('span');
  streak.className = 'streak' + (h.streak >= 3 ? ' hot' : '');
  streak.textContent = h.doneToday ? `连 ${h.streak} 天` : `${h.streak} 天`;

  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'check' + (h.doneToday ? ' on' : '');
  check.textContent = h.doneToday ? '已打卡' : '打卡';
  check.disabled = !granted.has('storage');
  check.addEventListener('click', () => {
    check.disabled = true;
    void setCheck(h.id, !h.doneToday, false).finally(() => { check.disabled = false; });
  });

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove';
  remove.textContent = '删';
  remove.disabled = !granted.has('storage');
  remove.addEventListener('click', () => {
    remove.disabled = true;
    void removeHabit(h.id).finally(() => { remove.disabled = false; });
  });

  row.appendChild(name);
  row.appendChild(streak);
  row.appendChild(check);
  row.appendChild(remove);
  return row;
}

/** 重画视图。换日/落盘之外的 tick 也会调它，但 key 没变时在这里直接返回。 */
function paint() {
  if (!els.card) return;
  const s = summary || refreshSummary();
  const key = `${s.day}|${s.done}/${s.total}|${state.habits.map((h) => h.id).join(',')}|${ready ? 1 : 0}`;
  if (key === viewKey) return;
  viewKey = key;

  if (els.progress) {
    els.progress.textContent = s.total === 0
      ? '还没有习惯'
      : `今日 ${s.done}/${s.total}　还差 ${s.remaining} 个`;
  }
  const list = els.list;
  if (list) {
    list.textContent = '';
    if (state.habits.length === 0) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = self.slot === 'workshop' ? '在下面添加第一个习惯' : '还没有习惯，去插件页添加';
      list.appendChild(p);
    } else if (self.slot === 'workshop') {
      for (const h of s.habits) list.appendChild(renderWorkshopRow(h));
    } else {
      for (const h of s.habits) list.appendChild(renderRow(h));
    }
  }
  if (els.note) {
    if (!granted.has('storage')) {
      els.note.hidden = false;
      els.note.textContent = '未获授权 storage：打卡会没有效果';
    } else {
      els.note.hidden = true;
    }
  }
  if (els.manage) els.manage.hidden = self.slot !== 'workshop' || !granted.has('storage');
  reportHeight();
}

// 浮层面的高度跟内容走（§6.5）：宿主只对声明了 maxH 的块应用 sizes，maxH=320 在 manifest 里。
let heightTimer = null;
function reportHeight() {
  if (self.kind !== 'surface' || !granted.has('pet.surface') || !els.card) return;
  clearTimeout(heightTimer);
  // 防抖到期一定会发（不是"窗口内只发一次"）：每条消息都表示"这是现在的高度"。
  heightTimer = setTimeout(() => {
    request('surface.blocks', { sizes: { '0': Math.min(320, Math.ceil(document.body.scrollHeight) + 2) } }).catch(() => {});
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
  lastBadge = null; // 重挂后重新对表：徽标内容哪怕没变，新帧也要重算

  if (els.root) {
    els.root.classList.remove('view-boot');
    if (self.kind === 'surface') els.root.classList.add('view-surface');
    else if (self.slot === 'background') els.root.classList.add('bg');
  }
  if (els.status) {
    els.status.textContent = !granted.has('storage')
      ? '未获授权：storage'
      : self.slot === 'workshop' ? '在这里管理习惯' : '已就绪';
  }

  await refreshConfig().catch(() => {});
  await loadState().catch(() => {});
  await subscribeEvents();
  refreshSummary();
  paint();
  updateBadge();
}

// events（config.changed）做即时反应，不轮询配置。
function onHostEvent(name, payload) {
  if (name === 'config.changed' && (!payload || payload.pluginId === PLUGIN_ID)) {
    void (async () => {
      await refreshConfig().catch(() => {});
      refreshSummary();
      paint();
      updateBadge();
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

// 兜底间隔：跨换日点后重算 todayKey / 重画 / 校正徽标。15 秒是手册给的兜底拍子（§7.2）。
// dayKey 与完成数都没变时 paint 与 updateBadge 直接返回——这不是一次轮询。
setInterval(() => {
  if (!ready) return;
  const before = todayKey;
  refreshSummary();
  if (before !== todayKey) viewKey = '';
  paint();
  updateBadge();
}, 15000);

grabEls();

// 工坊页的添加表单（其余挂载没有这个控件）
if (els.addForm) {
  els.addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = els.newName;
    if (!input || !granted.has('storage')) return;
    const name = input.value;
    input.disabled = true;
    void addHabit(name)
      .then(() => { input.value = ''; })
      .catch(() => {})
      .finally(() => { input.disabled = false; });
  });
}

// **监听器装好之后**才握手：init 可能在 post 完的下一个任务就到达。
HOST.postMessage({ v: PROTOCOL, type: 'ready' }, '*');

/**
 * 测试接缝：常驻帧被 plugin.call 问、徽标在没人看着时更新——行为发生在看不见的那一面。
 * 纯逻辑在 window.HabitCore（lib/habit-core.js）；这里的函数是"接了宿主的那些"。
 */
window.__habits = Object.freeze({
  handlers: CALL_HANDLERS,
  setCheck,
  addHabit,
  removeHabit,
  setClock: (nowMsOverride, offsetMinOverride) => {
    clock.nowMs = nowMsOverride || clock.nowMs;
    clock.offsetMin = offsetMinOverride != null ? () => offsetMinOverride : clock.offsetMin;
    todayKey = '';
  },
  recompute: refreshSummary,
  snapshot: () => ({
    slot: self.slot,
    kind: self.kind,
    ready,
    granted: [...granted],
    cfg: { ...cfg },
    todayKey,
    lastBadge,
    subscribed,
    state: {
      habits: state.habits.map((h) => ({ ...h })),
      log: Object.fromEntries(Object.entries(state.log).map(([k, v]) => [k, [...v]])),
    },
  }),
  core: window.HabitCore,
});
