// lib/decode.js —— base64 → 像素缓冲（DOM 适配层）
//
// 沙箱里解码图片只有一条路：data: URL → <img> → canvas getImageData。
// 这一层被单独拆出来是因为它**无法在 jsdom 里测**（jsdom 没有 canvas 与图片解码器），
// 所以它必须薄到一眼看完，核心算法（提色、模糊）都不在这里。
//
// net.fetch 用 encoding:"base64" 拿二进制（手册 §6.10：文本形式对非 UTF-8 内容是有损的），
// 这里拼 data: URL 时按魔数猜 MIME（Bing 返回的总是 JPEG/PNG）。

'use strict';

const WALLPAPER_MAX_DIMENSION = 512; // 解码后最长边压到 512：提色与模糊都用不着原始分辨率

function sniffMime(base64) {
  if (/^iVBORw0KGgo/.test(base64)) return 'image/png';
  if (/^\/9j\//.test(base64)) return 'image/jpeg';
  if (/^R0lGOD/.test(base64)) return 'image/gif';
  if (/^Qk/.test(base64)) return 'image/bmp';
  if (/^UklGR/.test(base64)) return 'image/webp';
  return '';
}

/**
 * base64 图片 → {width, height, data}。解码失败（坏数据/不支持的格式）抛中文错误。
 * 真浏览器环境专用；测试不 import 这个文件。
 */
function decodeBase64Image(base64) {
  const mime = sniffMime(base64);
  if (!mime) throw new Error('不认识的图片格式（只支持 PNG/JPEG/GIF/BMP/WebP）');
  const url = `data:${mime};base64,${base64}`;
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, WALLPAPER_MAX_DIMENSION / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
        const w = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
        const h = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('拿不到 canvas 2d 上下文');
        ctx.drawImage(img, 0, 0, w, h);
        const imageData = ctx.getImageData(0, 0, w, h);
        resolve({ width: w, height: h, data: imageData.data });
      } catch (err) {
        reject(new Error(`图片解码失败：${String(err && err.message || err)}`));
      }
    };
    img.onerror = () => reject(new Error('图片解码失败（数据损坏或格式不支持）'));
    img.src = url;
  });
}

const WallpaperDecode = { decodeBase64Image, sniffMime, WALLPAPER_MAX_DIMENSION };
