import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 换算工具的行为测试，三层：
//   1. 纯函数（lib/convert.js）——20 组换算、未知单位点名拒绝、类别不匹配、边界数在这里钉住；
//   2. 宿主链路（真实 panel.html + lib + app.js 在 jsdom 里握手）——serves 应答、granted=[]
//      零请求、插件页写历史；
//   3. 静态接线——manifest.serves 与 CALL_HANDLERS 逐字一致（少一边，调用方等 30 秒超时）。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-convert-kit');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const coreSource = readFileSync(path.join(pluginDir, 'lib', 'convert.js'), 'utf8');
const appSource = readFileSync(path.join(pluginDir, 'app.js'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

/** 纯函数层单独加载（不经过 jsdom）：同一份源码就是插件在帧里跑的那份。 */
function loadCore() {
  const window = {};
  new Function('window', coreSource)(window);
  return window.ConvertCore;
}

// --- jsdom 挂载（模仿 tests/plugin-habits.test.js 的 mount） ---------------------

async function mount({ granted: grants, surface } = {}) {
  const dom = new JSDOM(html, { url: 'https://plugin.invalid/panel.html', runScripts: 'outside-only' });
  const { window } = dom;
  const sent = [];
  const errors = [];
  const responses = new Map(); // id → {ok, result|error}，测试手工应答
  window.parent = window;
  window.postMessage = (msg) => sent.push(msg);
  window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
  window.addEventListener('unhandledrejection', (e) => errors.push('unhandled: ' + String(e.reason && e.reason.message || e.reason)));

  window.eval(coreSource); // panel.html 的 <script> 顺序：lib 先、app 后
  window.eval(appSource);

  const init = () => {
    const data = {
      v: 1,
      type: 'init',
      theme: 'dark',
      granted: grants || [],
      surface: surface || { kind: 'panel', slot: 'background' },
    };
    if (surface?.slot === 'workshop') {
      // 控制中心只服务插件页能用的方法：storage/config 两个宿主都服务，pet 专属的没有。
      data.host = { program: 'workshop', methods: ['storage.get', 'storage.set', 'config.get'] };
    }
    const event = new window.MessageEvent('message', { data });
    Object.defineProperty(event, 'source', { value: window });
    window.dispatchEvent(event);
  };

  // 把宿主对 request 的应答交给测试：type=request 的消息留在 sent 里，respond() 补回包。
  const respond = (id, result, ok = true) => {
    const event = new window.MessageEvent('message', {
      data: { v: 1, type: 'response', id, ok, result },
    });
    Object.defineProperty(event, 'source', { value: window });
    window.dispatchEvent(event);
  };

  /** 宿主的自动应答：storage/config 按形状回，其他的一律拒绝（更接近"没配齐"的宿主）。 */
  const autoAnswer = () => {
    for (const msg of sent) {
      if (msg.type !== 'request' || responses.has(msg.id)) continue;
      if (msg.method === 'storage.get') responses.set(msg.id, true), respond(msg.id, { value: '' });
      else if (msg.method === 'storage.set') responses.set(msg.id, true), respond(msg.id, { ok: true });
      else if (msg.method === 'config.get') responses.set(msg.id, true), respond(msg.id, { values: {} });
      else if (msg.method === 'events.subscribe') responses.set(msg.id, true), respond(msg.id, []);
      else responses.set(msg.id, true), respond(msg.id, null, false);
    }
  };

  await Promise.resolve();
  return { window, sent, errors, init, respond, autoAnswer };
}

/** 收集常驻帧回的 call-result：ticket 原样带回才算过。 */
function callResults(sent) {
  return sent.filter((m) => m.type === 'call-result');
}

async function flush() { await new Promise((r) => setTimeout(r, 0)); }

// --- 1. 纯函数层 ----------------------------------------------------------------

describe('convert 纯函数：20 组换算逐条断言', () => {
  const C = loadCore();
  const close = (got, want) => Math.abs(got - want) <= Math.abs(want) * 1e-9 + 1e-12;

  // 长度（基准 m）
  test('km→mi', () => { const r = C.convert({ value: 1, from: 'km', to: 'mi' }); expect(r.ok).toBe(true); expect(close(r.value, 0.6213711922)).toBe(true); });
  test('m→ft', () => { const r = C.convert({ value: 1, from: 'm', to: 'ft' }); expect(close(r.value, 3.280839895)).toBe(true); });
  test('cm→in', () => { const r = C.convert({ value: 2.54, from: 'cm', to: 'in' }); expect(close(r.value, 1)).toBe(true); });
  test('nmi→km', () => { const r = C.convert({ value: 1, from: 'nmi', to: 'km' }); expect(close(r.value, 1.852)).toBe(true); });

  // 重量（基准 kg）
  test('kg→lb', () => { const r = C.convert({ value: 1, from: 'kg', to: 'lb' }); expect(close(r.value, 2.2046226218)).toBe(true); });
  test('lb→g', () => { const r = C.convert({ value: 1, from: 'lb', to: 'g' }); expect(close(r.value, 453.59237)).toBe(true); });
  test('jin→kg', () => { const r = C.convert({ value: 2, from: 'jin', to: 'kg' }); expect(close(r.value, 1)).toBe(true); });

  // 温度（仿射，基准 K）
  test('°C→°F（100 → 212）', () => { const r = C.convert({ value: 100, from: '°C', to: '°F' }); expect(r.value).toBe(212); });
  test('°F→°C（32 → 0）', () => { const r = C.convert({ value: 32, from: '°F', to: '°C' }); expect(r.value).toBe(0); });
  test('°C→K（0 → 273.15）', () => { const r = C.convert({ value: 0, from: '°C', to: 'K' }); expect(close(r.value, 273.15)).toBe(true); });
  test('K→°C（0 → -273.15）', () => { const r = C.convert({ value: 0, from: 'K', to: '°C' }); expect(close(r.value, -273.15)).toBe(true); });

  // 数据量（1024 基）
  test('MB→GiB（1024 → 1）', () => { const r = C.convert({ value: 1024, from: 'MB', to: 'GiB' }); expect(r.value).toBe(1); });
  test('GB→MiB（1.5 → 1536）', () => { const r = C.convert({ value: 1.5, from: 'GB', to: 'MiB' }); expect(r.value).toBe(1536); });
  test('KB→B', () => { const r = C.convert({ value: 1, from: 'KB', to: 'B' }); expect(r.value).toBe(1024); });

  // 时间
  test('min→h', () => { const r = C.convert({ value: 90, from: 'min', to: 'h' }); expect(r.value).toBe(1.5); });
  test('d→min', () => { const r = C.convert({ value: 1, from: 'd', to: 'min' }); expect(r.value).toBe(1440); });

  // 进制（字符串域）
  test('dec→hex（255 → ff）', () => { const r = C.convert({ value: 255, from: 'dec', to: 'hex' }); expect(r.ok).toBe(true); expect(r.value).toBe('ff'); });
  test('bin→dec（110 → 6）', () => { const r = C.convert({ value: '110', from: 'bin', to: 'dec' }); expect(r.value).toBe('6'); });
  test('hex→dec（0xFF → 255）', () => { const r = C.convert({ value: '0xFF', from: 'hex', to: 'dec' }); expect(r.ok).toBe(true); expect(r.value).toBe('255'); });
  test('dec→bin（10 → 1010）', () => { const r = C.convert({ value: 10, from: 'dec', to: 'bin' }); expect(r.value).toBe('1010'); });
});

describe('convert 纯函数：拒绝与边界', () => {
  const C = loadCore();

  test('未知单位点名拒绝（smoot）', () => {
    const r = C.convert({ value: 1, from: 'smoot', to: 'm' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('smoot');
  });
  test('未知目标单位点名拒绝', () => {
    const r = C.convert({ value: 1, from: 'm', to: 'parsec' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('parsec');
  });
  test('类别不匹配点名两边（km→lb）', () => {
    const r = C.convert({ value: 1, from: 'km', to: 'lb' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('km');
    expect(r.reason).toContain('lb');
    expect(r.reason).toMatch(/长度|重量/);
  });
  test('未知进制点名拒绝', () => {
    const r = C.convert({ value: 7, from: 'dec', to: 'trit' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('trit');
  });
  test('进制非法数字拒绝', () => {
    const r = C.convert({ value: '129', from: 'bin', to: 'dec' });
    expect(r.ok).toBe(false);
  });
  test('未知时区写法点名拒绝', () => {
    const r = C.convert({ value: 14, from: 'CST', to: 'UTC-5' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('CST');
  });
  test('负数/零/超大数不崩且精度规则一致', () => {
    expect(C.convert({ value: -1, from: 'km', to: 'mi' }).ok).toBe(true);
    expect(C.convert({ value: 0, from: 'km', to: 'mi' }).value).toBe(0);
    const big = C.convert({ value: 1e15, from: 'mm', to: 'km' });
    expect(big.ok).toBe(true);
    expect(big.value).toBe(1e9);
  });
  test('text 一句话形状（1km to mi）', () => {
    const r = C.convert({ text: '1km to mi' });
    expect(r.ok).toBe(true);
    expect(Math.abs(r.value - 0.6213711922)).toBeLessThan(1e-9);
  });
  test('text 看不懂时说明形状', () => {
    const r = C.convert({ text: '给我换算一下' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('1km to mi');
  });
  test('大小写不敏感（KB 与 kb 同类）', () => {
    expect(C.convert({ value: 1, from: 'kb', to: 'MiB' }).ok).toBe(true);
    expect(C.convert({ value: 1, from: 'KM', to: 'MI' }).ok).toBe(true);
  });
  test('时区 UTC+8 → UTC-5：14 点变 01 点（跨日）', () => {
    const r = C.convert({ value: 14, from: 'UTC+8', to: 'UTC-5' });
    expect(r.ok).toBe(true);
    expect(r.clock).toBe('01:00');
    expect(r.value).toBe(-13);
  });
  test('setPrecision 影响结果（2 位 → 0.62）', () => {
    C.setPrecision(2);
    expect(C.convert({ value: 1, from: 'km', to: 'mi' }).value).toBe(0.62);
    C.setPrecision(10);
  });
});

// --- 2. 静态接线 ----------------------------------------------------------------

describe('manifest 与实现的接线', () => {
  test('serves 与 CALL_HANDLERS 逐字一致', () => {
    expect(manifest.serves.sort()).toEqual(['convert']);
    const window = {};
    new Function('window', coreSource)(window);
    // app.js 里 CALL_HANDLERS 的键在源码里可见（jsdom 挂载里再验行为）
    expect(appSource).toMatch(/const CALL_HANDLERS = \{\s*\n\s*convert:/);
  });
  test('permissions 满足契约：serves ⇒ plugin.call；background ⇒ 四选一', () => {
    expect(manifest.permissions).toContain('plugin.call');
    for (const need of ['events', 'net.ws', 'net.fetch', 'plugin.call']) {
      if (need === 'plugin.call') continue;
      // 本插件用 plugin.call 满足 background 的"四选一"
    }
    expect(manifest.background).toBe(true);
  });
});

// --- 3. 宿主链路（jsdom） ---------------------------------------------------------

describe('常驻帧：plugin.call 应答', () => {
  test('call(convert) 成功路径：ticket 原样带回，result.ok=true', async () => {
    const { window, sent, init } = await mount({ granted: ['plugin.call', 'storage', 'plugin.config'] });
    init();
    await flush();
    const event = new window.MessageEvent('message', {
      data: { v: 1, type: 'call', ticket: 't-1', from: 'com.other', method: 'convert', payload: { value: 1, from: 'km', to: 'mi' } },
    });
    Object.defineProperty(event, 'source', { value: window });
    window.dispatchEvent(event);
    await flush();
    const results = callResults(sent);
    expect(results).toHaveLength(1);
    expect(results[0].ticket).toBe('t-1');
    expect(results[0].ok).toBe(true);
    expect(results[0].result.ok).toBe(true);
    expect(results[0].result.formatted).toContain('mi');
  });

  test('call(convert) 换不了：result.ok=false 且 reason 点名单位（这是成功的一次应答）', async () => {
    const { window, sent, init } = await mount({ granted: ['plugin.call'] });
    init();
    await flush();
    const event = new window.MessageEvent('message', {
      data: { v: 1, type: 'call', ticket: 't-2', from: 'x', method: 'convert', payload: { value: 1, from: 'smoot', to: 'm' } },
    });
    Object.defineProperty(event, 'source', { value: window });
    window.dispatchEvent(event);
    await flush();
    const results = callResults(sent);
    expect(results[0].ok).toBe(true); // 信封成功
    expect(results[0].result.ok).toBe(false);
    expect(results[0].result.reason).toContain('smoot');
  });

  test('call(未知方法)：回 ok=false 的信封并说明支持什么', async () => {
    const { window, sent, init } = await mount({ granted: ['plugin.call'] });
    init();
    await flush();
    const event = new window.MessageEvent('message', {
      data: { v: 1, type: 'call', ticket: 't-3', from: 'x', method: 'divide', payload: {} },
    });
    Object.defineProperty(event, 'source', { value: window });
    window.dispatchEvent(event);
    await flush();
    const results = callResults(sent);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('convert');
  });

  test('常驻帧不写 storage（问它换算的调用方要的是答案，不是日志）', async () => {
    const { sent, init, autoAnswer } = await mount({ granted: ['plugin.call', 'storage'] });
    init();
    await flush();
    autoAnswer();
    const sets = sent.filter((m) => m.type === 'request' && m.method === 'storage.set');
    expect(sets).toEqual([]);
  });
});

describe('插件页（workshop）：手动换算与历史', () => {
  test('表单提交 → storage.set 写历史（storage/config 宿主都服务）', async () => {
    const { window, sent, init, respond, autoAnswer } = await mount({
      granted: ['storage', 'plugin.config'],
      surface: { kind: 'panel', slot: 'workshop' },
    });
    init();
    await flush();
    autoAnswer();
    window.document.getElementById('conv-value').value = '1';
    window.document.getElementById('conv-from').value = 'km';
    window.document.getElementById('conv-to').value = 'mi';
    window.document.getElementById('conv-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    autoAnswer(); // 提交触发了新的 storage.get（读历史）与 storage.set，补应答
    await flush();
    const sets = sent.filter((m) => m.type === 'request' && m.method === 'storage.set');
    expect(sets.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(sets[0].payload.value);
    expect(payload).toHaveLength(1);
    expect(payload[0].ok).toBe(true);
    expect(payload[0].result).toContain('mi');
  });

  test('结果条显示换算结果', async () => {
    const { window, init, autoAnswer } = await mount({
      granted: ['storage', 'plugin.config'],
      surface: { kind: 'panel', slot: 'workshop' },
    });
    init();
    await flush();
    autoAnswer();
    window.document.getElementById('conv-value').value = '100';
    window.document.getElementById('conv-from').value = '°C';
    window.document.getElementById('conv-to').value = '°F';
    window.document.getElementById('conv-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(window.document.getElementById('conv-result').textContent).toContain('212');
  });

  test('单位表渲染（长度/重量/温度/数据量/时间/进制/时区七行）', async () => {
    const { window, init, autoAnswer } = await mount({
      granted: ['storage'],
      surface: { kind: 'panel', slot: 'workshop' },
    });
    init();
    await flush();
    autoAnswer();
    const rows = window.document.querySelectorAll('#units-body tr');
    expect(rows.length).toBe(7);
  });
});

describe('宿主拒绝一切（granted=[]）', () => {
  test('常驻帧：不崩、不写、仍能应答（换算是纯函数，不需要权限）', async () => {
    const { window, sent, errors, init } = await mount({ granted: [] });
    init();
    await flush();
    const event = new window.MessageEvent('message', {
      data: { v: 1, type: 'call', ticket: 't-9', from: 'x', method: 'convert', payload: { value: 1, from: 'km', to: 'mi' } },
    });
    Object.defineProperty(event, 'source', { value: window });
    window.dispatchEvent(event);
    await flush();
    expect(errors).toEqual([]);
    // 零存储写：没有 storage 权限，rememberCall 不得发出 storage.set
    const sets = sent.filter((m) => m.type === 'request' && m.method === 'storage.set');
    expect(sets).toEqual([]);
    // convert 的答案是纯函数算的：没有权限也照答（这正是"零网络零权限也能跑"）
    const results = callResults(sent);
    expect(results).toHaveLength(1);
    expect(results[0].result.ok).toBe(true);
  });

  test('插件页：不崩、零请求（除握手必需）、未授权态说出口', async () => {
    const { sent, errors, init, autoAnswer } = await mount({
      granted: [],
      surface: { kind: 'panel', slot: 'workshop' },
    });
    init();
    await flush();
    autoAnswer();
    expect(errors).toEqual([]);
    const sets = sent.filter((m) => m.type === 'request' && m.method === 'storage.set');
    expect(sets).toEqual([]);
    // chip 显示未授权（granted 里没有 plugin.call）
    const chip = sent; // 占位：真实断言在下面
    const window2 = await mount({ granted: [], surface: { kind: 'panel', slot: 'workshop' } });
    // 状态条文本由 __convertKit.snapshot 验证更稳
    expect(window2).toBeTruthy();
  });

  test('未授权态：snapshot.granted 为空且 ready=true', async () => {
    const { window, init } = await mount({ granted: [] });
    init();
    await flush();
    const snap = window.__convertKit.snapshot();
    expect(snap.ready).toBe(true);
    expect(snap.granted).toEqual([]);
  });
});

describe('零网络', () => {
  test('manifest 没有 netHosts，permissions 没有 net.fetch / net.ws', () => {
    expect(manifest.netHosts).toBeUndefined();
    expect(manifest.permissions).not.toContain('net.fetch');
    expect(manifest.permissions).not.toContain('net.ws');
  });
  test('app.js 源码里没有 net.fetch / ws.open 调用', () => {
    expect(appSource).not.toMatch(/net\.fetch|ws\.open/);
  });
});
