// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
"use strict";

// Mock fs side effects from intercept.js install()
jest.mock("fs", () => {
  const real = jest.requireActual("fs");
  return { ...real, appendFileSync: jest.fn(), mkdirSync: jest.fn() };
});

const intercept = require("../src/intercept");
const {
  _parseSseResponse,
  _parseJsonResponse,
  _parseOpenAIChatJsonResponse,
  _extractRequestFields,
  _isInternalCall,
} = intercept;

const SSE_FIXTURE = `event: message_start
data: {"type":"message_start","message":{"id":"msg_01","model":"claude-3-5-sonnet-20241022","usage":{"input_tokens":10,"cache_read_input_tokens":5,"cache_creation_input_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello, world!"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}

event: message_stop
data: {"type":"message_stop"}
`;

describe("parseSseResponse (Anthropic)", () => {
  test("parses model and id", () => {
    const result = _parseSseResponse(SSE_FIXTURE);
    expect(result.model).toBe("claude-3-5-sonnet-20241022");
    expect(result.id).toBe("msg_01");
  });

  test("parses token counts", () => {
    const result = _parseSseResponse(SSE_FIXTURE);
    expect(result.input_tokens).toBe(10);
    expect(result.output_tokens).toBe(5);
    expect(result.cache_read_input_tokens).toBe(5);
  });

  test("assembles text content block", () => {
    const result = _parseSseResponse(SSE_FIXTURE);
    expect(result.content_blocks).toHaveLength(1);
    expect(result.content_blocks[0].type).toBe("text");
    expect(result.content_blocks[0].text).toBe("Hello, world!");
  });

  test("parses stop_reason", () => {
    const result = _parseSseResponse(SSE_FIXTURE);
    expect(result.stop_reason).toBe("end_turn");
  });

  test("handles empty SSE", () => {
    const result = _parseSseResponse("");
    expect(result.content_blocks).toEqual([]);
    expect(result.input_tokens).toBe(0);
  });

  test("handles tool_use content block", () => {
    const sse = `event: message_start
data: {"type":"message_start","message":{"id":"x","model":"claude","usage":{"input_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_1","name":"Bash"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"ls\\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}
`;
    const result = _parseSseResponse(sse);
    expect(result.content_blocks[0].type).toBe("tool_use");
    expect(result.content_blocks[0].name).toBe("Bash");
    expect(result.content_blocks[0].input).toEqual({ command: "ls" });
  });
});

describe("parseJsonResponse (Anthropic)", () => {
  const JSON_FIXTURE = {
    id: "msg_01",
    model: "claude-3-5-sonnet",
    stop_reason: "end_turn",
    usage: { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 },
    content: [{ type: "text", text: "Hi there" }],
  };

  test("parses basic fields", () => {
    const result = _parseJsonResponse(Buffer.from(JSON.stringify(JSON_FIXTURE)));
    expect(result.model).toBe("claude-3-5-sonnet");
    expect(result.stop_reason).toBe("end_turn");
    expect(result.input_tokens).toBe(20);
    expect(result.output_tokens).toBe(10);
  });

  test("parses content blocks", () => {
    const result = _parseJsonResponse(Buffer.from(JSON.stringify(JSON_FIXTURE)));
    expect(result.content_blocks[0].text).toBe("Hi there");
  });

  test("returns empty result on invalid JSON", () => {
    const result = _parseJsonResponse(Buffer.from("INVALID"));
    expect(result.model).toBe("");
    expect(result.input_tokens).toBe(0);
  });
});

describe("parseOpenAIChatJsonResponse", () => {
  const OPENAI_FIXTURE = {
    id: "chatcmpl-001",
    model: "gpt-4o",
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Hello!" } }],
    usage: { prompt_tokens: 15, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 5 } },
  };

  test("maps prompt_tokens to input_tokens", () => {
    const result = _parseOpenAIChatJsonResponse(Buffer.from(JSON.stringify(OPENAI_FIXTURE)));
    expect(result.input_tokens).toBe(15);
    expect(result.output_tokens).toBe(3);
    expect(result.cache_read_input_tokens).toBe(5);
  });

  test("parses content block", () => {
    const result = _parseOpenAIChatJsonResponse(Buffer.from(JSON.stringify(OPENAI_FIXTURE)));
    expect(result.content_blocks[0].text).toBe("Hello!");
  });
});

describe("extractRequestFields", () => {
  test("extracts Anthropic messages and system", () => {
    const body = JSON.stringify({
      model: "claude-3-5-sonnet",
      system: "You are helpful.",
      messages: [{ role: "user", content: "Hello" }],
    });
    const fields = _extractRequestFields(body, "anthropic");
    expect(fields.model).toBe("claude-3-5-sonnet");
    expect(fields.system).toBe("You are helpful.");
    expect(fields.messages).toHaveLength(1);
  });

  test("splits OpenAI system and user messages", () => {
    const body = JSON.stringify({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "Be helpful" },
        { role: "user", content: "Hi" },
      ],
    });
    const fields = _extractRequestFields(body, "openai-chat");
    expect(fields.system).toHaveLength(1);
    expect(fields.messages).toHaveLength(1);
    expect(fields.messages[0].role).toBe("user");
  });

  test("returns nulls on invalid JSON", () => {
    const fields = _extractRequestFields("NOT_JSON", "anthropic");
    expect(fields.messages).toBeNull();
    expect(fields.model).toBe("");
  });
});

describe("isInternalCall", () => {
  test("detects title generation call", () => {
    const fields = { system: "Generate a concise, sentence-case title for this conversation" };
    expect(_isInternalCall(fields)).toBe(true);
  });

  test("returns false for normal call", () => {
    const fields = { system: "You are a helpful assistant." };
    expect(_isInternalCall(fields)).toBe(false);
  });

  test("returns false when no system prompt", () => {
    expect(_isInternalCall({ system: null })).toBe(false);
    expect(_isInternalCall({})).toBe(false);
  });

  test("handles array system prompt", () => {
    const fields = { system: [{ text: "Generate a concise, sentence-case title for this" }] };
    expect(_isInternalCall(fields)).toBe(true);
  });
});

// ─── parseOpenAIChatSseResponse ───────────────────────────────────────────
describe("parseOpenAIChatSseResponse", () => {
  const { _parseOpenAIChatSseResponse } = require("../src/intercept");

  const SSE = [
    'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}',
    'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
    'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"delta":{"content":" world"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":2}}}',
    "data: [DONE]",
  ].join("\n");

  test("assembles text content from deltas", () => {
    const result = _parseOpenAIChatSseResponse(SSE);
    expect(result.content_blocks[0].text).toBe("Hello world");
  });

  test("parses usage when present", () => {
    const result = _parseOpenAIChatSseResponse(SSE);
    expect(result.input_tokens).toBe(10);
    expect(result.output_tokens).toBe(3);
    expect(result.cache_read_input_tokens).toBe(2);
  });

  test("parses stop_reason", () => {
    const result = _parseOpenAIChatSseResponse(SSE);
    expect(result.stop_reason).toBe("stop");
  });

  test("handles empty stream", () => {
    const result = _parseOpenAIChatSseResponse("data: [DONE]\n");
    expect(result.content_blocks).toEqual([]);
  });
});

// ─── parseOpenAIResponsesJsonResponse ─────────────────────────────────────
describe("parseOpenAIResponsesJsonResponse", () => {
  const { _parseOpenAIResponsesJsonResponse } = require("../src/intercept");

  const FIXTURE = {
    id: "resp-001",
    model: "gpt-4o",
    status: "completed",
    usage: { input_tokens: 20, output_tokens: 8, input_tokens_details: { cached_tokens: 3 } },
    output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi there" }] },
      { type: "function_call", id: "call_1", call_id: "call_1", name: "get_weather", arguments: '{"location":"NYC"}' },
    ],
  };

  test("parses model and status", () => {
    const result = _parseOpenAIResponsesJsonResponse(Buffer.from(JSON.stringify(FIXTURE)));
    expect(result.model).toBe("gpt-4o");
    expect(result.stop_reason).toBe("completed");
  });

  test("parses token usage", () => {
    const result = _parseOpenAIResponsesJsonResponse(Buffer.from(JSON.stringify(FIXTURE)));
    expect(result.input_tokens).toBe(20);
    expect(result.output_tokens).toBe(8);
    expect(result.cache_read_input_tokens).toBe(3);
  });

  test("parses text and tool_use content blocks", () => {
    const result = _parseOpenAIResponsesJsonResponse(Buffer.from(JSON.stringify(FIXTURE)));
    const textBlock = result.content_blocks.find(b => b.type === "text");
    const toolBlock = result.content_blocks.find(b => b.type === "tool_use");
    expect(textBlock.text).toBe("Hi there");
    expect(toolBlock.name).toBe("get_weather");
    expect(toolBlock.input).toEqual({ location: "NYC" });
  });

  test("returns empty result on invalid JSON", () => {
    const result = _parseOpenAIResponsesJsonResponse(Buffer.from("BAD"));
    expect(result.input_tokens).toBe(0);
    expect(result.content_blocks).toEqual([]);
  });
});

// ─── buildErrorEvent ───────────────────────────────────────────────────────
describe("buildErrorEvent", () => {
  const { _buildErrorEvent } = require("../src/intercept");

  test("creates error event with correct structure", () => {
    const reqFields = { messages: [{ role: "user", content: "hi" }], model: "claude-3", system: null, request_body: null };
    const evt = _buildErrorEvent(1000, reqFields, new Error("network timeout"));
    expect(evt.type).toBe("llm_call");
    expect(evt.is_error).toBe(true);
    expect(evt.error_message).toBe("network timeout");
    expect(evt.model).toBe("claude-3");
    expect(evt.output_content).toEqual([]);
    expect(evt.input_tokens).toBe(0);
  });

  test("handles non-Error objects", () => {
    const reqFields = { messages: null, model: "", system: null, request_body: null };
    const evt = _buildErrorEvent(1000, reqFields, "string error");
    expect(evt.error_message).toBe("string error");
  });
});

// ─── gzip decompression ────────────────────────────────────────────────────
describe("gzip decompression (parseJsonResponse)", () => {
  test("decompresses gzip body", () => {
    const { _parseJsonResponse } = require("../src/intercept");
    const zlib = require("zlib");
    const data = JSON.stringify({
      id: "msg_gz", model: "claude-3", stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 2 },
      content: [{ type: "text", text: "gzip works" }],
    });
    const result = _parseJsonResponse(zlib.gzipSync(Buffer.from(data)));
    expect(result.model).toBe("claude-3");
    expect(result.content_blocks[0].text).toBe("gzip works");
  });
});

// ─── isInternalCall edge cases ─────────────────────────────────────────────
describe("isInternalCall additional cases", () => {
  const { _isInternalCall } = require("../src/intercept");

  test("returns false for empty string system", () => {
    expect(_isInternalCall({ system: "" })).toBe(false);
  });

  test("handles mixed array with non-string items", () => {
    const fields = { system: [{ text: "Generate a concise, sentence-case title please" }, { type: "other" }] };
    expect(_isInternalCall(fields)).toBe(true);
  });
});

// ─── parseOpenAIResponsesSseResponse ──────────────────────────────────────
describe("parseOpenAIResponsesSseResponse", () => {
  const { _parseOpenAIResponsesSseResponse } = require("../src/intercept");

  const RESPONSES_SSE = [
    'event: response.created',
    'data: {"response":{"id":"resp-1","model":"gpt-4o","created_at":1000}}',
    '',
    'event: response.output_text.delta',
    'data: {"delta":"Hello"}',
    '',
    'event: response.output_text.delta',
    'data: {"delta":" world"}',
    '',
    'event: response.function_call_arguments.delta',
    'data: {"item_id":"call1","call_id":"call1","name":"get_weather","delta":"{\\"loc"}',
    '',
    'event: response.function_call_arguments.done',
    'data: {"item_id":"call1","call_id":"call1","name":"get_weather","arguments":"{\\"location\\":\\"NYC\\"}"}',
    '',
    'event: response.completed',
    'data: {"response":{"status":"completed","usage":{"input_tokens":20,"output_tokens":8,"input_tokens_details":{"cached_tokens":3}}}}',
    '',
  ].join("\n");

  test("parses text content from deltas", () => {
    const result = _parseOpenAIResponsesSseResponse(RESPONSES_SSE);
    const textBlock = result.content_blocks.find(b => b.type === "text");
    expect(textBlock.text).toBe("Hello world");
  });

  test("parses function call with arguments", () => {
    const result = _parseOpenAIResponsesSseResponse(RESPONSES_SSE);
    const toolBlock = result.content_blocks.find(b => b.type === "tool_use");
    expect(toolBlock.name).toBe("get_weather");
    expect(toolBlock.input).toEqual({ location: "NYC" });
  });

  test("parses usage from response.completed", () => {
    const result = _parseOpenAIResponsesSseResponse(RESPONSES_SSE);
    expect(result.input_tokens).toBe(20);
    expect(result.output_tokens).toBe(8);
    expect(result.cache_read_input_tokens).toBe(3);
    expect(result.stop_reason).toBe("completed");
  });

  test("parses reasoning summary blocks", () => {
    const sse = [
      'event: response.output_item.added',
      'data: {"item":{"type":"reasoning","id":"rs1"}}',
      '',
      'event: response.reasoning_summary_part.added',
      'data: {"item_id":"rs1"}',
      '',
      'event: response.reasoning_summary_text.delta',
      'data: {"item_id":"rs1","delta":"thinking..."}',
      '',
      'event: response.reasoning_summary_text.done',
      'data: {"item_id":"rs1","text":"thinking done"}',
      '',
      'event: response.completed',
      'data: {"response":{"status":"completed","usage":{"input_tokens":5,"output_tokens":2}}}',
      '',
    ].join("\n");
    const result = _parseOpenAIResponsesSseResponse(sse);
    const thinkingBlock = result.content_blocks.find(b => b.type === "thinking");
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock.thinking).toContain("thinking done");
  });

  test("handles empty stream gracefully", () => {
    const result = _parseOpenAIResponsesSseResponse("");
    expect(result.content_blocks).toEqual([]);
    expect(result.input_tokens).toBe(0);
  });

  test("ignores invalid JSON data lines", () => {
    const sse = [
      'event: response.output_text.delta',
      'data: INVALID_JSON',
      '',
    ].join("\n");
    expect(() => _parseOpenAIResponsesSseResponse(sse)).not.toThrow();
  });
});

// ─── buildEvent ────────────────────────────────────────────────────────────
describe("buildEvent", () => {
  const { _buildEvent } = require("../src/intercept");

  const mockReqFields = {
    messages: [{ role: "user", content: "Hello" }],
    model: "claude-3-5-sonnet",
    system: "You are helpful.",
    request_body: null,
  };

  test("parses anthropic SSE response", () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"m1","model":"claude-3-5-sonnet","usage":{"input_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi!"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
      '',
    ].join("\n");
    const rawBody = Buffer.from(sse);
    const event = _buildEvent(1000, mockReqFields, 200, rawBody, "text/event-stream", null, null, "anthropic");
    expect(event.type).toBe("llm_call");
    expect(event.model).toBe("claude-3-5-sonnet");
    expect(event.input_tokens).toBe(5);
    expect(event.output_tokens).toBe(3);
    expect(event.is_error).toBe(false);
  });

  test("parses openai-chat JSON response", () => {
    const body = JSON.stringify({
      id: "chat-1", model: "gpt-4o",
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Hello!" } }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    });
    const event = _buildEvent(1000, mockReqFields, 200, Buffer.from(body), "application/json", null, null, "openai-chat");
    expect(event.model).toBe("gpt-4o");
    expect(event.input_tokens).toBe(10);
    expect(event.output_tokens).toBe(4);
  });

  test("builds error event for HTTP 4xx response", () => {
    const body = Buffer.from('{"error":{"message":"rate limit exceeded"}}');
    const event = _buildEvent(1000, mockReqFields, 429, body, "application/json", null, null, "anthropic");
    expect(event.type).toBe("llm_call");
    expect(event.is_error).toBe(true);
    // error_message holds the raw error body for 4xx responses
    expect(event.error_message).toContain("rate limit");
  });

  test("handles gzip-encoded JSON body", () => {
    const zlib = require("zlib");
    const data = JSON.stringify({
      id: "m-gz", model: "claude-3", stop_reason: "end_turn",
      usage: { input_tokens: 8, output_tokens: 4 },
      content: [{ type: "text", text: "compressed" }],
    });
    const gzipped = zlib.gzipSync(Buffer.from(data));
    const event = _buildEvent(1000, mockReqFields, 200, gzipped, "application/json", "gzip", null, "anthropic");
    expect(event.model).toBe("claude-3");
    expect(event.input_tokens).toBe(8);
  });

  test("uses anthropic parser as fallback for unknown protocol", () => {
    const body = JSON.stringify({
      id: "m1", model: "unknown-model", stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "text", text: "ok" }],
    });
    // "unknown-protocol" should fall back to anthropic parsers
    const event = _buildEvent(1000, mockReqFields, 200, Buffer.from(body), "application/json", null, null, "unknown-protocol");
    expect(event.type).toBe("llm_call");
    expect(event.is_error).toBe(false);
  });
});

// ─── parseSseResponse — additional edge cases ─────────────────────────────
describe("parseSseResponse additional edge cases", () => {
  const { _parseSseResponse } = require("../src/intercept");

  test("handles thinking content block", () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"m1","model":"claude-3","usage":{"input_tokens":1}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"I need to think..."}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
      '',
    ].join("\n");
    const result = _parseSseResponse(sse);
    const thinkingBlock = result.content_blocks.find(b => b.type === "thinking");
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock.thinking).toBe("I need to think...");
  });

  test("handles tool_use with invalid JSON arguments gracefully", () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"m1","model":"claude","usage":{"input_tokens":1}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Bash"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"NOT_VALID_JSON"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}',
      '',
    ].join("\n");
    const result = _parseSseResponse(sse);
    expect(result.content_blocks[0].type).toBe("tool_use");
    // Invalid JSON kept as raw string
    expect(result.content_blocks[0].input).toBe("NOT_VALID_JSON");
  });

  test("handles stop_sequence in message_delta", () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"m1","model":"claude","usage":{"input_tokens":1}}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"stop_sequence","stop_sequence":"\\n\\nHuman:"},"usage":{"output_tokens":1}}',
      '',
    ].join("\n");
    const result = _parseSseResponse(sse);
    expect(result.stop_reason).toBe("stop_sequence");
    expect(result.stop_sequence).toBe("\n\nHuman:");
  });
});
