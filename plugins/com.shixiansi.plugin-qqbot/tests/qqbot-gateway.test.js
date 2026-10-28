// tests/qqbot-gateway.test.js —— 网关协议逻辑的单元测试（不跑 jsdom，直接驱动纯函数）
//
// 跑法：node tests/qqbot-gateway.test.js
// 这些测试只覆盖纯逻辑（intents、事件归一化、去重、白名单、seq 预算）——
// 完整的"文档真的跑起来"检查在 docs/plugin-testkit/plugin-check.mjs 的 protocol 组里。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ---- 装载被测代码：把 lib/*.js 依序 eval 进一个共享沙箱（和 panel.html 的顺序一致）

const LIB = path.join(__dirname, '..', 'lib');
const sandbox = {
  window: { parent: null, addEventListener() {} },
  document: {
    documentElement: { dataset: {} },
    getElementById: () => null,
    createElement: () => ({ style: {}, append() {}, addEventListener() {} }),
  },
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  location: { search: '' },
  URLSearchParams: class { constructor() {} get() { return null; } },
  Date, Math, JSON, Number, String, Object, Array, Set, Map, Promise, Error, Boolean,
};
sandbox.window.parent = sandbox.window;
vm.createContext(sandbox);
for (const name of ['core.js', 'gateway.js', 'inbound.js', 'llm.js', 'sender.js', 'workshop.js']) {
  vm.runInContext(fs.readFileSync(path.join(LIB, name), 'utf8'), sandbox, { filename: name });
}

// `const cfg` / `const gw` 是全局**词法**声明，不挂在 sandbox 对象上；但同一 context 里
// 后续脚本能看见它们，所以用一句脚本把它们抄到可读的属性上（测试接缝）。
vm.runInContext('globalThis.__cfg = cfg; globalThis.__gw = gw; globalThis.__token = token;', sandbox);

const g = sandbox;

// ---- 断言小工具

let passed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { passed += 1; return; }
  failures.push(label);
  console.error(`  FAIL ${label}`);
}

// ---- intents 预设

ok(g.intentsFor('group') === (1 << 25), 'intents group = 1<<25');
ok(g.intentsFor('c2c') === (1 << 25), 'intents c2c = 1<<25');
ok(g.intentsFor('guild') === (1 << 30), 'intents guild = 1<<30');
ok(g.intentsFor('group+c2c') === ((1 << 25) | (1 << 30)), 'intents group+c2c = 位或');
ok(g.intentsFor(undefined) === ((1 << 25) | (1 << 30)), 'intents 缺省 = group+c2c');

// ---- 事件归一化与去重

const groupFrame = {
  id: 'evt-1',
  t: 'GROUP_AT_MESSAGE_CREATE',
  s: 42,
  d: {
    id: 'msg-abc',
    content: ' 你好，机器人 ',
    group_openid: 'G1',
    author: { id: 'U1', member_openid: 'U1', username: '张三' },
    timestamp: '2026-10-28T15:04:05+08:00',
  },
};
const msg1 = g.normalizeEvent('GROUP_AT_MESSAGE_CREATE', groupFrame.d, groupFrame);
ok(msg1 && msg1.kind === 'group', '群事件归一化 kind');
ok(msg1.openid === 'G1' && msg1.msgId === 'msg-abc', '群事件 openid/msgId');
ok(msg1.text === '你好，机器人', '群事件 content 去空白（官方已去 @ 前缀）');
ok(msg1.senderId === 'U1', '群事件 sender');

// 相同事件再来一次：必须被去重
const dup = g.normalizeEvent('GROUP_AT_MESSAGE_CREATE', groupFrame.d, groupFrame);
ok(dup === null, '重复事件 id 被去重');

// 单聊事件
const c2cFrame = {
  id: 'evt-2',
  t: 'C2C_MESSAGE_CREATE',
  d: {
    id: 'msg-c2c-1',
    content: '在吗',
    author: { id: 'V1', user_openid: 'V1', username: '李四' },
    timestamp: '2026-10-28T15:05:05+08:00',
  },
};
const c2c = g.normalizeEvent('C2C_MESSAGE_CREATE', c2cFrame.d, c2cFrame);
ok(c2c && c2c.kind === 'c2c' && c2c.openid === 'V1', '单聊事件归一化');

// 不认识的事件 → null，不抛
ok(g.normalizeEvent('SOMETHING_ELSE', {}, { id: 'evt-3' }) === null, '未知事件返回 null');

// 状态类事件（进群/退群）→ null 且不炸
ok(g.normalizeEvent('GROUP_ADD_ROBOT', { group_openid: 'G9', op_member_openid: 'U9' }, { id: 'evt-4' }) === null, '进群事件返回 null');

// ---- 白名单（cfg 是 core.js 的模块级变量；测试通过 g.cfg 直接访问沙箱全局）

g.__cfg.groupAllow = '';
ok(g.shouldReply({ kind: 'group', openid: 'G1', text: 'hi', raw: {} }), '白名单留空=所有群');
g.__cfg.groupAllow = 'G1, G2';
ok(g.shouldReply({ kind: 'group', openid: 'G1', text: 'hi', raw: {} }), '白名单命中');
ok(!g.shouldReply({ kind: 'group', openid: 'GX', text: 'hi', raw: {} }), '白名单未命中');
g.__cfg.groupAllow = '';

// 单聊富媒体类型不硬答
ok(!g.shouldReply({ kind: 'c2c', openid: 'V1', text: '[卡片]', raw: { message_type: 3 } }), '单聊卡片消息不回');
ok(g.shouldReply({ kind: 'c2c', openid: 'V1', text: '文本', raw: { message_type: 0 } }), '单聊文本回');
ok(!g.shouldReply({ kind: 'c2c', openid: 'V1', text: '', raw: {} }), '空文本不回');

// ---- msg_seq 预算

const state = { lastReplyAt: 0, seq: {} };
const s1 = g.nextSeq(state, 'm1');
ok(s1.n === 1, '首条回复 seq=1');
state.seq.m1 = { n: 3, at: Date.now() };
ok(g.nextSeq(state, 'm1').n === 4, '同一条消息 seq 递增');

// ---- 网关帧解析：喂一帧 Hello → 应当触发 Identify（这里只验证不抛 + 状态机不炸）

g.onSocketFrame(JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }));
g.onSocketFrame(JSON.stringify({ op: 11 }));
g.onSocketFrame(JSON.stringify({ op: 0, t: 'RESUMED', s: 7, d: '' }));
g.onSocketFrame('not json');
ok(true, '网关帧解析不抛');

// ---- 汇总

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAILED'}: ${passed} 通过, ${failures.length} 失败`);
process.exit(failures.length === 0 ? 0 : 1);
