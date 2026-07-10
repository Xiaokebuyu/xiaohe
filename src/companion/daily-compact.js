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
  getUncompactedTurns, getMaxTurnId, updateContext, getContext,
  markDailyCompactDate, markDistillAttempt, markDistillResult,
} from './store.js';

const THINKING_SNIPPET_MAX = 400;   // 每轮思考进 convo 的截断长度，防蒸馏输入过肿
import { ensureTopic, upsertEntry, renderMemoryIndex } from './memory-store.js';

const COMPACT_MODEL = process.env.BOT_COMPANION_DISTILL_MODEL || SUMMARY_MODEL;

const _inFlight = new Map();   // openId -> { promise, beforeIso, compactDate }：同人串行；不同 scope 不复用错结果

function sameCompactRequest(a, b) {
  return (a.beforeIso ?? null) === (b.beforeIso ?? null) && (a.compactDate ?? null) === (b.compactDate ?? null);
}

/**
 * 压一个人的当天对话。成功返回 true。
 * @param {string} openId
 * @param {Object|null} boundUser
 * @param {Object} [opts]
 * @param {string|null} [opts.beforeIso]    只压这个时间点之前的对话；daily 4 点调度传今日 04:00 cutoff，
 *   930k 紧急 compact 传 now-2h（只压 2 小时前，保留进行中的对话原文，防情绪悬崖）。
 * @param {string|null} [opts.compactDate]  传了才在成功/无需压时标记"今天已日常压过"；只有 daily 调度传，
 *   930k 紧急 compact 不传（两套触发互不干扰对方的"今天扫过没"状态）。
 */
export function dailyCompact(openId, boundUser = null, opts = {}) {
  const request = { beforeIso: opts.beforeIso ?? null, compactDate: opts.compactDate ?? null };
  const running = _inFlight.get(openId);
  if (running) {
    // 同一 scope 的重复调用才复用；不同 scope（如 daily cutoff vs 930k 全量）必须串行跑，别拿错结果冒充
    if (sameCompactRequest(running, request)) return running.promise;
    const p = running.promise.catch(() => false).then(() => _run(openId, boundUser, request));
    _inFlight.set(openId, { ...request, promise: p });
    p.finally(() => { if (_inFlight.get(openId)?.promise === p) _inFlight.delete(openId); });
    return p;
  }
  const p = _run(openId, boundUser, request);
  _inFlight.set(openId, { ...request, promise: p });
  p.finally(() => { if (_inFlight.get(openId)?.promise === p) _inFlight.delete(openId); });
  return p;
}

async function _run(openId, boundUser, { beforeIso = null, compactDate = null } = {}) {
  const compactStartedAt = new Date().toISOString();   // 读数据时刻：写回时若某条已被更晚的实时 remember 更新过，就不覆盖
  const rows = getUncompactedTurns(openId, beforeIso);
  if (rows.length === 0) {                                    // 真没内容才跳过（1 行=1 轮完整对话，仍值得蒸；旧 messages 版是 2 条，切 rows 后阈值要跟着改）
    if (compactDate) markDailyCompactDate(openId, compactDate);   // 标记今天已扫过，避免反复空转
    return true;
  }

  markDistillAttempt(openId);
  const throughTurnId = getMaxTurnId(openId, beforeIso);
  const memIdx = renderMemoryIndex(openId);
  const ctx = getContext(openId);
  // 拼 convo：带上小合当轮的思考原文（(内心：…)）——它对用户状态的在场判断常比暖回复更诚实，
  // 是补记"当时没顺手 remember 的 nuance"的关键来源。截断防肿。
  const convo = rows.map(r => {
    if (r.direction !== 'inbound') return `小合（主动）：${r.assistant_text}`;
    const inner = r.thinking_text
      ? `\n（小合当时的内心：${r.thinking_text.slice(0, THINKING_SNIPPET_MAX)}）`
      : '';
    return `他：${r.user_text}\n小合：${r.assistant_text}${inner}`;
  }).join('\n');

  const system = `你是"小合"的记忆整理器。把这一天的陪伴对话整理成结构化 JSON。
只留**稳定、未来有用**的（近况/心情/生活/偏好/约定/在跟进的事），别记流水账。
对话里带的"（小合当时的内心：…）"是小合当时的真实判断，比暖回复更能看出他的状态——重点参考它来补记他的心情和处境。
已有记忆索引会给你，**别重复**——同一件事给出它的 entry_id 做更新，而不是新建。
输出严格 JSON：
{
  "day_summary": "一两句话概括这一天他的状态、情绪基调，以及你们最后聊到哪、怎么收的尾（次日开场的温度全靠这句，要能接得上）",
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
        updatedBeforeIso: compactStartedAt,   // 期间被实时 remember 更新过的条目不覆盖（实时写赢）
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
  if (compactDate) markDailyCompactDate(openId, compactDate);   // 只在真压成功后标记"今天扫过"
  markDistillResult(openId, true);
  console.log(`[Companion/DailyCompact] ${openId.slice(0, 8)} 已压当天（记忆 ${(out.memory_updates || []).length} 条，boundary→${throughTurnId}）`);
  return true;
}
