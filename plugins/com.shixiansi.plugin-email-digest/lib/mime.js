// lib/mime.js —— RFC822/MIME 解析：信封、编码、纯文本正文
//
// 宿主的能力表里没有邮件，原始邮件文本由邮件桥（tools/mail-bridge.mjs）从 IMAP
// 拉回来。这里做的是把一封 RFC822 文本变成"能读的一段话"：
//
//   1. 信封：From / To / Subject / Date（含 RFC2047 编码的标题 =?utf-8?B?…?=）；
//   2. multipart 拆解：text/plain 优先，text/html 兜底（剥标签），附件跳过；
//   3. 传输编码：Quoted-Printable 与 Base64（按 charset 解，默认 UTF-8）。
//
// 三条纪律：
//   · 解析失败返回"尽力而为的部分"——一封坏邮件不该让整批摘要失败；
//   · 所有长度上限由调用方传（maxBodyChars），函数本身只做形状；
//   · 附件的文件名要收集（列表里显示"含 2 个附件"），但内容绝不读。

'use strict';

const MimeParser = {
  /** 主入口：原始 RFC822 文本 → 结构化邮件。 */
  parse(raw) {
    const text = String(raw === undefined || raw === null ? '' : raw);
    const split = splitHeadersBody(text);
    const headers = parseHeaders(split.headers);
    const ctype = parseContentType(headers['content-type'] || '');

    const mail = {
      from: decodeRfc2047(headers.from || ''),
      fromEmail: extractEmail(headers.from || ''),
      to: decodeRfc2047(headers.to || ''),
      subject: decodeRfc2047(headers.subject || '').replace(/\s+/g, ' ').trim(),
      date: headers.date || '',
      attachments: [],
      body: '',
      bodyIsHtml: false,
    };

    if (ctype.isMultipart) {
      const parts = splitMultipart(split.body, ctype.boundary);
      let htmlFallback = '';
      for (const part of parts) {
        const pType = parseContentType(part.headers['content-type'] || '');
        const pEnc = String(part.headers['content-transfer-encoding'] || '').trim().toLowerCase();
        const disposition = String(part.headers['content-disposition'] || '');
        if (/attachment/i.test(disposition)) {
          const m = disposition.match(/filename="?([^";]+)"?/i);
          if (m) mail.attachments.push(decodeRfc2047(m[1]));
          continue;
        }
        if (pType.type === 'text/plain' && !mail.body) {
          mail.body = decodeTransfer(part.body, pEnc);
        } else if (pType.type === 'text/html' && !htmlFallback) {
          htmlFallback = decodeTransfer(part.body, pEnc);
        }
      }
      if (!mail.body && htmlFallback) {
        mail.body = stripHtml(htmlFallback);
        mail.bodyIsHtml = true;
      }
    } else {
      const enc = String(headers['content-transfer-encoding'] || '').trim().toLowerCase();
      const body = decodeTransfer(split.body, enc);
      if (ctype.type === 'text/html') {
        mail.body = stripHtml(body);
        mail.bodyIsHtml = true;
      } else {
        mail.body = body;
      }
    }
    return mail;
  },

  /** 把一封邮件压成给模型看的形状（发件人 + 主题 + 正文片段）。 */
  toPrompt(mail, maxBodyChars) {
    const limit = Number.isFinite(maxBodyChars) && maxBodyChars > 0 ? maxBodyChars : 4000;
    const body = Array.from(mail.body || '');
    const clipped = body.length > limit;
    const lines = [
      `发件人：${mail.from || '(未知)'} ${mail.fromEmail ? `<${mail.fromEmail}>` : ''}`.trim(),
      `主题：${mail.subject || '(无主题)'}`,
      mail.attachments.length ? `附件：${mail.attachments.join('、')}` : '',
      '正文：',
      body.slice(0, limit).join(''),
      clipped ? '…（正文已截断）' : '',
    ].filter(Boolean);
    return lines.join('\n');
  },
};

/** 拆头与体（第一个空行为界；\r\n 与 \n 都认）。 */
function splitHeadersBody(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  const at = normalized.indexOf('\n\n');
  if (at < 0) return { headers: normalized, body: '' };
  return { headers: normalized.slice(0, at), body: normalized.slice(at + 2) };
}

/** 头解析：支持折行（以空格/制表符开头的行接着上一行）。 */
function parseHeaders(headersText) {
  const out = {};
  let current = '';
  for (const line of headersText.split('\n')) {
    if (/^[ \t]/.test(line) && current) {
      out[current] += ` ${line.trim()}`;
      continue;
    }
    const at = line.indexOf(':');
    if (at > 0) {
      current = line.slice(0, at).trim().toLowerCase();
      out[current] = line.slice(at + 1).trim();
    }
  }
  return out;
}

/** Content-Type: type/subtype; boundary="…"; charset=… */
function parseContentType(value) {
  const raw = String(value || '');
  const main = raw.split(';')[0].trim().toLowerCase();
  const isMultipart = /^multipart\//.test(main);
  let boundary = '';
  const bm = raw.match(/boundary="?([^";]+)"?/i);
  if (bm) boundary = bm[1];
  let charset = '';
  const cm = raw.match(/charset="?([\w-]+)"?/i);
  if (cm) charset = cm[1];
  return { type: main, isMultipart, boundary, charset };
}

/** 按 boundary 拆 multipart。boundary 前面通常有 "--"。 */
function splitMultipart(body, boundary) {
  const parts = [];
  if (!boundary) return parts;
  const normalized = body.replace(/\r\n/g, '\n');
  const marker = `--${boundary}`;
  const segments = normalized.split(marker);
  // segments[0] 是 preamble，最后一段的结尾是 "--"（epilogue）。
  for (let i = 1; i < segments.length; i += 1) {
    const seg = segments[i];
    if (seg.startsWith('--')) break; // closing marker
    const trimmed = seg.replace(/^\n+/, '').replace(/\n--\s*$/, '');
    const split = splitHeadersBody(trimmed);
    parts.push({ headers: parseHeaders(split.headers), body: split.body });
  }
  return parts;
}

/** Quoted-Printable / Base64 / 7bit-8bit 解码（字节层完成，再按 UTF-8 收）。 */
function decodeTransfer(body, encoding) {
  if (encoding === 'base64') {
    try {
      return b64ToUtf8(body.replace(/[^A-Za-z0-9+/=]/g, ''));
    } catch {
      return body;
    }
  }
  if (encoding === 'quoted-printable') {
    return qpToUtf8(body);
  }
  return body;
}

function qpToUtf8(text) {
  // 先去掉软换行 =\n，再把 =XX 序列收集成字节流。
  const noSoft = text.replace(/=\n/g, '');
  const bytes = [];
  let i = 0;
  while (i < noSoft.length) {
    const c = noSoft[i];
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(noSoft.slice(i + 1, i + 3))) {
      bytes.push(parseInt(noSoft.slice(i + 1, i + 3), 16));
      i += 3;
      continue;
    }
    // 非 ASCII 字符按 UTF-8 原样取码元再编码（jsdom 环境的字符串已是 UTF-16）。
    const code = noSoft.codePointAt(i);
    const chunk = String.fromCodePoint(code);
    for (const b of new TextEncoder().encode(chunk)) bytes.push(b);
    i += chunk.length;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
}

function b64ToUtf8(text) {
  return new TextDecoder('utf-8', { fatal: false }).decode(b64Bytes(text));
}

/**
 * 剥 HTML：script/style 连内容一起去掉，块级标签换行，其余标签剥掉，
 * 实体解最常见的几个，空白压缩。够"读"用，不做 HTML 的完整渲染。
 */
function stripHtml(html) {
  return String(html === undefined || html === null ? '' : html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|tr|h[1-6]|li|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** RFC2047：=?charset?B/Q?…?= （连续编码段直接拼接）。 */
function decodeRfc2047(value) {
  const raw = String(value === undefined || value === null ? '' : value);
  return raw.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (all, charset, enc, payload) => {
    try {
      if (enc.toLowerCase() === 'b') {
        return decodeBytes(b64Bytes(payload), charset);
      }
      // Q 编码：下划线 = 空格，=XX 同 QP。
      return decodeBytes(qpBytes(payload.replace(/_/g, ' ')), charset);
    } catch {
      return all;
    }
  }).replace(/\?=\s*=\?/g, '?='); // 相邻编码段之间的空白折叠
}

function qpBytes(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    for (const b of new TextEncoder().encode(c)) bytes.push(b);
  }
  return new Uint8Array(bytes);
}

/** 手写的 base64 解码：不依赖 atob（jsdom 的 atob 对长度/字符集比浏览器严格，
 *  一个差一位的填充就会让整封邮件"看起来成功了"实际是乱码）。 */
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64Bytes(text) {
  const cleaned = text.replace(/[^A-Za-z0-9+/=]/g, '').replace(/=+$/, '');
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const c of cleaned) {
    const value = B64_ALPHABET.indexOf(c);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

/** gb2312/gbk 等非 UTF-8 的字符集在沙箱里解不了：至少把 ASCII 部分保住，别的替换。 */
function decodeBytes(bytes, charset) {
  const cs = String(charset || 'utf-8').toLowerCase();
  if (cs.includes('utf-8') || cs.includes('utf8') || cs.includes('us-ascii') || cs.includes('ascii')) {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
  try {
    return new TextDecoder(cs, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

function extractEmail(value) {
  const m = String(value || '').match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
  return m ? m[0] : '';
}
