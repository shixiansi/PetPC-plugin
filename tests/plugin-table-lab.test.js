import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 表格分析插件的行为测试。三层：
//   1. 纯 CSV/统计层（lib/csv.js）——空文件、单列、引号逗号、BOM、CRLF、类型推断、
//      已知数据的 min/max/mean/unique 逐条钉住；
//   2. 宿主链路（真实 panel.html + lib + app.js 在 jsdom 里握手）——文件选择/FileReader
//      进数据、storage 只存摘要不存原文、llm.chat 成功路径、workshop 降级、granted=[]；
//   3. 静态接线——manifest 按 WAVE-1 的 table-lab 行（纯面板、无 serves、四个权限、assets）。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-table-lab');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const libSource = readFileSync(path.join(pluginDir, 'lib', 'csv.js'), 'utf8');
const appSource = readFileSync(path.join(pluginDir, 'app.js'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

// --- 纯函数层单独加载（不经过 jsdom）：同一份源码就是插件在帧里跑的那份 ---------------

function loadLib() {
  const window = {};
  new Function('window', libSource)(window);
  return window.TableLab;
}

// --- jsdom 挂载（抄 tests/plugin-todo.test.js 的 mount） -----------------------------

const PET_METHODS = [
  'storage.get', 'storage.set', 'config.get', 'config.set',
  'llm.chat', 'bubble.say',
];

async function mount({ granted = [], slot = 'chat', methods = PET_METHODS } = {}) {
  const dom = new JSDOM(html, { url: 'https://plugin.invalid/panel.html', runScripts: 'outside-only' });
  const { window } = dom;
  const sent = [];
  const errors = [];
  const responded = new Set();
  window.parent = window;
  window.postMessage = (msg) => sent.push(msg);
  window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
  window.addEventListener('unhandledrejection', (e) => errors.push('unhandled: ' + String((e.reason && e.reason.message) || e.reason)));

  window.eval(libSource); // panel.html 的 <script> 顺序：lib 先、app 后
  window.eval(appSource);

  const init = () => {
    const data = {
      v: 1,
      type: 'init',
      theme: 'dark',
      granted,
      surface: { kind: 'panel', slot },
      host: { program: slot === 'workshop' ? 'workshop' : 'pet', methods: [...methods] },
    };
    const event = new window.MessageEvent('message', { data });
    Object.defineProperty(event, 'source', { value: window });
    window.dispatchEvent(event);
  };
  const respond = (id, result, ok = true) => {
    responded.add(id);
    const event = new window.MessageEvent('message', {
      data: { v: 1, type: 'response', id, ok, ...(ok ? { result } : { error: String(result) }) },
    });
    Object.defineProperty(event, 'source', { value: window });
    window.dispatchEvent(event);
  };
  return { window, sent, errors, responded, init, respond };
}

/**
 * 把宿主的应答喂完：init → config/storage 各一轮 await，每一轮回答完等一拍再收新请求，
 * 直到不再有新请求。answers(method, payload) 返回 { ok, result }；undefined 用默认表。
 */
async function drive(page, answers) {
  const defaults = (method) => {
    if (method === 'config.get') return { ok: true, result: { values: { maxHistBins: '12' }, secrets: {} } };
    if (method === 'storage.get') return { ok: true, result: { value: '' } };
    if (method === 'storage.set') return { ok: true, result: { ok: true } };
    return { ok: true, result: { ok: true } };
  };
  for (let round = 0; round < 30; round++) {
    const fresh = page.sent.filter((m) => m.type === 'request' && !page.responded.has(m.id));
    for (const m of fresh) {
      const a = (answers && answers(m.method, m.payload || {})) || defaults(m.method, m.payload || {});
      page.respond(m.id, a.result, a.ok !== false);
    }
    const waiting = page.sent.some((m) => m.type === 'request' && !page.responded.has(m.id));
    if (!waiting && fresh.length === 0) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 10));
}

const requestsOf = (page, method) =>
  page.sent.filter((m) => m.type === 'request' && m.method === method);
const lastOf = (page, method) => requestsOf(page, method).pop() || null;

// =====================================================================
// 1. 纯 CSV / 统计层
// =====================================================================

describe('CSV 解析（lib/csv.js，纯函数）', () => {
  const T = loadLib();

  test('空文件（0 字节）不崩：返回明确的空态标记', () => {
    let out;
    expect(() => { out = T.parseCSV(''); }).not.toThrow();
    expect(out.empty).toBe(true);
    expect(out.header).toEqual([]);
    expect(out.rows).toEqual([]);
    // 全空行同样算空，且 CRLF 的空文件也不崩
    expect(T.parseCSV('\r\n').empty).toBe(true);
    expect(T.parseCSV('  \n \r\n').empty).toBe(true);
  });

  test('单列表（表头 + 1 行）能出统计', () => {
    const out = T.parseCSV('name\nAlice');
    expect(out.empty).toBe(false);
    expect(out.header).toEqual(['name']);
    expect(out.rows).toEqual([['Alice']]);
    const s = T.summarize(out.header, out.rows);
    expect(s.rowCount).toBe(1);
    expect(s.cols).toHaveLength(1);
    expect(s.cols[0]).toMatchObject({ name: 'name', type: 'text', count: 1, unique: 1 });
  });

  test('字段内带逗号被引号正确保护："内容, 带引号" 是一个字段', () => {
    const out = T.parseCSV('a,b\n"内容, 带引号",2\nplain,"x""y"""');
    expect(out.rows[0]).toEqual(['内容, 带引号', '2']);
    expect(out.rows[1]).toEqual(['plain', 'x"y"']);
    // 带引号的表头同样保护（摘要里的列名原样出现）
    const q2 = T.parseCSV('"col, one",b\n1,2');
    expect(q2.header).toEqual(['col, one', 'b']);
    const digest = T.digestText(q2.header, q2.rows, 'q.csv');
    expect(digest).toContain('col, one');
  });

  test('带 BOM（\\uFEFF）的文件：首列名不带 BOM', () => {
    const out = T.parseCSV('\uFEFFid,name\n1,x');
    expect(out.header).toEqual(['id', 'name']);
    expect(out.header[0]).not.toContain('\uFEFF');
  });

  test('CRLF 与 LF 行尾等价（解析结果逐字节一致）', () => {
    const crlf = T.parseCSV('a,b\r\n1,x\r\n2,y\r\n');
    const lf = T.parseCSV('a,b\n1,x\n2,y\n');
    expect(JSON.stringify(crlf)).toBe(JSON.stringify(lf));
    expect(crlf.rows).toEqual([['1', 'x'], ['2', 'y']]);
  });

  test('分号 / Tab 分隔的 CSV 也能读（Excel 导出常态）', () => {
    expect(T.parseCSV('a;b\n1;x').rows).toEqual([['1', 'x']]);
    expect(T.parseCSV('a\tb\n1\tx').rows).toEqual([['1', 'x']]);
  });

  test('畸形输入不抛错：短行补空、长行并入最后一格', () => {
    const out = T.parseCSV('a,b,c\n1\n2,3,4,5');
    expect(() => T.summarize(out.header, out.rows)).not.toThrow();
    expect(out.rows[0]).toEqual(['1', '', '']);
    expect(out.rows[1]).toEqual(['2', '3', '4,5']);
  });
});

describe('类型推断（整数/小数/日期/混合）', () => {
  const T = loadLib();

  test('整数列 → number', () => {
    expect(T.inferColumn(['1', '-2', '30']).type).toBe('number');
    expect(T.classifyValue('42')).toBe('int');
  });

  test('小数列 → number（含科学计数）', () => {
    expect(T.inferColumn(['1.5', '-0.25', '1e3']).type).toBe('number');
    expect(T.classifyValue('1.5')).toBe('float');
  });

  test('日期字符串列 → date', () => {
    expect(T.inferColumn(['2026-01-03', '2026/1/4', '2026-01-05 08:30']).type).toBe('date');
    expect(T.inferColumn(['2026-01-03T08:30:00']).type).toBe('date');
  });

  test('混合列 → text（数字里混一个词就退回文本）', () => {
    expect(T.inferColumn(['1', '2', 'abc']).type).toBe('text');
    // 空值不参与推断：全空列是 text，但混合着看时数字不算数
    expect(T.inferColumn(['', '   ']).type).toBe('text');
  });
});

describe('统计正确性（一组已知数据逐条断言）', () => {
  const T = loadLib();
  // 已知数据：v 列 1,3,5,7,8 → count=5, unique=5, min=1, max=8, mean=24/5=4.8
  //            w 列 x,x,y,y,(空) → count=4, unique=2
  const parsed = T.parseCSV('v,w\n1,x\n3,x\n5,y\n7,y\n8,');
  const s = T.summarize(parsed.header, parsed.rows);

  test('数值列的 min / max / mean / count / unique 全对', () => {
    const v = s.cols[0];
    expect(v.name).toBe('v');
    expect(v.type).toBe('number');
    expect(v.count).toBe(5);
    expect(v.unique).toBe(5);
    expect(v.min).toBe(1);
    expect(v.max).toBe(8);
    expect(v.mean).toBeCloseTo(4.8, 10);
  });

  test('文本列的 count / unique（空值不算，重复值折叠）', () => {
    const w = s.cols[1];
    expect(w.type).toBe('text');
    expect(w.count).toBe(4);       // 尾行是空值，不计入
    expect(w.unique).toBe(2);      // x 与 y
    expect(w.min).toBeUndefined(); // 文本列没有数值统计
  });

  test('小数列的 mean 不丢精度（0.1+0.2+0.3 → 0.2）', () => {
    const p2 = T.parseCSV('f\n0.1\n0.2\n0.3');
    const c = T.summarize(p2.header, p2.rows).cols[0];
    expect(c.mean).toBeCloseTo(0.2, 10);
  });

  test('统计摘要只含列名与统计数字（digestText）', () => {
    const digest = T.digestText(parsed.header, parsed.rows, 'demo.csv');
    expect(digest).toContain('demo.csv');
    expect(digest).toContain('行数：5');
    expect(digest).toContain('min=1');
    expect(digest).toContain('max=8');
    expect(digest).toContain('mean=4.8');
    expect(digest).not.toContain('7,y'); // 原始行不出现在摘要里
  });
});

describe('概览图（overviewSVG）', () => {
  const T = loadLib();

  test('有数值列：首列数值直方图，格子数与范围正确', () => {
    const p = T.parseCSV('n,s\n1,a\n2,b\n3,c\n9,d');
    const ov = T.overviewSVG(p.header, p.rows, { bins: 4 });
    expect(ov.kind).toBe('histogram');
    expect(ov.svg).toContain('<svg');
    expect(ov.svg).toContain('rect');
    expect(ov.detail).toContain('n');
  });

  test('没有数值列：退回列类型分布图', () => {
    const p = T.parseCSV('name,day\n张三,2026-01-01\n李四,2026-01-02');
    const ov = T.overviewSVG(p.header, p.rows, {});
    expect(ov.kind).toBe('column-types');
    expect(ov.svg).toContain('文本列');
    expect(ov.svg).toContain('日期列');
  });
});

// =====================================================================
// 2. 宿主链路（panel.html + app.js 在 jsdom 里跑）
// =====================================================================

describe('握手', () => {
  test('ready 先于一切请求；init 之后才开始问宿主', async () => {
    const page = await mount({ granted: ['storage', 'plugin.config', 'llm.chat', 'pet.bubble'] });
    expect(page.sent).toHaveLength(1);
    expect(page.sent[0]).toMatchObject({ v: 1, type: 'ready' });
    page.init();
    await drive(page);
    expect(lastOf(page, 'config.get')).toBeTruthy();
    expect(page.errors).toEqual([]);
  });
});

describe('CSV 进入与统计渲染（FileReader 路径 + 空文件空态）', () => {
  async function mounted(grantList) {
    const page = await mount({ granted: grantList || ['storage', 'plugin.config', 'llm.chat', 'pet.bubble'] });
    page.init();
    await drive(page);
    page.sent.length = 0;
    return page;
  }

  /** 把一个 File 塞进真实的 <input type=file> 并触发 change（浏览器同一条路）。 */
  function pickFile(page, content, name) {
    const input = page.window.document.getElementById('file');
    const file = new page.window.File([content], name, { type: 'text/csv' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new page.window.Event('change', { bubbles: true }));
  }

  test('文件选择框 → FileReader → 统计表与概览图出现', async () => {
    const page = await mounted();
    pickFile(page, 'name,age\n张三,30\n李四,41', 'people.csv');
    await new Promise((r) => setTimeout(r, 20)); // FileReader 是异步的
    const doc = page.window.document;
    expect(doc.getElementById('overview').hidden).toBe(false);
    // 统计表显示每列的统计（列名 / 类型 / 非空数 / 不同值 / min / max / mean），
    // 不是原始单元格：年龄列 mean=35.5、类型"数字"，姓名列类型"文本"。
    const tableText = doc.getElementById('stats').textContent;
    expect(tableText).toContain('name');
    expect(tableText).toContain('age');
    expect(tableText).toContain('35.5'); // mean=(30+41)/2
    expect(tableText).toContain('数字');
    expect(tableText).toContain('文本');
    expect(doc.querySelector('#chart svg')).toBeTruthy();
    expect(doc.getElementById('status').textContent).toContain('2 行 × 2 列');
    expect(page.errors).toEqual([]);
    expect(doc.querySelector('#chart svg')).toBeTruthy();
    expect(doc.getElementById('status').textContent).toContain('2 行 × 2 列');
    expect(page.errors).toEqual([]);
  });

  test('空文件（0 字节）不崩，给出明确空态', async () => {
    const page = await mounted();
    pickFile(page, '', 'empty.csv');
    await new Promise((r) => setTimeout(r, 20));
    const doc = page.window.document;
    expect(page.errors).toEqual([]);
    expect(doc.getElementById('overview').hidden).toBe(true);
    expect(doc.getElementById('empty-state').hidden).toBe(false);
    expect(doc.querySelector('#empty-state .empty-sub').textContent).toContain('空表格');
    expect(doc.getElementById('status').textContent).toContain('空表格');
  });

  test('拖拽路径（DataTransfer.files[0]）同样进入分析', async () => {
    const page = await mounted();
    const dt = { files: [new page.window.File(['a,b\n1,2'], 'drop.csv', { type: 'text/csv' })] };
    page.window.document.getElementById('drop').dispatchEvent(
      new page.window.Event('drop', { bubbles: true, dataTransfer: undefined }),
    );
    // jsdom 不给 Event 构造器传 dataTransfer：直接走 app 的拖拽处理器的替代入口断言过一次
    // （上面的 drop 事件只验证"空拖不崩"），真实内容走 ingestText 接缝：
    page.window.__tablelab.ingestText('a,b\n1,2', 'drop.csv');
    await new Promise((r) => setTimeout(r, 20));
    expect(page.window.document.getElementById('overview').hidden).toBe(false);
    expect(dt.files[0].name).toBe('drop.csv');
    expect(page.errors).toEqual([]);
  });

  test('>1 MiB 的 CSV：照常分析，storage 里只有摘要与文件名，原始数据一字节不落', async () => {
    const page = await mounted();
    // 约 1.2 MiB：42000 行。行内容里埋一个只会在原始数据里出现的标记。
    const rows = ['idx,MARKER-VALUE'];
    for (let i = 0; i < 42000; i++) rows.push(`${i},MARKER-${i}-SECRET`);
    const big = rows.join('\n');
    expect(big.length).toBeGreaterThan(1024 * 1024);
    page.window.__tablelab.ingestText(big, 'big.csv');
    await drive(page);
    const sets = requestsOf(page, 'storage.set');
    expect(sets.length).toBeGreaterThan(0);
    for (const m of sets) {
      expect(m.payload.value.length).toBeLessThan(9000);      // 摘要量级，绝不是 1 MiB 原文
      expect(m.payload.value).not.toContain('SECRET');        // 原始数据不出门
      expect(['summary', 'summary-name', 'summary-at']).toContain(m.payload.key);
    }
    expect(page.errors).toEqual([]);
  });
});

describe('"让模型解读"：llm.chat 两条路径', () => {
  async function mountedWithFile({ slot, methods, granted }) {
    const page = await mount({ granted, slot, methods });
    page.init();
    await drive(page);
    page.sent.length = 0;
    page.window.__tablelab.ingestText('city,pop\n北京,2100\n上海,2400\n深圳,1700', 'cities.csv');
    await new Promise((r) => setTimeout(r, 10));
    return page;
  }

  test('成功路径（桌宠侧）：mock llm.chat 返回解读；发出的 prompt 是摘要而非原始数据', async () => {
    const page = await mountedWithFile({
      slot: 'chat', methods: PET_METHODS,
      granted: ['storage', 'plugin.config', 'llm.chat', 'pet.bubble'],
    });
    const ask = page.window.document.getElementById('ask');
    expect(ask.disabled).toBe(false); // 能力齐 + 有数据：按钮可用
    ask.dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
    await drive(page, (method, payload) => {
      if (method === 'llm.chat') return { ok: true, result: { requestId: 'r1', text: '结论：人口列均值约 2066 万。' } };
      return undefined;
    });
    const call = lastOf(page, 'llm.chat');
    expect(call).toBeTruthy();
    expect(call.payload.text).toContain('min=');           // 统计摘要在
    expect(call.payload.text).toContain('cities.csv');     // 文件名在
    expect(call.payload.text).toContain('pop');            // 列名在
    expect(call.payload.text).not.toContain('2100');       // 原始单元格值不在：只发摘要
    const doc = page.window.document;
    expect(doc.getElementById('answer').hidden).toBe(false);
    expect(doc.getElementById('answer').textContent).toContain('均值约 2066 万');
    expect(doc.getElementById('status').textContent).toContain('完成');
    expect(page.errors).toEqual([]);
  });

  test('workshop 降级路径：按钮置灰 + 说出口"模型只在桌宠侧可用"，一个请求都不发', async () => {
    const page = await mountedWithFile({
      slot: 'workshop',
      methods: ['storage.get', 'storage.set', 'config.get', 'config.set'], // 控制中心没有 llm.chat / bubble.say
      granted: ['storage', 'plugin.config', 'llm.chat', 'pet.bubble'],     // 就算权限全给了也没用
    });
    const doc = page.window.document;
    expect(doc.getElementById('ask').disabled).toBe(true);
    expect(doc.getElementById('bubble').disabled).toBe(true);
    expect(doc.getElementById('llm-note').hidden).toBe(false);
    expect(doc.getElementById('llm-note').textContent).toContain('模型只在桌宠侧可用');
    // 解析、统计、图照常（只读的部分继续显示 —— §9）
    expect(doc.getElementById('overview').hidden).toBe(false);
    // 点击也不发请求（disabled 的按钮没有 click 副作用；再显式调一次确认无请求）
    doc.getElementById('ask').dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(requestsOf(page, 'llm.chat')).toEqual([]);
    expect(requestsOf(page, 'bubble.say')).toEqual([]);
    expect(page.errors).toEqual([]);
  });
});

describe('权限缺口时的降级', () => {
  test("granted=['storage','plugin.config']（无 llm.chat）：不崩，解读功能说出口且点击不发请求", async () => {
    const page = await mount({ granted: ['storage', 'plugin.config'], slot: 'chat' });
    page.init();
    await drive(page);
    page.sent.length = 0;
    page.window.__tablelab.ingestText('a\n1\n2', 'x.csv');
    await new Promise((r) => setTimeout(r, 10));
    const doc = page.window.document;
    expect(page.errors).toEqual([]);
    expect(doc.getElementById('overview').hidden).toBe(false); // 统计照常
    expect(doc.getElementById('ask').disabled).toBe(true);
    expect(doc.getElementById('llm-note').hidden).toBe(false);
    expect(doc.getElementById('llm-note').textContent).toContain('llm.chat');
    doc.getElementById('ask').dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(requestsOf(page, 'llm.chat')).toEqual([]);
  });

  test('granted=[]：零请求、零写、不崩，界面停在"未获授权"', async () => {
    const page = await mount({ granted: [], slot: 'chat' });
    page.init();
    await drive(page, () => ({ ok: false, result: '模拟拒绝' }));
    const requests = page.sent.filter((m) => m.type === 'request');
    expect(requests, 'granted=[] 时发出了请求').toEqual([]);
    expect(page.errors).toEqual([]);
    expect(page.window.document.getElementById('status').textContent).toContain('未获授权');
    // 没有授权也没有数据时，分析入口仍然不能把 UI 弄崩
    page.window.__tablelab.ingestText('a\n1', 'y.csv');
    await new Promise((r) => setTimeout(r, 10));
    expect(page.errors).toEqual([]);
    expect(requestsOf(page, 'storage.set')).toEqual([]); // 零写
    expect(requestsOf(page, 'llm.chat')).toEqual([]);    // 零网络/零模型
    expect(page.window.document.getElementById('overview').hidden).toBe(false); // 就地统计仍可用
  });

  test('宿主对 llm.chat 说"未获权限"：宿主的中文原话原样显示（不翻译成"出错了"）', async () => {
    const page = await mount({ granted: ['storage', 'plugin.config', 'llm.chat', 'pet.bubble'], slot: 'chat' });
    page.init();
    await drive(page);
    page.sent.length = 0;
    page.window.__tablelab.ingestText('a\n1', 'z.csv');
    await new Promise((r) => setTimeout(r, 10));
    page.window.document.getElementById('ask').dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
    await drive(page, (method) => (method === 'llm.chat'
      ? { ok: false, result: '插件 com.shixiansi.plugin-table-lab 未获权限 llm.chat' }
      : undefined));
    const doc = page.window.document;
    expect(doc.getElementById('error').hidden).toBe(false);
    expect(doc.getElementById('error').textContent).toContain('未获权限');
    expect(page.errors).toEqual([]);
  });
});

// =====================================================================
// 3. 静态接线（WAVE-1 的 table-lab 行）
// =====================================================================

describe('manifest 接线（WAVE-1 table-lab 行）', () => {
  test('纯面板 + 无 serves + 四个权限 + assets 齐全', () => {
    expect(manifest.id).toBe('com.shixiansi.plugin-table-lab');
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.author).toBe('shixiansi');
    expect(manifest.permissions).toEqual(['storage', 'plugin.config', 'llm.chat', 'pet.bubble']);
    expect(manifest.panel).toBe(true);          // 界面落点：panel
    expect(manifest.background).not.toBe(true); // 纯面板：无常驻帧
    expect(manifest.surface).toBeUndefined();   // 无浮层面
    expect(manifest.serves).toBeUndefined();    // 不被别人调用 → 没有 serves（也就不需要 plugin.call）
    expect(manifest.entry).toBe('panel.html');
    expect(manifest.assets).toContain('ui.css');      // 纯面板插件要带宿主 token 副本
    expect(manifest.assets).toContain('lib/csv.js');  // 解析层要进包
  });

  test('ui.css 副本与源头逐字节相同，且在自家样式之前引入', () => {
    const master = readFileSync(path.join(here, '..', 'docs', 'ui', 'petpc-ui.css'), 'utf8');
    const copy = readFileSync(path.join(pluginDir, 'ui.css'), 'utf8');
    expect(copy).toBe(master);
    const uiAt = html.indexOf('href="ui.css"');
    const ownAt = html.indexOf('href="style.css"');
    expect(uiAt).toBeGreaterThan(-1);
    expect(ownAt).toBeGreaterThan(-1);
    expect(uiAt).toBeLessThan(ownAt);
  });

  test('铁律在源码里可查：没有磁盘路径读取，storage.set 的值只来自摘要', () => {
    // app.js 里不允许出现 readFile / fs / 任意路径读取的痕迹
    expect(appSource).not.toMatch(/\brequire\s*\(/);
    expect(appSource).not.toMatch(/\breadFile|\.oya\b|node:fs/);
    // 内容键不存在：KEY_* 只有摘要与文件名与时刻，没有任何"内容"键
    expect(appSource).not.toMatch(/KEY_.*(CONTENT|CSV|RAW|DATA)/);
  });

  test('app.js 行数 ≤ 800（任务书上限）', () => {
    const lines = appSource.split('\n').length;
    expect(lines).toBeLessThanOrEqual(800);
  });
});
