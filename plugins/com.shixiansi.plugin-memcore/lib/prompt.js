// lib/prompt.js —— 把四层记忆拼成一次提问
//
// WHY 人设是"整段注入"而不是"检索出来的"
//
// L0 不参与竞争：它每一轮都作为 system 的第一段出现。检索式的人设会漂移——同一个人今天冷
// 一点明天热一点，用户立刻能感觉到"这不是它了"。所以人设不在候选里，它在开头。
//
// WHY system 是拼出来的，而不是让宿主加
//
// 宿主的 llm.chat 在没有 system 时会自己加一段"你是谁 + 现在几点 + 你的待办"。这一路是
// 群聊/私聊的回答，会被一屋子人看到，不该顺带把用户的待办清单发出去（手册 §6.6 对
// `system` 的说明正是这件事）。所以这里总是给 system，而且只给记忆里该给的东西。
//
// 上限是硬的：system ≤ 4000 字。拼的次序就是丢的次序——人设在最前，最后被丢的是最不重要的
// "最近发生了什么"。宁可少一段背景，也不能让人设和规则被截断。

'use strict';

/** 每一轮都占掉的一部分：说话的方式，不随记忆变化。 */
function personaBlock() {
  const name = text(cfg.personaName, 40) || '小记';
  // 2000 而不是 1200：人设是最不该被截断的一段（用户实测写到了 722 字，且越靠后的规则越具体）。
  const custom = text(cfg.persona, 2000).trim();
  const lines = [];
  if (custom) {
    // **自定义人设是权威，不再往前塞一句 `你是「名字」。`**
    //
    // 2026-10-30 真机：人设写的是「你是「鲸鱼娘」，群里养着的一只小鲸鱼…」，而 `personaName`
    // 配的是「小记」。原来的代码无条件在前面加 `你是「小记」。`，于是 system 开头两行各说一个
    // 身份——模型只好折中成没有性格的腔调，用户的原话是"回复的还是不对味"。人设自己会说自己是谁；
    // 只有它压根没提配置里那个名字时，才补一句。
    // 判据是"人设有没有自己声明身份"，不是"有没有出现配置里的名字"——人设写「你是「鲸鱼娘」」时
    // 名字当然不等于 personaName（小记），但它已经把身份说清了，再补一句就是两个身份。
    const declaresSelf = /你是\s*[「『"']?[^，。！？\n]{1,20}[」』"']?/.test(custom);
    if (!declaresSelf) lines.push(`你是「${name}」。`);
    lines.push(custom);
  } else {
    lines.push(`你是「${name}」。`);
    lines.push('话不多，但记得住事：别人说过的细节你会记得，也不特意炫耀。');
    // 这句只在**没有自定义人设**时加：它是一句粗糙的兜底，和用户那份精细的说话规则并列时只会
    // 拉平语气（人设说"两句话、二十来字"，这句说"短句、口语"——后者更弱，模型会向它靠）。
    lines.push('说话像人在聊天：短句、口语，不加小标题、不列清单、不写"作为一个AI"。');
  }
  // 「只用记忆回答」这条曾经让查到的资料被无视（2026-10-30：萌娘百科的释义明明在 system 里，
  // 模型仍答"是不是打错了"）。所以这里给它留一个明确的例外，而不是让每个提供方自己写一段
  // "我不是记忆、请用我"来对抗人设。
  lines.push('用下面给你的记忆回答；记忆里没有的事就说不知道，不要编。'
    + '如果另外给了【资料】开头的段落，那是刚查到的，比记忆更权威，优先按它说。');
  lines.push('不要复述记忆本身，也不要提到"记忆""上下文"这些词。');
  return lines.join('\n');
}

/** 这个人是谁（L4）。空画像返回空串，不占额度。 */
function profileBlock(profile) {
  if (!profile) return '';
  const lines = [];
  if (profile.name) lines.push(`称呼：${profile.name}`);
  if (profile.stage) lines.push(`关系：${profile.stage}`);
  if (profile.prefs && profile.prefs.length) lines.push(`偏好：${profile.prefs.join('；')}`);
  if (profile.habits && profile.habits.length) lines.push(`习惯：${profile.habits.join('；')}`);
  if (!lines.length) return '';
  return ['【关于这个人】', ...lines].join('\n');
}

/** 这个会话之前发生的事（L2）。 */
function summaryBlock(summary) {
  if (!summary || !summary.text) return '';
  return ['【这个会话之前聊过】', summary.text].join('\n');
}

/**
 * 值得长期记住的事（L3）。
 *
 * 只放最近几条：情节记忆的价值在"最近的、还没过期的"，把 40 条全塞进去等于没有重点。
 */
function episodesBlock(episodes) {
  if (!Array.isArray(episodes) || !episodes.length) return '';
  const recent = episodes.slice(-6).filter((e) => e && typeof e.text === 'string' && e.text !== '');
  if (!recent.length) return '';
  return ['【记得这些事】', ...recent.map((e) => `- ${e.text}`)].join('\n');
}

/** 按"先保人设与规则、再保画像与摘要、最后保情节"的次序截断到 budget 字。 */
function fitBlocks(blocks, budget) {
  const parts = [];
  let used = 0;
  for (const block of blocks) {
    if (!block) continue;
    const cost = block.length + 2;
    if (used + cost > budget) break;
    parts.push(block);
    used += cost;
  }
  return parts.join('\n\n');
}

/**
 * 拼出这一轮要用的 system。
 *
 * @param {object} state  loadRole() 的返回值
 * @param {object} profile L4
 * @param {string} [hint] 调用方这一轮的临时指令（例如 QQ 插件"这次是你主动开口"）。
 *   它不是记忆、也不入盘：只活在这一轮，所以放在最末、且占最小的地方。
 * @param {string} [extraRule] 一次性追加的规则（例如联网搜索的 [SEARCH] 约定）。
 *   与 hint 一样只活在这一轮；放在最末，因为它是"这一轮怎么答"的事。
 * @returns {string} ≤ 4000 字
 */
function buildSystem(state, profile, hint, extraRule) {
  const blocks = [
    personaBlock(),
    profileBlock(profile),
    summaryBlock(state && state.summary),
    episodesBlock(state && state.episodes),
  ];
  const extra = text(hint, 200).trim();
  if (extra) blocks.push(`【这一轮】${extra}`);
  const rule = text(extraRule, 600).trim();
  if (rule) blocks.push(rule);
  return fitBlocks(blocks, 4000);
}

/**
 * 把 L1 的往来整理成 llm.chat 要的 history。
 *
 * 两条上限都由宿主执行（32 条 / 合计 12000 字），这里先剪一遍，因为被宿主悄悄丢掉最旧的几条
 * 会让"模型突然忘了刚才说什么"变成一个无法解释的现象——不如在这里按同样的规则剪，并且
 * 剪掉的正是最旧的。
 */
function buildHistory(turns) {
  const out = [];
  let chars = 0;
  for (let i = (Array.isArray(turns) ? turns : []).length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (!turn || typeof turn.text !== 'string' || turn.text === '') continue;
    const role = turn.role === 'assistant' ? 'assistant' : 'user';
    const body = text(turn.text, 1500);
    chars += body.length;
    if (out.length >= 32 || chars > 12000) break;
    out.unshift({ role, text: body });
  }
  return out;
}
