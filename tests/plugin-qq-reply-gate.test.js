// Unit tests for lib/reply_gate.js and lib/reply_splitter.js.
//
// 这两个文件是纯函数库（通宵任务 ~/chat-delta-lab/extracted/ 三个模块的 JS 直译，
// 权重与语义对应关系写在各自文件头），不需要宿主也不需要 jsdom —— 直接 new Function
// 载入文件内容，断言暴露出来的全局函数。
//
// 回归口径：
//   · reply_gate 的期望值大多来自 Python 侧 test_reply_gate.py 的同型用例；
//   · reply_splitter 的用例对应 test_reply_splitter.py。
// 两边语义若有分叉，先改实现，再同步两侧测试。
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-qq');

function loadLib(...files) {
  const source = files
    .map((file) => readFileSync(path.join(pluginDir, file), 'utf8'))
    .join('\n');
  // 源文件是 'use strict' 的经典 script，声明都在函数作用域里。给它包一层
  // function 体再在同一个作用域里追加一个 return，就能拿到需要的全局函数——
  // 等价于插件在浏览器里"这些声明进了共享作用域"。
  const expose = new Function(`${source}\n;return { estimateReplyProbability, gateThresholdFor, gateDecision, summarizePendingTexts, splitReplyForSend, calculateTypingDelay };`);
  return expose();
}

// 两个库都喂给两份常量：return 语句里的标识符在两个文件间共享（严格模式下引用
// 未定义的 shorthand 键会直接 ReferenceError），而且插件运行时它们本来就在同一个作用域。
const gate = loadLib('lib/reply_gate.js', 'lib/reply_splitter.js');
const splitter = loadLib('lib/reply_gate.js', 'lib/reply_splitter.js');

describe('reply_gate（权重与阈值来自 MaiBot 拟合结果）', () => {
  const calm = {
    mentionBot: false,
    atOther: false,
    hasQuestionMark: false,
    placeholderOnly: false,
    recentSelfRatio: 0.2,
    recentMessageCount: 6,
    secondsSinceBotMessage: 300,
    pendingCount: 1,
  };

  test('@ 提及 + 问号是最高分的组合', () => {
    const p = gate.estimateReplyProbability({ ...calm, mentionBot: true, hasQuestionMark: true });
    expect(p).toBeGreaterThan(0.8);
  });

  test('纯媒体占位拖低概率', () => {
    const plain = gate.estimateReplyProbability(calm);
    const media = gate.estimateReplyProbability({ ...calm, placeholderOnly: true });
    expect(media).toBeLessThan(plain);
  });

  test('冷场越久越值得开口（secondsSinceBotMessage 项）', () => {
    const fresh = gate.estimateReplyProbability({ ...calm, recentSelfRatio: 0.5, secondsSinceBotMessage: 10 });
    const stale = gate.estimateReplyProbability({ ...calm, recentSelfRatio: 0.5, secondsSinceBotMessage: 7200 });
    expect(stale).toBeGreaterThan(fresh);
  });

  test('刷屏抑制：60 条/分钟的热闹群单条闲聊分更低', () => {
    const busy = gate.estimateReplyProbability({ ...calm, recentMessageCount: 60 });
    const quiet = gate.estimateReplyProbability({ ...calm, recentMessageCount: 4 });
    expect(busy).toBeLessThan(quiet);
  });

  test('输出恒为概率', () => {
    for (const input of [
      calm,
      { ...calm, mentionBot: true, pendingCount: 20, recentSelfRatio: 1 },
      { ...calm, placeholderOnly: true, atOther: true, recentMessageCount: 100, secondsSinceBotMessage: 0 },
    ]) {
      const p = gate.estimateReplyProbability(input);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  test('summarizePendingTexts：@ 别人 / 问号 / 纯占位', () => {
    expect(gate.summarizePendingTexts(['@张三 你看这个？'], false)).toEqual({
      atOther: true, hasQuestionMark: true, placeholderOnly: false,
    });
    expect(gate.summarizePendingTexts(['[图片]', '[表情：笑]'], false)).toEqual({
      atOther: false, hasQuestionMark: false, placeholderOnly: true,
    });
    // 被 @ 时 summarize 不把 "@别人" 当冷落信号（强制触发路径）。
    expect(gate.summarizePendingTexts(['@bot @张三'], true).atOther).toBe(false);
  });

  test('forced 直接触发，不看分数', () => {
    const cold = { ...calm, placeholderOnly: true, atOther: true, recentMessageCount: 80 };
    expect(gate.gateDecision(cold, 0.9, true).decision).toBe('trigger');
  });

  test('阈值语义：wait / trigger 分界', () => {
    const decision = gate.gateDecision({ ...calm, placeholderOnly: true }, 0.9, false);
    expect(decision.decision).toBe('wait');
    expect(decision.probability).toBeLessThan(0.9);
  });

  test('gateThresholdFor：replyChance 两端不变，中段换档', () => {
    expect(gate.gateThresholdFor(0)).toBe(0.43); // <=0 在 shouldAnswer 里早已拦截，这里是兜底
    expect(gate.gateThresholdFor(10)).toBe(0.605); // 保留 10%：安静
    expect(gate.gateThresholdFor(30)).toBe(0.43); // 保留 30%：自然（MaiBot 离线表中段）
    expect(gate.gateThresholdFor(50)).toBe(0.336); // 保留 50%：活跃
    expect(gate.gateThresholdFor(100)).toBe(0.43); // >=100 早已拦截，兜底回落
    expect(gate.gateThresholdFor(' nonsense ')).toBe(0.43); // 未知值回落自然档
  });
});

describe('reply_splitter（MaiBot 后处理拆分的规则版）', () => {
  test('短回复原样一条（绝大多数回复零行为变化）', () => {
    expect(splitter.splitReplyForSend('好的', 300)).toEqual(['好的']);
  });

  test('长回复按标点拆条', () => {
    const parts = splitter.splitReplyForSend(
      '先别急，这个报错其实是版本问题，不是你的配置写错了。你先把依赖降到 2.3，再重新跑一遍试试，多半就好了。别慌，这个插件我昨天也遇到过，等它重连一次就好。',
      300,
    );
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.length).toBeLessThanOrEqual(3);
    expect(parts.join('，')).not.toContain('。。');
  });

  test('英文单词/URL 不被腰斩', () => {
    const parts = splitter.splitReplyForSend(
      '看这个地址 https://example.com/a, b 后面还有一段比较长的中文内容，用来把总长度撑到拆分阈值之上，这样切分逻辑才会真正参与进来，而不是直接原样返回。',
      300,
    );
    // URL 本体（含路径）不得被切开；"a," 与 " b" 之间的空格按分隔符语义可以切。
    expect(parts.join('，')).toContain('example.com/a');
  });

  test('引号内的标点不切', () => {
    const parts = splitter.splitReplyForSend(
      '他说「走吧，天要下雨了」，然后就走了，走得特别快，头也不回一下，留下我一个人站在原地。',
      300,
    );
    expect(parts.join('，')).toContain('「走吧，天要下雨了」');
  });

  test('段数上限：超了就合并回 3 条，不丢内容', () => {
    const text = Array.from({ length: 12 }, (_, i) => `第${i + 1}点要注意`).join('。');
    const parts = splitter.splitReplyForSend(`${text}。`, 300);
    expect(parts.length).toBeLessThanOrEqual(3);
    // 内容守恒：每个点都还在。
    for (let i = 1; i <= 12; i += 1) expect(parts.join('，')).toContain(`第${i}点`);
  });

  test('单条超过 maxChars 时放弃拆分回原文', () => {
    const long = '这是一条特别长的回复没有标点因此切不出来只能原样返回，'.repeat(8);
    expect(splitter.splitReplyForSend(long, 60)).toEqual([long]);
  });

  test('calculateTypingDelay：单汉字 ×3、emoji 固定 1s、延迟随长度单调', () => {
    expect(splitter.calculateTypingDelay('嗯')).toBeCloseTo(0.3 * 3 + 0.3);
    expect(splitter.calculateTypingDelay('😂')).toBe(1);
    expect(splitter.calculateTypingDelay('好')).toBeLessThan(
      splitter.calculateTypingDelay('这句话稍微长一点，有十几个汉字。'),
    );
    expect(splitter.calculateTypingDelay('')).toBe(0);
  });

  test('空输入与零宽字符', () => {
    expect(splitter.splitReplyForSend('   ', 300)).toEqual(['']);
    expect(splitter.splitReplyForSend('\u200b好的\u200b，这是一条足够长的回复，好让拆分逻辑参与进来。', 300)
      .join('，')).not.toContain('\u200b');
  });
});
