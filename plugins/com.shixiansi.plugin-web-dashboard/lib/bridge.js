// lib/bridge.js —— 看板桥的客户端说明（占位）
//
// 与 email-digest 的桥同理：唯一的 HTTP 交互（读插件 storage 的 last-data、
// 提供浏览器页面）由 tools/dashboard-bridge.mjs 在宿主侧完成，插件的沙箱里
// 没有任何端口可监听。本文件是这份说明的载体，保证 assets 引用稳定。
//
// 桥的协议：
//   GET /            → 看板单页（内联 token 副本 + fetch 轮询 /api/data）
//   GET /api/data    → {at, chat, todo, pomodoro, plugins:[…]}（聚合自插件目录）
//   POST /api/refresh → 让桥立即重读插件数据文件
