// lib/admin.js —— 群内命令、协议端自动启动、连接
//
// #状态/#忘掉/#补图，以及 ws 的建立与身份读取。
//
// 从原来的 app.js 按节**原样搬出来**（1.12 的重构）：内容逐字未改，只是换了个文件。
// 经典 script 共享同一个全局作用域，所以这里不用 import/export；
// 加载顺序写在 panel.html 里（顺序 = 原来的文件顺序，所以原有的依赖关系不变）。
'use strict';

// --- 群内管理命令 -------------------------------------------------------------
//
// 只认两个，而且只有主人或管理员能触发：这不是聊天，是"看一眼它现在什么状态"和
// "把它的记忆清掉"——两件事都不该由群里任何人随时做。

const GROUP_COMMANDS = { '#状态': 'status', '#忘掉': 'forget' };

function groupCommandOf(text) {
  const raw = String(text || '').trim();
  for (const [command, kind] of Object.entries(GROUP_COMMANDS)) {
    if (raw === command || raw.startsWith(`${command} `)) return kind;
  }
  return '';
}

function isGroupAdmin(data) {
  const owner = String(state.cfg.ownerQQ || '').trim();
  const sender = String(data.sender_id || '');
  if (owner && sender === owner) return true;
  const role = String((data.group_member && data.group_member.role) || '').toLowerCase();
  return role === 'admin' || role === 'owner';
}

/** 群友卡片的张数（工坊/命令里显示"它认识了几个群友"）。 */
async function countFriends() {
  try {
    const res = await request('storage.list', { sub: 'memory/friends' });
    const files = (res && res.files) || [];
    return Array.isArray(files) ? files.length : 0;
  } catch {
    return 0;
  }
}

async function handleGroupCommand(kind, groupID, data) {
  const say = async (text) => {
    await api('send_group_message', { group_id: Number(groupID), message: [{ type: 'text', data: { text } }] });
    state.counts.replies += 1;
  };
  if (!isGroupAdmin(data)) {
    await say('这条命令只有群主/管理员能用。');
    return;
  }
  if (kind === 'forget') {
    await saveNotes(groupID, []);
    // 往来一起清：上下文里如果有什么被服务商拦下的内容（真机上是群里让人"把脏话记下来"），
    // 只清要点是没用的 —— 它还在 history 里，下一次请求照样被拒。
    try {
      await request('storage.remove', { key: historyKey(groupID) });
      state.moderationAt.delete(String(groupID));
    } catch {
      // 删不掉就只是没清干净，下一轮照样会走"最小上下文"兜底
    }
    await say('这个群的记忆和最近的往来都清掉了。');
    note(`群 ${groupID}：记忆与往来已被清空（工坊里也有同样的按钮）`);
    return;
  }
  const energy = await loadEnergy(groupID);
  const notes = await loadNotes(groupID);
  const friends = await countFriends();
  const mine = (await loadReminders()).filter((row) => String(row.group) === String(groupID));
  await say(
    `能量 ${Math.round(energy * 100)}/100（${energyLabel(energy)}）；这个群记着 ${notes.length} 条；群友卡片 ${friends} 张。`
      + (mine.length ? `定时提醒 ${mine.map((row) => row.time).join('、')}。` : ''),
  );
}

// --- 协议端（可选自动启动）-----------------------------------------------------

/**
 * How long the protocol side has to answer a `get_login_info` before it counts as
 * "not running". Short on purpose: this sits in front of the connection, so the whole
 * probe is a startup cost, and a server that is up answers a local HTTP request in
 * milliseconds.
 */
const CLIENT_PROBE_TIMEOUT_MS = 1500;

/**
 * How long to wait after starting the protocol side before dialling.
 *
 * A freshly started Yogurt needs a moment to bind its port and load its account. Dialling
 * immediately would fail, and the host's retry ladder would then spend its first (short)
 * step on a connection that could never have worked.
 */
const CLIENT_STARTUP_GRACE_MS = 2000;

/**
 * Whether THIS page has already tried to start the protocol side.
 *
 * One attempt per page lifetime, and the flag is checked before the call rather than
 * after it: a plugin frame is rebuilt on every plugin update, and a bot that re-launched
 * Yogurt on every rebuild would fill the desktop with copies the user never asked for.
 */
let clientLaunchTried = false;

/**
 * True when something ANSWERS at the protocol side's API.
 *
 * It is deliberately not api(): api() throws when the reply carries `status: "failed"`,
 * and a protocol side that is running but not logged in yet answers exactly that. Only a
 * transport-level failure - nothing listening, connection refused, the probe's own
 * deadline - means "the program is not there", which is the only question this asks.
 * Starting a second copy because the first one has not scanned a QR code yet would be
 * the worst outcome of getting this wrong.
 */
async function protocolClientReachable() {
  const headers = { accept: 'application/json', 'content-type': 'application/json' };
  if (state.cfg.accessToken) headers.authorization = `Bearer ${state.cfg.accessToken}`;
  try {
    await requestWithTimeout('net.fetch', {
      method: 'POST',
      url: `${state.base}/api/get_login_info`,
      body: '{}',
      headers,
    }, CLIENT_PROBE_TIMEOUT_MS);
    return true;
  } catch (err) {
    // The reason is worth a line: "not declared in netHosts" and "connection refused"
    // both mean "not reachable" here but need completely different fixes.
    note(`探测协议端失败：${(err && err.message) || err}`);
    return false;
  }
}

/**
 * Starts the protocol side if it is not already running and the user asked for it.
 *
 * Called ONCE per page, before the socket is dialled. Each of the four outcomes is a
 * distinct log line, because the difference between "you did not turn it on", "you did
 * not give me a path", "I started it" and "it would not start" is exactly what a user
 * staring at "未连接" needs to know.
 */
async function ensureProtocolClient() {
  if (await protocolClientReachable()) return;

  if (!flag(state.cfg.autoStartClient, false)) {
    note('协议端没响应：没开启自动启动（autoStartClient 关），不改动它');
    return;
  }
  const path = String(state.cfg.clientPath || '').trim();
  if (!path) {
    note('协议端没响应：自动启动已开启，但「协议端可执行文件」路径是空的');
    return;
  }
  if (!granted.has('process')) {
    note('协议端没响应：缺少 process 权限，无法启动本机程序');
    return;
  }
  if (clientLaunchTried) {
    note('协议端没响应：本次已经尝试过启动，不再重复拉起');
    return;
  }
  clientLaunchTried = true;
  try {
    const res = await request('process.launch', { path, args: argsOf(state.cfg.clientArgs) });
    const pid = (res && res.pid) || 0;
    note(`已启动协议端客户端（pid ${pid}）`);
  } catch (err) {
    // The host's refusal is already a readable sentence ("process.launch 的 path 必须是
    // 绝对路径：…"), and it is shown verbatim: the user has to fix the field it names.
    note(`启动客户端失败：${(err && err.message) || err}`);
    return;
  }
  await sleep(CLIENT_STARTUP_GRACE_MS);
}

// --- connection --------------------------------------------------------------

function onSocketState(payload) {
  const next = (payload && payload.state) || 'closed';
  state.ws = next;
  state.wsError = (payload && payload.error) || '';
  note(`WebSocket ${next}${state.wsError ? `（${state.wsError}）` : ''}`);
  if (next === 'open') void learnIdentity();
  schedulePersist();
}

/** Asks the protocol side who we are, so the dashboard can show it. */
async function learnIdentity() {
  try {
    const info = await api('get_login_info', {});
    if (info && info.uin) {
      state.selfID = String(info.uin);
      state.selfName = String(info.nickname || '');
      note(`已登录：${state.selfName || '（无昵称）'} ${state.selfID}`);
      schedulePersist();
    }
  } catch (err) {
    note(`读取登录信息失败：${(err && err.message) || err}`);
  }
}

/**
 * Reads the group index back into memory.
 *
 * It has to happen BEFORE the first persist, and 1.10 did not do it: the bot started with
 * an empty map and its first write replaced the index with that empty list, so every
 * restart wiped the group names, the counts and "which rooms were alive a minute ago"
 * (the only thing the proactive path uses to avoid talking into an empty room). Reading it
 * first also keeps the upgrade visible: the migration moves that file, and clobbering it
 * on the same boot would make the tidying look like it had deleted the groups.
 *
 * `lastAt` is kept as stored rather than stamped with "now": a group nobody has touched
 * for an hour must stay unattractive to the proactive tick, or the first minute after a
 * restart would be the most talkative one.
 */
async function loadGroupsIndex() {
  if (!granted.has('storage')) return;
  for (const row of await readGroupsIndex(DATA.groups)) {
    if (!row || row.id === undefined || row.id === null) continue;
    state.groups.set(String(row.id), {
      id: String(row.id),
      name: String(row.name || ''),
      count: Number(row.count) || 0,
      lastAt: Number(row.lastAt) || 0,
    });
  }
  // True even when the file was empty or unreadable: from here on the map IS this
  // install's answer, so publishing it is no longer a way to lose the file.
  state.groupsLoaded = true;
}

/** Starts the bot: read the settings, derive the endpoints, ask the host to dial. */
async function startBot() {
  if (state.started) return;
  state.started = true;
  await loadGroupsIndex();
  if (!granted.has('net.ws')) {
    note('未获授权：net.ws');
    return;
  }
  try {
    const res = await request('config.get', {});
    const values = (res && res.values) || {};
    state.cfg = { ...DEFAULTS, ...values };
  } catch (err) {
    note(`读取配置失败：${(err && err.message) || err}`);
  }
  const endpoints = endpointsFor(state.cfg.server, state.cfg.accessToken);
  state.base = endpoints.base;
  state.eventUrl = endpoints.eventUrl;
  appliedConfig = JSON.stringify(state.cfg);
  // Before dialling, ask whether the protocol side is even there. This is the only
  // place the client is started: it happens once, at the start of the page's life,
  // and the retry ladder below then owns the connection.
  await ensureProtocolClient();
  try {
    await request('ws.open', { url: state.eventUrl, token: state.cfg.accessToken });
    note(`正在连接 ${endpoints.eventUrl.replace(/access_token=[^&]*/, 'access_token=***')}`);
  } catch (err) {
    state.counts.errors += 1;
    note(`连接失败：${(err && err.message) || err}`);
  }
  void refreshModelSource();
  // Keep the running bot in step with the saved settings: see startConfigWatch.
  //
  // 订阅一次 `config.changed`：宿主的设置事件只发给**订阅过**的插件（win: 手册 §7.1），
  // 而 storage.changed / share.changed 是直接发给相关插件的，不需要订阅。
  if (granted.has('events')) {
    void request('events.subscribe', { names: ['config.changed'] }).catch(() => {});
  }
  startConfigWatch();
  // 30 秒兜底 for the Bilibili bridge. 这里原来写的是"结果是文件，文件没有事件可送"——那是
  // 2026-10 的事实：bilibili 插件发布 `bili-results` / `recommend` 之后，宿主会发
  // share.changed（手册 §7.1），qq 已经声明了这两个键的 shareRead，所以主路径是推送，
  // 这个定时器只负责"事件丢了"。真机日志里那 182 次 share.get 就是 5 秒一拍的产物。
  state.bridgeStartedAt = Date.now();
  if (state.bridgeTimer) clearInterval(state.bridgeTimer);
  state.bridgeTimer = setInterval(() => {
    void pollBridge();
  }, 30_000);
  // The ticker is started from the settings, not from a constant: a user who set
  // `proactiveMinutes` to 0 must not pay for a timer that decides to do nothing
  // every minute.
  startProactive();
  if (number(state.cfg.proactiveMinutes, 0, 0, 1440) > 0) {
    note(`主动开口已开启：平均每 ${number(state.cfg.proactiveMinutes, 0, 0, 1440)} 分钟一句`);
  }
  startBatch();
  if (flag(state.cfg.batchEnabled, true)) {
    note(`攒批自主插话已开启：每群每 ${number(state.cfg.batchWindowSec, 120, 30, 3600)} 秒最多看一次聊天，每小时最多 ${number(state.cfg.batchMaxPerHour, 8, 0, 200)} 次`);
  }
  startReminders();
  const armed = (await loadReminders(true)).length;
  if (armed) note(`有 ${armed} 条定时提醒在等时间`);
}

/** Records where the model settings would come from, for the dashboard. */
async function refreshModelSource() {
  if (!granted.has('llm.borrow')) {
    state.modelSource = state.cfg.llmModel ? `自有：${state.cfg.llmModel}` : '自有配置';
    return;
  }
  try {
    const profile = await request('llm.profile', {});
    if (profile && profile.source === 'borrowed' && profile.lender) {
      state.modelSource = `借用「${profile.lender.name}」：${profile.model || ''}`;
    } else if (profile && profile.source === 'own') {
      state.modelSource = `自有：${profile.model || state.cfg.llmModel}`;
    } else {
      state.modelSource = '未配置';
    }
  } catch (err) {
    state.modelSource = '由桌宠进程决定';
  }
}

