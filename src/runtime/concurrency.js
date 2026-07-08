/**
 * 两层并发控制
 *
 * 第一层：per-user mutex（async-mutex-lite）
 *   同一用户的消息严格串行，不同用户并行
 *
 * 第二层：全局信号量
 *   限制同时进行的 LLM 调用总数，防止 MiniMax API 过载
 *
 * 背压：per-user 队列超 3 条时拒绝排队，返回 backpressure 状态
 *
 * 消息流：
 *   飞书事件 → message_id 去重 → per-user mutex 排队 → 全局信号量限流 → LLM 调用
 */

import { mutex } from 'async-mutex-lite';

// ── 全局信号量 ──

const MAX_CONCURRENT = Number(process.env.BOT_MAX_CONCURRENT_LLM) || 5;
let running = 0;
const waitQueue = [];

function acquireSemaphore() {
  if (running < MAX_CONCURRENT) {
    running++;
    return Promise.resolve();
  }
  return new Promise(resolve => waitQueue.push(resolve));
}

function releaseSemaphore() {
  if (waitQueue.length > 0) {
    waitQueue.shift()();
  } else {
    running--;
  }
}

// ── 背压跟踪 ──

const queueDepth = new Map();
const MAX_QUEUE_DEPTH = Number(process.env.BOT_MAX_QUEUE_DEPTH) || 3;

/**
 * 将消息排入 per-user 队列
 *
 * @param {string} userId - 飞书 user open_id
 * @param {() => Promise<any>} task - 消息处理函数
 * @returns {Promise<{ status: 'ok' | 'backpressure', result?: any }>}
 */
export async function enqueueMessage(userId, task) {
  const depth = (queueDepth.get(userId) || 0) + 1;

  // 背压：队列已满，拒绝排队
  if (depth > MAX_QUEUE_DEPTH) {
    console.log(`[Concurrency] 背压: userId=${userId.slice(0, 8)}... depth=${depth} > max=${MAX_QUEUE_DEPTH}`);
    return { status: 'backpressure' };
  }

  queueDepth.set(userId, depth);

  try {
    const result = await mutex(userId, async () => {
      console.log(`[Concurrency] 开始处理: userId=${userId.slice(0, 8)}... (running=${running}/${MAX_CONCURRENT})`);

      await acquireSemaphore();
      try {
        return await task();
      } finally {
        releaseSemaphore();
      }
    });

    return { status: 'ok', result };
  } finally {
    const current = queueDepth.get(userId) || 1;
    if (current <= 1) {
      queueDepth.delete(userId);
    } else {
      queueDepth.set(userId, current - 1);
    }
  }
}

/** 给 get_system_health 工具用：返回当前并发指标 */
export function getConcurrencyMetrics() {
  return {
    running,
    maxConcurrent: MAX_CONCURRENT,
    waitingForSemaphore: waitQueue.length,
    perUserQueueDepth: Object.fromEntries(
      [...queueDepth.entries()].map(([u, d]) => [u.slice(0, 8) + '...', d])
    ),
    maxQueueDepth: MAX_QUEUE_DEPTH,
  };
}
