// lib/tomd.js —— HTML → Markdown 转换（turndown 封装）
//
// turndown 是 UMD 包（lib/turndown.js，经典 script 加载后挂全局 TurndownService）。
// 这里只做三件事：
//   1. 实例化一次，配上项目的过滤规则（去掉隐藏节点、脚本残留、超长属性）；
//   2. 修掉它对嵌套列表/代码块的两处默认行为，输出更接近 GitHub Flavored 风格；
//   3. 提供 toMarkdown(html)：入参是 extract.js 选出的正文 HTML，出参是字符串。
//
// turndown 在 jsdom 与真 iframe 里都能跑（它内部用正则 + DOM 查询，全局 document 即可），
// 测试里把 extract + turndown 串起来驱动真实转换。

'use strict';

/** 默认丢弃的节点：turndown 保留它们只会产生噪音。 */
const DROP_SELECTOR = [
  'script', 'style', 'noscript', 'iframe', 'form', 'button', 'input', 'select',
  'textarea', 'nav', 'aside', 'footer', 'svg', 'canvas', 'video', 'audio', 'object', 'embed',
].join(',');

/** 长度上限：单段正文超过它截断（输出给 AI 读，太长没有意义）。 */
const MAX_MARKDOWN_CHARS = 60000;

function createConverter(TurndownServiceCtor) {
  if (typeof TurndownServiceCtor !== 'function') {
    throw new Error('turndown 没有加载（全局 TurndownService 不存在）');
  }
  const svc = new TurndownServiceCtor({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    strongDelimiter: '**',
    hr: '---',
    br: '  \n',
  });

  // 隐藏节点与噪音标签：整体丢弃。remove 接受函数过滤器（turndown 会逐节点调用）。
  const dropSet = new Set(DROP_SELECTOR.split(','));
  svc.remove((node) => node && node.nodeName && dropSet.has(node.nodeName.toLowerCase()));

  // 链接保留 href；相对地址拼上页面基址，输出给 AI 时才知道指向哪里。
  svc.addRule('absolute-links', {
    filter: (node) => node.nodeName === 'A' && node.getAttribute('href'),
    replacement: (content, node) => {
      const href = (node.getAttribute('href') || '').trim();
      const base = createConverter.baseUrl || '';
      let abs = href;
      if (base && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) {
        try { abs = new URL(href, base).href; } catch { abs = href; }
      }
      if (!content.trim()) return '';
      return `[${content}](${abs})`;
    },
  });

  // 图片：alt 优先，没有 alt 用文件名。
  svc.addRule('images-with-alt', {
    filter: (node) => node.nodeName === 'IMG',
    replacement: (content, node) => {
      const alt = (node.getAttribute('alt') || '').trim();
      const src = (node.getAttribute('src') || '').trim();
      if (!src) return '';
      return `![${alt || 'image'}](${src})`;
    },
  });

  return {
    /** @param {string} html @param {{baseUrl?:string}} [opts] */
    toMarkdown(html, opts = {}) {
      createConverter.baseUrl = String(opts.baseUrl || '');
      try {
        let out = String(svc.turndown(String(html ?? '')));
        out = out.replace(/\n{3,}/g, '\n\n').trim();
        if (out.length > MAX_MARKDOWN_CHARS) {
          out = `${out.slice(0, MAX_MARKDOWN_CHARS)}\n\n…（已截断，原文更长）`;
        }
        return out;
      } finally {
        createConverter.baseUrl = '';
      }
    },
  };
}

const ScraperToMd = { createConverter, MAX_MARKDOWN_CHARS, DROP_SELECTOR };
