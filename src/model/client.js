/**
 * 共享 Anthropic SDK client
 * 当前指向 MiniMax 的 Anthropic 兼容端点；改 baseURL 即可切到 Claude / Bedrock 等
 *
 * MiniMax 兼容性已验证（bot/_probe-sdk.js）：
 *   - 流式 + native thinking_delta
 *   - 流式 tool use（input_json_delta）
 *   - cache_control: { type: 'ephemeral' }
 *   - anthropic-beta: interleaved-thinking-2025-05-14
 */

import Anthropic from '@anthropic-ai/sdk';

const apiKey = process.env.MINIMAX_API_KEY;
if (!apiKey) {
  console.warn('[Bot/SDK] MINIMAX_API_KEY 未配置，LLM 调用将失败');
}

export const client = new Anthropic({
  apiKey: apiKey || 'missing',
  baseURL: process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com/anthropic',
  maxRetries: 2,            // 网络抖动重试
  timeout: 120_000,         // 流式可能跑很久
});

export const DEFAULT_MODEL = process.env.MINIMAX_MODEL || 'MiniMax-M2.7-highspeed';

/** 摘要模型：生成思考折叠条标题，要求不开思考（直接输出结论） */
export const SUMMARY_MODEL = process.env.MINIMAX_SUMMARY_MODEL || 'MiniMax-M2.7-highspeed';

/**
 * 会议总结模型：默认 MiniMax-M3（百万上下文，整场 transcript 一次读完不切片）。
 * 若厂商 Anthropic 兼容端点的正式 model id 不同，用 MINIMAX_MEETING_MODEL 覆盖。
 */
export const MEETING_MODEL = process.env.MINIMAX_MEETING_MODEL || 'MiniMax-M3';

/** 交错思考 beta 头（边推理边调工具，跨轮次保持思考连贯） */
export const INTERLEAVED_THINKING_HEADERS = {
  'anthropic-beta': 'interleaved-thinking-2025-05-14',
};
