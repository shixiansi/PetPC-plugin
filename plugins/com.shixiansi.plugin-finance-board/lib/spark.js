// lib/spark.js —— 把一个数字数组画成一条 SVG sparkline
//
// 为什么手写 SVG 而不是图表库：这个插件声明了浮层面（300×150 的卡片），帧里每一像素都在被矩形
// 裁剪的窗口里；图表库意味着一个包、一套自己的主题与阴影，而这里要的只是一条线。
//
// **不抽稀**：图上几个点就是数据几个点。抽稀会让"最近 30 个点"在某些宽度下变成 12 个，而用户
// 无从得知；把点数压到 5–120 是设置项的事（config.points），不是画图的事。
'use strict';

function sparkValues(values) {
  const out = [];
  if (!Array.isArray(values)) return out;
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
/**
 * 数据 → polyline 的 `points` 属性（"x,y x,y …"）。
 *
 * y 轴是翻的（SVG 的 y 向下、价格向上），所以价高者在上面。全平的一段画在竖直中间：画在顶上或
 * 底下都会读成"涨到头了 / 跌到底了"。
 */
function sparkPoints(values, width, height, pad) {
  const list = sparkValues(values);
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  const inset = Math.max(0, Number(pad) || 0);
  if (!list.length) return { attr: '', count: 0, min: null, max: null };

  let min = list[0];
  let max = list[0];
  for (const value of list) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const span = max - min;
  const innerH = Math.max(1, h - inset * 2);
  const step = list.length > 1 ? Math.max(1, w - inset * 2) / (list.length - 1) : 0;
  const coords = [];
  for (let i = 0; i < list.length; i += 1) {
    const x = list.length > 1 ? inset + step * i : w / 2;
    const y = span === 0 ? inset + innerH / 2 : inset + innerH - ((list[i] - min) / span) * innerH;
    coords.push(round1(x) + ',' + round1(y));
  }
  return { attr: coords.join(' '), count: list.length, min, max };
}

/**
 * 一条完整的 sparkline。`class` 由调用者给（卡片与插件页尺寸不同）；颜色走 `currentColor`，所以
 * SVG 里不出现任何色值——这个插件的配色只有 style.css 顶部那两个调色板块有。
 */
function sparkSvg(values, width, height, className) {
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  const head = `<svg class="${escapeHtml(className || 'spark')}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">`;
  const geometry = sparkPoints(values, w, h, 2);
  // 没有数据：画一条基线，而不是一个空盒子——空盒子看起来像"线刚好是平的"。
  if (!geometry.count) {
    return `${head}<line x1="2" y1="${round1(h - 2)}" x2="${round1(w - 2)}" y2="${round1(h - 2)}" stroke="currentColor" stroke-width="1" stroke-dasharray="2 3" opacity="0.5" /></svg>`;
  }
  return `${head}<polyline points="${geometry.attr}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>`;
}
