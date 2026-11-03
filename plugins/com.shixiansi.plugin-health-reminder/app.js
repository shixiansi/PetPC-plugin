// app.js —— 接线：握手、钟、事件、以及"这个窗口到底该不该跑钟"
//
// 提醒的全部判断都在 lib/schedule.js 的纯函数里；这里只做三件事：把宿主的消息接上、
// 每 30 秒看一眼"现在离上一次说过了多久"、把该说的话说出去。
//
// 为什么是 30 秒的钟而不是 1 秒的计数器（手册 §3.9 第 4 条）：
//
//   * **不数拍子，只读钟**：判定用的是 `Date.now()` 与"上次说的时间"之差，所以机器休眠两小时
//     回来，下一拍立刻发现"早该说了"，而不是从零再数 45 分钟。
//   * 30 秒意味着一条提醒最多迟到 30 秒，而请求数是每 2 分钟一次——**而且只在真的要说/要改
//     徽标时才发请求**。1 秒轮询在这一档上换不到任何用户能看见的东西，只换到几万行日志。
//
// 谁跑钟：常驻帧（background）跑；**没授予 events 时宿主压根不会挂常驻帧**，那时这块浮层面
// 就是唯一的钟（见 isTicker）。同一时刻桌宠那一侧只有一个帧在跑钟，所以不存在一发两条。

'use strict';

/** 钟拍。30 秒是个折中：迟到不超过半分钟，而日志里每 2 分钟才可能有一条。 */
const CLOCK_MS = 30 * 1000;

let clockId = 0;
let ticking = false;
/** 上一条推给宠物的徽标：一样就不再发（纯显示的东西没必要每拍重复一次）。 */
let lastBadge = null;
/** `events.subscribe` 有没有成功。被拒时提醒照样跑，只是设置改动要等下一拍。 */
let subscribed = false;

/**
 * 这个窗口该不该跑钟。
 *
 * `background` 帧当然跑。浮层面只在**没有常驻帧**的时候跑，而"有没有常驻帧"这件事宿主的判据
 * 是"granted 里有 events / net.ws / net.fetch / plugin.call 之一"（`frontend/src/main.js`
 * 的 `backgroundPlugins`，与 Go 侧 manifest 校验同一条规则）。我们只声明了 events，所以照抄
 * 它一个条件就够——**问宿主比背一张表可靠**，而这张表恰好也是我们能问到的唯一一份。
 */
function isTicker() {
  if (view === 'background') return true;
  return view === 'surface' && !can('events');
}

function stopClock() {
  if (clockId) {
    clearInterval(clockId);
    clockId = 0;
  }
}

/**
 * 起钟。跑钟的那一面每一拍都判定；只显示的那一面（events 已授予时的浮层面、控制中心的页面）
 * 也有一台 30 秒的钟，但它**只重画倒计时、不发请求**——否则"看着它"这件事本身就变成了轮询。
 */
function startClock() {
  stopClock();
  clockId = setInterval(() => {
    if (isTicker()) void tick();
    else paint();
  }, CLOCK_MS);
}

/**
 * 一拍。
 *
 * @param {number} [nowOverride] 用例用它喂时间；生产路径上不传，取本机的钟。
 */
async function tick(nowOverride) {
  if (!isTicker() || ticking) return;
  ticking = true;
  try {
    const now = Number.isFinite(nowOverride) ? nowOverride : Date.now();
    // 没有订阅（没授予 events，或者 events.subscribe 被拒）时，设置只能自己重读：宿主不会来
    // 通知我。只在降级路径上付这一次请求，正常路径上"改了设置"是 config.changed 推过来的。
    if (!subscribed) await refreshConfig();
    const config = configOf();
    let plan = step(state, config, now, pausedAt(now));

    if (plan.fires.length) {
      // 到点之前再确认一次「今天先别提醒我」：它写在另一个键上，可能是浮层面刚刚点下的。
      // 只在**真的要说话**的这一刻读它，所以常态下这一拍一个请求都不发。
      await refreshPause();
      plan = step(state, config, now, pausedAt(now));
    }

    const changing = !sameState(plan.state, state);
    state = plan.state;
    if (changing) await writeState();

    if (plan.fires.length && can('pet.bubble') && serves('bubble.say')) {
      // 同一拍里到点的合成一句：气泡只有一个，连发两条的结果是后一条把前一条顶掉。
      const line = plan.fires.map((fire) => fire.text).join('；');
      try {
        await request('bubble.say', { text: line });
      } catch (err) {
        say('提醒没说出来：' + errorText(err));
      }
    }

    if (plan.badge !== lastBadge && can('pet.surface') && serves('pet.badge')) {
      // 先记下来再发：被拒时不重复喊同一句（日志里那会是每 2 分钟一条 WARN）。
      lastBadge = plan.badge;
      try {
        await request('pet.badge', { text: plan.badge });
      } catch (err) {
        say('徽标没写上去：' + errorText(err));
      }
    }

    paint();
  } finally {
    ticking = false;
  }
}

// --- 宿主消息 ------------------------------------------------------------------

function onResponse(data) {
  const waiter = pending.get(data.id);
  if (!waiter) return; // 迟到的 response（界面重画过）：按手册 §5.3 第 4 条安全丢弃。
  pending.delete(data.id);
  if (data.ok) waiter.resolve(data.result);
  else waiter.reject(new Error(data.error || '宿主拒绝了这次调用'));
}

function onHostEvent(data) {
  const name = String((data && data.name) || '');
  const payload = (data && data.payload) || {};
  if (name === 'config.changed') {
    void onConfigChanged(payload);
    return;
  }
  if (name === 'storage.changed') {
    void onStorageChanged(payload);
  }
}

/**
 * 设置变了（手动改表单、或者别处调 config.set）。
 *
 * 这里必须**当场**重算一拍：把某一条关掉之后，用户期待的是一句话都不再有，而不是"下一次到点
 * 才发现它关了"。"立刻停"这件事就是这一行 await。
 */
async function onConfigChanged(payload) {
  const id = payload && payload.pluginId;
  if (id && selfId && id !== selfId) return; // 桌宠按订阅广播，别人家的设置不关我事。
  await refreshConfig();
  if (isTicker()) await tick();
  else paint();
}

async function onStorageChanged(payload) {
  const key = String((payload && payload.key) || '');
  if (key === PAUSE_KEY) await refreshPause();
  else if (key === STATE_KEY) await refreshState();
  else return;
  paint();
}

function onInit(data) {
  const info = data || {};
  view = viewOf(info.surface);
  selfId = String(info.pluginId || '');
  hostMethods = info.host && Array.isArray(info.host.methods) ? info.host.methods : null;
  granted.clear();
  for (const name of info.granted || []) granted.add(name);
  applyTheme(info.theme);
  showView();
  return boot();
}

async function boot() {
  // 读三份数据：设置、今天的状态、「今天先别提醒我」。三件都缺一不可，缺哪件都只能降级。
  await refreshConfig();
  await refreshState();
  await refreshPause();

  if (view === 'workshop') {
    paint();
    startClock(); // 只重画倒计时，这一面没有宠物、不发请求。
    return;
  }
  if (view !== 'surface' && view !== 'background') return;

  // 订阅是"改了设置立刻生效"的那条路。被拒不是崩，只是慢一拍（见 workshop.js 的说明）。
  subscribed = false;
  if (can('events') && serves('events.subscribe')) {
    try {
      await request('events.subscribe', { names: ['config.changed'] });
      subscribed = true;
    } catch (err) {
      say('events.subscribe 被拒：设置在别处改动后要等下一拍（≤30 秒）才生效。' + errorText(err));
    }
  }

  if (isTicker()) {
    await tick(); // 先判一次：宿主半夜重启过的话，这一刻就该补上"早该说了"的那条。
    startClock();
  } else {
    paint();
    startClock(); // 只有倒计时。
  }
}

function onMessage(event) {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.v !== PROTOCOL) return;
  switch (data.type) {
    case 'init':
      void onInit(data).catch((err) => say('初始化失败：' + errorText(err)));
      break;
    case 'response':
      onResponse(data);
      break;
    case 'event':
      onHostEvent(data);
      break;
    case 'theme':
      applyTheme(data.theme);
      break;
    default:
      // `call` / `surface` / 未知类型：这个插件既不应答 plugin.call，也不需要长高，忽略是协议
      // 要求的宽容（宿主以后还会加消息类型）。
      break;
  }
}

// --- 启动 ---------------------------------------------------------------------

window.addEventListener('message', onMessage);
if (els.pause) els.pause.addEventListener('click', () => void onPauseToday().catch((err) => say(errorText(err))));

/** 测试接缝：钟、判定、状态都发生在看不见的那一面（和 diary-writer / media-sync 同一型）。 */
window.__health = Object.freeze({
  tick,
  startClock,
  stopClock,
  isTicker,
  paint,
  snapshot: () => ({
    view,
    selfId,
    granted: [...granted],
    subscribed,
    state: normalizeState(state),
    cfg: Object.assign({}, cfg),
    pauseDay,
    badge: lastBadge,
    clock: Boolean(clockId),
  }),
  keys: { state: STATE_KEY, pause: PAUSE_KEY },
  schedule: {
    step,
    normalizeConfig,
    normalizeState,
    dayKey,
    isQuiet,
    hhmm,
    mmhh,
    badgeText,
    sameState,
    DAY_ROLL_HOUR,
  },
});

// **监听器装好之后**才握手：init 可能在 post 完的下一个任务就到达。
postToHost({ type: 'ready' });
