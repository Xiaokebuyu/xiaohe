/**
 * 陪伴跨天状态存取（SQLite 后端，重启不忘）。
 *
 * 三层里的中间层「专属上下文」：
 *   - companion_turns：对话原文（含主动 outbound），history 从这里读最近 N 轮 —— 跨重启延续。
 *   - companion_context：recent_summary + active_threads（"上次聊到哪 / 还有哪些没聊完"），每轮注入。
 * 长期人物画像仍在 markdown（memory/），当前对话窗在内存（engine）。
 */
import db from '../db/index.js';

const now = () => new Date().toISOString();

// ── 人 ──
const _upsertPerson = db.prepare(`
  INSERT INTO companion_people (open_id, display_name, last_active_at, updated_at)
  VALUES (@openId, @displayName, @ts, @ts)
  ON CONFLICT(open_id) DO UPDATE SET
    display_name = COALESCE(excluded.display_name, companion_people.display_name),
    last_active_at = excluded.last_active_at,
    updated_at = excluded.updated_at
`);
export function touchPerson(openId, displayName = null) {
  _upsertPerson.run({ openId, displayName, ts: now() });
}
const _markUserAt = db.prepare(`UPDATE companion_people SET last_user_at=@ts, last_active_at=@ts WHERE open_id=@openId`);
const _markBotAt = db.prepare(`UPDATE companion_people SET last_bot_at=@ts, last_active_at=@ts WHERE open_id=@openId`);
export function getPerson(openId) {
  return db.prepare(`SELECT * FROM companion_people WHERE open_id=?`).get(openId) || null;
}

// ── 对话轮 ──
const _insTurn = db.prepare(`
  INSERT INTO companion_turns (open_id, direction, source, user_text, assistant_text, created_at)
  VALUES (@openId, @direction, @source, @userText, @assistantText, @ts)
`);

/** 反应式一轮：user + assistant。 */
export function appendExchange(openId, userText, assistantText) {
  touchPerson(openId);
  _insTurn.run({ openId, direction: 'inbound', source: 'feishu', userText, assistantText, ts: now() });
  _markUserAt.run({ openId, ts: now() });
}

/** 主动 outbound：小合主动说的话（无 user_text），必须记，否则它忘了自己说过啥。 */
export function appendOutbound(openId, assistantText, source = 'proactive') {
  touchPerson(openId);
  _insTurn.run({ openId, direction: 'outbound', source, userText: null, assistantText, ts: now() });
  _markBotAt.run({ openId, ts: now() });
}

/**
 * 最近 N 轮展开成 Anthropic messages（干净原文，不含现装动态上下文）。
 * inbound → user+assistant 两条；outbound → 只 assistant 一条。
 */
export function getRecentHistory(openId, limitTurns = 8) {
  const rows = db.prepare(
    `SELECT * FROM companion_turns WHERE open_id=? ORDER BY id DESC LIMIT ?`
  ).all(openId, limitTurns);
  rows.reverse();
  const msgs = [];
  for (const r of rows) {
    if (r.direction === 'inbound') {
      if (r.user_text) msgs.push({ role: 'user', content: r.user_text });
      if (r.assistant_text) msgs.push({ role: 'assistant', content: r.assistant_text });
    } else {
      if (r.assistant_text) msgs.push({ role: 'assistant', content: r.assistant_text });
    }
  }
  return msgs;
}

/** 距上次对话多久了（给 personal context 用："上次是昨天/3天前聊的"）。 */
export function getTurnsSince(openId, sinceIso) {
  return db.prepare(
    `SELECT COUNT(*) n FROM companion_turns WHERE open_id=? AND created_at > ?`
  ).get(openId, sinceIso).n;
}

/** 自上次摘要以来新增了多少轮 —— 用 turn id（单调、不撞同毫秒）判 C5 滚动 compact 触发。 */
export function countTurnsSinceContext(openId) {
  const c = db.prepare(`SELECT last_summarized_turn_id FROM companion_context WHERE open_id=?`).get(openId);
  const since = c?.last_summarized_turn_id || 0;
  return db.prepare(
    `SELECT COUNT(*) n FROM companion_turns WHERE open_id=? AND id > ?`
  ).get(openId, since).n;
}

// ── 关系上下文 ──
const _maxTurnId = db.prepare(`SELECT COALESCE(MAX(id),0) m FROM companion_turns WHERE open_id=?`);
const _upsertContext = db.prepare(`
  INSERT INTO companion_context (open_id, recent_summary, active_threads_json, last_summarized_turn_id, updated_at)
  VALUES (@openId, @recentSummary, @activeThreads, @maxId, @ts)
  ON CONFLICT(open_id) DO UPDATE SET
    recent_summary = COALESCE(excluded.recent_summary, companion_context.recent_summary),
    active_threads_json = COALESCE(excluded.active_threads_json, companion_context.active_threads_json),
    last_summarized_turn_id = excluded.last_summarized_turn_id,
    updated_at = excluded.updated_at
`);
export function getContext(openId) {
  const row = db.prepare(`SELECT * FROM companion_context WHERE open_id=?`).get(openId);
  if (!row) return { recentSummary: '', activeThreads: [] };
  let threads = [];
  try { threads = row.active_threads_json ? JSON.parse(row.active_threads_json) : []; } catch { /* ignore */ }
  return { recentSummary: row.recent_summary || '', activeThreads: threads, updatedAt: row.updated_at };
}
/** 更新关系上下文（distill/compact 的落点）。同时把"已摘要到"的水位推到当前最新轮。 */
export function updateContext(openId, { recentSummary = null, activeThreads = null } = {}) {
  _upsertContext.run({
    openId,
    recentSummary,
    activeThreads: activeThreads ? JSON.stringify(activeThreads) : null,
    maxId: _maxTurnId.get(openId).m,
    ts: now(),
  });
}

/**
 * 待蒸馏候选：已静默（last_active 早于 idle 阈值）且自上次蒸馏后有新对话
 * （last_user_at 晚于 context.updated_at，或还没蒸过）。返回 openId 数组。
 */
export function listDistillCandidates(idleMs) {
  const cutoff = new Date(Date.now() - idleMs).toISOString();
  const rows = db.prepare(`
    SELECT p.open_id
    FROM companion_people p
    LEFT JOIN companion_context c ON c.open_id = p.open_id
    WHERE p.last_active_at IS NOT NULL
      AND p.last_active_at < @cutoff
      AND p.last_user_at IS NOT NULL
      AND (c.updated_at IS NULL OR p.last_user_at > c.updated_at)
  `).all({ cutoff });
  return rows.map(r => r.open_id);
}

// ── 主动关心钩子（C6/C7）──
let _hookSeq = 0;
function hookId() { return `hk_${Date.now().toString(36)}_${(_hookSeq++).toString(36)}`; }

const _insHook = db.prepare(`
  INSERT INTO companion_hooks (id, open_id, kind, fire_at, status, payload_json, created_at)
  VALUES (@id, @openId, @kind, @fireAt, 'active', @payload, @ts)
`);
/** 建一个主动关心钩子。payload 携带执行所需上下文（跟进啥/当时说了啥）。返回 hookId。 */
export function createHook(openId, { kind = 'custom', fireAt, payload = {} }) {
  const id = hookId();
  _insHook.run({ id, openId, kind, fireAt, payload: JSON.stringify(payload || {}), ts: now() });
  return id;
}
/** 到点待发的 active 钩子。 */
export function listDueHooks(nowIso = now()) {
  return db.prepare(
    `SELECT * FROM companion_hooks WHERE status='active' AND fire_at <= ? ORDER BY fire_at LIMIT 50`
  ).all(nowIso).map(h => { try { h.payload = JSON.parse(h.payload_json || '{}'); } catch { h.payload = {}; } return h; });
}
export function markHookFired(id) {
  db.prepare(`UPDATE companion_hooks SET status='fired', fired_at=? WHERE id=?`).run(now(), id);
}
export function markHookSkipped(id, reason) {
  db.prepare(`UPDATE companion_hooks SET status='skipped', skip_reason=?, fired_at=? WHERE id=?`).run(reason || '', now(), id);
}
export function cancelHook(id) {
  db.prepare(`UPDATE companion_hooks SET status='cancelled' WHERE id=?`).run(id);
}

/** 最近一次主动 outbound 的时间（冷却判断用）。无则 null。 */
export function lastProactiveAt(openId) {
  const r = db.prepare(
    `SELECT MAX(created_at) t FROM companion_turns WHERE open_id=? AND direction='outbound'`
  ).get(openId);
  return r?.t || null;
}

const _logOutreach = db.prepare(`
  INSERT INTO companion_outreach_log (open_id, hook_id, kind, decision, reason, message, created_at)
  VALUES (@openId, @hookId, @kind, @decision, @reason, @message, @ts)
`);
export function logOutreach(openId, { hookId = null, kind = null, decision, reason = '', message = '' }) {
  _logOutreach.run({ openId, hookId, kind, decision, reason, message, ts: now() });
}

/**
 * 渲染注入 renderCompanionTurn 的「最近关系状态」短块。为空返回 ''。
 */
export function renderPersonalContext(openId) {
  const ctx = getContext(openId);
  const person = getPerson(openId);
  const parts = [];
  if (person?.last_user_at) {
    const days = Math.floor((Date.now() - Date.parse(person.last_user_at)) / 86400000);
    if (days >= 1) parts.push(`（你们上次聊已经是 ${days} 天前了。）`);
  }
  if (ctx.recentSummary) parts.push(ctx.recentSummary);
  if (ctx.activeThreads?.length) parts.push(`还没聊完的：${ctx.activeThreads.map(t => `「${t}」`).join('、')}`);
  return parts.join('\n');
}
