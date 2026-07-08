/**
 * MiniMax 没有 count-tokens，做保守近似（CJK 约 1.2 token/字，其余约 1 token/3.5 字符）。
 * 只用于 930k 兜底阈值的粗判——宁可高估提前压，也别爆窗口。
 */
export function estimateTokens(text = '') {
  if (!text) return 0;
  const cjk = (text.match(/[㐀-鿿豈-﫿]/g) || []).length;
  const nonCjk = text.length - cjk;
  return Math.ceil(cjk * 1.2 + nonCjk / 3.5);
}

export function estimateMessagesTokens(messages = []) {
  let n = 0;
  for (const m of messages) {
    n += estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
  }
  return n;
}
