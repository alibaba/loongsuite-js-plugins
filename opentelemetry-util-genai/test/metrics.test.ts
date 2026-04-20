import { describe, it, expect, vi, beforeEach } from "vitest";
import { InvocationMetricsRecorder } from "../src/metrics.js";
import { ExtendedInvocationMetricsRecorder } from "../src/extended-metrics.js";
import { createLLMInvocation } from "../src/types.js";

function createMockMeter() {
  const recordFn = vi.fn();
  return {
    meter: {
      createHistogram: vi.fn().mockReturnValue({ record: recordFn }),
    },
    recordFn,
  };
}

describe("InvocationMetricsRecorder", () => {
  let mocks: ReturnType<typeof createMockMeter>;
  let recorder: InvocationMetricsRecorder;

  beforeEach(() => {
    mocks = createMockMeter();
    recorder = new InvocationMetricsRecorder(mocks.meter as any);
  });

  it("creates duration and token histograms", () => {
    expect(mocks.meter.createHistogram).toHaveBeenCalledTimes(2);
  });

  it("records duration when monotonicStartS is set", () => {
    const mockSpan = {
      spanContext: vi.fn().mockReturnValue({
        traceId: "abc",
        spanId: "def",
        traceFlags: 1,
      }),
    };
    const inv = createLLMInvocation({
      requestModel: "gpt-4",
      provider: "openai",
      monotonicStartS: performance.now() / 1000 - 1.0,
    });

    recorder.record(mockSpan as any, inv);
    expect(mocks.recordFn).toHaveBeenCalled();
  });

  it("records token counts", () => {
    const mockSpan = {
      spanContext: vi.fn().mockReturnValue({
        traceId: "abc",
        spanId: "def",
        traceFlags: 1,
      }),
    };
    const inv = createLLMInvocation({
      requestModel: "gpt-4",
      inputTokens: 10,
      outputTokens: 20,
      monotonicStartS: performance.now() / 1000,
    });

    recorder.record(mockSpan as any, inv);
    // duration + 2 token records = 3 calls
    expect(mocks.recordFn).toHaveBeenCalledTimes(3);
  });

  it("skips recording when span is null", () => {
    const inv = createLLMInvocation();
    recorder.record(null, inv);
    expect(mocks.recordFn).not.toHaveBeenCalled();
  });

  it("includes error type in attributes", () => {
    const mockSpan = {
      spanContext: vi.fn().mockReturnValue({
        traceId: "abc",
        spanId: "def",
        traceFlags: 1,
      }),
    };
    const inv = createLLMInvocation({
      requestModel: "gpt-4",
      monotonicStartS: performance.now() / 1000,
    });

    recorder.record(mockSpan as any, inv, { errorType: "TimeoutError" });
    expect(mocks.recordFn).toHaveBeenCalled();
    const callArgs = mocks.recordFn.mock.calls[0];
    expect(callArgs[1]).toHaveProperty("error.type", "TimeoutError");
  });
});

describe("ExtendedInvocationMetricsRecorder", () => {
  it("delegates LLM to base record", () => {
    const { meter, recordFn } = createMockMeter();
    const recorder = new ExtendedInvocationMetricsRecorder(meter as any);
    const mockSpan = {
      spanContext: vi.fn().mockReturnValue({
        traceId: "abc",
        spanId: "def",
        traceFlags: 1,
      }),
    };

    const inv = createLLMInvocation({
      requestModel: "gpt-4",
      monotonicStartS: performance.now() / 1000,
    });

    recorder.recordExtended(mockSpan as any, inv);
    expect(recordFn).toHaveBeenCalled();
  });

  it("handles non-LLM invocations without error", () => {
    const { meter, recordFn } = createMockMeter();
    const recorder = new ExtendedInvocationMetricsRecorder(meter as any);
    const mockSpan = { spanContext: vi.fn() };

    recorder.recordExtended(mockSpan as any, {
      requestModel: "text-embedding-3-small",
      attributes: {},
    });
    // Non-LLM types are not yet implemented, so no record calls
    expect(recordFn).not.toHaveBeenCalled();
  });
});
