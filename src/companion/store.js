/**
 * 陪伴跨天状态存取（SQLite 后端，重启不忘）。
 *
 * 三层里的中间层「专属上下文」：
 *   - companion_turns：对话原文（含主动 outbound），history 从这里读最近 N 轮 —— 跨重启延续。
 *   - companion_context：recent_summary + active_threads（"上次聊到哪 / 还有哪些没聊完"），每轮注入。
 * 长期人物画像仍在 markdown（memory/），当前对话窗在内存（engine）。
 */
import db from '../db/index.js';
import { beijingTimeTag, beijingDateLabel } from '../util/time.js';

const now = () => new Date().toISOString();

// thinking 落库上限：compact 侧只截 400，但存全量会让 companion_turns 随长思考膨胀，读时又全进内存。
const THINKING_TEXT_MAX_CHARS = Number(process.env.XIAOHE_THINKING_TEXT_MAX_CHARS) || 12_000;
function clampThinkingText(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  return s.length > THINKING_TEXT_MAX_CHARS ? `${s.slice(0, THINKING_TEXT_MAX_CHARS)}\n（thinking 已截断）` : s;
}

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
  INSERT INTO companion_turns (open_id, direction, source, user_text, assistant_text, thinking_text, created_at)
  VALUES (@openId, @direction, @source, @userText, @assistantText, @thinkingText, @ts)
`);

/** 反应式一轮：user + assistant。thinkingText = 模型当轮的思考（仅供夜间 compact 补记，实时上下文不注入）。 */
export function appendExchange(openId, userText, assistantText, thinkingText = null) {
  touchPerson(openId);
  _insTurn.run({ openId, direction: 'inbound', source: 'feishu', userText, assistantText, thinkingText: clampThinkingText(thinkingText), ts: now() });
  _markUserAt.run({ openId, ts: now() });
}

/** 主动 outbound：小合主动说的话（无 user_text），必须记，否则它忘了自己说过啥。 */
export function appendOutbound(openId, assistantText, source = 'proactive') {
  touchPerson(openId);
  _insTurn.run({ openId, direction: 'outbound', source, userText: null, assistantText, thinkingText: null, ts: now() });
  _markBotAt.run({ openId, ts: now() });
}

/** 追加一条消息，保证 messages 交替：合并连续同角色；首条是 assistant 则先补一条合成 user。 */
function pushMsg(msgs, role, content) {
  if (!content) return;
  const last = msgs[msgs.length - 1];
  if (last && last.role === role) { last.content += `\n\n${content}`; return; }
  if (role === 'assistant' && msgs.length === 0) {
    msgs.push({ role: 'user', content: '（系统记录：小合之前主动发起过一次关心，用户当时没先说话。）' });
  }
  msgs.push({ role, content });
}

/**
 * 最近 N 轮展开成 Anthropic messages（干净原文，不含现装动态上下文）。
 * inbound → user+assistant；outbound → 只 assistant。经 pushMsg 保证角色交替（防端点报错）。
 */
export function getRecentHistory(openId, limitTurns = 8) {
  const rows = db.prepare(
    `SELECT * FROM companion_turns WHERE open_id=? ORDER BY id DESC LIMIT ?`
  ).all(openId, limitTurns);
  rows.reverse();
  const msgs = [];
  for (const r of rows) {
    if (r.direction === 'inbound') {
      pushMsg(msgs, 'user', r.user_text);
      pushMsg(msgs, 'assistant', r.assistant_text);
    } else {
      pushMsg(msgs, 'assistant', r.assistant_text);
    }
  }
  return msgs;
}

/**
 * 未压缩的对话（compact boundary=last_summarized_turn_id 之后的所有 turn）展开成 messages。
 * 每天凌晨 compact 前，这就是"当天原文"；1M 窗口装得下，当天不裁。boundary 之前的由 recent_summary 承接。
 */
export function getUncompactedHistory(openId, beforeIso = null) {
  const rows = getUncompactedTurns(openId, beforeIso);
  const msgs = [];
  for (const r of rows) {
    if (r.direction === 'inbound') {
      // user 轮带 [收讯时刻] 前缀：帮模型看出"早上说的话 / 现在是晚上"，补情绪连续性。
      // 只加在 user 侧（模型不生成 user 轮，无模仿风险）；contract 已说明这是系统标注不是他打的字。
      const tag = beijingTimeTag(r.created_at);
      pushMsg(msgs, 'user', tag ? `[${tag}] ${r.user_text}` : r.user_text);
      pushMsg(msgs, 'assistant', r.assistant_text);
    } else {
      pushMsg(msgs, 'assistant', r.assistant_text);
    }
  }
  return msgs;
}

/** 未压缩对话的**原始行**（含 thinking_text / created_at），给 daily-compact 拼 convo 用。 */
export function getUncompactedTurns(openId, beforeIso = null) {
  const c = db.prepare(`SELECT last_summarized_turn_id FROM companion_context WHERE open_id=?`).get(openId);
  const since = c?.last_summarized_turn_id || 0;
  return beforeIso
    ? db.prepare(`SELECT * FROM companion_turns WHERE open_id=? AND id > ? AND created_at < ? ORDER BY id`).all(openId, since, beforeIso)
    : db.prepare(`SELECT * FROM companion_turns WHERE open_id=? AND id > ? ORDER BY id`).all(openId, since);
}

/** compact 状态（boundary + 今天有没有 daily compact 成功过 + 上次尝试时间，供失败重试冷却判断）。 */
export function getCompactState(openId) {
  const c = db.prepare(`SELECT last_summarized_turn_id, last_daily_compact_date, last_distill_attempt_at FROM companion_context WHERE open_id=?`).get(openId);
  return {
    lastSummarizedTurnId: c?.last_summarized_turn_id || 0,
    lastDailyCompactDate: c?.last_daily_compact_date || null,
    lastDistillAttemptAt: c?.last_distill_attempt_at || null,
  };
}
/** 标记今天已成功 daily compact 过（防同日重复扫；只应在成功/无需压时调用，别在失败前占位）。 */
export function markDailyCompactDate(openId, date) {
  db.prepare(`
    INSERT INTO companion_context (open_id, last_daily_compact_date, updated_at)
    VALUES (@openId, @date, COALESCE((SELECT updated_at FROM companion_context WHERE open_id=@openId), @ts))
    ON CONFLICT(open_id) DO UPDATE SET last_daily_compact_date = @date
  `).run({ openId, date, ts: now() });
}
/**
 * 有 daily compact 候选的人：boundary 之后、（可选）cutoff 之前有 turn。
 * @param {string|null} beforeIso 传了则只算 cutoff 之前的对话——防止过了凌晨 4 点之后当天新聊的内容
 *   被立刻当成"待压"扫走（daily 调度传今日 04:00 cutoff；不传给 930k 紧急场景之类的调用方）。
 */
export function listCompactCandidates(beforeIso = null) {
  const sql = beforeIso
    ? `SELECT p.open_id FROM companion_people p LEFT JOIN companion_context c ON c.open_id = p.open_id
       WHERE EXISTS (SELECT 1 FROM companion_turns t WHERE t.open_id=p.open_id AND t.id > COALESCE(c.last_summarized_turn_id,0) AND t.created_at < ?)`
    : `SELECT p.open_id FROM companion_people p LEFT JOIN companion_context c ON c.open_id = p.open_id
       WHERE EXISTS (SELECT 1 FROM companion_turns t WHERE t.open_id=p.open_id AND t.id > COALESCE(c.last_summarized_turn_id,0))`;
  const rows = beforeIso ? db.prepare(sql).all(beforeIso) : db.prepare(sql).all();
  return rows.map(r => r.open_id);
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
const _maxTurnIdBefore = db.prepare(`SELECT COALESCE(MAX(id),0) m FROM companion_turns WHERE open_id=? AND created_at < ?`);
/**
 * 当前该人最新 turn id（compact 前捕获作水位，避免 await 期间进的新轮被误标已摘要）。
 * @param {string|null} beforeIso 传了则只算 cutoff 之前的（daily compact 只推进到 cutoff，之后的留给明天）
 */
export function getMaxTurnId(openId, beforeIso = null) {
  return beforeIso ? _maxTurnIdBefore.get(openId, beforeIso).m : _maxTurnId.get(openId).m;
}

// last_summarized_turn_id 只在新值 >= 旧值时才覆盖（WHERE 子句失败=整条 DO UPDATE 无操作，视作 no-op）：
// daily 调度和 930k 紧急 compact 可能并发跑到同一个人，避免后完成的旧 compact 把水位覆盖回更早的值。
const _upsertContext = db.prepare(`
  INSERT INTO companion_context (open_id, recent_summary, active_threads_json, last_summarized_turn_id, updated_at)
  VALUES (@openId, @recentSummary, @activeThreads, @maxId, @ts)
  ON CONFLICT(open_id) DO UPDATE SET
    recent_summary = COALESCE(excluded.recent_summary, companion_context.recent_summary),
    active_threads_json = COALESCE(excluded.active_threads_json, companion_context.active_threads_json),
    last_summarized_turn_id = excluded.last_summarized_turn_id,
    updated_at = excluded.updated_at
  WHERE excluded.last_summarized_turn_id >= COALESCE(companion_context.last_summarized_turn_id, 0)
`);
export function getContext(openId) {
  const row = db.prepare(`SELECT * FROM companion_context WHERE open_id=?`).get(openId);
  if (!row) return { recentSummary: '', activeThreads: [] };
  let threads = [];
  try { threads = row.active_threads_json ? JSON.parse(row.active_threads_json) : []; } catch { /* ignore */ }
  return { recentSummary: row.recent_summary || '', activeThreads: threads, updatedAt: row.updated_at };
}
/**
 * 更新关系上下文（distill/compact 的落点）。水位 last_summarized_turn_id 显式传入更准
 * （distill 应传"读 history 时捕获的 turn id"，而非当前 max——防 await 期间的新轮被误标）。
 */
export function updateContext(openId, { recentSummary = null, activeThreads = null, lastSummarizedTurnId = null } = {}) {
  _upsertContext.run({
    openId,
    recentSummary,
    activeThreads: activeThreads ? JSON.stringify(activeThreads) : null,
    maxId: lastSummarizedTurnId ?? _maxTurnId.get(openId).m,
    ts: now(),
  });
}

// ── agent 便笺（小合自己掌管、自由改写、每轮注入的持久上下文区）──
export function getAgentNote(openId) {
  const r = db.prepare(`SELECT agent_note FROM companion_context WHERE open_id=?`).get(openId);
  return r?.agent_note || '';
}
/** 小合改写便笺（overwrite）。空串=清空。持久化，重启不丢，改动前一直生效。 */
export function setAgentNote(openId, content) {
  db.prepare(`
    INSERT INTO companion_context (open_id, agent_note, updated_at)
    VALUES (@openId, @note, COALESCE((SELECT updated_at FROM companion_context WHERE open_id=@openId), @ts))
    ON CONFLICT(open_id) DO UPDATE SET agent_note = @note
  `).run({ openId, note: content ?? '', ts: now() });
}

// ── distill 尝试/失败追踪（F3：防蒸馏失败每分钟无限重试烧 token）──
export function markDistillAttempt(openId) {
  db.prepare(`
    INSERT INTO companion_context (open_id, last_distill_attempt_at, updated_at)
    VALUES (@openId, @ts, COALESCE((SELECT updated_at FROM companion_context WHERE open_id=@openId), @ts))
    ON CONFLICT(open_id) DO UPDATE SET last_distill_attempt_at = @ts
  `).run({ openId, ts: now() });
}
export function markDistillResult(openId, ok) {
  db.prepare(`UPDATE companion_context SET distill_failures = CASE WHEN @ok THEN 0 ELSE distill_failures + 1 END WHERE open_id=@openId`)
    .run({ openId, ok: ok ? 1 : 0 });
}

/**
 * 待蒸馏候选：已静默（last_active 早于 idle 阈值）且自上次蒸馏后有新对话
 * （last_user_at 晚于 context.updated_at，或还没蒸过）。返回 openId 数组。
 */
export function listDistillCandidates(idleMs, retryMs = 30 * 60 * 1000) {
  const cutoff = new Date(Date.now() - idleMs).toISOString();
  const retryCutoff = new Date(Date.now() - retryMs).toISOString();
  // "有新料"用 last_summarized_turn_id 判（不受 markDistillAttempt 触碰 updated_at 影响）；
  // 失败后靠 last_distill_attempt_at 的重试窗排除，避免每分钟无限重蒸。
  const rows = db.prepare(`
    SELECT p.open_id
    FROM companion_people p
    LEFT JOIN companion_context c ON c.open_id = p.open_id
    WHERE p.last_active_at IS NOT NULL
      AND p.last_active_at < @cutoff
      AND (c.last_distill_attempt_at IS NULL OR c.last_distill_attempt_at < @retryCutoff)
      AND EXISTS (
        SELECT 1 FROM companion_turns t
        WHERE t.open_id = p.open_id AND t.id > COALESCE(c.last_summarized_turn_id, 0)
      )
  `).all({ cutoff, retryCutoff });
  return rows.map(r => r.open_id);
}

// ── 主动关心钩子（C6/C7）──
let _hookSeq = 0;
function hookId() { return `hk_${Date.now().toString(36)}_${(_hookSeq++).toString(36)}`; }

const RECUR_MS = { daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000 };
const VALID_RECURRENCES = new Set(Object.keys(RECUR_MS));

const _insHook = db.prepare(`
  INSERT INTO companion_hooks (id, open_id, kind, fire_at, status, payload_json, recurrence, recurrence_anchor, created_at)
  VALUES (@id, @openId, @kind, @fireAt, 'active', @payload, @recurrence, @recurrenceAnchor, @ts)
`);
/** 建一个主动关心钩子。payload 携带执行所需上下文（跟进啥/当时说了啥）。recurrence: null/'daily'/'weekly'。返回 hookId。 */
export function createHook(openId, { kind = 'custom', fireAt, payload = {}, recurrence = null }) {
  const id = hookId();
  const recur = VALID_RECURRENCES.has(recurrence) ? recurrence : null;
  // 周期钩子记下原始锚点：之后 defer 只动 fire_at，滚下一次时从锚点算，不让"每天9点"被延后污染成"每天10点"
  _insHook.run({ id, openId, kind, fireAt, payload: JSON.stringify(payload || {}), recurrence: recur, recurrenceAnchor: recur ? fireAt : null, ts: now() });
  return id;
}

/**
 * 周期钩子发完后滚到下一次（保持 active，不置 fired 终态）。北京固定 UTC+8 无 DST，
 * 加固定毫秒即可保持同一本地时刻。**从原始锚点算**（fire_at 可能被 defer 临时改过），防时刻漂移。
 * 落后于现在则快进到下一个未来时刻（不补发一堆过去的）。返回下一次 fire_at（非法返回 null）。
 */
export function advanceRecurringHook(openId, id, recurrence, prevFireAtIso, anchorIso = null) {
  const step = RECUR_MS[recurrence];
  if (!step) return null;
  const anchorMs = Date.parse(anchorIso || prevFireAtIso);
  if (!Number.isFinite(anchorMs)) return null;
  let next = anchorMs;
  const nowMs = Date.now();
  do { next += step; } while (next <= nowMs);
  const nextIso = new Date(next).toISOString();
  const anchor = new Date(anchorMs).toISOString();
  const res = db.prepare(`UPDATE companion_hooks SET fire_at=?, fired_at=?, skip_reason=NULL, recurrence_anchor=COALESCE(recurrence_anchor, ?) WHERE open_id=? AND id=? AND status='active'`)
    .run(nextIso, now(), anchor, openId, id);
  return res.changes > 0 ? nextIso : null;
}
/** 到点待发的 active 钩子。 */
export function listDueHooks(nowIso = now()) {
  return db.prepare(
    `SELECT * FROM companion_hooks WHERE status='active' AND fire_at <= ? ORDER BY fire_at LIMIT 50`
  ).all(nowIso).map(h => { try { h.payload = JSON.parse(h.payload_json || '{}'); } catch { h.payload = {}; } return h; });
}
/** 某人当前挂着的 active 钩子（给小合注入上下文用：防重复设 + 能引用/撤销）。 */
export function listActiveHooks(openId, limit = 10) {
  return db.prepare(
    `SELECT id, kind, fire_at, payload_json, recurrence FROM companion_hooks WHERE open_id=? AND status='active' ORDER BY fire_at LIMIT ?`
  ).all(openId, limit).map(h => { try { h.payload = JSON.parse(h.payload_json || '{}'); } catch { h.payload = {}; } return h; });
}

/** UTC ISO → 北京时间简述（跟 user turn 里的当前时间对齐，别让小合按 UTC 误解）。 */
function beijingBrief(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/** 渲染小合已挂钩子的简述，注入 user turn，让它知道自己记着啥（防重复 + 可撤/可提）。为空返回 ''。 */
export function renderActiveHooks(openId) {
  const hooks = listActiveHooks(openId);
  if (!hooks.length) return '';
  const recurLabel = { daily: '每天', weekly: '每周' };
  // 只列条目；"别重复设 / cancel_reminder 撤 / hk_ 别念出来"的规则已在 system 解码契约里说过，不重复。
  const lines = hooks.map(h => {
    const when = h.fire_at ? beijingBrief(h.fire_at) : '';
    const recur = recurLabel[h.recurrence] ? `${recurLabel[h.recurrence]} ` : '';
    return `- [${h.id}] ${h.payload?.about || h.kind}${when ? `（${recur}约 ${when}，北京时间）` : ''}`;
  });
  return lines.join('\n');
}

// 后台钩子状态更新一律带 open_id owner 校验（跟 cancelHook 一致）——防御式，避免误传别人 id 改到别人的钩子。
export function markHookFired(openId, id) {
  return db.prepare(`UPDATE companion_hooks SET status='fired', fired_at=? WHERE open_id=? AND id=?`).run(now(), openId, id).changes > 0;
}
export function markHookSkipped(openId, id, reason) {
  return db.prepare(`UPDATE companion_hooks SET status='skipped', skip_reason=?, fired_at=? WHERE open_id=? AND id=?`).run(reason || '', now(), openId, id).changes > 0;
}
/** transient 原因（静默/冷却/发送失败等）：改 fire_at 延后重试，保持 active，别永久 skip。 */
export function deferHook(openId, id, reason, fireAtIso) {
  return db.prepare(`UPDATE companion_hooks SET fire_at=?, skip_reason=? WHERE open_id=? AND id=? AND status='active'`)
    .run(fireAtIso, reason || '', openId, id).changes > 0;
}
/** 撤销一个人自己的 active 钩子；越权/不存在返回 false（不改别人的钩子）。 */
export function cancelHook(openId, id) {
  const res = db.prepare(`UPDATE companion_hooks SET status='cancelled' WHERE open_id=? AND id=? AND status='active'`).run(openId, id);
  return res.changes > 0;
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
 * 渲染 <relationship> 块的「最近关系状态」短文（带日期小结 + 没聊完的话头）。为空返回 ''。
 */
export function renderPersonalContext(openId) {
  const ctx = getContext(openId);
  const person = getPerson(openId);
  const parts = [];
  if (person?.last_user_at) {
    const days = Math.floor((Date.now() - Date.parse(person.last_user_at)) / 86400000);
    if (days >= 1) parts.push(`（你们上次聊已经是 ${days} 天前了。）`);
  }
  if (ctx.recentSummary) {
    // 给小结标日期，让模型分清"在赶项目"是昨天还是上周的事（避免把陈旧状态当此刻）
    const dateLabel = beijingDateLabel(ctx.updatedAt);
    parts.push(dateLabel ? `（截至 ${dateLabel}的小结）${ctx.recentSummary}` : ctx.recentSummary);
  }
  if (ctx.activeThreads?.length) parts.push(`还没聊完的：${ctx.activeThreads.map(t => `「${t}」`).join('、')}`);
  return parts.join('\n');
}
