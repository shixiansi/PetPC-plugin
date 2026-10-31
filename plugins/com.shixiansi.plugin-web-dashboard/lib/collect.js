// lib/collect.js —— 数据聚合：向各插件要 stats
//
// 看板自己不产生数据。四路数据、三种来源：
//   对话/记忆   plugin.call('chat'/'export-state' 太重)——memcore 没有 stats 方法，
//              用它已声明的 seed？不行——看板读的是"记忆规模"，走 storage 的路径
//              也被沙箱挡住。所以 memcore 的数据由**桥**在宿主侧读（它有宿主权限，
//              见 tools/dashboard-bridge.mjs），插件的 plugin.call 只负责 todo 与
//              pomodoro——这两个插件在 1.2.1/2.3.12 起各自 serves 一个 stats。
//
// 结果统一成 DashboardData 的形状（桥的 /api/data 与这里共用）：
//   { at, chat: {…}|null, todo: {…}|null, pomodoro: {…}|null, plugins: [{id,name,state}] }
//
// 每一路独立失败：一个插件不在，卡片显示"未安装"，其它两路照常。

'use strict';

const DASHBOARD_DATA_KEY = 'state/last-data';

let lastData = null;
let lastError = '';

/** 向一个插件问 stats（带 try/catch：对方不在/没在帧上是常态，不是错误）。 */
async function askPlugin(target, method, payload) {
  try {
    const out = await request('plugin.call', { target, method, payload: payload || {} });
    return out && typeof out === 'object' ? out : null;
  } catch (err) {
    lastError = `${target} 没有回答：${text(err && err.message, 100)}`;
    return null;
  }
}

/** 采集一轮。返回 DashboardData（并落盘，桥会来读）。 */
async function collectOnce() {
  const [todo, pomodoro] = await Promise.all([
    askPlugin('com.shixiansi.plugin-todo', 'stats'),
    askPlugin('com.shixiansi.plugin-pomodoro', 'stats'),
  ]);

  const data = {
    at: now(),
    // memcore 一路：chat 的会话数与规模由桥在宿主侧统计（桥有文件权限），
    // 插件侧只透传上次桥写入 storage 的那份（没有就 null）。
    chat: null,
    todo,
    pomodoro,
  };

  const saved = await readJSON('state/chat-stats', null);
  if (saved && typeof saved === 'object') data.chat = saved;

  lastData = data;
  await writeJSON(DASHBOARD_DATA_KEY, data);
  return data;
}

/** 工坊页用的最近一份数据（先内存后盘）。 */
async function loadLastData() {
  if (lastData) return lastData;
  lastData = await readJSON(DASHBOARD_DATA_KEY, null);
  return lastData;
}

/** 供桥 /api/data 读取的键名常量（桥直接读插件的私有目录）。 */
const DATA_KEY_FOR_BRIDGE = DASHBOARD_DATA_KEY;
