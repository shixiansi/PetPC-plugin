# PetPC 插件开发手册（独立版）

> **读者**：一个**没有、也不需要**看过宿主源码的模型或开发者。
> 本文是全部契约：manifest 的每个字段、桥的每条消息、每个能力方法的 payload 与返回、
> 几何与主题的规则、打包与发布的格式。按本文写出来的东西宿主就能跑。
>
> 本文不含宿主内部实现细节，也不要求读者拥有宿主代码。**本文列出的就是全部**：
> 没有列在这里的方法、权限或事件，宿主不认。
>
> 文中的大小限制、字段名、正则、状态字符串都是从当前实现里逐条核对过的；如果某个数字
> 与你手上的别处资料冲突，以本文为准，并把它当作宿主版本更新的信号。

---

## 0. 六十秒摘要

- 一个插件是一个 **zip**，根目录下有 `manifest.json`、一个 HTML 入口、以及它自己的
  JS/CSS/资源。
- 宿主管一个 **沙箱 iframe**（`sandbox="allow-scripts"`，**没有** `allow-same-origin`），
  文档从 `/plugin-asset/<插件id>/<入口路径>` 加载。
- 文档与宿主只通过 **`postMessage`** 说话：插件发 `ready` 协议，宿主回 `init`，之后插件发
  `request`、宿主回 `response`，宿主会推 `event`。
- 每个能力调用都过**一道权限闸门**：插件必须在 manifest 里**申请**、用户必须在安装时**授予**。
  没授予的调用**什么都不做**，只返回一句原因。
- 插件拿不到 DOM、`localStorage`、`Cookie`、文件系统路径、密钥明文、任意网络地址。
  它需要的一切都必须通过下文的**能力方法**，而这些方法都有明确的上限。

---

## 1. 运行模型

```
桌面宿主进程（"桌宠" 或 "控制中心"）
├── 窗口 / 区域裁剪 / 托盘 / 菜单         ← 宿主的事，插件碰不到
├── 权限闸门（唯一入口）                  ← 每一次插件请求都过这里
│     └─ 能力方法：storage / audio / net.fetch / llm.chat / …
└── 沙箱 iframe（每个插件可以挂多个）
      └── 你的 HTML 文档（opaque origin）
            你只能：改自己的 DOM、收 postMessage、发 postMessage
```

**同一次安装里可能同时存在多个"你"**：

| 挂载 | 什么时候 | 数量 |
| --- | --- | --- |
| `surface` 的一块 | 用户让你显示浮层面时 | manifest 每声明一块就是一个文档 |
| `panel` | 宿主把你挂在某个固定槽位（今天只有"对话"槽） | 一个 |
| `background` | 插件声明 `background` 且用户授予了相应权限时，**常驻**但不显示 | 一个 |
| `workshop` | 用户在**控制中心**打开你的插件页时 | 一个 |

多个挂载之间**没有共享内存**，它们是彼此独立的文档、独立的 iframe。要传递数据只能：
`storage.*`（自己读写自己的文件）、`plugin.share`（发布/订阅明文键值）、或 `init` 里宿主告诉你的事。

> 这条事实决定了大量设计：一个"输入框"浮层与一个"回答"浮层是两个文档，
> 想知道对方在干什么，只能靠 `storage` 或 `plugin.share` 往返。

### 三种"界面落点"，至少要有一种

`entry` 这个 HTML 文件必须"有人会加载它"，所以 manifest 至少要声明下面三项之一，
否则打包校验会拒绝（「插件至少要有一个界面落点」）：

1. `panel: true` + `panelSlot`（占用宿主的一个固定槽位，今天只有 `chat`）；
2. 至少一块 `surface`（宠物旁边的浮层矩形）；
3. `background: true`（常驻帧；要求同时申请 `events` / `net.ws` / `net.fetch` 之一）。

---

## 2. 一个能跑的最小插件

四个文件，放在同一个目录里（打包时压到 zip 根目录，**不要**多包一层文件夹）：

```
manifest.json
panel.html
app.js
style.css
```

### `manifest.json`

```json
{
  "id": "com.example.hello",
  "name": "打招呼插件",
  "version": "1.0.0",
  "author": "你的名字",
  "description": "在桌宠旁边弹一句话，并记住按过几次。",
  "permissions": ["pet.bubble", "storage", "pet.surface"],
  "surface": [{ "dx": 160, "dy": -160, "w": 320, "h": 220, "radius": 12 }],
  "entry": "panel.html"
}
```

要点：`id` 是**反向域名式的小写标识**（`^[a-z0-9]+(\.[a-z0-9][a-z0-9-]*)+$`，≤96 字符）；
`version` 是语义化版本（`1.0.0`，可带 `-beta.1` 预发布后缀）。

### `panel.html`

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>打招呼</title>
  <script>
    // 主题要在样式之前应用：两个宿主都会把 ?theme=light|dark 放在帧地址上
    // （桌宠按它自己的卡片配色，控制中心按它的主题），否则首帧会闪一下深色。
    (function () {
      var t = new URLSearchParams(location.search).get('theme');
      if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    })();
  </script>
  <link rel="stylesheet" href="./style.css" />
</head>
<body id="root" data-surface="boot">
  <header class="bar"><span class="title">打招呼</span><span id="status" class="status">等待宿主初始化…</span></header>
  <main class="body">
    <p id="count" class="count">还没按过</p>
    <button id="say" class="btn primary" disabled>让桌宠说一句</button>
    <button id="show" class="btn" disabled>在桌宠旁边显示</button>
  </main>
  <script type="module" src="./app.js"></script>
</body>
</html>
```

### `app.js`

```js
// 与宿主说话的唯一通道。复制这段是安全的：它就是协议本身。
const V = 1;
const HOST = window.parent;
let nextId = 1;
const pending = new Map();   // requestId -> {resolve, reject}
let granted = new Set();
let surfaceInfo = null;      // init.surface
let helloCount = 0;

function request(method, payload) {
  const id = 'r' + nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    HOST.postMessage({ v: V, type: 'request', id, method, payload: payload ?? {} }, '*');
  });
}

window.addEventListener('message', (event) => {
  // 只认父窗口；只认本协议版本。
  if (event.source !== HOST) return;
  const data = event.data;
  if (!data || data.v !== V) return;

  switch (data.type) {
    case 'init':
      void onInit(data);
      break;
    case 'response': {
      const slot = pending.get(data.id);
      if (!slot) return;                    // 过期或未知的 id：丢掉，不要报错
      pending.delete(data.id);
      if (data.ok) slot.resolve(data.result);
      else slot.reject(new Error(data.error || '宿主拒绝了这次调用'));
      break;
    }
    case 'theme':
      // 控制中心里用户切换了深/浅色。
      document.documentElement.dataset.theme = data.theme === 'light' ? 'light' : 'dark';
      break;
    case 'event':
      // 你订阅过事件才会收到；见第 7 节。
      break;
    default:
      break;
  }
});

async function onInit(data) {
  granted = new Set(data.granted || []);
  surfaceInfo = data.surface || {};
  document.getElementById('root').dataset.surface = surfaceInfo.kind || 'panel';
  document.getElementById('root').className = 'ready';

  // 没授予的能力，控件就别装成能用。
  const canSay = granted.has('pet.bubble');
  const canShow = granted.has('pet.surface') && (data.permissions || []).includes('pet.surface');
  document.getElementById('say').disabled = !canSay;
  document.getElementById('show').disabled = !canShow;

  if (granted.has('storage')) {
    const saved = await request('storage.get', { key: 'hello-count' }).catch(() => ({ value: '' }));
    helloCount = Number.parseInt(String(saved?.value || '0'), 10) || 0;
    paint();
  }
  // background 帧和还没接管的界面都先这么显示
  document.getElementById('status').textContent = canSay ? '已就绪' : '未获授权：pet.bubble';
  // 只有在 surface 挂载里才需要（见第 8 节）
  if (surfaceInfo.kind === 'surface') console.log('这一块是 surface#' + surfaceInfo.rectIndex);
}

function paint() {
  document.getElementById('count').textContent = helloCount
    ? `已经说了 ${helloCount} 次`
    : '还没按过';
}

document.getElementById('say').addEventListener('click', async () => {
  try {
    await request('bubble.say', { text: `你好，这是第 ${helloCount + 1} 次。` });
    helloCount += 1;
    paint();
    if (granted.has('storage')) {
      await request('storage.set', { key: 'hello-count', value: String(helloCount) });
    }
  } catch (err) {
    document.getElementById('status').textContent = '失败了：' + err.message;
  }
});

document.getElementById('show').addEventListener('click', async () => {
  try {
    await request('surface.show');   // 打开 manifest 里声明的那块浮层面
  } catch (err) {
    document.getElementById('status').textContent = '打不开：' + err.message;
  }
});

// **监听器装好之后**才握手：init 可能在你 post 完的下一个任务就到达。
HOST.postMessage({ v: V, type: 'ready' }, '*');
```

### `style.css`

```css
:root {
  --bg: #191b21;
  --text: #e8eaf0;
  --muted: #9aa3b2;
  --line: #2c313c;
  --accent: #2f6feb;
  /* 配色声明是给原生控件（滚动条、光标、下拉）用的，不影响你自己的颜色。 */
  color-scheme: dark;
}
html[data-theme='light'] {
  --bg: #ffffff;
  --text: #16202e;
  --muted: #5b6779;
  --line: #d6dde9;
  --accent: #2f6bea;
  color-scheme: light;
}
/* 画布必须透明：浮层面的矩形之外，宿主窗口是透出桌面的。 */
:root { background: transparent; color-scheme: only light; }

* { box-sizing: border-box; }
body {
  margin: 0; padding: 12px; height: 100%;
  display: flex; flex-direction: column; gap: 10px;
  background: var(--bg); color: var(--text);
  font: 13px/1.5 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
}
body[data-surface='boot'] { background: transparent; }
.bar { display: flex; align-items: baseline; gap: 8px; }
.title { font-weight: 600; }
.status { flex: 1; text-align: right; color: var(--muted); font-size: 12px; }
.body { display: flex; flex-direction: column; gap: 8px; }
.count { margin: 0; color: var(--muted); }
.btn {
  padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px;
  background: #232733; color: inherit; font: inherit; cursor: pointer;
}
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn:disabled { opacity: .4; cursor: not-allowed; }
```

**这三个文件之外**，你还需要一件事：让宿主认识这个插件（见下一节）。

---

## 3. 本地开发与手工安装（不需要任何市场界面）

宿主的数据目录是 `%AppData%\PetPC`（可用环境变量 `PETPC_DATA_DIR` 指到别处，
便于做隔离测试）。装一个插件 = 两样东西：

1. 文件放进 `%AppData%\PetPC\plugins\<插件id>\`（`manifest.json` 与其它文件**平铺**在这里）；
2. 在 `%AppData%\PetPC\plugins.json` 里加一条索引：

```json
{
  "version": 1,
  "plugins": [
    {
      "id": "com.example.hello",
      "version": "1.0.0",
      "enabled": true,
      "granted": ["pet.bubble", "storage", "pet.surface"],
      "installedAt": "2026-10-28T08:00:00Z"
    }
  ]
}
```

规则：

- `granted` 必须是 manifest `permissions` 的**子集**——这就是"用户授予了哪些"。开发时
  为了省事可以全给，**发布时**必须回到"用户会自己勾"的假设上。
- `enabled: false` 的插件不运行、不挂帧、事件也收不到（这是最快的"关掉它"开关）。
- 改完 `plugins.json` 或文件后**重启宿主程序**；索引与 manifest 都是每次读盘，但帧只在
  打开/重启时重建。
- 索引损坏会被隔离成 `plugins.json.bak`，插件列表变空——那是"文件写坏了"，不是插件的问题。
- **manifest 版本与索引版本**不一致时，插件页会显示不匹配；开发时保持两者一致最省心。

调试：

- 桌面宿主（桌宠）的窗口没有开发者工具；**控制中心的插件页**能给你一个可调试的窗口：
  在那里选中你的插件，右侧就是你的文档（`surface.slot === 'workshop'`）。
- 宿主两个程序都写日志（`%AppData%\PetPC\logs\pet.log` 与 `logs\market.log`），
  控制中心左栏的**日志**页能按等级/子系统/关键词筛。**每一次插件请求都有一行**
  （方法、payload 字节数、返回字节数、耗时、结果或错误原文）——排错先看它。
  等级由方法决定：**动作**（气泡 / 浮层 / 音频 / 模型 / 网络 / 进程 / 订阅）记 `INFO`，
  **读写你自己的数据**（`storage.*` / `share.*` / `config.*` / `memory.*`）记 `DEBUG`，
  失败一律 `WARN`。同一方法 5 秒内的重复会**合并成一行并带次数**（`同类另有 N 次已合并`），
  所以不要拿它当调用计数器。
- `response` 的 `error` 是宿主自己写的中文句子（如 `插件 X 未获权限 llm.chat`），
  把它显示出来，不要翻译成"出错了"。

---

## 4. `manifest.json` 参考

### 顶层字段

| 字段 | 必填 | 规则 | 说明 |
| --- | --- | --- | --- |
| `id` | ✅ | `^[a-z0-9]+(\.[a-z0-9][a-z0-9-]*)+$`，≤96 | 反向域名式，**小写**，不含 `_`。安装目录名就是它 |
| `name` | ✅ | ≤64 字符 | 显示名 |
| `version` | ✅ | `^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$` | 语义化版本；**更新只接受严格更高**的版本 |
| `author` | ✅ | 非空 | |
| `description` | ✅ | ≤512 字符 | 安装对话框里给用户看 |
| `permissions` | ✅ | 见下；不重复 | 空数组合法（但那就什么都做不了） |
| `entry` | ✅ | 相对路径，`.html` 结尾，不含 `\` 与 `..`，不以 `/` 开头 | 入口文档 |
| `surface` | | ≤8 块 | 浮层面矩形，见第 8 节 |
| `panel` | | bool | 占用一个固定槽位。今天只有 `panelSlot:"chat"` 有意义 |
| `panelSlot` | | `""` / `"chat"` / `"todos"` / `"pomodoro"` | `"chat"` 要求 `panel:true`；`"todos"`/`"pomodoro"` 要求声明了 `surface`——它决定**右键菜单的那一格**打开谁 |
| `background` | | bool | 要一个常驻无名帧；要求申请了 `events`、`net.ws`、`net.fetch` 之一 |
| `config` | | ≤40 项 | 你的设置项，见第 4.2 节 |
| `netHosts` | | ≤ 见规则 | `net.fetch`/`net.ws` 的白名单；声明了 `net.fetch` 就至少要一项 |
| `shareRead` | | ≤8 项 | 你能读**别人**的哪些共享键，格式 `<插件id>/<名字>` |
| `shareLLM` | | bool | 允许**别人**借你的模型配置；要求同时申请 `llm.chat` |
| `assets` | | ≤32 项 | 包里除入口与固定资源之外、需要按相对路径取用的文件（例如内置音频） |

**至少要有一种界面落点**：`panel:true`、非空 `surface`、`background:true` 三者之一。

### 4.1 权限（13 项，全表）

| 权限 | 用户看到的文案 | 它 gates 的方法 |
| --- | --- | --- |
| `pet.bubble` | 让桌宠弹出一句话的气泡 | `bubble.say` |
| `events` | 订阅待办与番茄钟的变化事件（关闭界面后也会送达） | `events.subscribe`，以及 `background` 帧的一个依据 |
| `net.fetch` | 访问网络（仅限插件声明的域名） | `net.fetch`，以及 `background` 的一个依据 |
| `net.credentials` | 以你保存的网站登录凭据发请求（凭据本身不会显示给插件） | **不是独立方法**：`net.fetch` 携带 `credentials`/`referer`/`readCookies` 的第二道开关。声明了它就必须同时声明 `net.fetch` |
| `storage` | 在自己的私有目录里保存数据 | `storage.get/set/remove/dir/stat/list/move`、`memory.read/append` |
| `pet.surface` | 在桌宠旁显示自定义浮层面 | `surface.show/hide/blocks` |
| `llm.chat` | 调用你已配置的大模型（流式返回） | `llm.chat` |
| `plugin.config` | 保存你自己的插件配置 | `config.get/set` |
| `audio` | 保存并播放音频（例如语音提醒） | `audio.save/import/list/remove/play/stop` |
| `net.ws` | 保持一条到插件所声明地址的 WebSocket 长连接（收发消息） | `ws.open/send/close/state`，以及 `background` 的一个依据 |
| `llm.borrow` | 使用其它插件已配置的大模型与密钥（密钥不会显示给你） | `llm.profile` |
| `process` | 启动本机程序 | `process.launch/state` |
| `plugin.share` | 与其它插件交换消息（只能读清单里点名的键，只能写自己名下的键） | `share.set/get/remove` |

> **没有 `background` 权限**：常驻帧由 `events` / `net.ws` / `net.fetch` 之一门控。
>
> 这张表就是全部。宿主**不认识任何具体插件**，所以也不存在"待办"或"番茄钟"这一类以业务
> 命名的能力：待办列表、番茄钟状态都住在各自插件的私有目录里，别的插件要读只能走
> `plugin.share`（第 6.7 节），而且要写进自己 manifest 的 `shareRead`。

### 4.2 `config`（你的设置项）

每个插件把自己的设置**声明**出来，用户在一个由宿主绘制、随声明变化的表单里编辑；
值存在你的私有目录里，只有你能读到。

```json
{
  "key": "model",
  "label": "模型名",
  "type": "text",
  "default": "deepseek-chat"
}
```

| 字段 | 规则 |
| --- | --- |
| `key` | `^[A-Za-z0-9_-]{1,64}$`，在同一个插件里唯一（它就是存储键） |
| `label` | 必填，≤64 字符。给用户看的中文说明 |
| `type` | `text` \| `number` \| `bool` \| `secret` \| `select` |
| `default` | 可选。**字符串**（数字也写成 `"3"`）；表单空着时用它 |
| `secret` | 必须与 `type:"secret"` 一致（两种写法 = 两处可能把加密写错） |
| `hostWhitelist` | 至多一项。它的**当前值**会被加进 `net.fetch` 的域名白名单（用于"用户自己填的服务地址"） |
| `options` / `multiple` | 只用于 `select`；`options` 需要 2–64 项，每项 `{value,label}` 都要有，`value` 不重复；`multiple:true` 的值是**逗号串**（`"a,b"`） |
| `select` 的限制 | 不能同时是 `secret` 或 `hostWhitelist` |

`secret` 的真实语义（重要）：

- 明文**永不出宿主进程**：`config.get` 对你的这个 key 只回 `{set:true, mask:"••••a1b2"}`；
- 你**不能**用 `config.get` 拿到它，也不能把它放进 `config.set` 去"确认一下"；
- 你能做的是**点名使用它**：`net.fetch { credentials: "<key名>" }` 让宿主把它填进
  `Cookie` 头（需要 `net.credentials`）；`llm.chat` 会把名为 `llmApiKey` 的 secret 当作
  模型密钥（见 6.6）。

---

## 5. 桥接协议

### 5.1 消息总表

所有消息都是 `{ v: 1, type: "…", … }`，一律走 `postMessage(msg, '*')`
（帧是 opaque origin，没有 origin 可指定）。**`v` 不是 1 的消息宿主会丢弃，
你也应该丢弃**。

| 方向 | `type` | 其它字段 | 什么时候 |
| --- | --- | --- | --- |
| 插件 → 宿主 | `ready` | — | 你的文档脚本就绪时，**发一次**。必须是监听器装好之后 |
| 宿主 → 插件 | `init` | `pluginId` `permissions` `granted` `surface` `theme` | 收到 `ready` 后**恰好一次**。之前别发请求 |
| 插件 → 宿主 | `request` | `id`（非空字符串）`method` `payload`（对象） | 任意次 |
| 宿主 → 插件 | `response` | `id` `ok` `result` \| `error` | 每个 `request` 一次 |
| 宿主 → 插件 | `event` | `name` `payload` | 你订阅且帧在的情况下 |
| 宿主 → 插件 | `theme` | `theme: "light"\|"dark"` | 用户切换配色时（桌宠右键菜单的「主题」、控制中心的「偏好」页）。首帧的色在 URL 的 `?theme=` 上 |
| 宿主 → 插件 | `surface` | `rect` | 帧的矩形变了（内容长高、被裁、被移） |

### 5.2 `init` 的 `surface`

```jsonc
// 面板槽位（panel:true）
"surface": { "kind": "panel", "slot": "chat" }
// 控制中心打开的插件页
"surface": { "kind": "panel", "slot": "workshop" }
// 常驻无名帧
"surface": { "kind": "panel", "slot": "background" }
// 浮层面的一块（每块一个文档）
"surface": {
  "kind": "surface",
  "rectIndex": 0,          // 这是 manifest.surface 的第几块（从 0 开始）
  "rectCount": 2,          // 一共声明了几块
  "rect": {                // 这一块**实际**的矩形（宿主已按屏幕夹回）
    "x": 100, "y": 40, "w": 308, "h": 60, "r": 16,
    "ellipse": false,
    "tailX": 154,          // 宠物中心相对这一块左边界的距离（画尖角用）
    "hidden": false,
    "room": 160            // 宠物上方可用高度（可为 0；决定你还能长多高）
  }
}
```

`init.theme` 只在控制中心里有（桌宠是纯深色窗口，不发主题）。
**别用 `kind` 判断自己在哪个窗口**：常驻帧与面板的 `kind` 都是 `panel`——用 `slot`。

### 5.3 铁律

1. **监听器先装，再发 `ready`。** 否则会漏掉 `init`，界面永远停在"等待宿主初始化"。
2. **`init` 之前不要发请求。** 你还不知道用户授予了什么；宿主虽然会答，但你的 UI 会先按
   错误的假设画出来。
3. **只认 `event.source === window.parent` 且 `data.v === 1`。** 别的窗口、别的版本一律忽略。
4. **`request` 的 `id` 每次不同、非空字符串。** 宿主用一个 `id` 对应一个 `response`；
   迟到的 `response`（比如你把界面重画了）要能安全丢弃——按 `id` 找 `pending`，找不到就忽略。
5. **`response.ok === false` 时 `error` 是给人看的中文句子**，直接显示，不要包装成
   "操作失败"。
6. **同一个文档只握手一次**：第二个 `ready` 会被忽略（不会回第二条 `init`）。

---

## 6. 能力参考

通用约定：

- `payload` 是对象；不需要参数的方法传 `{}` 或省略。
- 返回值是 JSON 对象（下表逐项列出）。
- 失败时 `response.ok=false`，`error` 是中文原因（含"未获权限 X"、"未启用"、"本程序不支持该方法"）。
- **payload 里的字符串都有上限**，超了会被拒绝或截断（逐项注明）。
- 名字类参数（音频槽名、共享键名、存储键的每一段）都是**扁平名**：
  `^[A-Za-z0-9_-]{1,64}$`。

### 6.1 `pet.bubble`

#### `bubble.say` — 让桌宠说一句话

```jsonc
// payload
{ "text": "该吃药了", "todoAction": false }
// → { "ok": true }
```

- `text` 必填，非空。
- 气泡只有一个；它会和"浮层面"互斥（打开浮层面会收起气泡，反之亦然）。
- `todoAction: true` 会在气泡上加一个「看看待办」的按钮——只在这个气泡**就是**关于待办
  列表的时候用。
- 桌宠被隐藏时不显示；气泡有自动消失时间。

### 6.2 `events`

#### `events.subscribe` — 订阅宿主事件

```jsonc
// payload
{ "names": ["reminder.fired"] }
// → ["reminder.fired"]        // 返回你的**全部**订阅集合（累加，不会取消）
```

- 未知事件名**整条拒绝**（`未知事件名 X`），一个都不订阅。
- 订阅只是登记；**只有在帧被挂载时才送得到**（见第 7 节）。

### 6.3 `storage` — 你自己的私有目录

键是**相对路径**：`/` 分隔，最多 4 段，总长 ≤200，每段 ≤64 且只能是
`A-Za-z0-9_-`（不能是 `.` / `..`，不能有 `\`）。例如 `stickers/bytes/790ed6cc`。

| 方法 | payload | 返回 | 备注 |
| --- | --- | --- | --- |
| `storage.get` | `{key}` | `{value}` | 不存在 = `value:""`，**不是错误** |
| `storage.set` | `{key, value}` | `{ok:true}` | 值是**字符串**；会自动建父目录。没有硬上限，但它是给小文本的——整份内容会读进内存再交给你，别往里塞二进制 |
| `storage.remove` | `{key}` | `{ok:true}` | 删除不存在的键也算成功 |
| `storage.stat` | `{key}` | `{exists, bytes}` | 不存在 = `{exists:false, bytes:0}` |
| `storage.dir` | `{sub?}` | `{dir}` | 返回你自己的绝对目录；`sub` 是一个相对子路径（同样 ≤4 段，会按需创建）。给人看路径、或交给 `process.launch` 启动的程序写文件时用 |
| `storage.list` | `{sub?}` | `{dir, files:[{name,bytes}], dirs:[名字]}` | 列出你某个子目录里的东西；目录不存在 = 空列表 |
| `storage.move` | `{from, to}` | `{ok, moved, targetExists?}` | 重命名/搬你自己的文件；目标已存在时 `moved:false, targetExists:true`（不覆盖） |

> **一个键只有一个写者。** 两个文档同时对同一个键做"读-改-写"会丢更新。
> 要么只让一个角色写（例如"只有 surface#2 写状态"），要么用 `plugin.share` 的单向约定。

#### `memory.read` / `memory.append` — 模型用的长期记忆

宿主替你管一份 markdown 文档（`self-memory` 风格：一条一行）：

```jsonc
// memory.read  payload {} → { "text": "…整份文档…" }
// memory.append payload { "text": "主人喜欢简短的回答" } → { "text": "…追加之后的整份文档…" }
```

- 单条上限 **500 字符**（超了截断并加 `…`）；整份文档上限 **8 KiB**，写满会被拒绝。
- 每次追加会在你的目录里留一份快照（最多保留 20 份）。
- 这一对方法是给"让模型自己记点事"用的；普通设置请用 `config`。

### 6.4 `plugin.config` — 你的设置项

```jsonc
// config.get  payload {} → { "values": {"model":"deepseek-chat"}, "secrets": {"apiKey": {"set":true,"mask":"••••a1b2"}} }
// config.set  payload { "values": {"model":"deepseek-chat"} } → { "ok":true }
```

- **只能写 manifest 声明过的键**：payload 里只要有一个未声明的键，整次写入**什么都不存**。
- `values` 只含非 secret 项；secret 项只以 `{set, mask}` 出现。
- 写 secret：把明文放进 `config.set` 的 `values[<secretKey>]`（宿主加密存储；之后 `config.get` 只回 `{set,mask}`）。
- 用户在别处改了设置，你要下次 `config.get` 才看得到（宿主不会主动通知）。

### 6.5 `pet.surface` — 宠物旁边的浮层面

| 方法 | payload | 返回 | 说明 |
| --- | --- | --- | --- |
| `surface.show` | `{}` | `{ok:true}` | 打开你自己的浮层面（manifest 声明的那些矩形） |
| `surface.hide` | `{}` | `{ok:true}` | 关闭 |
| `surface.blocks` | `{hidden?:[索引], sizes?:{"索引": 高度}}` | `{ok:true}` | 显示/隐藏某些块，或请求某个块长高 |
| `pet.badge` | `{text}`（≤16 字符，空串=清除） | `{text}` | 在**宠物自己的框内、头顶正中**画一行字（番茄钟的倒计时就是这么来的）。它不占宠物旁那个槽位，所以待办列表开着时也能显示。文字是**字符串**：宿主不解析、不知道是谁写的。**借用 `pet.surface` 的授权**（同一件事：插件可以在宠物身上画自己的像素），所以不需要额外权限 |

`surface.blocks` 的细节（**这是浮层面唯一能改几何的方式**）：

- `hidden` 是**声明索引**（从 0 开始），命中的块不占窗口区域、不挂帧、不接点击——所以
  一个"空着的块"不用留一块吞点击的区域。
- `sizes` 的键是索引的**字符串形式**（JSON 对象的键只能是字符串），值是这一块想要的
  **高度**（px）。宿主把它夹在 `[声明高度, maxH]` 之间；声明时没写 `maxH` 的块长不高。
- 传空对象 `{}` = 全部按声明的样子显示。
- 每次调用都会重新裁剪窗口并推送新布局；**最多每 500 毫秒生效一次**（更频繁的调用会被合并——动画式地每帧调它没有意义）。

### 6.6 `llm.chat` / `llm.borrow` — 用模型

#### `llm.chat`

```jsonc
// payload
{
  "text": "用户这一句",                  // 必填，≤4000 字符
  "requestId": "自定义 id",             // 可选；流式帧会带回它。不给则宿主生成
  "system": "你是……",                   // 可选，≤4000 字符。不给时宿主会自己加一段"你是谁 + 现在几点"；给了就整段用它
  "history": [                          // 可选，≤32 条、合计 ≤12000 字符（多余的从最旧的丢）
    { "role": "user", "text": "…" },
    { "role": "assistant", "text": "…" }
  ],
  "model": "…",                         // 可选：只对这一次生效的模型名（≤96）
  "images": ["https://…"],              // 可选，≤4 张；http(s)，必须落在你的 netHosts 里
  "tools": ["pet_say", "memory_read"]   // 可选：宿主工具目录里的名字，见下
}
// → { "requestId": "…", "text": "完整回复" }
```

流式结果**同时**通过 `event` 推给你（名字以 `llm.` 开头，只有发起者能收到）：

| 事件 | payload |
| --- | --- |
| `llm.delta` | `{ requestId, text }` 增量片段 |
| `llm.done` | `{ requestId, text }` 全文（丢过帧时用它修） |
| `llm.error` | `{ requestId, message, kind }` |
| `llm.tool` | `{ requestId, name, ok, error? }` 模型调用了一个宿主工具 |

`kind` 是错误分类，用来决定"要不要重试/要不要提示改配置"：

```text
auth（密钥错/过期，重试无用）  rate_limit（限流/额度）  model（模型名不对）
request（请求本身被拒）        network（连不上）        timeout（超时）
canceled（用户取消）           server（服务端 5xx）     protocol（返回不是它承诺的形状）
other
```

限制与语义：

- **端点、模型、密钥、每日上限都属于你**（写在你自己的 `config` 里）：宿主只是转发。
  所以 manifest 需要声明 `llmBaseUrl` / `llmModel` / `llmApiKey`（`secret`）这类配置项。
  宿主会把配置里**第一个 `secret` 项**当作这次请求的密钥——把它命名为 `llmApiKey` 最不容易出错。
- 每日请求上限由你在 `config` 里声明（例如 `llmDailyBudget`），宿主替你计数并拒绝超限的请求；
  **被拒绝的那次也算一次尝试**。
- `tools` 是**宿主工具目录里的名字**，不是 JSON Schema：宿主决定工具长什么样，你没授予的
  权限对应的工具*不会*被提供。三个可用的名字（宿主不认识的工具名会被**静默跳过**，所以别假设它一定被提供）：

  | 工具名 | 需要权限 | 作用 |
  | --- | --- | --- |
  | `pet_say` | `pet.bubble` | 让桌宠弹一句话（参数 `{"text":"…"}`） |
  | `memory_read` | `storage` | 读你的长期记忆文档 |
  | `memory_append` | `storage` | 往长期记忆里追加一条（参数 `{"text":"…"}`） |

  模型可以连续要工具，宿主最多跑 4 轮；超过会以 `kind:"tool_rounds"` 结束。
- 回复**不会**被宿主写进任何转写：历史是你的责任（存进 `storage`）。
- 一条 `llm.chat` 可能因为工具跑好几轮，每一轮都算一次请求上限。

#### `llm.profile`

```jsonc
// payload {} →
{
  "ownReady": true,        // 你自己的配置是否齐全（有密钥/端点/模型）
  "borrowAllowed": false,  // 用户是否授予了 llm.borrow
  "ready": true,           // 这次调用到底能不能成
  "source": "own",         // "own" | "borrowed" | "none"
  "model": "deepseek-chat",
  "lender": { "id": "com.shixiansi.plugin-chat", "name": "对话插件" }  // source=borrowed 时
}
```

用来在设置页上诚实地说"现在用的是谁的模型"。

`llm.borrow` 的语义：你不是拿别人的密钥，而是**用别人已配置好的那套**发请求；
密钥不出宿主进程。只有当某个已装插件在自己的 manifest 里 `shareLLM: true` 时才借得到。

### 6.7 `plugin.share` — 插件之间的牌盘

写：**只能写你自己名下**（值落在你的私有目录）。读：**只能读 manifest `shareRead` 里点名的**
（`"<别人的id>/<名字>"`，精确匹配，没有通配）。

| 方法 | payload | 返回 |
| --- | --- | --- |
| `share.set` | `{name, value}` | `{ok:true, key:"<你的id>/<name>"}` |
| `share.get` | `{owner?, name}` | `{value, at, key}` — `at` 是写入时刻（epoch 毫秒） |
| `share.remove` | `{name}` | `{ok:true}`（只删你自己的） |

- `name` 是扁平名（`^[A-Za-z0-9_-]{1,64}$`）；`value` 是字符串，**≤64 KiB**。
- `owner` 省略 = 读自己的（读自己不需要声明）。
- 读一个"还没人发布"的键返回 `{value:"", at:0}`，**不是错误**——轮询的第一次都是这样。
- 典型用法：一个插件发布快照，另一个按 `at` 判断新旧，避免拿三天前的任务当真。

### 6.8 `audio` — 保存并播放音频

只接受 **WAV**，只在你的私有目录里，名字是扁平名。

| 方法 | payload | 返回 |
| --- | --- | --- |
| `audio.save` | `{name, data}`（`data` 是 **base64**） | `{name, bytes}` |
| `audio.import` | `{name, from}`（`from` 是**包内**相对路径，必须在 `manifest.assets` 里声明） | `{name, bytes}` |
| `audio.list` | `{}` | `[{name, bytes}]` |
| `audio.remove` | `{name}` | `{ok:true}` |
| `audio.play` | `{name}` | `{ok:true}` |
| `audio.stop` | `{}` | `{ok:true}` |

- 单段上限 **16 MiB**。
- 播放是**按文件**的（不是内存里的字节）：所以 `data`/`import` 必须是**已经写完**的文件。
- 同一时刻只有一段音频在播；`audio.play` 会顶掉前一段。

### 6.9 `net.fetch` / `net.credentials`

```jsonc
// payload
{
  "method": "GET",                     // 只支持 GET / POST（大小写不敏感，默认 GET）
  "url": "https://api.example.com/x",  // 只支持 http/https
  "body": "…",                         // 可选
  "encoding": "text",                  // "text"（默认）| "base64"
  "headers": { "authorization": "Bearer …" },   // 只允许这四个：accept / authorization / content-type / user-agent
  "credentials": "biliCookie",         // 可选：声明过的 secret 配置项的 key，宿主填进 Cookie 头（需 net.credentials）
  "referer": "https://www.example.com/", // 可选：需 net.credentials，且**域名也要在白名单里**
  "readCookies": true                  // 可选：要响应的 Set-Cookie（需 net.credentials）
}
// → { "status": 200, "body": "…", "encoding": "base64"?, "truncated": true?, "cookies": ["a=b", …]? }
```

- **域名白名单 = `manifest.netHosts` ∪ `hostWhitelist` 那个配置项的当前值。**
  精确匹配（`api.example.com` 不会让 `example.com` 或 `notapi.example.com` 通）；
  带端口的条目只匹配那个端口。**每次重定向都会重新检查**，最多 5 跳。
- 单次响应体上限 **8 MiB**；超了会被截断并带 `truncated: true`——**别忽略这个字段**。
- `encoding:"base64"` 是**唯一**安全的二进制方式：文本形式对非 UTF-8 内容是有损的
  （无效字节会变成替换字符，看起来"成功了"、放出来是噪音）。
- 请求头是白名单制：`cookie`/`referer` 不在其中，因为它们由宿主填（见 `credentials`/`referer`）。
- 单个头值 ≤1024 字节；不允许换行。

### 6.10 `net.ws` — 一条宿主代持的长连接

| 方法 | payload | 返回 |
| --- | --- | --- |
| `ws.open` | `{url, token?}` | `{ok:true, state, url}` |
| `ws.send` | `{text}` | `{ok:true}` |
| `ws.close` | `{}` | `{ok:true}` |
| `ws.state` | `{}` | `{state, url?, error?, since, received, sent}` |

- 只支持 `ws`/`wss`，地址的 host 必须在白名单里（同 `net.fetch` 的规则）。
- `token` 会作为 HTTP 头随握手发出（这是它存在的理由：浏览器 `WebSocket` 不能设头）。
  ≤2048 字符。
- 每个插件**一条**连接；宿主负责重连与心跳（30 秒 ping）。
- `state` 是 `connecting` / `open` / `error` / `closed` 之一；`error` 不是终态（宿主会继续重试）。
- 入站文本帧通过 `event` 推给你：`ws.message {text}`；状态变化推 `ws.state {state,…}`。
- 出站单帧上限 **512 KiB**。

### 6.11 `process` — 启动本机程序

| 方法 | payload | 返回 |
| --- | --- | --- |
| `process.launch` | `{path, args?}` | `{pid}` |
| `process.state` | `{pid}` | `{known, running, exitCode}` |

- `path` 必须是**绝对路径**、`.exe`、已存在，且**是用户在配置里填的值**（不要让用户以外的东西
  决定它：这条权限的含义就是"启动用户指给你的程序"）。文件 ≤512 MiB；`args` ≤32 个、每个
  ≤512 字符。
- 不等待、不共享 stdio：它启动后与宿主无关。`process.state` 只是"它还活着吗、退出码是多少"。
- `{known:false}` = 这个 pid 不是你启动的（或来自上一次运行），应读作"它已经不在了"。
- 一个插件最多同时跟踪 **32** 个子进程。

---

## 7. 事件

可订阅的**只有两个**：

| 事件 | payload | 谁发 | 什么时候 |
| --- | --- | --- | --- |
| `reminder.fired` | `{due, overdue, total}` | 桌宠 | **它自己**弹提醒气泡时。今天这只在用户点「立刻提醒一次」（托盘菜单 / 右键菜单）时发生；**定时提醒是待办插件自己弹 `bubble.say`，不经这个事件** |
| `config.changed` | `{pluginId}` | 桌宠 | 你的 `config.json` 在磁盘上变了——**不管是谁改的**：控制中心的插件页保存设置，或者你自己的工坊界面调 `config.set`。它是**广播**：每个订阅者都会收到每个插件的变化，所以要用 `payload.pluginId` 和自己的 id 比一下 || `timer.phaseEnded` | `{phase}` | **没有人发** | 订阅它会成功，但你**永远收不到**：宿主不产生这个事件。要听"一段结束了"，读番茄钟插件发布的 `com.shixiansi.plugin-pomodoro/phase-ended` |

番茄钟的"一段结束了"由**番茄钟插件**通过 `plugin.share` 发布（
`owner: "com.shixiansi.plugin-pomodoro"`, `name: "phase-ended"`,
值 `{"phase":"focus"|"break","at":<epoch ms>}`，需要 `shareRead` 声明 + `plugin.share` 权限）。
语音插件就是这么知道该说话的。

**送达条件**：

1. 你在 manifest 里申请了 `events`，且用户授予了；
2. 你调过 `events.subscribe`；
3. **在这一刻你有一个帧被挂载**（面板开着、浮层面开着、或你声明了 `background`）。

所以"用户关掉界面后还要办事"的插件必须声明 `background: true`——否则事件到不了你，
宿主会直接丢掉它（没有"补发"）。

---

## 8. 界面与几何

### 8.1 浮层面的矩形是"声明"的，不是"算"的

`surface` 里的每一块是**相对宠物左上角的 CSS 像素**（`dx`,`dy` 可以为负）。
窗口的可见区域就是这些矩形的并集——所以 CSS 里的 `height:auto` **不成立**：
一块的大小在打开那一刻就定了。

```jsonc
{
  "dx": -79, "dy": -60,     // 相对宠物左上角；负数是向左/向上
  "w": 308, "h": 60,        // 宽高必须 >0，≤2000
  "maxH": 156,              // 可选：这一块最多能长到多高（用 surface.blocks 的 sizes 请求）
  "radius": 16,             // 圆角（0..200）。形状由你的 CSS 画，宿主只按矩形裁剪
  "anchor": "bottom",       // 可选："top"（默认，从宠物头顶算）或 "bottom"（从宠物脚下算 dy）
  "ellipse": false          // 可选：区域是椭圆（当你要一个正圆/椭圆时）
}
```

- **`anchor:"bottom"` 是给"宠物下面那块"用的**：宠物大小是用户可调的（`petScale`），
  `dy` 从头顶算会在放大后压到宠物的腿上。
- 一块矩形就是一个 iframe：**同一个插件的多块是多个独立文档**。想画一个"带尖角的卡片"，
  尖角是用 CSS 伪元素画在那块矩形**之内**的。
- 你的文档只拿到这块矩形的**尺寸**（`body` 的 100%），拿不到"我在屏幕哪里"。
- **不要画到矩形之外**：多出来的部分会被原生区域裁掉（看起来像"右下角少了一块"）。

### 8.2 动态显示/隐藏/长高

`surface.blocks { hidden: [1], sizes: { "0": 120 } }`：

- `hidden` 里的块**不占区域、不挂帧**；`[]` 恢复全部。
- `sizes` 只有声明了 `maxH` 的块会长（再高会被夹到 `maxH`）。**请求被丢弃或被夹住时，宿主会在日志里写一条 WARN**（没有 `maxH`、超过 `maxH`、索引不存在、低于声明高度），因为调用本身总是返回成功——不写这条，插件只能靠用户截图才知道没生效。
- 你会收到一条 `{type:'surface', rect:{…}}` 告诉你新的矩形（含新的 `room`）。

### 8.2b 一张卡片里，同一时刻只有一组东西可见（这条是五次翻车换来的）

浮层面的卡片是**固定矩形**，所以"内容放不下"不会报错，只会**被裁掉**——而且裁掉哪一块取决于
布局，改一次 CSS 就换一种裁法。番茄钟的卡片在 2.3.3–2.3.9 之间翻了五次，症状依次是「按钮被切」
→「只剩数字」→「全黑」，根因只有两类：

1. **元素用 `flex: 1` 互相抢空间。** 倒计时面板是 `flex: 1 1 auto`，门一出现它就把卡片吃满，把
   门自己的按钮挤到卡片底边之外。规则：**卡片里不许有两个"会自己长大"的块**；同一时刻只有一组
   内容可见，其余显式 `hidden`（门 / 主面板 / 控件三选一，而不是叠在一起靠 flex 分配）。
2. **`hidden` 加在父元素上，连子元素一起藏。** 门的教训：`#ask` 是 `<footer id="compose">` 的
   **子元素**（HTML 注释里写着"它占据整个 footer"），而代码去藏 `#compose` —— 于是每修一次空间
   问题就把门藏一次，屏幕上只剩记录列表、只剩数字、最后一无所有。规则：**藏之前先确认要藏的是
   哪一层**；把"控件"和"容器"分开，只藏控件（`.actions` / `.pick`），容器留给里面的门。

配套的三条：

- 高度会变就**量**（`document.body.scrollHeight`），不要写死数字；矩形里必须声明 `maxH`，否则
  宿主忽略请求（会写一条 WARN 说明原因）。
- 布局相关的测试只能断言**属性与层级**（`hidden`、父子关系、请求的 payload）——jsdom 没有排版，
  断言不了"看起来在哪"。所以上面第 2 条要靠"藏的是哪一层"这种断言守住，而不是靠像素。
- 加/改卡片结构时，至少走一遍**最满**和**最窄**两种状态：门开着、门关着。
### 8.3 主题

两个通道，缺一不可：

1. **首帧**：控制中心在帧地址上带 `?theme=light|dark`。在你自己的 `<head>` 里立刻读它并
   写到 `document.documentElement.dataset.theme`，否则会闪一下深色。
2. **切换**：控制中心会再发 `{type:'theme', theme}`。收到就改。

桌宠窗口是纯深色，**不发主题**（`init.theme` 为 `undefined`，URL 上没有 `?theme=`）——
所以默认必须是深色。

### 8.4 CSS 纪律（每条都是踩过的）

- **不许 `box-shadow` / `filter` / `transform`**：它们在矩形之外绘制，会直接画到用户的桌面上。
  需要边框就用 `border`，需要圆角就用 `border-radius`。
- `:root { background: transparent }`：浮层面矩形里"你没画"的地方是要透出桌面的。
  同时要 `color-scheme: only light` 写在 `:root` 上——Chromium 在 `color-scheme: dark` 下会给
  **画布**铺 `#121212`，根元素的 `background:transparent` 压不住那一层。
- 在**控制中心**里你的文档填满一块普通区域，可以有背景色；在**浮层面**里必须透明。
  用 `init.surface.kind === 'surface'` 决定要不要铺底色。
- 滚动条：`overflow:auto` 放在**会增长的那个元素**上，并把它的 `min-height` 设为 `0`
  （否则内容会把外层盒子撑高、把工具栏顶出去）。

### 8.5 关于 `slot` 与 `background`

```jsonc
// 常驻无名帧（声明 background:true + events/net.ws/net.fetch 之一）
{ "kind": "panel", "slot": "background" }
```

- 它在整个进程生命周期里挂着，但 `display:none`：**看不见、不能点、不能滚**，
  只能收发消息（这是"用户关掉界面后还要办事"的唯一方式）。
- 因此常驻帧里**不要**依赖布局、尺寸、焦点。
- 桌宠给别的挂载的 `slot`：`chat`（对话槽）、`todos`/`pomodoro`（右键菜单的那一格打开你）、
  `background`；控制中心给 `workshop`。

---

## 9. 两个宿主的差异

同一个文档可能被两个程序挂载，它们**服务的能力不同**：

| 能力 | 桌宠 | 控制中心（`slot:"workshop"`） |
| --- | --- | --- |
| `storage.*` `config.*` `audio.*` `net.fetch` `plugin.share.*` | ✅ | ✅ |
| `bubble.say` / `surface.*` | ✅ | ❌ |
| `llm.chat` / `llm.profile` | ✅ | ❌ |
| `events.subscribe` | ✅ | ❌ |
| `ws.*` / `process.launch` / `process.state` | ✅ | ❌ |
| 主题 | 只有深色 | `?theme=` + `theme` 消息 |

未被服务的能力**不是"没授予"**，而是 `response.error = "本程序不支持该方法 X"`。
好的插件在这里降级而不是崩：`slot === 'workshop'` 时

- 藏起只能在桌宠上做的事（计时按钮、发消息的输入框、弹气泡的按钮），
- 用一行字说明"这件事在桌宠上"，
- 但**继续显示只读的部分**（列表、记录、历史）——那正是用户打开这一页的原因。

一个现成的判据：控制中心给的是 `surface.slot === 'workshop'`，其余都是桌宠。

---

## 10. 你拿不到的东西（安全边界）

| 你想要的 | 现实 |
| --- | --- |
| 父窗口的 DOM / 你的宿主的变量 | ❌ 帧是 opaque origin（`sandbox="allow-scripts"`，故意没有 `allow-same-origin`） |
| `localStorage` / `sessionStorage` / `IndexedDB` / `document.cookie` | ❌ opaque origin 访问会抛 `SecurityError`。要存东西用 `storage.*` |
| 任意文件读写 | ❌ 只有 `storage.*`（你自己的目录）和 `audio.*`（你自己的音频） |
| 密钥明文 | ❌ 只存在 `{set, mask}`；要"用"它只能点名（`net.fetch` 的 `credentials`、`llm.chat` 的 `llmApiKey`） |
| 任意网络地址 | ❌ 只有 `manifest.netHosts` ∪ `hostWhitelist` 配置项里的 host；重定向也检查 |
| 直接开 WebSocket / 起进程 / 播音频 | ❌ 全都要经宿主（`ws.*` / `process.*` / `audio.*`） |
| 从 payload 里给路径 | ❌ 宿主从不接受 payload 里的路径（`entry`、`assets`、`from` 都是**包内相对路径**且被校验） |
| 绕过权限 | ❌ 每次请求都过闸门；闸门在前三步拒绝时**什么都不发生**（不写文件、不弹气泡、不发请求） |

另外：**你的 manifest 会被用户看见**。`permissions`、`config` 的 `label`、`shareRead`
都出现在安装对话框里——写得含糊，用户就会拒绝。

---

## 11. 发布

### 11.1 zip 的形状

```
com.example.hello-1.0.0.zip
├── manifest.json          ← 必须在**根**
├── panel.html             ← 你的 entry
├── app.js
├── style.css
└── assets/…               ← manifest.assets 里列过的额外文件
```

**不要多包一层目录**：宿主直接解压到 `plugins/<id>/`，多一层会让 `manifest.json` 深一层而
被判为"没有 manifest"。

必守的文件规则：

- 每个条目的路径都会被校验：不能是绝对路径、不能有 `..`、不能是符号链接；
- 单文件解压 ≤32 MiB，总计 ≤128 MiB；
- 包内 `manifest.json` 的 `permissions` 与 `netHosts`，必须和市场条目里的**完全一致**
  （顺序无关）——否则安装会被拒绝。这条规则保护的是"用户看到的授权 = 真正申请的授权"。

### 11.2 市场条目（`index.json`）

```json
{
  "version": 1,
  "updatedAt": "2026-10-28T08:00:00Z",
  "plugins": [
    {
      "id": "com.example.hello",
      "name": "打招呼插件",
      "version": "1.0.0",
      "author": "你的名字",
      "description": "……",
      "permissions": ["pet.bubble", "storage", "pet.surface"],
      "netHosts": ["api.example.com"],
      "download": "https://example.com/plugins/com.example.hello-1.0.0.zip",
      "sha256": "小写十六进制 64 位"
    }
  ]
}
```

- `download` 只支持 `http`/`https`；`sha256` 必须是**小写** 64 位十六进制。
- 下载后会先算摘要、必须与条目一致，然后才解压。
- `netHosts` 只有在声明了 `net.fetch` 时才需要，但一旦 manifest 里有，条目里也要有。

### 11.3 版本与更新

- 版本是**严格递增**语义：更新只接受"严格更高"的版本（`1.2.10 > 1.2.9 > 1.2.0`）；
  装一个更低的版本会被拒绝。
- 更新**保留**用户的启用状态与已授予的权限。
- **卸载是两件事，用户分开回答**：插件本体（`plugins/<id>`）总是删；私有目录
  （`plugin-data/<id>`：设置、密钥、你的数据）**只在用户在确认弹窗里勾了「同时删除它的配置与
  数据」时才删**——那一下不可恢复，不勾就相当于"拔下来"，重新装回来接着用。所以"用户的数据"要么
  能重建，要么当成随时会消失（用户勾了那一下就是消失）：两者都别指望它一定还在。
- 用户手里的插件不会自动升级：控制中心的插件页会在"你装着的版本 < 目录里的版本"时显示
  「更新到 vX」，由用户点。

---

## 12. 自检清单

> **能自动查的，工具都查了**：[`docs/plugin-testkit/`](plugin-testkit/README.md) 里那四个文件
> 拷进你的仓就能跑（`plugin-check.mjs` + 它用的假宿主 `fake-host.mjs`，加上预览器
> `preview.mjs` / `preview.html`）——manifest 的每条规则、包里的文件在不在、静态红线（没申请权限
> 就调能力、用 `localStorage`、样式里非 inset 的 `box-shadow`）、以及**把文档真的跑一遍**
> （握手、请求 `id` 唯一、宿主拒绝一切时不崩、`granted=[]` 时不乱发请求）。
> **排版也查得到**：[`preview.mjs`](plugin-testkit/README.md) 用你机器上的 Edge/Chrome 把插件装进
> 声明的矩形里跑一遍，越界就 FAIL（--check），也能截图（--shot）、能点（--click）、能直达
> 「等你回答」那一屏（--state gate）。
> 下面这张清单是它查不到的部分（观感、真实宿主行为），以及给你自己过一遍用的。

在你认为"做完了"之前，逐条确认：

**协议**

- [ ] 监听器在 `ready` 之前装好；只认 `event.source === parent` 与 `data.v === 1`。
- [ ] 每个 `request` 有唯一非空 `id`；`response` 找不到对应 `id` 时安全丢弃。
- [ ] 没用了一次 `init` 之外的假设：`granted` 里没有的能力，控件是禁用/隐藏的，而不是点了报错。
- [ ] 失败路径把宿主的 `error` 原文显示出来。

**能力**

- [ ] 用到的每个方法都在 `permissions` 里申请了对应权限，且**只申请用得到的**。
- [ ] `net.fetch` 的每个 host 都在 `netHosts` 里；用户可填的服务地址用 `hostWhitelist` 配置项。
- [ ] 二进制内容走 `encoding:"base64"`；检查了 `truncated`。
- [ ] secret 只通过 `config.set` 写入，从不试图读回。
- [ ] 同一个 `storage` 键只有一个写者。

**界面**

- [ ] 帧地址上的 `?theme=` 在样式之前应用；桌宠（无主题）下默认深色也好看。
- [ ] 没有 `box-shadow` / `filter` / `transform`。
- [ ] `surface` 模式：`:root` 透明、`color-scheme: only light`、内容不超出矩形。
- [ ] `background` 模式：不依赖布局与焦点。
- [ ] 控制中心（`slot === 'workshop'`）下：桌宠专属的东西隐藏并说明，只读的部分照常显示。

**包**

- [ ] zip 根目录就是 manifest；`entry` 存在；`assets` 里的文件都在包里。
- [ ] `index.json` 的 `permissions`/`netHosts` 与 manifest 逐项一致；`sha256` 小写。
- [ ] 版本号高于上一版。

---

## 13. 常见故障对照

| 症状 | 多半是 |
| --- | --- |
| 界面一直停在"等待宿主初始化…" | 没发 `ready`，或发得太早（监听器还没装），或守卫把 `init` 丢了（`data.v !== 1` / `event.source` 判断写错） |
| 一按按钮就报"未获权限 X" | manifest 没申请，或用户没勾。看 `init.granted` |
| 请求发出去了，永远没有回音 | `id` 为空/重复；或你在自己的 `message` 监听里把 `response` 也过滤掉了 |
| 「本程序不支持该方法 X」 | 你在控制中心里调了桌宠专属能力（见第 9 节） |
| `net.fetch` 报"未声明的域名" | host 不在 `netHosts`（注意端口：`example.com:8443` 与 `example.com` 是两条） |
| 图片/音频"看起来成功了"但内容坏了 | 用了文本编码取二进制。改 `encoding:"base64"` |
| 浮层面右下角少一块 / 内容被切 | 内容画到声明的矩形之外；或需要长高却没声明 `maxH` |
| 浮层面里"没画东西"的地方是黑的 | `:root` 没透明，或缺 `color-scheme: only light` |
| 首帧闪一下深色 | 没读 URL 上的 `?theme=` |
| 关掉界面后事件收不到 | 没声明 `background:true`（或没申请 `events`/`net.ws`/`net.fetch`） |
| 列表在两个窗口里不一致 | 你的文档只在挂载时读一次；需要定时重读或让写者唯一 |
| 装不上，报"市场条目与插件包的权限声明不一致" | `index.json` 与 `manifest.json` 的 `permissions`/`netHosts` 不同 |
| 装不上，报 sha256 校验失败 | 包被重新压过（时间戳/换行变了）；重算摘要 |
| 更新被拒 | 新版本号不高于已装版本 |

---

## 14. 这个插件的边界（写给"该不该由插件做"）

宿主的立场，值得在动手前读一遍：

- **插件是沙箱，不是扩展。** 它没有宿主的能力，只有用户逐项勾选的这 13 项。
- **宿主不认识任何具体插件。** 所以"给宿主加一个功能"永远不是选项；
  你能做的是用现有能力把它组合出来。
- **数据是你的。** 待办列表、番茄钟记录、对话历史都在各自插件的私有目录里。
  别的插件要读，只能经 `plugin.share`（且要用户看得见的 `shareRead` 声明）。
- **别把密钥、正文写进日志。** 宿主的日志会被用户贴进 issue；你的报错文案会被显示。
  两者都按"会被人看到"来写。

---

## 15. 附录：方法总表

| 方法 | 权限 | 一句话 |
| --- | --- | --- |
| `bubble.say` | `pet.bubble` | 让桌宠说一句话（可带「看看待办」按钮） |
| `events.subscribe` | `events` | 订阅宿主事件（只有两个可用） |
| `storage.get` | `storage` | 读你自己的键 |
| `storage.set` | `storage` | 写你自己的键 |
| `storage.remove` | `storage` | 删你自己的键 |
| `storage.stat` | `storage` | 文件大小 |
| `storage.dir` | `storage` | 你的目录的绝对路径 |
| `storage.list` | `storage` | 列你的子目录 |
| `storage.move` | `storage` | 搬/改名你自己的文件 |
| `memory.read` | `storage` | 读长期记忆文档 |
| `memory.append` | `storage` | 追加一条长期记忆 |
| `config.get` | `plugin.config` | 读你声明的设置（secret 只给 `{set,mask}`） |
| `config.set` | `plugin.config` | 写你声明的设置（只接受声明过的键） |
| `surface.show` | `pet.surface` | 打开你的浮层面 |
| `surface.hide` | `pet.surface` | 关闭你的浮层面 |
| `surface.blocks` | `pet.surface` | 显示/隐藏块、请求长高 |
| `pet.badge` | `pet.surface` | 宠物头顶的一行字（借 surface 的授权，见 6.5） |
| `llm.chat` | `llm.chat` | 用你自己的配置调模型（流式） |
| `llm.profile` | `llm.borrow` | 现在能用谁的模型 |
| `share.set` | `plugin.share` | 发布一个值（只能是你名下的） |
| `share.get` | `plugin.share` | 读一个值（只能读 `shareRead` 点名的） |
| `share.remove` | `plugin.share` | 删你自己发布的值 |
| `audio.save` | `audio` | 存一段 WAV（base64） |
| `audio.import` | `audio` | 把包内音频复制进你的音频目录 |
| `audio.list` | `audio` | 列你的音频 |
| `audio.remove` | `audio` | 删一段音频 |
| `audio.play` | `audio` | 播一段音频 |
| `audio.stop` | `audio` | 停 |
| `net.fetch` | `net.fetch`（+ 可选 `net.credentials`） | 受域名白名单约束的 HTTP |
| `ws.open` | `net.ws` | 开一条宿主代持的长连接 |
| `ws.send` | `net.ws` | 发一个文本帧 |
| `ws.close` | `net.ws` | 关 |
| `ws.state` | `net.ws` | 连接状态 |
| `process.launch` | `process` | 启动一个用户指定的 .exe |
| `process.state` | `process` | 那个 pid 还活着吗 |

---

**开工顺序建议**：先照第 2 节把四个文件跑起来（只要 `pet.bubble` + `storage`），
确认握手、`init.granted`、一次 `bubble.say` 都能通；再加 `surface` 学几何；
最后按需要加 `llm.chat` / `net.fetch` / `ws`。每加一个能力，先想清楚"用户拒绝这一项时
界面长什么样"——那是这个平台上最常见的失败模式。
 