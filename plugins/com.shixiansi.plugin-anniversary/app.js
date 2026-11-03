// app.js —— 握手、三副面孔的分派、常驻帧的时钟、plugin.call 的应答
//
// 谁干什么：background（常驻无名帧）算"还有几天"、推 pet.badge、当天说一句、把卡片摊开、答
// plugin.call 的 next——要"用户没看着也在办"的只有它；surface 只读清单画最近三条；workshop 是
// 控制中心那一页（完整清单 + 加/删），没有宠物，不碰气泡与浮层面。
//
// 为什么徽标与那句气泡**只由常驻帧推**：一个数据一个写者（手册 6.3）。三个文档同时写徽标，头顶就
// 成了"谁最后说话算谁的"；而"当天只弹一次"一旦有两个写者就必然弹两次。

'use strict';

/** plugin.call 能问的方法。**必须与 manifest 的 serves 逐字相同**：写了没实现，调用方等 30 秒超时。 */
const CALL_HANDLERS = { next: serveNext };

// 「当天说一句」的记账：内存挡同一进程内的重复，storage 挡重启之后的重复。
let seenDay = '';
let lastBadge = null; // 上一次推给宿主的徽标文字（null = 还没推过）
let cardOpened = false;
let cardTimer = 0;
let timersStarted = false;
let initSeen = false;

// 钟表类定时器（手册 §3.9 的例外：跨过零点的判定本身就是功能）：30 秒那一档只读内存，
// 10 分钟那一档是"storage.changed 丢了"的兜底。
const MIDNIGHT_TICK_MS = 30000;
const FALLBACK_MS = 600000;
// 气泡与浮层面共用宠物旁边那个位置，同一时刻只能有一个（手册 §8.2b）。所以当天那句话先说，
// 一分钟后再把卡片摆上——用户读完气泡，卡片刚好接上。
const CARD_DELAY_MS = 60000;

// --- 宿主消息泵 ---------------------------------------------------------------

function onResponse(data) {
  const waiter = pending.get(data.id);
  if (!waiter) return; // 过期或未知的 id：丢掉，不要报错
  pending.delete(data.id);
  if (data.ok) waiter.resolve(data.result);
  else waiter.reject(new Error(data.error || '宿主拒绝了这次调用'));
}

async function onEvent(data) {
  // 另一面（或另一个程序里的同一面）刚写完清单：立刻重读，别等 10 分钟的兜底。
  if (String((data && data.name) || '') !== 'storage.changed') return;
  if (mountInfo.slot === 'background') {
    await backgroundRefresh(); // 它自己会重读清单、重算、再决定推不推徽标
    return;
  }
  await refreshData();
  paint();
}

/** 答一次 plugin.call。三种结局都要回一条 call-result——包括「我不认识这个方法」。 */
async function onCall(data) {
  const ticket = typeof data.ticket === 'string' ? data.ticket : '';
  if (!ticket) return;
  const method = String(data.method || '');
  const handler = CALL_HANDLERS[method];
  if (!handler) {
    const only = Object.keys(CALL_HANDLERS).join(' / ');
    postCallResult(ticket, false, new Error('纪念日倒计时不认识方法 ' + (method || '(空)') + '：它只回答 ' + only));
    return;
  }
  try {
    postCallResult(ticket, true, await handler(data.payload === undefined ? {} : data.payload));
  } catch (err) {
    postCallResult(ticket, false, err);
  }
}

function onMessage(event) {
  // 只认父窗口；只认本协议版本（别的窗口、未来的 v 都忽略）。
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.v !== PROTOCOL) return;
  switch (data.type) {
    case 'init':
      if (initSeen) return; // 同一个文档只握手一次
      initSeen = true;
      void onInit(data).catch((err) => {
        textOf(els.wsStatus, '初始化失败：' + errorText(err));
        textOf(els.sfEmpty, '初始化失败：' + errorText(err));
      });
      break;
    case 'response':
      onResponse(data);
      break;
    case 'theme':
      applyTheme(data.theme);
      break;
    case 'event':
      void onEvent(data);
      break;
    case 'call':
      void onCall(data);
      break;
    case 'surface':
      // 浮层面被夹回或长高之后宿主要重新告诉我矩形：重画一次就够。
      if (data.rect) mountInfo.rect = data.rect;
      paint();
      break;
    default:
      break;
  }
}

// --- 启动 ---------------------------------------------------------------------

async function onInit(data) {
  for (const name of data.granted || []) granted.add(name);
  const surface = data.surface || {};
  const host = data.host || null;
  hostMethods = host && Array.isArray(host.methods) ? host.methods.slice() : null;

  const kind = String(surface.kind || 'panel');
  mountInfo.kind = kind;
  // 浮层面的 kind 是 'surface' 而**没有 slot**；常驻帧的 kind 是 'panel'、slot 是 'background'。
  mountInfo.slot = String(surface.slot || (kind === 'surface' ? 'surface' : 'panel'));
  mountInfo.rect = surface.rect || null;
  mountInfo.rectIndex = Number(surface.rectIndex) || 0;
  mountInfo.rectCount = Number(surface.rectCount) || 1;
  if (data.theme) applyTheme(data.theme);

  show(els.boot, false);
  show(els.surfaceCard, isSurfaceMount());
  show(els.workshop, mountInfo.slot === 'workshop');
  // data-view 是给 CSS 用的（body[data-view='surface'] 会关掉那句 boot 文案）：同样按 kind 判，
  // 因为浮层面可能带着一个面板槽名过来（见 lib/core.js 的 isSurfaceMount）。
  if (els.body) els.body.dataset.view = isSurfaceMount() ? 'surface' : (mountInfo.slot || 'panel');

  if (mountInfo.slot === 'background') {
    // 常驻帧没有像素：它的"界面"是头顶那一行、那句气泡、以及卡片开不开。
    await backgroundRefresh();
    startBackgroundTimers();
    return;
  }
  await refreshData();
  paint();
}

function startBackgroundTimers() {
  if (timersStarted) return;
  timersStarted = true;

  // 跨过本地零点：徽标与"今天"都要换。**只读内存**——日期一天才变一次，拍子里读盘就是手册 §7
  // 说的那种轮询，而这条路径上没有任何宿主事件可听。10 分钟那一档是"事件丢了"的兜底。
  let lastDay = Dates.todayISO(new Date());
  setInterval(() => {
    const day = Dates.todayISO(new Date());
    if (day === lastDay) return;
    lastDay = day;
    void backgroundRefresh();
  }, MIDNIGHT_TICK_MS);
  setInterval(() => {
    void backgroundRefresh();
  }, FALLBACK_MS);
}

// --- 常驻帧：徽标、那句话、卡片 -------------------------------------------------

/** 一次完整的重算。**不许抛**：它跑在定时器里，漏出去的异常就是一条 unhandledrejection。 */
async function backgroundRefresh() {
  await refreshData();
  await loadSeen();
  await pushBadge();
  await maybeSpeak();
}

async function loadSeen() {
  if (!can('storage')) return;
  const raw = await readKey(KEY_SEEN, '');
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    const day = parsed && typeof parsed.day === 'string' ? parsed.day : '';
    if (day) seenDay = day;
  } catch {
    // 记号坏了就当没说过：多说一句比一句都不说好。
  }
}

/**
 * 把最近那一个（或条数）写到宠物头顶。一个**空清单不发出任何 pet.badge 请求**：没有徽标可画。
 * 只有"上一次推过非空的文字"才需要一条空串去清除（空串语义就是清除，手册 6.5）——否则删光清单
 * 之后头顶会留着一行旧字。
 */
async function pushBadge() {
  if (!can('pet.surface') || !serves('pet.badge')) return;
  const mode = cfgText('badgeMode', 'nearest');
  const text = Agenda.badgeText(state.agenda, mode, cfgNum('advanceDays', 0, 3650, 30));
  if (text === lastBadge) return;
  if (!text && lastBadge === null) return;
  // 先记住再发：被拒（撤了授权、桌宠藏着）也算推过。不然每一拍都去撞同一道墙，日志里全是同一条
  // WARN，而头顶那一行并不会因此出现。
  lastBadge = text;
  try {
    await request('pet.badge', { text });
  } catch {
    // 下一次文字变了还会再试，那时用户很可能已经补上授权了。
  }
}

/**
 * 当天说一句。**一天只说一次**，跨重启也一样（记号落在 storage 里）。没有 storage 就不说：那种
 * 情况下"只一次"根本保证不了，而一个每次重算都弹的气泡比不说话更糟。
 */
async function maybeSpeak() {
  if (!can('pet.bubble') || !serves('bubble.say')) return;
  if (!cfgBool('sayOnDay', true)) return;
  const text = Agenda.bubbleText(state.agenda);
  if (!text) return;
  if (!can('storage')) return;
  const day = Dates.todayISO(new Date());
  if (seenDay === day) return;
  seenDay = day; // 先记：被拒也算说过（否则会每次重算都弹一次）
  await writeKey(KEY_SEEN, JSON.stringify({ day }));
  try {
    await request('bubble.say', { text });
  } catch {
    // 被拒（桌宠藏着、用户撤了 pet.bubble）：那一天就不再试。
  }
  scheduleCard();
}

/** 说完那句之后，把卡片摆出来一次。 */
function scheduleCard() {
  if (cardOpened || cardTimer) return;
  if (!can('pet.surface') || !serves('surface.show')) return;
  cardTimer = setTimeout(() => {
    cardTimer = 0;
    void openCard();
  }, CARD_DELAY_MS);
}

async function openCard() {
  if (cardOpened) return;
  cardOpened = true;
  try {
    await request('surface.show', {});
  } catch {
    cardOpened = false; // 打不开（桌宠藏着）：下一次"当天"还有机会
  }
}

// --- plugin.call 的 next --------------------------------------------------------

function rowPayload(row) {
  const { name, date, days, remaining, yearly, text } = row;
  return { name, date, days, remaining, yearly, text };
}

/**
 * 下一个纪念日在哪、还有多久。形状钉在 README 里：
 * `{items, nearest, count, today, updatedAt}`，每行 `{name, date, days, remaining, yearly, text}`；
 * nearest 是"下一个还没过去的"，一个都没有时是 null。
 */
async function serveNext() {
  if (!state.agenda) await refreshData();
  const agenda = state.agenda || Agenda.build([], Dates.todayISO(new Date()));
  return {
    items: agenda.items.map(rowPayload),
    nearest: agenda.nearest ? rowPayload(agenda.nearest) : null,
    count: agenda.total,
    today: agenda.today,
    updatedAt: Date.now(),
  };
}

// **监听器装好之后**才握手：init 可能在你 post 完的下一个任务就到达。
window.addEventListener('message', onMessage);
postToHost({ type: 'ready' });
