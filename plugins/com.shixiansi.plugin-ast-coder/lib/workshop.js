// lib/workshop.js —— 两副面孔的接线与 plugin.call 的应答
//
// 常驻帧：目录轮询（watcher）+ 分发 plugin.call（serves: analyze / review / genTests）。
// 工坊页：结构索引列表、代码框、审查按钮、生成测试按钮。
//
// serves 里点名了三个方法，CALL_HANDLERS 必须逐字对上——serves 写了而代码没有，
// 调用方会一直等到 30 秒超时（宿主不替你答，手册 §6.8）。

'use strict';

const CALL_HANDLERS = {
  analyze: handleAnalyze,
  review: handleReview,
  genTests: handleGenTests,
};

/**
 * `analyze`：把一段代码（或一个已索引文件）的结构给出去。
 * payload {code?, path?}——给了 code 用 code；给了 path 且在索引里用索引。
 */
async function handleAnalyze(payload) {
  const code = payload && typeof payload.code === 'string' ? payload.code : '';
  const pathIn = text(payload && payload.path, 200).trim();
  if (code) {
    const structure = AstParser.parse(code, pathIn || '(粘贴的代码)');
    return { structure, summary: AstParser.summarize(structure, 1200) };
  }
  if (pathIn) {
    const hit = watcher.index.get(pathIn);
    if (hit) return { structure: hit.structure, summary: hit.summary };
    return { structure: null, summary: `索引里没有 ${pathIn}（等待下一次扫描，或先 review 粘贴的代码）` };
  }
  throw new Error('analyze 需要 code 或 path 之一');
}

// --- 工坊页 -------------------------------------------------------------------

function renderWorkshop() {
  renderIndex();
  renderStatus();
  renderResult();
}

function renderStatus() {
  if (!els.chipState) return;
  const dir = String(cfg.watchDir || '').trim();
  const stateLine = watcherRunning() ? (fileBridge.ok === false ? '桥不在线' : '监听中') : '未监听';
  els.chipState.textContent = `${dir ? `目录 ${dir}` : '未配置目录'} · ${stateLine}`;
  if (els.statFiles) els.statFiles.textContent = String(watcher.index.size);
  if (els.statScans) els.statScans.textContent = String(watcher.scanCount);
  if (els.statusError) els.statusError.textContent = watcher.lastError || fileBridge.lastError || '';
  if (els.statusNote) els.statusNote.textContent = watcherRunning() ? '轮询中' : '监听未启动（或已停止）';
  if (els.watchToggle) {
    els.watchToggle.textContent = watcherRunning() ? '停止监听' : '开始监听';
  }
}

/** 渲染结构索引（列表：路径、行数、函数/类/导出计数、TODO 数）。 */
function renderIndex() {
  if (!els.indexList) return;
  const items = indexList(30);
  els.indexList.replaceChildren();
  if (!items.length) {
    if (els.indexEmpty) els.indexEmpty.hidden = false;
    return;
  }
  if (els.indexEmpty) els.indexEmpty.hidden = true;
  for (const item of items) {
    const row = document.createElement('li');
    row.className = 'file-row';
    const name = document.createElement('button');
    name.className = 'file-name';
    name.type = 'button';
    name.textContent = item.path;
    name.title = item.summary;
    name.addEventListener('click', () => {
      const hit = watcher.index.get(item.path);
      if (hit) loadCodeIntoBox(item.path, hit.structure);
    });
    const meta = document.createElement('span');
    meta.className = 'file-meta muted';
    meta.textContent = `${item.lines} 行 · ${item.functions} 函数 · ${item.classes} 类 · ${item.exports} 导出${item.todos ? ` · ${item.todos} TODO` : ''}`;
    row.append(name, meta);
    els.indexList.appendChild(row);
  }
}

/** 点一个索引项：把文件摘要放进代码框（不回读源码——摘要已经够模型用）。 */
function loadCodeIntoBox(pathKey, hit) {
  if (!els.codeBox) return;
  els.codeBox.value = `// 来自索引的摘要（点「审查」即可用；要完整源码请粘贴）\n// ${pathKey}\n// ${hit.summary}\n`;
  if (els.codeName) els.codeName.value = pathKey.split('/').pop().replace(/\.[^.]+$/, '');
  renderResult();
}

function renderResult() {
  if (!els.result) return;
  els.result.replaceChildren();
  const last = reviewState.last;
  if (els.resultEmpty) els.resultEmpty.hidden = Boolean(last);
  if (!last) return;
  const head = document.createElement('p');
  head.className = 'muted';
  head.textContent = `${new Date(last.at).toLocaleString()} · ${last.chars} 字${last.clipped ? ' · 送审代码被截断' : ''}`;
  const body = document.createElement('pre');
  body.className = 'review-answer';
  body.textContent = last.answer;
  els.result.append(head, body);
}

/** 审查按钮：拿代码框的当前内容。 */
async function reviewButton() {
  if (!els.codeBox) return;
  const code = els.codeBox.value || '';
  els.reviewBtn.disabled = true;
  reviewState.lastError = '';
  renderStatus();
  try {
    await handleReview({ code, lang: 'JavaScript', note: els.codeName ? `文件名：${els.codeName.value}` : '' });
  } catch (err) {
    reviewState.lastError = text(err && err.message, 160);
  } finally {
    els.reviewBtn.disabled = false;
    renderResult();
    renderStatus();
  }
}

/** 生成测试按钮。 */
async function genTestsButton() {
  if (!els.codeBox) return;
  const code = els.codeBox.value || '';
  const name = els.codeName ? els.codeName.value : '';
  els.genBtn.disabled = true;
  reviewState.lastError = '';
  try {
    const out = await handleGenTests({ code, name });
    reviewState.last = {
      at: now(),
      chars: Array.from(out.code).length,
      answer: `目标文件：${out.target}${out.wrote ? `（已写入 ${out.bytes} 字节）` : out.existedBefore ? '（目标已存在且非空——**没有覆盖**，内容在下方）' : '（未写入磁盘：开关关闭或未配置目录）'}\n\n${out.code}`,
      clipped: out.clipped,
    };
  } catch (err) {
    reviewState.lastError = text(err && err.message, 160);
  } finally {
    els.genBtn.disabled = false;
    renderResult();
    renderStatus();
  }
}

/** 监听开关：写 share 命令键，常驻帧读它（两副面孔之间没有共享内存）。 */
const SHARE_COMMAND = 'coder-command';
async function sendCommand(op) {
  try {
    await request('share.set', { name: SHARE_COMMAND, value: JSON.stringify({ op, at: now() }) });
  } catch (err) {
    say(`命令没有发出去：${text(err && err.message, 120)}`);
  }
}

let lastCommandAt = 0;
async function pollCommand() {
  if (!granted.has('plugin.share')) return;
  try {
    const out = await request('share.get', { name: SHARE_COMMAND });
    const value = String((out && out.value) || '');
    if (!value) return;
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed.at !== 'number' || parsed.at <= lastCommandAt) return;
    lastCommandAt = parsed.at;
    if (parsed.op === 'watch-start') {
      if (String(cfg.watchDir || '').trim()) startWatcher();
    } else if (parsed.op === 'watch-stop') {
      stopWatcher();
    }
  } catch {
    // 键还没人写过或坏 JSON：跳过。
  }
}
