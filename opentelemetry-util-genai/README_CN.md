# @loongsuite/opentelemetry-util-genai

面向 Node.js 的 OpenTelemetry GenAI 工具库 — 为生成式 AI 操作提供标准化的遥测数据采集，涵盖 LLM、Agent、Embedding、Tool、Retrieval、Rerank、Memory、Entry 和 ReAct Step。

本库是 Python 版 `opentelemetry-util-genai` 的 Node.js 等价实现，遵循相同的语义约定和 API 设计模式。

## 安装

```bash
npm install @loongsuite/opentelemetry-util-genai
```

## 功能特性

- **LLM（聊天/补全）**：追踪 LLM 请求，支持完整消息内容、Token 用量和流式首 Token 时间（TTFT）
- **Agent**：创建和调用 Agent，支持工具定义和会话上下文
- **Embedding**：监控向量嵌入生成，包括维度数和编码格式
- **Tool 执行**：追踪工具调用的参数和返回结果
- **Retrieval（检索）**：观测从向量数据库检索文档的查询和结果
- **Rerank（重排）**：追踪文档重排操作及评分详情
- **Memory（记忆）**：记录记忆操作（添加、搜索、更新、删除等）
- **Entry（入口）**：标记 AI 应用系统入口点，包含会话/用户上下文
- **ReAct Step（推理-行动步骤）**：追踪 Agent 中的每一轮推理-行动迭代

## 快速开始

### 使用 TelemetryHandler（仅 LLM）

```typescript
import {
  TelemetryHandler,
  createLLMInvocation,
} from "@loongsuite/opentelemetry-util-genai";

const handler = new TelemetryHandler();

// 回调模式（推荐）
await handler.llm(
  createLLMInvocation({
    requestModel: "gpt-4",
    provider: "openai",
    inputMessages: [
      { role: "user", parts: [{ type: "text", content: "Hello!" }] },
    ],
  }),
  async (inv) => {
    // 在此调用你的 LLM API...
    inv.outputMessages = [
      {
        role: "assistant",
        parts: [{ type: "text", content: "Hi there!" }],
        finishReason: "stop",
      },
    ];
    inv.inputTokens = 5;
    inv.outputTokens = 10;
  },
);

// 或使用手动 start/stop 模式
const inv = createLLMInvocation({ requestModel: "gpt-4", provider: "openai" });
handler.startLlm(inv);
try {
  // 调用你的 LLM API...
  inv.inputTokens = 5;
  inv.outputTokens = 10;
  handler.stopLlm(inv);
} catch (err) {
  handler.failLlm(inv, {
    message: String(err),
    type: err instanceof Error ? err.constructor.name : "Error",
  });
}
```

### 使用 ExtendedTelemetryHandler（全部操作类型）

```typescript
import {
  ExtendedTelemetryHandler,
  createEmbeddingInvocation,
  createRetrievalInvocation,
  createInvokeAgentInvocation,
  createMemoryInvocation,
} from "@loongsuite/opentelemetry-util-genai";

const handler = new ExtendedTelemetryHandler();

// Embedding（向量嵌入）
handler.embedding(
  createEmbeddingInvocation("text-embedding-3-small"),
  (inv) => {
    inv.inputTokens = 100;
    inv.dimensionCount = 1536;
  },
);

// Retrieval（检索）
handler.retrieval(
  createRetrievalInvocation({ dataSourceId: "my_vector_store", topK: 5 }),
  (inv) => {
    inv.documents = [
      { id: "doc1", score: 0.95, content: "..." },
      { id: "doc2", score: 0.87, content: "..." },
    ];
  },
);

// Agent（智能体）
await handler.invokeAgent(
  createInvokeAgentInvocation("openai", { agentName: "research-agent" }),
  async (inv) => {
    // ... Agent 调用逻辑
    inv.inputTokens = 500;
    inv.outputTokens = 200;
  },
);

// Memory（记忆）
handler.memory(createMemoryInvocation("search", { userId: "user-1" }), (inv) => {
  inv.outputMessages = [{ content: "remembered context" }];
});
```

## 环境变量

| 变量名 | 说明 | 默认值 |
|---|---|---|
| `OTEL_SEMCONV_STABILITY_OPT_IN` | 设为 `gen_ai_latest_experimental` 以启用实验性功能 | - |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` | 内容采集模式：`NO_CONTENT`、`SPAN_ONLY`、`EVENT_ONLY`、`SPAN_AND_EVENT` | `NO_CONTENT` |
| `OTEL_INSTRUMENTATION_GENAI_EMIT_EVENT` | 是否发射 `gen_ai.client.inference.operation.details` 事件：`true`/`false` | 取决于内容采集模式 |

## 支持的操作类型

| 操作 | Span Kind | `gen_ai.operation.name` | Handler 方法 |
|---|---|---|---|
| LLM 聊天 | LLM | `chat` | `llm()` / `startLlm()` |
| 创建 Agent | AGENT | `create_agent` | `createAgent()` / `startCreateAgent()` |
| 调用 Agent | AGENT | `invoke_agent` | `invokeAgent()` / `startInvokeAgent()` |
| Embedding | EMBEDDING | `embeddings` | `embedding()` / `startEmbedding()` |
| 执行 Tool | TOOL | `execute_tool` | `executeTool()` / `startExecuteTool()` |
| Retrieval | RETRIEVER | `retrieval` | `retrieval()` / `startRetrieval()` |
| Rerank | RERANKER | `rerank_documents` | `rerank()` / `startRerank()` |
| Memory | MEMORY | `memory_operation` | `memory()` / `startMemory()` |
| Entry | ENTRY | `enter` | `entry()` / `startEntry()` |
| ReAct Step | STEP | `react` | `reactStep()` / `startReactStep()` |

## 语义约定

本库遵循 [OpenTelemetry GenAI 语义约定](https://opentelemetry.io/docs/specs/semconv/gen-ai/)，并包含 LoongSuite 扩展：

- `gen_ai.span.kind` — 逻辑 Span Kind 分类
- 扩展操作名称（`retrieval`、`rerank_documents`、`enter`、`react`）
- Memory 操作属性（`gen_ai.memory.*`）
- 缓存 Token 用量（`gen_ai.usage.cache_creation.input_tokens`、`gen_ai.usage.cache_read.input_tokens`）
- 总 Token 计算（`gen_ai.usage.total_tokens`）
- 首 Token 时间（`gen_ai.response.time_to_first_token`）

## API 参考

### 核心类

- **`TelemetryHandler`** — 管理 LLM 调用生命周期，包括 Span、指标和事件发射
- **`ExtendedTelemetryHandler`** — 继承 `TelemetryHandler`，支持全部 GenAI 操作类型

### 工厂函数

- `createLLMInvocation(init?)` — 创建 LLM 调用对象（带默认值）
- `createEmbeddingInvocation(requestModel, init?)` — 创建 Embedding 调用对象
- `createExecuteToolInvocation(toolName, init?)` — 创建工具执行调用对象
- `createCreateAgentInvocation(provider, init?)` — 创建 Agent 创建调用对象
- `createInvokeAgentInvocation(provider, init?)` — 创建 Agent 调用对象
- `createRetrievalInvocation(init?)` — 创建检索调用对象
- `createRerankInvocation(provider, init?)` — 创建重排调用对象
- `createMemoryInvocation(operation, init?)` — 创建记忆操作调用对象
- `createEntryInvocation(init?)` — 创建入口调用对象
- `createReactStepInvocation(init?)` — 创建 ReAct 步骤调用对象

### 单例访问器

- `getTelemetryHandler(options?)` — 获取或创建默认的 `TelemetryHandler`
- `getExtendedTelemetryHandler(options?)` — 获取或创建默认的 `ExtendedTelemetryHandler`

## 许可证

Apache License 2.0
