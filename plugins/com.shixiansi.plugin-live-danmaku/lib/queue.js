// lib/queue.js —— 弹幕缓冲队列：防抖、节流、打分
//
// 弹幕流的形状是"一秒几十条、绝大多数不值得回"。把它原样塞给模型，一小时就能烧掉
// 一天的额度；直接丢，又会让"终于有人问了个好问题"淹没在"666"里。所以这条队列要
// 同时做四件事，每一件都可独立验证：
//
//   1. 定容：超过 queueCap 丢最旧的（内存有上界，1000 条瞬间灌进来也不涨）；
//   2. 过滤：屏蔽词、长度区间、纯符号/纯数字这类"不值得念出来"的内容直接不进队；
//   3. 去重：同一窗口内「同一人 + 同一内容」的重复弹幕只记一次（计数+1，不再入队）；
//   4. 打分：抽取时按 分数×新鲜度 挑，命中关键词、带问号的排前面。
//
// WHY 抽取是"挑一批"而不是"消费队列"
//
// 节流的正确形状不是"每 5 秒读走全部"（那还是全要回），也不是"每 5 秒读一条"（高频时
// 那一条多半是垃圾）。是：到点了以后，从当前窗口里**按分挑出最多 N 条**，没被挑中的
// 让它们自然过期——窗口之外的内容对"现在"已经没有互动价值。

'use strict';

/** 一条弹幕在队列里的形状。 */
// {
//   uid: '20001',            // 平台侧的用户标识（原样保存，只用于去重）
//   name: '小明',            // 显示名
//   text: '这首歌叫什么',    // 清洗过的正文
//   at: 1700000000000,       // 到达时刻（epoch ms）
//   score: 42,               // 静态分：关键词/问号/长度合适量化后的值
//   count: 1,                // 去重命中的次数（同一内容被刷了几遍）
// }

const DanmakuQueue = {
  /** 创建一个队列。cap/intervalSec 等参数由调用方在每次抽取时给，这里只存形状。 */
  create(cap) {
    return { items: [], cap: clampInt(cap, 10, 5000, 500), stats: emptyStats() };
  },

  emptyStats,

  /** 队列里现在有多少条。 */
  size(q) {
    return q.items.length;
  },

  /**
   * 入队一条。返回 'accepted' | 'filtered' | 'dropped' | 'duplicate'。
   *
   * 参数全部由调用方给（队列自己不读 config）：让测试可以用与真机不同的参数驱动，
   * 也让"策略"与"容器"保持分离。
   */
  push(q, item, rules) {
    const entry = normalise(item);
    if (!entry) {
      q.stats.dropped += 1;
      return 'dropped';
    }
    if (!passesRules(entry, rules)) {
      q.stats.filtered += 1;
      return 'filtered';
    }
    // 去重：窗口内同一「人 + 内容」再出现，把已有那条的 count +1 并刷新时间，
    // 不再占一个新的位置。
    const windowMs = (Number(rules.dedupeWindowSec) > 0 ? Number(rules.dedupeWindowSec) : 120) * 1000;
    for (let i = q.items.length - 1; i >= 0; i -= 1) {
      const seen = q.items[i];
      // 去重窗口按「同内容最近一次出现」算：命中会刷新 seen.at，所以刷屏弹幕在
      // 最后一次出现之后的窗口内都算重复；安静超过窗口才算新的。同一个人可能
      // 反复发同一句话而中间隔着别人的弹幕，所以要扫过整条队列找到最近的同内容。
      if (seen.uid === entry.uid && seen.text === entry.text) {
        if (entry.at - seen.at <= windowMs) {
          seen.count += 1;
          seen.at = entry.at;
          q.stats.duplicates += 1;
          return 'duplicate';
        }
        break; // 同内容的最近一次已经出了窗口。
      }
    }
    q.items.push(entry);
    q.stats.accepted += 1;
    // 定容：超出上限丢最旧的。shift 是 O(n)，但 cap ≤5000 且入队节奏受节流保护，
    // 比引入环形缓冲的复杂度更值。
    while (q.items.length > q.cap) {
      q.items.shift();
      q.stats.dropped += 1;
    }
    return 'accepted';
  },

  /**
   * 抽取：到点了，从队列里挑最多 limit 条"现在值得回的"。
   *
   * 排序键 = score + count×5 - 等待时长惩罚。等待惩罚让"一条好弹幕压了 20 秒"仍然
   * 有机会翻盘，又不会让老弹幕无限堆积（抽取后没被挑中的会被清掉）。
   *
   * 抽完把队列清空：留下的内容下一轮已经不新鲜了。
   */
  drain(q, limit, nowMs) {
    const limitN = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1;
    const at = Number.isFinite(nowMs) ? nowMs : now();
    const scored = q.items.map((item) => ({
      item,
      rank: item.score + Math.min(item.count, 5) * 5 - Math.max(0, Math.floor((at - item.at) / 1000)) / 4,
    }));
    scored.sort((a, b) => b.rank - a.rank);
    const picked = scored.slice(0, limitN).map((s) => s.item);
    q.items = [];
    q.stats.drains += 1;
    return picked;
  },

  /** 清空（停止监听时用）。 */
  clear(q) {
    q.items = [];
  },

  /** 快照（workshop 显示与测试断言用）。 */
  snapshot(q) {
    return {
      size: q.items.length,
      cap: q.cap,
      stats: { ...q.stats },
      items: q.items.slice(-8).map((item) => ({ ...item })),
    };
  },
};

function emptyStats() {
  return { accepted: 0, filtered: 0, dropped: 0, duplicates: 0, drains: 0 };
}

/** 清洗一条弹幕：非对象/空文本/纯符号纯数字返回 null（计入 dropped）。 */
function normalise(item) {
  if (!item || typeof item !== 'object') return null;
  const raw = typeof item.text === 'string' ? item.text : '';
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  // 剥掉标点、符号、空白、字母数字之后一个字都不剩 = 念出来没有任何信息量
  // （"666"、"？？?"、一堆感叹号）：连队列都不进，它们不是"被过滤的弹幕"，是噪音。
  const meaningful = cleaned.replace(/[\s\p{P}\p{S}0-9a-zA-Z]/gu, '');
  if (!meaningful) return null;
  const uid = text(item.uid, 64) || keyOf(item.name, 'guest');
  return {
    uid,
    name: text(item.name, 24) || '观众',
    text: cleaned,
    at: Number.isFinite(item.at) ? item.at : now(),
    score: 0,
    count: 1,
  };
}

/**
 * 静态过滤 + 打分。返回 false = 根本不值得占队列的位置。
 *
 * 打分只看文本本身（关键词、问号、长度适中），"谁说的、说了几遍"留给去重和抽取。
 */
function passesRules(entry, rules) {
  const minLen = Number.isFinite(rules.minTextLen) ? rules.minTextLen : 2;
  const maxLen = Number.isFinite(rules.maxTextLen) ? rules.maxTextLen : 40;
  if (Array.from(entry.text).length < minLen || Array.from(entry.text).length > maxLen) return false;

  const blocked = splitList(rules.blockedWords);
  for (const word of blocked) {
    if (entry.text.includes(word)) return false;
  }

  // 纯符号 / 纯数字 / 单字复读已在 normalise 处挡掉；这里只保留关键词与问号的加分。
  const keywords = splitList(rules.keywords);
  for (const word of keywords) {
    if (entry.text.includes(word)) entry.score += 20;
  }
  if (/[?？]/.test(entry.text)) entry.score += 15;
  if (/^(666|233|哈哈哈+|哈哈哈哈*|草|？+|!+|。+|…+)$/.test(entry.text)) entry.score -= 30;
  entry.score += 10; // 基础分：能进队就比"没有"强
  return true;
}

/** "a,b,c" → ['a','b','c']；空串/空格安全。 */
function splitList(raw) {
  return String(raw === undefined || raw === null ? '' : raw)
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
