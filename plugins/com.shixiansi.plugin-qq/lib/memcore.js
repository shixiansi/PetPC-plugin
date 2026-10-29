// lib/memcore.js —— 把"答什么"交给记忆核心（可选）
//
// WHAT THIS FILE IS
//
// 这个 QQ 插件原本自己拼 prompt、自己记群记忆（memory.js）。打开配置里的「记忆核心」之后，
// **这一句怎么回**交给另一个插件：
//
//   Milky ──ws──▶ 本插件 ──plugin.call{method:"chat"}──▶ com.shixiansi.plugin-memcore ──▶ 模型
//                    ▲                                          │
//                    └──────────── result.text ──────────────────┘
//
// 于是人设、最近往来、摘要、长期记忆、用户画像只有一份，住在核心的私有目录里；再加一个接入端
// （OneBot 那类）时不用搬任何数据。
//
// WHAT THIS FILE DOES NOT DO
//
// 它不改这个插件的任何既有路径：配置里的开关默认关着，关着的时候 bili.js 的回答路径一行没变。
// 打开之后的取舍是明写着的（面板上也有同一段话）：
//
//   · 本插件的人设（`persona`）与群记忆设置不再参与回答——人设在核心里；
//   · **主动开口 / 攒批插话停下**：它们要靠结构化回复里的 `silent` 与表情选择才成立，而核心
//     只给一句话（见 proactive.js 里的两处早退）；
//   · 看图不在核心模式里：图片过不了 plugin.call（它是 JSON，不是多模态），所以把"这条带了
//     几张图"如实告诉核心，让它别装作看过；
//   · 表情包只剩随机贴一张（模型点名那张要靠围栏）。
//
// WHY 仍然写本插件自己的记忆
//
// `remember()` / notes 照旧写。它们不再参与回答，但**关掉开关就立刻退回原样**——这一点比省几次
// 写入重要得多：用户试完不喜欢，应该只是把开关拨回去，而不是发现历史空了。

'use strict';

/** 记忆核心的 id 与方法。必须与 manifest 的 `callTargets` 逐字一致。 */
const CORE_PLUGIN = 'com.shixiansi.plugin-memcore';
const CORE_CHAT = 'chat';
const CORE_SEED = 'seed';

/** 一个群 = 核心里的一个会话。前缀把两代接入端分开（OneBot 那份是 `onebot-group-`）。 */
function coreRoleId(groupID) {
  return `qq-group-${String(groupID)}`;
}

/** 开关。默认关：已经装好这个插件的人不该因为更新而突然换了大脑。 */
let coreMode = false;

/**
 * 开关存在**插件自己的 storage** 里，而不是 manifest 的 config 里。
 *
 * 两个理由，第二个是硬的：
 *   1. 这一页（控制中心的插件页）本来就是它唯一的开关位置，卡片上还有"导入群记忆"这个动作；
 *   2. manifest 的 config 有上限（宿主侧 40 项），这个插件已经用满了——再加一项就装不上。
 *      而这条规则是宿主的，不该为了一个插件挪。
 *
 * 代价是"改完要等下一次轮询"：常驻帧每 10 秒读一次（proactive.js 的 startConfigWatch），
 * 所以拨开关最多 10 秒生效，而不是立刻。
 */
const CORE_MODE_KEY = 'state/core';

function coreEnabled() {
  return coreMode;
}

/** 读一次开关（常驻帧的轮询与插件页都会调）。 */
async function refreshCoreMode() {
  let next = false;
  try {
    const res = await request('storage.get', { key: CORE_MODE_KEY });
    const parsed = JSON.parse(String((res && res.value) || '{}'));
    next = Boolean(parsed && parsed.enabled);
  } catch {
    // 读不出来就保持现状：一次读失败不该悄悄把大脑换掉。
    return coreMode;
  }
  if (next !== coreMode) {
    coreMode = next;
    note(next
      ? '记忆核心已接管回答（人设与记忆在 com.shixiansi.plugin-memcore）'
      : '记忆核心已退出，改回本插件自己回答');
    if (view === 'workshop') renderMemcoreCard();
  }
  // 刚被打开，而且是在**常驻帧**里发现的：把本插件已有的群记忆导过去一次。
  //
  // 为什么不是插件页上的按钮：那一页跑在控制中心里，而控制中心**不服务 plugin.call**
  // （它只挂一页、没有常驻帧，另一端没人答）。2026-10-29 真机上就是这么踩的：按钮点下去，
  // 市场上那条日志写的是「调用了本程序不支持的方法 plugin.call」，三个群三条空放。
  // 所以这件事只能由桌宠的常驻帧做 —— 而它在轮询里本来就会经过这里。
  if (next && view === 'background') {
    void autoSeedOnce().catch((err) => note(`导入群记忆失败：${(err && err.message) || err}`));
  }
  return coreMode;
}

/**
 * 打开开关时把本插件的群记忆导进核心，**只导一次**。
 *
 * 幂等靠 `state/core` 里的 `seededAt`：没有它，每次重启（每 10 秒的轮询同样）都会重扫一遍
 * 所有群。核心那边的 seed 本身也去重，但"每次启动都发 N 个 plugin.call"是不该有的噪声。
 *
 * `seedVersion` 是为了收拾 1.13.1 留下的烂摊子：那一版把"试过了"当成"导成功了"盖章，而当时
 * 核心的常驻帧根本没挂上（宿主的前端白名单漏了 `plugin.call`）。所以旧记录（没有版本号）不算数，
 * 升级之后的下一次轮询会自己重试一次——用户不必再去拨开关。
 */
const SEED_RECORD_VERSION = 2;

async function autoSeedOnce() {
  const raw = await readKeyText(CORE_MODE_KEY);
  let record = {};
  try {
    record = JSON.parse(raw || '{}') || {};
  } catch {
    record = {};
  }
  if (record.seededAt && Number(record.seedVersion) >= SEED_RECORD_VERSION) {
    return { scanned: 0, imported: 0, failed: 0, skipped: true };
  }
  // 全部失败时**不盖章**：那说明核心不在（没装、没授权、或者常驻帧还没挂上），下一次轮询
  // 应该还有机会——2026-10-29 真机上就是"帧没挂上"那次，把失败当成功盖了章，于是用户只有
  // 手动拨一次开关才会重试。但也不能每 10 秒试一次，所以失败后 5 分钟内不再试。
  if (record.lastTryAt && Date.now() - Number(record.lastTryAt) < 5 * 60 * 1000) {
    return { scanned: 0, imported: 0, failed: 0, skipped: true };
  }
  const res = await seedCore();
  const allFailed = res.scanned > 0 && res.failed === res.scanned;
  await writeJSON(CORE_MODE_KEY, {
    enabled: true,
    at: Number(record.at) || Date.now(),
    // 只有"真的有人接住"才盖章。
    ...(allFailed ? {} : { seededAt: Date.now(), seedVersion: SEED_RECORD_VERSION }),
    lastTryAt: Date.now(),
    imported: res.imported,
  });
  note(res.scanned === 0
    ? '记忆核心：本插件没有可导入的群记忆'
    : allFailed
      ? `记忆核心：导入群记忆失败（${res.failed} 个群，核心那边没人接），5 分钟后重试`
      : `记忆核心：导入本插件群记忆 ${res.imported} 条（扫了 ${res.scanned} 个群${res.failed ? `，${res.failed} 个失败` : ''}）`);
  return res;
}

/** 改开关（插件页的勾选框）。 */
async function setCoreMode(on) {
  coreMode = Boolean(on);
  await writeJSON(CORE_MODE_KEY, { enabled: coreMode, at: Date.now() });
  note(coreMode ? '打开了记忆核心' : '关掉了记忆核心');
  renderMemcoreCard();
  return coreMode;
}

/** 问一次核心，拿回一句话。失败时抛宿主/核心给的中文句子，由调用方决定怎么讲。 */
async function askCore({ groupID, userId, userName, text, hint }) {
  const payload = {
    roleId: coreRoleId(groupID),
    userId: String(userId || ''),
    userName: String(userName || ''),
    text: String(text || ''),
  };
  const extra = String(hint || '').trim();
  if (extra) payload.hint = extra;
  const res = await request('plugin.call', {
    target: CORE_PLUGIN,
    method: CORE_CHAT,
    payload,
  });
  return String((res && res.text) || '');
}

/** 随机贴一张表情（核心模式下模型不再点名，只剩这一条路）。 */
async function maybeRandomSticker(groupID) {
  const chance = number(state.cfg.stickerChance, 30, 0, 100);
  if (chance <= 0) return;
  if (Math.random() * 100 >= chance) return;
  const index = await loadStickerIndex();
  if (!Array.isArray(index) || !index.length) return;
  const row = index[Math.floor(Math.random() * index.length)];
  if (!row || !row.hash) return;
  // 几率与冷却都在 maybeSendSticker 里还有一道，所以这里的摇号只是"少摇几次"。
  await maybeSendSticker(groupID, row.hash);
}

/**
 * 核心模式下的一个回合。
 *
 * 它接在 `takeTurn` 的最前面（bili.js），做完和原路径同样的收尾：发出去、记本插件的转写、
 * 结算社交能量、更新工坊里那几张卡。**不**做的事：拼 prompt、解析围栏、写群记忆（核心自己记）。
 */
async function takeTurnViaCore(groupID, job) {
  const data = (job && job.data) || {};
  const ask = String(job && job.ask ? job.ask : '');
  const asker = String(job && job.asker ? job.asker : '某人');
  const groupName = String(job && job.groupName ? job.groupName : '');
  const senderID = String(data.sender_id || '');
  const turns = number(state.cfg.contextTurns, 8, 0, 40);

  const segments = Array.isArray(job && job.segments) ? job.segments : [];
  const quoted = job && job.enriched && Array.isArray(job.enriched.quoteSegments)
    ? job.enriched.quoteSegments
    : [];
  // 数**图片段**而不是 imagesOf() 的结果：后者在没有 `visionModel` 时恒为空（它的开关是"要不要
  // 送去识图"），而这里要回答的是"这条消息里有没有图"，与识图配没配无关。
  const imageCount = [...segments, ...quoted]
    .filter((seg) => seg && seg.type === 'image').length;
  // 图片过不了 plugin.call，所以如实说。模型最容易犯的错是"假装看过图"，一句提示比一段道歉便宜。
  const imageNote = imageCount
    ? `（这条消息带了 ${imageCount} 张图，你看不到；不确定就别描述画面。）`
    : '';

  const asked = `${asker}：${ask}`;
  const reply = await askCore({
    groupID,
    userId: senderID,
    userName: asker,
    text: `${asked}${imageNote}`,
  });
  const maxChars = number(state.cfg.replyMaxChars, 300, 20, 2000);
  const say = tidyReply(reply, maxChars);

  // 社交能量照旧结算：它是"这个群还活跃吗"的账，不是记忆。
  await settleEnergy(groupID, Boolean(job && job.mentioned));
  if (!say) {
    if (job && job.mentioned) await reactToMessage(groupID, data.message_seq);
    note(`群 ${groupID}：记忆核心回了空内容，这条没发出去`);
    return;
  }

  await sendGroupReply(groupID, data.message_seq, say);
  await remember(groupID, groupName, asked, say, turns);
  const spent = await spendEnergy(groupID, Array.from(say).length, 0);
  publishGroupState(groupID, { energy: spent, notes: (await loadNotes(groupID)).length });
  note(`群 ${groupID} 回复了 ${asker}（记忆核心，${Array.from(say).length} 字）`);
  await maybeRandomSticker(groupID);
}

/** 一条本插件的群记忆 → 核心的一句事实。 */
function noteAsFact(row) {
  const body = String((row && row.text) || '').trim();
  if (!body) return '';
  const who = String((row && row.whoName) || '').trim();
  return (who ? `${who}：${body}` : body).slice(0, 120);
}

/**
 * 把本插件攒下的群记忆一次性导入核心。
 *
 * 为什么要手动：打开开关的那一刻，这些记忆并没有消失，但**再没有人在读它**——用户看到的是
 * "它把我说过的事忘了"。与其让它悄悄失效，不如给一个按钮，导进去、报告导了几条。
 *
 * @param {string[]} [groups] 指定群号；不传就是所有见过的群
 * @returns {Promise<{scanned:number, imported:number, failed:number}>}
 */
async function seedCore(groups) {
  let ids = Array.isArray(groups) && groups.length ? groups.map(String) : [];
  if (!ids.length) {
    // 没有指定就扫 `memory/` 下真实存在的目录，而不是内存里的 `state.groups`：后者是"见过哪些群"
    // 的索引，可能被清过、也可能还没在这台机器上加载过，而**记忆在磁盘上**。用磁盘做清单，
    // "有记忆但索引里没有"的群也能被带走。
    try {
      const res = await request('storage.list', { sub: 'memory' });
      ids = (res && Array.isArray(res.dirs) ? res.dirs : []).map(String);
    } catch {
      ids = [];
    }
    if (!ids.length) ids = [...state.groups.keys()];
  }
  let scanned = 0;
  let imported = 0;
  let failed = 0;
  for (const id of ids) {
    const notes = await loadNotes(id);
    const facts = notes.map(noteAsFact).filter(Boolean);
    if (!facts.length) continue;
    scanned += 1;
    try {
      const res = await request('plugin.call', {
        target: CORE_PLUGIN,
        method: CORE_SEED,
        payload: { roleId: coreRoleId(id), facts },
      });
      imported += Number(res && res.imported) || 0;
    } catch (err) {
      failed += 1;
      note(`群 ${id} 的记忆导入失败：${(err && err.message) || err}`);
    }
  }
  return { scanned, imported, failed };
}

// --- 插件页那一张卡 ---------------------------------------------------------------

function renderMemcoreCard() {
  const card = document.getElementById('memcore-card');
  if (!card) return;
  card.hidden = false;
  const on = coreEnabled();
  const box = document.getElementById('memcore-toggle');
  if (box) box.checked = on;
  const line = document.getElementById('memcore-state');
  if (line) {
    line.textContent = on
      ? '已开启：群里的每一句问答都交给记忆核心（人设、往来、摘要、长期记忆、画像都在那边）。'
      : '未开启：本插件自己拼 prompt、自己记群记忆。勾上下面这一项即可交出去。';
  }
  // 这一页在**控制中心**里，而控制中心不服务 plugin.call：导入只能由桌宠的常驻帧做。
  // 所以这里没有按钮 —— 与其放一个点了报错的按钮，不如说清楚它会在什么时候自动发生。
  const where = document.getElementById('memcore-where');
  if (where) {
    where.textContent = on
      ? '本插件已经攒下的群记忆会在桌宠那边自动导入一次（最多 10 秒后开始，只导一次）；这一页在控制中心里，不能直接调 plugin.call。'
      : '';
    where.hidden = !on;
  }
}

/** 控件绑一次（app.js 末尾调用，和表情包控件同一个做法）。 */
function bindMemcoreControls() {
  const box = document.getElementById('memcore-toggle');
  if (!box) return;
  box.addEventListener('change', () => {
    void setCoreMode(box.checked).catch((err) => {
      note(`切换记忆核心失败：${(err && err.message) || err}`);
    });
  });
}

/**
 * 测试接缝：这一层的行为入口。
 *
 * 它的每一条路都仍然经 `request` 过宿主的闸门，所以它不是一条额外的能力。
 */
window.__qqCore = Object.freeze({
  enabled: coreEnabled,
  roleId: coreRoleId,
  ask: askCore,
  turn: takeTurnViaCore,
  seed: seedCore,
  autoSeed: autoSeedOnce,
  refreshMode: refreshCoreMode,
  card: renderMemcoreCard,
  // 核心模式会**停下**的那两条路（proactive.js）：测试要能直接验证"它真的停在这里"，
  // 而不是等 15 秒的定时器、或者靠 batchTick 的一串前置条件碰巧成立。
  batch: batchEvaluate,
  proactive: speakProactively,
});
