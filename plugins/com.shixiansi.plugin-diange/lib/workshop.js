// lib/workshop.js —— 插件页那一面：手动点一首 + 最近点过 + 接口状态
//
// 这一页是**开发工具**，不是主路：真正干活的是桌宠那边的常驻帧（用户在群里点歌时，没有
// 任何一个界面是开着的）。所以这里只有两件事值得做——能当场验证"这首歌查得到、链接通"，
// 以及看见最近点过什么（用来判断"是不是缓存把一条过期链接留住了"）。
//
// 能不能在这里真的搜，看宿主**服务不服务** net.fetch（`init.host.methods`），不看 slot 叫
// 什么。这条踩过：写死"控制中心不服务网络"的结果是插件页上唯一能搜的按钮永远是灰的，
// 而控制中心其实注册了 net.fetch。

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

/** 宿主服务不服务这个能力。没有 init.host 的旧宿主才退回保守判断。 */
function hostServes(method) {
  if (self.host && Array.isArray(self.host.methods)) return self.host.methods.includes(method);
  return self.slot !== 'workshop';
}

/** 顶部 chips：接口在哪、这一面属于谁。 */
function renderChips() {
  if (els.chipApi) {
    let base = '';
    try {
      base = apiBase();
      els.chipApi.classList.remove('bad');
      els.chipApi.textContent = `接口：${base.replace(/^https?:\/\//, '')}`;
    } catch (err) {
      els.chipApi.classList.add('bad');
      els.chipApi.textContent = `接口：${text(err && err.message, 40)}`;
    }
  }
  if (els.chipSlot) els.chipSlot.textContent = self.slot === 'workshop' ? '控制中心' : '桌宠';
}

/** 一首歌的渲染。链接是可点的（这一页在普通容器里，不需要担心裁剪）。 */
function renderSong(song) {
  if (!els.results) return;
  els.results.textContent = '';
  if (!song) {
    els.results.append(el('p', 'muted', '没找到。换个写法试试（歌名 + 歌手更容易命中）。'));
    return;
  }
  const card = el('div', 'result');
  const head = el('div', 'result-head');
  head.append(el('span', 'result-title', song.title));
  if (song.singer) head.append(el('span', 'result-singer', song.singer));
  card.append(head);

  const facts = [];
  if (song.album) facts.push(`专辑《${song.album}》`);
  const quality = [song.format, song.bitrate ? `${song.bitrate}kbps` : '', song.size].filter(Boolean).join(' ');
  if (quality) facts.push(quality);
  const dur = formatDuration(song.durationSec);
  if (dur) facts.push(dur);
  if (facts.length) card.append(el('p', 'result-facts', facts.join('；')));

  const link = el('a', 'result-url', song.url);
  link.href = song.url;
  link.target = '_blank';
  link.rel = 'noreferrer';
  card.append(link);

  const probe = el('p', `result-probe ${song.probe && song.probe.checked && !song.probe.ok ? 'bad' : ''}`.trim(),
    describeProbe(song.probe));
  card.append(probe);
  if (song.cover) {
    const cover = el('a', 'result-cover', `封面：${song.cover}`);
    cover.href = song.cover;
    cover.target = '_blank';
    cover.rel = 'noreferrer';
    card.append(cover);
  }
  els.results.append(card);
}

/** 跑一次搜索（能跑就跑；宿主不服务 net.fetch 时按钮本身是禁用的）。 */
async function runSearch() {
  if (searching || !els.query || !els.results) return;
  const query = els.query.value.trim();
  if (!query) return;
  searching = true;
  if (els.go) els.go.disabled = true;
  say('点歌中…');
  try {
    const out = await handleSong({ query });
    renderSong(out.results[0] || null);
    say(out.count ? `找到「${out.results[0].title}」，用了 ${Math.max(1, Math.round(out.tookMs / 1000))} 秒` : `没找到「${query}」`);
    void renderHistory();
  } catch (err) {
    say(text(err && err.message ? err.message : err, 160));
  } finally {
    searching = false;
    if (els.go) els.go.disabled = !(granted.has('net.fetch') && hostServes('net.fetch'));
  }
}

/** 「最近点过」列表。 */
async function renderHistory() {
  if (!els.historyBody) return;
  const list = await loadHistory();
  els.historyBody.textContent = '';
  if (!list.length) {
    if (els.historyEmpty) els.historyEmpty.classList.remove('hidden');
    return;
  }
  if (els.historyEmpty) els.historyEmpty.classList.add('hidden');
  for (const item of list.slice().reverse()) {
    const row = el('tr');
    row.append(
      el('td', 'hist-time', fmtTime(item.at)),
      el('td', 'hist-query', text(item.query, 60)),
      el('td', 'hist-song', item.ok ? `${text(item.title, 30)}${item.singer ? ` - ${text(item.singer, 20)}` : ''}` : '（没找到）'),
      el('td', 'hist-ok', item.ok ? (item.probe ? '可播' : '未验证') : '—'),
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
    say('点歌记录已清空');
  } catch (err) {
    say(text(err && err.message ? err.message : err, 160));
  }
}

/** workshop 面的整体重画（init 之后调一次；历史由动作自己刷新）。 */
async function renderWorkshop() {
  await refreshConfig();
  renderChips();
  const ready = granted.has('net.fetch') && hostServes('net.fetch');
  if (els.go) els.go.disabled = !ready;
  if (!ready && els.workshop) {
    // 用 HTML 的 hidden **属性**，不是 `.hidden` 类：ui.css 只给 `[hidden]` 定过规则，
    // 一个叫 .hidden 的类在这份样式表里不代表"看不见"（踩过的坑：提示语永远挂在页面上）。
    const note = els.workshop.querySelector('.desktop-only');
    if (note) note.hidden = false;
  }
  await renderHistory();
}
