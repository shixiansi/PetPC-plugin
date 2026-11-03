// lib/upload.js —— 一次上传：拼 multipart、发 net.fetch、解析回来那条链接
//
// 端点是 CloudFlare-ImgBed 的 `POST /upload`（https://github.com/MarSeventh/CloudFlare-ImgBed）：
//
//   POST {base}/upload?authCode=…&responseFormat=object&returnFormat=full
//   Content-Type: multipart/form-data; boundary=…
//   body: file=<图片字节>
//
// 三条真机事实（2026-11-02 在 https://imgcloud.shipixiv.de5.net 上跑的，不是照文档猜的）：
//
//   1. **`responseFormat=object` 才有对象**。默认回的是数组 `[{"src":"/file/…"}]`；
//   2. **`src` 默认是相对路径**（`/file/abc.png`），要 `returnFormat=full` 才是能直接贴进
//      Markdown 的完整链接；
//   3. **`publicUrl` 经常没有**——那个字段只在管理员配了"默认 URL 前缀"时才出现。所以"哪一条
//      是链接"不能只认一个字段名，而且相对路径要自己补上站点根。

'use strict';

/** 一次上传的最大字节数。宿主那边 net.fetch 的上限是 16 MiB，这里留出余量并给出人话。 */
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/** 读设置，顺带把地址与凭据校验干净。错误信息就是给人看的那句。 */
function endpointSettings() {
  const base = String(cfg.baseUrl === undefined || cfg.baseUrl === null ? '' : cfg.baseUrl).trim().replace(/\/+$/, '');
  if (!base) throw new Error('还没有填图床地址（设置里的第一项）');
  if (!/^https?:\/\//i.test(base)) throw new Error(`图床地址要以 http:// 或 https:// 开头：${base}`);
  try {
    // 只用来校验形状；拼 URL 仍然用字符串，因为 path 里可能有中文目录。
    void new URL(base);
  } catch {
    throw new Error(`图床地址不是一个有效的 URL：${base}`);
  }
  return {
    base,
    authCode: String(cfg.authCode || '').trim(),
    apiToken: String(cfg.apiToken || '').trim(),
    // `auto` 是"跟随站点默认"的那个选项值（宿主的 select 不许有空的 value），所以它在请求里
    // 必须等于"不带这个参数"——否则图床会收到 uploadChannel=auto 而回 400。
    channel: String(cfg.uploadChannel || '').trim() === 'auto' ? '' : String(cfg.uploadChannel || '').trim(),
    folder: String(cfg.folder || '').trim(),
    nameType: String(cfg.nameType || 'default').trim() || 'default',
  };
}

/** 认证码与 Token 都空着时，与其发一个注定 401 的请求，不如在这里说清楚。 */
function assertCredential(ep) {
  if (ep.authCode || ep.apiToken) return;
  throw new Error('先填「上传认证码」或「API Token」（插件设置里），图床只接受带凭据的上传');
}

/** 把站点根和参数拼成上传地址。 */
function uploadUrl(ep) {
  const params = [
    ['responseFormat', 'object'], // 要对象，不要数组
    ['returnFormat', 'full'], // 要完整链接，不要 /file/…
  ];
  if (ep.channel) params.push(['uploadChannel', ep.channel]);
  if (ep.folder) params.push(['uploadFolder', ep.folder]);
  if (ep.nameType && ep.nameType !== 'default') params.push(['uploadNameType', ep.nameType]);
  // Token 走 Authorization 头（下面），认证码只能走查询串——它是图床给"不想登录的人"用的那个。
  if (!ep.apiToken && ep.authCode) params.push(['authCode', ep.authCode]);
  const query = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return `${ep.base}/upload?${query}`;
}

function uploadHeaders(ep, contentType) {
  const headers = { accept: 'application/json', 'content-type': contentType };
  if (ep.apiToken) headers.authorization = `Bearer ${ep.apiToken}`;
  return headers;
}

/** 相对路径补成完整链接；已经是完整链接就原样返回。 */
function absolutize(value, base) {
  const url = String(value || '').trim();
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  return `${base}${url.startsWith('/') ? '' : '/'}${url}`;
}

/**
 * 从响应里取那条链接。
 *
 * 四种形状都要认：对象、单元素数组、`src` 是相对路径、以及只有 `publicUrl` 的部署。
 * 一个都取不到时返回空串——调用方会把它变成一句"上传成功但没看懂返回"，而不是编一条链接出来。
 */
function pickLink(parsed, base) {
  const row = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!row || typeof row !== 'object') return '';
  for (const key of ['publicUrl', 'src', 'url']) {
    const link = absolutize(row[key], base);
    if (link) return link;
  }
  return '';
}

/** 服务端那句错误里最有用的部分：JSON 的 error/message 字段，否则原文前 200 字。 */
function explainFailure(status, body) {
  const raw = String(body === undefined || body === null ? '' : body).trim();
  let detail = '';
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      detail = String((parsed && (parsed.error || parsed.message || parsed.detail)) || '');
    } catch {
      detail = raw;
    }
  }
  if (status === 401 || status === 403) {
    return `图床拒绝了这次上传（${status}）：认证码或 API Token 不对，或者这个 Token 没有 upload 权限`;
  }
  if (status === 413) return '图床说文件太大（413）：换一张小一点的，或者在站点设置里放开上传体积';
  if (status === 400 && /format|not allowed/i.test(detail)) {
    return `图床不接受这个格式（400）：${text(detail, 120)}`;
  }
  const tail = detail ? `：${text(detail, 160)}` : '';
  return `图床回了 ${status}${tail}`;
}

/**
 * 上传一份已经在内存里的字节。
 *
 * @param {{name: string, mime: string, bytes: Uint8Array}} file
 * @returns {Promise<{url: string, name: string, bytes: number, at: number}>}
 */
async function uploadBytes(file) {
  const ep = endpointSettings();
  assertCredential(ep);
  const bytes = file && file.bytes;
  if (!bytes || !bytes.length) throw new Error('这个文件是空的');
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new Error(`文件 ${fmtBytes(bytes.length)}，超过这次上传的上限 ${fmtBytes(MAX_UPLOAD_BYTES)}`);
  }
  const { body, contentType } = buildMultipartBody({
    field: 'file',
    filename: file.name,
    mime: file.mime || 'application/octet-stream',
    bytes,
  });

  // 字节能发出去靠的是 bodyBase64：body 是字符串，非 UTF-8 的字节在宿主那一步会被换成 U+FFFD，
  // 上传就会"成功"地存下一张坏图。这条能力两个宿主都有。
  const reply = await request('net.fetch', {
    method: 'POST',
    url: uploadUrl(ep),
    bodyBase64: base64FromBytes(body),
    headers: uploadHeaders(ep, contentType),
  });

  const status = Number(reply && reply.status) || 0;
  const rawBody = String((reply && reply.body) || '');
  if (!status) throw new Error('宿主没有回状态码：这张图没有发出去');
  if (status < 200 || status >= 300) throw new Error(explainFailure(status, rawBody));
  if (reply && reply.truncated) throw new Error('图床的回复被截断了，读不出链接（换小一点的图再试）');

  let parsed = null;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error(`上传成功了，但图床的回复不是 JSON：${text(rawBody, 120)}`);
  }
  const url = pickLink(parsed, ep.base);
  if (!url) {
    throw new Error(`上传成功了，但回复里没有链接：${text(rawBody, 160)}`);
  }
  return { url, name: String(file.name || ''), bytes: bytes.length, at: now() };
}

/** 把用户拖进来/选中的 File 读成字节，再上传。 */
async function uploadPicked(file) {
  const name = safeFilename(file && file.name, file && file.type);
  const mime = String((file && file.type) || '') || 'application/octet-stream';
  const bytes = await readFileBytes(file);
  return uploadBytes({ name, mime, bytes });
}

/**
 * File → 字节。
 *
 * 先走 `blob.arrayBuffer()`，没有它才退到 FileReader。两个都在时优先前者：它就是一个 Promise，
 * 不需要事件回调，也不依赖"读文件的实现会在哪个 tick 里派发 onload"——上传这条路上少一个能卡住
 * 的环节，比"多兼容一种老引擎"更值钱（WebView2 与 jsdom 都有 arrayBuffer）。
 */
async function readFileBytes(file) {
  if (!file) throw new Error('没有文件');
  if (typeof file.arrayBuffer === 'function') {
    const buffer = await file.arrayBuffer();
    return new Uint8Array(buffer || new ArrayBuffer(0));
  }
  return new Promise((resolve, reject) => {
    let reader = null;
    try {
      reader = new FileReader();
    } catch {
      reject(new Error('这个窗口读不了本地文件'));
      return;
    }
    reader.onload = () => resolve(new Uint8Array(reader.result || new ArrayBuffer(0)));
    reader.onerror = () => reject(new Error('读这个文件失败（它可能正被别的程序占用）'));
    reader.readAsArrayBuffer(file);
  });
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}


