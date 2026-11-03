# 行情看板（com.shixiansi.plugin-finance-board）

宠物旁边一张 **300×150** 的小卡片：最多三个标的，每行「代码 · 现价 · ±x%」加一条 SVG sparkline。
控制中心的插件页里是完整列表（最多 8 个）、周期选择、行情源切换，以及一个标的列表编辑框。

不引任何第三方库，也不引 CDN：sparkline 是一条手写的 `<svg><polyline>`。

## 三个行情源

| 源 | 用来做什么 | 请求的地址 |
| --- | --- | --- |
| `yahoo` | 股票 / 基金 / 汇率 | `https://query1.finance.yahoo.com/v8/finance/chart/<symbol>?range=1mo&interval=1d` |
| `binance` | 加密（现价） | `https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT` |
| `binance` | 加密（走势） | `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=30` |
| `coingecko` | 第三个备选源（只取现价） | `https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd` |

三个源报价格的字段名与类型**都不一样**（`meta.regularMarketPrice` 是数字、币安的 `price` 是
字符串、CoinGecko 是嵌套的 `[coinId].usd`），`lib/sources.js` 是唯一把差异关起来的地方：出去的时候
一律是同一个形状 `{symbol, price, change, points}`，界面因此不需要知道数据来自哪个源。

**换行情源真的会换域名与路径**：不带前缀的标的跟随「默认行情源」那一项；带前缀的
（`yahoo:AAPL`、`binance:BTCUSDT`）按自己写的那一个源走。用例断言的就是 `net.fetch` 的 url。

## 规则

- **刷新间隔最少 10 分钟**（默认 30）。行情不是秒级数据，1 秒一刷只会烧掉配额、把日志写满。
  没有轮询，只有 `setTimeout` 排下一拍。
- **休市的股票不刷新**：`yahoo` 的标的在周六、周日**一个请求都不发**，表格里写「休市」，价格保留
  上一次的收盘价。`binance` / `coingecko` 是加密，7×24，同一天照常刷。
  节假日（元旦、圣诞…）与各交易所不同的收盘时间**没有判**——那要另一份交易日历，而猜错的代价是
  明明开着却整天不刷新。
- **失败不清空**：请求被拒、`status >= 400`、正文不是 JSON、`429` —— 价格与 sparkline 都留在原地，
  状态行写「上次成功是 X 前」，`429` 另外写「被限流」。一条都没成功时**不写**快照（写盘等于用
  "空"覆盖"有"）。
- **数字格式**：涨跌永远带 `+`/`-` 与两位小数；没有数据写「—」，不写 `0`。
  涨跌的红绿跟着 A 股习惯（红涨绿跌），要反过来只改 `style.css` 顶部那四个 token。

## 设置项（宿主的设置表单）

| key | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `targets` | text | `yahoo:AAPL` / `yahoo:0700.HK` / `binance:BTCUSDT` 各一行 | 一行一个「源:代码」，最多 8 个 |
| `source` | select | `yahoo` | 默认行情源（只影响不带前缀的标的） |
| `refreshMinutes` | number | `30` | ≥10 |
| `points` | number | `30` | sparkline 用几个点，5–120 |

宿主的设置表单里 `text` 是**单行** input，而换行在 `<input>` 的 value 里会被清洗掉。所以解析器
同时接受逗号、分号、空格作分隔（`yahoo:AAPL, binance:BTCUSDT` 一样能用），插件页里那个
textarea 是编辑列表的主要入口。

## 数据存在哪

- `market/snapshot` —— 上一次成功取到的行情（**缓存**，不是用户数据）。卡片与插件页都可能在
  刷新后写它，内容一致，后写的赢。
- `market/view` —— 浏览偏好（周期）。只由插件页写，卡片只读。

## 已知取舍

- **卡片由宿主打开，这个插件自己不会把它弹出来。** 宿主打开一个插件的浮层面只有两条路：右键菜单
  里某一格（`panelSlot` = `todos` / `pomodoro`，今天分别被待办与番茄钟占着）或插件自己调
  `surface.show`（那要求一个活着的帧，也就是声明 `background` / `panel`）。本插件两者都没有声明
  ——落点只有一块浮层面 + 插件页——所以真机上能看它的地方是控制中心「扩展能力」里的预览台。要让它
  常驻，得占用一个菜单槽或者加一条常驻帧，那是另一个决定。
- **`net.fetch` 能不能带自定义头**：能，但只在那四个白名单头里（`accept` / `authorization` /
  `content-type` / `user-agent`，手册 §6.10）。Yahoo 偶发会拒没有 `User-Agent` 的请求，所以这里
  带了 `user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) PetPC-finance-board/0.1.0`。
- **CoinGecko 只取现价**：它的 `simple/price` 没有走势。涨跌与 sparkline 按「—」画，不假装 0。
  要完整走势得再请求 `/api/v3/coins/<id>/market_chart` 那条路径（这轮没做）。
- 卡片正好三行（高度在 manifest 里声明死）：`style.css` 顶部的注释里写着那份预算，改行高要一起
  改它，否则内容会被原生区域裁掉，而且不报错。
