import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 图床上传插件的行为测试：驱动的是 panel.html 里真实加载的那几支脚本。
//
// harness 与 websearch / memcore 那几份同型：vitest 的 jsdom 全局 window 当作插件的 window，
// 拼起来的源码用 new Function 丢进一个新函数作用域（等于浏览器里那几支经典 script 共享一个
// 作用域），出站 postMessage 用 spy 记下来。
//
// 这个文件钉住的几件事：
//
//   1. manifest 的形状：四项权限、background 由 net.fetch 撑着、serves 只有 upload、
//      图床地址是 hostWhitelist 项（用户能填，而且填了就会被加进白名单）；
//   2. multipart 的**字节**：边界出现在头和正文里、文件名被消毒、图片字节一字不差；
//   3. 请求的形状：POST 到 /upload、`responseFormat=object&returnFormat=full`、认证码在
//      查询串里而 Token 在 Authorization 头里、请求体走 bodyBase64（**不**用 body）；
//   4. 回来的四种形状都能变出一条链接（对象 / 数组 / 相对路径 / publicUrl）；
//   5. 失败说的是人话（401 点名认证码、400 点名格式），而且凭据没填时**一个请求都不发**；
//   6. 历史：最新在前、同一个链接只留一条、条数按设置项截断、清空会删键；
//   7. plugin.call：upload 用 data URL 也能传，未知方法回一条说得清的回包。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-imgbed');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');
const source = scriptSources
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-imgbed';

// 一张真的 PNG（1x1）：这些字节不是合法 UTF-8，正好是 body 会毁掉、bodyBase64 不会的那类内容。
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

function base64ToBytes(text) {
  const binary = Buffer.from(String(text), 'base64');
  return Uint8Array.from(binary);
}

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

describe('manifest', () => {
  test('asks for exactly what it uses, and the background frame is gated by net.fetch', () => {
    expect([...manifest.permissions].sort()).toEqual(
      ['net.fetch', 'plugin.call', 'plugin.config', 'storage'],
    );
    // 没有 process：上传是本机发出去的一个请求，不是启动一个程序。
    expect(manifest.permissions).not.toContain('process');
    expect(manifest.sidecar).toBeUndefined();
    expect(manifest.background).toBe(true);
    // serves 里点名的必须是自己实现的了的那一个方法。
    expect(manifest.serves).toEqual(['upload']);
  });

  test('the image host is a static netHost and the address is also a hostWhitelist setting', () => {
    expect(manifest.netHosts).toEqual(['imgcloud.shipixiv.de5.net']);
    const whitelist = manifest.config.filter((item) => item.hostWhitelist === true);
    expect(whitelist).toHaveLength(1);
    expect(whitelist[0].key).toBe('baseUrl');
    // 默认值就是用户提到的那台，第一次打开就能用。
    expect(whitelist[0].default).toBe('https://imgcloud.shipixiv.de5.net');
  });

  test('every file the page loads ships in the package', () => {
    // panel.html / app.js / style.css 是打包器总是带的三个固定资源；其余被页面引用的（lib/*.js、
    // ui.css）必须写进 manifest.assets，否则不会进包——装好之后是"页面白屏 + 404"。
    const fixed = ['panel.html', 'app.js', 'style.css'];
    for (const src of scriptSources) {
      if (fixed.includes(src)) continue;
      expect(manifest.assets).toContain(src);
    }
    expect(manifest.assets).toContain('ui.css');
    for (const asset of manifest.assets) {
      expect(existsSync(path.join(pluginDir, asset)), `manifest.assets 里的 ${asset} 不存在`).toBe(true);
    }
    expect(existsSync(path.join(pluginDir, manifest.entry))).toBe(true);
  });
});

// --- harness -----------------------------------------------------------------

let store;
let configValues;
let fetchCalls;
let fetchReplies;
let answered;
let postedFrom;
let windowListeners;
let timers;

function posted() {
  return window.postMessage.mock.calls.map((call) => call[0]).slice(postedFrom);
}

function byType(type) {
  return posted().filter((m) => m && m.type === type);
}

function requests() {
  return byType('request').map((m) => ({ id: m.id, method: m.method, payload: m.payload }));
}

function hostSends(data) {
  window.dispatchEvent(new MessageEvent('message', { data, source: window }));
}

function answer(id, result, { ok = true, error = '' } = {}) {
  answered.add(id);
  hostSends({ v: 1, type: 'response', id, ok, result, error });
}

function fetchReplyFor() {
  if (fetchReplies.length) {
    const next = fetchReplies.shift();
    return typeof next === 'function' ? next() : next;
  }
  return { status: 200, body: JSON.stringify({ src: 'https://img.example/file/ok.png' }) };
}

/** 每拍把还没答的请求答掉，再让出一拍——FileReader 与 Promise 链都在下一拍产生新请求。 */
async function drain(rounds = 24) {
  for (let i = 0; i < rounds; i += 1) {
    for (const req of requests().filter((r) => !answered.has(r.id))) {
      const payload = req.payload || {};
      switch (req.method) {
        case 'config.get':
          answer(req.id, { values: configValues, secrets: {} });
          break;
        case 'storage.get':
          answer(req.id, { value: store.has(String(payload.key)) ? store.get(String(payload.key)) : '' });
          break;
        case 'storage.set':
          store.set(String(payload.key), String(payload.value || ''));
          answer(req.id, { ok: true });
          break;
        case 'storage.remove':
          store.delete(String(payload.key));
          answer(req.id, { removed: true });
          break;
        case 'net.fetch':
          fetchCalls.push(payload);
          answer(req.id, fetchReplyFor());
          break;
        default:
          answer(req.id, null, { ok: false, error: `本程序不支持该方法 ${req.method}` });
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function loadApp() {
  answered = new Set();
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  for (const id of timers) clearTimeout(id);
  timers = [];
  postedFrom = window.postMessage.mock.calls.length;
  // eslint-disable-next-line no-new-func
  new Function(source)();
}

/** 装一份帧。`slot` 决定它是插件页还是桌宠那边的常驻帧。 */
async function boot({ slot = 'workshop', granted = manifest.permissions } = {}) {
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
  loadApp();
  hostSends({
    v: 1,
    type: 'init',
    pluginId: PLUGIN_ID,
    permissions: manifest.permissions,
    granted: [...granted],
    surface: slot === 'workshop' ? { kind: 'panel', slot: 'workshop' } : { kind: 'panel', slot: 'background' },
    host: {
      program: slot === 'workshop' ? 'workshop' : 'pet',
      methods: ['config.get', 'net.fetch', 'storage.get', 'storage.set', 'storage.remove'],
    },
  });
  await drain(6);
}

/** 走真实的那条路：把文件"拖"到拖放区上。 */
function dropFiles(files) {
  const zone = document.getElementById('drop');
  const event = new window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files } });
  zone.dispatchEvent(event);
}

function pngFile(name = 'a.png') {
  return new window.File([PNG], name, { type: 'image/png' });
}

beforeEach(() => {
  store = new Map();
  configValues = {
    baseUrl: 'https://img.example',
    authCode: 'code-1',
    apiToken: '',
    uploadChannel: '',
    folder: 'img/pet',
    nameType: 'default',
    maxHistory: '50',
  };
  fetchCalls = [];
  fetchReplies = [];
  windowListeners = [];
  timers = [];
  const originalAdd = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(function (type, fn, opts) {
    windowListeners.push([type, fn, opts]);
    return originalAdd(type, fn, opts);
  });
  const originalTimeout = window.setTimeout.bind(window);
  // 只记账，不拦：vitest 自己的"测试超时"也走 setTimeout，把整套语义换掉会让挂住的用例
  // 永远不超时（表现是整份测试无输出地停在那里）。所以 defer 一次原始实现，其余原样放行。
  vi.spyOn(window, 'setTimeout').mockImplementation((fn, ms, ...rest) => {
    const id = originalTimeout(fn, ms, ...rest);
    timers.push(id);
    return id;
  });
  vi.spyOn(window, 'postMessage').mockImplementation(() => {});
});

afterEach(() => {
  for (const id of timers) clearTimeout(id);
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  vi.restoreAllMocks();
});

// --- 一次上传：请求的形状与 multipart 的字节 ------------------------------------

test('dropping a file uploads it as bodyBase64 multipart, and the bytes survive verbatim', async () => {
  await boot();
  fetchReplies.push({ status: 200, body: JSON.stringify({ src: 'https://img.example/file/1793_a.png' }) });
  dropFiles([pngFile()]);
  await drain();

  expect(fetchCalls).toHaveLength(1);
  const sent = fetchCalls[0];
  expect(sent.method).toBe('POST');
  // 要对象、要完整链接、认证码在查询串里（Token 才走 Authorization 头）。
  expect(sent.url).toContain('https://img.example/upload?');
  expect(sent.url).toContain('responseFormat=object');
  expect(sent.url).toContain('returnFormat=full');
  expect(sent.url).toContain('authCode=code-1');
  expect(sent.url).toContain('uploadFolder=img%2Fpet');
  // 字节走 bodyBase64；body 一个字都不给（宿主会拒绝两个都给）。
  expect(sent.body).toBeUndefined();
  expect(typeof sent.bodyBase64).toBe('string');

  const body = base64ToBytes(sent.bodyBase64);
  const text = Buffer.from(body).toString('latin1');
  const boundary = /boundary=(.+)$/.exec(sent.headers['content-type'] || '');
  expect(boundary, 'content-type 必须带 boundary').toBeTruthy();
  expect(sent.headers.accept).toBe('application/json');

  // 边界出现在正文的头与尾，文件名字段与 Content-Type 行都在，图片字节一字不差。
  expect(text.startsWith(`--${boundary[1]}\r\n`)).toBe(true);
  expect(text).toContain('Content-Disposition: form-data; name="file"; filename="a.png"');
  expect(text).toContain('Content-Type: image/png');
  expect(text.endsWith(`\r\n--${boundary[1]}--\r\n`)).toBe(true);
  const at = body.indexOf(PNG[0] === 0x89 ? 0x89 : 0);
  expect(Array.from(body.slice(at, at + PNG.length))).toEqual(Array.from(PNG));

  // 结果就地显示在队列里，链接进历史。
  const rows = [...document.querySelectorAll('#queue .queue-row')];
  expect(rows).toHaveLength(1);
  expect(rows[0].querySelector('.queue-link').textContent).toBe('https://img.example/file/1793_a.png');
  const history = JSON.parse(store.get('uploads-v1'));
  expect(history[0].url).toBe('https://img.example/file/1793_a.png');
  expect(history[0].name).toBe('a.png');
});

test('an API Token rides the Authorization header instead of the query string', async () => {
  configValues.apiToken = 'tok-9';
  configValues.authCode = '';
  await boot();
  dropFiles([pngFile()]);
  await drain();

  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0].url).not.toContain('authCode=');
  expect(fetchCalls[0].headers.authorization).toBe('Bearer tok-9');
});

test('a name with quotes, a slash and a newline does not break the multipart header', async () => {
  await boot();
  dropFiles([pngFile('a"b/c\r\nd.png')]);
  await drain();

  const text = Buffer.from(base64ToBytes(fetchCalls[0].bodyBase64)).toString('latin1');
  // 取最后一段路径、并去掉引号与换行：头里那一行必须还是一个文件名，而不是被拆成第二个头。
  expect(text).toContain('filename="cd.png"');
  // 头里只有一个 CRLFCRLF 结束标记，注入的换行没有变成第二个头。
  expect(text.split('\r\n\r\n')).toHaveLength(2);
});

test('a Chinese filename travels as UTF-8 bytes (the图床 uses it as the stored name)', async () => {
  await boot();
  dropFiles([pngFile('桌宠截图.png')]);
  await drain();

  const body = base64ToBytes(fetchCalls[0].bodyBase64);
  // Node 的 Buffer 当裁判：这三个字的 UTF-8 字节必须原样出现在正文里。手写的 utf8Bytes 要是
  // 把多字节字符编错，图床那边存下来的就是一个乱码文件名——而界面上一切正常。
  expect(Buffer.from(body).indexOf(Buffer.from('桌宠截图.png', 'utf8'))).toBeGreaterThan(0);
});

// --- 回来的四种形状 -------------------------------------------------------------
test('an array with a relative src becomes a full link on the configured site', async () => {
  await boot();
  fetchReplies.push({ status: 200, body: JSON.stringify([{ src: '/file/abc.png' }]) });
  dropFiles([pngFile()]);
  await drain();
  expect(document.querySelector('#queue .queue-link').textContent).toBe('https://img.example/file/abc.png');
});

test('publicUrl wins over src when the deployment sets a URL prefix', async () => {
  await boot();
  fetchReplies.push({
    status: 200,
    body: JSON.stringify({ src: '/file/abc.png', publicUrl: 'https://cdn.example/abc.png' }),
  });
  dropFiles([pngFile()]);
  await drain();
  expect(document.querySelector('#queue .queue-link').textContent).toBe('https://cdn.example/abc.png');
});

// --- 失败说的是人话 ------------------------------------------------------------

test('401 names the credential as the thing to fix, and the file row shows it', async () => {
  await boot();
  fetchReplies.push({ status: 401, body: 'Unauthorized' });
  dropFiles([pngFile()]);
  await drain();

  const error = document.querySelector('#queue .queue-error');
  expect(error).toBeTruthy();
  expect(error.textContent).toContain('认证码');
  expect(error.textContent).toContain('401');
  // 失败不进历史。
  expect(store.has('uploads-v1')).toBe(false);
});

test('a format rejection points at the format, not at "操作失败"', async () => {
  await boot();
  fetchReplies.push({
    status: 400,
    body: JSON.stringify({ code: 'UPLOAD_FORMAT_NOT_ALLOWED', error: 'format not allowed' }),
  });
  dropFiles([pngFile()]);
  await drain();
  expect(document.querySelector('#queue .queue-error').textContent).toContain('格式');
});

test('with neither an auth code nor a token, nothing is sent at all', async () => {
  configValues.authCode = '';
  configValues.apiToken = '';
  await boot();
  dropFiles([pngFile()]);
  await drain();

  expect(fetchCalls).toHaveLength(0);
  expect(document.querySelector('#queue .queue-error').textContent).toContain('认证码');
});

test('without net.fetch the drop zone says so and sends nothing', async () => {
  await boot({ granted: ['storage', 'plugin.config', 'plugin.call'] });
  expect(document.getElementById('pick-btn').disabled).toBe(true);
  dropFiles([pngFile()]);
  await drain();

  expect(fetchCalls).toHaveLength(0);
  expect(document.getElementById('status').textContent).toContain('net.fetch');
});

// --- 历史 ---------------------------------------------------------------------

test('history keeps the newest first, folds duplicates, and honours maxHistory', async () => {
  configValues.maxHistory = '2';
  await boot();
  for (const name of ['a.png', 'b.png', 'c.png', 'a.png']) {
    fetchReplies.push({ status: 200, body: JSON.stringify({ src: `https://img.example/file/${name}` }) });
    dropFiles([pngFile(name)]);
    await drain(12);
  }
  const kept = JSON.parse(store.get('uploads-v1'));
  // a 刚传过 → 排到最前；只剩 2 条。
  expect(kept.map((row) => row.name)).toEqual(['a.png', 'c.png']);
});

test('clearing the history removes the key instead of writing an empty array', async () => {
  await boot();
  store.set('uploads-v1', JSON.stringify([{ url: 'https://img.example/x.png', at: 1, name: 'x.png' }]));
  document.getElementById('history-clear').click();
  await drain(8);
  expect(store.has('uploads-v1')).toBe(false);
  expect(document.getElementById('history-empty').classList.contains('hidden')).toBe(false);
});

// --- plugin.call（桌宠那边的常驻帧） -------------------------------------------

function callUpload(payload, method = 'upload') {
  const before = byType('call-result').length;
  const ticket = `t-${Math.random().toString(36).slice(2, 8)}`;
  hostSends({ v: 1, type: 'call', ticket, from: 'com.shixiansi.plugin-chat', method, payload });
  return () => {
    const list = byType('call-result').slice(before);
    expect(list.length, 'plugin.call 一直没有回包').toBeGreaterThan(0);
    return list[list.length - 1];
  };
}

test('plugin.call upload takes a data URL and answers with a link', async () => {
  await boot({ slot: 'background' });
  fetchReplies.push({ status: 200, body: JSON.stringify({ src: 'https://img.example/file/qr.png' }) });
  const taken = callUpload({ dataUrl: `data:image/png;base64,${bytesToBase64(PNG)}`, name: 'qr.png' });
  await drain();

  const packet = taken();
  expect(packet.ok).toBe(true);
  expect(packet.result.url).toBe('https://img.example/file/qr.png');
  expect(fetchCalls).toHaveLength(1);
  const body = base64ToBytes(fetchCalls[0].bodyBase64);
  // 图片字节原样出现在正文里（尾巴是 `\r\n--<boundary>--\r\n`，长度随边界变，所以按内容找）。
  const at = Buffer.from(body).indexOf(Buffer.from(PNG));
  expect(at).toBeGreaterThan(0);
  expect(Array.from(body.slice(at, at + PNG.length))).toEqual(Array.from(PNG));
});

test('plugin.call answers a method it does not serve with a sentence, not silence', async () => {
  await boot({ slot: 'background' });
  const taken = callUpload({}, 'resize');
  await drain(4);
  const packet = taken();
  expect(packet.ok).toBe(false);
  expect(packet.error).toContain('resize');
  expect(packet.error).toContain('upload');
});

test('plugin.call refuses an image too big for the 64 KiB payload instead of timing out', async () => {
  await boot({ slot: 'background' });
  const big = new Uint8Array(41 * 1024);
  const taken = callUpload({ dataUrl: `data:image/png;base64,${bytesToBase64(big)}` });
  await drain(4);
  const packet = taken();
  expect(packet.ok).toBe(false);
  expect(packet.error).toContain('插件页');
  expect(fetchCalls).toHaveLength(0);
});

