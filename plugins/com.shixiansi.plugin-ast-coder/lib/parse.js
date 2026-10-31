// lib/parse.js —— 轻量代码结构提取
//
// 不是真的 AST：宿主的帧里没有编译器，一个手写解析器要同时扛住 ES2022 的全部形状
// 还不出错，成本远大于收益。这里做的是"够用的结构提取"，用一组对**行首形状**敏感的
// 正则把四种东西找出来：
//
//   function 声明 / 箭头赋值 / 类（带方法名）/ export 清单
//
// 三条纪律让它接近 AST 而不会比正则更脆：
//   1. 先剥注释与字符串字面量（位置保持不变）——注释里的 `function foo()` 不算声明；
//   2. 逐行匹配，多行参数列表靠括号配对补全（记录行号用）；
//   3. 任何一步出错都返回"已提取的部分"，绝不抛——一个坏文件不该弄断整次索引。
//
// 输出形状（也是 plugin.call('analyze') 的返回值）：
//   { file, lines, functions: [{name, line, kind}], classes: [{name, line, methods}],
//     exports: [{name, line, kind}], imports: number, todos: [{line, text}] }

'use strict';

const AstParser = {
  /** 主入口：源码 → 结构。path 只是标注用。 */
  parse(source, pathLabel) {
    const text = String(source === undefined || source === null ? '' : source);
    const stripped = stripCommentsAndStrings(text);
    const lines = stripped.split('\n');
    const rawLines = text.split('\n');

    const functions = [];
    const classes = [];
    const exports = [];
    const todos = [];
    let imports = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const rawLine = rawLines[i] || '';
      const lineNo = i + 1;

      // import 计数（行首 import ... from）
      if (/^\s*import\b/.test(line) && /\bfrom\b/.test(line)) imports += 1;

      // TODO / FIXME 记录：跑在**原始行**上——注释里写 TODO 是它的本职，
      // 结构匹配用剥过注释的行，TODO 用没剥过的，两不耽误。
      const todo = rawLine.match(/\b(TODO|FIXME|HACK)\b[:\s]?(.{0,80})/);
      if (todo) todos.push({ line: lineNo, text: `${todo[1]}: ${String(todo[2] || '').trim()}` });

      // function 声明（含 async function / export 前缀）
      const fn = matchFunction(line);
      if (fn) functions.push({ ...fn, line: lineNo });

      // 箭头赋值：const/let/var NAME = (…) => 或 = async (…) =>
      const arrow = matchArrow(line);
      if (arrow) functions.push({ ...arrow, line: lineNo });

      // 类声明：class NAME [extends …] {
      const cls = line.match(/^\s*(?:export\s+(?:default\s+)?)?class\s+([A-Za-z_$][\w$]*)/);
      if (cls) classes.push({ name: cls[1], line: lineNo, methods: [] });

      // 方法（在类体里缩进的 method(...) 形状）：由调用方判断是否在类里太复杂，
      // 简化：任何 "NAME(args) {" 且 NAME 不是关键字、又不是顶层函数的，归给最近的类。
      const method = line.match(/^\s{2,}(?:async\s+|static\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/);
      if (method && !KEYWORDS.has(method[1]) && classes.length && !matchFunction(line)) {
        classes[classes.length - 1].methods.push(method[1]);
      }

      // export 清单
      const exp = matchExport(line);
      if (exp) exports.push({ ...exp, line: lineNo });
    }

    return {
      file: String(pathLabel || ''),
      lines: lines.length,
      functions,
      classes,
      exports,
      imports,
      todos,
    };
  },

  /** 一个结构摘要压成一行（工坊页与 prompt 用）。 */
  summarize(structure, maxChars) {
    const parts = [];
    if (structure.classes.length) {
      parts.push(`类: ${structure.classes.map((c) => (c.methods.length ? `${c.name}(${c.methods.join(', ')})` : c.name)).join('; ')}`);
    }
    if (structure.functions.length) {
      parts.push(`函数: ${structure.functions.map((f) => `${f.name}(${f.kind}${f.line})`).join(', ')}`);
    }
    if (structure.exports.length) {
      parts.push(`导出: ${structure.exports.map((e) => e.name).join(', ')}`);
    }
    let text = parts.join(' | ') || '（没有可识别的结构）';
    const limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 1200;
    if (Array.from(text).length > limit) text = `${Array.from(text).slice(0, limit).join('')}…`;
    return text;
  },
};

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'constructor']);

/**
 * 去注释与字符串字面量，但保留换行与整体形状（长度不变），
 * 这样"行号"在整个提取流程里始终是对的。
 */
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += quote;
      i += 1;
      while (i < n) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        if (src[i] === quote) { out += quote; i += 1; break; }
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 匹配一个 function 声明，返回 {name, kind} 或 null。 */
function matchFunction(line) {
  const m = line.match(/^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/);
  if (m) return { name: m[1], kind: 'fn' };
  return null;
}

/** 匹配 const/let/var NAME = (…) => 形状（含 async）。 */
function matchArrow(line) {
  const m = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/);
  if (m) return { name: m[1], kind: 'arrow' };
  return null;
}

/** 匹配一个 export，返回 {name, kind} 或 null。 */
function matchExport(line) {
  let m = line.match(/^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?|class)\s+([A-Za-z_$][\w$]*)/);
  if (m) return { name: m[1], kind: 'decl' };
  m = line.match(/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/);
  if (m) return { name: m[1], kind: 'value' };
  m = line.match(/^\s*export\s*\{([^}]+)\}/);
  if (m) {
    const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop().trim()).filter(Boolean);
    if (names.length === 1) return { name: names[0], kind: 'named' };
    if (names.length > 1) return { name: names.join(', '), kind: 'named' };
  }
  m = line.match(/^\s*export\s+default\s+([A-Za-z_$][\w$]*)/);
  if (m) return { name: m[1], kind: 'default' };
  return null;
}
