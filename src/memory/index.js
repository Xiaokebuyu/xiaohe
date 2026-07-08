/**
 * 小合跨会话记忆系统（per-user markdown）
 *
 * 设计要点：
 *   - 双键存储：_index.json 映射 openId → username，未绑定回落 openId
 *   - Public / Private 分段（LLM 写入时自判）：群聊只注入 Public，私聊全量
 *   - 展示给用户（"你记得我什么"）永远只给 Public，保留神秘感
 *   - 软上限 16KB / 硬上限 32KB；超硬拒写，超软下次写入前 LLM 自行整理
 *   - 文件 IO 并发：per-key mutex（防并发写 corrupt）
 *
 * 目录：
 *   server/bot/memory/
 *     _index.json                # { [openId]: { username?, lastSeen } }
 *     user-{username}.md         # 已绑定用户
 *     anon-{openId}.md           # 未绑定用户
 */

import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { formatBeijingNow } from '../util/time.js';

const MEMORY_DIR = join(dirname(fileURLToPath(import.meta.url)));
const INDEX_PATH = join(MEMORY_DIR, '_index.json');

export const MEMORY_SIZE_SOFT_LIMIT = 16 * 1024;
export const MEMORY_SIZE_HARD_LIMIT = 32 * 1024;

export const PUBLIC_HEADER = '## 👥 Public';
export const PRIVATE_HEADER = '## 🔒 Private';

/** per-key 写锁（防并发） */
const lockMap = new Map();

async function withLock(key, fn) {
  const prev = lockMap.get(key) || Promise.resolve();
  let release;
  const next = new Promise(r => { release = r; });
  // 保留 chain 的引用以便 GC 判断——旧实现用 next.then(()=>{}) 每次返回新 Promise，
  // 比较永不命中，lockMap 永不 shrink，长期跑下来内存泄漏（key 随 openId 线性增长）。
  const chain = prev.then(() => next);
  lockMap.set(key, chain);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (lockMap.get(key) === chain) lockMap.delete(key);
  }
}

// ──────────────────────────────────────────────────────────
//  _index.json：openId ↔ username 映射
// ──────────────────────────────────────────────────────────

/**
 * 原子写文件：tmp 文件落盘后 rename 覆盖目标，同 FS 下 rename 原子
 * 防 OS 崩溃 / SIGKILL 中途截断导致 JSON.parse / md 读取永久报错
 */
async function atomicWriteFile(targetPath, content) {
  await fs.mkdir(dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, content, 'utf8');
  try {
    await fs.rename(tmp, targetPath);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

async function readIndex() {
  try {
    const raw = await fs.readFile(INDEX_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    if (err instanceof SyntaxError) {
      // _index.json 损坏（上次写入被截断 / 磁盘故障）。备份原文件、从空索引重建，
      // 避免所有用户的 memory 读取永久炸在 JSON.parse
      const backup = `${INDEX_PATH}.corrupt.${Date.now()}`;
      console.error(`[Memory] _index.json 损坏，备份到 ${backup} 后从空索引重建:`, err.message);
      await fs.rename(INDEX_PATH, backup).catch(e =>
        console.warn('[Memory] 备份 _index.json 失败:', e.message)
      );
      return {};
    }
    throw err;
  }
}

async function writeIndex(idx) {
  await atomicWriteFile(INDEX_PATH, JSON.stringify(idx, null, 2));
}

const INDEX_LOCK_KEY = '__index__';

/**
 * 解析 openId → 实际存储 key（username 或 anon-openId）
 * boundUser 存在则优先用 username，否则 fallback openId
 * 副作用：更新 _index.json 的 lastSeen + username
 *
 * 用 INDEX_LOCK_KEY 全局串化 read-modify-write：并发 chat 的多个 resolveKey
 * 交错执行会丢失部分 openId 映射，极端情况 writeFile 交错破坏 JSON。
 */
async function resolveKey(openId, boundUser) {
  return withLock(INDEX_LOCK_KEY, async () => {
    const idx = await readIndex();
    const prev = idx[openId] || {};
    const username = boundUser?.username || prev.username || null;

    idx[openId] = {
      ...prev,
      ...(username ? { username } : {}),
      lastSeen: new Date().toISOString(),
    };
    await writeIndex(idx);

    return {
      key: username ? `user-${username}` : `anon-${openId}`,
      isAnon: !username,
      username,
    };
  });
}

function pathOf(key) {
  return join(MEMORY_DIR, `${key}.md`);
}

// ──────────────────────────────────────────────────────────
//  读 / 写
// ──────────────────────────────────────────────────────────

/**
 * 读取用户的 memory（完整 markdown）
 * @returns {{ path, content, sizeBytes, isAnon, key, username }}
 */
export async function loadUserMemory(openId, boundUser = null) {
  const { key, isAnon, username } = await resolveKey(openId, boundUser);
  const p = pathOf(key);
  let content = '';
  try {
    content = await fs.readFile(p, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return {
    path: p,
    content,
    sizeBytes: Buffer.byteLength(content, 'utf8'),
    isAnon,
    key,
    username,
  };
}

/**
 * 直接按 username 读 user-{username}.md —— 给 runPatrol 等
 * "不在当前对话 session、但要引用某人画像"的场景用。
 * 不走 _index.json，不触发 lastSeen 更新。
 */
export async function loadUserMemoryByUsername(username) {
  if (!username) return '';
  try {
    return await fs.readFile(pathOf(`user-${username}`), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

/**
 * 写入用户的 memory（整文件覆盖）
 * 调用方通常先 loadUserMemory 拿到 content，改完再 save
 */
export async function saveUserMemory(openId, boundUser, content) {
  const { key, isAnon, username } = await resolveKey(openId, boundUser);
  const sizeBytes = Buffer.byteLength(content, 'utf8');

  if (sizeBytes > MEMORY_SIZE_HARD_LIMIT) {
    throw new Error(`memory 超过硬上限 ${MEMORY_SIZE_HARD_LIMIT} 字节，请先删减再写入`);
  }

  await withLock(key, async () => {
    await atomicWriteFile(pathOf(key), content);
  });

  return {
    path: pathOf(key),
    sizeBytes,
    overSoft: sizeBytes > MEMORY_SIZE_SOFT_LIMIT,
    isAnon,
    key,
    username,
  };
}

// ──────────────────────────────────────────────────────────
//  Public / Private 分段
// ──────────────────────────────────────────────────────────

/**
 * 把 markdown 按 Public/Private header 切块
 * 未标注的内容视为 Public（宽松）
 * @returns {{ public: string, private: string, raw: string }}
 */
export function parseSegments(content = '') {
  if (!content.trim()) return { public: '', private: '', raw: content };

  const pubIdx = content.indexOf(PUBLIC_HEADER);
  const priIdx = content.indexOf(PRIVATE_HEADER);

  if (pubIdx === -1 && priIdx === -1) {
    return { public: content.trim(), private: '', raw: content };
  }

  const slices = [];
  if (pubIdx !== -1) slices.push({ type: 'public', start: pubIdx });
  if (priIdx !== -1) slices.push({ type: 'private', start: priIdx });
  slices.sort((a, b) => a.start - b.start);

  const segments = { public: '', private: '' };
  for (let i = 0; i < slices.length; i++) {
    const { type, start } = slices[i];
    const end = i + 1 < slices.length ? slices[i + 1].start : content.length;
    const header = type === 'public' ? PUBLIC_HEADER : PRIVATE_HEADER;
    segments[type] = content.slice(start + header.length, end).trim();
  }
  return { ...segments, raw: content };
}

/**
 * 重建完整 markdown（Public 段 + Private 段）
 */
export function composeSegments({ public: pub = '', private: pri = '' } = {}) {
  const parts = [];
  if (pub.trim()) parts.push(`${PUBLIC_HEADER}\n${pub.trim()}`);
  if (pri.trim()) parts.push(`${PRIVATE_HEADER}\n${pri.trim()}`);
  return parts.join('\n\n') + '\n';
}

/**
 * 给 LLM 注入用的文本：
 *   - chatType === 'p2p' → 全量（Public + Private）
 *   - 其他（group/chat） → 仅 Public
 * 空 memory 返回空字符串（上层自行判断要不要注入）
 */
export function renderForInjection({ content, chatType }) {
  if (!content?.trim()) return '';
  const segs = parseSegments(content);
  if (chatType === 'p2p') {
    const parts = [];
    if (segs.public.trim()) parts.push(`### 👥 公开画像\n${segs.public.trim()}`);
    if (segs.private.trim()) parts.push(`### 🔒 私密画像（仅当前私聊可见）\n${segs.private.trim()}`);
    return parts.join('\n\n');
  }
  // 群聊/未知：只给 Public
  return segs.public.trim() ? `### 👥 公开画像\n${segs.public.trim()}` : '';
}

/**
 * 给用户自己看的文本（小合回答"你记得我什么"用）
 * 方案 B：只展示 Public，Private 永不外露——神秘感 ✨
 */
export function renderForDisplay(content) {
  if (!content?.trim()) return '（我对你还没有任何记忆，随便聊聊让我认识你吧～）';
  const segs = parseSegments(content);
  return segs.public.trim() || '（目前只有一些私密画像，公开段还没攒起来）';
}

/**
 * 容量检查
 */
export function checkSizeLimit(content) {
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  return {
    sizeBytes,
    overSoft: sizeBytes > MEMORY_SIZE_SOFT_LIMIT,
    overHard: sizeBytes > MEMORY_SIZE_HARD_LIMIT,
  };
}

// ──────────────────────────────────────────────────────────
//  段落级 CRUD（给 memory tools 用）
// ──────────────────────────────────────────────────────────

/**
 * 更新一个命名 section：在指定 segment（public/private）里 upsert
 * sectionName 不含 "## "，工具调用时用裸名字（如 "画像" "协作偏好"）
 */
export function upsertSection(content, { section, body, segment = 'public' }) {
  const segs = parseSegments(content);
  const target = segs[segment] || '';
  const sectionHeader = `### ${section}`;

  // 不能带 'm' flag：m 下 $ 匹配每行末尾，non-greedy 会在第一行末就 stop，
  // 导致 update 已有多行段落时只替换第一行。无 m 时 $ = 字符串末尾，(^|\n) 已处理首行边界。
  const re = new RegExp(`(^|\\n)${escapeRegex(sectionHeader)}[^\\n]*\\n[\\s\\S]*?(?=\\n### |$)`);
  const newSection = `${sectionHeader}\n${body.trim()}`;

  let updatedTarget;
  if (re.test(target)) {
    updatedTarget = target.replace(re, (match, pre) => `${pre}${newSection}`);
  } else {
    updatedTarget = target.trim() ? `${target.trim()}\n\n${newSection}` : newSection;
  }

  return composeSegments({ ...segs, [segment]: updatedTarget });
}

export function removeSection(content, { section }) {
  const segs = parseSegments(content);
  const sectionHeader = `### ${section}`;
  // 保留 g flag 以便 replace 扫描两个 segment 的所有命中；去掉 m 原因同 upsertSection
  const re = new RegExp(`(^|\\n)${escapeRegex(sectionHeader)}[^\\n]*\\n[\\s\\S]*?(?=\\n### |$)`, 'g');

  const stripped = {
    public: (segs.public || '').replace(re, '').trim(),
    private: (segs.private || '').replace(re, '').trim(),
  };
  return composeSegments(stripped);
}

/**
 * 追加一行带时间戳的短笔记到指定 segment 的 "笔记" section
 */
export function appendNote(content, { note, segment = 'public' }) {
  const { today } = formatBeijingNow();
  const line = `- [${today}] ${note.trim()}`;
  const segs = parseSegments(content);
  const target = segs[segment] || '';

  const notesHeader = '### 笔记';
  // 同样不带 'm' flag：否则 body 捕获只到第一行，每次追加都会丢失历史笔记
  const re = new RegExp(`(^|\\n)${escapeRegex(notesHeader)}\\n([\\s\\S]*?)(?=\\n### |$)`);
  let updatedTarget;
  if (re.test(target)) {
    updatedTarget = target.replace(re, (_m, pre, body) => `${pre}${notesHeader}\n${body.trim()}\n${line}`);
  } else {
    updatedTarget = target.trim() ? `${target.trim()}\n\n${notesHeader}\n${line}` : `${notesHeader}\n${line}`;
  }
  return composeSegments({ ...segs, [segment]: updatedTarget });
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ──────────────────────────────────────────────────────────
//  anon → user 迁移（绑定时用，T11 接入）
// ──────────────────────────────────────────────────────────

/**
 * 绑定成功时把 anon-{openId}.md 迁移成 user-{username}.md
 * 若两者都存在则合并（anon 的内容 append 到 user 的对应段末尾）
 *
 * 幂等：写入 merged 内容时带 `<!-- migrated_from: anon-xxx -->` 标记，
 * 若 unlink 失败、下次重试看到同标记就跳过合并，避免画像重复。
 */
export async function migrateAnonToUser(openId, username) {
  const anonKey = `anon-${openId}`;
  const userKey = `user-${username}`;
  const anonPath = pathOf(anonKey);
  const userPath = pathOf(userKey);
  const migrateMarker = `<!-- migrated_from: ${anonKey} -->`;

  // 同一把锁覆盖 index read-modify-write + user 文件写入
  async function updateIndex() {
    await withLock(INDEX_LOCK_KEY, async () => {
      const idx = await readIndex();
      idx[openId] = { ...(idx[openId] || {}), username, lastSeen: new Date().toISOString() };
      await writeIndex(idx);
    });
  }

  // 整段 read-check-merge-write 进 anonKey 锁：防两个并发 bind（双击 / admin 重绑）
  // 都读到同份 anon 内容、都 merge 一遍 → user 段重复
  const result = await withLock(anonKey, async () => {
    let anonContent = '';
    let userContent = '';
    try { anonContent = await fs.readFile(anonPath, 'utf8'); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    try { userContent = await fs.readFile(userPath, 'utf8'); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }

    if (!anonContent) {
      return { migrated: false, reason: 'no anon memory' };
    }

    // 若 user 文件里已有本次迁移标记 → 先前合并过，anon 文件是残留，直接 unlink
    if (userContent.includes(migrateMarker)) {
      await fs.unlink(anonPath).catch(err => console.warn('[Memory] 清理残留 anon 失败:', err.message));
      return { migrated: false, reason: 'already merged' };
    }

    // 合并策略：anon 的 Public/Private 分别 append 到 user 对应段
    const aSeg = parseSegments(anonContent);
    const uSeg = parseSegments(userContent);
    const merged = migrateMarker + '\n' + composeSegments({
      public: [uSeg.public, aSeg.public].filter(Boolean).join('\n\n'),
      private: [uSeg.private, aSeg.private].filter(Boolean).join('\n\n'),
    });

    await atomicWriteFile(userPath, merged);
    await fs.unlink(anonPath).catch(err => console.warn('[Memory] unlink anon 失败（已带幂等标记，下次启动会清理）:', err.message));

    return { migrated: true, from: anonPath, to: userPath };
  });

  await updateIndex();
  return result;
}
