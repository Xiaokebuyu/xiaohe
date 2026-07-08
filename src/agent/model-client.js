/**
 * 模型客户端 — 薄封装现有 anthropic-client.js
 *
 * xiaohe-agent-sdk 的所有模型通信都从这里取 client，不直接 import ../anthropic-client.js，
 * 好在未来切换端点 / 加路由策略时只动这一个文件。当前直通 MiniMax 兼容端点。
 */

export {
  client,
  DEFAULT_MODEL,
  SUMMARY_MODEL,
  MEETING_MODEL,
  INTERLEAVED_THINKING_HEADERS,
} from '../model/client.js';
