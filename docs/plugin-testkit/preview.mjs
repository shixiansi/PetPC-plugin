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
//   node docs/plugin-testkit/preview.mjs <pluginDir> --shot after.png --click "#ask-ok"
//
// Exit codes: 0 = ok / nothing to check, 1 = overflow found, 2 = usage or environment problem.
// Debug: PETPC_PREVIEW_DUMP=<file> keeps the DOM the check read (message log + report).

import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, statSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
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
        if (url.pathname.startsWith('/testkit/')) {
          // preview.html imports the SAME fake host plugin-check.mjs uses (`fake-host.mjs`), so the
          // page needs it over http (a `file://` module script would be blocked by CORS anyway).
          const rel = decodeURIComponent(url.pathname.slice('/testkit/'.length));
          const full = resolve(join(here, rel));
          if (!full.startsWith(resolve(here))) {
            res.writeHead(403).end('outside the testkit');
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
function previewURL({ port, plugin, rect, slot, kind, granted, deny, state, click }) {
  const u = new URL(`http://127.0.0.1:${port}/`);
  u.searchParams.set('plugin', plugin);
  u.searchParams.set('rect', String(rect));
  u.searchParams.set('slot', slot);
  u.searchParams.set('kind', kind);
  if (granted) u.searchParams.set('granted', granted);
  if (deny) u.searchParams.set('deny', '1');
  if (click) u.searchParams.set('click', click);
  u.searchParams.set('state', state);
  return u.toString();
}

/**
 * Runs the browser once and resolves with {code, stdout, stderr}.
 *
 * WHY A TEMP FILE INSTEAD OF A PIPE. `--dump-dom` writes the whole document to stdout, which invites
 * `execFile(..., cb)`; that captures through a named pipe, and a confined (sandboxed) process is not
 * allowed to open one - the spawn dies with `EPERM` before Chromium even starts, and the error points
 * at the browser rather than at the harness. Handing the child a real file descriptor is the same
 * amount of code and works in both worlds.
 */
function runBrowser(browser, args) {
  const stamp = Math.random().toString(36).slice(2, 10);
  const outFile = join(tmpdir(), `petpc-preview-${stamp}.out`);
  const errFile = join(tmpdir(), `petpc-preview-${stamp}.err`);
  const outFd = openSync(outFile, 'w');
  const errFd = openSync(errFile, 'w');
  return new Promise((resolvePromise) => {
    const child = spawn(browser, args, { stdio: ['ignore', outFd, errFd], windowsHide: true });
    const timer = setTimeout(() => child.kill(), 60000);
    const done = (code, extra) => {
      clearTimeout(timer);
      try { closeSync(outFd); } catch { /* already closed */ }
      try { closeSync(errFd); } catch { /* already closed */ }
      resolvePromise({
        code,
        stdout: existsSync(outFile) ? readFileSync(outFile, 'utf8') : '',
        stderr: (extra ? extra + '\n' : '') + (existsSync(errFile) ? readFileSync(errFile, 'utf8') : ''),
      });
    };
    child.on('error', (err) => done(-1, String(err && err.message)));
    child.on('close', (code) => done(code ?? 0));
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
  // `PETPC_PREVIEW_DUMP=<file>` keeps the dumped DOM. It exists because "it said PASS, why?" is a
  // question a screenshot cannot answer: the dump carries the message log plus the report the page
  // computed, exactly as the check read them.
  if (process.env.PETPC_PREVIEW_DUMP) writeFileSync(process.env.PETPC_PREVIEW_DUMP, stdout);
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
  const opts = { dir: null, shot: null, check: false, open: false, port: 7801, rect: 0, rectGiven: false, slot: 'pomodoro', kind: 'surface', state: 'gate', granted: null, deny: false, size: null, click: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--shot') opts.shot = argv[++i];
    else if (a === '--check') opts.check = true;
    else if (a === '--open') opts.open = true;
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--rect') { opts.rect = Number(argv[++i]); opts.rectGiven = true; }
    else if (a === '--slot') opts.slot = argv[++i];
    else if (a === '--kind') opts.kind = argv[++i];
    else if (a === '--state') opts.state = argv[++i];
    else if (a === '--granted') opts.granted = argv[++i];
    else if (a === '--deny') opts.deny = true;
    else if (a === '--size') opts.size = argv[++i];
    else if (a === '--click') opts.click = argv[++i];
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
    console.error('用法：node preview.mjs <插件目录> [--open] [--check] [--shot out.png] [--state gate|running|idle] [--rect N] [--slot S] [--kind surface|panel] [--deny] [--click "#id"]');
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
  const browser = findBrowser();
  const url = (rectIndex) => previewURL({
    port, plugin: manifest.id, rect: rectIndex, slot: opts.slot, kind: opts.kind,
    granted: opts.granted, deny: opts.deny, state: opts.state, click: opts.click,
  });

  try {
    if (opts.check || opts.shot) {
      if (!browser) {
        // SKIP, never "pass": a check that did not run must not look like a check that passed.
        console.error('SKIP：没找到 Edge / Chrome。`--check` 与 `--shot` 需要一个已安装的 Chromium；');
        console.error('      服务器模式仍然可用：node preview.mjs <dir> --open（在你自己浏览器里看）。');
        process.exit(0);
      }
    }
    if (opts.shot) {
      // The screenshot is of the PAGE (card + side panel), so the window has to be wider than the
      // card. `--size` overrides; the default leaves room for the message column.
      const pageSize = opts.size ? size : { w: size.w + 460, h: Math.max(size.h + 120, 420) };
      const out = await shot(browser, url(opts.rect), opts.shot, pageSize);
      console.log(`已截图：${out}`);
    }
    if (opts.check) {
      if (rects.length === 0) {
        // A plugin with no `surface` has no declared rect to fit into (a `background` frame is
        // invisible, a `panel` fills the window it is given). Inventing 380x260 here would be a
        // number the plugin never agreed to - report SKIP, never a green check.
        console.error(`SKIP  ${manifest.id} 没有声明浮层面（surface）：排版检查只对声明的矩形有意义。`);
        console.error('      它的界面要么是常驻帧（看不见），要么铺满宿主给的窗口——没有"放不放得下"这回事。');
        process.exitCode = 0;
        return;
      }
      // No `--rect` means "every declared rect": a card that fits at 380x260 can still clip at the
      // 320x120 one, and checking only rect 0 was how a whole rect used to go unlooked-at.
      const targets = opts.rectGiven ? [opts.rect] : rects.map((_, i) => i);
      let bad = 0;
      for (const index of targets) {
        const rect = rects[index] || { w: 380, h: 260 };
        const problems = await check(browser, url(index));
        const label = `${manifest.id} rect ${index}（${Math.round(rect.w)}×${Math.round(rect.h)}，state=${opts.state}）`;
        if (problems.length === 0) {
          console.log(`PASS  ${label}：全部元素在卡片之内`);
        } else {
          bad += 1;
          console.log(`FAIL  ${label}：${problems.length} 处越界`);
          for (const p of problems) console.log('  ✗ ' + p);
        }
      }
      process.exitCode = bad === 0 ? 0 : 1;
    }
    if (!opts.check && !opts.shot) {
      console.log(`预览：${url(opts.rect)}`);
      console.log('（Ctrl+C 结束）');
      if (opts.open && browser) {
        spawn(browser, [url(opts.rect)], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      }
      return; // keep serving until the process is killed
    }
  } finally {
    if (opts.check || opts.shot) server.close();
  }
}

main().catch((err) => {
  console.error('preview 崩了：' + (err && err.message ? err.message : err));
  process.exit(2);
});

