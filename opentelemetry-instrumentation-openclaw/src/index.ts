// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import { ArmsExporter } from "./arms-exporter.js";
import type {
  AfterToolCallEvent,
  AgentEndEvent,
  ArmsTraceConfig,
  BeforeAgentStartEvent,
  BeforeToolCallEvent,
  GatewayStartEvent,
  LlmInputEvent,
  LlmOutputEvent,
  MessageReceivedEvent,
  MessageSendingEvent,
  MessageSentEvent,
  OpenClawPlugin,
  OpenClawPluginApi,
  PluginHookContext,
  SessionEndEvent,
  SessionStartEvent,
  SpanData,
} from "./types.js";
import { PLUGIN_VERSION } from "./version.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum age (ms) for the lastUserTraceContext fallback when linking an
 * agent-channel hook back to the originating user context.  If the gap
 * between message_received and before_agent_start exceeds this window the
 * plugin creates a new trace instead of joining the existing one.
 */
const CONTEXT_LINK_TIMEOUT_MS = 3_000;

/** Stale context entries older than this (ms) are removed periodically. */
const CONTEXT_MAX_AGE_MS = 20 * 60 * 1_000; // 20 minutes

/** How often (ms) the stale-context sweeper runs. */
const CONTEXT_SWEEP_INTERVAL_MS = 10 * 60 * 1_000; // 10 minutes
const TEMP_RUN_ID_PREFIX = "run-";
const PENDING_ASSISTANT_TTL_MS = 15_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(length = 16): string {
  const chars = "0123456789abcdef";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

function safeClone<T>(value: T): T {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

const MAX_ATTR_LENGTH = 3_200_000;

function truncateAttr(value: string): string {
  return value.length > MAX_ATTR_LENGTH
    ? value.substring(0, MAX_ATTR_LENGTH)
    : value;
}

function toSpecParts(content: unknown): Array<Record<string, unknown>> {
  if (content === undefined || content === null) return [];
  if (typeof content === "string") return [{ type: "text", content }];
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") return { type: "text", content: item };
      if (typeof item === "object" && item !== null) {
        const obj = item as Record<string, unknown>;
        if (obj.type === "toolCall" || obj.type === "tool_call" || obj.type === "function_call") {
          return {
            type: "tool_call",
            id: obj.id || obj.toolCallId || null,
            name: obj.name || obj.toolName || "",
            arguments: obj.arguments || obj.input || obj.params || null,
          };
        }
        if (obj.type === "toolResult" || obj.type === "tool_result" || obj.type === "tool_call_response") {
          const resp = obj.response ?? obj.result ?? obj.content ?? "";
          return {
            type: "tool_call_response",
            id: obj.id || obj.toolCallId || null,
            response: typeof resp === "string" ? resp : JSON.stringify(resp),
          };
        }
        if (obj.type === "text") {
          return { type: "text", content: String(obj.content ?? obj.text ?? "") };
        }
        if (obj.type === "thinking" || obj.type === "reasoning") {
          return { type: "reasoning", content: String(obj.content ?? obj.thinking ?? "") };
        }
        if (obj.type) return obj;
        return { type: "text", content: JSON.stringify(item) };
      }
      return { type: "text", content: String(item) };
    });
  }
  return [{ type: "text", content: JSON.stringify(content) }];
}

function formatSystemInstructions(systemPrompt: string): string {
  return truncateAttr(JSON.stringify([{ type: "text", content: systemPrompt }]));
}

const ROLE_MAP: Record<string, string> = {
  toolResult: "tool",
  tool_result: "tool",
  function: "tool",
};

function formatInputMessages(
  historyMessages: Array<{ role: string; content: unknown }>,
  userPrompt?: string,
): string {
  const result: unknown[] = [];
  for (const msg of historyMessages) {
    const role = ROLE_MAP[msg.role] || msg.role;
    result.push({ role, parts: toSpecParts(msg.content) });
  }
  if (userPrompt) {
    result.push({ role: "user", parts: [{ type: "text", content: userPrompt }] });
  }
  return truncateAttr(JSON.stringify(result));
}

function formatOutputMessages(assistantTexts: string[], finishReason = "stop"): string {
  return truncateAttr(
    JSON.stringify(
      assistantTexts.map((text) => ({
        role: "assistant",
        parts: [{ type: "text", content: text }],
        finish_reason: finishReason,
      })),
    ),
  );
}

function formatAssistantOutputMessages(
  assistantContent: unknown,
  fallbackTexts: string[] = [],
  finishReason = "stop",
): string {
  const parts = toSpecParts(assistantContent);
  if (parts.length > 0) {
    return truncateAttr(
      JSON.stringify([
        {
          role: "assistant",
          parts,
          finish_reason: finishReason,
        },
      ]),
    );
  }
  return formatOutputMessages(fallbackTexts, finishReason);
}

function normalizeChannelId(input: string | undefined): string {
  if (!input || input === "unknown") return "system/unknown";
  if (input.includes("/")) return input;
  if (/^agent[_:]/.test(input)) return `agent/${input.slice(6)}`;
  return `system/${input}`;
}

function resolveChannelId(
  ctx: PluginHookContext,
  eventFrom?: string,
): string {
  const raw =
    (ctx.sessionKey as string)
    || ctx.channelId
    || ctx.conversationId
    || eventFrom
    || "unknown";
  return normalizeChannelId(raw);
}

type PendingToolCall = {
  runId?: string;
  toolName: string;
  toolCallId: string;
  toolSpanId: string;
  toolStartTime: number;
  toolInput: unknown;
  traceContext: TraceContext;
  channelId: string;
  createdAt: number;
};

type AssistantToolCall = {
  id: string;
  name?: string;
};

type LlmUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

type BeforeMessageWriteEvent = {
  message?: {
    role?: string;
    content?: unknown;
    timestamp?: number;
    stopReason?: string;
    usage?: LlmUsage;
  };
};

function resolveOptionalRunId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function resolveOptionalToolCallId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function buildPendingToolCallKey(toolCallId: string, runId?: string): string {
  return runId ? `${runId}:${toolCallId}` : toolCallId;
}

function extractAssistantToolCalls(content: unknown): AssistantToolCall[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const calls: AssistantToolCall[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as { type?: unknown; id?: unknown; name?: unknown };
    if (
      (rec.type === "toolCall" || rec.type === "toolUse" || rec.type === "functionCall")
      && typeof rec.id === "string"
      && rec.id
    ) {
      calls.push({
        id: rec.id,
        name: typeof rec.name === "string" ? rec.name : undefined,
      });
    }
  }
  return calls;
}

function extractAssistantTexts(content: unknown): string[] {
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const texts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as { type?: unknown; text?: unknown; content?: unknown };
    if (rec.type === "text") {
      if (typeof rec.text === "string" && rec.text) {
        texts.push(rec.text);
      } else if (typeof rec.content === "string" && rec.content) {
        texts.push(rec.content);
      }
    }
  }
  return texts;
}

function countToolCallsFromMessages(messages: unknown[] | undefined): number {
  if (!Array.isArray(messages) || messages.length === 0) {
    return 0;
  }
  let total = 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const rec = msg as { role?: unknown; content?: unknown };
    if (rec.role !== "assistant" || !Array.isArray(rec.content)) {
      continue;
    }
    for (const block of rec.content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const typed = block as { type?: unknown };
      if (
        typed.type === "toolCall"
        || typed.type === "toolUse"
        || typed.type === "functionCall"
      ) {
        total += 1;
      }
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Per-session trace context
// ---------------------------------------------------------------------------

interface TraceContext {
  traceId: string;
  rootSpanId: string;
  runId: string;
  turnId: string;
  channelId: string;
  originalChannelId?: string;
  sessionId?: string;

  createdAt: number;

  userInput?: unknown;
  lastOutput?: unknown;
  rootSpanStartTime?: number;

  llmProvider?: string;
  llmModel?: string;
  llmPendingStartTime?: number;
  llmPendingSpanId?: string;
  llmPendingSystemInstructions?: string;
  llmPendingInputMessages?: string;
  llmLastInputMessages?: string;
  llmLastAssistantContent?: unknown;
  llmPendingToolResultsForNextInput: Array<{ role: string; content: unknown }>;
  llmPendingToolCallIds: Set<string>;
  llmPendingToolCallCountFallback: number;
  llmSegmentCount: number;
  lastLlmUsage?: LlmUsage;
  stepSpanId?: string;
  stepStartTime?: number;
  stepRoundCounter: number;
  stepCurrentRound?: number;
  stepAwaitingToolResults: boolean;

  agentStartTime?: number;
  agentSpanId?: string;
  hasSeenLlmInput?: boolean;
  isClosing?: boolean;
}

type PendingAssistantMessage = {
  message: NonNullable<BeforeMessageWriteEvent["message"]>;
  createdAt: number;
};

// ---------------------------------------------------------------------------
// Plugin implementation
// ---------------------------------------------------------------------------

const armsTracePlugin: OpenClawPlugin = {
  id: "openclaw-cms-plugin",
  name: "OpenClaw CMS Plugin",
  version: PLUGIN_VERSION,
  description:
    "Report OpenClaw AI agent execution traces to Alibaba Cloud CMS via OpenTelemetry",

  activate(api: OpenClawPluginApi) {
    const pluginConfig = api.pluginConfig || {};
    const endpoint = pluginConfig.endpoint as string | undefined;
    const headers = pluginConfig.headers as Record<string, string> | undefined;

    if (!endpoint) {
      api.logger.error(
        "[ArmsTrace] Missing required configuration: 'endpoint' must be provided",
      );
      return;
    }
    const config: ArmsTraceConfig = {
      endpoint,
      headers: headers || {},
      serviceName: (pluginConfig.serviceName as string) || "openclaw-agent",
      debug: (pluginConfig.debug as boolean) || false,
      batchSize: (pluginConfig.batchSize as number) || 10,
      flushIntervalMs: (pluginConfig.flushIntervalMs as number) || 5000,
      enabledHooks: pluginConfig.enabledHooks as string[] | undefined,
    };

    const exporter = new ArmsExporter(api, config);

    // -- Trace context management -------------------------------------------

    const contextByChannelId = new Map<string, TraceContext>();
    const contextByRunId = new Map<string, TraceContext>();
    const contextsByChannelId = new Map<string, Set<TraceContext>>();
    const activeContextByAgentChannel = new Map<string, TraceContext>();
    const pendingToolCalls = new Map<string, PendingToolCall>();
    const traceTaskQueueByTraceId = new Map<string, Promise<void>>();
    const pendingAssistantByTraceId = new Map<string, PendingAssistantMessage>();

    let lastUserChannelId: string | undefined;
    let lastUserTraceContext: TraceContext | undefined;
    let lastUserContextSetAt: number | undefined;
    const openclawVersion: string = api.runtime?.version || "unknown";

    const sweepStaleContexts = () => {
      const now = Date.now();
      for (const [key, ctx] of contextByChannelId) {
        if (now - ctx.createdAt > CONTEXT_MAX_AGE_MS) {
          contextByChannelId.delete(key);
          contextByRunId.delete(ctx.runId);
        }
      }
      for (const [key, pending] of pendingToolCalls) {
        if (now - pending.createdAt > CONTEXT_MAX_AGE_MS) {
          pendingToolCalls.delete(key);
        }
      }
      for (const [traceId, pending] of pendingAssistantByTraceId) {
        if (now - pending.createdAt > PENDING_ASSISTANT_TTL_MS) {
          pendingAssistantByTraceId.delete(traceId);
          if (config.debug) {
            api.logger.warn(
              `[ArmsTrace] Dropped stale pending assistant message: traceId=${traceId}`,
            );
          }
        }
      }
    };
    const contextSweepTimer = setInterval(sweepStaleContexts, CONTEXT_SWEEP_INTERVAL_MS);
    contextSweepTimer.unref();

    const shouldHookEnabled = (hookName: string): boolean => {
      if (!config.enabledHooks) return true;
      return config.enabledHooks.includes(hookName);
    };

    const cleanupPendingToolCallsForRun = (runId: string | undefined) => {
      if (!runId) {
        return;
      }
      const prefix = `${runId}:`;
      for (const key of pendingToolCalls.keys()) {
        if (key.startsWith(prefix)) {
          pendingToolCalls.delete(key);
        }
      }
    };

    const isTemporaryRunId = (runId: string): boolean => runId.startsWith(TEMP_RUN_ID_PREFIX);

    const movePendingToolCallsRunBinding = (fromRunId: string, toRunId: string) => {
      for (const [key, pending] of pendingToolCalls) {
        if (pending.runId !== fromRunId) {
          continue;
        }
        pendingToolCalls.delete(key);
        pending.runId = toRunId;
        pendingToolCalls.set(buildPendingToolCallKey(pending.toolCallId, toRunId), pending);
      }
    };

    const bindRealRunId = (ctx: TraceContext, runId: string, hookName: string) => {
      const realRunId = resolveOptionalRunId(runId);
      if (!realRunId || ctx.runId === realRunId) {
        return;
      }
      const existing = contextByRunId.get(realRunId);
      if (existing && existing !== ctx) {
        if (config.debug) {
          api.logger.warn(
            `[ArmsTrace] Skip runId rebind due to existing mapping: hook=${hookName}, oldRunId=${ctx.runId}, realRunId=${realRunId}`,
          );
        }
        return;
      }
      const oldRunId = ctx.runId;
      if (!isTemporaryRunId(oldRunId)) {
        if (config.debug) {
          api.logger.warn(
            `[ArmsTrace] Skip runId rebind because current runId is already stable: hook=${hookName}, runId=${oldRunId}, incoming=${realRunId}`,
          );
        }
        return;
      }
      if (contextByRunId.get(oldRunId) === ctx) {
        contextByRunId.delete(oldRunId);
      }
      ctx.runId = realRunId;
      ctx.turnId = realRunId;
      contextByRunId.set(realRunId, ctx);
      movePendingToolCallsRunBinding(oldRunId, realRunId);
      const rebindAttrs = {
        "openclaw.run.id": realRunId,
        "openclaw.turn.id": realRunId,
      };
      exporter.patchOpenSpanAttributes(ctx.rootSpanId, rebindAttrs);
      if (ctx.agentSpanId) {
        exporter.patchOpenSpanAttributes(ctx.agentSpanId, rebindAttrs);
      }
      if (config.debug) {
        api.logger.info(
          `[ArmsTrace] Rebound temporary runId: hook=${hookName}, oldRunId=${oldRunId}, realRunId=${realRunId}`,
        );
      }
    };

    const enqueueTraceTask = (
      traceId: string,
      task: () => Promise<void>,
    ): Promise<void> => {
      const prev = traceTaskQueueByTraceId.get(traceId) || Promise.resolve();
      const next = prev.catch(() => undefined).then(task);
      let tracked: Promise<void>;
      tracked = next.finally(() => {
        if (traceTaskQueueByTraceId.get(traceId) === tracked) {
          traceTaskQueueByTraceId.delete(traceId);
        }
      });
      traceTaskQueueByTraceId.set(traceId, tracked);
      return tracked;
    };

    const clearPendingAssistantForTrace = (traceId: string | undefined) => {
      if (!traceId) {
        return;
      }
      pendingAssistantByTraceId.delete(traceId);
    };

    const drainTraceTasks = async (traceId: string | undefined): Promise<void> => {
      if (!traceId) {
        return;
      }
      const pending = traceTaskQueueByTraceId.get(traceId);
      if (!pending) {
        return;
      }
      try {
        await pending;
      } catch {
        // already logged at task site
      }
    };

    const consumePendingToolCall = (event: AfterToolCallEvent): PendingToolCall | undefined => {
      const eventRunId = resolveOptionalRunId(event.runId);
      const eventToolCallId = resolveOptionalToolCallId(event.toolCallId);

      if (eventToolCallId) {
        const directKeys = [
          buildPendingToolCallKey(eventToolCallId, eventRunId),
          buildPendingToolCallKey(eventToolCallId, undefined),
        ];
        for (const key of directKeys) {
          const direct = pendingToolCalls.get(key);
          if (direct) {
            pendingToolCalls.delete(key);
            return direct;
          }
        }
      }

      let fallbackKey: string | undefined;
      let fallback: PendingToolCall | undefined;
      for (const [key, pending] of pendingToolCalls) {
        if (pending.toolName !== event.toolName) {
          continue;
        }
        if (eventRunId && pending.runId && pending.runId !== eventRunId) {
          continue;
        }
        if (!fallback || pending.toolStartTime > fallback.toolStartTime) {
          fallback = pending;
          fallbackKey = key;
        }
      }
      if (fallback && fallbackKey) {
        pendingToolCalls.delete(fallbackKey);
        if (config.debug) {
          api.logger.warn(
            `[ArmsTrace] Tool call fallback match used: tool=${event.toolName}, runId=${eventRunId || "-"}, eventToolCallId=${eventToolCallId || "-"}`,
          );
        }
      }
      return fallback;
    };

    const registerChannelContext = (channelId: string, ctx: TraceContext) => {
      let set = contextsByChannelId.get(channelId);
      if (!set) {
        set = new Set<TraceContext>();
        contextsByChannelId.set(channelId, set);
      }
      set.add(ctx);
    };

    const unregisterChannelContext = (channelId: string, ctx: TraceContext) => {
      const set = contextsByChannelId.get(channelId);
      if (!set) {
        return;
      }
      set.delete(ctx);
      if (set.size === 0) {
        contextsByChannelId.delete(channelId);
      }
    };

    const mapContextToChannel = (channelId: string, ctx: TraceContext) => {
      contextByChannelId.set(channelId, ctx);
      registerChannelContext(channelId, ctx);
    };

    const unmapContextFromChannelIfMatches = (channelId: string, ctx: TraceContext) => {
      if (contextByChannelId.get(channelId) === ctx) {
        contextByChannelId.delete(channelId);
      }
      unregisterChannelContext(channelId, ctx);
    };

    const cleanupContextIdentity = (ctx: TraceContext) => {
      if (contextByRunId.get(ctx.runId) === ctx) {
        contextByRunId.delete(ctx.runId);
      }
      for (const [channelId, mapped] of contextByChannelId) {
        if (mapped === ctx) {
          contextByChannelId.delete(channelId);
        }
      }
      for (const [channelId, set] of contextsByChannelId) {
        if (set.has(ctx)) {
          set.delete(ctx);
          if (set.size === 0) {
            contextsByChannelId.delete(channelId);
          }
        }
      }
      for (const [agentChannelId, mapped] of activeContextByAgentChannel) {
        if (mapped === ctx) {
          activeContextByAgentChannel.delete(agentChannelId);
        }
      }
      clearPendingAssistantForTrace(ctx.traceId);
    };

    const getContextByChannel = (channelId: string) =>
      contextByChannelId.get(channelId);

    const getContextByRun = (runId: string) => contextByRunId.get(runId);

    const getOriginalChannelId = (runId: string) => {
      const ctx = contextByRunId.get(runId);
      return ctx?.originalChannelId || ctx?.channelId;
    };

    const startTurn = (
      runId: string,
      channelId: string,
      originalChannelId?: string,
    ): TraceContext => {
      const traceId = generateId(32);
      const ctx: TraceContext = {
        traceId,
        rootSpanId: generateId(16),
        runId,
        turnId: runId,
        channelId,
        originalChannelId: originalChannelId || channelId,
        createdAt: Date.now(),
        llmPendingToolCallIds: new Set<string>(),
        llmPendingToolResultsForNextInput: [],
        llmPendingToolCallCountFallback: 0,
        llmSegmentCount: 0,
        stepRoundCounter: 0,
        stepAwaitingToolResults: false,
      };
      mapContextToChannel(channelId, ctx);
      contextByRunId.set(runId, ctx);
      return ctx;
    };

    const endTurn = (channelId: string) => {
      const ctx = contextByChannelId.get(channelId);
      if (ctx) {
        unmapContextFromChannelIfMatches(channelId, ctx);
        if (contextByRunId.get(ctx.runId) === ctx) {
          contextByRunId.delete(ctx.runId);
        }
      }
    };

    const pickAgentEndContext = (channelId: string, fallback?: TraceContext): TraceContext | undefined => {
      const set = contextsByChannelId.get(channelId);
      if (!set || set.size === 0) {
        return fallback;
      }
      const candidates = Array.from(set).filter((ctx) => ctx.agentSpanId && !ctx.isClosing);
      if (candidates.length === 0) {
        return fallback || Array.from(set)[0];
      }
      candidates.sort((a, b) => (a.agentStartTime || a.createdAt) - (b.agentStartTime || b.createdAt));
      return candidates[0];
    };

    const getOrCreateContext = (
      rawChannelId: string,
      runId: string | undefined,
      hookName: string,
    ): { ctx: TraceContext; channelId: string; isNew: boolean } => {
      let channelId = rawChannelId;
      const agentChannelKey = rawChannelId.startsWith("agent/") ? rawChannelId : undefined;
      let activeCtx = agentChannelKey
        ? activeContextByAgentChannel.get(agentChannelKey) || getContextByChannel(rawChannelId)
        : getContextByChannel(rawChannelId);
      const resolvedIncomingRunId = resolveOptionalRunId(runId);
      let effectiveRunId = resolvedIncomingRunId || activeCtx?.runId || `run-${Date.now()}`;
      const canLinkRecentUserContext = () =>
        rawChannelId.startsWith("agent/")
        && Boolean(lastUserTraceContext)
        && Boolean(lastUserContextSetAt)
        && (Date.now() - (lastUserContextSetAt || 0)) < CONTEXT_LINK_TIMEOUT_MS;

      const linkRecentUserContext = () => {
        if (!lastUserTraceContext) {
          return undefined;
        }
        const linked = lastUserTraceContext;
        if (
          resolvedIncomingRunId
          && linked.runId !== resolvedIncomingRunId
          && !isTemporaryRunId(linked.runId)
        ) {
          // Incoming event already has a stable run id. Do not re-link to a
          // different stable user context, otherwise run attribution drifts.
          return undefined;
        }
        channelId = lastUserChannelId || channelId;
        mapContextToChannel(rawChannelId, linked);
        contextByRunId.set(effectiveRunId, linked);
        if (config.debug) {
          api.logger.info(
            `[ArmsTrace] LINKING agent to user context: hook=${hookName}, agentChannel=${rawChannelId}, userChannel=${channelId}, traceId=${linked.traceId}`,
          );
        }
        return linked;
      };

      if (rawChannelId.startsWith("agent/") && effectiveRunId) {
        const originalChannelId = getOriginalChannelId(effectiveRunId);
        if (originalChannelId) {
          channelId = originalChannelId;
          activeCtx =
            getContextByChannel(originalChannelId) || activeCtx;
        }
      }

      if (!activeCtx) {
        activeCtx = getContextByRun(effectiveRunId);
      }

      if (hookName === "agent_end" && !resolvedIncomingRunId) {
        activeCtx = pickAgentEndContext(channelId, activeCtx);
      }

      if (!activeCtx && canLinkRecentUserContext()) {
        activeCtx = linkRecentUserContext();
      }

      if (
        hookName === "message_received"
        && !rawChannelId.startsWith("agent/")
        && activeCtx
        && (activeCtx.agentSpanId || activeCtx.hasSeenLlmInput || activeCtx.isClosing)
      ) {
        if (config.debug) {
          api.logger.info(
            `[ArmsTrace] Rotating user context for new message: channelId=${channelId}, previousRunId=${activeCtx.runId}`,
          );
        }
        activeCtx = undefined;
        // Force a fresh temporary run id for the new turn. Without this reset
        // the newly created context may inherit the previous stable run id.
        if (!resolvedIncomingRunId) {
          effectiveRunId = `run-${Date.now()}`;
        }
      }

      if (
        activeCtx &&
        resolvedIncomingRunId &&
        activeCtx.runId !== resolvedIncomingRunId &&
        !isTemporaryRunId(activeCtx.runId)
      ) {
        if (config.debug) {
          api.logger.info(
            `[ArmsTrace] New stable run detected on active channel; creating fresh context: hook=${hookName}, channelId=${channelId}, oldRunId=${activeCtx.runId}, newRunId=${resolvedIncomingRunId}`,
          );
        }
        activeCtx = undefined;
        effectiveRunId = resolvedIncomingRunId;
      }

      if (
        activeCtx &&
        resolvedIncomingRunId &&
        isTemporaryRunId(activeCtx.runId)
      ) {
        const existingReal = contextByRunId.get(resolvedIncomingRunId);
        if (existingReal && existingReal !== activeCtx) {
          if (config.debug) {
            api.logger.info(
              `[ArmsTrace] Switching temporary context to existing real run context: hook=${hookName}, channelId=${channelId}, tempRunId=${activeCtx.runId}, realRunId=${resolvedIncomingRunId}`,
            );
          }
          activeCtx = existingReal;
          mapContextToChannel(channelId, activeCtx);
        }
      }

      if (!activeCtx && canLinkRecentUserContext()) {
        activeCtx = linkRecentUserContext();
      }

      let isNew = false;
      if (!activeCtx) {
        activeCtx = startTurn(
          effectiveRunId,
          channelId,
          rawChannelId !== channelId ? rawChannelId : undefined,
        );
        isNew = true;
        if (config.debug) {
          api.logger.info(
            `[ArmsTrace] NEW TraceContext: hook=${hookName}, channelId=${channelId}, runId=${effectiveRunId}, traceId=${activeCtx.traceId}`,
          );
        }
      } else if (config.debug) {
        api.logger.info(
          `[ArmsTrace] REUSING TraceContext: hook=${hookName}, channelId=${channelId}, traceId=${activeCtx.traceId}`,
        );
      }
      if (agentChannelKey && activeCtx && !activeCtx.isClosing) {
        activeContextByAgentChannel.set(agentChannelKey, activeCtx);
      }
      if (activeCtx && runId) {
        bindRealRunId(activeCtx, runId, hookName);
      }
      return { ctx: activeCtx, channelId, isNew };
    };

    const createSpan = (
      ctx: TraceContext,
      channelId: string,
      name: string,
      type: SpanData["type"],
      startTime: number,
      endTime: number,
      attributes: Record<string, string | number | boolean> = {},
      input?: unknown,
      output?: unknown,
      parentSpanId?: string,
    ): SpanData => ({
      name,
      type,
      startTime,
      endTime,
      attributes: {
        ...attributes,
        "openclaw.version": openclawVersion,
        "openclaw.session.id": ctx.sessionId || channelId,
        "gen_ai.session.id": ctx.sessionId || channelId,
        "openclaw.run.id": ctx.runId,
        "openclaw.turn.id": ctx.turnId,
      },
      input,
      output,
      traceId: ctx.traceId,
      spanId: generateId(16),
      parentSpanId: parentSpanId || ctx.rootSpanId,
    });

    const resolveAgentFirstParentSpanId = (ctx: TraceContext): string =>
      ctx.agentSpanId || ctx.rootSpanId;

    const resolveStepFirstParentSpanId = (ctx: TraceContext): string =>
      ctx.stepSpanId || ctx.agentSpanId || ctx.rootSpanId;

    const exportPendingLlmSpan = async (
      ctx: TraceContext,
      channelId: string,
      params: {
        endTime: number;
        outputTexts: string[];
        outputContent?: unknown;
        stopReason?: string;
        usage?: LlmUsage;
      },
    ): Promise<void> => {
      const now = params.endTime || Date.now();
      const startTime = ctx.llmPendingStartTime || now;
      const safeEndTime = now < startTime ? startTime : now;
      if (safeEndTime !== now && config.debug) {
        api.logger.warn(
          `[ArmsTrace] Corrected negative LLM span duration: runId=${ctx.runId}, traceId=${ctx.traceId}, start=${startTime}, end=${now}`,
        );
      }
      const provider = ctx.llmProvider || "unknown";
      const model = ctx.llmModel || "unknown";
      const stopReason = params.stopReason || "stop";

      const inputTokens = params.usage?.input ?? 0;
      const outputTokens = params.usage?.output ?? 0;
      const cacheReadTokens = params.usage?.cacheRead ?? 0;
      const cacheCreationTokens = params.usage?.cacheWrite ?? 0;
      const totalTokens =
        params.usage?.total ?? inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;

      const llmAttrs: Record<string, string | number | boolean> = {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": provider,
        "gen_ai.request.model": model,
        "gen_ai.response.model": model,
        "gen_ai.usage.input_tokens": inputTokens,
        "gen_ai.usage.output_tokens": outputTokens,
        "gen_ai.usage.total_tokens": totalTokens,
        "gen_ai.usage.cache_read.input_tokens": cacheReadTokens,
        "gen_ai.usage.cache_creation.input_tokens": cacheCreationTokens,
      };

      if (ctx.llmPendingSystemInstructions) {
        llmAttrs["gen_ai.system_instructions"] = ctx.llmPendingSystemInstructions;
      }
      const effectiveInputMessages = ctx.llmPendingInputMessages || ctx.llmLastInputMessages;
      if (effectiveInputMessages) {
        llmAttrs["gen_ai.input.messages"] = effectiveInputMessages;
      }
      if (params.outputContent !== undefined || params.outputTexts.length > 0) {
        llmAttrs["gen_ai.output.messages"] = formatAssistantOutputMessages(
          params.outputContent,
          params.outputTexts,
          stopReason,
        );
      }
      llmAttrs["gen_ai.response.finish_reasons"] = JSON.stringify([stopReason]);

      const span = createSpan(
        ctx,
        channelId,
        `chat ${model}`,
        "model",
        startTime,
        safeEndTime,
        llmAttrs,
        undefined,
        undefined,
        resolveStepFirstParentSpanId(ctx),
      );
      if (ctx.llmPendingSpanId) {
        span.spanId = ctx.llmPendingSpanId;
      }
      await exporter.export(span);

      ctx.llmPendingStartTime = undefined;
      ctx.llmPendingSpanId = undefined;
      ctx.llmPendingSystemInstructions = undefined;
      ctx.llmPendingInputMessages = undefined;
      ctx.llmSegmentCount += 1;

      if (config.debug) {
        api.logger.info(
          `[ArmsTrace] Exported segmented LLM span: ${provider}/${model}, duration=${safeEndTime - startTime}ms, reason=${stopReason}`,
        );
      }
    };

    const processAssistantMessageForContext = async (
      ctx: TraceContext,
      channelId: string,
      message: NonNullable<BeforeMessageWriteEvent["message"]>,
    ) => {
      const messageTs =
        typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
          ? message.timestamp
          : Date.now();
      const toolCalls = extractAssistantToolCalls(message.content);
      const outputTexts = extractAssistantTexts(message.content);
      const stopReason =
        typeof message.stopReason === "string"
          ? message.stopReason
          : (toolCalls.length > 0 ? "toolUse" : "stop");

      if (!ctx.llmPendingStartTime) {
        ctx.llmPendingStartTime = messageTs;
        ctx.llmPendingSpanId = generateId(16);
      }

      await exportPendingLlmSpan(ctx, channelId, {
        endTime: messageTs,
        outputTexts,
        outputContent: message.content,
        stopReason,
        usage: message.usage,
      });

      if (outputTexts.length > 0) {
        ctx.lastOutput = outputTexts.join("\n");
      }

      ctx.llmPendingToolCallIds.clear();
      ctx.llmPendingToolResultsForNextInput = [];
      ctx.llmLastAssistantContent = message.content;
      for (const call of toolCalls) {
        ctx.llmPendingToolCallIds.add(call.id);
      }
      ctx.llmPendingToolCallCountFallback =
        ctx.llmPendingToolCallIds.size > 0 ? 0 : toolCalls.length;
      ctx.stepAwaitingToolResults = toolCalls.length > 0;

      if (toolCalls.length === 0) {
        endStepSpan(ctx, messageTs, stopReason, channelId);
      }

      if (config.debug) {
        api.logger.info(
          `[ArmsTrace] Processed assistant message for segmented LLM: runId=${ctx.runId}, toolCalls=${toolCalls.length}, stopReason=${stopReason}`,
        );
      }
    };

    const ensureEntrySpan = async (
      ctx: TraceContext,
      channelId: string,
      options: { userId?: string; role?: string; from?: string } = {},
    ) => {
      if (ctx.rootSpanStartTime) return;
      const now = Date.now();
      ctx.rootSpanStartTime = now;
      const rootSpanData: SpanData = {
        name: "enter_openclaw_system",
        type: "entry",
        startTime: now,
        attributes: {
          "gen_ai.operation.name": "enter",
          "gen_ai.user.id": options.userId || "unknown",
          "openclaw.session.id": ctx.sessionId || channelId,
          "gen_ai.session.id": ctx.sessionId || channelId,
          "openclaw.run.id": ctx.runId,
          "openclaw.turn.id": ctx.turnId,
          "openclaw.message.role": options.role || "unknown",
          "openclaw.message.from": options.from || "unknown",
          "openclaw.version": openclawVersion,
        },
        input: ctx.userInput,
        traceId: ctx.traceId,
        spanId: ctx.rootSpanId,
      };
      await exporter.startSpan(rootSpanData, ctx.rootSpanId);
      if (config.debug) {
        api.logger.info(
          `[ArmsTrace] Started root span: traceId=${ctx.traceId}, spanId=${ctx.rootSpanId}`,
        );
      }
    };

    const ensureAgentSpan = async (
      ctx: TraceContext,
      channelId: string,
      agentId: string,
    ) => {
      if (ctx.agentSpanId) {
        return;
      }
      const now = Date.now();
      ctx.agentStartTime = now;
      ctx.agentSpanId = generateId(16);

      const spanData: SpanData = {
        name: `invoke_agent ${agentId}`,
        type: "agent",
        startTime: now,
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.provider.name": "openclaw",
          "gen_ai.agent.id": agentId,
          "gen_ai.agent.name": agentId,
          "openclaw.session.id": ctx.sessionId || channelId,
          "gen_ai.session.id": ctx.sessionId || channelId,
          "openclaw.run.id": ctx.runId,
          "openclaw.turn.id": ctx.turnId,
          "openclaw.version": openclawVersion,
        },
        traceId: ctx.traceId,
        spanId: ctx.agentSpanId,
        parentSpanId: ctx.rootSpanId,
      };
      await exporter.startSpan(spanData, ctx.agentSpanId);

      if (config.debug) {
        api.logger.info(
          `[ArmsTrace] Started agent span: ${agentId}, spanId=${ctx.agentSpanId}`,
        );
      }
    };

    const ensureStepSpan = async (
      ctx: TraceContext,
      channelId: string,
      startTime: number,
    ) => {
      if (ctx.stepSpanId) {
        return;
      }
      const round = ctx.stepRoundCounter + 1;
      const spanId = generateId(16);
      const stepAttrs: Record<string, string | number | boolean> = {
        "gen_ai.operation.name": "react",
        "gen_ai.react.round": round,
        "openclaw.session.id": ctx.sessionId || channelId,
        "gen_ai.session.id": ctx.sessionId || channelId,
        "openclaw.run.id": ctx.runId,
        "openclaw.turn.id": ctx.turnId,
        "openclaw.version": openclawVersion,
      };
      const spanData: SpanData = {
        name: "react step",
        type: "step",
        startTime,
        attributes: stepAttrs,
        traceId: ctx.traceId,
        spanId,
        parentSpanId: resolveAgentFirstParentSpanId(ctx),
      };
      await exporter.startSpan(spanData, spanId);
      ctx.stepSpanId = spanId;
      ctx.stepStartTime = startTime;
      ctx.stepRoundCounter = round;
      ctx.stepCurrentRound = round;
      ctx.stepAwaitingToolResults = false;
      if (config.debug) {
        api.logger.info(
          `[ArmsTrace] Started step span: round=${round}, spanId=${spanId}, runId=${ctx.runId}`,
        );
      }
    };

    const endStepSpan = (
      ctx: TraceContext,
      endTime: number,
      finishReason: string,
      channelId: string,
    ) => {
      if (!ctx.stepSpanId) {
        return;
      }
      const stepSpanId = ctx.stepSpanId;
      const stepRound = ctx.stepCurrentRound || ctx.stepRoundCounter || 1;
      const stepAttrs: Record<string, string | number | boolean> = {
        "gen_ai.react.round": stepRound,
        "gen_ai.react.finish_reason": finishReason || "stop",
        "openclaw.session.id": ctx.sessionId || channelId,
        "gen_ai.session.id": ctx.sessionId || channelId,
      };
      exporter.endSpanById(stepSpanId, endTime, stepAttrs);
      ctx.stepSpanId = undefined;
      ctx.stepStartTime = undefined;
      ctx.stepCurrentRound = undefined;
      ctx.stepAwaitingToolResults = false;
      if (config.debug) {
        api.logger.info(
          `[ArmsTrace] Ended step span: round=${stepRound}, reason=${finishReason}, spanId=${stepSpanId}`,
        );
      }
    };

    // -- Hook: gateway_stop -------------------------------------------------

    api.on("gateway_stop", async () => {
      clearInterval(contextSweepTimer);
      const queuedTasks = Array.from(traceTaskQueueByTraceId.values());
      if (queuedTasks.length > 0) {
        await Promise.allSettled(queuedTasks);
      }
      pendingToolCalls.clear();
      pendingAssistantByTraceId.clear();
      await exporter.dispose();
    });

    // -- Hook: gateway_start ------------------------------------------------

    if (shouldHookEnabled("gateway_start")) {
      api.on("gateway_start", async (event: GatewayStartEvent) => {
        const now = Date.now();
        const { ctx, channelId } = getOrCreateContext(
          "system/gateway",
          undefined,
          "gateway_start",
        );
        const span = createSpan(
          ctx,
          channelId,
          "gateway_start",
          "gateway",
          now,
          now,
          {
              "gateway.port": event.port,
          },
        );
        delete (span.attributes as Record<string, unknown>)["openclaw.session.id"];
        delete (span.attributes as Record<string, unknown>)["gen_ai.session.id"];
        await exporter.export(span);
      });
    }

    // -- Hook: session_start ------------------------------------------------

    if (shouldHookEnabled("session_start")) {
      api.on(
        "session_start",
        async (event: SessionStartEvent, hookCtx: PluginHookContext) => {
          const rawChannelId = resolveChannelId(hookCtx, event.sessionId);
          const { ctx, channelId } = getOrCreateContext(
            rawChannelId,
            undefined,
            "session_start",
          );
          const now = Date.now();
          const span = createSpan(
            ctx,
            channelId,
            "session_start",
            "session",
            now,
            now,
            { "event.type": "session_start" },
          );
          delete (span.attributes as Record<string, unknown>)["gen_ai.session.id"];
          if (event.sessionId) {
            span.attributes["openclaw.session.id"] = event.sessionId;
          }
          await exporter.export(span);
        },
      );
    }

    // -- Hook: session_end --------------------------------------------------

    if (shouldHookEnabled("session_end")) {
      api.on(
        "session_end",
        async (event: SessionEndEvent, hookCtx: PluginHookContext) => {
          const rawChannelId = resolveChannelId(hookCtx, event.sessionId);
          const { ctx, channelId } = getOrCreateContext(
            rawChannelId,
            undefined,
            "session_end",
          );
          const now = Date.now();
          const span = createSpan(
            ctx,
            channelId,
            "session_end",
            "session",
            now,
            now,
            {
              "session.duration_ms": event.durationMs || 0,
              "session.message_count": event.messageCount || 0,
              "session.total_tokens": ctx.lastLlmUsage?.total || 0,
            },
            undefined,
            {
              messageCount: event.messageCount,
              totalTokens: ctx.lastLlmUsage?.total,
            },
          );
          delete (span.attributes as Record<string, unknown>)["gen_ai.session.id"];
          if (event.sessionId) {
            span.attributes["openclaw.session.id"] = event.sessionId;
          }
          await exporter.export(span);
          endTurn(channelId);
        },
      );
    }

    // -- Hook: message_received ---------------------------------------------

    if (shouldHookEnabled("message_received")) {
      api.on(
        "message_received",
        async (
          event: MessageReceivedEvent,
          hookCtx: PluginHookContext,
        ) => {
          const rawChannelId = resolveChannelId(
            hookCtx,
            event.from || ((event.metadata as { senderId?: string } | undefined)?.senderId),
          );
          const { ctx, channelId, isNew } = getOrCreateContext(
            rawChannelId,
            undefined,
            "message_received",
          );
          const now = Date.now();
          const role = "user";

          const isUserMessage = !rawChannelId.startsWith("agent/");
          if (isUserMessage) {
            lastUserChannelId = channelId;
            lastUserTraceContext = ctx;
            lastUserContextSetAt = Date.now();
            ctx.userInput = event.content;

            await ensureEntrySpan(ctx, channelId, {
              userId: event.from || ((event.metadata as { senderId?: string } | undefined)?.senderId),
              role,
              from: event.from,
            });
          }

        },
      );
    }

    // -- Hook: message_sending ----------------------------------------------

    if (shouldHookEnabled("message_sending")) {
      api.on(
        "message_sending",
        async (event: MessageSendingEvent, hookCtx: PluginHookContext) => {
          const rawChannelId = resolveChannelId(hookCtx, event.to);
          const { ctx } = getOrCreateContext(
            rawChannelId,
            undefined,
            "message_sending",
          );
          ctx.lastOutput = event.content;
        },
      );
    }

    // -- Hook: message_sent -------------------------------------------------

    if (shouldHookEnabled("message_sent")) {
      api.on(
        "message_sent",
        async (event: MessageSentEvent, hookCtx: PluginHookContext) => {
          if (event.content && event.success) {
            const rawChannelId = resolveChannelId(hookCtx, event.to);
            const { ctx } = getOrCreateContext(
              rawChannelId,
              undefined,
              "message_sent",
            );
            ctx.lastOutput = event.content;
          }
        },
      );
    }

    // -- Hook: llm_input ----------------------------------------------------

    if (shouldHookEnabled("llm_input")) {
      api.on(
        "llm_input",
        async (event: LlmInputEvent, hookCtx: PluginHookContext) => {
          const rawChannelId = resolveChannelId(hookCtx);
          const { ctx, channelId } = getOrCreateContext(
            rawChannelId,
            event.runId,
            "llm_input",
          );

          if (event.sessionId) {
            ctx.sessionId = event.sessionId;
          }

          if (!ctx.userInput && event.prompt) {
            ctx.userInput = event.prompt;
          }

          // In concurrent/reordered hook delivery, llm_input may arrive before
          // before_agent_start for this run. Ensure parent spans exist so
          // segmented LLM/TOOL spans never become orphan traces.
          await ensureEntrySpan(ctx, channelId, {
            userId: (hookCtx.trigger as string) || "system",
            role: (hookCtx.trigger as string) || "system",
            from: hookCtx.agentId || "openclaw",
          });
          await ensureAgentSpan(ctx, channelId, hookCtx.agentId || "openclaw");

          ctx.llmProvider = event.provider;
          ctx.llmModel = event.model;
          ctx.hasSeenLlmInput = true;
          ctx.isClosing = false;
          if (rawChannelId.startsWith("agent/")) {
            activeContextByAgentChannel.set(rawChannelId, ctx);
          }
          ctx.llmPendingStartTime = Date.now();
          ctx.llmPendingSpanId = generateId(16);
          await ensureStepSpan(ctx, channelId, ctx.llmPendingStartTime);
          ctx.llmPendingToolCallIds.clear();
          ctx.llmPendingToolCallCountFallback = 0;

          if (event.systemPrompt) {
            ctx.llmPendingSystemInstructions = formatSystemInstructions(event.systemPrompt);
          }

          const historyMsgs = event.historyMessages?.length
            ? event.historyMessages.map((msg) => safeClone(msg))
            : [];
          ctx.llmPendingInputMessages = formatInputMessages(historyMsgs, event.prompt);
          ctx.llmLastInputMessages = ctx.llmPendingInputMessages;

          const pendingAssistant = pendingAssistantByTraceId.get(ctx.traceId);
          if (pendingAssistant) {
            pendingAssistantByTraceId.delete(ctx.traceId);
            void enqueueTraceTask(ctx.traceId, async () => {
              await processAssistantMessageForContext(ctx, channelId, pendingAssistant.message);
            }).catch((err) => {
              api.logger.warn(`[ArmsTrace] replay pending assistant failed: ${String(err)}`);
            });
          }

          if (config.debug) {
            api.logger.info(
              `[ArmsTrace] LLM input started: ${event.provider}/${event.model}, runId=${event.runId}`,
            );
          }
        },
      );
    }

    // -- Hook: llm_output ---------------------------------------------------

    if (shouldHookEnabled("llm_output")) {
      api.on(
        "llm_output",
        async (event: LlmOutputEvent, hookCtx: PluginHookContext) => {
          const rawChannelId = resolveChannelId(hookCtx);
          const { ctx, channelId } = getOrCreateContext(
            rawChannelId,
            event.runId,
            "llm_output",
          );

          if (event.sessionId) {
            ctx.sessionId = event.sessionId;
          }

          if (event.assistantTexts?.length) {
            const outputText = event.assistantTexts.join("\n");
            ctx.lastOutput = outputText;
          }
          if (event.usage) {
            ctx.lastLlmUsage = {
              input: event.usage.input,
              output: event.usage.output,
              cacheRead: event.usage.cacheRead,
              cacheWrite: event.usage.cacheWrite,
              total: event.usage.total,
            };
          }
          // Keep llm_output only as a compatibility fallback.
          // Normal segmented exports happen in before_message_write.
          if (ctx.llmSegmentCount === 0 && ctx.llmPendingStartTime) {
            const endTime = Date.now();
            const lastAssistantObj = event.lastAssistant as Record<string, unknown> | undefined;
            const stopReason = typeof lastAssistantObj?.stopReason === "string"
              ? lastAssistantObj.stopReason
              : undefined;
            await exportPendingLlmSpan(ctx, channelId, {
              endTime,
              outputTexts: event.assistantTexts || [],
              stopReason,
              usage: event.usage,
            });
            endStepSpan(ctx, endTime, stopReason || "stop", channelId);
          }
        },
      );
    }

    // -- Hook: before_message_write -----------------------------------------

    if (shouldHookEnabled("before_message_write")) {
      api.on(
        "before_message_write",
        (event: BeforeMessageWriteEvent, hookCtx: PluginHookContext) => {
          const message = event.message;
          if (!message || message.role !== "assistant") {
            return;
          }
          const rawChannelId = resolveChannelId(hookCtx);
          const anchoredCtx =
            rawChannelId.startsWith("agent/")
              ? activeContextByAgentChannel.get(rawChannelId)
              : undefined;
          if (rawChannelId.startsWith("agent/") && !anchoredCtx) {
            if (config.debug) {
              api.logger.warn(
                `[ArmsTrace] Skip assistant message without active agent context: channelId=${rawChannelId}`,
              );
            }
            return;
          }
          const { ctx, channelId } = anchoredCtx
            ? { ctx: anchoredCtx, channelId: anchoredCtx.channelId }
            : getOrCreateContext(
              rawChannelId,
              undefined,
              "before_message_write",
            );

          if (!ctx.hasSeenLlmInput) {
            pendingAssistantByTraceId.set(ctx.traceId, {
              message,
              createdAt: Date.now(),
            });
            if (config.debug) {
              api.logger.warn(
                `[ArmsTrace] Buffered assistant message waiting for llm_input: traceId=${ctx.traceId}, runId=${ctx.runId}`,
              );
            }
            return;
          }

          void enqueueTraceTask(ctx.traceId, async () => {
            await processAssistantMessageForContext(ctx, channelId, message);
          }).catch((err) => {
            api.logger.warn(`[ArmsTrace] before_message_write segmented export failed: ${String(err)}`);
          });
        },
      );
    }

    // -- Hook: before_tool_call ---------------------------------------------

    if (shouldHookEnabled("before_tool_call")) {
      api.on(
        "before_tool_call",
        async (
          event: BeforeToolCallEvent,
          hookCtx: PluginHookContext,
        ) => {
          const rawChannelId = resolveChannelId(hookCtx);
          const anchoredCtx =
            rawChannelId.startsWith("agent/")
              ? activeContextByAgentChannel.get(rawChannelId)
              : undefined;
          if (rawChannelId.startsWith("agent/") && !anchoredCtx) {
            if (config.debug) {
              api.logger.warn(
                `[ArmsTrace] Skip tool span without active agent context: tool=${event.toolName}, channelId=${rawChannelId}`,
              );
            }
            return;
          }
          const { ctx, channelId } = anchoredCtx
            ? { ctx: anchoredCtx, channelId: anchoredCtx.channelId }
            : getOrCreateContext(
              rawChannelId,
              resolveOptionalRunId(event.runId),
              "before_tool_call",
            );
          if (!ctx.hasSeenLlmInput) {
            if (config.debug) {
              api.logger.warn(
                `[ArmsTrace] Skip tool span before llm_input binding: tool=${event.toolName}, channelId=${channelId}, runId=${ctx.runId}`,
              );
            }
            return;
          }
          const runId = resolveOptionalRunId(event.runId) || ctx.runId;
          const toolCallId = resolveOptionalToolCallId(event.toolCallId) || `call_${generateId(12)}`;
          const pendingToolCall: PendingToolCall = {
            runId,
            toolName: event.toolName,
            toolCallId,
            toolSpanId: generateId(16),
            toolStartTime: Date.now(),
            toolInput: event.params,
            traceContext: ctx,
            channelId,
            createdAt: Date.now(),
          };
          pendingToolCalls.set(buildPendingToolCallKey(toolCallId, runId), pendingToolCall);
          if (config.debug) {
            api.logger.info(
              `[ArmsTrace] Tool call started: ${event.toolName}, toolCallId=${toolCallId}, runId=${runId}, spanId=${pendingToolCall.toolSpanId}`,
            );
          }
        },
      );
    }

    // -- Hook: after_tool_call ----------------------------------------------

    if (shouldHookEnabled("after_tool_call")) {
      api.on(
        "after_tool_call",
        async (
          event: AfterToolCallEvent,
          _hookCtx: PluginHookContext,
        ) => {
          const pendingToolCall = consumePendingToolCall(event);
          if (!pendingToolCall) {
            return;
          }

          const {
            toolName,
            toolCallId,
            toolSpanId,
            toolStartTime,
            toolInput,
            traceContext,
            channelId,
          } = pendingToolCall;
          const now = Date.now();

          const toolAttrs: Record<string, string | number | boolean> = {
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": toolName,
            "gen_ai.tool.call.id": toolCallId,
            "gen_ai.tool.type": "function",
            "tool.duration_ms": event.durationMs || now - toolStartTime,
          };
          if (toolInput !== undefined) {
            toolAttrs["gen_ai.tool.call.arguments"] = truncateAttr(
              typeof toolInput === "string" ? toolInput : JSON.stringify(toolInput),
            );
          }
          if (event.error) {
            toolAttrs["error.type"] = event.error;
          } else if (event.result !== undefined) {
            toolAttrs["gen_ai.tool.call.result"] = truncateAttr(
              typeof event.result === "string" ? event.result : JSON.stringify(event.result),
            );
          }

          const span = createSpan(
            traceContext,
            channelId,
            `execute_tool ${toolName}`,
            "tool",
            toolStartTime,
            now,
            toolAttrs,
            undefined,
            undefined,
            resolveStepFirstParentSpanId(traceContext),
          );
          span.spanId = toolSpanId;
          await exporter.export(span);

          const toolResultPayload =
            event.error
              ? [{ type: "toolResult", toolCallId, toolName, isError: true, content: event.error }]
              : [{ type: "toolResult", toolCallId, toolName, content: event.result }];
          traceContext.llmPendingToolResultsForNextInput.push({
            role: "toolResult",
            content: toolResultPayload,
          });

          const hadWaitingTools =
            traceContext.llmPendingToolCallIds.size > 0
            || traceContext.llmPendingToolCallCountFallback > 0;
          if (hadWaitingTools) {
            if (traceContext.llmPendingToolCallIds.size > 0) {
              if (traceContext.llmPendingToolCallIds.has(toolCallId)) {
                traceContext.llmPendingToolCallIds.delete(toolCallId);
              } else if (!resolveOptionalToolCallId(event.toolCallId)) {
                const firstPendingId = traceContext.llmPendingToolCallIds.values().next().value;
                if (firstPendingId) {
                  traceContext.llmPendingToolCallIds.delete(firstPendingId);
                }
              }
            } else if (traceContext.llmPendingToolCallCountFallback > 0) {
              traceContext.llmPendingToolCallCountFallback -= 1;
            }

            const toolBatchFinished =
              traceContext.llmPendingToolCallIds.size === 0
              && traceContext.llmPendingToolCallCountFallback === 0;
            if (toolBatchFinished) {
              const nextInputHistory: Array<{ role: string; content: unknown }> = [];
              if (traceContext.llmLastAssistantContent !== undefined) {
                nextInputHistory.push({
                  role: "assistant",
                  content: traceContext.llmLastAssistantContent,
                });
              }
              if (traceContext.llmPendingToolResultsForNextInput.length > 0) {
                nextInputHistory.push(...traceContext.llmPendingToolResultsForNextInput);
              }
              endStepSpan(traceContext, now, "toolUse", channelId);
              traceContext.llmPendingStartTime = now;
              traceContext.llmPendingSpanId = generateId(16);
              await ensureStepSpan(traceContext, channelId, now);
              traceContext.llmPendingSystemInstructions = undefined;
              traceContext.llmPendingInputMessages =
                nextInputHistory.length > 0
                  ? formatInputMessages(nextInputHistory)
                  : undefined;
              traceContext.llmLastInputMessages = traceContext.llmPendingInputMessages;
              traceContext.llmPendingToolResultsForNextInput = [];
              if (config.debug) {
                api.logger.info(
                  `[ArmsTrace] Prepared next segmented LLM start after tools: runId=${traceContext.runId}, tool=${toolName}, toolCallId=${toolCallId}`,
                );
              }
            }
          }

          if (config.debug) {
            api.logger.info(
              `[ArmsTrace] Exported tool span: ${toolName}, toolCallId=${toolCallId}, duration=${now - toolStartTime}ms`,
            );
          }
        },
      );
    }

    // -- Hook: before_agent_start -------------------------------------------

    if (shouldHookEnabled("before_agent_start")) {
      api.on(
        "before_agent_start",
        async (
          event: BeforeAgentStartEvent,
          hookCtx: PluginHookContext,
        ) => {
          const rawChannelId = resolveChannelId(hookCtx);
          const agentId =
            hookCtx.agentId || "openclaw";
          const { ctx, channelId } = getOrCreateContext(
            rawChannelId,
            undefined,
            "before_agent_start",
          );

          // Ensure ENTRY span exists (idempotent: skips if message_received already created one)
          await ensureEntrySpan(ctx, channelId, {
            userId: (hookCtx.trigger as string) || "system",
            role: (hookCtx.trigger as string) || "system",
            from: agentId,
          });
          await ensureAgentSpan(ctx, channelId, agentId);
        },
      );
    }

    // -- Hook: agent_end ----------------------------------------------------

    if (shouldHookEnabled("agent_end")) {
      api.on(
        "agent_end",
        async (event: AgentEndEvent, hookCtx: PluginHookContext) => {
          const rawChannelId = resolveChannelId(hookCtx);
          const { ctx, channelId } = getOrCreateContext(
            rawChannelId,
            undefined,
            "agent_end",
          );
          await drainTraceTasks(ctx.traceId);
          ctx.isClosing = true;
          const now = Date.now();
          if (ctx.stepSpanId) {
            endStepSpan(
              ctx,
              now,
              ctx.stepAwaitingToolResults ? "agent_end" : "stop",
              channelId,
            );
          }

          // Collect agent span closing data (defer actual close to setTimeout)
          const pendingAgentSpanId = ctx.agentSpanId;
          const agentEndTime = now;
          let agentEndAttrs: Record<string, string | number | boolean> | undefined;
          if (pendingAgentSpanId) {
            const agentMessageCount = Array.isArray(event.messages) ? event.messages.length : 0;
            const agentToolCallCount = countToolCallsFromMessages(event.messages);
            agentEndAttrs = {
              "agent.duration_ms": event.durationMs || 0,
              "agent.message_count": agentMessageCount,
              "agent.tool_call_count": agentToolCallCount,
              "gen_ai.usage.input_tokens": ctx.lastLlmUsage?.input || 0,
              "gen_ai.usage.output_tokens": ctx.lastLlmUsage?.output || 0,
              "gen_ai.usage.total_tokens": ctx.lastLlmUsage?.total || 0,
            };
            if (ctx.sessionId) {
              agentEndAttrs["openclaw.session.id"] = ctx.sessionId || channelId;
              agentEndAttrs["gen_ai.session.id"] = ctx.sessionId || channelId;
            }
            const agentInput = ctx.userInput;
            if (agentInput) {
              agentEndAttrs["gen_ai.input.messages"] = truncateAttr(
                JSON.stringify([{ role: "user", parts: [{ type: "text", content: String(agentInput) }] }]),
              );
            }
            ctx.agentSpanId = undefined;
            ctx.agentStartTime = undefined;
          }
          const agentUsageCost = pendingAgentSpanId && ctx.lastLlmUsage
            ? {
              usage: {
                input: ctx.lastLlmUsage.input,
                output: ctx.lastLlmUsage.output,
                total: ctx.lastLlmUsage.total,
              },
            }
            : undefined;

          const rootCtx = ctx;

          if (rootCtx.rootSpanStartTime || pendingAgentSpanId) {
            const rootSpanId = rootCtx.rootSpanId;
            const rootSpanStartTime = rootCtx.rootSpanStartTime;
            const userInput = rootCtx.userInput;
            const traceId = rootCtx.traceId;
            const resolvedSessionId = ctx.sessionId || rootCtx.sessionId;

            setTimeout(async () => {
              // By now llm_output / message_sending / message_sent should
              // have executed and written lastOutput onto the context.
              const finalOutput =
                ctx.lastOutput || rootCtx.lastOutput;

              // End agent span (deferred)
              if (pendingAgentSpanId && agentEndAttrs) {
                if (finalOutput) {
                  agentEndAttrs["gen_ai.output.messages"] = formatOutputMessages(
                    [typeof finalOutput === "string" ? finalOutput : JSON.stringify(finalOutput)],
                  );
                }
                exporter.endSpanById(
                  pendingAgentSpanId,
                  agentEndTime,
                  agentEndAttrs,
                  agentUsageCost,
                );
                if (config.debug) {
                  api.logger.info(
                    `[ArmsTrace] Ended agent span: spanId=${pendingAgentSpanId}, duration=${event.durationMs}ms`,
                  );
                }
              }

              // End root span
              if (rootSpanStartTime) {
                const endTime = Date.now();
                const rootEndAttrs: Record<string, string | number | boolean> = {
                  "request.duration_ms": endTime - rootSpanStartTime,
                };
                if (resolvedSessionId) {
                  rootEndAttrs["openclaw.session.id"] = resolvedSessionId;
                  rootEndAttrs["gen_ai.session.id"] = resolvedSessionId;
                }
                if (userInput) {
                  rootEndAttrs["gen_ai.input.messages"] = truncateAttr(
                    JSON.stringify([{ role: "user", parts: [{ type: "text", content: String(userInput) }] }]),
                  );
                }
                if (finalOutput) {
                  rootEndAttrs["gen_ai.output.messages"] = formatOutputMessages(
                    [typeof finalOutput === "string" ? finalOutput : JSON.stringify(finalOutput)],
                  );
                }
                exporter.endSpanById(
                  rootSpanId,
                  endTime,
                  rootEndAttrs,
                  finalOutput,
                  userInput,
                );
                if (config.debug) {
                  api.logger.info(
                    `[ArmsTrace] Ended root span: spanId=${rootSpanId}, duration=${endTime - rootSpanStartTime}ms, traceId=${traceId}`,
                  );
                }
              }

              // Clean up Map entries AFTER spans are closed so that
              // late-arriving hooks (llm_output) don't create stale entries.
              cleanupPendingToolCallsForRun(rootCtx.runId || ctx.runId);
              cleanupContextIdentity(rootCtx);

              await exporter.flush();
              exporter.endTrace();
            }, 100);
          } else {
            cleanupPendingToolCallsForRun(rootCtx.runId || ctx.runId);
            cleanupContextIdentity(rootCtx);
            await exporter.flush();
            exporter.endTrace();
          }
        },
      );
    }

    api.logger.info(
      `[ArmsTrace] Plugin activated (endpoint: ${config.endpoint}, service: ${config.serviceName})`,
    );
  },
};

export default armsTracePlugin;
