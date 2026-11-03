import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 表格分析插件的行为测试：驱动的是 panel.html 里真实加载的那几支脚本。
//
// harness 与 imgbed / websearch 那几份同型：vitest 的 jsdom 全局 window 当作插件的 window，
// 拼起来的源码用 new Function 丢进一个新函数作用域（等于浏览器里那几支经典 script 共享一个
// 作用域），出站 postMessage 用 spy 记下来。文件用 jsdom **真实**的 File/FileReader 驱动——
// 这是"上传只经 FileReader"那条断言能成立的前提：桩掉解码器就等于绕开了要证明的那件事。
//
// 这个文件钉住的几件事：
//
//   1. manifest 的形状：只申请四项权限（含 pet.surface——声明了 surface 就**必须**申请它，
//      否则宿主打得开清单、却永远点不开那张卡片）、落点是 panel + 一块 300×150 的 surface、
//      不需要 background / serves（模型只在桌宠那边调）；
//   2. 四种 CSV 输入：空文件、只有一列、字段里的逗号与转义引号、UTF-8 BOM；
//   3. 类型推断：整数 / 小数 / 日期 / 文本各一条，空单元格不算证据，整列全空是"空列"；
//   4. 分组统计：给定小表，计数与排序逐条断言（含并列时按取值升序）；
//   5. SVG：真的产出一个 <svg>，每个分组一个 <rect>，宽度随行数递减；
//   6. 不读磁盘路径：源码里没有 process.*/绝对路径，读文件只经 readAsText（连 encoding
//      选项都是它的第二个参数，插件自己不解码）；
//   7. llm.chat 只在卡片上发，而且喂给模型的只有浓缩摘要；被拒时把宿主原话显示出来，
//      而卡片上那两行统计（行列数、分组结论）一个字都不动；
//   8. 宿主拒绝一切时：本地分析照常（它不依赖宿主），但什么都不写进私有目录。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-table-lab');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');
const source = scriptSources.map((src) => readFileSync(path.join(pluginDir, src), 'utf8')).join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-table-lab';
const SUMMARY_KEY = 'summary/current';
const SVG_NS = 'http://www.w3.org/2000/svg';

/** 桌宠专属的方法（手册 §9 那张表的机器可读副本），控制中心那一次挂载不服务它们。 */
const PET_ONLY = new Set(['llm.chat']);

const ALL_METHODS = ['config.get', 'config.set', 'storage.get', 'storage.set', 'storage.remove', 'llm.chat'];

function servedMethods(slot) {
  return ALL_METHODS.filter((method) => slot !== 'workshop' || !PET_ONLY.has(method));
}

describe('manifest', () => {
  test('只申请它用到的四项权限，而且没有 process（不碰本机程序）', () => {
    expect([...manifest.permissions].sort()).toEqual(['llm.chat', 'pet.surface', 'plugin.config', 'storage']);
    expect(manifest.permissions).not.toContain('process');
    expect(manifest.sidecar).toBeUndefined();
  });

  // 这一条是给"下一个改 manifest 的人"画的线，也是这次返工的原因：宿主 OpenPluginSurface
  // 在打开浮层面的那一刻**硬判** pet.surface（app_plugin_surface.go），而 manifest 校验
  // 并不检查这一对。两边不一致的话，插件装得上、卡片却永远点不开——没有报错、没有日志，
  // 就是"点了一下什么都没发生"。
  test('声明了 surface 就必须申请 pet.surface；申请了却没人用的权限一个都不留', () => {
    expect(manifest.surface.length).toBeGreaterThan(0);
    expect(manifest.permissions).toContain('pet.surface');
    // 每一项权限都得有一处真实用途：要么代码里真的调了它 gate 的方法，要么浮层面本身就靠它。
    const usedBySource = {
      storage: /'storage\./.test(source),
      'plugin.config': /'config\./.test(source),
      'llm.chat': /'llm\.chat'/.test(source),
      'pet.surface': manifest.surface.length > 0,
    };
    const idle = manifest.permissions.filter((permission) => !usedBySource[permission]);
    expect(idle, `这些权限申请了却没有任何用途：${idle.join('、')}`).toEqual([]);
    // 气泡不在其中：结论就写在卡片上，喊一嗓子只会让用户在安装对话框里多答一个空开关。
    expect(manifest.permissions).not.toContain('pet.bubble');
    expect(source).not.toContain("'bubble.say'");
  });

  test('落点是 panel + 一块 300×150 的紧凑卡片，不需要 background / serves', () => {
    expect(manifest.panel).toBe(true);
    expect(manifest.background).toBeUndefined();
    expect(manifest.serves).toBeUndefined();
    expect(manifest.surface).toHaveLength(1);
    expect(manifest.surface[0]).toMatchObject({ dx: 160, dy: -160, w: 300, h: 150, radius: 14 });
  });

  test('三项设置：预览行数 / 分隔符 / 默认字符集', () => {
    const byKey = Object.fromEntries(manifest.config.map((item) => [item.key, item]));
    expect(Object.keys(byKey).sort()).toEqual(['delimiter', 'encoding', 'maxPreviewRows']);
    expect(byKey.maxPreviewRows.type).toBe('number');
    expect(byKey.maxPreviewRows.default).toBe('200');
    expect(byKey.delimiter.type).toBe('text');
    expect(byKey.delimiter.default).toBe(',');
    expect(byKey.encoding.type).toBe('select');
    expect(byKey.encoding.default).toBe('auto');
    expect(byKey.encoding.options.map((option) => option.value)).toEqual(['auto', 'utf-8', 'gbk']);
  });

  test('页面引用的每个本地文件都写进 assets，而且都在包里', () => {
    const fixed = ['panel.html', 'app.js', 'style.css'];
    for (const src of scriptSources) {
      if (fixed.includes(src)) continue;
      expect(manifest.assets).toContain(src);
    }
    for (const asset of manifest.assets) {
      expect(existsSync(path.join(pluginDir, asset)), `manifest.assets 里的 ${asset} 不存在`).toBe(true);
    }
    expect(existsSync(path.join(pluginDir, manifest.entry))).toBe(true);
    // 声明了浮层面的插件不整份引 ui.css（§8.6 末尾的例外）：卡片自带调色板。
    expect(existsSync(path.join(pluginDir, 'ui.css'))).toBe(false);
  });
});

// --- harness -----------------------------------------------------------------

let store;
let configValues;
let denyAll;
let denyMethods;
let chatReply;
let chatCalls;
let answered;
let postedFrom;
let windowListeners;
let intervals;
let fileReads;
let pageErrors;

function posted() {
  return window.postMessage.mock.calls.map((call) => call[0]).slice(postedFrom);
}

function byType(type) {
  return posted().filter((message) => message && message.type === type);
}

function requests() {
  return byType('request').map((message) => ({ id: message.id, method: message.method, payload: message.payload }));
}

function methodsRequested() {
  return requests().map((request) => request.method);
}

function hostSends(data) {
  window.dispatchEvent(new window.MessageEvent('message', { data, source: window }));
}

function answer(id, result, options = {}) {
  answered.add(id);
  hostSends({ v: 1, type: 'response', id, ok: options.ok !== false, result, error: options.error || '' });
}

/** 每拍把还没答的请求答掉，再让出一拍（FileReader 与 Promise 链都在下一拍产生新请求）。 */
async function drain(rounds = 24) {
  for (let i = 0; i < rounds; i += 1) {
    for (const req of requests().filter((item) => !answered.has(item.id))) {
      const payload = req.payload || {};
      if (denyAll || denyMethods.has(req.method)) {
        answer(req.id, null, { ok: false, error: `模拟拒绝：未获权限 ${req.method}` });
        continue;
      }
      switch (req.method) {
        case 'config.get':
          answer(req.id, { values: { ...configValues }, secrets: {} });
          break;
        case 'storage.get':
          answer(req.id, { value: store.has(String(payload.key)) ? store.get(String(payload.key)) : '' });
          break;
        case 'storage.set':
          store.set(String(payload.key), String(payload.value == null ? '' : payload.value));
          answer(req.id, { ok: true });
          break;
        case 'storage.remove':
          store.delete(String(payload.key));
          answer(req.id, { ok: true });
          break;
        case 'llm.chat':
          chatCalls.push(payload);
          answer(req.id, { requestId: 'sim', text: chatReply });
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
  for (const id of intervals) window.clearInterval(id);
  intervals = [];
  postedFrom = window.postMessage.mock.calls.length;
  // eslint-disable-next-line no-new-func
  new Function(source)();
}

/** 装一份帧。slot='workshop' 是控制中心那一次，其余按桌宠的卡片挂。 */
async function boot({ slot = 'workshop', granted = manifest.permissions } = {}) {
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
  loadApp();
  const surface =
    slot === 'workshop'
      ? { kind: 'panel', slot: 'workshop' }
      : {
          kind: 'surface',
          rectIndex: 0,
          rectCount: manifest.surface.length,
          rect: { x: 0, y: 0, w: 300, h: 150, r: 14, tailX: 150, hidden: false, room: 160 },
        };
  hostSends({
    v: 1,
    type: 'init',
    pluginId: PLUGIN_ID,
    permissions: manifest.permissions,
    granted: [...granted],
    surface,
    host: { program: slot === 'workshop' ? 'workshop' : 'pet', methods: servedMethods(slot) },
  });
  await drain(8);
}

function csvFile(text, name = 'a.csv') {
  const bytes = Buffer.isBuffer(text) || text instanceof Uint8Array ? text : Buffer.from(String(text), 'utf8');
  return new window.File([new Uint8Array(bytes)], name, { type: 'text/csv' });
}

/** 走真实的那条路：把文件"拖"到拖放区上。 */
function dropFile(file) {
  const zone = document.getElementById('drop');
  const event = new window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } });
  zone.dispatchEvent(event);
}

/** 解析一份 CSV（拖进来 → 等宿主答完）。 */
async function analyze(text, name = 'a.csv') {
  dropFile(csvFile(text, name));
  await drain();
}

function texts(selector) {
  return [...document.querySelectorAll(selector)].map((node) => node.textContent);
}

function typeRows() {
  return texts('#types .type-row');
}

function groupValues() {
  return texts('#group-list .group-value');
}

function groupCounts() {
  return texts('#group-list .group-count');
}

function chartRectValues() {
  return [...document.querySelectorAll('#chart svg rect')].map((rect) => rect.getAttribute('data-value'));
}

function summaryInStore() {
  const raw = store.get(SUMMARY_KEY);
  return raw ? JSON.parse(raw) : null;
}

/** 一份四列的小表：城市列用来做分组断言（3/2/2/1，两个并列按取值升序）。 */
const CITY_CSV = [
  '城市,金额,日期,备注',
  '北京,10,2026-11-01,张三说这句话只出现在一行里',
  '上海,20,2026-11-02,',
  '北京,30,2026-11-03,',
  '广州,40,2026-11-04,',
  '上海,50,2026-11-05,',
  '北京,60,2026-11-06,',
  '广州,70,2026-11-07,',
  '杭州,80,2026-11-08,',
].join('\n');

beforeEach(() => {
  store = new Map();
  configValues = { maxPreviewRows: '200', delimiter: ',', encoding: 'auto' };
  denyAll = false;
  denyMethods = new Set();
  chatReply = '这张表按城市分组，北京最多（3 行）；日期覆盖 11 月 1–8 日，是一份完整的日报。备注列大多为空，建议补齐。';
  chatCalls = [];
  windowListeners = [];
  intervals = [];
  fileReads = [];
  pageErrors = [];

  const originalAdd = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(function (type, fn, opts) {
    windowListeners.push([type, fn, opts]);
    return originalAdd(type, fn, opts);
  });
  // 记账、不拦：真正解码的是 jsdom 的 FileReader，桩掉它等于绕开"只经 FileReader"这条断言。
  const readerProto = window.FileReader.prototype;
  const realReadAsText = readerProto.readAsText;
  vi.spyOn(readerProto, 'readAsText').mockImplementation(function (file, label) {
    fileReads.push({ name: file && file.name, label });
    return realReadAsText.call(this, file, label);
  });

  const originalInterval = window.setInterval.bind(window);
  vi.spyOn(window, 'setInterval').mockImplementation((fn, ms, ...rest) => {
    const id = originalInterval(fn, ms, ...rest);
    intervals.push(id);
    return id;
  });
  const originalTimeout = window.setTimeout.bind(window);
  vi.spyOn(window, 'setTimeout').mockImplementation((fn, ms, ...rest) => originalTimeout(fn, ms, ...rest));
  vi.spyOn(window, 'postMessage').mockImplementation(() => {});

  // 未捕获错误与未处理的 Promise 拒绝都记账：宿主拒绝一切时"不崩"就是这条断言。
  window.addEventListener('error', (event) => pageErrors.push(String(event.message || event.error)));
  window.addEventListener('unhandledrejection', (event) =>
    pageErrors.push('unhandled: ' + String((event.reason && event.reason.message) || event.reason)),
  );
});

afterEach(() => {
  for (const id of intervals) window.clearInterval(id);
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  vi.restoreAllMocks();
});

// --- 握手 ---------------------------------------------------------------------

test('ready → init：工坊页画出来，卡片收起来，状态行不再停在"等待宿主初始化"', async () => {
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
  loadApp();
  // 握手之前不许发请求（手册 §5.3 第 2 条）。
  expect(byType('ready')).toHaveLength(1);
  expect(requests()).toHaveLength(0);
  expect(document.getElementById('status').textContent).toContain('等待宿主初始化');

  hostSends({
    v: 1,
    type: 'init',
    pluginId: PLUGIN_ID,
    permissions: manifest.permissions,
    granted: [...manifest.permissions],
    surface: { kind: 'panel', slot: 'workshop' },
    host: { program: 'workshop', methods: servedMethods('workshop') },
  });
  await drain(6);

  expect(document.getElementById('root').dataset.view).toBe('workshop');
  expect(document.getElementById('workshop').hidden).toBe(false);
  expect(document.getElementById('card').hidden).toBe(true);
  expect(document.getElementById('status').textContent).not.toContain('等待宿主初始化');
  // 一次设置读取：用户的行数上限/分隔符要生效。
  expect(methodsRequested()).toEqual(['config.get']);
});

// --- 四种 CSV 输入 ------------------------------------------------------------

test('空文件：界面进空状态，不发请求、不写私有目录、不崩', async () => {
  await boot();
  await analyze('', 'empty.csv');

  expect(document.getElementById('empty').hidden).toBe(false);
  expect(document.getElementById('result').hidden).toBe(true);
  expect(document.getElementById('empty').textContent).toContain('空');
  expect(store.size).toBe(0);
  expect(pageErrors).toEqual([]);
});

test('只有一列：一个类型行、一个分组按钮，分组计数照算', async () => {
  await boot();
  await analyze('城市\n北京\n北京\n上海\n');

  expect(typeRows()).toHaveLength(1);
  expect(typeRows()[0]).toContain('城市');
  expect(typeRows()[0]).toContain('文本');
  expect(texts('#group-tabs .chip')).toEqual(['按 城市']);
  expect(groupValues()).toEqual(['北京', '上海']);
  expect(groupCounts()).toEqual(['2 行', '1 行']);
  expect(document.querySelectorAll('#chart svg rect')).toHaveLength(2);
});

test('字段里的逗号与转义的双引号都还原成一个单元格，不拆列', async () => {
  await boot();
  await analyze('a,b\n"x,y",2\n"he said ""hi""",3\n');

  expect(typeRows()).toHaveLength(2);
  // 两个值各 1 行；并列时按取值升序（'h' 在 'x' 前面），所以顺序是确定的。
  expect(groupValues()).toEqual(['he said "hi"', 'x,y']);
  expect(groupCounts()).toEqual(['1 行', '1 行']);
  // 第二列是整数：字段里那个逗号没有被当成列分隔符（否则这里会多出一列）。
  expect(typeRows()[1]).toContain('整数');
  expect(document.getElementById('meta').textContent).toContain('2 行 × 2 列');
});

test('带 UTF-8 BOM 的文件：首列名不带 \\uFEFF', async () => {
  await boot();
  await analyze('\uFEFF城市,金额\n北京,1\n上海,2\n');

  const firstName = document.querySelector('#types .type-name').textContent;
  expect(firstName).toBe('城市');
  expect(firstName.charCodeAt(0)).not.toBe(0xfeff);
  expect(summaryInStore().columns[0].name).toBe('城市');
});

// --- 类型推断 -----------------------------------------------------------------

test('整数 / 小数 / 日期 / 文本各判对，空单元格不算证据，整列全空是"空列"', async () => {
  await boot();
  await analyze(
    [
      'id,qty,price,day,note,blank',
      '1,3,1.5,2026-11-03,北京,',
      '2,,2,2026/11/4,上海,',
    ].join('\n'),
  );

  const rows = typeRows();
  expect(rows).toHaveLength(6);
  expect(rows[0]).toContain('整数'); // id：1、2
  expect(rows[1]).toContain('整数'); // qty：3 与一个空单元格——空的不算证据
  expect(rows[1]).toContain('1 个值 / 1 个空');
  expect(rows[2]).toContain('小数'); // price：1.5、2
  expect(rows[3]).toContain('日期'); // day：2026-11-03、2026/11/4
  expect(rows[4]).toContain('文本'); // note
  expect(rows[5]).toContain('空列'); // blank：两个单元格都是空 → 没有类型证据
  expect(rows[5]).toContain('0 个值 / 2 个空');
});

test('格式对但日子不存在的日期落到文本（2026-02-30 不是日期）', async () => {
  await boot();
  await analyze('day\n2026-02-30\n2026-11-03\n');
  expect(typeRows()[0]).toContain('文本');
});

// --- 分组统计 -----------------------------------------------------------------

test('分组计数与排序逐条对上：行数降序，并列按取值升序', async () => {
  await boot();
  await analyze(CITY_CSV);

  // 北京 3、上海 2、广州 2、杭州 1（上海与广州并列 2 行，按码位 上 < 广）。
  expect(groupValues()).toEqual(['北京', '上海', '广州', '杭州']);
  expect(groupCounts()).toEqual(['3 行', '2 行', '2 行', '1 行']);
  expect(document.getElementById('group-line').textContent).toContain('「城市」共 4 组');
  expect(chartRectValues()).toEqual(['北京', '上海', '广州', '杭州']);
});

test('点另一列的「按 X」按钮就按那一列重算（分组是表的功能，不是一次的结论）', async () => {
  await boot();
  await analyze(CITY_CSV);
  // 默认挑分类列：城市（4 个取值），而不是「金额」（8 个各不相同的数）。
  expect(chartRectValues()).toEqual(['北京', '上海', '广州', '杭州']);

  const amountChip = [...document.querySelectorAll('#group-tabs .chip')].find((chip) => chip.textContent === '按 金额');
  amountChip.click();
  await drain(6);

  expect(document.querySelectorAll('#chart svg rect')).toHaveLength(8);
  expect(document.getElementById('group-line').textContent).toContain('「金额」共 8 组');
  expect(summaryInStore().group.column).toBe('金额');
});

test('空单元格自成一组（界面上标成「（空）」），各组加起来等于行数', async () => {
  await boot();
  await analyze('城市,金额\n北京,1\n,2\n上海,3\n');

  // 三个值各 1 行；并列时按码位升序：上(U+4E0A) < 北(U+5317) < （(U+FF08)。
  expect(groupValues()).toEqual(['上海', '北京', '（空）']);
  expect(groupCounts()).toEqual(['1 行', '1 行', '1 行']);
  // 那一组在界面上看得出来是空的，不是一个字面量。
  const blank = [...document.querySelectorAll('#group-list .group-value')].find((node) => node.textContent === '（空）');
  expect(blank.classList.contains('is-blank')).toBe(true);
  // 整行都是空的（Excel 导出常见的尾巴）不算一行数据。
  expect(document.getElementById('meta').textContent).toContain('3 行 × 2 列');
});

// --- SVG ----------------------------------------------------------------------

test('真的产出一个 <svg>，每个分组一个 <rect>，宽度按行数递减', async () => {
  await boot();
  await analyze(CITY_CSV);

  const svg = document.querySelector('#chart svg');
  expect(svg).toBeTruthy();
  expect(svg.tagName.toLowerCase()).toBe('svg');
  expect(svg.namespaceURI).toBe(SVG_NS);

  const rects = [...svg.querySelectorAll('rect')];
  expect(rects).toHaveLength(4);
  const widths = rects.map((rect) => Number(rect.getAttribute('width')));
  // 364/243/243/121：条长与行数成正比，最大值那条占满可用宽度。
  expect(widths[0]).toBeGreaterThan(widths[1]);
  expect(widths[1]).toBe(widths[2]);
  expect(widths[2]).toBeGreaterThan(widths[3]);
  // 每根条旁边有一行计数文字（不是画在条里的，SVG 里没有"文字塞进 rect"这回事）。
  expect([...svg.querySelectorAll('text')].map((node) => node.textContent)).toEqual(
    expect.arrayContaining(['3', '2', '1']),
  );
  // 没有引任何图表库/外链：图是本地 createElementNS 画出来的。
  expect(document.querySelectorAll('#chart img')).toHaveLength(0);
});

// --- 不读磁盘路径 --------------------------------------------------------------

test('上传只经 FileReader：翻页读的是用户交出来的那个 File，源码里没有 process 与绝对路径', async () => {
  await boot();
  await analyze(CITY_CSV, 'cities.csv');

  expect(fileReads).toHaveLength(1);
  expect(fileReads[0].name).toBe('cities.csv');
  // auto 不传 encoding：让浏览器按默认（UTF-8）解，插件自己不做解码。
  expect(fileReads[0].label == null || fileReads[0].label === '').toBe(true);

  // 源码层面：没有任何"绕开 FileReader"的路子。
  expect(source).not.toMatch(/process\s*\.\s*launch/);
  expect(source).not.toMatch(/process\s*\.\s*kill/);
  expect(source).not.toMatch(/readAsArrayBuffer/);
  expect(source).not.toMatch(/readAsBinaryString/);
  // 盘符路径的形状（`C:\…` / `C:/…`）：`http://` 这种 URL 也必须排除掉，否则这条断言
  // 会因为 chart.js 里那个 SVG 命名空间而误报——那是命名空间，不是磁盘。
  expect(source).not.toMatch(/\b[A-Za-z]:[\\/](?![\\/])/);
  expect(source).not.toMatch(/\brequire\s*\(/);
  // 也没向宿主问过自己的目录（那是"拿绝对路径"的另一种写法）。
  expect(methodsRequested()).not.toContain('storage.dir');
  expect(methodsRequested().sort()).toEqual(['config.get', 'storage.set']);
});

test('默认字符集选 GBK 时，encoding 作为 readAsText 的第二个参数交给浏览器', async () => {
  configValues.encoding = 'gbk';
  await boot();
  // 这四个字节就是 GBK 的「你好」——插件自己不解码，解码器是浏览器的。
  await analyze(Buffer.from([0xc4, 0xe3, 0xba, 0xc3]), 'gbk.csv');
  expect(fileReads).toHaveLength(1);
  expect(fileReads[0].label).toBe('gbk');

  configValues.encoding = 'utf-8';
  await boot();
  await analyze('城市\n北京\n');
  expect(fileReads[fileReads.length - 1].label).toBe('utf-8');
});

// --- 大文件：截断并说明 --------------------------------------------------------

test('超过预览行数就截断，界面写明只统计了前 N 行', async () => {
  configValues.maxPreviewRows = '2';
  await boot();
  await analyze('城市\n北京\n北京\n上海\n广州\n杭州\n');

  const meta = document.getElementById('meta').textContent;
  expect(meta).toContain('2 行 × 1 列');
  expect(meta).toContain('只统计了前 2 行（文件里共 5 行）');
  // 统计真的只用了前两行：北京 2，别的组不该出现。
  expect(groupValues()).toEqual(['北京']);
  const summary = summaryInStore();
  expect(summary.truncated).toBe(true);
  expect(summary.rows).toBe(2);
  expect(summary.totalRows).toBe(5);
});

// --- 模型那一格：落点按能力来定 -------------------------------------------------

test('工坊页里没有模型按钮：那是一行说明，而且一个 llm.chat 都不发', async () => {
  await boot();
  await analyze(CITY_CSV);

  expect(methodsRequested()).not.toContain('llm.chat');
  expect(methodsRequested()).not.toContain('bubble.say');
  const note = document.getElementById('llm-note');
  expect(note.hidden).toBe(false);
  expect(note.textContent).toContain('模型解读要在桌宠旁边那张卡片上点');
  expect(note.textContent).toContain('这个窗口不服务 llm.chat');
  // 卡片整个收起来——不需要在控制中心里摆一个"点了会失败"的按钮。
  expect(document.getElementById('card').hidden).toBe(true);
});

test('卡片：读到插件页写下的摘要，点一下才发 llm.chat，喂进去的只有浓缩摘要', async () => {
  // 第一段：控制中心里真的解析一遍，摘要落进"同一个私有目录"。
  await boot();
  await analyze(CITY_CSV, 'cities.csv');
  const written = summaryInStore();
  expect(written.file).toBe('cities.csv');
  expect(written.rows).toBe(8);
  expect(written.cols).toBe(4);
  // 摘要里只有结论：没有备注列那一行的原文。
  expect(JSON.stringify(written)).not.toContain('张三说');

  // 第二段：桌宠旁边的卡片，读同一个键。
  await boot({ slot: 'surface' });
  expect(document.getElementById('workshop').hidden).toBe(true);
  expect(document.getElementById('card').hidden).toBe(false);
  expect(document.getElementById('card-meta').textContent).toBe('当前表格 · 8 行 × 4 列');
  expect(document.getElementById('card-group').textContent).toContain('按「城市」');
  expect(document.getElementById('card-group').textContent).toContain('北京 3');
  // 握手读完摘要就该发过一次 storage.get（也只有这一次）。
  expect(methodsRequested()).toEqual(['config.get', 'storage.get']);
  expect(chatCalls).toHaveLength(0);

  const ask = document.getElementById('card-ask');
  expect(ask.disabled).toBe(false);
  ask.click();
  await drain();

  expect(chatCalls).toHaveLength(1);
  const sent = chatCalls[0];
  // llm.chat 的 text 上限 4000（手册 §6.6）；浓缩摘要连 1800 都不到。
  expect(sent.text.length).toBeLessThan(1800);
  expect(sent.text.length).toBeLessThanOrEqual(4000);
  expect(sent.text).toContain('按「城市」分组');
  expect(sent.text).toContain('北京 3');
  expect(sent.text).toContain('城市=文本');
  // **整张表不在里面**：备注列那一行独有的原文一个字都没出现。
  expect(sent.text).not.toContain('张三说');
  expect(sent.text).not.toContain('2026-11-01');
  expect(String(sent.system || '').length).toBeLessThanOrEqual(4000);

  expect(document.getElementById('card-reply').textContent).toContain('北京最多');
  // 只有一次 llm.chat：没有再顺手弹一个气泡（那要 pet.bubble，而这张清单里没有它）。
  expect(methodsRequested()).toEqual(['config.get', 'storage.get', 'llm.chat']);
  expect(pageErrors).toEqual([]);
});

test('llm.chat 被拒：显示宿主原文，卡片上那两行统计一个字都不动', async () => {
  await boot();
  await analyze(CITY_CSV, 'cities.csv');
  await boot({ slot: 'surface' });

  const metaBefore = document.getElementById('card-meta').textContent;
  const groupBefore = document.getElementById('card-group').textContent;
  denyMethods.add('llm.chat');
  document.getElementById('card-ask').click();
  await drain();

  const reply = document.getElementById('card-reply');
  expect(reply.textContent).toContain('未获权限 llm.chat'); // 宿主的原话，不翻译成"操作失败"
  expect(reply.classList.contains('is-error')).toBe(true);
  // 模型只是加一段话，不是主路径：表格与统计仍然在。
  expect(document.getElementById('card-meta').textContent).toBe(metaBefore);
  expect(document.getElementById('card-group').textContent).toBe(groupBefore);
  expect(document.getElementById('card-meta').textContent).toContain('8 行 × 4 列');
  // 被拒时不多发任何别的请求（没有再试一次，也没有顺手弹气泡）。
  expect(methodsRequested().filter((method) => method === 'llm.chat')).toHaveLength(1);
  expect(methodsRequested()).not.toContain('bubble.say');
  // 按钮回到可以再点一次的状态。
  expect(document.getElementById('card-ask').disabled).toBe(false);
  expect(pageErrors).toEqual([]);
});

test('卡片还没有表格时按钮是禁用的，点也不发请求', async () => {
  await boot({ slot: 'surface' });
  const ask = document.getElementById('card-ask');
  expect(ask.disabled).toBe(true);
  expect(document.getElementById('card-meta').textContent).toBe('当前表格 · 还没有');
  ask.click();
  await drain(4);
  expect(chatCalls).toHaveLength(0);
});

test('卡片没有 storage 授权：说清楚读不到，不崩', async () => {
  await boot({ slot: 'surface', granted: ['llm.chat', 'plugin.config', 'pet.surface'] });
  expect(document.getElementById('card-reply').textContent).toContain('没有 storage 授权');
  expect(pageErrors).toEqual([]);
});

test('卡片没有 llm.chat 授权：按钮禁用，并写明模型解读在哪一边', async () => {
  await boot({ slot: 'surface', granted: ['storage', 'plugin.config'] });
  expect(document.getElementById('card-ask').disabled).toBe(true);
  expect(document.getElementById('card-reply').textContent).toContain('llm.chat');
  expect(chatCalls).toHaveLength(0);
});

// --- 宿主拒绝一切 --------------------------------------------------------------

test('宿主拒绝一切：本地分析照常（CSV 不经过宿主），但什么都不写进私有目录', async () => {
  denyAll = true;
  await boot();
  await analyze(CITY_CSV, 'cities.csv');

  // 解析完全在页面里做，一个字节都不需要宿主点头。
  expect(document.getElementById('result').hidden).toBe(false);
  expect(typeRows()).toHaveLength(4);
  expect(chartRectValues()).toEqual(['北京', '上海', '广州', '杭州']);
  // 但"存进私有目录"这一步失败了，界面上说了原因（宿主原话）。
  expect(store.size).toBe(0);
  expect(document.getElementById('status').textContent).toContain('未获权限 storage.set');
  expect(pageErrors).toEqual([]);
});

test('宿主拒绝一切时卡片不崩：显示宿主原话，按钮禁用，没有残留统计', async () => {
  denyAll = true;
  await boot({ slot: 'surface' });

  expect(document.getElementById('card-reply').textContent).toContain('未获权限 storage.get');
  expect(document.getElementById('card-meta').textContent).toBe('当前表格 · 还没有');
  expect(document.getElementById('card-ask').disabled).toBe(true);
  expect(pageErrors).toEqual([]);
});

test('granted=[] 时一条需要权限的请求都不发（按 granted 判断，而不是先发再兜底）', async () => {
  await boot({ granted: [] });
  expect(requests()).toHaveLength(0);
  expect(document.getElementById('status').textContent).toContain('没有 storage 授权');
  await analyze(CITY_CSV);
  expect(requests()).toHaveLength(0);
  // 本地分析仍然能跑：文件是用户交给页面的，不需要任何权限。
  expect(chartRectValues()).toEqual(['北京', '上海', '广州', '杭州']);
});
