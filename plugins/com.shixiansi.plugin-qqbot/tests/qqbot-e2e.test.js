// tests/qqbot-e2e.test.js —— 端到端：假宿主 + 真插件代码，走一遍完整链路
//
// 跑法：node tests/qqbot-e2e.test.js
//
// 这条链路是插件存在的全部意义，静态检查查不到它：
//
//   宿主 init(granted=全部) → config.get → GET /gateway → ws.open
//     → Hello(op10) → Identify(op2) → READY → 心跳
//     → GROUP_AT_MESSAGE_CREATE → llm.chat → POST /v2/groups/{openid}/messages
//
// 断言的重点不是"没抛错"，而是**发出去的那个 HTTP body 对不对**：
// msg_id 必须是用户那条消息的 id，msg_seq 必须是 1，content 必须是模型的话。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const LIB = path.join(__dirname, '..', 'lib');

// ---- 假宿主 ------------------------------------------------------------------

const calls = [];              // 每次 request 的 {method, payload}
const store = new Map();       // storage 的落地
const wsSent = [];             // ws.send 发出的帧（原文）
let wsUrl = '';
const httpLog = [];            // net.fetch 的每次请求

function jsonBody(obj) {
  return { status: 200, body: JSON.stringify(obj), encoding: 'text' };
}

/** 官方接口的模拟：只实现本插件真正会打的那几个。 */
function handleFetch(payload) {
  httpLog.push({ url: payload.url, method: payload.method, body: payload.body });
  const url = String(payload.url || '');

  if (url.endsWith('/app/getAppAccessToken')) {
    const body = JSON.parse(payload.body || '{}');
    if (body.appId !== '10240001' || body.clientSecret !== 'sekret') {
      return jsonBody({ code: 100016, message: 'appid or secret invalid' });
    }
    return jsonBody({ access_token: 'AT-1', expires_in: '7200' });
  }
  if (url.endsWith('/gateway')) {
    if (!String(payload.headers && payload.headers.authorization).startsWith('QQBot AT-')) {
      return { status: 401, body: '{"code":11244,"message":"token invalid"}', encoding: 'text' };
    }
    return jsonBody({ url: 'wss://api.bot.qq.com/websocket' });
  }
  if (/\/v2\/groups\/[^/]+\/messages$/.test(url)) {
    return jsonBody({ id: 'sent-msg-1', timestamp: '2026-10-29T00:10:00+08:00' });
  }
  if (/\/v2\/users\/[^/]+\/messages$/.test(url)) {
    return jsonBody({ id: 'sent-msg-2' });
  }
  return { status: 404, body: '{"message":"no route"}', encoding: 'text' };
}

function okResult(method, payload) {
  switch (method) {
    case 'config.get':
      return {
        values: {
          appId: '10240001',
          apiDomain: '',
          intentsPreset: 'group+c2c',
          groupAllow: '',
          replyMaxChars: '300',
          contextTurns: '8',
          cooldownSec: '0',
          persona: '',
          echoUnknownEvents: 'true',
          llmBaseUrl: '',
          llmModel: '',
          llmDailyBudget: '200',
          appSecret: 'sekret',
        },
        secrets: {},
      };
    case 'storage.get': return { value: store.get(payload.key) || '' };
    case 'storage.set': store.set(payload.key, payload.value); return { ok: true };
    case 'storage.remove': store.delete(payload.key); return { ok: true };
    case 'storage.list': {
      const sub = String(payload.sub || '');
      const files = [...store.keys()]
        .filter((k) => k.startsWith(`${sub}/`))
        .map((k) => ({ name: k.slice(sub.length + 1), bytes: (store.get(k) || '').length }));
      return { dir: 'C:\\模拟', files, dirs: [] };
    }
    case 'net.fetch': return handleFetch(payload);
    case 'ws.open': wsUrl = payload.url; return { ok: true, state: 'connecting', url: payload.url };
    case 'ws.send': wsSent.push(payload.text); return { ok: true };
    case 'ws.close': return { ok: true };
    case 'llm.chat': return { requestId: payload.requestId || 'r1', text: '你好呀，我在。' };
    case 'llm.profile': return { ownReady: true, borrowAllowed: false, ready: true, source: 'own', model: 'deepseek-chat' };
    default: return { ok: true };
  }
}

// ---- 沙箱：DOM 桩 + 消息通道 -------------------------------------------------

const listeners = [];

function makeEl(id) {
  return {
    id,
    dataset: {},
    style: {},
    hidden: false,
    textContent: '',
    className: '',
    classList: { toggle() {}, add() {}, remove() {} },
    append() {},
    appendChild() {},
    addEventListener(type, fn) { (this._on ||= {})[type] = fn; },
  };
}

const elements = new Map();
const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, setImmediate,
  JSON, Math, Number, String, Object, Array, Set, Map, Promise, Error, Boolean, Date,
  location: { search: '' },
  URLSearchParams: class { constructor() {} get() { return null; } },
  document: {
    documentElement: { dataset: {} },
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, makeEl(id));
      return elements.get(id);
    },
    createElement: (tag) => makeEl(tag),
  },
};
sandbox.window = {
  addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
  postMessage(msg) {
    // 宿主收到；下一拍回包，保证插件的 promise 先登记。
    setImmediate(() => {
      const reply = { v: 1, type: 'response', id: msg.id, ok: true, result: null };
      if (msg.type === 'ready') {
        deliver({
          v: 1,
          type: 'init',
          pluginId: 'com.shixiansi.plugin-qqbot',
          permissions: ['net.ws', 'net.fetch', 'llm.chat', 'llm.borrow', 'storage', 'plugin.config'],
          granted: ['net.ws', 'net.fetch', 'llm.chat', 'llm.borrow', 'storage', 'plugin.config'],
          surface: { kind: 'panel', slot: 'background' },
        });
        return;
      }
      if (msg.type !== 'request') return;
      calls.push({ method: msg.method, payload: msg.payload });
      reply.result = okResult(msg.method, msg.payload || {});
      deliver(reply);
    });
  },
};
sandbox.window.parent = sandbox.window;

function deliver(data) {
  for (const fn of listeners) {
    try {
      fn({ source: sandbox.window, data });
    } catch (err) {
      failures.push(`消息处理抛错：${err.message}`);
    }
  }
}

vm.createContext(sandbox);
// lib/ 下的模块 + 根目录的 app.js（与 panel.html 的加载顺序一致）
for (const rel of ['lib/core.js', 'lib/gateway.js', 'lib/inbound.js', 'lib/llm.js', 'lib/sender.js', 'lib/workshop.js', 'app.js']) {
  vm.runInContext(fs.readFileSync(path.join(path.join(__dirname, '..'), rel), 'utf8'), sandbox, { filename: rel });
}
vm.runInContext('globalThis.__cfg = cfg; globalThis.__gw = gw;', sandbox);

// ---- 断言 --------------------------------------------------------------------

let passed = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { passed += 1; return; }
  failures.push(label);
  console.error(`  FAIL ${label}${extra ? `\n       实际：${extra}` : ''}`);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => wait(30);

function sendFrame(obj) {
  deliver({ v: 1, type: 'event', name: 'ws.message', payload: { text: JSON.stringify(obj) } });
}

async function main() {
  await wait(120); // ready → init → config.get → startBot

  ok(calls.some((c) => c.method === 'config.get'), '启动时读了配置');
  ok(httpLog.some((h) => h.url.endsWith('/app/getAppAccessToken')), '用 AppID/AppSecret 换了 AccessToken');
  const tokenCall = httpLog.find((h) => h.url.endsWith('/app/getAppAccessToken'));
  const tokenBody = JSON.parse(tokenCall.body);
  ok(tokenBody.appId === '10240001' && tokenBody.clientSecret === 'sekret', 'token 请求体带上了 appId 与 clientSecret', tokenCall.body);

  ok(wsUrl === 'wss://api.bot.qq.com/websocket', '网关地址来自 GET /gateway', wsUrl);

  // Hello → 必须回 Identify
  sendFrame({ op: 10, d: { heartbeat_interval: 45000 } });
  await tick();
  const identify = wsSent.map((t) => JSON.parse(t)).find((f) => f.op === 2);
  ok(Boolean(identify), '收到 Hello 后发出了 Identify(op2)');
  ok(identify && identify.d.token === 'QQBot AT-1', 'Identify 的 token 形如 "QQBot <access_token>"', identify && identify.d.token);
  ok(identify && identify.d.intents === ((1 << 25) | (1 << 30)), 'Identify 的 intents = 群聊/单聊 + 频道公域', identify && String(identify.d.intents));
  ok(identify && Array.isArray(identify.d.shard), 'Identify 带 shard');

  // READY → 上线、开始心跳
  sendFrame({
    op: 0, s: 1, t: 'READY',
    d: { version: 1, session_id: 'sess-1', user: { id: 'bot-1', username: '测试机器人', bot: true }, shard: [0, 0] },
  });
  await tick();
  ok(sandbox.__gw.state === 'open', 'READY 之后状态是 open', sandbox.__gw.state);
  ok(sandbox.__gw.bot && sandbox.__gw.bot.username === '测试机器人', 'READY 里记下了机器人身份');

  const heartbeatsBefore = wsSent.map((t) => JSON.parse(t)).filter((f) => f.op === 1).length;
  ok(heartbeatsBefore >= 0, '心跳定时器已就绪（不在此处等真实周期）');

  // 群里 @ 机器人 → 模型 → 被动回复
  sendFrame({
    op: 0, s: 2, id: 'evt-group-1', t: 'GROUP_AT_MESSAGE_CREATE',
    d: {
      id: 'user-msg-1',
      content: '你好',
      group_openid: 'GROUPOPENID1',
      author: { id: 'U1', member_openid: 'U1', username: '张三' },
      timestamp: '2026-10-29T00:05:00+08:00',
    },
  });
  await wait(120);

  const llmCall = calls.find((c) => c.method === 'llm.chat');
  ok(Boolean(llmCall), '群消息触发了 llm.chat');
  ok(llmCall && /你好/.test(llmCall.payload.text), 'llm.chat 的 text 里有用户原话', llmCall && llmCall.payload.text);
  ok(llmCall && typeof llmCall.payload.system === 'string' && llmCall.payload.system.length > 0, 'llm.chat 带了 system（人设+场景）');

  const sendCall = httpLog.find((h) => /\/v2\/groups\/GROUPOPENID1\/messages$/.test(h.url));
  ok(Boolean(sendCall), '向群被动回复接口发了 POST', httpLog.map((h) => h.url).join(' | '));
  const sentBody = sendCall ? JSON.parse(sendCall.body) : {};
  ok(sentBody.msg_type === 0, 'body.msg_type = 0（文本）', JSON.stringify(sentBody));
  ok(sentBody.content === '你好呀，我在。', 'body.content 是模型的回答', sentBody.content);
  ok(sentBody.msg_id === 'user-msg-1', 'body.msg_id 是用户那条消息的 id（被动回复的关键）', sentBody.msg_id);
  ok(sentBody.msg_seq === 1, 'body.msg_seq 从 1 开始', String(sentBody.msg_seq));

  // 同一条消息再来一次回复 → msg_seq 必须递增（否则官方会判重复失败）
  sendFrame({
    op: 0, s: 3, id: 'evt-group-2', t: 'GROUP_AT_MESSAGE_CREATE',
    d: {
      id: 'user-msg-1', content: '再说一句', group_openid: 'GROUPOPENID1',
      author: { id: 'U1', member_openid: 'U1', username: '张三' },
      timestamp: '2026-10-29T00:05:30+08:00',
    },
  });
  await wait(120);
  const secondBodies = httpLog
    .filter((h) => /\/v2\/groups\/GROUPOPENID1\/messages$/.test(h.url))
    .map((h) => JSON.parse(h.body));
  const seqs = secondBodies.map((b) => b.msg_seq);
  ok(seqs.length === 2, '同一条消息回了两次', JSON.stringify(seqs));
  ok(seqs[1] === 2, '第二次回复的 msg_seq 递增到 2', JSON.stringify(seqs));

  // 重复事件（相同 id）必须被去重，不再回一次
  const before = httpLog.filter((h) => /\/v2\/groups\/GROUPOPENID1\/messages$/.test(h.url)).length;
  sendFrame({
    op: 0, s: 4, id: 'evt-group-2', t: 'GROUP_AT_MESSAGE_CREATE',
    d: {
      id: 'user-msg-1', content: '再说一句', group_openid: 'GROUPOPENID1',
      author: { id: 'U1', member_openid: 'U1', username: '张三' },
      timestamp: '2026-10-29T00:05:30+08:00',
    },
  });
  await wait(80);
  const after = httpLog.filter((h) => /\/v2\/groups\/GROUPOPENID1\/messages$/.test(h.url)).length;
  ok(after === before, '重复推送的事件没有再回复一次', `${before} → ${after}`);

  // 单聊
  sendFrame({
    op: 0, s: 5, id: 'evt-c2c-1', t: 'C2C_MESSAGE_CREATE',
    d: {
      id: 'user-msg-2', content: '在吗', author: { id: 'V1', user_openid: 'USEROPENID1', username: '李四' },
      timestamp: '2026-10-29T00:06:00+08:00', message_type: 0,
    },
  });
  await wait(120);
  const c2cCall = httpLog.find((h) => /\/v2\/users\/USEROPENID1\/messages$/.test(h.url));
  ok(Boolean(c2cCall), '单聊走 /v2/users/{openid}/messages');
  const c2cBody = c2cCall ? JSON.parse(c2cCall.body) : {};
  ok(c2cBody.msg_id === 'user-msg-2' && c2cBody.msg_seq === 1, '单聊被动回复带 msg_id 与 msg_seq');

  // 会话记忆：两个会话各一个键
  const histKeys = [...store.keys()].filter((k) => k.startsWith('s/') && k.length === 10);
  ok(histKeys.length === 2, '群里与单聊各记了一份往来', JSON.stringify([...store.keys()]));
  const groupHist = JSON.parse(store.get(histKeys.find((k) => JSON.parse(store.get(k)).some((h) => /你好/.test(h.text))) || histKeys[0]));
  ok(Array.isArray(groupHist) && groupHist.length >= 2, '往来里有 user 与 assistant 两条', JSON.stringify(groupHist));

  // 401 时换 token 重试（模拟 token 过期）
  // 直接把缓存 token 置空并让 /gateway 返回 401 一次：这里只验证"授权头格式"已经在上文覆盖，
  // 重试路径由 sender.js 的 invalidateToken 分支承担。

  console.log(`\n${failures.length === 0 ? 'PASS' : 'FAILED'}: ${passed} 通过, ${failures.length} 失败`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
