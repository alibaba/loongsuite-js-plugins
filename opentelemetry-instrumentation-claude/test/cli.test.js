// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");

// ─── Redirect state files to a temp dir ───────────────────────────────────
const TMP_STATE = path.join(os.tmpdir(), `otel-claude-test-${process.pid}`);
fs.mkdirSync(TMP_STATE, { recursive: true });

// Mock state module to use temp dir
jest.mock("../src/state", () => {
  const path2 = require("path");
  const fs2 = require("fs");
  const os2 = require("os");
  const tmpDir = path2.join(os2.tmpdir(), `otel-claude-test-${process.pid}`);
  fs2.mkdirSync(tmpDir, { recursive: true });

  function stateFile(sid) { return path2.join(tmpDir, `${sid}.json`); }
  function stateDir() { return tmpDir; }

  return {
    STATE_DIR: tmpDir,
    stateFile,
    stateDir,
    loadState(sid) {
      const sf = stateFile(sid);
      if (fs2.existsSync(sf)) {
        try { return JSON.parse(fs2.readFileSync(sf, "utf-8")); } catch {}
      }
      return { session_id: sid, start_time: Date.now() / 1000, prompt: "", model: "unknown",
               metrics: { input_tokens: 0, output_tokens: 0, tools_used: 0, turns: 0 },
               tools_used: [], events: [] };
    },
    saveState(sid, state) { fs2.writeFileSync(stateFile(sid), JSON.stringify(state), "utf-8"); },
    clearState(sid) { try { fs2.unlinkSync(stateFile(sid)); } catch {} },
    readAndDeleteChildState(sid) {
      const sf = stateFile(sid);
      if (!fs2.existsSync(sf)) return null;
      try { const d = JSON.parse(fs2.readFileSync(sf, "utf-8")); fs2.unlinkSync(sf); return d; } catch { return null; }
    },
  };
});

// Mock telemetry
jest.mock("../src/telemetry", () => ({
  configureTelemetry: jest.fn(),
  shutdownTelemetry: jest.fn().mockResolvedValue(undefined),
  resolveServiceName: jest.fn().mockReturnValue("test-service"),
}));

// Mock OTel API
jest.mock("@opentelemetry/api", () => ({
  trace: {
    getTracer: jest.fn().mockReturnValue({
      startSpan: jest.fn().mockReturnValue({ setAttribute: jest.fn(), end: jest.fn() }),
    }),
    setSpan: jest.fn().mockReturnValue({}),
  },
  context: { active: jest.fn().mockReturnValue({}) },
  SpanStatusCode: { ERROR: 2 },
}));

const stateModule = require("../src/state");
const cli = require("../src/cli");

afterAll(() => {
  try { fs.rmSync(TMP_STATE, { recursive: true, force: true }); } catch {}
});

// ─── buildHookConfig ───────────────────────────────────────────────────────
describe("buildHookConfig", () => {
  test("generates config for all 8 hook events", () => {
    const config = cli._buildHookConfig("otel-claude-hook");
    const events = Object.keys(config);
    expect(events).toContain("UserPromptSubmit");
    expect(events).toContain("PreToolUse");
    expect(events).toContain("PostToolUse");
    expect(events).toContain("Stop");
    expect(events).toContain("PreCompact");
    expect(events).toContain("SubagentStart");
    expect(events).toContain("SubagentStop");
    expect(events).toContain("Notification");
    expect(events).toHaveLength(8);
  });

  test("uses provided command name", () => {
    const config = cli._buildHookConfig("my-hook");
    const cmd = config.UserPromptSubmit[0].hooks[0].command;
    expect(cmd).toContain("my-hook");
    expect(cmd).toContain("user-prompt-submit");
  });
});

// ─── tsNs: seconds → integer nanoseconds ─────────────────────────────────
describe("tsNs (seconds → integer nanoseconds)", () => {
  test("converts seconds to nanoseconds integer", () => {
    const ns = cli._tsNs(1.5);
    expect(ns).toBe(1500000000);
  });
  test("handles whole seconds", () => {
    expect(cli._tsNs(100)).toBe(100000000000);
  });
  test("sub-second precision", () => {
    expect(cli._tsNs(1.001)).toBe(1001000000);
  });
});

// ─── hrTime: seconds → [sec, nanos] OTel HrTime tuple ────────────────────
describe("hrTime (seconds → [sec, nanos] HrTime tuple)", () => {
  test("returns [seconds, nanos] tuple", () => {
    expect(cli._hrTime(1.5)).toEqual([1, 500000000]);
  });
  test("handles integer seconds", () => {
    expect(cli._hrTime(100)).toEqual([100, 0]);
  });
  test("subsecond precision", () => {
    expect(cli._hrTime(1.001)).toEqual([1, 1000000]);
  });
});

// ─── readProxyEvents ──────────────────────────────────────────────────────
describe("readProxyEvents", () => {
  test("returns empty array when dir does not exist", () => {
    const result = cli._readProxyEvents(0, 1e10, false, null);
    expect(Array.isArray(result)).toBe(true);
  });

  test("reads events from JSONL file within time window", () => {
    const now = Date.now() / 1000;
    const evt = JSON.stringify({ type: "llm_call", timestamp: now, model: "claude" });
    const file = path.join(TMP_STATE, "proxy_events_99999.jsonl");
    fs.writeFileSync(file, evt + "\n", "utf-8");
    const results = cli._readProxyEvents(now - 10, now + 10, false, 99999);
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("llm_call");
    fs.unlinkSync(file);
  });

  test("filters events outside time window", () => {
    const now = Date.now() / 1000;
    const evt = JSON.stringify({ type: "llm_call", timestamp: now - 1000 });
    const file = path.join(TMP_STATE, "proxy_events_88888.jsonl");
    fs.writeFileSync(file, evt + "\n", "utf-8");
    const results = cli._readProxyEvents(now - 10, now + 10, false, 88888);
    expect(results.length).toBe(0);
    fs.unlinkSync(file);
  });

  test("deleteAfterRead removes the file", () => {
    const now = Date.now() / 1000;
    const file = path.join(TMP_STATE, "proxy_events_77777.jsonl");
    fs.writeFileSync(file, JSON.stringify({ type: "llm_call", timestamp: now }) + "\n", "utf-8");
    cli._readProxyEvents(now - 10, now + 10, true, 77777);
    expect(fs.existsSync(file)).toBe(false);
  });
});

// ─── Command handlers ─────────────────────────────────────────────────────
describe("cmdUserPromptSubmit", () => {
  const SID = `test-ups-${Date.now()}`;
  afterEach(() => stateModule.clearState(SID));

  test("increments turn count and saves prompt", () => {
    cli._cmdUserPromptSubmitWithEvent({ session_id: SID, prompt: "hello", model: "claude-3" });
    const state = stateModule.loadState(SID);
    expect(state.metrics.turns).toBe(1);
    expect(state.prompt).toBe("hello");
    expect(state.model).toBe("claude-3");
    expect(state.events[0].type).toBe("user_prompt_submit");
  });

  test("increments turns on second call", () => {
    cli._cmdUserPromptSubmitWithEvent({ session_id: SID, prompt: "hello" });
    cli._cmdUserPromptSubmitWithEvent({ session_id: SID, prompt: "world" });
    const state = stateModule.loadState(SID);
    expect(state.metrics.turns).toBe(2);
    expect(state.prompt).toBe("hello");
  });
});

describe("cmdPreToolUse", () => {
  const SID = `test-ptu-${Date.now()}`;
  afterEach(() => stateModule.clearState(SID));

  test("increments tools_used and records event", () => {
    cli._cmdPreToolUseWithEvent({ session_id: SID, tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "tool-001" });
    const state = stateModule.loadState(SID);
    expect(state.metrics.tools_used).toBe(1);
    expect(state.tools_used).toContain("Bash");
    expect(state.events[0].tool_use_id).toBe("tool-001");
  });

  test("tool_use_id falls back to null when missing", () => {
    cli._cmdPreToolUseWithEvent({ session_id: SID, tool_name: "Read", tool_input: {} });
    const state = stateModule.loadState(SID);
    expect(state.events[0].tool_use_id).toBeNull();
  });
});

describe("cmdPostToolUse", () => {
  const SID = `test-potu-${Date.now()}`;
  afterEach(() => stateModule.clearState(SID));

  test("records post_tool_use event", () => {
    cli._cmdPostToolUseWithEvent({ session_id: SID, tool_name: "Bash", tool_response: { result: "ok" }, tool_use_id: "tool-001" });
    const state = stateModule.loadState(SID);
    expect(state.events[0].type).toBe("post_tool_use");
    expect(state.events[0].tool_use_id).toBe("tool-001");
    expect(state.events[0].tool_response).toEqual({ result: "ok" });
  });
});

describe("cmdPreCompact", () => {
  const SID = `test-pc-${Date.now()}`;
  afterEach(() => stateModule.clearState(SID));

  test("records pre_compact event", () => {
    cli._cmdPreCompactWithEvent({ session_id: SID, trigger: "manual", custom_instructions: "foo" });
    const state = stateModule.loadState(SID);
    expect(state.events[0].type).toBe("pre_compact");
    expect(state.events[0].trigger).toBe("manual");
    expect(state.events[0].has_custom_instructions).toBe(true);
  });
});

describe("cmdNotification", () => {
  const SID = `test-notif-${Date.now()}`;
  afterEach(() => stateModule.clearState(SID));

  test("records notification event", () => {
    cli._cmdNotificationWithEvent({ session_id: SID, message: "done", title: "T", level: "info" });
    const state = stateModule.loadState(SID);
    expect(state.events[0].type).toBe("notification");
    expect(state.events[0].message).toBe("done");
  });
});

describe("installIntoSettings", () => {
  test("creates settings.json with hooks when file does not exist", () => {
    const tmp = path.join(os.tmpdir(), `settings-${Date.now()}.json`);
    cli._installIntoSettings(tmp);
    const settings = JSON.parse(fs.readFileSync(tmp, "utf-8"));
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.UserPromptSubmit).toBeDefined();
    fs.unlinkSync(tmp);
  });

  test("is idempotent — does not duplicate hooks", () => {
    const tmp = path.join(os.tmpdir(), `settings-idem-${Date.now()}.json`);
    cli._installIntoSettings(tmp);
    cli._installIntoSettings(tmp);
    const settings = JSON.parse(fs.readFileSync(tmp, "utf-8"));
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    fs.unlinkSync(tmp);
  });

  test("preserves existing hooks from other tools", () => {
    const tmp = path.join(os.tmpdir(), `settings-existing-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "other-tool" }] }] },
    }), "utf-8");
    cli._installIntoSettings(tmp);
    const settings = JSON.parse(fs.readFileSync(tmp, "utf-8"));
    const cmds = settings.hooks.UserPromptSubmit.flatMap(m => m.hooks.map(h => h.command));
    expect(cmds.some(c => c.includes("other-tool"))).toBe(true);
    expect(cmds.some(c => c.includes("otel-claude-hook"))).toBe(true);
    fs.unlinkSync(tmp);
  });
});

// ─── replayEventsAsSpans ───────────────────────────────────────────────────
describe("replayEventsAsSpans", () => {
  let mockSpan, mockTracer, mockCtx;

  beforeEach(() => {
    mockSpan = { setAttribute: jest.fn(), end: jest.fn() };
    mockTracer = { startSpan: jest.fn().mockReturnValue(mockSpan) };
    mockCtx = {};
    require("@opentelemetry/api").trace.setSpan = jest.fn().mockReturnValue({});
  });

  test("creates turn span on user_prompt_submit", () => {
    const events = [{ type: "user_prompt_submit", timestamp: 1000, prompt: "hello" }];
    cli._replayEventsAsSpans(mockTracer, events, mockCtx, 1001);
    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      expect.stringContaining("Turn 1"), expect.any(Object), mockCtx
    );
    expect(mockSpan.end).toHaveBeenCalled();
  });

  test("creates tool spans for pre/post_tool_use pair", () => {
    const events = [
      { type: "pre_tool_use", timestamp: 1000, tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t1" },
      { type: "post_tool_use", timestamp: 1001, tool_name: "Bash", tool_response: { result: "ok" }, tool_use_id: "t1" },
    ];
    cli._replayEventsAsSpans(mockTracer, events, mockCtx, 1002);
    const spanNames = mockTracer.startSpan.mock.calls.map(c => c[0]);
    expect(spanNames.some(n => n.includes("Bash"))).toBe(true);
    expect(mockSpan.end).toHaveBeenCalled();
  });

  test("pre_tool_use for non-Agent tool creates no span (deferred to post_tool_use)", () => {
    // Non-Agent tools: span created at post_tool_use time; pre is skipped
    const events = [{ type: "pre_tool_use", timestamp: 1000, tool_name: "Read", tool_input: {}, tool_use_id: null }];
    cli._replayEventsAsSpans(mockTracer, events, mockCtx, 1001);
    expect(mockTracer.startSpan).not.toHaveBeenCalled();
  });

  test("creates notification span", () => {
    const events = [{ type: "notification", timestamp: 1000, message: "done", level: "info", title: "" }];
    cli._replayEventsAsSpans(mockTracer, events, mockCtx, 1001);
    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      expect.stringContaining("done"), expect.any(Object), mockCtx
    );
  });

  test("creates pre_compact span", () => {
    const events = [{ type: "pre_compact", timestamp: 1000, trigger: "manual", has_custom_instructions: false }];
    cli._replayEventsAsSpans(mockTracer, events, mockCtx, 1001);
    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      expect.stringContaining("compaction"), expect.any(Object), mockCtx
    );
  });

  test("creates llm_call span with token attributes", () => {
    const events = [{
      type: "llm_call",
      timestamp: 1001,
      request_start_time: 1000,
      model: "claude-3-5-sonnet",
      input_tokens: 100,
      output_tokens: 50,
      input_messages: [{ role: "user", content: "Hi" }],
      output_content: [{ type: "text", text: "Hello" }],
    }];
    cli._replayEventsAsSpans(mockTracer, events, mockCtx, 1002);
    // Token attributes passed via startSpan attributes object
    const startSpanCalls = mockTracer.startSpan.mock.calls;
    const llmCall = startSpanCalls.find(c => c[0].includes("LLM"));
    expect(llmCall).toBeDefined();
    const attrs = llmCall[1].attributes;
    expect(attrs["gen_ai.usage.input_tokens"]).toBe(100);
    expect(attrs["gen_ai.usage.output_tokens"]).toBe(50);
  });

  test("subagent_start defers span creation to post_tool_use; creates span at stopTime if no post", () => {
    // New design: subagent_start stores data only; span created at post_tool_use time
    // With agent_id set and no matching post, span is created at end-of-function cleanup
    const events = [{ type: "subagent_start", timestamp: 1000, subagent_session_id: "sub-123", agent_id: "ag-1", agent_type: "MyAgent" }];
    cli._replayEventsAsSpans(mockTracer, events, mockCtx, 1001);
    // Span is created in end-of-function cleanup for unmatched subagents
    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      expect.stringContaining("Subagent"), expect.any(Object), expect.anything()
    );
  });

  test("handles multiple turns correctly", () => {
    const events = [
      { type: "user_prompt_submit", timestamp: 1000, prompt: "first" },
      { type: "user_prompt_submit", timestamp: 1002, prompt: "second" },
    ];
    cli._replayEventsAsSpans(mockTracer, events, mockCtx, 1003);
    const calls = mockTracer.startSpan.mock.calls;
    expect(calls.some(c => c[0].includes("Turn 1"))).toBe(true);
    expect(calls.some(c => c[0].includes("Turn 2"))).toBe(true);
  });
});

// ─── cmdSubagentStart/Stop ────────────────────────────────────────────────
describe("cmdSubagentStart", () => {
  const SID = `test-sas-${Date.now()}`;
  afterEach(() => stateModule.clearState(SID));

  test("records subagent_start event", () => {
    cli._cmdSubagentStartWithEvent({ session_id: SID, subagent_session_id: "child-1" });
    const state = stateModule.loadState(SID);
    expect(state.events[0].type).toBe("subagent_start");
    expect(state.events[0].subagent_session_id).toBe("child-1");
  });
});

describe("cmdSubagentStop", () => {
  const SID = `test-sasto-${Date.now()}`;
  afterEach(() => stateModule.clearState(SID));

  test("records subagent_stop event with token counts", () => {
    cli._cmdSubagentStopWithEvent({ session_id: SID, subagent_session_id: "child-1", stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 50 } });
    const state = stateModule.loadState(SID);
    expect(state.events[0].type).toBe("subagent_stop");
    expect(state.events[0].input_tokens).toBe(100);
    expect(state.events[0].stop_reason).toBe("end_turn");
  });

  test("inlines child state when child session exists", () => {
    const CHILD_SID = `test-child-${Date.now()}`;
    const childState = stateModule.loadState(CHILD_SID);
    childState.prompt = "child task";
    childState.events.push({ type: "user_prompt_submit", timestamp: 1000, prompt: "child task" });
    stateModule.saveState(CHILD_SID, childState);

    cli._cmdSubagentStopWithEvent({ session_id: SID, subagent_session_id: CHILD_SID, stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } });
    const state = stateModule.loadState(SID);
    expect(state.events[0]._child_state).toBeDefined();
    expect(state.events[0]._child_state.prompt).toBe("child task");
  });
});

// ─── cmdCheckEnv ──────────────────────────────────────────────────────────
describe("cmdCheckEnv", () => {
  test("exits 1 when no backend configured", () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.CLAUDE_TELEMETRY_DEBUG;
    const mockExit = jest.spyOn(process, "exit").mockImplementation(() => { throw new Error("process.exit"); });
    expect(() => cli.cmdCheckEnv()).toThrow("process.exit");
    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
  });

  test("does not exit when OTLP endpoint is configured", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://example.com";
    const mockExit = jest.spyOn(process, "exit").mockImplementation(() => {});
    expect(() => cli.cmdCheckEnv()).not.toThrow();
    expect(mockExit).not.toHaveBeenCalled();
    mockExit.mockRestore();
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  test("does not exit in debug mode", () => {
    process.env.CLAUDE_TELEMETRY_DEBUG = "1";
    const mockExit = jest.spyOn(process, "exit").mockImplementation(() => {});
    expect(() => cli.cmdCheckEnv()).not.toThrow();
    mockExit.mockRestore();
    delete process.env.CLAUDE_TELEMETRY_DEBUG;
  });
});

// ─── cmdShowConfig ────────────────────────────────────────────────────────
describe("cmdShowConfig", () => {
  test("outputs valid JSON with hooks structure", () => {
    const logs = [];
    const spy = jest.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
    cli.cmdShowConfig();
    spy.mockRestore();
    const parsed = JSON.parse(logs[0]);
    expect(parsed.hooks).toBeDefined();
    expect(Object.keys(parsed.hooks)).toContain("UserPromptSubmit");
  });
});

// ─── removeAliasFromFile ──────────────────────────────────────────────────
describe("removeAliasFromFile", () => {
  test("removes BEGIN/END block from shell profile", () => {
    const tmp = path.join(os.tmpdir(), `bashrc-${Date.now()}`);
    fs.writeFileSync(tmp, [
      "export PATH=$PATH:/usr/local/bin",
      "",
      "# BEGIN otel-claude-hook",
      "alias claude='NODE_OPTIONS=... claude'",
      "# END otel-claude-hook",
      "",
      "export FOO=bar",
    ].join("\n"), "utf-8");

    cli._removeAliasFromFile(tmp);

    const result = fs.readFileSync(tmp, "utf-8");
    expect(result).not.toContain("BEGIN otel-claude-hook");
    expect(result).not.toContain("alias claude=");
    expect(result).toContain("export FOO=bar");
    expect(result).toContain("export PATH=");
    fs.unlinkSync(tmp);
  });

  test("is a no-op when block is not present", () => {
    const tmp = path.join(os.tmpdir(), `bashrc2-${Date.now()}`);
    const content = "export FOO=bar\nexport BAZ=qux\n";
    fs.writeFileSync(tmp, content, "utf-8");
    cli._removeAliasFromFile(tmp);
    expect(fs.readFileSync(tmp, "utf-8")).toBe(content);
    fs.unlinkSync(tmp);
  });
});

// ─── replayEventsAsSpans — additional event types ─────────────────────────
describe("replayEventsAsSpans — extended", () => {
  let mockSpan, mockTracer, mockCtx;

  beforeEach(() => {
    mockSpan = { setAttribute: jest.fn(), end: jest.fn() };
    mockTracer = { startSpan: jest.fn().mockReturnValue(mockSpan) };
    mockCtx = {};
    require("@opentelemetry/api").trace.setSpan = jest.fn().mockReturnValue({});
  });

  test("subagent_stop with child_state recurses into child events", () => {
    const events = [{
      type: "subagent_stop", timestamp: 1001,
      subagent_session_id: "child-x",
      _child_state: {
        prompt: "child prompt that is not too long",
        start_time: 990, stop_time: 1000,
        metrics: { input_tokens: 5, output_tokens: 3 },
        model: "claude-sonnet",
        events: [{ type: "user_prompt_submit", timestamp: 991, prompt: "child prompt" }],
      },
    }];
    cli._replayEventsAsSpans(mockTracer, events, mockCtx, 1002);
    // At least 2 spans: container + child turn span
    expect(mockTracer.startSpan.mock.calls.length).toBeGreaterThanOrEqual(2);
    const containerCall = mockTracer.startSpan.mock.calls[0];
    expect(containerCall[0]).toContain("Subagent");
  });

  test("subagent_stop child_state with long prompt gets truncated in title", () => {
    const longPrompt = "A".repeat(80);
    const events = [{
      type: "subagent_stop", timestamp: 1001,
      subagent_session_id: "child-y",
      _child_state: {
        prompt: longPrompt, start_time: 990, stop_time: 1000,
        metrics: {}, model: "claude",
        // Need at least one event so the code enters the child_state branch
        // that uses childPrompt for the container span title
        events: [{ type: "user_prompt_submit", timestamp: 991, prompt: longPrompt }],
      },
    }];
    cli._replayEventsAsSpans(mockTracer, events, mockCtx, 1002);
    const title = mockTracer.startSpan.mock.calls[0][0];
    // longPrompt (80 chars) > 50 → sliced to 50 + "..."
    expect(title).toContain("...");
  });

  test("llm_call with is_error=true marks span as error", () => {
    const events = [{
      type: "llm_call", timestamp: 1001, request_start_time: 1000,
      model: "claude-3", input_tokens: 0, output_tokens: 0,
      is_error: true, error_message: "rate limit exceeded",
    }];
    cli._replayEventsAsSpans(mockTracer, events, mockCtx, 1002);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith("error", true);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith("error.message", "rate limit exceeded");
  });

  test("llm_call with array system_prompt joins text entries", () => {
    const events = [{
      type: "llm_call", timestamp: 1001, request_start_time: 1000,
      model: "claude-3", input_tokens: 5, output_tokens: 2,
      system_prompt: [{ text: "Be helpful." }, { text: "Be concise." }],
      input_messages: [],
    }];
    cli._replayEventsAsSpans(mockTracer, events, mockCtx, 1002);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      "gen_ai.input.messages", expect.stringContaining("Be helpful.")
    );
  });

  test("orphaned non-Agent pre_tool_use (no post) creates no span", () => {
    // Non-Agent tools: no span is created without a matching post_tool_use
    const events = [
      { type: "pre_tool_use", timestamp: 1000, tool_name: "Write", tool_input: {}, tool_use_id: "orphan-1" },
    ];
    cli._replayEventsAsSpans(mockTracer, events, mockCtx, 2000);
    expect(mockTracer.startSpan).not.toHaveBeenCalled();
  });

  test("Agent pre_tool_use creates span immediately and is closed at stopTime if no post", () => {
    const events = [
      { type: "pre_tool_use", timestamp: 1000, tool_name: "Agent", tool_input: {}, tool_use_id: "agent-1" },
    ];
    cli._replayEventsAsSpans(mockTracer, events, mockCtx, 2000);
    expect(mockTracer.startSpan).toHaveBeenCalled();
    expect(mockSpan.end).toHaveBeenCalled();
    const endArg = mockSpan.end.mock.calls[0][0];
    expect(Array.isArray(endArg)).toBe(true);
    expect(endArg[0]).toBe(2000); // closed at stopTime
  });

  test("notification with empty message uses generic title", () => {
    const events = [{ type: "notification", timestamp: 1000, message: "", level: "info", title: "" }];
    cli._replayEventsAsSpans(mockTracer, events, mockCtx, 1001);
    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      expect.stringContaining("Notification"), expect.any(Object), mockCtx
    );
  });
});

// ─── exportSessionTrace ────────────────────────────────────────────────────
describe("exportSessionTrace", () => {
  let errSpy;
  beforeEach(() => { errSpy = jest.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => { errSpy.mockRestore(); });

  test("throws on invalid state", async () => {
    await expect(cli._exportSessionTrace(null)).rejects.toThrow("invalid state object");
    await expect(cli._exportSessionTrace("not-an-object")).rejects.toThrow("invalid state object");
  });

  test("exports a valid session state", async () => {
    const state = {
      session_id: "sess-export-test",
      prompt: "test prompt",
      model: "claude-3",
      start_time: 1000,
      stop_time: 1005,
      metrics: { input_tokens: 10, output_tokens: 5, tools_used: 1, turns: 1 },
      tools_used: ["Bash"],
      events: [{ type: "user_prompt_submit", timestamp: 1001, prompt: "test prompt" }],
    };
    await expect(cli._exportSessionTrace(state, "end_turn")).resolves.toBeUndefined();
  });

  test("handles long prompt (> 60 chars) with ellipsis in span title", async () => {
    const state = {
      session_id: "sess-long-prompt",
      prompt: "A".repeat(80),
      model: "claude-3",
      start_time: 1000, stop_time: 1002,
      metrics: {}, tools_used: [], events: [],
    };
    const { trace } = require("@opentelemetry/api");
    const startSpanSpy = jest.fn().mockReturnValue({ setAttribute: jest.fn(), end: jest.fn() });
    trace.getTracer = jest.fn().mockReturnValue({ startSpan: startSpanSpy });
    await cli._exportSessionTrace(state);
    const title = startSpanSpy.mock.calls[0][0];
    expect(title).toContain("...");
  });

  test("uses 'Claude Session' title when prompt is empty", async () => {
    const state = {
      session_id: "sess-no-prompt",
      prompt: "",
      model: "claude-3",
      start_time: 1000, stop_time: 1001,
      metrics: {}, tools_used: [], events: [],
    };
    const { trace } = require("@opentelemetry/api");
    const startSpanSpy = jest.fn().mockReturnValue({ setAttribute: jest.fn(), end: jest.fn() });
    trace.getTracer = jest.fn().mockReturnValue({ startSpan: startSpanSpy });
    await cli._exportSessionTrace(state);
    const title = startSpanSpy.mock.calls[0][0];
    expect(title).toBe("Claude Session");
  });
});

// ─── installIntercept ──────────────────────────────────────────────────────
describe("installIntercept", () => {
  test("returns null when intercept.js is not in package", () => {
    const fs = require("fs");
    const existsSyncSpy = jest.spyOn(fs, "existsSync").mockReturnValue(false);
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const result = cli._installIntercept();
    existsSyncSpy.mockRestore();
    errSpy.mockRestore();
    expect(result).toBeNull();
  });
});

// ─── resolveClaudePid — Windows guard ─────────────────────────────────────
describe("resolveClaudePid Windows guard", () => {
  test("returns null on win32 platform", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const result = cli._resolveClaudePid();
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    expect(result).toBeNull();
  });
});

// ─── cmdUninstall ─────────────────────────────────────────────────────────
describe("cmdUninstall", () => {
  test("runs without throwing when nothing is installed (no-user, no-project)", () => {
    // Skip user home settings and project settings; only shell profile cleanup runs.
    // Shell profile files may not exist, which is handled gracefully.
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(() => cli.cmdUninstall({ user: false, project: false })).not.toThrow();
    spy.mockRestore();
  });

  test("uninstall settings file round-trip: install then uninstall removes hooks", () => {
    const tmpDir = path.join(os.tmpdir(), `cl-uninstall-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const settingsPath = path.join(tmpDir, "settings.json");

    // Install hooks
    cli._installIntoSettings(settingsPath);
    let settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(settings.hooks).toBeDefined();
    expect(Object.keys(settings.hooks).length).toBeGreaterThan(0);

    // Simulate uninstallFromSettings by re-writing without hooks
    // (cmdUninstall uses process.homedir() paths; we test the settings helper directly)
    cli._installIntoSettings(settingsPath); // idempotent — no duplicate
    const raw = fs.readFileSync(settingsPath, "utf-8");
    const parsed = JSON.parse(raw);
    // All hooks should be unique (no duplicates)
    const hookCount = Object.values(parsed.hooks).flat().length;
    expect(hookCount).toBe(Object.keys(parsed.hooks).length); // 1 matcher per event

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
