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
import { buildCompanionSystemPrompt, renderCompanionContext } from './prompts.js';
import { buildCompanionRegistry } from './tools/index.js';
import { renderMemoryIndex } from '../companion/memory-store.js';
import { getPerson } from '../companion/store.js';
import { beijingNowMinute, humanGap } from '../util/time.js';
import { AUDITOR_MODE, prefilterAudit, judgeMissedAction, buildActivationMessage, correctionSendable } from '../companion/action-auditor.js';

/** 陪伴默认走 MiniMax-M3（百万上下文），env 可覆盖降级。 */
const COMPANION_MODEL = process.env.BOT_COMPANION_MODEL || MEETING_MODEL;

// 8192：思考 token 算进 max_tokens（M3 adaptive），4096 曾导致带思考时回复被截断（断头）
const MAX_TOKENS = Number(process.env.BOT_CHAT_MAX_TOKENS) || 8192;
// 上限夹到 99999：element_id `thinking_pill_r${round}` 到 r99999 正好 20 字符（飞书硬限），别让 env 撑爆
const MAX_ROUNDS = Math.min(Math.max(1, Number(process.env.BOT_CHAT_MAX_ROUNDS) || 20), 99_999);

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
export async function runCompanionMessage({ userText, history = [], boundUser = null, chatContext = {}, personalContext = '', activeHooks = '', agentNote = '', emit }) {
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

  // 当前时间 + 距他上条消息多久（<now> 用；毫秒戳已删，分钟级即可）
  const { dateHm, hm, weekday, iso } = beijingNowMinute();
  let lastGap = '';
  try {
    if (chatContext.openId) {
      const person = getPerson(chatContext.openId);   // last_user_at 此刻还是上条消息的时间（本条 appendExchange 在回复后才写）
      if (person?.last_user_at) lastGap = humanGap(Date.now() - Date.parse(person.last_user_at));
    }
  } catch { /* 取不到就不显 gap */ }

  // 角色分离：动态上下文进「第二个 system 块」（renderCompanionContext），user 轮只留纯原话（带收讯时刻前缀）。
  // history 仍存干净原文；旧记忆/旧时间不会被冻进历史。
  const dynamicContext = renderCompanionContext({
    nowHm: dateHm, weekday, iso, lastGap, memoryInjection, agentNote, personalContext, activeHooks,
  });
  const initialMessages = [...history, { role: 'user', content: `[${hm}] ${userText}` }];

  try {
    const result = await runEngine({
      client,
      model: COMPANION_MODEL,
      maxTokens: MAX_TOKENS,
      maxRounds: MAX_ROUNDS,
      buildSystem: () => buildCompanionSystemPrompt(dynamicContext),
      initialMessages,
      registry,
      permissions,
      baseCtx,
      thinking: { type: 'adaptive' },   // M3 只认 adaptive/disabled；adaptive=模型按难度自决要不要思考（budget_tokens 对 M3 无效，思考 token 直接算进 max_tokens）
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

    // 动作核查（"良心"）：用户已先拿到原回复；这里事后核查"要了动作却没真调工具"，
    // enforce 模式下追加一轮把它补上。整段 fail-open，绝不影响已发出的主回复。
    let correction = null;
    if (AUDITOR_MODE !== 'off' && !result.exhausted && !result.allFailed && !result.truncated && result.text) {
      correction = await auditAndCorrect({ userText, result, registry, permissions, baseCtx, dynamicContext })
        .catch(err => { console.warn('[ActionAuditor] 核查流程异常（放过）:', err.message); return null; });
    }

    return {
      text: result.text,
      toolSummaries: result.toolSummaries,
      toolSteps: result.toolSteps,
      exhausted: result.exhausted,
      allFailed: result.allFailed,
      thinkingText: result.thinkingText || '',   // 落库喂夜间 compact
      correction,                                 // { text, toolSteps, thinkingText } | null，server 发独立补正卡 + 合并落库
    };
  } catch (err) {
    console.error('[Companion/Runner] Error:', err.message);
    await send({ type: 'error', text: ERROR_TEXT }).catch(() => {});
    return { text: ERROR_TEXT, toolSummaries: [], toolSteps: [], uncaughtError: err };
  }
}

/**
 * 事后核查 +（enforce 模式）纠正。任何路径失败都返回 null，不影响已发出的主回复。
 * @returns {Promise<{text,toolSteps,thinkingText}|null>}  可发的补正；null=无需/不可发
 */
async function auditAndCorrect({ userText, result, registry, permissions, baseCtx, dynamicContext }) {
  const calledOkTools = result.toolSteps.filter(s => s.ok).map(s => s.name);
  const actions = prefilterAudit({ userText, assistantText: result.text, calledOkTools });
  if (!actions.length) return null;   // 绝大多数轮到此为止，零额外调用

  const verdict = await judgeMissedAction({ userText, assistantText: result.text, toolSummaries: result.toolSummaries, actions });
  // 全量结构化日志（shadow 期就靠它测误报/漏报，也是以后调词表/prompt 的唯一依据）
  console.log('[ActionAuditor] verdict ' + JSON.stringify({
    openId: (baseCtx.openId || '').slice(0, 8), mode: AUDITOR_MODE,
    prefilter: actions.map(a => a.id), missed: verdict?.missed ?? 'judge_failed',
    action: verdict?.action_id, info_sufficient: verdict?.info_sufficient, reason: verdict?.reason,
  }));
  if (!verdict?.missed || AUDITOR_MODE === 'shadow') return null;   // shadow：只判只记，不纠正

  // 纠正轮 = 在真实 transcript 后追加激活消息，跑一次（不再核查，防递归）。
  // 激活消息只存在于这个临时 messages 数组——不进 companion_turns，下一轮 history 从 DB 重建，天然不带它。
  const corr = await runEngine({
    client, model: COMPANION_MODEL, maxTokens: MAX_TOKENS,
    maxRounds: 4,                                     // 补救预算：调工具 + 说一句，不给长链
    buildSystem: () => buildCompanionSystemPrompt(dynamicContext),
    initialMessages: [...result.messages, { role: 'user', content: buildActivationMessage(verdict) }],
    registry, permissions, baseCtx,
    thinking: { type: 'adaptive' }, interleaved: true, headers: INTERLEAVED_THINKING_HEADERS,
    // 不传 onTextChunk/onToolDone 等回调：纠正轮不流式，成品走独立卡
  });

  if (!correctionSendable(corr, verdict.expected_tools)) {
    console.warn('[ActionAuditor] 纠正轮仍未落地且不可发，放过。tools=' + corr.toolSteps.map(s => `${s.name}:${s.ok}`).join(','));
    return null;
  }
  return { text: corr.text, toolSteps: corr.toolSteps, thinkingText: corr.thinkingText || '' };
}
