---
name: Bug Report
about: Report a bug or unexpected behavior
title: '[Bug] '
labels: bug
assignees: ''
---

## Describe the Bug

A clear and concise description of what the bug is.

## Plugin

- [ ] `opentelemetry-instrumentation-claude`
- [ ] `opentelemetry-instrumentation-openclaw`

## Environment

- OS: (e.g. macOS 14.x, Ubuntu 22.04)
- Node.js version: (`node --version`)
- Claude Code version: (`claude --version`) *(if applicable)*
- Plugin version:

## Steps to Reproduce

1. ...
2. ...
3. ...

## Expected Behavior

What did you expect to happen?

## Actual Behavior

What actually happened?

## Logs

Enable debug mode and paste the output:

```bash
# For claude plugin:
CLAUDE_TELEMETRY_DEBUG=1 OTEL_CLAUDE_DEBUG=1 claude "your task"

# For openclaw plugin:
# Set debug: true in openclaw.json plugin config
```

<details>
<summary>Full log output</summary>

```
paste logs here
```

</details>
