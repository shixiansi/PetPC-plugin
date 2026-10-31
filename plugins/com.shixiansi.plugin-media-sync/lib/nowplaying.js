// lib/nowplaying.js —— 曲目数据的解析与 Tool 形状
//
// 判定全是纯函数：测试直接调，不经过 DOM 与桥。
//
// WHY "我正在听什么"是一个 plugin.call 的 Tool 而不是 share 快照：问题的回答者
// 是模型（用户在对话里问），模型经 plugin.call 问这里的 now_playing（websearch
// 的 search、memcore 的 chat 是同一条路——被调用方声明 serves，调用方点名问）。
// share 键 media-now 仍然发布，给不想发起调用的界面（工坊页）读。

'use strict';

// 扁平名（`[A-Za-z0-9_-]`）：写成 media/now 会被 share.set 拒绝，发布永远失败。
// 读的一方用 shareRead 的两段式 `com.shixiansi.plugin-media-sync/media-now`。
const SHARE_NOW = 'media-now';

/** 合法的播放状态（脚本侧写别的过来一律当 unknown）。 */
const PLAY_STATES = ['playing', 'paused', 'stopped', 'unknown'];

/**
 * 解析 outbox/media 的原始值。返回：
 *   null            没有数据（没开播放器 / 文件不存在 / 坏 JSON）
 *   {title:'',status:'stopped'} 曲目存在但没标题（"没在放歌"）
 *   {title,artist,album,status,at}
 *
 * maxAgeMs 之后的数据视为过期——"正在播放"是此刻的状态，一分钟前的答案会说谎。
 */
function parseTrack(raw, nowMs, maxAgeMs) {
  if (!raw) return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  if (data.error) return { error: String(data.error), at: Number(data.at) || 0 };
  const at = Number(data.at) || 0;
  if (!at) return null;
  if (typeof nowMs === 'number' && nowMs - at > (maxAgeMs || 30000)) return null;
  const status = PLAY_STATES.includes(data.status) ? data.status : 'unknown';
  return {
    title: String(data.title || ''),
    artist: String(data.artist || ''),
    album: String(data.album || ''),
    status,
    at,
  };
}

/**
 * 给模型的回答。 Track 是 Tool 的返回值：短、平面、直接可读。
 * 没在放（stopped / 无标题 / 无数据）返回 {playing:false, text}——text 是给模型的
 * 一句话，让它别编。
 */
function trackAnswer(track, nowMs) {
  if (!track) {
    return { playing: false, text: '现在没有检测到任何播放。' };
  }
  if (track.error) {
    return { playing: false, text: `拿不到播放状态：${track.error}` };
  }
  if (!track.title || track.status === 'stopped') {
    return { playing: false, text: '现在没有在放歌。' };
  }
  const parts = [`正在播放《${track.title}》`];
  if (track.artist) parts.push(`—— ${track.artist}`);
  if (track.album) parts.push(`（专辑：${track.album}）`);
  if (track.status === 'paused') parts.push('（已暂停）');
  return {
    playing: track.status === 'playing',
    title: track.title,
    artist: track.artist,
    album: track.album,
    status: track.status,
    text: parts.join(' '),
  };
}

/** 宠物头顶的徽标（≤16 字符）。空串 = 清除。 */
function badgeFor(track) {
  if (!track || !track.title || track.status === 'stopped') return '';
  const head = track.status === 'paused' ? '⏸ ' : '♪ ';
  const label = track.artist ? `${track.title} - ${track.artist}` : track.title;
  const full = head + label;
  return full.length > 16 ? full.slice(0, 16) : full;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SHARE_NOW, PLAY_STATES, parseTrack, trackAnswer, badgeFor };
}
