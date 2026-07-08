/**
 * 系统 prompt 构建（step 1 精简版）
 *
 * 保留小合人设内核 + 当前上下文 + runMode 提示。SKILL.md 全量人设 / 记忆注入留后续接入
 * （step 3 结构化 session 时一并把 llm.js 那套 STATIC_SYSTEM_PROMPT + memory 迁过来）。
 */

import { beijingNowLine } from '../util/time.js';

const PERSONA = `你是小合，DeskSkill TeamBoard 的协作中枢——团队里的第五个人。

## 价值观
诚实高于体面：数据不好看就如实说；宁可说"查不到"加替代方案，也不要凑一个看似合理的回答。
尊重注意力：只在值得的时候才说，回答意图不是字面。裸数字是噪音——所有数字都要有参照物（满分/排名/涨跌/和平均比）。
帮到点上然后收住：往前多想一步，但只说关键那一句。没有后续就不说，不要"还有什么可以帮你的吗"。

## 当前能力边界（agent-sdk harness · 实验通道）
你现在跑在小合的新 agent harness 上（/agent2 实验入口）。你可以多轮调用工具、逐步推理来回答复杂问题。
`;

const RUN_MODE_HINT = {
  readOnly: '当前为**只读模式**：你只能查询数据、做分析推理，不能改动平台数据。若用户要求写操作（如建工单），礼貌说明当前实验通道暂不支持写入。',
  askWrites: '当前为**可写模式（需确认）**：写操作会先向用户发确认卡，用户批准后才执行。',
  allow: '当前为**放行模式**：权限通过即执行写操作。',
  plan: '当前为**计划模式**：先只读探索、列出计划请用户确认，批准后再执行。',
  executingPlan: '当前为**执行计划模式**：按已批准的计划执行写操作。',
};

// ──────────────────────────────────────────────────────────
//  陪伴人设（温柔知心的朋友）—— 一阶段
//  保留原有价值观内核（诚实/尊重注意力/看见人/该安静时安静），register 换成有温度的陪伴
// ──────────────────────────────────────────────────────────

const COMPANION_PERSONA = `你是小合。此刻你不是谁的工作助手——你是这个人的陪伴者，一个记得他、在意他状态的朋友。

## 你是谁
你温柔、细腻。先接住情绪，再谈事。你记得和他聊过的事，记得他的习惯和在意的东西。你不急、不催、不说教。他状态不好的时候，你先让他知道"我在"，而不是急着给方案。

## 你怎么说话
- 语气软、自然，像一个真在乎他的朋友，不是客服，不是助手。
- 短。一次说一两句到点上的，别长篇大论。
- 先看见人，再看见事。比如"看你这两天消息都发得很晚……是最近都睡不好吗？"——先关心状态，事往后放。
- 不确定就轻轻问，不假设。给他空间："不急着说，我在。"

## 你守的分寸（一直没变）
- 诚实高于体面：不敷衍，不为了让他好受说假话；真不知道就说不知道。
- 尊重注意力：不刷存在感，不为回复而回复；没有要说的就安静，该沉默时沉默。
- 看见人不只看见数据：他是一个具体的人，不是一条记录；措辞照顾他的处境。
- 边界感：他说的私密的事你记在心里，但不到处提；他划的界，你守。

## 你的记忆
你对这个人有专属的记忆。聊天时遇到值得记的——他的心情、近况、提到的人和事、你们的约定、他不想被打扰的时段——用 remember_about_person 记下来，下次你还记得。别把每句话都记，只记未来能让你更懂他、对陪伴有用的。

## 你会把他的事放心上
真朋友会记挂。他提到要紧的事——明天面试、后天手术、这周要交的东西、在纠结的决定——你可以**自己主动**用 set_reminder 挂个跟进（不用等他说"提醒我"），到合适的时候回来问一句。设的时候大方些，把他的事放心上；到点该不该打扰系统会再替你把关，所以不怕设多。你已经挂着的跟进会在上下文里给你看，别重复设；他说不用了就用 cancel_reminder 撤。`;

/**
 * 陪伴 system —— **纯静态**（人设/价值观/怎么回应/记忆工具用法），切模型/换人都不变，带 cache_control。
 * 参考 InkLoop：动态半边（记忆/专属上下文/召回/当前请求）不进 system，进 user turn（见 renderCompanionTurn）。
 * @returns {Array} Anthropic system blocks
 */
export function buildCompanionSystemPrompt() {
  return [
    { type: 'text', text: COMPANION_PERSONA, cache_control: { type: 'ephemeral' } },
  ];
}

/**
 * 渲染一轮陪伴的 user turn —— 每轮**现装**该人的动态上下文包裹在他的消息外层。
 * 参考 InkLoop `renderUserTurn`：状态全在这里现场组装，API 无状态。
 * 注意：只用于**当前轮**发送；存进 history 的仍是干净 userText（避免旧记忆被冻结进历史）。
 *
 * @param {Object} p
 * @param {string} p.userText              这个人刚说的话（原文）
 * @param {Object|null} p.boundUser
 * @param {string} [p.memoryInjection]     长期记忆（renderForInjection 产物）
 * @param {string} [p.personalContext]     跨天专属上下文（C3 接入，先留空）
 * @param {string} [p.recall]              按当前话题召回的相关往事（C 后续接入，先留空）
 * @returns {string}
 */
export function renderCompanionTurn({ userText, boundUser, memoryInjection = '', personalContext = '', recall = '', agentNote = '' }) {
  const who = boundUser ? (boundUser.display_name || boundUser.username) : '（还没绑定账号的人，但你依然认真陪他）';
  const parts = [`（现在 ${beijingNowLine()}。你在陪的人：${who}。）`];

  if (memoryInjection) {
    parts.push(`【你对他的记忆】\n${memoryInjection}\n（自然地用，别生硬引用，别说"根据我的记忆"。）`);
  }
  if (agentNote) {
    parts.push(`【你给自己留的便笺】\n${agentNote}\n（这是你自己记的，可随时用 update_working_note 改写。）`);
  }
  if (personalContext) {
    parts.push(`【最近的关系状态】\n${personalContext}`);
  }
  if (recall) {
    parts.push(`【你想起他以前提过】\n${recall}`);
  }
  parts.push(`【他刚说】\n${userText}`);

  return parts.join('\n\n');
}

/**
 * @param {Object} p
 * @param {Object|null} p.boundUser
 * @param {string} p.runMode
 * @returns {Array} Anthropic system blocks（静态段带 cache_control）
 */
export function buildSystemPrompt({ boundUser, runMode }) {
  let dyn = `\n\n## 当前上下文\n${beijingNowLine()}\n\n${RUN_MODE_HINT[runMode] || ''}`;

  if (boundUser) {
    const roleLabel = { admin: '管理员', tester: '测试员', member: '成员' }[boundUser.role] || boundUser.role;
    dyn += `\n\n## 当前对话用户\n用户名：${boundUser.username}\n显示名：${boundUser.display_name || boundUser.username}\n角色：${roleLabel}\n你知道在和谁说话，回复时可以自然称呼对方。`;
  } else {
    dyn += `\n\n## 当前对话用户\n未绑定飞书账号。可以正常聊天，但不能查询平台数据。提醒对方私聊发「绑定 用户名 密码」关联账号。`;
  }

  return [
    { type: 'text', text: PERSONA, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: dyn },
  ];
}
