/**
 * 装配陪伴工具（纯陪伴 repo：只有记忆类工具，无 panel 工具）。
 */

import { ToolRegistry } from '../tool-registry.js';
import { rememberTool, recallMemoryTool } from './memory.js';
import { setReminderTool, cancelReminderTool } from './reminder.js';
import { updateWorkingNoteTool } from './note.js';

/** 陪伴场景：记忆（多级索引 记/调）+ 自主设/撤主动关心钩子 + 自管便笺。 */
export function buildCompanionRegistry() {
  return new ToolRegistry([
    rememberTool,
    recallMemoryTool,
    setReminderTool,
    cancelReminderTool,
    updateWorkingNoteTool,
  ]);
}
