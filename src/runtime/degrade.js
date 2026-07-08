/**
 * 全局降级检测 + 日志 + 降级卡片
 *
 * 触发场景（放宽阈值，先让 LLM 充分 agentic retry）：
 *   - agent-loop 返回 exhausted/allFailed：轮数耗尽或全失败
 *   - 工具失败次数 ≥ DEGRADE_ERROR_THRESHOLD：连环失败
 *   - handleMessage 外层 catch 到非业务异常：SDK 流穿透
 *
 * 巡检 / 变更检测只打日志、不发卡片（避免 LLM 不可用时骚扰用户）。
 * user-facing 链路（chat）才在 uncaught 时发降级卡片。
 */

import { buildSimpleCard } from './card-templates.js';

const DEGRADE_ERROR_THRESHOLD = 5;

/**
 * 判断一次 agent-loop 结果是否已经降级
 * @param {object} loopResult - runAgentLoop 的返回体或 chat() 透传体
 * @returns {boolean}
 */
export function shouldDegrade(loopResult) {
  if (!loopResult) return false;
  if (loopResult.uncaughtError) return true;
  if (loopResult.exhausted) return true;
  if (loopResult.allFailed) return true;
  const errs = (loopResult.toolSteps || []).filter(s => s.error).length;
  return errs >= DEGRADE_ERROR_THRESHOLD;
}

/**
 * 汇总一个可读的降级原因（短语，用于日志和卡片）
 */
export function summarizeDegrade(loopResult) {
  if (!loopResult) return 'unknown';
  if (loopResult.uncaughtError) return 'uncaught';
  if (loopResult.allFailed) return 'all_failed';
  if (loopResult.exhausted) return 'exhausted';
  const errs = (loopResult.toolSteps || []).filter(s => s.error).length;
  if (errs >= DEGRADE_ERROR_THRESHOLD) return `too_many_errors(${errs})`;
  return 'unknown';
}

/**
 * 构造降级卡片（user-facing 场景用）
 */
export function buildDegradeCard(reason, { toolSummaries } = {}) {
  const tail = Array.isArray(toolSummaries) && toolSummaries.length
    ? '\n\n最近尝试：\n' + toolSummaries.slice(-3).join('\n')
    : '';
  const content = `小合这会儿有点忙不过来了（原因：${reason}）。\n稍等片刻再问一次，或者换个问法看看。${tail}`;
  return buildSimpleCard(content, { level: 'warn', title: '小合小憩一下', subtitle: '降级兜底' });
}

/**
 * 统一降级日志前缀，便于 grep
 * 生产排查：pm2 logs deskskill | grep '\[Bot/Degrade\]'
 */
export function logDegrade(scope, reason, detail) {
  if (detail instanceof Error) {
    console.error(`[Bot/Degrade] scope=${scope} reason=${reason}:`, detail.message);
  } else if (detail !== undefined) {
    console.error(`[Bot/Degrade] scope=${scope} reason=${reason}`, detail);
  } else {
    console.error(`[Bot/Degrade] scope=${scope} reason=${reason}`);
  }
}
