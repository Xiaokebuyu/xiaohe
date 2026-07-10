/**
 * 每日 compact 调度器：每 10 分钟看一次，过了凌晨 4 点（北京）且今天还没压过的人，压一次当天对话。
 * 取代 20 分钟 idle 蒸馏 —— 1M 窗口撑一整天，不必频繁压；agent 聊天时已有意识存重要事，这里做系统性兜底。
 */
import { listCompactCandidates, getCompactState } from './store.js';
import { dailyCompact } from './daily-compact.js';
import { isCompanionTarget, nameOf } from '../config/companions.js';
import { formatBeijingNow } from '../util/time.js';

const COMPACT_HOUR = Number(process.env.XIAOHE_DAILY_COMPACT_HOUR ?? 4);   // 北京时间几点压
const TICK_MS = Number(process.env.XIAOHE_DAILY_TICK_MS) || 10 * 60 * 1000;
const RETRY_COOLDOWN_MS = Number(process.env.XIAOHE_DAILY_RETRY_MS) || 30 * 60 * 1000;   // 失败后同日重试冷却

let timer = null;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const { today, dateTime } = formatBeijingNow();
    const hour = Number(dateTime.slice(11, 13));
    if (hour < COMPACT_HOUR) return;   // 还没到凌晨压缩点
    // 只压"今日 COMPACT_HOUR 点"之前的对话——过了 4 点之后当天新聊的内容留到明天的 cutoff 再压，
    // 不然一过 4 点，候选人刚聊完的对话马上就会被当成"待压"扫走，1M 撑一整天的设计就白搭了。
    const cutoffIso = new Date(`${today}T${String(COMPACT_HOUR).padStart(2, '0')}:00:00+08:00`).toISOString();
    for (const openId of listCompactCandidates(cutoffIso)) {
      if (!isCompanionTarget(openId)) continue;   // 移出白名单/旧测试用户不再被后台 compact
      const state = getCompactState(openId);
      if (state.lastDailyCompactDate === today) continue;   // 今天已成功压过
      if (state.lastDistillAttemptAt && (Date.now() - Date.parse(state.lastDistillAttemptAt)) < RETRY_COOLDOWN_MS) continue;   // 刚失败过，冷却中
      const displayName = nameOf(openId);
      const boundUser = displayName ? { username: openId, display_name: displayName } : null;
      try { await dailyCompact(openId, boundUser, { beforeIso: cutoffIso, compactDate: today }); }
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
