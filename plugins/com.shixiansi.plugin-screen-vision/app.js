// app.js —— 入口：宿主消息泵、plugin.call 的应答、启动接线
//
// 与 websearch / memcore 的 app.js 同一型：四种入站（init / response / event / call），
// 最后一种是这个插件存在的理由——别的插件用 plugin.call 问 analyze_screen，这里答。
//
// 它不订阅任何宿主事件、不持有任何长连接。background 帧负责启动辅助脚本并随时答问；
// surface 块（面板）负责"看一眼屏幕"按钮与识别中状态；workshop 页只读。

'use strict';

/**
 * `plugin.call` 能问的方法。**必须与 manifest 的 `serves` 逐字相同**——serves 里写了
 * 这里没实现，调用方等到 30 秒超时；这里写了 serves 没列，宿主不会转发过来。
 * 测试里有一条断言把这两边钉在一起。
 */
const CALL_HANDLERS = {
  analyze_screen: handleAnalyzeScreen,
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
      `屏幕视觉不认识方法 ${method || '(空)'}：它只回答 ${Object.keys(CALL_HANDLERS).join(' / ')}`));
    return;
  }
  try {
    postCallResult(ticket, true, await handler(data.payload === undefined ? {} : data.payload));
  } catch (err) {
    postCallResult(ticket, false, err);
  }
}

/** 启动截图辅助脚本（pet-sense 的同一条路：写好的脚本 + 用户配置的 powershell.exe）。 */
async function startHelper() {
  const helperExe = String(cfg.helperPath || '').trim();
  const scriptPath = String(cfg.helperScript || '').trim();
  if (!helperExe || !scriptPath) {
    say('先在设置里填 PowerShell 路径与辅助脚本路径，再重启桌宠');
    return;
  }
  const dirOut = await request('storage.dir', {}).catch(() => null);
  const outDir = dirOut && dirOut.dir ? dirOut.dir : '';
  if (!outDir) return;
  try {
    await request('process.launch', {
      path: helperExe,
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-OutDir', outDir],
    });
    say('截图辅助脚本已启动');
  } catch (err) {
    say('启动失败：' + text(err && err.message, 120));
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
        // 控制中心不服务 process / plugin.call：按钮禁用，记录照常显示。
        if (els.look) els.look.disabled = true;
        if (els.workshop) {
          const note = els.workshop.querySelector('.desktop-only');
          if (note) note.classList.remove('hidden');
        }
        void renderHelperChip().catch(() => {});
        void renderHistory().catch(() => {});
        // 桌宠那边的常驻帧在写同一批文件（历史），所以这一面自己刷新；核心并不轮询事件。
        setInterval(() => {
          void renderHistory().catch(() => {});
          void renderHelperChip().catch(() => {});
        }, 5000);
        return;
      }
      // 桌宠的常驻帧（slot=background）：启动辅助脚本，然后不画任何东西。
      if (els.root) els.root.classList.add('view-background');
      if (granted.has('process')) {
        void startHelper().catch(() => {});
      } else {
        say('未获授权：process（只能等别人来问）');
      }
      // 面板（surface 块）也用这份文档：那里 process 都被授予了，按钮可用。
      if (els.look) els.look.disabled = !granted.has('process') || !granted.has('plugin.call');
      void renderHistory().catch(() => {});
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
if (els.look) els.look.addEventListener('click', () => void runAnalysis().catch(() => {}));
if (els.question) {
  els.question.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void runAnalysis().catch(() => {});
    }
  });
}
if (els.historyClear) els.historyClear.addEventListener('click', () => void clearAllHistory().catch(() => {}));

// **监听器装好之后**才握手：init 可能在 post 完的下一个任务就到达。
postToHost({ type: 'ready' });

/**
 * 测试接缝：行为发生在看不见的那一面（常驻帧被 plugin.call 问、截图在脚本侧），测试要么
 * 驱动真实链路，要么只能读源码假装它是对的。
 */
window.__vision = Object.freeze({
  analyze: handleAnalyzeScreen,
  runAnalysis,
  renderHistory,
  clearAllHistory,
  startHelper,
  handlers: CALL_HANDLERS,
  screenshot: { captureOnce, pollMeta, readUploadResult, readHelperHealth, cleanRegion, urlHostInWhitelist, effectiveWhitelist },
  snapshot: () => ({
    slot: self.slot,
    ready,
    granted: [...granted],
    cfg: { ...cfg },
    lastAnalyzeAt,
  }),
});
