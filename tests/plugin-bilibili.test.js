import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Behaviour tests for the Bilibili plugin.
//
// Three groups, and each exists because the other two cannot see its failure:
//
//   pure functions   md5/wbi against node's own crypto, the chunker, the digest parser,
//                    the four gates. A bug here is invisible from outside (a wrong
//                    signature is just a -403) and expensive in tokens.
//   manifest + css   the pairing rules the host enforces, the "first secret is the model
//                    key" rule, the config cap, and the two CSS house rules.
//   the frame        the handshake, and one end-to-end debug run driven through a fake
//                    host - which is the only thing that proves the two-frame
//                    architecture works: the market cannot run this pipeline, so the
//                    workshop leaves a command and the pet's frame executes it.

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-bilibili');
const appPath = path.join(pluginDir, 'app.js');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const css = readFileSync(path.join(pluginDir, 'style.css'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const PLUGIN_ID = 'com.shixiansi.plugin-bilibili';
const ALL_GRANTED = [...manifest.permissions];
const configByKey = new Map(manifest.config.map((item) => [item.key, item]));

describe('manifest', () => {
  test('declares the headless frame and a polling permission that fills one', () => {
    // The pairing validateBackground enforces, in its third form: this plugin is told
    // nothing by the host and holds no socket, it decides when to ask.
    expect(manifest.background).toBe(true);
    expect(manifest.permissions).toContain('net.fetch');
    expect(manifest.permissions).not.toContain('events');
    expect(manifest.permissions).not.toContain('net.ws');
  });

  test('asks for credentials, and only together with the network', () => {
    // net.credentials is the SECOND gate of net.fetch; declared alone it would be a
    // switch that unlocks nothing, which the host refuses (validateCredentials).
    expect(manifest.permissions).toContain('net.credentials');
    expect(manifest.permissions).toContain('net.fetch');
  });

  test('the FIRST secret is the model key', () => {
    // The host routes the first secret item to llm.chat as the credential. A plugin that
    // declared the Bilibili cookie first would send it as an API key, and the failure
    // would look like "wrong key" at the model endpoint.
    const secrets = manifest.config.filter((item) => item.secret === true);
    expect(secrets.map((item) => item.key)).toEqual(['llmApiKey', 'biliCookie']);
    expect(secrets[0].type).toBe('secret');
  });

  test('commenting is off by default, and drafts by default when it is on', () => {
    // The one capability that can make the account speak. An update that arrived with
    // this on would post under the user's name without them asking.
    expect(configByKey.get('commentEnabled').default).toBe('false');
    expect(configByKey.get('commentMode').default).toBe('draft');
    expect(configByKey.get('enabled').default).toBe('false');
  });

  test('stays within the host config item limit', () => {
    // Read the cap from the HOST rather than restating the number: it is the host's rule.
    const hostSrc = readFileSync(
      path.join(here, '..', '..', 'internal', 'plugins', 'manifest.go'), 'utf8');
    const cap = Number((hostSrc.match(/maxConfigItems = (\d+)/) || [])[1]);
    expect(cap).toBeGreaterThan(0);
    expect(manifest.config.length).toBeLessThanOrEqual(cap);
  });

  test('every host the code calls is on the allow-list', () => {
    // Exact-host matching, no wildcards: a missing entry is a request that dies inside
    // the host with "未声明的域名", i.e. a feature that looks broken for no visible reason.
    for (const host of [
      'api.bilibili.com',
      'passport.bilibili.com', // 扫码登录的 generate/poll
      'aisubtitle.hdslb.com',
      'i0.hdslb.com',
      'www.bilibili.com',
    ]) {
      expect(manifest.netHosts, `netHosts is missing ${host}`).toContain(host);
    }
  });

  test('app.js 的 DEFAULTS 与 manifest 的默认值逐项一致', async () => {
    // 两处真相会走样，而且走样的方式很隐蔽：清单改了默认值、DEFAULTS 没改，于是
    // 「用户没动过这个设置」时用的是 app.js 那份旧值。真机上就是这样把
    // summaryMaxCalls 的 6 又变回 4，13 分钟的视频只读了前半段。
    await loadApp();
    const defaults = window.__bili.DEFAULTS;
    for (const item of manifest.config) {
      if (item.secret) continue; // 密钥没有默认值
      if (item.default === undefined) continue;
      expect(defaults[item.key], `DEFAULTS 缺少 ${item.key}`).toBe(item.default);
    }
    const declared = new Set(manifest.config.map((item) => item.key));
    for (const key of Object.keys(defaults)) {
      expect(declared.has(key), `DEFAULTS 多出清单里没有的 ${key}`).toBe(true);
    }
  });
});

describe('style.css', () => {
  test('[hidden] wins with !important', () => {
    // Both appearances are in one document and the workshop sets display:flex, which
    // would outrank the user agent's [hidden] rule - putting a workshop on screen inside
    // the pet's invisible frame.
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const match = stripped.match(/\[hidden\][^{]*\{([^}]*)\}/);
    expect(match, 'style.css has no [hidden] rule').toBeTruthy();
    expect(match[1]).toMatch(/display\s*:\s*none/);
    expect(match[1]).toMatch(/!important/);
  });

  test('nothing paints outside an element box', () => {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const prop of ['box-shadow', 'filter:', 'text-shadow', 'transform:']) {
      expect(stripped, `style.css uses ${prop}, which paints outside the crop`).not.toContain(prop);
    }
  });

  test('has a light palette as well as the dark one', () => {
    expect(css).toContain(':root[data-theme="light"]');
  });
});

describe('md5', () => {
  /** The reference implementation, from Node. */
  const reference = (text) => createHash('md5').update(Buffer.from(text, 'utf8')).digest('hex');

  beforeEach(async () => {
    await loadApp();
  });

  test('matches node for ascii, empty and multi-block input', () => {
    for (const text of ['', 'abc', 'x'.repeat(100), 'a=1&b=2wts=1700000000']) {
      expect(window.__bili.md5(text), `md5(${JSON.stringify(text)})`).toBe(reference(text));
    }
  });

  test('hashes UTF-8 bytes, not UTF-16 code units', () => {
    // The classic way this breaks: `md5('中文')` of four UTF-16 chars is a different
    // digest from the six UTF-8 bytes the server signed. It only breaks for non-ASCII,
    // which makes it look like a key problem rather than an encoding one.
    expect(window.__bili.md5('中文')).toBe(reference('中文'));
    expect(window.__bili.md5('中文')).toBe('a7bac2239fcdcb3a067903d8077c4a07');
  });
});

describe('wbi signature', () => {
  // The 64-entry shuffle table is DATA of the algorithm, not logic, so the reference
  // below repeats it on purpose: the assertion that matters is that OUR md5, OUR sorting
  // and OUR filtering reproduce the string the server recomputes.
  const TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42,
    19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51,
    30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
  ];

  beforeEach(async () => {
    await loadApp();
  });

  test('reproduces the server-side string', () => {
    const img = '7cd084941338484aae1ad9425b84077c';
    const sub = '4932caff0ff746eab6f01bf08b70ac45';
    const params = { bvid: 'BV1xx411c7mD', cid: 12345 };
    const wts = 1700000000;
    const mixin = TAB.map((index) => (img + sub).charAt(index)).join('').slice(0, 32);
    const query = Object.keys({ ...params, wts })
      .sort()
      .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(({ ...params, wts })[key]))}`)
      .join('&');
    const expected = `${query}&w_rid=${createHash('md5').update(query + mixin).digest('hex')}`;
    expect(window.__bili.encWbi(params, img, sub, wts)).toBe(expected);
  });

  test('strips the four characters the server strips, and sorts the keys', () => {
    const signed = window.__bili.encWbi({ keyword: "a!b'c(d)e*f", bvid: 'BV1xx411c7mD' }, 'k'.repeat(32), 's'.repeat(32), 1700000000);
    expect(signed.startsWith('bvid=BV1xx411c7mD&keyword=abcdef&wts=1700000000&w_rid=')).toBe(true);
  });

  test('is deterministic for the same inputs and varies with wts', () => {
    const one = window.__bili.encWbi({ bvid: 'BV1' }, 'a', 'b', 1700000000);
    const two = window.__bili.encWbi({ bvid: 'BV1' }, 'a', 'b', 1700000000);
    const later = window.__bili.encWbi({ bvid: 'BV1' }, 'a', 'b', 1700000001);
    expect(one).toBe(two);
    expect(one).not.toBe(later);
  });
});

describe('字幕清洗与切块', () => {
  beforeEach(async () => {
    await loadApp();
  });

  test('stripTags eats annotation tokens and keeps real text', () => {
    const { stripTags } = window.__bili;
    expect(stripTags('[音乐] 大家好　[掌声]')).toBe('大家好');
    expect(stripTags('♪♪ 这一句里有 [一个很长的括号内容超过十二个字所以不该被删] 的词')).toContain('一个很长的括号内容');
  });

  test('mergeSegments joins fragments but stops at a full stop', () => {
    const { mergeSegments } = window.__bili;
    const merged = mergeSegments([
      { from: 0, to: 1, content: '今天讲' },
      { from: 1.1, to: 2, content: '一个事' },
      { from: 2.2, to: 3, content: '。然后' },
      { from: 3.1, to: 4, content: '继续' },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].content).toBe('今天讲一个事。然后继续');
  });

  test('mergeSegments keeps a gap open', () => {
    const { mergeSegments } = window.__bili;
    const merged = mergeSegments([
      { from: 0, to: 1, content: '第一句' },
      { from: 2, to: 3, content: '很久以后' },
    ]);
    expect(merged).toHaveLength(2);
  });

  test('chunkSegments splits on the time cap and never exceeds the rune cap', () => {
    const { chunkSegments } = window.__bili;
    const segments = [];
    for (let i = 0; i < 40; i += 1) {
      segments.push({ from: i * 10, to: i * 10 + 9, content: '这是一句十个字的字幕内容。' });
    }
    const chunks = chunkSegments(segments, { seconds: 60, maxRunes: 3500 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.to - chunk.from).toBeLessThanOrEqual(70);
      expect(Array.from(chunk.text).length).toBeLessThanOrEqual(3500);
    }
  });

  test('chunkSegments also splits on the rune cap', () => {
    const { chunkSegments } = window.__bili;
    const segments = [{ from: 0, to: 1, content: '字'.repeat(4000) }];
    const chunks = chunkSegments(segments, { seconds: 180, maxRunes: 3500 });
    // One over-long segment is not split mid-sentence: it becomes one chunk that the plan
    // step will refuse to send. What must NOT happen is silent truncation.
    expect(chunks).toHaveLength(1);
    expect(Array.from(chunks[0].text).length).toBe(4000);
  });

  test('planDigest counts every call and reports clipping', () => {
    const { planDigest } = window.__bili;
    const chunks = [{ text: 'a' }, { text: 'b' }, { text: 'c' }];
    const tight = planDigest({ title: 't' }, chunks, { limit: 2 });
    expect(tight.mapChunks).toHaveLength(1);
    expect(tight.calls).toBe(2);
    expect(tight.clipped).toBe(true);
    const roomy = planDigest({ title: 't' }, chunks, { limit: 6 });
    expect(roomy.calls).toBe(4);
    expect(roomy.clipped).toBe(false);
    expect(planDigest({ title: 't' }, [], { limit: 4, isTranscript: false }).calls).toBe(1);
  });
});

describe('摘要解析', () => {
  beforeEach(async () => {
    await loadApp();
  });

  test('reads a fenced answer with prose around it', () => {
    const { parseDigest } = window.__bili;
    const digest = parseDigest('好的，这是结果：\n```json\n{"summary":"讲了 x","points":["a","b"],"useful":true,"score":88,"why":"因为你最近在看 x","comment":"第 3 分钟讲到的 y 挺关键"}\n```\n希望有用。');
    expect(digest.summary).toBe('讲了 x');
    expect(digest.points).toEqual(['a', 'b']);
    expect(digest.score).toBe(88);
    expect(digest.useful).toBe(true);
    expect(digest.comment).toContain('第 3 分钟');
  });

  test('returns null rather than half a digest', () => {
    const { parseDigest } = window.__bili;
    expect(parseDigest('完全没有 JSON')).toBeNull();
    expect(parseDigest('{"summary":')).toBeNull();
    expect(parseDigest('{"points":["a"],"score":90}')).toBeNull();
  });

  test('clamps numbers, lengths and the comment', () => {
    const { parseDigest } = window.__bili;
    const digest = parseDigest(JSON.stringify({
      summary: 's',
      score: 400,
      useful: false,
      comment: '字'.repeat(200),
      points: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'],
    }));
    expect(digest.score).toBe(100);
    expect(Array.from(digest.comment).length).toBe(60);
    expect(digest.points).toHaveLength(5);
  });

  test('buildSystem keeps persona and preferences inside the host limit', () => {
    const { buildSystem, state } = window.__bili;
    state.cfg.persona = '人'.repeat(5000);
    state.cfg.preferences = '偏'.repeat(5000);
    const system = buildSystem(state.cfg);
    expect(Array.from(system).length).toBeLessThanOrEqual(3900);
    expect(system).toContain('人设');
    // At 1500 + 1500 of user text the preference half is what gets cut: the persona is
    // what the user sees in every line, the preferences only steer the score.
    expect(system).toContain('偏');
  });
});

describe('四道闸', () => {
  beforeEach(async () => {
    await loadApp();
    const { state } = window.__bili;
    state.cfg = { ...window.__bili.DEFAULTS };
    state.lastPushAt = 0;
    state.lastCommentAt = 0;
    state.usage = {};
    state.secrets = { biliCookie: { set: true, mask: '••••' } };
  });

  const digest = (over) => ({ summary: 's', points: [], score: 80, useful: true, why: 'w', comment: '这条讲到 x', ...over });

  test('active hours are a real window, including across midnight', () => {
    const { inWindow } = window.__bili;
    const at = (h, m) => new Date(2026, 9, 23, h, m).getTime();
    expect(inWindow(at(10, 0), '09:00-23:00')).toBe(true);
    expect(inWindow(at(23, 30), '09:00-23:00')).toBe(false);
    expect(inWindow(at(1, 0), '22:00-02:00')).toBe(true);
    expect(inWindow(at(12, 0), '22:00-02:00')).toBe(false);
    // An unreadable setting is "no window", not "never": a typo must not silently turn
    // the plugin off.
    expect(inWindow(at(12, 0), '早上到晚上')).toBeNull();
  });

  test('push needs useful + threshold + cap + window + gap', () => {
    const { decidePush } = window.__bili;
    const noon = new Date(2026, 9, 23, 12, 0).getTime();
    expect(decidePush({ digest: digest(), now: noon }).ok).toBe(true);

    expect(decidePush({ digest: digest({ useful: false }), now: noon }).reason).toContain('没用');
    expect(decidePush({ digest: digest({ score: 60 }), now: noon }).reason).toContain('低于阈值');
    expect(decidePush({ digest: digest(), now: noon, lastPushAt: noon - 60 * 1000 }).reason).toContain('太近');

    // The counter is keyed by LOCAL date, so the key is built the same way the plugin
    // builds it - an ISO (UTC) slice would land on the previous day for half the world.
    const localKey = (ms) => {
      const date = new Date(ms);
      const pad = (n) => String(n).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    };
    window.__bili.state.usage = { [localKey(noon)]: { videos: 1, pushes: 5, comments: 0, llmCalls: 0 } };
    expect(decidePush({ digest: digest(), now: noon }).reason).toContain('打扰');
  });

  test('a quiet hour keeps the card out of the bubble but not out of the inbox', () => {
    const { decidePush } = window.__bili;
    const lateNight = new Date(2026, 9, 23, 3, 0).getTime();
    const gate = decidePush({ digest: digest(), now: lateNight });
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain('时段');
  });

  test('comment needs the switch, auto mode, specifics, score, cap and a csrf token', () => {
    const { decideComment, state } = window.__bili;
    expect(decideComment({ digest: digest() }).reason).toContain('总开关');

    state.cfg.commentEnabled = 'true';
    expect(decideComment({ digest: digest() }).reason).toContain('draft');

    state.cfg.commentMode = 'auto';
    state.cfg.biliJct = 'jct';
    expect(decideComment({ digest: digest({ score: 90, comment: '第 3 分钟那个例子很关键' }) }).ok).toBe(true);
    expect(decideComment({ digest: digest({ score: 80, comment: '第 3 分钟那个例子很关键' }) }).reason).toContain('门槛');
    expect(decideComment({ digest: digest({ score: 90, comment: '' }) }).reason).toContain('草稿');

    state.cfg.biliJct = '';
    expect(decideComment({ digest: digest({ score: 90 }) }).reason).toContain('bili_jct');

    state.cfg.biliJct = 'jct';
    state.secrets = { biliCookie: { set: false } };
    expect(decideComment({ digest: digest({ score: 90 }) }).reason).toContain('凭据');
  });

  test('commentTextOk refuses spam, links, self-identification and long text', () => {
    const { commentTextOk } = window.__bili;
    expect(commentTextOk('第 3 分钟那个例子很关键')).toBe(true);
    expect(commentTextOk('加微信拿资料')).toBe(false);
    expect(commentTextOk('看这里 https://x.example')).toBe(false);
    expect(commentTextOk('作为一个观众我觉得很好')).toBe(false);
    expect(commentTextOk('这个 AI 总结得不错')).toBe(false);
    expect(commentTextOk('字'.repeat(61))).toBe(false);
    expect(commentTextOk('   ')).toBe(false);
  });
});

describe('候选与初筛', () => {
  beforeEach(async () => {
    await loadApp();
    window.__bili.state.cfg = { ...window.__bili.DEFAULTS };
  });

  const item = (over) => ({
    bvid: 'BV1xx411c7mD', title: '一个正常的标题', up: 'UP', upMid: '1',
    duration: 600, play: 50000, pubdate: 1000, rid: '36', tname: '知识', ...over,
  });

  test('normaliseItem reads both shapes and rejects a non-BV id', () => {
    const { normaliseItem } = window.__bili;
    const ranked = normaliseItem({ bvid: 'BV1xx411c7mD', title: 't', owner: { mid: 9, name: 'u' }, stat: { view: 7 }, duration: 60, pubdate: 5 }, '36');
    expect(ranked.upMid).toBe('9');
    expect(ranked.play).toBe(7);
    const searched = normaliseItem({ bvid: 'BV1xx411c7mD', title: 't', author: 'a', mid: 8, play: 3, created: 4 }, '');
    expect(searched.up).toBe('a');
    expect(searched.play).toBe(3);
    expect(normaliseItem({ bvid: 'av123' }, '')).toBeNull();
    expect(normaliseItem(null, '')).toBeNull();
  });

  test('each local rule drops its own kind, and the tally adds up', () => {
    const { filterCandidates } = window.__bili;
    const seen = new Set(['BV1000000001']);
    const pool = [
      item({ bvid: 'BV1000000001' }),                                  // already seen
      item({ bvid: 'BV1000000002', upMid: '2' }),                      // blacklisted up
      item({ bvid: 'BV1000000003', duration: 30 }),                    // too short
      item({ bvid: 'BV1000000004', duration: 4000 }),                  // too long
      item({ bvid: 'BV1000000005', play: 10 }),                        // below min play
      item({ bvid: 'BV1000000006', title: '手游抽卡实录' }),           // excluded keyword
      item({ bvid: 'BV1000000007' }),                                  // survives
      item({ bvid: 'BV1000000007' }),                                  // duplicate row
      item({ bvid: 'BV1000000008', upMid: '999' }),                    // survives
    ];
    window.__bili.state.cfg.upBlacklist = '2';
    window.__bili.state.cfg.keywordsInclude = '';
    const { picked, dropped } = filterCandidates(pool, seen);
    expect(picked.map((row) => row.bvid)).toEqual(['BV1000000007', 'BV1000000008']);
    expect(dropped).toMatchObject({ seen: 1, up: 1, duration: 2, play: 1, keyword: 1, dup: 1 });
  });

  test('the owner\'s own video is skipped and the whitelist narrows', () => {
    const { filterCandidates, state } = window.__bili;
    state.cfg.ownerUID = '42';
    state.cfg.upWhitelist = '7';
    const { picked, dropped } = filterCandidates([
      item({ bvid: 'BV1000000001', upMid: '42' }),
      item({ bvid: 'BV1000000002', upMid: '7' }),
      item({ bvid: 'BV1000000003', upMid: '8' }),
    ], new Set());
    expect(picked.map((row) => row.bvid)).toEqual(['BV1000000002']);
    expect(dropped.own).toBe(1);
    expect(dropped.up).toBe(1);
  });

  test('newest first, then most played', () => {
    const { filterCandidates } = window.__bili;
    const { picked } = filterCandidates([
      item({ bvid: 'BV1000000001', pubdate: 100, play: 90000 }),
      item({ bvid: 'BV1000000002', pubdate: 300, play: 20000 }),
      item({ bvid: 'BV1000000003', pubdate: 200, play: 50000 }),
    ], new Set());
    expect(picked.map((row) => row.bvid)).toEqual(['BV1000000002', 'BV1000000003', 'BV1000000001']);
  });
});

// --- the harness -------------------------------------------------------------

let windowListeners = [];
let storageMap = new Map();
let intervals = [];
let timeouts = [];
let bootValues = {};
let fetchScript = [];
let llmAnswer = '';
/** 非空时让 llm.chat 直接失败（模拟服务商的内容审核拒绝）。 */
let llmFail = '';
let llmCalls = 0;
let bubbles = [];
let configSets = [];
/** The host's cross-plugin tray, keyed "<owner>/<name>" ('self' for the plugin's own). */
let shareMap = new Map();

function installPanel() {
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
}

async function loadApp() {
  vi.resetModules();
  await import(appPath);
}

function posted() {
  return window.postMessage.mock.calls.map((call) => call[0]);
}

function byType(type) {
  return posted().filter((message) => message && message.type === type);
}

function requests() {
  return byType('request').map((message) => ({ id: message.id, method: message.method, payload: message.payload }));
}

const answered = new Set();

function hostSends(data) {
  window.dispatchEvent(new MessageEvent('message', { data, source: window }));
}

function answer(id, result, { ok = true, error = '' } = {}) {
  answered.add(id);
  hostSends({ v: 1, type: 'response', id, ok, result, error });
}

/** Answers everything the plugin asks for, the way the real PET host would. */
function answerPlumbing() {
  for (const req of requests()) {
    if (answered.has(req.id)) continue;
    const payload = req.payload || {};
    switch (req.method) {
      case 'config.get':
        answer(req.id, { values: bootValues, secrets: { biliCookie: { set: true, mask: '••••' } } });
        break;
      case 'config.set':
        configSets.push(payload.values || {});
        answer(req.id, { ok: true });
        break;
      case 'share.get': {
        const owner = String(payload.owner || 'self');
        const name = String(payload.name || '');
        answer(req.id, { value: shareMap.get(`${owner}/${name}`) || '', at: Date.now(), key: `${owner}/${name}` });
        break;
      }
      case 'share.set':
        shareMap.set(`self/${String(payload.name || '')}`, String(payload.value || ''));
        answer(req.id, { ok: true });
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
        answer(req.id, { removed: true });
        break;
      case 'net.fetch': {
        const url = String(payload.url || '');
        const hit = fetchScript.find((row) => row.match(url));
        if (!hit) {
          answer(req.id, { status: 404, body: '' });
          break;
        }
        const body = typeof hit.body === 'function' ? hit.body() : hit.body;
        answer(req.id, { status: hit.status || 200, body, cookies: hit.cookies || [] });
        break;
      }
      case 'llm.chat':
        llmCalls += 1;
        if (llmFail) {
          answer(req.id, null, { ok: false, error: llmFail });
          break;
        }
        answer(req.id, { text: llmAnswer });
        break;
      case 'bubble.say':
        bubbles.push(String(payload.text || ''));
        answer(req.id, { ok: true });
        break;
      case 'llm.profile':
        answer(req.id, { source: 'borrowed', lender: { id: 'com.shixiansi.plugin-chat', name: '对话插件' }, model: 'deepseek-chat' });
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

function initFrame({ slot = 'workshop' } = {}) {
  return {
    v: 1,
    type: 'init',
    pluginId: PLUGIN_ID,
    permissions: ALL_GRANTED,
    granted: ALL_GRANTED,
    surface: { kind: 'panel', slot },
    theme: 'dark',
  };
}

beforeEach(() => {
  installPanel();
  windowListeners = [];
  storageMap = new Map();
  intervals = [];
  bootValues = {};
  fetchScript = [];
  llmAnswer = '';
  llmFail = '';
  llmCalls = 0;
  bubbles = [];
  configSets = [];
  shareMap = new Map();
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
  // The QR login polls with setTimeout chains, not setInterval, so a test that ends in the
  // middle of one would leave it scheduling 0 ms timers for the rest of the file - and the
  // next test then competes with a loop nobody can see.
  const originalTimeout = window.setTimeout.bind(window);
  vi.spyOn(window, 'setTimeout').mockImplementation((fn, ms) => {
    const id = originalTimeout(fn, ms);
    timeouts.push(id);
    return id;
  });
});

afterEach(() => {
  for (const id of intervals) window.clearInterval(id);
  intervals = [];
  for (const id of timeouts) window.clearTimeout(id);
  timeouts = [];
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  vi.restoreAllMocks();
});

describe('二维码（扫码登录）', () => {
  // 夹具是怎么来的：本机另一个仓库（E:\lagrangeV2\xunlu-core）里真的装着 `qrcode` 包，
  // 用它离线生成矩阵（纠错等级 M、掩码由库自己挑并记录在夹具里），存成 qr-fixtures.ndjson。
  // 所以这里比对的是**两个独立实现**，不是自己跟自己比。
  //
  // 一个必须写下来的坑：**要让参考库强制 byte 模式**（`[{data, mode:'byte'}]`）。第一次
  // 没强制，库把 "HELLO" 编成了字母数字模式——两种都合法，但那是两张不同的码，矩阵永远
  // 对不上。定位它的办法是「用我方的放置顺序去反读参考矩阵」：反读出来的第一个字节是
  // 0x20（字母数字模式指示符）而不是 0x40（byte 模式），一眼就知道差在哪一层。
  const fixtures = readFileSync(path.join(here, 'qr-fixtures.ndjson'), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

  beforeEach(async () => {
    await loadApp();
  });

  test('每位都对得上参考实现（v1 / v2 / v7 / v8，含 131 字的真实登录 URL）', () => {
    const { qrMatrix } = window.__bili;
    expect(fixtures.length).toBeGreaterThanOrEqual(4);
    const wrong = [];
    for (const fixture of fixtures) {
      const rows = qrMatrix(fixture.text, { version: fixture.version, mask: fixture.mask });
      expect(rows.length, `${fixture.text.slice(0, 12)}… 的尺寸`).toBe(fixture.size);
      const mine = rows.map((row) => row.map((cell) => (cell ? '1' : '0')).join(''));
      const firstDiff = fixture.rows.findIndex((row, index) => row !== mine[index]);
      if (firstDiff >= 0) wrong.push({ version: fixture.version, firstDiff });
    }
    expect(wrong).toEqual([]);
  });

  test('自己挑版本与掩码时仍然是一张合法的码', () => {
    const { qrMatrix } = window.__bili;
    const url = 'https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=1ccd22605ca728606dc834d3ac39db98&from=';
    const rows = qrMatrix(url);
    expect(rows.length).toBe(49); // 131 字节 → v8，和参考实现同一个版本
    // 三个定位图形必须是「7 暗 / 1 亮 / 5 暗 三圈」的样子：抽查左上角那 7×7 的外框。
    const corner = rows.slice(0, 7).map((row) => row.slice(0, 7).map((cell) => (cell ? 1 : 0)).join(''));
    expect(corner).toEqual(['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111']);
    // 空白区之外必须全是布尔值（描边时一个 undefined 就会画成空洞）
    for (const row of rows) for (const cell of row) expect(typeof cell).toBe('boolean');
  });

  test('内容太长时明确失败，而不是画一张错的码', () => {
    const { qrMatrix } = window.__bili;
    expect(() => qrMatrix('A'.repeat(3000))).toThrow(/太长/);
  });

  test('SVG path 只包含矩阵里的暗块', () => {
    const { qrMatrix, qrSvgPath } = window.__bili;
    const rows = qrMatrix('HELLO', { version: 1, mask: 3 });
    let dark = 0;
    for (const row of rows) for (const cell of row) if (cell) dark += 1;
    const path = qrSvgPath(rows, rows.length);
    expect(path.split('M').length - 1).toBe(dark);
  });
});

describe('handshake', () => {
  test('sends one ready frame and no request before init', async () => {
    await loadApp();
    expect(byType('ready')).toHaveLength(1);
    expect(byType('request')).toHaveLength(0);
  });

  test('the workshop renders the status card and does not start a schedule', async () => {
    bootValues = { enabled: 'true', dailyVideoCap: '12', pushDailyCap: '5' };
    storageMap.set('usage', JSON.stringify({}));
    await loadApp();
    hostSends(initFrame({ slot: 'workshop' }));
    await pump();
    expect(document.getElementById('st-run').textContent).toContain('自动刷');
    expect(document.getElementById('st-today').textContent).toContain('0 / 12');
    expect(document.getElementById('st-account').textContent).toContain('未登录');
    // No tick timer: the workshop is a view, not a worker.
    const minuteTimers = intervals.length;
    expect(minuteTimers).toBeLessThanOrEqual(1); // only the 5 s refresh
  });

  test('the workshop leaves a command instead of running the pipeline itself', async () => {
    // The market program implements neither llm.chat nor bubble.say, so "跑一遍" cannot
    // execute where the button is. This test pins the split: a button writes `cmd`, and
    // nothing else happens here.
    await loadApp();
    hostSends(initFrame({ slot: 'workshop' }));
    await pump();
    document.getElementById('dbg-bvid').value = 'BV1xx411c7mD';
    document.getElementById('dbg-run').click();
    await pump();
    const cmd = JSON.parse(storageMap.get('cmd') || 'null');
    expect(cmd).toBeTruthy();
    expect(cmd.kind).toBe('debug');
    expect(cmd.bvid).toBe('BV1xx411c7mD');
    expect(requestsFor('net.fetch')).toHaveLength(0);
  });
});

function requestsFor(method) {
  return requests().filter((request) => request.method === method);
}

describe('一轮（推送与评论）', () => {
  const ranking = (bvids) => JSON.stringify({
    code: 0,
    data: {
      list: bvids.map((bvid, index) => ({
        bvid,
        title: `第 ${index + 1} 条测试视频`,
        owner: { mid: 9, name: '某个 UP' },
        duration: 600,
        stat: { view: 50000 },
        pubdate: 1700000000 - index,
        pic: '',
      })),
    },
  });

  function scriptRound(bvids) {
    fetchScript = [
      {
        name: 'ranking',
        match: (url) => url.includes('/x/web-interface/ranking/v2'),
        body: ranking(bvids),
      },
      {
        name: 'nav',
        match: (url) => url.includes('/x/web-interface/nav'),
        body: JSON.stringify({
          code: 0,
          data: { isLogin: false, wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } },
        }),
      },
      {
        name: 'view',
        match: (url) => url.includes('/x/web-interface/view?'),
        body: JSON.stringify({
          code: 0,
          data: {
            aid: 111, cid: 222, title: '一条测试视频', desc: '简介', duration: 620,
            tname: '知识', pic: '', owner: { mid: 9, name: '某个 UP' },
            stat: { view: 50000 }, pages: [{ cid: 222 }],
          },
        }),
      },
      {
        name: 'player',
        match: (url) => url.includes('/x/player/wbi/v2'),
        body: JSON.stringify({
          code: 0,
          data: { subtitle: { need_login_subtitle: false, subtitles: [{ lan: 'zh-CN', lan_doc: '中文', ai_type: 0, subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/abc.json' }] } },
        }),
      },
      {
        name: 'subtitle',
        match: (url) => url.includes('aisubtitle.hdslb.com'),
        body: JSON.stringify({ body: [{ from: 0, to: 4, content: '这一段讲了一个具体结论。' }] }),
      },
    ];
    llmAnswer = JSON.stringify({
      summary: '讲了那个结论。', points: ['结论'], useful: true, score: 90,
      why: '你在做这件事', tags: [], comment: '第 1 分钟那个结论挺关键',
    });
  }

  test('a round pushes once, writes the card, and spends the counter', async () => {
    scriptRound(['BV1000000001', 'BV1000000002', 'BV1000000003']);
    bootValues = { enabled: 'true', source: 'ranking', rids: '36', perRound: '3', activeHours: '00:00-23:59' };
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    window.__bili.state.minGapMs = 0;
    await pump();

    const done = window.__bili.runRound({ reason: 'test' });
    await pump(160);
    await done;

    // One bubble for the round, not one per video: "刷屏" is the failure mode the cap
    // exists to prevent, and the inbox is where the other two go.


    expect(bubbles).toHaveLength(1);
    expect(Array.from(bubbles[0]).length).toBeLessThanOrEqual(40);

    const inbox = JSON.parse(storageMap.get('inbox') || '[]');
    expect(inbox).toHaveLength(3);
    expect(inbox[0].score).toBe(90);
    expect(inbox[0].transcript).toBe(true);

    const usage = JSON.parse(storageMap.get('usage') || '{}');
    const today = Object.values(usage)[0];
    expect(today.videos).toBe(3);
    expect(today.pushes).toBe(1);

    const seen = JSON.parse(storageMap.get('seen') || '[]');
    expect(seen).toHaveLength(3);

    // The LAST line must be on disk. The real machine caught the first version skipping a
    // write that arrived while another was in flight: the log ended at "常驻帧起来了",
    // which reads like the plugin died right there.
    const log = JSON.parse(storageMap.get('log') || '[]');
    expect(log[0].text).toContain('这一轮结束');
    expect(log.some((entry) => entry.text.includes('候选'))).toBe(true);
  });

  test('内容被模型服务拒绝时只记一行「跳过」，不当成摘要失败', async () => {
    // 真机：`小说推荐：服务端返回错误：The request contains sensitive content.`
    // 视频标题里带「性转/雌堕」这类词，输入就被服务商拦了。重试没用，也不该显示成错误。
    scriptRound(['BV1000000001']);
    bootValues = { enabled: 'true', source: 'ranking', rids: '36', perRound: '3', activeHours: '00:00-23:59' };
    llmFail = '服务端返回错误：The request contains sensitive content. Please modify your input and try again.';
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    window.__bili.state.minGapMs = 0;
    await pump();

    const done = window.__bili.runRound({ reason: 'test' });
    await pump(120);
    await done;

    const log = JSON.parse(storageMap.get('log') || '[]');
    expect(log.some((entry) => entry.text.includes('跳过'))).toBe(true);
    expect(log.some((entry) => entry.text.includes('sensitive content'))).toBe(false);
    // 一条都不推：被拒的内容没什么可推的
    expect(bubbles).toHaveLength(0);
    const usage = JSON.parse(storageMap.get('usage') || '{}');
    expect(Object.values(usage)[0].pushes).toBe(0);
  });

  test('模型只回一句「无法协助」时也当作跳过', async () => {
    scriptRound(['BV1000000001']);
    bootValues = { enabled: 'true', source: 'ranking', rids: '36', perRound: '3', activeHours: '00:00-23:59' };
    llmAnswer = '抱歉，我无法协助生成这个摘要。';
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    window.__bili.state.minGapMs = 0;
    await pump();

    const done = window.__bili.runRound({ reason: 'test' });
    await pump(120);
    await done;

    const log = JSON.parse(storageMap.get('log') || '[]');
    expect(log.some((entry) => entry.text.includes('跳过'))).toBe(true);
    expect(bubbles).toHaveLength(0);
  });

  test('处理失败的视频会被记下来，下一轮不再抓它', async () => {
    // 真机：「候选 322 条 → … → 取 3 条」每轮都取到同样三条失败品（内容被审核拒），
    // 因为失败不写 seen，于是无限重试。现在失败单独记一份、6 小时 TTL。
    scriptRound(['BV1000000001']);
    bootValues = { enabled: 'true', source: 'ranking', rids: '36', perRound: '3', activeHours: '00:00-23:59' };
    llmFail = 'sensitive content';
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    window.__bili.state.minGapMs = 0;
    await pump();

    const first = window.__bili.runRound({ reason: 'test' });
    await pump(120);
    await first;

    const failed = JSON.parse(storageMap.get('failed') || '[]');
    expect(failed.map((row) => row.bvid)).toContain('BV1000000001');
    // 下一轮它直接被当作「已见过」丢掉
    const log = JSON.parse(storageMap.get('log') || '[]');
    const seenLine = log.find((entry) => entry.text.includes('候选'));
    expect(seenLine).toBeTruthy();
    expect(window.__bili.seenSet().has('BV1000000001')).toBe(true);
  });

  test('a second round skips the videos it already saw', async () => {
    scriptRound(['BV1000000001', 'BV1000000002']);
    bootValues = { enabled: 'true', source: 'ranking', rids: '36', perRound: '3', activeHours: '00:00-23:59' };
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    window.__bili.state.minGapMs = 0;
    await pump();

    const first = window.__bili.runRound({ reason: 'test' });
    await pump(160);
    await first;
    expect(JSON.parse(storageMap.get('inbox') || '[]')).toHaveLength(2);

    // Same candidates again: every one of them is now in `seen`, so the round does no
    // paid work at all - which is the point of remembering them.
    const llmBefore = llmCalls;
    const second = window.__bili.runRound({ reason: 'test' });
    await pump(60);
    await second;
    expect(llmCalls).toBe(llmBefore);
    expect(JSON.parse(storageMap.get('inbox') || '[]')).toHaveLength(2);
  });

  test('commenting is off by default: a round makes no POST at all', async () => {
    scriptRound(['BV1000000001']);
    bootValues = { enabled: 'true', source: 'ranking', rids: '36', perRound: '1' };
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    window.__bili.state.minGapMs = 0;
    await pump();

    const done = window.__bili.runRound({ reason: 'test' });
    await pump(160);
    await done;

    expect(requests().filter((req) => req.method === 'net.fetch'
      && String((req.payload || {}).url || '').includes('/x/v2/reply/add'))).toHaveLength(0);
  });

  test('auto mode posts one form, names the credential, and never puts it in the body', async () => {
    scriptRound(['BV1000000011']);
    bootValues = {
      enabled: 'true', source: 'ranking', rids: '36', perRound: '1',
      commentEnabled: 'true', commentMode: 'auto', biliJct: 'the-jct',
    };
    fetchScript.push({
      name: 'replyAdd',
      match: (url) => url.includes('/x/v2/reply/add'),
      body: JSON.stringify({ code: 0, data: { rpid: 998877 } }),
    });
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    window.__bili.state.minGapMs = 0;
    await pump();

    const done = window.__bili.runRound({ reason: 'test' });
    await pump(200);
    await done;

    const posts = requests().filter((req) => req.method === 'net.fetch'
      && String((req.payload || {}).url || '').includes('/x/v2/reply/add'));
    expect(posts).toHaveLength(1);
    const payload = posts[0].payload;
    // The credential travels as a KEY the host resolves, never as a value the page holds.
    expect(payload.credentials).toBe('biliCookie');
    expect(payload.body).toContain('csrf=the-jct');
    expect(payload.body).toContain('oid=111');
    expect(payload.body).not.toContain('SESSDATA');

    const inbox = JSON.parse(storageMap.get('inbox') || '[]');
    expect(inbox[0].comment.rpid).toBe('998877');
  });
});

describe('单条调试（常驻帧执行）', () => {
  const bvid = 'BV1xx411c7mD';

  function scriptHost() {
    fetchScript = [
      {
        name: 'nav',
        match: (url) => url.includes('/x/web-interface/nav'),
        body: JSON.stringify({
          code: 0,
          data: {
            isLogin: false,
            wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' },
          },
        }),
      },
      {
        name: 'view',
        match: (url) => url.includes('/x/web-interface/view'),
        body: JSON.stringify({
          code: 0,
          data: {
            aid: 111,
            cid: 222,
            title: '一条被调试的视频',
            desc: '简介在这里',
            duration: 620,
            tname: '知识',
            pic: '',
            owner: { mid: 9, name: '某个 UP' },
            stat: { view: 123456 },
            pages: [{ cid: 222 }],
          },
        }),
      },
      {
        name: 'player',
        match: (url) => url.includes('/x/player/wbi/v2'),
        body: JSON.stringify({
          code: 0,
          data: {
            subtitle: {
              need_login_subtitle: false,
              subtitles: [{ lan: 'zh-CN', lan_doc: '中文（中国）', ai_type: 0, subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/abc.json' }],
            },
          },
        }),
      },
      {
        name: 'subtitle',
        match: (url) => url.includes('aisubtitle.hdslb.com'),
        body: JSON.stringify({
          body: [
            { from: 0, to: 3, content: '今天我们讲一个具体的问题。' },
            { from: 3.2, to: 6, content: '先看数据，再说结论。' },
          ],
        }),
      },
    ];
    llmAnswer = JSON.stringify({
      summary: '讲了那个具体问题的原因和一个结论。',
      points: ['先看数据', '再说结论', '结论是 x'],
      useful: true,
      score: 86,
      why: '正好是你在做的那件事',
      tags: ['数据'],
      comment: '第 3 分钟那个数据挺关键',
    });
  }

  test('runs the whole pipeline and writes the report back', async () => {
    scriptHost();
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    await pump();

    storageMap.set('cmd', JSON.stringify({ id: 'd1', kind: 'debug', bvid, at: Date.now() }));
    window.__bili.state.minGapMs = 0;
    const done = window.__bili.pollCommand();
    await pump(80);
    await done;

    const report = JSON.parse(storageMap.get('debug') || 'null');
    expect(report, 'the frame did not write a report').toBeTruthy();
    expect(report.error).toBe('');
    expect(report.ok).toBe(true);
    expect(report.steps.view.text).toContain('cid 222');
    expect(report.steps.player.text).toContain('zh-CN');
    // 字幕轨列表必须**带凭据**去要：匿名请求基本是 0 轨（真机 20/20），于是每条视频都
    // 走「非字幕」降级 —— 用户看到的正是「怎么都是这样」。
    const playerCalls = requests().filter((req) => String((req.payload || {}).url || '').includes('/x/player/wbi/v2'));
    expect(playerCalls).toHaveLength(1);
    expect(playerCalls[0].payload.credentials).toBe('biliCookie');
    expect(report.steps.subtitle.text).toContain('2 段');
    expect(report.card.summary).toContain('具体问题');
    expect(report.card.score).toBe(86);
    expect(report.card.transcript).toBe(true);
    // `draft` is what the card carries; `comment` stays empty until it is actually sent.
    expect(report.card.draft).toBe('第 3 分钟那个数据挺关键');
    expect(report.card.comment).toBeNull();

    // A debug run must NOT spend the day's budget or push anything.
    expect(bubbles).toHaveLength(0);
    const usage = JSON.parse(storageMap.get('usage') || '{}');
    expect(Object.values(usage).every((day) => day.videos === 0)).toBe(true);
    // Two API calls happen before the subtitles (nav + view), so the throttle must have
    // been the only thing between them; the count is asserted to catch a double fetch.
    expect(requestsFor('net.fetch').length).toBeGreaterThanOrEqual(4);
  });

  test('a video without subtitles is summarised from its description and says so', async () => {
    scriptHost();
    fetchScript = fetchScript.filter((row) => row.name !== 'player' && row.name !== 'subtitle');
    fetchScript.push({
      match: (url) => url.includes('/x/web-interface/view/detail/tag'),
      body: JSON.stringify({ code: 0, data: [{ tag_name: '标签一' }] }),
    });
    fetchScript.push({
      match: (url) => url.includes('/x/v2/reply'),
      body: JSON.stringify({ code: 0, data: { replies: [{ content: { message: '热评一' } }] } }),
    });
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    await pump();

    storageMap.set('cmd', JSON.stringify({ id: 'd2', kind: 'debug', bvid, at: Date.now() }));
    window.__bili.state.minGapMs = 0;
    const done = window.__bili.pollCommand();
    await pump(80);
    await done;

    const report = JSON.parse(storageMap.get('debug') || 'null');
    expect(report.ok).toBe(true);
    expect(report.steps.player.state).toBe('warn');
    expect(report.steps.subtitle.text).toContain('非字幕');
    expect(report.card.transcript).toBe(false);
    // The prompt has to tell the model the material is second-hand, or the digest will
    // read as if it had heard the video.
    const chat = requestsFor('llm.chat').pop();
    expect(String(chat.payload.text)).toContain('不是逐字稿');
  });
});

describe('与 QQ 插件的联动（共享托盘）', () => {
  // xunlu-core 的那套阶梯：时长决定起始画质，带宽预估再往回压。两条都是纯函数，所以
  // 边界值可以钉死，而不用真的去请求一次 playurl 才知道退到了哪一档。
  beforeEach(async () => {
    await loadApp();
  });

  test('画质只由预算决定：长视频也拿得到高画质', () => {
    const { pickVideoStream } = window.__bili;
    const videos = [
      { id: 80, url: 'a', bandwidth: 4_000_000, codecid: 7 },
      { id: 64, url: 'b', bandwidth: 2_000_000, codecid: 7 },
      { id: 32, url: 'c', bandwidth: 500_000, codecid: 7 },
    ];
    // 150 MB 的 1080p 放不下 80 MB 的预算 → 退到 720p（75 MB）
    expect(pickVideoStream(videos, 300, 80 * 1024 * 1024).stream.id).toBe(64);
    // 20 分钟的视频，只要 480p 装得下就选 480p —— 旧的「按时长定档」会给 360p
    // （1200 s × 500 kbps ≈ 75 MB）
    expect(pickVideoStream(videos, 1200, 80 * 1024 * 1024).stream.id).toBe(32);
    // 预算充足时直接拿最高的那一档，不管视频多长
    expect(pickVideoStream(videos, 1200, 1024 * 1024 * 1024).stream.id).toBe(80);
    // 连最低画质都放不下就返回 null（调用方改成发链接）
    expect(pickVideoStream(videos, 300, 1 * 1024 * 1024)).toBeNull();
    // 同一档里优先 avc1：`-c copy` 不重编码，AV1/HEVC 会让一部分手机放不出来。
    const sameQuality = [
      { id: 64, url: 'hevc', bandwidth: 1_500_000, codecid: 12 },
      { id: 64, url: 'avc', bandwidth: 2_000_000, codecid: 7 },
    ];
    expect(pickVideoStream(sameQuality, 60, 0).stream.url).toBe('avc');
  });

  test('预估体积与字段名归一化', () => {
    const { estimateStreamBytes, normaliseDashStream } = window.__bili;
    expect(estimateStreamBytes(4_000_000, 300)).toBe(150 * 1000 * 1000); // 150 MB
    expect(normaliseDashStream({ id: '64', base_url: 'x', backup_url: ['y'], bandwidth: '2000', codecid: '7' }))
      .toMatchObject({ id: 64, url: 'x', backups: ['y'], bandwidth: 2000, codecid: 7 });
  });

  test('画质名给群里看，不是给程序员看的', () => {
    const { qnLabel } = window.__bili;
    expect(qnLabel(80)).toBe('1080p');
    expect(qnLabel(64)).toBe('720p');
    expect(qnLabel(32)).toBe('480p');
    expect(qnLabel(120)).toBe('4K');
    expect(qnLabel(999)).toBe('qn 999');
  });

  function scriptLink() {
    fetchScript = [
      {
        name: 'view',
        match: (url) => url.includes('/x/web-interface/view?'),
        body: JSON.stringify({
          code: 0,
          data: {
            aid: 1, cid: 2, title: '一条被求链接的视频', desc: '', duration: 300,
            owner: { mid: 9, name: '某个 UP' }, stat: { view: 1 }, pages: [{ cid: 2 }],
          },
        }),
      },
      {
        name: 'nav',
        match: (url) => url.includes('/x/web-interface/nav'),
        body: JSON.stringify({
          code: 0,
          data: { isLogin: false, wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } },
        }),
      },
      {
        name: 'playurl',
        match: (url) => url.includes('/x/player/wbi/playurl'),
        body: JSON.stringify({
          code: 0,
          data: {
            dash: {
              video: [
                { id: 80, baseUrl: 'https://cdn.example/1080.m4s', bandwidth: 4_000_000 },
                { id: 64, baseUrl: 'https://cdn.example/720.m4s', bandwidth: 2_000_000 },
                { id: 32, baseUrl: 'https://cdn.example/480.m4s', bandwidth: 500_000 },
              ],
              audio: [{ id: 30280, baseUrl: 'https://cdn.example/audio.m4s', bandwidth: 128_000 }],
            },
          },
        }),
      },
    ];
  }

  async function runJob(job) {
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    window.__bili.state.minGapMs = 0;
    await pump();
    shareMap.set('com.shixiansi.plugin-qq/bili-jobs', JSON.stringify([job]));
    const done = window.__bili.pollShare();
    await pump(80);
    await done;
    return JSON.parse(shareMap.get('self/bili-results') || '[]');
  }

  test('共享值超上限时丢最旧的，而不是整条写失败', () => {
    // 真机上攒到 20 条时整条写入被宿主拒绝（64 KiB），于是**最新的答复也没送到** ——
    // 表现是「发了几条链接，只有前几条有反应」。
    const { trimShared } = window.__bili;
    const fat = (id) => ({ id, video: { url: 'https://cdn.example/' + 'x'.repeat(1500) } });
    const list = [fat('new'), ...Array.from({ length: 60 }, (_, i) => fat(`old${i}`))];
    const trimmed = trimShared(list, 20 * 1024);
    expect(trimmed.length).toBeLessThan(list.length);
    expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(20 * 1024);
    // 最新的那条必须还在：它是唯一有人在等的东西。
    expect(trimmed[0].id).toBe('new');
    // 单条超限也不至于写个空数组。
    expect(trimShared([fat('only')], 10).length).toBe(1);
    // 不是数组就原样返回。
    expect(trimShared({ a: 1 }, 10)).toEqual({ a: 1 });
  });

  test('答复里每个流只带一个备用地址（多了会把共享值撑爆）', async () => {
    scriptLink();
    const results = await runJob({ id: 'j7', url: 'BV1xx411c7mD', maxMB: 80, maxMinutes: 25 });
    expect(results[0].ok).toBe(true);
    // 备用地址是给 QQ 换节点重试用的（CDN 会抽风），但只留一个：三条会把 64 KiB 的
    // 共享值顶穿（T11 就是这么丢过结果）。
    expect((results[0].video.backups || []).length).toBeLessThanOrEqual(1);
    expect((results[0].audio.backups || []).length).toBeLessThanOrEqual(1);
    expect(JSON.stringify(results).length).toBeLessThan(20 * 1024);
  });

  test('取播放流时带上凭据（匿名只给到 480p 左右）', async () => {
    scriptLink();
    const results = await runJob({ id: 'j6', url: 'BV1xx411c7mD', maxMB: 80, maxMinutes: 25 });
    expect(results[0].ok).toBe(true);
    const playurl = requests().filter((req) => String((req.payload || {}).url || '').includes('/x/player/wbi/playurl'));
    expect(playurl).toHaveLength(1);
    // 传的是配置项**名字**，不是值：cookie 明文不进页面。
    expect(playurl[0].payload.credentials).toBe('biliCookie');
    expect(playurl[0].payload.body || '').not.toContain('SESSDATA');
  });

  test('把 QQ 的链接请求解析成「能下载的流」，并按上限降到 720p', async () => {
    scriptLink();
    const results = await runJob({ id: 'j1', url: 'https://www.bilibili.com/video/BV1xx411c7mD', maxMB: 80, maxMinutes: 25 });
    expect(results).toHaveLength(1);
    const answer = results[0];
    expect(answer.ok).toBe(true);
    expect(answer.bvid).toBe('BV1xx411c7mD');
    expect(answer.kind).toBe('dash');
    // 300 秒 → 起始 720p；1080p 预估 150 MB 放不下，退到 720p（75 MB）
    expect(answer.qn).toBe(64);
    expect(answer.video.url).toContain('720');
    expect(answer.audio.url).toContain('audio');
    expect(answer.sizeBytes).toBeGreaterThan(0);
  });

  test('时长超上限时不发视频，答复里说清原因', async () => {
    scriptLink();
    const results = await runJob({ id: 'j2', url: 'BV1xx411c7mD', maxMB: 80, maxMinutes: 3 });
    expect(results[0].ok).toBe(false);
    expect(results[0].reason).toContain('时长');
    expect(results[0].title).toBe('一条被求链接的视频');
  });

  test('认不出 BV 号时也回一条，而不是沉默', async () => {
    scriptLink();
    const results = await runJob({ id: 'j3', url: 'https://example.com/not-bilibili', maxMB: 80, maxMinutes: 25 });
    expect(results[0].ok).toBe(false);
    expect(results[0].reason).toContain('BV');
  });

  test('短链拿不到正文时，答复里带真正的原因', async () => {
    // 真机上这里曾经只说「没认出 BV 号」，而日志里是「未声明的域名：b23.tv」——
    // 白名单少一个域名被说成了「卡片格式不对」。现在原因原样往上传。
    scriptLink();
    const results = await runJob({ id: 'j5', url: 'https://b23.tv/HTPbBxO', maxMB: 80, maxMinutes: 25 });
    expect(results[0].ok).toBe(false);
    expect(results[0].reason).toContain('短链解析失败');
  });


  test('指向 UP 主主页的短链当作「不是视频」，不报错', async () => {
    // 真机：`b23.tv/jJKBcEG` → `space.bilibili.com/3747…`
    const { filterCandidates } = window.__bili;
    expect(typeof filterCandidates).toBe('function');
    scriptLink();
    // 短链页面里没有 BV 号 = 不是视频页
    fetchScript = [
      ...fetchScript.filter((entry) => entry.name !== 'view'),
      {
        name: 'short',
        match: (url) => url.includes('b23.tv/'),
        body: '<html><title>某个 UP 主的主页</title><div>签名</div></html>',
      },
    ];
    const results = await runJob({ id: 'j10', url: 'https://b23.tv/jJKBcEG', maxMB: 80, maxMinutes: 25 });
    expect(results[0].ok).toBe(false);
    expect(results[0].notVideo).toBe(true);
    expect(results[0].reason).toContain('不是视频');
  });

  test('超过 10 分钟的 job 不再处理（重启后不该把旧 job 重跑一遍）', async () => {
    scriptLink();
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    window.__bili.state.minGapMs = 0;
    await pump();
    const stale = Date.now() - 11 * 60 * 1000;
    shareMap.set('com.shixiansi.plugin-qq/bili-jobs', JSON.stringify([{ id: 'old1', url: 'BV1xx411c7mD', maxMB: 80, maxMinutes: 25, at: stale }]));
    const done = window.__bili.pollShare();
    await pump(40);
    await done;
    expect(requestsFor('net.fetch').filter((req) => String((req.payload || {}).url || '').includes('/x/web-interface/view'))).toHaveLength(0);
  });

  test('BV 不存在时标成 notVideo（别让噪声变成群里的「失败」）', async () => {
    scriptLink();
    // view 回 -400「请求错误」：BV 号根本不存在（多半是正则从卡片噪声里蒙出来的）
    fetchScript = fetchScript.map((entry) => (entry.name === 'view'
      ? { ...entry, body: JSON.stringify({ code: -400, message: '请求错误' }) }
      : entry));
    const results = await runJob({ id: 'j9', url: 'BVlkbstVNrVJ', maxMB: 80, maxMinutes: 25 });
    expect(results[0].ok).toBe(false);
    expect(results[0].notVideo).toBe(true);
  });

  test('同一个 job 只处理一次（轮询每 3 秒一次，不能重复请求）', async () => {
    scriptLink();
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    window.__bili.state.minGapMs = 0;
    await pump();
    shareMap.set('com.shixiansi.plugin-qq/bili-jobs', JSON.stringify([{ id: 'j4', url: 'BV1xx411c7mD', maxMB: 80, maxMinutes: 25 }]));
    const first = window.__bili.pollShare();
    await pump(80);
    await first;
    const afterFirst = requestsFor('net.fetch').length;
    const second = window.__bili.pollShare();
    await pump(40);
    await second;
    expect(requestsFor('net.fetch').length).toBe(afterFirst);
  });
});

describe('扫码登录（常驻帧执行）', () => {
  // B 站扫码成功后给的是一个 crossDomain 跳转地址，三个凭据都在查询串里（百分号编码）。
  // 真的扫码给出的却是「url 为空 + Set-Cookie」，两种都认（见下面两条成功用例）。
  const crossDomain = 'https://passport.biligame.com/crossDomain?DedeUserID=123456'
    + '&DedeUserID__ckMd5=abcdef0123456789&SESSDATA=abc%2Cdef%2C123&bili_jct=the-jct'
    + '&gourl=https%3A%2F%2Fwww.bilibili.com%2F';

  test('凭据从 crossDomain 地址里取出来，并且解码', () => {
    const { credentialFromCrossDomain } = window.__bili;
    const creds = credentialFromCrossDomain(crossDomain);
    expect(creds.hasSession).toBe(true);
    expect(creds.cookie).toBe('SESSDATA=abc,def,123; DedeUserID=123456; DedeUserID__ckMd5=abcdef0123456789');
    expect(creds.jct).toBe('the-jct');
    expect(credentialFromCrossDomain('').hasSession).toBe(false);
    expect(credentialFromCrossDomain('https://x/').hasSession).toBe(false);
  });

  function scriptQr(pollBodies, pollCookies) {
    fetchScript = [
      {
        name: 'generate',
        match: (url) => url.includes('qrcode/generate'),
        body: JSON.stringify({
          code: 0,
          data: {
            url: 'https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=KEY1&from=',
            qrcode_key: 'KEY1',
          },
        }),
      },
      {
        name: 'poll',
        match: (url) => url.includes('qrcode/poll'),
        body: () => pollBodies.shift() || JSON.stringify({ code: 0, data: { code: 86101 } }),
        cookies: pollCookies || [],
      },
      {
        name: 'nav',
        match: (url) => url.includes('/x/web-interface/nav'),
        body: JSON.stringify({ code: 0, data: { isLogin: true, mid: 123456, uname: '测试主人' } }),
      },
    ];
  }

  /** Runs the command and lets the poll loop breathe. */
  async function runQr(pollBodies, options) {
    const until = (options && options.until) || 'ok';
    scriptQr(pollBodies, options && options.cookies);
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    window.__bili.state.qrPollDelayMs = 0;
    window.__bili.state.minGapMs = 0;
    await pump();
    storageMap.set('cmd', JSON.stringify({ id: 'q1', kind: 'qr-start', at: Date.now() }));
    const done = window.__bili.pollCommand();
    await pump(60);
    await done;
    let report = {};
    for (let i = 0; i < 60; i += 1) {
      await pump(6);
      report = JSON.parse(storageMap.get('qrcode') || '{}');
      if (report.status === until) break;
    }
    return report;
  }

  test('生成 → 已扫码 → 成功，并把凭据写进加密存储', async () => {
    const report = await runQr([
      JSON.stringify({ code: 0, data: { code: 86101 } }),
      JSON.stringify({ code: 0, data: { code: 86090 } }),
      JSON.stringify({ code: 0, data: { code: 0, url: crossDomain } }),
    ]);
    expect(report.status).toBe('ok');
    expect(report.account.uname).toBe('测试主人');
    const saved = configSets.find((values) => values.biliCookie);
    expect(saved, 'nothing was saved').toBeTruthy();
    expect(saved.biliCookie).toContain('SESSDATA=abc,def,123');
    expect(saved.biliJct).toBe('the-jct');
  });

  test('成功时凭据走 Set-Cookie（当前的真实形状），不是 data.url', async () => {
    // 真机上扫一次就看到的事实：poll 返回 `data.code:0` 与空 url，会话在 Set-Cookie 里。
    const report = await runQr(
      [JSON.stringify({ code: 0, data: { code: 0, url: '', timestamp: 1 } })],
      {
        cookies: [
          'SESSDATA=abc%2Cdef%2C123',
          'bili_jct=the-jct',
          'DedeUserID=123456',
          'DedeUserID__ckMd5=abcdef0123456789',
          'buvid3=unrelated',
        ],
      },
    );
    expect(report.status).toBe('ok');
    const saved = configSets.find((values) => values.biliCookie);
    expect(saved, 'nothing was saved').toBeTruthy();
    expect(saved.biliCookie).toContain('SESSDATA=abc%2Cdef%2C123');
    expect(saved.biliCookie).toContain('DedeUserID=123456');
    expect(saved.biliCookie).not.toContain('buvid3');
    expect(saved.biliJct).toBe('the-jct');
  });

  test('两处都没有凭据时说清字段名，且不保存任何东西', async () => {
    const report = await runQr(
      [JSON.stringify({ code: 0, data: { code: 0, url: '', refresh_token: 'x' } })],
      { until: 'error' },
    );
    expect(report.status).toBe('error');
    expect(report.message).toContain('没有可用');
    expect(configSets.some((values) => values.biliCookie)).toBe(false);
    // 诊断信息只写字段名与有无，不写值。
    const log = JSON.parse(storageMap.get('log') || '[]');
    const line = log.find((entry) => String(entry.text).includes('没解析出凭据'));
    expect(line, 'no diagnostic line').toBeTruthy();
    expect(line.text).toContain('refresh_token');
    expect(line.text).not.toContain('SESSDATA');
  });

  test('中途会报告「已扫码待确认」，而不是一直说未扫码', async () => {
    const report = await runQr([JSON.stringify({ code: 0, data: { code: 86090 } })], { until: 'scanned' });
    expect(report.status).toBe('scanned');
    expect(report.url).toContain('scan-web');
    expect(configSets.some((values) => values.biliCookie)).toBe(false);
  });

  test('过期就停，不重试也不保存', async () => {
    const report = await runQr([JSON.stringify({ code: 0, data: { code: 86038 } })], { until: 'expired' });
    expect(report.status).toBe('expired');
    expect(configSets.some((values) => values.biliCookie)).toBe(false);
  });

  test('取消会停下轮询', async () => {
    scriptQr([JSON.stringify({ code: 0, data: { code: 86101 } })]);
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    window.__bili.state.qrPollDelayMs = 0;
    window.__bili.state.minGapMs = 0;
    await pump();
    storageMap.set('cmd', JSON.stringify({ id: 'q1', kind: 'qr-start', at: Date.now() }));
    const start = window.__bili.pollCommand();
    await pump(40);
    await start;
    storageMap.set('cmd', JSON.stringify({ id: 'q2', kind: 'qr-cancel', at: Date.now() }));
    const cancel = window.__bili.pollCommand();
    await pump(40);
    await cancel;
    const report = JSON.parse(storageMap.get('qrcode') || '{}');
    expect(report.status).toBe('cancelled');
  });
});
