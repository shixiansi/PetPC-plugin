// lib/workshop.js —— 插件页那一面：拖 / 粘贴 / 选文件 → 上传 → 拿走链接
//
// 这一面是插件的**唯一界面**（桌宠那边只有一个不显示的常驻帧，用来答 plugin.call）。所以它的
// 状态要一次说全：图床是哪台、配置齐不齐、正在传什么、刚才那条链接是什么、历史里有什么。
//
// 三条纪律（都是这本手册里踩过的）：
//
//   1. 没有权限就把控件禁掉并说明，不要"点了报错"——被拒的请求在宿主日志里是一条 WARN；
//   2. 失败时把宿主/图床的原文显示出来，不包装成"操作失败"；
//   3. 复制失败不是错误：链接已经显示在屏幕上，用户能自己选中。

'use strict';

let uploading = 0;
let booted = false;

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

/**
 * 这个窗口能不能上传：**权限**与**能力**是两件事，两个都要问。
 *
 * `granted` 说用户给没给 `net.fetch`；`serves('net.fetch')` 说这个宿主服务不服务它（来自
 * init.host.methods，没有这个字段的老宿主退回 slot）。手册 §9 的规矩是"按 granted 先判断，
 * 或者按能力判断"——这里两件都做，因为两种失败的读法完全不同：一个去授权，一个换窗口。
 * 返回空串 = 可以传；否则就是那句要显示给用户的话。
 */
function uploadability() {
  if (!granted.has('net.fetch')) return '没有 net.fetch 权限：在插件的授权里勾上「访问网络」';
  if (!serves('net.fetch')) return '这个窗口不支持 net.fetch：上传要在桌宠那边的插件页里做';
  return '';
}

/** 顶部两颗 chip：图床是哪台、配置齐不齐。 */
function renderChips() {
  if (els.chipHost) {
    let label = '图床：未配置';
    try {
      const ep = endpointSettings();
      label = `图床：${new URL(ep.base).host}`;
    } catch {
      label = '图床：未配置';
    }
    els.chipHost.textContent = label;
  }
  if (!els.chipState) return;
  els.chipState.classList.remove('bad');
  const blocked = uploadability();
  if (blocked) {
    els.chipState.textContent = text(blocked, 40);
    els.chipState.classList.add('bad');
    return;
  }
  try {
    const ep = endpointSettings();
    if (!ep.authCode && !ep.apiToken) {
      els.chipState.textContent = '缺认证码 / Token';
      els.chipState.classList.add('bad');
      return;
    }
    els.chipState.textContent = ep.apiToken ? 'API Token' : '上传认证码';
  } catch (err) {
    els.chipState.textContent = text(err && err.message ? err.message : err, 40);
    els.chipState.classList.add('bad');
  }
}

/** 一行"名字 + 结果"。成功时带上缩略图、链接与复制按钮；失败时只有原因。 */
function renderResultRow({ name, bytes, url, error, pending }) {
  const row = el('li', 'queue-row');
  if (pending) row.classList.add('pending');
  if (url) row.classList.add('ok');
  if (error) row.classList.add('bad');

  if (url) {
    const thumb = el('img', 'thumb');
    thumb.src = url;
    thumb.alt = '';
    thumb.loading = 'lazy';
    row.append(thumb);
  } else {
    const glyph = el('span', 'thumb thumb-glyph', pending ? '…' : error ? '!' : '·');
    row.append(glyph);
  }

  const main = el('div', 'queue-main');
  const head = el('div', 'queue-head');
  head.append(el('span', 'queue-name', text(name, 60)));
  if (bytes) head.append(el('span', 'queue-bytes', fmtBytes(bytes)));
  main.append(head);

  if (pending) {
    main.append(el('p', 'queue-note', '上传中…'));
  } else if (error) {
    main.append(el('p', 'queue-error', text(error, 240)));
  } else if (url) {
    const link = el('a', 'queue-link', url);
    link.href = url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    main.append(link);
  }

  row.append(main);

  if (url) {
    const actions = el('div', 'queue-actions');
    const copy = el('button', 'btn soft tiny', '复制');
    copy.type = 'button';
    copy.addEventListener('click', () => {
      if (copyText(url)) {
        copy.textContent = '已复制';
        setTimeout(() => {
          copy.textContent = '复制';
        }, 1500);
      } else {
        // 复制不了不是失败：链接就在旁边，选中就能复制。
        copy.textContent = '请手动复制';
        const link = row.querySelector('.queue-link');
        if (link && window.getSelection) {
          const range = document.createRange();
          range.selectNodeContents(link);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
    });
    actions.append(copy);
    row.append(actions);
  }

  return row;
}

/** 正在传的那一段：先画一行"上传中"，结束原地换成结果。 */
async function handleFiles(fileList) {
  const files = Array.from(fileList || []).filter(Boolean);
  if (!files.length) return;
  const blocked = uploadability();
  if (blocked) {
    say(blocked);
    return;
  }
  if (els.queueEmpty) els.queueEmpty.classList.add('hidden');
  if (els.queue) els.queue.classList.remove('hidden');

  for (const file of files) {
    const name = safeFilename(file.name, file.type);
    const pendingRow = renderResultRow({ name, pending: true });
    if (els.queue) els.queue.prepend(pendingRow);
    uploading += 1;
    say(`正在上传 ${name}…`);
    try {
      await refreshConfig();
      const result = await uploadPicked(file);
      pendingRow.replaceWith(renderResultRow({ name, bytes: result.bytes, url: result.url }));
      say(`已上传：${result.url}`);
      const list = await pushHistory(result);
      renderHistoryList(list);
    } catch (err) {
      const reason = err && err.message ? err.message : String(err);
      pendingRow.replaceWith(renderResultRow({ name, error: reason }));
      say(reason);
    } finally {
      uploading -= 1;
    }
  }
  if (!uploading) renderChips();
}

/** 「最近上传」列表。 */
function renderHistoryList(list) {
  if (!els.historyBody) return;
  els.historyBody.textContent = '';
  const rows = Array.isArray(list) ? list : [];
  if (els.historyEmpty) {
    if (rows.length) els.historyEmpty.classList.add('hidden');
    else els.historyEmpty.classList.remove('hidden');
  }
  for (const item of rows) {
    if (!item || !item.url) continue;
    els.historyBody.append(
      renderResultRow({ name: item.name || item.url, bytes: item.bytes, url: item.url, at: item.at }),
    );
  }
}

async function renderHistory() {
  renderHistoryList(await loadHistory());
}

async function clearAllHistory() {
  try {
    await clearHistory();
    renderHistoryList([]);
    say('上传记录已清空');
  } catch (err) {
    say(text(err && err.message ? err.message : err, 200));
  }
}

/** 整个 workshop 面的重画（init 时一次；上传与清空之后各自局部重画）。 */
async function renderWorkshop() {
  await refreshConfig();
  renderChips();
  await renderHistory();
  const blocked = uploadability();
  if (els.pickBtn) {
    els.pickBtn.disabled = Boolean(blocked);
    els.pickBtn.title = blocked;
  }
  if (els.drop) els.drop.classList.toggle('disabled', Boolean(blocked));
  if (blocked) say(blocked);
}

/** 装一次事件。`init` 只会来一次，所以这里不重复绑定。 */
function bindWorkshop() {
  if (booted) return;
  booted = true;

  if (els.pickBtn && els.pick) {
    els.pickBtn.addEventListener('click', () => els.pick.click());
    els.pick.addEventListener('change', () => {
      const files = els.pick.files;
      // 选完清空 value：同一个文件再选一次也要触发 change。
      els.pick.value = '';
      void handleFiles(files);
    });
  }

  if (els.historyClear) {
    els.historyClear.addEventListener('click', () => void clearAllHistory());
  }

  if (els.drop) {
    // dragover 必须 preventDefault，否则浏览器不会派发 drop。
    els.drop.addEventListener('dragover', (event) => {
      event.preventDefault();
      els.drop.classList.add('over');
    });
    els.drop.addEventListener('dragleave', () => els.drop.classList.remove('over'));
    els.drop.addEventListener('drop', (event) => {
      event.preventDefault();
      els.drop.classList.remove('over');
      const dt = event.dataTransfer;
      void handleFiles(dt && dt.files);
    });
  }

  // 粘贴：截图工具、Win+Shift+S 之后最常见的一步。整页都接，因为用户不会先去点某个框。
  document.addEventListener('paste', (event) => {
    const cd = event.clipboardData;
    const files = cd && cd.files;
    if (!files || !files.length) return;
    event.preventDefault();
    void handleFiles(files);
  });

  // 整页拖放：拖到卡片外面也不该让浏览器直接打开那张图（那会把插件页换成一张图片）。
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());
}
