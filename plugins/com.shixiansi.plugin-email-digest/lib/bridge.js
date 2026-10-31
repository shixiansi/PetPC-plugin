// lib/bridge.js —— 邮件桥的客户端（占位：digest.js 直接调 net.fetch）
//
// 这个文件保持为空壳的原因：邮件桥只有一支会被调用的端点（/unread），
// 它的调用方在 lib/digest.js 的 fetchUnread 里，挨着它的错误处理放在一起。
// 独立成一个文件反而会让"桥说什么样"与"怎么发请求"分家。
//
// 桥的协议（tools/mail-bridge.mjs，Node 实现，IMAP 连接由桥自己管）：
//   GET /ping              → {ok:true, account:"…"}（桥自己探测，插件不用）
//   GET /unread?limit=N    → {mails:["<RFC822 原文>", …]}
//
// MIME 解析在插件侧做（lib/mime.js），桥只负责"从 IMAP 拿原文"——这样解析逻辑
// 可以在没有 IMAP 的情况下被完整测试（测试直接喂 RFC822 文本）。
