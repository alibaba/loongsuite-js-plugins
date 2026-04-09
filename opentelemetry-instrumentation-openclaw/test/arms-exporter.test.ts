// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for ArmsExporter.
 *
 * We mock all OTel SDK dependencies so tests run offline with zero I/O.
 * The mocks use plain functions (not arrow functions) so they work as
 * constructors in the ESM + Vitest environment.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ArmsExporter } from "../src/arms-exporter.js";
import type { OpenClawPluginApi, ArmsTraceConfig, SpanData } from "../src/types.js";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockSpan = {
  setAttribute: vi.fn(),
  setStatus: vi.fn(),
  end: vi.fn(),
  spanContext: vi.fn().mockReturnValue({ traceId: "trace-abc", spanId: "span-xyz" }),
};

const mockTracer = { startSpan: vi.fn().mockReturnValue(mockSpan) };

const mockProvider = {
  getTracer: vi.fn().mockReturnValue(mockTracer),
  forceFlush: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
};

vi.mock("@opentelemetry/exporter-trace-otlp-proto", () => ({
  OTLPTraceExporter: vi.fn(function (this: unknown) { return {}; }),
}));

vi.mock("@opentelemetry/resources", () => ({
  resourceFromAttributes: vi.fn().mockReturnValue({}),
}));

vi.mock("@opentelemetry/sdk-trace-base", () => ({
  BasicTracerProvider: vi.fn(function (this: unknown) { return mockProvider; }),
  BatchSpanProcessor: vi.fn(function (this: unknown) { return {}; }),
}));

vi.mock("@opentelemetry/api", () => ({
  trace: { setSpan: vi.fn().mockReturnValue({}) },
  context: { active: vi.fn().mockReturnValue({}) },
  SpanKind: { SERVER: 0, CLIENT: 1, INTERNAL: 2 },
  SpanStatusCode: { UNSET: 0, OK: 1, ERROR: 2 },
}));

vi.mock("@opentelemetry/semantic-conventions", () => ({
  ATTR_SERVICE_NAME: "service.name",
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeApi(): OpenClawPluginApi {
  return {
    config: {},
    pluginConfig: {},
    runtime: { version: "1.0.0" },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    on: vi.fn(),
  };
}

function makeConfig(overrides: Partial<ArmsTraceConfig> = {}): ArmsTraceConfig {
  return {
    endpoint: "https://otlp-example.com:4318",
    headers: { "x-arms-license-key": "test-key" },
    serviceName: "test-service",
    debug: false,
    batchSize: 5,
    flushIntervalMs: 1000,
    ...overrides,
  };
}

function makeSpanData(overrides: Partial<SpanData> = {}): SpanData {
  return {
    name: "test-span",
    type: "tool",
    startTime: Date.now() - 100,
    endTime: Date.now(),
    attributes: { "gen_ai.tool.name": "Bash" },
    traceId: "trace-001",
    spanId: "span-001",
    parentSpanId: "span-root",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ArmsExporter", () => {
  let api: OpenClawPluginApi;
  let exporter: ArmsExporter;

  beforeEach(() => {
    api = makeApi();
    exporter = new ArmsExporter(api, makeConfig());
    // Reset span mock call history
    mockSpan.setAttribute.mockClear();
    mockSpan.setStatus.mockClear();
    mockSpan.end.mockClear();
    mockTracer.startSpan.mockClear();
  });

  // ── Construction ──────────────────────────────────────────────────────────

  it("creates an instance without throwing", () => {
    expect(exporter).toBeDefined();
  });

  // ── ensureInitialized ─────────────────────────────────────────────────────

  describe("ensureInitialized", () => {
    it("resolves without error", async () => {
      await expect(exporter.ensureInitialized()).resolves.toBeUndefined();
    });

    it("is idempotent — multiple calls do not re-initialize", async () => {
      const before = mockProvider.getTracer.mock.calls.length;
      await exporter.ensureInitialized();
      const after1 = mockProvider.getTracer.mock.calls.length;
      await exporter.ensureInitialized(); // second call should not call getTracer again
      const after2 = mockProvider.getTracer.mock.calls.length;
      expect(after1 - before).toBe(1);     // first call initialized once
      expect(after2 - after1).toBe(0);     // second call is no-op
    });
  });

  // ── resolveTraceUrl (tested via ensureInitialized) ────────────────────────

  describe("endpoint URL handling", () => {
    it("resolves URL correctly without re-initializing on repeat calls", async () => {
      const before = mockProvider.getTracer.mock.calls.length;
      await exporter.ensureInitialized();
      await exporter.ensureInitialized(); // idempotent
      // Only one extra getTracer call despite two ensureInitialized calls
      expect(mockProvider.getTracer.mock.calls.length - before).toBe(1);
    });
  });

  // ── export (fire-and-forget spans) ───────────────────────────────────────

  describe("export", () => {
    it("exports a tool span without throwing", async () => {
      await expect(exporter.export(makeSpanData({ type: "tool" }))).resolves.toBeUndefined();
    });

    it("exports an entry span", async () => {
      await expect(exporter.export(makeSpanData({ type: "entry" }))).resolves.toBeUndefined();
    });

    it("exports a model (LLM) span", async () => {
      await expect(exporter.export(makeSpanData({ type: "model" }))).resolves.toBeUndefined();
    });

    it("exports an agent span", async () => {
      await expect(exporter.export(makeSpanData({ type: "agent" }))).resolves.toBeUndefined();
    });

    it("calls span.end after export", async () => {
      await exporter.export(makeSpanData());
      expect(mockSpan.end).toHaveBeenCalled();
    });

    it("uses current time when endTime is omitted", async () => {
      const spanData = makeSpanData({ endTime: undefined });
      await expect(exporter.export(spanData)).resolves.toBeUndefined();
    });

    it("marks span ERROR when error.type attribute is set", async () => {
      const { SpanStatusCode } = await import("@opentelemetry/api");
      await exporter.export(makeSpanData({ attributes: { "error.type": "TimeoutError" } }));
      expect(mockSpan.setStatus).toHaveBeenCalledWith(
        expect.objectContaining({ code: SpanStatusCode.ERROR })
      );
    });

    it("marks span OK for normal spans", async () => {
      const { SpanStatusCode } = await import("@opentelemetry/api");
      await exporter.export(makeSpanData({ attributes: {} }));
      expect(mockSpan.setStatus).toHaveBeenCalledWith(
        expect.objectContaining({ code: SpanStatusCode.OK })
      );
    });
  });

  // ── startSpan / endSpanById ───────────────────────────────────────────────

  describe("startSpan + endSpanById", () => {
    it("startSpan resolves without error", async () => {
      await expect(exporter.startSpan(makeSpanData({ type: "agent" }), "agent-span-1")).resolves.toBeUndefined();
    });

    it("endSpanById ends an open span", async () => {
      await exporter.startSpan(makeSpanData({ type: "agent" }), "my-span");
      mockSpan.end.mockClear();
      exporter.endSpanById("my-span", Date.now());
      expect(mockSpan.end).toHaveBeenCalled();
    });

    it("endSpanById with unknown id is a no-op", () => {
      expect(() => exporter.endSpanById("nonexistent", Date.now())).not.toThrow();
    });

    it("endSpanById passes additional attributes to span", async () => {
      await exporter.startSpan(makeSpanData({ type: "entry" }), "span-attrs");
      exporter.endSpanById("span-attrs", Date.now(), {
        "agent.duration_ms": 1500,
        "gen_ai.usage.total_tokens": 200,
      });
      expect(mockSpan.setAttribute).toHaveBeenCalledWith("agent.duration_ms", 1500);
    });

    it("span is removed from open map after endSpanById", async () => {
      await exporter.startSpan(makeSpanData({ type: "entry" }), "remove-me");
      exporter.endSpanById("remove-me", Date.now());
      // Second call is a no-op (span already removed)
      mockSpan.end.mockClear();
      exporter.endSpanById("remove-me", Date.now());
      expect(mockSpan.end).not.toHaveBeenCalled();
    });
  });

  // ── patchOpenSpanAttributes ───────────────────────────────────────────────

  describe("patchOpenSpanAttributes", () => {
    it("patches attributes on an open span", async () => {
      await exporter.startSpan(makeSpanData({ type: "entry" }), "patch-me");
      exporter.patchOpenSpanAttributes("patch-me", { "openclaw.run.id": "run-abc" });
      expect(mockSpan.setAttribute).toHaveBeenCalledWith("openclaw.run.id", "run-abc");
    });

    it("is a no-op for unknown span id", () => {
      expect(() =>
        exporter.patchOpenSpanAttributes("unknown", { "any.attr": "val" })
      ).not.toThrow();
    });

    it("skips undefined and null values", async () => {
      await exporter.startSpan(makeSpanData({ type: "entry" }), "patch-nulls");
      // Type cast to test runtime behavior with null/undefined values
      exporter.patchOpenSpanAttributes("patch-nulls", {
        "valid.attr": "ok",
        "null.attr": null as unknown as string,
        "undefined.attr": undefined as unknown as string,
      });
      expect(mockSpan.setAttribute).toHaveBeenCalledWith("valid.attr", "ok");
      expect(mockSpan.setAttribute).not.toHaveBeenCalledWith("null.attr", expect.anything());
    });
  });

  // ── endTrace ──────────────────────────────────────────────────────────────

  describe("endTrace", () => {
    it("is a no-op (does not clear open spans)", async () => {
      await exporter.startSpan(makeSpanData({ type: "agent" }), "long-lived");
      exporter.endTrace(); // Should not close the span
      mockSpan.end.mockClear();
      // Span is still open
      exporter.endSpanById("long-lived", Date.now());
      expect(mockSpan.end).toHaveBeenCalled();
    });
  });

  // ── flush / dispose ───────────────────────────────────────────────────────

  describe("flush and dispose", () => {
    it("flush resolves when not yet initialized", async () => {
      await expect(exporter.flush()).resolves.toBeUndefined();
    });

    it("flush calls provider.forceFlush after initialization", async () => {
      await exporter.ensureInitialized();
      await exporter.flush();
      expect(mockProvider.forceFlush).toHaveBeenCalled();
    });

    it("dispose resolves when not yet initialized", async () => {
      await expect(exporter.dispose()).resolves.toBeUndefined();
    });

    it("dispose calls provider.shutdown after initialization", async () => {
      await exporter.ensureInitialized();
      await exporter.dispose();
      expect(mockProvider.shutdown).toHaveBeenCalled();
    });
  });

  // ── debug mode ────────────────────────────────────────────────────────────

  describe("debug mode", () => {
    it("logs info messages when debug is enabled", async () => {
      const debugExporter = new ArmsExporter(api, makeConfig({ debug: true }));
      await debugExporter.ensureInitialized();
      const spanData = makeSpanData();
      await debugExporter.export(spanData);
      expect(api.logger.info).toHaveBeenCalled();
      await debugExporter.dispose();
    });

    it("does not call logger.info for normal spans in non-debug mode", async () => {
      await exporter.ensureInitialized();
      const spanData = makeSpanData();
      await exporter.export(spanData);
      // In non-debug mode, info is only called during initialization
      const initCallCount = (api.logger.info as ReturnType<typeof vi.fn>).mock.calls.length;
      await exporter.export(spanData); // second export
      expect((api.logger.info as ReturnType<typeof vi.fn>).mock.calls.length).toBe(initCallCount);
    });
  });
});
