// lib/multipart.js —— 把"一个文件"拼成一段 multipart/form-data 的**字节**
//
// 为什么要自己拼，而不是让浏览器帮忙（`new Request(url, {body: formData})` 之后读回
// `arrayBuffer()` 也能拿到同样的字节）：
//
//   1. 那样写要 `Request` / `Response` / `FormData` 三件套，而这三个在 jsdom 里没有——插件的
//      用例就得为了这一行去装 polyfill，而 polyfill 通过 ≠ 真浏览器通过；
//   2. 边界（boundary）出现在 `content-type` 头里，**必须**和正文里的那几行逐字一致。自己拼
//      则两样出自同一个变量，不可能对不上。
//
// 全是纯函数、只碰 Uint8Array：这是本插件里唯一"算错了会静默产出一个坏文件"的地方，所以要能被
// 逐字节断言。

'use strict';

/**
 * 一段字符串的 UTF-8 字节。
 *
 * 手写而不是 `TextEncoder`：jsdom 不提供它，而插件页要能在测试里跑一遍。代理对
 * （emoji、部分符号）必须按 4 字节编码，否则文件名里的一个 emoji 会让整个 multipart 头坏掉。
 */
function utf8Bytes(value) {
  const str = String(value === undefined || value === null ? '' : value);
  const out = [];
  for (let i = 0; i < str.length; i += 1) {
    let code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const low = str.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
}

/** 标准字母表的 64 个字符。手写 base64 就是为了不依赖 `btoa`/`atob`（见下面两个函数的注释）。 */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * 字节 → base64。
 *
 * 不用 `btoa`，两个理由，第二个是真的踩到的：
 *
 *   1. 大数组要分块喂进去（`String.fromCharCode(...bytes)` 会顶爆调用栈），于是代码里多一层
 *      与 base64 无关的循环；
 *   2. **它会卡住。** 2026-11-02 写这个插件的用例时，jsdom 环境里的 `btoa` 对
 *      `btoa(String.fromCharCode.apply(null, tinyArray))` 直接不返回——整个测试进程无声地停住，
 *      连超时都不触发。一个"算 184 个字节的 base64"的函数不该有能力把宿主页面挂住，所以这里
 *      自己算：纯算术、无全局依赖、可逐字节断言。
 */
function base64FromBytes(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[b2 & 0x3f] : '=';
  }
  return out;
}

/**
 * base64 → 字节。给 plugin.call 的 data URL 那条路用。
 *
 * 同样不用 `atob`：白名单之外的一切字符都被当作空白丢掉（真实的 data URL 里会带换行），
 * 非法字符则报错——一个坏掉的 data URL 应该立刻变成一句"这不是 base64"，而不是一段猜测出来的字节。
 */
function bytesFromBase64(value) {
  const clean = String(value === undefined || value === null ? '' : value).replace(/[^A-Za-z0-9+/]/g, '');
  if (!clean) return new Uint8Array(0);
  const out = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64.indexOf(clean[i]);
    const c1 = i + 1 < clean.length ? B64.indexOf(clean[i + 1]) : -1;
    const c2 = i + 2 < clean.length ? B64.indexOf(clean[i + 2]) : -1;
    const c3 = i + 3 < clean.length ? B64.indexOf(clean[i + 3]) : -1;
    if (c0 < 0 || c1 < 0) throw new Error('base64 里有不在字母表里的字符');
    out.push((c0 << 2) | (c1 >> 4));
    if (c2 >= 0) out.push(((c1 & 0x0f) << 4) | (c2 >> 2));
    if (c3 >= 0) out.push(((c2 & 0x03) << 6) | c3);
  }
  return new Uint8Array(out);
}

/**
 * `data:image/png;base64,…` → {mime, bytes}。给 plugin.call 用。
 *
 * 只认 `;base64,` 这一种 data URL：非 base64 的 data URL（百分号编码）在图片里没人用，
 * 而"支持一半"比不支持更难解释。
 */
function bytesFromDataUrl(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  const comma = raw.indexOf(',');
  if (!/^data:/i.test(raw) || comma < 0) throw new Error('不是一个 data URL');
  const meta = raw.slice(5, comma);
  if (!/;base64$/i.test(meta)) throw new Error('只认 data:<type>;base64,<数据> 这种写法');
  const mime = meta.slice(0, meta.length - ';base64'.length) || 'application/octet-stream';
  const bytes = bytesFromBase64(raw.slice(comma + 1));
  if (!bytes.length) throw new Error('data URL 里没有数据');
  return { mime, bytes };
}

/** 三种常见图片的扩展名。认不出来就留空——宁可不带扩展名，也不要给它编一个错的。 */
const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
};

/**
 * 文件名消毒：去掉分隔符、引号与换行，并截到 120 字符。
 *
 * 它会被写进 `Content-Disposition: form-data; name="file"; filename="…"`——一个引号或一个换行
 * 就能让这行头提前结束，于是服务端收到的不是"一个叫 a.png 的文件"，而是"一个名字古怪的文件"，
 * 或者直接 400。图床还会拿它当存储名（`uploadNameType=default` 是 `前缀_原名`）。
 */
function safeFilename(value, fallbackMime) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  const base = raw.split(/[\\/]/).pop() || '';
  const cleaned = base.replace(/["\r\n\t]/g, '').replace(/[\u0000-\u001f]/g, '');
  if (cleaned) return cleaned.slice(0, 120);
  const ext = EXT_BY_MIME[String(fallbackMime || '').toLowerCase()] || 'bin';
  return `image.${ext}`;
}

/** 一段 16 进制随机数，够当一个不会撞的 boundary 了（它只需要在一份正文里唯一）。 */
function randomBoundary() {
  let out = '----PetPCFormBoundary';
  for (let i = 0; i < 16; i += 1) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

/**
 * 拼一份单字段的 multipart/form-data。
 *
 * 返回的 `contentType` **必须**原样放进 `net.fetch` 的 `content-type` 头：没有它，服务端不知道
 * boundary 在哪，只会回一句"没有文件"——这正是 2026-11-02 之前控制中心那份 net.fetch 忽略
 * `headers` 时，插件看起来"上传失败"的样子。
 */
function buildMultipartBody({ field, filename, mime, bytes, boundary }) {
  const name = String(field || 'file');
  const type = String(mime || 'application/octet-stream');
  const bound = String(boundary || randomBoundary());
  const head = utf8Bytes(
    `--${bound}\r\n` +
      `Content-Disposition: form-data; name="${name}"; filename="${safeFilename(filename, type)}"\r\n` +
      `Content-Type: ${type}\r\n\r\n`,
  );
  const tail = utf8Bytes(`\r\n--${bound}--\r\n`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);
  return { body, boundary: bound, contentType: `multipart/form-data; boundary=${bound}` };
}
