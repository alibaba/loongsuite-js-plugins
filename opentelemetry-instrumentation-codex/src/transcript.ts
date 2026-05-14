import * as fs from "node:fs";
import type { MessagePart, ToolDefinition } from "@loongsuite/opentelemetry-util-genai";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface TranscriptData {
  model: string;
  modelProvider: string;
  tokenEvents: TokenUsage[];
  totalUsage: TokenUsage | null;
  // gen_ai.system_instructions 数据源:
  //   - session_meta.payload.base_instructions.text(主 system prompt)
  //   - turn_context.payload.developer_instructions(每 turn 可更新,取最后一次)
  systemInstruction?: MessagePart[];
  // gen_ai.tool.definitions 数据源:
  //   - session_meta.payload.dynamic_tools[](codex 动态注册工具,如 automation_update;
  //     不含 shell/apply_patch 等内嵌在 system prompt 里的"伪工具")
  toolDefinitions?: ToolDefinition[];
}

interface DynamicToolEntry {
  namespace?: string;
  name?: string;
  description?: string;
  inputSchema?: unknown;
}

function mapDynamicTool(t: DynamicToolEntry): ToolDefinition | null {
  const rawName = typeof t.name === "string" ? t.name : "";
  if (!rawName) return null;
  const ns = typeof t.namespace === "string" ? t.namespace : "";
  return {
    type: "function",
    name: ns ? `${ns}/${rawName}` : rawName,
    description: typeof t.description === "string" ? t.description : null,
    parameters: t.inputSchema ?? {},
  };
}

function parseTokenUsage(raw: Record<string, unknown>): TokenUsage {
  return {
    inputTokens: Number(raw["input_tokens"] || 0),
    outputTokens: Number(raw["output_tokens"] || 0),
    cachedInputTokens: Number(raw["cached_input_tokens"] || 0),
    reasoningOutputTokens: Number(raw["reasoning_output_tokens"] || 0),
    totalTokens: Number(raw["total_tokens"] || 0),
  };
}

export function parseTranscript(transcriptPath: string): TranscriptData | null {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

  let content: string;
  try {
    content = fs.readFileSync(transcriptPath, "utf-8");
  } catch {
    return null;
  }

  let model = "unknown";
  let modelProvider = "openai";
  const tokenEvents: TokenUsage[] = [];
  let lastTotalUsage: TokenUsage | null = null;
  let baseInstructionsText = "";
  let lastDeveloperInstructions = "";
  const toolDefs: ToolDefinition[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const entryType = entry["type"] as string | undefined;
    const payload = entry["payload"] as Record<string, unknown> | undefined;
    if (!payload) continue;

    if (entryType === "session_meta") {
      const mp = payload["model_provider"];
      if (typeof mp === "string" && mp) modelProvider = mp;

      const bi = payload["base_instructions"];
      if (bi && typeof bi === "object") {
        const text = (bi as Record<string, unknown>)["text"];
        if (typeof text === "string" && text) baseInstructionsText = text;
      } else if (typeof bi === "string" && bi) {
        baseInstructionsText = bi;
      }

      const dynamicTools = payload["dynamic_tools"];
      if (Array.isArray(dynamicTools)) {
        for (const t of dynamicTools) {
          if (!t || typeof t !== "object") continue;
          const mapped = mapDynamicTool(t as DynamicToolEntry);
          if (mapped) toolDefs.push(mapped);
        }
      }
    } else if (entryType === "turn_context") {
      const m = payload["model"];
      if (typeof m === "string" && m) model = m;

      const di = payload["developer_instructions"];
      if (typeof di === "string" && di) lastDeveloperInstructions = di;
    } else if (entryType === "event_msg") {
      const payloadType = payload["type"] as string | undefined;
      if (payloadType === "token_count") {
        const info = payload["info"] as Record<string, unknown> | null;
        if (!info) continue;

        const lastUsage = info["last_token_usage"] as Record<string, unknown> | undefined;
        if (lastUsage) {
          tokenEvents.push(parseTokenUsage(lastUsage));
        }

        const totalUsage = info["total_token_usage"] as Record<string, unknown> | undefined;
        if (totalUsage) {
          lastTotalUsage = parseTokenUsage(totalUsage);
        }
      }
    }
  }

  const systemInstruction: MessagePart[] = [];
  if (baseInstructionsText) {
    systemInstruction.push({ type: "text", content: baseInstructionsText });
  }
  if (lastDeveloperInstructions) {
    systemInstruction.push({ type: "text", content: lastDeveloperInstructions });
  }

  const hasContent =
    tokenEvents.length > 0 ||
    !!lastTotalUsage ||
    systemInstruction.length > 0 ||
    toolDefs.length > 0;
  if (!hasContent) return null;

  return {
    model,
    modelProvider,
    tokenEvents,
    totalUsage: lastTotalUsage,
    systemInstruction: systemInstruction.length > 0 ? systemInstruction : undefined,
    toolDefinitions: toolDefs.length > 0 ? toolDefs : undefined,
  };
}
