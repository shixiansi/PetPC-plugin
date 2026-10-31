# 媒体同步（plugin-media-sync）

桌宠知道你正在听什么。Windows 的"系统正在播什么"住在 SMTC（System Media Transport
Controls）里——网易云、QQ 音乐、Spotify、浏览器播放器都会把当前曲目注册进去。
本插件由本机辅助脚本读它，然后：

- 模型可用的 **Tool**：`now_playing` —— 用户问「我在听什么」，接入了大模型的插件把它
  转发过来，答案直接可放进模型上下文；
- 宠物头顶的**徽标**：`♪ 晴天 - 周杰伦`（暂停时 `⏸`，≤16 字符）；
- 共享键 `media-now`：完整曲目快照，工坊页与其它插件只读。

## 数据流

```
media-helper.ps1（宿主按 manifest 的 sidecar 启动，读 WinRT SMTC）
  └── 每 2s 原子写 outbox/media {title, artist, album, status, at}
                 常驻帧每 1s 轮询
                        │
                        ├── share.set        media-now
                        ├── pet.badge        ♪ 曲目（变化才重挂）
                        └── storage.set      最近听过（≤10 条）
别的插件 ──plugin.call now_playing──> {playing, title?, artist?, album?, status?, text}
```

## Tool 的返回形状

`plugin.call { method: "now_playing" }`，四种答案，给模型的话不撒谎：

```jsonc
// 在放
{ "playing": true, "title": "晴天", "artist": "周杰伦", "album": "叶惠美",
  "status": "playing", "text": "正在播放《晴天》 —— 周杰伦 （专辑：叶惠美）" }
// 暂停
{ "playing": false, "status": "paused", "text": "…（已暂停）" }
// 没在放 / 没数据
{ "playing": false, "text": "现在没有在放歌。" }
// 辅助脚本坏了
{ "playing": false, "text": "拿不到播放状态：WinRT 不可用：…" }
```

## 接入（以记忆核心为例）

任何接入了大模型的插件在自己的 manifest 里加：

```json
"callTargets": ["com.shixiansi.plugin-media-sync/now_playing"]
```

然后把用户「我在听什么」的问题用 `plugin.call` 转发，`result.text` 放回模型上下文。
（与 `com.shixiansi.plugin-websearch/search` 同一条路。）

## 启用

**不需要填任何路径**：`manifest.json` 里声明了 `sidecar: {script: "media-helper.ps1"}`，宿主在
插件启用、且用户授予 `process` 时自己启动它，脚本从 `PETPC_PLUGIN_DATA` 拿到该往哪写。
（0.1.5 之前要用户手填 `helperPath` / `helperScript` 两个绝对路径，那一步是"装好了但什么也没有"
的主要来源。）

macOS / Linux / 未开播放器时没有数据——插件把"没有数据"显示为"现在没在放"，而不是报错。

## 权限

`process` · `plugin.share` · `plugin.call` · `pet.surface` · `storage` · `plugin.config`。

## 测试

```bash
npx vitest run tests/plugin-media-sync.test.js   # 17 条：解析 / Tool 答案 / 徽标 / 轮询 / PS1 协议
```
