/**
 * 装配陪伴工具（纯陪伴 repo：只有记忆类工具，无 panel 工具）。
 */

import { ToolRegistry } from '../tool-registry.js';
import { rememberAboutPersonTool } from './memory.js';

/** 陪伴场景：只挂记忆类工具。 */
export function buildCompanionRegistry() {
  return new ToolRegistry([
    rememberAboutPersonTool,
  ]);
}
