// lib/proactive.js —— 主动开口、攒批自主插话、提示词
//
// 两种"没人叫它也说一句"的路径，以及 systemPromptFor / withBudget。
//
// 从原来的 app.js 按节**原样搬出来**（1.12 的重构）：内容逐字未改，只是换了个文件。
// 经典 script 共享同一个全局作用域，所以这里不用 import/export；
// 加载顺序写在 panel.html 里（顺序 = 原来的文件顺序，所以原有的依赖关系不变）。
'use strict';

// --- 主动开口 ----------------------------------------------------------------

/**
 * The proactive ticker: the bot occasionally says something nobody asked for.
 *
 * `proactiveMinutes` is an AVERAGE gap, not a schedule. Once a minute the plugin
 * draws a 1/N chance, so the gaps are irregular and average N minutes - as opposed
 * to the same offset past every hour, which is the difference between "it
 * occasionally joins in" and "it is a cron job with a personality prompt".
 *
 * Two refusals keep it from being obnoxious, and both are cheap:
 *
 *   - it never speaks into a room nobody has used within the last N minutes. That is
 *     the only reason `touchGroup` exists: an idle group has nothing to join, and a
 *     bot that starts a conversation with itself is the trait people remove.
 *   - it shares the per-group single-flight and cooldown with the answering path, so
 *     it cannot talk over itself or land on top of a reply that is still streaming.
 */
let proactiveTimer = 0;

function startProactive() {
  stopProactive();
  const minutes = number(state.cfg.proactiveMinutes, 0, 0, 1440);
  if (minutes <= 0) return;
  proactiveTimer = setInterval(() => {
    void speakProactively();
  }, 60_000);
}

function stopProactive() {
  if (proactiveTimer) {
    clearInterval(proactiveTimer);
    proactiveTimer = 0;
  }
}

async function speakProactively() {
  const minutes = number(state.cfg.proactiveMinutes, 0, 0, 1440);
  if (minutes <= 0 || state.ws !== 'open') return;
  // The hazard draw. 1/N per minute means "once every N minutes on average".
  if (Math.random() >= 1 / Math.max(1, minutes)) return;

  const now = Date.now();
  const cutoff = now - minutes * 60_000;
  const cooldown = number(state.cfg.cooldownSec, 5, 0, 600) * 1000;
  const candidates = [...state.groups.values()].filter((group) => {
    const id = String(group.id);
    return (group.lastAt || 0) >= cutoff &&
      !state.busy.has(id) &&
      now - (state.lastAnswer.get(id) || 0) >= cooldown;
  });
  if (candidates.length === 0) return;

  const group = candidates[Math.floor(Math.random() * candidates.length)];
  const groupID = String(group.id);
  const turns = number(state.cfg.contextTurns, 8, 0, 40);

  state.busy.add(groupID);
  state.lastAnswer.set(groupID, now);
  try {
    const history = await loadHistory(groupID, turns);
    const energy = await settleEnergy(groupID, false);
    const notes = await loadNotes(groupID);
    const index = flag(state.cfg.autoCollectStickers, true) ? await loadStickerIndex() : [];
    const system = proactivePromptFor(groupID, group.name, {
      energy,
      notes,
      candidates: pickStickerCandidates(index, history.slice(-2).map((turn) => turn.text).join(' ')),
    });
    const cue = '（没有人在问你。接着上面的话题，主动说一句。）';
    const maxChars = number(state.cfg.replyMaxChars, 300, 20, 2000);
    const askProactive = (text, sys, turns) => request('llm.chat', { text, system: sys, history: turns });
    let res = await askWithFallback({
      asked: cue,
      system,
      history,
      images: [],
      groupID,
      groupName: group.name,
      chat: askProactive,
    });
    let rawReply = String((res && res.text) || '');
    let parsed = parseReply(rawReply);
    let say = tidyReply(parsed.text, maxChars);
    if (!say && !parsed.silent) {
      // Same empty-content retry as the answering path: a silent proactive tick is
      // indistinguishable from a bot that has stopped working.
      note(`群 ${groupID} 主动开口的回复是空的，重试一次`);
      res = await askWithFallback({
        asked: cue,
        system,
        history,
        images: [],
        groupID,
        groupName: group.name,
        chat: askProactive,
      });
      rawReply = String((res && res.text) || '');
      parsed = parseReply(rawReply);
      say = tidyReply(parsed.text, maxChars);
    }
    await recordProbe(groupID, rawReply);
    noteMissingFence(groupID, rawReply);
    // 主动开口也可能只是"顺手记一句然后不说话"，所以指令先落地。
    await applyMemoryWrites(groupID, parsed);
    await applyTodoWrites(groupID, parsed);
    const armedProactive = await applyReminders(groupID, parsed.remind);
    if (armedProactive) note(`群 ${groupID}：记下了 ${armedProactive} 条定时提醒`);
    if (parsed.silent || !say) {
      await adjustEnergy(groupID, parsed.energy);
      if (parsed.silent) note(`群 ${groupID} 主动开口时决定不说话`);
      return;
    }
    // No quote: there is no question to quote, and a reply segment needs a
    // message_seq the model's line does not have.
    await sendGroupReply(groupID, null, say);
    await remember(groupID, group.name, null, say, turns);
    await spendEnergy(groupID, Array.from(say).length, parsed.energy);
    note(`在群 ${groupID} 主动说了一句（${Array.from(say).length} 字${parsed.meme ? "，配表情" : "，无表情"}）`);
    await maybeSendSticker(groupID, parsed.meme, parsed.tag);
  } catch (err) {
    state.counts.errors += 1;
    note(`群 ${groupID} 主动开口失败：${(err && err.message) || err}`);
  } finally {
    state.busy.delete(groupID);
  }
}

/**
 * 攒批自主插话（P3）。
 *
 * 和数据流的区别：被 @ 时是"一条消息 → 一次调用"；这里是"**一批**消息 → 最多一次调用"，而且
 * 大多数时候那次调用会以 `{"silent":true}` 收场。所以花费的上限是**窗口**给的，不是消息量给的。
 *
 * 四道闸，全在本地判（0 成本），全过才发请求：
 *   ① 距上次评估 ≥ `batchWindowSec`（默认 120 秒）
 *   ② 缓冲里 ≥ `BATCH_MIN_MESSAGES` 条（默认 3；冷清的群因此一次都不会调）
 *   ③ 这个群这一小时评估次数 < `batchMaxPerHour`（默认 8，硬上限）
 *   ④ 社交能量 > `BATCH_ENERGY_FLOOR`（0.35：累了就不多想事）
 * 另外话题必须还热（最新一条 5 分钟内），否则那一批直接扔掉。
 */
const CHATTER_MAX_LINES = 30;
const BATCH_MAX_LINES = 10;
const BATCH_MIN_MESSAGES = 3;
const BATCH_ENERGY_FLOOR = 0.35;
const BATCH_TICK_MS = 15_000;
const BATCH_STALE_MS = 5 * 60_000;

let batchTimer = 0;

/** 记一句"背景聊天"：只有**没被回答**的群消息才进来（被回答的那条已经在这轮提问里了）。 */
function noteChatter(groupID, speaker, text) {
  const line = String(text || '').trim();
  if (!line) return;
  const rows = state.chatter.get(String(groupID)) || [];
  rows.push({ at: Date.now(), speaker: String(speaker || '某人'), text: line.slice(0, 300) });
  state.chatter.set(String(groupID), rows.slice(-CHATTER_MAX_LINES));
}

function startBatch() {
  stopBatch();
  if (!flag(state.cfg.batchEnabled, true)) return;
  batchTimer = setInterval(() => {
    void batchTick();
  }, BATCH_TICK_MS);
}

function stopBatch() {
  if (batchTimer) {
    clearInterval(batchTimer);
    batchTimer = 0;
  }
}

/** 每 15 秒过一次闸；过闸的群把这一批交给 batchEvaluate（一批只调一次模型）。 */
async function batchTick() {
  if (!flag(state.cfg.batchEnabled, true) || state.ws !== 'open') return;
  const windowMs = number(state.cfg.batchWindowSec, 120, 30, 3600) * 1000;
  const perHour = number(state.cfg.batchMaxPerHour, 8, 0, 200);
  if (perHour <= 0) return;
  const now = Date.now();
  for (const [groupID, lines] of [...state.chatter]) {
    if (!groupAllowed(groupID)) continue;
    if (lines.length < BATCH_MIN_MESSAGES) continue;
    if (state.busy.has(groupID)) continue;
    const book = state.batchAt.get(groupID) || { at: 0, hourStart: 0, count: 0 };
    if (now - book.at < windowMs) continue;
    if (now - book.hourStart > 3_600_000) {
      book.hourStart = now;
      book.count = 0;
    }
    if (book.count >= perHour) continue;
    const newest = lines[lines.length - 1];
    if (now - (newest && newest.at ? newest.at : 0) > BATCH_STALE_MS) {
      // 话题已经凉了：这一批不该再拿去问，直接丢掉，也别花钱。
      state.chatter.delete(groupID);
      continue;
    }
    const energy = await loadEnergy(groupID);
    if (energy < BATCH_ENERGY_FLOOR) {
      state.chatter.delete(groupID);
      continue;
    }
    book.at = now;
    book.count += 1;
    state.batchAt.set(groupID, book);
    // 这一批已经交给模型了：清掉缓冲，后面的消息重新攒。
    state.chatter.delete(groupID);
    state.busy.add(groupID);
    try {
      await batchEvaluate(groupID, lines.slice(-BATCH_MAX_LINES), energy);
    } finally {
      state.busy.delete(groupID);
    }
  }
}

const BATCH_CUE = '（没有人在问你，也没人叫你。接着上面这些群友的话说一句；不想说就只回 {"silent":true}。）';

/** 一批消息 → 一次调用。沉默是合法且常见的答案。 */
async function batchEvaluate(groupID, lines, energy) {
  const group = state.groups.get(String(groupID)) || {};
  const groupName = String(group.name || '');
  const history = await loadHistory(groupID, 2);
  const notes = await loadNotes(groupID);
  const system = batchSystemPrompt(groupID, groupName, energy, lines, notes);
  const chat = (text, sys, turns) => request('llm.chat', { text, system: sys, history: turns });
  const res = await askWithFallback({
    asked: BATCH_CUE,
    system,
    history,
    images: [],
    groupID,
    groupName,
    chat,
  });
  const rawReply = String((res && res.text) || '');
  const parsed = parseReply(rawReply);
  await recordProbe(groupID, rawReply);
  noteMissingFence(groupID, rawReply);
  await applyMemoryWrites(groupID, parsed);
  await applyTodoWrites(groupID, parsed);
  const armedBatch = await applyReminders(groupID, parsed.remind);
  if (armedBatch) note(`群 ${groupID}：记下了 ${armedBatch} 条定时提醒`);
  const maxChars = number(state.cfg.replyMaxChars, 300, 20, 2000);
  let say = tidyReply(parsed.text, maxChars);
  // 和回答路径同一条兜底：正文整条是图库编号时，别把编号发进群。
  const absorbed = await absorbStickerIdText(groupID, say);
  say = absorbed.text;
  if (absorbed.meme) parsed.meme = absorbed.meme;
  if (parsed.silent || !say) {
    await adjustEnergy(groupID, parsed.energy);
    if (parsed.meme && !parsed.silent) await maybeSendSticker(groupID, parsed.meme, parsed.tag);
    note(`群 ${groupID}：看了 ${lines.length} 条新消息，${parsed.silent ? '决定不插嘴' : parsed.meme ? '只发了一张表情' : '没说出话'}`);
    return false;
  }
  const mentionBatch = await mentionSegmentsFor(groupID, parsed.at, '');
  await sendGroupReply(groupID, null, mentionBatch.leftovers.length
    ? `${mentionBatch.leftovers.map((name) => `@${name}`).join(' ')} ${say}`
    : say, mentionBatch.segments);
  await remember(groupID, groupName, null, say, number(state.cfg.contextTurns, 8, 0, 40));
  await spendEnergy(groupID, Array.from(say).length, parsed.energy);
  note(`群 ${groupID}：自己插了一句（${Array.from(say).length} 字，看了 ${lines.length} 条新消息，能量 ${Math.round((await loadEnergy(groupID)) * 100)}）`);
  await maybeSendSticker(groupID, parsed.meme, parsed.tag);
  return true;
}

/**
 * 攒批用的提示词：比回答时短得多。
 *
 * 刻意不带表情候选和待收藏（那是花钱的大头，而"插一句嘴"用不上它们），只带人设、规则、
 * 这个群的记忆要点、能量状态和那几条消息。
 */
function batchSystemPrompt(groupID, groupName, energy, lines, notes) {
  const maxChars = number(state.cfg.replyMaxChars, 300, 20, 2000);
  const persona = String(state.cfg.persona || '').trim() || DEFAULT_PERSONA;
  const chat = ['【群友刚才在聊】', ...(lines || []).map((line) => `${stripControl(line.speaker)}：${stripControl(line.text)}`)]
    .join('\n');
  let notesBlock = '';
  if (Array.isArray(notes) && notes.length) {
    let text = '【你记得这个群的事】\n';
    for (const row of notes.slice(-8)) {
      const line = `- ${stripControl(row.text)}\n`;
      if (Array.from(text + line).length > 400) break;
      text += line;
    }
    notesBlock = text.trim();
  }
  const blocks = [
    persona,
    [
      '规则：',
      `- 你在 QQ 群「${stripControl(groupName || groupID)}」里，下面是群友刚才在聊的东西。`,
      '- 是你自己想插一句：必须接住他们聊的那件**具体的事**（谁在说、说了什么），不要泛泛感慨，不许编造。',
      `- 一句话，最多 ${Math.min(40, maxChars)} 字；不复述、不总结、不解释你为什么开口。`,
      '- **大多数时候不该插嘴**：插不上、话题已经说完、或者只是两个人在对话，就只回 {"silent":true}。',
      '- 要说话时：每条回复以唯一一个 ```json 围栏结尾（没要记的就写 {}）。',
    ].join('\n'),
    `【状态】${energyLabel(energy)}`,
    notesBlock,
    chat,
  ];
  return blocks.filter(Boolean).join('\n\n');
}

/**
 * Watches the saved settings and applies them to the RUNNING bot.
 *
 * Without this the plugin read its settings once, at startup, and the market's "保存
 * 配置" changed only the file - so an edit appeared to do nothing until the whole pet
 * was restarted. That is the exact shape of the report "I set it to reply to
 * everything, and it still only answers @": the dashboard showed the SAVED values
 * (the workshop re-reads them), while the frame kept the ones it had loaded.
 *
 * A 10s poll is enough: `config.get` is a small local file read, nothing here touches
 * the network, and a settings change is not a realtime event. A change to the address
 * or the token re-dials; a change to the trigger rules or the proactive interval takes
 * effect on the next message.
 */
const CONFIG_POLL_MS = 10_000;
let configTimer = 0;
/** The settings the bot is actually running with, as a comparable string. */
let appliedConfig = '';

function startConfigWatch() {
  if (configTimer) return;
  configTimer = setInterval(() => {
    void refreshConfig();
  }, CONFIG_POLL_MS);
}

async function refreshConfig() {
  if (!granted.has('plugin.config')) return;
  let values = null;
  try {
    const res = await request('config.get', {});
    values = (res && res.values) || {};
  } catch {
    return;
  }
  const next = { ...DEFAULTS, ...values };
  const signature = JSON.stringify(next);
  if (signature === appliedConfig) return;
  const previous = state.cfg;
  appliedConfig = signature;
  state.cfg = next;

  // A new address or token means the socket is pointed at the wrong place.
  if (next.server !== previous.server || next.accessToken !== previous.accessToken) {
    const endpoints = endpointsFor(next.server, next.accessToken);
    state.base = endpoints.base;
    state.eventUrl = endpoints.eventUrl;
    try {
      await request('ws.open', { url: state.eventUrl, token: next.accessToken });
      note('配置已更新：地址或令牌变了，正在重新连接');
    } catch (err) {
      note(`配置已更新，但重连失败：${(err && err.message) || err}`);
    }
  } else {
    note('配置已更新并生效');
  }

  if (next.proactiveMinutes !== previous.proactiveMinutes) {
    startProactive();
  }
  // 攒批的开关变了才重挂定时器：它每 15 秒空转一次，关掉就不该留着。
  if (flag(next.batchEnabled, true) !== flag(previous.batchEnabled, true)) {
    startBatch();
  }
  if (view === 'workshop') renderFacts(next);
}

/**
 * The system prompt for a line nobody asked for.
 *
 * The rules are written against a failure that took real testing to find: without
 * "必须接住群友聊的那件具体的事", a proactive line drifts into stage directions about
 * itself ("我先去囤点米饭") instead of joining the conversation.
 *
 * A line saying "最后一条是提示语，不是群友说的话" was tried and REMOVED: with it the
 * model concluded it had not seen the room at all and answered "没看到你们刚才聊啥".
 * Telling it which message is a stage direction is worse than leaving the cue as one.
 */
function proactivePromptFor(groupID, groupName, ctx) {
  const maxChars = number(state.cfg.replyMaxChars, 300, 20, 2000);
  const persona = String(state.cfg.persona || '').trim();
  const info = ctx || {};
  const energy = Number.isFinite(info.energy) ? info.energy : energyBaseline();
  const rules = [
    '规则：',
    `- 你在 QQ 群「${groupName || groupID}」里，上面几条是群友刚才的聊天记录。`,
    '- 没有人 @ 你、也没有人在提问：是你自己想插一句。',
    '- 必须接住群友聊的那件具体的事（谁在说、说了什么），说一句自己的看法、追问或者吐槽；不要泛泛感慨，也不要编造记录里没出现的时间、地点、人。',
    '- 不复述别人的话，不总结，不解释你为什么开口，也不提「插话」「接话」这件事，直接说内容。',
    `- 最多 ${maxChars} 字，简体中文口语，不要 Markdown、不要列表。`,
    '- **每条回复都必须以唯一一个 ```json 围栏结尾**（同聊天时一样，没要记的就写 {}）：{"meme":"表情 id","remember":["…"]}；不想说就只回 {"silent":true}。',
    `- 现在是 ${new Date().toLocaleString('zh-CN', { hour12: false })}。`,
  ].join('\n');

  let notesBlock = '';
  const notes = Array.isArray(info.notes) ? info.notes : [];
  if (notes.length) {
    let text = '【你记得这个群的事】\n';
    for (const row of notes.slice(-12)) {
      const line = `- ${row.text}\n`;
      if (Array.from(text + line).length > NOTES_INJECT_CHARS) break;
      text += line;
    }
    notesBlock = text.trim();
  }
  let stickerBlock = '';
  const candidates = Array.isArray(info.candidates) ? info.candidates : [];
  if (candidates.length) {
    stickerBlock = ['【表情包】想配表情时，把**下面某一个 id 填进围栏的 meme**（正文里不要写编号，正文是给群里看的话）：',
      ...candidates.map((row) => `- ${row.hash} ${row.tag}：${row.description || '（没描述）'}`)].join('\n');
  }
  return withBudget([
    persona || DEFAULT_PERSONA,
    rules,
    `【你现在的状态】${energyLabel(energy)}`,
    notesBlock,
    stickerBlock,
  ], 3800);
}

/** Groups a message names: Milky reports the group's name in the event. */
function groupNameOf(data) {
  const group = data.group || {};
  // 群名里真会有不可打印字符（真机上一个群叫「喵窝<$ÿĀ><$ÿĀ">…」），原样塞进提示词只会添乱。
  return stripControl(group.group_name || group.name).slice(0, 40);
}

