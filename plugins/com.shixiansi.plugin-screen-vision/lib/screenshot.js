// lib/screenshot.js —— 截图管线：写任务文件 → 辅助脚本拍 → 读 meta → 拿到可用的图
//
// 插件侧不做任何像素工作。它只做四件事：
//
//   1. 向 storage.dir 要自己的私有目录（辅助脚本被启动时收到了同一个路径）；
//   2. 把一次抓取写成 capture.ask —— 辅助脚本轮询到它就拍、就上传；
//   3. 轮询 capture.meta，直到出现比任务时间新的完成标记；
//   4. 读 capture.upload，拿到上传服务返回的 URL（视觉模型从这里拉图）。
//
// WHY 不用 screen-share / getUserMedia：宿主的能力表里没有它们（§4.1 是穷尽的），
// process.launch + 本机脚本是唯一合法的像素通道（与 pet-sense 同一条路）。

'use strict';

const KEY_ASK = 'capture.ask';
const KEY_META = 'capture.meta';
const KEY_UPLOAD = 'capture.upload';
const KEY_HEALTH = 'health.json';

/** 拍一张图。返回完成时的 meta（含 bytes / sha256 / tookMs）；失败时抛"能拿去修"的中文。 */
async function captureOnce({ uploadUrl, region }) {
  const dirOut = await request('storage.dir', {});
  const dir = dirOut && dirOut.dir ? dirOut.dir : '';
  if (!dir) throw new Error('拿不到插件数据目录（storage.dir 没有返回 dir）');

  const since = now();
  await request('storage.set', { key: KEY_ASK, value: JSON.stringify({ region, uploadUrl, at: since }) });

  // 辅助脚本 600ms 轮询一次，截图本身 < 500ms，上传最长 20s；等到 25s 还没有就是脚本没在跑。
  // 步长 25ms：人感觉是即时的（真实脚本 600ms 一轮，25ms 的插件侧轮询不会空转出可见负载）。
  const meta = await pollMeta(since, 25000, 25);
  return meta;
}

/** 轮询 meta 出现完成标记。超时抛中文错误——错误文案要指向"怎么修"。 */
async function pollMeta(since, timeoutMs, stepMs) {
  const deadline = since + timeoutMs;
  let lastErr = '';
  while (now() < deadline) {
    await sleep(stepMs);
    const raw = await readJSON(KEY_META, null);
    if (raw && raw.at > since && raw.sha256) {
      return raw;
    }
    if (raw && raw.uploadError) {
      lastErr = `截图上传失败：${text(raw.uploadError, 120)}（检查「截图上传地址」是否可达）`;
    }
  }
  if (lastErr) throw new Error(lastErr);
  throw new Error('等截图超时（25 秒）：辅助脚本没在跑。检查设置里的 PowerShell 路径与脚本路径，然后重启桌宠');
}

/** 上传结果：辅助脚本把响应原文写进 capture.upload。返回 {url} 或 null。 */
async function readUploadResult() {
  const raw = await readJSON(KEY_UPLOAD, null);
  if (!raw) return null;
  // 约定：上传服务回一个 JSON {"url": "https://…"}；拿不到 url 就只报状态。
  const url = raw && typeof raw.url === 'string' ? raw.url : '';
  return { url, raw };
}

/** 辅助脚本健康（面板上那行"辅助脚本：…"+ workshop 页也读它）。 */
async function readHelperHealth() {
  const raw = await readJSON(KEY_HEALTH, null);
  if (!raw || !Number(raw.at)) return { alive: false, at: 0 };
  const age = now() - Number(raw.at);
  // 健康文件 5 秒一刷；15 秒没动静 = 脚本被关掉了。
  return { alive: age < 15000, at: Number(raw.at), age };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** region 选项的合法值：超出的一律按 full 处理（协议要求的宽容）。 */
function cleanRegion(value) {
  return value === 'primary' ? 'primary' : 'full';
}
