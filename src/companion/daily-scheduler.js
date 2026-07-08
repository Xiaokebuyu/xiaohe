/**
 * 每日 compact 调度器：每 10 分钟看一次，过了凌晨 4 点（北京）且今天还没压过的人，压一次当天对话。
 * 取代 20 分钟 idle 蒸馏 —— 1M 窗口撑一整天，不必频繁压；agent 聊天时已有意识存重要事，这里做系统性兜底。
 */
import { listCompactCandidates, getCompactState } from './store.js';
import { dailyCompact } from './daily-compact.js';
import { nameOf } from '../config/companions.js';
import { formatBeijingNow } from '../util/time.js';

const COMPACT_HOUR = Number(process.env.XIAOHE_DAILY_COMPACT_HOUR ?? 4);   // 北京时间几点压
const TICK_MS = Number(process.env.XIAOHE_DAILY_TICK_MS) || 10 * 60 * 1000;

let timer = null;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const { today, dateTime } = formatBeijingNow();
    const hour = Number(dateTime.slice(11, 13));
    if (hour < COMPACT_HOUR) return;   // 还没到凌晨压缩点
    for (const openId of listCompactCandidates()) {
      if (getCompactState(openId).lastDailyCompactDate === today) continue;   // 今天已压
      const displayName = nameOf(openId);
      const boundUser = displayName ? { username: openId, display_name: displayName } : null;
      try { await dailyCompact(openId, boundUser); }
      catch (err) { console.warn(`[Companion/Daily] 压 ${openId.slice(0, 8)} 出错:`, err.message); }
    }
  } finally { running = false; }
}

export function startDailyCompact() {
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  if (timer.unref) timer.unref();
  console.log(`[Companion/Daily] 每日 compact 调度已启动（北京 ${COMPACT_HOUR} 点后压当天）`);
}
export function stopDailyCompact() { if (timer) { clearInterval(timer); timer = null; } }
