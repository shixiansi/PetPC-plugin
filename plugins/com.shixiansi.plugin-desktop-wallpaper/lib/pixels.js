// lib/pixels.js —— 像素级图像处理（纯函数：输入 RGBA 字节数组，不碰任何 DOM API）
//
// 为什么不用 canvas 的 getImageData 直接开工：jsdom 没有 canvas，插件包又必须在
// "真 iframe + 测试"两个环境里被同一套测试驱动。所以核心算法只认 {width, height, data}
// 的平面结构，DOM 解码（decodeImage）是 workshop.js 里的薄适配层。
//
// 两件事：
//   1. 主色调提取：k-means 聚类（k=5，采样 ≤4096 像素），按簇内像素占比×纯度排序，
//      过滤掉近白/近黑/近灰的"无信息色"。
//   2. 高斯模糊：三次 box blur 近似（两次水平 + 两次垂直，半径 r≈3σ/2），
//      O(1) 每像素的滑动窗口，不分配临时大数组之外的内存——模糊大图不会泄漏。

'use strict';

/** 像素缓冲：{width, height, data: Uint8ClampedArray|number[]}（RGBA 每像素 4 字节）。 */
function pxCreate(width, height, fill = 0) {
  const data = new Uint8ClampedArray(width * height * 4);
  if (fill) data.fill(fill);
  return { width, height, data };
}

function pxClone(buf) {
  return { width: buf.width, height: buf.height, data: new Uint8ClampedArray(buf.data) };
}

/** 从 RGBA 缓冲里等步长采样（最多 maxSamples 个像素），跳过完全透明的像素。 */
function pxSample(buf, maxSamples = 4096) {
  const { width, height, data } = buf;
  const total = width * height;
  const step = Math.max(1, Math.floor(total / maxSamples));
  const out = [];
  for (let i = 0; i < total; i += step) {
    const o = i * 4;
    if (data[o + 3] < 16) continue; // 全透明：没有颜色信息
    out.push([data[o], data[o + 1], data[o + 2]]);
  }
  return out;
}

/** RGB → HSL（h: 0-360, s/l: 0-1）。 */
function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h: h * 360, s, l };
}

/** 颜色距离（加权欧氏，人眼对绿色更敏感）。 */
function colorDist(a, b) {
  const dr = a[0] - b[0];
  const dg = (a[1] - b[1]) * 1.2;
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * k-means 主色调提取。
 * @returns {Array<{rgb:[number,number,number], hex:string, share:number, hsl:object}>}
 *          按占比降序；share ∈ (0,1]。
 */
function pxExtractPalette(buf, options = {}) {
  const k = Math.min(8, Math.max(2, options.k || 6));
  const samples = pxSample(buf, options.maxSamples || 4096);
  if (!samples.length) return [];
  // 初始质心：样本里均匀取 k 个（k-means++ 太贵，均匀采样对壁纸足够稳）。
  const centers = [];
  for (let i = 0; i < k; i += 1) {
    centers.push(samples[Math.floor((i / k) * samples.length)].slice());
  }
  const assign = new Array(samples.length).fill(0);
  // 迭代 ≤12 轮；质心移动 <2% 提前停。
  for (let iter = 0; iter < 12; iter += 1) {
    let moved = 0;
    for (let i = 0; i < samples.length; i += 1) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centers.length; c += 1) {
        const d = colorDist(samples[i], centers[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (assign[i] !== best) moved += 1;
      assign[i] = best;
    }
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < samples.length; i += 1) {
      const s = sums[assign[i]];
      s[0] += samples[i][0]; s[1] += samples[i][1]; s[2] += samples[i][2]; s[3] += 1;
    }
    for (let c = 0; c < centers.length; c += 1) {
      if (sums[c][3] > 0) {
        centers[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
      } else {
        // 空簇：取"离自己质心最远的样本"，把簇拉开（比随机稳）。
        let far = samples[0];
        let farD = -1;
        for (const s of samples) {
          const d = colorDist(s, centers[c]);
          if (d > farD) { farD = d; far = s; }
        }
        centers[c] = far.slice();
      }
    }
    if (moved / samples.length < 0.02) break;
  }
  // 汇总占比 + 过滤无信息色（近白/近黑/近灰）。
  const counts = centers.map(() => 0);
  for (const a of assign) counts[a] += 1;
  const out = [];
  for (let c = 0; c < centers.length; c += 1) {
    if (!counts[c]) continue;
    const rgb = centers[c].map((v) => Math.round(v));
    const hsl = rgbToHsl(rgb[0], rgb[1], rgb[2]);
    const isNeutral = hsl.s < 0.12 || hsl.l < 0.06 || hsl.l > 0.96;
    out.push({
      rgb,
      hex: `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`,
      share: counts[c] / samples.length,
      hsl,
      neutral: isNeutral,
    });
  }
  out.sort((a, b) => b.share - a.share);
  // 主色：优先"有信息"的（饱和度够、不太黑白），否则退回占比最大的。
  out.primary = out.find((c) => !c.neutral && c.share >= 0.04) || out[0] || null;
  return out;
}

/**
 * 滑动窗口 box blur（单方向）。radius=0 时原样返回。
 * 内部用累积和，每像素 O(1)；临时数组在函数返回时释放。
 */
function pxBoxBlurPass(buf, radius, horizontal) {
  if (radius <= 0) return buf;
  const { width, height, data } = buf;
  const out = new Uint8ClampedArray(data.length);
  const outer = horizontal ? height : width;
  const inner = horizontal ? width : height;
  const get = (o, i) => (horizontal ? (o * inner + i) * 4 : (i * outer + o) * 4);
  for (let o = 0; o < outer; o += 1) {
    let r = 0; let g = 0; let b = 0; let a = 0;
    let count = 0;
    for (let i = -radius; i <= radius; i += 1) {
      const ci = Math.min(inner - 1, Math.max(0, i));
      const p = get(o, ci);
      r += data[p]; g += data[p + 1]; b += data[p + 2]; a += data[p + 3];
      count += 1;
    }
    for (let i = 0; i < inner; i += 1) {
      const p = get(o, i);
      out[p] = r / count;
      out[p + 1] = g / count;
      out[p + 2] = b / count;
      out[p + 3] = a / count;
      const addIdx = Math.min(inner - 1, i + radius + 1);
      const subIdx = Math.max(0, i - radius);
      const pa = get(o, addIdx);
      const ps = get(o, subIdx);
      r += data[pa] - data[ps];
      g += data[pa + 1] - data[ps + 1];
      b += data[pa + 2] - data[ps + 2];
      a += data[pa + 3] - data[ps + 3];
    }
  }
  return { width, height, data: out };
}

/**
 * 高斯模糊近似：3 次 box blur（水平+垂直 交替）。sigma → radius ≈ ceil(1.5σ)。
 * 返回新缓冲，不改原缓冲。
 */
function pxGaussianBlur(buf, sigma = 4) {
  if (sigma <= 0) return pxClone(buf);
  const radius = Math.max(1, Math.round(sigma * 1.5));
  let cur = pxClone(buf);
  // 三次 pass：近似正态核（中心极限定理），视觉上与真高斯几乎无差。
  for (let pass = 0; pass < 3; pass += 1) {
    cur = pxBoxBlurPass(cur, radius, true);
    cur = pxBoxBlurPass(cur, radius, false);
  }
  return cur;
}

/** 主色 → CSS 渐变字符串（面板背景用）。 */
function pxColorToGradient(palette) {
  if (!palette || !palette.length) return '';
  const cs = palette.filter((c) => !c.neutral).slice(0, 3);
  const use = cs.length ? cs : palette.slice(0, 2);
  const stops = use.map((c, i) => `${c.hex} ${(i / Math.max(1, use.length - 1)) * 100}%`);
  return `linear-gradient(135deg, ${stops.join(', ')})`;
}

/** RGBA → PNG 之外的轻量预览格式：base64 的 BMP（面板 <img> 可直接显示，无需编码库）。 */
const WALL_BMP_HEADER_SIZE = 54;

function pxBmpDataUrl(buf) {
  const { width, height, data } = buf;
  const rowSize = Math.ceil((width * 3) / 4) * 4; // BMP 行按 4 字节对齐
  const pixelBytes = rowSize * height;
  const total = WALL_BMP_HEADER_SIZE + pixelBytes;
  const bytes = new Uint8Array(total);
  const dv = new DataView(bytes.buffer);
  // BITMAPFILEHEADER
  bytes[0] = 0x42; bytes[1] = 0x4d;
  dv.setUint32(2, total, true);
  dv.setUint32(10, WALL_BMP_HEADER_SIZE, true);
  // BITMAPINFOHEADER
  dv.setUint32(14, 40, true);
  dv.setInt32(18, width, true);
  dv.setInt32(22, -height, true); // 负高 = 自上而下
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 24, true);
  dv.setUint32(34, pixelBytes, true);
  dv.setUint32(38, 2835, true);
  dv.setUint32(42, 2835, true);
  // 像素（BGR、自下而上已被负高处理，按行写入即可）
  let o = WALL_BMP_HEADER_SIZE;
  const padding = rowSize - width * 3;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 4;
      const alpha = data[p + 3] / 255;
      bytes[o] = Math.round(data[p + 2] * alpha);
      bytes[o + 1] = Math.round(data[p + 1] * alpha);
      bytes[o + 2] = Math.round(data[p] * alpha);
      o += 3;
    }
    o += padding;
  }
  // Uint8Array → base64：手写编码器（分块防 call stack 爆炸）。
  // 为什么不用 btoa：jsdom 的 btoa 对部分 Latin-1 字符串有兼容怪癖（同输入真浏览器能编、
  // jsdom 抛 InvalidCharacterError）；一张 30 行的表驱动实现让两个环境行为逐字节一致。
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const end = Math.min(bytes.length, i + CHUNK);
    let chunk = '';
    for (let j = i; j < end; j += 3) {
      const b0 = bytes[j];
      const b1 = j + 1 < end ? bytes[j + 1] : 0;
      const b2 = j + 2 < end ? bytes[j + 2] : 0;
      chunk += B64[b0 >> 2];
      chunk += B64[((b0 & 3) << 4) | (b1 >> 4)];
      chunk += j + 1 < end ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
      chunk += j + 2 < end ? B64[b2 & 63] : '=';
    }
    out += chunk;
  }
  return `data:image/bmp;base64,${out}`;
}

const WallpaperPixels = {
  pxCreate, pxClone, pxSample, pxExtractPalette, pxGaussianBlur, pxBoxBlurPass,
  pxColorToGradient, pxBmpDataUrl, rgbToHsl, colorDist,
};
