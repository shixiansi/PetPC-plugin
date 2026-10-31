#!/usr/bin/env node
// tools/dashboard-bridge.mjs —— web-dashboard 的本机看板服务
//
// 插件沙箱里没有端口可监听；这个桥在宿主侧起 HTTP 服务，把"浏览器里能打开的
// 看板"做出来：
//
//   GET  /           → 看板单页（内联 token 副本，纯 CSS 柱状图，零外部依赖）
//   GET  /api/data   → 聚合 JSON（读各插件私有目录里由 collectOnce 写下的
//                      state/last-data；chat 部分由桥直接统计 memcore 的
//                      mem/role/** 文件数与大小）
//   POST /api/refresh → 立即重读（其实 /api/data 每次都现读，这个端点只是给
//                      SPA 的刷新按钮一个明确的落点）
//
// 数据目录：--data=<PetPC 数据目录>，默认 ./dashboard-data。各插件的私有目录按
//   <data>/plugin-data/<插件id>/state/last-data
// 查找（与宿主的数据布局一致；目录不存在就当插件未装）。
//
// 用法：
//   node tools/dashboard-bridge.mjs [端口] [--data=目录]
//   node tools/dashboard-bridge.mjs 23260 --data="%AppData%/PetPC"

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.argv[2]) || 23260;
const DATA_ARG = (process.argv.find((a) => a.startsWith('--data=')) || '').split('=').slice(1).join('=');
const DATA_ROOT = path.resolve(DATA_ARG || path.join(process.cwd(), 'dashboard-data'));

const PLUGIN_IDS = {
  dashboard: 'com.shixiansi.plugin-web-dashboard',
  memcore: 'com.shixiansi.plugin-memcore',
};

/** token 副本：优先从桥脚本所在仓的 docs/ui 找（本仓内启动），其次当前目录。 */
function loadTokens() {
  const candidates = [
    path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', 'docs', 'ui', 'petpc-ui.css'),
    path.join(process.cwd(), 'docs', 'ui', 'petpc-ui.css'),
    path.join(DATA_ROOT, 'petpc-ui.css'),
  ];
  for (const file of candidates) {
    try {
      return String(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
  }
  return '/* token 副本缺失：请把 docs/ui/petpc-ui.css 放在桥旁边 */';
}
const TOKENS = loadTokens();

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function pluginFile(id, rel) {
  return path.join(DATA_ROOT, 'plugin-data', id, ...rel.split('/'));
}

/** chat 一路：memcore 的 mem/role/** 现统计（桥有文件权限，插件没有）。 */
function chatStats() {
  const roleDir = path.join(DATA_ROOT, 'plugin-data', PLUGIN_IDS.memcore, 'mem', 'role');
  let sessions = 0;
  let bytes = 0;
  let turns = 0;
  let lastDay = '';
  try {
    for (const session of fs.readdirSync(roleDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      sessions += 1;
      const dir = path.join(roleDir, session.name);
      for (const file of fs.readdirSync(dir)) {
        const full = path.join(dir, file);
        let stat;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        bytes += stat.size;
        if (file === 'turns') {
          try {
            turns += JSON.parse(fs.readFileSync(full, 'utf8')).length;
          } catch {
            // 坏文件不算。
          }
        } else if (file === 'l3') {
          try {
            const l3 = JSON.parse(fs.readFileSync(full, 'utf8'));
            if (Array.isArray(l3) && l3.length) lastDay = String(l3[l3.length - 1].day || lastDay);
          } catch {
            // 同上。
          }
        }
      }
    }
  } catch {
    return null; // memcore 未安装/未使用
  }
  if (!sessions) return null;
  return { sessions, turns, bytes, lastDay };
}

function aggregate() {
  const dashboardData = readJson(pluginFile(PLUGIN_IDS.dashboard, 'state/last-data')) || {};
  return {
    at: Date.now(),
    chat: chatStats() || dashboardData.chat || null,
    todo: dashboardData.todo || null,
    pomodoro: dashboardData.pomodoro || null,
    plugins: [
      { id: PLUGIN_IDS.memcore, name: '记忆核心', state: dashboardData.chat ? 'ok' : 'unknown' },
      { id: 'com.shixiansi.plugin-todo', name: '待办', state: dashboardData.todo ? 'ok' : 'unknown' },
      { id: 'com.shixiansi.plugin-pomodoro', name: '番茄钟', state: dashboardData.pomodoro ? 'ok' : 'unknown' },
    ],
  };
}

function page() {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>桌宠状态看板</title>
<style>${TOKENS}</style>
<style>
  body { margin: 0; padding: var(--space-6); background: var(--bg); color: var(--text); font: var(--font); }
  .page { max-width: 960px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-5); }
  h1 { font-size: 20px; margin: 0; }
  .muted { color: var(--text-dim); font-size: 13px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-4); }
  .card { background: var(--bg-raised); border-radius: var(--radius-xl); box-shadow: var(--sh-sm); padding: var(--space-5); }
  .card h2 { font-size: 13px; color: var(--text-dim); margin: 0 0 var(--space-2); font-weight: 600; }
  .big { font-size: 30px; font-weight: 600; margin: 0; }
  .bars { display: flex; flex-direction: column; gap: var(--space-2); margin-top: var(--space-3); }
  .row { display: flex; align-items: center; gap: var(--space-2); }
  .label { width: 84px; font-size: 12px; color: var(--text-dim); }
  .track { flex: 1; height: 14px; background: var(--bg-sunken); border-radius: var(--radius-full); overflow: hidden; }
  .fill { height: 100%; background: var(--accent); border-radius: var(--radius-full); min-width: 2px; transition: width 240ms var(--ease); }
  .value { width: 56px; text-align: right; font-size: 12px; }
  .plugins { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .tag { padding: 2px 10px; border-radius: var(--radius-full); background: var(--accent-soft); color: var(--accent-strong); font-size: 12px; }
  button { padding: 8px 16px; border: none; border-radius: var(--radius); background: var(--accent-strong); color: #fff; font: inherit; cursor: pointer; }
</style>
</head>
<body>
<div class="page">
  <header><h1>桌宠状态看板</h1><p class="muted" id="updated">读取中…</p></header>
  <div class="grid" id="cards"></div>
  <div class="grid" id="charts"></div>
  <div class="card">
    <h2>插件</h2>
    <div class="plugins" id="plugins"></div>
    <p style="margin-top:16px"><button id="refresh">刷新数据</button></p>
  </div>
</div>
<script>
  function card(title, big, sub) {
    return '<div class="card"><h2>' + title + '</h2><p class="big">' + big + '</p><p class="muted">' + (sub || '') + '</p></div>';
  }
  function chart(title, rows) {
    const body = (rows || []).map((r) =>
      '<div class="row"><span class="label">' + r.label + '</span><div class="track"><div class="fill" style="width:' + r.pct + '%"></div></div><span class="value">' + r.value + '</span></div>'
    ).join('') || '<p class="muted">暂无数据</p>';
    return '<div class="card"><h2>' + title + '</h2><div class="bars">' + body + '</div></div>';
  }
  function pct(v, max) { return Math.min(100, Math.round((v / (max || 1)) * 100)); }
  async function refresh() {
    const data = await (await fetch('/api/data')).json();
    document.getElementById('updated').textContent = '更新于 ' + new Date(data.at).toLocaleTimeString();
    const cards = [];
    cards.push(data.todo ? card('待办', data.todo.done + '/' + data.todo.total, '完成率 ' + data.todo.completionRate + '%') : card('待办', '—', '未安装'));
    cards.push(data.pomodoro ? card('专注', data.pomodoro.focusMinutesToday + ' 分钟', '今天 ' + data.pomodoro.focusSessions + ' 个番茄') : card('专注', '—', '未安装'));
    cards.push(data.chat ? card('对话', String(data.chat.turns), '最近 ' + (data.chat.lastDay || '—')) : card('对话', '—', '未安装'));
    document.getElementById('cards').innerHTML = cards.join('');
    const charts = [];
    charts.push(data.todo ? chart('待办分布', [
      { label: '已完成', value: data.todo.done, pct: pct(data.todo.done, data.todo.total) },
      { label: '进行中', value: data.todo.open, pct: pct(data.todo.open, data.todo.total) },
    ]) : chart('待办分布', []));
    charts.push(data.pomodoro ? chart('专注统计', [
      { label: '今日番茄', value: data.pomodoro.focusSessions, pct: pct(data.pomodoro.focusSessions, data.pomodoro.focusSessionsTotal) },
      { label: '累计番茄', value: data.pomodoro.focusSessionsTotal, pct: 100 },
    ]) : chart('专注统计', []));
    document.getElementById('charts').innerHTML = charts.join('');
    document.getElementById('plugins').innerHTML = (data.plugins || []).map((p) => '<span class="tag">' + p.name + '</span>').join('');
  }
  document.getElementById('refresh').addEventListener('click', refresh);
  refresh();
  setInterval(refresh, 30000);
</script>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page());
    return;
  }
  if (url.pathname === '/api/data') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(aggregate()));
    return;
  }
  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(aggregate()));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'no route' }));
});

server.listen(PORT, () => {
  console.log(`看板桥已启动：http://127.0.0.1:${PORT}/（数据目录 ${DATA_ROOT}）`);
});
