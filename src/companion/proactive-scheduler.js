/**
 * 主动关心调度器（C6/C7）：每分钟扫到点的钩子，硬门 → LLM 软判断 → 发 DM + 记 outbound + 记日志。
 * 主动消息必须写回 companion_turns（否则小合忘了自己主动说过啥，是陪伴硬伤）。
 */
import { listDueHooks, getPerson, markHookFired, markHookSkipped, deferHook, appendOutbound, logOutreach } from './store.js';
import { hardGate, softDecide } from './proactive-decider.js';
import { nameOf } from '../config/companions.js';

const TICK_MS = Number(process.env.XIAOHE_PROACTIVE_TICK_MS) || 60 * 1000;
const DEFER_MS = Number(process.env.XIAOHE_PROACTIVE_DEFER_MS) || 60 * 60 * 1000;   // transient 延后 1h 重试

// 永久性拒绝（人不在/被禁）→ skip；其余（静默/冷却/用户活跃/上次没回/软判断不发/发送失败）→ defer 重排
const PERMANENT = new Set(['disabled', 'no_person']);
function resolveHook(hook, reason, openId) {
  if (PERMANENT.has(reason)) { markHookSkipped(hook.id, reason); return; }
  deferHook(hook.id, reason, new Date(Date.now() + DEFER_MS).toISOString());
}

let timer = null;
let running = false;
let sendCard = null;   // 由 server 注入：(openId, text) => Promise，实际发飞书卡

/** server 启动时注入发送器（避免 scheduler 直接依赖 feishu 层，方便测试）。 */
export function setProactiveSender(fn) { sendCard = fn; }

async function processHook(hook) {
  const openId = hook.open_id;
  const person = getPerson(openId);

  const gate = hardGate(person);
  if (!gate.pass) {
    logOutreach(openId, { hookId: hook.id, kind: hook.kind, decision: 'skip', reason: gate.reason });
    resolveHook(hook, gate.reason, openId);   // 静默/冷却/用户活跃/上次没回 → defer 重排（不永久 skip）
    return;
  }

  const displayName = nameOf(openId);
  const boundUser = displayName ? { username: openId, display_name: displayName } : null;
  const decision = await softDecide({ openId, boundUser, hook });

  if (!decision.send) {
    logOutreach(openId, { hookId: hook.id, kind: hook.kind, decision: 'skip', reason: decision.reason });
    resolveHook(hook, decision.reason, openId);   // 软判断不发/解析失败 → defer（此刻不发，晚点再看）
    return;
  }

  try {
    if (sendCard) await sendCard(openId, decision.message);   // 发送器无 messageId 会 throw（见 server）
    appendOutbound(openId, decision.message, 'proactive');   // 记进跨天历史，小合记得自己说过
    logOutreach(openId, { hookId: hook.id, kind: hook.kind, decision: 'send', reason: decision.reason, message: decision.message });
    markHookFired(hook.id);
    console.log(`[Companion/Proactive] 主动关心 ${openId.slice(0, 8)}（${hook.kind}）: ${decision.message.slice(0, 30)}`);
  } catch (err) {
    console.warn(`[Companion/Proactive] 发送失败 ${openId.slice(0, 8)}:`, err.message);
    resolveHook(hook, 'send_failed', openId);   // 发送失败 → defer 重排，别原地每分钟重跑 LLM
  }
}

async function tick() {
  if (running) return;
  running = true;
  try {
    for (const hook of listDueHooks()) {
      try { await processHook(hook); } catch (err) { console.warn('[Companion/Proactive] 处理钩子出错:', err.message); }
    }
  } finally { running = false; }
}

export function startProactive() {
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  if (timer.unref) timer.unref();
  console.log('[Companion/Proactive] 主动关心调度已启动');
}

export function stopProactive() { if (timer) { clearInterval(timer); timer = null; } }
