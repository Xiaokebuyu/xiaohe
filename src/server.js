/**
 * 小合陪伴服务入口。
 *
 * 独立进程：连飞书 WS → 白名单私聊路由到陪伴 harness（runCompanionMessage）→ 轻量流式卡。
 * 无状态 LLM：每轮现装 system + user turn；短期连续对话历史在本进程内存（session.js），
 * 跨天专属上下文（C3）后续接 SQLite。
 */
import './config/env.js';

import express from 'express';
import { initFeishu, createAndSendCard } from './feishu/client.js';
import { buildSimpleCard } from './feishu/cards.js';
import { CompanionStreamer } from './feishu/streamer.js';
import { runCompanionMessage } from './agent/index.js';
import { enqueueMessage } from './runtime/concurrency.js';
import { getHistory, appendTurn, startSessionCleanup } from './runtime/session.js';
import { assertCompanionConfig, isCompanionTarget, nameOf, companionSummary } from './config/companions.js';

const PORT = Number(process.env.PORT) || 3100;
let feishuReady = false;

async function handleMessage(text, chatId, userId, chatType) {
  const openId = userId;

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
      const result = await runCompanionMessage({
        userText: text,
        history: getHistory(openId),                 // 短期连续对话历史（干净原文）
        boundUser,
        chatContext: { openId, chatType },
        emit: (event) => streamer.onEvent(event),
      });
      replyText = result?.text || '';
    } catch (err) {
      console.error('[Xiaohe] 处理错误:', err);
      await streamer.onEvent({ type: 'error', text: '抱歉，我这会儿有点走神，等下再聊好吗？' });
      return;
    }
    // 成功才提交本轮到历史（失败不留孤儿）
    if (replyText) appendTurn(openId, text, replyText);
  });

  if (status === 'backpressure') {
    await createAndSendCard(openId, 'open_id',
      buildSimpleCard('我还在回你上一条，稍等一下～', { level: 'info' })).catch(() => {});
  }
}

async function main() {
  assertCompanionConfig();   // 生产空白名单 → 拒启动
  startSessionCleanup();

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
    console.log(`[Xiaohe] 陪伴服务已就绪，等待私聊。${companionSummary()}`);
  }
}

main().catch(err => { console.error('[Xiaohe] 启动失败:', err.message); process.exit(1); });
