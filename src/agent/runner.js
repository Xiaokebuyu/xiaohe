/**
 * Runner — 唯一业务入口。串起 prompts / registry / permissions / engine，把 engine 事件
 * 翻译成跟旧 chat() 完全一致的 onProgress 事件（text_chunk/thinking_chunk/tool_start/
 * tool_done/complete/direct_reply/error），从而原样复用 index.js 的 ChatCardStreamer。
 *
 * step 1：无状态单轮（history 由调用方传入），readOnly 模式，内存无持久 session。
 * 结构化 SessionStore / compact / 审批 pause-resume 在后续步骤接入。
 */

import { client, MEETING_MODEL, INTERLEAVED_THINKING_HEADERS } from './model-client.js';
import { runEngine, ERROR_TEXT } from './engine.js';
import { PermissionEngine } from './permissions.js';
import { buildCompanionSystemPrompt, renderCompanionTurn } from './prompts.js';
import { buildCompanionRegistry } from './tools/index.js';
import { renderMemoryIndex } from '../companion/memory-store.js';

/** 陪伴默认走 MiniMax-M3（百万上下文），env 可覆盖降级。 */
const COMPANION_MODEL = process.env.BOT_COMPANION_MODEL || MEETING_MODEL;

const MAX_TOKENS = Number(process.env.BOT_CHAT_MAX_TOKENS) || 4096;
const MAX_ROUNDS = Number(process.env.BOT_CHAT_MAX_ROUNDS) || 20;
const THINKING_BUDGET = Number(process.env.BOT_THINKING_BUDGET) || 500;

/**
 * 陪伴入口。注入该人的记忆 + companion 权限模式 + 只挂记忆工具。
 * C1 范围：无状态单轮（history 传入）+ 记忆注入 + remember 工具。
 * 专属上下文（跨天 SQLite）/ compact / 主动关心在 C3+ 接入。
 *
 * @param {Object} p
 * @param {string} p.userText
 * @param {Array} [p.history]
 * @param {Object|null} [p.boundUser]
 * @param {Object} [p.chatContext]   { openId, chatType }
 * @param {Function} [p.emit]
 */
export async function runCompanionMessage({ userText, history = [], boundUser = null, chatContext = {}, personalContext = '', agentNote = '', emit }) {
  const send = emit || (() => Promise.resolve());

  const registry = buildCompanionRegistry();
  const permissions = new PermissionEngine({ mode: 'companion' });

  // 注入该人的记忆索引（主题+各条摘要；正文按需 recall_memory 调）
  let memoryInjection = '';
  try {
    if (chatContext.openId) memoryInjection = renderMemoryIndex(chatContext.openId);
  } catch (err) {
    console.warn('[Companion] load memory failed:', err.message);
  }

  const baseCtx = {
    sessionId: `companion:${chatContext.openId || 'anon'}`,
    chatType: chatContext.chatType || 'p2p',
    openId: chatContext.openId || null,
    boundUser,
    runMode: 'companion',
    chatContext,
  };

  // 参考 InkLoop：history 存干净原文；当前轮把动态上下文（记忆/专属上下文/召回）现装进 user turn。
  // personalContext/recall 先留空（C3 起接入），memory 已可注入。
  const renderedTurn = renderCompanionTurn({ userText, boundUser, memoryInjection, personalContext, agentNote });
  const initialMessages = [...history, { role: 'user', content: renderedTurn }];

  try {
    const result = await runEngine({
      client,
      model: COMPANION_MODEL,
      maxTokens: MAX_TOKENS,
      maxRounds: MAX_ROUNDS,
      buildSystem: () => buildCompanionSystemPrompt(),
      initialMessages,
      registry,
      permissions,
      baseCtx,
      thinking: { type: 'enabled', budget_tokens: THINKING_BUDGET },
      interleaved: true,
      headers: INTERLEAVED_THINKING_HEADERS,
      onTextChunk: (delta, round) => send({ type: 'text_chunk', delta, round }),
      onThinkingChunk: (delta, round) => send({ type: 'thinking_chunk', delta, round }),
      onToolStart: async (toolSteps) => {
        const tools = toolSteps.filter(s => !s.done).map(s => s.name);
        await send({ type: 'tool_start', tools, toolSteps });
      },
      onToolDone: async (toolSteps) => { await send({ type: 'tool_done', toolSteps }); },
    });

    if (result.toolSteps.length === 0) {
      await send({ type: 'direct_reply', text: result.text });
    } else {
      await send({ type: 'complete', text: result.text, toolSteps: result.toolSteps });
    }
    return {
      text: result.text,
      toolSummaries: result.toolSummaries,
      toolSteps: result.toolSteps,
      exhausted: result.exhausted,
      allFailed: result.allFailed,
    };
  } catch (err) {
    console.error('[Companion/Runner] Error:', err.message);
    await send({ type: 'error', text: ERROR_TEXT }).catch(() => {});
    return { text: ERROR_TEXT, toolSummaries: [], toolSteps: [], uncaughtError: err };
  }
}
