// lib/gateway.js —— AccessToken 鉴权 + 官方 WebSocket 网关的生命周期
//
// 职责只有三件：拿 token、维持一条 wss 长连接、把 Dispatch 事件递给 inbound.js。
// 对"事件是什么、要不要回"没有任何意见——那是 inbound.js 的事。
//
// 为什么连接是宿主的（net.ws）而不是浏览器的 WebSocket：沙箱帧是 opaque origin，
// 浏览器的 new WebSocket() 无法自定义握手，而且页面在插件更新时会被拆掉。
// 宿主代持的连接自带 30 秒 ping 与断线重连；官方要求的 op1 应用层心跳由我们自己发。
//
// 官方协议速查（op => 行为）：
//   10 Hello           连上后第一条，d.heartbeat_interval 是心跳周期（毫秒）
//   2 Identify         鉴权：token="QQBot <AccessToken>"、intents 位集
//   0 Dispatch         业务事件（t=READY / GROUP_AT_MESSAGE_CREATE / …），s 是序号
//   1 Heartbeat        按周期发，d = 收到的最新 s（没有就 null）
//   11 Heartbeat ACK   心跳确认
//   7 Reconnect        服务端要求重连：重连后 Resume
//   9 Invalid Session  Identify/Resume 参数错：清会话重新 Identify
//   6 Resume           重连恢复：token+session_id+seq，平台补发漏掉的事件
//
// 关于 AppSecret 的诚实说明：官方换 token 的接口要求把 clientSecret 放进 JSON body，
// 而本平台的 net.fetch 的 credentials 只能把 secret 配置填进 Cookie 头——覆盖不到 body。
// 所以 AppSecret 用普通配置项存放（留在用户本机插件的私有目录里），本插件从不把它
// 写进日志或显示出来。这是平台边界，不是偷懒。
'use strict';

// --- intents -----------------------------------------------------------------

const INTENTS = {
  GROUP_AND_C2C_EVENT: 1 << 25,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
};

/** 配置里的预设 → intents 位集。 */
function intentsFor(preset) {
  switch (String(preset || 'group+c2c')) {
    case 'group':
    case 'c2c':
      return INTENTS.GROUP_AND_C2C_EVENT;
    case 'guild':
      return INTENTS.PUBLIC_GUILD_MESSAGES;
    case 'group+c2c':
    default:
      return INTENTS.GROUP_AND_C2C_EVENT | INTENTS.PUBLIC_GUILD_MESSAGES;
  }
}

// --- AccessToken -------------------------------------------------------------

let token = { value: '', expiresAt: 0 };

/** 官方正式环境域名；配置留空就是它（沙箱/私有化部署时用户自己填）。 */
function apiDomainOf() {
  const d = String(cfg.apiDomain || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return d || 'api.bot.qq.com';
}

/**
 * 换取 AccessToken（POST /app/getAppAccessToken）。
 * 失败时抛出带官方原文的错误——"获取失败"三个字修不了任何配置。
 */
async function fetchAccessToken() {
  const appId = String(cfg.appId || '').trim();
  const secret = String(cfg.appSecret || '').trim();
  if (!appId) throw new Error('还没有填 AppID');
  if (!secret) throw new Error('还没有填 AppSecret');
  const res = await request('net.fetch', {
    method: 'POST',
    url: `https://${apiDomainOf()}/app/getAppAccessToken`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret: secret }),
  });
  if (res.truncated) throw new Error('token 响应被截断，请重试');
  let data;
  try {
    data = JSON.parse(res.body || '{}');
  } catch {
    throw new Error('token 响应不是 JSON');
  }
  if (!data.access_token) {
    throw new Error(`获取 AccessToken 失败：${data.message || truncate(JSON.stringify(data), 200)}`);
  }
  const ttl = num(data.expires_in, 7200);
  token = { value: String(data.access_token), expiresAt: Date.now() + Math.max(120, ttl - 120) * 1000 };
  return token.value;
}

/** 带缓存的 token：过期前 2 分钟就换新，避免回复到一半失效。 */
async function accessToken() {
  if (token.value && Date.now() < token.expiresAt) return token.value;
  return fetchAccessToken();
}

function invalidateToken() {
  token = { value: '', expiresAt: 0 };
}

/** 带鉴权头的 REST 调用（sender.js 也走这里）。 */
async function qqApi(method, path, bodyObj) {
  const at = await accessToken();
  const res = await request('net.fetch', {
    method,
    url: `https://${apiDomainOf()}${path}`,
    headers: {
      authorization: `QQBot ${at}`,
      'content-type': 'application/json',
    },
    body: bodyObj === undefined ? undefined : JSON.stringify(bodyObj),
  });
  let data = null;
  try {
    data = res.body ? JSON.parse(res.body) : null;
  } catch {
    data = { raw: truncate(String(res.body || ''), 300) };
  }
  return { status: Number(res.status) || 0, data, truncated: Boolean(res.truncated) };
}

// --- 网关连接 ----------------------------------------------------------------

const gw = {
  desired: false,          // 用户想要它连（start 之后为 true）
  state: 'closed',         // closed | connecting | open | error
  heartbeatMs: 30000,
  heartbeatTimer: 0,
  watchdogTimer: 0,
  lastActivityAt: 0,       // 最近一次收到任何下行的时间（看门狗用）
  resumeSession: '',       // 断线时还能用来 Resume 的会话
  resumeSeq: null,
  attempts: 0,             // 重连梯子
  bot: null,               // READY 里的 d.user
};

const wsHandlers = { onDispatch: () => {}, onState: () => {} };

function onGatewayState(state, extra) {
  gw.state = state;
  try {
    wsHandlers.onState(state, extra);
  } catch {
    // 监听方（app.js）的渲染错误不该打断协议处理。
  }
}

/** 启动机器人：之后由事件与重连梯子接管。 */
function startGateway(handlers) {
  Object.assign(wsHandlers, handlers || {});
  gw.desired = true;
  gw.attempts = 0;
  void connect();
}

function stopGateway() {
  gw.desired = false;
  gw.resumeSession = '';
  gw.resumeSeq = null;
  stopHeartbeat();
  stopWatchdog();
  void request('ws.close', {}).catch(() => {});
  onGatewayState('closed', { reason: 'stopped' });
}

function stopHeartbeat() {
  if (gw.heartbeatTimer) {
    clearInterval(gw.heartbeatTimer);
    gw.heartbeatTimer = 0;
  }
}

async function connect() {
  if (!gw.desired) return;
  if (!String(cfg.appId || '').trim()) {
    onGatewayState('error', { reason: '还没有填 AppID（在插件设置里填开放平台的 AppID）' });
    return;
  }
  onGatewayState('connecting');
  let url = '';
  try {
    const res = await qqApi('GET', '/gateway');
    url = res.data && res.data.url;
    if (!url) throw new Error(`取网关地址失败：${res.status} ${truncate(JSON.stringify(res.data), 120)}`);
  } catch (err) {
    // 鉴权类失败换 token 再来也没用，梯子会放慢节奏。
    note(`网关地址获取失败：${err.message}`);
    onGatewayState('error', { reason: err.message });
    scheduleReconnect();
    return;
  }

  try {
    await request('ws.open', { url });
  } catch (err) {
    note(`网关连接失败：${err.message}`);
    onGatewayState('error', { reason: err.message });
    scheduleReconnect();
    return;
  }
  // 之后的状态与消息都从 event（ws.state / ws.message）进来，见 onSocketFrame / onSocketState。
  startWatchdog();
}

/**
 * 看门狗只管一件事：连接活着但**长时间收不到任何下行**（连 Heartbeat ACK 都没有）。
 * 它不能拿"没有新事件"当断线依据——安静的群一整天也不来一条 Dispatch，而 s 只随事件
 * 前进；把"没事件"当"断线"会每隔几分钟把好端端的连接拆一次。
 * 与心跳定时器分开两个字段：共用一个会在 startHeartbeat 里被 stopHeartbeat 清掉。
 */
function startWatchdog() {
  stopWatchdog();
  touchActivity();
  gw.watchdogTimer = setInterval(() => {
    if (!gw.desired) return;
    if (Date.now() - gw.lastActivityAt > gw.heartbeatMs * 3 + 5000) {
      note('三个心跳周期没有任何下行，主动重建连接');
      void reconnectNow();
    }
  }, gw.heartbeatMs);
}

function stopWatchdog() {
  if (gw.watchdogTimer) {
    clearInterval(gw.watchdogTimer);
    gw.watchdogTimer = 0;
  }
}

/** 任何下行（事件 / Heartbeat ACK / 状态帧）都摸一下；看门狗靠它区分"安静"与"死了"。 */
function touchActivity() {
  gw.lastActivityAt = Date.now();
}

async function reconnectNow() {
  stopHeartbeat();
  stopWatchdog();
  await request('ws.close', {}).catch(() => {});
  onGatewayState('closed', { reason: 'reconnecting' });
  await sleep(1000);
  if (gw.desired) void connect();
}

/** 指数退避的重连梯子：1s, 2s, 4s … 上限 5 分钟；Resume 成功就归零。 */
function scheduleReconnect() {
  if (!gw.desired) return;
  gw.attempts = Math.min(gw.attempts + 1, 9);
  const delay = Math.min(300000, 1000 * 2 ** (gw.attempts - 1));
  note(`${delay / 1000}s 后重连网关（第 ${gw.attempts} 次）`);
  setTimeout(() => {
    if (gw.desired) void connect();
  }, delay);
}

// --- 下行帧 ------------------------------------------------------------------

/** 宿主推来的 ws 消息（一条就是一个官方网关帧）。 */
function onSocketFrame(text) {
  touchActivity();
  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    note(`网关帧不是 JSON（${truncate(text, 80)}）`);
    return;
  }
  const op = Number(frame.op);
  if (frame.s !== undefined && frame.s !== null) gw.lastSeq = Number(frame.s);

  switch (op) {
    case 10: { // Hello
      gw.heartbeatMs = Math.max(5000, Number(frame.d && frame.d.heartbeat_interval) || 30000);
      if (gw.resumeSession && gw.resumeSeq !== null && token.value) {
        sendFrame(6, { token: `QQBot ${token.value}`, session_id: gw.resumeSession, seq: gw.resumeSeq });
      } else {
        void identify();
      }
      break;
    }
    case 0: // Dispatch
      handleDispatch(frame);
      break;
    case 11: // Heartbeat ACK
      break;
    case 7: // Reconnect：服务端要求；保留会话，重连后 Resume
      note('网关要求重连（op7）');
      void reconnectNow();
      break;
    case 9: // Invalid Session：会话作废，清掉重新 Identify
      gw.resumeSession = '';
      gw.resumeSeq = null;
      note('网关拒绝会话（op9），重新 Identify');
      setTimeout(() => {
        if (gw.desired) void identify();
      }, gw.heartbeatMs);
      break;
    default:
      break;
  }
}

async function identify() {
  try {
    await accessToken();
  } catch (err) {
    note(`鉴权失败：${err.message}`);
    invalidateToken();
    onGatewayState('error', { reason: err.message });
    scheduleReconnect();
    return;
  }
  sendFrame(2, {
    token: `QQBot ${token.value}`,
    intents: intentsFor(cfg.intentsPreset),
    shard: [0, 1],
    properties: { $os: 'windows', $browser: 'petpc-plugin', $device: 'petpc-plugin' },
  });
}

function sendFrame(op, d) {
  void request('ws.send', { text: JSON.stringify({ op, d }) }).catch(() => {});
}

/**
 * 心跳（op1）按 Hello 给的周期发，d = 收到的最新 s（没有就 null）。
 * 是否还活着由 startWatchdog 的 lastActivityAt 判断：任何下行（事件、Heartbeat ACK）
 * 都会摸一下时间戳——"没有新事件"不等于"死了"，安静的一天也不该被拆连接。
 */
function startHeartbeat() {
  stopHeartbeat();
  gw.heartbeatTimer = setInterval(() => {
    sendFrame(1, gw.lastSeq === null || gw.lastSeq === undefined ? null : gw.lastSeq);
  }, gw.heartbeatMs);
}

function handleDispatch(frame) {
  const type = String(frame.t || '');
  const d = frame.d || {};
  if (type === 'READY') {
    gw.resumeSession = String(d.session_id || '');
    gw.resumeSeq = gw.lastSeq;
    gw.bot = d.user || null;
    gw.attempts = 0;
    startHeartbeat();
    onGatewayState('open', { bot: gw.bot });
    void logEvent('READY', `${(d.user && (d.user.username || d.user.id)) || '机器人'} 上线`);
    void storageSet('bot/info', JSON.stringify({
      id: (d.user && d.user.id) || '',
      username: (d.user && d.user.username) || '',
      at: Date.now(),
    }));
    return;
  }
  if (type === 'RESUMED') {
    gw.attempts = 0;
    startHeartbeat();
    onGatewayState('open', { bot: gw.bot, resumed: true });
    void logEvent('RESUMED', '会话已恢复');
    return;
  }
  gw.resumeSeq = gw.lastSeq;
  // 业务事件交给 inbound.js；网关自己不认识事件名也不要紧——unknown 由它记录。
  try {
    wsHandlers.onDispatch(type, d, frame);
  } catch (err) {
    note(`处理事件 ${type} 出错：${err.message}`);
  }
}

// --- 宿主事件接线 ------------------------------------------------------------

/** ws.state 事件：open 是"握手完成，等 Hello"；closed/error 交给宿主重连或看门狗。 */
function onSocketState(payload) {
  const state = String((payload && payload.state) || '');
  if (state === 'open') {
    onGatewayState('connecting');
    return;
  }
  if (state === 'closed' || state === 'error') {
    stopHeartbeat();
    stopWatchdog();
    const reason = String((payload && payload.error) || state);
    if (gw.desired) onGatewayState('error', { reason });
    // 宿主自己会重连；连上后我们收到新的 Hello，用 resumeSession 走 Resume。
    // 如果宿主也连不上，下一次 connect() 会重新取 /gateway。
  }
}
