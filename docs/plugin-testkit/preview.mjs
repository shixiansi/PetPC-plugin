#!/usr/bin/env node
// Plugin preview: serve a plugin's own document in a real browser, with a fake host, and answer
// "does it fit" - the question jsdom cannot answer.
//
// WHY NO NPM DEPENDENCY. The first design used Playwright, which wants a ~130 MB browser download
// before it can do anything; on this machine that download was slower than the bug hunt it was
// meant to serve. Every Windows box that can run this product already has a Chromium: Edge (the same
// engine the product's WebView2 uses) or Chrome. Both take `--headless=new --screenshot` and
// `--dump-dom` on the command line, which is all this tool needs:
//
//   --shot   a PNG a human (or an agent) can look at;
//   --check  the page's own overflow report, read out of the dumped DOM.
//
// So: zero dependencies, no install step, and the engine is the one the product actually ships.
//
//   node docs/plugin-testkit/preview.mjs <pluginDir>                      # serve, print the URL
//   node docs/plugin-testkit/preview.mjs <pluginDir> --open               # ... and open it
//   node docs/plugin-testkit/preview.mjs <pluginDir> --shot out.png --state gate
//   node docs/plugin-testkit/preview.mjs <pluginDir> --check --state gate --rect 0
//
// Exit codes: 0 = ok / nothing to check, 1 = overflow found, 2 = usage or environment problem.

import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// The browser: an installed Chromium, never a download.
// ---------------------------------------------------------------------------
const BROWSERS = [
  join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
  join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
  join(process.env.ProgramFiles || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
  join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function findBrowser() {
  for (const path of BROWSERS) {
    try {
      if (existsSync(path) && statSync(path).isFile()) return path;
    } catch { /* keep looking */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Static server: `/` is the preview page, `/plugin/*` is the plugin being previewed.
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
};

function startServer(pluginDir, port) {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      try {
        if (url.pathname === '/' || url.pathname === '/index.html') {
          res.writeHead(200, { 'content-type': MIME['.html'] });
          res.end(await readFile(join(here, 'preview.html')));
          return;
        }
        if (url.pathname.startsWith('/plugin/')) {
          // The plugin's own directory. No traversal: the path is joined and then checked to stay
          // inside pluginDir, because a preview tool that can read arbitrary files is a liability.
          const rel = decodeURIComponent(url.pathname.slice('/plugin/'.length));
          const full = resolve(join(pluginDir, rel));
          if (!full.startsWith(resolve(pluginDir))) {
            res.writeHead(403).end('outside the plugin');
            return;
          }
          const data = await readFile(full);
          res.writeHead(200, { 'content-type': MIME[extname(full).toLowerCase()] || 'application/octet-stream' });
          res.end(data);
          return;
        }
        res.writeHead(404).end('not found');
      } catch (err) {
        res.writeHead(404).end(String(err && err.message));
      }
    });
    server.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE') return startServer(pluginDir, port + 1).then(resolvePromise, rejectPromise);
      rejectPromise(err);
    });
    server.listen(port, '127.0.0.1', () => resolvePromise({ server, port }));
  });
}

// ---------------------------------------------------------------------------
// Driving the browser.
// ---------------------------------------------------------------------------
function previewURL({ port, plugin, rect, slot, kind, granted, deny, state }) {
  const u = new URL(`http://127.0.0.1:${port}/`);
  u.searchParams.set('plugin', plugin);
  u.searchParams.set('rect', String(rect));
  u.searchParams.set('slot', slot);
  u.searchParams.set('kind', kind);
  if (granted) u.searchParams.set('granted', granted);
  if (deny) u.searchParams.set('deny', '1');
  u.searchParams.set('state', state);
  return u.toString();
}

/** Runs the browser once and resolves with {stdout} - `--dump-dom` or a screenshot on disk. */
function runBrowser(browser, args) {
  return new Promise((resolvePromise) => {
    execFile(browser, args, { timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
      resolvePromise({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// A separate --user-data-dir per run: sharing the default profile with a running browser makes the
// screenshot silently reuse the existing instance and exit without writing anything.
function profileDir() {
  return join(tmpdir(), 'petpc-preview-' + Math.random().toString(36).slice(2, 10));
}

async function shot(browser, url, out, size) {
  await mkdir(dirname(resolve(out)), { recursive: true });
  const args = [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--user-data-dir=' + profileDir(),
    `--window-size=${size.w},${size.h}`,
    '--virtual-time-budget=6000',
    '--screenshot=' + resolve(out),
    url,
  ];
  const { stderr } = await runBrowser(browser, args);
  if (!existsSync(out)) {
    throw new Error('浏览器没有写出截图：\n' + stderr.split('\n').slice(0, 4).join('\n'));
  }
  return out;
}

async function check(browser, url) {
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run',
    '--user-data-dir=' + profileDir(),
    '--window-size=1200,800',
    '--virtual-time-budget=6000',
    '--dump-dom',
    url,
  ];
  const { stdout, stderr } = await runBrowser(browser, args);
  const m = /data-report="([^"]*)"/.exec(stdout);
  if (!m) {
    throw new Error('页面没有给出报告（是否加载失败？）：\n' + (stdout || stderr).slice(0, 400));
  }
  const decode = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
  return JSON.parse(decode(m[1]));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { dir: null, shot: null, check: false, open: false, port: 7801, rect: 0, slot: 'pomodoro', kind: 'surface', state: 'gate', granted: null, deny: false, size: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--shot') opts.shot = argv[++i];
    else if (a === '--check') opts.check = true;
    else if (a === '--open') opts.open = true;
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--rect') opts.rect = Number(argv[++i]);
    else if (a === '--slot') opts.slot = argv[++i];
    else if (a === '--kind') opts.kind = argv[++i];
    else if (a === '--state') opts.state = argv[++i];
    else if (a === '--granted') opts.granted = argv[++i];
    else if (a === '--deny') opts.deny = true;
    else if (a === '--size') opts.size = argv[++i];
    else if (a.startsWith('-')) throw new Error('未知参数 ' + a);
    else opts.dir = a;
  }
  if (!opts.dir) throw new Error('要一个插件目录：node preview.mjs <pluginDir> [--check|--shot out.png]');
  return opts;
}

function readManifest(dir) {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) throw new Error(`${dir} 里没有 manifest.json`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error('用法：node preview.mjs <插件目录> [--open] [--check] [--shot out.png] [--state gate|running|idle] [--rect N] [--slot S] [--kind surface|panel] [--deny]');
    process.exit(2);
  }
  const pluginDir = resolve(opts.dir);
  if (!existsSync(join(pluginDir, 'manifest.json'))) {
    console.error(`${pluginDir} 里没有 manifest.json`);
    process.exit(2);
  }
  const manifest = JSON.parse(await readFile(join(pluginDir, 'manifest.json'), 'utf8'));
  const rects = manifest.surface || [];
  const r = rects[opts.rect] || { w: 380, h: 260 };
  const size = opts.size
    ? { w: Number(opts.size.split('x')[0]), h: Number(opts.size.split('x')[1]) }
    : { w: Math.round(r.w), h: Math.round(r.h) };

  const { server, port } = await startServer(pluginDir, opts.port);
  const url = previewURL({ port, plugin: manifest.id, rect: opts.rect, slot: opts.slot, kind: opts.kind, granted: opts.granted, deny: opts.deny, state: opts.state });
  const browser = findBrowser();

  try {
    if (opts.check || opts.shot) {
      if (!browser) {
        console.error('SKIP：没找到 Edge / Chrome。`--check` 与 `--shot` 需要一个已安装的 Chromium；');
        console.error('      服务器模式仍然可用：node preview.mjs <dir> --open（在你自己浏览器里看）。');
        process.exit(0);
      }
    }
    if (opts.shot) {
      // The screenshot is of the PAGE (card + side panel), so the window has to be wider than the
      // card. `--size` overrides; the default leaves room for the message column.
      const pageSize = opts.size ? size : { w: size.w + 460, h: Math.max(size.h + 120, 420) };
      const out = await shot(browser, url, opts.shot, pageSize);
      console.log(`已截图：${out}`);
    }
    if (opts.check) {
      const problems = await check(browser, url);
      if (problems.length === 0) {
        console.log(`PASS  ${manifest.id} rect ${opts.rect}（${size.w}×${size.h}，state=${opts.state}）：全部元素在卡片之内`);
      } else {
        console.log(`FAIL  ${manifest.id} rect ${opts.rect}（${size.w}×${size.h}，state=${opts.state}）：${problems.length} 处越界`);
        for (const p of problems) console.log('  ✗ ' + p);
      }
    }
    if (!opts.check && !opts.shot) {
      console.log(`预览：${url}`);
      console.log('（Ctrl+C 结束）');
      if (opts.open && browser) {
        spawn(browser, [url], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      }
      return; // keep serving until the process is killed
    }
    process.exitCode = opts.check ? 0 : 0;
  } finally {
    if (opts.check || opts.shot) server.close();
  }
}

main().catch((err) => {
  console.error('preview 崩了：' + (err && err.message ? err.message : err));
  process.exit(2);
});
