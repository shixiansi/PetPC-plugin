// app.js —— 网络词词典
//
// 这个插件做一件小事：**当别的插件问「这个词什么意思」，它答得出来**。桌宠在群里聊天时，记忆核心
// 会先把用户那句话交给这里查一遍——查到就把释义拼进 prompt，模型于是知道「尊嘟假嘟」不是地名。
//
// 三种身份（同一份文档，靠 `init.surface.slot` 分辨）：
//   background  桌宠挂的常驻帧。**不画任何东西**，只等 plugin.call。查词发生在这一面。
//   workshop    控制中心的插件页：导入词库、试查、看最近查过什么。
//   其它        老宿主可能给 'panel'：按 workshop 渲染即可（两个宿主都服务 storage/config）。
//
// 数据去哪：自带 40 条在 `lib/seed.js`（我们自己写的），其余的**由用户导入**
// （`parseChunksJSONL` 吃得下 astrbot-rag-kb / Buzzword 的 `chunks.jsonl`）。为什么不在包里附带
// 公开语料：那一份上游没有 LICENSE、明确要求"再分发需授权"，而这个插件发布在公开仓里。
'use strict';

const PROTOCOL = 1;
const STORE_IMPORTED = 'lex/imported';
const STORE_RECENT = 'log/recent';
const RECENT_CAP = 12;
/** 导入时把【详解】截到这么长：它是给人看的考据，prompt 里只留最有用的一两句。 */
const DETAIL_CAP = 240;

let self = { pluginId: '', slot: '', host: null };
const granted = new Set();
let cfg = {};
let index = buildIndex([SEED_ENTRIES]);
let importedCount = 0;
let importedAt = 0;
let ready = false;

// --- 与宿主说话 ---------------------------------------------------------------

function postToHost(message) {
  if (!window.parent) return;
  window.parent.postMessage({ v: PROTOCOL, ...message }, '*');
}

let nextId = 1;
const pending = new Map();

function request(method, payload) {
  const id = `r${nextId++}`;
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
    // 读不到就沿用上一次：设置读失败不该让查词停摆。
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

// --- 词库 ---------------------------------------------------------------------

/** 从私有存储读回导入的词条，和自带的一起建索引。 */
async function loadLexicon() {
  const rows = await readJSON(STORE_IMPORTED, []);
  const list = Array.isArray(rows) ? rows : [];
  importedCount = list.length;
  importedAt = Number((rows && rows.at) || 0) || 0;
  index = buildIndex([SEED_ENTRIES, list]);
}

/**
 * 导入一份 `chunks.jsonl`。
 *
 * 只保留查词要用的三个字段，并把【详解】截断：1200 条 × 全文约 1.2 MB，而 prompt 里真正有用的
 * 是「释义」那一句。截断后整体约 200 KB，`storage.set` 一次就写完。
 */
async function importChunks(input) {
  const blocks = Array.isArray(input) ? input : [input];
  const fresh = [];
  let skipped = 0;
  let reason = '';
  for (const block of blocks) {
    const out = parseChunksJSONL(block);
    if (out.entries.length) {
      fresh.push(...out.entries);
      skipped += out.skipped;
    } else if (!reason) {
      // 记住**第一个**失败原因：同时选了 chunks.jsonl 和 manifest.json 时，前者成功、后者本来
      // 就该被忽略，不该把整次导入判成失败。
      reason = importReason(block);
    }
  }
  if (!fresh.length) throw new Error(describeImportFailure(reason));

  // 和已有的合并（后导入的覆盖同名词条）：先导 01 释义库、再导 04 V吧黑话，两份都在。
  const existing = await readJSON(STORE_IMPORTED, []);
  const merged = new Map();
  for (const row of Array.isArray(existing) ? existing : []) {
    const entry = makeEntry(row);
    if (entry) merged.set(normalizeTerm(entry.term), entry);
  }
  for (const entry of fresh) {
    merged.set(normalizeTerm(entry.term), {
      term: entry.term,
      meaning: entry.meaning,
      example: entry.example,
      detail: entry.detail.slice(0, DETAIL_CAP),
      source: 'imported',
    });
  }
  const compact = [...merged.values()];
  await writeJSON(STORE_IMPORTED, compact);
  importedCount = compact.length;
  importedAt = Date.now();
  index = buildIndex([SEED_ENTRIES, compact]);
  return { kept: compact.length, added: fresh.length, skipped };
}

/**
 * 导入失败时说清楚**选错了哪个文件**。
 *
 * 这不是客套：那个目录里每个子文件夹都有 `manifest.json`（元数据）和 `chunks.jsonl`（词条），
 * 而 `.jsonl` 没有注册 MIME 类型，文件选择框默认只肯显示 `.json`——用户很可能选到 manifest，
 * 然后收到一句"认不出任何词条"，完全不知道下一步该做什么。
 */
function describeImportFailure(reason) {
  if (reason === 'manifest') {
    return '你选的是 manifest.json（那是元数据，没有词条）。同一个文件夹里的 chunks.jsonl 才是词条文件，选它。';
  }
  if (reason === 'noMarkers') {
    return '文件里的条目没有【词条】/【释义】结构。这个插件只收**释义型**语料（01_cheer_terms、04_vbar），风格/对话/笑话那几份（02/03/05）不是词条。';
  }
  if (reason === 'notJSONL') {
    return '认不出 JSON：需要每行一个 {"id":…,"text":"…"}，或者整份 JSON 数组。';
  }
  return '文件是空的。';
}

/** 查一次词，并把结果记进最近记录（工坊页要显示"最近查过什么"）。 */
async function lookUp(query, source) {
  const result = lookup(index, query, {
    max: cfgNum('maxHits', 1, 10, 2),
    allowPartial: cfgBool('allowPartial', true),
  });
  if (result.entries.length) {
    const recent = await readJSON(STORE_RECENT, []);
    const list = Array.isArray(recent) ? recent : [];
    list.unshift({ at: Date.now(), query: String(query).slice(0, 80), matched: result.matched, from: source });
    await writeJSON(STORE_RECENT, list.slice(0, RECENT_CAP));
  }
  return result;
}

// --- plugin.call 的 `slang` ---------------------------------------------------

/**
 * 答一次 `plugin.call {method:'slang'}`。
 *
 * 返回形状固定：`{query, matched, hits, text, total}`。`text` 是**给模型读的一段话**（查不到就是
 * 空串），调用方直接拼进 system prompt——它不该自己再排版一遍。
 */
async function handleSlang(payload) {
  if (!cfgBool('enabled', true)) {
    throw new Error('网络词词典被关掉了（在控制中心的插件设置里打开）');
  }
  const query = String((payload && payload.query) || '').slice(0, 300).trim();
  if (!query) throw new Error('slang 需要 query：要查的那个词或那句话');
  await refreshConfig();
  const result = await lookUp(query, 'call');
  return {
    query,
    matched: result.matched,
    hits: result.entries,
    total: index.entries.length,
    text: renderHits(result),
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
  if (method !== 'slang') {
    postCallResult(data && data.ticket, false, new Error(`这个插件只提供 slang，不认识 ${method || '(空)'}`));
    return;
  }
  try {
    postCallResult(data.ticket, true, await handleSlang((data && data.payload) || {}));
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
  await loadLexicon();

  if (self.slot === 'background') {
    // 常驻帧什么都不画：加个类让样式表把它彻底收起来。
    if (els.root) els.root.classList.add('view-background');
    return;
  }
  await renderWorkshop();
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

// --- 工坊页（控制中心）--------------------------------------------------------

const els = {
  root: document.getElementById('root'),
  status: document.getElementById('ws-status'),
  count: document.getElementById('ws-count'),
  file: document.getElementById('ws-file'),
  pick: document.getElementById('ws-pick'),
  note: document.getElementById('ws-note'),
  try: document.getElementById('try-input'),
  go: document.getElementById('try-go'),
  out: document.getElementById('try-out'),
  recent: document.getElementById('recent'),
};

function setNote(text, kind) {
  if (!els.note) return;
  els.note.textContent = text || '';
  els.note.className = `hint ${kind || ''}`.trim();
}

async function renderWorkshop() {
  if (els.count) {
    els.count.textContent = `${index.entries.length} 条（自带 ${SEED_ENTRIES.length}`
      + (importedCount ? `，导入 ${importedCount}` : '，还没导入')
      + '）';
  }
  if (els.status) {
    els.status.textContent = importedAt
      ? `词库就绪，最近一次导入：${new Date(importedAt).toLocaleString()}`
      : '词库就绪（只有自带的小词表）。导入一份 chunks.jsonl 可以让它认识上万条梗。';
  }
  await renderRecent();
}

async function renderRecent() {
  if (!els.recent) return;
  const rows = await readJSON(STORE_RECENT, []);
  const list = Array.isArray(rows) ? rows : [];
  els.recent.innerHTML = '';
  if (!list.length) {
    els.recent.innerHTML = '<li class="muted">还没查过。上面试一句看看。</li>';
    return;
  }
  for (const row of list) {
    const li = document.createElement('li');
    const when = new Date(Number(row.at) || 0).toLocaleTimeString();
    li.textContent = `${when}  ${row.query} → ${row.matched || '没查到'}`;
    els.recent.append(li);
  }
}

function renderTryResult(result) {
  if (!els.out) return;
  if (!result.entries.length) {
    els.out.textContent = '没查到。可以导入更大的词库，或者换个说法（模糊命中要打开）。';
    els.out.className = 'out muted';
    return;
  }
  els.out.className = 'out';
  els.out.innerHTML = '';
  for (const entry of result.entries) {
    const box = document.createElement('div');
    box.className = 'hit';
    const term = document.createElement('b');
    term.textContent = entry.term;
    const meaning = document.createElement('p');
    meaning.textContent = entry.meaning;
    box.append(term, meaning);
    if (entry.example) {
      const example = document.createElement('p');
      example.className = 'ex';
      example.textContent = `例：${entry.example}`;
      box.append(example);
    }
    els.out.append(box);
  }
}

/** 读一个用户主动选的文件（沙箱里唯一能读到的路径）。 */
function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读不了这个文件（沙箱只能读你主动选的那一个）'));
    reader.readAsText(file);
  });
}

function bindWorkshop() {
  if (!els.pick || !els.file) return;
  els.pick.addEventListener('click', () => els.file.click());
  els.file.addEventListener('change', () => {
    const files = [...(els.file.files || [])];
    if (!files.length) return;
    setNote(`正在读取 ${files.length} 个文件…`);
    // 一次选多个：01_cheer_terms 与 04_vbar 都是**释义型**，一起导进来更全（02/03/05 不是词条，
    // 选了也会被逐条跳过，不会污染词库）。
    Promise.all(files.map(readTextFile))
      .then((texts) => importChunks(texts))
      .then(({ kept, added, skipped }) => {
        setNote(`导入完成：新增 ${added} 条，词库共 ${kept} 条${skipped ? `（跳过 ${skipped} 行认不出的）` : ''}`, 'ok');
        return renderWorkshop();
      })
      .catch((err) => setNote(`导入失败：${err.message}`, 'bad'))
      .finally(() => {
        els.file.value = '';
      });
  });

  const run = () => {
    const query = String(els.try.value || '').trim();
    if (!query) return;
    void (async () => {
      const result = await lookUp(query, 'workshop');
      renderTryResult(result);
      await renderRecent();
    })();
  };
  if (els.go) els.go.addEventListener('click', run);
  if (els.try) {
    els.try.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') run();
    });
  }
}

// --- 启动 ---------------------------------------------------------------------


window.addEventListener('message', onMessage);
bindWorkshop();
postToHost({ type: 'ready' });

/** 测试接缝：纯函数在这里，行为靠 plugin-check 与预览器。 */
window.__slang = Object.freeze({
  ...SLANG_PURE,
  cfgBool,
  cfgNum,
  importChunks,
});
