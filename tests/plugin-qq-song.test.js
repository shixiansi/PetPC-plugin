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
  sandbox.notes = [];
  sandbox.note = (line) => sandbox.notes.push(String(line));
  sandbox.request = request || (async () => ({ results: [SONG] }));
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
