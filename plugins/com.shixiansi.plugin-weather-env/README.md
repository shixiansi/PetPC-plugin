# 天气与环境感知（plugin-weather-env）

桌宠出门前提醒你带伞。默认接入 **Open-Meteo** 公开天气 API（免密钥），也可配置
和风天气；`get_weather(city)` 工具让模型能回答任意城市的天气，下雨 / 雷雨 / 下雪 /
晴天高温时在桌宠头顶挂出提醒徽标并推送状态事件（同一事件 3 小时只提醒一次）。

## 数据流

```
Open-Meteo（默认）/ 和风天气（配 Key 后）
  ├── geocoding：城市名 → 经纬度 / location id
  └── current：温度 · 天气码 · 风速
                 常驻帧每 60min 拉一次默认城市
                        │
                        ├── storage.set   weather/last（快照，每次都存）
                        ├── share.set     weather/now + weather/condition（3h 节流）
                        └── pet.badge     ☂ 出门带伞 / ⚡ 有雷雨 / ❄ 下雪路滑 / ☀ 注意防晒
模型/别的插件 ──plugin.call get_weather {city}──> {city, condition, tempC, text}
```

## 提醒规则（纯函数，集中在一处）

| condition | 徽标 | 说明 |
| --- | --- | --- |
| `rain` | ☂ 出门带伞 | WMO 码 51–67、80–82 |
| `thunder` | ⚡ 有雷雨，别在室外久留 | 95–99 |
| `snow` | ❄ 下雪路滑 | 71–77、85–86 |
| `sunny` 且 ≥32℃ | ☀ 今天很晒，注意防晒 | 码 0；不高温不提醒 |
| `cloudy` / `fog` | （不提醒） | 码 1–3 / 45、48 |

**节流**：同一城市同一事件 3 小时内只提醒一次；被节流的轮询不推迟"下次可以提醒"
的时间戳。原始快照每次都存（工坊页要显示），节流的只是"打扰"。

## Tool 的返回形状

```jsonc
// plugin.call { method: "get_weather", payload: { "city": "上海" } }
{ "city": "上海", "condition": "rain", "tempC": 18, "text": "上海：雨 18°C，风速 12 km/h，出门带伞。" }
```

不带 `city` 用默认城市（config `defaultCity`）。找不到城市返回一句能拿去修的中文：
`找不到城市：诺亚星`。

## 接入

接入了大模型的插件在 manifest 里加：

```json
"callTargets": ["com.shixiansi.plugin-weather-env/get_weather"]
```

## 数据源

- **Open-Meteo**（默认，免 Key）：`geocoding-api.open-meteo.com` + `api.open-meteo.com`；
- **和风天气**（可选）：设置里填 `qweatherKey` 后启用，走 `geoapi.qweather.com` +
  `qweatherHost`（免费订阅 `devapi.qweather.com`）。

域名白名单在 manifest 的 `netHosts` 里，两家的四个域名都已声明。

## 权限

`net.fetch` · `plugin.share` · `plugin.call` · `pet.surface` · `storage` · `plugin.config`。

## 测试

```bash
npx vitest run tests/plugin-weather-env.test.js   # 18 条：WMO 归一化 / 双源解析 / 节流 / Tool / 请求形状
```
