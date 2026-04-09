#!/usr/bin/env bash
# install.sh — One-command installation for otel-claude-hook
#
# Steps:
#   1. npm install (install Node dependencies)
#   2. npm install -g . (register otel-claude-hook on PATH)
#   3. Copy intercept.js to ~/.cache/opentelemetry.instrumentation.claude/
#   4. Run otel-claude-hook install (write ~/.claude/settings.json hooks)
#   5. Set up claude alias in shell profiles
#   6. Print success message

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"   # scripts/ → package root
INTERCEPT_DEST="$HOME/.cache/opentelemetry.instrumentation.claude/intercept.js"

# ---------------------------------------------------------------------------
# 语言检测 / Language detection
# ---------------------------------------------------------------------------
detect_lang() {
    if [ -n "${OTEL_CLAUDE_LANG:-}" ]; then echo "$OTEL_CLAUDE_LANG"; return; fi
    for v in "${LANGUAGE:-}" "${LC_ALL:-}" "${LC_MESSAGES:-}" "${LANG:-}"; do
        if echo "$v" | grep -qi "zh"; then echo "zh"; return; fi
    done
    if [ "$(uname)" = "Darwin" ]; then
        local apple_lang
        apple_lang=$(defaults read -g AppleLanguages 2>/dev/null | grep -i "zh" | head -1 || true)
        if [ -n "$apple_lang" ]; then echo "zh"; return; fi
        local apple_locale
        apple_locale=$(defaults read -g AppleLocale 2>/dev/null || true)
        if echo "$apple_locale" | grep -qi "zh"; then echo "zh"; return; fi
    fi
    if [ "$(uname -o 2>/dev/null || true)" = "Msys" ] || [ "$(uname -o 2>/dev/null || true)" = "Cygwin" ]; then
        local locale
        locale=$(reg query "HKCU\\Control Panel\\International" /v LocaleName 2>/dev/null | grep -o "zh[^[:space:]]*" | head -1 || true)
        if [ -n "$locale" ]; then echo "zh"; return; fi
    fi
    echo "en"
}
LANG_MODE=$(detect_lang)

# 双语输出 / Bilingual output helper
msg() {
    local zh="$1"
    local en="$2"
    if [ "$LANG_MODE" = "zh" ]; then
        echo "$zh"
    else
        echo "$en"
    fi
}

# ---------------------------------------------------------------------------

msg "==============================================" \
    "=============================================="
msg " otel-claude-hook — OpenTelemetry for Claude" \
    " otel-claude-hook — OpenTelemetry for Claude"
msg "==============================================" \
    "=============================================="
echo ""

# 1. Install Node.js dependencies
msg "==> 正在安装 Node.js 依赖..." \
    "==> Installing Node.js dependencies..."
cd "$PKG_DIR"
npm install --silent
msg "    ✅ 依赖安装完成" \
    "    ✅ Dependencies installed"
echo ""

# 2. Install package globally so otel-claude-hook is on PATH
#
# Fallback strategy (in order):
#   a) npm install -g .   — copies package into global node_modules (preferred)
#   b) local copy fallback — copies package to ~/.local/lib/ then creates a
#                            wrapper in ~/.local/bin/ pointing to that copy.
#
# NOTE: "npm link" is intentionally NOT used as a fallback.
# npm link creates a symlink from the global bin to the SOURCE directory.
# When install.sh is invoked from remote-install.sh, the source directory is a
# temporary directory that gets deleted after the script exits, leaving a
# dangling symlink and a broken otel-claude-hook command.
msg "==> 正在全局注册 otel-claude-hook..." \
    "==> Registering otel-claude-hook globally..."
if npm install -g . --silent 2>/dev/null; then
    msg "    ✅ 已通过 npm install -g 全局安装" \
        "    ✅ Installed globally via npm install -g"
else
    msg "    ⚠️  全局安装失败，拷贝到本地永久目录..." \
        "    ⚠️  Global install failed; copying to a permanent local directory..."
    LOCAL_LIB="$HOME/.local/lib/otel-claude-hook"
    LOCAL_BIN="$HOME/.local/bin"
    # Copy the entire package to a permanent location (not a symlink)
    rm -rf "$LOCAL_LIB"
    cp -r "$PKG_DIR" "$LOCAL_LIB"
    mkdir -p "$LOCAL_BIN"
    # Create a wrapper that points to the permanent copy
    cat > "$LOCAL_BIN/otel-claude-hook" << WRAPPER
#!/usr/bin/env bash
exec node "$LOCAL_LIB/bin/otel-claude-hook" "\$@"
WRAPPER
    chmod +x "$LOCAL_BIN/otel-claude-hook"
    msg "    ✅ 包已拷贝至 $LOCAL_LIB" \
        "    ✅ Package copied to $LOCAL_LIB"
    msg "    ✅ Wrapper 已安装至 $LOCAL_BIN/otel-claude-hook" \
        "    ✅ Wrapper installed at $LOCAL_BIN/otel-claude-hook"
    msg "       请确认 $LOCAL_BIN 在 PATH 中" \
        "       Make sure $LOCAL_BIN is on your PATH."
fi
echo ""

# 3. Copy intercept.js to cache directory
msg "==> 正在安装 intercept.js..." \
    "==> Installing intercept.js..."
mkdir -p "$(dirname "$INTERCEPT_DEST")"
cp "$PKG_DIR/src/intercept.js" "$INTERCEPT_DEST"
msg "    ✅ intercept.js 已安装至 $INTERCEPT_DEST" \
    "    ✅ intercept.js installed to $INTERCEPT_DEST"
echo ""

# 4. Register hooks in ~/.claude/settings.json + enable built-in telemetry
msg "==> 正在注册 Claude Code Hook 并启用内置遥测..." \
    "==> Registering Claude Code hooks and enabling built-in telemetry..."
otel-claude-hook install --user
echo ""

# 5. Set up claude alias in shell profiles
msg "==> 正在设置 claude 别名..." \
    "==> Setting up claude alias..."
bash "$SCRIPT_DIR/setup-alias.sh"
echo ""

# 6. Done
msg "==============================================" \
    "=============================================="
msg " ✅ 安装完成！" \
    " ✅ Installation complete!"
msg "==============================================" \
    "=============================================="
echo ""

msg "后续步骤：" \
    "Next steps:"
echo ""

msg "1. 配置遥测后端（二选一）：" \
    "1. Configure your telemetry backend (choose one):"
echo ""
msg "   # 任意 OTEL 兼容后端（Sunfire、Jaeger 等）：" \
    "   # Any OTEL-compatible backend (Sunfire, Jaeger, etc.):"
echo "   export OTEL_EXPORTER_OTLP_ENDPOINT='https://your-otlp-endpoint:4318'"
echo "   export OTEL_RESOURCE_ATTRIBUTES='service.name=my-claude-agent'"
echo ""
msg "   export OTEL_METRICS_EXPORTER=otlp" \
    "   export OTEL_METRICS_EXPORTER=otlp"
msg "   export OTEL_METRIC_EXPORT_INTERVAL=20000  # 20秒上报一次" \
    "   export OTEL_METRIC_EXPORT_INTERVAL=20000  # Export metrics every 20s"
echo ""
msg "   # 控制台调试输出（无需后端）：" \
    "   # Console debug output (no backend needed):"
echo "   export CLAUDE_TELEMETRY_DEBUG=1"
echo ""

msg "2. 重新加载 Shell：" \
    "2. Reload your shell:"
echo "   source ~/.bashrc   # or ~/.zshrc"
echo ""

msg "3. 正常使用 claude，Trace 将自动上报。" \
    "3. Use claude as normal — traces will appear in your backend automatically."
echo ""

msg "提示：" \
    "Tips:"
msg "  - 注意：已默认开启 Claude Code 内置 OTel 指标 (CLAUDE_CODE_ENABLE_TELEMETRY=1)" \
    "  - Note: Claude Code built-in OTel metrics enabled by default (CLAUDE_CODE_ENABLE_TELEMETRY=1)"
msg "  - 验证配置：otel-claude-hook check-env" \
    "  - Run 'otel-claude-hook check-env' to verify your configuration"
msg "  - 查看 Hook 配置：otel-claude-hook show-config" \
    "  - Run 'otel-claude-hook show-config' to see the hooks JSON snippet"
msg "  - intercept.js 可捕获原始 LLM API 调用的详细数据" \
    "  - intercept.js captures raw LLM API calls for detailed token-level tracing"
msg "  - 卸载请运行：otel-claude-hook uninstall" \
    "  - To uninstall: otel-claude-hook uninstall"
msg "  - 或执行脚本：bash scripts/uninstall.sh" \
    "  - Or run the script: bash scripts/uninstall.sh"

echo ""
