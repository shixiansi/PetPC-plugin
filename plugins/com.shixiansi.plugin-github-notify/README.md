# GitHub 通知（com.shixiansi.plugin-github-notify）

盯几个 GitHub 仓库的 **PR / Issue / CI**：有新动静就写成**一句摘要**（含仓库名与事件类型），
宠物头顶的 `pet.badge` 挂着未读数；插件页里是完整的事件列表与设置。

- 落点：`panel: true`（控制中心的插件页）+ `pet.badge` / `bubble.say` 两个**能力**。
  没有声明浮层面，也没有常驻帧。
- 权限：`net.fetch`、`storage`、`plugin.config`、`pet.surface`（`pet.badge` 借的就是它）、
  `pet.bubble`。
- 网络：只有 `api.github.com`（`netHosts` 里那一项，没有 `hostWhitelist`：GitHub 的域名是固定的）。

## 1. 用哪个接口，需要什么 scope

**`GET /repos/{owner}/{repo}/events?per_page=30`**（仓库事件）。

| 为什么是它 | |
| --- | --- |
| 不需要额外的 scope | `/notifications` 要求 token 带 `notifications` scope；`/events` 只要"能读这个仓库" |
| 404 能点名 | 请求里就是 `owner/repo`，所以"哪个仓库不存在"是请求的一部分，不是猜出来的 |
| 匿名也能读 | 公开仓库不填 token 也能读到（本插件仍然要求填 token：见第 3 节） |

**token 要什么权限**：只要读。

- classic token：勾 `repo`（只看公开仓库的话 `public_repo` 就够）；
- fine-grained token：目标仓库的 **Actions / Issues / Pull requests** 三项 Read。

插件同时认得 `/notifications` 形状的回答（标题在 `subject.title`、类型在 `subject.type`），
所以换端点时解析不用重写；但**它发出去的是 `/events`**。

`per_page=30` 是一次看多少条。GitHub 的仓库事件接口只保留最近 90 天、最多 300 条，
所以"很久没开机的机器"第一次打开时不会收到一场雪崩式的历史通知（也见第 4 节的去重）。

## 2. 设置项

| key | 类型 | 说明 |
| --- | --- | --- |
| `token` | text | Personal Access Token（见第 3 节：**为什么它是明文**） |
| `repos` | text | `owner/repo`，逗号分隔，最多 8 个；写错的条目会被忽略并在页面上说明 |
| `intervalMinutes` | number | 每隔几分钟抓一次，默认 10，**最少 5**（写 1 也只是 5） |
| `kinds` | select(multiple) | 只通知 PR / Issue / CI；全不勾 = 三类都要 |

`token` 或 `repos` 为空时**一个 `net.fetch` 都不发**，页面第一屏就是「先去设置里填」——
一个注定 401 的请求既浪费额度，也会让人以为是 token 写错了。

## 3. 为什么 token 是明文配置项（而不是 `secret`）

这是本插件唯一一处**故意偏离**"密钥只写不读回"的地方，原因是宿主的能力边界：

1. GitHub 只从 **`Authorization`** 头收 token（`?access_token=` 那条路早就废了）；
2. `net.fetch` 的请求头是白名单制，只有 `accept` / `authorization` / `content-type` /
   `user-agent`（`internal/plugins/fetchheaders.go`）。`authorization` **可以**设，但要先把
   token 读成字符串；
3. 而 `secret` 配置项的明文**永不出宿主进程**：`config.get` 只回 `{set, mask}`，
   `net.fetch {credentials}` 那条路是把密钥填进 **`Cookie`** 头（还要 `net.credentials` 权限）——
   `api.github.com` 不认 Cookie 里的 token。

三条放在一起：一个 `secret` 的 token 在本插件里**一个字节都用不出去**，用户填了会以为能用。
所以这一项是 `text`（明文存在本插件的私有配置里，`%AppData%\PetPC\plugin-data\<id>\config.json`），
而界面上、设置项的 label 里都写着这件事。

配套的克制：插件**只把 token 放进 `Authorization` 头**，不写日志、不回显、不拼进 URL
（URL 会进宿主的日志行）。

## 4. 同一件事只说一次

两层：

1. **事件 id 去重**（硬保证）。已处理过的事件 id 存在 `storage` 的 `notify/state` 里，
   只留最近 200 个（8 个仓库 × 30 条/轮，留得比一轮能抓回来的更多）。第二次抓到同一条，
   不再说话、不再涨未读数。
2. **条件请求（ETag / 304）**（能带就带）。上一轮的 `etag` 存在同一个键里；下一轮带
   `If-None-Match`，回答 `304` 时**不解析、不通知、不涨未读数**。`304` 的空正文不是
   "零个事件"，所以它有一条单独的、什么都不做的分支。

   但**今天真机上这一层是关着的**，有两个事实要记住：宿主的 `net.fetch` 既不回响应头
   （拿不到 `ETag`），也不允许 `if-none-match` 这个请求头（会被整条拒掉、请求根本发不出去）。
   所以代码的写法是"能带上就带"：一旦被拒（`net.fetch 不允许设置请求头`），就永久关掉这一层、
   改用不带校验器的同一个 URL 重发一次。也就是说：**去重永远靠第 1 层**，ETag 是等宿主放开
   响应头/请求头之后自动开始工作的一层，不需要改代码。

## 5. 徽标与气泡

- `pet.badge` 的文字是 `GitHub N`（≤16 字符，`N` 就是未读数），`0` 时推空串清除；
- **只在数值变化时推一次**。`pet.badge` 在宿主日志里是 DEBUG 级，每拍推一次等于自己造噪音；
- `bubble.say` 只推**一句**：单独一条是 `<仓库> 有新的 PR #12：<标题>`，多条是
  `<仓库> 有 3 条新动静（PR、CI）`。**不是把标题拼成一串**——气泡是让人抬头看一眼的。

**注意落点**：控制中心那一页没有宠物（手册 §9），所以徽标与气泡只在桌宠那边出现。这一版的
manifest 只有 `panel: true`（插件页），**没有声明桌宠侧的帧**，所以真机上这两个能力目前不会
被调用——那一行说明就写在插件页底部（「头顶那个未读徽标与那句话说在桌宠那边」）。
要让它们真的生效，需要给 manifest 加一块 `surface` 或 `background`（代码不用改：
`runCheck()` 在哪个窗口跑，就在哪个窗口通知）。

## 6. 每种失败对应的那句话

| 情况 | 界面上写 |
| --- | --- |
| `401` | token 无效或过期，去设置里换一个 |
| `403` + 正文里有 rate limit | 被限流了，N 分钟后自动重试（`x-ratelimit-reset` 有就按它算，没有就按轮询间隔） |
| `403` 其它 | GitHub 拒绝了这次请求（403）：这个 token 大概没有 `<owner/repo>` 的读权限 |
| `404` | 找不到 `<owner/repo>`：仓库名写错了，或者这个 token 看不到它 |
| `5xx` | GitHub 那边出问题了（HTTP 5xx），下一次轮询再试 |
| 宿主拒绝（未授权 / 未声明域名） | 宿主的原文照抄（`未获权限 net.fetch`、`net.fetch 未声明的域名` …） |
| 还没配置 | 先去设置里填（卡片的标题就是这四个字） |

一个仓库失败不会让另外七个停下来：每个仓库一条错误，其余照常。

## 7. 文件

```
manifest.json     声明
panel.html        入口（只有插件页那一副面孔）
app.js            消息泵 + 启动 + 测试接缝
lib/core.js       桥、授权、设置、小工具
lib/github.js     URL、两种响应形状、事件分类、一句话摘要、报错文案
lib/state.js      notify/state 一个键（seen / unread / recent / etags / lastAt）
lib/notify.js     一轮抓取：去重 → 写状态 → 徽标 → 气泡
lib/workshop.js   渲染、按钮、按分钟定时
style.css         这一页的布局（颜色全部来自 token）
ui.css            宿主 tokens 的逐字节副本（打包时必须写进 assets）
```
