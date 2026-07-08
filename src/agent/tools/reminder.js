/**
 * 主动关心钩子工具 —— 小合可**自主**设/撤跟进钩子，持久化到 companion_hooks（SQLite，重启不丢）。
 *
 * set_reminder：不只是用户点名"提醒我"才用。你察觉到值得挂心的事——他提到的大事（面试/手术/汇报）、
 *   在焦虑的事、许下的约定——就主动设一个跟进钩子，自己推断个合适的时间。**克制在发送端**：到点会
 *   再判"此刻打扰合不合适"，所以你设的时候可以大方，把他的事放心上。
 * cancel_reminder：不需要跟进了就撤（上下文里会给你当前挂着的钩子和它们的 id）。
 */
import { defineTool } from '../tool.js';
import { createHook, cancelHook } from '../../companion/store.js';

export const setReminderTool = defineTool({
  name: 'set_reminder',
  description:
    '设一个"以后主动关心/跟进"的钩子（持久化）。两种时机都用：①用户明确让你提醒；'
    + '②你自己察觉到值得跟进的事（他提到的大事/在担心的事/约定），主动挂上，不用等他开口。'
    + '时间自己按当前时间推断（如"他明天下午面试"→挂到明天傍晚）。到点会再判该不该真发，所以放心设。',
  inputSchema: {
    type: 'object',
    properties: {
      fire_at: { type: 'string', description: '触发时间，ISO 8601 带时区（如 2026-07-09T18:00:00+08:00）。按当前时间和事情推断。' },
      about: { type: 'string', description: '要跟进/关心的事，一句话（如"他今天的面试"）' },
      note: { type: 'string', description: '可选，额外上下文，帮你到时候说得贴切' },
      source: { type: 'string', enum: ['autonomous', 'user_requested'], description: '你自己想起来设的填 autonomous；用户明确让你提醒的填 user_requested' },
    },
    required: ['fire_at', 'about'],
  },
  scope: 'reminder',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async checkPermissions(input, ctx) {
    if (!ctx.openId) return { behavior: 'deny', message: '设提醒需要 openId' };
    const fireMs = Date.parse(input.fire_at || '');
    if (!Number.isFinite(fireMs)) return { behavior: 'deny', message: 'fire_at 必须是可解析的 ISO 8601 时间（带时区）' };
    if (fireMs <= Date.now() + 60_000) return { behavior: 'deny', message: 'fire_at 不能是过去或一分钟内的时间' };
    return { behavior: 'allow', updatedInput: { ...input, fire_at: new Date(fireMs).toISOString() } };
  },
  async call(input, ctx) {
    const id = createHook(ctx.openId, {
      kind: 'followup',
      fireAt: input.fire_at,
      payload: { about: input.about, note: input.note || '', source: input.source || 'autonomous' },
    });
    return { ok: true, hook_id: id, fire_at: input.fire_at, note: `已记下「${input.about}」，到时候我会主动问问` };
  },
});

export const cancelReminderTool = defineTool({
  name: 'cancel_reminder',
  description: '撤掉一个已挂的跟进钩子（不需要跟进了、或用户说不用了）。hook_id 从上下文里"你已经记着要跟进"那段拿。',
  inputSchema: {
    type: 'object',
    properties: { hook_id: { type: 'string', description: '要撤的钩子 id（形如 hk_xxx）' } },
    required: ['hook_id'],
  },
  scope: 'reminder',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async checkPermissions(input, ctx) {
    if (!ctx.openId) return { behavior: 'deny', message: '撤提醒需要 openId' };
    if (!/^hk_/.test(input.hook_id || '')) return { behavior: 'deny', message: 'hook_id 格式不对' };
    return { behavior: 'allow', updatedInput: input };
  },
  async call(input) {
    cancelHook(input.hook_id);
    return { ok: true, note: '好，那件事我就不记着了' };
  },
});
