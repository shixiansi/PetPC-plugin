// lib/core.js —— 文档骨架、DOM 引用、宿主桥
//
// 页面元素与 postMessage 桥：插件所有能力都从这里出去。
//
// 从原来的 app.js 按节**原样搬出来**（1.12 的重构）：内容逐字未改，只是换了个文件。
// 经典 script 共享同一个全局作用域，所以这里不用 import/export；
// 加载顺序写在 panel.html 里（顺序 = 原来的文件顺序，所以原有的依赖关系不变）。
'use strict';

/**
 * QQ 群聊插件 —— Milky 协议桥。
 *
 * WHAT THIS FILE IS
 *
 * One plugin, two appearances of one document (see panel.html). The frame the pet
 * mounts in the background is the whole bot:
 *
 *   Milky 协议端 (Yogurt)  ──ws──▶ 宿主 (net.ws)  ──event──▶  这个文件
 *                                                             │
 *        llm.chat（借用对话插件的模型配置）◀───────────────────┤
 *                                                             │
 *        net.fetch POST /api/send_group_message ─────────────▶ 群里
 *
 * Nothing here talks to the network directly. The socket is the host's (a browser
 * `new WebSocket()` cannot send the `Authorization` header, and the page is torn
 * down on every plugin update), and the model is the host's (the credential never
 * enters this document). This file owns three things in return:
 *
 *   1. what counts as "talking to the bot" (a mention, or a configured prefix);
 *   2. what the model is told about the group (persona, the speaker, recent turns);
 *   3. what is remembered per group, in the plugin's own private storage.
 *
 * WHY THE HISTORY IS STORED HERE
 *
 * Per group, in `plugin-data/com.shixiansi.plugin-qq/history/<群号>`. The host keeps
 * no transcript for plugin calls at all (that is the conversation plugin's file),
 * so a group's memory cannot live anywhere else without becoming a second, and
 * invisible, writer of it. The file is re-read before every answer instead of being
 * cached for the session, because the workshop view in the market program can CLEAR
 * a group's memory in a different process - a cached copy would quietly restore what
 * the user just deleted.
 *
 * The rest of that directory is laid out one folder per kind of data; see the
 * "数据放在哪" section below, which is also where the one-time migration from the
 * flat 1.10 layout lives.
 */

'use strict';

// --- DOM ---------------------------------------------------------------------

const els = {
  root: document.getElementById('root'),
  background: document.getElementById('background'),
  workshop: document.getElementById('workshop'),
  chipState: document.getElementById('chip-state'),
  chipSelf: document.getElementById('chip-self'),
  chipModel: document.getElementById('chip-model'),
  statusNote: document.getElementById('status-note'),
  statusError: document.getElementById('status-error'),
  facts: document.getElementById('facts'),
  groups: document.getElementById('groups'),
  groupsBody: document.getElementById('groups-body'),
  groupsEmpty: document.getElementById('groups-empty'),
  log: document.getElementById('log'),
  logEmpty: document.getElementById('log-empty'),
  // 表情包管理（see the "表情包管理" section near the bottom of this file).
  stickerSummary: document.getElementById('sticker-summary'),
  stickerStatus: document.getElementById('sticker-status'),
  stickerFilter: document.getElementById('sticker-filter'),
  stickerSelectPage: document.getElementById('sticker-select-page'),
  stickerSelected: document.getElementById('sticker-selected'),
  stickerMoveTarget: document.getElementById('sticker-move-target'),
  stickerMove: document.getElementById('sticker-move'),
  stickerGrid: document.getElementById('sticker-grid'),
  stickerEmpty: document.getElementById('sticker-empty'),
  stickerPage: document.getElementById('sticker-page'),
  stickerPrev: document.getElementById('sticker-prev'),
  stickerNext: document.getElementById('sticker-next'),
  stickerCategories: document.getElementById('sticker-categories'),
  stickerNewName: document.getElementById('sticker-new-name'),
  stickerAdd: document.getElementById('sticker-add'),
  stickerPurgeRow: document.getElementById('sticker-purge-row'),
  stickerPurgeTruncated: document.getElementById('sticker-purge-truncated'),
  stickerRecoverTruncated: document.getElementById('sticker-recover-truncated'),
  pendingBlock: document.getElementById('pending-block'),
  pendingList: document.getElementById('pending-list'),
  probeNote: document.getElementById('probe-note'),
  memoryCard: document.getElementById('memory-card'),
  memoryGroup: document.getElementById('memory-group'),
  memoryEmpty: document.getElementById('memory-empty'),
  memoryList: document.getElementById('memory-list'),
  memoryNew: document.getElementById('memory-new'),
  memoryAdd: document.getElementById('memory-add'),
  memoryStatus: document.getElementById('memory-status'),
  remindList: document.getElementById('remind-list'),
  remindEmpty: document.getElementById('remind-empty'),
};

// --- the bridge --------------------------------------------------------------
//
// The same {v,type,id,method,payload} envelope every plugin uses. A request that
// the host refuses rejects with the host's own Chinese sentence ("插件 X 未获权限
// net.ws"), which is shown verbatim: a generic "操作失败" would hide exactly the
// thing the user has to fix.

const PROTOCOL = 1;
let nextRequestID = 1;
const pending = new Map();

function postToHost(message) {
  if (!window.parent) return;
  window.parent.postMessage({ v: PROTOCOL, ...message }, '*');
}

function request(method, payload) {
  const id = String(nextRequestID++);
  postToHost({ type: 'request', id, method, payload: payload === undefined ? {} : payload });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

/**
 * The same request, but with a deadline.
 *
 * It exists for ONE caller: the protocol-side probe on startup, which must not inherit
 * the host's 30 s `net.fetch` timeout. A bot that waits half a minute to discover that
 * nothing is listening cannot decide whether to start the client in time to be useful.
 *
 * The pending entry is DELETED when the deadline fires, so a response that arrives
 * afterwards is dropped by onResponse instead of resolving a promise nobody awaits -
 * the same rule the host's own refusals follow: a timed-out call does nothing.
 */
function requestWithTimeout(method, payload, timeoutMs) {
  const id = String(nextRequestID++);
  postToHost({ type: 'request', id, method, payload: payload === undefined ? {} : payload });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`请求超时（${timeoutMs} ms）`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
  });
}

/** Resolves after ms; used to let a just-started program come up. */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Everything the host granted, upper-cased membership is unnecessary: ids are exact. */
const granted = new Set();
let self = { pluginId: '', surface: {} };
let view = 'workshop';

