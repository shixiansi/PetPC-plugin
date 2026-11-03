// lib/workshop.js —— 控制中心的插件页（只读的一屏）
//
// 控制中心**没有宠物**：bubble.say / pet.badge / surface.* / events.subscribe 都不被服务
// （手册 §9）。所以这一面没有"立刻提醒一次"这种按钮——那会是一个点了没反应的控件。
// 它做的是用户打开这一页真正想要的事：看清三条提醒下一次是什么时候、今天说了几次、
// 免打扰那一段到底被认成了几点，以及**这个插件做不到什么**（全屏检测、没授权时会怎样）。

'use strict';

function paintWorkshop() {
  const config = configOf();
  const now = Date.now();
  const paused = pausedAt(now);
  const plan = step(state, config, now, paused);

  const running = config.items.some((item) => item.on);

  for (const item of config.items) {
    const row = els.wsRows[item.key];
    if (!row) continue;
    const where = row.querySelector('.ws-next');
    const count = row.querySelector('.ws-count');
    if (!item.on) {
      row.dataset.off = '1';
      textOf(where, '已关掉（到点不会有任何提醒）');
      textOf(count, '');
      continue;
    }
    row.dataset.off = '0';
    const every = '每 ' + item.minutes + ' 分钟';
    if (paused) textOf(where, every + ' · 今天已暂停');
    else if (plan.quiet) textOf(where, every + ' · 免打扰中，还有 ' + minutesOf(plan.remaining[item.key]) + ' 分');
    else textOf(where, every + ' · 还有 ' + minutesOf(plan.remaining[item.key]) + ' 分');
    const times = Number(state.counts && state.counts[item.key]) || 0;
    textOf(count, times > 0 ? '今天已提醒 ' + times + ' 次' : '今天还没提醒过');
  }

  if (els.wsState) {
    let label = '运行中';
    if (!running) label = '三条都关掉了';
    else if (paused) label = '今天已暂停';
    else if (plan.quiet) label = '免打扰中';
    textOf(els.wsState, label);
  }

  // 写"**实际生效**的那一段"而不是用户填的那两串：`8：00`（全角冒号）这种填法会被认，
  // 而认不出来的会安静地回兜底值——两种情况下用户都该看到真正起作用的时间。
  textOf(
    els.wsQuiet,
    '免打扰 ' + mmhh(config.quiet.start) + ' – ' + mmhh(config.quiet.end) +
      '（' + (config.quiet.start === config.quiet.end ? '起止相同 = 不设免打扰' : '跨午夜也算对') +
      '；这段里到点的提醒直接跳过，不会在结束时补发）',
  );

  const fired = config.items
    .filter((item) => (Number(state.counts && state.counts[item.key]) || 0) > 0)
    .map((item) => item.label + ' ' + (Number(state.counts[item.key]) || 0) + ' 次');
  // 日界写的是同一个常量（schedule.js 的 DAY_ROLL_HOUR）：改了那一处，这句话跟着改。
  const roll = '过了本机 ' + pad2(DAY_ROLL_HOUR) + ':00 算新的一天';
  textOf(
    els.wsCounts,
    fired.length
      ? '今天：' + fired.join(' · ') + '（' + roll + '，次数从这里清零）'
      : '今天还没有提醒过（' + roll + '）。',
  );

  if (els.wsNoteSub) textOf(els.wsNoteSub, subscriptionNote());
}

/**
 * 这一面的"缺什么 / 靠什么"要说出口，而且**说的必须是这一面的事实**。
 *
 * 三条都是读过宿主代码、而不是猜的：
 *
 *   - **宿主只在 granted 里有 events（或 net.ws / net.fetch / plugin.call）时才挂常驻帧**
 *     （`frontend/src/main.js` 的 `backgroundPlugins`，与 Go 侧 manifest 校验同一条规则）。
 *     没授予 events 就没有常驻帧，于是提醒只在桌宠旁边那块卡片开着的时候才跑。
 *   - **控制中心不服务 `events.subscribe`**（手册 §9），但它**不用订阅也收得到**
 *     `config.changed`：那条事件由宿主直达变化所属的插件。所以在这一页改设置是立刻生效的。
 *   - `events.subscribe` 在桌宠那一侧被拒时，提醒**照常**（它靠的是钟，不是事件），
 *     只是"设置改动"要等桌宠那一侧的下一拍（≤30 秒）——那一侧会自己重读设置。
 */
function subscriptionNote() {
  if (!can('events')) {
    return '没有授予 events：宿主不会为我挂常驻帧，提醒只在这块卡片（或桌宠那边）开着时生效。' +
      '想要「关掉界面也在提醒」，请在插件授权里补上 events。';
  }
  if (!can('storage')) {
    return '没有授予 storage：记不住"上一次说是什么时候"，提醒会变成每次开机都说一句。';
  }
  if (view === 'workshop') {
    return '这一页改设置会立刻反映到上面的数字（宿主把 config.changed 直接推给我，控制中心不需要订阅）。';
  }
  if (!subscribed) {
    return 'events.subscribe 被拒绝：这一侧会在每一拍（≤30 秒）自己重读一次设置——' +
      '提醒本身不受影响，它靠的是钟表，不是事件。';
  }
  return '设置改动会立刻生效（订阅了 config.changed）。';
}
