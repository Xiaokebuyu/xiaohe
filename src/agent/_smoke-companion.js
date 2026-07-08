/**
 * 陪伴自测：companion registry / 权限模式 / remember_about_person 真写真读。
 * 不连飞书、不调模型。跑：cd server && node bot/xiaohe-agent-sdk/_smoke-companion.js
 * 用一个一次性 anon openId 写真实 memory 文件，跑完自删。
 */

import { unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { buildCompanionRegistry } from './tools/index.js';
import { PermissionEngine } from './permissions.js';
import { loadUserMemory } from '../memory/index.js';

let pass = 0, fail = 0;
function ok(name, cond) { cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.error(`  ✗ ${name}`)); }

const TEST_OPENID = 'ou_companion_smoke_0001';
const MEMORY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'memory');

const registry = buildCompanionRegistry();
const rememberTool = registry.get('remember_about_person');

console.log('1. companion registry');
ok('remember_about_person 已注册', !!rememberTool);
ok('是 memory scope', rememberTool?.scope === 'memory');
ok('registry 不含 panel 工具', !registry.get('list_plans') && !registry.get('proxy_create_plan'));

console.log('2. companion 权限模式');
const eng = new PermissionEngine({ mode: 'companion' });
const ctx = { runMode: 'companion', openId: TEST_OPENID, boundUser: null, chatType: 'p2p' };
const dMem = await eng.canUseTool(rememberTool, { section: '近期状态', content: 'x' }, ctx);
ok('memory 工具 + 有 openId → allow', dMem.behavior === 'allow');
const dNoId = await eng.canUseTool(rememberTool, { section: '近期状态', content: 'x' }, { ...ctx, openId: null });
ok('memory 工具 + 无 openId → deny（工具层 checkPermissions 拦）', dNoId.behavior === 'deny');
// 伪造一个非 memory 的写工具，验证 companion 模式拒绝
const fakeWrite = { name: 'fake_panel_write', scope: undefined, isReadOnly: () => false, checkPermissions: async (i) => ({ behavior: 'allow', updatedInput: i }) };
const dPanel = await eng.canUseTool(fakeWrite, {}, ctx);
ok('非 memory 写工具 → deny', dPanel.behavior === 'deny');

console.log('3. remember_about_person 真写真读');
try {
  const r1 = await rememberTool.call({ section: '相处偏好', content: '喜欢先被接住情绪再谈事', segment: 'private' }, ctx);
  ok('upsert 型分段写入 ok', r1.ok === true && r1.section === '相处偏好');
  const r2 = await rememberTool.call({ section: '近期状态', content: '最近睡得晚，别早上催', segment: 'private' }, ctx);
  ok('append 型分段写入 ok', r2.ok === true);

  const mem = await loadUserMemory(TEST_OPENID, null);
  ok('记忆里有「相处偏好」段', mem.content.includes('### 相处偏好'));
  ok('记忆里有「近期状态」段', mem.content.includes('### 近期状态'));
  ok('内容落盘（含"别早上催"）', mem.content.includes('别早上催'));
  ok('append 带日期前缀', /### 近期状态\n- \[\d{4}-\d{2}-\d{2}\]/.test(mem.content));
} finally {
  await unlink(join(MEMORY_DIR, `anon-${TEST_OPENID}.md`)).catch(() => {});
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
