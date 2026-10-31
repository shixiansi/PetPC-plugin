// app.js —— 入口：宿主消息泵、plugin.call 应答、启动接线、测试接缝
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

/**
 * 答一次 plugin.call。三种结局都要回一条 call-result，**包括"我不认识这个方法"**：
 * 不回包的话调用方只能等到 30 秒超时（手册 §6.8）。
 */
async function onCall(data) {
  const ticket = typeof data.ticket === 'string' ? data.ticket : '';
  if (!ticket) return;
  const method = typeof data.method === 'string' ? data.method : '';
  const handler = CALL_HANDLERS[method];
  if (!handler) {
    postCallResult(ticket, false, new Error(
      `代码助手不认识方法 ${method || '(空)'}：它只回答 ${Object.keys(CALL_HANDLERS).join(' / ')}`));
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

  if (self.slot === 'workshop') {
    if (els.workshop) els.workshop.classList.remove('hidden');
    void restoreIndex().then(() => renderWorkshop()).catch(() => {});
    setInterval(() => {
      void (async () => {
        await refreshCfg();
        renderWorkshop();
      })();
    }, 5000);
    return;
  }

  // 常驻帧：读设置 → 探桥 → 恢复索引 → 按开关启动轮询。
  if (els.root) els.root.classList.add('view-background');
  void (async () => {
    await refreshCfg();
    await probeBridge();
    await restoreIndex();
    if (flag('watchEnabled', false) && String(cfg.watchDir || '').trim()) startWatcher();
    // 命令轮询：工坊页的开关走 share 键递过来。
    // 15 秒兜底：宿主会为 share.changed 发事件（手册 §7.1），这个定时器只负责"事件丢了"。
    setInterval(() => {
      void pollCommand();
    }, 15000);
  })();
}

/**
 * 宿主说"你关心的共享键变了"（share.changed，手册 §7.1）：立刻读一次，不用等 15 秒兜底。
 *
 * 只认自己名下的键（`<自己的 id>/<名字>`）：命令键是同一个插件的两个帧之间的通道，
 * 而这条事件也会因为"别人的键变了"送到这里——那不是给我们的。
 */
function onHostEvent(data) {
  if (!data || data.name !== 'share.changed') return;
  const payload = data.payload || {};
  const key = String(payload.key || '');
  if (!self.pluginId || !key.startsWith(self.pluginId + '/')) return;
  void pollCommand();
}
function onMessage(event) {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.v !== PROTOCOL) return;
  switch (data.type) {
    case 'init':
      onInit(data);
      break;
    case 'event':
      onHostEvent(data);
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
      // event / surface / 未知类型：忽略是协议要求的宽容。
      break;
  }
}

/** 读一遍设置。配置权限未授予时**不发请求**（与 live-danmaku 同一纪律）。 */
function refreshCfg() {
  if (!granted.has('plugin.config')) return Promise.resolve();
  return request('config.get', {})
    .then((out) => {
      cfg = Object.assign({}, cfg, (out && out.values) || {});
    })
    .catch(() => {});
}

window.addEventListener('message', onMessage);
if (els.reviewBtn) els.reviewBtn.addEventListener('click', () => void reviewButton());
if (els.genBtn) els.genBtn.addEventListener('click', () => void genTestsButton());
if (els.watchToggle) {
  els.watchToggle.addEventListener('click', () => {
    const running = watcherRunning();
    void sendCommand(running ? 'watch-stop' : 'watch-start');
    // 本进程立即生效（命令键的 at 去重保证常驻帧不会重复执行）。
    if (running) stopWatcher();
    else if (String(cfg.watchDir || '').trim()) startWatcher();
    renderStatus();
  });
}
postToHost({ type: 'ready' });

/**
 * 测试接缝。解析、轮询、审查、写盘——全部可被直接驱动；它们不是能力：
 * 每个函数里的读写仍然经 request 过宿主的闸门。
 */
window.__ast = Object.freeze({
  parser: AstParser,
  state: () => ({
    slot: self.slot,
    ready,
    granted: [...granted],
    cfg: { ...cfg },
    bridge: { ...fileBridge },
    watcher: {
      running: watcherRunning(),
      scanning: watcher.scanning,
      lastScanAt: watcher.lastScanAt,
      lastError: watcher.lastError,
      scanCount: watcher.scanCount,
      size: watcher.index.size,
    },
    review: reviewSnapshot(),
  }),
  index: watcher.index,
  handlers: CALL_HANDLERS,
  // 直达函数
  scanOnce,
  startWatcher,
  stopWatcher,
  probeBridge,
  bridgeList,
  bridgeRead,
  bridgeWrite,
  handleAnalyze,
  handleReview,
  handleGenTests,
  extractTestCode,
  sanitizeName,
  clampCode,
  persistIndex,
  restoreIndex,
  indexList,
  renderWorkshop,
  sendCommand,
  pollCommand,
  setCfg: (patch) => { cfg = Object.assign({}, cfg, patch); },
});
