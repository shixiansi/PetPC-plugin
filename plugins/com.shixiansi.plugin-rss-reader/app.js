// app.js —— 入口：宿主消息泵、plugin.call 的应答、启动接线
//
// 与 websearch / memcore / screen-vision 的 app.js 同一型：四种入站
// （init / response / event / call），最后一种是这个插件存在的理由——
// 别的插件用 plugin.call 问 fetch_now，这里答。
//
// 它没有 surface（面板工作交给 workshop 页），background 帧负责定时抓取与播报；
// 谁也不订阅宿主事件（events 权限是 background 落点的依据，真正的周期走 setInterval）。

'use strict';

/**
 * `plugin.call` 能问的方法。**必须与 manifest 的 `serves` 逐字相同**——serves 里写了
 * 这里没实现，调用方等到 30 秒超时；这里写了 serves 没列，宿主不会转发过来。
 */
const CALL_HANDLERS = {
  fetch_now: handleFetchNow,
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
      `晨报不认识方法 ${method || '(空)'}：它只回答 ${Object.keys(CALL_HANDLERS).join(' / ')}`));
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

  void refreshConfig()
    .then(async () => {
      if (self.slot === 'workshop') {
        // 控制中心不服务 net.fetch / plugin.call：按钮禁用，列表照常显示。
        if (els.fetchNow) els.fetchNow.disabled = true;
        if (els.workshop) {
          const note = els.workshop.querySelector('.desktop-only');
          if (note) note.classList.remove('hidden');
        }
        void renderFeeds().catch(() => {});
        void renderDigest().catch(() => {});
        // 桌宠那边的常驻帧在写同一批文件，所以这一面自己刷新；核心并不轮询事件。
        setInterval(() => {
          void renderFeeds().catch(() => {});
          void renderDigest().catch(() => {});
        }, 5000);
        return;
      }
      // 桌宠的常驻帧：定时抓取在这里跑。
      if (els.root) els.root.classList.add('view-background');
      if (granted.has('net.fetch')) {
        // 启动 30 秒后先补一轮（宿主半夜重启错过点的话），然后按间隔循环。
        scheduleDigest(30000);
      } else {
        say('未获授权：net.fetch（定时抓取不会运行）');
      }
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
if (els.feedAdd) els.feedAdd.addEventListener('click', () => void addFeed().catch(() => {}));
if (els.feedUrl) {
  els.feedUrl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void addFeed().catch(() => {});
    }
  });
}
if (els.fetchNow) els.fetchNow.addEventListener('click', () => void runFetchNow().catch(() => {}));

// **监听器装好之后**才握手：init 可能在 post 完的下一个任务就到达。
postToHost({ type: 'ready' });

/**
 * 测试接缝：晨报的行为发生在看不见的那一面（常驻帧的定时器、对两个插件的调用），
 * 测试要么驱动真实链路，要么只能读源码假装它是对的。
 */
window.__rss = Object.freeze({
  runDigestCycle,
  handleFetchNow,
  addFeed,
  removeFeed,
  renderFeeds,
  scheduleDigest,
  stopDigestTimer,
  handlers: CALL_HANDLERS,
  xml: { parseFeed, tagContent, excerpt, decodeEntities, plainText },
  feeds: { cleanFeedUrl, configuredFeeds, fetchOne, pickNew, seenKey, loadFeedList, loadSeen },
  digest: { buildDigestPrompt, askDigest, speakDigest, withTimeout, DIGEST_SYSTEM },
  snapshot: () => ({
    slot: self.slot,
    ready,
    granted: [...granted],
    cfg: { ...cfg },
  }),
});
