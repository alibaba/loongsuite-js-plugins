import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  applyMemoryFinishAttributes,
  maybeEmitMemoryEvent,
} from "../src/memory/memory-utils.js";
import { createMemoryInvocation } from "../src/memory/memory-types.js";
import {
  GEN_AI_MEMORY_OPERATION,
  GEN_AI_MEMORY_USER_ID,
  GEN_AI_MEMORY_AGENT_ID,
  GEN_AI_MEMORY_ID,
  GEN_AI_MEMORY_TOP_K,
} from "../src/semconv/gen-ai-memory-attributes.js";
import {
  GEN_AI_OPERATION_NAME,
  GEN_AI_SPAN_KIND,
} from "../src/semconv/gen-ai-extended-attributes.js";

function createMockSpan() {
  return {
    updateName: vi.fn(),
    setAttributes: vi.fn(),
    setAttribute: vi.fn(),
    isRecording: vi.fn().mockReturnValue(true),
    setStatus: vi.fn(),
  };
}

describe("memory-utils", () => {
  describe("applyMemoryFinishAttributes", () => {
    it("sets span name with operation", () => {
      const span = createMockSpan();
      const inv = createMemoryInvocation("search", {
        userId: "user-1",
        agentId: "agent-1",
        topK: 10,
      });

      applyMemoryFinishAttributes(span as any, inv);

      expect(span.updateName).toHaveBeenCalledWith(
        "memory_operation search",
      );
      expect(span.setAttribute).toHaveBeenCalledWith(
        GEN_AI_SPAN_KIND,
        "MEMORY",
      );
      expect(span.setAttributes).toHaveBeenCalled();

      const attrs = span.setAttributes.mock.calls[0][0];
      expect(attrs[GEN_AI_OPERATION_NAME]).toBe("memory_operation");
      expect(attrs[GEN_AI_MEMORY_OPERATION]).toBe("search");
      expect(attrs[GEN_AI_MEMORY_USER_ID]).toBe("user-1");
      expect(attrs[GEN_AI_MEMORY_AGENT_ID]).toBe("agent-1");
      expect(attrs[GEN_AI_MEMORY_TOP_K]).toBe(10);
    });

    it("sets default span name when no operation", () => {
      const span = createMockSpan();
      const inv = createMemoryInvocation("");
      applyMemoryFinishAttributes(span as any, inv);
      expect(span.updateName).toHaveBeenCalledWith("memory_operation");
    });

    it("includes memory parameters", () => {
      const span = createMockSpan();
      const inv = createMemoryInvocation("add", {
        memoryId: "mem-1",
        limit: 5,
        page: 1,
        pageSize: 10,
        memoryType: "procedural_memory",
        threshold: 0.8,
        rerank: true,
      });

      applyMemoryFinishAttributes(span as any, inv);
      const attrs = span.setAttributes.mock.calls[0][0];
      expect(attrs[GEN_AI_MEMORY_ID]).toBe("mem-1");
    });
  });

  describe("maybeEmitMemoryEvent", () => {
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
      saved["OTEL_SEMCONV_STABILITY_OPT_IN"] =
        process.env["OTEL_SEMCONV_STABILITY_OPT_IN"];
      saved["OTEL_INSTRUMENTATION_GENAI_EMIT_EVENT"] =
        process.env["OTEL_INSTRUMENTATION_GENAI_EMIT_EVENT"];
    });
    afterEach(() => {
      for (const [key, val] of Object.entries(saved)) {
        if (val === undefined) delete process.env[key];
        else process.env[key] = val;
      }
    });

    it("does nothing when not experimental", () => {
      delete process.env["OTEL_SEMCONV_STABILITY_OPT_IN"];
      const logger = { emit: vi.fn() };
      const span = createMockSpan();
      maybeEmitMemoryEvent(
        logger,
        span as any,
        createMemoryInvocation("add"),
      );
      expect(logger.emit).not.toHaveBeenCalled();
    });

    it("emits event when experimental and emit enabled", () => {
      process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] =
        "gen_ai_latest_experimental";
      process.env["OTEL_INSTRUMENTATION_GENAI_EMIT_EVENT"] = "true";
      const logger = { emit: vi.fn() };
      const span = createMockSpan();
      maybeEmitMemoryEvent(
        logger,
        span as any,
        createMemoryInvocation("search", { userId: "u1" }),
      );
      expect(logger.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "gen_ai.memory.operation.details",
        }),
      );
    });

    it("includes error type when error provided", () => {
      process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] =
        "gen_ai_latest_experimental";
      process.env["OTEL_INSTRUMENTATION_GENAI_EMIT_EVENT"] = "true";
      const logger = { emit: vi.fn() };
      const span = createMockSpan();
      maybeEmitMemoryEvent(
        logger,
        span as any,
        createMemoryInvocation("add"),
        { message: "fail", type: "MemError" },
      );
      const call = logger.emit.mock.calls[0][0];
      expect(call.attributes["error.type"]).toBe("MemError");
    });
  });
});
