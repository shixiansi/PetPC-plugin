'use strict';

// 条形图：手搓 SVG。
//
// 为什么不用图表库：插件包不许引第三方库、也不许引 CDN（手册 §2），而这张图要画的东西只有
// 一件事——每个分组合一根横条。拿一个 300 KB 的库换 40 行 createElementNS 不划算，也换不来
// "这一根条对应哪个分组"这种能被测试逐条断言的性质。
//
// 几何：viewBox 固定宽 520，高度随组数长。横向条形而不是竖向柱子，因为分组的名字常常是中文
// 短语（"北京"、"线上"），竖着放会把名字压成一条竖线。

const SVG_NS = 'http://www.w3.org/2000/svg';

const CHART_WIDTH = 520;
const CHART_ROW = 22;
const CHART_LABEL_W = 112;
const CHART_VALUE_W = 44;

function svgText(x, y, anchor, value, className) {
  const node = document.createElementNS(SVG_NS, 'text');
  node.setAttribute('x', String(x));
  node.setAttribute('y', String(y));
  node.setAttribute('text-anchor', anchor);
  node.setAttribute('class', className || 'bar-label');
  node.textContent = String(value);
  return node;
}

/**
 * 造一个 <svg>：每组一根 <rect>（外加两条 <text>，一根条一个分组，一一对应）。
 *
 * maxBars：超过就只画前几组，并在底部写一行"另有 N 组"——那一行是文字，不是条。条数必须
 * 与"画出来的分组"严格相等，否则图与列表对不上，而那种不一致没人会去数。
 */
function buildBarChart(pairs, options) {
  const wanted = Number(options && options.maxBars);
  const maxBars = Number.isFinite(wanted) && wanted > 0 ? Math.floor(wanted) : 10;
  const bars = (Array.isArray(pairs) ? pairs : []).slice(0, maxBars);
  const more = (Array.isArray(pairs) ? pairs.length : 0) - bars.length;
  const height = Math.max(28, bars.length * CHART_ROW + (more > 0 ? CHART_ROW : 0) + 8);

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'chart');
  svg.setAttribute('viewBox', '0 0 ' + CHART_WIDTH + ' ' + height);
  svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '分组行数条形图');

  const max = bars.length ? bars[0].count : 0;
  const barMax = CHART_WIDTH - CHART_LABEL_W - CHART_VALUE_W;

  bars.forEach((bar, i) => {
    const top = 4 + i * CHART_ROW;
    const name = String(bar.value);
    const shown = name.length > 9 ? name.slice(0, 8) + '…' : name;
    svg.appendChild(svgText(CHART_LABEL_W - 8, top + 13, 'end', shown));

    const width = max > 0 ? Math.max(2, Math.round((bar.count / max) * barMax)) : 2;
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(CHART_LABEL_W));
    rect.setAttribute('y', String(top + 1));
    rect.setAttribute('width', String(width));
    rect.setAttribute('height', '14');
    rect.setAttribute('rx', '4');
    rect.setAttribute('class', 'bar');
    rect.setAttribute('data-value', name);
    rect.setAttribute('data-count', String(bar.count));
    svg.appendChild(rect);

    svg.appendChild(svgText(CHART_LABEL_W + width + 6, top + 13, 'start', String(bar.count), 'bar-value'));
  });

  if (more > 0) {
    svg.appendChild(svgText(CHART_LABEL_W - 8, bars.length * CHART_ROW + 18, 'end', '另有 ' + more + ' 组', 'bar-more'));
  }
  return svg;
}
