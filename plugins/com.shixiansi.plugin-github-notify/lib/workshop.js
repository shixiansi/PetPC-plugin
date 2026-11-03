// lib/workshop.js —— 插件的这一页：把一轮 report 画出来，并且按设置里的分钟数定时再抓一次。
//
// 这里没有业务判断：去重、通知、写盘全在 notify.js 的 runCheck() 里。页面只做三件事——
// 显示、触发、以及把"为什么没有徽标"说出口（手册 §9：控制中心没宠物）。

'use strict';

const TAG_BY_KIND = { pr: 'tag accent', issue: 'tag info', ci: 'tag ok' };

function timeLabel(at) {
  const stamp = Number(at) || 0;
  if (!stamp) return '时间未知';
  const diff = nowMs() - stamp;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  const d = new Date(stamp);
  return d.getMonth() + 1 + ' 月 ' + d.getDate() + ' 日';
}

function paintChips(unreadCount, lastAt) {
  if (els.chipUnread) els.chipUnread.textContent = '未读 ' + (Number(unreadCount) || 0);
  if (els.chipLast) {
    els.chipLast.textContent = lastAt ? '上次检查 ' + timeLabel(lastAt) : '还没检查过';
  }
}

function paintSetup(problem) {
  if (!els.setup) return;
  if (!problem) {
    els.setup.hidden = true;
    els.setupText.textContent = '';
    return;
  }
  els.setup.hidden = false;
  els.setupTitle.textContent = '先去设置里填';
  els.setupText.textContent = problem;
}

/** 一个条目一行：类型标签 + 标题（带编号）+ 仓库与时间。 */
function rowFor(item) {
  const li = el('li', 'feed-row');
  li.appendChild(el('span', TAG_BY_KIND[item.kind] || 'tag', KIND_LABEL[item.kind] || item.kind));
  const main = el('div', 'feed-main');
  const number = item.number ? '#' + item.number + ' ' : '';
  main.appendChild(el('p', 'feed-title', number + item.title));
  main.appendChild(el('p', 'feed-meta muted', item.repo + ' · ' + timeLabel(item.at)));
  li.appendChild(main);
  return li;
}

function paintList(listEl, emptyEl, items) {
  if (!listEl) return;
  const list = arrayOf(items);
  listEl.textContent = '';
  for (const item of list) listEl.appendChild(rowFor(item));
  if (emptyEl) emptyEl.hidden = list.length > 0;
}

function paintErrors(errors) {
  if (!els.error) return;
  els.error.textContent = '';
  for (const entry of arrayOf(errors)) {
    // 宿主给的 error 原文本身就是给人看的中文句子，直接显示，不要再包一层"出错了"。
    els.error.appendChild(el('p', 'status error', entry.text));
  }
}

/**
 * 控制中心这一面没有宠物（手册 §9），所以徽标与气泡在这里做不了。这一行就是说这件事——
 * 一个点了没反应、也没有一句话解释的界面，比没有那一块更糟。
 */
function paintBadgeNote() {
  if (!els.badgeNote) return;
  let note = '';
  if (!serves('pet.badge') || !serves('bubble.say')) {
    note = '头顶那个未读徽标与那句话说在桌宠那边，这一页只负责列表与设置。';
  } else if (!granted.has('pet.surface')) {
    note = '没有 pet.surface 授权：头顶的未读徽标画不出来（气泡可能还在）。';
  } else if (!granted.has('pet.bubble')) {
    note = '没有 pet.bubble 授权：新动静不会说话，只有头顶的未读徽标。';
  }
  els.badgeNote.textContent = note;
  els.badgeNote.hidden = !note;
}

function renderReport(report) {
  if (role !== 'page') return;
  paintSetup(report.notice);
  paintChips(arrayOf(report.unread).length, report.at);
  paintList(els.unreadList, els.unreadEmpty, report.unread);
  paintList(els.feedList, els.feedEmpty, report.recent);
  paintErrors(report.errors);
  paintBadgeNote();

  const bits = [];
  if (report.notice) bits.push('什么都还没抓');
  else {
    bits.push('检查了 ' + arrayOf(report.repos).length + ' 个仓库');
    if (report.notModified.length) bits.push(report.notModified.length + ' 个内容没变');
    if (report.added.length) bits.push(report.added.length + ' 条新动静');
    else bits.push('没有新动静');
    if (report.skipped) bits.push(report.skipped + ' 个仓库名没看懂，已跳过');
  }
  if (report.errors.length) bits.push(report.errors.length + ' 个仓库出错');
  say(bits.join('，') + '。');
}

async function checkNow() {
  if (!ready) return null;
  if (role === 'page') {
    say('正在检查…');
    if (els.btnCheck) els.btnCheck.disabled = true;
  }
  let report;
  try {
    report = await runCheck();
  } catch (err) {
    // runCheck 自己不该抛；万一抛了也不能让整页停在那里。
    report = { at: nowMs(), notice: '', errors: [{ repo: '', text: String((err && err.message) || err) }], added: [], notModified: [], repos: [], unread: [], recent: [] };
  }
  if (role === 'page') {
    if (els.btnCheck) els.btnCheck.disabled = false;
    renderReport(report);
  }
  return report;
}

// --- 定时 --------------------------------------------------------------------

let pollTimer = 0;

/**
 * 定时抓取。间隔来自设置里的分钟数（最少 5 分钟）——这是"定时抓取"，不是"等一个文件变化"，
 * 所以事件 + 15 秒兜底那条规则不适用；但**绝不能**写成 1 秒：一份 8 仓库的设置会在一小时里
 * 把主机日志写成几万行 INFO。
 */
function startPolling() {
  stopPolling();
  const ms = intervalMinutes() * 60 * 1000;
  pollTimer = setInterval(() => {
    void checkNow();
  }, ms);
  return ms;
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = 0;
}

// --- 两副面孔 ----------------------------------------------------------------

async function bootPage() {
  paintBadgeNote();
  // 第一轮抓取立刻做：打开这一页时看到的是"现在"的样子，而不是"十分钟内的某个时候"。
  // 界面上的"先去设置里填"与宿主那句拒绝也由这一轮的 report 带出来（见 renderReport）。
  await checkNow();
  // **这一页不排定时器**：轮询只有一个执行者，就是常驻帧（manifest 的 background）。
  // 两个帧各自 setInterval 的代价是同一份 GitHub 配额被问两次、同一个 storage 键两个写者、
  // 用户开着插件页时日志里出现成对的行——而"打开这一页看到的数是新的"由上面那一轮保证，
  // 手动刷新还有「立即检查」。2026-11-03 之前这里真的排了定时器，只因为当时没有常驻帧。
}

/** 桌宠侧：不画页面，只轮询与通知。**唯一**的轮询者，间隔来自设置里的分钟数。 */
async function bootPet() {
  await checkNow();
  startPolling();
}
