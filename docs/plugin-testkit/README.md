# 插件自检工具（`plugin-check.mjs` / `preview.mjs`）

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

## 这个目录里有四个文件

| 文件 | 是什么 |
| --- | --- |
| `plugin-check.mjs` | 四组检查的入口：manifest / package / source / protocol |
| `fake-host.mjs` | **假宿主**（协议 + 方法表 + 权限表 + 结果表）。上面那个和下面的预览页都用这一份 |
| `preview.html` | 预览页：把插件装进声明的矩形里，量排版、列越界元素 |
| `preview.mjs` | 起服务器 / 无头断言 / 截图（用你机器上的 Edge 或 Chrome） |

为什么假宿主单独一个文件：`plugin-check.mjs` 在 jsdom 里跑，`preview.html` 在真浏览器里跑，
两者**必须**说同一套协议。两套假宿主必然分叉，而分叉的假宿主比没有更坏——它会告诉你"没问题"。

## 怎么用这几个文件

把**整个目录**拷进你自己的插件仓（或随便放一个目录），用它指向插件目录：

```
你的插件仓/
├── plugins/com.example.hello/     ← 被检查的目录（里面是 manifest.json 与页面文件）
└── tools/plugin-testkit/          ← 拷过来的这个目录（四个文件都留着）
```

- **零必需依赖**：`plugin-check.mjs` 的前三组只用 Node 内置模块；`preview.mjs` 只用你机器上
  已经有的 Edge/Chrome。
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
| 内容会不会溢出声明的矩形 | jsdom 不做排版 | **用同目录的 `preview.mjs`**（真浏览器，`--check` 越界就 FAIL） |
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
import { createFakeHost } from './fake-host.mjs';   // 和 plugin-check 用的是同一个假宿主

// 1. 建 DOM，把 parent 指成自己
const dom = new JSDOM(readFileSync('panel.html', 'utf8'), { runScripts: 'dangerously', url: 'https://plugin.invalid/panel.html' });
const { window } = dom;
window.parent = window;
const host = createFakeHost({
  manifest: JSON.parse(readFileSync('manifest.json', 'utf8')),
  granted: ['storage', 'plugin.config'],
  surface: { kind: 'panel', slot: 'workshop' },
  deliver: (data) => {
    const event = new window.MessageEvent('message', { data });
    Object.defineProperty(event, 'source', { value: window });
    window.dispatchEvent(event);
  },
});
window.postMessage = (msg) => host.onMessage(msg);
// 2. 载入你的脚本（jsdom 不执行 <script type="module">，测试里直接 eval 即可）
window.eval(readFileSync('app.js', 'utf8'));
// 3. 插件自己发的 ready 会走 host.onMessage → init 自动回过去，然后断言
//    host.requests 里有你要的那条（method / payload），host.errors 为空
```

（本仓官方插件的 `tests/*.test.js` 就是这么写的，可以直接参考。）

## 判定标准：FAIL / WARN / SKIP

- **FAIL**：装上去一定出问题，或者一定违反宿主的前提（缺权限、方法不存在、entry 不存在、
  CSS 会画到桌面上）。
- **WARN**：可能有问题，取决于你的意图（未授权仍发请求、缺透明背景、浅色主题没读 `?theme=`）。
- **SKIP**：这一项**没查**（缺 jsdom、模块图跑不起来）。不要把 SKIP 当通过。

## 与手册的关系

工具的常量表（14 项权限、43 个方法、各处上限）与手册第 4/6 节是同一份契约的两处副本。
权限表与方法表在 `fake-host.mjs` 里（预览页共用那一份），上限在 `plugin-check.mjs` 里。
**改一处就要改另一处**——这条写在 `AGENTS.md §3.3`。工具落后于宿主时它会"少报"
（不认识新方法），但不会替你误报已存在的方法。

## 预览：装之前先看一眼（`preview.mjs` + `preview.html`）

自检工具查的是 manifest、包、静态红线与协议——**它看不见排版**（jsdom 没有布局引擎，
`getBoundingClientRect()` 恒为 0）。所以"卡片放不放得下"必须用真浏览器看，这里就是那个工具。

**零依赖、零下载**：用你机器上已经有的 Edge 或 Chrome（Edge 就是产品 WebView2 的引擎），
不需要 npm 装任何东西，也不需要构建宿主。

```bash
# 人工看：起一个本地服务器，浏览器里点、切 rect、看消息流水与排版结论
node docs/plugin-testkit/preview.mjs plugins/com.shixiansi.plugin-pomodoro --open

# 断言：无头跑一遍，越界就 FAIL（退出码 1）；不给 --rect 就逐块矩形都查
node docs/plugin-testkit/preview.mjs plugins/… --check --state gate

# 截图：给人和 agent 看（一张 380×260 的卡片 + 右侧面板）
node docs/plugin-testkit/preview.mjs plugins/… --shot gate.png --state gate

# 点一下再截图（"点了之后界面变成什么样"）
node docs/plugin-testkit/preview.mjs plugins/… --shot after.png --state gate --click "#ask-ok"
```

**只在控制中心里挂的插件（没有 `surface`）：要判断布局/间距/元素规范，必须给一个真实的框。**
默认会退回 380×260（退休面板的尺寸），用它看"间距是否合规"只会看到一屏被裁掉大半的页面：

```bash
node docs/plugin-testkit/preview.mjs plugins/… --shot page.png --slot workshop \
     --theme light --frame 900x1250 --bare
```

| 开关 | 作用 |
| --- | --- |
| `--frame WxH` | 这个插件**实际的框**多大（工作区约 720×560，想一次看全就给 900×1250） |
| `--bare` | 去掉虚线框、右栏与留白，截图就是页面本身 |
| `--theme light` | 宿主给插件的配色；深浅两套都该看一眼 |

### 画廊：一次看到全部（`--gallery`）

单插件模式一次只画一个，于是"风格统不统一"这件事**没有画面**可以判断——2026-10-30 的教训是
三个插件的包里根本没带 `ui.css`，谁也没发现，因为没有任何一个画面同时展示了"有人有 kit、
有人没有"。

```bash
# 一张接触表：每个插件按它声明的矩形铺开（有 surface 的逐块画，没有的画一格工坊页）
node docs/plugin-testkit/preview.mjs --gallery plugins --shot sheet.png --theme dark --cols 3

# 也可以直接看：起服务器 + 打开浏览器（格子里的和单插件模式是同一套渲染、同一份假宿主）
node docs/plugin-testkit/preview.mjs --gallery plugins --open
```

- 一格 = 一个插件的一个矩形。浮层面按**声明尺寸**画（虚线框就是宿主裁出来的那个框）。
- 每格下面写着它用的是 `kit · 带 ui.css` 还是 `自带调色板`，以及有没有浮层面。
- 空白格是**该状态下本来就没有内容**（比如询问卡要等有候选才出现），不是样式坏了。

**它的边界，说在前面：**

- **能看排版，不能看颜色。** 一张表缩到屏幕里时，`#1d2027` 的卡片在 `#191b12` 的底上会被看成
  "浅色卡片"——我自己就这么误判过两次。要判断深浅与对比度，用单插件 `--shot`（或 `--cols 1`），
  一张图一个插件。
- 工坊页那一格给的是**固定框**（`--frame`，默认 420×340），不是它真实的窗口尺寸——溢出只作参考。
- 状态是统一的 `--state`；某个块需要别的状态才填满时，它会显示空。

**预览器会跟随 `surface.blocks` 的长高请求。** 插件请求 `sizes` 时，卡片按 [声明高度, `maxH`]
夹回并立刻重排（和真宿主一样），卡片标签会写成 `declared 308×44 → 插件请求长高 308×61`，
`--check` 量的是长高**之后**的尺寸。

这条是 2026-10-30 补的：在此之前预览永远按声明高度量，于是"插件会自己长高"这件事一直是隐形的，
而一块**本来正常**的浮层会被报成越界（clipask 的询问卡：声明 44、内容 50、请求 62）。
现在仍然会被报出来的是"**从不**请求长高的块"——那才是真的被永久裁着。

| `--granted none` | 复现"什么都没授权"那一屏（默认按清单声明的**全部**权限授权） |

假宿主对 `llm.channels.get` 返回**一张示例渠道表**（两个渠道，其中一个带两把掩码密钥），
否则渠道类界面在预览里只有空状态，行高/标签列/密钥网格全都看不见。

退出码：`0` 全部在框内（或没找到浏览器 → `SKIP`）· `1` 有元素越界 · `2` 用法/环境问题。

没有声明 `surface` 的插件（只有常驻帧，或者铺满宿主窗口的面板）会报 `SKIP`：那种界面没有
"放不放得下"这回事，拿一个它没答应过的尺寸去量它，只会得到一个假结论。

`--state gate|running|idle` 决定假宿主回什么状态：`gate` 就是「等你回答」那一屏（一段专注结束、
停在那里等回答），不必真的等五分钟。`--rect N` 选第几块矩形，`--slot` / `--kind` 选挂载方式，
`--deny` 把每个请求都拒绝（用来看权限被拒时界面会不会崩）。

**它检查什么**（页面上实时显示，也是 `--check` 的判据）：每个可见元素的
`getBoundingClientRect()` 是否超出声明矩形（下边、右边），以及 `scrollHeight` 是否超过卡片高度。
越界就列出元素与差值：

```
FAIL  com.shixiansi.plugin-pomodoro rect 0（380×260，state=gate）：6 处越界
  ✗ 内容比卡片高：scrollHeight=277 > 260
  ✗ #ask-ok 底边 277 > 260（被下边缘裁掉 17px）
  ✗ #ask-skip 底边 277 > 260（被下边缘裁掉 17px）
```

这就是 2026-10-28 番茄钟卡片连翻五次车的那一类问题（按钮被切 → 只剩数字 → 全黑），
前四次这个工具都能直接抓住。

### 点一下，看它有没有效果

预览页挂的是**两个帧**，和真宿主一样：清单声明 `background: true` 时，除了那张卡片，还会挂一个
**隐藏的常驻帧**（右栏顶上写着「挂载：surface + bg」）。番茄钟的计时器和状态机住在常驻帧里，
卡片只是视图——所以点「确定」是走完整一圈的：

```
卡片里的按钮 → share.set 一条 command → 常驻帧下一秒读到并应用 → 写回 state
            → 卡片下一秒读回 state 并重画
```

```bash
# 门开着（一段专注结束、等你回答）
node docs/plugin-testkit/preview.mjs plugins/… --shot before.png --state gate

# 点「确定」之后：门关掉，休息开始跑
node docs/plugin-testkit/preview.mjs plugins/… --shot after.png --state gate --click "#ask-ok"
```

两张图放一起看，就是"这个按钮到底有没有用"的答案。`--click` 收任何 CSS 选择器
（`#ask-skip`、`.btn-primary`……），点完会等两拍（常驻帧 1s + 卡片 1s）再量、再截。

**它还能量出"点了没反应"到底是多久没反应。** 番茄钟那次，两帧预览量出来的是 **0.824s**——
按下到那一屏真的变之间，屏幕上什么都没有，于是报告是「点确认和跳过没有反应」「要点好几次才有效」。
这个数字进了插件（2.3.10 让按钮按下即写「已提交…」，确认提前到 0.583s）。**在它之前，这类问题
一次都没被量到过**，因为没有任何一处同时有排版引擎和两个帧。

**唯一的例外是 `--slot workshop`**：那是控制中心的挂载方式，而控制中心不跑常驻帧
（它不服务 `events`）。所以在那个预览里不给常驻帧——否则页面上会出现一个真机没有的"活的"计时器。

**常设反向样本**：`tests/fixtures/overflow-card/` 是一个故意放不下的最小插件（声明 200×120、
内容 300 高）。工具说 PASS 的时候，先用它确认工具还看得见东西：

```bash
node docs/plugin-testkit/preview.mjs tests/fixtures/overflow-card --check   # 必须 FAIL，退出码 1
```

**它看不见什么**：真机的窗口区域裁剪（原生 `SetWindowRgn`）、跨进程的 `config.changed` 时序、
"好不好看"。这些仍需人装上去看一眼。