/**
 * 小合陪伴服务入口。
 *
 * 独立进程：连飞书 WS → 白名单私聊路由到陪伴 harness（runCompanionMessage）→ 轻量流式卡。
 * 无状态 LLM：每轮现装 system + user turn；对话历史 + 关系上下文落 SQLite（跨天/跨重启，companion/store.js）。
 */
import './config/env.js';

import express from 'express';
import { initFeishu, createAndSendCard } from './feishu/client.js';
import { buildSimpleCard, buildCorrectionCard } from './feishu/cards.js';
import { CompanionStreamer } from './feishu/streamer.js';
import { runCompanionMessage } from './agent/index.js';
import { enqueueMessage } from './runtime/concurrency.js';
import { getUncompactedHistory, appendExchange, renderPersonalContext, renderActiveHooks, getAgentNote, touchPerson } from './companion/store.js';
import { renderMemoryIndex } from './companion/memory-store.js';
import { startDailyCompact } from './companion/daily-scheduler.js';
import { dailyCompact } from './companion/daily-compact.js';
import { estimateMessagesTokens, estimateTokens } from './util/tokens.js';
import { startProactive, setProactiveSender } from './companion/proactive-scheduler.js';
import { assertCompanionConfig, isCompanionTarget, nameOf, companionSummary } from './config/companions.js';

// 930k 兜底：单轮组装的 context 估算超此值 → 先压当天再继续（1M 窗口的安全垫）。
const COMPACT_THRESHOLD_TOKENS = Number(process.env.XIAOHE_COMPACT_THRESHOLD_TOKENS) || 930_000;
const OUTPUT_RESERVE_TOKENS = 6000;   // 人设 + 回复输出的粗留量

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
    let thinkingText = '';
    try {
      // 关系状态与已挂钩子分别渲染 → 进 <relationship> / <reminders> 两个标签（钩子含 hk_ 编号，契约里已禁止念出来）
      const renderRelationship = () => renderPersonalContext(openId);
      const renderReminders = () => renderActiveHooks(openId);
      let personalContext = renderRelationship();
      let activeHooks = renderReminders();
      const agentNote = getAgentNote(openId);

      // 930k 兜底：当天原文 + 各注入块（含这条刚说的话）估算超阈值 → 先同步压一次当天（推进 boundary、裁历史）
      let history = getUncompactedHistory(openId);
      const estimateOverhead = () => estimateTokens(personalContext + activeHooks + agentNote + renderMemoryIndex(openId) + text) + OUTPUT_RESERVE_TOKENS;
      if (estimateMessagesTokens(history) + estimateOverhead() > COMPACT_THRESHOLD_TOKENS) {
        console.log(`[Xiaohe] 上下文近 930k，提前 compact ${openId.slice(0, 8)}`);
        // 只压 2 小时前的：保住进行中的对话原文，别把聊到情绪深处的当下也压成两句小结（情绪悬崖）
        const emergencyBeforeIso = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
        const compactOk = await dailyCompact(openId, boundUser, { beforeIso: emergencyBeforeIso }).catch(err => {
          console.warn('[Xiaohe] 提前 compact 出错:', err.message);
          return false;
        });
        history = getUncompactedHistory(openId);
        if (compactOk) { personalContext = renderRelationship(); activeHooks = renderReminders(); }   // 重取新小结，别用陈旧的
        if (estimateMessagesTokens(history) + estimateOverhead() > COMPACT_THRESHOLD_TOKENS) {
          // compact 失败或压完仍超阈值：别让这条消息带着爆窗风险的历史去闯主模型，先安抚等下一条
          await streamer.onEvent({ type: 'error', text: '我这边攒的东西有点多，正在整理，稍等一下再发我这条好吗？' });
          return;
        }
      }

      const result = await runCompanionMessage({
        userText: text,
        history,                                     // 当天原文（1M 装得下；boundary 前由 recent_summary 承接）
        personalContext,
        activeHooks,
        agentNote,                                   // 小合自管的持久便笺（它改写、每轮注入）
        boundUser,
        chatContext: { openId, chatType },
        emit: (event) => streamer.onEvent(event),
      });
      replyText = result?.uncaughtError ? '' : (result?.text || '');   // 失败轮不写历史
      thinkingText = result?.thinkingText || '';                       // 当轮思考，随成功轮落库喂夜间 compact

      // 动作核查补正（enforce 模式命中才有）：发独立后续卡 + 把补正并进落库文本（历史反映用户看到的诚实最终态）
      const corr = result?.correction;
      if (corr?.text && replyText) {
        await createAndSendCard(openId, 'open_id', buildCorrectionCard(corr))
          .catch(err => console.warn('[Xiaohe] 补正卡发送失败:', err.message));
        replyText = `${replyText}\n\n${corr.text}`;
        thinkingText = [thinkingText, corr.thinkingText].filter(Boolean).join('\n');
      }
    } catch (err) {
      console.error('[Xiaohe] 处理错误:', err);
      await streamer.onEvent({ type: 'error', text: '抱歉，我这会儿有点走神，等下再聊好吗？' });
      return;
    }
    if (replyText) appendExchange(openId, text, replyText, thinkingText);   // 成功才落跨天历史（失败不留孤儿）
  });

  if (status === 'backpressure') {
    await createAndSendCard(openId, 'open_id',
      buildSimpleCard('我还在回你上一条，稍等一下～', { level: 'info' })).catch(() => {});
  }
}

async function main() {
  assertCompanionConfig();   // 生产空白名单 → 拒启动
  startDailyCompact();       // 每天凌晨 4 点压当天对话进记忆 + 裁历史（930k 兜底在消息路径里）

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
