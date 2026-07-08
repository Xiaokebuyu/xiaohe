/**
 * 主动关心决策（C7）：规则硬门 + LLM 软判断。守 SKILL 的"尊重注意力、别打扰"。
 * hardGate 是纯函数（可测）；softDecide 调 LLM 判"现在该不该关心 + 说什么"。
 */
import { client, SUMMARY_MODEL } from '../model/client.js';
import { formatBeijingNow } from '../util/time.js';
import { lastProactiveAt, getContext } from './store.js';
import { loadUserMemory, renderForInjection } from '../memory/index.js';
import { extractJson } from '../util/json.js';

const DECIDE_MODEL = process.env.BOT_COMPANION_DISTILL_MODEL || SUMMARY_MODEL;
const COOLDOWN_MS = Number(process.env.XIAOHE_PROACTIVE_COOLDOWN_MS) || 20 * 60 * 60 * 1000;  // 20h 内不重复主动
const USER_ACTIVE_MS = Number(process.env.XIAOHE_PROACTIVE_USER_ACTIVE_MS) || 30 * 60 * 1000; // 用户 30 分钟内活跃就不打扰

/** 静默时段：默认 22:00–08:00（北京）。person.quiet_hours_json 可覆盖 {start,end}。 */
function inQuietHours(person) {
  let start = 22, end = 8;
  try { const q = person?.quiet_hours_json && JSON.parse(person.quiet_hours_json); if (q) { start = q.start ?? start; end = q.end ?? end; } } catch { /* default */ }
  const { dateTime } = formatBeijingNow();
  const hour = Number(dateTime.slice(11, 13));
  return start > end ? (hour >= start || hour < end) : (hour >= start && hour < end);
}

/**
 * 硬门：不满足直接不发。返回 { pass, reason }。
 * @param {Object} person companion_people 行
 */
export function hardGate(person) {
  if (!person) return { pass: false, reason: 'no_person' };
  if (person.enabled === 0) return { pass: false, reason: 'disabled' };
  if (inQuietHours(person)) return { pass: false, reason: 'quiet_hours' };

  const now = Date.now();
  if (person.last_user_at && now - Date.parse(person.last_user_at) < USER_ACTIVE_MS) {
    return { pass: false, reason: 'user_recently_active' };   // 人还在，不用主动凑
  }
  const lastPro = lastProactiveAt(person.open_id);
  if (lastPro && now - Date.parse(lastPro) < COOLDOWN_MS) {
    return { pass: false, reason: 'cooldown' };
  }
  // 上次主动后用户没回（outbound 晚于 last_user_at）→ 别追着打扰
  if (lastPro && (!person.last_user_at || Date.parse(lastPro) > Date.parse(person.last_user_at))) {
    return { pass: false, reason: 'unanswered_last_outreach' };
  }
  return { pass: true, reason: 'ok' };
}

/**
 * 软判断：LLM 看人物记忆 + 近期状态 + 钩子上下文，决定发不发、说什么。
 * @returns {Promise<{send:boolean, reason:string, message:string}>}
 */
export async function softDecide({ openId, boundUser, hook }) {
  const mem = await loadUserMemory(openId, boundUser);
  const memText = renderForInjection({ content: mem.content, chatType: 'p2p' });
  const ctx = getContext(openId);
  const { dateTime, weekday } = formatBeijingNow();
  const payload = hook.payload || {};

  const system = `你是"小合"——温柔知心的陪伴者。现在要判断：此刻主动私聊这个人合不合适，如果合适，说一句什么。
非常克制：只有当"这一句真的对他有意义、此刻不突兀"才发。宁可不发。别为了刷存在感发。
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
