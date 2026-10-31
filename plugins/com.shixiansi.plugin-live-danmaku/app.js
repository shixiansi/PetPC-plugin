// app.js —— 入口：宿主消息泵、启动接线、测试接缝
//
// 最后加载的一支脚本。别的模块只定义函数；这里决定"什么时候开始干活"。

'use strict';

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

function onEvent(data) {
  if (!data || typeof data.name !== 'string') return;
  switch (data.name) {
    case 'ws.message':
      // 弹幕帧只对常驻帧有意义：工坊页不持有连接，也不该替它处理。
      if (self.slot === 'background' && data.payload && typeof data.payload.text === 'string') {
        onDanmakuFrame(data.payload.text);
      }
      break;
    case 'ws.state':
      // 状态变化只刷新本地标记；真正的显示在 renderStatus。
      if (data.payload && typeof data.payload.state === 'string') {
        liveConn.open = data.payload.state === 'open';
        if (self.slot === 'workshop') renderStatus();
      }
      break;
    default:
      break;
  }
}

function onCall(data) {
  // 这个插件 serves 里没有方法（它是提问的一方），但宿主按协议可能仍把 call 转过来
  // （例如旧版本清单还挂着）。对每一条 call 都回一个 call-result 是铁律：不回的话
  // 调用方要等满 30 秒超时（手册 §6.8）。
  const ticket = typeof data.ticket === 'string' ? data.ticket : '';
  if (!ticket) return;
  postCallResult(ticket, false, new Error(`弹幕插件不回答方法 ${data.method || '(空)'}`));
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

  // 队列容量从配置里来：每次 init 重读一次（用户可能刚改过设置）。
  // granted=[] 时一发 config.get 就会被宿主拒绝——用户什么都没授予的安装里，界面
  // 停在半截比停在"未授权"更糟，所以这个读取要等授予过 plugin.config 才发。
  void refreshCfg();

  if (self.slot === 'workshop') {
    if (els.workshop) els.workshop.classList.remove('hidden');
    void renderWorkshop().catch(() => {});
    // 工坊页每 2 秒刷一次：它读的是常驻帧写进盘上的统计（这里以内存快照 + 回应日志为准）。
    setInterval(() => {
      void renderWorkshop().catch(() => {});
    }, 2000);
    return;
  }

  // 常驻帧：开始干活。先读设置，再连弹幕桥。
  if (els.root) els.root.classList.add('view-background');
  void refreshCfg().then(() => {
    queue.cap = clampInt(cfg.queueCap, 10, 5000, 500);
    startBot();
    // 命令轮询：工坊页的开关走 share 键递过来。
    setInterval(() => {
      void pollCommand();
    }, 3000);
  });
}

/** 读一遍设置到 cfg。配置权限被拒/未授予时**不发请求**：用户什么都没授予的安装里，
 *  界面停在"未授权"比停在半截好，而且那条拒绝也是一次无意义的往返。 */
function refreshCfg() {
  if (!granted.has('plugin.config')) return Promise.resolve();
  return request('config.get', {})
    .then((out) => {
      cfg = Object.assign({}, cfg, (out && out.values) || {});
      queue.cap = clampInt(cfg.queueCap, 10, 5000, 500);
    })
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
    case 'event':
      onEvent(data);
      break;
    case 'call':
      onCall(data);
      break;
    default:
      // 未知类型：忽略是协议要求的宽容。
      break;
  }
}

window.addEventListener('message', onMessage);
if (els.startStop) {
  els.startStop.addEventListener('click', () => {
    const running = interactRunning();
    void sendCommand(running ? 'stop' : 'start');
    // 本进程也直接动：workshop 与常驻帧在不同进程里，两边各跑各的开关不冲突
    // （命令键的 at 去重保证同一条命令只被执行一次）。
    if (running) stopInteractLoop();
    else startInteractLoop();
    renderStatus();
  });
}
postToHost({ type: 'ready' });

/**
 * 测试接缝。
 *
 * 弹幕插件的全部行为都发生在"一帧弹幕进来之后"：入队 → 打分 → 抽取 → 问模型 → 回应。
 * 测试要驱动这条真实的链路，而不是读源码假装它是对的。它们不是能力：下面每个函数
 * 里的每一次读写仍然经 `request`，仍然过宿主那道闸门。
 */
window.__danmaku = Object.freeze({
  queue: DanmakuQueue,
  state: () => liveSnapshot(),
  liveConn,
  interactState,
  // 直达函数：测试用它们拼"一帧弹幕进来 → 下一次抽取 → 发出了什么请求"。
  onDanmakuFrame,
  interactTick,
  startInteractLoop,
  stopInteractLoop,
  startBot,
  stopBot,
  buildPrompt,
  withinRate,
  speakReply,
  openDanmaku,
  closeDanmaku,
  danmakuTick,
  parseDanmakuFrame,
  protocolFor,
  renderWorkshop,
  renderStatus,
  renderFeed,
  renderReplies,
  memcoreRoleKey,
  sendCommand,
  pollCommand,
  loadReplies,
  setCfg: (patch) => { cfg = Object.assign({}, cfg, patch); },
  refreshCfg,
});
