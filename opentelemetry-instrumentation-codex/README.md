# opentelemetry-instrumentation-codex

OpenAI Codex CLI 的 OpenTelemetry 可观测插件 — 将 AI Agent 执行链路上报到任何兼容 OTLP 的后端。

无需修改 Codex 源码。插件通过 Codex 内置的 Hooks 机制工作：在会话过程中累积事件，会话结束时解析 transcript 文件获取 token 用量，最终导出符合 ARMS GenAI 语义规范的 OpenTelemetry 链路数据。

多轮会话中，每一轮产生独立的 trace（唯一 traceId），所有轮次共享同一个 `gen_ai.session.id`。

### 数据输出方式

插件支持两种数据输出方式，可同时启用：

| 方式 | 说明 | 用途 |
|------|------|------|
| **OTLP 导出** | 直接上报到任何 OTLP 兼容后端 | 独立使用，接入 Jaeger / ARMS / Grafana Tempo 等 |
| **JSONL 日志** | 写入本地 JSONL 文件（event_t schema） | 与 [ai-agent-collector](https://github.com/alibaba/loongcollector) 集成，集中采集多个 Agent 数据 |

## Span 层级结构

遵循 [ARMS GenAI 语义规范](https://opentelemetry.io/docs/specs/semconv/gen-ai/)：

```
enter_ai_application_system (ENTRY)
└── invoke_agent codex (AGENT)          ← 汇总全部 token
    ├── react step (STEP, round=1)
    │   ├── chat <model> (LLM)          ← 每轮 LLM 调用均有 token 指标
    │   ├── execute_tool shell (TOOL)
    │   └── execute_tool apply_patch (TOOL)
    ├── react step (STEP, round=2)
    │   ├── chat <model> (LLM)
    │   └── execute_tool shell (TOOL)
    └── react step (STEP, round=3)
        └── chat <model> (LLM)          ← finish_reason=stop
```

### Span 属性覆盖

| Span 类型 | 关键属性 |
|---|---|
| LLM (`chat`) | `gen_ai.usage.input_tokens`, `output_tokens`, `total_tokens`, `cache_read.input_tokens`, `response.model`, `response.finish_reasons`, `conversation.id`, `provider.name`, `input/output.messages` |
| AGENT (`invoke_agent`) | `agent.name`, `request.model`, `response.model`, 汇总 `usage.*` token, `conversation.id`, `framework` |
| TOOL (`execute_tool`) | `tool.name`, `tool.call.id`, `tool.type`, `tool.call.arguments`, `tool.call.result` |
| STEP (`react`) | `react.round` |
| ENTRY (`enter`) | `session.id`, `conversation.id`, `input/output.messages` |

### Token 用量获取

Token 数据来源于 Codex 的 transcript JSONL 文件（`~/.codex/sessions/.../*.jsonl`）。Codex 在每次 LLM 调用后写入 `token_count` 事件，包含 `last_token_usage`（单次调用）和 `total_token_usage`（累计）。

插件在 Stop hook 时解析 transcript，按时序将 token 数据注入对应的 LLM span，并在 AGENT span 上汇总全轮次 token 总量。

---

## 快速开始

### 方式一：一行远程安装（推荐）

```bash
curl -fsSL https://arms-apm-cn-hangzhou-pre.oss-cn-hangzhou.aliyuncs.com/opentelemetry-instrumentation-codex/remote-install.sh | bash -s -- \
  --endpoint "https://your-otlp-endpoint:4318" \
  --service-name "my-codex-agent"
```

支持的参数：

| 参数 | 说明 |
|------|------|
| `--endpoint <url>` | OTLP 后端地址，写入 `~/.codex/otel-config.json` |
| `--service-name <name>` | 服务名 |
| `--headers <kv>` | OTLP 请求头（逗号分隔的 key=value） |
| `--debug` | 启用调试输出 |
| `--tarball-url <url>` | 覆盖默认的 tarball 下载地址 |
| `--lang zh\|en` | 强制输出语言 |

### 方式二：本地安装

```bash
# 从源码安装
cd opentelemetry-instrumentation-codex
bash scripts/install.sh

# 或通过 npm 全局安装
npm install -g @loongsuite/opentelemetry-instrumentation-codex
```

安装时自动将 hooks 注册到 `~/.codex/config.toml`。

### 验证安装

```bash
otel-codex-hook check-env
```

---

## 配置

支持两种配置方式：**配置文件**（推荐）和 **环境变量**。配置文件优先级高于环境变量。

### 配置文件（推荐）

在以下路径创建 JSON 配置文件（按优先级查找）：

| 优先级 | 路径 | 作用域 |
|--------|------|--------|
| 1 | `./codex.config.json` | 项目级 |
| 2 | `~/.codex/otel.config.json` | 全局 |

示例 `codex.config.json`：

```json
{
  "OTEL_EXPORTER_OTLP_ENDPOINT": "https://your-otlp-endpoint/apm/trace/opentelemetry",
  "OTEL_EXPORTER_OTLP_HEADERS": "x-arms-license-key=xxx,x-arms-project=yyy,x-cms-workspace=zzz",
  "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
  "OTEL_RESOURCE_ATTRIBUTES": "service.name=my-codex-app",
  "OTEL_SEMCONV_STABILITY_OPT_IN": "gen_ai_latest_experimental",
  "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT": "SPAN_ONLY"
}
```

### otel-config.json（JSONL 日志输出）

通过 `~/.codex/otel-config.json` 配置 JSONL 日志输出（用于与 ai-agent-collector 集成）：

```json
{
  "log_enabled": true,
  "log_dir": "~/.ai-agent-collector/logs/codex",
  "log_filename_format": "hook"
}
```

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `log_enabled` | 是否启用 JSONL 日志输出 | `false` |
| `log_dir` | 日志输出目录 | `~/.cache/opentelemetry.instrumentation.codex/sessions` |
| `log_filename_format` | 日志文件名格式：`hook`（按日期滚动）或 `session`（按会话） | `session` |
| `otlp_endpoint` | OTLP 后端地址（也可通过环境变量设置） | — |
| `otlp_headers` | OTLP 请求头 | — |
| `service_name` | 服务名 | — |
| `debug` | 调试模式 | `false` |

> `log_filename_format` 为 `hook` 时，文件名为 `codex-YYYY-MM-DD.jsonl`（按日期滚动）；为 `session` 时，文件名为 `<session-id>.jsonl`。

### 环境变量

也可以直接设置环境变量：

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://your-otlp-endpoint:4318"
export OTEL_EXPORTER_OTLP_HEADERS="x-api-key=your-key"
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_RESOURCE_ATTRIBUTES="service.name=my-codex-app"
```

调试模式（输出到控制台）：

```bash
export CODEX_TELEMETRY_DEBUG=1
```

### 服务名设置

服务名按以下优先级确定：

1. `OTEL_SERVICE_NAME` 环境变量
2. `OTEL_RESOURCE_ATTRIBUTES` 中的 `service.name`
3. 默认值 `codex-agent`

### 启用消息内容采集

默认情况下 `gen_ai.input.messages` 和 `gen_ai.output.messages` 不包含在 span 中。启用方式：

```json
{
  "OTEL_SEMCONV_STABILITY_OPT_IN": "gen_ai_latest_experimental",
  "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT": "SPAN_ONLY"
}
```

> 注意：值必须是 `gen_ai_latest_experimental`，仅使用 `gen_ai` 不生效。

---

## 接入阿里云 ARMS

```json
{
  "OTEL_EXPORTER_OTLP_ENDPOINT": "https://proj-xxx.cn-hangzhou.log.aliyuncs.com/apm/trace/opentelemetry",
  "OTEL_EXPORTER_OTLP_HEADERS": "x-arms-license-key=xxx,x-arms-project=yyy,x-cms-workspace=zzz",
  "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
  "OTEL_RESOURCE_ATTRIBUTES": "service.name=my-app",
  "OTEL_SEMCONV_STABILITY_OPT_IN": "gen_ai_latest_experimental",
  "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT": "SPAN_ONLY"
}
```

> 从 ARMS 控制台 → 接入中心 获取 `x-arms-license-key`、`x-arms-project` 和 `x-cms-workspace`。

> 协议必须使用 `http/protobuf`，JSON 格式的 trace 数据不会被 ARMS SLS 正确索引。

---

## CLI 命令

```bash
otel-codex-hook install             # 将 hooks 注册到 ~/.codex/config.toml
otel-codex-hook uninstall           # 从 config.toml 移除 hooks
otel-codex-hook uninstall --purge   # 同时删除缓存和会话数据
otel-codex-hook check-env           # 检查配置状态（OTLP + JSONL 日志）
otel-codex-hook show-config         # 打印 hook 配置（TOML/JSON 格式）
```

### Hook 事件

| 命令 | Hook 事件 | 说明 |
|------|-----------|------|
| `session-start` | SessionStart | 初始化会话状态 |
| `user-prompt-submit` | UserPromptSubmit | 记录用户输入 |
| `pre-tool-use` | PreToolUse | 记录工具调用开始 |
| `post-tool-use` | PostToolUse | 记录工具调用完成 |
| `stop` | Stop | 解析 transcript、生成并导出 trace |

---

## 手动配置 Hooks

如果自动安装未生效，手动添加到 `~/.codex/config.toml`：

```toml
# OpenTelemetry instrumentation hooks
[[hooks.SessionStart]]
type = "command"
command = "otel-codex-hook session-start"

[[hooks.UserPromptSubmit]]
type = "command"
command = "otel-codex-hook user-prompt-submit"

[[hooks.PreToolUse]]
type = "command"
command = "otel-codex-hook pre-tool-use"

[[hooks.PostToolUse]]
type = "command"
command = "otel-codex-hook post-tool-use"

[[hooks.Stop]]
type = "command"
command = "otel-codex-hook stop"
```

---

## 卸载

```bash
# 方式一：使用卸载脚本
bash scripts/uninstall.sh

# 方式二：使用 CLI
otel-codex-hook uninstall

# 完全清理（包括缓存和会话数据）
otel-codex-hook uninstall --purge
```

卸载会移除 `~/.codex/config.toml` 中的 hooks 配置和 `~/.local/bin/otel-codex-hook` wrapper（如果存在）。会话数据保留在 `~/.cache/opentelemetry.instrumentation.codex/sessions/`，如需完全删除：

```bash
rm -rf ~/.cache/opentelemetry.instrumentation.codex
```

---

## 开发

```bash
npm install
npm run build       # 编译 TypeScript（tsup）
npm run dev         # 监听模式
npm run typecheck   # 仅类型检查
```

### 打包

```bash
bash scripts/pack.sh
# 输出: dist/otel-codex-hook.tar.gz
```

要求 Node.js >= 18.0.0。

---

## 许可证

Apache-2.0 — 详见 [LICENSE](../LICENSE)。
