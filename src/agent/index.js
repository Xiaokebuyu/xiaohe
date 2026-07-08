/**
 * xiaohe 陪伴 harness 公共入口（不是 Anthropic Agent SDK）。
 *
 * 无状态 loop（engine 内化 MiniMax 流式核心）+ 厚 Tool 抽象 + 两层权限 + 静态/动态上下文分离。
 */

export { runCompanionMessage } from './runner.js';
export { defineTool } from './tool.js';
export { ToolRegistry } from './tool-registry.js';
export { PermissionEngine } from './permissions.js';
