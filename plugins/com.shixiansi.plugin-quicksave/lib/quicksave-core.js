// lib/quicksave-core.js —— 速记的纯函数层：标签提取、添加/合并/淘汰、搜索。
//
// 这里不碰宿主、不碰 DOM、不取当前时间——"现在几点"由调用方传进来。测试接缝：
// panel.html 用 <script> 引入即 window.QuickCore；测试用 new Function 装载同一份源码。
//
// 淘汰策略（写在这里，测试钉死，"可预测"是它的全部价值）：
//   · 上限 cap（默认 500）。满了再进新的一条时挤掉一条；
//   · 被挤的永远是"未置顶里最旧"的那条；全置顶时挤绝对最旧（策略必须总能腾出位置，
//     否则用户加不进任何东西——那比破坏置顶承诺更糟）；
//   · 重复内容不新增：把原条目提到最前并更新时刻（这是"合并"的语义）。
//
// 条目顺序即数组顺序：新的在后（append），显示时反向。position 是时间戳，不是序号——
// 淘汰只看数组下标与 pinned，不依赖时钟单调。
'use strict';

(function () {
  const DEFAULT_CAP = 500;

  /** 提取 #标签：#后面跟非空白字符才算；返回 {clean, tags}。 */
  function parseTags(text) {
    const raw = String(text || '');
    const tags = [];
    const clean = raw.replace(/#([^\s#]+)/g, (all, tag) => {
      const t = String(tag).slice(0, 24);
      if (t && tags.indexOf(t) < 0) tags.push(t);
      return ''; // 标签从正文里拿掉：它已经在 tags 里了，正文留纯内容
    }).replace(/\s{2,}/g, ' ').trim();
    return { clean, tags };
  }

  function normalizeEntry(e) {
    return {
      id: String(e.id || ''),
      text: String(e.text || ''),
      tags: Array.isArray(e.tags) ? e.tags.slice(0, 8).map(String) : [],
      pinned: Boolean(e.pinned),
      at: Number(e.at) || 0,
    };
  }

  /** 读回 storage 里的状态：任何畸形输入都落到空列表，绝不抛错。 */
  function parseState(text) {
    if (!text) return [];
    let v;
    try { v = JSON.parse(String(text)); } catch { return []; }
    if (!Array.isArray(v)) return [];
    return v.filter((e) => e && typeof e === 'object' && typeof e.text === 'string' && e.text).map(normalizeEntry);
  }

  /** 文本去空白后的等价键：重复内容合并的判据（严格全等，不做模糊——猜会并错）。 */
  function dedupKey(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * 添加一条。返回 {entries, added, merged, evicted}：
   *   added   真的进了新条目
   *   merged  与已有条目重复（那条被提到最前、更新时刻）
   *   evicted 被挤掉的条目（没有则 null）
   * nowMs 由调用方传入（测试注入）。
   */
  function add(entries, text, nowMs, options) {
    const opts = options || {};
    const cap = Number.isFinite(opts.cap) ? Math.max(1, Math.floor(opts.cap)) : DEFAULT_CAP;
    const { clean, tags } = parseTags(text);
    if (!clean) return { entries: entries.slice(), added: false, merged: false, evicted: null, reason: '空内容' };
    const key = dedupKey(clean);
    const existing = entries.find((e) => dedupKey(e.text) === key);
    let next = entries.slice();
    if (existing) {
      // 合并：提到最前（数组头），时刻刷新；标签并入（保持原顺序，新标签追加）。
      next = next.filter((e) => e !== existing);
      const mergedTags = existing.tags.slice();
      for (const t of tags) if (mergedTags.indexOf(t) < 0) mergedTags.push(t);
      next.unshift(normalizeEntry({ ...existing, tags: mergedTags.slice(-8), at: nowMs }));
      return { entries: next, added: false, merged: true, evicted: null };
    }
    const entry = normalizeEntry({ id: 'q' + nowMs.toString(36) + Math.random().toString(36).slice(2, 6), text: clean, tags, pinned: false, at: nowMs });
    next.push(entry);
    let evicted = null;
    while (next.length > cap) {
      // 未置顶里最旧 = "除刚加的这条以外"的数组里第一个 !pinned；找不到（全置顶）则挤
      // 绝对最旧（next[0]）。**绝不能挤刚加的这条**：全置顶时 findIndex 若不含这个排除，
      // 找到的唯一未置顶就是新条目自己——挤掉它等于"加了但没加进去"。
      const rest = next.slice(0, -1);
      let idx = rest.findIndex((e) => !e.pinned);
      if (idx < 0) idx = 0;
      evicted = next.splice(idx, 1)[0];
    }
    return { entries: next, added: true, merged: false, evicted };
  }

  function togglePin(entries, id) {
    return entries.map((e) => (e.id === id ? { ...e, pinned: !e.pinned } : e));
  }

  function removeEntry(entries, id) {
    return entries.filter((e) => e.id !== id);
  }

  /** 搜索：文本包含匹配（大小写不敏感），空查询返回全部。tag 过滤可选。 */
  function search(entries, query, tag) {
    let list = entries.slice();
    if (tag) list = list.filter((e) => e.tags.indexOf(tag) >= 0);
    const q = String(query || '').trim().toLowerCase();
    if (q) list = list.filter((e) => e.text.toLowerCase().indexOf(q) >= 0);
    return list;
  }

  /** serve recent：最近 N 条（数组尾是最新的，反向返回），可带 tag。 */
  function recent(entries, options) {
    const opts = options || {};
    const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(100, Math.floor(opts.limit))) : 20;
    const list = search(entries, opts.query, opts.tag);
    return list.slice(-limit).reverse();
  }

  /** 序列化的体积防线：整包 JSON 不许超 1 MiB（storage 单值上限）。 */
  function serialize(entries) {
    const json = JSON.stringify(entries);
    return json;
  }
  const SIZE_LIMIT = 1024 * 1024;
  function fits(entries) {
    return serialize(entries).length <= SIZE_LIMIT;
  }

  window.QuickCore = Object.freeze({
    DEFAULT_CAP,
    SIZE_LIMIT,
    parseTags,
    parseState,
    dedupKey,
    add,
    togglePin,
    removeEntry,
    search,
    recent,
    serialize,
    fits,
  });
})();
