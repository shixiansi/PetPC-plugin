import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 点歌插件的行为测试，以及它与记忆核心之间那条链。
//
// 前半（「点歌插件」）驱动的是 panel.html 里真实加载的那几支脚本：接口请求的形状、`data` 是
// 对象还是数组、缓存、探测在哪一步发生、`song_link` 与 `song` 的差别。
//
// 后半（「记忆核心 → 点歌」）驱动的是记忆核心那一份，并把 `plugin.call` 答成点歌插件的返回
// 形状：它证明的是"用户点歌时核心真的会来问、问的时候带的是干净的查询词、拿回来的直链真的
// 进了 prompt"。核心自己的测试证明"它按我以为的形状问模型"；这里证明中间那件事。
//
// 一个必须钉住的细节：**方法名**。`search` 在插件市场里已经是"网页搜索"的能力名，而记忆核心
// 按能力名发现提供方（宿主 plugins.services / lib/services.js）。点歌如果也叫 search，
// "搜一下今天天气"会被问成"没找到这首歌"——所以这里断言 manifest.serves、CALL_HANDLERS、
// 核心的 callTargets 与 lib/music.js 里的两个常量四处逐字一致。

const here = path.dirname(fileURLToPath(import.meta.url));
const DIANGE_DIR = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-diange');
const CORE_DIR = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-memcore');

const DIANGE_ID = 'com.shixiansi.plugin-diange';
const CORE_ID = 'com.shixiansi.plugin-memcore';

const diangeManifest = JSON.parse(readFileSync(path.join(DIANGE_DIR, 'manifest.json'), 'utf8'));
const coreManifest = JSON.parse(readFileSync(path.join(CORE_DIR, 'manifest.json'), 'utf8'));

/** 一个插件的"文档包"：panel.html 的标记 + 它按顺序加载的全部脚本（拼起来 = 浏览器里那个作用域）。 */
function readBundle(dir) {
  const html = readFileSync(path.join(dir, 'panel.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
    .map((m) => m[1])
    .filter((src) => src && !src.startsWith('http'));
  if (!scripts.length) throw new Error(`${dir} 的 panel.html 没有加载任何插件脚本`);
  return { html, scripts, source: scripts.map((src) => readFileSync(path.join(dir, src), 'utf8')).join('\n') };
}

const diange = readBundle(DIANGE_DIR);
const core = readBundle(CORE_DIR);

// --- 静态接线 ----------------------------------------------------------------

describe('点歌插件：manifest 与接线', () => {
  test('常驻帧由 net.fetch / plugin.call 撑起来，权限不多要一个', () => {
    expect(diangeManifest.background).toBe(true);
    expect(diangeManifest.permissions).toContain('net.fetch');
    expect(diangeManifest.permissions).toContain('plugin.call');
    expect(diangeManifest.permissions).toContain('storage');
    expect(diangeManifest.permissions).toContain('plugin.config');
    // 不弹气泡、不占浮层面、不听事件：这个插件只回答"哪首歌、链接是什么"。
    for (const permission of ['pet.bubble', 'pet.surface', 'events', 'net.ws', 'audio', 'llm.chat']) {
      expect(diangeManifest.permissions, `不该申请 ${permission}`).not.toContain(permission);
    }
  });

  test('serves 与 CALL_HANDLERS 逐字相同（少一边就永远等超时）', () => {
    const body = (diange.source.match(/const CALL_HANDLERS = \{([\s\S]*?)\n\};/) || [])[1];
    expect(body, 'app.js 里没有 CALL_HANDLERS 字面量').toBeTruthy();
    const keys = [...body.matchAll(/^\s{2}([A-Za-z0-9_]+):/gm)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(0);
    expect(diangeManifest.serves).toEqual(keys);
    // 能力名不能占用"网页搜索"的那个词（见文件头）。
    expect(diangeManifest.serves).not.toContain('search');
  });

  test('探测白名单里的域名都在 manifest.netHosts 里', () => {
    const hosts = (diange.source.match(/const KNOWN_CDN_HOSTS = \[([^\]]*)\]/) || [])[1] || '';
    const known = [...hosts.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(known.length).toBeGreaterThan(0);
    for (const host of known) {
      expect(diangeManifest.netHosts, `netHosts 少了 ${host}`).toContain(host);
    }
    // 接口自己的域名也要在（用户把 apiBase 清空时回退到它）。
    expect(diangeManifest.netHosts).toContain('oiapi.net');
  });

  test('接口地址的默认值与代码里的 API_DEFAULT 一致', () => {
    const fromCode = (diange.source.match(/const API_DEFAULT = '([^']+)'/) || [])[1];
    const fromManifest = diangeManifest.config.find((item) => item.key === 'apiBase');
    expect(fromCode).toBeTruthy();
    expect(fromManifest.default).toBe(fromCode);
    expect(fromManifest.hostWhitelist).toBe(true);
  });

  test('记忆核心点名了这两个方法，而且用的是同一个名字', () => {
    const song = (core.source.match(/const MUSIC_METHOD = '([^']+)'/) || [])[1];
    const link = (core.source.match(/const MUSIC_LINK_METHOD = '([^']+)'/) || [])[1];
    expect(song).toBe('song');
    expect(link).toBe('song_link');
    expect(diangeManifest.serves).toContain(song);
    expect(diangeManifest.serves).toContain(link);
    expect(coreManifest.callTargets).toContain(`${DIANGE_ID}/${song}`);
    expect(coreManifest.callTargets).toContain(`${DIANGE_ID}/${link}`);
    expect(coreManifest.permissions).toContain('plugin.call');
    // 被调方也要持有 plugin.call：宿主对两边都查这一项。
    expect(diangeManifest.permissions).toContain('plugin.call');
  });

  test('配置项里最多两个 hostWhitelist（宿主的形状上限是 4）', () => {
    const whitelists = diangeManifest.config.filter((item) => item.hostWhitelist === true);
    expect(whitelists.length).toBeLessThanOrEqual(2);
    expect(whitelists.map((item) => item.key).sort()).toEqual(['apiBase', 'probeHosts']);
  });

  test('核心的 music 开关默认开着（否则"装了却没反应"）', () => {
    const item = coreManifest.config.find((row) => row.key === 'music');
    expect(item, 'manifest 里没有 music 这一项').toBeTruthy();
    expect(item.default).toBe('auto');
    expect(item.options.map((option) => option.value).sort()).toEqual(['auto', 'off']);
  });
});

// --- 点歌插件：行为 -----------------------------------------------------------

let store;
let configValues;
let fetchCalls;
let fetchReplies;
let answered;
let windowListeners;
let intervals;

function posted() {
  return window.postMessage.mock.calls.map((call) => call[0]);
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
  return { status: 404, body: '' };
}

async function pump(maxRounds = 40) {
  for (let i = 0; i < maxRounds; i += 1) {
    const open = requests().filter((r) => !answered.has(r.id));
    if (!open.length) return;
    for (const req of open) {
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
          answer(req.id, fetchReplyFor(payload));
          break;
        default:
          answer(req.id, null, { ok: false, error: `本程序不支持该方法 ${req.method}` });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const macro = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 装一份新的插件文档（等于宿主建的那个 iframe）。 */
function loadApp() {
  answered = new Set();
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  for (const id of intervals) clearInterval(id);
  intervals = [];
  // eslint-disable-next-line no-new-func
  new Function(diange.source)();
}

async function boot({ granted = [...diangeManifest.permissions], slotName = 'background', host = null } = {}) {
  const parsed = new JSDOM(diange.html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
  loadApp();
  hostSends({
    v: 1, type: 'init', pluginId: DIANGE_ID, permissions: diangeManifest.permissions,
    granted, surface: { kind: 'panel', slot: slotName }, host,
  });
  await pump();
}

/** 发一次 plugin.call，返回"取回包"的函数。 */
function call(method, payload) {
  const before = byType('call-result').length;
  const ticket = `t-${Math.random().toString(36).slice(2, 8)}`;
  hostSends({ v: 1, type: 'call', ticket, from: CORE_ID, method, payload });
  return () => {
    const list = byType('call-result').slice(before);
    expect(list.length, `${method} 一直没有回包（call-result 缺失）`).toBeGreaterThan(0);
    return list[list.length - 1];
  };
}

/** 接口对一首歌的应答（字段名照抄真实返回，见 lib/kuwo.js 的注释）。 */
function kuwoBody(over = {}) {
  return JSON.stringify({
    code: 1,
    message: '…',
    data: {
      song: '晴天',
      singer: '周杰伦',
      album: '叶惠美',
      url: 'http://kw-er.kuwo.cn/abc/resource/30106/trackmedia/M5000027oMO61wWi55.mp3?bitrate$128',
      picture: 'https://kwimg4.kuwo.cn/star/albumcover/800/x.jpg',
      bitrate: '128',
      format: 'mp3',
      size: '4.4Mb',
      time: '269',
      ...over,
    },
  });
}

beforeEach(() => {
  store = new Map();
  // 默认把探测关掉：绝大多数用例关心的是"搜索本身"，而探测会多花一次 net.fetch。
  // 探测自己的行为在下面单独一组里测，而且那时会显式打开它。
  configValues = {
    apiBase: 'http://oiapi.net', br: '128', probe: 'false', probeHosts: '',
    cacheTtlMin: '0', maxHistory: '10',
  };
  fetchCalls = [];
  fetchReplies = [];
  answered = new Set();
  windowListeners = [];
  intervals = [];
  const originalAdd = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(function (type, fn, opts) {
    windowListeners.push([type, fn, opts]);
    return originalAdd(type, fn, opts);
  });
  const originalInterval = window.setInterval.bind(window);
  vi.spyOn(window, 'setInterval').mockImplementation((fn, ms) => {
    const id = originalInterval(fn, ms);
    intervals.push(id);
    return id;
  });
  vi.spyOn(window, 'postMessage').mockImplementation(() => {});
});

afterEach(() => {
  for (const id of intervals) clearInterval(id);
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  vi.restoreAllMocks();
});

describe('song：把一句话变成一首歌', () => {
  test('请求形状：GET {apiBase}/api/Kuwo?msg=…&n=1&br=…，结果归一化成一首歌', async () => {
    await boot();
    fetchReplies.push({ status: 200, body: kuwoBody() });
    const get = call('song', { query: '晴天' });
    await pump();
    const packet = get();
    expect(packet.ok).toBe(true);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].method).toBe('GET');
    expect(fetchCalls[0].url).toBe(`http://oiapi.net/api/Kuwo?msg=${encodeURIComponent('晴天')}&n=1&br=128`);
    expect(Object.keys(fetchCalls[0].headers || {})).toEqual(['accept']);

    const song = packet.result.results[0];
    expect(song.title).toBe('晴天');
    expect(song.singer).toBe('周杰伦');
    expect(song.album).toBe('叶惠美');
    expect(song.url).toContain('kw-er.kuwo.cn');
    expect(song.durationSec).toBe(269);
    // 给模型读的那一段：直链独占一行，模型才知道该原样转发什么。
    expect(packet.result.text).toContain('【点歌】「晴天」——周杰伦');
    expect(packet.result.text).toContain(`直链：${song.url}`);
    expect(packet.result.text).toContain('4:29');
  });

  test('data 是数组也认（同一个接口两种都返回过）', async () => {
    await boot();
    fetchReplies.push({
      status: 200,
      body: JSON.stringify({ code: 1, data: [{ song: '七里香', singer: '周杰伦', url: 'http://kw-lv.kuwo.cn/x.mp3' }] }),
    });
    const get = call('song', { query: '七里香' });
    await pump();
    const packet = get();
    expect(packet.ok).toBe(true);
    expect(packet.result.results[0].title).toBe('七里香');
  });

  test('没有结果不是错误：count 0 + 一句"没找到"，而且只问了一次接口', async () => {
    await boot();
    fetchReplies.push({ status: 200, body: JSON.stringify({ code: 0, message: '没有' }) });
    const get = call('song', { query: 'zzz不存在' });
    await pump();
    const packet = get();
    expect(packet.ok).toBe(true);
    expect(packet.result.count).toBe(0);
    expect(packet.result.text).toContain('没有找到');
    // 换码率不会变出一首歌来：三档全问一遍纯属浪费。
    expect(fetchCalls).toHaveLength(1);
  });

  test('HTTP 失败会如实说接口挂了（不是"没找到"）', async () => {
    await boot();
    fetchReplies.push({ status: 502, body: '' });
    const get = call('song', { query: '晴天' });
    await pump();
    const packet = get();
    expect(packet.ok).toBe(false);
    expect(packet.error).toContain('502');
    expect(packet.error).toContain('oiapi.net');
  });

  test('缓存：同一句话在 TTL 内不再问接口（键是哈希，因为中文不是合法存储段）', async () => {
    configValues.cacheTtlMin = '15';
    await boot();
    fetchReplies.push({ status: 200, body: kuwoBody() });
    call('song', { query: '晴天' });
    await pump();
    expect(fetchCalls).toHaveLength(1);

    const get = call('song', { query: '晴天' });
    await pump();
    const packet = get();
    expect(fetchCalls, '缓存命中却又问了一次接口').toHaveLength(1);
    expect(packet.result.cached).toBe(true);
    expect(packet.result.results[0].title).toBe('晴天');
    // 缓存键只能是 [A-Za-z0-9_-] 的段：中文查询必须先哈希，否则整次写入被判非法键、静默不发生。
    const keys = [...store.keys()].filter((key) => key.startsWith('cache/'));
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^cache\/song\/[0-9a-f]+$/);
  });

  test('空 query 被拒绝，且一个请求都不发', async () => {
    await boot();
    const get = call('song', { query: '   ' });
    await pump();
    const packet = get();
    expect(packet.ok).toBe(false);
    expect(packet.error).toContain('query');
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('探测：能验才验，验不了就说"未验证"', () => {
  test('域名不在探测白名单里 → 不发请求，标未验证', async () => {
    configValues.probe = 'true';
    await boot();
    fetchReplies.push({
      status: 200,
      // 一个不认识的 CDN 域名：宿主白名单里没有它，发请求只会换来一条 WARN。
      body: kuwoBody({ url: 'http://cdn.example.test/x.mp3' }),
    });
    const get = call('song', { query: '晴天' });
    await pump();
    const packet = get();
    expect(fetchCalls, '对一个不在白名单里的域名发了请求').toHaveLength(1);
    expect(packet.result.results[0].probe).toEqual({ checked: false, reason: 'skip-host' });
    expect(packet.result.text).toContain('不在探测白名单里');
  });

  test('域名在白名单里 → GET 一次确认；播不通就换一档再试', async () => {
    configValues.probe = 'true';
    configValues.probeHosts = 'kw-er.kuwo.cn';
    await boot();
    const first = 'http://kw-er.kuwo.cn/abc/a.mp3';
    const second = 'http://kw-er.kuwo.cn/abc/b.mp3';
    fetchReplies.push(
      { status: 200, body: kuwoBody({ url: first }) },
      { status: 404, body: '' },                                    // 128 的那条播不通
      { status: 200, body: kuwoBody({ url: second, bitrate: '192' }) },
      { status: 200, body: '' },                                    // 192 的那条通了
    );
    const get = call('song', { query: '晴天' });
    await pump();
    const packet = get();
    expect(packet.ok).toBe(true);
    expect(fetchCalls).toHaveLength(4);
    expect(fetchCalls[1].url).toBe(first);
    expect(fetchCalls[3].url).toBe(second);
    // 第二次搜索是从 128 往上的下一档，不是原地重试。
    expect(fetchCalls[2].url).toContain('br=192');
    const song = packet.result.results[0];
    expect(song.url).toBe(second);
    expect(song.probe).toEqual({ checked: true, ok: true, code: 200 });
    expect(packet.result.text).toContain('已验证可播');
  });

  test('probe 关掉：一次探测都不发，理由写明是"关掉了"', async () => {
    configValues.probeHosts = 'kw-er.kuwo.cn';
    await boot();
    fetchReplies.push({ status: 200, body: kuwoBody() });
    const get = call('song', { query: '晴天' });
    await pump();
    const packet = get();
    expect(fetchCalls).toHaveLength(1);
    expect(packet.result.results[0].probe.reason).toBe('off');
    expect(packet.result.text).toContain('探测已关掉');
  });
});

describe('song_link：已知歌名要一条当下的链接', () => {
  test('song + singer 拼成一句话，url 提到顶层，且默认绕过缓存', async () => {
    configValues.cacheTtlMin = '15';
    await boot();
    fetchReplies.push({ status: 200, body: kuwoBody() }, { status: 200, body: kuwoBody() });
    const get = call('song_link', { song: '晴天', singer: '周杰伦' });
    await pump();
    const packet = get();
    expect(packet.ok).toBe(true);
    expect(fetchCalls[0].url).toContain(encodeURIComponent('晴天 周杰伦'));
    expect(packet.result.url).toContain('kw-er.kuwo.cn');
    expect(packet.result.title).toBe('晴天');
    expect(packet.result.verified).toBeNull();

    // 要链接的人往往正是因为"上一条失效了"，所以默认 fresh：第二次也要真的去问接口。
    const again = call('song_link', { song: '晴天', singer: '周杰伦' });
    await pump();
    expect(again().result.cached).toBe(false);
    expect(fetchCalls).toHaveLength(2);
  });

  test('找不到时 url 是空串（不是 undefined），调用方好判断', async () => {
    await boot();
    fetchReplies.push({ status: 200, body: '{"code":0}' });
    const get = call('song_link', { song: '不存在的歌' });
    await pump();
    const packet = get();
    expect(packet.ok).toBe(true);
    expect(packet.result.url).toBe('');
    expect(packet.result.text).toContain('没有找到');
  });
});

describe('协议', () => {
  test('不认识的方法也回包，并且点名自己答什么', async () => {
    await boot();
    const get = call('music', { query: 'x' });
    await pump();
    const packet = get();
    expect(packet.ok).toBe(false);
    expect(packet.error).toContain('song');
    expect(packet.error).toContain('song_link');
  });

  test('先发 ready；init 之前一个请求都不发', async () => {
    const parsed = new JSDOM(diange.html);
    document.body.innerHTML = parsed.window.document.body.innerHTML;
    loadApp();
    expect(posted()[0] && posted()[0].type).toBe('ready');
    expect(requests()).toHaveLength(0);
  });

  test('workshop 里宿主不服务 net.fetch：按钮禁用并说清为什么', async () => {
    await boot({
      slotName: 'workshop',
      host: { program: 'workshop', methods: ['config.get', 'storage.get'] },
    });
    expect(document.getElementById('go').disabled).toBe(true);
    const note = document.querySelector('.desktop-only');
    expect(note, '没有那句"这一页搜不动"的说明').toBeTruthy();
    // hidden 是**属性**（ui.css 只给 [hidden] 定过规则）：一个同名 class 不表示"看不见"。
    expect(note.hidden, '说明被藏起来了').toBe(false);
  });

  test('workshop 里宿主服务 net.fetch：按钮可用（控制中心其实注册了它）', async () => {
    await boot({
      slotName: 'workshop',
      host: { program: 'workshop', methods: ['config.get', 'storage.get', 'net.fetch'] },
    });
    expect(document.getElementById('go').disabled).toBe(false);
  });
});

// --- 记忆核心 → 点歌 ---------------------------------------------------------

describe('记忆核心 → 点歌', () => {
  let coreWindow;
  let coreInbox;
  let coreStore;
  let coreConfig;
  let llmCalls;
  let llmReplies;
  let callTargets;
  let callPayloads;
  let musicReplies;
  let coreAnswered;
  let coreListeners;
  let coreIntervals;

  function coreRequests() {
    return coreInbox.filter((m) => m && m.type === 'request')
      .map((m) => ({ id: m.id, method: m.method, payload: m.payload }));
  }

  function coreSend(data) {
    coreWindow.dispatchEvent(new coreWindow.MessageEvent('message', { data, source: coreWindow }));
  }

  function coreAnswer(id, result, { ok = true, error = '' } = {}) {
    coreAnswered.add(id);
    coreSend({ v: 1, type: 'response', id, ok, result, error });
  }

  function answerCoreRequest(req) {
    const payload = req.payload || {};
    switch (req.method) {
      case 'config.get':
        coreAnswer(req.id, { values: coreConfig, secrets: {} });
        return;
      case 'storage.get':
        coreAnswer(req.id, { value: coreStore.has(String(payload.key)) ? coreStore.get(String(payload.key)) : '' });
        return;
      case 'storage.set':
        coreStore.set(String(payload.key), String(payload.value || ''));
        coreAnswer(req.id, { ok: true });
        return;
      case 'storage.remove':
        coreStore.delete(String(payload.key));
        coreAnswer(req.id, { removed: true });
        return;
      case 'llm.chat':
        llmCalls.push(payload);
        coreAnswer(req.id, { requestId: 'sim', text: llmReplies.length ? llmReplies.shift() : '（模拟回答）' });
        return;
      case 'plugin.call': {
        const target = `${String(payload.target || '')}/${String(payload.method || '')}`;
        callTargets.push(target);
        callPayloads.push(payload.payload || {});
        // 闸门按 manifest 的声明做：没点名的目标一律拒——和真宿主同一句话。
        if (!coreManifest.callTargets.includes(target)) {
          coreAnswer(req.id, null, { ok: false, error: `插件 ${CORE_ID} 没有声明要调用 ${target}` });
          return;
        }
        if (!target.startsWith(`${DIANGE_ID}/`)) {
          // 词库 / 联网搜索：装上但没命中，正是真机上常见的样子。
          coreAnswer(req.id, { query: String((payload.payload && payload.payload.query) || ''), text: '', matched: '', hits: [] });
          return;
        }
        const reply = musicReplies.shift();
        if (!reply) {
          coreAnswer(req.id, null, { ok: false, error: `问不到 ${DIANGE_ID}` });
          return;
        }
        coreAnswer(req.id, reply);
        return;
      }
      default:
        coreAnswer(req.id, null, { ok: false, error: `本程序不支持该方法 ${req.method}` });
    }
  }

  async function settle(maxRounds = 60) {
    let idle = 0;
    for (let i = 0; i < maxRounds; i += 1) {
      const before = coreInbox.length;
      let acted = 0;
      for (const req of coreRequests()) {
        if (coreAnswered.has(req.id)) continue;
        acted += 1;
        answerCoreRequest(req);
      }
      await macro();
      if (acted === 0 && before === coreInbox.length) {
        idle += 1;
        if (idle >= 3) return;
      } else {
        idle = 0;
      }
    }
  }

  function bootCore() {
    const dom = new JSDOM(core.html, { runScripts: 'outside-only', url: 'http://plugin.test/panel.html' });
    coreWindow = dom.window;
    coreWindow.parent = coreWindow;
    coreInbox = [];
    coreWindow.postMessage = (message) => coreInbox.push(message);
    const originalAdd = coreWindow.addEventListener.bind(coreWindow);
    coreWindow.addEventListener = (type, fn, opts) => {
      coreListeners.push([type, fn, opts]);
      return originalAdd(type, fn, opts);
    };
    const originalInterval = coreWindow.setInterval.bind(coreWindow);
    coreWindow.setInterval = (fn, ms) => {
      const id = originalInterval(fn, ms);
      coreIntervals.push(id);
      return id;
    };
    coreWindow.eval(core.source);
    coreSend({
      v: 1, type: 'init', pluginId: CORE_ID, permissions: coreManifest.permissions,
      granted: [...coreManifest.permissions], surface: { kind: 'panel', slot: 'background' },
    });
    return settle();
  }

  /** 通过核心的 chat 跑一轮（等于接入端问了一次）。 */
  async function chat(line) {
    const ticket = 'chat-1';
    coreSend({
      v: 1, type: 'call', ticket, from: 'test-adapter', method: 'chat',
      payload: { roleId: 'g-1', userId: 'u-1', userName: '阿岚', text: line },
    });
    await settle();
    return coreInbox.filter((m) => m && m.type === 'call-result' && m.ticket === ticket).at(-1);
  }

  const songResult = {
    query: '晴天',
    provider: 'kuwo',
    count: 1,
    tookMs: 320,
    text: '【点歌】「晴天」——周杰伦（专辑《叶惠美》；mp3 128kbps 4.4Mb；4:29）\n直链：http://kw-er.kuwo.cn/abc/x.mp3\n链接状态：未验证（这个音频域名不在探测白名单里）',
    results: [{ title: '晴天', singer: '周杰伦', album: '叶惠美', url: 'http://kw-er.kuwo.cn/abc/x.mp3' }],
  };

  // 只数"问点歌"的那几次：词库（slang / moegirl）也在 callTargets 里，它们每轮都会问一次。
  // 所以断言一律按目标过滤，而不是取 callTargets[0]——那会随"这一轮先问了谁"漂移。
  const musicCalls = () => callTargets.filter((t) => t.startsWith(`${DIANGE_ID}/`));
  const musicPayloads = () => callTargets
    .map((target, index) => ({ target, payload: callPayloads[index] }))
    .filter((row) => row.target.startsWith(`${DIANGE_ID}/`))
    .map((row) => row.payload);

  beforeEach(() => {
    coreInbox = [];
    coreStore = new Map();
    coreConfig = {
      personaName: '小记', persona: '', replyMaxChars: '400', bufferTurns: '8',
      summaryChars: '500', episodeMax: '40', profileEvery: '3',
      webSearch: 'off', webSearchCount: '3', llmDailyBudget: '200',
      compactEnabled: 'false', music: 'auto',
    };
    llmCalls = [];
    llmReplies = [];
    callTargets = [];
    callPayloads = [];
    musicReplies = [];
    coreAnswered = new Set();
    coreListeners = [];
    coreIntervals = [];
  });

  afterEach(() => {
    for (const id of coreIntervals) clearInterval(id);
    if (coreWindow) {
      for (const [type, fn, opts] of coreListeners) coreWindow.removeEventListener(type, fn, opts);
      coreWindow.close();
    }
  });

  test('「点歌 晴天」：查询词去掉动词，直链进了 prompt', async () => {
    musicReplies.push(songResult);
    await bootCore();
    llmReplies.push('给你——周杰伦《晴天》：\nhttp://kw-er.kuwo.cn/abc/x.mp3');
    const packet = await chat('点歌 晴天');
    expect(packet.ok).toBe(true);

    // 请求形状：方法名、干净的查询词、带预算。
    expect(musicCalls()[0]).toBe(`${DIANGE_ID}/song`);
    expect(musicPayloads()[0].query).toBe('晴天');
    expect(musicPayloads()[0].timeoutMs).toBeGreaterThan(0);

    // 拼进 system 的是结果本身（模型要照着它说），不是"我查过了"。
    expect(llmCalls[0].system).toContain('【点歌结果】');
    expect(llmCalls[0].system).toContain('http://kw-er.kuwo.cn/abc/x.mp3');
    expect(packet.result.text).toContain('http://kw-er.kuwo.cn/abc/x.mp3');
    expect(packet.result.meta.music).toEqual({ title: '晴天', singer: '周杰伦', provider: 'kuwo' });
    // 直链不落盘也不进 meta：它带签名，存下来只会变成未来的死链。
    expect(JSON.stringify(packet.result.meta)).not.toContain('kw-er.kuwo.cn');
  });

  test('模型自己写 [SONG] 时走结构化那条路（song_link）', async () => {
    await bootCore();
    llmReplies.push('[SONG] 晴天 - 周杰伦', '给你：http://kw-er.kuwo.cn/abc/x.mp3');
    musicReplies.push(songResult);
    const packet = await chat('随便放点什么吧');
    expect(packet.ok).toBe(true);

    // 用户那句话不是在点歌，所以第一问之前没问；第二答之前才问，而且是 song_link。
    expect(musicCalls()).toEqual([`${DIANGE_ID}/song_link`]);
    expect(musicPayloads()[0].song).toBe('晴天');
    expect(musicPayloads()[0].singer).toBe('周杰伦');
    expect(musicPayloads()[0].fresh).toBe(true);
    expect(llmCalls).toHaveLength(2);
    expect(llmCalls[1].system).toContain('【点歌结果】');
    expect(packet.result.meta.music.title).toBe('晴天');
    expect(packet.result.text).not.toContain('[SONG]');
  });

  test('点歌插件问不到：对话照常，不再拿同一个问题试第二遍', async () => {
    await bootCore();
    llmReplies.push('这首歌我没找到链接，换个写法（歌名 + 歌手）再点一次？');
    // musicReplies 空 → 假宿主回「问不到 …」
    const packet = await chat('点歌 晴天');
    expect(packet.ok).toBe(true);
    expect(packet.result.meta.music).toBeNull();
    expect(packet.result.text).not.toContain('[SONG]');
    // 用户明确点歌 → 第一次就问了；插件都问不动，就别再为模型那句 [SONG] 试第二遍。
    expect(musicCalls()).toEqual([`${DIANGE_ID}/song`]);
  });

  test('music=off：一次都不问，标记照样被去掉', async () => {
    coreConfig.music = 'off';
    await bootCore();
    llmReplies.push('[SONG] 晴天 - 周杰伦');
    const packet = await chat('点歌 晴天');
    expect(packet.ok).toBe(true);
    expect(musicCalls()).toEqual([]);
    expect(packet.result.text).not.toContain('[SONG]');
    expect(packet.result.meta.music).toBeNull();
  });

  test('「我记得那首歌」不是点歌：不触发', async () => {
    await bootCore();
    llmReplies.push('记得，上次你说喜欢《晴天》。');
    const packet = await chat('我记得那首歌');
    expect(packet.ok).toBe(true);
    expect(musicCalls()).toEqual([]);
    expect(packet.result.meta.music).toBeNull();
  });
});
