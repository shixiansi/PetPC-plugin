// lib/report.js —— 素材 → 一段 ≤300 字的周报 → storage（只留最新一份）
//
// 三条硬规矩：① **长度预算在喂模型之前**（素材有上限、日记片段有上限、正文再夹 300；反过来
// "先发一个必定超长的 prompt 再截回来"等于花一次请求买一句被截断的话）；② **模型不可用不算失败**
// （被拒/超时/空回复都退回模板——三个数写成几句人话本来就有确定答案）；③ **只留最新一份**
// （一个键，不堆 52 份：这份东西的用法是"现在长什么样"，历史在日记与待办各自那里）。
//
// 去重另有一个人管：lastReportDay。进程内那份只防"同一天里每分钟重来一遍"，重启之后靠 storage。

'use strict';

const KEY_LATEST = 'reports/latest';
const KEY_LAST_DAY = 'state/last-report-day';
/** 正文上限（不含标题）。用户要的是"≤300 字"，用例断言的也是这个数。 */
const REPORT_MAX = 300;
/** 喂模型之前素材的硬上限。prompt 的 text 上限是 4000（手册 §6.6），离它很远是刻意的。 */
const MATERIAL_BUDGET = 520;
const DIARY_EXCERPT = 60;
const MAX_EXCERPTS = 2;

const REPORT_SYSTEM = [
  '你是用户的桌宠，正在写这一周的周报。用简洁的中文直接说事，不要寒暄。',
  '只输出周报正文：不要标题、不要 Markdown、不要列表符号、不要分点，一段话。',
  '数字照素材写，不要编造；素材说"没拿到"的那一块就照实写缺了它，不要猜它的值。',
  '正文不超过 {max} 字。',
].join('\n');

/** 进程内那份"今天生成过没有"/"最新一份"：storage 写不进去时它们仍然撑住界面与回答。 */
let lastReportDay = '';
let latestMemory = null;

/**
 * 素材 → 给模型读的几行。`includeDiary` 是隐私开关：篇数（一个数字）总是有的，**正文**只有用户
 * 勾了才进来——日记是这堆素材里唯一有成段文字的东西，它住在日记插件里，用户没想到会流到周报。
 */
function buildMaterial(collected, includeDiary) {
  const n = collected.numbers || {};
  const lines = [];
  if (n.todoTotal !== null && n.todoTotal !== undefined) {
    lines.push(`待办：共 ${n.todoTotal} 件，已完成 ${n.todoDone} 件，还挂着 ${n.todoOpen} 件，完成率 ${n.todoRate}%。`);
  }
  if (n.focusMinutes !== null && n.focusMinutes !== undefined) {
    lines.push(`专注：今天专注 ${n.focusMinutes} 分钟，共 ${n.focusSessions} 段番茄钟。`);
  }
  if (n.diaryCount !== null && n.diaryCount !== undefined) lines.push(`日记：这周写了 ${n.diaryCount} 篇。`);
  for (const miss of collected.missing || []) lines.push(miss.line);

  let truncated = false;
  const week = Array.isArray(collected.diary) ? collected.diary : [];
  if (includeDiary && week.length) {
    const kept = week.slice(-MAX_EXCERPTS);
    let budget = MATERIAL_BUDGET - lines.join('\n').length - 24;
    for (const entry of kept) {
      const piece = `日记 ${entry.day}：${clip(entry.text, DIARY_EXCERPT)}`;
      if (budget - piece.length - 1 < 0) {
        truncated = true;
        break;
      }
      budget -= piece.length + 1;
      lines.push(piece);
    }
    if (kept.length < week.length) truncated = true;   // 丢了篇数也算截断：模型该知道它没看到全部。
  }

  // 每一行也可能自己超长（对方把一段摘要塞进统计接口）。单行封顶 120，兜住"一行吃满预算"。
  const capped = lines.map((line) => clip(line, 120));
  const joined = capped.join('\n');
  if (joined.length > MATERIAL_BUDGET) {
    return { text: clip(joined, MATERIAL_BUDGET), lines: capped, truncated: true };
  }
  return { text: joined, lines: capped, truncated };
}

/** 素材 → 一次 llm.chat 的 payload。截断在这一步之前已经做完。 */
function buildPrompt(collected, includeDiary, maxChars) {
  const material = buildMaterial(collected, includeDiary);
  const text = [
    `今天是 ${dayKeyOf(now())}，本周是 ${weekLabel(collected.range)}（周一到周日）。`,
    `请据此写一份不超过 ${maxChars} 字的周报。`, '', '素材：', material.text,
  ].join('\n');
  return { text, system: REPORT_SYSTEM.replace('{max}', String(maxChars)), truncated: material.truncated, material: material.text };
}

/** 模型的回答 → 一段话。围栏、标题符号、空行都清掉；剩下的再夹一次（模板不靠这一层兜底）。 */
function parseReportText(raw, maxChars) {
  let s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return '';
  const fenced = s.match(/```(?:text|markdown|md)?\s*([\s\S]*?)```/i);
  if (fenced) s = fenced[1].trim();
  // 300 字里换行很贵（卡片与气泡都只显示一段），而"一段话"本身就是需求。
  s = s.replace(/^#+\s*/gm, '').replace(/\r/g, '').replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return clip(s, maxChars);
}

/** 卡片上那一句结论：三个数说不出来的那个"所以呢"。同时进记录（summary），两处才不会分叉。 */
function conclusionOf(numbers, missing) {
  const n = numbers || {};
  if (Array.isArray(missing) && missing.length >= 3) return '三个来源都没答上来，检查一下插件与授权。';
  const bits = [];
  if (n.todoRate !== null && n.todoRate !== undefined) {
    if (!n.todoTotal) bits.push('待办还是空的');
    else if (n.todoRate >= 80) bits.push('待办收得很干净');
    else if (n.todoRate >= 50) bits.push('待办过半');
    else bits.push('待办还挂着一半');
  }
  if (n.focusMinutes !== null && n.focusMinutes !== undefined) {
    if (n.focusMinutes >= 120) bits.push('专注很稳');
    else if (n.focusMinutes > 0) bits.push('专注有点零碎');
    else bits.push('今天还没开番茄钟');
  }
  if (n.diaryCount !== null && n.diaryCount !== undefined && n.diaryCount >= 5) bits.push('日记没断过');
  return bits.length ? `${bits.join('，')}。` : '这周的数字不多，先攒点素材。';
}

/**
 * 固定模板周报：三个数写成几句人话。模型被拒/没授权/关了润色都走这里，所以它必须**永远**产出
 * 非空的、≤maxChars 的一段话。它**不含缺块那几句**（由 composeReport 追加，模型那一路也得有，
 * 否则"缺了哪一块"就取决于模型今天的心情）。预算不够时按"最不重要的先丢"丢。
 */
function templateReport(collected, includeDiary, maxChars) {
  const n = collected.numbers || {};
  const must = [`本周（${weekLabel(collected.range)}）：`];
  if (n.todoTotal !== null && n.todoTotal !== undefined) {
    must.push(`待办共 ${n.todoTotal} 件，完成 ${n.todoDone} 件，还挂着 ${n.todoOpen} 件，完成率 ${n.todoRate}%。`);
  }
  if (n.focusMinutes !== null && n.focusMinutes !== undefined) {
    must.push(`今天专注 ${n.focusMinutes} 分钟、${n.focusSessions} 段番茄钟。`);
  }
  const diaryLine = n.diaryCount === null || n.diaryCount === undefined ? '' : `这周写了 ${n.diaryCount} 篇日记。`;
  const tail = [];
  if (includeDiary) {
    const weekEntries = Array.isArray(collected.diary) ? collected.diary : [];
    const latestEntry = weekEntries.length ? weekEntries[weekEntries.length - 1] : null;
    if (latestEntry && latestEntry.text) tail.push(`最近一篇写着：${clip(latestEntry.text, 40)}`);
  }
  tail.push(conclusionOf(n, collected.missing));

  // 四档，最不重要的先丢：① 全都要 → ② 丢掉结论/日记片段 → ③ 再丢日记篇数 → ④ 只剩三个数。
  const assemble = (withDiary, withTail) => [...must, withDiary ? diaryLine : '', withTail ? tail.join('') : ''].join('');
  const candidates = [assemble(true, true), assemble(true, false), assemble(false, true), assemble(false, false)];
  for (const candidate of candidates) {
    if (candidate.length <= maxChars) return { text: candidate, dropped: candidate !== candidates[0] };
  }
  return { text: clip(candidates[3], maxChars), dropped: true };
}

/**
 * 一次模型尝试；任何失败都退回模板，**不抛给调用方**（周报必须有正文）。`maxChars` 是**不含缺块
 * 句**的额度——调用方先给那几句留下位置。
 */
async function draftReport(collected, includeDiary, maxChars) {
  const fallback = templateReport(collected, includeDiary, maxChars);
  if (!flag('useModel', true)) return { text: fallback.text, source: 'template', why: '设置里关掉了模型润色' };
  if (!granted.has('llm.chat')) return { text: fallback.text, source: 'template', why: '未获授权 llm.chat' };
  const prompt = buildPrompt(collected, includeDiary, maxChars);
  try {
    const out = await request('llm.chat', { text: prompt.text, system: prompt.system });
    const body = parseReportText(out && out.text, maxChars);
    if (!body) throw new Error('模型没有返回可用的正文');
    return { text: body, source: 'model', why: '' };
  } catch (err) {
    // 拒绝、超时、空回复：同一种处理。这就是"润色是加分项，不是前提"。
    return { text: fallback.text, source: 'template', why: clip(msgOf(err), 80) };
  }
}

/**
 * 正文 = 模型/模板那段 + 缺块那几句，总长 ≤ maxChars。缺块句子**先占位再让正文写**（不是写完再
 * 截）：反过来唯一的结果就是那几句被裁掉，而它正是"缺了哪一块"这个需求的全部。
 */
async function composeReport(collected, includeDiary, maxChars) {
  const missingLines = (collected.missing || []).map((miss) => miss.line);
  const reserve = missingLines.join('').length;
  const draft = await draftReport(collected, includeDiary, Math.max(120, maxChars - reserve));
  return {
    text: clip(String(draft.text || '').trim() + missingLines.join(''), maxChars),
    source: draft.source,
    why: draft.why,
  };
}

/** 最新一份报告（先看 storage，再看进程内那份）。没有就是 null，不是错误。 */
async function readLatest() {
  const stored = await readJSON(KEY_LATEST, null);
  if (stored && typeof stored === 'object' && typeof stored.text === 'string' && stored.text) return stored;
  return latestMemory;
}

/** 重启后唯一还记得"今天生成过"的地方。 */
async function readLastReportDay() {
  const stored = await readJSON(KEY_LAST_DAY, null);
  return stored && typeof stored.day === 'string' ? stored.day : '';
}

/**
 * 生成一份周报并落盘（只留最新一份）。
 *
 * 刻意的顺序：**先写进程内那份，再写 storage**。宿主拒绝写时（没授权、盘满），这一次的结果仍然
 * 要能显示、能回答 plugin.call——否则用户点了「生成」什么都看不到。
 */
async function generateReport() {
  await refreshConfig();
  const range = weekRangeOf(now());
  const week = weekLabel(range);
  const includeDiary = flag('includeDiary', false);
  const collected = await collectWeek(range);
  const numbers = collected.numbers;
  const draft = await composeReport(collected, includeDiary, REPORT_MAX);
  const text = clip(String(draft.text || '').trim(), REPORT_MAX) || clip(`本周（${week}）：没攒到可写的东西。`, REPORT_MAX);
  const record = {
    day: dayKeyOf(now()), at: now(),
    weekStart: dayKeyOf(range.start), weekEnd: dayKeyOf(range.end),
    week, title: `周报 · ${week}`,
    text, source: draft.source, summary: conclusionOf(numbers, collected.missing),
    missing: collected.missing.map((miss) => ({ key: miss.key, label: miss.label, line: miss.line })),
    numbers, diaryIncluded: includeDiary,
  };
  latestMemory = record;
  lastReportDay = record.day;   // 进程内那一半：storage 写失败也不能每分钟重来一遍。
  try {
    await writeJSON(KEY_LATEST, record);
  } catch {
    // 存不下去：这一次的回答与界面仍然有内容（latestMemory 兜着）。
  }
  try {
    await writeJSON(KEY_LAST_DAY, { day: record.day });
  } catch {
    // 同上：重启之后会多生成一份，但不会崩、也不会写坏东西。
  }
  return record;
}
