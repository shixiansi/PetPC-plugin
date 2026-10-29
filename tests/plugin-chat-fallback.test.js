import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 对话插件的兜底链：主模型 → 备用模型 → 借来的渠道 → 本地兜底。
//
// 这一组只测**决策**（链长什么样、错误算不算可重试），因为那是"用户看到一句人话还是一条
// 原始报错"的分界线。DOM 与流式接线由 plugin-check 与预览器覆盖——把它们塞进 jsdom 只会
// 测到一个不存在的浏览器。
//
// 两条不变量最值得钉住：
//   1. **主模型永远是第一级**，任何配置都不会把它挤掉；
//   2. **借来的渠道只在拿到 llm.borrow 且有就绪渠道时出现**——没授权却去点名别人的渠道，
//      宿主会拒绝，而"拒绝"在插件里表现为又一条失败。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-chat');
const script = readFileSync(path.join(pluginDir, 'app.js'), 'utf8');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

let api;

beforeEach(() => {
  document.body.innerHTML = new JSDOM(html).window.document.body.innerHTML;
  // 这个插件没有模块级 import/export，和它的其它测试一样用 Function 求值即可。
  // eslint-disable-next-line no-new-func
  new Function(script)();
  api = window.__chat;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the manifest', () => {
  test('declares what the fallback chain needs', () => {
    // 借渠道要有 llm.borrow；否则第四级只能跳到本地兜底。
    expect(manifest.permissions).toContain('llm.borrow');
    const keys = manifest.config.map((item) => item.key);
    expect(keys).toContain('llmFallbackModel');
    expect(keys).toContain('llmImageModel');
    // 图片域名白名单必须是 hostWhitelist 项，否则宿主会以"未声明的域名"拒绝图片。
    const imageHosts = manifest.config.find((item) => item.key === 'llmImageHosts');
    expect(imageHosts.hostWhitelist).toBe(true);
    // 配置项不能撞上宿主的 40 项上限。
    expect(manifest.config.length).toBeLessThanOrEqual(40);
  });
});

describe('buildAttemptChain', () => {
  const base = { text: '在吗', history: [{ role: 'user', text: '早' }], tools: ['pet_say'] };

  test('primary first, local last, and nothing in between when nothing is configured', () => {
    const chain = api.buildAttemptChain({ base });
    expect(chain.map((s) => s.tier)).toEqual(['primary', 'local']);
    expect(chain[0].payload).toEqual(base);
    expect(chain[0].payload).not.toBe(base); // 复制，不是同一个对象
    expect(chain[1].local).toBe(true);
  });

  test('adds the fallback model when it differs from the primary', () => {
    const chain = api.buildAttemptChain({ base, fallbackModel: 'gpt-4o-mini', primaryModel: 'gpt-4o' });
    expect(chain.map((s) => s.tier)).toEqual(['primary', 'fallback-model', 'local']);
    expect(chain[1].payload.model).toBe('gpt-4o-mini');
    // 其它字段原样带过去：换模型不该丢掉图片、工具或历史。
    expect(chain[1].payload.tools).toEqual(base.tools);
    expect(chain[1].payload.history).toEqual(base.history);
  });

  test('skips a fallback model that is the same as the primary', () => {
    const chain = api.buildAttemptChain({ base, fallbackModel: 'gpt-4o', primaryModel: 'gpt-4o' });
    expect(chain.map((s) => s.tier)).toEqual(['primary', 'local']);
  });

  test('adds the borrowed channel with its provider and channel id', () => {
    const chain = api.buildAttemptChain({ base, borrowed: { id: 'com.example.channels', channel: 'openai' } });
    expect(chain.map((s) => s.tier)).toEqual(['primary', 'borrowed', 'local']);
    expect(chain[1].payload.provider).toBe('com.example.channels');
    expect(chain[1].payload.channel).toBe('openai');
  });

  test('full chain in the documented order', () => {
    const chain = api.buildAttemptChain({
      base,
      fallbackModel: 'cheap',
      primaryModel: 'expensive',
      borrowed: { id: 'com.example.channels' },
    });
    expect(chain.map((s) => s.tier)).toEqual(['primary', 'fallback-model', 'borrowed', 'local']);
    // 没有 channel 时不写这个字段（宿主按"用它的默认渠道"处理）。
    expect(chain[2].payload.channel).toBeUndefined();
  });

  test('says why the local fallback was needed when images had no vision model', () => {
    const chain = api.buildAttemptChain({ base: { ...base, images: ['https://x/y.png'] }, imageModel: '' });
    const local = chain[chain.length - 1];
    expect(local.tier).toBe('local');
    expect(local.why).toContain('图片模型');
  });
});

describe('classifyFailure', () => {
  const cases = [
    ['401 unauthorized', 'auth'],
    ['invalid api key', 'auth'],
    ['429 Too Many Requests', 'quota'],
    ['余额不足', 'quota'],
    ['请求超时', 'network'],
    ['fetch failed: ECONNRESET', 'network'],
    ['context length exceeded', 'context'],
    ['maximum token limit', 'context'],
    ['502 bad gateway', 'server'],
    ['model not found', 'model'],
    ['说不清的问题', 'unknown'],
  ];

  for (const [message, want] of cases) {
    test(`${message} → ${want}`, () => {
      expect(api.classifyFailure({ message })).toBe(want);
    });
  }

  test('reads the code field too, not just message', () => {
    expect(api.classifyFailure({ code: '429' })).toBe('quota');
  });

  test('an empty failure is unknown rather than a crash', () => {
    expect(api.classifyFailure(null)).toBe('unknown');
    expect(api.classifyFailure({})).toBe('unknown');
  });
});

describe('the tier labels', () => {
  test('every tier the chain can produce has a human label', () => {
    const chain = api.buildAttemptChain({
      base: { text: 'x' },
      fallbackModel: 'b',
      primaryModel: 'a',
      borrowed: { id: 'p' },
    });
    for (const step of chain) {
      expect(api.TIER_LABEL[step.tier], `缺少 ${step.tier} 的文案`).toBeTruthy();
    }
  });
});
