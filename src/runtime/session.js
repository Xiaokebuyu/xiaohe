/**
 * 最小连续对话历史（per-openId 内存滑动窗）。
 *
 * 陪伴的第一印象不只看第一句，更看第二句能不能接住"刚才"。所以即使还没做跨天专属上下文（C3），
 * 也必须先有对话内的短期历史。参考 InkLoop buffer：只存干净原文、滑动窗封顶、TTL 可丢。
 *
 * 注意：这里存的是**干净原文**（user 说的话 / 小合的回复），不含 renderCompanionTurn 现装的
 * 动态上下文——那个只在当前轮现渲染，不进历史（避免旧记忆被冻结）。distill/跨天持久是 C3/C4。
 */

const MAX_TURNS = Number(process.env.XIAOHE_SESSION_MAX_TURNS) || 8;   // 留最近 8 轮（16 条）
const TTL_MS = Number(process.env.XIAOHE_SESSION_TTL_MS) || 45 * 60 * 1000;  // 45 分钟无动静即清

/** @type {Map<string, { messages: Array<{role:string,content:string}>, lastActive: number }>} */
const sessions = new Map();

/** 取该人的历史 messages（干净原文，不含本轮）。过期返回空。 */
export function getHistory(openId) {
  const s = sessions.get(openId);
  if (!s) return [];
  if (Date.now() - s.lastActive > TTL_MS) { sessions.delete(openId); return []; }
  return s.messages.slice();
}

/** 一轮结束后追加 user + assistant 干净文本，维护滑动窗。 */
export function appendTurn(openId, userText, assistantText) {
  if (!openId || !userText || !assistantText) return;
  const s = sessions.get(openId) || { messages: [], lastActive: 0 };
  s.messages.push({ role: 'user', content: userText });
  s.messages.push({ role: 'assistant', content: assistantText });
  const cap = MAX_TURNS * 2;
  if (s.messages.length > cap) s.messages.splice(0, s.messages.length - cap);
  s.lastActive = Date.now();
  sessions.set(openId, s);
}

let cleanupTimer = null;
export function startSessionCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, s] of sessions) if (now - s.lastActive > TTL_MS) sessions.delete(k);
  }, 5 * 60 * 1000);
  if (cleanupTimer.unref) cleanupTimer.unref();
}
