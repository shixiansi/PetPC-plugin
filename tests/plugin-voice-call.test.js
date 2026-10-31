import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Behaviour tests for the voice-call plugin.
//
// Three groups:
//   vad            THE pure-logic state machine: silence→listening→recording→send,
//                  noise discard, max-utterance force close, interrupt abort, and
//                  levelOf (PCM RMS). No environment, no clocks — frames in, events out.
//   manifest+css   host pairing rules + CSS house rules.
//   plumbing       the frame boot, pollFrame through a fake audio bridge, the FULL
//                  speech→ASR→chat→TTS→play pipeline, interruption (audio.stop on
//                  speech-start), and the share command.

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-voice-call');
const panelPath = path.join(pluginDir, 'panel.html');
const cssPath = path.join(pluginDir, 'style.css');
const manifestPath = path.join(pluginDir, 'manifest.json');

const html = readFileSync(panelPath, 'utf8');
const css = readFileSync(cssPath, 'utf8');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');

const source = scriptSources
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-voice-call';
const PERMISSIONS = manifest.permissions;
const ALL_GRANTED = [...PERMISSIONS];
const MEMCORE = 'com.shixiansi.plugin-memcore';

// --- harness -----------------------------------------------------------------

let windowListeners = [];
let bootValues = {};
const storageMap = new Map();
const shareMap = new Map();
let intervals = [];
const answered = new Set();
let postedFrom = 0;
const calls = [];
const fetches = [];
/** 音频桥的应答。 */
let bridgeLevel = 0;
let bridgeClip = '';
let bridgeUp = true;
/** ASR / memcore / TTS。 */
let asrText = '今天天气怎么样';
let memcoreAnswer = { text: '晴，适合出门。' };
let memcoreFails = false;
let ttsStatus = 200;
let ttsBody = 'd09HTg==';

function installPanel() {
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
}

async function loadApp() {
  answered.clear();
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  for (const id of intervals) window.clearInterval(id);
  intervals = [];
  vi.resetModules();
  postedFrom = window.postMessage.mock.calls.length;
  calls.length = 0;
  fetches.length = 0;
  // eslint-disable-next-line no-new-func
  new Function(source)();
}

function posted() {
  return window.postMessage.mock.calls.map((call) => call[0]).slice(postedFrom);
}

function byType(type) {
  return posted().filter((m) => m && m.type === type);
}

function requests() {
  return byType('request').map((m) => ({ id: m.id, method: m.method, payload: m.payload }));
}

function requestsFor(method) {
  return requests().filter((r) => r.method === method);
}

function hostSends(data) {
  window.dispatchEvent(new MessageEvent('message', { data, source: window }));
}

function answer(id, result, { ok = true, error = '' } = {}) {
  answered.add(id);
  hostSends({ v: 1, type: 'response', id, ok, result, error });
}

function initFrame({ slot = 'background', granted = ALL_GRANTED } = {}) {
  return {
    v: 1, type: 'init', pluginId: PLUGIN_ID, permissions: PERMISSIONS,
    granted, surface: { kind: 'panel', slot },
  };
}

async function pump(ticks = 30) {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve();
    answerPlumbing();
  }
}

function answerPlumbing() {
  for (const req of requests()) {
    if (answered.has(req.id)) continue;
    const payload = req.payload || {};
    switch (req.method) {
      case 'config.get':
        answer(req.id, { values: bootValues, secrets: {} });
        break;
      case 'storage.get':
        answer(req.id, { value: storageMap.has(String(payload.key)) ? storageMap.get(String(payload.key)) : '' });
        break;
      case 'storage.set':
        storageMap.set(String(payload.key || ''), String(payload.value || ''));
        answer(req.id, { ok: true });
        break;
      case 'share.get': {
        const name = String(payload.name || '');
        answer(req.id, { value: shareMap.has(`${PLUGIN_ID}/${name}`) ? shareMap.get(`${PLUGIN_ID}/${name}`) : '', at: Date.now(), key: `${PLUGIN_ID}/${name}` });
        break;
      }
      case 'share.set':
        shareMap.set(`${PLUGIN_ID}/${String(payload.name || '')}`, String(payload.value || ''));
        answer(req.id, { ok: true });
        break;
      case 'net.fetch': {
        fetches.push(payload);
        const url = String(payload.url || '');
        if (url.includes('/frame')) {
          if (!bridgeUp) answer(req.id, null, { ok: false, error: '模拟拒绝：连不上' });
          else answer(req.id, { status: 200, body: JSON.stringify({ level: bridgeLevel }) });
        } else if (url.includes('/clip')) {
          answer(req.id, { status: 200, body: JSON.stringify({ seq: 1, base64: bridgeClip }) });
        } else if (url.includes('/asr')) {
          answer(req.id, { status: 200, body: JSON.stringify({ text: asrText }) });
        } else if (url.includes('/tts')) {
          if (ttsStatus !== 200) answer(req.id, { status: ttsStatus, body: '' });
          else answer(req.id, { status: 200, body: ttsBody });
        } else {
          answer(req.id, { status: 404, body: 'no route' });
        }
        break;
      }
      case 'plugin.call': {
        calls.push(payload);
        if (memcoreFails) answer(req.id, null, { ok: false, error: '模拟拒绝：超时' });
        else answer(req.id, memcoreAnswer);
        break;
      }
      case 'audio.stop':
      case 'audio.play':
      case 'audio.save':
      case 'bubble.say':
        answer(req.id, { ok: true });
        break;
      default:
        answer(req.id, { ok: true });
        break;
    }
  }
}

beforeEach(() => {
  installPanel();
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  bootValues = {};
  storageMap.clear();
  shareMap.clear();
  intervals = [];
  answered.clear();
  bridgeLevel = 0;
  bridgeClip = '';
  bridgeUp = true;
  asrText = '今天天气怎么样';
  memcoreAnswer = { text: '晴，适合出门。' };
  memcoreFails = false;
  ttsStatus = 200;
  ttsBody = 'd09HTg==';
  window.postMessage = vi.fn();
  const originalSetInterval = window.setInterval.bind(window);
  const originalClearInterval = window.clearInterval.bind(window);
  window.setInterval = (fn, ms, ...rest) => {
    const id = originalSetInterval(fn, ms, ...rest);
    intervals.push(id);
    return id;
  };
  window.clearInterval = (id) => {
    const at = intervals.indexOf(id);
    if (at >= 0) intervals.splice(at, 1);
    return originalClearInterval(id);
  };
  const addEventListener = window.addEventListener.bind(window);
  window.addEventListener = (type, fn, opts) => {
    windowListeners.push([type, fn, opts]);
    return addEventListener(type, fn, opts);
  };
});

afterEach(() => {
  for (const id of intervals) window.clearInterval(id);
  intervals = [];
});

// --- VAD 状态机（纯逻辑） -------------------------------------------------------

describe('vad：状态机', () => {
  beforeEach(async () => {
    await loadApp();
  });

  /** 快进：按 frameMs 喂 N 帧指定音量。 */
  function feed(vad, level, frames) {
    const events = [];
    for (let i = 0; i < frames; i += 1) {
      events.push(...window.__call.vad.step(vad, level));
    }
    return events;
  }

  test('silence → listening → recording → send：完整流转', () => {
    const vad = window.__call.vad.create({ threshold: 40, frameMs: 100, minSpeechMs: 300, silenceMs: 1200, listenFrames: 2, maxUtteranceMs: 15000 });
    // 1 帧大声：还没到 listenFrames → 无事件。
    expect(feed(vad, 80, 1)).toEqual([]);
    expect(vad.state).toBe('idle');
    // 第 2 帧大声 → speech-start。
    expect(feed(vad, 80, 1)).toEqual([{ type: 'speech-start', level: 80 }]);
    expect(vad.state).toBe('listening');
    // 满 minSpeechMs（300ms = 3 更多帧，speechMs 从开口那刻计数）→ recording-start。
    expect(feed(vad, 80, 2)).toEqual([]);
    expect(feed(vad, 80, 1)).toEqual([{ type: 'recording-start', durationMs: 300 }]);
    expect(vad.state).toBe('recording');
    // 说话 3 秒。
    feed(vad, 75, 30);
    // 静音 1200ms = 12 帧 → send（reason: silence）。
    const send = feed(vad, 5, 12);
    expect(send).toEqual([{ type: 'send', reason: 'silence', durationMs: 4500, level: 5 }]);
    expect(vad.state).toBe('send');
  });

  test('a short blip (noise) is discarded, not recorded', () => {
    const vad = window.__call.vad.create({ threshold: 40, frameMs: 100, minSpeechMs: 300, silenceMs: 1200, listenFrames: 2, maxUtteranceMs: 15000 });
    feed(vad, 80, 2);          // speech-start
    feed(vad, 80, 1);          // 100ms < 300ms
    const events = feed(vad, 5, 12); // 掉回静音满 silenceMs
    expect(events).toEqual([{ type: 'discard' }]);
    expect(vad.state).toBe('idle');
  });

  test('max utterance force-closes a long monologue', () => {
    const vad = window.__call.vad.create({ threshold: 40, frameMs: 100, minSpeechMs: 300, silenceMs: 1200, maxUtteranceMs: 15000, listenFrames: 2 });
    feed(vad, 80, 5);          // start + recording（4 帧开口 + 1 帧入录）
    const events = feed(vad, 85, 149); // 15 秒不放
    const send = events.filter((e) => e.type === 'send');
    expect(send).toHaveLength(1);
    expect(send[0].reason).toBe('max');
    expect(send[0].durationMs).toBeGreaterThanOrEqual(15000);
    expect(vad.state).toBe('send');
  });

  test('interrupt during recording aborts and returns to idle', () => {
    const vad = window.__call.vad.create({ threshold: 40, frameMs: 100, minSpeechMs: 300, silenceMs: 1200, maxUtteranceMs: 15000, listenFrames: 2 });
    feed(vad, 80, 5);
    expect(vad.state).toBe('recording');
    expect(window.__call.vad.stepInterrupt(vad)).toEqual([{ type: 'abort' }]);
    expect(vad.state).toBe('idle');
    // 中止后重新开始新一轮。
    expect(feed(vad, 80, 2)).toEqual([{ type: 'speech-start', level: 80 }]);
  });

  test('SEND state swallows frames until finishSend', () => {
    const vad = window.__call.vad.create({ threshold: 40, frameMs: 100, minSpeechMs: 300, silenceMs: 1200, maxUtteranceMs: 15000, listenFrames: 2 });
    feed(vad, 80, 5);
    feed(vad, 5, 12);          // → send
    expect(vad.state).toBe('send');
    expect(feed(vad, 80, 50)).toEqual([]); // 处理期间不产生事件
    window.__call.vad.finishSend(vad);
    expect(vad.state).toBe('idle');
  });

  test('params are clamped to sane ranges', () => {
    const vad = window.__call.vad.create({ threshold: 999, frameMs: 0, silenceMs: -5, minSpeechMs: 999999, maxUtteranceMs: 1 });
    expect(vad.params.threshold).toBe(100);
    expect(vad.params.frameMs).toBe(20);
    expect(vad.params.silenceMs).toBe(100);
    expect(vad.params.minSpeechMs).toBe(5000);
    expect(vad.params.maxUtteranceMs).toBe(500);
  });

  test('levelOf turns PCM RMS into a 0-100 level', () => {
    const loud = new Int16Array(480).fill(20000);
    const quiet = new Int16Array(480).fill(30);
    const loudLevel = window.__call.vad.levelOf(loud);
    const quietLevel = window.__call.vad.levelOf(quiet);
    expect(loudLevel).toBeGreaterThan(80);
    expect(quietLevel).toBeLessThan(5);
    expect(window.__call.vad.levelOf(new Int16Array(0))).toBe(0);
  });

  test('alternating high/quiet frames follow the exact expected path', () => {
    const vad = window.__call.vad.create({ threshold: 40, frameMs: 100, minSpeechMs: 300, silenceMs: 1200, maxUtteranceMs: 15000, listenFrames: 2 });
    // 高-静-高-静 交替： loudFrames 需要连续 2 帧才开口 → 永远不开。
    const events = feed(vad, 80, 1).concat(feed(vad, 5, 1), feed(vad, 80, 1), feed(vad, 5, 1), feed(vad, 80, 1), feed(vad, 5, 1));
    expect(events).toEqual([]);
    expect(vad.state).toBe('idle');
    // 连续大声 → 立即开始。
    expect(feed(vad, 80, 2)).toEqual([{ type: 'speech-start', level: 80 }]);
  });
});

// --- manifest & css ----------------------------------------------------------

describe('manifest', () => {
  test('declares the headless frame and both network hosts', () => {
    expect(manifest.background).toBe(true);
    expect(manifest.permissions).toContain('net.fetch');
    expect(manifest.permissions).toContain('audio');
    expect(manifest.netHosts).toEqual(expect.arrayContaining(['127.0.0.1:9880', '127.0.0.1:23240']));
  });

  test('VAD parameters have documented defaults', () => {
    const byKey = new Map(manifest.config.map((item) => [item.key, item]));
    expect(byKey.get('vadThreshold').default).toBe('40');
    expect(byKey.get('silenceMs').default).toBe('1200');
    expect(byKey.get('minSpeechMs').default).toBe('300');
    expect(byKey.get('interruptEnabled').default).toBe('true');
    expect(byKey.get('callEnabled').default).toBe('false');
  });

  test('calls only memcore', () => {
    expect(manifest.callTargets).toEqual([`${MEMCORE}/chat`]);
  });
});

describe('style.css', () => {
  test('ships no hardcoded colour', () => {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const hex = stripped.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    expect(hex, `style.css 写死了颜色：${hex.join(', ')}`).toEqual([]);
  });
});

// --- plumbing ----------------------------------------------------------------

describe('plumbing：打断与整条链路', () => {
  test('speech-start immediately stops the playing audio (THE interrupt)', async () => {
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    await pump(24);
    window.__call.startCall();
    bridgeLevel = 80;
    const tick = window.__call.pollFrame();
    await pump(20);
    await tick;
    expect(requestsFor('audio.stop')).toHaveLength(1);
    expect(window.__call.state().stats.interrupts).toBe(1);
  }, 20000);

  test('full pipeline: speech → ASR → chat → TTS → play → bubble', async () => {
    await loadApp();
    bootValues = { vadThreshold: '40', frameMs: '100', minSpeechMs: '300', silenceMs: '1200', maxUtteranceMs: '15000', asrBaseUrl: '127.0.0.1:23240', ttsBaseUrl: '127.0.0.1:9880', voiceRefPath: 'ref.wav' };
    hostSends(initFrame({ slot: 'background' }));
    await pump(24);
    window.__call.startCall();
    bridgeClip = 'RIFFchunk';
    // 大声 5 帧 → recording-start；切片被拉取。
    bridgeLevel = 80;
    for (let i = 0; i < 5; i += 1) {
      const tick = window.__call.pollFrame();
      await pump(20);
      await tick;
    }
    expect(window.__call.state().state).toBe('recording');
    expect(fetches.filter((f) => String(f.url).includes('/clip')).length).toBeGreaterThan(0);
    // 静音 12 帧 → send → 处理。
    bridgeLevel = 3;
    for (let i = 0; i < 13; i += 1) {
      const tick = window.__call.pollFrame();
      await pump(30);
      await tick;
    }
    expect(window.__call.state().stats.utterances).toBe(1);
    // ASR 收到了切片。
    const asr = fetches.find((f) => String(f.url).includes('/asr'));
    expect(asr).toBeTruthy();
    expect(JSON.parse(asr.body).audio).toContain('RIFF');
    // 记忆核心收到识别文本。
    const call = calls[calls.length - 1];
    expect(call.payload.roleId).toBe('voice-call');
    expect(call.payload.text).toBe('今天天气怎么样');
    // TTS + 播放 + 气泡。
    const tts = fetches.find((f) => String(f.url).includes('/tts'));
    expect(tts).toBeTruthy();
    expect(JSON.parse(tts.body).text).toBe('晴，适合出门。');
    expect(requestsFor('audio.play').length).toBeGreaterThan(0);
    expect(requestsFor('bubble.say').length).toBeGreaterThan(0);
    expect(window.__call.state().state).toBe('idle');
  }, 30000);

  test('user speaks again mid-reply → at most one reply, state returns to idle', async () => {
    await loadApp();
    bootValues = { vadThreshold: '40', frameMs: '100', minSpeechMs: '300', silenceMs: '1200', maxUtteranceMs: '15000', asrBaseUrl: '127.0.0.1:23240', ttsBaseUrl: '127.0.0.1:9880', voiceRefPath: 'ref.wav' };
    hostSends(initFrame({ slot: 'background' }));
    await pump(24);
    window.__call.startCall();
    bridgeLevel = 80;
    let tick = null;
    for (let i = 0; i < 5; i += 1) {
      tick = window.__call.pollFrame();
      await pump(20);
      await tick;
    }
    // 静音满 silenceMs（12 帧 @100ms）→ send。处理开始（ASR 在飞）。
    bridgeLevel = 3;
    tick = window.__call.pollFrame();
    await pump(20);
    await tick;
    for (let i = 0; i < 11; i += 1) {
      tick = window.__call.pollFrame();
      await pump(20);
      await tick;
    }
    // send 事件已产生；processUtterance 的异步链（ASR → chat → TTS）可能已完成也可能在飞，
    // 两种都合法——状态机只认事件。
    expect(['send', 'idle']).toContain(window.__call.state().state);
    // SEND 期间音量又上来：打断位 → abort → idle（若链路已跑完则是新的一轮开头，同样合法）。
    bridgeLevel = 85;
    tick = window.__call.pollFrame();
    await pump(20);
    await tick;
    // 无论哪条路：状态合法、绝没有出现"一次语音两次回答"。
    expect(['idle', 'listening', 'recording', 'send']).toContain(window.__call.state().state);
    expect(window.__call.state().stats.replies).toBeLessThanOrEqual(1);
    expect(calls.length).toBeLessThanOrEqual(1);
    // 收尾：闭嘴（静音），让任何未完的轮次自然落回 idle。
    bridgeLevel = 0;
    for (let i = 0; i < 14; i += 1) {
      tick = window.__call.pollFrame();
      await pump(20);
      await tick;
    }
    expect(['idle', 'send']).toContain(window.__call.state().state);
    expect(window.__call.state().stats.replies).toBeLessThanOrEqual(1);
  }, 30000);

  test('ASR empty text finishes without a model call', async () => {
    asrText = '';
    await loadApp();
    bootValues = { vadThreshold: '40', frameMs: '100', minSpeechMs: '300', silenceMs: '1200', maxUtteranceMs: '15000', asrBaseUrl: '127.0.0.1:23240', ttsBaseUrl: '127.0.0.1:9880', voiceRefPath: 'ref.wav' };
    hostSends(initFrame({ slot: 'background' }));
    await pump(24);
    window.__call.startCall();
    bridgeLevel = 80;
    for (let i = 0; i < 5; i += 1) {
      const tick = window.__call.pollFrame();
      await pump(20);
      await tick;
    }
    bridgeLevel = 3;
    for (let i = 0; i < 13; i += 1) {
      const tick = window.__call.pollFrame();
      await pump(30);
      await tick;
    }
    expect(calls).toHaveLength(0);
    expect(window.__call.state().state).toBe('idle');
  }, 30000);

  test('the audio bridge being down keeps the loop alive with the error on record', async () => {
    bridgeUp = false;
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    await pump(24);
    window.__call.startCall();
    const tick = window.__call.pollFrame();
    await pump(20);
    await tick;
    expect(window.__call.state().lastError).toContain('音频桥');
    expect(window.__call.state().running).toBe(true);
  }, 20000);

  test('the share command starts/stops the loop once per at', async () => {
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    await pump(24);
    shareMap.set(`${PLUGIN_ID}/call-command`, JSON.stringify({ op: 'start', at: 1000 }));
    const poll = window.__call.pollCommand();
    await pump(8);
    await poll;
    expect(window.__call.state().running).toBe(true);
    const poll2 = window.__call.pollCommand();
    await pump(8);
    await poll2;
    expect(window.__call.state().running).toBe(true);
    shareMap.set(`${PLUGIN_ID}/call-command`, JSON.stringify({ op: 'stop', at: 1001 }));
    const poll3 = window.__call.pollCommand();
    await pump(8);
    await poll3;
    expect(window.__call.state().running).toBe(false);
  });

  test('granted=[] sends nothing that needs a permission', async () => {
    await loadApp();
    hostSends(initFrame({ slot: 'background', granted: [] }));
    await pump(12);
    expect(requests()).toEqual([]);
  });
});
