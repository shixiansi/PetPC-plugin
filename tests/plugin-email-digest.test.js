import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Behaviour tests for the email-digest plugin.
//
// Four groups:
//   mime           RFC822/MIME parsing in isolation: encodings (QP, Base64),
//                  multipart, HTML stripping, RFC2047 subjects, attachments,
//                  and hostile/malformed inputs.
//   manifest+css   host pairing rules + CSS house rules.
//   the frame      handshake, workshop render, granted=[] silence.
//   plumbing       fetch via the fake bridge, local spam pre-filter, one-call
//                  classify+summarize through memcore, degraded mode, bubble &
//                  TTS delivery, and the daily auto-tick.

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-email-digest');
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

const PLUGIN_ID = 'com.shixiansi.plugin-email-digest';
const PERMISSIONS = manifest.permissions;
const ALL_GRANTED = [...PERMISSIONS];
const MEMCORE = 'com.shixiansi.plugin-memcore';

// --- harness -----------------------------------------------------------------

let windowListeners = [];
let bootValues = {};
const storageMap = new Map();
let intervals = [];
const answered = new Set();
let postedFrom = 0;
const calls = [];
const fetches = [];
/** /unread 的返回。 */
let unreadMails = [];
let unreadStatus = 200;
/** 记忆核心的回答。 */
let memcoreAnswer = { text: 'JSON 占位' };
let memcoreFails = false;
/** TTS。 */
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
      case 'storage.get': {
        const key = String(payload.key || '');
        answer(req.id, { value: storageMap.has(key) ? storageMap.get(key) : '' });
        break;
      }
      case 'storage.set':
        storageMap.set(String(payload.key || ''), String(payload.value || ''));
        answer(req.id, { ok: true });
        break;
      case 'net.fetch': {
        fetches.push(payload);
        const url = String(payload.url || '');
        if (url.includes('/unread')) {
          if (unreadStatus !== 200) answer(req.id, { status: unreadStatus, body: '' });
          else answer(req.id, { status: 200, body: JSON.stringify({ mails: unreadMails }) });
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
      case 'bubble.say':
        answer(req.id, { ok: true });
        break;
      case 'audio.save':
        answer(req.id, { name: payload.name, bytes: 16 });
        break;
      case 'audio.play':
        answer(req.id, { ok: true });
        break;
      case 'events.subscribe':
        answer(req.id, payload.names || []);
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
  intervals = [];
  answered.clear();
  unreadMails = [];
  unreadStatus = 200;
  memcoreAnswer = { text: 'JSON 占位' };
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

function defaultValues() {
  const values = {};
  for (const item of manifest.config) {
    if (item.secret) continue;
    if (item.default !== undefined) values[item.key] = item.default;
  }
  return values;
}

// --- MIME 解析 ---------------------------------------------------------------

describe('mime：RFC822/MIME 解析', () => {
  beforeEach(async () => {
    await loadApp();
  });

  test('parses a plain ASCII mail end to end', () => {
    const raw = [
      'From: 张三 <zhang@corp.example>',
      'To: me@corp.example',
      'Subject: 周会改到下午三点',
      'Date: Fri, 30 Oct 2026 09:00:00 +0800',
      'Content-Type: text/plain; charset=utf-8',
      '',
      '会议室换了，请带上周报。',
    ].join('\r\n');
    const mail = window.__mail.mime.parse(raw);
    expect(mail.subject).toBe('周会改到下午三点');
    expect(mail.fromEmail).toBe('zhang@corp.example');
    expect(mail.from).toContain('张三');
    expect(mail.body).toContain('周报');
    expect(mail.attachments).toEqual([]);
  });

  test('decodes base64 transfer encoding with UTF-8', () => {
    const body = Buffer.from('这是一段 Base64 编码的正文。', 'utf8').toString('base64');
    const raw = [
      'From: a@b.c',
      'Subject: base64',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      body,
    ].join('\n');
    const mail = window.__mail.mime.parse(raw);
    expect(mail.body).toContain('Base64 编码的正文');
  });

  test('decodes quoted-printable including soft line breaks and UTF-8 bytes', () => {
    // "报价如下：" 的 UTF-8 QP 编码 + 一个软换行。
    const qp = '=E6=8A=A5=E4=BB=B7=E5=A6=82=E4=B8=8B=\n：100 元';
    const raw = [
      'From: a@b.c',
      'Subject: qp',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      qp,
    ].join('\n');
    const mail = window.__mail.mime.parse(raw);
    expect(mail.body).toContain('报价如下：100 元');
  });

  test('prefers text/plain and strips HTML only as fallback', () => {
    const raw = [
      'From: a@b.c',
      'Subject: both',
      `Content-Type: multipart/alternative; boundary="XYZ"`,
      '',
      '--XYZ',
      'Content-Type: text/plain; charset=utf-8',
      '',
      '纯文本版本。',
      '--XYZ',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<html><body><p>HTML <b>版本</b>。<script>evil()</script></p></body></html>',
      '--XYZ--',
    ].join('\n');
    const mail = window.__mail.mime.parse(raw);
    expect(mail.body).toContain('纯文本版本');
    expect(mail.body).not.toContain('HTML');
  });

  test('falls back to HTML and strips tags, scripts and entities', () => {
    const raw = [
      'From: a@b.c',
      'Subject: html only',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>第一段 &amp; 亮点</p><script>alert(1)</script><style>.x{}</style><p>第二段</p>',
    ].join('\n');
    const mail = window.__mail.mime.parse(raw);
    expect(mail.body).toContain('第一段 & 亮点');
    expect(mail.body).toContain('第二段');
    expect(mail.body).not.toContain('alert');
    expect(mail.body).not.toContain('.x{}');
    expect(mail.body).not.toMatch(/<[a-z]/i);
  });

  test('decodes RFC2047 subjects (B and Q encodings)', () => {
    const bSubject = `=?utf-8?B?${Buffer.from('季度报表', 'utf8').toString('base64')}?=`;
    const qSubject = '=?utf-8?Q?re:_=E9=97=AE=E9=A2=98?=';
    const raw = [
      `From: a@b.c`,
      `Subject: ${bSubject}`,
      '',
      'x',
    ].join('\n');
    expect(window.__mail.mime.parse(raw).subject).toBe('季度报表');
    const raw2 = raw.replace(bSubject, qSubject);
    expect(window.__mail.mime.parse(raw2).subject).toBe('re: 问题');
  });

  test('collects attachment filenames without reading content', () => {
    const raw = [
      'From: a@b.c',
      'Subject: 附件',
      `Content-Type: multipart/mixed; boundary="MIX"`,
      '',
      '--MIX',
      'Content-Type: text/plain; charset=utf-8',
      '',
      '见附件。',
      '--MIX',
      'Content-Type: application/pdf; name="report.pdf"',
      'Content-Disposition: attachment; filename="report.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      'JVBERi0xLjQ=',
      '--MIX--',
    ].join('\n');
    const mail = window.__mail.mime.parse(raw);
    expect(mail.attachments).toEqual(['report.pdf']);
    expect(mail.body).toContain('见附件');
  });

  test('never throws on garbage, and header folding keeps the value', () => {
    expect(() => window.__mail.mime.parse('张三 李四 {} [[[')).not.toThrow();
    expect(window.__mail.mime.parse('').subject).toBe('');
    const folded = [
      'From: a@b.c',
      'Subject: 第一行',
      '  接着第二行',
      '',
      'x',
    ].join('\n');
    expect(window.__mail.mime.parse(folded).subject).toBe('第一行 接着第二行');
  });

  test('toPrompt clamps the body and marks the cut', () => {
    const mail = { from: 'x', fromEmail: 'x@y.z', subject: 's', body: '字'.repeat(6000), attachments: ['a.pdf'] };
    const prompt = window.__mail.mime.toPrompt(mail, 100);
    expect(prompt).toContain('x@y.z');
    expect(prompt).toContain('a.pdf');
    expect(prompt).toContain('已截断');
  });
});

// --- manifest & css ----------------------------------------------------------

describe('manifest', () => {
  test('declares the headless frame, the bridge and TTS on the allow-list', () => {
    expect(manifest.background).toBe(true);
    expect(manifest.permissions).toContain('net.fetch');
    expect(manifest.permissions).toContain('events');
    expect(manifest.netHosts).toContain('127.0.0.1:23220');
    const bridge = manifest.config.find((item) => item.key === 'bridgeUrl');
    const tts = manifest.config.find((item) => item.key === 'ttsBaseUrl');
    expect(bridge.hostWhitelist).toBe(true);
    expect(tts.hostWhitelist).toBe(true);
  });

  test('the FIRST secret is the model credential; classify is on by default', () => {
    const secrets = manifest.config.filter((item) => item.secret === true);
    expect(secrets).toHaveLength(1);
    expect(secrets[0].key).toBe('llmApiKey');
    const byKey = new Map(manifest.config.map((item) => [item.key, item]));
    expect(byKey.get('classifyEnabled').default).toBe('true');
    expect(byKey.get('speakDigest').default).toBe('false');
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

// --- the frame ---------------------------------------------------------------

describe('the frame', () => {
  test('workshop renders and never fetches on its own', async () => {
    await loadApp();
    hostSends(initFrame({ slot: 'workshop' }));
    await pump(12);
    expect(requestsFor('net.fetch')).toHaveLength(0);
    expect(document.getElementById('workshop').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('mail-empty').hidden).toBe(false);
  });

  test('background boot subscribes to config.changed and starts the clock', async () => {
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    await pump(24);
    expect(requestsFor('events.subscribe')[0].payload.names).toContain('config.changed');
  });

  test('granted=[] sends nothing that needs a permission', async () => {
    await loadApp();
    hostSends(initFrame({ slot: 'background', granted: [] }));
    await pump(12);
    expect(requests()).toEqual([]);
  });
});

// --- plumbing ----------------------------------------------------------------

const MAIL_URGENT = [
  'From: 老板 <boss@corp.example>',
  'To: me@corp.example',
  'Subject: 今天下午 3 点前给我报价',
  'Content-Type: text/plain; charset=utf-8',
  '',
  '客户在等，务必今天下午三点之前把报价发我。',
].join('\r\n');

const MAIL_NORMAL = [
  'From: GitLab <git@corp.example>',
  'To: me@corp.example',
  'Subject: [GitLab] Pipeline #123 passed',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Your pipeline passed.',
].join('\r\n');

const MAIL_SPAM = [
  'From: promo@shop.example',
  'To: me@corp.example',
  'Subject: 限时促销：全场五折优惠券',
  'Content-Type: text/plain; charset=utf-8',
  '',
  '最后一天！',
].join('\r\n');

const CLASSIFY_JSON = JSON.stringify({
  mails: [
    { n: 1, kind: 'urgent', summary: '老板要今天三点前给报价', reason: '有明确时间点' },
    { n: 2, kind: 'normal', summary: '', reason: '流水线通知' },
  ],
});

describe('plumbing：抓取、分类、推送', () => {
  test('digest fetches unread, pre-filters spam locally, classifies the rest in ONE call', async () => {
    unreadMails = [MAIL_URGENT, MAIL_NORMAL, MAIL_SPAM];
    memcoreAnswer = { text: `好的：\n${CLASSIFY_JSON}` };
    await loadApp();
    bootValues = { ...defaultValues(), bubbleEnabled: undefined };
    hostSends(initFrame({ slot: 'background' }));
    await pump(24);
    const record = await (async () => {
      const p = window.__mail.digestOnce({ push: false });
      await pump(40);
      return p;
    })();
    expect(record.total).toBe(3);
    expect(record.urgent).toBe(1);
    expect(record.normal).toBe(1);
    expect(record.spam).toBe(1);
    // 本地垃圾词直接拦下第三封（不进模型）——模型只见到两封。
    const call = calls[calls.length - 1];
    expect(call.method).toBe('chat');
    expect(call.payload.roleId).toBe('email-digest');
    expect(call.payload.text).toContain('【邮件 1】');
    expect(call.payload.text).toContain('报价');
    expect(call.payload.text).not.toContain('限时促销');
    // 紧急摘要在记录里。
    const urgentMail = record.mails.find((m) => m.kind === 'urgent');
    expect(urgentMail.summary).toBe('老板要今天三点前给报价');
    // 摘要落盘。
    const log = JSON.parse(storageMap.get('state/digest-log') || '[]');
    expect(log).toHaveLength(1);
    expect(log[0].total).toBe(3);
  }, 20000);

  test('deliver pushes a bubble and optionally speaks the summary', async () => {
    unreadMails = [MAIL_URGENT];
    memcoreAnswer = { text: CLASSIFY_JSON };
    await loadApp();
    bootValues = { ...defaultValues(), speakDigest: 'true', voiceRefPath: 'ref.wav', ttsBaseUrl: '127.0.0.1:9880' };
    hostSends(initFrame({ slot: 'background' }));
    await pump(24);
    const record = await (async () => {
      const p = window.__mail.digestOnce({ push: true });
      await pump(50);
      return p;
    })();
    expect(record.urgent).toBe(1);
    const bubbles = requestsFor('bubble.say');
    expect(bubbles.length).toBeGreaterThan(0);
    expect(bubbles[0].payload.text).toContain('紧急');
    const tts = fetches.find((f) => String(f.url).includes('/tts'));
    expect(tts, 'TTS request missing').toBeTruthy();
    expect(tts.encoding).toBe('base64');
    expect(JSON.parse(tts.body).ref_audio_path).toBe('ref.wav');
    expect(requestsFor('audio.play').length).toBeGreaterThan(0);
  }, 20000);

  test('speak without voice config records the failure instead of throwing', async () => {
    unreadMails = [MAIL_NORMAL];
    memcoreAnswer = { text: CLASSIFY_JSON };
    await loadApp();
    bootValues = { ...defaultValues(), speakDigest: 'true', voiceRefPath: '' };
    hostSends(initFrame({ slot: 'background' }));
    await pump(24);
    await (async () => {
      const p = window.__mail.digestOnce({ push: true });
      await pump(40);
      return p;
    })();
    expect(window.__mail.state().lastError).toContain('语音');
    expect(fetches.filter((f) => String(f.url).includes('/tts'))).toHaveLength(0);
  }, 20000);

  test('model failure degrades to all-normal with a note, mail is never lost', async () => {
    unreadMails = [MAIL_URGENT];
    memcoreFails = true;
    await loadApp();
    bootValues = defaultValues();
    hostSends(initFrame({ slot: 'background' }));
    await pump(24);
    const record = await (async () => {
      const p = window.__mail.digestOnce({ push: false });
      await pump(40);
      return p;
    })();
    expect(record.total).toBe(1);
    expect(record.normal).toBe(1);
    expect(record.summary).toContain('模型没有给出分类');
  }, 20000);

  test('a hostile model answer (non-JSON) degrades the same way', async () => {
    unreadMails = [MAIL_NORMAL];
    memcoreAnswer = { text: '这段代码看起来不错。' };
    await loadApp();
    bootValues = defaultValues();
    hostSends(initFrame({ slot: 'background' }));
    await pump(24);
    const verdicts = await (async () => {
      const p = window.__mail.classifyBatch([{ mail: window.__mail.mime.parse(MAIL_NORMAL) }]);
      await pump(20);
      return p;
    })();
    expect(verdicts).toBeNull();
  }, 20000);

  test('parseClassify aligns verdicts by n and clamps lengths', async () => {
    await loadApp();
    const out = window.__mail.parseClassify(
      JSON.stringify({ mails: [
        { n: 2, kind: 'spam' },
        { n: 1, kind: 'urgent', summary: 'x'.repeat(200) },
        { n: 9, kind: 'urgent' },
      ] }),
      2,
    );
    expect(out).toHaveLength(2);
    expect(out[0].kind).toBe('urgent');
    expect(out[0].summary.length).toBeLessThanOrEqual(80);
    expect(out[1].kind).toBe('spam');
  });

  test('the bridge being down leaves the lastError and an empty batch', async () => {
    unreadStatus = 503;
    await loadApp();
    bootValues = defaultValues();
    hostSends(initFrame({ slot: 'background' }));
    await pump(24);
    const record = await (async () => {
      const p = window.__mail.digestOnce({ push: false });
      await pump(30);
      return p;
    })();
    expect(record.total).toBe(0);
    expect(window.__mail.state().lastError).toContain('桥');
  }, 20000);

  test('autoTick fires once per day at digestTime, not before it', async () => {
    await loadApp();
    bootValues = { ...defaultValues(), digestTime: '00:00' };
    hostSends(initFrame({ slot: 'background' }));
    await pump(24);
    // digestTime 00:00 = 已经过了：第一拍就跑。
    const fired = await (async () => {
      const p = window.__mail.autoTick();
      await pump(30);
      return p;
    })();
    expect(fired).toBe(true);
    unreadMails = [MAIL_NORMAL];
    memcoreAnswer = { text: CLASSIFY_JSON };
    // 同一天第二拍：不再跑。
    const again = await (async () => {
      const p = window.__mail.autoTick();
      await pump(30);
      return p;
    })();
    expect(again).toBe(false);
  }, 20000);

  test('autoTick with a future digestTime does nothing yet', async () => {
    await loadApp();
    bootValues = { ...defaultValues(), digestTime: '23:59' };
    hostSends(initFrame({ slot: 'background' }));
    await pump(24);
    const fired = await (async () => {
      const p = window.__mail.autoTick();
      await pump(20);
      return p;
    })();
    expect(fired).toBe(false);
  }, 20000);

  test('an unread fetch with hostile bodies never throws and never blocks the digest', async () => {
    unreadMails = ['', '   ', MAIL_NORMAL];
    memcoreAnswer = { text: CLASSIFY_JSON };
    await loadApp();
    bootValues = { ...defaultValues(), speakDigest: 'false' };
    hostSends(initFrame({ slot: 'background' }));
    await pump(24);
    const record = await (async () => {
      const p = window.__mail.digestOnce({ push: false });
      await pump(40);
      return p;
    })();
    // 空串被过滤掉，只解析了真邮件。
    expect(record.total).toBe(1);
  }, 20000);
});
