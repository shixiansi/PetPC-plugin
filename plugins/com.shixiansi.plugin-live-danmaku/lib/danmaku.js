// lib/danmaku.js —— 弹幕流的接入层：net.ws 连接、协议归一、在线人数
//
// 所有网络都走宿主代持的那条连接（ws.open / ws.send / ws.state），入站文本帧以
// `ws.message {text}` 事件到达。这个文件只做三件事：
//
//   1. open：按配置的平台拼出地址与握手包，调 ws.open，订阅事件；
//   2. parse：把一帧文本归一成 {kind:'dm'|'stats', dm?, online?, ...}；
//      协议认不出来的帧返回 null——**绝不抛错**，一个坏帧不该弄断监听循环；
//   3. 心跳：Mock 桥要求客户端每 20 秒发一次 {"op":2}，这里按平台给出发送体。
//
// 两种平台的帧形状：
//
//   Mock（tools/mock-danmaku-server.mjs）：
//     {"op":3,"data":{"online":123}}                          服务器推送的在线人数
//     {"op":5,"data":{"uid","name","text"}}                   一条弹幕
//   B 站开放平台（互动玩法）：
//     {"type":"LIVE_OPEN_PLATFORM_DM","data":{"uid","uname","msg"}}
//     {"type":"LIVE_OPEN_PLATFORM_LIVE_ROOM_INFO","data":{"online_count":1}}

'use strict';

const DANMAKU_PROTOCOLS = {
  mock: {
    /** ws:// 前缀补全：用户填 "127.0.0.1:23100" 或 "ws://…" 都认。 */
    urlOf(cfgValue) {
      const raw = String(cfgValue || '').trim();
      if (!raw) return '';
      if (/^wss?:\/\//i.test(raw)) return raw;
      return `ws://${raw.replace(/^\/+/, '')}`;
    },
    hello(cfg) {
      const room = typeof cfg === 'object' && cfg !== null ? cfg.roomId : cfg;
      return JSON.stringify({ op: 1, data: { room: String(room || '0') } });
    },
    heartbeat() {
      return JSON.stringify({ op: 2 });
    },
    heartbeatEveryMs: 20000,
    parse(text) {
      const frame = parseJSON(text);
      if (!frame || typeof frame !== 'object') return null;
      if (frame.op === 3 && frame.data && Number.isFinite(Number(frame.data.online))) {
        return { kind: 'stats', online: Number(frame.data.online) };
      }
      if (frame.op === 5 && frame.data) {
        const d = frame.data;
        if (typeof d.text !== 'string' || !d.text.trim()) return null;
        return { kind: 'dm', dm: { uid: String(d.uid || ''), name: String(d.name || ''), text: d.text } };
      }
      return null;
    },
  },

  'bilibili-open': {
    urlOf() {
      // 开放平台互动玩法：项目侧地址。应用信息（app_id/身份码）在握手包里发。
      return 'wss://dealer-open.bilibili.com/sub';
    },
    hello(cfg) {
      return JSON.stringify({
        type: 'IDENTITY',
        data: { app_id: String(cfg.appId || ''), room_id: String(cfg.roomId || ''), identity_code: String(cfg.idCode || '') },
      });
    },
    heartbeat() {
      return JSON.stringify({ type: 'HEARTBEAT' });
    },
    heartbeatEveryMs: 20000,
    parse(text) {
      const frame = parseJSON(text);
      if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') return null;
      const d = frame.data && typeof frame.data === 'object' ? frame.data : {};
      if (frame.type === 'LIVE_OPEN_PLATFORM_DM') {
        const body = typeof d.msg === 'string' ? d.msg : '';
        if (!body.trim()) return null;
        return { kind: 'dm', dm: { uid: String(d.uid || d.open_id || ''), name: String(d.uname || ''), text: body } };
      }
      if (frame.type === 'LIVE_OPEN_PLATFORM_LIVE_ROOM_INFO' && Number.isFinite(Number(d.online_count))) {
        return { kind: 'stats', online: Number(d.online_count) };
      }
      return null;
    },
  },
};

/** 当前平台实现。配置了不认识的平台时回 mock（配置里没有第三种）。 */
function protocolFor(platform) {
  return DANMAKU_PROTOCOLS[platform] || DANMAKU_PROTOCOLS.mock;
}

function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// --- 连接状态 -----------------------------------------------------------------

const liveConn = {
  platform: 'mock',
  open: false,
  wanted: false,      // 用户要它连（区别于"连上了"）
  lastErrorAt: 0,
  lastError: '',
};

/**
 * 打开连接。返回 true = 已经发出 ws.open。
 *
 * 规则：一个插件只有一条 net.ws 连接——重复 open 是错误，所以先查 ws.state；
 * 已经是 open 时直接返回 true（幂等），不是重开。
 */
async function openDanmaku(cfgIn) {
  const platform = protocolFor(cfgIn.platform);
  const url = platform.urlOf(cfgIn.mockUrl || cfgIn.roomId);
  if (!url) {
    liveConn.lastError = '没有可用的弹幕桥地址';
    return false;
  }
  try {
    const stateOut = await request('ws.state', {});
    if (stateOut && stateOut.state === 'open') {
      liveConn.open = true;
      liveConn.platform = cfgIn.platform;
      return true;
    }
  } catch {
    // state 查不到不影响开连接：宿主会给出真正的失败原因。
  }
  try {
    await request('ws.open', { url });
    liveConn.platform = cfgIn.platform;
    liveConn.wanted = true;
    liveConn.open = true;
    liveConn.lastError = '';
    // 握手包（Mock 要房间号；B 站开放平台要 app_id/身份码）。
    await request('ws.send', { text: platform.hello({ appId: cfgIn.appId, roomId: cfgIn.roomId, idCode: cfgIn.idCode }) });
    return true;
  } catch (err) {
    liveConn.open = false;
    liveConn.lastError = text(err && err.message, 160);
    liveConn.lastErrorAt = now();
    return false;
  }
}

/** 主动关闭（用户按「停止监听」）。 */
async function closeDanmaku() {
  liveConn.wanted = false;
  liveConn.open = false;
  try {
    await request('ws.close', {});
  } catch {
    // 已经不在了也算成功。
  }
}

/**
 * 心跳那一拍：每 5 秒一次，协议要求（Mock 与 B 站都是"定期 ping，否则服务端断开"）。
 *
 * 这里**不再查 ws.state**。连接状态是宿主推的（`ws.state` 事件，手册 §7 与
 * app_plugin_ws.go 的 emit），这个插件在 app.js 的 onEvent 里已经把 liveConn.open 跟着更新了。
 * 2026-11-01 的真机日志里，每 5 秒一次的 `ws.state` 查询一小时 201 条 INFO——真正需要它的
 * 只有"事件丢了"那一种情况，所以对表被挪到 reconcileConnection()，60 秒一次。
 */
async function danmakuTick() {
  const platform = protocolFor(liveConn.platform);
  if (liveConn.open && liveConn.wanted) {
    try {
      await request('ws.send', { text: platform.heartbeat() });
    } catch {
      // 发送失败：宿主会发 ws.state 事件说明连接怎么了。
    }
  }
}

/**
 * 对一次表。60 秒兜底，主路径是 `ws.state` 事件。
 *
 * 什么时候真用得上：事件在极端情况下会丢（帧刚挂载、宿主重启），而"想连却没连上"必须能在
 * 工坊页上看见。
 */
async function reconcileConnection() {
  try {
    const stateOut = await request('ws.state', {});
    const isOpen = Boolean(stateOut && stateOut.state === 'open');
    if (liveConn.wanted && !isOpen && now() - liveConn.lastErrorAt > 30000) {
      // 宿主负责重连；这里只记录"想要但还没连上"，供 workshop 显示。
      liveConn.lastError = `连接状态：${(stateOut && stateOut.state) || '未知'}`;
    }
    liveConn.open = isOpen;
    return stateOut;
  } catch {
    return null;
  }
}

/**
 * 一帧入站文本 → 归一化结果或 null。
 *
 * 平台按 liveConn.platform 选（ws.message 事件本身不带平台信息）。
 */
function parseDanmakuFrame(textIn) {
  const platform = protocolFor(liveConn.platform);
  return platform.parse(textIn);
}
