import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createFakeHost } from '../docs/plugin-testkit/fake-host.mjs';

// 剪贴板助手的行为测试：app.js 在 jsdom 里对着假宿主跑，断言的是"读源码读不出来"的部分
// —— 握手之后才有请求、granted 决定哪些控件可用、一次复制走完整条流水线、点「好的」
// 会发起一次点名了渠道的 llm.chat、模型事件把流式文本写进结果卡的共享键。
//
// 帧间协议（本插件自己的约定，宿主不知道）：常驻帧往 clipask/inbox 写待问样本，
// 询问卡读它并把点按写回 clipask/clicks，常驻帧读到点按后发起 llm.chat，
// 把 llm.delta/llm.done 的结果写进 clipask/answer。测试直接驱动这条流水线。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-clipask');
const appPath = path.join(pluginDir, 'app.js');
const panelPath = path.join(pluginDir, 'panel.html');
const cssPath = path.join(pluginDir, 'style.css');
const manifestPath = path.join(pluginDir, 'manifest.json');

const html = readFileSync(panelPath, 'utf8');
const css = readFileSync(cssPath, 'utf8');
const appSource = readFileSync(appPath, 'utf8');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const ALL_GRANTED = [...manifest.permissions];

// --- 测试台 ------------------------------------------------------------------
//
// 每个用例得到一个 {dom, window, host, store, share}：
//   store   —— storage.get/set 的内存实现（常驻帧的 harvestInbox 读它）
//   share   —— share.get/set 的内存实现（五条帧间通道）
//   config  —— config.get 的返回值
//   host    —— 假宿主，记录所有请求

function makeHarness({
  granted = ALL_GRANTED,
  surface = { kind: 'panel', slot: 'background' },
  config = {},
  answers,
} = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://plugin.invalid/panel.html' });
  const { window } = dom;
  window.parent = window;

  const store = new Map();
  const share = new Map();
  const clicks = [];
  let chatPayload = null;
  let chatCalls = 0;

  const deliver = (data) => {
    const event = new window.MessageEvent('message', { data });
    Object.defineProperty(event, 'source', { value: window });
    window.dispatchEvent(event);
  };

  const host = createFakeHost({
    manifest,
    granted,
    surface,
    deliver,
    answers: (method, payload) => {
      if (answers) return answers(method, payload);
      switch (method) {
        case 'storage.get': return { value: store.get(payload?.key) ?? '' };
        case 'storage.set': store.set(payload?.key, payload?.value); return { ok: true };
        case 'storage.dir': return { dir: 'C:\\plugin-data\\clipask\\private' };
        case 'config.get': return { values: { ...config }, secrets: {} };
        case 'share.get': {
          const key = payload?.owner ? `${payload.owner}/${payload.name}` : `com.shixiansi.plugin-clipask/${payload?.name}`;
          const hit = share.get(key);
          return { value: hit ? hit.value : '', at: hit ? hit.at : 0, key };
        }
        case 'share.set': {
          const key = `com.shixiansi.plugin-clipask/${payload?.name}`;
          share.set(key, { value: payload?.value ?? '', at: Date.now() });
          return { ok: true, key };
        }
        case 'process.launch': clicks.push(payload); return { pid: 4242 };
        case 'process.state': return { known: true, running: true, exitCode: 0 };
        case 'llm.chat':
          chatCalls += 1;
          chatPayload = payload;
          return { requestId: payload?.requestId ?? 'sim', text: '（模拟回复）' };
        case 'surface.blocks': return { ok: true };
        case 'surface.show': return { ok: true };
        default: return { ok: true };
      }
    },
  });

  window.postMessage = (msg) => {
    // 与 plugin-check 的 driveOnce 相同的节奏：握手一到就开始逐批答复——
    // 插件的请求链是"一个答复引出下一个请求"。
    if (host.onMessage(msg) === 'ready') queueMicrotask(flush);
  };

  async function flush() {
    for (let round = 0; round < 6; round++) {
      const batch = host.takePending();
      if (batch.length === 0) {
        await new Promise((r) => setTimeout(r, 15));
        continue;
      }
      for (const msg of batch) host.respond(msg);
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  // jsdom 不执行 <script type="module">：直接 eval（app.js 无 import/export，是整段脚本）。
  window.eval(appSource);

  return {
    dom, window, host, store, share, clicks,
    get chatPayload() { return chatPayload; },
    get chatCalls() { return chatCalls; },
    /** 等待插件里的 promise 链排空（request→response→后续）。 */
    settle: () => new Promise((r) => setTimeout(r, 30)),
    /** 直接驱动常驻帧的一拍（不等真实的 1200ms 定时器）。 */
    tick: async () => {
      await window.__test_probe.tick();
      await new Promise((r) => setTimeout(r, 30));
    },
    /** 分类器（纯函数）。 */
    classify: (text) => window.__test_probe.classify(text),
    /** 以宿主身份送一条消息进插件（事件、theme 等）。 */
    deliver,
    /** 直接驱动浮层帧的一拍（不等真实的 1s 定时器）。 */
    poll: async () => {
      await window.__test_probe.pollInbox().catch(() => {});
      await window.__test_probe.pollAnswer().catch(() => {});
      await new Promise((r) => setTimeout(r, 30));
    },
    requests: (method) => host.requests.filter((r) => r.method === method),
  };
}

// fake-host 的答复由上面那个 flush 循环逐批送出（与 plugin-check 的 driveOnce 同节奏）。

let harness;

beforeEach(() => {
  // jsdom 环境里 setInterval 会把进程吊住：每个用例自己清（见 afterEach）。
});

afterEach(() => {
  if (harness) {
    // app.js 里的 setInterval 只在 ask/result 两类挂载启动；测试台不关掉它们会吊住进程。
    // jsdom 没有直接枚举定时器的 API：直接关掉整个 window 的事件循环来源。
    harness.dom.window.close();
    harness = null;
  }
});

// --- 用例 --------------------------------------------------------------------

describe('manifest', () => {
  test('申请了它用到的每一项权限', () => {
    for (const needed of ['process', 'llm.chat', 'llm.borrow', 'storage', 'plugin.config', 'plugin.share', 'events', 'pet.surface', 'pet.bubble']) {
      expect(manifest.permissions, `manifest 没申请 ${needed}`).toContain(needed);
    }
    expect(manifest.permissions).not.toContain('net.fetch'); // 请求统一由宿主的 llm.chat 发出
    expect(manifest.background).toBe(true);
    expect(manifest.surface).toHaveLength(2);
  });

  test('浮层块声明了 maxH（不长高的块不申请）', () => {
    for (const rect of manifest.surface) expect(Number(rect.maxH)).toBeGreaterThan(rect.h);
  });
});

describe('style.css：浮层裁剪纪律', () => {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');

  test('没有任何画到盒子之外的装饰', () => {
    for (const prop of ['box-shadow', 'filter:', 'text-shadow', 'transform:']) {
      expect(stripped, `style.css 用了 ${prop}`).not.toContain(prop);
    }
  });

  test('浮层面必须透明 + only light', () => {
    expect(stripped).toMatch(/:root[^{]*\{[^}]*background\s*:\s*transparent/);
    expect(stripped).toMatch(/color-scheme\s*:\s*only\s+light/);
  });

  test('[hidden] 带 !important（分身份全靠它）', () => {
    // 只匹配真正的规则行（^ 开头），跳过头部注释里提到 [hidden] 的说明文字。
    const rule = css.match(/^\[hidden\]\s*\{([^}]*)\}/m);
    expect(rule, '没有 [hidden] 规则').toBeTruthy();
    expect(rule[1]).toMatch(/display\s*:\s*none/);
    expect(rule[1]).toMatch(/!important/);
  });
});

describe('分类器：一段文本是代码、文章，还是单词', () => {
  test('代码：缩进 + 括号 + 关键字', () => {
    harness = makeHarness();
    const code = 'function hello(name) {\n  if (!name) return;\n  console.log(name);\n}';
    expect(harness.classify(code).kind).toBe('code');
  });

  test('单词：一个没有空白的短串', () => {
    harness = makeHarness();
    expect(harness.classify('serendipity').kind).toBe('word');
  });

  test('文章：普通多行文本不当代码', () => {
    harness = makeHarness();
    const article = '今天读了一篇关于海洋生态的长文，讲珊瑚白化的速度比预想的快。\n作者给了三个数据来源。\n结论是减排比预想的更紧迫。';
    expect(harness.classify(article).kind).toBe('text');
  });

  test('围栏代码块：按内容判断，不按围栏', () => {
    harness = makeHarness();
    const fenced = '```js\nfunction add(a, b) {\n  return a + b;\n}\n```';
    expect(harness.classify(fenced).kind).toBe('code');
  });
});

describe('常驻帧：流水线', () => {
  test('握手之后才发请求，第一拍是 config.get', async () => {
    harness = makeHarness();
    await harness.settle();
    expect(harness.host.ready).toBe(true);
    const first = harness.host.requests[0];
    expect(first.method).toBe('config.get');
  });

  test('inbox 里的一次复制 → 写 clipask/inbox 共享键，动作来自分类', async () => {
    harness = makeHarness();
    await harness.settle();
    const code = 'function add(a, b) {\n  return a + b;\n}\nconst x = add(1, 2);';
    harness.store.set('clip/inbox/latest', JSON.stringify({ at: Date.now(), text: code }));
    await harness.tick();

    const key = 'com.shixiansi.plugin-clipask/inbox';
    const hit = harness.share.get(key);
    expect(hit, '没有写 clipask/inbox').toBeTruthy();
    const value = JSON.parse(hit.value);
    expect(value.kind).toBe('code');
    expect(value.actions).toContain('解释');
    expect(value.text).toBe(code);
  });

  test('冷却：同一内容在窗口内不重复询问', async () => {
    harness = makeHarness({ config: { askCooldownSec: '120' } });
    await harness.settle();
    const code = 'function add(a, b) {\n  return a + b;\n}\nconst x = add(1, 2);';
    harness.store.set('clip/inbox/latest', JSON.stringify({ at: Date.now(), text: code }));
    await harness.tick();
    const first = harness.share.get('com.shixiansi.plugin-clipask/inbox');
    const firstId = JSON.parse(first.value).id;

    // 同内容、更大 at：冷却期内不该覆盖
    harness.store.set('clip/inbox/latest', JSON.stringify({ at: Date.now() + 1000, text: code }));
    await harness.tick();
    const second = JSON.parse(harness.share.get('com.shixiansi.plugin-clipask/inbox').value);
    expect(second.id).toBe(firstId);
  });

  test('点「好的」→ 一次点名 provider 的 llm.chat，正文带原文', async () => {
    harness = makeHarness({
      config: { provider: 'com.shixiansi.plugin-llmchannel', channel: 'deepseek' },
    });
    await harness.settle();
    const code = 'function add(a, b) {\n  return a + b;\n}\nconst x = add(1, 2);';
    harness.store.set('clip/inbox/latest', JSON.stringify({ at: Date.now(), text: code }));
    await harness.tick();

    // 用户点头：往 clicks 写一条（真实世界里这是询问卡写的）。
    const inbox = JSON.parse(harness.share.get('com.shixiansi.plugin-clipask/inbox').value);
    harness.share.set('com.shixiansi.plugin-clipask/clicks', {
      value: JSON.stringify([{ id: inbox.id, action: 'yes', at: Date.now() }]),
      at: Date.now(),
    });
    await harness.tick();

    expect(harness.chatCalls).toBe(1);
    expect(harness.chatPayload.provider).toBe('com.shixiansi.plugin-llmchannel');
    expect(harness.chatPayload.channel).toBe('deepseek');
    expect(harness.chatPayload.text).toContain('add');
    expect(harness.chatPayload.system).toMatch(/代码/);
  });

  test('llm.delta / llm.done → 流式写进 clipask/answer，done 后清掉 inbox', async () => {
    harness = makeHarness();
    await harness.settle();
    const code = 'function add(a, b) {\n  return a + b;\n}\nconst x = add(1, 2);';
    harness.store.set('clip/inbox/latest', JSON.stringify({ at: Date.now(), text: code }));
    await harness.tick();

    const inbox = JSON.parse(harness.share.get('com.shixiansi.plugin-clipask/inbox').value);
    harness.share.set('com.shixiansi.plugin-clipask/clicks', {
      value: JSON.stringify([{ id: inbox.id, action: 'yes', at: Date.now() }]),
      at: Date.now(),
    });
    await harness.tick();
    expect(harness.chatCalls).toBe(1);

    const requestId = harness.chatPayload.requestId;
    harness.deliver({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId, text: '这段' } });
    await harness.settle();
    harness.deliver({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId, text: '代码做加法' } });
    await harness.settle();

    const answer = JSON.parse(harness.share.get('com.shixiansi.plugin-clipask/answer').value);
    expect(answer.text).toBe('这段代码做加法');
    expect(answer.done).toBe(false);

    harness.deliver({ v: 1, type: 'event', name: 'llm.done', payload: { requestId, text: '这段代码做加法。' } });
    await harness.settle();
    const done = JSON.parse(harness.share.get('com.shixiansi.plugin-clipask/answer').value);
    expect(done.text).toBe('这段代码做加法。');
    expect(done.done).toBe(true);
    // 完成后 inbox 被清空（询问卡下一次轮询就不再显示旧问题）。
    const cleared = JSON.parse(harness.share.get('com.shixiansi.plugin-clipask/inbox').value);
    expect(cleared.id).toBe('');
  });

  test('llm.error → 错误进 answer，且带宿主原文', async () => {
    harness = makeHarness();
    await harness.settle();
    const code = 'function add(a, b) {\n  return a + b;\n}\nconst x = add(1, 2);';
    harness.store.set('clip/inbox/latest', JSON.stringify({ at: Date.now(), text: code }));
    await harness.tick();

    const inbox = JSON.parse(harness.share.get('com.shixiansi.plugin-clipask/inbox').value);
    harness.share.set('com.shixiansi.plugin-clipask/clicks', {
      value: JSON.stringify([{ id: inbox.id, action: 'yes', at: Date.now() }]),
      at: Date.now(),
    });
    await harness.tick();

    harness.deliver({
      v: 1, type: 'event', name: 'llm.error',
      payload: { requestId: harness.chatPayload.requestId, message: '密钥不对（auth）', kind: 'auth' },
    });
    await harness.settle();
    const answer = JSON.parse(harness.share.get('com.shixiansi.plugin-clipask/answer').value);
    expect(answer.done).toBe(true);
    expect(answer.error).toContain('密钥不对');
  });

  test('辅助脚本：写 watch 键进私有目录，用配置里的 exe 以 scriptblock 方式启动', async () => {
    harness = makeHarness({ config: { helperPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' } });
    await harness.settle();
    // 键名**不带 .ps1**：宿主的存储键每段只允许 [A-Za-z0-9_-]，带点的话 storage.set 整个
    // 不执行——脚本根本没落盘，而这条路径以前没人走过（helperPath 是空的），所以静默。
    const script = harness.store.get('clip/watch');
    expect(script, '没有把脚本写进私有目录的 clip/watch 键').toBeTruthy();
    expect(harness.store.get('clip/watch.ps1'), '键名又带上扩展名了').toBeUndefined();
    expect(script).toContain('Clipboard');
    expect(script).toContain('latest.txt');

    const launches = harness.requests('process.launch');
    expect(launches).toHaveLength(1);
    expect(launches[0].payload.path).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    // `-File` 要求 .ps1 扩展名，而键不能带点，所以启动走 -Command + scriptblock::Create。
    const args = launches[0].payload.args;
    expect(args).toContain('-Command');
    expect(args).not.toContain('-File');
    const command = String(args[args.indexOf('-Command') + 1] ?? '');
    expect(command, '启动命令里没有指向私有目录里的脚本').toContain('watch');
    expect(command).toContain('scriptblock');
    // 宿主的 process.launch 每个参数上限 512 字符：两个路径必须塞得下。
    expect(command.length).toBeLessThan(512);
  });

  // 这条原来断言的是"留空 = 不启动任何进程"——那正是用户报"完全没反应"的根因：`helperPath`
  // 的默认值就是空，于是装好、启用、授权之后什么都没发生。现在留空走系统自带的 PowerShell，
  // 所以改成钉**缺权限时才不启动**：那才是真正该拦住的事实，而且它发生在碰配置之前。
  test('缺 process 权限时一个进程都不启动', async () => {
    harness = makeHarness({ granted: ['storage', 'plugin.config', 'plugin.share'] });
    await harness.settle();
    expect(harness.requests('process.launch')).toHaveLength(0);
  });

  test('granted=[] 时一个请求都不发', async () => {
    harness = makeHarness({ granted: [] });
    await harness.settle();
    expect(harness.host.requests).toHaveLength(0);
  });

  test('宿主全拒时不崩', async () => {
    harness = makeHarness({ granted: ALL_GRANTED });
    await harness.settle();
    harness.host.mode = 'deny';
    harness.store.set('clip/inbox/latest', JSON.stringify({ at: Date.now(), text: 'hello' }));
    await harness.settle();
    await harness.settle();
    expect(harness.host.errors).toHaveLength(0);
  });
});

describe('询问卡（浮层块 0）', () => {
  function makeAskHarness() {
    return makeHarness({ surface: { kind: 'surface', rectIndex: 0, rectCount: 2 } });
  }

  test('读到待问样本后亮出按钮；点头把 action 写回 clicks', async () => {
    harness = makeAskHarness();
    await harness.settle();

    harness.share.set('com.shixiansi.plugin-clipask/inbox', {
      value: JSON.stringify({ id: 's1', kind: 'code', label: '这段代码', actions: ['解释'], text: 'x', at: Date.now() }),
      at: Date.now(),
    });
    await harness.poll();

    const yes = harness.window.document.getElementById('ask-yes');
    const kind = harness.window.document.getElementById('ask-kind');
    expect(kind.textContent).toBe('这段代码');
    expect(yes.disabled).toBe(false);

    yes.click();
    await harness.poll();

    const clicks = JSON.parse(harness.share.get('com.shixiansi.plugin-clipask/clicks').value);
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toMatchObject({ id: 's1', action: 'yes' });
  });

  test('同一个 id 不重复点亮（轮询幂等）', async () => {
    harness = makeAskHarness();
    await harness.settle();
    harness.share.set('com.shixiansi.plugin-clipask/inbox', {
      value: JSON.stringify({ id: 's1', kind: 'code', label: '这段代码', actions: ['解释'], text: 'x', at: Date.now() }),
      at: Date.now(),
    });
    await harness.poll();
    // clicks 一直为空：没有点过就没有写。
    const clicks = harness.share.get('com.shixiansi.plugin-clipask/clicks');
    expect(clicks ? JSON.parse(clicks.value) : []).toHaveLength(0);
  });

  // 块 0 声明 44px（maxH 180）。44px 装得下"标签 + 两个按钮"，装不下多出来的一行问话——
  // 真机上按钮那一排的下沿会被矩形切掉 6px（预览器 `--check --rect 0` 报的 `#ask-yes 底边 50 > 44`）。
  // 结果卡一直有 growIfNeeded()，询问卡以前没有：声明高度刚好卡在边界上，谁也没注意。
  //
  // jsdom 没有排版引擎（scrollHeight 恒为 0），所以这里断言的是"有没有发这个请求"以及
  // "请求的是块 0、且落在 [44, 180] 里"，不是具体数字。
  test('内容一变就请求块 0 长高（和结果卡同一条路）', async () => {
    harness = makeAskHarness();
    await harness.settle();

    harness.share.set('com.shixiansi.plugin-clipask/inbox', {
      value: JSON.stringify({ id: 's9', kind: 'code', label: '这段代码', actions: ['解释'], text: 'x', at: Date.now() }),
      at: Date.now(),
    });
    await harness.poll();

    const calls = harness.requests('surface.blocks');
    expect(calls.length, '没有请求长高：块 0 声明 44px，装不下问话那一行').toBeGreaterThan(0);
    const sizes = calls[calls.length - 1].payload.sizes;
    expect(sizes, '长高请求里没有块 0').toHaveProperty('0');
    expect(sizes[0]).toBeGreaterThanOrEqual(44); // 声明高度是下限
    expect(sizes[0]).toBeLessThanOrEqual(180);   // manifest 的 maxH 是上限
  });
});

describe('结果卡（浮层块 1）', () => {
  function makeResultHarness() {
    return makeHarness({ surface: { kind: 'surface', rectIndex: 1, rectCount: 2 } });
  }

  test('answer 键有内容时显示文本与标题，done 后状态清空', async () => {
    harness = makeResultHarness();
    await harness.settle();

    harness.share.set('com.shixiansi.plugin-clipask/answer', {
      value: JSON.stringify({ id: 'a1', title: '解释', status: '思考中…', text: '', done: false, at: Date.now() }),
      at: Date.now(),
    });
    await harness.poll();

    const doc = harness.window.document;
    expect(doc.getElementById('result').hidden).toBe(false);
    expect(doc.getElementById('result-title').textContent).toBe('解释');
    expect(doc.getElementById('result-status').textContent).toBe('思考中…');

    harness.share.set('com.shixiansi.plugin-clipask/answer', {
      value: JSON.stringify({ id: 'a1', title: '解释', status: '', text: '这段代码把两个数加起来。', done: true, at: Date.now() }),
      at: Date.now() + 10,
    });
    await harness.poll();
    expect(doc.getElementById('result-body').textContent).toContain('加起来');
  });

  test('错误路径把宿主的句子显示出来，不包装', async () => {
    harness = makeResultHarness();
    await harness.settle();
    harness.share.set('com.shixiansi.plugin-clipask/answer', {
      value: JSON.stringify({ id: 'a2', title: '解释', status: '', text: '', done: true, error: '模拟拒绝：未获权限 llm.chat', at: Date.now() }),
      at: Date.now(),
    });
    await harness.poll();
    expect(harness.window.document.getElementById('result-body').textContent).toContain('模拟拒绝');
  });
});

describe('工坊页（控制中心）', () => {
  function makeWorkshopHarness(opts = {}) {
    return makeHarness({ surface: { kind: 'panel', slot: 'workshop' }, ...opts });
  }

  test('读出设置并显示运行状态；缺权限时明说', async () => {
    harness = makeWorkshopHarness({ config: { helperPath: 'C:\\ps.exe' } });
    await harness.settle();
    const doc = harness.window.document;
    expect(doc.getElementById('cfg-helperPath').value).toBe('C:\\ps.exe');
    expect(doc.getElementById('ws-status').textContent).not.toContain('缺权限');
  });

  test('保存设置发 config.set，且只带声明过的键', async () => {
    harness = makeWorkshopHarness({ config: { helperPath: '' } });
    await harness.settle();
    const doc = harness.window.document;
    doc.getElementById('cfg-askCooldownSec').value = '30';
    doc.getElementById('cfg-askCooldownSec').dispatchEvent(new harness.window.Event('change'));
    await harness.settle();
    await harness.settle();

    const sets = harness.requests('config.set');
    expect(sets).toHaveLength(1);
    const keys = Object.keys(sets[0].payload.values);
    for (const key of keys) expect(manifest.config.some((c) => c.key === key), `config.set 带了未声明的键 ${key}`).toBe(true);
    expect(sets[0].payload.values.askCooldownSec).toBe('30');
  });
});

describe('WATCH_SCRIPT 与包内脚本的同源守卫', () => {
  test('app.js 的 WATCH_SCRIPT 就是唯一的脚本来源（clip-watch.ps1 不存在）', () => {
    // 脚本以字符串常量随 app.js 走（插件读不到包内文件的内容）。这条测试钉住两件事：
    // 常量存在、且没有第二个独立脚本文件造成"两处改了一处"的漂移。
    expect(appSource).toMatch(/const WATCH_SCRIPT = String\.raw`/);
  });

  test('脚本只写私有目录里的 latest.txt，不做别的 I/O', () => {
    const script = appSource.match(/const WATCH_SCRIPT = String\.raw`([\s\S]*?)`;/)[1];
    expect(script).toContain('Clipboard');
    expect(script).toContain('latest.txt');
    expect(script).not.toMatch(/Invoke-WebRequest|Invoke-RestMethod|Start-Process/);
  });
});

  // 这条是用户报"完全没反应"的根因：`helperPath` 默认是空，而以前"留空 = 不启动"。
  // 于是安装、启用、授权都做了，日志里也只看得到每个挂载周期的 config.get / share.get，
  // 一次 process.launch 都没有——插件看起来就是死的。
  test('没配 helperPath 时自动用系统自带的 PowerShell', async () => {
    harness = makeHarness({ config: {} });
    await harness.settle();
    const launches = harness.requests('process.launch');
    expect(launches.length, '一次都没启动：留空又被当成"不启动"了').toBeGreaterThan(0);
    expect(launches[0].payload.path.toLowerCase()).toContain('windowspowershell\\v1.0\\powershell.exe');
  });

  test('配了 helperPath 就先试它（默认值只是后备）', async () => {
    harness = makeHarness({ config: { helperPath: 'D:\\tools\\pwsh.exe' } });
    await harness.settle();
    const launches = harness.requests('process.launch');
    expect(launches.length).toBeGreaterThan(0);
    expect(launches[0].payload.path).toBe('D:\\tools\\pwsh.exe');
  });

// 脚本落盘的名字必须与插件轮询的键**逐字**相同。
//
// 宿主存储键每段只允许 `[A-Za-z0-9_-]`（手册 §6.3），所以键里不可能有 `.txt`；而按绝对路径写
// 文件的脚本侧很容易顺手写 `.txt`。2026-10-30 两边就是这么对不上：脚本写 `latest.txt`、插件读
// `clip/inbox/latest`，于是**即使辅助脚本启动了，也永远读不到样本**——症状和"完全没反应"一样。
test('辅助脚本落盘的名字与插件轮询的键一致（latest，不带扩展名）', () => {
  const src = readFileSync(appPath, 'utf8');
  expect(src, '脚本又写 latest.txt 了：插件轮询的是 clip/inbox/latest').not.toContain("'latest.txt'");
  expect(src, "脚本没有写 'latest'").toContain("(Join-Path $OutDir 'latest')");
  expect(src, '插件轮询的键变了，脚本侧要跟着改').toContain("request('storage.get', { key: 'clip/inbox/latest' })");
});

// 这一组守的是"出来了没弹"：辅助脚本起来了、样本也处理了，但界面什么也没有。
// 原因是 `surface.blocks` **只对已经打开的浮层面生效**，而 offerSample 写完信箱就结束了——
// 没有 `surface.show`，询问卡那一帧永远不会挂载，也就没有任何一帧去读 inbox。
describe('浮层面生命周期：有东西要看才打开', () => {
  test('样本进信箱后请求 surface.show（否则那一帧不会挂载）', async () => {
    harness = makeHarness();
    await harness.settle();
    harness.store.set('clip/inbox/latest', JSON.stringify({
      at: Date.now(),
      text: 'function add(a, b) {  // 一段足够长的代码，用来让分类器认定它是代码而不是一句话\n  return a + b;\n}\nconst x = add(1, 2);',
    }));
    await harness.tick();
    const shows = harness.requests('surface.show');
    expect(shows.length, '没有请求 surface.show：块不会挂载，界面就永远没反应').toBeGreaterThan(0);
  });

  test('点「不用」收起浮层面；点「好的」把询问卡让位给结果卡', async () => {
    harness = makeHarness({ surface: { kind: 'surface', rectIndex: 0, rectCount: 2 } });
    await harness.settle();

    const put = (id) => harness.share.set('com.shixiansi.plugin-clipask/inbox', {
      value: JSON.stringify({ id, kind: 'code', label: '这段代码', actions: ['解释'], text: 'x', at: Date.now() }),
      at: Date.now(),
    });

    put('s1');
    await harness.poll();
    harness.window.document.getElementById('ask-no').click();
    await harness.poll();
    expect(harness.requests('surface.hide').length, '点「不用」没有收起浮层面').toBeGreaterThan(0);

    put('s2');
    await harness.poll();
    harness.window.document.getElementById('ask-yes').click();
    await harness.poll();
    const blocks = harness.requests('surface.blocks');
    expect(blocks.length).toBeGreaterThan(0);
    // hidden 是"整份替换"：只留块 1（结果卡），询问卡必须被藏起来
    expect(blocks[blocks.length - 1].payload.hidden).toEqual([0]);
  });
});
