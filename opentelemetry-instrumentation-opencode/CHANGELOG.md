# Changelog

本文档记录 `@loongsuite/opentelemetry-instrumentation-opencode` 的重要变更。  
格式遵循 [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.5.0] - 2026-04-15

### 破坏性变更

- **包名**：由 `@ali/opencode-plugin-otel` 更名为 `@loongsuite/opentelemetry-instrumentation-opencode`。依赖与安装方式需同步更新。
- **发布配置**：移除 `publishConfig.registry`（原指向阿里云内网 AnPM）。发布到 npm 或私有 registry 时请在项目或 CI 中自行配置 registry。

### 变更

- **`package.json` 元数据**：补充 `description`、`license`、`keywords`、`homepage`、`bugs`，以及 `repository.directory`（指向本 monorepo 子目录）。
- **OpenCode 应用日志**：`client.app.log` 的 `service` 字段由 `loongsuite-instrumentation-opencode` 改为 `loongsuite/opentelemetry-instrumentation-opencode`，与新的包标识一致。

### 新增

- 脚本：`npm run test`（底层为 `bun test`），与现有 `npm run typecheck` 一并用于本地校验。

### 迁移说明

从旧包迁移时：

1. 将依赖中的 `@ali/opencode-plugin-otel` 替换为 `@loongsuite/opentelemetry-instrumentation-opencode`（版本号请使用 `0.5.0` 或更高）。
2. 若曾依赖内网 registry 安装旧包，请改为在 `.npmrc` 或 CI 中配置可访问的 npm 源后再安装。
3. 若你在日志或监控中按 `service` 字段过滤 OpenCode 插件日志，请将过滤条件更新为 `loongsuite/opentelemetry-instrumentation-opencode`。
