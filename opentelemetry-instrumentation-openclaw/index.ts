// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * Root entry point for OpenClaw's direct TypeScript loading (via jiti).
 *
 * Re-exports the plugin from src/index.ts and wraps it with the configSchema
 * and register() method that OpenClaw's plugin-sdk loader expects.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import armsTracePlugin from "./dist/index.js";

const plugin = {
  id: armsTracePlugin.id,
  name: armsTracePlugin.name,
  description: armsTracePlugin.description,
  configSchema: {
    type: "object",
    properties: {
      endpoint: {
        type: "string",
        default: "",
        description: "ARMS OTLP endpoint URL",
      },
      headers: {
        type: "object",
        default: {},
        description: "HTTP headers for ARMS authentication",
      },
      serviceName: {
        type: "string",
        default: "openclaw-agent",
        description: "Service name for traces",
      },
      debug: {
        type: "boolean",
        default: false,
        description: "Enable debug logging",
      },
      batchSize: {
        type: "number",
        default: 10,
        description: "Number of spans to buffer before sending",
      },
      flushIntervalMs: {
        type: "number",
        default: 5000,
        description: "Maximum time (ms) to wait before sending buffered spans",
      },
      enabledHooks: {
        type: "array",
        items: { type: "string" },
        description:
          "List of hooks to enable (if not set, all hooks are enabled)",
      },
    },
  },

  register(api: OpenClawPluginApi) {
    armsTracePlugin.activate(api as any);
  },
};

export default plugin;
