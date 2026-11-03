// lib/history.js —— 最近上传的链接
//
// 存在自己的私有目录里（`storage`），一个键一份 JSON 数组，最新在前。它存在的理由很朴素：
// 链接要被**贴到别处**，而"刚上传的那条"往往是在另一个窗口里用。上限来自设置项
// `maxHistory`（0 = 不记录），因为这是插件自己的数据，占多少由用户决定。

'use strict';

/** 一个键，一个写者：这个文件是它唯一的主人（多挂载之间靠 storage.changed 知道变化）。 */
const KEY_UPLOADS = 'uploads-v1';

async function loadHistory() {
  const list = await readJSON(KEY_UPLOADS, []);
  return Array.isArray(list) ? list : [];
}

/**
 * 把一次成功的上传记到最前面。
 *
 * 同一个链接只留一条：用户重复上传同一张图（或对同一条结果再点一次）时，历史不该长出两行
 * 一模一样的记录——那样"最近上传"就会把有用的信息挤掉。
 */
async function pushHistory(row) {
  const limit = num('maxHistory', 0, 500, 50);
  if (limit <= 0) return [];
  const list = await loadHistory();
  const kept = list.filter((item) => item && item.url !== row.url);
  kept.unshift(row);
  const capped = kept.slice(0, limit);
  await writeJSON(KEY_UPLOADS, capped);
  return capped;
}

async function clearHistory() {
  // remove 而不是写一个空数组：文件不在了，"没有记录"就是它本来的样子。
  await request('storage.remove', { key: KEY_UPLOADS });
}
