import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 换算工具插件的行为测试：驱动的是 panel.html 里真实加载的那几支脚本。
//
// harness 与 plugin-imgbed.test.js 同型：vitest 的 jsdom 全局 window 当作插件的 window，拼起来的
// 源码用 new Function 丢进一个新函数作用域（等于浏览器里那几支经典 script 共享一个作用域），
// 出站 postMessage 用 spy 记下来，`drain` 每拍把还没答的请求答掉。
//
// 这个文件钉住的四段（任务书要求的三段各在里面）：
//
//   1. 握手：ready / init / 两副面孔（workshop 画页面、background 什么都不画）；
//      `granted=[]` 时一个需要权限的请求都不发。
//   2. 主路径：20 多组换算（长度/重量/体积/温度/速度/时区/进制/汇率）经 **plugin.call** 走一轮，
//      连同 `serves.convert` 的 payload 与返回形状一起钉住。
//   3. 拒绝：未知单位 / 未知分类 / 未知进制 / 非法数字 / 非法时刻 / 未知方法都必须**点名**回一条
//      中文 error，绝不静默按 1:1 换算。
//   4. 宿主管什么都拒绝时：不崩、不写一个字节的私有数据，而换算本身照常能答（它是纯本地算术）。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-convert-kit');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');
const source = scriptSources
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-convert-kit';
const FIXED_FILES = ['panel.html', 'app.js', 'style.css'];

// --- manifest -----------------------------------------------------------------

describe('manifest', () => {
  test('三项权限，没有 net.fetch / pet.surface / pet.bubble / llm.chat', () => {
    expect([...manifest.permissions].sort()).toEqual(['plugin.call', 'plugin.config', 'storage']);
    for (const banned of ['net.fetch', 'net.credentials', 'pet.surface', 'pet.bubble', 'llm.chat', 'events', 'process', 'net.ws', 'audio', 'plugin.share', 'llm.borrow']) {
      expect(manifest.permissions, `这个插件是纯本地计算，不该要 ${banned}`).not.toContain(banned);
    }
    // 零网络的另一半：没有白名单就说明它没有网络能力。
    expect(manifest.netHosts).toBeUndefined();
  });

  test('只在控制中心铺页面，另加一帧常驻帧来答 plugin.call', () => {
    expect(manifest.panel).toBe(true);
    expect(manifest.surface).toBeUndefined();
    // 常驻帧不是可选的：serves 要有人接电话（没有帧时调用只会立刻拿到"没有帧"）。
    expect(manifest.background).toBe(true);
    expect(manifest.permissions).toContain('plugin.call');
    expect(manifest.serves).toEqual(['convert']);
    expect(manifest.entry).toBe('panel.html');
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.author).toBe('shixiansi');
  });

  test('三个设置项：保留位数 / 默认分类 / 是否显示汇率，没有 secret 与 hostWhitelist', () => {
    const byKey = Object.fromEntries(manifest.config.map((item) => [item.key, item]));
    expect(Object.keys(byKey).sort()).toEqual(['decimals', 'defaultCategory', 'showRates']);

    expect(byKey.decimals.type).toBe('number');
    expect(byKey.decimals.default).toBe('2');

    expect(byKey.defaultCategory.type).toBe('select');
    expect(byKey.defaultCategory.default).toBe('length');
    expect(byKey.defaultCategory.options.map((option) => option.value)).toEqual([
      'length', 'weight', 'volume', 'temperature', 'speed', 'timezone', 'base',
    ]);

    expect(byKey.showRates.type).toBe('bool');
    expect(byKey.showRates.default).toBe('true');

    // 一个不联网、不存密钥的插件不该有这两样：它们会变成安装对话框里两句用户没法判断的授权。
    expect(manifest.config.filter((item) => item.secret === true || item.hostWhitelist === true)).toHaveLength(0);
  });

  test('页面引用的每个本地文件都会进包，ui.css 与 docs/ui 那份逐字节相同', () => {
    for (const src of scriptSources) {
      if (FIXED_FILES.includes(src)) continue;
      expect(manifest.assets).toContain(src);
    }
    expect(manifest.assets).toContain('ui.css');
    for (const asset of manifest.assets) {
      expect(existsSync(path.join(pluginDir, asset)), `manifest.assets 里的 ${asset} 不存在`).toBe(true);
    }
    expect(existsSync(path.join(pluginDir, manifest.entry))).toBe(true);

    // 手册 §8.6 的硬规矩：包内那份必须与 docs/ui/petpc-ui.css 逐字节相同（副本分叉是静默腐坏）。
    const upstream = readFileSync(path.join(here, '..', 'docs', 'ui', 'petpc-ui.css'));
    const shipped = readFileSync(path.join(pluginDir, 'ui.css'));
    expect(shipped.equals(upstream), 'ui.css 和 docs/ui/petpc-ui.css 已经分叉了').toBe(true);
  });

  test('style.css 里没有十六进制色值，颜色只能来自 ui.css 的 token', () => {
    const own = readFileSync(path.join(pluginDir, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(own.match(/#[0-9a-fA-F]{3,8}\b/g) || []).toEqual([]);
    // 它仍然要在 :root 上写明透明与 color-scheme：同一份文档也可能被挂到没有底色的容器里。
    expect(own).toMatch(/:root\s*\{[^}]*background\s*:\s*transparent/);
    expect(own).toMatch(/color-scheme\s*:\s*only\s+light/);
  });
});

// --- harness -----------------------------------------------------------------

let store;
let configValues;
let denyAll;
let answered;
let postedFrom;
let windowListeners;
let timers;

function posted() {
  return window.postMessage.mock.calls.map((call) => call[0]).slice(postedFrom);
}

function byType(type) {
  return posted().filter((message) => message && message.type === type);
}

function requests() {
  return byType('request').map((message) => ({ id: message.id, method: message.method, payload: message.payload }));
}

function hostSends(data) {
  window.dispatchEvent(new MessageEvent('message', { data, source: window }));
}

function answer(id, result, { ok = true, error = '' } = {}) {
  answered.add(id);
  hostSends({ v: 1, type: 'response', id, ok, result, error });
}

/** 每拍把还没答的请求答掉，再让出一拍——Promise 链在下一拍产生下一个请求。 */
async function drain(rounds = 24) {
  for (let i = 0; i < rounds; i += 1) {
    for (const req of requests().filter((item) => !answered.has(item.id))) {
      const payload = req.payload || {};
      if (denyAll) {
        // 「宿主拒绝一切」那一遍：每条都拒，而且**什么都不落盘**。
        answer(req.id, null, { ok: false, error: `模拟拒绝：未获权限（${req.method}）` });
        continue;
      }
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
        default:
          answer(req.id, null, { ok: false, error: `本程序不支持该方法 ${req.method}` });
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
  for (const id of timers) clearTimeout(id);
  timers = [];
  postedFrom = window.postMessage.mock.calls.length;
  // eslint-disable-next-line no-new-func
  new Function(source)();
}

/** 装一份帧。`slot` 决定它是控制中心的插件页还是桌宠挂的常驻帧。 */
async function boot({ slot = 'workshop', granted = manifest.permissions, mode = 'ok' } = {}) {
  denyAll = mode === 'deny';
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
    host: { program: slot === 'workshop' ? 'workshop' : 'pet', methods: [] },
  });
  await drain(10);
}

/** 走真实那条路：宿主发一条 `call`，插件回一条 `call-result`。 */
function startCall(payload, method = 'convert') {
  const before = byType('call-result').length;
  const ticket = `t-${Math.random().toString(36).slice(2, 8)}`;
  hostSends({ v: 1, type: 'call', ticket, from: 'com.shixiansi.plugin-chat', method, payload });
  return () => {
    const list = byType('call-result').slice(before);
    expect(list.length, 'plugin.call 一直没有回包').toBeGreaterThan(0);
    return list[list.length - 1];
  };
}

async function convert(payload, method) {
  const taken = startCall(payload, method);
  await drain(6);
  return taken();
}

/** 一次成功换算：返回 result，并把 task 的名字带进断言消息里。 */
async function convertOk(payload, label) {
  const packet = await convert(payload);
  expect(packet.ok, `${label || JSON.stringify(payload)} 失败了：${packet.error}`).toBe(true);
  return packet.result;
}

function tab(category) {
  return document.querySelector(`#tabs .tab[data-category="${category}"]`);
}

function selectValue(slot) {
  return document.querySelector(`#${slot}-slot .select-value`).textContent;
}

beforeEach(() => {
  store = new Map();
  configValues = { decimals: '2', defaultCategory: 'length', showRates: 'true' };
  denyAll = false;
  windowListeners = [];
  timers = [];
  const originalAdd = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(function (type, fn, opts) {
    windowListeners.push([type, fn, opts]);
    return originalAdd(type, fn, opts);
  });
  const originalTimeout = window.setTimeout.bind(window);
  vi.spyOn(window, 'setTimeout').mockImplementation((fn, ms, ...rest) => {
    const id = originalTimeout(fn, ms, ...rest);
    timers.push(id);
    return id;
  });
  vi.spyOn(window, 'postMessage').mockImplementation(() => {});
});

afterEach(() => {
  for (const id of timers) clearTimeout(id);
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  vi.restoreAllMocks();
});

// --- 第一段：握手 -------------------------------------------------------------

describe('握手', () => {
  test('workshop 帧：发了 ready、收到 init，插件页画出来了', async () => {
    await boot();
    expect(byType('ready')).toHaveLength(1);
    expect(document.getElementById('workshop').hidden).toBe(false);
    // 八个分类；默认长度、默认那一对是 米→英尺，并且打开就已经算过示例。
    expect(document.querySelectorAll('#tabs .tab')).toHaveLength(8);
    expect(tab('length').getAttribute('aria-selected')).toBe('true');
    expect(selectValue('from')).toBe('米 · m');
    expect(selectValue('to')).toBe('英尺 · ft');
    expect(document.getElementById('result-value').textContent).toBe('41.01');
    expect(document.getElementById('result-expr').textContent).toBe('12.5 m = 41.01 ft');
  });

  test('background 帧：什么都不画，只把设置读进来（好在 plugin.call 里按用户的位数格式化）', async () => {
    await boot({ slot: 'background' });
    expect(document.getElementById('workshop').hidden).toBe(true);
    // 一个请求：config.get。它不为界面服务，而是为了 text。
    expect(requests().map((req) => req.method)).toEqual(['config.get']);
  });

  test('granted=[] 时一个需要权限的请求都不发，页面照样能用', async () => {
    await boot({ granted: [] });
    expect(requests()).toHaveLength(0);
    expect(document.querySelectorAll('#tabs .tab')).toHaveLength(8);
    // 说不出口的降级是坏降级：状态行要写明"这次不会记住你的单位"。
    expect(document.getElementById('status').textContent).toContain('storage');
    expect(document.getElementById('result-value').textContent).toBe('41.01');
  });

  test('设置里 showRates=false 时，汇率那一栏不出现（convert 的汇率分类照常能问）', async () => {
    configValues.showRates = 'false';
    await boot();
    expect(document.querySelectorAll('#tabs .tab')).toHaveLength(7);
    expect(tab('currency')).toBeNull();
    const out = await convertOk({ category: 'currency', from: 'USD', to: 'CNY', value: 100 }, '汇率');
    expect(out.text).toBe('724');
  });
});

// --- 第二段：主路径（20 多组换算，经 plugin.call） -----------------------------

describe('长度 4 组', () => {
  test('米→英尺 / 千米→英里 / 厘米→英寸 / 海里→米', async () => {
    await boot({ slot: 'background' });

    const ft = await convertOk({ category: 'length', from: 'm', to: 'ft', value: 12.5 }, 'm→ft');
    expect(ft.text).toBe('41.01');
    expect(ft.value).toBeCloseTo(41.0104986876, 8);
    expect(ft.expression).toBe('12.5 m = 41.01 ft');

    const mi = await convertOk({ category: 'length', from: 'km', to: 'mi', value: 10 }, 'km→mi');
    expect(mi.text).toBe('6.21');
    expect(mi.value).toBeCloseTo(6.2137119224, 8);

    const inch = await convertOk({ category: 'length', from: 'cm', to: 'in', value: 2.54 }, 'cm→in');
    expect(inch.text).toBe('1');
    expect(inch.value).toBeCloseTo(1, 10);

    const nmi = await convertOk({ category: 'length', from: 'nmi', to: 'm', value: 1 }, 'nmi→m');
    expect(nmi.text).toBe('1852');
    expect(nmi.value).toBe(1852);
  });
});

describe('重量 3 组', () => {
  test('千克→磅 / 磅→盎司 / 吨→千克', async () => {
    await boot({ slot: 'background' });

    const lb = await convertOk({ category: 'weight', from: 'kg', to: 'lb', value: 1 }, 'kg→lb');
    expect(lb.text).toBe('2.2');
    expect(lb.value).toBeCloseTo(2.2046226218, 8);

    const oz = await convertOk({ category: 'weight', from: 'lb', to: 'oz', value: 1 }, 'lb→oz');
    expect(oz.text).toBe('16');
    expect(oz.value).toBeCloseTo(16, 10);

    const kg = await convertOk({ category: 'weight', from: 't', to: 'kg', value: 2.5 }, 't→kg');
    expect(kg.text).toBe('2500');
    expect(kg.value).toBe(2500);
  });
});

describe('体积 2 组', () => {
  test('升→毫升 / 加仑（美制）→升', async () => {
    await boot({ slot: 'background' });

    const ml = await convertOk({ category: 'volume', from: 'l', to: 'ml', value: 0.5 }, 'l→ml');
    expect(ml.text).toBe('500');
    expect(ml.value).toBeCloseTo(500, 10);

    const l = await convertOk({ category: 'volume', from: 'gal', to: 'l', value: 1 }, 'gal→l');
    expect(l.text).toBe('3.79');
    expect(l.value).toBeCloseTo(3.785411784, 10);
  });
});

describe('温度 4 组（含两个方向与绝对零度下界）', () => {
  test('°C→°F / °F→°C / °C→K / 低于绝对零度被夹住', async () => {
    await boot({ slot: 'background' });

    const f = await convertOk({ category: 'temperature', from: 'c', to: 'f', value: 100 }, '100°C→°F');
    expect(f.text).toBe('212');
    expect(f.clamped).toBeUndefined();

    const c = await convertOk({ category: 'temperature', from: 'f', to: 'c', value: 32 }, '32°F→°C');
    expect(c.text).toBe('0');
    expect(c.value).toBeCloseTo(0, 10);

    const k = await convertOk({ category: 'temperature', from: 'c', to: 'k', value: -273.15 }, '−273.15°C→K');
    expect(k.text).toBe('0');
    expect(k.value).toBeCloseTo(0, 10);

    const clamped = await convertOk({ category: 'temperature', from: 'c', to: 'f', value: -300 }, '−300°C→°F');
    // 绝对零度以下不存在：夹在 −273.15 °C，也就是 −459.67 °F，并且把这件事说出来。
    expect(clamped.text).toBe('-459.67');
    expect(clamped.value).toBeCloseTo(-459.67, 6);
    expect(clamped.clamped).toBe(true);
    expect(clamped.note).toContain('绝对零度');
    expect(clamped.note).toContain('-300');
  });
});

describe('速度 2 组', () => {
  test('千米/时→米/秒 / 英里/时→千米/时', async () => {
    await boot({ slot: 'background' });

    const mps = await convertOk({ category: 'speed', from: 'kmh', to: 'mps', value: 36 }, '36km/h→m/s');
    expect(mps.text).toBe('10');
    expect(mps.value).toBeCloseTo(10, 10);

    const kmh = await convertOk({ category: 'speed', from: 'mph', to: 'kmh', value: 1 }, '1mph→km/h');
    expect(kmh.text).toBe('1.61');
    expect(kmh.value).toBeCloseTo(1.609344, 8);
  });
});

describe('时区 2 组（含跨日）', () => {
  test('UTC+8 的 23:30 → UTC 是同一天的 15:30', async () => {
    await boot({ slot: 'background' });
    const out = await convertOk({ category: 'timezone', from: 'UTC+8', to: 'UTC', time: '23:30' }, 'UTC+8→UTC');
    expect(out.text).toBe('15:30');
    expect(out.dayShift).toBe(0);
    expect(out.input).toBe('23:30');
    expect(out.expression).toBe('UTC+8 23:30 = UTC 15:30');
  });

  test('UTC 的 23:30 → UTC+8 是次日的 07:30', async () => {
    await boot({ slot: 'background' });
    const out = await convertOk({ category: 'timezone', from: 'UTC', to: 'UTC+8', time: '23:30' }, 'UTC→UTC+8');
    expect(out.text).toBe('07:30');
    expect(out.dayShift).toBe(1);
    expect(out.expression).toBe('UTC 23:30 = UTC+8 07:30（次日）');
    expect(out.note).toContain('第二天');
  });

  test('半小时偏移：UTC+5:30 的 22:10 → UTC+8 是次日的 00:40', async () => {
    await boot({ slot: 'background' });
    const out = await convertOk({ category: 'timezone', from: 'UTC+5:30', to: 'UTC+8', time: '22:10' }, 'UTC+5:30→UTC+8');
    expect(out.text).toBe('00:40');
    expect(out.dayShift).toBe(1);
  });
});

describe('进制 4 组（含负数）', () => {
  test('十进制→二进制 / 十进制→十六进制（负数）/ 十六进制→十进制 / 八进制→十进制', async () => {
    await boot({ slot: 'background' });

    const bin = await convertOk({ category: 'base', from: '10', to: '2', value: '255' }, '255→bin');
    expect(bin.text).toBe('11111111');
    expect(bin.value).toBe(255);

    const hex = await convertOk({ category: 'base', from: '10', to: '16', value: '-255' }, '-255→hex');
    expect(hex.text).toBe('-FF');
    expect(hex.value).toBe(-255);

    const dec = await convertOk({ category: 'base', from: '16', to: '10', value: 'ff' }, 'ff→dec');
    expect(dec.text).toBe('255');
    expect(dec.value).toBe(255);

    const oct = await convertOk({ category: 'base', from: '8', to: '10', value: '17' }, '17(oct)→dec');
    expect(oct.text).toBe('15');
    expect(oct.value).toBe(15);
  });
});

describe('汇率 3 组（内置静态快照）', () => {
  test('USD↔CNY 两个方向自洽 / JPY→CNY', async () => {
    await boot({ slot: 'background' });

    const cny = await convertOk({ category: 'currency', from: 'USD', to: 'CNY', value: 100 }, '100USD→CNY');
    expect(cny.text).toBe('724');
    expect(cny.value).toBeCloseTo(724, 10);
    expect(cny.note).toContain('2026-11-01');

    // 反方向必须回到同一个数：静态汇率表最容易错的地方是"只对了正方向"。
    const usd = await convertOk({ category: 'currency', from: 'CNY', to: 'USD', value: 724 }, '724CNY→USD');
    expect(usd.text).toBe('100');
    expect(usd.value).toBeCloseTo(100, 8);

    const jpy = await convertOk({ category: 'currency', from: 'JPY', to: 'CNY', value: 10000 }, '10000JPY→CNY');
    expect(jpy.text).toBe('478.52');
    expect(jpy.value).toBeCloseTo(478.5194977, 6);
  });
});

describe('serves.convert 的形状', () => {
  test('返回值字段是钉住的：少字段就是破坏契约', async () => {
    await boot({ slot: 'background' });
    const out = await convertOk({ category: 'length', from: 'm', to: 'ft', value: 12.5 }, '形状');
    expect(Object.keys(out).sort()).toEqual([
      'category', 'expression', 'from', 'input', 'text', 'to', 'unit', 'value',
    ]);
    expect(out.category).toBe('length');
    // from / to 一律回**单位 id**，不是你写进来的中文名或符号。
    expect(out.from).toBe('m');
    expect(out.to).toBe('ft');
    expect(out.unit).toBe('ft');
    expect(out.input).toBe(12.5);
  });

  test('单位写中文名也认，但返回的仍是 id', async () => {
    await boot({ slot: 'background' });
    const out = await convertOk({ category: '重量', from: '千克', to: '磅', value: 1 }, '中文单位');
    expect(out.from).toBe('kg');
    expect(out.to).toBe('lb');
    expect(out.text).toBe('2.2');
  });

  test('保留位数来自插件设置（decimals=0 时结果没有小数）', async () => {
    configValues.decimals = '0';
    await boot({ slot: 'background' });
    const out = await convertOk({ category: 'length', from: 'm', to: 'ft', value: 1 }, 'decimals=0');
    expect(out.text).toBe('3');
    // value 仍是原始精度：截断的是显示，不是数据。
    expect(out.value).toBeCloseTo(3.280839895, 8);
  });
});

describe('精度：不吐二进制浮点的尾巴', () => {
  test('0.1 + 0.2 说 0.3，不是 0.30000000000000004', async () => {
    await boot({ slot: 'background' });
    const out = await convertOk({ category: 'length', from: 'm', to: 'm', value: 0.1 + 0.2 }, '0.1+0.2');
    expect(out.text).toBe('0.3');
    expect(out.text).not.toContain('30000000000000004');
    expect(out.expression).toBe('0.3 m = 0.3 m');
  });

  test('比精度还小的非零值不会被说成 0', async () => {
    await boot({ slot: 'background' });
    const out = await convertOk({ category: 'length', from: 'm', to: 'mm', value: 1e-9 }, '1e-9 m→mm');
    expect(out.text).not.toBe('0');
    expect(out.text).toBe('0.000001');
  });
});

// --- 第三段之一：点名拒绝 -----------------------------------------------------

describe('不认识的东西点名拒绝，绝不静默按 1:1 换算', () => {
  test('未知单位「斤」：error 里带上那个名字，而且把认识的一并念出来', async () => {
    await boot({ slot: 'background' });

    const from = await convert({ category: 'weight', from: '斤', to: 'kg', value: 1 });
    expect(from.ok).toBe(false);
    expect(from.result).toBeUndefined();
    expect(from.error).toContain('斤');
    expect(from.error).toContain('不认识单位');
    expect(from.error).toContain('kg');

    // 目标端同样拒绝：只在 from 上校验，`to` 就会被当成"1:1"。
    const to = await convert({ category: 'weight', from: 'kg', to: '市斤', value: 1 });
    expect(to.ok).toBe(false);
    expect(to.error).toContain('市斤');
  });

  test('未知分类、未知进制、非法数字、非法时刻各自点名', async () => {
    await boot({ slot: 'background' });

    const category = await convert({ category: '面积', from: 'm', to: 'ft', value: 1 });
    expect(category.ok).toBe(false);
    expect(category.error).toContain('面积');
    expect(category.error).toContain('长度');

    const radix = await convert({ category: 'base', from: '3', to: '10', value: '11' });
    expect(radix.ok).toBe(false);
    expect(radix.error).toContain('进制');
    expect(radix.error).toContain('3');

    const digits = await convert({ category: 'base', from: '2', to: '10', value: '12' });
    expect(digits.ok).toBe(false);
    expect(digits.error).toContain('二进制');

    const prefix = await convert({ category: 'base', from: '16', to: '10', value: '0xff' });
    expect(prefix.ok).toBe(false);
    expect(prefix.error).toContain('前缀');

    const clock = await convert({ category: 'timezone', from: 'UTC+8', to: 'UTC', time: '25:99' });
    expect(clock.ok).toBe(false);
    expect(clock.error).toContain('25:99');

    const notNumber = await convert({ category: 'length', from: 'm', to: 'ft', value: 'abc' });
    expect(notNumber.ok).toBe(false);
    expect(notNumber.error).toContain('abc');
  });

  test('未知方法回一条说得清的中文 error，不回 silence', async () => {
    await boot({ slot: 'background' });
    const packet = await convert({}, 'resize');
    expect(packet.ok).toBe(false);
    expect(packet.error).toContain('resize');
    expect(packet.error).toContain('convert');
  });
});

// --- 第三段之二：宿主拒绝一切 -------------------------------------------------

describe('宿主拒绝一切时', () => {
  test('不崩、不写盘，而换算本身照常答得上（它是纯本地算术）', async () => {
    await boot({ mode: 'deny' });

    // 「不写数据」是这一条的重点：拒绝之后插件不该再用别的路径把东西塞进私有目录。
    expect(store.size).toBe(0);
    // 页面还在，没有抛到 window 上的错误（有的话 vitest 会因为未处理异常红）。
    expect(document.querySelectorAll('#tabs .tab')).toHaveLength(8);

    const packet = await convert({ category: 'length', from: 'm', to: 'ft', value: 12.5 });
    expect(packet.ok).toBe(true);
    expect(packet.result.text).toBe('41.01');
    expect(store.size).toBe(0);
  });

  test('用户自己按「换算」也不写盘、不把错误说成"出错了"', async () => {
    await boot({ mode: 'deny' });
    document.getElementById('amount').value = '2';
    document.getElementById('run').click();
    await drain(6);
    expect(document.getElementById('result-value').textContent).toBe('6.56');
    expect(store.size).toBe(0);
  });
});

// --- 插件页的主路径（DOM） -----------------------------------------------------

describe('插件页', () => {
  test('按下「换算」→ 结果 + 最近换算 + 记住上次用的那对单位', async () => {
    await boot();

    document.getElementById('amount').value = '1';
    document.getElementById('run').click();
    await drain(6);
    expect(document.getElementById('result-value').textContent).toBe('3.28');
    expect(document.getElementById('result-expr').textContent).toBe('1 m = 3.28 ft');

    const rows = [...document.querySelectorAll('#recent .recent-row')];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toBe('1 m = 3.28 ft');

    // 键是相对路径（≤4 段、每段只能是 [A-Za-z0-9_-]），不带扩展名。
    expect([...store.keys()]).toEqual(['state/last-units']);
    for (const key of store.keys()) {
      for (const segment of key.split('/')) expect(segment).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    }
    expect(JSON.parse(store.get('state/last-units'))).toEqual({ category: 'length', from: 'm', to: 'ft' });
  });

  test('「对调」把两端换过来并立刻重算', async () => {
    await boot();
    const [amount, run, swap] = ['amount', 'run', 'swap'].map((id) => document.getElementById(id));
    amount.value = '1';
    run.click();
    await drain(4);
    swap.click();
    await drain(4);

    expect(selectValue('from')).toBe('英尺 · ft');
    expect(selectValue('to')).toBe('米 · m');
    expect(document.getElementById('result-value').textContent).toBe('0.3');
    expect(document.getElementById('result-expr').textContent).toBe('1 ft = 0.3 m');
  });

  test('切分类会换掉两个下拉框、数值示例与那一句"它不做什么"', async () => {
    await boot();
    tab('temperature').click();
    await drain(6);

    expect(selectValue('from')).toBe('摄氏度 · °C');
    expect(selectValue('to')).toBe('华氏度 · °F');
    expect(document.getElementById('amount').value).toBe('100');
    expect(document.getElementById('result').hidden).toBe(true); // 切过去不自动算，等用户按

    document.getElementById('run').click();
    await drain(6);
    expect(document.getElementById('result-value').textContent).toBe('212');

    tab('timezone').click();
    await drain(6);
    expect(document.getElementById('amount').value).toBe('23:30');
    expect(document.getElementById('kind-hint').textContent).toContain('夏令时');
    expect(document.getElementById('kind-hint').hidden).toBe(false);
  });

  test('自绘下拉框：点开、选中一项，下一次换算就用它', async () => {
    await boot();
    tab('base').click();
    await drain(6);

    document.querySelector('#from-slot .select-trigger').click();
    const options = [...document.querySelectorAll('#from-slot .select-option')];
    expect(options.length).toBe(4);
    options.find((item) => item.dataset.value === '2').click();
    expect(selectValue('from')).toBe('二进制 · 2');

    document.getElementById('amount').value = '12';
    document.getElementById('run').click();
    await drain(6);
    // 12 不是二进制数：错误要原样显示在页面上，并说清是哪一类。
    expect(document.getElementById('error').textContent).toContain('二进制');
    expect(document.getElementById('result').hidden).toBe(true);
  });

  test('清空最近换算只是丢掉内存里那一列（不删任何存储键）', async () => {
    await boot();
    expect(document.querySelectorAll('#recent .recent-row')).toHaveLength(1);
    const before = new Map(store);
    document.getElementById('recent-clear').click();
    expect(document.querySelectorAll('#recent .recent-row')).toHaveLength(0);
    expect(document.getElementById('recent-empty').hidden).toBe(false);
    expect(document.getElementById('recent-clear').disabled).toBe(true);
    expect(store).toEqual(before);
  });

  test('上一次记住的那对单位会在下次打开时被用上', async () => {
    store.set('state/last-units', JSON.stringify({ category: 'speed', from: 'mph', to: 'kmh' }));
    await boot();
    expect(tab('speed').getAttribute('aria-selected')).toBe('true');
    expect(selectValue('from')).toBe('英里/时 · mph');
    expect(selectValue('to')).toBe('千米/时 · km/h');
  });
});
