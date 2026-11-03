// lib/dates.js —— 只认「本地日历上的某一天」的纯函数
//
// 为什么单独一层、而且不接受"现在几点"：整个插件的正确性都压在两句话上——"两个本地日期差几个
// 整天"和"下一次落在哪一天"。最容易写错的两处：(1) **夏令时**，有些时区一年里有一天只有 23 小时、
// 另一天 25 小时，直接 `(b-a)/86400000` 再 floor 会在春季拨快那天少算一天，所以两边都归一到本地
// 00:00、最后 round；(2) **2 月 29 日**，平年没有这一天，规则写在 nextYearly 上面（README 里是
// 同一句话）。这一层不碰 DOM、不碰宿主、不读时钟，所以用例可以直接喂日期字符串进来。

'use strict';

const Dates = (function () {
  const MS_PER_DAY = 86400000;
  // 只认 "YYYY-MM-DD"：storage 里存的、input[type=date] 给的、plugin.call 回来的都是这个形状。
  const ISO_PATTERN = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function isLeapYear(year) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  }

  /** month 是 1..12（和用户看到的月份一致，只有 new Date() 处才减 1）。 */
  function daysInMonth(year, month) {
    if (month === 2) return isLeapYear(year) ? 29 : 28;
    if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
    return 31;
  }

  /** 本地日历上的那一天 → "YYYY-MM-DD"。 */
  function isoOf(date) {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  }

  /** "YYYY-MM-DD" → {y, m, d}（m 是 1..12）；不存在的日子（2 月 30 日、平年的 2 月 29 日）→ null。 */
  function parts(text) {
    const m = ISO_PATTERN.exec(String(text === undefined || text === null ? '' : text).trim());
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    // 1900..2200 之外的不是"纪念日"，是打错了（也顺手挡住 new Date(y,…) 的两位年份陷阱）。
    if (!(y >= 1900 && y <= 2200)) return null;
    if (!(mo >= 1 && mo <= 12)) return null;
    if (!(d >= 1 && d <= daysInMonth(y, mo))) return null;
    return { y, m: mo, d };
  }

  /** → 本地当天 00:00 的 Date。用 new Date(y, m-1, d) 构造，跨夏令时也落在当天。 */
  function localDay(text) {
    const p = parts(text);
    return p ? new Date(p.y, p.m - 1, p.d) : null;
  }

  function todayISO(now) {
    return isoOf(now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date());
  }

  /**
   * 整天差：toISO - fromISO，按**本地日历**的整天数算。
   * 12 月 31 日 → 1 月 1 日是 **1**：跨年只是年份变了，日历上没有跳过任何一天。
   */
  function dayDiff(fromISO, toISO) {
    const a = localDay(fromISO);
    const b = localDay(toISO);
    if (!a || !b) return null;
    // 两边都已归一到本地 00:00，差值只可能是 N×86400000 或它的 ±3600000（夏令时那一天）。
    // 必须 round：floor 会让"春季拨快"那一天少算一天。
    return Math.round((b - a) / MS_PER_DAY);
  }

  /**
   * 「每年重复」的下一次落在哪一天。
   *
   * **2 月 29 日的人在平年不过生日**：平年的 2 月 29 日**当年不出现**，下一次是下一个闰年。
   * （另一种常见做法是折算到 3 月 1 日，本插件不这么做——README 里是同一句话。）
   * 所以从 2027-02-28 看，下一次是 2028-02-29，还剩 366 天。
   *
   * 上限 9 年：闰年间隔 4 年，世纪年不闰时（1900 / 2100 这种）是 8 年。
   */
  function nextYearly(fromISO, month, day) {
    const from = localDay(fromISO);
    if (!from) return null;
    if (!(month >= 1 && month <= 12)) return null;
    if (!(day >= 1 && day <= 31)) return null;
    const startYear = from.getFullYear();
    for (let y = startYear; y <= startYear + 8; y += 1) {
      if (day > daysInMonth(y, month)) continue; // 平年的 2 月 29 日：今年不出现
      const candidate = new Date(y, month - 1, day);
      if (candidate >= from) return isoOf(candidate);
    }
    return null;
  }

  return { MS_PER_DAY, pad2, isLeapYear, daysInMonth, isoOf, parts, localDay, todayISO, dayDiff, nextYearly };
})();
