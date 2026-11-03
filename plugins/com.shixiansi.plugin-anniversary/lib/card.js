// lib/card.js —— 桌宠旁边那块 280×132 的紧凑卡片（浮层面 0 号块）
//
// 卡片是**固定矩形**：装不下的内容不会报错，只会被裁掉（手册 §8.2b）。所以这里守两条：
//   1. 同一时刻只有一组可见：#sf-rows 或 #sf-empty。每行高度写死，名称超了用省略号，没有任何
//      flex:1 的"会自己长大"的容器去和别的块抢空间。
//   2. 高度真装不下时才报给宿主（surface.blocks + manifest 的 maxH）；量不到（jsdom 没有排版
//      引擎）就不发，免得用一个荒唐的小数字把卡片压扁。
//
// 卡片只在"今天是某个纪念日"那天由常驻帧摊开一次（见 app.js 的 scheduleCard）：那个位置同一时刻
// 只能放一样东西（气泡或浮层面），所以先把话说出来，一分钟后再把卡片摆上。

'use strict';

// manifest 里声明的高度。内容装得下就不去打扰宿主。
const SURFACE_DECLARED_H = 132;
let cardLastFit = 0;
let cardBound = false;

function bindCard() {
  if (cardBound) return;
  cardBound = true;
  if (!els.sfClose) return;
  els.sfClose.addEventListener('click', () => {
    // 只关自己这块浮层面。徽标不归这一面管，它继续挂着。
    if (serves('surface.hide')) request('surface.hide', {}).catch(() => {});
  });
}

function paintCard() {
  bindCard();
  const agenda = state.agenda || Agenda.build([], Dates.todayISO(new Date()));
  const rows = Agenda.top(agenda, 3);

  textOf(els.sfCount, agenda.total > rows.length ? '共 ' + agenda.total + ' 条' : '');
  show(els.sfRows, rows.length > 0);
  show(els.sfEmpty, rows.length === 0);
  if (rows.length === 0) {
    textOf(
      els.sfEmpty,
      !can('storage')
        ? '未获授权：storage（清单存在插件自己的私有目录里）。'
        : state.error
          ? '读不到清单：' + state.error
          : '还没有纪念日：在控制中心的「纪念日倒计时」页里加一条。',
    );
  }

  if (!els.sfRows) return;
  els.sfRows.textContent = '';
  for (const row of rows) {
    const li = document.createElement('li');
    li.className = 'sf-row' + (row.days === 0 ? ' sf-row-today' : '');
    const name = document.createElement('span');
    name.className = 'sf-name';
    name.textContent = row.name;
    const when = document.createElement('span');
    when.className = 'sf-when';
    when.textContent = Agenda.relativeText(row.days);
    li.appendChild(name);
    li.appendChild(when);
    els.sfRows.appendChild(li);
  }

  fitCard();
}

/** 内容真的装不下时才请求长高。jsdom 里 scrollHeight 恒为 0，`want < 40` 这一条在测试环境里直接
 *  返回——那不是掩盖问题，而是"没有排版引擎就没有可报的高度"。 */
function fitCard() {
  if (!can('pet.surface') || !serves('surface.blocks') || !els.surfaceCard) return;
  const want = Math.ceil((els.surfaceCard.scrollHeight || 0) + 2);
  if (!Number.isFinite(want) || want < 40 || want <= SURFACE_DECLARED_H) return;
  if (want === cardLastFit) return;
  cardLastFit = want;
  request('surface.blocks', { sizes: { [String(mountInfo.rectIndex)]: want } }).catch(() => {});
}
