// lib/charts.js —— 纯 SVG 图表（环形图 + 折线图，无依赖、无 canvas）
//
// 颜色全部来自 token（ui.css 的 CSS 变量在 SVG 里同样可用：fill="var(--accent)"）。
// 几何是纯数学：donut 用 stroke-dasharray 的圆弧段；trend 用 polyline + 坐标缩放。

'use strict';

/** 分类 → 颜色（token 变量名）。10 类够用；超出循环使用。 */
const CHART_COLORS = [
  'var(--accent)', 'var(--success)', 'var(--warning)', 'var(--info)', 'var(--danger)',
  'var(--accent-strong)', 'var(--text-dim)', 'var(--accent-dim)', 'var(--text-faint)', 'var(--line-strong)',
];

function chartColorFor(index) {
  return CHART_COLORS[index % CHART_COLORS.length];
}

/**
 * 环形图：每类一段圆弧（stroke-dasharray），中心放总额。
 * @param {Array<{category, total, share}>} byCategory
 * @param {number} grandTotal 支出总额
 * @returns {string} SVG innerHTML
 */
function chartDonut(byCategory, grandTotal) {
  const CX = 110;
  const CY = 110;
  const R = 78;
  const SW = 30;
  const C = 2 * Math.PI * R;
  const parts = [];
  // 底环。
  parts.push(`<circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="var(--bg-sunken)" stroke-width="${SW}" />`);
  let offset = 0;
  byCategory.forEach((seg, i) => {
    const frac = Math.max(0, Math.min(1, seg.share));
    if (frac <= 0) return;
    const len = frac * C;
    // 圆弧段：dasharray = 段长 空隙；旋转到当前偏移。
    const angle = (offset / C) * 360 - 90;
    parts.push(
      `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${chartColorFor(i)}" stroke-width="${SW}"`
      + ` stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}"`
      + ` stroke-dashoffset="${(-offset).toFixed(2)}"`
      + ` transform="rotate(${angle.toFixed(2)} ${CX} ${CY})" />`,
    );
    offset += len;
  });
  // 中心文字：总额。
  parts.push(`<text x="${CX}" y="${CY - 4}" text-anchor="middle" class="donut-total">${grandTotal >= 10000 ? `${(grandTotal / 10000).toFixed(1)}万` : grandTotal.toFixed(0)}</text>`);
  parts.push(`<text x="${CX}" y="${CY + 18}" text-anchor="middle" class="donut-sub">月支出</text>`);
  return parts.join('');
}

/** 环形图的图例。 */
function chartLegend(byCategory) {
  return byCategory.map((seg, i) => (
    `<span class="legend-item"><span class="legend-dot" style="background:${chartColorFor(i)}"></span>`
    + `${seg.category} ${Math.round(seg.share * 100)}%</span>`
  )).join('');
}

/**
 * 折线图：每日支出趋势。
 * @param {Array<{day, total}>} byDay 当月逐日
 * @returns {string} SVG innerHTML
 */
function chartTrend(byDay) {
  const W = 420;
  const H = 220;
  const PAD_L = 34;
  const PAD_R = 12;
  const PAD_T = 14;
  const PAD_B = 26;
  const max = Math.max(1, ...byDay.map((d) => d.total));
  const iw = W - PAD_L - PAD_R;
  const ih = H - PAD_T - PAD_B;
  const x = (i) => PAD_L + (byDay.length <= 1 ? iw / 2 : (i / (byDay.length - 1)) * iw);
  const y = (v) => PAD_T + ih - (v / max) * ih;
  const parts = [];
  // 网格：3 条横线 + 刻度。
  for (const frac of [0, 0.5, 1]) {
    const gy = PAD_T + ih - frac * ih;
    parts.push(`<line x1="${PAD_L}" y1="${gy}" x2="${W - PAD_R}" y2="${gy}" class="grid-line" />`);
    parts.push(`<text x="${PAD_L - 6}" y="${gy + 4}" text-anchor="end" class="axis-text">${Math.round(max * frac)}</text>`);
  }
  // X 轴标签：每 5 天一个。
  byDay.forEach((d, i) => {
    const day = Number(d.day.slice(-2));
    if (day % 5 === 0 || day === 1) {
      parts.push(`<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="axis-text">${day}</text>`);
    }
  });
  // 面积 + 折线。
  const pts = byDay.map((d, i) => `${x(i).toFixed(1)},${y(d.total).toFixed(1)}`);
  if (pts.length) {
    parts.push(`<polygon class="trend-area" points="${PAD_L},${y(0).toFixed(1)} ${pts.join(' ')} ${x(byDay.length - 1).toFixed(1)},${y(0).toFixed(1)}" />`);
    parts.push(`<polyline class="trend-line" points="${pts.join(' ')}" />`);
  }
  // 峰值点标注。
  const peakIdx = byDay.reduce((best, d, i) => (d.total > (byDay[best] ? byDay[best].total : 0) ? i : best), 0);
  if (byDay[peakIdx] && byDay[peakIdx].total > 0) {
    parts.push(`<circle cx="${x(peakIdx).toFixed(1)}" cy="${y(byDay[peakIdx].total).toFixed(1)}" r="3.5" class="trend-peak" />`);
    parts.push(`<text x="${x(peakIdx).toFixed(1)}" y="${(y(byDay[peakIdx].total) - 8).toFixed(1)}" text-anchor="middle" class="axis-text">${byDay[peakIdx].total.toFixed(0)}</text>`);
  }
  return parts.join('');
}

const ExpenseCharts = { CHART_COLORS, chartColorFor, chartDonut, chartLegend, chartTrend };
