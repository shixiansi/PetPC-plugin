// lib/inbound.js —— 收到的消息怎么变成一次回答
//
// 消息段扁平化、@ 判定、引用展开、视频闸、每群排队、takeTurn。
//
// 从原来的 app.js 按节**原样搬出来**（1.12 的重构）：内容逐字未改，只是换了个文件。
// 经典 script 共享同一个全局作用域，所以这里不用 import/export；
// 加载顺序写在 panel.html 里（顺序 = 原来的文件顺序，所以原有的依赖关系不变）。
'use strict';

// --- message handling --------------------------------------------------------

/** True when this group's id is allowed by the `groupAllow` setting. */
function groupAllowed(groupID) {
  const allow = listOf(state.cfg.groupAllow);
  if (allow.length === 0) return true;
  return allow.includes(String(groupID));
}

/** True when the segments mention the bot itself (an `@`). */
function mentionsBot(segments, selfID) {
  if (!selfID) return false;
  for (const seg of segments) {
    if (!seg || seg.type !== 'mention' || !seg.data) continue;
    if (String(seg.data.user_id) === String(selfID)) return true;
  }
  return false;
}

/**
 * Flattens the segments into the text the model reads.
 *
 * Non-text segments become bracketed placeholders rather than being dropped: a
 * message that is only an image would otherwise arrive as an empty string and be
 * answered as if nothing had been said.
 *
 * `image` carries a `summary` (the platform's own description, e.g. "[动画表情]"), so
 * that is used when present - "[图片]" alone tells a model nothing it can act on.
 * Reading the PICTURE itself needs a multimodal request, which the host's llm.chat
 * does not send (it sends text messages only); the url is deliberately NOT written
 * into the prompt, because a model that cannot see it would hallucinate about it.
 */
function plainText(segments, selfID) {
  const parts = [];
  for (const seg of segments) {
    if (!seg) continue;
    const data = seg.data || {};
    switch (seg.type) {
      case 'text':
        parts.push(String(data.text || ''));
        break;
      case 'mention':
        if (String(data.user_id) !== String(selfID)) {
          parts.push(`@${data.name || data.user_id}`);
        }
        break;
      case 'mention_all':
        parts.push('@全体成员');
        break;
      case 'face':
        parts.push('[表情]');
        break;
      case 'image': {
        const summary = String(data.summary || '').trim();
        parts.push(summary ? `[图片：${summary}]` : '[图片]');
        break;
      }
      case 'record':
      case 'voice':
      case 'audio':
        // 同视频：声音它听不到，占位符要写清楚，别让模型顺着猜。
        parts.push('[语音（听不到）]');
        break;
      case 'video':
        // 明确写出"看不到内容"：模型只看到 `[视频]` 时会顺着猜（"这视频挺有意思"），
        // 而这个占位符会进背景聊天缓冲，所以措辞必须诚实。
        parts.push('[视频（画面看不到）]');
        break;
      case 'file':
        parts.push(`[文件：${String(data.file_name || '').trim() || '未命名'}]`);
        break;
      case 'forward':
        // Replaced by the expanded text when the API answers; see enrichSegments.
        parts.push(forwardPlaceholder(data));
        break;
      case 'market_face':
        // 市场表情：协议端给了 `summary`（"笑"之类的短标签），带上它模型才谈得上"看懂"。
        parts.push(String(data.summary || '').trim() ? `[表情：${String(data.summary).trim()}]` : '[表情]');
        break;
      case 'json':
      case 'xml':
      case 'light_app': {
        // A shared card (B 站, 公众号, 音乐…) used to vanish completely: the type was not
        // in this switch, so the model saw a message with nothing in it and had no way to
        // react to what was shared. The title is the part worth keeping.
        const title = cardTitle(seg.data);
        parts.push(title ? `[卡片：${title}]` : '[卡片]');
        break;
      }
      case 'reply':
        // The quoted message's own segments travel with the reply segment, but the
        // quote is rendered as a PREFIX by enrichSegments, so it is skipped here.
        break;
      case 'location':
        parts.push('[位置]');
        break;
      case 'music':
        parts.push(`[音乐：${String(data.title || data.name || '').trim() || '未命名'}]`);
        break;
      case 'contact':
      case 'recommend':
        parts.push(`[名片：${String(data.nickname || data.name || '').trim() || '某人'}]`);
        break;
      case 'dice':
        parts.push('[骰子]');
        break;
      case 'rps':
        parts.push('[猜拳]');
        break;
      case 'poke':
        parts.push('[戳一戳]');
        break;
      case 'notice':
      case 'group_notice':
        parts.push('[群公告]');
        break;
      default:
        // 认不出的段类型不再静默丢掉：一个"什么都没说"的消息会让模型以为群里很安静。
        // 也不把原始负载写进 prompt（那是 base64 噪声），只标一句类型名。
        if (seg.type) parts.push(`[${String(seg.type).slice(0, 16)}]`);
        break;
    }
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/**
 * The title of a shared card, wherever that card keeps it.
 *
 * Cards arrive as `{data: "<json string>"}`, as `{json_payload: "..."}`, as an already
 * nested object, or as XML - and QQ's structmsg puts the title under `meta.news.title`
 * or `meta.detail_1.title/desc`. Four shapes, one answer, bounded so a hostile payload
 * cannot turn into a paragraph.
 */
function cardTitle(data) {
  const payload = data || {};
  const raw = [payload.data, payload.json_payload, payload.xml, payload.content].find((value) => typeof value === 'string' && value.trim());
  const text = String(raw || '');
  if (text) {
    const xmlTitle = /<title>([\s\S]{1,80}?)<\/title>/.exec(text);
    if (xmlTitle) return xmlTitle[1].trim();
    try {
      const parsed = JSON.parse(text);
      const title = pickCardTitle(parsed);
      if (title) return title;
    } catch {
      // Not JSON (or not parseable): fall through to the regex below.
    }
    const loose = /"(?:title|desc)"\s*:\s*"([^"]{1,80})"/.exec(text);
    if (loose) return loose[1];
  }
  return pickCardTitle(payload);
}

function pickCardTitle(value) {
  if (!value || typeof value !== 'object') return '';
  const meta = value.meta || {};
  const candidates = [
    meta.news && meta.news.title,
    meta.detail_1 && meta.detail_1.title,
    meta.detail_1 && meta.detail_1.desc,
    meta.music && meta.music.title,
    value.prompt,
    value.title,
  ];
  for (const candidate of candidates) {
    const text = String(candidate || '').trim();
    if (text) return text.slice(0, 80);
  }
  return '';
}

/** What a forward block looks like when its content could not be fetched. */
function forwardPlaceholder(data) {
  const title = String(data.title || '').trim();
  const summary = String(data.summary || '').trim();
  const preview = Array.isArray(data.preview) ? data.preview.slice(0, 3) : [];
  const bits = [title, summary].filter(Boolean);
  let text = `[合并转发${bits.length ? '：' + bits.join(' / ') : ''}]`;
  if (preview.length) {
    text += `\n预览：${preview.map((p) => String(p).trim()).filter(Boolean).join(' | ')}`;
  }
  return text;
}

/**
 * Turns the inbound segments into the text the model reads, WITH the two things that
 * need a second look: the quoted message, and the inside of a forwarded block.
 *
 * Both were silently dropped before, which made two ordinary situations unanswerable:
 * "reply to the bot with a quote and ask about it" arrived as a bare question with no
 * subject, and a forwarded chat log arrived as "[合并转发]" and nothing else.
 *
 *   - QUOTE: Milky's `reply` segment carries the quoted message's own `segments`,
 *     `sender_name` and `time`, so no extra request is needed - the text is already
 *     in the event.
 *   - FORWARD: only an id is carried, so the content has to be fetched with
 *     `get_forwarded_messages`. Failure is tolerated rather than fatal: the block
 *     still shows its title/summary/preview, which is what the user sees in QQ too.
 */
async function enrichSegments(segments, selfID, groupID) {
  const quoted = [];
  const forwarded = [];
  /** Segments of the quoted message(s), so their pictures can be collected too. */
  const quoteSegments = [];
  for (const seg of segments || []) {
    if (!seg) continue;
    if (seg.type === 'reply' && seg.data) {
      let inner = Array.isArray(seg.data.segments) ? seg.data.segments : [];
      // The protocol side may send the quote as an "empty" reference (only
      // message_seq/sender/time). Then the quoted content - text AND pictures - has to
      // be fetched by sequence number, which is what made "引用一张图再问这是什么"
      // arrive as a question about nothing.
      if (!inner.length && seg.data.message_seq) {
        inner = await fetchQuotedSegments(groupID, seg.data.message_seq);
      }
      for (const item of inner) quoteSegments.push(item);
      const text = plainText(inner, selfID).trim();
      const who = String(seg.data.sender_name || seg.data.sender_id || '').trim();
      if (text) {
        quoted.push(`（引用${who ? ' ' + who : ''}：${clampOneLine(text, 300)}）`);
      } else if (inner.length) {
        quoted.push(`（引用${who ? ' ' + who : ''}：一条非文字消息）`);
      }
    } else if (seg.type === 'forward' && seg.data && seg.data.forward_id) {
      forwarded.push(seg.data);
    }
  }

  let body = plainText(segments, selfID);
  if (forwarded.length) {
    const expanded = [];
    for (const block of forwarded.slice(0, 2)) {
      expanded.push(await expandForward(block, groupID));
    }
    // The placeholder is already the fallback text, so replacing the whole body is
    // wrong when other segments were present: the expansion is appended instead.
    body = `${body}\n${expanded.join('\n')}`.trim();
  }
  if (quoted.length) {
    body = `${quoted.join('\n')}\n${body}`.trim();
  }
  return { text: body, quoteSegments };
}

/**
 * Fetches the segments of the message a `reply` segment points at.
 *
 * Milky's `get_message` takes the scene, the peer and the sequence; the reply shape
 * varies between implementations (an array, or `{message:{segments}}`, or
 * `{segments}`), so all three are accepted. Failure is logged and treated as "no
 * quoted content" - a quote that cannot be read is not worth failing the answer for.
 */
async function fetchQuotedSegments(groupID, messageSeq) {
  try {
    const res = await api('get_message', {
      message_scene: 'group',
      peer_id: Number(groupID) || groupID,
      message_seq: Number(messageSeq),
    });
    const payload = res && res.message !== undefined ? res.message : res;
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.segments)) return payload.segments;
    return [];
  } catch (err) {
    note(`引用内容取不到（协议端只能读到启动之后的消息），按无引用处理：${(err && err.message) || err}`);
    return [];
  }
}

/**
 * Fetches one forwarded block's messages and renders them as plain text.
 *
 * The cap (8 messages, 80 characters each) is a budget decision: a forwarded log can
 * be hundreds of messages, and sending all of it would cost more than the answer is
 * worth while pushing the actual question out of the model's attention.
 */
async function expandForward(block, groupID) {
  try {
    const res = await api('get_forwarded_messages', {
      forward_id: String(block.forward_id),
      peer_id: Number(groupID) || groupID,
      message_scene: 'group',
    });
    const rows = Array.isArray(res) ? res : (res && Array.isArray(res.messages) ? res.messages : []);
    if (!rows.length) return forwardPlaceholder(block);
    const lines = rows.slice(0, 8).map((row) => {
      const who = String(row.sender_name || row.user_id || '').trim();
      const text = plainText(Array.isArray(row.segments) ? row.segments : [], '').trim();
      return `${who ? who + '：' : ''}${trimTo(text, 80)}`;
    }).filter((line) => line.trim() !== '');
    if (!lines.length) return forwardPlaceholder(block);
    const more = rows.length > lines.length ? `\n（还有 ${rows.length - lines.length} 条）` : '';
    return `[合并转发内容]\n${lines.join('\n')}${more}`;
  } catch (err) {
    note(`读取转发消息失败：${(err && err.message) || err}`);
    return forwardPlaceholder(block);
  }
}

/** Clamps a multi-line string to n characters, keeping it single-line. */
function clampOneLine(text, n) {
  return trimTo(String(text || '').replace(/\s+/g, ' ').trim(), n);
}

/** Strips the configured trigger prefix, when the message starts with it. */
function stripPrefix(text) {
  const prefix = String(state.cfg.prefix || '').trim();
  if (!prefix) return text;
  if (!text.startsWith(prefix)) return text;
  return text.slice(prefix.length).trim();
}

/**
 * Whether this message is addressed to the bot - or worth an unprompted reply.
 *
 * THREE tiers, and the middle one is the reason this is not a boolean:
 *
 *   1. a mention, or a configured prefix, ALWAYS answers. That is the user talking
 *      to the bot on purpose;
 *   2. `atOnly` (the default) refuses everything else. It is the only mode that
 *      cannot flood a group, and it stays the default;
 *   3. with `atOnly` off, `replyChance` decides how often it joins in: 0 never,
 *      100 every message, anything between is a coin flip per message.
 *
 * Why a percentage rather than "on/off": "reply to everything" is a different
 * feature from "occasionally chime in", and the useful setting is the second one.
 * A switch would force the user to choose between silence and a monologue, and the
 * cooldown (5s by default) would turn the monologue into "answers once every five
 * seconds" - which reads as a broken bot rather than a chatty one.
 */
function shouldAnswer(text, mentioned) {
  if (mentioned) return true;
  const prefix = String(state.cfg.prefix || '').trim();
  if (prefix !== '' && text.startsWith(prefix)) return true;
  if (flag(state.cfg.atOnly, true)) return false;
  const chance = number(state.cfg.replyChance, 0, 0, 100);
  if (chance <= 0) return false;
  if (chance >= 100) return true;
  return Math.random() * 100 < chance;
}

/** The speaker's display name, preferring the group card over the nickname. */
function speakerOf(data) {
  const member = data.group_member || {};
  const card = stripControl(member.card);
  if (card) return card.slice(0, 32);
  const nickname = stripControl(member.nickname);
  if (nickname) return nickname.slice(0, 32);
  return String(data.sender_id || '某人');
}

/**
 * The picture URLs worth sending to a vision model.
 *
 * Empty unless `visionModel` is set, which is the switch: without it the pictures stay
 * as `[图片：摘要]` text and cost nothing. The count is capped by `visionMaxImages`
 * because every picture is billed as tokens on every turn it appears in.
 */
function imagesOf(segments) {
  const model = String(state.cfg.visionModel || '').trim();
  const max = number(state.cfg.visionMaxImages, 2, 0, 4);
  if (!model || max <= 0) return [];
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
    // A picture the user REPLIED to lives inside the reply segment, not at the top
    // level - and "引用一张图再问这是什么" is the commonest way people ask about an
    // image. Scanning only the top level made that arrive with no picture at all,
    // and the model answered "我没看到图" - which was literally true.
    if (seg && seg.type === 'reply' && seg.data) {
      for (const inner of seg.data.segments || []) add(inner);
    }
    add(seg);
  }
  return urls.slice(0, max);
}

/**
 * Asks the model, with pictures when there are any and the vision model is configured.
 *
 * The fallback is deliberate and narrow: if the vision request is REFUSED with an
 * error that names 图片 (the host's allow-list, or a gateway that does not take image
 * parts), the same question is retried as text. A group question should not go
 * unanswered because one picture could not be looked at - and the log says which
 * happened.
 */
async function askModel(text, system, history, images) {
  const model = String(state.cfg.visionModel || '').trim();
  const payload = { text, system, history };
  let withImages = false;
  if (images && images.length && model) {
    payload.model = model;
    payload.images = images;
    const extra = String(state.cfg.visionPrompt || '').trim();
    if (extra) payload.system = `${system}\n\n${extra}`;
    withImages = true;
  }
  try {
    return await request('llm.chat', payload);
  } catch (err) {
    const message = String((err && err.message) || err);
    if (withImages && message.includes('图片')) {
      note(`看图没成功，改用文字回答：${message}`);
      return await request('llm.chat', { text, system, history });
    }
    throw err;
  }
}

/** 去掉不可打印字符：QQ 的群名/名片里真的会有 \u0011 这类东西，进提示词只会添乱。 */
function stripControl(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 服务商的内容安全拦截 —— 它不是"模型坏了"，而是这轮请求里有什么被拒了。
 *
 * 真机上撞到的具体形状：群里有人让机器人"把'傻逼'记下来"，这句话与机器人的复述一起进了
 * `history/<群号>`，于是**之后每一条**请求都带着它们，服务商一律回
 * "The request contains sensitive content"，机器人哑了好几分钟，日志里只有"回答失败"。
 */
function isModerationError(message) {
  return /sensitive content|content[_ ]?(policy|moderation)|blocked by|内容安全|敏感内容|risk control|flagged/i
    .test(String(message || ''));
}

/** 刚被拦过就主动缩小上下文（失败的请求也是要计费的，不能每次都先失败一次）。 */
const MODERATION_TTL_MS = 10 * 60 * 1000;

function needsMinimalContext(groupID) {
  const at = state.moderationAt.get(String(groupID)) || 0;
  return at > 0 && Date.now() - at < MODERATION_TTL_MS;
}

function markModeration(groupID) {
  state.moderationAt.set(String(groupID), Date.now());
}

/**
 * 被拦时用的"最小提示词"：人设 + 规则 + 这句提问。
 *
 * 刻意**不带**群记忆、群友卡片、表情候选、系统通知，也基本不带历史：那些正是可能被拦的东西，
 * 而"这一轮先能回上话"比"记得住"重要。
 */
function minimalSystemPrompt(groupID, groupName) {
  const maxChars = number(state.cfg.replyMaxChars, 300, 20, 2000);
  const persona = String(state.cfg.persona || '').trim() || DEFAULT_PERSONA;
  return [
    persona,
    '规则：',
    `- 你在 QQ 群「${stripControl(groupName || groupID)}」里聊天。`,
    `- 一两句就够，${maxChars} 字是硬上限；简体中文口语，不要 Markdown、列表、emoji。`,
    '- 正文直接发进群里；每条回复以唯一一个 ```json 围栏结尾（字段可省略，没要记的就写 {}）。',
    '- 这一轮的上下文被安全策略缩小过，别提问"刚才聊了什么"，只回应下面这句话。',
  ].join('\n');
}

/**
 * 调模型，并在被内容安全拦下时**自己救自己**。
 *
 * 真机上撞到的形状：有人让机器人"把脏话记下来"，那句与它的复述一起进了 `history/<群号>`，
 * 于是之后每条请求都带着它们、一律被拒。用户不该为此去群里敲指令，所以这里的处理是：
 *
 *   · 正常：一次调用；
 *   · 被拦：**阶梯式丢掉旧往来**（一半 → 只留两轮 → 全丢），第一次成功的那一档就写回磁盘，
 *     从此不再带那些话。日志里说明"丢了 N 轮旧往来，已经自己恢复正常"；
 *   · 十分钟内刚被拦过：直接用最小上下文，不先白跑一次失败请求（失败也计费）。
 *
 * 三档都失败（说明连当前这句都过不了）才放弃，并且日志里的建议是**工坊里点「忘掉这个群」**，
 * 不是让人去群里发指令。
 */
async function askWithFallback({ asked, system, history, images, groupID, groupName, chat }) {
  const call = chat || ((text, sys, turns, pics) => askModel(text, sys, turns, pics));
  if (needsMinimalContext(groupID)) {
    return call(asked, minimalSystemPrompt(groupID, groupName), history.slice(-2), images);
  }
  try {
    return await call(asked, system, history, images);
  } catch (err) {
    const message = String((err && err.message) || err);
    if (!isModerationError(message)) throw err;
    markModeration(groupID);
    // 阶梯：一半旧往来 → 只留两轮 → 完全不带。历史本来就空的时候只试最后一档
    // （那时被拦的多半是系统提示本身，缩历史没有意义，但换最小提示词有意义）。
    const rungs = [...new Set([Math.ceil(history.length / 2), 2, 0])]
      .filter((n) => n < history.length || n === 0)
      .sort((a, b) => b - a);
    for (const keep of rungs) {
      const trimmed = keep > 0 ? history.slice(-keep) : [];
      let res = null;
      try {
        res = await call(asked, minimalSystemPrompt(groupID, groupName), trimmed, images);
      } catch (inner) {
        if (!isModerationError((inner && inner.message) || inner)) throw inner;
        continue;
      }
      // 成功这一档就落盘：否则每次都要先失败一遍，还得一直用残缺的上下文。
      if (trimmed.length < history.length) {
        try {
          await request('storage.set', { key: historyKey(groupID), value: JSON.stringify(trimmed) });
        } catch {
          // 写不进去只是下次还要再缩一次，不影响这条回答
        }
      }
      note(`群 ${groupID}：服务商把这次请求判成敏感内容，已缩到 ${trimmed.length} 轮上下文后正常回答（不用你处理）`);
      return res;
    }
    throw new Error('服务商一直判定内容敏感，这条没答上（上下文里有它不接受的词；工坊里点「忘掉这个群」可以立刻清掉）');
  }
}

