import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 系统与 DSH 感知插件的行为测试。
//
// harness 与 websearch/memcore 的测试同型：vitest 的 jsdom 全局 window 当作插件的
// window，panel.html 里引用的两支脚本（lib/sampler.js + app.js）拼起来丢进
// new Function 的一个作用域，出站 postMessage 用 spy 记下来。
//
// 这个文件钉住的几件事：
//   1. 判定纯函数：快照过期丢弃、DSH 状态映射、徽标文案、负载事件的进/出只发一次；
//   2. 轮询循环：读三个 outbox 键 → 按序 share.set + pet.badge，DSH 的 at 没变不重发；
//   3. plugin.call 的 status 方法有问必答（包括"不认识的方法"）；
//   4. manifest：background 由 process 门控、serves 与代码逐字一致、assets 齐全；
//   5. 辅助脚本：PS1 在 assets 里、端口 3210、POST /api/state 的四状态白名单。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-pet-sense');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');
const source = scriptSources
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-pet-sense';

// --- harness -------------------------------------------------------------------

let window;
let document;
let outbound;
let storage;
let shares;
let badges;
let calls;
let scope;

function boot({ grantedNames = [], configValues = {}, surface = { kind: 'panel', slot: 'background' } } = {}) {
  const dom = new JSDOM(html, { url: 'https://plugin.local/panel.html' });
  window = dom.window;
  document = window.document;
  window.__granted = grantedNames;
  const host = fakeHost(grantedNames, configValues);

  const run = new Function('window', 'document', 'localStorage', `
    const window = undefined; // 阴影占位：真正的引用来自参数名外的全局注入
  `, '');

  // 与 websearch 测试同一招：脚本在函数作用域里执行，window/document 由参数给。
  const scopeWindow = window;
  scope = { window: scopeWindow, document };
  const fn = new Function('window', 'document', 'grantedNames', 'configValues', `
    const grantedSet = new Set(grantedNames);
    // 脚本读的是自己的 granted / cfg 变量；这里把宿主行为装进 postMessage。
  `);
  fn(scopeWindow, document, grantedNames, configValues);

  return host;
}

describe('manifest', () => {
  test('background 由 process 门控，serves 只有 status', () => {
    expect(manifest.background).toBe(true);
    expect(manifest.permissions).toContain('process');
    expect(manifest.permissions).toContain('plugin.call');
    expect(manifest.serves).toEqual(['status']);
    // 它不占浮层面：输出是徽标与共享键
    expect(manifest.surface).toBeUndefined();
    expect(manifest.permissions).toContain('pet.surface'); // pet.badge 借 surface 的授权
  });

  test('assets 里有辅助脚本与 sampler', () => {
    expect(manifest.assets).toContain('pet-sense-helper.ps1');
    expect(manifest.assets).toContain('lib/sampler.js');
    for (const asset of manifest.assets) {
      // assets 必须真的在包目录里
      // eslint-disable-next-line no-sync
      expect(require('node:fs').existsSync(path.join(pluginDir, asset)), `缺 ${asset}`).toBe(true);
    }
  });

  test('不申请多余权限（没有 net.fetch / events / audio）', () => {
    for (const p of ['net.fetch', 'events', 'audio', 'net.ws', 'llm.chat']) {
      expect(manifest.permissions).not.toContain(p);
    }
  });

  test('config 的 helperPath / helperScript 是文本项', () => {
    const keys = manifest.config.map((c) => c.key);
    expect(keys).toContain('helperPath');
    expect(keys).toContain('helperScript');
    expect(keys).toContain('sampleInterval');
    expect(keys).toContain('cpuThreshold');
    expect(keys).toContain('highStreak');
    expect(manifest.config.every((c) => c.type !== 'secret' || c.key === 'llmApiKey')).toBe(true);
  });
});

describe('辅助脚本 pet-sense-helper.ps1', () => {
  const ps1 = readFileSync(path.join(pluginDir, 'pet-sense-helper.ps1'), 'utf8');

  test('监听 127.0.0.1:3210，提供 POST /api/state 与 GET /health', () => {
    expect(ps1).toContain("http://127.0.0.1:3210/");
    expect(ps1).toContain('/api/state');
    expect(ps1).toContain('/health');
  });

  test('四状态白名单：thinking / tool / done / error，别的拒 422', () => {
    expect(ps1).toMatch(/'thinking',\s*'tool',\s*'done',\s*'error'/);
    expect(ps1).toContain('422');
  });

  test('负载判定在脚本侧：连续 N 次才写 load.json，恢复也写', () => {
    expect(ps1).toContain('$streak');
    expect(ps1).toContain('high = $true');
    expect(ps1).toContain('high = $false');
  });

  test('原子写：先写 tmp 再 Move（读方永远看到完整 JSON）', () => {
    expect(ps1).toContain('.tmp');
    expect(ps1).toContain('Move-Item');
  });
});

describe('lib/sampler.js 判定（纯函数）', () => {
  // sampler 的函数都是经典脚本全局；单独拼一份最小作用域来调。
  const samplerSrc = readFileSync(path.join(pluginDir, 'lib', 'sampler.js'), 'utf8');
  const sandbox = { exports: {} };
  // sampler.js 走的是 module.exports 分支（node 与浏览器经典 script 双兼容）。
  new Function('window', 'module', samplerSrc)({}, sandbox);
  const S = sandbox.exports;

  test('parseSnapshot：坏 JSON / 过期快照返回 null', () => {
    expect(S.parseSnapshot('', Date.now())).toBeNull();
    expect(S.parseSnapshot('not json', Date.now())).toBeNull();
    const fresh = JSON.stringify({ cpu: 10, at: Date.now() - 1000 });
    expect(S.parseSnapshot(fresh, Date.now())).not.toBeNull();
    const stale = JSON.stringify({ cpu: 10, at: Date.now() - 60000 });
    expect(S.parseSnapshot(stale, Date.now(), 30000)).toBeNull();
  });

  test('mapDshState：四个状态映射成事件，别的丢弃', () => {
    for (const state of ['thinking', 'tool', 'done', 'error']) {
      expect(S.mapDshState({ state, at: 1 }).kind).toBe(`dsh.${state}`);
    }
    expect(S.mapDshState({ state: 'banana', at: 1 })).toBeNull();
    expect(S.mapDshState(null)).toBeNull();
    expect(S.mapDshState({ state: 'TOOL', at: 1 })).toBeNull(); // 大小写敏感：协议是 小写
  });

  test('badgeFor：thinking/tool 有徽标，done/error 清除', () => {
    expect(S.badgeFor({ kind: 'dsh.thinking' })).toBe('思考中…');
    expect(S.badgeFor({ kind: 'dsh.tool', tool: 'web_search' })).toBe('工具:web_search');
    expect(S.badgeFor({ kind: 'dsh.tool' })).toBe('在用工具…');
    expect(S.badgeFor({ kind: 'dsh.done' })).toBe('');
    expect(S.badgeFor({ kind: 'dsh.error' })).toBe('');
    expect(S.badgeFor({ kind: 'load.high' })).toBe('系统很忙');
    expect(S.badgeFor(null)).toBe('');
  });

  test('shouldPublishLoad：进与出各发一次，中间不重发', () => {
    expect(S.shouldPublishLoad(null, { high: true })).toBe(true);   // 进入
    expect(S.shouldPublishLoad({ high: true }, { high: true })).toBe(false); // 仍然高
    expect(S.shouldPublishLoad({ high: true }, { high: false })).toBe(true); // 恢复
    expect(S.shouldPublishLoad({ high: false }, { high: false })).toBe(false);
  });

  test('planActions：顺序是 system → load → dsh(share+badge)，DSH at 未变不发', () => {
    const sys = { cpu: 12, memPct: 40, at: 100 };
    const load = { high: true, at: 100 };
    const dsh = { state: 'thinking', at: 200 };
    const actions = S.planActions({ system: sys, load, dsh, prevDshAt: 0 });
    // 负载进入（prevLoad 为空 → high）也挂一次徽标，随后才是 DSH 的 share + 徽标。
    expect(actions.map((a) => a.share || `badge:${a.badge}`)).toEqual([
      'sense/system', 'sense/load', 'badge:系统很忙', 'sense/dsh', 'badge:思考中…',
    ]);

    // 仍然高（prevLoad.high === true）：负载的 share 与徽标都不重发
    const steady = S.planActions({ system: sys, load, dsh: null, prevDshAt: 0, prevLoad: load });
    expect(steady.map((a) => a.share || `badge:${a.badge}`)).toEqual(['sense/system']);

    // 同一条 DSH（at 未变）不再发 badge
    const again = S.planActions({ system: sys, load: null, dsh, prevDshAt: 200 });
    expect(again.some((a) => a.badge)).toBe(false);

    // 没有 DSH：只有 share，没有 badge
    const quiet = S.planActions({ system: sys, load: null, dsh: null, prevDshAt: 0 });
    expect(quiet.some((a) => a.badge)).toBe(false);
  });
});

describe('app.js 行为（jsdom）', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    try { window.__sense?.stopPoll?.(); } catch { /* 已关闭 */ }
    window?.close?.();
  });

  function boot({ grantedNames = [], configValues = {}, surface = { kind: 'panel', slot: 'background' } } = {}) {
    const dom = new JSDOM(html, { url: 'https://plugin.local/panel.html' });
    window = dom.window;
    document = window.document;
    outbound = [];
    shares = [];
    badges = [];
    storage = new Map();

    const responses = {
      'config.get': () => ({ values: configValues || {} }),
      'storage.get': ({ key }) => ({ value: storage.get(key) || '' }),
      'storage.set': ({ key, value }) => { storage.set(key, value); return { ok: true }; },
      'storage.dir': () => ({ dir: 'C:\\fake\\dir' }),
      'share.set': ({ name, value }) => { shares.push({ name, value }); return { ok: true }; },
      'pet.badge': ({ text }) => { badges.push(text); return { text }; },
      'process.launch': () => ({ pid: 4242 }),
    };

    window.parent.postMessage = (msg) => {
      outbound.push(msg);
      if (msg.type !== 'request') return;
      const handler = responses[msg.method];
      const result = handler ? handler(msg.payload || {}) : null;
      const ok = Boolean(handler);
      Promise.resolve().then(() => {
        window.dispatchEvent(new window.MessageEvent('message', {
          source: window.parent,
          data: { v: 1, type: 'response', id: msg.id, ok, result },
        }));
      });
    };

    // 拼两支脚本进一个作用域（与浏览器里的经典 script 一致）
    new Function('window', 'document', `
      ${source}
    `)(window, document);

    // 脚本已发 ready；现在宿主回 init（与真机时序一致：ready → init）。
    Promise.resolve().then(() => {
      window.dispatchEvent(new window.MessageEvent('message', {
        source: window.parent,
        data: { v: 1, type: 'init', pluginId: 'com.shixiansi.plugin-pet-sense',
                permissions: manifest.permissions, granted: grantedNames,
                surface, theme: 'dark' },
      }));
    });

    return dom;
  }

  /** 等 outbound 里出现第 n 个 request（轮询是异步的）。 */
  async function until(pred, ms = 1500) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const ok = pred();
      if (ok) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return pred();
  }

  test('握手：监听器装好后只发一次 ready', () => {
    boot({ grantedNames: [] });
    const readies = outbound.filter((m) => m.type === 'ready');
    expect(readies).toHaveLength(1);
    expect(readies[0].v).toBe(1);
  });

  test('轮询：写入 outbox 后按序 share.set，DSH 状态映射成徽标', async () => {
    boot({ grantedNames: ['plugin.share', 'pet.surface', 'storage', 'plugin.config'] });

    // 模拟辅助脚本写文件
    const at = Date.now();
    storage.set('outbox/system', JSON.stringify({ cpu: 10, memPct: 30, memUsedGb: 4, memTotalGb: 16, at }));
    storage.set('outbox/load', JSON.stringify({ high: true, consecutive: 3, cpu: 90, memPct: 85, at }));
    storage.set('outbox/dsh', JSON.stringify({ state: 'thinking', tool: '', note: '', at }));

    expect(await until(() => badges.length > 0)).toBe(true);
    const names = shares.map((s) => s.name);
    expect(names).toContain('sense/system');
    expect(names).toContain('sense/load');
    expect(names).toContain('sense/dsh');
    // 负载进入：徽标"系统很忙"（load.high 与 dsh.thinking 都会写，取最后一条也含它）
    expect(badges).toContain('思考中…');
    expect(badges).toContain('系统很忙');
    // share 的值是合法 JSON
    const sys = JSON.parse(shares.find((s) => s.name === 'sense/system').value);
    expect(sys.cpu).toBe(10);
  });

  test('负载恢复只发一次 load.low（中间轮不重发）', async () => {
    boot({ grantedNames: ['plugin.share', 'pet.surface', 'storage', 'plugin.config'] });
    const at = Date.now();
    storage.set('outbox/load', JSON.stringify({ high: true, consecutive: 3, cpu: 90, memPct: 85, at }));

    expect(await until(() => badges.includes('系统很忙'))).toBe(true);
    const highCount = shares.filter((s) => {
      try { return JSON.parse(s.value).high === true; } catch { return false; }
    }).length;
    expect(highCount).toBeGreaterThanOrEqual(1);

    // 恢复
    storage.set('outbox/load', JSON.stringify({ high: false, consecutive: 0, cpu: 10, memPct: 30, at: at + 1000 }));
    expect(await until(() => shares.some((s) => {
      try { return JSON.parse(s.value).high === false; } catch { return false; }
    }), 2500)).toBe(true);

    // 之后再没有新的 high=false（轮询继续也不重发）
    const lowCount = shares.filter((s) => {
      try { return JSON.parse(s.value).high === false; } catch { return false; }
    }).length;
    await new Promise((r) => setTimeout(r, 1300));
    expect(shares.filter((s) => {
      try { return JSON.parse(s.value).high === false; } catch { return false; }
    }).length).toBe(lowCount);
  });

  test('DSH done → 徽标清除（空串也是一次 pet.badge）', async () => {
    boot({ grantedNames: ['plugin.share', 'pet.surface', 'storage', 'plugin.config'] });
    const at = Date.now();
    storage.set('outbox/dsh', JSON.stringify({ state: 'thinking', tool: '', note: '', at }));
    expect(await until(() => badges.includes('思考中…'))).toBe(true);

    storage.set('outbox/dsh', JSON.stringify({ state: 'done', tool: '', note: '', at: at + 100 }));
    expect(await until(() => badges.includes(''))).toBe(true);
  });

  test('plugin.call status 有问必答，不认识的方法给一句中文错误', async () => {
    boot({ grantedNames: ['plugin.call', 'storage'] });

    const at = Date.now();
    storage.set('outbox/system', JSON.stringify({ cpu: 22, memPct: 50, memUsedGb: 8, memTotalGb: 16, at }));

    // 等轮询至少跑过一轮（status 内部也会自己 pollOnce）
    await until(() => shares.length > 0);

    const ticket = 't-1';
    const callEvent = new window.MessageEvent('message', {
      source: window.parent,
      data: { v: 1, type: 'call', ticket, from: 'com.other', method: 'status', payload: {} },
    });
    window.dispatchEvent(callEvent);
    await until(() => outbound.some((m) => m.type === 'call-result' && m.ticket === ticket));
    const answer = outbound.find((m) => m.type === 'call-result' && m.ticket === ticket);
    expect(answer.ok).toBe(true);
    expect(answer.result.system.cpu).toBe(22);

    // 未知方法
    const ticket2 = 't-2';
    window.dispatchEvent(new window.MessageEvent('message', {
      source: window.parent,
      data: { v: 1, type: 'call', ticket: ticket2, from: 'com.other', method: 'nope', payload: {} },
    }));
    await until(() => outbound.some((m) => m.type === 'call-result' && m.ticket === ticket2));
    const answer2 = outbound.find((m) => m.type === 'call-result' && m.ticket === ticket2);
    expect(answer2.ok).toBe(false);
    expect(answer2.error).toContain('nope');
  });

  test('没有授权时不发 share / badge（静默降级，不崩）', async () => {
    boot({ grantedNames: ['storage'] });
    storage.set('outbox/dsh', JSON.stringify({ state: 'error', tool: 'x', note: 'boom', at: Date.now() }));
    await new Promise((r) => setTimeout(r, 1200));
    expect(shares).toEqual([]);
    expect(badges).toEqual([]);
  });
});
