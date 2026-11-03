// lib/github.js —— 接口那一侧：URL、两种响应形状、事件分类、一句话摘要、报错文案。
//
// 端点选的是 `GET /repos/{owner}/{repo}/events`（仓库事件），理由写在 README 里：它不要
// `notifications` scope、按仓库回答（所以 404 能点名是哪个仓库）、而且公开仓库匿名可读。
// 但**解析**两种形状都认：/events 把标题放在 payload 里，/notifications 放在 subject 里
// （`subject.title` + `subject.type`）——换端点时不用重写解析，测试也是两种各喂一条。

'use strict';

const API_ROOT = 'https://api.github.com';
const MAX_REPOS = 8;
const MAX_BUBBLE = 140;
const KIND_LABEL = { pr: 'PR', issue: 'Issue', ci: 'CI' };
// owner ≤39 字符、repo ≤100（GitHub 的上限），字符集是它允许的那几个。
const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;

// 只有这几种"动静"值得叫醒用户：synchronize / labeled / assigned 之类每个 PR 都会刷很多条，
// 通知它们等于把插件变成噪音源。
const PR_ACTIONS = ['opened', 'reopened', 'ready_for_review', 'closed'];
const ISSUE_ACTIONS = ['opened', 'reopened', 'closed'];
const CI_ACTIONS = ['completed', 'requested'];
// /notifications 形状没有 type/action，只有 subject.type。
const SUBJECT_KINDS = { PullRequest: 'pr', Issue: 'issue', CheckSuite: 'ci', Commit: 'ci' };
const CONCLUSION_LABEL = {
  success: '通过', failure: '失败', cancelled: '取消', timed_out: '超时',
  action_required: '需要处理', neutral: '中性', skipped: '跳过', stale: '过期',
};

/** `owner/repo, other/repo` → [{key, owner, name}]。去重、限量、丢掉写错的那些。 */
function parseRepos(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text || '').split(/[,，\s]+/)) {
    const full = raw.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
    if (!full || !REPO_PATTERN.test(full)) continue;
    const key = full.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const parts = full.split('/');
    out.push({ key: full, owner: parts[0], name: parts[1] });
    if (out.length >= MAX_REPOS) break;
  }
  return out;
}

function eventsUrl(fullName) {
  // per_page 的默认值就是 30，写出来是为了让"一次能看多少条"变成可读的常量。
  return API_ROOT + '/repos/' + fullName + '/events?per_page=30';
}

// --- 分类 --------------------------------------------------------------------

function kindOfEvent(type, action) {
  if (type === 'PullRequestEvent') return PR_ACTIONS.indexOf(action) >= 0 ? 'pr' : '';
  if (type === 'IssuesEvent') return ISSUE_ACTIONS.indexOf(action) >= 0 ? 'issue' : '';
  if (type === 'WorkflowRunEvent' || type === 'CheckRunEvent') {
    return CI_ACTIONS.indexOf(action) >= 0 ? 'ci' : '';
  }
  if (type === 'StatusEvent') return 'ci';
  return '';
}

function titleOf(raw, payload, kind) {
  const pr = payload.pull_request || {};
  const issue = payload.issue || {};
  const run = payload.workflow_run || {};
  const check = payload.check_run || {};
  const subject = raw.subject || {};
  if (pr.title) return String(pr.title) + (pr.merged ? '（已合并）' : '');
  if (issue.title) return String(issue.title);
  if (run.display_title || run.name) {
    const name = String(run.display_title || run.name);
    const conclusion = CONCLUSION_LABEL[String(run.conclusion || '')];
    return conclusion ? name + '：' + conclusion : name;
  }
  if (check.name) {
    const conclusion = CONCLUSION_LABEL[String(check.conclusion || '')];
    return conclusion ? String(check.name) + '：' + conclusion : String(check.name);
  }
  if (subject.title) return String(subject.title);
  return KIND_LABEL[kind] + ' 事件';
}

function numberFrom(raw, payload) {
  const pr = payload.pull_request || {};
  const issue = payload.issue || {};
  const run = payload.workflow_run || {};
  const direct = pr.number || issue.number || run.run_number || 0;
  if (direct) return Number(direct) || 0;
  // /notifications 形状把编号藏在 subject.url 的末段（…/issues/12）。
  const tail = String((raw.subject && raw.subject.url) || '').split('?')[0].split('/').filter(Boolean).pop() || '';
  return /^[0-9]+$/.test(tail) ? Number(tail) : 0;
}

function timeOf(raw) {
  const stamp = raw.created_at || raw.updated_at || raw.at || '';
  const ms = Date.parse(String(stamp));
  return Number.isFinite(ms) ? ms : 0;
}

/** 一条原始条目 → 我们自己的形状；不是"值得叫醒人的事件"就返回 null。 */
function normalizeEvent(fullName, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id === undefined || raw.id === null ? '' : raw.id);
  if (!id) return null;
  const payload = raw.payload && typeof raw.payload === 'object' ? raw.payload : {};
  const action = String(payload.action || raw.action || '');
  const type = String(raw.type || '');
  let kind = kindOfEvent(type, action);
  if (!kind) kind = SUBJECT_KINDS[String((raw.subject && raw.subject.type) || '')] || '';
  if (!kind) return null;
  return {
    id: id,
    repo: fullName,
    kind: kind,
    title: clampText(titleOf(raw, payload, kind), 100),
    number: numberFrom(raw, payload),
    at: timeOf(raw),
  };
}

/** 响应体（字符串）→ 条目数组。形状不认识就抛，让调用方把原因写给人看。 */
function itemsFromBody(fullName, body) {
  const parsed = JSON.parse(body);
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed && parsed.items) ? parsed.items : null;
  if (!list) throw new Error('回答的形状不认识（既不是数组，也没有 items）');
  const out = [];
  for (const raw of list) {
    const item = normalizeEvent(fullName, raw);
    if (item) out.push(item);
  }
  return out;
}

// --- 一句话摘要 --------------------------------------------------------------

/**
 * 气泡那一句。要求只有两条：**含仓库名与事件类型**，而且是一句话——不是把标题们拼成一串。
 *
 * 条数多时按"仓库 + 类型"概括，标题只为单独那一条服务：一串标题在气泡里既读不完，
 * 也读不懂哪一条更急。
 */
function summarize(items) {
  const list = arrayOf(items);
  if (!list.length) return '';
  const newest = list[0];
  const repos = [];
  const kinds = [];
  for (const item of list) {
    if (repos.indexOf(item.repo) < 0) repos.push(item.repo);
    const label = KIND_LABEL[item.kind] || item.kind;
    if (kinds.indexOf(label) < 0) kinds.push(label);
  }
  let text;
  if (list.length === 1) {
    const number = newest.number ? ' #' + newest.number : '';
    text = newest.repo + ' 有新的 ' + (KIND_LABEL[newest.kind] || '事件') + number + '：' + newest.title;
  } else if (repos.length === 1) {
    text = newest.repo + ' 有 ' + list.length + ' 条新动静（' + kinds.join('、') + '）';
  } else {
    text = newest.repo + ' 等 ' + repos.length + ' 个仓库共 ' + list.length + ' 条新动静（' + kinds.join('、') + '）';
  }
  return clampText(text, MAX_BUBBLE);
}

// --- 失败说的是人话 ----------------------------------------------------------

function headerOf(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const lower = String(name).toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return String(headers[key]);
  }
  return '';
}
function looksRateLimited(bodyText, headers) {
  // 宿主今天的 net.fetch 只回 {status, body}，没有响应头（README 的"条件请求"一节写了这条），
  // 所以主判据是正文：GitHub 的限流回答里一定有 "rate limit" 这几个字。
  if (headerOf(headers, 'x-ratelimit-remaining') === '0') return true;
  const text = String(bodyText || '').toLowerCase();
  return text.indexOf('rate limit') >= 0 || text.indexOf('abuse') >= 0 || text.indexOf('secondary rate') >= 0;
}

/** 限流还要等几分钟：有 x-ratelimit-reset 就按它算，没有就按下一次轮询（插件本来就会再试）。 */
function retryMinutes(headers, fallback) {
  const reset = Number(headerOf(headers, 'x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    const minutes = Math.ceil((reset * 1000 - nowMs()) / 60000);
    if (minutes > 0) return Math.min(180, minutes);
  }
  return Math.max(1, Math.round(Number(fallback) || 10));
}

/**
 * HTTP 状态 → 一句中文。每一种都点名"下一步该怎么办"，因为这一行是用户唯一看得到的东西。
 *
 * 三段是分开的，因为对策完全不同：401 换令牌，403 等一会儿，404 改仓库名。
 */
function describeFailure(status, body, fullName, headers, intervalMin) {
  const text = clampText(body, 200);
  if (status === 401) return 'token 无效或过期，去设置里换一个';
  if (status === 403) {
    if (looksRateLimited(text, headers)) {
      return '被限流了，' + retryMinutes(headers, intervalMin) + ' 分钟后自动重试';
    }
    return 'GitHub 拒绝了这次请求（403）：这个 token 大概没有 ' + fullName + ' 的读权限';
  }
  if (status === 404) return '找不到 ' + fullName + '：仓库名写错了，或者这个 token 看不到它';
  if (status >= 500) return 'GitHub 那边出问题了（HTTP ' + status + '），下一次轮询再试';
  if (status === 0) return '请求没有走到 GitHub：' + (text || '宿主没给原因');
  return 'GitHub 回了 HTTP ' + status + '：' + (text || '没有说明');
}

// --- 一次抓取 ----------------------------------------------------------------

/**
 * 宿主的请求头白名单只有 accept / authorization / content-type / user-agent
 * （internal/plugins/fetchheaders.go），`if-none-match` 不在里面：带上它会被**整条拒掉**，
 * 请求根本发不出去。所以条件请求是"能带上就带"——被拒一次就永久关掉，这一轮改用不带校验器
 * 的同一个 URL 重发一次。真机上今天就是这条路：304 那一支是防御性的（README 有整节说明），
 * "同一件事只通知一次"的硬保证是 notify.js 里按事件 id 去重。
 */
let conditionalOff = false;

async function fetchWithValidator(url, etag) {
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: 'Bearer ' + String(cfg.token || ''),
    'user-agent': 'PetPC-github-notify',
  };
  const conditional = Boolean(etag) && !conditionalOff;
  if (conditional) headers['if-none-match'] = String(etag);
  try {
    return await request('net.fetch', { method: 'GET', url: url, headers: headers });
  } catch (err) {
    const message = String((err && err.message) || err);
    if (conditional && /请求头|if-none-match/i.test(message)) {
      conditionalOff = true;
      return fetchWithValidator(url, '');
    }
    throw err;
  }
}

function etagOf(out) {
  if (!out || typeof out !== 'object') return '';
  if (typeof out.etag === 'string' && out.etag) return out.etag;
  return headerOf(out.headers, 'etag');
}

/**
 * 抓一个仓库。返回值永远是对象，不抛：一个仓库失败不该让另外七个也停下来，
 * 而失败要变成界面上一句中文（report.errors）。
 */
async function fetchRepo(fullName, etag) {
  let out;
  try {
    out = await fetchWithValidator(eventsUrl(fullName), etag);
  } catch (err) {
    const message = String((err && err.message) || err);
    // 宿主自己的拒绝（未获权限 / 未声明的域名）原文就是给人看的，别包成"出错了"。
    return { error: message };
  }
  const status = Number((out && out.status) || 0);
  // 304：内容没变。**不解析、不算新、不通知**——空正文不是"零个事件"。
  if (status === 304) return { notModified: true };
  const body = out && typeof out.body === 'string' ? out.body : '';
  const headers = (out && out.headers) || null;
  if (status < 200 || status >= 300) {
    return { error: describeFailure(status, body, fullName, headers, intervalMinutes()) };
  }
  let items;
  try {
    items = itemsFromBody(fullName, body);
  } catch (err) {
    return { error: fullName + ' 的回答读不出来：' + clampText((err && err.message) || err, 80) };
  }
  return { items: items, etag: etagOf(out), truncated: Boolean(out && out.truncated) };
}
