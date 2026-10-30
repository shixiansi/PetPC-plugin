import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 三个文档一条链：**接入端 → 记忆核心 → 联网搜索**。
//
// memcore 自己的测试证明「它按我以为的形状问模型」；websearch 自己的测试证明「它按引擎的
// 形状发请求」。这个文件证明的是中间那件事：当记忆答不上时，核心真的会向搜索插件要资料、
// 把资料拼进第二次提问，并把"用了搜索"如实带在 meta 里；搜索插件不在 / 没配好时，回答
// 照常返回——联网是增强，不是依赖。
//
// 闸门按 manifest 的声明做：memcore 的 callTargets 必须点名 <websearch>/search，
// websearch 的 serves 必须有 search——一条声明写错，这条用例直接红。

const here = path.dirname(fileURLToPath(import.meta.url));
const CORE_DIR = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-memcore');
const SEARCH_DIR = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-websearch');

const CORE_ID = 'com.shixiansi.plugin-memcore';
const SEARCH_ID = 'com.shixiansi.plugin-websearch';

const coreManifest = JSON.parse(readFileSync(path.join(CORE_DIR, 'manifest.json'), 'utf8'));
const searchManifest = JSON.parse(readFileSync(path.join(SEARCH_DIR, 'manifest.json'), 'utf8'));

function readSources(dir) {
  const html = readFileSync(path.join(dir, 'panel.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
    .map((m) => m[1])
    .filter((src) => src && !src.startsWith('http'));
  if (!scripts.length) throw new Error(`${dir} 的 panel.html 没有加载任何插件脚本`);
  return {
    html,
    source: scripts.map((src) => readFileSync(path.join(dir, src), 'utf8')).join('\n'),
  };
}

const coreBundle = readSources(CORE_DIR);
const searchBundle = readSources(SEARCH_DIR);

/** 装一份插件文档到它自己的 window（等于宿主建的那个 iframe）。 */
function makeDoc(id, bundle, { slot, config, granted }) {
  const dom = new JSDOM(bundle.html, { runScripts: 'outside-only', url: 'http://plugin.test/panel.html' });
  const w = dom.window;
  w.parent = w;
  const inbox = [];
  w.postMessage = (msg) => inbox.push(msg);
  const listeners = [];
  const add = w.addEventListener.bind(w);
  w.addEventListener = (type, fn, opts) => {
    listeners.push([type, fn, opts]);
    return add(type, fn, opts);
  };
  const intervals = [];
  const interval = w.setInterval.bind(w);
  w.setInterval = (fn, ms) => {
    const hook = interval(fn, ms);
    intervals.push(hook);
    return hook;
  };
  w.eval(bundle.source);
  w.dispatchEvent(new w.MessageEvent('message', {
    data: {
      v: 1, type: 'init', pluginId: id, permissions: (coreManifest.id === id ? coreManifest : searchManifest).permissions,
      granted, surface: { kind: 'panel', slot },
    },
    source: w,
  }));
  return {
    w, dom, inbox, slot, storage: new Map(), config,
    send(data) {
      w.dispatchEvent(new w.MessageEvent('message', { data, source: w }));
    },
    close() {
      for (const [type, fn, opts] of listeners) w.removeEventListener(type, fn, opts);
      for (const id2 of intervals) clearInterval(id2);
      w.close();
    },
  };
}

// --- fake host ---------------------------------------------------------------

let core;
let search;
let llmCalls;
/** 按队列取的模型回答（取完用 fallback）。 */
let llmReplies;
/** 每一次发往搜索引擎插件的 net.fetch（websearch 那一侧）。 */
let searchFetches;
/** 每次 plugin.call 的目标（`<id>/<method>`），按调用顺序——后备链的用例靠它断言。 */
let callTargets;
/** 搜索引擎应答（按队列；函数形式按请求算）。 */
let engineReplies;
let answered;

function makeCore() {
  return makeDoc(CORE_ID, coreBundle, {
    slot: 'background',
    config: {
      personaName: '小记', persona: '', replyMaxChars: '240', bufferTurns: '8',
      summaryChars: '500', episodeMax: '40', profileEvery: '3',
      webSearch: 'auto', webSearchCount: '3', llmDailyBudget: '200',
    },
    granted: [...coreManifest.permissions],
  });
}

function makeSearch() {
  return makeDoc(SEARCH_ID, searchBundle, {
    slot: 'background',
    config: {
      engine: 'searxng', searxngUrl: 'http://127.0.0.1:8888',
      tavilyApiKey: '', bingKey: '', resultCount: '3', cacheTtlMin: '0', maxHistory: '10',
    },
    granted: [...searchManifest.permissions],
  });
}

function engineReplyFor(payload) {
  if (engineReplies.length) {
    const next = engineReplies.shift();
    return typeof next === 'function' ? next(payload) : next;
  }
  return { status: 200, body: '{"results":[]}' };
}

function answerRequest(doc, req) {
  const payload = req.payload || {};
  const storage = doc.storage;
  switch (req.method) {
    case 'config.get':
      doc.send({ v: 1, type: 'response', id: req.id, ok: true, result: { values: doc.config, secrets: {} } });
      return;
    case 'storage.get':
      doc.send({ v: 1, type: 'response', id: req.id, ok: true, result: { value: storage.has(String(payload.key)) ? storage.get(String(payload.key)) : '' } });
      return;
    case 'storage.set':
      storage.set(String(payload.key), String(payload.value || ''));
      doc.send({ v: 1, type: 'response', id: req.id, ok: true, result: { ok: true } });
      return;
    case 'storage.remove':
      storage.delete(String(payload.key));
      doc.send({ v: 1, type: 'response', id: req.id, ok: true, result: { removed: true } });
      return;
    case 'storage.list':
      doc.send({ v: 1, type: 'response', id: req.id, ok: true, result: { dir: 'C:\\data', files: [], dirs: [] } });
      return;
    case 'llm.chat':
      llmCalls.push(payload);
      {
        const reply = llmReplies.length ? llmReplies.shift() : '（模拟回答）';
        doc.send({ v: 1, type: 'response', id: req.id, ok: true, result: { requestId: 'sim', text: reply } });
      }
      return;
    case 'net.fetch':
      searchFetches.push(payload);
      doc.send({ v: 1, type: 'response', id: req.id, ok: true, result: engineReplyFor(payload) });
      return;
    case 'plugin.call': {
      const target = String(payload.target || '');
      callTargets.push(`${target}/${String(payload.method || '')}`);
      const method = String(payload.method || '');
      const declared = Array.isArray(coreManifest.callTargets) ? coreManifest.callTargets : [];
      if (!declared.includes(`${target}/${method}`)) {
        doc.send({
          v: 1, type: 'response', id: req.id, ok: false,
          error: `插件 ${CORE_ID} 没有声明要调用 ${target}/${method}：manifest 的 callTargets 里没有这一项`,
        });
        return;
      }
      if (target !== SEARCH_ID) {
        doc.send({ v: 1, type: 'response', id: req.id, ok: false, error: `问不到 ${target}` });
        return;
      }
      const serves = Array.isArray(searchManifest.serves) ? searchManifest.serves : [];
      if (!search || !serves.includes(method)) {
        doc.send({ v: 1, type: 'response', id: req.id, ok: false, error: 'plugin.call 的目标插件未启用' });
        return;
      }
      const ticket = `tkt-${answered.calls.size + 1}`;
      answered.calls.set(ticket, { doc, id: req.id });
      search.send({ v: 1, type: 'call', ticket, from: CORE_ID, method, payload: payload.payload });
      return;
    }
    default:
      doc.send({ v: 1, type: 'response', id: req.id, ok: false, error: `本程序不支持该方法 ${req.method}` });
  }
}

const macro = () => new Promise((resolve) => setTimeout(resolve, 0));

function round() {
  let acted = 0;
  for (const doc of [core, search]) {
    if (!doc) continue;
    for (const msg of doc.inbox) {
      if (!msg || msg.type !== 'request') continue;
      const key = `${doc === core ? 'core' : 'search'}:${msg.id}`;
      if (answered.requests.has(key)) continue;
      answered.requests.add(key);
      acted += 1;
      answerRequest(doc, msg);
    }
  }
  for (const doc of [search, core]) {
    if (!doc) continue;
    for (const msg of doc.inbox) {
      if (!msg || msg.type !== 'call-result') continue;
      const waiter = answered.calls.get(msg.ticket);
      if (!waiter) continue;
      answered.calls.delete(msg.ticket);
      acted += 1;
      if (msg.ok) waiter.doc.send({ v: 1, type: 'response', id: waiter.id, ok: true, result: msg.result });
      else waiter.doc.send({ v: 1, type: 'response', id: waiter.id, ok: false, error: msg.error });
    }
  }
  return acted;
}

async function pump(maxRounds = 80) {
  let idle = 0;
  for (let i = 0; i < maxRounds; i += 1) {
    const acted = round();
    await macro();
    if (acted === 0) {
      idle += 1;
      if (idle >= 3) return;
    } else {
      idle = 0;
    }
  }
}

function bootDocs({ withSearch = true } = {}) {
  core = makeCore();
  search = withSearch ? makeSearch() : null;
  if (core) core.send({ v: 1, type: 'noop' });
}

/** 通过核心的 chat 方法跑一轮（等同接入端问了一次）。 */
async function chat(text) {
  const ticket = 'chat-1';
  core.send({ v: 1, type: 'call', ticket, from: 'test-adapter', method: 'chat', payload: { roleId: 'g-1', userId: 'u-1', userName: '阿岚', text } });
  await pump();
  const packet = core.inbox.filter((m) => m && m.type === 'call-result' && m.ticket === ticket).at(-1);
  return packet;
}

beforeEach(() => {
  llmCalls = [];
  llmReplies = [];
  searchFetches = [];
  callTargets = [];
  callTargets = [];
  engineReplies = [];
  answered = { requests: new Set(), calls: new Map() };
});

afterEach(() => {
  if (core) core.close();
  if (search) search.close();
  core = null;
  search = null;
});

describe('the core can only ask the search plugin it declared', () => {
  test('manifests agree', () => {
    expect(coreManifest.callTargets).toContain(`${SEARCH_ID}/search`);
    expect(searchManifest.serves).toContain('search');
    expect(searchManifest.permissions).toContain('plugin.call');
    expect(coreManifest.permissions).toContain('plugin.call');
  });
});

describe('auto mode', () => {
  test('memory answers fine: no search, one model call', async () => {
    bootDocs();
    llmReplies.push('周五交报告，我记着呢。');
    const packet = await chat('周五要交什么来着？');
    expect(packet.ok).toBe(true);
    expect(llmCalls).toHaveLength(1);
    expect(searchFetches).toHaveLength(0);
    expect(packet.result.meta.webSearch).toBeNull();
    expect(packet.result.text).toBe('周五交报告，我记着呢。');
  });

  test('「我不知道」first answer triggers one search, then the model answers with it', async () => {
    bootDocs();
    llmReplies.push('这个我不清楚。', '今天是 2026 年 10 月 30 日，晴天。');
    engineReplies.push({
      status: 200,
      body: JSON.stringify({ results: [{ title: '天气网', url: 'https://weather.example.com', content: '2026-10-30 晴' }] }),
    });
    const packet = await chat('今天天气怎么样？');
    expect(packet.ok).toBe(true);
    // 两次模型调用 + 一次搜索
    expect(llmCalls).toHaveLength(2);
    expect(searchFetches).toHaveLength(1);
    // 第二次提问的 system 带着搜索结果
    const second = llmCalls[1];
    expect(second.system).toContain('【网页搜索结果】');
    expect(second.system).toContain('天气网');
    expect(packet.result.meta.webSearch).toEqual({ engine: 'searxng', results: 1 });
    expect(packet.result.text).toContain('2026 年 10 月 30 日');
  });

  test('user explicitly asks to search: results are fetched BEFORE the first model call', async () => {
    bootDocs();
    llmReplies.push('查到了：明天 18 度。');
    engineReplies.push({
      status: 200,
      body: JSON.stringify({ results: [{ title: '预报', url: 'https://f.example.com', content: '明天 18 度' }] }),
    });
    const packet = await chat('帮我查一下明天多少度');
    expect(packet.ok).toBe(true);
    expect(searchFetches).toHaveLength(1);
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0].system).toContain('【网页搜索结果】');
    expect(packet.result.meta.webSearch).not.toBeNull();
  });
});

describe('off and always', () => {
  test('off: a memory miss never touches the network', async () => {
    bootDocs();
    core.config.webSearch = 'off';
    llmReplies.push('这个我不知道。');
    const packet = await chat('今天天气怎么样？');
    expect(packet.ok).toBe(true);
    expect(llmCalls).toHaveLength(1);
    expect(searchFetches).toHaveLength(0);
  });

  test('always: every turn searches first, even when memory knows the answer', async () => {
    bootDocs();
    core.config.webSearch = 'always';
    llmReplies.push('好的，周五交报告。');
    engineReplies.push({
      status: 200,
      body: JSON.stringify({ results: [{ title: '日历', url: 'https://c.example.com', content: '周五是 10 月 31 日' }] }),
    });
    const packet = await chat('周五要交什么来着？');
    expect(packet.ok).toBe(true);
    expect(searchFetches).toHaveLength(1);
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0].system).toContain('【网页搜索结果】');
  });
});

describe('the search plugin is not there', () => {
  test('auto still answers from memory; the failure is silent by design', async () => {
    bootDocs({ withSearch: false });
    llmReplies.push('这个我不知道。');
    const packet = await chat('今天天气怎么样？');
    expect(packet.ok).toBe(true);
    // 第一答「不知道」→ 搜索失败（目标未启用）→ 兜底：不再第二问，第一答就是最终回答。
    expect(llmCalls).toHaveLength(1);
    expect(searchFetches).toHaveLength(0);
    expect(packet.result.text).toBe('这个我不知道。');
    expect(packet.result.meta.webSearch).toBeNull();
  });

  test('engine misconfigured: chat still returns the memory answer', async () => {
    bootDocs();
    search.config.searxngUrl = '';
    llmReplies.push('这个我不知道。');
    const packet = await chat('今天天气怎么样？');
    expect(packet.ok).toBe(true);
    expect(searchFetches).toHaveLength(0);
    expect(packet.result.text).toBe('这个我不知道。');
  });
});

// 模型自己给出的 `[SEARCH] 要查的话`（提示词里约定的出口）。
//
// 2026-10-30 真机日志：模型如实回了 `[SEARCH] "区"在网络用语中是什么意思`，而核心这一侧
// 从来没解析它——`SEARCH_TAG_RE` 只用在 `wantsSearchFor(用户那句话)` 里。于是既不搜，还把这个
// 标记原样发给了用户。用户的原话："记忆插件不会调用插件"。
describe('模型的 [SEARCH] 出口', () => {
  test('第一答是 [SEARCH] 查询词：用它去搜，再带着结果答第二遍', async () => {
    bootDocs();
    llmReplies.push('[SEARCH] 区 网络用语 意思', '「区」是「区区」的简写，自谦的说法。');
    engineReplies.push({
      status: 200,
      body: JSON.stringify({ results: [{ title: '网络用语词典', url: 'https://slang.example.com/qu', content: '区=区区' }] }),
    });
    const packet = await chat('让你搜区的网络意思');
    expect(packet.ok).toBe(true);
    // 关键：查的是**模型给的查询词**，不是用户原话
    expect(searchFetches).toHaveLength(1);
    const asked = searchFetches[0];
    const query = decodeURIComponent(String(asked.url || '').replace(/^.*[?&]q=([^&]*).*$/, '$1'));
    expect(query, '没有用模型给的查询词去搜').toContain('网络用语');
    // 两次模型调用：第一次是标记，第二次是带结果的正式回答
    expect(llmCalls).toHaveLength(2);
    expect(llmCalls[1].system).toContain('【网页搜索结果】');
    expect(packet.result.text).not.toContain('[SEARCH]');
    expect(packet.result.text).toContain('区区');
  });

  test('搜不到时：标记不许出现在用户看到的回答里', async () => {
    bootDocs();
    llmReplies.push('[SEARCH] 某个查不到的东西');
    engineReplies.push({ status: 500, body: 'boom' });
    const packet = await chat('让你搜某个查不到的东西');
    expect(packet.ok).toBe(true);
    expect(packet.result.text, '把 [SEARCH] 标记发给用户了').not.toContain('[SEARCH]');
    expect(packet.result.text.trim().length, '回答变成空的了').toBeGreaterThan(0);
    expect(packet.result.meta.webSearch).toBeNull();
  });
});

// 搜索引擎搜不到 → 换 B 站搜。用户的原话："网络梗搜索引擎不一定搜得到，b站插件也可以提供搜索的
// 能力，当搜索引擎搜不到时，使用 b站的搜索"。
//
// 判据是**一条结果都没有**（不是"报错"）：搜索引擎对网络梗经常返回 200 + 空列表，那也算没帮上忙。
describe('后备链：搜索引擎搜不到就用 B 站', () => {
  const BILI = 'com.shixiansi.plugin-bilibili/search';

  test('搜索引擎返回 0 条 → 接着问 B 站（并如实说明问不到时仍按记忆回答）', async () => {
    bootDocs();
    llmReplies.push('这个我不清楚。', '「区」是「区区」的自谦说法。');
    // 搜索引擎：200 但零结果
    engineReplies.push({ status: 200, body: JSON.stringify({ results: [] }) });
    const packet = await chat('区在网络用语中是什么意思');
    expect(packet.ok).toBe(true);
    expect(callTargets[0], '第一家不是搜索引擎').toBe('com.shixiansi.plugin-websearch/search');
    expect(callTargets, '搜索引擎没结果时没有去问 B 站').toContain(BILI);
    // 这一轮里 B 站在 harness 中不存在 → 问不到 → 仍然按记忆回答，不失败
    expect(packet.result.text.trim().length).toBeGreaterThan(0);
  });

  test('搜索引擎有结果 → 不去问 B 站（别多花一次往返）', async () => {
    bootDocs();
    llmReplies.push('这个我不清楚。', '今天是 2026 年 10 月 30 日。');
    engineReplies.push({
      status: 200,
      body: JSON.stringify({ results: [{ title: '天气', url: 'https://w.example.com', content: '晴' }] }),
    });
    const packet = await chat('今天天气怎么样');
    expect(packet.ok).toBe(true);
    expect(callTargets).toContain('com.shixiansi.plugin-websearch/search');
    expect(callTargets, '搜索引擎已经有结果，却又问了 B 站').not.toContain(BILI);
  });
});
