// lib/weather.js —— 天气数据的归一化与"要不要提醒"的判定
//
// 全是纯函数：测试直接调。两个数据源归一化成同一个形状：
//
//   Open-Meteo（默认，免 Key）：GET https://api.open-meteo.com/v1/forecast
//     ?latitude=..&longitude=..&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto
//   和风天气（可选，要 Key）：GET https://{host}/v7/weather/now?location=..
//
// weather_code（WMO）：0 晴 1-3 多云 45/48 雾 51-67 雨（含冻雨） 71-77 雪
// 80-82 阵雨 85-86 阵雪 95-99 雷暴。归一化后的 condition：
//
//   sunny / cloudy / fog / rain / snow / thunder
//
// 提醒规则（判断是纯函数，"要不要打扰用户"的策略集中在一处）：
//   rain / thunder → 「出门带伞」；snow → 「下雪路滑」；sunny 且 ≥32℃ → 「今天很晒」
//   同一城市同一事件 3 小时内不重复（nap 掉，免得每小时都念一遍）。

'use strict';

const WEATHER_API = 'api.open-meteo.com';
const QWEATHER_GEO = 'geoapi.qweather.com';
const QWEATHER_API = 'api.qweather.com';

/** WMO weather code → 内部 condition。未知码归 cloudy（最不出错的默认）。 */
function conditionOf(code) {
  const c = Number(code);
  if (!Number.isFinite(c)) return 'cloudy';
  if (c === 0) return 'sunny';
  if (c >= 1 && c <= 3) return 'cloudy';
  if (c === 45 || c === 48) return 'fog';
  if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return 'rain';
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snow';
  if (c >= 95 && c <= 99) return 'thunder';
  return 'cloudy';
}

/** 和风天气的图标文字（101 这类）粗分：只有"雨/雪/雷"是它特有信息，其余交给 code 路径。 */
function conditionFromQWeatherText(text) {
  const t = String(text || '');
  if (/雷/.test(t)) return 'thunder';
  if (/雨/.test(t)) return 'rain';
  if (/雪/.test(t)) return 'snow';
  if (/雾|霾/.test(t)) return 'fog';
  if (/晴/.test(t) && !/多云/.test(t)) return 'sunny';
  return 'cloudy';
}

/** condition → 给人看的一个字面。 */
const CONDITION_LABEL = {
  sunny: '晴',
  cloudy: '多云',
  fog: '雾',
  rain: '雨',
  snow: '雪',
  thunder: '雷雨',
};

/** condition → 徽标符号（宠物头顶，≤16 字符由调用方截）。 */
const CONDITION_GLYPH = {
  sunny: '☀',
  cloudy: '☁',
  fog: '≈',
  rain: '☂',
  snow: '❄',
  thunder: '⚡',
};

/**
 * 归一化一次 Open-Meteo 的响应。
 * 返回 {city, tempC, windKmh, condition, text, at}；解析不出来返回 null。
 */
function parseOpenMeteo(body, city, nowMs) {
  if (!body || typeof body !== 'object') return null;
  const cur = body.current;
  if (!cur || typeof cur !== 'object') return null;
  const tempC = Number(cur.temperature_2m);
  if (!Number.isFinite(tempC)) return null;
  const condition = conditionOf(cur.weather_code);
  return {
    city: String(city || ''),
    tempC: Math.round(tempC),
    windKmh: Number.isFinite(Number(cur.wind_speed_10m)) ? Math.round(Number(cur.wind_speed_10m)) : null,
    condition,
    at: Number(nowMs) || 0,
  };
}

/**
 * 归一化一次和风天气的 v7/weather/now 响应。
 * 成功形状：{code:'200', now:{temp, windSpeed, text}}；业务错误 code !== '200' → null。
 */
function parseQWeather(body, city, nowMs) {
  if (!body || typeof body !== 'object' || String(body.code) !== '200') return null;
  const now2 = body.now;
  if (!now2 || typeof now2 !== 'object') return null;
  const tempC = Number(now2.temp);
  if (!Number.isFinite(tempC)) return null;
  return {
    city: String(city || ''),
    tempC: Math.round(tempC),
    windKmh: Number.isFinite(Number(now2.windSpeed)) ? Math.round(Number(now2.windSpeed)) : null,
    condition: conditionFromQWeatherText(now2.text),
    at: Number(nowMs) || 0,
  };
}

/** 工具给模型的答案（get_weather 的返回值）：短、平面、直接可读。 */
function weatherAnswer(weather) {
  if (!weather) return { text: '查不到天气（城市名或网络问题）。' };
  const parts = [`${weather.city}：${CONDITION_LABEL[weather.condition] || weather.condition} ${weather.tempC}°C`];
  if (weather.windKmh !== null) parts.push(`风速 ${weather.windKmh} km/h`);
  const tip = adviceFor(weather);
  if (tip) parts.push(tip);
  return { city: weather.city, condition: weather.condition, tempC: weather.tempC, text: parts.join('，') + '。' };
}

/**
 * 该天气要不要给一句提醒（徽标/share 用）。
 * 返回 '' = 没什么要说的。
 */
function adviceFor(weather) {
  if (!weather) return '';
  switch (weather.condition) {
    case 'rain':
      return '出门带伞';
    case 'thunder':
      return '有雷雨，别在室外久留';
    case 'snow':
      return '下雪路滑';
    case 'sunny':
      return weather.tempC >= 32 ? '今天很晒，注意防晒' : '';
    default:
      return '';
  }
}

/** 徽标文案（≤16 字符）。空串 = 清除。 */
function badgeFor(weather) {
  if (!weather) return '';
  const glyph = CONDITION_GLYPH[weather.condition] || '';
  if (weather.condition === 'sunny' && weather.tempC < 32) return '';
  const tip = adviceFor(weather);
  if (!tip) return '';
  return `${glyph} ${tip}`.slice(0, 16);
}

/**
 * 提醒节流：同一城市同一事件 3 小时内只提醒一次。
 * state 形如 { city|condition: lastAt }；纯函数——旧的进新的出。
 */
const NAP_MS = 3 * 3600 * 1000;

function shouldNotify(state, weather, nowMs) {
  const key = `${weather.city}|${weather.condition}`;
  const last = Number(state && state[key]) || 0;
  const ok = nowMs - last > NAP_MS;
  // 只在真的提醒时才刷新时间戳：被节流的轮询不该把"下次可以提醒"往后推。
  const next = Object.assign({}, state, ok ? { [key]: nowMs } : {});
  return { ok, next };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    WEATHER_API, QWEATHER_GEO, QWEATHER_API,
    CONDITION_LABEL, CONDITION_GLYPH, NAP_MS,
    conditionOf, conditionFromQWeatherText, parseOpenMeteo, parseQWeather,
    weatherAnswer, adviceFor, badgeFor, shouldNotify,
  };
}
