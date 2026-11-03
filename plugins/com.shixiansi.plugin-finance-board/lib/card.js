// lib/card.js —— 宠物旁边那块 300×150 的卡片
//
// 高度是**声明死**的（manifest.surface），装不下的部分会被原生区域裁掉而且不报错，所以预算是算
// 出来的：132 可用（150 − 内边距 16 − 边框 2）= 头 16 + 间距 8 + 三行×28 + 间距 8 + 脚注 16。
// 因此**最多三行**（更多的在插件页看，脚注说"还有 N 个"），行高写死，没有任何 flex: 1 让两块
// 互相抢空间——那正是"按钮被切掉一半"的来源（手册 §8.2b）。
'use strict';

const CARD_ROWS = 3;
const CARD_SPARK_W = 84;
const CARD_SPARK_H = 20;
function cardRowHtml(row) {
  // 休市那一行写「休市」而不是「+0.00%」：价格没动不是"涨跌为零"，是"今天没有成交"。
  const change = row.closed ? CLOSED_TEXT : fmtChange(row.change);
  const side = row.closed ? 'flat' : changeSide(row.change);
  return (
    `<li class="sf-row"><span class="sf-code">${escapeHtml(row.code)}</span>` +
    `<span class="sf-price">${escapeHtml(fmtPrice(row.price))}</span>` +
    `<span class="sf-chg ${side}">${escapeHtml(change)}</span>` +
    sparkSvg(row.points, CARD_SPARK_W, CARD_SPARK_H, 'sf-spark') +
    '</li>'
  );
}

function paintCard() {
  const rows = market.items.slice(0, CARD_ROWS);
  textOf(els.sfSrc, sourceLabel(market.source || defaultSource()));
  if (els.sfRows) els.sfRows.innerHTML = rows.map(cardRowHtml).join('');

  let foot = '还没有标的：在控制中心的插件页里填几个';
  if (rows.length) {
    const extra = market.items.length > CARD_ROWS ? ' · 还有 ' + (market.items.length - CARD_ROWS) + ' 个' : '';
    foot = statusText() + extra;
  }
  textOf(els.sfFoot, foot);
  // 失败原因可能很长（宿主那句中文）：卡片只放得下一行状态，原文挂在 title 上，完整的那一份在
  // 插件页的 #ws-bad 里。
  if (els.sfFoot) els.sfFoot.title = market.error || '';
}

/** 卡片上唯一一个控件：收起。桌宠那边服务 surface.hide，其它宿主不服务就不发。 */
function bindCard() {
  if (!els.sfClose) return;
  els.sfClose.addEventListener('click', () => {
    if (!serves('surface.hide')) return;
    // 收不起来（浮层面已经不在了、授权被撤）什么都不用做：用户会再点一次。
    request('surface.hide', {}).catch(() => {});
  });
}
