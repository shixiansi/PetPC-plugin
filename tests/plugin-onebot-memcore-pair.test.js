import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 两个插件一起跑：**接入端**（OneBot）与**记忆核心**，中间是一个照着宿主规矩办事的假宿主。
//
// 这个文件存在的理由：两边各自的测试都只能证明"它按我以为的形状发消息"。真正的问题是那条
// 链路——一帧 OneBot JSON 进来，最后会不会变成群里的一句回答，而记忆只落在核心那一边。
// 所以这里把两个**独立的 window**（等于两个 iframe）同时装起来，用一个假宿主在两份 inbox
// 之间转发 plugin.call，并且**按 manifest 的声明**做那道闸门：
//
//   · 调用方（适配器）的 callTargets 必须点名 <target>/<method>；
//   · 被调用方（核心）的 serves 必须点名那个 method。
//
// 于是一条声明写错的插件在这条用例里就装不上了，而不是等到真机上"它没反应"。

const here = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER_DIR = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-onebot');
const CORE_DIR = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-memcore');

const ADAPTER_ID = 'com.shixiansi.plugin-onebot';
const CORE_ID = 'com.shixiansi.plugin-memcore';

function readManifest(dir) {
  return JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
}
const adapterManifest = readManifest(ADAPTER_DIR);
const coreManifest = readManifest(CORE_DIR);

/** 装一份插件文档到它自己的 window 里（等同于宿主建的那个 iframe）。 */
function makeDoc(dir, { slot, config }) {
  const html = readFileSync(path.join(dir, 'panel.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://plugin.test/panel.html' });
  const w = dom.window;

  // 宿主这一侧的三个接缝：出站消息的收件箱、监听器的登记表、以及定时器。
  // jsdom 里 `window.parent` 就是 window 自己，所以"发给宿主"就是发给这个 window。
  const inbox = [];
  w.postMessage = (msg) => inbox.push(msg);
  const listeners = [];
  const add = w.addEventListener.bind(w);
  w.addEventListener = (type, fn, opts) => {
    listeners.push([type, fn, opts]);
    return add(type, fn, opts);
  };
  const intervals = [];
  const interval = w.setInterval.bind(w);
  w.setInterval = (fn, ms) => {
    const id = interval(fn, ms);
    intervals.push(id);
    return id;
  };

  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  if (!scripts.length) throw new Error('panel.html 没有加载任何插件脚本');
  // 一次 eval 所有脚本：等于浏览器里它们共享同一个全局作用域（分开 eval 会让 const 互相看不见）。
  w.eval(scripts.map((src) => readFileSync(path.join(dir, src), 'utf8')).join('\n'));

  return {
    w,
    dom,
    inbox,
    slot,
    storage: new Map(),
    config,
    send(data) {
      w.dispatchEvent(new w.MessageEvent('message', { data, source: w }));
    },
    close() {
      for (const [type, fn, opts] of listeners) w.removeEventListener(type, fn, opts);
      for (const id of intervals) w.clearInterval(id);
      w.close();
    },
  };
}

// --- fake host ---------------------------------------------------------------

let core;
let adapter;
/** 每一条 ws.send 的正文（JSON 字符串），也就是适配器真正发出去的动作。 */
let wsFrames;
/** 每一条 llm.chat 的 payload，用来断言核心给模型喂了什么。 */
let llmCalls;
let llmReply;
/** 协议端是否把 `echo` 带回（真实实现会，糙的实现可能不会）。 */
let echoReplies;
/** 谁拥有哪份存储：这是"插件之间不共享文件"的那条规矩。 */
let answered;

function makeCore() {
  return makeDoc(CORE_DIR, {
    slot: 'background',
    config: {
      personaName: '小记',
      persona: '你是个记性很好的搭子。',
      replyMaxChars: '240',
      bufferTurns: '8',
      summaryChars: '500',
      episodeMax: '40',
      profileEvery: '3',
      llmDailyBudget: '200',
    },
  });
}

function makeAdapter() {
  return makeDoc(ADAPTER_DIR, {
    slot: 'background',
    config: {
      wsUrl: 'ws://127.0.0.1:3001',
      accessToken: '',
      selfId: '10000',
      atOnly: 'true',
      prefix: '',
      privateReply: 'true',
      groupAllow: '',
      quoteReply: 'true',
      atSender: 'false',
      cooldownSec: '0',
      errorToChat: 'false',
    },
  });
}

/** 一份 request 的应答，按"哪一份文档的存储"分开。 */
function answerRequest(doc, req) {
  const payload = req.payload || {};
  const storage = doc.storage;
  switch (req.method) {
    case 'config.get':
      doc.send({ v: 1, type: 'response', id: req.id, ok: true, result: { values: doc.config, secrets: {} } });
      return;
    case 'storage.get':
      doc.send({
        v: 1, type: 'response', id: req.id, ok: true,
        result: { value: storage.has(String(payload.key)) ? storage.get(String(payload.key)) : '' },
      });
      return;
    case 'storage.set':
      storage.set(String(payload.key), String(payload.value || ''));
      doc.send({ v: 1, type: 'response', id: req.id, ok: true, result: { ok: true } });
      return;
    case 'storage.remove':
      storage.delete(String(payload.key));
      doc.send({ v: 1, type: 'response', id: req.id, ok: true, result: { removed: true } });
      return;
    case 'storage.list': {
      const sub = String(payload.sub || '');
      const prefix = sub ? `${sub}/` : '';
      const files = [];
      const dirs = new Set();
      for (const [key, value] of storage) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (!rest) continue;
        const slash = rest.indexOf('/');
        if (slash < 0) files.push({ name: rest, bytes: String(value).length });
        else dirs.add(rest.slice(0, slash));
      }
      doc.send({ v: 1, type: 'response', id: req.id, ok: true, result: { dir: 'C:\\data', files, dirs: [...dirs] } });
      return;
    }
    case 'llm.profile':
      doc.send({
        v: 1, type: 'response', id: req.id, ok: true,
        result: { ownReady: false, borrowAllowed: true, ready: true, source: 'borrowed', model: 'test-model' },
      });
      return;
    case 'llm.chat':
      llmCalls.push(payload);
      doc.send({ v: 1, type: 'response', id: req.id, ok: true, result: { requestId: 'sim', text: llmReply } });
      return;
    case 'ws.open':
      doc.send({ v: 1, type: 'response', id: req.id, ok: true, result: { ok: true, state: 'connecting', url: payload.url } });
      return;
    case 'ws.send': {
      // 真实协议端会把 `echo` 原样带回：那个回应才是"这个动作成功了"的凭据。不过发送只等
      // `ws.send` 自己的回应（见 lib/send.js），所以 `echoReplies=false` 时也要照样工作。
      const frame = JSON.parse(String(payload.text));
      wsFrames.push(frame);
      doc.send({ v: 1, type: 'response', id: req.id, ok: true, result: { ok: true } });
      if (echoReplies) {
        doc.send({
          v: 1, type: 'event', name: 'ws.message',
          payload: {
            text: JSON.stringify({
              status: 'ok', retcode: 0, data: { message_id: 4242 }, echo: frame.echo,
            }),
          },
        });
      }
      return;
    }
    case 'ws.close':
      doc.send({ v: 1, type: 'response', id: req.id, ok: true, result: { ok: true } });
      return;
    case 'ws.state':
      doc.send({ v: 1, type: 'response', id: req.id, ok: true, result: { state: 'open', received: 0, sent: 0 } });
      return;
    case 'plugin.call': {
      const target = String(payload.target || '');
      const method = String(payload.method || '');
      const declared = Array.isArray(adapterManifest.callTargets) ? adapterManifest.callTargets : [];
      if (!declared.includes(`${target}/${method}`)) {
        doc.send({
          v: 1, type: 'response', id: req.id, ok: false,
          error: `插件 ${ADAPTER_ID} 没有声明要调用 ${target}/${method}：manifest 的 callTargets 里没有这一项`,
        });
        return;
      }
      const serves = Array.isArray(coreManifest.serves) ? coreManifest.serves : [];
      if (!core || !serves.includes(method)) {
        doc.send({ v: 1, type: 'response', id: req.id, ok: false, error: 'plugin.call 的目标插件未启用' });
        return;
      }
      const ticket = `tkt-${answered.calls.size + 1}`;
      answered.calls.set(ticket, { doc, id: req.id });
      core.send({ v: 1, type: 'call', ticket, from: ADAPTER_ID, method, payload: payload.payload });
      return;
    }
    default:
      doc.send({ v: 1, type: 'response', id: req.id, ok: false, error: `本程序不支持该方法 ${req.method}` });
  }
}

const macro = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 一轮：把两份 inbox 里的请求都答掉，把核心的 call-result 送回适配器。 */
function round() {
  let acted = 0;
  for (const doc of [core, adapter]) {
    if (!doc) continue;
    const who = doc === core ? 'core' : 'adapter';
    for (const msg of doc.inbox) {
      if (!msg || msg.type !== 'request') continue;
      const key = `${who}:${msg.id}`;
      if (answered.requests.has(key)) continue;
      answered.requests.add(key);
      acted += 1;
      answerRequest(doc, msg);
    }
  }
  // 核心的 call-result → 适配器那条 plugin.call 的 response。
  for (const msg of core ? core.inbox : []) {
    if (!msg || msg.type !== 'call-result') continue;
    const waiter = answered.calls.get(msg.ticket);
    if (!waiter) continue;
    answered.calls.delete(msg.ticket);
    acted += 1;
    if (msg.ok) {
      waiter.doc.send({ v: 1, type: 'response', id: waiter.id, ok: true, result: msg.result });
    } else {
      waiter.doc.send({ v: 1, type: 'response', id: waiter.id, ok: false, error: msg.error });
    }
  }
  return acted;
}

async function pump(maxRounds = 80) {
  let idle = 0;
  for (let i = 0; i < maxRounds; i += 1) {
    const acted = round();
    await macro();
    if (acted === 0) {
      idle += 1;
      if (idle >= 3) return;
    } else {
      idle = 0;
    }
  }
}

function bootDocs() {
  core = makeCore();
  adapter = makeAdapter();
  const grantedCore = [...coreManifest.permissions];
  const grantedAdapter = [...adapterManifest.permissions];
  core.send({
    v: 1, type: 'init', pluginId: CORE_ID, permissions: coreManifest.permissions,
    granted: grantedCore, surface: { kind: 'panel', slot: 'background' }, theme: 'dark',
  });
  adapter.send({
    v: 1, type: 'init', pluginId: ADAPTER_ID, permissions: adapterManifest.permissions,
    granted: grantedAdapter, surface: { kind: 'panel', slot: 'background' }, theme: 'dark',
  });
}

/** 一条群消息，形状照 OneBot v11 的 message 事件。 */
let nextMessageID = 900;
function groupFrame({ groupId = 1001, userId = 2002, name = '阿岚', text = '周五交报告', at = '10000', id = null } = {}) {
  const message = [];
  if (at) message.push({ type: 'at', data: { qq: at } });
  message.push({ type: 'text', data: { text } });
  nextMessageID += 1;
  return {
    post_type: 'message',
    message_type: 'group',
    self_id: 10000,
    group_id: groupId,
    user_id: userId,
    // 每帧一个不同的 id：协议端就是这么发的，而重复 id 会被适配器当成重发丢掉。
    message_id: id === null ? nextMessageID : id,
    raw_message: text,
    message,
    sender: { nickname: name, card: '' },
  };
}

function socket(frame) {
  adapter.send({ v: 1, type: 'event', name: 'ws.message', payload: { text: JSON.stringify(frame) } });
}

beforeEach(() => {
  wsFrames = [];
  llmCalls = [];
  llmReply = '收到，周五的报告别忘。';
  echoReplies = true;
  answered = { requests: new Set(), calls: new Map() };
  core = null;
  adapter = null;
});

afterEach(() => {
  adapter?.close();
  core?.close();
  vi.restoreAllMocks();
});

// --- the pair ----------------------------------------------------------------

describe('接入端 → 记忆核心 → 群里', () => {
  test('a message that @s the bot becomes one reply, and the memory stays in the core', async () => {
    bootDocs();
    await pump();

    socket(groupFrame());
    await pump();

    // 群里收到了一条 send_group_msg，正文是核心给的
    const sends = wsFrames.filter((f) => f && f.action === 'send_group_msg');
    expect(sends, '适配器没有把回答发回群里').toHaveLength(1);
    const segments = sends[0].params.message;
    expect(sends[0].params.group_id).toBe(1001);
    expect(segments.some((s) => s.type === 'reply')).toBe(true); // 默认引用提问那条
    expect(segments.filter((s) => s.type === 'text').map((s) => s.data.text).join('')).toBe(llmReply);

    // 核心给模型喂的是人设 + 这一句
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0].system).toContain('记性很好的搭子');
    expect(llmCalls[0].text).toBe('周五交报告');

    // 记忆在**核心**的私有存储里
    expect(core.storage.has('mem/role/onebot-group-1001/turns')).toBe(true);
    const turns = JSON.parse(core.storage.get('mem/role/onebot-group-1001/turns'));
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ role: 'user', text: '周五交报告', who: '阿岚' });

    // 而适配器什么都没记：它是薄的，记忆只有一份
    const adapterKeys = [...adapter.storage.keys()];
    expect(adapterKeys.some((key) => key.startsWith('mem/'))).toBe(false);
    expect(adapterKeys).toContain('state/status');
  });

  test('a message that does not address the bot gets nothing at all', async () => {
    bootDocs();
    await pump();

    socket(groupFrame({ at: '', text: '今天吃什么' }));
    await pump();

    expect(wsFrames).toHaveLength(0);
    expect(llmCalls).toHaveLength(0);
    const status = JSON.parse(adapter.storage.get('state/status') || '{}');
    expect(status.skipped).toBe(1);
  });

  test('the prefix route reaches the core without the prefix in the text', async () => {
    bootDocs();
    adapter.config.prefix = '#问';
    await pump();

    socket(groupFrame({ at: '', text: '#问 明天几点开会' }));
    await pump();

    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0].text).toBe('明天几点开会');
    expect(wsFrames.filter((f) => f.action === 'send_group_msg')).toHaveLength(1);
  });

  test('two groups are two memories, and neither sees the other', async () => {
    bootDocs();
    await pump();

    socket(groupFrame({ groupId: 1001, text: '我在准备报告' }));
    await pump();
    llmReply = '知道啦。';
    socket(groupFrame({ groupId: 2002, userId: 3003, name: '别人', text: '晚上吃啥' }));
    await pump();

    expect(core.storage.has('mem/role/onebot-group-1001/turns')).toBe(true);
    expect(core.storage.has('mem/role/onebot-group-2002/turns')).toBe(true);
    // 第二条的上下文里没有第一条的任何一行
    expect(llmCalls).toHaveLength(2);
    expect(llmCalls[1].history).toEqual([]);
    expect(JSON.stringify(llmCalls[1])).not.toContain('我在准备报告');
  });

  test('a resent message is answered once', async () => {
    bootDocs();
    await pump();

    const frame = groupFrame({ id: 777 });
    socket(frame);
    await pump();
    socket(frame);
    await pump();

    // 协议端重连之后会重发最近的消息：按 message_id 去重，否则同一句话被答两遍。
    expect(wsFrames.filter((f) => f.action === 'send_group_msg')).toHaveLength(1);
    expect(llmCalls).toHaveLength(1);
  });

  test('when the core is missing the adapter says so on its own page, and stays quiet in the group', async () => {
    bootDocs();
    await pump();
    core.close();
    core = null;

    socket(groupFrame());
    await pump();

    expect(wsFrames.filter((f) => f.action === 'send_group_msg')).toHaveLength(0);
    const status = JSON.parse(adapter.storage.get('state/status') || '{}');
    expect(status.failed).toBe(1);
    expect(status.lastError.message).toContain('未启用');
  });

  test('a protocol side that never echoes still gets its messages out', async () => {
    // 发送只等 `ws.send` 的回应。等 `echo` 会让不回 echo 的实现每说一句话卡 10 秒，然后把一件
    // 已经做成了的事记成失败——这条用例就是那个坏模式的栅栏。
    echoReplies = false;
    bootDocs();
    await pump();

    socket(groupFrame());
    await pump();

    expect(wsFrames.filter((f) => f.action === 'send_group_msg')).toHaveLength(1);
    const status = JSON.parse(adapter.storage.get('state/status') || '{}');
    expect(status.answered).toBe(1);
    expect(status.failed).toBe(0);
  });

  test('a broken OneBot frame is ignored without killing the loop', async () => {
    bootDocs();
    await pump();

    adapter.send({ v: 1, type: 'event', name: 'ws.message', payload: { text: '这不是 JSON' } });
    await pump();
    socket(groupFrame());
    await pump();

    // 坏帧之后仍然能正常工作：一条帧的解析失败不该让连接变成聋子。
    expect(wsFrames.filter((f) => f.action === 'send_group_msg')).toHaveLength(1);
  });
});
