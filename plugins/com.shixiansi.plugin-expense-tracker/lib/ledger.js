// lib/ledger.js —— 账本（JSONL 追加 + 月度聚合，纯逻辑 + 注入网关）
//
// 存储布局：
//   ledger/<YYYY-MM>.jsonl   每行一笔 {id, at, day, type, amount, category, note, raw}
//   ledger/index             月索引 ["2026-10", …]
//
// 为什么 JSONL：追加写入与宿主 storage.set 天然契合（整月一份字符串），坏行可以跳过；
// 聚合时读当月文件即可（跨月报表逐月读）。
//
// 坏行防线（题目要求）：解析 ledger 时跳过坏 JSON 行并计数——**脏数据不能崩账本**，
// 也不能在查询时被当成 0 元交易。

'use strict';

const LEDGER_PREFIX = 'ledger/';
const LEDGER_INDEX_KEY = 'ledger/index';

function ledgerMonthOf(day) {
  return String(day || '').slice(0, 7); // YYYY-MM
}

function ledgerKeyForMonth(month) {
  return `${LEDGER_PREFIX}${month}.jsonl`;
}

/** 序列化一行。 */
function ledgerSerialize(entry) {
  return JSON.stringify(entry);
}

/** 解析整月文件：坏行跳过并计数。返回 {entries, badLines}。 */
function ledgerParseMonth(text) {
  const entries = [];
  let badLines = 0;
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object' && typeof obj.amount === 'number' && Number.isFinite(obj.amount)) {
        entries.push(obj);
      } else {
        badLines += 1;
      }
    } catch {
      badLines += 1;
    }
  }
  return { entries, badLines };
}

/** 账本仓库：所有 IO 经 gateway(method, payload)（app.js 注入 request；测试注入假网关）。 */
function ledgerCreateStore(gateway) {
  if (typeof gateway !== 'function') throw new Error('ledgerCreateStore 需要网关函数');
  async function readMonth(month) {
    const out = await gateway('storage.get', { key: ledgerKeyForMonth(month) }).catch(() => ({ value: '' }));
    return ledgerParseMonth(out && out.value);
  }
  async function writeMonth(month, entries) {
    const body = entries.map(ledgerSerialize).join('\n');
    await gateway('storage.set', { key: ledgerKeyForMonth(month), value: body });
  }
  async function readIndex() {
    const out = await gateway('storage.get', { key: LEDGER_INDEX_KEY }).catch(() => ({ value: '' }));
    try {
      const parsed = JSON.parse((out && out.value) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  async function writeIndex(months) {
    await gateway('storage.set', { key: LEDGER_INDEX_KEY, value: JSON.stringify(months) });
  }
  return {
    gateway,
    readMonth,
    writeMonth,
    readIndex,
    writeIndex,
  };
}

/** 记一笔：追加到当月文件 + 维护月索引。 */
async function ledgerAppend(store, entry) {
  if (!entry || !entry.day || !Number.isFinite(entry.amount)) throw new Error('账目缺 day/amount');
  const month = ledgerMonthOf(entry.day);
  const { entries } = await store.readMonth(month);
  entries.push(entry);
  await store.writeMonth(month, entries);
  const months = await store.readIndex();
  if (!months.includes(month)) {
    months.push(month);
    months.sort();
    await store.writeIndex(months);
  }
  return { month, total: entries.length };
}

/** 删除一笔（按 id，全索引找）。 */
async function ledgerRemove(store, id) {
  const months = await store.readIndex();
  for (const month of months) {
    const { entries } = await store.readMonth(month);
    const next = entries.filter((e) => e.id !== id);
    if (next.length !== entries.length) {
      await store.writeMonth(month, next);
      return { removed: true, month };
    }
  }
  return { removed: false };
}

/** 读一个月的账（坏行只计数不崩）。 */
async function ledgerMonthEntries(store, month) {
  const { entries, badLines } = await store.readMonth(month);
  return { entries: entries.slice().sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.at - b.at)), badLines };
}

/**
 * 月度聚合（图表数据）：
 *   byCategory: [{category, total, share}]（按金额降序）
 *   byDay: [{day, total}]（1 号到月末，缺日补 0）
 *   totals: {expense, income, refund, count}
 */
function ledgerAggregate(entries, month) {
  const totals = { expense: 0, income: 0, refund: 0, count: 0 };
  const catTotals = new Map();
  const dayTotals = new Map();
  for (const e of entries) {
    totals.count += 1;
    if (e.type === 'income') totals.income += e.amount;
    else if (e.type === 'refund') totals.refund += e.amount;
    else totals.expense += e.amount;
    if (e.type === 'expense') {
      catTotals.set(e.category, (catTotals.get(e.category) || 0) + e.amount);
    }
    dayTotals.set(e.day, (dayTotals.get(e.day) || 0) + (e.type === 'expense' ? e.amount : 0));
  }
  const totalExpense = totals.expense;
  const byCategory = [...catTotals.entries()]
    .map(([category, total]) => ({ category, total, share: totalExpense > 0 ? total / totalExpense : 0 }))
    .sort((a, b) => b.total - a.total);
  // 月内逐日（缺日补 0）。
  const [y, m] = String(month).split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const byDay = [];
  for (let d = 1; d <= daysInMonth; d += 1) {
    const day = `${month}-${String(d).padStart(2, '0')}`;
    byDay.push({ day, total: dayTotals.get(day) || 0 });
  }
  for (const k of ['expense', 'income', 'refund']) totals[k] = Math.round(totals[k] * 100) / 100;
  return { totals, byCategory, byDay };
}

const ExpenseLedger = {
  LEDGER_PREFIX, LEDGER_INDEX_KEY,
  ledgerMonthOf, ledgerKeyForMonth, ledgerSerialize, ledgerParseMonth,
  ledgerCreateStore, ledgerAppend, ledgerRemove, ledgerMonthEntries, ledgerAggregate,
};
