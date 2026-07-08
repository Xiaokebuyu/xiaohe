/**
 * update_working_note —— 小合自己掌管的一块便笺。它改写里面的内容，从下一轮回复起这块就注入上下文，
 * 一直生效到它再改。持久化（companion_context.agent_note，重启不丢）。
 *
 * 跟 remember_about_person 的区别：记忆是"关于这个人的长期事实"（结构化、蒸馏、跨对话积累）；
 * 便笺是"小合此刻给自己留的话"（自由文本、随时整个重写、当前工作上下文）——比如此刻在留意他的什么、
 * 这段关系的当前基调、正在陪他走的一件事。它是给自己看的，不是发给用户的。
 */
import { defineTool } from '../tool.js';
import { setAgentNote } from '../../companion/store.js';

export const updateWorkingNoteTool = defineTool({
  name: 'update_working_note',
  description:
    '改写你自己的便笺（一块只有你看得到、每轮都会出现在你眼前的持久笔记）。'
    + '用来记你此刻对这个人/这段关系的判断和留意点——比如"他这阵子在赶项目、情绪紧绷，先多接住少建议"。'
    + '整段覆盖式改写；内容变了就更新，不需要了就写空。这不是发给用户的话。',
  inputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: '便笺的新全文（覆盖旧的）。留空字符串=清空便笺。' },
    },
    required: ['content'],
  },
  scope: 'note',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async checkPermissions(input, ctx) {
    if (!ctx.openId) return { behavior: 'deny', message: '改便笺需要 openId' };
    return { behavior: 'allow', updatedInput: input };
  },
  async call(input, ctx) {
    setAgentNote(ctx.openId, input.content || '');
    return { ok: true, note: '（便笺已更新，下一轮起生效）' };
  },
});
