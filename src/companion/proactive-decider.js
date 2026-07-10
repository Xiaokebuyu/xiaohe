/**
 * 主动关心决策（C7）：规则硬门 + LLM 软判断。守 SKILL 的"尊重注意力、别打扰"。
 * hardGate 是纯函数（可测）；softDecide 调 LLM 判"现在该不该关心 + 说什么"。
 */
import { client, SUMMARY_MODEL } from '../model/client.js';
import { formatBeijingNow } from '../util/time.js';
import { getContext } from './store.js';
import { renderMemoryIndex } from './memory-store.js';
import { extractJson } from '../util/json.js';

const DECIDE_MODEL = process.env.BOT_COMPANION_DISTILL_MODEL || SUMMARY_MODEL;

/**
 * 硬门（用户已定"全拆"：冷却/活跃/静默时段全去掉，钩子到点就发）。
 * 只剩「人存不存在 / 被没被禁用」这类合法性校验——不是免打扰门，是发不出去的前置。
 * 「此刻发合不合适」交给 softDecide 的 LLM 软判断（autonomous），user_requested 直接发。
 * @param {Object} person companion_people 行
 */
export function hardGate(person) {
  if (!person) return { pass: false, reason: 'no_person' };
  if (person.enabled === 0) return { pass: false, reason: 'disabled' };
  return { pass: true, reason: 'ok' };
}

/**
 * 软判断：LLM 看人物记忆 + 近期状态 + 钩子上下文，决定发不发、说什么。
 * @returns {Promise<{send:boolean, reason:string, message:string}>}
 */
export async function softDecide({ openId, boundUser, hook }) {
  const memText = renderMemoryIndex(openId);
  const ctx = getContext(openId);
  const { dateTime, weekday } = formatBeijingNow();
  const payload = hook.payload || {};

  const system = `你是"小合"——温柔知心的陪伴者。现在要判断：此刻主动私聊这个人合不合适，如果合适，说一句什么。
非常克制：只有当"这一句真的对他有意义、此刻不突兀"才发。宁可不发。别为了刷存在感发。
看当前时间：深夜/凌晨（约 23:00–7:00）除非事情很要紧，否则别打扰，让他睡；这个点大多数关心都可以等天亮。
输出严格 JSON：{"send": true/false, "reason": "一句话理由", "message": "要发的话（温柔、短、自然，像朋友随口关心；不发则空串）"}`;

  const sourceHint = payload.source === 'user_requested'
    ? '（这是他当时明确让你提醒的，可以直接一点：「你让我提醒你…」）'
    : '（这是你自己记下来想跟进的，别显得像定了闹钟，更像突然想起来关心：「突然想起你…」）';

  const user = `现在：${dateTime} ${weekday}
关心的缘由（钩子）：${payload.about ? `关于：${payload.about}` : `kind=${hook.kind}`}${payload.note ? `，备注：${payload.note}` : ''}
${sourceHint}
你对他的记忆：\n${memText || '（还不多）'}
最近关系状态：${ctx.recentSummary || '（无）'}`;

  let raw;
  try {
    const resp = await client.messages.create({ model: DECIDE_MODEL, max_tokens: 400, system, messages: [{ role: 'user', content: user }] });
    raw = resp.content?.filter(b => b.type === 'text').map(b => b.text).join('') || '';
  } catch (err) {
    return { send: false, reason: `llm_error:${err.message}`, message: '' };
  }
  const out = extractJson(raw);
  if (!out) return { send: false, reason: 'parse_failed', message: '' };
  return { send: !!out.send && !!out.message, reason: String(out.reason || ''), message: String(out.message || '').trim() };
}
