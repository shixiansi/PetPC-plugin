// lib/diary.js —— 日记生成：素材 → 一次模型请求 → {text, mood} → storage
//
// Prompt 编排的三条硬规则：
//
//   1. **长度预算**：素材（chat 行 / 待办 / 专注数 / 昨天的日记引用）全部拼进一条
//      prompt，硬上限 3800 字（llm.chat 的 text 上限 4000，留缓冲）——超了先砍素材，
//      不把"发出注定被拒的请求"当成兜底；
//   2. **JSON 输出**：让模型只回 {"text": "...", "mood": "happy|tired|excited|calm"}，
//      解析是健壮的：裸 JSON / ```json 围栏 / 前后有废话都接得住；接不住就重试一次
//      （只重试解析，不再花一次请求——解析失败的原文留着给下次）；
//   3. **昨天的日记**：作为「昨天你写过：…」注入，让日记有连续性；注入本身受预算管。

'use strict';

// MEMCORE_TARGET 在 lib/collect.js 里声明（经典脚本共享一个全局作用域，同一常量只声明一次）。

const DIARY_ROLE = 'diary';
const PROMPT_BUDGET = 3800;

const MOODS = ['happy', 'tired', 'excited', 'calm'];

const DIARY_SYSTEM = [
  '你是用户的桌宠，正在写当天的日记（第一人称「我」，把用户叫「主人」）。',
  '只输出 JSON，不要解释。形状：{"text":"…","mood":"happy|tired|excited|calm"}',
  'text 是 ≤{max} 字的日记正文：口语化、有温度、写今天具体发生的事，不要列清单。',
  'mood 从四个里选一个最贴的：happy（开心）、tired（累了）、excited（兴奋）、calm（平静）。',
  '素材很少的日子就老实写「今天很安静」，不要编造。',
].join('\n');

/** 从一段模型输出里抠出 JSON 对象（裸 / ```json 围栏 / 前后有废话都接得住）。 */
function parseDiaryJSON(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  // 1) 直接 parse。
  try {
    return normalizeDiary(JSON.parse(s));
  } catch { /* 继续 */ }
  // 2) ```json … ``` 围栏。
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return normalizeDiary(JSON.parse(fenced[1].trim()));
    } catch { /* 继续 */ }
  }
  // 3) 第一个 { 到最后一个 } 之间。
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return normalizeDiary(JSON.parse(s.slice(start, end + 1)));
    } catch { /* 放弃 */ }
  }
  return null;
}

/** 形状校验与归一：text 必须非空，mood 必须在词表里（不认识 → calm）。 */
function normalizeDiary(body) {
  if (!body || typeof body !== 'object') return null;
  const textBody = typeof body.text === 'string' ? body.text.trim() : '';
  if (!textBody) return null;
  const mood = MOODS.includes(String(body.mood)) ? String(body.mood) : 'calm';
  return { text: textBody, mood };
}

/** 素材 → prompt。返回 {prompt, truncated}；超预算时从素材尾部砍。 */
function buildPrompt(material, maxChars, yesterdayDiary) {
  const staticBlocks = [];
  if (material.todosDone.length) {
    staticBlocks.push(`【今天完成的待办】${material.todosDone.join('；')}`);
  }
  if (material.todosPending > 0) {
    staticBlocks.push(`【还挂着没做的】${material.todosPending} 件`);
  }
  if (material.focusCount > 0) {
    staticBlocks.push(`【今天的专注】完成了 ${material.focusCount} 段番茄钟`);
  }
  if (!material.memOk) {
    staticBlocks.push('【今天的对话】（记忆核心没装或没说话——别提对话的事）');
  }
  const staticLen = staticBlocks.join('\n\n').length;

  // 预算分配：总预算 − 静态块 − 固定框架 − 昨天的日记引用（最多 200 字）。
  // chat 行**逐条**计入：从最旧的开始丢，直到总数进预算。这不是"拼接后量一次"——
  // 字符串拼好后量，砍一条不会让已经拼好的字符串变短（2026-10-31 修掉的死循环）。
  let budget = PROMPT_BUDGET - 300 - staticLen
    - (yesterdayDiary && yesterdayDiary.text ? Math.min(text(yesterdayDiary.text, 200).length + 12, 220) : 0);
  const kept = [];
  let truncated = false;
  for (let i = 0; i < material.chat.length; i += 1) {
    const line = material.chat[i];
    if (budget - line.length - 1 < 0) {
      truncated = true;
      break;
    }
    budget -= line.length + 1;
    kept.push(line);
  }
  // 超预算的丢弃发生在**尾部**（素材按时间正序排列时丢的是最旧的）。
  const chatBlock = kept.length ? ['【今天的对话】', ...kept].join('\n') : '';
  let body = [chatBlock, ...staticBlocks].filter(Boolean).join("\n\n");

  if (yesterdayDiary && yesterdayDiary.text) {
    const quote = `【昨天你写过】${text(yesterdayDiary.text, 200)}`;
    if (body.length + quote.length + 20 < PROMPT_BUDGET) {
      body = `${body}\n\n${quote}`;
    }
  }

  const prompt = [
    `今天是 ${material.day}。以下是我攒下的今天，请据此写今天的日记：`,
    body,
  ].join('\n\n');
  return { prompt, truncated, system: DIARY_SYSTEM.replace('{max}', String(maxChars)) };
}

/** 问一次模型（走记忆核心的 chat，让日记也进它的记忆）。 */
async function askDiary(prompt, system) {
  const out = await request('plugin.call', {
    target: MEMCORE_TARGET,
    method: 'chat',
    payload: { roleId: DIARY_ROLE, userId: 'desktop', userName: '主人', text: prompt, hint: '这是日记请求：只回 JSON' },
  });
  const reply = out && typeof out.text === 'string' ? out.text : '';
  if (!reply.trim()) throw new Error('记忆核心没有返回内容（检查它的模型配置）');
  return reply;
}

/** 日记的存储键（按天）：diary/2026-10-31。 */
function diaryKey(day) {
  return `diary/${String(day || '').replace(/[^0-9-]/g, '')}`;
}

/** 最近一篇日记（panel 显示 + 注入用）。 */
async function loadRecentDiaries(limit) {
  const index = await readJSON('diary/index', []);
  const days = (Array.isArray(index) ? index : []).slice(-Math.max(1, limit || 7));
  const out = [];
  for (const day of days) {
    const entry = await readJSON(diaryKey(day), null);
    if (entry && entry.text) out.push(entry);
  }
  return out;
}

/** 把一篇日记追加进索引（去重、按天排序）。 */
async function indexDiary(day) {
  const index = await readJSON('diary/index', []);
  const next = (Array.isArray(index) ? index : []).filter((d) => d !== day).concat(day).sort();
  await writeJSON('diary/index', next.slice(-400));
}

/** 超过 keepDays 的日记删除（0 = 永久）。 */
async function pruneOldDiaries(keepDays) {
  const days = Math.max(0, Number(keepDays) || 0);
  if (days <= 0) return 0;
  const index = await readJSON('diary/index', []);
  const cutoff = now() - days * 24 * 3600 * 1000;
  let removed = 0;
  const kept = [];
  for (const day of Array.isArray(index) ? index : []) {
    const ts = Date.parse(`${day}T00:00:00`);
    if (Number.isFinite(ts) && ts < cutoff) {
      await request('storage.remove', { key: diaryKey(day) }).catch(() => {});
      removed += 1;
    } else {
      kept.push(day);
    }
  }
  if (removed) await writeJSON('diary/index', kept);
  return removed;
}

/**
 * 一次完整的写日记流程（定时器与 write_now 走同一条）。
 *
 * @returns {Promise<object>} {day, text, mood, truncated, prevMood}
 */
async function writeDiary() {
  await refreshConfig();
  const maxChars = num('maxChars', 100, 600, 300);

  const material = await collectToday(1200);
  const yesterday = yesterdayKey(now());
  const recent = await loadRecentDiaries(7);
  const yesterdayDiary = recent.find((d) => d.day === yesterday) || null;

  const { prompt, truncated, system } = buildPrompt(material, maxChars, yesterdayDiary);
  const raw = await askDiary(prompt, system);
  const diary = parseDiaryJSON(raw);
  if (!diary) {
    // 一次解析失败不值得再花一次请求：把失败写进状态，下一拍重试（runDigestCycle 式）。
    throw new Error(`日记不是 JSON：${text(raw, 120)}`);
  }

  const entry = {
    day: material.day,
    at: now(),
    text: text(diary.text, maxChars),
    mood: diary.mood,
    prevMood: yesterdayDiary ? yesterdayDiary.mood : '',
    truncated,
  };
  await writeJSON(diaryKey(entry.day), entry);
  await indexDiary(entry.day);
  void pruneOldDiaries(num('keepDays', 0, 3650, 90));

  // 发布快照（桌宠生态可读）。
  try {
    await request('share.set', {
      name: 'diary-latest',
      value: JSON.stringify({ at: entry.at, day: entry.day, mood: entry.mood, preview: text(entry.text, 120) }),
    });
  } catch {
    // 牌盘写不进去不影响日记本身。
  }

  // 弹气泡（桌宠在场才显示；权限没给就安静）。
  if (flag('bubbleDiary', true) && granted.has('pet.bubble')) {
    try {
      await request('bubble.say', { text: `今天的日记写好了（${moodLabel(entry.mood)}）：${text(entry.text, 80)}` });
    } catch {
      // 气泡不是关键路径。
    }
  }

  return entry;
}

/** 情绪标签的中文（气泡用）。 */
function moodLabel(mood) {
  return { happy: '开心', tired: '有点累', excited: '兴奋', calm: '平静' }[mood] || '平静';
}

// --- 定时器 ------------------------------------------------------------------------

let diaryTimer = null;

/** 每分钟看一次钟；到了 diaryTime 且今天还没写就写。 */
function scheduleDiary() {
  if (diaryTimer) clearInterval(diaryTimer);
  diaryTimer = setInterval(() => {
    void diaryTick().catch(() => {});
  }, 60000);
}

async function diaryTick() {
  const material = await refreshConfig().then(() => {
    const { h, min } = (typeof parseDiaryTime === 'function' ? parseDiaryTime : () => ({ h: 23, min: 0 }))(cfg.diaryTime);
    const d = new Date();
    const target = { h, min };
    return { due: d.getHours() === target.h && d.getMinutes() >= target.min, day: dayKeyOf(now()) };
  });
  if (!material.due) return;
  const existing = await readJSON(diaryKey(material.day), null);
  if (existing && existing.text) return; // 今天已经写过
  await writeDiary();
}

function stopDiaryTimer() {
  if (diaryTimer) {
    clearInterval(diaryTimer);
    diaryTimer = null;
  }
}
