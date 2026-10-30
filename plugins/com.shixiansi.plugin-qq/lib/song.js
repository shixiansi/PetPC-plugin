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
 * 一条歌 → **按顺序试的几种卡片形态**。
 *
 * 为什么不是一种：QQ NT 只认它认识的消息元素。最初这里发的是 OneBot v11 的 `music` 段
 * （`type: "custom"`），桥接端照发了，而客户端显示「该消息类型暂不支持查看」——那正是"元素发过去
 * 了，QQ 不认识它"的样子。而同一个插件**入站**早就在处理三类卡片（`json` / `xml` / `light_app`，
 * 见 bili.js 头注），说明这条通道上跑的是 QQ NT 的 ark 体系，不是 v11 的 music 段。
 *
 * 所以这里按"最像 QQ 自己的卡片"到"最退让"排四级，逐级试：
 *
 *   1. `light_app`  —— QQ NT 的 light-app 元素（ark 卡片的现代形态）；
 *   2. `json`       —— OneBot v11 的 ark 段，多数桥接端也吃；
 *   3. `xml`        —— 经典 QQ 音乐卡（serviceID=1 / templateID=1 + <audio>），老客户端认；
 *   4. `text`       —— 歌名 + 歌手 + 直链。宁可少一张卡，也不要一条点不开的卡片。
 *
 * 每一级都**不预设桥接端支持**：发送抛错就下一级；全失败才退文本。哪一级成功会写进日志
 * （`点歌卡片：light_app`），下次排查不用猜。
 */
function buildSongCards(song) {
  const title = String((song && song.title) || '').trim() || '未知歌曲';
  const singer = String((song && song.singer) || '').trim();
  const url = String((song && song.url) || '').trim();
  const cover = String((song && song.cover) || '').trim();
  if (!url) return [];

  // ① ark 载荷（QQ 音乐的 light-app 卡片）：官方音乐卡就是这个形状，字段名不能改。
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
  const arkJSON = JSON.stringify(ark);

  // ② 经典 XML 音乐卡（老客户端仍然认这一份）。
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<msg serviceID="1" templateID="1" action="web" brief="[分享] ' + title + '" url="' + url + '">',
    '<item layout="2">',
    '<audio cover="' + (cover || '') + '" src="' + url + '"/>',
    '<title>' + title + '</title>',
    '<summary>' + (singer || '') + '</summary>',
    '</item>',
    '</msg>',
  ].join('');

  const cards = [
    {
      label: 'light_app',
      segments: [{ type: 'light_app', data: { app_name: 'com.tencent.music.lua', app_view: 'music', json: arkJSON, meta: ark.meta } }],
    },
    { label: 'json', segments: [{ type: 'json', data: { data: arkJSON } }] },
    { label: 'xml', segments: [{ type: 'xml', data: { xml } }] },
    { label: 'text', segments: buildTextSegments(song) },
  ];
  return cards;
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
