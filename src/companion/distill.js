/**
 * 陪伴蒸馏（C4）：一个人聊完一阵、静默下来后，把这段对话的软信息整理进长期记忆 + 更新关系上下文。
 *
 * 分工（对齐设计）：
 *   - compact（C5）= 对话中窗口管理，不写长期记忆。
 *   - distill（这里）= 静默/结束时整理，写 per-user markdown memory + 更新 recent_summary。
 * 陪伴画像（心情/生活/偏好/约定/在聊的事），不是工作画像。用户明确要"超时没发消息就保存记忆"。
 */
import { client, SUMMARY_MODEL } from '../model/client.js';
import { loadUserMemory, saveUserMemory, appendNote, upsertSection, checkSizeLimit } from '../memory/index.js';
import { getRecentHistory, getContext, updateContext, getMaxTurnId, markDistillAttempt, markDistillResult } from './store.js';
import { extractJson } from '../util/json.js';

const DISTILL_MODEL = process.env.BOT_COMPANION_DISTILL_MODEL || SUMMARY_MODEL;
const UPSERT_SECTIONS = new Set(['人物画像', '相处偏好', '约定与边界', '情绪与支持方式']);

/**
 * 蒸馏一个人的近期对话。成功返回 true。
 * @param {string} openId
 * @param {Object|null} boundUser
 */
export async function distillPerson(openId, boundUser = null) {
  const history = getRecentHistory(openId, 12);
  if (history.length < 2) return false;   // 没聊什么，不蒸

  // 先记一次尝试（F3：即使失败也不会下一分钟又选中同一个人无限重试）+ 捕获水位（F4）
  markDistillAttempt(openId);
  const throughTurnId = getMaxTurnId(openId);

  const mem = await loadUserMemory(openId, boundUser);
  const ctx = getContext(openId);
  const convo = history.map(m => `${m.role === 'user' ? '他' : '小合'}：${m.content}`).join('\n');

  const system = `你是"小合"的记忆整理器。把一段陪伴对话整理成结构化 JSON，用于小合下次还记得这个人。
只提取**稳定、未来有用**的软信息（心情近况/生活/偏好/约定/在聊没聊完的事），不要复述对话，不要记流水账。
输出严格 JSON：
{
  "recent_summary": "一两句话概括这阵子他的状态和你们聊到哪（给下次开场用）",
  "active_threads": ["还没聊完/需要跟进的事，最多3个，没有就空数组"],
  "memory_notes": [
    {"section": "人物画像|相处偏好|近期状态|约定与边界|情绪与支持方式|重要日期", "content": "一句话", "mode": "upsert|append"}
  ]
}
memory_notes 只放真正值得长期记的（可空数组）。upsert=画像类整段更新，append=动态类追加。`;

  const user = `已有记忆（供去重，别重复写）：\n${mem.content || '（暂无）'}\n\n上次概括：${ctx.recentSummary || '（无）'}\n\n这段对话：\n${convo}`;

  let raw;
  try {
    const resp = await client.messages.create({
      model: DISTILL_MODEL,
      max_tokens: 800,
      system,
      messages: [{ role: 'user', content: user }],
    });
    raw = resp.content?.filter(b => b.type === 'text').map(b => b.text).join('') || '';
  } catch (err) {
    console.warn(`[Companion/Distill] LLM 失败 ${openId.slice(0, 8)}:`, err.message);
    markDistillResult(openId, false);
    return false;
  }

  const out = extractJson(raw);
  if (!out) { console.warn('[Companion/Distill] 解析 JSON 失败'); markDistillResult(openId, false); return false; }

  // 1. 先写长期记忆（F9：memory 是易失的，先落它；失败就别推进上下文水位，好重试）
  if (Array.isArray(out.memory_notes) && out.memory_notes.length) {
    let content = mem.content;
    for (const note of out.memory_notes) {
      if (!note?.section || !note?.content) continue;
      const next = (note.mode === 'upsert' || UPSERT_SECTIONS.has(note.section))
        ? upsertSection(content, { section: note.section, body: note.content, segment: 'private' })
        : appendNote(content, { note: `${note.section}：${note.content}`, segment: 'private' });
      if (checkSizeLimit(next).overHard) break;   // 超硬上限就停在上一版，别写坏
      content = next;
    }
    try {
      await saveUserMemory(openId, boundUser, content);
    } catch (err) {
      console.warn('[Companion/Distill] 存记忆失败，暂不推进上下文（下次重试）:', err.message);
      markDistillResult(openId, false);
      return false;
    }
  }

  // 2. 记忆落好后再更新关系上下文 + 推进水位（用蒸馏时捕获的 throughTurnId）
  updateContext(openId, {
    recentSummary: typeof out.recent_summary === 'string' ? out.recent_summary : null,
    activeThreads: Array.isArray(out.active_threads) ? out.active_threads.slice(0, 3) : null,
    lastSummarizedTurnId: throughTurnId,
  });
  markDistillResult(openId, true);

  console.log(`[Companion/Distill] ${openId.slice(0, 8)} 已整理（threads=${(out.active_threads || []).length} notes=${(out.memory_notes || []).length}）`);
  return true;
}
