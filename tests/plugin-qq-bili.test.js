import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// B 站联动（B 站插件 → QQ 插件）的行为测试。
//
// 单独一个文件而不是塞进 plugin-qq.test.js：那一个已经 52 例、装着自己的假宿主，而这里要
// 验证的是**另一条链路**（群消息 → bili-jobs → bili-results → ffmpeg → 发群）。共用假宿主
// 会让两边互相牵连：bridge 的 5 秒定时器会污染聊天用例的请求日志。
//
// 钉住四件事：
//   1. 开关关着时一条共享值都不写；
//   2. 打开后把链接写进自己的 bili-jobs，并记住它属于哪个群（结果里没有群号，也不该有）；
//   3. 拿到结果后：起 ffmpeg → 轮询 process.state → 发「@主人 + 文字 + 视频段」；
//   4. 失败路径（没有 ffmpeg / 结果说不行）回一句并附链接，且 5 分钟内不重复。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-qq');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

// 脚本清单从 panel.html 读：插件是一组经典脚本（lib/*.js + app.js），单独 import app.js
// 只会拿到入口那一支，别的模块里的函数一个都不在作用域里。清单只留一份，加文件时不会漏。
const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1])
  .filter((src) => src && !src.startsWith('http'));
const bundle = scriptSources
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-qq';
const ALL_GRANTED = [...manifest.permissions];

let windowListeners = [];
let intervals = [];
let timeouts = [];
let storageMap = new Map();
let shareMap = new Map();
let bootValues = {};
let launches = [];
let processStates = [];
let llmPrompts = [];
/** How many upcoming `send_group_message` calls the protocol side should refuse. */
let sendFails = 0;
/** What `storage.stat` reports for the muxed file; tests lower it to simulate a truncation. */
let statBytes = 75 * 1024 * 1024;
const answered = new Set();

function installPanel() {
  document.body.innerHTML = new JSDOM(html).window.document.body.innerHTML;
}

async function loadApp() {
  vi.resetModules();
  // 和 plugin-qq.test.js 同一套：拼起来的源码放进一个新的函数作用域，等于重新加载整组脚本。
  // eslint-disable-next-line no-new-func
  new Function(bundle)();
}

function posted() {
  return window.postMessage.mock.calls.map((call) => call[0]);
}

function requests() {
  return posted().filter((message) => message && message.type === 'request')
    .map((message) => ({ id: message.id, method: message.method, payload: message.payload }));
}

function requestsFor(method) {
  return requests().filter((request) => request.method === method);
}

function hostSends(data) {
  window.dispatchEvent(new MessageEvent('message', { data, source: window }));
}

function answer(id, result, { ok = true, error = '' } = {}) {
  answered.add(id);
  hostSends({ v: 1, type: 'response', id, ok, result, error });
}

function answerPlumbing() {
  for (const req of requests()) {
    if (answered.has(req.id)) continue;
    const payload = req.payload || {};
    switch (req.method) {
      case 'config.get':
        answer(req.id, { values: bootValues, secrets: {} });
        break;
      case 'storage.get': {
        const key = String(payload.key || '');
        answer(req.id, { value: storageMap.has(key) ? storageMap.get(key) : '' });
        break;
      }
      case 'storage.set':
        storageMap.set(String(payload.key || ''), String(payload.value || ''));
        answer(req.id, { ok: true });
        break;
      case 'storage.remove':
        storageMap.delete(String(payload.key || ''));
        answer(req.id, { ok: true });
        break;
      case 'storage.dir':
        // The real host resolves `sub` and creates that folder; the products therefore land
        // in `video\` and the intermediate streams in `video\tmp\`. It hands back an OS
        // path, so the separators are backslashes - the plugin joins a file name to it.
        answer(req.id, {
          dir: ['C:', 'data', 'plugin-data', 'com.shixiansi.plugin-qq', String(payload.sub || '').replace(/\//g, '\\')]
            .filter(Boolean)
            .join('\\'),
        });
        break;
      case 'storage.list':
        // This install is already tidied (`storage.stat` reports the layout marker), so the
        // sweep never runs; an empty listing keeps the fake host honest if it ever does.
        answer(req.id, { dir: 'C:\\data\\plugin-data\\com.shixiansi.plugin-qq', files: [], dirs: [] });
        break;
      case 'storage.stat':
        // 产物的真实体积由测试决定：`statBytes` 用来模拟「下了一半」这种情况。
        answer(req.id, { exists: true, bytes: statBytes });
        break;
      case 'share.get': {
        const owner = String(payload.owner || 'self');
        const name = String(payload.name || '');
        answer(req.id, { value: shareMap.get(`${owner}/${name}`) || '', at: Date.now() });
        break;
      }
      case 'share.set':
        shareMap.set(`self/${String(payload.name || '')}`, String(payload.value || ''));
        answer(req.id, { ok: true });
        break;
      case 'process.launch':
        launches.push(payload);
        answer(req.id, { pid: 4242 });
        break;
      case 'process.state':
        // First poll: still running; then it finishes with whatever the test queued.
        answer(req.id, processStates.length ? processStates.shift() : { known: true, running: false, exitCode: 0 });
        break;
      case 'ws.open':
        answer(req.id, { ok: true, state: 'open' });
        break;
      case 'llm.chat':
        // The prompt is the assertion in the card-rendering test: what the model SEES is
        // the only thing that decides whether it can react to a shared card.
        llmPrompts.push(String(payload.text || ''));
        answer(req.id, { text: '收到了' });
        break;
      case 'llm.profile':
        answer(req.id, { source: 'borrowed', lender: { id: 'com.shixiansi.plugin-chat', name: '对话插件' }, model: 'x' });
        break;
      case 'net.fetch':
        // `sendFails` lets a test make the protocol side refuse, which is how the two-URI
        // fallback and the "do not delete the file" rule get exercised.
        if (String((payload || {}).url || '').includes('send_group_message') && sendFails > 0) {
          sendFails -= 1;
          answer(req.id, null, { ok: false, error: 'Internal error: File not found: /C:/data/x' });
          break;
        }
        // 真实协议端会回 message_seq；日志里记下它，才能和 Yogurt 的日志对上号。
        answer(req.id, {
          status: 200,
          body: String((payload || {}).url || '').includes('send_group_message')
            ? JSON.stringify({ status: 'ok', retcode: 0, data: { message_seq: 45667 } })
            : '{}',
        });
        break;
      default:
        answer(req.id, { ok: true });
        break;
    }
  }
}

async function pump(rounds = 40) {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
    answerPlumbing();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function initFrame() {
  return {
    v: 1,
    type: 'init',
    pluginId: PLUGIN_ID,
    permissions: ALL_GRANTED,
    granted: ALL_GRANTED,
    surface: { kind: 'panel', slot: 'background' },
  };
}

function groupMessage(text, { groupID = 10086, senderID = 20001, selfID = 90001, segments } = {}) {
  return {
    v: 1,
    type: 'event',
    name: 'ws.message',
    payload: {
      text: JSON.stringify({
        event_type: 'message_receive',
        time: 1700000000,
        self_id: selfID,
        data: {
          message_scene: 'group',
          peer_id: groupID,
          message_seq: 7,
          sender_id: senderID,
          time: 1700000000,
          segments: segments || [{ type: 'text', data: { text } }],
          group: { group_id: groupID, group_name: '测试群' },
          group_member: { user_id: senderID, nickname: '小明', card: '小明', role: 'member' },
        },
      }),
    },
  };
}

async function boot(values) {
  bootValues = values;
  await loadApp();
  // ffmpeg 的轮询间隔在测试里归零：否则每个用例都要真等 2 秒。
  if (window.__qq) window.__qq.state.biliPollMs = 0;
  hostSends(initFrame());
  await pump();
}

async function sayLink(text, options) {
  hostSends(groupMessage(text, options));
  await pump(30);
}

beforeEach(() => {
  installPanel();
  windowListeners = [];
  intervals = [];
  timeouts = [];
  storageMap = new Map();
  shareMap = new Map();
  bootValues = {};
  launches = [];
  processStates = [];
  llmPrompts = [];
  sendFails = 0;
  statBytes = 75 * 1024 * 1024;
  answered.clear();
  const originalAdd = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(function (type, fn, opts) {
    windowListeners.push([type, fn, opts]);
    return originalAdd(type, fn, opts);
  });
  vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  const originalInterval = window.setInterval.bind(window);
  vi.spyOn(window, 'setInterval').mockImplementation((fn, ms) => {
    const id = originalInterval(fn, ms);
    intervals.push(id);
    return id;
  });
  const originalTimeout = window.setTimeout.bind(window);
  vi.spyOn(window, 'setTimeout').mockImplementation((fn, ms) => {
    const id = originalTimeout(fn, ms);
    timeouts.push(id);
    return id;
  });
});

afterEach(() => {
  for (const id of intervals) window.clearInterval(id);
  for (const id of timeouts) window.clearTimeout(id);
  intervals = [];
  timeouts = [];
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  vi.restoreAllMocks();
});

/** The plugin's own published jobs, parsed. */
function publishedJobs() {
  const raw = shareMap.get('self/bili-jobs');
  return raw ? JSON.parse(raw) : [];
}

/** Feeds one result as if the Bilibili plugin had written it. */
function seedResult(result) {
  shareMap.set(
    'com.shixiansi.plugin-bilibili/bili-results',
    JSON.stringify([{ at: Date.now(), ...result }]),
  );
}

describe('群里的 B 站链接', () => {
  test('开关关着时一条共享值都不写', async () => {
    await boot({ biliLinkReply: 'false' });
    await sayLink('看这个 https://www.bilibili.com/video/BV1xx411c7mD 挺有意思');
    expect(shareMap.get('self/bili-jobs')).toBeUndefined();
    expect(shareMap.get('com.shixiansi.plugin-bilibili/bili-results')).toBeUndefined();
  });

  test('打开后写进 bili-jobs，并带上体积与时长上限', async () => {
    await boot({ biliLinkReply: 'true', biliMaxMB: '60', biliMaxMinutes: '12' });
    await sayLink('看这个 https://www.bilibili.com/video/BV1xx411c7mD 挺有意思');
    const jobs = publishedJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].url).toContain('BV1xx411c7mD');
    expect(jobs[0].maxMB).toBe(60);
    expect(jobs[0].maxMinutes).toBe(12);
    expect(jobs[0].id).toBeTruthy();
  });

  test('bili2233.cn 也是短链', async () => {
    await boot({ biliLinkReply: 'true' });
    await sayLink('https://bili2233.cn/abcdefg 这个');
    const jobs = publishedJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].url).toContain('bili2233.cn');
  });

  test('同一条链接 5 分钟内不重复请求', async () => {
    await boot({ biliLinkReply: 'true' });
    await sayLink('https://www.bilibili.com/video/BV1xx411c7mD');
    const first = publishedJobs().length;
    await sayLink('again https://www.bilibili.com/video/BV1xx411c7mD');
    expect(publishedJobs()).toHaveLength(first);
  });

  test('不在白名单的群不写', async () => {
    await boot({ biliLinkReply: 'true', groupAllow: '99999' });
    await sayLink('https://www.bilibili.com/video/BV1xx411c7mD', { groupID: 10086 });
    expect(shareMap.get('self/bili-jobs')).toBeUndefined();
  });
});

describe('B 站分享卡片', () => {
  // 卡片的链接不在文字里：它是 `json` / `xml` / `light_app` 段，BV 号藏在
  // `meta.detail_1.qqdocurl` / `meta.news.jumpUrl` / XML 的 `<url>` 里，而且整个负载
  // 往往是一段**被转义过的 JSON 字符串**（`https:\/\/…`）。
  async function cardRoundTrip(segments, options) {
    await boot({ biliLinkReply: 'true', ...options });
    hostSends(groupMessage('', { segments }));
    await pump(30);
    return publishedJobs();
  }

  test('structmsg 卡片（json 段，带转义斜杠）', async () => {
    const payload = JSON.stringify({
      app: 'com.tencent.structmsg',
      meta: {
        news: {
          title: '一条被分享的视频',
          jumpUrl: 'https://www.bilibili.com/video/BV1xx411c7mD?share_source=qq&spm=1',
          preview: 'https://i0.hdslb.com/cover.jpg',
        },
      },
    });
    const jobs = await cardRoundTrip([{ type: 'json', data: { data: payload } }]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].bvid).toBe('BV1xx411c7mD');
    expect(jobs[0].url).toContain('BV1xx411c7mD');
  });

  test('卡片负载本身是对象（未序列化）也能认出来', async () => {
    const jobs = await cardRoundTrip([{
      type: 'json',
      data: { data: { app: 'com.tencent.structmsg', meta: { detail_1: { qqdocurl: 'https://www.bilibili.com/video/BV1xx411c7mD' } } } },
    }]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].bvid).toBe('BV1xx411c7mD');
  });

  test('xml 段（<url> 里带链接）', async () => {
    const xml = '<msg serviceID="1"><item><title>视频</title></item><item><url>https://www.bilibili.com/video/BV1xx411c7mD</url></item></msg>';
    const jobs = await cardRoundTrip([{ type: 'xml', data: { xml } }]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].bvid).toBe('BV1xx411c7mD');
  });

  test('light_app 的 json_payload 也能认出 b23 短链', async () => {
    const jobs = await cardRoundTrip([{ type: 'light_app', data: { app_name: 'com.tencent.structmsg', json_payload: '{"meta":{"news":{"jumpUrl":"https://b23.tv/abcdefg"}}}' } }]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].url).toContain('b23.tv');
    expect(jobs[0].bvid).toBe('');
  });

  test('卡片里是别的网站就一声不吭', async () => {
    const payload = JSON.stringify({ app: 'com.tencent.structmsg', meta: { news: { jumpUrl: 'https://example.com/whatever' } } });
    const jobs = await cardRoundTrip([{ type: 'json', data: { data: payload } }]);
    expect(jobs).toHaveLength(0);
  });

  test('卡片 + 一句文字，仍然只请求一次', async () => {
    const jobs = await cardRoundTrip([
      { type: 'text', data: { text: '看这个' } },
      { type: 'json', data: { data: '{"meta":{"news":{"jumpUrl":"https://www.bilibili.com/video/BV1xx411c7mD"}}}' } },
    ]);
    expect(jobs).toHaveLength(1);
  });

  test('卡片也要出现在模型看到的文本里（原来整段消失）', async () => {
    // 只修「发视频」不够：主动 @ 机器人时，卡片段此前不在 plainText 的 switch 里，
    // 模型看到的就是一条空消息，于是「分享了个空气」。
    await boot({ biliLinkReply: 'false', atOnly: 'true' });
    hostSends(groupMessage('', {
      segments: [
        { type: 'json', data: { data: '{"meta":{"news":{"title":"一条被分享的视频","jumpUrl":"https://www.bilibili.com/video/BV1xx411c7mD"}}}' } },
        { type: 'mention', data: { user_id: 90001, name: '机器人' } },
        { type: 'text', data: { text: '这个怎么样' } },
      ],
    }));
    await pump(60);
    expect(llmPrompts.length).toBeGreaterThan(0);
    const prompt = llmPrompts[llmPrompts.length - 1];
    expect(prompt).toContain('[卡片：一条被分享的视频]');
    expect(prompt).toContain('这个怎么样');
  });
});

describe('结果回到群里', () => {
  const okResult = (id) => ({
    id,
    ok: true,
    bvid: 'BV1xx411c7mD',
    title: '一条测试视频',
    up: '某个 UP',
    duration: 300,
    qn: 64,
    kind: 'dash',
    sizeBytes: 75 * 1024 * 1024,
    video: { url: 'https://cdn.example/720.m4s', backups: ['https://cdn-backup.example/720.m4s'] },
    audio: { url: 'https://cdn.example/audio.m4s', backups: ['https://cdn-backup.example/audio.m4s'] },
    reason: '',
  });

  /** Boots, makes a job, then answers it — the full loop. */
  async function roundTrip(resultFor) {
    await boot({
      biliLinkReply: 'true',
      biliLinkAtOwner: 'true',
      ownerQQ: '12345',
      ffmpegPath: 'D:\\ffmpeg\\bin\\ffmpeg.exe',
    });
    await sayLink('https://www.bilibili.com/video/BV1xx411c7mD');
    const job = publishedJobs()[0];
    seedResult(resultFor(job.id));
    // Not awaited: the tick blocks on host requests, and this harness only answers them
    // while `pump` runs. Awaiting first is a deadlock, not a slow test.
    void window.__qq.bridgeTick();
    await pump(60);
    return job;
  }

  test('curl 下两条流，ffmpeg 只做本地合并，然后发「@主人 + 文字 + 视频」', async () => {
    const job = await roundTrip(okResult);
    // 三次进程：curl 下视频、curl 下音频、ffmpeg 合并本地文件。
    // 让 ffmpeg 自己当 HTTP 客户端是上一版的做法，参数一多就撞 32 个上限。
    expect(launches).toHaveLength(3);
    const [curlVideo, curlAudio, mux] = launches;
    expect(curlVideo.path).toContain('curl.exe');
    expect(curlVideo.args.join(' ')).toContain('720.m4s');
    expect(curlAudio.args.join(' ')).toContain('audio.m4s');
    // 中间流下在 `video\tmp\`（合成完就删），成品写进 `video\`（要活到协议端上传完）。
    // 两者混在一个目录里时，谁也说不清哪个能删。
    expect(curlVideo.args.join(' ')).toContain('com.shixiansi.plugin-qq\\media\\video\\tmp\\bili');
    expect(mux.path).toContain('ffmpeg.exe');
    // 两条输入（视频 + 音频）→ 要显式映射，否则 ffmpeg 只认第一路的音轨
    expect(mux.args.join(' ')).toContain('-map 0:v:0 -map 1:a:0');
    // ffmpeg 只碰本地路径：参数里不该再出现任何 http 地址
    expect(mux.args.join(' ')).not.toContain('http');
    expect(mux.args[mux.args.length - 1]).toContain('bilivideo');

    const sent = requestsFor('net.fetch').filter((req) => String((req.payload || {}).url || '').includes('send_group_message'));
    expect(sent).toHaveLength(1);
    const message = sent[0].payload.body;
    expect(message).toContain('"type":"mention"');
    expect(message).toContain('12345');
    expect(message).toContain('一条测试视频');
    expect(message).toContain('"type":"video"');
    // 首选形式是 `file://` + 盘符（**两个**斜杠）：真机上 `file:///C:/…` 被协议端截成
    // `/C:/…`，而裸路径又没有 scheme。两个报错拼起来只有这一种写法是自洽的。
    expect(message).toContain('file://C:/data/plugin-data/com.shixiansi.plugin-qq/media/video/bilivideo');
    expect(message).not.toContain('file:///');
  });

  test('没有 ffmpeg 路径时只发链接，并说明原因', async () => {
    await boot({ biliLinkReply: 'true', ownerQQ: '12345', ffmpegPath: '' });
    await sayLink('https://www.bilibili.com/video/BV1xx411c7mD');
    const job = publishedJobs()[0];
    seedResult(okResult(job.id));
    // Not awaited: the tick blocks on host requests, and this harness only answers them
    // while `pump` runs. Awaiting first is a deadlock, not a slow test.
    void window.__qq.bridgeTick();
    await pump(60);
    expect(launches).toHaveLength(0);
    const sent = requestsFor('net.fetch').filter((req) => String((req.payload || {}).url || '').includes('send_group_message'));
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.body).toContain('ffmpeg');
    expect(sent[0].payload.body).toContain('BV1xx411c7mD');
    expect(sent[0].payload.body).not.toContain('"type":"video"');
  });

  test('解析失败时回一句原因，不装成功', async () => {
    await boot({ biliLinkReply: 'true', ownerQQ: '12345', ffmpegPath: 'D:\\ffmpeg\\bin\\ffmpeg.exe' });
    await sayLink('https://www.bilibili.com/video/BV1xx411c7mD');
    const job = publishedJobs()[0];
    seedResult({ id: job.id, ok: false, bvid: 'BV1xx411c7mD', title: '一条测试视频', reason: '时长 30 分钟超过上限 25 分钟' });
    // Not awaited: the tick blocks on host requests, and this harness only answers them
    // while `pump` runs. Awaiting first is a deadlock, not a slow test.
    void window.__qq.bridgeTick();
    await pump(60);
    expect(launches).toHaveLength(0);
    const sent = requestsFor('net.fetch').filter((req) => String((req.payload || {}).url || '').includes('send_group_message'));
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.body).toContain('没法直接发');
    expect(sent[0].payload.body).toContain('时长');
  });

  test('两次尝试都非 0 退出时才改发链接', async () => {
    await boot({ biliLinkReply: 'true', ownerQQ: '12345', ffmpegPath: 'D:\\ffmpeg\\bin\\ffmpeg.exe' });
    // 主地址和备用 CDN 都失败：现在会先换节点重试一次，所以这里要排两次失败。
    processStates = [
      { known: true, running: false, exitCode: 1 },
      { known: true, running: false, exitCode: 1 },
    ];
    await sayLink('https://www.bilibili.com/video/BV1xx411c7mD');
    const job = publishedJobs()[0];
    seedResult(okResult(job.id));
    // Not awaited: the tick blocks on host requests, and this harness only answers them
    // while `pump` runs. Awaiting first is a deadlock, not a slow test.
    void window.__qq.bridgeTick();
    await pump(160);
    const sent = requestsFor('net.fetch').filter((req) => String((req.payload || {}).url || '').includes('send_group_message'));
    expect(sent).toHaveLength(1);
    // 现在的失败原因是 curl 的退出码（下载归 curl，ffmpeg 只合并）
    expect(sent[0].payload.body).toContain('curl 退出码 1');
  });

  test('首选形式被拒时，自动再用 file:/// 试一次', async () => {
    await boot({ biliLinkReply: 'true', ownerQQ: '12345', ffmpegPath: 'D:\\ffmpeg\\bin\\ffmpeg.exe' });
    await sayLink('https://www.bilibili.com/video/BV1xx411c7mD');
    const job = publishedJobs()[0];
    seedResult(okResult(job.id));
    sendFails = 1; // 第一次（file:// + 盘符）被协议端拒掉
    void window.__qq.bridgeTick();
    await pump(80);
    const sent = requestsFor('net.fetch').filter((req) => String((req.payload || {}).url || '').includes('send_group_message'));
    expect(sent).toHaveLength(2);
    expect(sent[0].payload.body).toContain('file://C:/');
    expect(sent[1].payload.body).toContain('file:///C:/');
  });

  test('两种 URI 都被拒时：不发假成功，文件也不删', async () => {
    await boot({ biliLinkReply: 'true', ownerQQ: '12345', ffmpegPath: 'D:\\ffmpeg\\bin\\ffmpeg.exe' });
    await sayLink('https://www.bilibili.com/video/BV1xx411c7mD');
    const job = publishedJobs()[0];
    seedResult(okResult(job.id));
    sendFails = 3; // 三种 uri 形式全被拒
    void window.__qq.bridgeTick();
    await pump(90);
    // 产物留在盘上：失败时删掉它，等于把唯一的证据也删了（真机上就是这么丢掉文件的）。
    // 被删的只能是中间文件（curl 下的视频流 / 音频流）。
    const removed = requestsFor('storage.remove').map((req) => String((req.payload || {}).key || ''));
    expect(removed.filter((key) => key.startsWith('media/video/bilivideo'))).toHaveLength(0);
    // 而「发不出去」的说明里**必须**有链接：这时它是唯一的交付物。
    const notices = requestsFor('net.fetch').filter((req) => String((req.payload || {}).url || '').includes('send_group_message'));
    expect(notices.some((req) => String(req.payload.body || '').includes('bilibili.com/video/'))).toBe(true);
  });

  test('失败过的链接允许立刻重试（5 分钟去重不该禁掉重试）', async () => {
    await boot({ biliLinkReply: 'true', ownerQQ: '12345', ffmpegPath: 'D:\\ffmpeg\\bin\\ffmpeg.exe' });
    await sayLink('https://www.bilibili.com/video/BV1xx411c7mD');
    const job = publishedJobs()[0];
    seedResult({ id: job.id, ok: false, bvid: 'BV1xx411c7mD', reason: '时长超限' });
    void window.__qq.bridgeTick();
    await pump(60);
    const afterFirst = publishedJobs().length;
    // 同一个链接再发一次：应该**新**建一个 job（真机上这里被「5 分钟内已经请求过了」挡住了）
    await sayLink('https://www.bilibili.com/video/BV1xx411c7mD');
    expect(publishedJobs().length).toBeGreaterThan(afterFirst);
  });

  test('成功的链接仍然 5 分钟内不重复', async () => {
    await boot({ biliLinkReply: 'true', ownerQQ: '12345', ffmpegPath: 'D:\\ffmpeg\\bin\\ffmpeg.exe' });
    await sayLink('https://www.bilibili.com/video/BV1xx411c7mD');
    const job = publishedJobs()[0];
    seedResult(okResult(job.id));
    void window.__qq.bridgeTick();
    await pump(60);
    const afterFirst = publishedJobs().length;
    await sayLink('https://www.bilibili.com/video/BV1xx411c7mD');
    expect(publishedJobs().length).toBe(afterFirst);
  });

  test('发完不立刻删文件，只记账（协议端上传是异步的）', async () => {
    await boot({ biliLinkReply: 'true', ownerQQ: '12345', ffmpegPath: 'D:\\ffmpeg\\bin\\ffmpeg.exe' });
    await sayLink('https://www.bilibili.com/video/BV1xx411c7mD');
    const job = publishedJobs()[0];
    seedResult(okResult(job.id));
    void window.__qq.bridgeTick();
    await pump(80);
    // 真机：send_group_message 返回 ok 后立刻删文件，群里那条视频显示「已过期」。
    // 所以**产物**必须留着；被删的只能是两条中间文件（视频流、音频流）。
    const removed = requestsFor('storage.remove').map((req) => String((req.payload || {}).key || ''));
    const ledger = JSON.parse(storageMap.get('state/video') || '[]');
    const outKey = ledger.map((entry) => entry.key).find((key) => key.startsWith('media/video/bilivideo'));
    expect(outKey).toBeTruthy();
    expect(removed).not.toContain(outKey);
    expect(removed.length).toBeGreaterThanOrEqual(2); // 中间文件已清
    // 正文里**不能**出现 B 站链接：群里别的解析机器人会把它当链接再解析一遍，
    // 变成「我们发视频、它回卡片」。真机反馈过这个问题。
    const sent = requestsFor('net.fetch').filter((req) => String((req.payload || {}).url || '').includes('send_group_message'));
    expect(sent[0].payload.body).not.toContain('bilibili.com');
    expect(sent[0].payload.body).toContain('一条测试视频');
    // 日志里带上协议端返回的 message_seq：和 Yogurt 的日志对得上，才查得动「已过期」这类问题。
    expect(storageMap.get('state/log') || '').toContain('seq 45667');
  });

  test('够旧的产物由下一次轮询清掉', async () => {
    await boot({ biliLinkReply: 'true', ownerQQ: '12345', ffmpegPath: 'D:\\ffmpeg\\bin\\ffmpeg.exe' });
    // 11 分钟前留下的两个产物
    const old = Date.now() - 11 * 60 * 1000;
    storageMap.set('state/video', JSON.stringify([
      { key: 'media/video/bilivideoold1', at: old },
      { key: 'media/video/bilivideoold2', at: old },
      { key: 'media/video/bilivideofresh', at: Date.now() },
    ]));
    void window.__qq.bridgeTick();
    await pump(40);
    const removed = requestsFor('storage.remove').map((req) => String((req.payload || {}).key || ''));
    expect(removed).toContain('media/video/bilivideoold1');
    expect(removed).toContain('media/video/bilivideoold2');
    expect(removed).not.toContain('media/video/bilivideofresh');
    const ledger = JSON.parse(storageMap.get('state/video') || '[]');
    expect(ledger.map((entry) => entry.key)).toEqual(['media/video/bilivideofresh']);
  });

  test('卡片噪声里的「BV…」不当作视频（真机蒙出过 BVlkbstVNrVJ）', async () => {
    await boot({ biliLinkReply: 'true' });
    // 粘在更长的字母数字串里：base64/URL 噪声的典型样子
    await sayLink('看这个 xBVlkbstVNrVJyy 和 https://b23.tv/JWeI98I');
    const jobs = publishedJobs();
    // 只认短链那一个，噪声不算
    expect(jobs).toHaveLength(1);
    expect(jobs[0].url).toContain('b23.tv');
  });

  test('「这不是视频」的结果只在日志里说，不往群里发', async () => {
    await boot({ biliLinkReply: 'true', ownerQQ: '12345', ffmpegPath: 'D:\\ffmpeg\\bin\\ffmpeg.exe' });
    await sayLink('https://www.bilibili.com/video/BV1xx411c7mD');
    const job = publishedJobs()[0];
    seedResult({ id: job.id, ok: false, notVideo: true, bvid: 'BVlkbstVNrVJ', reason: '这不是一个能打开的视频' });
    void window.__qq.bridgeTick();
    await pump(60);
    const sent = requestsFor('net.fetch').filter((req) => String((req.payload || {}).url || '').includes('send_group_message'));
    expect(sent).toHaveLength(0);
  });

  test('产物只有预估一半不到时，判定没下完、改发链接', async () => {
    // 判据是体积不是时间：xunlu-core 也是 `fs.statSync(result.path).size` 与上限比。
    await boot({ biliLinkReply: 'true', ownerQQ: '12345', ffmpegPath: 'D:\\ffmpeg\\bin\\ffmpeg.exe' });
    await sayLink('https://www.bilibili.com/video/BV1xx411c7mD');
    const job = publishedJobs()[0];
    seedResult(okResult(job.id));
    statBytes = 20 * 1024 * 1024; // 预估 75 MB，实际只有 20 MB
    void window.__qq.bridgeTick();
    await pump(80);
    const sent = requestsFor('net.fetch').filter((req) => String((req.payload || {}).url || '').includes('send_group_message'));
    // 一条「没法直接发」的说明，没有视频段
    expect(sent.every((req) => !String(req.payload.body || '').includes('"type":"video"'))).toBe(true);
    expect(storageMap.get('state/log') || '').toContain('像是没下完');
  });

  test('主地址失败时自动换备用 CDN 重试', async () => {
    // 真机上 CDN 节点会抽风：同一条直链一会儿 0 字节、一会儿 6 秒下完。换节点重试
    // 比「等更久」有用得多。
    await boot({ biliLinkReply: 'true', ownerQQ: '12345', ffmpegPath: 'D:\\ffmpeg\\bin\\ffmpeg.exe' });
    await sayLink('https://www.bilibili.com/video/BV1xx411c7mD');
    const job = publishedJobs()[0];
    seedResult(okResult(job.id));
    processStates.push({ known: true, running: false, exitCode: 1 }); // 主地址那次下载失败
    void window.__qq.bridgeTick();
    await pump(160);
    // 第一次 curl 用的主地址，重试用的是备用 CDN
    const urls = launches.map((launch) => String(launch.args.join(' ')));
    expect(urls.some((line) => line.includes('cdn-backup.example'))).toBe(true);
    const sent = requestsFor('net.fetch').filter((req) => String((req.payload || {}).url || '').includes('send_group_message'));
    expect(sent.some((req) => String(req.payload.body || '').includes('"type":"video"'))).toBe(true);
  });

  test('下载参数里带超时与重试（否则 CDN 卡住就无限等）', async () => {
    await boot({ biliLinkReply: 'true', ownerQQ: '12345', ffmpegPath: 'D:\\ffmpeg\\bin\\ffmpeg.exe' });
    await sayLink('https://www.bilibili.com/video/BV1xx411c7mD');
    const job = publishedJobs()[0];
    seedResult(okResult(job.id));
    void window.__qq.bridgeTick();
    await pump(80);
    const curl = launches.find((launch) => String(launch.path || '').includes('curl.exe'));
    const line = curl.args.join(' ');
    // 真机：ffmpeg 卡在死连接上，两分钟只用了 0.4 秒 CPU、输出 0 字节。
    // 现在这些开关归 curl：--max-time 兜总时长、--retry 处理瞬时错误、-e 带 Referer。
    expect(line).toContain('--max-time');
    expect(line).toContain('--retry 2');
    expect(line).toContain('-e https://www.bilibili.com/');
  });

  test('ffmpeg 的等待预算按体积给，不再写死 90 秒', async () => {
    // 真机上 59 MB 的 720p 在普通家宽要两三分钟，写死 90 秒必然超时 → 用户看到
    // 「下载超过 90 秒」然后就只收到链接。
    await boot({});
    const { ffmpegBudgetMs } = window.__qq;
    expect(ffmpegBudgetMs(8 * 1024 * 1024)).toBe(90000); // 小文件仍走 90 秒下限
    expect(ffmpegBudgetMs(59 * 1024 * 1024)).toBeGreaterThan(180000); // 59 MB ≈ 4 分钟
    expect(ffmpegBudgetMs(2000 * 1024 * 1024)).toBe(15 * 60 * 1000); // 封顶 15 分钟
  });

  test('同一个结果只处理一次', async () => {
    await boot({ biliLinkReply: 'true', ownerQQ: '12345', ffmpegPath: 'D:\\ffmpeg\\bin\\ffmpeg.exe' });
    await sayLink('https://www.bilibili.com/video/BV1xx411c7mD');
    const job = publishedJobs()[0];
    seedResult(okResult(job.id));
    // Not awaited: the tick blocks on host requests, and this harness only answers them
    // while `pump` runs. Awaiting first is a deadlock, not a slow test.
    void window.__qq.bridgeTick();
    await pump(60);
    const afterFirst = launches.length; // curl 视频 + curl 音频 + ffmpeg 合并
    // Not awaited: the tick blocks on host requests, and this harness only answers them
    // while `pump` runs. Awaiting first is a deadlock, not a slow test.
    void window.__qq.bridgeTick();
    await pump(40);
    // 第二次 tick 不该再起任何进程（结果已经被消费过了）
    expect(launches).toHaveLength(afterFirst);
  });
});

describe('推荐通知', () => {
  test('配了群号才发，且只发文字 + @ 主人', async () => {
    await boot({ biliRecommendGroup: '88888', biliLinkAtOwner: 'true', ownerQQ: '12345' });
    shareMap.set('com.shixiansi.plugin-bilibili/recommend', JSON.stringify([{
      bvid: 'BV1xx411c7mD', title: '刷到的视频', up: 'UP', score: 88, why: '你在做这件事', summary: '摘要', at: Date.now(),
    }]));
    // Not awaited: the tick blocks on host requests, and this harness only answers them
    // while `pump` runs. Awaiting first is a deadlock, not a slow test.
    void window.__qq.bridgeTick();
    await pump(60);
    const sent = requestsFor('net.fetch').filter((req) => String((req.payload || {}).url || '').includes('send_group_message'));
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.body).toContain('88888');
    expect(sent[0].payload.body).toContain('刷到值得看的');
    expect(sent[0].payload.body).toContain('"type":"mention"');
    expect(sent[0].payload.body).not.toContain('"type":"video"');
  });

  test('没配群号就一声不吭', async () => {
    await boot({ biliRecommendGroup: '' });
    shareMap.set('com.shixiansi.plugin-bilibili/recommend', JSON.stringify([{ bvid: 'BV1xx411c7mD', title: 'x', at: Date.now() }]));
    // Not awaited: the tick blocks on host requests, and this harness only answers them
    // while `pump` runs. Awaiting first is a deadlock, not a slow test.
    void window.__qq.bridgeTick();
    await pump(40);
    const sent = requestsFor('net.fetch').filter((req) => String((req.payload || {}).url || '').includes('send_group_message'));
    expect(sent).toHaveLength(0);
  });
});
