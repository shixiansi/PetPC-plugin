// app.js —— 握手 + 两条路的接线
//
// 一个文档，两副面孔（由 init.surface.slot 决定，不猜）：
//
//   workshop     控制中心插件页：拖/粘贴/选文件 → 上传 → 拿走链接（lib/workshop.js）
//   background   桌宠的常驻无名帧：什么都不画，只等别的插件 plugin.call 问 upload
//
// 常驻帧那一半是真的有人用的：`upload` 收一个 data URL（≤40KB 的字节，因为 plugin.call 的
// payload 上限是 64KiB），传上去回一条链接。适合"另一个插件刚生成了一张二维码/小图，想给它一个
// 能贴出去的地址"——大图请用户在插件页里拖，那条路不需要经过 plugin.call。

'use strict';

const V = 1;
const HOST = window.parent;

/**
 * plugin.call 这条路能带多大一张图。
 *
 * payload ≤64KiB 是硬上限，而 data URL 是 base64（4/3），再留出信封的余量，40KB 是能稳稳站稳的
 * 那个数。超了要**明说**，不能让调用方等到超时。
 */
const MAX_CALL_BYTES = 40 * 1024;

function defaultNameFor(mime) {
  const ext = EXT_BY_MIME[String(mime || '').toLowerCase()] || 'png';
  return `pet-${Date.now()}.${ext}`;
}

/** 一次 plugin.call 的答案。出错就抛——外层会把错误文本原样回给调用方。 */
async function answerCall(method, payload) {
  if (method !== 'upload') throw new Error(`图床上传不认识 ${method} 这个方法（它只答 upload）`);
  const input = payload || {};
  if (!input.dataUrl) throw new Error('upload 需要 {dataUrl:"data:image/png;base64,…"}');
  const { mime, bytes } = bytesFromDataUrl(input.dataUrl);
  if (bytes.length > MAX_CALL_BYTES) {
    throw new Error(`plugin.call 只能带 ${MAX_CALL_BYTES} 字节以内的图（这张 ${fmtBytes(bytes.length)}）：大图请在插件页里拖`);
  }
  await refreshConfig();
  const result = await uploadBytes({ name: String(input.name || defaultNameFor(mime)), mime, bytes });
  return { url: result.url, name: result.name, bytes: result.bytes, at: result.at };
}

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
    case 'call': {
      // 只有声明了 serves 的插件会收到这个（manifest 里是 ["upload"]）。
      const ticket = data.ticket;
      Promise.resolve()
        .then(() => answerCall(String(data.method || ''), data.payload || {}))
        .then((value) => postCallResult(ticket, true, value))
        .catch((err) => postCallResult(ticket, false, (err && err.message) || err));
      break;
    }
    case 'event':
    case 'surface':
      // 这个插件不订阅事件，也没有浮层面；收到就忽略。
      break;
    default:
      break;
  }
});

async function onInit(data) {
  for (const name of data.granted || []) granted.add(name);
  const surface = data.surface || {};
  const host = data.host || null;
  hostMethods = host && Array.isArray(host.methods) ? host.methods.slice() : null;
  self = {
    pluginId: String(data.pluginId || ''),
    slot: String(surface.slot || ''),
    program: String((host && host.program) || (surface.slot === 'workshop' ? 'workshop' : 'pet')),
  };
  if (data.theme) applyTheme(data.theme);

  const root = els.root;
  if (root) {
    root.dataset.surface = surface.kind || 'panel';
    root.dataset.slot = self.slot;
    root.classList.add('ready');
  }

  if (self.slot === 'workshop') {
    if (els.workshop) els.workshop.classList.remove('hidden');
    bindWorkshop();
    await renderWorkshop();
    return;
  }

  // 常驻帧：看不见、不能点，只答 plugin.call。这里不打日志、不画东西。
  if (els.workshop) els.workshop.classList.add('hidden');
}

// **监听器装好之后**才握手：init 可能在你 post 完的下一个任务就到达。
HOST.postMessage({ v: V, type: 'ready' }, '*');
