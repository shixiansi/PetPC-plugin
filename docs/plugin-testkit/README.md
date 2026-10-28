# 插件自检工具（`plugin-check.mjs`）

> 目的：**在没有宿主、没有宿主源码的情况下**，检查一个插件"装上去会不会出问题"。
> 它是《[插件开发手册](../plugin-dev.md)》的可执行版本：手册说"应该怎样"，这里检查"是否真的这样"。

```bash
# 把一个插件查一遍（四组全跑）
node plugin-check.mjs path/to/plugins/com.example.hello

# 一次查一批
node plugin-check.mjs path/to/plugins/*

# 只跑某几组（改 CSS 时不必每次都等协议那一组）
node plugin-check.mjs . --only=manifest,source

# 机器可读（CI 里用）
node plugin-check.mjs . --json
```

退出码：`0` 没有 FAIL · `1` 有 FAIL · `2` 用法错误。

## 怎么用一个文件

把这个文件拷进你自己的插件仓（或随便放一个目录），用它指向插件目录：

```
你的插件仓/
├── plugins/com.example.hello/     ← 被检查的目录（里面是 manifest.json 与页面文件）
└── tools/plugin-check.mjs          ← 拷过来的这个文件
```

- **零必需依赖**：前三组只用 Node 内置模块。
- **协议那一组需要 DOM**：`npm i -D jsdom`。装不到时它报 `SKIP` 并说明原因，**不会**假装通过。
  jsdom 会先在你的插件目录里找，再在本文件旁边找。

## 它检查什么

### 组 1 `manifest`

与宿主的校验规则逐条对应（这是唯一权威，别凭印象）：

- `id` 反向域名式小写、`version` 语义化版本、`name`/`description` 长度；
- `permissions` 必须是 13 项词表里的名字、不重复；
- 声明 `net.fetch` 就**必须**有 `netHosts`；声明 `net.credentials` 就必须同时有 `net.fetch`；
- `shareLLM` 必须同时申请 `llm.chat`；`shareRead` 必须是 `<id>/<名字>` 对、不指向自己、≤8 项；
- `config`：key 形状、`secret` 与 `type:"secret"` 一致、`select` 的 2–64 个 options、
  至多一个 `hostWhitelist`、≤40 项；
- `panelSlot` 的三种值以及它与 `panel` / `surface` 的配对；
- `entry` 不以 `/` 开头、无 `\` 与 `..`、`.html` 结尾；
- **至少有一个界面落点**（`panel` / `surface` / `background` 之一）；
- `background` 必须配 `events` / `net.ws` / `net.fetch` 之一；
- `surface` 每块的宽高、圆角、偏移、`anchor`、`maxH` 与块数上限。

### 组 2 `package`

- `entry` 指向的文件真的存在（否则装上就是一个 404 的空白帧）；
- `assets` 声明的文件都在包里；
- entry 里 `src`/`href` 引用的**本地**文件都在（漏一个的典型症状：页面能开，但没样式/没脚本）。

### 组 3 `source`（静态读文本）

- 每一处 `request('…')` 的方法名都在契约表里，且它需要的权限**已经写进 manifest**；
- 没有碰这些（在 opaque origin 里要么抛错、要么绕过白名单）：
  `localStorage` / `sessionStorage` / `indexedDB` / `document.cookie` / `new WebSocket` /
  `XMLHttpRequest` / `fetch('https://…')`；
- 样式里没有 `box-shadow`（`inset` 除外）/ `filter` / `transform` / `text-shadow`
  ——它们在盒子外面绘制，会画到用户桌面上；
- 有 `surface` 的插件建议 `:root { background: transparent }` 与 `color-scheme: only light`
  （缺了只 WARN：只在控制中心里跑的插件不需要）。

**注释与字符串会被跳过**：注释里写「No fetch, no localStorage」的插件不会被误判。

### 组 4 `protocol`（把文档真的跑起来）

工具自带一个**照抄宿主的假宿主**：收到 `ready` 回一条 `init`，对每个 `request` 回一条
`response`。每个挂载跑**两遍**——宿主全部答应、宿主**全部拒绝**——再加两轮：

| 轮 | 期待 |
| --- | --- |
| `ok` | 握手成功、请求的 `id` 唯一非空、不抛错 |
| `deny` | 每条请求都收到 `{ok:false}` 时不抛错（**这条最能抓"只在成功路径上写对了"的代码**） |
| `granted=[]` | 不发（或发出去也不崩）需要权限的请求；发了会 WARN，提醒你确认控件也禁用了 |
| `tolerant` | 收到 `theme` / `surface` / 未知 `type` / `v:2` 时**忽略**而不是抛错 |

挂载会自动按 manifest 生成：`panel/workshop`（控制中心）、`panel/background`（常驻帧）、
以及 `surface#0`（如果声明了浮层面）。

## 它**查不到**什么（重要）

| 查不到 | 为什么 | 怎么办 |
| --- | --- | --- |
| 内容会不会溢出声明的矩形 | jsdom 不做排版 | 真机上把窗口拖到 1.5× 缩放看一眼 |
| 颜色对比、深浅主题的实际观感 | 同上 | 真机 |
| 宿主真的怎么回应某个请求 | 假宿主只回"成功"或"拒绝"两种 | 装到真机上，看控制中心左栏的**日志**页（每次插件请求都有一行） |
| 动态拼出来的方法名 | 静态查不到 | 改成字面量，或自己写一条协议测试（见下） |
| ESM 模块图里"奇怪"的写法（裸模块名、动态 import） | 工具里的小加载器只支持相对路径 + 具名/命名空间/默认导出 | 会报 `SKIP` 并说明原因——**跑不起来的是"没查"，不是"查过没问题"** |

## 写自己的场景（可选）

工具的协议组只检查"协议本身"。要检查**你的**界面行为（"点发送之后发出 `llm.chat` 并且文本里带
问题"），用你自己的测试文件驱动同一个假宿主——`vitest` / `node --test` 都行：

```js
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

// 1. 建 DOM，把 parent 指成自己，收集插件发出的消息
const dom = new JSDOM(readFileSync('panel.html', 'utf8'), { runScripts: 'dangerously', url: 'https://plugin.invalid/panel.html' });
const { window } = dom;
const sent = [];
window.parent = window;
window.postMessage = (m) => sent.push(m);
// 2. 载入你的脚本（jsdom 不执行 <script type="module">，测试里直接 eval 即可）
window.eval(readFileSync('app.js', 'utf8'));
// 3. 按宿主协议发 init，然后断言
//    { v:1, type:'init', pluginId, permissions, granted, surface:{kind:'panel',slot:'workshop'} }
```

（本仓官方插件的 `tests/*.test.js` 就是这么写的，可以直接参考。）

## 判定标准：FAIL / WARN / SKIP

- **FAIL**：装上去一定出问题，或者一定违反宿主的前提（缺权限、方法不存在、entry 不存在、
  CSS 会画到桌面上）。
- **WARN**：可能有问题，取决于你的意图（未授权仍发请求、缺透明背景、浅色主题没读 `?theme=`）。
- **SKIP**：这一项**没查**（缺 jsdom、模块图跑不起来）。不要把 SKIP 当通过。

## 与手册的关系

工具的常量表（13 项权限、34 个方法、各处上限）与手册第 4/6 节是同一份契约的两处副本。
**改一处就要改另一处**——这条写在 `AGENTS.md §3.3`。工具落后于宿主时它会"少报"
（不认识新方法），但不会替你误报已存在的方法。
