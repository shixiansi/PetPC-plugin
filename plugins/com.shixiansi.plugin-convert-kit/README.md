# 换算工具（com.shixiansi.plugin-convert-kit）

一个**完全离线**的换算器：长度、重量、体积、温度、速度、时区、进制，外加一份内置的汇率静态快照。

- 界面在**控制中心的插件页**里（`panel: true`，没有 `surface`）：选分类 → 选两组单位 → 拿结果，
  最近几次换算留在这一页（只在内存里）。
- 桌宠那边没有窗口，只有一帧**常驻帧**（`background: true`）。它存在的唯一理由是
  `serves: ["convert"]` 要有人接电话：`plugin.call` 只有在对方**此刻有帧**时才答得上话。
- **零网络**：manifest 里没有 `net.fetch`，也没有 `netHosts`。汇率是一份写死在
  `lib/units.js` 里的快照（日期见返回值里的 `note`），它不会自己变新，界面与返回值都把日期说出口。

## 权限（只申请用得到的三个）

| 权限 | 用在哪 |
| --- | --- |
| `plugin.call` | `serves: ["convert"]` 就是它门控的；没有它，别的插件问不了 |
| `storage` | 只为一件事：「上次用的那对单位」（键 `state/last-units`） |
| `plugin.config` | 读三个设置项（保留位数 / 默认分类 / 是否显示汇率一栏） |

没有 `net.fetch`、`pet.surface`、`pet.bubble`、`llm.chat`、`events`、`process`。

## 设置项（`config`）

| key | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `decimals` | `number` | `"2"` | 结果保留几位小数（0–8）。它会改 `text`，不改 `value` |
| `defaultCategory` | `select` | `length` | 打开插件页先显示哪一类（长度/重量/体积/温度/速度/时区/进制） |
| `showRates` | `bool` | `"true"` | 插件页里是否显示「汇率」一栏。它只是**显示**开关：`convert` 的汇率分类照常能问 |

用户改完设置后，两个宿主都会推一条 `config.changed`，插件收到就重读一次——不用重开插件页。

「汇率」不在 `defaultCategory` 的选项里（那七项是任务给定的清单），页面上的「汇率」一栏由
`showRates` 控制。两种情况都只是**显示**：`convert` 的 `currency` 分类一直能问。

## `serves.convert` —— 对外的唯一契约

别的插件在 manifest 里申请 `plugin.call` 并写 `callTargets: ["com.shixiansi.plugin-convert-kit/convert"]`，
然后：

```js
const out = await request('plugin.call', {
  target: 'com.shixiansi.plugin-convert-kit',
  method: 'convert',
  payload: { category: 'length', from: 'm', to: 'ft', value: 12.5 },
});
// out.text === '41.01'，out.value ≈ 41.0105，out.expression === '12.5 m = 41.01 ft'
```

### payload

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `category` | ✅ | `length` / `weight` / `volume` / `temperature` / `speed` / `timezone` / `base` / `currency`，**也认中文名**（长度 / 重量 / 体积 / 温度 / 速度 / 时区 / 进制 / 汇率） |
| `from` | ✅ | 源单位。写 `id`、`symbol` 或中文名都行（`kg` / `千克`） |
| `to` | ✅ | 目标单位，同上 |
| `value` | ✅ | 要换算的数值（数字或数字字符串；`"1,000"` 也认）。`base` 分类里是**进制数本身**（`"ff"`、`"-1011"`） |
| `time` | | 只有 `timezone` 用：`"HH:MM"`（也可以用 `value` 写）。分类换算不用它 |

`timezone` 的 `from` / `to` 是固定偏移的时区名：`UTC` / `UTC+8` / `UTC-5` / `UTC+5:30` ……
**不含夏令时**（那需要一整套 tzdata，而不是一个离线算术插件）。

`base` 的 `from` / `to` 就是基数本身：`"2"` / `"8"` / `"10"` / `"16"`。

### 返回（形状是钉住的：少字段就是破坏契约）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `category` | string | 分类 id（`length` …） |
| `from` / `to` | string | 单位的 `id`（不是你写进来的那个中文名） |
| `input` | number \| string | 归一化后的输入：标量类是数字，`base` 是原始字符串，`timezone` 是 `HH:MM` |
| `value` | number | **原始精度**的结果。`timezone` 是目标时区从 00:00 起的分钟数；`base` 是解析出来的十进制值 |
| `text` | string | 按保留位数四舍五入后的结果（给人看的那一个）。`base` 是目标进制的字符串（十六进制大写、负数带 `-`） |
| `unit` | string | 目标单位的符号（`ft` / `°C` / `CNY`；`base` 是 `基数 16`） |
| `expression` | string | 一整行「12.5 m = 41.01 ft」，可以直接显示 |
| `note` | string? | 只在有话要说时出现：汇率快照日期、绝对零度夹住、跨日 |
| `clamped` | bool? | `temperature` 专用：输入低于绝对零度，被夹住了 |
| `dayShift` | number? | `timezone` 专用：`1` = 次日、`-1` = 前一日、`0` = 同一天 |

`text` 永远不吐二进制浮点的尾巴：`0.1 + 0.2` 那条路给出 `0.3`（按保留位数四舍五入）。
比精度还小的非零值不会被说成 `0`，而是退回 3 位有效数字——换算是要拿去做判断的。

### 失败：一条点名原因的中文 error，**不抛给宿主**

| 情况 | error 长什么样 |
| --- | --- |
| 不认识的单位 | `不认识单位「市斤」——重量只认 mg / g / kg / t / lb / oz（中文名：毫克 / 克 / 千克 / 吨 / 磅 / 盎司）` |
| 不认识的分类 | `不认识分类「面积」（只认 长度 / 重量 / 体积 / 温度 / 速度 / 时区 / 进制 / 汇率）` |
| 不认识的进制 | `不认识进制「3」——进制只认 2 / 8 / 10 / 16（…）` |
| 数不合法 | `「12」不是合法的二进制数字（二进制只认 0 和 1）` |
| 时刻不合法 | `「25:99」不是一个时刻（时区换算要写成 HH:MM，例如 23:30）` |
| 不认识的方法 | `换算工具不认识 resize 这个方法（它只答 convert，payload 与返回形状见插件的 README）` |

**未知单位绝不静默按 1:1 换算。** 一个形状正常、内容错误的答案比一条错误信息坏得多：用户
（或调用方）没有第二次机会发现它。

## 私有数据

只有一个键：`state/last-units`（`{"category":"length","from":"m","to":"ft"}`）。
它记的是「上次用的那对单位」，下次打开插件页省一步。最近换算**只留在内存**里——它是顺手看看的
东西，为它写盘只会让宿主日志多出几行没用的 DEBUG。

## 自检

```powershell
cd F:\dev\pet_pc\market
node docs/plugin-testkit/plugin-check.mjs plugins/com.shixiansi.plugin-convert-kit
npx vitest run tests/plugin-convert-kit.test.js
```

## 文件

| 文件 | 是什么 |
| --- | --- |
| `manifest.json` | 清单（三权限 / panel / background / serves convert / 三个设置项） |
| `panel.html` | 入口文档：控制中心的插件页 |
| `app.js` | 握手 + 两条路的接线（界面 / 常驻帧的 `convert`） |
| `lib/core.js` | 与宿主说话的桥、设置、存储、小工具 |
| `lib/units.js` | 换算表（**只有数据**，每条都写了它是怎么来的） |
| `lib/convert.js` | `convert()`：分类分派、格式化、点名拒绝 |
| `lib/panel.js` | 插件页界面（分类标签、两个自绘下拉框、最近换算） |
| `ui.css` | 宿主 `docs/ui/petpc-ui.css` 的**逐字节副本**（iframe 是 opaque origin，变量进不来） |
| `style.css` | 只写这一页特有的布局，一个色值都没有 |
