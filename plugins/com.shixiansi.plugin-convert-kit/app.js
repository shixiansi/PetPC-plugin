// app.js —— 握手 + 两条路的接线。
//
// 一个文档，两副面孔（由 init.surface.slot 决定，不猜）：
//
//   workshop     控制中心的插件页：换算界面（lib/panel.js）。
//   background   桌宠的常驻无名帧：什么都不画，只等别的插件 plugin.call 问 convert。
//
// 常驻帧那一半不是摆设：manifest 的 `serves: ["convert"]` 是一句承诺，而**只有挂了帧的插件
// 才答得上话**（手册 §6.8「目标必须此刻有帧」）。没有它，任何调用方都只会立刻拿到"没有帧"。

'use strict';

const V = 1;
const HOST = window.parent;

/**
 * 一次 plugin.call 的答案。出错就抛——外层把错误文本原样回给调用方。
 *
 * payload 与返回的形状见 README「serves.convert」那一节；形状变了别人的代码就会崩在它那边，
 * 所以返回字段是钉住的，减少字段要升版本。
 */
async function answerCall(method, payload) {
  const name = String(method === undefined || method === null ? '' : method);
  if (name !== 'convert') {
    throw new Error(`换算工具不认识 ${name || '（空方法名）'} 这个方法（它只答 convert，payload 与返回形状见插件的 README）`);
  }
  await ensureConfig(); // 保留位数会影响 text；读不到就用默认的 2 位
  return convert(payload || {}, { decimals: cfg.decimals });
}

window.addEventListener('message', (event) => {
  // 只认父窗口；只认本协议版本（宿主以后会加 type，认不出来的一律忽略）。
  if (event.source !== HOST) return;
  const data = event.data;
  if (!data || data.v !== V) return;

  switch (data.type) {
    case 'init':
      onInit(data).catch((err) => say(`界面没能起来：${(err && err.message) || err}`));
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
      applyTheme(data.theme);
      break;
    case 'call': {
      // 只有声明了 serves 的插件会收到这个（manifest 里是 ["convert"]）。
      const ticket = data.ticket;
      Promise.resolve()
        .then(() => answerCall(data.method, data.payload || {}))
        .then((value) => postCallResult(ticket, true, value))
        .catch((err) => postCallResult(ticket, false, (err && err.message) || err));
      break;
    }
    case 'event':
      // 用户在外面的设置页改了保留位数：两个宿主都会推 config.changed（手册 §7）。
      // 重读一次，这样不必重开插件页。
      if (data.name === 'config.changed') {
        invalidateConfig();
        guard(ensureConfig);
      }
      break;
    case 'surface':
      // 这个插件没有浮层面也没有本体帧，矩形变化与它无关。
      break;
    default:
      break;
  }
});

async function onInit(data) {
  for (const name of data.granted || []) granted.add(name);
  const surface = data.surface || {};
  self = {
    pluginId: String(data.pluginId || ''),
    slot: String(surface.slot || ''),
  };
  if (data.theme) applyTheme(data.theme);

  const page = document.getElementById('workshop');
  const headless = self.slot === 'background' || self.slot === 'body';
  if (page) {
    // 常驻帧里这一整块都不显示（它本来就 display:none，这里只是别让它去量布局）。
    page.hidden = headless;
    page.dataset.slot = self.slot;
  }
  if (headless) {
    // 不画东西，只把设置读进来：plugin.call 的 text 要按用户设的位数格式化。
    await ensureConfig();
    return;
  }
  await mountPanel();
}

// **监听器装好之后**才握手：init 可能在你 post 完的下一个任务就到达（手册 §5.3 铁律 1）。
HOST.postMessage({ v: V, type: 'ready' }, '*');
