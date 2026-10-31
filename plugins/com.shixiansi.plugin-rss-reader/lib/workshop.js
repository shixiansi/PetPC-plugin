// lib/workshop.js —— 插件页那一面：订阅源管理 + 立刻抓一次 + 最近晨报
//
// 与 websearch/screen-vision 的 workshop 同一条纪律：控制中心不服务 net.fetch /
// plugin.call / bubble（手册 §9），所以「立刻抓一次」按钮在这一页是禁用的（不是点了
// 报错）；只读的部分（源列表、最近晨报）照常显示。真正的抓取活在桌宠那边的常驻帧。

'use strict';

let fetching = false;

function el(tag, className, body) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (body !== undefined) node.textContent = body;
  return node;
}

function fmtTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const d = new Date(n);
  const pad = (x) => `${x}`.padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function setFetching(on) {
  fetching = on;
  if (els.fetchNow) {
    els.fetchNow.disabled = on || !granted.has('net.fetch') || !granted.has('plugin.call');
    els.fetchNow.textContent = on ? '抓取中…' : '立刻抓一次';
  }
  if (on && els.digest) els.digest.textContent = '正在抓取订阅源、总结、播报…';
}

/** 「立刻抓一次」（面板与插件页共用 handleFetchNow）。 */
async function runFetchNow() {
  if (fetching) return;
  setFetching(true);
  say('抓取中…');
  try {
    const out = await handleFetchNow();
    if (els.digest) {
      els.digest.textContent = out.headline || '（空）';
      els.digestTime.textContent = `${fmtTime(out.at)} · 新内容 ${out.freshCount} 条`;
    }
    say(out.spoken ? '已总结并语音播报' : '已总结（语音没播：未配置或失败）');
    void renderFeeds();
  } catch (err) {
    say(text(err && err.message ? err.message : err, 200));
    if (els.digest) els.digest.textContent = '';
  } finally {
    setFetching(false);
  }
}

/** 添加一个订阅源：清洗 → 记入列表 → 立刻试抓一次（失败的源当场就讲清楚）。 */
async function addFeed() {
  if (!els.feedUrl) return;
  const url = String(els.feedUrl.value || '').trim();
  try {
    const cleaned = cleanFeedUrl(url);
    const list = await loadFeedList();
    if (list.some((f) => f.url === cleaned)) {
      say('这个源已经在列表里了');
      return;
    }
    list.push({ url: cleaned, addedAt: now(), title: '', lastStatus: '', lastError: '' });
    await saveFeedList(list);
    els.feedUrl.value = '';
    say('已添加，正在试抓一次…');
    void renderFeeds();
    try {
      const { parsed } = await fetchAndRecord(cleaned);
      say(`已添加：${parsed.title || cleaned}（${parsed.items.length} 条）`);
    } catch (err) {
      say(`添加了，但试抓失败：${text(err && err.message ? err.message : err, 140)}`);
    }
    void renderFeeds();
  } catch (err) {
    say(text(err && err.message ? err.message : err, 160));
  }
}

/** 删除一个订阅源（它的已读记录一并清掉，重加不会整源被跳过）。 */
async function removeFeed(url) {
  const list = await loadFeedList();
  await saveFeedList(list.filter((f) => f.url !== url));
  const seen = await loadSeen();
  const next = {};
  for (const [key, value] of Object.entries(seen)) {
    if (!key.startsWith(`${url}\n`)) next[key] = value;
  }
  await saveSeen(next);
  void renderFeeds();
  say('已删除');
}

/** 源列表 + 每源状态。 */
async function renderFeeds() {
  if (!els.feedList) return;
  const list = await loadFeedList();
  els.feedList.textContent = '';
  if (!list.length) {
    const empty = el('p', 'muted', '还没有订阅源。在设置里填（每行一个），或在这里加。');
    els.feedList.append(empty);
    return;
  }
  for (const feed of list) {
    const row = el('div', 'feed');
    const head = el('div', 'feed-head');
    head.append(el('span', 'feed-title', feed.title || feed.url));
    const remove = el('button', 'btn soft feed-remove', '删除');
    remove.type = 'button';
    remove.addEventListener('click', () => void removeFeed(feed.url).catch(() => {}));
    head.append(remove);
    row.append(head);
    const bits = [];
    if (feed.lastStatus === 'ok') bits.push(`正常 · ${feed.itemCount ?? '?'} 条 · ${fmtTime(feed.lastFetchedAt)}`);
    else if (feed.lastStatus === 'error') bits.push(`出错：${feed.lastError}`);
    else bits.push('还没抓过');
    row.append(el('p', 'feed-meta', bits.join(' · ')));
    els.feedList.append(row);
  }
}

/** 最近晨报。 */
async function renderDigest() {
  if (!els.digest) return;
  const digest = await loadLastDigest();
  if (!digest || !digest.headline) return;
  els.digest.textContent = digest.headline;
  if (els.digestTime) els.digestTime.textContent = fmtTime(digest.at);
}
