// app.js —— 隐私卫士：入口、协议泵、轮询、启动辅助脚本、plugin.call 应答
//
// 一个文档，两种身份：
//
//   workshop    控制中心插件页：试验台（手动粘贴扫描）、规则开关、告警历史。
//   background  桌宠常驻帧：轮询辅助脚本的 outbox → 扫描 → 脱敏 → 发布 → 弹气泡。
//
// 隐私边界（插件的自我要求）：扫描在本机完成；发布出去的告警**只含规则名与风险级别**
// 和一段 ≤60 字的上下文预览（同样已脱敏），绝不发布原文。

'use strict';

const V = 1;
const HOST = window.parent;
let nextId = 1;
const pending = new Map();

const PERM = {
  process: 'process',
  storage: 'storage',
  config: 'plugin.config',
  share: 'plugin.share',
  call: 'plugin.call',
  surface: 'pet.surface',
  bubble: 'pet.bubble',
};

function request(method, payload) {
  const id = `r${nextId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    HOST.postMessage({ v: V, type: 'request', id, method, payload: payload ?? {} }, '*');
  });
}

let granted = new Set();
let self = { pluginId: '', slot: '' };
let cfg = {};
let toggles = PrivacyPatterns.defaultToggles();
let seenHashes = new Map();
let alertLog = [];   // share/面板里的告警历史
let pollGen = 0;
let helperStarted = false;

window.addEventListener('message', (event) => {
  if (event.source !== HOST) return;
  const data = event.data;
  if (!data || data.v !== V) return;
  switch (data.type) {
    case 'init':
      void onInit(data);
      break;
    case 'response': {
      const slot = pending.get(data.id);
      if (!slot) return;
      pending.delete(data.id);
      if (data.ok) slot.resolve(data.result);
      else slot.reject(new Error(data.error || '宿主拒绝了这次调用'));
      break;
    }
    case 'theme':
      document.documentElement.dataset.theme = data.theme === 'light' ? 'light' : 'dark';
      break;
    case 'call':
      void onCall(data);
      break;
    default:
      break;
  }
});

// --- 配置与持久化 ----------------------------------------------------------------

async function refreshConfig() {
  if (!granted.has(PERM.config)) return;
  try {
    const out = await request('config.get', {});
    cfg = Object.assign({}, (out && out.values) || {});
  } catch {
    cfg = {};
  }
  // 规则开关存 config（bool 项）。
  for (const rule of PrivacyPatterns.RULES) {
    const v = cfg[`rule_${rule.id}`];
    if (v !== undefined) toggles[rule.id] = v !== 'false';
  }
}

async function saveToggle(ruleId, on) {
  if (!granted.has(PERM.config)) return;
  try {
    await request('config.set', { values: { [`rule_${ruleId}`]: on ? 'true' : 'false' } });
  } catch {
    // 保存失败下次还是旧值，不阻塞。
  }
}

async function loadAlerts() {
  if (!granted.has(PERM.storage)) return;
  try {
    const out = await request('storage.get', { key: PrivacyWatch.ALERTS_KEY });
    if (out && out.value) {
      const parsed = JSON.parse(out.value);
      if (Array.isArray(parsed)) alertLog = parsed;
    }
  } catch {
    alertLog = [];
  }
}

async function persistAlerts() {
  if (!granted.has(PERM.storage)) return;
  try {
    await request('storage.set', { key: PrivacyWatch.ALERTS_KEY, value: JSON.stringify(alertLog) });
  } catch {
    // 存不下就算了。
  }
}

// --- 辅助脚本（由宿主托管：manifest 的 sidecar） ----------------------------------
//
// 插件**不再**自己 process.launch。它拿不到自己的安装目录，于是"自己启动"必然要求用户在设置
// 里手填两个绝对路径——2026-10-31 的实测是四个这样写的插件因此从来没跑起来过（界面上只是
// "没有数据"）。现在宿主在插件启用、且用户授予 process 时启动它，脚本从 PETPC_PLUGIN_DATA
// 拿到该往哪写（见 privacy-guard-helper.ps1 的 -OutDir 默认值）。
//
// 这里只剩下"界面上该说什么"。

function helperNote() {
  helperStarted = granted.has(PERM.process);
  if (!helperStarted) return '未获授权：process（只能手动扫描）';
  return '监控脚本由宿主托管（桌宠启动时自动运行；没起来就看桌宠日志）';
}

// --- 轮询：outbox → 扫描 → 动作 ---------------------------------------------------

async function pollOnce() {
  const actions = [];
  for (const key of [PrivacyWatch.POLL_KEY, PrivacyWatch.POLL_FILE_KEY]) {
    const raw = await request('storage.get', { key }).catch(() => ({ value: '' }));
    if (!raw || !raw.value) continue;
    let record;
    try {
      record = JSON.parse(raw.value);
    } catch {
      continue; // 坏 JSON：等脚本下一轮覆写。
    }
    record.source = key === PrivacyWatch.POLL_KEY ? 'clipboard' : 'file';
    const outcome = PrivacyWatch.processRecord(record, {
      toggles,
      seenHashes,
      alertLog,
      cooldownMs: Math.max(1, Number(cfg.alertCooldownMin) || 10) * 60 * 1000,
      now: () => Date.now(),
    });
    if (outcome) actions.push({ key, outcome });
  }
  return actions;
}

async function runPollCycle() {
  if (!granted.has(PERM.storage)) return;
  let actions;
  try {
    actions = await pollOnce();
  } catch {
    return;
  }
  for (const { outcome } of actions) {
    if (!outcome.log) continue; // 无发现：只更新了 hash，无事可做
    // 发布告警（只含元信息 + 已脱敏预览，不含原文）。
    if (granted.has(PERM.share)) {
      const payload = {
        at: outcome.log.at,
        source: outcome.log.source,
        path: outcome.log.path,
        risk: outcome.log.risk,
        rules: outcome.log.rules,
        preview: outcome.log.preview,
      };
      await request('share.set', { name: 'privacy-alert', value: JSON.stringify(payload) }).catch(() => {});
    }
    if (outcome.alert && granted.has(PERM.bubble)) {
      await request('bubble.say', { text: outcome.alert.text }).catch(() => {});
    }
    alertLog = PrivacyWatch.pushAlerts(alertLog, outcome.log);
    await persistAlerts();
    if (self.slot === 'workshop') PrivacyWorkshop.gwsRenderAlerts(alertLog);
  }
}

function startPolling() {
  const gen = ++pollGen;
  const tick = async () => {
    if (gen !== pollGen) return;
    await runPollCycle();
    if (gen === pollGen) setTimeout(tick, 2000);
  };
  tick();
}

// --- plugin.call ----------------------------------------------------------------

const CALL_HANDLERS = {
  /** 扫一段文本（别的插件在发出去之前先自查）。payload {text, toggles?} */
  scan: async (payload) => {
    const text = String((payload && payload.text) ?? '');
    if (!text) return { findings: [], redacted: '', count: 0, risk: 'none' };
    const out = PrivacyPatterns.redact(text, (payload && payload.toggles) || toggles);
    return { findings: out.findings, redacted: out.text, count: out.findings.length, risk: PrivacyPatterns.riskLevel(out.findings) };
  },
  /** 最近告警。 */
  alerts: async (payload) => {
    const n = Math.max(1, Math.min(50, Number(payload && payload.limit) || 10));
    return alertLog.slice(0, n);
  },
  /** 当前规则开关表。 */
  rules: async () => ({ toggles: { ...toggles } }),
};

async function onCall(data) {
  const ticket = typeof data.ticket === 'string' ? data.ticket : '';
  if (!ticket) return;
  const method = typeof data.method === 'string' ? data.method : '';
  const handler = CALL_HANDLERS[method];
  if (!handler) {
    postCallResult(ticket, false, new Error(
      `隐私卫士不认识方法 ${method || '(空)'}：它只回答 ${Object.keys(CALL_HANDLERS).join(' / ')}`));
    return;
  }
  try {
    postCallResult(ticket, true, await handler(data.payload === undefined ? {} : data.payload));
  } catch (err) {
    postCallResult(ticket, false, err);
  }
}

function postCallResult(ticket, ok, value) {
  const message = { v: V, type: 'call-result', ticket, ok: Boolean(ok) };
  if (ok) message.result = value === undefined ? null : value;
  else message.error = String(value && value.message ? value.message : value);
  HOST.postMessage(message, '*');
}

// --- 工坊页 ---------------------------------------------------------------------

function runProbe() {
  const input = PrivacyWorkshop.GWS.els && PrivacyWorkshop.GWS.els['probe-input'];
  const text = String((input && input.value) || '');
  const out = PrivacyPatterns.redact(text, toggles);
  PrivacyWorkshop.gwsRenderProbe({ findings: out.findings, redacted: out.text });
}

async function copyProbe() {
  const output = PrivacyWorkshop.GWS.els && PrivacyWorkshop.GWS.els['probe-output'];
  if (!output || !output.textContent) return;
  // 沙箱里没有 navigator.clipboard 写权限；把结果放回输入框让用户自己复制。
  const input = PrivacyWorkshop.GWS.els && PrivacyWorkshop.GWS.els['probe-input'];
  if (input) input.value = output.textContent;
  PrivacyWorkshop.gwsSetStatus('脱敏结果已放回输入框，直接复制即可');
}

async function onInit(data) {
  self = {
    pluginId: data.pluginId || '',
    slot: (data.surface && data.surface.slot) || '',
  };
  granted.clear();
  for (const name of data.granted || []) granted.add(name);
  document.documentElement.dataset.theme = data.theme === 'light' ? 'light' : 'dark';

  await refreshConfig();
  if (granted.has(PERM.storage)) await loadAlerts();

  if (self.slot !== 'workshop') {
    // 常驻帧：辅助脚本由宿主启动，这里只轮询它写的文件。
    helperNote();
    startPolling();
    return;
  }

  PrivacyWorkshop.gwsCollectEls();
  PrivacyWorkshop.gwsRenderRules(PrivacyPatterns.RULES, toggles, (ruleId, on) => void saveToggle(ruleId, on));
  PrivacyWorkshop.gwsRenderAlerts(alertLog);
  PrivacyWorkshop.GWS.els['probe-run']?.addEventListener('click', runProbe);
  PrivacyWorkshop.GWS.els['probe-copy']?.addEventListener('click', () => void copyProbe());
  PrivacyWorkshop.gwsSetChip(helperStarted ? '监控中' : '手动模式');
  if (!granted.has(PERM.process)) {
    PrivacyWorkshop.gwsSetStatus('未授予 process：自动监控没启动，试验台仍可用');
  }
}

HOST.postMessage({ v: V, type: 'ready' }, '*');

/** 测试接缝。 */
window.__privacy = Object.freeze({
  request,
  handlers: CALL_HANDLERS,
  pollOnce,
  runPollCycle,
  helperNote,
  runProbe,
  patterns: PrivacyPatterns,
  watch: PrivacyWatch,
  workshop: PrivacyWorkshop,
  snapshot: () => ({
    slot: self.slot,
    granted: [...granted],
    cfg: { ...cfg },
    toggles: { ...toggles },
    seenHashes: [...seenHashes.entries()],
    alertCount: alertLog.length,
    helperStarted,
  }),
});
