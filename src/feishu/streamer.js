/**
 * 轻量陪伴卡片流式器 —— 把 runner 的 onProgress 事件渲染成一张会打字的飞书卡。
 *
 * 相比旧 ChatCardStreamer 砍掉了：思考胶囊 / 工具面板 / markup 图表块（陪伴用不上）。
 * 只做一件事：把回复文本节流地流进 main_text_0，收尾切完成态。记忆写入是静默的，不在卡上展示。
 */

import {
  createAndSendCard, streamCardText, updateCardEntity, closeStreamingMode,
} from './client.js';
import { buildChatCardInitial, buildCompletionCard, buildErrorCard } from './cards.js';

const FLUSH_MS = Number(process.env.XIAOHE_STREAM_FLUSH_MS) || 380;

export class CompanionStreamer {
  constructor(receiveId, receiveIdType, { scene = 'default' } = {}) {
    this.receiveId = receiveId;
    this.receiveIdType = receiveIdType;
    this.scene = scene;
    this.cardId = null;
    this.full = '';
    this.dirty = false;
    this.timer = null;
    this.startMs = Date.now();
    this.closed = false;
  }

  /** 预创建流式卡（拿 cardId）。失败返回 false，调用方应中止本轮。 */
  async start() {
    try {
      const { cardId, messageId } = await createAndSendCard(
        this.receiveId, this.receiveIdType, buildChatCardInitial(this.scene));
      this.cardId = cardId;
      if (!cardId || !messageId) return false;
      this.timer = setInterval(() => this._flush(), FLUSH_MS);
      return true;
    } catch (err) {
      console.error('[Companion/Streamer] 建卡失败:', err.message);
      return false;
    }
  }

  async _flush() {
    if (!this.dirty || !this.cardId || this.closed) return;
    this.dirty = false;
    await streamCardText(this.cardId, 'main_text_0', this.full);
  }

  /** runner 的 onProgress 事件入口。 */
  async onEvent(event) {
    try {
      switch (event.type) {
        case 'text_chunk':
          if (event.delta) { this.full += event.delta; this.dirty = true; }
          break;
        case 'complete':
        case 'direct_reply':
          await this._finish(event.text);
          break;
        case 'error':
          await this._error(event.text);
          break;
        // thinking_chunk / tool_start / tool_done：陪伴不展示，忽略
      }
    } catch (err) {
      console.error(`[Companion/Streamer] onEvent(${event.type}) 错误:`, err.message);
    }
  }

  async _finish(finalText) {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    const text = (finalText || this.full || '').trim();
    // 收尾：先把全文推满，再切完成态（关流式）
    try {
      if (text) await streamCardText(this.cardId, 'main_text_0', text);
      await closeStreamingMode(this.cardId);
      const durationMs = Date.now() - this.startMs;
      await updateCardEntity(this.cardId, buildCompletionCard(this.scene, durationMs, text));
    } catch (err) {
      console.error('[Companion/Streamer] 收尾失败:', err.message);
    }
  }

  async _error(text) {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    try {
      await updateCardEntity(this.cardId, buildErrorCard(text || '抱歉，我这会儿有点走神，等下再聊好吗？'));
    } catch (err) {
      console.error('[Companion/Streamer] 错误态失败:', err.message);
    }
  }
}
