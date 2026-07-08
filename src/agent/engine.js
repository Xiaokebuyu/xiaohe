/**
 * Engine — 内化后的 agent 循环（脱胎自 agent-loop.js 的 MiniMax stream 核心）
 *
 * 保留旧 loop 已验证的一切：流式 text/thinking 增量、交错思考、完整 assistant content
 * 按序入历史、per-tool 超时 + AbortController、结构化 error + retryable 分类、全失败提前终止。
 *
 * 相对旧 loop 的新增（harness 边界）：
 *   - 工具来自 ToolRegistry（按 runMode 过滤后的 Anthropic schema），不再吃扁平数组
 *   - 每次工具调用前过 PermissionEngine.canUseTool（两层权限）；deny → 把拒绝原因作为
 *     tool_result 喂回模型（is_error），让它换法或解释，而不是静默失败
 *   - 通过 tool.call(input, ctx) 执行，ctx 带 signal / runMode / boundUser
 *
 * step 1 范围：工具串行执行（并发分批 = step 5）；pause（写审批）= step 2，此处遇到 pause
 * 先当 deny 兜底并记日志（readOnly 模式不会触发）。
 */

const ERROR_TEXT = '抱歉，我暂时无法处理请求，请稍后再试。';
const TOOL_TIMEOUT_MS = Number(process.env.BOT_TOOL_TIMEOUT_MS) || 30_000;

function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content.filter(b => b.type === 'text').map(b => b.text).join('\n');
}

/** 单工具执行加超时 + abort。tool.call 接 ctx.signal 才能真正释放底层 fetch。 */
function callWithTimeout(tool, input, ctx, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const err = new Error(`工具 ${tool.name} 执行超过 ${timeoutMs}ms 未返回`);
      err.code = 'TOOL_TIMEOUT';
      reject(err);
    }, timeoutMs);
  });
  const toolCtx = { ...ctx, signal: controller.signal };
  return Promise.race([
    Promise.resolve().then(() => tool.call(input, toolCtx)),
    timeoutPromise,
  ]).finally(() => clearTimeout(timer));
}

/**
 * 跑一次 agent 循环。
 *
 * @param {Object} opts
 * @param {import('./model-client.js').client} opts.client
 * @param {string} opts.model
 * @param {number} opts.maxTokens
 * @param {number} opts.maxRounds
 * @param {(round:number)=>(string|object[])} opts.buildSystem
 * @param {Array} opts.initialMessages
 * @param {import('./tool-registry.js').ToolRegistry} opts.registry
 * @param {import('./permissions.js').PermissionEngine} opts.permissions
 * @param {import('./tool.js').XiaoheToolContext} opts.baseCtx
 * @param {object} [opts.thinking]
 * @param {boolean} [opts.interleaved]
 * @param {object} [opts.headers]         interleaved thinking headers
 * @param {Function} [opts.onTextChunk]   (delta, round) => void
 * @param {Function} [opts.onThinkingChunk]
 * @param {Function} [opts.onRoundStart]
 * @param {Function} [opts.onToolStart]   (toolSteps) => Promise|void
 * @param {Function} [opts.onToolDone]    (toolSteps) => Promise|void
 * @returns {Promise<{text,toolSteps,toolSummaries,truncated?,exhausted?,allFailed?,final?}>}
 */
export async function runEngine(opts) {
  const {
    client, model, maxTokens, maxRounds,
    buildSystem, initialMessages,
    registry, permissions, baseCtx,
    thinking, interleaved = false, headers,
    onTextChunk, onThinkingChunk, onRoundStart, onToolStart, onToolDone,
  } = opts;

  const messages = [...initialMessages];
  const toolSteps = [];
  const toolSummaries = [];

  for (let round = 0; round < maxRounds; round++) {
    onRoundStart?.(round);

    const body = {
      model,
      max_tokens: maxTokens,
      system: buildSystem(round, { messages, toolSummaries }),
      messages,
      tools: registry.toAnthropicTools(baseCtx),
    };
    if (thinking) body.thinking = thinking;

    const requestOpts = interleaved && headers ? { headers } : undefined;
    const stream = client.messages.stream(body, requestOpts);

    let textCount = 0, thinkingCount = 0;
    if (onTextChunk) {
      stream.on('text', (delta) => { textCount++; onTextChunk(delta, round); });
    }
    if (onThinkingChunk) {
      stream.on('streamEvent', (evt) => {
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'thinking_delta') {
          thinkingCount++;
          onThinkingChunk(evt.delta.thinking, round);
        }
      });
    }

    let final;
    try {
      final = await stream.finalMessage();
    } catch (err) {
      console.error('[Engine] stream 失败:', err.message);
      throw err;
    }

    const blockTypes = final.content.map(b => b.type).join(',');
    console.log(
      `[Engine] round=${round} blocks=[${blockTypes}] `
      + `chunks(text=${textCount},thinking=${thinkingCount}) `
      + `tokens(in=${final.usage?.input_tokens},out=${final.usage?.output_tokens},`
      + `cacheR=${final.usage?.cache_read_input_tokens || 0}) `
      + `stop=${final.stop_reason} mode=${baseCtx.runMode}`
    );

    messages.push({ role: 'assistant', content: final.content });

    const hasToolUse = final.content.some(b => b.type === 'tool_use');

    if (final.stop_reason === 'max_tokens') {
      const partial = extractText(final.content);
      const text = partial ? partial + '\n\n_(回复过长被截断)_' : ERROR_TEXT;
      return { text, toolSteps, toolSummaries, truncated: true, final };
    }

    if (final.stop_reason === 'end_turn' || !hasToolUse) {
      const text = extractText(final.content) || ERROR_TEXT;
      return { text, toolSteps, toolSummaries, final };
    }

    // ── 执行工具（step 1：串行）──
    const toolUseBlocks = final.content.filter(b => b.type === 'tool_use');
    const newSteps = toolUseBlocks.map(b => ({ name: b.name, blockId: b.id, done: false }));
    toolSteps.push(...newSteps);

    if (onToolStart) await onToolStart(toolSteps);

    const toolResults = [];
    const errorInfos = [];

    for (const block of toolUseBlocks) {
      const { content, isError, errorInfo } = await executeOne(block, { registry, permissions, baseCtx });

      const tr = { type: 'tool_result', tool_use_id: block.id, content };
      if (isError) tr.is_error = true;
      toolResults.push(tr);
      errorInfos.push(errorInfo);

      const inputBrief = JSON.stringify(block.input).slice(0, 80);
      const marker = isError ? `失败(${errorInfo?.category || 'error'})` : '成功';
      toolSummaries.push(`${block.name}(${inputBrief}) → ${marker}`);

      const step = toolSteps.find(s => s.blockId === block.id);
      if (step) { step.done = true; if (errorInfo) step.error = errorInfo; }
    }

    if (onToolDone) await onToolDone(toolSteps);

    messages.push({ role: 'user', content: toolResults });

    // 全失败且均不可重试 → 提前终止
    const failed = errorInfos.filter(Boolean);
    if (failed.length === toolUseBlocks.length && failed.length > 0) {
      if (!failed.some(e => e.retryable)) {
        const summary = toolSummaries.slice(-failed.length).join('\n');
        return {
          text: `${ERROR_TEXT}\n\n本轮尝试：\n${summary}`,
          toolSteps, toolSummaries, allFailed: true, exhausted: true,
        };
      }
    }
  }

  const tail = toolSummaries.slice(-3).join('\n');
  const hint = tail ? `\n\n最近尝试：\n${tail}` : '';
  return {
    text: `查询过程过于复杂，请尝试更简单的问题。${hint}`,
    toolSteps, toolSummaries, exhausted: true,
  };
}

/** 执行单个 tool_use block：权限闸门 → validate → call。返回 tool_result content 字符串。 */
async function executeOne(block, { registry, permissions, baseCtx }) {
  const tool = registry.get(block.name);
  if (!tool) {
    const errorInfo = { category: 'unknown_tool', message: `未知工具 ${block.name}`, retryable: false, tool: block.name };
    return { content: JSON.stringify({ ok: false, error: errorInfo }, null, 2), isError: true, errorInfo };
  }

  try {
    const decision = await permissions.canUseTool(tool, block.input, baseCtx);

    if (decision.behavior === 'deny') {
      // 拒绝作为 tool_result 喂回模型（非异常）——让它换法或向用户解释
      const errorInfo = { category: 'permission_denied', message: decision.message, retryable: false, tool: block.name };
      return { content: JSON.stringify({ ok: false, error: errorInfo }, null, 2), isError: true, errorInfo };
    }
    if (decision.behavior === 'pause') {
      // step 2 才实装 pause/resume；step 1（readOnly）不会走到这里，兜底当 deny
      console.warn(`[Engine] ${block.name} 返回 pause 但 step 1 尚未实装审批回环，暂拒绝`);
      const errorInfo = { category: 'approval_required', message: '该写操作需要用户确认（审批回环尚未启用）', retryable: false, tool: block.name };
      return { content: JSON.stringify({ ok: false, error: errorInfo }, null, 2), isError: true, errorInfo };
    }

    const input = decision.updatedInput ?? block.input;
    await tool.validateInput(input, baseCtx);
    const out = await callWithTimeout(tool, input, baseCtx, TOOL_TIMEOUT_MS);

    // 识别业务函数返回的结构化 error shape
    if (out && out.ok === false && out.error) {
      return { content: JSON.stringify(out, null, 2), isError: true, errorInfo: out.error };
    }
    return { content: JSON.stringify(out, null, 2), isError: false, errorInfo: null };
  } catch (err) {
    const category = err?.code === 'TOOL_TIMEOUT' ? 'timeout' : 'unknown';
    const errorInfo = { category, message: err?.message || String(err), retryable: category === 'timeout', tool: block.name };
    console.error(`[Engine] 工具 ${block.name} 异常 (${category}):`, err?.message);
    return { content: JSON.stringify({ ok: false, error: errorInfo }, null, 2), isError: true, errorInfo };
  }
}

export { ERROR_TEXT };
