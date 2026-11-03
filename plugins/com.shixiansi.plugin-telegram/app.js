// app.js —— 入口：宿主桥、握手、挂载分派、插件页渲染。
//
// 一个文档两副面孔（kind 都是 'panel'，按 slot 分）：
//   slot 'background'  常驻帧：读配置与 offset、启动轮询、持有收件箱、答 on_message。
//   slot 'workshop'    控制中心的插件页：状态、错误态、手动发送。不启动轮询。
//
// net.fetch 是 where:'both' 的方法（手册 §9 的表），所以插件页也能发手动消息——
// 发送是用户点了按钮才发生的那一次请求，不是常驻循环。轮询只属于常驻帧。
//
// 分层（与 habits / anniversary / convert-kit 一致）：lib 是纯 IIFE，桥归本文件；
// TelegramCore 通过 useBridge 拿到 request/can/hostServes 三个函数。

'use strict';

// --- 宿主桥 ------------------------------------------------------------------

const PROTOCOL = 1;
const PLUGIN_ID = 'com.shixiansi.plugin-telegram';
const HOST = window.parent;
let nextId = 1;
const pending = new Map();
const granted = new Set();

function request(method, payload) {
  const id = `tg${nextId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    HOST.postMessage({ v: PROTOCOL, type: 'request', id, method, payload: payload || {} }, '*');
  });
}

/** 一次 plugin.call 的回包。ticket 原样带回——带错了宿主不认，调用方只会等到超时。 */
function postCallResult(ticket, ok, valueOrErr) {
  const msg = ok
    ? { v: PROTOCOL, type: 'call-result', ticket, ok, result: valueOrErr }
    : { v: PROTOCOL, type: 'call-result', ticket, ok, error: String((valueOrErr && valueOrErr.message) || valueOrErr) };
  HOST.postMessage(msg, '*');
}

// --- 状态 --------------------------------------------------------------------

let slot = '';
let hostMethods = null;
let ready = false;

function can(name) { return granted.has(name); }

/** 这一面有没有"宿主服务这个方法"（§5.2.1）：有 host 表查表，没有退回 slot 猜。 */
function hostServes(method) {
  if (hostMethods) {
    if (hostMethods.indexOf('*') >= 0) return true; // 测试假宿主的通配表
    return hostMethods.indexOf(method) >= 0;
  }
  if (slot === 'workshop') return false;
  return true;
}

// --- 小工具 ------------------------------------------------------------------

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

function text(value, max) {
  const s = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  const limit = Number.isFinite(max) && max > 0 ? max : 200;
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

// --- 消息循环（监听器先装，再发 ready —— §5.3 第 1 条） --------------------------

function onResponse(data) {
  const waiter = pending.get(data.id);
  if (!waiter) return; // 迟到的 response：安全丢弃（§5.3 第 4 条）
  pending.delete(data.id);
  if (data.ok) waiter.resolve(data.result);
  else waiter.reject(new Error(data.error || '宿主拒绝了这次调用'));
}

function onMessage(event) {
  if (event.source !== HOST) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.v !== PROTOCOL) return;
  switch (data.type) {
    case 'init': void onInit(data).catch(() => {}); break;
    case 'response': onResponse(data); break;
    case 'theme': applyTheme(data.theme); break;
    case 'call': void onCall(data).catch(() => {}); break;
    default: break; // event / surface / 未知类型：忽略是协议要求的宽容
  }
}

window.addEventListener('message', onMessage);

/** 宿主转来的 plugin.call：必须回 call-result（手册 §6.8），错误也要回包。 */
async function onCall(msg) {
  try {
    const value = await TelegramCore.answerCall(String(msg.method || ''), msg.payload || {});
    postCallResult(msg.ticket, true, value);
  } catch (err) {
    postCallResult(msg.ticket, false, err);
  }
}

async function onInit(data) {
  granted.clear();
  for (const g of data.granted || []) granted.add(g);
  const surface = data.surface || {};
  slot = surface.slot || 'workshop';
  hostMethods = (data.host && Array.isArray(data.host.methods)) ? data.host.methods : null;
  applyTheme(data.theme);
  const root = document.getElementById('root');
  if (root) root.dataset.slot = slot;
  ready = true;

  if (slot === 'workshop') {
    await renderWorkshop().catch(() => {});
    return;
  }

  // 常驻帧（background）：读配置与游标，然后视配置情况决定启不启动轮询。
  try {
    await TelegramCore.refreshConfig();
    await TelegramCore.loadState();
  } catch (err) {
    paintBackground(`初始化失败：${text((err && err.message) || err, 120)}`);
    return;
  }
  if (!TelegramCore.configured()) {
    // 未配置：不发任何请求（必测第一条），状态行说清楚怎么配。
    paintBackground('未配置：填好 Bot Token 与默认 chat id 前不会发任何请求');
    return;
  }
  if (!can('net.fetch')) {
    paintBackground('未获授权 net.fetch：轮询不会开始');
    return;
  }
  paintBackground(`轮询中（offset ${TelegramCore.snapshot().offset}）`);
  TelegramCore.startPolling();
}

// --- 常驻帧的状态行 -----------------------------------------------------------

function paintBackground(line) {
  const el = document.getElementById('bg-status');
  if (el) el.textContent = line;
}

// --- 插件页渲染 ---------------------------------------------------------------

async function renderWorkshop() {
  const doc = document;
  const chipConfig = doc.getElementById('chip-config');
  const chipOffset = doc.getElementById('chip-offset');
  const chipInbox = doc.getElementById('chip-inbox');
  const facts = doc.getElementById('facts');
  const errBox = doc.getElementById('error');
  const sendBtn = doc.getElementById('send');
  const chatInput = doc.getElementById('chat-id');

  // 配置态：读 config（botToken 是普通项，读得到是否已填；不显示内容本身）。
  let configuredNow = false;
  let chatDefault = '';
  if (can('plugin.config')) {
    try {
      await TelegramCore.refreshConfig();
      configuredNow = TelegramCore.configured();
      chatDefault = TelegramCore.chatDefault();
    } catch { /* 读不到就按未配置画 */ }
  } else if (errBox) {
    errBox.hidden = false;
    errBox.textContent = '未获授权 plugin.config：读不到配置。';
  }

  // offset：常驻帧写进 storage 的游标（这里只显示）。
  let offsetNow = 0;
  if (can('storage')) {
    try {
      const out = await request('storage.get', { key: 'tg-offset' });
      offsetNow = Number.parseInt(String((out && out.value) || ''), 10) || 0;
    } catch { /* 显示 0 */ }
  }

  if (chipConfig) {
    chipConfig.textContent = configuredNow ? '已配置' : '未配置';
    chipConfig.className = `chip ${configuredNow ? 'ok-chip' : 'warn-chip'}`;
  }
  if (chipOffset) chipOffset.textContent = `offset：${offsetNow}`;
  if (chipInbox) chipInbox.textContent = `收件箱：${TelegramCore.snapshot().inboxCount} 条（本帧视角）`;
  if (facts) {
    const items = [
      `轮询：${configuredNow ? '已配置（常驻帧在长轮询 getUpdates）' : '未配置——一个请求都不会发'}`,
      `发送：${configuredNow ? '在下方手写并发送（唯一发送路径）' : '未配置，不可用'}`,
      `on_message：${can('plugin.call') ? '已声明（别的插件用 plugin.call 查询收件箱）' : '未获授权 plugin.call，答不了查询'}`,
      `共享键：${can('plugin.share') ? 'telegram-inbox（环形 20 条）' : '未获授权 plugin.share，发布不了'}`,
    ];
    facts.textContent = '';
    for (const line of items) {
      const p = doc.createElement('p');
      p.className = 'fact';
      p.textContent = `· ${line}`;
      facts.append(p);
    }
  }
  if (errBox && TelegramCore.snapshot().lastError) {
    errBox.hidden = false;
    errBox.textContent = TelegramCore.snapshot().lastError;
  }
  if (sendBtn) sendBtn.disabled = !configuredNow;
  if (chatInput && !chatInput.value) chatInput.value = chatDefault;
  paintNotes();
}

/** 手动发送（插件页唯一的发送入口；net.fetch 两个宿主都服务，这面能直接发）。 */
async function onSendClick() {
  const doc = document;
  const errBox = doc.getElementById('error');
  const status = doc.getElementById('send-status');
  const btn = doc.getElementById('send');
  const show = (msg) => { if (status) status.textContent = msg; };
  const fail = (msg) => {
    if (errBox) { errBox.hidden = false; errBox.textContent = msg; }
    show('发送失败。');
  };
  const target = String(doc.getElementById('chat-id').value || '').trim();
  const body = String(doc.getElementById('send-text').value || '').trim();
  if (!body) { fail('先写一句话再发。'); return; }
  if (!target) { fail('没有 chat id：先在设置里填默认目标，或在这里填一个。'); return; }
  btn.disabled = true;
  show('正在发送…');
  try {
    await TelegramCore.sendMessage(target, body);
    show('已发送。');
    doc.getElementById('send-text').value = '';
  } catch (err) {
    // 宿主的 error 是给人看的中文句子，原文显示（§5.3 第 5 条）。
    fail(text((err && err.message) || err, 200));
  } finally {
    btn.disabled = !TelegramCore.configured();
  }
}

// --- 事件尾巴（notes 渲染）-----------------------------------------------------

function paintNotes() {
  const logEl = document.getElementById('log');
  if (!logEl) return;
  logEl.textContent = '';
  for (const item of TelegramCore.snapshot().notes.slice(-10).reverse()) {
    const li = document.createElement('li');
    const when = new Date(item.at);
    const pad = (x) => `${x}`.padStart(2, '0');
    li.textContent = `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())} · ${item.line}`;
    logEl.append(li);
  }
}

// --- 接线：把桥递给 core，再补 DOM 事件，最后发 ready ----------------------------

TelegramCore.useBridge({ request, can, hostServes });
TelegramCore.setPaint(() => {
  if (slot === 'workshop') void renderWorkshop().catch(() => {});
  else paintBackground(TelegramCore.snapshot().lastError || '');
});

const sendBtn = document.getElementById('send');
if (sendBtn) sendBtn.addEventListener('click', () => { void onSendClick(); });

HOST.postMessage({ v: PROTOCOL, type: 'ready' }, '*');
