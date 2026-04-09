# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅ Yes    |

## Reporting a Vulnerability

**Please do NOT report security vulnerabilities via public GitHub Issues.**

If you discover a security vulnerability in this project, please report it responsibly:

1. **GitHub Private Vulnerability Reporting** (preferred):
   Use [GitHub's private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability) on this repository.

2. **Email**: Send details to the maintainers via the contact listed in the repository's GitHub profile.

Please include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested mitigations

We will acknowledge receipt within **48 hours** and aim to provide a fix or mitigation within **14 days** for critical issues.

## Scope

This policy covers:

- `opentelemetry-instrumentation-claude` — Hook mechanism, intercept.js, state file handling
- `opentelemetry-instrumentation-openclaw` — Plugin activation, span export, config parsing

## Out of Scope

- Vulnerabilities in third-party dependencies (please report directly to them)
- Issues in Claude Code or OpenClaw themselves
- Theoretical risks without a concrete exploit path
