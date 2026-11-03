// lib/dates.js —— 纪念日的纯日期层：不碰 DOM、不碰宿主桥、不看真实时钟。
//
// 为什么是经典 script 而不是 module：panel.html 用 <script src> 按序加载（calendar 插件的
// 同一型），app.js 直接读全局 AnniversaryDates；测试用 new Function(source) 就能拿到同一份
// 纯函数（vitest 与 jsdom 都不用走 ESM）。
//
// 为什么"今天"处处是入参：同一份函数要被测试注入"今天 = 2026-03-01"反复问，注入的是
// "本地零点"与"本地日期串"，所以这个文件里没有一处取当前时间的调用。
//
// 平年闰年只用自家的 daysInMonth（Date 的月溢出回绕正好留给 addMonths 用）。
// 本地偏移（分钟）由调用方给：常驻帧给真实时区，测试给固定值；这个文件不做时区换算。

'use strict';

(function () {
  const MS_DAY = 86400000;

  // --- 基础 ---------------------------------------------------------------

  function isLeapYear(y) {
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  }

  function daysInMonth(y, mo) {
    if (mo === 2) return isLeapYear(y) ? 29 : 28;
    if (mo === 4 || mo === 6 || mo === 9 || mo === 11) return 30;
    return 31;
  }

  // --- 记录的解析与规范化 -----------------------------------------------------
  //
  // storage 里的一条：{ id, title, date: 'YYYY-MM-DD', yearly: bool }
  // date 用原生 <input type="date"> 的串格式（0001-9999 年）。JSON 里没有类型，读回来的
  // 全要过一遍 parseRecord：坏行跳过（renumber 由写侧负责），绝不抛错。

  // 'YYYY-MM-DD' 只认数字形状：Date('2027-5-20') 这类宽松解析在 Node 与浏览器之间差 8 小时
  // （后者按本地时区），不能用来校验。
  const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  /**
   * 解析一条纪念日。返回 null = 这行坏掉了（调用方跳过它，界面与 next 都不提）。
   * 规则：year 0001–9999、mo 1–12、d 1–当月天数（2/29 只在闰年合法，平年的 02-29 是录入错误）。
   * 不接受 Date() 宽松解析：'2026-02-30' 是坏数据，不能静默滚到 3 月。
   */
  function parseRecord(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const m = DATE_RE.exec(String(raw.date || ''));
    if (!m) return null;
    const year = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12) return null;
    if (d < 1 || d > daysInMonth(year, mo)) return null;
    const title = String(raw.title || '').trim();
    return {
      id: String(raw.id || ''),
      title,
      date: `${m[1]}-${m[2]}-${m[3]}`,
      yearly: raw.yearly !== false, // 缺省按每年重复（生日是这个插件的主体）
    };
  }

  /** 整表解析：返回合法记录数组；坏行直接丢（写回时整表覆盖，不需要下标）。 */
  function parseRecords(text) {
    let data;
    try {
      data = JSON.parse(String(text || '[]'));
    } catch {
      return [];
    }
    if (!Array.isArray(data)) return [];
    const out = [];
    for (const raw of data) {
      const rec = parseRecord(raw);
      if (rec) out.push(rec);
    }
    return out;
  }

  // --- 本地日期的算术（全部走"本地零点 + 天数偏移"这一条路） ---------------------

  /** 本地日期串（todayKey 等）→ 本地零点的 epoch 毫秒。 */
  function localDayStartMs(key, offsetMin) {
    const m = DATE_RE.exec(String(key || ''));
    if (!m) return NaN;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - offsetMin * 60000;
  }

  /** epoch 毫秒 → 'YYYY-MM-DD'（按给定本地偏移）。年份取四位：0001 也要是 '0001'。 */
  function dayKeyOf(ms, offsetMin) {
    const d = new Date(ms + offsetMin * 60000);
    const y = String(d.getUTCFullYear()).padStart(4, '0');
    const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${mo}-${day}`;
  }

  /**
   * 月+日 → 查询年里的目标日键。
   * 平年 2/29 → 落 2/28（落日不追赶：闰年的"第 29 天"平年里就在最后一天过）。
   * 2/29 在闰年、1/31 在 4 月 → 夹到当月最后一天：日历上最后一个"那一天"就是它。
   */
  function targetDayKey(month, day, year, offsetMin) {
    const dim = daysInMonth(year, month);
    const d = Math.min(day, dim);
    const key = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return { key, clamped: d !== day };
  }

  /**
   * 一条纪念日 → 最近的未过发生。
   * 规则（写在这里，测试钉死）：
   * - 当天 == 纪念日：今天就是要找的那个，daysLeft = 0（不是 1，更不是负数）。
   * - yearly：月-日 >= 今天的月-日 → 今年；否则明年。平年 2/29 → 今年 2/28。
   * - 单次（yearly=false）：日期 >= 今天才算（今天 = 还没过的那天）；过了就不再出现。
   * 返回 { dateKey, daysLeft, targetYear, clamped }，daysLeft 是整数天（未来为正，今天为 0）。
   */
  function nextOccurrence(rec, todayKey, offsetMin) {
    const m = DATE_RE.exec(rec.date);
    if (!m) return null;
    const month = Number(m[2]);
    const day = Number(m[3]);
    const year = Number(m[1]);
    const todayStart = localDayStartMs(todayKey, offsetMin);
    if (!Number.isFinite(todayStart)) return null;

    let targetYear;
    if (rec.yearly) {
      const year = Number(todayKey.slice(0, 4));
      const todayKeySlice = todayKey.slice(5, 10); // 'MM-DD'
      // 平年 2/29 → 02-28（落日规则，targetDayKey 同源）：按"落在今年里的那一天"比，
      // 02-28 >= 02-28，所以查询当天（平年 2/28）返回的就是它、daysLeft=0。
      const effDay = month === 2 && day === 29 && !isLeapYear(year) ? 28 : day;
      const eff = `${String(month).padStart(2, '0')}-${String(effDay).padStart(2, '0')}`;
      targetYear = year + (todayKeySlice <= eff ? 0 : 1);
    } else {
      targetYear = year;
    }
    const t = targetDayKey(month, day, targetYear, offsetMin);
    const targetStart = localDayStartMs(t.key, offsetMin);
    const daysLeft = Math.round((targetStart - todayStart) / MS_DAY);
    // 单次且已过（daysLeft < 0）：不再出现——调用方把它从 next 与列表里剔除。
    return { dateKey: t.key, daysLeft, targetYear, clamped: t.clamped };
  }

  /**
   * 整表的"下一个"：合法记录里 daysLeft 最小的那个。并列（同一天两个纪念日）按录入顺序——
   * 数组的顺序就是用户在插件页里的顺序，不发明第二套规则。
   * 返回值第一行带 year（targetYear）：next 的消费方（模型、别的插件）要能读出"哪一年"。
   */
  function nextOf(records, todayKey, offsetMin) {
    let best = null;
    for (const rec of records) {
      const occ = nextOccurrence(rec, todayKey, offsetMin);
      if (!occ || occ.daysLeft < 0) continue; // 单次已过的不参加
      if (!best || occ.daysLeft < best.daysLeft) {
        best = {
          id: rec.id,
          title: rec.title,
          yearly: rec.yearly,
          originalDate: rec.date,
          date: occ.dateKey,
          daysLeft: occ.daysLeft,
          year: occ.targetYear,
          clamped: occ.clamped,
        };
      }
    }
    return best;
  }

  /** 整表按"最近的先"排（daysLeft 升序；单次已过的剔除）。 */
  function sortedWithDays(records, todayKey, offsetMin) {
    const out = [];
    for (const rec of records) {
      const occ = nextOccurrence(rec, todayKey, offsetMin);
      if (!occ) continue;
      if (!rec.yearly && occ.daysLeft < 0) continue; // 单次已过：列表里也不再出现
      out.push({
        id: rec.id,
        title: rec.title,
        yearly: rec.yearly,
        originalDate: rec.date,
        date: occ.dateKey,
        daysLeft: occ.daysLeft,
        year: occ.targetYear,
        clamped: occ.clamped,
      });
    }
    out.sort((a, b) => a.daysLeft - b.daysLeft);
    return out;
  }

  // --- 徽标 -------------------------------------------------------------------

  /** 徽标 ≤16 字符（手册 pet.badge 的上限）：今天 = "今天"，否则 = N 天。 */
  function badgeText(daysLeft) {
    if (daysLeft <= 0) return '今天';
    return `${daysLeft}天`;
  }

  window.AnniversaryDates = Object.freeze({
    isLeapYear,
    daysInMonth,
    parseRecord,
    parseRecords,
    localDayStartMs,
    dayKeyOf,
    targetDayKey,
    nextOccurrence,
    nextOf,
    sortedWithDays,
    badgeText,
    DATE_RE,
  });
})();
