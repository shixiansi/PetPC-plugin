// 反向样本：15 行 × 20px = 300px 内容，而 manifest 里声明的矩形只有 120px 高。
//
// 这就是 2026-10-28 番茄钟连翻五次车的那一类错误的最小形态：页面自己不知道"卡片有多高"，
// 宿主按声明的矩形做原生裁剪，于是底下 180px 被裁掉——界面上看是"列表少了几行"，
// 没有任何报错，jsdom 里也一切正常（它没有排版引擎）。
//
// 判据：`preview.mjs <这个目录> --check` 必须 FAIL 且退出码 1。
//       `plugin-check.mjs <这个目录>` 除了 surface-fixed-height 那条 WARN 之外不该有别的抱怨——
//       这个样本是"只有一处错"，多一处就会让"工具抓不抓得住"这件事变得说不清。

const rows = document.getElementById('rows');
for (let i = 1; i <= 15; i += 1) {
  const li = document.createElement('li');
  li.textContent = `第 ${i} 行`;
  rows.append(li);
}

// 协议：监听器先装好，再发 ready；只认 parent 与 v===1（手册第 3 节）。
window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  const msg = event.data;
  if (!msg || msg.v !== 1 || msg.type !== 'init') return;
  document.body.dataset.ready = '1';
});
window.parent.postMessage({ v: 1, type: 'ready' }, '*');
