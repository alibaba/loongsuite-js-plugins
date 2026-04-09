// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

"use strict";

/**
 * @agenttrack/opentelemetry-instrumentation-claude
 *
 * OpenTelemetry instrumentation for Claude Code — hook-based session tracing
 * plus intercept.js for per-request LLM call capture.
 */

const { configureTelemetry, shutdownTelemetry } = require("./telemetry");
const { loadState, saveState, clearState } = require("./state");
const {
  createToolTitle,
  createEventData,
  addResponseToEventData,
} = require("./hooks");

module.exports = {
  configureTelemetry,
  shutdownTelemetry,
  loadState,
  saveState,
  clearState,
  createToolTitle,
  createEventData,
  addResponseToEventData,
};
