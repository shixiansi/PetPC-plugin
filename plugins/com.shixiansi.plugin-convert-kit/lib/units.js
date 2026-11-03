// lib/units.js —— 换算表（**只有数据，没有逻辑**）。
//
// 这张表是这个插件唯一"可以被质疑"的地方，所以每一条都说清它是怎么来的：
//
//   · 公制与英制之间只用**精确定义**（1959 年国际码/磅协定之后 1 in = 25.4 mm 是精确值，
//     所以 ft / yd / mi / lb / oz 都是精确值，不是近似）。
//   · 体积里的"茶匙 / 汤匙 / 杯 / 液体盎司 / 加仑"一律按**美制**：中文用户看到的"杯"绝大多数
//     来自美制食谱。英制加仑是另一个数（4.54609 L），这里不提供——混在一张表里而没有后缀，
//     就是让人拿错单位。
//   · 温度不用系数，用"先换成摄氏度、再换出去"两个函数：没有线性系数能同时表达 °F 的偏移。
//   · 时区是**固定偏移**，不是 IANA 时区库：真正的 Asia/Shanghai 含历史与夏令时数据，那需要
//     一整套 tzdata。所以这里只有 UTC±H[:MM]，界面上写清"不含夏令时"。
//   · 汇率是一份**静态快照**（RATES_AS_OF），它的意义是"这个数大概是多少"，不是报价；插件零
//     网络，快照不会自己变新，所以界面与返回值都把日期说出口。
//
// 每个单位四个字段：id（from/to 要写的，key 或 symbol 也认）、symbol（显示）、name（中文名，
// convert 也认）、外加 scalar 的 k（相对基准单位的系数）/ temperature 的两个函数 / timezone 的
// offset（分钟）/ number-base 的 id 就是基数 / currency 的 perUsd（1 美元等于多少该币种）。

'use strict';

const CATEGORY_LIST = [
  { id: 'length', kind: 'scalar', label: '长度', unitWord: '单位', units: [
    { id: 'mm', symbol: 'mm', name: '毫米', k: 0.001 },
    { id: 'cm', symbol: 'cm', name: '厘米', k: 0.01 },
    { id: 'm', symbol: 'm', name: '米', k: 1 },
    { id: 'km', symbol: 'km', name: '千米', k: 1000 },
    { id: 'in', symbol: 'in', name: '英寸', k: 0.0254 },
    { id: 'ft', symbol: 'ft', name: '英尺', k: 0.3048 },
    { id: 'yd', symbol: 'yd', name: '码', k: 0.9144 },
    { id: 'mi', symbol: 'mi', name: '英里', k: 1609.344 },
    { id: 'nmi', symbol: 'nmi', name: '海里', k: 1852 },
  ] },

  { id: 'weight', kind: 'scalar', label: '重量', unitWord: '单位', units: [
    { id: 'mg', symbol: 'mg', name: '毫克', k: 0.000001 },
    { id: 'g', symbol: 'g', name: '克', k: 0.001 },
    { id: 'kg', symbol: 'kg', name: '千克', k: 1 },
    { id: 't', symbol: 't', name: '吨', k: 1000 },
    { id: 'lb', symbol: 'lb', name: '磅', k: 0.45359237 },
    { id: 'oz', symbol: 'oz', name: '盎司', k: 0.028349523125 },
  ] },

  { id: 'volume', kind: 'scalar', label: '体积', unitWord: '单位', units: [
    { id: 'ml', symbol: 'ml', name: '毫升', k: 0.001 },
    { id: 'l', symbol: 'l', name: '升', k: 1 },
    { id: 'm3', symbol: 'm³', name: '立方米', k: 1000 },
    { id: 'tsp', symbol: 'tsp', name: '茶匙（美制）', k: 0.00492892159375 },
    { id: 'tbsp', symbol: 'tbsp', name: '汤匙（美制）', k: 0.01478676478125 },
    { id: 'floz', symbol: 'fl oz', name: '液体盎司（美制）', k: 0.0295735295625 },
    { id: 'cup', symbol: 'cup', name: '杯（美制）', k: 0.2365882365 },
    { id: 'gal', symbol: 'gal', name: '加仑（美制）', k: 3.785411784 },
  ] },

  { id: 'temperature', kind: 'temperature', label: '温度', unitWord: '单位', units: [
    // min 是"该单位下的绝对零度"：低于它不是换算问题，是物理上不存在。
    { id: 'c', symbol: '°C', name: '摄氏度', min: -273.15,
      toBase: (v) => v, fromBase: (v) => v },
    { id: 'f', symbol: '°F', name: '华氏度', min: -459.67,
      toBase: (v) => (v - 32) * 5 / 9, fromBase: (v) => v * 9 / 5 + 32 },
    { id: 'k', symbol: 'K', name: '开尔文', min: 0,
      toBase: (v) => v - 273.15, fromBase: (v) => v + 273.15 },
  ] },

  { id: 'speed', kind: 'scalar', label: '速度', unitWord: '单位', units: [
    { id: 'mps', symbol: 'm/s', name: '米/秒', k: 1 },
    { id: 'kmh', symbol: 'km/h', name: '千米/时', k: 1 / 3.6 },
    { id: 'mph', symbol: 'mph', name: '英里/时', k: 0.44704 },
    { id: 'kn', symbol: 'kn', name: '节', k: 1852 / 3600 },
    { id: 'fps', symbol: 'ft/s', name: '英尺/秒', k: 0.3048 },
  ] },

  { id: 'timezone', kind: 'timezone', label: '时区', unitWord: '时区', units: [
    { id: 'UTC-8', symbol: 'UTC-8', name: '太平洋时间（冬令）', offset: -480 },
    { id: 'UTC-5', symbol: 'UTC-5', name: '美东时间（冬令）', offset: -300 },
    { id: 'UTC-3', symbol: 'UTC-3', name: '巴西时间', offset: -180 },
    { id: 'UTC', symbol: 'UTC', name: '协调世界时', offset: 0 },
    { id: 'UTC+1', symbol: 'UTC+1', name: '中欧时间（冬令）', offset: 60 },
    { id: 'UTC+3', symbol: 'UTC+3', name: '莫斯科时间', offset: 180 },
    { id: 'UTC+5:30', symbol: 'UTC+5:30', name: '印度时间', offset: 330 },
    { id: 'UTC+8', symbol: 'UTC+8', name: '北京时间', offset: 480 },
    { id: 'UTC+9', symbol: 'UTC+9', name: '东京时间', offset: 540 },
  ] },

  { id: 'base', kind: 'number-base', label: '进制', unitWord: '进制', units: [
    // id 就是基数本身：它同时是 from/to 要写的值，也是 parseInt 的第二个参数。
    { id: '2', symbol: '2', name: '二进制' },
    { id: '8', symbol: '8', name: '八进制' },
    { id: '10', symbol: '10', name: '十进制' },
    { id: '16', symbol: '16', name: '十六进制' },
  ] },

  { id: 'currency', kind: 'currency', label: '汇率', unitWord: '币种', units: [
    { id: 'USD', symbol: 'USD', name: '美元', perUsd: 1 },
    { id: 'CNY', symbol: 'CNY', name: '人民币', perUsd: 7.24 },
    { id: 'EUR', symbol: 'EUR', name: '欧元', perUsd: 0.92 },
    { id: 'GBP', symbol: 'GBP', name: '英镑', perUsd: 0.79 },
    { id: 'JPY', symbol: 'JPY', name: '日元', perUsd: 151.3 },
    { id: 'HKD', symbol: 'HKD', name: '港币', perUsd: 7.81 },
  ] },
];

/** 汇率快照的日期。它会出现在界面上和返回值里——一份自己不会变新的数据必须说清哪天的。 */
const RATES_AS_OF = '2026-11-01';

/** 页面上的示例数值：一打开就能按一下看到结果，而不是先对着空框发呆。 */
const SAMPLE_VALUES = {
  length: '12.5', weight: '1', volume: '1', temperature: '100',
  speed: '36', timezone: '23:30', base: '255', currency: '100',
};

const PLACEHOLDERS = {
  length: '12.5', weight: '1', volume: '1', temperature: '100', speed: '36',
  timezone: '23:30（HH:MM）', base: 'ff 或 -1011（不带 0x 前缀）', currency: '100',
};
