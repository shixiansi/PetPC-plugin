// lib/workshop.js —— 两副面孔的接线：常驻帧干活、工坊页显示
//
// 常驻帧（slot === 'background'）：
//   订阅 ws.message / ws.state，把每一帧弹幕交给 queue.push，定时心跳 + 抽取。
//   **什么都不画**：els.workshop 在这个文档里根本不存在。
//
// 工坊页（slot === 'workshop'）：
//   每 2 秒拉一次状态快照（在线人数、队列深度、统计），滚动渲染最近的弹幕。
//   它不持有连接——那是常驻帧的事；它只读，外加一个「开始/停止监听」按钮，
//   通过 share 的 command 键把意图递过去（两副面孔之间没有共享内存，手册 §1）。
//
//   这个键是单向的：工坊写、常驻帧读。谁读它谁就是 bot。

'use strict';

// --- 共享状态（本进程内） ------------------------------------------------------

const queue = DanmakuQueue.create(500);
const dmFeed = [];               // 最近几条弹幕（工坊显示；重启清零是可接受的）
const DM_FEED_MAX = 30;
let liveStats = { online: 0, watched: 0 };
let persistTimer = null;
let heartbeatTimer = null;
let reconcileTimer = null;

/** 本进程看到的最近一次状态（工坊页与测试接缝都用它）。 */
function liveSnapshot() {
  // 两处错误都成立：桥连不上与互动失败互不覆盖（后发生的照样可见）。
  const errors = [liveConn.lastError, interactState.lastError].filter(Boolean).join('；');
  return {
    running: interactRunning(),
    wanted: liveConn.wanted,
    open: liveConn.open,
    platform: liveConn.platform,
    lastError: errors,
    online: liveStats.online,
    watched: liveStats.watched,
    room: roomLabel(),
    counters: { ...interactState.counters },
    queue: DanmakuQueue.snapshot(queue),
    feed: dmFeed.slice(-12).reverse(),
  };
}

// --- 常驻帧 -------------------------------------------------------------------

function startBot() {
  // 连接是幂等的：开着时 openDanmaku 直接返回 true。
  const cfgNow = { ...cfg };
  void (async () => {
    const ok = await openDanmaku(cfgNow);
    if (!ok) {
      // 桥连不上不挡互动循环：收不到弹幕时抽取自然为空，宿主重连后一切照旧。
      // 要说的是"桥没连上"，而不是把整个监听器停在半路。
      noteError(`弹幕桥没有连上：${liveConn.lastError}`);
    } else {
      liveStats.watched += 1;
      noteError('');
      say(`监听中（${liveConn.platform}）`);
    }
    if (flag('listenEnabled', false)) startInteractLoop();
  })();

  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      void danmakuTick();
      void persistTick();
    }, 5000);
    // 连接状态的主路径是 `ws.state` 事件；这个 60 秒的对表只负责"事件丢了"。
    // 以前它混在心跳那一拍里，于是 INFO 档每小时 201 条 ws.state。
    reconcileTimer = setInterval(() => {
      void reconcileConnection();
    }, 60_000);
  }
}

function stopBot() {
  stopInteractLoop();
  void closeDanmaku();
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
  say('已停止');
}

/** ws.message 事件进来的一帧。 */
function onDanmakuFrame(textIn) {
  const parsed = parseDanmakuFrame(textIn);
  if (!parsed) return;
  if (parsed.kind === 'stats') {
    liveStats.online = parsed.online;
    return;
  }
  if (parsed.kind === 'dm') {
    const outcome = DanmakuQueue.push(
      queue,
      { uid: parsed.dm.uid, name: parsed.dm.name, text: parsed.dm.text, at: now() },
      {
        minTextLen: num('minTextLen', 1, 100, 2),
        maxTextLen: num('maxTextLen', 4, 200, 40),
        dedupeWindowSec: num('dedupeWindowSec', 0, 3600, 120),
        keywords: cfg.keywords || '',
        blockedWords: cfg.blockedWords || '',
      },
    );
    if (outcome === 'accepted') {
      dmFeed.push({ name: parsed.dm.name, text: parsed.dm.text, at: now() });
      while (dmFeed.length > DM_FEED_MAX) dmFeed.shift();
      if (self.slot === 'workshop') renderFeed();
    }
    if (outcome === 'dropped') queue.stats.dropped += 0; // 计数已在 push 内完成
  }
}

// 每 30 秒把统计落一次盘：workshop 重启后能看到"今天收过多少条"。
const STATS_KEY = 'state/stats';
async function persistTick() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void (async () => {
      try {
        await writeJSON(STATS_KEY, { day: today(), stats: queue.stats, watched: liveStats.watched });
      } catch {
        // 统计落盘失败不打断监听。
      }
    })();
  }, 30000);
}

// --- 工坊页 -------------------------------------------------------------------

async function renderWorkshop() {
  // 设置读取走 app.js 的 refreshCfg（它会先看 granted）：没有 plugin.config 的安装
  // 不发这次请求，界面停在"未授权"而不是半截。
  await refreshCfg();
  renderStatus();
  renderFeed();
  renderReplies();
  const replies = await loadReplies();
  if (replies.length) renderReplies(replies);
}

function renderStatus() {
  if (!els.chipState) return;
  const snap = liveSnapshot();
  const room = snap.room ? `房间 ${snap.room}` : '房间未设置';
  const stateLine = snap.open ? '已连接' : snap.wanted ? '连接中' : '未连接';
  const mode = snap.running ? '· 互动中' : '';
  els.chipState.textContent = `${room} · ${stateLine} ${mode}`;
  if (els.statOnline) els.statOnline.textContent = String(snap.online || '—');
  if (els.statWatched) els.statWatched.textContent = String(snap.watched);
  if (els.statAccepted) els.statAccepted.textContent = String(snap.queue.stats.accepted);
  if (els.statDropped) els.statDropped.textContent = String(snap.queue.stats.filtered + snap.queue.stats.dropped);
  if (els.statQueue) els.statQueue.textContent = String(snap.queue.size);
  if (els.statReplies) els.statReplies.textContent = String(snap.counters.replies);
  if (els.statLlmCalls) els.statLlmCalls.textContent = String(snap.counters.llmCalls);
  if (els.statusNote) els.statusNote.textContent = snap.lastError ? '' : (snap.open ? (snap.running ? '互动循环运行中' : '只听不回（打开「启动后自动开始监听」或在下方开始）') : '未连接弹幕桥');
  if (els.statusError) els.statusError.textContent = snap.lastError || '';
  if (els.startStop) {
    els.startStop.textContent = snap.running ? '停止互动' : '开始互动';
    els.startStop.disabled = false;
  }
}

/** 渲染滚动的精简弹幕列表。无参调用 = 用本进程的 dmFeed（常驻帧路径）。 */
function renderFeed() {
  if (!els.dmList) return;
  const items = dmFeed.slice(-12).reverse();
  els.dmList.replaceChildren();
  if (!items.length) {
    if (els.dmEmpty) els.dmEmpty.hidden = false;
    return;
  }
  if (els.dmEmpty) els.dmEmpty.hidden = true;
  for (const item of items) {
    const row = document.createElement('li');
    row.className = 'dm';
    const who = document.createElement('span');
    who.className = 'dm-name';
    who.textContent = item.name;
    const what = document.createElement('span');
    what.className = 'dm-text';
    what.textContent = item.text;
    row.append(who, what);
    els.dmList.appendChild(row);
  }
}

/** 渲染最近的回应（replies 可省略：工坊页先画内存里的，读到盘上的再补）。 */
function renderReplies(replies) {
  if (!els.replyList) return;
  const items = Array.isArray(replies) && replies.length ? replies : [];
  els.replyList.replaceChildren();
  if (!items.length) {
    if (els.replyEmpty) els.replyEmpty.hidden = false;
    return;
  }
  if (els.replyEmpty) els.replyEmpty.hidden = true;
  for (const item of items) {
    const row = document.createElement('li');
    row.className = 'reply';
    const when = document.createElement('time');
    when.className = 'reply-at';
    when.textContent = new Date(item.at).toLocaleTimeString();
    const ask = document.createElement('p');
    ask.className = 'reply-ask muted';
    ask.textContent = item.prompt;
    const ans = document.createElement('p');
    ans.className = 'reply-answer';
    ans.textContent = item.answer;
    row.append(when, ask, ans);
    els.replyList.appendChild(row);
  }
}

/** 工坊页的「开始/停止互动」按钮：写 command 共享键，常驻帧读它。 */
const SHARE_COMMAND = 'live-command';
async function sendCommand(op) {
  try {
    await request('share.set', { name: SHARE_COMMAND, value: JSON.stringify({ op, at: now() }) });
    say(op === 'start' ? '已请求开始互动' : '已请求停止互动');
  } catch (err) {
    say(`命令没有发出去：${text(err && err.message, 120)}`);
  }
}

/**
 * 常驻帧读命令键。at 比 lastCommandAt 新才执行——工坊页保存设置也会写键，
 * 同一条命令不该被执行两遍。
 */
let lastCommandAt = 0;
async function pollCommand() {
  if (!granted.has('plugin.share')) return;
  try {
    const out = await request('share.get', { name: SHARE_COMMAND });
    const value = String((out && out.value) || '');
    if (!value) return;
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed.at !== 'number' || parsed.at <= lastCommandAt) return;
    lastCommandAt = parsed.at;
    if (parsed.op === 'start') startInteractLoop();
    else if (parsed.op === 'stop') stopInteractLoop();
  } catch {
    // 键还没人写过（value 为空串）或坏 JSON：跳过。
  }
}
