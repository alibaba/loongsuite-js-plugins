# @loongsuite/opentelemetry-instrumentation-opencode

OpenTelemetry instrumentation plugin for [OpenCode](https://opencode.ai) — export sessions, traces, metrics, and logs to any OTLP-compatible backend (Jaeger, Alibaba Sunfire, Grafana, SigNoz, Alibaba Cloud ARMS, etc.).

## Features

- 📊 **Metrics** — session count, token usage, cost, lines of code, git commits, tool durations, cache activity
- 🔍 **Traces** — hierarchical spans: Entry → Agent → Step → LLM / Tool / Permission
- 📝 **Logs** — structured log events (user prompts, session lifecycle, errors)
- 🔌 **Zero-config** — enable by setting `OTEL_EXPORTER_OTLP_ENDPOINT`
- 🌐 **OTLP/HTTP** — works with any OpenTelemetry-compatible backend

## Installation

```bash
# Via opencode plugin system
opencode install @loongsuite/opentelemetry-instrumentation-opencode
```

Or add to your opencode config manually:

```json
{
  "plugins": ["@loongsuite/opentelemetry-instrumentation-opencode"]
}
```

## Quick Start

```bash
# Send telemetry to a local collector
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318

# Start opencode — telemetry is enabled automatically
opencode
```

## Configuration

All configuration is done via environment variables. OTEL standard variables are preferred; legacy `OPENCODE_*` variables are supported as fallbacks.

### Core

| Variable | Default | Description |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP endpoint (enables telemetry when set) |
| `OTEL_EXPORTER_OTLP_HEADERS` | — | Additional HTTP headers, e.g. `Authorization=Bearer <token>` |
| `OTEL_RESOURCE_ATTRIBUTES` | — | Extra resource attributes, e.g. `env=prod,team=ml` |
| `OPENCODE_ENABLE_TELEMETRY` | — | Legacy: set to any value to enable telemetry |

### Traces

| Variable | Default | Description |
|---|---|---|
| `OTEL_TRACES_EXPORTER` | — | Set to `none` to disable traces |
| `OTEL_TRACE_MAX_CONTENT_SIZE` | `2048` | Max characters per role content in `gen_ai.input/output.messages` (0 = unlimited) |
| `OPENCODE_DISABLE_TRACES` | — | Legacy: set to any value to disable traces |

### Metrics

| Variable | Default | Description |
|---|---|---|
| `OTEL_METRIC_EXPORT_INTERVAL` | `60000` | Metric export interval in milliseconds |
| `OTEL_METRIC_PREFIX` | `opencode.` | Prefix for all metric names |
| `OTEL_DISABLE_METRICS` | — | Comma-separated list of metric names to disable |

### Logs

| Variable | Default | Description |
|---|---|---|
| `OTEL_LOGS_EXPORTER` | — | Set to `none` to disable logs; set to `otlp` to enable |
| `OTEL_BLRP_SCHEDULE_DELAY` | `5000` | Log batch export delay in milliseconds |

### Semantic Convention Dialect

Some backends (e.g. Alibaba Group internal ARMS) require the span kind attribute name `gen_ai.span_kind_name` instead of the default `gen_ai.span.kind`.

| Variable | Description |
|---|---|
| `LOONGSUITE_SEMCONV_DIALECT_NAME` | Set to `ALIBABA_GROUP` to use `gen_ai.span_kind_name` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Auto-detected: endpoints containing `sunfire` automatically switch to `ALIBABA_GROUP` dialect |

## Traces

When tracing is enabled, each user message produces a span hierarchy:

```
Entry (gen_ai.span.kind=ENTRY)
└── invoke_agent <agent-name> (gen_ai.span.kind=AGENT)
    └── step <n> (gen_ai.span.kind=STEP)
        ├── <model>/<prompt-preview> (gen_ai.span.kind=LLM)
        │     gen_ai.input.messages, gen_ai.output.messages
        │     gen_ai.usage.input_tokens, gen_ai.usage.output_tokens
        ├── tool:<tool-name> (gen_ai.span.kind=TOOL)
        │     gen_ai.tool.name, gen_ai.tool.call.arguments, gen_ai.tool.call.result
        └── permission:<tool-name> (gen_ai.span.kind=TOOL)
              permission.decision, permission.reason
```

### Key Span Attributes

| Attribute | Description |
|---|---|
| `gen_ai.system` | Always `opencode` |
| `gen_ai.operation.name` | Operation type: `enter`, `invoke_agent`, `step`, `chat`, `tool` |
| `gen_ai.agent.name` | Agent display name |
| `gen_ai.agent.id` | Agent ID |
| `gen_ai.request.model` | Model ID used for the LLM call |
| `gen_ai.usage.input_tokens` | Input tokens consumed |
| `gen_ai.usage.output_tokens` | Output tokens generated |
| `gen_ai.input.messages` | JSON-serialized input messages (truncated to `maxContentSize`) |
| `gen_ai.output.messages` | JSON-serialized output messages (truncated to `maxContentSize`) |
| `gen_ai.tool.name` | Tool name |
| `gen_ai.tool.call.arguments` | Tool call arguments (JSON) |
| `gen_ai.tool.call.result` | Tool execution result |
| `project.id` | OpenCode project ID |
| `session.id` | OpenCode session ID |

## Metrics

All metrics are prefixed with `opencode.` by default (configurable via `OTEL_METRIC_PREFIX`).

| Metric | Type | Unit | Description |
|---|---|---|---|
| `opencode.session.count` | Counter | `{session}` | Sessions started |
| `opencode.token.usage` | Counter | `{token}` | Tokens consumed (split by `type`: input/output/cacheRead/cacheCreation) |
| `opencode.cost.usage` | Counter | `{USD}` | Cumulative cost in USD |
| `opencode.lines_of_code.count` | Counter | `{line}` | Lines added/removed (from `session.diff`) |
| `opencode.commit.count` | Counter | `{commit}` | Git commits detected in executed commands |
| `opencode.tool.duration` | Histogram | `ms` | Tool execution duration |
| `opencode.cache.count` | Counter | `{request}` | Cache hits/creations per message |
| `opencode.session.duration` | Histogram | `ms` | Session lifetime (created → idle) |
| `opencode.message.count` | Counter | `{message}` | Completed assistant messages |
| `opencode.session.token.total` | Histogram | `{token}` | Total tokens per session (on idle) |
| `opencode.session.cost.total` | Histogram | `{USD}` | Total cost per session (on idle) |
| `opencode.model.usage` | Counter | `{request}` | Requests per model/provider |
| `opencode.retry.count` | Counter | `{retry}` | API retries observed |

To disable specific metrics:

```bash
export OTEL_DISABLE_METRICS="opencode.cost.usage,opencode.session.cost.total"
```

## Logs

Structured log events are emitted to the OTLP logs endpoint (requires `OTEL_LOGS_EXPORTER=otlp`):

| Event | Description |
|---|---|
| `user_prompt` | User message submitted, includes `prompt_length`, `model`, `agent` |
| Session lifecycle events | `session.created`, `session.idle`, `session.error` |

## Backend Examples

### Jaeger (local development)

```bash
docker run -p 4318:4318 -p 16686:16686 jaegertracing/all-in-one
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

### Grafana Cloud

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-<region>.grafana.net/otlp
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic <base64-encoded-token>"
```

### Alibaba Cloud ARMS

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=https://arms-opentelemetry-<region>.aliyuncs.com
export OTEL_EXPORTER_OTLP_HEADERS="Authentication=<arms-token>"
# gen_ai.span_kind_name is used automatically when endpoint contains "sunfire"
# Or set explicitly:
export LOONGSUITE_SEMCONV_DIALECT_NAME=ALIBABA_GROUP
```

## Architecture

```
opencode event bus
        │
        ▼
   OtelPlugin (src/index.ts)
   ├── config.ts      — env var resolution
   ├── probe.ts       — OTLP endpoint connectivity check
   ├── otel.ts        — SDK setup (MeterProvider / TracerProvider / LoggerProvider)
   └── handlers/
       ├── session.ts    — session lifecycle (created/idle/error/status)
       ├── message.ts    — LLM call spans, token/cost metrics, session history
       ├── permission.ts — tool permission request/reply spans
       └── activity.ts   — git commits, lines of code, tool durations
```

## Development

```bash
# Install dependencies
bun install

# Run tests
bun test

# Type check
bun run typecheck
```

## License

[MPL-2.0](./LICENSE)
