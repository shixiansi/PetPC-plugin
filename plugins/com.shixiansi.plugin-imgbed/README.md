# 图床上传（com.shixiansi.plugin-imgbed）

把一张图传到一个 [CloudFlare-ImgBed](https://github.com/MarSeventh/CloudFlare-ImgBed) 图床
（默认 `https://imgcloud.shipixiv.de5.net`），拿回一条能直接贴出去的链接。

- **界面**：控制中心的「插件」页。拖进来、<kbd>Ctrl</kbd>+<kbd>V</kbd> 粘贴截图、或者选文件，
  一次可以多张；每张传完就地显示链接与「复制」。
- **桌宠那边**：只有一个不显示的常驻帧，用来答别的插件的 `plugin.call`（方法 `upload`）。
  宠物旁边没有它的格子——右键菜单那三格（日程 / 对话 / 番茄钟）由 `panelSlot` 声明，新插件没有
  格子可去，所以这一页就是它的正门。

## 它要的权限（4 项）

| 权限 | 为什么 |
| --- | --- |
| `net.fetch` | 上传就是一次 `POST {站点}/upload`。域名白名单是 `manifest.netHosts`（内置那台）∪ 你在设置里填的「图床地址」 |
| `plugin.config` | 图床地址、认证码、渠道、目录、命名 |
| `storage` | 「最近上传」的链接（条数可调，0 = 不记录） |
| `plugin.call` | 答其它插件的 `upload`（data URL，≤40KB） |

**没有 `process`**，也没有随包脚本：图片字节从页面直接进请求体（`net.fetch` 的 `bodyBase64`），
不需要启动任何本机程序。

## 设置

| 项 | 说明 |
| --- | --- |
| 图床地址 | 站点根，例如 `https://imgcloud.shipixiv.de5.net`（不要带 `/upload`）。它会被加进网络白名单 |
| 上传认证码 | 图床「系统设置 → 安全设置 → 上传认证」里的那个码 |
| API Token | 可选，替代认证码（图床「API Token 管理」创建，勾 `upload`）。填了它就走 `Authorization: Bearer` |
| 上传渠道 | 跟随站点默认最省事；站点只开了一个渠道时不用改 |
| 上传目录 | 相对路径，如 `img/pet`；留空 = 站点根目录 |
| 文件命名 | `前缀_原名`（站点默认）/ `只用原名` / `只用前缀` / `短链` |
| 最近上传留几条 | 0 = 不记录 |

认证码与 Token 都是**明文**存在这个插件自己的配置里：`secret` 型配置宿主读不回明文，也就没法替你
拼进请求 —— 这和「联网搜索」的 API Key 是同一个取舍，写在这里是为了让用户知道自己填的是什么。

## 它怎么发（给下一个读代码的人）

1. 图片字节从 `File`/粘贴板来（`FileReader` → `Uint8Array`）；
2. `lib/multipart.js` 把它拼成 `multipart/form-data` 的**字节**（boundary 在头与正文里出自同一个
   变量，所以不可能对不上）；
3. 整段字节 base64 后放进 `net.fetch` 的 `bodyBase64`，`content-type` 原样带上 boundary；
   地址带 `responseFormat=object&returnFormat=full`（默认是数组 + 相对路径，见 `lib/upload.js` 顶部）；
4. 回来的是一个对象或单元素数组，取 `publicUrl` / `src`，相对路径补上站点根。

## 已知边界

- **一张 15 MB**（宿主的 `net.fetch` 请求体上限是 16 MiB，这里留余量并给一句人话）。
- **不能"传一个网址"**：插件读不到别的网站上的图，得把文件本身给它。
- **`plugin.call` 那条路只有 40KB**：`plugin.call` 的 payload 上限是 64 KiB，而 data URL 是 base64。
  大图请在插件页里拖。
- **复制**用 `document.execCommand('copy')`：帧是 opaque origin，`navigator.clipboard` 需要宿主给
  iframe 加 `allow="clipboard-write"`（那会让每次复制都变成一次权限提示）。复制失败时链接仍然
  显示在屏幕上并被选中，用户自己 Ctrl+C。

## 自检

```powershell
node ../docs/plugin-testkit/plugin-check.mjs .
node ../docs/plugin-testkit/preview.mjs . --slot workshop --frame 900x1250 --shot out.png --bare
```

（`preview.mjs` 需要本机装有 Edge/Chrome；它给这个插件的 `net.fetch` 回一条**像真的**应答，
所以 `--shot` 能看到"上传成功"那一屏。）
