import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isExperimentalMode,
  getContentCapturingMode,
  shouldEmitEvent,
  shouldCaptureContentInSpan,
  shouldCaptureContentInEvent,
  genAiJsonDumps,
} from "../src/utils.js";
import { ContentCapturingMode } from "../src/types.js";

describe("utils", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved["OTEL_SEMCONV_STABILITY_OPT_IN"] =
      process.env["OTEL_SEMCONV_STABILITY_OPT_IN"];
    saved["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] =
      process.env["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"];
    saved["OTEL_INSTRUMENTATION_GENAI_EMIT_EVENT"] =
      process.env["OTEL_INSTRUMENTATION_GENAI_EMIT_EVENT"];
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(saved)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  describe("isExperimentalMode", () => {
    it("returns false when env var is not set", () => {
      delete process.env["OTEL_SEMCONV_STABILITY_OPT_IN"];
      expect(isExperimentalMode()).toBe(false);
    });

    it("returns true when set to gen_ai_latest_experimental", () => {
      process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] =
        "gen_ai_latest_experimental";
      expect(isExperimentalMode()).toBe(true);
    });

    it("returns true when included among comma-separated values", () => {
      process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] =
        "http,gen_ai_latest_experimental";
      expect(isExperimentalMode()).toBe(true);
    });

    it("returns false for other values", () => {
      process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] = "http";
      expect(isExperimentalMode()).toBe(false);
    });
  });

  describe("getContentCapturingMode", () => {
    it("returns NO_CONTENT when not in experimental mode", () => {
      delete process.env["OTEL_SEMCONV_STABILITY_OPT_IN"];
      expect(getContentCapturingMode()).toBe(ContentCapturingMode.NO_CONTENT);
    });

    it("returns NO_CONTENT when env var is not set", () => {
      process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] =
        "gen_ai_latest_experimental";
      delete process.env[
        "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"
      ];
      expect(getContentCapturingMode()).toBe(ContentCapturingMode.NO_CONTENT);
    });

    it("returns SPAN_ONLY", () => {
      process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] =
        "gen_ai_latest_experimental";
      process.env["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] =
        "SPAN_ONLY";
      expect(getContentCapturingMode()).toBe(ContentCapturingMode.SPAN_ONLY);
    });

    it("returns EVENT_ONLY", () => {
      process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] =
        "gen_ai_latest_experimental";
      process.env["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] =
        "event_only";
      expect(getContentCapturingMode()).toBe(ContentCapturingMode.EVENT_ONLY);
    });

    it("returns SPAN_AND_EVENT", () => {
      process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] =
        "gen_ai_latest_experimental";
      process.env["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] =
        "SPAN_AND_EVENT";
      expect(getContentCapturingMode()).toBe(
        ContentCapturingMode.SPAN_AND_EVENT,
      );
    });

    it("returns NO_CONTENT for invalid value", () => {
      process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] =
        "gen_ai_latest_experimental";
      process.env["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] =
        "INVALID";
      expect(getContentCapturingMode()).toBe(ContentCapturingMode.NO_CONTENT);
    });
  });

  describe("shouldEmitEvent", () => {
    it("returns false when not experimental", () => {
      delete process.env["OTEL_SEMCONV_STABILITY_OPT_IN"];
      expect(shouldEmitEvent()).toBe(false);
    });

    it("returns true when explicitly set to true", () => {
      process.env["OTEL_INSTRUMENTATION_GENAI_EMIT_EVENT"] = "true";
      expect(shouldEmitEvent()).toBe(true);
    });

    it("returns false when explicitly set to false", () => {
      process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] =
        "gen_ai_latest_experimental";
      process.env["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] =
        "EVENT_ONLY";
      process.env["OTEL_INSTRUMENTATION_GENAI_EMIT_EVENT"] = "false";
      expect(shouldEmitEvent()).toBe(false);
    });

    it("defaults to true for EVENT_ONLY", () => {
      process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] =
        "gen_ai_latest_experimental";
      process.env["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] =
        "EVENT_ONLY";
      delete process.env["OTEL_INSTRUMENTATION_GENAI_EMIT_EVENT"];
      expect(shouldEmitEvent()).toBe(true);
    });

    it("defaults to false for NO_CONTENT", () => {
      process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] =
        "gen_ai_latest_experimental";
      delete process.env[
        "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"
      ];
      delete process.env["OTEL_INSTRUMENTATION_GENAI_EMIT_EVENT"];
      expect(shouldEmitEvent()).toBe(false);
    });
  });

  describe("shouldCaptureContentInSpan", () => {
    it("returns false when not experimental", () => {
      delete process.env["OTEL_SEMCONV_STABILITY_OPT_IN"];
      expect(shouldCaptureContentInSpan()).toBe(false);
    });

    it("returns true for SPAN_ONLY", () => {
      process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] =
        "gen_ai_latest_experimental";
      process.env["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] =
        "SPAN_ONLY";
      expect(shouldCaptureContentInSpan()).toBe(true);
    });

    it("returns true for SPAN_AND_EVENT", () => {
      process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] =
        "gen_ai_latest_experimental";
      process.env["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] =
        "SPAN_AND_EVENT";
      expect(shouldCaptureContentInSpan()).toBe(true);
    });
  });

  describe("shouldCaptureContentInEvent", () => {
    it("returns true for EVENT_ONLY", () => {
      process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] =
        "gen_ai_latest_experimental";
      process.env["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] =
        "EVENT_ONLY";
      expect(shouldCaptureContentInEvent()).toBe(true);
    });
  });

  describe("genAiJsonDumps", () => {
    it("serializes plain objects", () => {
      expect(genAiJsonDumps({ a: 1, b: "hello" })).toBe(
        '{"a":1,"b":"hello"}',
      );
    });

    it("serializes Buffer to base64", () => {
      const buf = Buffer.from("hello");
      const result = JSON.parse(genAiJsonDumps({ data: buf }));
      expect(result.data).toEqual(expect.objectContaining({ type: "Buffer" }));
    });

    it("handles null and undefined", () => {
      expect(genAiJsonDumps(null)).toBe("null");
    });
  });
});
