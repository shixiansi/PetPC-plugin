// lib/workshop.js —— surface 块上的渲染与交互
//
// 引擎（lib/engine.js）管规则，这里只管三件事：
//
//   1. 三块面板的显隐：开始菜单 / 游戏板（含 HUD）/ 结算——**同一时刻只有一块可见**
//      （手册 §8.2b 的教训：卡片是固定矩形，两块都可见就是两块都被裁）；
//   2. requestAnimationFrame 的 tick → engine.step(dt)，再把 state 画进 DOM
//      （掉落物用绝对定位的小元素，不用 canvas——沙箱 iframe 里 canvas 也可以，
//      但 DOM 元素让 ui-tokens 的颜色检查与深浅主题自动生效）；
//   3. 结算时写 storage（最高分）+ share.set（发布给生态）。
//
// 键盘：←/→ 或 A/D 移动；空格开始/再来。指针：在板上按下并拖动 = moveTo。

'use strict';

const GAME_KEY = 'game/highscores';
const HIGHSCORE_CAP_DEFAULT = 5;

let game = null;          // createGame() 的实例
let rafId = 0;
let playing = false;
let pointerActive = false;

// --- DOM 构建 -----------------------------------------------------------------

function el(tag, className, body) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (body !== undefined) node.textContent = body;
  return node;
}

/** 一颗掉落物的 DOM 元素（kind 决定样式类）。 */
function makeItemEl(kind) {
  return el('span', `item item-${kind}`);
}

/** 把引擎状态画进 DOM：掉落物按需增删、篮子与 HUD 就地更新。 */
function paint() {
  const state = game.getState();
  if (!state || !els.board) return;

  // 掉落物：以 items 数组为准增删（引擎每帧都重建数组）。
  const existing = els.board.querySelectorAll('.item');
  if (existing.length !== state.items.length) {
    els.board.querySelectorAll('.item').forEach((n) => n.remove());
    for (const item of state.items) {
      const node = makeItemEl(item.kind);
      els.board.append(node);
    }
  }
  const nodes = els.board.querySelectorAll('.item');
  state.items.forEach((item, index) => {
    const node = nodes[index];
    if (!node) return;
    node.style.left = `${Math.round(item.x - game.ITEM_R)}px`;
    node.style.top = `${Math.round(item.y - game.ITEM_R)}px`;
  });

  // 篮子。
  const basketNode = els.board.querySelector('.basket');
  if (basketNode) {
    basketNode.style.left = `${Math.round(state.basket.x)}px`;
  }

  // HUD。
  if (els.hudScore) els.hudScore.textContent = `${state.score} 分 · 金币 ${state.coins}`;
  if (els.hudLives) {
    els.hudLives.textContent = '♥'.repeat(Math.max(0, state.lives)) + '♡'.repeat(Math.max(0, 3 - state.lives));
  }
  if (els.hudEffects) {
    const bits = [];
    if (state.effects.magnet > 0) bits.push(`磁铁 ${Math.ceil(state.effects.magnet)}s`);
    if (state.effects.double > 0) bits.push(`双倍 ${Math.ceil(state.effects.double)}s`);
    if (state.shield > 0) bits.push('护盾');
    els.hudEffects.textContent = bits.join(' · ');
  }
}

/** 主循环：真实时间步进（暂停时不 tick）。 */
function loop() {
  if (!playing) return;
  const state = game.getState();
  void state;
  const input = currentInput();
  game.step(1 / 60, input);
  paint();
  const phase = game.getPhase();
  if (phase === 'gameover') {
    void finishGame().catch(() => {});
    return;
  }
  rafId = requestAnimationFrame(loop);
}

/** 键盘与指针的合成输入。 */
let keyDir = 0;
let pointerX = null;

function currentInput() {
  if (pointerActive && pointerX != null) return { x: pointerX };
  return { dir: keyDir };
}

// --- 开始 / 结束 ---------------------------------------------------------------

function showPanel(name) {
  if (els.menu) els.menu.hidden = name !== 'menu';
  if (els.board) els.board.hidden = name !== 'board';
  if (els.result) els.result.hidden = name !== 'result';
  // 三块之外的东西（HUD 属于 board）一并由 hidden 属性管。
}

async function startGame() {
  await refreshConfig();
  game = createGame({
    coinValue: num('coinValue', 1, 1000, 10),
    bombPenalty: num('bombPenalty', 0, 1000, 30),
  });
  game.start();
  playing = true;
  showPanel('board');
  if (els.board) {
    // 篮子元素只需要一个；掉落物由 paint 增删。
    if (!els.board.querySelector('.basket')) {
      els.board.append(el('span', 'basket'));
    }
  }
  say('');
  paint();
  if (!rafId) rafId = requestAnimationFrame(loop);
}

async function finishGame() {
  playing = false;
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  const state = game.getState();

  // 最高分（本地）。
  const cap = num('highScores', 1, 20, HIGHSCORE_CAP_DEFAULT);
  const list = await readJSON(GAME_KEY, []);
  const scores = (Array.isArray(list) ? list : [])
    .concat([{ at: now(), score: state.score, coins: state.coins, mood: state.mood }])
    .sort((a, b) => b.score - a.score)
    .slice(0, cap);
  try {
    await writeJSON(GAME_KEY, scores);
  } catch {
    // 记不上就记不上：这一局的结算面板照常显示。
  }

  // 生态发布：plugin.share 的快照（亲密度/金币由记忆侧消费）。
  if (flag('shareScore', true) && granted.has('plugin.share')) {
    try {
      await request('share.set', {
        name: 'game-last-run',
        value: JSON.stringify({
          at: now(),
          score: state.score,
          coins: state.coins,
          coinsEarned: state.coins,
          durationSec: Math.round(state.elapsed),
          mood: state.mood,
        }),
      });
    } catch {
      // 牌盘写不进去不影响结算。
    }
  }

  // 结算面板。状态文案 = 桌宠的反应（生态那边可以根据 mood 播动画/说话）。
  const moodLine = {
    boom: '被炸弹终结了，桌宠替你惋惜。',
    'boom-sad': '炸弹加漏接，桌宠有点失落……',
    sad: '漏了太多金币，桌宠失落 地看着你。',
    none: '稳稳当当，桌宠为你欢呼！',
  }[state.mood] || '这局结束了。';
  if (els.resultTitle) els.resultTitle.textContent = `${state.score} 分`;
  if (els.resultDetail) {
    els.resultDetail.textContent =
      `金币 ${state.coins} 枚 · 坚持 ${Math.round(state.elapsed)} 秒 · ${moodLine}`;
  }
  if (els.resultBest) {
    els.resultBest.textContent = scores.length ? `本地最高：${scores[0].score} 分` : '';
  }
  showPanel('result');
  say('');
}

function backToMenu() {
  playing = false;
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  if (game) game.toMenu();
  showPanel('menu');
}

// --- 输入 ----------------------------------------------------------------------

function wireInput() {
  window.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'a' || event.key === 'A') keyDir = -1;
    else if (event.key === 'ArrowRight' || event.key === 'd' || event.key === 'D') keyDir = 1;
    else if (event.key === ' ') {
      event.preventDefault();
      const phase = game ? game.getPhase() : 'menu';
      if (phase === 'menu' || phase === 'gameover') void startGame().catch(() => {});
    } else return;
    event.preventDefault();
  });
  window.addEventListener('keyup', (event) => {
    if (['ArrowLeft', 'a', 'A', 'ArrowRight', 'd', 'D'].includes(event.key)) keyDir = 0;
  });

  if (els.board) {
    const move = (event) => {
      const rect = els.board.getBoundingClientRect();
      pointerX = ((event.clientX - rect.left) / rect.width) * game.FIELD_W;
    };
    els.board.addEventListener('pointerdown', (event) => {
      if (!playing) return;
      pointerActive = true;
      move(event);
    });
    els.board.addEventListener('pointermove', (event) => {
      if (!pointerActive) return;
      move(event);
    });
    window.addEventListener('pointerup', () => {
      pointerActive = false;
      pointerX = null;
    });
  }
}

// --- 启动 -----------------------------------------------------------------------

function wireUI() {
  if (els.play) els.play.addEventListener('click', () => void startGame().catch(() => {}));
  if (els.again) els.again.addEventListener('click', () => void startGame().catch(() => {}));
  if (els.pause) {
    els.pause.addEventListener('click', () => {
      if (!game) return;
      const phase = game.pause();
      if (phase === 'paused') {
        playing = false;
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
        els.pause.textContent = '继续';
        say('已暂停');
      } else {
        playing = true;
        els.pause.textContent = '暂停';
        say('');
        if (!rafId) rafId = requestAnimationFrame(loop);
      }
    });
  }
  wireInput();
  showPanel('menu');
}
