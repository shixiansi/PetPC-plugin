// lib/csv.js —— 表格分析的纯函数层：不碰 DOM、不碰宿主桥、不读磁盘路径。
//
// 为什么是经典 script 而不是 module：panel.html 用 <script src> 按序加载（calendar 试点同一型），
// app.js 直接读全局 TableLab；测试用 new Function(source) 就能拿到同一份纯函数。
//
// 铁律（任务书）：**不读磁盘路径**。CSV 内容只能来自浏览器侧的 FileReader / File API——
// 这个文件里没有任何读取文件的调用，输入一律是"已经读进内存的字符串"。
//
// 覆盖的输入形态（任务书 §3 必测）：空文件（返回明确空态，不抛）、单列单行、字段内带逗号
// 的引号保护、UTF-8 BOM（首列名不带 BOM）、CRLF 与 LF 等价。
// 解析不了的行不抛错：短行补空串、长行并入最后一格，并计数（rowsSkipped）。

'use strict';

(function () {
  const MAX_FIELDS = 4096;     // 一行的字段数上限：防一个病态行撑爆内存
  const MS_DAY = 86400000;
  const INT_RE = /^[+-]?\d{1,15}$/;
  // 小数/科学计数：1.5 / -0.25 / 1e3 / 2.5E-3。Number() 本身很宽，先用形状挡掉
  // "0100"（按文本更像编号）之外的真数字形态，再交给 Number() 收口。
  const FLOAT_RE = /^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d{1,3})?$/;
  // ISO 日期 / 日期时间：2026-01-03、2026/1/3、2026-01-03T08:30(:00)、2026-01-03 08:30。
  const DATE_RE = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}([T ]\d{1,2}:\d{2}(:\d{2})?)?$/;

  // --- 解析 --------------------------------------------------------------------

  // 去掉一个 UTF-8 BOM（文件对象按 UTF-8 读进来时它是第一个字符）。
  function stripBom(text) {
    return String(text || '').replace(/^\uFEFF/, '');
  }

  // 一行 RFC4180 形状的 CSV → 字段数组。分隔符在引号里不是分隔符；"" 是一个引号本身；
  // 引号没闭合就吞到行尾（宽进，不抛错）。字段数超上限并入最后一格。
  function parseLine(line, delimiter) {
    const sep = delimiter || ',';
    const fields = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuote) {
        if (c === '"') {
          if (line[i + 1] === '"') { cur += '"'; i += 1; }
          else inQuote = false;
        } else cur += c;
      } else if (c === '"') {
        inQuote = true;
      } else if (c === sep) {
        fields.push(cur); cur = '';
        if (fields.length >= MAX_FIELDS) { cur += line.slice(i + 1); return fields; }
      } else {
        cur += c;
      }
    }
    fields.push(cur);
    return fields;
  }

  // 主入口：CSV 文本 → { header, rows, rowsSkipped, delimiter }。
  // delimiter 按首行猜：tab 与分号（Excel 中文导出常见）优先于逗号；猜不出用逗号。
  // 空文件 / 全空行 → { header: [], rows: [], empty: true }，绝不抛错。
  function parseCSV(text) {
    const clean = stripBom(text);
    if (!clean.trim()) {
      return { header: [], rows: [], rowsSkipped: 0, delimiter: ',', empty: true };
    }
    const firstBreak = clean.search(/[\r\n]/);
    const headLine = firstBreak < 0 ? clean : clean.slice(0, firstBreak);
    const delimiter = countIn(headLine, '\t') > countIn(headLine, ',')
      ? '\t'
      : countIn(headLine, ';') > countIn(headLine, ',') ? ';' : ',';
    const lines = splitLines(clean);
    if (lines.length === 0) {
      return { header: [], rows: [], rowsSkipped: 0, delimiter, empty: true };
    }
    const header = parseLine(lines[0], delimiter).map((h, i) => (h.trim() ? h.trim() : `列${i + 1}`));
    const width = header.length;
    const rows = [];
    let rowsSkipped = 0;
    for (let i = 1; i < lines.length; i++) {
      const raw = parseLine(lines[i], delimiter);
      // 全空行不是数据：跳过但不计入损坏。
      if (raw.length === 1 && raw[0].trim() === '') continue;
      if (raw.length > width) {
        // 长行：多出的部分并回最后一格（字段里带换行的退化情形），数据本身不丢。
        const head = raw.slice(0, width);
        head[width - 1] = raw.slice(width - 1).join(',');
        rows.push(head);
      } else {
        // 短行：补空串到表宽——访问 r[ci] 永远有值。
        while (raw.length < width) raw.push('');
        rows.push(raw);
      }
    }
    return { header, rows, rowsSkipped, delimiter, empty: false };
  }

  function countIn(s, ch) {
    let n = 0;
    for (const c of s) if (c === ch) n += 1;
    return n;
  }

  // 行切分：CRLF、LF、 Lone CR 都算一行；末尾的换行不产生空行。
  function splitLines(text) {
    return String(text).split(/\r\n|\n|\r/).filter((line, i, arr) =>
      !(i === arr.length - 1 && line === ''));
  }

  // --- 类型推断 ------------------------------------------------------------------
  //
  // 每列一个类型：number / date / text。非空样本里全部像数字 → number；全部像 ISO 日期
  // → date；其余 → text。空值不参与推断。"整数"是 number 的记号，不是独立类型。

  function classifyValue(v) {
    const s = String(v ?? '').trim();
    if (s === '') return 'empty';
    if (INT_RE.test(s)) return 'int';
    if (FLOAT_RE.test(s) && Number.isFinite(Number(s))) return 'float';
    if (DATE_RE.test(s)) {
      const ms = Date.parse(s.replace(' ', 'T'));
      if (Number.isFinite(ms)) return 'date';
    }
    return 'text';
  }

  // 对一列做推断，给出类型与每种记号的数量（int/float 拆开给"数字列"内部看）。
  function inferColumn(values) {
    const kinds = { int: 0, float: 0, date: 0, text: 0, empty: 0 };
    for (const v of values) kinds[classifyValue(v)] += 1;
    const filled = values.length - kinds.empty;
    let type = 'text';
    if (filled > 0 && kinds.int + kinds.float === filled) type = 'number';
    else if (filled > 0 && kinds.date === filled) type = 'date';
    return { type, kinds };
  }

  // --- 统计 --------------------------------------------------------------------

  // 每列 count / unique；数值列再加 min / max / mean（按数值算，不是按字符串）。
  // 已知数据一组：count=5, unique=4, min=1, max=8, mean=3.5 之类逐条可断言。
  function summarize(header, rows) {
    const cols = header.map((name, ci) => {
      const values = rows.map((r) => r[ci] ?? '');
      const { type } = inferColumn(values);
      const filled = values.filter((v) => String(v ?? '').trim() !== '');
      const unique = new Set(filled.map((v) => String(v ?? ''))).size;
      const col = { name, type, count: filled.length, unique };
      if (type === 'number') {
        const nums = filled.map((v) => Number(String(v).trim())).filter((n) => Number.isFinite(n));
        if (nums.length > 0) {
          let min = Infinity, max = -Infinity, sum = 0;
          for (const n of nums) { if (n < min) min = n; if (n > max) max = n; sum += n; }
          col.min = min;
          col.max = max;
          col.mean = sum / nums.length;
        }
      }
      return col;
    });
    return { cols, rowCount: rows.length };
  }

  // 概览摘要（给界面与模型的那份"只发这个"的东西）：文本 + 结构化各一份。
  // 原始数据不进这里：模型拿到的最多是列名、类型、与已算好的数字。
  function digestText(header, rows, fileName) {
    const s = summarize(header, rows);
    const lines = [];
    lines.push(`文件：${fileName || '（未命名）'}`);
    lines.push(`行数：${s.rowCount}，列数：${s.cols.length}`);
    for (const c of s.cols) {
      let line = `- ${c.name}（${typeName(c.type)}）：${c.count} 个非空值，${c.unique} 个不同值`;
      if (c.type === 'number' && c.min !== undefined) {
        line += `，min=${fmtNum(c.min)}，max=${fmtNum(c.max)}，mean=${fmtNum(c.mean)}`;
      }
      lines.push(line);
    }
    return lines.join('\n');
  }

  function typeName(t) {
    return t === 'number' ? '数字' : t === 'date' ? '日期' : '文本';
  }

  function fmtNum(n) {
    if (!Number.isFinite(n)) return String(n);
    return Math.abs(n) >= 1e15 || (Math.abs(n) < 1e-6 && n !== 0)
      ? n.toExponential(4)
      : String(Math.round(n * 1e6) / 1e6);
  }

  // --- 概览图 --------------------------------------------------------------------
  //
  // 两种图，按数据自动挑：
  //   1. 首个数值列的直方图（分箱计数）——有数值列时的首选；
  //   2. 否则每列的类型分布条形图（数字/日期/文本各多少列）。
  // 输出是 SVG 字符串：不依赖画布尺寸，jsdom 里也能逐条断言。

  function histBins(values, bins) {
    const nums = values
      .map((v) => Number(String(v ?? '').trim()))
      .filter((n) => Number.isFinite(n));
    if (nums.length === 0 || bins < 1) return { bins: [], min: 0, max: 0 };
    let min = Infinity, max = -Infinity;
    for (const n of nums) { if (n < min) min = n; if (n > max) max = n; }
    const width = (max - min) / bins || 1;
    const counts = new Array(bins).fill(0);
    for (const n of nums) {
      let idx = Math.floor((n - min) / width);
      if (idx >= bins) idx = bins - 1; // max 落进最后一格
      if (idx < 0) idx = 0;
      counts[idx] += 1;
    }
    return { bins: counts, min, max, width };
  }

  /** 概览图：优先首列数值直方图，否则列类型分布。返回 {kind, svg, detail}。 */
  function overviewSVG(header, rows, opts) {
    const binCount = Math.max(4, Math.min(40, Number(opts && opts.bins) || 16));
    const numeric = header
      .map((name, ci) => ({ name, ci, values: rows.map((r) => r[ci] ?? '') }))
      .filter((c) => inferColumn(c.values).type === 'number');
    if (numeric.length > 0) {
      const col = numeric[0];
      const h = histBins(col.values, binCount);
      if (h.bins.length > 0) {
        return {
          kind: 'histogram',
          detail: `「${col.name}」的直方图，${h.bins.length} 格，范围 ${fmtNum(h.min)} – ${fmtNum(h.max)}`,
          svg: barSVG(h.bins.map((count, i) => ({
            label: `${fmtNum(h.min + i * h.width)}`,
            count,
          })), `直方图：${col.name}`),
        };
      }
    }
    const kinds = { number: 0, date: 0, text: 0 };
    // 按下标走：列名可以重名，indexOf 会把两列算成同一列。
    for (let ci = 0; ci < header.length; ci++) {
      const values = rows.map((r) => r[ci] ?? '');
      const t = inferColumn(values).type;
      if (kinds[t] !== undefined) kinds[t] += 1; else kinds.text += 1;
    }
    const bars = [
      { label: '数字列', count: kinds.number },
      { label: '日期列', count: kinds.date },
      { label: '文本列', count: kinds.text },
    ].filter((b) => b.count > 0);
    return {
      kind: 'column-types',
      detail: `各列类型分布（共 ${header.length} 列）`,
      svg: barSVG(bars, '列类型分布'),
    };
  }

  // 竖条 SVG：值域自适应，文字用 token 一样的中性灰（图内不用花色）。
  function barSVG(bars, title) {
    const W = 320, H = 160, PAD_L = 8, PAD_B = 22, PAD_T = 18;
    const innerW = W - PAD_L * 2;
    const innerH = H - PAD_B - PAD_T;
    const max = Math.max(1, ...bars.map((b) => b.count));
    const bw = bars.length > 0 ? innerW / bars.length : innerW;
    const parts = [];
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}" class="overview-svg">`);
    parts.push(`<title>${esc(title)}</title>`);
    parts.push(`<line x1="${PAD_L}" y1="${H - PAD_B}" x2="${W - PAD_L}" y2="${H - PAD_B}" stroke="var(--text-faint, #94a3b8)" stroke-width="1"/>`);
    bars.forEach((b, i) => {
      const h = Math.round((b.count / max) * innerH);
      const x = PAD_L + i * bw + bw * 0.15;
      const y = H - PAD_B - h;
      parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${h}" rx="4" fill="var(--accent, #7c3aed)"><title>${esc(b.label)}：${b.count}</title></rect>`);
      if (b.count > 0) {
        parts.push(`<text x="${(x + bw * 0.35).toFixed(1)}" y="${(y - 3).toFixed(1)}" font-size="10" text-anchor="middle" fill="var(--text-dim, #64748b)">${b.count}</text>`);
      }
      parts.push(`<text x="${(x + bw * 0.35).toFixed(1)}" y="${H - PAD_B + 13}" font-size="10" text-anchor="middle" fill="var(--text-dim, #64748b)">${esc(shortLabel(b.label))}</text>`);
    });
    parts.push('</svg>');
    return parts.join('');
  }

  function shortLabel(s) {
    const t = String(s);
    return t.length > 8 ? `${t.slice(0, 7)}…` : t;
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 导出（测试接缝：new Function('window', source)(window) 与页面 <script> 各加载一份）。
  window.TableLab = Object.freeze({
    parseCSV,
    stripBom,
    parseLine,
    classifyValue,
    inferColumn,
    summarize,
    digestText,
    histBins,
    overviewSVG,
    barSVG,
    fmtNum,
  });
})();
