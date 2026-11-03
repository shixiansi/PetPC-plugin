# Telegram 接入端（薄适配器）

把 Telegram 接进桌宠的**记忆核心**：它在桌宠的常驻帧里长轮询 Telegram，收到一句话就交给
`com.shixiansi.plugin-memcore` 的 `chat` 方法，再把回答发回去。

## 它只是管道

这句话不是谦辞，是设计边界。这个插件里**没有**人设、没有记忆、没有模型配置，也**不**存
任何对话：

| 住在这个插件里的 | 住在记忆核心里的 |
| --- | --- |
| Telegram 的 Bot API 形状（`getUpdates` / `sendMessage`） | 角色名、人设、表达风格 |
| `update_id` 游标（防重复）与断网退避 | L1 滚动缓冲 / L2 摘要 / L3 长期记忆 / L4 用户画像 |
| 「这条消息该不该接」的判断（chat id 白名单、只读 `message.text`） | 模型、渠道、每日额度、联网搜索 |

为什么这条边界要紧：一旦适配器开始自己记东西，同一份记忆就有两个副本，而两个副本迟早会说出
不一样的话。反过来说，换一个平台（QQ、OneBot）只是加一层新的管道，人设改一次全平台生效。

另一个方向也能走：别的插件可以用 `plugin.call` 问它 `on_message`，把一句话交给这个管道，
自己完全不必认识 Telegram 的 API（见下面「给别的插件用」）。

## 配置

| 设置项 | 说明 |
| --- | --- |
| `botToken` | `@BotFather` 发给你的那一串（`123456:AA…`）。**默认空 = 一个请求都不发。** |
| `allowedChats` | 允许的 chat id，逗号分隔。**留空 = 谁的都不收**（不是"全都收"）。 |
| `pollEnabled` | 轮询开关，默认**关**。填好 token 之后要把它打开。 |
| `pollCount` | 每次 `getUpdates` 取几条 update，1–100，默认 20。 |

不知道自己的 chat id？把某一句话让它收一次：不在名单里的会写一行日志（**只写 chat id，不写
正文**）——`收到 chat 123456789 的消息，但不在允许名单里（把它填进设置就能收）`。

### 为什么 Bot Token 是 `text` 而不是 `secret`

Telegram 的令牌必须出现在请求**路径**里：`https://api.telegram.org/bot<token>/getUpdates`。
而 `secret` 配置项的明文**永不出宿主进程**（`config.get` 对 secret 只回 `{set, mask}`），
`net.fetch` 唯一能替插件用 secret 的地方是 Cookie 头（还要 `net.credentials`），覆盖不到 URL。
所以「secret + 能用」这两件事在现在的宿主里凑不到一起，这个插件选了「能用」，并把代价写明：

- token 明文存在**你自己的**插件私有目录里（和 `com.shixiansi.plugin-weather-env` 的
  `qweatherKey` 是同一个取舍）；
- 它不进日志、不进面板、不进错误文本：`plugin.log` 与面板的每一行都过 `redact()`，`sendMessage`
  与 `getUpdates` 的失败一律只报 HTTP 状态码与一句人话，不报 URL。

顺带一个宿主侧的坑：`net.fetch` 连不上时会把 Go 的 `*url.Error` 原文交回来，而那段文本里带
着整个 URL（含 token）。所以这个插件**从不**把 `err.message` 里跟 `net.fetch` 有关的部分原样
写出去，`redact()` 是第二道闸门。

## 收：长轮询 25 秒

```
getUpdates?offset=<游标>&timeout=25&limit=<pollCount>
```

**为什么是 25 秒**：宿主的 `net.fetch` 有自己的超时 —— `app_plugins.go` 里
`http.Client{Timeout: 30 * time.Second}`（手册 §6.10 只写了域名白名单与 8 MiB 上限，没有写这一
条，这里是去代码里确认的）。25 < 30，每一轮都还在宿主的超时之内，服务器替我们等着，这段时间
里没有一次往返，也不需要「短轮询 + 15 秒间隔」那种更吵的形状。

如果将来宿主把这个超时改到 25 秒以下，正确的应对是退回 `timeout=0` 的短轮询 + 15 秒间隔
（`lib/api.js` 顶部的 `LONG_POLL_SECONDS` 是唯一要改的地方）。

**成功之后立刻拉下一轮（间隔 0）**，那不是"1 秒轮询"：真实节奏由服务器那一侧决定——它已经替
我们等了 25 秒，或者手里正好有积压的 update 值得马上处理。被限流时（429）等的是 Telegram 指定的
秒数，断网时等的是 15 秒起步的退避，没配置好时等的是 15 秒——**没有任何一条路是 1 秒**。

**没有 `setInterval`**：循环是一条自调度的 `while`，每一拍的间隔由上一条的结果决定
（`lib/poll.js`）。固定的 `setInterval` 无法表达「断网就退避 30 秒、被限流就等 12 秒」。
工坊页那一页的 15 秒是兜底刷新（没有 `events` 权限，收不到 `config.changed`）。

## 三种"不顺利"，三种说法

| 情况 | 这个插件做什么 |
| --- | --- |
| **401**（token 不对 / 被 @BotFather 撤销） | 停下来说清楚，**60 秒**后重看设置。不会拿一个错 token 每 15 秒去撞墙。 |
| **409**（同一个 token 只允许一个 `getUpdates`） | 说清楚「另一个进程在用同一个 bot 的长轮询」，**30 秒**后再看。抢是抢不来的。 |
| **429**（被限流） | 读 Telegram 给的 `parameters.retry_after`（读不到再从 `description` 里抠），**等它要求的秒数**。 |
| 断网（`net.fetch` 抛错 / HTTP 502、503 / 看不懂的答复） | 退避重连：**15 → 30 → 60 → 120 → 240 → 300** 秒封顶；**成功一次就重置回 15**。 |

退避为什么要"成功一次就重置"：一次成功说明网络真的回来了，继续用 5 分钟的间隔等只会让下一句
话迟到 5 分钟。

## 只处理 `message.text`

贴图、语音、视频、文件、位置、频道消息（`channel_post`）、机器人发来的消息、`/start` 之外的
一切非文本 update —— 一律**安全忽略**，并在 `plugin.log` 里留一行（等级 `info`），说明跳过的是
**哪一种**。原因很实际：把一张贴图交给记忆核心，得到的只会是一段瞎猜。

## 处理链路

```
update ──▶ 游标（update_id 已见过？） ──▶ message.text？ ──▶ chat 白名单？ 
        ──▶ plugin.call com.shixiansi.plugin-memcore/chat {roleId, userId, userName, text, platform}
        ──▶ sendMessage 发回同一个 chat
```

- **`offset` 防重复**：游标（下一条要的 `update_id`）存 `state/offset`，活过重启。比游标小的
  update 直接丢弃 —— Telegram 会重发上一轮没确认成功的 update，少了这一步同一条消息会被回答两次。
- **`roleId`** 是 `telegram:<chat id>`：一个 Telegram 会话就是记忆核心里的一份会话，所以私聊与
  各群各自的记忆互不串味。
- **记忆核心报错时**，对方只收到一句「我这边出错了，稍后再试」。内部错误原文（宿主的拒绝、模型
  配置、额度、堆栈）只进宿主日志 —— 那是这台机器的内部信息，不该发给聊天对面的人。

## 给别的插件用

`serves: ["on_message"]`：

```js
// 只回答，不发出去
const out = await call('com.shixiansi.plugin-telegram', 'on_message', {
  text: '今天几号', roleId: 'telegram:123456789',
});
// out = { reply, sent: false, messageId: null, roleId }

// 回答并让 bot 在某个 chat 里说出来（chat 必须在允许名单里）
await call('com.shixiansi.plugin-telegram', 'on_message', {
  text: '到点了', chatId: '123456789',
});
```

## 界面

- **常驻帧**（`slot:"background"`，桌宠挂的那份）：`display:none`，只跑轮询。不读布局、不算尺寸、
  不碰焦点；状态在内存 + `storage`（`state/offset`、`state/status`、`state/notes`）。
- **工坊页**（`slot:"workshop"`，控制中心挂的那份）：状态、只读的设置摘要、事件尾巴。它**一个
  `net.fetch` 都不发** —— 控制中心不服务那条循环该有的东西，一个点了没反应的开关比没有更糟。

## 文件

| 文件 | 是什么 |
| --- | --- |
| `app.js` | 宿主消息泵、启动接线、`plugin.call` 的 `on_message` |
| `lib/core.js` | 桥、配置、私有存储、事件行 |
| `lib/api.js` | 两条 Bot API 调用 + 429 的 `retry_after` |
| `lib/pipeline.js` | update → 文本 → 记忆核心 → 发回 |
| `lib/poll.js` | 一拍、退避阶梯、游标、状态 |
| `lib/workshop.js` | 工坊页渲染 |
| `ui.css` | 宿主 tokens 的**逐字节**副本（`docs/ui/petpc-ui.css`） |
