// lib/workshop.js —— 插件页那一面：手动搜索 + 最近记录 + 引擎状态
//
// 与 memcore 的 workshop 同一条纪律：控制中心不服务 net.fetch，所以「搜一下」按钮在
// 这一页是禁用的（不是点了报错）；只读的部分（最近记录、引擎状态）照常显示。
// 引擎状态读的是 config.get——控制中心服务它，所以这一页永远能看到「配置齐不齐」。

'use strict';

let searching = false;

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

/** 顶部 chips：现在用哪家引擎、配置齐不齐。 */
async function renderEngineChip() {
  if (!els.chipEngine) return;
  const status = engineStatus();
  const names = { searxng: 'SearXNG', tavily: 'Tavily', bing: 'Bing' };
  const name = names[status.engine] || status.engine;
  if (status.ready) {
    els.chipEngine.textContent = `引擎：${name}`;
    els.chipEngine.classList.remove('bad');
  } else {
    els.chipEngine.textContent = `引擎：${name}（${status.reason}）`;
    els.chipEngine.classList.add('bad');
  }
  if (els.chipSlot) {
    els.chipSlot.textContent = self.slot === 'workshop' ? '控制中心' : '桌宠';
  }
}

/** 一次搜索结果的渲染。 */
function renderResultList(results, query) {
  els.results.textContent = '';
  if (!results.length) {
    els.results.append(el('p', 'muted', `没有搜到「${query}」相关的结果。`));
    return;
  }
  for (const item of results) {
    const card = el('div', 'result');
    const head = el('div', 'result-head');
    head.append(el('span', 'result-title', item.title));
    card.append(head);
    card.append(el('a', 'result-url', item.url));
    if (item.snippet) card.append(el('p', 'result-snippet', item.snippet));
    els.results.append(card);
  }
}

/** 跑一次搜索（桌宠那一面才真的会跑；workshop 面上按钮是禁用的，这里只是兜底）。 */
async function runSearch() {
  if (searching || !els.query || !els.results) return;
  const query = els.query.value.trim();
  if (!query) return;
  searching = true;
  els.go.disabled = true;
  say('搜索中…');
  try {
    const out = await handleSearch({ query });
    renderResultList(out.results || [], query);
    say(`用了 ${out.engine}，${out.count} 条，${Math.max(1, Math.round(out.tookMs / 1000))} 秒`);
    void renderHistory();
  } catch (err) {
    say(text(err && err.message ? err.message : err, 160));
  } finally {
    searching = false;
    els.go.disabled = !granted.has('net.fetch');
  }
}

/** 「最近查过」列表。 */
async function renderHistory() {
  if (!els.historyBody) return;
  const list = await loadHistory();
  els.historyBody.textContent = '';
  const empty = Boolean(els.historyEmpty);
  if (!list.length) {
    if (empty) els.historyEmpty.classList.remove('hidden');
    return;
  }
  if (empty) els.historyEmpty.classList.add('hidden');
  for (const item of list.slice().reverse()) {
    const row = el('tr');
    row.append(
      el('td', 'hist-time', fmtTime(item.at)),
      el('td', 'hist-query', text(item.query, 60)),
      el('td', 'hist-engine', text(item.engine, 12)),
      el('td', 'hist-count', `${Number(item.count) || 0} 条`),
    );
    row.addEventListener('click', () => {
      if (!els.query) return;
      els.query.value = String(item.query || '');
      els.query.focus();
    });
    els.historyBody.append(row);
  }
}

async function clearAllHistory() {
  try {
    await clearHistory();
    await renderHistory();
    say('搜索记录已清空');
  } catch (err) {
    say(text(err && err.message ? err.message : err, 160));
  }
}

/** workshop 面的整体重画（5 秒轮询与 init 各调一次）。 */
async function renderWorkshop() {
  await refreshConfig();
  await renderEngineChip();
  await renderHistory();
}
