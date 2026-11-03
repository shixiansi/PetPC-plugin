'use strict';

// 分组统计、摘要、以及"喂给模型的那段话"。
//
// 三件事必须分开看：
//   1. 分组计数（groupCounts）是**表**的函数，纯计算，可以逐条断言；
//   2. 摘要（buildSummary）是**跨挂载**传递的形状：workshop 写进 storage，卡片读回来。
//      它故意只放结论（行列数、列类型、分组计数），不放整张表——卡片是 300×150 的一格，
//      而模型那条路上还有 4000 字符的上限（手册 §6.6）。"塞整张表"在这里会同时弄坏两件事。
//   3. 模型摘要（buildDigest）只从摘要生成，绝不再读原始行：一份 200 行的表拼成文本就上万
//      字符，宿主会拒（llm.chat 的 text ≤4000）。

/** 空单元格也占一组：否则"各组加起来"会小于行数，读的人会以为统计错了。 */
const BLANK_GROUP = '（空）';

function cellAt(row, index) {
  const value = row && row[index];
  return value == null ? '' : String(value);
}

/**
 * 某一列的分组计数。
 *
 * 排序：行数降序；行数相同的按取值升序（按码位比较，所以同一份文件每次得到同一个顺序——
 * 用 localeCompare 会让顺序随系统语言变，而测试与截图都依赖它是确定的）。
 */
function groupCounts(rows, columnIndex) {
  const counts = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const raw = cellAt(row, columnIndex);
    const key = raw === '' ? BLANK_GROUP : raw;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}

/**
 * 默认按哪一列分组。
 *
 * 判据是"这一列能不能当分类用"：不同取值 2–12 个、且不是日期列（按日期分组等于一行一组，
 * 画出来是一排一样高的条，没有信息）。都不合适就退回第一列——宁可给一个不好看的分组，
 * 也不要让界面空着，因为空着会让人以为统计没跑。
 */
function pickGroupColumn(columns, rows) {
  const list = Array.isArray(columns) ? columns : [];
  const body = Array.isArray(rows) ? rows : [];
  for (const column of list) {
    if (column.type === 'empty' || column.type === 'date') continue;
    const distinct = new Set(body.map((row) => cellAt(row, column.index) || BLANK_GROUP)).size;
    if (distinct >= 2 && distinct <= 12) return column.index;
  }
  return list.length ? list[0].index : -1;
}

/** "北京 3、上海 2、广州 1" —— 卡片只有一行，所以只留前 max 组，后面用总数收尾。 */
function summaryLine(pairs, max) {
  const list = Array.isArray(pairs) ? pairs : [];
  const n = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : 3;
  const head = list.slice(0, n).map((pair) => pair.value + ' ' + pair.count).join('、');
  if (!head) return '';
  return list.length > n ? head + ' 等 ' + list.length + ' 组' : head;
}

/**
 * 跨挂载传递的那份摘要。participants：table（workshop 解析出来的）+ 分组列 + 文件名。
 * pairs 只留前 12 组：卡片与模型摘要都只需要"最集中的几个"。
 */
function buildSummary(table, groupIndex, fileName) {
  if (!table || !table.header || !table.header.length) return null;
  const column = (table.columns || []).find((c) => c.index === groupIndex);
  const pairs = column ? groupCounts(table.rows, column.index) : [];
  return {
    file: String(fileName || ''),
    rows: table.rows.length,
    cols: table.header.length,
    totalRows: table.totalRows,
    truncated: !!table.truncated,
    at: Date.now(),
    columns: (table.columns || []).map((c) => ({ name: c.name, type: c.type })),
    group: column
      ? { column: column.name, total: pairs.length, pairs: pairs.slice(0, 12).map((p) => ({ value: p.value, count: p.count })) }
      : null,
  };
}

/**
 * 喂给模型的那段话。
 *
 * 两个硬上限都在这一个函数里守住：llm.chat 的 text ≤4000 字符（手册 §6.6），而这里连
 * 1800 字符都不到——因为一份 200 行的表如果原样拼进去，会是几万字符，宿主会直接拒，
 * 用户看到的却只是"模型解读失败"。所以摘要里只留计数与类型，一行原始数据都不带。
 */
function buildDigest(summary) {
  if (!summary) return '';
  const lines = [];
  lines.push('这是插件从一份 CSV 里算出来的统计摘要，只有结论、没有原始行。请用中文说三句话：这张表在讲什么、分组里最明显的集中或偏斜、以及一句数据质量上的提醒。不要编造摘要里没有的数字。');
  lines.push('文件：' + (summary.file || '（未命名）') + '，' + summary.rows + ' 行 × ' + summary.cols + ' 列（第一行是表头）');
  lines.push(
    summary.truncated
      ? '范围：文件里共 ' + summary.totalRows + ' 行，只统计了前 ' + summary.rows + ' 行'
      : '范围：全部 ' + summary.rows + ' 行',
  );
  const types = (summary.columns || []).map((c) => c.name + '=' + (TYPE_LABELS[c.type] || c.type)).join('，');
  if (types) lines.push('列类型：' + types);
  if (summary.group && summary.group.pairs && summary.group.pairs.length) {
    lines.push(
      '按「' + summary.group.column + '」分组（共 ' + summary.group.total + ' 组，按行数降序）：' +
        summary.group.pairs.map((p) => p.value + ' ' + p.count).join('、'),
    );
  } else {
    lines.push('没有可用的分组列。');
  }
  const text = lines.join('\n');
  return text.length > 1800 ? text.slice(0, 1780) + '…（摘要已截断）' : text;
}
