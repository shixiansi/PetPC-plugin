// app.js —— 萌娘百科插件
//
// 三件事：握手、回答 `plugin.call` 的 `slang` / `wiki`、以及一个能试查的插件页。
//
// 为什么对外提供**两个**方法名而不是一个：
//   · `slang` 是"这个词什么意思"（记忆核心在本地词库查不到时的第一顺位补位）；
//   · `wiki`  是"这个东西是什么"（角色/作品/事件）。同一个实现，两个入口，是因为**语义不同**：
//     调用方按意图挑选，而不是把一句话硬塞进一个通道里。
//
// 内容许可是 CC BY-NC-SA 3.0 CN：所以每次回答都带来源链接与许可标注（见 lib/api.js 的 renderEntry），
// 而且**只在运行时取**、不缓存进包里。
'use strict';

const PROTOCOL = 1;
const CACHE_PREFIX = 'cache/entry/';

let self = { pluginId: '', slot: '', host: null };
const granted = new Set();
let cfg = {};
let ready = false;
let lastNote = '';

// --- 与宿主说话 ---------------------------------------------------------------

function postToHost(message) {
  if (!window.parent) return;
  window.parent.postMessage({ v: PROTOCOL, ...message }, '*');
}

let nextId = 1;
const pending = new Map();

function request(method, payload) {
  const id = `m${nextId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    postToHost({ type: 'request', id, method, payload: payload === undefined ? {} : payload });
  });
}

function onResponse(data) {
  const slot = pending.get(data.id);
  if (!slot) return;
  pending.delete(data.id);
  if (data.ok) slot.resolve(data.result);
  else slot.reject(new Error(data.error || '宿主拒绝了这次请求'));
}

function can(permission) {
  return granted.has(permission);
}

async function readJSON(key, fallback) {
  if (!can('storage')) return fallback;
  try {
    const out = await request('storage.get', { key });
    const raw = out && typeof out.value === 'string' ? out.value : '';
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

async function writeJSON(key, value) {
  if (!can('storage')) return;
  await request('storage.set', { key, value: JSON.stringify(value) }).catch(() => {});
}

async function refreshConfig() {
  if (!can('plugin.config')) return;
  try {
    const out = await request('config.get', {});
    cfg = Object.assign({}, (out && out.values) || {});
  } catch {
    // 读不到就沿用上一次。
  }
}

function cfgBool(key, fallback) {
  const raw = cfg[key];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return String(raw).toLowerCase() === 'true';
}

function cfgNum(key, min, max, fallback) {
  const value = Number(cfg[key]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

// --- 查询 ---------------------------------------------------------------------

/** 一次 net.fetch，返回 body 文本（失败抛出带原因的错误）。 */
async function fetchText(url) {
  const out = await request('net.fetch', { method: 'GET', url, headers: { accept: 'application/json', 'user-agent': UA } });
  if (!out || out.status < 200 || out.status >= 300) {
    throw new Error(`萌娘百科返回 HTTP ${out && out.status ? out.status : '?'}`);
  }
  return String(out.body || '');
}

/**
 * 查一个词条。返回 `{title, extract, url, text, cached}`；查不到返回 null（不是异常——"没有这个条目"
 * 是正常结果，调用方据此换下一家）。
 */
async function lookUpEntry(query) {
  const asked = String(query || '').trim().slice(0, 120);
  if (!asked) throw new Error('需要 query：要查的那个词');

  const ttlMin = cfgNum('cacheTtlMin', 0, 100000, 720);
  const cacheKey = CACHE_PREFIX + encodeURIComponent(asked);
  if (ttlMin > 0) {
    const hit = await readJSON(cacheKey, null);
    if (hit && typeof hit.at === 'number' && Date.now() - hit.at < ttlMin * 60000 && hit.extract) {
      return { ...hit, cached: true };
    }
  }

  // ① 先解析成真实条目名（别名/重定向都在这一步消化）
  const opened = parseOpenSearch(await fetchText(openSearchURL(asked, 3)));
  const title = opened.length ? opened[0].title : asked;
  const url = opened.length ? opened[0].url : '';

  // ② 再取序言正文
  const maxChars = cfgNum('maxChars', 120, 4000, 600);
  const page = parseExtract(await fetchText(extractURL(title, maxChars)));
  if (!page) return null;

  const entry = { title: page.title || title, extract: page.extract, url, at: Date.now() };
  await writeJSON(cacheKey, entry);
  return { ...entry, cached: false };
}

/** 两个方法共用同一份实现：`slang` 与 `wiki` 的差别只在调用方的意图，不在查询本身。 */
async function handleLookup(payload) {
  if (!cfgBool('enabled', true)) {
    throw new Error('萌娘百科插件被关掉了（在控制中心的插件设置里打开）');
  }
  if (!can('net.fetch')) throw new Error('缺 net.fetch 权限：安装时要授予它才能联网查');
  await refreshConfig();
  const entry = await lookUpEntry((payload && payload.query) || '');
  const maxChars = cfgNum('maxChars', 120, 4000, 600);
  if (!entry) {
    lastNote = `没查到「${(payload && payload.query) || ''}」`;
    return { query: String((payload && payload.query) || ''), title: '', text: '', entry: null };
  }
  lastNote = `${entry.title}${entry.cached ? '（缓存）' : ''}`;
  return {
    query: String((payload && payload.query) || ''),
    title: entry.title,
    entry,
    text: renderEntry(entry, maxChars),
    source: 'moegirl',
  };
}

function postCallResult(ticket, ok, value) {
  const message = { type: 'call-result', ticket, ok: Boolean(ok) };
  if (ok) message.result = value === undefined ? null : value;
  else message.error = String(value && value.message ? value.message : value);
  postToHost(message);
}

async function onCall(data) {
  const method = String((data && data.method) || '');
  if (method !== 'slang' && method !== 'wiki') {
    postCallResult(data && data.ticket, false, new Error(`这个插件只提供 slang / wiki，不认识 ${method || '(空)'}`));
    return;
  }
  try {
    postCallResult(data.ticket, true, await handleLookup((data && data.payload) || {}));
  } catch (err) {
    postCallResult(data.ticket, false, err);
  }
}

// --- 身份 ---------------------------------------------------------------------

async function onInit(payload) {
  self = {
    pluginId: payload.pluginId || '',
    slot: (payload.surface && payload.surface.slot) || '',
    host: payload.host && Array.isArray(payload.host.methods) ? payload.host : null,
  };
  granted.clear();
  for (const name of payload.granted || []) granted.add(name);
  applyTheme(payload.theme);
  ready = true;
  await refreshConfig();

  if (self.slot === 'background') {
    if (els.root) els.root.classList.add('view-background');
    return;
  }
  renderWorkshop();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

function onMessage(event) {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.v !== PROTOCOL) return;
  switch (data.type) {
    case 'init':
      void onInit(data);
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
      break;
  }
}

// --- 插件页 -------------------------------------------------------------------

const els = {
  root: document.getElementById('root'),
  status: document.getElementById('ws-status'),
  input: document.getElementById('try-input'),
  go: document.getElementById('try-go'),
  out: document.getElementById('try-out'),
  note: document.getElementById('ws-note'),
};

function setNote(text, kind) {
  if (!els.note) return;
  els.note.textContent = text || '';
  els.note.className = `hint ${kind || ''}`.trim();
}

function renderWorkshop() {
  if (els.status) {
    const fetchReady = can('net.fetch');
    els.status.textContent = fetchReady
      ? `可以查（缓存 ${cfgNum('cacheTtlMin', 0, 100000, 720)} 分钟，单次取 ${cfgNum('maxChars', 120, 4000, 600)} 字）`
      : '缺 net.fetch 权限：安装时要授予它才能联网查。';
    els.status.className = fetchReady ? 'value' : 'value warn';
  }
}

function renderResult(result) {
  if (!els.out) return;
  if (!result || !result.text) {
    els.out.textContent = '没查到。换个写法试试（萌娘百科是条目制的，全名比简称更容易命中）。';
    els.out.className = 'out muted';
    return;
  }
  els.out.className = 'out';
  els.out.textContent = result.text;
}

function bindWorkshop() {
  if (!els.go) return;
  const run = () => {
    const query = String(els.input.value || '').trim();
    if (!query) return;
    setNote('查询中…');
    void handleLookup({ query })
      .then((result) => {
        renderResult(result);
        setNote(lastNote || '', result.text ? 'ok' : 'bad');
      })
      .catch((err) => setNote(`查询失败：${err.message}`, 'bad'));
  };
  els.go.addEventListener('click', run);
  if (els.input) {
    els.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') run();
    });
  }
}

window.addEventListener('message', onMessage);
bindWorkshop();
postToHost({ type: 'ready' });

/** 测试接缝：纯函数，以及两个纯装配用的工具。 */
window.__moegirl = Object.freeze({
  ...MOEGIRL_PURE,
  cfgBool,
  cfgNum,
});
