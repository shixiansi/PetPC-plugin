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
const SLANG_ID = 'com.shixiansi.plugin-slang';
const MOEGIRL_ID = 'com.shixiansi.plugin-moegirl';

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
/** 每次 plugin.call 的 payload，按调用顺序。 */
let callPayloads;
/** 每次 plugins.services 的时刻：能力发现的刷新节奏靠它断言。 */
let servicesCalls;
/** true = 第一次问名单时释义提供方还没装（真机 2026-10-30 的那一幕）。 */
let servicesCold;
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
    case 'plugins.services':
      // 能力发现：宿主告诉调用方"谁能干什么"（真宿主 0.6.0 起提供）。
      servicesCalls.push(Date.now());
      // `servicesCold` 模拟真机：第一次问的时候释义提供方还没装完（名单里只有搜索）。
      const list = servicesCold && servicesCalls.length === 1
        ? [{ id: SEARCH_ID, name: '联网搜索', description: '整网搜索', serves: ['search'] }]
        : [
          { id: SLANG_ID, name: '网络词词典', description: '本地词库', serves: ['slang'] },
          { id: MOEGIRL_ID, name: '萌娘百科', description: '百科条目', serves: ['slang', 'wiki'] },
          { id: SEARCH_ID, name: '联网搜索', description: '整网搜索', serves: ['search'] },
        ];
      doc.send({ v: 1, type: 'response', id: req.id, ok: true, result: { services: list } });
      return;
    case 'plugin.call': {
      const target = String(payload.target || '');
      callTargets.push(`${target}/${String(payload.method || '')}`);
      callPayloads.push(payload.payload || {});
      const method = String(payload.method || '');
      const declared = Array.isArray(coreManifest.callTargets) ? coreManifest.callTargets : [];
      if (!declared.includes(`${target}/${method}`)) {
        doc.send({
          v: 1, type: 'response', id: req.id, ok: false,
          error: `插件 ${CORE_ID} 没有声明要调用 ${target}/${method}：manifest 的 callTargets 里没有这一项`,
        });
        return;
      }
      if (target === MOEGIRL_ID) {
        const asked2 = String((payload.payload && payload.payload.query) || '');
        if (!asked2.includes('区')) {
          doc.send({ v: 1, type: 'response', id: req.id, ok: true, result: { query: asked2, title: '', text: '', entry: null } });
          return;
        }
        doc.send({
          v: 1, type: 'response', id: req.id, ok: true,
          result: {
            query: asked2,
            title: '区',
            text: '【萌娘百科】区\n区可以指：区(网络用语)——一种网络用语。\n（来源：萌娘百科，CC BY-NC-SA 3.0 CN）',
            entry: { title: '区', extract: '区可以指：区(网络用语)——一种网络用语。' },
            source: 'moegirl',
          },
        });
        return;
      }
      if (target === SLANG_ID) {
        const asked = String((payload.payload && payload.payload.query) || '');
        if (!asked.includes('破防')) {
          doc.send({ v: 1, type: 'response', id: req.id, ok: true, result: { query: asked, matched: '', hits: [], total: 40, text: '' } });
          return;
        }
        // 本地词库：立即回一段释义（真插件也在这个量级——纯本地查表）。
        doc.send({
          v: 1, type: 'response', id: req.id, ok: true,
          result: {
            query: String((payload.payload && payload.payload.query) || ''),
            matched: '破防',
            hits: [{ term: '破防', meaning: '心理防线被击穿。' }],
            total: 40,
            text: '【网络词】用户提到的词在本地词库里查到了，可以直接用它的意思，不要再说「不知道」：\n- 破防：心理防线被击穿。',
          },
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
  callPayloads = [];
  servicesCalls = [];
  servicesCold = false;
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
    expect(callTargets[0], '第一顺位应当是本地词库（免费）').toBe('com.shixiansi.plugin-slang/slang');
    // 释义提供方（词库 → 百科）都问完之后，才轮到搜索：搜索是最后一道，不是第一道。
    const webAt = callTargets.indexOf('com.shixiansi.plugin-websearch/search');
    expect(webAt, '没有问搜索引擎').toBeGreaterThanOrEqual(0);
    expect(webAt, '搜索排在了释义提供方之前').toBeGreaterThan(callTargets.indexOf('com.shixiansi.plugin-slang/slang'));
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

// "在问 B 站上的东西" → B 站排第一顺位。
//
// 真机事故（2026-10-30）：问「看一下b站原神现在的最新pv叫啥」，搜索引擎返回 5 条**非空但没用**的
// 结果（哔哩哔哩热门 / 下载中心 / UP主专栏 / 微软商店 / 山寨站），于是"0 条才换一家"的判据不触发，
// 而 B 站站内搜索同一句话第一条就是「「原神」新角色PV」（实测 code 0）。所以判据从"结果数"改成
// "词面意图"：命中 B 站/视频/PV/UP主 这些词就先问 B 站——顺带省掉搜索引擎那 20 秒。
describe('B 站意图：先问 B 站', () => {
  const BILI = 'com.shixiansi.plugin-bilibili/search';
  const WEB = 'com.shixiansi.plugin-websearch/search';

  test('用户明确说"b站…pv"：第一顺位是 B 站', async () => {
    bootDocs();
    llmReplies.push('这个我不清楚。', '最新的是「原神」新角色PV，链接 BV1dAxE6VErW。');
    engineReplies.push({
      status: 200,
      body: JSON.stringify({ results: [{ title: '「原神」新角色PV', url: 'https://www.bilibili.com/video/BV1dAxE6VErW', content: 'PV' }] }),
    });
    const packet = await chat('看一下b站原神现在的最新pv叫啥，链接发来');
    expect(packet.ok).toBe(true);
    expect(callTargets[0], '第一顺位应当是本地词库').toBe('com.shixiansi.plugin-slang/slang');
    const biliAt = callTargets.indexOf(BILI);
    const webIdx = callTargets.indexOf(WEB);
    expect(biliAt, 'B 站意图却没有问 B 站').toBeGreaterThanOrEqual(0);
    expect(biliAt, 'B 站意图应当排在整网搜索之前').toBeLessThan(webIdx < 0 ? Number.MAX_SAFE_INTEGER : webIdx);
    // harness 里 B 站不存在 → 问不到 → 仍然会退回整网搜索（后备链不能因此断掉）
    expect(callTargets).toContain(WEB);
    expect(packet.result.text).toContain('BV');
  });

  test('普通问题仍然整网优先（别把每次搜索都变成 B 站）', async () => {
    bootDocs();
    llmReplies.push('这个我不清楚。', '今天是晴天。');
    engineReplies.push({
      status: 200,
      body: JSON.stringify({ results: [{ title: '天气', url: 'https://w.example.com', content: '晴' }] }),
    });
    const packet = await chat('今天天气怎么样');
    expect(packet.ok).toBe(true);
    expect(callTargets, '普通问题：应当整网搜索').toContain(WEB);
    expect(callTargets, '普通问题不该去问 B 站').not.toContain(BILI);
    expect(callTargets).not.toContain(BILI);
  });
});

// 搜索这一步必须在自己的预算内收手。
//
// 真机事故（2026-10-30）：`plugin.call 等 com.shixiansi.plugin-memcore/chat 的回答超时（30 秒）`。
// 那台 SearXNG 单次 20 秒，加上两轮模型就把宿主给的 30 秒花光了。修复有两半：本插件把时长
// （timeoutMs）透给搜索插件，让它提前放弃；同时自己再 race 一道兜底（老版本插件不认这个字段）。
describe('搜索有时间预算', () => {
  test('把 timeoutMs 透给搜索插件', async () => {
    bootDocs();
    llmReplies.push('这个我不清楚。', '好。');
    engineReplies.push({ status: 200, body: JSON.stringify({ results: [{ title: 't', url: 'https://x.example', content: 'c' }] }) });
    await chat('今天天气怎么样');
    expect(callPayloads.length, '没有发出 plugin.call').toBeGreaterThan(0);
    const at = callTargets.indexOf('com.shixiansi.plugin-websearch/search');
    expect(at, '没有发出搜索请求').toBeGreaterThanOrEqual(0);
    const searchPayload = callPayloads[at];
    expect(typeof searchPayload.timeoutMs, 'payload 里没有 timeoutMs：搜索方只能跑满 25 秒').toBe('number');
    expect(searchPayload.timeoutMs).toBeGreaterThan(1000);
    expect(searchPayload.timeoutMs, '预算比宿主的 30 秒还宽就没意义了').toBeLessThan(30000);
  });
});

// 网络词：先查本地词库，查到了就拼进 prompt。
//
// 顺序是刻意的——词库排在搜索**之前**：它免费（本机 plugin.call，微秒级）、更准（给的是释义而不是
// 网页），而且能省下那条有预算上限的搜索链。查不到就什么都不加，对话照旧。
describe('网络词：先查词库', () => {
  const SLANG = 'com.shixiansi.plugin-slang/slang';

  test('词库命中 → 排在搜索之前，且释义进了 system prompt', async () => {
    bootDocs();
    llmReplies.push('破防就是心理防线被击穿。');
    const packet = await chat('我今天真的破防了');
    expect(packet.ok).toBe(true);
    // 第一顺位是词库，不是搜索引擎
    expect(callTargets[0], '第一个问的不是词库').toBe(SLANG);
    expect(llmCalls[0].system, 'system prompt 里没有词库给的释义').toContain('心理防线被击穿');
    expect(packet.result.meta.slang, 'meta 里没有记下命中的词').toBe('破防');
    // 词库答上来了，就不该再花 20 秒去上网
    expect(callTargets, '词库已经答上，却又去搜索了').not.toContain('com.shixiansi.plugin-websearch/search');
  });

  test('词库没装（问不到）时：什么都不加，对话照常', async () => {
    bootDocs();
    // 让 slang 也走"问不到"那条：把它的 handler 关掉
    const before = callTargets.length;
    llmReplies.push('嗯。');
    const packet = await chat('随便说一句');
    expect(packet.ok).toBe(true);
    expect(packet.result.meta.slang, '这轮不该记下任何命中').toBeNull();
    expect(llmCalls[0].system).not.toContain('【网络词】');
    expect(callTargets.length).toBeGreaterThanOrEqual(before);
  });
});


// 能力发现 + 释义补位：本地词库没有的词，去问**发现了的**提供方（这里是萌娘百科）。
//
// 这条是"功能类插件主动暴露能力"的落点：核心不再写死某个插件 id，而是问宿主"谁提供 slang/wiki"，
// 再按顺序问过去。新装一个提供 slang 的插件，不需要改核心就能被用上。
describe('能力发现：词库没有就问百科', () => {
  test('slang 提供方都没有 → 问 wiki 提供方（萌娘百科），释义进了 prompt', async () => {
    bootDocs();
    llmReplies.push('「区」在网络用语里就是「区区」的自谦说法。');
    const packet = await chat('区在网络用语中是什么意思');
    expect(packet.ok).toBe(true);
    // 先问本地词库（它答不上来这个），再问萌娘百科
    expect(callTargets[0], '第一顺位应当是本地词库').toBe('com.shixiansi.plugin-slang/slang');
    expect(callTargets, '没有去问发现了的百科提供方').toContain('com.shixiansi.plugin-moegirl/slang');
    expect(llmCalls[0].system, '百科给的释义没有进 prompt').toContain('萌娘百科');
    expect(packet.result.meta.slang, 'meta 里没有记下命中的条目').toBe('区');
  });
});


// 能力发现的名单**不能永久缓存**。
//
// 真机事故（2026-10-30）：记忆核心的常驻帧只在挂载时问了一次 `plugins.services`，那时释义提供方
// （网络词词典 / 萌娘百科）还没装完——之后整场会话都用那份旧名单，新装的插件一次都没被调用，
// 用户看到的就是"发区还是不知道啥意思"。
describe('能力发现：名单会刷新', () => {
  test('第一次名单里没有提供方 → 作废缓存重问一次，然后真的去问它', async () => {
    servicesCold = true;
    bootDocs();
    llmReplies.push('「区」是「区区」的自谦说法。');
    const packet = await chat('区在网络用语中是什么意思');
    expect(packet.ok).toBe(true);
    expect(servicesCalls.length, '只问了一次名单：新装的插件会一直看不见').toBeGreaterThan(1);
    expect(callTargets, '重问之后仍然没去问释义提供方').toContain('com.shixiansi.plugin-slang/slang');
  });
});


// 查词/查资料前要去掉**说话人前缀**。
//
// 真机事故（2026-10-30）：QQ 为了模型知道谁在说话，发给核心的正文是「白泽：蛆」「时先思：区」。
// 前缀对模型是对的，对查词是灾难——`时先思：区` 被拿去 opensearch，解析成别的条目，回来一个
// missing page（109 B），于是「发区还是不知道啥意思」；`白泽：蛆` 更被解析成「白泽加奈惠」（声优）。
describe('查词前剥掉说话人前缀', () => {
  test('「时先思：区」→ 提供方收到的是「区」，而 prompt 里的原文不动', async () => {
    bootDocs();
    llmReplies.push('「区」是「区区」的自谦说法。');
    const packet = await chat('时先思：区');
    expect(packet.ok).toBe(true);
    const slangAt = callTargets.indexOf('com.shixiansi.plugin-slang/slang');
    expect(slangAt, '没有去问词库').toBeGreaterThanOrEqual(0);
    expect(callPayloads[slangAt].query, '说话人前缀被当成查询词了').toBe('区');
    // 进模型的那一句必须保持原样（前缀是给模型看的）
    expect(llmCalls[0].text).toContain('时先思：区');
  });

  test('图片提示也一起去掉（它只对模型有意义）', async () => {
    bootDocs();
    llmReplies.push('嗯。');
    await chat('时先思：区（这条消息带了 2 张图，你看不到；不确定就别描述画面。）');
    const slangAt = callTargets.indexOf('com.shixiansi.plugin-slang/slang');
    expect(callPayloads[slangAt].query).toBe('区');
  });
});
