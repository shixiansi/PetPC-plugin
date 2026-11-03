// lib/convert.js —— convert()：这个插件对外的**唯一**契约（manifest.serves = ["convert"]）。
//
// 三条不让步的规则，每条都对应一种"看起来成功了，其实是错的"：
//
//   1. **不认识的东西点名拒绝。** 静默按 1:1 换算会给出一个形状完全正常、内容完全错误的答案，
//      而用户（或别的插件、模型）没有第二次机会发现它。所以未知单位、未知分类、未知进制、
//      非法数字全部抛错，错误文本里带上那个不认识的名字。
//   2. **返回值的形状固定**（category / from / to / input / value / text / unit / expression，
//      外加可选的 note / dayShift / clamped）。调用方是别的插件，形状一变它就会崩在它那边。
//   3. **数字不吐二进制浮点的尾巴。** text 按保留位数四舍五入，0.1+0.2 说 0.3：
//      一个换算工具输出 0.30000000000000004，用户会以为它算错了。

'use strict';

/** 所有拒绝都走这里：message 是给人看的中文句子，宿主与调用方都原样转述。 */
function fail(message) {
  throw new Error(message);
}

// --- 查找 ---------------------------------------------------------------------

/** 分类既认 id（length）也认中文名（长度）：模型和用户更可能写后者。 */
function findCategory(raw) {
  const key = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!key) {
    fail(`缺少分类（category）：要写 ${CATEGORY_LIST.map((d) => d.id).join(' / ')}，也可以写中文 ${CATEGORY_LIST.map((d) => d.label).join(' / ')}`);
  }
  const lower = key.toLowerCase();
  for (const def of CATEGORY_LIST) {
    if (def.id === lower || def.label === key) return def;
  }
  fail(`不认识分类「${key}」（只认 ${CATEGORY_LIST.map((d) => d.label).join(' / ')}）`);
}

/**
 * 找一个单位。id / symbol / 中文名都认——但**只认表里的**。
 *
 * 未知时把"这张表里到底有什么"念出来：只回一句"单位不合法"，用户下一步只能猜。这一句是
 * 2026-11-02 定下来的形状：`不认识单位「斤」——重量只认 kg / g / mg / t / lb / oz（中文名：…）`。
 */
function findUnit(def, raw, side) {
  const key = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!key) {
    fail(`${def.unitWord}没写：${side === 'from' ? 'from' : 'to'} 缺一个${def.unitWord}（例如 {"from":"${def.units[0].id}","to":"${def.units[1].id}"}）`);
  }
  const lower = key.toLowerCase();
  for (const unit of def.units) {
    if (unit.id.toLowerCase() === lower || String(unit.symbol).toLowerCase() === lower || unit.name === key) return unit;
  }
  const ids = def.units.map((u) => u.id).join(' / ');
  const names = def.units.map((u) => u.name).join(' / ');
  fail(`不认识${def.unitWord}「${key}」——${def.label}只认 ${ids}（中文名：${names}）`);
}

// --- 数字与格式 ---------------------------------------------------------------

function clampDecimals(value) {
  const n = Number.parseInt(String(value === undefined || value === null ? '' : value), 10);
  if (!Number.isFinite(n)) return 2;
  return Math.min(8, Math.max(0, n));
}

/** 去掉小数点后面多余的 0：`0.30` → `0.3`，`724.00` → `724`（toFixed 之后才会出现这些）。 */
function stripZeros(text) {
  if (!text.includes('.')) return text;
  // 科学计数法的尾零长在指数前面（1.00e-9）：只削尾零会把那个 0 留在小数点后。
  const [mantissa, exponent] = text.split('e');
  const trimmed = mantissa.replace(/0+$/, '').replace(/\.$/, '');
  return exponent === undefined ? trimmed : `${trimmed}e${exponent}`;
}

/**
 * 按保留位数显示一个数。
 *
 * 两件事：四舍五入之后才是"结果"（0.1+0.2 那条），以及**比精度还小的数不要说成 0**——
 * 换算是要拿去做判断的，把 1e-6 米说成"0 米"等于说谎。所以它退回 3 位有效数字。
 */
function formatNumber(value, decimals) {
  if (!Number.isFinite(value)) return '—';
  const d = clampDecimals(decimals);
  const abs = Math.abs(value);
  if (abs !== 0 && abs < Math.pow(10, -d) / 2) {
    return stripZeros(value.toPrecision(3));
  }
  return stripZeros(value.toFixed(d));
}

function numberOf(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim().replace(/,/g, '');
  if (!text) fail('缺少要换算的数值（value 要给一个数字，例如 12.5）');
  const n = Number(text);
  if (!Number.isFinite(n)) fail(`「${text}」不是数字（要换算的数值请写成 12.5 这样）`);
  return n;
}

// --- 各分类 -------------------------------------------------------------------

function scalarResult(def, from, to, input, decimals) {
  const value = numberOf(input.value);
  const out = (value * from.k) / to.k;
  return {
    category: def.id,
    from: from.id,
    to: to.id,
    input: value,
    value: out,
    text: formatNumber(out, decimals),
    unit: to.symbol,
    expression: `${formatNumber(value, decimals)} ${from.symbol} = ${formatNumber(out, decimals)} ${to.symbol}`,
  };
}

function temperatureResult(def, from, to, input, decimals) {
  const raw = numberOf(input.value);
  // 绝对零度以下不存在：夹住并说明。照算会得到 -500 °F 这种"数字对、物理错"的答案。
  const belowZero = raw < from.min;
  const value = belowZero ? from.min : raw;
  const out = to.fromBase(from.toBase(value));
  const result = {
    category: def.id,
    from: from.id,
    to: to.id,
    input: raw,
    value: out,
    text: formatNumber(out, decimals),
    unit: to.symbol,
    expression: `${formatNumber(value, decimals)} ${from.symbol} = ${formatNumber(out, decimals)} ${to.symbol}`,
  };
  if (belowZero) {
    result.clamped = true;
    result.note = `${formatNumber(raw, decimals)} ${from.symbol} 低于绝对零度（${from.min} ${from.symbol}），已按绝对零度换算`;
  }
  return result;
}

function timeToMinutes(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  const match = /^(\d{1,2})\s*[:：]\s*(\d{2})$/.exec(text);
  if (!match) fail(`「${text}」不是一个时刻（时区换算要写成 HH:MM，例如 23:30）`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) fail(`「${text}」不是一个时刻（小时 0–23、分钟 0–59）`);
  return hours * 60 + minutes;
}

function minutesToTime(total) {
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function zoneResult(def, from, to, input) {
  const given = input.time !== undefined ? input.time : input.value;
  const local = timeToMinutes(given);
  // 先还原成 UTC，再落到目标时区：直接减两个偏移之差是一样的，但这条路上"跨日"是加出来的。
  const target = local - from.offset + to.offset;
  const dayShift = Math.floor(target / 1440);
  const clock = ((target % 1440) + 1440) % 1440;
  const text = minutesToTime(clock);
  const suffix = dayShift > 0 ? '（次日）' : dayShift < 0 ? '（前一日）' : '';
  const result = {
    category: def.id,
    from: from.id,
    to: to.id,
    input: minutesToTime(local),
    value: clock,
    text,
    unit: to.symbol,
    dayShift,
    expression: `${from.symbol} ${minutesToTime(local)} = ${to.symbol} ${text}${suffix}`,
  };
  if (dayShift !== 0) {
    result.note = `目标时区已经是${dayShift > 0 ? '第二天' : '前一天'}的 ${text}（这里只有固定偏移，不含夏令时）`;
  }
  return result;
}

const RADIX_NAMES = { 2: '二进制', 8: '八进制', 10: '十进制', 16: '十六进制' };
const RADIX_DIGITS = { 2: '0 和 1', 8: '0–7', 10: '0–9', 16: '0–9 与 A–F' };

function parseInBase(raw, radix) {
  const original = String(raw === undefined || raw === null ? '' : raw).trim();
  let text = original.replace(/[\s_]/g, '');
  const name = RADIX_NAMES[radix] || `${radix} 进制`;
  if (!text) fail('缺少要转换的数（value 写成字符串，例如 "ff"）');
  let sign = 1;
  if (text[0] === '+' || text[0] === '-') {
    if (text[0] === '-') sign = -1;
    text = text.slice(1);
  }
  if (!text) fail(`「${original}」不是一个${name}数`);
  if (/^0[xbo]/i.test(text)) {
    fail(`「${original}」带了 0x / 0b / 0o 前缀——进制由 from 说了算，把前缀去掉写成「${text.slice(2)}」`);
  }
  for (const ch of text) {
    if (!Number.isFinite(Number.parseInt(ch, radix))) {
      fail(`「${original}」不是合法的${name}数字（${name}只认 ${RADIX_DIGITS[radix] || ''}）`);
    }
  }
  return sign * Number.parseInt(text, radix);
}

function baseResult(def, from, to, input) {
  const radixFrom = Number(from.id);
  const radixTo = Number(to.id);
  const digits = String(input.value === undefined || input.value === null ? '' : input.value).trim();
  const value = parseInBase(digits, radixFrom);
  const text = value.toString(radixTo).toUpperCase();
  return {
    category: def.id,
    from: from.id,
    to: to.id,
    input: digits,
    value,
    text,
    unit: `基数 ${to.id}`,
    expression: `${digits}（${radixFrom} 进制） = ${text}（${radixTo} 进制）`,
  };
}

function currencyResult(def, from, to, input, decimals) {
  const value = numberOf(input.value);
  // 两个币种的 perUsd 之比就是汇率，所以"先换成美元、再换出去"——少了任何一步，
  // 反方向就会和正方向对不上（这是静态汇率表最容易写错的地方）。
  const out = (value / from.perUsd) * to.perUsd;
  return {
    category: def.id,
    from: from.id,
    to: to.id,
    input: value,
    value: out,
    text: formatNumber(out, decimals),
    unit: to.symbol,
    expression: `${formatNumber(value, decimals)} ${from.id} = ${formatNumber(out, decimals)} ${to.id}`,
    note: `汇率来自内置静态快照（${RATES_AS_OF}），完全离线、不代表实时价`,
  };
}

// --- 入口 ---------------------------------------------------------------------

/**
 * @param {object} payload  { category, from, to, value }（时区用 time 或 value 写 HH:MM）
 * @param {{decimals?: number}} [options]  保留位数（来自插件设置，默认 2）
 * @returns {object} 见 README「serves.convert」那一节，形状是钉住的
 */
function convert(payload, options) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const decimals = clampDecimals(options && options.decimals);
  const def = findCategory(input.category);
  const from = findUnit(def, input.from, 'from');
  const to = findUnit(def, input.to, 'to');
  switch (def.kind) {
    case 'scalar':
      return scalarResult(def, from, to, input, decimals);
    case 'temperature':
      return temperatureResult(def, from, to, input, decimals);
    case 'timezone':
      return zoneResult(def, from, to, input);
    case 'number-base':
      return baseResult(def, from, to, input);
    case 'currency':
      return currencyResult(def, from, to, input, decimals);
    default:
      // 走到这里说明 units.js 加了一类而 convert.js 没跟上：明说，别返回一个空壳。
      fail(`分类「${def.label}」还没有实现（这是插件自己的 bug）`);
  }
}
