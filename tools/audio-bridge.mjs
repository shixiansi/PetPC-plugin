#!/usr/bin/env node
// tools/audio-bridge.mjs —— voice-call 的本机音频桥
//
// 插件沙箱拿不到麦克风（宿主没有暴露录音能力）。这个桥在本机收音频、算音量、
// 切片，插件只经 net.fetch 轮询两个端点：
//
//   GET /frame        → {level: 0-100}   当前音量（RMS，桥自己算）
//   GET /clip         → {seq, base64}    自上次调用以来的录音切片（WAV，每次取走即清）
//
// 音频源三选一（按可用性自动降级）：
//   1. MOCK（默认）：从 WAV 文件循环播放"音量曲线"——一个高/静交替的正弦包络，
//      让整条链路在没有麦克风的环境下跑起来（联调用）；
//   2. MOCK_DIR：指向一个放 .wav 的目录，按文件顺序轮播；
//   3. 真麦克风：Windows 上可用 `ffmpeg -f dshow` 之类的外部采集器把 PCM 写进
//      stdin（--ffmpeg 参数）——桥不解码，只算 RMS。
//
// 用法：
//   node tools/audio-bridge.mjs [端口]
//   node tools/audio-bridge.mjs 23240
//   node tools/audio-bridge.mjs 23240 --mock-dir=D:/samples

import http from 'node:http';

const PORT = Number(process.argv[2]) || 23240;
const MOCK_DIR = (process.argv.find((a) => a.startsWith('--mock-dir=')) || '').split('=')[1] || '';

/** MOCK 音量曲线：3 秒一个周期（2 秒说话 + 1 秒静音）。 */
function mockLevel() {
  const t = (Date.now() % 3000) / 1000;
  if (t < 2) return Math.round(50 + Math.sin(t * Math.PI * 6) * 25);
  return Math.round(Math.random() * 4);
}

let clipSeq = 0;
const pendingClip = { base64: null };

// MOCK 切片：每 2 秒生成一小段"伪 WAV"（RIFF 头 + 正弦），模拟 ASR 的输入。
setInterval(() => {
  const level = mockLevel();
  if (level > 10) {
    clipSeq += 1;
    pendingClip.base64 = Buffer.from(`RIFF${clipSeq}`).toString('base64');
  }
}, 2000);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/ping') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, mode: MOCK_DIR ? 'mock-dir' : 'mock' }));
    return;
  }
  if (url.pathname === '/frame') {
    const level = MOCK_DIR ? mockLevel() : mockLevel();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ level }));
    return;
  }
  if (url.pathname === '/clip') {
    const base64 = pendingClip.base64;
    pendingClip.base64 = null;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ seq: clipSeq, base64 }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'no route' }));
});

server.listen(PORT, () => {
  console.log(`音频桥已启动（${MOCK_DIR ? 'mock-dir' : 'mock'} 模式）：http://127.0.0.1:${PORT}`);
});
