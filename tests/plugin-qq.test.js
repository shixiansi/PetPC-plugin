import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Behaviour tests for the QQ plugin, driven through its real panel.html in jsdom.
//
// The technique is the voice plugin's (see plugin-voice.test.js): `parent` in jsdom
// IS the window, so a spy on window.postMessage is the host's inbox and a dispatched
// MessageEvent with source=window is a frame the host sent. What that buys, and what
// reading the source cannot: the plugin must not ask for anything before `init`, the
// socket must be opened with the URL derived from the ONE server setting, and a
// Milky `message_receive` frame must end in exactly one `send_group_message` carrying
// the model's answer - while saying nothing at all when the bot was not addressed.
//
// The two appearances matter here as much as they do for the voice plugin:
//
//   surface.slot === 'background'  the pet's headless frame: it owns the socket and
//                                  answers groups. Draws nothing.
//   surface.slot === 'workshop'    the plugin market's view: status and memory
//                                  housekeeping, and it must NOT open a second socket.
//
// The fake host ANSWERS the plumbing (storage, config, ws.*, net.fetch) and leaves
// `llm.chat` to each test, because the model call is the assertion in half of them.

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-qq');
const panelPath = path.join(pluginDir, 'panel.html');
const cssPath = path.join(pluginDir, 'style.css');
const manifestPath = path.join(pluginDir, 'manifest.json');

const html = readFileSync(panelPath, 'utf8');
const css = readFileSync(cssPath, 'utf8');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// The scripts to evaluate come from panel.html, not from a list kept here.
//
// One list is the point: the plugin is now a set of classic scripts loaded in order
// (lib/core.js, lib/store.js, ... app.js), and a second copy of that order in the test
// harness would drift the first time someone adds a file. Whatever the HTML loads, the
// test loads - in the same order, through the same global scope.
const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');

/** The plugin's own source, concatenated: used by tests that assert on the code itself. */
const source = scriptSources
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-qq';
const PERMISSIONS = manifest.permissions;
const ALL_GRANTED = [...PERMISSIONS];

describe('manifest', () => {
  test('declares the headless frame and the permissions that fill it', () => {
    // The pairing the manifest validator enforces: `background` needs `events` or `net.ws`.
    // qq has both now — `net.ws` for the protocol side, and `events` because it subscribes to
    // `config.changed` (the host only pushes settings events to subscribers, §7.1).
    //
    // 这条以前断言的是 `not.toContain('events')`，理由当时成立（没有任何宿主事件要听）。
    // 现在它订阅了设置事件，所以那条断言要跟着改——**申请了就必须用**：一个"什么都没做的
    // 开关"正是 §3.1 里拒绝的那种东西。
    expect(manifest.background).toBe(true);
    expect(manifest.permissions).toContain('net.ws');
    expect(manifest.permissions).toContain('events');
    const admin = readFileSync(path.join(pluginDir, 'lib', 'admin.js'), 'utf8');
    expect(admin, '申请了 events 却没订阅').toContain('events.subscribe');
  });

  test('declares every capability the code uses', () => {
    for (const needed of ['net.ws', 'net.fetch', 'llm.chat', 'llm.borrow', 'storage', 'plugin.config', 'process']) {
      expect(manifest.permissions, `manifest does not ask for ${needed}`).toContain(needed);
    }
  });

  test('the client settings exist, and auto-start is off by default', () => {
    // Starting a program on the user's machine is the widest permission this plugin
    // asks for, so the switch that uses it must default to OFF and the path to empty:
    // an update that arrived with "auto start: on" would start something the user
    // never pointed at.
    const byKey = new Map(manifest.config.map((item) => [item.key, item]));
    for (const key of ['clientPath', 'clientArgs', 'autoStartClient']) {
      expect(byKey.get(key), `manifest does not declare ${key}`).toBeTruthy();
    }
    expect(byKey.get('clientPath').default).toBe('');
    expect(byKey.get('clientArgs').default).toBe('');
    expect(byKey.get('autoStartClient').type).toBe('bool');
    expect(byKey.get('autoStartClient').default).toBe('false');
  });

  test('the protocol side is on the allow-list', () => {
    // `server` contributes its host through hostWhitelist, and netHosts declares the
    // default explicitly. A plugin that could not reach its own default would be
    // installable and immediately useless.
    expect(manifest.netHosts).toContain('127.0.0.1:3000');
    const server = manifest.config.find((item) => item.key === 'server');
    expect(server.hostWhitelist).toBe(true);
    expect(server.default).toBe('127.0.0.1:3000');
  });

  test('exactly one secret, and it is the model credential', () => {
    // The host routes the FIRST secret item to llm.chat as the credential, so a
    // plugin that declared a second one first would send its protocol token as an
    // API key.
    const secrets = manifest.config.filter((item) => item.secret === true);
    expect(secrets).toHaveLength(1);
    expect(secrets[0].key).toBe('llmApiKey');
    expect(secrets[0].type).toBe('secret');
  });

  test('stays within the host config item limit', () => {
    // Host cap = 40 (README: "manifest 的 config 上限是宿主的 40 项，QQ 插件已经用满了").
    // The Go source (`internal/plugins/manifest.go`, maxConfigItems) is not part of this
    // market repo and is absent on dev machines that only check out the market, so the
    // number is restated here with the README as the cross-reference. The QQ manifest
    // being AT the cap is itself load-bearing: adding a config item requires dropping
    // one or moving the setting into plugin-owned storage (that is where the memcore
    // switch and personaBehavior live — see lib/store.js DATA).
    const HOST_CONFIG_CAP = 40;
    expect(manifest.config.length, `config 项数超过宿主上限 ${HOST_CONFIG_CAP}`).toBeLessThanOrEqual(HOST_CONFIG_CAP);
  });
});

describe('style.css', () => {
  test('a [hidden] rule exists and uses !important', () => {
    // The markup toggles `hidden` on the two appearances, and `.workshop` sets
    // `display: flex` - which would outrank the user agent's `[hidden]` rule and put a
    // workshop on screen inside the pet's invisible frame.
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const match = stripped.match(/\[hidden\][^{]*\{([^}]*)\}/);
    expect(match, 'style.css has no [hidden] rule').toBeTruthy();
    expect(match[1]).toMatch(/display\s*:\s*none/);
    expect(match[1]).toMatch(/!important/);
  });

  test('no decoration paints outside an element box', () => {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const prop of ['box-shadow', 'filter:', 'text-shadow', 'transform:']) {
      expect(stripped, `style.css uses ${prop}, which paints outside the crop`).not.toContain(prop);
    }
  });
});

// --- harness -----------------------------------------------------------------

let windowListeners = [];
/** Values the fake host reports for config.get. */
let bootValues = {};
/** Response body for every storage.get whose key is not in `storageMap`. */
let storageValue = '';
/**
 * A real per-key storage, which is what the sticker card needs: it reads the index, the
 * category list and ONE PAGE of `sticker_<hash>` bytes, and it writes the first two back.
 * A single global `storageValue` cannot express "the bytes of these 24, and not of those
 * 6", which is precisely the claim the paging tests make.
 */
let storageMap = new Map();
/** Timers the plugin started, so a workshop poll cannot outlive its own test. */
let intervals = [];
/**
 * When true, the fake host refuses the get_login_info probe the way an unreachable
 * protocol side does - a transport-level failure, not an HTTP error - which is what
 * makes the plugin consider starting the client.
 */
let loginInfoUnreachable = false;
/**
 * When true, the fake host REFUSES process.launch - which is what a wrong path, a
 * missing permission or an argument the host will not accept looks like to the plugin.
 */
let launchFails = false;
/**
 * When true, the fake host refuses `get_message` - which is what a protocol side that
 * only knows the messages it saw since it started answers with ("Message not found").
 */
let getMessageFails = false;
/**
 * When true (the default), the fake host's private directory is an ALREADY-MIGRATED one:
 * `state/layout` is there, so the one-time tidy is a no-op. Setting it to false is what
 * makes a test an upgrade-from-1.10 install.
 */
let layoutMigrated = true;
/**
 * When true, the fake host is a PRE-1.11 pet: a storage key may be a bare file name and
 * nothing else, so every key containing `/` (and `storage.move`, which it does not have)
 * is refused. That is the "the plugin was updated, the pet was not" install.
 */
let hostRefusesSubfolders = false;
/**
 * The base64 body `net.fetch` returns for an image URL, and whether the host reports it as
 * cut at the size cap. Auto-collect downloads pictures, so these two are its inputs.
 */
let imageBody = '';
let imageTruncated = false;
/**
 * 群成员名单：`@昵称` → 真 @ 段要用它。默认关掉（协议端没有这个接口的样子），
 * 需要它的用例自己打开。
 */
let membersAvailable = false;
let groupMembers = [];
/** 群信息：`@群主` 要解析成这个 QQ 号。默认协议端没提供。 */
let groupInfoAvailable = false;
let groupOwnerID = 30001;
/** 协议端不支持"戳人"时置 true：所有 poke 接口都拒。 */
let pokeFails = false;
/** 群历史：补图功能要去这里翻图片地址。默认"协议端没这个接口"。 */
let historyAvailable = false;
let historyMessages = [];
/** url -> base64：按地址给不同的图，补图才能"只认出其中一张"。 */
const imageByUrl = new Map();
const answered = new Set();

function installPanel() {
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
}

async function loadApp() {
  // A fresh module restarts the request ids at 1, so "already answered" has to forget the
  // previous document's ids - otherwise a second boot in the same test finds every one of
  // its requests marked as answered and the plugin waits forever.
  answered.clear();
  // Drop the previous document's listeners and timers. Importing app.js again creates a
  // SECOND instance, and both would answer the same `init`: the old one keeps running with
  // its stale in-memory state, which is not "the pet restarted" but "two bots", and its
  // next persist silently reverts what the new one just wrote.
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  for (const id of intervals) window.clearInterval(id);
  intervals = [];
  vi.resetModules();
  // The new module restarts its request ids at 1, so both the "already answered" set and
  // the window it looks at have to start over: only traffic from this boot is the new
  // document's, and answering the old document's requests would replay its writes.
  postedFrom = window.postMessage.mock.calls.length;
  // 插件现在是一组经典脚本（panel.html 按顺序加载 lib/*.js，最后是 app.js）。这里把它们
  // 拼起来放进**一个新的函数作用域**里跑：
  //   · 拼接 = 浏览器里那几支脚本共享同一个作用域（跨文件互相看得见）；
  //   · new Function 每次给一份新作用域 = 原来"重新 import 一份新模块"的效果，`const state`
  //     之类可以安全地重新声明；
  //   · 不能逐个 import：每个 import 是独立模块作用域，拆开之后跨文件就看不到彼此的声明了。
  // eslint-disable-next-line no-new-func
  new Function(source)();
}

/**
 * Where the CURRENT document's postMessage traffic starts.
 *
 * A second boot in the same test reuses the same spy, so `posted()` would otherwise hand
 * back the previous document's requests as well - and answering those replays old writes
 * (a stale `state/groups`, for instance) on top of what the new document just did.
 */
let postedFrom = 0;

function posted() {
  return window.postMessage.mock.calls.map((call) => call[0]).slice(postedFrom);
}

function byType(type) {
  return posted().filter((m) => m && m.type === type);
}

function requests() {
  return byType('request').map((m) => ({ id: m.id, method: m.method, payload: m.payload }));
}

function requestsFor(method) {
  return requests().filter((r) => r.method === method);
}

function hostSends(data, { source = window } = {}) {
  window.dispatchEvent(new MessageEvent('message', { data, source }));
}

/** Answer one specific pending request. */
function answer(id, result, { ok = true, error = '' } = {}) {
  answered.add(id);
  hostSends({ v: 1, type: 'response', id, ok, result, error });
}

/**
 * Answers every pending request EXCEPT llm.chat, the way the real host would.
 *
 * Without this the plugin's own sequencing (read config, open socket, read the
 * group's memory, then ask the model) never advances: each step awaits a response,
 * and a test that hand-answered only the interesting ones would hang on the boring
 * ones and report "the model was never called".
 */
function answerPlumbing() {
  for (const req of requests()) {
    if (answered.has(req.id) || req.method === 'llm.chat') continue;
    // A pre-1.11 host: a key may be a bare file name and nothing else. Everything the
    // plugin asks for with a folder in it is refused, which is what "the pet was not
    // upgraded with the plugin" looks like from this side.
    const asked = req.payload || {};
    const keyed = [asked.key, asked.sub, asked.from, asked.to].filter((v) => typeof v === 'string');
    if (hostRefusesSubfolders && keyed.some((value) => value.includes('/'))) {
      answer(req.id, null, { ok: false, error: `storage key 非法：${keyed.join(' ')}` });
      continue;
    }
    switch (req.method) {
      case 'config.get':
        answer(req.id, { values: bootValues, secrets: {} });
        break;
      case 'storage.get': {
        const key = String((req.payload && req.payload.key) || '');
        answer(req.id, { value: storageMap.has(key) ? storageMap.get(key) : storageValue });
        break;
      }
      case 'storage.set': {
        const key = String((req.payload && req.payload.key) || '');
        storageMap.set(key, String((req.payload && req.payload.value) || ''));
        answer(req.id, { ok: true });
        break;
      }
      case 'storage.remove': {
        storageMap.delete(String((req.payload && req.payload.key) || ''));
        answer(req.id, { removed: true });
        break;
      }
      case 'storage.stat': {
        // The fake host is an ALREADY-MIGRATED install: `state/layout` exists, so the
        // one-time tidy does not run inside every other test. The migration tests flip
        // `layoutMigrated` and drive it themselves; once a test's migration has run, the
        // marker it wrote is what the next stat sees.
        const key = String((req.payload && req.payload.key) || '');
        if (key === 'state/layout') {
          const planted = storageMap.has(key);
          answer(req.id, { exists: planted || layoutMigrated, bytes: planted ? 1 : 0 });
          break;
        }
        answer(req.id, { exists: storageMap.has(key), bytes: String(storageMap.get(key) || '').length });
        break;
      }
      case 'storage.move': {
        const from = String((req.payload && req.payload.from) || '');
        const to = String((req.payload && req.payload.to) || '');
        // The three outcomes the real host reports, and they are told apart on purpose:
        // "nothing to move" and "already moved" need different handling.
        if (!storageMap.has(from)) {
          answer(req.id, { ok: true, moved: false });
          break;
        }
        if (storageMap.has(to)) {
          answer(req.id, { ok: true, moved: false, targetExists: true });
          break;
        }
        storageMap.set(to, storageMap.get(from));
        storageMap.delete(from);
        answer(req.id, { ok: true, moved: true });
        break;
      }
      case 'storage.dir':
        answer(req.id, { dir: `C:\\data\\qq\\${String((req.payload && req.payload.sub) || '')}` });
        break;
      case 'storage.list': {
        // One level of the fake directory: keys whose first segment is `sub`, files by
        // their remaining name and folders by the segment after it.
        const sub = String((req.payload && req.payload.sub) || '');
        const prefix = sub ? `${sub}/` : '';
        const files = [];
        const dirs = new Set();
        for (const [key, value] of storageMap) {
          if (!key.startsWith(prefix) || key === prefix) continue;
          const rest = key.slice(prefix.length);
          const slash = rest.indexOf('/');
          if (slash < 0) files.push({ name: rest, bytes: String(value || '').length });
          else dirs.add(rest.slice(0, slash));
        }
        answer(req.id, { dir: `C:\\data\\qq\\${sub}`, files, dirs: [...dirs] });
        break;
      }
      case 'ws.open':
        answer(req.id, { ok: true, state: 'connecting' });
        break;
      case 'net.fetch':
        // The startup probe goes through net.fetch, so the "nothing is listening"
        // case has to be expressible: the host reports a transport failure by
        // REJECTING the request (ok: false), never by returning an HTTP status.
        // 戳人：`pokeFails` 模拟"协议端没这个接口"（Milky 叫 send_group_nudge）。
        if (pokeFails && /poke|nudge/i.test(String(req.payload && req.payload.url))) {
          answer(req.id, null, { ok: false, error: 'not implemented' });
          break;
        }
        if (loginInfoUnreachable && String(req.payload && req.payload.url).includes('get_login_info')) {
          answer(req.id, null, { ok: false, error: 'connectex: No connection could be made' });
          break;
        }
        if (getMessageFails && String(req.payload && req.payload.url).includes('get_message')) {
          answer(req.id, null, { ok: false, error: 'Message not found' });
          break;
        }
        // An image URL is what auto-collect downloads: answer with bytes, and say whether
        // the host had to cut them at its size cap.
        if (String((req.payload && req.payload.url) || '').includes('img.example')) {
          const url = String(req.payload.url);
          answer(req.id, {
            status: 200,
            body: imageByUrl.has(url) ? imageByUrl.get(url) : imageBody,
            encoding: 'base64',
            truncated: imageTruncated,
          });
          break;
        }
        // 群历史：补图要顺着它翻图片地址。
        if (String((req.payload && req.payload.url) || '').includes('/api/get_history_messages')
          || String((req.payload && req.payload.url) || '').includes('/api/get_group_msg_history')) {
          if (!historyAvailable) {
            answer(req.id, null, { ok: false, error: 'not implemented' });
            break;
          }
          answer(req.id, {
            status: 200,
            body: JSON.stringify({ status: 'ok', retcode: 0, data: { messages: historyMessages } }),
          });
          break;
        }
        // 群成员名单：正文里的 `@昵称` 要换成真正的 @ 段，就得问协议端"谁叫什么"。
        if (String((req.payload && req.payload.url) || '').includes('get_group_member_list')) {
          if (!membersAvailable) {
            answer(req.id, null, { ok: false, error: 'not implemented' });
            break;
          }
          answer(req.id, {
            status: 200,
            body: JSON.stringify({
              status: 'ok',
              retcode: 0,
              data: groupMembers.map((row) => ({
                user_id: Number(row.id),
                card: row.card,
                nickname: row.nickname,
                role: row.role || 'member',
              })),
            }),
          });
          break;
        }
        // 群信息：`@群主` 要先把"群主"解析成 QQ 号。
        if (String((req.payload && req.payload.url) || '').includes('get_group_info')) {
          if (!groupInfoAvailable) {
            answer(req.id, null, { ok: false, error: 'not implemented' });
            break;
          }
          answer(req.id, {
            status: 200,
            body: JSON.stringify({
              status: 'ok',
              retcode: 0,
              data: { group: { owner_id: groupOwnerID } },
            }),
          });
          break;
        }
        answer(req.id, { ok: true });
        break;
      case 'process.launch':
        if (launchFails) {
          answer(req.id, null, { ok: false, error: 'process.launch 的 path 必须是绝对路径："yogurt.exe"' });
          break;
        }
        answer(req.id, { ok: true, pid: 4321 });
        break;
      default:
        answer(req.id, { ok: true });
        break;
    }
  }
}

/**
 * Lets the plugin run until it is waiting for something only the test can give.
 *
 * 30 ticks because an answer now walks through several storage round trips before it ever
 * reaches the model (energy settle, group notes, the asker's card, the sticker catalog),
 * and a tick is one round trip. The budget was 12 and that made "the model was never
 * called" the most common failure of an unrelated edit.
 */
async function pump(ticks = 30) {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve();
    answerPlumbing();
  }
}

function initFrame({ slot = 'background', granted = ALL_GRANTED } = {}) {
  return {
    v: 1,
    type: 'init',
    pluginId: PLUGIN_ID,
    permissions: PERMISSIONS,
    granted,
    surface: { kind: 'panel', slot },
  };
}

function hostEmits(name, payload) {
  hostSends({ v: 1, type: 'event', name, payload });
}

/**
 * Boots the background frame far enough to have a socket.
 *
 * 30 ticks rather than 12: startup begins with the data-layout tidy (a `storage.stat` for the
 * migration marker, then a `storage.list`), then the orphan-sticker sweep (ONE more
 * `storage.list` in `media/stickers/bytes`), and waiting for the socket is what every test
 * here assumes has happened by the time bootBot returns. Raising this is the honest cost of
 * adding a startup step; lowering it again without removing a step would make the socket tests
 * flaky instead of failing.
 */
async function bootBot({ values = {}, granted = ALL_GRANTED } = {}) {
  bootValues = values;
  await loadApp();
  hostSends(initFrame({ slot: 'background', granted }));
  await pump(30);
}

/** Drives an inbound Milky frame through the socket event. */
async function deliver(text) {
  hostEmits('ws.message', { text });
  await pump();
}

/** A Milky `message_receive` event for a group message. */
function groupMessage({
  groupID = 10086,
  senderID = 20001,
  selfID = 90001,
  segments = [{ type: 'text', data: { text: '你好' } }],
  seq = 7,
  card = '小明',
  groupName = '测试群',
  role = 'member',
} = {}) {
  return JSON.stringify({
    event_type: 'message_receive',
    time: 1700000000,
    self_id: selfID,
    data: {
      message_scene: 'group',
      peer_id: groupID,
      message_seq: seq,
      sender_id: senderID,
      time: 1700000000,
      segments,
      group: { group_id: groupID, group_name: groupName },
      group_member: { user_id: senderID, nickname: card, card, role },
    },
  });
}

function mention(selfID = 90001) {
  return { type: 'mention', data: { user_id: selfID, name: '机器人' } };
}

beforeEach(() => {
  installPanel();
  windowListeners = [];
  bootValues = {};
  storageValue = '';
  storageMap = new Map();
  intervals = [];
  answered.clear();
  getMessageFails = false;
  // Every test starts from an install whose layout was already tidied; the migration
  // tests below are the ones that say "this one is a 1.10 install with flat files".
  layoutMigrated = true;
  hostRefusesSubfolders = false;
  imageBody = '';
  imageTruncated = false;
  membersAvailable = false;
  groupMembers = [];
  groupInfoAvailable = false;
  groupOwnerID = 30001;
  pokeFails = false;
  historyAvailable = false;
  historyMessages = [];
  imageByUrl.clear();
  const originalAdd = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(function (type, fn, opts) {
    windowListeners.push([type, fn, opts]);
    return originalAdd(type, fn, opts);
  });
  vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  // The workshop view polls renderWorkshop every five seconds. Tracked (not blocked) so
  // a poll from a finished test cannot write into the next test's request log.
  const originalInterval = window.setInterval.bind(window);
  vi.spyOn(window, 'setInterval').mockImplementation((fn, ms) => {
    const id = originalInterval(fn, ms);
    intervals.push(id);
    return id;
  });
});

afterEach(() => {
  for (const id of intervals) window.clearInterval(id);
  intervals = [];
  for (const [type, fn, opts] of windowListeners) {
    window.removeEventListener(type, fn, opts);
  }
  windowListeners = [];
  vi.restoreAllMocks();
});

// --- handshake and the socket ------------------------------------------------

describe('handshake', () => {
  test('sends one ready frame and no request before init', async () => {
    await loadApp();
    expect(byType('ready')).toHaveLength(1);
    expect(byType('request')).toHaveLength(0);
  });

  test('the background frame reads its configuration, then opens the socket', async () => {
    await bootBot();
    expect(requestsFor('config.get')).toHaveLength(1);
    const open = requestsFor('ws.open');
    expect(open, 'the headless frame never opened a socket').toHaveLength(1);
    expect(open[0].payload.url).toBe('ws://127.0.0.1:3000/event');
  });

  test('the token travels both as a query parameter and as the header value', async () => {
    // milky-tea sends it as `?access_token=`; the host's dialer ALSO sends
    // `Authorization: Bearer`, and a protocol side that accepts either must be
    // reachable from here. A browser WebSocket could not send the header at all,
    // which is why the host owns the socket.
    await bootBot({ values: { accessToken: 'tok-123' } });
    const open = requestsFor('ws.open')[0];
    expect(open.payload.url).toBe('ws://127.0.0.1:3000/event?access_token=tok-123');
    expect(open.payload.token).toBe('tok-123');
  });

  test('a full URL in `server` keeps its scheme and prefix', async () => {
    await bootBot({ values: { server: 'https://bot.example.com/milky/' } });
    const open = requestsFor('ws.open')[0];
    expect(open.payload.url).toBe('wss://bot.example.com/milky/event');
  });

  test('without net.ws nothing is opened, and the log says which permission', async () => {
    await bootBot({ granted: ['llm.chat', 'storage', 'plugin.config'] });
    expect(requestsFor('ws.open')).toHaveLength(0);
    await vi.waitFor(() => {
      const log = requestsFor('storage.set').filter((r) => r.payload.key === 'state/log');
      expect(log.length).toBeGreaterThan(0);
      expect(log.slice(-1)[0].payload.value).toContain('net.ws');
    });
  });

  test('the workshop view never opens a second socket', async () => {
    await loadApp();
    hostSends(initFrame({ slot: 'workshop' }));
    await pump();
    expect(requestsFor('ws.open')).toHaveLength(0);
    // It reads the files the bot wrote instead.
    expect(requestsFor('storage.get').map((r) => r.payload.key)).toEqual(
      expect.arrayContaining(['state/status', 'state/groups', 'state/log']),
    );
  });
});

// --- answering a group -------------------------------------------------------

describe('answering', () => {
  test('a mention produces one model call and one reply, quoting the question', async () => {
    // 引用现在按概率：这条用例断言的是"引用长什么样"，所以把概率锁到 100%。
    await bootBot({ values: { quoteChance: '100' } });
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(
      groupMessage({ segments: [mention(), { type: 'text', data: { text: '今天天气怎么样' } }] }),
    );

    const chat = requestsFor('llm.chat');
    expect(chat, 'a mention did not reach the model').toHaveLength(1);
    // The speaker travels WITH the question, in the same `昵称：内容` shape the history
    // uses: the prompt promises "消息前面会带上说话人的昵称", and a model that cannot
    // see who is talking answers "你们" - which is how a helpdesk reads, not a group.
    expect(chat[0].payload.text).toBe('小明：今天天气怎么样');
    // An explicit system prompt is what makes the host skip the pet's world
    // snapshot: a group must not be told the user's todos.
    expect(chat[0].payload.system).toContain('测试群');
    expect(chat[0].payload.history).toEqual([]);

    answer(chat[0].id, { text: '晴，26 度。' });
    await pump();

    const send = requestsFor('net.fetch').filter((r) => String(r.payload.url).includes('send_group_message') && !String(r.payload.url).includes('_reaction'));
    expect(send, 'no reply was sent to the group').toHaveLength(1);
    const body = JSON.parse(send[0].payload.body);
    expect(body.group_id).toBe(10086);
    expect(body.message[0]).toEqual({ type: 'reply', data: { message_seq: 7 } });
    expect(body.message[1]).toEqual({ type: 'text', data: { text: '晴，26 度。' } });
    expect(send[0].payload.headers.authorization).toBeUndefined();
    expect(send[0].payload.headers['content-type']).toBe('application/json');

    // The exchange is remembered per group, with the speaker named.
    const hist = requestsFor('storage.set').filter((r) => r.payload.key === 'history/10086');
    expect(hist).toHaveLength(1);
    const turns = JSON.parse(hist[0].payload.value);
    expect(turns).toHaveLength(2);
    expect(turns[0].text).toBe('小明：今天天气怎么样');
    expect(turns[1]).toEqual({ role: 'assistant', text: '晴，26 度。' });
  });

  test('a message that does not address the bot is ignored', async () => {
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage());
    expect(requestsFor('llm.chat')).toHaveLength(0);
    // Nothing was said into the group. (The login-info probe on connect also goes
    // through net.fetch, so the assertion is about the send endpoint.)
    expect(
      requestsFor('net.fetch').filter((r) => String(r.payload.url).includes('send_group_message') && !String(r.payload.url).includes('_reaction')),
    ).toHaveLength(0);
  });

  test("the bot's own messages never trigger it", async () => {
    // Yogurt reports the bot's own messages (`reportSelfMessage`), so without this
    // guard every answer would be answered - for ever.
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(
      groupMessage({ senderID: 90001, segments: [mention(), { type: 'text', data: { text: '我说的' } }] }),
    );
    expect(requestsFor('llm.chat')).toHaveLength(0);
  });

  test('private messages are out of scope', async () => {
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    const friend = JSON.stringify({
      event_type: 'message_receive',
      self_id: 90001,
      data: {
        message_scene: 'friend',
        peer_id: 1234,
        message_seq: 1,
        sender_id: 1234,
        segments: [mention(), { type: 'text', data: { text: '在吗' } }],
      },
    });
    await deliver(friend);
    expect(requestsFor('llm.chat')).toHaveLength(0);
  });

  test('the group allow-list is honoured', async () => {
    await bootBot({ values: { groupAllow: '12345' } });
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '你好' } }] }));
    expect(requestsFor('llm.chat')).toHaveLength(0);
  });

  // --- the three tiers of "when does it speak" -------------------------------
  //
  // These four cases are the whole reason `replyChance` exists. Before it the
  // setting was binary: `atOnly` on meant "only when addressed", off meant "answer
  // every single message", and there was nothing in between - so "join in
  // occasionally" was impossible to ask for.

  test('with atOnly off and chance 100, an unaddressed message is answered', async () => {
    await bootBot({ values: { atOnly: 'false', replyChance: '100' } });
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage());
    expect(requestsFor('llm.chat')).toHaveLength(1);
  });

  test('with atOnly off and chance 0, an unaddressed message is ignored', async () => {
    await bootBot({ values: { atOnly: 'false', replyChance: '0' } });
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage());
    expect(requestsFor('llm.chat')).toHaveLength(0);
  });

  test('atOnly still wins over a chance of 100: a mention is required', async () => {
    await bootBot({ values: { atOnly: 'true', replyChance: '100' } });
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage());
    expect(requestsFor('llm.chat'), 'atOnly must refuse even at 100%').toHaveLength(0);
  });

  test('a mention is answered even when the chance is 0', async () => {
    await bootBot({ values: { atOnly: 'false', replyChance: '0' } });
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '在吗' } }] }));
    expect(requestsFor('llm.chat')).toHaveLength(1);
  });

  test('proactive: a random draw produces a line nobody asked for', async () => {
    // Fake timers because the feature IS a timer, and `Math.random` because the
    // hazard draw is the feature too: fixing it high means "this tick fires", which
    // is what makes the assertion about the prompt and the send rather than about
    // the odds.
    vi.useFakeTimers();
    try {
      vi.spyOn(Math, 'random').mockReturnValue(0.0001);
      await bootBot({ values: { proactiveMinutes: '1' } });
      hostEmits('ws.state', { state: 'open' });
      await pump();
      // Someone talks in the group without addressing the bot: that is what makes
      // the room "alive" enough to join.
      await deliver(groupMessage());

      await vi.advanceTimersByTimeAsync(61_000);
      await pump();

      const chat = requestsFor('llm.chat');
      expect(chat.length, 'the ticker never asked the model').toBeGreaterThanOrEqual(1);
      expect(chat[0].payload.system).toContain('没有人 @ 你');
      // The model answers, and only then does the line go out - the same
      // "nothing is sent until there is something to send" rule the answering path
      // follows.
      answer(chat[0].id, { text: '这个话题我也好奇。' });
      await pump();
      // And the line goes out without a quote: there is no question to quote.
      const send = requestsFor('net.fetch').filter((r) => String(r.payload.url).includes('send_group_message') && !String(r.payload.url).includes('_reaction'));
      expect(send.length, 'no proactive line was sent').toBeGreaterThanOrEqual(1);
      const body = JSON.parse(send[0].payload.body);
      expect(body.message).toHaveLength(1);
      expect(body.message[0].type).toBe('text');
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  test('proactive: the mood tag never reaches the group', async () => {
    // The tag is a protocol between the model and this file. The answering path always
    // stripped it; the proactive path did not, so a tag the model added on its own
    // initiative would have been pasted into the group verbatim.
    vi.useFakeTimers();
    try {
      vi.spyOn(Math, 'random').mockReturnValue(0.0001);
      await bootBot({ values: { proactiveMinutes: '1' } });
      hostEmits('ws.state', { state: 'open' });
      await pump();
      await deliver(groupMessage());
      await vi.advanceTimersByTimeAsync(61_000);
      await pump();

      const chat = requestsFor('llm.chat');
      expect(chat.length, 'the ticker never asked the model').toBeGreaterThanOrEqual(1);
      answer(chat[0].id, { text: '就俩人还请假，这活量是存心的吧。〔表情:无语〕' });
      await pump();

      const send = requestsFor('net.fetch').filter((r) => String(r.payload.url).includes('send_group_message') && !String(r.payload.url).includes('_reaction'));
      const body = JSON.parse(send[send.length - 1].payload.body);
      const text = body.message
        .filter((seg) => seg.type === 'text')
        .map((seg) => seg.data.text)
        .join('');
      expect(text).toBe('就俩人还请假，这活量是存心的吧。');
      expect(text).not.toContain('表情');
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  test('proactive: no line when nobody has spoken recently', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(Math, 'random').mockReturnValue(0.0001);
      // A long average gap: with no activity at all there is nothing to join.
      await bootBot({ values: { proactiveMinutes: '5' } });
      hostEmits('ws.state', { state: 'open' });
      await pump();
      await vi.advanceTimersByTimeAsync(6 * 61_000);
      await pump();
      expect(requestsFor('llm.chat'), 'it spoke into an empty room').toHaveLength(0);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  test('the same group is not answered twice inside the cooldown', async () => {
    await bootBot({ values: { cooldownSec: '60' } });
    hostEmits('ws.state', { state: 'open' });
    await pump();
    const frame = groupMessage({ segments: [mention(), { type: 'text', data: { text: '你好' } }] });
    await deliver(frame);
    expect(requestsFor('llm.chat')).toHaveLength(1);
    answer(requestsFor('llm.chat')[0].id, { text: '嗯。' });
    await pump();

    await deliver(frame);
    expect(requestsFor('llm.chat'), 'the cooldown did not stop the second answer').toHaveLength(1);
  });

  test('prefix mode answers without a mention', async () => {
    await bootBot({ values: { atOnly: 'false', prefix: '#问' } });
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [{ type: 'text', data: { text: '#问 你是谁' } }] }));
    const chat = requestsFor('llm.chat');
    expect(chat).toHaveLength(1);
    expect(chat[0].payload.text).toBe('小明：你是谁');
  });

  test('a refusal is logged, never said into the group', async () => {
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '你好' } }] }));
    answer(requestsFor('llm.chat')[0].id, null, {
      ok: false,
      error: '「QQ 群聊插件」还没有可用的大模型配置',
    });
    await pump();
    expect(
      requestsFor('net.fetch').filter((r) => String(r.payload.url).includes('send_group_message') && !String(r.payload.url).includes('_reaction')),
    ).toHaveLength(0);
    await vi.waitFor(() => {
      const log = requestsFor('storage.set').filter((r) => r.payload.key === 'state/log');
      expect(log.slice(-1)[0].payload.value).toContain('还没有可用的大模型配置');
    });
  });

  test('previous turns are replayed, capped to the configured count', async () => {
    const stored = [];
    for (let i = 0; i < 5; i += 1) {
      stored.push({ role: 'user', text: `问 ${i}` });
      stored.push({ role: 'assistant', text: `答 ${i}` });
    }
    storageValue = JSON.stringify(stored);
    await bootBot({ values: { contextTurns: '2' } });
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '第六个' } }] }));

    const chat = requestsFor('llm.chat');
    expect(chat).toHaveLength(1);
    const history = chat[0].payload.history;
    expect(history).toHaveLength(4);
    expect(history[0].text).toBe('问 3');
    expect(history[3].text).toBe('答 4');
  });
});

// --- the socket's state ------------------------------------------------------

describe('connection state', () => {
  test('a failed connection is reported, not hidden', async () => {
    await bootBot();
    hostEmits('ws.state', { state: 'error', error: 'connection refused' });
    await pump();
    await vi.waitFor(() => {
      const status = requestsFor('storage.set').filter((r) => r.payload.key === 'state/status');
      expect(status.slice(-1)[0].payload.value).toContain('connection refused');
    });
  });

  test('an unparseable frame is ignored rather than fatal', async () => {
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver('not json');
    expect(requestsFor('llm.chat')).toHaveLength(0);
    // The bot is still alive: a later mention still works.
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '还在吗' } }] }));
    expect(requestsFor('llm.chat')).toHaveLength(1);
  });
});

// --- 启动协议端（可选）---------------------------------------------------------
//
// The bot talks to a protocol side that is a SEPARATE program, so "nothing is
// listening" is the ordinary first-run state rather than an error. These tests pin the
// four outcomes the log has to distinguish, and the two rules that make the feature
// safe: it starts at most ONE process per page, and it never starts one the user did
// not configure.

/** The last log snapshot the plugin persisted, as one string. */
function loggedText() {
  const snapshots = requestsFor('storage.set').filter((r) => r.payload.key === 'state/log');
  return snapshots.length ? String(snapshots.slice(-1)[0].payload.value) : '';
}

describe('starting the protocol side', () => {
  beforeEach(() => {
    loginInfoUnreachable = false;
    launchFails = false;
  });

  test('a reachable protocol side is never started', async () => {
    // The probe answers, so the program is running. Even with the switch on and a path
    // configured, launching again would put a second copy on the desktop.
    await bootBot({
      values: { autoStartClient: 'true', clientPath: 'E:\\lagrangeV2\\yogurt.exe' },
    });
    expect(requestsFor('process.launch')).toHaveLength(0);
    expect(requestsFor('ws.open')).toHaveLength(1);
  });

  test('a reachable protocol side needs no permission check either', async () => {
    // Without `process` granted the plugin must still connect normally: the missing
    // permission may only ever cost the auto-start, never the socket.
    await bootBot({
      granted: ['net.ws', 'net.fetch', 'storage', 'plugin.config'],
      values: { autoStartClient: 'true', clientPath: 'E:\\lagrangeV2\\yogurt.exe' },
    });
    expect(requestsFor('ws.open')).toHaveLength(1);
  });

  test('switch off: nothing is started, and the log names the switch', async () => {
    loginInfoUnreachable = true;
    await bootBot({ values: { clientPath: 'E:\\lagrangeV2\\yogurt.exe', autoStartClient: 'false' } });
    expect(requestsFor('process.launch')).toHaveLength(0);
    // The connection is still attempted: not starting the client must not stop the bot
    // from trying, because the user may have started it themselves a second ago.
    expect(requestsFor('ws.open')).toHaveLength(1);
    await vi.waitFor(() => {
      expect(loggedText()).toContain('没开启自动启动');
    });
  });

  test('switch on but no path: nothing is started, and the log says the path is empty', async () => {
    loginInfoUnreachable = true;
    await bootBot({ values: { autoStartClient: 'true', clientPath: '   ' } });
    expect(requestsFor('process.launch')).toHaveLength(0);
    await vi.waitFor(() => {
      expect(loggedText()).toContain('路径是空的');
    });
  });

  test('switch on with a path: one launch, with the arguments, before dialling', async () => {
    vi.useFakeTimers();
    try {
      loginInfoUnreachable = true;
      await bootBot({
        values: {
          autoStartClient: 'true',
          clientPath: 'E:\\lagrangeV2\\yogurt-windows-x64 (1)\\yogurt.exe',
          clientArgs: '--qq 123 --port 3000',
        },
      });

      const launch = requestsFor('process.launch');
      expect(launch).toHaveLength(1);
      expect(launch[0].payload).toEqual({
        path: 'E:\\lagrangeV2\\yogurt-windows-x64 (1)\\yogurt.exe',
        args: ['--qq', '123', '--port', '3000'],
      });
      // Not dialled yet: the program needs a moment to open its port, so the socket
      // waits for the grace period rather than burning a retry on a port nobody is
      // listening on yet.
      expect(requestsFor('ws.open')).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(2_100);
      await pump();
      expect(requestsFor('ws.open')).toHaveLength(1);
      await vi.waitFor(() => {
        expect(loggedText()).toContain('已启动协议端客户端（pid 4321）');
      });
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  test('a refused launch is logged and still followed by a connection attempt', async () => {
    launchFails = true;
    loginInfoUnreachable = true;
    await bootBot({
      values: { autoStartClient: 'true', clientPath: 'yogurt.exe' },
    });
    expect(requestsFor('process.launch')).toHaveLength(1);
    // A failed launch is not a reason to give up: the host's own sentence is logged,
    // and the socket is dialled anyway so a program the user fixes by hand connects.
    expect(requestsFor('ws.open')).toHaveLength(1);
    await vi.waitFor(() => {
      expect(loggedText()).toContain('启动客户端失败：');
    });
  });

  test('an over-long argument list is sent, and the host refuses it', async () => {
    // The plugin does not silently truncate: dropping arguments would start the program
    // with a command line nobody wrote, so the list goes out as the user typed it and
    // the host's refusal ("args 最多 32 个") is what they see.
    loginInfoUnreachable = true;
    launchFails = true;
    await bootBot({
      values: {
        autoStartClient: 'true',
        clientPath: 'E:\\lagrangeV2\\yogurt.exe',
        clientArgs: Array.from({ length: 40 }, (_, i) => `-a${i}`).join(' '),
      },
    });
    const launch = requestsFor('process.launch');
    expect(launch).toHaveLength(1);
    expect(launch[0].payload.args).toHaveLength(40);
  });
});

// --- 表情包管理（workshop）-----------------------------------------------------
//
// The bot imports stickers into storage and this card is the only human way to see and
// re-file them. What these tests pin, and why each one is not obvious from the source:
//
//   - ONLY THE CURRENT PAGE'S BYTES ARE READ. A hundred stickers is tens of megabytes of
//     base64; "render 24 by reading all 100" is the bug this stop exists for, so the
//     assertion counts the `sticker_<hash>` reads, not the pictures drawn.
//   - deleting a category never touches `sticker_<hash>`. The label goes, the picture
//     stays, and the index row moves to 未分类.
//   - a rename migrates the rows too, or every renamed sticker would reappear under the
//     old name as a "discovered" category.
//   - the four refusals (empty / duplicate / too long / the reserved name) are shared by
//     add and rename, so they are asserted on both paths.

/** Boots the market's view of the same document (no socket, storage only). */
async function bootWorkshop(ticks = 120) {
  await loadApp();
  hostSends(initFrame({ slot: 'workshop' }));
  await pump(ticks);
}

const el = (id) => document.getElementById(id);

/** 本地当天（和宿主 `llm-usage` 的 date 同一个口径：本地日，不是 UTC）。 */
function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** One index row with a predictable 8-hex hash. */
function stickerRow(i, tag) {
  return { hash: i.toString(16).padStart(8, '0'), tag, description: `第 ${i} 张` };
}

/**
 * Seeds the fake host's storage with an index, a category list and the bytes.
 *
 * `categories` is written only when given: omitting it is the first-run case, where the
 * plugin has to seed the ten categories itself.
 */
function seedLibrary({ rows = [], categories } = {}) {
  storageMap.set('media/stickers/index', JSON.stringify(rows));
  if (categories) storageMap.set('media/stickers/categories', JSON.stringify(categories));
  for (const row of rows) {
    // A PNG magic prefix, so the card's MIME sniffing is exercised for real.
    storageMap.set(`media/stickers/bytes/${row.hash}`, `iVBORw0KGgoAAAANSUhEUg${row.hash}`);
  }
}

/** Every `sticker_<hash>` key the plugin READ, in call order. */
function readByteKeys() {
  return requestsFor('storage.get')
    .map((r) => String((r.payload && r.payload.key) || ''))
    .filter((key) => key.startsWith('media/stickers/bytes/'));
}

/** The workshop's visible log (`#log`), which is where note() lands in this view. */
function workshopLog() {
  const node = el('log');
  return node ? node.textContent : '';
}

function checkBoxes() {
  return [...document.querySelectorAll('#sticker-grid .sticker-check')];
}

function cells() {
  return [...document.querySelectorAll('#sticker-grid .sticker-cell')];
}

function filterOptions() {
  return [...el('sticker-filter').options].map((option) => option.value);
}

function tick(box) {
  box.checked = true;
  box.dispatchEvent(new window.Event('change'));
}

describe('sticker library', () => {
  test('first run seeds the ten categories the vision model produces', async () => {
    // `categories` is absent, which is what a plugin installed before this feature
    // looks like. The ten names are not a preference: classifySticker offers exactly
    // these, so an empty list would describe a library nobody can filter.
    seedLibrary({ rows: [stickerRow(0, '开心')] });
    await bootWorkshop();
    expect(JSON.parse(storageMap.get('media/stickers/categories'))).toEqual([
      '开心', '无语', '疑惑', '惊讶', '点赞', '嘲笑', '委屈', '生气', '沉默', '摸鱼',
    ]);
    expect(filterOptions()).toEqual([
      '全部',
      '开心', '无语', '疑惑', '惊讶', '点赞', '嘲笑', '委屈', '生气', '沉默', '摸鱼',
      '未分类',
    ]);
  });

  test('残图：被截断的那几张能单独筛出来，摘要里报数量', async () => {
    // 1.10 时代的真实样子：156/317 张被 1 MiB 上限静默截断，看起来完全正常。
    seedLibrary({
      rows: [
        { ...stickerRow(0, '开心'), truncated: true },
        { ...stickerRow(1, '开心'), truncated: true },
        stickerRow(2, '无语'),
      ],
      categories: ['开心', '无语'],
    });
    await bootWorkshop();

    expect(el('sticker-summary').textContent).toContain('其中 2 张被截断过');
    expect(el('sticker-summary').textContent).toContain('共 3 张');
    // 「残图」作为一个视图出现在筛选里（不是分类），选它只剩那两张。
    expect(filterOptions()).toContain('__truncated__');
    el('sticker-filter').value = '__truncated__';
    el('sticker-filter').dispatchEvent(new window.Event('change'));
    await pump(20);
    expect(cells()).toHaveLength(2);
    expect(el('sticker-page').textContent).toBe('第 1 / 1 页');
    // 格子本身带标记，提示里说明"重新导入可覆盖"。
    expect(document.querySelector('.sticker-cell[data-truncated="1"]')).toBeTruthy();
  });

  test('从群历史里找回：前缀一比就认出同一张，把完整字节写回原处', async () => {
    // 残图是真图的前缀（1 MiB 处被切）。所以"同一张"的判据只能是前缀，不是整串 hash。
    const prefix = 'A'.repeat(70000);
    const full = `${prefix}${'B'.repeat(5000)}`;
    storageMap.set('media/stickers/index', JSON.stringify([
      { hash: 'aaaa1111', tag: '开心', description: '会补回来的', truncated: true },
      { hash: 'bbbb2222', tag: '无语', description: '历史里没有', truncated: true },
    ]));
    storageMap.set('media/stickers/bytes/aaaa1111', prefix);
    storageMap.set('media/stickers/bytes/bbbb2222', 'C'.repeat(70000));
    storageMap.set('state/groups', JSON.stringify([{ id: '10086', name: '测试群', count: 1, lastAt: 1 }]));
    historyAvailable = true;
    historyMessages = [{
      segments: [{ type: 'image', data: { temp_url: 'http://img.example/full.png' } }],
    }];
    imageByUrl.set('http://img.example/full.png', full);

    await bootWorkshop();
    el('sticker-filter').value = '__truncated__';
    el('sticker-filter').dispatchEvent(new window.Event('change'));
    await pump(20);
    el('sticker-recover-truncated').click();
    await pump(120);

    // 认出来的那张：字节换成完整的，标记清掉（key 没变 —— 描述、分类、使用次数都还在）。
    expect(storageMap.get('media/stickers/bytes/aaaa1111')).toBe(full);
    const index = JSON.parse(storageMap.get('media/stickers/index'));
    const fixedRow = index.find((row) => row.hash === 'aaaa1111');
    expect(fixedRow.truncated).toBeUndefined();
    expect(fixedRow.tag).toBe('开心');
    expect(fixedRow.description).toBe('会补回来的');
    // 认不出来的那张原样留着，用户可以再决定删不删。
    expect(index.find((row) => row.hash === 'bbbb2222').truncated).toBe(true);
    expect(storageMap.get('media/stickers/bytes/bbbb2222')).toBe('C'.repeat(70000));
    expect(el('sticker-status').textContent).toContain('补回 1 张');
    expect(el('sticker-status').textContent).toContain('还剩 1 张');
  });

  test('协议端没有历史接口时如实说，而不是假装找过', async () => {
    storageMap.set('media/stickers/index', JSON.stringify([
      { hash: 'aaaa1111', tag: '开心', description: '残', truncated: true },
    ]));
    storageMap.set('media/stickers/bytes/aaaa1111', 'A'.repeat(70000));
    storageMap.set('state/groups', JSON.stringify([{ id: '10086', name: '测试群', count: 1, lastAt: 1 }]));
    historyAvailable = false;
    await bootWorkshop();
    el('sticker-filter').value = '__truncated__';
    el('sticker-filter').dispatchEvent(new window.Event('change'));
    await pump(20);
    el('sticker-recover-truncated').click();
    await pump(120);
    expect(el('sticker-status').textContent).toContain('没有提供群历史接口');
  });

  test('删除残图：两下确认、删掉索引行与字节文件，正常图不受影响', async () => {
    seedLibrary({
      rows: [
        { ...stickerRow(0, '开心'), truncated: true },
        { ...stickerRow(1, '开心'), truncated: true },
        stickerRow(2, '无语'),
      ],
      categories: ['开心', '无语'],
    });
    await bootWorkshop();
    el('sticker-filter').value = '__truncated__';
    el('sticker-filter').dispatchEvent(new window.Event('change'));
    await pump(20);

    // 第一下只是"确认"，不删东西 —— 沙箱 iframe 里没有 confirm()，只能这么做。
    el('sticker-purge-truncated').click();
    await pump(10);
    expect(el('sticker-purge-truncated').textContent).toContain('确认删除这 2 张');
    expect(JSON.parse(storageMap.get('media/stickers/index'))).toHaveLength(3);

    el('sticker-purge-truncated').click();
    await pump(30);

    const index = JSON.parse(storageMap.get('media/stickers/index'));
    expect(index).toHaveLength(1);
    expect(index[0].hash).toBe('00000002');
    // 字节也跟着删了，不然只是索引干净、盘上还留着。
    expect(storageMap.has('media/stickers/bytes/00000000')).toBe(false);
    expect(storageMap.has('media/stickers/bytes/00000001')).toBe(false);
    expect(storageMap.get('media/stickers/bytes/00000002')).toBeTruthy();
    expect(el('sticker-status').textContent).toContain('已删除 2 张残图');
  });

  test('残图视图之外看不到「删除残图」按钮', async () => {
    seedLibrary({ rows: [{ ...stickerRow(0, '开心'), truncated: true }], categories: ['开心'] });
    await bootWorkshop();
    expect(el('sticker-purge-row').hidden).toBe(true);
    el('sticker-filter').value = '__truncated__';
    el('sticker-filter').dispatchEvent(new window.Event('change'));
    await pump(20);
    expect(el('sticker-purge-row').hidden).toBe(false);
  });

  test('旧上限时代的残图（正好 1 MiB 的 base64）会被自动标出来', async () => {
    // 1.12 之前没有 truncated 字段，宿主也不说自己截断了。1,398,104 就是 1 MiB 的 base64，
    // 真机上 317 张里有 156 张正好是这个长度。
    const cap = 1_398_104;
    storageMap.set('media/stickers/index', JSON.stringify([
      { hash: 'aaaa1111', tag: '开心', description: '被切过的动图' },
      { hash: 'bbbb2222', tag: '无语', description: '正常的一张' },
    ]));
    storageMap.set('media/stickers/bytes/aaaa1111', 'A'.repeat(cap));
    storageMap.set('media/stickers/bytes/bbbb2222', 'R0lGODlhAQAB');
    await bootWorkshop();

    const index = JSON.parse(storageMap.get('media/stickers/index'));
    expect(index.find((row) => row.hash === 'aaaa1111').truncated).toBe(true);
    expect(index.find((row) => row.hash === 'bbbb2222').truncated).toBeUndefined();
    // 工坊据此报数量、给出筛选。
    expect(el('sticker-summary').textContent).toContain('其中 1 张被截断过');
    expect(filterOptions()).toContain('__truncated__');
  });

  test('工坊改分类时不会抹掉机器人写的字段（使用次数/关键词/截断标记）', async () => {
    // 真机上会撞到的：工坊只认 hash/tag/description，改个分类就把整份索引写回去，
    // 于是 usageCount 归零 → "优先挑没发过的"永远挑同一张，残图标记也一起消失。
    seedLibrary({
      rows: [{
        hash: '0a0a0a0a',
        tag: '开心',
        description: '笑',
        keywords: ['笑', '乐'],
        usageCount: 7,
        truncated: true,
        collected: true,
      }],
      categories: ['开心', '无语'],
    });
    await bootWorkshop();

    el('sticker-new-name').value = '摸鱼';
    el('sticker-add').click();
    await pump(20);

    const row = JSON.parse(storageMap.get('media/stickers/index'))[0];
    expect(row.usageCount, '使用次数被抹掉了').toBe(7);
    expect(row.keywords).toEqual(['笑', '乐']);
    expect(row.truncated).toBe(true);
    expect(row.collected).toBe(true);
  });

  test('没有残图时，筛选里不出现「残图」这一项', async () => {
    seedLibrary({ rows: [stickerRow(0, '开心')], categories: ['开心'] });
    await bootWorkshop();
    expect(filterOptions()).not.toContain('__truncated__');
    expect(el('sticker-summary').textContent).not.toContain('被截断过');
  });

  test('状态卡显示今日模型用量（宿主写的 llm-usage）', async () => {
    storageMap.set('llm-usage', JSON.stringify({
      date: todayKey(),
      requests: 12,
      promptTokens: 24000,
      completionTokens: 6000,
    }));
    await bootWorkshop();
    const facts = el('facts').textContent;
    expect(facts).toContain('今日模型');
    expect(facts).toContain('12 次调用');
    expect(facts).toContain('30.0K tokens');
    // 每次约 2500 tokens —— 这个数字就是"一次回答值多少钱"。
    expect(facts).toContain('每次约 2500');
    // 上限也要显示：宿主按 `llmDailyBudget` 拦，插件没声明这一项时是"不限"。
    expect(facts).toContain('上限 300 次');
  });

  test('每日上限设成 0 时显示"不限次数"（宿主那边 budget<=0 就是不拦）', async () => {
    // config.get 回的就是 bootValues，所以这两条用例靠 bootBot 的值来切上限。
    storageMap.set('llm-usage', JSON.stringify({
      date: todayKey(),
      requests: 5,
      promptTokens: 1000,
      completionTokens: 200,
    }));
    bootValues = { llmDailyBudget: '0' };
    await loadApp();
    hostSends(initFrame({ slot: 'workshop', granted: ALL_GRANTED }));
    await pump(120);
    expect(el('facts').textContent).toContain('不限次数');
  });

  test('用量是昨天的就不显示（宿主的计数按本地日翻滚）', async () => {
    storageMap.set('llm-usage', JSON.stringify({
      date: '2000-01-01',
      requests: 12,
      promptTokens: 24000,
      completionTokens: 6000,
    }));
    await bootWorkshop();
    expect(el('facts').textContent).not.toContain('今日模型');
  });

  test('新增分类: trimmed, persisted once, and offered everywhere afterwards', async () => {
    seedLibrary({ rows: [stickerRow(0, '开心')], categories: ['开心', '无语'] });
    await bootWorkshop();

    el('sticker-new-name').value = '  摸鱼  ';
    el('sticker-add').click();
    await pump(8);

    expect(JSON.parse(storageMap.get('media/stickers/categories'))).toEqual(['开心', '无语', '摸鱼']);
    expect(filterOptions()).toContain('摸鱼');
    expect(
      document.querySelector('#sticker-categories [data-category="摸鱼"] [data-action="delete"]'),
      'the new category is not an ordinary, removable one',
    ).toBeTruthy();
    expect(el('sticker-status').textContent).toContain('已新增分类「摸鱼」');
    expect(workshopLog()).toContain('新增表情包分类「摸鱼」');
    // The box is cleared, so the next name can be typed straight away.
    expect(el('sticker-new-name').value).toBe('');
  });

  test('新增分类 refuses empty, duplicate, over-long and the reserved name', async () => {
    seedLibrary({ rows: [], categories: ['开心', '无语'] });
    await bootWorkshop();
    const before = storageMap.get('media/stickers/categories');
    const cases = [
      ['', '分类名不能为空'],
      ['    ', '分类名不能为空'],
      ['开心', '已经存在'],
      ['一二三四五六七八九十一二三', '最多 12 个字符'],
      ['未分类', '内建分类'],
    ];
    for (const [value, message] of cases) {
      el('sticker-new-name').value = value;
      el('sticker-add').click();
      await pump(6);
      expect(storageMap.get('media/stickers/categories'), `「${value}」was written through`).toBe(before);
      expect(el('sticker-status').textContent, `no refusal for 「${value}」`).toContain(message);
    }
    expect(filterOptions()).toEqual(['全部', '开心', '无语', '未分类']);
  });

  test('改名 migrates the index rows and keeps the bytes', async () => {
    seedLibrary({
      rows: [stickerRow(0, '无语'), stickerRow(1, '无语'), stickerRow(2, '开心')],
      categories: ['开心', '无语'],
    });
    await bootWorkshop();

    document.querySelector('#sticker-categories [data-action="rename"][data-category="无语"]').click();
    await pump(4);
    const input = document.querySelector('#sticker-categories .cat-input');
    expect(input, 'the rename box did not open').toBeTruthy();
    expect(input.value).toBe('无语');

    input.value = '尴尬';
    document.querySelector('#sticker-categories [data-action="rename-save"]').click();
    await pump(10);

    expect(JSON.parse(storageMap.get('media/stickers/categories'))).toEqual(['开心', '尴尬']);
    // Both halves of the rename: the list AND the rows. Without the second the two
    // stickers would drift back as a "discovered" 无语 category.
    expect(JSON.parse(storageMap.get('media/stickers/index')).map((row) => row.tag)).toEqual([
      '尴尬', '尴尬', '开心',
    ]);
    expect(filterOptions()).toContain('尴尬');
    expect(filterOptions()).not.toContain('无语');
    // The pictures were neither removed nor rewritten.
    expect(requestsFor('storage.remove')).toHaveLength(0);
    expect(
      requestsFor('storage.set')
        .map((r) => String(r.payload.key))
        .filter((key) => key.startsWith('media/stickers/bytes/')),
    ).toEqual([]);
    expect(workshopLog()).toContain('表情包分类「无语」已改名为「尴尬」，2 张随之迁移');
  });

  test('改名 refuses a duplicate and the built-in name', async () => {
    seedLibrary({ rows: [stickerRow(0, '无语')], categories: ['开心', '无语'] });
    await bootWorkshop();

    document.querySelector('#sticker-categories [data-action="rename"][data-category="无语"]').click();
    await pump(4);
    const input = document.querySelector('#sticker-categories .cat-input');
    input.value = '开心';
    document.querySelector('#sticker-categories [data-action="rename-save"]').click();
    await pump(8);
    expect(el('sticker-status').textContent).toContain('已经存在');
    expect(JSON.parse(storageMap.get('media/stickers/categories'))).toEqual(['开心', '无语']);
    expect(JSON.parse(storageMap.get('media/stickers/index'))[0].tag).toBe('无语');

    input.value = '未分类';
    document.querySelector('#sticker-categories [data-action="rename-save"]').click();
    await pump(8);
    expect(el('sticker-status').textContent).toContain('内建分类');
    expect(JSON.parse(storageMap.get('media/stickers/categories'))).toEqual(['开心', '无语']);
  });

  test('删除分类 re-files its stickers under 未分类 and deletes no bytes', async () => {
    seedLibrary({
      rows: [stickerRow(0, '无语'), stickerRow(1, '无语'), stickerRow(2, '无语'), stickerRow(3, '开心')],
      categories: ['开心', '无语'],
    });
    const bytesBefore = new Map(
      [...storageMap].filter(([key]) => key.startsWith('media/stickers/bytes/')),
    );
    await bootWorkshop();

    document.querySelector('#sticker-categories [data-action="delete"][data-category="无语"]').click();
    await pump(12);

    expect(JSON.parse(storageMap.get('media/stickers/categories'))).toEqual(['开心']);
    expect(JSON.parse(storageMap.get('media/stickers/index')).map((row) => row.tag)).toEqual([
      '未分类', '未分类', '未分类', '开心',
    ]);
    // THE POINT OF THIS TEST: a label was removed, not a picture.
    expect(requestsFor('storage.remove'), 'a category delete removed a storage key').toHaveLength(0);
    expect(
      requestsFor('storage.set')
        .map((r) => String(r.payload.key))
        .filter((key) => key.startsWith('media/stickers/bytes/')),
      'a category delete wrote a sticker byte key',
    ).toEqual([]);
    for (const [key, value] of bytesBefore) {
      expect(storageMap.get(key), `${key} was dropped`).toBe(value);
    }
    expect(workshopLog()).toContain('表情包分类「无语」已删除，3 张归入未分类');

    // The pictures are still reachable: they are in the built-in bucket.
    el('sticker-filter').value = '未分类';
    el('sticker-filter').dispatchEvent(new window.Event('change'));
    await pump(20);
    expect(cells()).toHaveLength(3);
    expect(document.querySelector('#sticker-grid img.sticker-thumb').getAttribute('src'))
      .toMatch(/^data:image\/png;base64,/);
  });

  test('the built-in 未分类 cannot be renamed or deleted', async () => {
    seedLibrary({ rows: [stickerRow(0, '开心')], categories: ['开心'] });
    await bootWorkshop();

    const builtin = document.querySelector('#sticker-categories [data-category="未分类"]');
    expect(builtin).toBeTruthy();
    expect(builtin.querySelector('[data-action="delete"]')).toBeNull();
    expect(builtin.querySelector('[data-action="rename"]')).toBeNull();
    expect(builtin.textContent).toContain('内建');
    expect(el('sticker-categories').textContent).toContain('未分类');
  });

  test('批量移动: ticked stickers move in ONE index write', async () => {
    seedLibrary({
      rows: [stickerRow(0, '开心'), stickerRow(1, '开心'), stickerRow(2, '开心'), stickerRow(3, '开心')],
      categories: ['开心', '摸鱼'],
    });
    await bootWorkshop();
    expect(cells()).toHaveLength(4);

    tick(checkBoxes()[1]);
    tick(checkBoxes()[3]);
    await pump(4);
    expect(el('sticker-selected').textContent).toContain('已选 2 张');

    el('sticker-move-target').value = '摸鱼';
    el('sticker-move-target').dispatchEvent(new window.Event('change'));
    const writesBefore = requestsFor('storage.set').filter((r) => r.payload.key === 'media/stickers/index').length;
    el('sticker-move').click();
    await pump(12);

    const writes = requestsFor('storage.set').filter((r) => r.payload.key === 'media/stickers/index');
    expect(writes.length - writesBefore, 'the batch was not written exactly once').toBe(1);
    expect(JSON.parse(storageMap.get('media/stickers/index')).map((row) => row.tag)).toEqual([
      '开心', '摸鱼', '开心', '摸鱼',
    ]);
    // The selection is consumed, so a second click cannot move the same pictures again.
    expect(el('sticker-selected').textContent).toBe('未选中');
    expect(workshopLog()).toContain('已把 2 张表情包移到「摸鱼」');
  });

  test('分页: only the current page of bytes is read', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => stickerRow(i, '开心'));
    seedLibrary({ rows, categories: ['开心'] });
    await bootWorkshop();

    expect(cells(), 'page one is not 24 cells').toHaveLength(24);
    expect(el('sticker-page').textContent).toBe('第 1 / 2 页');
    expect(el('sticker-summary').textContent).toContain('共 30 张');
    const pageOne = rows.slice(0, 24).map((row) => `media/stickers/bytes/${row.hash}`);
    expect(readByteKeys().sort()).toEqual([...pageOne].sort());
    expect(document.querySelector('#sticker-grid img.sticker-thumb').getAttribute('src'))
      .toMatch(/^data:image\/png;base64,/);

    el('sticker-next').click();
    await pump(60);

    expect(cells(), 'page two is not the remaining six').toHaveLength(6);
    expect(el('sticker-page').textContent).toBe('第 2 / 2 页');
    const pageTwo = rows.slice(24).map((row) => `media/stickers/bytes/${row.hash}`);
    // The six new keys, and NOT a re-read of page one.
    expect(readByteKeys().sort()).toEqual([...pageOne, ...pageTwo].sort());
    expect(new Set(readByteKeys()).size).toBe(readByteKeys().length);
  });

  test('a tag only the index knows is listed as an ordinary category', async () => {
    // This is the "分类漂移" guard: the vision model still produces 无语 after a human
    // deleted it from the list, so the pictures must not become invisible.
    seedLibrary({
      rows: [stickerRow(0, '无语'), stickerRow(1, '开心')],
      categories: ['开心'],
    });
    await bootWorkshop();

    expect(filterOptions()).toEqual(['全部', '开心', '无语', '未分类']);
    const row = document.querySelector('#sticker-categories [data-category="无语"]');
    expect(row, 'the discovered tag has no category row').toBeTruthy();
    expect(row.querySelector('[data-action="delete"]')).toBeTruthy();
    expect(row.querySelector('[data-action="rename"]')).toBeTruthy();
    expect(row.textContent).toContain('1 张');

    // And it filters: the sticker under it is reachable.
    el('sticker-filter').value = '无语';
    el('sticker-filter').dispatchEvent(new window.Event('change'));
    await pump(20);
    expect(cells()).toHaveLength(1);
  });

  test('an empty library renders nothing, and says so', async () => {
    seedLibrary({ rows: [], categories: ['开心'] });
    await bootWorkshop();
    expect(cells()).toHaveLength(0);
    expect(el('sticker-empty').hidden).toBe(false);
    expect(el('sticker-page').textContent).toBe('第 1 / 1 页');
    expect(el('sticker-prev').disabled).toBe(true);
    expect(el('sticker-next').disabled).toBe(true);
  });
});

// --- 日志：为什么没发表情 / 为什么引用为空 -------------------------------------
//
// Both situations used to be SILENT, which is what made "它只回复、不发图" and "引用一张
// 图问它却像在问空气" impossible to diagnose: the group saw a reply, the log saw
// nothing, and the three ways a sticker can be skipped were indistinguishable.

describe('diagnostic log lines', () => {
  /** Delivers one mention, lets the model answer with a sticker marker, and pumps. */
  async function replyOnce() {
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '在吗' } }] }));
    const chat = requestsFor('llm.chat');
    expect(chat.length, 'the model was never asked').toBeGreaterThan(0);
    answer(chat[chat.length - 1].id, { text: '在。〔表情:疑惑〕' });
    await pump(40);
  }

  test('a missed probability is in the log', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    await bootBot({ values: { stickerChance: '50' } });
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await replyOnce();
    await vi.waitFor(() => expect(loggedText()).toContain('概率没中'));
  });

  test('an empty category is named, and only a real send starts the cooldown', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    await bootBot({
      values: { stickerChance: '100', stickerCooldownSec: '600', cooldownSec: '0' },
    });
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await replyOnce();
    await vi.waitFor(() => expect(loggedText()).toContain('图库里没有「疑惑」分类的表情'));
    // 挑不到图的那次**不**该占用冷却：否则"图库里没有这一档"会让这个群十分钟发不出任何
    // 表情，而日志只说"在冷却里"，看不出真正的原因。
    expect(loggedText()).not.toContain('还在冷却里');

    // 图库里有货之后这张发出去了 —— 这一刻才该开始算冷却。
    storageMap.set('media/stickers/index', JSON.stringify([{ hash: 'aaaa1111', tag: '疑惑', description: '歪头' }]));
    storageMap.set('media/stickers/bytes/aaaa1111', 'iVBORw0KGgoAAAANSUhEUg');
    await replyOnce();
    await vi.waitFor(() => expect(loggedText()).toContain('发了一张表情'));
    await replyOnce();
    // 冷却那一行带着"还要等几秒"，这是用户真正想知道的数字。
    await vi.waitFor(() => expect(loggedText()).toMatch(/还在冷却里，还要等 \d+ 秒/));
  });

  test('an unfetchable quote reads as an expected limit, not as an error', async () => {
    getMessageFails = true;
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(
      groupMessage({
        segments: [
          { type: 'reply', data: { message_seq: 5, sender_name: '小明' } },
          mention(),
          { type: 'text', data: { text: '这张图是什么' } },
        ],
      }),
    );
    await vi.waitFor(() => {
      const text = loggedText();
      expect(text).toContain('引用内容取不到（协议端只能读到启动之后的消息），按无引用处理：');
      expect(text).toContain('Message not found');
    });
  });
});

// --- 群聊手感：提示词与发送前的清理 -------------------------------------------
//
// The parts of "it should not read like a bot" that are testable without a model:
// whether the prompt can see WHO is talking, what happens when the model answers with
// nothing at all, and how an action written in asterisks reaches the group. All three
// were found by replaying real group conversations against the live model - none of
// them shows up in a unit test of the parser.

describe('group-chat tone', () => {
  /** The text a group would actually read, joined from the last send. */
  function sentText() {
    const send = requestsFor('net.fetch').filter((r) => String(r.payload.url).includes('send_group_message') && !String(r.payload.url).includes('_reaction'));
    const body = JSON.parse(send[send.length - 1].payload.body);
    return body.message
      .filter((seg) => seg.type === 'text')
      .map((seg) => seg.data.text)
      .join('');
  }

  test('the current question names its speaker, exactly as the history does', async () => {
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '在吗' } }] }));

    const chat = requestsFor('llm.chat');
    expect(chat[0].payload.text).toBe('小明：在吗');
    answer(chat[0].id, { text: '在。' });
    await pump();

    // The remembered turn must be byte-identical to the asked turn, or the next question
    // replays a conversation where the names do not line up.
    const hist = requestsFor('storage.set').filter((r) => r.payload.key === 'history/10086');
    const turns = JSON.parse(hist[hist.length - 1].payload.value);
    expect(turns[0].text).toBe('小明：在吗');
  });

  test('an empty answer is asked once more instead of leaving the group silent', async () => {
    // A reasoning model can spend the whole token budget on reasoning and return an
    // empty content with finish_reason "stop" (seen live on qwen3.8-27b). Silence is the
    // one outcome nobody can tell apart from a broken bot.
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '在吗' } }] }));
    expect(requestsFor('llm.chat')).toHaveLength(1);

    answer(requestsFor('llm.chat')[0].id, { text: '' });
    await pump();
    const chat = requestsFor('llm.chat');
    expect(chat, 'the empty answer was not retried').toHaveLength(2);

    answer(chat[1].id, { text: '在。' });
    await pump();
    expect(sentText()).toBe('在。');
    await vi.waitFor(() => expect(loggedText()).toContain('回复是空的，重试一次'));
  });

  test('the system prompt carries the brevity rules and the directive protocol', async () => {
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '在吗' } }] }));
    const system = requestsFor('llm.chat')[0].payload.system;

    // "硬上限，不是目标": the old wording ("回答控制在 N 字以内") was read as a quota, and a
    // 300-字 answer to "中午吃啥" is what a helpdesk does.
    expect(system).toContain('是硬上限，不是目标');
    expect(system).toContain('不要重复上一条回复里用过的开头、口癖和句式');
    expect(system).toContain('emoji');
    // 1.12 的协议：正文 + 尾部 ```json 围栏（meme / remember / silent）。平台没有
    // response_format，所以这段约定就是"一次调用干完回复+记忆+表情"的全部依据。
    // 而且必须是**命令式**的："可选"的措辞在真机上被模型整段忽略过（记忆一直是空的）。
    expect(system).toContain('```json');
    expect(system).toContain('必须');
    expect(system).toContain('"meme"');
    expect(system).toContain('"remember"');
    expect(system).toContain('{}');
    expect(system).toContain('{"silent":true}');
    // 人设：没配置时是"群里的老熟人"，而且绝不能自称机器人（一自称就出戏）。
    expect(system).toContain('老熟人');
    expect(system).not.toContain('机器人');
  });

  test('a written persona replaces the default one entirely', async () => {
    await bootBot({ values: { persona: '你是隔壁那只猫。' } });
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '在吗' } }] }));
    const system = requestsFor('llm.chat')[0].payload.system;
    expect(system.startsWith('你是隔壁那只猫。')).toBe(true);
    expect(system).not.toContain('老熟人');
  });

  test('an action written in asterisks reaches the group in brackets', async () => {
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '胖了？' } }] }));
    answer(requestsFor('llm.chat')[0].id, { text: '*甩了下尾巴*才不是胖。' });
    await pump();
    // Deleting the asterisks used to leave a bare "甩了下尾巴" hanging in the message: a
    // stage direction that lost its brackets, which nobody types in a group.
    expect(sentText()).toBe('（甩了下尾巴）才不是胖。');
  });
});

// --- 数据目录（升级时的整理）---------------------------------------------------
//
// 1.11 起插件的私有目录按数据类型分了文件夹（state/、history/、stickers/、video/）。
// 1.10 及以前每个键就是根目录里的一个文件名，所以升级必须**把老文件搬过去**，而且要
// 满足三条：
//
//   - 记忆不能丢：群的历史、表情包的字节和索引都得跟着走，否则用户升级后看到的是
//     "机器人失忆了、图库空了"；
//   - 只搬一次：标记文件挡住后续启动，否则每次启动都要为三百个文件问一次；
//   - 搬不动就退回旧名字：桌宠没跟着升级时，带斜杠的键会被宿主顶回来，此时插件必须
//     按 1.10 的方式继续工作，而不是把数据写到一半就报错。

describe('数据目录', () => {
  /** Seeds the fake host with exactly what a 1.10 install has on disk. */
  function seedFlatInstall() {
    layoutMigrated = false;
    storageMap.set('status', JSON.stringify({ state: 'open', selfID: '90001' }));
    storageMap.set('log', JSON.stringify(['旧日志']));
    storageMap.set('groups', JSON.stringify([{ id: '10086', name: '群', count: 2, lastAt: 5 }]));
    storageMap.set('stickers', JSON.stringify([
      { hash: '0a0a0a0a', tag: '开心', description: '第一张' },
      { hash: '0b0b0b0b', tag: '无语', description: '第二张' },
    ]));
    storageMap.set('categories', JSON.stringify(['开心', '无语']));
    storageMap.set('bilivideo-files', JSON.stringify([{ key: 'bilivideoabc', at: 1 }]));
    storageMap.set('sticker_0a0a0a0a', 'iVBORw0KGgoAAAANSUhEUg0a0a');
    storageMap.set('sticker_0b0b0b0b', 'iVBORw0KGgoAAAANSUhEUg0b0b');
    storageMap.set('hist_10086', JSON.stringify([{ role: 'user', text: '在吗' }]));
    // A value the host itself manages, from the same era.
    storageMap.set('share-bili-jobs', JSON.stringify([{ id: 'old' }]));
  }

  test('1.10 的平铺文件被搬进各自的文件夹，一个字节都不丢', async () => {
    seedFlatInstall();
    await bootBot();
    // The migration moves one file per round trip (a rename, not a copy), so the pump has
    // to run long enough for the whole batch plus the socket handshake behind it.
    await pump(60);

    // 索引、分类、群索引和产物清单都在新的位置，而且内容还是原来的。
    expect(JSON.parse(storageMap.get('media/stickers/index')).map((row) => row.tag)).toEqual(['开心', '无语']);
    expect(JSON.parse(storageMap.get('media/stickers/categories'))).toEqual(['开心', '无语']);
    expect(JSON.parse(storageMap.get('state/groups'))[0].id).toBe('10086');
    // 账本里的旧名字被改成了新位置：`bilivideoabc` 在 1.10 指的正是根目录里的那个文件。
    expect(JSON.parse(storageMap.get('state/video'))[0].key).toBe('media/video/bilivideoabc');
    // `state/status` and `state/log` are LIVE: the bot rewrites them on its first note, so
    // what is asserted there is that they moved at all (below), not what they hold.

    // 表情包的字节按 hash 各就各位 —— 这是两百多个文件的那一批。
    expect(storageMap.get('media/stickers/bytes/0a0a0a0a')).toBe('iVBORw0KGgoAAAANSUhEUg0a0a');
    expect(storageMap.get('media/stickers/bytes/0b0b0b0b')).toBe('iVBORw0KGgoAAAANSUhEUg0b0b');

    // 群记忆跟着群号走：升级不该让机器人「失忆」。
    expect(JSON.parse(storageMap.get('history/10086'))[0].text).toBe('在吗');

    // 旧的平铺文件名一个都不剩，否则同一个值会有两个位置，读哪个都是运气。
    for (const stale of ['status', 'log', 'groups', 'stickers', 'categories', 'bilivideo-files',
      'sticker_0a0a0a0a', 'sticker_0b0b0b0b', 'hist_10086']) {
      expect(storageMap.has(stale), `${stale} 还留在根目录`).toBe(false);
    }
    // 宿主自己的托盘文件不归插件管：它有自己的兼容路径，插件既不读也不搬。
    expect(storageMap.has('share-bili-jobs')).toBe(true);

    // 标记写下了，搬了几个也记着。
    expect(JSON.parse(storageMap.get('state/layout')).version).toBe('2');
    // 状态与日志这两份"活"文件也被搬了：新位置有内容，旧位置没有。
    expect(storageMap.has('state/status')).toBe(true);
    expect(storageMap.has('state/log')).toBe(true);
    // 而且机器人照常连上了协议端：整理不能挡住工作。
    expect(requestsFor('ws.open')).toHaveLength(1);
  });

  test('第二次启动只查一个标记，不再搬任何东西', async () => {
    seedFlatInstall();
    await bootBot();
    await pump(60);
    expect(requestsFor('storage.move').length, '第一次启动没有搬任何东西').toBeGreaterThan(0);

    // 同一个目录、同一个标记，重新加载文档 = 又一次启动。请求日志按"这一份文档"重新算，
    // 所以这里断言的是第二次启动**自己**一次 move 都没发。
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    await pump(40);
    expect(requestsFor('storage.move'), '第二次启动又搬了文件').toHaveLength(0);
    // 它确实去看了标记，而不是跳过了这一步。
    const stats = requestsFor('storage.stat').map((r) => String((r.payload && r.payload.key) || ''));
    expect(stats).toContain('state/layout');
  });

  test('桌宠还是 1.10（拒绝子目录键）时退回旧名字，数据不写到一半', async () => {
    // 老宿主的 storage.stat 只认平铺键：带斜杠就被顶回来。
    storageMap.set('stickers', JSON.stringify([{ hash: '0a0a0a0a', tag: '开心', description: '' }]));
    hostRefusesSubfolders = true;
    await bootBot();

    // 没有一次搬迁，也没有一次带斜杠的写入 —— 全部退回 1.10 的键名。
    expect(requestsFor('storage.move')).toHaveLength(0);
    const written = requestsFor('storage.set').map((r) => String((r.payload && r.payload.key) || ''));
    expect(written.some((key) => key.includes('/'))).toBe(false);
    // 日志说清了要修什么，而不是只说"失败了"。
    const log = requestsFor('storage.set')
      .filter((r) => r.payload.key === 'log')
      .map((r) => String(r.payload.value))
      .join('\n');
    expect(log).toContain('升级到 1.11');
  });

  test('没人记账的旧视频产物被收进 media/video，等账本收走', async () => {
    seedFlatInstall();
    // 1.10 留下的两种形状：成品 `bilivideo<stamp>`、中间流 `bili<stamp>v`。账本里都没
    // 有它们 —— 真机上正是这样躺了 48 MB，而插件连"目录里有什么"都问不出来。
    storageMap.set('bilivideozz9', 'x'.repeat(100));
    storageMap.set('bilizz9v', 'x'.repeat(50));
    // 一个"名字有点像但并不是产物"的文件：扫错就是删别人的东西，所以必须原地不动。
    storageMap.set('bili-settings', 'keep me');
    await bootBot();
    await pump(90);

    expect(storageMap.has('media/video/bilivideozz9')).toBe(true);
    expect(storageMap.has('media/video/bilizz9v')).toBe(true);
    expect(storageMap.has('bilivideozz9')).toBe(false);
    expect(storageMap.get('bili-settings')).toBe('keep me');
    // 搬过去就必须补账，否则文件在新文件夹里住到天荒地老。
    const ledger = JSON.parse(storageMap.get('state/video')).map((entry) => entry.key);
    expect(ledger).toContain('media/video/bilivideozz9');
    // 账本里的旧名字也改成了新位置：原来那条 `bilivideoabc` 指向一个不存在的地方。
    expect(ledger).not.toContain('bilivideoabc');
    expect(ledger.every((key) => key.startsWith('media/video/'))).toBe(true);
  });

  test('群索引被 1.10 的清空 bug 弄空了，记忆照样搬过去并补回索引', async () => {
    // 真机上就是这样：1.10 每次启动都把 `groups` 写成空表，于是升级那一刻索引里一个群
    // 都没有。照着索引搬，`hist_*` 一份都不会动，用户看到的是"机器人把每个群都忘了"。
    seedFlatInstall();
    storageMap.set('groups', '[]');
    await bootBot();
    await pump(90);

    // 四份记忆跟着群号各就各位（三个来自 1.10 的文件名，不是索引）。
    expect(JSON.parse(storageMap.get('history/10086'))[0].text).toBe('在吗');
    expect(storageMap.has('hist_10086')).toBe(false);
    // 索引被补回一条：工坊的群列表和「忘掉这个群」还能看到它。
    const groups = JSON.parse(storageMap.get('state/groups'));
    const row = groups.find((entry) => entry.id === '10086');
    expect(row, '有记忆的群没有被补回索引').toBeTruthy();
    // lastAt 是 0：陈年旧群不该被主动开口当成活跃群。
    expect(row.lastAt).toBe(0);
  });

  test('升级时旧进程还在写平铺文件：合并进新位置，不覆盖、不留下第二份', async () => {
    // 真机上撞到过两次：整理干净之后根目录里又冒出 `groups` / `log` / `status`，因为桌宠
    // 内存里还是 1.10 的代码。这一条断言的是"再遇到也会被收拾干净"，而且平铺那份里
    // **新的东西不能丢**（旧进程刚记住的群名）。
    seedFlatInstall();
    await bootBot();
    await pump(90);
    expect(JSON.parse(storageMap.get('state/groups'))[0].id).toBe('10086');

    // 旧进程又写了一遍：一个已知群（带新名字）和一个新群，外加一份状态快照。
    storageMap.set('groups', JSON.stringify([
      { id: '10086', name: '改过名的群', count: 5, lastAt: 9 },
      { id: '20002', name: '后来才有的群', count: 1, lastAt: 7 },
    ]));
    storageMap.set('log', JSON.stringify(['旧进程的一行']));
    storageMap.set('status', JSON.stringify({ state: 'open' }));

    // 下一次启动（不重装、标记已在）—— 也就是每天正常的重启。
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    await pump(60);

    const groups = JSON.parse(storageMap.get('state/groups'));
    expect(groups.map((g) => g.id).sort()).toEqual(['10086', '20002']);
    expect(groups.find((g) => g.id === '10086').name).toBe('改过名的群');
    // 平铺的那几份已经没了：目录不会每次启动都重新变乱。
    for (const stale of ['groups', 'log', 'status']) {
      expect(storageMap.has(stale), `${stale} 又留在根目录了`).toBe(false);
    }
  });

  test('索引里没有的表情包字节也跟着搬，不会留在根目录', async () => {
    seedFlatInstall();
    // 索引只剩一行，但磁盘上还躺着另一张（索引被改坏/丢过的样子）。
    storageMap.set('stickers', JSON.stringify([{ hash: '0a0a0a0a', tag: '开心', description: '' }]));
    storageMap.set('sticker_0f0f0f0f', 'iVBORw0KGgoAAAANSUhEUg0f0f');
    await bootBot();
    await pump(90);

    expect(storageMap.get('media/stickers/bytes/0a0a0a0a')).toBe('iVBORw0KGgoAAAANSUhEUg0a0a');
    expect(storageMap.get('media/stickers/bytes/0f0f0f0f')).toBe('iVBORw0KGgoAAAANSUhEUg0f0f');
    expect(storageMap.has('sticker_0f0f0f0f')).toBe(false);
  });

  test('旧进程又写了一遍同名记忆/字节：留条数多的那份，而不是留两份', async () => {
    // 升级窗口里最真实的样子：新进程已经搬过，旧进程（内存里还是 1.10）又往根目录写了
    // 一份同名文件。两份并存时读哪份都是运气，所以按类型收尾。
    //
    // 记忆**不能**无脑用新写的那份：真机上旧进程因为文件已被搬走，只记得最新一轮，于是
    // 一份四轮的记忆被两句话盖掉了。条数多的赢，长度相同才用新的。
    seedFlatInstall();
    await bootBot();
    await pump(90);
    // 新位置里是一份多轮的记忆（升级前攒下来的）。
    storageMap.set('history/10086', JSON.stringify([
      { role: 'user', text: '在吗' },
      { role: 'assistant', text: '在。' },
      { role: 'user', text: '今天有点累' },
    ]));

    // 旧进程把这份记忆写短了（它只记得最新一轮），并重新写了一份字节。
    storageMap.set('hist_10086', JSON.stringify([
      { role: 'user', text: '只记得这一轮' },
    ]));
    storageMap.set('sticker_0a0a0a0a', 'iVBORw0KGgoAAAANSUhEUg0a0a');

    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    await pump(60);

    // 长的那份（新位置里的三轮）留下来了，短的被丢掉，根目录不再有第二份。
    const turns = JSON.parse(storageMap.get('history/10086'));
    expect(turns.map((t) => t.text)).toEqual(['在吗', '在。', '今天有点累']);
    expect(storageMap.has('hist_10086')).toBe(false);
    // 同一个 hash 的字节去重成一份，根目录那一份删掉。
    expect(storageMap.has('sticker_0a0a0a0a')).toBe(false);
    expect(storageMap.get('media/stickers/bytes/0a0a0a0a')).toBe('iVBORw0KGgoAAAANSUhEUg0a0a');
  });

  test('旧进程写来的记忆更全时，用它的（更长的那份赢）', async () => {
    seedFlatInstall();
    await bootBot();
    await pump(90);
    storageMap.set('hist_10086', JSON.stringify([
      { role: 'user', text: '在吗' },
      { role: 'assistant', text: '在。' },
      { role: 'user', text: '刚那句再补一轮' },
    ]));
    await loadApp();
    hostSends(initFrame({ slot: 'background' }));
    await pump(60);

    const turns = JSON.parse(storageMap.get('history/10086'));
    expect(turns.map((t) => t.text)).toContain('刚那句再补一轮');
    expect(storageMap.has('hist_10086')).toBe(false);
  });

  test('顶层文件夹与 1.10 的键名不重名（否则搬迁要靠先改名再搬回来）', () => {
    // This is the trap the layout has to stay out of, and it is not obvious: in 1.10 the
    // sticker index IS a file called `stickers`. Had the folder been `stickers/`, moving the
    // index to `stickers/index` would need the folder created first - while that very name
    // is a file - and `MkdirAll` fails. Every sticker move would fail with it, the library
    // would read back empty, and the user would see "my stickers are gone" after an upgrade.
    //
    // Read out of the source so the guard cannot drift from it.
    const legacy = ['status', 'log', 'groups', 'stickers', 'categories', 'bilivideo-files'];
    const dataBlock = /const DATA = \{([\s\S]*?)\n\};/.exec(source);
    expect(dataBlock, 'the source has no DATA table').toBeTruthy();
    const destinations = [
      ...[...dataBlock[1].matchAll(/: '([^']+)'/g)].map((m) => m[1]),
      ...[...source.matchAll(/const STICKER_BYTES_DIR = '([^']+)'/g)].map((m) => m[1]),
      ...[...source.matchAll(/const VIDEO(?:_TMP)?_DIR = '([^']+)'/g)].map((m) => m[1]),
    ];
    expect(destinations.length, 'no destination keys were found in the source').toBeGreaterThan(4);
    for (const key of destinations) {
      const top = key.split('/')[0];
      expect(legacy, `文件夹 ${top}/ 与 1.10 的键名撞车`).not.toContain(top);
      // And the layout really is a tree: every destination is at least two segments deep.
      expect(key).toContain('/');
    }
  });
});

// --- 记忆、状态与表情包目录 -----------------------------------------------------
//
// 参考项目（nonebot-plugin-aigf）的"一次调用干完回复+记忆+表情"。它们的机制是
// response_format/tools，我们没有，所以协议改成"正文 + 尾部 ```json 围栏"。这一组用例钉的
// 都是那套约定的边界：围栏剥得干净、坏 JSON 不炸、老标记仍然生效、沉默时不发消息但记忆照写。

/** 一条带尾部指令块的模型回复。 */
function fenced(text, patch) {
  return `${text}\n\`\`\`json\n${JSON.stringify(patch)}\n\`\`\``;
}

/** The text segments of the last message sent into the group (skipping sticker-only sends). */
function lastSentText() {
  const sends = requestsFor('net.fetch')
    .filter((r) => String(r.payload.url).includes('send_group_message') && !String(r.payload.url).includes('_reaction'))
    .map((r) => JSON.parse(r.payload.body))
    .map((body) => body.message.filter((seg) => seg.type === 'text').map((seg) => seg.data.text).join(''))
    .filter((text) => text !== '');
  return sends.length ? sends[sends.length - 1] : '';
}

describe('记忆与状态', () => {
  /** Boots the bot and delivers one mention, leaving the model call unanswered. */
  async function askMention({ text = '在吗', values = {}, senderID = 20001, card = '小明' } = {}) {
    await bootBot({ values });
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ senderID, card, segments: [mention(), { type: 'text', data: { text } }] }));
    const chat = requestsFor('llm.chat');
    expect(chat.length, 'the model was never asked').toBeGreaterThan(0);
    return chat[chat.length - 1];
  }

  test('围栏被剥掉：群里只看到正文，记忆同时写进去', async () => {
    const call = await askMention();
    answer(call.id, { text: fenced('在。', { remember: ['张三在准备考研'] }) });
    await pump(40);

    expect(lastSentText()).toBe('在。');
    expect(lastSentText()).not.toContain('```');
    const notes = JSON.parse(storageMap.get('memory/10086/notes'));
    expect(notes[0].text).toBe('张三在准备考研');
  });

  test('坏 JSON 不会被当成指令，也不会漏到群里', async () => {
    const call = await askMention();
    answer(call.id, { text: '在。\n```json\n{不是 JSON}\n```' });
    await pump(40);
    // 解析失败 ⇒ 当没有指令；tidyReply 仍然会把围栏从正文里清掉。
    expect(lastSentText()).toBe('在。');
    expect(storageMap.has('memory/10086/notes')).toBe(false);
  });

  test('正文里本来就有的代码块不会被误吞', async () => {
    const call = await askMention();
    answer(call.id, { text: '这样写：\n```python\nprint(1)\n```\n挺好懂的。' });
    await pump(40);
    // 最后一个围栏里的内容不是对象 ⇒ 不是指令块 ⇒ 整段仍按正文处理（围栏由 tidyReply 清掉，
    // 但句子本身要留着）。
    expect(lastSentText()).toContain('挺好懂的');
  });

  test('老标记〔表情:分类〕仍然生效', async () => {
    storageMap.set('media/stickers/index', JSON.stringify([{ hash: 'aaaa1111', tag: '开心', description: '笑' }]));
    storageMap.set('media/stickers/bytes/aaaa1111', 'R0lGODlh');
    const call = await askMention({ values: { stickerChance: '100' } });
    answer(call.id, { text: '在。〔表情:开心〕' });
    await pump(40);
    expect(lastSentText(), loggedText()).toBe('在。');
    const sent = requestsFor('net.fetch').filter((r) => String(r.payload.url).includes('send_group_message') && !String(r.payload.url).includes('_reaction'));
    const bodies = sent.map((r) => String(r.payload.body));
    expect(bodies.some((body) => body.includes('"type":"image"') && body.includes('base64://'))).toBe(true);
  });

  test('silent：一个字都不发，但记忆与能量照写', async () => {
    // 随机漂移关掉（0.5 ⇒ 偏移 0），这样能量的变化只可能来自 settle 与 model 的 delta。
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    storageMap.set('state/energy/10086', JSON.stringify({ value: 0.5, at: 1 }));
    const call = await askMention();
    answer(call.id, { text: fenced('', { silent: true, remember: ['今天这话题它不想插嘴'], energy: -0.1 }) });
    await pump(40);

    expect(lastSentText(), '沉默时不该发任何消息').toBe('');
    expect(JSON.parse(storageMap.get('memory/10086/notes'))[0].text).toBe('今天这话题它不想插嘴');
    const energy = JSON.parse(storageMap.get('state/energy/10086')).value;
    // 0.5 → 向基线 0.7 回归 25%（+0.05）、被 @ +0.05 ⇒ 0.6，再按模型的 delta -0.1 ⇒ 0.5。
    // 沉默**不扣**"说话成本"：没说话就没有消耗。
    expect(energy).toBeCloseTo(0.5, 2);
    expect(loggedText()).toContain('这次没说话');
  });

  test('群记忆会去重、会忘掉，也会在下一次提问里出现', async () => {
    const first = await askMention();
    answer(first.id, { text: fenced('在。', { remember: ['张三在准备考研', '张三在准备考研'] }) });
    await pump(40);
    // 同一件事说两遍只留一条（按前 12 个字判重）。
    expect(JSON.parse(storageMap.get('memory/10086/notes'))).toHaveLength(1);

    const second = await askMention({ text: '还记得我吗' });
    expect(second.payload.system).toContain('张三在准备考研');
    answer(second.id, { text: fenced('记得。', { forget: ['准备考研'] }) });
    await pump(40);
    expect(JSON.parse(storageMap.get('memory/10086/notes'))).toHaveLength(0);
  });

  test('群友卡片：昵称自动记，模型补一句话，下一次进 prompt', async () => {
    const first = await askMention({ card: '小明' });
    answer(first.id, { text: fenced('在。', { friend: { nickname: '小明', info: '在准备考研，晚上才出现' } }) });
    await pump(40);
    const card = JSON.parse(storageMap.get('memory/friends/20001'));
    expect(card.nickname).toBe('小明');
    expect(card.info).toContain('考研');

    const second = await askMention({ text: '晚上好' });
    expect(second.payload.system).toContain('在准备考研');
    expect(second.payload.system).toContain('你认识的群友');
    answer(second.id, { text: '晚上好。' });
    await pump(40);
  });

  test('能量：说一句会掉，被 @ 会给一点加成', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // 漂移为 0，只剩规则本身
    storageMap.set('state/energy/10086', JSON.stringify({ value: 0.9, at: 1 }));
    const call = await askMention();
    answer(call.id, { text: '在。' });
    await pump(40);
    const after = JSON.parse(storageMap.get('state/energy/10086')).value;
    // 0.9 → 向基线回归（-0.05）→ 被 @ +0.05 ⇒ 0.9，说一句再扣 0.051 ⇒ 约 0.85。
    // 关键是"回复的成本要大于被 @ 的加成"：真机上 0.1 的加成对上 0.03 的成本，能量一路顶到
    // 97，整个机制退化成装饰。
    expect(after).toBeLessThan(0.9);
    expect(after).toBeGreaterThan(0.8);
  });

  test('模型漏了围栏时：日志说一句，原话也留在 state/probe 里', async () => {
    const call = await askMention();
    answer(call.id, { text: '在。' }); // 只写正文，没有围栏
    await pump(40);

    expect(lastSentText()).toBe('在。');
    expect(loggedText()).toContain('模型没带尾部围栏');
    const probe = JSON.parse(storageMap.get('state/probe'));
    expect(probe[probe.length - 1].raw).toBe('在。');
    expect(probe[probe.length - 1].group).toBe('10086');
  });

  test('带了围栏就不该冒那句提示', async () => {
    const call = await askMention();
    answer(call.id, { text: fenced('在。', {}) });
    await pump(40);
    expect(loggedText()).not.toContain('模型没带尾部围栏');
  });

  test('能量低时 prompt 里说的是"可以敷衍"，而不是数字', async () => {
    storageMap.set('state/energy/10086', JSON.stringify({ value: 0.05, at: 1 }));
    const call = await askMention();
    expect(call.payload.system).toContain('不想说话');
    answer(call.id, { text: '嗯。' });
    await pump(40);
  });
});

describe('表情包目录', () => {
  /** A library of three stickers with tags and descriptions. */
  function seedStickers() {
    storageMap.set('media/stickers/index', JSON.stringify([
      { hash: 'aaaa1111', tag: '开心', description: '笑到打滚的人' },
      { hash: 'bbbb2222', tag: '委屈', description: '蹲在角落画圈' },
      { hash: 'cccc3333', tag: '无语', description: '一只翻白眼的猫' },
    ]));
    for (const hash of ['aaaa1111', 'bbbb2222', 'cccc3333']) {
      storageMap.set(`media/stickers/bytes/${hash}`, 'R0lGODlhAQAB');
    }
  }

  test('候选表情进了 prompt，模型挑 id 就能发出去', async () => {
    seedStickers();
    await bootBot({ values: { stickerChance: '100' } });
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '好委屈' } }] }));
    const call = requestsFor('llm.chat').slice(-1)[0];
    // 三条都在候选里，而且带 id —— 这就是"模型挑 id"的全部依据。
    expect(call.payload.system).toContain('aaaa1111');
    expect(call.payload.system).toContain('蹲在角落画圈');

    answer(call.id, { text: fenced('抱抱。', { meme: 'bbbb2222' }) });
    await pump(90);
    const sends = requestsFor('net.fetch').filter((r) => String(r.payload.url).includes('send_group_message') && !String(r.payload.url).includes('_reaction'));
    const stickerSend = sends.map((r) => String(r.payload.body)).find((body) => body.includes('"type":"image"'));
    expect(stickerSend, '挑中的那张没有发出去').toBeTruthy();
    expect(stickerSend).toContain('base64://R0lGODlhAQAB');
    // 用过的计数要写回去，否则"优先挑没用过的"永远只在原地打转。
    const index = JSON.parse(storageMap.get('media/stickers/index'));
    expect(index.find((row) => row.hash === 'bbbb2222').usageCount).toBe(1);
  });

  test('模型挑了一个不存在的 id：不发、不报错', async () => {
    seedStickers();
    await bootBot({ values: { stickerChance: '100' } });
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '在吗' } }] }));
    answer(requestsFor('llm.chat').slice(-1)[0].id, { text: fenced('在。', { meme: 'deadbeef' }) });
    await pump(40);
    const sends = requestsFor('net.fetch').filter((r) => String(r.payload.url).includes('send_group_message') && !String(r.payload.url).includes('_reaction'));
    expect(sends.some((r) => String(r.payload.body).includes('"type":"image"'))).toBe(false);
    expect(loggedText()).toContain('不在图库里');
  });

  test('候选条数受 stickerCandidateMax 限制', async () => {
    storageMap.set('media/stickers/index', JSON.stringify(
      Array.from({ length: 30 }, (_, i) => ({
        hash: `0000000${i.toString(16)}`,
        tag: '开心',
        description: `第 ${i} 张`,
      })),
    ));
    await bootBot({ values: { stickerCandidateMax: '5' } });
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '在吗' } }] }));
    const system = requestsFor('llm.chat').slice(-1)[0].payload.system;
    const listed = system.split('\n').filter((line) => /^- 0{7}[0-9a-f] /.test(line));
    expect(listed.length).toBeLessThanOrEqual(5);
    expect(listed.length).toBeGreaterThan(0);
  });
});

describe('群内命令、@ 与消息段', () => {
  /** The segments of the last message sent into the group. */
  function lastSentSegments() {
    const sends = requestsFor('net.fetch').filter((r) => String(r.payload.url).includes('send_group_message') && !String(r.payload.url).includes('_reaction'));
    if (!sends.length) return [];
    return JSON.parse(sends[sends.length - 1].payload.body).message;
  }

  test('#状态 只有主人/管理员能用，回复里带着能量与记忆条数', async () => {
    storageMap.set('state/energy/10086', JSON.stringify({ value: 0.42, at: 1 }));
    storageMap.set('memory/10086/notes', JSON.stringify([{ text: '张三在考研', at: 1 }]));
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();

    // 普通群员：拒绝。
    await deliver(groupMessage({ senderID: 20001, card: '小明', segments: [{ type: 'text', data: { text: '#状态' } }] }));
    expect(lastSentSegments().filter((seg) => seg.type === 'text').map((seg) => seg.data.text).join(''))
      .toContain('只有群主/管理员');

    // 管理员：给数字。
    await deliver(groupMessage({
      senderID: 20002,
      card: '管理',
      segments: [{ type: 'text', data: { text: '#状态' } }],
      role: 'admin',
      seq: 9,
    }));
    const text = lastSentSegments().filter((seg) => seg.type === 'text').map((seg) => seg.data.text).join('');
    expect(text).toContain('42/100');
    expect(text).toContain('记着 1 条');
    // 命令不喂给模型。
    expect(requestsFor('llm.chat')).toHaveLength(0);
  });

  test('#忘掉 清空这个群的记忆要点', async () => {
    storageMap.set('memory/10086/notes', JSON.stringify([{ text: '张三在考研', at: 1 }]));
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({
      senderID: 20002,
      card: '管理',
      segments: [{ type: 'text', data: { text: '#忘掉' } }],
      role: 'owner',
    }));
    expect(JSON.parse(storageMap.get('memory/10086/notes'))).toHaveLength(0);
    expect(requestsFor('llm.chat')).toHaveLength(0);
  });

  test('@昵称 变成真正的 @ 段', async () => {
    membersAvailable = true;
    groupMembers = [
      { id: '30001', card: '张三', nickname: 'zs' },
      { id: '30002', card: '张三丰', nickname: 'zsf' },
    ];
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '在吗' } }] }));
    answer(requestsFor('llm.chat').slice(-1)[0].id, { text: '在。@张三丰 你说得对' });
    await pump(40);

    const segments = lastSentSegments();
    const at = segments.find((seg) => seg.type === 'mention');
    expect(at, '文本里的 @昵称 没有被换成真的 @').toBeTruthy();
    // 长的名字优先："@张三丰" 不该被 "@张三" 截走。
    expect(String(at.data.user_id)).toBe('30002');
    expect(segments.filter((seg) => seg.type === 'text').map((seg) => seg.data.text).join('')).toContain('你说得对');
  });

  test('协议端没有群成员接口时，@昵称 保持普通文字（不发错 @）', async () => {
    membersAvailable = false;
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '在吗' } }] }));
    answer(requestsFor('llm.chat').slice(-1)[0].id, { text: '在。@张三 你说得对' });
    await pump(40);
    const segments = lastSentSegments();
    expect(segments.some((seg) => seg.type === 'mention')).toBe(false);
    expect(segments.filter((seg) => seg.type === 'text').map((seg) => seg.data.text).join('')).toContain('@张三');
  });

  test('新补的消息段：位置/名片/骰子有占位，认不出的类型也不会变成空字符串', async () => {
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({
      segments: [
        mention(),
        { type: 'location', data: {} },
        { type: 'contact', data: { nickname: '老王' } },
        { type: 'dice', data: {} },
        { type: 'some_new_type', data: {} },
        { type: 'text', data: { text: '在吗' } },
      ],
    }));
    const asked = String(requestsFor('llm.chat').slice(-1)[0].payload.text);
    expect(asked).toContain('[位置]');
    expect(asked).toContain('[名片：老王]');
    expect(asked).toContain('[骰子]');
    expect(asked).toContain('[some_new_type]');
    expect(asked).toContain('在吗');
  });
});

describe('主人私聊导入', () => {
  /** One private message from the owner. */
  function privateMessage({ senderID = 12345, segments = [] } = {}) {
    return JSON.stringify({
      event_type: 'message_receive',
      self_id: 90001,
      data: {
        message_scene: 'friend',
        peer_id: senderID,
        sender_id: senderID,
        segments,
      },
    });
  }

  /** The text of the last private reply to the owner. */
  function lastPrivateText() {
    const sends = requestsFor('net.fetch')
      .filter((r) => String(r.payload.url).includes('send_private_message'))
      .map((r) => JSON.parse(r.payload.body));
    if (!sends.length) return '';
    return sends[sends.length - 1].message
      .filter((seg) => seg.type === 'text')
      .map((seg) => seg.data.text)
      .join('');
  }

  async function bootOwner(values = {}) {
    await bootBot({ values: { ownerQQ: '12345', visionModel: 'vlm-model', ...values } });
    hostEmits('ws.state', { state: 'open' });
    await pump();
  }

  test('重新发一遍残图的完整版：就地补齐，**不重新识图**', async () => {
    // 用户的原话是"重新发了之前的记录，反应好久没回复，难不成又识别了一遍" —— 之前确实是
    // 每张都调一次识图。现在先比"前 48 KB 指纹"：认出是那张残图的完整版，就把字节写回去，
    // 分类和描述沿用旧的。
    const prefix = 'A'.repeat(70000);
    const full = `${prefix}${'B'.repeat(5000)}`;
    storageMap.set('media/stickers/index', JSON.stringify([
      { hash: 'aaaa1111', tag: '开心', description: '笑到打滚' },
    ].map((row) => ({ ...row, truncated: true }))));
    storageMap.set('media/stickers/bytes/aaaa1111', prefix);
    imageByUrl.set('http://img.example/full.png', full);

    await bootOwner();
    hostEmits('ws.message', { text: privateMessage({ segments: [{ type: 'image', data: { temp_url: 'http://img.example/full.png' } }] }) });
    await pump(120);

    expect(requestsFor('llm.chat'), '补图时不该再调识图').toHaveLength(0);
    expect(storageMap.get('media/stickers/bytes/aaaa1111')).toBe(full);
    const row = JSON.parse(storageMap.get('media/stickers/index'))[0];
    expect(row.truncated).toBeUndefined();
    expect(row.tag).toBe('开心');
    expect(row.description).toBe('笑到打滚');
    expect(row.sig, '指纹没有记下来，下次还要再读一遍').toBeTruthy();
    expect(lastPrivateText()).toContain('就地补齐');
  });

  test('完整版已经作为新行导过一次：补齐残图的同时把那份重复的收掉', async () => {
    // 真机上就是这样：先按旧逻辑导进 56 张完整的（每张都识了图），残图还留着。
    // 重发时应该"补好残图 + 删掉那条重复的新行"，而不是让同一张图在库里躺两行。
    const prefix = 'A'.repeat(70000);
    const full = `${prefix}${'B'.repeat(5000)}`;
    // 重复的那一行是"按新图导进来"的，key 就是完整字节的 hash —— 用插件自己的算法算，
    // 免得测试和实现各写一份 FNV 然后悄悄分叉。
    const fullHash = window.__qq.hashOf(full);
    storageMap.set('media/stickers/index', JSON.stringify([
      { hash: 'aaaa1111', tag: '开心', description: '老的那条' },
      { hash: fullHash, tag: '开心', description: '新导入的重复' },
    ].map((row) => (row.hash === 'aaaa1111' ? { ...row, truncated: true } : row))));
    storageMap.set('media/stickers/bytes/aaaa1111', prefix);
    storageMap.set(`media/stickers/bytes/${fullHash}`, full);
    imageByUrl.set('http://img.example/full.png', full);

    await bootOwner();
    hostEmits('ws.message', { text: privateMessage({ segments: [{ type: 'image', data: { temp_url: 'http://img.example/full.png' } }] }) });
    await pump(120);

    const index = JSON.parse(storageMap.get('media/stickers/index'));
    expect(index, '重复的那行没有被收掉').toHaveLength(1);
    expect(index[0].hash).toBe('aaaa1111');
    expect(index[0].truncated).toBeUndefined();
    expect(index[0].description).toBe('老的那条');
    expect(storageMap.get('media/stickers/bytes/aaaa1111')).toBe(full);
    expect(storageMap.has(`media/stickers/bytes/${fullHash}`)).toBe(false);
    expect(requestsFor('llm.chat')).toHaveLength(0);
    expect(lastPrivateText()).toContain('收掉了 1 张重复的');
  });

  test('真正的新图才识图，同一张发第二次按 hash 跳过', async () => {
    imageByUrl.set('http://img.example/new.png', 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIB');
    await bootOwner();
    hostEmits('ws.message', { text: privateMessage({ segments: [{ type: 'image', data: { temp_url: 'http://img.example/new.png' } }] }) });
    await pump(60);
    const classify = requestsFor('llm.chat').filter((r) => Array.isArray(r.payload.images) && r.payload.images.length);
    expect(classify, '新图应该识图一次').toHaveLength(1);
    answer(classify[0].id, { text: '开心\n笑' });
    await pump(60);
    expect(JSON.parse(storageMap.get('media/stickers/index'))).toHaveLength(1);

    // 同一份字节再来一次：hash 命中，识图不再发生。
    hostEmits('ws.message', { text: privateMessage({ segments: [{ type: 'image', data: { temp_url: 'http://img.example/new.png' } }] }) });
    await pump(60);
    const again = requestsFor('llm.chat').filter((r) => Array.isArray(r.payload.images) && r.payload.images.length);
    expect(again, '同一张图被重复识图了').toHaveLength(1);
  });
});

describe('自动收藏', () => {
  /** Boots with the vision model configured, which is what enables collecting. */
  async function bootWithVision(values = {}) {
    await bootBot({ values: { visionModel: 'vlm-model', ...values } });
    hostEmits('ws.state', { state: 'open' });
    await pump();
  }

  /** One unaddressed group message carrying a picture. */
  function imageMessage(url = 'http://img.example/a.png', extra = {}) {
    return groupMessage({ segments: [{ type: 'image', data: { temp_url: url, summary: '[动画表情]' } }], ...extra });
  }

  test('群里的图：下载 + 识图 → 进待收藏；模型 save_meme 才真正落库', async () => {
    imageBody = 'R0lGODlhAQABAIAAAAAAAP';
    await bootWithVision();
    await deliver(imageMessage());
    // 收图时会问一次视觉模型："这是什么表情"。
    const classify = requestsFor('llm.chat').filter((r) => Array.isArray(r.payload.images) && r.payload.images.length);
    expect(classify.length, '没有为新图调用识图模型').toBe(1);
    answer(classify[0].id, { text: '开心\n一个人笑到打滚' });
    await pump(40);

    const pending = JSON.parse(storageMap.get('media/stickers/pending-index'));
    expect(pending).toHaveLength(1);
    expect(pending[0].tag).toBe('开心');
    expect(storageMap.get(`media/stickers/pending/${pending[0].hash}`)).toBe(imageBody);
    // 还没进图库：收藏是模型的决定，不是下载的副作用。
    expect(storageMap.has('media/stickers/index')).toBe(false);

    // 下一次被 @：候选池里有这张，模型说要收。
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '在吗' } }] }));
    const call = requestsFor('llm.chat').filter((r) => !r.payload.images).slice(-1)[0];
    expect(call.payload.system).toContain(pending[0].hash);
    answer(call.id, { text: fenced('在。', { save_meme: pending[0].hash }) });
    await pump(50);

    const index = JSON.parse(storageMap.get('media/stickers/index'));
    expect(index).toHaveLength(1);
    expect(index[0].hash).toBe(pending[0].hash);
    expect(index[0].collected).toBe(true);
    expect(storageMap.get(`media/stickers/bytes/${pending[0].hash}`)).toBe(imageBody);
    expect(JSON.parse(storageMap.get('media/stickers/pending-index'))).toHaveLength(0);
  });

  test('同一张图不会重复识图（按内容 hash 去重）', async () => {
    imageBody = 'R0lGODlhAQABAIAAAAAAAP';
    await bootWithVision();
    await deliver(imageMessage());
    const first = requestsFor('llm.chat').filter((r) => Array.isArray(r.payload.images) && r.payload.images.length);
    answer(first[0].id, { text: '无语\n翻白眼' });
    await pump(40);

    // 同一份字节再发一次：识别与下载都不该再来一遍。
    await deliver(imageMessage('http://img.example/b.png', { seq: 8 }));
    const again = requestsFor('llm.chat').filter((r) => Array.isArray(r.payload.images) && r.payload.images.length);
    expect(again.length, '同一张图被重复识图了').toBe(1);
    expect(JSON.parse(storageMap.get('media/stickers/pending-index'))).toHaveLength(1);
  });

  test('关掉开关就完全不碰网络与识图', async () => {
    imageBody = 'R0lGODlhAQABAIAAAAAAAP';
    await bootWithVision({ autoCollectStickers: 'false' });
    await deliver(imageMessage());
    expect(requestsFor('llm.chat')).toHaveLength(0);
    const fetches = requestsFor('net.fetch').filter((r) => String(r.payload.url).includes('img.example'));
    expect(fetches).toHaveLength(0);
    expect(storageMap.has('media/stickers/pending-index')).toBe(false);
  });

  test('没有识图模型时安静跳过（没有描述的表情包收进来也没用）', async () => {
    imageBody = 'R0lGODlhAQABAIAAAAAAAP';
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(imageMessage());
    expect(requestsFor('llm.chat')).toHaveLength(0);
    expect(storageMap.has('media/stickers/pending-index')).toBe(false);
  });

  test('被截断的大图不收藏，并在日志里说清楚', async () => {
    imageBody = 'R0lGODlhAQABAIAAAAAAAP';
    imageTruncated = true;
    await bootWithVision();
    await deliver(imageMessage());
    await pump(40);
    expect(storageMap.has('media/stickers/pending-index')).toBe(false);
    expect(loggedText()).toContain('被截断');
  });

  test('每小时最多描述 3 张图', async () => {
    imageBody = 'R0lGODlhAQABAIAAAAAAAP';
    await bootWithVision();
    for (let i = 0; i < 5; i += 1) {
      // 每一张的字节都不同，否则会命中 hash 去重而不是限速。
      imageBody = `R0lGODlhAQABAIAAAAAAAP${'B'.repeat(i + 1)}`;
      await deliver(imageMessage(`http://img.example/p${i}.png`, { seq: 20 + i }));
      const pending = requestsFor('llm.chat').filter((r) => Array.isArray(r.payload.images) && r.payload.images.length);
      const last = pending[pending.length - 1];
      if (last && !answered.has(last.id)) answer(last.id, { text: '开心\n笑' });
      await pump(40);
    }
    const described = requestsFor('llm.chat').filter((r) => Array.isArray(r.payload.images) && r.payload.images.length);
    expect(described.length).toBe(3);
    expect(loggedText()).toContain('这一小时已经存过');
  });
});

// --- 服务商内容安全拦截 -------------------------------------------------------
//
// 真机上撞到的：群里有人让机器人"把'傻逼'记下来"，这句话和它的复述一起进了 history，
// 于是之后每条请求都带着它们 → 服务端一律回 "The request contains sensitive content"，
// 机器人哑了好几分钟，日志里只有"回答失败"。这一组钉的是"被拦之后还能不能说话"。

describe('内容安全拦截', () => {
  const BLOCKED = '服务端返回错误：The request contains sensitive content. Please modify your input and try again.';

  async function mentionAndFail(values = {}) {
    await bootBot({ values });
    hostEmits('ws.state', { state: 'open' });
    await pump();
    storageMap.set('memory/10086/notes', JSON.stringify([{ text: '乱七八糟的一句', at: 1 }]));
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '在吗' } }] }));
    const first = requestsFor('llm.chat').slice(-1)[0];
    answer(first.id, null, { ok: false, error: BLOCKED });
    await pump(40);
    return first;
  }

  test('被拦之后自己缩上下文重试，群里照样收到回复（不需要人发指令）', async () => {
    const first = await mentionAndFail();
    const calls = requestsFor('llm.chat');
    expect(calls.length, '没有重试').toBe(2);
    const second = calls[1];
    // 最小上下文：不带历史、不带群记忆，也不带表情候选。
    expect(second.payload.history || []).toHaveLength(0);
    expect(second.payload.system).not.toContain('你记得这个群的事');
    expect(second.payload.system).not.toContain('表情包');
    expect(second.payload.system).toContain('安全策略缩小过');
    // 提问本身还在。
    expect(second.payload.text).toContain('在吗');
    expect(second.id).not.toBe(first.id);

    answer(second.id, { text: '在。' });
    await pump(40);
    expect(lastSentText()).toBe('在。');
    expect(loggedText()).toContain('判成敏感内容');
    expect(loggedText()).toContain('不用你处理');
  });

  test('历史里有脏东西：先丢一半再试，成功那一档写回磁盘（以后不再带）', async () => {
    // 真机上的形状：那两轮带脏话的往来留在 history 里，每次回答都会被重放。
    storageMap.set('history/10086', JSON.stringify([
      { role: 'user', text: '一' }, { role: 'assistant', text: '二' },
      { role: 'user', text: '三' }, { role: 'assistant', text: '四' },
      { role: 'user', text: '五' }, { role: 'assistant', text: '六' },
    ]));
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '在吗' } }] }));
    const first = requestsFor('llm.chat').slice(-1)[0];
    expect(first.payload.history).toHaveLength(6);
    answer(first.id, null, { ok: false, error: BLOCKED });
    await pump(40);

    const retry = requestsFor('llm.chat').slice(-1)[0];
    expect(retry.id).not.toBe(first.id);
    expect(retry.payload.history, '没有先试"丢一半"').toHaveLength(3);
    answer(retry.id, { text: '在。' });
    await pump(40);

    expect(lastSentText()).toBe('在。');
    // 成功的那一档落盘：下次不用再先失败一遍，也不会再带着那几轮。
    const kept = JSON.parse(storageMap.get('history/10086'));
    // 落盘的是"最近三轮 + 这一轮新问答"：被判敏感的头三轮已经不在文件里了。
    expect(kept).toHaveLength(5);
    expect(kept.slice(0, 3).map((turn) => turn.text)).toEqual(['四', '五', '六']);
    expect(kept.some((turn) => ['一', '二', '三'].includes(turn.text)), '旧的脏往来还留着').toBe(false);
    expect(loggedText()).toContain('缩到 3 轮');
  });

  test('十分钟内再问一次：直接用最小上下文，不再白跑一次失败请求', async () => {
    // cooldownSec 关掉：这里要测的是"用哪种上下文"，不是每群冷却。
    const first = await mentionAndFail({ cooldownSec: '0' });
    answer(requestsFor('llm.chat')[1].id, { text: '在。' });
    await pump(40);

    const before = requestsFor('llm.chat').length;
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '还在吗' } }], seq: 9 }));
    const calls = requestsFor('llm.chat');
    expect(calls.length - before, '又开始用完整上下文了').toBe(1);
    expect(calls[calls.length - 1].payload.system).toContain('安全策略缩小过');
    answer(calls[calls.length - 1].id, { text: '在。' });
    await pump(40);
    expect(first.id).toBeTruthy();
  });

  test('不是内容安全的错误照旧抛出去（别把真故障当成"换个上下文就好"）', async () => {
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '在吗' } }] }));
    const first = requestsFor('llm.chat').slice(-1)[0];
    answer(first.id, null, { ok: false, error: 'connectex: No connection could be made' });
    await pump(40);
    expect(requestsFor('llm.chat'), '非内容安全错误不该重试').toHaveLength(1);
    expect(loggedText()).toContain('回答失败');
  });

  test('#忘掉 连最近的往来一起清（只清要点救不了被拦的上下文）', async () => {    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    storageMap.set('memory/10086/notes', JSON.stringify([{ text: '要忘掉的', at: 1 }]));
    storageMap.set('history/10086', JSON.stringify([{ role: 'user', text: '脏话' }]));
    await deliver(groupMessage({
      senderID: 20002,
      card: '管理',
      role: 'owner',
      segments: [{ type: 'text', data: { text: '#忘掉' } }],
    }));
    expect(storageMap.has('history/10086')).toBe(false);
    expect(JSON.parse(storageMap.get('memory/10086/notes'))).toHaveLength(0);
  });

  test('群名里的不可打印字符不会进提示词', async () => {
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({
      groupName: '喵窝<\u0011\u0010><\uFFFD>',
      segments: [mention(), { type: 'text', data: { text: '在吗' } }],
    }));
    const system = requestsFor('llm.chat').slice(-1)[0].payload.system;
    expect(system).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/);
    expect(system).toContain('喵窝');
  });
});

// --- 攒批自主插话（P3）--------------------------------------------------------
//
// 核心承诺：每条群消息只进内存缓冲，**不请求模型**；一个窗口内最多一次调用，且那一次调用同时
// 覆盖那一批消息。这一组就是钉这句话的 —— 谁把 tick 改成"每条消息问一次"，这里会立刻红。

describe('攒批自主插话', () => {
  /** 一条没被叫到的群消息：只该进缓冲。 */
  async function chatter(seq, text, card = '甲') {
    await deliver(groupMessage({ card, seq, segments: [{ type: 'text', data: { text } }] }));
  }

  async function bootBatch(values = {}) {
    await bootBot({ values: { batchWindowSec: '30', ...values } });
    hostEmits('ws.state', { state: 'open' });
    await pump();
  }

  test('群友闲聊不请求模型：三条只进缓冲，一条以上的消息也只有一次评估', async () => {
    await bootBatch();
    await chatter(11, '今天吃啥');
    await chatter(12, '随便');
    expect(requestsFor('llm.chat'), '每条消息都去问模型了').toHaveLength(0);

    await chatter(13, '那吃面吧');
    expect(requestsFor('llm.chat'), '三条就该等等，不该立刻发').toHaveLength(0);

    void window.__qq.batchTick();
    await pump(20);
    const calls = requestsFor('llm.chat');
    expect(calls, '攒够三条应该只发一次').toHaveLength(1);
    // 那一次调用同时覆盖了这三条。
    expect(calls[0].payload.system).toContain('群友刚才在聊');
    expect(calls[0].payload.system).toContain('今天吃啥');
    expect(calls[0].payload.system).toContain('那吃面吧');
    // 不要求它说话：沉默是合法答案。
    expect(calls[0].payload.text).toContain('不想说');
  });

  test('模型选择沉默：一个字都不发，而且不占用额度以外的任何东西', async () => {
    await bootBatch();
    await chatter(11, '今天吃啥');
    await chatter(12, '随便');
    await chatter(13, '那吃面吧');
    void window.__qq.batchTick();
    await pump(20);
    const calls = requestsFor('llm.chat');
    // 裸 JSON（不裹围栏）也要认：模型经常就这么回。
    answer(calls[0].id, { text: '{"silent":true}' });
    await pump(40);
    expect(lastSentText(), '沉默不该发出任何消息').toBe('');
    expect(loggedText()).toContain('决定不插嘴');
  });

  test('想说话时发一句，并在日志里记下看了几条', async () => {
    await bootBatch();
    await chatter(11, '今天吃啥');
    await chatter(12, '随便');
    await chatter(13, '那吃面吧');
    void window.__qq.batchTick();
    await pump(20);
    const calls = requestsFor('llm.chat');
    answer(calls[0].id, { text: '面吧，别又点那家齁咸的。\n```json\n{}\n```' });
    await pump(40);
    expect(lastSentText()).toBe('面吧，别又点那家齁咸的。');
    expect(loggedText()).toContain('自己插了一句');
    expect(loggedText()).toContain('看了 3 条新消息');
  });

  test('不够三条就不评估（冷清的群一次都不花钱）', async () => {
    await bootBatch();
    await chatter(11, '在吗');
    await chatter(12, '嗯');
    void window.__qq.batchTick();
    await pump(20);
    expect(requestsFor('llm.chat')).toHaveLength(0);
  });

  test('窗口没到不评估（batchWindowSec）', async () => {
    await bootBatch({ batchWindowSec: '600' });
    await chatter(11, '今天吃啥');
    await chatter(12, '随便');
    await chatter(13, '那吃面吧');
    void window.__qq.batchTick();
    // 第一次过闸会评估；把预置的"上次评估时间"顶到刚过去，第二次就该被窗口挡住。
    await pump(20);
    const first = requestsFor('llm.chat').length;
    expect(first).toBe(1);
    for (const call of requestsFor('llm.chat')) {
      if (!answered.has(call.id)) answer(call.id, { text: '{"silent":true}' });
    }
    await pump(20);
    await chatter(14, '走');
    await chatter(15, '走啊');
    await chatter(16, '嗯');
    void window.__qq.batchTick();
    await pump(20);
    expect(requestsFor('llm.chat'), '窗口内又评估了一次').toHaveLength(1);
  });

  test('每小时上限是硬闸（batchMaxPerHour）', async () => {
    await bootBatch({ batchWindowSec: '30', batchMaxPerHour: '1' });
    for (const [seq, text] of [[11, '一'], [12, '二'], [13, '三']]) await chatter(seq, `${text}个问题`);
    void window.__qq.batchTick();
    await pump(20);
    expect(requestsFor('llm.chat')).toHaveLength(1);
    answer(requestsFor('llm.chat')[0].id, { text: '{"silent":true}' });
    await pump(20);

    for (const [seq, text] of [[14, '四'], [15, '五'], [16, '六']]) await chatter(seq, `${text}个问题`);
    void window.__qq.batchTick();
    await pump(20);
    expect(requestsFor('llm.chat'), '超过每小时上限还在调').toHaveLength(1);
  });

  test('能量太低就不去看聊天（累了就歇着）', async () => {
    storageMap.set('state/energy/10086', JSON.stringify({ value: 0.1, at: 1 }));
    await bootBatch();
    await chatter(11, '今天吃啥');
    await chatter(12, '随便');
    await chatter(13, '那吃面吧');
    void window.__qq.batchTick();
    await pump(20);
    expect(requestsFor('llm.chat')).toHaveLength(0);
  });

  test('关掉开关就完全不去看', async () => {
    await bootBatch({ batchEnabled: 'false' });
    await chatter(11, '今天吃啥');
    await chatter(12, '随便');
    await chatter(13, '那吃面吧');
    void window.__qq.batchTick();
    await pump(20);
    expect(requestsFor('llm.chat')).toHaveLength(0);
  });

  test('被 @ 时把刚才的闲聊带上当上下文，而且不额外花钱', async () => {
    await bootBatch();
    await chatter(11, '今天吃啥');
    await chatter(12, '随便');
    const before = requestsFor('llm.chat').length;
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '你说呢' } }] }));
    const calls = requestsFor('llm.chat');
    expect(calls.length - before, '多花了一次调用').toBe(1);
    expect(calls[calls.length - 1].payload.system).toContain('刚才群里在聊');
    expect(calls[calls.length - 1].payload.system).toContain('今天吃啥');
  });
});

// --- 待收藏（群里的新图）------------------------------------------------------
//
// 真机上这条链是"花钱不产出"：待收藏满 10 张、collected 一直是 0、每群每小时还在识图。
// 两个原因 —— 协议里没列 `save_meme`，以及满了不设闸。这一组把两头都钉住。

describe('待收藏', () => {
  const PENDING = 'media/stickers/pending-index';

  function seedPending(count) {
    const rows = [];
    for (let i = 0; i < count; i += 1) {
      const hash = `0f0f000${i}`;
      rows.push({ hash, tag: '开心', description: `第 ${i} 张`, at: Date.now() + i });
      storageMap.set(`media/stickers/pending/${hash}`, 'R0lGODlhAQABAIAAAAAAAP');
    }
    storageMap.set(PENDING, JSON.stringify(rows));
    return rows;
  }

  function pictureMessage(url = 'http://img.example/pending.png') {
    return groupMessage({
      segments: [{ type: 'image', data: { temp_url: url, summary: '[动画表情]' } }],
    });
  }

  test('待收藏满了就不再识图（花钱之前先看有没有地方放）', async () => {
    await bootBot({ values: { visionModel: 'vlm-model' } });
    hostEmits('ws.state', { state: 'open' });
    await pump();
    seedPending(10);
    imageBody = 'R0lGODlhAQABAIAAAAAAAP';

    await deliver(pictureMessage());
    await pump(60);

    const vision = requestsFor('llm.chat')
      .filter((r) => Array.isArray(r.payload.images) && r.payload.images.length);
    expect(vision, '队列满了还去识图').toHaveLength(0);
    expect(loggedText()).toContain('待收藏区已经满了');
    // 队列没被悄悄挤掉：还是原来那 10 张。
    expect(JSON.parse(storageMap.get(PENDING))).toHaveLength(10);
  });

  test('协议里列出了 save_meme，而且要模型表态', async () => {
    seedPending(2);
    await bootBot({ values: { visionModel: 'vlm-model' } });
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '在吗' } }] }));
    const system = requestsFor('llm.chat').slice(-1)[0].payload.system;
    expect(system).toContain('"save_meme"');
    expect(system).toContain('不要不表态');
    expect(system).toContain('群里刚发的新表情');
  });

  test('工坊收件箱：能看到待收藏，收进图库与丢掉各走一边', async () => {
    seedPending(2);
    await bootWorkshop();

    const items = document.querySelectorAll('#pending-list .pending-item');
    expect(items, '待收藏没显示出来').toHaveLength(2);
    expect(el('pending-block').hidden).toBe(false);
    expect(document.querySelector('#pending-list .pending-desc').textContent).toContain('第 0 张');

    // 收进图库：索引多一行（带 collected），待收藏少一条。
    document.querySelector('#pending-list [data-action="keep"]').click();
    await pump(60);
    const index = JSON.parse(storageMap.get('media/stickers/index') || '[]');
    expect(index).toHaveLength(1);
    expect(index[0].collected).toBe(true);
    expect(index[0].description).toBe('第 0 张');
    expect(JSON.parse(storageMap.get(PENDING))).toHaveLength(1);

    // 丢掉：待收藏清空，字节也不再留着。
    document.querySelector('#pending-list [data-action="drop"]').click();
    await pump(60);
    expect(JSON.parse(storageMap.get(PENDING))).toHaveLength(0);
    expect(storageMap.has('media/stickers/pending/0f0f0001')).toBe(false);
    expect(el('pending-block').hidden).toBe(true);
  });
});

// --- 排队 ---------------------------------------------------------------------
//
// 原来的做法是"这个群上一条没答完就丢掉下一条"：两个人前后脚问，第二个人永远等不到回应。
// 现在按群排队，一次只答一条，答完接着答排队的。

describe('排队', () => {
  /** Every text sent into a group, in the order they went out. */
  function sentTexts() {
    return requestsFor('net.fetch')
      .filter((r) => String(r.payload.url).includes('send_group_message') && !String(r.payload.url).includes('_reaction'))
      .map((r) => JSON.parse(r.payload.body))
      .map((body) => (body.message || [])
        .filter((seg) => seg.type === 'text')
        .map((seg) => seg.data.text)
        .join(''))
      .filter(Boolean);
  }

  async function bootQuiet() {
    // cooldownSec 关掉：这里要测的是排队，不是间隔。
    await bootBot({ values: { cooldownSec: '0' } });
    hostEmits('ws.state', { state: 'open' });
    await pump();
  }

  test('上一条没答完时，第二个人的问题排队，答完再答他', async () => {
    await bootQuiet();
    await deliver(groupMessage({ card: '甲', segments: [mention(), { type: 'text', data: { text: '第一个问题' } }] }));
    const first = requestsFor('llm.chat').slice(-1)[0];
    expect(first).toBeTruthy();

    await deliver(groupMessage({
      senderID: 20003,
      card: '乙',
      segments: [mention(), { type: 'text', data: { text: '第二个问题' } }],
      seq: 8,
    }));
    expect(requestsFor('llm.chat'), '第二条不该同时发请求').toHaveLength(1);
    expect(loggedText()).toContain('排上了');

    answer(first.id, { text: '答甲' });
    await pump(80);
    const calls = requestsFor('llm.chat');
    expect(calls, '答完上一条没有接着答排队的').toHaveLength(2);
    expect(calls[1].payload.text).toContain('第二个问题');
    expect(calls[1].payload.text).toContain('乙');

    answer(calls[1].id, { text: '答乙' });
    await pump(80);
    expect(sentTexts()).toEqual(['答甲', '答乙']);
  });

  test('排队最多 4 条，多出来的直接丢（那条本来也不是在等回答）', async () => {
    await bootQuiet();
    await deliver(groupMessage({ card: '甲', segments: [mention(), { type: 'text', data: { text: '问题0' } }] }));
    for (let i = 1; i <= 5; i += 1) {
      await deliver(groupMessage({
        senderID: 20010 + i,
        card: `丙${i}`,
        segments: [mention(), { type: 'text', data: { text: `问题${i}` } }],
        seq: 10 + i,
      }));
    }
    expect(loggedText()).toContain('只好丢掉');
  });

  test('不同群互不阻塞：两个群可以同时在飞', async () => {
    await bootQuiet();
    await deliver(groupMessage({ card: '甲', segments: [mention(), { type: 'text', data: { text: '这边的' } }] }));
    await deliver(groupMessage({
      groupID: 20086,
      groupName: '另一个群',
      segments: [mention(), { type: 'text', data: { text: '那边的' } }],
      seq: 9,
    }));
    expect(requestsFor('llm.chat'), '第二个群被第一个群挡住了').toHaveLength(2);
  });
});

// --- 尾部裸 JSON ---------------------------------------------------------------
//
// 真机事故（1.12 第一批）：群里出现了
//   行啊，每天5点戳你，算以为我闹钟了。{"remember":[…],"friend":{…}}
// 模型没裹围栏就把指令追在句子后面，于是那句花括号原样发进了群。

describe('尾部裸 JSON', () => {
  test('正文后面直接跟 JSON：只发正文，指令照样生效', async () => {
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '每天晚上5点at我一下' } }] }));
    const call = requestsFor('llm.chat').slice(-1)[0];
    answer(call.id, {
      text: '行啊，每天5点戳你，算给你当闹钟了。'
        + '{"remember":["时先思让我每天晚上5点at他"],"friend":{"nickname":"时先思","info":"让我每天晚上5点at他"}}',
    });
    await pump(60);

    expect(lastSentText(), '花括号漏进群里了').toBe('行啊，每天5点戳你，算给你当闹钟了。');
    expect(JSON.parse(storageMap.get('memory/10086/notes'))[0].text).toBe('时先思让我每天晚上5点at他');
    expect(JSON.parse(storageMap.get('memory/friends/20001')).info).toBe('让我每天晚上5点at他');
  });

  test('整条回复就是裸 JSON（攒批的沉默）也认', async () => {
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '在吗' } }] }));
    const call = requestsFor('llm.chat').slice(-1)[0];
    answer(call.id, { text: '{"silent":true}' });
    await pump(60);
    expect(lastSentText()).toBe('');
    expect(loggedText()).toContain('这次没说话');
  });

  test('尾部裸 JSON 里带 remind：只发正文，提醒照样记下', async () => {
    // 真机第二次事故：「记了，我补上，别嫌。{"remind":[{"time":"21:05",…}]}」整段发进了群 ——
    // 因为那层"尾部裸 JSON"的字段白名单里漏了 `remind`。
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '你压根没记' } }] }));
    const call = requestsFor('llm.chat').slice(-1)[0];
    answer(call.id, {
      text: '记了，我补上，别嫌。{"remind":[{"time":"21:05","every":"once","text":"晚上好","at":"时先思"}]}',
    });
    await pump(60);

    expect(lastSentText(), '花括号又漏进群里了').toBe('记了，我补上，别嫌。');
    const rows = JSON.parse(storageMap.get('state/reminders'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ group: '10086', time: '21:05', every: 'once', text: '晚上好', at: '时先思' });
  });

  test('被截断的半截 JSON 也会被切掉（不把花括号发进群）', async () => {
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '记一下' } }] }));
    const call = requestsFor('llm.chat').slice(-1)[0];
    // max_tokens 掐断的样子：字段名在、JSON 不完整。
    answer(call.id, { text: '好，记下了。{"remember":["张三在考研' });
    await pump(60);
    expect(lastSentText()).toBe('好，记下了。');
  });

  test('聊到花括号本身时不能误伤（键名不认识就别动）', async () => {
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '这个符号念什么' } }] }));
    const call = requestsFor('llm.chat').slice(-1)[0];
    answer(call.id, { text: '这个 { } 叫大括号，写代码天天见 {"a":1}' });
    await pump(60);
    expect(lastSentText()).toBe('这个 { } 叫大括号，写代码天天见 {"a":1}');
  });
});

// --- 视频消息 ----------------------------------------------------------------
//
// 视频画面它一点都看不到，却会顺着"有人 @ 我"照常作答 —— 于是产出"这视频挺有意思"这种
// 凭空的评论。宁可沉默。

describe('视频消息', () => {
  function videoMessage({ extra = [], mentioned = true, seq = 40 } = {}) {
    const first = mentioned ? [mention()] : [];
    return groupMessage({
      seq,
      segments: [...first, ...extra, { type: 'video', data: { uri: 'file:///x.mp4' } }],
    });
  }

  test('带视频的消息（即使被 @）也不回，日志说明原因', async () => {
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(videoMessage({ extra: [{ type: 'text', data: { text: '看这个' } }] }));
    await pump(40);

    expect(requestsFor('llm.chat'), '带视频还去问模型').toHaveLength(0);
    expect(lastSentText()).toBe('');
    expect(loggedText()).toContain('画面看不到');
    expect(loggedText()).toContain('video');
  });

  test('短视频（short_video）同样不回', async () => {
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({
      seq: 41,
      segments: [mention(), { type: 'short_video', data: {} }],
    }));
    await pump(40);
    expect(requestsFor('llm.chat')).toHaveLength(0);
  });

  test('引用里带着视频也算（那句话就是在说那个视频）', async () => {
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({
      seq: 42,
      segments: [
        mention(),
        { type: 'text', data: { text: '这啥' } },
        { type: 'reply', data: { message_seq: 40, segments: [{ type: 'video', data: {} }] } },
      ],
    }));
    await pump(40);
    expect(requestsFor('llm.chat')).toHaveLength(0);
  });

  test('纯文字消息照旧回答（别把闸开太大）', async () => {
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '在吗' } }] }));
    await pump(20);
    expect(requestsFor('llm.chat')).toHaveLength(1);
  });

  test('带视频的消息仍然进背景聊天，占位符写明看不到', async () => {
    // 不回答，但它是"群里刚发生的事"，攒批应该知道有人在发视频（而不是当作没发生）。
    await bootBot({ values: { batchWindowSec: '30' } });
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(videoMessage({ mentioned: false, seq: 50 }));
    await deliver(groupMessage({ seq: 51, segments: [{ type: 'text', data: { text: '好看吗' } }] }));
    await deliver(groupMessage({ seq: 52, segments: [{ type: 'text', data: { text: '看不清' } }] }));
    void window.__qq.batchTick();
    await pump(40);
    const calls = requestsFor('llm.chat');
    expect(calls).toHaveLength(1);
    expect(calls[0].payload.system).toContain('视频（画面看不到）');
  });
});

// --- 主动 @ 与定时提醒 --------------------------------------------------------
//
// 群友说"每天 5 点 at 我一下"时，原来它只能记在 notes 里，兑现不了。这一组钉住两个新能力：
// `at` 指令（点名要 @ 谁）和 `remind`（到点自己发一条带真 @ 的消息，且触发时不调模型）。

describe('主动 @ 与定时提醒', () => {
  const REMINDERS = 'state/reminders';

  function mentionWith(text) {
    return groupMessage({ segments: [mention(), { type: 'text', data: { text } }] });
  }

  function sentSegments() {
    const sends = requestsFor('net.fetch')
      .filter((r) => String(r.payload.url).includes('send_group_message') && !String(r.payload.url).includes('_reaction'));
    if (!sends.length) return [];
    return JSON.parse(sends[sends.length - 1].payload.body).message || [];
  }

  function seedMembers() {
    membersAvailable = true;
    groupMembers = [
      { id: '20001', card: '时先思', nickname: 'sxs' },
      { id: '20002', card: '遥辰', nickname: 'yc' },
    ];
  }

  test('at 指令：名字变成真正的 @ 段，日志里也写明了 @ 了谁', async () => {
    seedMembers();
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(mentionWith('叫他别忘了'));
    const call = requestsFor('llm.chat').slice(-1)[0];
    answer(call.id, { text: '记得呢！\n```json\n{"at":["遥辰","@时先思"]}\n```' });
    await pump(60);

    const segments = sentSegments();
    const ids = segments.filter((seg) => seg.type === 'mention').map((seg) => String(seg.data.user_id));
    expect(ids).toEqual(['20002', '20001']);
    // 正文照旧跟在后面（两个 @ 之间的空格是分隔符，不算内容）。
    expect(segments.filter((seg) => seg.type === 'text').map((seg) => seg.data.text).join('').trim()).toBe('记得呢！');
    expect(loggedText()).toContain('@了 遥辰、时先思');
  });

  test('@ 段的类型必须叫 mention（写成 at 协议端会静默丢掉）', async () => {
    // 真机事故：提醒发出去了、日志也说"@了谁"，群里却什么都没有 —— 因为段类型写成了 `at`，
    // 而 Milky 的 @ 段叫 `mention`（入站就是这个名字，看 mentionsBot 就知道）。
    seedMembers();
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(mentionWith('叫他别忘了'));
    const call = requestsFor('llm.chat').slice(-1)[0];
    answer(call.id, { text: '好。\n```json\n{"at":["遥辰"]}\n```' });
    await pump(60);

    const segments = sentSegments();
    expect(segments.some((seg) => seg.type === 'at'), '又写成 at 了，协议端会静默丢掉').toBe(false);
    const mentions = segments.filter((seg) => seg.type === 'mention');
    expect(mentions).toHaveLength(1);
    expect(mentions[0].data.user_id).toBe(20002);
  });

  test('remind 指令落盘：HH:MM 之外的时间一律丢掉', async () => {
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(mentionWith('每天5点叫我一下'));
    const call = requestsFor('llm.chat').slice(-1)[0];
    answer(call.id, {
      text: '行。\n```json\n{"remind":[{"time":"17:00","every":"day","text":"该下班了","at":"时先思"},{"time":"下午五点","text":"x"},{"time":"25:00","text":"y"}]}\n```',
    });
    await pump(60);

    const rows = JSON.parse(storageMap.get(REMINDERS));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ group: '10086', time: '17:00', every: 'day', text: '该下班了', at: '时先思' });
    expect(loggedText()).toContain('记下了 1 条定时提醒');
  });

  test('到点就发：带真 @ 段，一天只发一次，触发时不调模型', async () => {
    seedMembers();
    storageMap.set(REMINDERS, JSON.stringify([
      { group: '10086', time: '17:00', every: 'day', text: '该下班了', at: '时先思', lastDay: '', at_ms: 1 },
    ]));
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    const before = requestsFor('llm.chat').length;

    const at = new Date();
    at.setHours(17, 0, 5, 0);
    void window.__qq.reminderTick(at);
    await pump(60);

    const segments = sentSegments();
    expect(segments.filter((seg) => seg.type === 'mention').map((seg) => String(seg.data.user_id))).toEqual(['20001']);
    expect(segments.filter((seg) => seg.type === 'text').map((seg) => seg.data.text).join('')).toContain('该下班了');
    expect(requestsFor('llm.chat').length, '发提醒不该调模型').toBe(before);

    // 同一分钟内再来一次：不重复发。
    const sends = requestsFor('net.fetch').filter((r) => String(r.payload.url).includes('send_group_message') && !String(r.payload.url).includes('_reaction')).length;
    void window.__qq.reminderTick(at);
    await pump(60);
    expect(
      requestsFor('net.fetch').filter((r) => String(r.payload.url).includes('send_group_message') && !String(r.payload.url).includes('_reaction')).length,
      '一分钟内发了两次',
    ).toBe(sends);
    // 每天的提醒发完还在（只是记了 lastDay）。
    expect(JSON.parse(storageMap.get(REMINDERS))).toHaveLength(1);
  });

  test('一次性的提醒发完就删掉', async () => {
    storageMap.set(REMINDERS, JSON.stringify([
      { group: '10086', time: '09:30', every: 'once', text: '交作业', at: '', lastDay: '', at_ms: 1 },
    ]));
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    const at = new Date();
    at.setHours(9, 30, 0, 0);
    void window.__qq.reminderTick(at);
    await pump(60);
    expect(JSON.parse(storageMap.get(REMINDERS))).toHaveLength(0);
  });

  test('时间不对就不发（只看 HH:MM 相等，不补发昨天错过的）', async () => {
    storageMap.set(REMINDERS, JSON.stringify([
      { group: '10086', time: '17:00', every: 'day', text: '该下班了', at: '', lastDay: '', at_ms: 1 },
    ]));
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    const at = new Date();
    at.setHours(18, 30, 0, 0);
    void window.__qq.reminderTick(at);
    await pump(60);
    const sends = requestsFor('net.fetch').filter((r) => String(r.payload.url).includes('send_group_message') && !String(r.payload.url).includes('_reaction'));
    expect(sends).toHaveLength(0);
  });

  test('模型没写 at：默认 @ 那个提要求的人（真机上提醒没 @ 到人）', async () => {
    seedMembers();
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    // 说话人是"时先思"，模型只下发了 time/text。
    await deliver(groupMessage({
      senderID: 20001,
      card: '时先思',
      segments: [mention(), { type: 'text', data: { text: '21:10分at我一下' } }],
    }));
    const call = requestsFor('llm.chat').slice(-1)[0];
    answer(call.id, { text: '行，21:10 叫你。\n```json\n{"remind":[{"time":"21:10","every":"once","text":"该干活了"}]}\n```' });
    await pump(60);

    const rows = JSON.parse(storageMap.get(REMINDERS));
    expect(rows[0].at, '没有默认 @ 说话人').toBe('时先思');

    // 到点发出来时是真 @ 段，不是普通文字。
    const at = new Date();
    at.setHours(21, 10, 5, 0);
    void window.__qq.reminderTick(at);
    await pump(60);
    const ids = sentSegments().filter((seg) => seg.type === 'mention').map((seg) => String(seg.data.user_id));
    expect(ids).toEqual(['20001']);
    expect(loggedText()).toContain('@时先思');
  });

  test('@ 的名字不在群成员里时，日志说明只能按普通文字发出', async () => {
    membersAvailable = true;
    groupMembers = [{ id: '20002', card: '遥辰', nickname: 'yc' }];
    storageMap.set(REMINDERS, JSON.stringify([
      { group: '10086', time: '07:00', every: 'day', text: '起床', at: '查无此人', lastDay: '', at_ms: 1 },
    ]));
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    const at = new Date();
    at.setHours(7, 0, 0, 0);
    void window.__qq.reminderTick(at);
    await pump(60);
    expect(loggedText()).toContain('认不出是谁');
    expect(sentSegments().some((seg) => seg.type === 'mention')).toBe(false);
  });

  test('"群主" 不是昵称：按群信息里的 owner_id 解析成真 @', async () => {
    // 真机：模型把 `at` 写成 `群主`，于是提醒到点谁也没 @ 到。
    groupInfoAvailable = true;
    groupOwnerID = 30001;
    storageMap.set(REMINDERS, JSON.stringify([
      { group: '10086', time: '21:30', every: 'once', text: '起来打原神', at: '群主', lastDay: '', at_ms: 1 },
    ]));
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    const at = new Date();
    at.setHours(21, 30, 5, 0);
    void window.__qq.reminderTick(at);
    await pump(60);
    const ids = sentSegments().filter((seg) => seg.type === 'mention').map((seg) => String(seg.data.user_id));
    expect(ids).toEqual(['30001']);
    expect(loggedText()).toContain('@群主');
  });

  test('"全体成员" 发成 mention_all，"我" 指向说话人，纯数字当 QQ 号', async () => {
    seedMembers();
    storageMap.set(REMINDERS, JSON.stringify([
      { group: '10086', time: '08:00', every: 'once', text: '集合', at: '全体成员', lastDay: '', at_ms: 1 },
      { group: '10086', time: '08:00', every: 'once', text: '打卡', at: '20002', lastDay: '', at_ms: 2 },
    ]));
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    const at = new Date();
    at.setHours(8, 0, 0, 0);
    void window.__qq.reminderTick(at);
    await pump(80);

    const sends = requestsFor('net.fetch')
      .filter((r) => String(r.payload.url).includes('send_group_message') && !String(r.payload.url).includes('_reaction'))
      .map((r) => JSON.parse(r.payload.body).message);
    const all = sends.find((segs) => segs.some((seg) => seg.type === 'mention_all'));
    expect(all, '没有 mention_all 段').toBeTruthy();
    const byId = sends.find((segs) => segs.some((seg) => seg.type === 'mention'));
    expect(String(byId.find((seg) => seg.type === 'mention').data.user_id)).toBe('20002');
  });

  test('存的时候就解析好：atID 落盘，不依赖到点时的群成员名单', async () => {
    seedMembers();
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({
      senderID: 20001,
      card: '时先思',
      segments: [mention(), { type: 'text', data: { text: '21:30 at群主 起来打原神' } }],
    }));
    const call = requestsFor('llm.chat').slice(-1)[0];
    answer(call.id, { text: '行。\n```json\n{"remind":[{"time":"21:30","every":"once","text":"起来打原神","at":"群主"}]}\n```' });
    await pump(60);
    const rows = JSON.parse(storageMap.get(REMINDERS));
    expect(rows[0].at).toBe('群主');
    // 协议端没提供 get_group_info 时解析不出来：atID 为空，到点只能退回普通文字。
    expect(rows[0].atID).toBe('');
    expect(rows[0].atAll).toBe(false);
  });

  test('回复里 at 写"群主"/"全体成员"也认得（不靠昵称）', async () => {
    groupInfoAvailable = true;
    groupOwnerID = 30001;
    // 两条连着问：关掉每群冷却，别让第二条排队。
    await bootBot({ values: { cooldownSec: '0' } });
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(mentionWith('叫群主起来打原神'));
    const first = requestsFor('llm.chat').slice(-1)[0];
    answer(first.id, { text: '群主，该起了。\n```json\n{"at":["群主"]}\n```' });
    await pump(60);

    const segments = sentSegments();
    const mentions = segments.filter((seg) => seg.type === 'mention');
    expect(mentions).toHaveLength(1);
    expect(String(mentions[0].data.user_id)).toBe('30001');
    // 正文不该再重复一个 "@群主" 的纯文本。
    expect(segments.filter((seg) => seg.type === 'text').map((seg) => seg.data.text).join('')).not.toContain('@群主');

    await deliver(mentionWith('通知所有人'));
    const second = requestsFor('llm.chat').slice(-1)[0];
    answer(second.id, { text: '全体注意。\n```json\n{"at":["全体成员"]}\n```' });
    await pump(60);
    const all = sentSegments();
    expect(all.some((seg) => seg.type === 'mention_all')).toBe(true);
  });

  test('"群主" 也能从群成员名单的 role 认出来（真机上没有 get_group_info）', async () => {
    // 真机：协议端不支持 get_group_info，于是 `@群主` 一直"认不出是谁"。名单里本来就有角色。
    membersAvailable = true;
    groupMembers = [
      { id: '20001', card: '时先思', nickname: 'sxs', role: 'member' },
      { id: '30001', card: '白泽', nickname: 'bz', role: 'owner' },
    ];
    storageMap.set(REMINDERS, JSON.stringify([
      { group: '10086', time: '22:15', every: 'once', text: '群主，改代码', at: '群主', lastDay: '', at_ms: 1 },
    ]));
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    const at = new Date();
    at.setHours(22, 15, 5, 0);
    void window.__qq.reminderTick(at);
    await pump(80);

    const mentions = sentSegments().filter((seg) => seg.type === 'mention');
    expect(mentions).toHaveLength(1);
    expect(String(mentions[0].data.user_id)).toBe('30001');
    // 发送段只带 user_id：协议端文档的 OutgoingSegment 表里 mention 只有这一个字段
    // （带 name 是接收段的形状），多塞字段只会让严格校验的实现整条拒掉。
    expect(mentions[0].data.name).toBeUndefined();
  });

  test('群主说过一句话之后，"群主" 就有了答案（消息自带 role）', async () => {
    // 名单读不到、也没有 get_group_info 时的最后一条路：消息里的 group_member.role。
    membersAvailable = false;
    // 提醒要在 boot 之前写好：reminders 在启动时读一次、之后按缓存用（一分钟才重读）。
    storageMap.set(REMINDERS, JSON.stringify([
      { group: '10086', time: '09:00', every: 'once', text: '改代码', at: '群主', lastDay: '', at_ms: 1 },
    ]));
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({
      senderID: 40001,
      card: '白泽',
      role: 'owner',
      segments: [{ type: 'text', data: { text: '我来了' } }],
    }));
    await pump(20);

    const at = new Date();
    at.setHours(9, 0, 0, 0);
    void window.__qq.reminderTick(at);
    await pump(80);
    const mentions = sentSegments().filter((seg) => seg.type === 'mention');
    expect(mentions).toHaveLength(1);
    expect(String(mentions[0].data.user_id)).toBe('40001');
  });

  test('工坊能看到这个群的提醒并删掉', async () => {
    storageMap.set('state/groups', JSON.stringify([
      { id: '10086', name: '测试群', count: 1, lastAt: Date.now() },
    ]));
    storageMap.set('memory/10086/notes', JSON.stringify([]));
    storageMap.set(REMINDERS, JSON.stringify([
      { group: '10086', time: '17:00', every: 'day', text: '该下班了', at: '时先思', lastDay: '', at_ms: 1 },
      { group: '20086', time: '08:00', every: 'day', text: '别的群的', at: '', lastDay: '', at_ms: 2 },
    ]));
    await bootWorkshop();
    document.querySelector('#groups-body [data-group="10086"]').click();
    await pump(60);

    const items = [...document.querySelectorAll('#remind-list .note-item')];
    expect(items, '只该显示这个群的提醒').toHaveLength(1);
    expect(items[0].textContent).toContain('17:00');
    expect(items[0].textContent).toContain('@时先思');

    document.querySelector('#remind-list [data-action="delete-remind"]').click();
    await pump(60);
    const left = JSON.parse(storageMap.get(REMINDERS));
    expect(left).toHaveLength(1);
    expect(left[0].group).toBe('20086');
  });
});

// --- 引用提问（概率）----------------------------------------------------------
//
// 以前是 bool（引用/不引用）：真机上"每条都引用"像复读机，"从不引用"又接不住"你说的那句"。
// 现在填概率。

describe('引用提问的概率', () => {
  function sentSegments() {
    const sends = requestsFor('net.fetch').filter((r) => String(r.payload.url).includes('send_group_message') && !String(r.payload.url).includes('_reaction'));
    if (!sends.length) return [];
    return JSON.parse(sends[sends.length - 1].payload.body).message || [];
  }

  async function ask(values = {}) {
    await bootBot({ values });
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '在吗' } }] }));
    const call = requestsFor('llm.chat').slice(-1)[0];
    answer(call.id, { text: '在。' });
    await pump(60);
  }

  test('概率 100：每条都引用，且 seq 是提问那条', async () => {
    await ask({ quoteChance: '100' });
    const first = sentSegments()[0];
    expect(first).toEqual({ type: 'reply', data: { message_seq: 7 } });
  });

  test('概率 0：从不引用', async () => {
    await ask({ quoteChance: '0' });
    expect(sentSegments().some((seg) => seg.type === 'reply')).toBe(false);
    expect(sentSegments()[0].type).toBe('text');
  });

  test('掷骰子没过就不引用（60% 时 0.9 该落空）', async () => {
    const random = vi.spyOn(Math, 'random');
    random.mockReturnValue(0.9);
    await ask();
    expect(sentSegments().some((seg) => seg.type === 'reply')).toBe(false);
  });

  test('掷骰子过了就引用（60% 时 0.1 该中）', async () => {
    const random = vi.spyOn(Math, 'random');
    random.mockReturnValue(0.1);
    await ask();
    expect(sentSegments().some((seg) => seg.type === 'reply')).toBe(true);
  });
});

// --- 表情编号漏进群 -----------------------------------------------------------
//
// 真机：群里连着出现两行 `694ee580` —— 模型把表情编号当正文发了出来。编号只该在围栏的
// `meme` 里；整条就是一个图库编号时，改成"发那张图"。

describe('表情编号当正文', () => {
  function seed() {
    storageMap.set('media/stickers/index', JSON.stringify([
      { hash: '694ee580', tag: '开心', description: '笑' },
    ]));
    storageMap.set('media/stickers/bytes/694ee580', 'R0lGODlhAQABAIAAAAAAAP');
  }

  function sentSegmentsList() {
    return requestsFor('net.fetch')
      .filter((r) => String(r.payload.url).includes('send_group_message') && !String(r.payload.url).includes('_reaction'))
      .map((r) => JSON.parse(r.payload.body).message || []);
  }

  test('编号夹在句子里（"给你这个，5f5910ea。"）：摘掉编号，图照发，话照说', async () => {
    // 真机第二次：模型把编号写进了正文中间。
    storageMap.set('media/stickers/index', JSON.stringify([
      { hash: '5f5910ea', tag: '开心', description: '递东西' },
    ]));
    storageMap.set('media/stickers/bytes/5f5910ea', 'R0lGODlhAQABAIAAAAAAAP');
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '发个表情包' } }] }));
    const call = requestsFor('llm.chat').slice(-1)[0];
    answer(call.id, { text: '给你这个，5f5910ea。' });
    await pump(100);

    const sends = sentSegmentsList();
    const texts = sends.map((segs) => segs.filter((seg) => seg.type === 'text').map((seg) => seg.data.text).join(''));
    expect(texts.join(''), '编号漏进群了').not.toContain('5f5910ea');
    // 剩下的话还在，标点收拾干净。
    expect(texts.join('').trim()).toBe('给你这个。');
    expect(sends.filter((segs) => segs.some((seg) => seg.type === 'image')), '图没发').toHaveLength(1);
  });

  test('正文整条是图库编号：发那张图，不发编号', async () => {
    seed();
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '发个表情包' } }] }));
    const call = requestsFor('llm.chat').slice(-1)[0];
    answer(call.id, { text: '694ee580' });
    await pump(80);

    const sends = sentSegmentsList();
    const texts = sends.map((segs) => segs.filter((seg) => seg.type === 'text').map((seg) => seg.data.text).join(''));
    expect(texts.join(''), '编号被当消息发出去了').not.toContain('694ee580');
    const images = sends.filter((segs) => segs.some((seg) => seg.type === 'image'));
    expect(images, '没有把那张表情发出来').toHaveLength(1);
    expect(loggedText()).toContain('改成发那张图');
  });

  test('正文是编号但图库里没有：宁可什么都不发，也不发一串十六进制', async () => {
    seed();
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '发个表情包' } }] }));
    const call = requestsFor('llm.chat').slice(-1)[0];
    answer(call.id, { text: 'deadbeef' });
    await pump(80);

    expect(sentSegmentsList(), '还是发出去了').toHaveLength(0);
    expect(loggedText()).toContain('图库里没有这张');
  });

  test('句子里有别的十六进制但不是图库里的：原样放过（别吃正常的话）', async () => {
    seed();
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '在吗' } }] }));
    const call = requestsFor('llm.chat').slice(-1)[0];
    answer(call.id, { text: 'ff8800 这个颜色挺好看的' });
    await pump(80);
    expect(lastSentText()).toBe('ff8800 这个颜色挺好看的');
  });
});

// --- 语音与戳一戳 -------------------------------------------------------------
//
// 两件相反的事：语音听不到，所以**不回**；戳一戳是冲它来的动作，所以**要回**。
// 两者都不该调模型 —— 语音没有内容可答，戳一戳只要一句短话。

describe('语音与戳一戳', () => {
  const POKE_LINES = ['戳我干嘛，手痒？', '别戳，痒。', '再戳我可要咬你了。', '戳坏了你赔吗？', '有话说，别动手。'];

  function sentTexts() {
    return requestsFor('net.fetch')
      .filter((r) => String(r.payload.url).includes('send_group_message') && !String(r.payload.url).includes('_reaction'))
      .map((r) => JSON.parse(r.payload.body))
      .map((body) => (body.message || []).map((seg) => (seg.type === 'text' ? seg.data.text : '')).join(''))
      .filter((text) => text.trim());
  }

  function sentMessage() {
    const sends = requestsFor('net.fetch').filter((r) => String(r.payload.url).includes('send_group_message') && !String(r.payload.url).includes('_reaction'));
    return sends.length ? JSON.parse(sends[sends.length - 1].payload.body).message : [];
  }

  function pokeEvent({ self = 90001, poker = 20001, target = 90001 } = {}) {
    return JSON.stringify({
      event_type: 'group_poke',
      self_id: self,
      data: { group_id: 10086, user_id: poker, target_id: target },
    });
  }

  test('语音消息不回，日志说明听不到', async () => {
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({
      segments: [mention(), { type: 'record', data: { uri: 'file:///a.amr' } }],
    }));
    await pump(40);
    expect(requestsFor('llm.chat'), '语音还去问模型').toHaveLength(0);
    expect(sentTexts()).toHaveLength(0);
    expect(loggedText()).toContain('听不到');
    expect(loggedText()).toContain('record');
  });

  test('语音也进背景聊天，占位符写明听不到', async () => {
    await bootBot({ values: { batchWindowSec: '30' } });
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ seq: 60, segments: [{ type: 'record', data: {} }] }));
    await deliver(groupMessage({ seq: 61, segments: [{ type: 'text', data: { text: '说啥了' } }] }));
    await deliver(groupMessage({ seq: 62, segments: [{ type: 'text', data: { text: '听不清' } }] }));
    void window.__qq.batchTick();
    await pump(40);
    const calls = requestsFor('llm.chat');
    expect(calls).toHaveLength(1);
    expect(calls[0].payload.system).toContain('语音（听不到）');
  });

  test('被戳一戳：回一句并 @ 戳的人，不调模型', async () => {
    // 概率全避开：不戳回去、也不贴表情（这两件各有自己的用例）。
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    hostEmits('ws.message', { text: pokeEvent() });
    await pump(40);

    const segments = sentMessage();
    const mention = segments.find((seg) => seg.type === 'mention');
    expect(mention, '没有 @ 戳的人').toBeTruthy();
    expect(String(mention.data.user_id)).toBe('20001');
    const text = segments.filter((seg) => seg.type === 'text').map((seg) => seg.data.text).join('').trim();
    expect(POKE_LINES).toContain(text);
    expect(requestsFor('llm.chat'), '回应戳一戳不该调模型').toHaveLength(0);
    expect(loggedText()).toContain('被戳了一下');
  });

  test('掷骰子中了就戳回去，而不是回一句话', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // 0 < pokeBackChance(40) ⇒ 戳回去
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    hostEmits('ws.message', { text: pokeEvent() });
    await pump(40);

    const pokes = requestsFor('net.fetch').filter((r) => /poke|nudge/i.test(String(r.payload.url)));
    expect(pokes.length, '没有戳回去').toBeGreaterThan(0);
    expect(String(pokes[pokes.length - 1].payload.url)).toContain('send_group_nudge');
    expect(sentTexts(), '戳回去就不要再说话了').toHaveLength(0);
    expect(loggedText()).toContain('戳回去了');
  });

  test('协议端不支持戳人：退化成回一句话，不沉默', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    pokeFails = true;
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    hostEmits('ws.message', { text: pokeEvent() });
    await pump(40);

    expect(sentTexts()).toHaveLength(1);
    expect(loggedText()).toContain('不支持戳人');
  });

  test('戳一戳只回一句话，不贴表情（表情只跟"回答"走）', async () => {
    // 曾经在这里贴过表情，后来撤了：戳一戳是高频动作，贴图会吃掉表情冷却，
    // 真正回答提问时反而贴不出来。
    const random = vi.spyOn(Math, 'random');
    random.mockReturnValue(0.5);
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    storageMap.set('media/stickers/index', JSON.stringify([
      { hash: '0a0a0a0a', tag: '开心', description: '笑' },
    ]));
    storageMap.set('media/stickers/bytes/0a0a0a0a', 'R0lGODlhAQABAIAAAAAAAP');
    random.mockReturnValueOnce(0.99).mockReturnValueOnce(0.5).mockReturnValueOnce(0);
    hostEmits('ws.message', { text: pokeEvent() });
    await pump(120);

    const sends = requestsFor('net.fetch').filter((r) => String(r.payload.url).includes('send_group_message') && !String(r.payload.url).includes('_reaction'));
    expect(sends, '只该有一条文字').toHaveLength(1);
    const hasImage = sends.some((r) => JSON.parse(r.payload.body).message.some((seg) => seg.type === 'image'));
    expect(hasImage, '戳一戳不该贴表情').toBe(false);
  });

  test('连戳多次：60 秒内只回一次', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    for (let i = 0; i < 4; i += 1) hostEmits('ws.message', { text: pokeEvent() });
    await pump(60);
    expect(sentTexts()).toHaveLength(1);
  });

  test('戳的是别人：不理', async () => {
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    hostEmits('ws.message', { text: pokeEvent({ target: 20002 }) });
    await pump(40);
    expect(sentTexts()).toHaveLength(0);
  });

  test('真机上的事件名 group_nudge 也认（而且不再掉进"未识别"）', async () => {
    // 真机日志：`收到未识别的事件类型：group_nudge` —— 因为戳一戳的钩子写在了"已知通知"
    // 那个分支里，而 group_nudge 不在通知表里，钩子就永远轮不到。
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    hostEmits('ws.message', {
      text: JSON.stringify({
        event_type: 'group_nudge',
        self_id: 90001,
        data: { group_id: 10086, user_id: 20001, target_id: 90001 },
      }),
    });
    await pump(40);

    expect(sentTexts(), 'group_nudge 没有被当成戳一戳').toHaveLength(1);
    expect(loggedText()).not.toContain('未识别的事件类型');
    expect(loggedText()).toContain('被戳了一下');
  });

  test('戳的人认不出来时，把原始字段记一次（各家字段名不一样）', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    hostEmits('ws.message', {
      text: JSON.stringify({ event_type: 'group_nudge', self_id: 90001, data: { group_id: 10086 } }),
    });
    await pump(40);
    expect(loggedText()).toContain('戳一戳事件的字段');
  });

  test('戳一戳以消息段的形式到达时也认', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99); // 不戳回去、不贴表情
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({
      senderID: 20003,
      card: '乙',
      seq: 70,
      segments: [{ type: 'poke', data: { target_id: 90001 } }],
    }));
    await pump(40);
    const segments = sentMessage();
    expect(segments.some((seg) => seg.type === 'mention')).toBe(true);
    expect(requestsFor('llm.chat')).toHaveLength(0);
  });
});

// --- 记忆编辑 ----------------------------------------------------------------
//
// 模型记错事时，原来唯一的人工动作是"忘掉这个群"——好的一起扔。这一组钉住"只删错的那条"和
// "自己补一条"。

describe('记忆编辑', () => {
  function seedGroup(notes) {
    storageMap.set('state/groups', JSON.stringify([
      { id: '10086', name: '测试群', count: 3, lastAt: Date.now() },
    ]));
    storageMap.set('memory/10086/notes', JSON.stringify(notes));
  }

  async function openCard() {
    const button = document.querySelector('#groups-body [data-group="10086"]');
    expect(button, '群列表里没有记忆入口').toBeTruthy();
    button.click();
    await pump(60);
    return el('memory-card');
  }

  test('点群列表的「记忆」能逐条看到，并删掉其中一条', async () => {
    seedGroup([
      { text: '张三在考研', at: 1 },
      { text: '群规：不聊政治', at: 2 },
    ]);
    await bootWorkshop();
    const card = await openCard();
    expect(card.hidden).toBe(false);
    expect(el('memory-group').textContent).toContain('测试群');

    const items = [...document.querySelectorAll('#memory-list .note-item')];
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('张三在考研');

    document.querySelector('#memory-list .note-item [data-action="delete"]').click();
    await pump(60);

    const kept = JSON.parse(storageMap.get('memory/10086/notes'));
    expect(kept).toHaveLength(1);
    expect(kept[0].text).toBe('群规：不聊政治');
    expect(el('memory-status').textContent).toContain('删掉了');
  });

  test('手工补一条：去重、守上限、最新的排在最后', async () => {
    seedGroup([{ text: '张三在考研', at: 1 }]);
    await bootWorkshop();
    await openCard();

    el('memory-new').value = '  李四养了只猫  ';
    el('memory-add').click();
    await pump(60);
    let kept = JSON.parse(storageMap.get('memory/10086/notes'));
    expect(kept).toHaveLength(2);
    expect(kept[kept.length - 1].text).toBe('李四养了只猫');

    // 同一条再加一次：不该出现两条。
    el('memory-new').value = '李四养了只猫';
    el('memory-add').click();
    await pump(60);
    kept = JSON.parse(storageMap.get('memory/10086/notes'));
    expect(kept).toHaveLength(2);
    expect(el('memory-status').textContent).toContain('已经记着了');
  });

  test('没有记忆的群也能打开，进去补第一条', async () => {
    seedGroup([]);
    await bootWorkshop();
    await openCard();
    expect(el('memory-empty').hidden).toBe(false);

    el('memory-new').value = '这个群主要在聊手游';
    el('memory-add').click();
    await pump(60);
    const kept = JSON.parse(storageMap.get('memory/10086/notes'));
    expect(kept).toHaveLength(1);
    expect(el('memory-empty').hidden).toBe(true);
  });
});

// --- 工坊可观测性 -------------------------------------------------------------
//
// 这一组是为了"记忆为什么一直是空的"这类问题能被用户自己看出来：机器人存一份模型原话，
// 工坊显示它；群列表的两列不再依赖"机器人回答过"才有人写。

describe('工坊可观测性', () => {
  test('「最近一次模型原话」显示在工坊里（含围栏，一眼能看出有没有带）', async () => {
    storageMap.set('state/probe', JSON.stringify([
      { group: '10086', at: Date.now(), raw: '在。\n```json\n{"remember":["张三在考研"]}\n```' },
    ]));
    await bootWorkshop();
    const note = el('probe-note');
    expect(note.hidden).toBe(false);
    expect(note.textContent).toContain('在。');
    expect(note.textContent).toContain('remember');
    expect(note.textContent).toContain('10086');
  });

  test('没有原话时那一块是隐藏的（不显示"undefined"）', async () => {
    await bootWorkshop();
    expect(el('probe-note').hidden).toBe(true);
  });

  test('群列表的记忆/能量列：索引里没写就自己读文件', async () => {
    storageMap.set('state/groups', JSON.stringify([
      { id: '10086', name: '测试群', count: 3, lastAt: Date.now() },
    ]));
    storageMap.set('state/energy/10086', JSON.stringify({ value: 0.42, at: 1 }));
    storageMap.set('memory/10086/notes', JSON.stringify([{ text: 'a', at: 1 }, { text: 'b', at: 2 }]));
    await bootWorkshop();

    const cells = [...document.querySelectorAll('#groups-body tr td')].map((td) => td.textContent);
    expect(cells).toContain('2 条');
    expect(cells).toContain('42');
  });
});

// --- 长短期记忆、个人账号、沉默时的表情回应 -----------------------------------
//
// 三件事：① 被 @ 了但选择沉默时贴个表情回应，别一点动静都没有；
// ② 记忆挂到 QQ 号上（昵称会改），昵称/旧名都能认回同一个人；
// ③ 待办这类"做完就该忘"的事走独立的短期记忆，不污染长期 notes。

describe('长短期记忆与表情回应', () => {
  function groupSends() {
    return requestsFor('net.fetch')
      .filter((r) => String(r.payload.url).includes('/api/send_group_message') && !String(r.payload.url).includes('_reaction'));
  }

  function reactions() {
    return requestsFor('net.fetch').filter((r) => String(r.payload.url).includes('send_group_message_reaction'));
  }

  test('被 @ 了但选择沉默：给那条消息贴个表情回应，一个字都不发', async () => {
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ seq: 21, segments: [mention(), { type: 'text', data: { text: '在吗' } }] }));
    const call = requestsFor('llm.chat').slice(-1)[0];
    answer(call.id, { text: '{"silent":true}' });
    await pump(60);

    expect(groupSends(), '不该发文字').toHaveLength(0);
    const r = reactions();
    expect(r, '没有贴表情回应').toHaveLength(1);
    const body = JSON.parse(r[0].payload.body);
    expect(body.message_seq).toBe(21);
    expect(body.is_add).toBe(true);
    expect(body.reaction_type).toBe('face');
  });

  test('没被 @ 的沉默（攒批）不贴表情：没人问它，别去打扰', async () => {
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ seq: 22, segments: [{ type: 'text', data: { text: '随便聊聊' } }] }));
    await pump(20);
    expect(reactions()).toHaveLength(0);
  });

  test('remember 带 who：存成 QQ 号，注入时把名字写在前面', async () => {
    membersAvailable = true;
    groupMembers = [{ id: '20001', card: '时先思', nickname: 'sxs', role: 'member' }];
    // 这条用例要连问两次：关掉每群冷却，否则第二条会排队等 5 秒。
    await bootBot({ values: { cooldownSec: '0' } });
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '我在考研' } }] }));
    const call = requestsFor('llm.chat').slice(-1)[0];
    answer(call.id, { text: '加油。\n```json\n{"remember":[{"text":"在考研","who":"时先思"}]}\n```' });
    await pump(90);

    const notes = JSON.parse(storageMap.get('memory/10086/notes'));
    expect(notes[0]).toMatchObject({ text: '在考研', who: '20001', whoName: '时先思' });

    // 下一轮提问时，这条记忆带着名字出现。
    await deliver(groupMessage({ seq: 31, segments: [mention(), { type: 'text', data: { text: '还记得吗' } }] }));
    const next = requestsFor('llm.chat').slice(-1)[0];
    expect(next.payload.system).toContain('时先思：在考研');
  });

  test('换昵称之后：旧名字仍然能 @ 到同一个人（friends-index）', async () => {
    // 第一次出现叫"小明"，后来改叫"阿明"；改完之后说"叫小明"也要认得出 20001。
    membersAvailable = true;
    groupMembers = [{ id: '20001', card: '阿明', nickname: 'am', role: 'member' }];
    storageMap.set('memory/friends/20001', JSON.stringify({
      nickname: '阿明', aliases: ['小明'], info: '', lastSeenAt: 1, groups: ['10086'],
    }));
    storageMap.set('memory/friends-index', JSON.stringify({ '阿明': '20001', '小明': '20001' }));
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '叫小明过来' } }] }));
    const call = requestsFor('llm.chat').slice(-1)[0];
    answer(call.id, { text: '好。\n```json\n{"at":["小明"]}\n```' });
    await pump(90);

    const sends = groupSends();
    const body = JSON.parse(sends[sends.length - 1].payload.body);
    const atSeg = body.message.find((seg) => seg.type === 'mention');
    expect(atSeg, '旧名字没有解析成人').toBeTruthy();
    expect(String(atSeg.data.user_id)).toBe('20001');
  });

  test('待办走短期记忆：不写进 notes，做完用 done 消掉', async () => {
    await bootBot({ values: { cooldownSec: '0' } });
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '记得问我考得怎么样' } }] }));
    const call = requestsFor('llm.chat').slice(-1)[0];
    answer(call.id, { text: '行。\n```json\n{"todo":["问他考得怎么样"]}\n```' });
    await pump(90);

    expect(JSON.parse(storageMap.get('memory/10086/todo'))[0].text).toBe('问他考得怎么样');
    expect(storageMap.get('memory/10086/notes') || '[]', '待办不该进长期记忆').not.toContain('考得怎么样');

    // 下一轮提问时，待办出现在专属那一段里。
    await deliver(groupMessage({ seq: 41, segments: [mention(), { type: 'text', data: { text: '在吗' } }] }));
    const next = requestsFor('llm.chat').slice(-1)[0];
    expect(next.payload.system).toContain('还没做完的事');
    expect(next.payload.system).toContain('问他考得怎么样');

    answer(next.id, { text: '问过了。\n```json\n{"done":["考得怎么样"]}\n```' });
    await pump(90);
    expect(JSON.parse(storageMap.get('memory/10086/todo'))).toHaveLength(0);
  });

  test('短期记忆 24 小时后自动过期', async () => {
    storageMap.set('memory/10086/todo', JSON.stringify([
      { text: '昨天的待办', at: Date.now() - 25 * 3600_000 },
      { text: '刚记的待办', at: Date.now() },
    ]));
    await bootBot();
    hostEmits('ws.state', { state: 'open' });
    await pump();
    await deliver(groupMessage({ segments: [mention(), { type: 'text', data: { text: '在吗' } }] }));
    const call = requestsFor('llm.chat').slice(-1)[0];
    expect(call.payload.system).toContain('刚记的待办');
    expect(call.payload.system).not.toContain('昨天的待办');
  });
});

// --- 变化通知（config / storage / share） -------------------------------------
//
// 真机日志里 qq 一小时 158 次 config.get、197 次 storage.get、182 次 share.get —— 三处轮询：
// 设置 10 秒一拍、B 站桥 5 秒一拍。宿主现在会推（手册 §7.1 / §7.2），所以这些定时器只剩兜底，
// 下面钉住"事件到了就立刻读"和"兜底间隔没有被谁悄悄调回去"。
describe('变化通知', () => {
  test('config.changed 到了就立刻重读设置（不等兜底）', async () => {
    await bootBot({ values: {} });
    const before = requestsFor('config.get').length;
    hostEmits('config.changed', { pluginId: 'com.shixiansi.plugin-qq' });
    await pump(6);
    expect(requestsFor('config.get').length, 'config.changed 没有触发 config.get').toBeGreaterThan(before);
  });

  test('config.changed 不是自己那份时不重读', async () => {
    await bootBot({ values: {} });
    const before = requestsFor('config.get').length;
    hostEmits('config.changed', { pluginId: 'com.example.someone-else' });
    await pump(6);
    expect(requestsFor('config.get').length).toBe(before);
  });

  test('storage.changed 到了就重读那两个住在 storage 里的开关', async () => {
    await bootBot({ values: {} });
    // 断言到**具体的键**：只数 storage.get 的话，重连之类无关的读也会让它通过（假阳性）。
    const keys = () => requestsFor('storage.get').map((req) => String(req.payload && req.payload.key));
    const before = keys().length;
    hostEmits('storage.changed', { key: 'state/core' });
    await pump(10);
    const after = keys().slice(before);
    expect(after, '记忆核心开关没被重读').toContain('state/core');
    expect(after, '接话分寸没被重读').toContain('state/persona-behavior');
  });

  test('share.changed（B 站那两个键）到了就立刻收一次共享值', async () => {
    await bootBot({ values: { biliLinkReply: 'true' } });
    const before = requestsFor('share.get').length;
    hostEmits('share.changed', { owner: 'com.shixiansi.plugin-bilibili', name: 'bili-results' });
    await pump(8);
    expect(requestsFor('share.get').length, 'share.changed 没有触发 share.get').toBeGreaterThan(before);
  });

  test('兜底间隔没有被调回去（60 秒设置 / 30 秒 B 站桥）', () => {
    const proactive = readFileSync(path.join(pluginDir, 'lib', 'proactive.js'), 'utf8');
    expect(proactive, '设置兜底又变回 10 秒了').toContain('const CONFIG_POLL_MS = 60_000;');
    const admin = readFileSync(path.join(pluginDir, 'lib', 'admin.js'), 'utf8');
    expect(admin, 'B 站桥兜底又变回 5 秒了').toMatch(/\}, 30_000\);/);
  });
});

// ---------------------------------------------------------------------------
// 索引里有、字节没了：**标记，不删**（2026-11-01 事故的最终形态）
// ---------------------------------------------------------------------------
//
// 用户的话把这条钉死了：「索引才占多少内存，你就是把全部索引都删了都清不出内存」
// 「表情包也不能删啊……程序什么时候都不能自动清」。
//
// 索引条目是识图花钱换来的 tag 与描述，**不可再生**；而且它是"重扫免费"的凭据：
// importStickers 里 `if (known.has(hash)) continue;` —— 条目在，用户重发同一张图就
// 不必再识一遍。所以启动整理对空条目只做一件事：标上 `orphaned`，让界面说得清"这张的图没了"。
describe('没有字节的表情包记录：标记而不是删除', () => {
  test('图没了的条目留在索引里，只是带上 orphaned 标记', async () => {
    storageMap.set('media/stickers/index', JSON.stringify([
      { hash: 'keptAAAA', tag: '开心', description: '还在' },
      { hash: 'goneBBBB', tag: '无语', description: '图已经不在了' },
    ]));
    storageMap.set('media/stickers/bytes/keptAAAA', 'AAAA');
    await bootBot();
    const after = JSON.parse(storageMap.get('media/stickers/index') || '[]');
    // 两条都还在——一条没删。这也是"重发不用重新识图"的前提。
    expect(after.map((row) => row.hash)).toEqual(['keptAAAA', 'goneBBBB']);
    const gone = after.find((row) => row.hash === 'goneBBBB');
    const kept = after.find((row) => row.hash === 'keptAAAA');
    expect(gone.orphaned, '图没了的那条应当被标记').toBe(true);
    expect(kept.orphaned, '还有图的不该被标记').toBeUndefined();
  });

  test('全部条目都没有字节时，索引一个字都不改（不是"清空"的理由）', async () => {
    storageMap.set('media/stickers/index', JSON.stringify([
      { hash: 'goneAAAA', tag: '开心' },
      { hash: 'goneBBBB', tag: '无语' },
    ]));
    await bootBot();
    const after = JSON.parse(storageMap.get('media/stickers/index') || '[]');
    expect(after.length, '一条都不许少').toBe(2);
    for (const row of after) expect(row.orphaned).toBe(true);
  });

  test('标记是幂等的：第二次启动不会重复写，也不会因为标记而删', async () => {
    storageMap.set('media/stickers/index', JSON.stringify([
      { hash: 'goneAAAA', tag: '开心', orphaned: true },
    ]));
    const before = storageMap.get('media/stickers/index');
    await bootBot();
    expect(storageMap.get('media/stickers/index')).toBe(before);
  });

  test('图补回来了就把标记清掉（重发同一张图不必再识）', async () => {
    storageMap.set('media/stickers/index', JSON.stringify([
      { hash: 'backAAAA', tag: '开心', description: '补齐了', orphaned: true },
    ]));
    storageMap.set('media/stickers/bytes/backAAAA', 'AAAA');
    await bootBot();
    const after = JSON.parse(storageMap.get('media/stickers/index') || '[]');
    expect(after[0].orphaned, '有字节了就不该再标').toBeUndefined();
    expect(after.length).toBe(1);
  });
});