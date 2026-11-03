// lib/workshop.js —— 控制中心的整页：完整列表 + 周期 + 行情源
//
// 这个窗口没有宠物：bubble.say / surface.* / pet.badge / events.subscribe 都不被服务，所以
// "在桌宠旁边显示"这类控件根本不画，只用一行说明它在哪（发出去必被拒，还会在宿主日志里留一行
// WARN）。只读的部分——列表、现价、涨跌、sparkline——照常显示。
//
// 开关都落到**同一份配置**上（config.set）：默认行情源、标的列表；周期落在 storage 的
// market/view 里（它是浏览偏好，不是设置）。改完立刻重取一次，用户马上看到结果。
'use strict';

const WS_SPARK_W = 160;
const WS_SPARK_H = 36;
let workshopBound = false;
function workshopRowHtml(row) {
  // 那一列是**说明**：休市（交易所没开门）或者未更新（这次取数失败，价格是上一次的）。
  const flag = row.closed || (row.stale ? '未更新' : '');
  const side = row.closed ? 'flat' : changeSide(row.change);
  return (
    '<li class="ws-row"><div class="ws-main">' +
    `<span class="ws-code">${escapeHtml(row.code)}</span>` +
    `<span class="ws-src">${escapeHtml(sourceLabel(row.source))}</span></div>` +
    `<span class="ws-price">${escapeHtml(fmtPrice(row.price))}</span>` +
    `<span class="ws-chg ${side}">${escapeHtml(fmtChange(row.change))}</span>` +
    sparkSvg(row.points, WS_SPARK_W, WS_SPARK_H, 'ws-spark') +
    `<span class="ws-flag">${escapeHtml(flag)}</span></li>`
  );
}

function paintSegments(selector, attribute, current) {
  for (const button of document.querySelectorAll(selector)) {
    const on = button.getAttribute(attribute) === current;
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

function paintWorkshop() {
  const rows = market.items;
  textOf(els.wsState, statusText());
  if (els.wsRows) els.wsRows.innerHTML = rows.map(workshopRowHtml).join('');
  show(els.wsRows, rows.length > 0);
  show(els.wsEmpty, rows.length === 0);

  // 宿主的失败原文完整显示在这里（卡片上只有一行状态，放不下）。
  if (els.wsBad) {
    textOf(els.wsBad, market.error);
    show(els.wsBad, Boolean(market.error));
  }
  paintSegments('[data-source]', 'data-source', defaultSource());
  paintSegments('[data-period]', 'data-period', periodOf().value);

  // 正在输入的框不要被重画覆盖：用户打了三个标的、还在第四个，一次后台刷新就把字擦掉是最糟的
  // 那种"我明明写了"。
  if (els.wsTargets && document.activeElement !== els.wsTargets) els.wsTargets.value = targetsText();
}

function bindWorkshop() {
  if (workshopBound) return;
  workshopBound = true;
  if (els.wsRefresh) els.wsRefresh.addEventListener('click', () => void forceRefresh());
  if (els.wsSave) els.wsSave.addEventListener('click', () => void saveTargets());
  for (const button of document.querySelectorAll('[data-source]')) {
    button.addEventListener('click', () => void switchSource(button.getAttribute('data-source')));
  }
  for (const button of document.querySelectorAll('[data-period]')) {
    button.addEventListener('click', () => void switchPeriod(button.getAttribute('data-period')));
  }
}

async function forceRefresh() {
  textOf(els.wsStatus, '刷新中…');
  try {
    await refreshMarket({ force: true });
    textOf(els.wsStatus, '已刷新 · ' + lastOkText());
  } catch (err) {
    textOf(els.wsStatus, '刷新失败：' + errorText(err));
  }
}

/**
 * 换行情源：不带前缀的标的会跟着换到另一个**域名与路径**上（用例断言的就是 net.fetch 的 url）；
 * 带前缀的标的不动——那是用户点名要的源。
 */
async function switchSource(value) {
  if (!isSourceId(value)) return;
  if (!can('plugin.config')) {
    textOf(els.wsStatus, '未获权限 plugin.config：行情源只能在宿主的设置表单里改');
    return;
  }
  cfg.source = value; // 先改内存里的那一份：界面立刻跟上，不必等 config.get 回来
  paintWorkshop();
  try {
    await request('config.set', { values: { source: value } });
  } catch (err) {
    textOf(els.wsStatus, '切换失败：' + errorText(err));
    return;
  }
  await refreshMarket({ force: true, reload: false });
  textOf(els.wsStatus, '已切到' + sourceLabel(value) + ' · ' + lastOkText());
}

async function switchPeriod(value) {
  if (!periodSpec(value)) return;
  await setPeriod(value);
  paintWorkshop();
  await refreshMarket({ force: true });
  textOf(els.wsStatus, '周期：' + periodSpec(value).label + ' · ' + lastOkText());
}

async function saveTargets() {
  if (!can('plugin.config')) {
    textOf(els.wsStatus, '未获权限 plugin.config：标的列表只能在宿主的设置表单里改');
    return;
  }
  const text = els.wsTargets ? String(els.wsTargets.value || '') : '';
  try {
    // config.set 只接受声明过的键；这里只写 targets 一个。
    await request('config.set', { values: { targets: text } });
  } catch (err) {
    textOf(els.wsStatus, '保存失败：' + errorText(err));
    return;
  }
  cfg.targets = text;
  textOf(els.wsStatus, '已保存，正在重取…');
  await refreshMarket({ force: true, reload: false });
  const count = parseTargets(text).length;
  textOf(els.wsStatus, (count ? `已保存 ${count} 个标的` : '已保存：列表是空的') + ' · ' + lastOkText());
}
