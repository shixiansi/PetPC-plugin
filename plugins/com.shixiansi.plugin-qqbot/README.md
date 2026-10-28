# QQ 官方机器人插件（com.shixiansi.plugin-qqbot）

把大模型接进 **QQ 官方机器人**（QQ 开放平台 [q.qq.com](https://q.qq.com)）：
桌宠的常驻帧维持一条到官方网关的 WebSocket 长连接，群里被 @ 或收到单聊消息时，
用宿主的 `llm.chat` 生成回答，再通过官方 REST 接口**被动回复**回去。

> 与仓库里另一个 `com.shixiansi.plugin-qq`（走 Milky 协议端的**个人号**机器人）是
> 两个不同的插件：那个连的是 NapCat/Yogurt 之类的第三方协议端，这个连的是腾讯官方
> 的 `api.bot.qq.com`。两者可以共存，但不建议同时开（会在同一个群里抢着回答）。

## 接入架构

```
QQ 开放平台网关 ──wss──▶ 宿主 (net.ws，宿主代持连接)
                              │ event: ws.message / ws.state
                              ▼
                       插件常驻帧 (background)
                         ├─ gateway.js  AccessToken 鉴权 / Identify / 心跳 / Resume
                         ├─ inbound.js  事件去重、触发判定、频控
                         ├─ llm.js      历史管理 + llm.chat（默认借用对话插件配置）
                         └─ sender.js   net.fetch POST 被动回复（msg_id / msg_seq）
```

## 使用步骤

1. 在 [QQ 开放平台](https://q.qq.com) 创建机器人，在「开发设置」拿到 **AppID** 与 **AppSecret**；
2. 安装本插件，在设置里填入 AppID 与 AppSecret，重启桌宠；
3. 在开放平台把机器人添加到群（或开通单聊），群里 **@ 机器人** 即可对话，单聊直接发消息。

## 官方平台规则（插件已经替你守住的部分）

| 规则 | 插件的行为 |
| --- | --- |
| 群聊被动回复：收到消息后 5 分钟内有效，每条消息最多回 5 次 | 每条消息最多回 4 次（留 1 次余量），超窗口的回复记录到日志后放弃，不重试骚扰 |
| 同一 `msg_id + msg_seq` 重复发送会失败 | `msg_seq` 从 1 开始递增，计数存在会话状态里 |
| 相同事件可能重复推送 | 事件 `id` 内存去重（最近 256 条） |
| AccessToken 7200 秒有效 | 缓存在内存里，过期前 2 分钟自动换新；401 时自动换一次再重试 |
| 断线重连可补发事件 | 断线后先尝试 `Resume`（session_id + seq），被拒（op9）再重新 `Identify` |
| `GROUP_AT_MESSAGE_CREATE` / `C2C_MESSAGE_CREATE` 都在 intents `1<<25` | 默认订阅 `群+单聊+频道公域`，可在设置里收窄 |

## 文件结构

```
manifest.json        权限、netHosts（仅 api.bot.qq.com）、配置项
panel.html           一份文档两种身份：background 帧是机器人本体，workshop 是看板
app.js               消息泵 + 启动接线 + 测试接缝 window.__qqbot
style.css            工坊页样式（深浅两套主题）
lib/core.js          桥、配置加载、storage 助手（会话历史 / 日志）
lib/gateway.js       token + 网关生命周期（Hello/Identify/Resume/心跳/看门狗）
lib/inbound.js       事件归一化、去重、群白名单、冷却
lib/llm.js           人设、历史裁剪、llm.chat 调用
lib/sender.js        被动回复（群/单聊/频道三种端点）、msg_seq 预算
lib/workshop.js      机器人总装配 + 工坊页渲染
```

## 自检与打包

本插件自带两组测试，不需要宿主程序、也不需要 jsdom：

```bash
# 1) 纯逻辑：intents、事件归一化、去重、白名单、msg_seq 预算
node tests/qqbot-gateway.test.js

# 2) 端到端：假宿主 + 真插件代码，走完
#    init → config.get → 换 token → GET /gateway → ws.open → Hello → Identify
#    → READY → 群 @ 消息 → llm.chat → POST /v2/groups/{openid}/messages
node tests/qqbot-e2e.test.js
```

端到端那一组断言的是**发出去的 HTTP body**：`msg_id` 必须是用户那条消息的 id、
`msg_seq` 必须是 1 且同一条消息第二次回复递增到 2、`content` 必须是模型的原话。
这三样错任何一个，官方接口都不会把消息显示出来，而且不会报错。

外加上游仓的自检工具（manifest / 包内文件 / 静态红线 / 协议四组）：

```bash
node docs/plugin-testkit/plugin-check.mjs plugins/com.shixiansi.plugin-qqbot
# protocol 那一组（假宿主把文档真的跑一遍）要 jsdom：
#   cd plugins/com.shixiansi.plugin-qqbot && npm i -D jsdom
# 跑完删掉 node_modules 与 package.json —— 它们不该留在插件目录里。
```

打包（zip 根目录就是 `manifest.json`，不要多包一层目录）：

```bash
cd plugins/com.shixiansi.plugin-qqbot
zip -r -X ../../dist/com.shixiansi.plugin-qqbot-1.0.0.zip \
  manifest.json panel.html app.js style.css README.md lib
```

## 已知边界（诚实清单）

- **AppSecret** 存在用户本机插件的配置文件里（普通 `text` 配置项）。官方换 token 的接口
  要求把 secret 放进 JSON body，而平台的 `net.fetch` 的 `credentials` 只能把 secret 填进
  Cookie 头，覆盖不到 body——所以 `secret` 类型配置在这个场景用不上。插件绝不把
  AppSecret 打进日志或显示出来。
- 单聊的**富媒体/卡片消息**（message_type ≠ 0/101）不支持回答，只记日志。
- 图片、语音等富媒体**收发**都未实现（官方上传接口分单聊/群聊两套，且需要分片上传），
  本版本只做文本。
- 频道场景只支持公域 `AT_MESSAGE_CREATE`（`PUBLIC_GUILD_MESSAGES`），私域机器人
  需要的 `GUILD_MESSAGES` intents 没有订阅。
