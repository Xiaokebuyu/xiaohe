/**
 * PermissionEngine — 全局权限闸门 + runMode 状态机（第二层，跟工具自带 checkPermissions 叠加）
 *
 * 两层模型：
 *   1. tool.checkPermissions(input, ctx)  —— 业务授权 / 所有权（ability 判定）
 *   2. engine.canUseTool(tool, input, ctx) —— 本轮 runMode + 用户确认
 *
 * runMode：
 *   readOnly       只放行只读工具（写工具直接 deny，模型收到解释）
 *   askWrites      读放行，写/外部副作用 → ask（step 2 接飞书审批 pause）
 *   allow          ability 通过即执行
 *   plan           只读工具 + request_task_approval；其他写工具 deny
 *   executingPlan  已批准计划内的写工具放行；破坏性操作仍 ask
 *
 * ⚠️ step 1 只实装 readOnly / allow 两态与两层叠加。ask → pause 的飞书审批回环在 step 2。
 * 关键设计（防死锁）：canUseTool 永不 await 用户。需要确认时返回 {behavior:'pause'}，
 * 由 Runner 保存 pending batch 并让本次 task 返回（释放 per-user mutex），按钮回调再 resume。
 */

export class PermissionEngine {
  /** @param {{ mode?: string }} [opts] */
  constructor({ mode = 'readOnly' } = {}) {
    this.mode = mode;
  }

  /**
   * @param {import('./tool.js').XiaoheTool} tool
   * @param {any} input
   * @param {import('./tool.js').XiaoheToolContext} ctx
   * @returns {Promise<{behavior:'allow',updatedInput:any}
   *                  | {behavior:'deny',message:string}
   *                  | {behavior:'pause',summary:object}>}
   */
  async canUseTool(tool, input, ctx) {
    // 第一层：工具自带业务授权
    const perTool = await tool.checkPermissions(input, ctx);
    if (perTool.behavior === 'deny') {
      return { behavior: 'deny', message: perTool.message || '无权执行该操作' };
    }
    const nextInput = perTool.updatedInput ?? input;

    const readOnly = tool.isReadOnly(nextInput, ctx);

    // 第二层：runMode 闸门
    switch (this.mode) {
      case 'allow':
        return { behavior: 'allow', updatedInput: nextInput };

      case 'readOnly':
      case 'plan':
        if (readOnly || tool.exposeInPlan) {
          return { behavior: 'allow', updatedInput: nextInput };
        }
        return {
          behavior: 'deny',
          message: `当前处于只读模式，不能执行写操作「${tool.name}」。`
            + `如需真正改动平台数据，请让管理员切到可写模式。`,
        };

      case 'askWrites':
      case 'executingPlan':
        if (readOnly) return { behavior: 'allow', updatedInput: nextInput };
        // step 2 实装：返回 pause，Runner 存 pending 并发审批卡
        return {
          behavior: 'pause',
          summary: tool.approvalSummary?.(nextInput, ctx)
            ?? { title: tool.name, lines: [JSON.stringify(nextInput).slice(0, 200)] },
        };

      case 'companion':
        // 陪伴模式：放行小合本地作用域工具（记忆 / 提醒 / 便笺）+ 只读工具；拒 panel/外部写
        if (['memory', 'reminder', 'note'].includes(tool.scope) && ctx.openId) {
          return { behavior: 'allow', updatedInput: nextInput };
        }
        if (readOnly) return { behavior: 'allow', updatedInput: nextInput };
        return { behavior: 'deny', message: '陪伴模式只允许记忆/提醒/便笺等本地操作，不碰平台或外部写。' };

      default:
        return { behavior: 'deny', message: `未知运行模式 ${this.mode}` };
    }
  }
}
