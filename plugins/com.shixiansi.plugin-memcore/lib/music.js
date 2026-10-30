// lib/music.js —— 「点歌 → 一条直链」的那一步
//
// 点歌是**借来的能力**：酷我搜索、按码率回退、验一下链接能不能播、以及那个第三方接口的地址
// 与白名单，全都住在「点歌」插件里（`com.shixiansi.plugin-diange`），这里只用 plugin.call 问它。
// 于是三件事自动成立：
//
//   · 换一个音源 / 换一个接口地址，核心一行代码都不用改；
//   · 点歌插件没装、没启用、没被点名时，这里拿到的是宿主那句中文（「未启用」「问不到 …」），
//     兜底就是"当没有点歌"，对话绝不因为点歌失败而失败；
//   · 直链是**当场取**的：它带签名、会过期。把它存进记忆是错误的——下次拿出来是一句死链，
//     而且没有任何地方能看得出为什么。
//
// ## 两个方法名，两种意图
//
//   song       入参是一句人话（「点歌 晴天 周杰伦」）→ 交给插件去猜
//   song_link  入参是结构化的（song + singer）→ 精确地要一首歌的链接
//
// 为什么要分开：用户说的是人话，模型写的是 `歌名 - 歌手`。把两种输入塞进同一个通道，最后一定
// 会出现"把「晴天 - 周杰伦」整串当成歌名去搜"这种命中率下降的 bug。
//
// ## 为什么是两条触发线，而不是"让模型自己决定"
//
// 宿主的 llm.chat 工具目录里没有"找一首歌"这个工具，模型没有出口。所以决定权放在两个硬信号上：
//
//   1. 用户这一轮明确要歌（「点歌 …」「来一首 …」「想听一首 …」）—— 先查再答；
//   2. 模型按 prompt 约定输出 `[SONG] 歌名 - 歌手` —— 它比"用户那句话"更懂该查什么。
//
// 两条都是**可解释**的：回答里带了链接，一定能指出是哪一条触发的（见 chat.js 的 meta.music）。
//
// ## 为什么没有 always 档
//
// 联网搜索有 always（时效性问题不该赌记忆）。点歌没有：没人点歌时"每轮都查一首"只会多花一次
// 往返与一次别人的限额，换来的是模型每句话都忍不住贴一个链接。所以只有 auto / off。

'use strict';

/** 方法名就是**能力名**：别的插件靠它被发现（lib/services.js），所以不能和网页搜索的 `search` 混用。 */
const MUSIC_METHOD = 'song';
const MUSIC_LINK_METHOD = 'song_link';
/** 老宿主没有 `plugins.services` 时的第一顺位（发现可用时这只是"优先问谁"）。 */
const MUSIC_PREFER = 'com.shixiansi.plugin-diange';
/**
 * 点歌这一步的时间上限（毫秒）。
 *
 * 宿主 plugin.call 是 30 秒，而一句话里还要塞两轮模型调用（实测各 1.5–2.5 秒）。酷我搜索正常
 * 在 1 秒内回来；给它 8 秒是留给"偶尔要探一次链接能不能播"的那种情况——再慢就带着已有信息
 * 回答，绝不让调用方干等超时。
 */
const SONG_BUDGET_MS = 8000;

/**
 * 用户这一轮明确要歌。
 *
 * 只匹配**动作**，不匹配"歌"这个字：说「我记得那首歌」是在回忆，不是点歌；而「想听你说说」
 * 里也有"想听"——所以"想听"要求后面跟着量词（一首/一点/几个）。
 */
const MUSIC_INTENT_RE = /(点歌|点一?首|来一?首|来首|放一?首|放首|想听(一|首|点|个)|听一?首|唱一?首|搜一?首歌|找一?首歌|给我(找|放|来)一?首|歌曲?的?(链接|地址)|音乐的?(链接|地址))/;

/** 模型按 prompt 约定主动要一次点歌的前缀（与 `[SEARCH]` 同一个约定）。 */
const SONG_TAG_RE = /^\s*\[SONG\]\s*(.+)/;

/** 「点歌 / 来一首 / 帮我找一首 …」这些开场词：接口只吃一句干净的话。 */
const SONG_PREFIX_RE = /^\s*(请|帮我|麻烦|给我)?\s*(点歌|点一?首|来一?首|来首|放一?首|放首|想听|听一?首|唱一?首|搜一?首歌|找一?首歌|给我(找|放|来)一?首)\s*[:：,，、]?\s*/;

/** 没找到歌时给用户的那句话（不编歌名，也不假装链接在别处）。 */
const MUSIC_MISS_REPLY = '这首歌我没找到链接，换个写法（歌名 + 歌手）再点一次？';

function musicMode() {
  const mode = String(cfg.music || 'auto').trim().toLowerCase();
  return mode === 'off' ? 'off' : 'auto';
}

/** 这一句是不是在点歌（auto 档的第一条触发线）。 */
function wantsMusic(line) {
  if (musicMode() === 'off') return false;
  return MUSIC_INTENT_RE.test(String(line || ''));
}

/**
 * 把「点歌 晴天 - 周杰伦」收拾成查询词「晴天 - 周杰伦」。
 *
 * 去掉的是**寒暄与动词**：接口按整句话去匹配歌名，多一个"点歌"两个字就会把命中率打下来。
 * 引号与书名号也去掉（用户写「《晴天》」时接口会把书名号当成歌名的一部分）。
 * 万一收拾完是空的（用户只说了"点歌"），退回原句——让插件那边去判断，而不是在这里静默查询空串。
 */
function musicQueryOf(line) {
  const original = text(line, 200).trim();
  let body = original.replace(SONG_PREFIX_RE, '').trim();
  body = body.replace(/^[《「『"“'‘]+/, '').replace(/[》」』"”'’]+$/, '').trim();
  // "周杰伦的歌" → "周杰伦"；"这首歌的链接" → "这首歌"（再退一步就是原句）。
  body = body.replace(/(的)?(歌曲|歌|音乐)(的)?(链接|地址)?\s*[?？!！。]*$/u, '').trim();
  return text(body || original, 200).trim();
}

/** 模型按约定给出的那一行（没有就是空串）。 */
function songTagOf(reply) {
  const matched = SONG_TAG_RE.exec(String(reply || ''));
  return matched ? text(matched[1], 200).trim() : '';
}

/** 把 `[SONG]` 那一行从回答里去掉：用户不该看到这个标记。 */
function stripSongTag(reply) {
  return String(reply || '').replace(SONG_TAG_RE, '').trim();
}

/**
 * `晴天 - 周杰伦` → `{song:'晴天', singer:'周杰伦'}`。
 *
 * 只认**第一个**分隔符：歌名里本来就可能带连字符（「M-1」），而歌手名里基本不会有空格包着的
 * 破折号。认不出来就整串当歌名，交给插件去搜——比猜一个不存在的歌手好。
 */
function splitSongTag(raw) {
  const body = text(raw, 200).trim();
  const matched = /^(.{1,120}?)\s*[-–—|｜]\s*(.{1,60})$/.exec(body);
  if (!matched) return { song: body, singer: '' };
  return { song: matched[1].trim(), singer: matched[2].trim() };
}

/** 应答里的"那首歌"：两种返回形状（`results[0]` 与顶层 url）都要认。 */
function songOf(out) {
  if (!out) return null;
  const row = Array.isArray(out.results)
    ? out.results.find((item) => item && typeof item.url === 'string' && item.url)
    : null;
  if (row) return { title: row.title, singer: row.singer, url: row.url };
  if (typeof out.url === 'string' && out.url) return { title: out.title, singer: out.singer, url: out.url };
  return null;
}

/**
 * 点歌插件在这一个文档里**问不动**（没装 / 没启用 / 没有帧）。
 *
 * 为什么需要记这一笔：用户点歌时问一次，插件不可用就得到一句"问不到"；如果模型的回答里
 * 又出现 `[SONG]`，再去问同一家只会再等一次 8 秒的预算——两次串起来正好撞上宿主
 * plugin.call 的 30 秒上限，用户看到的是"点了歌，30 秒后超时"。
 *
 * 只认"抛错"（连不上），不认"没找到这首歌"：后者换一个查询词是可能成功的，重试有意义。
 * 成功一次就清零——插件被装上/启用后，下一次点歌立刻恢复（安装要重启宿主，粒度一致）。
 */
let musicUnreachable = false;

function musicIsUnreachable() {
  return musicUnreachable;
}

/**
 * 问一个提供方。任何失败都返回 null——这一家不行就问下一家，绝不让对话失败。
 *
 * 名字带 `Music` 是必须的：这些 lib 文件是**经典脚本、共享同一个全局作用域**，
 * `lib/websearch.js` 里已经有 `askOne`。同名会静默互相覆盖（2026-10-30 踩过）。
 */
async function askMusicProvider(id, method, payload) {
  try {
    const out = await request('plugin.call', { target: id, method, payload });
    musicUnreachable = false;
    if (!out || typeof out.text !== 'string' || !out.text.trim()) return null;
    const song = songOf(out);
    // 没有链接 = 这一家没帮上忙（找不到这首歌）。别把一段"没找到"塞进 prompt。
    if (!song) return null;
    return {
      text: out.text,
      song,
      provider: typeof out.provider === 'string' && out.provider ? out.provider : 'kuwo',
      via: method,
    };
  } catch {
    // 没装 / 没启用 / 没声明在 callTargets 里 / 超时（plugin.call 的 30 秒上限）：当作问不到。
    musicUnreachable = true;
    return null;
  }
}

/** 按一句话找歌（用户说的是一句人话）。 */
async function askMusic(query) {
  const asked = text(query, 200).trim();
  if (!asked) return null;
  for (const id of await providersFor(MUSIC_METHOD, MUSIC_PREFER)) {
    const hit = await askMusicProvider(id, MUSIC_METHOD, { query: asked, timeoutMs: SONG_BUDGET_MS });
    if (hit) return hit;
  }
  return null;
}

/** 已知歌名（可带歌手），要一条**当下有效**的链接。 */
async function askMusicLink(song, singer) {
  const title = text(song, 200).trim();
  if (!title) return null;
  const payload = { song: title, fresh: true, timeoutMs: SONG_BUDGET_MS };
  const who = text(singer, 80).trim();
  if (who) payload.singer = who;
  for (const id of await providersFor(MUSIC_LINK_METHOD, MUSIC_PREFER)) {
    const hit = await askMusicProvider(id, MUSIC_LINK_METHOD, payload);
    if (hit) return hit;
  }
  return null;
}

/**
 * 带硬截止的版本：老版本插件不认 `timeoutMs` 时，到点就不再等它。
 *
 * 为什么必须有：宿主 plugin.call 自己会在 30 秒掐断，而那时候我们已经来不及回答了。
 */
async function withinSongBudget(promise) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), SONG_BUDGET_MS + 500)),
  ]);
}

/** auto 档第一问之前，告诉模型有一个 `[SONG]` 出口。 */
function musicInstruction() {
  return [
    '【点歌】你可以给用户一首歌的直链：',
    '- 用户想要某首歌时，第一行只写「[SONG] 歌名 - 歌手」，不要写别的；',
    '- 收到【点歌结果】后，把里面那条直链**原样**发出来（不要改写、不要截断），再补一句歌手。',
  ].join('\n');
}

/** 把一次点歌的结果拼进 system。 */
function musicBlock(result) {
  return `【点歌结果】\n${result.text}`;
}
