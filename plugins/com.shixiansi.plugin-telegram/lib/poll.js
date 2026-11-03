// lib/poll.js —— 常驻帧的循环：拉一次、处理、等一会儿、再拉
//
// 这个文件是"没反应"的第二个来源（第一个是白名单），所以它把每一拍的结果都写成一句人话。
//
// 三种等待，各有各的理由：
//   · 长轮询 25 秒（lib/api.js 的 LONG_POLL_SECONDS）——宿主的 net.fetch 超时是 30 秒；
//   · 断网退避 15 → 30 → 60 → 120 → 240 → 300，封顶 5 分钟，**成功一次就回到 15**
//     （一次成功说明网络真的回来了，继续等 5 分钟只会让下一句话迟到 5 分钟）；
//   · 没配置好 15 秒重看一次设置——这个插件没有 `events` 权限，收不到 `config.changed`，
//     而设置通常是用户在**另一个进程**里改的。15 秒是手册给的兜底粒度（1 秒是反模式）。
//
// WHY 不用 setInterval：每一拍的间隔由上一拍的结果决定，而 setInterval 的间隔是固定的。

'use strict';

/** 断网之后第一次等 15 秒，然后每失败一次翻倍，封顶 5 分钟。 */
const RETRY_FIRST_MS = 15000;
const RETRY_MAX_MS = 300000;
/** 没配置好（没 token / 开关关着）时重看设置的间隔。 */
const IDLE_MS = 15000;
/** 401 之后：token 要被人改，别每 15 秒去撞一次墙。 */
const AUTH_RETRY_MS = 60000;
/** 409 之后：另一个进程在轮询同一个 bot，抢是抢不来的。 */
const CONFLICT_RETRY_MS = 30000;
/** 设置多久重读一次（没有 config.changed 可听，见文件头）。 */
const CONFIG_TTL_MS = 240000;

/**
 * 面板与日志都读这一份。`message` 是给用户看的那句话，`retryIn` 是下一拍要等多久。
 * 状态**同时**在内存和 storage 里：工坊页是另一个文档、另一个进程，它只能读 `state/status`。
 */
const pollState = {
  phase: 'idle', message: '还没开始', retryIn: 0, at: 0,
  answered: 0, skipped: 0, failed: 0, lastError: '',
};

/** `update_id` 游标：下一条我要的 id。比它小的一律当成"处理过了"。 */
let cursor = 0;
/** 退避阶梯的当前位置。 */
let backoffMs = RETRY_FIRST_MS;
let polling = false;
let stopRequested = false;
let lastStatusJSON = '';

/**
 * 循环里的等待。测试要把它换掉（app.js 的 `__telegram.setSleep`）：这个插件一半的行为是
 * "等多久"，而等 15 秒在用例里没法过。
 */
let pollSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- 状态与游标 --------------------------------------------------------------

async function saveStatus() {
  const snapshot = {
    phase: pollState.phase, message: pollState.message, retryIn: pollState.retryIn,
    at: pollState.at, cursor, answered: pollState.answered, skipped: pollState.skipped,
    failed: pollState.failed, lastError: pollState.lastError,
  };
  const encoded = JSON.stringify(snapshot);
  // 长轮询每 25 秒一拍，而绝大多数拍什么都没变：没变就不写，别把私有目录写成日志。
  if (encoded === lastStatusJSON) return;
  lastStatusJSON = encoded;
  await writeJSON(KEY_STATUS, snapshot);
}

function setPhase(phase, message, retryIn) {
  pollState.phase = phase;
  pollState.at = now();
  pollState.retryIn = Number.isFinite(retryIn) ? retryIn : 0;
  if (message !== undefined && message !== null) pollState.message = String(message);
  renderStatus();
  void saveStatus();
}

async function loadCursor() {
  const value = Number(await readJSON(KEY_OFFSET, 0));
  cursor = Number.isFinite(value) && value > 0 ? value : 0;
  return cursor;
}

/** 前进一步。**只前进不后退**：游标回头就会重放已经答过的消息。 */
async function advanceCursor(next) {
  const value = Number(next);
  if (!Number.isFinite(value) || value <= cursor) return;
  cursor = value;
  renderStatus();
  await writeJSON(KEY_OFFSET, cursor);
}

// --- 一拍 --------------------------------------------------------------------

async function refreshConfigIfDue() {
  if (now() - configReadAt < CONFIG_TTL_MS) return;
  await refreshConfig();
}

function seconds(ms) {
  return Math.max(1, Math.round(Number(ms) / 1000));
}

/** 「没配好」的一拍：写下原因，并让下一拍重读设置（设置是在另一个进程里改的）。 */
function idleFor(phase, message) {
  configReadAt = 0;
  setPhase(phase, message);
  return IDLE_MS;
}

/**
 * 断网：按阶梯退避。`net.fetch` 抛错（DNS / 连不上 / 宿主的 30 秒超时）与 502/503 都走这里。
 */
function retryLater(message, detail) {
  const wait = backoffMs;
  backoffMs = Math.min(RETRY_MAX_MS, backoffMs * 2);
  note(detail ? `${message}（${text(detail, 120)}）` : message);
  setPhase('retry', `${message}；${seconds(wait)} 秒后再试`, wait);
  logLine('warn', `${message}；下一次在 ${seconds(wait)} 秒后`);
  return wait;
}

/**
 * 一拍：重读设置、判断能不能干活、拉一次、把 update 交给管道。
 * 返回**下一次该等多久**（毫秒）——0 表示立刻再拉（长轮询的服务器已经替我们等过了）。
 */
async function pollOnce() {
  await refreshConfigIfDue();

  // 「没配好」的四种情况：一个 net.fetch 都不发（这才有资格叫"未配置"）。
  if (!granted.has('net.fetch')) {
    return idleFor('no-permission', '没有 net.fetch 权限：在插件设置里重新授权，它才能去问 Telegram 要消息');
  }
  if (!granted.has('plugin.call')) {
    return idleFor('no-permission', '没有 plugin.call 权限：收得到话也没人能回答（要问记忆核心）');
  }
  if (!botToken()) return idleFor('idle', '先去设置里填 Bot Token');
  if (!pollEnabled()) return idleFor('idle', '轮询开关关着（设置里的「收消息」没打开）');

  let res;
  try {
    res = await tgGetUpdates(cursor);
  } catch (err) {
    // 连不上。**不回显 err.message 的原文**：宿主的 net.fetch 失败时交回来的是 Go 的
    // *url.Error，它带着整个 URL（含 token）。redact 是第二道闸门。
    return retryLater('网络不通', redact(err && err.message ? err.message : err));
  }

  const status = res.status;
  const data = res.data;
  const code = Number(data && data.error_code) || status;

  if (status === 401 || code === 401) {
    note('token 不对（401 Unauthorized）');
    logLine('warn', 'getUpdates 被拒：401 Unauthorized（Bot Token 不对，或者被 @BotFather 撤销了）');
    setPhase('auth', 'token 不对：去设置里核对 Bot Token（它可能被 @BotFather 撤销了）', AUTH_RETRY_MS);
    return AUTH_RETRY_MS;
  }
  if (status === 409 || code === 409) {
    note('另一个进程在用同一个 bot 的长轮询');
    logLine('warn', 'getUpdates 被拒：409 Conflict（同一个 token 只允许一个 getUpdates）');
    setPhase(
      'conflict',
      '另一个进程在用同一个 bot 的长轮询（同一个 token 只允许一个 getUpdates）',
      CONFLICT_RETRY_MS,
    );
    return CONFLICT_RETRY_MS;
  }
  if (status === 429 || code === 429) {
    const secs = tgRetryAfter(data) || 30;
    note(`Telegram 说太频繁了（429），等 ${secs} 秒`);
    logLine('warn', `getUpdates 被限流：429，Telegram 要求等 ${secs} 秒`);
    setPhase('throttle', `Telegram 说太频繁了（429）：它要求等 ${secs} 秒`, secs * 1000);
    return secs * 1000;
  }
  if (status === 502 || status === 503 || status >= 500) {
    return retryLater(`Telegram 那边出错了（HTTP ${status || '?'}）`);
  }
  if (status !== 200 || !data || data.ok !== true) {
    return retryLater(`Telegram 回了一句看不懂的答复（HTTP ${status || '?'}）`);
  }

  // 成功一次就把阶梯放回原点（见文件头）。
  backoffMs = RETRY_FIRST_MS;
  const updates = Array.isArray(data.result) ? data.result : [];
  for (const update of updates) {
    await ingestUpdate(update);
  }
  setPhase(
    'polling',
    updates.length ? `刚收到 ${updates.length} 条 update` : '在等消息（长轮询 25 秒一轮）',
    0,
  );
  return 0;
}

// --- 循环 --------------------------------------------------------------------

async function pollLoop() {
  if (polling) return;
  polling = true;
  stopRequested = false;
  try {
    await loadCursor();
    while (!stopRequested) {
      let wait = IDLE_MS;
      try {
        wait = await pollOnce();
      } catch (err) {
        // 一拍里抛错不该让常驻帧死掉：记一行，下一拍照常。
        note(`一拍里抛错了：${text(redact(err && err.message ? err.message : err), 120)}`);
        wait = IDLE_MS;
      }
      if (stopRequested) break;
      await pollSleep(wait);
    }
  } finally {
    polling = false;
  }
}

function stopPolling() {
  stopRequested = true;
  polling = false;
}

/** 测试接缝：把循环里的等待换掉（等 15 秒在用例里没法过）。 */
function setPollSleep(fn) {
  if (typeof fn === 'function') pollSleep = fn;
}
