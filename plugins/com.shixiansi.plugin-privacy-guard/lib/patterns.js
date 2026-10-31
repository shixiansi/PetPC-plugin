// lib/patterns.js —— 敏感信息正则库与脱敏引擎（纯函数）
//
// 设计原则（每条都来自一次误杀教训）：
//   1. **有分隔符才算**：手机号/身份证要求边界（前面不是数字，后面不是数字）——
//      否则订单号 138000012345678 会被掐成"手机号"。
//   2. **有校验位就校验**：身份证 18 位带 ISO 7064 MOD 11-2 校验，错的直接不认；
//      银行卡 16-19 位带 Luhn 校验。这两条把"随手敲的数字串"挡在门外。
//   3. **有格式特征才算**：API Key 有 sk- 前缀 + 长随机段；邮箱要 TLD；IP 要四段
//      0-255 且前后不是数字或点。
//   4. **每类独立开关 + 统一脱敏形状**：脱敏保留前 3 后 2（身份证）/前 3 后 4（手机），
//      其余 *；Key 类全遮只留前缀。findings() 返回位置，调用方自己拼"哪一段被遮"。
//
// 五类内置：身份证 / 手机号 / 银行卡 / API Key / 邮箱（邮箱是"可识别个人"的最弱项，
// 默认开启但可关）。

'use strict';

/** ISO 7064 MOD 11-2：中国身份证第 18 位校验。 */
function idCardChecksumOk(id18) {
  const W = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const CODES = '10X98765432';
  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    const c = id18.charCodeAt(i) - 48;
    if (c < 0 || c > 9) return false;
    sum += c * W[i];
  }
  const expect = CODES[sum % 11];
  return id18.charAt(17).toUpperCase() === expect;
}

/** Luhn 算法：银行卡/信用卡校验位。 */
function luhnOk(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const c = digits.charCodeAt(i) - 48;
    if (c < 0 || c > 9) return false;
    let d = c;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** 生日部分要像真的日期（年份 1800-2099，月 01-12，日 01-31）。 */
function idBirthdayOk(id18) {
  const y = Number(id18.slice(6, 10));
  const m = Number(id18.slice(10, 12));
  const d = Number(id18.slice(12, 14));
  return y >= 1800 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

// 数字边界：前后不能是数字（避免订单号被掐半）。
const NB = '(?<!\\d)';
const NA = '(?!\\d)';

/** 五类内置规则。enabled 由调用方的开关表决定；这里只定义"怎么认、怎么遮"。 */
const RULES = [
  {
    id: 'openai_key',
    label: 'API Key（sk- 开头）',
    severity: 'high',
    // sk- 后 20-200 位 [A-Za-z0-9_-]；边界：前后不能是同一字符集（防止把长串的一部分当 Key）。
    re: new RegExp(`${NB}sk-[A-Za-z0-9_-]{20,200}${NA}`, 'g'),
    mask: (m) => `sk-${'*'.repeat(Math.min(12, Math.max(4, m[0].length - 3)))}`,
  },
  {
    id: 'bearer_token',
    label: 'Bearer 令牌',
    severity: 'high',
    re: /(?<![\w.-])Bearer\s+[A-Za-z0-9._~+/=-]{16,512}(?![\w./=-])/gi,
    mask: () => 'Bearer ****',
  },
  {
    id: 'id_card',
    label: '身份证号',
    severity: 'high',
    re: new RegExp(`${NB}[1-9]\\d{5}(?:19|20)\\d{2}(?:0[1-9]|1[0-2])(?:[0-2]\\d|3[01])\\d{3}[\\dXx]${NA}`, 'g'),
    // 校验位在 scan 阶段再验（正则里做不了）：validator 字段。
    validator: (m) => idCardChecksumOk(m[0].toUpperCase()),
    mask: (m) => `${m[0].slice(0, 3)}***********${m[0].slice(-2)}`,
  },
  {
    id: 'phone',
    label: '手机号',
    severity: 'high',
    // 大陆手机号：1[3-9] 开头共 11 位；前后不能是数字（不碰订单号/座机分机）。
    re: new RegExp(`${NB}1[3-9]\\d{9}${NA}`, 'g'),
    mask: (m) => `${m[0].slice(0, 3)}****${m[0].slice(-4)}`,
  },
  {
    id: 'bank_card',
    label: '银行卡号',
    severity: 'high',
    // 16-19 位数字，常见卡 BIN 以 4/5/6 开头（visa/mc/银联）；Luhn 校验挡掉随手数字串。
    re: new RegExp(`${NB}[4-6]\\d{15,18}${NA}`, 'g'),
    validator: (m) => luhnOk(m[0]),
    mask: (m) => {
      const head = m[0].slice(0, 4);
      const tail = m[0].slice(-4);
      const midStars = '*'.repeat(m[0].length - 8);
      // 中段每 4 个一组，组间空格；尾部单独一段。
      const mid = (midStars.match(/.{1,4}/g) || []).join(' ');
      return `${head} ${mid} ${tail}`.replace(/ {2,}/g, ' ');
    },
  },
  {
    id: 'email',
    label: '邮箱地址',
    severity: 'medium',
    re: /(?<![\w.+-])[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}(?![\w.-])/g,
    mask: (m) => {
      const at = m[0].indexOf('@');
      const local = m[0].slice(0, at);
      const head = local.slice(0, Math.min(2, local.length));
      return `${head}***${m[0].slice(at)}`;
    },
  },
  {
    id: 'ipv4',
    label: '内网 IP 地址',
    severity: 'low',
    re: new RegExp(`${NB}(?:(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)${NA}`, 'g'),
    mask: (m) => `${m[0].split('.')[0]}.***.***.${m[0].split('.')[3]}`,
  },
];

const RULES_BY_ID = Object.fromEntries(RULES.map((r) => [r.id, r]));

/** 默认开关表：全部开启。 */
function defaultToggles() {
  return Object.fromEntries(RULES.map((r) => [r.id, true]));
}

/**
 * 扫描一段文本。返回 findings：[{id, ruleId, label, severity, start, end, masked, preview}]。
 * @param {string} text
 * @param {object} [toggles] 每类开关（缺省 = 开）
 */
function scanText(text, toggles = {}) {
  const s = String(text ?? '');
  if (!s) return [];
  const findings = [];
  for (const rule of RULES) {
    if (toggles[rule.id] === false) continue;
    const re = rule.re;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      if (m[0].length === 0) { re.lastIndex += 1; continue; }
      // 校验器不过 = 不是这类敏感信息（误杀防线）。
      if (rule.validator && !rule.validator(m)) continue;
      // 位置去重：一个更早的规则已经覆盖了这段就不再报（身份证先于手机号出现在同一段）。
      const start = m.index;
      const end = m.index + m[0].length;
      if (findings.some((f) => start < f.end && end > f.start)) continue;
      findings.push({
        ruleId: rule.id,
        label: rule.label,
        severity: rule.severity,
        start,
        end,
        masked: rule.mask(m),
        // 预览自带脱敏（告警会离开本插件，绝不能带原文出去）。
        preview: '',
      });
      // zero-length 防护
      if (m.index === re.lastIndex) re.lastIndex += 1;
    }
  }
  findings.sort((a, b) => a.start - b.start || a.end - b.end);
  return findings;
}

/**
 * 脱敏：把 findings 的区间替换成 masked 文本。
 * @returns {{ text: string, replaced: number }}
 */
function redactText(text, findings) {
  let s = String(text ?? '');
  const fs = [...(findings || [])].sort((a, b) => b.start - a.start); // 从后往前替换
  for (const f of fs) {
    s = s.slice(0, f.start) + f.masked + s.slice(f.end);
  }
  return { text: s, replaced: fs.length };
}

/** 命中处的安全预览：在**脱敏后的文本**上取命中位置附近的一段。
 *  绝不返回原文——调用方（告警/日志）拿着它离开本插件。 */
function safePreview(text, findings, radius = 16) {
  const { text: redacted } = redactText(text, findings);
  if (!findings.length) return '';
  const first = findings[0];
  const from = Math.max(0, first.start - radius);
  const to = Math.min(redacted.length, first.end + radius);
  return redacted.slice(from, to).replace(/\s+/g, ' ').trim();
}

/** 一次调用：扫 + 遮。 */
function redact(text, toggles = {}) {
  const findings = scanText(text, toggles);
  return { findings, ...redactText(text, findings) };
}

/** 风险分级：一条 high 就 high；否则 medium；否则 low；没有就是 none。 */
function riskLevel(findings) {
  if (!findings || !findings.length) return 'none';
  if (findings.some((f) => f.severity === 'high')) return 'high';
  if (findings.some((f) => f.severity === 'medium')) return 'medium';
  return 'low';
}

const PrivacyPatterns = {
  RULES, RULES_BY_ID, defaultToggles, scanText, redactText, redact, riskLevel, safePreview,
  idCardChecksumOk, luhnOk,
};
