/**
 * 轻量陪伴卡片流式器 —— 把 runner 的 onProgress 事件渲染成一张会打字的暖调飞书卡。
 *
 * 相比旧 ChatCardStreamer 砍掉了：思考胶囊 / 工具面板 / markup 图表块（陪伴用不上）。
 * 只做一件事：把回复文本节流地流进 main_text_0，收尾切完成态。记忆写入是静默的，不上卡。
 *
 * 时序安全：flush 串行化（一条 promise 链，避免并发推导致 sequence 乱序）；收尾前 await 在途 flush，
 * 再关流 + 切完成卡（避免旧内容更新和完成态更新交错）。
 */

import {
  createAndSendCard, streamCardText, updateCardEntity, closeStreamingMode,
} from './client.js';
import { buildCompanionInitial, buildCompanionDone, buildErrorCard } from './cards.js';

const FLUSH_MS = Number(process.env.XIAOHE_STREAM_FLUSH_MS) || 380;

export class CompanionStreamer {
  constructor(receiveId, receiveIdType) {
    this.receiveId = receiveId;
    this.receiveIdType = receiveIdType;
    this.cardId = null;
    this.full = '';
    this.dirty = false;
    this.timer = null;
    this.closed = false;
    this.flushChain = Promise.resolve();   // 串行化所有 streamCardText
  }

  /** 预创建流式卡（拿 cardId）。失败返回 false，调用方应中止本轮。 */
  async start() {
    try {
      const { cardId, messageId } = await createAndSendCard(
        this.receiveId, this.receiveIdType, buildCompanionInitial());
      this.cardId = cardId;
      if (!cardId || !messageId) return false;
      this.timer = setInterval(() => { this._flush(); }, FLUSH_MS);
      return true;
    } catch (err) {
      console.error('[Companion/Streamer] 建卡失败:', err.message);
      return false;
    }
  }

  /** 把当前累积全文排入串行链（不并发调用 streamCardText）。 */
  _flush() {
    if (!this.dirty || !this.cardId) return this.flushChain;
    this.dirty = false;
    const content = this.full;
    this.flushChain = this.flushChain.then(async () => {
      if (this.closed || !this.cardId) return;
      await streamCardText(this.cardId, 'main_text_0', content);
    }).catch(err => console.error('[Companion/Streamer] flush 失败:', err.message));
    return this.flushChain;
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
    this.closed = true;                 // 先封口：链里在途/后续 flush 都 no-op，不和完成卡交错
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const text = (finalText || this.full || '').trim();
    try {
      await this.flushChain;            // 排空在途流式推送
      if (text) await streamCardText(this.cardId, 'main_text_0', text);  // 补齐最终全文
      await closeStreamingMode(this.cardId);
      await updateCardEntity(this.cardId, buildCompanionDone(text));
    } catch (err) {
      console.error('[Companion/Streamer] 收尾失败:', err.message);
    }
  }

  async _error(text) {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try {
      await this.flushChain;
      await updateCardEntity(this.cardId, buildErrorCard(text || '抱歉，我这会儿有点走神，等下再聊好吗？'));
    } catch (err) {
      console.error('[Companion/Streamer] 错误态失败:', err.message);
    }
  }
}
