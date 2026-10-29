# 记忆核心（plugin-memcore）

人设与记忆只在这里存一份：接入端插件（QQ、OneBot 等）把它收到的每句话用
`plugin.call` 交给这里，这里拼好上下文、问模型、把这一轮记下来再把回答交回去。
装了联网搜索插件后，记忆答不上的问题它会先上网查资料再回答（auto / always / off 三档）。

**0.3.0 新增：定时记忆压缩。** 每天凌晨，把前一天在 L1/L2 里的往来压成一段
**≤200 字**的 L3 长期摘要，按天存档进长期记忆库——情节（L3）从此有了**叙事**，
不只是散点事实。

## 五层记忆

| 层 | 存哪 | 是什么 | 上限 |
| --- | --- | --- | --- |
| L0 | config | 人设，每一轮整段注入 system | — |
| L1 | `mem/role/<会话>/turns` | 最近几轮往来（原文） | 8 轮滚动 |
| L2 | `mem/role/<会话>/summary` | 会话摘要（L1 满了压出来） | 500 字 |
| L3 | `mem/role/<会话>/episodes` | 情节：值得长期记住的事实 | 40 条，丢最旧 |
| **L3 每日** | `mem/role/<会话>/l3` | **0.3.0：每天一段 ≤200 字的长期摘要** | 60 条，丢最旧 |
| L4 | `mem/user/<用户>/profile` | 用户画像（跨会话） | — |

## 定时记忆压缩（0.3.0）

```
每天凌晨（本地 00:00 过后第一跳）
  ├── 读 state/compact.lastDay —— 已压到哪天（幂等的游标）
  ├── 列出 mem/role/ 下的全部会话（storage.list，不猜键名）
  └── 对每个会话 × 每个未压的天：
        输入：当天的 L1 往来 + 当前 L2 摘要 + 已有的最后一段 L3
        问模型：{"summary":"…"} —— ≤200 字的连贯叙事
        写回：mem/role/<会话>/l3（同一天重压会替换，不堆叠）
        记账：chain 里留一条 kind:"l3"
```

**三道触发，互相独立，都幂等**：定时（每分钟看一次钟，日期一变就跑）、
启动补跑（宿主半夜重启错过定时）、`plugin.call compact`（工坊页与测试）。

**连贯性**：压缩请求的 prompt 里永远带着"上一段长期摘要"（第一条除外）——模型接住
前文的故事线往下写，而不是把每天写成孤岛。

** Why 凌晨跑**：L1 是 8 轮滚动缓冲，当天的原文在夜里还在、第二天就被挤掉——压缩要
赶在 L1 滚掉之前。若用户几天没开桌宠，L1 只剩最近 8 轮，那就压手头有的 + L2 兜底。

### 手动触发

```jsonc
// 压"到昨天为止"的默认路径（推进 lastDay 游标）
plugin.call { method: "compact", payload: { "daysBack": 1 } }
// 补压指定的一天（不改 lastDay；工坊页"补录"用）
plugin.call { method: "compact", payload: { "day": "2026-10-29" } }
// → { lastDay, days: [{day, roleKey, ok, skipped, reason}], daysTotal, ok, skipped }
```

设置里的 `compactEnabled` 开关（默认开）关掉后不启动定时器；`plugin.call compact`
仍可用。

## `plugin.call` 的方法

| 方法 | 谁调用 | 说明 |
| --- | --- | --- |
| `chat` | 接入端 | 一次问答：拼上下文 → 问模型 → 记录 → 返回 |
| `seed` | 接入端 | 把接入端已攒的记忆并进来（一次性导入） |
| `compact` | 工坊页 / 测试 | 手动触发压缩（见上） |

## 测试

```bash
npx vitest run tests/plugin-memcore.test.js          # 28 条：分层隔离 / 晋升 / 协议
npx vitest run tests/plugin-memcore-compact.test.js  # 13 条：压缩判定 / 幂等 / 100 轮压力测试
```

压力测试模拟 100 轮对话（10 天 × 每天轮次）后逐日压缩，验证：

- 每一次压缩请求的 prompt 都带着上一段 L3（故事线连续）；
- L3 存档按天有序、同一天唯一、每条 ≤200 字、总量 ≤60 条；
- 每条 L3 在 chain 里留了账。
