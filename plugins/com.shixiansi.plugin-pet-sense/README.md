# 系统与 DSH 感知（plugin-pet-sense）

桌宠的眼睛与耳朵。它做两件事，一个常驻帧：

1. **系统负载感知**：每 5 秒采样 CPU 与内存，负载**持续**超过阈值（默认 3 次 = 15 秒）时，
   在宠物头顶挂「系统很忙」徽标，并把快照发布到共享键 `sense/system` 与 `sense/load`。
2. **DSH 状态感知**：在本机 `127.0.0.1:3210` 起一个 HTTP 服务，接收 DSH 推来的
   `POST /api/state`（`thinking` / `tool` / `done` / `error` 四个状态），映射成
   桌宠头顶的状态徽标与共享键 `sense/dsh`。

## 数据流

```
本机辅助脚本（pet-sense-helper.ps1，宿主按 manifest 的 sidecar 启动）
  ├── 每 5s 采样 CPU/内存 ──写──> outbox/system
  ├── 连续 N 次超阈值     ──写──> outbox/load
  ├── HTTP :3210 ← DSH    ──写──> outbox/dsh
  └── GET /health         ──写──> outbox/health
                （文件名没有扩展名：存储键不是文件名，带 .json 会被宿主判非法）
                 常驻帧每 1s 轮询
                        │
                        ├── share.set  sense/system · sense/load · sense/dsh
                        └── pet.badge  思考中… / 工具:xxx / 系统很忙
别的插件 ──shareRead: sense/*──> 只读快照
别的插件 ──plugin.call status──> 一次拿全当前快照
```

## 事件映射

| DSH 状态 | 徽标 | 共享键 |
| --- | --- | --- |
| `thinking` | 思考中… | `sense/dsh` = `{state:"thinking",…}` |
| `tool` | 工具:`<名>`（≤16 字符） | 同上，`tool` 字段 |
| `done` | （清除徽标） | `{state:"done",…}` |
| `error` | （清除徽标） | `{state:"error", note,…}` |

负载事件是**边沿触发**的：进入高压与恢复各发一次，中间的"仍然高"不重复发——
每 5 秒刷一次屏没有信息量。判定在辅助脚本侧完成（连续 N 次），插件只消费"已经判好的事件"。

## 接 DSH

```bash
curl -X POST http://127.0.0.1:3210/api/state \
  -H 'Content-Type: application/json' \
  -d '{"state":"thinking"}'
# 204 No Content；非四状态之一 → 422；GET /health → "ok"
```

## 启用

采样与监听需要本机脚本，但**不需要填任何路径**：`manifest.json` 里声明了
`sidecar: {script: "pet-sense-helper.ps1"}`，宿主在插件启用、且用户授予 `process` 时自己启动它，
脚本从 `PETPC_PLUGIN_DATA` 拿到该往哪写。（0.1.4 之前要手填 `helperPath` / `helperScript`，
那一步是"装好了但什么也没有"的主要来源。）

没有辅助脚本在跑时插件只读已有的 outbox（例如别的机器推过来的），不会报错。

## 权限

`process`（启动辅助脚本）· `plugin.share`（发布快照）· `plugin.call`（回答 `status`）
· `pet.surface`（借它的授权挂徽标）· `storage`（outbox 与状态）· `plugin.config`（设置）。

## 测试

```bash
npx vitest run tests/plugin-pet-sense.test.js   # 19 条：判定纯函数 / 轮询 / 徽标 / plugin.call / PS1 协议
```
