// lib/call.js —— 状态机的事件落到真实能力上：打断、ASR、回答、合成
//
// step() 吐出的事件在这里产生副作用：
//   speech-start   用户开口了 → interruptEnabled 时立刻 audio.stop（打断桌宠正在说的话）
//   recording-start 通知上层开始攒音频切片
//   send           把攒下的切片 POST 给 ASR 桥 → 文本 → plugin.call(chat) → 回答
//                  → TTS → audio.play；同时（可选）弹气泡
//   abort/discard  丢弃本轮
//
// 音频从哪来：沙箱拿不到麦克风（宿主没有暴露录音能力）。真实链路是"本机音频桥"
// （tools/audio-bridge.mjs）负责录音与音量帧，插件轮询它的 /frame 与 /clip：
//   GET /frame → {level: 0-100}      当前音量（桥自己做 RMS）
//   GET /clip?since=N → {seq, base64}（对话轮的录音切片，WAV）
// 桥不在时这个插件安静地待在 IDLE，并在工坊页说明为什么。

'use strict';

const MEMCORE = 'com.shixiansi.plugin-voice-call';
const CALL_ROLE = 'voice-call';

const callState = {
  machine: null,
  running: false,
  /** 本轮录音切片的缓存（base64 块）。 */
  chunks: [],
  busy: false,          // SEND 阶段的模型/合成在飞
  lastError: '',
  stats: { interrupts: 0, utterances: 0, discard: 0, aborted: 0, replies: 0 },
};

function callRunning() {
  return callState.running;
}

/** 启动监听：创建状态机、打开音频桥的轮询。 */
function startCall() {
  if (callState.running) return;
  callState.machine = VadMachine.create({
    threshold: num('vadThreshold', 0, 100, 40),
    silenceMs: num('silenceMs', 100, 10000, 1200),
    minSpeechMs: num('minSpeechMs', 50, 5000, 300),
    maxUtteranceMs: num('maxUtteranceMs', 500, 120000, 15000),
    frameMs: num('frameMs', 20, 2000, 100),
  });
  callState.running = true;
  callState.chunks = [];
  callState.lastError = '';
  pollFrame();
}

function stopCall() {
  callState.running = false;
  if (callState.machine) {
    finishSend(callState.machine);
  }
  callState.chunks = [];
}

/**
 * 音频桥轮询的一拍：拿当前音量喂状态机；RECORDING 时顺手拉切片。
 * 帧间隔由调用方的定时器决定（真机 frameMs，工坊预览 500ms）。
 */
async function pollFrame() {
  if (!callState.running) return;
  const events = [];
  try {
    const out = await request('net.fetch', { url: `${asrBase()}/frame`, method: 'GET' });
    const parsed = out && out.status === 200 ? JSON.parse(String(out.body || '{}')) : null;
    const level = parsed && Number.isFinite(Number(parsed.level)) ? Number(parsed.level) : 0;
    // SEND 期间用户再开口 = 打断策略：允许在 SEND 状态下喂"打断位"。
    const machineEvents = callState.machine.state === 'send'
      ? (flag('interruptEnabled', true) && level >= num('vadThreshold', 0, 100, 40)
        ? [{ type: 'abort' }]
        : [])
      : VadMachine.step(callState.machine, level, false);
    events.push(...machineEvents);
    // RECORDING 中拉切片。
    if (callState.machine.state === 'recording') {
      const clip = await pullClip();
      if (clip) callState.chunks.push(clip);
    }
  } catch (err) {
    callState.lastError = `音频桥不可达：${text(err && err.message, 120)}`;
  }
  await handleEvents(events);
}

/** 拉一段录音切片。返回 base64 或 null。 */
async function pullClip() {
  try {
    const out = await request('net.fetch', { url: `${asrBase()}/clip`, method: 'GET' });
    const parsed = out && out.status === 200 ? JSON.parse(String(out.body || '{}')) : null;
    if (parsed && typeof parsed.base64 === 'string' && parsed.base64) return parsed.base64;
  } catch {
    // 切片拉不到就丢了——下一帧还有。
  }
  return null;
}

/** 状态机事件 → 副作用。 */
async function handleEvents(events) {
  for (const event of events) {
    switch (event.type) {
      case 'speech-start':
        // 用户开口：打断正在播放的语音（这一下是"打断机制"的本体）。
        if (flag('interruptEnabled', true) && granted.has('audio')) {
          await request('audio.stop', {}).catch(() => {});
          callState.stats.interrupts += 1;
        }
        break;
      case 'recording-start':
        callState.chunks = [];
        break;
      case 'discard':
        callState.stats.discard += 1;
        break;
      case 'abort':
        callState.stats.aborted += 1;
        callState.chunks = [];
        break;
      case 'send':
        callState.stats.utterances += 1;
        await processUtterance(event);
        break;
      default:
        break;
    }
  }
}

/** 一句话的完整处理：识别 → 回答 → 合成 → 播放。 */
async function processUtterance(event) {
  callState.busy = true;
  try {
    const asrText = await transcribe();
    if (!asrText.trim()) {
      finishSend(callState.machine);
      return;
    }
    const answer = await askModel(asrText);
    await speakAnswer(answer);
    callState.stats.replies += 1;
  } catch (err) {
    callState.lastError = `${text(err && err.message, 140)}`;
  } finally {
    callState.busy = false;
    callState.chunks = [];
    finishSend(callState.machine);
    void event;
  }
}

/** 切片 → ASR 桥 → 文本。 */
async function transcribe() {
  if (!callState.chunks.length) return '';
  const audio = callState.chunks.join('');
  const out = await request('net.fetch', {
    url: `${asrBase()}/asr`,
    method: 'POST',
    body: JSON.stringify({ audio, format: 'wav' }),
  });
  if (!out || out.status !== 200) throw new Error(`ASR 返回 ${out ? out.status : '无响应'}`);
  const parsed = JSON.parse(String(out.body || '{}'));
  return String(parsed.text || '');
}

/** 文本 → 记忆核心 → 回答。 */
async function askModel(textIn) {
  const out = await request('plugin.call', {
    target: 'com.shixiansi.plugin-memcore',
    method: 'chat',
    payload: { roleId: CALL_ROLE, userId: 'caller', userName: '通话对象', text: textIn },
  });
  const reply = String((out && out.text) || '').trim();
  if (!reply) throw new Error('记忆核心返回了空回答');
  const max = num('replyMaxChars', 40, 500, 120);
  return reply.length > max ? `${reply.slice(0, max)}…` : reply;
}

/** 回答 → TTS → audio.play（可选气泡）。 */
async function speakAnswer(answer) {
  const base = ttsBase();
  const refPath = String(cfg.voiceRefPath || '').trim();
  if (granted.has('pet.bubble') && flag('bubbleEnabled', true)) {
    await request('bubble.say', { text: answer }).catch(() => {});
  }
  if (!base || !refPath) {
    callState.lastError = '想说话但语音配置不完整';
    return;
  }
  const out = await request('net.fetch', {
    url: `http://${base}/tts`,
    method: 'POST',
    encoding: 'base64',
    body: JSON.stringify({
      text: answer,
      text_lang: 'zh',
      ref_audio_path: refPath,
      prompt_lang: 'zh',
      streaming_mode: false,
    }),
  });
  if (!out || out.status !== 200 || !out.body) throw new Error(`语音服务返回 ${out ? out.status : '无响应'}`);
  const name = `call-${Date.now().toString(36)}`;
  await request('audio.save', { name, data: out.body });
  await request('audio.play', { name });
}

function asrBase() {
  const raw = String(cfg.asrBaseUrl || '').trim();
  if (!raw) return '';
  return /^https?:\/\//i.test(raw) ? raw.replace(/\/+$/, '') : `http://${raw.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

function ttsBase() {
  const raw = String(cfg.ttsBaseUrl || '').trim();
  if (!raw) return String(cfg.asrBaseUrl || '').trim();
  return /^https?:\/\//i.test(raw) ? raw.replace(/\/+$/, '') : raw.replace(/^\/+|\/+$/g, '');
}

function callSnapshot() {
  return {
    running: callState.running,
    state: callState.machine ? callState.machine.state : 'idle',
    level: callState.machine ? callState.machine.level : 0,
    chunks: callState.chunks.length,
    busy: callState.busy,
    lastError: callState.lastError,
    stats: { ...callState.stats },
  };
}
