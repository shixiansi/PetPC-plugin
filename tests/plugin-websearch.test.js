import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 联网搜索插件的行为测试：驱动的是 panel.html 里真实加载的那几支脚本。
//
// harness 与 memcore 的测试同型：vitest 的 jsdom 全局 window 当作插件的 window，
// 拼起来的源码用 new Function 丢进一个新函数作用域（等于浏览器里那几支经典脚本
// 共享同一个作用域），出站 postMessage 用 spy 记下来。
//
// 这个文件钉住的几件事：
//
//   1. 三家引擎各自的请求形状（Tavily 是 POST body、Bing 是查询参数、SearXNG 是 GET+format=json）；
//   2. 归一化：没有 url / 非 http 的行被丢掉，摘要压成一行；
//   3. 缓存：同一句话在 TTL 内不发第二次网络；
//   4. 引擎没配好时，给出的错误是「能拿去修」的那句中文；
//   5. 每一次 plugin.call 都有回包，包括「我不认识这个方法」。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-websearch');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');
const source = scriptSources
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-websearch';

describe('manifest', () => {
  test('declares background gated by net.fetch, and serves only search', () => {
    expect(manifest.background).toBe(true);
    expect(manifest.permissions).toContain('net.fetch');
    expect(manifest.permissions).toContain('plugin.call');
    expect(manifest.permissions).not.toContain('events');
    expect(manifest.permissions).not.toContain('net.ws');
    expect(manifest.serves).toEqual(['search']);
  });

  test('whitelists the two hosted engines and takes the SearXNG base from config', () => {
    // SearXNG 的地址是用户自填的（hostWhitelist 配置项），netHosts 只需要两家托管引擎。
    expect(manifest.netHosts).toContain('api.tavily.com');
    expect(manifest.netHosts).toContain('api.bing.microsoft.com');
    const whitelist = manifest.config.filter((item) => item.hostWhitelist === true);
    expect(whitelist).toHaveLength(1);
    expect(whitelist[0].key).toBe('searxngUrl');
  });

  test('memcore names exactly this plugin/search', () => {
    const coreSource = ['core.js', 'memory.js', 'prompt.js', 'websearch.js', 'chat.js', 'workshop.js']
      .map((f) => readFileSync(path.join(here, '..', 'plugins', 'com.shixiansi.plugin-memcore', 'lib', f), 'utf8'))
      .join('\n');
    const target = (coreSource.match(/const SEARCH_TARGET = '([^']+)';/) || [])[1];
    const method = (coreSource.match(/const SEARCH_METHOD = '([^']+)';/) || [])[1];
    expect(target).toBe(PLUGIN_ID);
    expect(method).toBe('search');
    expect(manifest.serves).toContain(method);
  });
});

// --- harness -----------------------------------------------------------------

let store;
let configValues;
let fetchCalls;
/** 每一次 net.fetch 的应答（按队列取；函数形式的按请求算）。 */
let fetchReplies;
let answered;
let postedFrom;
let windowListeners;
let intervals;

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

function fetchReplyFor(payload) {
  if (fetchReplies.length) {
    const next = fetchReplies.shift();
    return typeof next === 'function' ? next(payload) : next;
  }
  return { status: 200, body: '{"results":[]}' };
}

async function pump(maxRounds = 40) {
  for (let i = 0; i < maxRounds; i += 1) {
    const list = requests().filter((r) => !answered.has(r.id));
    if (!list.length) return;
    for (const req of list) {
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

/** 装一份新的常驻帧文档。 */
function loadApp() {
  answered = new Set();
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  for (const id of intervals) clearInterval(id);
  intervals = [];
  postedFrom = window.postMessage.mock.calls.length;
  // 拼起来的源码放进一个新的函数作用域（memcore 测试同款）。
  // eslint-disable-next-line no-new-func
  new Function(source)();
}

function boot() {
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
  loadApp();
  hostSends({
    v: 1, type: 'init', pluginId: PLUGIN_ID, permissions: manifest.permissions,
    granted: [...manifest.permissions], surface: { kind: 'panel', slot: 'background' },
  });
  return macro();
}

/** 发一次 plugin.call 的 search，返回「取回包」的函数。 */
function callSearch(payload, method = 'search') {
  const before = byType('call-result').length;
  const ticket = `t-${Math.random().toString(36).slice(2, 8)}`;
  hostSends({ v: 1, type: 'call', ticket, from: 'com.shixiansi.plugin-memcore', method, payload });
  return () => {
    const list = byType('call-result').slice(before);
    expect(list.length, 'search 一直没有回包（call-result 缺失）').toBeGreaterThan(0);
    return list[list.length - 1];
  };
}

beforeEach(() => {
  store = new Map();
  configValues = { engine: 'searxng', searxngUrl: 'http://127.0.0.1:8888', resultCount: '3', cacheTtlMin: '30', maxHistory: '20' };
  fetchCalls = [];
  fetchReplies = [];
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

// --- 引擎请求形状 ---------------------------------------------------------------

const searxngBody = JSON.stringify({
  query: '今天天气', answer: [], results: [
    { title: '天气网', url: 'https://weather.example.com/today', content: '今天 晴\n 3 到 12 度' },
    { title: '没有链接的行', url: '', content: '会被丢掉' },
    { title: 'ftp 不算', url: 'ftp://example.com/x', content: '也会被丢掉' },
  ],
});

test('searxng: GET format=json against the configured instance, snippets flattened', async () => {
  await boot();
  fetchReplies.push({ status: 200, body: searxngBody });
  const getResult = callSearch({ query: '今天天气' });
  await pump();
  const packet = getResult();
  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0].method).toBe('GET');
  expect(fetchCalls[0].url).toBe('http://127.0.0.1:8888/search?q=%E4%BB%8A%E5%A4%A9%E5%A4%A9%E6%B0%94&format=json&language=zh-CN&safesearch=1');

  expect(packet.ok).toBe(true);
  expect(packet.result.results).toHaveLength(1);
  expect(packet.result.results[0]).toEqual({
    title: '天气网', url: 'https://weather.example.com/today', snippet: '今天 晴 3 到 12 度',
  });
  expect(packet.result.text).toContain('[1] 天气网');
  expect(packet.result.engine).toBe('searxng');
});

test('searxng 403: the error names the settings.yml fix', async () => {
  await boot();
  fetchReplies.push({ status: 403, body: 'forbidden' });
  const getResult = callSearch({ query: 'x' });
  await pump();
  const packet = getResult();
  expect(packet.ok).toBe(false);
  expect(packet.error).toContain('settings.yml');
  expect(packet.error).toContain('json');
});

test('tavily: POST with api_key in the body', async () => {
  configValues = { engine: 'tavily', tavilyApiKey: 'tvly-test', resultCount: '2', cacheTtlMin: '0' };
  await boot();
  fetchReplies.push({ status: 200, body: JSON.stringify({ results: [{ title: 'T', url: 'https://t.example/a', content: '内容' }] }) });
  const getResult = callSearch({ query: 'hello' });
  await pump();
  const packet = getResult();
  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0].method).toBe('POST');
  expect(fetchCalls[0].url).toBe('https://api.tavily.com/search');
  const sent = JSON.parse(fetchCalls[0].body);
  expect(sent.api_key).toBe('tvly-test');
  expect(sent.query).toBe('hello');
  expect(packet.ok).toBe(true);
  expect(packet.result.results[0].title).toBe('T');
});

test('tavily 401: names the key as the thing to fix', async () => {
  configValues = { engine: 'tavily', tavilyApiKey: 'bad', cacheTtlMin: '0' };
  await boot();
  fetchReplies.push({ status: 401, body: '{"detail":{"error":"Unauthorized"}}' });
  const getResult = callSearch({ query: 'x' });
  await pump();
  expect(getResult().error).toContain('Key');
});

test('bing: subscription key rides the query string (host header whitelist)', async () => {
  configValues = { engine: 'bing', bingKey: 'bing-key-1', resultCount: '4', cacheTtlMin: '0' };
  await boot();
  fetchReplies.push({
    status: 200,
    body: JSON.stringify({ webPages: { value: [{ name: 'B 标题', url: 'https://b.example/x', snippet: 'B 摘要' }] } }),
  });
  const getResult = callSearch({ query: 'bing q' });
  await pump();
  const packet = getResult();
  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0].method).toBe('GET');
  expect(fetchCalls[0].url).toContain('https://api.bing.microsoft.com/v7.0/search?q=bing%20q');
  expect(fetchCalls[0].url).toContain('subscription-key=bing-key-1');
  expect(Object.keys(fetchCalls[0].headers || {})).toEqual(['accept']);
  expect(packet.ok).toBe(true);
  expect(packet.result.results[0]).toEqual({ title: 'B 标题', url: 'https://b.example/x', snippet: 'B 摘要' });
});

// --- 缓存 / 历史 / 兜底 ---------------------------------------------------------

test('cache: the same query inside the TTL does not hit the network twice', async () => {
  await boot();
  fetchReplies.push({ status: 200, body: searxngBody });
  callSearch({ query: '今天天气' });
  await pump();
  expect(fetchCalls).toHaveLength(1);

  const getResult = callSearch({ query: '今天天气' });
  await pump();
  const packet = getResult();
  expect(fetchCalls).toHaveLength(1);
  expect(packet.ok).toBe(true);
  expect(packet.result.cached).toBe(true);
  expect(packet.result.results).toHaveLength(1);
});

test('history records the query', async () => {
  await boot();
  fetchReplies.push({ status: 200, body: searxngBody });
  callSearch({ query: '今天天气' });
  await pump();
  const saved = JSON.parse(store.get('history/recent'));
  expect(saved).toHaveLength(1);
  expect(saved[0].query).toBe('今天天气');
  expect(saved[0].engine).toBe('searxng');
  expect(saved[0].count).toBe(1);
});

test('unconfigured engine: a fixable Chinese error, no network', async () => {
  configValues = { engine: 'searxng', searxngUrl: '', cacheTtlMin: '0' };
  await boot();
  const getResult = callSearch({ query: 'x' });
  await pump();
  const packet = getResult();
  expect(packet.ok).toBe(false);
  expect(packet.error).toContain('SearXNG 实例地址');
  expect(fetchCalls).toHaveLength(0);
});

test('unknown call method: answered with an error, never silence', async () => {
  await boot();
  const getResult = callSearch({}, 'other');
  await pump();
  const packet = getResult();
  expect(packet.ok).toBe(false);
  expect(packet.error).toContain('search');
});

test('every request has a unique non-empty id; empty query is rejected', async () => {
  await boot();
  const ids = requests().map((r) => r.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);

  const getResult = callSearch({ query: '   ' });
  await pump();
  const packet = getResult();
  expect(packet.ok).toBe(false);
  expect(packet.error).toContain('query');
});

test('says ready first, and nothing before init', async () => {
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
  loadApp();
  const first = posted()[0];
  expect(first && first.type).toBe('ready');
  expect(requests()).toHaveLength(0);
});
