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
//   node docs/plugin-testkit/preview.mjs <pluginDir> --shot light.png --theme light
//
// Exit codes: 0 = ok / nothing to check, 1 = overflow found, 2 = usage or environment problem.
// Debug: PETPC_PREVIEW_DUMP=<file> keeps the DOM the check read (message log + report).

import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync, statSync, openSync, closeSync, writeFileSync } from 'node:fs';
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

function startServer(pluginDir, port, galleryBox = null) {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      try {
        if (url.pathname === '/gallery') {
          // 画廊页：本来只有"一个插件一个 server"，所以画廊由**同一个** server 在 /gallery 上发，
          // 里面的 iframe 各自指向对应插件的那个端口。galleryBox 是可变对象，因为页面内容要等
          // 所有 server 都起来（端口确定）之后才能拼出来。
          if (!galleryBox || !galleryBox.html) {
            res.writeHead(404).end('gallery not ready');
            return;
          }
          res.writeHead(200, { 'content-type': MIME['.html'] });
          res.end(galleryBox.html);
          return;
        }
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
      if (err && err.code === 'EADDRINUSE') return startServer(pluginDir, port + 1, galleryBox).then(resolvePromise, rejectPromise);
      rejectPromise(err);
    });
    server.listen(port, '127.0.0.1', () => resolvePromise({ server, port }));
  });
}

// ---------------------------------------------------------------------------
// Driving the browser.
// ---------------------------------------------------------------------------
function previewURL({ port, plugin, rect, slot, kind, granted, deny, state, theme, click, frame, bare, nogrow }) {
  const u = new URL(`http://127.0.0.1:${port}/`);
  u.searchParams.set('plugin', plugin);
  u.searchParams.set('rect', String(rect));
  u.searchParams.set('slot', slot);
  u.searchParams.set('kind', kind);
  if (granted) u.searchParams.set('granted', granted);
  if (deny) u.searchParams.set('deny', '1');
  // Do NOT follow surface.blocks growth requests: measures "does the DECLARED size hold it".
  if (nogrow) u.searchParams.set('nogrow', '1');
  if (theme) u.searchParams.set('theme', theme);
  if (click) u.searchParams.set('click', click);
  // 显式的框（--frame）与裸模式（--bare）：一个没有 surface 的插件需要真实的框才看得出布局。
  if (frame) {
    u.searchParams.set('w', String(frame.w));
    u.searchParams.set('h', String(frame.h));
  }
  if (bare) u.searchParams.set('bare', '1');
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

async function shot(browser, url, out, size, budgetMs = 6000) {
  await mkdir(dirname(resolve(out)), { recursive: true });
  const args = [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--user-data-dir=' + profileDir(),
    `--window-size=${size.w},${size.h}`,
    // 虚拟时间预算：Chrome 会等页面"安静"到这么久为止。画廊一屏要拉 15 个插件的资源（每个插件
    // 一个端口），6000 不够——会拍到一半的帧，画面里就是几个空框、"等待宿主初始化"。单插件沿用
    // 6s，画廊传更长。
    `--virtual-time-budget=${budgetMs}`,
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
// 画廊：一次看到所有插件的观感
// ---------------------------------------------------------------------------
//
// 为什么需要它：判断"风格统不统一"要同时看很多个插件，而单插件模式一次只画一个——于是要么不判断，
// 要么靠回忆判断。2026-10-30 的教训是三个插件的包里根本没带 ui.css，谁也没发现，因为**没有任何
// 一个画面同时展示了"有人有 kit、有人没有"**。一张接触表就让这种差异无法被忽略。
//
// 它不另写渲染管线：每个插件仍然起一个自己的 server（`/plugin/…` 映射到那个目录），页面里用
// `?bare=1` 的 iframe 一格一格引用它们。所以看到的和单插件模式**是同一套渲染**（同一份假宿主、
// 同一套状态机），不是"另画一份预览"。

/** 每个带 manifest.json 的子目录，按 id 排序。 */
function discoverPlugins(root) {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    if (!existsSync(join(dir, 'manifest.json'))) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    } catch {
      continue; // 坏清单不该挡住整张表；单插件模式会为它报错
    }
    out.push({ dir, manifest });
  }
  return out.sort((a, b) => String(a.manifest.id).localeCompare(String(b.manifest.id)));
}

/**
 * 一个插件画几格。
 *
 * 声明了浮层面的：一块矩形一格，**按声明的尺寸**——那才是宿主真正裁出来的框。
 * 没声明的：一格"工坊页"，尺寸取 `--frame`（默认 420×340）。那不是它真实的窗口尺寸（宿主给多少
 * 就是多少），所以格里溢出只当观感参考，不算错。
 */
function cellsFor(manifest, opts) {
  const rects = Array.isArray(manifest.surface) ? manifest.surface : [];
  if (rects.length === 0) {
    const frame = opts.frame || { w: 420, h: 340 };
    return [{ kind: 'panel', slot: 'workshop', rect: 0, w: frame.w, h: frame.h, label: '工坊页' }];
  }
  return rects.map((r, i) => ({
    kind: 'surface',
    slot: opts.slot || 'pomodoro',
    rect: i,
    w: Math.round(Number(r.w) || 380),
    h: Math.round(Number(r.h) || 260),
    label: `rect ${i}`,
  }));
}

/** 拼出接触表。纯字符串——没有图片库，排版交给浏览器。 */
function galleryPage(cards, theme, cols) {
  const dark = theme !== 'light';
  // 统一列宽：格子宽度不一（308×64 挨着 380×260）时，flex 换行会让行参差不齐，
  // 读的人会把标题配错格子——这正是第一版我把 voice 看成浅色的原因。
  const colW = Math.max(320, ...cards.map((c) => c.w)) + 2;
  const cells = cards.map((c) => `
    <figure>
      <div class="box" style="width:${c.w}px;height:${c.h}px">
        <iframe loading="eager" title="${c.id} ${c.label}"
          src="http://127.0.0.1:${c.port}/?bare=1&plugin=${encodeURIComponent(c.id)}&rect=${c.rect}&kind=${c.kind}&slot=${encodeURIComponent(c.slot)}&theme=${theme}&state=${encodeURIComponent(c.state)}"></iframe>
      </div>
      <figcaption>
        <b>${c.short}</b> <code>v${c.version}</code>
        <span class="dim">· ${c.label} ${c.w}×${c.h}</span><br>
        <span class="dim">${c.styleNote}${c.surface ? ' · 有浮层面（按矩形裁剪）' : ''}</span>
      </figcaption>
    </figure>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>插件画廊 · ${theme}</title>
<style>
  :root { color-scheme: ${dark ? 'dark' : 'light'}; }
  body { margin: 0; padding: 24px; background: ${dark ? '#080b12' : '#e9edf4'};
         color: ${dark ? '#e6ebf5' : '#1c2430'};
         font: 13px/1.6 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
  h1 { margin: 0 0 4px; font-size: 16px; font-weight: 600; }
  p.note { margin: 0 0 20px; opacity: .66; font-size: 12px; }
  .grid { display: flex; flex-wrap: wrap; gap: 26px; align-items: flex-start; }
  figure { margin: 0; width: ${colW}px; }
  .box { outline: 1px dashed ${dark ? 'rgba(255,255,255,.22)' : 'rgba(0,0,0,.22)'}; overflow: hidden; }
  .box iframe { display: block; width: 100%; height: 100%; border: 0; background: transparent; }
  figcaption { margin-top: 8px; max-width: 420px; }
  figcaption b { font-weight: 600; }
  code { font: 12px ui-monospace, Consolas, monospace; opacity: .8; }
  .dim { opacity: .6; font-size: 12px; }
</style></head><body>
<h1>插件画廊 · ${theme} · ${cards.length} 格 / ${new Set(cards.map((c) => c.id)).size} 个插件</h1>
<p class="note">虚线框 = manifest 声明的矩形（宿主就是按它裁窗口的）。浮层面按真实尺寸画；工坊页给一个固定框，溢出只作参考——那由宿主窗口决定。</p>
<div class="grid"${cols ? ` style="max-width:${cols * 470}px"` : ''}>${cells}</div>
</body></html>`;
}

async function runGallery(opts) {
  const root = resolve(opts.gallery);
  const plugins = discoverPlugins(root);
  if (plugins.length === 0) {
    console.error(`${root} 下没有任何带 manifest.json 的插件目录`);
    process.exit(2);
  }
  const box = { html: '' };
  const servers = [];
  const cards = [];
  let port = opts.port;
  for (const p of plugins) {
    const started = await startServer(p.dir, port, box);
    servers.push(started.server);
    port = started.port + 1; // 一个插件一个端口：各自的 /plugin/… 才成立
    const styleNote = existsSync(join(p.dir, 'ui.css')) ? 'kit · 带 ui.css' : '自带调色板';
    for (const cell of cellsFor(p.manifest, opts)) {
      cards.push({
        ...cell,
        port: started.port,
        id: p.manifest.id,
        short: String(p.manifest.id).replace(/^com\.[^.]+\.plugin-/, ''),
        version: p.manifest.version,
        surface: (p.manifest.surface || []).length > 0,
        styleNote,
        state: opts.state,
      });
    }
  }
  const theme = opts.theme === 'light' ? 'light' : 'dark';
  box.html = galleryPage(cards, theme, opts.cols);
  const first = `http://127.0.0.1:${cards[0].port}/gallery`;

  // 文字版一览：谁用 kit、谁自带调色板、谁有浮层面。截图能看出来的，终端里也要说得清。
  for (const p of plugins) {
    const note = existsSync(join(p.dir, 'ui.css')) ? 'kit' : '自带调色板';
    const surf = (p.manifest.surface || []).length;
    console.log(`  ${String(p.manifest.id).replace(/^com\.[^.]+\.plugin-/, '').padEnd(14)} v${String(p.manifest.version).padEnd(9)} ${note.padEnd(12)} ${surf ? `surface ×${surf}` : '无浮层面'}`);
  }

  if (opts.shot) {
    const browser = findBrowser();
    if (!browser) {
      console.error('SKIP：没找到 Edge / Chrome，没法截图。');
      console.error(`      画廊页仍然可以自己看：${first}`);
      process.exitCode = 0;
      return;
    }
    const cols = opts.cols || 3;
    const cellW = Math.max(...cards.map((c) => c.w)) + 26;
    const cellH = Math.max(...cards.map((c) => c.h)) + 76;
    const rows = Math.ceil(cards.length / cols);
    const pageSize = opts.size || { w: cols * cellW + 48, h: rows * cellH + 96 };
    const out = await shot(browser, first, opts.shot, pageSize, 20000);
    console.log(`已截图：${out}（${cards.length} 格，窗口 ${pageSize.w}×${pageSize.h}）`);
    for (const s of servers) s.close();
    return;
  }

  console.log(`\n画廊：${first}`);
  console.log(`（${cards.length} 格 / ${plugins.length} 个插件，Ctrl+C 结束）`);
  if (opts.open) {
    const browser = findBrowser();
    if (browser) spawn(browser, [first], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    else console.error('没找到 Edge / Chrome，请自己打开上面的地址。');
  }
  return; // 服务器留着，直到进程被结束
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { dir: null, gallery: null, cols: null, shot: null, check: false, open: false, port: 7801, rect: 0, rectGiven: false, slot: 'pomodoro', kind: 'surface', state: 'gate', granted: null, deny: false, size: null, click: null, frame: null, bare: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--shot') opts.shot = argv[++i];
    else if (a === '--check') opts.check = true;
    else if (a === '--open') opts.open = true;
    // --gallery <pluginsRoot>：把这个目录下**所有**插件铺成一张接触表（一次看到全部观感）。
    else if (a === '--gallery') opts.gallery = argv[++i];
    else if (a === '--cols') opts.cols = Number(argv[++i]);
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--rect') { opts.rect = Number(argv[++i]); opts.rectGiven = true; }
    else if (a === '--slot') opts.slot = argv[++i];
    else if (a === '--kind') opts.kind = argv[++i];
    else if (a === '--state') opts.state = argv[++i];
    // --theme light|dark：预览用的配色。默认深色（历史行为），浅色用来量对比度和描边。
    else if (a === '--theme') opts.theme = argv[++i];
    else if (a === '--granted') opts.granted = argv[++i];
    else if (a === '--deny') opts.deny = true;
    else if (a === '--size') opts.size = argv[++i];
    else if (a === '--frame') {
      const [w, h] = String(argv[++i]).split('x').map(Number);
      if (!w || !h) throw new Error('--frame 要写成 WxH，例如 --frame 900x760');
      opts.frame = { w, h };
    }
    else if (a === '--bare') opts.bare = true;
    else if (a === '--click') opts.click = argv[++i];
    else if (a.startsWith('-')) throw new Error('未知参数 ' + a);
    else opts.dir = a;
  }
  if (!opts.dir && !opts.gallery) throw new Error('要一个插件目录（或 --gallery <pluginsRoot>）：node preview.mjs <pluginDir> [--check|--shot out.png]');
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
    console.error('用法：node preview.mjs <插件目录> [--open] [--check] [--shot out.png] [--state gate|running|idle] [--rect N] [--slot S] [--kind surface|panel] [--deny] [--click "#id"] [--frame WxH] [--bare]');
    console.error('      node preview.mjs --gallery <pluginsRoot> [--shot out.png] [--open] [--theme light|dark] [--cols N] [--frame WxH]');
    process.exit(2);
  }
  // 画廊模式：一次看到全部插件的观感（一张接触表，或者一个可交互的页面）。
  if (opts.gallery) {
    await runGallery(opts);
    return;
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
    granted: opts.granted, deny: opts.deny, state: opts.state, theme: opts.theme, click: opts.click,
    frame: opts.frame, bare: opts.bare,
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
      // --bare 截的就是插件页面本身：窗口尺寸 = 框的尺寸（+1px 防亚像素滚动条）。
      const box = opts.frame ? { w: opts.frame.w, h: opts.frame.h } : size;
      const pageSize = opts.bare
        ? { w: box.w + 1, h: box.h + 1 }
        : opts.size
          ? size
          : { w: box.w + 460, h: Math.max(box.h + 120, 420) };
      const out = await shot(browser, url(opts.rect), opts.shot, pageSize);
      console.log(`已截图：${out}`);
    }
    if (opts.check) {
      if (rects.length === 0) {
        // A plugin with no `surface` has no DECLARED rect, and that is the only thing `--check` can
        // judge: a surface block is cropped by the native window region, so "taller than the box"
        // really is "clipped". A panel page is NOT - an iframe scrolls by default, so a page that is
        // taller than the window is simply scrollable, and calling that a failure would be a false
        // alarm on every settings page in the market.
        //
        // 2026-10-30 tried the opposite (let an explicit `--frame` drive the check) and got exactly
        // that: 10 of 11 panel plugins "FAILED" with scrollHeight 600–1900, while the plugins whose
        // workspace sets `overflow: auto` were fine all along. Fitting a scrolling page into a
        // window is not a property to check - it is what scrolling is for.
        console.error(`SKIP  ${manifest.id} 没有声明浮层面（surface）：排版断言只对"被裁出来的矩形"有意义。`);
        console.error('      工坊页是可滚动的（iframe 默认就能滚），"比窗口高"不是缺陷——所以这里不判定。');
        console.error('      要看它长什么样：--shot page.png --slot workshop --kind panel --frame 720x560 --bare');
        process.exitCode = 0;
        return;
      }
      // No `--rect` means "every declared rect": a card that fits at 380x260 can still clip at the
      // 320x120 one, and checking only rect 0 was how a whole rect used to go unlooked-at.
      // 窗口的天花板：块**向上长**，所以一块能长多高取决于它的下边缘离窗口上沿有多远。
      //
      // 宿主那边宠物是垂直居中的（`petY = (totalH - petH)/2`），`totalH = max(520, petH)`，
      // 默认宠物 150x200、缩放 1 → petY = 160。于是 `dy=-148, h=44` 的块下边缘在 56，
      // **再往上只有 56px**，而它声明了 `maxH: 180`——那条上限永远兑现不了，宿主只会夹回去并留一条
      // WARN，界面上就是被切掉的按钮（2026-10-30 真机）。
      //
      // 这段是纯算术，不需要浏览器，所以放在这里：`--check` 连"声明本身有没有可能"都一起看。
      const PET = { w: 150, h: 200 };
      const WINDOW_H = 520;
      const petY = Math.round((Math.max(WINDOW_H, PET.h) - PET.h) / 2);
      for (const [i, r] of rects.entries()) {
        if (!r || !r.maxH) continue;
        const bottom = petY + Number(r.dy || 0) + Number(r.h || 0); // anchor: top（默认）
        if (r.maxH > bottom) {
          console.log(`WARN  ${manifest.id} rect ${i}：maxH=${r.maxH} 超过窗口能给的 ${bottom}px（宠物头顶到窗口上沿的距离）`);
          console.log(`      块向上长，天花板就是它的下边缘这里（dy=${r.dy} + h=${r.h} + petY=${petY}）。超出的部分永远长不出来：把 dy 往 0 挪（贴着头顶）或把 maxH 改成 ≤ ${bottom}。`);
        }
      }

      const targets = opts.rectGiven ? [opts.rect] : rects.map((_, i) => i);
      let bad = 0;
      for (const index of targets) {
        const rect = rects[index] || { w: 380, h: 260 };
        const problems = await check(browser, url(index));
        const label = `${manifest.id} rect ${index}（${Math.round(rect.w)}×${Math.round(rect.h)}，state=${opts.state}）`;
        if (problems.length === 0) {
          console.log(`PASS  ${label}：全部元素在卡片之内`);
          // 第二趟：**不**跟随长高请求，按声明尺寸再量一次。
          //
          // 补的是一个具体事故（2026-10-30）：询问卡挂载时量到的是占位文本，真内容在 500ms
          // 内到达又被插件自己的节流吞掉，块停在旧高度、按钮被切掉一半。而只跑"宿主配合"的
          // 第一趟永远 PASS——因为**第一趟的宿主就是本工具**，它立刻同意、从不节流。
          // 所以把"只有宿主同意长高才装得下"显式报出来，让人知道自己依赖的是哪一环。
          const strict = await check(browser, url(index) + '&nogrow=1');
          if (strict.length > 0) {
            console.log(`WARN  ${manifest.id} rect ${index}：按声明尺寸装不下（${strict.length} 处），只有宿主同意长高才显示得全`);
            for (const one of strict.slice(0, 3)) console.log('  · ' + one);
            console.log('      真宿主那边长高要过 500ms 节流并重裁窗口：内容到达后必须**强制重量一次**，否则块停在挂载时那个高度（按钮被切掉一半）。');
          }
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

