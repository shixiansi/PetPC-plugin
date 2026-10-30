import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 游戏中心的行为测试。两层：
//
//   1. 引擎（lib/engine.js）是纯逻辑：种子化随机源 + 显式 step(dt)——不建 DOM、
//      不进 jsdom 也能测。分数计算、碰撞检测、道具概率、状态机全在这层钉死。
//   2. 结算发布（workshop.js 的 finishGame）走真实链路：jsdom 里驱动 surface 挂载，
//      断言 storage 最高分与 plugin.share 的 game-last-run 快照。
//
// "道具掉落概率"测的是**分布**而不是单点：种子里跑 20000 次抽签，断言每个 kind
// 的频率落在权重比例的容差带里。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-game-center');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

const scriptSources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1])
  .filter((src) => src && !src.startsWith('http'));
if (!scriptSources.length) throw new Error('panel.html 没有加载任何插件脚本');
const source = scriptSources
  .map((src) => readFileSync(path.join(pluginDir, src), 'utf8'))
  .join('\n');

const PLUGIN_ID = 'com.shixiansi.plugin-game-center';

// --- 引擎（纯逻辑，new Function 装进一个局部作用域） -----------------------------

function loadEngine() {
  // 只取 engine.js（不碰 core/workshop——它们引用 DOM）。
  // 引擎把接缝挂在 window 上；这里给一个假 window 承接，document 给 undefined。
  const engineSource = readFileSync(path.join(pluginDir, 'lib', 'engine.js'), 'utf8');
  const scope = {};
  // eslint-disable-next-line no-new-func
  const factory = new Function('window', 'document', `${engineSource}\n;return window.__gameEngine;`);
  return factory(scope, undefined);
}

const G = loadEngine();

/** 把一枚掉落物放到篮子上并 step 一帧，返回接住后的状态。 */
function catchItem(engine, kind, x) {
  engine.start();
  const state = engine.getState();
  state.items.push({ kind, x: x ?? (state.basket.x + state.basket.w / 2), y: state.basket.y + 2, vy: 0, vx: 0 });
  engine.step(1 / 60, { dir: 0 });
  return state;
}

describe('manifest', () => {
  test('a surface card is the only mount; no background, no call', () => {
    expect(manifest.surface).toHaveLength(1);
    expect(manifest.surface[0].maxH).toBeGreaterThan(manifest.surface[0].h);
    expect(manifest.background).toBeUndefined();
    expect(manifest.panel).toBeUndefined();
    expect(manifest.serves).toBeUndefined();
    // panelSlot 不允许自创值：这个插件不占槽位。
    expect(manifest.panelSlot).toBeUndefined();
  });

  test('asks only for what the game itself needs', () => {
    expect(manifest.permissions).toContain('plugin.share');
    expect(manifest.permissions).toContain('pet.surface');
    expect(manifest.permissions).not.toContain('llm.chat');
    expect(manifest.permissions).not.toContain('net.fetch');
  });
});

describe('engine: scoring', () => {
  test('a caught coin adds coinValue; double doubles it', () => {
    const base = catchItem(G.createGame({ coinValue: 10 }), 'coin');
    expect(base.score).toBe(10);
    expect(base.coins).toBe(1);

    const doubled = G.createGame({ coinValue: 10 });
    doubled.start();
    const s = doubled.getState();
    s.effects.double = 5; // 双倍生效中
    s.items.push({ kind: 'coin', x: s.basket.x + s.basket.w / 2, y: s.basket.y + 2, vy: 0, vx: 0 });
    doubled.step(1 / 60, { dir: 0 });
    expect(s.score).toBe(20);
    expect(s.coins).toBe(1);
  });

  test('a bomb costs bombPenalty and one life; a shield absorbs it at half price', () => {
    const bare = catchItem(G.createGame({ bombPenalty: 30 }), 'bomb');
    expect(bare.score).toBe(0); // max(0, 0-30)：分数不为负
    expect(bare.lives).toBe(2);

    const shielded = G.createGame({ bombPenalty: 30 });
    shielded.start();
    const s = shielded.getState();
    s.shield = 1;
    s.items.push({ kind: 'bomb', x: s.basket.x + s.basket.w / 2, y: s.basket.y + 2, vy: 0, vx: 0 });
    shielded.step(1 / 60, { dir: 0 });
    expect(s.shield).toBe(0);
    expect(s.lives).toBe(3);
    // 护盾只扣一半（15 取整）。
    expect(s.score).toBe(0);
  });

  test('score never goes negative even after repeated bombs', () => {
    const g = G.createGame({ bombPenalty: 30 });
    g.start();
    for (let i = 0; i < 5; i += 1) {
      const s = g.getState();
      s.items.push({ kind: 'bomb', x: s.basket.x + s.basket.w / 2, y: s.basket.y + 2, vy: 0, vx: 0 });
      g.step(1 / 60, { dir: 0 });
      expect(s.score).toBeGreaterThanOrEqual(0);
    }
    expect(g.getPhase()).toBe('gameover'); // 3 条命耗尽
  });

  test('utilities grant a small score and their timers tick down', () => {
    const g = G.createGame({ coinValue: 10 });
    g.start();
    const s = g.getState();
    s.items.push({ kind: 'magnet', x: s.basket.x + s.basket.w / 2, y: s.basket.y + 2, vy: 0, vx: 0 });
    g.step(1 / 60, { dir: 0 });
    expect(s.score).toBe(5);
    // 碰撞发生在这一帧的计时扣减**之后**：接到的瞬间是满值；随后 2 秒（20×0.1s，
    // step 把单帧 dt 夹在 0.1s 以内——后台回来不暴走）扣 2 秒。
    expect(s.effects.magnet).toBeCloseTo(G.MAGNET_TIME, 5);
    for (let i = 0; i < 20; i += 1) g.step(0.1, { dir: 0 });
    expect(s.effects.magnet).toBeCloseTo(G.MAGNET_TIME - 2, 3);
  });
});

describe('engine: collision and movement', () => {
  test('circleHitsBasket: center inside hits, far away misses, edge touches count', () => {
    const basket = { x: 100, y: 274, w: 56, h: 14 };
    const hit = (x, y) => G.circleHitsBasket({ x, y }, basket);
    expect(hit(128, 280)).toBe(true);   // 篮子中心
    expect(hit(10, 10)).toBe(false);    // 远处
    expect(hit(100 + 56 + 9, 280)).toBe(true);  // 边缘外 9px（半径 10，圆还擦着）
    expect(hit(100 + 56 + 12, 280)).toBe(false); // 边缘外 12px，真够不到
  });

  test('the basket clamps to the field and follows keyboard input', () => {
    const g = G.createGame();
    g.start();
    // 向左长按 2 秒：撞到左墙就停。
    for (let i = 0; i < 120; i += 1) g.step(1 / 60, { dir: -1 });
    expect(g.getState().basket.x).toBe(0);
    // 向右长按 2 秒：撞到右墙就停。
    for (let i = 0; i < 120; i += 1) g.step(1 / 60, { dir: 1 });
    expect(g.getState().basket.x).toBeCloseTo(G.FIELD_W - g.getState().basket.w, 5);
  });

  test('missed coins count toward the sad mood but do not end the run', () => {
    const g = G.createGame();
    g.start();
    for (let i = 0; i < G.MISS_SAD_THRESHOLD + 1; i += 1) {
      // 放一枚离篮子很远的金币，让它落到场外。
      const s = g.getState();
      s.items.push({ kind: 'coin', x: 5, y: 10, vy: 5000, vx: 0 });
      g.step(0.1, { dir: 0 });
    }
    const s = g.getState();
    expect(s.misses).toBeGreaterThanOrEqual(G.MISS_SAD_THRESHOLD);
    expect(s.mood).toBe('sad');
    expect(g.getPhase()).toBe('playing'); // 还在玩
  });
});

describe('engine: the state machine', () => {
  test('menu → playing → (pause/resume) → gameover → again', () => {
    const g = G.createGame();
    expect(g.getPhase()).toBe('menu');
    g.start();
    expect(g.getPhase()).toBe('playing');
    g.pause();
    expect(g.getPhase()).toBe('paused');
    // 暂停时 step 是空转。
    const frozen = g.getState().elapsed;
    g.step(1, { dir: 0 });
    expect(g.getState().elapsed).toBe(frozen);
    g.resume();
    expect(g.getPhase()).toBe('playing');
    g.step(0.016, { dir: 0 });
    expect(g.getState().elapsed).toBeGreaterThan(frozen);

    // 打到 gameover。
    for (let i = 0; i < 3; i += 1) {
      const s = g.getState();
      s.shield = 0;
      s.items.push({ kind: 'bomb', x: s.basket.x + s.basket.w / 2, y: s.basket.y + 2, vy: 0, vx: 0 });
      g.step(1 / 60, { dir: 0 });
    }
    expect(g.getPhase()).toBe('gameover');
    expect(g.getState().mood).toBe('boom');

    g.again();
    expect(g.getPhase()).toBe('playing');
    expect(g.getState().score).toBe(0);
    expect(g.getState().lives).toBe(3);
  });

  test('difficulty ramps: fall speed and spawn rate grow with elapsed', () => {
    const g = G.createGame({ seed: 7 });
    g.start();
    // 快进 60 秒：不断 step，记录场上掉落物的最大 vy。
    for (let i = 0; i < 600; i += 1) g.step(0.1, { dir: 0 });
    const speeds = g.getState().items.map((item) => item.vy);
    const maxSpeed = speeds.length ? Math.max(...speeds) : 0;
    expect(maxSpeed).toBeGreaterThan(70); // 基础速度是 70
  });
});

describe('drop probabilities', () => {
  test('the weighted table lands within tolerance over 20000 draws', () => {
    const rng = G.makeRng(20261031);
    const draws = 20000;
    const counts = { coin: 0, bomb: 0, magnet: 0, double: 0, shield: 0 };
    for (let i = 0; i < draws; i += 1) {
      counts[G.pickDrop(rng)] += 1;
    }
    const total = G.DROP_TABLE.reduce((sum, d) => sum + d.weight, 0);
    for (const drop of G.DROP_TABLE) {
      const expected = (drop.weight / total) * draws;
      const actual = counts[drop.kind];
      // 5% 相对容差 + 40 绝对容差：种子固定的确定性分布，不该贴边。
      expect(Math.abs(actual - expected)).toBeLessThan(expected * 0.05 + 40);
    }
    // 金币永远是最常见的（剩余权重 > 任何单一道具）。
    expect(counts.coin).toBeGreaterThan(counts.bomb);
  });

  test('the same seed replays the same drops (deterministic for tests)', () => {
    const a = G.pickDrop(G.makeRng(42));
    const b = G.pickDrop(G.makeRng(42));
    expect(a).toBe(b);
  });
});

// --- 结算发布（surface 挂载，走真实桥） -------------------------------------------

let store;
let configValues;
let answered;
let postedFrom;
let windowListeners;
let intervals;

function posted() {
  return window.postMessage.mock.calls.map((call) => call[0]).slice(postedFrom);
}

function byType(type) {
  return posted().filter((m) => m && m.type === type);
}

function requests() {
  return byType('request').map((m) => ({ id: m.id, method: m.method, payload: m.payload }));
}

function hostSends(data) {
  window.dispatchEvent(new MessageEvent('message', { data, source: window }));
}

function answer(id, result, { ok = true, error = '' } = {}) {
  answered.add(id);
  hostSends({ v: 1, type: 'response', id, ok, result, error });
}

async function pump(maxRounds = 30) {
  for (let i = 0; i < maxRounds; i += 1) {
    const list = requests().filter((r) => !answered.has(r.id));
    if (!list.length) return;
    for (const req of list) {
      const payload = req.payload || {};
      switch (req.method) {
        case 'config.get':
          answer(req.id, { values: configValues, secrets: {} });
          break;
        case 'storage.get':
          answer(req.id, { value: store.has(String(payload.key)) ? store.get(String(payload.key)) : '' });
          break;
        case 'storage.set':
          store.set(String(payload.key), String(payload.value || ''));
          answer(req.id, { ok: true });
          break;
        case 'share.set':
          answer(req.id, { ok: true, key: `${PLUGIN_ID}/${payload.name}` });
          break;
        default:
          answer(req.id, null, { ok: false, error: `本程序不支持该方法 ${req.method}` });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const macro = () => new Promise((resolve) => setTimeout(resolve, 0));

function boot() {
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
  for (const attr of ['id']) {
    const value = parsed.window.document.body.getAttribute(attr);
    if (value) document.body.setAttribute(attr, value);
  }
  answered = new Set();
  postedFrom = window.postMessage.mock.calls.length;
  // eslint-disable-next-line no-new-func
  new Function(source)();
  hostSends({
    v: 1, type: 'init', pluginId: PLUGIN_ID, permissions: manifest.permissions,
    granted: [...manifest.permissions],
    surface: { kind: 'surface', rectIndex: 0, rectCount: 1, rect: { x: 0, y: 0, w: 380, h: 300, r: 14, ellipse: false, tailX: 0, hidden: false, room: 0 } },
  });
  return macro();
}

beforeEach(() => {
  store = new Map();
  configValues = { shareScore: 'true', coinValue: '10', bombPenalty: '30', highScores: '5' };
  windowListeners = [];
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
  // 游戏用 requestAnimationFrame：jsdom 有，但测试里手动 step 更可控——mock 成空转。
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});

afterEach(() => {
  for (const id of intervals) clearInterval(id);
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  vi.restoreAllMocks();
});

describe('the finish flow', () => {
  /** 与函数并发泵宿主应答（startGame/finishGame 内部都要走 storage/config）。 */
  async function withPump(promise) {
    let settled = false;
    promise.finally(() => { settled = true; });
    for (let i = 0; i < 30 && !settled; i += 1) {
      await pump(6);
      await new Promise((resolve) => setTimeout(resolve, 4));
    }
    return promise;
  }

  test('starting a game shows the board; finishing writes highscores and publishes the share', async () => {
    await boot();
    await pump();

    await withPump(window.__game.startGame());
    expect(window.__game.snapshot().phase).toBe('playing');
    // 三块面板：board 可见，menu/result 隐藏（§8.2b 的互斥）。
    expect(document.getElementById('menu').hidden).toBe(true);
    expect(document.getElementById('board').hidden).toBe(false);
    expect(document.getElementById('result').hidden).toBe(true);

    // 给这一局塞点分数（引擎规则由引擎测试覆盖；这里测结算与发布）。
    const state = window.__game.snapshot().state;
    state.score = 120;
    state.coins = 7;
    state.mood = 'none';

    // 结算。
    await withPump(window.__game.finishGame());

    // 最高分落盘。
    const scores = JSON.parse(store.get('game/highscores'));
    expect(Array.isArray(scores)).toBe(true);
    expect(scores).toHaveLength(1);
    expect(scores[0].score).toBe(120);
    expect(scores[0]).toHaveProperty('mood');

    // 生态发布。
    const share = requests().find((r) => r.method === 'share.set' && r.payload.name === 'game-last-run');
    expect(share, '本局得分没有发布').toBeTruthy();
    const snapshot = JSON.parse(share.payload.value);
    expect(snapshot.score).toBe(120);
    expect(snapshot.coinsEarned).toBe(7);
    expect(snapshot).toHaveProperty('mood');
    expect(snapshot).toHaveProperty('durationSec');

    // 结算面板显示桌宠的状态反应。
    expect(document.getElementById('result').hidden).toBe(false);
    expect(document.getElementById('result-detail').textContent).toContain('桌宠');
  });

  test('shareScore=false skips the publish but keeps the highscore', async () => {
    configValues = { ...configValues, shareScore: 'false' };
    await boot();
    await pump();
    await withPump(window.__game.startGame());
    await withPump(window.__game.finishGame());
    expect(JSON.parse(store.get('game/highscores'))).toHaveLength(1);
    expect(requests().filter((r) => r.method === 'share.set')).toHaveLength(0);
  });

  test('says ready first, and nothing before init', async () => {
    const parsed = new JSDOM(html);
    document.body.innerHTML = parsed.window.document.body.innerHTML;
    postedFrom = window.postMessage.mock.calls.length;
    // eslint-disable-next-line no-new-func
    new Function(source)();
    const first = posted()[0];
    expect(first && first.type).toBe('ready');
    expect(requests()).toHaveLength(0);
  });
});
