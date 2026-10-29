// app.js —— 入口：宿主消息泵、plugin.call 的应答、启动接线
//
// 最后加载的一支脚本。别的文件只定义函数；这里决定"什么时候开始干活"，并把测试接缝挂出去。
//
// 消息泵有四种入站：init / response / event / **call**。最后一种是这个插件存在的理由：
// 别的插件用 plugin.call 问一句，这里答一句。它走的是 `call` / `call-result` 这一对，
// 不是 `request` / `response`——方向相反，而且一次调用只认一个回包（手册 §6.8）。
//
// WHAT IT DOES *NOT* DO
//
// 它不订阅任何宿主事件（manifest 里没有 events），也不持有任何网络连接：入站流量只有
// "别人问我"。所以它不挑窗口——桌宠的常驻帧和控制中心的插件页是同一个文档的两种 appearance。

'use strict';

/**
 * `plugin.call` 能问的方法。**必须与 manifest 的 `serves` 逐字相同**：
 * serves 里写了、这里没有，调用方会一直等到超时（宿主不替你答）；这里写了、serves 里没有，
 * 宿主根本不会把它转发过来。测试里有一条断言把这两边钉在一起。
 */
const CALL_HANDLERS = {
  chat: handleChat,
  // 把接入端（例如 QQ 插件）已经攒下的记忆并进来。它不是"迁移工具"的装饰：没有它，用户打开
  // 记忆核心的那一刻，旧记忆会变成没人再读的文件，而看到的是"它把我记得的事忘了"。
  seed: handleSeed,
  // 定时记忆压缩（0.3.0）：手动触发一次"把到昨天为止还没压的天压掉"。
  // payload {daysBack?}；工坊页与测试用它，定时器走的同一个入口。
  compact: handleCompact,
};

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

/** 首帧的配色在 URL 上（宿主写在 src 里），所以第一次绘制就已经是对的。 */
applyTheme(new URLSearchParams(location.search).get('theme'));

function onResponse(data) {
  const waiter = pending.get(data.id);
  if (!waiter) return;
  pending.delete(data.id);
  if (data.ok) waiter.resolve(data.result);
  else waiter.reject(new Error(data.error || '插件请求失败'));
}

/**
 * 答一次 plugin.call。
 *
 * 三种结局都要回一条 call-result，**包括"我不认识这个方法"**：不回包的话调用方只能等到
 * 30 秒超时，而它永远等不到原因。这就是为什么这里的默认分支是一条错误而不是 return。
 */
async function onCall(data) {
  const ticket = typeof data.ticket === 'string' ? data.ticket : '';
  if (!ticket) return;
  const method = typeof data.method === 'string' ? data.method : '';
  const handler = CALL_HANDLERS[method];
  if (!handler) {
    postCallResult(ticket, false, new Error(
      `记忆核心不认识方法 ${method || '(空)'}：它只回答 ${Object.keys(CALL_HANDLERS).join(' / ')}`));
    return;
  }
  try {
    postCallResult(ticket, true, await handler(data.payload === undefined ? {} : data.payload));
  } catch (err) {
    postCallResult(ticket, false, err);
  }
}

function onInit(payload) {
  self = {
    pluginId: payload.pluginId || '',
    slot: (payload.surface && payload.surface.slot) || '',
  };
  granted.clear();
  for (const name of payload.granted || []) granted.add(name);
  applyTheme(payload.theme);
  ready = true;

  // 两种 appearance，一件共同的事：把设置读进来（问答与显示都要用它）。
  void refreshConfig()
    .then(() => {
      if (self.slot === 'workshop') {
        void renderWorkshop().catch((err) => say(`刷新失败：${text(err && err.message, 120)}`));
        // 另一个进程（桌宠的常驻帧）在写同一批文件，所以打开的这一面自己刷新；核心并不轮询。
        setInterval(() => {
          void renderWorkshop().catch(() => {});
        }, 5000);
        return;
      }
      // 常驻帧：不画任何东西。它只需要"在"，并且随时答得上。
      if (els.root) els.root.classList.add('view-background');
      // 定时记忆压缩（0.3.0）：每分钟看一次钟，本地日期一变就把前一天压成 L3。
      // 开关关了就不启动；启动时还有一次补跑（宿主半夜重启错过定时的话）。
      if (flag('compactEnabled', true)) startCompactTimer();
    })
    // 每一条"射后不理"的 promise 都得有接收者：否则一条拒绝会以"未处理的 promise 拒绝"
    // 收场，而它的原因（例如 storage 未授权）在界面上一个字都看不出。
    .catch(() => {});
}

function onMessage(event) {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.v !== PROTOCOL) return;
  switch (data.type) {
    case 'init':
      onInit(data);
      break;
    case 'theme':
      applyTheme(data.theme);
      break;
    case 'response':
      onResponse(data);
      break;
    case 'call':
      void onCall(data);
      break;
    default:
      // `event` / `surface` / 未知类型：这个插件都不需要。忽略是协议要求的宽容。
      break;
  }
}

window.addEventListener('message', onMessage);
if (els.forget) els.forget.addEventListener('click', () => void forgetSelected().catch(() => {}));
postToHost({ type: 'ready' });

/**
 * 测试接缝。
 *
 * 这一个比别的插件更需要它：核心的行为发生在**没有界面**的那一面，一条 plugin.call 进来
 * 之后要走完"读记忆 → 拼 prompt → 问模型 → 写回 → 排晋升"。测试要么驱动这条真实的链路，
 * 要么就只能读源码假装它是对的——前者是唯一有意义的那一半。
 *
 * 它不是能力：下面每个函数里的每一次读写仍然经 `request`，仍然过宿主那道闸门。
 */
window.__memcore = Object.freeze({
  chat: handleChat,
  compact: handleCompact,
  compactTick,
  stopCompactTimer,
  forget: forgetRole,
  renderWorkshop,
  forgetSelected,
  handlers: CALL_HANDLERS,
  snapshot: () => ({
    slot: self.slot,
    ready,
    granted: [...granted],
    cfg: { ...cfg },
    queueDepth: roleQueues.size,
  }),
  resetQueue: () => roleQueues.clear(),
});
