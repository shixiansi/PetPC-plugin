// 剪贴板助手 —— 一个文档，五种身份，一条流水线。
//
//   boot        握手没完成                 （什么都画不出来）
//   background  常驻帧：轮询 inbox、弹询问、发 llm.chat   ← 流水线只在这里
//   ask         浮层块 0：宠物头顶的询问卡  （用户点头/摇头的地方）
//   result      浮层块 1：宠物正上的结果卡  （流式渲染的回答）
//   workshop    控制中心里的插件页         （设置 + 最近记录）
//
// 为什么流水线只住在 background：常驻帧是唯一"用户关掉界面也活着"的挂载
// （手册 §7 的送达条件）。询问与回答要发生在用户复制的那一刻，而不是面板打开的
// 那一刻。浮层帧只做两件事：把宿主共享键里的画面画出来、把用户的点按写回去。
// 帧之间没有共享内存，牌盘（plugin.share）是它们唯一的板子：
//
//   clipask/inbox   常驻帧 → 询问卡   待询问的样本（ {id, kind, text} ）
//   clipask/answer  常驻帧 → 结果卡   一次回答的状态（ {id, title, text, status} ）
//   clipask/clicks  询问卡 → 常驻帧   用户的点按（ {id, action:"yes"|"no"} ）
//   clipask/history 常驻帧 → 工坊页   最近 20 条记录（ [{at,kind,chars,summary}] ）
//   clipask/state   常驻帧 → 工坊页   运行状态（ {watcher, lastAt, note} ）
//
// 每个键只有一个写者（手册 §6.3 的"一个键只有一个写者"）：inbox/answer/history/state
// 只由常驻帧写，clicks 只由询问卡写。工坊页只读。
//
// 为什么监听剪贴板要 process.launch：宿主的能力表里没有剪贴板（手册 §4.1 是穷尽的），
// 所以"系统剪贴板"只能委托给一个插件启动的本机程序——这是语音插件连本机 TTS 的
// 同一条路。双向通信用插件私有目录里的文件：常驻帧把 clip-watch.ps1 写进
// storage.dir 给的目录，process.launch 启动 PowerShell（默认用系统自带的那个）去跑它；
// 脚本把新样本写进 inbox/，常驻帧轮询读取。脚本随包（assets），路径每次启动重写。

'use strict';

const V = 1;
const HOST = window.parent;
let nextId = 1;
const pending = new Map();

// 权限名拼一次：打错一个字母就是"控件永远禁用"且没有报错。
const PERM = {
  chat: 'llm.chat',
  borrow: 'llm.borrow',
  storage: 'storage',
  config: 'plugin.config',
  share: 'plugin.share',
  surface: 'pet.surface',
  bubble: 'pet.bubble',
  process: 'process',
};

/** 与宿主说话的唯一通道。复制这段是安全的：它就是协议本身。 */
function request(method, payload) {
  const id = 'r' + nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    HOST.postMessage({ v: V, type: 'request', id, method, payload: payload ?? {} }, '*');
  });
}

let granted = new Set();
let surfaceInfo = null;

function can(perm) {
  return granted.has(perm);
}

window.addEventListener('message', (event) => {
  if (event.source !== HOST) return;
  const data = event.data;
  if (!data || data.v !== V) return;

  switch (data.type) {
    case 'init':
      void onInit(data);
      break;
    case 'response': {
      const slot = pending.get(data.id);
      if (!slot) return; // 过期或未知的 id：丢掉，不要报错
      pending.delete(data.id);
      if (data.ok) slot.resolve(data.result);
      else slot.reject(new Error(data.error || '宿主拒绝了这次调用'));
      break;
    }
    case 'theme':
      document.documentElement.dataset.theme = data.theme === 'light' ? 'light' : 'dark';
      break;
    case 'event':
      // 宿主事件流：本插件不用 reminder/config，只关心自己的 llm 流式帧。
      dispatchEvent(data.name, data.payload);
      break;
    default:
      break;
  }
});

// ---------------------------------------------------------------------------
// 共享的小工具
// ---------------------------------------------------------------------------

function el(id) {
  return document.getElementById(id);
}

function show(node, on) {
  if (node) node.hidden = !on;
}

/** 截断到 n 字符，加省略号。展示用；不改变原文。 */
function clamp(text, n) {
  const s = String(text ?? '');
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…';
}

function now() {
  return Date.now();
}

// ---------------------------------------------------------------------------
// 共用：分类器 —— 一段文本是代码、文章，还是单词
//
// 这决定询问卡的措辞（"翻译/总结"还是"解释"），也让"分类对不对"可以单独测。
// 规则故意简单：信号明显才叫代码，宁可把代码当文章问"总结"，也不错把文章当代码问"解释"。
// ---------------------------------------------------------------------------

/** 数一数代码的踪迹：缩进块、括号密度、符号行、常见关键字、URL/路径。 */
function codeSignals(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const indented = lines.filter((l) => /^[ \t]{2,}\S/.test(l)).length;
  const brackets = (text.match(/[{}[\]()<>]/g) || []).length;
  const symbolLines = lines.filter((l) => /[;{}]|=>|::|\(\)|\+=|===?|!==/.test(l)).length;
  const keywords = (text.match(/\b(function|const|let|var|def|class|import|export|return|if|else|for|while|public|private|void|struct|package|func|fn)\b/g) || []).length;
  const pathish = (text.match(/https?:\/\/|\/[\w.-]+\/[\w.-]+|[A-Za-z]:\\[\w\\.-]+/g) || []).length;
  return { lines, indented, brackets, symbolLines, keywords, pathish };
}

/**
 * 把一段文本分类成 "code" | "word" | "text"。
 *
 * word：一段没有空白的短字符串（≤40 字符），或者 1-3 个词的短语文本（适合查词/翻译）。
 * code：多行 + 足够的代码踪迹；单行也可能是代码（一行命令、一条 URL）。
 */
function classify(text) {
  const s = String(text ?? '').trim();
  if (!s) return { kind: 'text', label: '这段内容' };
  const oneWord = !/\s/.test(s);
  if (oneWord && s.length <= 40) {
    return { kind: 'word', label: `「${clamp(s, 24)}」这个词` };
  }
  const sig = codeSignals(s);
  const isCode =
    (sig.lines.length >= 2 && sig.indented >= 1 && sig.brackets >= 4) ||
    (sig.symbolLines >= Math.max(2, sig.lines.length * 0.5) && sig.keywords >= 2) ||
    (sig.lines.length === 1 && sig.brackets >= 2 && sig.keywords >= 1);
  if (isCode) return { kind: 'code', label: '这段代码' };
  const words = s.split(/\s+/).filter(Boolean);
  // 短语也要**整体**短（中文没有空格，一整段话在这里也是"一个词"——所以限总长而非词数）。
  if (words.length <= 3 && s.length <= 24) {
    return { kind: 'word', label: `「${clamp(s, 24)}」这个短语` };
  }
  return { kind: 'text', label: '这段内容' };
}

/** 每种分类给询问卡与系统提示词用的动作表。 */
const ACTIONS = {
  code: {
    ask: '需要我解释这段代码吗？',
    verb: '解释',
    system:
      '你是一个桌宠里帮用户读代码的助手。用户复制了一段代码，请解释它：先一句话说这段代码做什么，再按关键步骤讲清楚，指出值得注意的坑。保持简短实用，不要复述整段代码。',
  },
  word: {
    ask: '需要我帮你查这个词吗？',
    verb: '查词',
    system:
      '你是一个桌宠里的查词助手。用户复制了一个词或短语，请给出简明的解释：如果是外语词，给出读音、词性与中文释义，并配一两个短语例句；如果是中文词，解释含义与常见用法。控制在几行以内。',
  },
  text: {
    ask: '需要我帮你翻译或总结这段内容吗？',
    verb: '翻译',
    system:
      '你是一个桌宠里的阅读助手。用户复制了一段文字，请先判断语言：外文就翻译成中文，中文就很短地总结要点（3-5 条，每条一句）。不要评论文风，不要展开原文没有的内容。',
  },
};

// ---------------------------------------------------------------------------
// 身份分派：这个文档是谁
// ---------------------------------------------------------------------------

let mySlot = '';
let myRectIndex = -1;

async function onInit(data) {
  granted = new Set(data.granted || []);
  surfaceInfo = data.surface || {};
  mySlot = surfaceInfo.slot || '';
  myRectIndex = Number(surfaceInfo.rectIndex ?? -1);

  const root = el('root');
  root.dataset.view = 'boot';
  root.className = 'ready';

  // kind 是 'panel' 的有两种：常驻帧与工坊页——用 slot 区分（手册 §5.2）。
  if (surfaceInfo.kind === 'surface') {
    show(el('ask'), myRectIndex === 0);
    show(el('result'), myRectIndex === 1);
    root.dataset.view = myRectIndex === 0 ? 'ask' : 'result';
    if (myRectIndex === 0) initAskFrame();
    else initResultFrame();
    return;
  }
  if (mySlot === 'background') {
    root.dataset.view = 'background';
    initBackgroundFrame();
    return;
  }
  // 工坊页（控制中心）；桌宠没有别的面板槽位。
  root.dataset.view = 'workshop';
  initWorkshop();
}

// ---------------------------------------------------------------------------
// 常驻帧：轮询 → 询问 → 回答
// ---------------------------------------------------------------------------

const SHARE = {
  inbox: 'inbox',
  answer: 'answer',
  clicks: 'clicks',
  history: 'history',
  state: 'state',
};

let cfg = {};
let helperLaunched = false;
let helperNote = '未启动';
let current = null; // 正在问/正在答的那一条：{id, kind, text, askedAt}
let processedClicks = new Set();
let pollTimer = null;
let tickBusy = false;

/** 重读设置。读不到就沿用旧值：一次 config.get 失败不该让流水线停摆。 */
async function refreshConfig() {
  if (!can(PERM.config)) return; // 没授予就别发：发了也是一句拒绝（手册 §12"granted=[] 不乱发"）
  try {
    const out = await request('config.get', {});
    cfg = Object.assign({}, (out && out.values) || {});
  } catch {
    // 沿用旧值。
  }
}

function cfgNum(key, fallback, min, max) {
  const raw = Number.parseInt(String(cfg[key] ?? ''), 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

function cfgBool(key, fallback) {
  const raw = String(cfg[key] ?? '').toLowerCase();
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return fallback;
}

function writeShare(name, value) {
  if (!can(PERM.share)) return Promise.resolve(); // 未授予就不发：同上
  return request('share.set', { name, value: JSON.stringify(value) }).catch(() => {});
}

async function readShare(name, owner) {
  if (!can(PERM.share)) return { at: 0, value: null };
  try {
    const out = await request('share.get', owner ? { owner, name } : { name });
    const at = Number(out && out.at) || 0;
    const raw = String((out && out.value) || '');
    if (!raw) return { at: 0, value: null };
    return { at, value: JSON.parse(raw) };
  } catch {
    return { at: 0, value: null };
  }
}

/**
 * 浮层面的三个动作。**`surface.show` 是这里最容易漏的一步**：`surface.blocks` 只对"已经打开的
 * 浮层面"生效（宿主侧 pluginSurfaceBlocks 的注释写着），所以不先 show，块就永远不会挂载——
 * 症状是"辅助脚本起来了、样本也处理了、share/inbox 里躺着待问的那条，界面什么也没有"。
 * 2026-10-30 用户报的就是这个：日志里能看见 `share.set`（806 B 写入了样本），但 `share.get`
 * 只在轮询 clicks，没有任何一帧在读 inbox（询问卡那一帧根本没挂载）。
 *
 * `hidden` 是**整份替换**语义，而每个帧各有一份记录——所以 grow 那两处**只发 `sizes`**：宿主把
 * 缺省的 `hidden` 当成"别动隐藏集合"。不然"结果卡长高"的请求会把自己那份空的隐藏集合发上去，
 * 把刚被藏起来的询问卡又放出来。
 */
/**
 * 让块的高度跟着内容走：**监听内容尺寸，每次变化都把最终高度报上去**。
 *
 * 为什么不用"挂载时量一次 + 节流"：那个写法有两个竞态，而且都已在真机上咬过人——
 *   1. 挂载那一刻量到的是静态占位（`…` 一行），真内容几百毫秒后才到；
 *   2. 真内容到达时的那次测量正好落在 500ms 节流窗口里，被直接丢掉，之后没有第二次机会。
 * 结果是块停在占位高度上，按钮被矩形下边缘切掉一半（2026-10-30 用户截图）。
 *
 * `ResizeObserver` 没有这个毛病：内容一变（文本落定、字体加载完、换行变化）它就回调，
 * 回调里量 `scrollHeight` 并把**当前**高度发上去。宿主的 `surface.blocks` 是"最后一条生效"，
 * 所以重复发送是安全的，反而是我们要的：发送意味着"这是现在的高度"。
 *
 * 节流保留一个小的防抖（120ms），避免一次布局变化触发十几条请求；防抖到期一定会发，
 * 所以最后那个正确的高度**不会**被丢掉——这是和"每 500ms 只准发一次、多余的丢弃"的关键区别。
 *
 * 宿主读不到沙箱帧里的内容（`allow-scripts`、没有 `allow-same-origin`），所以"宿主自己量"
 * 这条路不存在：高度只能由插件报，能做的就是保证"报的是最终值"。
 */
function autoFit(blockIndex, measure) {
  if (!can(PERM.surface)) return () => {};
  let last = 0;
  let timer = 0;

  const send = async () => {
    timer = 0;
    let want = 0;
    try {
      want = Math.ceil(measure());
    } catch {
      return;
    }
    // 量不到（元素隐藏、或测试环境里没有排版引擎）就别发荒唐的小数字：等下一次回调。
    // 宿主会把它夹进 [声明高度, maxH]，所以发错也不会画坏，但没必要污染日志。
    if (!Number.isFinite(want) || want < 16) return;
    if (want === last) return; // 没变就不打扰宿主
    last = want;
    // 记一份到自己的共享目录：日志里 surface.blocks 有 5 秒合并，"到底报了多少"会被合并掉，
    // 而这一条能从磁盘直接读（也顺便让工坊页可以说"现在这一块多高"）。
    void writeShare('fit', { block: blockIndex, h: want, at: now() });
    await request('surface.blocks', { sizes: { [blockIndex]: want } }).catch(() => {});
  };

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => void send(), 120);
  };

  void send(); // 开局立刻报一次：块刚挂载时宿主给的是声明高度，可能一屏都装不下

  const stops = [];

  // ① 内容**尺寸**变化：字体加载完、换行变化。（注意：被观察的节点如果高度由帧决定，这条永远不会
  //    触发——所以下面必须有 ②。）
  if (typeof ResizeObserver === 'function' && measure.node) {
    const ro = new ResizeObserver(schedule);
    ro.observe(measure.node);
    stops.push(() => ro.disconnect());
  }

  // ② 内容**本身**变化：`textContent` 被改写（占位 → 真句子）、行数变了但容器高度没变。
  //    `ResizeObserver` 对这类变化完全无感——2026-10-30 就栽在这里：观察的 `#ask` 是
  //    `height: 100%`，尺寸由帧决定，于是它只在开局发了一次（量到的是占位），真内容到了没人再量，
  //    块停在 56px，按钮被切掉一半。
  const root = measure.watch || measure.node;
  if (typeof MutationObserver === 'function' && root) {
    const mo = new MutationObserver(schedule);
    mo.observe(root, { childList: true, characterData: true, subtree: true, attributes: true });
    stops.push(() => mo.disconnect());
  }

  // ③ 兜底：每秒量一次，只在"算出来和上次不同"时才发。上面两个观察者任何一个漏了（引擎差异、
  //    节点被替换、字体异步落定），这一条在 1 秒内补上。一次测量是一对 scrollHeight 读取，代价
  //    可以忽略；而"用户看到被切掉一半的按钮"的代价很大。
  const poll = setInterval(schedule, 1000);
  stops.push(() => clearInterval(poll));

  return () => stops.forEach((fn) => fn());
}

async function showSurface() {
  if (!can(PERM.surface)) return;
  await request('surface.show', {}).catch(() => {});
}

async function hideSurface() {
  if (!can(PERM.surface)) return;
  await request('surface.hide', {}).catch(() => {});
}

/** 只留这些块可见：`hidden` 是声明下标数组。 */
async function focusBlocks(hidden) {
  if (!can(PERM.surface)) return;
  await request('surface.blocks', { hidden, sizes: {} }).catch(() => {});
}

/** 写一行状态给工坊页。 */
async function pushState(note) {
  helperNote = note || helperNote;
  await writeShare(SHARE.state, { watcher: helperLaunched ? 'running' : 'off', note: helperNote, at: now() });
}

async function pushHistory(entry) {
  const prev = (await readShare(SHARE.history)).value;
  const list = Array.isArray(prev) ? prev : [];
  list.unshift(entry);
  await writeShare(SHARE.history, list.slice(0, 20));
}

/**
 * 从哪个 PowerShell 起：用户填的优先，然后系统自带的那几个标准位置。
 *
 * `process.launch` **只接受绝对路径的 .exe**，而插件看不见文件系统（沙盒里没有 fs，也没有环境
 * 变量），所以这里给一串"Windows 上大概率存在"的绝对路径逐个试——宿主会替我们验证每个路径
 * 是不是真的存在（`process.launch` 的路径检查），失败的候选换下一个就行。
 *
 * 第 1 个是 Windows 10/11 一定有的 Windows PowerShell 5.1；后面两个是 PowerShell 7 的常规安装
 * 位置。用户显式配置了就只试他那个（外加这些默认值——填错时才有机会仍然跑起来，而错误信息里会
 * 带上他自己填的那个路径）。
 */
function helperCandidates() {
  const configured = String(cfg.helperPath || '').trim();
  const seen = new Set();
  return [
    configured,
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
  ].filter((p) => p && !seen.has(p) && seen.add(p));
}

/**
 * 把辅助脚本放进自己的私有目录并启动。
 *
 * 为什么每次启动都重写脚本：私有目录可能被用户"卸载并删除数据"过，包里的 assets 宿主
 * 只保证在包里、不保证已在目录里。重写一份小文本的代价可以忽略，换来的是"脚本一定在"。
 *
 * 入口路径见 `helperCandidates`：**留空就用系统自带的 PowerShell**。以前是"留空=不启动"，
 * 于是这个插件在真机上从来没工作过（默认值就是空，没人会去手敲那个路径）。
 */
async function ensureHelper() {
  if (helperLaunched) return;
  if (!can(PERM.storage) || !can(PERM.process)) {
    await pushState('缺权限：安装时需要授予 storage 与 process，监听才可用');
    return;
  }
  try {
    const dirOut = await request('storage.dir', { sub: 'clip' });
    const dir = String(dirOut && dirOut.dir) || '';
    if (!dir) throw new Error('storage.dir 没有返回目录');

    // 脚本本体随包（assets/clip-watch.ps1），但插件读不到包内文件的内容——所以把脚本
    // 以字符串常量（WATCH_SCRIPT，与本文件底部定义逐字同义）写进私有目录。写小文本的
    // 代价可以忽略，换来的是"脚本一定在"：私有目录可能被"卸载并删除数据"清空过。
    //
    // 键以 `clip/watch` 结尾而**不**是 `watch.ps1`：宿主的存储键每一段只允许
    // `[A-Za-z0-9_-]`（手册 §6.3），带点的键会被判定为非法，`storage.set` 整个不执行——
    // 于是"脚本没写进去、启动又失败"，而这个插件在真机上从来没报过错，因为没人配过
    // helperPath：这条路一次都没走过。
    await request('storage.set', { key: 'clip/watch', value: WATCH_SCRIPT });

    // 相对目录交给脚本拼；Windows 路径里的反斜杠原样传。
    const outDir = joinPath(dir, 'inbox');
    const scriptPath = joinPath(dir, 'watch');
    // 用 `[scriptblock]::Create((Get-Content …))` 而不是 `-File`：`-File` 明确要求 `.ps1`
    // 扩展名（实测：`-File` 跑无扩展名文件直接报 "does not have a '.ps1' extension"），
    // 而存储键里不能有点。这条路不挑扩展名，代价是启动参数从"一个路径"变成一行短命令，
    // 仍是 512 字符一参的上限之内（只有两个路径）。
    const runner =
      `& { $sb = [scriptblock]::Create((Get-Content -LiteralPath '${scriptPath}' -Raw)); ` +
      `& $sb -OutDir '${outDir}' }`;
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', runner];

    // 从哪个 PowerShell 起？用户填的优先，**留空就用系统自带的那个**。
    //
    // 以前这里"留空 = 不启动"，于是这个插件在真机上从来没工作过：`helperPath` 的默认值就是空，
    // 而没人会为了一个剪贴板助手去手敲 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`。
    // 症状是"装了、启用了、什么都没发生"——日志里一次 `process.launch` 都没有，只有每个挂载周期
    // 的 `config.get` 与 `share.get`（2026-10-30 用户报的）。
    //
    // 逐个试是因为插件看不见文件系统（沙盒、没有 fs）：`process.launch` 会替我们验证"这个绝对
    // 路径是不是一个存在的 .exe"，失败的候选直接试下一个。用户显式填了却不存在时，报错里会带
    // 上他填的那个路径——那才是他要改的东西。
    const tried = [];
    let launched = '';
    for (const exe of helperCandidates()) {
      try {
        await request('process.launch', { path: exe, args });
        launched = exe;
        break;
      } catch (err) {
        tried.push(`${exe}（${err && err.message ? err.message : err}）`);
      }
    }
    if (!launched) {
      await pushState(`启动剪贴板监听失败：没有可用的 PowerShell。试过 ${tried.join('；')}`);
      return;
    }
    helperLaunched = true;
    await pushState(`已启动剪贴板监听（${launched}）`);
  } catch (err) {
    await pushState(`辅助脚本没启动：${String(err && err.message ? err.message : err)}`);
  }
}

/** 简单的 Windows 路径拼接（插件只跑在桌面宿主上）。 */
function joinPath(dir, name) {
  const d = String(dir || '').replace(/[\\/]+$/, '');
  return `${d}\\${name}`;
}

/**
 * 把一个新样本变成询问。
 *
 * 防打扰的三道闸：冷却（同样的内容 120s 内不重问）、长度上限（超长不问）、
 * 一次只问一条（上一条没答完，新的进队列覆盖待答位）。
 */
async function offerSample(text) {
  const verdict = classify(text);
  const cooldownMs = cfgNum('askCooldownSec', 120, 0, 3600) * 1000;
  const maxChars = cfgNum('askMaxChars', 6000, 0, 20000);
  if (maxChars > 0 && text.length > maxChars) return;

  const seenAt = recentOffers.get(verdict.kind === 'word' ? text : hashOf(text));
  if (seenAt && now() - seenAt < cooldownMs) return;

  if (current) {
    // 上一条还没被处理（用户没点头也没摇头）：直接替换。剪贴板是"最新的意图"。
    if (current.answered) return; // 已在回答中：不打断
    current = null;
  }

  const id = `s${now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  recentOffers.set(verdict.kind === 'word' ? text : hashOf(text), now());
  current = { id, kind: verdict.kind, text, askedAt: now(), answered: false };

  await writeShare(SHARE.inbox, {
    id,
    kind: verdict.kind,
    label: verdict.label,
    actions: actionsFor(verdict.kind),
    text: clamp(text, 8000),
    at: now(),
  });
  // 先把样本放进信箱，再开浮层面：块一挂载就立刻读信箱，顺序反了会漏掉这一条。
  await showSurface();
  await focusBlocks([1]); // 只留询问卡（块 0）；结果卡此刻没内容，白占一块矩形
}

function actionsFor(kind) {
  const a = ACTIONS[kind] || ACTIONS.text;
  return [a.verb];
}

/** 稳定的小哈希（冷却判断用；避免把整段长文当 Map 键）。 */
function hashOf(text) {
  const s = String(text);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h);
}

const recentOffers = new Map(); // 内容指纹 → 上次询问时刻

/**
 * 处理询问卡点回来的答案。
 *
 * clicks 是询问卡写的、常驻帧读的：每次 tick 读一次，按 id 去重
 * （share.get 返回整个值，同样的 {id} 会被读到多次）。
 */
async function handlePoll() {
  const clicks = await readShare(SHARE.clicks);
  const list = Array.isArray(clicks.value) ? clicks.value : [];
  const fresh = list.filter((c) => c && c.id && !processedClicks.has(c.id));
  for (const c of fresh) {
    processedClicks.add(c.id);
    if (c.action === 'yes') await answerCurrent(c.id);
    else if (current && c.id === current.id) {
      current = null;
      await writeShare(SHARE.inbox, { id: '', kind: '', label: '', actions: [], text: '', at: now() });
    }
  }
  if (processedClicks.size > 200) processedClicks = new Set([...processedClicks].slice(-50));
}

/** 用户点头：发起一次 llm.chat，流式写进 answer 键。 */
async function answerCurrent(id) {
  if (!current || current.id !== id) return;
  if (!can(PERM.chat)) {
    await writeShare(SHARE.answer, {
      id, title: '剪贴板', status: '未获授权：llm.chat', text: '', done: true, at: now(),
    });
    return;
  }
  const verdict = ACTIONS[current.kind] || ACTIONS.text;
  current.answered = true;

  const requestId = `clip-${current.id}`;
  const chineseCode = cfgBool('codeExplain', true);
  const system = verdict.system + (current.kind === 'code' && chineseCode ? '请用中文回答。' : '');
  const body = clamp(current.text, 4000);

  await writeShare(SHARE.answer, {
    id: current.id,
    title: verdict.verb,
    status: '思考中…',
    text: '',
    done: false,
    at: now(),
  });

  try {
    await request('llm.chat', {
      text: body,
      system,
      requestId,
      history: [],
      // 点名渠道（用户在工坊页配的 provider/channel）；都留空时由宿主按默认顺序借用。
      ...(String(cfg.provider || '').trim() ? { provider: String(cfg.provider).trim() } : {}),
      ...(String(cfg.channel || '').trim() ? { channel: String(cfg.channel).trim() } : {}),
      tools: [],
    });
    // 回复不会写进任何转写：llm.delta/done/error 事件由本帧接收（发起者本人），
    // 在 onEvent 里拼装。这里不 await 结果——协议是"发出去，等事件"。
  } catch (err) {
    current = null;
    await writeShare(SHARE.answer, {
      id, title: verdict.verb, status: '', text: '', done: true,
      error: String(err && err.message ? err.message : err),
      at: now(),
    });
  }
}

/** llm 流式事件（只有发起者能收到）→ 写进 answer 键。 */
async function onLlmEvent(name, payload) {
  if (!payload || typeof payload.requestId !== 'string') return;
  if (!current || payload.requestId !== `clip-${current.id}`) return;
  const title = (ACTIONS[current.kind] || ACTIONS.text).verb;

  if (name === 'llm.delta') {
    answerText += String(payload.text || '');
    await writeShare(SHARE.answer, {
      id: current.id, title, status: '', text: answerText, done: false, at: now(),
    });
    return;
  }
  if (name === 'llm.done') {
    answerText = String(payload.text || answerText);
    await pushHistory({ at: now(), kind: current.kind, chars: current.text.length, ok: true });
    const doneId = current.id;
    current = null;
    await writeShare(SHARE.answer, { id: doneId, title, status: '', text: answerText, done: true, at: now() });
    await writeShare(SHARE.inbox, { id: '', kind: '', label: '', actions: [], text: '', at: now() });
    return;
  }
  if (name === 'llm.error') {
    await pushHistory({ at: now(), kind: current.kind, chars: current.text.length, ok: false });
    const errId = current.id;
    current = null;
    await writeShare(SHARE.answer, {
      id: errId, title, status: '', text: '', done: true,
      error: String(payload.message || '模型调用失败'),
      at: now(),
    });
  }
}

let answerText = '';

/** 常驻帧的入口：订阅不到宿主事件（没有需要的），只需要自己的节拍器。 */
function initBackgroundFrame() {
  void (async () => {
    await refreshConfig();
    // events 权限虽然申请了（background 的依据之一），但宿主事件里没有剪贴板——
    // 不订阅不会丢任何东西。这里仅把 llm 流式事件通道说明在状态里。
    await ensureHelper();
    await pushState('运行中：等一次复制');
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => void tick(), 1200);
  })();
}

/** 一拍：读设置的变化、确保脚本在、轮询 clicks、处理 inbox 溢出。 */
async function tick() {
  if (tickBusy) return;
  tickBusy = true;
  try {
    await refreshConfig();
    await ensureHelper();
    await handlePoll();
    await harvestInbox();
  } catch {
    // 一拍失败不致命：下一拍重来。
  } finally {
    tickBusy = false;
  }
}

/**
 * 把辅助脚本落下的新样本收进来。
 *
 * 脚本往 clip/inbox/ 里写 <时间戳>-<随机>.txt（正文就是剪贴板原文）；常驻帧读不到
 * 私有目录的文件列表——所以脚本同时维护一个 inbox/latest（无扩展名，每次落盘覆盖写），
 * 这里只轮询这一个键——**名字必须逐字相同**，见 Publish-Latest 上方的注释。两个写者（脚本写 latest、插件处理完记 seenAt）之间用
 * "文件 mtime 语义"的替代品：latest 里带脚本自己盖的时间戳，插件按时间戳去重。
 */
async function harvestInbox() {
  if (!can(PERM.storage)) return;
  const out = await request('storage.get', { key: 'clip/inbox/latest' }).catch(() => ({ value: '' }));
  const raw = String((out && out.value) || '');
  if (!raw) return;
  let sample;
  try {
    sample = JSON.parse(raw);
  } catch {
    return; // 写到一半：下一拍再读。
  }
  if (!sample || !sample.at || !sample.text) return;
  if (sample.at <= lastHarvestAt) return;
  lastHarvestAt = sample.at;
  await offerSample(String(sample.text));
}

let lastHarvestAt = 0;

// 常驻帧收到事件（llm.delta 等）的分派：message 监听器里 event 分支调它。
function dispatchEvent(name, payload) {
  if (name === 'llm.delta' || name === 'llm.done' || name === 'llm.error') {
    void onLlmEvent(name, payload);
  }
}

// ---------------------------------------------------------------------------
// 询问卡（浮层块 0）
// ---------------------------------------------------------------------------

function initAskFrame() {
  const yes = el('ask-yes');
  const no = el('ask-no');
  yes.disabled = true;
  no.disabled = true;
  void pollInbox();
  setInterval(() => void pollInbox(), 1000);

  yes.addEventListener('click', () => void sendClick('yes'));
  no.addEventListener('click', () => void sendClick('no'));

  // 光等"内容变化"不够：**初始那版静态内容就已经装不下**——标签 + 问话占位 + 两个按钮实测 50px，
  // 而块 0 声明 44px，于是从挂载那一刻起下沿就被裁着。所以开局先量一次。
  autoFit(0, Object.assign(() => Math.min(152, Math.ceil(el('ask').scrollHeight + 2)), { node: el('ask') }));
}

async function pollInbox() {
  const out = await readShare(SHARE.inbox);
  const v = out.value;
  if (!v || !v.id || v.id === askedId) return;
  askedId = v.id;
  el('ask-kind').textContent = v.label || '这段内容';
  el('ask-text').textContent = v.actions && v.actions.length ? `需要我帮你${v.actions[0]}吗？` : '需要我看一眼吗？';
  el('ask-yes').disabled = false;
  el('ask-no').disabled = false;
  // 内容换了一句更长得多的问话，块高就得跟着变——**必须强制重量**。
  //
  // 挂载时那次测量量到的是静态占位（`…` 一行），真内容在 500ms 内到达；用普通节流的话这次
  // 调用会被直接吞掉，而且之后不会再有人量——块就停在"占位那一行"的高度上，两个按钮被卡片
  // 下边缘切掉一半（2026-10-30 用户截图就是这个）。
  // 160ms 再补一次：字体/换行落定后高度可能还会变一点，只量一次容易短一截。

}

let askedId = '';

async function sendClick(action) {
  el('ask-yes').disabled = true;
  el('ask-no').disabled = true;
  const out = await readShare(SHARE.inbox);
  const v = out.value;
  if (!v || !v.id) return;
  const prev = (await readShare(SHARE.clicks)).value;
  const list = Array.isArray(prev) ? prev : [];
  list.push({ id: v.id, action, at: now() });
  await writeShare(SHARE.clicks, list.slice(-40));
  // 点完即清空自己的画面：回答出现在另一块浮层里。
  el('ask-kind').textContent = '这段内容';
  el('ask-text').textContent = action === 'yes' ? '好，想想…' : '好的，先不问。';
  if (action === 'yes') await focusBlocks([0]); // 询问卡让位给结果卡
  else await hideSurface();                     // 不问就没有第二块要显示
}

// ---------------------------------------------------------------------------
// 结果卡（浮层块 1）
// ---------------------------------------------------------------------------

function initResultFrame() {
  el('result-close').addEventListener('click', () => {
    show(el('result'), false);
    // 关掉就得把浮层面也收起来：块只是"不再显示"，它那块矩形还在，仍然会吞掉桌面点击
    // （宿主侧 pluginSurfaceBlocks 的注释写着这件事）。
    void hideSurface();
  });
  autoFit(1, Object.assign(() => {
    const card = document.querySelector('.result-card');
    const body = card && card.querySelector('.result-body');
    if (!body) return 0;
    const chrome = Math.max(0, card.clientHeight - body.clientHeight);
    // 上限写死的理由：宿主只允许块长到 manifest 的 `maxH`，而这一块的几何天花板更低——
    // 宠物头顶到窗口上边缘只有 petY（默认 160px），`dy=-60 + h=60` 的底边正好落在头顶，
    // 所以 156 已经是能给的最大值。超过它的请求会被宿主夹回去并留一条 WARN，日志里每次都是
    // "请求 308px，超过声明的 maxH=156px"，而那 308px 是**内容**高度，不是窗口能给的。
    // 超出部分本来就该在正文里滚动（`.result-body` 有 overflow: auto）。
    return Math.min(156, Math.ceil(body.scrollHeight + chrome + 2));
  }, {
    node: document.querySelector('.result-body'),
    // 观察整张卡：正文一变（占位 → 真回答）就重新量。`.result-body` 自己是 `flex: 1`，
    // 高度由帧决定，只盯它的话 ResizeObserver 永远不会触发。
    watch: document.querySelector('.result-card'),
  }));

  void pollAnswer();
  setInterval(() => void pollAnswer(), 700);
}

let answerId = '';

async function pollAnswer() {
  const out = await readShare(SHARE.answer);
  const v = out.value;
  if (!v || !v.id || (v.id === answerId && v.done && answerDoneShown)) return;
  if (v.id !== answerId) {
    answerId = v.id;
    answerDoneShown = false;
    show(el('result'), true);
  }
  el('result-title').textContent = v.title || '剪贴板';
  const err = v.error ? String(v.error) : '';
  el('result-status').textContent = err ? '' : (v.status || (v.done ? '' : '…'));
  // 内容比这块矩形高时明说一句：静默截断看起来就是"被切掉了"，而它其实是能滚的。
  if (v.done && !err) {
    const body = document.querySelector('.result-body');
    if (body && body.scrollHeight > body.clientHeight + 2) {
      el('result-status').textContent = '滚动看全文';
    }
  }
  // `trim()`：模型经常以空行开头（实测回答是 `\n\n\`eventPluginEvent\` 是…`），而正文是
  // `white-space: pre-wrap`，行首的空行会被如实渲染成一片空白——看起来像"卡片上方少画了东西"。
  // 只去首尾，内部换行与缩进一律保留（那是代码块和列表的结构）。
  el('result-body').textContent = err ? `出了点问题：${err}` : String(v.text || '…').trim();
  if (v.done) answerDoneShown = true;
  // 同询问卡：正文是在挂载之后才到的，节流会把这次测量吞掉，卡片就停在旧高度。

}

let answerDoneShown = false;

// ---------------------------------------------------------------------------
// 工坊页（控制中心）：设置 + 最近记录
// ---------------------------------------------------------------------------

function initWorkshop() {
  const ids = ['helperPath', 'provider', 'channel', 'askCooldownSec', 'askMaxChars', 'llmDailyBudget'];
  const badge = el('ws-badge');
  const status = el('ws-status');

  void (async () => {
    await refreshConfig();
    el('cfg-helperPath').value = String(cfg.helperPath || '');
    el('cfg-provider').value = String(cfg.provider || '');
    el('cfg-channel').value = String(cfg.channel || '');
    el('cfg-askCooldownSec').value = String(cfgNum('askCooldownSec', 120, 0, 3600));
    el('cfg-askMaxChars').value = String(cfgNum('askMaxChars', 6000, 0, 20000));
    el('cfg-llmDailyBudget').value = String(cfgNum('llmDailyBudget', 200, 1, 2000));
    el('cfg-codeExplain').checked = cfgBool('codeExplain', true);

    // 工坊页被控制中心托管：它不服务 surface/llm——诚实显示"这件事在桌宠上"。
    const state = await readShare(SHARE.state);
    const s = state.value || {};
    if (can(PERM.surface) && can(PERM.chat)) {
      badge.textContent = s.watcher === 'running' ? '监听中' : '待命';
      badge.className = `tag ${s.watcher === 'running' ? 'ok' : 'warn'}`;
      status.textContent = s.note || '桌宠在运行时这里显示监听状态。';
    } else {
      badge.textContent = '缺权限';
      badge.className = 'tag warn';
      status.textContent = '安装时没有授予 process / llm.chat / pet.surface：监听与询问在桌宠上不可用。';
    }
    await renderHistory();
  })();

  el('ws-clear').addEventListener('click', () => void clearHistory());

  el('root').addEventListener('submit', (e) => e.preventDefault());

  // 保存：任何一项改动都整体重写 values（config.set 只接受声明过的键）。
  for (const id of ids) {
    el(`cfg-${id}`).addEventListener('change', () => void saveConfig());
  }
  el('cfg-codeExplain').addEventListener('change', () => void saveConfig());
}

async function saveConfig() {
  const values = {
    helperPath: el('cfg-helperPath').value.trim(),
    provider: el('cfg-provider').value.trim(),
    channel: el('cfg-channel').value.trim(),
    askCooldownSec: String(Math.max(0, Number.parseInt(el('cfg-askCooldownSec').value, 10) || 0)),
    askMaxChars: String(Math.max(0, Number.parseInt(el('cfg-askMaxChars').value, 10) || 0)),
    llmDailyBudget: String(Math.max(1, Number.parseInt(el('cfg-llmDailyBudget').value, 10) || 200)),
    codeExplain: el('cfg-codeExplain').checked ? 'true' : 'false',
  };
  try {
    await request('config.set', { values });
    await refreshConfig();
    cfg = Object.assign({}, cfg, values);
    el('ws-status').textContent = '已保存。桌宠端下次询问生效。';
  } catch (err) {
    el('ws-status').textContent = `没保存上：${String(err && err.message ? err.message : err)}`;
  }
}

async function renderHistory() {
  const out = await readShare(SHARE.history);
  const list = Array.isArray(out.value) ? out.value : [];
  const box = el('ws-history');
  el('ws-history-sub').textContent = list.length ? `最近 ${list.length} 条（最多留 20 条）` : '还没有记录';
  box.textContent = '';
  for (const h of list) {
    const row = document.createElement('div');
    row.className = 'history-row';
    const when = new Date(Number(h.at) || 0).toLocaleString('zh-CN', { hour12: false });
    row.textContent = `${when} · ${h.kind === 'code' ? '代码' : h.kind === 'word' ? '查词' : '翻译/总结'} · ${h.chars} 字 · ${h.ok ? '已回答' : '失败'}`;
    box.appendChild(row);
  }
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = '复制一段代码、文章或单词，桌宠头顶会弹出询问卡。';
    box.appendChild(empty);
  }
}

async function clearHistory() {
  await writeShare(SHARE.history, []);
  await renderHistory();
}

// HOST 的事件分派也要进常驻帧的 llm 处理：message 监听器的 event 分支调用 dispatchEvent
//（见文件顶部）。下面是 WATCH_SCRIPT：与包内 clip-watch.ps1 逐字同义的字符串常量。
// 插件读不到自己包里的文件内容，所以脚本以这份字符串进私有目录（见 ensureHelper）。
// 两处必须同步改：改了 clip-watch.ps1 就改这里，反之亦然——tests/ 里有守卫。
const WATCH_SCRIPT = String.raw`param(
    [Parameter(Mandatory = $true)][string]$OutDir,
    [int]$IntervalMs = 600,
    [int]$MaxChars = 20000
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $OutDir -PathType Container)) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

Add-Type -AssemblyName System.Windows.Forms | Out-Null

$last = ''
$stall = 0
$lastSkip = 0

function Write-Utf8NoBom {
    param([string]$Path, [string]$Text)
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $utf8)
}

function Publish-Latest {
    param([string]$Text)
    $payload = @{
        at   = [System.DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        text = $Text
    } | ConvertTo-Json -Compress
    $tmp = Join-Path $OutDir 'latest.tmp'
    Write-Utf8NoBom -Path $tmp -Text $payload
    # The file name must match the storage key the plugin polls, character for character:
  # clip/inbox/latest, with NO extension. A key segment only allows [A-Za-z0-9_-], so a
  # .txt name can never be read back - and the script writes by absolute path, so nothing
  # complains: the plugin just never sees a sample. (2026-10-30: latest.txt vs latest.)
  # Keep this whole script ASCII: it is launched with Get-Content -Raw under Windows
  # PowerShell 5.1, which decodes a BOM-less file as the ANSI code page and can eat a
  # quote or a newline in the middle of a multi-byte comment. (AGENTS.md section 7.)
  Move-Item -LiteralPath $tmp -Destination (Join-Path $OutDir 'latest') -Force
}

while ($true) {
    Start-Sleep -Milliseconds ([Math]::Max(100, $IntervalMs))

    $text = $null
    try {
        if ([System.Windows.Forms.Clipboard]::ContainsText()) {
            $text = [System.Windows.Forms.Clipboard]::GetText()
        }
    }
    catch {
        $text = $null
    }

    if ([string]::IsNullOrEmpty($text)) { continue }
    if ($text -ceq $last) { continue }
    $last = $text

    if ($text.Length -gt $MaxChars) {
        # Too long for the ask flow: publish an empty sample so the plugin sees that
        # something was skipped (throttled by $lastSkip).
        if (([System.DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $lastSkip) -gt 30000) {
            $lastSkip = [System.DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            try { Publish-Latest -Text '' } catch { }
        }
        continue
    }

    try {
        Publish-Latest -Text $text
        $stall = 0
    }
    catch {
        $stall += 1
        if ($stall -gt 20) { Start-Sleep -Seconds 5 }
    }
}
`;

// **监听器装好之后**才握手：init 可能在你 post 完的下一个任务就到达（手册 §5.3 铁律 1）。
HOST.postMessage({ v: V, type: 'ready' }, '*');

// 测试探针：tests/ 通过它取模块作用域里的纯函数与节拍器（不用等真实定时器）。
// 不承载任何运行时状态：classify 是纯函数，__tick/__poll 就是各自的轮询拍。
if (typeof window !== 'undefined') {
  window.__test_probe = {
    classify, ACTIONS, WATCH_SCRIPT, tick, offerSample, refreshConfig,
    pollInbox, pollAnswer, sendClick,
  };
}
