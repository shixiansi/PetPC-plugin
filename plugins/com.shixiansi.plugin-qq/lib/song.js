// lib/song.js —— 「点歌 <歌名>」：问「点歌」插件要一条可播链接，然后发一张 QQ 音乐卡片
//
// 三件事分开，因为失败时要说的话不一样：
//   1. `songCommandOf`  —— 这是不是一句点歌命令（纯函数，认「点歌 / 点一首 / 来一首 / 来首」）；
//   2. `buildSongSegments` —— 把一条歌变成消息段（纯函数；`music` 卡片或纯文本，由设置决定）；
//   3. `maybeHandleSongCommand` —— 真的去问、真的发。
//
// **搜索不在这个插件里**：酷我搜索、按码率回退、验链接能不能播、接口地址与白名单全都在「点歌」插件
// （`com.shixiansi.plugin-diange`，`serves: ["song", "song_link"]`）。这里只用 plugin.call 问它——
// 于是"音乐源"只有一个地方要维护，换一家也不用动 QQ 这边。
//
// 卡片为什么用 `music` 段而不是参考实现里的 `json` 段：`json` 那种 ark 卡片要靠第三方接口
// （api.s01s.cn）拼一段很长的 JSON，多一个依赖、多一个会挂的地方；而 OneBot v11 的 `music` 段
// （`type: "custom"`）就是为这件事准备的，NapCat / Lagrange 都认，字段全是我们手上已有的东西。
// 万一桥接端不认，`send` 会抛错——那就退回纯文本，至少歌名、歌手、链接还在。
'use strict';

/** 「点歌 发如雪」/「来一首 晴天」/「点一首：稻香」——前缀之后的整段就是查询。 */
const SONG_CMD_RE = /^\s*(?:点歌|点一首|来一首|来首)\s*[:：]?\s*(.+)$/u;

/** 这条消息是不是点歌命令；不是就返回空串。 */
function songCommandOf(raw) {
  const matched = SONG_CMD_RE.exec(String(raw || ''));
  return matched ? String(matched[1] || '').trim() : '';
}

/**
 * 一条歌 → 消息段。
 *
 * `music` 段（custom）需要的字段：`url`（点卡片跳去哪）、`audio`（点播放放什么）、`title`、
 * `image`（封面）、`content`（副标题，这里放歌手）。酷我给的是直链，两个 url 都用它——参考实现
 * 也是这么干的（`link` 与 `audio` 同一条）。
 */
function buildSongSegments(song, mode) {
  const title = String((song && song.title) || '').trim() || '未知歌曲';
  const singer = String((song && song.singer) || '').trim();
  const url = String((song && song.url) || '').trim();
  const cover = String((song && song.cover) || '').trim();
  if (!url) return [];

  if (String(mode || 'music') === 'text') {
    const lines = [`点歌：${title}${singer ? ` —— ${singer}` : ''}`];
    if (song.album) lines.push(`专辑：${song.album}`);
    lines.push(url);
    return [{ type: 'text', data: { text: lines.join('\n') } }];
  }

  const data = { type: 'custom', url, audio: url, title };
  if (singer) data.content = singer;
  if (cover) data.image = cover;
  return [{ type: 'music', data }];
}

/**
 * 问「点歌」插件要一首歌。
 *
 * 三种结局必须分开，因为它们该说不同的话：
 *
 *   { ok: true,  song }     搜到了；
 *   { ok: true,  song: null } 问了、它说没有这首（该回一句"没找到"）；
 *   { ok: false }            根本没问到（插件没装/没启用/被关掉/超时）——这时**不要**回"没找到"，
 *                            那会把"你没装点歌插件"伪装成"世上没这首歌"。调用方应当放它过，
 *                            让这句话照常当聊天处理。
 */
async function askSongPlugin(query) {
  try {
    const out = await request('plugin.call', {
      target: 'com.shixiansi.plugin-diange',
      method: 'song',
      payload: { query },
    });
    const song = out && Array.isArray(out.results) ? out.results[0] : null;
    return { ok: true, song: song && song.url ? song : null };
  } catch {
    return { ok: false, song: null };
  }
}

async function sendSegments(groupID, segments) {
  await api('send_group_message', { group_id: Number(groupID), message: segments });
}

/**
 * 命中点歌命令就当场处理掉，返回 true（调用方据此**不再**把这条消息喂给模型）。
 *
 * @returns {Promise<boolean>} 是否已经处理（true = 已回复，调用方 return）
 */
async function maybeHandleSongCommand(raw, groupID) {
  const query = songCommandOf(raw);
  if (!query) return false;

  const { ok, song } = await askSongPlugin(query);
  // 点歌插件没装/停用：这句话照常当聊天，我们一个字都不插（见 askSongPlugin 的注释）。
  if (!ok) return false;
  if (!song) {
    await sendSegments(groupID, [{ type: 'text', data: { text: `没找到「${query}」，换个写法试试（歌名 + 歌手更好找）。` } }])
      .catch(() => {});
    return true;
  }

  // 卡片形态不设配置项：这个插件的设置已经到 40 项上限，而"发不成卡片就退回文本"本来就不需要人选。
  const mode = 'music';
  const segments = buildSongSegments(song, mode);
  try {
    await sendSegments(groupID, segments);
  } catch {
    // 桥接端不认 `music` 段（有的实现只支持文本/图片）：退回一条能点的链接。
    await sendSegments(groupID, buildSongSegments(song, 'text')).catch(() => {});
  }
  return true;
}
