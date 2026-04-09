// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
"use strict";
const fs = require("fs");

describe("state", () => {
  let stateModule;

  beforeEach(() => {
    jest.resetModules();
    stateModule = require("../src/state");
  });

  test("loadState returns fresh state for unknown session", () => {
    const state = stateModule.loadState("test-session-nonexistent-" + Date.now());
    expect(state.session_id).toMatch(/test-session-nonexistent/);
    expect(state.events).toEqual([]);
    expect(state.metrics).toMatchObject({ input_tokens: 0, output_tokens: 0 });
  });

  test("saveState and loadState roundtrip", () => {
    const sessionId = "test-roundtrip-" + Date.now();
    const state = stateModule.loadState(sessionId);
    state.prompt = "hello";
    state.events.push({ type: "user_prompt_submit", timestamp: 1234 });
    stateModule.saveState(sessionId, state);

    const loaded = stateModule.loadState(sessionId);
    expect(loaded.prompt).toBe("hello");
    expect(loaded.events).toHaveLength(1);
    expect(loaded.events[0].type).toBe("user_prompt_submit");

    stateModule.clearState(sessionId);
  });

  test("clearState removes file", () => {
    const sessionId = "test-clear-" + Date.now();
    const state = stateModule.loadState(sessionId);
    stateModule.saveState(sessionId, state);

    const filePath = stateModule.stateFile(sessionId);
    expect(fs.existsSync(filePath)).toBe(true);

    stateModule.clearState(sessionId);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  test("readAndDeleteChildState returns null for missing session", () => {
    const result = stateModule.readAndDeleteChildState("nonexistent-" + Date.now());
    expect(result).toBeNull();
  });

  test("readAndDeleteChildState reads and removes file", () => {
    const sessionId = "test-child-" + Date.now();
    const state = stateModule.loadState(sessionId);
    state.prompt = "child task";
    stateModule.saveState(sessionId, state);

    const result = stateModule.readAndDeleteChildState(sessionId);
    expect(result).not.toBeNull();
    expect(result.prompt).toBe("child task");
    expect(fs.existsSync(stateModule.stateFile(sessionId))).toBe(false);
  });

  test("saveState is atomic (no partial file)", () => {
    const sessionId = "test-atomic-" + Date.now();
    const state = stateModule.loadState(sessionId);
    state.events = Array.from({ length: 100 }, (_, i) => ({ type: "evt", i }));
    stateModule.saveState(sessionId, state);

    const filePath = stateModule.stateFile(sessionId);
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.events).toHaveLength(100);

    stateModule.clearState(sessionId);
  });

  test("loadState returns fresh state on corrupted file", () => {
    const sessionId = "test-corrupt-" + Date.now();
    stateModule.saveState(sessionId, stateModule.loadState(sessionId));
    const filePath = stateModule.stateFile(sessionId);
    fs.writeFileSync(filePath, "NOT_JSON{{{", "utf-8");

    const state = stateModule.loadState(sessionId);
    expect(state.events).toEqual([]);

    stateModule.clearState(sessionId);
  });
});
