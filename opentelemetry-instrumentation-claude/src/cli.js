// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

"use strict";

/**
 * cli.js — Hook CLI commands (commander-based).
 * Full port of Python's settings_hooks.py, including _replay_events_as_spans.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { trace, context } = require("@opentelemetry/api");
const { loadState, saveState, clearState, readAndDeleteChildState, STATE_DIR } = require("./state");
const { configureTelemetry, shutdownTelemetry } = require("./telemetry");
const { createToolTitle, createEventData, addResponseToEventData, MAX_CONTENT_LENGTH } = require("./hooks");

// ---------------------------------------------------------------------------
// 语言检测 / Language detection
// ---------------------------------------------------------------------------

/**
 * Lightweight detection using only environment variables.
 * Called at module load for every hook subprocess — must not spawn processes.
 */
function detectLang() {
  const vars = [
    process.env.OTEL_CLAUDE_LANG,
    process.env.LANGUAGE,
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
    process.env.LANG,
  ];
  for (const v of vars) {
    if (v && /zh/i.test(v)) return "zh";
  }
  return "en";
}

/**
 * Full detection for install-time commands (cmdInstall).
 * Runs only once during installation; subprocess latency is acceptable.
 * Falls back to detectLang() if system commands are unavailable.
 */
function detectLangFull() {
  const fast = detectLang();
  if (fast === "zh") return "zh";
  // macOS: check system language preference
  if (process.platform === "darwin") {
    try {
      const { execSync } = require("child_process");
      const langs = execSync("defaults read -g AppleLanguages 2>/dev/null", { encoding: "utf-8", timeout: 2000 });
      if (/zh/i.test(langs)) return "zh";
      const locale = execSync("defaults read -g AppleLocale 2>/dev/null", { encoding: "utf-8", timeout: 2000 }).trim();
      if (/zh/i.test(locale)) return "zh";
    } catch {}
  }
  // Windows: check registry locale
  if (process.platform === "win32") {
    try {
      const { execSync } = require("child_process");
      const locale = execSync(
        'reg query "HKCU\\Control Panel\\International" /v LocaleName',
        { encoding: "utf-8", timeout: 2000, windowsHide: true }
      );
      if (/zh/i.test(locale)) return "zh";
    } catch {}
  }
  return "en";
}
const LANG_MODE = detectLang();

/** Lightweight debug helper — only logs when OTEL_CLAUDE_DEBUG=1 */
function debug(msg) {
  if (process.env.OTEL_CLAUDE_DEBUG) console.error("[otel-claude-hook]", msg);
}

function msg(zh, en) {
  return LANG_MODE === "zh" ? zh : en;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HOOK_CMD_ENV_VAR = "OTEL_CLAUDE_HOOK_CMD";
const HOOK_CMD_DEFAULT = "otel-claude-hook";

function getHookCmd() {
  return process.env[HOOK_CMD_ENV_VAR] || HOOK_CMD_DEFAULT;
}

function buildHookConfig(cmd) {
  const subcommands = [
    ["UserPromptSubmit", "user-prompt-submit"],
    ["PreToolUse", "pre-tool-use"],
    ["PostToolUse", "post-tool-use"],
    ["Stop", "stop"],
    ["PreCompact", "pre-compact"],
    ["SubagentStart", "subagent-start"],
    ["SubagentStop", "subagent-stop"],
    ["Notification", "notification"],
  ];
  const config = {};
  for (const [event, sub] of subcommands) {
    config[event] = [{ hooks: [{ type: "command", command: `${cmd} ${sub}` }] }];
  }
  return config;
}

// ---------------------------------------------------------------------------
// Proxy event reading (intercept.js JSONL logs)
// ---------------------------------------------------------------------------

const PROXY_EVENTS_DIR = STATE_DIR;

/**
 * Resolve the PID of the claude process that launched this hook subprocess.
 *
 * Hook invocation chain (Claude Code uses shell=true):
 *   claude (PID=X)  →  sh (PID=Y)  →  otel-claude-hook (PID=Z)
 *
 * Inside otel-claude-hook: process.ppid = Y (shell), not X (claude).
 * intercept.js runs inside claude, so its process.pid = X.
 * We need X to locate the correct proxy_events_<X>.jsonl file.
 *
 * Strategy:
 *   1. Linux  — read /proc/<shellPid>/status for grandparent PID
 *   2. macOS  — run `ps -o ppid= -p <shellPid>` for grandparent PID
 *   3. Fallback — try process.ppid directly (works if Claude Code uses shell=false)
 *
 * If the resolved file doesn't exist on disk, we fall back to process.ppid
 * (handles the rare shell=false case) or return null (no targeted lookup).
 *
 * @returns {number|null}
 */
function resolveClaudePid() {
  const shellPid = process.ppid;
  if (!shellPid) return null;

  const candidates = [];

  // Windows: process tree walking is not supported.
  // Return null so readProxyEvents() falls back to time-window scan (without
  // deleting files, to avoid cross-session data loss).
  if (process.platform === "win32") {
    debug("resolveClaudePid: Windows not supported, returning null (time-window fallback)");
    return null;
  }

  // Strategy 1 & 2: walk up one level in the process tree to find the
  // grandparent PID (the actual claude process, not the intermediate shell).
  try {
    let grandparentPid = null;
    if (process.platform === "linux") {
      const status = fs.readFileSync(`/proc/${shellPid}/status`, "utf-8");
      const m = status.match(/^PPid:\s+(\d+)/m);
      if (m) grandparentPid = parseInt(m[1], 10);
    } else if (process.platform === "darwin") {
      const { execSync } = require("child_process");
      const out = execSync(`ps -o ppid= -p ${shellPid}`, { encoding: "utf-8", timeout: 2000 }).trim();
      if (/^\d+$/.test(out)) grandparentPid = parseInt(out, 10);
    }
    if (grandparentPid && grandparentPid > 1) candidates.push(grandparentPid);
  } catch (err) {
    debug(`resolveClaudePid: process tree walk failed (${err.message}), falling back to direct ppid`);
  }

  // Strategy 3: direct ppid — handles the rare case where Claude Code
  // invokes hooks without an intermediate shell (shell=false).
  if (shellPid > 1) candidates.push(shellPid);

  // Return the first candidate whose proxy_events file actually exists on disk
  for (const pid of candidates) {
    const candidate = path.join(PROXY_EVENTS_DIR, `proxy_events_${pid}.jsonl`);
    if (fs.existsSync(candidate)) return pid;
  }

  // No matching file found — return best guess (grandparent if available)
  return candidates[0] || null;
}

function readProxyEvents(startTime, stopTime, deleteAfterRead = false, pid = null) {
  if (!fs.existsSync(PROXY_EVENTS_DIR)) return [];

  const bufferedStart = startTime - 5.0;
  const bufferedStop = stopTime + 5.0;
  const events = [];

  // If pid is specified, only read that pid's file (safe for concurrent sessions).
  // If pid is null (platform not supported), fall back to time-window scan WITHOUT
  // deleting — avoids data loss for other concurrent sessions.
  let fileNames = fs.readdirSync(PROXY_EVENTS_DIR)
    .filter((f) => f.startsWith("proxy_events_") && f.endsWith(".jsonl"));
  if (pid !== null) {
    fileNames = fileNames.filter((f) => f === `proxy_events_${pid}.jsonl`);
  } else {
    // Unknown PID: read all but do NOT delete (safe fallback)
    deleteAfterRead = false;
  }
  const files = fileNames.map((f) => path.join(PROXY_EVENTS_DIR, f)).sort();

  for (const logFile of files) {
    try {
      const lines = fs.readFileSync(logFile, "utf-8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const evt = JSON.parse(trimmed);
          const ts = parseFloat(evt.timestamp);
          if (!isNaN(ts) && ts >= bufferedStart && ts <= bufferedStop) {
            events.push(evt);
          }
        } catch {}
      }
    } catch {}
  }

  events.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  if (deleteAfterRead) {
    for (const logFile of files) {
      try { fs.unlinkSync(logFile); } catch {}
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// OTel helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Unix timestamp (seconds, float) to OTel HrTime [seconds, nanos].
 * OTel Node.js SDK treats plain numbers as milliseconds, so we must use
 * the [seconds, nanos] tuple format to avoid 1e6x precision loss.
 */
function hrTime(timestampSec) {
  const sec = Math.floor(timestampSec);
  const nanos = Math.round((timestampSec - sec) * 1e9);
  return [sec, nanos];
}

/** Convert a Unix timestamp (seconds, float) to integer nanoseconds. */
function tsNs(sec) {
  return Math.round(sec * 1e9);
}

// ---------------------------------------------------------------------------
// _replayEventsAsSpans — full port of the Python function
// ---------------------------------------------------------------------------

function replayEventsAsSpans(tracer, events, parentCtx, stopTime) {
  const openTools = {};
  let currentTurnSpan = null;
  let currentTurnCtx = null;
  let turnIdx = 0;

  function parentContext() {
    return currentTurnCtx !== null ? currentTurnCtx : parentCtx;
  }

  for (const ev of events) {
    const evType = ev.type || "";
    const evTs = ev.timestamp || stopTime;

    if (evType === "user_prompt_submit") {
      if (currentTurnSpan !== null) {
        currentTurnSpan.end(hrTime(evTs));
        currentTurnSpan = null;
        currentTurnCtx = null;
      }

      turnIdx++;
      const p = ev.prompt || "";
      const preview = p.length > 50 ? p.slice(0, 50) + "..." : p;
      const label = preview ? `👤 Turn ${turnIdx}: ${preview}` : `👤 Turn ${turnIdx}`;
      currentTurnSpan = tracer.startSpan(
        label,
        {
          startTime: hrTime(evTs),
          attributes: {
            "turn.index": turnIdx,
            "gen_ai.input.messages": p,
            "gen_ai.span_kind_name": "LLM",
          },
        },
        parentCtx
      );
      currentTurnCtx = trace.setSpan(context.active(), currentTurnSpan);

    } else if (evType === "pre_tool_use") {
      const toolName = ev.tool_name || "unknown";
      const toolInput = ev.tool_input || {};
      const toolUseId = ev.tool_use_id || "";
      const toolTitle = createToolTitle(toolName, toolInput);
      const eventData = createEventData(toolName, toolInput);

      const attrs = {
        "gen_ai.tool.name": toolName,
        "gen_ai.span_kind_name": "TOOL",
      };
      for (const [k, v] of Object.entries(eventData)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          attrs[k] = v;
        }
      }

      const toolSpan = tracer.startSpan(
        `🔧 ${toolTitle}`,
        { startTime: hrTime(evTs), attributes: attrs },
        parentContext()
      );
      if (toolUseId) {
        openTools[toolUseId] = toolSpan;
      } else {
        toolSpan.end(hrTime(evTs));
      }

    } else if (evType === "post_tool_use") {
      const toolUseId = ev.tool_use_id || "";
      const toolName = ev.tool_name || "unknown";
      const toolResponse = ev.tool_response;

      const toolSpan = openTools[toolUseId];
      if (toolSpan) {
        delete openTools[toolUseId];
        const eventData = { "gen_ai.tool.name": toolName };
        addResponseToEventData(eventData, toolResponse);
        for (const [k, v] of Object.entries(eventData)) {
          if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
            toolSpan.setAttribute(k, v);
          }
        }
        toolSpan.end(hrTime(evTs));
      }

    } else if (evType === "pre_compact") {
      const span = tracer.startSpan(
        "🗜️ Context compaction",
        {
          startTime: hrTime(evTs),
          attributes: {
            "compact.trigger": ev.trigger || "unknown",
            "compact.has_custom_instructions": !!ev.has_custom_instructions,
            "gen_ai.span_kind_name": "TASK",
          },
        },
        parentCtx
      );
      span.end(hrTime(evTs));

    } else if (evType === "notification") {
      const msg = ev.message || "";
      const span = tracer.startSpan(
        msg ? `🔔 ${msg.slice(0, 60)}` : "🔔 Notification",
        {
          startTime: hrTime(evTs),
          attributes: {
            "notification.message": msg,
            "notification.level": ev.level || "info",
            "notification.title": ev.title || "",
            "gen_ai.span_kind_name": "TASK",
          },
        },
        parentCtx
      );
      span.end(hrTime(evTs));

    } else if (evType === "subagent_start") {
      const subSid = ev.subagent_session_id || "";
      const span = tracer.startSpan(
        subSid ? `🤖 Subagent started: ${subSid.slice(0, 30)}` : "🤖 Subagent started",
        {
          startTime: hrTime(evTs),
          attributes: {
            "subagent.session_id": subSid,
            "claude_code.hook.type": evType,
            "gen_ai.span_kind_name": "AGENT",
          },
        },
        parentContext()
      );
      span.end(hrTime(evTs));

    } else if (evType === "subagent_stop") {
      const childSid = ev.subagent_session_id || "unknown";
      const childState = ev._child_state;

      if (childState && Array.isArray(childState.events) && childState.events.length > 0) {
        const childPrompt = childState.prompt || "";
        const childPreview = childPrompt.length > 50
          ? childPrompt.slice(0, 50) + "..."
          : childPrompt;
        const childMetrics = childState.metrics || {};
        const childStart = childState.start_time || evTs;
        const childStop = childState.stop_time || evTs;

        const containerSpan = tracer.startSpan(
          childPreview ? `🤖 Subagent: ${childPreview}` : "🤖 Subagent",
          {
            startTime: hrTime(childStart),
            attributes: {
              "subagent.session_id": childSid,
              "subagent.stop_reason": ev.stop_reason || "end_turn",
              "gen_ai.usage.input_tokens": childMetrics.input_tokens || ev.input_tokens || 0,
              "gen_ai.usage.output_tokens": childMetrics.output_tokens || ev.output_tokens || 0,
              "gen_ai.request.model": childState.model || "unknown",
              "gen_ai.span_kind_name": "AGENT",
            },
          },
          parentContext()
        );
        const containerCtx = trace.setSpan(context.active(), containerSpan);
        replayEventsAsSpans(tracer, childState.events, containerCtx, childStop);
        containerSpan.end(hrTime(childStop));
      } else {
        const span = tracer.startSpan(
          "🤖 Subagent completed",
          {
            startTime: hrTime(evTs),
            attributes: {
              "subagent.session_id": childSid,
              "subagent.stop_reason": ev.stop_reason || "end_turn",
              "gen_ai.usage.input_tokens": ev.input_tokens || 0,
              "gen_ai.usage.output_tokens": ev.output_tokens || 0,
              "gen_ai.usage.cache_read.input_tokens": ev.cache_read_input_tokens || 0,
              "gen_ai.usage.cache_creation.input_tokens": ev.cache_creation_input_tokens || 0,
              "claude_code.hook.type": evType,
              "gen_ai.span_kind_name": "AGENT",
            },
          },
          parentContext()
        );
        span.end(hrTime(evTs));
      }

    } else if (evType === "llm_call") {
      const model = ev.model || "unknown";
      const inputMessages = ev.input_messages || [];

      let lastUserPreview = "";
      if (Array.isArray(inputMessages)) {
        for (let i = inputMessages.length - 1; i >= 0; i--) {
          const m = inputMessages[i];
          if (m && m.role === "user") {
            const content = m.content;
            if (typeof content === "string") {
              lastUserPreview = content.slice(0, 40);
            } else if (Array.isArray(content)) {
              for (const block of content) {
                if (block && block.type === "text") {
                  lastUserPreview = (block.text || "").slice(0, 40);
                  break;
                }
              }
            }
            break;
          }
        }
      }

      const label = lastUserPreview
        ? `🧠 LLM: ${lastUserPreview}...`
        : `🧠 LLM call (${model})`;

      const requestStart = ev.request_start_time || evTs;
      const llmSpan = tracer.startSpan(
        label,
        {
          startTime: hrTime(requestStart),
          attributes: {
            "gen_ai.system": "anthropic",
            "gen_ai.request.model": model,
            "gen_ai.response.model": model,
            "gen_ai.usage.input_tokens": ev.input_tokens || 0,
            "gen_ai.usage.output_tokens": ev.output_tokens || 0,
            "gen_ai.usage.cache_read_input_tokens": ev.cache_read_input_tokens || 0,
            "gen_ai.usage.cache_creation_input_tokens": ev.cache_creation_input_tokens || 0,
            "claude_code.hook.type": "llm_call",
            "gen_ai.span_kind_name": "LLM",
          },
        },
        parentContext()
      );

      // Attach input/output messages (best-effort, max 1MB each)
      try {
        let rawInput = ev.input_messages || [];
        const systemPrompt = ev.system_prompt;
        if (systemPrompt !== null && systemPrompt !== undefined) {
          let systemText = "";
          if (Array.isArray(systemPrompt)) {
            systemText = systemPrompt
              .map((item) => (typeof item === "string" ? item : (item && item.text) || ""))
              .join("\n");
          } else {
            systemText = String(systemPrompt);
          }
          rawInput = [{ role: "system", content: systemText }, ...(Array.isArray(rawInput) ? rawInput : [])];
        }
        if (rawInput && (Array.isArray(rawInput) ? rawInput.length > 0 : true)) {
          let serialized = typeof rawInput === "string"
            ? rawInput
            : JSON.stringify(rawInput);
          if (serialized.length > MAX_CONTENT_LENGTH) {
            serialized = serialized.slice(0, MAX_CONTENT_LENGTH) + "...(truncated)";
          }
          llmSpan.setAttribute("gen_ai.input.messages", serialized);
        }
      } catch {}

      try {
        const rawOutput = ev.output_content;
        if (rawOutput !== null && rawOutput !== undefined) {
          let serialized = typeof rawOutput === "string"
            ? rawOutput
            : JSON.stringify(rawOutput);
          if (serialized.length > MAX_CONTENT_LENGTH) {
            serialized = serialized.slice(0, MAX_CONTENT_LENGTH) + "...(truncated)";
          }
          llmSpan.setAttribute("gen_ai.output.messages", serialized);
        }
      } catch {}

      if (ev.is_error) {
        llmSpan.setAttribute("error", true);
        llmSpan.setAttribute("error.message", ev.error_message || "");
      }
      llmSpan.end(hrTime(evTs));
    }
  }

  // Close any orphaned tool spans
  for (const orphan of Object.values(openTools)) {
    orphan.end(hrTime(stopTime));
  }
  if (currentTurnSpan !== null) {
    currentTurnSpan.end(hrTime(stopTime));
  }
}

// ---------------------------------------------------------------------------
// export_session_trace
// ---------------------------------------------------------------------------

async function exportSessionTrace(state, stopReason = "end_turn") {
  // configureTelemetry throws Error if no backend is configured — let it propagate
  // so cmdStop can catch it and warn without crashing.
  configureTelemetry();

  if (!state || typeof state !== "object") {
    throw new Error("exportSessionTrace: invalid state object");
  }

  const sessionId = state.session_id || "unknown";
  const prompt = state.prompt || "";
  const metrics = state.metrics || {};
  let events = Array.isArray(state.events) ? state.events : [];
  const startTime = typeof state.start_time === "number" ? state.start_time : Date.now() / 1000;
  const stopTime = typeof state.stop_time === "number" ? state.stop_time : Date.now() / 1000;

  const promptPreview = prompt.length > 60 ? prompt.slice(0, 60) + "..." : prompt;
  const spanTitle = prompt ? `🤖 ${promptPreview}` : "Claude Session";

  const tracer = trace.getTracer("opentelemetry-instrumentation-claude");

  // Merge proxy events from intercept.js.
  // resolveClaudePid() walks the process tree to find the claude PID whose
  // proxy_events_<pid>.jsonl file we should read and delete.
  try {
    const claudePid = resolveClaudePid();
    const proxyEvents = readProxyEvents(startTime, stopTime, true, claudePid);
    if (proxyEvents.length > 0) {
      events = [...events, ...proxyEvents].sort(
        (a, b) => (a.timestamp || 0) - (b.timestamp || 0)
      );
    }
  } catch {}

  const sessionSpan = tracer.startSpan(spanTitle, {
    startTime: hrTime(startTime),
    attributes: {
      "gen_ai.input.messages": prompt,
      session_id: sessionId,
      "gen_ai.conversation.id": sessionId,
      "gen_ai.system": "anthropic",
      "gen_ai.request.model": state.model || "unknown",
      "gen_ai.response.model": state.model || "unknown",
      "gen_ai.usage.input_tokens": metrics.input_tokens || 0,
      "gen_ai.usage.output_tokens": metrics.output_tokens || 0,
      tools_used: metrics.tools_used || 0,
      tool_names: (state.tools_used || []).join(","),
      turns: metrics.turns || 0,
      stop_reason: stopReason,
      "gen_ai.span_kind_name": "TASK",
    },
  });
  const sessionCtx = trace.setSpan(context.active(), sessionSpan);

  replayEventsAsSpans(tracer, events, sessionCtx, stopTime);
  sessionSpan.end(hrTime(stopTime));

  await shutdownTelemetry();

  const duration = stopTime - startTime;
  console.error(
    `✅ Session traced | ` +
    `${metrics.input_tokens || 0} in, ` +
    `${metrics.output_tokens || 0} out | ` +
    `${metrics.tools_used || 0} tools | ` +
    `${duration.toFixed(1)}s`
  );
}

// ---------------------------------------------------------------------------
// stdin helper
// ---------------------------------------------------------------------------

function readStdinJson() {
  try {
    // Read stdin synchronously. Claude Code sends hook data as JSON on stdin.
    // We use a 4KB buffer loop to handle large payloads reliably across platforms.
    const chunks = [];
    const buf = Buffer.alloc(4096);
    let fd;
    try {
      fd = fs.openSync("/dev/stdin", "rs");
    } catch {
      // Fallback: read from fd 0 directly
      fd = 0;
    }
    let bytes;
    while ((bytes = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      chunks.push(buf.slice(0, bytes));
    }
    if (fd !== 0) try { fs.closeSync(fd); } catch {}
    const raw = Buffer.concat(chunks).toString("utf-8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// install helpers
// ---------------------------------------------------------------------------

function installIntercept() {
  const src = path.join(__dirname, "intercept.js");
  if (!fs.existsSync(src)) {
    console.error("⚠️  intercept.js not found in package, skipping.");
    return null;
  }
  const destDir = path.join(os.homedir(), ".cache", "opentelemetry.instrumentation.claude");
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, "intercept.js");
  fs.copyFileSync(src, dest);
  console.error(`✅ intercept.js installed to ${dest}`);
  return dest;
}

function installIntoSettings(settingsPath) {
  settingsPath = path.resolve(settingsPath);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")); } catch {}
  }

  if (!settings.hooks) settings.hooks = {};
  const hookConfig = buildHookConfig(getHookCmd());

  for (const [eventName, matchers] of Object.entries(hookConfig)) {
    if (!settings.hooks[eventName]) settings.hooks[eventName] = [];
    const existing = settings.hooks[eventName];
    const hookCmd = matchers[0].hooks[0].command;

    const alreadyPresent = existing.some((matcher) =>
      (matcher.hooks || []).some((h) => h.command === hookCmd)
    );
    if (!alreadyPresent) {
      existing.push(...matchers);
    }
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Command handlers (called from bin/otel-claude-hook)
// ---------------------------------------------------------------------------

function cmdUserPromptSubmit() {
  const event = readStdinJson();
  const sessionId = event.session_id || require("crypto").randomUUID();
  const prompt = event.prompt || "";

  const state = loadState(sessionId);
  if (!state.start_time) state.start_time = Date.now() / 1000;
  if (!state.prompt) state.prompt = prompt;
  state.metrics.turns = (state.metrics.turns || 0) + 1;
  if (event.model) state.model = event.model;

  state.events.push({
    type: "user_prompt_submit",
    timestamp: Date.now() / 1000,
    prompt,
  });
  saveState(sessionId, state);
}

function cmdPreToolUse() {
  const event = readStdinJson();
  const sessionId = event.session_id || require("crypto").randomUUID();
  const toolName = event.tool_name || "unknown";
  const toolInput = event.tool_input || {};
  // Use event-provided tool_use_id only. Falling back to a random UUID would
  // create an id that cmdPostToolUse can never match (it also falls back to
  // null), leaving the span open forever. When absent, replayEventsAsSpans
  // closes the pre-span immediately (the `if (toolUseId)` guard).
  const toolUseId = event.tool_use_id || null;

  const state = loadState(sessionId);
  state.metrics.tools_used = (state.metrics.tools_used || 0) + 1;
  if (!state.tools_used.includes(toolName)) state.tools_used.push(toolName);

  state.events.push({
    type: "pre_tool_use",
    timestamp: Date.now() / 1000,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
  });
  saveState(sessionId, state);
}

function cmdPostToolUse() {
  const event = readStdinJson();
  const sessionId = event.session_id || require("crypto").randomUUID();

  const state = loadState(sessionId);
  state.events.push({
    type: "post_tool_use",
    timestamp: Date.now() / 1000,
    tool_name: event.tool_name || "unknown",
    tool_response: event.tool_response,
    tool_use_id: event.tool_use_id || null,
  });
  saveState(sessionId, state);
}

function cmdPreCompact() {
  const event = readStdinJson();
  const sessionId = event.session_id || require("crypto").randomUUID();

  const state = loadState(sessionId);
  state.events.push({
    type: "pre_compact",
    timestamp: Date.now() / 1000,
    trigger: event.trigger || "unknown",
    has_custom_instructions: event.custom_instructions !== null && event.custom_instructions !== undefined,
  });
  saveState(sessionId, state);
}

function cmdSubagentStart() {
  const event = readStdinJson();
  const sessionId = event.session_id || require("crypto").randomUUID();

  const state = loadState(sessionId);
  state.events.push({
    type: "subagent_start",
    timestamp: Date.now() / 1000,
    subagent_session_id: event.subagent_session_id || "",
    agent_id: event.agent_id || "",
    agent_type: event.agent_type || "",
  });
  saveState(sessionId, state);
}

function cmdSubagentStop() {
  const event = readStdinJson();
  const sessionId = event.session_id || require("crypto").randomUUID();
  const stopReason = event.stop_reason || "end_turn";

  const usage = event.usage || {};
  const inputTokens = usage.input_tokens || event.input_tokens || 0;
  const outputTokens = usage.output_tokens || event.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || event.cache_read_input_tokens || 0;
  const cacheCreate = usage.cache_creation_input_tokens || event.cache_creation_input_tokens || 0;

  const childSid = event.subagent_session_id || "unknown";
  let childStateSnapshot = null;
  if (childSid && childSid !== "unknown" && childSid !== sessionId) {
    childStateSnapshot = readAndDeleteChildState(childSid);
  }

  const evData = {
    type: "subagent_stop",
    timestamp: Date.now() / 1000,
    subagent_session_id: childSid,
    stop_reason: stopReason,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreate,
  };
  if (childStateSnapshot && Array.isArray(childStateSnapshot.events) && childStateSnapshot.events.length > 0) {
    evData._child_state = childStateSnapshot;
  }

  const state = loadState(sessionId);
  state.events.push(evData);
  saveState(sessionId, state);
}

function cmdNotification() {
  const event = readStdinJson();
  const sessionId = event.session_id || require("crypto").randomUUID();

  const state = loadState(sessionId);
  state.events.push({
    type: "notification",
    timestamp: Date.now() / 1000,
    message: event.message || "",
    title: event.title || "",
    level: event.level || "info",
  });
  saveState(sessionId, state);
}

async function cmdStop() {
  const event = readStdinJson();
  const sessionId = event.session_id || require("crypto").randomUUID();
  const stopReason = event.stop_reason || "end_turn";

  const state = loadState(sessionId);
  state.stop_time = Date.now() / 1000;
  saveState(sessionId, state);

  // Telemetry export failures must NOT crash the process (exit code 0),
  // otherwise Claude Code may treat the hook as broken.
  try {
    await exportSessionTrace(state, stopReason);
  } catch (err) {
    console.error(
      "[otel-claude-hook] telemetry export failed (agent unaffected):",
      err?.message || String(err)
    );
  }
}

async function cmdInstall(opts = {}) {
  const quiet = !!opts.quiet;

  // Helper: print unless quiet mode
  const log = (...args) => { if (!quiet) console.error(...args); };

  // Use full language detection (with system commands) for install output.
  // This runs only once; subprocess latency is acceptable here.
  const installLang = quiet ? LANG_MODE : detectLangFull();
  const installMsg = (zh, en) => installLang === "zh" ? zh : en;

  try {
    const targets = [];
    if (opts.user !== false) {
      targets.push(path.join(os.homedir(), ".claude", "settings.json"));
    }
    if (opts.project) {
      targets.push(path.join(process.cwd(), ".claude", "settings.json"));
    }
    if (targets.length === 0 && !quiet) {
      console.error(installMsg("未指定目标 - 请使用 --user 或 --project。", "No target specified - use --user or --project."));
      process.exit(1);
    }

    // 1. Register hooks in settings.json
    for (const settingsPath of targets) {
      installIntoSettings(settingsPath);
      log(installMsg(`✅ Hook 已安装到 ${settingsPath}`, `✅ Hooks installed in ${settingsPath}`));
    }
    log(installMsg(
      "✅ 已启用 Claude Code 内置 OTel 指标 (CLAUDE_CODE_ENABLE_TELEMETRY=1 via alias)",
      "✅ Claude Code built-in OTel metrics enabled (CLAUDE_CODE_ENABLE_TELEMETRY=1 via alias)"
    ));

    // 2. Copy intercept.js to cache directory
    const interceptPath = installIntercept();

    // 3. Set up shell alias via setup-alias.sh (if bash is available)
    const setupAliasScript = path.join(__dirname, "..", "scripts", "setup-alias.sh");
    if (fs.existsSync(setupAliasScript)) {
      try {
        const { execSync } = require("child_process");
        execSync(`bash "${setupAliasScript}"`, { stdio: quiet ? "ignore" : "inherit" });
      } catch (err) {
        if (!quiet) {
          console.error(installMsg(
            `⚠️  alias 设置失败（非致命）: ${err.message}`,
            `⚠️  alias setup failed (non-fatal): ${err.message}`
          ));
        }
      }
    }

    // 4. Print usage hints (non-quiet only)
    log(
      installMsg(
        "\n请配置遥测后端：\n" +
        "  export OTEL_EXPORTER_OTLP_ENDPOINT='https://xxx:4318'\n" +
        "  export OTEL_RESOURCE_ATTRIBUTES='service.name=claude-agents'\n",
        "\nRemember to configure your telemetry backend:\n" +
        "  export OTEL_EXPORTER_OTLP_ENDPOINT='https://xxx:4318'\n" +
        "  export OTEL_RESOURCE_ATTRIBUTES='service.name=claude-agents'\n"
      )
    );
    if (interceptPath) {
      log(
        installMsg(
          "启用 LLM 输入输出追踪，请使用以下方式启动 Claude Code：\n" +
          `  CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_METRICS_EXPORTER=otlp OTEL_METRIC_EXPORT_INTERVAL=20000 OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta NODE_OPTIONS="--require ${interceptPath}" npx -y @anthropic-ai/claude-code@latest\n` +
          "\n或在 Shell 配置文件中添加以下别名（已通过 setup-alias.sh 自动配置）：\n" +
          `  alias claude='CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_METRICS_EXPORTER=otlp OTEL_METRIC_EXPORT_INTERVAL=20000 OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta NODE_OPTIONS="--require ${interceptPath}" npx -y @anthropic-ai/claude-code@latest'\n`,
          "To enable LLM call tracing, launch Claude Code with:\n" +
          `  CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_METRICS_EXPORTER=otlp OTEL_METRIC_EXPORT_INTERVAL=20000 OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta NODE_OPTIONS="--require ${interceptPath}" npx -y @anthropic-ai/claude-code@latest\n` +
          "\nOr add the following alias to your shell profile (auto-configured via setup-alias.sh):\n" +
          `  alias claude='CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_METRICS_EXPORTER=otlp OTEL_METRIC_EXPORT_INTERVAL=20000 OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta NODE_OPTIONS="--require ${interceptPath}" npx -y @anthropic-ai/claude-code@latest'\n`
        )
      );
    }
  } catch (err) {
    if (quiet) {
      // In quiet/postinstall mode: warn but don't fail npm install
      console.error(`[otel-claude-hook] postinstall warning: ${err?.message || String(err)}`);
    } else {
      throw err;
    }
  }
}

function cmdShowConfig() {
  const snippet = { hooks: buildHookConfig(getHookCmd()) };
  console.log(JSON.stringify(snippet, null, 2));
}

function cmdCheckEnv() {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const debug = process.env.CLAUDE_TELEMETRY_DEBUG;

  if (endpoint) {
    console.error(msg(`📊 OTEL 端点: ${endpoint}`, `📊 OTEL endpoint: ${endpoint}`));
    if (process.env.OTEL_EXPORTER_OTLP_HEADERS) {
      console.error(msg("   请求头: ***已配置***", "   Headers: ***configured***"));
    }
  } else if (debug) {
    console.error(msg("🔍 调试模式已启用（仅控制台输出）", "🔍 Debug mode active (console output only)"));
  } else {
    console.error(
      msg(
        "❌ 未配置遥测后端。\n设置 OTEL_EXPORTER_OTLP_ENDPOINT 或 CLAUDE_TELEMETRY_DEBUG=1",
        "❌ No telemetry backend configured.\nSet OTEL_EXPORTER_OTLP_ENDPOINT or CLAUDE_TELEMETRY_DEBUG=1"
      )
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// cmdUninstall
// ---------------------------------------------------------------------------

function uninstallFromSettings(settingsPath) {
  settingsPath = path.resolve(settingsPath);
  if (!fs.existsSync(settingsPath)) return;

  let settings;
  try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")); }
  catch { return; }

  let changed = false;

  // Remove otel-claude-hook entries from hooks
  if (settings.hooks && typeof settings.hooks === "object") {
    for (const [event, matchers] of Object.entries(settings.hooks)) {
      if (!Array.isArray(matchers)) continue;
      const filtered = matchers
        .map((matcher) => {
          if (!Array.isArray(matcher.hooks)) return matcher;
          const newHooks = matcher.hooks.filter(
            (h) => !h.command || !h.command.includes("otel-claude-hook")
          );
          if (newHooks.length === matcher.hooks.length) return matcher;
          changed = true;
          return newHooks.length > 0 ? { ...matcher, hooks: newHooks } : null;
        })
        .filter(Boolean)
        .filter((m) => m && Array.isArray(m.hooks) && m.hooks.length > 0);

      if (filtered.length === 0) {
        delete settings.hooks[event];
        changed = true;
      } else {
        settings.hooks[event] = filtered;
      }
    }
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
      changed = true;
    }
  }

  // (enableTelemetry field was removed in favor of CLAUDE_CODE_ENABLE_TELEMETRY env var)

  if (changed) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    console.error(msg(`    ✅ hooks 配置已从 ${settingsPath} 中清理`, `    ✅ Hooks config cleaned up from ${settingsPath}`));
  } else {
    console.error(msg(`    ℹ️  ${settingsPath}: 未找到 otel-claude-hook 相关配置`, `    ℹ️  ${settingsPath}: No otel-claude-hook config found`));
  }
}

function removeAliasFromFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf-8");
  if (!content.includes("# BEGIN otel-claude-hook")) return;
  const newContent = content.replace(
    /\n?# BEGIN otel-claude-hook\n[\s\S]*?# END otel-claude-hook\n?/g,
    "\n"
  );
  fs.writeFileSync(filePath, newContent, "utf-8");
  console.error(msg(`    ✅ 已从 ${filePath} 删除别名`, `    ✅ Removed alias from ${filePath}`));
}

function cmdUninstall(opts = {}) {
  console.error("============================");
  console.error(msg(" otel-claude-hook — 卸载", " otel-claude-hook — Uninstall"));
  console.error("============================");
  console.error("");

  // 1. Clean settings.json
  console.error(msg("==> 清理 hooks 配置...", "==> Cleaning up hooks config..."));
  const targets = [];
  if (opts.project) targets.push(path.join(process.cwd(), ".claude", "settings.json"));
  if (opts.user !== false) targets.push(path.join(os.homedir(), ".claude", "settings.json"));
  for (const t of targets) uninstallFromSettings(t);
  console.error("");

  // 2. Remove intercept.js (or entire cache dir if --purge)
  const cacheDir = path.join(os.homedir(), ".cache", "opentelemetry.instrumentation.claude");
  if (opts.purge) {
    console.error(msg("==> --purge: 正在删除整个缓存目录...", "==> --purge: Removing entire cache directory..."));
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      console.error(msg(`    ✅ 已删除 ${cacheDir}`, `    ✅ Deleted ${cacheDir}`));
    } else {
      console.error(msg(`    ℹ️  ${cacheDir} 不存在，跳过`, `    ℹ️  ${cacheDir} not found, skipping`));
    }
  } else {
    console.error(msg("==> 正在删除 intercept.js...", "==> Removing intercept.js..."));
    const interceptFile = path.join(cacheDir, "intercept.js");
    if (fs.existsSync(interceptFile)) {
      fs.unlinkSync(interceptFile);
      console.error(msg(`    ✅ 已删除 ${interceptFile}`, `    ✅ Deleted ${interceptFile}`));
    } else {
      console.error(msg(`    ℹ️  ${interceptFile} 不存在，跳过`, `    ℹ️  ${interceptFile} not found, skipping`));
    }
  }
  console.error("");

  // 3. Remove alias from shell profiles
  console.error(msg("==> 正在清理 shell 别名...", "==> Cleaning up shell alias..."));
  removeAliasFromFile(path.join(os.homedir(), ".bashrc"));
  removeAliasFromFile(path.join(os.homedir(), ".zshrc"));
  removeAliasFromFile(path.join(os.homedir(), ".bash_profile"));
  console.error("");

  // 4. Done
  console.error("============================");
  console.error(msg(" ✅ 卸载完成", " ✅ Uninstall complete!"));
  console.error("============================");
  console.error("");
  if (!opts.purge) {
    console.error(msg(`  - Session 数据仍保留在: ${cacheDir}/sessions/`, `  - Session data retained at: ${cacheDir}/sessions/`));
    console.error(msg("  - 完全删除缓存：otel-claude-hook uninstall --purge", "  - To fully remove cache: otel-claude-hook uninstall --purge"));
  }
  console.error(msg("  - 重新加载 Shell 使别名失效：source ~/.bashrc", "  - Reload shell to deactivate alias: source ~/.bashrc"));
  console.error("");
}

module.exports = {
  cmdUserPromptSubmit,
  cmdPreToolUse,
  cmdPostToolUse,
  cmdPreCompact,
  cmdSubagentStart,
  cmdSubagentStop,
  cmdNotification,
  cmdStop,
  cmdInstall,
  cmdUninstall,
  cmdShowConfig,
  cmdCheckEnv,
  // Internal exports for testing
  _buildHookConfig: buildHookConfig,
  _hrTime: hrTime,
  _tsNs: tsNs,
  _readProxyEvents: readProxyEvents,
  _installIntoSettings: installIntoSettings,
  // Event-driven variants (bypass stdin, accept event object directly)
  _cmdUserPromptSubmitWithEvent: function(event) {
    const { loadState, saveState } = require("./state");
    const sessionId = event.session_id || require("crypto").randomUUID();
    const prompt = event.prompt || "";
    const state = loadState(sessionId);
    if (!state.start_time) state.start_time = Date.now() / 1000;
    if (!state.prompt) state.prompt = prompt;
    state.metrics.turns = (state.metrics.turns || 0) + 1;
    if (event.model) state.model = event.model;
    state.events.push({ type: "user_prompt_submit", timestamp: Date.now() / 1000, prompt });
    saveState(sessionId, state);
  },
  _cmdPreToolUseWithEvent: function(event) {
    const { loadState, saveState } = require("./state");
    const sessionId = event.session_id || require("crypto").randomUUID();
    const toolName = event.tool_name || "unknown";
    const toolInput = event.tool_input || {};
    const toolUseId = event.tool_use_id || null;
    const state = loadState(sessionId);
    state.metrics.tools_used = (state.metrics.tools_used || 0) + 1;
    if (!state.tools_used.includes(toolName)) state.tools_used.push(toolName);
    state.events.push({ type: "pre_tool_use", timestamp: Date.now() / 1000, tool_name: toolName, tool_input: toolInput, tool_use_id: toolUseId });
    saveState(sessionId, state);
  },
  _cmdPostToolUseWithEvent: function(event) {
    const { loadState, saveState } = require("./state");
    const sessionId = event.session_id || require("crypto").randomUUID();
    const state = loadState(sessionId);
    state.events.push({ type: "post_tool_use", timestamp: Date.now() / 1000, tool_name: event.tool_name || "unknown", tool_response: event.tool_response, tool_use_id: event.tool_use_id || null });
    saveState(sessionId, state);
  },
  _cmdPreCompactWithEvent: function(event) {
    const { loadState, saveState } = require("./state");
    const sessionId = event.session_id || require("crypto").randomUUID();
    const state = loadState(sessionId);
    state.events.push({ type: "pre_compact", timestamp: Date.now() / 1000, trigger: event.trigger || "unknown", has_custom_instructions: event.custom_instructions != null });
    saveState(sessionId, state);
  },
  _cmdNotificationWithEvent: function(event) {
    const { loadState, saveState } = require("./state");
    const sessionId = event.session_id || require("crypto").randomUUID();
    const state = loadState(sessionId);
    state.events.push({ type: "notification", timestamp: Date.now() / 1000, message: event.message || "", title: event.title || "", level: event.level || "info" });
    saveState(sessionId, state);
  },
  _resolveClaudePid: typeof resolveClaudePid !== "undefined" ? resolveClaudePid : null,
  _replayEventsAsSpans: replayEventsAsSpans,
  _exportSessionTrace: exportSessionTrace,
  _installIntercept: installIntercept,
  _removeAliasFromFile: removeAliasFromFile,
  _cmdSubagentStartWithEvent: function(event) {
    const sessionId = event.session_id || require("crypto").randomUUID();
    const state = loadState(sessionId);
    state.events.push({
      type: "subagent_start",
      timestamp: Date.now() / 1000,
      subagent_session_id: event.subagent_session_id || "",
      agent_id: event.agent_id || "",
      agent_type: event.agent_type || "",
    });
    saveState(sessionId, state);
  },
  _cmdSubagentStopWithEvent: function(event) {
    const sessionId = event.session_id || require("crypto").randomUUID();
    const stopReason = event.stop_reason || "end_turn";
    const usage = event.usage || {};
    const inputTokens = usage.input_tokens || event.input_tokens || 0;
    const outputTokens = usage.output_tokens || event.output_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || event.cache_read_input_tokens || 0;
    const cacheCreate = usage.cache_creation_input_tokens || event.cache_creation_input_tokens || 0;
    const childSid = event.subagent_session_id || "unknown";
    let childStateSnapshot = null;
    if (childSid && childSid !== "unknown" && childSid !== sessionId) {
      childStateSnapshot = readAndDeleteChildState(childSid);
    }
    const evData = {
      type: "subagent_stop",
      timestamp: Date.now() / 1000,
      subagent_session_id: childSid,
      stop_reason: stopReason,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheCreate,
    };
    if (childStateSnapshot && Array.isArray(childStateSnapshot.events) && childStateSnapshot.events.length > 0) {
      evData._child_state = childStateSnapshot;
    }
    const state = loadState(sessionId);
    state.events.push(evData);
    saveState(sessionId, state);
  },
};
