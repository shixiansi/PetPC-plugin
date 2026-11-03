// 假宿主：**一份**实现，两个执行环境。
//
//   plugin-check.mjs 的协议组   → 跑在 jsdom 里，问"插件会不会崩"；
//   preview.html（真浏览器）     → 问"插件在声明的矩形里放不放得下"。
//
// 为什么必须共用：两套假宿主必然分叉，而分叉的假宿主比没有更坏——它会告诉你"没问题"。
// 协议（ready→init、request→response、v 必须是 1、id 必须唯一非空、granted 只是数据）
// 与结果表（METHODS / PERMISSIONS / okResult）都在这一个文件里，谁要改就改这里。
//
// 这个文件**不许 import node 内置模块**：preview.html 会在浏览器里 `import` 它。
// 它也不知道自己身在何处——怎么把消息送进插件（`deliver`）由调用方决定：
//   jsdom：直接 dispatch 一个 MessageEvent 进 window；
//   浏览器：iframe.contentWindow.postMessage(msg, '*')。

// ---------------------------------------------------------------------------
// 契约常量（与《插件开发手册》第 4/6 节一一对应；改这里就要改手册）
// ---------------------------------------------------------------------------

export const PERMISSIONS = {
  'pet.bubble': '让桌宠弹出一句话的气泡',
  events: '订阅宿主的状态变化事件（提醒触发、计时阶段结束、配置变更）',
  'net.fetch': '访问网络（仅限插件声明的域名）',
  'net.credentials': '以你保存的网站登录凭据发请求（凭据本身不会显示给插件）',
  storage: '在自己的私有目录里保存数据',
  'pet.surface': '在桌宠旁显示自定义浮层面',
  'llm.chat': '调用你已配置的大模型（流式返回）',
  'plugin.config': '保存你自己的插件配置',
  audio: '保存并播放音频（例如语音提醒）',
  'net.ws': '保持一条到插件所声明地址的 WebSocket 长连接（收发消息）',
  'llm.borrow': '使用其它插件已配置的大模型与密钥（密钥不会显示给你）',
  process: '启动本机程序',
  'plugin.share': '与其它插件交换消息（只能读清单里点名的键，只能写自己名下的键）',
  'plugin.call': '与其它插件互相调用（只能调用清单里点名的目标，也只能回答清单里声明的方法）',
};

/** 方法表：名字 → { perm, where }。where: 'pet' 只有桌宠服务、'both' 两个宿主都服务。 */
export const METHODS = {
  'bubble.say': { perm: 'pet.bubble', where: 'pet' },
  'events.subscribe': { perm: 'events', where: 'pet' },
  'net.fetch': { perm: 'net.fetch', where: 'both', alsoAllows: ['net.credentials'] },
  'storage.get': { perm: 'storage', where: 'both' },
  'storage.set': { perm: 'storage', where: 'both' },
  'storage.remove': { perm: 'storage', where: 'both' },
  'storage.stat': { perm: 'storage', where: 'both' },
  'storage.dir': { perm: 'storage', where: 'both' },
  'storage.list': { perm: 'storage', where: 'both' },
  'storage.move': { perm: 'storage', where: 'both' },
  // 私有目录用了多少 / 多少个文件 / 按目录拆开。**没有上限**：宿主不限制插件存多少东西
  // （2026-11-01 删掉了那道 64 MiB），用它做展示，不要用它算"该删多少"。
  'storage.usage': { perm: 'storage', where: 'both' },
  'memory.read': { perm: 'storage', where: 'pet' },
  'memory.append': { perm: 'storage', where: 'pet' },
  // 往宿主日志写一行（借用 storage，两个宿主都服务）。
  'plugin.log': { perm: 'storage', where: 'both' },
  'config.get': { perm: 'plugin.config', where: 'both' },
  'config.set': { perm: 'plugin.config', where: 'both' },
  'surface.show': { perm: 'pet.surface', where: 'pet' },
  'surface.hide': { perm: 'pet.surface', where: 'pet' },
  'surface.blocks': { perm: 'pet.surface', where: 'pet' },
  // Borrows the surface grant: same authority, and no 14th permission to authorise.
  'pet.badge': { perm: 'pet.surface', where: 'pet' },
  'llm.chat': { perm: 'llm.chat', where: 'pet' },
  // 今天用了多少：宿主替**你这个调用方**记的账，只读（不花钱、不改状态）。权限借 llm.chat
  // ——"能不能用模型"和"看看自己用了多少"是同一件事的两面；控制中心没有模型调用，所以是 'pet'。
  'llm.usage': { perm: 'llm.chat', where: 'pet' },
  'llm.profile': { perm: 'llm.borrow', where: 'pet' },
  'llm.providers': { perm: 'llm.borrow', where: 'pet' },
  // 渠道表：两个宿主都服务（控制中心的渠道编辑器就靠它），因为它是插件自己的设置。
  'llm.channels.get': { perm: 'llm.chat', where: 'both' },
  'llm.channels.set': { perm: 'llm.chat', where: 'both' },
  'share.set': { perm: 'plugin.share', where: 'both' },
  'share.get': { perm: 'plugin.share', where: 'both' },
  'share.remove': { perm: 'plugin.share', where: 'both' },
  'plugin.call': { perm: 'plugin.call', where: 'pet' },
  // 能力发现：问宿主「谁能干什么」。宿主按安装状态回答（`serves` 是插件的承诺）。
  'plugins.services': { perm: 'plugin.call', where: 'both' },
  'audio.save': { perm: 'audio', where: 'both' },
  'audio.import': { perm: 'audio', where: 'both' },
  'audio.list': { perm: 'audio', where: 'both' },
  'audio.remove': { perm: 'audio', where: 'both' },
  'audio.play': { perm: 'audio', where: 'both' },
  'audio.stop': { perm: 'audio', where: 'both' },
  'ws.open': { perm: 'net.ws', where: 'pet' },
  'ws.send': { perm: 'net.ws', where: 'pet' },
  'ws.close': { perm: 'net.ws', where: 'pet' },
  'ws.state': { perm: 'net.ws', where: 'pet' },
  'process.launch': { perm: 'process', where: 'pet' },
  'process.state': { perm: 'process', where: 'pet' },
  // 停掉自己启动的进程（宿主按"谁启动的"授权，别人的 pid 会被拒）。
  'process.kill': { perm: 'process', where: 'pet' },
};

/** 宿主工具目录里可以被 llm.chat 的 tools 点名的名字（见手册 6.6）。 */
export const LLM_TOOL_NAMES = ['pet_say', 'memory_read', 'memory_append'];

/**
 * 这个「宿主」服务不服务某个方法。
 *
 * 手册 §9 有一张两宿主差异表，`METHODS` 的 `where` 就是那张表的机器可读版本。以前它只被写着、
 * 从没被读过——于是「在控制中心的那一面调只有桌宠才服务的方法」在自检里**永远是 ok**，而真机上
 * 这是最常见的一类失败（2026-10-30 的真机日志里 571 行 `本程序不支持该方法`，其中 445 行来自
 * 一个在 workshop 里每 5 秒调一次 `llm.profile` 的插件）。声明了却不检查的契约比没有契约更坏：
 * 它让人以为查过了。
 *
 * 判据只有一个，就是手册写的那个：`surface.slot === 'workshop'` 是控制中心，其余都是桌宠。
 * `kind` 不能拿来判——常驻帧的 kind 也是 'panel'。
 */
export function hostServes(method, surface) {
  const where = METHODS[method]?.where;
  if (where !== 'pet') return true;           // 'both'，或者根本不是契约里的方法（另有一条检查管）
  return (surface?.slot ?? '') !== 'workshop';
}

/**
 * 每类方法给一个"看起来成功"的答案，让插件能继续往下走。
 *
 * 它故意**不含任何插件特有的数据**：自检工具不知道、也不该假装知道番茄钟的 state 长什么样。
 * 预览页需要真实一点的数据时，另给一个 `answers`（见下面的 `previewAnswers`）。
 */
export function okResult(method) {
  switch (method) {
    case 'storage.get': return { value: '' };
    case 'storage.stat': return { exists: false, bytes: 0 };
    case 'storage.dir': return { dir: 'C:\\模拟\\plugin-data\\example' };
    case 'storage.list': return { dir: 'C:\\模拟', files: [{ name: '举例', bytes: 12, modified: Date.now() - 3600000 }], dirs: [] };
    case 'storage.move': return { ok: true, moved: true };
    case 'storage.usage': return { used: 0, files: 0, folders: {}, limit: -1 };
    case 'config.get': return { values: {}, secrets: {} };
    case 'llm.profile': return { ownReady: false, borrowAllowed: false, ready: false, source: 'none', model: '' };
    case 'llm.providers': return { providers: [], default: '', own: { ready: false, model: '' } };
    // 一张**非空**的示例渠道表：空表会让渠道编辑器只画出空状态，而空状态看不出布局问题
    // （行高、标签列宽、密钥行的网格、按钮层级全都藏起来了）。密钥只有 mask——和真宿主一致。
    case 'llm.channels.get': return {
      defaultChannel: 'openai',
      channels: [
        {
          id: 'openai', name: '主号 OpenAI', baseUrl: 'https://api.openai.com/v1',
          provider: 'openai', models: ['gpt-4o', 'gpt-4o-mini'], defaultModel: 'gpt-4o',
          keys: [
            { id: 'k1', label: '主号', set: true, mask: '…7f3a' },
            { id: 'k2', label: '备用', set: true, mask: '…9c11' },
          ],
        },
        {
          id: 'local', name: '本机 Ollama', baseUrl: 'http://127.0.0.1:11434/v1',
          provider: 'ollama', models: ['qwen2.5:7b'], defaultModel: 'qwen2.5:7b',
          keys: [],
        },
      ],
    };
    case 'llm.channels.set': return { channels: [], defaultChannel: '' };
    case 'llm.chat': return { requestId: 'sim', text: '（模拟回复）' };
    // 一条**非零**的用量：全是 0 的状态条看不出布局问题（数字位数、千分位、"今日已用 X/Y" 的
    // 折行都藏起来了）。budgetTokens 用 0（不限）——设了上限的假数据会让插件画出"要满了"。
    case 'llm.usage': return { day: '2026-11-02', requests: 3, tokensIn: 1200, tokensOut: 300, budgetTokens: 0 };
    case 'events.subscribe': return [];
    case 'ws.state': return { state: 'closed', received: 0, sent: 0 };
    case 'ws.open': return { ok: true, state: 'connecting', url: '' };
    case 'process.launch': return { pid: 4242 };
    case 'process.state': return { known: true, running: false, exitCode: 0 };
    case 'audio.list': return [];
    case 'audio.save':
    case 'audio.import': return { name: 'sim', bytes: 0 };
    case 'share.get': return { value: '', at: 0, key: '' };
    // 假宿主里没有"另一个插件"，所以这里如实模拟成"问不到"：插件应当把这句话显示出来，
    // 而不是假设一定有答案（真宿主在没有常驻帧时给的也是同一类错误）。
    case 'plugin.call': throw new Error('模拟拒绝：假宿主里没有可以被调用的插件');
    default: return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// 假宿主本体
// ---------------------------------------------------------------------------

/**
 * 造一个假宿主。它不判断权限（和真宿主一样）：`granted` 只是发给插件的**数据**，
 * 所以"权限被拒时界面会不会崩"可以用 `mode:'deny'` 直接看到。
 *
 * @param {object} o
 * @param {object} o.manifest   `{ id, permissions }`（`declared` 也认，那是自检工具里的字段名）
 * @param {string[]} [o.granted]  发给插件的已授予权限；默认空
 * @param {object} [o.surface]   init 里的 `surface`（kind/slot/rect/…）
 * @param {string} [o.theme]     init 里的主题，默认 dark
 * @param {'ok'|'deny'|'silent'} [o.mode]  ok=都答应；deny=每条都拒绝；silent=一条都不答
 * @param {function} [o.answers] `(method, payload) => result`；默认 okResult
 * @param {function} o.deliver   `(msg) => void`，把一条消息送进插件
 * @param {boolean} [o.autoRespond] 收到请求立刻回（预览页）；false 则排队，由调用方 `takePending()` 取
 */
export function createFakeHost({
  manifest = {},
  granted = [],
  surface = { kind: 'panel', slot: 'workshop' },
  theme = 'dark',
  mode = 'ok',
  answers = okResult,
  deliver = () => {},
  autoRespond = true,
} = {}) {
  const declared = manifest.permissions ?? manifest.declared ?? [];
  const seenIds = new Set();

  const host = {
    ready: false,
    requests: [],
    pending: [],
    errors: [],
    badIds: [],
    unknownMethods: [],
    unsupported: [],
    log: [],
  };

  const record = (dir, text) => host.log.push({ dir, text });

  function send(msg) {
    record('out', describe(msg));
    try {
      deliver(msg);
    } catch (err) {
      host.errors.push('dispatch: ' + String(err?.message || err));
    }
  }

  function initMessage() {
    // `host` is DERIVED from the same table `respond()` gates on, so the two can never disagree:
    // the program name comes from the slot the way the real hosts define it, and the method list
    // is exactly what this mount would accept. A hand-written list here would be a second answer
    // to "does this window serve X", which is the thing `init.host` exists to stop.
    const program = surface?.slot === 'workshop' ? 'workshop' : 'pet';
    const methods = Object.keys(METHODS)
      .filter((name) => hostServes(name, surface))
      .sort();
    return {
      v: 1, type: 'init', pluginId: manifest.id || '', permissions: [...declared],
      granted: [...granted], theme, surface,
      host: { program, methods },
    };
  }

  /** 对一条 request 造 response 并送回去。`mode:'silent'` 时调用方不该走到这里。 */
  function respond(msg) {
    // 「这个宿主没有这个方法」先于「没授权」判断，而且两种 mode 都给同一个答案：它不是权限
    // 问题，是插件选错了窗口。真宿主的文案逐字如此（`dispatchPluginRequest` /
    // `marketRegistry` 之外的那条「本程序不支持该方法」），照抄是为了让作者在日志里搜得到。
    if (!hostServes(msg.method, surface)) {
      if (!host.unsupported.includes(msg.method)) host.unsupported.push(msg.method);
      send({
        v: 1, type: 'response', id: msg.id, ok: false,
        error: `插件 ${manifest.id || '（本插件）'} 调用了本程序不支持的方法 ${msg.method}`,
      });
      return;
    }
    if (mode === 'deny') {
      send({ v: 1, type: 'response', id: msg.id, ok: false, error: `模拟拒绝：未获权限 ${METHODS[msg.method]?.perm ?? '（未知）'}` });
      return;
    }
    send({ v: 1, type: 'response', id: msg.id, ok: true, result: answers(msg.method, msg.payload) });
  }

  /** 插件发来的每一条消息都从这里进。返回值只是方便调用方链式判断。 */
  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return null;
    record('in', describe(msg));
    if (msg.v !== 1) {
      host.errors.push(`插件发来的消息 v=${JSON.stringify(msg.v)}（应为 1）`);
      return null;
    }
    if (msg.type === 'ready') {
      host.ready = true;
      send(initMessage());
      return 'ready';
    }
    if (msg.type === 'request') {
      // id 唯一非空是硬要求：同一个 id 用两次，第二个 response 会被插件当成第一个。
      if (typeof msg.id !== 'string' || msg.id === '' || seenIds.has(msg.id)) host.badIds.push(String(msg.id));
      seenIds.add(msg.id);
      if (typeof msg.method !== 'string' || !METHODS[msg.method]) host.unknownMethods.push(String(msg.method));
      host.requests.push({ id: msg.id, method: msg.method, payload: msg.payload });
      if (mode === 'silent') return 'request';
      if (autoRespond) respond(msg);
      else host.pending.push(msg);
      return 'request';
    }
    if (msg.type === 'event') return 'event';
    // 宿主以后会加消息类型；插件忽略不认识的 type 才是对的，反过来说这里也只记录。
    host.errors.push(`插件发来了宿主不认识的 type=${JSON.stringify(msg.type)}`);
    return null;
  }

  // 全是 getter：调用方拿到的是同一个对象，`host.requests` 永远是最新的那一份。
  return {
    get log() { return host.log; },
    get requests() { return host.requests; },
    get errors() { return host.errors; },
    get badIds() { return host.badIds; },
    get unknownMethods() { return host.unknownMethods; },
    get unsupported() { return host.unsupported; },
    get pending() { return host.pending; },
    get ready() { return host.ready; },
    onMessage,
    respond,
    send,
    sendInit: () => send(initMessage()),
    takePending: () => host.pending.splice(0, host.pending.length),
  };
}

function describe(msg) {
  if (!msg || typeof msg !== 'object') return String(msg);
  const bits = [String(msg.type)];
  if (msg.method) bits.push(String(msg.method));
  if (msg.id) bits.push('#' + msg.id);
  if (msg.type === 'response') bits.push(msg.ok ? 'ok' : 'error');
  if (msg.type === 'event' && msg.name) bits.push(String(msg.name));
  return bits.join(' ');
}

// ---------------------------------------------------------------------------
// 预览页专用的"像真的"的答案
// ---------------------------------------------------------------------------
//
// 自检工具用 okResult 就够（它只问"会不会崩"）。预览页问的是"这一屏长什么样"，所以 storage
// 得回**真的能渲染出界面**的数据。这些数据是插件私有的（番茄钟的 `pomodoro-state-v2`），
// 假宿主不假装认识它们——按插件 id 分表，认不出来的插件就回空字符串，界面上就是"没数据"。

/** 一段专注结束、停在"要不要写总结"那一屏（四次翻车的那个状态）。 */
export function sampleState(name = 'idle') {
  const base = {
    phase: 'focus', runState: 'running', endsAt: Date.now() + 5 * 60 * 1000,
    remainingOnHalt: 0, currentTodoId: '', currentTodoTitle: '', asking: '',
    pendingRecordId: '', focusCount: 1,
  };
  if (name === 'gate') {
    // 门开着：endsAt=0（没在跑）、remainingOnHalt 记住剩下的秒数、asking 说在等回答。
    return { ...base, runState: 'paused', endsAt: 0, remainingOnHalt: 300, asking: 'summary', pendingRecordId: 'r1' };
  }
  if (name === 'idle') return { ...base, phase: 'idle', runState: 'stopped', endsAt: 0, remainingOnHalt: 0 };
  return base;
}

/** 每个插件自己的私有存储键 → 预览时要回什么。认不出来的键一律回空串。 */
const SAMPLE_STORAGE = {
  'com.shixiansi.plugin-pomodoro': (state) => ({
    'pomodoro-state-v2': sampleState(state),
    'pomodoro-records-v2': [{ id: 'r1', endedAt: Date.now() - 60000, minutes: 5, phase: 'focus', summary: '' }],
  }),
};

/**
 * 一个记得住写入的存储，给预览页用。
 *
 * 为什么需要：真宿主是**有记忆**的。插件点完「确定」会 `storage.set` 新状态、再 `storage.get`
 * 读回来渲染；假宿主如果每次 `get` 都回同一份初始数据，界面就会弹回点之前那一屏——看起来像
 * "点了没反应"，其实是假宿主在撒谎。一个会撒谎的预览工具比没有更坏。
 */
export function createMemoryStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    get: (key) => (data.has(key) ? data.get(key) : undefined),
    set: (key, value) => { data.set(key, String(value)); },
    remove: (key) => { data.delete(key); },
    snapshot: () => Object.fromEntries(data),
  };
}

/**
 * 预览页用的答案表：在 okResult 之上，把"这个插件真的会读到什么"补上。
 *
 * `store` 与 `share` 是**同一个对象，被这个插件的两个帧共用**——那正是真宿主的形状：
 * 一个私有目录 + 一个 share 托盘，常驻帧和浮层面读写的是同一份。少了这一条，浮层面留下的
 * `command` 就永远没人读，界面上就是"点了没反应"。
 *
 * @param {string} method
 * @param {object} payload
 * @param {{ state?: string, manifest?: object, store?: object, share?: object }} ctx
 */
export function previewAnswers(method, payload, { state = 'idle', manifest = {}, store = null, share = null } = {}) {
  const keys = SAMPLE_STORAGE[manifest.id]?.(state) ?? {};
  switch (method) {
    case 'storage.get': {
      const key = (payload && payload.key) || '';
      const written = store?.get(key);           // 先看插件自己写过的，再看样本数据
      if (written !== undefined) return { value: written };
      if (key in keys) return { value: JSON.stringify(keys[key]) };
      return okResult(method);
    }
    case 'storage.set': {
      if (store && payload && typeof payload.key === 'string') store.set(payload.key, payload.value ?? '');
      return { ok: true };
    }
    case 'storage.remove': {
      if (store && payload && typeof payload.key === 'string') store.remove(payload.key);
      return { ok: true };
    }
    case 'share.get': {
      const name = (payload && payload.name) || '';
      const owner = (payload && payload.owner) || manifest.id;
      // 别人的键：预览里没有第二个插件在发布，所以只可能是"还没人发布"。
      if (owner !== manifest.id) return { value: '', at: 0, key: `${owner}/${name}` };
      const written = share?.get(name);
      if (written !== undefined) return { value: written, at: Date.now(), key: `${owner}/${name}` };
      return { value: '', at: 0, key: `${owner}/${name}` };
    }
    case 'share.set': {
      const name = (payload && payload.name) || '';
      if (share && name) share.set(name, payload.value ?? '');
      return { ok: true, key: `${manifest.id}/${name}` };
    }
    case 'share.remove': {
      const name = (payload && payload.name) || '';
      if (share && name) share.remove(name);
      return { ok: true };
    }
    case 'config.get': {
      // 清单里的默认值就是用户第一次打开时看到的样子——预览就该看到那个。
      const values = {};
      for (const item of manifest.config ?? []) {
        if (item && item.key && item.type !== 'secret' && item.default !== undefined) values[item.key] = String(item.default);
      }
      return { values, secrets: {} };
    }
    case 'llm.chat': return { requestId: 'preview', text: '（预览回复）' };
    case 'net.fetch': {
      // 假宿主不联网，所以默认只回 {ok:true}——那对"会不会崩"够用，对"成功那一屏长什么样"
      // 不够：一个上传插件只会画出错误行。这里按插件 id 点名给一份**像真的**应答，别的插件
      // 的行为一点不动（`body` 的形状就是真接口的形状，所以顺带验证了解析）。
      const make = SAMPLE_FETCH[manifest.id];
      return make ? make(payload) : okResult(method);
    }
    default: return okResult(method);
  }
}

/** 每个插件在预览里的 net.fetch 应答。没点名的一律走 okResult。 */
const SAMPLE_FETCH = {
  // 图床上传：真接口在 `responseFormat=object&returnFormat=full` 下回的就是这一条，
  // 链接里那个文件名是 2026-11-02 在真实实例上跑出来的形状。
  'com.shixiansi.plugin-imgbed': () => ({
    status: 200,
    body: JSON.stringify({ src: 'https://imgcloud.shipixiv.de5.net/file/1793637171292_simulated.png' }),
  }),
};
