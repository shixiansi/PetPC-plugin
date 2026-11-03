import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// GitHub 通知插件的行为测试：驱动 panel.html 真正加载的那几支脚本。
//
// harness 与 imgbed / state-snapshot 那几份同型：vitest 的 jsdom 全局 window 当作插件的
// window，拼起来的源码用 new Function 丢进一个新函数作用域（等于浏览器里那几支经典 script
// 共享一个作用域），出站 postMessage 用 spy 记下来，每一拍把还没答的请求答掉。
//
// 这个文件钉住的是"这个插件到底会不会说错话"：
//
//   1. manifest 的形状：五项权限、netHosts 只有 api.github.com、没有 surface / background、
//      ui.css 与宿主那份逐字节相同且写进了 assets；
//   2. 主路径：请求的 URL 与两个头、事件分类、**一句**摘要、徽标文案、状态里记住的 id；
//   3. 去重：同一个事件 id 第二次抓回来不再说；
//   4. 304：不发气泡、不涨未读数，而且下一轮请求带上了 If-None-Match；
//   5. 401 / 403 限流 / 404 三种失败各自是一句能照着做的话；
//   6. 未配置（没有 token / 没有仓库列表）时**一个 net.fetch 都不发**，页面写「先去设置里填」；
//   7. 宿主拒绝一切时不崩、不写数据，界面显示宿主的原文；
//   8. 轮询是分钟级的（≥5 分钟），不是 1 秒。
//
// 注：桌宠那一侧的帧用 `slot: 'background'` 模拟。这个 manifest 今天没有桌宠侧的帧
// （panel: true 只挂在控制中心），但 pet.badge / bubble.say 那两条路必须是对的——它们是这个
// 插件存在的一半理由，而 plugin-check 也正好用同一个挂载名跑它。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-github-notify');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');
const source = scriptSources
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-github-notify';
const STATE_KEY = 'notify/state';

// --- 夹具 ---------------------------------------------------------------------

const iso = (minutesAgo = 0) => new Date(Date.now() - minutesAgo * 60000).toISOString();

/** /events 形状：标题在 payload 里。 */
function prEvent(id, over = {}) {
  return {
    id,
    type: 'PullRequestEvent',
    created_at: iso(2),
    payload: {
      action: 'opened',
      pull_request: Object.assign({ number: 12, title: '修复登录超时', merged: false }, over),
    },
  };
}

function issueEvent(id, title = '导出按钮点了没反应') {
  return { id, type: 'IssuesEvent', created_at: iso(5), payload: { action: 'opened', issue: { number: 34, title } } };
}

function ciEvent(id, name = 'CI', conclusion = 'failure') {
  return {
    id,
    type: 'WorkflowRunEvent',
    created_at: iso(1),
    payload: { action: 'completed', workflow_run: { name, run_number: 7, conclusion } },
  };
}

/** /notifications 形状：标题与类型都在 subject 里，没有 type / payload。 */
function subjectItem(id, subjectType, title) {
  return {
    id,
    reason: 'mention',
    updated_at: iso(3),
    subject: { title, type: subjectType, url: 'https://api.github.com/repos/octo/demo/issues/7' },
    repository: { full_name: 'octo/demo' },
  };
}

// --- harness ------------------------------------------------------------------

let store;
let configValues;
let denyAll;
let fetchCalls;
let fetchReplies;
let bubbles;
let badges;
let answered;
let postedFrom;
let windowListeners;
let intervals;

function posted() {
  return window.postMessage.mock.calls.map((call) => call[0]).slice(postedFrom);
}

function byType(type) {
  return posted().filter((message) => message && message.type === type);
}

function requests() {
  return byType('request').map((message) => ({ id: message.id, method: message.method, payload: message.payload }));
}

function callsOf(method) {
  return requests().filter((request) => request.method === method);
}

function hostSends(data) {
  window.dispatchEvent(new MessageEvent('message', { data, source: window }));
}

function answer(id, result, { ok = true, error = '' } = {}) {
  answered.add(id);
  hostSends({ v: 1, type: 'response', id, ok, result, error });
}

function nextFetchReply() {
  if (fetchReplies.length) {
    const next = fetchReplies.shift();
    return typeof next === 'function' ? next() : next;
  }
  return { status: 200, body: '[]' };
}

/** 每拍把还没答的请求答掉，再让出一拍——一次答复常常引出下一个请求。 */
async function drain(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    for (const request of requests().filter((entry) => !answered.has(entry.id))) {
      const payload = request.payload || {};
      if (denyAll) {
        answer(request.id, null, { ok: false, error: `模拟拒绝：未获权限 ${request.method}` });
        continue;
      }
      switch (request.method) {
        case 'config.get':
          answer(request.id, { values: Object.assign({}, configValues), secrets: {} });
          break;
        case 'storage.get':
          answer(request.id, { value: store.has(String(payload.key)) ? store.get(String(payload.key)) : '' });
          break;
        case 'storage.set':
          store.set(String(payload.key), String(payload.value === undefined ? '' : payload.value));
          answer(request.id, { ok: true });
          break;
        case 'storage.remove':
          store.delete(String(payload.key));
          answer(request.id, { ok: true });
          break;
        case 'net.fetch': {
          fetchCalls.push(payload);
          const reply = nextFetchReply();
          // `{error:'…'}` = 宿主在闸门上就把这次调用拦了（比如请求头不在白名单里）：
          // 那不是一条 HTTP 状态的回答，所以走 ok:false 的 response。
          if (reply && reply.error) answer(request.id, null, { ok: false, error: reply.error });
          else answer(request.id, reply);
          break;
        }
        case 'pet.badge':
          badges.push(String(payload.text === undefined ? '' : payload.text));
          answer(request.id, { text: String(payload.text || '') });
          break;
        case 'bubble.say':
          bubbles.push(String(payload.text || ''));
          answer(request.id, { ok: true });
          break;
        default:
          answer(request.id, null, { ok: false, error: `本程序不支持该方法 ${request.method}` });
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
  intervals = [];
  postedFrom = window.postMessage.mock.calls.length;
  // eslint-disable-next-line no-new-func
  new Function(source)();
}

/** 这个窗口服务哪些方法：控制中心没有宠物（和真宿主一样），桌宠那边两个都有。 */
function methodsFor(slot) {
  const both = ['config.get', 'net.fetch', 'storage.get', 'storage.list', 'storage.remove', 'storage.set'];
  return slot === 'workshop' ? both : both.concat(['pet.badge', 'bubble.say']);
}

async function boot({ slot = 'workshop', granted = manifest.permissions, deny = false } = {}) {
  denyAll = deny;
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
  loadApp();
  hostSends({
    v: 1,
    type: 'init',
    pluginId: PLUGIN_ID,
    permissions: manifest.permissions,
    granted: [...granted],
    theme: 'dark',
    surface: slot === 'workshop'
      ? { kind: 'panel', slot: 'workshop' }
      : { kind: 'panel', slot: 'background' },
    host: { program: slot === 'workshop' ? 'workshop' : 'pet', methods: methodsFor(slot) },
  });
  await drain(14);
}

function stateValue() {
  const raw = store.get(STATE_KEY);
  return raw ? JSON.parse(raw) : null;
}

beforeEach(() => {
  store = new Map();
  configValues = { token: 'tok-1', repos: 'octo/demo', intervalMinutes: '10', kinds: 'pr,issue,ci' };
  denyAll = false;
  fetchCalls = [];
  fetchReplies = [];
  bubbles = [];
  badges = [];
  answered = new Set();
  postedFrom = 0;
  windowListeners = [];
  intervals = [];
  const originalAdd = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(function (type, fn, opts) {
    windowListeners.push([type, fn, opts]);
    return originalAdd(type, fn, opts);
  });
  // 定时器只记账、不真起：一份 10 分钟的 interval 在测试里永远不该触发，而起着它会让
  // vitest 报"还有句柄没关"。startPolling 仍然会调它，所以档期本身是断言的对象。
  vi.spyOn(window, 'setInterval').mockImplementation((fn, ms) => {
    intervals.push(Number(ms) || 0);
    return intervals.length;
  });
  vi.spyOn(window, 'clearInterval').mockImplementation(() => {});
  vi.spyOn(window, 'postMessage').mockImplementation(() => {});
});

afterEach(() => {
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  vi.restoreAllMocks();
});

// --- manifest -----------------------------------------------------------------

describe('manifest', () => {
  test('只申请用得到的五项权限，徽标借的是 pet.surface', () => {
    expect([...manifest.permissions].sort()).toEqual(
      ['net.fetch', 'pet.bubble', 'pet.surface', 'plugin.config', 'storage'],
    );
    // pet.badge 借 pet.surface 的授权（宿主 §4.1），所以没有、也不该有第六项。
    expect(manifest.permissions).not.toContain('events');
    expect(manifest.permissions).not.toContain('background');
  });

  test('落点：插件页 + 常驻帧，没有 surface、没有 serves', () => {
    expect(manifest.panel).toBe(true);
    // 常驻帧不是可选的：徽标与气泡只在桌宠那个程序里被服务，而"打开插件页"这件事本身
    // 不会在桌宠侧挂出任何帧——没有 background 的话 pet.badge / bubble.say 这两项权限
    // 就是用户被问了、却永远不会发生的事（2026-11-03 截图阶段发现的形状）。
    expect(manifest.background).toBe(true);
    expect(manifest.surface).toBeUndefined();
    expect(manifest.serves).toBeUndefined();
  });

  test('网络只有 api.github.com，而且没有 hostWhitelist（GitHub 的域名是固定的）', () => {
    expect(manifest.netHosts).toEqual(['api.github.com']);
    expect(manifest.config.filter((item) => item.hostWhitelist === true)).toHaveLength(0);
  });

  test('设置项就是那四项：token / 仓库列表 / 分钟数 / 类型多选', () => {
    const byKey = {};
    for (const item of manifest.config) byKey[item.key] = item;
    expect(byKey.token.type).toBe('text');
    expect(byKey.repos.type).toBe('text');
    expect(byKey.intervalMinutes.type).toBe('number');
    expect(byKey.intervalMinutes.default).toBe('10');
    expect(byKey.kinds.type).toBe('select');
    expect(byKey.kinds.multiple).toBe(true);
    expect(byKey.kinds.default).toBe('pr,issue,ci');
    expect(byKey.kinds.options.map((option) => option.value)).toEqual(['pr', 'issue', 'ci']);
  });

  test('页面引用的每个本地文件都写进了 assets，ui.css 与宿主那份逐字节相同', () => {
    const fixed = ['panel.html', 'app.js', 'style.css'];
    for (const src of scriptSources) {
      if (fixed.includes(src)) continue;
      expect(manifest.assets).toContain(src);
    }
    expect(manifest.assets).toContain('ui.css');
    for (const asset of manifest.assets) {
      expect(existsSync(path.join(pluginDir, asset)), `manifest.assets 里的 ${asset} 不存在`).toBe(true);
    }
    // 没有声明 surface，所以走的是"整份引 ui.css"那条路：副本必须逐字节一致。
    const master = path.join(here, '..', 'docs', 'ui', 'petpc-ui.css');
    expect(readFileSync(path.join(pluginDir, 'ui.css'), 'utf8')).toBe(readFileSync(master, 'utf8'));
  });
});

// --- 握手 + 主路径 --------------------------------------------------------------

describe('握手与主路径', () => {
  test('握手之后按设置抓一次，请求带 Authorization 与 accept', async () => {
    fetchReplies.push({ status: 200, body: JSON.stringify([prEvent('e1')]) });
    await boot({ slot: 'background' });

    expect(window.__gh.snapshot().role).toBe('pet');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].method).toBe('GET');
    expect(fetchCalls[0].url).toBe('https://api.github.com/repos/octo/demo/events?per_page=30');
    expect(fetchCalls[0].headers.authorization).toBe('Bearer tok-1');
    expect(fetchCalls[0].headers.accept).toContain('github');
    // token 只在头里，绝不进 URL（URL 会进宿主的日志行）。
    expect(fetchCalls[0].url).not.toContain('tok-1');
  });

  test('一条新 PR：说一句摘要（含仓库名与类型），徽标挂上未读数，状态里记住 id', async () => {
    fetchReplies.push({ status: 200, body: JSON.stringify([prEvent('e1')]) });
    await boot({ slot: 'background' });

    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toContain('octo/demo');
    expect(bubbles[0]).toContain('PR');
    expect(bubbles[0]).toContain('修复登录超时');
    expect(badges).toEqual(['GitHub 1']);

    const state = stateValue();
    expect(state.seen).toContain('e1');
    expect(state.unread).toHaveLength(1);
    expect(state.unread[0]).toMatchObject({ id: 'e1', repo: 'octo/demo', kind: 'pr', number: 12 });
    expect(state.lastError).toBe('');
  });

  test('一次抓到多条时，气泡是一句话而不是一串标题', async () => {
    fetchReplies.push({
      status: 200,
      body: JSON.stringify([ciEvent('c1'), prEvent('p1', { title: '第二个标题' }), issueEvent('i1', '第三个标题')]),
    });
    await boot({ slot: 'background' });

    expect(bubbles).toHaveLength(1);
    const text = bubbles[0];
    expect(text).toContain('octo/demo');
    expect(text).toContain('3 条新动静');
    expect(text).toContain('PR');
    expect(text.length).toBeLessThanOrEqual(140);
    // 不是把三个标题拼起来：中间那些标题不该出现。
    expect(text).not.toContain('第三个标题');
    expect(text).not.toContain('\n');
  });

  test('两种响应形状都认：/events 的 payload 与 /notifications 的 subject', async () => {
    configValues.repos = 'octo/demo, other/lib';
    // 第一个仓库回空的 /events 数组，第二个仓库回 /notifications 形状的条目。
    fetchReplies.push({ status: 200, body: '[]' });
    fetchReplies.push({ status: 200, body: JSON.stringify([subjectItem('n1', 'PullRequest', '来自通知形状的标题')]) });
    await boot({ slot: 'background' });

    const state = stateValue();
    expect(state.unread).toHaveLength(1);
    expect(state.unread[0]).toMatchObject({ id: 'n1', kind: 'pr', repo: 'other/lib', number: 7 });
    expect(state.unread[0].title).toBe('来自通知形状的标题');
    // 两个仓库都真的被抓了，而且顺序就是设置里的顺序。
    expect(fetchCalls.map((call) => call.url)).toEqual([
      'https://api.github.com/repos/octo/demo/events?per_page=30',
      'https://api.github.com/repos/other/lib/events?per_page=30',
    ]);
  });

  test('只勾了 PR 时，CI 与 Issue 既不进列表也不算新动静', async () => {
    configValues.kinds = 'pr';
    fetchReplies.push({ status: 200, body: JSON.stringify([ciEvent('c1'), issueEvent('i1'), prEvent('p1')]) });
    await boot({ slot: 'background' });

    const state = stateValue();
    expect(state.unread.map((item) => item.id)).toEqual(['p1']);
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toContain('PR');
    // 见过的东西仍然全记下来：以后打开 CI 通知时，不会把几小时前的失败当成新动静。
    expect(state.seen).toEqual(expect.arrayContaining(['c1', 'i1', 'p1']));
  });
});

// --- 不重复通知 ----------------------------------------------------------------

describe('不重复通知', () => {
  test('同一个事件第二次抓回来不再说话，未读数也不涨', async () => {
    fetchReplies.push({ status: 200, body: JSON.stringify([prEvent('e1')]) });
    await boot({ slot: 'background' });
    expect(bubbles).toHaveLength(1);

    fetchReplies.push({ status: 200, body: JSON.stringify([prEvent('e1')]) });
    // 轮询这一拍：再抓一次，宿主回的还是同一条事件。（不能 await 它——它的 promise 要等
    // drain 把请求答掉才会落地。）
    window.__gh.check();
    await drain(14);

    expect(bubbles).toHaveLength(1);        // 0 次新的 bubble.say
    expect(badges).toEqual(['GitHub 1']);   // 数值没变 → 一次都不推
    expect(stateValue().unread).toHaveLength(1);
  });

  test('带上一次的 If-None-Match；304 时不发气泡、不涨未读数', async () => {
    fetchReplies.push({ status: 200, body: JSON.stringify([prEvent('e1')]), etag: '"v1"' });
    await boot({ slot: 'background' });
    expect(bubbles).toHaveLength(1);
    expect(stateValue().etags['octo/demo']).toBe('"v1"');

    fetchReplies.push({ status: 304, body: '' });
    window.__gh.check();
    await drain(14);

    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1].headers['if-none-match']).toBe('"v1"');
    expect(bubbles).toHaveLength(1);   // 0 次新的 bubble.say
    expect(badges).toEqual(['GitHub 1']);
    expect(stateValue().unread).toHaveLength(1);
  });

  test('徽标跟着未读数变，但数值没变就一次都不推', async () => {
    fetchReplies.push({ status: 200, body: JSON.stringify([prEvent('e1')]) });
    await boot({ slot: 'background' });
    expect(badges).toEqual(['GitHub 1']);

    fetchReplies.push({ status: 200, body: JSON.stringify([prEvent('e2')]) });
    window.__gh.check();
    await drain(14);
    expect(badges).toEqual(['GitHub 1', 'GitHub 2']);

    // 第三轮没有任何新事件：数值没变，于是**一次 pet.badge 都不发**（它是 DEBUG 级日志）。
    fetchReplies.push({ status: 200, body: JSON.stringify([prEvent('e2')]) });
    window.__gh.check();
    await drain(14);
    expect(badges).toEqual(['GitHub 1', 'GitHub 2']);
  });

  test('全部标记为已读会把徽标清掉（推空串，而不是推 0）', async () => {
    fetchReplies.push({ status: 200, body: JSON.stringify([prEvent('e1')]) });
    await boot({ slot: 'background' });
    window.__gh.markAllRead();
    await drain(12);

    expect(badges).toEqual(['GitHub 1', '']);
    expect(stateValue().unread).toEqual([]);
  });

  test('宿主拒绝 if-none-match 时自动退回不带校验器的那一次请求', async () => {
    fetchReplies.push({ status: 200, body: JSON.stringify([prEvent('e1')]), etag: '"v1"' });
    await boot({ slot: 'background' });
    // 第二轮：第一次带校验器的请求被宿主整条拒掉（真实宿主的头白名单里没有它）。
    fetchReplies.push({ error: 'net.fetch 不允许设置请求头 "if-none-match"' });
    fetchReplies.push({ status: 200, body: JSON.stringify([prEvent('e1')]) });
    window.__gh.check();
    await drain(14);

    expect(window.__gh.snapshot().conditionalOff).toBe(true);
    // 退回之后仍然抓到了东西，也没有因为一次被拒就变成"整个插件坏了"。
    expect(document.querySelectorAll('#error p')).toHaveLength(0);
  });
});

// --- 失败说的是人话 -------------------------------------------------------------

describe('失败说的是人话', () => {
  test('401：说 token 无效或过期，并指向设置', async () => {
    fetchReplies.push({ status: 401, body: '{"message":"Bad credentials"}' });
    await boot();
    const errors = document.getElementById('error').textContent;
    expect(errors).toContain('token 无效或过期');
    expect(errors).toContain('设置');
    expect(stateValue().lastError).toContain('token 无效或过期');
  });

  test('403 且正文说限流：说清几分钟后自动重试', async () => {
    fetchReplies.push({
      status: 403,
      body: '{"message":"API rate limit exceeded for 1.2.3.4."}',
    });
    await boot();
    const errors = document.getElementById('error').textContent;
    expect(errors).toContain('被限流了');
    expect(errors).toMatch(/被限流了，\d+ 分钟后自动重试/);
  });

  test('403 且不是限流：说是 token 没有这个仓库的读权限', async () => {
    fetchReplies.push({ status: 403, body: '{"message":"Resource not accessible by personal access token"}' });
    await boot();
    const errors = document.getElementById('error').textContent;
    expect(errors).toContain('403');
    expect(errors).toContain('octo/demo');
    expect(errors).not.toContain('被限流了');
  });

  test('404：点名是哪个 owner/repo 不存在', async () => {
    configValues.repos = 'octo/does-not-exist';
    fetchReplies.push({ status: 404, body: '{"message":"Not Found"}' });
    await boot();
    const errors = document.getElementById('error').textContent;
    expect(errors).toContain('找不到 octo/does-not-exist');
    expect(errors).toContain('仓库名');
  });
});

// --- 未配置 --------------------------------------------------------------------

describe('未配置时不发请求', () => {
  test('没有 token：一个 net.fetch 都不发，页面写「先去设置里填」', async () => {
    configValues.token = '';
    await boot();

    expect(fetchCalls).toHaveLength(0);
    expect(document.getElementById('setup').hidden).toBe(false);
    expect(document.getElementById('setup').textContent).toContain('先去设置里填');
    expect(document.getElementById('setup-text').textContent).toContain('token');
    // 连状态都不用读：没有可抓的东西，不写盘。
    expect(store.has(STATE_KEY)).toBe(false);
  });

  test('仓库列表为空：同样一个请求都不发', async () => {
    configValues.repos = '';
    await boot();

    expect(fetchCalls).toHaveLength(0);
    expect(document.getElementById('setup').hidden).toBe(false);
    expect(document.getElementById('setup-text').textContent).toContain('仓库列表');
  });

  test('仓库名写错时被忽略，并在状态行里说清跳过了几个', async () => {
    configValues.repos = 'octo/demo, 这不是仓库名';
    fetchReplies.push({ status: 200, body: JSON.stringify([prEvent('e1')]) });
    await boot();

    expect(fetchCalls).toHaveLength(1);
    expect(document.getElementById('status').textContent).toContain('没看懂');
  });
});

// --- 宿主拒绝一切 --------------------------------------------------------------

describe('宿主拒绝一切', () => {
  test('不崩、不写数据，界面显示宿主那句中文', async () => {
    await boot({ deny: true });

    // 没有一条写盘：拒绝发生在闸门上，什么都没发生（手册 §5.3 的第 3 步）。
    expect(store.size).toBe(0);
    expect(fetchCalls).toHaveLength(0);
    expect(bubbles).toHaveLength(0);
    const errors = document.getElementById('error').textContent;
    expect(errors).toContain('模拟拒绝');
    expect(document.getElementById('setup').hidden).toBe(false);
    // 界面仍然可用：按钮在、状态行是一句话。
    expect(document.getElementById('btn-check').disabled).toBe(false);
    expect(document.getElementById('status').textContent.length).toBeGreaterThan(0);
  });
});

// --- 页面 ----------------------------------------------------------------------

describe('页面', () => {
  test('控制中心这一面把「徽标与气泡在桌宠那边」说出来，而且真的不调那两个方法', async () => {
    fetchReplies.push({ status: 200, body: JSON.stringify([prEvent('e1')]) });
    await boot();

    expect(window.__gh.snapshot().role).toBe('page');
    expect(callsOf('pet.badge')).toHaveLength(0);
    expect(callsOf('bubble.say')).toHaveLength(0);
    expect(document.getElementById('badge-note').hidden).toBe(false);
    expect(document.getElementById('badge-note').textContent).toContain('桌宠');
  });

  test('未读列表画出来了，一条一行（类型标签 + 标题 + 仓库与时间）', async () => {
    fetchReplies.push({ status: 200, body: JSON.stringify([prEvent('e1'), issueEvent('i1')]) });
    await boot();

    const rows = [...document.querySelectorAll('#unread .feed-row')];
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('.tag').textContent).toBe('PR');
    expect(rows[0].querySelector('.feed-title').textContent).toContain('#12 修复登录超时');
    expect(rows[0].querySelector('.feed-meta').textContent).toContain('octo/demo');
    expect(document.getElementById('chip-unread').textContent).toBe('未读 2');
  });

  test('「全部标记为已读」清空未读，并把徽标清除', async () => {
    fetchReplies.push({ status: 200, body: JSON.stringify([prEvent('e1')]) });
    await boot();
    document.getElementById('btn-read').click();
    await drain(10);

    expect(stateValue().unread).toEqual([]);
    expect(document.querySelectorAll('#unread .feed-row')).toHaveLength(0);
    expect(document.getElementById('chip-unread').textContent).toBe('未读 0');
  });

  test('「最近事件」两轮抓到同一条不会在列表里出现两次', async () => {
    fetchReplies.push({ status: 200, body: JSON.stringify([prEvent('e1'), issueEvent('i1')]) });
    await boot();
    expect(document.querySelectorAll('#feed .feed-row')).toHaveLength(2);

    // 第二轮抓回来的还是那两条（GitHub 的 /events 每轮都回一屏）。
    fetchReplies.push({ status: 200, body: JSON.stringify([prEvent('e1'), issueEvent('i1')]) });
    window.__gh.check();
    await drain(14);
    expect(document.querySelectorAll('#feed .feed-row')).toHaveLength(2);
    expect(stateValue().recent.map((item) => item.id).sort()).toEqual(['e1', 'i1']);
  });

  test('轮询是分钟级：默认 10 分钟，写成 1 也只是 5 分钟；只有常驻帧排定时器', async () => {
    await boot({ slot: 'background' });
    // 一次 boot 只装一个定时器（不是每秒一个）。
    expect(intervals).toHaveLength(1);
    expect(intervals[0]).toBe(10 * 60 * 1000);

    configValues.intervalMinutes = '1';
    await boot({ slot: 'background' });
    expect(intervals[0]).toBe(5 * 60 * 1000);
    expect(window.__gh.intervalMinutes()).toBe(5);

    // 插件页不排定时器：轮询只有一个执行者（常驻帧），否则同一份 GitHub 配额被问两次、
    // 同一个 storage 键两个写者。页面打开时的那一轮抓取仍然要做（boot 里第一件事）。
    intervals.length = 0;
    await boot({ slot: 'workshop' });
    expect(intervals).toHaveLength(0);
  });
});
