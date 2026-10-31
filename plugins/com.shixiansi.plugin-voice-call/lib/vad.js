// lib/vad.js —— VAD 状态机（纯逻辑，零环境依赖）
//
// 「听—想—说」的全部状态转移都在这里，只吃数字、吐事件——这样它可以在没有
// 麦克风的测试环境里被完整验证。
//
//   IDLE      静默。音量连续 N 帧超过阈值 → LISTENING（有人开口了）。
//   LISTENING 还没满 minSpeechMs：掉回静音就回 IDLE（那是噪音）；持续超阈值
//             满 minSpeechMs → RECORDING。
//   RECORDING 正在录音。静音连续 silenceMs → SEND（收音）；到 maxUtteranceMs
//             → SEND（强制收音）。任一时刻外部要求"打断"→ ABORT（丢弃）。
//   SEND      交给上层去识别/回答/合成。上层说完（或失败）→ IDLE。
//
// 音量帧是调用方喂的（0-100），时间由调用方给（frameMs 的倍数）——状态机自己
// 不碰 Date.now，测试可以精确推进时间。
//
// 实现说明：JS 里每个状态是一个函数（state machine 的经典形状），step() 喂一帧
// 返回产生的事件数组（[] | ['speech-start'] | ['recording'] | ['send', payload] …）。
// 事件由调用方（lib/call.js）驱动真实副作用。

'use strict';

const VAD = {
  IDLE: 'idle',
  LISTENING: 'listening',
  RECORDING: 'recording',
  SEND: 'send',
};

/** 创建一个状态机。params 全部由调用方给（测试可以用与真机不同的参数）。 */
function createVad(params) {
  const p = {
    threshold: clamp(params.threshold, 0, 100, 40),
    silenceMs: clamp(params.silenceMs, 100, 10000, 1200),
    minSpeechMs: clamp(params.minSpeechMs, 50, 5000, 300),
    maxUtteranceMs: clamp(params.maxUtteranceMs, 500, 120000, 15000),
    frameMs: clamp(params.frameMs, 20, 2000, 100),
    listenFrames: clamp(params.listenFrames, 1, 20, 2), // 连续几帧超阈值才算"开口"
  };
  const machine = {
    state: VAD.IDLE,
    params: p,
    // 内部计数
    loudFrames: 0,
    quietMs: 0,
    speechMs: 0,
    startedAt: 0,
    level: 0,
  };
  return machine;
}

/**
 * 喂一帧音量（0-100）。返回本次产生的事件：
 *   {type:'speech-start'}                 开始听到人声（LISTENING 进入）
 *   {type:'recording-start'}              真正开始录音（过了最短说话时长）
 *   {type:'send', level, durationMs}      收音（自然静音或到达上限）
 *   {type:'discard'}                      判定为噪音（LISTENING 中掉回静音）
 *   {type:'interrupt'}                    只在 interrupt=true 时由 stepInterrupt 产生
 */
function step(machine, level, interrupt = false) {
  const events = [];
  const p = machine.params;
  const loud = level >= p.threshold;
  machine.level = level;

  if (machine.state === VAD.SEND) {
    // 说/想期间只关心打断：外部显式要求，或（策略上）这次不开。
    return events;
  }

  if (machine.state === VAD.IDLE) {
    if (loud) {
      machine.loudFrames += 1;
      if (machine.loudFrames >= p.listenFrames) {
        machine.state = VAD.LISTENING;
        machine.speechMs = 0;
        machine.quietMs = 0;
        machine.startedAt = 0;
        events.push({ type: 'speech-start', level });
      }
    } else {
      machine.loudFrames = 0;
    }
    return events;
  }

  if (machine.state === VAD.LISTENING) {
    if (loud) {
      machine.loudFrames = Math.max(machine.loudFrames, p.listenFrames);
      machine.speechMs += p.frameMs;
      machine.quietMs = 0;
      if (machine.speechMs >= p.minSpeechMs) {
        machine.state = VAD.RECORDING;
        machine.startedAt = machine.speechMs;
        machine.quietMs = 0;
        events.push({ type: 'recording-start', durationMs: machine.speechMs });
      }
    } else {
      machine.quietMs += p.frameMs;
      if (machine.quietMs >= p.silenceMs) {
        machine.state = VAD.IDLE;
        machine.loudFrames = 0;
        machine.speechMs = 0;
        machine.quietMs = 0;
        events.push({ type: 'discard' });
      }
    }
    return events;
  }

  // RECORDING
  if (interrupt) {
    machine.state = VAD.IDLE;
    reset(machine);
    events.push({ type: 'abort' });
    return events;
  }
  machine.speechMs += p.frameMs;
  if (loud) {
    machine.quietMs = 0;
  } else {
    machine.quietMs += p.frameMs;
  }
  if (machine.speechMs >= p.maxUtteranceMs) {
    events.push(closeUtterance(machine, 'max'));
    return events;
  }
  if (machine.quietMs >= p.silenceMs) {
    events.push(closeUtterance(machine, 'silence'));
    return events;
  }
  return events;
}

/** 外部打断（用户按按钮/策略决定）。只在 RECORDING/LISTENING 有意义。 */
function stepInterrupt(machine) {
  const events = [];
  if (machine.state === VAD.RECORDING || machine.state === VAD.LISTENING) {
    machine.state = VAD.IDLE;
    reset(machine);
    events.push({ type: 'abort' });
  }
  return events;
}

/** 上层处理完毕（说完/失败），状态机回到 IDLE。 */
function finishSend(machine) {
  machine.state = VAD.IDLE;
  reset(machine);
}

function closeUtterance(machine, reason) {
  const durationMs = machine.speechMs;
  const level = machine.level;
  machine.state = VAD.SEND;
  machine.quietMs = 0;
  return { type: 'send', reason, durationMs, level };
}

function reset(machine) {
  machine.loudFrames = 0;
  machine.quietMs = 0;
  machine.speechMs = 0;
  machine.startedAt = 0;
}

function clamp(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** RMS → 0-100 的音量（调用方把 PCM 帧交进来）。 */
function levelOf(pcmInt16) {
  let sum = 0;
  const n = Math.min(pcmInt16.length, 4800); // 100ms @48k 上限
  for (let i = 0; i < n; i += 1) {
    sum += pcmInt16[i] * pcmInt16[i];
  }
  const rms = Math.sqrt(sum / Math.max(1, n));
  return Math.min(100, Math.round((rms / 32768) * 100 * 3)); // ×3 是经验的说话余量
}

// —— 命名空间：lib/call.js 与测试接缝用 `VadMachine.*` 调用（上面的函数是实现）。 ——
const VadMachine = {
  IDLE: VAD.IDLE,
  LISTENING: VAD.LISTENING,
  RECORDING: VAD.RECORDING,
  SEND: VAD.SEND,
  create: createVad,
  step,
  stepInterrupt,
  finishSend,
  levelOf,
};
