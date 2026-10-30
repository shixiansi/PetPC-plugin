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
 * 一条歌 → 卡片消息段。
 *
 * **Milky 的出站段只有这几种**（https://milky.ntqqrev.org/struct/OutgoingSegment）：
 * `text / mention / mention_all / face / reply / image / record / video / forward / light_app`。
 * 没有 `xml`、没有 `json`、没有 OneBot v11 的 `music`——前两版就是发这些，于是客户端显示
 * 「该消息类型暂不支持查看」（元素发过去了，QQ 不认它）。
 *
 * 而 `light_app` 的出站结构**只有一个字段**：
 *
 *     { "type": "light_app", "data": { "json_payload": "<ark JSON 字符串>" } }
 *
 * 入站那份（/struct/IncomingSegment）多一个 `app_name`，发送侧不需要——按上游实现
 * （LagrangeDev/acidify#12）桥接端会自己把 `json_payload` 做 zlib 压缩 + 0x01 前缀再塞进
 * `lightAppElem`，所以这边**只交纯 JSON**，不要自己压缩、也不要编字段名。
 *
 * 于是只有两级：`light_app`（卡片）→ `text`（歌名 + 歌手 + 直链）。第二级是给"桥接端版本太老
 * 不支持 light_app"留的退路，不是常态。
 */
function buildSongCards(song) {
  const title = String((song && song.title) || '').trim() || '未知歌曲';
  const singer = String((song && song.singer) || '').trim();
  const url = String((song && song.url) || '').trim();
  const cover = String((song && song.cover) || '').trim();
  if (!url) return [];

  // QQ 音乐卡片（ark）：`com.tencent.music.lua` / view `music`。字段名是腾讯定的，不能改。
  const ark = {
    app: 'com.tencent.music.lua',
    config: { ctime: Math.floor(Date.now() / 1000), forward: true, type: 'normal', autosize: true },
    desc: '0',
    meta: {
      music: {
        app_type: 1,
        appid: 100495085,
        ctime: Math.floor(Date.now() / 1000),
        desc: singer,
        jumpUrl: url,
        musicUrl: url,
        preview: cover || '',
        tag: '音乐',
        title,
      },
    },
    prompt: `[分享] ${title}${singer ? ` - ${singer}` : ''}`,
    ver: '0.0.0.1',
    view: 'music',
  };

  return [
    { label: 'light_app', segments: [{ type: 'light_app', data: { json_payload: JSON.stringify(ark) } }] },
    { label: 'text', segments: buildTextSegments(song) },
  ];
}

/** 最后的退路：一条能点的文本。 */
function buildTextSegments(song) {
  const title = String((song && song.title) || '').trim() || '未知歌曲';
  const singer = String((song && song.singer) || '').trim();
  const url = String((song && song.url) || '').trim();
  if (!url) return [];
  const lines = [`点歌：${title}${singer ? ` —— ${singer}` : ''}`];
  if (song.album) lines.push(`专辑：${song.album}`);
  lines.push(url);
  return [{ type: 'text', data: { text: lines.join('\n') } }];
}

/**
 * 问「点歌」插件要一首歌。
 *
 * 三种结局必须分开，因为它们该说不同的话：
 *
 *   { ok: true,  song }       搜到了；
 *   { ok: true,  song: null } 问了、它说没有这首（该回一句"没找到"）；
 *   { ok: false }             根本没问到（插件没装/没启用/被关掉/超时）——这时**不要**回"没找到"，
 *                             那会把"你没装点歌插件"伪装成"世上没这首歌"。调用方应当放它过，
 *                             让这句话照常当聊天处理。
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

  // 逐级试：哪一级桥接端接受就用它（README/日志里能看到是哪一级）。
  const cards = buildSongCards(song);
  let sent = '';
  for (const card of cards) {
    if (!card.segments.length) continue;
    try {
      await sendSegments(groupID, card.segments);
      sent = card.label;
      break;
    } catch {
      // 这一级桥接端不认：试下一级。
    }
  }
  if (!sent) {
    await sendSegments(groupID, buildTextSegments(song)).catch(() => {});
    sent = 'text';
  }
  // 哪一级成功要留痕：客户端显示「暂不支持查看」时，这条日志就是唯一能定位的线索。
  note(`点歌卡片：${song.title}${song.singer ? ` - ${song.singer}` : ''} 用 ${sent} 发出`);
  return true;
}
