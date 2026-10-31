// app.js —— 媒体同步：入口、轮询、now_playing 工具
//
// 一个文档，三种身份：
//
//   background  常驻帧：唯一的工人。轮询 outbox、发布 share、挂徽标、答 now_playing
//   workshop    控制中心插件页：只读的"正在播放"卡片 + 最近听过的几首
//   (无 surface) 输出是徽标、共享键与 Tool 答案
//
// 数据流（每个键只有一个写者）：
//
//   辅助脚本(SMTC) ──写──> outbox/media ──本文件轮询──> share.set media-now
//                                                └──────> pet.badge ♪ 曲目
//   别的插件/模型 ──plugin.call now_playing──> { playing, title, artist, text }
//
// 模型侧的接法（与 memcore 的 search 同型）：任何接入了大模型的插件在自己的
// callTargets 里加 com.shixiansi.plugin-media-sync/now_playing，把用户"我在听什么"
// 的问题原样转发，答案放回模型上下文。

'use strict';

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

function clamp(text, n) {
  const s = String(text ?? '');
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…';
}

function now() {
  return Date.now();
}

async function refreshConfig() {
  try {
    const out = await request('config.get', {});
    cfg = Object.assign({}, (out && out.values) || {});
  } catch {
    // 沿用旧值。
  }
}

// --- 轮询：outbox → share / badge / 最近列表 -------------------------------------

let lastBadge = null;      // 上一条徽标（同样的曲目不重挂）
let recent = [];           // 最近听过的曲目（工坊页显示；上限 10）

async function pollOnce() {
  const out = await request('storage.get', { key: 'outbox/media' }).catch(() => ({ value: '' }));
  const track = parseTrack(out && out.value, now());

  const actions = [];
  if (track && !track.error) {
    actions.push({ share: SHARE_NOW, value: track });
    // showBadge=false：整个徽标功能关闭（连"清除"也不发——用户没戴过这个徽标）。
    const badgeEnabled = String(cfg.showBadge ?? 'true') !== 'false';
    if (badgeEnabled) {
      const badge = badgeFor(track);
      if (badge !== lastBadge) {
        actions.push({ badge });
        lastBadge = badge;
      }
    }
    // playing 的新曲目才进"最近"：暂停/恢复不刷列表。
    if (track.status === 'playing' && track.title) {
      const key = `${track.title}|${track.artist}`;
      if (!recent.length || recent[0].key !== key) {
        recent = [{ key, title: track.title, artist: track.artist, at: track.at }, ...recent].slice(0, 10);
        actions.push({ store: 'recent' });
      }
    }
  }
  for (const action of actions) {
    if (action.share && granted.has(PERM.share)) {
      await request('share.set', { name: action.share, value: JSON.stringify(action.value) }).catch(() => {});
    }
    if (action.badge !== undefined && granted.has(PERM.surface)) {
      await request('pet.badge', { text: action.badge }).catch(() => {});
    }
    if (action.store === 'recent' && granted.has(PERM.storage)) {
      await request('storage.set', { key: 'recent', value: JSON.stringify(recent) }).catch(() => {});
    }
  }
  return track;
}

let pollGen = 0;
let pollTimer = 0;

// 兜底间隔：宿主会为"你的私有目录变了"发 storage.changed（手册 §7.2），这个定时器只负责
// "事件丢了"。1 秒 → 15 秒，日志里那每秒一条 storage.get 就没了（2026-10-31 一天 659 行）。
const POLL_FALLBACK_MS = 15000;
const POLL_KEYS = ['outbox/media'];

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
    const track = await pollOnce();
    renderWorkshop(track);
  } catch {
    // 一轮失败不算什么。
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

// --- plugin.call：now_playing 工具 ----------------------------------------------

const CALL_HANDLERS = {
  /** 模型问"我在听什么"：返回 {playing, title?, artist?, album?, status?, text}。 */
  now_playing: async () => {
    const out = await request('storage.get', { key: 'outbox/media' }).catch(() => ({ value: '' }));
    const track = parseTrack(out && out.value, now());
    return trackAnswer(track, now());
  },
};

async function onCall(data) {
  const ticket = typeof data.ticket === 'string' ? data.ticket : '';
  if (!ticket) return;
  const method = typeof data.method === 'string' ? data.method : '';
  const handler = CALL_HANDLERS[method];
  if (!handler) {
    postCallResult(ticket, false, new Error(
      `媒体同步不认识方法 ${method || '(空)'}：它只回答 ${Object.keys(CALL_HANDLERS).join(' / ')}`));
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
  for (const id of ['note', 'track-card', 'track-line', 'track-state', 'recent-card', 'recent-list', 'helper-card', 'helper-state']) {
    els[id] = document.getElementById(id);
  }
}

function renderWorkshop(track) {
  if (self.slot !== 'workshop') return;
  if (els['track-line']) {
    els['track-line'].textContent = track && track.title
      ? `${track.title}${track.artist ? ' — ' + track.artist : ''}`
      : '现在没在放';
  }
  if (els['track-state'] && track) {
    els['track-state'].textContent = { playing: '播放中', paused: '已暂停', stopped: '已停止', unknown: '未知' }[track.status] || track.status;
  }
  if (els['recent-list']) {
    els['recent-list'].replaceChildren(...recent.slice(0, 10).map((item) => {
      const li = document.createElement('li');
      li.textContent = `${item.title}${item.artist ? ' — ' + item.artist : ''}`;
      return li;
    }));
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

  // 最近列表先从盘上读回来（常驻帧重启不清零）。
  if (granted.has(PERM.storage)) {
    const saved = await request('storage.get', { key: 'recent' }).catch(() => ({ value: '[]' }));
    try {
      const parsed = JSON.parse(saved.value || '[]');
      if (Array.isArray(parsed)) recent = parsed.slice(0, 10);
    } catch { /* 坏了就当没有 */ }
  }

  if (self.slot === 'workshop') {
    startPollLoop();
    return;
  }

  // 常驻帧：辅助脚本由宿主托管（manifest 的 sidecar），这里只轮询它写的文件。
  //
  // 以前这一段要用户先在设置里填两个绝对路径——插件拿不到自己的安装目录，所以"自己启动"
  // 只能这么写；2026-10-31 的实测是四个这样写的插件因此从来没跑起来过。
  if (granted.has(PERM.process)) {
    started = true;
    setNote('辅助脚本由宿主托管（SMTC 监听；没起来就看桌宠日志）');
  } else {
    setNote('未获授权：process（只能读已有的 outbox）');
  }
  startPollLoop();
}

collectEls();
HOST.postMessage({ v: V, type: 'ready' }, '*');

/** 测试接缝。 */
window.__media = Object.freeze({
  pollOnce,
  stopPoll,
  handlers: CALL_HANDLERS,
  snapshot: () => ({ slot: self.slot, granted: [...granted], started, lastBadge, recent, note: currentNote }),
});
