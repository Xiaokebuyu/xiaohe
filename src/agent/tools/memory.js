/**
 * 记忆工具（多级事件索引版）：
 *   remember     —— 在某主题下 upsert 一条记忆（事件/事实）；索引每轮注入。
 *   recall_memory —— 调某条正文，或按关键词搜（索引摘要不够时用）。
 *
 * 跟便笺（update_working_note）的区别：便笺=此刻自留的工作上下文（整段改写、临时）；
 * 记忆=关于这个人的长期事件/事实（结构化、分主题积累、按需展开）。
 */
import { defineTool } from '../tool.js';
import { ensureTopic, upsertEntry, getEntry, searchEntries } from '../../companion/memory-store.js';

export const rememberTool = defineTool({
  name: 'remember',
  description:
    '记住关于这个人的一件事（事件/事实/偏好/约定/近况），挂在一个主题下。'
    + '同一件事重复出现就更新（传 entry_id 或同标题会自动合并），别新建重复条目。'
    + '只记未来对陪伴有用、值得长期记的。日常琐碎、这轮聊完就没用的别记。',
  inputSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: '归到哪个主题（如 工作 / 健康 / 家人 / 情绪 / 生活 / 约定）。没有会新建。' },
      title: { type: 'string', description: '这条的短标题（如"在赶的项目"、"父亲住院"）' },
      summary: { type: 'string', description: '一句话摘要（进索引，每轮小合能看到）' },
      body: { type: 'string', description: '可选，更详细的内容（不进索引，按需 recall）' },
      salience: { type: 'integer', minimum: 1, maximum: 5, description: '重要度 1-5（默认 3；越重要越不会被裁剪）' },
      entry_id: { type: 'string', description: '可选，更新已有条目就传它的 id（me_xxx）' },
    },
    required: ['topic', 'title', 'summary'],
  },
  scope: 'memory',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async checkPermissions(input, ctx) {
    if (!ctx.openId) return { behavior: 'deny', message: '记忆需要 openId' };
    return { behavior: 'allow', updatedInput: input };
  },
  async call(input, ctx) {
    const parentId = ensureTopic(ctx.openId, input.topic);
    const id = upsertEntry(ctx.openId, {
      id: input.entry_id || null,
      parentId,
      title: input.title,
      summary: input.summary,
      body: input.body ?? null,          // 没传=保留原正文（别冲空）
      salience: input.salience ?? null,  // 没传=保留原重要度
    });
    return { ok: true, entry_id: id, topic: input.topic, note: `记下了「${input.title}」` };
  },
});

export const recallMemoryTool = defineTool({
  name: 'recall_memory',
  description: '调记忆细节：给 entry_id 看某条正文；或给 query 关键词搜相关条目。索引里的摘要不够、需要细节时用。',
  inputSchema: {
    type: 'object',
    properties: {
      entry_id: { type: 'string', description: '要看正文的条目 id（me_xxx）' },
      query: { type: 'string', description: '关键词搜索（不给 entry_id 时用）' },
    },
  },
  scope: 'memory',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async checkPermissions(input, ctx) {
    if (!ctx.openId) return { behavior: 'deny', message: '记忆需要 openId' };
    return { behavior: 'allow', updatedInput: input };
  },
  async call(input, ctx) {
    if (input.entry_id) {
      const e = getEntry(ctx.openId, input.entry_id);
      return e ? { ok: true, entry: { id: e.id, title: e.title, summary: e.summary, body: e.body } } : { ok: false, note: '没找到这条' };
    }
    if (input.query) {
      return { ok: true, matches: searchEntries(ctx.openId, input.query) };
    }
    return { ok: false, note: '给个 entry_id 或 query' };
  },
});
