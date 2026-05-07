#!/usr/bin/env node
// WebSocket trace propagation test script
// Tests: traceparent + custom attributes via <!--otel:{JSON}--> in message content

import { createRequire } from "node:module";
import crypto from "node:crypto";

const _require = createRequire("/opt/homebrew/lib/node_modules/openclaw/");
const { WebSocket } = _require("ws");

// ── Config ──
const GW_PORT = 18789;
const GW_TOKEN = "wf3667606";
const WS_URL = `ws://127.0.0.1:${GW_PORT}`;

// ── Test trace context ──
const TEST_TRACE_ID = "abcdef1234567890abcdef1234567890";
const TEST_SPAN_ID = "1234567890abcdef";
const TEST_TRACEPARENT = `00-${TEST_TRACE_ID}-${TEST_SPAN_ID}-01`;

// ── Helpers ──
let reqId = 0;
const nextId = () => String(++reqId);

function sendReq(ws, method, params) {
  const id = nextId();
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  console.log(`  → [${method}] id=${id}`);
  return id;
}

function waitForRes(ws, expectedId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout id=${expectedId}`)), timeoutMs);
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "res" && msg.id === expectedId) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });
}

function waitForChatFinal(ws, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const events = [];
    const timer = setTimeout(() => { ws.off("message", handler); resolve(events); }, timeoutMs);
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "event" && msg.event === "chat") {
        events.push(msg.payload);
        const state = msg.payload?.state;
        if (state === "final" || state === "error" || state === "aborted") {
          clearTimeout(timer);
          ws.off("message", handler);
          resolve(events);
        }
      }
    };
    ws.on("message", handler);
  });
}

// ── Main ──
async function main() {
  console.log("=== WebSocket Trace Propagation Test ===\n");

  // 1. Connect
  console.log(`[1] Connecting to ${WS_URL} ...`);
  const ws = new WebSocket(WS_URL, {
    headers: { Origin: `http://127.0.0.1:${GW_PORT}` },
  });
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  console.log("    Connected.\n");

  // 2. Handshake
  console.log("[2] Handshake ...");
  const connectId = sendReq(ws, "connect", {
    minProtocol: 3, maxProtocol: 3,
    client: { id: "openclaw-control-ui", displayName: "WS Trace Test", version: "control-ui", platform: "darwin", mode: "webchat" },
    role: "operator",
    scopes: ["operator.read", "operator.write"],
    auth: { token: GW_TOKEN },
  });
  const connectRes = await waitForRes(ws, connectId);
  if (!connectRes.ok) {
    console.error("    FAILED:", JSON.stringify(connectRes.error, null, 2));
    ws.close(); process.exit(1);
  }
  console.log("    OK.\n");

  // 3. Send chat.send with otel payload
  const sessionKey = `ws-trace-test-${Date.now()}`;
  const userMessage = "你好，请简短回复一句话即可。";
  const otelPayload = {
    tp: TEST_TRACEPARENT,
    attr: {
      "user.id": "test-user-001",
      "biz.order_id": "ORD-20260428-001",
      "env": "local-test",
      "priority": 1,
      "debug": true,
    },
  };
  const messageWithOtel = `${userMessage}\n<!--otel:${JSON.stringify(otelPayload)}-->`;

  console.log("[3] Sending chat.send with otel payload ...");
  console.log(`    traceparent:  ${TEST_TRACEPARENT}`);
  console.log(`    custom attrs: ${JSON.stringify(otelPayload.attr)}`);
  console.log(`    sessionKey:   ${sessionKey}\n`);

  // Start event listener before sending
  const chatEventsPromise = waitForChatFinal(ws, 120000);

  const chatId = sendReq(ws, "chat.send", {
    sessionKey,
    message: messageWithOtel,
    idempotencyKey: crypto.randomUUID(),
  });

  const chatRes = await waitForRes(ws, chatId, 120000);
  if (!chatRes.ok) {
    console.error("    chat.send FAILED:", JSON.stringify(chatRes.error, null, 2));
    ws.close(); process.exit(1);
  }
  console.log("    chat.send accepted, waiting for LLM ...\n");

  const chatEvents = await chatEventsPromise;
  const finalEvent = chatEvents.find((e) => e.state === "final");
  const errorEvent = chatEvents.find((e) => e.state === "error");

  console.log("[4] Results:");
  console.log(`    Events: ${chatEvents.length}`);
  if (finalEvent) {
    const text = finalEvent.message?.content?.[0]?.text ?? JSON.stringify(finalEvent.message);
    console.log(`    LLM reply: ${String(text).slice(0, 200)}`);
  }
  if (errorEvent) {
    console.error(`    Error: ${errorEvent.errorMessage} (${errorEvent.errorKind})`);
  }

  console.log("\n[5] Check ARMS console:");
  console.log(`    traceId:  ${TEST_TRACE_ID}`);
  console.log(`    parentId: ${TEST_SPAN_ID}`);
  console.log(`    Custom span attributes:`);
  console.log(`      user.id       = "test-user-001"`);
  console.log(`      biz.order_id  = "ORD-20260428-001"`);
  console.log(`      env           = "local-test"`);
  console.log(`      priority      = 1`);
  console.log(`      debug         = true`);

  ws.close();
  console.log("\n=== Test complete ===");
}

main().catch((err) => { console.error("Test failed:", err); process.exit(1); });
