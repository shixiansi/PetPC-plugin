// lib/agenda.js —— 清单的归一化与"这一屏该画什么"（纯函数，不碰 DOM、不读时钟）
//
// 一条清单项是 {name, date:"YYYY-MM-DD", yearly:boolean}：yearly 只借 `date` 的月和日（2 月 29 日
// 的规则见 lib/dates.js），一次性条目则 `date` 就是那一天，过去了显示「已过 N 天」。
//
// 吐出来的是**视图模型**：每行 {name, date, days, remaining, text}，外加 nearest 与 total。卡片、
// 徽标、气泡、plugin.call 的答案都从它派生——"三个落点说的是同一件事"因此是结构保证。

'use strict';

const Agenda = (function () {
  // 宿主对徽标文字的上限是 16 个字（Go 侧 MaxBadgeRunes）。**按码点数**，和宿主同一把尺子：
  // 用 .length 会把 emoji 数成 2，于是"本地 15 个字"在真机上被拒。
  const BADGE_MAX = 16;
  const BUBBLE_MAX = 80;
  const NAME_MAX = 40;
  const MAX_ITEMS = 120;

  /** 按码点截断；超了用省略号，保证结果一定在 max 之内。 */
  function clip(text, max) {
    const runes = Array.from(String(text === undefined || text === null ? '' : text));
    return runes.length <= max ? runes.join('') : runes.slice(0, Math.max(0, max - 1)).join('') + '…';
  }

  function cleanName(raw) {
    return String(raw === undefined || raw === null ? '' : raw)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, NAME_MAX);
  }

  /** 一条输入（来自表单、storage 或 plugin.call）→ 合法清单项；不合法返回 null。 */
  function normalizeEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = cleanName(raw.name);
    const p = Dates.parts(raw.date);
    if (!name || !p) return null;
    // 统一成补零的 "YYYY-MM-DD"：用户可能写 "2026-5-2"，后面所有比较都靠这个形状。
    return { name, date: Dates.isoOf(new Date(p.y, p.m - 1, p.d)), yearly: raw.yearly === true };
  }

  /**
   * storage 里那个字符串 → 清单项数组。坏数据一律当"没有这一条"而不是抛：这个键可能被更老的版本、
   * 或者用户手改过。整份读不出来时宁可显示空状态，也不要让一屏报错把用户挡在外面。
   */
  function parseList(raw) {
    const text = String(raw === undefined || raw === null ? '' : raw).trim();
    if (!text) return [];
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return [];
    }
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.items) ? parsed.items : [];
    const out = [];
    for (const row of rows) {
      const entry = normalizeEntry(row);
      if (!entry) continue;
      out.push(entry);
      if (out.length >= MAX_ITEMS) break;
    }
    return out;
  }

  function serializeList(list) {
    const items = [];
    for (const row of Array.isArray(list) ? list : []) {
      const entry = normalizeEntry(row);
      if (!entry) continue;
      items.push(entry);
      if (items.length >= MAX_ITEMS) break;
    }
    return JSON.stringify({ version: 1, items });
  }

  /** "还有 8 天" / "今天" / "已过 3 天"。卡片、徽标、气泡共用的那半句话。 */
  function relativeText(days) {
    if (!Number.isFinite(days)) return '';
    if (days === 0) return '今天';
    return days > 0 ? '还有 ' + days + ' 天' : '已过 ' + Math.abs(days) + ' 天';
  }

  /** 一条清单项在"今天"这一天的落点：{date, days}，算不出来就是 null。 */
  function occurrence(entry, today) {
    const p = Dates.parts(entry.date);
    if (!p) return null;
    if (!entry.yearly) {
      const days = Dates.dayDiff(today, entry.date);
      return days === null ? null : { date: entry.date, days };
    }
    const next = Dates.nextYearly(today, p.m, p.d);
    if (!next) return null;
    const days = Dates.dayDiff(today, next);
    return days === null ? null : { date: next, days };
  }

  /**
   * 排序：还没到的排前面（最近的先），已经过去的排在后面（刚过去的先）。这样第一行永远是最值得
   * 看的那一行，而过去的事也不会消失。
   */
  function compareRows(a, b) {
    const au = a.days >= 0;
    const bu = b.days >= 0;
    if (au !== bu) return au ? -1 : 1;
    return au ? a.days - b.days : b.days - a.days;
  }

  /**
   * 清单 + 今天 → 视图模型。
   *
   * remaining 是 days 的同义词，故意留两份：卡片、徽标、气泡按 remaining 说话（"还剩几天"），
   * plugin.call 的消费方按 days 读。两个名字指同一个数，改哪一处都不会让另一边漂。
   */
  function build(list, today) {
    const ref = Dates.parts(today) ? today : Dates.todayISO(new Date());
    const rows = [];
    for (const entry of Array.isArray(list) ? list : []) {
      const one = occurrence(entry, ref);
      if (!one) continue;
      rows.push({
        name: entry.name,
        date: one.date,
        days: one.days,
        remaining: one.days,
        yearly: entry.yearly !== false,
        text: entry.name + ' · ' + relativeText(one.days),
      });
    }
    rows.sort(compareRows);
    let nearest = null;
    for (const row of rows) {
      if (row.days >= 0) {
        nearest = row;
        break;
      }
    }
    return { items: rows, nearest, total: rows.length, today: ref };
  }

  /**
   * 宠物头顶那一行字（上限 16 字）。空清单、以及"最近的那个还在 advanceDays 之外"都返回空串：
   * 徽标是稀缺的（头顶就那一行），离得远的事不该占着它。空串的语义是"清除"（手册 6.5）。
   */
  function badgeText(agenda, mode, advanceDays) {
    if (!agenda || !agenda.total) return '';
    if (mode === 'count') return clip('纪念日 ' + agenda.total + ' 个', BADGE_MAX);
    const near = agenda.nearest;
    if (!near) return '';
    const window = Number.isFinite(advanceDays) ? advanceDays : 30;
    if (near.days > window) return '';
    if (near.days === 0) return clip('今天 ' + near.name, BADGE_MAX);
    return clip(near.name + ' 还有 ' + near.days + ' 天', BADGE_MAX);
  }

  /** 当天那句气泡。文案里必须有「今天」——那是这个插件当天唯一要说的事。 */
  function bubbleText(agenda) {
    if (!agenda) return '';
    const names = [];
    for (const row of agenda.items) {
      if (row.days === 0) names.push(row.name);
    }
    if (!names.length) return '';
    return clip('今天是' + names.join('、') + '，别忘了。', BUBBLE_MAX);
  }

  /** 卡片上那三条（浮层面是固定矩形，只放得下三条）。 */
  function top(agenda, count) {
    const n = Number.isFinite(count) && count > 0 ? count : 3;
    return agenda && Array.isArray(agenda.items) ? agenda.items.slice(0, n) : [];
  }

  return {
    BADGE_MAX,
    NAME_MAX,
    clip,
    cleanName,
    normalizeEntry,
    parseList,
    serializeList,
    relativeText,
    occurrence,
    build,
    badgeText,
    bubbleText,
    top,
  };
})();
