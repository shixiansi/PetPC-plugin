// app.js —— 握手与三个角色的接线。
//
// 三副面孔由 init.surface 决定（不猜）：
//
//   page   slot === 'workshop'     → 控制中心的插件页（lib/view.js 的 renderPage）
//   card   kind === 'surface'      → 宠物旁边 280×140 的卡片（renderCard）
//   bg     slot === 'background'   → 常驻帧：头顶那行字 + 到点提醒，什么都不画
//
// 一个 entry 同时在三个窗口里跑，所以这里只做接线：真正的规则在 lib/habits.js（纯函数），
// 读写那一格在 lib/store.js，画在 lib/view.js。

'use strict';

const V = 1;
const HOST = window.parent;
/** 钟表定时器：30 秒看一次"到点了吗"。提醒本身由 lastRemindDay 去重，所以这个间隔只是响应速度。 */
const BG_TICK_MS = 30 * 1000;

let timer = null;
let subscribed = false;

window.addEventListener('message', (event) => {
  // 只认父窗口；只认本协议版本。
  if (event.source !== HOST) return;
  const data = event.data;
  if (!data || data.v !== V) return;

  switch (data.type) {
    case 'init':
      void onInit(data);
      break;
    case 'response': {
      const slot = pending.get(data.id);
      if (!slot) return; // 过期或未知的 id：丢掉，不要报错
      pending.delete(data.id);
      if (data.ok) slot.resolve(data.result);
      else slot.reject(new Error(data.error || '宿主拒绝了这次调用'));
      break;
    }
    case 'theme':
      // 控制中心里用户切换了深/浅色。
      applyTheme(data.theme);
      break;
    case 'call':
      answerCall(data.ticket, data.method, data.payload);
      break;
    case 'event':
      onHostEvent(data);
      break;
    default:
      // 宿主以后会加消息类型；不认识的忽略掉（surface 消息也只有浮层面用得上，这里不关心）。
      break;
  }
});

/** 对一条 plugin.call 的唯一回法：ticket 原样带回，成功给 result、失败给中文 error。 */
function answerCall(ticket, method, payload) {
  Promise.resolve()
    .then(() => serveAnswer(String(method || ''), payload || {}))
    .then((value) => postCallResult(ticket, true, value))
    .catch((err) => postCallResult(ticket, false, (err && err.message) || err));
}

/**
 * 宿主推来的两条事件。
 *
 * 两条都是**推**而不是轮询：`config.changed` 让提醒时刻改完就生效（常驻帧一直挂着，用户改完
 * 设置不会重挂它），`storage.changed` 让"另一个文档刚打了卡"立刻反映到这一面。后者不需要
 * `events.subscribe`——那是自己的私有目录，`storage` 授权已经覆盖了。
 */
function onHostEvent(data) {
  const name = String((data && data.name) || '');
  const payload = (data && data.payload) || {};
  if (name === 'config.changed') {
    if (payload.pluginId && pluginId && payload.pluginId !== pluginId) return;
    void refreshConfig().then(() => {
      renderAll();
      pushBadge();
    });
    return;
  }
  if (name === 'storage.changed') {
    if (payload.key && payload.key !== STATE_KEY) return;
    void refreshState().then(() => {
      if (role === 'bg' && lastSettleAdvanced) void persist();
      renderAll();
      pushBadge();
    });
  }
}

async function onInit(data) {
  for (const name of data.granted || []) granted.add(name);
  const surface = data.surface || {};
  const host = data.host || null;
  hostMethods = host && Array.isArray(host.methods) ? host.methods.slice() : null;
  pluginId = String(data.pluginId || '');
  role = surface.kind === 'surface' ? 'card' : surface.slot === 'background' ? 'bg' : 'page';
  if (data.theme) applyTheme(data.theme);

  if (els.root) {
    els.root.dataset.slot = role;
    els.root.classList.add('ready');
  }
  if (els.card) els.card.hidden = role !== 'card';
  if (els.page) els.page.hidden = role !== 'page';

  wire();
  await refreshConfig();
  await refreshState();

  if (role === 'bg') startBackground();
  // 页与卡片都要先画一次：**没授权的那一屏**也是在画，它要说清缺的是哪一项。
  else renderAll();
}

/** 常驻帧：头顶那行字（唯一推手）+ 到点提醒（唯一钟表）。 */
function startBackground() {
  // 挂载时就把结算结果写回去一次：`refreshState` 只在内存里结算，而连续天数是"结算出来的
  // 数字"，不落盘的话重挂帧之后要靠 60 天的打卡历史重算。
  if (lastSettleAdvanced) void persist();
  pushBadge();
  void checkReminder();
  // 只有它需要听"设置变了"：页与卡片是重挂时读一次，而它一直挂着。
  if (granted.has('events') && serves('events.subscribe') && !subscribed) {
    subscribed = true;
    request('events.subscribe', { names: ['config.changed'] }).catch(() => {
      subscribed = false; // 被拒就下次重挂再试，不要在这里重试成一轮噪音
    });
  }
  if (!timer) timer = window.setInterval(bgTick, BG_TICK_MS);
}

/**
 * 30 秒一拍。
 *
 * `refreshState` 在这一拍里是**兜底**（`storage.changed` 是主路径）：帧一直挂着，事件也可能
 * 因为别的程序里的写入而晚到。30 秒比文档建议的 15 秒更宽，因为它读的东西一天就变几次。
 */
async function bgTick() {
  await refreshState();
  // 结算落盘：连续天数是"结算出来的数字"，不写回去就会一直依赖 60 天的历史窗口，
  // 而跨过 60 天的那一天 streak 会从历史里消失（用户看到"连续 40 天"变成"连续 1 天"）。
  if (lastSettleAdvanced) await persist();
  pushBadge();
  await checkReminder();
}

// **监听器装好之后**才握手：init 可能在你 post 完的下一个任务就到达。
HOST.postMessage({ v: V, type: 'ready' }, '*');
