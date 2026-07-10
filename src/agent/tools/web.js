/**
 * 联网搜索工具（只读）—— 让小合能查时效信息 / 新闻 / 需要核实的事实。
 *
 * 当前只接百度千帆 AI 搜索（中文场景足够；Tavily/Exa 等 key 配齐后再扩 provider 路由）。
 * 密钥只从 env 读（BAIDU_QIANFAN_API_KEY，.env 不进 Git）。
 * 失败一律 fail-soft：返回 { ok:false, note } 让模型能老实告诉用户"这会儿查不了"，不 throw 断轮。
 */
import { defineTool } from '../tool.js';

const BAIDU_ENDPOINT = 'https://qianfan.baidubce.com/v2/ai_search/web_search';
const BAIDU_QUERY_MAX = 72;        // 千帆 content 字段硬限 72 字，超长自动截
const SEARCH_TIMEOUT_MS = 20_000;
const SNIPPET_MAX = 300;           // 单条摘要限长，防结果倾倒撑爆上下文
const DEFAULT_N = 5;
const MAX_N = 8;

/** 从 URL 提取域名做来源兜底。 */
function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** 千帆响应归一成 {title,url,snippet,source,publishedAt}。两种版本字段都兼容。 */
function normalizeBaiduHits(raw, n) {
  const list = Array.isArray(raw?.search_results) ? raw.search_results
    : Array.isArray(raw?.results) ? raw.results
    : Array.isArray(raw?.references) ? raw.references
    : [];
  return list.slice(0, n).map(r => {
    const url = r.url || r.link || '';
    return {
      title: String(r.title || '').slice(0, 120),
      url,
      snippet: String(r.content || r.abstract || r.segment_text || '').slice(0, SNIPPET_MAX),
      source: r.source || domainOf(url),
      publishedAt: r.publish_time || '',
    };
  }).filter(h => h.title || h.snippet);
}

export const webSearchTool = defineTool({
  name: 'web_search',
  description:
    '联网搜索。他问到时效性的事（新闻/天气/最近发生的）、或需要核实你不确定的事实时用。'
    + '返回带来源网址的结果列表；转述时自然说，别原样倾倒列表，需要时可以提一句来源。'
    + '纯聊天/情绪/回忆你们聊过的事不用查——那是你记忆里的事。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索词，中文直接写（如"杭州明天天气"、"XX 最新消息"）。72 字内，别塞整段话。' },
      n: { type: 'integer', minimum: 1, maximum: MAX_N, description: `返回条数，默认 ${DEFAULT_N}` },
    },
    required: ['query'],
  },
  scope: 'web',
  isReadOnly: () => true,          // companion 权限模式对只读工具直接放行
  isConcurrencySafe: () => true,
  async checkPermissions(input) {
    const q = String(input.query || '').trim();
    if (!q) return { behavior: 'deny', message: 'query 不能为空' };
    return { behavior: 'allow', updatedInput: { ...input, query: q.slice(0, BAIDU_QUERY_MAX) } };
  },
  async call(input) {
    const apiKey = process.env.BAIDU_QIANFAN_API_KEY || '';
    if (!apiKey) return { ok: false, note: '联网搜索还没配置好（缺密钥），先老实告诉他这会儿查不了' };

    const n = Math.min(Math.max(input.n || DEFAULT_N, 1), MAX_N);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
    let raw;
    try {
      const resp = await fetch(BAIDU_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: input.query }] }),
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        const text = (await resp.text().catch(() => '')).slice(0, 200);
        console.warn(`[WebSearch] 千帆 HTTP ${resp.status}: ${text}`);
        return { ok: false, note: `搜索服务这会儿不太顺（HTTP ${resp.status}），可以老实告诉他查不了` };
      }
      raw = await resp.json();
    } catch (err) {
      console.warn('[WebSearch] 请求失败:', err.name === 'AbortError' ? '超时' : err.message);
      return { ok: false, note: '搜索超时或网络不通，老实告诉他这会儿查不了，别编结果' };
    } finally {
      clearTimeout(timer);
    }

    const hits = normalizeBaiduHits(raw, n);
    if (!hits.length) return { ok: false, note: '没搜到相关结果，可以换个说法再试一次，或告诉他没查到' };
    // card_note → 卡片上的操作 chip：让用户看到答案是现查的（搜索词公开无妨，本来就是他问的事）
    return { ok: true, query: input.query, provider: 'baidu', hits, card_note: `查了「${input.query}」` };
  },
});
