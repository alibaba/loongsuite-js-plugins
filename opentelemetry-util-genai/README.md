# @loongsuite/opentelemetry-util-genai

OpenTelemetry GenAI utility library for Node.js — standardized telemetry collection for Generative AI operations including LLM, Agent, Embedding, Tool, Retrieval, Rerank, Memory, Entry, and ReAct Step.

This is the Node.js equivalent of the Python `opentelemetry-util-genai` package, following the same semantic conventions and API design patterns.

## Installation

```bash
npm install @loongsuite/opentelemetry-util-genai
```

## Features

- **LLM (Chat/Completion)**: Track LLM requests with full message content, token usage, and streaming TTFT
- **Agent**: Create and invoke agents with tool definitions and conversation context
- **Embedding**: Monitor embedding generation with dimension counts and encoding formats
- **Tool Execution**: Trace tool calls with arguments and results
- **Retrieval**: Observe document retrieval from vector stores with query and results
- **Rerank**: Track document reranking operations with scoring details
- **Memory**: Record memory operations (add, search, update, delete, etc.)
- **Entry**: Mark AI application system entry points with session/user context
- **ReAct Step**: Track individual Reasoning-Acting iterations in agents

## Quick Start

### Using TelemetryHandler (LLM only)

```typescript
import {
  TelemetryHandler,
  createLLMInvocation,
} from "@loongsuite/opentelemetry-util-genai";

const handler = new TelemetryHandler();

// Callback pattern (recommended)
await handler.llm(
  createLLMInvocation({
    requestModel: "gpt-4",
    provider: "openai",
    inputMessages: [
      { role: "user", parts: [{ type: "text", content: "Hello!" }] },
    ],
  }),
  async (inv) => {
    // Call your LLM API here...
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

// Or manual start/stop pattern
const inv = createLLMInvocation({ requestModel: "gpt-4", provider: "openai" });
handler.startLlm(inv);
try {
  // Call your LLM API...
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

### Using ExtendedTelemetryHandler (All operations)

```typescript
import {
  ExtendedTelemetryHandler,
  createEmbeddingInvocation,
  createRetrievalInvocation,
  createInvokeAgentInvocation,
  createMemoryInvocation,
} from "@loongsuite/opentelemetry-util-genai";

const handler = new ExtendedTelemetryHandler();

// Embedding
handler.embedding(
  createEmbeddingInvocation("text-embedding-3-small"),
  (inv) => {
    inv.inputTokens = 100;
    inv.dimensionCount = 1536;
  },
);

// Retrieval
handler.retrieval(
  createRetrievalInvocation({ dataSourceId: "my_vector_store", topK: 5 }),
  (inv) => {
    inv.documents = [
      { id: "doc1", score: 0.95, content: "..." },
      { id: "doc2", score: 0.87, content: "..." },
    ];
  },
);

// Agent
await handler.invokeAgent(
  createInvokeAgentInvocation("openai", { agentName: "research-agent" }),
  async (inv) => {
    // ... agent invocation
    inv.inputTokens = 500;
    inv.outputTokens = 200;
  },
);

// Memory
handler.memory(createMemoryInvocation("search", { userId: "user-1" }), (inv) => {
  inv.outputMessages = [{ content: "remembered context" }];
});
```

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `OTEL_SEMCONV_STABILITY_OPT_IN` | Set to `gen_ai_latest_experimental` to enable experimental features | - |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` | Content capturing mode: `NO_CONTENT`, `SPAN_ONLY`, `EVENT_ONLY`, `SPAN_AND_EVENT` | `NO_CONTENT` |
| `OTEL_INSTRUMENTATION_GENAI_EMIT_EVENT` | Whether to emit `gen_ai.client.inference.operation.details` events: `true`/`false` | Based on content mode |

## Supported Operation Types

| Operation | Span Kind | `gen_ai.operation.name` | Handler Method |
|---|---|---|---|
| LLM Chat | LLM | `chat` | `llm()` / `startLlm()` |
| Create Agent | AGENT | `create_agent` | `createAgent()` / `startCreateAgent()` |
| Invoke Agent | AGENT | `invoke_agent` | `invokeAgent()` / `startInvokeAgent()` |
| Embedding | EMBEDDING | `embeddings` | `embedding()` / `startEmbedding()` |
| Execute Tool | TOOL | `execute_tool` | `executeTool()` / `startExecuteTool()` |
| Retrieval | RETRIEVER | `retrieval` | `retrieval()` / `startRetrieval()` |
| Rerank | RERANKER | `rerank_documents` | `rerank()` / `startRerank()` |
| Memory | MEMORY | `memory_operation` | `memory()` / `startMemory()` |
| Entry | ENTRY | `enter` | `entry()` / `startEntry()` |
| ReAct Step | STEP | `react` | `reactStep()` / `startReactStep()` |

## Semantic Conventions

This library follows the [OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) with LoongSuite extensions for:

- `gen_ai.span.kind` — Logical span kind classification
- Extended operation names (`retrieval`, `rerank_documents`, `enter`, `react`)
- Memory operation attributes (`gen_ai.memory.*`)
- Cache token usage (`gen_ai.usage.cache_creation.input_tokens`, `gen_ai.usage.cache_read.input_tokens`)
- Total token calculation (`gen_ai.usage.total_tokens`)
- Time to first token (`gen_ai.response.time_to_first_token`)

## API Reference

### Core Classes

- **`TelemetryHandler`** — Manages LLM invocation lifecycles with span, metrics, and event emission
- **`ExtendedTelemetryHandler`** — Extends `TelemetryHandler` with support for all GenAI operation types

### Factory Functions

- `createLLMInvocation(init?)` — Create an LLM invocation with defaults
- `createEmbeddingInvocation(requestModel, init?)` — Create an embedding invocation
- `createExecuteToolInvocation(toolName, init?)` — Create a tool execution invocation
- `createCreateAgentInvocation(provider, init?)` — Create an agent creation invocation
- `createInvokeAgentInvocation(provider, init?)` — Create an agent invocation
- `createRetrievalInvocation(init?)` — Create a retrieval invocation
- `createRerankInvocation(provider, init?)` — Create a rerank invocation
- `createMemoryInvocation(operation, init?)` — Create a memory invocation
- `createEntryInvocation(init?)` — Create an entry invocation
- `createReactStepInvocation(init?)` — Create a ReAct step invocation

### Singleton Accessors

- `getTelemetryHandler(options?)` — Get or create the default `TelemetryHandler`
- `getExtendedTelemetryHandler(options?)` — Get or create the default `ExtendedTelemetryHandler`

## License

Apache License 2.0
