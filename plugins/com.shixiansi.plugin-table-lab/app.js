// 表格分析（纯面板插件）：CSV → 类型推断 → 分组统计 → SVG 概览图 →（可选）模型解读。
//
// 一个文档两种挂载（都是 kind:'panel'，按 slot 分）：
//   slot 'chat'      桌宠侧的对话槽面板：全部功能可用
//   slot 'workshop'  控制中心插件页：解析与统计照常，llm.chat / bubble.say 是 where:'pet'
//                    的方法、这一面没有——按 init.host.methods 降级（§5.2.1），按钮置灰
//                    并说一句"模型只在桌宠侧可用"，绝不把请求发出去等拒绝。
//
// 铁律（任务书）：**不读磁盘路径**。CSV 只从 <input type=file> 与拖拽进（FileReader / File
// API 在 opaque origin 里可用，手册 §6.6 的图片走的就是同一条路）。内容**不进 storage**：
// 持久化的只有统计摘要与文件名（>1 MiB 的整体落键会被宿主拒写，这里从源头就不发）。

'use strict';

// --- 宿主桥 --------------------------------------------------------------------

const PROTOCOL = 1;
const PLUGIN_ID = 'com.shixiansi.plugin-table-lab';
const HOST = window.parent;
let nextId = 1;
const pending = new Map();
const granted = new Set();

function request(method, payload) {
  const id = `t${nextId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    HOST.postMessage({ v: PROTOCOL, type: 'request', id, method, payload: payload || {} }, '*');
  });
}

// --- 状态 ----------------------------------------------------------------------

const self = { slot: '', hostMethods: null };
let cfg = { maxHistBins: 16 };
let current = null; // { fileName, bytes, header, rows, digest, at } —— 内存态，原始内容只在这里

const KEY_SUMMARY = 'summary';      // 上一次分析的统计摘要（文本，几千字符量级）
const KEY_FILENAME = 'summary-name';
const KEY_AT = 'summary-at';
const MAX_STORED_DIGEST = 8000;     // 摘要键的上限：列数极多时截断，绝不逼近 1 MiB

const $ = (id) => document.getElementById(id);

// 这一面有没有"宿主服务这个方法"的权威答案（§5.2.1）：有 host 表就查表，没有退回 slot 猜。
function hostServes(method) {
  if (self.hostMethods) return self.hostMethods.indexOf(method) >= 0;
  if (self.slot === 'workshop') return false; // 控制中心没有 pet 专属方法（§9 的表）
  return true;
}

// llm.chat / bubble.say 都是 where:'pet'：要先过 granted，再过本窗口的能力表。
function canChat() { return granted.has('llm.chat') && hostServes('llm.chat'); }
function canBubble() { return granted.has('pet.bubble') && hostServes('bubble.say'); }
function canStore() { return granted.has('storage'); }
function canConfig() { return granted.has('plugin.config'); }

// --- 初始化 ----------------------------------------------------------------------

async function onInit(data) {
  for (const g of data.granted || []) granted.add(g);
  const surface = data.surface || {};
  self.slot = surface.slot || 'workshop';
  self.hostMethods = (data.host && Array.isArray(data.host.methods)) ? data.host.methods : null;
  $('root').dataset.slot = self.slot;

  setStatus(canConfig() || canStore() ? '已就绪' : '未获授权：storage / plugin.config');
  if (canConfig()) {
    try {
      const res = await request('config.get', {});
      const n = Number(res && res.values && res.values.maxHistBins);
      if (Number.isFinite(n) && n >= 8 && n <= 40) cfg.maxHistBins = Math.round(n);
    } catch { /* 设置读不到就用默认值：16 格 */ }
  }
  if (canStore()) {
    try {
      const [s, name, at] = await Promise.all([
        request('storage.get', { key: KEY_SUMMARY }).catch(() => ({ value: '' })),
        request('storage.get', { key: KEY_FILENAME }).catch(() => ({ value: '' })),
        request('storage.get', { key: KEY_AT }).catch(() => ({ value: '' })),
      ]);
      const digest = String((s && s.value) || '');
      if (digest) showHistory({
        fileName: String((name && name.value) || ''),
        digest,
        at: Number((at && at.value) || 0) || 0,
      });
    } catch { /* 历史读不到不致命 */ }
  }
  paintGate();
}

// 能力落位：不该能用的控件禁用，并且**说出口**（§9：降级要有一行说明，不是静默藏掉）。
function paintGate() {
  const chatOK = canChat();
  const bubbleOK = canBubble();
  $('ask').disabled = !chatOK || !current;
  $('bubble').disabled = !bubbleOK || !current;
  const note = $('llm-note');
  if (!chatOK) {
    note.hidden = false;
    note.textContent = self.slot === 'workshop' && !(self.hostMethods || []).includes('llm.chat')
      ? '模型只在桌宠侧可用：这里（控制中心的插件页）没有模型能力，统计与图照常，"请模型解读"请到桌宠侧的表格分析面板使用。'
      : '模型解读需要授予 llm.chat 权限（安装时未勾选），按钮因此置灰。';
  } else {
    note.hidden = true;
    note.textContent = '';
  }
}

// --- 文件进入（FileReader / File API；不读磁盘路径） -------------------------------

const MAX_PARSE = 8 * 1024 * 1024; // 8 MiB：再大的 CSV 解析已无意义，明确拒绝而不是卡死页面

function bindFileInput() {
  $('pick').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', () => {
    const file = $('file').files && $('file').files[0];
    if (file) void ingestFile(file);
  });

  const drop = $('drop');
  for (const ev of ['dragenter', 'dragover']) {
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.dataset.over = 'true';
    });
  }
  for (const ev of ['dragleave', 'drop']) {
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.dataset.over = 'false';
    });
  }
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    const dt = e.dataTransfer;
    const file = dt && dt.files && dt.files[0];
    if (file) void ingestFile(file);
    else showError('拖进来的不是文件：请拖一个 CSV（或 TSV）。');
  });
}

async function ingestFile(file) {
  hideError();
  const bytes = file.size || 0;
  const isCsvish = /\.(csv|tsv|txt)$/i.test(file.name) || /text\/(csv|tab-separated|plain)/.test(file.type || '');
  if (!isCsvish) {
    showError(`这不是文本表格文件：${file.name}。请给 .csv / .tsv（或纯文本）文件。`);
    return;
  }
  if (bytes > MAX_PARSE) {
    showError(`文件太大（${fmtBytes(bytes)}）：本插件按 8 MiB 上限就地解析，更大的表格请先拆分。`);
    return;
  }
  setStatus(`正在读取 ${file.name}（${fmtBytes(bytes)}）…`);
  let text = '';
  try {
    text = await readAsText(file);
  } catch (err) {
    showError(`读不出这个文件：${(err && err.message) || err}`);
    return;
  }
  analyze(text, { fileName: file.name, bytes });
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(new Error('FileReader 读文件失败'));
    fr.onabort = () => reject(new Error('读取被中断'));
    fr.readAsText(file, 'utf-8'); // BOM 在 lib/csv.js 里剥（首列名不带 \uFEFF）
  });
}

// --- 分析主路径 --------------------------------------------------------------------

function analyze(text, meta) {
  const parsed = window.TableLab.parseCSV(text);
  if (parsed.empty) {
    // 空文件（0 字节、全空行）：不崩，给出明确的空态。
    current = null;
    renderEmptyTable(meta ? meta.fileName : '');
    setStatus('这是一个空表格：没有表头，也没有数据行。换一个 CSV 试试。');
    paintGate();
    return;
  }
  const digest = window.TableLab.digestText(parsed.header, parsed.rows, meta.fileName);
  current = {
    fileName: meta.fileName,
    bytes: meta.bytes,
    header: parsed.header,
    rows: parsed.rows,
    digest,
    at: Date.now(),
  };
  renderStats(parsed.header, parsed.rows);
  renderChart(parsed.header, parsed.rows);
  renderEmptyHidden();
  setStatus(`已分析：${parsed.rows.length} 行 × ${parsed.header.length} 列（分隔符 ${parsed.delimiter === '\t' ? 'Tab' : parsed.delimiter === ';' ? '分号' : '逗号'}）`);
  paintGate();
  void persistSummary(digest, meta.fileName, current.at);
}

// 只存统计摘要与文件名（铁律：原始内容 >1 MiB 不落 storage；这里任何内容都不落）。
async function persistSummary(digest, fileName, at) {
  if (!canStore()) return;
  const kept = digest.length > MAX_STORED_DIGEST ? `${digest.slice(0, MAX_STORED_DIGEST)}…（截断）` : digest;
  await request('storage.set', { key: KEY_SUMMARY, value: kept }).catch(() => {});
  await request('storage.set', { key: KEY_FILENAME, value: String(fileName || '') }).catch(() => {});
  await request('storage.set', { key: KEY_AT, value: String(at) }).catch(() => {});
}

function showHistory(rec) {
  $('history-card').hidden = false;
  const when = rec.at ? new Date(rec.at).toLocaleString() : '';
  $('history').textContent = `${rec.fileName || '（未命名）'}${when ? ` · ${when}` : ''}\n${rec.digest}`;
}

// --- 渲染 ----------------------------------------------------------------------

function renderStats(header, rows) {
  const s = window.TableLab.summarize(header, rows);
  const tbody = $('stats').tBodies[0];
  tbody.textContent = '';
  for (const c of s.cols) {
    const tr = document.createElement('tr');
    const cells = [
      c.name,
      c.type === 'number' ? '数字' : c.type === 'date' ? '日期' : '文本',
      String(c.count),
      String(c.unique),
      c.min !== undefined ? window.TableLab.fmtNum(c.min) : '—',
      c.max !== undefined ? window.TableLab.fmtNum(c.max) : '—',
      c.mean !== undefined ? window.TableLab.fmtNum(c.mean) : '—',
    ];
    for (const text of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  $('overview').hidden = false;
}

function renderChart(header, rows) {
  const ov = window.TableLab.overviewSVG(header, rows, { bins: cfg.maxHistBins });
  const chart = $('chart');
  chart.innerHTML = ov.svg; // lib 生成、转义过的 SVG 字符串；数据值不直接进属性
  const note = $('chart-note');
  note.hidden = false;
  note.textContent = ov.detail;
}

function renderEmptyTable(fileName) {
  $('overview').hidden = true;
  $('chart').innerHTML = '';
  $('chart-note').hidden = true;
  $('file-name').hidden = true;
  $('file-meta').hidden = true;
  renderEmptyHidden();
  showEmptyState(fileName
    ? `${fileName} 是一个空表格：没有表头，也没有数据行。`
    : '还没有表格。选一个 CSV（或 TSV），统计与概览图会出现在这里。');
}

function renderEmptyHidden() {
  $('empty-state').hidden = true;
  $('interpret').hidden = false;
  if (current) {
    $('file-name').hidden = false;
    $('file-name').textContent = current.fileName;
    $('file-meta').hidden = false;
    $('file-meta').textContent = `${current.fileName} · ${fmtBytes(current.bytes)} · 已分析于 ${new Date(current.at).toLocaleTimeString()}`;
  }
}

function showEmptyState(text) {
  const box = $('empty-state');
  box.hidden = false;
  const sub = box.querySelector('.empty-sub');
  if (sub) sub.textContent = text;
}

// --- 模型解读（llm.chat）与桌宠气泡（bubble.say） ------------------------------------
//
// 按钮在 paintGate() 里按 granted + hostServes 置灰：workshop 那一面根本没有这两个方法，
// 请求永远不会发出去（不发出去再等拒绝，§9）。

async function askModel() {
  if (!current || !canChat()) return;
  const btn = $('ask');
  btn.disabled = true;
  setStatus('正在请模型解读统计摘要…');
  try {
    const prompt = [
      '下面是一个 CSV 文件的统计摘要（列名、类型、行数、每列的非空数/不同值/min/max/mean）。',
      '请用不超过 8 行的中文解读：这份数据大概是什么、哪些列值得注意、有没有一眼可见的异常',
      '（空值多、极端值、唯一值几乎每行不同之类）。不要编造数据里没有的结论。',
      '',
      current.digest,
    ].join('\n');
    const res = await request('llm.chat', { text: prompt, system: '你是数据分析助手：只依据给出的统计摘要说话，简短、具体。' });
    const answer = $('answer');
    answer.hidden = false;
    answer.textContent = String((res && res.text) || '（模型没有返回内容）');
    setStatus('模型解读完成。');
  } catch (err) {
    // 宿主的 error 是给人看的中文句子，原文显示（§5.3 第 5 条）。
    showError(`模型解读失败：${(err && err.message) || err}`);
    setStatus('模型解读失败。');
  } finally {
    btn.disabled = !canChat() || !current;
  }
}

async function sayConclusion() {
  if (!current || !canBubble()) return;
  const first = current.digest.split('\n').filter(Boolean).slice(0, 2).join('；');
  try {
    await request('bubble.say', { text: `表格分析：${first}`.slice(0, 200) });
  } catch (err) {
    showError(`桌宠没说出这句话：${(err && err.message) || err}`);
  }
}

// --- 杂项 ----------------------------------------------------------------------

function setStatus(text) { $('status').textContent = text; }
function showError(text) { const el = $('error'); el.hidden = false; el.textContent = text; }
function hideError() { const el = $('error'); el.hidden = true; el.textContent = ''; }

function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

// --- 消息循环（监听器先装，再发 ready —— §5.3 第 1 条） ------------------------------

window.addEventListener('message', (event) => {
  if (event.source !== HOST) return;
  const data = event.data;
  if (!data || data.v !== PROTOCOL) return;
  switch (data.type) {
    case 'init':
      void onInit(data);
      break;
    case 'response': {
      const slot = pending.get(data.id);
      if (!slot) return; // 迟到的 response：安全丢弃（§5.3 第 4 条）
      pending.delete(data.id);
      if (data.ok) slot.resolve(data.result);
      else slot.reject(new Error(data.error || '宿主拒绝了这次调用'));
      break;
    }
    case 'theme':
      document.documentElement.dataset.theme = data.theme === 'light' ? 'light' : 'dark';
      break;
    default:
      break; // event / surface / 未知类型：忽略（tolerant）
  }
});

$('ask').addEventListener('click', () => { void askModel(); });
$('bubble').addEventListener('click', () => { void sayConclusion(); });
bindFileInput();

// 测试接缝：把内存态与关键开关交给 jsdom（抄 diange / calendar 的 window.__<name> 形状）。
window.__tablelab = Object.freeze({
  state: () => ({
    slot: self.slot,
    hostMethods: self.hostMethods,
    granted: [...granted],
    cfg: { ...cfg },
    current: current && {
      fileName: current.fileName,
      bytes: current.bytes,
      rows: current.rows.length,
      cols: current.header.length,
      digest: current.digest,
    },
  }),
  ingestText: (text, fileName) => analyze(String(text ?? ''), { fileName: String(fileName || '（拖入）'), bytes: (text || '').length }),
});

HOST.postMessage({ v: PROTOCOL, type: 'ready' }, '*');
