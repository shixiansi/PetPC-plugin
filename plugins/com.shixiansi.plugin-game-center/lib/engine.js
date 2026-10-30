// lib/engine.js —— 「接金币」的游戏引擎：纯逻辑，不碰 DOM
//
// 面板（surface 块）只做两件事：把 requestAnimationFrame 的 tick 喂给 step()，
// 把 state 画出来。所有规则都在这里，测试直接驱动引擎、不建任何 DOM。
//
// 状态机：
//
//   menu ──start()──> playing ──生命耗尽──> gameover ──again()──> playing
//                        │  ▲
//                        └──┘ pause() / resume()
//
// 玩法：
//   · 篮子在底部，←/→ 或 A/D 移动（触屏/鼠标拖动也走 moveTo）；
//   · 金币 +coinValue 分；炸弹 -bombPenalty 分并 -1 命（护盾挡一次）；
//   · 道具：magnet（一段时间内金币被吸向篮子）、double（一段时间内金币双倍）、
//     shield（护盾 +1，最多 1 层）；
//   · 漏接金币不扣分（这是休闲游戏，不是考试），但漏 3 枚会让桌宠"失落"——
//     结算面板会显示这个状态给生态那边；
//   · 难度随时间上升：下落速度与生成频率都跟着 elapsed 走。

'use strict';

// --- 常量与调参 -----------------------------------------------------------------

const GameEngine = { VERSION: '0.1.0' };

/** 画布逻辑尺寸（surface 块 380×300 的内部坐标系）。 */
const FIELD_W = 380;
const FIELD_H = 300;

/** 篮子。 */
const BASKET_W = 56;
const BASKET_H = 14;
const BASKET_Y = FIELD_H - 26;
const BASKET_SPEED = 260; // px/s，键盘移动
/** 篮子移动的平滑系数（0=瞬移，1=不动）。 */
const BASKET_EASE = 0.0009;

/** 掉落物。 */
const ITEM_R = 10;           // 半径（碰撞按圆算）
const BASE_FALL_SPEED = 70;  // px/s，难度 0 时
const FALL_SPEED_GROWTH = 6; // 每秒加多少
const BASE_SPAWN_EVERY = 0.9; // 秒，难度 0 时的生成间隔
const SPAWN_EASY_FLOOR = 0.35; // 生成间隔的下限

/** 道具效果时长（秒）。 */
const MAGNET_TIME = 6;
const DOUBLE_TIME = 8;

/** 道具掉落概率（coin 是隐含的"剩余权重"：30 权重的道具对 70 权重的金币）。 */
const DROP_TABLE = [
  { kind: 'coin', weight: 70 },
  { kind: 'bomb', weight: 14 },
  { kind: 'magnet', weight: 6 },
  { kind: 'double', weight: 6 },
  { kind: 'shield', weight: 4 },
];

/** 漏接多少枚金币触发桌宠的"失落"。 */
const MISS_SAD_THRESHOLD = 3;

// --- 工具 ----------------------------------------------------------------------

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/** 按权重表随机一个 kind。rng 注入（测试用种子），不直接 Math.random。 */
function pickDrop(rng) {
  const total = DROP_TABLE.reduce((sum, d) => sum + d.weight, 0);
  let roll = rng() * total;
  for (const drop of DROP_TABLE) {
    roll -= drop.weight;
    if (roll <= 0) return drop.kind;
  }
  return 'coin';
}

/** 一个可注入的确定性随机源（mulberry32）。 */
function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 圆-矩形碰撞：篮子按矩形算，掉落物按圆算。 */
function circleHitsBasket(item, basket) {
  const cx = clamp(item.x, basket.x, basket.x + basket.w);
  const cy = clamp(item.y, basket.y, basket.y + basket.h);
  const dx = item.x - cx;
  const dy = item.y - cy;
  return dx * dx + dy * dy <= ITEM_R * ITEM_R;
}

// --- 引擎本体 --------------------------------------------------------------------

/**
 * 创建一个引擎实例。
 *
 * @param {object} opts {seed?, coinValue?, bombPenalty?}
 * @returns 引擎对象：state 快照 + start/step/moveTo/pause/resume/again。
 */
function createGame(opts) {
  const settings = {
    coinValue: Number(opts && opts.coinValue) > 0 ? Number(opts.coinValue) : 10,
    bombPenalty: Number(opts && opts.bombPenalty) >= 0 ? Number(opts.bombPenalty) : 30,
  };
  const rng = makeRng((opts && opts.seed) || (Date.now() & 0xffffffff));

  let phase = 'menu';          // menu | playing | paused | gameover
  let state = null;
  let spawnTimer = 0;
  let lastTickAt = 0;

  function freshState() {
    return {
      elapsed: 0,
      score: 0,
      coins: 0,
      lives: 3,
      shield: 0,
      misses: 0,
      basket: { x: FIELD_W / 2 - BASKET_W / 2, y: BASKET_Y, w: BASKET_W, h: BASKET_H, dir: 0 },
      items: [],
      effects: { magnet: 0, double: 0 },
      // 结算时给生态的状态：win=接得漂亮，sad=漏了太多，boom=被炸弹终结。
      mood: 'none',
    };
  }

  // --- 内部步骤 ---------------------------------------------------------------

  function difficulty() {
    return state.elapsed; // 秒；下落速度与生成频率都以它为自变量
  }

  function spawnItem() {
    const kind = pickDrop(rng);
    const speed = BASE_FALL_SPEED + FALL_SPEED_GROWTH * Math.min(difficulty(), 60);
    state.items.push({
      kind,
      x: ITEM_R + rng() * (FIELD_W - ITEM_R * 2),
      y: -ITEM_R,
      vy: speed * (0.85 + rng() * 0.3),
      vx: 0,
    });
  }

  /** 磁铁效果：把金币往篮子中心水平拉。 */
  function applyMagnet(item, dt) {
    if (state.effects.magnet <= 0) return;
    if (item.kind !== 'coin') return;
    const target = state.basket.x + state.basket.w / 2;
    const pull = 240 * dt;
    if (Math.abs(item.x - target) <= pull) item.x = target;
    else item.x += Math.sign(target - item.x) * pull;
  }

  function catchItem(item) {
    if (item.kind === 'coin') {
      const value = state.effects.double > 0 ? settings.coinValue * 2 : settings.coinValue;
      state.score += value;
      state.coins += 1;
      return;
    }
    if (item.kind === 'bomb') {
      if (state.shield > 0) {
        state.shield -= 1;
        state.score = Math.max(0, state.score - Math.floor(settings.bombPenalty / 2));
      } else {
        state.score = Math.max(0, state.score - settings.bombPenalty);
        state.lives -= 1;
      }
      return;
    }
    if (item.kind === 'magnet') state.effects.magnet = MAGNET_TIME;
    if (item.kind === 'double') state.effects.double = DOUBLE_TIME;
    if (item.kind === 'shield') state.shield = 1;
    state.score += 5;
  }

  function finish(mood) {
    state.mood = mood;
    phase = 'gameover';
  }

  /** 推进一帧。dt 秒；输入：basket.dir ∈ {-1, 0, 1} 或 moveTo 的目标。 */
  function step(dt, input) {
    if (phase !== 'playing') return state;
    const d = Math.min(Math.max(Number(dt) || 0, 0), 0.1); // 一帧最多 100ms（后台回来不暴走）

    state.elapsed += d;

    // 篮子：键盘方向 + 可选的指针目标（input.x 存在时向它滑动）。
    const basket = state.basket;
    if (input && Number.isFinite(input.x)) {
      const target = clamp(input.x - basket.w / 2, 0, FIELD_W - basket.w);
      const delta = target - basket.x;
      basket.x += delta * Math.min(1, BASKET_EASE * 1000 * d + 0.5);
      basket.dir = Math.sign(delta);
    } else if (input && Number.isFinite(input.dir)) {
      basket.dir = Math.sign(input.dir);
      basket.x = clamp(basket.x + basket.dir * BASKET_SPEED * d, 0, FIELD_W - basket.w);
    }

    // 效果计时。
    if (state.effects.magnet > 0) state.effects.magnet = Math.max(0, state.effects.magnet - d);
    if (state.effects.double > 0) state.effects.double = Math.max(0, state.effects.double - d);

    // 生成。
    spawnTimer += d;
    const every = Math.max(SPAWN_EASY_FLOOR, BASE_SPAWN_EVERY - difficulty() * 0.008);
    while (spawnTimer >= every) {
      spawnTimer -= every;
      spawnItem();
    }

    // 掉落与碰撞。
    const keep = [];
    for (const item of state.items) {
      applyMagnet(item, d);
      item.y += item.vy * d;
      if (circleHitsBasket(item, basket)) {
        catchItem(item);
        continue;
      }
      if (item.y - ITEM_R > FIELD_H) {
        if (item.kind === 'coin') state.misses += 1;
        continue;
      }
      keep.push(item);
    }
    state.items = keep;

    // 终局判定。
    if (state.lives <= 0) {
      finish(state.misses >= MISS_SAD_THRESHOLD ? 'boom-sad' : 'boom');
      return state;
    }

    // 漏接只记情绪，不结束：休闲游戏不该因为漏 3 枚就把人赶出结算。
    if (state.misses >= MISS_SAD_THRESHOLD && state.mood === 'none') {
      state.mood = 'sad';
    }

    return state;
  }

  // --- 对外动作 -----------------------------------------------------------------

  function start() {
    state = freshState();
    spawnTimer = 0;
    phase = 'playing';
    lastTickAt = Date.now();
    return state;
  }

  function pause() {
    if (phase === 'playing') phase = 'paused';
    return phase;
  }

  function resume() {
    if (phase === 'paused') {
      phase = 'playing';
      lastTickAt = Date.now();
    }
    return phase;
  }

  /** 结算后再来一局：直接进 playing（开始菜单只在首次与主动返回时显示）。 */
  function again() {
    return start();
  }

  function toMenu() {
    phase = 'menu';
    state = null;
    return phase;
  }

  function getPhase() {
    return phase;
  }

  function getState() {
    return state;
  }

  return {
    settings,
    start,
    step,
    pause,
    resume,
    again,
    toMenu,
    getPhase,
    getState,
    // 测试与渲染都用的常量。
    FIELD_W,
    FIELD_H,
    ITEM_R,
    MISS_SAD_THRESHOLD,
  };
}

// 挂到 window 上（经典脚本共享作用域；测试里同样以全局函数注入）。
if (typeof window !== 'undefined') {
  window.__gameEngine = {
    createGame,
    makeRng,
    pickDrop,
    circleHitsBasket,
    FIELD_W,
    FIELD_H,
    BASKET_W,
    BASKET_Y,
    DROP_TABLE,
    MAGNET_TIME,
    DOUBLE_TIME,
    MISS_SAD_THRESHOLD,
  };
}
