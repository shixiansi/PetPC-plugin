import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 记忆核心的行为测试，驱动的是 panel.html 里真实加载的那几支脚本。
//
// 为什么值得为它写这么多：它的主要行为发生在**看不见的那一面**——常驻帧收到一条
// plugin.call，读四层记忆、拼 prompt、问模型、写回去、再把答案交出去。只读源码的话，
// "它到底把哪些东西拼进了上下文"和"它到底把哪些东西写进了磁盘"都只能靠相信。
//
// 这个文件钉住的几件事，每一件都在别处很难看出来：
//
//   1. 人设（L0）每一轮都整段在 system 里 —— 它是"人格不漂移"的全部实现；
//   2. 上一个会话的内容**不会**出现在另一个会话的上下文里（roleId 是隔离键）；
//   3. L1 满了才晋升，而且晋升用一个请求同时产出摘要与事实（两层一次问完）；
//   4. 每一次调用都有回包，包括"我不认识这个方法"——不回包调用方只能等超时。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-memcore');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const css = readFileSync(path.join(pluginDir, 'style.css'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

// 脚本来自 panel.html，不是这里另抄一份顺序：插件是"一组经典脚本按顺序加载"，
// 两份清单会在第一次加文件时分叉。
const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');
const source = scriptSources
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-memcore';

describe('manifest', () => {
  test('declares the headless frame and the permission that fills one', () => {
    // 一个"被问"的插件：入站流量是 plugin.call，没有宿主事件、没有自己的 socket、也没有
    // 轮询表。所以门控它的必须是 plugin.call —— 那正是这一版为它加进 validateBackground 的。
    expect(manifest.background).toBe(true);
    expect(manifest.permissions).toContain('plugin.call');
    expect(manifest.permissions).not.toContain('events');
    expect(manifest.permissions).not.toContain('net.ws');
  });

  test('serves exactly the methods the code answers', () => {
    // serves 里写了代码没实现 → 调用方等到超时（宿主不替我们答）；
    // 代码实现了 serves 没写 → 宿主根本不会转发过来。两边必须逐字相同。
    //
    // 从源码里读，而不是从跑起来的 `window.__memcore`：这条断言必须在任何 boot 之前就成立，
    // 否则它只证明了"这个文件被 import 过"。
    const body = (source.match(/const CALL_HANDLERS = \{([\s\S]*?)\n\};/) || [])[1];
    expect(body, 'app.js has no CALL_HANDLERS literal').toBeTruthy();
    const keys = [...body.matchAll(/^\s{2}([A-Za-z0-9_]+):/gm)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(0);
    expect(manifest.serves).toEqual(keys);
  });

  test('does not pretend to call anyone', () => {
    // 核心是被问的那一端。列出 callTargets 会让安装对话框承诺一件它不做的事。
    expect(manifest.callTargets).toBeUndefined();
  });

  test('exactly one secret, and it is the model credential', () => {
    // 宿主把配置里**第一个** secret 当作这次请求的密钥。
    const secrets = manifest.config.filter((item) => item.secret === true);
    expect(secrets).toHaveLength(1);
    expect(secrets[0].key).toBe('llmApiKey');
  });

  test('stays within the host config item limit', () => {
    const hostSrc = readFileSync(
      path.join(here, '..', '..', 'internal', 'plugins', 'manifest.go'), 'utf8');
    const cap = Number((hostSrc.match(/maxConfigItems = (\d+)/) || [])[1]);
    expect(cap, 'the host cap could not be read').toBeGreaterThan(0);
    expect(manifest.config.length).toBeLessThanOrEqual(cap);
  });
});

describe('style.css', () => {
  test('nothing paints outside an element box', () => {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const prop of ['box-shadow', 'filter:', 'text-shadow', 'transform:']) {
      expect(stripped, `style.css uses ${prop}`).not.toContain(prop);
    }
  });

  test('the hidden attribute wins over the card layout', () => {
    // 这条规则住在共享的 `ui.css` 里（每个插件带一份副本），所以两处合起来看。
    const ui = readFileSync(path.join(pluginDir, 'ui.css'), 'utf8');
    const stripped = (css + ui).replace(/\/\*[\s\S]*?\*\//g, '');
    const match = stripped.match(/\[hidden\][^{]*\{([^}]*)\}/);
    expect(match, '没有 [hidden] 规则（style.css 或 ui.css）').toBeTruthy();
    expect(match[1]).toMatch(/display\s*:\s*none/);
    expect(match[1]).toMatch(/!important/);
  });
});

// --- harness -----------------------------------------------------------------

/** 插件的私有存储：键 -> 字符串值。 */
let store = new Map();
/** config.get 返回的值。 */
let configValues = {};
/** 脚本化的模型回答：按顺序取，取完用 fallback。 */
let llmReplies = [];
/** 每一条 llm.chat 的 payload，按顺序。 */
let llmCalls = [];
let answered = new Set();
let postedFrom = 0;
let windowListeners = [];
let intervals = [];
let chatFails = null;

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

/** 一个会按环境变量般的行为作答的假宿主（除 llm.chat 之外，那个由 llmReplies 决定）。 */
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
      case 'storage.list': {
        const sub = String(payload.sub || '');
        const prefix = sub ? `${sub}/` : '';
        const files = [];
        const dirs = new Set();
        for (const [key, value] of store) {
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          if (!rest) continue;
          const slash = rest.indexOf('/');
          if (slash < 0) files.push({ name: rest, bytes: String(value).length });
          else dirs.add(rest.slice(0, slash));
        }
        answer(req.id, { dir: 'C:\\data\\memcore', files, dirs: [...dirs] });
        break;
      }
      case 'storage.stat':
        answer(req.id, {
          exists: store.has(String(payload.key)),
          bytes: String(store.get(String(payload.key)) || '').length,
        });
        break;
      case 'llm.profile':
        answer(req.id, { ownReady: false, borrowAllowed: true, ready: true, source: 'borrowed', model: 'test-model' });
        break;
      case 'llm.chat': {
        llmCalls.push(payload);
        if (chatFails) {
          answer(req.id, null, { ok: false, error: chatFails });
          break;
        }
        const reply = llmReplies.length ? llmReplies.shift() : '（模拟回答）';
        answer(req.id, { requestId: 'sim', text: reply });
        break;
      }
      default:
        answer(req.id, null, { ok: false, error: `本程序不支持该方法 ${req.method}` });
        break;
    }
  }
  return answeredNow;
}

const macro = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 让插件把该发的请求都发出来、该跑的宏任务都跑完，再答一轮。
 *
 * 不是"跑固定几轮"：一次问答的每一处 await 都要占掉一个宏任务（假宿主一轮答一批），
 * 而一次问答有十来处。固定轮数会在改一行代码之后变成偶发失败——那种测试比没有更坏。
 * 所以这里按"没有新请求、也没有新回答"来判定停。
 */
async function settle(maxRounds = 60) {
  let idle = 0;
  for (let i = 0; i < maxRounds; i += 1) {
    const before = posted().length;
    const answeredNow = answerPlumbing();
    await macro();
    if (answeredNow === 0 && before === posted().length) {
      idle += 1;
      // 晋升是 setTimeout(0) 排的，它会在"看起来没事了"之后一拍才发出请求。
      if (idle >= 3) return;
    } else {
      idle = 0;
    }
  }
}

function installPanel() {
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
}

async function loadApp() {
  answered = new Set();
  // 上一份文档的监听器与定时器必须先走：它们仍然挂在同一个 window 上，而一个还活着的旧实例
  // 会跟新实例一起答复同一条消息——那不是"插件重启了"，是"两个记忆核心"，写出来的东西互相覆盖
  // （症状是 chain 里凭空多出一倍的事件）。
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  for (const id of intervals) window.clearInterval(id);
  intervals = [];
  vi.resetModules();
  postedFrom = window.postMessage.mock.calls.length;
  // 拼起来的源码放进一个新的函数作用域：等于浏览器里那几支经典脚本共享同一个作用域。
  // eslint-disable-next-line no-new-func
  new Function(source)();
}

async function boot({ slot = 'background' } = {}) {
  installPanel();
  await loadApp();
  await macro();
  // 握手：宿主回 init。之后插件才会去读设置。
  hostSends({
    v: 1,
    type: 'init',
    pluginId: PLUGIN_ID,
    permissions: manifest.permissions,
    granted: [...manifest.permissions],
    surface: { kind: 'panel', slot },
    theme: 'dark',
  });
  await settle();
}

/** 一次 plugin.call 的完整往返：投递 → 等回包。 */
async function call(method, payload, ticket = `t${Math.random().toString(36).slice(2, 8)}`) {
  hostSends({ v: 1, type: 'call', ticket, from: 'com.example.adapter', method, payload });
  await settle();
  const result = byType('call-result').filter((m) => m.ticket === ticket);
  return result.length ? result[result.length - 1] : null;
}

beforeEach(() => {
  document.body.innerHTML = '';
  // 上一条用例留下的实例必须**先拆掉**，再重置记录数组：数组一清，就再也找不到它们了，
  // 而它们还挂在同一个 window 上。症状是下一条用例里一个 plugincall 被答复好几次。
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  for (const id of intervals) window.clearInterval(id);
  intervals = [];
  store = new Map();
  configValues = {
    personaName: '小记',
    persona: '',
    replyMaxChars: '240',
    bufferTurns: '8',
    summaryChars: '500',
    episodeMax: '40',
    profileEvery: '3',
    llmDailyBudget: '200',
  };
  llmReplies = [];
  llmCalls = [];
  chatFails = null;
  // 记下插件注册的监听器与定时器，下一次 boot 之前好把它们拆掉（见 loadApp 的注释）。
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
  vi.restoreAllMocks();
});

// --- the bridge ---------------------------------------------------------------

describe('the handshake', () => {
  test('says ready before it asks for anything', async () => {
    installPanel();
    await loadApp();
    await macro();
    const first = posted()[0];
    expect(first && first.type).toBe('ready');
    expect(requests()).toHaveLength(0);
  });

  test('reads its settings once after init, and nothing before', async () => {
    installPanel();
    await loadApp();
    await macro();
    expect(requests().filter((r) => r.method === 'config.get')).toHaveLength(0);
    hostSends({
      v: 1, type: 'init', pluginId: PLUGIN_ID,
      permissions: manifest.permissions, granted: [...manifest.permissions],
      surface: { kind: 'panel', slot: 'background' }, theme: 'dark',
    });
    await settle();
    expect(requests().filter((r) => r.method === 'config.get').length).toBeGreaterThan(0);
  });

  test('the background frame paints nothing', async () => {
    await boot({ slot: 'background' });
    // 这一面是桌宠的隐藏帧：它必须看得见"自己是背景"(class)，而不是画出一块界面。
    expect(document.getElementById('root').classList.contains('view-background')).toBe(true);
    expect(document.getElementById('workshop').classList.contains('hidden')).toBe(true);
  });
});

// --- plugin.call ---------------------------------------------------------------

describe('answering `chat`', () => {
  test('the persona is in system on every turn, and the answer comes back', async () => {
    configValues.persona = '你是个记性很好的搭子，回答干脆。';
    await boot();
    llmReplies = ['行，周五交报告。'];
    const reply = await call('chat', {
      roleId: 'qq-group-1101', userId: 'u-1', userName: '阿岚', text: '帮我记一下周五交报告',
    });

    expect(reply, 'the caller never got a call-result').toBeTruthy();
    expect(reply.ok).toBe(true);
    expect(reply.result.text).toBe('行，周五交报告。');

    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0].system).toContain('记性很好的搭子');
    expect(llmCalls[0].text).toBe('帮我记一下周五交报告');
    expect(llmCalls[0].history).toEqual([]);
  });

  test('writes the turn into L1 and both chains', async () => {
    await boot();
    llmReplies = ['记住了。'];
    await call('chat', { roleId: 'qq-group-1', userId: 'u-1', userName: '阿岚', text: '周五交报告' });

    const turns = JSON.parse(store.get('mem/role/qq-group-1/turns'));
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ role: 'user', text: '周五交报告', who: '阿岚' });
    expect(turns[1]).toMatchObject({ role: 'assistant', text: '记住了。' });

    expect(JSON.parse(store.get('mem/role/qq-group-1/chain'))).toHaveLength(2);
    // 全局账本是"发生过什么"的记录：它跟着写，但从不进入上下文（下面那条用例断言这件事）。
    expect(JSON.parse(store.get('mem/global/chain'))).toHaveLength(2);
  });

  test('the next turn carries the previous one as history', async () => {
    await boot();
    llmReplies = ['好。', '记得。'];
    await call('chat', { roleId: 'g', userId: 'u', userName: '阿岚', text: '周五交报告' });
    await call('chat', { roleId: 'g', userId: 'u', userName: '阿岚', text: '别忘了' });

    expect(llmCalls).toHaveLength(2);
    expect(llmCalls[1].history).toEqual([
      { role: 'user', text: '周五交报告' },
      { role: 'assistant', text: '好。' },
    ]);
  });

  test('two conversations never see each other', async () => {
    await boot();
    configValues.bufferTurns = '8';
    llmReplies = ['好的。', '知道的。'];
    await call('chat', { roleId: 'qq-group-1', userId: 'u-1', userName: '阿岚', text: '我在准备周五的报告' });
    await call('chat', { roleId: 'onebot-2', userId: 'u-9', userName: '别人', text: '今天吃什么' });

    // 第二条的上下文里不能有第一条的任何一行——不是"被过滤掉了"，是根本没读过。
    const second = llmCalls[1];
    expect(second.history).toEqual([]);
    expect(JSON.stringify(second)).not.toContain('周五的报告');
    expect(second.system).not.toContain('阿岚');
  });

  test('refuses an empty line, and says why', async () => {
    await boot();
    const reply = await call('chat', { roleId: 'g', text: '   ' });
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('text');
    expect(llmCalls).toHaveLength(0);
  });

  test('refuses without a roleId', async () => {
    await boot();
    const reply = await call('chat', { userId: 'u', text: '在吗' });
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('roleId');
  });

  test('a call may carry one line of this-turn guidance, and it is not stored', async () => {
    // 用途：QQ 插件的"主动开口"。它是这一轮的指令，不是记忆——所以进 system 的末尾，
    // 而且不落盘（否则下一轮它会以为自己又要主动说话）。
    await boot();
    llmReplies = ['嗯，我在。'];
    await call('chat', {
      roleId: 'g', userId: 'u', userName: '阿岚', text: '（没有人在问你）', hint: '这次是你自己主动开口。',
    });
    expect(llmCalls[0].system).toContain('这次是你自己主动开口');
    const turns = JSON.parse(store.get('mem/role/g/turns'));
    expect(JSON.stringify(turns)).not.toContain('主动开口');
  });

  test('an unknown method is answered, not ignored', async () => {
    await boot();
    const reply = await call('forget', { roleId: 'g' });
    expect(reply, 'an unanswered call waits for the 30 s timeout instead').toBeTruthy();
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('forget');
  });

  test('a model failure becomes the caller’s error, and nothing is written', async () => {
    await boot();
    chatFails = '插件 com.shixiansi.plugin-memcore 未获权限 llm.chat';
    const reply = await call('chat', { roleId: 'g', userId: 'u', text: '在吗' });
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('llm.chat');
    expect(store.has('mem/role/g/turns')).toBe(false);
  });
});

// --- promotion ---------------------------------------------------------------

describe('promotion (L1 → L2/L3)', () => {
  test('does not summarise until the buffer overflows', async () => {
    configValues.bufferTurns = '2'; // 上限 4 条 = 两轮
    await boot();
    llmReplies = ['一', '二'];
    await call('chat', { roleId: 'g', userId: 'u', userName: '阿岚', text: '第一句' });
    await call('chat', { roleId: 'g', userId: 'u', userName: '阿岚', text: '第二句' });
    expect(llmCalls).toHaveLength(2); // 只有两次问答，没有第三次"压摘要"
  });

  test('one request produces both the summary and the facts', async () => {
    configValues.bufferTurns = '1'; // 上限 2 条 = 一轮；第二轮就会溢出
    await boot();
    llmReplies = [
      '一', // 第一轮的回答
      '二', // 第二轮的问答
      '{"summary":"阿岚在准备周五的报告","facts":["阿岚周五要交报告"]}', // 压摘要
    ];
    await call('chat', { roleId: 'g', userId: 'u', userName: '阿岚', text: '周五要交报告' });
    await call('chat', { roleId: 'g', userId: 'u', userName: '阿岚', text: '还差图表' });

    expect(llmCalls).toHaveLength(3);
    const digest = llmCalls[2];
    expect(digest.system).toContain('只输出 JSON');
    expect(digest.text).toContain('周五要交报告');

    const summary = JSON.parse(store.get('mem/role/g/summary'));
    expect(summary.text).toBe('阿岚在准备周五的报告');
    expect(summary.digests).toBe(1);
    expect(summary.lastUserId).toBe('u');

    const episodes = JSON.parse(store.get('mem/role/g/episodes'));
    expect(episodes).toHaveLength(1);
    expect(episodes[0].text).toBe('阿岚周五要交报告');

    // 缓冲被压过一轮之后只剩当前这一轮
    expect(JSON.parse(store.get('mem/role/g/turns'))).toHaveLength(2);
  });

  test('a broken digest does not lose the conversation', async () => {
    configValues.bufferTurns = '1';
    await boot();
    llmReplies = ['一', '二', '这不是 JSON，只是一句总结。'];
    await call('chat', { roleId: 'g', userId: 'u', userName: '阿岚', text: '第一句' });
    await call('chat', { roleId: 'g', userId: 'u', userName: '阿岚', text: '第二句' });

    // 宽容解析：整段当摘要，事实为空 —— 但绝不能因此丢掉已经记下来的往来。
    const summary = JSON.parse(store.get('mem/role/g/summary'));
    expect(summary.text).toContain('这不是 JSON');
    expect(JSON.parse(store.get('mem/role/g/turns'))).toHaveLength(2);
  });

  test('the profile is built every N digests, and never replaces a good one with junk', async () => {
    configValues.bufferTurns = '1';
    configValues.profileEvery = '1';
    await boot();
    llmReplies = [
      '一', '二',
      '{"summary":"阿岚在准备报告","facts":["阿岚周五要交报告"]}',
      '{"prefs":["喜欢短句"],"habits":["晚上写东西"],"stage":"认识了一段时间"}',
    ];
    await call('chat', { roleId: 'g', userId: 'u', userName: '阿岚', text: '第一句' });
    await call('chat', { roleId: 'g', userId: 'u', userName: '阿岚', text: '第二句' });

    const profile = JSON.parse(store.get('mem/user/u/profile'));
    expect(profile.prefs).toEqual(['喜欢短句']);
    expect(profile.stage).toBe('认识了一段时间');
  });
});

// --- seed：把接入端已经攒下的记忆并进来 --------------------------------------------

describe('`seed` (importing another plugin’s memory)', () => {
  test('facts land in L3, duplicates are skipped, and the chain says so', async () => {
    await boot();
    const first = await call('seed', {
      roleId: 'qq-group-1',
      facts: ['阿岚周五要交报告', '阿岚在准备报告', '阿岚周五要交报告'],
    });
    expect(first.ok).toBe(true);
    expect(first.result).toMatchObject({ imported: 2, skipped: 1 });

    const episodes = JSON.parse(store.get('mem/role/qq-group-1/episodes'));
    expect(episodes.map((e) => e.text)).toEqual(['阿岚周五要交报告', '阿岚在准备报告']);
    expect(JSON.stringify(JSON.parse(store.get('mem/role/qq-group-1/chain')))).toContain('导入了 2 条');

    // 再导一次同一批：一条都不该重复进来。
    const again = await call('seed', { roleId: 'qq-group-1', facts: ['阿岚周五要交报告'] });
    expect(again.result).toMatchObject({ imported: 0, skipped: 1 });
    expect(JSON.parse(store.get('mem/role/qq-group-1/episodes'))).toHaveLength(2);
  });

  test('a summary is written when there is none, and never over one that exists', async () => {
    configValues.bufferTurns = '1';
    await boot();
    // 先走一轮真实问答，让核心自己压出一份摘要。
    llmReplies = ['一', '二', '{"summary":"核心自己压的摘要","facts":[]}'];
    await call('chat', { roleId: 'g', userId: 'u', userName: '阿岚', text: '第一句' });
    await call('chat', { roleId: 'g', userId: 'u', userName: '阿岚', text: '第二句' });
    expect(JSON.parse(store.get('mem/role/g/summary')).text).toBe('核心自己压的摘要');

    const seeded = await call('seed', { roleId: 'g', summary: '插件搬过来的旧摘要', facts: [] });
    expect(seeded.result.summary).toBe(false);
    expect(JSON.parse(store.get('mem/role/g/summary')).text).toBe('核心自己压的摘要');
  });

  test('seeding needs a roleId', async () => {
    await boot();
    const reply = await call('seed', { facts: ['x'] });
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('roleId');
  });
});

// --- the workshop face ---------------------------------------------------------

describe('the workshop face', () => {
  test('never asks for llm.profile here: the control center does not serve it', async () => {
    // 被拒的调用在宿主那侧记一条 WARN。这一页每 5 秒刷一次，所以「问了再兜底」会把市场日志刷满
    // （2026-10-29 真机上就是这样）。判断必须在请求之前做。
    await boot({ slot: 'workshop' });
    expect(requests().filter((r) => r.method === 'llm.profile')).toHaveLength(0);
    const chip = document.getElementById('chip-model');
    expect(chip.textContent).toContain('桌宠');
  });


  test('lists a conversation, shows its summary, and can forget it', async () => {
    configValues.bufferTurns = '1';
    await boot();
    llmReplies = ['一', '二', '{"summary":"在准备报告","facts":[]}'];
    await call('chat', { roleId: 'qq-group-7', userId: 'u', userName: '阿岚', text: '第一句' });
    await call('chat', { roleId: 'qq-group-7', userId: 'u', userName: '阿岚', text: '第二句' });

    // 换个 appearance 重新挂一遍：控制中心那一份。
    await boot({ slot: 'workshop' });
    await settle();
    const rows = document.querySelectorAll('#roles-body tr');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('qq-group-7');

    window.confirm = () => true;
    rows[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await settle();
    document.getElementById('forget').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await settle();

    expect(store.has('mem/role/qq-group-7/turns')).toBe(false);
    expect(store.has('mem/role/qq-group-7/summary')).toBe(false);
    // 账本不动：删掉一个会话的上下文，不等于这件事没发生过。
    expect(store.has('mem/global/chain')).toBe(true);
  });
});
