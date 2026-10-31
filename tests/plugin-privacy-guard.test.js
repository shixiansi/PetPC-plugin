import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 隐私卫士的行为测试。钉住的几件事：
//
//   1. 五类敏感信息全识别（一段文本里同时出现 5 种 → 5 处发现）；
//   2. 误杀防线：订单号不是手机号、错的身份证校验位不认、Luhn 不过的 16 位数字不认、
//      短数字串、普通编号——全部放行；
//   3. 脱敏格式：手机 3+4、身份证 3+2、卡号 4-4-4、Key 全遮留前缀、邮箱留头两位；
//   4. 节流：同 ruleId 冷却期内不重复弹，冷却过了再弹；同 hash 不重扫；文件按路径分桶；
//   5. 状态机安全：开关关掉的规则不再报；空输入/坏 JSON 不炸；
//   6. 发布边界：告警只含规则名与已脱敏预览，不含原文；
//   7. 完整链路：假宿主泵 outbox → 扫描 → share.set + bubble.say。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-privacy-guard');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((m) => m[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');
const source = scriptSources
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-privacy-guard';

// --- 测试数据 ----------------------------------------------------------------------

// 校验位正确的身份证（ISO 7064 MOD 11-2 手工构造）：
// 前 17 位 11010519491231002 → 校验位 X
const VALID_ID = '11010519491231002X';
// 错校验位：同前 17 位、末位改成 1
const INVALID_ID = '110105194912310021';
// Luhn 合法/不合法的卡号
const VALID_CARD = '4111111111111111';
const INVALID_CARD = '4111111111111112';
const PHONE = '13812345678';
const KEY = 'sk-proj-abcdefghij0123456789ABCD';
const EMAIL = 'zhang.san@example.com';
const IPV4 = '192.168.1.100';
const BEARER = 'Bearer abcdef1234567890ABCDEF';

/** 一段包含 5 类（题目要求）敏感信息的 Mock 文本。 */
function fiveKindsText() {
  return [
    `手机 ${PHONE}`,
    `身份证 ${VALID_ID}`,
    `钥匙 ${KEY}`,
    `邮箱 ${EMAIL}`,
    `卡号 ${VALID_CARD}`,
  ].join('\n');
}

// --- 消息泵 -----------------------------------------------------------------------

let store;
let configValues;
let outbox;         // 模拟辅助脚本写的两个 outbox 文件
let sharePublished;
let bubbles;
let launched;
let windowListeners;
let intervals;
let timeouts;
let posted;
let answered;

function hostSends(msg) {
  for (const [, fn] of windowListeners) fn({ source: window, data: msg });
}

function requests() {
  return posted.mock.calls.map((c) => c[0]).filter((m) => m && m.type === 'request');
}

function answer(id, result, { ok = true, error = '' } = {}) {
  answered.add(id);
  hostSends({ v: 1, type: 'response', id, ok, result, error });
}

async function pump(maxRounds = 100) {
  for (let i = 0; i < maxRounds; i += 1) {
    const list = requests().filter((r) => !answered.has(r.id));
    if (!list.length) return;
    for (const req of list) {
      const payload = req.payload || {};
      switch (req.method) {
        case 'config.get':
          answer(req.id, { values: configValues, secrets: {} });
          break;
        case 'config.set':
          Object.assign(configValues, payload.values || {});
          answer(req.id, { ok: true });
          break;
        case 'storage.get':
          if (payload.key === 'alerts-v1') answer(req.id, { value: store.get('alerts-v1') || '' });
          else if (payload.key === 'outbox/clipboard') answer(req.id, { value: outbox.clipboard || '' });
          else if (payload.key === 'outbox/file') answer(req.id, { value: outbox.file || '' });
          else answer(req.id, { value: '' });
          break;
        case 'storage.set':
          store.set(String(payload.key), String(payload.value ?? ''));
          answer(req.id, { ok: true });
          break;
        case 'storage.dir':
          answer(req.id, { dir: 'C:\\plugin-data\\privacy-guard' });
          break;
        case 'process.launch':
          launched.push(payload);
          answer(req.id, { pid: 4242 });
          break;
        case 'share.set':
          sharePublished.push({ name: payload.name, value: payload.value });
          answer(req.id, { ok: true, key: `${PLUGIN_ID}/${payload.name}` });
          break;
        case 'bubble.say':
          bubbles.push(payload.text);
          answer(req.id, { ok: true });
          break;
        default:
          answer(req.id, null, { ok: false, error: `本程序不支持该方法 ${req.method}` });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function drive(promiseFactory) {
  const p = promiseFactory();
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 40 && !settled; i += 1) {
    await pump(8);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return p;
}

const macro = () => new Promise((resolve) => setTimeout(resolve, 0));

function loadApp() {
  answered = new Set();
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  for (const id of intervals) clearInterval(id);
  intervals = [];
  for (const id of timeouts) clearTimeout(id);
  timeouts = [];
  // eslint-disable-next-line no-new-func
  new Function(source)();
}

function boot(slot = 'workshop', granted = manifest.permissions) {
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
  loadApp();
  hostSends({
    v: 1, type: 'init', pluginId: PLUGIN_ID, permissions: manifest.permissions,
    granted, surface: { kind: 'panel', slot },
  });
  return macro();
}

async function bootSettled(slot = 'workshop', granted = manifest.permissions) {
  await boot(slot, granted);
  await pump(8);
}

beforeEach(() => {
  store = new Map();
  configValues = { alertCooldownMin: '10' };
  outbox = {};
  sharePublished = [];
  bubbles = [];
  launched = [];
  windowListeners = [];
  intervals = [];
  timeouts = [];
  const originalAdd = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(function (type, fn, opts) {
    windowListeners.push([type, fn, opts]);
    return originalAdd(type, fn, opts);
  });
  const originalInterval = window.setInterval.bind(window);
  vi.spyOn(window, 'setInterval').mockImplementation((fn, ms) => {
    const id = originalInterval(fn, ms);
    intervals.push(id);
    return id;
  });
  const originalTimeout = window.setTimeout.bind(window);
  vi.spyOn(window, 'setTimeout').mockImplementation((fn, ms) => {
    const id = originalTimeout(fn, ms);
    timeouts.push(id);
    return id;
  });
  posted = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
});

afterEach(() => {
  for (const id of intervals) clearInterval(id);
  for (const id of timeouts) clearTimeout(id);
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('manifest', () => {
  test('permissions: process/storage/config/share/call/bubble，无多余', () => {
    expect([...manifest.permissions].sort()).toEqual([
      'pet.bubble', 'plugin.call', 'plugin.config', 'plugin.share', 'process', 'storage',
    ]);
  });

  test('background gated by process；7 条规则开关都是配置项', () => {
    expect(manifest.background).toBe(true);
    const ruleKeys = manifest.config.filter((c) => c.key.startsWith('rule_')).map((c) => c.key);
    expect(ruleKeys).toHaveLength(7);
    expect(manifest.config.find((c) => c.key === 'alertCooldownMin').type).toBe('number');
  });

  test('serves 只列实现了的三个方法；helper 脚本在 assets 里', () => {
    expect(manifest.serves).toEqual(['scan', 'alerts', 'rules']);
    expect(manifest.assets).toContain('privacy-guard-helper.ps1');
  });
});

describe('patterns: 识别与误杀防线', () => {
  let P;
  beforeEach(async () => {
    await bootSettled('background');
    P = window.__privacy.patterns;
  });

  test('一段文本 5 类敏感信息 → 5 处发现，规则齐全', () => {
    const out = P.redact(fiveKindsText());
    const ids = out.findings.map((f) => f.ruleId);
    expect(ids).toContain('phone');
    expect(ids).toContain('id_card');
    expect(ids).toContain('openai_key');
    expect(ids).toContain('email');
    expect(ids).toContain('bank_card');
    expect(out.findings).toHaveLength(5);
    expect(P.riskLevel(out.findings)).toBe('high');
  });

  test('7 类全部出现（加 Bearer 与 IP）→ 7 处', () => {
    const text = `${fiveKindsText()}\n令牌 ${BEARER}\n地址 ${IPV4}`;
    const out = P.redact(text);
    expect(out.findings).toHaveLength(7);
  });

  test('误杀：订单号/时间戳/金额不是手机号或卡号', () => {
    const clean = P.scanText('订单号 13812345678901234 时间 20231031120000 金额 138 元 电话分机 12345678');
    expect(clean).toEqual([]);
  });

  test('误杀：校验位错的身份证与 Luhn 不过的卡号不认', () => {
    expect(P.scanText(`身份证 ${INVALID_ID}`).map((f) => f.ruleId)).not.toContain('id_card');
    expect(P.scanText(`卡号 ${INVALID_CARD}`).map((f) => f.ruleId)).not.toContain('bank_card');
    // 合法的要认。
    expect(P.scanText(`身份证 ${VALID_ID}`).map((f) => f.ruleId)).toContain('id_card');
    expect(P.scanText(`卡号 ${VALID_CARD}`).map((f) => f.ruleId)).toContain('bank_card');
  });

  test('误杀：生日部分荒谬的 18 位串不是身份证', () => {
    // 月份 13 → 正则不过。
    expect(P.scanText('编号 110105209913310021').map((f) => f.ruleId)).not.toContain('id_card');
  });

  test('误杀：普通句子、坐标、版本号不是 IP', () => {
    expect(P.scanText('版本 3.14.15 但是圆周率不是 IP').map((f) => f.ruleId)).not.toContain('ipv4');
    // 真 IPv4 要认。
    expect(P.scanText(`服务器 ${IPV4} 在内网`).map((f) => f.ruleId)).toContain('ipv4');
  });

  test('开关：关掉的规则完全不报', () => {
    const t = P.defaultToggles();
    t.phone = false;
    t.email = false;
    const out = P.redact(fiveKindsText(), t);
    const ids = out.findings.map((f) => f.ruleId);
    expect(ids).not.toContain('phone');
    expect(ids).not.toContain('email');
    expect(ids).toHaveLength(3);
  });

  test('空输入与坏输入不炸', () => {
    expect(P.redact('')).toEqual({ findings: [], text: '', replaced: 0 });
    expect(P.redact(null).findings).toEqual([]);
    expect(P.redact('   ').findings).toEqual([]);
  });
});

describe('patterns: 脱敏格式', () => {
  let P;
  beforeEach(async () => {
    await bootSettled('background');
    P = window.__privacy.patterns;
  });

  test('手机号：前 3 + **** + 后 4', () => {
    const out = P.redact(`打我手机 ${PHONE}`);
    expect(out.text).toBe(`打我手机 138****5678`);
  });

  test('身份证：前 3 + 11 星 + 后 2', () => {
    const out = P.redact(`证件 ${VALID_ID}`);
    expect(out.text).toBe(`证件 110***********2X`);
  });

  test('银行卡：4-4-4-4 分组，中段全星', () => {
    const out = P.redact(`卡号 ${VALID_CARD}`);
    expect(out.text).toMatch(/4111 \*+ \*+ 1111/);
  });

  test('API Key：sk- 前缀保留，其余全星', () => {
    const out = P.redact(`key ${KEY}`);
    expect(out.text).toMatch(/^key sk-\*+$/);
    expect(out.text).not.toContain('abcdefghij');
  });

  test('邮箱：本地部分留前 2 位，域名保留', () => {
    const out = P.redact(`发到 ${EMAIL}`);
    expect(out.text).toBe('发到 zh***@example.com');
  });

  test('IP：首尾段保留，中段全星', () => {
    const out = P.redact(`服务器 ${IPV4}`);
    expect(out.text).toBe('服务器 192.***.***.100');
  });

  test('原文里其余部分一字不动（替换只发生在命中区间）', () => {
    const text = `前缀文字 ${PHONE} 后缀文字`;
    const out = P.redact(text);
    expect(out.text.startsWith('前缀文字 ')).toBe(true);
    expect(out.text.endsWith(' 后缀文字')).toBe(true);
    expect(out.replaced).toBe(1);
  });
});

describe('watch: 编排与节流', () => {
  let W;
  beforeEach(async () => {
    await bootSettled('background');
    W = window.__privacy.watch;
  });

  function makeCtx(now = 1000, cooldownMs = 10 * 60 * 1000) {
    return {
      toggles: window.__privacy.patterns.defaultToggles(),
      seenHashes: new Map(),
      alertLog: [],
      cooldownMs,
      now: () => now,
    };
  }

  test('同 hash 不重扫；文件按路径分桶', () => {
    const ctx = makeCtx();
    const rec = { source: 'clipboard', hash: 'h1', text: `手机 ${PHONE}` };
    expect(W.processRecord(rec, ctx).alert).toBeTruthy();
    expect(W.processRecord(rec, ctx)).toBeNull();
    // 文件来源同 hash 但路径不同 → 各自处理。
    const f1 = { source: 'file', hash: 'h1', path: 'C:/a/.env', text: `手机 ${PHONE}` };
    expect(W.processRecord(f1, ctx).alert).toBeTruthy();
    expect(W.processRecord(f1, ctx)).toBeNull();
  });

  test('节流：冷却期内同 ruleId 不弹（但仍返回 result）；冷却过了再弹', () => {
    const ctx = makeCtx(1000, 60000);
    const first = W.processRecord({ source: 'clipboard', hash: 'h1', text: `手机 ${PHONE}` }, ctx);
    expect(first.alert).toBeTruthy();
    ctx.alertLog.push({ ruleId: 'phone', at: 1000 });
    const second = W.processRecord({ source: 'clipboard', hash: 'h2', text: `手机 13987654321` }, ctx);
    expect(second.alert).toBeNull();
    expect(second.result.count).toBe(1);
    ctx.now = () => 61000; // 冷却已过
    const third = W.processRecord({ source: 'clipboard', hash: 'h3', text: `手机 13666666666` }, ctx);
    expect(third.alert).toBeTruthy();
  });

  test('坏记录（无 text / 无 hash）直接跳过', () => {
    const ctx = makeCtx();
    expect(W.processRecord(null, ctx)).toBeNull();
    expect(W.processRecord({ source: 'clipboard', hash: 'h1' }, ctx)).toBeNull();
    expect(W.processRecord({ source: 'clipboard', hash: '', text: 'x' }, ctx)).toBeNull();
  });

  test('历史追加：新→旧、超量裁掉', () => {
    let log = [];
    for (let i = 0; i < 60; i += 1) {
      log = W.pushAlerts(log, { at: i, source: 'clipboard', risk: 'high', rules: ['phone'], preview: 'x' });
    }
    expect(log).toHaveLength(50);
    expect(log[0].at).toBe(59);
  });
});

describe('完整链路（假宿主泵）', () => {
  test('outbox 出现敏感信息 → share.set（脱敏预览）+ bubble.say + 告警历史', async () => {
    await bootSettled('background');
    outbox.clipboard = JSON.stringify({ at: 1, hash: 'h1', text: fiveKindsText() });
    await drive(() => window.__privacy.runPollCycle());
    // 气泡：一条（节流：5 处发现里第一条规则弹一次）。
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toContain('高风险');
    expect(bubbles[0]).toContain('已自动脱敏');
    // share 只发布规则名与预览，不含原文。
    expect(sharePublished).toHaveLength(1);
    const payload = JSON.parse(sharePublished[0].value);
    expect(payload.rules).toContain('phone');
    expect(payload.risk).toBe('high');
    expect(payload.preview).not.toContain(PHONE);
    expect(payload.preview).not.toContain(VALID_ID);
    // 历史进了 storage。
    const saved = JSON.parse(store.get('alerts-v1'));
    expect(saved).toHaveLength(1);
  });

  test('同一份内容第二轮不再告警（hash 去重）', async () => {
    await bootSettled('background');
    outbox.clipboard = JSON.stringify({ at: 1, hash: 'h1', text: fiveKindsText() });
    await drive(() => window.__privacy.runPollCycle());
    expect(bubbles).toHaveLength(1);
    await drive(() => window.__privacy.runPollCycle());
    expect(bubbles).toHaveLength(1);
  });

  test('outbox 里的干净文本不产生任何动作', async () => {
    await bootSettled('background');
    outbox.clipboard = JSON.stringify({ at: 1, hash: 'h1', text: '今天天气不错，适合写代码。' });
    await drive(() => window.__privacy.runPollCycle());
    expect(bubbles).toHaveLength(0);
    expect(sharePublished).toHaveLength(0);
  });

  test('坏 JSON 的 outbox 不炸轮询', async () => {
    await bootSettled('background');
    outbox.clipboard = '{not json';
    await drive(() => window.__privacy.runPollCycle());
    expect(bubbles).toHaveLength(0);
  });

  test('process.launch：配置齐全时用给定参数启动辅助脚本', async () => {
    configValues.helperPath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    configValues.helperScript = 'C:\\plugins\\privacy-guard-helper.ps1';
    configValues.watchDir = 'C:\\Users\\me';
    await bootSettled('background');
    expect(launched).toHaveLength(1);
    expect(launched[0].path).toContain('powershell.exe');
    expect(launched[0].args).toEqual(expect.arrayContaining(['-File', 'C:\\plugins\\privacy-guard-helper.ps1', '-WatchDir', 'C:\\Users\\me']));
  });

  test('helperPath 没填：不启动，也不炸', async () => {
    await bootSettled('background');
    expect(launched).toHaveLength(0);
  });

  test('plugin.call scan：文本自查（给其他插件用）', async () => {
    await bootSettled('background');
    const h = window.__privacy.handlers;
    const out = await drive(() => h.scan({ text: `联系 ${PHONE} 或 ${EMAIL}` }));
    expect(out.count).toBe(2);
    expect(out.risk).toBe('high');
    expect(out.redacted).toContain('138****5678');
    const empty = await drive(() => h.scan({ text: '' }));
    expect(empty.count).toBe(0);
  });

  test('工坊页试验台：渲染发现与脱敏结果', async () => {
    await bootSettled('workshop');
    const input = document.getElementById('probe-input');
    input.value = `手机 ${PHONE}`;
    window.__privacy.runProbe();
    expect(document.getElementById('probe-summary').textContent).toContain('1 处');
    expect(document.getElementById('probe-output').textContent).toContain('138****5678');
  });
});

describe('样式治理', () => {
  test('style.css 不写死十六进制颜色', () => {
    const css = readFileSync(path.join(pluginDir, 'style.css'), 'utf8');
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(stripped.match(/#[0-9a-fA-F]{3,8}\b/g) || []).toEqual([]);
  });

  test('ui.css 与源头逐字节相同', () => {
    expect(readFileSync(path.join(pluginDir, 'ui.css'), 'utf8'))
      .toBe(readFileSync(path.join(here, '..', 'docs', 'ui', 'petpc-ui.css'), 'utf8'));
  });
});
