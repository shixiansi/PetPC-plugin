import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// 萌娘百科插件里"能不能读懂一个条目页"的那几个纯函数。
//
// 真实素材（2026-10-30 抓的原文）：
//   「区」   → "区可以指：…区(月亮计划)————游戏《脑叶公司》…、区(网络用语)————一种网络用语。"
//             这是一张**消歧义页**，照原样交给模型等于什么都没说；
//             子条目「区(网络用语)」的正文才是答案："区，本字为蛆，是ACG亚文化中的一种称谓，呈贬义。"
//   「破防」 → 普通条目，直接可用。
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-moegirl');

const sandbox = { console, JSON, Date, Math, String, encodeURIComponent };
vm.createContext(sandbox);
vm.runInContext(readFileSync(path.join(dir, 'lib', 'api.js'), 'utf8'), sandbox, { filename: 'lib/api.js' });
const A = vm.runInContext('MOEGIRL_PURE', sandbox);

const DISAMBIGUATION = [
  '区可以指：',
  '',
  '区(月亮计划)————游戏《脑叶公司》《废墟图书馆》《边狱公司》中的概念。',
  '区(网络用语)————一种网络用语。',
].join('\n');

const PLAIN = '破防是个游戏术语，也是网络用语。凭借其在各领域的广泛使用，破防了成为B站2021年年度弹幕之一。';

describe('消歧义页：认得出、挑得准', () => {
  test('「区」这种页面认得出，普通条目不会误判', () => {
    expect(A.isDisambiguation(DISAMBIGUATION)).toBe(true);
    expect(A.isDisambiguation(PLAIN), '普通条目被误判成消歧义页，会把好内容换成子条目').toBe(false);
    expect(A.isDisambiguation('')).toBe(false);
  });

  test('候选子条目按「名字 + 破折号后的说明」切出来', () => {
    const rows = A.parseDisambiguationTitles(DISAMBIGUATION);
    expect(rows.map((r) => r.title)).toEqual(['区(月亮计划)', '区(网络用语)']);
    expect(rows[1].note).toContain('网络用语');
  });

  test('挑「网络用语」那一支，而不是第一个', () => {
    const picked = A.pickSubEntry('区', A.parseDisambiguationTitles(DISAMBIGUATION));
    expect(picked.title).toBe('区(网络用语)');
  });

  test('偏好是明写的：带括弧的、带"网络/用语/梗"的优先，其余按页序', () => {
    const rows = A.parseDisambiguationTitles([
      '甲(游戏)————某游戏角色。',
      '甲————一个姓。',
      '甲(网络用语)————一个梗。',
    ].join('\n'));
    expect(A.pickSubEntry('甲', rows).title).toBe('甲(网络用语)');
  });

  test('没有候选就返回 null（别把消歧义页当成答案死循环）', () => {
    expect(A.pickSubEntry('区', [])).toBeNull();
    expect(A.pickSubEntry('区', null)).toBeNull();
  });
});

describe('给模型读的那段话', () => {
  test('自报身份：说清是"查到的资料"、直接用它回答', () => {
    const text = A.renderEntry({ title: '破防', extract: PLAIN, url: 'https://zh.moegirl.org.cn/破防' }, 300);
    expect(text).toContain('【资料】');
    expect(text, '要说明这段不是发给用户的话').toContain('不是要发给用户的话');
    expect(text, '要要求用自己的人设重说').toContain('用你自己的话');
    expect(text).toContain('破防是个游戏术语');
    expect(text, '不许把出处贴给用户').not.toContain('CC BY-NC-SA');
  });

  test('从消歧义页降级下来的，要交代取自哪个分条', () => {
    const text = A.renderEntry({
      title: '区(网络用语)',
      extract: '区，本字为蛆（英语：maggot），是ACG亚文化中的一种称谓，呈贬义。',
      url: 'https://zh.moegirl.org.cn/区',
      from: '区',
      alsoTitles: ['区(月亮计划)'],
    }, 300);
    expect(text).toContain('取自「区」的分条');
    // 不列同名分条：列了模型就会复述「脑叶公司…你说哪个？」（真机 2026-10-30）
    expect(text).not.toContain('月亮计划');
  });

  test('空摘要返回空串：调用方据此判断"什么也没查到"', () => {
    expect(A.renderEntry({ title: 'x', extract: '   ' }, 300)).toBe('');
    expect(A.renderEntry(null, 300)).toBe('');
  });
});

describe('存储键', () => {
  test('缓存键只有字母数字（`%` 会让整次 storage.get 不执行）', () => {
    for (const q of ['区', '时先思：区', 'a b/c?d=e', '原神']) {
      expect(A.cacheKeyOf(q)).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    }
    expect(A.cacheKeyOf('区')).toBe(A.cacheKeyOf('区'));
    expect(A.cacheKeyOf('区')).not.toBe(A.cacheKeyOf('蛆'));
  });
});
