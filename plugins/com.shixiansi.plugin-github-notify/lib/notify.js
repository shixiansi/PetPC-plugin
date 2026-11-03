// lib/notify.js —— 一轮抓取：设置 → 抓 → 去重 → 写状态 → 通知（徽标 + 气泡）。
//
// 这是整个插件里唯一会"说出去"的地方，也是唯一写 storage 的地方。页面、轮询、按钮都只是
// 调它，然后渲染它回来的那份 report——所以"同一件事只说一次"只有一处逻辑要看。
//
// 两条克制：
//   · 徽标只在**数值变化时**推一次。pet.badge 是 DEBUG 级日志（手册 §3.9 的等级表），
//     每拍推一次等于自己制造噪音；
//   · 气泡只推**一句摘要**，不是一串标题：气泡是让人抬头看一眼的，不是列表。

'use strict';

const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 180;

/** 轮询间隔（分钟）。写死 1 秒是反模式（手册 §3.9）——这里的最小值是 5 分钟。 */
function intervalMinutes() {
  const raw = Number(cfg.intervalMinutes);
  if (!Number.isFinite(raw) || raw <= 0) return 10;
  return Math.max(MIN_INTERVAL_MINUTES, Math.min(MAX_INTERVAL_MINUTES, Math.round(raw)));
}

/** 用户勾的类型；一个都没勾时按"全都要"算（空选择在 select multiple 里是"没限制"）。 */
function wantedKinds() {
  const picked = [];
  for (const raw of String(cfg.kinds || '').split(',')) {
    const kind = raw.trim().toLowerCase();
    if (KIND_LABEL[kind] && picked.indexOf(kind) < 0) picked.push(kind);
  }
  return picked.length ? picked : ['pr', 'issue', 'ci'];
}

/**
 * 还没法开抓的原因。**两种空都算**：没有 token、没有仓库列表。
 *
 * 这一句就是界面上"先去设置里填"的来源，也是"一个 net.fetch 都不发"的开关：
 * 一个注定 401 的请求既浪费额度，也让人以为是 token 写错了。
 */
function setupProblem(repos) {
  const list = arrayOf(repos);
  const hasToken = Boolean(String(cfg.token || '').trim());
  if (!hasToken && !list.length) return 'token 和仓库列表都还空着：先去设置里填这两项，再回来。';
  if (!hasToken) return 'token 还空着：先去设置里填 Personal Access Token。';
  if (!list.length) return '仓库列表还空着：先去设置里填一个 owner/repo（多个用逗号分隔）。';
  return '';
}

// --- 通知 --------------------------------------------------------------------

// 上一次推给宿主的徽标文案。只有它变了才发请求——宿主按"最后一条生效"处理，重复推只是噪音。
let lastBadge = '';

async function pushBadge(count) {
  if (!canBadge()) return false;
  const text = badgeText(count);
  if (text === lastBadge) return false;
  try {
    await request('pet.badge', { text: text });
    lastBadge = text;
    return true;
  } catch (err) {
    // 被拒就是不画。这里不重试：没有徽标的桌宠仍然是桌宠。
    return false;
  }
}

async function saySummary(items) {
  if (!canBubble()) return false;
  const text = summarize(items);
  if (!text) return false;
  try {
    await request('bubble.say', { text: text });
    return true;
  } catch (err) {
    return false;
  }
}

// --- 一轮 --------------------------------------------------------------------

/**
 * 抓一轮。返回值永远是对象（不抛），页面照它画，桌宠侧照它说。
 *
 * report 的字段就是界面需要的全部：notice（还没配置 / 没授权，一句话）、errors（每个仓库
 * 一条中文）、added（这一轮新出现的）、unread / recent（要画的两张列表）。
 */
async function runCheck() {
  const report = {
    at: nowMs(), notice: '', errors: [], added: [], notModified: [],
    repos: [], unread: [], recent: [], wrote: false, said: false, badged: false, skipped: 0,
  };
  const configOk = await refreshCfg();
  const repos = parseRepos(cfg.repos);
  report.repos = repos.map((repo) => repo.key);
  // 仓库列表里写错的那几个：**说出来**。悄悄丢掉会让用户以为"我明明加了它"，而症状是
  // 那个仓库一条通知都没有。
  const tokens = String(cfg.repos || '').split(/[,，\s]+/).filter((token) => token.trim());
  report.skipped = Math.max(0, tokens.length - repos.length);
  // 设置读不到时把宿主的原文（"未获权限 plugin.config" 之类）一起显示出来：否则界面只会说
  // "先去设置里填"，而用户明明填过了——那是最难查的一种。
  if (!configOk && lastConfigError) report.errors.push({ repo: '', text: lastConfigError });
  const problem = setupProblem(repos);
  if (problem) {
    report.notice = problem;
    return report;
  }
  if (!granted.has('net.fetch')) {
    report.notice = '这个窗口没有 net.fetch 授权：抓不了 GitHub。';
    return report;
  }

  const state = await loadState();
  const kinds = wantedKinds();
  // 本轮开始前就见过哪些 id：这是"同一件事只说一次"的判据。用一份快照，因为 seen 在循环里
  // 会往前挪动；快照也让"同一个事件出现在两个仓库里"只算一次。
  const known = new Set(state.seen);

  for (const repo of repos) {
    const result = await fetchRepo(repo.key, state.etags[repo.key]);
    if (result.notModified) {
      report.notModified.push(repo.key);
      continue;
    }
    if (result.error) {
      report.errors.push({ repo: repo.key, text: result.error });
      continue;
    }
    if (result.etag) state.etags[repo.key] = result.etag;
    const items = result.items;
    for (const item of items) {
      if (state.seen.indexOf(item.id) < 0) state.seen.unshift(item.id);
    }
    state.seen = state.seen.slice(0, MAX_SEEN);
    const wanted = items.filter((item) => kinds.indexOf(item.kind) >= 0);
    for (const item of wanted) {
      // 见过的**全部**记下来（包括用户此刻不关心的类型）：否则"先关掉 CI 再打开"会把几小时前
      // 的失败当成新动静说一遍。
      if (known.has(item.id)) continue;
      known.add(item.id);
      report.added.push(item);
    }
    state.recent = mergeRecent(wanted, state.recent);
  }

  if (report.added.length) {
    state.unread = report.added.concat(state.unread).slice(0, MAX_UNREAD);
  }
  state.lastAt = report.at;
  state.lastError = report.errors.length ? report.errors[0].text : '';
  report.wrote = await saveState(state);

  report.unread = state.unread;
  report.recent = state.recent;
  // 顺序有讲究：先徽标再气泡。徽标是"有几条"，气泡是"是哪一条"——反过来的话，用户看到气泡
  // 时徽标还是旧数字。
  report.badged = await pushBadge(state.unread.length);
  if (report.added.length) report.said = await saySummary(report.added);
  return report;
}

/**
 * 「最近事件」那一栏：新一轮的条目 + 上一次留下的，**按 id 去重、按时间倒序、只留 N 条**。
 *
 * 为什么非要在这里去重：每一轮都会把同一个仓库最近 30 条重新抓回来，直接 concat 会让同一条
 * 事件在列表里出现三次、五次——而那看起来像"这个仓库一直在动"。
 */
function mergeRecent(fresh, previous) {
  const merged = [];
  const ids = new Set();
  for (const item of arrayOf(fresh).concat(arrayOf(previous))) {
    if (!item || ids.has(item.id)) continue;
    ids.add(item.id);
    merged.push(item);
  }
  merged.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  return merged.slice(0, MAX_RECENT);
}

/** 把"全部标记为已读"落盘，顺便清掉徽标。 */
async function markAllRead() {
  const state = await loadState();
  state.unread = [];
  const wrote = await saveState(state);
  await pushBadge(0);
  return { wrote: wrote, unread: [] };
}
