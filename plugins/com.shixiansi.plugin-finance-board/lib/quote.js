// lib/quote.js —— 行情解析的纯函数层：两种源形状的解析器 + sparkline 坐标生成。
//
// 这里不碰宿主、不碰 DOM、不发网络。测试接缝：panel.html 引入即 window.QuoteCore。
//
// 两个源（内置，apiBase 可切换）：
//   · 腾讯 qt.gtimg.cn：v_sh000001="1~上证指数~000001~3261.56~…"；字段用 ~ 分隔，
//     [1]名称 [2]代码 [3]现价 [4]昨收 [5]今开 [31]涨跌 [32]涨跌%。
//   · 新浪 hq.sinajs.cn：var hq_str_sh000001="上证指数,3261.56,3245.22,…";
//     CSV：[0]名称 [1]今开 [2]昨收 [3]现价 [4]最高 [5]最低 … [8]涨跌额 [9]涨跌%。
//
// 解析器铁律：垃圾进垃圾出不抛错——认不出就返回 null（调用方标"无数据"，绝不编数字）。
// "休市不刷"由调用方比较快照哈希：解析结果与上次一致 → 不写不画。
'use strict';

(function () {
  function num(s) {
    const v = Number(String(s == null ? '' : s).replace(/,/g, ''));
    return Number.isFinite(v) ? v : null;
  }

  /**
   * 腾讯形状。返回 {code, name, price, prevClose, change, changePct} 或 null。
   * 响应可能是 GBK 的（浏览器 fetch 已按 utf-8 解——乱码字段当 null，不抛错）。
   */
  function parseTencent(text) {
    const m = /v_[a-z]+(\w+)="([^"]*)"/.exec(String(text || ''));
    if (!m) return null;
    const parts = m[2].split('~');
    if (parts.length < 32) return null;
    const price = num(parts[3]);
    if (price === null) return null;
    return {
      code: String(parts[2] || m[1] || ''),
      name: String(parts[1] || '').slice(0, 24),
      price,
      prevClose: num(parts[4]),
      change: num(parts[31]),
      changePct: num(parts[32]),
    };
  }

  /** 新浪形状。返回同上或 null。 */
  function parseSina(text) {
    const m = /hq_str_(\w+)="([^"]*)"/.exec(String(text || ''));
    if (!m) return null;
    const parts = m[2].split(',');
    if (parts.length < 10) return null;
    const price = num(parts[3]);
    if (price === null) return null;
    const prevClose = num(parts[2]);
    const change = num(parts[8]);
    const changePct = num(parts[9]);
    return {
      code: String(m[1] || ''),
      name: String(parts[0] || '').slice(0, 24),
      price,
      prevClose,
      change,
      changePct,
    };
  }

  /** 按 apiBase 选解析器。认不出的 base 返回 null（调用方标配置错误）。 */
  function parserFor(apiBase) {
    const s = String(apiBase || '');
    if (/gtimg\.cn/.test(s)) return parseTencent;
    if (/sinajs\.cn/.test(s)) return parseSina;
    return null;
  }

  /**
   * sparkline：values → SVG path 的 d 属性（polyline）。
   * w×h 是画布尺寸（留 1px 内边），空/单点返回 ''（画不出线就画不出，不硬编一个假点）。
   * y 轴：min 在下 max 在上；全同值时线画在正中。
   */
  function sparkline(values, w, h) {
    const list = (values || []).map(num).filter((v) => v !== null);
    if (list.length < 2) return '';
    const width = Math.max(10, Number(w) || 100);
    const height = Math.max(10, Number(h) || 30);
    const min = Math.min(...list);
    const max = Math.max(...list);
    const span = max - min;
    const pad = 1;
    const points = list.map((v, i) => {
      const x = pad + (i * (width - pad * 2)) / (list.length - 1);
      const y = span === 0
        ? height / 2
        : pad + (1 - (v - min) / span) * (height - pad * 2);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    });
    return `M${points.join(' L')}`;
  }

  /** 快照哈希：同一秒抓两次，值串一致 → 休市/无新数据（调用方决定不写不画）。 */
  function snapshotHash(quotes) {
    return JSON.stringify((quotes || []).map((q) => [q.code, q.price, q.changePct]));
  }

  /** 解析一组代码请求的响应（一个源一次返回多行）。返回 {ok, quotes} 或 {ok:false}。 */
  function parseResponse(apiBase, text) {
    const parse = parserFor(apiBase);
    if (!parse) return { ok: false, reason: `认不出这个行情源：${apiBase}（内置：腾讯 qt.gtimg.cn / 新浪 hq.sinajs.cn）` };
    const body = String(text || '');
    const re = /v_[a-z]+\w+="[^"]*"|hq_str_\w+="[^"]*"/g;
    const chunks = body.match(re) || [];
    const quotes = [];
    for (const chunk of chunks) {
      const q = parse(chunk);
      if (q) quotes.push(q);
    }
    return { ok: true, quotes };
  }

  window.QuoteCore = Object.freeze({
    parseTencent,
    parseSina,
    parserFor,
    parseResponse,
    sparkline,
    snapshotHash,
  });
})();
