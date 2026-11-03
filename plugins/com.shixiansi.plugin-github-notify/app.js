// GitHub 通知 —— 编排层：宿主桥、轮询、气泡、插件页。
//
// 形状（任务书 §2）：拉取型插件。没有 events 权限也不用——数据源是 GitHub，不是宿主；
// 拉取型的固有形状是 background 常驻帧 + 定时 tick。15 分钟（pollMin 可调）一次兜底 tick，
// ≥10s，避开 plugin-check 的 poll WARN（net.fetch 没有事件可听，poll-with-event 规则
// 管不到它：可订阅的宿主事件里没有"网络回复"这一种）。
//
// token 纪律（任务书 §2）：
//   - 手册的 secret 机制帮不上这个 token：config.get 对 secret 只回 {set,mask}，而 secret
//     能被宿主"点名使用"的去处只有 net.fetch 的 Cookie（credentials，要 net.credentials）与
//     llm.chat 的 llmApiKey——GitHub 要的是 Authorization: Bearer 头，两条路都不通。
//   - 所以 token 是普通 config 项（type:"text"）。这样它是可接受的，因为：config 只存在
//     插件自己的私有目录（宿主管；加密与否是宿主的事）、插件只在拼 net.fetch 的
//     authorization 头时用它、且本文件从不把它写进 storage / plugin.log / 气泡文案
//     （有测试钉住）。给用户的建议写在 config label 里：最小 scope token。
//   - net.fetch 的请求头白名单（手册 §6.10）只收 accept / authorization / content-type /
//     user-agent：所以带 token 的请求用 authorization，ETag 只能走 If-None-Match——它不在
//     白名单里。当前宿主把非白名单头直接丢掉（不报错），因此 ETag 的发送是"尽力而为"：
//     发出去、若生效则 304 省一次重通知；若被丢掉则退化为全量拉取 + 本地去重，两条路都正确。
//     响应头（x-ratelimit-* / ETag 的回读）net.fetch 目前不回传——reset 时间在有头时显示
//     HH:MM，没头时"稍后"（lib/core.js 的 resetLine）。

'use strict';

const PROTOCOL = 1;
const PLUGIN_ID = 'com.shixiansi.plugin-github-notify';
const HOST = window.parent;
const API = 'https://api.github.com';
let nextId = 1;
const pending = new Map();
const granted = new Set();

const KEY_STATE = 'state/v1'; // { seen, etag{notifications,events}, last, at, source }（core.emptyState 形状）
const POLL_MS_FLOOR = 10 * 60 * 1000; // 兜底 tick 下限 10 分钟

function request(method, payload) {
  const id = `r${nextId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    HOST.postMessage({ v: PROTOCOL, type: 'request', id, method, payload: payload || {} }, '*');
  });
}

// --- 状态 ----------------------------------------------------------------------

const self = { slot: '', hostMethods: null };
let cfg = { token: '', publicRepo: '', pollMin: 15, quietBubble: false };
let state = null;        // core.sanitizeState 形状；只在 canStore() 时与 storage 同步
let pollTimer = null;
let netFailStreak = 0;   // 连续断网次数：断网时静默保留状态，不清空列表

const $ = (id) => document.getElementById(id);

// 这一面有没有"宿主服务这个方法"的权威答案（手册 §5.2.1）。
function hostServes(method) {
  if (self.hostMethods) return self.hostMethods.indexOf(method) >= 0;
  if (self.slot === 'workshop') return false; // 控制中心没有 pet 专属方法（§9 的表）
  return true;
}

function canStore() { return granted.has('storage'); }
function canConfig() { return granted.has('plugin.config'); }
function canFetch() { return granted.has('net.fetch'); }
// bubble.say 是 where:'pet'：常驻帧 / 桌宠面板可以，workshop 没有（也不需要：气泡只在轮询里弹）。
function canBubble() { return granted.has('pet.bubble') && hostServes('bubble.say'); }

// --- 初始化 ----------------------------------------------------------------------

async function onInit(data) {
  for (const g of data.granted || []) granted.add(g);
  const surface = data.surface || {};
  self.slot = surface.slot || 'workshop';
  self.hostMethods = (data.host && Array.isArray(data.host.methods)) ? data.host.methods : null;
  $('root').dataset.slot = self.slot;

  // 先把能力落位说出口（§9）：这一面缺什么、哪些事做不了，在发第一个请求之前就写出来。
  paintGate();
  const gateNote = $('gate-note').textContent || '';
  if (!canFetch()) setStatus('未获授权：net.fetch（安装时未勾选网络权限），不会发任何请求。');
  else if (!canStore() && canFetch()) setStatus('未获授权：storage——能拉新通知但记不住（不落盘、不去重）。');
  else if (!cfg.token && !cfg.publicRepo && gateNote) setStatus(gateNote);

  if (canConfig()) {
    try {
      const res = await request('config.get', {});
      applyConfig(res && res.values);
    } catch { /* 设置读不到就用默认 */ }
  }
  if (canStore()) {
    try {
      const res = await request('storage.get', { key: KEY_STATE });
      state = window.__gh.core.sanitizeState(res && res.value);
    } catch {
      state = window.__gh.core.emptyState();
    }
    renderList();
  } else {
    state = window.__gh.core.emptyState(); // 内存里也能跑：只是不持久化
  }

  const background = self.slot === 'background';
  if (background) {
    if (canFetch() && (cfg.token || cfg.publicRepo)) {
      await refreshCycle(); // 挂载即拉一轮，别让用户等到第一个 tick
      startPolling();
    }
  } else {
    // 插件页：打开时刷新一次（气泡不弹——这一面轮询职责在常驻帧）。
    if (canFetch()) await refreshCycle({ fromPanel: true });
  }
  paintGate();
  setStatusFromState();
}

function applyConfig(values) {
  const v = values || {};
  cfg = {
    token: String(v.token || '').trim(),
    publicRepo: cleanRepo(String(v.publicRepo || '').trim()),
    pollMin: clampInt(v.pollMin, 1, 60, 15),
    quietBubble: String(v.quietBubble || '') === 'true',
  };
}

function cleanRepo(s) {
  // 容忍用户粘贴完整 URL：owner/repo 之外的都剥掉。
  const m = s.match(/github\.com\/([^/]+)\/([^/#?]+)/i);
  if (m) return `${m[1]}/${m[2]}`;
  return s.replace(/^\/+|\/+$/g, '');
}

function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

// --- 轮询 ----------------------------------------------------------------------

function startPolling() {
  stopPolling();
  const ms = Math.max(POLL_MS_FLOOR, cfg.pollMin * 60 * 1000);
  pollTimer = setInterval(() => { void refreshCycle().catch(() => {}); }, ms);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// 一轮 = 选源（token → notifications；否则公开仓库 events）→ ETag 条件请求 → 归一化 →
// 去重 → 新通知弹气泡 → 持久化。granted 缺哪块就安静跳过哪块，不崩。
async function refreshCycle(opts) {
  const fromPanel = opts && opts.fromPanel;
  if (!canFetch()) { setStatus('未获授权：net.fetch（安装时未勾选网络权限），不会发任何请求。'); return null; }
  if (!cfg.token && !cfg.publicRepo) {
    setStatus('还没有配置：填一个 GitHub token（拉你的通知）或公开仓库 owner/repo（拉事件流）。');
    return null;
  }

  const useNotifications = Boolean(cfg.token);
  const url = useNotifications
    ? `${API}/notifications?all=false`
    : `${API}/repos/${encodeURIComponent(cfg.publicRepo).replace(/%2F/i, '/')}/events?per_page=30`;
  const etagKey = useNotifications ? 'notifications' : 'events';
  const etag = (state && state.etag && state.etag[etagKey]) || '';

  let res;
  try {
    res = await fetchWithEtag(url, useNotifications, etag);
  } catch (err) {
    // 断网（respond ok:false）：静默保留上次状态——不清空列表、不重通知、不写 storage、不崩。
    netFailStreak += 1;
    const msg = `网络不可达：${(err && err.message) || err}。保留上次的列表（${(state && state.last.length) || 0} 条），稍后自动重试。`;
    setStatus(msg);
    showError(msg);
    return null;
  }
  netFailStreak = 0;
  hideError();

  if (res.status === 304) {
    // ETag 命中：零气泡、零重写（storage.set 一条都不发）。
    setStatus('没有变化（304）：距上次拉取 GitHub 那边没有任何新通知。');
    if (state) state.at = Date.now();
    return { status: 304, fresh: [] };
  }

  if (res.status !== 200) {
    const cls = window.__gh.core.classify(res.status, res.body, res.headers);
    showError(cls.message);
    setStatus(cls.message);
    if (state) { state.error = cls.message; state.at = Date.now(); }
    await persist(); // 错误态也落盘：插件页重开还能看到为什么
    return { status: res.status, error: cls };
  }

  const items = useNotifications
    ? window.__gh.core.parseNotifications(res.body)
    : window.__gh.core.parseEvents(res.body);
  const fresh = window.__gh.core.freshItems(items, state ? state.seen : []);

  // 去重集合：全部（不只未读的）都记下来，旧的被 GitHub 再标 unread 也不会重复吵。
  const merged = window.__gh.core.mergeSeen(state ? state.seen : [], items.map((it) => it.id));
  state = {
    seen: merged.seen,
    etag: Object.assign({}, (state && state.etag) || {}, { [etagKey]: res.etag || (state && state.etag && state.etag[etagKey]) || '' }),
    last: items,
    at: Date.now(),
    source: useNotifications ? 'notifications' : 'events',
    error: '',
  };
  await persist();

  // 气泡：新通知恰好多条时只弹第一条的摘要 + 条数（气泡只有一个，别刷屏）。
  // quietBubble / 面板触发的刷新 / workshop（canBubble 本来就是 false）都不弹。
  if (fresh.length && cfg.quietBubble !== true && !fromPanel && canBubble()) {
    const text = fresh.length === 1
      ? window.__gh.core.bubbleText(fresh[0])
      : `${window.__gh.core.bubbleText(fresh[0])}（还有 ${fresh.length - 1} 条）`;
    try {
      await request('bubble.say', { text });
    } catch { /* 气泡失败不影响列表 */ }
  }

  setStatus(`已更新：${items.length} 条${fresh.length ? `，其中 ${fresh.length} 条新的` : '，没有新的'}。`);
  return { status: 200, fresh: fresh.length, items };
}

// token 只在这里（authorization 头）与 config 之间流动，绝不进 storage / 日志 / 气泡。
async function fetchWithEtag(url, withToken, etag) {
  const headers = { accept: 'application/vnd.github+json' };
  if (withToken) headers.authorization = `Bearer ${cfg.token}`;
  if (etag) headers['if-none-match'] = etag; // 白名单外：宿主可能丢弃——见文件头注释
  const res = await request('net.fetch', { method: 'GET', url, headers });
  return {
    status: Number(res && res.status) || 0,
    body: String((res && res.body) || ''),
    headers: (res && res.headers) || null,
    // 宿主回传 ETag 的那一天这里自动生效；拿不到就 undefined，状态里存空串。
    etag: (res && res.headers && res.headers.etag) || '',
  };
}

async function persist() {
  if (!canStore() || !state) return;
  // 顺手防御：把 token 从任何要落盘的对象里剥掉（当前 state 根本不含它，测试钉死这一点）。
  const safe = JSON.parse(JSON.stringify(state));
  delete safe.token;
  await request('storage.set', { key: KEY_STATE, value: JSON.stringify(safe) }).catch(() => {});
}

// --- 插件页 ----------------------------------------------------------------------

function paintGate() {
  const background = self.slot === 'background';
  const configured = Boolean(cfg.token || cfg.publicRepo);
  $('refresh').disabled = !canFetch() || !configured;
  $('mark-read').disabled = !canStore();
  const mode = $('mode');
  if (cfg.token) {
    mode.hidden = false;
    mode.className = 'tag ok';
    mode.textContent = 'token 模式：拉取你的通知';
  } else if (cfg.publicRepo) {
    mode.hidden = false;
    mode.className = 'tag info';
    mode.textContent = `公开模式：${cfg.publicRepo} 的事件流`;
  } else {
    mode.hidden = true;
  }

  const note = $('gate-note');
  if (!canFetch()) {
    note.hidden = false;
    note.textContent = '需要 net.fetch 权限（安装时未勾选）：不发请求，列表只显示上次拉到的内容。';
  } else if (!canStore()) {
    note.hidden = false;
    note.textContent = '需要 storage 权限（安装时未勾选）：拉到的通知只在本次显示，不会记住，也不会去重。';
  } else if (!configured && !background) {
    note.hidden = false;
    note.textContent = '先在上方设置里填 token 或公开仓库，然后点「立即刷新」。';
  } else {
    note.hidden = true;
  }

  if (self.slot === 'workshop' && !hostServes('bubble.say')) {
    // 说出口（§9）：气泡这件事在桌宠侧。
    const existing = note.textContent;
    if (!existing) {
      note.hidden = false;
      note.textContent = '新通知的气泡在桌宠上（常驻帧）弹出；这一页只负责列表与标记已读。';
    }
  }
}

function renderList() {
  const items = (state && state.last) || [];
  const tbody = $('list').tBodies[0];
  tbody.textContent = '';
  if (!items.length) {
    $('list-card').hidden = true;
    $('empty-state').hidden = false;
    return;
  }
  $('list-card').hidden = false;
  $('empty-state').hidden = true;
  for (const it of items) {
    const tr = document.createElement('tr');
    tr.className = it.unread ? 'unread' : 'read';

    const tdK = document.createElement('td');
    tdK.className = 'k';
    tdK.textContent = window.__gh.core.kindLabel(it.kind);
    tr.appendChild(tdK);

    const tdR = document.createElement('td');
    tdR.className = 'repo';
    tdR.textContent = it.repo || '—';
    tr.appendChild(tdR);

    const tdT = document.createElement('td');
    tdT.className = 'title';
    if (it.url && /^https:\/\/github\.com\//.test(it.url)) {
      const a = document.createElement('a');
      a.href = it.url;
      a.target = '_blank';
      a.rel = 'noreferrer noopener';
      a.textContent = window.__gh.core.oneLine(it.title);
      tdT.appendChild(a);
    } else {
      tdT.textContent = window.__gh.core.oneLine(it.title);
    }
    tr.appendChild(tdT);

    const tdD = document.createElement('td');
    tdD.textContent = it.at ? new Date(it.at).toLocaleString() : '—';
    tr.appendChild(tdD);

    tbody.appendChild(tr);
  }
}

function setStatus(text) { $('status').textContent = text; }
function showError(text) {
  $('error-card').hidden = false;
  $('error-detail').textContent = text;
}
function hideError() {
  $('error-card').hidden = true;
  $('error-detail').textContent = '';
}

function setStatusFromState() {
  if (!state) return;
  if (state.error) { showError(state.error); }
  if (state.at) $('last-at').textContent = `上次更新 ${new Date(state.at).toLocaleString()}`;
  if ((state.last || []).length) renderList();
}

async function markAllRead() {
  if (!canStore() || !state || !(state.last || []).length) return;
  for (const it of state.last) it.unread = false;
  renderList();
  await persist();
}

// --- 杂项 ----------------------------------------------------------------------

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
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
      if (!slot) return; // 迟到的 response：安全丢弃
      pending.delete(data.id);
      if (data.ok) slot.resolve(data.result);
      else slot.reject(new Error(data.error || '宿主拒绝了这次调用'));
      break;
    }
    case 'theme':
      applyTheme(data.theme);
      break;
    default:
      break; // event / surface / 未知类型：忽略（tolerant）
  }
});

$('refresh').addEventListener('click', () => { void refreshCycle({ fromPanel: true }); });
$('mark-read').addEventListener('click', () => { void markAllRead(); });

// 测试接缝（抄 table-lab / diange 的 window.__<name> 形状）。
window.__gh = window.__gh || { core: null };
window.__gh = Object.freeze({
  core: window.__gh.core,
  state: () => ({
    slot: self.slot,
    hostMethods: self.hostMethods,
    granted: [...granted],
    cfg: { ...cfg, tokenSet: Boolean(cfg.token) },
    store: state,
    polling: Boolean(pollTimer),
    pollMs: pollTimer ? Math.max(POLL_MS_FLOOR, cfg.pollMin * 60 * 1000) : 0,
  }),
  refreshCycle,
  markAllRead,
  applyConfig,
});

HOST.postMessage({ v: PROTOCOL, type: 'ready' }, '*');
