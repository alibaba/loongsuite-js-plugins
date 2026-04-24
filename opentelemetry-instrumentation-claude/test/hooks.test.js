// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
"use strict";
const { createToolTitle, createEventData, addResponseToEventData, MAX_CONTENT_LENGTH } = require("../src/hooks");

describe("createToolTitle", () => {
  test("returns toolName when no input", () => {
    expect(createToolTitle("Bash")).toBe("Bash");
    expect(createToolTitle("Read", null)).toBe("Read");
    expect(createToolTitle("Write", {})).toBe("Write");
  });

  test("includes string values in title", () => {
    const title = createToolTitle("Read", { file_path: "/tmp/foo.js" });
    expect(title).toContain("Read");
    expect(title).toContain("/tmp/foo.js");
  });

  test("respects maxLength parameter", () => {
    const longInput = { cmd: "a".repeat(200) };
    const title = createToolTitle("Bash", longInput, 20);
    expect(title.length).toBeLessThanOrEqual(20);
  });

  test("truncates long string values using maxLength", () => {
    const input = { key: "x".repeat(MAX_CONTENT_LENGTH + 100) };
    const title = createToolTitle("Tool", input);
    expect(title.length).toBeLessThanOrEqual(MAX_CONTENT_LENGTH + 20);
  });

  test("handles numeric, boolean, null values", () => {
    const title = createToolTitle("Tool", { count: 42, flag: true, empty: null });
    expect(title).toContain("42");
  });

  test("handles array and object values", () => {
    const title = createToolTitle("Tool", { items: [1, 2, 3], meta: { a: 1 } });
    expect(title).toContain("[...3]");
    expect(title).toContain("{...1}");
  });

  test("limits to 3 summary parts", () => {
    const input = { a: "1", b: "2", c: "3", d: "4" };
    const title = createToolTitle("Tool", input);
    const parts = title.split(" - ")[1]?.split(", ") ?? [];
    expect(parts.length).toBeLessThanOrEqual(3);
  });
});

describe("createEventData", () => {
  test("returns base object when no input", () => {
    const data = createEventData("Bash");
    expect(data).toEqual({ "gen_ai.tool.name": "Bash" });
  });

  test("includes input fields as input.* attributes", () => {
    const data = createEventData("Read", { file_path: "/foo.js", limit: 100 });
    expect(data["input.file_path"]).toBe("/foo.js");
    expect(data["input.limit"]).toBe("100");
  });

  test("sets gen_ai.tool.call.arguments summary", () => {
    const data = createEventData("Bash", { command: "ls -la" });
    expect(data["gen_ai.tool.call.arguments"]).toContain("command=ls -la");
  });

  test("truncates oversized string inputs", () => {
    const huge = "x".repeat(MAX_CONTENT_LENGTH + 500);
    const data = createEventData("Write", { content: huge });
    expect(data["input.content"].length).toBeLessThanOrEqual(MAX_CONTENT_LENGTH + 50);
    expect(data["input.content"]).toContain("truncated");
  });
});

describe("addResponseToEventData", () => {
  test("handles null response", () => {
    const data = {};
    addResponseToEventData(data, null);
    expect(data.status).toBe("success");
    expect(data["gen_ai.tool.call.result"]).toBe("null");
  });

  test("handles string response", () => {
    const data = {};
    addResponseToEventData(data, "hello world");
    expect(data.status).toBe("success");
    expect(data["gen_ai.tool.call.result"]).toBe("hello world");
  });

  test("detects error in object response", () => {
    const data = {};
    addResponseToEventData(data, { isError: true, error: "file not found" });
    expect(data.status).toBe("error");
    expect(data["gen_ai.tool.call.result"]).toContain("file not found");
  });

  test("handles success object response", () => {
    const data = {};
    addResponseToEventData(data, { result: "ok", content: "done" });
    expect(data.status).toBe("success");
    expect(data["gen_ai.tool.call.result"]).toContain("result=ok");
  });

  test("handles array response", () => {
    const data = {};
    addResponseToEventData(data, [1, 2, 3]);
    expect(data.status).toBe("success");
    expect(data["gen_ai.tool.call.result"]).toContain("3");
    expect(data["response.count"]).toBe(3);
  });

  test("handles number response", () => {
    const data = {};
    addResponseToEventData(data, 42);
    expect(data.status).toBe("success");
    expect(data["gen_ai.tool.call.result"]).toBe("42");
  });

  test("sets response_type correctly", () => {
    const objData = {};
    addResponseToEventData(objData, { a: 1 });
    expect(objData.response_type).toBe("dict");

    const arrData = {};
    addResponseToEventData(arrData, [1, 2]);
    expect(arrData.response_type).toBe("list");

    const strData = {};
    addResponseToEventData(strData, "text");
    expect(strData.response_type).toBe("string");
  });

  test("extracts text from content block arrays in object response", () => {
    const data = {};
    addResponseToEventData(data, {
      content: [
        { type: "text", text: "Hello" },
        { type: "text", text: " world" },
      ],
      result: [{ type: "tool_use", id: "t1", name: "bash" }],
    });
    expect(data.status).toBe("success");
    // content field: text blocks joined
    expect(data["gen_ai.tool.call.result"]).toContain("Hello world");
    // result field: non-text array → JSON
    expect(data["response.result"]).toContain("tool_use");
  });

  test("serializes nested objects in response fields as JSON", () => {
    const data = {};
    addResponseToEventData(data, {
      meta: { nested: { key: "value" } },
    });
    expect(data["response.meta"]).toContain("nested");
    expect(data["response.meta"]).not.toBe("[object Object]");
  });
});
