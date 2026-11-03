// lib/ics.js —— ICS 的纯解析层：不碰 DOM、不碰宿主桥、不看时钟。
//
// 为什么是经典 script 而不是 module：panel.html 用 <script src> 按序加载（点歌插件的同一型），
// app.js 直接读全局 CalendarICS；测试用 new Function(source) 就能拿到同一份纯函数。
//
// 为什么"现在几点 / 本地在哪个时区"是参数而不是自己取：同一份解析要在测试里被注入
// "今天 = 2026-01-01"，也要能回答"别的时区的日程换到本地是几点"。所有时间入参都是
// epoch 毫秒 + 本地偏移（分钟），这个文件里没有一处取当前时间的调用。
//
// 支持的形态（手册要求"至少"）：VCALENDAR/VEVENT/VTIMEZONE 嵌套（VALARM 跳过）、
// DTSTART/DTEND 的 DATE 与 DATE-TIME、VALUE=DATE、带 Z 的 UTC、TZID（VTIMEZONE 固定偏移，
// 兜底走 Intl 的 IANA 时区表）、RRULE 的 FREQ=DAILY/WEEKLY/MONTHLY + INTERVAL + COUNT/UNTIL
// （WEEKLY 认 BYDAY，MONTHLY 认 BYMONTHDAY）。解析不了的事件跳过并计数，绝不抛错。

'use strict';

(function () {
  const MS_MIN = 60000;
  const MS_DAY = 86400000;
  const MAX_OCC = 400;      // 单个事件在一次展开里最多留下的发生数：防一条病态 RRULE 撑爆返回值
  const MAX_STEPS = 40000;  // 迭代步数上限（约 100 年的逐日）：跨世纪的老日历也要能走到今天
  const WEEKDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

  // --- 文本 -----------------------------------------------------------------

  // RFC 5545 的长行以 CRLF+空格续行；先并回一行再解析，否则 TZID 这类参数会被腰斩。
  function unfold(text) {
    return String(text || '').replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r\n|\n/);
  }

  function unescapeText(v) {
    return String(v || '')
      .replace(/\\n/gi, '\n')
      .replace(/\\,/g, ',')
      .replace(/\\;/g, ';')
      .replace(/\\\\/g, '\\')
      .trim();
  }

  // 名字与值在第一个不在引号里的冒号处分家；分号后是参数（TZID=… / VALUE=DATE）。
  function parseProp(line) {
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') inQuote = !inQuote;
      else if (c === ':' && !inQuote) {
        const segs = line.slice(0, i).split(';');
        const params = {};
        for (let k = 1; k < segs.length; k++) {
          const eq = segs[k].indexOf('=');
          if (eq > 0) params[segs[k].slice(0, eq).toUpperCase()] = segs[k].slice(eq + 1).replace(/^"|"$/g, '');
        }
        return { name: segs[0].toUpperCase(), params, value: line.slice(i + 1) };
      }
    }
    return null;
  }

  // --- 时间 -----------------------------------------------------------------

  // +0800 / -0530 → 分钟。拿不到就 null（调用方据此跳过这个事件）。
  function offsetToMin(s) {
    const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(String(s || '').trim());
    if (!m) return null;
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(m[4]) / 60 : 0));
  }

  function parseWall(v) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/.exec(String(v || '').trim());
    if (!m) return null;
    return { y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0) };
  }

  // 墙钟按 UTC 语义取毫秒（"naive"毫秒）：它不是时刻，只是给时区换算当输入。
  function wallUtcMs(w) {
    return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  }

  function addDays(w, n) {
    const dt = new Date(Date.UTC(w.y, w.mo - 1, w.d + n));
    return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate(), h: w.h, mi: w.mi, s: w.s };
  }

  function addMonths(w, n) {
    const dt = new Date(Date.UTC(w.y, w.mo - 1 + n, 1, w.h, w.mi, w.s));
    const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
    return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: Math.min(w.d, last), h: w.h, mi: w.mi, s: w.s };
  }

  // VTIMEZONE 覆盖不了的 TZID，退到 Intl 的 IANA 表。固定偏移的时区（Asia/Shanghai、
  // Asia/Tokyo）一轮就收敛；带夏令时的也能算对。时区名不认识 → null → 事件被跳过。
  const intlCache = new Map();
  function offsetViaIntl(tzid, naiveMs) {
    let fmt = intlCache.get(tzid);
    if (fmt === null) return null;
    if (!fmt) {
      try {
        fmt = new Intl.DateTimeFormat('en-US', {
          timeZone: tzid, hourCycle: 'h23',
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit',
        });
        intlCache.set(tzid, fmt);
      } catch {
        intlCache.set(tzid, null);
        return null;
      }
    }
    // offset(t) = asUTC(墙钟(t)) - t。迭代两轮：第一轮的误差来自夏令时边界，第二轮已收敛。
    let t = naiveMs;
    let off = 0;
    for (let i = 0; i < 2; i++) {
      const parts = {};
      for (const p of fmt.formatToParts(new Date(t))) {
        if (p.type !== 'literal') parts[p.type] = Number(p.value);
      }
      const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
      off = asUtc - t;
      t = naiveMs - off;
    }
    return Math.round(off / MS_MIN);
  }

  // VTIMEZONE 的规则匹配按"观察时刻 ≤ 事件墙钟"取最后一条——固定偏移的时区只有一条，天然命中。
  function zoneOffsetMin(zones, tzid, naiveMs) {
    const rules = zones && zones.get ? zones.get(tzid) : null;
    if (rules && rules.length) {
      let pick = null;
      for (const r of rules) {
        if (r.dtstartMs != null && r.dtstartMs <= naiveMs) pick = r;
      }
      if (!pick) pick = rules[0];
      return pick.offsetToMin != null ? pick.offsetToMin : pick.offsetFromMin;
    }
    return offsetViaIntl(tzid, naiveMs);
  }

  // DTSTART/DTEND 的一个属性值 → { allDay, wall, utcMs, tzid, floating }。
  // utcMs 为 null 表示"展开时才算"（全天的本地零点 / 浮动时间的本地钟）。
  function resolveDate(value, params, zones) {
    const v = String(value || '').trim();
    const w = parseWall(v);
    if (!w) return null;
    const isDate = (params && params.VALUE === 'DATE') || /^\d{8}$/.test(v);
    if (isDate) return { allDay: true, wall: w, utcMs: null, tzid: '', floating: false };
    if (/[zZ]$/.test(v)) return { allDay: false, wall: w, utcMs: wallUtcMs(w), tzid: 'UTC', floating: false };
    const tzid = params && params.TZID ? params.TZID : '';
    if (tzid) {
      const off = zoneOffsetMin(zones, tzid, wallUtcMs(w));
      if (off == null) return null;
      return { allDay: false, wall: w, utcMs: wallUtcMs(w) - off * MS_MIN, tzid, floating: false };
    }
    // 浮动时间（无 Z 也无 TZID）：按查看者的本地钟。共享日历里很少见，但出现时不能崩。
    return { allDay: false, wall: w, utcMs: null, tzid: '', floating: true };
  }

  // --- RRULE ----------------------------------------------------------------

  // 认不出的 FREQ 返回 null：调用方保留第一次发生，不展开也不崩。
  function parseRRULE(v) {
    const parts = {};
    for (const seg of String(v || '').split(';')) {
      const eq = seg.indexOf('=');
      if (eq > 0) parts[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1);
    }
    const freq = (parts.FREQ || '').toUpperCase();
    if (['DAILY', 'WEEKLY', 'MONTHLY'].indexOf(freq) < 0) return null;
    return {
      freq,
      interval: Math.max(1, Number(parts.INTERVAL) || 1),
      count: parts.COUNT ? Math.max(1, Number(parts.COUNT) || 1) : null,
      until: parts.UNTIL ? String(parts.UNTIL) : null,
      byDay: parts.BYDAY ? parts.BYDAY.split(',').map((s) => s.trim().toUpperCase()) : null,
      byMonthDay: parts.BYMONTHDAY ? parts.BYMONTHDAY.split(',').map(Number).filter((n) => Number.isFinite(n)) : null,
    };
  }

  // UNTIL 的时刻：Z 结尾按 UTC；DATE 形态按"那天结束"（含当天）；其余按事件时区的墙钟。
  function untilMs(rule, ev, zones) {
    if (!rule.until) return null;
    const endsWithZ = /[zZ]$/.test(rule.until);
    const w = parseWall(rule.until);
    if (!w) return null;
    if (endsWithZ) return wallUtcMs(w);
    const off = ev.allDay ? 0 : (zoneOffsetMin(zones, ev.tzid, wallUtcMs(w)) || 0);
    const base = wallUtcMs(w) - off * MS_MIN;
    return /^\d{8}$/.test(rule.until) ? base + MS_DAY - 1 : base;
  }

  // --- 解析 VCALENDAR --------------------------------------------------------

  function collectTimezones(lines) {
    const zones = new Map();
    let tz = null;
    let obs = null;
    const stack = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const p = parseProp(line);
      if (!p) continue;
      if (p.name === 'BEGIN') {
        const comp = p.value.toUpperCase();
        stack.push(comp);
        if (comp === 'VTIMEZONE') tz = { tzid: '', obs: [] };
        else if (tz && (comp === 'STANDARD' || comp === 'DAYLIGHT')) obs = {};
        continue;
      }
      if (p.name === 'END') {
        const comp = p.value.toUpperCase();
        if (obs && tz && (comp === 'STANDARD' || comp === 'DAYLIGHT')) {
          if (obs.offsetToMin != null || obs.offsetFromMin != null) tz.obs.push(obs);
          obs = null;
        } else if (tz && comp === 'VTIMEZONE') {
          if (tz.tzid && tz.obs.length) zones.set(tz.tzid, tz.obs);
          tz = null;
        }
        stack.pop();
        continue;
      }
      if (obs) {
        if (p.name === 'DTSTART') {
          const w = parseWall(p.value);
          obs.dtstartMs = w ? wallUtcMs(w) : 0;
        } else if (p.name === 'TZOFFSETTO') obs.offsetToMin = offsetToMin(p.value);
        else if (p.name === 'TZOFFSETFROM') obs.offsetFromMin = offsetToMin(p.value);
      } else if (tz && stack[stack.length - 1] === 'VTIMEZONE' && p.name === 'TZID') {
        tz.tzid = p.value;
      }
    }
    return zones;
  }

  // 返回 { events, skipped, zones }。skipped 是"看得见但解析不了"的计数——静默丢事件
  // 是排不出来的人才做的事，计数让插件页能把它显示出来。
  function parseICS(text) {
    const lines = unfold(text);
    const zones = collectTimezones(lines);
    const events = [];
    let skipped = 0;
    let ev = null;
    const stack = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const p = parseProp(line);
      if (!p) continue;
      if (p.name === 'BEGIN') {
        stack.push(p.value.toUpperCase());
        if (stack[stack.length - 1] === 'VEVENT') ev = { uid: '', title: '', location: '', status: '' };
        continue;
      }
      if (p.name === 'END') {
        const comp = p.value.toUpperCase();
        if (comp === 'VEVENT' && ev) {
          // 没有 DTSTART 的事件无处安放；STATUS:CANCELLED 不该提醒。都算"跳过"。
          if (ev.start && ev.status.toUpperCase() !== 'CANCELLED') events.push(finalize(ev));
          else skipped += 1;
          ev = null;
        }
        stack.pop();
        continue;
      }
      if (!ev) continue;
      // VALARM 是 VEVENT 的子组件，它的 DTSTART 不是日程的开始时间。
      if (stack.indexOf('VALARM') >= 0) continue;
      if (p.name === 'UID') ev.uid = p.value.trim();
      else if (p.name === 'SUMMARY') ev.title = unescapeText(p.value);
      else if (p.name === 'LOCATION') ev.location = unescapeText(p.value);
      else if (p.name === 'STATUS') ev.status = p.value.trim();
      else if (p.name === 'DTSTART') ev.start = resolveDate(p.value, p.params, zones);
      else if (p.name === 'DTEND') ev.end = resolveDate(p.value, p.params, zones);
      else if (p.name === 'RRULE') ev.rruleRaw = p.value;
    }
    return { events, skipped, zones };
  }

  // 解析结果 → 参与展开的形状：把 DTEND 缺失补成"零长 / 全天一天"，把时长先算好。
  function finalize(ev) {
    const start = ev.start;
    const end = ev.end || null;
    let durationMs = 0;
    let spanDays = 1;
    if (start.allDay) {
      if (end && end.allDay) {
        spanDays = Math.max(1, Math.round((wallUtcMs(end.wall) - wallUtcMs(start.wall)) / MS_DAY));
      }
    } else if (end) {
      const endUtc = end.utcMs != null ? end.utcMs : null;
      const startUtc = start.utcMs != null ? start.utcMs : null;
      if (endUtc != null && startUtc != null) durationMs = Math.max(0, endUtc - startUtc);
      else durationMs = Math.max(0, wallUtcMs(end.wall) - wallUtcMs(start.wall));
    }
    return {
      uid: ev.uid || `${start.wall.y}${pad(start.wall.mo)}${start.wall.d}T${pad(start.wall.h)}${pad(start.wall.mi)}-${hash(ev.title)}`,
      title: ev.title || '（无标题日程）',
      location: ev.location,
      allDay: start.allDay,
      tzid: start.tzid,
      floating: start.floating,
      wall: start.wall,
      rrule: ev.rruleRaw ? parseRRULE(ev.rruleRaw) : null,
      durationMs,
      spanDays,
    };
  }

  function pad(n) { return n < 10 ? `0${n}` : String(n); }
  function hash(s) {
    let h = 0;
    const t = String(s || '');
    for (let i = 0; i < t.length; i++) h = ((h << 5) - h + t.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  // --- 展开 ------------------------------------------------------------------

  // 一次发生换算成时刻。返回 null = 这个发生的时区算不出来（整条跳过，不能崩）。
  function occMs(ev, wall, zones, localOffsetMin) {
    if (ev.allDay) {
      return {
        startMs: Date.UTC(wall.y, wall.mo - 1, wall.d) - localOffsetMin * MS_MIN,
        endMs: Date.UTC(wall.y, wall.mo - 1, wall.d + ev.spanDays) - localOffsetMin * MS_MIN,
      };
    }
    const naive = wallUtcMs(wall);
    let off;
    if (ev.tzid === 'UTC') off = 0;
    else if (ev.floating || !ev.tzid) off = localOffsetMin;
    else {
      off = zoneOffsetMin(zones, ev.tzid, naive);
      if (off == null) return null;
    }
    return { startMs: naive - off * MS_MIN, endMs: naive - off * MS_MIN + ev.durationMs };
  }

  function* candidateWalls(ev) {
    const w = ev.wall;
    const rule = ev.rrule;
    if (!rule) { yield w; return; }
    if (rule.freq === 'DAILY') {
      for (let step = 0; step < MAX_STEPS; step++) yield addDays(w, step * rule.interval);
    } else if (rule.freq === 'WEEKLY') {
      const dow = new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay();
      // BYDAY 认 "MO" 也认带序号的 "1MO"（序号按每周处理：近似但不会把事件弄丢）。
      let days = null;
      if (rule.byDay && rule.byDay.length) {
        days = rule.byDay.map((d) => WEEKDAY.indexOf(d.replace(/^[+-]?\d+/, '')))
          .filter((i) => i >= 0).sort((a, b) => a - b);
      }
      if (!days || !days.length) days = [dow];
      // 锚在 DTSTART 那一周的周日（WEEKDAY 的下标就是 getUTCDay，SU=0），按 interval 整周走。
      const monday = addDays(w, -((dow + 6) % 7));
      const sunday = addDays(monday, -1);
      for (let week = 0; week < MAX_STEPS; week++) {
        const base = addDays(sunday, week * 7 * rule.interval);
        for (const dayIdx of days) yield addDays(base, dayIdx);
      }
    } else { // MONTHLY
      const days = rule.byMonthDay && rule.byMonthDay.length ? rule.byMonthDay : [w.d];
      for (let month = 0; month < MAX_STEPS; month++) {
        const base = addMonths(w, month * rule.interval);
        for (const md of days) {
          const last = new Date(Date.UTC(base.y, base.mo, 0)).getUTCDate();
          if (md >= 1 && md <= last) yield { y: base.y, mo: base.mo, d: md, h: base.h, mi: base.mi, s: base.s };
        }
      }
    }
  }

  // 把一个事件展开进 [fromMs, toMs)（按发生与窗口"重叠"算，跨半夜的事件两天都算）。
  // COUNT 从 DTSTART 起数——不能因为只看未来一周就从窗口起数，那会把第 6 天算成第 1 天。
  function expandEvent(ev, zones, fromMs, toMs, localOffsetMin, out) {
    const limit = toMs + 1;
    const hardUntil = ev.rrule && ev.rrule.until ? untilMs(ev.rrule, ev, zones) : null;
    // DTSTART 本身永远是一次发生（RFC：COUNT 从它起数）。迭代出的墙钟比它早的
    // （WEEKLY BYDAY 补齐的同一周里靠前的天）不算发生、也不计入 COUNT。
    const first = occMs(ev, ev.wall, zones, localOffsetMin);
    let produced = 0;
    let counted = 0;
    for (const wall of candidateWalls(ev)) {
      if (produced >= MAX_OCC || counted >= MAX_STEPS) break;
      const t = occMs(ev, wall, zones, localOffsetMin);
      if (!t) return;
      if (first && t.startMs < first.startMs) continue;
      counted += 1;
      if (ev.rrule) {
        if (hardUntil != null && t.startMs > hardUntil) return;
        if (ev.rrule.count != null && counted > ev.rrule.count) return;
      }
      if (t.endMs > fromMs && t.startMs < limit) {
        out.push({
          uid: ev.uid, title: ev.title, location: ev.location, allDay: ev.allDay,
          startMs: t.startMs, endMs: t.endMs,
        });
        produced += 1;
      }
      // 候选按墙钟单调递增：越过窗口右端就可以停（这是老日历不拖垮帧的真正保证）。
      if (t.startMs > toMs) return;
    }
  }

  // 主入口：解析过的事件列表 → 时间顺序的展开结果（按 uid+start 去重、排序）。
  function expandWindow(events, zones, opts) {
    const fromMs = opts.fromMs;
    const toMs = opts.toMs;
    const offsetMin = opts.offsetMin;
    const out = [];
    const seen = new Set();
    for (const ev of events || []) {
      const before = out.length;
      expandEvent(ev, zones, fromMs, toMs, offsetMin, out);
      // 同一 UID 解析出两份（日历合并的常态）会发生两次，按 uid+start 去重。
      for (let i = before; i < out.length; i++) {
        const key = `${out[i].uid}@${out[i].startMs}`;
        if (seen.has(key)) { out.splice(i, 1); i -= 1; } else seen.add(key);
      }
    }
    out.sort((a, b) => a.startMs - b.startMs || (a.title < b.title ? -1 : 1));
    return out;
  }

  // --- 本地日历的小工具 -------------------------------------------------------

  function dayKeyOf(ms, offsetMin) {
    const d = new Date(ms + offsetMin * MS_MIN);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }

  // 'YYYY-MM-DD HH:MM'（本地墙钟）。给别的插件看的是字符串，毫秒也一并带着。
  function fmtLocal(ms, offsetMin) {
    const d = new Date(ms + offsetMin * MS_MIN);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }

  // 某个本地日的零点（epoch 毫秒）。dayKey 与 offset 必须是同一套时区算出来的。
  function dayStartMs(key, offsetMin) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
    if (!m) return NaN;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - offsetMin * MS_MIN;
  }

  window.CalendarICS = Object.freeze({
    parseICS,
    expandWindow,
    dayKeyOf,
    fmtLocal,
    dayStartMs,
    offsetToMin,
  });
})();
