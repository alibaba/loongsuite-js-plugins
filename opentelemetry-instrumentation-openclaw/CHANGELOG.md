# 更新日志

本文档记录 `openclaw-cms-plugin` 的重要变更。

## [0.1.2] - 2026-03-26

### 背景

- `0.1.1` 版本的主链路结构为：`ENTRY -> AGENT -> LLM -> TOOL -> TOOL...`，尚不支持真实多轮 `LLM <-> TOOL` 交错分段。
- `0.1.1` 在并发场景下仍存在断链/串链风险（包括 runId 错绑、上下文误关联等）。
- 本次 `0.1.2` 的核心目标是：补齐多轮 LLM 分段能力、引入 STEP 轮次语义，并系统性修复并发稳定性。

### 新增

- 新增 ReAct 轮次的 STEP span 支持：
  - `gen_ai.span.kind=STEP`
  - `gen_ai.operation.name=react`
  - `gen_ai.react.round`
  - `gen_ai.react.finish_reason`
- 新增 ReAct STEP span，支持真实多轮链路分段追踪

### 变更

- 升级 Trace 层级，支持真实多轮交错链路：
  - `ENTRY -> AGENT -> STEP -> (LLM/TOOL...)`
- 重构并发会话/并发 run 的上下文状态管理。
- 将 LLM 分段主路径切换为 Hook 驱动（以 `before_message_write` 为主）。
- 优化 TOOL 匹配策略（优先 `toolCallId(+runId)`，缺失时同名 fallback）。
- 对齐插件本地 Hook 事件类型与 OpenClaw 源码定义。

### 修复

- 修复并发场景下 runId 迟到绑定与跨会话 runId 污染问题。
- 修复上下文清理竞态导致的孤儿 span/断链问题。
- 修复 exporter 在并发收尾时误清理父 span 状态的问题。
- 修复 `agent_end` 指标提取问题：
  - `agent.message_count` 改为基于 `event.messages` 计算
  - `agent.tool_call_count` 改为基于 assistant 工具调用块计数
  - AGENT usage token 改为使用缓存的 `llm_output` usage
- 修复同一 STEP 内连续 LLM span 可能缺失 `gen_ai.input.messages` 的问题（增加输入快照回退）。
  - 说明：该问题是在 `0.1.2` 实施过程中暴露并修复，不属于 `0.1.1` 既有问题。

### 说明

- 宿主运行时中，`after_tool_call` 偶发缺失 `runId`/`toolCallId` 仍可能发生；插件保留 fallback 匹配机制（设计内行为）。

