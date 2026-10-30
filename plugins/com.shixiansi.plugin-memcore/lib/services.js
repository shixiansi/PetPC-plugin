// lib/services.js —— 能力发现：问宿主"谁能干什么"，别把插件 id 写死
//
// 为什么需要这一层（宿主为此加了 `plugins.services`）：
//
//   调用方只能到达自己在 manifest 的 `callTargets` 里**声明过**的目标，而以前没有任何东西告诉它
//   "有哪些目标存在"。于是"谁能查释义 / 谁能搜网页"这件事被写死在每个消费方里——记忆核心每加一个
//   功能就学一个插件 id，新装的插件在有人改核心之前是隐形的。现在读安装状态就够了：`serves` 是插件
//   的承诺，而**没人能发现的承诺等于没承诺**。
//
// 两层：先问宿主；问不到（老宿主没有这个方法）就退回这张已知清单——功能不能因为宿主旧一点就消失。
'use strict';

/** 老宿主的兜底：已知的提供方，按优先级。 */
const KNOWN_PROVIDERS = {
  slang: ['com.shixiansi.plugin-slang', 'com.shixiansi.plugin-moegirl'],
  wiki: ['com.shixiansi.plugin-moegirl'],
  search: ['com.shixiansi.plugin-websearch', 'com.shixiansi.plugin-bilibili'],
};

/**
 * 缓存多久。
 *
 * **不能永久缓存**：2026-10-30 真机上就栽在这里——记忆核心的常驻帧只在挂载时问了一次
 * `plugins.services`（那时「网络词词典」「萌娘百科」还没装完），之后整场会话都用那份旧名单，
 * 于是新装的提供方**一次都没被调用过**（用户："发区还是不知道啥意思"）。
 * 安装/更新插件发生在桌宠运行期间，是很常见的事。
 *
 * 60 秒：一次查询只是一条本地请求，代价可以忽略；而"刚装的插件一秒内就能用上"值得这个代价。
 */
const SERVICES_TTL_MS = 60000;
let discovered = null;
let discoveredAt = 0;

/** 问宿主一次（失败或不支持就返回 null，调用方退到 KNOWN_PROVIDERS）。 */
async function listServices() {
  if (discovered && Date.now() - discoveredAt < SERVICES_TTL_MS) return discovered;
  try {
    const out = await request('plugins.services', {});
    const rows = Array.isArray(out && out.services) ? out.services : [];
    if (!rows.length) return null;
    discovered = rows;
    discoveredAt = Date.now();
    return discovered;
  } catch {
    return null;
  }
}

/**
 * 谁会答 `method`，按优先级。
 *
 * `prefer` 用来把某个 id 提到最前（比如"整网搜索优先、B 站补位"这种顺序是意图，不是发现结果）。
 */
async function providersFor(method, prefer) {
  // 第一次没找到提供方，就当作"名单可能过期了"：作废缓存再问一次。刚装上的插件因此**立刻**
  // 可用，而不必等 60 秒 TTL，更不必重启桌宠。
  const found = await collectProviders(method, prefer);
  if (found.length) return found;
  resetServicesCache();
  return collectProviders(method, prefer);
}

async function collectProviders(method, prefer) {
  const rows = await listServices();
  let ids;
  if (rows) {
    ids = rows
      .filter((row) => Array.isArray(row.serves) && row.serves.includes(method))
      .map((row) => String(row.id || ''))
      .filter(Boolean);
    // 宿主只告诉我们"谁能"，没告诉我们"先问谁"——所以把已知清单的顺序当作优先级来排序，
    // 不认识的提供方排在后面（新装的插件也能用上，只是优先级最低）。
    const known = KNOWN_PROVIDERS[method] || [];
    ids.sort((a, b) => {
      const ia = known.indexOf(a);
      const ib = known.indexOf(b);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
  } else {
    ids = [...(KNOWN_PROVIDERS[method] || [])];
  }
  if (prefer) {
    ids = [prefer, ...ids.filter((id) => id !== prefer)];
  }
  return ids;
}

/** 测试接缝：清掉发现缓存。 */
function resetServicesCache() {
  discovered = null;
  discoveredAt = 0;
}
