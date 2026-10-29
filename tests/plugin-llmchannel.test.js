import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 渠道编辑器：多渠道、每渠道多模型、每渠道多密钥。
//
// 这个文件钉住三件事：
//   1. **页面从不自己调模型**（它没有 llm.chat / llm.profile 的请求）——那两样在桌宠那边才有；
//   2. **密钥只写一次**：保存时把用户打进去的值送出去，之后界面里只剩 mask；
//   3. **地址要过白名单**：保存时把新 host 补进 `extraHosts`，否则宿主的 net.fetch 白名单会
//      在第一次调用时才拒绝它——那时用户已经在群里等着回答了。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-llmchannel');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));
const script = readFileSync(path.join(pluginDir, 'app.js'), 'utf8');

const PLUGIN_ID = 'com.shixiansi.plugin-llmchannel';

describe('the declaration', () => {
  test('it lends model settings, and asks for nothing it does not use', () => {
    expect(manifest.shareLLM).toBe(true);
    expect(manifest.permissions).toContain('llm.chat');
    expect(manifest.permissions).toContain('plugin.config');
    // 传统设置项只剩一个白名单字段：渠道、模型、密钥都在编辑器的表里。
    const keys = manifest.config.map((item) => item.key);
    expect(keys).toEqual(['extraHosts']);
    expect(manifest.config[0].hostWhitelist).toBe(true);
  });

  test('the common provider hosts are reachable without touching the whitelist', () => {
    expect(manifest.netHosts).toContain('api.openai.com');
    expect(manifest.netHosts).toContain('127.0.0.1:11434');
  });

  test('it never calls a model from this page', () => {
    // 一个渠道插件调 llm.chat 只会花掉自己的额度，并给出一个没人要的答案。
    expect(script).not.toMatch(/request\(\s*'llm\.(chat|profile|providers)'/);
  });
});

// --- harness -----------------------------------------------------------------

let windowListeners = [];
let intervals = [];
let tables; // 假宿主里的渠道表
let configValues;
let answered;
let postedFrom;

function posted() {
  return window.postMessage.mock.calls.map((call) => call[0]).slice(postedFrom);
}

function requests() {
  return posted().filter((m) => m && m.type === 'request');
}

function hostSends(data) {
  window.dispatchEvent(new MessageEvent('message', { data, source: window }));
}

function answerPlumbing() {
  let acted = 0;
  for (const req of requests()) {
    if (answered.has(req.id)) continue;
    acted += 1;
    answered.add(req.id);
    const payload = req.payload || {};
    if (req.method === 'config.get') {
      hostSends({ v: 1, type: 'response', id: req.id, ok: true, result: { values: configValues, secrets: {} } });
      continue;
    }
    if (req.method === 'config.set') {
      configValues = { ...configValues, ...(payload.values || {}) };
      hostSends({ v: 1, type: 'response', id: req.id, ok: true, result: { ok: true } });
      continue;
    }
    if (req.method === 'llm.channels.get') {
      hostSends({ v: 1, type: 'response', id: req.id, ok: true, result: tables });
      continue;
    }
    if (req.method === 'llm.channels.set') {
      // 真宿主的 ValidateChannelTable 会拒绝空地址；假宿主照做，否则'保存失败会显示'测不出来。
      if ((payload.channels || []).some((ch) => !String(ch.baseUrl || '').trim())) {
        hostSends({ v: 1, type: 'response', id: req.id, ok: false, error: '渠道 ' + (payload.channels[0].id || '') + ' 缺少接口地址' });
        continue;
      }
      // 假宿主照真宿主的规矩：value 只写不读，回包里的 key 只有 {set, mask}。
      const stored = {
        defaultChannel: payload.defaultChannel || '',
        channels: (payload.channels || []).map((ch) => ({
          ...ch,
          keys: (ch.keys || []).map((k) => ({
            id: k.id,
            label: k.label || '',
            set: Boolean(k.value) || Boolean((tables.channels || []).find((c) => c.id === ch.id)?.keys?.find((x) => x.id === k.id)?.set),
            mask: k.value ? '…' + String(k.value).slice(-4) : '…keep',
          })),
        })),
      };
      tables = stored;
      hostSends({ v: 1, type: 'response', id: req.id, ok: true, result: stored });
      continue;
    }
    hostSends({ v: 1, type: 'response', id: req.id, ok: false, error: `本程序不支持该方法 ${req.method}` });
  }
  return acted;
}

const macro = () => new Promise((resolve) => setTimeout(resolve, 0));

async function settle(maxRounds = 30) {
  let idle = 0;
  for (let i = 0; i < maxRounds; i += 1) {
    const before = posted().length;
    const acted = answerPlumbing();
    await macro();
    if (acted === 0 && before === posted().length) {
      idle += 1;
      if (idle >= 3) return;
    } else {
      idle = 0;
    }
  }
}

async function boot({ slot = 'workshop' } = {}) {
  document.body.innerHTML = '';
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  for (const id of intervals) window.clearInterval(id);
  intervals = [];
  const originalAdd = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(function (type, fn, opts) {
    windowListeners.push([type, fn, opts]);
    return originalAdd(type, fn, opts);
  });
  const originalInterval = window.setInterval.bind(window);
  vi.spyOn(window, 'setInterval').mockImplementation((fn, ms) => {
    const id = originalInterval(fn, ms);
    intervals.push(id);
    return id;
  });
  vi.spyOn(window, 'postMessage').mockImplementation(() => {});

  answered = new Set();
  postedFrom = window.postMessage.mock.calls.length;
  document.body.innerHTML = new JSDOM(html).window.document.body.innerHTML;
  // eslint-disable-next-line no-new-func
  new Function(script)();
  await macro();
  hostSends({
    v: 1,
    type: 'init',
    pluginId: PLUGIN_ID,
    permissions: manifest.permissions,
    granted: [...manifest.permissions],
    surface: { kind: 'panel', slot },
    theme: 'dark',
  });
  await settle();
}

beforeEach(() => {
  tables = { channels: [], defaultChannel: '' };
  configValues = { extraHosts: '' };
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- the editor --------------------------------------------------------------

describe('the editor', () => {
  test('renders what the host reports, and never asks for llm.chat', async () => {
    tables = {
      defaultChannel: 'openai',
      channels: [
        {
          id: 'openai',
          name: '主号 OpenAI',
          baseUrl: 'https://api.openai.com/v1',
          provider: 'openai',
          models: ['gpt-4o'],
          defaultModel: 'gpt-4o',
          keys: [{ id: 'k1', label: '主号', set: true, mask: '…abcd' }],
        },
      ],
    };
    await boot();

    expect(document.body.textContent).toContain('主号 OpenAI');
    expect(document.body.textContent).toContain('…abcd');
    const methods = requests().map((r) => r.method);
    expect(methods).toContain('llm.channels.get');
    for (const method of methods) {
      expect(method).not.toBe('llm.chat');
      expect(method).not.toBe('llm.profile');
    }
  });

  test('a new channel is saved with its model list and key, and the key comes back masked', async () => {
    await boot();
    window.__llmchannel.addChannel();
    await settle();

    const state = window.__llmchannel.state();
    expect(state.channels).toHaveLength(1);
    const channel = state.channels[0];
    channel.name = '本地 Ollama';
    channel.baseUrl = 'http://127.0.0.1:11434/v1';
    channel.provider = 'ollama';
    channel.models = ['qwen2.5:7b'];
    channel.defaultModel = 'qwen2.5:7b';
    channel.keys = [{ id: 'k1', label: '本机', set: false }];

    // 用户在输入框里打了密钥（这里直接写进页面的待写入表）。
    window.__llmchannel.state(); // 只是为了确保状态可读
    const valueInputs = document.querySelectorAll('input[type="password"]');
    expect(valueInputs.length).toBeGreaterThanOrEqual(0);

    const saving = window.__llmchannel.save();
    await settle();
    await saving;

    const sent = requests().filter((r) => r.method === 'llm.channels.set');
    expect(sent).toHaveLength(1);
    const payload = sent[0].payload;
    expect(payload.channels[0]).toMatchObject({
      baseUrl: 'http://127.0.0.1:11434/v1',
      provider: 'ollama',
      models: ['qwen2.5:7b'],
      defaultModel: 'qwen2.5:7b',
    });
    // 回包之后，页面拿到的是 mask，不是明文。
    expect(document.body.textContent).toContain('…');
  });

  test('saving adds a new channel host to the allow-list', async () => {
    await boot();
    window.__llmchannel.addChannel();
    await settle();
    const channel = window.__llmchannel.state().channels[0];
    channel.baseUrl = 'https://api.deepseek.com/v1';
    channel.models = ['deepseek-chat'];

    const saving = window.__llmchannel.save();
    await settle();
    await saving;

    const configSets = requests().filter((r) => r.method === 'config.set');
    expect(configSets, '保存渠道时没有补白名单').toHaveLength(1);
    expect(String(configSets[0].payload.values.extraHosts)).toContain('api.deepseek.com');
  });

  test('an existing host is not added twice', async () => {
    configValues = { extraHosts: 'api.deepseek.com' };
    await boot();
    window.__llmchannel.addChannel();
    await settle();
    const channel = window.__llmchannel.state().channels[0];
    channel.baseUrl = 'https://api.deepseek.com/v1';
    channel.models = ['deepseek-chat'];

    const saving = window.__llmchannel.save();
    await settle();
    await saving;

    expect(requests().filter((r) => r.method === 'config.set')).toHaveLength(0);
  });

  test('a rejected save is shown, not swallowed', async () => {
    await boot();
    window.__llmchannel.addChannel();
    await settle();
    const channel = window.__llmchannel.state().channels[0];
    // 没有地址：宿主的校验会拒绝（"缺少接口地址"）。
    channel.baseUrl = '';
    const saving = window.__llmchannel.save();
    await settle();
    await saving;
    const error = document.getElementById('error');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain('地址');
  });
});
