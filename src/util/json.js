/**
 * 从 LLM 文本里稳健抽第一个可解析 JSON 对象。
 * 优先 fenced ```json 块；否则做括号深度扫描（避免贪婪 /\{[\s\S]*\}/ 抓过头）。
 */
export function extractJson(text) {
  if (!text || typeof text !== 'string') return null;

  // 1) fenced ```json ... ``` 或 ``` ... ```
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  candidates.push(text);

  for (const chunk of candidates) {
    const obj = scanFirstObject(chunk);
    if (obj) return obj;
  }
  return null;
}

/** 括号深度扫描：找第一个平衡的 {...}（跳过字符串内的花括号），尝试 parse。 */
function scanFirstObject(s) {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}
