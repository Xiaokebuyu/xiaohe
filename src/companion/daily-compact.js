/**
 * 每日 compact（凌晨 4 点，或 930k 阈值提前触发）：把当天对话蒸进**记忆条目树** + 生成当日小结，
 * 然后推进 compact boundary（次日从"当日小结 + 新对话"开始）。取代旧的 idle 蒸馏 + 12 轮滚动。
 *
 * 分工：agent 聊天时已有意识地 remember 重要事；这里是**系统性兜底 + 裁历史**——补记漏的、合并碎条、
 * 写当日小结、推进 boundary。1M 窗口撑一整天，所以当天不压，只在跨天/超 930k 时压。
 */
import { client, SUMMARY_MODEL } from '../model/client.js';
import { extractJson } from '../util/json.js';
import {
  getUncompactedHistory, getMaxTurnId, updateContext, getContext,
  markDailyCompactDate, markDistillAttempt, markDistillResult,
} from './store.js';
import { ensureTopic, upsertEntry, renderMemoryIndex } from './memory-store.js';
import { formatBeijingNow } from '../util/time.js';

const COMPACT_MODEL = process.env.BOT_COMPANION_DISTILL_MODEL || SUMMARY_MODEL;

/**
 * 压一个人的当天对话。成功返回 true。
 * @param {string} openId
 * @param {Object|null} boundUser
 */
export async function dailyCompact(openId, boundUser = null) {
  const history = getUncompactedHistory(openId);
  markDailyCompactDate(openId, formatBeijingNow().today);   // 先占位：同日不重复扫（不管成败）
  if (history.length < 2) return true;                       // 没啥可压

  markDistillAttempt(openId);
  const throughTurnId = getMaxTurnId(openId);
  const memIdx = renderMemoryIndex(openId);
  const ctx = getContext(openId);
  const convo = history.map(m => `${m.role === 'user' ? '他' : '小合'}：${m.content}`).join('\n');

  const system = `你是"小合"的记忆整理器。把这一天的陪伴对话整理成结构化 JSON。
只留**稳定、未来有用**的（近况/心情/生活/偏好/约定/在跟进的事），别记流水账。
已有记忆索引会给你，**别重复**——同一件事给出它的 entry_id 做更新，而不是新建。
输出严格 JSON：
{
  "day_summary": "一两句话概括这一天他的状态和你们聊到哪（下次开场用）",
  "active_threads": ["还没聊完/要跟进的，最多3个，没有就空数组"],
  "memory_updates": [
    {"topic":"工作|健康|家人|情绪|生活|约定|...", "title":"短标题", "summary":"一句话摘要",
     "body":"可选详情", "salience":1-5, "entry_id":"可选，更新已有条目时给"}
  ]
}
memory_updates 只放真正值得长期记的（可空）。`;

  const user = `已有记忆索引（别重复，更新用 entry_id）：\n${memIdx || '（暂无）'}\n\n上次小结：${ctx.recentSummary || '（无）'}\n\n这一天的对话：\n${convo}`;

  let raw;
  try {
    const resp = await client.messages.create({ model: COMPACT_MODEL, max_tokens: 1200, system, messages: [{ role: 'user', content: user }] });
    raw = resp.content?.filter(b => b.type === 'text').map(b => b.text).join('') || '';
  } catch (err) {
    console.warn(`[Companion/DailyCompact] LLM 失败 ${openId.slice(0, 8)}:`, err.message);
    markDistillResult(openId, false);
    return false;   // 不推进 boundary：当天对话滚到明天再压
  }

  const out = extractJson(raw);
  if (!out) { console.warn('[Companion/DailyCompact] 解析失败'); markDistillResult(openId, false); return false; }

  // 1. 先写记忆条目（易失，先落）
  try {
    for (const u of (Array.isArray(out.memory_updates) ? out.memory_updates : [])) {
      if (!u?.topic || !u?.title) continue;
      const parentId = ensureTopic(openId, u.topic);
      upsertEntry(openId, {
        id: u.entry_id || null, parentId, title: u.title,
        summary: u.summary || '', body: u.body ?? null, salience: u.salience || 3,
      });
    }
  } catch (err) {
    console.warn('[Companion/DailyCompact] 写记忆失败，暂不推进 boundary:', err.message);
    markDistillResult(openId, false);
    return false;
  }

  // 2. 记忆落好，再写当日小结 + 推进 boundary（用蒸前捕获的水位）
  updateContext(openId, {
    recentSummary: typeof out.day_summary === 'string' ? out.day_summary : null,
    activeThreads: Array.isArray(out.active_threads) ? out.active_threads.slice(0, 3) : null,
    lastSummarizedTurnId: throughTurnId,
  });
  markDistillResult(openId, true);
  console.log(`[Companion/DailyCompact] ${openId.slice(0, 8)} 已压当天（记忆 ${(out.memory_updates || []).length} 条，boundary→${throughTurnId}）`);
  return true;
}
