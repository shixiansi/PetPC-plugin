// lib/feed.js —— 订阅地址、抓取、缓存、"今天/下一场/一段区间"，以及会前提醒
//
// 三条定死的规则：① 断网时唯一的数据来源是 storage 里那份**原始 ICS 文本**（外加 fetchedAt），
// 所以抓成功的第一件事是整份写进 feed/ics + feed/meta，而不是只留解析结果；② 写的永远是整份
// 快照（不是读-改-写）：两个帧同时抓最多让一份快照被覆盖，不会写坏缓存（§6.3）；③ 界面必须
// 说清这是不是缓存——feedState.fresh 只在本次会话真的抓成功过时为真。
// 提醒是钟表类定时器（§3.9 的例外）：20 秒一拍判"距开始还剩不到 N 分钟"，1 秒一拍只是多 20 倍唤醒。
'use strict';

const KEY_FEED_ICS = 'feed/ics';
const KEY_FEED_META = 'feed/meta';
const KEY_REMINDED = 'feed/reminded';
const MAX_CACHE_CHARS = 1000000; // 单值上限 1 MiB（§6.3），超了就只留在内存里
const REFRESH_AFTER_MS = 20 * 60 * 1000; // 日历一天变不了几次，20 分钟足够
const REMIND_KEEP_MS = 2 * ICS_DAY_MS;

const feedState = {
  text: '', fetchedAt: 0, url: '',
  error: '', // 最近一次抓取的失败原因：有它的时候界面写"这次刷新失败"
  fresh: false, // 本次会话抓成功过（= 不是缓存）
  cacheNote: '', // 缓存没写成的说明
  eventCount: 0,
};
let feedEvents = [];

/** webcal:// 是日历应用给出的订阅协议，浏览器与宿主都发不出去；换成 https 省用户一步。 */
function normalizeFeedUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (/^webcal:\/\//i.test(text)) return 'https://' + text.slice('webcal://'.length);
  return /^https?:\/\/\S+$/i.test(text) ? text : '';
}

function feedConfiguredRaw() { return String(cfgText('calendarUrl', '') || '').trim(); }

function feedParsed() {
  try {
    feedEvents = feedState.text ? icsParse(feedState.text) : [];
  } catch {
    feedEvents = [];
  }
  feedState.eventCount = feedEvents.length;
}

/** 把磁盘上的缓存读进来。它同时是"断网时能出今天有什么"的全部依据。 */
async function feedLoadCache() {
  if (!can('storage')) return;
  const text = await readKey(KEY_FEED_ICS, '');
  const meta = jsonOr(await readKey(KEY_FEED_META, ''), {});
  feedState.text = typeof text === 'string' ? text : '';
  feedState.fetchedAt = Number(meta.fetchedAt) || 0;
  feedState.url = String(meta.url || '');
  feedParsed();
}

async function feedSaveCache() {
  if (!can('storage')) return;
  if (feedState.text.length > MAX_CACHE_CHARS) {
    feedState.cacheNote = '订阅太大（超过 1 MiB），没写进本地缓存：断网时就没有兜底了';
    return;
  }
  const meta = JSON.stringify({ fetchedAt: feedState.fetchedAt, url: feedState.url, events: feedState.eventCount });
  const okIcs = await writeKey(KEY_FEED_ICS, feedState.text);
  const okMeta = await writeKey(KEY_FEED_META, meta);
  feedState.cacheNote = okIcs && okMeta ? '' : '缓存没写成（storage 拒绝了这次写入）';
}

/** 抓一次。返回 {ok, reason, error?}——**不抛**：调用方是定时器与按钮，失败要落在界面上。 */
async function feedRefresh() {
  const raw = feedConfiguredRaw();
  if (!raw) return { ok: false, reason: 'unconfigured' };
  const url = normalizeFeedUrl(raw);
  if (!url) return { ok: false, reason: 'bad-url' };
  if (!can('net.fetch')) return { ok: false, reason: 'no-net' };
  if (!can('storage')) return { ok: false, reason: 'no-storage' };
  let res;
  try {
    res = await request('net.fetch', { method: 'GET', url, headers: { accept: 'text/calendar' } });
  } catch (err) {
    feedState.error = errorText(err);
    return { ok: false, reason: 'fetch', error: feedState.error };
  }
  const status = Number(res && res.status) || 0;
  if (status < 200 || status >= 300) {
    feedState.error = '日历地址回了 HTTP ' + (status || '（没有状态码）');
    return { ok: false, reason: 'status', error: feedState.error };
  }
  const body = String((res && res.body) || '');
  if (!body.trim()) {
    feedState.error = '日历地址回了一个空文档';
    return { ok: false, reason: 'empty', error: feedState.error };
  }
  if (!/BEGIN:VCALENDAR/i.test(body)) {
    feedState.error = '回来的不是 .ics 日历（贴的是日历网页地址吗？要「导出 / 订阅」的链接）';
    return { ok: false, reason: 'not-ics', error: feedState.error };
  }
  feedState.text = body;
  feedState.fetchedAt = Date.now();
  feedState.url = url;
  feedState.error = '';
  feedState.fresh = true;
  feedParsed();
  await feedSaveCache();
  return { ok: true, eventCount: feedState.eventCount, truncated: Boolean(res && res.truncated) };
}

function feedStale(nowMs) {
  return !feedState.fetchedAt || nowMs - feedState.fetchedAt > REFRESH_AFTER_MS;
}

/** 界面上那行"数据有多新"。缓存必须自己说出来，不能假装是刚拉的。 */
function feedFreshnessLabel(nowMs) {
  const ref = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (feedState.error) {
    return feedState.fetchedAt
      ? '缓存 · ' + ageText(feedState.fetchedAt, ref) + '（这次刷新失败：' + feedState.error + '）'
      : '还没拉到日程：' + feedState.error;
  }
  return feedState.fetchedAt ? ageText(feedState.fetchedAt, ref) + '更新过' : '还没拉到日程';
}

function feedOccurrences(fromMs, toMs, maxCount) { return icsExpand(feedEvents, fromMs, toMs, maxCount); }

/** 今天（本机日历日）的日程，含跨零点的与全天的。 */
function feedToday(nowMs) {
  const dayStart = localMidnight(nowMs);
  return feedOccurrences(dayStart, dayStart + ICS_DAY_MS, 80);
}

/** 下一场：还没结束的最早那一场（正在进行的也算，start 会告诉你它已经开始了）。 */
function feedNext(nowMs) {
  for (const event of feedOccurrences(nowMs, nowMs + 30 * ICS_DAY_MS, 60)) {
    if (event.end > nowMs) return event;
  }
  return null;
}

/** [from, to) 里的日程。参数接受 epoch 毫秒、ISO 字符串或 Date。 */
function feedAgenda(from, to, nowMs) {
  const start = toMs(from, localMidnight(Number.isFinite(nowMs) ? nowMs : Date.now()));
  const capped = Math.min(toMs(to, start + 7 * ICS_DAY_MS), start + 400 * ICS_DAY_MS);
  return capped > start ? feedOccurrences(start, capped, 200) : [];
}

function toMs(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return asNumber;
  }
  return fallback;
}

/** 喂给别的插件的那份形状：start/end 是 epoch 毫秒，另附人读的两行。 */
function feedEventPayload(event) {
  return {
    uid: event.uid, title: event.title, start: event.start, end: event.end,
    allDay: Boolean(event.allDay), location: event.location || '',
    startText: event.allDay ? '全天' : hm(event.start),
    endText: event.allDay ? '' : hm(event.end),
    recurring: Boolean(event.recurring),
  };
}

function feedMetaForCall(nowMs) {
  return { fetchedAt: feedState.fetchedAt, fromCache: !feedState.fresh, note: feedFreshnessLabel(nowMs) };
}

//
// "只发一次"靠两样东西：内存里的 uid→时刻表（同一会话内），以及 storage 里的 feed/reminded
// （重启之后不重复说）。**先记再发**：发失败也记，否则一个被拒的 bubble.say 会变成每一拍
// 都撞一次同一道墙。

const reminderState = { map: {} };
/** 说过一次之后就不再自动弹卡片：那个位置同一时刻只能有一个（气泡或浮层面）。 */
let cardSuppressUntil = 0;

async function reminderLoad() {
  const parsed = jsonOr(await readKey(KEY_REMINDED, ''), {});
  reminderState.map = Array.isArray(parsed) ? {} : parsed;
}

/** 该提醒的那些：会前 N 分钟之内、还没开始、整天的不算（全天的"会前"没有意义）。 */
function reminderDue(nowMs) {
  if (!cfgBool('remindEnabled', true)) return [];
  const horizon = nowMs + cfgNum('remindMinutes', 1, 120, 10) * 60000;
  const due = [];
  for (const event of feedOccurrences(nowMs, horizon + 1000, 40)) {
    if (event.allDay || event.start <= nowMs || event.start > horizon) continue;
    if (!reminderState.map[event.uid]) due.push(event);
  }
  return due;
}

/** 气泡里那句话。说清"还有多久"和"是什么"，别只写"你有一个会议"。 */
function reminderText(event, nowMs) {
  const minutes = Math.max(1, Math.round((event.start - nowMs) / 60000));
  const where = event.location ? '（' + event.location + '）' : '';
  return '还有 ' + minutes + ' 分钟到「' + event.title + '」' + where + '，' + hm(event.start) + ' 开始。';
}

/**
 * 一拍：把到点的说出去，然后落盘。它（以及调用它的 tick）**不许问宿主的盘**：没有
 * config.get、没有 storage.get，只有内存里的事件与提醒账本——定时器里读盘就是 §7 的那种轮询。
 */
async function reminderTick(nowMs) {
  const ref = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (!can('pet.bubble') || !serves('bubble.say')) return 0;
  const due = reminderDue(ref);
  if (!due.length) return 0;
  let fired = 0;
  for (const event of due) {
    reminderState.map[event.uid] = ref;
    cardSuppressUntil = Math.max(cardSuppressUntil, event.start);
    try {
      await request('bubble.say', { text: reminderText(event, ref) });
      fired += 1;
    } catch {
    }
  }
  const cutoff = ref - REMIND_KEEP_MS;
  const kept = {};
  for (const uid of Object.keys(reminderState.map)) {
    if (Number(reminderState.map[uid]) >= cutoff) kept[uid] = reminderState.map[uid];
  }
  reminderState.map = kept;
  await writeKey(KEY_REMINDED, JSON.stringify(kept));
  return fired;
}

/**
 * 该不该现在把浮层面那块卡片摆出来：下一场在 30 分钟内，而且还没提醒过。
 * 提醒过就不再自动弹——提醒是一句话，卡片是一块矩形，那个位置同一时刻只放一个。
 */
function reminderCardTarget(nowMs) {
  if (!can('pet.surface') || !serves('surface.show')) return null;
  const ref = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (ref < cardSuppressUntil) return null;
  for (const event of feedOccurrences(ref, ref + 30 * 60000, 20)) {
    if (event.allDay || event.end <= ref) continue;
    return reminderState.map[event.uid] ? null : event;
  }
  return null;
}
