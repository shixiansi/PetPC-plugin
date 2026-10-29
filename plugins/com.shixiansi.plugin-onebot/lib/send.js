// lib/send.js —— 出站：动作请求与消息段
//
// OneBot 的调用是**异步**的，而且有两层确认，必须分清楚：
//
//   1. `ws.send` 的回应  —— 宿主告诉我们"这一帧已经写到线上了"；
//   2. `{"status":"ok","retcode":0,"echo":…}` —— 协议端告诉我们"这个动作我做了"。
//
// 发消息只等第 1 层。等第 2 层会有一个很坏的失败模式：实现得糙一点的协议端不回 `echo`，
// 于是每一条回答都要干等 10 秒才被判定失败——而消息其实早就送到了。所以发送按"已上线"算成功，
// 第 2 层如果回来了、并且 `retcode` 不是 0，就当成一条**要记下来的失败**（面板上看得见）。
//
// 查询（`get_login_info`）不一样：它的答案就在第 2 层里，所以它必须等 `echo`。
//
// 消息用**消息段数组**而不是 CQ 码字符串：昵称里带方括号或逗号时，CQ 码要靠转义规则，而转义
// 规则在协议端之间并不统一。数组是结构化的，没有转义问题。

'use strict';

/** echo -> {resolve, reject, timer}：正在等回应的查询。 */
const actionWaiters = new Map();
/** echo -> 动作名：发送类动作只用来把"协议端拒绝了"变成一条能查的记录。 */
const sentActions = new Map();
let nextEcho = 1;
const ACTION_TIMEOUT_MS = 10_000;

function textSegment(body) {
  return { type: 'text', data: { text: String(body === undefined || body === null ? '' : body) } };
}

function atSegment(qq) {
  return { type: 'at', data: { qq: String(qq) } };
}

/** 引用一条消息（OneBot v11 的 reply 段）。 */
function replySegment(messageId) {
  return { type: 'reply', data: { id: String(messageId) } };
}

function mintEcho(name) {
  const echo = `a${nextEcho++}`;
  sentActions.set(echo, name);
  if (sentActions.size > 60) {
    for (const old of [...sentActions.keys()].slice(0, 30)) sentActions.delete(old);
  }
  return echo;
}

/**
 * 发一个动作，**等协议端的回应**。用于查询（答案在回应里）。
 *
 * 超时是真失败：没有回应就没有数据，等下去也不会出现。
 */
function action(name, params) {
  const echo = mintEcho(name);
  const body = JSON.stringify({ action: name, params: params || {}, echo });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      actionWaiters.delete(echo);
      reject(new Error(`${name} 没有回应（${ACTION_TIMEOUT_MS / 1000} 秒）`));
    }, ACTION_TIMEOUT_MS);
    actionWaiters.set(echo, { resolve, reject, timer });
    request('ws.send', { text: body }).catch((err) => {
      clearTimeout(timer);
      actionWaiters.delete(echo);
      reject(err);
    });
  });
}

/**
 * 发一个动作，只等"已写到线上"。用于发送消息（见文件头）。
 *
 * 仍然带 `echo`：这样协议端真拒绝时那条回应还能被认出来、记一笔。
 */
async function sendAction(name, params) {
  const echo = mintEcho(name);
  await request('ws.send', { text: JSON.stringify({ action: name, params: params || {}, echo }) });
}

/**
 * 路由一帧动作回应。返回 true 表示它被这里处理了（不是事件）。
 *
 * 没有等待者的回应不是错误：那多半是一次发送的确认，只在 `retcode` 非 0 时值得记一笔。
 */
function onActionResult(frame) {
  const echo = frame && frame.echo !== undefined ? String(frame.echo) : '';
  const failed = typeof frame.retcode === 'number' && frame.retcode !== 0;
  const waiter = actionWaiters.get(echo);
  if (waiter) {
    actionWaiters.delete(echo);
    sentActions.delete(echo);
    clearTimeout(waiter.timer);
    if (failed) {
      waiter.reject(new Error(`协议端拒绝：retcode=${frame.retcode}${frame.wording ? `（${frame.wording}）` : ''}`));
      return true;
    }
    waiter.resolve(frame.data === undefined ? {} : frame.data);
    return true;
  }
  const name = sentActions.get(echo);
  if (name !== undefined) {
    sentActions.delete(echo);
    if (failed) note(`${name} 被协议端拒绝：retcode=${frame.retcode}${frame.wording ? `（${frame.wording}）` : ''}`);
    return true;
  }
  return false;
}

/** 连上之后问一次"我是谁"。协议端可能还没准备好，所以调用方会重试。 */
async function fetchLoginInfo() {
  const data = await action('get_login_info', {});
  return data && data.user_id !== undefined ? String(data.user_id) : '';
}

async function sendGroup(groupId, segments) {
  return sendAction('send_group_msg', { group_id: toNumberId(groupId), message: segments, auto_escape: false });
}

async function sendPrivate(userId, segments) {
  return sendAction('send_private_msg', { user_id: toNumberId(userId), message: segments, auto_escape: false });
}

/**
 * 协议端的 id 是数字。字符串形式的 id 直接传过去，有的实现会当成 0 或报错——所以这里转成
 * 数字；转不动就原样传（极少数实现用字符串 id）。
 */
function toNumberId(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw);
  const n = Number(s);
  return Number.isSafeInteger(n) && `${n}` === s ? n : s;
}
