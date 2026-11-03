// GitHub 通知 —— 纯函数层（无宿主依赖，window.__gh.core 是测试接缝）。
//
// 这里只做四件事：通知摘要文案、通知/事件的归一化、去重集合的合并、错误分类。
// 所有与宿主说话（net.fetch / storage / bubble.say）的编排都在 app.js。

'use strict';

(function () {
  const core = {};

  // --- 归一化 ------------------------------------------------------------------

  // notifications API 的一条 → { id, repo, title, kind, url, at, unread }
  // 宿主只给我们响应体字符串，解析失败的那条跳过（坏的跳、好的照常），整体不抛。
  core.parseNotification = function (raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || '');
    if (!id) return null;
    const repo = (raw.repository && raw.repository.full_name) || '';
    const subject = raw.subject || {};
    const kind = String(subject.type || '').toLowerCase(); // PullRequest / Issue / Release / CheckSuite ...
    return {
      id,
      repo,
      title: String(subject.title || ''),
      kind,
      url: String((subject.latest_comment_url || subject.url || '')),
      at: Date.parse(raw.updated_at || '') || 0,
      unread: raw.unread !== false,
    };
  };

  // 首个字母大写化，显示用：pullrequest → PullRequest 的观感
  core.kindLabel = function (kind) {
    const k = String(kind || '').toLowerCase();
    if (k === 'pullrequest') return 'PullRequest';
    if (k === 'issue') return 'Issue';
    if (k === 'checksuite') return 'CheckSuite';
    if (k === 'release') return 'Release';
    if (k === 'discussion') return 'Discussion';
    return k ? k.charAt(0).toUpperCase() + k.slice(1) : '通知';
  };

  // events API 的一条 → { id, repo, kind, title, url, at, unread }
  core.parseEvent = function (raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || '');
    if (!id) return null;
    const type = String(raw.type || '').replace(/Event$/, '');
    const actor = (raw.actor && raw.actor.login) || '';
    const repo = (raw.repo && raw.repo.name) || '';
    const payload = raw.payload || {};
    let title = '';
    let url = '';
    if (type === 'PullRequest') {
      const pr = payload.pull_request || {};
      title = String(pr.title || '');
      url = String(pr.html_url || '');
    } else if (type === 'Issues') {
      const issue = payload.issue || {};
      title = String(issue.title || '');
      url = String(issue.html_url || '');
    } else if (type === 'IssueComment') {
      const issue = payload.issue || {};
      title = String(issue.title || '');
      url = String((payload.comment && payload.comment.html_url) || issue.html_url || '');
    } else if (type === 'Push') {
      const size = Number(payload.size);
      title = `${actor} 推送了 ${Number.isFinite(size) ? size : payload.commits ? payload.commits.length : 0} 个提交`;
      url = String((payload.head_commit && payload.head_commit.url) || '');
    } else if (type === 'Watch' || type === 'Fork') {
      title = `${actor} ${type === 'Fork' ? 'fork 了' : 'star 了'}这个仓库`;
    } else {
      title = actor ? `${actor} 的 ${type} 动态` : `${type} 动态`;
    }
    return {
      id: `ev-${id}`,
      repo,
      title,
      kind: type.toLowerCase() || 'event',
      url,
      at: Date.parse(raw.created_at || '') || 0,
      unread: true,
      via: 'events',
    };
  };

  core.parseNotifications = function (body) { return core.digestList(core.parseNotification, body); };
  core.parseEvents = function (body) { return core.digestList(core.parseEvent, body); };

  core.digestList = function (fn, body) {
    let arr = body;
    if (typeof body === 'string') {
      try { arr = JSON.parse(body); } catch { return []; }
    }
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const item of arr) {
      const n = fn(item);
      if (n) out.push(n);
    }
    return out;
  };

  // --- 气泡文案 ------------------------------------------------------------------
  // PR / Issue / CI(CheckSuite) / 其它，各有措辞；必须含类型短语与仓库名。
  core.bubbleText = function (item) {
    const repo = item.repo || 'GitHub';
    const title = core.oneLine(item.title || '');
    const k = String(item.kind || '').toLowerCase();
    if (k === 'pullrequest' || k === 'pull_request') {
      return `GitHub PR 更新：${repo}「${title}」有新动静。`;
    }
    if (k === 'issue') {
      return `GitHub Issue：${repo}「${title}」有新回复或状态变化。`;
    }
    if (k === 'checksuite') {
      return `GitHub CI：${repo} 的检查「${title}」有了新结果。`;
    }
    if (k === 'release') {
      return `GitHub 发布：${repo} 有新版本「${title}」。`;
    }
    return `GitHub 通知：${repo}「${title}」有更新。`;
  };

  core.oneLine = function (s) {
    const line = String(s || '').replace(/\s+/g, ' ').trim();
    if (!line) return '（无标题）';
    return line.length > 60 ? `${line.slice(0, 59)}…` : line;
  };

  // --- 去重 ----------------------------------------------------------------------
  // 已见过的通知 id 不再气泡。集合持久化在 storage（JSON 数组），这里做合并与裁剪。
  core.SEEN_MAX = 400;

  core.mergeSeen = function (seenIds, freshIds, max = core.SEEN_MAX) {
    const seen = Array.isArray(seenIds) ? seenIds.map(String) : [];
    const set = new Set(seen);
    const added = [];
    for (const id of Array.isArray(freshIds) ? freshIds.map(String) : []) {
      if (!id || set.has(id)) continue;
      set.add(id);
      added.push(id);
    }
    let kept = seen;
    if (added.length) kept = seen.concat(added);
    if (kept.length > max) kept = kept.slice(kept.length - max);
    return { seen: kept, added };
  };

  // 新通知 = 未读 ∧ 没见过。seen 在手，别让"旧通知被 GitHub 又标成 unread"重复吵人。
  core.freshItems = function (items, seenIds) {
    const set = new Set((seenIds || []).map(String));
    return (items || []).filter((it) => it && it.unread !== false && !set.has(String(it.id)));
  };

  // --- 错误分类 --------------------------------------------------------------------
  // 401 = token 无效；403 = 权限不足 / SSO（限流也走 403，用 body 或 x-ratelimit 佐证时归限流）；
  // 429 = 限流。net.fetch 目前只回 { status, body }，响应头拿不到——x-ratelimit-remaining
  // 只能在"宿主将来回传 headers"时用（headers 参数可空，见 resetLine）。
  core.classify = function (status, body, headers) {
    const s = Number(status) || 0;
    const text = String(body || '');
    if (s === 401) return { code: 'unauthorized', message: 'token 无效：GitHub 拒绝了这个 token（401）。请到设置里更新它。' };
    if (s === 403) {
      const limited = /rate limit/i.test(text)
        || (headers && String(headers['x-ratelimit-remaining'] || '') === '0');
      if (limited) return core.ratelimited(0, headers);
      return { code: 'forbidden', message: '权限不足 / SSO：token 有效但这个资源不让它访问（403）。请检查 token 的 scope，或确认 SSO 已授权。' };
    }
    if (s === 429) return core.ratelimited(0, headers);
    if (s === 404) return { code: 'notfound', message: '找不到这个仓库（404）：私有仓库需要 token，公开仓库请检查 owner/repo 拼写。' };
    if (s >= 500) return { code: 'server', message: `GitHub 服务端错误（${s}）：稍后会自动重试。` };
    if (s === 0) return { code: 'offline', message: '网络不可达：保留上次的列表，稍后自动重试。' };
    return { code: 'http', message: `GitHub 返回了 ${s}：稍后自动重试。` };
  };

  core.ratelimited = function (_unused, headers) {
    const reset = core.resetLine(headers && headers['x-ratelimit-reset']);
    return { code: 'ratelimit', message: `限流：请求太快，${reset}重置。稍后自动重试。` };
  };

  // 重置时刻 → "HH:MM 重置"。没有头时（当前宿主不给）就"稍后"。
  core.resetLine = function (resetHeader) {
    const n = Number(resetHeader);
    if (!Number.isFinite(n) || n <= 0) return '稍后';
    const d = new Date(n * 1000);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm} `;
  };

  // x-ratelimit-remaining 只在宿主将来回传 headers 时才有值（可空对象）。
  core.isRateLimitedByHeader = function (headers) {
    return Boolean(headers) && String(headers['x-ratelimit-remaining'] || '') === '0';
  };

  // --- storage 值的形状 -------------------------------------------------------------
  // state/v1：{ seen: [id…], etag: {notifications, events}, last: [归一化通知…], at: <ms>, source: 'notifications'|'events'|'' }
  // token 绝不进这里（config 管）。
  core.emptyState = function () {
    return { seen: [], etag: { notifications: '', events: '' }, last: [], at: 0, source: '' };
  };

  core.sanitizeState = function (value) {
    const base = core.emptyState();
    let v = value;
    if (typeof value === 'string') {
      try { v = JSON.parse(value); } catch { return base; }
    }
    if (!v || typeof v !== 'object') return base;
    const seen = Array.isArray(v.seen) ? v.seen.map(String).slice(-core.SEEN_MAX) : [];
    const last = Array.isArray(v.last) ? v.last.filter((x) => x && typeof x === 'object') : [];
    const etag = (v.etag && typeof v.etag === 'object') ? v.etag : {};
    return {
      seen,
      etag: { notifications: String(etag.notifications || ''), events: String(etag.events || '') },
      last,
      at: Number(v.at) || 0,
      source: String(v.source || ''),
    };
  };

  window.__gh = Object.freeze({ core: Object.freeze(core) });
})();
