/**
 * Idle 蒸馏调度器（C4）：每分钟扫一遍，把静默下来、且有新对话的人蒸馏一次。
 * 用户明确要的"超时没发消息之后就保存记忆"。compact（C5）是对话中的事，跟这个不冲突。
 */
import { listDistillCandidates } from './store.js';
import { distillPerson } from './distill.js';
import { nameOf } from '../config/companions.js';

const IDLE_MS = Number(process.env.XIAOHE_DISTILL_IDLE_MS) || 20 * 60 * 1000;   // 静默 20 分钟触发
const TICK_MS = Number(process.env.XIAOHE_DISTILL_TICK_MS) || 60 * 1000;         // 每分钟扫

let timer = null;
let running = false;

async function tick() {
  if (running) return;                 // 上一轮没跑完就跳过，别叠
  running = true;
  try {
    const ids = listDistillCandidates(IDLE_MS);
    for (const openId of ids) {
      const displayName = nameOf(openId);
      const boundUser = displayName ? { username: openId, display_name: displayName } : null;
      try {
        await distillPerson(openId, boundUser);
      } catch (err) {
        console.warn(`[Companion/Idle] 蒸馏 ${openId.slice(0, 8)} 出错:`, err.message);
      }
    }
  } finally {
    running = false;
  }
}

export function startIdleDistill() {
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  if (timer.unref) timer.unref();
  console.log(`[Companion/Idle] 蒸馏调度已启动（静默 ${IDLE_MS / 60000} 分钟触发）`);
}

export function stopIdleDistill() {
  if (timer) { clearInterval(timer); timer = null; }
}
