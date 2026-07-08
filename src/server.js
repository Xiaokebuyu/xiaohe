/**
 * 小合陪伴服务入口。
 *
 * 独立进程：连飞书 WS → 白名单私聊路由到陪伴 harness（runCompanionMessage）→ 轻量流式卡。
 * 无状态 LLM：每轮现装 system + user turn；对话历史 + 关系上下文落 SQLite（跨天/跨重启，companion/store.js）。
 */
import './config/env.js';

import express from 'express';
import { initFeishu, createAndSendCard } from './feishu/client.js';
import { buildSimpleCard } from './feishu/cards.js';
import { CompanionStreamer } from './feishu/streamer.js';
import { runCompanionMessage } from './agent/index.js';
import { enqueueMessage } from './runtime/concurrency.js';
import { getRecentHistory, appendExchange, renderPersonalContext, renderActiveHooks, getAgentNote, touchPerson, countTurnsSinceContext } from './companion/store.js';
import { startIdleDistill } from './companion/idle-scheduler.js';
import { distillPerson } from './companion/distill.js';
import { startProactive, setProactiveSender } from './companion/proactive-scheduler.js';
import { assertCompanionConfig, isCompanionTarget, nameOf, companionSummary } from './config/companions.js';

// C5 轻量 compact：长会话每 K 轮后台刷新滚动摘要，避免超出窗口的早期对话被硬丢。
const COMPACT_EVERY_TURNS = Number(process.env.XIAOHE_COMPACT_EVERY_TURNS) || 12;

const PORT = Number(process.env.PORT) || 3100;
let feishuReady = false;

async function handleMessage(text, chatId, userId, chatType) {
  const openId = userId;
  if (chatType === 'p2p') console.log(`[Xiaohe] 收到私聊 openId=${openId} 称呼=${nameOf(openId) || '(未设)'}`);

  // 陪伴只走私聊；群里被 @ 温和说明，不进 harness（避免"切版后群里像坏了"）
  if (chatType !== 'p2p') {
    await createAndSendCard(chatId, 'chat_id',
      buildSimpleCard('新版小合只在私聊里陪你说话～群里的事我先不掺和啦。', { level: 'info' })).catch(() => {});
    return;
  }

  if (!isCompanionTarget(openId)) {
    await createAndSendCard(openId, 'open_id',
      buildSimpleCard('嗨～我现在还只陪伴几位固定的朋友。以后有缘再聊。', { level: 'info' })).catch(() => {});
    return;
  }

  const displayName = nameOf(openId);
  touchPerson(openId, displayName);
  const boundUser = displayName ? { username: openId, display_name: displayName, role: 'friend' } : null;

  const { status } = await enqueueMessage(openId, async () => {
    const streamer = new CompanionStreamer(openId, 'open_id');
    const ok = await streamer.start();
    if (!ok) {
      await createAndSendCard(openId, 'open_id',
        buildSimpleCard('飞书卡片服务这会儿有点问题，等下再发一次好吗？', { level: 'error' })).catch(() => {});
      return;
    }
    let replyText = '';
    try {
      // 最近关系状态 + 小合已挂的钩子（让它知道自己记着啥→防重复设 + 可引用/撤销）
      const personalContext = [renderPersonalContext(openId), renderActiveHooks(openId)].filter(Boolean).join('\n\n');
      const result = await runCompanionMessage({
        userText: text,
        history: getRecentHistory(openId),           // 跨天/跨重启的最近对话（SQLite）
        personalContext,
        agentNote: getAgentNote(openId),             // 小合自管的持久便笺（它改写、每轮注入）
        boundUser,
        chatContext: { openId, chatType },
        emit: (event) => streamer.onEvent(event),
      });
      if (result?.uncaughtError) { replyText = ''; }   // 失败轮：不把 ERROR_TEXT 当回复写进历史
      else replyText = result?.text || '';
    } catch (err) {
      console.error('[Xiaohe] 处理错误:', err);
      await streamer.onEvent({ type: 'error', text: '抱歉，我这会儿有点走神，等下再聊好吗？' });
      return;
    }
    // 成功才提交本轮到跨天历史（失败不留孤儿）
    if (replyText) {
      appendExchange(openId, text, replyText);
      // C5：活跃会话攒够 K 轮 → 后台滚动摘要（不阻塞回复），让早期上下文进 recent_summary
      if (countTurnsSinceContext(openId) >= COMPACT_EVERY_TURNS) {
        distillPerson(openId, boundUser).catch(err => console.warn('[Xiaohe] 滚动摘要出错:', err.message));
      }
    }
  });

  if (status === 'backpressure') {
    await createAndSendCard(openId, 'open_id',
      buildSimpleCard('我还在回你上一条，稍等一下～', { level: 'info' })).catch(() => {});
  }
}

async function main() {
  assertCompanionConfig();   // 生产空白名单 → 拒启动
  startIdleDistill();        // C4：静默后把对话蒸馏进长期记忆

  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => {
    res.status(feishuReady ? 200 : 503).json({
      ok: feishuReady, service: 'xiaohe', feishu: feishuReady, ts: Date.now(),
    });
  });
  app.listen(PORT, () => console.log(`[Xiaohe] 内部 HTTP 就绪 :${PORT}`));

  feishuReady = await initFeishu(handleMessage);
  if (!feishuReady) {
    console.error('[Xiaohe] ⚠️ 飞书未就绪（缺凭据或连接失败）。/health 返回 503，请检查 FEISHU_APP_ID/SECRET。');
  } else {
    // C6/C7：主动关心只在飞书就绪后启。发送器无 messageId 就 throw（scheduler 据此 defer 重试，不记假消息）
    setProactiveSender(async (openId, text) => {
      const res = await createAndSendCard(openId, 'open_id', buildSimpleCard(text, { level: 'info', title: '小合' }));
      if (!res?.messageId) throw new Error('飞书主动消息发送失败（无 messageId）');
      return res;
    });
    startProactive();
    console.log(`[Xiaohe] 陪伴服务已就绪，等待私聊。${companionSummary()}`);
  }
}

main().catch(err => { console.error('[Xiaohe] 启动失败:', err.message); process.exit(1); });
