#!/usr/bin/env bash
# install.sh — One-command installer for opentelemetry-instrumentation-opencode
#
# Usage:
#   bash install.sh [options]
#
# Options:
#   --endpoint <url>         OTLP exporter endpoint
#   --headers <k=v,k=v>      OTLP headers (comma-separated key=value)
#   --service-name <name>    Service name (written to OTEL_RESOURCE_ATTRIBUTES)
#   --debug                  Enable debug mode (console output, no backend needed)
#   --lang zh|en             Force output language

set -euo pipefail

PKG_NAME="@loongsuite/opentelemetry-instrumentation-opencode"
MARKER_BEGIN="# BEGIN opentelemetry-instrumentation-opencode"
MARKER_END="# END opentelemetry-instrumentation-opencode"

# ---------------------------------------------------------------------------
# 参数解析 / Argument parsing
# ---------------------------------------------------------------------------
ENDPOINT=""
HEADERS=""
SERVICE_NAME=""
DEBUG_MODE="false"
FORCE_LANG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --endpoint)   ENDPOINT="$2"; shift 2 ;;
    --endpoint=*) ENDPOINT="${1#--endpoint=}"; shift ;;
    --headers)    HEADERS="$2"; shift 2 ;;
    --headers=*)  HEADERS="${1#--headers=}"; shift ;;
    --service-name) SERVICE_NAME="$2"; shift 2 ;;
    --service-name=*) SERVICE_NAME="${1#--service-name=}"; shift ;;
    --debug)      DEBUG_MODE="true"; shift ;;
    --lang)       FORCE_LANG="$2"; shift 2 ;;
    --lang=*)     FORCE_LANG="${1#--lang=}"; shift ;;
    -h|--help)
      echo "Usage: bash install.sh [--endpoint <url>] [--headers <k=v>] [--service-name <name>] [--debug]"
      exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# 语言检测 / Language detection
# ---------------------------------------------------------------------------
detect_lang() {
    if [ -n "${FORCE_LANG:-}" ]; then echo "$FORCE_LANG"; return; fi
    for v in "${LANGUAGE:-}" "${LC_ALL:-}" "${LC_MESSAGES:-}" "${LANG:-}"; do
        if echo "$v" | grep -qi "zh"; then echo "zh"; return; fi
    done
    if [ "$(uname)" = "Darwin" ]; then
        local al
        al=$(defaults read -g AppleLanguages 2>/dev/null | grep -i "zh" | head -1 || true)
        if [ -n "$al" ]; then echo "zh"; return; fi
        local aloc
        aloc=$(defaults read -g AppleLocale 2>/dev/null || true)
        if echo "$aloc" | grep -qi "zh"; then echo "zh"; return; fi
    fi
    echo "en"
}
LANG_MODE=$(detect_lang)

msg() {
    local zh="$1"
    local en="$2"
    if [ "$LANG_MODE" = "zh" ]; then echo "$zh"; else echo "$en"; fi
}

# ---------------------------------------------------------------------------

msg "================================================" \
    "================================================"
msg " OpenTelemetry for OpenCode — 安装" \
    " OpenTelemetry for OpenCode — Install"
msg "================================================" \
    "================================================"
echo ""

# ---------------------------------------------------------------------------
# 1. 检查 opencode 是否安装 / Check opencode is installed
# ---------------------------------------------------------------------------
msg "==> 检查 opencode..." \
    "==> Checking opencode..."
if ! command -v opencode &>/dev/null; then
    msg "    ⚠️  未检测到 opencode，请先安装：" \
        "    ⚠️  opencode not found. Install it first:"
    echo "       npm install -g @opencode-ai/cli"
    echo "       # or: https://opencode.ai/docs/installation"
    echo ""
    msg "    （继续安装 OTel 插件...）" \
        "    (Continuing with OTel plugin installation...)"
else
    OPENCODE_VER=$(opencode --version 2>/dev/null || echo "unknown")
    msg "    ✅ opencode 已安装 (${OPENCODE_VER})" \
        "    ✅ opencode detected (${OPENCODE_VER})"
fi
echo ""

# ---------------------------------------------------------------------------
# 2. 全局安装 npm 包 / Install npm package globally
# ---------------------------------------------------------------------------
msg "==> 正在全局安装 ${PKG_NAME}..." \
    "==> Installing ${PKG_NAME} globally..."

# 本地包目录（脚本在 scripts/ 下，包根目录在上级）/ Local package root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

install_ok=false

# 优先尝试 npm registry，失败时尝试本地目录安装
# Try npm registry first; fall back to local directory install
if npm install -g "${PKG_NAME}" --silent 2>/tmp/npm-install-opencode-err.log; then
    msg "    ✅ npm install -g（registry）成功" \
        "    ✅ Installed from npm registry"
    install_ok=true
elif [ -f "${PKG_DIR}/package.json" ] && npm install -g "${PKG_DIR}" --silent 2>/tmp/npm-install-opencode-err.log; then
    msg "    ✅ npm install -g（本地目录）成功" \
        "    ✅ Installed from local directory"
    install_ok=true
else
    if grep -qi "EACCES\|permission denied" /tmp/npm-install-opencode-err.log 2>/dev/null; then
        msg "    ❌ 安装失败：Node.js 目录权限不足" \
            "    ❌ Install failed: permission denied"
        echo ""
        msg "    💡 修复方案（任选其一）：" \
            "    💡 Fix options (choose one):"
        echo "       curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash"
        echo "       nvm install --lts && nvm use --lts"
        echo ""
        msg "    或配置 npm prefix（无需 sudo）：" \
            "    Or configure npm prefix (no sudo):"
        echo '       npm config set prefix "$HOME/.local"'
        echo '       export PATH="$HOME/.local/bin:$PATH"'
    else
        msg "    ❌ 安装失败，详情：" \
            "    ❌ Install failed. Details:"
        cat /tmp/npm-install-opencode-err.log
    fi
    echo ""
    exit 1
fi
echo ""

# ---------------------------------------------------------------------------
# 3. Sunfire 自动检测 / Sunfire endpoint auto-detection
# ---------------------------------------------------------------------------
if [ -n "$ENDPOINT" ] && echo "$ENDPOINT" | grep -qi "sunfire"; then
    if [ -z "${LOONGSUITE_SEMCONV_DIALECT_NAME:-}" ]; then
        LOONGSUITE_SEMCONV_DIALECT_NAME="ALIBABA_GROUP"
        msg "    💡 检测到 Sunfire 端点，自动设置 LOONGSUITE_SEMCONV_DIALECT_NAME=ALIBABA_GROUP" \
            "    💡 Sunfire endpoint detected — auto-setting LOONGSUITE_SEMCONV_DIALECT_NAME=ALIBABA_GROUP"
    fi
fi

# ---------------------------------------------------------------------------
# 4. 写入 shell profile / Write env block to shell profiles
# ---------------------------------------------------------------------------
msg "==> 写入环境变量到 shell 配置文件..." \
    "==> Writing environment variables to shell profiles..."

build_env_block() {
    echo ""
    echo "${MARKER_BEGIN}"
    if [ "$DEBUG_MODE" = "true" ]; then
        echo "export CLAUDE_TELEMETRY_DEBUG=1"
    elif [ -n "$ENDPOINT" ]; then
        echo "export OTEL_EXPORTER_OTLP_ENDPOINT=\"${ENDPOINT}\""
    fi
    if [ -n "$HEADERS" ]; then
        echo "export OTEL_EXPORTER_OTLP_HEADERS=\"${HEADERS}\""
    fi
    if [ -n "$SERVICE_NAME" ]; then
        echo "export OTEL_RESOURCE_ATTRIBUTES=\"service.name=${SERVICE_NAME}\""
    fi
    echo "export OTEL_LOGS_EXPORTER=otlp"
    if [ -n "${LOONGSUITE_SEMCONV_DIALECT_NAME:-}" ]; then
        echo "export LOONGSUITE_SEMCONV_DIALECT_NAME=\"${LOONGSUITE_SEMCONV_DIALECT_NAME}\""
    fi
    echo "${MARKER_END}"
}

write_env_to_profile() {
    local file="$1"
    [ -f "$file" ] || return 0
    # Remove existing block first
    if grep -q "${MARKER_BEGIN}" "$file" 2>/dev/null; then
        local tmp
        tmp=$(mktemp)
        sed "/^${MARKER_BEGIN}$/,/^${MARKER_END}$/d" "$file" > "$tmp" && mv "$tmp" "$file"
    fi
    build_env_block >> "$file"
    msg "    ✅ 已写入 ${file}" \
        "    ✅ Written to ${file}"
}

write_env_to_profile "$HOME/.bashrc"       || true
write_env_to_profile "$HOME/.zshrc"        || true
write_env_to_profile "$HOME/.bash_profile" || true
echo ""

# ---------------------------------------------------------------------------
# 5. 完成 / Done
# ---------------------------------------------------------------------------
msg "================================================" \
    "================================================"
msg " ✅ 安装完成！" \
    " ✅ Installation complete!"
msg "================================================" \
    "================================================"
echo ""

msg "后续步骤：" \
    "Next steps:"
echo ""
msg "1. 重新加载 shell 配置：" \
    "1. Reload your shell config:"
echo "   source ~/.bashrc   # or ~/.zshrc"
echo ""

if [ -z "$ENDPOINT" ] && [ "$DEBUG_MODE" = "false" ]; then
    msg "2. 配置遥测后端（二选一）：" \
        "2. Configure telemetry backend (choose one):"
    echo ""
    msg "   # 任意 OTLP 兼容后端（Sunfire、Jaeger 等）：" \
        "   # Any OTLP-compatible backend (Sunfire, Jaeger, etc.):"
    echo "   export OTEL_EXPORTER_OTLP_ENDPOINT='https://your-endpoint:4318'"
    echo "   export OTEL_EXPORTER_OTLP_HEADERS='authorization=Bearer <token>'"
    echo ""
    msg "   # 控制台调试（无需后端）：" \
        "   # Console debug (no backend needed):"
    echo "   export CLAUDE_TELEMETRY_DEBUG=1"
    echo ""
    msg "3. 启动 opencode：" \
        "3. Start opencode:"
fi

echo "   opencode"
echo ""
msg "卸载：bash scripts/uninstall.sh" \
    "To uninstall: bash scripts/uninstall.sh"
echo ""
