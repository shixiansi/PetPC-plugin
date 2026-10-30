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
 * 「查词/查资料用的那一句」——剥掉调用方塞进来的**说话人前缀**与**图片提示**。
 *
 * 为什么需要：QQ 那边为了让模型知道谁在说话，发给核心的正文是 `白泽：蛆`、`时先思：区`
 * （`text: asker + 冒号 + ask`）。这个格式对**模型**是对的，对**查词/搜索**是灾难：
 *
 *   · 2026-10-30 真机：查 `时先思：区` 时，萌娘百科的 opensearch 解析成别的条目，回来一个
 *     missing page（109 B），于是「发区还是不知道啥意思」；
 *   · 同一晚 `白泽：蛆` 被解析成条目「白泽加奈惠」（一位声优）——前缀把整个查询带偏了。
 *
 * 只影响「拿去查」的字符串，**进 prompt 的原文一个字都不动**。
 *
 * 放在这个文件里是因为它先于 websearch.js 加载（两个消费方都要用），而它不碰 DOM——
 * 可以被 node 直接跑起来验（`lib/core.js` 一加载就要 document，验不了）。
 */
function lookupQueryOf(line) {
  let body = String(line || '').trim();
  // 说话人前缀：同一行里的第一个冒号，且前面不超过 24 字（`白泽：` / `时先思:`）
  body = body.replace(/^[^：:\n]{1,24}[：:]\s*/, '');
  // 图片提示（见 lib/memcore.js 的 imageNote）
  body = body.replace(/（这条消息带了[^）]*）/g, '');
  return body.trim();
}

/**
 * 问一次本地词库。
 *
 * @returns {Promise<{text: string, matched: string, hits: Array}|null>}
 *          `text` 是能直接拼进 system prompt 的段落；查不到就是 null。
 */
async function askSlang(line) {
  // 调用方给的是「谁：内容」，查词只要「内容」。
  const query = text(lookupQueryOf(line), 300).trim();
  if (!query) return null;
  const tried = new Set();
  for (const method of SLANG_METHODS) {
    for (const id of await providersFor(method)) {
      if (tried.has(id)) continue;
      tried.add(id);
      const hit = await askSlangProvider(id, method, query);
      if (hit) {
        // 顺手把"外面查到的"记进本地词库：下次同一个词就不用再联网了。
        //
        // 判据是**返回形状**，不是方法名：萌娘百科既提供 `slang` 也提供 `wiki`，按方法名判断会把
        // 它在 slang 通道上的回答漏掉（第一版就漏了，测试直接抓到）。本地词库返回 `hits`（结构化
        // 词条），百科返回 `entry`（正文）——`fromDictionary` 记的就是这件事。
        // 不 await：存起来是副作用，不该让用户多等一个往返。
        if (!hit.fromDictionary) void learnTerm(hit, id);
        return hit;
      }
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
/**
 * 把刚查到的一条释义写进**本地词库**（`com.shixiansi.plugin-slang` 的 `learn` 方法）。
 *
 * 用户的原话："萌娘百科搜索后的词应该添加到网络词词典，而不是每次都搜一次，效率太低了。"
 * 对：查过一次就该落地。这里做三件不显眼但必要的事：
 *
 *   · **不 await、不报错**：存词库是副作用，失败（没装词典 / 没给 learn 权限）不该影响这次回答；
 *   · **缺词或缺正文就不学**：否则会往词库里塞一条只有半句话的词条；
 *   · **名字带前缀**（`learnTerm`）：这些 lib 是经典脚本、共享全局作用域，重名会静默互相覆盖
 *     （`askOne` 那次就吃过这个亏）。
 */
async function learnTerm(hit, providerId) {
  const term = String((hit && hit.matched) || '').trim();
  const meaning = String((hit && hit.detail) || '').trim();
  if (!term || !meaning) return;
  try {
    await request('plugin.call', {
      target: 'com.shixiansi.plugin-slang',
      method: 'learn',
      payload: { term, meaning, source: providerId || '' },
    });
  } catch {
    // 词库没装 / 没授权：这次照常答，下次再查一遍就是了。
  }
}

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
    // `detail` 是**给词库用的正文**（百科的 extract），和 `text` 不同：`text` 是给模型读的一整段
    // （带指令与格式），存进词库只要那条释义本身。
    const detail = out.entry && typeof out.entry.extract === 'string'
      ? out.entry.extract
      : (Array.isArray(out.hits) && out.hits[0] && out.hits[0].meaning ? out.hits[0].meaning : '');
    const hits = Array.isArray(out.hits) ? out.hits : [];
    return {
      text: out.text,
      matched,
      detail,
      source: id,
      hits,
      // 本地词库自己答的（结构化 hits 非空）不必再学一遍；外面查到的才要落地。
      fromDictionary: hits.length > 0,
    };
  } catch {
    // 没装 / 没启用 / 没声明在 callTargets 里 / 被关掉 / 超时：都当作这一家问不到。
    return null;
  }
}
