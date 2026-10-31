// lib/bridge.js —— 本机文件桥的 HTTP 客户端
//
// 沙箱里没有文件系统（手册 §10），而 plugin-dev 的能力表里也没有"读用户目录"这一项。
// 所以"监听目录"这件事的诚实做法是：由用户在本机跑一个**自己指给插件的**文件桥
// （tools/local-file-bridge.mjs），插件通过 net.fetch 走它读目录清单与文件内容。
// 桥的地址是配置项（hostWhitelist），留空 = 这个插件退化成"手动粘贴代码"模式，
// 什么都不读。
//
// 桥的协议（三支，全部 GET/POST JSON）：
//   GET  {base}/list?dir=…&depth=…     → {files: [{path, bytes, mtime}]}
//   GET  {base}/read?path=…            → {content, truncated}
//   POST {base}/write {path, content}  → {ok, bytes, existedBefore}
//
// 写入安全是桥的责任也是插件的责任：插件永远先 read 再 write，把"existedBefore"
// 记录下来；桥本身拒绝写任何已经存在且 differs 的路径，除非 body 里带了
// overwrite:true——而这个字段插件只在写 .test.js 时才给。

'use strict';

const fileBridge = {
  base: '',
  ok: null,          // null=没探测过；true/false=探测结果
  lastError: '',
};

/** 从配置拼出桥的基址（http:// 前缀补全）。 */
function bridgeBase(cfgValue) {
  const raw = String(cfgValue || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, '');
  return `http://${raw.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

/** 探测桥是否在线（1.2 秒超时：一个不在的桥不该把启动拖半分钟）。 */
async function probeBridge() {
  const base = bridgeBase(cfg.bridgeUrl);
  if (!base) {
    fileBridge.ok = false;
    fileBridge.lastError = '没有配置文件桥地址（手动粘贴模式）';
    return false;
  }
  try {
    const out = await request('net.fetch', { url: `${base}/ping`, method: 'GET' });
    fileBridge.ok = Boolean(out && out.status === 200);
    fileBridge.lastError = fileBridge.ok ? '' : `桥返回 ${out ? out.status : '无响应'}`;
  } catch (err) {
    fileBridge.ok = false;
    fileBridge.lastError = text(err && err.message, 120);
  }
  fileBridge.base = base;
  return fileBridge.ok;
}

/** 列一个目录下的 .js/.ts 文件（深度与忽略列表由配置给）。 */
async function bridgeList(dir) {
  const base = bridgeBase(cfg.bridgeUrl);
  if (!base || !dir) return [];
  const params = new URLSearchParams({ dir, depth: String(num('maxDepth', 0, 12, 4)), ignore: String(cfg.ignoreDirs || '') });
  try {
    const out = await request('net.fetch', { url: `${base}/list?${params}`, method: 'GET' });
    if (!out || out.status !== 200) {
      fileBridge.lastError = `桥 /list 返回 ${out ? out.status : '无响应'}`;
      return [];
    }
    const parsed = JSON.parse(String(out.body || '{}'));
    return Array.isArray(parsed.files) ? parsed.files : [];
  } catch (err) {
    fileBridge.lastError = `/list 失败：${text(err && err.message, 120)}`;
    return [];
  }
}

/** 读一个文件的内容。返回 {content, truncated} 或 null。 */
async function bridgeRead(pathIn) {
  const base = bridgeBase(cfg.bridgeUrl);
  if (!base || !pathIn) return null;
  const params = new URLSearchParams({ path: pathIn });
  try {
    const out = await request('net.fetch', { url: `${base}/read?${params}`, method: 'GET' });
    if (!out || out.status !== 200) {
      fileBridge.lastError = `桥 /read 返回 ${out ? out.status : '无响应'}`;
      return null;
    }
    const parsed = JSON.parse(String(out.body || '{}'));
    return { content: String(parsed.content || ''), truncated: Boolean(parsed.truncated) };
  } catch (err) {
    fileBridge.lastError = `/read 失败：${text(err && err.message, 120)}`;
    return null;
  }
}

/**
 * 写一个文件。**先读后写**是调用方的责任；这里只负责把"写之前存在吗"记进返回值。
 * `overwrite` 只在生成测试文件时为 true（那是唯一允许覆盖的目标）。
 */
async function bridgeWrite(pathIn, content, overwrite = false) {
  const base = bridgeBase(cfg.bridgeUrl);
  if (!base || !pathIn) return { ok: false, error: '没有配置文件桥地址' };
  try {
    const out = await request('net.fetch', {
      url: `${base}/write`,
      method: 'POST',
      body: JSON.stringify({ path: pathIn, content, overwrite: Boolean(overwrite) }),
    });
    if (!out || out.status !== 200) {
      const detail = out && out.body ? String(out.body).slice(0, 120) : String(out ? out.status : '无响应');
      return { ok: false, error: `桥 /write 拒绝：${detail}` };
    }
    const parsed = JSON.parse(String(out.body || '{}'));
    return { ok: true, bytes: Number(parsed.bytes) || 0, existedBefore: Boolean(parsed.existedBefore) };
  } catch (err) {
    return { ok: false, error: `/write 失败：${text(err && err.message, 120)}` };
  }
}
