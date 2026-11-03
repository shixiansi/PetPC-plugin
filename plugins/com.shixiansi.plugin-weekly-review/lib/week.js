// lib/week.js —— 周区间与"到点了没"的纯函数
//
// 单独一层的原因：这一批是唯一会被"跨月 / 跨年 / 夏令时"弄错的地方，错了的症状是报告里少一天或
// 多一天——肉眼极难发现。它们不读时钟（入参是毫秒），用例能把跨月、跨年那两周直接钉住。
// 边界按**本地时区**：周一 00:00:00.000 → 周日 23:59:59.999。

'use strict';

function pad2(n) {
  return `${n}`.padStart(2, '0');
}

/** 本地日键 YYYY-MM-DD。按天去重（lastReportDay）用的就是它。 */
function dayKeyOf(ms) {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 月.日（卡片与标题里的短写法：10.26）。 */
function shortDate(ms) {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  return `${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
}

/**
 * 这一周的区间：周一 00:00 → 周日 23:59:59.999（本地时区）。
 *
 * 全部用**日期算术**而不是加 7×86400000：有夏令时的时区里那 7 天不是 168 小时，加毫秒会让周末
 * 那一天被算两次、或者整段丢掉。
 *
 * @returns {{start:number, end:number, days:string[]}} days 是这七天的日键（周一到周日）。
 */
function weekRangeOf(ms) {
  const at = new Date(Number.isFinite(ms) ? ms : Date.now());
  const sinceMonday = (at.getDay() + 6) % 7;   // getDay(): 0=周日 … 6=周六 → 0=周一
  const start = new Date(at.getFullYear(), at.getMonth(), at.getDate() - sinceMonday, 0, 0, 0, 0);
  // 周日最后一毫秒 = 下周一 00:00 的前一毫秒（跨夏令时那天也还是"周日的最后一刻"）。
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7, 0, 0, 0, -1);
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    // 取正午再取日键：切换日的凌晨可能是 01:00 或 23:00，正午永远是那一天。
    const noon = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i, 12, 0, 0, 0);
    days.push(dayKeyOf(noon.getTime()));
  }
  return { start: start.getTime(), end: end.getTime(), days };
}

/** 区间的人话：10.26–11.01（卡片、标题、模板周报共用同一个写法）。 */
function weekLabel(range) {
  const r = range && Number.isFinite(range.start) ? range : weekRangeOf(Date.now());
  return `${shortDate(r.start)}–${shortDate(r.end)}`;
}

/** 某个日键在不在这一周里（日记按天归档，要挑出本周那几篇）。 */
function dayInRange(range, day) {
  return Boolean(range && Array.isArray(range.days) && range.days.includes(String(day || '')));
}

/**
 * "HH:MM" → {h,min}。非法值回 20:00（清单里的默认值）；回 00:00 会让一次手滑变成
 * "每天零点生成一份"。
 */
function parseClock(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value === undefined || value === null ? '' : value).trim());
  if (!m) return { h: 20, min: 0 };
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!(h >= 0 && h <= 23) || !(min >= 0 && min <= 59)) return { h: 20, min: 0 };
  return { h, min };
}

/** 星期几归一：清单里是 "0"…"6"（0=周日，与 Date.getDay 同一套词），脏值回周日。 */
function weekdayOf(value) {
  const n = Number.parseInt(String(value === undefined || value === null ? '' : value), 10);
  if (!Number.isFinite(n)) return 0;
  return ((n % 7) + 7) % 7;
}

/**
 * 现在到点了吗？只管"这一天、这个时刻过了没有"，**不管"今天生成过没"**——后者是 storage 里
 * lastReportDay 的事（重启之后只有它还记得）。
 *
 * @returns {{due:boolean, day:string}}
 */
function dueNow(ms, weekday, clockText) {
  const at = new Date(Number.isFinite(ms) ? ms : Date.now());
  const day = dayKeyOf(at.getTime());
  if (at.getDay() !== weekdayOf(weekday)) return { due: false, day };
  const { h, min } = parseClock(clockText);
  const dueAt = new Date(at.getFullYear(), at.getMonth(), at.getDate(), h, min, 0, 0).getTime();
  // 过了 20:00 就一直是"到点且还没做"：宿主半夜重启、用户白天没开机都靠这一点补上。
  return { due: at.getTime() >= dueAt, day };
}
