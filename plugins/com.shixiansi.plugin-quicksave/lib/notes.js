'use strict';

/* 速记盒子的数据层：**一个 storage 键、一份 JSON**（`notes-v1`）。
 *
 * 为什么不是"一条一个键"：这个盒子每次打开界面都要「最近三条」、要「搜一句」、要「满了淘汰最久
 * 没碰过的」——在一条一个键的布局下，这三件事都要求先 list 一遍目录再逐条 get。一次打开就是几十
 * 个来回，而它要显示的只是三行字。表情库那种"一张图一个键"是对的（图不该塞进一个值），速记不是。
 *
 * 为什么设置里的默认上限是 500 而不是 5000：手册 §6.3 只拦一件事——**单次 storage.set 的值
 * > 1 MiB**。一条速记最长 500 字，500 条 × 500 字 = 25 万字符，按 UTF-8 算约 750 KB（汉字 3
 * 字节、ASCII 1 字节），离 1 MiB 还有余量；而 5000 条就是 7.5 MB，第一次写满必然撞上那条拒绝，
 * 症状是"记不下来了"——用户从界面上看不出原因，只会以为插件坏了。
 * 所以除了条数上限，还有一层**字节守卫**（VALUE_MAX_BYTES）：条数设到 2000、内容又都是长句时，
 * 按同一个淘汰顺序继续腾地方，而不是等宿主回一条拒绝。
 *
 * 这个文件是纯数据：不碰 DOM、不发消息、不知道宿主存在，所以测试可以单独摆弄它。
 */

const TEXT_MAX = 500;
const TAG_MAX = 32;
const RECENT_DEFAULT = 10;
const RECENT_MAX = 50;
/** manifest 里 `maxItems` 的范围。低于 20 的盒子连"最近三条"都放不稳（合并一次就没了）。 */
const LIMIT_MIN = 20;
const LIMIT_MAX = 2000;
/** 宿主单值上限是 1 MiB（1048576 字节）；留 128 KB 余量，别贴着红线走。 */
const VALUE_MAX_BYTES = 900 * 1024;

/** 去首尾空白：存下来的永远是这句话本身，不带用户手滑的空格。 */
function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

/** 按**字符**数（码点）而不是 UTF-16 长度数：一个汉字就是一个字，"500 字"才对得上用户的直觉。 */
function textRunes(value) {
  return [...String(value === undefined || value === null ? '' : value)].length;
}

/** 判重用：去空白 + 大小写不敏感。与手册一致的地方是"用户看起来一样的两句就是同一句"。 */
function dedupKey(text) {
  return normalizeText(text).toLowerCase();
}

/**
 * 标签归一：去空白、去掉用户顺手打的 `#`（界面上显示时会加回去）、内部连续空白压成一个。
 *
 * 为什么去 `#`：同一个标签有两种写法（`#工作` / `工作`），不归一就会在筛选时变成两个标签，
 * 而用户完全看不出区别——这种"数据里悄悄分了两份"的错没人会去查。
 */
function normalizeTag(value) {
  return String(value === undefined || value === null ? '' : value)
    .trim()
    .replace(/^#+/, '')
    .replace(/\s+/g, ' ');
}

/** 标签比较用的小写形式（筛选不分大小写，和 `query` 一致）。 */
function tagKey(value) {
  return normalizeTag(value).toLowerCase();
}

/** 上限夹到 manifest 声明的 20–2000。`values.maxItems` 是字符串（config 的值都是字符串）。 */
function clampMaxItems(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return 500;
  return Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, n));
}

/** UTF-8 字节数。自己数：宿主的 1 MiB 是按字节算的，而 `String.length` 是 UTF-16 长度。 */
function utf8Bytes(text) {
  let bytes = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) bytes += 1;
    else if (cp < 0x800) bytes += 2;
    else if (cp < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/**
 * 把存下来的一串文本读成盒子。
 *
 * 坏数据回落到**空盒子**而不是抛错：这份文件是这个插件自己的，一份读不动的文件不该让整个帧从此
 * 哑掉（宿主每 2 秒扫一次目录，`storage.changed` 会把下一次读写带来的修复机会送到）。
 * 但**不**回落到"覆盖掉它"：真正的写发生在用户/调用方要写的那一刻，而且是现读现改。
 */
function parseBook(raw) {
  if (!raw) return { seq: 0, items: [] };
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return { seq: 0, items: [] };
  }
  const rows = Array.isArray(parsed && parsed.items) ? parsed.items : [];
  let seq = Number.isFinite(Number(parsed && parsed.seq)) ? Math.max(0, Math.floor(Number(parsed.seq))) : 0;
  const items = [];
  for (const row of rows) {
    if (!row || typeof row.text !== 'string') continue;
    const text = normalizeText(row.text);
    if (!text) continue;
    const at = Number.isFinite(Number(row.at)) ? Math.max(0, Math.floor(Number(row.at))) : 0;
    const rowSeq = Number.isFinite(Number(row.seq)) ? Math.max(0, Math.floor(Number(row.seq))) : 0;
    items.push({
      id: typeof row.id === 'string' && row.id ? row.id : 'n' + rowSeq + '-' + at.toString(36),
      text,
      tag: normalizeTag(row.tag),
      at,
      seq: rowSeq,
    });
    if (rowSeq > seq) seq = rowSeq;
  }
  return { seq, items };
}

/** 存盘形式。`v` 是留给以后迁移用的版本号（现在读的时候不看它，写的永远是 1）。 */
function serializeBook(book) {
  return JSON.stringify({
    v: 1,
    seq: book.seq,
    items: book.items.map((item) => ({
      id: item.id,
      text: item.text,
      tag: item.tag,
      at: item.at,
      seq: item.seq,
    })),
  });
}

/** 下一张号码牌。同一毫秒内两条就靠它分先后（`at` 相同时 `seq` 是次级键）。 */
function nextSeq(book) {
  book.seq += 1;
  return book.seq;
}

/**
 * 最新在前：先按 `at` 降序，同一毫秒再按自增序号降序。
 *
 * 不就地排序用户的数组，是为了让"存盘的顺序"和"显示的顺序"互不干扰：显示顺序只是读的时候的一个
 * 视图，文件里留着插入顺序，出问题时还能看出先后。
 */
function sortNewest(items) {
  return [...items].sort((a, b) => (b.at - a.at) || (b.seq - a.seq));
}

/** 最久没被碰过的那一条在数组里的下标（`at` 最小的；同一毫秒取序号小的）。 */
function oldestIndex(items) {
  let oldest = 0;
  for (let i = 1; i < items.length; i += 1) {
    const a = items[i];
    const b = items[oldest];
    if (a.at < b.at || (a.at === b.at && a.seq < b.seq)) oldest = i;
  }
  return oldest;
}

/**
 * 淘汰到"刚好不超"。返回赶走了几条。
 *
 * 顺序是**可预测**的那一种：按 `at` 升序（最久没被碰过的最先走），一次只删到不超为止——
 * 所以"满 500 条之后再加一条，走掉的是第 501 老的那一条"，不是随机、也不是成批清空。
 * 被**合并**过的条目因为 `at` 刚更新过，会自然排到队尾，不该先走；这一条有用例钉住。
 */
function fitBook(book, maxItems) {
  const max = clampMaxItems(maxItems);
  let evicted = 0;
  while (book.items.length > max) {
    book.items.splice(oldestIndex(book.items), 1);
    evicted += 1;
  }
  // 字节守卫（见文件头）：条数没超、但整份值超过 900 KB 时按同一个顺序继续腾地方。
  // 只在真的超了的时候进来一次，所以那个 O(n) 的估算不会变成热路径。
  if (book.items.length > 1 && utf8Bytes(serializeBook(book)) > VALUE_MAX_BYTES) {
    let bytes = utf8Bytes(serializeBook(book));
    while (book.items.length > 1 && bytes > VALUE_MAX_BYTES) {
      const at = oldestIndex(book.items);
      // 减掉这条自己的字节（估算偏大一点点：逗号与括号没减，方向是"多删"，不会留下超限的值）。
      bytes -= utf8Bytes(JSON.stringify(book.items[at])) + 1;
      book.items.splice(at, 1);
      evicted += 1;
    }
  }
  return evicted;
}

/**
 * 往盒子里记一条（**就地**改 `book`），返回调用方拿到的那个形状。
 *
 * 三条规则都在这里，而不是在两处调用点各写一遍（界面那一侧和 `plugin.call` 那一侧）：
 * - 同样的话不新增第二条：去空白、大小写不敏感地比，命中就只更新 `at` 并"置顶"（换一张新的号码
 *   牌，于是同一毫秒里它也排最前），`merged: true`；
 * - 合并时**给了新标签才覆盖**旧标签，没给就留着——把标签覆盖成空等于悄悄删掉用户的归类；
 * - 写完就淘汰（`fitBook`），所以回包里的 `total` 是"存完之后盒子里到底有几条"。
 */
function applyAdd(book, input, maxItems) {
  const wanted = dedupKey(input.text);
  const tag = normalizeTag(input.tag);
  const existing = book.items.find((item) => dedupKey(item.text) === wanted) || null;
  let entry;
  if (existing) {
    existing.at = input.at;
    existing.seq = nextSeq(book);
    if (tag) existing.tag = tag;
    entry = existing;
  } else {
    const seq = nextSeq(book);
    entry = { id: 'n' + seq + '-' + input.at.toString(36), text: input.text, tag, at: input.at, seq };
    book.items.push(entry);
  }
  const evicted = fitBook(book, maxItems);
  return {
    id: entry.id,
    at: entry.at,
    total: book.items.length,
    merged: Boolean(existing),
    evicted,
  };
}

/**
 * 挑出要显示的条目：最新在前，可选子串搜索与标签筛选。
 *
 * `query` 是**大小写不敏感的纯子串**匹配（不解析通配符、不解释正则：一条速记里出现 `*` 是常事，
 * 把它当模式只会让人搜不到自己刚写的东西）。
 * `limited` 是"截断前的命中数"，`items` 是按 `limit` 截断后的那一份——两都给出，调用方才知道
 * 自己是"就这么多"还是"还有更多"。
 */
function selectNotes(items, opts) {
  const limitRaw = opts && opts.limit !== undefined ? opts.limit : RECENT_DEFAULT;
  const limit = Math.min(RECENT_MAX, Math.max(1, Math.floor(Number(limitRaw)) || RECENT_DEFAULT));
  const query = normalizeText(opts && opts.query).toLowerCase();
  const tag = tagKey(opts && opts.tag);
  const matched = [];
  for (const item of sortNewest(items)) {
    if (tag && tagKey(item.tag) !== tag) continue;
    if (query && !item.text.toLowerCase().includes(query)) continue;
    matched.push({ id: item.id, text: item.text, tag: item.tag, at: item.at });
  }
  return {
    items: matched.slice(0, limit),
    limited: matched.length,
  };
}

/** `recent` 的完整回包：`total` 是盒子里一共几条，`matched` 是这次筛中的几条。 */
function recentFrom(book, opts) {
  const picked = selectNotes(book.items, opts);
  return { items: picked.items, total: book.items.length, matched: picked.limited };
}
