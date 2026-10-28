// lib/importer.js —— 主人私聊导入表情包
//
// 合并转发/图片 → 识图 → 存字节；以及"残图完整版就地补齐"。
//
// 从原来的 app.js 按节**原样搬出来**（1.12 的重构）：内容逐字未改，只是换了个文件。
// 经典 script 共享同一个全局作用域，所以这里不用 import/export；
// 加载顺序写在 panel.html 里（顺序 = 原来的文件顺序，所以原有的依赖关系不变）。
'use strict';

// --- 素材导入：私聊合并转发 → 识图分类 → 入库 ------------------------------

/**
 * A tiny FNV-1a hash, used as the sticker's identity.
 *
 * Not a cryptographic hash and deliberately so: the job is "have I seen these exact
 * bytes before", over data the owner just sent to their own bot. It runs in the page
 * with no imports, which is why the plugin needs no new capability for it.
 */
function hashOf(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** True for a private message from the configured owner. */
function isOwner(event, data) {
  const owner = String(state.cfg.ownerQQ || '').trim();
  if (!owner) return false;
  const sender = String((data && data.sender_id) || '');
  // The protocol side reports the bot's own messages too; without this guard the
  // import would classify its own summary replies.
  const selfID = String(event.self_id || state.selfID || '');
  if (selfID && sender === selfID) return false;
  return sender === owner;
}

/** Sends one private reply to the owner (progress and results). */
async function replyToOwner(userID, text) {
  try {
    await api('send_private_message', {
      user_id: Number(userID),
      message: [{ type: 'text', data: { text } }],
    });
  } catch (err) {
    note(`私聊回复失败：${(err && err.message) || err}`);
  }
}

/** Every image URL in one list of segments (top level, quoted, or forwarded). */
async function imageUrlsIn(segments, groupID) {
  const urls = [];
  const seen = new Set();
  const add = (seg) => {
    if (!seg || seg.type !== 'image' || !seg.data || !seg.data.temp_url) return;
    const url = String(seg.data.temp_url);
    if (seen.has(url)) return;
    seen.add(url);
    urls.push(url);
  };
  for (const seg of segments || []) {
    if (!seg) continue;
    if (seg.type === 'image') add(seg);
    else if (seg.type === 'reply' && seg.data) {
      for (const inner of seg.data.segments || []) add(inner);
    } else if (seg.type === 'forward' && seg.data && seg.data.forward_id) {
      try {
        const res = await api('get_forwarded_messages', {
          forward_id: String(seg.data.forward_id),
          peer_id: Number(groupID) || groupID,
          message_scene: 'private',
        });
        const rows = Array.isArray(res) ? res : (res && Array.isArray(res.messages) ? res.messages : []);
        for (const row of rows) {
          for (const inner of (row && row.segments) || []) add(inner);
        }
      } catch (err) {
        note(`展开转发失败：${(err && err.message) || err}`);
      }
    }
  }
  return urls;
}

/**
 * Asks the vision model what ONE sticker is: a category from the closed set, plus a
 * short description. The answer is parsed defensively - a model that adds prose still
 * yields a usable category, and an unusable answer is skipped rather than guessed at.
 */
async function classifySticker(url) {
  const res = await request('llm.chat', {
    text: '这是 QQ 聊天里的一张表情包。只回答两行：第一行是分类（只能选一个：' +
      STICKER_TAGS.join('/') + '），第二行是十个字以内的画面描述。',
    system: '你是一个给表情包打标签的助手，只输出分类和描述，不要解释。',
    model: String(state.cfg.visionModel || '').trim(),
    images: [url],
  });
  const lines = String((res && res.text) || '')
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const tag = STICKER_TAGS.find((candidate) => (lines[0] || '').includes(candidate)) || '';
  const description = clampOneLine(lines[1] || lines[0] || '', 40);
  return { tag, description };
}

/**
 * Loads the sticker index (`[{hash, tag, description}]`).
 *
 * `key` is a parameter with a default rather than a constant read, because the
 * migration has to read the OLD name (`stickers`, the 1.10 flat one) before anything
 * has been moved, while every other caller wants the folder.
 */
async function loadStickerIndex(key) {
  try {
    const res = await request('storage.get', { key: key || DATA.stickerIndex });
    const parsed = JSON.parse((res && res.value) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Loads the group index (`[{id, name, count, lastAt}]`) from one key. */
async function readGroupsIndex(key) {
  try {
    const res = await request('storage.get', { key });
    const parsed = JSON.parse((res && res.value) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Imports every sticker in one message: fetch the bytes, classify them, store them.
 *
 * Base64 in the plugin's private storage rather than the CDN url, because those urls
 * expire: a library of expiring links is a library that goes empty overnight. The
 * bytes also make the identity (hash) stable, so sending the same pack twice adds
 * nothing.
 */
async function importStickers(event, data) {
  const userID = String(data.sender_id || '');
  const segments = Array.isArray(data.segments) ? data.segments : [];
  const urls = await imageUrlsIn(segments, data.peer_id);
  if (!urls.length) {
    await replyToOwner(userID, '没在这条消息里找到图片。发一条「合并转发」或者直接发图给我。');
    return;
  }
  const model = String(state.cfg.visionModel || '').trim();
  if (!model) {
    await replyToOwner(userID, '还没设置看图模型（visionModel），没法识别图片。');
    return;
  }
  const index = await loadStickerIndex();
  const known = new Set(index.map((row) => row.hash));
  const tally = new Map();
  let added = 0;
  let failed = 0;
  let truncated = 0;
  let repaired = 0;
  let duplicates = 0;
  // 残图指纹表：只在真的来了新图时才建（一次读一遍残图字节，之后索引里就有 sig 了）。
  let signatures = null;
  await replyToOwner(userID, `收到 ${urls.length} 张图，正在识别…`);
  let seen = 0;
  for (const url of urls) {
    seen += 1;
    // 一百多张图要跑好几分钟，中间必须报进度：否则对面看到的就是"发完没反应"。
    if (seen % 15 === 0) {
      await replyToOwner(userID, `已处理 ${seen}/${urls.length} 张…`);
    }
    try {
      const fetched = await request('net.fetch', { url, encoding: 'base64' });
      const base64 = String((fetched && fetched.body) || '');
      if (!base64) {
        failed += 1;
        continue;
      }
      const hash = hashOf(base64);
      const cut = Boolean(fetched && fetched.truncated);
      const sig = stickerSignature(base64);
      // **先**问"这是不是某张残图的完整版"，再问"这张是不是已经导过"：顺序不能反。
      // 反过来的话，一张已经被当成新图导进来过的完整版（hash 已在索引里）会在这里直接跳过，
      // 它对应的那张残图就永远补不上了。
      if (!signatures) signatures = await truncatedSignatureMap(index);
      if (signatures.size) {
        const row = signatures.get(sig);
        if (row) {
          await request('storage.set', { key: stickerBytesKey(row.hash), value: base64 });
          delete row.truncated;
          row.sig = sig;
          row.recoveredAt = Date.now();
          signatures.delete(sig);
          // 顺手收掉"同一张图已经作为新行导进来过"的那份：用户重发一遍时必然会撞到
          // （几分钟前那批就是按新图入库的），两份并存等于图库里同一张图有两行。
          const dup = index.findIndex((item) => item && item !== row && item.hash === hash);
          if (dup >= 0) {
            const victim = index[dup];
            index.splice(dup, 1);
            known.delete(victim.hash);
            try {
              await request('storage.remove', { key: stickerBytesKey(victim.hash) });
            } catch {
              // 删不掉不影响"已经补好"这件事，只是多占一份盘。
            }
            duplicates += 1;
          }
          repaired += 1;
          continue;
        }
      }
      if (known.has(hash)) continue;
      const { tag, description } = await classifySticker(url);
      if (!tag) {
        failed += 1;
        continue;
      }
      await request('storage.set', { key: stickerBytesKey(hash), value: base64 });
      // 宿主把这张图截断过（超过单次下载上限）就记下来：它看起来能显示，实际只是前几帧。
      // `sig` 是"同一张图"的指纹，将来重新发一遍时靠它认出"这不是新图"。
      index.push({
        hash,
        tag,
        description,
        sig,
        ...(cut ? { truncated: true } : {}),
      });
      known.add(hash);
      tally.set(tag, (tally.get(tag) || 0) + 1);
      if (cut) truncated += 1;
      added += 1;
    } catch (err) {
      failed += 1;
      note(`识别失败：${(err && err.message) || err}`);
    }
  }
  await request('storage.set', { key: DATA.stickerIndex, value: JSON.stringify(index) });
  const summary = [...tally.entries()].map(([tag, n]) => `${tag} ${n}`).join('、') || '无新增';
  // 库里还留着旧上限时代的残图就说一句：完整的那几张刚导进来，旧的可以删了。
  const brokenLeft = index.filter((row) => row && row.truncated).length;
  await replyToOwner(
    userID,
    `入库完成：新增 ${added} 张，跳过 ${urls.length - added - failed - repaired} 张（已存在），失败 ${failed} 张。` +
      (repaired ? `另外 ${repaired} 张是旧残图的完整版，已就地补齐（没重新识图）。` : '') +
      (duplicates ? `顺手收掉了 ${duplicates} 张重复的。` : '') +
      `${truncated ? `其中 ${truncated} 张仍然太大被截断。` : ''}分类：${summary}` +
      (brokenLeft ? `\n图库里还有 ${brokenLeft} 张旧残图（被老版本截断的）：到工坊的「残图」里可以一键从群历史找回，或者删掉。` : ''),
  );
  note(`素材导入：新增 ${added} 张，失败 ${failed} 张${repaired ? `，就地补齐残图 ${repaired} 张` : ''}${duplicates ? `，清掉重复 ${duplicates} 张` : ''}${truncated ? `，截断 ${truncated} 张` : ''}${brokenLeft ? `，库里仍有 ${brokenLeft} 张旧残图` : ''}`);
}

/** One inbound private message: the owner's import channel, and nothing else. */
async function onPrivateMessage(event) {
  const data = event.data || {};
  if (!isOwner(event, data)) return;
  const segments = Array.isArray(data.segments) ? data.segments : [];
  const hasImage = segments.some((seg) => seg && (seg.type === 'image' || seg.type === 'forward'));
  if (!hasImage) {
    await replyToOwner(String(data.sender_id || ''), '把表情包用「合并转发」发我，或者直接发图片。');
    return;
  }
  await importStickers(event, data);
}

// --- 表情包 ----------------------------------------------------------------

/** The moods the model may ask for. A closed set, so a stray word is not a sticker. */
const STICKER_TAGS = ['开心', '无语', '疑惑', '惊讶', '点赞', '嘲笑', '委屈', '生气', '沉默', '摸鱼'];

/**
 * Splits the model's reply into text and an optional legacy mood tag.
 *
 * 1.12 起表情是靠尾部 JSON 围栏里的 `meme` 指定的（见 parseReply）。这个老标记仍然认，
 * 因为不是每个模型都会照约定写围栏；认它意味着"忘了写围栏"只是少了记忆/表情能力，
 * 而不是把 `〔表情:开心〕` 这种东西发进群里。
 */
function splitStickerTag(text) {
  const raw = String(text || '');
  const match = raw.match(/[〔\[（(]\s*表情\s*[:：]\s*([^〕\]）)]+?)\s*[〕\]）)]\s*$/);
  if (!match) return { text: raw.trim(), tag: '' };
  const tag = match[1].trim();
  const cleaned = raw.slice(0, match.index).trim();
  return { text: cleaned, tag: STICKER_TAGS.includes(tag) ? tag : '' };
}

/** The sticker library: one http(s) URL per line. Empty means the feature is off. */
function stickerLibrary() {
  const out = [];
  for (const line of String(state.cfg.stickerUrls || '').split(/[\r\n]+/)) {
    const trimmed = line.trim();
    if (!trimmed || !/^https?:\/\//i.test(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
}

