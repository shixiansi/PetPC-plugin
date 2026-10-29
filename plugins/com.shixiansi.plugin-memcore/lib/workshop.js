// lib/workshop.js —— 插件页那一面：记忆都能看见、能清掉
//
// WHY 这一面存在
//
// 记忆是用户的数据。看不见的数据等于不在：用户没法判断"它到底记了我什么"、也删不掉记错的
// 东西。所以这一面只做两件事——**如实显示**四层各存了什么，以及**清掉一个会话**。
//
// 人设不在这里编辑：它是 manifest 的 config，编辑器由宿主按声明画出来（另一套真话只会分叉）。
// 这里只把**当前生效的那一段**原样显示出来，因为"我以为我写的是 A、它其实用着 B"是这类插件
// 最常见的困惑。
//
// 它在控制中心里跑（surface.slot === 'workshop'），那里没有 llm.chat、没有 llm.profile，也不会有
// plugin.call。所以这一面的每一次请求都只碰 storage.* / config.*：一个在错误的窗口里点了没反应的
// 按钮比没有按钮更糟，**而一次注定被拒的调用还会在宿主日志里留一条 WARN**——2026-10-29 真机上
// `llm.profile 没有执行` 就是这么每 5 秒一条、把市场日志刷满的。所以"问了再兜底"在这里不够：
// 插件的 catch 只让界面好看，不让日志安静。

'use strict';

let selectedRole = '';

function el(tag, className, body) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (body !== undefined) node.textContent = body;
  return node;
}

/** 一行记忆统计。 */
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

/** 模型是谁的：真机上这句话决定用户该去哪里填 key。 */
async function renderModelChip() {
  if (!els.chipModel) return;
  // 控制中心不服务 llm.profile（手册 §9：它没有宠物窗口、没有模型预算）。按 slot 判断，
  // 而不是"问一次被拒再兜底"——理由见文件头：被拒的那次已经在宿主日志里记了一条 WARN。
  if (self.slot === 'workshop') {
    els.chipModel.textContent = '模型：由桌宠那边的配置决定（这一页查不到）';
    return;
  }
  try {
    const p = await request('llm.profile', {});
    const source = p && p.source ? p.source : 'none';
    if (source === 'own') {
      els.chipModel.textContent = `模型：本插件配置${p.model ? `（${p.model}）` : ''}`;
      return;
    }
    if (source === 'borrowed') {
      const from = p.lender && p.lender.name ? p.lender.name : '另一个插件';
      els.chipModel.textContent = `模型：借自${from}${p.model ? `（${p.model}）` : ''}`;
      return;
    }
    els.chipModel.textContent = '模型：还没有可用的配置';
  } catch (err) {
    els.chipModel.textContent = '模型：读取失败';
  }
}

/** 顶部那张"现在记着什么"。 */
async function renderFacts(roles) {
  if (!els.facts) return;
  els.facts.textContent = '';

  let turns = 0;
  let episodes = 0;
  for (const key of roles) {
    const state = await loadRole(key);
    turns += state.turns.length;
    episodes += state.episodes.length;
  }
  const ledger = await readJSON('mem/global/chain', []);
  const ledgerCount = Array.isArray(ledger) ? ledger.length : 0;
  const lastError = await readJSON('state/lastError', null);

  els.facts.append(
    factLine('会话', `${roles.length} 个`),
    factLine('还在缓冲里的往来', `${turns} 条`),
    factLine('长期记住的事', `${episodes} 条`),
    factLine('全局事件链', `${ledgerCount} 条（只写不读：任何回答都不会用它）`),
  );
  if (lastError && lastError.message) {
    els.facts.append(factLine('上一次整理失败', `${fmtTime(lastError.at)} · ${lastError.message}`));
  }

  if (els.personas) {
    const custom = String(cfg.persona || '').trim();
    els.personas.textContent = custom
      || `（没写人设，用的是默认那句：你是「${String(cfg.personaName || '小记')}」，话不多但记得住事。）`;
  }
}

function renderRoleRows(roles) {
  if (!els.rolesBody) return;
  els.rolesBody.textContent = '';
  for (const key of roles) {
    const row = el('tr');
    row.dataset.role = key;
    if (key === selectedRole) row.classList.add('selected');
    row.append(
      el('td', 'role-name', key),
      el('td', 'role-turns', '…'),
      el('td', 'role-episodes', '…'),
      el('td', 'role-summary', '…'),
    );
    row.addEventListener('click', () => {
      selectedRole = key;
      void renderDetail(key).catch(() => {});
      renderRoleRows(roles);
    });
    els.rolesBody.append(row);
    void (async () => {
      const state = await loadRole(key);
      row.children[1].textContent = `${state.turns.length}`;
      row.children[2].textContent = `${state.episodes.length}`;
      row.children[3].textContent = state.summary && state.summary.text
        ? text(state.summary.text, 60)
        : '（还只是最近往来，没到压摘要的时候）';
    })();
  }
}

/** 一个会话的详情：摘要、长期记忆、画像、角色链最近几条。 */
async function renderDetail(roleKey) {
  if (!els.detail) return;
  if (!roleKey) {
    els.detail.hidden = true;
    return;
  }
  const state = await loadRole(roleKey);
  els.detail.hidden = false;
  if (els.detailTitle) els.detailTitle.textContent = `会话 ${roleKey}`;
  if (els.detailSummary) {
    els.detailSummary.textContent = state.summary && state.summary.text
      ? `${state.summary.text}（${fmtTime(state.summary.at)}）`
      : '还没有摘要：往来还没超过缓冲上限。';
  }
  if (els.detailEpisodes) {
    els.detailEpisodes.textContent = '';
    if (!state.episodes.length) {
      els.detailEpisodes.append(el('li', 'muted', '还没有长期记忆。'));
    } else {
      for (const item of state.episodes.slice().reverse()) {
        els.detailEpisodes.append(el('li', '', `${fmtTime(item.at)} · ${item.text}`));
      }
    }
  }
  if (els.detailProfile) {
    const userId = state.summary && state.summary.lastUserId ? state.summary.lastUserId : '';
    if (!userId) {
      els.detailProfile.textContent = '还没有画像（画像是攒够几次摘要之后才生成的）。';
    } else {
      const profile = await loadProfile(userId);
      const bits = [];
      if (profile.name) bits.push(`称呼：${profile.name}`);
      if (profile.stage) bits.push(`关系：${profile.stage}`);
      if (profile.prefs.length) bits.push(`偏好：${profile.prefs.join('；')}`);
      if (profile.habits.length) bits.push(`习惯：${profile.habits.join('；')}`);
      els.detailProfile.textContent = bits.length
        ? `${bits.join('\n')}`
        : `还没有画像（用户键 ${userId}）。`;
    }
  }
  if (els.detailChain) {
    els.detailChain.textContent = '';
    const recent = state.chain.slice(-8).reverse();
    if (!recent.length) {
      els.detailChain.append(el('li', 'muted', '还没有事件。'));
    } else {
      for (const item of recent) {
        els.detailChain.append(el('li', '', `${fmtTime(item.at)} · ${item.who || '?'} · ${item.text || item.kind}`));
      }
    }
  }
}

/**
 * 插件的这一面：刷新一次。
 *
 * 控制中心可能同时开着这个页面而桌宠在另一头写文件，所以它按需重读，不缓存任何"刚才看到
 * 的东西"——用户点刷新（或者切回来）就应该看到磁盘上的真实内容。
 */
async function renderWorkshop() {
  if (!els.workshop) return;
  els.workshop.classList.remove('hidden');
  if (els.root) els.root.classList.add('view-workshop');
  await refreshConfig();
  if (els.chipSlot) els.chipSlot.textContent = '记忆核心 · 插件页';

  // 没有 storage 就什么都不显示，并且**说出来**：一个每格都是"…"的页面比一句"未获授权"
  // 更难懂，而用户在这件事上唯一能做的动作就是去重新授权。
  if (!granted.has('storage')) {
    if (els.facts) els.facts.textContent = '';
    if (els.rolesEmpty) {
      els.rolesEmpty.hidden = false;
      els.rolesEmpty.textContent = '没有 storage 权限：这个插件看不到自己的记忆。请在插件设置里重新授权。';
    }
    if (els.detail) els.detail.hidden = true;
    say('未获 storage 权限');
    return;
  }

  void renderModelChip();

  const roles = await listRoleKeys();
  await renderFacts(roles);
  if (els.rolesEmpty) els.rolesEmpty.hidden = roles.length > 0;
  renderRoleRows(roles);
  if (selectedRole && roles.includes(selectedRole)) await renderDetail(selectedRole);
  else if (els.detail) els.detail.hidden = true;
  say(`已刷新 · ${new Date().toLocaleTimeString()}`);
}

/** 清掉选中会话的四份记忆（全局账本不动，见 chat.js 的 forgetRole）。 */
async function forgetSelected() {
  if (!selectedRole) return;
  const ok = typeof window.confirm === 'function'
    ? window.confirm(`清掉会话「${selectedRole}」的记忆？摘要、长期记忆、最近的往来都会没掉，全局事件链保持不动。`)
    : true;
  if (!ok) return;
  await forgetRole(selectedRole);
  selectedRole = '';
  await renderWorkshop();
}
