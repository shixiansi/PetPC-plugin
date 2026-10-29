import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 媒体同步插件的行为测试。harness 与 pet-sense 同型。
//
//   1. 判定纯函数：解析/过期/Tool 答案形状/徽标截断；
//   2. 轮询：share.set media/now、徽标随曲目变化、暂停/恢复不重挂同一徽标；
//   3. plugin.call now_playing 有问必答；不认识的方法给一句中文错误；
//   4. manifest：serves 与代码逐字一致、assets 齐全、不申请多余权限；
//   5. 辅助脚本：SMTC 会话选择（优先 Playing）、四状态、原子写。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-media-sync');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));
const PLUGIN_ID = 'com.shixiansi.plugin-media-sync';

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((m) => m[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');
const source = scriptSources
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

// --- 判定纯函数 -----------------------------------------------------------------

const nowplayingSrc = readFileSync(path.join(pluginDir, 'lib', 'nowplaying.js'), 'utf8');
const sandbox = { exports: {} };
new Function('window', 'module', nowplayingSrc)({}, sandbox);
const NP = sandbox.exports;

describe('manifest', () => {
  test('background 由 process 门控，serves 只有 now_playing', () => {
    expect(manifest.background).toBe(true);
    expect(manifest.permissions).toContain('process');
    expect(manifest.permissions).toContain('plugin.call');
    expect(manifest.serves).toEqual(['now_playing']);
    expect(manifest.surface).toBeUndefined();
  });

  test('assets 里有辅助脚本与 nowplaying', () => {
    expect(manifest.assets).toContain('media-helper.ps1');
    expect(manifest.assets).toContain('lib/nowplaying.js');
    for (const asset of manifest.assets) {
      expect(existsSync(path.join(pluginDir, asset)), `缺 ${asset}`).toBe(true);
    }
  });

  test('不申请多余权限', () => {
    for (const p of ['net.fetch', 'net.ws', 'events', 'audio', 'llm.chat', 'llm.borrow']) {
      expect(manifest.permissions).not.toContain(p);
    }
  });
});

describe('辅助脚本 media-helper.ps1', () => {
  const ps1 = readFileSync(path.join(pluginDir, 'media-helper.ps1'), 'utf8');

  test('走 WinRT 的 SMTC 会话管理器', () => {
    expect(ps1).toContain('GlobalSystemMediaTransportControlsSessionManager');
    expect(ps1).toContain('RequestAsync');
  });

  test('优先选正在播放的会话，否则取第一个', () => {
    expect(ps1).toMatch(/Playing\)\s*\{\s*\$session\s*=\s*\$s;\s*break/);
    expect(ps1).toContain('$sessions[0]');
  });

  test('四种播放状态映射齐全（其余 unknown）', () => {
    expect(ps1).toContain('Playing');
    expect(ps1).toContain('Paused');
    expect(ps1).toContain('Stopped');
    expect(ps1).toContain("'unknown'");
  });

  test('没有会话不写文件（"没在放"由缺文件表达），原子写', () => {
    expect(ps1).toContain('没有 session：不写文件');
    expect(ps1).toContain('.tmp');
    expect(ps1).toContain('Move-Item');
  });
});

describe('lib/nowplaying.js 判定（纯函数）', () => {
  test('parseTrack：无数据/坏 JSON/过期 → null', () => {
    expect(NP.parseTrack('', Date.now())).toBeNull();
    expect(NP.parseTrack('nope', Date.now())).toBeNull();
    const stale = JSON.stringify({ title: 'x', status: 'playing', at: Date.now() - 60000 });
    expect(NP.parseTrack(stale, Date.now(), 30000)).toBeNull();
  });

  test('parseTrack：未知状态归 unknown，脚本错误透传为 {error}', () => {
    const bad = NP.parseTrack(JSON.stringify({ title: 'x', status: 'rewinding', at: Date.now() }), Date.now());
    expect(bad.status).toBe('unknown');
    const err = NP.parseTrack(JSON.stringify({ error: 'WinRT 不可用', at: 5 }), Date.now(), 1e9);
    expect(err.error).toContain('WinRT');
  });

  test('trackAnswer：四种答案形状，给模型的话不撒谎', () => {
    expect(NP.trackAnswer(null).playing).toBe(false);
    expect(NP.trackAnswer(null).text).toContain('没有检测到');
    expect(NP.trackAnswer({ error: 'x' }, Date.now()).playing).toBe(false);
    expect(NP.trackAnswer({ title: '', status: 'playing', at: 1 }, Date.now()).playing).toBe(false);
    expect(NP.trackAnswer({ title: 'x', status: 'stopped', at: 1 }, Date.now()).playing).toBe(false);

    const on = NP.trackAnswer({ title: '晴天', artist: '周杰伦', album: '叶惠美', status: 'playing', at: 1 }, Date.now());
    expect(on.playing).toBe(true);
    expect(on.text).toContain('《晴天》');
    expect(on.text).toContain('周杰伦');

    const paused = NP.trackAnswer({ title: '晴天', artist: '', status: 'paused', at: 1 }, Date.now());
    expect(paused.playing).toBe(false);
    expect(paused.text).toContain('已暂停');
  });

  test('badgeFor：徽标 ≤16 字符，暂停有 ⏸，没在放为空', () => {
    const b1 = NP.badgeFor({ title: '晴天', artist: '周杰伦', status: 'playing' });
    expect(b1.startsWith('♪ ')).toBe(true);
    expect(b1.length).toBeLessThanOrEqual(16);
    expect(NP.badgeFor({ title: '晴天', artist: '周杰伦', status: 'paused' }).startsWith('⏸ ')).toBe(true);
    expect(NP.badgeFor({ title: '', status: 'playing' })).toBe('');
    expect(NP.badgeFor(null)).toBe('');
  });
});

describe('app.js 行为（jsdom）', () => {
  let window;
  let outbound;
  let shares;
  let badges;
  let storage;

  beforeEach(() => vi.resetModules());

  afterEach(() => {
    try { window.__media?.stopPoll?.(); } catch { /* 已关闭 */ }
    window?.close?.();
  });

  function boot({ grantedNames = [], configValues = {}, surface = { kind: 'panel', slot: 'background' } } = {}) {
    const dom = new JSDOM(html, { url: 'https://plugin.local/panel.html' });
    window = dom.window;
    outbound = [];
    shares = [];
    badges = [];
    storage = new Map();

    const responses = {
      'config.get': () => ({ values: configValues || {} }),
      'storage.get': ({ key }) => ({ value: storage.get(key) || '' }),
      'storage.set': ({ key, value }) => { storage.set(key, value); return { ok: true }; },
      'storage.dir': () => ({ dir: 'C:\\fake\\dir' }),
      'share.set': ({ name, value }) => { shares.push({ name, value }); return { ok: true }; },
      'pet.badge': ({ text }) => { badges.push(text); return { text }; },
      'process.launch': () => ({ pid: 4242 }),
    };

    window.parent.postMessage = (msg) => {
      outbound.push(msg);
      if (msg.type !== 'request') return;
      const handler = responses[msg.method];
      const ok = Boolean(handler);
      const result = handler ? handler(msg.payload || {}) : null;
      Promise.resolve().then(() => {
        window.dispatchEvent(new window.MessageEvent('message', {
          source: window.parent,
          data: { v: 1, type: 'response', id: msg.id, ok, result },
        }));
      });
    };

    new Function('window', 'document', source)(window, window.document);

    Promise.resolve().then(() => {
      window.dispatchEvent(new window.MessageEvent('message', {
        source: window.parent,
        data: { v: 1, type: 'init', pluginId: PLUGIN_ID, permissions: manifest.permissions,
                granted: grantedNames, surface, theme: 'dark' },
      }));
    });
    return dom;
  }

  async function until(pred, ms = 2000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pred()) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return pred();
  }

  function playTrack(title, artist, status = 'playing') {
    storage.set('outbox/media.json', JSON.stringify({ title, artist, album: '', status, at: Date.now() }));
  }

  test('握手只发一次 ready', () => {
    boot({ grantedNames: [] });
    expect(outbound.filter((m) => m.type === 'ready')).toHaveLength(1);
  });

  test('轮询：播放中 → share media/now + 徽标；没数据 → 什么都不发', async () => {
    boot({ grantedNames: ['plugin.share', 'pet.surface', 'storage', 'plugin.config'] });
    expect(await until(() => badges.length > 0)).toBe(false); // 先确认没乱发

    playTrack('晴天', '周杰伦');
    expect(await until(() => shares.length > 0)).toBe(true);
    const nowShare = shares.find((s) => s.name === 'media/now');
    expect(JSON.parse(nowShare.value).title).toBe('晴天');
    expect(badges.some((b) => b.startsWith('♪ ') && b.includes('晴天'))).toBe(true);
    expect(await until(() => storage.has('recent'))).toBe(true);
    expect(JSON.parse(storage.get('recent'))[0].title).toBe('晴天');
  });

  test('同一曲目连播：徽标不重挂；切歌：徽标换成新的', async () => {
    boot({ grantedNames: ['plugin.share', 'pet.surface', 'storage', 'plugin.config'] });
    playTrack('晴天', '周杰伦');
    expect(await until(() => badges.length > 0)).toBe(true);
    const afterFirst = badges.length;
    await new Promise((r) => setTimeout(r, 1400)); // 轮询再跑几轮
    expect(badges.length).toBe(afterFirst);        // 没有重复挂

    playTrack('七里香', '周杰伦');
    expect(await until(() => badges.some((b) => b.includes('七里香')))).toBe(true);
  });

  test('暂停恢复不刷"最近"列表', async () => {
    boot({ grantedNames: ['plugin.share', 'pet.surface', 'storage', 'plugin.config'] });
    playTrack('晴天', '周杰伦', 'playing');
    expect(await until(() => storage.has('recent'))).toBe(true);
    const entries = JSON.parse(storage.get('recent')).length;
    playTrack('晴天', '周杰伦', 'paused');
    await new Promise((r) => setTimeout(r, 1400));
    playTrack('晴天', '周杰伦', 'playing');
    await new Promise((r) => setTimeout(r, 1400));
    expect(JSON.parse(storage.get('recent')).length).toBe(entries); // 没有新增
  });

  test('showBadge=false：不挂徽标，share 照发', async () => {
    boot({ grantedNames: ['plugin.share', 'pet.surface', 'storage', 'plugin.config'], configValues: { showBadge: 'false' } });
    playTrack('晴天', '周杰伦');
    expect(await until(() => shares.length > 0)).toBe(true);
    expect(badges).toEqual([]);
  });

  test('plugin.call now_playing：正在放 / 没在放 / 不认识的方法', async () => {
    boot({ grantedNames: ['plugin.call', 'storage'] });
    playTrack('七里香', '周杰伦');
    await until(() => shares.length > 0);

    const ask = async (method, payload = {}) => {
      const ticket = `t-${Math.random().toString(36).slice(2)}`;
      window.dispatchEvent(new window.MessageEvent('message', {
        source: window.parent,
        data: { v: 1, type: 'call', ticket, from: 'com.other', method, payload },
      }));
      await until(() => outbound.some((m) => m.type === 'call-result' && m.ticket === ticket));
      return outbound.find((m) => m.type === 'call-result' && m.ticket === ticket);
    };

    const on = await ask('now_playing');
    expect(on.ok).toBe(true);
    expect(on.result.playing).toBe(true);
    expect(on.result.title).toBe('七里香');
    expect(on.result.text).toContain('《七里香》');

    // 停止播放：数据过期（at 是旧的）→ playing:false
    storage.set('outbox/media.json', JSON.stringify({ title: '七里香', artist: '', status: 'playing', at: Date.now() - 120000 }));
    const off = await ask('now_playing');
    expect(off.ok).toBe(true);
    expect(off.result.playing).toBe(false);

    const bad = await ask('volume_up');
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('volume_up');
  });
});
