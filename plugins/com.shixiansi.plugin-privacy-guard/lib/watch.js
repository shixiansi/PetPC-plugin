// lib/watch.js —— 监控编排：outbox 轮询 → 扫描 → 告警节流 → 发布（纯逻辑，注入依赖）
//
// 辅助脚本把剪贴板/文件内容写进 outbox（pet-sense 同款），background 帧每 2 秒轮询一次。
// 这一层的职责：
//   1. 只处理 hash 变了的条目（同一份内容不重复扫）；
//   2. 告警节流：同一 ruleId 在 cooldown 分钟内只弹一次气泡（剪贴板反复粘贴同一张卡号
//      不该连弹十次）；
//   3. 产出结构化结果：{ findings, redacted, alert }——发布与 UI 各取所需。
//
// 纯函数 + 注入（now/cooldownMs），测试不需要真的等时间。

'use strict';

// 存储键**不是文件名**（手册 §6.3）：写成 outbox/clipboard.json 会被判非法，整个
// storage.get 不执行——2026-10-31 的真机上就是这么刷了 110 条 WARN。辅助脚本写的
// 也是这两个无扩展名的文件，两边必须同时改。
const POLL_KEY = 'outbox/clipboard';
const POLL_FILE_KEY = 'outbox/file';
const ALERTS_KEY = 'alerts-v1';
const ALERTS_MAX = 50;

/** 一次扫描的完整结果。 */
function makeResult(source, findings, redacted, at) {
  return {
    source, // clipboard | file
    at,
    count: findings.length,
    risk: 'none',
    findings,
    redacted,
    path: '',
  };
}

/**
 * 处理一条 outbox 记录。返回要做的动作（不执行 IO——编排层照着做）：
 *   null                       = 内容没变/没有发现，无事可做
 *   { alert, result, log }     = 有发现：alert 是给气泡的一句中文，result 进历史
 *
 * @param {object} record {at, hash, text, path?}
 * @param {object} ctx {toggles, seenHashes: Map, alertLog: [{ruleId, at}], cooldownMs, now}
 */
function processRecord(record, ctx) {
  if (!record || !record.text || !record.hash) return null;
  const now = ctx.now ? ctx.now() : Date.now();
  const seen = ctx.seenHashes.get(record.source === 'file' ? `file:${record.path}` : 'clipboard');
  if (seen === record.hash) return null;
  ctx.seenHashes.set(record.source === 'file' ? `file:${record.path}` : 'clipboard', record.hash);

  const scan = PrivacyPatterns.redact(record.text, ctx.toggles);
  const result = makeResult(record.source, scan.findings, scan.text, now);
  if (record.path) result.path = record.path;
  if (!scan.findings.length) return { result, alert: null, log: null };
  // 告警节流：同一 ruleId 在冷却期内只弹一次。
  const topRule = scan.findings[0].ruleId;
  const last = (ctx.alertLog || []).find((a) => a.ruleId === topRule);
  const throttled = last && now - last.at < (ctx.cooldownMs || 10 * 60 * 1000);
  const risk = PrivacyPatterns.riskLevel(scan.findings);
  const alert = throttled ? null : {
    ruleId: topRule,
    risk,
    text: `检测到${scan.findings[0].label}（${risk === 'high' ? '高风险' : risk === 'medium' ? '中风险' : '低风险'}），已自动脱敏`,
  };
  const log = {
    at: now,
    source: record.source,
    path: record.path || '',
    risk,
    rules: scan.findings.map((f) => f.ruleId),
    // 安全预览：在脱敏后的文本上取段，绝不带原文。
    preview: PrivacyPatterns.safePreview(record.text, scan.findings, 16),
  };
  return { alert, result, log };
}

/** 历史追加：新→旧、超量裁掉。 */
function pushAlerts(alerts, log, max = ALERTS_MAX) {
  return [log, ...alerts].slice(0, max);
}

const PrivacyWatch = { POLL_KEY, POLL_FILE_KEY, ALERTS_KEY, ALERTS_MAX, processRecord, pushAlerts, makeResult };
