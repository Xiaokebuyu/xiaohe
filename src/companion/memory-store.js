/**
 * 记忆：多级可更新事件索引（SQLite 条目树）。取代旧的扁平 markdown 记忆。
 *
 * 结构（照"我的记忆范式"）：
 *   - 顶层 = 主题（parent_id NULL）：工作 / 健康 / 家人 / 情绪 / 日常……
 *   - 子层 = 事件/事实条目（挂主题下，可再多级）：每条 title + summary + body + salience
 *   - 索引 = 主题 + 各条 title/summary，**每轮注入**（小合看到"我知道他哪些面"）
 *   - 正文 body 不全量注入，小合需要细节时 recall_memory 调出（像 Read 一个 topic 文件）
 * 日常聊天很碎 → 碎事件成一条条挂主题下，索引仍清爽；凌晨 compact 顺手合并同类碎条目。
 */
import db from '../db/index.js';

const now = () => new Date().toISOString();
let _seq = 0;
function entryId() { return `me_${Date.now().toString(36)}_${(_seq++).toString(36)}`; }
function isAfter(a, b) {
  const am = Date.parse(a || ''); const bm = Date.parse(b || '');
  return Number.isFinite(am) && Number.isFinite(bm) && am > bm;
}

const _get = db.prepare(`SELECT * FROM memory_entries WHERE open_id=? AND id=?`);
const _ins = db.prepare(`
  INSERT INTO memory_entries (id, open_id, parent_id, title, summary, body, salience, created_at, updated_at)
  VALUES (@id, @openId, @parentId, @title, @summary, @body, @salience, @ts, @ts)
`);
const _upd = db.prepare(`
  UPDATE memory_entries SET
    parent_id=COALESCE(@parentId, parent_id),
    title=COALESCE(@title, title),
    summary=COALESCE(@summary, summary),
    body=COALESCE(@body, body),
    salience=COALESCE(@salience, salience),
    updated_at=@ts
  WHERE open_id=@openId AND id=@id
`);

/** 按标题在某 parent 下找已有条目（去重/合并用）。 */
export function findByTitle(openId, title, parentId = null) {
  return db.prepare(
    `SELECT * FROM memory_entries WHERE open_id=? AND title=? AND IFNULL(parent_id,'')=IFNULL(?,'')`
  ).get(openId, title, parentId) || null;
}

/** 确保一个顶层主题存在，返回其 id（同名复用）。 */
export function ensureTopic(openId, title, summary = '') {
  const found = findByTitle(openId, title, null);
  if (found) return found.id;
  const id = entryId();
  _ins.run({ id, openId, parentId: null, title, summary, body: '', salience: 3, ts: now() });
  return id;
}

/**
 * upsert 一条记忆条目。给 id 则更新那条；否则在 (parentId, title) 上去重 upsert。
 * 更新语义：字段传 null/undefined = **保留原值**（COALESCE），只有显式传值才覆盖
 * （避免"没传 body"把已有正文冲成空）。
 * @returns {string} entry id
 */
export function upsertEntry(openId, { id = null, parentId = null, title = null, summary = null, body = null, salience = null, updatedBeforeIso = null }) {
  const existing = (id && _get.get(openId, id)) || (title ? findByTitle(openId, title, parentId) : null);
  if (existing) {
    // updatedBeforeIso：调用方（如 daily compact）读数据的时刻。若这条在那之后被更新过（用户实时 remember），
    // 说明有更新的内容，别用旧摘要盖回去——实时写赢。
    if (updatedBeforeIso && isAfter(existing.updated_at, updatedBeforeIso)) return existing.id;
    _upd.run({ openId, id: existing.id, parentId, title, summary, body, salience, ts: now() });
    return existing.id;
  }
  const newId = entryId();
  _ins.run({
    id: newId, openId, parentId,
    title: title ?? '(未命名)', summary: summary ?? '', body: body ?? '', salience: salience ?? 3,
    ts: now(),
  });
  return newId;
}

export function getEntry(openId, id) { return _get.get(openId, id) || null; }
/** 删一条及其整棵子树（多级嵌套也删干净，不留孙节点孤儿）。 */
export function deleteEntry(openId, id) {
  db.prepare(`
    WITH RECURSIVE sub(id) AS (
      SELECT id FROM memory_entries WHERE open_id=@openId AND id=@id
      UNION ALL
      SELECT m.id FROM memory_entries m JOIN sub ON m.parent_id = sub.id WHERE m.open_id=@openId
    )
    DELETE FROM memory_entries WHERE open_id=@openId AND id IN (SELECT id FROM sub)
  `).run({ openId, id });
}
export function listTopics(openId) {
  return db.prepare(`SELECT * FROM memory_entries WHERE open_id=? AND parent_id IS NULL ORDER BY salience DESC, updated_at DESC`).all(openId);
}
export function listChildren(openId, parentId) {
  return db.prepare(`SELECT * FROM memory_entries WHERE open_id=? AND parent_id=? ORDER BY salience DESC, updated_at DESC`).all(openId, parentId);
}

/** 简单关键词搜索（recall 用），标题/摘要/正文 LIKE。 */
export function searchEntries(openId, query, limit = 8) {
  const q = `%${(query || '').trim()}%`;
  return db.prepare(
    `SELECT id, parent_id, title, summary, salience FROM memory_entries
     WHERE open_id=? AND (title LIKE ? OR summary LIKE ? OR body LIKE ?)
     ORDER BY salience DESC, updated_at DESC LIMIT ?`
  ).all(openId, q, q, q, limit);
}

/**
 * 渲染注入 user turn 的记忆索引：主题树 + 各条 title/summary（不含 body）。
 * 有软上限，超了按 salience 截断并提示"更多可 recall"。为空返回 ''。
 */
export function renderMemoryIndex(openId, { maxChars = 3000 } = {}) {
  const topics = listTopics(openId);
  if (!topics.length) return '';
  const lines = [];
  for (const t of topics) {
    lines.push(`▍${t.title}${t.summary ? `：${t.summary}` : ''}`);
    for (const c of listChildren(openId, t.id)) {
      lines.push(`  · [${c.id}] ${c.title}${c.summary ? ` — ${c.summary}` : ''}`);
    }
  }
  let out = lines.join('\n');
  let truncated = false;
  if (out.length > maxChars) {
    // 按整行截断，不按字符硬切——否则可能把 "[me_xxx]" 切一半，模型看到残缺 id 后 recall 不到那条
    truncated = true;
    const kept = [];
    let acc = 0;
    for (const line of lines) {
      if (acc + line.length + 1 > maxChars) break;
      kept.push(line);
      acc += line.length + 1;
    }
    out = kept.join('\n');
  }
  return out + (truncated ? '\n（索引较长已截断；需要某条细节用 recall_memory 调正文。）' : '\n（这是索引；某条要看细节用 recall_memory 调正文。）');
}
