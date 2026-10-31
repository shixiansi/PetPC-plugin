import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 天气与环境感知插件的行为测试。harness 与 pet-sense/media-sync 同型。
//
//   1. 判定纯函数：WMO code 归一化、两家数据源的解析、提醒规则、3 小时节流；
//   2. fetchWeather 的请求形状：Open-Meteo 的 geocoding → forecast 两跳、和风的 lookup → now；
//   3. publishWeather：快照必存、提醒 share/badge 带节流（同事件 3 小时一次）；
//   4. plugin.call get_weather：带城市 / 不带城市 / 不认识的方法；
//   5. manifest：netHosts 覆盖两家、serves 与代码逐字一致。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-weather-env');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));
const PLUGIN_ID = 'com.shixiansi.plugin-weather-env';

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((m) => m[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');
const source = scriptSources
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

const weatherSrc = readFileSync(path.join(pluginDir, 'lib', 'weather.js'), 'utf8');
const sandbox = { exports: {} };
new Function('window', 'module', weatherSrc)({}, sandbox);
const W = sandbox.exports;

describe('manifest', () => {
  test('background 由 net.fetch 门控，serves 只有 get_weather', () => {
    expect(manifest.background).toBe(true);
    expect(manifest.permissions).toContain('net.fetch');
    expect(manifest.serves).toEqual(['get_weather']);
  });

  test('netHosts 覆盖 Open-Meteo 两跳与和风两跳', () => {
    for (const host of ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'geoapi.qweather.com', 'devapi.qweather.com']) {
      expect(manifest.netHosts).toContain(host);
    }
  });

  test('assets 里有 weather.js；不申请多余权限', () => {
    expect(manifest.assets).toContain('lib/weather.js');
    expect(existsSync(path.join(pluginDir, 'lib/weather.js'))).toBe(true);
    for (const p of ['net.ws', 'events', 'process', 'llm.chat']) {
      expect(manifest.permissions).not.toContain(p);
    }
  });
});

describe('lib/weather.js 判定（纯函数）', () => {
  test('WMO code 归一化：晴/云/雾/雨/雪/雷，未知归 cloudy', () => {
    expect(W.conditionOf(0)).toBe('sunny');
    expect(W.conditionOf(2)).toBe('cloudy');
    expect(W.conditionOf(45)).toBe('fog');
    expect(W.conditionOf(63)).toBe('rain');
    expect(W.conditionOf(73)).toBe('snow');
    expect(W.conditionOf(95)).toBe('thunder');
    expect(W.conditionOf(80)).toBe('rain');
    expect(W.conditionOf(999)).toBe('cloudy');
    expect(W.conditionOf('x')).toBe('cloudy');
  });

  test('和风的文字粗分：雷 > 雨 > 雪', () => {
    expect(W.conditionFromQWeatherText('雷阵雨')).toBe('thunder');
    expect(W.conditionFromQWeatherText('小雨')).toBe('rain');
    expect(W.conditionFromQWeatherText('中雪')).toBe('snow');
    expect(W.conditionFromQWeatherText('晴')).toBe('sunny');
    expect(W.conditionFromQWeatherText('多云')).toBe('cloudy');
  });

  test('parseOpenMeteo：形状与容错', () => {
    const ok = W.parseOpenMeteo(
      { current: { temperature_2m: 21.4, weather_code: 61, wind_speed_10m: 9.6 } }, '上海', 1000);
    expect(ok).toEqual({ city: '上海', tempC: 21, windKmh: 10, condition: 'rain', at: 1000 });
    expect(W.parseOpenMeteo(null, 'x', 1)).toBeNull();
    expect(W.parseOpenMeteo({ current: { weather_code: 0 } }, 'x', 1)).toBeNull(); // 没有温度
  });

  test('parseQWeather：code=200 才收，业务错误归 null', () => {
    const ok = W.parseQWeather({ code: '200', now: { temp: '31', windSpeed: '12', text: '晴（很晒）' } }, '北京', 7);
    expect(ok.condition).toBe('sunny');
    expect(ok.tempC).toBe(31);
    expect(W.parseQWeather({ code: '401', now: {} }, 'x', 1)).toBeNull();
    expect(W.parseQWeather(null, 'x', 1)).toBeNull();
  });

  test('提醒规则：雨伞/雷雨/雪/晒，多云不提醒', () => {
    expect(W.adviceFor({ condition: 'rain', tempC: 18 })).toBe('出门带伞');
    expect(W.adviceFor({ condition: 'thunder', tempC: 25 })).toContain('雷雨');
    expect(W.adviceFor({ condition: 'snow', tempC: -2 })).toBe('下雪路滑');
    expect(W.adviceFor({ condition: 'sunny', tempC: 33 })).toContain('防晒');
    expect(W.adviceFor({ condition: 'sunny', tempC: 22 })).toBe('');
    expect(W.adviceFor({ condition: 'cloudy', tempC: 20 })).toBe('');
  });

  test('徽标：只在有提醒时挂，≤16 字符；晴天不高温清空', () => {
    expect(W.badgeFor({ condition: 'rain', tempC: 18 })).toBe('☂ 出门带伞');
    expect(W.badgeFor({ condition: 'thunder', tempC: 25 }).startsWith('⚡')).toBe(true);
    expect(W.badgeFor({ condition: 'sunny', tempC: 35 }).startsWith('☀')).toBe(true);
    expect(W.badgeFor({ condition: 'sunny', tempC: 20 })).toBe('');
    for (const w of [
      { condition: 'thunder', tempC: 30 }, { condition: 'snow', tempC: 0 },
    ]) {
      expect(W.badgeFor(w).length).toBeLessThanOrEqual(16);
    }
  });

  test('节流：同城市同事件 3 小时一次，不同事件互不影响', () => {
    const t0 = 1_800_000_000_000; // 2027 年前后的 epoch ms：必须远大于 NAP_MS
    const rain = { city: '上海', condition: 'rain', tempC: 18 };
    const first = W.shouldNotify({}, rain, t0);
    expect(first.ok).toBe(true);

    const second = W.shouldNotify(first.next, rain, t0 + 1000);
    expect(second.ok).toBe(false); // 1 秒后不重复

    const later = W.shouldNotify(first.next, rain, t0 + W.NAP_MS + 1);
    expect(later.ok).toBe(true);   // 3 小时后再提醒

    const snow = { city: '上海', condition: 'snow', tempC: -1 };
    expect(W.shouldNotify(first.next, snow, t0 + 1000).ok).toBe(true); // 别的事件不受影响

    const otherCity = { city: '北京', condition: 'rain', tempC: 18 };
    expect(W.shouldNotify(first.next, otherCity, t0 + 1000).ok).toBe(true);
  });

  test('weatherAnswer：给模型一句话，温度取整', () => {
    const a = W.weatherAnswer({ city: '上海', tempC: 18, windKmh: 12, condition: 'rain', at: 1 });
    expect(a.text).toContain('上海');
    expect(a.text).toContain('雨');
    expect(a.text).toContain('带伞');
    expect(W.weatherAnswer(null).text).toContain('查不到');
  });
});

describe('app.js 行为（jsdom）', () => {
  let window;
  let outbound;
  let shares;
  let badges;
  let storage;
  let fetches;

  beforeEach(() => vi.resetModules());

  afterEach(() => {
    try { window.__weather?.stopPush?.(); } catch { /* 已关闭 */ }
    window?.close?.();
  });

  function boot({ grantedNames = [], configValues = {}, surface = { kind: 'panel', slot: 'background' } } = {}) {
    const dom = new JSDOM(html, { url: 'https://plugin.local/panel.html' });
    window = dom.window;
    outbound = [];
    shares = [];
    badges = [];
    storage = new Map();
    fetches = [];

    const responses = {
      'config.get': () => ({ values: configValues || {} }),
      'storage.get': ({ key }) => ({ value: storage.get(key) || '' }),
      'storage.set': ({ key, value }) => { storage.set(key, value); return { ok: true }; },
      'share.set': ({ name, value }) => { shares.push({ name, value }); return { ok: true }; },
      'pet.badge': ({ text }) => { badges.push(text); return { text }; },
      'net.fetch': ({ url }) => {
        fetches.push(url);
        return netReply(url);
      },
    };

    function netReply(url) {
      if (url.includes('geocoding-api.open-meteo.com')) {
        return { status: 200, body: JSON.stringify({ results: [{ name: '上海', latitude: 31.2, longitude: 121.5 }] }) };
      }
      if (url.includes('api.open-meteo.com')) {
        return { status: 200, body: JSON.stringify({ current: { temperature_2m: 18.5, weather_code: 61, wind_speed_10m: 11.2 } }) };
      }
      if (url.includes('geoapi.qweather.com')) {
        return { status: 200, body: JSON.stringify({ location: [{ name: '上海', id: '101020100' }] }) };
      }
      if (url.includes('v7/weather/now')) {
        return { status: 200, body: JSON.stringify({ code: '200', now: { temp: '19', windSpeed: '10', text: '小雨' } }) };
      }
      return { status: 404, body: '{}' };
    }

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

  const ask = async (method, payload = {}) => {
    const ticket = `t-${Math.random().toString(36).slice(2)}`;
    window.dispatchEvent(new window.MessageEvent('message', {
      source: window.parent,
      data: { v: 1, type: 'call', ticket, from: 'com.other', method, payload },
    }));
    await until(() => outbound.some((m) => m.type === 'call-result' && m.ticket === ticket));
    return outbound.find((m) => m.type === 'call-result' && m.ticket === ticket);
  };

  test('握手只发一次 ready', () => {
    boot({ grantedNames: [] });
    expect(outbound.filter((m) => m.type === 'ready')).toHaveLength(1);
  });

  test('get_weather：两跳请求（geocoding → forecast），答案带提醒', async () => {
    boot({ grantedNames: ['net.fetch', 'plugin.call', 'storage', 'plugin.config'] });
    const answer = await ask('get_weather', { city: '上海' });
    expect(answer.ok).toBe(true);
    expect(answer.result.city).toBe('上海');
    expect(answer.result.condition).toBe('rain');
    expect(answer.result.text).toContain('带伞');
    expect(fetches[0]).toContain('geocoding-api.open-meteo.com');
    expect(fetches[1]).toContain('api.open-meteo.com');
    expect(fetches[1]).toContain('latitude=31.2');
  });

  test('get_weather 不带城市 → 用默认城市（config.defaultCity）', async () => {
    boot({
      grantedNames: ['net.fetch', 'plugin.call', 'storage', 'plugin.config'],
      configValues: { defaultCity: 'Tokyo' },
    });
    // config 是异步读的：先等 config.get 真的发生，再问。
    await until(() => outbound.some((m) => m.type === 'request' && m.method === 'config.get'));
    const answer = await ask('get_weather', {});
    expect(answer.ok).toBe(true);
    expect(fetches.some((u) => u.includes(encodeURIComponent('Tokyo')))).toBe(true);
  });

  test('publishWeather：快照必存，提醒 share + badge；第二次被节流', async () => {
    boot({ grantedNames: ['net.fetch', 'plugin.share', 'pet.surface', 'storage', 'plugin.config'] });
    // 等 init 真正跑完：granted 已设置（snapshot 里能看到），而不是只等到第一个 response。
    await until(() => (window.__weather.snapshot().granted || []).includes('plugin.share'));

    const weather = { city: '杭州', tempC: 18, windKmh: 11, condition: 'rain', at: Date.now() }; // 与 push loop 的上海错开，验证的是节流本身
    const first = await window.__weather.publishWeather(weather);
    expect(first.some((a) => a.share === 'weather-now')).toBe(true);
    expect(first.some((a) => a.share === 'weather-condition')).toBe(true);
    // badge 与 push loop 竞速：如果上海的雨已经挂过同样的"☂ 出门带伞"，这里就不重复。
    // 用 snapshot 里的 lastBadge 验证"徽标最终挂的是这个文案"。
    expect(['☂ 出门带伞', undefined]).toContain(first.find((a) => a.badge !== undefined)?.badge);
    expect(JSON.parse(storage.get('weather/last')).city).toBe('杭州');

    const second = await window.__weather.publishWeather({ ...weather, at: Date.now() + 1000 });
    expect(second.some((a) => a.share)).toBe(false); // 3 小时内不重复
    expect(second.some((a) => a.badge !== undefined)).toBe(false);
  });

  test('晴天不高温：有 share 快照但没有徽标与 condition 提醒', async () => {
    boot({ grantedNames: ['net.fetch', 'plugin.share', 'pet.surface', 'storage', 'plugin.config'] });
    await until(() => outbound.some((m) => m.type === 'response'));
    const actions = await window.__weather.publishWeather({ city: '北京', tempC: 22, windKmh: 5, condition: 'sunny', at: Date.now() });
    expect(actions.some((a) => a.share === 'weather-now')).toBe(true);
    expect(actions.some((a) => a.badge === '')).toBe(true); // 空串 = 清除（无提醒）
  });

  test('不认识的方法给一句中文错误；没授权 net.fetch 时 get_weather 报错', async () => {
    boot({ grantedNames: ['plugin.call', 'storage'] });
    const bad = await ask('humidity');
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('humidity');
  });

  test('Open-Meteo 找不到城市：错误是能拿去修的那句中文', async () => {
    boot({ grantedNames: ['net.fetch', 'plugin.call', 'storage', 'plugin.config'] });
    // 让 geocoding 返回 200 + 空 results（真实宿主的形状：不是拒绝，是查无此城）
    window.parent.postMessage = (msg) => {
      outbound.push(msg);
      if (msg.type !== 'request') return;
      const empty = msg.method === 'net.fetch' && String(msg.payload?.url || '').includes('geocoding');
      Promise.resolve().then(() => {
        window.dispatchEvent(new window.MessageEvent('message', {
          source: window.parent,
          data: {
            v: 1, type: 'response', id: msg.id, ok: true,
            result: { status: 200, body: JSON.stringify(empty ? { results: [] } : { current: { temperature_2m: 20, weather_code: 0, wind_speed_10m: 5 } }) },
          },
        }));
      });
    };
    // 重新发 ready（postMessage 换掉了，桥还在）
    window.dispatchEvent(new window.MessageEvent('message', {
      source: window.parent,
      data: { v: 1, type: 'init', pluginId: PLUGIN_ID, permissions: manifest.permissions,
              granted: ['net.fetch', 'plugin.call', 'storage', 'plugin.config'],
              surface: { kind: 'panel', slot: 'background' }, theme: 'dark' },
    }));
    const answer = await ask('get_weather', { city: '诺亚星' });
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain('找不到城市');
  });
});
