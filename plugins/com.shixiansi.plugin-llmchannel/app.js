// app.js —— 渠道编辑器
//
// 这个插件的"设置界面"就是这一页：多个渠道、每个渠道多个模型、每个渠道多个密钥。
// manifest 的 config 表单做不到这件事（一个插件只能声明一个 llmBaseUrl / 一个 secret），
// 所以数据走两条路，都由宿主保存：
//
//   llm.channels.get / set   渠道表：地址、模型名、key 的 id 与标签
//   宿主 DPAPI               每个 key 的明文，单独文件，任何读接口都不返回
//
// 这一页永远不会拿到密钥明文：它只看到 {set, mask}。用户要换 key，就在输入框里打一个新的，
// 保存时作为 value 送出去（只写），界面随后重新读一次，拿回来的仍然只是 mask。
//
// 还有一个副作用要处理：渠道地址同样受 net.fetch 白名单约束。保存时把每个地址的 host 加进
// `extraHosts`（manifest 里那个 hostWhitelist 项）——用户刚刚亲手打了这个地址，让插件替他抄一遍
// 域名是这一页该做的事，而不是让他去设置里找那个字段。

'use strict';

const PROTOCOL = 1;

/** 服务商预设：只是给地址和"要不要密钥"一点默认值，选"自定义"就全手填。 */
const PRESETS = [
  { id: 'custom', label: '自定义（OpenAI 兼容）', baseUrl: '' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { id: 'moonshot', label: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'dashscope', label: '通义千问（阿里云）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'ollama', label: '本机 Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
];

const els = {
  channels: document.getElementById('channels'),
  defaultChannel: document.getElementById('default-channel'),
  status: document.getElementById('status'),
  error: document.getElementById('error'),
  add: document.getElementById('add'),
  save: document.getElementById('save'),
};

const granted = new Set();
let self = { pluginId: '', slot: '' };
let initialised = false;
/** The table as the host reports it: keys carry {set, mask}, never a value. */
let channels = [];
let defaultChannel = '';
/** Values the user typed in this session, keyed `channelId/keyId`. Never persisted here. */
const pendingKeys = new Map();
/** Extra hosts already in the whitelist, so the save step only adds what is missing. */
let whitelist = [];

let nextRequestID = 1;
const pending = new Map();

function postToHost(message) {
  if (!window.parent) return;
  window.parent.postMessage({ v: PROTOCOL, ...message }, '*');
}

function request(method, payload) {
  const id = String(nextRequestID++);
  postToHost({ type: 'request', id, method, payload: payload === undefined ? {} : payload });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

applyTheme(new URLSearchParams(location.search).get('theme'));

// --- helpers -----------------------------------------------------------------

function say(line) {
  if (els.status) els.status.textContent = line || '';
}

function fail(err) {
  if (!els.error) return;
  const message = err && err.message ? err.message : String(err || '');
  els.error.hidden = !message;
  els.error.textContent = message;
}

/** 新行的 id：短、稳定、可读（也是存储文件名的一半，所以只用 [A-Za-z0-9_-]）。 */
function newID(prefix, taken) {
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${prefix}${i}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${prefix}${Date.now().toString(36)}`;
}

function hostOf(baseUrl) {
  try {
    const u = new URL(String(baseUrl || '').trim());
    return u.host || '';
  } catch {
    return '';
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// --- 自绘下拉框 --------------------------------------------------------------
//
// 为什么不用原生 `<select>`：它的**弹层**由系统绘制（方角、灰底高亮、系统字体），CSS 只能改
// 收起时的外观，改不了打开的那一列——所以它永远"还是最原始的风格"。这里用
// `button[aria-haspopup=listbox]` + `ul[role=listbox]` 自己画，样式在 ui.css 的 `.select*`。
//
// 键盘照 listbox 的惯例：Enter/Space/↓ 打开，↑↓ 移动，Home/End 到首尾，Enter 选中，Esc 关闭，
// Tab 走人。焦点留在触发按钮上（不是列表），这样读屏念的是"当前值"。

function makeSelect({ options, value, onChange, ariaLabel }) {
  const wrap = el('div', 'select');
  const trigger = el('button', 'select-trigger');
  trigger.type = 'button';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  if (ariaLabel) trigger.setAttribute('aria-label', ariaLabel);
  const label = el('span', 'select-value');
  const chev = el('span', 'chev');
  chev.setAttribute('aria-hidden', 'true');
  trigger.append(label, chev);

  const list = el('ul', 'select-list');
  list.setAttribute('role', 'listbox');
  list.hidden = true;

  let current = value;
  let activeIndex = -1;

  const items = options.map((opt, index) => {
    const item = el('li', 'select-option');
    item.setAttribute('role', 'option');
    item.dataset.value = opt.value;
    item.append(el('span', '', opt.label));
    const tick = el('span', 'tick', '✓');
    tick.setAttribute('aria-hidden', 'true');
    item.append(tick);
    item.addEventListener('click', () => choose(index));
    item.addEventListener('mousemove', () => setActive(index));
    return item;
  });
  list.append(...items);

  function labelOf(candidate) {
    const found = options.find((opt) => opt.value === candidate);
    if (found) return found.label;
    return options[0] ? options[0].label : '';
  }

  function paint() {
    label.textContent = labelOf(current);
    items.forEach((item, index) => {
      item.setAttribute('aria-selected', String(options[index].value === current));
    });
  }

  function setActive(index) {
    activeIndex = index;
    items.forEach((item, i) => item.classList.toggle('active', i === index));
  }

  function open() {
    list.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    const at = options.findIndex((opt) => opt.value === current);
    setActive(at >= 0 ? at : 0);
    document.addEventListener('pointerdown', onOutside, true);
  }

  function close() {
    if (list.hidden) return;
    list.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    setActive(-1);
    document.removeEventListener('pointerdown', onOutside, true);
  }

  function onOutside(event) {
    if (!wrap.contains(event.target)) close();
  }

  function choose(index) {
    const opt = options[index];
    if (!opt) return;
    current = opt.value;
    paint();
    close();
    trigger.focus();
    if (onChange) onChange(opt.value);
  }

  trigger.addEventListener('click', () => {
    if (list.hidden) open();
    else close();
  });

  trigger.addEventListener('keydown', (event) => {
    const key = event.key;
    if (key === 'Enter' || key === ' ' || key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault(); // 也挡掉 Enter/Space 在 button 上合成的那次 click
      if (list.hidden) {
        open();
        if (key === 'ArrowUp') setActive(items.length - 1);
        return;
      }
      if (key === 'Enter' || key === ' ') {
        choose(activeIndex >= 0 ? activeIndex : 0);
        return;
      }
      if (key === 'ArrowDown') setActive(Math.min(activeIndex + 1, items.length - 1));
      else setActive(Math.max(activeIndex - 1, 0));
      return;
    }
    if (key === 'Escape') {
      if (!list.hidden) {
        event.preventDefault();
        close();
      }
      return;
    }
    if (key === 'Home' && !list.hidden) {
      event.preventDefault();
      setActive(0);
      return;
    }
    if (key === 'End' && !list.hidden) {
      event.preventDefault();
      setActive(items.length - 1);
      return;
    }
    if (key === 'Tab') close();
  });

  paint();
  wrap.append(trigger, list);
  wrap.setValue = (next) => {
    current = next;
    paint();
  };
  return wrap;
}

// --- rendering ---------------------------------------------------------------

function renderDefaultPicker() {
  if (!els.defaultChannel) return;
  els.defaultChannel.textContent = '';
  if (!channels.length) {
    els.defaultChannel.append(el('p', 'hint', '（还没有渠道）'));
    return;
  }
  els.defaultChannel.append(
    makeSelect({
      ariaLabel: '默认渠道',
      options: channels.map((channel) => ({ value: channel.id, label: channel.name || channel.id })),
      value: defaultChannel || channels[0].id,
      onChange: (next) => {
        defaultChannel = next;
      },
    }),
  );
}


function renderKeyRow(channel, key) {
  const row = el('div', 'key-row');
  const label = el('input', 'input label');
  label.type = 'text';
  label.value = key.label || '';
  label.placeholder = '这个 key 叫什么（主号 / 备用）';
  label.addEventListener('input', () => {
    key.label = label.value;
  });

  const state = el('span', `tag ${key.set ? 'ok' : 'warn'}`, key.set ? key.mask || '已保存' : '未保存');

  const value = el('input', 'input value');
  value.type = 'password';
  value.placeholder = key.set ? '换一个（留空=不改）' : '粘贴密钥';
  value.addEventListener('input', () => {
    const slot = `${channel.id}/${key.id}`;
    if (value.value === '') pendingKeys.delete(slot);
    else pendingKeys.set(slot, value.value);
  });

  const remove = el('button', 'btn tiny ghost', '删除');
  remove.type = 'button';
  remove.addEventListener('click', () => {
    channel.keys = channel.keys.filter((k) => k.id !== key.id);
    pendingKeys.delete(`${channel.id}/${key.id}`);
    renderChannels();
  });

  row.append(label, state, value, remove);
  return row;
}

function renderChannelCard(channel) {
  const card = el('section', 'card channel');

  const head = el('div', 'channel-head');
  const name = el('input', 'input name');
  name.type = 'text';
  name.value = channel.name || '';
  name.placeholder = '渠道名（例如 主号 OpenAI）';
  name.addEventListener('input', () => {
    channel.name = name.value;
  });
  const remove = el('button', 'btn tiny danger', '删除渠道');
  remove.type = 'button';
  remove.addEventListener('click', () => {
    channels = channels.filter((c) => c.id !== channel.id);
    if (defaultChannel === channel.id) defaultChannel = channels.length ? channels[0].id : '';
    renderChannels();
  });
  head.append(name, el('span', 'tag mono', channel.id), remove);

  const presetRow = el('div', 'row');
  presetRow.append(el('span', 'k', '服务商预设'));
  const presetBox = el('div', 'grow');
  presetBox.append(
    makeSelect({
      ariaLabel: '服务商预设',
      options: PRESETS.map((option) => ({ value: option.id, label: option.label })),
      value: channel.provider || 'custom',
      onChange: (next) => {
        channel.provider = next;
        const found = PRESETS.find((option) => option.id === next);
        // 只在地址还是空的时候替用户填：不覆盖他手打过的东西。
        if (found && found.baseUrl && !String(channel.baseUrl || '').trim()) {
          channel.baseUrl = found.baseUrl;
          renderChannels();
        }
      },
    }),
  );
  presetRow.append(presetBox);

  const baseRow = el('label', 'row');
  baseRow.append(el('span', 'k', '接口地址'));
  const base = el('input', 'input wide');
  base.type = 'text';
  base.value = channel.baseUrl || '';
  base.placeholder = 'https://api.openai.com/v1';
  base.addEventListener('input', () => {
    channel.baseUrl = base.value;
  });
  baseRow.append(base);

  const modelRow = el('label', 'row');
  modelRow.append(el('span', 'k', '模型'));
  const models = el('input', 'input wide');
  models.type = 'text';
  models.value = (channel.models || []).join(', ');
  models.placeholder = 'gpt-4o, gpt-4o-mini（逗号分隔，第一个是默认）';
  models.addEventListener('input', () => {
    channel.models = models.value
      .split(/[,，\s]+/)
      .map((m) => m.trim())
      .filter(Boolean);
    if (!channel.defaultModel && channel.models.length) channel.defaultModel = channel.models[0];
  });
  modelRow.append(models);

  const defaultModelRow = el('label', 'row');
  defaultModelRow.append(el('span', 'k', '默认模型'));
  const defaultModel = el('input', 'input wide');
  defaultModel.type = 'text';
  defaultModel.value = channel.defaultModel || '';
  defaultModel.placeholder = '留空=用上面第一个';
  defaultModel.addEventListener('input', () => {
    channel.defaultModel = defaultModel.value.trim();
  });
  defaultModelRow.append(defaultModel);

  const keysHead = el('div', 'keys-head');
  keysHead.append(el('h3', '', '密钥'));
  const addKey = el('button', 'btn tiny soft', '+ 添加密钥');
  addKey.type = 'button';
  addKey.addEventListener('click', () => {
    channel.keys = channel.keys || [];
    channel.keys.push({ id: newID('k', channel.keys.map((k) => k.id)), label: '', set: false });
    renderChannels();
  });
  keysHead.append(addKey);

  card.append(head, presetRow, baseRow, modelRow, defaultModelRow, keysHead);
  for (const key of channel.keys || []) card.append(renderKeyRow(channel, key));
  if (!(channel.keys || []).length) {
    card.append(el('p', 'hint', '还没有密钥。本机 Ollama 这类服务可以一个都不填。'));
  }
  return card;
}

function renderChannels() {
  if (!els.channels) return;
  els.channels.textContent = '';
  renderDefaultPicker();
  for (const channel of channels) els.channels.append(renderChannelCard(channel));
  if (!channels.length) {
    els.channels.append(el('p', 'hint', '还没有渠道。点右上角「+ 添加渠道」。'));
  }
}

// --- loading / saving --------------------------------------------------------

async function refreshConfig() {
  try {
    const res = await request('config.get', {});
    const values = (res && res.values) || {};
    whitelist = String(values.extraHosts || '')
      .split(/[,;\s]+/)
      .map((h) => h.trim())
      .filter(Boolean);
  } catch {
    whitelist = [];
  }
}

async function load() {
  await refreshConfig();
  const res = await request('llm.channels.get', {});
  channels = Array.isArray(res && res.channels) ? res.channels : [];
  for (const channel of channels) {
    channel.keys = Array.isArray(channel.keys) ? channel.keys : [];
    channel.models = Array.isArray(channel.models) ? channel.models : [];
    channel.provider = channel.provider || 'custom';
  }
  defaultChannel = String((res && res.defaultChannel) || '');
  if (!defaultChannel && channels.length) defaultChannel = channels[0].id;
  pendingKeys.clear();
  renderChannels();
  say(`已读取 ${channels.length} 个渠道`);
}

/** 把每个渠道地址的 host 补进白名单，返回补了哪些。 */
async function ensureHosts() {
  const missing = [];
  for (const channel of channels) {
    const host = hostOf(channel.baseUrl);
    if (!host) continue;
    if (whitelist.includes(host) || missing.includes(host)) continue;
    missing.push(host);
  }
  if (!missing.length) return [];
  const next = whitelist.concat(missing).join(', ');
  await request('config.set', { values: { extraHosts: next } });
  whitelist = whitelist.concat(missing);
  return missing;
}

async function save() {
  if (els.save) els.save.disabled = true;
  fail('');
  try {
    // 先把用户这一轮打过的密钥并进 payload：只写一次，然后从内存里清掉。
    const payload = {
      defaultChannel,
      channels: channels.map((channel) => ({
        id: channel.id,
        name: channel.name || '',
        baseUrl: String(channel.baseUrl || '').trim(),
        provider: channel.provider || 'custom',
        models: channel.models || [],
        defaultModel: channel.defaultModel || '',
        keys: (channel.keys || []).map((key) => {
          const value = pendingKeys.get(`${channel.id}/${key.id}`);
          const row = { id: key.id, label: key.label || '' };
          if (value) row.value = value;
          return row;
        }),
      })),
    };
    const stored = await request('llm.channels.set', payload);
    const added = await ensureHosts();
    pendingKeys.clear();
    channels = Array.isArray(stored && stored.channels) ? stored.channels : [];
    for (const channel of channels) {
      channel.keys = Array.isArray(channel.keys) ? channel.keys : [];
      channel.models = Array.isArray(channel.models) ? channel.models : [];
      channel.provider = channel.provider || 'custom';
    }
    defaultChannel = String((stored && stored.defaultChannel) || defaultChannel);
    renderChannels();
    say(added.length
      ? `已保存；顺手把 ${added.join('、')} 加进了「额外允许的地址」`
      : `已保存（${channels.length} 个渠道）`);
  } catch (err) {
    fail(err);
    say('保存失败');
  } finally {
    if (els.save) els.save.disabled = false;
  }
}

function addChannel() {
  const taken = channels.map((c) => c.id);
  const channel = {
    id: newID('ch', taken),
    name: '',
    baseUrl: '',
    provider: 'custom',
    models: [],
    defaultModel: '',
    keys: [],
  };
  channels.push(channel);
  if (!defaultChannel) defaultChannel = channel.id;
  renderChannels();
}

// --- bridge ------------------------------------------------------------------

function onResponse(data) {
  const waiter = pending.get(data.id);
  if (!waiter) return;
  pending.delete(data.id);
  if (data.ok) waiter.resolve(data.result);
  else waiter.reject(new Error(data.error || '插件请求失败'));
}

function onInit(payload) {
  self = {
    pluginId: payload.pluginId || '',
    slot: (payload.surface && payload.surface.slot) || '',
  };
  granted.clear();
  for (const name of payload.granted || []) granted.add(name);
  applyTheme(payload.theme);
  initialised = true;

  // 这一页在控制中心里跑（slot=workshop），那里**服务** llm.channels.*（它们是插件自己的设置，
  // 不涉及模型调用）。但它不服务 llm.chat / llm.profile —— 所以这一页一个都不问。
  if (!granted.has('llm.chat')) {
    say('没有 llm.chat 权限：渠道表读写都会被拒。去插件设置里重新授权。');
    return;
  }
  void load().catch((err) => {
    fail(err);
    say('读取失败');
  });
}

function onMessage(event) {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.v !== PROTOCOL) return;
  switch (data.type) {
    case 'init':
      onInit(data);
      break;
    case 'theme':
      applyTheme(data.theme);
      break;
    case 'response':
      onResponse(data);
      break;
    default:
      break;
  }
}

window.addEventListener('message', onMessage);
if (els.add) els.add.addEventListener('click', () => addChannel());
if (els.save) els.save.addEventListener('click', () => void save());
// 默认渠道的下拉框由 renderDefaultPicker 每次重建，回调写在它里面；这里不再挂 change。
postToHost({ type: 'ready' });

/**
 * 测试接缝：把"点了什么"变成可断言的调用。
 *
 * 这一页的每一次读写仍然经 `request` 过宿主的闸门，所以它不是额外的能力。
 */
window.__llmchannel = Object.freeze({
  state: () => ({ channels, defaultChannel, whitelist, pending: [...pendingKeys.keys()] }),
  load,
  save,
  addChannel,
  refreshConfig,
  hostOf,
});
