# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added
- Jest test suite: hooks, state, telemetry, intercept parsers, and cli command unit tests
- `cli.js` and `intercept.js` now included in coverage reporting

### Fixed
- `process.ppid` ≠ claude PID bug: `resolveClaudePid()` now walks the process tree
  (`/proc` on Linux, `ps` on macOS) to correctly locate `proxy_events_<pid>.jsonl`
- `readProxyEvents` with unknown PID no longer deletes files (safe fallback)
- `tool_use_id` fallback aligned between `cmdPreToolUse` and `cmdPostToolUse` (both use `null`)
- `detectLang()` no longer spawns subprocesses (`defaults read`, PowerShell); uses env vars only

### Performance
- Hook subprocess startup latency reduced by removing synchronous OS calls in `detectLang()`

---

## [0.1.1] - 2026-04-08

### Added
- npm global install support: `npm install -g @loongsuite/opentelemetry-instrumentation-claude`
- `otel-claude-hook install --user` completes full setup (hooks + intercept.js + shell alias)
- Remote install script (`remote-install.sh`) for one-line curl-based installation
- Uninstall command: `otel-claude-hook uninstall [--purge] [--project]`
- `--quiet` flag on `install` command for safe `postinstall` execution
- Shell alias wrapped in `# BEGIN otel-claude-hook` / `# END otel-claude-hook` comment blocks
- `OTEL_CLAUDE_LANG` env var for explicit language override (zh/en)
- LICENSE (Apache-2.0), CONTRIBUTING.md, CHANGELOG.md added
- Apache-2.0 SPDX headers added to all source files

### Fixed
- Renamed Alibaba-internal field names: `dashscope_id` → `response_id`,
  `dashscope_request_id` → `request_id`, `eagleeye_trace_id` → `vendor_trace_id`
- Session JSONL isolation: `intercept.js` names files `proxy_events_<PID>.jsonl`
  (one file per claude process) to prevent cross-session event pollution
- Proxy events are deleted after being read by `cmdStop`, preventing stale data accumulation
- `createToolTitle()` inner comparisons now correctly use the `maxLength` parameter
- `removeAliasFromFile()` uses `BEGIN…END` block matching instead of broad `grep`-based filter,
  preventing accidental removal of unrelated shell lines
- Shell alias installation is idempotent: `setup-alias.sh` skips if block already present
- `postinstall` uses `|| true` to never fail `npm install` on setup errors

### Changed
- Package renamed to `@loongsuite/opentelemetry-instrumentation-claude`
- `claude` alias now uses `npx -y @anthropic-ai/claude-code@latest` for cross-platform support
- `CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_METRICS_EXPORTER`, `OTEL_METRIC_EXPORT_INTERVAL`,
  `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` added to default alias

---

## [0.1.0] - 2026-04-07

### Added
- Initial release: Node.js port of `opentelemetry-instrumentation-claude` from Python
- Hook-based session tracing via Claude Code `settings.json`:
  `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `PreCompact`,
  `SubagentStart`, `SubagentStop`, `Notification`
- `intercept.js` for in-process LLM API call capture, with three strategies:
  - **Strategy A**: undici `Dispatcher` (best for `npx @anthropic-ai/claude-code`)
  - **Strategy B**: `https.request` / `http.request` patch (bundled claude binary)
  - **Strategy C**: `globalThis.fetch` monkey-patch (Bun runtime and fallback)
- Support for Anthropic Messages API, OpenAI Chat Completions, OpenAI Responses API
- Streaming (SSE) and non-streaming (JSON) response parsing
- Nested subagent span hierarchy (`SubagentStop` inlines child session trace)
- Atomic state file writes using `rename` (matches Python `os.replace()` semantics)
- `otel-claude-hook` CLI: `install`, `uninstall`, `show-config`, `check-env`
- Bilingual output (zh/en) based on `$LANG` / `$LANGUAGE` environment variables
- OTel HrTime `[seconds, nanos]` format for nanosecond-precision span timestamps
- `CLAUDE_CODE_ENABLE_TELEMETRY=1` enabled by default via shell alias
- Apache-2.0 license
