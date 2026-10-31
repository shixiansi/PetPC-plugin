// lib/digest.js —— 晨报生成：新条目 → 模型 3 句话 → 语音/气泡
//
// 一次 runDigestCycle：
//
//   1. 逐源抓取（配置里的每一行），汇总"没见过"的条目；
//   2. 取最新的 maxItems 条，每条截 digestChars 字，编号排进一条 prompt；
//   3. plugin.call 问记忆核心的 chat：总结成 3 句话，语气符合桌宠人设；
//   4. speakDigest 时把这段总结交给语音插件的 speak（一段念完）；
//   5. bubbleDigest 时 bubble.say 弹一句（不念全文——气泡只有几秒）；
//   6. 存 lastDigest 与历史，发布 share 快照。
//
// 整个循环里有三个"一次调用最多等 30 秒"的墙（手册 §6.8 的 plugin.call 超时）：
// 抓取在插件自己手里（可配），模型与语音在对方手里。所以总结阶段的每一步都有
// timeout 包装——超时的那一步降级，不让整份晨报死在半路。

'use strict';

const MEMCORE_TARGET = 'com.shixiansi.plugin-memcore';
const MEMCORE_METHOD = 'chat';
const VOICE_TARGET = 'com.shixiansi.plugin-voice';
const VOICE_METHOD = 'speak';

/** 晨报会话：与屏幕视觉一样单独放一份记忆。 */
const DIGEST_ROLE = 'rss-morning';

/**
 * 给一个 promise 加超时。超时抛出带步骤名的中文——调用方决定降级还是失败。
 * （plugin.call 的宿主侧超时是 30 秒；这里更短，把"等不到"变成能说清楚的事。）
 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时（${Math.round(ms / 1000)} 秒）`)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

/** 新条目 → 一条 prompt（编号列表；空条目直接抛）。 */
function buildDigestPrompt(items, maxChars) {
  const lines = items.map((item, index) => {
    const body = excerpt(item, maxChars);
    return `[${index + 1}] ${body}`;
  });
  return [
    '以下是你订阅源里的新内容，请基于它们写今天的晨报：',
    ...lines,
  ].join('\n\n');
}

const DIGEST_SYSTEM = '你是用户的桌宠。收到一段订阅源摘要时，把它总结成正好 3 句话，语气轻快、口语化、像搭档在聊天，不要列表格式，不要标题，直接给正文。没有值得说的就直说今天没什么新东西。';

/** 问记忆核心要晨报。返回整理过的纯文本（≤400 字）。 */
async function askDigest(prompt) {
  const out = await withTimeout(
    request('plugin.call', {
      target: MEMCORE_TARGET,
      method: MEMCORE_METHOD,
      payload: { roleId: DIGEST_ROLE, userId: 'desktop', userName: '主人', text: prompt, hint: '这是晨报请求：请直接给 3 句话的总结正文' },
    }),
    num('timeoutSec', 10, 120, 30) * 1000,
    '等记忆核心总结',
  );
  const reply = out && typeof out.text === 'string' ? out.text : '';
  if (!reply.trim()) throw new Error('记忆核心没有返回内容（检查它的模型配置）');
  return text(reply.replace(/\s*\n+\s*/g, ' ').trim(), 400);
}

/** 把晨报交给语音插件念。失败不抛——念不出来时晨报本身已经成功了。 */
async function speakDigest(digestText) {
  try {
    await withTimeout(
      request('plugin.call', { target: VOICE_TARGET, method: VOICE_METHOD, payload: { text: digestText } }),
      num('timeoutSec', 10, 120, 30) * 1000,
      '等语音插件播报',
    );
    return true;
  } catch (err) {
    say(`语音播报失败：${text(err && err.message ? err.message : err, 120)}`);
    return false;
  }
}

/** 弹气泡（桌宠在场才显示；权限没给就是安静地跳过）。 */
async function bubbleDigest(digestText) {
  if (!granted.has('pet.bubble')) return false;
  try {
    await request('bubble.say', { text: `晨报：${text(digestText, 120)}` });
    return true;
  } catch {
    return false;
  }
}

/**
 * 一次完整晨报循环。面板按钮、定时器与 fetch_now 都走这里。
 *
 * @returns {Promise<object>} {at, feeds, items, prompt, headline, spoken, freshCount}
 */
async function runDigestCycle() {
  // 设置可能在另一个进程里改过（控制中心的插件页）：每轮都重读一次。
  await refreshConfig();
  const at = now();
  const feeds = [];
  const allFresh = [];

  for (const feedUrl of configuredFeeds()) {
    try {
      const { parsed, fresh } = await fetchAndRecord(feedUrl);
      feeds.push({ url: feedUrl, title: parsed.title, status: 'ok', fresh: fresh.length });
      allFresh.push(...fresh.map((item) => ({ ...item, feed: parsed.title || feedUrl })));
    } catch (err) {
      feeds.push({ url: feedUrl, status: 'error', error: text(err && err.message ? err.message : err, 160), fresh: 0 });
    }
  }

  // 没配源 / 全部源都没有新内容：也算一次"安静的晨报"——记录、不再往下走。
  const maxItems = num('maxItems', 1, 10, 5);
  const items = allFresh
    .sort((a, b) => (b.published || 0) - (a.published || 0))
    .slice(0, maxItems);

  if (!items.length) {
    // freshCount 也要给：面板与 fetch_now 的调用方都用它显示"0 条新内容"。
    const quiet = { at, feeds, items: [], prompt: '', headline: '今天订阅源里没有新内容。', spoken: false, freshCount: 0 };
    await saveLastDigest({ at, headline: quiet.headline, feeds });
    return quiet;
  }

  const prompt = buildDigestPrompt(items, num('digestChars', 100, 2000, 600));
  let headline;
  try {
    headline = await askDigest(prompt);
  } catch (err) {
    // 总结失败也要留下痕迹：源是好的，坏的是模型那一步——下次定时再试。
    const failed = { at, feeds, items: [], prompt, headline: '', error: text(err && err.message ? err.message : err, 200), spoken: false };
    await saveLastDigest({ at, headline: `（这一轮总结失败：${failed.error}）`, feeds });
    throw err;
  }

  let spoken = false;
  if (flag('speakDigest', true)) spoken = await speakDigest(headline);
  if (flag('bubbleDigest', true)) await bubbleDigest(headline);

  await saveLastDigest({ at, headline, feeds });
  try {
    await request('share.set', { name: 'rss-last-digest', value: JSON.stringify({ at, headline, freshCount: items.length }) });
  } catch {
    // 牌盘写不进去不影响晨报本身。
  }

  return { at, feeds, items, prompt, headline, spoken, freshCount: items.length };
}

/** 定时循环：intervalMin 一次（默认 120 分钟）；启动 30 秒后先补一轮（宿主半夜重启过的话）。 */
let digestTimer = null;

function scheduleDigest(firstDelayMs) {
  if (digestTimer) clearInterval(digestTimer);
  const intervalMin = Math.max(15, num('intervalMin', 15, 1440, 120));
  digestTimer = setInterval(() => {
    void runDigestCycle().catch(() => {});
  }, intervalMin * 60000);
  if (firstDelayMs > 0) {
    setTimeout(() => {
      void runDigestCycle().catch(() => {});
    }, firstDelayMs);
  }
}

function stopDigestTimer() {
  if (digestTimer) {
    clearInterval(digestTimer);
    digestTimer = null;
  }
}
