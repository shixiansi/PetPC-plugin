// lib/price-core.js —— 网页变化监控的纯函数层：监控项解析、值提取、变化判定、退避。
//
// 这里不碰宿主、不碰 DOM、不发网络。测试接缝：panel.html 引入即 window.PriceCore；
// 测试用 new Function 装载同一份源码。
//
// 报警语义（测试钉死）：
//   · **首次抓取不报警**——没有 lastValue 就只立基线（"变化"的定义是"与上次的已知值不同"）；
//   · 值没变 = 安静（不写、不气泡、不记历史）；
//   · 值变了 = 恰一条气泡 + 历史记一条；
//   · 抓取失败/提取失败 = 不算变化（不气泡），但失败计数 +1、下次抓取按退避推后。
//
// 退避（反爬自觉）：连续失败 n 次 → 间隔 = 基础间隔 × 2^n，封顶 60 分钟；成功即清零。
'use strict';

(function () {
  const MS_MIN = 60000;
  const BACKOFF_CAP_MIN = 60;

  /** 读回 storage 里的监控项列表：任何畸形输入都落到空列表，绝不抛错。 */
  function parseItems(text) {
    if (!text) return [];
    let v;
    try { v = JSON.parse(String(text)); } catch { return []; }
    if (!Array.isArray(v)) return [];
    return v
      .filter((it) => it && typeof it === 'object' && typeof it.url === 'string' && it.url)
      .slice(0, 50)
      .map((it) => ({
        id: String(it.id || ''),
        name: String(it.name || '').slice(0, 60) || '(未命名)',
        url: String(it.url),
        selector: typeof it.selector === 'string' ? it.selector : '',
        regex: typeof it.regex === 'string' ? it.regex : '',
        lastValue: it.lastValue === null || it.lastValue === undefined ? null : String(it.lastValue),
        lastAt: Number(it.lastAt) || 0,
        failCount: Number(it.failCount) || 0,
        nextAt: Number(it.nextAt) || 0,
        lastError: typeof it.lastError === 'string' ? it.lastError : '',
        history: Array.isArray(it.history)
          ? it.history
            .filter((h) => h && typeof h === 'object' && typeof h.value === 'string')
            .slice(-20)
            .map((h) => ({ at: Number(h.at) || 0, value: h.value }))
          : [],
      }));
  }

  /** 正则提取：pattern 是字符串形式的正则（新的 RegExp(pattern)）。命中组 1 优先，否则整体匹配。 */
  function extractWithRegex(html, pattern) {
    if (!pattern) return null;
    let re;
    try { re = new RegExp(pattern, 'i'); } catch { return null; }
    const m = re.exec(String(html || ''));
    if (!m) return null;
    return (m[1] !== undefined ? m[1] : m[0]).trim();
  }

  /**
   * CSS 选择器提取：需要 DOMParser（常驻帧/插件页里都有；纯 node 测试环境没有——
   * 那条路走 jsdom 集成测试）。没命中返回 null（=提取失败，不算变化）。
   */
  function extractWithSelector(html, selector) {
    if (!selector || typeof DOMParser === 'undefined') return null;
    try {
      const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
      const el = doc.querySelector(selector);
      if (!el) return null;
      return (el.textContent || '').trim().slice(0, 2000);
    } catch {
      return null;
    }
  }

  /** 按监控项配置提取：regex 优先（跨标签页面的正则更稳），没有才走选择器。 */
  function extract(item, html) {
    if (item.regex) return extractWithRegex(html, item.regex);
    if (item.selector) return extractWithSelector(html, item.selector);
    return null;
  }

  /** 失败后的下次抓取时刻：基础间隔 × 2^失败次数，封顶 60 分钟。 */
  function backoffMs(baseMin, failCount) {
    const base = Math.max(1, Number(baseMin) || 15);
    const n = Math.max(0, Math.floor(Number(failCount) || 0));
    return Math.min(BACKOFF_CAP_MIN, base * Math.pow(2, n)) * MS_MIN;
  }

  /**
   * 抓到一次值之后的判定。value=null 表示提取失败。
   * 返回 {item, action}：action ∈ baseline | alert | quiet | fail。
   * 不在这里发气泡——只算出"该不该说"与"新状态"，发送是宿主桥的事。
   */
  function observe(item, value, nowMs, baseMin) {
    const next = { ...item, history: item.history.slice() };
    if (value === null) {
      const failCount = (item.failCount || 0) + 1;
      next.failCount = failCount;
      next.lastError = value === null ? '提取失败' : '';
      next.nextAt = nowMs + backoffMs(baseMin, failCount);
      return { item: next, action: 'fail' };
    }
    next.lastError = '';
    next.failCount = 0;
    next.lastAt = nowMs;
    next.nextAt = nowMs + backoffMs(baseMin, 0);
    if (item.lastValue === null) {
      next.lastValue = value;
      return { item: next, action: 'baseline' };
    }
    if (item.lastValue === value) {
      return { item: next, action: 'quiet' };
    }
    next.history.push({ at: nowMs, value });
    if (next.history.length > 20) next.history = next.history.slice(-20);
    next.lastValue = value;
    return { item: next, action: 'alert' };
  }

  /** 新监控项：id 用时刻+随机尾巴（删了重建同 URL 也不共状态）。 */
  function newItem(form, nowMs) {
    return {
      id: 'w' + nowMs.toString(36) + Math.random().toString(36).slice(2, 6),
      name: String(form.name || '').slice(0, 60) || '(未命名)',
      url: String(form.url || ''),
      selector: String(form.selector || ''),
      regex: String(form.regex || ''),
      lastValue: null,
      lastAt: 0,
      failCount: 0,
      // 新项立即抓（nextAt=0）：基线越早立越好。
      nextAt: 0,
      lastError: '',
      history: [],
    };
  }

  const SIZE_LIMIT = 1024 * 1024;
  function serialize(items) { return JSON.stringify(items); }
  function fits(items) { return serialize(items).length <= SIZE_LIMIT; }

  window.PriceCore = Object.freeze({
    MS_MIN,
    BACKOFF_CAP_MIN,
    parseItems,
    extractWithRegex,
    extractWithSelector,
    extract,
    backoffMs,
    observe,
    newItem,
    serialize,
    fits,
  });
})();
