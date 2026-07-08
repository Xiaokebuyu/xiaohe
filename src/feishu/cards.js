/**
 * 飞书卡片模板（Card JSON 2.0）
 *
 * 场景：
 *   1. 聊天（流式）— 场景包 header（随机 title+subtitle 池）+ 瞬态思考胶囊
 *   2. 群聊变更通知
 *   3. 私聊提醒
 *   4. 每日巡检
 *   5. 简单回复（绑定/背压/错误）
 *
 * 聊天卡生命周期：
 *   initial  → 场景包（日常/数据/工单/深度/错误）的 initial header
 *   streaming → thinking chunks 插入 thinking_pill_r{N}，text 首 chunk 删除
 *   complete → card.update 切完成态 header（绿勾 + "小合" + 随机完成 subtitle · 耗时）
 */

const BOT_NAME = '小合';

// ============================================================
//  配置常量
// ============================================================

/** 流式更新节奏（ms） */
const STREAMING_CONFIG = {
  print_frequency_ms: { default: 30, pc: 30, ios: 30, android: 30 },
  print_step: { default: 2 },
  print_strategy: 'fast',
};

// ============================================================
//  场景包（5 种）：icon + color + template + 文案池
// ============================================================

/**
 * 场景对应的 header 视觉
 * ⚠️ icon token 全部在 _probe-cards.js 里实测过，下面都是 ✓ 已生效的
 * 可用候选（节选）：bitablegrid / bitablekanban / edit / pen / done / check /
 * yes / close / close-bold / no / add / reduce / bell / info / warning /
 * search / chat / calendar / file-link-docx _outlined
 */
const SCENE_HEADERS = {
  default:   { icon: 'chat_outlined',          color: 'orange',    template: 'default' },
  data:      { icon: 'bitablekanban_outlined', color: 'indigo',    template: 'default' },
  plan:      { icon: 'edit_outlined',          color: 'violet',    template: 'default' },
  deepthink: { icon: 'search_outlined',        color: 'turquoise', template: 'default' },
  error:     { icon: 'close_outlined',         color: 'red',       template: 'red'     },
};

/** 完成态 header（场景无关，永远绿勾 + "小合"） */
const COMPLETE_HEADER = {
  icon: 'done_outlined', color: 'green', template: 'default',
};

/** 文案池：initial titles / initial subtitles / initial summaries / complete subtitles */
const SCENE_POOLS = {
  default: {
    titles:    ['小合在', '小合', '值班小合'],
    subtitles: ['这就来', '我在', '你好呀', '听着呢', '让我看看'],
    summaries: ['小合正在思考...', '让我看看...', '马上就来...'],
    completes: ['应该是这样 · {X}s', '希望帮到你 · {X}s', '就这些 · {X}s', '说完啦 · {X}s'],
  },
  data: {
    titles:    ['账本小合', '小合 · 查账', '数字小合'],
    subtitles: ['翻翻数据', '去查账了', '扒拉下历史', '看看最近', '数数去'],
    summaries: ['翻数据中...', '扒账本中...', '查数据中...'],
    completes: ['数对了 · {X}s', '账翻完 · {X}s', '扒出来了 · {X}s'],
  },
  plan: {
    titles:    ['小合 · 工单房', '跟单小合', '小合 · 看工单'],
    subtitles: ['去看工单', '翻翻抽屉', '摸摸进展', '瞧瞧情况', '把工单找出来'],
    summaries: ['查工单中...', '翻抽屉中...', '摸工单中...'],
    completes: ['工单看完 · {X}s', '心里有数 · {X}s', '摸清了 · {X}s', '过目一遍 · {X}s'],
  },
  deepthink: {
    titles:    ['小合 · 认真脸', '思考小合', '小合 · 琢磨中'],
    subtitles: ['让我想想', '琢磨一会儿', '认真捋一下', '转转脑子', '深呼吸'],
    summaries: ['深度思考中...', '认真琢磨中...', '捋思路中...'],
    completes: ['想明白了 · {X}s', '琢磨出来了 · {X}s', '想好了 · {X}s', '捋通了 · {X}s'],
  },
  error: {
    titles:    ['小合 · 懵了', '小合 · 卡壳', '小合 · 撞墙了'],
    subtitles: ['卡壳了', '哎呀碰壁', '撞墙了', '出了点状况', '脑子短路了'],
    summaries: ['遇到问题'],
    completes: [],   // 错误态不走完成态
  },
};

function pick(arr) {
  if (!arr || arr.length === 0) return '';
  return arr[Math.floor(Math.random() * arr.length)];
}

function fmtDuration(ms) {
  return (ms / 1000).toFixed(1);
}

// ============================================================
//  场景包 helper（供 ChatCardStreamer 调用）
// ============================================================

/**
 * 生成 initial header（场景包起点：随机 title + subtitle）
 * @param {'default'|'data'|'plan'|'deepthink'|'error'} scene
 */
export function pickInitialHeader(scene = 'default') {
  const pool = SCENE_POOLS[scene] || SCENE_POOLS.default;
  const vis = SCENE_HEADERS[scene] || SCENE_HEADERS.default;
  return {
    title:    { tag: 'plain_text', content: pick(pool.titles) },
    subtitle: { tag: 'plain_text', content: pick(pool.subtitles) },
    icon:     { tag: 'standard_icon', token: vis.icon, color: vis.color },
    template: vis.template,
  };
}

/**
 * 生成完成态 header（绿勾 + "小合" + 随机完成 subtitle 内嵌耗时）
 * @param {string} scene
 * @param {number} durationMs
 */
export function pickCompletionHeader(scene = 'default', durationMs = 0) {
  const pool = SCENE_POOLS[scene] || SCENE_POOLS.default;
  const template = pick(pool.completes) || `已用 {X}s`;
  const subtitle = template.replace('{X}', fmtDuration(durationMs));
  return {
    title:    { tag: 'plain_text', content: BOT_NAME },
    subtitle: { tag: 'plain_text', content: subtitle },
    icon:     { tag: 'standard_icon', token: COMPLETE_HEADER.icon, color: COMPLETE_HEADER.color },
    template: COMPLETE_HEADER.template,
  };
}

export function pickInitialSummary(scene = 'default') {
  const pool = SCENE_POOLS[scene] || SCENE_POOLS.default;
  return pick(pool.summaries);
}

// ============================================================
//  ① 聊天卡片
// ============================================================

/**
 * 聊天卡片初始 JSON — 场景化
 * 只包含一个空 main_text_0，thinking_pill 运行时按轮插入
 */
export function buildChatCardInitial(scene = 'default') {
  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      streaming_config: STREAMING_CONFIG,
      summary: { content: pickInitialSummary(scene) },
      update_multi: true,
      width_mode: 'fill',
    },
    header: pickInitialHeader(scene),
    body: {
      elements: [
        { tag: 'markdown', element_id: 'main_text_0', content: '' },
      ],
    },
  };
}

/**
 * 思考胶囊 — 展开态（思考中）
 * 胶囊在文本开始时不再删除，而是 patch 成收起态带摘要（见 buildPillCollapsePatch）
 * @param {number} round - 轮次，element_id 带 round 后缀
 */
export function buildThinkingPill(round) {
  const id = `thinking_pill_r${round}`;
  const textId = `thinking_text_r${round}`;
  return [
    {
      tag: 'collapsible_panel',
      element_id: id,
      expanded: true,
      background_color: 'default',
      padding: '2px 12px 8px 12px',
      margin: '4px 0 8px 0',
      border: { corner_radius: '12px' },
      header: {
        title: { tag: 'markdown', content: "● 思考中..." },
        vertical_align: 'center',
        padding: '4px 8px 4px 8px',
        icon: { tag: 'standard_icon', token: 'add_outlined', size: '12px 12px', color: 'grey' },
        icon_position: 'right',
        icon_expanded_angle: -45,
      },
      elements: [
        {
          tag: 'markdown',
          element_id: textId,
          content: '',
          text_size: 'notation',
        },
      ],
    },
  ];
}

/**
 * 思考胶囊收起态 patch — 用 patchCardElement 局部更新
 * @param {string|null} summary - 摘要文本（null 则只显示耗时）
 * @param {number} durationSec - 思考耗时（秒）
 */
export function buildPillCollapsePatch(summary, durationSec) {
  const dur = Number(durationSec).toFixed(1);
  const title = summary
    ? `● 思考 ${dur}s · ${summary}`
    : `● 思考 ${dur}s`;
  return {
    expanded: false,
    header: {
      title: { tag: 'markdown', content: title },
    },
  };
}

/** 有效 header template 枚举（飞书官方文档确认） */
export const HEADER_TEMPLATES_VALID = [
  'default', 'blue', 'wathet', 'turquoise', 'green', 'yellow',
  'orange', 'red', 'carmine', 'violet', 'purple', 'indigo', 'grey',
];

/**
 * 根据 LLM 给的 {title, subtitle, template} 构造 header 对象（Stage C 用）
 * icon/color 从 template 派生，LLM 不选
 */
export function buildLLMHeader({ title, subtitle, template } = {}) {
  const tpl = HEADER_TEMPLATES_VALID.includes(template) ? template : 'default';
  const icon = tpl === 'red' ? 'close_outlined' : 'chat_outlined';
  const iconColor = (tpl === 'default' || tpl === 'grey') ? 'orange' : tpl;
  const header = {
    title: { tag: 'plain_text', content: title || BOT_NAME },
    icon: { tag: 'standard_icon', token: icon, color: iconColor },
    template: tpl,
  };
  if (subtitle) header.subtitle = { tag: 'plain_text', content: subtitle };
  return header;
}

/**
 * LLM header 模式下的 initial card（Stage C 用）
 * @param {object} headerObj - buildLLMHeader 返回值
 */
export function buildChatCardInitialFromHeader(headerObj) {
  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      streaming_config: STREAMING_CONFIG,
      summary: { content: '正在回答...' },
      update_multi: true,
      width_mode: 'fill',
    },
    header: headerObj,
    body: {
      elements: [
        { tag: 'markdown', element_id: 'main_text_0', content: '' },
      ],
    },
  };
}

/**
 * 完成态整张卡（card.update 用）
 * @param {string} scene
 * @param {number} durationMs
 * @param {object[]|string} bodyOrText - body elements 数组（多段 + markup 组件），或者纯文本（兜底）
 */
export function buildCompletionCard(scene, durationMs, bodyOrText) {
  const elements = Array.isArray(bodyOrText)
    ? bodyOrText
    : [{ tag: 'markdown', element_id: 'main_text_0', content: String(bodyOrText || '') }];
  return {
    schema: '2.0',
    config: { streaming_mode: false, update_multi: true, width_mode: 'fill' },
    header: pickCompletionHeader(scene, durationMs),
    body: { elements },
  };
}

/**
 * 错误态整张卡（card.update 用）
 */
export function buildErrorCard(errorText) {
  return {
    schema: '2.0',
    config: { streaming_mode: false, update_multi: true, width_mode: 'fill' },
    header: pickInitialHeader('error'),
    body: {
      elements: [
        { tag: 'markdown', element_id: 'main_text_0', content: errorText },
      ],
    },
  };
}

// ============================================================
//  ② 群聊变更通知
// ============================================================

function timeStr(date = new Date()) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function dateStr(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/**
 * @param {string} message
 * @param {object} opts
 * @param {number} opts.changeCount
 * @param {Array<{action,priority,summary}>} [opts.changes]
 */
export function buildNotificationCard(message, { changeCount = 0, changes = [] } = {}) {
  const highCount = changes.filter(c => c.priority === 'high').length;
  const medCount = changes.filter(c => c.priority === 'medium').length;

  const tagList = [];
  if (highCount > 0) tagList.push({ tag: 'text_tag', text: { tag: 'plain_text', content: `${highCount} 项高优` }, color: 'red' });
  if (medCount > 0) tagList.push({ tag: 'text_tag', text: { tag: 'plain_text', content: `${medCount} 项中优` }, color: 'orange' });
  tagList.push({ tag: 'text_tag', text: { tag: 'plain_text', content: 'AI 整理' }, color: 'neutral' });

  const isHighPriority = highCount > 0;

  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: `工作台 · ${changeCount} 项变更` },
      subtitle: { tag: 'plain_text', content: timeStr() },
      text_tag_list: tagList.slice(0, 3),
      icon: {
        tag: 'standard_icon',
        token: 'bell_outlined',
        color: isHighPriority ? 'red' : 'grey',
      },
      template: isHighPriority ? 'red' : 'default',
    },
    body: {
      elements: [
        { tag: 'markdown', element_id: 'notify_body', content: message || '（无内容）' },
        { tag: 'hr' },
        {
          tag: 'markdown',
          content: `<font color='grey'>小合整理 · ${timeStr()}</font>`,
          text_size: 'notation',
        },
      ],
    },
  };
}

// ============================================================
//  ③ 私聊提醒
// ============================================================

export function buildPersonalCard(message, { from = BOT_NAME } = {}) {
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: 'DeskHub 提醒' },
      subtitle: { tag: 'plain_text', content: `来自 ${from}` },
      icon: { tag: 'standard_icon', token: 'bell_outlined', color: 'orange' },
      template: 'default',
    },
    body: {
      elements: [
        { tag: 'markdown', element_id: 'personal_body', content: message || '（无内容）' },
      ],
    },
  };
}

// ============================================================
//  ④ 每日巡检
// ============================================================

export function buildPatrolCard(message, { attentionCount = 0 } = {}) {
  const tagList = [];
  if (attentionCount > 0) {
    tagList.push({
      tag: 'text_tag',
      text: { tag: 'plain_text', content: `${attentionCount} 项关注` },
      color: 'indigo',
    });
  }

  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: '每日巡检' },
      subtitle: { tag: 'plain_text', content: dateStr() },
      text_tag_list: tagList,
      icon: { tag: 'standard_icon', token: 'bitablekanban_outlined', color: 'indigo' },
      template: 'default',
    },
    body: {
      elements: [
        { tag: 'markdown', element_id: 'patrol_body', content: message || '（无内容）' },
        { tag: 'hr' },
        {
          tag: 'markdown',
          content: `<font color='grey'>小合每日巡检 · ${timeStr()}</font>`,
          text_size: 'notation',
        },
      ],
    },
  };
}

// ============================================================
//  ⑤ 简单回复（绑定/背压/错误）
// ============================================================

const SIMPLE_LEVEL_CONFIG = {
  info:    { token: 'info_outlined',    color: 'grey',   template: 'default' },
  success: { token: 'done_outlined',    color: 'green',  template: 'default' },
  warn:    { token: 'warning_outlined', color: 'orange', template: 'default' },
  error:   { token: 'close_outlined',   color: 'red',    template: 'red' },
};

export function buildSimpleCard(content, { level = 'info', title = BOT_NAME, subtitle } = {}) {
  const cfg = SIMPLE_LEVEL_CONFIG[level] || SIMPLE_LEVEL_CONFIG.info;

  const header = {
    title: { tag: 'plain_text', content: title },
    icon: { tag: 'standard_icon', token: cfg.token, color: cfg.color },
    template: cfg.template,
  };
  if (subtitle) header.subtitle = { tag: 'plain_text', content: subtitle };

  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'fill' },
    header,
    body: {
      elements: [
        { tag: 'markdown', element_id: 'reply_body', content: content || '（无内容）' },
      ],
    },
  };
}

// LLM 产的总结文本进飞书 markdown：转义标签/表格注入向量（<>& 防 font/at/text_tag 注入 · | 防表格破坏 · 折叠换行）。
// 不转义 * _ ` [ ]，保留正常文本可读性（这些字符在会议内容里是普通标点，转义反而满屏反斜杠）。
function escMd(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/\s*\n+\s*/g, ' ')
    .trim();
}

// 会议总结卡：服务端把五要素渲染成 CardKit（不让模型产 CardKit JSON，避免坏 schema 整卡失败）
export function buildMeetingSummaryCard(summary, meta = {}) {
  const actions = Array.isArray(summary?.action_items) ? summary.action_items : [];
  const risks = Array.isArray(summary?.risks) ? summary.risks : [];
  const topic = meta.topic || '会议总结';
  const num = (items, empty) => {
    const arr = Array.isArray(items) ? items.filter(Boolean) : [];
    return arr.length ? arr.map((x, i) => `${i + 1}. ${escMd(x)}`).join('\n') : `<font color='grey'>${empty}</font>`;
  };
  const mdCell = escMd;
  const actionTable = actions.length
    ? ['| 事项 | 责任人 | 期限 | 依据 |', '| --- | --- | --- | --- |',
       ...actions.map((x) => `| ${mdCell(x.task)} | ${mdCell(x.owner || '未指定')} | ${mdCell(x.due) || '—'} | ${mdCell(x.evidence) || '—'} |`)].join('\n')
    : "<font color='grey'>（无明确行动项）</font>";
  const metaLine = [
    meta.meetingId ? `\`${meta.meetingId}\`` : '',
    meta.minuteUrl ? `[打开妙记](${meta.minuteUrl})` : '',
  ].filter(Boolean).join('  ·  ');

  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: '会议总结' },
      subtitle: { tag: 'plain_text', content: topic },
      text_tag_list: [
        { tag: 'text_tag', text: { tag: 'plain_text', content: `${actions.length} 行动项` }, color: actions.length ? 'orange' : 'neutral' },
        { tag: 'text_tag', text: { tag: 'plain_text', content: `${risks.length} 风险` }, color: risks.length ? 'red' : 'neutral' },
      ],
      icon: { tag: 'standard_icon', token: 'calendar_outlined', color: 'blue' },
      template: risks.length ? 'orange' : 'blue',
    },
    body: {
      elements: [
        ...(metaLine ? [{ tag: 'markdown', content: metaLine, text_size: 'notation' }] : []),
        { tag: 'markdown', content: `**📌 结论**\n${num(summary?.conclusions, '（无明确结论）')}` },
        { tag: 'markdown', content: `**✅ 行动项**\n${actionTable}` },
        { tag: 'markdown', content: `**⚠️ 风险**\n${num(summary?.risks, '（无）')}` },
        { tag: 'markdown', content: `**❓ 待决问题**\n${num(summary?.open_questions, '（无）')}` },
        { tag: 'markdown', content: `**➡️ 后续**\n${num(summary?.next_steps, '（无）')}` },
        { tag: 'hr' },
        { tag: 'markdown', content: "<font color='grey'>小合 · AI 整理，仅供参考</font>", text_size: 'notation' },
      ],
    },
  };
}
