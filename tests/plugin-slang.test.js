import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// 网络词词典的**纯函数**：解析（对外来格式）、建索引、查词排序、给模型的文本。
//
// 为什么用 vm 而不是 jsdom：这三个文件不碰 DOM，也不发请求——它们只有字符串和 Map。把它们放进
// 一个干净的沙箱跑，测试就只依赖"输入 → 输出"，不受宿主消息泵与样式的干扰。行为那半边
// （plugin.call 应答、导入落盘）由 plugin-check 与预览器覆盖。
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-slang');

const sandbox = { console };
vm.createContext(sandbox);
for (const file of ['lib/seed.js', 'lib/lexicon.js']) {
  vm.runInContext(readFileSync(path.join(dir, file), 'utf8'), sandbox, { filename: file });
}

const P = vm.runInContext('SLANG_PURE', sandbox);
const SEED = vm.runInContext('SEED_ENTRIES', sandbox);
const builtin = () => P.buildIndex([SEED]);

describe('查词：整句、句子里、长词优先', () => {
  test('整句就是词条', () => {
    const result = P.lookup(builtin(), '破防');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].term).toBe('破防');
  });

  test('句子里含词条也算（「今天好破防啊」）', () => {
    const result = P.lookup(builtin(), '今天好破防啊，真的');
    expect(result.matched).toBe('破防');
    expect(result.entries[0].meaning).toContain('心理防线');
  });

  test('同样命中时，长词优先（「电子榨菜」压过「榨菜」）', () => {
    const index = P.buildIndex([[
      { term: '榨菜', meaning: '一种腌菜' },
      { term: '电子榨菜', meaning: '下饭的视频' },
    ]]);
    const result = P.lookup(index, '今天拿电子榨菜下饭');
    expect(result.entries[0].term).toBe('电子榨菜');
  });

  test('关掉模糊命中后，整句查不到就是查不到', () => {
    const result = P.lookup(builtin(), '今天好破防啊', { allowPartial: false });
    expect(result.entries).toHaveLength(0);
  });

  test('max 限制条数（一句话里好几个梗时不撑爆 prompt）', () => {
    const index = P.buildIndex([[
      { term: '破防', meaning: 'a' },
      { term: '麻了', meaning: 'b' },
      { term: '离谱', meaning: 'c' },
    ]]);
    const result = P.lookup(index, '破防了麻了太离谱', { max: 2 });
    expect(result.entries.length).toBeLessThanOrEqual(2);
  });

  test('空查询与空索引都不炸', () => {
    expect(P.lookup(builtin(), '').entries).toHaveLength(0);
    expect(P.lookup(P.buildIndex([]), '破防').entries).toHaveLength(0);
  });
});

describe('导入：吃 astrbot-rag-kb / Buzzword 的 chunks.jsonl', () => {
  const line = JSON.stringify({
    id: 1,
    text: '【词条】白人饭\n【释义】指一种以生冷食材为主、无需过多加工的简餐。\n【详解】源自欧美网友分享的午餐。',
  });

  test('按【词条】【释义】【详解】切开，坏行只跳过不中断', () => {
    const { entries, skipped } = P.parseChunksJSONL([line, 'not json', '', JSON.stringify({ id: 2, text: '没有标记' })].join('\n'));
    expect(entries).toHaveLength(1);
    expect(entries[0].term).toBe('白人饭');
    expect(entries[0].meaning).toContain('生冷食材');
    expect(entries[0].detail).toContain('欧美');
    expect(skipped).toBe(2);
  });

  test('【例句】是可选的，有就带上', () => {
    const withExample = JSON.stringify({
      id: 3,
      text: '【词条】破防\n【释义】心理防线被击穿。\n【例句】看到这条我人破防了。\n【详解】…',
    });
    const { entries } = P.parseChunksJSONL(withExample);
    expect(entries[0].example).toContain('破防了');
  });

  test('缺【释义】或空词的条目不算词条（宁可跳过，也不要一条半成品）', () => {
    expect(P.parseChunkText('【词条】只有词条')).toBeNull();
    expect(P.parseChunkText('【释义】只有释义')).toBeNull();
    expect(P.parseChunkText('')).toBeNull();
  });

  test('导入的覆盖同名的自带条目（用户的数据更新）', () => {
    const index = P.buildIndex([SEED, [{ term: '破防', meaning: '（导入的释义）' }]]);
    expect(index.byTerm.get(P.normalizeTerm('破防')).meaning).toBe('（导入的释义）');
  });
});

describe('给模型读的那段话', () => {
  test('查到就是一段可直接拼进 prompt 的文本', () => {
    const text = P.renderHits(P.lookup(builtin(), '尊嘟假嘟'));
    expect(text).toContain('【资料】');
    expect(text).toContain('尊嘟假嘟');
  });

  test('查不到返回空串——调用方据此"什么都不加"，不要往 prompt 里塞废话', () => {
    expect(P.renderHits({ entries: [] })).toBe('');
  });
});

// 导入失败的**诊断**：用户最容易踩的不是"数据坏了"，而是**选错了文件**。
//
// 真机（2026-10-30）：目录里每个子文件夹都有 manifest.json（元数据）和 chunks.jsonl（词条），而
// `.jsonl` 没有注册 MIME，文件选择框默认只显示 .json —— 用户选到 manifest，收到一句"认不出词条"，
// 完全不知道该换哪个文件。所以解析器现在会**说出这是什么文件**。
describe('导入诊断与整份 JSON', () => {
  test('选到 manifest.json：明确告诉用户去选 chunks.jsonl', () => {
    const manifest = JSON.stringify({ kb_name: '网络流行语释义库', num_chunks: 1219, source_url: '…' });
    expect(P.importReason(manifest)).toBe('manifest');
    expect(P.parseChunksJSONL(manifest).entries).toHaveLength(0);
  });

  test('选了对话/笑话语料（没有词条结构）：说清"这份不是词条"', () => {
    const meme = [
      JSON.stringify({ id: 1, text: '用户：这也太离谱了\n回复：习惯了' }),
      JSON.stringify({ id: 2, text: '用户：笑死\n回复：+1' }),
    ].join('\n');
    expect(P.importReason(meme)).toBe('noMarkers');
  });

  test('既不是 JSONL 也不是 JSON：说清格式要求', () => {
    expect(P.importReason('普通文本，一行一个词')).toBe('notJSONL');
    expect(P.importReason('')).toBe('empty');
  });

  test('整份 JSON 数组 / {chunks:[…]} 也吃得下（有的导出工具不写 jsonl）', () => {
    const asArray = JSON.stringify([{ id: 1, text: '【词条】甲\n【释义】A' }, { id: 2, text: '【词条】乙\n【释义】B' }]);
    expect(P.parseChunksJSONL(asArray).entries).toHaveLength(2);
    const asObject = JSON.stringify({ chunks: [{ id: 1, text: '【词条】丙\n【释义】C' }] });
    expect(P.parseChunksJSONL(asObject).entries).toHaveLength(1);
  });
});
