import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 语音插件 1.1.0 的 `speak`（plugin.call）行为测试。
//
// speak 是晨报（rss-reader）等插件的依赖：一段任意文本 → 引擎三步链 → 保存 → 播放。
// 这里钉住的是那条链的真实顺序与回包语义，而不是源码长什么样：
//
//   1. 链的顺序：/set_gpt_weights → /set_sovits_weights → POST /tts（base64）→ audio.save
//      → audio.play，一步都不能少（引擎只保留最后加载的权重，跳步就是错的音色）；
//   2. 每一步的应答错误都会让调用方收到 reject（call-result ok:false），链不会挂在半路；
//   3. 入参清洗：空文本、超长文本各有能拿去修的中文；
//   4. 不认识的方法也回包——调用方永远等得到一句原因，而不是 30 秒超时。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-voice');
const appPath = path.join(pluginDir, 'app.js');
const panelPath = path.join(pluginDir, 'panel.html');
const html = readFileSync(panelPath, 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const PLUGIN_ID = 'com.shixiansi.plugin-voice';
const ALL_GRANTED = [...manifest.permissions];

const CONFIG = {
  ttsBaseUrl: 'http://127.0.0.1:9880',
  gptPath: 'C:/gpt.ckpt',
  sovitsPath: 'C:/sovits.ckpt',
  refPath: 'C:/ref.wav',
  promptText: '',
  promptLang: 'zh',
  speed: '1',
  temperature: '1',
};

let windowListeners = [];

function installPanel() {
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
  for (const attr of ['id', 'class']) {
    const value = parsed.window.document.body.getAttribute(attr);
    if (value) document.body.setAttribute(attr, value);
  }
  const view = parsed.window.document.body.getAttribute('data-view');
  if (view) document.body.setAttribute('data-view', view);
}

async function loadApp() {
  vi.resetModules();
  await import(appPath);
}

function posted() {
  return window.postMessage.mock.calls.map((call) => call[0]);
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

function initFrame({ slot = 'background', granted = ALL_GRANTED } = {}) {
  return {
    v: 1, type: 'init', pluginId: PLUGIN_ID, permissions: manifest.permissions,
    granted, surface: { kind: 'panel', slot },
  };
}

/** 把积压的请求按假宿主的规则全部答掉（net.fetch 按序答 200；storage/config 正常）。 */
async function pump({ engineStatus = 200 } = {}) {
  for (let round = 0; round < 20; round += 1) {
    const open = byType('request').filter((m) => !answered.has(m.id));
    if (!open.length) return;
    for (const req of open) {
      answered.add(req.id);
      const payload = req.payload || {};
      switch (req.method) {
        case 'config.get':
          hostSends({ v: 1, type: 'response', id: req.id, ok: true, result: { values: CONFIG, secrets: {} } });
          break;
        case 'storage.get':
          hostSends({ v: 1, type: 'response', id: req.id, ok: true, result: { value: '' } });
          break;
        case 'audio.list':
          hostSends({ v: 1, type: 'response', id: req.id, ok: true, result: [] });
          break;
        case 'net.fetch': {
          const url = String(payload.url || '');
          if (url.endsWith('/tts')) {
            hostSends({ v: 1, type: 'response', id: req.id, ok: true, result: { status: engineStatus, body: 'UklGRiQAAABf' } });
          } else {
            hostSends({ v: 1, type: 'response', id: req.id, ok: true, result: { status: 200, body: 'ok' } });
          }
          break;
        }
        case 'audio.save':
        case 'audio.play':
          hostSends({ v: 1, type: 'response', id: req.id, ok: true, result: { ok: true } });
          break;
        case 'events.subscribe':
          hostSends({ v: 1, type: 'response', id: req.id, ok: true, result: ['timer.phaseEnded', 'reminder.fired'] });
          break;
        default:
          hostSends({ v: 1, type: 'response', id: req.id, ok: false, error: `本程序不支持该方法 ${req.method}` });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

let answered;

/** 发一次 plugin.call 的 speak，返回「取回包」的函数。 */
function callSpeak(payload, method = 'speak') {
  const before = byType('call-result').length;
  const ticket = `t-${Math.random().toString(36).slice(2, 8)}`;
  hostSends({ v: 1, type: 'call', ticket, from: 'com.shixiansi.plugin-rss-reader', method, payload });
  return () => {
    const list = byType('call-result').slice(before);
    expect(list.length, 'speak 一直没有回包（call-result 缺失）').toBeGreaterThan(0);
    return list[list.length - 1];
  };
}

/** 直接驱动内部 speak（promise 级），并并发泵宿主应答。 */
async function speakDirect(payload) {
  const p = window.__voiceSpeak.speak(payload);
  await pump();
  return p;
}

beforeEach(() => {
  answered = new Set();
  installPanel();
  windowListeners = [];
  const originalAdd = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(function (type, fn, opts) {
    windowListeners.push([type, fn, opts]);
    return originalAdd(type, fn, opts);
  });
  vi.spyOn(window, 'postMessage').mockImplementation(() => {});
});

afterEach(() => {
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  vi.restoreAllMocks();
});

describe('manifest', () => {
  test('serves exactly speak and asks plugin.call for it', () => {
    expect(manifest.serves).toEqual(['speak']);
    expect(manifest.permissions).toContain('plugin.call');
  });
});

describe('speak: the engine chain', () => {
  test('the full chain fires in order: gpt weights → sovits weights → /tts → save → play', async () => {
    await loadApp();
    hostSends(initFrame());
    await pump();

    const out = await speakDirect({ text: '早上好，这是今天的晨报。' });
    expect(out.played).toBe(true);
    expect(out.clip).toMatch(/^speak-/);

    // 三步网络请求的顺序与形状（引擎只保留最后加载的权重，顺序就是音色）。
    const fetches = requestsFor('net.fetch');
    expect(fetches).toHaveLength(3);
    expect(fetches[0].payload.url).toContain('/set_gpt_weights?weights_path=C%3A%2Fgpt.ckpt');
    expect(fetches[1].payload.url).toContain('/set_sovits_weights?weights_path=C%3A%2Fsovits.ckpt');
    expect(fetches[2].payload.url).toContain('/tts');
    expect(fetches[2].payload.encoding).toBe('base64');
    const body = JSON.parse(fetches[2].payload.body);
    expect(body.text).toBe('早上好，这是今天的晨报。');
    // 保存与播放用的是同一个 slot 名：播放按文件（手册 §6.9），save 没写完就 play 是空的。
    const saved = requestsFor('audio.save');
    const played = requestsFor('audio.play');
    expect(saved).toHaveLength(1);
    expect(played).toHaveLength(1);
    expect(played[0].payload.name).toBe(saved[0].payload.name);
  });

  test('the plugin.call surface routes speak and answers every ticket', async () => {
    await loadApp();
    hostSends(initFrame());
    await pump();

    const getResult = callSpeak({ text: '你好' });
    await pump();
    const packet = getResult();
    expect(packet.ok).toBe(true);
    expect(packet.result.played).toBe(true);
  });

  test('an engine error at any step rejects the caller instead of hanging the chain', async () => {
    await loadApp();
    hostSends(initFrame());
    await pump({ engineStatus: 200 });

    // /tts 答非 200：链在第三步断，调用方拿到原因，保存与播放都不发生。
    // rejects 是接住的（await expect(...).rejects）——不然一条"预期中的拒绝"会以
    // 未处理拒绝收场，vitest 会把它算成套件错误。
    const p = window.__voiceSpeak.speak({ text: '测试' });
    const expectation = expect(p).rejects.toThrow('语音服务返回');
    await pump({ engineStatus: 500 });
    await expectation;
    expect(requestsFor('audio.save')).toHaveLength(0);
    expect(requestsFor('audio.play')).toHaveLength(0);
  });

  test('empty and over-long text are rejected with fixable Chinese, before any network', async () => {
    await loadApp();
    hostSends(initFrame());
    await pump();

    expect(() => window.__voiceSpeak.cleanPayload({ text: '   ' })).toThrow('speak 需要 text');
    expect(() => window.__voiceSpeak.cleanPayload({ text: '啊'.repeat(501) })).toThrow('≤500');
    expect(requestsFor('net.fetch')).toHaveLength(0);
  });

  test('an unknown call method is answered with an error, never silence', async () => {
    await loadApp();
    hostSends(initFrame());
    await pump();
    const getResult = callSpeak({}, 'sing');
    await pump();
    const packet = getResult();
    expect(packet.ok).toBe(false);
    expect(packet.error).toContain('speak');
  });
});
