/**
 * 小合陪伴服务入口。
 *
 * 独立进程：连飞书 WS → 白名单私聊路由到陪伴 harness（runCompanionMessage）→ 轻量流式卡。
 * 无状态：状态全在每次现装的 system + 现渲染的 user turn（记忆从 durable store 重组）。
 *
 * MVP 范围（对应 PLAN C1）：反应式陪伴 + 记忆注入 + remember 工具。
 * 待接：C2 白名单落 DB / C3 专属上下文 SQLite / C4 distill / C5 compact / C6-7 主动关心。
 */
import './config/env.js';

import express from 'express';
import { initFeishu, createAndSendCard } from './feishu/client.js';
import { buildSimpleCard } from './feishu/cards.js';
import { CompanionStreamer } from './feishu/streamer.js';
import { runCompanionMessage } from './agent/index.js';
import { enqueueMessage } from './runtime/concurrency.js';

const PORT = Number(process.env.PORT) || 3100;

// 白名单：设了就限定这些 openId；空则放行所有私聊（dev 便利，生产请设）。
const ALLOW = new Set(
  (process.env.XIAOHE_COMPANION_ALLOW_OPENIDS || '').split(',').map(s => s.trim()).filter(Boolean),
);
function isCompanionTarget(openId) {
  return ALLOW.size === 0 ? true : ALLOW.has(openId);
}

async function handleMessage(text, chatId, userId, chatType) {
  // 陪伴只走私聊
  if (chatType !== 'p2p') return;
  const openId = userId;

  if (!isCompanionTarget(openId)) {
    // 非陪伴对象：温和一句，不进 harness
    await createAndSendCard(openId, 'open_id',
      buildSimpleCard('嗨～我现在还只陪伴几位固定的朋友。以后有缘再聊。', { level: 'info' })).catch(() => {});
    return;
  }

  const { status } = await enqueueMessage(openId, async () => {
    const streamer = new CompanionStreamer(openId, 'open_id', { scene: 'default' });
    const ok = await streamer.start();
    if (!ok) {
      await createAndSendCard(openId, 'open_id',
        buildSimpleCard('飞书卡片服务这会儿有点问题，等下再发一次好吗？', { level: 'error' })).catch(() => {});
      return;
    }
    try {
      await runCompanionMessage({
        userText: text,
        history: [],                 // C3 接专属上下文前先无历史（无状态单轮）
        boundUser: null,             // 纯陪伴暂无 panel 账号；C2 接白名单身份映射
        chatContext: { openId, chatType },
        emit: (event) => streamer.onEvent(event),
      });
    } catch (err) {
      console.error('[Xiaohe] 处理错误:', err);
      await streamer.onEvent({ type: 'error', text: '抱歉，我这会儿有点走神，等下再聊好吗？' });
    }
  });

  if (status === 'backpressure') {
    await createAndSendCard(openId, 'open_id',
      buildSimpleCard('我还在回你上一条，稍等一下～', { level: 'info' })).catch(() => {});
  }
}

async function main() {
  // 内部 HTTP：健康检查（未来 panel 反向调 /internal/tasks 也挂这里）
  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => res.json({ ok: true, service: 'xiaohe', ts: Date.now() }));
  app.listen(PORT, () => console.log(`[Xiaohe] 内部 HTTP 就绪 :${PORT}`));

  const ready = await initFeishu(handleMessage);
  if (!ready) {
    console.error('[Xiaohe] 飞书未初始化（缺 FEISHU_APP_ID/SECRET），只有健康端点在跑。');
  } else {
    console.log('[Xiaohe] 陪伴服务已就绪，等待私聊。白名单：' + (ALLOW.size ? [...ALLOW].join(',') : '（空=放行所有私聊）'));
  }
}

main().catch(err => { console.error('[Xiaohe] 启动失败:', err); process.exit(1); });
