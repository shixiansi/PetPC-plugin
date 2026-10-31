import { afterEach, beforeEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 晨报插件的行为测试：驱动的是 panel.html 里真实加载的那几支脚本。
//
// harness 与 websearch / screen-vision 的测试同型：拼起来的源码用 new Function 丢进
// 一个新函数作用域，出站 postMessage 用 spy 记下来。
//
// 这个文件钉住的几件事：
//
//   1. 极简 XML 解析器：RSS 2.0 与 Atom 都归一化；CDATA 与实体不漏字；命名空间前缀按本地名；
//   2. 去重：同一个源的旧文章第二次抓不再出现；换 link 的源用 title 兜底；
//   3. 摘要编排：正文按条截断、prompt 的形状、"3 句话"的系统提示；
//   4. 超时处理：模型那一步挂了要留痕、要抛中文；语音那一步失败不拖死晨报；
//   5. fetch_now 的回包形状与「我不认识这个方法」。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-rss-reader');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');
const source = scriptSources
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-rss-reader';
const MEMCORE_ID = 'com.shixiansi.plugin-memcore';
const VOICE_ID = 'com.shixiansi.plugin-voice';

// --- 测试用的 feed ------------------------------------------------------------

const RSS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>科技早报</title>
  <item>
    <title>第一条 &amp; 有转义</title>
    <link>https://news.example.com/one</link>
    <pubDate>Mon, 26 Oct 2026 08:00:00 GMT</pubDate>
    <description><![CDATA[<p>带 <b>HTML</b> 的第一段。]]></description>
  </item>
  <item>
    <title>第二条：没有链接的</title>
    <pubDate>Tue, 27 Oct 2026 08:00:00 GMT</pubDate>
    <description>纯文本第二条，字符 &lt; 尖括号也要活下来</description>
  </item>
  <item>
    <title>content:encoded 的全文</title>
    <link>https://news.example.com/three</link>
    <content:encoded>正文在另一个命名空间里。</content:encoded>
  </item>
</channel></rss>`;

const ATOM_SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom 源</title>
  <entry>
    <title>Atom 第一条</title>
    <link href="https://atom.example.com/a"/>
    <updated>2026-10-28T10:00:00Z</updated>
    <summary>Atom 的摘要。</summary>
  </entry>
  <entry>
    <title>Atom 第二条</title>
    <link rel="alternate" href="https://atom.example.com/b"/>
    <published>2026-10-29T09:00:00Z</published>
    <content>直接在 content 里的正文。</content>
  </entry>
</feed>`;

describe('manifest', () => {
  test('declares background gated by net.fetch and fetch/events permissions', () => {
    expect(manifest.background).toBe(true);
    expect(manifest.permissions).toContain('net.fetch');
    expect(manifest.permissions).toContain('plugin.call');
    expect(manifest.permissions).toContain('pet.bubble');
    // 净网：不需要的多余权限不申请。
    expect(manifest.permissions).not.toContain('net.ws');
    expect(manifest.permissions).not.toContain('llm.chat');
  });

  test('serves fetch_now and calls exactly memcore/chat and voice/speak', () => {
    expect(manifest.serves).toEqual(['fetch_now']);
    expect(manifest.callTargets).toEqual([
      `${MEMCORE_ID}/chat`,
      `${VOICE_ID}/speak`,
    ]);
  });

  test('the pair partners actually serve what we call', () => {
    const coreManifest = JSON.parse(readFileSync(path.join(here, '..', 'plugins', MEMCORE_ID, 'manifest.json'), 'utf8'));
    const voiceManifest = JSON.parse(readFileSync(path.join(here, '..', 'plugins', VOICE_ID, 'manifest.json'), 'utf8'));
    expect(coreManifest.serves).toContain('chat');
    expect(voiceManifest.serves).toContain('speak');
  });

  test('feedUrls is the single hostWhitelist the user feeds live in', () => {
    const whitelist = manifest.config.filter((item) => item.hostWhitelist === true);
    expect(whitelist.map((item) => item.key)).toEqual(['feedUrls', 'extraHosts']);
    expect(manifest.netHosts.length).toBeGreaterThan(0);
  });
});

// --- 纯函数部分（解析器 / prompt）：在**隔离的 jsdom** 里挂一份只读作用域 -----------------
//
// 注意不能直接用全局 document： vitest 的 jsdom 环境整个文件共享一个 window，
// 这里 new Function(source) 出来的作用域会**一直挂着 message 监听器**——后面行为测试
// 的 init 也会被它收到，它发的请求 id 与当前作用域的撞车，pump 就会答错对象。
// 隔离 = 用一个独立的 JSDOM window 承载这份作用域，不碰全局 document。

const isolatedListeners = [];

async function mountIsolated() {
  // 在 vitest 的 jsdom window 上挂一份"只读"作用域，但**挂完立刻把它的监听器摘掉**：
  // 源码顶层 addEventListener('message', ...) 与 postToHost({type:'ready'}) 都会执行——
  // 留着监听器，行为测试的 init 会被它收到，它发出的请求 id 与当前作用域的撞车。
  const originalAdd = window.addEventListener.bind(window);
  const spied = vi.spyOn(window, 'addEventListener').mockImplementation(function (type, fn, opts) {
    isolatedListeners.push([type, fn, opts]);
    return originalAdd(type, fn, opts);
  });
  try {
    // eslint-disable-next-line no-new-func
    new Function(source)();
  } finally {
    spied.mockRestore();
  }
  // 摘掉它挂的一切 message 监听器（含 app.js/core.js 的），并清掉它刚发过的 ready。
  for (const [type, fn, opts] of isolatedListeners.splice(0)) {
    window.removeEventListener(type, fn, opts);
  }
  // 它的 ready 走了**真实的** postMessage（spy 还没装）——jsdom 顶层无害，无需清理。
  return window.__rss;
}

describe('xml parser', () => {
  let xml;
  beforeAll(async () => {
    const api = await mountIsolated();
    xml = api.xml;
  });

  test('rss: items normalized, entities and cdata decoded, html stripped', () => {
    const parsed = xml.parseFeed(RSS_SAMPLE);
    expect(parsed.kind).toBe('rss');
    expect(parsed.title).toBe('科技早报');
    expect(parsed.items).toHaveLength(3);
    expect(parsed.items[0].title).toBe('第一条 & 有转义');
    expect(parsed.items[0].link).toBe('https://news.example.com/one');
    expect(parsed.items[0].published).toBe(Date.parse('Mon, 26 Oct 2026 08:00:00 GMT'));
    expect(parsed.items[0].summary).toBe('带 HTML 的第一段。');
    // 没有 link 的条目：link 为空，但条目还在（title 兜底去重）。
    expect(parsed.items[1].link).toBe('');
    expect(parsed.items[1].summary).toContain('字符 < 尖括号');
    // content:encoded 按**本地名**匹配。
    expect(parsed.items[2].summary).toBe('正文在另一个命名空间里。');
  });

  test('atom: link from href attribute, summary falls back to content', () => {
    const parsed = xml.parseFeed(ATOM_SAMPLE);
    expect(parsed.kind).toBe('atom');
    expect(parsed.title).toBe('Atom 源');
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0].link).toBe('https://atom.example.com/a');
    expect(parsed.items[0].summary).toBe('Atom 的摘要。');
    expect(parsed.items[1].link).toBe('https://atom.example.com/b');
    expect(parsed.items[1].summary).toBe('直接在 content 里的正文。');
    expect(parsed.items[1].published).toBe(Date.parse('2026-10-29T09:00:00Z'));
  });

  test('garbage is not a feed, and broken dates sink to 0 instead of throwing', () => {
    expect(xml.parseFeed('<html><body>不是订阅源</body></html>').kind).toBe('');
    const bad = xml.parseFeed(RSS_SAMPLE.replace('Mon, 26 Oct 2026 08:00:00 GMT', '不是日期'));
    expect(bad.items[0].published).toBe(0);
  });

  test('excerpt truncates long bodies and keeps the title first', () => {
    const item = { title: '标题', summary: '细'.repeat(1000) };
    const body = xml.excerpt(item, 50);
    expect(body.startsWith('标题。')).toBe(true);
    expect(body.endsWith('…')).toBe(true);
    // 50 字正文 + 标题前缀 + 省略号，总长受控。
    expect(body.length).toBeLessThanOrEqual(4 + 50);
  });
});

describe('digest prompt', () => {
  let digest;
  beforeAll(async () => {
    const api = await mountIsolated();
    digest = api.digest;
  });

  test('the prompt numbers each item and the system asks for exactly 3 sentences', () => {
    const items = [
      { title: 'A', summary: 'a 的正文' },
      { title: 'B', summary: 'b 的正文' },
    ];
    const prompt = digest.buildDigestPrompt(items, 600);
    expect(prompt).toContain('[1] A。a 的正文');
    expect(prompt).toContain('[2] B。b 的正文');
    expect(digest.DIGEST_SYSTEM).toContain('3 句话');
    expect(digest.DIGEST_SYSTEM).toContain('桌宠');
  });
});

// --- 行为部分：jsdom 里驱动真实链路 ---------------------------------------------

let store;
let configValues;
let fetchBodies;
let callCalls;
let callReplies;
let answered;
let postedFrom;
let windowListeners;
let intervals;
let timeouts;

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

function callReplyFor(payload) {
  if (callReplies.length) {
    const next = callReplies.shift();
    return typeof next === 'function' ? next(payload) : next;
  }
  return { text: '第一条新闻说的是 A。第二条讲的是 B。第三条值得你注意。' };
}

async function pump(maxRounds = 200) {
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
          answer(req.id, { ok: true });
          break;
        case 'net.fetch': {
          const body = fetchBodies.get(String(payload.url)) || '<html>not a feed</html>';
          answer(req.id, { status: 200, body });
          break;
        }
        case 'plugin.call': {
          callCalls.push(payload);
          const reply = callReplyFor(payload);
          // 队列里放 Error = 这一步要失败（如 memcore 未安装、语音引擎没开）。
          if (reply instanceof Error) answer(req.id, null, { ok: false, error: reply.message });
          else answer(req.id, reply);
          break;
        }
        case 'bubble.say':
          answer(req.id, { ok: true });
          break;
        case 'share.set':
          answer(req.id, { ok: true, key: `${PLUGIN_ID}/${payload.name}` });
          break;
        default:
          answer(req.id, null, { ok: false, error: `本程序不支持该方法 ${req.method}` });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const macro = () => new Promise((resolve) => setTimeout(resolve, 0));

function loadApp() {
  answered = new Set();
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  for (const id of intervals) clearInterval(id);
  intervals = [];
  for (const id of timeouts) clearTimeout(id);
  timeouts = [];
  postedFrom = window.postMessage.mock.calls.length;
  // eslint-disable-next-line no-new-func
  new Function(source)();
}

function boot(slot = 'background') {
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
  loadApp();
  hostSends({
    v: 1, type: 'init', pluginId: PLUGIN_ID, permissions: manifest.permissions,
    granted: [...manifest.permissions], surface: { kind: 'panel', slot },
  });
  return macro();
}

function callFetchNow(payload = {}, method = 'fetch_now') {
  const before = byType('call-result').length;
  const ticket = `t-${Math.random().toString(36).slice(2, 8)}`;
  hostSends({ v: 1, type: 'call', ticket, from: MEMCORE_ID, method, payload });
  return () => {
    const list = byType('call-result').slice(before);
    expect(list.length, 'fetch_now 一直没有回包（call-result 缺失）').toBeGreaterThan(0);
    return list[list.length - 1];
  };
}

/** 并发跑一次晨报循环：循环内部的 net.fetch / plugin.call / storage 都要有人答，
 * 而且答完还会引发下一批（digest/history 是最后一个读）——所以要泵到完全安静。 */
async function runCycle() {
  const p = window.__rss.runDigestCycle();
  let settled = false;
  p.finally(() => { settled = true; });
  for (let i = 0; i < 40 && !settled; i += 1) {
    await pump(8);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return p;
}

/** boot 之后把启动期的 config.get 泵安静：onInit 的 refreshConfig 是异步的。 */
async function bootSettled(slot = 'background') {
  await boot(slot);
  await pump(8);
}

beforeEach(() => {
  store = new Map();
  configValues = {
    feedUrls: 'https://news.example.com/rss.xml\nhttps://atom.example.com/feed.xml',
    intervalMin: '120',
    maxItems: '5',
    digestChars: '600',
    speakDigest: 'true',
    bubbleDigest: 'true',
    timeoutSec: '5',
  };
  fetchBodies = new Map([
    ['https://news.example.com/rss.xml', RSS_SAMPLE],
    ['https://atom.example.com/feed.xml', ATOM_SAMPLE],
  ]);
  callCalls = [];
  callReplies = [];
  windowListeners = [];
  intervals = [];
  timeouts = [];
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
  const originalTimeout = window.setTimeout.bind(window);
  vi.spyOn(window, 'setTimeout').mockImplementation((fn, ms) => {
    const id = originalTimeout(fn, ms);
    timeouts.push(id);
    return id;
  });
  vi.spyOn(window, 'postMessage').mockImplementation(() => {});
});

afterEach(() => {
  for (const id of intervals) clearInterval(id);
  for (const id of timeouts) clearTimeout(id);
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  vi.restoreAllMocks();
});

describe('the digest cycle', () => {
  test('first run: all items are new; the model gets a numbered prompt and answers into the digest', async () => {
    await bootSettled();
    const result = await runCycle();

    expect(result.feeds).toHaveLength(2);
    expect(result.feeds.every((f) => f.status === 'ok')).toBe(true);
    expect(result.freshCount).toBe(5); // 3 (rss) + 2 (atom)
    expect(result.prompt).toContain('[1]');
    expect(result.headline).toContain('第一条新闻');

    // 模型调用走 memcore/chat，带晨报专用会话。
    expect(callCalls[0].target).toBe(MEMCORE_ID);
    expect(callCalls[0].method).toBe('chat');
    expect(callCalls[0].payload.roleId).toBe('rss-morning');

    // 语音与气泡都被触发。
    const speak = callCalls.find((c) => c.target === VOICE_ID);
    expect(speak, '晨报没有交给语音插件').toBeTruthy();
    expect(speak.method).toBe('speak');
    expect(speak.payload.text).toBe(result.headline);
    const bubble = requests().find((r) => r.method === 'bubble.say');
    expect(bubble, '晨报没有弹气泡').toBeTruthy();
    expect(bubble.payload.text).toContain('晨报：');

    // 历史与快照。
    const saved = JSON.parse(store.get('digest/last'));
    expect(saved.headline).toBe(result.headline);
    const shareMsg = requests().find((r) => r.method === 'share.set' && r.payload.name === 'rss-last-digest');
    expect(shareMsg).toBeTruthy();
  });

  test('second run with unchanged feeds: nothing is new, and the model is never asked', async () => {
    await bootSettled();
    await runCycle();
    const callsAfterFirst = callCalls.length;

    const result = await runCycle();
    expect(result.freshCount).toBe(0);
    expect(result.headline).toContain('没有新内容');
    expect(callCalls.length).toBe(callsAfterFirst);
    // 记录里也安静。
    expect(callCalls.filter((c) => c.target === VOICE_ID)).toHaveLength(1);
  });

  test('a dead feed is reported per-feed and the healthy feed still digests', async () => {
    fetchBodies.set('https://news.example.com/rss.xml', '<html>502 page</html>');
    await bootSettled();
    const result = await runCycle();
    const dead = result.feeds.find((f) => f.url === 'https://news.example.com/rss.xml');
    const alive = result.feeds.find((f) => f.url === 'https://atom.example.com/feed.xml');
    expect(dead.status).toBe('error');
    expect(dead.error).toContain('RSS/Atom');
    expect(alive.status).toBe('ok');
    expect(result.freshCount).toBe(2);

    // 源状态被记进列表，面板能看到那句话。
    const list = JSON.parse(store.get('feeds/list'));
    const deadEntry = list.find((f) => f.url === 'https://news.example.com/rss.xml');
    expect(deadEntry.lastStatus).toBe('error');
    expect(deadEntry.lastError).toContain('RSS/Atom');
  });

  test('a model timeout races to a fixable Chinese error (withTimeout, unit level)', async () => {
    await boot();
    // 真实链路里 askDigest 的预算来自 timeoutSec 配置；这里是 withTimeout 的单元断言：
    // 一个永不完成的 promise 在预算内被"等 X 超时"的中文打断。
    const never = new Promise(() => {});
    const raced = window.__rss.digest.withTimeout(never, 50, '等记忆核心总结');
    await expect(raced).rejects.toThrow('等记忆核心总结超时');
  });

  test('a model failure inside the cycle leaves a trace in digest/last and rethrows', async () => {
    await bootSettled();
    // 模型那一步直接被拒（例如 memcore 未安装）：循环失败，但痕迹已经留下。
    // rejects 是接住的：await expect(...) 本身消费了拒绝；再让 saveLastDigest 的
    // 写盘拍完（它发生在 rethrow 之后的 finally 里）需要继续泵——下面用 settled 循环等。
    callReplies.push(new Error('问不到 com.shixiansi.plugin-memcore'));
    const p = window.__rss.runDigestCycle();
    let settled = false;
    let rejected = null;
    p.then(() => {}, (err) => { rejected = err; settled = true; });
    for (let i = 0; i < 40 && !settled; i += 1) {
      await pump(8);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(rejected && rejected.message).toContain('问不到');
    const saved = JSON.parse(store.get('digest/last'));
    expect(saved.headline).toContain('总结失败');
  });

  test('a voice failure does not kill the digest (spoken: false, headline still saved)', async () => {
    await bootSettled();
    callReplies.push(() => ({ text: '晨报正文。' }));           // memcore/chat
    callReplies.push(new Error('语音服务未运行，请先自行启动'));   // voice/speak
    const result = await runCycle();
    expect(result.headline).toBe('晨报正文。');
    expect(result.spoken).toBe(false);
    const saved = JSON.parse(store.get('digest/last'));
    expect(saved.headline).toBe('晨报正文。');
  });

  test('no feeds configured: a quiet digest, no model call', async () => {
    configValues = { ...configValues, feedUrls: '' };
    await bootSettled();
    const result = await runCycle();
    expect(result.feeds).toHaveLength(0);
    expect(result.headline).toContain('没有新内容');
    expect(callCalls).toHaveLength(0);
  });
});

describe('fetch_now and the protocol', () => {
  test('fetch_now answers {at, freshCount, feeds, headline, spoken}', async () => {
    await bootSettled();
    const packetP = (function () {
      const before = byType('call-result').length;
      hostSends({ v: 1, type: 'call', ticket: 't-fn', from: MEMCORE_ID, method: 'fetch_now', payload: {} });
      return () => {
        const list = byType('call-result').slice(before);
        expect(list.length, 'fetch_now 一直没有回包').toBeGreaterThan(0);
        return list[list.length - 1];
      };
    })();
    let settled = false;
    const cycle = window.__rss.runDigestCycle().catch(() => {}).finally(() => { settled = true; });
    void cycle;
    for (let i = 0; i < 40 && !settled; i += 1) {
      await pump(5);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const packet = packetP();
    expect(packet.ok).toBe(true);
    expect(packet.result.freshCount).toBe(5);
    expect(packet.result.feeds).toHaveLength(2);
    expect(packet.result.headline).toContain('第一条新闻');
    expect(packet.result.spoken).toBe(true);
  });

  test('unknown call method: answered with an error, never silence', async () => {
    await bootSettled();
    const getResult = callFetchNow({}, 'fetch_all');
    await pump(10);
    const packet = getResult();
    expect(packet.ok).toBe(false);
    expect(packet.error).toContain('fetch_now');
  });

  test('every request has a unique non-empty id within one mount; says ready first', async () => {
    await bootSettled();
    // 直接并发驱动一次循环（不走 callFetchNow 的取包函数——它的断言写死了"必须回包"，
    // 而这里的重点是 id 唯一性与 ready 顺序）。
    let settled = false;
    void window.__rss.runDigestCycle().catch(() => {}).finally(() => { settled = true; });
    for (let i = 0; i < 40 && !settled; i += 1) {
      await pump(8);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const ids = requests().map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);

    // ready 先发；init 之前没有任何请求（第二次加载后立刻断言，与请求计数互不污染）。
    const parsed = new JSDOM(html);
    document.body.innerHTML = parsed.window.document.body.innerHTML;
    loadApp();
    const first = posted()[0];
    expect(first && first.type).toBe('ready');
  });

  test('adding a feed validates the URL and records it; garbage is rejected with Chinese', async () => {
    await bootSettled();
    const feeds = window.__rss.feeds;
    expect(() => feeds.cleanFeedUrl('ftp://x.example/feed.xml')).toThrow('http(s)');
    expect(() => feeds.cleanFeedUrl('not a url')).toThrow('URL');
    expect(feeds.cleanFeedUrl('https://x.example/feed.xml?a=1')).toBe('https://x.example/feed.xml?a=1');
  });
});
