/**
 * Tool 抽象层 — 小合自己的工具接口（借 Claude Code 源码 Tool.ts 的设计，精简到 bot 场景）
 *
 * 跟旧 tools.js 扁平定义的区别：每个工具自带生命周期元信息（只读性 / 破坏性 / 并发安全 /
 * 权限判定 / 中断策略），engine 和 PermissionEngine 据此决策，而不是把权限埋在一个大 switch 里。
 *
 * 类型速览（JSDoc，运行时无 TS）：
 *
 * @typedef {Object} XiaoheToolContext
 * @property {string}  sessionId
 * @property {'p2p'|'group'} chatType
 * @property {string}  openId              发起人 open_id
 * @property {Object|null} boundUser       绑定的平台用户（null=未绑定）
 * @property {'readOnly'|'askWrites'|'allow'|'plan'|'executingPlan'} runMode
 * @property {AbortSignal} [signal]        工具执行超时/中断信号
 * @property {Object}  [chatContext]       透传给业务函数的原始 chat 上下文
 *
 * @typedef {{behavior:'allow', updatedInput?:any, reason?:string}
 *         | {behavior:'ask', message:string, reason?:string, updatedInput?:any}
 *         | {behavior:'deny', message:string, reason?:string}} PermissionDecision
 *
 * @typedef {Object} XiaoheTool
 * @property {string} name
 * @property {string} description
 * @property {Object} inputSchema                      JSON Schema（直接喂 Anthropic tools）
 * @property {(ctx:XiaoheToolContext)=>boolean} isEnabled
 * @property {(input:any, ctx:XiaoheToolContext)=>boolean} isReadOnly
 * @property {(input:any, ctx:XiaoheToolContext)=>boolean} isDestructive   不可逆（删/覆盖/外发）
 * @property {(input:any, ctx:XiaoheToolContext)=>boolean} isConcurrencySafe
 * @property {(input:any, ctx:XiaoheToolContext)=>'cancel'|'block'} interruptBehavior
 * @property {number} maxResultSizeChars               结果超此长度将落盘（step 5 实装）
 * @property {(input:any, ctx:XiaoheToolContext)=>{title:string,lines:string[]}} [approvalSummary]
 *           写工具发审批卡时的人话摘要（step 2 用）
 * @property {(input:any, ctx:XiaoheToolContext)=>Promise<void>} [validateInput]
 * @property {(input:any, ctx:XiaoheToolContext)=>Promise<PermissionDecision>} checkPermissions
 * @property {(input:any, ctx:XiaoheToolContext)=>Promise<any>} call
 */

/** 未指定字段时的默认值（保守：默认非只读 = 当写操作对待） */
const DEFAULTS = {
  isEnabled: () => true,
  isReadOnly: () => false,
  isDestructive: () => false,
  isConcurrencySafe: () => false,
  interruptBehavior: () => 'block',
  maxResultSizeChars: 80_000,
  async validateInput() {},
  async checkPermissions(input) {
    // 默认放行 —— 具体授权由工具自己覆盖或交给全局 PermissionEngine 按 runMode 兜底
    return { behavior: 'allow', updatedInput: input };
  },
};

/**
 * 定义一个工具。填必需字段（name/description/inputSchema/call），其余走默认。
 * @param {Partial<XiaoheTool> & Pick<XiaoheTool,'name'|'description'|'inputSchema'|'call'>} def
 * @returns {XiaoheTool}
 */
export function defineTool(def) {
  if (!def.name || !def.description || !def.inputSchema || typeof def.call !== 'function') {
    throw new Error(`defineTool: 工具 ${def.name || '(未命名)'} 缺 name/description/inputSchema/call`);
  }
  return { ...DEFAULTS, ...def };
}
