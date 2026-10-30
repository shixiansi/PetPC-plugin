// lib/slang.js —— 先问本地词库，再考虑上网
//
// 为什么网络词要**先查本地**而不是交给搜索引擎：
//
//   · 它是免费的：一次 `plugin.call` 到本机插件，微秒级，没有网络、没有模型、不占预算；
//   · 它更准：搜索引擎对"尊嘟假嘟""显眼包"返回的是二手网页，而词库给的是**释义本身**；
//   · 它守时：上面那条链的预算是挤出来的（宿主 plugin.call 只有 30 秒），能省一次搜索就省一次。
//
// 词库插件没装 / 没启用 / 没插词条时，这里返回 null，对话照常按记忆回答——**词库是增强，不是依赖**，
// 和后备搜索链同一个原则。
'use strict';

/**
 * 提供方是**发现**来的，不是写死的（见 lib/services.js）。
 *
 * 顺序有含义：先问提供 `slang` 的（本地词库，免费且快），都不行再问提供 `wiki` 的
 * （萌娘百科那类，要联网）。同一个插件可能两个方法都提供，所以按 id 去重。
 */
const SLANG_METHODS = ['slang', 'wiki'];

/**
 * 问一次本地词库。
 *
 * @returns {Promise<{text: string, matched: string, hits: Array}|null>}
 *          `text` 是能直接拼进 system prompt 的段落；查不到就是 null。
 */
async function askSlang(line) {
  const query = text(line, 300).trim();
  if (!query) return null;
  const tried = new Set();
  for (const method of SLANG_METHODS) {
    for (const id of await providersFor(method)) {
      if (tried.has(id)) continue;
      tried.add(id);
      const hit = await askSlangProvider(id, method, query);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * 问一个提供方。任何失败都返回 null——这一家不行就问下一家，绝不让对话失败。
 *
 * 名字带 `Slang` 是必须的：这些 lib 文件是**经典脚本、共享同一个全局作用域**，而
 * `lib/websearch.js` 里已经有一个 `askOne`（签名叫 `askOne(target, query, count)`）。同名会
 * 静默互相覆盖——2026-10-30 就这样把两边都打崩了（payload 变成 `{query:'slang'}`）。
 */
async function askSlangProvider(id, method, query) {
  try {
    const out = await request('plugin.call', {
      target: id,
      method,
      payload: { query },
    });
    if (!out || typeof out.text !== 'string' || !out.text.trim()) return null;
    // `matched` 是本地词库的说法，`title` 是百科的说法：两者都当作"命中了哪个条目"。
    const matched = typeof out.matched === 'string' && out.matched
      ? out.matched
      : (typeof out.title === 'string' ? out.title : '');
    return {
      text: out.text,
      matched,
      source: id,
      hits: Array.isArray(out.hits) ? out.hits : [],
    };
  } catch {
    // 没装 / 没启用 / 没声明在 callTargets 里 / 被关掉 / 超时：都当作这一家问不到。
    return null;
  }
}
