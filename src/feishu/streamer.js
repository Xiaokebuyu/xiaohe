/**
 * 轻量陪伴卡片流式器 —— 把 runner 的 onProgress 事件渲染成一张会打字的暖调飞书卡。
 *
 * 相比旧 ChatCardStreamer 砍掉了：工作 markup / 场景 header / 绿勾完成态 / 摘要模型（陪伴用不上）。
 * 保留 + 修复的核心：**每轮独立文本段 + per-round 思考胶囊**。
 *
 * ⚠️ 交错模式（M3 interleaved：think→reply→think→reply）的关键：正文不能全塞进单个 main_text_0，
 * 否则每轮胶囊 insert_before 同一个 main_text_0 会把第二轮胶囊顶到第一轮回复上方（折叠 bug）。
 * 这里维护 `_segments`/`_bodyElements`：每轮一个 main_text_N，round N 的胶囊插在它自己那段之前，
 * 顺序天然是 [pill_r0][reply_r0][pill_r1][reply_r1]…；tool_done 后预开下一段；收尾用 _bodyElements
 * 整卡重建（不用 finalText 覆盖全卡，避免丢掉前几轮已流出的回复）。
 *
 * 时序：所有写卡（建段/推文本/插胶囊/收起/收尾）走同一条串行链 this.chain（飞书 CardKit 要求同 card_id
 * 的 sequence 严格递增）。收尾用 closing→closed 两段封口：closing 时排空在途写卡都还能执行，全部落完再 closed。
 */

import {
  createAndSendCard, streamCardText, updateCardEntity, closeStreamingMode,
  insertCardElements, patchCardElement,
} from './client.js';
import {
  buildCompanionInitial, buildCompanionDoneFromElements, buildErrorCard,
  buildCompanionThinkingPill, buildCompanionPillCollapse, buildCompanionTextElement,
  buildCompanionActionChip, isChipTool,
} from './cards.js';

const FLUSH_MS = Number(process.env.XIAOHE_STREAM_FLUSH_MS) || 380;
const MAX_CARD_MD_CHARS = Number(process.env.XIAOHE_MAX_CARD_MD_CHARS) || 28_000;   // 飞书单 markdown 元素硬上限 30000，留安全垫

// 模型正文/思考进飞书 markdown：转义 <> 防被当标签吞掉/注入坏标签；限长防撞单元素上限（整卡 update 会因超限整张失败）。
// 只转 <>（不转 & 防重复编码、不转 * _ ` [ ] 以保留正常 markdown）。chip 的 <font> 是代码生成的、不走这里。
function toCardMarkdown(raw) {
  let s = String(raw ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (s.length > MAX_CARD_MD_CHARS) s = s.slice(0, MAX_CARD_MD_CHARS - 1) + '…';
  return s;
}

export class CompanionStreamer {
  constructor(receiveId, receiveIdType) {
    this.receiveId = receiveId;
    this.receiveIdType = receiveIdType;
    this.cardId = null;
    this.messageId = null;
    this.timer = null;
    this.closed = false;
    this.closing = false;
    this.chain = Promise.resolve();

    this._segments = [{ id: 'main_text_0', round: 0, text: '' }];
    this._bodyElements = [buildCompanionTextElement('main_text_0')];
    this._roundSegments = new Map([[0, 'main_text_0']]);
    this._currentSegmentId = 'main_text_0';
    this._dirtySegments = new Set();

    this.pills = new Map();
    this._activePillRound = null;
    this._maxRoundSeen = 0;
    this._failedElementIds = new Set();
    this._chartedSteps = new Set();   // 已上过卡的 tool blockId（tool_done 携带累积 steps，去重）
    this._chipSeq = 0;                // chip element_id 计数器（飞书 element_id ≤20 字符，不能用长 blockId 拼）
  }

  async start() {
    try {
      const { cardId, messageId } = await createAndSendCard(
        this.receiveId, this.receiveIdType, buildCompanionInitial());
      this.cardId = cardId;
      this.messageId = messageId;
      if (!cardId || !messageId) return false;
      this.timer = setInterval(() => { this._flush(); }, FLUSH_MS);
      return true;
    } catch (err) {
      console.error('[Companion/Streamer] 建卡失败:', err.message);
      return false;
    }
  }

  _enqueue(fn) {
    this.chain = this.chain.then(fn).catch(err => {
      console.error('[Companion/Streamer] 写卡失败:', err.message);
    });
    return this.chain;
  }

  _normalizeRound(round) {
    const n = Number(round);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }

  _segmentById(id) {
    return this._segments.find(s => s.id === id);
  }

  _bodyElementById(id) {
    return this._bodyElements.find(e => e.element_id === id);
  }

  _setSegmentText(segmentId, text) {
    const seg = this._segmentById(segmentId);
    if (!seg) return;
    seg.text = text;
    const el = this._bodyElementById(segmentId);
    if (el) el.content = text;
    this._dirtySegments.add(segmentId);
  }

  _appendToSegment(segmentId, delta) {
    if (!delta) return;
    const seg = this._segmentById(segmentId);
    if (!seg) return;
    this._setSegmentText(segmentId, seg.text + delta);
  }

  _ensureSegmentForRound(round) {
    round = this._normalizeRound(round);
    this._maxRoundSeen = Math.max(this._maxRoundSeen, round);

    const existing = this._roundSegments.get(round);
    if (existing) {
      this._currentSegmentId = existing;
      return existing;
    }

    const segmentId = `main_text_${this._segments.length}`;
    const seg = { id: segmentId, round, text: '' };
    const el = buildCompanionTextElement(segmentId);

    this._segments.push(seg);
    this._roundSegments.set(round, segmentId);
    this._bodyElements.push(el);
    this._currentSegmentId = segmentId;

    this._enqueue(async () => {
      if (this.closed || !this.cardId) return;
      const ok = await insertCardElements(this.cardId, [el], { type: 'append' });
      if (!ok) this._failedElementIds.add(segmentId);
    });

    return segmentId;
  }

  _createThinkingPill(round) {
    const segmentId = this._ensureSegmentForRound(round);
    const pillElement = buildCompanionThinkingPill(round)[0];
    const pillId = `thinking_pill_r${round}`;

    const targetIdx = this._bodyElements.findIndex(e => e.element_id === segmentId);
    if (targetIdx >= 0) this._bodyElements.splice(targetIdx, 0, pillElement);
    else this._bodyElements.push(pillElement);

    const pill = {
      thinkingFull: '',
      dirty: false,
      collapsed: false,
      startedAt: Date.now(),
      segmentId,
      element: pillElement,
    };
    this.pills.set(round, pill);

    this._enqueue(async () => {
      if (this.closed || !this.cardId) return;

      let ok = false;
      if (!this._failedElementIds.has(segmentId)) {
        ok = await insertCardElements(this.cardId, [pillElement], {
          type: 'insert_before',
          targetElementId: segmentId,
        });
      }
      if (!ok) {
        ok = await insertCardElements(this.cardId, [pillElement], { type: 'append' });
      }
      if (!ok) this._failedElementIds.add(pillId);
    });

    return pill;
  }

  _flush() {
    if (!this.cardId || this.closed) return this.chain;

    const dirtySegmentIds = [...this._dirtySegments];
    this._dirtySegments.clear();
    for (const segmentId of dirtySegmentIds) {
      const seg = this._segmentById(segmentId);
      const content = seg?.text || '';
      this._enqueue(async () => {
        if (this.closed || !this.cardId || this._failedElementIds.has(segmentId)) return;
        const ok = await streamCardText(this.cardId, segmentId, toCardMarkdown(content));
        if (!ok) this._failedElementIds.add(segmentId);   // 推失败（元素丢失/超限）→ 标记，最终重建时按失败段处理
      });
    }

    for (const [round, pill] of this.pills) {
      if (!pill.dirty) continue;
      pill.dirty = false;
      const content = pill.thinkingFull;
      const pillId = `thinking_pill_r${round}`;
      this._enqueue(async () => {
        if (this.closed || !this.cardId || this._failedElementIds.has(pillId)) return;
        const ok = await streamCardText(this.cardId, `thinking_text_r${round}`, toCardMarkdown(content));
        if (!ok) this._failedElementIds.add(pillId);   // 内文推失败 → 标记整个 pill，最终过滤
      });
    }

    return this.chain;
  }

  async onEvent(event) {
    try {
      switch (event.type) {
        case 'thinking_chunk':
          this._onThinking(event.delta, event.round ?? 0);
          break;
        case 'text_chunk':
          this._onText(event.delta, event.round ?? 0);
          break;
        case 'tool_done':
          this._onToolDone(event.toolSteps);
          break;
        case 'complete':
        case 'direct_reply':
          await this._finish(event.text);
          break;
        case 'error':
          await this._error(event.text);
          break;
      }
    } catch (err) {
      console.error(`[Companion/Streamer] onEvent(${event.type}) 错误:`, err.message);
    }
  }

  _onThinking(delta, round = 0) {
    if (!delta || this.closed || this.closing) return;
    round = this._normalizeRound(round);

    if (this._activePillRound !== null && this._activePillRound !== round) {
      this._collapsePill(this._activePillRound, this.pills.get(this._activePillRound));
    }

    let pill = this.pills.get(round);
    if (!pill) pill = this._createThinkingPill(round);

    pill.thinkingFull += delta;
    pill.dirty = true;
    if (pill.element?.elements?.[0]) pill.element.elements[0].content = pill.thinkingFull;
    if (!pill.collapsed) this._activePillRound = round;
  }

  _onText(delta, round = 0) {
    if (!delta || this.closed || this.closing) return;
    round = this._normalizeRound(round);

    this._collapseOpenPills();

    const segmentId = this._ensureSegmentForRound(round);
    this._appendToSegment(segmentId, delta);
  }

  _onToolDone(steps = []) {
    if (this.closed || this.closing) return;
    this._collapseOpenPills();
    // 给刚完成的写类工具插操作 chip（文案=模型自己填的 card_note，见 engine step.summary）。累积 steps 去重。
    for (const step of Array.isArray(steps) ? steps : []) {
      if (!step?.done || !step.blockId || this._chartedSteps.has(step.blockId)) continue;
      this._chartedSteps.add(step.blockId);
      if (step.ok && step.summary && isChipTool(step.name)) {
        this._insertActionChip(step.blockId, step.name, step.summary);
      }
    }
    this._ensureSegmentForRound(this._maxRoundSeen + 1);
  }

  _insertActionChip(blockId, toolName, text) {
    const chipId = `action_${this._chipSeq++}`;   // 短 id（飞书 element_id ≤20 字符，不能拼长 blockId）
    const chip = buildCompanionActionChip(chipId, toolName, text);
    this._bodyElements.push(chip);   // 追加到当前末尾（在触发它的那段回复之后、下一段之前）
    this._enqueue(async () => {
      if (this.closed || !this.cardId) return;
      const ok = await insertCardElements(this.cardId, [chip], { type: 'append' });
      if (!ok) this._failedElementIds.add(chipId);
    });
  }

  _collapseOpenPills() {
    for (const [round, pill] of this.pills) {
      if (!pill.collapsed) this._collapsePill(round, pill);
    }
  }

  _collapsePill(round, pill) {
    if (!pill || pill.collapsed) return;
    pill.collapsed = true;
    if (this._activePillRound === round) this._activePillRound = null;

    const durationSec = (Date.now() - pill.startedAt) / 1000;
    const patch = buildCompanionPillCollapse(durationSec);
    const pillId = `thinking_pill_r${round}`;

    pill.element.expanded = false;
    pill.element.header = { ...pill.element.header, ...patch.header };

    this._enqueue(async () => {
      if (this.closed || !this.cardId || this._failedElementIds.has(pillId)) return;
      await patchCardElement(this.cardId, pillId, patch);
    });
  }

  _applyFinalTextFallback(finalText) {
    const text = String(finalText || '');
    if (!text.trim()) return;

    const current = this._segmentById(this._currentSegmentId) || this._segments[this._segments.length - 1];
    const hasAnyText = this._segments.some(s => s.text.trim());

    if (!hasAnyText && current) {
      this._setSegmentText(current.id, text);
      return;
    }

    if (current && !current.text.trim()) {
      this._setSegmentText(current.id, text);
      return;
    }

    if (current && text.startsWith(current.text) && text !== current.text) {
      this._setSegmentText(current.id, text);
    }
  }

  _finalBodyElements() {
    // 失败的"正文段"文本要救回，但只能并进另一个存活的**正文段**——绝不能并进 action chip（chip 也是 markdown，
    // 但它是灰字操作确认，正文并进去既错位又串味）。用 _segmentById 判定是不是段。
    let lastAliveTextIdx = -1;
    const pendingFailedText = [];

    for (let i = 0; i < this._bodyElements.length; i++) {
      const el = this._bodyElements[i];
      if (!el) continue;

      const eid = el.element_id;
      const seg = eid ? this._segmentById(eid) : null;
      const failed = eid && this._failedElementIds.has(eid);
      if (failed) {
        if (seg?.text?.trim()) {
          if (lastAliveTextIdx >= 0) {
            const alive = this._bodyElements[lastAliveTextIdx];
            alive.content = [alive.content, seg.text].filter(Boolean).join('\n\n');
          } else {
            pendingFailedText.push(seg.text);   // 前面还没有活着的段，暂存，等下一个活段来接
          }
        }
        continue;
      }

      if (el.tag === 'markdown' && seg) {   // 只有"段"才算并入目标（chip 不是段，seg 为 null）
        if (pendingFailedText.length) {
          el.content = [pendingFailedText.join('\n\n'), el.content].filter(Boolean).join('\n\n');
          pendingFailedText.length = 0;
        }
        lastAliveTextIdx = i;
      }
    }

    const filtered = this._bodyElements.filter(el => {
      if (!el) return false;
      if (el.element_id && this._failedElementIds.has(el.element_id)) return false;
      if (el.tag === 'markdown' && typeof el.content === 'string' && !el.content.trim()) return false;
      return true;
    });
    if (pendingFailedText.length) {   // 全程没有活着的段收留 → 兜一个新段（main_text_f=11 字符，合规）
      filtered.unshift(buildCompanionTextElement('main_text_f', pendingFailedText.join('\n\n')));
    }

    return filtered.length
      ? filtered
      : [buildCompanionTextElement('main_text_0', '我刚刚没有组织好语言，能再跟我说一次吗？')];
  }

  /** 整卡重建前把模型文本 escape+限长：段正文、胶囊内思考。chip（action_ 开头，含刻意 <font>）与胶囊 header 不动。 */
  _escapeFinalElements(elements) {
    return elements.map(el => {
      if (!el) return el;
      if (typeof el.element_id === 'string' && el.element_id.startsWith('action_')) return el;   // chip 不动
      if (el.tag === 'markdown' && typeof el.content === 'string') return { ...el, content: toCardMarkdown(el.content) };
      if (el.tag === 'collapsible_panel' && Array.isArray(el.elements)) {
        return { ...el, elements: el.elements.map(inner =>
          (inner?.tag === 'markdown' && typeof inner.content === 'string') ? { ...inner, content: toCardMarkdown(inner.content) } : inner) };
      }
      return el;
    });
  }

  async _finish(finalText) {
    if (this.closed || this.closing) return;
    this.closing = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }

    this._collapseOpenPills();
    this._applyFinalTextFallback(finalText);

    for (const seg of this._segments) {
      if (seg.text) this._dirtySegments.add(seg.id);
    }
    for (const pill of this.pills.values()) {
      if (pill.thinkingFull) pill.dirty = true;
    }
    this._flush();

    try {
      await this.chain;
      const finalElements = this._escapeFinalElements(this._finalBodyElements());
      await this._enqueue(async () => {
        if (!this.cardId) return;
        await closeStreamingMode(this.cardId);
        await updateCardEntity(this.cardId, buildCompanionDoneFromElements(finalElements));
      });
      await this.chain;
    } catch (err) {
      console.error('[Companion/Streamer] 收尾失败:', err.message);
    } finally {
      this.closed = true;
      this.closing = false;
    }
  }

  async _error(text) {
    if (this.closed || this.closing) return;
    this.closing = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }

    try {
      await this.chain;
      await this._enqueue(async () => {
        if (!this.cardId) return;
        await closeStreamingMode(this.cardId).catch(() => {});   // 先关流，否则错误卡 update 若失败会卡在"生成中"
        await updateCardEntity(this.cardId, buildErrorCard(text || '抱歉，我这会儿有点走神，等下再聊好吗？'));
      });
      await this.chain;
    } catch (err) {
      console.error('[Companion/Streamer] 错误态失败:', err.message);
    } finally {
      this.closed = true;
      this.closing = false;
    }
  }
}
