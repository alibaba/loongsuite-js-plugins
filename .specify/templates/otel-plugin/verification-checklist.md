# Verification Checklist — OTel Instrumentation Plugin: <AGENT>

> 5 类验证 fail-fast 顺序执行;失败 → self-correct(累计 ≥3 次失败则停下报告)。

**Feature ID**:1xx-instrumentation-<AGENT>

---

## V1. Typecheck(`npm run typecheck`)

**通过条件**:0 错误,0 warning。

**常见失败点**:
- 漏 import util-genai 类型(`MessagePart` / `ToolDefinition` / `InvocationXxx`)
- `process.env[X]` 取出的是 `string | undefined`,赋给 `string` 字段需先判 null

**自我修复策略**:
- 报错位置贴上对应 import / 类型 narrowing
- 仍失败 → 检查 tsconfig.json 是否漏 `lib: ["es2022"]` / `moduleResolution: "node16"`

---

## V2. Build(`npm run build`)

**通过条件**:tsup 产出 `dist/cli.js` + `dist/index.js`,无错误。

**常见失败点**:
- `tsup.config.ts` 的 entry 路径错
- 依赖未 install

---

## V3. Unit tests(`npm test`)

**通过条件**:全部 PASS,覆盖率达到 codex 插件水平(transcript / replay / config 各 80%+)

**常见失败点**:
- transcript 解析对边界 case(空文件 / 损坏 JSON 行)处理不当
- replay 的 turn split 算法对单 turn / 多 turn / 含 tool calls / 末尾无 last_assistant_message 等模式覆盖不全

---

## V4. E2E InMemorySpanExporter

**位置**:`tests/e2e/inmemory-span.test.js`(参考 `/tmp/codex-trace-fix-test.js`)

**步骤**:
1. 创建 `InMemorySpanExporter` + `SimpleSpanProcessor` 注册到 NodeTracerProvider
2. 加载 cli.js(触发顶层 GenAI env 注入)
3. 构造 mock SessionState + mock TranscriptData(含 systemInstruction + toolDefinitions)
4. 调 replaySession → forceFlush
5. `exporter.getFinishedSpans()` → 断言

**5 项必须断言**:

| # | 断言 | 对应 Constitution |
|---|---|---|
| 1 | `spans[0].startTime[0]` ≈ 当前 Unix 秒(差不超过 2s) | C2 |
| 2 | LLM span attrs 含 `gen_ai.input.messages` + `gen_ai.output.messages` | C3 |
| 3 | resource attrs 含 `gen_ai.agent.system=<AGENT>` | C4 |
| 4 | `gen_ai.system_instructions` 同时出现在 AGENT 和至少 1 个 LLM span,parsed 为 array | C3 |
| 5 | `gen_ai.tool.definitions` 同上,parsed function 项 name 与 mock 一致 | C3 |

**通过条件**:5/5 PASS。

---

## V5. 真实 ARMS Trace 验证

**前置条件**(用户在 spec review 阶段已提供):
- ARMS endpoint URL
- ARMS license key + project + workspace
- 用户已在测试机器安装好目标 `<AGENT>`

**步骤**:
1. 跑 `<AGENT>-hook install`(走完整安装流程)
2. 写 `~/.<AGENT>/otel-config.json` 配 OTLP endpoint(用户提供的 ARMS endpoint)
3. 在测试机用 `<AGENT>` 跑 1-2 turn 真实对话(如 "list files in /tmp")
4. 等待 ~30 秒 trace flush 到 ARMS
5. 用 `arms-genai-verify` skill:
   - `SearchTraces` 按 service.name + 时间窗找最新 trace
   - `GetTrace` 拉完整 span 树
6. 对照 spec 1.4 必采属性清单,逐项 check 每个 span 的 attrs

**通过条件**:
- ARMS 平台可见对应 trace
- ENTRY → AGENT → STEP → LLM/TOOL 树结构完整
- spec 1.4 列出的所有必采属性在对应 span 都能找到
- token 数据数量级合理(input / output 都 > 0)

**自我修复策略**:
- 找不到 trace → 检查 endpoint / headers / OTLP protocol 配置
- 树结构不对 → 回到 V4 检查 InMemoryExporter 是否同步暴露问题
- 字段缺失 → 检查 replay.ts 是否真的设置了对应字段

---

## 总验收

5 道关全 PASS → 进 PR/CR 创建阶段(`gh pr create --repo alibaba/loongsuite-js-plugins`)。
