// lib/parse.js —— 大模型返回的记账 JSON 的容错解析（纯函数）
//
// 设计（题目要求的核心）：模型可能返回非标准 JSON、金额带单位、类别不在清单里、
// 甚至在 JSON 外面裹一段话。解析分四层兜底：
//
//   1. 直接 JSON.parse；
//   2. 剥掉 ```json 围栏 / 抓取第一个 {...} 平衡块再 parse；
//   3. 宽松修复：全角引号/逗号、尾逗号、单引号；
//   4. 语义清洗：amount 抠数字（"25块"/"¥25.0"/"二十五"不认——只认数字字面量）、
//      type 归一化（expense/income/refund）、category 白名单映射（同义词表）。
//
// 全部失败时返回 {ok:false, reason}，编排层决定重试还是放弃——**账本绝不写脏数据**。

'use strict';

const EXPENSE_CATEGORIES = ['餐饮', '交通', '购物', '娱乐', '居住', '医疗', '教育', '通讯', '旅行', '其他'];
const INCOME_CATEGORIES = ['工资', '报销', '红包', '理财', '其他'];

/** 同义词 → 标准类别（模型爱自由发挥）。 */
const CATEGORY_SYNONYMS = {
  吃饭: '餐饮', 吃: '餐饮', 饭: '餐饮', 午饭: '餐饮', 晚饭: '餐饮', 早饭: '餐饮', 咖啡: '餐饮', 奶茶: '餐饮', 外卖: '餐饮', 食品: '餐饮',
  打车: '交通', 出租: '交通', 地铁: '交通', 公交: '交通', 加油: '交通', 停车: '交通', 高铁: '交通', 火车: '交通', 机票: '交通', 出行: '交通',
  买: '购物', 衣服: '购物', 日用: '购物', 数码: '购物', 快递: '购物',
  电影: '娱乐', 游戏: '娱乐', ktv: '娱乐', 运动: '娱乐',
  房租: '居住', 水电: '居住', 物业: '居住', 家具: '居住',
  药: '医疗', 看病: '医疗', 挂号: '医疗',
  书: '教育', 课程: '教育', 培训: '教育',
  话费: '通讯', 流量: '通讯', 网费: '通讯',
  酒店: '旅行', 门票: '旅行', 住宿: '旅行',
  工资: '工资', 薪水: '工资', 报销: '报销', 红包: '红包', 转账收入: '其他',
};

/** 数字里可能夹的干扰字符。 */
function stripAmountNoise(text) {
  return String(text ?? '').replace(/[¥￥$,\s元块]/g, '');
}

/** 抠金额：接受 number 或字符串，返回非负有限数或 null。上限 1000 万（荒谬值拒）。 */
const AMOUNT_MAX = 10000000;

function parseAmount(raw) {
  let n;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return null;
    n = raw;
  } else if (typeof raw === 'string') {
    const cleaned = stripAmountNoise(raw);
    // 只认纯数字字面量（可带小数）；"二十五"这类汉字数字**不猜**——宁可解析失败重试。
    const m = cleaned.match(/^(\d+(?:\.\d+)?)$/);
    if (!m) return null;
    n = Number.parseFloat(m[1]);
  } else {
    return null;
  }
  if (!Number.isFinite(n) || n < 0 || n > AMOUNT_MAX) return null;
  return n;
}

/** 类型归一化。 */
function parseType(raw, amount) {
  const t = String(raw ?? '').toLowerCase().trim();
  if (t === 'income' || t === '收入' || t === 'in') return 'income';
  if (t === 'refund' || t === '退款' || t === '报销') return 'refund';
  if (t === 'expense' || t === '支出' || t === 'out' || t === '') return 'expense';
  return null; // 未知类型：让上层重试，不猜
}

/** 类别归一化：白名单 + 同义词。未知归 '其他'（可接受，不算脏数据）。 */
function parseCategory(raw, type) {
  const s = String(raw ?? '').trim();
  if (!s) return type === 'income' ? '其他' : '其他';
  const low = s.toLowerCase();
  if (low === '其他' || low === '其它') return '其他';
  if (type === 'income') {
    if (INCOME_CATEGORIES.includes(s)) return s;
    return CATEGORY_SYNONYMS[low] && INCOME_CATEGORIES.includes(CATEGORY_SYNONYMS[low]) ? CATEGORY_SYNONYMS[low] : '其他';
  }
  if (EXPENSE_CATEGORIES.includes(s)) return s;
  if (CATEGORY_SYNONYMS[low]) return CATEGORY_SYNONYMS[low];
  // 模型给的白名单外新类目：归"其他"，原文记进 note。
  return '其他';
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 日期归一化：接受 YYYY-MM-DD / 今天/昨天 / 缺省。返回 YYYY-MM-DD 或 null。 */
function parseDate(raw, now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  const today = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const yesterday = `${new Date(now - DAY_MS).getFullYear()}-${p(new Date(now - DAY_MS).getMonth() + 1)}-${p(new Date(now - DAY_MS).getDate())}`;
  const s = String(raw ?? '').trim();
  if (!s || s === '今天' || s === 'today') return today;
  if (s === '昨天' || s === 'yesterday') return yesterday;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const dt = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
    if (!Number.isNaN(dt.getTime())) return `${m[1]}-${m[2]}-${m[3]}`;
  }
  return null; // 别的格式不猜
}

/** 从任意文本里抓出能 parse 的 JSON 对象：逐个 { 试起（模型常在 JSON 前面写正文，
 *  而正文里也可能有花括号），第一个能 parse 的平衡块赢。 */
function extractJsonObject(text) {
  const s = String(text ?? '');
  let from = s.indexOf('{');
  while (from >= 0) {
    let depth = 0;
    let inStr = false;
    let quote = '';
    for (let i = from; i < s.length; i += 1) {
      const c = s[i];
      if (inStr) {
        if (c === '\\') { i += 1; continue; }
        if (c === quote) inStr = false;
        continue;
      }
      if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
      if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          const candidate = s.slice(from, i + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return candidate;
          } catch {
            break; // 这个起点不行，试下一个 {
          }
          break;
        }
      }
    }
    from = s.indexOf('{', from + 1);
  }
  return null;
}

/** 宽松 JSON 修复：全角标点 → 半角；无引号键补引号；单引号字符串 → 双引号；尾逗号去掉。 */
function repairJson(text) {
  let s = String(text ?? '');
  s = s.replace(/[（]/g, '(').replace(/[）]/g, ')').replace(/[：]/g, ':').replace(/[，]/g, ',');
  s = s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":'); // 无引号键
  s = s.replace(/([{,]\s*)'([^']+)'\s*:/g, '$1"$2":');           // 单引号键
  s = s.replace(/:\s*'([^']*)'/g, ': "$1"');                     // 单引号值
  s = s.replace(/,\s*([}\]])/g, '$1');                            // 尾逗号
  return s;
}

/** 单次模型输出 → 结构化记录。返回 {ok, entry?, reason?}。 */
function parseModelReply(rawText, now = Date.now()) {
  const text = String(rawText ?? '');
  if (!text.trim()) return { ok: false, reason: '模型没有返回内容' };

  const candidates = [];
  // 1) 原文直接 parse
  candidates.push(text);
  // 2) 围栏内 / 平衡块
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1]);
  const balanced = extractJsonObject(text);
  if (balanced) candidates.push(balanced);
  // 3) 修复版
  if (balanced) candidates.push(repairJson(balanced));
  candidates.push(repairJson(text));

  let obj = null;
  for (const cand of candidates) {
    try {
      const parsed = JSON.parse(cand.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { obj = parsed; break; }
    } catch {
      // 下一个候选
    }
  }
  if (!obj) return { ok: false, reason: '模型返回里找不到能解析的 JSON 对象' };

  const amount = parseAmount(obj.amount ?? obj.money ?? obj.金额);
  if (amount === null) return { ok: false, reason: `金额不是可识别的数字（收到 ${JSON.stringify(obj.amount ?? obj.money ?? null).slice(0, 40)}）` };
  if (amount === 0) return { ok: false, reason: '金额是 0（不是一笔真实的账）' };

  const type = parseType(obj.type ?? obj.类型, amount);
  if (!type) return { ok: false, reason: `类型无法识别（收到 ${String(obj.type ?? obj.类型 ?? '').slice(0, 20)}）` };

  const day = parseDate(obj.date ?? obj.dateStr ?? obj.日期, now);
  if (!day) return { ok: false, reason: `日期无法识别（收到 ${String(obj.date ?? '').slice(0, 20)}）` };

  const category = parseCategory(obj.category ?? obj.分类 ?? obj.categoryName, type);
  const entry = {
    id: `e${now.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    at: now,
    day,
    type,
    amount: Math.round(amount * 100) / 100,
    category,
    note: String(obj.note ?? obj.note ?? obj.备注 ?? obj.description ?? '').slice(0, 120),
    raw: String(obj.raw ?? '').slice(0, 120), // 用户原话（模型透传，丢了也没关系）
  };
  return { ok: true, entry };
}

/** prompt：要求严格 JSON 输出（发给模型的系统指令）。 */
function buildParsePrompt(userText) {
  return [
    '你是记账解析器。把用户这句话解析成一笔账，只输出一个 JSON 对象，不要输出任何其他文字。',
    '字段（全部必填）：',
    '- amount: 数字（纯数字，不要带单位）',
    '- type: "expense"（支出）| "income"（收入）| "refund"（退款/报销）',
    '- category: 支出用 [餐饮,交通,购物,娱乐,居住,医疗,教育,通讯,旅行,其他] 之一；收入用 [工资,报销,红包,其他] 之一',
    '- date: "YYYY-MM-DD"（今天或昨天用这两个词时也输出具体日期）',
    '- note: 简短备注（≤20 字，没有就空字符串）',
    '- raw: 用户原话',
    '用户的话：',
    userText.slice(0, 500),
  ].join('\n');
}

/** 一句话是否像记账（编排层的预筛：省 llm 调用）。
 *  记账口令都很短；长句（>40 字）多半是普通聊天，不浪费模型调用。 */
function looksLikeExpense(text) {
  const s = String(text ?? '');
  if (s.length > 40) return false;
  if (s.length < 3) return false;
  return /(花了|付了|支付|买了|消费|记账|记一下|报销|收入|红包|工资|元|块)/.test(s)
    && /\d/.test(s);
}

const ExpenseParse = {
  EXPENSE_CATEGORIES, INCOME_CATEGORIES, CATEGORY_SYNONYMS,
  parseAmount, parseType, parseCategory, parseDate, parseModelReply,
  buildParsePrompt, looksLikeExpense, extractJsonObject, repairJson,
};
