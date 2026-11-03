// lib/surface.js —— 桌宠旁边那块 280×112 的卡片
//
// 固定矩形，装不下的部分会被宿主裁掉而不是报错（手册 §8.2b），所以这里每一行都是固定高度、
// **没有一处 flex: 1**：两个"会自己长大"的块互相抢空间的代价，是按钮被矩形下边缘切掉一半。
//
// 这一面**只说显示，不说不该由它说的话**：它不做提醒判定、不写 state/v1（谁跑钟谁写，见
// app.js 的 isTicker）。它读同一份状态，于是三行数字和头顶徽标永远是同一份答案。

'use strict';

/** 三行：`久坐 · 还有 44 分`。关掉的那一条写"已关"，不给一个看起来还在倒计时的数字。 */
function paintSurface() {
  const config = configOf();
  const now = Date.now();
  const paused = pausedAt(now);
  // 纯函数，不落盘：paint 只在内存里算一份看看，state 不被它改动。
  const plan = step(state, config, now, paused);

  for (const item of config.items) {
    const row = els.rows[item.key];
    if (!row) continue;
    const next = row.querySelector('.row-next');
    if (!item.on) {
      row.dataset.off = '1';
      textOf(next, '已关');
      continue;
    }
    row.dataset.off = '0';
    if (paused) textOf(next, '今天停');
    else if (plan.quiet) textOf(next, '免打扰');
    else textOf(next, '还有 ' + minutesOf(plan.remaining[item.key]) + ' 分');
  }

  if (els.pause) {
    els.pause.disabled = paused || !can('storage');
    textOf(els.pause, paused ? '今天先不提醒' : '今天先别提醒我');
  }
}

/** 「今天先别提醒我」：写的是**日期**，所以明天自动作废，不需要谁去清它。 */
async function onPauseToday() {
  const now = Date.now();
  const day = dayKey(now);
  if (!can('storage')) {
    // 没有 storage 就没有"今天"这个记忆，只能当场停一拍——说清楚，别装作记住了。
    say('没有授予 storage：这一条停不下来（关掉开关请到设置里改）');
    return;
  }
  const ok = await writePause(day);
  if (!ok) {
    say('写不下「今天先别提醒我」：宿主的存储拒绝了这次写入');
    return;
  }
  paint();
  // 这个窗口自己就是钟的时候（没授予 events，见 app.js 的 isTicker），立刻按"暂停"重算一拍；
  // 否则钟在常驻帧里，它会从 storage.changed 知道这件事。
  if (isTicker()) await tick(now);
}
