// app.js —— 入口：宿主消息泵、测试接缝、启动接线
//
// 这是最后加载的一支脚本。别的模块只定义函数，真正的"开始干活"在这里：
// pollBridge 收宿主的回包、window.__qq 暴露给测试、末尾那一句把表情包控件的监听挂上。
//
// 从原来的 app.js 按节**原样搬出来**（1.12 的重构）：内容逐字未改，只是换了个文件。
'use strict';

// --- message pump ------------------------------------------------------------

function onResponse(data) {
  const waiter = pending.get(data.id);
  if (!waiter) return;
  pending.delete(data.id);
  if (data.ok) {
    waiter.resolve(data.result);
  } else {
    waiter.reject(new Error(data.error || '插件请求失败'));
  }
}

function onEvent(data) {
  if (!data || typeof data.name !== 'string') return;
  switch (data.name) {
    case 'ws.message':
      if (view === 'background' && data.payload && typeof data.payload.text === 'string') {
        onSocketFrame(data.payload.text);
      }
      break;
    case 'ws.state':
      if (view === 'background') onSocketState(data.payload);
      break;
    case 'config.changed':
      // 只认自己那份设置（宿主把 pluginId 放进 payload）。
      if (view === 'background' && data.payload && data.payload.pluginId === self.pluginId) onConfigChanged();
      break;
    case 'storage.changed':
      // 自己的私有目录变了：记忆核心开关与接话分寸都住在那里。
      if (view === 'background') onOwnStorageChanged();
      break;
    case 'share.changed':
      // 只关心 B 站那两个键（manifest 的 shareRead 声明了它们）。
      if (view === 'background') onBiliSharedChanged(data.payload && data.payload.name);
      break;
    case 'llm.delta':
      // Nothing streams into the group: a chat protocol has no "partial message",
      // so the reply is sent once, when it is finished.
      break;
    default:
      break;
  }
}

function onInit(payload) {
  self = { pluginId: payload.pluginId || '', surface: payload.surface || {} };
  applyTheme(payload.theme);
  granted.clear();
  for (const name of payload.granted || []) granted.add(name);
  applyView(self.surface);
  // 布局整理跑在两种界面**之前**：桌宠的常驻帧持有群记忆和历史，市场的工坊持有表情包
  // 图库，谁先启动谁整理。迁移是幂等的（一个标记文件挡住后续），所以两个进程同时跑也
  // 不会搬坏东西；它也不可能挡住它们 —— 整理失败只是这次没整理，机器人照常起来。
  const tidy = migrateDataLayout()
    // 每次启动都跑一次轻量兜底：升级那一刻旧进程还在往根目录写文件（真机上撞到过），
    // 而迁移有标记只跑一次，所以"目录保持干净"不能只靠它。
    .then(() => tidyLeftovers())
    .catch((err) => {
      note(`整理数据目录失败：${(err && err.message) || err}`);
    });
  if (view === 'background') {
    // 先把开关读进来，再开始连协议端：一个重启后要用的模式，不该等第一条群消息才生效。
    void refreshCoreMode().catch(() => {});
    void tidy.then(() => startBot());
    // media/ 的字节预算（lib/media.js）**不挡启动**：机器人先连上，再收拾缓存。真机上这个目录
    // 长到 497 MiB，而宿主上限是 64 MiB——不自己清，宿主只能拒绝写入，那就连账本都存不下去。
    void tidy.then(() => trimMediaAndNote().catch(() => {}));
    // 半小时一次就够：媒体文件的增长是"用户发图/看视频"驱动的，不是秒级的。
    setInterval(() => void trimMediaAndNote().catch(() => {}), 30 * 60 * 1000);
    return;
  }
  void tidy.then(() => renderWorkshop());
  // 记忆核心那张卡跟着一起刷：开关是在这张卡上勾的，而这一页可能一直开着。
  void refreshCoreMode().then(() => renderMemcoreCard());
  // The workshop is a second process's view of the same files, so it refreshes
  // while it is open; the bot itself does not poll anything.
  setInterval(() => {
    void renderWorkshop();
    void refreshCoreMode().then(() => renderMemcoreCard());
  }, 5000);
}

/**
 * Applies the window's colour scheme.
 *
 * The market program owns the scheme; this document only mirrors it, because it is a
 * sandboxed frame that cannot see the host's CSS. `data-theme` on <html> is the whole
 * interface to style.css, which holds both palettes.
 *
 * Three ways the value arrives, in the order they can happen:
 *   - on the frame URL, applied by the inline script in panel.html BEFORE the first
 *     paint (no flash of the wrong scheme);
 *   - in `init`, for a document mounted without it;
 *   - in a `theme` message, when the user flips the switch while this frame runs.
 */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

// The pet mounts this document too, without a scheme; dark is what it has always
// been there.
applyTheme(new URLSearchParams(location.search).get('theme'));

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
    default:
      break;
  }
}

window.addEventListener('message', onMessage);
postToHost({ type: 'ready' });

/**
 * Test seam: one bridge round, one tidy run, and the live state.
 *
 * The bridge runs on a 5 s timer, and a test that waited for real seconds would be slow
 * and flaky. Publishing the tick lets the behaviour be driven directly - the alternative,
 * putting the interval on a fake clock, would also fake out the WebSocket retry ladder
 * that the other tests depend on. `migrateDataLayout` / `tidyLeftovers` are published for
 * the same reason: they normally run once, at init, and a test that asserts what they
 * moved has to be able to run them on a directory it prepared.
 *
 * It is NOT a capability: everything it calls still goes through `request`, i.e. through
 * the dispatcher's permission gate.
 */
window.__qq = Object.freeze({
  bridgeTick: pollBridge,
  migrateDataLayout,
  tidyLeftovers,
  // 攒批的定时器每 15 秒才走一次，测试里等不起：直接调同一个函数。
  batchTick,
  // 定时提醒同理：测试给它一个假的时间点，就不用等真到点。
  reminderTick,
  // 哈希与指纹也放出来：测试要用**真实**的算法造"同一张图的另一种长度"，自己抄一份
  // FNV-1a 只会让两边悄悄分叉。
  hashOf,
  stickerSignature,
  state,
  ffmpegBudgetMs,
  // 字节预算的清理：测试要能直接驱动它，而不是等半小时的定时器。
  trimMedia,
  trimMediaAndNote,
  planEviction,
  MEDIA_BUDGET_BYTES,
});

// The sticker card's controls are wired once, at load. Function declarations are hoisted,
// so this can sit at the end of the file while the handlers live with the rest of the
// workshop code above.
bindStickerControls();
// 记忆核心那张卡的按钮：同一个做法（函数声明会被提升，所以这一句可以留在文件末尾）。
bindMemcoreControls();
