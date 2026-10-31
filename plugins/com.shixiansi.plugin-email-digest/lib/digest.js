// lib/digest.js —— 抓取 → 分类 → 摘要 → 推送
//
// 一轮摘要（digestOnce）分四步：
//   1. fetchUnread：桥上抓最新 maxMailCount 封未读（原始 RFC822 文本）；
//   2. 本地预筛：垃圾词命中的直接标为垃圾，不进模型；
//   3. classify：把余下的打包交给记忆核心，要一个 JSON（每封 urgent|normal|spam + 理由），
//      紧急的让模型当场给一句摘要（一次调用同时做完分类与总结——分两次只是多花钱）；
//   4. deliver：气泡（紧急+常规的计数与紧急摘要）、语音（可选）、落盘。
//
// 模型解析失败的兜底：整批按「常规」处理，摘要写成"模型没有给出分类"，绝不因为
// 一次坏的 JSON 让用户错过邮件。

'use strict';

const MEMCORE = 'com.shixiansi.plugin-memcore';
const DIGEST_ROLE = 'email-digest';
const DIGEST_LOG_KEY = 'state/digest-log';
const DIGEST_LOG_MAX = 30;
const LAST_RUN_KEY = 'state/last-run';

const digestState = {
  busy: false,
  lastError: '',
  lastRun: null,     // {at, total, urgent, normal, spam, summary}
  todayRun: '',      // 'YYYY-MM-DD'（自动推送每天只跑一次）
};

/**
 * 抓取 + 解析未读邮件。返回 [{raw, mail}]。
 */
async function fetchUnread() {
  const base = mailBase();
  if (!base) {
    digestState.lastError = '没有配置邮件桥地址';
    return [];
  }
  try {
    const out = await request('net.fetch', {
      url: `${base}/unread?limit=${num('maxMailCount', 1, 50, 10)}`,
      method: 'GET',
    });
    if (!out || out.status !== 200) {
      digestState.lastError = `桥 /unread 返回 ${out ? out.status : '无响应'}`;
      return [];
    }
    const parsed = JSON.parse(String(out.body || '{}'));
    const raws = Array.isArray(parsed.mails) ? parsed.mails : [];
    return raws
      .filter((raw) => typeof raw === 'string' && raw.trim())
      .slice(0, num('maxMailCount', 1, 50, 10))
      .map((raw) => ({ raw, mail: MimeParser.parse(raw) }));
  } catch (err) {
    digestState.lastError = `抓取失败：${text(err && err.message, 120)}`;
    return [];
  }
}

/** 本地垃圾预筛：命中词直接判垃圾（不进模型）。 */
function localSpam(mail) {
  const words = String(cfg.spamKeywords || '')
    .split(/[,，\n]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const haystack = `${mail.subject}\n${mail.body}\n${mail.fromEmail}`.toLowerCase();
  for (const word of words) {
    if (haystack.includes(word)) return word;
  }
  return null;
}

/**
 * 分类 + 总结（一次模型调用）。
 * items: [{mail}]；返回 [{kind:'urgent'|'normal'|'spam', summary?, reason?}]（与入参对齐）。
 * 任何解析失败都返回 null（调用方按"全部常规"兜底）。
 */
async function classifyBatch(items) {
  if (!flag('classifyEnabled', true) || !items.length) return null;
  const blocks = items.map((item, i) => {
    const m = item.mail;
    return [
      `【邮件 ${i + 1}】`,
      MimeParser.toPrompt(m, 1200),
    ].join('\n');
  });

  const prompt = [
    '你是邮件分拣助手。下面是最近的未读邮件，请对每一封分类：urgent（紧急：需要今天回复/行动、来自真实的人、有时间点）、normal（常规：通知、账单、订阅内容）、spam（垃圾：营销、钓鱼、与我无关）。',
    '只输出 JSON，不要解释。形状：{"mails":[{"n":1,"kind":"urgent","summary":"一句话（urgent 必填，30 字内）","reason":"一句话"}]}',
    'mails 要覆盖每一封输入；n 对应【邮件 n】。',
    '',
    ...blocks,
  ].join('\n');

  try {
    const out = await request('plugin.call', {
      target: MEMCORE,
      method: 'chat',
      payload: { roleId: DIGEST_ROLE, userId: 'mailbox', userName: '邮箱', text: prompt },
    });
    return parseClassify(String((out && out.text) || ''), items.length);
  } catch (err) {
    digestState.lastError = `记忆核心没有回答：${text(err && err.message, 120)}`;
    return null;
  }
}

/** 宽容解析：截取第一个 {…}，按 n 对齐；缺的当 normal。 */
function parseClassify(raw, count) {
  const body = String(raw || '');
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
  const list = Array.isArray(parsed && parsed.mails) ? parsed.mails : null;
  if (!list) return null;
  const byN = new Map();
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const n = Number(row.n);
    if (!Number.isFinite(n) || n < 1 || n > count) continue;
    byN.set(n, row);
  }
  const out = [];
  for (let i = 1; i <= count; i += 1) {
    const row = byN.get(i);
    const kind = row && ['urgent', 'normal', 'spam'].includes(row.kind) ? row.kind : 'normal';
    out.push({
      kind,
      summary: row && typeof row.summary === 'string' ? row.summary.slice(0, 80) : '',
      reason: row && typeof row.reason === 'string' ? row.reason.slice(0, 80) : '',
    });
  }
  return out;
}

/**
 * 跑一轮摘要。返回 {total, urgent, normal, spam, summary, lines}。
 * memcore 不在/模型失败时返回降级摘要（全部按常规，只有计数）。
 */
async function digestOnce({ push = true } = {}) {
  if (digestState.busy) return null;
  digestState.busy = true;
  digestState.lastError = '';
  try {
    const fetched = await fetchUnread();
    const items = [];
    for (const item of fetched) {
      const spamWord = localSpam(item.mail);
      items.push({ ...item, localSpam: spamWord });
    }

    const modelItems = items.filter((item) => !item.localSpam);
    const verdicts = await classifyBatch(modelItems.map((item) => ({ mail: item.mail })));

    let vi = 0;
    const results = [];
    for (const item of items) {
      if (item.localSpam) {
        results.push({ mail: item.mail, kind: 'spam', summary: '', reason: `本地垃圾词：${item.localSpam}` });
        continue;
      }
      const verdict = verdicts && verdicts[vi] ? verdicts[vi] : { kind: 'normal', summary: '', reason: verdicts ? '' : '模型没有给出分类' };
      vi += 1;
      results.push({ mail: item.mail, kind: verdict.kind, summary: verdict.summary, reason: verdict.reason });
    }

    const urgent = results.filter((r) => r.kind === 'urgent');
    const normal = results.filter((r) => r.kind === 'normal');
    const spam = results.filter((r) => r.kind === 'spam');

    const summaryLines = [];
    if (!fetched.length) summaryLines.push('当前没有未读邮件，收件箱很干净。');
    if (urgent.length) {
      summaryLines.push(`有 ${urgent.length} 封紧急邮件：`);
      for (const r of urgent) {
        summaryLines.push(`· ${r.mail.subject || '(无主题)'}（${r.mail.fromEmail || r.mail.from || '?'}）${r.summary ? `：${r.summary}` : ''}`);
      }
    }
    if (normal.length) summaryLines.push(`常规 ${normal.length} 封。`);
    if (spam.length) summaryLines.push(`已过滤垃圾 ${spam.length} 封。`);
    if (fetched.length && !verdicts) summaryLines.push('（模型没有给出分类，这一批先按常规处理。）');
    const summary = summaryLines.join('\n');

    const record = {
      at: now(),
      total: fetched.length,
      urgent: urgent.length,
      normal: normal.length,
      spam: spam.length,
      summary,
      mails: results.map((r) => ({
        from: r.mail.fromEmail || r.mail.from,
        subject: r.mail.subject,
        kind: r.kind,
        summary: r.summary,
        reason: r.reason,
      })),
    };
    digestState.lastRun = record;
    await appendLog(record);

    if (push && fetched.length) {
      await deliver(record);
    }
    return record;
  } finally {
    digestState.busy = false;
  }
}

/** 推送：气泡（ pet.bubble）+ 语音（可选）。 */
async function deliver(record) {
  const tasks = [];
  if (granted.has('pet.bubble')) {
    tasks.push(request('bubble.say', { text: `邮件摘要：${record.urgent ? `${record.urgent} 封紧急。` : '没有紧急邮件。'}${record.normal ? `常规 ${record.normal} 封。` : ''}` }).catch((err) => {
      digestState.lastError = `气泡没有弹出来：${text(err && err.message, 120)}`;
    }));
  }
  if (flag('speakDigest', false)) {
    tasks.push(speak(record.summary).catch((err) => {
      digestState.lastError = `语音播报失败：${text(err && err.message, 120)}`;
    }));
  }
  await Promise.all(tasks);
}

/** 与 live-danmaku 同一 TTS 形状：POST /tts → base64 WAV → audio.save → audio.play。 */
async function speak(textIn) {
  const base = String(cfg.ttsBaseUrl || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const refPath = String(cfg.voiceRefPath || '').trim();
  if (!base || !refPath) throw new Error('语音配置不完整（需要语音服务地址与参考音频路径）');
  const spoken = Array.from(textIn).slice(0, 300).join('');
  const out = await request('net.fetch', {
    url: `http://${base}/tts`,
    method: 'POST',
    encoding: 'base64',
    body: JSON.stringify({
      text: spoken,
      text_lang: 'zh',
      ref_audio_path: refPath,
      prompt_lang: 'zh',
      streaming_mode: false,
    }),
  });
  if (!out || out.status !== 200 || !out.body) throw new Error(`语音服务返回 ${out ? out.status : '无响应'}`);
  const name = `digest-${Date.now().toString(36)}`;
  await request('audio.save', { name, data: out.body });
  await request('audio.play', { name });
}

async function appendLog(record) {
  try {
    const log = await readJSON(DIGEST_LOG_KEY, []);
    const next = (Array.isArray(log) ? log : []).concat([record]).slice(-DIGEST_LOG_MAX);
    await writeJSON(DIGEST_LOG_KEY, next);
  } catch {
    // 日志失败不影响摘要。
  }
}

async function loadLog() {
  const log = await readJSON(DIGEST_LOG_KEY, []);
  return (Array.isArray(log) ? log : []).slice(-12).reverse();
}

/** 每天一次的自动推送判定（由常驻帧的定时器调用）。 */
async function autoTick() {
  const due = today();
  if (digestState.todayRun === due) return false;
  const hhmm = String(cfg.digestTime || '08:00').trim();
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const nowD = new Date();
  const target = new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate(), Number(m[1]), Number(m[2]));
  if (nowD < target) return false;
  digestState.todayRun = due;
  await writeJSON(LAST_RUN_KEY, { day: due, at: now() });
  await digestOnce({ push: true });
  return true;
}

function mailBase() {
  const raw = String(cfg.bridgeUrl || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, '');
  return `http://${raw.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

function digestSnapshot() {
  return {
    busy: digestState.busy,
    lastError: digestState.lastError,
    lastRun: digestState.lastRun,
    todayRun: digestState.todayRun,
  };
}
