# Specs

本目录存放 spec-kit 驱动的开发任务。每个任务一个独立子目录。

## 编号约定

```
specs/
├── 001-platform-base/                 # 平台基础设施(预留)
├── 1xx-instrumentation-<AGENT>/       # 类型 A:新 agent 的 OTel 插件
│   ├── spec.md                        # 用户 review 的规格(从 .specify/templates/otel-plugin/spec-template.md 派生)
│   ├── plan.md                        # 实施计划
│   ├── tasks.md                       # 任务清单(每条带 status: pending / in_progress / done)
│   ├── decisions.md                   # 自动决策日志(便于审计)
│   └── state.json                     # 单文件权威状态机(含 phase / current_task / retry_budget / verification / pr)
└── 2xx-xxx/                           # 其他类型(预留)
```

**关于 state.json**:它是单文件权威。verification 各 gate 结果(typecheck/build/unit/e2e/arms)+ PR 元数据(url/number/state/commit/head/base)都嵌入 `state.json`,无需独立的 `verification.json` / `pr.json`(早期模板曾要求这两个文件,首例实施[`100-instrumentation-qodercli`](100-instrumentation-qodercli/)证明分文件冗余且易不一致;已合并到 state.json)。完整 schema 见 [`auto-dev/skills/shared/state-machine.md`](https://gitlab.alibaba-inc.com/fangxiu/auto-dev/-/blob/main/skills/shared/state-machine.md)。

`<AGENT>` 用目标 agent 短名:`gemini` / `aider` / 等。

编号从 100 起步,每个新 agent 顺延 +1(101 / 102 / 103 ...)。已落地的 claude / codex 不需要回填 spec(它们早于本流程)。

## 工作流

由 `auto-dev-otel-plugin` skill 驱动(参见 `auto-dev/skills/auto-dev-otel-plugin/SKILL.md`)。用户输入:
```
/auto-dev-otel-plugin <开发背景描述>
```

skill 会:
1. 分配新编号,创建 `specs/1xx-instrumentation-<agent>/` 目录
2. 读 `.specify/templates/otel-plugin/spec-template.md` 模板
3. 询问必填字段(目标 agent / hook 机制 / ARMS endpoint 等)
4. 产出 `spec.md` 让用户 review
5. review 通过后,自驱动完成 plan / tasks / implement / verify / PR

## 模板与宪法

- 模板:`.specify/templates/otel-plugin/{spec,plan,tasks,verification-checklist}-template.md`
- 通用模板:`.specify/templates/{spec,plan,tasks,checklist}-template.md`(spec-kit 标准)
- 宪法:`.specify/memory/constitution.md`(C1-C10 硬约束,review 阶段强制对齐)
