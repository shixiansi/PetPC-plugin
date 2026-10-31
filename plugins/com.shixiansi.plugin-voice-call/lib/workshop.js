// lib/workshop.js —— 工坊页：状态、音量条、统计、开关；常驻帧只跑循环

'use strict';

const SHARE_COMMAND = 'call-command';
let lastCommandAt = 0;
let frameTimer = null;

function startFrameTimer() {
  if (frameTimer) return;
  const interval = Math.max(100, num('frameMs', 20, 2000, 100));
  frameTimer = setInterval(() => {
    void pollFrame();
    if (self.slot === 'workshop') renderLive();
  }, interval);
}

function stopFrameTimer() {
  if (frameTimer) {
    clearInterval(frameTimer);
    frameTimer = null;
  }
}

function renderWorkshop() {
  renderLive();
  renderStatus();
}

function renderLive() {
  if (!els.stateNow) return;
  const snap = callSnapshot();
  els.stateNow.textContent = { idle: '静默', listening: '听到人声', recording: '录音中', send: '处理中' }[snap.state] || snap.state;
  if (els.levelNow) {
    els.levelNow.textContent = String(snap.level);
    els.levelNow.style.width = `${Math.min(100, snap.level)}%`;
  }
  if (els.statInterrupts) els.statInterrupts.textContent = String(snap.stats.interrupts);
  if (els.statUtterances) els.statUtterances.textContent = String(snap.stats.utterances);
  if (els.statReplies) els.statReplies.textContent = String(snap.stats.replies);
  if (els.statAborted) els.statAborted.textContent = String(snap.stats.aborted);
}

function renderStatus() {
  if (!els.chipState) return;
  const snap = callSnapshot();
  els.chipState.textContent = snap.running ? `通话监听中（${{ idle: '静默', listening: '听', recording: '录', send: '说' }[snap.state] || snap.state}）` : '未在监听';
  if (els.statusError) els.statusError.textContent = snap.lastError || '';
  if (els.statusNote) els.statusNote.textContent = snap.lastError ? '' : (snap.running ? '音频桥每帧上报音量，VAD 在本地判定说话与静音。' : '按「开始通话」进入监听（需要音频桥在跑）。');
  if (els.callToggle) {
    els.callToggle.textContent = snap.running ? '结束通话' : '开始通话';
    els.callToggle.disabled = false;
  }
}

async function toggleButton() {
  const running = callRunning();
  try {
    await request('share.set', { name: SHARE_COMMAND, value: JSON.stringify({ op: running ? 'stop' : 'start', at: now() }) });
  } catch (err) {
    say(`命令没有发出去：${text(err && err.message, 120)}`);
  }
  // 本进程立即生效（常驻帧通过命令键的 at 去重保证不重复执行）。
  if (running) {
    stopCall();
    stopFrameTimer();
  } else {
    startCall();
    startFrameTimer();
  }
  renderStatus();
}

async function pollCommand() {
  if (!granted.has('plugin.share')) return;
  try {
    const out = await request('share.get', { name: SHARE_COMMAND });
    const value = String((out && out.value) || '');
    if (!value) return;
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed.at !== 'number' || parsed.at <= lastCommandAt) return;
    lastCommandAt = parsed.at;
    if (parsed.op === 'start') {
      if (!callRunning()) {
        startCall();
        startFrameTimer();
      }
    } else if (parsed.op === 'stop') {
      stopCall();
      stopFrameTimer();
    }
  } catch {
    // 键还没人写过或坏 JSON。
  }
}

/** 读一遍设置。配置权限未授予时**不发请求**。 */
function refreshCfg() {
  if (!granted.has('plugin.config')) return Promise.resolve();
  return request('config.get', {})
    .then((out) => {
      cfg = Object.assign({}, cfg, (out && out.values) || {});
    })
    .catch(() => {});
}
