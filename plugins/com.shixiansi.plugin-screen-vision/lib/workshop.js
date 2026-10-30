// lib/workshop.js —— 插件页那一面：看一眼屏幕 + 最近识别记录
//
// 纪律与 websearch 的 workshop 同一条：控制中心不服务 process / plugin.call（手册 §9），
// 所以「看一眼」按钮在这一页是禁用的（不是点了报错）；只读的部分（配置状态、最近记录）
// 照常显示。真正的按钮活在桌宠那边的面板上——本插件的 surface 块。

'use strict';

let analyzing = false;

function el(tag, className, body) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (body !== undefined) node.textContent = body;
  return node;
}

function fmtTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const d = new Date(n);
  const pad = (x) => `${x}`.padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 顶部 chip：辅助脚本活不活（轮询 health，15 秒没动静就是死了）。 */
async function renderHelperChip() {
  if (!els.chipHelper) return;
  const health = await readHelperHealth();
  if (health.alive) {
    els.chipHelper.textContent = '辅助脚本：运行中';
    els.chipHelper.classList.remove('bad');
  } else {
    els.chipHelper.textContent = '辅助脚本：未启动';
    els.chipHelper.classList.add('bad');
  }
}

/** 面板与插件页共用的"识别中"状态。 */
function setAnalyzing(on, line) {
  analyzing = on;
  if (els.look) {
    els.look.disabled = on || !granted.has('process') || !granted.has('plugin.call');
    els.look.textContent = on ? '识别中…' : '看一眼屏幕';
  }
  if (on && els.answer) {
    els.answer.textContent = '';
    els.answer.dataset.state = 'loading';
  }
  say(line || (on ? '截图 → 上传 → 问视觉模型，请稍等…' : ''));
}

/** 一次完整分析（面板按钮与 plugin.call 走同一条 handleAnalyzeScreen）。 */
async function runAnalysis() {
  if (analyzing) return;
  const question = els.question && els.question.value.trim() ? els.question.value.trim() : '';
  setAnalyzing(true, '识别中…');
  try {
    const out = await handleAnalyzeScreen(question ? { question } : {});
    if (els.answer) {
      els.answer.textContent = out.text;
      els.answer.dataset.state = 'ready';
    }
    if (els.answerMeta) {
      const kb = Math.max(1, Math.round((out.meta.bytes || 0) / 1024));
      els.answerMeta.textContent = out.meta.imageUrl
        ? `${kb} KB · ${Math.max(1, Math.round(out.meta.tookMs / 100) / 10)}s · 已带图`
        : `${kb} KB · 图未上传（检查设置）`;
    }
    say('识别完成');
    void renderHistory();
  } catch (err) {
    if (els.answer) {
      els.answer.textContent = text(err && err.message ? err.message : err, 300);
      els.answer.dataset.state = 'error';
    }
    say('识别失败');
  } finally {
    setAnalyzing(false);
  }
}

/** 「最近识别」列表。 */
async function renderHistory() {
  if (!els.history) return;
  const list = await loadHistory();
  els.history.textContent = '';
  if (!list.length) {
    if (els.historyEmpty) els.historyEmpty.classList.remove('hidden');
    return;
  }
  if (els.historyEmpty) els.historyEmpty.classList.add('hidden');
  for (const item of list.slice().reverse()) {
    const tr = el('tr');
    tr.append(el('td', 'hist-time', fmtTime(item.at)));
    tr.append(el('td', 'hist-question', text(item.question, 60)));
    tr.append(el('td', 'hist-answer', text(item.answer, 120)));
    els.history.append(tr);
  }
}

async function clearAllHistory() {
  await clearHistory();
  void renderHistory();
  say('记录已清空');
}
