// lib/apply.js —— 壁纸状态机与发布（环境合成的业务核心）
//
// 状态机（壁纸的"一生"）：
//
//   idle ──fetch──> downloading ──解码──> analyzing ──提色──> ready
//     │                  │                    │
//     └──error◄──────────┴────────────────────┘        （error 可重试回 idle）
//
// ready 的产物是一份"环境快照"：
//
//   { at, source: 'bing'|'local', title, url, palette: [{hex, share}], primaryHex,
//     gradient, mood }
//
// 快照经 share.set 发布（键 wallpaper/ambient），桌宠侧插件（或任何声明了 shareRead
// 的插件）按 at 判断新旧。mood 是从主色算出来的一个词（bright/calm/dark/warm/cool），
// 给桌宠的"视觉呼应"一个不用懂颜色的接口。

'use strict';

const AMBIENT_SHARE_KEY = 'ambient';
const STATE_KEY = 'state-v1';
const HISTORY_KEY = 'history-v1';
const HISTORY_MAX = 30;

/** 主色 → 情绪词。给桌宠的接口：它只需要认识这五个词。 */
function moodFromColor(hsl) {
  if (!hsl) return 'calm';
  if (hsl.l > 0.8) return 'bright';
  if (hsl.l < 0.2) return 'dark';
  if (hsl.s < 0.15) return 'calm';
  if (hsl.h >= 0 && hsl.h < 90) return 'warm';   // 红-黄
  if (hsl.h >= 90 && hsl.h < 250) return 'cool'; // 绿-蓝
  return 'warm'; // 紫-品红偏暖
}

function makeState(initial = {}) {
  return {
    phase: 'idle', // idle | downloading | analyzing | ready | error
    error: '',
    at: 0,
    source: '', // bing | local
    title: '',
    url: '',
    primaryHex: '',
    gradient: '',
    mood: '',
    palette: [],
    ...initial,
  };
}

/**
 * 归一化调色板 → 环境快照（ready 阶段的产物）。
 * 只挑"有信息"的颜色（近白近黑近灰的 neutral 色不上墙）。
 */
function makeAmbient({ source, title, url, palette, at }) {
  const informative = (palette || []).filter((c) => !c.neutral).slice(0, 5);
  const use = informative.length ? informative : (palette || []).slice(0, 2);
  const primary = (informative.length ? informative : palette || [])[0] || null;
  if (!primary) throw new Error('调色板是空的，无法生成环境快照');
  // 渐变至少要两个 stop（单 stop 的 linear-gradient 是无效 CSS，浏览器/jssom 都会丢弃）；
  // 只有一个候选色时首尾都用它。
  const stops = use.map((c, i) => `${c.hex} ${Math.round((i / Math.max(1, use.length - 1)) * 100)}%`);
  const gradient = `linear-gradient(135deg, ${use.length === 1 ? `${stops[0]}, ${stops[0]}` : stops.join(', ')})`;
  return {
    at: at || Date.now(),
    source: source || '',
    title: String(title || '').slice(0, 120),
    url: String(url || '').slice(0, 500),
    primaryHex: primary.hex,
    mood: moodFromColor(primary.hsl),
    gradient,
    palette: use.map((c) => ({ hex: c.hex, share: Math.round(c.share * 100) / 100 })),
  };
}

/**
 * 一次"环境合成"的状态迁移。纯函数：输入当前状态 + 各阶段的结果，输出新状态。
 * 编排层（app.js）负责真正的 IO，这里保证状态机不会被中间失败卡死。
 */
function transition(state, event) {
  const s = { ...state };
  switch (event.type) {
    case 'fetch-start':
      if (s.phase === 'downloading' || s.phase === 'analyzing') return s; // 忙时忽略
      return makeState({ phase: 'downloading', source: event.source || '' });
    case 'download-ok':
      if (s.phase !== 'downloading') return s;
      s.phase = 'analyzing';
      s.title = event.title || '';
      s.url = event.url || '';
      return s;
    case 'download-fail':
      if (s.phase !== 'downloading') return s;
      return makeState({ phase: 'error', error: String(event.error || '下载失败'), source: s.source });
    case 'analyze-ok':
      if (s.phase !== 'analyzing' && s.phase !== 'downloading') return s;
      return makeState({
        phase: 'ready',
        at: event.ambient.at,
        source: event.ambient.source || s.source,
        title: event.ambient.title,
        url: event.ambient. url || s.url,
        primaryHex: event.ambient.primaryHex,
        gradient: event.ambient.gradient,
        mood: event.ambient.mood,
        palette: event.ambient.palette,
      });
    case 'analyze-fail':
      if (s.phase !== 'analyzing') return s;
      return makeState({ phase: 'error', error: String(event.error || '解析失败'), source: s.source });
    case 'reset':
      return makeState();
    default:
      return s;
  }
}

/** 历史追加：新的在前、去重（同 URL 同日只留一条）、超量裁掉。 */
function pushHistory(history, ambient, max = HISTORY_MAX) {
  const day = new Date(ambient.at || Date.now()).toISOString().slice(0, 10);
  const key = `${ambient.source}|${ambient.url}|${day}`;
  const next = [ambient, ...history.filter((h) => `${h.source}|${h.url}|${new Date(h.at).toISOString().slice(0, 10)}` !== key)];
  return next.slice(0, max);
}

const WallpaperApply = {
  AMBIENT_SHARE_KEY, STATE_KEY, HISTORY_KEY, HISTORY_MAX,
  makeState, makeAmbient, transition, moodFromColor, pushHistory,
};
