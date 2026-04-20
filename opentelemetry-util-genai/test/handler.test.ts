import { describe, it, expect, vi, beforeEach } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { TelemetryHandler, getTelemetryHandler } from "../src/handler.js";
import { createLLMInvocation } from "../src/types.js";
import type { GenAIError } from "../src/types.js";

function createMockTracer() {
  const endFn = vi.fn();
  const setAttributesFn = vi.fn();
  const setAttributeFn = vi.fn();
  const updateNameFn = vi.fn();
  const setStatusFn = vi.fn();
  const isRecordingFn = vi.fn().mockReturnValue(true);
  const spanContextFn = vi.fn().mockReturnValue({
    traceId: "abc",
    spanId: "def",
    traceFlags: 1,
  });

  const mockSpan = {
    end: endFn,
    setAttributes: setAttributesFn,
    setAttribute: setAttributeFn,
    updateName: updateNameFn,
    setStatus: setStatusFn,
    isRecording: isRecordingFn,
    spanContext: spanContextFn,
    recordException: vi.fn(),
    addEvent: vi.fn(),
  };

  const startSpanFn = vi.fn().mockReturnValue(mockSpan);
  const mockTracer = { startSpan: startSpanFn };

  const mockTracerProvider = {
    getTracer: vi.fn().mockReturnValue(mockTracer),
  };

  const mockMeter = {
    createHistogram: vi.fn().mockReturnValue({ record: vi.fn() }),
  };
  const mockMeterProvider = {
    getMeter: vi.fn().mockReturnValue(mockMeter),
  };

  return {
    mockSpan,
    mockTracer,
    mockTracerProvider,
    mockMeterProvider,
    startSpanFn,
    endFn,
    setAttributesFn,
    updateNameFn,
    setStatusFn,
  };
}

describe("TelemetryHandler", () => {
  let mocks: ReturnType<typeof createMockTracer>;
  let handler: TelemetryHandler;

  beforeEach(() => {
    mocks = createMockTracer();
    handler = new TelemetryHandler({
      tracerProvider: mocks.mockTracerProvider as any,
      meterProvider: mocks.mockMeterProvider as any,
    });
  });

  describe("startLlm", () => {
    it("creates a span and sets invocation fields", () => {
      const inv = createLLMInvocation({
        requestModel: "gpt-4",
        provider: "openai",
      });

      handler.startLlm(inv);

      expect(mocks.startSpanFn).toHaveBeenCalledOnce();
      expect(inv.span).toBe(mocks.mockSpan);
      expect(inv.monotonicStartS).toBeTypeOf("number");
    });

    it("passes custom startTime to tracer.startSpan", () => {
      const inv = createLLMInvocation({ requestModel: "gpt-4" });
      const customStart = 1700000000000;

      handler.startLlm(inv, undefined, customStart);

      expect(mocks.startSpanFn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ startTime: customStart }),
        undefined,
      );
    });
  });

  describe("stopLlm", () => {
    it("applies attributes and ends span", () => {
      const inv = createLLMInvocation({
        requestModel: "gpt-4",
        provider: "openai",
      });

      handler.startLlm(inv);
      inv.outputMessages = [
        {
          role: "assistant",
          parts: [{ type: "text", content: "Hello!" }],
          finishReason: "stop",
        },
      ];
      inv.inputTokens = 10;
      inv.outputTokens = 20;
      handler.stopLlm(inv);

      expect(mocks.updateNameFn).toHaveBeenCalled();
      expect(mocks.setAttributesFn).toHaveBeenCalled();
      expect(mocks.endFn).toHaveBeenCalledOnce();
    });

    it("passes custom endTime to span.end", () => {
      const inv = createLLMInvocation({ requestModel: "gpt-4" });
      handler.startLlm(inv);
      const customEnd = 1700000005000;

      handler.stopLlm(inv, customEnd);

      expect(mocks.endFn).toHaveBeenCalledWith(customEnd);
    });

    it("returns invocation if not started", () => {
      const inv = createLLMInvocation();
      const result = handler.stopLlm(inv);
      expect(result).toBe(inv);
      expect(mocks.endFn).not.toHaveBeenCalled();
    });
  });

  describe("failLlm", () => {
    it("applies error attributes and ends span", () => {
      const inv = createLLMInvocation({
        requestModel: "gpt-4",
        provider: "openai",
      });

      handler.startLlm(inv);

      const error: GenAIError = {
        message: "API error",
        type: "ApiError",
      };
      handler.failLlm(inv, error);

      expect(mocks.setStatusFn).toHaveBeenCalledWith(
        expect.objectContaining({
          code: SpanStatusCode.ERROR,
          message: "API error",
        }),
      );
      expect(mocks.endFn).toHaveBeenCalledOnce();
    });

    it("passes custom endTime to span.end", () => {
      const inv = createLLMInvocation({ requestModel: "gpt-4" });
      handler.startLlm(inv);
      const customEnd = 1700000009000;

      handler.failLlm(inv, { message: "err", type: "E" }, customEnd);

      expect(mocks.endFn).toHaveBeenCalledWith(customEnd);
    });
  });

  describe("llm callback", () => {
    it("runs callback and stops invocation on success", () => {
      const inv = createLLMInvocation({
        requestModel: "gpt-4",
        provider: "openai",
      });

      handler.llm(inv, (i) => {
        i.inputTokens = 5;
        i.outputTokens = 10;
      });

      expect(mocks.endFn).toHaveBeenCalledOnce();
    });

    it("marks error on exception and re-throws", () => {
      const inv = createLLMInvocation({
        requestModel: "gpt-4",
        provider: "openai",
      });

      expect(() =>
        handler.llm(inv, () => {
          throw new Error("test error");
        }),
      ).toThrow("test error");

      expect(mocks.setStatusFn).toHaveBeenCalledWith(
        expect.objectContaining({ code: SpanStatusCode.ERROR }),
      );
      expect(mocks.endFn).toHaveBeenCalledOnce();
    });

    it("handles async callback", async () => {
      const inv = createLLMInvocation({
        requestModel: "gpt-4",
        provider: "openai",
      });

      await handler.llm(inv, async (i) => {
        i.inputTokens = 5;
      });

      expect(mocks.endFn).toHaveBeenCalledOnce();
    });

    it("handles async error", async () => {
      const inv = createLLMInvocation({
        requestModel: "gpt-4",
        provider: "openai",
      });

      await expect(
        handler.llm(inv, async () => {
          throw new Error("async error");
        }),
      ).rejects.toThrow("async error");

      expect(mocks.endFn).toHaveBeenCalledOnce();
    });

    it("works with no invocation (creates default)", () => {
      handler.llm(null, (i) => {
        expect(i.operationName).toBe("chat");
      });
      expect(mocks.endFn).toHaveBeenCalledOnce();
    });
  });
});

describe("getTelemetryHandler", () => {
  it("returns a TelemetryHandler", () => {
    const handler = getTelemetryHandler();
    expect(handler).toBeInstanceOf(TelemetryHandler);
  });
});
