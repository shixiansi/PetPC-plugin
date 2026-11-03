// lib/views.js —— 两副看的界面：桌宠旁边的紧凑卡片 + 控制中心的整页
//
// workshop 这一面**没有宠物**：宿主不服务 bubble.say / surface.* / events.subscribe /
// plugin.call（别硬发——那会变成一行没人看的"本程序不支持该方法"，§9）。所以这里不画"提醒"
// 控件，只用 #ws-note 说明提醒在桌宠上；事件列表照常显示。
// 卡片那一面是固定矩形：装不下的内容不会报错，只会被裁掉（§8.2b）。所以同一时刻只有一组可见
// （#sf-main 或 #sf-empty），也没有任何 flex:1 的容器去和别的块抢空间。
'use strict';

const SURFACE_DECLARED_H = 132; // 与 manifest.surface[0].h 一致：装得下就不去打扰宿主
let surfaceLastFit = 0;

function paintSurface() {
  const nowMs = Date.now();
  const configured = Boolean(normalizeFeedUrl(feedConfiguredRaw()));
  const next = feedNext(nowMs);
  textOf(els.sfState, feedFreshnessLabel(nowMs));
  show(els.sfMain, Boolean(next));
  show(els.sfEmpty, !next);
  if (next) {
    const when = next.allDay ? '全天' : hm(next.start) + (next.recurring ? '（重复）' : '');
    textOf(els.sfTime, when + (next.location ? ' · ' + next.location : ''));
    textOf(els.sfWhat, next.title);
    const later = feedToday(nowMs).filter((event) => event.start > next.start).length;
    textOf(els.sfFoot, later > 0 ? '今天还有 ' + later + ' 场' : '今天没有别的了');
  } else {
    textOf(els.sfEmpty, configured ? '接下来几天没有日程。' : '先在设置里填日历地址。');
    textOf(els.sfFoot, '');
  }
  fitSurfaceCard();
}

/**
 * 内容真的装不下时才请求长高（manifest 声明了 maxH，宿主才会应用 sizes）。
 * jsdom 里 scrollHeight 恒为 0，所以量不到就直接返回——报一个荒唐的小数字只会把卡片压扁。
 */
function fitSurfaceCard() {
  if (!can('pet.surface') || !serves('surface.blocks') || !els.surface) return;
  const want = Math.ceil(els.surface.scrollHeight + 2);
  if (!Number.isFinite(want) || want < 40 || want <= SURFACE_DECLARED_H) return;
  if (want === surfaceLastFit) return;
  surfaceLastFit = want;
  request('surface.blocks', { sizes: { [String(mountInfo.rectIndex || 0)]: want } }).catch(() => {});
}

let workshopBound = false;
let workshopStatus = '';
let workshopBusy = false;

function bindWorkshop() {
  if (workshopBound) return;
  workshopBound = true;
  if (els.wsRefresh) els.wsRefresh.addEventListener('click', () => void workshopRefresh());
  if (els.wsSave) els.wsSave.addEventListener('click', () => void workshopSave());
  if (!els.wsUrl) return;
  els.wsUrl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void workshopSave();
  });
}

async function workshopSave() {
  if (!can('plugin.config') || !els.wsUrl) return;
  const value = String(els.wsUrl.value || '').trim();
  workshopStatus = '正在保存…';
  paint();
  try {
    await request('config.set', { values: { calendarUrl: value } });
  } catch (err) {
    workshopStatus = '保存失败：' + errorText(err);
    paint();
    return;
  }
  await refreshConfig();
  if (els.wsSettings) els.wsSettings.open = false;
  await workshopRefresh();
}

async function workshopRefresh() {
  if (workshopBusy) return;
  if (!can('net.fetch')) {
    workshopStatus = '未获授权：net.fetch（拉不了日历，只能看缓存）';
    paint();
    return;
  }
  if (!normalizeFeedUrl(feedConfiguredRaw())) {
    workshopStatus = '';
    paint();
    return;
  }
  workshopBusy = true;
  workshopStatus = '正在刷新…';
  paint();
  const result = await feedRefresh();
  workshopBusy = false;
  workshopStatus = result.ok
    ? '刚更新：' + feedState.eventCount + ' 条日程' + (result.truncated ? '（响应被宿主截断，可能不全）' : '')
    : '刷新失败：' + (result.error || (result.reason === 'bad-url' ? '地址不是 http(s) 链接' : '未知原因'));
  paint();
}

function paintWorkshop() {
  bindWorkshop();
  const nowMs = Date.now();
  const raw = feedConfiguredRaw();
  const url = normalizeFeedUrl(raw);
  textOf(els.wsState, workshopStatus);
  textOf(els.wsCache, '数据：' + feedFreshnessLabel(nowMs) + (feedState.cacheNote ? '　·　' + feedState.cacheNote : ''));
  if (els.wsRefresh) els.wsRefresh.disabled = !can('net.fetch');
  if (els.wsSave) els.wsSave.disabled = !can('plugin.config');
  if (els.wsUrl && els.wsSettings && !els.wsSettings.open) els.wsUrl.value = raw;
  show(els.wsNeedUrl, !url);
  show(els.wsDays, Boolean(url));
  if (!url) {
    textOf(els.wsNeedText, raw ? '这个地址不像 http(s) 链接：' + raw : '先去设置里填日历地址');
    if (els.wsDays) els.wsDays.textContent = '';
    show(els.wsEmpty, false);
    return;
  }
  paintWorkshopDays(nowMs);
}

function paintWorkshopDays(nowMs) {
  const dayStart = localMidnight(nowMs);
  const list = feedOccurrences(dayStart, dayStart + 7 * ICS_DAY_MS, 200);
  const next = feedNext(nowMs);
  const nextUid = next ? next.uid : '';
  if (!els.wsDays) return;
  els.wsDays.textContent = '';
  let currentKey = '';
  let listNode = null;
  for (const event of list) {
    if (dayKey(event.start) !== currentKey) {
      currentKey = dayKey(event.start);
      const day = document.createElement('section');
      day.className = 'day';
      day.appendChild(spanOf('day-head', dayLabel(event.start, nowMs), 'h2'));
      listNode = document.createElement('ul');
      listNode.className = 'evs';
      day.appendChild(listNode);
      els.wsDays.appendChild(day);
    }
    if (listNode) listNode.appendChild(workshopRow(event, nextUid));
  }
  show(els.wsEmpty, list.length === 0);
}

function spanOf(className, text, tag) {
  const node = document.createElement(tag || 'span');
  node.className = className;
  node.textContent = text;
  return node;
}

function workshopRow(event, nextUid) {
  const row = document.createElement('li');
  row.className = 'ev' + (event.uid === nextUid ? ' special' : ''); // 下一场高亮
  row.appendChild(spanOf('ev-time', event.allDay ? '全天' : hm(event.start) + '–' + hm(event.end)));
  row.appendChild(spanOf('ev-title', event.title));
  if (event.location) row.appendChild(spanOf('ev-where', event.location));
  return row;
}
