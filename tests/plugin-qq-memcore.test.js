import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// QQ 插件 × 记忆核心：**核心模式的开关**。
//
// 这个文件只测一件事，但它是这件事的全部风险面：打开「把回答交给记忆核心」之后，群里的一句
// @ 会不会变成一次 `plugin.call`（而不是本插件自己的 `llm.chat`），回答会不会照原样发进群，
// 以及关掉开关时老路径是不是**一行都没变**。
//
// 老路径的行为由 plugin-qq.test.js 的 184 个用例覆盖，所以这里不重复测它；这里只钉"分叉点"。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-qq');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1])
  .filter((src) => src && !src.startsWith('http'));
const source = scriptSources.map((src) => readFileSync(path.join(pluginDir, src), 'utf8')).join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-qq';
const CORE_ID = 'com.shixiansi.plugin-memcore';
const SELF_ID = '99999';
const GROUP_ID = '123456';

// --- harness -----------------------------------------------------------------

let store = new Map();
let configValues = {};
/** 每一条 plugin.call：{target, method, payload}。 */
let coreCalls = [];
/** 每一条 llm.chat 的 payload。 */
let llmCalls = [];
/** 每一条发进群的动作：{api, params}。 */
let apiCalls = [];
/** 核心怎么答：'ok' / 'fail'。 */
let coreMode = 'ok';
let answered = new Set();
let postedFrom = 0;
let windowListeners = [];
let intervals = [];
let timeouts = [];

const macro = () => new Promise((resolve) => setTimeout(resolve, 0));

function posted() {
  return window.postMessage.mock.calls.map((call) => call[0]).slice(postedFrom);
}

function requests() {
  return posted().filter((m) => m && m.type === 'request');
}

function hostSends(data) {
  window.dispatchEvent(new MessageEvent('message', { data, source: window }));
}

function answer(id, result, { ok = true, error = '' } = {}) {
  answered.add(id);
  hostSends({ v: 1, type: 'response', id, ok, result, error });
}

function answerPlumbing() {
  let answeredNow = 0;
  for (const req of requests()) {
    if (answered.has(req.id)) continue;
    answeredNow += 1;
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
      case 'storage.stat':
        answer(req.id, { exists: store.has(String(payload.key)), bytes: 1 });
        break;
      case 'storage.dir':
        answer(req.id, { dir: 'C:\\data\\qq' });
        break;
      case 'storage.list': {
        const sub = String(payload.sub || '');
        const prefix = sub ? `${sub}/` : '';
        const dirs = new Set();
        const files = [];
        for (const [key, value] of store) {
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          if (!rest) continue;
          const slash = rest.indexOf('/');
          if (slash < 0) files.push({ name: rest, bytes: String(value).length });
          else dirs.add(rest.slice(0, slash));
        }
        answer(req.id, { dir: 'C:\\data\\qq', files, dirs: [...dirs] });
        break;
      }
      case 'storage.move':
        answer(req.id, { ok: true, moved: false });
        break;
      case 'ws.open':
        answer(req.id, { ok: true, state: 'open' });
        break;
      case 'ws.send':
        answer(req.id, { ok: true });
        break;
      case 'ws.close':
        answer(req.id, { ok: true });
        break;
      case 'ws.state':
        answer(req.id, { state: 'open', received: 0, sent: 0 });
        break;
      case 'llm.profile':
        answer(req.id, { ownReady: false, borrowAllowed: true, ready: true, source: 'borrowed', model: 'test-model' });
        break;
      case 'llm.chat':
        llmCalls.push(payload);
        answer(req.id, { requestId: 'sim', text: '插件自己拼的回答' });
        break;
      case 'plugin.call':
        coreCalls.push({ target: payload.target, method: payload.method, payload: payload.payload });
        if (coreMode === 'fail') {
          answer(req.id, null, { ok: false, error: 'plugin.call 的目标插件 com.shixiansi.plugin-memcore 未启用' });
          break;
        }
        if (payload.method === 'seed') {
          answer(req.id, { imported: Array.isArray(payload.payload && payload.payload.facts) ? payload.payload.facts.length : 0, skipped: 0 });
          break;
        }
        answer(req.id, { text: '核心的回答：周五交报告。', meta: { roleId: payload.payload && payload.payload.roleId } });
        break;
      case 'net.fetch': {
        const url = String(payload.url || '');
        const match = url.match(/\/api\/([a-z_]+)/);
        const api = match ? match[1] : '';
        if (api) apiCalls.push({ api, params: safeJSON(payload.body) });
        if (api === 'get_login_info') {
          answer(req.id, { status: 200, body: JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: SELF_ID } }) });
          break;
        }
        answer(req.id, { status: 200, body: JSON.stringify({ status: 'ok', retcode: 0, data: {} }) });
        break;
      }
      default:
        answer(req.id, null, { ok: false, error: `本程序不支持该方法 ${req.method}` });
        break;
    }
  }
  return answeredNow;
}

function safeJSON(raw) {
  try {
    return JSON.parse(String(raw || '{}'));
  } catch {
    return null;
  }
}

async function settle(maxRounds = 80) {
  let idle = 0;
  for (let i = 0; i < maxRounds; i += 1) {
    const before = posted().length;
    const answeredNow = answerPlumbing();
    await macro();
    if (answeredNow === 0 && before === posted().length) {
      idle += 1;
      if (idle >= 3) return;
    } else {
      idle = 0;
    }
  }
}

async function boot({ useMemcore = true, slot = 'background' } = {}) {
  document.body.innerHTML = '';
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  for (const id of intervals) window.clearInterval(id);
  intervals = [];
  for (const id of timeouts) window.clearTimeout(id);
  timeouts = [];
  vi.resetModules();
  postedFrom = window.postMessage.mock.calls.length;
  answered = new Set();

  // 开关存在插件自己的 storage 里（config 的 40 项已经用满了）。
  store.set('state/core', JSON.stringify({ enabled: useMemcore, at: 1 }));
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;

  configValues = {
    server: '127.0.0.1:3000',
    accessToken: '',
    atOnly: 'true',
    replyChance: '0',
    proactiveMinutes: '0',
    batchEnabled: 'false',
    batchWindowSec: '120',
    batchMaxPerHour: '0',
    prefix: '',
    groupAllow: '',
    persona: '',

    contextTurns: '8',
    memoryNotesMax: '20',
    energyBaseline: '70',
    replyMaxChars: '300',
    cooldownSec: '0',
    quoteChance: '0',
    stickerChance: '0',
    visionModel: '',
    autoCollectStickers: 'false',
    biliLinkReply: 'false',
    llmDailyBudget: '200',
  };

  // eslint-disable-next-line no-new-func
  new Function(source)();
  await macro();
  hostSends({
    v: 1,
    type: 'init',
    pluginId: PLUGIN_ID,
    permissions: [...manifest.permissions],
    granted: [...manifest.permissions],
    surface: { kind: 'panel', slot },
    theme: 'dark',
  });
  await settle();
  // 开关是**配置项**，而这份文档是 init 之后才去读配置的：断言"核心模式"之前必须先等它落地，
  // 否则测到的是"配置还没读进来"，而不是这条路径本身。
  await waitFor(() => window.__qqCore.enabled() === useMemcore);
}

/** 等到某个条件成立（配置不是同步就有的）。 */
async function waitFor(predicate, rounds = 40) {
  for (let i = 0; i < rounds; i += 1) {
    if (predicate()) return true;
    answerPlumbing();
    await macro();
  }
  return predicate();
}

/** 一条 @ 机器人的群消息（Milky 的 message_receive）。 */
function groupAsk({ text = '在吗', seq = 7, groupId = GROUP_ID, userId = '11111', name = '阿岚' } = {}) {
  return {
    event_type: 'message_receive',
    self_id: Number(SELF_ID),
    data: {
      message_scene: 'group',
      peer_id: Number(groupId),
      sender_id: Number(userId),
      message_seq: seq,
      group_member: { card: name, nickname: name },
      segments: [
        { type: 'mention', data: { user_id: Number(SELF_ID), name: '机器人' } },
        { type: 'text', data: { text: ` ${text}` } },
      ],
    },
  };
}

function socket(event) {
  hostSends({ v: 1, type: 'event', name: 'ws.message', payload: { text: JSON.stringify(event) } });
}

function sentMessages() {
  return apiCalls.filter((call) => call.api === 'send_group_message');
}

beforeEach(() => {
  store = new Map();
  coreCalls = [];
  llmCalls = [];
  apiCalls = [];
  coreMode = 'ok';
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
  vi.restoreAllMocks();
});

// --- manifest / wiring --------------------------------------------------------

describe('the declaration', () => {
  test('the core is named in callTargets, and the switch is not a config item', () => {
    expect(manifest.callTargets).toContain(`${CORE_ID}/chat`);
    expect(manifest.callTargets).toContain(`${CORE_ID}/seed`);
    expect(manifest.permissions).toContain('plugin.call');
    // 开关住在这个插件自己的 state/core 里，不是 manifest 的 config：config 的上限是宿主定的
    // 40 项，这个插件已经用满——为了一个开关去挪宿主的规则是本末倒置。
    expect(manifest.config.length).toBe(40);
    expect(manifest.config.some((entry) => entry.key === 'useMemcore')).toBe(false);
  });

  test('the script is carried in the package', () => {
    expect(manifest.assets).toContain('lib/memcore.js');
    expect(scriptSources).toContain('lib/memcore.js');
  });
});

// --- core mode ----------------------------------------------------------------

describe('with the memory core on', () => {
  test('an @ becomes one plugin.call, and its answer is what the group gets', async () => {
    await boot({ useMemcore: true });
    socket(groupAsk());
    await settle();

    expect(coreCalls).toHaveLength(1);
    expect(coreCalls[0].target).toBe(CORE_ID);
    expect(coreCalls[0].method).toBe('chat');
    expect(coreCalls[0].payload.roleId).toBe(`qq-group-${GROUP_ID}`);
    expect(coreCalls[0].payload.userId).toBe('11111');
    expect(coreCalls[0].payload.userName).toBe('阿岚');
    expect(coreCalls[0].payload.text).toContain('在吗');

    // 本插件不再自己问模型
    expect(llmCalls, '核心模式下仍然调了 llm.chat').toHaveLength(0);

    const sends = sentMessages();
    expect(sends).toHaveLength(1);
    const body = JSON.stringify(sends[0].params);
    expect(body).toContain('核心的回答');
  });

  test('an image cannot cross the call, and the core is told so instead of pretending', async () => {
    await boot({ useMemcore: true });
    const event = groupAsk({ text: '这张图里是什么' });
    event.data.segments = [
      { type: 'mention', data: { user_id: Number(SELF_ID) } },
      { type: 'text', data: { text: ' 这张图里是什么' } },
      { type: 'image', data: { url: 'https://example.invalid/a.png', summary: '[图片]' } },
    ];
    socket(event);
    await settle();

    expect(coreCalls).toHaveLength(1);
    expect(coreCalls[0].payload.text).toContain('1 张图');
    expect(coreCalls[0].payload.text).toContain('看不到');
  });

  test('a core failure is logged, not sent to the group', async () => {
    coreMode = 'fail';
    await boot({ useMemcore: true });
    socket(groupAsk());
    await settle();

    expect(sentMessages()).toHaveLength(0);
    const log = JSON.parse(store.get('state/log') || '[]');
    expect(JSON.stringify(log)).toContain('未启用');
  });

  test('the plugin still keeps its own transcript, so turning the switch off loses nothing', async () => {
    await boot({ useMemcore: true });
    socket(groupAsk());
    await settle();

    const history = store.get('history/' + GROUP_ID);
    expect(history, 'the plugin stopped writing its own history').toBeTruthy();
    expect(String(history)).toContain('核心的回答');
  });
});

describe('with the memory core off (the old path)', () => {
  test('the plugin asks the model itself and never calls the core', async () => {
    await boot({ useMemcore: false });
    socket(groupAsk());
    await settle();

    expect(coreCalls).toHaveLength(0);
    expect(llmCalls.length, 'the old path stopped calling llm.chat').toBeGreaterThan(0);
    expect(sentMessages().length).toBeGreaterThan(0);
  });
});

// --- seeding ------------------------------------------------------------------

describe('importing the old group memory', () => {
  test('notes travel as facts, and the count comes back', async () => {
    await boot({ useMemcore: true });
    store.set(`memory/${GROUP_ID}/notes`, JSON.stringify([
      { text: '周五要交报告', whoName: '阿岚', at: 1 },
      { text: '他养了一只猫', whoName: '阿岚', at: 2 },
    ]));

    const pending = window.__qqCore.seed([GROUP_ID]);
    await settle();
    const res = await pending;

    expect(res.imported).toBe(2);
    const call = coreCalls.find((entry) => entry.method === 'seed');
    expect(call, 'seed 没有被调用').toBeTruthy();
    expect(call.payload.roleId).toBe(`qq-group-${GROUP_ID}`);
    expect(call.payload.facts).toEqual(['阿岚：周五要交报告', '阿岚：他养了一只猫']);
  });

  test('a group with no notes is skipped, not sent as an empty import', async () => {
    await boot({ useMemcore: true });
    const pending = window.__qqCore.seed([GROUP_ID]);
    await settle();
    const res = await pending;
    expect(res.scanned).toBe(0);
    expect(coreCalls.filter((entry) => entry.method === 'seed')).toHaveLength(0);
  });
});

// --- what stops -----------------------------------------------------------------

// --- 自动导入：只能在常驻帧里发生 ------------------------------------------------

describe('importing, and where it is allowed to happen', () => {
  test('turning the switch on in the background imports the old notes exactly once', async () => {
    await boot({ useMemcore: false });
    store.set(`memory/${GROUP_ID}/notes`, JSON.stringify([
      { text: '周五要交报告', whoName: '阿岚', at: 1 },
    ]));
    // 用户在插件页勾上开关：那一页写的是**存储**，常驻帧在轮询里发现它变了。
    store.set('state/core', JSON.stringify({ enabled: true, at: Date.now() }));

    void window.__qqCore.refreshMode();
    await settle();

    const seeds = () => coreCalls.filter((call) => call.method === 'seed');
    expect(seeds(), '打开开关时没有导入旧记忆').toHaveLength(1);
    expect(seeds()[0].payload.facts).toEqual(['阿岚：周五要交报告']);

    // 再轮询一次：seededAt 挡住重复导入（否则每次重启都要发 N 个 plugin.call）。
    // 注意这里是 `void` + settle 而不是 `await`：`refreshMode` 自己会发 storage 请求，而请求只有
    // 在 settle 里才被假宿主回答 —— `await` 一个"要等宿主回话"的函数会把用例卡死。
    void window.__qqCore.refreshMode();
    await settle();
    expect(seeds()).toHaveLength(1);
  });

  test('a stamp left by the buggy build (1.13.1) does not block the import for ever', async () => {
    await boot({ useMemcore: false });
    store.set(`memory/${GROUP_ID}/notes`, JSON.stringify([{ text: '周五要交报告', at: 1 }]));
    // 1.13.1 写下的记录：seededAt 有值，但没有 seedVersion（那一版把「试过了」当成功）。
    store.set('state/core', JSON.stringify({ enabled: true, seededAt: 1, lastTryAt: 1, imported: 0 }));

    void window.__qqCore.refreshMode();
    await settle();

    expect(coreCalls.filter((call) => call.method === 'seed')).toHaveLength(1);
    const record = JSON.parse(store.get('state/core') || '{}');
    expect(record.seedVersion).toBe(2);
  });


  test('a failed import is not stamped as done, and is not retried every tick', async () => {
    await boot({ useMemcore: false });
    store.set(`memory/${GROUP_ID}/notes`, JSON.stringify([{ text: '周五要交报告', at: 1 }]));
    coreMode = 'fail';
    store.set('state/core', JSON.stringify({ enabled: true }));

    void window.__qqCore.refreshMode();
    await settle();

    const seeds = () => coreCalls.filter((call) => call.method === 'seed');
    expect(seeds()).toHaveLength(1);
    const record = JSON.parse(store.get('state/core') || '{}');
    // 没盖章：核心不在的时候，这条记忆还等着下一次机会。
    expect(record.seededAt).toBeUndefined();
    expect(record.lastTryAt).toBeGreaterThan(0);

    // 但也不会每 10 秒试一次：5 分钟内的下一次轮询直接跳过。
    void window.__qqCore.refreshMode();
    await settle();
    expect(seeds()).toHaveLength(1);
  });


  test('the workshop page never calls plugin.call, and says who does', async () => {
    // 这一条是**真机踩到的那次**的栅栏：控制中心不服务 plugin.call。按钮点下去，市场日志写的是
    // 「调用了本程序不支持的方法 plugin.call」——三个群三条空放。
    await boot({ useMemcore: true, slot: 'workshop' });
    store.set(`memory/${GROUP_ID}/notes`, JSON.stringify([{ text: '周五要交报告', at: 1 }]));
    void window.__qqCore.refreshMode();
    await settle();

    expect(coreCalls.filter((call) => call.method === 'seed'), '控制中心里发起了 plugin.call').toHaveLength(0);
    const where = document.getElementById('memcore-where');
    expect(where, '面板里没有那句说明').toBeTruthy();
    expect(where.hidden).toBe(false);
    expect(where.textContent).toContain('桌宠');
  });
});


describe('what core mode deliberately stops', () => {
  test('batch eavesdropping does not call the model any more', async () => {
    await boot({ useMemcore: true });
    expect(window.__qqCore.enabled(), '核心模式没打开时这条用例什么都没测').toBe(true);
    // 直接调那一层，而不是 batchTick：后者还有一串前置条件（攒够几条、能量、每小时次数），
    // 那些条件不成立时"没调模型"会是因为别的原因，而这里的断言想说的是"是核心模式让它停的"。
    const pending = window.__qqCore.batch(GROUP_ID, ['阿岚：在吗', '阿岚：有人吗']);
    await settle();
    const spoke = await pending;

    expect(spoke).toBe(false);
    expect(llmCalls).toHaveLength(0);
    // 读内存里的日志，不读落盘那一份：落盘是合并写的，断言不该依赖它什么时候刷。
    expect(window.__qq.state.log.join(String.fromCharCode(10))).toContain('不做攒批插话');
  });

  test('proactive speaking stops too, with the reason in the log', async () => {
    await boot({ useMemcore: true });
    const pending = window.__qqCore.proactive();
    await settle();
    await pending;

    expect(llmCalls).toHaveLength(0);
    expect(window.__qq.state.log.join('\n')).toContain('不主动开口');
  });
});
