// app.js —— 握手、两副面孔的分派、以及"到点再取一次"
//
//   surface（300×150 的卡片）  最多三行 + sparkline。它自己刷新——卡片是常驻可见的那一面。
//   workshop（控制中心插件页） 完整列表 + 周期 + 行情源。改完配置立刻重取一次。
//   其它落点                   本插件没有声明 background / panel；万一被挂到那儿就**只刷新不画**
//                              （它没有像素），数据照样是热的那一份。
//
// 刷新只有一个来源：bootMarket 开头一次，之后由 scheduleRefresh 按 refreshMinutes 排下一拍。
// **没有 1 秒的轮询**：1 秒一刷只会在日志里留下几万行 DEBUG 和一份被限流的配额（手册 §3.9）。
'use strict';

let initSeen = false;
let refreshTimer = 0;

function onResponse(data) {
  const waiter = pending.get(data.id);
  if (!waiter) return; // 过期或未知的 id：丢掉，不要报错
  pending.delete(data.id);
  if (data.ok) waiter.resolve(data.result);
  else waiter.reject(new Error(data.error || '宿主拒绝了这次调用'));
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
        textOf(els.boot, '初始化失败：' + errorText(err));
        show(els.boot, true);
      });
      break;
    case 'response':
      onResponse(data);
      break;
    case 'theme':
      applyTheme(data.theme);
      break;
    case 'surface':
      // 矩形被夹回：记下来重画一次就够（卡片按声明矩形排版，不跟着长高——它是固定三行）。
      if (data.rect) mountInfo.rect = data.rect;
      paint();
      break;
    default:
      break;
  }
}

async function onInit(data) {
  for (const name of data.granted || []) granted.add(name);
  const surface = data.surface || {};
  const host = data.host || null;
  hostMethods = host && Array.isArray(host.methods) ? host.methods.slice() : null;

  const kind = String(surface.kind || 'panel');
  mountInfo.kind = kind;
  // 浮层面的 kind 是 'surface' 而**没有** slot；常驻帧的 kind 是 'panel'、slot 是 'background'。
  mountInfo.slot = String(surface.slot || (kind === 'surface' ? 'surface' : 'panel'));
  mountInfo.rect = surface.rect || null;
  mountInfo.rectIndex = Number(surface.rectIndex) || 0;
  mountInfo.rectCount = Number(surface.rectCount) || 1;
  if (data.theme) applyTheme(data.theme);

  show(els.boot, false);
  show(els.surfaceCard, isSurfaceMount());
  show(els.workshop, mountInfo.slot === 'workshop');
  if (els.body) els.body.dataset.view = isSurfaceMount() ? 'surface' : mountInfo.slot || 'panel';
  if (isSurfaceMount()) bindCard();
  if (mountInfo.slot === 'workshop') bindWorkshop();

  await bootMarket();
}

/** 先用上一次的快照把界面画出来，再去取新的——"先有东西看"是失败不清空的另一半。 */
async function bootMarket() {
  await refreshConfig();
  await loadView();
  await loadSnapshot();
  paint();
  try {
    await refreshMarket({ reload: false });
  } catch (err) {
    const message = '刷新失败：' + errorText(err);
    textOf(els.sfFoot, message);
    textOf(els.wsStatus, message);
  }
  scheduleRefresh();
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = 0;
    // 定时器里漏出去的异常就是一条 unhandledrejection：这一拍必须自己吞掉。
    refreshMarket()
      .catch(() => {})
      .then(scheduleRefresh);
  }, marketIntervalMs());
}

// **监听器装好之后**才握手：init 可能在你 post 完的下一个任务就到达。
window.addEventListener('message', onMessage);
postToHost({ type: 'ready' });
