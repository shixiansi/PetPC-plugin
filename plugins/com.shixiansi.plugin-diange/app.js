// app.js —— 入口：宿主消息泵、plugin.call 的应答、启动接线
//
// 与联网搜索插件同一型：四种入站（init / response / event / call），最后一种是这个插件存在
// 的理由——别的插件（记忆核心）用 plugin.call 问 search 或 link，这里答。
//
// 它不订阅任何宿主事件、不持有任何长连接：入站只有「别人问我」和「插件页让我点一首」。

'use strict';

/**
 * `plugin.call` 能问的方法。**必须与 manifest 的 `serves` 逐字相同**——serves 里写了
 * 这里没实现，调用方等到 30 秒超时；这里写了 serves 没列，宿主不会转发过来。
 * 测试里有一条断言把这两边钉在一起。
 *
 * 名字是 `song` / `song_link`，**不是** `search` / `link`：
 *   · `search` 在插件市场里已经有主——它指的是「网页搜索」（联网搜索、B 站那两个插件），
 *     而记忆核心按**能力名**发现提供方（宿主 plugins.services / lib/services.js）。
 *     一个叫 search 的点歌插件会让"搜一下今天天气"被问成"没找到这首歌"；
 *   · `link` 太宽：以后会有一个"给我一个下载链接"的插件，那时两个都能答 `link`，
 *     调用方没法表达它要的是歌。
 */
const CALL_HANDLERS = {
  song: handleSong,
  song_link: handleSongLink,
};

function onResponse(data) {
  const waiter = pending.get(data.id);
  if (!waiter) return;
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
      `点歌不认识方法 ${method || '(空)'}：它只回答 ${Object.keys(CALL_HANDLERS).join(' / ')}`));
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
    // 宿主能力表（init.host = {program, methods}，手册 §5.2.1）。**别按 slot 猜**：
    // “这个窗口服务不服务 net.fetch”只有这一份答案。
    host: payload.host && Array.isArray(payload.host.methods) ? payload.host : null,
  };
  granted.clear();
  for (const name of payload.granted || []) granted.add(name);
  applyTheme(payload.theme);
  ready = true;

  void refreshConfig()
    .then(() => {
      if (self.slot === 'workshop') {
        void renderWorkshop().catch(() => {});
        // 桌宠那边的常驻帧在往同一批文件里写历史（用户点歌时插件页可能正开着），
        // 所以这一面自己刷新一次。它只读自己的私有目录，不花网络也不花模型钱。
        setInterval(() => {
          void renderWorkshop().catch(() => {});
        }, 5000);
        return;
      }
      // 桌宠的常驻帧：这里也可能是个浮层面/面板，但本插件没有那些落点——什么都不画。
      if (els.root) els.root.classList.add('view-background');
    })
    // 射后不理的 promise 都要有接收者：一次 config.get 失败不该变成"未处理的拒绝"。
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
if (els.go) els.go.addEventListener('click', () => void runSearch().catch(() => {}));
if (els.query) {
  els.query.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void runSearch().catch(() => {});
    }
  });
}
if (els.historyClear) els.historyClear.addEventListener('click', () => void clearAllHistory().catch(() => {}));

// **监听器装好之后**才握手：init 可能在 post 完的下一个任务就到达。
postToHost({ type: 'ready' });

/**
 * 测试接缝：行为发生在看不见的那一面（常驻帧被 plugin.call 问），测试要么驱动真实链路，
 * 要么只能读源码假装它是对的。
 */
window.__diange = Object.freeze({
  song: handleSong,
  songLink: handleSongLink,
  renderWorkshop,
  runSearch,
  clearAllHistory,
  handlers: CALL_HANDLERS,
  snapshot: () => ({
    slot: self.slot,
    ready,
    granted: [...granted],
    cfg: { ...cfg },
  }),
});
