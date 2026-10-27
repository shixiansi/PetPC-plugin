import { beforeAll, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 真实接口冒烟检查 —— 默认跳过，只有 `BILI_LIVE=1` 时才跑。
//
// 它验证的是单元测试**验证不了**的那一半：wbi 签名在真服务器上到底认不认、四个接口的返回
// 形状是不是还和代码假设的一样、字幕 JSON 是不是真能下下来。签名错一格的表现是 -403，
// 而在本地用一个「自己算、自己比」的实现测签名是测不出这个的。
//
// 刻意的边界：
//  · 只读端点（nav / ranking / view / player / 字幕文件），
//  · **绝不**碰评论、点赞这类会改账号状态的东西，也不使用任何凭据；
//  · 不写任何断言到「第 0 条视频必须是什么」，因为榜单会变 —— 断言的是**形状与签名**。
//
//   BILI_LIVE=1 npx vitest run tests/plugin-bilibili-live.test.js

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-bilibili');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const live = process.env.BILI_LIVE === '1';

describe.skipIf(!live)('真实接口（BILI_LIVE=1）', () => {
  beforeAll(async () => {
    const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
    const parsed = new JSDOM(html);
    document.body.innerHTML = parsed.window.document.body.innerHTML;
    vi.spyOn(window, 'postMessage').mockImplementation(() => {});
    await import(path.join(pluginDir, 'app.js'));
  });

  async function api(pathAndQuery) {
    const res = await fetch(`https://api.bilibili.com${pathAndQuery}`, {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
    });
    const text = await res.text();
    if (text.trim().startsWith('<')) {
      throw new Error(`接口返回了 HTML（多半是风控页）：${pathAndQuery}`);
    }
    return JSON.parse(text);
  }

  test('wbi 签名被真服务器接受，四步都能走通', async () => {
    const { encWbi } = window.__bili;

    // ① nav：拿 wbi key（匿名也给，但 code 是 -101 —— 这正是「非零码也可能是好数据」的例子）
    const nav = await api('/x/web-interface/nav');
    const image = nav.data && nav.data.wbi_img;
    expect(image && image.img_url && image.sub_url, `nav 没给 wbi_img：${JSON.stringify(nav).slice(0, 200)}`).toBeTruthy();
    const base = (url) => String(url).slice(String(url).lastIndexOf('/') + 1).replace(/\.\w+$/, '');
    const img = base(image.img_url);
    const sub = base(image.sub_url);
    // eslint-disable-next-line no-console
    console.log(`nav: img=${img} sub=${sub} isLogin=${nav.data.isLogin}`);

    // ② 分区排行：插件自己的第一个来源
    const ranking = await api('/x/web-interface/ranking/v2?rid=36&type=all');
    expect(ranking.code, 'ranking 返回非 0').toBe(0);
    const list = (ranking.data && ranking.data.list) || [];
    expect(list.length).toBeGreaterThan(0);
    const candidates = list.filter((row) => row.duration >= 60 && row.duration <= 1800).slice(0, 4);
    expect(candidates.length, '榜单里没有时长合适的视频').toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(`ranking/36: ${list.length} 条，取 ${candidates.length} 条候选；首条「${candidates[0].title}」`);

    // ③ view → cid
    const first = candidates[0];
    const view = await api(`/x/web-interface/view?bvid=${first.bvid}`);
    expect(view.code, 'view 返回非 0').toBe(0);
    const cid = Number(view.data.cid || (view.data.pages && view.data.pages[0].cid));
    expect(cid).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(`view: ${first.bvid} cid=${cid} 时长=${Math.round(view.data.duration / 60)} 分钟 tname=${view.data.tname}`);

    // ④ player(wbi) —— 这一步就是签名的真考验
    let playerFound = null;
    for (const item of candidates) {
      const info = await api(`/x/web-interface/view?bvid=${item.bvid}`);
      if (info.code !== 0) continue;
      const itemCid = Number(info.data.cid || (info.data.pages && info.data.pages[0].cid));
      const signed = encWbi({ bvid: item.bvid, cid: itemCid }, img, sub);
      const player = await api(`/x/player/wbi/v2?${signed}`);
      // -403 就是签名错了；这是本文件存在的理由，所以单独说清楚。
      expect(player.code, `player 返回 ${player.code}（-403 = 签名不被接受）：${player.message}`).toBe(0);
      const subtitle = (player.data && player.data.subtitle) || {};
      const tracks = subtitle.subtitles || [];
      // eslint-disable-next-line no-console
      console.log(`player: ${item.bvid} code=0 轨道=${tracks.length} need_login=${subtitle.need_login_subtitle}`);
      if (tracks.length) {
        playerFound = { item, cid: itemCid, tracks };
        break;
      }
    }

    if (!playerFound) {
      // 匿名请求拿不到字幕轨是**当前的事实**（实测 20/20 条都是 0 轨，`need_login_subtitle`
      // 这个字段也已经不在返回里了），所以这里不是失败：签名通过、字幕链路待登录态验证。
      // eslint-disable-next-line no-console
      console.log('这 4 条候选都没有字幕轨。签名已通过；匿名不返回字幕列表 → 需要登录态才能验证第 ⑤ 步。');
      return;
    }

    // ⑤ 下载字幕 JSON
    const track = playerFound.tracks.find((row) => row.lan === 'zh-CN') || playerFound.tracks[0];
    const url = String(track.subtitle_url).startsWith('//') ? `https:${track.subtitle_url}` : track.subtitle_url;
    const res = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' } });
    expect(res.ok, `字幕文件 HTTP ${res.status}`).toBe(true);
    const body = JSON.parse(await res.text());
    expect(Array.isArray(body.body)).toBe(true);
    expect(body.body.length).toBeGreaterThan(0);
    const firstLine = body.body[0];
    expect(typeof firstLine.from).toBe('number');
    expect(typeof firstLine.to).toBe('number');
    expect(typeof firstLine.content).toBe('string');
    // eslint-disable-next-line no-console
    console.log(`字幕：${playerFound.item.bvid} lan=${track.lan} 段数=${body.body.length} 首段「${firstLine.content.slice(0, 30)}」`);
  }, 120000);
});
