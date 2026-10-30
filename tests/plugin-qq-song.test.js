import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// 「点歌 <歌名>」这条命令：认句子、拼卡片、以及**三种失败该说不同的话**。
//
// 用 vm 沙箱装 lib/song.js（它不碰 DOM，只调 request/api），于是测试只依赖"给了什么、发了什么"。
// 真机上的协议往返由 plugin-check 与预览器覆盖。
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-qq');

const SONG = {
  title: '发如雪',
  singer: '周杰伦',
  album: '十一月的萧邦',
  url: 'https://example.com/faxue.mp3',
  cover: 'https://example.com/faxue.jpg',
};

/** 装一个沙箱：`request` 与 `api` 可替换，其余是记录用的数组。 */
function loadSong({ request, api } = {}) {
  const sandbox = { console, JSON, String, Number, Array, Object, Promise, encodeURIComponent };
  sandbox.sent = [];
  sandbox.calls = [];
  // 插件里的日志函数（真机写日志，这里只记录）
  sandbox.requests = [];
  sandbox.notes = [];
  sandbox.note = (line) => sandbox.notes.push(String(line));
  sandbox.request = async (method, payload) => {
    sandbox.requests.push({ method, payload });
    return (request || (async () => ({ results: [SONG] })))(method, payload);
  };
  sandbox.api = api || (async (action, payload) => {
    sandbox.calls.push({ action, payload });
    return { ok: true };
  });
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(dir, 'lib', 'song.js'), 'utf8'), sandbox, { filename: 'lib/song.js' });
  return sandbox;
}

describe('点歌命令：认句子', () => {
  test('四种写法都认，前缀之后的整段是查询', () => {
    const s = loadSong();
    expect(s.songCommandOf('点歌 发如雪')).toBe('发如雪');
    expect(s.songCommandOf('来一首：晴天')).toBe('晴天');
    expect(s.songCommandOf('点一首 稻香')).toBe('稻香');
    expect(s.songCommandOf('  来首 夜曲  ')).toBe('夜曲');
  });

  test('不是点歌就返回空串（别把正常聊天吃掉）', () => {
    const s = loadSong();
    expect(s.songCommandOf('你好')).toBe('');
    expect(s.songCommandOf('点歌')).toBe('');
    expect(s.songCommandOf('我想点歌')).toBe('');
    expect(s.songCommandOf('')).toBe('');
  });
});

describe('点歌卡片：Milky 的 light_app，退路是文本', () => {
  // Milky 出站只支持 text/mention/mention_all/face/reply/image/record/video/forward/light_app。
  // 没有 xml/json/music —— 发那些客户端会说「该消息类型暂不支持查看」。
  test('第一级是 light_app，data 只有 json_payload 一个字段（规范就是这么定的）', () => {
    const s = loadSong();
    const cards = s.buildSongCards(SONG);
    expect(cards.map((c) => c.label)).toEqual(['light_app', 'text']);
    const seg = cards[0].segments[0];
    expect(seg.type).toBe('light_app');
    expect(Object.keys(seg.data)).toEqual(['json_payload']);
  });

  test('json_payload 是未压缩的 QQ 音乐 ark：app / view / meta.music 的字段名是腾讯定的', () => {
    const s = loadSong();
    const ark = JSON.parse(s.buildSongCards(SONG)[0].segments[0].data.json_payload);
    expect(ark.app).toBe('com.tencent.music.lua');
    expect(ark.view).toBe('music');
    expect(ark.meta.music).toMatchObject({
      title: '发如雪',
      desc: '周杰伦',
      musicUrl: SONG.url,
      jumpUrl: SONG.url,
      preview: SONG.cover,
      appid: 100495085,
    });
    expect(ark.prompt).toContain('发如雪');
  });

  test('第二级是文本（老桥接端不支持 light_app 时的退路）', () => {
    const s = loadSong();
    const text = s.buildSongCards(SONG)[1].segments[0];
    expect(text.type).toBe('text');
    expect(text.data.text).toContain('发如雪');
    expect(text.data.text).toContain('周杰伦');
    expect(text.data.text).toContain(SONG.url);
  });

  test('没有可播链接就什么都不发（宁可不发，也不发一张点不开的卡片）', () => {
    const s = loadSong();
    expect(s.buildSongCards({ ...SONG, url: '' })).toEqual([]);
    expect(s.buildSongCards(null)).toEqual([]);
  });
});

describe('点歌命令：三种结局各说各的话', () => {
  test('搜到了 → 发一张音乐卡片，并且这条消息到此为止', async () => {
    const s = loadSong();
    const handled = await s.maybeHandleSongCommand('点歌 发如雪', '292298495');
    expect(handled).toBe(true);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].action).toBe('send_group_message');
    expect(s.calls[0].payload.group_id).toBe(292298495);
    expect(s.calls[0].payload.message[0].type).toBe('light_app');
  });

  test('问了但没有这首 → 回一句"没找到"，仍然算处理过', async () => {
    const s = loadSong({ request: async () => ({ results: [] }) });
    const handled = await s.maybeHandleSongCommand('点歌 不存在的歌', '1');
    expect(handled).toBe(true);
    expect(s.calls[0].payload.message[0].data.text).toContain('没找到');
  });

  test('点歌插件没装/停用 → **不拦消息**，让它照常当聊天', async () => {
    const s = loadSong({ request: async () => { throw new Error('plugin.call 的目标插件未启用'); } });
    const handled = await s.maybeHandleSongCommand('点歌 发如雪', '1');
    expect(handled, '问不到提供方时不该把这句话吃掉').toBe(false);
    expect(s.calls, '不该替"没装插件"回一句"没找到"').toHaveLength(0);
  });

  test('light_app 被桥接端拒绝时，退回文本也能发出去', async () => {
    let nth = 0;
    const s = loadSong({
      api: async (action, payload) => {
        nth += 1;
        s.calls.push({ action, payload });
        if (nth === 1) throw new Error('不支持的消息段类型 light_app');
        return { ok: true };
      },
    });
    const handled = await s.maybeHandleSongCommand('点歌 发如雪', '1');
    expect(handled).toBe(true);
    expect(s.calls.map((c) => c.payload.message[0].type)).toEqual(['light_app', 'text']);
    expect(s.calls[1].payload.message[0].data.text).toContain(SONG.url);
  });

  test('哪一级成功要写进日志（客户端显示"暂不支持查看"时，这是唯一线索）', async () => {
    const s = loadSong();
    await s.maybeHandleSongCommand('点歌 发如雪', '1');
    expect(s.notes.join('\n')).toContain('light_app');
  });
});


// 核心说"这一轮带了歌" → QQ 这边发卡片，而不是让模型贴一条裸链接。
//
// 用户的原话："听歌依旧发的是链接，没有发卡片"。真机原因：`我要听发如雪` 走的是**核心的点歌通道**
// （模型写 [SONG] → 核心问点歌插件 → 核心让模型把直链原样发出来），而字面命令「点歌 X」才走
// 插件自己的卡片路径。所以核心的 `meta.music` 一到，平台侧就得把卡片补上。
describe('核心带歌 → 发卡片', () => {
  const META = { music: { title: '发如雪', singer: '周杰伦', provider: 'kuwo' } };

  test('先按歌名+歌手要链接（song_link），再发 light_app 卡片', async () => {
    const s = loadSong({
      request: async (method, payload) => {
        s.requests.push({ method, payload });
        return { url: 'https://example.com/faxue.mp3', title: '发如雪', singer: '周杰伦', cover: 'https://example.com/c.jpg' };
      },
    });
    const card = await s.maybeSendSongCard('1', META);
    expect(s.requests[0].method).toBe('plugin.call');
    expect(s.requests[0].payload).toMatchObject({ method: 'song_link', payload: { song: '发如雪', singer: '周杰伦' } });
    expect(s.calls[0].payload.message[0].type).toBe('light_app');
    expect(card).toMatchObject({ url: 'https://example.com/faxue.mp3' });
  });

  test('核心没带歌 → 什么都不做（省一个往返）', async () => {
    const s = loadSong();
    expect(await s.maybeSendSongCard('1', { music: null })).toBeNull();
    expect(await s.maybeSendSongCard('1', null)).toBeNull();
    expect(s.calls).toHaveLength(0);
    expect(s.requests).toHaveLength(0);
  });

  test('要不到链接 → 不发空卡片，也不发文本（正文里本来就有链接）', async () => {
    const s = loadSong({ request: async () => ({ url: '' }) });
    expect(await s.maybeSendSongCard('1', META)).toBeNull();
    expect(s.calls).toHaveLength(0);
  });

  test('桥接端不认 light_app → 返回 null，不退回文本（避免一条消息两个链接）', async () => {
    const s = loadSong({
      request: async () => ({ url: 'https://example.com/a.mp3', title: '发如雪' }),
      api: async (action, payload) => {
        s.calls.push({ action, payload });
        throw new Error('不支持的消息段类型 light_app');
      },
    });
    expect(await s.maybeSendSongCard('1', META)).toBeNull();
    expect(s.calls).toHaveLength(1);
  });

  test('卡片带上链接后，正文里那条裸链接要去掉', () => {
    const s = loadSong();
    const url = 'http://kw-er.kuwo.cn/e2b2ae7b.mp3?bitrate$128';
    expect(s.stripSongURL(`给你 ${url} 周杰伦的。`, url)).toBe('给你 周杰伦的。');
    expect(s.stripSongURL('就这句，没链接。', url)).toBe('就这句，没链接。');
    expect(s.stripSongURL(`${url}`, url)).toBe('');
  });

  test('模型把链接改写过了也要删掉（真机：下划线被吃掉了）', () => {
    const s = loadSong();
    const url = 'http://kw-er.kuwo.cn/562e/6ae4b2e3/resource/30106/trackmedia/M5000027oMO61wWi55.mp3'
      + '?bitrate$128&source$kwplayer_ar_5.1.0.0_B_jiakong_vh.apk&type$convert_url_with_sign';
    // 真机发出去的样子：`_` 全没了，所以精确比对一定匹配不上
    const mangled = 'http://kw-er.kuwo.cn/562e/6ae4b2e3/resource/30106/trackmedia/M5000027oMO61wWi55.mp3'
      + '?bitrate$128&source$kwplayerar5.1.0.0Bjiakongvh.apk&type$converturlwithsign';
    expect(s.stripSongURL(`给你 ${mangled} 周杰伦的。`, url)).toBe('给你 周杰伦的。');
  });
});
