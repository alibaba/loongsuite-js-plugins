// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
"use strict";

describe("telemetry", () => {
  let telemetry;

  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(async () => {
    if (telemetry) {
      try { await telemetry.shutdownTelemetry(); } catch {}
      telemetry = null;
    }
  });

  test("throws when no backend configured", () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.CLAUDE_TELEMETRY_DEBUG;
    telemetry = require("../src/telemetry");
    expect(() => telemetry.configureTelemetry()).toThrow(/NO TELEMETRY BACKEND/);
  });

  test("configures console provider in debug mode", () => {
    process.env.CLAUDE_TELEMETRY_DEBUG = "1";
    telemetry = require("../src/telemetry");
    const provider = telemetry.configureTelemetry();
    expect(provider).toBeDefined();
    delete process.env.CLAUDE_TELEMETRY_DEBUG;
  });

  test("is idempotent — returns same provider on repeat calls", () => {
    process.env.CLAUDE_TELEMETRY_DEBUG = "1";
    telemetry = require("../src/telemetry");
    const p1 = telemetry.configureTelemetry();
    const p2 = telemetry.configureTelemetry();
    expect(p1).toBe(p2);
    delete process.env.CLAUDE_TELEMETRY_DEBUG;
  });

  test("resolveServiceName uses OTEL_SERVICE_NAME env var", () => {
    process.env.OTEL_SERVICE_NAME = "my-service";
    telemetry = require("../src/telemetry");
    expect(telemetry.resolveServiceName()).toBe("my-service");
    delete process.env.OTEL_SERVICE_NAME;
  });

  test("resolveServiceName reads service.name from OTEL_RESOURCE_ATTRIBUTES", () => {
    delete process.env.OTEL_SERVICE_NAME;
    process.env.OTEL_RESOURCE_ATTRIBUTES = "env=prod,service.name=my-agent";
    telemetry = require("../src/telemetry");
    expect(telemetry.resolveServiceName()).toBe("my-agent");
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
  });

  test("resolveServiceName returns default when nothing set", () => {
    delete process.env.OTEL_SERVICE_NAME;
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    telemetry = require("../src/telemetry");
    expect(telemetry.resolveServiceName()).toBe("claude-agents");
  });
});
