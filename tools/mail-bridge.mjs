#!/usr/bin/env node
// tools/mail-bridge.mjs —— email-digest 的本机邮件桥
//
// 插件沙箱没有 IMAP；把"连邮箱"这件事也交给一个用户自己启动的桥。桥负责：
//   · 连 IMAP（node:net 手写最小 IMAP4rev1 客户端：LOGIN → EXAMINE → SEARCH UNSEEN
//     → FETCH … (BODY.PEEK[])，取完不标已读）；
//   · 把原始 RFC822 文本按 POST /unread 的形状递给插件。
//
// 协议（插件侧只调这两支）：
//   GET /unread?limit=N → {mails:["<RFC822 原文>", …]}   最新 N 封未读
//
// 凭据从环境变量读（MAIL_BRIDGE_USER / MAIL_BRIDGE_PASS / MAIL_BRIDGE_HOST /
// MAIL_BRIDGE_PORT / MAIL_BRIDGE_TLS 可以接住大多数场景；未配置时桥进入
// MOCK 模式：返回内置的样例邮件——没有邮箱也能把整条链路跑通）。
//
// 用法：
//   node tools/mail-bridge.mjs [端口]
//   MAIL_BRIDGE_HOST=imap.gmail.com MAIL_BRIDGE_USER=x@gmail.com \
//   MAIL_BRIDGE_PASS=app-password MAIL_BRIDGE_TLS=1 node tools/mail-bridge.mjs 23220

import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';

const PORT = Number(process.argv[2]) || 23220;
const HOST = process.env.MAIL_BRIDGE_HOST || '';
const USER = process.env.MAIL_BRIDGE_USER || '';
const PASS = process.env.MAIL_BRIDGE_PASS || '';
const USE_TLS = process.env.MAIL_BRIDGE_TLS === '1';
const IMAP_PORT = Number(process.env.MAIL_BRIDGE_PORT) || (USE_TLS ? 993 : 143);
const MOCK = !HOST;

// --- IMAP 最小客户端 -----------------------------------------------------------

/** 连上、登录、抓 limit 封未读的完整 RFC822。失败抛错（调用方给 502）。 */
async function fetchUnread(limit) {
  const socket = USE_TLS
    ? tls.connect({ host: HOST, port: IMAP_PORT, rejectUnauthorized: false })
    : net.connect({ host: HOST, port: IMAP_PORT });
  await waitTagged(socket, '*', 10000);
  await sendCommand(socket, `A1 LOGIN ${quote(USER)} ${quote(PASS)}`);
  await sendCommand(socket, 'A2 EXAMINE INBOX');
  const search = await sendCommand(socket, 'A3 SEARCH UNSEEN');
  const ids = (search.match(/\* SEARCH ([0-9 ]+)/) || [])[1]
    ? search.match(/\* SEARCH ([0-9 ]+)/)[1].trim().split(/\s+/)
    : [];
  const latest = ids.slice(-limit);
  const mails = [];
  for (const id of latest) {
    const fetched = await sendCommand(socket, `A4 FETCH ${id} (BODY.PEEK[])`, 30000);
    const raw = extractRfc822(fetched);
    if (raw) mails.push(raw);
  }
  await sendCommand(socket, 'A5 LOGOUT').catch(() => {});
  socket.destroy();
  return mails;
}

function quote(s) {
  return `"${String(s).replace(/([\\"])/g, '\\$1')}"`;
}

function waitTagged(socket, prefix, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.startsWith(prefix)) {
        socket.removeListener('data', onData);
        resolve(buffer);
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
    setTimeout(() => {
      socket.removeListener('data', onData);
      reject(new Error('IMAP greeting timeout'));
    }, timeoutMs);
  });
}

/** 发一条命令并等到带 A{n} 前缀的行结束。 */
function sendCommand(socket, command, timeoutMs = 15000) {
  const tag = command.split(' ')[0];
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes(`\r\n${tag} `) || buffer.includes(`\n${tag} `) || buffer.trimEnd().endsWith(tag)) {
        socket.removeListener('data', onData);
        resolve(buffer);
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.write(`${command}\r\n`);
    setTimeout(() => {
      socket.removeListener('data', onData);
      reject(new Error(`IMAP timeout: ${tag}`));
    }, timeoutMs);
  });
}

/** 从 FETCH 响应里抠出 RFC822 文本（第一个 {n} 字面量之后）。 */
function extractRfc822(response) {
  const m = response.match(/\{(\d+)\}\r?\n/);
  if (!m) return '';
  const start = response.indexOf(m[0]) + m[0].length;
  return response.slice(start, start + Number(m[1]));
}

// --- MOCK 模式 -----------------------------------------------------------------

function mockMails() {
  const dir = process.env.MAIL_BRIDGE_MOCK_DIR || '';
  if (dir) {
    try {
      return fs.readdirSync(dir).filter((f) => f.endsWith('.eml')).slice(0, 20)
        .map((f) => fs.readFileSync(`${dir}/${f}`, 'utf8'));
    } catch {
      // 目录读不了就回落到内置样例。
    }
  }
  return [
    [
      'From: 老板 <boss@corp.example>',
      'To: me@corp.example',
      'Subject: 今天下午 3 点前给我报价',
      'Content-Type: text/plain; charset=utf-8',
      '',
      '客户在等，务必今天下午三点之前把报价发我。',
    ].join('\r\n'),
    [
      'From: GitLab <git@corp.example>',
      'To: me@corp.example',
      'Subject: [GitLab] Pipeline #123 passed',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Your pipeline passed.',
    ].join('\r\n'),
    [
      'From: promo@shop.example',
      'To: me@corp.example',
      'Subject: 限时促销：全场五折优惠券',
      'Content-Type: text/plain; charset=utf-8',
      '',
      '最后一天！',
    ].join('\r\n'),
  ];
}

// --- HTTP -----------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/ping') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, mode: MOCK ? 'mock' : 'imap', host: HOST || '(mock)' }));
    return;
  }
  if (url.pathname === '/unread') {
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
    const done = (mails) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ mails: mails.slice(0, limit) }));
    };
    const fail = (err) => {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(err && err.message) }));
    };
    if (MOCK) {
      done(mockMails());
      return;
    }
    fetchUnread(limit).then(done).catch(fail);
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'no route' }));
});

server.listen(PORT, () => {
  if (MOCK) {
    console.log(`邮件桥已启动（MOCK 模式）：http://127.0.0.1:${PORT}——配置 MAIL_BRIDGE_HOST/USER/PASS 后重启即接真邮箱`);
  } else {
    console.log(`邮件桥已启动（IMAP ${HOST}:${IMAP_PORT}${USE_TLS ? ' TLS' : ''}）：http://127.0.0.1:${PORT}`);
  }
});
