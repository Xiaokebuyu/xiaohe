/**
 * 陪伴自测：companion registry / 权限模式 / 记忆条目树（remember/recall）真写真读。
 * 不连飞书、不调模型。跑：cd xiaohe && node src/agent/_smoke-companion.js
 * 用一次性 DB，跑完自删。
 */
import { rmSync } from 'fs';

const TEST_DB = '/tmp/xiaohe_smoke.sqlite';
['', '-wal', '-shm'].forEach(s => rmSync(TEST_DB + s, { force: true }));
process.env.XIAOHE_DB_PATH = TEST_DB;

const { buildCompanionRegistry } = await import('./tools/index.js');
const { PermissionEngine } = await import('./permissions.js');
const { renderMemoryIndex, getEntry } = await import('../companion/memory-store.js');

let pass = 0, fail = 0;
function ok(name, cond) { cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.error(`  ✗ ${name}`)); }

const TEST_OPENID = 'ou_companion_smoke_0001';
const registry = buildCompanionRegistry();

console.log('1. companion registry');
for (const t of ['remember', 'recall_memory', 'set_reminder', 'cancel_reminder', 'update_working_note']) {
  ok(`${t} 已注册`, !!registry.get(t));
}
ok('registry 不含 panel 工具', !registry.get('list_plans') && !registry.get('proxy_create_plan'));

console.log('2. companion 权限模式');
const eng = new PermissionEngine({ mode: 'companion' });
const ctx = { runMode: 'companion', openId: TEST_OPENID, boundUser: null, chatType: 'p2p' };
const remember = registry.get('remember');
const d1 = await eng.canUseTool(remember, { topic: '工作', title: 't', summary: 's' }, ctx);
ok('memory 工具 + openId → allow', d1.behavior === 'allow');
const d2 = await eng.canUseTool(remember, {}, { ...ctx, openId: null });
ok('无 openId → deny', d2.behavior === 'deny');
const fakeWrite = { name: 'fake', scope: undefined, isReadOnly: () => false, checkPermissions: async i => ({ behavior: 'allow', updatedInput: i }) };
ok('非本地 scope 写工具 → deny', (await eng.canUseTool(fakeWrite, {}, ctx)).behavior === 'deny');

console.log('3. 记忆条目树真写真读');
const r1 = await remember.call({ topic: '工作', title: '在赶的项目', summary: '周五截止', body: '压力大常加班', salience: 4 }, ctx);
ok('remember 落条目', r1.ok === true && r1.entry_id.startsWith('me_'));
const r1b = await remember.call({ topic: '工作', title: '在赶的项目', summary: '今天说快搞定了' }, ctx);
ok('同标题合并（id 不变）', r1b.entry_id === r1.entry_id);
ok('没传 body 时正文保留（不被冲空）', getEntry(TEST_OPENID, r1.entry_id).body.includes('加班'));
const idx = renderMemoryIndex(TEST_OPENID);
ok('索引含主题+摘要、不含 body', idx.includes('工作') && idx.includes('快搞定了') && !idx.includes('加班'));
const recall = registry.get('recall_memory');
ok('recall 拿到正文', (await recall.call({ entry_id: r1.entry_id }, ctx)).entry.body.includes('加班'));
ok('搜索命中', (await recall.call({ query: '项目' }, ctx)).matches.length >= 1);

['', '-wal', '-shm'].forEach(s => rmSync(TEST_DB + s, { force: true }));
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
