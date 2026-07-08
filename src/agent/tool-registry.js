/**
 * ToolRegistry — 注册 / 查找 / 按上下文过滤 / 转 Anthropic tools schema
 *
 * engine 只跟 registry 打交道，不认识具体工具。runMode 过滤在这里做第一道粗筛
 * （readOnly 模式直接不把写工具暴露给模型），细粒度权限仍由 PermissionEngine 兜底。
 */

export class ToolRegistry {
  /** @param {import('./tool.js').XiaoheTool[]} tools */
  constructor(tools = []) {
    this._byName = new Map();
    for (const t of tools) this.register(t);
  }

  register(tool) {
    if (this._byName.has(tool.name)) {
      throw new Error(`ToolRegistry: 工具重名 ${tool.name}`);
    }
    this._byName.set(tool.name, tool);
    return this;
  }

  get(name) {
    return this._byName.get(name) || null;
  }

  /** 当前上下文下可见的工具（isEnabled + runMode 粗筛）。 */
  visible(ctx) {
    const out = [];
    for (const tool of this._byName.values()) {
      if (!tool.isEnabled(ctx)) continue;
      // readOnly / plan 模式：只暴露只读工具（plan 另放行审批工具，见 PermissionEngine）
      if ((ctx.runMode === 'readOnly' || ctx.runMode === 'plan') && !tool.isReadOnly({}, ctx)) {
        if (!tool.exposeInPlan) continue;
      }
      out.push(tool);
    }
    return out;
  }

  /** 转成 Anthropic messages API 的 tools 数组。 */
  toAnthropicTools(ctx) {
    return this.visible(ctx).map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }
}
