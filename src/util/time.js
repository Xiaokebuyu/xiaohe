/**
 * 北京时间工具
 * toISOString 是 UTC，直接用会在东八区凌晨误差 8 小时。
 * 所有注入 LLM 的"当前时间"应该走这个 util，输出北京时间 + 星期。
 */

const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 返回北京时间的多种呈现，供不同 prompt 复用
 * @returns {{ today: string, dateTime: string, weekday: string, nowMs: number, iso: string }}
 *   today:     "2026-04-22"
 *   dateTime:  "2026-04-22 14:32:05"
 *   weekday:   "周三"
 *   nowMs:     毫秒时间戳（给 LLM 做差值用）
 *   iso:       "2026-04-22T14:32:05+08:00"
 */
export function formatBeijingNow() {
  const now = new Date();
  const nowMs = now.getTime();

  // 转北京时间（东八区偏移）
  const bj = new Date(nowMs + 8 * 3600 * 1000);
  const y = bj.getUTCFullYear();
  const m = String(bj.getUTCMonth() + 1).padStart(2, '0');
  const d = String(bj.getUTCDate()).padStart(2, '0');
  const hh = String(bj.getUTCHours()).padStart(2, '0');
  const mm = String(bj.getUTCMinutes()).padStart(2, '0');
  const ss = String(bj.getUTCSeconds()).padStart(2, '0');
  const weekday = WEEKDAY_CN[bj.getUTCDay()];

  const today = `${y}-${m}-${d}`;
  const dateTime = `${today} ${hh}:${mm}:${ss}`;
  const iso = `${today}T${hh}:${mm}:${ss}+08:00`;

  return { today, dateTime, weekday, nowMs, iso };
}

/**
 * 返回适合塞进 prompt 的一行文本
 * "当前时间：2026-04-22 周三 14:32:05（北京时间，毫秒时间戳 1745...）"
 */
export function beijingNowLine() {
  const { today, weekday, dateTime, nowMs } = formatBeijingNow();
  return `当前时间：${dateTime} ${weekday}（北京时间，毫秒时间戳 ${nowMs}）`;
}

/**
 * 陪伴 <now> 用的精简当前时间（分钟级，无秒/无毫秒戳——毫秒戳对弱模型是纯噪音，
 * set_reminder 也只吃 ISO 带时区，不靠这个算 epoch）。
 * @returns {{ dateHm: string, hm: string, weekday: string, iso: string }}
 *   dateHm "2026-07-09 12:56"、hm "12:56"、weekday "周三"、iso "…+08:00"
 */
export function beijingNowMinute() {
  const { dateTime, weekday, iso } = formatBeijingNow();
  const dateHm = dateTime.slice(0, 16);        // 去掉秒
  return { dateHm, hm: dateHm.slice(11), weekday, iso };
}

/** 把毫秒间隔说成人话："刚刚"/"5 分钟前"/"2 小时前"/"3 天前"。非法/负数返回 ''。 */
export function humanGap(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.floor(ms / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
}

/**
 * 历史 user 轮开头的收讯时刻标签（帮模型看出"早上说的 / 现在是晚上"，补情绪连续性）：
 * 今天→"12:56"；昨天→"昨天 23:40"；更早→"7-08 09:00"。非法返回 ''。
 */
export function beijingTimeTag(createdAtIso) {
  const t = Date.parse(createdAtIso || '');
  if (!Number.isFinite(t)) return '';
  const bj = new Date(t + 8 * 3600 * 1000);
  const hh = String(bj.getUTCHours()).padStart(2, '0');
  const mm = String(bj.getUTCMinutes()).padStart(2, '0');
  const nowBj = new Date(Date.now() + 8 * 3600 * 1000);
  const sameYMD = (a, b) => a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
  if (sameYMD(bj, nowBj)) return `${hh}:${mm}`;
  const yst = new Date(nowBj.getTime() - 24 * 3600 * 1000);
  if (sameYMD(bj, yst)) return `昨天 ${hh}:${mm}`;
  return `${bj.getUTCMonth() + 1}-${bj.getUTCDate()} ${hh}:${mm}`;
}

/** 小结日期标签（"7月9日"），用 ctx.updatedAt 给 recent_summary 标时。非法返回 ''。 */
export function beijingDateLabel(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const bj = new Date(t + 8 * 3600 * 1000);
  return `${bj.getUTCMonth() + 1}月${bj.getUTCDate()}日`;
}
