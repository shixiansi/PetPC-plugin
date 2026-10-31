// app.js —— 网页提取插件：入口、协议泵、plugin.call 应答
//
// 一个文档，两种身份：
//
//   workshop    控制中心插件页：输入 URL → 进度 → Markdown 预览 → 文章库。
//   background  桌宠常驻帧：不画东西，随时答别的插件的 plugin.call：
//                 scrape_one {url}          → 抓一页并入库（返回 {id,title,chars}）
//                 library_list {}           → 文章索引（新→旧）
//                 library_get {id}          → 取一篇正文（给知识库/记忆核心引用）
//                 library_latest {}         → 最新一篇
//
// 与生态的联动：
//   - plugin.call 被动服务：memcore/知识库可以问"帮我读这个 URL / 给我那篇文章"；
//   - 桌宠联动：抓取完成后 bubble.say 一句（可配置关掉）；「让桌宠读这篇」走记忆核心的 chat。

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
let ready = false;

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

// --- 转换器与存储 ---------------------------------------------------------------

/** turndown 封装：懒创建（它要求全局 TurndownService 已就位）。 */
let converter = null;
function getConverter() {
  if (!converter) converter = ScraperToMd.createConverter(window.TurndownService);
  return converter;
}

const store = ScraperLibrary.libCreateStore(request);

// --- plugin.call ----------------------------------------------------------------

const CALL_HANDLERS = {
  /** 抓一页并入库。payload {url} → {id, title, chars, url} */
  scrape_one: async (payload) => {
    const url = String(payload && payload.url || '').trim();
    if (!url) throw new Error('scrape_one 需要 {url}');
    const out = await scrapeQuiet(url);
    return { id: out.page.id, title: out.page.title, chars: out.page.markdown.length, url: out.page.url };
  },
  /** 文章索引。payload {limit?} → [{id,title,host,chars,at,url}] */
  library_list: async (payload) => {
    const index = await store.loadIndex();
    const limit = Math.max(1, Math.min(50, Number(payload && payload.limit) || 20));
    return index.slice(0, limit);
  },
  /** 一篇正文。payload {id} → {id,title,url,markdown,at} */
  library_get: async (payload) => {
    const id = String(payload && payload.id || '');
    const page = await store.loadPage(id);
    if (!page) throw new Error(`文章库里没有 ${id || '(空 id)'}`);
    return { id: page.id, title: page.title, url: page.url, markdown: page.markdown, at: page.at };
  },
  /** 最新一篇。payload {} → 同 library_get */
  library_latest: async () => {
    const index = await store.loadIndex();
    if (!index.length) throw new Error('文章库还是空的');
    const page = await store.loadPage(index[0].id);
    if (!page) throw new Error('最新一篇的正文读不到了（索引与正文不一致）');
    return { id: page.id, title: page.title, url: page.url, markdown: page.markdown, at: page.at };
  },
};

async function onCall(data) {
  const ticket = typeof data.ticket === 'string' ? data.ticket : '';
  if (!ticket) return;
  const method = typeof data.method === 'string' ? data.method : '';
  const handler = CALL_HANDLERS[method];
  if (!handler) {
    postCallResult(ticket, false, new Error(
      `网页提取不认识方法 ${method || '(空)'}：它只回答 ${Object.keys(CALL_HANDLERS).join(' / ')}`));
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

/** 静默抓取：不碰 UI 的进度，只走业务链路。 */
async function scrapeQuiet(url) {
  return ScraperScrape.scrapeRun({
    request,
    extractor: (html) => ScraperExtract.extractArticle(html),
    toMarkdown: (html, opts) => getConverter().toMarkdown(html, opts),
    store,
  }, { url });
}

// --- 工坊页 ---------------------------------------------------------------------

let currentIndex = [];
let currentId = '';
let busy = false;

async function refreshIndex() {
  currentIndex = await store.loadIndex();
  if (self.slot === 'workshop') {
    ScraperWorkshop.wsRenderLibrary(currentIndex, openLibraryPage, currentId);
  }
  return currentIndex;
}

async function openLibraryPage(id) {
  try {
    const page = await store.loadPage(id);
    if (!page) {
      ScraperWorkshop.wsSetStatus('这篇的正文已经不在了（可能被更新的文章挤出了库）', 'danger');
      return;
    }
    currentId = id;
    ScraperWorkshop.wsRenderPreview(page.markdown);
    ScraperWorkshop.wsRenderPicked(page.picked || null);
    ScraperWorkshop.wsSetStatus(`已打开：${page.title}`);
    ScraperWorkshop.wsRenderLibrary(currentIndex, openLibraryPage, currentId);
  } catch (err) {
    ScraperWorkshop.wsSetStatus(`打开失败：${String(err && err.message || err)}`, 'danger');
  }
}

async function runScrape(url) {
  if (busy) return;
  busy = true;
  ScraperWorkshop.wsSetBusy(true);
  ScraperWorkshop.wsRenderPicked(null);
  try {
    const onStep = (step) => {
      ScraperWorkshop.wsSetProgress(step);
    };
    const out = await ScraperScrape.scrapeRun({
      request,
      extractor: (html) => ScraperExtract.extractArticle(html),
      toMarkdown: (html, opts) => getConverter().toMarkdown(html, opts),
      store,
    }, { url, onStep });
    currentId = out.page.id;
    ScraperWorkshop.wsRenderPreview(out.page.markdown);
    ScraperWorkshop.wsRenderPicked(out.page.picked);
    await refreshIndex();
    await notifyPet(out.page);
  } catch (err) {
    ScraperWorkshop.wsSetProgress(null);
    ScraperWorkshop.wsSetStatus(String(err && err.message || err), 'danger');
  } finally {
    busy = false;
    ScraperWorkshop.wsSetBusy(false);
  }
}

/** 桌宠联动：抓完弹一句（可配置）；失败不打断主流程。 */
async function notifyPet(page) {
  if (!cfg.bubbleAfterScrape || cfg.bubbleAfterScrape === 'false') return;
  if (!granted.has(PERM.bubble)) return;
  try {
    await request('bubble.say', { text: `文章已收进库：《${page.title}》（${page.markdown.length} 字）` });
  } catch {
    // 气泡失败不算失败。
  }
}

/** 「让桌宠读这篇」：把正文交给记忆核心的 chat，让它用自己的话讲一遍。 */
async function askPetToRead() {
  if (!currentId) return;
  const send = ScraperWorkshop.WS.els && ScraperWorkshop.WS.els['send-pet'];
  try {
    if (send) send.disabled = true;
    const page = await store.loadPage(currentId);
    if (!page) throw new Error('正文已经不在了');
    ScraperWorkshop.wsSetStatus('正在让桌宠读这篇（走记忆核心）…');
    const reply = await request('plugin.call', {
      target: 'com.shixiansi.plugin-memcore/chat',
      method: 'chat',
      payload: {
        text: `请用三句话以内，讲讲下面这篇文章讲了什么：\n\n标题：${page.title}\n${page.markdown.slice(0, 4000)}`,
      },
    });
    ScraperWorkshop.wsSetStatus(`桌宠说：${String(reply && reply.text || reply).slice(0, 200)}`);
  } catch (err) {
    ScraperWorkshop.wsSetStatus(`桌宠读不了：${String(err && err.message || err)}`, 'danger');
  } finally {
    if (send) send.disabled = !currentId;
  }
}

async function saveHosts() {
  const ta = ScraperWorkshop.WS.els && ScraperWorkshop.WS.els.hosts;
  if (!ta || !granted.has(PERM.config)) return;
  const lines = String(ta.value || '').split('\n').map((l) => l.trim()).filter(Boolean);
  try {
    await request('config.set', { values: { extraHosts: lines.join(',') } });
    cfg.extraHosts = lines.join(',');
    ScraperWorkshop.wsSetStatus(`白名单已保存（${lines.length} 个域）`);
  } catch (err) {
    ScraperWorkshop.wsSetStatus(`保存失败：${String(err && err.message || err)}`, 'danger');
  }
}

// --- init -----------------------------------------------------------------------

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

async function onInit(data) {
  self = {
    pluginId: data.pluginId || '',
    slot: (data.surface && data.surface.slot) || '',
  };
  granted.clear();
  for (const name of data.granted || []) granted.add(name);
  applyTheme(data.theme);
  ready = true;

  if (granted.has(PERM.config)) {
    try {
      const out = await request('config.get', {});
      cfg = Object.assign({}, (out && out.values) || {});
    } catch {
      cfg = {};
    }
  } else {
    // 没授予 plugin.config：控件不该装成能保存设置。
    cfg = {};
  }

  if (self.slot !== 'workshop') {
    // 常驻帧（background）：不画任何东西，随时答 plugin.call。
    return;
  }

  ScraperWorkshop.wsCollectEls();
  const canScrape = granted.has(PERM.net) && granted.has(PERM.storage);
  const go = ScraperWorkshop.WS.els.go;
  if (go) {
    go.disabled = !canScrape;
    if (!canScrape) {
      go.title = '需要授予 net.fetch 与 storage';
    }
  }
  const hosts = ScraperWorkshop.WS.els.hosts;
  if (hosts) hosts.value = String(cfg.extraHosts || '').split(',').map((s) => s.trim()).filter(Boolean).join('\n');
  if (!granted.has(PERM.call)) {
    const send = ScraperWorkshop.WS.els['send-pet'];
    if (send) send.title = '需要授予 plugin.call（问记忆核心）';
  }
  go?.addEventListener('click', () => {
    const url = String(ScraperWorkshop.WS.els.url.value || '').trim();
    void runScrape(url);
  });
  ScraperWorkshop.WS.els.url?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void runScrape(String(ScraperWorkshop.WS.els.url.value || '').trim());
  });
  ScraperWorkshop.WS.els['send-pet']?.addEventListener('click', () => void askPetToRead());
  ScraperWorkshop.WS.els['hosts-save']?.addEventListener('click', () => void saveHosts());

  if (granted.has(PERM.storage)) {
    await refreshIndex().catch(() => {});
  }
}

HOST.postMessage({ v: V, type: 'ready' }, '*');

/** 测试接缝：协议泵之外，行为都在 lib/*（纯函数优先），这里只暴露编排好的入口。 */
window.__scraper = Object.freeze({
  request,
  handlers: CALL_HANDLERS,
  scrapeQuiet,
  runScrape,
  openLibraryPage,
  refreshIndex,
  askPetToRead,
  saveHosts,
  store,
  // 测试接缝：四个 lib 命名空间（纯函数优先，行为测试从这条缝进去）。
  extract: ScraperExtract,
  tomd: ScraperToMd,
  library: ScraperLibrary,
  scrape: ScraperScrape,
  workshop: ScraperWorkshop,
  snapshot: () => ({
    slot: self.slot,
    ready,
    granted: [...granted],
    cfg: { ...cfg },
    busy,
    currentId,
    indexSize: currentIndex.length,
  }),
});
