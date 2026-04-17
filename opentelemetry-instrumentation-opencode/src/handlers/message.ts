import { SeverityNumber } from "@opentelemetry/api-logs"
import { SpanStatusCode } from "@opentelemetry/api"
import type { AssistantMessage, EventMessageUpdated, EventMessagePartUpdated, ReasoningPart, ToolPart, TextPart } from "@opencode-ai/sdk"
import {
  accumulateSessionTotals,
  errorSummary,
  genAiSpanAttrs,
  genAiSpanName,
  isMetricEnabled,
  isTraceEnabled,
  setBoundedMap,
  startChildSpan,
  truncate,
  truncateMessages,
} from "../util.ts"
import type { ActiveInvocation, ActiveMessageSpan, HandlerContext } from "../types.ts"
import type { AttributeValue } from "@opentelemetry/api"

/** Merges deferred text parts (no `time.start` yet) into a newly opened LLM span. */
function flushDeferredMessageText(sessionID: string, messageID: string, active: ActiveMessageSpan, ctx: HandlerContext) {
  const key = `${sessionID}:${messageID}`
  const deferred = ctx.deferredMessageTextParts.get(key)
  if (!deferred) return
  for (const [id, text] of deferred) active.textParts.set(id, text)
  ctx.deferredMessageTextParts.delete(key)
}

/**
 * Gets or creates an LLM span for the given message. Created on the first
 * `message.part.updated` so that tool spans can be parented correctly.
 * Returns `null` when tracing is disabled.
 */
function getOrCreateLLMSpan(
  sessionID: string,
  messageID: string,
  ctx: HandlerContext,
  startTime?: number,
): ActiveMessageSpan | null {
  const key = `${sessionID}:${messageID}`
  const existing = ctx.activeMessageSpans.get(key)
  if (existing) return existing

  if (!isTraceEnabled(ctx) || !ctx.tracer) return null

  const invocation = getOrCreateInvocation(sessionID, ctx, startTime)
  if (!invocation) return null
  const stepRound = invocation.nextStepRound
  invocation.nextStepRound += 1
  const span = startChildSpan(
    ctx.tracer,
    genAiSpanName("chat"),
    genAiSpanAttrs("LLM", "chat", sessionID, ctx.commonAttrs, {
      "gen_ai.react.round": stepRound,
      "gen_ai.loop.id": invocation.invocationID,
      "gen_ai.loop.iteration": stepRound,
    }),
    invocation.agentContext,
    startTime,
  )

  const active: ActiveMessageSpan = {
    span,
    context: span.spanContext(),
    stepRound,
    invocationID: invocation.invocationID,
    sessionID,
    messageID,
    textParts: new Map(),
    toolCalls: [],
    toolResults: [],
  }
  setBoundedMap(ctx.activeMessageSpans, key, active)
  flushDeferredMessageText(sessionID, messageID, active, ctx)
  return active
}

function getOrCreateInvocation(
  sessionID: string,
  ctx: HandlerContext,
  startTime?: number,
): ActiveInvocation | null {
  const existing = ctx.activeInvocations.get(sessionID)
  if (existing) return existing
  if (!isTraceEnabled(ctx) || !ctx.tracer) return null
  const nextSeq = (ctx.sessionInvocationSeq.get(sessionID) ?? 0) + 1
  ctx.sessionInvocationSeq.set(sessionID, nextSeq)
  const invocationID = `${sessionID}:${nextSeq}`
  const entrySpan = startChildSpan(
    ctx.tracer,
    genAiSpanName("enter"),
    genAiSpanAttrs("ENTRY", "enter", sessionID, ctx.commonAttrs),
    undefined,
    startTime,
  )
  const agentMeta = ctx.sessionAgentMeta.get(sessionID)
  const agentName = agentMeta?.name ?? "opencode-agent"
  const agentAttrs: Record<string, AttributeValue> = { "gen_ai.agent.name": agentName }
  if (agentMeta?.id) agentAttrs["gen_ai.agent.id"] = agentMeta.id
  if (agentMeta?.description) agentAttrs["gen_ai.agent.description"] = agentMeta.description
  const agentSpan = startChildSpan(
    ctx.tracer,
    genAiSpanName("invoke_agent", agentName),
    genAiSpanAttrs("AGENT", "invoke_agent", sessionID, ctx.commonAttrs, agentAttrs),
    entrySpan.spanContext(),
    startTime,
  )
  const invocation: ActiveInvocation = {
    invocationID,
    sessionID,
    requestSeq: nextSeq,
    entrySpan,
    entryContext: entrySpan.spanContext(),
    agentSpan,
    agentContext: agentSpan.spanContext(),
    nextStepRound: 1,
  }
  setBoundedMap(ctx.activeInvocations, sessionID, invocation)
  return invocation
}

/** Safely parses a JSON string into an object; returns the raw string on failure. */
function tryParseJson(s: string): unknown {
  try { return JSON.parse(s) } catch { return s }
}

/**
 * Builds `gen_ai.input.messages`: user prompt + accumulated conversation history
 * (previous assistant outputs and tool results).
 *
 * Format uses `parts` arrays per the GenAI semantic conventions.
 */
function buildInputMessages(sessionID: string, ctx: HandlerContext): unknown[] {
  const msgs: unknown[] = []
  const systemPrompt = ctx.pendingSystemPrompts.get(sessionID)
  if (systemPrompt) {
    msgs.push({ role: "system", parts: [{ type: "text", content: systemPrompt }] })
  }
  const userPrompt = ctx.pendingUserPrompts.get(sessionID)
  if (userPrompt) {
    msgs.push({ role: "user", parts: [{ type: "text", content: userPrompt }] })
  }
  const history = ctx.sessionHistory.get(sessionID)
  if (history) {
    msgs.push(...history)
  }
  return msgs
}

/**
 * Appends the current LLM call's output (assistant message + tool results)
 * to the session's conversation history for use as input in subsequent calls.
 */
function appendToSessionHistory(sessionID: string, active: ActiveMessageSpan, ctx: HandlerContext) {
  const history = ctx.sessionHistory.get(sessionID) ?? []

  // Append assistant output: text parts + tool_call parts
  const parts: unknown[] = []
  const textContent = [...active.textParts.values()].join("")
  if (textContent) parts.push({ type: "text", content: textContent })
  for (const tc of active.toolCalls) {
    parts.push({ type: "tool_call", id: tc.callID, name: tc.name, arguments: tryParseJson(tc.arguments) })
  }
  if (parts.length > 0) {
    history.push({ role: "assistant", parts })
  }

  // Append tool results as separate role=tool messages
  for (const r of active.toolResults) {
    history.push({ role: "tool", parts: [{ type: "tool_call_response", id: r.callID, response: r.content }] })
  }

  ctx.sessionHistory.set(sessionID, history)
}

/**
 * Builds `gen_ai.output.messages`: assistant text parts + tool_call parts.
 */
function buildOutputMessages(active: ActiveMessageSpan): unknown[] {
  const parts: unknown[] = []
  const textContent = [...active.textParts.values()].join("")
  if (textContent) parts.push({ type: "text", content: textContent })
  for (const tc of active.toolCalls) {
    parts.push({ type: "tool_call", id: tc.callID, name: tc.name, arguments: tryParseJson(tc.arguments) })
  }
  if (parts.length === 0) return []
  return [{ role: "assistant", parts }]
}

/**
 * Handles a completed assistant message: increments token and cost counters and emits
 * either an `api_request` or `api_error` log event depending on whether the message errored.
 * Finalizes the LLM span (created earlier by part events) with model attributes and timing.
 */
export function handleMessageUpdated(e: EventMessageUpdated, ctx: HandlerContext) {
  const msg = e.properties.info
  if (msg.role !== "assistant") {
    // Discard any LLM span accidentally created by text parts for non-assistant messages.
    // Not calling span.end() ensures BatchSpanProcessor never exports the orphan.
    const msgInfo = msg as { sessionID: string; id: string }
    const orphanKey = `${msgInfo.sessionID}:${msgInfo.id}`
    ctx.activeMessageSpans.delete(orphanKey)
    return
  }
  const assistant = msg as AssistantMessage
  if (!assistant.time.completed) return

  const { sessionID, modelID, providerID } = assistant
  const duration = assistant.time.completed - assistant.time.created

  const totalTokens = assistant.tokens.input + assistant.tokens.output + assistant.tokens.reasoning
    + assistant.tokens.cache.read + assistant.tokens.cache.write

  if (isMetricEnabled("token.usage", ctx)) {
    const { tokenCounter } = ctx.instruments
    tokenCounter.add(assistant.tokens.input, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, type: "input" })
    tokenCounter.add(assistant.tokens.output, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, type: "output" })
    tokenCounter.add(assistant.tokens.reasoning, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, type: "reasoning" })
    tokenCounter.add(assistant.tokens.cache.read, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, type: "cacheRead" })
    tokenCounter.add(assistant.tokens.cache.write, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, type: "cacheCreation" })
  }

  if (isMetricEnabled("cost.usage", ctx)) {
    ctx.instruments.costCounter.add(assistant.cost, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID })
  }

  if (isMetricEnabled("cache.count", ctx)) {
    if (assistant.tokens.cache.read > 0) {
      ctx.instruments.cacheCounter.add(1, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, type: "cacheRead" })
    }
    if (assistant.tokens.cache.write > 0) {
      ctx.instruments.cacheCounter.add(1, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, type: "cacheCreation" })
    }
  }

  if (isMetricEnabled("message.count", ctx)) {
    ctx.instruments.messageCounter.add(1, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID })
  }

  if (isMetricEnabled("model.usage", ctx)) {
    ctx.instruments.modelUsageCounter.add(1, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, provider: providerID })
  }

  accumulateSessionTotals(sessionID, totalTokens, assistant.cost, ctx)

  ctx.log("debug", "otel: token+cost counters incremented", {
    sessionID,
    model: modelID,
    input: assistant.tokens.input,
    output: assistant.tokens.output,
    reasoning: assistant.tokens.reasoning,
    cacheRead: assistant.tokens.cache.read,
    cacheWrite: assistant.tokens.cache.write,
    cost_usd: assistant.cost,
  })

  const hasError = assistant.error !== undefined

  // Finalize the LLM span (created by part events, or create now if no parts arrived)
  const msgKey = `${sessionID}:${assistant.id}`
  const active = ctx.activeMessageSpans.get(msgKey)
    ?? getOrCreateLLMSpan(sessionID, assistant.id, ctx, assistant.time.created)

  if (active) {
    const { span } = active
    span.updateName(genAiSpanName("chat", modelID))
    span.setAttribute("gen_ai.request.model", modelID)
    span.setAttribute("gen_ai.provider.name", providerID)
    span.setAttribute("gen_ai.usage.input_tokens", assistant.tokens.input)
    span.setAttribute("gen_ai.usage.output_tokens", assistant.tokens.output)
    span.setAttribute("gen_ai.usage.total_tokens", totalTokens)
    span.setAttribute("cost_usd", assistant.cost)
    span.setAttribute("duration_ms", duration)

    const maxLen = ctx.maxContentSize
    const inputMsgs = truncateMessages(buildInputMessages(sessionID, ctx), maxLen)
    if (inputMsgs.length > 0) {
      span.setAttribute("gen_ai.input.messages", JSON.stringify(inputMsgs))
    }

    const outputMsgs = truncateMessages(buildOutputMessages(active), maxLen)
    const outputMsgsJson = outputMsgs.length > 0 ? JSON.stringify(outputMsgs) : undefined
    if (outputMsgsJson) {
      span.setAttribute("gen_ai.output.messages", outputMsgsJson)
    }

    // Append this round's assistant output + tool results to conversation history
    appendToSessionHistory(sessionID, active, ctx)

    if (hasError) {
      span.setAttribute("gen_ai.react.finish_reason", "error")
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorSummary(assistant.error) })
    } else {
      span.setAttribute("gen_ai.react.finish_reason", "success")
      span.setStatus({ code: SpanStatusCode.OK })
    }
    span.end(assistant.time.completed)
    ctx.activeMessageSpans.delete(msgKey)

    const invocation = ctx.activeInvocations.get(sessionID)
    if (invocation) {
      if (outputMsgsJson) {
        invocation.entrySpan.setAttribute("gen_ai.output.messages", outputMsgsJson)
        invocation.agentSpan.setAttribute("gen_ai.output.messages", outputMsgsJson)
      }
    }
  }

  if (hasError) {
    ctx.logger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: "ERROR",
      timestamp: assistant.time.created,
      observedTimestamp: Date.now(),
      body: "api_error",
      attributes: {
        "event.name": "api_error",
        "session.id": sessionID,
        model: modelID,
        provider: providerID,
        error: errorSummary(assistant.error),
        duration_ms: duration,
        ...ctx.commonAttrs,
      },
    })
    return ctx.log("error", "otel: api_error", {
      sessionID,
      model: modelID,
      error: errorSummary(assistant.error),
      duration_ms: duration,
    })
  }

  ctx.logger.emit({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: assistant.time.created,
    observedTimestamp: Date.now(),
    body: "api_request",
    attributes: {
      "event.name": "api_request",
      "session.id": sessionID,
      model: modelID,
      provider: providerID,
      cost_usd: assistant.cost,
      duration_ms: duration,
      input_tokens: assistant.tokens.input,
      output_tokens: assistant.tokens.output,
      reasoning_tokens: assistant.tokens.reasoning,
      cache_read_tokens: assistant.tokens.cache.read,
      cache_creation_tokens: assistant.tokens.cache.write,
      ...ctx.commonAttrs,
    },
  })
  return ctx.log("info", "otel: api_request", {
    sessionID,
    model: modelID,
    cost_usd: assistant.cost,
    duration_ms: duration,
    input_tokens: assistant.tokens.input,
    output_tokens: assistant.tokens.output,
  })
}

/**
 * Tracks tool execution time between `running` and `completed`/`error` part updates,
 * records a `tool.duration` histogram measurement, and emits a `tool_result` log event.
 * Also buffers text parts for the LLM span's output messages.
 */
export function handleMessagePartUpdated(e: EventMessagePartUpdated, ctx: HandlerContext) {
  const part = e.properties.part

  // Buffer text parts on the LLM span for gen_ai.output.messages
  if (part.type === "text") {
    const textPart = part as TextPart
    const key = `${textPart.sessionID}:${textPart.messageID}`
    const existing = ctx.activeMessageSpans.get(key)
    if (existing) {
      existing.textParts.set(textPart.id, textPart.text)
      return
    }
    const t0 = textPart.time?.start
    if (t0 === undefined) {
      let inner = ctx.deferredMessageTextParts.get(key)
      if (!inner) {
        inner = new Map()
        setBoundedMap(ctx.deferredMessageTextParts, key, inner)
      }
      inner.set(textPart.id, textPart.text)
      return
    }
    const active = getOrCreateLLMSpan(textPart.sessionID, textPart.messageID, ctx, t0)
    if (active) active.textParts.set(textPart.id, textPart.text)
    return
  }

  if (part.type === "reasoning") {
    const rp = part as ReasoningPart
    getOrCreateLLMSpan(rp.sessionID, rp.messageID, ctx, rp.time.start)
    return
  }

  if (part.type !== "tool") return

  const toolPart = part as ToolPart
  const key = `${toolPart.sessionID}:${toolPart.callID}`

  if (toolPart.state.status === "running") {
    setBoundedMap(ctx.pendingToolSpans, key, {
      tool: toolPart.tool,
      sessionID: toolPart.sessionID,
      startMs: toolPart.state.time.start,
    })
    if (isTraceEnabled(ctx) && ctx.tracer) {
      const llmSpan = getOrCreateLLMSpan(toolPart.sessionID, toolPart.messageID, ctx, toolPart.state.time.start)
      const parentCtx = llmSpan?.context
        ?? ctx.activeInvocations.get(toolPart.sessionID)?.agentContext
      const rawInput = typeof toolPart.state.input === "string"
        ? toolPart.state.input
        : JSON.stringify(toolPart.state.input)
      const toolSpan = startChildSpan(
        ctx.tracer,
        genAiSpanName("execute_tool", toolPart.tool),
        genAiSpanAttrs("TOOL", "execute_tool", toolPart.sessionID, ctx.commonAttrs, {
          "gen_ai.tool.name": toolPart.tool,
          "gen_ai.tool.call.id": toolPart.callID,
          "gen_ai.tool.call.arguments": rawInput,
          "gen_ai.react.round": llmSpan?.stepRound ?? 0,
          "gen_ai.loop.id": ctx.activeInvocations.get(toolPart.sessionID)?.invocationID ?? "",
          "gen_ai.loop.iteration": llmSpan?.stepRound ?? 0,
        }),
        parentCtx,
        toolPart.state.time.start,
      )
      setBoundedMap(ctx.activeToolSpans, key, {
        span: toolSpan,
        tool: toolPart.tool,
        sessionID: toolPart.sessionID,
        startMs: toolPart.state.time.start,
      })
      // Record tool call on the LLM span for gen_ai.output.messages (deduplicate by callID)
      if (llmSpan && !llmSpan.toolCalls.some(tc => tc.callID === toolPart.callID)) {
        llmSpan.toolCalls.push({
          callID: toolPart.callID,
          name: toolPart.tool,
          arguments: rawInput,
        })
      }
    }
    ctx.log("debug", "otel: tool span started", { sessionID: toolPart.sessionID, tool: toolPart.tool, key })
    return
  }

  if (toolPart.state.status !== "completed" && toolPart.state.status !== "error") return

  const span = ctx.pendingToolSpans.get(key)
  ctx.pendingToolSpans.delete(key)
  const start = span?.startMs ?? toolPart.state.time.start
  const end = toolPart.state.time.end
  if (end === undefined) return
  const duration_ms = end - start
  const success = toolPart.state.status === "completed"

  if (isMetricEnabled("tool.duration", ctx)) {
    ctx.instruments.toolDurationHistogram.record(duration_ms, {
      ...ctx.commonAttrs,
      "session.id": toolPart.sessionID,
      tool_name: toolPart.tool,
      success,
    })
  }

  const sizeAttr = success
    ? { tool_result_size_bytes: Buffer.byteLength((toolPart.state as { output: string }).output, "utf8") }
    : { error: (toolPart.state as { error: string }).error }

  ctx.logger.emit({
    severityNumber: success ? SeverityNumber.INFO : SeverityNumber.ERROR,
    severityText: success ? "INFO" : "ERROR",
    timestamp: start,
    observedTimestamp: Date.now(),
    body: "tool_result",
    attributes: {
      "event.name": "tool_result",
      "session.id": toolPart.sessionID,
      tool_name: toolPart.tool,
      success,
      duration_ms,
      ...sizeAttr,
      ...ctx.commonAttrs,
    },
  })

  const rawOutput = success ? (toolPart.state as { output: string }).output : ""
  const truncatedOutput = success ? truncate(rawOutput, ctx.maxContentSize) : ""

  const activeToolSpan = ctx.activeToolSpans.get(key)
  if (activeToolSpan) {
    ctx.activeToolSpans.delete(key)
    activeToolSpan.span.setAttribute("duration_ms", duration_ms)
    if (success) {
      activeToolSpan.span.setAttribute("gen_ai.tool.call.result", truncatedOutput)
      activeToolSpan.span.setStatus({ code: SpanStatusCode.OK })
    } else {
      const errStr = (toolPart.state as { error: string }).error
      activeToolSpan.span.setStatus({ code: SpanStatusCode.ERROR, message: errStr })
    }
    activeToolSpan.span.end(end)
  }

  // Record tool result on the LLM span for next round's gen_ai.input.messages
  if (success) {
    const msgKey = `${toolPart.sessionID}:${toolPart.messageID}`
    const llmSpan = ctx.activeMessageSpans.get(msgKey)
    if (llmSpan && !llmSpan.toolResults.some(tr => tr.callID === toolPart.callID)) {
      llmSpan.toolResults.push({
        callID: toolPart.callID,
        name: toolPart.tool,
        content: truncatedOutput,
      })
    }
  }

  ctx.log("debug", "otel: tool.duration histogram recorded", {
    sessionID: toolPart.sessionID,
    tool_name: toolPart.tool,
    duration_ms,
    success,
  })
  return ctx.log(success ? "info" : "error", "otel: tool_result", {
    sessionID: toolPart.sessionID,
    tool_name: toolPart.tool,
    success,
    duration_ms,
  })
}
