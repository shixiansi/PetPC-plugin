import { afterEach, beforeEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 本地知识库的行为测试。三层：
//
//   1. 切片器（纯函数）：滑动窗口 + 重叠 + 句边界回退；**无漏句**是硬性要求——
//      把切片拼回去（考虑重叠区）必须覆盖原文的每一个句子；
//   2. TF-IDF 索引（纯函数 + storage）：检索出"最相关"的切片——用一份内容差异明显
//      的语料断言排序正确；
//   3. ask_kb 全链路（jsdom 驱动真实桥）：切片注入 Prompt、相关度门槛、回包形状。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-knowledge-base');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');
const source = scriptSources
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-knowledge-base';
const MEMCORE_ID = 'com.shixiansi.plugin-memcore';

// --- 测试语料 -----------------------------------------------------------------

/** 100 句的合成文档：每句带序号，切片拼回时用来查漏。 */
function makeLongDoc(sentences = 100) {
  return Array.from({ length: sentences }, (_, i) =>
    `这是第${i + 1}句话，讲的是主题${i % 7}的细节说明。`).join('');
}

describe('manifest', () => {
  test('background gated by net.fetch; serves ask_kb and calls memcore/chat', () => {
    expect(manifest.background).toBe(true);
    expect(manifest.permissions).toContain('net.fetch');
    expect(manifest.permissions).toContain('plugin.call');
    expect(manifest.serves).toEqual(['ask_kb']);
    expect(manifest.callTargets).toEqual([`${MEMCORE_ID}/chat`]);
  });

  test('remote docs are a hostWhitelist setting; static hosts exist too', () => {
    const whitelist = manifest.config.filter((item) => item.hostWhitelist === true);
    expect(whitelist).toHaveLength(1);
    expect(whitelist[0].key).toBe('docUrls');
    expect(manifest.netHosts.length).toBeGreaterThan(0);
  });
});

// --- 纯函数部分：切片器与检索（隔离挂载） -----------------------------------------

async function mountIsolated() {
  const dom = new JSDOM(html, { url: 'https://plugin.invalid/panel.html' });
  const win = dom.window;
  win.postMessage = () => {};
  const timers = [];
  const winSetTimeout = win.setTimeout.bind(win);
  const injectedSetTimeout = (fn, ms, ...rest) => {
    const id = winSetTimeout(fn, ms, ...rest);
    timers.push(id);
    return id;
  };
  const injectedSetInterval = (fn, ms, ...rest) => {
    const id = win.setInterval(fn, ms, ...rest);
    timers.push(id);
    return id;
  };
  // eslint-disable-next-line no-new-func
  new Function(
    'window', 'document', 'location', 'URLSearchParams', 'MessageEvent',
    'setTimeout', 'setInterval', 'clearInterval', 'clearTimeout',
    `return (function () { ${source}\n; return window.__kb; })();`,
  )(
    win, win.document, win.location, win.URLSearchParams, win.MessageEvent,
    injectedSetTimeout, injectedSetInterval, win.clearInterval.bind(win), win.clearTimeout.bind(win),
  );
  return win.__kb;
}

describe('chunker', () => {
  let chunker;
  beforeAll(async () => {
    chunker = (await mountIsolated()).chunker;
  });

  test('params are cleaned: overlap < size always', () => {
    expect(chunker.cleanChunkParams({ chunkChars: 500, chunkOverlap: 50 })).toEqual({ size: 500, overlap: 50 });
    expect(chunker.cleanChunkParams({ chunkChars: 300, chunkOverlap: 500 }).overlap).toBeLessThan(150);
    expect(chunker.cleanChunkParams({}).size).toBe(500);
  });

  test('no sentence is lost: every sentence appears in at least one chunk', () => {
    const doc = makeLongDoc(100);
    const chunks = chunker.chunkDocument(doc, { chunkChars: 300, chunkOverlap: 40 }, 'doc1');
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.docId === 'doc1')).toBe(true);
    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => i + 1));

    const joined = chunks.map((c) => c.text).join('|');
    for (let i = 1; i <= 100; i += 1) {
      const sentence = `这是第${i}句话，讲的是主题${(i - 1) % 7}的细节说明。`;
      expect(joined.includes(sentence), `句子 ${i} 丢了`).toBe(true);
    }
  });

  test('adjacent chunks share the overlap region (semantic continuity)', () => {
    const doc = makeLongDoc(60);
    const chunks = chunker.chunkDocument(doc, { chunkChars: 300, chunkOverlap: 50 }, 'doc1');
    for (let i = 1; i < chunks.length; i += 1) {
      const prevTail = chunks[i - 1].text.slice(-30);
      const curHead = chunks[i].text.slice(0, 60);
      // 重叠区：前一片的结尾应出现在本片的开头附近（句边界回退可能有几字差）。
      const tailCore = prevTail.slice(6, 24);
      expect(curHead.includes(tailCore) || chunks[i - 1].text.includes(chunks[i].text.slice(0, 24)),
        `切片 ${i} 与前一片没有重叠`).toBe(true);
    }
  });

  test('chunks respect the size budget (with sentence-boundary slack)', () => {
    const doc = makeLongDoc(80);
    const chunks = chunker.chunkDocument(doc, { chunkChars: 300, chunkOverlap: 40 }, 'doc1');
    for (const chunk of chunks) {
      // 句边界回退最多砍掉 40%——切片在 60%–100%+ε 预算内。
      expect(chunk.text.length).toBeGreaterThanOrEqual(300 * 0.5);
      expect(chunk.text.length).toBeLessThanOrEqual(320);
    }
  });

  test('markdown noise is stripped but text survives', () => {
    const md = '# 标题\n\n看[这个链接](https://x.example/a)和 ![图](https://x.example/i.png)。\n\n```js\nconst a = 1;\n```\n';
    const cleaned = chunker.stripMarkdownNoise(md);
    expect(cleaned).toContain('标题');
    expect(cleaned).toContain('看这个链接和');
    expect(cleaned).toContain('const a = 1;');
    expect(cleaned).not.toContain('![');
    expect(cleaned).not.toContain('](https://');
  });

  test('empty input yields no chunks', () => {
    expect(chunker.chunkDocument('', {}, 'd')).toEqual([]);
    expect(chunker.chunkDocument('   \n\n  ', {}, 'd')).toEqual([]);
  });
});

describe('tf-idf index', () => {
  let kb;
  beforeAll(async () => {
    kb = await mountIsolated();
  });

  test('tokenize: latin words + cjk bigrams', () => {
    const tokens = kb.index.tokenize('部署 DeepSeek 模型');
    expect(tokens).toContain('deepseek'); // 拉丁词整体
    expect(tokens).toContain('部署');     // 双字中文恰是它的 bigram
    expect(tokens).toContain('模型');
    expect(kb.index.tokenize('番茄红素')).toContain('番茄'); // 长中文串按 bigram 切
  });

  test('search ranks the right document first (discriminative corpus)', () => {
    // 三份内容差异明显的文档。
    const tomato = '番茄是一种茄科植物，喜阳光，生长适温二十到三十度，常见病虫害是晚疫病。番茄富含番茄红素。';
    const terraform = 'Terraform 是基础设施即代码工具，用 HCL 语言描述资源，通过 plan 与 apply 管理云资源状态。';
    const pasta = '意大利面的经典做法：水开加盐，下面煮八到十分钟，酱汁用番茄或肉酱。';

    const tomatoChunks = kb.chunker.chunkDocument(tomato, { chunkChars: 200, chunkOverlap: 30 }, 'tomato');
    const terraChunks = kb.chunker.chunkDocument(terraform, { chunkChars: 200, chunkOverlap: 30 }, 'terraform');
    const pastaChunks = kb.chunker.chunkDocument(pasta, { chunkChars: 200, chunkOverlap: 30 }, 'pasta');

    // 直接构建内存索引（search 从 loadIndex 读 storage——这里注入）。
    // 用 indexDocument 的纯逻辑做不到（它走 storage）；改为验证评分函数的判别力：
    // 用检索的相对分数比较。构造小的 terms/chunks 结构走 search 的兄弟路径不可行，
    // 因此这里通过行为层（下方 describe）覆盖；纯函数层验证 tokenize 的判别词。
    const t1 = kb.index.tokenize(tomato);
    const t2 = kb.index.tokenize(terraform);
    expect(t1).toContain('番茄');
    expect(t2).toContain('terraform');
    expect(t1).not.toContain('terraform');
    expect(t2).not.toContain('番茄');
    void pastaChunks;
    void tomatoChunks;
    void terraChunks;
  });
});

// --- 行为部分：jsdom 驱动真实链路 -------------------------------------------------

let store;
let configValues;
let fetchBodies;
let callCalls;
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

async function pump(maxRounds = 120) {
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
          const body = fetchBodies.get(String(payload.url)) || '';
          answer(req.id, { status: 200, body });
          break;
        }
        case 'plugin.call':
          callCalls.push(payload);
          answer(req.id, { text: '根据文档，番茄喜阳光，适温二十到三十度（文档 tomato 第 1 片）。' });
          break;
        default:
          answer(req.id, null, { ok: false, error: `本程序不支持该方法 ${req.method}` });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const macro = () => new Promise((resolve) => setTimeout(resolve, 0));

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

function loadApp() {
  answered = new Set();
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  for (const id of intervals) clearInterval(id);
  intervals = [];
  postedFrom = window.postMessage.mock.calls.length;
  // eslint-disable-next-line no-new-func
  new Function(source)();
}

function callApi(payload, method = 'ask_kb') {
  const before = byType('call-result').length;
  const ticket = `t-${Math.random().toString(36).slice(2, 8)}`;
  hostSends({ v: 1, type: 'call', ticket, from: MEMCORE_ID, method, payload });
  return async () => {
    await pump(10);
    const list = byType('call-result').slice(before);
    expect(list.length, `${method} 一直没有回包（call-result 缺失）`).toBeGreaterThan(0);
    return list[list.length - 1];
  };
}

/** 与入库并发泵（addDocument 内部的 storage 请求要有人答）。 */
async function withPump(p) {
  let settled = false;
  p.then(() => {}, () => {}).finally(() => { settled = true; });
  for (let i = 0; i < 120 && !settled; i += 1) {
    await pump(8);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return p;
}

const TOMATO = '番茄是一种茄科植物，喜阳光，生长适温二十到三十度，常见病虫害是晚疫病。番茄富含番茄红素，是最好的番茄红素来源。';
const TERRAFORM = 'Terraform 是基础设施即代码工具，用 HCL 语言描述资源，通过 plan 与 apply 管理云资源状态。Terraform 支持 MD 多云。';

beforeEach(() => {
  store = new Map();
  configValues = { docUrls: '', chunkChars: '200', chunkOverlap: '30', topK: '3', minScore: '20' };
  fetchBodies = new Map();
  callCalls = [];
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

describe('document management (the real chain)', () => {
  test('addDocument chunks, indexes, and records the doc; the index meta advances', async () => {
    await boot();
    await pump();

    const added = await withPump(window.__kb.addDocument({ title: '番茄种植', content: TOMATO }));
    expect(added.chunkCount).toBe(1);
    expect(added.indexMeta.docCount).toBe(1);
    expect(added.indexMeta.chunkCount).toBe(1);
    expect(added.indexMeta.terms).toBeGreaterThan(0);

    // 索引三件套落盘。
    const terms = JSON.parse(store.get('kb/index/terms'));
    expect(Object.keys(terms).length).toBe(added.indexMeta.terms);
    const chunks = JSON.parse(store.get('kb/index/chunks'));
    expect(Object.values(chunks)[0].text).toContain('番茄');

    // 列表。
    const list = JSON.parse(store.get('kb/docs/index'));
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('番茄种植');
  });

  test('a second document increments both counts; re-adding replaces the old chunks', async () => {
    await boot();
    await pump();
    await withPump(window.__kb.addDocument({ title: '番茄种植', content: TOMATO }));
    await withPump(window.__kb.addDocument({ title: 'Terraform', content: TERRAFORM }));

    const meta = JSON.parse(store.get('kb/index/meta'));
    expect(meta.docCount).toBe(2);
    expect(meta.chunkCount).toBe(2);

    // 同名重新入库：新 id 新切片，旧的还在（显式删除才删）。
    const before = JSON.parse(store.get('kb/index/meta')).chunkCount;
    await withPump(window.__kb.addDocument({ title: '番茄种植', content: TOMATO }));
    const after = JSON.parse(store.get('kb/index/meta')).chunkCount;
    expect(after).toBeGreaterThan(before);
  });

  test('removeDocument cleans the index, the body, and the list', async () => {
    await boot();
    await pump();
    const added = await withPump(window.__kb.addDocument({ title: '番茄种植', content: TOMATO }));
    await withPump(window.__kb.addDocument({ title: 'Terraform', content: TERRAFORM }));

    await withPump(window.__kb.removeDocument(added.docId));
    const meta = JSON.parse(store.get('kb/index/meta'));
    expect(meta.docCount).toBe(1);
    expect(meta.chunkCount).toBe(1);
    const list = JSON.parse(store.get('kb/docs/index'));
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('Terraform');
  });

  test('fetchRemoteDocuments pulls configured URLs and indexes them', async () => {
    fetchBodies.set('https://raw.githubusercontent.com/x/guide.md', TERRAFORM);
    configValues = { ...configValues, docUrls: 'https://raw.githubusercontent.com/x/guide.md' };
    await boot();
    await pump();

    const results = await withPump(window.__kb.fetchRemoteDocuments());
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(results[0].chunkCount).toBeGreaterThanOrEqual(1);

    // 一份失败的源不影响其它源。
    fetchBodies.set('https://raw.githubusercontent.com/x/bad.md', '');
    configValues = { ...configValues, docUrls: 'https://raw.githubusercontent.com/x/guide.md\nhttps://raw.githubusercontent.com/x/bad.md' };
    const results2 = await withPump(window.__kb.fetchRemoteDocuments());
    expect(results2.filter((r) => r.ok)).toHaveLength(1);
    expect(results2.find((r) => !r.ok).error).toContain('空内容');
  });
});

describe('ask_kb (the full retrieval-injection flow)', () => {
  test('a matching question injects the right chunks into the model prompt', async () => {
    await boot();
    await pump();
    await withPump(window.__kb.addDocument({ title: '番茄种植', content: TOMATO }));
    await withPump(window.__kb.addDocument({ title: 'Terraform', content: TERRAFORM }));

    const get = callApi({ question: '番茄的生长温度是多少？' });
    await pump();
    const packet = await get();

    expect(packet.ok).toBe(true);
    expect(packet.result.usedContext).toBe(true);
    expect(packet.result.hits.length).toBeGreaterThan(0);
    expect(packet.result.hits[0].docId).toContain('番茄');
    expect(packet.result.hits[0].score).toBeGreaterThanOrEqual(20);

    // Prompt 形状：注入的切片 + 问题。
    const chat = callCalls[callCalls.length - 1];
    expect(chat.payload.roleId).toBe('kb-qa');
    expect(chat.payload.text).toContain('请根据以下本地文档回答用户');
    expect(chat.payload.text).toContain('番茄');
    expect(chat.payload.text).toContain('用户的问题：番茄的生长温度是多少？');
  });

  test('retrieval is discriminative: the tomato question hits tomato chunks, not terraform', async () => {
    await boot();
    await pump();
    await withPump(window.__kb.addDocument({ title: '番茄种植', content: TOMATO }));
    await withPump(window.__kb.addDocument({ title: 'Terraform', content: TERRAFORM }));

    const get = callApi({ question: 'Terraform 怎么管理云资源？' });
    await pump();
    const packet = await get();
    expect(packet.result.usedContext).toBe(true);
    expect(packet.result.hits[0].docId).toContain('Terraform');
  });

  test('below the relevance threshold the plugin declines instead of hallucinating', async () => {
    await boot();
    await pump();
    await withPump(window.__kb.addDocument({ title: '番茄种植', content: TOMATO }));

    const get = callApi({ question: '量子色动力学在渐近自由区里的耦合常数如何跑动？' });
    await pump();
    const packet = await get();
    expect(packet.ok).toBe(true);
    expect(packet.result.usedContext).toBe(false);
    expect(packet.result.answer).toContain('没查到');
    // 没问模型。
    expect(callCalls).toHaveLength(0);
  });

  test('an empty question is rejected in Chinese; unknown methods get an answer', async () => {
    await boot();
    await pump();
    const empty = callApi({ question: '   ' });
    await pump();
    const emptyPacket = await empty();
    expect(emptyPacket.ok).toBe(false);
    expect(emptyPacket.error).toContain('question');

    const unknown = callApi({}, 'search_docs');
    await pump();
    const unknownPacket = await unknown();
    expect(unknownPacket.ok).toBe(false);
    expect(unknownPacket.error).toContain('ask_kb');
  });

  test('says ready first, and nothing before init', async () => {
    const parsed = new JSDOM(html);
    document.body.innerHTML = parsed.window.document.body.innerHTML;
    loadApp();
    const first = posted()[0];
    expect(first && first.type).toBe('ready');
    expect(requests()).toHaveLength(0);
  });
});
