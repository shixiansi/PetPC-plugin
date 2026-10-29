// lib/chat.js —— 一次问答：拼上下文、问模型、把这一轮记下来
//
// 这是 plugin.call 的 `chat` 方法。接入端插件（QQ/OneBot/任何别的）只需要知道三件事：
// 把 roleId、谁说的、说了什么交过来；等答复；把它发回平台。人设、记忆、晋升、画像全都
// 在这里，所以换一个接入端不用搬任何数据。
//
// 这个文档不认识任何具体平台：payload 里没有 GROUP_MESSAGE / C2C_MESSAGE 这类词，只有
// roleId（会话）与 userId（谁）。任何一个平台只要能把这两样映射过来，就能接上同一份记忆。
//
// WHY 每次问答都要先重读设置
//
// 设置可以在**另一个进程**里改（控制中心的插件页），而这个文档是常驻的。缓存一份设置到天荒地老
// 的结果是"我改了人设，回答还是旧口吻"，而且没有任何地方能看出原因。

'use strict';

/** 每个会话一条队列：同一会话的两次问答不并发读写同一批文件（跨会话仍然并行）。 */
const roleQueues = new Map();

/**
 * 把一件事排进某个会话的队列。
 *
 * 代价是同一群里"两条消息同时到"会变成先后处理（这正是想要的：它们要一起进上下文），
 * 收益是 L1 / 摘要 / 情节的三次读写不会互相覆盖。
 */
function serialized(roleKey, job) {
  const previous = roleQueues.get(roleKey) || Promise.resolve();
  const run = previous.then(job, job);
  // 队列本身只需要"上一件事结束了没有"，它成功还是失败由返回的 promise 告诉调用方。
  roleQueues.set(roleKey, run.then(() => {}, () => {}));
  return run;
}

/** 重读设置（见文件头）。读不到就沿用上一次的：一次 config.get 失败不该让对话停摆。 */
async function refreshConfig() {
  try {
    const out = await request('config.get', {});
    const values = (out && out.values) || {};
    cfg = Object.assign({}, values);
  } catch {
    // 沿用旧值。
  }
}

/** 记下"上一次长期动作哪里失败了"，给插件页看——插件自己没有办法写宿主的日志。 */
async function noteError(where, err) {
  try {
    await writeJSON('state/lastError', {
      at: now(),
      where,
      message: String(err && err.message ? err.message : err),
    });
  } catch {
    // 连这个都写不进去时没什么可做的了。
  }
}

async function clearError() {
  try {
    await writeJSON('state/lastError', { at: 0, where: '', message: '' });
  } catch {
    // 同上。
  }
}

/** 把模型的回答整理成一句能发出去的话：去首尾空白、压掉多余空行、按字数上限截断。 */
function tidyReply(raw) {
  const body = String(raw === undefined || raw === null ? '' : raw)
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const max = num('replyMaxChars', 40, 2000, 240);
  if (body.length <= max) return body;
  const cut = body.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('\n'));
  return stop > max * 0.5 ? cut.slice(0, stop + 1) : `${cut}…`;
}

/** 问一次模型。失败时抛宿主自己的句子（未获权限 / 额度用完 / 连不上），由调用方决定怎么讲。 */
async function askModel(prompt) {
  const out = await request('llm.chat', {
    text: text(prompt.text, 4000),
    system: text(prompt.system, 4000),
    history: prompt.history || [],
  });
  const reply = out && typeof out.text === 'string' ? out.text : '';
  if (!reply.trim()) throw new Error('模型没有返回内容（检查模型配置或每日额度）');
  return reply;
}

// --- `chat`：plugin.call 的方法 -------------------------------------------------

/**
 * 处理一次 `plugin.call { method: "chat" }`。
 *
 * @param {object} payload {roleId, userId, userName?, text, platform?}
 * @returns {Promise<object>} {text, meta}
 */
async function handleChat(payload) {
  const roleId = text(payload && payload.roleId, 80).trim();
  const line = text(payload && payload.text, 4000).trim();
  if (!roleId) throw new Error('chat 需要 roleId：它决定用哪一份记忆（会话）');
  if (!line) throw new Error('chat 的 text 是空的');

  await refreshConfig();
  const roleKey = roleKeyOf(roleId);
  const userKey = userKeyOf(payload.userId);
  const who = text(payload.userName, 40) || '某人';

  return serialized(roleKey, async () => {
    const state = await loadRole(roleKey);
    const profile = await loadProfile(userKey);

    const reply = tidyReply(await askModel({
      text: line,
      system: buildSystem(state, profile, payload && payload.hint),
      history: buildHistory(state.turns),
    }));

    const at = now();
    const turns = state.turns
      .concat([{ role: 'user', text: line, at, who, uid: userKey }])
      .concat([{ role: 'assistant', text: reply, at }]);
    await saveTurns(roleKey, turns);
    await appendChains(roleKey, { at, roleId, kind: 'in', who, text: text(line, 160) });
    await appendChains(roleKey, { at, roleId, kind: 'out', who: 'bot', text: text(reply, 160) });

    // 晋升是"这一轮已经答完了"之后的事：它要花一次模型请求，而用户在等的是那一句回答。
    // 排到下一个宏任务，失败只写一条 noteError —— 记忆整理失败不该让对话失败。
    const overflow = overflowOf(turns);
    if (overflow) {
      setTimeout(() => {
        digestRole(roleKey, roleId, overflow.old, state.summary, userKey).catch((err) => {
          noteError('digest', err);
        });
      }, 0);
    }

    return {
      text: reply,
      meta: {
        roleId,
        turns: Math.min(turns.length, turnsCap()),
        episodes: state.episodes.length,
        summarised: Boolean(state.summary && state.summary.text),
      },
    };
  });
}

// --- 晋升：L1 → L2/L3，再 → L4 ---------------------------------------------------

/**
 * 把一段要挤出去的旧往来压成摘要与事实。
 *
 * 一次请求同时产出两层（L2 摘要 + L3 事实），因为这两样本来就是同一个动作的两面：**理解这段
 * 话讲了什么**。分两次问只会多花一次钱，还会让摘要和事实互相矛盾。
 */
async function digestRole(roleKey, roleId, oldTurns, previousSummary, userKey) {
  const material = oldTurns
    .filter((t) => t && typeof t.text === 'string' && t.text !== '')
    .slice(-24)
    .map((t) => `${t.role === 'assistant' ? '你' : t.who || '对方'}：${text(t.text, 200)}`)
    .join('\n');

  const system = [
    '你在整理聊天记录，供以后回答时参考。只输出 JSON，不要解释。',
    '形状：{"summary":"…","facts":["…"]}',
    `summary 是这个会话到目前为止的摘要，不超过 ${summaryCap()} 字：谁在关心什么、聊到哪一步、有什么未完成的事。`,
    'facts 是最多 3 条值得长期记住的客观事实（某人的偏好、约定、重要事件），每条一句话、不超过 40 字；没有就给空数组。',
    '不要写猜测，不要把客套话当事实。',
  ].join('\n');

  const prompt = [
    previousSummary && previousSummary.text ? `已有摘要：${previousSummary.text}` : '已有摘要：（无）',
    '要整理的往来：',
    material,
  ].join('\n');

  const raw = await askModel({ text: prompt, system, history: [] });
  const digest = parseDigest(raw);
  const at = now();

  if (digest.summary) {
    const previousCount = previousSummary && Number(previousSummary.digests) ? Number(previousSummary.digests) : 0;
    await saveSummary(roleKey, {
      text: text(digest.summary, summaryCap()),
      at,
      digests: previousCount + 1,
      lastUserId: userKey,
      lastRoleId: roleId,
    });
    await appendChains(roleKey, { at, roleId, kind: 'summary', who: 'bot', text: text(digest.summary, 160) });
  }

  if (digest.facts.length) {
    const state = await loadRole(roleKey);
    const episodes = state.episodes.concat(digest.facts.map((fact) => ({
      at,
      text: text(fact, 120),
      valence: valenceOf(fact),
      roleId,
    })));
    await saveEpisodes(roleKey, episodes);
  }

  await clearError();
  await maybeBuildProfile(roleKey, roleId, userKey);
}

/**
 * 攒够几次摘要就把它们合成一份用户画像。
 *
 * 画像与摘要的材料是同一批，区别在**问题**：摘要在讲"这个会话"，画像在讲"这个人"。所以它按
 * userKey 存，跨会话共用——这是四层里唯一跨出 roleId 的一层，也是它必须由用户看得见的地方
 * （插件页里能读、能清）。
 */
async function maybeBuildProfile(roleKey, roleId, userKey) {
  const every = num('profileEvery', 0, 50, 3);
  if (every <= 0) return;
  const state = await loadRole(roleKey);
  const digests = state.summary && Number(state.summary.digests) ? Number(state.summary.digests) : 0;
  if (digests === 0 || digests % every !== 0) return;

  const existing = await loadProfile(userKey);
  const system = [
    '你在维护一份用户画像，供以后对话时参考。只输出 JSON，不要解释。',
    '形状：{"prefs":["…"],"habits":["…"],"stage":"…"}',
    'prefs 是这个人明确表达过的偏好，最多 6 条；habits 是反复出现的行为习惯，最多 6 条；',
    'stage 是你们现在的关系阶段，一句话（例如"刚认识，还客气"）。每条不超过 30 字。',
    '只写材料里有的，不要凭空补。',
  ].join('\n');

  const prompt = [
    existing && (existing.prefs.length || existing.habits.length || existing.stage)
      ? `已有画像：${JSON.stringify({ prefs: existing.prefs, habits: existing.habits, stage: existing.stage })}`
      : '已有画像：（无）',
    state.summary && state.summary.text ? `最近的摘要：${state.summary.text}` : '',
    state.episodes.length
      ? `记得的事：${state.episodes.slice(-8).map((e) => e.text).join('；')}`
      : '',
    '请给出更新后的画像。',
  ].filter(Boolean).join('\n');

  const raw = await askModel({ text: prompt, system, history: [] });
  const body = parseObject(raw);
  if (!body) {
    // 画像解析不出来就保留旧的：一份坏画像比没有画像更糟（它会被每一轮注入）。
    await noteError('profile', new Error(`画像不是 JSON：${text(raw, 80)}`));
    return;
  }
  await saveProfile(userKey, {
    name: existing.name,
    prefs: Array.isArray(body.prefs) ? body.prefs : [],
    habits: Array.isArray(body.habits) ? body.habits : [],
    stage: typeof body.stage === 'string' ? body.stage : '',
  });
  await appendChains(roleKey, { at: now(), roleId, kind: 'profile', who: 'bot', text: '更新了用户画像' });
}

// --- `seed`：把一个接入端已经攒下的记忆并进来 --------------------------------------
//
// 为什么需要它：一个已经跑了一段时间的 QQ 机器人有自己的群记忆。用户打开"记忆核心"的那一刻，
// 那些记忆会**悄无声息地**不再生效——它没有丢，但也没有人再读它，而用户看到的是"它把我记得的
// 事忘了"。所以给接入端一个显式的入口，把那些事实搬进来（一次，用户点的），而不是让它在切换
// 的瞬间蒸发。
//
// 三块内容各自有边界：
//   · facts 去重后并进 L3（同一句话不重复记两遍）；
//   · summary 只在**本来没有摘要**时写入 —— 覆盖一份已经由模型压过的摘要，是拿旧东西盖新东西；
//   · 全程 append 到角色链，留下"这次导入过"的痕迹（账本里也有一份）。

async function handleSeed(payload) {
  const roleId = text(payload && payload.roleId, 80).trim();
  if (!roleId) throw new Error('seed 需要 roleId：它决定并进哪个会话');
  await refreshConfig();
  const roleKey = roleKeyOf(roleId);
  const state = await loadRole(roleKey);

  const facts = (Array.isArray(payload.facts) ? payload.facts : [])
    .map((f) => text(f, 120).trim())
    .filter(Boolean)
    .slice(0, 60);
  const known = new Set(state.episodes.map((e) => String(e && e.text ? e.text : '')));
  const added = [];
  for (const fact of facts) {
    // 去重同时覆盖两种重复：已经记过的，以及**这一批自己内部**重复的（接入端的导出里
    // 常有同一句话被记了两次）。
    if (known.has(fact)) continue;
    known.add(fact);
    added.push({ at: now(), text: fact, valence: valenceOf(fact), roleId });
  }

  if (added.length) await saveEpisodes(roleKey, state.episodes.concat(added));

  const summary = text(payload && payload.summary, summaryCap()).trim();
  const wroteSummary = Boolean(summary) && !(state.summary && state.summary.text);
  if (wroteSummary) {
    await saveSummary(roleKey, { text: summary, at: now(), digests: 0, seeded: true });
  }

  await appendChains(roleKey, {
    at: now(),
    roleId,
    kind: 'seed',
    who: 'import',
    text: `导入了 ${added.length} 条事实${wroteSummary ? '与一份摘要' : ''}`,
  });

  return {
    imported: added.length,
    skipped: facts.length - added.length,
    summary: wroteSummary,
    episodes: state.episodes.length + added.length,
  };
}

// --- `forget`：清掉一个会话 -------------------------------------------------------
//
// 不是 plugin.call 的方法（接入端不需要它），只是插件页那个按钮的实现。放在这里是因为它
// 与上面几个函数共用同一批键名——两处拼字符串迟早会拼错一个。

async function forgetRole(roleKey) {
  await removeKey(rolePath(roleKey, MEM_TURNS));
  await removeKey(rolePath(roleKey, MEM_SUMMARY));
  await removeKey(rolePath(roleKey, MEM_EPISODES));
  await removeKey(rolePath(roleKey, MEM_CHAIN));
  // 全局账本**不动**：它是"发生过什么"的记录，删掉一个会话的上下文不等于这件事没发生。
  // 这也是全局链唯一的对外可见后果：它不会让任何回答变长。
}
