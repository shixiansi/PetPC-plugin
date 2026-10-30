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

const SLANG_TARGET = 'com.shixiansi.plugin-slang';
const SLANG_METHOD = 'slang';

/**
 * 问一次本地词库。
 *
 * @returns {Promise<{text: string, matched: string, hits: Array}|null>}
 *          `text` 是能直接拼进 system prompt 的段落；查不到就是 null。
 */
async function askSlang(line) {
  const query = text(line, 300).trim();
  if (!query) return null;
  try {
    const out = await request('plugin.call', {
      target: SLANG_TARGET,
      method: SLANG_METHOD,
      payload: { query },
    });
    if (!out || typeof out.text !== 'string' || !out.text.trim()) return null;
    return {
      text: out.text,
      matched: typeof out.matched === 'string' ? out.matched : '',
      hits: Array.isArray(out.hits) ? out.hits : [],
    };
  } catch {
    // 没装 / 没启用 / 没声明在 callTargets 里 / 被关掉了：一律当作"没有词库"。
    return null;
  }
}
