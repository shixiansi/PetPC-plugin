import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 久坐喝水提醒插件的行为测试。
//
// 三遍式（泳道契约）：握手成功 → 主路径（注入时钟）→ granted=[] 不崩不写。
// 时间相关断言全部注入时钟（__health.setClock），不依赖真实墙钟——尤其不依赖
// "现在几点"（默认勿扰 23:00-07:00 会把凌晨/清晨的墙钟静默掉，业务代码是对的）。
//
// reminderTick 内部 await 的是 bubble.say 的应答，所以 tick 期间要有一个应答循环
// 在跑（drainWhile）——真实宿主就是这么回话的。

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-health-reminder');
const html = readFileSync(path.join(pluginDir, 'panel.html'), 'utf8');
const appSource = readFileSync(path.join(pluginDir, 'app.js'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

// 本地时区的"今天上午十点"（用户与测试同机）：勿扰窗口外，主场景在这里演。
function localMs(h, min) {
  const d = new Date();
  d.setHours(h, min, 0, 0);
  return d.getTime();
}
const DAY10 = localMs(10, 0);
const MS_MIN = 60000;

/** 常驻帧（提醒计时所在的那一面）或浮层面 / 插件页的 jsdom 挂载。 */
async function mount({ granted, surface, clock = () => DAY10 } = {}) {
  const dom = new JSDOM(html, { url: 'https://plugin.invalid/panel.html', runScripts: 'outside-only' });
  const { window } = dom;
  const sent = [];
  const errors = [];
  window.parent = window;
  window.postMessage = (msg) => sent.push(msg);
  window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
  window.addEventListener('unhandledrejection', (e) => errors.push('unhandled: ' + String(e.reason && e.reason.message || e.reason)));

  window.eval(appSource);
  window.__health.setClock(clock);

  const init = () => {
    const data = {
      v: 1,
      type: 'init',
      theme: 'dark',
      granted: granted || [],
      surface: surface || { kind: 'panel', slot: 'background' },
      // host.methods 逐字照 fake-host 的判据给（pet 宿主：pet 专属方法在列）。
      host: { program: surface?.slot === 'workshop' ? 'workshop' : 'pet', methods: surface?.slot === 'workshop' ? ['storage.get', 'storage.set', 'config.get', 'config.set'] : ['storage.get', 'storage.set', 'config.get', 'config.set', 'bubble.say', 'events.subscribe', 'pet.badge', 'surface.blocks'] },
    };
    const event = new window.MessageEvent('message', { data });
    Object.defineProperty(event, 'source', { value: window });
    window.dispatchEvent(event);
  };
  const respond = (id, result, ok = true) => {
    const event = new window.MessageEvent('message', { data: { v: 1, type: 'response', id, ok, result } });
    Object.defineProperty(event, 'source', { value: window });
    window.dispatchEvent(event);
  };
  const answer = (method, payload, answers) => {
    const a = answers && answers(method, payload || {});
    if (a) return a;
    if (method === 'config.get') {
      return { ok: true, result: { values: {
        waterEnabled: 'true', waterIntervalMin: '45',
        sitEnabled: 'true', sitIntervalMin: '45',
        eyeEnabled: 'true', eyeIntervalMin: '30',
        dndWindow: '23:00-07:00', restMinutes: '30',
      } } };
    }
    if (method === 'storage.get') return { ok: true, result: { value: '' } };
    if (method === 'events.subscribe') return { ok: true, result: ['config.changed'] };
    return { ok: true, result: { ok: true } };
  };
  /** 把宿主的应答喂完：直到不再有新请求。 */
  const drive = async (answers) => {
    const done = new Set();
    for (let round = 0; round < 30; round++) {
      const fresh = sent.filter((m) => m.type === 'request' && !done.has(m.id));
      if (fresh.length === 0) break;
      for (const m of fresh) {
        done.add(m.id);
        const a = answer(m.method, m.payload, answers);
        respond(m.id, a.result, a.ok !== false);
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 5));
  };
  /** tick 期间的应答循环：reminderTick await 的 bubble.say 也从这里得到回应。 */
  const drainWhile = async (work, answers) => {
    const t = setInterval(() => {
      for (const m of sent) {
        if (m.type === 'request' && !m._done) {
          m._done = true;
          const a = answer(m.method, m.payload, answers);
          respond(m.id, a.result, a.ok !== false);
        }
      }
    }, 2);
    try {
      await work();
    } finally {
      clearInterval(t);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return { window, sent, errors, init, respond, drive, drainWhile, answer };
}

/** 已握手、已就绪的常驻帧（提醒计时所在）。 */
async function mountedBackground(opts = {}) {
  const page = await mount({ granted: ['events', 'pet.surface', 'pet.bubble', 'plugin.config', 'storage'], surface: { kind: 'panel', slot: 'background' }, ...opts });
  page.init();
  await page.drive(opts.answers);
  page.sent.length = 0; // 握手期的请求不算数，后面只看行为
  return page;
}

const bubbleSays = (page) => page.sent.filter((m) => m.type === 'request' && m.method === 'bubble.say');
const storageSets = (page) => page.sent.filter((m) => m.type === 'request' && m.method === 'storage.set');
const badgePushes = (page) => page.sent.filter((m) => m.type === 'request' && m.method === 'pet.badge');

// --- 纯函数（不动宿主） ---------------------------------------------------------

describe('纯逻辑：勿扰 / 换日 / 倒计时（__health 暴露的纯函数）', () => {
  function loadHealth() {
    const window = {
      addEventListener: () => {},
      setInterval: () => 0,
      parent: { postMessage: () => {} },
      document: { getElementById: () => null },
    };
    new Function('window', appSource)(window);
    return window.__health;
  }
  const H = loadHealth();
  const DND = H.parseDnd('23:00-07:00');
  const at = (h, min) => new Date(2026, 0, 1, h, min).getTime();
  const stEmpty = () => ({ water: { nextAt: 0, dayKey: '', done: 0 }, sit: { nextAt: 0, dayKey: '', done: 0 }, eye: { nextAt: 0, dayKey: '', done: 0 }, restUntil: 0 });
  const cfgAll = (over = {}) => ({ waterEnabled: true, waterIntervalMin: 45, sitEnabled: true, sitIntervalMin: 45, eyeEnabled: true, eyeIntervalMin: 30, ...over });

  test('勿扰解析：合法、空白、非法都按约定', () => {
    expect(DND).toEqual({ from: 23 * 60, to: 7 * 60 });
    expect(H.parseDnd('')).toBeNull();
    expect(H.parseDnd('abc')).toBeNull();
    expect(H.parseDnd('25:00-07:00')).toBeNull();
  });

  test('跨午夜勿扰：23:30 在扰内、07:00 整仍在扰内（含端点）、07:01 已恢复、12:00 正常', () => {
    expect(H.isSilent(at(23, 30), DND, stEmpty())).toBe('dnd');
    expect(H.isSilent(at(23, 0), DND, stEmpty())).toBe('dnd');
    expect(H.isSilent(at(6, 59), DND, stEmpty())).toBe('dnd');
    expect(H.isSilent(at(7, 0), DND, stEmpty())).toBe('dnd');
    expect(H.isSilent(at(7, 1), DND, stEmpty())).toBe('');
    expect(H.isSilent(at(12, 0), DND, stEmpty())).toBe('');
  });

  test('歇会儿静默：restUntil 之内是 rest，过期不算', () => {
    const st = stEmpty();
    st.restUntil = at(12, 30);
    expect(H.isSilent(at(12, 0), null, st)).toBe('rest');
    expect(H.isSilent(at(12, 31), null, st)).toBe('');
  });

  test('跨日重置边界：04:00 换日（与全局换日一致）', () => {
    expect(H.dayKeyOf(at(3, 59))).toBe(H.dayKeyOf(at(23, 59) - 86400000));
    expect(H.dayKeyOf(at(4, 0))).not.toBe(H.dayKeyOf(at(3, 59)));
  });

  test('到点触发（纯函数）：45 分钟间隔、计数 +1、下一次排程从这次到达时刻起', () => {
    const st = stEmpty();
    const now = at(10, 0);
    st.water = { nextAt: now - 1000, dayKey: H.dayKeyOf(now), done: 2 };
    const fired = H.tickGroups(now, cfgAll(), st, DND);
    expect(fired).toEqual([{ name: 'water', muted: false }]);
    expect(st.water.done).toBe(3);
    expect(st.water.nextAt).toBe(now + 45 * MS_MIN);
  });

  test('同一跳多组同时到点：全部触发（说话方只挑一个，纯函数不挑）', () => {
    const st = stEmpty();
    const now = at(10, 0);
    st.water.nextAt = now - 1;
    st.sit.nextAt = now - 1;
    st.eye.nextAt = now - 1;
    const fired = H.tickGroups(now, cfgAll(), st, DND);
    expect(fired.map((f) => f.name).sort()).toEqual(['eye', 'sit', 'water']);
  });

  test('关 A 不影响 B：A 关着不触发也不重排，B 照常到点', () => {
    const st = stEmpty();
    const now = at(10, 0);
    st.water = { nextAt: now - 1000, dayKey: H.dayKeyOf(now), done: 5 };
    st.sit = { nextAt: now - 1000, dayKey: H.dayKeyOf(now), done: 1 };
    const fired = H.tickGroups(now, cfgAll({ waterEnabled: false }), st, DND);
    expect(fired.map((f) => f.name)).toEqual(['sit']);
    expect(st.water.nextAt).toBe(now - 1000); // 关着的组：计时不被重排
    expect(st.water.done).toBe(5);
    expect(st.sit.nextAt).toBe(now + 45 * MS_MIN);
  });

  test('勿扰/歇会儿里的到点：muted 标记，计数与排程照走', () => {
    const st = stEmpty();
    const now = at(23, 30); // 勿扰内
    st.water = { nextAt: now - 1000, dayKey: H.dayKeyOf(now), done: 0 };
    const fired = H.tickGroups(now, cfgAll(), st, DND);
    expect(fired).toEqual([{ name: 'water', muted: true }]);
    expect(st.water.done).toBe(1);
    const st2 = stEmpty();
    st2.restUntil = now + 600000; // 歇会儿中
    st2.eye = { nextAt: now - 1000, dayKey: H.dayKeyOf(now), done: 0 };
    const fired2 = H.tickGroups(now, cfgAll(), st2, null);
    expect(fired2).toEqual([{ name: 'eye', muted: true }]);
  });

  test('徽标文案：三组里最近的启用组；≤16 字符；全关为空串', () => {
    const now = at(10, 0);
    const st = stEmpty();
    st.water.nextAt = now + 45 * MS_MIN;
    st.eye.nextAt = now + 30 * MS_MIN;
    expect(H.badgeTextFor(now, st, cfgAll())).toBe('下一次 30 分钟');
    expect(H.badgeTextFor(now + 30 * MS_MIN + 1, st, cfgAll())).toBe('提醒就现在');
    const stClosed = stEmpty();
    expect(H.badgeTextFor(now, stClosed, cfgAll({ waterEnabled: false, sitEnabled: false, eyeEnabled: false }))).toBe('');
    const text = H.badgeTextFor(now, st, cfgAll());
    expect([...text].length).toBeLessThanOrEqual(16);
  });
});

// --- 握手与协议 -----------------------------------------------------------------

describe('握手（三遍式第一遍）', () => {
  test('ready 先于一切请求；init 之后开始问配置', async () => {
    const page = await mount({ granted: ['events', 'pet.surface', 'pet.bubble', 'plugin.config', 'storage'] });
    expect(page.sent).toHaveLength(1);
    expect(page.sent[0]).toMatchObject({ v: 1, type: 'ready' });
    page.init();
    await page.drive();
    expect(page.sent.some((m) => m.type === 'request' && m.method === 'config.get')).toBe(true);
    expect(page.errors).toEqual([]);
  });

  test('manifest 按 WAVE-1 的 health-reminder 行：permissions / background / 无 serves / 0.1.0 / shixiansi', () => {
    expect(manifest.id).toBe('com.shixiansi.plugin-health-reminder');
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.author).toBe('shixiansi');
    expect(manifest.background).toBe(true);
    expect(manifest.serves).toBeUndefined(); // 无 serves：不给别的插件当被调方
    expect([...manifest.permissions].sort()).toEqual(['events', 'pet.bubble', 'pet.surface', 'plugin.config', 'storage'].sort());
    expect(manifest.surface).toHaveLength(1);
    expect(manifest.config.some((c) => c.key === 'dndWindow')).toBe(true);
  });

  test('常驻帧启动：排程三组 + 徽标推一次（下一次 30 分钟 = 护眼的间隔）', async () => {
    const page = await mount({ granted: ['events', 'pet.surface', 'pet.bubble', 'plugin.config', 'storage'], surface: { kind: 'panel', slot: 'background' } });
    // 徽标在 init 链里发出：drive 的应答循环打开前 init 已经排完队——用 drainWhile 全程收。
    page.init();
    let badgesDuringInit = [];
    await page.drainWhile(() => page.drive());
    badgesDuringInit = page.sent.filter((m) => m.type === 'request' && m.method === 'pet.badge');
    const st = page.window.__health.snapshot().state;
    expect(st.water.nextAt).toBe(DAY10 + 45 * MS_MIN);
    expect(st.sit.nextAt).toBe(DAY10 + 45 * MS_MIN);
    expect(st.eye.nextAt).toBe(DAY10 + 30 * MS_MIN);
    expect(badgesDuringInit.length).toBeGreaterThanOrEqual(1);
    expect(badgesDuringInit.some((m) => m.payload.text === '下一次 30 分钟')).toBe(true);
    // 状态落盘一次（徽标与倒计时的持久层）
    const write = page.sent.filter((m) => m.type === 'request' && m.method === 'storage.set').find((m) => m.payload.key === 'state/v1');
    expect(write, '挂载时应把排程写进 state/v1').toBeTruthy();
  });
});

// --- 主路径（注入时钟） -----------------------------------------------------------

describe('到点触发（注入时钟，间隔 45 分钟）', () => {
  test('到点恰好发一次 bubble.say，文案对；下一分钟的一跳不发第二次', async () => {
    const page = await mountedBackground();
    const H = page.window.__health;
    const st = H.snapshot().state;
    // 握手排程在 DAY10（挂载时注入的钟）。护眼 30 分钟最先到——把护眼关掉，
    // 让"45 分钟间隔到点"这一跳只有喝水一组到期（久坐同为 45 分钟、同一毫秒到期，
    // 平局按 water → sit → eye 挑一个，所以关掉久坐才能钉死"说喝水"）。
    page.sent.length = 0;
    const event = new page.window.MessageEvent('message', {
      data: { v: 1, type: 'event', name: 'config.changed', payload: { pluginId: 'com.shixiansi.plugin-health-reminder' } },
    });
    Object.defineProperty(event, 'source', { value: page.window });
    await page.drainWhile(async () => {
      page.window.dispatchEvent(event);
      await new Promise((r) => setTimeout(r, 15));
    }, (method) => (method === 'config.get' ? { ok: true, result: { values: { eyeEnabled: 'false', sitEnabled: 'false' } } } : undefined));
    expect(H.snapshot().cfg.eyeEnabled).toBe(false);
    page.sent.length = 0;
    H.setClock(() => st.water.nextAt + 500);
    await page.drainWhile(() => H.reminderTick());
    const says = bubbleSays(page);
    expect(says).toHaveLength(1);
    expect(says[0].payload.text).toContain('喝水');
    expect(H.snapshot().state.water.done).toBe(1);
    // 排程从"这次到达的时刻"起推一个完整间隔（fireAt = 到点 + 500ms，差值保留）
    expect(H.snapshot().state.water.nextAt).toBe(st.water.nextAt + 45 * MS_MIN + 500);
    // 一分钟后的一跳：远没到下一次，零气泡
    page.sent.length = 0;
    H.setClock(() => st.water.nextAt + 500 + MS_MIN);
    await page.drainWhile(() => H.reminderTick());
    expect(bubbleSays(page)).toHaveLength(0);
  });

  test('同一跳两组到点：只说一句，平局按 water → sit → eye（说出口的是喝水）', async () => {
    const page = await mountedBackground();
    const H = page.window.__health;
    const st = H.snapshot().state;
    // 护眼 30 分钟那跳先让它说完（一次只说一句）
    H.setClock(() => st.eye.nextAt + 500);
    await page.drainWhile(() => H.reminderTick());
    expect(bubbleSays(page)).toHaveLength(1);
    // water/sit 同为 45 分钟、同一毫秒到期：平局按 water → sit → eye 挑，water 先说
    // （GROUPS 顺序固定，说话方从 fired 里按这个顺序取第一个未静默的组）
    page.sent.length = 0;
    H.setClock(() => st.water.nextAt + 500);
    await page.drainWhile(() => H.reminderTick());
    const says = bubbleSays(page);
    expect(says).toHaveLength(1);
    expect(says[0].payload.text).toContain('喝水');
    expect(H.snapshot().state.water.done).toBe(1);
    expect(H.snapshot().state.sit.done).toBe(1);
  });

  test('到点写一次 state（徽标/倒计时的持久层），且写的是 state/v1', async () => {
    const page = await mountedBackground();
    const H = page.window.__health;
    const st = H.snapshot().state;
    H.setClock(() => st.eye.nextAt + 500);
    await page.drainWhile(() => H.reminderTick());
    const writes = storageSets(page).filter((m) => m.payload.key === 'state/v1');
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0].payload.value).eye.done).toBe(1);
    // 徽标跟着走：护眼到点后，最近的启用组是喝水/久坐（45 分钟后）
    const badge = badgePushes(page).pop();
    expect(badge.payload.text).toBe('下一次 15 分钟'); // 护眼重排后 15 分钟内没有别的组
  });
});

describe('勿扰时段（23:00-07:00 配置）', () => {
  test('23:30 的到点 tick：计数照走、气泡零条；07:01 恢复出声', async () => {
    const page = await mountedBackground();
    const H = page.window.__health;
    // 把三组都拨到 23:30 同一跳到期（直接快进：勿扰之外的时点先静默走完）——
    // 干净做法：把 nextAt 改到 23:30（storage 是插件自己的键，测试借 snapshot 改不进去；
    // 但 nextAt 只由"现在 + 间隔"推进，所以用 setClock 直接跳到 23:30，让 10:15/10:30 的
    // 到点在 23:30 这一跳一次性补触发——三组同跳、全 muted）
    H.setClock(() => localMs(23, 30));
    await page.drainWhile(() => H.reminderTick());
    expect(bubbleSays(page)).toHaveLength(0); // 勿扰时段：一条都不发
    const snap = H.snapshot();
    expect(snap.state.water.done).toBe(1); // 计数照走（静默不是跳过）
    expect(snap.state.sit.done).toBe(1);
    expect(snap.state.eye.done).toBe(1);
    // 下一轮从 23:30 起 + 各自间隔：water/sit 00:15、eye 00:00 —— 都在勿扰内，继续静默
    page.sent.length = 0;
    H.setClock(() => snap.state.water.nextAt + 500); // 00:15
    await page.drainWhile(() => H.reminderTick());
    expect(bubbleSays(page)).toHaveLength(0);
    const snap2 = H.snapshot();
    expect(snap2.state.water.done).toBe(2); // 勿扰里到点：计数照走
    // 00:15 之后的水/久坐 nextAt = 01:00、护眼 00:45 —— 仍全在勿扰内；
    // 拨到次日 07:01（跨过了 04:00 换日）：勿扰已结束，01:00 的 nextAt 早已过期 → 到点即触发，恢复出声
    page.sent.length = 0;
    H.setClock(() => localMs(7, 1) + 86400000);
    await page.drainWhile(() => H.reminderTick());
    const restored = bubbleSays(page);
    expect(restored.length).toBe(1); // 一次只说一句话（气泡只有一个）
    expect(restored[0].payload.text.length).toBeGreaterThan(0);
  });
});

describe('关开关立刻停（运行中关掉喝水开关）', () => {
  test('config.changed 推来 waterEnabled=false → 之后的 tick 零气泡、不重排', async () => {
    const page = await mountedBackground();
    const H = page.window.__health;
    const st = H.snapshot().state;
    // 先到点一次：确认计时在走
    H.setClock(() => st.water.nextAt + 500);
    await page.drainWhile(() => H.reminderTick());
    expect(bubbleSays(page)).toHaveLength(1);
    // 用户在设置里关掉喝水（宿主推 config.changed；配置应答带新值）
    page.sent.length = 0;
    const event = new page.window.MessageEvent('message', {
      data: { v: 1, type: 'event', name: 'config.changed', payload: { pluginId: 'com.shixiansi.plugin-health-reminder' } },
    });
    Object.defineProperty(event, 'source', { value: page.window });
    await page.drainWhile(async () => {
      page.window.dispatchEvent(event);
      await new Promise((r) => setTimeout(r, 15));
    }, (method) => (method === 'config.get' ? { ok: true, result: { values: { waterEnabled: 'false' } } } : undefined));
    expect(H.snapshot().cfg.waterEnabled).toBe(false);
    expect(typeof H.snapshot().cfg.waterEnabled).toBe('boolean'); // 开关归一成布尔（config 表单给字符串）
    // 之后一跳：水的 nextAt 早已过期，但它关着——零气泡、不计数、不重排。
    // 注：这一跳里久坐/护眼的 nextAt 也已过期（间隔更短/更早），它们照常触发——
    // 所以"零气泡"只对喝水成立，气泡里不允许出现"喝水"。
    page.sent.length = 0;
    const lastNextAt = H.snapshot().state.water.nextAt;
    H.setClock(() => lastNextAt + MS_MIN);
    await page.drainWhile(() => H.reminderTick());
    expect(bubbleSays(page).some((m) => String(m.payload.text).includes('喝水'))).toBe(false);
    expect(H.snapshot().state.water.done).toBe(1); // 关掉后不再计数
    expect(H.snapshot().state.water.nextAt).toBe(lastNextAt); // 不重排
    // 其他组不受影响：久坐下一次到点照发（用久坐重排后的 nextAt 这一跳；
    // 它的 nextAt 已过期即触发，文案仍是久坐——喝水关着，名额轮不到它）
    const st2 = H.snapshot().state;
    page.sent.length = 0;
    H.setClock(() => st2.sit.nextAt + 500);
    await page.drainWhile(() => H.reminderTick());
    const says = bubbleSays(page);
    expect(says).toHaveLength(1);
    expect(says[0].payload.text).toContain('久坐'); // 计数是第 3 次还是第 2 次取决于中段几组到过点，不钉
  });
});

describe('跨日重置（04:00 与全局换日一致）', () => {
  test('昨日计数在 04:00 之后的第一次到点归零重数；04:00 之前仍算前一天', async () => {
    const page = await mountedBackground();
    const H = page.window.__health;
    const st = H.snapshot().state;
    // 今天 10:15 到点一次 → done=1
    H.setClock(() => st.water.nextAt + 500);
    await page.drainWhile(() => H.reminderTick());
    expect(H.snapshot().state.water.done).toBe(1);
    // 次日 03:30（勿扰内，且按 04:00 换日仍是"前一天"）：到点计数继续 +1
    H.setClock(() => localMs(3, 30) + 86400000);
    await page.drainWhile(() => H.reminderTick());
    expect(H.snapshot().state.water.done).toBe(2); // 前一天的计数日
    // 次日 04:30（已换日）：到点 → 归零后重数为 1
    H.setClock(() => localMs(4, 30) + 86400000);
    await page.drainWhile(() => H.reminderTick());
    expect(H.snapshot().state.water.done).toBe(1); // 新的一天从 0 重数
  });
});

describe('三组提醒相互独立（歇会儿不挪计时）', () => {
  test('歇会儿进入静默但三组的 nextAt 原样；勿扰外的到点被静默', async () => {
    const page = await mountedBackground();
    const H = page.window.__health;
    const st = H.snapshot().state;
    const before = { water: st.water.nextAt, sit: st.sit.nextAt, eye: st.eye.nextAt };
    await page.drainWhile(() => H.restNow());
    expect(H.snapshot().state.restUntil).toBeGreaterThan(DAY10);
    expect(H.snapshot().state.restUntil).toBe(DAY10 + 30 * MS_MIN); // 默认歇 30 分钟
    const after = H.snapshot().state;
    expect(after.water.nextAt).toBe(before.water);
    expect(after.sit.nextAt).toBe(before.sit);
    expect(after.eye.nextAt).toBe(before.eye);
    // 勿扰之外的到点此刻被 rest 静默（气泡零条，计数照走）。
    // 注：restNow 把 restUntil 设为 now+30 分钟 = DAY10+30；护眼在 DAY10+30 到点——
    // restUntil 与它同毫秒，`restUntil > now` 为假 → 不静默。先把 restMinutes 配成 45。
    page.sent.length = 0;
    const ev = new page.window.MessageEvent('message', {
      data: { v: 1, type: 'event', name: 'config.changed', payload: { pluginId: 'com.shixiansi.plugin-health-reminder' } },
    });
    Object.defineProperty(ev, 'source', { value: page.window });
    await page.drainWhile(async () => {
      page.window.dispatchEvent(ev);
      await new Promise((r) => setTimeout(r, 15));
    }, (method) => (method === 'config.get' ? { ok: true, result: { values: { restMinutes: '45' } } } : undefined));
    page.sent.length = 0;
    await page.drainWhile(() => H.restNow());
    expect(H.snapshot().state.restUntil).toBe(DAY10 + 45 * MS_MIN);
    page.sent.length = 0;
    H.setClock(() => before.eye + 500);
    await page.drainWhile(() => H.reminderTick());
    expect(bubbleSays(page)).toHaveLength(0);
    expect(H.snapshot().state.eye.done).toBe(1);
  });
});

// --- granted=[]（三遍式第三遍） ---------------------------------------------------

describe('granted=[]：宿主什么都没给', () => {
  test('零请求、零 storage 写、零 bubble.say、不崩、状态说出口', async () => {
    const page = await mount({ granted: [], surface: { kind: 'panel', slot: 'background' } });
    page.init();
    await page.drive();
    expect(page.sent.filter((m) => m.type === 'request')).toEqual([]);
    expect(page.errors).toEqual([]);
    // 常驻帧也说出口（无界面可看，但状态行有内容）
    expect(page.window.document.getElementById('status').textContent).toContain('未获授权');
    // 一跳也不崩、不出声、不写
    page.window.__health.setClock(() => DAY10 + 45 * MS_MIN);
    await page.drainWhile(() => page.window.__health.reminderTick());
    expect(bubbleSays(page)).toHaveLength(0);
    expect(storageSets(page)).toHaveLength(0);
    expect(page.errors).toEqual([]);
  });

  test('浮层面：零请求、UI 出未授权态（控件禁用、歇会儿隐藏）', async () => {
    const page = await mount({
      granted: [],
      surface: { kind: 'surface', rectIndex: 0, rectCount: 1, rect: { x: 0, y: 0, w: 320, h: 190, r: 14, tailX: 0, hidden: false, room: 160 } },
    });
    page.init();
    await page.drive();
    expect(page.sent.filter((m) => m.type === 'request')).toEqual([]);
    expect(page.errors).toEqual([]);
    expect(page.window.document.getElementById('status').textContent).toContain('未获授权');
    expect(page.window.document.getElementById('toggle-water').disabled).toBe(true);
    expect(page.window.document.getElementById('rest').hidden).toBe(true);
  });

  test('插件页（workshop）：只读视图照常渲染，桌宠专属请求一条不发并说出口', async () => {
    const page = await mount({
      granted: ['events', 'pet.surface', 'pet.bubble', 'plugin.config', 'storage'],
      surface: { kind: 'panel', slot: 'workshop' },
    });
    page.init();
    await page.drive();
    expect(page.errors).toEqual([]);
    const petOnly = page.sent.filter((m) => m.type === 'request' && ['bubble.say', 'pet.badge', 'surface.blocks', 'events.subscribe'].includes(m.method));
    expect(petOnly).toEqual([]);
    expect(page.window.document.getElementById('status').textContent).toContain('桌宠');
    // 只读部分照常显示（§9）：三行卡片在
    expect(page.window.document.getElementById('row-water')).toBeTruthy();
    expect(page.window.document.getElementById('toggle-water').disabled).toBe(true);
  });
});

// --- 面板交互 -------------------------------------------------------------------

describe('浮层面的开关与歇会儿', () => {
  test('开关写 config.set；歇会儿写 rest/request 供常驻帧读取', async () => {
    const page = await mount({
      granted: ['events', 'pet.surface', 'pet.bubble', 'plugin.config', 'storage'],
      surface: { kind: 'surface', rectIndex: 0, rectCount: 1, rect: { x: 0, y: 0, w: 320, h: 190, r: 14, tailX: 0, hidden: false, room: 160 } },
    });
    page.init();
    await page.drive();
    page.sent.length = 0;
    page.window.document.getElementById('toggle-water').dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
    await page.drainWhile(() => new Promise((r) => setTimeout(r, 15)));
    const set = page.sent.find((m) => m.type === 'request' && m.method === 'config.set');
    expect(set, '开关应写 config.set').toBeTruthy();
    expect(set.payload.values.waterEnabled).toBe('false');
    page.sent.length = 0;
    await page.drainWhile(() => page.window.__health.restNow());
    const rest = page.sent.find((m) => m.type === 'request' && m.method === 'storage.set' && m.payload.key === 'rest/request');
    expect(rest, '歇会儿应写 rest/request（常驻帧的读法）').toBeTruthy();
    expect(Number(rest.payload.value)).toBeGreaterThan(DAY10);
  });
});
