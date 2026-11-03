// app.js —— 入口：宿主消息泵、plugin.call 的应答、启动接线
//
// 唯一的架构决定：**只有常驻帧跑定时器**。一个插件的每个落点都是独立文档（手册 §8.1），两面都起
// setInterval，同一天就会生成两份、冒两个气泡。浮层面只读最新一份 + 手动触发。

'use strict';

/** `plugin.call` 能问的方法。**必须与 manifest 的 `serves` 逐字相同**。 */
const CALL_HANDLERS = { report: handleReport, latest: handleLatest };

const TICK_MS = 60000;
/** init.host.methods。旧宿主没有这个字段 → null，退化用 slot 判断（手册 §5.2.1）。 */
let hostMethods = null;
let role = 'background';
let tickTimer = null;
let busy = false;

function onResponse(data) {
  const waiter = pending.get(data.id);
  if (!waiter) return;   // 迟到的回包（界面已经重画过）安全丢弃
  pending.delete(data.id);
  if (data.ok) waiter.resolve(data.result);
  else waiter.reject(new Error(data.error || '插件请求失败'));
}

/** 答一次 plugin.call。三种结局都要回 call-result——包括「我不认识这个方法」。 */
async function onCall(data) {
  const ticket = typeof data.ticket === 'string' ? data.ticket : '';
  if (!ticket) return;
  const method = typeof data.method === 'string' ? data.method : '';
  const handler = CALL_HANDLERS[method];
  if (!handler) {
    postCallResult(ticket, false, new Error(
      `周报不认识方法 ${method || '(空)'}：它只回答 ${Object.keys(CALL_HANDLERS).join(' / ')}`));
    return;
  }
  try {
    postCallResult(ticket, true, await handler(data.payload === undefined ? {} : data.payload));
  } catch (err) {
    postCallResult(ticket, false, err);
  }
}

/** `plugin.call` 的 report：现在生成一份并回。三个来源并行问，宿主 30 秒的上限够用（手册 §6.8）。 */
async function handleReport() {
  if (!granted.has('plugin.call')) throw new Error('未获权限 plugin.call：周报要问待办、番茄钟和日记');
  const record = await generateReport();
  if (role === 'card') renderCard(record);
  return publicReport(record);
}

/** `plugin.call` 的 latest：回上一次的。**从没生成过就回空**，那不是错误。 */
async function handleLatest() {
  const record = await readLatest();
  if (!record || !record.text) return { text: '', at: 0 };
  return publicReport(record);
}

/** 回给别的插件的形状：正文、时刻、周区间、缺块清单、三个数。 */
function publicReport(record) {
  const { day, at, weekStart, weekEnd, title, text, source, summary } = record;
  return {
    day, at, weekStart, weekEnd, title, text, source, summary,
    missing: record.missing || [],
    numbers: record.numbers || {},
  };
}

/** 这个窗口服务不服务某个方法。有 init.host 就问它，没有才退化到 slot（手册 §5.2.1）。 */
function serves(method) {
  if (Array.isArray(hostMethods)) return hostMethods.includes(method);
  return role !== 'workshop';
}

/**
 * 从 init.surface 认出这一面：用 `slot` 而不是 `kind`（常驻帧与面板的 kind 都是 'panel'）。
 * 浮层面那一块是唯一例外——它的 slot 是空串，只能靠 kind === 'surface' 认出来。认不出的挂载
 * 按常驻帧处理：它唯一安全的行为就是按时判定。
 */
function roleOf(surface) {
  const s = surface && typeof surface === 'object' ? surface : {};
  if (s.slot === 'workshop') return 'workshop';
  if (s.kind === 'surface') return 'card';
  return 'background';
}

async function onInit(payload) {
  role = roleOf(payload.surface);
  hostMethods = payload.host && Array.isArray(payload.host.methods) ? payload.host.methods : null;
  self = { pluginId: payload.pluginId || '', role, slot: (payload.surface && payload.surface.slot) || '' };
  granted.clear();
  for (const name of payload.granted || []) granted.add(name);
  applyTheme(payload.theme);
  ready = true;
  showFace(role);
  await refreshConfig();

  if (role === 'workshop') {
    // 控制中心不服务 plugin.call（手册 §9）：按钮禁用 + 一行"这件事在桌宠上"，只读的照常画。
    if (els.makeNow) {
      els.makeNow.disabled = !(serves('plugin.call') && granted.has('plugin.call'));
      els.makeNow.textContent = '现在生成一份';
    }
    renderWorkshop(await readLatest());
    return;
  }

  if (role === 'card') {
    if (els.cardNow) els.cardNow.disabled = !(serves('plugin.call') && granted.has('plugin.call'));
    renderCard(await readLatest());
    return;
  }

  if (granted.has('events')) {
    try {
      await request('events.subscribe', { names: ['config.changed'] });
    } catch {
      // 订阅不上只影响"改了设置立刻生效"，下一拍照样读到新配置。
    }
  }
  lastReportDay = await readLastReportDay();
  startMinuteTimer();
  // 启动补一次：宿主半夜重启、用户 20:05 才开机都靠这一拍补上（去重由 lastReportDay 负责）。
  void weeklyTick().catch(() => {});
}

/** 事件：配置变了重新判定；别的文档写了我们的键就把界面刷新过来（不轮询，手册 §7）。 */
function onEvent(data) {
  const name = typeof data.name === 'string' ? data.name : '';
  const payload = data.payload && typeof data.payload === 'object' ? data.payload : {};
  if (name === 'config.changed') {
    if (payload.pluginId && payload.pluginId !== self.pluginId) return;
    void refreshConfig().then(() => weeklyTick()).catch(() => {});
    return;
  }
  if (name !== 'storage.changed') return;
  if (payload.key === KEY_LATEST || payload.key === KEY_LAST_DAY) void syncFromStorage().catch(() => {});
}

/**
 * 一个文档写的键，另一个文档要看见：常驻帧 20:00 生成的那一份，卡片是**另一个文档**，它手里那份
 * record 是挂载时读的。没有这一条，用户点开卡片看到的还是上一次的数字。
 */
async function syncFromStorage() {
  const day = await readLastReportDay();
  // 只往上抬：不用一次读失败把进程内那条去重记录抹掉（那会让同一天多生成一份）。
  if (day) lastReportDay = day;
  const record = await readLatest();
  if (role === 'card') renderCard(record);
  if (role === 'workshop') renderWorkshop(record);
}

/** 每分钟看一次钟。钟表类定时器是唯一允许的 1 分钟节拍（手册 §3.9 第 4 条）。 */
function startMinuteTimer() {
  stopMinuteTimer();
  tickTimer = setInterval(() => { void weeklyTick().catch(() => {}); }, TICK_MS);
}

function stopMinuteTimer() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

/**
 * 到点判定 + 生成 + 通知。**同一天只做一次**，这就是「20:00 只触发一次」的全部实现：
 * `dueNow` 回答"这一刻过了没有"（过了一直为真，所以重启能补），`lastReportDay` 回答"今天有过了"。
 */
async function weeklyTick() {
  const hit = dueNow(now(), weekdayOf(cfg.reportWeekday), cfg.reportTime);
  if (!hit.due) return null;
  if (lastReportDay === hit.day) return null;
  const record = await generateReport();
  if (granted.has('pet.bubble')) {
    try {
      await request('bubble.say', { text: bubbleLine(record) });
    } catch {
      // 气泡不是关键路径：周报已经存好了。
    }
  }
  // 然后开卡片。**顺序是刻意的**：气泡与浮层面共用宠物旁边那一格，后打开的留下（手册 §3.2），
  // 所以用户最后看到的是三个数与结论，气泡只是响了一声。这一份周报的产品就是那三个数。
  if (granted.has('pet.surface') && serves('surface.show')) {
    try {
      await request('surface.show', {});
    } catch {
      // 打不开（被折叠、没有矩形）不影响周报本身。
    }
  }
  if (role === 'card') renderCard(record);
  return record;
}

/** 气泡只有一句话的地方：两个数 + 缺了哪块。 */
function bubbleLine(record) {
  const n = (record && record.numbers) || {};
  const bits = [];
  if (n.todoRate !== null && n.todoRate !== undefined) bits.push(`待办完成率 ${n.todoRate}%`);
  if (n.focusMinutes !== null && n.focusMinutes !== undefined) bits.push(`专注 ${n.focusMinutes} 分钟`);
  const missing = record && Array.isArray(record.missing) ? record.missing : [];
  const tail = missing.length ? `（缺${missing.map((miss) => miss.label).join('、')}）` : '';
  return clip(`周报好了：${bits.length ? bits.join('，') : '这一周'}${tail}`, 60);
}

function setBusy(on) {
  if (!els.cardNow) return;
  els.cardNow.disabled = on || !(serves('plugin.call') && granted.has('plugin.call'));
  els.cardNow.textContent = on ? '生成中…' : '生成';
}

/** 卡片上那个「生成」。同一时刻只允许一次（连点两下不该问两轮三个插件）。 */
async function runNow() {
  if (busy) return;
  if (!(serves('plugin.call') && granted.has('plugin.call'))) {
    say('未获授权 plugin.call：周报要问待办、番茄钟和日记');
    return;
  }
  busy = true;
  setBusy(true);
  say('正在问三个插件…');
  try {
    const record = await generateReport();
    if (role === 'workshop') {
      renderWorkshop(record);
      say('生成好了。');
    } else {
      renderCard(record);
    }
  } catch (err) {
    say(clip(msgOf(err), 120));
  } finally {
    busy = false;
    setBusy(false);
  }
}

function onMessage(event) {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.v !== PROTOCOL) return;
  switch (data.type) {
    case 'init': void onInit(data).catch((err) => say(clip(msgOf(err), 120))); break;
    case 'theme': applyTheme(data.theme); break;
    case 'response': onResponse(data); break;
    case 'event': onEvent(data); break;
    case 'call': void onCall(data); break;
    default: break;   // `surface` 与未来新增的 type：协议要求宽容地忽略。
  }
}

window.addEventListener('message', onMessage);
if (els.cardNow) els.cardNow.addEventListener('click', () => void runNow());
if (els.makeNow) els.makeNow.addEventListener('click', () => void runNow());

// **监听器装好之后**才握手：init 可能在 post 完的下一个任务就到达。
postToHost({ type: 'ready' });

/** 测试接缝：纯函数与"看不见的那一面"都要能被直接驱动。 */
window.__weekly = Object.freeze({
  generateReport, weeklyTick, handleReport, handleLatest, runNow,
  startMinuteTimer, stopMinuteTimer, refreshConfig,
  renderCard, renderWorkshop, syncFromStorage, bubbleLine, publicReport,
  week: { dayKeyOf, shortDate, weekRangeOf, weekLabel, dayInRange, parseClock, weekdayOf, dueNow },
  collect: { collectWeek, askSource, classifyError, missingLine, readTodoStats, readFocusStats, readDiaryRecent, SOURCES },
  report: {
    buildMaterial, buildPrompt, parseReportText, templateReport, conclusionOf, draftReport, composeReport,
    readLatest, readLastReportDay, REPORT_MAX, MATERIAL_BUDGET, KEY_LATEST, KEY_LAST_DAY,
  },
  snapshot: () => ({
    role, ready, granted: [...granted], cfg: { ...cfg }, lastReportDay,
    hostMethods: hostMethods ? [...hostMethods] : null,
  }),
});
