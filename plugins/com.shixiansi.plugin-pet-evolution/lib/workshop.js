// lib/workshop.js —— 养成面板渲染（纯 SVG/CSS 画法，只管画不做业务判断）
'use strict';

const EWS = { els: null };

const STAT_LABELS = { intellect: '智力', stamina: '体力', affinity: '亲密' };
const MOOD_LABELS = { calm: '平静', happy: '开心', tired: '累了', excited: '兴奋', levelup: '升级啦' };

function ewsCollectEls() {
  EWS.els = {};
  for (const id of [
    'chip-name', 'chip-level', 'chip-mood', 'level-label', 'exp-bar', 'exp-label',
    'friendship-label', 'points-label', 'radar', 'stat-list', 'respec',
    'feed', 'play', 'status', 'skins', 'effects-label', 'fatal',
  ]) {
    EWS.els[id] = document.getElementById(id);
  }
  return EWS.els;
}

function ewsSetStatus(text, kind) {
  const el = EWS.els && EWS.els.status;
  if (!el) return;
  el.textContent = String(text || '');
  el.classList.toggle('danger', kind === 'danger');
}

/** 画整块：等级条、好感、雷达、属性行、外观。 */
function ewsRenderProfile(profile) {
  const els = EWS.els;
  if (!els || !profile) return;
  els['chip-name'].textContent = profile.name || '小宠';
  els['chip-level'].textContent = `Lv.${profile.level}`;
  els['chip-mood'].textContent = `状态：${MOOD_LABELS[profile.mood] || profile.mood || '平静'}`;
  els['level-label'].textContent = `Lv.${profile.level}`;
  if (profile.level >= EvolutionEngine.MAX_LEVEL) {
    els['exp-bar'].style.width = '100%';
    els['exp-label'].textContent = '满级';
  } else {
    const need = EvolutionEngine.expToNext(profile.level);
    els['exp-bar'].style.width = `${Math.min(100, Math.round((profile.exp / need) * 100))}%`;
    els['exp-label'].textContent = `${profile.exp}/${need}`;
  }
  els['friendship-label'].textContent = `好感度 ${profile.friendship}/100`;
  els['points-label'].textContent = `可用属性点 ${profile.statPoints}`;
  els['effects-label'].textContent = (() => {
    const fx = EvolutionEngine.statEffects(profile);
    return `对话深度 ${fx.chatDepth} 字 · 每小时互动 ${fx.interactionsPerHour} 次 · 好感倍率 ×${fx.friendshipRate.toFixed(1)}`;
  })();

  ewsRenderRadar(profile);
  ewsRenderStatList(profile);
  ewsRenderSkins(profile);
}

/** 纯 SVG 雷达图：三轴（智力/体力/亲密），值域 0-99。 */
function ewsRenderRadar(profile) {
  const svg = EWS.els && EWS.els.radar;
  if (!svg) return;
  const CX = 100;
  const CY = 104;
  const R = 62;
  const stats = ['intellect', 'stamina', 'affinity'];
  // 顶点角度：-90° 起，每 120° 一轴。
  const angles = stats.map((_, i) => (-90 + i * 120) * (Math.PI / 180));
  const point = (i, ratio) => [CX + Math.cos(angles[i]) * R * ratio, CY + Math.sin(angles[i]) * R * ratio];
  const parts = [];
  // 网格：3 圈同心三角 + 轴线。
  for (const ratio of [1 / 3, 2 / 3, 1]) {
    const pts = stats.map((_, i) => point(i, ratio).map((v) => v.toFixed(1)).join(',')).join(' ');
    parts.push(`<polygon class="grid-line" points="${pts}" />`);
  }
  for (let i = 0; i < stats.length; i += 1) {
    const [x, y] = point(i, 1);
    parts.push(`<line class="axis-line" x1="${CX}" y1="${CY}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" />`);
    const [lx, ly] = point(i, 1.28);
    parts.push(`<text class="axis-label" x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}">${STAT_LABELS[stats[i]]}</text>`);
  }
  // 数据三角 + 顶点值。
  const values = stats.map((s) => Math.max(0, Math.min(1, profile.stats[s] / EvolutionEngine.MAX_STAT)));
  const dataPts = values.map((r, i) => point(i, Math.max(0.06, r))).map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  parts.push(`<polygon class="data-shape" points="${dataPts}" />`);
  for (let i = 0; i < stats.length; i += 1) {
    const [x, y] = point(i, Math.max(0.06, values[i]));
    parts.push(`<circle class="data-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" />`);
    const [lx, ly] = point(i, 1.12);
    parts.push(`<text class="axis-value" x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}">${profile.stats[stats[i]]}</text>`);
  }
  svg.innerHTML = parts.join('');
}

/** 属性行：名称、值、进度条、+/− 按钮。onAllocate(stat, points) 由 app.js 注入。 */
function ewsRenderStatList(profile) {
  const list = EWS.els && EWS.els['stat-list'];
  if (!list) return;
  list.textContent = '';
  for (const stat of EvolutionEngine.STATS) {
    const row = document.createElement('div');
    row.className = 'stat-row';
    const name = document.createElement('span');
    name.className = 'stat-name';
    name.textContent = STAT_LABELS[stat];
    const value = document.createElement('span');
    value.className = 'stat-value';
    value.textContent = String(profile.stats[stat]);
    const track = document.createElement('span');
    track.className = 'stat-track';
    const fill = document.createElement('span');
    fill.className = 'stat-fill';
    fill.style.width = `${Math.round((profile.stats[stat] / EvolutionEngine.MAX_STAT) * 100)}%`;
    track.appendChild(fill);
    const plus = document.createElement('button');
    plus.className = 'btn tiny';
    plus.type = 'button';
    plus.textContent = '+';
    plus.disabled = profile.statPoints <= 0 || profile.stats[stat] >= EvolutionEngine.MAX_STAT;
    plus.addEventListener('click', () => { if (ewsOnAllocate) ewsOnAllocate(stat, 1); });
    const minus = document.createElement('button');
    minus.className = 'btn tiny';
    minus.type = 'button';
    minus.textContent = '−';
    minus.disabled = profile.stats[stat] <= 5;
    minus.addEventListener('click', () => { if (ewsOnAllocate) ewsOnAllocate(stat, -1); });
    row.appendChild(name);
    row.appendChild(value);
    row.appendChild(track);
    row.appendChild(plus);
    row.appendChild(minus);
    list.appendChild(row);
  }
}

let ewsOnAllocate = null;
function ewsSetAllocateHandler(fn) { ewsOnAllocate = fn; }

function ewsRenderSkins(profile) {
  const box = EWS.els && EWS.els.skins;
  if (!box) return;
  box.textContent = '';
  const all = EvolutionEngine.skinsForLevel(EvolutionEngine.MAX_LEVEL);
  for (const skin of all) {
    const chip = document.createElement('span');
    chip.className = 'skin-chip';
    chip.textContent = skin === 'default' ? '默认形态' : `形态 Lv.${skin.slice(5)}`;
    if (profile.unlocked.includes(skin)) chip.classList.add('owned');
    else chip.classList.add('locked');
    box.appendChild(chip);
  }
}

const EvolutionWorkshop = {
  EWS, STAT_LABELS, MOOD_LABELS,
  ewsCollectEls, ewsSetStatus, ewsRenderProfile, ewsRenderRadar, ewsRenderStatList, ewsRenderSkins, ewsSetAllocateHandler,
};
