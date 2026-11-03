// lib/ics.js —— 够用的 iCalendar 解析与重复展开
//
// 为什么自己写而不是引库：插件不许带第三方库、不许引 CDN，而这件事**没有服务端可依赖**
// （用户填的是一条 .ics 链接）。所以只做"够用"的那一小块：DTSTART / DTEND / SUMMARY /
// LOCATION / UID / RRULE / STATUS，重复只认 FREQ=DAILY / WEEKLY（带 INTERVAL / COUNT / UNTIL）。
// 宁可少画一场，也不要画错一场：认不出的行忽略，认不出的时区退回本机时区。
'use strict';

const ICS_DAY_MS = 86400000;

// 时区偏移靠 Intl —— 宿主和 Node 都自带它，那是唯一不用打包 tz 数据表的办法。
const icsZoneFormatters = new Map();

/**
 * 某个瞬间在某个时区的偏移（毫秒，正数=东边）。做法：把"这个瞬间在该时区的墙上时间"当 UTC
 * 读出来再相减。认不出的时区返回 null，调用方退回"按本机时区读"——那至少不会偏一天。
 */
function icsZoneOffset(utcMs, zone) {
  let fmt = icsZoneFormatters.get(zone);
  if (fmt === undefined) {
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    } catch {
      fmt = null; // 拼错的，或用了 Windows 时区名
    }
    icsZoneFormatters.set(zone, fmt);
  }
  if (!fmt) return null;
  const parts = fmt.formatToParts(new Date(Math.floor(utcMs / 1000) * 1000));
  const pick = (type) => Number((parts.find((part) => part.type === type) || {}).value) || 0;
  const asUtc = Date.UTC(pick('year'), pick('month') - 1, pick('day'), pick('hour'), pick('minute'), pick('second'));
  return asUtc - utcMs;
}

/** 墙上时间（{y,mo,d,h,mi,s}）+ 时区 → 绝对时刻。夏令时边界要算第二遍。 */
function icsWallToInstant(wall, zone) {
  const asLocal = new Date(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s || 0).getTime();
  if (!zone) return asLocal; // 浮动时间：按本机时区读
  const naive = Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s || 0);
  const first = icsZoneOffset(naive, zone);
  if (first === null) return asLocal;
  let real = naive - first;
  const second = icsZoneOffset(real, zone);
  if (second !== null && second !== first) real = naive - second; // 被 DST 折叠掉的那一小时
  return real;
}

/** "20261105" / "20261105T140000" / "…Z" → {wall, allDay, utc, zone}；认不出返回 null。 */
function icsDateValue(value, params) {
  const text = String(value || '').trim();
  if (/^\d{8}$/.test(text)) {
    const wall = { y: +text.slice(0, 4), mo: +text.slice(4, 6), d: +text.slice(6, 8), h: 0, mi: 0, s: 0 };
    return { wall, allDay: true, utc: false, zone: null };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(text);
  if (!m) return null;
  const wall = { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6] };
  const utc = m[7] === 'Z';
  return { wall, allDay: false, utc, zone: utc ? null : String(params.TZID || '') || null };
}

function icsInstantOf(info) {
  if (info.allDay) return new Date(info.wall.y, info.wall.mo - 1, info.wall.d).getTime();
  const w = info.wall;
  if (info.utc) return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  return icsWallToInstant(w, info.zone);
}

/** RRULE 里我们认的那几个键。UNTIL 按 RFC 当 UTC 读（不带 Z 的写法是坏数据，不当真）。 */
function icsParseRule(value) {
  const rule = { freq: '', interval: 1, count: 0, until: 0 };
  for (const chunk of String(value || '').split(';')) {
    const eq = chunk.indexOf('=');
    if (eq <= 0) continue;
    const key = chunk.slice(0, eq).trim().toUpperCase();
    const raw = chunk.slice(eq + 1).trim();
    if (key === 'FREQ') rule.freq = raw.toUpperCase();
    else if (key === 'INTERVAL') rule.interval = clampInt(raw, 1, 366, 1);
    else if (key === 'COUNT') rule.count = clampInt(raw, 0, 4000, 0);
    else if (key === 'UNTIL') {
      const info = icsDateValue(raw, {});
      if (!info) continue;
      const w = info.wall;
      rule.until = info.allDay
        ? Date.UTC(w.y, w.mo - 1, w.d, 23, 59, 59)
        : Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
    }
  }
  return rule;
}

/** 加天数只动日历日（用 UTC 的日历做算术，避开本机时区的 DST）。 */
function icsAddDays(wall, days) {
  const shifted = new Date(Date.UTC(wall.y, wall.mo - 1, wall.d + days));
  return { y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth() + 1, d: shifted.getUTCDate(), h: wall.h, mi: wall.mi, s: wall.s };
}

/** 第 index 次发生（0 = DTSTART 本身）。按**事件自己的时区**推进墙上时间，跨 DST 也对。 */
function icsOccurrenceInstant(event, index) {
  if (index === 0) return event.start;
  const stepDays = (event.rule.interval || 1) * (event.rule.freq === 'WEEKLY' ? 7 : 1);
  const wall = icsAddDays(event.wall, index * stepDays);
  if (event.allDay) return new Date(wall.y, wall.mo - 1, wall.d).getTime();
  if (event.utc) return Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s);
  return icsWallToInstant(wall, event.zone);
}

function icsBuildEvent(fields) {
  if (!fields.start || String(fields.status || '') === 'CANCELLED') return null;
  const start = icsInstantOf(fields.start);
  const rawEnd = fields.end ? icsInstantOf(fields.end) : 0;
  const end = rawEnd > start ? rawEnd : start + (fields.start.allDay ? ICS_DAY_MS : 0);
  const title = String(fields.title || '').replace(/\\,/g, ',').replace(/\\n/gi, ' ').trim();
  const rule = fields.rule ? icsParseRule(fields.rule) : null;
  return {
    uid: String(fields.uid || 'ics-' + start + '-' + title.slice(0, 12)),
    title: title || '（无标题）',
    location: String(fields.location || '').replace(/\\,/g, ',').trim(),
    start, end, allDay: Boolean(fields.start.allDay),
    wall: fields.start.wall, zone: fields.start.zone, utc: fields.start.utc,
    rule: rule && (rule.freq === 'DAILY' || rule.freq === 'WEEKLY') ? rule : null,
  };
}

/** 解析一整份 .ics。返回按 start 排序的事件（重复的只留一条 + 规则）。 */
function icsParse(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let fields = null;
  for (const line of lines) {
    if (/^BEGIN:VEVENT\s*$/i.test(line)) { fields = {}; continue; }
    if (/^END:VEVENT\s*$/i.test(line)) {
      const event = fields ? icsBuildEvent(fields) : null;
      if (event) events.push(event);
      fields = null;
      continue;
    }
    if (!fields) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const bits = line.slice(0, colon).split(';');
    const name = bits[0].trim().toUpperCase();
    const value = line.slice(colon + 1);
    const params = {};
    for (const bit of bits.slice(1)) {
      const eq = bit.indexOf('=');
      if (eq > 0) params[bit.slice(0, eq).trim().toUpperCase()] = bit.slice(eq + 1).replace(/^"|"$/g, '').trim();
    }
    if (name === 'DTSTART') fields.start = icsDateValue(value, params);
    else if (name === 'DTEND') fields.end = icsDateValue(value, params);
    else if (name === 'SUMMARY') fields.title = value;
    else if (name === 'LOCATION') fields.location = value;
    else if (name === 'UID') fields.uid = value.trim();
    else if (name === 'RRULE') fields.rule = value;
    else if (name === 'STATUS') fields.status = value.trim().toUpperCase();
  }
  events.sort((a, b) => a.start - b.start || String(a.title).localeCompare(String(b.title)));
  return events;
}

function icsSnapshot(event, start) {
  return {
    uid: event.uid + '@' + start, title: event.title, location: event.location, start,
    end: start + (event.end - event.start), allDay: event.allDay, recurring: start !== event.start,
  };
}

/**
 * 把事件展开成 [fromMs, toMs) 里的"这一次一次的发生"，按时间排序。
 * 一天一条的重复如果从 2019 年就开始了，从 index 0 硬数要空转几千次，所以先按步长估算起点
 * 再往前退一格——步长只用来定位，真正的时刻仍按墙上时间重算。
 */
function icsExpand(events, fromMs, toMs, maxCount) {
  const limit = Number.isFinite(maxCount) && maxCount > 0 ? maxCount : 200;
  const out = [];
  if (!(toMs > fromMs)) return out;
  for (const event of events) {
    if (!event.rule) {
      if (event.end > fromMs && event.start < toMs) out.push(icsSnapshot(event, event.start));
      continue;
    }
    const stepMs = (event.rule.interval || 1) * (event.rule.freq === 'WEEKLY' ? 7 : 1) * ICS_DAY_MS;
    let index = fromMs > event.start ? Math.max(0, Math.floor((fromMs - event.start) / stepMs) - 1) : 0;
    for (let guard = 0; guard < 400 && out.length < limit; guard += 1) {
      if (event.rule.count && index >= event.rule.count) break;
      const start = icsOccurrenceInstant(event, index);
      if (event.rule.until && start > event.rule.until) break;
      if (start >= toMs) break;
      if (start + (event.end - event.start) > fromMs) out.push(icsSnapshot(event, start));
      index += 1;
    }
    if (out.length >= limit) break;
  }
  out.sort((a, b) => a.start - b.start || String(a.title).localeCompare(String(b.title)));
  return out;
}
