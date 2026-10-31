// lib/bing.js —— Bing 每日壁纸：URL 解析与获取（网络细节全部走宿主的 net.fetch）
//
// Bing 的官方接口是 https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1
// （JSON：{images: [{url, title, copyright, startdate}]}）。返回的 url 是相对路径
// （/th?id=OHR.xxx），要拼上 https://www.bing.com。
//
// 这个文件只做两件纯的事：把 API 响应变成壁纸条目、把条目变成可抓取的绝对地址。
// 抓取编排（下载 → 解码 → 提色 → 入库）在 scrape.js；白名单只需 www.bing.com 与
// cn.bing.com（用户可选国内源）。

'use strict';

const BING_HOSTS = ['www.bing.com', 'cn.bing.com'];

/** 从 net.fetch 的 JSON body 里抠出壁纸条目。解析失败抛中文错误。 */
function bingParseResponse(bodyText, { host = 'www.bing.com' } = {}) {
  let data;
  try {
    data = JSON.parse(String(bodyText ?? ''));
  } catch {
    throw new Error('Bing 返回的不是 JSON（接口可能变了）');
  }
  const images = data && Array.isArray(data.images) ? data.images : [];
  if (!images.length) throw new Error('Bing 的响应里没有壁纸（images 为空）');
  const img = images[0];
  const rawUrl = String(img.url || '');
  if (!rawUrl) throw new Error('Bing 的壁纸条目缺少 url 字段');
  const url = rawUrl.startsWith('http') ? rawUrl : `https://${host}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;
  return {
    url,
    title: String(img.title || '').slice(0, 120),
    copyright: String(img.copyright || '').slice(0, 200),
    date: String(img.startdate || ''),
  };
}

/** 今天（本地时区）的 yyyymmdd，用于缓存键。 */
function bingTodayKey(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

const WallpaperBing = { bingParseResponse, bingTodayKey, BING_HOSTS };
