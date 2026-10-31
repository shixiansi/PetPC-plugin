// app.js —— 系统与 DSH 感知：入口、轮询、发布
//
// 一个文档，三种身份：
//
//   background  常驻帧：唯一的工人。轮询 outbox、发布 share、挂徽标、答 plugin.call
//   workshop    控制中心插件页：只读的当前状态（系统 / DSH / 辅助脚本健康）
//   (无 surface) 这个插件不占浮层面——它的输出是徽标与共享键，不是一块屏幕
//
// 为什么流水线只住在 background：采样与 DSH 推送都要发生在"没人看着"的时候
// （手册 §7 的送达条件）。工坊页只读牌盘，5 秒刷一次（与 websearch/memcore 同一型）。
//
// 数据流（每个键只有一个写者，手册 §6.3）：
//
//   辅助脚本 ──写──> outbox/{system,load,dsh} ──本文件轮询──> share.set（自己名下的键）
//   DSH ──POST :3210──> 辅助脚本 ──┘
//   别的插件 ──shareRead: sense/*──> 只读快照
//   工坊页 ──plugin.call status──> 本文件回答当前一切
//
// 启动辅助脚本走 process.launch（clipask 的同一条路）：把脚本写进 storage.dir 给的
// 目录，启动用户配置的 powershell.exe 去跑它；参数里带上 outbox 的绝对路径。

'use strict';

// sampler 的判定函数并进同一作用域（panel.html 会在 app.js 之前加载 lib/sampler.js，
// 这里引用的是那边的全局；测试用 new Function 把两份拼起来跑）。

const V = 1;
const HOST = window.parent;
let nextId = 1;
const pending = new Map();

const PERM = {
  process: 'process',
  share: 'plugin.share',
  call: 'plugin.call',
  storage: 'storage',
  config: 'plugin.config',
  surface: 'pet.surface',
};

/** 与宿主说话的唯一通道。 */
function request(method, payload) {
  const id = 'r' + nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    HOST.postMessage({ v: V, type: 'request', id, method, payload: payload ?? {} }, '*');
  });
}

let granted = new Set();
let self = { pluginId: '', slot: '' };
let cfg = {};
let started = false;

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
    case 'event':
      onHostEvent(data);
      break;
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

// --- 小工具 -------------------------------------------------------------------

function el(id) {
  return document.getElementById(id);
}

function clamp(text, n) {
  const s = String(text ?? '');
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…';
}

function now() {
  return Date.now();
}

// --- 配置 ---------------------------------------------------------------------

async function refreshConfig() {
  try {
    const out = await request('config.get', {});
    cfg = Object.assign({}, (out && out.values) || {});
  } catch {
    // 沿用旧值。
  }
}

function intervalSec() {
  const n = Number.parseInt(String(cfg.sampleInterval ?? '5'), 10);
  return Number.isFinite(n) ? Math.min(60, Math.max(2, n)) : 5;
}

function cpuThreshold() {
  const n = Number.parseFloat(String(cfg.cpuThreshold ?? '80'));
  return Number.isFinite(n) ? Math.min(99, Math.max(10, n)) : 80;
}

/** 负载要连续几次才报（默认 3 次 × 5 秒 = 15 秒的持续高压，一次尖峰不惊扰）。 */
function highStreak() {
  const n = Number.parseInt(String(cfg.highStreak ?? '3'), 10);
  return Number.isFinite(n) ? Math.min(12, Math.max(1, n)) : 3;
}

// --- 辅助脚本（由宿主托管：manifest 的 sidecar） -----------------------------------
//
// 插件不再自己 process.launch：它拿不到自己的安装目录，所以"自己启动"必然要求用户手填两个
// 绝对路径（2026-10-31 的实测：四个这样写的插件因此从没跑起来过）。现在宿主在插件启用且
// 授予 process 时启动它，脚本从 PETPC_PLUGIN_DATA 拿到该往哪写。
//
// 采样间隔、阈值、连续次数这些**设置项仍然生效**：它们经 config 落到插件，插件读 outbox 时
// 用的还是同一份判定（lib/sampler.js）。只有"谁启动脚本"这件事搬到了宿主。

// --- 轮询：outbox → share / badge ----------------------------------------------
//
// 键名**不带扩展名**，而且这不是风格问题：宿主的存储键每一段只允许 `[A-Za-z0-9_-]`
// （手册 §6.3），`outbox/system.json` 会被判为非法键、整个 `storage.get` 不执行。真机上
// 这件事的表现是"插件装了但什么都不做"——245 行 WARN 在日志里，界面上一片安静
// （2026-10-30）。辅助脚本按**绝对路径**写文件，所以它那边的文件名必须和这里的键逐字一致。

let lastDshAt = 0;
let lastLoad = null;

// 辅助脚本一句话都不说的时候，这个插件在界面上完全没有痕迹：没有徽标、没有分享值，用户只会说
// "感知功能没用"。宿主给了 plugin.log（手册 §6.13），所以连续几次全空之后写一条 WARN——
// 4 次 ≈ 60 秒（兜底一拍 15 秒）。只在"一直没数据"的那一段里说一次，数据回来就重置。
const EMPTY_POLLS_BEFORE_WARNING = 4;
let emptyPolls = 0;

/** 往宿主的日志里写一行。plugin.log 借 storage 授权（手册 §6.13），所以先看有没有。 */
function logLine(level, message) {
  if (!granted.has(PERM.storage)) return Promise.resolve();
  return request('plugin.log', { level, message }).catch(() => {});
}

async function pollOnce() {
  const [sysRaw, loadRaw, dshRaw] = await Promise.all([
    request('storage.get', { key: 'outbox/system' }).catch(() => ({ value: '' })),
    request('storage.get', { key: 'outbox/load' }).catch(() => ({ value: '' })),
    request('storage.get', { key: 'outbox/dsh' }).catch(() => ({ value: '' })),
  ]);
  const anyData = [sysRaw, loadRaw, dshRaw].some((r) => String((r && r.value) || '').trim());
  if (!anyData) {
    emptyPolls += 1;
    if (emptyPolls === EMPTY_POLLS_BEFORE_WARNING) {
      void logLine('warn',
        'outbox/system、outbox/load、outbox/dsh 一直是空的：辅助脚本可能没起来。它由宿主托管（manifest 的 sidecar 字段），桌宠日志里的 sidecar 行会写明原因');
    }
  } else {
    emptyPolls = 0;
  }

  const system = parseSnapshot(sysRaw && sysRaw.value, now());
  const load = parseSnapshot(loadRaw && loadRaw.value, now());
  const dsh = parseSnapshot(dshRaw && dshRaw.value, now(), 24 * 3600 * 1000);

  const actions = planActions({
    system: system && { cpu: system.cpu, memUsedGb: system.memUsedGb, memTotalGb: system.memTotalGb, memPct: system.memPct, at: system.at },
    load: load && { high: load.high, consecutive: load.consecutive, cpu: load.cpu, memPct: load.memPct, at: load.at },
    dsh: dsh && { state: dsh.state, tool: dsh.tool, note: dsh.note, at: dsh.at },
    prevDshAt: lastDshAt,
    prevLoad: lastLoad,
  });

  for (const action of actions) {
    if (action.share && granted.has(PERM.share)) {
      await request('share.set', { name: action.share, value: JSON.stringify(action.value) }).catch(() => {});
    }
    if (action.share === FILE_LOAD) {
      lastLoad = action.value;
    }
    if (action.share === FILE_DSH) {
      lastDshAt = action.value.at || lastDshAt;
    }
    if (action.badge !== undefined && granted.has(PERM.surface)) {
      await request('pet.badge', { text: action.badge }).catch(() => {});
    }
  }
  return { system, load, dsh };
}

/** 轮询代数：stopPoll 之后旧的 tick 链全部失效（不靠 clearTimeout 猜时序）。 */
let pollGen = 0;
let pollTimer = 0;

// 兜底间隔。
//
// 宿主会为"你的私有目录变了"发一条 storage.changed（手册 §7.2），所以这个定时器只负责
// "事件丢了"这种情况。1 秒改成 15 秒之后，日志里那每秒一条 storage.get 就没了——
// 2026-10-31 的日志里这个插件一天写了 660 行，全是同一个值。
const POLL_FALLBACK_MS = 15000;
// 这个插件真正关心的键（宿主给的是 storage.get 的键形状：/ 分隔、无扩展名）。
const POLL_KEYS = ['outbox/system', 'outbox/load', 'outbox/dsh'];

function schedule(delay) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    pollTimer = 0;
    void tick();
  }, delay);
}

async function tick() {
  const gen = pollGen;
  try {
    const snap = await pollOnce();
    renderWorkshop(snap);
  } catch {
    // 一轮失败不算什么：下一轮再来。
  }
  if (gen === pollGen) schedule(POLL_FALLBACK_MS);
}

function startPollLoop() {
  pollGen += 1;
  schedule(0);
}

function stopPoll() {
  pollGen += 1;
  clearTimeout(pollTimer);
  pollTimer = 0;
}

/** 宿主说"你的私有目录变了"（storage.changed）：立刻读一次，不等兜底定时器。 */
function onHostEvent(data) {
  if (!data || data.name !== 'storage.changed') return;
  const key = data.payload && data.payload.key;
  if (typeof key === 'string' && !POLL_KEYS.includes(key)) return;
  schedule(0);
}

// --- plugin.call：别的插件问"现在怎么样" -----------------------------------------

const CALL_HANDLERS = {
  /** status: 一次拿全当前快照（别的插件不想自己解析三份 share）。 */
  status: async () => {
    const snap = await pollOnce();
    return {
      system: snap.system || null,
      load: snap.load || null,
      dsh: snap.dsh || null,
      helper: { started, note: currentNote },
    };
  },
};

async function onCall(data) {
  const ticket = typeof data.ticket === 'string' ? data.ticket : '';
  if (!ticket) return;
  const method = typeof data.method === 'string' ? data.method : '';
  const handler = CALL_HANDLERS[method];
  if (!handler) {
    postCallResult(ticket, false, new Error(
      `系统感知不认识方法 ${method || '(空)'}：它只回答 ${Object.keys(CALL_HANDLERS).join(' / ')}`));
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

// --- 工坊页（只读） ---------------------------------------------------------------

let currentNote = '';

function setNote(text) {
  currentNote = text || '';
  if (els.note) els.note.textContent = currentNote;
}

const els = {};

function collectEls() {
  for (const id of ['note', 'system-card', 'cpu', 'mem', 'dsh-card', 'dsh-state', 'dsh-tool', 'dsh-note', 'helper-card', 'helper-state']) {
    els[id] = document.getElementById(id);
  }
}

function renderWorkshop(snap) {
  if (self.slot !== 'workshop') return;
  if (snap && snap.system) {
    if (els.cpu) els.cpu.textContent = `CPU ${snap.system.cpu >= 0 ? snap.system.cpu.toFixed(0) : '—'}% · 内存 ${snap.system.memUsedGb}/${snap.system.memTotalGb} GB（${snap.system.memPct}%）`;
  }
  if (snap && snap.dsh) {
    if (els['dsh-state']) els['dsh-state'].textContent = { thinking: '思考中', tool: '在用工具', done: '完成', error: '出错' }[snap.dsh.state] || snap.dsh.state;
    if (els['dsh-tool']) els['dsh-tool'].textContent = snap.dsh.tool ? `工具：${snap.dsh.tool}` : '';
    if (els['dsh-note']) els['dsh-note'].textContent = snap.dsh.note || '';
  }
  if (els['helper-state']) els['helper-state'].textContent = started ? '运行中' : '未启动';
}

// --- init ----------------------------------------------------------------------

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
  collectEls();

  await refreshConfig().catch(() => {});

  if (self.slot === 'workshop') {
    // 控制中心不服务 process/pet.badge：这一页只显示共享键里的最近快照。
    startPollLoop();
    return;
  }

  // 常驻帧：辅助脚本由宿主托管（manifest 的 sidecar），这里只轮询它写的文件。
  if (granted.has(PERM.process)) {
    setNote('辅助脚本由宿主托管（采样 · HTTP 3210；没起来就看桌宠日志）');
  } else {
    setNote('未获授权：process（只能读已有的 outbox）');
  }
  startPollLoop();
}

HOST.postMessage({ v: V, type: 'ready' }, '*');

/** 测试接缝：判定逻辑是纯函数（lib/sampler.js），这里的接缝只暴露轮询的一次。 */
window.__sense = Object.freeze({
  pollOnce,
  stopPoll,
  handlers: CALL_HANDLERS,
  snapshot: () => ({ slot: self.slot, granted: [...granted], started, lastDshAt, lastLoad, note: currentNote }),
});
