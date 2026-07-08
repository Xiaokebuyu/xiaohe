/**
 * 陪伴记忆工具 —— 让小合在对话中主动记下关于这个人的事（不只等会话结束蒸馏）
 *
 * 复用现有 memory/index.js 的存储（per-user markdown / Public·Private 分段 / 大小上限 / 写锁）。
 * 陪伴专用分段（人物画像/相处偏好/近期状态/待跟进/重要日期/约定与边界/情绪与支持方式/笔记）
 * 靠 upsertSection（整段替换）或 appendTimestampedNote（追加带日期的一行）落进对应 segment。
 */

import { defineTool } from '../tool.js';
import {
  loadUserMemory, saveUserMemory, checkSizeLimit,
  upsertSection, parseSegments, composeSegments,
} from '../../memory/index.js';
import { formatBeijingNow } from '../../util/time.js';

/** 陪伴分段：整段替换型（画像类，upsert）vs 追加型（动态类，append 带日期） */
const UPSERT_SECTIONS = new Set(['人物画像', '相处偏好', '约定与边界', '情绪与支持方式']);
const APPEND_SECTIONS = new Set(['近期状态', '待跟进', '重要日期', '笔记']);
const ALL_SECTIONS = [...UPSERT_SECTIONS, ...APPEND_SECTIONS];

/** 追加一行带日期的短笔记到任意命名 section（通用化 appendNote，支持非「笔记」段）。 */
function appendTimestampedNote(content, { section, note, segment = 'private' }) {
  const { today } = formatBeijingNow();
  const line = `- [${today}] ${note.trim()}`;
  const segs = parseSegments(content);
  const target = segs[segment] || '';
  const header = `### ${section}`;
  const esc = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|\\n)${esc}\\n([\\s\\S]*?)(?=\\n### |$)`);
  let updated;
  if (re.test(target)) {
    updated = target.replace(re, (_m, pre, body) => `${pre}${header}\n${body.trim()}\n${line}`);
  } else {
    updated = target.trim() ? `${target.trim()}\n\n${header}\n${line}` : `${header}\n${line}`;
  }
  return composeSegments({ ...segs, [segment]: updated });
}

export const rememberAboutPersonTool = defineTool({
  name: 'remember_about_person',
  description:
    '记住关于当前对话对象的重要事情，方便以后还记得他。只记未来对陪伴有用的：心情/近况、'
    + '相处偏好、你们的约定、待跟进的事、重要日期、他不希望被打扰的边界。别把每句话都记，只记值得记的。',
  inputSchema: {
    type: 'object',
    properties: {
      section: { type: 'string', enum: ALL_SECTIONS, description: '记到哪个分段' },
      content: { type: 'string', description: '要记的内容，一句话讲清' },
      segment: { type: 'string', enum: ['public', 'private'], description: '公开画像还是私密（默认私密）' },
    },
    required: ['section', 'content'],
  },
  scope: 'memory',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async checkPermissions(input, ctx) {
    if (!ctx.openId) return { behavior: 'deny', message: '记忆写入需要 openId（私聊场景）' };
    return { behavior: 'allow', updatedInput: input };
  },
  async call(input, ctx) {
    const segment = input.segment || 'private';
    const mem = await loadUserMemory(ctx.openId, ctx.boundUser);
    const next = UPSERT_SECTIONS.has(input.section)
      ? upsertSection(mem.content, { section: input.section, body: input.content, segment })
      : appendTimestampedNote(mem.content, { section: input.section, note: input.content, segment });

    const sz = checkSizeLimit(next);
    if (sz.overHard) {
      return { ok: false, error: { category: 'memory_limit', retryable: false, message: '记忆超过硬上限，先整理再记' } };
    }
    await saveUserMemory(ctx.openId, ctx.boundUser, next);
    return { ok: true, section: input.section, sizeBytes: sz.sizeBytes, overSoft: sz.overSoft };
  },
});
