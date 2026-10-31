// app.js —— 记账：入口、协议泵、LLM 解析编排（重试链）、看板
//
// 一个文档，两种身份：
//
//   workshop    控制中心插件页：当月看板（环形图+折线图）、流水、手动记账。
//   background  桌宠常驻帧：答 chat_on_message——聊天插件把"像记账的话"转过来，
//               这里调 llm.chat 解析 → 入账 → 回一句确认。也答 stats / month。
//
// LLM 解析的重试链（题目核心：容错与重试，账本不写脏数据）：
//   第 1 次：原话 + 严格 JSON 指令
//   第 2 次：带上一次的坏输出 + 指名错误（"金额要纯数字"），再试
//   第 3 次失败：放弃，回用户一句"没记上"，绝不写猜测值

'use strict';

const V = 1;
const HOST = window.parent;
let nextId = 1;
const pending = new Map();

const PERM = {
  storage: 'storage',
  config: 'plugin.config',
  call: 'plugin.call',
  share: 'plugin.share',
  llm: 'llm.chat',
  borrow: 'llm.borrow',
  bubble: 'pet.bubble',
};

const PARSE_MAX_ATTEMPTS = 2; // llm 最多试 2 次（省额度）；解析层本身有 4 层兜底

function request(method, payload) {
  const id = `r${nextId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    HOST.postMessage({ v: V, type: 'request', id, method, payload: payload ?? {} }, '*');
  });
}

let granted = new Set();
let self = { pluginId: '', slot: '' };
let cfg = {};
let store = null;
let currentMonth = '';
let boardEntries = [];

window.addEventListener('message', (event) => {
  if (event.source !== HOST) return;
  const data = event.data;
  if (!data || data.v !== V) return;
  switch (data.type) {
    case 'init':
      void onInit(data);
      break;
    case 'response': {
      const slot = pending.get(data.id);
      if (!slot) return;
      pending.delete(data.id);
      if (data.ok) slot.resolve(data.result);
      else slot.reject(new Error(data.error || '宿主拒绝了这次调用'));
      break;
    }
    case 'theme':
      document.documentElement.dataset.theme = data.theme === 'light' ? 'light' : 'dark';
      break;
    case 'call':
      void onCall(data);
      break;
    default:
      break;
  }
});

// --- LLM 解析编排 -----------------------------------------------------------------

/** 一次 llm.chat 调用。失败抛错。 */
async function askModel(prompt) {
  const out = await request('llm.chat', { text: prompt, system: ExpenseParse.buildParsePrompt('').split('用户的话：')[0].trim() });
  return String((out && out.text) || '');
}

/**
 * 解析一句话 → 一笔账。重试链：
 *   attempt 1：正常问
 *   attempt 2：把上次的原始输出与失败原因放进 prompt，点名要改什么
 * @returns {{ok:true, entry, attempts}|{ok:false, reason, attempts, lastRaw}}
 */
async function parseWithRetry(userText, now = Date.now()) {
  let lastRaw = '';
  let lastReason = '';
  const attempts = PARSE_MAX_ATTEMPTS;
  for (let i = 0; i < attempts; i += 1) {
    let prompt = ExpenseParse.buildParsePrompt(userText);
    if (i > 0) {
      prompt += `\n\n你上一次的输出（不符合要求）：\n${lastRaw.slice(0, 400)}\n问题：${lastReason}\n请重新输出一个**合法的 JSON 对象**（amount 用纯数字）。`;
    }
    let reply;
    try {
      reply = await askModel(prompt);
    } catch (err) {
      // 模型挂了（未配置/超时/限流）：不重试——换多少次都一样挂。
      return { ok: false, reason: `模型调用失败：${String(err && err.message || err)}`, attempts: i + 1, lastRaw: '' };
    }
    lastRaw = reply;
    const parsed = ExpenseParse.parseModelReply(reply, now);
    if (parsed.ok) return { ok: true, entry: parsed.entry, attempts: i + 1 };
    lastReason = parsed.reason;
  }
  return { ok: false, reason: lastReason || '解析失败', attempts, lastRaw };
}

// --- 入账 -------------------------------------------------------------------------

async function recordEntry(userText, source, now = Date.now()) {
  if (!granted.has(PERM.llm)) return { ok: false, reason: '未授予 llm.chat：无法解析自然语言' };
  if (!granted.has(PERM.storage)) return { ok: false, reason: '未授予 storage：无法写账本' };
  const result = await parseWithRetry(userText, now);
  if (!result.ok) return result;
  await ExpenseLedger.ledgerAppend(store, result.entry);
  if (granted.has(PERM.bubble) && source === 'chat') {
    request('bubble.say', {
      text: `${result.entry.type === 'income' ? '收到' : '记下'}${result.entry.category} ${result.entry.amount} 元（${result.entry.day}）`,
    }).catch(() => {});
  }
  return result;
}

// --- plugin.call ----------------------------------------------------------------

const CALL_HANDLERS = {
  /** 聊天插件转来的疑似记账话语。payload {text} → {ok, entry?, reason?} */
  chat_on_message: async (payload) => {
    const text = String(payload && payload.text || '').trim();
    if (!text) throw new Error('chat_on_message 需要 {text}');
    if (!ExpenseParse.looksLikeExpense(text)) {
      return { ok: false, reason: 'not-expense' }; // 不是记账：调用方走原流程
    }
    const out = await recordEntry(text, 'chat');
    if (!out.ok) return { ok: false, reason: out.reason };
    return { ok: true, entry: { amount: out.entry.amount, category: out.entry.category, type: out.entry.type, day: out.entry.day } };
  },
  /** 月度统计（别的插件要看"这个月花了多少"）。payload {month?} */
  month: async (payload) => {
    const month = String(payload && payload.month || ExpenseLedger.ledgerMonthOf(todayStr()));
    const { entries, badLines } = await ExpenseLedger.ledgerMonthEntries(store, month);
    const agg = ExpenseLedger.ledgerAggregate(entries, month);
    return { month, ...agg, badLines };
  },
  /** 健康检查：本月笔数 + 账本坏行数。 */
  stats: async () => {
    const month = ExpenseLedger.ledgerMonthOf(todayStr());
    const { entries, badLines } = await ExpenseLedger.ledgerMonthEntries(store, month);
    return { month, count: entries.length, badLines, expense: ExpenseLedger.ledgerAggregate(entries, month).totals.expense };
  },
};

async function onCall(data) {
  const ticket = typeof data.ticket === 'string' ? data.ticket : '';
  if (!ticket) return;
  const method = typeof data.method === 'string' ? data.method : '';
  const handler = CALL_HANDLERS[method];
  if (!handler) {
    postCallResult(ticket, false, new Error(
      `记账插件不认识方法 ${method || '(空)'}：它只回答 ${Object.keys(CALL_HANDLERS).join(' / ')}`));
    return;
  }
  try {
    postCallResult(ticket, true, await handler(data.payload === undefined ? {} : data.payload));
  } catch (err) {
    postCallResult(ticket, false, err);
  }
}

function postCallResult(ticket, ok, value) {
  const message = { v: V, type: 'call-result', ticket, ok: Boolean(ok) };
  if (ok) message.result = value === undefined ? null : value;
  else message.error = String(value && value.message ? value.message : value);
  HOST.postMessage(message, '*');
}

// --- 工坊页 ---------------------------------------------------------------------

function todayStr(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
}

async function renderBoard(month) {
  currentMonth = month;
  const { entries, badLines } = await ExpenseLedger.ledgerMonthEntries(store, month);
  boardEntries = entries;
  const agg = ExpenseLedger.ledgerAggregate(entries, month);
  ExpenseWorkshop.xwsRenderBoard(month, agg);
  ExpenseWorkshop.xwsRenderLedger(entries, (id) => void removeEntry(id));
  if (badLines > 0) {
    ExpenseWorkshop.xwsSetStatus(`注意：账本里有 ${badLines} 行坏数据已跳过（不影响其他账目）`, 'danger');
  } else {
    ExpenseWorkshop.xwsSetStatus('');
  }
}

async function removeEntry(id) {
  await ExpenseLedger.ledgerRemove(store, id);
  await renderBoard(currentMonth);
}

async function addManual() {
  const els = ExpenseWorkshop.XWS.els;
  const amountRaw = String(els['manual-amount'].value || '').trim();
  const amount = ExpenseParse.parseAmount(amountRaw);
  if (amount === null || amount === 0) {
    ExpenseWorkshop.xwsSetStatus('金额要是大于 0 的数字', 'danger');
    return;
  }
  const entry = {
    id: `m${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
    at: Date.now(),
    day: todayStr(),
    type: els['manual-type'].value || 'expense',
    amount: Math.round(amount * 100) / 100,
    category: els['manual-category'].value || '其他',
    note: String(els['manual-note'].value || '').slice(0, 60),
    raw: '',
  };
  await ExpenseLedger.ledgerAppend(store, entry);
  els['manual-amount'].value = '';
  els['manual-note'].value = '';
  ExpenseWorkshop.xwsSetStatus(`已入账：${entry.category} ${entry.amount} 元`);
  await renderBoard(currentMonth);
}

async function onInit(data) {
  self = {
    pluginId: data.pluginId || '',
    slot: (data.surface && data.surface.slot) || '',
  };
  granted.clear();
  for (const name of data.granted || []) granted.add(name);
  document.documentElement.dataset.theme = data.theme === 'light' ? 'light' : 'dark';

  if (granted.has(PERM.config)) {
    try {
      const out = await request('config.get', {});
      cfg = Object.assign({}, (out && out.values) || {});
    } catch { cfg = {}; }
  }

  store = ExpenseLedger.ledgerCreateStore(request);

  if (self.slot !== 'workshop') return;

  ExpenseWorkshop.xwsCollectEls();
  ExpenseWorkshop.xwsRenderMonthOptions();
  const canLedger = granted.has(PERM.storage);
  ExpenseWorkshop.XWS.els['manual-add']?.addEventListener('click', () => void addManual());
  ExpenseWorkshop.XWS.els['month-prev']?.addEventListener('click', () => void renderBoard(shiftMonth(currentMonth, -1)));
  ExpenseWorkshop.XWS.els['month-next']?.addEventListener('click', () => void renderBoard(shiftMonth(currentMonth, 1)));
  if (!canLedger) {
    ExpenseWorkshop.xwsSetStatus('未授予 storage：不能记账', 'danger');
    return;
  }
  await renderBoard(ExpenseLedger.ledgerMonthOf(todayStr()));
}

HOST.postMessage({ v: V, type: 'ready' }, '*');

/** 测试接缝。 */
window.__expenses = Object.freeze({
  request,
  handlers: CALL_HANDLERS,
  parseWithRetry,
  recordEntry,
  addManual,
  removeEntry,
  renderBoard,
  parse: ExpenseParse,
  ledger: ExpenseLedger,
  charts: ExpenseCharts,
  workshop: ExpenseWorkshop,
  todayStr,
  shiftMonth,
  snapshot: () => ({
    slot: self.slot,
    granted: [...granted],
    cfg: { ...cfg },
    currentMonth,
    boardEntries: boardEntries.length,
  }),
});
