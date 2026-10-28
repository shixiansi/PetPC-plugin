// lib/protocol.js —— 尾部 JSON 围栏协议
//
// splitDirectives / parseReply / 字段白名单：模型一次回答里做完正文+指令。
//
// 从原来的 app.js 按节**原样搬出来**（1.12 的重构）：内容逐字未改，只是换了个文件。
// 经典 script 共享同一个全局作用域，所以这里不用 import/export；
// 加载顺序写在 panel.html 里（顺序 = 原来的文件顺序，所以原有的依赖关系不变）。
'use strict';

// --- 尾部指令块：模型一次回答里顺手做完记忆/表情/能量 ------------------------
//
// 平台**没有** response_format（见 openspec/changes/qq-plugin-aigf-inspired），所以"一次
// 调用干完回复+记忆+表情"只能靠约定。约定成这样：
//
//   正文（会被原样发到群里）
//   ```json
//   {"meme":"694ee580","remember":["张三在准备考研"],"energy":-0.05}
//   ```
//
// 三条规则让它在没有强制 JSON 的情况下也稳：
//   1. 只认**最后一个**围栏 —— 模型偶尔会在正文里写代码块，前面那些不能算；
//   2. 围栏里解析不出来就当没有 —— 群里只会看到正文，不会漏出花括号；
//   3. 老标记 `〔表情:分类〕` 仍然认 —— 不写围栏的模型照旧能配表情。

/** 从回复里剥离尾部指令块，返回 {body, data}。 */
function splitDirectives(raw) {
  const text = String(raw || '').trim();
  const end = text.lastIndexOf('```');
  if (end < 0) return { body: text, data: null, ...trailingDirectives(text) };
  const start = text.lastIndexOf('```', end - 1);
  if (start < 0) return { body: text, data: null, ...trailingDirectives(text) };
  const inner = text.slice(start + 3, end).replace(/^\s*json\s*/i, '').trim();
  let data = null;
  try {
    const parsed = JSON.parse(inner);
    // A bare array or a number is not an instruction block; treating it as one would
    // strip a legitimate code block out of a reply that was only ever text.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
  } catch {
    data = null;
  }
  if (!data) return { body: text, data: null, ...trailingDirectives(text) };
  return { body: text.slice(0, start).trim(), data };
}

/**
 * 整条回复就是一个 JSON 对象（没有围栏）时，也当成指令块。
 *
 * 这是 1.12 第一批真机事故：群里出现了
 * 「行啊，每天5点戳你。{"remember":["时先思让我每天晚上5点at他"],"friend":{…}}」
 * ——模型没裹围栏，把 JSON 直接追在句子后面，于是那句花括号原样发进了群。
 *
 * 做法：从最后一个 `{` 往前找，谁能让"它到结尾"整段解析成对象、且键都是我们认识的字段，
 * 就把它当围栏用、前半段当正文。键名校验很关键：没有它，一句"这个 { } 符号叫什么"会被
 * 误当成指令吞掉。
 */
const DIRECTIVE_KEYS = new Set([
  'meme', 'sticker', 'tag', 'save_meme', 'remember', 'forget', 'friend', 'energy', 'silent',
  'at', 'remind', 'reminder',
]);

/**
 * "字段名 + 冒号"的整体匹配，用来在无围栏分支里切掉坏掉的那半截 JSON。
 *
 * 由 `DIRECTIVE_KEYS` **生成**而不是手写：1.12 里就吃过一次亏——新加了 `remind` 字段，忘了
 * 同步这个正则，于是「记了，我补上，别嫌。{"remind":[…]}}」整段发进了群。一个清单一个来源。
 */
const DIRECTIVE_TAIL_PATTERN = new RegExp(
  `\\{\\s*"(?:${[...DIRECTIVE_KEYS].join('|')})"\\s*:`,
);

function trailingDirectives(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.endsWith('}')) return null;
  for (let i = trimmed.lastIndexOf('{'); i >= 0; i = trimmed.lastIndexOf('{', i - 1)) {
    let parsed = null;
    try {
      parsed = JSON.parse(trimmed.slice(i));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const keys = Object.keys(parsed);
    if (!keys.length || !keys.every((key) => DIRECTIVE_KEYS.has(key))) continue;
    return { body: trimmed.slice(0, i).trim(), data: parsed };
  }
  return null;
}

/** 一条指令文本的上限：记忆条目不该长到能挤掉 prompt 里的其它东西。 */
const DIRECTIVE_TEXT_MAX = 60;

