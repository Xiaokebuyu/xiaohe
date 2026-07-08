/**
 * set_reminder —— 让小合按用户的话设一个"以后主动关心/跟进"的钩子，钩子带上下文。
 * 例："记得明天面试完问问我怎么样" / "周五提醒我交方案"。到点由主动关心调度器判要不要发、说什么。
 *
 * 时间由模型算成 ISO 8601（当前时间在 user turn 里给了它）。上下文放 about/note，供到点时组织话术。
 */
import { defineTool } from '../tool.js';
import { createHook } from '../../companion/store.js';

export const setReminderTool = defineTool({
  name: 'set_reminder',
  description:
    '当用户希望你以后主动关心/跟进某件事时，设一个提醒钩子。'
    + '到点你会（在合适的时机、不打扰的前提下）主动私聊他。只在用户明确表达"以后提醒我/到时候问问我"这类意图时用。',
  inputSchema: {
    type: 'object',
    properties: {
      fire_at: { type: 'string', description: '触发时间，ISO 8601 带时区（如 2026-07-09T10:00:00+08:00）。根据当前时间和用户说的时间算。' },
      about: { type: 'string', description: '关心/跟进的事，一句话（如"他今天的面试"）' },
      note: { type: 'string', description: '可选，额外上下文，帮你到时候说得贴切' },
    },
    required: ['fire_at', 'about'],
  },
  scope: 'reminder',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async checkPermissions(input, ctx) {
    if (!ctx.openId) return { behavior: 'deny', message: '设提醒需要 openId' };
    if (!/^\d{4}-\d{2}-\d{2}T/.test(input.fire_at || '')) {
      return { behavior: 'deny', message: 'fire_at 必须是 ISO 8601 时间' };
    }
    return { behavior: 'allow', updatedInput: input };
  },
  async call(input, ctx) {
    const id = createHook(ctx.openId, {
      kind: 'followup',
      fireAt: input.fire_at,
      payload: { about: input.about, note: input.note || '' },
    });
    return { ok: true, hook_id: id, fire_at: input.fire_at, note: `已记下，到时候我会主动问问「${input.about}」` };
  },
});
