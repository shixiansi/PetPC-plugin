// lib/convert.js —— 换算的纯函数层：类别表、单位表、换算与解析。
//
// 这里不碰宿主、不碰 DOM、不发网络——**零网络**是本插件的存在方式（汇率没有数据源，
// 不做）。测试接缝：panel.html 用 <script> 引入即 window.ConvertCore；测试用
// new Function('window', src) 装载同一份源码，钉住 20 组换算与"未知单位点名拒绝"。
//
// 精度规则（测试钉死）：
//   · 中间量一律走"类别基准单位"（米/千克/开尔文/字节/秒），两端各一次乘除；
//   · 结果四舍五入到 precision 位有效数字（默认 10，config 可配 2–12），
//     不承诺 IEEE 精确，只承诺约定精度；
//   · 进制换算在字符串域（parseInt/toString(radix)），不走浮点。
//
// 未知单位必须**点名拒绝**（ok:false + 单位名原样出现在 reason 里），不猜同义词：
// 给模型的工具宁可拒绝也别猜错——猜错会被下游当成事实。
'use strict';

(function () {
  // 每个类别：基准单位 + 单位表（到基准的因子；温度是仿射的 {mul, add}，基准=开尔文）。
  const CATS = {
    length: {
      base: 'm',
      units: {
        mm: 0.001, cm: 0.01, m: 1, km: 1000,
        in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344, nmi: 1852,
      },
    },
    weight: {
      base: 'kg',
      units: {
        g: 0.001, kg: 1, t: 1000, lb: 0.45359237, oz: 0.028349523125, jin: 0.5,
      },
    },
    temperature: {
      base: 'K',
      units: {
        K: { mul: 1, add: 0 },
        '°C': { mul: 1, add: 273.15 },
        '°F': { mul: 5 / 9, add: 255.37222222222222 },
      },
    },
    data: {
      base: 'B',
      units: {
        B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4,
        KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4,
      },
    },
    time: {
      base: 's',
      units: {
        ms: 0.001, s: 1, min: 60, h: 3600, d: 86400, week: 604800,
      },
    },
  };

  const CAT_LABEL = { length: '长度', weight: '重量', temperature: '温度', data: '数据量', time: '时间' };

  const RADIX_NAMES = { bin: 2, oct: 8, dec: 10, hex: 16 };

  /** 查一个单位：精确名优先，其次大小写不敏感。返回 {cat, spec} 或 null。 */
  function findUnit(unit) {
    for (const cat of Object.keys(CATS)) {
      const units = CATS[cat].units;
      if (Object.prototype.hasOwnProperty.call(units, unit)) return { cat, spec: units[unit] };
    }
    const lower = String(unit).toLowerCase();
    for (const cat of Object.keys(CATS)) {
      const units = CATS[cat].units;
      const hit = Object.keys(units).find((u) => u.toLowerCase() === lower);
      if (hit) return { cat, spec: units[hit], canonical: hit };
    }
    return null;
  }

  function isRadixUnit(u) {
    const s = String(u).toLowerCase();
    return Object.prototype.hasOwnProperty.call(RADIX_NAMES, s) || ['2', '8', '10', '16'].includes(s);
  }

  function isZoneUnit(u) { return /^UTC[+-]/i.test(String(u || '').trim()); }

  const round = (v) => {
    if (!Number.isFinite(v)) return v;
    const s = Number(v.toPrecision(precision));
    return Object.is(s, -0) ? 0 : s;
  };

  // 精度可配（manifest 的 precision 项，2–12）：app.js 经 setPrecision 传入。
  // 不放 CATS 里是因为它是展示层约定，不是换算表的属性。
  let precision = 10;
  function setPrecision(n) {
    const p = Number(n);
    if (Number.isFinite(p)) precision = Math.max(2, Math.min(12, Math.floor(p)));
  }

  function fmt(v) {
    if (!Number.isFinite(v)) return String(v);
    const abs = Math.abs(v);
    if (abs !== 0 && (abs < 1e-6 || abs >= 1e15)) return v.toExponential(6);
    return String(round(v));
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  /** "1km to mi" / "1km in mi" / "1 km → mi" 的一句话形状。失败 → null。 */
  function parseTextQuery(text) {
    const m = /^\s*([-+]?[0-9]+(?:\.[0-9]+)?(?:[eE][-+]?\d+)?)\s*([^\s]+)\s+(?:to|in|→|->|换算到|等于)\s*([^\s]+)\s*$/i.exec(String(text || ''));
    return m ? { value: Number(m[1]), from: m[2], to: m[3] } : null;
  }

  /** 进制换算（字符串域）。value 是数字或数字字符串；from/to 是 2/8/10/16 或 bin/oct/dec/hex。 */
  function convertRadix(value, from, to) {
    const radixOf = (name) => {
      const s = String(name).toLowerCase();
      if (Object.prototype.hasOwnProperty.call(RADIX_NAMES, s)) return RADIX_NAMES[s];
      if (['2', '8', '10', '16'].includes(s)) return Number(s);
      return null;
    };
    const f = radixOf(from);
    const t = radixOf(to);
    if (f === null) return { ok: false, reason: `未知进制：${from}（支持 bin/oct/dec/hex 或 2/8/10/16）` };
    if (t === null) return { ok: false, reason: `未知进制：${to}（支持 bin/oct/dec/hex 或 2/8/10/16）` };
    const digits = String(value).trim().replace(/[ \t_]/g, '').replace(/^0[box]/i, '');
    const neg = digits.startsWith('-');
    const abs = neg ? digits.slice(1) : digits;
    // 按位校验（parseInt 会宽松解析："129" 按 2 进制读出 1 而不是 NaN——不要它）。
    const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, f);
    if (!abs || [...abs.toLowerCase()].some((c) => !DIGITS.includes(c))) {
      return { ok: false, reason: `「${value}」不是 ${f} 进制数` };
    }
    const n = parseInt(abs, f);
    if (Number.isNaN(n)) return { ok: false, reason: `「${value}」不是 ${f} 进制数` };
    let out = n.toString(t);
    if (neg) out = '-' + out;
    return { ok: true, value: out, from: String(f), to: String(t), formatted: `${String(value)}(${f}进制) = ${out}(${t}进制)` };
  }

  /**
   * 时区偏移：from/to 形如 UTC+8 / UTC-05:30。
   * value 是 from 地方的钟点数（14 或 14.5 = 14:30）。
   * 日期基线：payload.at（epoch 毫秒）给"哪一天"；缺省用固定一天（2026-01-02T00:00Z），
   * 让结果可复现——"几点"由 value 说，"哪天"只是展示。
   */
  function convertZone(value, from, to, atMs) {
    const parse = (z) => {
      const m = /^UTC([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(String(z || '').trim());
      if (!m) return null;
      const sign = m[1] === '-' ? -1 : 1;
      const hh = Number(m[2]);
      const mm = Number(m[3] || '0');
      if (hh > 14 || mm > 59) return null;
      return sign * (hh * 60 + mm);
    };
    const a = parse(from);
    const b = parse(to);
    if (a === null) return { ok: false, reason: `未知时区写法：${from}（形如 UTC+8 / UTC-05:30）` };
    if (b === null) return { ok: false, reason: `未知时区写法：${to}（形如 UTC+8 / UTC-05:30）` };
    if (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) >= 24) {
      return { ok: false, reason: `钟点不是 0–24 的数：${JSON.stringify(value)}` };
    }
    const at = atMs === undefined ? Date.UTC(2026, 0, 2, 0, 0, 0) : Number(atMs);
    const fromLocal = new Date(at + Math.round(Number(value) * 3600000) - a * 60000);
    const toLocal = new Date(at + Math.round(Number(value) * 3600000) + (b - a) * 60000);
    const clock = `${pad2(toLocal.getUTCHours())}:${pad2(toLocal.getUTCMinutes())}`;
    const diff = round((b - a) / 60);
    return {
      ok: true,
      value: diff,
      from,
      to,
      clock,
      date: `${toLocal.getUTCFullYear()}-${pad2(toLocal.getUTCMonth() + 1)}-${pad2(toLocal.getUTCDate())}`,
      formatted: `${fmt(Number(value))} 点(${from}) = ${clock}(${to})，差 ${diff} 小时`,
      _fromLocalDate: fromLocal.toISOString(),
    };
  }

  /** 因子类换算（长度/重量/温度/数据量/时间）。 */
  function convertFactor(value, from, to) {
    const a = findUnit(from);
    if (!a) return { ok: false, reason: `未知单位：${from}。支持：长度(km m cm mi…)、重量(kg lb…)、温度(°C °F K)、数据量(MB GB…)、时间(min h…)` };
    const b = findUnit(to);
    if (!b) return { ok: false, reason: `未知单位：${to}。支持：长度(km m cm mi…)、重量(kg lb…)、温度(°C °F K)、数据量(MB GB…)、时间(min h…)` };
    if (a.cat !== b.cat) return { ok: false, reason: `类别不匹配：${from} 是${CAT_LABEL[a.cat]}，${to} 是${CAT_LABEL[b.cat]}——这两者换不了` };
    const toBaseVal = typeof a.spec === 'number' ? value * a.spec : value * a.spec.mul + a.spec.add;
    const out = typeof b.spec === 'number' ? toBaseVal / b.spec : (toBaseVal - b.spec.add) / b.spec.mul;
    return { ok: true, value: round(out), from: a.canonical || from, to: b.canonical || to, cat: a.cat, formatted: `${fmt(value)} ${a.canonical || from} = ${fmt(out)} ${b.canonical || to}` };
  }

  /**
   * 主入口：{value, from, to} 或 {text:"1km to mi"}（at 只对时区有意义）。
   * 返回 {ok:true, value, from, to, formatted} 或 {ok:false, reason}。
   */
  function convert(payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    let value = p.value;
    let from = p.from;
    let to = p.to;
    if (typeof p.text === 'string' && p.text.trim()) {
      const q = parseTextQuery(p.text);
      if (!q) return { ok: false, reason: `看不懂这句话：「${p.text}」。形状是「数值 单位 to 单位」，例如 1km to mi` };
      value = q.value; from = q.from; to = q.to;
    }
    if (value === undefined || value === null || String(value).trim() === '') {
      return { ok: false, reason: '缺 value（要换算的数）' };
    }
    from = String(from || '').trim();
    to = String(to || '').trim();
    if (!from || !to) return { ok: false, reason: '缺 from 或 to 单位' };

    // 时区：任一端是 UTC± 形状（value 是钟点）。进制端不可能撞上时区形状。
    if (isZoneUnit(from) || isZoneUnit(to)) return convertZone(value, from, to, p.at);

    // 进制：value 在这里按字符串读（进制数可能超出 double 的可靠整数域的场景不承诺，
    // 但字符串域保证 ≤2^53 内逐位正确）。
    if (isRadixUnit(from) || isRadixUnit(to)) return convertRadix(value, from, to);

    // 其余：因子类。value 必须是有限数。
    const n = Number(value);
    if (!Number.isFinite(n)) return { ok: false, reason: `值不是数：${JSON.stringify(value)}` };
    return convertFactor(n, from, to);
  }

  window.ConvertCore = Object.freeze({
    CATS,
    convert,
    convertRadix,
    convertZone,
    convertFactor,
    parseTextQuery,
    findUnit,
    round,
    setPrecision,
  });
})();
