// lib/workshop.js —— 工坊页渲染（只管画）
'use strict';

const GWS = { els: null };

function gwsCollectEls() {
  GWS.els = {};
  for (const id of [
    'chip-status', 'probe-input', 'probe-run', 'probe-copy', 'probe-summary',
    'probe-output', 'rules', 'alerts', 'alerts-empty', 'status', 'fatal',
  ]) {
    GWS.els[id] = document.getElementById(id);
  }
  return GWS.els;
}

function gwsSetStatus(text, kind) {
  const el = GWS.els && GWS.els.status;
  if (!el) return;
  el.textContent = String(text || '');
  el.classList.toggle('danger', kind === 'danger');
}

function gwsSetChip(text) {
  const chip = GWS.els && GWS.els['chip-status'];
  if (chip) chip.textContent = String(text || '');
}

/** 试验台结果：摘要 + 脱敏全文。 */
function gwsRenderProbe(result) {
  const summary = GWS.els && GWS.els['probe-summary'];
  const output = GWS.els && GWS.els['probe-output'];
  const copy = GWS.els && GWS.els['probe-copy'];
  if (!summary || !output) return;
  if (!result) {
    summary.textContent = '';
    output.textContent = '';
    output.classList.add('hidden');
    if (copy) copy.disabled = true;
    return;
  }
  if (!result.findings.length) {
    summary.textContent = '没有发现敏感信息。';
    output.textContent = result.redacted;
    output.classList.remove('hidden');
    if (copy) copy.disabled = true;
    return;
  }
  const bits = result.findings.map((f) => f.label).join('、');
  summary.textContent = `发现 ${result.findings.length} 处：${bits}（已脱敏）`;
  output.textContent = result.redacted;
  output.classList.remove('hidden');
  if (copy) copy.disabled = false;
}

/** 规则开关列表。onToggle(ruleId, checked) 由 app.js 提供。 */
function gwsRenderRules(rules, toggles, onToggle) {
  const list = GWS.els && GWS.els.rules;
  if (!list) return;
  list.textContent = '';
  for (const rule of rules) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'rule-name';
    name.textContent = rule.label;
    const sev = document.createElement('span');
    sev.className = 'rule-sev';
    sev.textContent = rule.severity === 'high' ? '高风险' : rule.severity === 'medium' ? '中风险' : '低风险';
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'btn tiny';
    sw.textContent = toggles[rule.id] === false ? '已关' : '开';
    sw.addEventListener('click', () => {
      const next = toggles[rule.id] === false;
      toggles[rule.id] = next;
      sw.textContent = next ? '开' : '已关';
      if (typeof onToggle === 'function') onToggle(rule.id, next);
    });
    li.appendChild(name);
    li.appendChild(sev);
    li.appendChild(sw);
    list.appendChild(li);
  }
}

function gwsRenderAlerts(alerts) {
  const list = GWS.els && GWS.els.alerts;
  const empty = GWS.els && GWS.els['alerts-empty'];
  if (!list || !empty) return;
  list.textContent = '';
  empty.classList.toggle('hidden', (alerts || []).length > 0);
  for (const a of alerts || []) {
    const li = document.createElement('li');
    const sw = document.createElement('span');
    sw.className = `alert-swatch ${a.risk || 'low'}`;
    const main = document.createElement('div');
    main.className = 'alert-main';
    const t = document.createElement('span');
    t.className = 'alert-title';
    const ruleNames = (a.rules || []).map((r) => PrivacyPatterns.RULES_BY_ID[r] ? PrivacyPatterns.RULES_BY_ID[r].label : r).join('、');
    t.textContent = `${a.source === 'file' ? '文件' : '剪贴板'}：${ruleNames || '敏感信息'}`;
    const m = document.createElement('span');
    m.className = 'alert-meta';
    m.textContent = `${a.path || ''}${a.path ? ' · ' : ''}${a.at ? new Date(a.at).toLocaleString() : ''}`;
    main.appendChild(t);
    main.appendChild(m);
    li.appendChild(sw);
    li.appendChild(main);
    list.appendChild(li);
  }
}

const PrivacyWorkshop = { GWS, gwsCollectEls, gwsSetStatus, gwsSetChip, gwsRenderProbe, gwsRenderRules, gwsRenderAlerts };
