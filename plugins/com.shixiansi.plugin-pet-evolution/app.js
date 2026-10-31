// app.js —— 桌宠进化：入口、协议泵、经验来源接线、plugin.call 应答
//
// 一个文档，两种身份：
//
//   workshop    控制中心插件页：成长总览、属性分配、喂食玩耍、外观、重置。
//   background  桌宠常驻帧：答别的插件的 grant_exp / profile；经 memcore 的聊天
//               由聊天插件发奖（callTargets 留给订阅型来源），本地事件自动记经验。
//
// 经验来源（谁写）：
//   - 喂食/玩耍（本地按钮，体力消耗计次）
//   - 其他插件经 plugin.call 的 grant_exp（聊天 +12、完成任务 +25，来源插件自己报）
//   - 番茄钟一段专注结束（订阅 pomodoro 插件发布的 share 键）+30
//
// 写者唯一：profile 只被本文件写（手册 §6.3），workshop 与 background 都经这里。

'use strict';

const V = 1;
const HOST = window.parent;
let nextId = 1;
const pending = new Map();

const PERM = {
  storage: 'storage',
  config: 'plugin.config',
  call: 'plugin.call',
  share: 'plugin.share',
  surface: 'pet.surface',
  bubble: 'pet.bubble',
  events: 'events',
};

const PROFILE_KEY = 'profile-v2';

/**
 * 这个窗口服务不服务某个方法（`init.host.methods`，手册 §5.2.1）。
 *
 * 控制中心挂这一页时不服务 `bubble.say`——按 slot 猜会猜错，而猜错的代价是每次升级都留一条
 * 「不支持该方法」的 WARN（2026-10-31 的真机日志里就是这么来的）。
 */
function hostHas(method) {
  return !!(self && self.host && Array.isArray(self.host.methods) && self.host.methods.includes(method));
}
const POMODORO_SHARE = { owner: 'com.shixiansi.plugin-pomodoro', name: 'phase-ended' };
const POMODORO_REWARD = 30;

function request(method, payload) {
  const id = `r${nextId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    HOST.postMessage({ v: V, type: 'request', id, method, payload: payload ?? {} }, '*');
  });
}

let granted = new Set();
let self = { pluginId: '', slot: '' };
let cfg = {};
let profile = EvolutionEngine.makeProfile();
let interactionsThisHour = { hour: -1, count: 0 };
let lastPhaseAt = 0;
let pollGen = 0;

window.addEventListener('message', (event) => {
  if (event.source !== HOST) return;
  const data = event.data;
  if (!data || data.v !== V) return;
  switch (data.type) {
    case 'init':
      void onInit(data);
      break;
    case 'response': {
      const slot = pending.get(data.id);
      if (!slot) return;
      pending.delete(data.id);
      if (data.ok) slot.resolve(data.result);
      else slot.reject(new Error(data.error || '宿主拒绝了这次调用'));
      break;
    }
    case 'theme':
      document.documentElement.dataset.theme = data.theme === 'light' ? 'light' : 'dark';
      break;
    case 'call':
      void onCall(data);
      break;
    case 'event':
      // 共享键变了：番茄钟刚结束一段就立刻去读（手册 §7.1），不等 60 秒兜底。
      if (data.name === 'share.changed') void checkPomodoroPhase().catch(() => {});
      break;
    default:
      break;
  }
});

// --- 存取 ------------------------------------------------------------------------

async function loadProfile() {
  if (!granted.has(PERM.storage)) return;
  try {
    const out = await request('storage.get', { key: PROFILE_KEY });
    if (out && out.value) profile = EvolutionEngine.migrateProfile(JSON.parse(out.value));
  } catch {
    profile = EvolutionEngine.makeProfile(); // 坏档重建（不覆盖旧档：下面 persist 才写）
  }
}

async function persistProfile() {
  if (!granted.has(PERM.storage)) return;
  try {
    await request('storage.set', { key: PROFILE_KEY, value: JSON.stringify(profile) });
  } catch {
    // 存不下：内存里继续（下次再试）。
  }
}

/** 统一的经验入口：结算 → 存档 → 升级后的动作（气泡/发布）。返回结算结果。 */
async function grantAndPersist(amount, reason) {
  const result = EvolutionEngine.grantExp(profile, amount, { now: Date.now() });
  const leveledUp = result.gained.levels > 0;
  profile = result.profile;
  if (leveledUp) profile.mood = 'levelup';
  await persistProfile();
  if (leveledUp && granted.has(PERM.bubble) && hostHas('bubble.say')) {
    request('bubble.say', {
      text: result.capped
        ? `我到满级啦！（${reason ? reason + '，' : ''}好感 +2）`
        : `升级！现在 ${profile.level} 级（${reason || '获得经验'}），属性点 +${result.gained.levels * 3}`,
    }).catch(() => {});
  }
  if (granted.has(PERM.share)) {
    request('share.set', {
      name: 'evolution-state',
      value: JSON.stringify({ at: Date.now(), level: profile.level, mood: profile.mood, friendship: profile.friendship }),
    }).catch(() => {});
  }
  if (self.slot === 'workshop') renderWorkshop();
  return result;
}

// --- 互动（本地经验来源） ----------------------------------------------------------

/** 每小时互动上限（体力属性决定）。 */
function interactionBudget() {
  const fx = EvolutionEngine.statEffects(profile);
  return fx.interactionsPerHour;
}

function interactionsLeft() {
  const hour = new Date().getHours();
  if (interactionsThisHour.hour !== hour) {
    interactionsThisHour = { hour, count: 0 };
  }
  return Math.max(0, interactionBudget() - interactionsThisHour.count);
}

async function doInteraction(kind) {
  if (kind === 'feed' && !granted.has(PERM.storage)) {
    EvolutionWorkshop.ewsSetStatus('未授予 storage：互动记不了档', 'danger');
    return;
  }
  const left = interactionsLeft();
  if (left <= 0) {
    EvolutionWorkshop.ewsSetStatus(`这小时的互动次数用完了（体力 ${profile.stats.stamina} → 每小时 ${interactionBudget()} 次），下个整点再来`, 'danger');
    return;
  }
  interactionsThisHour.count += 1;
  const amount = kind === 'feed' ? 8 : 5;
  const result = await grantAndPersist(amount, kind === 'feed' ? '喂食' : '玩耍');
  profile.counters[kind === 'feed' ? 'feeds' : 'plays'] += 1;
  if (profile.mood !== 'levelup') profile.mood = kind === 'feed' ? 'happy' : 'excited';
  await persistProfile();
  if (self.slot === 'workshop') {
    EvolutionWorkshop.ewsSetStatus(
      `${kind === 'feed' ? '喂食' : '玩耍'}完成：经验 +${amount}${result.gained.levels ? `，升了 ${result.gained.levels} 级！` : ''}（这小时还剩 ${interactionsLeft() - 1} 次）`);
    renderWorkshop();
  }
  return result;
}

// --- 番茄钟联动（share 轮询） ------------------------------------------------------

async function checkPomodoroPhase() {
  if (!granted.has(PERM.share)) return;
  try {
    const out = await request('share.get', { owner: POMODORO_SHARE.owner, name: POMODORO_SHARE.name });
    if (!out || !out.value || !out.at) return;
    if (out.at === lastPhaseAt) return;
    lastPhaseAt = out.at;
    let phase = '';
    try { phase = String(JSON.parse(out.value).phase || ''); } catch { phase = ''; }
    if (phase === 'focus') {
      await grantAndPersist(POMODORO_REWARD, '一段专注结束');
    }
  } catch {
    // 没装番茄钟/没授予：静默。
  }
}

function startShareWatch() {
  const gen = ++pollGen;
  const tick = async () => {
    if (gen !== pollGen) return;
    await checkPomodoroPhase().catch(() => {});
    // 60 秒兜底：宿主会为 share.changed 发事件（手册 §7.1），番茄钟的 phase-ended
    // 一变就立刻到，这个定时器只负责"事件丢了"。以前 5 秒一拍。
    if (gen === pollGen) setTimeout(tick, 60000);
  };
  tick();
}

// --- plugin.call ----------------------------------------------------------------

const CALL_HANDLERS = {
  /** 发经验。payload {amount, reason} → {levels, level, capped, overflow} */
  grant_exp: async (payload) => {
    const amount = Number(payload && payload.amount) || 0;
    if (amount <= 0) throw new Error('grant_exp 需要 {amount > 0}');
    const cappedAmount = Math.min(amount, 100000); // 单次发奖上限（防恶意调用方）
    const result = await grantAndPersist(cappedAmount, String(payload && payload.reason || '外部奖励'));
    return { levels: result.gained.levels, level: profile.level, capped: result.capped, overflow: result.overflow };
  },
  /** 当前档案（只读快照）。 */
  profile: async () => ({
    name: profile.name,
    level: profile.level,
    exp: profile.exp,
    expToNext: EvolutionEngine.expToNext(profile.level),
    stats: { ...profile.stats },
    statPoints: profile.statPoints,
    friendship: profile.friendship,
    mood: profile.mood,
    unlocked: [...profile.unlocked],
    effects: EvolutionEngine.statEffects(profile),
  }),
  /** 重置属性。 */
  respec: async () => {
    const out = EvolutionEngine.respecStats(profile);
    profile = out.profile;
    await persistProfile();
    if (self.slot === 'workshop') renderWorkshop();
    return { returned: out.returned, statPoints: profile.statPoints };
  },
};

async function onCall(data) {
  const ticket = typeof data.ticket === 'string' ? data.ticket : '';
  if (!ticket) return;
  const method = typeof data.method === 'string' ? data.method : '';
  const handler = CALL_HANDLERS[method];
  if (!handler) {
    postCallResult(ticket, false, new Error(
      `养成面板不认识方法 ${method || '(空)'}：它只回答 ${Object.keys(CALL_HANDLERS).join(' / ')}`));
    return;
  }
  try {
    postCallResult(ticket, true, await handler(data.payload === undefined ? {} : data.payload));
  } catch (err) {
    postCallResult(ticket, false, err);
  }
}

function postCallResult(ticket, ok, value) {
  const message = { v: V, type: 'call-result', ticket, ok: Boolean(ok) };
  if (ok) message.result = value === undefined ? null : value;
  else message.error = String(value && value.message ? value.message : value);
  HOST.postMessage(message, '*');
}

// --- 工坊页 ---------------------------------------------------------------------

function renderWorkshop() {
  if (self.slot !== 'workshop') return;
  EvolutionWorkshop.ewsRenderProfile(profile);
}

function doAllocate(stat, points) {
  const out = EvolutionEngine.allocateStat(profile, stat, points);
  if (!out.ok) {
    EvolutionWorkshop.ewsSetStatus(out.error, 'danger');
    return;
  }
  profile = out.profile;
  void persistProfile();
  renderWorkshop();
  EvolutionWorkshop.ewsSetStatus(points > 0 ? `${EvolutionWorkshop.STAT_LABELS[stat]} +${points}` : `${EvolutionWorkshop.STAT_LABELS[stat]} 洗回 ${points}`);
}

async function doRespec() {
  const out = EvolutionEngine.respecStats(profile);
  profile = out.profile;
  await persistProfile();
  renderWorkshop();
  EvolutionWorkshop.ewsSetStatus(`属性已重置：退回 ${out.returned} 点`);
}

async function onInit(data) {
  self = {
    pluginId: data.pluginId || '',
    slot: (data.surface && data.surface.slot) || '',
    // 宿主能力表（init.host = {program, methods}）：这个窗口服务不服务 bubble.say 只有这一份答案。
    host: data.host && Array.isArray(data.host.methods) ? data.host : null,
  };
  granted.clear();
  for (const name of data.granted || []) granted.add(name);
  document.documentElement.dataset.theme = data.theme === 'light' ? 'light' : 'dark';

  if (granted.has(PERM.config)) {
    try {
      const out = await request('config.get', {});
      cfg = Object.assign({}, (out && out.values) || {});
    } catch { cfg = {}; }
  }

  await loadProfile();

  if (granted.has(PERM.share)) startShareWatch();

  if (self.slot !== 'workshop') return;

  EvolutionWorkshop.ewsCollectEls();
  EvolutionWorkshop.ewsSetAllocateHandler(doAllocate);
  EvolutionWorkshop.ewsRenderProfile(profile);
  EvolutionWorkshop.ewsRenderProfile(profile); // 双画一次：SVG innerHTML 在部分时序下需要
  EvolutionWorkshop.EWS.els.feed?.addEventListener('click', () => void doInteraction('feed'));
  EvolutionWorkshop.EWS.els.play?.addEventListener('click', () => void doInteraction('play'));
  EvolutionWorkshop.EWS.els.respec?.addEventListener('click', () => void doRespec());
}

HOST.postMessage({ v: V, type: 'ready' }, '*');

/** 测试接缝。 */
window.__evolution = Object.freeze({
  request,
  handlers: CALL_HANDLERS,
  grantAndPersist,
  doInteraction,
  doAllocate,
  doRespec,
  checkPomodoroPhase,
  engine: EvolutionEngine,
  workshop: EvolutionWorkshop,
  snapshot: () => ({
    slot: self.slot,
    granted: [...granted],
    profile,
    interactionsLeft: interactionsLeft(),
    lastPhaseAt,
  }),
});
