# Changelog

## 0.1.0 (2026-04-14)

### Features

- Initial release of `@loongsuite/opentelemetry-util-genai`
- `TelemetryHandler` for LLM invocation lifecycle management (start/stop/fail + callback pattern)
- `ExtendedTelemetryHandler` with support for all GenAI operation types:
  - LLM (chat/completion)
  - Create Agent / Invoke Agent
  - Embedding
  - Execute Tool
  - Retrieval
  - Rerank
  - Memory (add, search, update, delete, etc.)
  - Entry (AI application system entry point)
  - ReAct Step (Reasoning-Acting iteration)
- Custom `instrumentationName` / `instrumentationVersion` options for controlling `otel.scope.name` and `otel.scope.version` on emitted spans
- Custom `startTime` / `endTime` passthrough on all start/stop methods for event-driven timestamp control
- Span attribute utilities following OpenTelemetry GenAI semantic conventions
- Metrics recording with duration and token usage histograms
- Environment variable configuration for content capturing and event emission
- Extended semantic convention constants (`gen_ai.span.kind`, memory attributes, etc.)
- Complete TypeScript type definitions for all invocation types
- `@opentelemetry/api` as peer dependency for proper singleton sharing
- Vitest-based test suite with 92 tests
