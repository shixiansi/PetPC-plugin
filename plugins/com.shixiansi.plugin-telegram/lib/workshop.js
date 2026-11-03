// lib/workshop.js —— 工坊页那一面：配没配好、拉到了没有、为什么跳过
//
// 这一面在**控制中心**里跑（slot:"workshop"），它不持有轮询，也不发一个 net.fetch：
// 收消息的是桌宠的常驻帧。所以这里画的全是"另一个进程留下的证据"——`state/status` 与
// `state/notes`（常驻帧写、这里读）。
//
// 它存在的理由只有一个：让"没反应"变成一句有原因的话。一个安静的 bot 和"没装"在用户眼里
// 没有区别，而这个页面把四种常见原因（没 token、开关关着、白名单是空的、token 不对）摆在
// 最上面。

'use strict';

function el(tag, className, body) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (body !== undefined) node.textContent = body;
  return node;
}

function factLine(label, value) {
  const row = el('div', 'fact');
  row.append(el('span', 'fact-label', label), el('span', 'fact-value', value));
  return row;
}

function fmtTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const d = new Date(n);
  const pad = (x) => `${x}`.padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const PHASE_TEXT = {
  idle: '没在拉（还没配置好）', polling: '在等消息', retry: '网络出了问题，正在退避重连',
  auth: 'token 不对', conflict: '有另一个进程在抢同一个 bot', throttle: '被 Telegram 限流（429）',
  'no-permission': '缺少权限',
};

/** 「还差一步」那一段：每一条都是"现在什么都收不到"的原因。 */
function renderWarnings() {
  const lines = [];
  if (!granted.has('net.fetch')) {
    lines.push('没有 net.fetch 权限：没有它就不能去问 Telegram 要消息（在插件设置里重新授权）。');
  }
  if (!granted.has('plugin.call')) {
    lines.push('没有 plugin.call 权限：收得到话也没人能回答——回答在记忆核心里。');
  }
  if (!botToken()) {
    lines.push('先去设置里填 Bot Token：没有它连不上 Telegram，这个插件现在一个请求都不发。');
  } else if (!pollEnabled()) {
    lines.push('轮询开关关着：token 已经保存了，把设置里的「收消息」打开才会开始拉。');
  }
  if (!chatAllowList().length) {
    lines.push(
      '允许的 chat id 是空的 —— 留空 = 谁的都不收（这是故意的，不是"全都收"）。'
      + '把 chat id 填进设置，逗号分隔；不知道自己的 id 时，先让某人给这个 bot 发一句话，'
      + '「最近发生了什么」里会写出那个 id。',
    );
  }
  if (els.warnCard) els.warnCard.hidden = lines.length === 0;
  if (!els.warn) return;
  els.warn.textContent = '';
  for (const line of lines) els.warn.append(el('li', '', line));
}

function renderFacts(status) {
  if (!els.facts) return;
  const phase = PHASE_TEXT[pollState.phase] || pollState.phase;
  els.facts.textContent = '';
  els.facts.append(
    factLine('现在', pollState.message ? `${phase}：${pollState.message}` : phase),
    factLine('update_id 游标', cursor ? `下一条要 ≥ ${cursor}` : '还没开始（0）'),
    factLine('回答 / 跳过 / 失败', `${pollState.answered} / ${pollState.skipped} / ${pollState.failed}`),
    factLine('最近一次活动', fmtTime(status && status.at)),
    factLine('最近一次错误', pollState.lastError ? text(redact(pollState.lastError), 160) : '—'),
  );
}

function renderSettings() {
  if (!els.settings) return;
  const list = chatAllowList();
  const token = botToken();
  els.settings.textContent = '';
  els.settings.append(
    // 明文不画在页面上，连"前几位 + 掩码"都不画：它会进截图、进屏幕共享。
    factLine('Bot Token', token ? `已保存（${token.length} 字符，这里不显示）` : '没填'),
    factLine('允许的 chat id', list.length ? `${list.length} 个：${list.join(', ')}` : '空（谁的都不收）'),
    factLine('收消息（轮询开关）', pollEnabled() ? '开' : '关'),
    factLine('每次取几条 update', `${pollBatch()} 条`),
    factLine('回答由谁给', `${MEMCORE_TARGET} 的 chat 方法`),
    factLine('怎么收', '长轮询：getUpdates 让服务器替我们等 25 秒（宿主的 net.fetch 超时是 30 秒）'),
  );
}

async function renderWorkshop() {
  if (!els.workshop) return;
  els.workshop.classList.remove('hidden');
  await refreshConfig();

  // 盘上那一份是**另一个进程**写的（桌宠的常驻帧），它比内存里的新。
  const status = (await readJSON(KEY_STATUS, {})) || {};
  const storedNotes = await readJSON(KEY_NOTES, []);
  if (Array.isArray(storedNotes) && storedNotes.length) {
    notes.length = 0;
    for (const item of storedNotes.slice(-40)) notes.push(item);
  }
  pollState.phase = text(status.phase, 24) || 'idle';
  pollState.message = text(status.message, 200);
  pollState.retryIn = Number(status.retryIn) || 0;
  pollState.answered = Number(status.answered) || 0;
  pollState.skipped = Number(status.skipped) || 0;
  pollState.failed = Number(status.failed) || 0;
  pollState.lastError = text(status.lastError, 200);
  cursor = Number(status.cursor) || 0;

  renderStatus();
  renderWarnings();
  renderFacts(status);
  renderSettings();
  renderNotes();
  say(`已刷新 · ${new Date().toLocaleTimeString()}`);
}
