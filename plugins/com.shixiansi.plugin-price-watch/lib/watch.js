// lib/watch.js —— 一轮抓取与比对（这个插件的心脏）
//
// 四条纪律，每条都有用例钉着（tests/plugin-price-watch.test.js）：
//
//   A. 首次抓取不报警：没有历史时只存基线（装上的第一天 8 条全报变了，第二天就会被关掉）。
//   B. 变化要连续两轮抓到同样的新内容才播报一次（CONFIRM_TICKS）：构建中、AB 分桶、翻页动画都会
//      让页面短暂变成另一个样子，甚至 A→B→A→B 横跳。代价是"变了"晚一个间隔才说，换回来的是
//      抖动一个气泡都没有、稳定的变化只报一次；横跳在"两轮确认"下产生 0 个气泡——每一次
//      "新内容"都被下一次抓到的东西否掉了。
//   C. 抓不到时不报警、也不覆盖旧快照：只写一条 ok:false 的记录，hash/excerpt/lastOkAt 原样保留，
//      于是界面还看得见「上次成功是 X 分钟前」，恢复之后比的仍然是那份旧基线。
//   D. 免打扰时段只更新快照、不弹气泡：否则第二天早上会攒一串"变化"排队炸出来。
//
// 另一条属于边界：**宿主拒绝 ≠ 站点失败**。前者是"这个能力现在不可用"（没授权、这个窗口不支持、
// 域名不在白名单），这时连一条失败记录都不该写——否则"宿主拒绝一切"那一遍会用一次拒绝把用户的
// 历史改写成"失败"。

'use strict';

/** 确认一次变化需要连续几轮抓到同一个新内容（见 B）。 */
const CONFIRM_TICKS = 2;
/** 常驻帧挂上之后第一轮等多久：桌宠启动时正在同时挂帧、读插件目录，立刻发 8 个请求只是添堵。 */
const FIRST_DELAY_MS = 20000;
/**
 * 插件页写给常驻帧的"设置变了，重排计时器"信标：抓取的计时器住在桌宠进程里，而设置是在控制中心
 * 保存的，这个插件又没申请 `events`（那要用户另勾一项）。`storage.changed` 是 `storage` 权限
 * 自带的推送（手册 §7.2），于是"改了间隔马上生效"不需要新权限。
 */
const BEACON_KEY = 'cmd/reload';

let timer = null;
let cycleRunning = false;
let lastCycle = null;

function isHostRefusal(message) {
  return /未获权限|未授权|没有授权|不支持该方法|未启用|不在白名单|未声明的域名/.test(String(message || ''));
}

function errorText(err) {
  return String((err && err.message) || err || '未知错误');
}

/** 一轮抓取。**永不抛**：常驻帧里一个没人接的拒绝只是一条控制台里的墓碑。 */
async function runCycle() {
  if (cycleRunning) return { at: now(), ok: true, skipped: '上一轮还在跑' };
  cycleRunning = true;
  try {
    return await runCycleInner();
  } catch (err) {
    lastCycle = { at: now(), ok: false, error: errorText(err), results: [], changed: 0 };
    say(`监控暂停：${text(errorText(err), 140)}`);
    return lastCycle;
  } finally {
    cycleRunning = false;
  }
}

async function runCycleInner() {
  const at = now();
  const summary = { at, ok: true, error: '', results: [], changed: 0, announced: 0, skipped: '', quiet: false };

  // ① 设置。读不到（未授权/宿主拒绝）就整轮停下：连"要盯什么"都不知道的轮次不该发请求。
  try {
    await refreshConfig();
  } catch (err) {
    summary.ok = false;
    summary.error = errorText(err);
    summary.skipped = '设置读取失败';
    lastCycle = summary;
    say(summary.error);
    return summary;
  }

  const entries = parseEntries(cfg.entries);
  const targets = watchableEntries(entries);
  if (!targets.length) {
    // ② 未配置：一条请求都不发（连 storage.get 都不发——没有条目就没有要读写的东西）。
    summary.skipped = entries.length ? '条目都还没配好（看插件页里标成「未配置」的那几行）' : '还没有配置任何监控条目';
    lastCycle = summary;
    return summary;
  }
  if (!granted.has('storage') || !granted.has('net.fetch')) {
    summary.ok = false;
    summary.error = `未获授权：${granted.has('storage') ? 'net.fetch' : 'storage'}（监控不会运行）`;
    summary.skipped = '缺权限';
    lastCycle = summary;
    say(summary.error);
    return summary;
  }

  summary.quiet = isQuietAt(at);
  if (summary.quiet) say('免打扰时段：只更新快照，不弹气泡');

  for (const entry of targets) {
    let snap = null;
    try {
      snap = await loadSnapshot(entry.id);
    } catch (err) {
      // 私有目录都读不到：能力问题，整轮停下、一条数据都不写。
      summary.ok = false;
      summary.error = errorText(err);
      summary.skipped = '私有目录读不到';
      break;
    }
    const one = await captureOne(entry, snap, { at, quiet: summary.quiet });
    summary.results.push(one);
    if (one.status === 'changed' || one.status === 'changed-quietly') summary.changed += 1;
    if (one.announced) summary.announced += 1;
    if (one.status === 'blocked' && !summary.error) summary.error = one.error;
  }

  summary.ok = summary.ok && !summary.results.some((r) => r.status === 'blocked');
  lastCycle = summary;
  if (!summary.quiet && summary.changed) {
    say(summary.announced ? `这一轮报了 ${summary.announced} 处变化` : '这一轮有变化，但没能说出口（看下面的原因）');
  }
  return summary;
}

/** 一条：抓 → 取正文 → 比对。返回一条可读的结果（不抛）。 */
async function captureOne(entry, snap, ctx) {
  const base = { id: entry.id, name: entry.name, url: entry.url, selector: entry.selector, status: 'ok', error: '' };
  let response;
  try {
    // 有些站按 Accept 给不同的页面（移动版/纯文本），固定一套让比对稳定。
    response = await request('net.fetch', {
      method: 'GET',
      url: entry.url,
      headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    });
  } catch (err) {
    const message = errorText(err);
    if (isHostRefusal(message)) return { ...base, status: 'blocked', error: message };
    return noteFailure(entry, snap, ctx, `抓取失败：${message}`);
  }

  const status = Number(response && response.status) || 0;
  // 4xx/5xx 是站点这一侧的问题：旧快照必须留着（一次 500 不该抹掉"上次的价格"）。
  if (status === 0 || status >= 400) return noteFailure(entry, snap, ctx, `站点回了 HTTP ${status || '?'}`);
  // 8 MiB 之后宿主截断（手册 §6.10）：截断的正文照样比对，只把这件事带在结果里——写进 error
  // 会让状态永远显示失败。
  if (response && response.truncated) base.truncated = true;

  const got = extractContent(String((response && response.body) || ''), entry.selector);
  if (!got.ok) return noteFailure(entry, snap, ctx, got.reason);
  return applyContent(entry, snap, ctx, got.text);
}

/**
 * 一轮抓失败：**保留**旧的指纹与摘录，只记下"什么时候试过、为什么没成"。`lastOkAt` 不动，界面
 * 因此还能说"上次成功是 23 分钟前"。首轮就失败时没有基线，这条记录也写下来（`loadSnapshot` 认
 * `at` 不认 `hash`），于是界面显示「失败」而不是装作没抓过。
 */
async function noteFailure(entry, snap, ctx, reason) {
  const previous = snap && typeof snap === 'object' ? snap : {};
  const record = {
    id: entry.id, name: entry.name, url: entry.url, selector: entry.selector,
    hash: previous.hash || '', excerpt: previous.excerpt || '', pending: previous.pending || null,
    lastOkAt: Number(previous.lastOkAt) || 0, at: ctx.at, ok: false, error: text(reason, 200),
  };
  try {
    await saveSnapshot(record);
  } catch {
    // 写不进去不能让这一轮崩掉；下一轮还会再试。
  }
  return { ...record, status: 'failed' };
}

/** 抓到了：首次建基线 / 没变 / 候选 / 确认（见 A、B）。 */
async function applyContent(entry, snap, ctx, rawText) {
  const hash = hashText(rawText);
  const nowExcerpt = excerpt(rawText, EXCERPT_CHARS);
  const base = {
    id: entry.id, name: entry.name, url: entry.url, selector: entry.selector,
    at: ctx.at, ok: true, error: '', lastOkAt: ctx.at,
  };
  const said = (status, extra) => ({ id: entry.id, name: entry.name, status, ...extra });

  // A. 首次抓取：只存快照，一条气泡都不发。
  if (!snap || !snap.hash) {
    await saveSnapshot({ ...base, hash, excerpt: nowExcerpt, pending: null });
    return said('baseline');
  }
  // 没变：顺手清掉可能存在的候选（A→B→A 里的那个 A），基线不动，一声不响。
  if (snap.hash === hash) {
    await saveSnapshot({ ...base, hash, excerpt: nowExcerpt, pending: null });
    return said('same');
  }
  // 变了：先当候选，同一份"新内容"要连续 CONFIRM_TICKS 轮都抓到才算数（B）。
  const seen = snap.pending && snap.pending.hash === hash ? Number(snap.pending.count) || 1 : 0;
  if (seen + 1 < CONFIRM_TICKS) {
    await saveSnapshot({ ...snap, ...base, pending: { hash, count: seen + 1, excerpt: nowExcerpt } });
    return said('pending', { note: '看到新内容，等下一轮确认' });
  }
  // 确认：更新基线 → 记历史（"哪一段变了"）→ 说一句（免打扰时不说话，但快照照更）。
  const before = String(snap.excerpt || '');
  const snippet = snippetAround(before, nowExcerpt);
  await saveSnapshot({ ...base, hash, excerpt: nowExcerpt, pending: null });
  await rememberChange({
    at: ctx.at, id: entry.id, name: entry.name, url: entry.url,
    before: excerpt(before, EXCERPT_CHARS), after: nowExcerpt, snippet, quiet: Boolean(ctx.quiet),
  });
  if (ctx.quiet) return said('changed-quietly', { snippet, announced: false });
  return said('changed', { snippet, announced: await announce(entry, snippet) });
}

/** 记一条变化。历史写不进去不影响播报（它是给人看的，不是状态机的一部分）。 */
async function rememberChange(change) {
  try {
    await saveHistory(pushChange(await loadHistory(), change));
  } catch {
    // 忽略：下一轮会重新写。
  }
}

/** 让桌宠说一句。只在桌宠的常驻帧里可能成功（bubble.say 不在控制中心的服务表里）。 */
async function announce(entry, snippet) {
  if (!granted.has('pet.bubble') || !hostServes('bubble.say')) return false;
  try {
    await request('bubble.say', { text: bubbleText(entry.name, snippet) });
    return true;
  } catch (err) {
    say(`气泡没弹出来：${text(errorText(err), 120)}`);
    return false;
  }
}

function stopTimer() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

/**
 * 排下一轮：一次性 setTimeout 自己续一次，而不是 setInterval——后者在创建那一刻就把周期定死了，
 * 而用户随时可能改间隔。一进来先 `stopTimer()`，所以旧计时器绝不会留下。
 */
function schedule(firstDelayMs) {
  stopTimer();
  const interval = intervalMs();
  const first = Number.isFinite(firstDelayMs) && firstDelayMs >= 0 ? firstDelayMs : interval;
  timer = setTimeout(() => {
    timer = null;
    void runCycle().catch(() => {}).then(() => schedule());
  }, first);
  return { intervalMs: interval, firstDelayMs: first, timerId: timer };
}

/** 设置变了：重读并按新值重排（"改了间隔立刻生效"的一半，另一半是每轮自己重读设置兜底）。 */
async function reloadAndReschedule() {
  try {
    await refreshConfig();
  } catch (err) {
    const message = errorText(err);
    say(message);
    return { ok: false, error: message };
  }
  // 旧计时器先清掉：用户清空条目、或把间隔改小了，都不该让上一条按旧值继续抓。
  stopTimer();
  if (!watchableEntries(parseEntries(cfg.entries)).length) {
    say('没有可抓的条目了：计时器已停，配好之后会重新开始');
    return { ok: true, stopped: true, intervalMs: intervalMs() };
  }
  const info = schedule();
  say(`设置已更新：每 ${Math.round(info.intervalMs / 60000)} 分钟抓一次`);
  return { ok: true, ...info };
}

/** 插件页保存完设置之后写一次信标（见 BEACON_KEY）。 */
async function writeReloadBeacon() {
  try {
    await request('storage.set', { key: BEACON_KEY, value: String(now()) });
    return true;
  } catch {
    return false;
  }
}

/** 收到 `storage.changed` 时该做什么：只认信标（快照/历史的变动与计时器无关）。 */
function onStorageChanged(key) {
  if (String(key === undefined || key === null ? '' : key) !== BEACON_KEY) return false;
  void reloadAndReschedule().catch(() => {});
  return true;
}

function watchState() {
  return { timerId: timer, intervalMs: intervalMs(), running: cycleRunning, last: lastCycle, cfg: { ...cfg }, cfgError };
}
