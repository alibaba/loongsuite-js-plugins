# opentelemetry-instrumentation-openclaw

OpenClaw plugin — report AI Agent execution traces to any OTLP-compatible backend via OpenTelemetry.

Spans follow the [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/):

| Span | gen_ai.span.kind | Description |
|------|-----------------|-------------|
| `enter_openclaw_system` | ENTRY | Request entry point |
| `invoke_agent` | AGENT | Agent invocation |
| `chat` | LLM | LLM call |
| `execute_tool` | TOOL | Tool execution |
| `session_start` / `session_end` | — | Session lifecycle |
| `gateway_start` / `gateway_stop` | — | Gateway lifecycle |

---

## Installation

The install script sets up two components:

1. **openclaw-cms-plugin** — Downloads, extracts, installs dependencies, and writes plugin config (Trace reporting)
2. **diagnostics-otel** — Locates the built-in OpenClaw extension and enables Metrics collection

```bash
curl -fsSL https://<your-plugin-host>/install.sh | bash -s -- \
  --endpoint "https://your-otlp-endpoint:4318" \
  --serviceName "my-openclaw-agent"
```

### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--endpoint` | Yes | OTLP endpoint URL |
| `--serviceName` | Yes | Service name for traces |
| `--plugin-url` | No | Custom tarball download URL |
| `--install-dir` | No | Override install directory |
| `--disable-metrics` | No | Skip diagnostics-otel metrics setup |

### Backend-specific auth headers

If your OTLP backend requires authentication headers, pass them to the plugin config after installation. Edit `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-cms-plugin": {
        "enabled": true,
        "config": {
          "endpoint": "https://your-otlp-endpoint:4318",
          "headers": {
            "x-api-key": "your-api-key"
          },
          "serviceName": "my-openclaw-agent"
        }
      }
    }
  }
}
```

> **Alibaba Cloud ARMS users**: The headers `x-arms-license-key`, `x-arms-project`, and `x-cms-workspace` are ARMS-specific authentication fields. Obtain these from the ARMS console → Integration Center.

### Prerequisites

- Node.js >= 18
- npm
- OpenClaw CLI (optional, used for auto-restarting the gateway)

---

## Uninstall

```bash
curl -fsSL https://<your-plugin-host>/uninstall.sh | bash
```

| Parameter | Description |
|-----------|-------------|
| `-y` / `--yes` | Skip confirmation prompt |
| `--install-dir` | Specify plugin install directory |
| `--keep-metrics` | Keep diagnostics-otel metrics config |

---

## Manual Configuration

If you prefer to configure manually, edit `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["openclaw-cms-plugin", "diagnostics-otel"],
    "load": { "paths": ["/path/to/openclaw-cms-plugin"] },
    "entries": {
      "openclaw-cms-plugin": {
        "enabled": true,
        "config": {
          "endpoint": "https://your-otlp-endpoint:4318",
          "headers": {
            "x-api-key": "your-backend-api-key"
          },
          "serviceName": "my-openclaw-agent",
          "debug": false,
          "batchSize": 10,
          "flushIntervalMs": 5000
        }
      },
      "diagnostics-otel": { "enabled": true }
    }
  },
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "https://your-otlp-endpoint:4318",
      "protocol": "http/protobuf",
      "headers": { "x-api-key": "your-backend-api-key" },
      "serviceName": "my-openclaw-agent",
      "traces": false,
      "metrics": true,
      "logs": false
    }
  }
}
```

> **Note**: Set `diagnostics.otel.traces: false` to avoid duplicate traces — `openclaw-cms-plugin` already handles trace reporting.

---

## Development

```bash
npm install
npm run build    # Compile TypeScript
npm run dev      # Watch mode
npm test         # Run tests (Vitest)
```

---

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
