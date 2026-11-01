// lib/store.js —— 私有目录的键与布局
//
// DATA 表、键名生成、1.10→1.11 的搬迁与每次启动的整理。
//
// 从原来的 app.js 按节**原样搬出来**（1.12 的重构）：内容逐字未改，只是换了个文件。
// 经典 script 共享同一个全局作用域，所以这里不用 import/export；
// 加载顺序写在 panel.html 里（顺序 = 原来的文件顺序，所以原有的依赖关系不变）。
'use strict';

// --- 数据放在哪 --------------------------------------------------------------
//
// 插件的私有目录是一棵**有结构的树**，不是一堆文件：
//
//   state/status            一次快照：连接状态、自己是谁、计数
//   state/log               最近 60 行日志
//   state/groups            群索引：哪些群最近有人说话
//   state/video             发出去的视频的保留清单（10 分钟后按它清理）
//   state/layout            布局标记（迁移只跑一次，见 migrateDataLayout）
//   history/<群号>          每群的往来
//   media/stickers/index    表情包索引 [{hash, tag, description}]
//   media/stickers/categories  分类列表
//   media/stickers/bytes/<hash>  表情包字节（base64）
//   media/video/<name>      合成好的、要发给协议端的视频
//   media/video/tmp/<name>  curl 下下来的中间流（合成完立刻删）
//   share/bili-jobs         宿主管理的跨插件托盘（由宿主写，不用管）
//
// WHY：1.10 及以前每个键就是根目录里的一个文件名，于是两百张表情包、两个 24 MB 的
// 视频、每个群一份往来、一次状态快照全挤在同一个文件夹里 —— 打开 `plugin-data` 谁
// 也看不出来哪个是设置、哪个是能删的垃圾。宿主的 storage key 从 1.11 起可以是
// `a/b`（每一段仍然只能是字母、数字、`_`、`-`，所以照样出不了自己的目录），
// 于是"每类数据一个文件夹"只换了键名，**没有多要一项权限**。
//
// WHY 表情包与视频在 `media/` 下：1.10 的索引文件就叫 `stickers`，而一个文件夹也叫
// `stickers` 的话，把索引搬进 `stickers/index` 需要先建 `stickers\` 这个目录 —— 而那个
// 名字此刻是一个文件，`MkdirAll` 直接失败。名字撞车的迁移要靠"先改名再搬回来"的特殊
// 处理，而这种特殊处理正是"搬了一半"的来源。所以顶层文件夹（state / history / media /
// share）**都不与 1.10 的任何键同名**，每一个搬迁因此都是普通的改名，任意顺序、任意次重
// 复都成立。顺带把"会占盘的字节"（表情包 + 视频）收在一处。
//
// 名字里的空格、斜杠、中文在这里都被洗掉：宿主的每段只认 [A-Za-z0-9_-]，
// 一个没洗干净的字符会让整个写入被拒绝，而那会变成"表情包突然存不进去了"。
const DATA = {
  status: 'state/status',
  log: 'state/log',
  groups: 'state/groups',
  layout: 'state/layout',
  videoFiles: 'state/video',
  stickerIndex: 'media/stickers/index',
  stickerCategories: 'media/stickers/categories',
  // 接话分寸（personaBehavior）。为什么走 storage 而不是 config：manifest 的 config
  // 已用满宿主 40 项上限（README「为什么不放 config」同一条理由）。
  personaBehavior: 'state/persona-behavior',
};

/**
 * 这台宿主认不认 `a/b` 这样的键。
 *
 * 桌宠和市场是同一个仓库出的两个程序，但用户可能只更新了插件、还没更新桌宠 —— 那时
 * 带斜杠的键会被一句"storage key 非法"顶回来，而这个插件的**所有**数据都换成新键了，
 * 于是它会看起来"什么都没了"。所以探一次：成功过就是 true，被顶回来就永久切成旧名字
 * （见 useLegacyKeys），让插件在旧桌宠上继续按 1.10 的方式工作，只是数据继续挤在一起。
 */
let useFolders = true;

/** 目录布局的版本。2 是"每类数据一个文件夹"；1 是全部平铺在根目录（1.10 及以前）。 */
const LAYOUT_VERSION = '2';

/** The folders whose contents are named after something external (a hash, a 群号). */
const STICKER_BYTES_DIR = 'media/stickers/bytes';
const HISTORY_DIR = 'history';

/** 1.10 的平铺键 → 新键。顺序无关，每一个搬迁都是幂等的（见 migrateDataLayout）。 */
const LEGACY_KEYS = [
  ['status', DATA.status],
  ['log', DATA.log],
  ['groups', DATA.groups],
  ['stickers', DATA.stickerIndex],
  ['categories', DATA.stickerCategories],
  ['bilivideo-files', DATA.videoFiles],
];

/** 退回 1.10 的平铺键。只由 migrateDataLayout 在探到旧宿主时调用，调用后不再回头。 */
function useLegacyKeys() {
  if (!useFolders) return;
  useFolders = false;
  DATA.status = 'status';
  DATA.log = 'log';
  DATA.groups = 'groups';
  DATA.stickerIndex = 'stickers';
  DATA.stickerCategories = 'categories';
  DATA.videoFiles = 'bilivideo-files';
  // DATA.layout 不再用到：旧宿主放不下标记文件，也就不该再探第二次。
}

/** Just the characters a storage key segment may contain. */
function cleanSegment(value) {
  return String(value === undefined || value === null ? '' : value).replace(/[^0-9A-Za-z_-]/g, '');
}

/** One group's memory: `history/<群号>`（旧宿主：`hist_<群号>`）。 */
function historyKey(groupID) {
  const id = cleanSegment(groupID);
  return (useFolders ? `${HISTORY_DIR}/${id}` : `hist_${id}`).slice(0, 64);
}

/** One sticker's bytes: `media/stickers/bytes/<hash>`（旧宿主：`sticker_<hash>`）。 */
function stickerBytesKey(hash) {
  const cleaned = cleanSegment(hash);
  return (useFolders ? `${STICKER_BYTES_DIR}/${cleaned}` : `sticker_${cleaned}`).slice(0, 64);
}

/** A video product's key: inside one of the video folders, or a flat name on an old host. */
function videoKeyIn(folder, name) {
  return useFolders ? `${folder}/${name}` : name;
}

/**
 * 1.10 写在根目录里的文件名形状。用正则而不是"以某前缀开头"：扫错文件就是搬错别人的
 * 东西。这四类都是 1.10 的代码**唯一**会写出来的名字。
 *
 *   `bili<stamp>[bN]` / `bilivideo<stamp>[bN]`  视频中间流与成品（stamp = Date.now() 的 36 进制）
 *   `hist_<群号>`                                每群的往来
 *   `sticker_<hash>`                             表情包字节
 */
const STREAM_NAME = /^bili[0-9a-z]+[va]$/;
const PRODUCT_NAME = /^bilivideo[0-9a-z]+$/;
const HISTORY_NAME = /^hist_([0-9]{3,20})$/;
const STICKER_NAME = /^sticker_([0-9A-Za-z]{1,32})$/;

/**
 * 扫根目录，把**索引不知道**的老文件也搬进各自的文件夹。
 *
 * 为什么必须扫，而不是"照着索引搬"就够了 —— 真机上踩到的：1.10 的群索引 `groups` 每次
 * 启动都会被写成空表（见 loadGroupsIndex 的注释），所以升级那一刻它已经是 `[]` 了。照着
 * 它搬，四份 `hist_<群号>` 一份都不会动，于是升级后**每个群的记忆看起来都丢了**：机器人
 * 读的是 `history/<群号>`，而文件还躺在根目录。
 *
 * 所以顺序是：先按索引搬（快、有名字可依），再把根目录**剩下的**认得出的文件也搬过去。
 * 索引完好时第二遍什么都不做；索引坏了时它救回记忆本身。同名同 hash 的文件本来就由
 * `storage.move` 的"目标已存在 → 不动"处理，搬两遍是安全的。
 *
 * 视频那两类还会补一条账（`rememberVideoFile`），因为搬过去之后没有任何索引记得它们，
 * 而 `pruneVideoFiles` 是唯一会清理 `media/video/` 的东西。
 *
 * `names` 是根目录此刻的文件名（由 tidyLeftovers 列一次传进来，省一次往返）。
 */
async function sweepLeftovers(names) {
  const out = { products: 0, histories: 0, stickers: 0, groupIDs: [] };

  for (const name of names) {
    let to = '';
    let kind = '';
    const history = HISTORY_NAME.exec(name);
    const sticker = STICKER_NAME.exec(name);
    if (STREAM_NAME.test(name) || PRODUCT_NAME.test(name)) {
      to = `${VIDEO_DIR}/${name}`;
      kind = 'products';
    } else if (history) {
      to = `${HISTORY_DIR}/${history[1]}`;
      kind = 'histories';
    } else if (sticker) {
      to = `${STICKER_BYTES_DIR}/${sticker[1]}`;
      kind = 'stickers';
    } else {
      continue;
    }
    try {
      const res = await request('storage.move', { from: name, to });
      if (res && res.moved) {
        out[kind] += 1;
        if (kind === 'products') {
          // The ledger ages it out; without the entry the moved file would sit in the
          // folder forever, which is the same leak one level down.
          await rememberVideoFile(to);
        }
        if (kind === 'histories') out.groupIDs.push(history[1]);
        continue;
      }
      // 目标已经在了：说明这条数据之前搬过，而根目录这一份是**旧进程刚刚又写出来的**。
      // 两份不同步地留着，读哪份都是运气，所以按类型就地收尾：
      //   · 记忆：留**条数多的**那份（ties 用新写的这份）。不能无脑用新写的：旧进程那份
      //     是它内存里的对话，而它可能因为文件已经被搬走而只记得最新一轮——真机上就这么
      //     把三份更长的历史盖成了两句话。所以条数多的赢，长度相同才用新的。
      //   · 表情包字节：hash 一致就是同一张图，删掉平铺那份；
      //   · 视频产物：不动（两份都是同一段录像，删错更亏），交给 10 分钟的账本清理。
      const targetExists = Boolean(res && res.targetExists);
      if (kind === 'histories' && targetExists) {
        const flat = await readKeyText(name);
        if (flat) {
          const turns = (text) => {
            try {
              const parsed = JSON.parse(text || '[]');
              return Array.isArray(parsed) ? parsed.length : 0;
            } catch {
              return 0;
            }
          };
          const current = await readKeyText(to);
          if (turns(flat) >= turns(current)) await request('storage.set', { key: to, value: flat });
          await request('storage.remove', { key: name });
          out.histories += 1;
          out.groupIDs.push(history[1]);
        }
      } else if (kind === 'stickers' && targetExists) {
        await request('storage.remove', { key: name });
        out.stickers += 1;
      }
    } catch (err) {
      note(`整理旧文件失败：${name}（${(err && err.message) || err}）`);
    }
  }

  // 账本里的旧名字要跟着改：账本记的是"`bilivideoabc` 在根目录"，搬过去之后那句话
  // 指着一个不存在的地方，真正被搬走的文件反而永远没人收。
  const ledger = await readVideoFiles();
  let renamed = 0;
  const fixed = ledger.map((row) => {
    const key = String((row && row.key) || '');
    if (!key || key.includes('/')) return row;
    renamed += 1;
    return { ...row, key: `${VIDEO_DIR}/${key}` };
  });
  if (renamed) {
    try {
      await request('storage.set', { key: DATA.videoFiles, value: JSON.stringify(fixed.slice(-40)) });
    } catch (err) {
      note(`账本里的旧产物名字没改成功：${(err && err.message) || err}`);
    }
  }
  return out;
}

/**
 * 把历史存在、群索引里却没有的群补回索引。
 *
 * 索引是 1.10 那个"启动就清空"的 bug 的受害者，而 `history/<群号>` 是证据：这个群确实
 * 跟机器人说过话。补一条 `{id, name:'', count:0, lastAt:0}` 而不是丢掉它，是为了工坊的
 * 群列表（以及"忘掉这个群"）还能看到它；`lastAt: 0` 让主动开口不会把陈年旧群当成活跃群。
 */
async function seedGroupsFromHistory(groupIDs) {
  const wanted = [...new Set(groupIDs.map((id) => cleanSegment(id)).filter(Boolean))];
  if (!wanted.length) return 0;
  const rows = await readGroupsIndex(DATA.groups);
  const known = new Set(rows.map((row) => cleanSegment(row && row.id)));
  const added = wanted.filter((id) => !known.has(id)).map((id) => ({ id, name: '', count: 0, lastAt: 0 }));
  if (!added.length) return 0;
  try {
    await request('storage.set', { key: DATA.groups, value: JSON.stringify([...rows, ...added]) });
  } catch (err) {
    note(`补回群索引失败：${(err && err.message) || err}`);
    return 0;
  }
  return added.length;
}

/** Reads one key's text, or '' when it is not there. */
async function readKeyText(key) {
  try {
    const res = await request('storage.get', { key });
    return String((res && res.value) || '');
  } catch {
    return '';
  }
}

/** Whether one key exists — used by absorbLegacyFiles, which must not guess. */
async function existsKey(key) {
  try {
    const res = await request('storage.stat', { key });
    return Boolean(res && res.exists);
  } catch {
    return false;
  }
}

/**
 * 两个 JSON 数组合并成一份，`keyOf` 取出用来判重的字段。
 *
 * 顺序是**平铺那份在前**：根目录里还有同名文件，说明某个旧进程此刻正在写它（升级那一刻
 * 内存里还是 1.10 的代码），所以它是最新的一份；新位置那份只补上平铺那份没有的条目。
 */
function unionRows(flat, current, keyOf) {
  const out = [];
  const seen = new Set();
  for (const row of [...flat, ...current]) {
    const key = keyOf(row);
    if (key === undefined || key === null || key === '') continue;
    if (seen.has(String(key))) continue;
    seen.add(String(key));
    out.push(row);
  }
  return out;
}

/**
 * 把根目录里仍然存在的 1.10 平铺键并进新位置，然后删掉平铺那一份。
 *
 * 这不是迁移的一部分（迁移有标记，只跑一次），而是**每次启动都跑的兜底**：真机上撞到
 * 过两次——整理干净之后，根目录里又冒出 `status` / `groups` / `log`，因为桌宠（或市场）
 * 内存里还是 1.10 的代码，它照旧往根目录写。一次 `storage.stat` + 几个小文件，代价可以
 * 忽略；换来的是"整理过的目录会自己保持干净"，而不是靠用户猜该关哪个程序。
 *
 * 目标不存在 → 改名（零拷贝）；已存在 → **合并**而不是覆盖，因为平铺那份可能带着新东西
 * （旧进程刚记住的群名、刚导入的表情包行），覆盖会丢。合并之后删掉平铺文件，否则下一次
 * 启动又看到它。
 */
async function absorbLegacyFiles(names) {
  const plan = [
    // [] 表示"两份都是随时会重写的快照"，没有合并的意义，删掉平铺那份即可。
    { from: 'status', to: DATA.status, by: '' },
    { from: 'log', to: DATA.log, by: '' },
    { from: 'groups', to: DATA.groups, by: (row) => String((row && row.id) || '') },
    { from: 'stickers', to: DATA.stickerIndex, by: (row) => String((row && row.hash) || '') },
    { from: 'categories', to: DATA.stickerCategories, by: (row) => String(row || '') },
    { from: 'bilivideo-files', to: DATA.videoFiles, by: (row) => String((row && row.key) || '') },
  ];
  let absorbed = 0;
  for (const item of plan) {
    if (!names.has(item.from)) continue;
    try {
      if (!(await existsKey(item.to))) {
        const res = await request('storage.move', { from: item.from, to: item.to });
        if (res && res.moved) absorbed += 1;
        continue;
      }
      if (item.by) {
        const parse = (text) => {
          try {
            const value = JSON.parse(text || '[]');
            return Array.isArray(value) ? value : [];
          } catch {
            return [];
          }
        };
        const flat = parse(await readKeyText(item.from));
        if (flat.length) {
          const current = parse(await readKeyText(item.to));
          const merged = unionRows(flat, current, item.by);
          await request('storage.set', { key: item.to, value: JSON.stringify(merged) });
        }
      }
      await request('storage.remove', { key: item.from });
      absorbed += 1;
    } catch (err) {
      note(`合并旧的 ${item.from} 失败：${(err && err.message) || err}`);
    }
  }
  return absorbed;
}

/**
 * 每次启动的轻量整理：根目录里"认得出是 1.10 写的"东西全部归位。
 *
 * 三步：把六个平铺键并进新位置（absorbLegacyFiles）、把索引不知道的字节与记忆按名字
 * 归位（sweepLeftovers）、把有记忆没索引的群补回索引（seedGroupsFromHistory）。
 * 全部幂等，目录已经干净时只花一次 `storage.list`。
 */
async function tidyLeftovers() {
  if (!useFolders || !granted.has('storage')) return { absorbed: 0, swept: 0, seeded: 0 };
  let listing = null;
  try {
    listing = await request('storage.list', {});
  } catch {
    // 老宿主没有 storage.list：1.10 的桌宠也不会产生这批文件，安静跳过。
    return { absorbed: 0, swept: 0, seeded: 0 };
  }
  const names = new Set((Array.isArray(listing && listing.files) ? listing.files : [])
    .map((entry) => String((entry && entry.name) || '')));
  const absorbed = await absorbLegacyFiles(names);
  const swept = await sweepLeftovers([...names]);
  const seeded = await seedGroupsFromHistory(swept.groupIDs);
  // 旧上限时代留下的残图没有标记，靠字节数认一次（见 backfillTruncated）。
  const cut = await backfillTruncated();
  if (cut) note(`标出了 ${cut} 张被旧上限截断过的表情包（工坊里可以按「残图」筛出来）`);
  // 索引里有、字节没有的条目：2026-10-31 那次 media/ 淘汰留下的废墟（删了 318 个字节文件，
  // 一条索引都没删）。不清理的话，插件每次随机抽到其中一条就静默失败一次，而用户在图库里看到
  // 的是"图还在、就是发不出来"——比直接没有更费解。
  const orphaned = await dropOrphanStickers();
  if (orphaned) note(`清掉了 ${orphaned} 条没有字节的表情包记录（图片文件已经不在了）`);
  // 磁盘上的 group 索引刚被改过，而内存里那份（如果已经读过）现在是旧的：下一次
  // `persistNow` 会拿它把刚合并进来的东西盖掉。读过就重读一遍，没读过就交给 startBot。
  if ((absorbed || seeded || swept.histories) && state.groupsLoaded) await loadGroupsIndex();
  if (absorbed || swept.products || swept.histories || swept.stickers || seeded || orphaned) {
    note(`又整理了一次：${absorbed} 个旧键、${swept.histories} 份群记忆、${swept.stickers} 张表情包、${swept.products} 个视频产物，补回 ${seeded} 个群`);
  }
  return { absorbed, swept, seeded, orphaned };
}

/**
 * 索引里有、字节文件已经没有的表情包条目——安静地去掉。
 *
 * 来源是 2026-10-31 那次 `media/` 字节预算淘汰：它按最旧删了 318 个字节文件，而索引一条没动
 * （那时候的 planEviction 不认识"手工导入"这回事）。留着这些空条目没有任何好处：
 * 随机抽到它只会走到 `readKeyText` 返回空、然后跳过——用户看到的是"库里有图、就是发不出来"。
 *
 * 一次 `storage.list` 就能判：在字节目录里的才留。列表拿不到（老宿主没有 storage.list）就
 * **什么都不做**——猜错了会把好好的图删掉，这正是这个函数存在的教训。
 */
async function dropOrphanStickers() {
  if (!useFolders || !granted.has('storage')) return 0;
  let listing = null;
  try {
    listing = await request('storage.list', { sub: STICKER_BYTES_DIR });
  } catch {
    return 0;
  }
  if (!listing) return 0;
  const present = new Set(
    ((listing && listing.files) || []).map((file) => String((file && file.name) || '')),
  );
  const index = await loadStickerIndex().catch(() => []);
  if (!Array.isArray(index) || !index.length) return 0;
  // 没有字节的条目：全部收走之后如果一个都不剩，就什么都不写（空库不是"清空"，那是另一个决定）。
  const kept = index.filter((row) => row && row.hash && present.has(cleanSegment(row.hash)));
  if (kept.length === index.length) return 0;
  if (!kept.length) return 0;
  await writeStickerIndex(kept);
  return index.length - kept.length;
}

/**
 * 把 1.10 的平铺文件搬进各自的文件夹。**一次性、幂等、可中断。**
 *
 * 用宿主新给的 `storage.move`（一次改名）而不是"读出来再写回去"：这台机器上光表情包
 * 就有两百多 MB 的 base64，走一遍桥就是三倍流量和两倍磁盘，而改名是零拷贝。
 *
 * 三种"搬不动"都不算错，全部安静跳过 —— 迁移是升级时的整理动作，不该让机器人起不来：
 *   · 源文件不存在（已经搬过，或者本来就没写过）；
 *   · 目标已存在（另一份进程搬过了：桌宠的常驻帧和市场的工坊都可能先启动）；
 *   · 宿主还不支持子目录键（`state/layout` 被拒 = 1.10 的桌宠），此时整体退回旧键名，
 *     一行日志说明"要整理得先升级桌宠"，插件本身照常工作。
 *
 * 搬完写一个 `state/layout` 标记：之后每次启动只多一次 stat，而不是三百次改名。
 *
 * 这里**只**按索引搬（快、有名字可依）。索引不知道的东西——索引被清空过的群记忆、忘了
 * 记账的视频、索引里没有的表情包——由每次启动都会跑的 `tidyLeftovers` 兜住，因为在真机
 * 上，升级那一刻的群索引已经是空表了。
 */
async function migrateDataLayout() {
  if (!granted.has('storage')) return { moved: 0, skipped: true };
  if (!useFolders) return { moved: 0, skipped: true };
  try {
    const marker = await request('storage.stat', { key: DATA.layout });
    if (marker && marker.exists) return { moved: 0, skipped: true };
  } catch (err) {
    useLegacyKeys();
    note(`这个桌面版本还不支持分文件夹存放，数据先按旧文件名继续；把桌宠升级到 1.11 后会自动整理：${(err && err.message) || err}`);
    return { moved: 0, skipped: true };
  }

  let moved = 0;
  const move = async (from, to) => {
    if (!from || !to || from === to) return;
    try {
      const res = await request('storage.move', { from, to });
      if (res && res.moved) moved += 1;
    } catch (err) {
      note(`整理数据失败：${from} → ${to}（${(err && err.message) || err}）`);
    }
  };

  // 表情包的 hash 与每群的编号都**只**由那两个索引知道，所以先按旧键把它们读出来。
  const rows = await loadStickerIndex('stickers');
  const groups = await readGroupsIndex('groups');

  for (const [from, to] of LEGACY_KEYS) await move(from, to);
  for (const row of rows) {
    if (!row || !row.hash) continue;
    await move(`sticker_${cleanSegment(row.hash)}`, `${STICKER_BYTES_DIR}/${cleanSegment(row.hash)}`);
  }
  for (const row of groups) {
    if (!row || !row.id) continue;
    await move(`hist_${cleanSegment(row.id)}`, `${HISTORY_DIR}/${cleanSegment(row.id)}`);
  }

  try {
    await request('storage.set', {
      key: DATA.layout,
      value: JSON.stringify({ version: LAYOUT_VERSION, moved, at: Date.now() }),
    });
  } catch (err) {
    // 标记写不进去只意味着下次启动再整理一遍（每个搬迁都是幂等的），不算错。
  }
  if (moved) note(`数据目录已整理：${moved} 个文件搬进了 state/、history/、media/`);
  return { moved, skipped: false };
}

