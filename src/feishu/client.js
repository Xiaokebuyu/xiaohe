/**
 * 飞书 SDK 封装
 * WSClient 长连接接收消息（无需公网 IP）
 * Client API 发送消息 + CardKit v1（卡片实体 + 组件级流式更新）
 */

import * as lark from '@larksuiteoapi/node-sdk';
import crypto from 'crypto';

let client = null;
let botOpenId = null;

// ── CardKit sequence 管理 ──
// 飞书要求每个 card_id 的更新 sequence 严格递增
// Map<cardId, { seq, lastAccess }>，按 lastAccess 时间清理（不按 seq 数值）
const cardSequences = new Map();
const SEQ_IDLE_TTL = 3 * 60 * 60 * 1000;  // 3 小时未访问则清理

function nextSeq(cardId) {
  const entry = cardSequences.get(cardId);
  const cur = (entry?.seq || 0) + 1;
  cardSequences.set(cardId, { seq: cur, lastAccess: Date.now() });
  return cur;
}

// ── 模块级 per-card 写操作队列 ──
// 飞书要求同一 card_id 的更新 sequence 严格递增且串行。CompanionStreamer 内部已有 chain 串行，但那只保护它自己；
// 任何调用方（现在/未来）并发调 streamCardText/patch/update 同一张卡都会乱序。这里在 client 层兜底：
// 同一 cardId 的所有 mutation 串行执行，且 nextSeq() 在队列任务**内部**取——保证序号按真实发送顺序分配。
const cardOpQueues = new Map();   // cardId -> tail Promise（已吞异常，仅用于排队）
export function enqueueCardOp(cardId, fn) {
  const prev = cardOpQueues.get(cardId) || Promise.resolve();
  const result = prev.then(fn, fn);          // 不管上一个成败都接着跑本任务；result 是本任务真实返回
  const tail = result.then(() => {}, () => {}); // 吞掉成败，只作排队锚点，避免一个失败拖垮后续
  cardOpQueues.set(cardId, tail);
  tail.finally(() => { if (cardOpQueues.get(cardId) === tail) cardOpQueues.delete(cardId); });
  return result;
}

function uuid() {
  return crypto.randomUUID();
}

// 飞书 element_id 硬约束：字母开头、只含字母数字下划线、≤20 字符。违反 → 300315/300301。
// 内部生成的 id 现已合规，这里做提前拦截：坏 id 在送飞书前就 return false + 报清楚是哪个，别等飞书拒了才发现元素不显示。
const ELEMENT_ID_RE = /^[A-Za-z][A-Za-z0-9_]{0,19}$/;
export function validElementId(id) { return typeof id === 'string' && ELEMENT_ID_RE.test(id); }
/** 递归收集 elements 数组里所有非法 element_id（含 collapsible_panel.elements 嵌套）。 */
function collectBadIds(elements, bad = []) {
  for (const el of Array.isArray(elements) ? elements : []) {
    if (el?.element_id && !validElementId(el.element_id)) bad.push(el.element_id);
    if (Array.isArray(el?.elements)) collectBadIds(el.elements, bad);
  }
  return bad;
}

// 定时按 idle 时间清理（一次性卡片 seq 永远是 1，按数值清理永远不会触发）
const seqCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [cid, entry] of cardSequences.entries()) {
    if (now - entry.lastAccess > SEQ_IDLE_TTL) cardSequences.delete(cid);
  }
}, 30 * 60 * 1000);  // 每 30 分钟扫一次
seqCleanupTimer.unref?.();

// 消息去重（message_id / event_id 级别，防飞书事件重发）
// per-user 串行化由 concurrency.js 的 mutex 负责
const recentMessageIds = new Set();
const MESSAGE_DEDUP_TTL = 60000;

/**
 * 初始化飞书客户端并启动消息监听
 * @param {Function} onMessage - 回调: (text, chatId, userId, chatType) => Promise<void>
 */
export async function initFeishu(onMessage, handlers = {}) {
  const { onMeetingEnded } = handlers || {};
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;

  if (!appId || !appSecret) {
    console.warn('[Bot/Feishu] FEISHU_APP_ID 或 FEISHU_APP_SECRET 未配置，跳过飞书初始化');
    return false;
  }

  // API Client（发送消息用）
  client = new lark.Client({
    appId,
    appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Feishu,
  });

  // 获取机器人自身信息（用于判断群聊中是否被 @）
  try {
    const res = await client.request({
      method: 'GET',
      url: 'https://open.feishu.cn/open-apis/bot/v3/info',
    });
    botOpenId = res?.data?.bot?.open_id || res?.bot?.open_id || null;
    if (botOpenId) {
      console.log(`[Bot/Feishu] 机器人 open_id: ${botOpenId}`);
    } else {
      console.warn('[Bot/Feishu] 获取 bot open_id 为空，群聊 @判断可能不准');
    }
  } catch (err) {
    console.warn('[Bot/Feishu] 获取机器人信息失败:', err.message, '（不影响私聊功能）');
  }

  // 事件处理器（纯陪伴：只收私聊/群消息，不收会议/妙记事件）
  const eventDispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      try {
        await handleMessageEvent(data, onMessage);
      } catch (err) {
        console.error('[Bot/Feishu] 消息处理错误:', err);
      }
    },
  });

  // WSClient 长连接（无需公网 IP）
  const wsClient = new lark.WSClient({
    appId,
    appSecret,
    loggerLevel: lark.LoggerLevel.info,
  });

  await wsClient.start({ eventDispatcher });
  console.log('[Bot/Feishu] WSClient 长连接已建立');
  return true;
}

/**
 * 处理收到的消息事件
 */
async function handleMessageEvent(data, onMessage) {
  const message = data?.message;
  if (!message) return;

  // 调试：打印消息标识，排查重复问题
  const msgId = message.message_id;
  const eventId = data?.header?.event_id;
  console.log(`[Bot/Dedup] 收到消息 msgId=${msgId} eventId=${eventId} text=${message.content?.slice(0, 50)}`);

  // 消息去重：优先用 message_id，备用 event_id
  const dedupKey = msgId || eventId;
  if (dedupKey && recentMessageIds.has(dedupKey)) {
    console.log(`[Bot/Dedup] 跳过重复 key=${dedupKey}`);
    return;
  }
  if (dedupKey) {
    recentMessageIds.add(dedupKey);
    setTimeout(() => recentMessageIds.delete(dedupKey), MESSAGE_DEDUP_TTL);
  }

  // 只处理文本消息
  const msgType = message.message_type;
  if (msgType !== 'text') return;

  const chatType = message.chat_type;   // 'p2p' | 'group'
  const chatId = message.chat_id;
  const userId = data.sender?.sender_id?.open_id;

  // 解析文本内容
  let content;
  try {
    content = JSON.parse(message.content);
  } catch {
    return;
  }
  let text = content?.text || '';

  // 群聊：必须 @机器人才响应
  if (chatType === 'group') {
    const mentions = message.mentions || [];
    const mentionedBot = mentions.some(m => m.id?.open_id === botOpenId);
    if (!mentionedBot) return;

    // 去掉 @mention 标记
    for (const m of mentions) {
      text = text.replace(m.key || '', '').trim();
    }
  }

  text = text.trim();
  if (!text) return;

  await onMessage(text, chatId, userId, chatType);
}

/**
 * 发送文本消息
 */
export async function sendText(receiveId, receiveIdType, text) {
  if (!client) return;
  try {
    await client.im.v1.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
  } catch (err) {
    console.error('[Bot/Feishu] 发送文本失败:', err.message);
  }
}

/**
 * 上传文件到飞书 CDN，返回 file_key
 *
 * 注意：im.v1.file.create 同 CardKit 一样是 lark SDK 调用，SDK 不抛业务错误，
 * 必须用 ensureOk() 校验 code。
 *
 * @param {Buffer} buffer - 文件字节
 * @param {string} filename - 原文件名（含扩展名，如 "report.pdf"）
 * @param {string} fileType - pdf / doc / xls / ppt / opus / mp4 / stream 之一
 * @returns {Promise<string>} file_key（用于 send_file_message 的 content.file_key）
 */
export async function uploadFileToFeishu(buffer, filename, fileType = 'stream') {
  if (!client) throw new Error('飞书 client 未初始化');
  if (!Buffer.isBuffer(buffer)) throw new Error('uploadFileToFeishu: 参数必须是 Buffer');
  if (buffer.length === 0) throw new Error('文件内容为空');

  const res = await client.im.v1.file.create({
    data: {
      file_type: fileType,
      file_name: filename,
      file: buffer,
    },
  });
  ensureOk('im.v1.file.create', res);
  const fileKey = res?.data?.file_key;
  if (!fileKey) throw new Error('im.v1.file.create 未返回 file_key');
  return fileKey;
}

/**
 * 发送文件消息给目标（通过 file_key 引用已上传的文件）
 *
 * 注意：file_key 的 TTL 飞书未公开文档，为稳妥起见调用方应每次发送前重新 uploadFileToFeishu，
 * 不缓存 file_key 跨消息复用。
 *
 * @param {string} receiveId
 * @param {'open_id'|'chat_id'|'user_id'|'union_id'} receiveIdType
 * @param {string} fileKey
 */
export async function sendFileMessage(receiveId, receiveIdType, fileKey) {
  if (!client) throw new Error('飞书 client 未初始化');
  const res = await client.im.v1.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      msg_type: 'file',
      content: JSON.stringify({ file_key: fileKey }),
    },
  });
  ensureOk('sendFileMessage', res);
  return res?.data?.message_id || null;
}

// ============================================================
//  CardKit v1（卡片实体 + 组件级流式更新）
//
//  关键概念：
//  - 卡片实体（card_id）独立于消息存在，14 天有效
//  - streaming_mode 下文本更新走打字机效果，不计 QPS 上限
//  - 所有更新需带 sequence（严格递增）和 uuid（幂等）
//
//  ⚠️ lark SDK 的 response interceptor 仅返回 resp.data，不检查 code !== 0。
//     调用 API 失败（业务错误码）时不抛异常，必须手动校验 code。
//     用 ensureOk() 统一处理。
// ============================================================

/**
 * 校验飞书 API 响应：code === 0 为成功，否则抛异常带详细信息
 * lark SDK 不会自动抛 code !== 0 的业务错误
 */
function ensureOk(label, res) {
  if (res && res.code !== undefined && res.code !== 0) {
    const err = new Error(`${label}: code=${res.code} msg=${res.msg || 'unknown'}`);
    err.feishuCode = res.code;
    err.feishuMsg = res.msg;
    err.feishuData = res.data;
    throw err;
  }
  return res;
}

/**
 * 创建卡片实体
 * @param {object} cardJson - 完整 card JSON 2.0 结构
 * @returns {Promise<string|null>} card_id
 */
export async function createCardEntity(cardJson) {
  if (!client) return null;
  const badIds = collectBadIds(cardJson?.body?.elements);
  if (badIds.length) console.warn(`[Bot/Feishu] ⚠️ 建卡含非法 element_id（飞书会拒整卡）: ${JSON.stringify(badIds)}`);
  try {
    const res = await client.cardkit.v1.card.create({
      data: {
        type: 'card_json',
        data: JSON.stringify(cardJson),
      },
    });
    ensureOk('createCardEntity', res);
    const cardId = res?.data?.card_id || null;
    if (!cardId) {
      console.error('[Bot/Feishu] 创建卡片实体失败：返回 card_id 为空', JSON.stringify(res));
    }
    return cardId;
  } catch (err) {
    console.error('[Bot/Feishu] 创建卡片实体失败:', err.message);
    return null;
  }
}

/**
 * 发送消息引用已创建的卡片实体
 * @param {string} receiveId - chat_id 或 open_id
 * @param {string} receiveIdType - 'chat_id' | 'open_id'
 * @param {string} cardId
 * @returns {Promise<string|null>} message_id
 */
export async function sendCardById(receiveId, receiveIdType, cardId) {
  if (!client || !cardId) return null;
  try {
    const res = await client.im.v1.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: 'interactive',
        content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
      },
    });
    ensureOk('sendCardById', res);
    return res?.data?.message_id || null;
  } catch (err) {
    console.error('[Bot/Feishu] 发送卡片实体失败:', err.message);
    return null;
  }
}

/**
 * 一站式：创建卡片实体并发送消息
 * @returns {Promise<{ cardId: string|null, messageId: string|null }>}
 */
export async function createAndSendCard(receiveId, receiveIdType, cardJson) {
  const cardId = await createCardEntity(cardJson);
  if (!cardId) return { cardId: null, messageId: null };
  const messageId = await sendCardById(receiveId, receiveIdType, cardId);
  return { cardId, messageId };
}

/**
 * 流式更新文本组件内容（打字机效果）
 * 适用 plain_text 和 markdown 组件。需 streaming_mode 开启才能拿到打字机效果。
 * 平台自动算 diff：新文本若是旧文本前缀超集，逐字渲染；否则瞬时替换。
 * @param {string} cardId
 * @param {string} elementId
 * @param {string} content - 全量文本
 */
export async function streamCardText(cardId, elementId, content) {
  if (!client || !cardId || !elementId) return false;
  if (!validElementId(elementId)) { console.error(`[Bot/Feishu] streamCardText: 非法 element_id "${elementId}"（≤20/字母开头/字母数字下划线）`); return false; }
  // 空内容飞书会返 code=99992402 field validation failed。典型场景：LLM 首 chunk 就是
  // [[chart:...]] 使初始 main_text_0 永远空；或 fenced 闭合后紧接 EOF。跳过即可，
  // 对打字机效果无影响（下次有内容再推就是从空开始的前缀超集）。
  if (!content || !String(content).length) return true;
  return enqueueCardOp(cardId, async () => {
    try {
      const res = await client.cardkit.v1.cardElement.content({
        path: { card_id: cardId, element_id: elementId },
        data: { uuid: uuid(), content, sequence: nextSeq(cardId) },
      });
      ensureOk(`streamCardText(${elementId})`, res);
      return true;
    } catch (err) {
      console.error(`[Bot/Feishu] 流式推文本失败 (${elementId}):`, err.message);
      return false;
    }
  });
}

/**
 * 在指定组件前/后插入新组件
 * @param {string} cardId
 * @param {object[]} elements - 组件 JSON 数组
 * @param {object} opts
 * @param {'insert_before'|'insert_after'|'append'} opts.type
 * @param {string} [opts.targetElementId] - type 不为 append 时必填
 */
export async function insertCardElements(cardId, elements, { type = 'append', targetElementId } = {}) {
  if (!client || !cardId) return false;
  if (type !== 'append' && !targetElementId) {
    console.error(`[Bot/Feishu] 插入组件失败 (${type})：缺少 targetElementId`);
    return false;
  }
  if (type !== 'append' && !validElementId(targetElementId)) {
    console.error(`[Bot/Feishu] 插入组件失败 (${type})：非法 targetElementId "${targetElementId}"`); return false;
  }
  const badIds = collectBadIds(elements);
  if (badIds.length) { console.error(`[Bot/Feishu] 插入组件失败：非法 element_id ${JSON.stringify(badIds)}`); return false; }
  return enqueueCardOp(cardId, async () => {
    try {
      const data = { uuid: uuid(), type, sequence: nextSeq(cardId), elements: JSON.stringify(elements) };
      if (type !== 'append') data.target_element_id = targetElementId;   // append 不带 target，请求更干净
      const res = await client.cardkit.v1.cardElement.create({ path: { card_id: cardId }, data });
      ensureOk(`insertCardElements(${type}@${targetElementId || 'append'})`, res);
      return true;
    } catch (err) {
      console.error(`[Bot/Feishu] 插入组件失败 (${type}@${targetElementId || 'append'}):`, err.message);
      if (err.feishuData) console.error('  详情:', JSON.stringify(err.feishuData).slice(0, 300));
      return false;
    }
  });
}

/**
 * 局部更新组件配置（partial merge）
 * 例如收起折叠面板：patchCardElement(cardId, 'thinking_panel', { expanded: false })
 */
export async function patchCardElement(cardId, elementId, partial) {
  if (!client || !cardId || !elementId) return false;
  if (!validElementId(elementId)) { console.error(`[Bot/Feishu] patch: 非法 element_id "${elementId}"`); return false; }
  return enqueueCardOp(cardId, async () => {
    try {
      const res = await client.cardkit.v1.cardElement.patch({
        path: { card_id: cardId, element_id: elementId },
        data: { uuid: uuid(), sequence: nextSeq(cardId), partial_element: JSON.stringify(partial) },
      });
      ensureOk(`patchCardElement(${elementId})`, res);
      return true;
    } catch (err) {
      console.error(`[Bot/Feishu] patch 组件失败 (${elementId}):`, err.message);
      return false;
    }
  });
}

/**
 * 全量更新组件
 */
export async function updateCardElement(cardId, elementId, element) {
  if (!client || !cardId || !elementId) return false;
  if (!validElementId(elementId)) { console.error(`[Bot/Feishu] update 元素: 非法 element_id "${elementId}"`); return false; }
  return enqueueCardOp(cardId, async () => {
    try {
      const res = await client.cardkit.v1.cardElement.update({
        path: { card_id: cardId, element_id: elementId },
        data: { uuid: uuid(), sequence: nextSeq(cardId), element: JSON.stringify(element) },
      });
      ensureOk(`updateCardElement(${elementId})`, res);
      return true;
    } catch (err) {
      console.error(`[Bot/Feishu] 全量更新组件失败 (${elementId}):`, err.message);
      return false;
    }
  });
}

/**
 * 删除组件
 */
export async function deleteCardElement(cardId, elementId) {
  if (!client || !cardId || !elementId) return false;
  if (!validElementId(elementId)) { console.error(`[Bot/Feishu] delete 元素: 非法 element_id "${elementId}"`); return false; }
  return enqueueCardOp(cardId, async () => {
    try {
      const res = await client.cardkit.v1.cardElement.delete({
        path: { card_id: cardId, element_id: elementId },
        data: { uuid: uuid(), sequence: nextSeq(cardId) },
      });
      ensureOk(`deleteCardElement(${elementId})`, res);
      return true;
    } catch (err) {
      console.error(`[Bot/Feishu] 删除组件失败 (${elementId}):`, err.message);
      return false;
    }
  });
}

/**
 * 全量更新卡片
 */
export async function updateCardEntity(cardId, cardJson) {
  if (!client || !cardId) return false;
  const badIds = collectBadIds(cardJson?.body?.elements);
  if (badIds.length) console.warn(`[Bot/Feishu] ⚠️ 整卡更新含非法 element_id（飞书会拒整卡）: ${JSON.stringify(badIds)}`);
  return enqueueCardOp(cardId, async () => {
    try {
      const res = await client.cardkit.v1.card.update({
        path: { card_id: cardId },
        data: { uuid: uuid(), sequence: nextSeq(cardId), card: { type: 'card_json', data: JSON.stringify(cardJson) } },
      });
      ensureOk('updateCardEntity', res);
      return true;
    } catch (err) {
      console.error('[Bot/Feishu] 全量更新卡片失败:', err.message);
      return false;
    }
  });
}

/**
 * 更新卡片配置（如开/关 streaming_mode）
 * @param {string} cardId
 * @param {object} settings - 形如 { config: { streaming_mode: false } }
 */
export async function updateCardSettings(cardId, settings) {
  if (!client || !cardId) return false;
  return enqueueCardOp(cardId, async () => {
    try {
      const res = await client.cardkit.v1.card.settings({
        path: { card_id: cardId },
        data: { uuid: uuid(), sequence: nextSeq(cardId), settings: JSON.stringify(settings) },
      });
      ensureOk('updateCardSettings', res);
      return true;
    } catch (err) {
      console.error('[Bot/Feishu] 更新卡片配置失败:', err.message);
      return false;
    }
  });
}

/**
 * 关闭流式模式（卡片可转发、可交互、摘要从"生成中..."切回）
 */
export async function closeStreamingMode(cardId) {
  return updateCardSettings(cardId, { config: { streaming_mode: false } });
}
