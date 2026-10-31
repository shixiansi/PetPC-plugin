#!/usr/bin/env node
// tools/mock-danmaku-server.mjs —— 直播间弹幕 Mock 桥
//
// 用途：给 plugin-live-danmaku 一个能连的"直播间"。它监听一条 WebSocket，
// 说 Mock 协议（见插件 lib/danmaku.js 的注释）：
//
//   客户端 → 服务器：{"op":1,"data":{"room":"…"}}  握手（带房间号）
//                    {"op":2}                       心跳（每 20 秒）
//   服务器 → 客户端：{"op":3,"data":{"online":N}}   在线人数（每 10 秒）
//                    {"op":5,"data":{"uid","name","text"}}  一条弹幕
//
// 用法：
//   node tools/mock-danmaku-server.mjs [端口] [每秒弹幕数]
//   node tools/mock-danmaku-server.mjs 23100 8      # 8 条/秒，接近真实直播间的节奏
//
// 依赖：零（只用 node:http 与手写的 WebSocket 帧编解码—— RFC 6455 服务端最小实现，
// 只够"收文本帧、发文本帧、回 ping"）。

import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.argv[2]) || 23100;
const RATE = Math.max(0, Number(process.argv[3]) || 5);

const NAMES = ['小明', '阿黄', '星星', '老王', '奶茶', '路过的', '果冻', '夜猫子'];
const LINES = [
  '666', '哈哈哈', '主播好强', '？', '打卡', '来了来了',
  '这个问题怎么解决？', '求助，怎么领奖励？', '点歌！来一首昨夜',
  '为什么这个技能这么贵？', '前排围观', '草', '23333',
  '主播今天玩什么？', '欢迎新来的朋友',
];

// --- RFC 6455 最小实现 ---------------------------------------------------------

function acceptKey(key) {
  return crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
}

/** 解一条客户端帧；返回 {opcode, payload, rest}。opcode 1=文本 8=关闭 9=ping。 */
function decodeFrame(buffer) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const masked = (second & 0x80) !== 0;
  let len = second & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buffer.length < 4) return null;
    len = buffer.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buffer.length < 10) return null;
    len = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + len) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + len));
  if (mask) {
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  }
  return { opcode: first & 0x0f, payload, rest: buffer.subarray(offset + len) };
}

function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// --- 服务器 ---------------------------------------------------------------------

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Mock 弹幕桥：请用 WebSocket 连接（ws://127.0.0.1:' + PORT + '）\n');
});

const sockets = new Set();
let online = 0;
let seq = 0;

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
    '\r\n',
  );
  sockets.add(socket);
  online += 1;
  say(socket, JSON.stringify({ op: 3, data: { online } }));

  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const frame = decodeFrame(buf);
      if (!frame) break;
      buf = frame.rest;
      if (frame.opcode === 8) {
        socket.end();
        return;
      }
      if (frame.opcode === 9) {
        socket.write(Buffer.from([0x8a, 0])); // pong
        continue;
      }
      if (frame.opcode === 1) {
        let hello = null;
        try {
          hello = JSON.parse(frame.payload.toString('utf8'));
        } catch {
          hello = null;
        }
        if (hello && hello.op === 1) {
          say(socket, JSON.stringify({ op: 3, data: { online } }));
        }
      }
    }
  });

  socket.on('close', () => {
    sockets.delete(socket);
    online = Math.max(0, online - 1);
  });
  socket.on('error', () => {
    sockets.delete(socket);
  });
});

function say(socket, text) {
  try {
    socket.write(encodeFrame(text));
  } catch {
    sockets.delete(socket);
  }
}

function broadcast(text) {
  for (const socket of [...sockets]) say(socket, text);
}

// 在线人数：每 10 秒推一次（有点波动，像真的）。
setInterval(() => {
  if (!sockets.size) return;
  online = Math.max(1, sockets.size + Math.floor(Math.sin(Date.now() / 60000) * 3));
  broadcast(JSON.stringify({ op: 3, data: { online } }));
}, 10000);

// 弹幕：按 RATE 条/秒的节奏发（带突发：每 20 秒有一波 5 条的刷屏）。
setInterval(() => {
  if (!sockets.size || RATE <= 0) return;
  const burst = Date.now() % 20000 < 2500 ? 5 : 1;
  for (let i = 0; i < Math.max(1, Math.round(RATE / 5)) * burst; i += 1) {
    seq += 1;
    const uid = `u${seq % 40}`;
    const name = NAMES[seq % NAMES.length];
    const line = LINES[(seq * 7) % LINES.length];
    broadcast(JSON.stringify({ op: 5, data: { uid, name, text: line } }));
  }
}, 1000);

server.listen(PORT, () => {
  console.log(`Mock 弹幕桥已启动：ws://127.0.0.1:${PORT}（节奏 ${RATE} 条/秒，含周期性刷屏）`);
});
