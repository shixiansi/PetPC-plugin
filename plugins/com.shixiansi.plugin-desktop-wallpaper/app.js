// app.js —— 壁纸联动插件：入口、协议泵、定时抓取、plugin.call 应答
//
// 一个文档，两种身份：
//
//   workshop    控制中心插件页：抓 Bing、看色板与模糊预览、看历史、手动重发环境色。
//   background  桌宠常驻帧：每天本地时间 07:30 后的第一轮 tick 抓 Bing（当天已抓过就跳过），
//               解码 → 提色 → 模糊 → 发布 ambient 共享键 → 存历史，随时答 plugin.call。
//
// 与生态的联动：
//   - plugin.share 发布 `ambient`（环境快照 JSON）：桌宠侧读它调光影/主题色；
//   - plugin.call 服务 ambient_now / refresh / history：别的插件可以问当前环境、
//     触发一次重抓（例如"桌宠开始干活了 → 环境色切成冷静色"的场景由调用方决定）。

'use strict';

const V = 1;
const HOST = window.parent;
let nextId = 1;
const pending = new Map();

const PERM = {
  net: 'net.fetch',
  storage: 'storage',
  config: 'plugin.config',
  call: 'plugin.call',
  share: 'plugin.share',
  bubble: 'pet.bubble',
};

function request(method, payload) {
  const id = `r${nextId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    HOST.postMessage({ v: V, type: 'request', id, method, payload: payload ?? {} }, '*');
  });
}

let granted = new Set();
let self = { pluginId: '', slot: '' };
let cfg = {};
let state = WallpaperApply.makeState();
let history = [];
let blurDataUrl = '';
let lastFetchedDay = '';
let tickTimer = null;

window.addEventListener('message', (event) => {
  if (event.source !== HOST) return;
  const data = event.data;
  if (!data || data.v !== V) return;
  switch (data.type) {
    case 'init':
      void onInit(data);
      break;
    case 'response': {
      const slot = pending.get(data.id);
      if (!slot) return;
      pending.delete(data.id);
      if (data.ok) slot.resolve(data.result);
      else slot.reject(new Error(data.error || '宿主拒绝了这次调用'));
      break;
    }
    case 'theme':
      document.documentElement.dataset.theme = data.theme === 'light' ? 'light' : 'dark';
      break;
    case 'call':
      void onCall(data);
      break;
    default:
      break;
  }
});

// --- 存取 ------------------------------------------------------------------------

async function loadPersisted() {
  if (!granted.has(PERM.storage)) return;
  try {
    const st = await request('storage.get', { key: WallpaperApply.STATE_KEY });
    if (st && st.value) {
      const parsed = JSON.parse(st.value);
      if (parsed && parsed.phase === 'ready') {
        state = WallpaperApply.makeState(parsed);
        blurDataUrl = parsed.blurDataUrl || '';
      } else if (parsed) {
        state = WallpaperApply.makeState({ phase: 'idle' });
      }
    }
    const hi = await request('storage.get', { key: WallpaperApply.HISTORY_KEY });
    if (hi && hi.value) {
      const parsed = JSON.parse(hi.value);
      if (Array.isArray(parsed)) history = parsed;
    }
  } catch {
    // 坏档按"没有"处理。
  }
  const day = await request('storage.get', { key: 'last-day' }).catch(() => ({ value: '' }));
  lastFetchedDay = String((day && day.value) || '');
}

async function persist() {
  if (!granted.has(PERM.storage)) return;
  try {
    await request('storage.set', {
      key: WallpaperApply.STATE_KEY,
      value: JSON.stringify({ ...state, blurDataUrl: state.phase === 'ready' ? blurDataUrl : '' }),
    });
    await request('storage.set', { key: WallpaperApply.HISTORY_KEY, value: JSON.stringify(history) });
    if (lastFetchedDay) await request('storage.set', { key: 'last-day', value: lastFetchedDay });
  } catch {
    // 存不下就算了（下次重新抓）。
  }
}

// --- 核心：抓取 → 提色 → 发布 ------------------------------------------------------

/** 抓 Bing 每日壁纸（API + 图片本体）并返回 {base64, meta}。 */
async function downloadBing() {
  const host = cfg.bingHost === 'cn.bing.com' ? 'cn.bing.com' : 'www.bing.com';
  const api = `https://${host}/HPImageArchive.aspx?format=js&idx=0&n=1`;
  const resp = await request('net.fetch', { method: 'GET', url: api });
  if (!resp || resp.status !== 200) throw new Error(`Bing API 返回 ${resp && resp.status}`);
  const meta = WallpaperBing.bingParseResponse(resp.body, { host });
  const imgResp = await request('net.fetch', { method: 'GET', url: meta.url, encoding: 'base64' });
  if (!imgResp || imgResp.status !== 200) throw new Error(`壁纸图片返回 ${imgResp && imgResp.status}`);
  if (!imgResp.body) throw new Error('壁纸图片是空的');
  return { base64: imgResp.body, meta };
}

/** 从 RGBA 缓冲生成环境快照 + 模糊预览。 */
async function analyzeBuffer(buf, meta) {
  const palette = WallpaperPixels.pxExtractPalette(buf, { k: 6 });
  if (!palette.length) throw new Error('图片里没有可提取的颜色');
  const ambient = WallpaperApply.makeAmbient({
    source: meta.source,
    title: meta.title,
    url: meta.url,
    palette,
    at: Date.now(),
  });
  const blurred = WallpaperPixels.pxGaussianBlur(buf, 6);
  return { ambient, blurDataUrl: WallpaperPixels.pxBmpDataUrl(blurred) };
}

async function publish(ambient) {
  if (!granted.has(PERM.share)) return;
  await request('share.set', { name: WallpaperApply.AMBIENT_SHARE_KEY, value: JSON.stringify(ambient) });
}

/** 一次完整的环境合成（bing 或已有 base64）。失败走状态机的 error，并返回 null。 */
async function runSynthesize(source) {
  state = WallpaperApply.transition(state, { type: 'fetch-start', source });
  renderWorkshop();
  try {
    let base64;
    let meta = { source, title: '', url: '' };
    if (source === 'bing') {
      const dl = await downloadBing();
      base64 = dl.base64;
      meta = { source, title: dl.meta.title, url: dl.meta.url };
    } else {
      throw new Error('未知来源');
    }
    state = WallpaperApply.transition(state, { type: 'download-ok', title: meta.title, url: meta.url });
    renderWorkshop();

    const buf = await WallpaperDecode.decodeBase64Image(base64);
    const { ambient, blurDataUrl: blur } = await analyzeBuffer(buf, meta);
    blurDataUrl = blur;
    state = WallpaperApply.transition(state, { type: 'analyze-ok', ambient });
    history = WallpaperApply.pushHistory(history, ambient);
    lastFetchedDay = WallpaperBing.bingTodayKey();
    await publish(ambient);
    await persist();
    renderWorkshop();
    return ambient;
  } catch (err) {
    const phase = state.phase;
    state = WallpaperApply.transition(state, {
      type: phase === 'analyzing' ? 'analyze-fail' : 'download-fail',
      error: String(err && err.message || err),
    });
    renderWorkshop();
    return null;
  }
}

// --- 定时抓取（background 帧） -----------------------------------------------------

function tick() {
  if (self.slot === 'workshop') return;
  if (cfg.autoFetch === 'false') return;
  const day = WallpaperBing.bingTodayKey();
  if (day === lastFetchedDay) return;
  // 本地时间 7 点后才抓（半夜重启不抢跑）。
  const hour = new Date().getHours();
  if (hour < 7) return;
  void runSynthesize('bing').then((ambient) => {
    if (ambient && granted.has(PERM.bubble) && cfg.bubbleOnUpdate !== 'false') {
      request('bubble.say', { text: `今天的壁纸是《${ambient.title}》，我换个配色啦（${ambient.mood}）` }).catch(() => {});
    }
  });
}

function startTicker() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(tick, 30 * 60 * 1000); // 半小时看一次钟
  // 启动即试一次（补跑错过的时间窗）。
  setTimeout(tick, 3000);
}

// --- plugin.call ----------------------------------------------------------------

const CALL_HANDLERS = {
  /** 当前环境快照（没有就抛错——调用方按"未同步"处理）。 */
  ambient_now: async () => {
    if (state.phase !== 'ready') throw new Error('环境还没同步过（先抓一次壁纸）');
    return {
      primaryHex: state.primaryHex,
      gradient: state.gradient,
      mood: state.mood,
      title: state.title,
      at: state.at,
      palette: state.palette,
    };
  },
  /** 触发一次重抓（source 目前只支持 bing）。 */
  refresh: async (payload) => {
    const source = String(payload && payload.source || 'bing');
    const ambient = await runSynthesize(source);
    if (!ambient) throw new Error(state.error || '环境合成失败');
    return { primaryHex: ambient.primaryHex, mood: ambient.mood, title: ambient.title, at: ambient.at };
  },
  /** 最近 N 条历史。 */
  history: async (payload) => {
    const n = Math.max(1, Math.min(30, Number(payload && payload.limit) || 10));
    return history.slice(0, n);
  },
};

async function onCall(data) {
  const ticket = typeof data.ticket === 'string' ? data.ticket : '';
  if (!ticket) return;
  const method = typeof data.method === 'string' ? data.method : '';
  const handler = CALL_HANDLERS[method];
  if (!handler) {
    postCallResult(ticket, false, new Error(
      `壁纸联动不认识方法 ${method || '(空)'}：它只回答 ${Object.keys(CALL_HANDLERS).join(' / ')}`));
    return;
  }
  try {
    postCallResult(ticket, true, await handler(data.payload === undefined ? {} : data.payload));
  } catch (err) {
    postCallResult(ticket, false, err);
  }
}

function postCallResult(ticket, ok, value) {
  const message = { v: V, type: 'call-result', ticket, ok: Boolean(ok) };
  if (ok) message.result = value === undefined ? null : value;
  else message.error = String(value && value.message ? value.message : value);
  HOST.postMessage(message, '*');
}

// --- 工坊页 ---------------------------------------------------------------------

function renderWorkshop() {
  if (self.slot !== 'workshop') return;
  WallpaperWorkshop.wwsRenderAmbient(state.phase === 'ready' ? state : null);
  WallpaperWorkshop.wwsRenderBlur(state.phase === 'ready' ? blurDataUrl : '');
  WallpaperWorkshop.wwsRenderHistory(history);
  if (state.phase === 'error') WallpaperWorkshop.wwsSetStatus(state.error, 'danger');
  else if (state.phase === 'downloading') WallpaperWorkshop.wwsSetStatus('正在下载壁纸…');
  else if (state.phase === 'analyzing') WallpaperWorkshop.wwsSetStatus('正在提取颜色…');
  else if (state.phase === 'ready') WallpaperWorkshop.wwsSetStatus(`已同步（${state.source === 'bing' ? 'Bing' : '本机'}）`);
  WallpaperWorkshop.wwsSetBusy(state.phase === 'downloading' || state.phase === 'analyzing');
  const republish = WallpaperWorkshop.WWS.els && WallpaperWorkshop.WWS.els.republish;
  if (republish) republish.disabled = state.phase !== 'ready' || !granted.has(PERM.share);
}

async function onInit(data) {
  self = {
    pluginId: data.pluginId || '',
    slot: (data.surface && data.surface.slot) || '',
  };
  granted.clear();
  for (const name of data.granted || []) granted.add(name);
  document.documentElement.dataset.theme = data.theme === 'light' ? 'light' : 'dark';

  if (granted.has(PERM.config)) {
    try {
      const out = await request('config.get', {});
      cfg = Object.assign({}, (out && out.values) || {});
    } catch { cfg = {}; }
  }

  await loadPersisted();

  if (self.slot !== 'workshop') {
    startTicker();
    return;
  }

  WallpaperWorkshop.wwsCollectEls();
  const canFetch = granted.has(PERM.net) && granted.has(PERM.storage);
  const btn = WallpaperWorkshop.WWS.els['fetch-bing'];
  if (btn) {
    btn.disabled = !canFetch;
    if (!canFetch) btn.title = '需要授予 net.fetch 与 storage';
  }
  btn?.addEventListener('click', () => void runSynthesize('bing'));
  WallpaperWorkshop.WWS.els.republish?.addEventListener('click', () => {
    if (state.phase !== 'ready') return;
    void publish({
      at: Date.now(), source: state.source, title: state.title, url: state.url,
      primaryHex: state.primaryHex, mood: state.mood, gradient: state.gradient, palette: state.palette,
    }).then(() => WallpaperWorkshop.wwsSetStatus('环境色已重新发布')).catch((err) => {
      WallpaperWorkshop.wwsSetStatus(`发布失败：${String(err && err.message || err)}`, 'danger');
    });
  });
  renderWorkshop();
}

HOST.postMessage({ v: V, type: 'ready' }, '*');

/** 测试接缝。 */
window.__wallpaper = Object.freeze({
  request,
  handlers: CALL_HANDLERS,
  runSynthesize,
  tick,
  stopTicker: () => { if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } },
  downloadBing,
  analyzeBuffer,
  publish,
  pixels: WallpaperPixels,
  bing: WallpaperBing,
  apply: WallpaperApply,
  workshop: WallpaperWorkshop,
  snapshot: () => ({
    slot: self.slot,
    granted: [...granted],
    cfg: { ...cfg },
    state: { ...state },
    historySize: history.length,
    lastFetchedDay,
    hasBlur: Boolean(blurDataUrl),
  }),
});
