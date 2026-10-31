#!/usr/bin/env node
// tools/local-file-bridge.mjs —— ast-coder 的本机文件桥
//
// 插件沙箱没有文件系统（手册 §10），宿主的能力表里也没有"读用户目录"。
// 所以"桌宠看懂本地代码"的最后一块拼图是这个**用户自己启动、自己指给插件**的桥：
// 它只应答三支请求（list / read / write），只肯碰启动参数里给出的根目录。
//
//   GET  /ping                     → ok
//   GET  /list?dir=…&depth=…&ignore=… → {files:[{path,bytes,mtime}]}   （路径必须在根内）
//   GET  /read?path=…              → {content, truncated}             （≤512KB，超出截断）
//   POST /write {path, content, overwrite} → {ok, bytes, existedBefore}
//
// 写入的两道闸：
//   1. 路径必须在启动根目录内（越界一律 403）；
//   2. 目标已存在且非空时，只有 body 带 overwrite:true 才写——插件只在写
//      生成测试（<同名>.test.js）时才给这个标志，普通内容不覆盖。
//
// 用法：
//   node tools/local-file-bridge.mjs [端口] [根目录]
//   node tools/local-file-bridge.mjs 23180 C:\Users\me\projects

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';

const PORT = Number(process.argv[2]) || 23180;
const ROOT = path.resolve(process.argv[3] || process.cwd());
const MAX_READ = 512 * 1024;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/ping') {
      return json(res, 200, { ok: true, root: ROOT });
    }

    if (req.method === 'GET' && url.pathname === '/list') {
      const dir = resolveInside(url.searchParams.get('dir') || ROOT);
      const depth = Math.min(12, Math.max(0, Number(url.searchParams.get('depth')) || 4));
      const ignore = new Set(String(url.searchParams.get('ignore') || 'node_modules').split(',').map((s) => s.trim()).filter(Boolean));
      const files = [];
      walk(dir, dir, depth, ignore, files);
      return json(res, 200, { files });
    }

    if (req.method === 'GET' && url.pathname === '/read') {
      const file = resolveInside(url.searchParams.get('path') || '');
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        return json(res, 404, { error: 'no such file' });
      }
      if (!stat.isFile()) return json(res, 404, { error: 'not a file' });
      const buf = fs.readFileSync(file);
      const truncated = buf.length > MAX_READ;
      return json(res, 200, { content: buf.subarray(0, MAX_READ).toString('utf8'), truncated });
    }

    if (req.method === 'POST' && url.pathname === '/write') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; if (body.length > 8 * 1024 * 1024) req.destroy(); });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}');
          const file = resolveInside(String(parsed.path || ''));
          const content = String(parsed.content ?? '');
          let existedBefore = false;
          try {
            existedBefore = fs.statSync(file).isFile() && fs.readFileSync(file, 'utf8').trim() !== '';
          } catch {
            existedBefore = false;
          }
          if (existedBefore && !parsed.overwrite) {
            return json(res, 200, { ok: false, existedBefore: true, bytes: 0, error: 'target exists and is non-empty; overwrite refused' });
          }
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, content, 'utf8');
          return json(res, 200, { ok: true, bytes: Buffer.byteLength(content, 'utf8'), existedBefore });
        } catch (err) {
          return json(res, 400, { error: String(err && err.message) });
        }
      });
      return;
    }

    json(res, 404, { error: 'no route' });
  } catch (err) {
    json(res, 403, { error: String(err && err.message) });
  }
});

/** 把请求路径限制在启动根目录内；越界抛错（→ 403）。 */
function resolveInside(requested) {
  const abs = path.resolve(String(requested || '').startsWith('/') || /^[A-Za-z]:[\\/]/.test(String(requested))
    ? requested
    : path.join(ROOT, String(requested || '')));
  const rel = path.relative(ROOT, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path escapes the bridge root: ${requested}`);
  }
  return abs;
}

function walk(dir, base, depth, ignore, out) {
  if (depth < 0) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (ignore.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, base, depth - 1, ignore, out);
    } else if (entry.isFile()) {
      let stat = null;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      out.push({ path: full, bytes: stat.size, mtime: stat.mtimeMs });
    }
  }
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

server.listen(PORT, () => {
  console.log(`本机文件桥已启动：http://127.0.0.1:${PORT}（根目录 ${ROOT}）`);
  console.log('把 127.0.0.1:' + PORT + ' 填进「代码感知与重构助手」的桥地址即可。');
});
