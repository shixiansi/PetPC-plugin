// lib/review.js —— 审查与测试生成：plugin.call('chat') 的两种问法
//
// 代码审查走记忆核心（人设与对话上下文都在那边；会话键 coder-review，审查历史连成串），
// 这是任务书的原话："你是代码审查专家，请找出这段代码的 Bug 并给出重构建议"。
//
// 测试生成是第二个问法：让模型产出**一个完整的 .test.js 文件**，插件只做三件事：
//   1. 校验产物形状（必须是 vitest 风格的 test/it 块，超长截断）；
//   2. 算出目标路径（同名 .test.js）；
//   3. 先读目标、再写目标——已存在且非空时不覆盖，返回"已存在"让用户决定。
//
// WHY 不直接 llm.chat
//
// 会话连续性：用户常常先问审查、再问"给第一个函数生成测试"，这两轮应该共享上下文。
// plugin.call 交给记忆核心之后，这些往来自动进同一份会话记忆（roleId 固定），插件
// 一个字都不用存。

'use strict';

const reviewState = {
  busy: false,
  last: null,          // 最近一次审查 {at, source, answer, chars}
  lastError: '',
};

const REVIEW_ROLE = 'coder-review';

/** 把一段代码整理成送审形状：截断要说明，别让模型以为那就是全文。 */
function clampCode(code) {
  const max = num('reviewMaxChars', 500, 60000, 6000);
  const body = String(code === undefined || code === null ? '' : code);
  if (Array.from(body).length <= max) return { text: body, clipped: false };
  return { text: `${Array.from(body).slice(0, max).join('')}\n/* …（已截断，原文共 ${Array.from(body).length} 字符）*/`, clipped: true };
}

/**
 * 审查一段代码。payload {code, lang?, note?}
 * 返回 {answer, clipped, roleId}。
 */
async function handleReview(payload) {
  const code = clampCode(payload && payload.code);
  if (!code.text.trim()) throw new Error('review 需要一段代码（code 不能为空）');
  const lang = text(payload && payload.lang, 24) || 'JavaScript';
  const note = text(payload && payload.note, 200);

  const lines = [
    '你是代码审查专家，请找出这段代码的 Bug 并给出重构建议。',
    `语言：${lang}。`,
    note ? `背景说明：${note}` : '',
    '要求：',
    '1. 按严重程度列出 Bug（每个 Bug 给出所在行附近的证据）；',
    '2. 给出最多 3 条重构建议，说明为什么值得改；',
    '3. 不要重写整段代码，不要输出修复后的完整文件。',
    '代码：',
    '```',
    code.text,
    '```',
  ].filter(Boolean).join('\n');

  let answer = '';
  try {
    const out = await request('plugin.call', {
      target: 'com.shixiansi.plugin-memcore',
      method: 'chat',
      payload: { roleId: REVIEW_ROLE, userId: 'local', userName: '开发者', text: lines },
    });
    answer = String((out && out.text) || '').trim();
  } catch (err) {
    reviewState.lastError = `记忆核心没有回答：${text(err && err.message, 120)}`;
    throw err;
  }
  if (!answer) {
    reviewState.lastError = '记忆核心返回了空审查';
    throw new Error('记忆核心返回了空审查');
  }
  reviewState.last = { at: now(), chars: Array.from(answer).length, answer, clipped: code.clipped };
  reviewState.lastError = '';
  return { answer, clipped: code.clipped, roleId: REVIEW_ROLE };
}

/**
 * 生成测试。payload {code, name?, lang?}
 *
 * 返回 {code: 测试文件内容, target: 目标路径, wrote, existedBefore?, bytes?}。
 * wrote=false 且 existedBefore=true = 目标已存在且非空，**没有覆盖**。
 */
async function handleGenTests(payload) {
  const code = clampCode(payload && payload.code);
  if (!code.text.trim()) throw new Error('genTests 需要一段代码（code 不能为空）');
  const name = sanitizeName(payload && payload.name);

  const lines = [
    '你是测试工程师。请为下面的代码生成一个完整的 vitest 测试文件。',
    '要求：',
    '1. 直接输出测试文件的全部内容，用一个 ``` 包住，不要解释；',
    '2. 覆盖正常路径、边界条件与至少一个错误路径；',
    '3. 用 describe/test 组织，中文测试名；',
    '4. 不要 mock 被测模块本身。',
    '代码：',
    '```',
    code.text,
    '```',
  ].join('\n');

  let raw = '';
  try {
    const out = await request('plugin.call', {
      target: 'com.shixiansi.plugin-memcore',
      method: 'chat',
      payload: { roleId: `${REVIEW_ROLE}-tests`, userId: 'local', userName: '开发者', text: lines },
    });
    raw = String((out && out.text) || '');
  } catch (err) {
    reviewState.lastError = `记忆核心没有回答：${text(err && err.message, 120)}`;
    throw err;
  }

  const testCode = extractTestCode(raw);
  if (!testCode) {
    reviewState.lastError = '模型没有产出可识别的测试文件';
    throw new Error('模型没有产出可识别的测试文件（没有 ``` 代码块或 test/it 用例）');
  }

  const target = `${name}.test.js`;
  const result = { code: testCode, target, wrote: false, clipped: code.clipped };

  // 写入：先看配置开关，再看目标是否已存在（桥的 existedBefore 是第二道闸）。
  if (!flag('testsWriteEnabled', true)) return result;
  const dir = String(cfg.watchDir || '').trim();
  if (!dir) return result; // 没有目录可写：只返回文本
  const targetPath = dir.replace(/\/+$/, '') + '/' + target;
  const existing = await bridgeRead(targetPath);
  if (existing && existing.content.trim()) {
    result.existedBefore = true;
    reviewState.lastError = '';
    return result; // **绝不覆盖**
  }
  const write = await bridgeWrite(targetPath, testCode, true);
  result.wrote = write.ok;
  if (write.ok) {
    result.bytes = write.bytes;
    result.existedBefore = write.existedBefore;
  } else {
    result.error = write.error || '写入被拒绝';
  }
  reviewState.lastError = '';
  return result;
}

/** 从模型输出里取出测试代码块（最后一个 ``` 围栏优先）。 */
function extractTestCode(raw) {
  const body = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!body) return '';
  const fence = [...body.matchAll(/```(?:[a-z]*)\n([\s\S]*?)```/g)];
  const candidates = fence.length ? fence.map((m) => m[1]) : [body];
  // 从后往前找第一段"看起来像测试"的：含 test( 或 it(。
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const c = candidates[i].trim();
    if (/\b(test|it)\s*\(/.test(c)) return c;
  }
  return '';
}

/** 文件名清洗：去掉扩展名、只留安全字符，保底 default。目标是 <去扩展名>.test.js。 */
function sanitizeName(raw) {
  const cleaned = String(raw === undefined || raw === null ? '' : raw)
    .replace(/\.(m?js|cjs|jsx?|tsx?)$/i, '')
    .replace(/\.test\.(m?js|cjs|jsx?|tsx?)$/i, '')
    .replace(/[^\w-]+/g, '-')
    .replace(/^[-]+|[-]+$/g, '')
    .slice(0, 80);
  return cleaned || 'module-under-test';
}

/** 工坊页的"审查历史"一条。 */
function reviewSnapshot() {
  return {
    busy: reviewState.busy,
    last: reviewState.last,
    lastError: reviewState.lastError,
  };
}
