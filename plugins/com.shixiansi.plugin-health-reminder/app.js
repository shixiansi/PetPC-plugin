// 久坐喝水提醒：常驻帧跑三组计时（喝水/久坐/护眼），到点让桌宠说一句；浮层面与插件页
// 显示三组倒计时与今日计数，头顶徽标显示"下一次提醒还有几分钟"。
//
// 一个文档，三种挂载（由 init 的 surface 决定，见 panel.html 顶部注释）。
// "现在几点"统一走 clock()：常驻帧给真实时钟，测试注入固定值——业务逻辑里不散落 new Date()。
//
// 轮询纪律（任务书 §2）：没有 1 秒轮询。提醒计时是 60 秒一跳的 setInterval（允许的拍子）；
// 配置变化走 events 的 config.changed；15 秒兜底只服务重绘与徽标（视图键没变时 paint 直接返回），
// 非常驻面每 15 秒补读一次自己的 state（§7.2 的兜底拍子，主路径是 storage.changed）。
//
// **休眠后墙钟失准是已知限制**：计时基准是"下一次触发的墙钟时刻"，睡眠期间 setInterval 停跳、
// 醒来后 Date.now() 一次性追上——极端情况下第一声提醒可能迟到、或醒来后第一跳补发一次。
// 彻底修法（单调钟 + 宿主休眠事件）留给路线图 M4。
//
// **全屏静默**：本插件拿不到全屏状态（宿主没有这个方法/事件）。静默语义由两件配置组成：
// 勿扰时段（config.dndWindow，HH:MM-HH:MM）与"用户点过歇会儿"（state.restUntil）。
// 真全屏检测留给宿主的 M 机制：宿主有了那个事件后，在 isSilent() 里加第三个条件即可。

'use strict';

// --- 宿主桥 ------------------------------------------------------------------

const PROTOCOL = 1;
const PLUGIN_ID = 'com.shixiansi.plugin-health-reminder';
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

// --- 时钟（测试接缝：__health.setClock 注入"现在"） ------------------------------

const clock = { nowMs: () => Date.now() };
function nowMs() { return clock.nowMs(); }

// --- 存储键（扁平名，/ 分隔 ≤4 段，每段 [A-Za-z0-9_-]，无扩展名——§6.3） -------------
// 一个键只有一个写者（§6.3）：state/v1 只由常驻帧写；rest/request 只由"歇会儿"按钮所在的
// 浮层面写。常驻帧经 storage.changed（自己的目录，不需要 events.subscribe）得知请求并落进
// 自己那份 state——两个角色对同一键的读-改-写竞态就不存在。
const KEY_STATE = 'state/v1';
const KEY_REST = 'rest/request';

// --- 状态 --------------------------------------------------------------------

let self = { slot: '', kind: '', hostMethods: null };
let ready = false;
let subscribed = false;
let viewKey = '';

// 默认值与 manifest 的 config 一致（表单空着时宿主会填 default，这里再兜一层）。
const GROUPS = ['water', 'sit', 'eye'];
const GROUP_LABEL = { water: '喝水', sit: '久坐', eye: '护眼' };
let cfg = {
  waterEnabled: true, waterIntervalMin: 45,
  sitEnabled: true, sitIntervalMin: 45,
  eyeEnabled: true, eyeIntervalMin: 30,
  dndWindow: '23:00-07:00',
  restMinutes: 30,
};

// 每组：nextAt（下一次触发的墙钟 ms，0=未排程）、dayKey（计数属于哪个本地日）、done（今日触发数）。
// rest 是"用户点过歇会儿"的静默语义：restUntil 之前一切提醒静默（计时继续走，只是不出声）。
let state = {
  water: { nextAt: 0, dayKey: '', done: 0 },
  sit: { nextAt: 0, dayKey: '', done: 0 },
  eye: { nextAt: 0, dayKey: '', done: 0 },
  restUntil: 0,
};
let stateDirty = false; // 有未落盘的改动；落盘由 persistState() 收口

// 这一面有没有"宿主服务这个方法"的权威答案（§5.2 / §9）：有 host 表就查表，没有退回 slot 猜。
function hostServes(method) {
  if (self.hostMethods) return self.hostMethods.indexOf(method) >= 0;
  if (self.slot === 'workshop') return false; // 控制中心没有 pet 专属方法
  return true;
}

// bubble.say / pet.badge 只有桌宠服务（§9 的表）：workshop 面不发这些请求。
function canBubble() { return granted.has('pet.bubble') && hostServes('bubble.say'); }
function canBadge() { return granted.has('pet.surface') && hostServes('pet.badge'); }
function isTimer() { return self.kind !== 'surface' && self.slot !== 'workshop'; }

// --- 纯函数（测试从 __health 直接调用） ----------------------------------------

/** "HH:MM" → 分钟数；非法返回 NaN。 */
function minutesOf(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  if (!m) return NaN;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return NaN;
  return h * 60 + min;
}

/** 解析"HH:MM-HH:MM"；非法/空白返回 null（=不启用勿扰）。 */
function parseDnd(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const from = minutesOf(`${m[1]}:${m[2]}`);
  const to = minutesOf(`${m[3]}:${m[4]}`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return { from, to };
}

/**
 * 本地日键——与全局换日一致，按 04:00 切：凌晨 0-4 点仍算"前一天"。
 */
function dayKeyOf(ms) {
  const d = new Date(ms - 4 * 3600000); // 04:00 为界
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 现在是否在勿扰时段内。
 * 跨午夜（from > to，如 23:00-07:00）：at >= from || at <= to；同日：from <= at <= to。
 * （to 用 <=：07:00 整也静默，07:01 恢复——勿扰的"到几点"包含那一分钟。）
 */
function inDnd(dnd, atMin) {
  if (!dnd) return false;
  return dnd.from > dnd.to ? (atMin >= dnd.from || atMin <= dnd.to) : (atMin >= dnd.from && atMin <= dnd.to);
}

/** 本地分钟数（0..1439）。 */
function minuteOfDay(ms) {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * 静默判定。返回 '' / 'dnd' / 'rest'（说出口用）。
 * 全屏状态拿不到（见文件头注释）；真全屏检测留给宿主的 M 机制，在那里加第三个条件。
 */
function isSilent(now, dnd, st) {
  if (inDnd(dnd, minuteOfDay(now))) return 'dnd';
  if (st.restUntil > now) return 'rest';
  return '';
}

/** 开关/间隔归一：config 的值可能是字符串；间隔下限 1 分钟。 */
function groupCfg(name, cfgSnapshot) {
  const src = cfgSnapshot || cfg;
  const on = src[`${name}Enabled`];
  const raw = Number(src[`${name}IntervalMin`]);
  return { enabled: on !== false && on !== 'false', intervalMin: Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 45 };
}

/** 倒计时文案（徽标 ≤16 字符的限制内）。 */
function countdownText(msLeft) {
  if (msLeft <= 0) return '就现在';
  const min = msLeft / 60000;
  if (min < 1) return '<1 分钟';
  return `${Math.ceil(min)} 分钟`;
}

/** 徽标文案：三组里最近的启用组倒计时。全关/未排程 = 空串（清除徽标）。 */
function badgeTextFor(now, st, cfgSnapshot) {
  let best = -1;
  for (const name of GROUPS) {
    if (!groupCfg(name, cfgSnapshot).enabled) continue;
    const at = st[name].nextAt;
    if (!at) continue;
    if (best < 0 || at < best) best = at;
  }
  if (best < 0) return '';
  const left = best - now;
  if (left <= 0) return '提醒就现在';
  return `下一次 ${countdownText(left)}`;
}

/** 气泡文案：到点的那组说什么（done 已含这一次）。 */
function bubbleTextFor(name, st) {
  const done = st[name].done;
  if (name === 'water') return `该喝水啦～今天第 ${done} 次提醒`;
  if (name === 'sit') return `久坐提醒：起来走两步吧（今天第 ${done} 次）`;
  return `看看远处休息下眼睛吧（今天第 ${done} 次）`;
}

/**
 * 一跳（60 秒一次）的纯逻辑：对三组各回答"要不要在这一跳说话"。
 * 返回 [{name, muted}]（一组一行；同一跳多组同时到点也全列出，说话方只挑一个——气泡只有一个）。
 *
 * 规则，按序：
 *   1. 开关关着 → 不触发也不排程（关掉开关立即停）；
 *   2. 未排程 → 从现在起排，这一跳不触发；
 *   3. nextAt 还没到 → 不触发；
 *   4. 到点了：跨日计数先归零（dayKey 按 04:00 与全局换日一致）→ 完成数 +1 →
 *      下一轮从"这次到达的时刻"起排（不按积压补发连环气泡）；
 *   5. 勿扰/歇会儿 → 计数与排程照走，只是不说话（muted）。
 */
function tickGroups(now, cfgSnapshot, st, dnd) {
  const fired = [];
  for (const name of GROUPS) {
    const g = groupCfg(name, cfgSnapshot);
    if (!g.enabled) continue;
    const slot = st[name];
    if (!slot.nextAt) { slot.nextAt = now + g.intervalMin * 60000; continue; }
    if (now < slot.nextAt) continue;
    const key = dayKeyOf(now);
    if (slot.dayKey !== key) { slot.done = 0; slot.dayKey = key; }
    slot.done += 1;
    slot.nextAt = now + g.intervalMin * 60000;
    fired.push({ name, muted: Boolean(isSilent(now, dnd, st)) });
  }
  return fired;
}

// --- 状态读写 -----------------------------------------------------------------

function loadState() {
  if (!granted.has('storage')) return Promise.resolve();
  return request('storage.get', { key: KEY_STATE })
    .then((res) => {
      const raw = String((res && res.value) || '');
      if (!raw) return;
      try {
        const saved = JSON.parse(raw);
        for (const name of GROUPS) {
          const s = saved && saved[name];
          if (!s || typeof s !== 'object') continue;
          state[name].nextAt = Number(s.nextAt) || 0;
          state[name].dayKey = String(s.dayKey || '');
          state[name].done = Number(s.done) || 0;
        }
        state.restUntil = Number(saved && saved.restUntil) || 0;
      } catch { /* 损坏的存量：按全新状态重来，不抛进消息循环 */ }
    })
    .catch(() => {});
}

/** 常驻帧补读"歇会儿"请求（写者是浮层面）。值是毫秒；过期的忽略。 */
function loadRestRequest() {
  if (!granted.has('storage') || !isTimer()) return Promise.resolve();
  return request('storage.get', { key: KEY_REST })
    .then((res) => {
      const until = Number((res && res.value) || 0) || 0;
      if (until > nowMs() && until > state.restUntil) {
        state.restUntil = until;
        stateDirty = true;
      }
    })
    .catch(() => {});
}

/** 唯一写者是常驻帧（isTimer）；浮层面/插件页只读自己的内存副本。 */
function persistState() {
  if (!stateDirty || !granted.has('storage') || !isTimer()) return;
  stateDirty = false;
  request('storage.set', { key: KEY_STATE, value: JSON.stringify(state) }).catch(() => {});
}

function markDirty() {
  stateDirty = true;
  if (isTimer()) persistState();
}

// --- 配置 --------------------------------------------------------------------

async function refreshConfig() {
  if (!granted.has('plugin.config')) return;
  const res = await request('config.get', {}).catch(() => null);
  if (!res || !res.values) return;
  const v = res.values;
  for (const name of GROUPS) {
    // 开关归一成布尔：config 表单给的是字符串 "true"/"false"
    if (v[`${name}Enabled`] !== undefined) cfg[`${name}Enabled`] = v[`${name}Enabled`] !== false && v[`${name}Enabled`] !== 'false';
    if (v[`${name}IntervalMin`] !== undefined) cfg[`${name}IntervalMin`] = Number(v[`${name}IntervalMin`]);
  }
  if (v.dndWindow !== undefined) cfg.dndWindow = String(v.dndWindow || '');
  if (v.restMinutes !== undefined) cfg.restMinutes = Number(v.restMinutes) || 30;
}

// config.changed 只发给订阅过的帧（§7）：订阅一次，失败不致命。
async function subscribeEvents() {
  if (subscribed || !granted.has('events') || !hostServes('events.subscribe')) return;
  subscribed = true;
  await request('events.subscribe', { names: ['config.changed'] }).catch(() => { subscribed = false; });
}

// --- 提醒计时（常驻帧 only） ----------------------------------------------------

let tickTimer = null;

function startTimer() {
  if (!isTimer()) return;
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  // 60 秒一跳：提醒的粒度是分钟，一分钟一次不是轮询（这一跳里没有任何"有事件可听"的查询）。
  tickTimer = setInterval(() => { void reminderTick(); }, 60000);
}

/**
 * 一跳。**到点触发在这里发生**：tickGroups 是纯函数（测试直接调），这里只负责
 * 发气泡、落盘、重绘。同一跳里多组同时到点只说一组（气泡只有一个，提醒风暴是最吵的翻车）。
 */
async function reminderTick() {
  if (!isTimer() || !ready) return;
  const now = nowMs();
  const dnd = parseDnd(cfg.dndWindow);
  const fired = tickGroups(now, cfg, state, dnd);
  if (fired.length > 0) {
    // 气泡只有一个：同一跳里多组同时到点，固定按 water → sit → eye 挑一个说（顺序可预期，
    // 文案可测）。muted 的组不占名额——如果最前面的组被静默了，后一组照说。
    const hit = fired.find((f) => !f.muted) || fired[0];
    if (canBubble() && !hit.muted) {
      await request('bubble.say', { text: bubbleTextFor(hit.name, state) }).catch(() => {});
    }
    markDirty();
  }
  persistState();
  paint();
  pushBadge();
}

/**
 * 用户点了「歇会儿」：立即进入静默（restUntil 之前不发气泡），到点自动恢复。
 * 浮层面把请求写进 rest/request（这个键只有浮层面写），常驻帧经 storage.changed 收到；
 * 常驻帧自己（面板没开时理论上点不到，但兜底）直接改内存。
 */
async function restNow() {
  const min = Math.max(1, Math.min(480, Number(cfg.restMinutes) || 30));
  const until = nowMs() + min * 60000;
  if (isTimer()) {
    state.restUntil = until;
    markDirty();
  } else if (granted.has('storage')) {
    await request('storage.set', { key: KEY_REST, value: String(until) }).catch(() => {});
    state.restUntil = until; // 本地立刻显示；权威在常驻帧
  }
  paint();
}

// --- 徽标（常驻帧 only；只在文案变化时发） ---------------------------------------

let badgeText = null;
function pushBadge() {
  if (!ready || !isTimer() || !canBadge()) return;
  const wanted = badgeTextFor(nowMs(), state, cfg);
  if (wanted === badgeText) return; // 每分钟一跳时字符串通常没变：不白跑一趟 IPC
  badgeText = wanted;
  request('pet.badge', { text: wanted }).catch(() => {});
}

// --- 视图 ---------------------------------------------------------------------

const els = {};
function grabEls() {
  const ids = ['root', 'status', 'card', 'dnd-note', 'rest',
    'row-water', 'toggle-water', 'in-water', 'count-water',
    'row-sit', 'toggle-sit', 'in-sit', 'count-sit',
    'row-eye', 'toggle-eye', 'in-eye', 'count-eye'];
  for (const id of ids) els[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = document.getElementById(id);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

/** 重画。15 秒兜底也调它，但视图键（含分钟桶）没变时直接返回——不是每 15 秒一次的重排。 */
function paint() {
  if (!els.card) return;
  const now = nowMs();
  const dnd = parseDnd(cfg.dndWindow);
  const silent = isSilent(now, dnd, state);
  const key = [self.slot, self.kind, Math.floor(now / 60000), state.water.done, state.sit.done, state.eye.done,
    state.water.nextAt, state.sit.nextAt, state.eye.nextAt, state.restUntil, cfg.dndWindow,
    cfg.waterEnabled, cfg.sitEnabled, cfg.eyeEnabled, granted.size].join('|');
  if (key === viewKey) return;
  viewKey = key;
  if (self.slot === 'workshop') { paintWorkshop(now, silent); return; }
  if (self.kind !== 'surface') return; // 常驻帧什么都不画
  paintRows(now, silent, self.kind === 'surface' && granted.has('plugin.config') && hostServes('config.set'));
  if (els.dndNote) {
    if (silent === 'rest') { els.dndNote.hidden = false; els.dndNote.textContent = '歇会儿中，到点自动恢复'; }
    else if (silent === 'dnd') { els.dndNote.hidden = false; els.dndNote.textContent = `勿扰 ${cfg.dndWindow || '已启用'}`; }
    else { els.dndNote.hidden = true; }
  }
  if (els.rest) els.rest.hidden = !granted.has('storage');
  reportHeight();
}

/** 三行卡片（浮层面可点开关；插件页同一布局、控件禁用）。 */
function paintRows(now, silent, interactive) {
  for (const name of GROUPS) {
    const g = groupCfg(name);
    const st = state[name];
    const toggle = els[`toggle${name[0].toUpperCase()}${name.slice(1)}`];
    const left = st.nextAt ? st.nextAt - now : 0;
    if (toggle) {
      toggle.textContent = g.enabled ? '开' : '关';
      toggle.classList.toggle('off', !g.enabled);
      toggle.setAttribute('aria-pressed', String(g.enabled));
      toggle.disabled = !interactive;
    }
    const cd = els[`in${name[0].toUpperCase()}${name.slice(1)}`];
    if (cd) {
      cd.textContent = !g.enabled ? '已关' : (left <= 0 ? '就现在' : countdownText(left));
      cd.classList.toggle('muted', !g.enabled);
      cd.classList.toggle('silent', Boolean(silent) && g.enabled);
    }
    const count = els[`count${name[0].toUpperCase()}${name.slice(1)}`];
    if (count) count.textContent = `今日 ${st.done} 次`;
    const row = els[`row${name[0].toUpperCase()}${name.slice(1)}`];
    if (row) row.classList.toggle('off', !g.enabled);
  }
}

/** 插件页（workshop）：只读视图 + 状态说明。桌宠专属的事藏起来并说出口（§9）。 */
function paintWorkshop(now, silent) {
  paintRows(now, silent, false);
  if (els.rest) els.rest.hidden = true;
  if (els.dndNote) {
    els.dndNote.hidden = false;
    els.dndNote.textContent = silent === 'rest' ? '歇会儿中（桌宠那边静默）' : `勿扰 ${cfg.dndWindow || '未启用'}`;
  }
  if (els.status) {
    if (!granted.has('plugin.config') && !granted.has('storage')) els.status.textContent = '未获授权：请在安装时授权';
    else if (!canBubble()) els.status.textContent = '提醒在桌宠那边弹（控制中心不发气泡）';
    else els.status.textContent = '已就绪';
  }
}

// 浮层面的高度跟内容走（§6.5）：宿主只对声明了 maxH 的块应用 sizes，maxH=300 在 manifest 里。
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
  badgeText = null;

  if (els.root) {
    els.root.classList.remove('view-boot');
    if (self.kind === 'surface') els.root.classList.add('view-surface');
    else if (self.slot === 'background') els.root.classList.add('bg');
    else if (self.slot === 'workshop') els.root.classList.add('view-workshop');
  }

  // 未授权态先说出口（§12：granted 里没有的能力，控件禁用/隐藏，而不是点了报错）。
  if (els.status && self.slot !== 'workshop') {
    els.status.textContent = granted.size === 0 ? '未获授权：请在控制中心授权后重挂' : '已就绪';
  }

  await refreshConfig().catch(() => {});
  await loadState().catch(() => {});
  await loadRestRequest().catch(() => {});
  await subscribeEvents();

  // 挂载/重启那一刻对一次换日表（存储里的 dayKey 可能是昨天的）：04:00 一过即归零；
  // 顺便把从未排程的启用组从现在起排上（徽标与倒计时立刻有内容，不用等第一跳）。
  const now = nowMs();
  const key = dayKeyOf(now);
  let dirty = false;
  for (const name of GROUPS) {
    if (state[name].dayKey !== key) { state[name].dayKey = key; state[name].done = 0; dirty = true; }
    if (!state[name].nextAt && groupCfg(name).enabled) {
      state[name].nextAt = now + groupCfg(name).intervalMin * 60000;
      dirty = true;
    }
  }
  if (dirty) markDirty();

  if (isTimer()) startTimer();
  paint();
  pushBadge();
}

// events（config.changed）做即时反应，不轮询配置。用户改间隔/开关，下一跳就按新值走；
// 关掉开关后 tickGroups 第 1 条直接跳过——"关掉开关立即停"。
// storage.changed（自己的目录，不需要订阅）送来浮层面的"歇会儿"请求。
function onHostEvent(name, payload) {
  if (name === 'config.changed' && (!payload || payload.pluginId === PLUGIN_ID)) {
    void (async () => {
      await refreshConfig().catch(() => {});
      if (isTimer()) markDirty(); // 配置变了重落一份（间隔只在"下一次排程"时生效）
      paint();
      pushBadge();
    })();
    return;
  }
  if (name === 'storage.changed' && payload && payload.key === KEY_REST) {
    void loadRestRequest().then(() => { paint(); pushBadge(); });
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
    default: break; // surface / 未知类型：忽略是协议要求的宽容
  }
}

window.addEventListener('message', onMessage);

// 兜底拍子（§7.2 的 15 秒）：非常驻面补读一次 state（主路径是 storage.changed，这里兜丢事件）；
// 常驻帧靠它把徽标/倒计时按分钟推进一步。视图键没变时 paint 直接返回，不是高频重排。
setInterval(() => {
  if (!ready) return;
  void (async () => {
    if (!isTimer()) await loadState().catch(() => {});
    paint();
    pushBadge();
  })();
}, 15000);

grabEls();
if (els.toggleWater) els.toggleWater.addEventListener('click', () => void toggleGroup('water'));
if (els.toggleSit) els.toggleSit.addEventListener('click', () => void toggleGroup('sit'));
if (els.toggleEye) els.toggleEye.addEventListener('click', () => void toggleGroup('eye'));
if (els.rest) els.rest.addEventListener('click', () => void restNow());

/** 浮层面的开关：写 config（配置是唯一权威）。config.changed 会推回来，本帧也立刻反映。 */
async function toggleGroup(name) {
  if (self.kind !== 'surface' || !granted.has('plugin.config') || !hostServes('config.set')) return;
  const cur = groupCfg(name).enabled;
  await request('config.set', { values: { [`${name}Enabled`]: cur ? 'false' : 'true' } }).catch(() => {});
  cfg[`${name}Enabled`] = !cur;
  paint();
}

grabEls();
// **监听器装好之后**才握手：init 可能在 post 完的下一个任务就到达。
HOST.postMessage({ v: PROTOCOL, type: 'ready' }, '*');

/**
 * 测试接缝：提醒行为发生在看不见的常驻帧里。纯函数（tickGroups / isSilent / parseDnd /
 * dayKeyOf / badgeTextFor / bubbleTextFor）与"接了宿主的那些"（reminderTick / restNow /
 * toggleGroup）都从这里暴露；setClock 注入"现在"，测试不依赖真实墙钟。
 */
window.__health = Object.freeze({
  GROUPS,
  tickGroups,
  isSilent,
  parseDnd,
  minutesOf,
  dayKeyOf,
  badgeTextFor,
  bubbleTextFor,
  countdownText,
  reminderTick,
  restNow,
  toggleGroup,
  refreshConfig,
  loadState,
  setClock: (nowMsOverride) => { clock.nowMs = nowMsOverride || clock.nowMs; },
  snapshot: () => ({
    slot: self.slot,
    kind: self.kind,
    ready,
    granted: [...granted],
    cfg: JSON.parse(JSON.stringify(cfg)),
    state: JSON.parse(JSON.stringify(state)),
    hostMethods: self.hostMethods,
  }),
});
