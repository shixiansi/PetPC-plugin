'use strict';

// 表格分析 —— 一个文档，两副面孔。
//
//   workshop  控制中心的插件页：拖入 → FileReader 读文本 → 解析 → 类型 → 分组 → SVG 条形图。
//   surface   桌宠旁边那张 300×150 的卡片：行列数、一行分组结论，以及唯一一个真调模型的按钮。
//   （background 不声明，但宿主仍可能把 entry 挂成常驻帧；那种情况下按卡片画，什么都不发。）
//
// 为什么模型按钮只在卡片上：llm.chat 只在桌宠那个程序里被服务，控制中心的插件页不服务它
// （手册 §9）。在这一页硬发就是一条必被拒的请求——真机上「本程序不支持该方法」那 571 行
// 日志就是这么来的。所以这一页把按钮换成一行说明，而不是"发出去被拒再兜底"：
// 后者不是降级，是把噪音换成了好看。
//
// 两个挂载之间没有共享内存（手册 §1），所以"当前表格"走私有目录：
//   summary/current   workshop 写，卡片读（一个键只有一个写者）
// 卡片靠 storage.changed 事件立刻刷新，另有 15 秒兜底（手册 §7.2：没有帧就收不到事件）。
//
// 文件只用 FileReader 读。宿主从不让插件看磁盘路径，而用户交到这个页面的 File 就是全部输入：
// 这里没有 process.*、没有绝对路径、也没有第二次读盘的机会。

const V = 1;
const HOST = window.parent;
const SUMMARY_KEY = 'summary/current';
const CHAT_TEXT_MAX = 4000; // 手册 §6.6：llm.chat 的 text ≤4000 字符
const CHAT_SYSTEM =
  '你是表格分析助手。用户给的是一份 CSV 算出统计摘要，不是聊天。用中文回答，三句话以内，' +
  '只说摘要里能看出来的事：这张表在讲什么、分组最明显的集中或偏斜、一句数据质量提醒。' +
  '不要编造摘要里没有的数字，也不要复述摘要原文。';
const DEFAULT_CONFIG = { maxPreviewRows: 200, delimiter: ',', encoding: 'auto' };

// 老宿主没有 init.host 时退回到手册 §9 那张表：控制中心不服务这些。
// 只列这个插件真的会用的那**一个**——背一整张表正是"背错表"的来源，而一张长表里
// 迟早会混进一个"顺手加上去"的名字。
const PET_ONLY = ['llm.chat'];

let nextId = 1;
const pending = new Map();

let granted = new Set();
let hostInfo = null;
let slot = '';
let view = 'boot';
let config = Object.assign({}, DEFAULT_CONFIG);
let table = null;
let fileName = '';
let groupIndex = -1;
let summaryState = null;
let cardTimer = 0;
let busy = false;
// 设置读不到时留一句话，等界面自己的状态行落定之后一起显示：否则"已就绪"会盖掉
// 那条"现在用的是默认值"，而用户正好是来改设置的。
let configNote = '';

/** 与宿主说话的唯一通道。复制这段是安全的：它就是协议本身。 */
function request(method, payload) {
  const id = 'r' + nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    HOST.postMessage({ v: V, type: 'request', id, method, payload: payload == null ? {} : payload }, '*');
  });
}

function can(permission) {
  return granted.has(permission);
}

/** 这个窗口服务不服务某个方法。优先问 init.host，别背那张表（手册 §5.2.1）。 */
function serves(method) {
  if (hostInfo && Array.isArray(hostInfo.methods)) return hostInfo.methods.includes(method);
  return slot === 'workshop' ? !PET_ONLY.includes(method) : true;
}

// --- 协议 -------------------------------------------------------------------

window.addEventListener('message', (event) => {
  if (event.source !== HOST) return;
  const data = event.data;
  if (!data || data.v !== V) return;

  switch (data.type) {
    case 'init':
      void onInit(data);
      break;
    case 'response': {
      const slotForId = pending.get(data.id);
      if (!slotForId) return; // 过期或未知的 id：丢掉，不要报错
      pending.delete(data.id);
      if (data.ok) slotForId.resolve(data.result);
      else slotForId.reject(new Error(data.error || '宿主拒绝了这次调用'));
      break;
    }
    case 'theme':
      document.documentElement.dataset.theme = data.theme === 'light' ? 'light' : 'dark';
      break;
    case 'event':
      // storage.changed 是"插件页刚算完一份表"到卡片的通道（手册 §7.2，不需要 events 授权）。
      // config.changed 在两个宿主里都是直达的（§7），设置改完立刻用新值。
      if (data.name === 'storage.changed' && view === 'card') void readSummary({ quiet: true });
      else if (data.name === 'config.changed') void reloadConfig();
      break;
    default:
      break;
  }
});

async function onInit(data) {
  granted = new Set(Array.isArray(data.granted) ? data.granted : []);
  hostInfo = data.host && typeof data.host === 'object' ? data.host : null;
  const surface = data.surface || {};
  slot = String(surface.slot || '');
  // kind 不能用来判断：常驻帧的 kind 也是 panel（手册 §5.2）。slot 才是权威。
  view = slot === 'workshop' ? 'workshop' : 'card';
  if (data.theme === 'light' || data.theme === 'dark') document.documentElement.dataset.theme = data.theme;

  const root = document.getElementById('root');
  if (root) root.dataset.view = view;
  show(el('workshop'), view === 'workshop');
  show(el('card'), view === 'card');

  await loadConfig();
  if (view === 'workshop') initWorkshop();
  else initCard();
}

async function reloadConfig() {
  await loadConfig();
  if (view === 'workshop' && table) renderAll();
}

/** 设置读不到就用默认值：界面照常能用，只是不按用户的偏好走。 */
async function loadConfig() {
  // 没授予就别发（手册 §5.3 第 2 条：init 之前、以及没授权时的请求都是白噪音）。
  if (!can('plugin.config')) return;
  try {
    const result = await request('config.get', {});
    config = mergeConfig(result && result.values);
    configNote = '';
  } catch (err) {
    config = Object.assign({}, DEFAULT_CONFIG);
    configNote = '读不到设置（' + err.message + '），先用默认值：最多 200 行、逗号分隔。';
    if (view === 'workshop') setStatus(configNote);
  }
}

function mergeConfig(values) {
  const raw = values && typeof values === 'object' ? values : {};
  const merged = Object.assign({}, DEFAULT_CONFIG);

  const rows = Number(raw.maxPreviewRows);
  if (Number.isFinite(rows) && rows > 0) merged.maxPreviewRows = Math.min(Math.floor(rows), 5000);

  const delimiter = String(raw.delimiter == null ? '' : raw.delimiter);
  if (delimiter === '\\t' || delimiter === 'tab') merged.delimiter = '\t';
  else if (delimiter.length >= 1 && delimiter.length <= 4) merged.delimiter = delimiter;

  const encoding = String(raw.encoding || 'auto').toLowerCase();
  if (encoding === 'utf-8' || encoding === 'utf8') merged.encoding = 'utf-8';
  else if (encoding === 'gbk' || encoding === 'gb18030') merged.encoding = 'gbk';
  else merged.encoding = 'auto';

  return merged;
}

// --- 工坊页 -----------------------------------------------------------------

function initWorkshop() {
  const drop = el('drop');
  const input = el('file');
  if (!drop || !input) return;

  drop.addEventListener('dragover', (event) => {
    event.preventDefault();
    drop.classList.add('is-over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('is-over');
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    void handleFile(file);
  });
  // 拖到页面别处时别让浏览器自己打开那个文件——那会把插件页换成一个裸文本视图。
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());

  const pickBtn = el('pick-btn');
  if (pickBtn) pickBtn.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    void handleFile(file);
    input.value = ''; // 允许再选同一个文件（改完内容试第二遍是常事）
  });

  show(el('result'), false);
  showCardAsk(false);
  if (!can('storage')) {
    setStatus('没有 storage 授权：这一页照常分析，但结果传不到桌宠那张卡片上。');
  } else if (configNote) {
    setStatus('已就绪 · ' + configNote);
  } else {
    setStatus('已就绪 · 把一份 CSV 拖进来');
  }
}

/** 模型那一格：工坊页只有说明，卡片才有按钮（llm.chat 不在这里被服务）。 */
function showCardAsk(on) {
  const ask = el('card-ask');
  if (ask) show(ask, on);
  const note = el('llm-note');
  if (note) show(note, !on);
}

async function handleFile(file) {
  if (!file || busy) return;
  busy = true;
  setStatus('正在读取 ' + (file.name || '文件') + '…');
  try {
    const text = await readFileText(file);
    applyText(text, file.name || '');
  } catch (err) {
    setStatus('读不了这个文件：' + err.message);
  } finally {
    busy = false;
  }
}

/**
 * 唯一一处碰文件内容的地方。
 *
 * FileReader 的 encoding 参数是这里"支持 GBK"的全部实现——浏览器自己会解码，插件不写解码器。
 * auto 就不传 label（浏览器按 UTF-8 读，旧表格请用户在设置里选 GBK）。老环境不认 label 时
 * 退回默认：宁可读出一堆乱码让用户看得见，也不要静默丢掉整份文件。
 */
function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result == null ? '' : reader.result));
    reader.onerror = () => reject(new Error('浏览器读不出这个文件的字节'));
    const label = encodingLabel();
    if (!label) {
      reader.readAsText(file);
      return;
    }
    try {
      reader.readAsText(file, label);
    } catch (err) {
      reader.readAsText(file);
    }
  });
}

function encodingLabel() {
  if (config.encoding === 'gbk') return 'gbk';
  if (config.encoding === 'utf-8') return 'utf-8';
  return '';
}

function applyText(text, name) {
  const rows = parseCsv(text, config.delimiter);
  const built = buildTable(rows, { maxRows: config.maxPreviewRows });
  if (!built.header.length) {
    table = null;
    groupIndex = -1;
    showWorkshopEmpty('这个文件里没有内容，也没有表头——空文件和只有空白的文件都读不出列。');
    setStatus('空表格：没有可分析的列。');
    return;
  }
  table = built;
  fileName = name;
  groupIndex = pickGroupColumn(built.columns, built.rows);
  renderAll();
  const bits = ['已读入 ' + (name || '文件') + '：' + built.rows.length + ' 行 × ' + built.header.length + ' 列'];
  if (built.truncated) bits.push('只统计了前 ' + built.rows.length + ' 行（文件里共 ' + built.totalRows + ' 行）');
  if (!built.rows.length) bits.push('只有表头，没有数据行');
  setStatus(bits.join(' · '));
  void publishSummary();
}

function renderAll() {
  if (!table) return;
  const column = table.columns.find((item) => item.index === groupIndex) || null;
  const pairs = column ? groupCounts(table.rows, groupIndex) : [];
  renderWorkshopTable({ fileName, table, groupIndex, column, pairs });
}

/** 用户点了另一列的「按 X」按钮。 */
function onGroupPick(index) {
  if (!table || busy) return;
  groupIndex = Number(index);
  renderAll();
  void publishSummary();
}

/**
 * 把"当前表格"写进私有目录，卡片读它。
 *
 * 写的是结论而不是整张表：卡片只有 300×150，而 storage 的单个值虽然有 1 MiB，但把一份
 * 200 行的表塞进去只是给下一个读它的人（和模型）制造一个必须再截断的东西。
 */
async function publishSummary() {
  if (!table) return;
  const payload = buildSummary(table, groupIndex, fileName);
  if (!payload) return;
  if (!can('storage')) {
    setStatus('这份表只在当前页面里：没有 storage 授权，桌宠那张卡片看不到它。');
    return;
  }
  try {
    await request('storage.set', { key: SUMMARY_KEY, value: JSON.stringify(payload) });
  } catch (err) {
    setStatus('算完了，但存不进私有目录：' + err.message + '（这一页照常看）');
  }
}

// --- 卡片 -------------------------------------------------------------------

function initCard() {
  showCardAsk(true);
  const ask = el('card-ask');
  if (ask) ask.addEventListener('click', () => void askModel());

  const canAsk = can('llm.chat') && serves('llm.chat');
  renderCard({ summary: null, canAsk, message: '' });
  renderCardReply(canAsk ? '把一份 CSV 拖进插件页，这里就会出现它的行列数与分组结论。' : '这个窗口没服务 llm.chat：统计照常显示，模型解读要在桌宠那边的卡片上点。');

  void readSummary();
  // 事件是主路径（storage.changed），这一拍只是"事件丢了"的兜底：15 秒，不是 1 秒（手册 §7.2）。
  cardTimer = setInterval(() => void readSummary({ quiet: true }), 15000);
}

async function readSummary(options) {
  const quiet = !!(options && options.quiet);
  if (!can('storage')) {
    renderCardReply('没有 storage 授权：读不到插件页里算出来的那张表。', { error: true });
    return;
  }
  try {
    const result = await request('storage.get', { key: SUMMARY_KEY });
    const raw = String((result && result.value) || '');
    if (!raw) {
      summaryState = null;
      renderCard({ summary: null, canAsk: can('llm.chat') && serves('llm.chat'), message: '' });
      return;
    }
    // 这份摘要就是本插件自己写的；万一坏了（手工改过、旧版本写的），当作没有，别让卡片崩。
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      parsed = null;
    }
    summaryState = parsed && typeof parsed === 'object' ? parsed : null;
    renderCard({ summary: summaryState, canAsk: can('llm.chat') && serves('llm.chat'), message: '' });
    if (summaryState && !quiet) renderCardReply('点「让模型解读」，让它读这段统计说三句话。');
  } catch (err) {
    // 宿主的原话直接显示：它是中文的、说清了是哪一件事（手册 §5.3 第 5 条）。
    renderCardReply('读不到当前表格：' + err.message, { error: true });
  }
}

function setAskBusy(on) {
  const ask = el('card-ask');
  if (!ask) return;
  ask.disabled = on || !summaryState || !can('llm.chat') || !serves('llm.chat');
  ask.textContent = on ? '模型在读…' : '让模型解读';
}

async function askModel() {
  if (!summaryState) return;
  if (!serves('llm.chat') || !can('llm.chat')) {
    renderCardReply('这个窗口没有 llm.chat 授权，模型解读要在桌宠那边的卡片上点。', { error: true });
    return;
  }
  setAskBusy(true);
  renderCardReply('正在让模型读这份统计…');
  // 送给模型的只有浓缩摘要，绝不是整张表（text ≤4000 字符就够了，我们连 1800 都不到）。
  const digest = buildDigest(summaryState).slice(0, CHAT_TEXT_MAX);
  try {
    const result = await request('llm.chat', { text: digest, system: CHAT_SYSTEM.slice(0, CHAT_TEXT_MAX) });
    const reply = String((result && result.text) || '').trim();
    renderCardReply(reply || '模型没有给出文字。');
  } catch (err) {
    // 模型只是"加一段话"，不是主路径：卡片上面那两行（行列数、分组结论）一个字都不动。
    renderCardReply('模型解读失败：' + err.message, { error: true });
  } finally {
    setAskBusy(false);
  }
}

// 这里**没有** bubble.say：结论就写在卡片上，用户已经看着它了。喊一嗓子要多申请一项
// pet.bubble——申请了却不调用，就是让用户在安装对话框里多答一个什么也不做的开关。

// **监听器装好之后**才握手：init 可能在你 post 完的下一个任务就到达（手册 §5.3 第 1 条）。
HOST.postMessage({ v: V, type: 'ready' }, '*');
