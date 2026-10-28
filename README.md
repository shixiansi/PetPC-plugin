# PetPC 插件市场（pet-pc-plugins）

桌宠 **PetPC** 的官方插件市场仓：示例插件的源码、打包脚本、市场目录 `index.json`、以及给人看的静态页 `index.html`。

> **本仓是一个公开仓**（`https://github.com/shixiansi/pet-pc-plugins.git`），面向所有插件作者与使用者；桌宠本体所在的仓 **`pet_PC` 是私有仓**。两者刻意分开：插件作者只需要看到本仓的插件格式与产物，不需要、也拿不到桌宠本体的源码。桌宠本体请使用者**自行 build**（见下文「本仓不含什么」）。

---

## 0. 想写插件？这两份就是全部契约

因为本仓是公开的、宿主仓是私有的，**写插件需要知道的一切都放在本仓里**，不要求你拿到桌宠的
源码：

| 文件 | 是什么 |
| --- | --- |
| [`docs/plugin-dev.md`](docs/plugin-dev.md) | **插件开发手册**：manifest 的每个字段与校验规则、桥接协议的每条消息、13 项权限与 34 个能力方法的 payload/返回/上限、浮层面几何与主题、打包与发布、常见故障对照。示例插件是逐字能跑的 |
| [`docs/plugin-testkit/`](docs/plugin-testkit/README.md) | **自检工具**：一个文件（`plugin-check.mjs`），零必需依赖，跑四组检查——manifest / 包里的文件 / 静态红线 / **把文档真的跑一遍**（假宿主，含"宿主拒绝一切"那一遍）。它不需要宿主 |

```bash
# 查一个插件（也可以一次给多个目录，或用 plugins/* 查全仓）
node docs/plugin-testkit/plugin-check.mjs plugins/com.shixiansi.plugin-todo
```

---

## 1. 目录结构

```
market/                                    ← 本仓根目录（独立 git 仓，非 pet_PC 的子目录）
├── .gitignore                             忽略 OS/编辑器噪声；dist/ 不忽略（是分发产物）
├── README.md                              本文件
├── docs/
│   ├── plugin-dev.md                      插件开发手册（**唯一一份**契约：协议、权限、方法、几何、发布）
│   └── plugin-testkit/                    自检工具：plugin-check.mjs（一个文件）+ 它的 README
├── index.json                             市场目录：桌宠拉取的唯一入口
├── index.html                             人看的静态市场页（单文件、无脚本、无外链）
├── package.json / vitest.config.js        示例插件前端行为的测试（需要宿主仓的 node_modules）
├── tools/package.ps1                      打包 + 算 sha256 + 回写 index.json + 复制进宿主内置源
├── tests/plugin-app.test.js               针对**对话插件** app.js 的桥接协议行为测试
├── plugins/
│   ├── com.shixiansi.plugin-chat/         一个插件一个目录，目录名 == 插件 id
│   │   ├── manifest.json                  插件声明
│   │   ├── panel.html                     面板视图入口（同时是浮层面入口）
│   │   ├── app.js                         插件前端逻辑（桥接、流式渲染、气泡）
│   │   └── style.css                      插件自己的样式
│   └── com.shixiansi.plugin-voice/        语音插件
│       ├── manifest.json                  声明 audio/events 等权限、background、assets
│       ├── panel.html                     工坊界面入口（由**市场程序**托管，不占桌宠面板）
│       ├── app.js                         事件→台词映射、生成、采用
│       ├── style.css                      两栏工坊样式
│       └── lines/*.wav                    5 条内置台词音频（随包，569 KB）
└── dist/
    ├── com.shixiansi.plugin-chat-1.3.0.zip   打包产物：manifest.json + 资源，全部在 zip 根目录
    └── com.shixiansi.plugin-voice-1.0.0.zip  同上，外加 assets 声明的 5 条音频
```

**发布流程只有三步**：改 `plugins/<id>/` 下的内容 → 运行 `tools/package.ps1` → 提交 `dist/` 里新生成的 zip 与更新后的 `index.json`。

> **改一个已装插件的任何文件，都必须同时升 `manifest.json` 的 `version`。**
> 宿主靠 `pluginId + version + 矩形数量` 判断要不要重建插件的 iframe；版本不变，桌宠会继续运行
> 它启动时加载的那份旧文档——改了 CSS 或 JS 也看不到任何变化，而且重启桌宠**不会**帮忙，因为
> 磁盘上的版本号同样没变。这不是「重启就好」的问题，`version` 就是重载的判据。
> 2026-10 的尖角输入框那轮因为没有升版本，白折腾了三轮。

---

## 2. `manifest.json` 字段

每个插件目录里的 `manifest.json` 是插件的全部声明。桌宠在安装时用 `internal/plugins.ParseManifest` 逐字段校验，**任何一条不合规都会拒绝安装**，不做静默修正。

| 字段 | 必填 | 规则 |
|---|---|---|
| `id` | ✅ | 反向域名式小写标识，`^[a-z0-9]+(\.[a-z0-9][a-z0-9-]*)+$`，长度 ≤ 96；必须等于所在目录名 |
| `name` | ✅ | 展示名，非空，长度 ≤ 64 |
| `version` | ✅ | 语义化版本，`^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`，如 `1.0.0` |
| `author` | ✅ | 作者，非空 |
| `description` | ✅ | 说明，非空，长度 ≤ 512 |
| `permissions` | ✅ | 权限数组，可为空数组；每项必须是下表的**十一项**之一，**不允许重复** |
| `netHosts` | 选填 | `net.fetch` 的域名白名单，元素形如 `host` 或 `host:port`。**声明了 `net.fetch` 却不给 `netHosts` 视为非法**；反之不声明 `net.fetch` 就不需要这个键 |
| `panel` | 选填 | 布尔；是否注册面板视图（插件 tab 已移除，面板视图现在挂在宿主的面板槽位上） |
| `panelSlot` | 选填 | 面板槽位名，目前只接受 `"chat"`；声明它必须同时 `panel: true` |
| `surface` | 选填 | 浮层面矩形数组，最多 8 块；每块 `w>0 && h>0`、边长 ≤ 2000、`0 ≤ radius ≤ 200`、`|dx| ≤ 4000`、`|dy| ≤ 4000`；`"ellipse": true` 的块画成椭圆而非圆角矩形 |
| `background` | 选填 | 布尔；申请一个**无界面的常驻帧**（桌宠会挂一个隐藏 iframe，生命周期与进程相同）。用于"没有界面打开时也要做事"的插件。**必须同时申请 `events` 权限**，否则拒绝——常驻帧的用途就是无人看着时收事件 |
| `assets` | 选填 | 包内额外携带的文件数组，最多 32 项；每项是相对路径（通过 `ValidRelPath`），不得绝对、不含 `..`。`audio.import` 只接受**在这里声明过**的路径 |
| `config` | 选填 | 插件自己的设置声明，最多 16 项；每项 `key`/`label`/`type`（`text`/`number`/`bool`/`secret`）与 `default`；`secret: true` 的项值加密存储且永不出现在任何返回值里；`hostWhitelist: true` 至多一项，它的当前值会成为该插件的 `net.fetch` 额外主机白名单 |
| `entry` | ✅ | 入口 HTML，相对路径、以 `.html` 结尾、不含 `\` 与 `..`、不以 `/` 开头；`panel`、`surface`、`background` **三者至少有一个**（插件总得有个界面落点，或者至少有个宿主会挂起来的文档） |

官方示例插件 `plugins/com.shixiansi.plugin-chat/manifest.json`：

```json
{
  "id": "com.shixiansi.plugin-chat",
  "name": "对话插件",
  "version": "1.3.0",
  "author": "shixiansi",
  "description": "在面板里与桌宠旁和大模型对话的官方插件；自己的 AI 配置与密钥由自己保存。",
  "permissions": ["llm.chat", "pet.bubble", "pet.surface", "plugin.config", "storage"],
  "panel": true,
  "panelSlot": "chat",
  "surface": [
    { "dx": -75, "dy": -120, "w": 300, "h": 112, "radius": 14 },
    { "dx": -75, "dy": 208, "w": 300, "h": 56, "radius": 14 }
  ],
  "config": [
    { "key": "llmBaseUrl", "label": "接口地址", "type": "text", "default": "https://api.deepseek.com/v1", "hostWhitelist": true },
    { "key": "llmApiKey", "label": "API Key", "type": "secret", "secret": true }
  ],
  "entry": "panel.html"
}
```

（上面为了可读性省略了另 12 项 `config`；文件里是完整的 14 项 —— 13 个 `llm*` 设置 + `llmApiKey`。）

上面那两块 `surface` 就是「宠物**正上方** 300×112 的回复卡」和「宠物**正下方** 300×56 的输入条」：
`dy` 从宠物左上角往下量，所以负数是往**上**，超过宠物高度（150×200 那档是 200）就是往**下**。
两块都是 300 宽、`dx: -75`，即**以 150 宽的宠物为中心**，各向两侧外扩 75px；
宠物紧贴窗口边缘时多出来的部分会被区域裁剪的边界夹回（见宿主 README 的「对话浮层面」一节）。
1.1.0 及更早的版本还声明过三个 `ellipse: true` 的「思考泡泡」，现已去掉。

---

## 3. 十一项权限的含义

插件能做的事**只有**这十一项，全部由宿主程序侧门控；插件本身读写不了文件、也发不出网络请求。

| 权限 | 含义 |
|---|---|
| `todos.read` | 读取待办列表 |
| `todos.write` | 新增、修改、完成与删除待办 |
| `pet.bubble` | 让桌宠弹出一句话的气泡 |
| `timer.read` | 读取番茄钟阶段与剩余时间 |
| `events` | 订阅待办与番茄钟的变化事件（`todos.changed` / `timer.changed` / `timer.phaseEnded` / `reminder.fired`）。**关闭界面后也会送达**——前提是插件用 `background` 申请了常驻帧 |
| `net.fetch` | 访问网络，**仅限**该插件 `manifest.json` 里 `netHosts` 声明的域名，外加它 `hostWhitelist` 配置项当前值里的域名。默认按**文本**返回正文，`encoding: "base64"` 才取二进制（文本形式对 WAV 这类数据是**有损**的：非法字节会被替换成 U+FFFD，文件大小看着对、播出来是噪声） |
| `storage` | 在插件自己的私有目录里保存数据。键是**相对路径**（`media/stickers/bytes/<hash>`），所以可以自己分文件夹；`storage.dir` 的 `sub` 把子目录的绝对路径交给插件启动的程序，`storage.list` 让插件看清自己文件夹里到底有什么，`storage.move` 在自己的目录里改名（迁移用，零拷贝） |
| `pet.surface` | 在桌宠旁显示自定义浮层面 |
| `llm.chat` | 调用该插件自己配置的大模型（流式返回）；**模型密钥归插件所有**，加密存在插件私有目录里 |
| `plugin.config` | 保存插件自己的设置；存在插件私有目录里，插件之间互相读不到 |
| `audio` | 在插件自己的私有目录里保存并播放音频（`audio.save/list/remove/play/stop/import`，单条上限 16 MiB） |

**没有 `background` 权限**：常驻帧由 manifest 的 `background` 字段申请、由既有的 `events` 权限门控。门禁里有一条「权限表与方法表逐项一致」的断言——每个权限都必须被某个方法使用，所以一个只用来"批准后台运行"、背后没有方法的权限会正好违反它。

**`audio` 不是 `storage` 的加宽**：`storage` 的接口是**文本**（插件自己的 JSON，以及像表情包那样被编码成 base64 的字节——能存，但代价是 4/3），`audio` 是**二进制、几百 KB 量级**而且要能直接播放。只想记住一个设置的插件，不该为此被授予一个它永远不用的音频出口。

示例插件申请 `llm.chat`、`pet.bubble`、`pet.surface`、`plugin.config`、`storage` 五项。它**不**申请 `net.fetch`（请求统一由宿主的 `llm.chat` 发出），因此它既不需要也不包含 `netHosts`。

语音插件申请 `audio`、`events`、`storage`、`plugin.config`、`net.fetch` 五项，并声明 `background: true` 与 `netHosts: ["127.0.0.1:9880"]`（它直连本机 GPT-SoVITS 渲染台词）。

安装完成时插件是**停用**状态：你可以先看清它申请的权限，再自行启用并逐项授权。插件调用了未授权的能力时，宿主会直接拒绝，且**不产生任何副作用**。

> **两个宿主程序的能力表不同。** 桌宠与市场共用同一套调度器与资源路由，但市场没有待办文件、没有番茄钟、没有宠物窗口，所以 `todos.*` / `timer.*` / `bubble.say` / `surface.*` / `llm.chat` / `events.subscribe` 从市场调用会得到「本程序不支持该方法」。插件界面被市场托管时（语音插件的配音工坊），这一点要记住。

---

## 4. 打包与发版

唯一路径是 `tools/package.ps1`，它本地、离线地做五件事（可重复运行，幂等）：

1. 读每个 `plugins/<id>/manifest.json`，校验 `id`/`version`/`entry`，并断言 `entry` 指向的文件与 `panel.html`/`app.js`/`style.css` 都在插件目录内；
2. **先删后建** `dist/<id>-<version>.zip`，把 `manifest.json` 与这些资源放在 **zip 根目录**（不带外层文件夹——桌宠直接解压进 `plugins/<id>/`，多一层目录会让 `manifest.json` 深一层而安装失败）；`assets` 列出的文件**也一并打进去**，声明了却不存在则**打包失败并点名**（语音插件的 5 条内置音频走这条路）；
3. 用 `Get-FileHash -Algorithm SHA256` 实算最终 zip 的 sha256（小写 64 位十六进制）；
4. 用**包内 manifest** 的 `name`/`version`/`author`/`description`/`permissions` 重写 `index.json` 里该条目的同名字段，并更新 `updatedAt`（RFC3339）。这样「目录里展示的权限」与「包里实际申请的权限」不可能漂移；
5. 把 zip 与 `index.json` 复制到宿主仓的内置源 `internal\plugins\sample\`（同名同字节），作为离线兜底。

> **升版本时要顺手删掉被取代的旧包**（`dist/` 与 `sample/` 各一份），并把
> `sample/embed.go` 的 `//go:embed` 清单改成新文件名。`embed.go` 是**逐一列出**文件名的
> （不是目录通配），所以清单不跟着改就会**编译失败**——这是好事，它逼着这一步不能忘。
> 清单之外多留一个旧 zip 不会被引用、也没有测试会报错，但它会让"这个版本到底发布的是哪一份"
> 变得需要猜，所以一并删掉。

运行：

```powershell
powershell -ExecutionPolicy Bypass -File tools\package.ps1
# 或 PowerShell 7：pwsh -File tools/package.ps1
```

该脚本**不**执行任何 git 命令、**不**联网、也**不**调用 npm / go / wails。它使用固定时间戳写 zip 条目，因此源码未变时重复运行得到的是**同一份字节**，sha256 不变。

发版即提交：

```powershell
git add dist/ index.json
git commit -m "feat: [AI-GEN] publish com.shixiansi.plugin-chat 1.3.0"
git push            # 由维护者手动执行，agent 不推送
```

### 插件必须跟随窗口主题（`data-theme`）

市场窗口有深/浅两套配色，而插件的工作区是 **sandboxed iframe 里的外来文档**：它看不到宿主的
CSS 变量，宿主也不能往里注入样式。所以是**宿主告知、插件自己画**，三条通道各管一段时间：

| 通道 | 什么时候 | 插件侧要做的 |
|---|---|---|
| `?theme=dark\|light` 挂在 frame URL 上 | **首帧之前** | `<head>` 里一个内联脚本读它，写到 `<html data-theme=…>`——这样浅色窗口不会先闪一下深色 |
| `init.theme` | 挂载后 | `onInit` 里 `applyTheme(data.theme)`；桌宠挂载时没有这个字段，一律深色 |
| `{v:1,type:'theme',theme}` 消息 | 用户在工坊开着时切主题 | 监听 `message`，改 `data-theme` 即可；**不要重挂页面**（会丢掉输入到一半的表单） |

插件侧的做法就是 CSS 里放两套调色板，keyed on `html[data-theme="light"]`：

```css
:root { --p-bg: #191b21; --p-text: #e8eaf0; /* … */ color-scheme: dark; }
html[data-theme="light"] { --p-bg: #f4f6fa; --p-text: #16202e; /* … */ color-scheme: light; }
```

比"浅色"更重要的是**别把颜色写死在规则里**：旧的两个插件（`chat`/`voice`）原本满是字面量，
这一轮先把它们收成 `--p-*` 变量再加浅色块——**深色的字节一个没变**。
`style.css` 里 `box-shadow`/`filter`/`transform` 依旧禁止（见上文裁剪约束），主题与那是两件事。

> 版本提醒：这一轮三个包都升了 patch（`chat` 1.4.1、`qq` 1.9.1、`voice` 1.0.1）；
> 之后 `qq` 因为提示词与人设的改动升到 **1.10.0**。插件是**安装时
> 复制进 `<dataDir>/plugins/<id>/`** 的，所以只改本仓源码、不重新打包并让市场装一次，用户看到的
> 仍是旧的那份。

### 示例插件的前端行为（`app.js`）

- 启动即向宿主发 `{v:1,type:'ready'}`；收到宿主回投的 `init` 后才按 `init.granted` 启用界面——缺 `llm.chat` 时输入区禁用且状态行显示「未获授权：llm.chat」，缺 `pet.bubble` / `pet.surface` 时对应按钮禁用。**`init` 之前不发起任何 `request`**。
- **一份文档、三种外观**：`init.surface.kind` 为 `'panel'` 时渲染会话视图（消息列表 + 输入框）；为 `'surface'` 时按 `init.surface.rectIndex` 渲染宠物上方的回复卡（`0`）或宠物下方的输入条（`1`）。三种外观的根元素 class 互不相同（`view-panel` / `view-card` / `view-bar`），这正是 `style.css` 区分它们的依据。
- **两个浮层面视图各画多少历史**：`history` 是同一份数组，面板画全部往来，回复卡**只画最后一条回复**（反向扫描第一条非 `user` 条目，而不是取末项——提问已发、回复未到时末项是提问）。`llm.*` 事件按 `pluginId` 投给**所有**界面，所以只有**发起请求的那一帧**写转写（holder 的 `owner` 标志），其余帧只显示；`stop` 会把该 requestId 记为已结束，迟到的分片不会把它重建出来。
- 流式回复（`llm.delta`）追加到**同一个文本节点**，该节点活到整条回复结束；`requestId` 不匹配的迟到分片一律丢弃；`llm.error` 渲染为一条系统行；`llm.done` 用宿主给的全量文本收口——**当全文与已累积内容不一致时整体替换显示文本**，而不是再追加一段，否则丢片修好的答复会重复半句。
- 对话记录由插件自己经 `storage.set` / `storage.get`（key `llm-history`）读写；宿主的 `llm.chat` **不写转写**。每日本次用量（`llm-usage`）由宿主唯一写。
- 「气泡」按钮发 `bubble.say`（取回复首行），「浮层面」按钮在 `surface.show` / `surface.hide` 之间切换。
- 样式纪律：`style.css` 中**没有** `box-shadow`/`filter`/`text-shadow`/`transform`——这些装饰会画到盒子之外，而面板槽位与浮层面都活在被区域裁剪的窗口矩形内。
- 输入框**没有 placeholder**、面板里**没有提示行**、也没有那三个思考泡泡的点层：输入框靠 `aria-label` 说明自己，省下来的高度留给消息列表。发送键是**纸飞机图标**（内联 SVG，`ph:paper-plane-tilt-fill`）而不是「发送」二字，可访问名走 `aria-label`——图标必须是内联的：这个文档跑在不透明源的沙箱里，取不到任何外部资源。

运行测试（需要宿主仓 `pet_PC` 的 `frontend\node_modules`，本仓通过目录 junction 复用，不自己再装一份）：

```powershell
node node_modules\vitest\vitest.mjs run
```

> **两套测试各覆盖一个插件**：`tests/plugin-app.test.js` 读
> `plugins/com.shixiansi.plugin-chat/` 的 `panel.html` 与 `app.js`（41 项）；
> `tests/plugin-voice.test.js` 读 `plugins/com.shixiansi.plugin-voice/` 的同名文件（39 项）。
> **两套都只驱动插件自己的前端**——宿主侧的
> **市场托管插件界面**那段（`tools/plugin-market/frontend/src/plugin-ui.js`，
> 210 行）**没有测试**。见宿主仓 `docs/voice.md` §8。

### QQ 群聊插件的人设与提示词（`app.js`）

人设是**用户自己写的**一段话（配置项 `persona`），它替换系统提示词的**第一段**，
插件在它下面追加固定规则。两边分工很硬：

- **人设管语气与人**：说话长短、脾气、口头禅、遇到什么事怎么反应。
- **插件管机制**：群里在哪个群、当前提问的人是谁、`replyMaxChars` 是**硬上限不是目标**、
  不要 Markdown/列表/emoji、不要重复上一条的开头与口癖、不知道就说不知道、
  末尾的〔表情:分类〕协议。
- **留空时的默认人设**（`DEFAULT_PERSONA`）写的是「群里的老熟人」，**不是**「一个待在
  QQ 群里的机器人」：模型被告知自己是机器人之后，写出来的就是助手腔——这是群聊里最
  显眼的一种人机味。

几条由真机测试换来的约定（改提示词前先读）：

1. **说话人昵称跟着当前这条提问一起进模型**（`昵称：内容`），与历史里的格式一致。
   只给历史加名字时，模型看不见"现在是谁在问"，会答成「你们」——像客服，不像群友。
2. **主动开口的提示词必须写"接住群友聊的那件具体的事"**，否则它会写成关于自己的旁白
   （"我先去囤点米饭"）。反过来**不要**写"最后一条是提示语，不是群友说的话"：实测加了
   这句，模型会认为整段群聊它没看到，答"没看到你们刚才聊啥"。
3. **〔表情:分类〕在两条路径上都要剥掉**（回答、主动开口）。它是模型与插件之间的协议，
   漏进群里就是一行乱码；主动开口原本没剥，模型自己加一个就会直接发出去。
4. **空回复要重试一次**。`qwen3.8-27b` 这类推理模型会把 token 预算花在 reasoning 上，
   然后返回 `finish_reason: "stop"` 的空 content；群里"不说话"是最像坏掉的一种表现。
5. **`*动作*` 转成中文括号**（`（甩了下尾巴）`）。只删星号会留下一个裸词，读起来像
   丢了括号的舞台指示。

### 语音插件的前端行为（`app.js`）

> 以下是**读代码**得到的描述，不是测试结论。逐条的依据见 `docs/voice.md` §8，
> 那里同时列出了**尚未完成**的部分（角色列表画不出来、「整套换成这个角色」没接线、
> `gptPath`/`sovitsPath` 填了却不发给引擎、没有 take 列表）。

- 一份文档、**两种外观**：`init.surface.slot === 'background'` 是桌宠挂的**常驻帧**
  （什么都不画，只 `events.subscribe` 两个边缘事件然后 `audio.play`）；
  否则就是**工坊**（由**市场程序**托管，不占桌宠面板）。两者的根 class 不同
  （`view-background` / `view-workshop`）。
- 事件的 payload **只有事实、没有措辞**：`timer.phaseEnded` 给 `{phase}`，
  `reminder.fired` 给 `{due,overdue,total}`；哪句话、用谁的嗓子由插件的 `LINES` 表与
  `resolveClipFor` 决定。
- 播什么走**一个**解析点 `resolveClipFor`：采用的那一版**必须**在宿主返回的
  `audio.list` 里，否则退回 `builtin-<line>`——它对着**宿主的清单**校验而不是信任自己存的
  `settings`，所以用户在插件外面删掉一个片段不会导致静音。
- 生成走 `net.fetch` 到本机 GPT-SoVITS，**必须** `encoding: 'base64'`（文本形式对 WAV 有损）；
  回复落 `audio.save`，**宿主确认写盘成功后**才把它记成"采用"，避免把桌宠指向一个还不存在
  （或永远不会存在）的片段。
- **插件不启动引擎**：`app.js` 里没有 `exec`/`spawn`，也没有任何启动进程的路径——
  "启动一个进程"若作为能力开放，等于给每个已装插件任意代码执行。
- 内置 5 条音频随包（manifest 的 `assets`），首次运行经 `audio.import` 复制进插件自己的
  `audio/` 目录一次（播放器只认私有目录里的名字，包是只读的）。
- 样式纪律与对话插件相同：`style.css` 里**没有** `box-shadow`/`filter`/`transform` 声明。

---

## 4.5 三个插件在控制中心里的样子（2026-10）

控制中心的**插件页**会挂载每个插件的文档，`init.surface` 是
`{ kind: 'panel', slot: 'workshop' }`——和桌宠给的 `slot`（`chat` / `todos` / `pomodoro`
/ `background`）不是同一个值。`slot === 'workshop'` 就是「我在一个管理窗口里」，三个插件的
文档各自据此决定**哪些事在这里不成立**：

| 插件 | 在 `workshop` 里 | 为什么 |
|---|---|---|
| 待办 `1.2.0` | 完整可用：列表、勾选、添加、删除（`storage`）。**每 2 秒重读一次**，写请求在飞时暂停轮询 | 同一个列表可能同时开在两个窗口（桌宠的槽位 + 这个页面）；挂载时只读一次会让另一边的改动看不见 |
| 番茄钟 `2.2.0` | **记录列表**（`pomodoro-records-v2`，新在前、最多 20 行）+ 最后状态；**倒计时按钮隐藏**，一行字说明「计时在桌宠上」 | 计时在桌宠的常驻帧里；这里的按钮发出的命令没人接，一个点了没反应的按钮比没有按钮更糟 |
| 对话 `1.7.5` | 历史照常渲染；**输入框只读**，状态行写「这里只显示记录；发送请在桌宠旁的对话浮层面」 | `llm.chat` 只由桌宠提供（预算与凭据在它手上）。控制中心**故意**不服务它：那会是第二个 LLM 路径 + 第二个写 `llm-usage` 的进程 |

两条由此而来、别踩的坑：

1. **`surface.slot` 是唯一的「我在哪」信号**，不要用 `kind`：常驻帧的 `kind` 也是 `panel`。
   番茄钟的 `onInit` 因此先判 `slot === 'background'`，再判 `workshop`。
2. **`plugin.share` 现在是两个宿主都服务的**（宿主侧 `internal/plugins/share.go`）。它以前只有
   桌宠服务，而待办与番茄钟的文档在 `share` 上发布/读取，于是「把浮层面插件挂进控制中心」
   会以「本程序不支持该方法 share.set」的形式失败——上一轮因此干脆不挂它们，等于把三个插件的
   界面藏起来了。规则只有一份，两个程序都调它。

番茄钟的设置项（`focusMinutes` / `shortBreakMinutes` / `longBreakMinutes` / `longBreakEvery` /
`autoStartNextPhase`）在 manifest 里**声明**，默认值与 `machine.js` 原本的兜底一致（25/5/15/4），
所以升级不会改掉正在用的人的专注时长；它们在控制中心的「设置」弹窗里编辑，插件自己负责读。

---

## 5. 桌宠侧：安装位置

安装后插件落在**用户数据目录**下：

```
%AppData%\PetPC\plugins\<插件id>\
%AppData%\PetPC\plugins.json               已装索引（启用状态 + 已授权限）
%AppData%\PetPC\plugin-data\<插件id>\      插件私有存储（storage / config / audio 能力唯一的可写落点）
%AppData%\PetPC\plugin-data\<插件id>\audio\<name>.wav   插件自己的音频（audio 能力）
%AppData%\PetPC\plugin-data\<插件id>\share\<name>       它发布到跨插件托盘的那份值（宿主写）
```

`storage` 的**键是相对路径**（`media/stickers/bytes/<hash>`、`media/video/tmp/<name>`），所以私有目录里
还能有插件自己分的文件夹；父目录由宿主建好，每一段仍然只认 `[A-Za-z0-9_-]`，所以
`..`、盘符、反斜杠都出不了目录。分隔符/路径规则写在 `internal/plugins/privatestore.go`，
桌宠与市场**共用**那一份实现——同一个键在两个程序里因此一样合法，而 QQ 插件的机器人跑在
桌宠、表情包工坊跑在市场。

即对话插件的安装目录是 `%AppData%\PetPC\plugins\com.shixiansi.plugin-chat\`，其中就是 zip 解压出来的 `manifest.json`、`panel.html`、`app.js`、`style.css`。

语音插件除了那四个文件之外还多一个 `lines\` 目录（5 条内置音频，来自 manifest 的 `assets`）。内置音频会在首次运行时被 `audio.import` **复制一次**进 `plugin-data\<id>\audio\`——播放器只认插件私有目录里的名字，包本身是只读的。

---

## 6. 桌宠侧：市场基址与镜像

桌宠从**一个可配置基址**拉取市场目录：`基址 + /index.json`；条目的 `download` 是**相对路径**，实际下载地址为 `基址 + / + download`。

默认基址走 `gh-proxy.com` 镜像（`raw.githubusercontent.com` 在部分网络下不可达）：

```
https://gh-proxy.com/https://raw.githubusercontent.com/shixiansi/pet-pc-plugins/main
```

在该基址下，本仓的 `index.json` 与插件包分别位于：

```
https://gh-proxy.com/https://raw.githubusercontent.com/shixiansi/pet-pc-plugins/main/index.json
https://gh-proxy.com/https://raw.githubusercontent.com/shixiansi/pet-pc-plugins/main/dist/com.shixiansi.plugin-chat-1.3.0.zip
```

基址可在桌宠的「设置」页里修改（点「打开插件市场」进市场程序改）；把它**清空**表示强制使用桌宠内置的示例源（离线兜底，内容与 `dist/` 同字节）。

### 换成别的仓名/镜像

如果实际使用的远端仓名与本仓不同，**只需要改两处**，产物与目录结构完全不变：

1. 本仓的远端地址：

   ```powershell
   git remote set-url origin https://github.com/<用户名>/<仓名>.git
   ```

2. 桌宠侧的市场基址（「插件」标签页里的输入框，或 `config.json` 的 `marketBaseUrl`）。

`download` 写的是相对路径，所以换仓名、换镜像前缀都不需要改动任何插件包或 `index.json`。

---

## 7. 本仓不含什么

- **本仓不含 exe，也不含任何构建产物**（桌宠本体的 `build/bin/`、前端 `frontend/dist/` 都不在这里）。桌宠本体请从私有仓 `pet_PC` 取源码后**自行 build**（该仓的 README 有构建步骤）。
- 本仓唯一的「产物」是 `dist/` 下的插件 zip——那是插件包，不是桌宠程序。
- 本仓不做 CI、不做 Release、不开 GitHub Pages：打包由 `tools/package.ps1` 在本地产出并提交，`index.html` 只是仓库里的一个静态文件，按需通过 raw 地址或上述镜像访问。

---

## 8. 提交规范

提交信息形如 `<type>: [AI-GEN] <一句话描述>`，`type` 取 `feat`/`fix`/`docs`/`chore`/`refactor`/`test`/`perf`/`ci` 之一，例如：

```
feat: [AI-GEN] add the chat sample plugin and the market packaging script
docs: [AI-GEN] document the mirror base URL and the install location
```
