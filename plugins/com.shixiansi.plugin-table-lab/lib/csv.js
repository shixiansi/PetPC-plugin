'use strict';

// CSV 解析与类型推断 —— 这个插件唯一碰"文件内容"的地方。
//
// 为什么自己写这七十行：插件包不许引第三方库（手册 §2 的包规则），而 CSV 的方言恰好只有
// 六件事——字段里的逗号、转义的双引号（""）、引号里的换行、CRLF、末尾换行、UTF-8 BOM。
// 每一件在 tests/plugin-table-lab.test.js 里都有一条用例。
//
// BOM 那条尤其要紧：不剥掉它，第一列的名字会带一个看不见的 \uFEFF，于是界面上写着"按 城市
// 分组"、实际分的是"\uFEFF城市"——用户看不见差别，只是所有分组都变成"另一个列"。

/** 把一段文本按分隔符切成二维数组（RFC 4180 的形状）。 */
function parseCsv(text, delimiter) {
  const src = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  const d = String(delimiter || '') || ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; ) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        // 连着两个引号是一个字面引号；单个引号结束这一段引用。
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (src.startsWith(d, i)) {
      row.push(field);
      field = '';
      i += d.length;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // 末尾那个换行不该多出一行空行：只有真的还有东西没落行时才收尾。
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const TYPE_LABELS = { integer: '整数', decimal: '小数', date: '日期', text: '文本', empty: '空列' };

const INT_PATTERN = /^[+-]?\d+$/;
const NUM_PATTERN = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const DATE_PATTERN = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/;

/** 日期只认 2026-11-03 / 2026/11/3 这种"年月日都在"的写法，而且日子要真的存在。 */
function isDateValue(text) {
  const m = DATE_PATTERN.exec(text);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  // 2026-02-30 这种"格式对、日子不存在"的必须排除：拿 Date 归一化后的结果反查一遍。
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/**
 * 一列的类型。
 *
 * 传进来的是**非空单元格**：空单元格不是类型证据（它可能是缺失值，也可能只是这一行没填）。
 * 一整列都空就没有任何证据，标成"空列"而不是猜一个——猜出来的类型会让人以为那里真有数据。
 */
function inferType(values) {
  const list = Array.isArray(values) ? values : [];
  if (list.length === 0) return 'empty';
  if (list.every((v) => INT_PATTERN.test(v))) return 'integer';
  if (list.every((v) => NUM_PATTERN.test(v))) return 'decimal';
  if (list.every((v) => isDateValue(v))) return 'date';
  return 'text';
}

/** 空表头给个名字，重名的加上序号（否则"按 城市 分组"会有两个一摸一样的按钮）。 */
function uniqueNames(names) {
  const seen = new Map();
  return names.map((raw, i) => {
    let name = String(raw == null ? '' : raw).trim() || '列' + (i + 1);
    const n = (seen.get(name) || 0) + 1;
    seen.set(name, n);
    if (n > 1) name = name + ' (' + n + ')';
    return name;
  });
}

/**
 * 把 parseCsv 的二维数组变成一张表。
 *
 * 第一行当表头（这是 CSV 的通行约定，也是"分组统计按列名说话"的前提）。数据行里全空的行
 * 直接丢掉——Excel 导出的文件末尾常有一串 `,,,`。超过 maxRows 的部分**不参与统计**，但
 * totalRows 记住文件里一共有多少行：界面上那句"只统计了前 N 行"必须说得准确。
 */
function buildTable(rows, options) {
  const wanted = Number(options && options.maxRows);
  const maxRows = Number.isFinite(wanted) && wanted > 0 ? Math.floor(wanted) : 200;
  const clean = (Array.isArray(rows) ? rows : []).filter(
    (row) => Array.isArray(row) && row.some((cell) => String(cell == null ? '' : cell).trim() !== ''),
  );
  if (!clean.length) return { header: [], rows: [], totalRows: 0, truncated: false, columns: [] };

  const header = uniqueNames(clean[0]);
  const data = clean.slice(1);
  const kept = data.slice(0, maxRows).map((row) => header.map((_, i) => String(row[i] == null ? '' : row[i]).trim()));
  const columns = header.map((name, i) => {
    const values = kept.map((row) => row[i]).filter((value) => value !== '');
    return {
      name,
      index: i,
      type: inferType(values),
      filled: values.length,
      empty: kept.length - values.length,
    };
  });
  return { header, rows: kept, totalRows: data.length, truncated: data.length > kept.length, columns };
}
