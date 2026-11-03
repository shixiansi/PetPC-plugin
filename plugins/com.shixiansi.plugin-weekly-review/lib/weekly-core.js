// lib/weekly-core.js —— 周报的纯函数层：周窗口计算、数据归集、报告文本组装。
//
// 这里不碰宿主、不发网络、不取当前时间——"现在几点"由调用方传进来。测试接缝：
// panel.html 引入即 window.WeeklyCore；测试用 new Function 装载同一份源码。
//
// 数据源容忍（任务书的核心要求，测试钉死）：
//   · 每个数据源独立可用/失败：collect() 的 sources 参数是 [{name, result|error}]，
//     失败的源在报告里写明"缺哪块"，绝不让一个失联插件把整份周报拖死；
//   · 全部失败 → 纯模板报告照出（绝不开天窗）。
//
// 报告形状：≤300 字（超了截断并标注）；llm 失败时退化为数字模板。
'use strict';

(function () {
  const LIMIT = 300;

  /** 本周窗口（周一起算）：返回 {start:Date, end:Date, label:"2026-W45"}。anchor 是任意时刻。 */
  function weekWindow(anchorMs, offsetMin) {
    const off = Number.isFinite(offsetMin) ? offsetMin : -new Date().getTimezoneOffset();
    // 以"本地墙钟"为基准：epoch + 偏移 → 用 UTC 取值器读本地日期。
    const local = new Date(anchorMs + off * 60000);
    const day = local.getUTCDay(); // 0=周日…6=周六
    const backToMonday = (day + 6) % 7;
    const start = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - backToMonday));
    const end = new Date(start.getTime() + 7 * 86400000);
    // ISO 周号：周四所在年
    const thursday = new Date(start.getTime() + 3 * 86400000);
    const jan1 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((thursday - jan1) / 86400000 + jan1.getUTCDay() + 1) / 7);
    const pad = (n) => (n < 10 ? '0' + n : String(n));
    return {
      start,
      end,
      label: `${thursday.getUTCFullYear()}-W${pad(week)}`,
      startDate: `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}-${pad(start.getUTCDate())}`,
    };
  }

  /**
   * 归集数据源。sources: [{name, ok:bool, data:object, error:string}]（调用方把 call 的
   * 成败翻译成这个形状——纯函数不碰宿主）。返回 {available:{name:data}, missing:[name]}。
   */
  function collect(sources) {
    const available = {};
    const missing = [];
    for (const s of sources || []) {
      if (s && s.ok && s.data && typeof s.data === 'object') available[s.name] = s.data;
      else missing.push(String((s && s.name) || '?'));
    }
    return { available, missing };
  }

  /** 数字模板：没有模型时也成立的一句式汇总。missing 一定要写出来。 */
  function templateText(win, avail, missing) {
    const parts = [];
    if (avail.todo && Number.isFinite(avail.todo.done) && Number.isFinite(avail.todo.total)) {
      parts.push(`待办完成 ${avail.todo.done}/${avail.todo.total}`);
    }
    if (avail.pomodoro && Number.isFinite(avail.pomodoro.minutes)) {
      parts.push(`专注 ${avail.pomodoro.minutes} 分钟${Number.isFinite(avail.pomodoro.count) ? `（${avail.pomodoro.count} 个番茄）` : ''}`);
    }
    if (avail.diary && Number.isFinite(avail.diary.entries)) {
      parts.push(`日记 ${avail.diary.entries} 篇`);
    }
    let head = `${win.label}（${win.startDate} 起）：`;
    let body = parts.length > 0 ? parts.join('；') + '。' : '本周没有拿到任何数据。';
    let tail = missing.length > 0 ? ` 缺数据源：${missing.join('、')}。` : '';
    let text = head + body + tail;
    if (text.length > LIMIT) {
      // 超长截断：标注本身也要在 300 字内。
      text = text.slice(0, LIMIT - '…（超长截断）'.length) + '…（超长截断）';
    }
    return text;
  }

  /** 供 llm.chat 的 prompt：只有统计摘要，没有原始数据。 */
  function buildPrompt(win, avail, missing) {
    const lines = [];
    lines.push(`把下面这份${win.label}的统计写成不超过 300 字的中文周报，语气自然，先总结再分点；`);
    if (missing.length > 0) lines.push(`这些数据源本周拿不到，报告里要如实写明缺了什么：${missing.join('、')}。`);
    lines.push('统计：');
    lines.push(JSON.stringify({ week: win.label, start: win.startDate, ...avail }));
    return lines.join('\n');
  }

  window.WeeklyCore = Object.freeze({
    LIMIT,
    weekWindow,
    collect,
    templateText,
    buildPrompt,
  });
})();
