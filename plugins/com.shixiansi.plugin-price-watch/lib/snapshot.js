// lib/snapshot.js —— 监控条目、快照、变化历史
//
// 三份数据，全部只在这个插件的私有目录里（宿主不设容量上限，尺寸靠自己控制）：
//
//   snap/<16 位指纹>   一条监控的**当前快照**：内容指纹 + 一段 ≤160 字摘录 + 上次成功时间。键由
//                     (URL + 选择器) 的指纹算出，而不是"第几行"——用户调换两行顺序、或中间插一条
//                     新的，都不该让剩下的条目全部"变了"一次。
//   hist/changes      最近 20 次**已确认**的变化（谁、什么时候、前后各一小段）。
//
// 只有常驻帧写这两样，插件页只读（手册 §6.3 的"一个键只有一个写者"）。快照里刻意**不存全文**：
// 比对靠指纹（`lib/extract.js`），给用户看"哪一段变了"靠两小段摘录。

'use strict';

const MAX_ENTRIES = 8;
const HISTORY_MAX = 20;
const EXCERPT_CHARS = 160;
const SNAPSHOT_PREFIX = 'snap/';
const HISTORY_KEY = 'hist/changes';

/** 一条监控的稳定标识：URL + 选择器的指纹（换行分隔，避免两者边界处撞车）。 */
const entryId = (url, selector) => hashText(`${String(url || '').trim()}\n${String(selector || '').trim()}`);

const snapshotKey = (id) => SNAPSHOT_PREFIX + id;

/** 没写名字的条目用域名当名字。 */
function hostOf(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return String(url || '');
  }
}

/**
 * 把设置里那段文本切成监控条目：一行一条，`名字 | URL | CSS 选择器（可空）`。空行与 `#` 开头的行
 * 跳过（临时关掉一条不用删掉它）；URL 必须是 http(s)；名字可空（用域名）；选择器里可以继续有 `|`
 * （CSS 的命名空间写法），所以第三段之后是 join 回去的。读不出来的行**不丢弃**：返回一条带
 * `problem` 的记录，界面显示成「未配置」并说明原因——悄悄跳过一行是这种插件最坏的失败方式。
 */
function parseEntries(raw) {
  const out = [];
  for (const line of String(raw === undefined || raw === null ? '' : raw).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('|');
    const name = (parts[0] || '').trim();
    const url = (parts[1] || '').trim();
    const selector = parts.slice(2).join('|').trim();
    const record = { name: name || (url ? hostOf(url) : ''), url, selector, id: '', problem: '' };
    if (!url) {
      record.problem = '这一行读不出 URL（格式：名字 | URL | 选择器）';
    } else if (!/^https?:\/\//i.test(url)) {
      record.problem = `只支持 http/https：${text(url, 60)}`;
    } else {
      try {
        void new URL(url); // 只问"能不能解析"；真正的拒绝在宿主那一侧（域名白名单）。
        record.id = entryId(url, selector);
      } catch {
        record.problem = `这个 URL 解析不了：${text(url, 60)}`;
      }
    }
    if (!record.problem && out.filter((e) => !e.problem).length >= MAX_ENTRIES) {
      record.problem = `超过 ${MAX_ENTRIES} 条了，这一条不会被监控`;
    }
    out.push(record);
  }
  return out;
}

/** 能真正去抓的条目（有 id、没有 problem）。 */
function watchableEntries(list) {
  return (list || []).filter((e) => e && e.id && !e.problem);
}

// --- 快照 ---------------------------------------------------------------------

/**
 * 读一条快照。`null` = 还没有任何一次抓取记录（首次抓取只建基线、**一条气泡都不发**）。判据是
 * `at`（"试过"）而不是 `hash`（"抓到过内容"）：首轮就失败的那条也有时间戳、也要在界面上显示成
 * 「失败」；有没有基线由调用方按 `hash` 判断。坏 JSON 当 `null`——那等于重新建立基线。
 */
async function loadSnapshot(id) {
  const snap = await readJSON(snapshotKey(id), null);
  if (!snap || typeof snap !== 'object') return null;
  if (!Number.isFinite(Number(snap.at)) || Number(snap.at) <= 0) return null;
  return snap;
}

async function saveSnapshot(snap) {
  await writeJSON(snapshotKey(snap.id), snap);
}

// --- 变化历史 -----------------------------------------------------------------

async function loadHistory() {
  const list = await readJSON(HISTORY_KEY, []);
  return Array.isArray(list) ? list.filter((row) => row && typeof row === 'object') : [];
}

/** 新的一条放最前，只留 HISTORY_MAX 条。 */
function pushChange(list, record) {
  return [record, ...(Array.isArray(list) ? list : [])].slice(0, HISTORY_MAX);
}

async function saveHistory(list) {
  await writeJSON(HISTORY_KEY, list);
}

// --- 展示 ---------------------------------------------------------------------

/**
 * 一条监控在界面上的状态：`未配置`（这行读不出来）/ `失败`（上一轮抓失败，快照是上一次成功的
 * 那一份）/ `正常` / `还没抓过`（配好了，常驻帧的第一轮还没来）。
 */
function statusOf(entry, snap) {
  if (!entry || entry.problem) return { label: '未配置', kind: 'info', detail: entry ? entry.problem : '' };
  if (!snap) return { label: '还没抓过', kind: 'info', detail: '等常驻帧的第一轮抓取' };
  if (snap.ok === false) return { label: '失败', kind: 'warn', detail: text(snap.error, 120) };
  return { label: '正常', kind: 'ok', detail: '' };
}

/** 「变了才说一句」的那一句：名字 + 变的那一小段，整体 ≤140 字（气泡里的字要短）。 */
function bubbleText(name, snippet) {
  const head = name ? `「${text(name, 40)}」变了` : '监控的网页变了';
  return text(`${head}${snippet ? `：${snippet}` : '（内容更新了）'}`, 140);
}
