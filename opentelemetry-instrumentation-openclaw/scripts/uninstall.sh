#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# openclaw-cms-plugin one-line uninstaller
#
# Usage:
#   curl -fsSL https://<oss-host>/uninstall.sh | bash
#   curl -fsSL https://<oss-host>/uninstall.sh | bash -s -- -y
#   curl -fsSL https://<oss-host>/uninstall.sh | bash -s -- --install-dir /path/to/plugin
#   curl -fsSL https://<oss-host>/uninstall.sh | bash -s -- --keep-metrics
# ---------------------------------------------------------------------------
set -euo pipefail

PLUGIN_NAME="openclaw-cms-plugin"
DIAG_PLUGIN_NAME="diagnostics-otel"
SKIP_CONFIRM=false
INSTALL_DIR=""
KEEP_METRICS=false

# ── Color helpers ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }

# ── Parse arguments ──
while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes)          SKIP_CONFIRM=true;   shift ;;
    --install-dir)
      if [[ $# -lt 2 ]] || [[ "$2" == --* ]]; then
        error "Option --install-dir requires a value"
        exit 1
      fi
      INSTALL_DIR="$2"; shift 2 ;;
    --keep-metrics)    KEEP_METRICS=true;   shift ;;
    *)
      error "Unknown option: $1"
      exit 1
      ;;
  esac
done

# ── Determine plugin directory ──
if [[ -n "$INSTALL_DIR" ]]; then
  TARGET_DIR="$INSTALL_DIR"
elif [[ -n "${OPENCLAW_STATE_DIR:-}" ]] && [[ -d "${OPENCLAW_STATE_DIR}/extensions/${PLUGIN_NAME}" ]]; then
  TARGET_DIR="${OPENCLAW_STATE_DIR}/extensions/${PLUGIN_NAME}"
elif [[ -d "$HOME/.openclaw/extensions/${PLUGIN_NAME}" ]]; then
  TARGET_DIR="$HOME/.openclaw/extensions/${PLUGIN_NAME}"
elif [[ -d "/opt/${PLUGIN_NAME}" ]]; then
  TARGET_DIR="/opt/${PLUGIN_NAME}"
else
  TARGET_DIR=""
fi

# ── Determine openclaw.json path ──
if [[ -n "${OPENCLAW_STATE_DIR:-}" ]] && [[ -f "${OPENCLAW_STATE_DIR}/openclaw.json" ]]; then
  CONFIG_PATH="${OPENCLAW_STATE_DIR}/openclaw.json"
elif [[ -f "$HOME/.openclaw/openclaw.json" ]]; then
  CONFIG_PATH="$HOME/.openclaw/openclaw.json"
else
  CONFIG_PATH=""
fi

# ── Summary ──
echo ""
echo -e "${CYAN}══════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  openclaw-cms-plugin uninstaller${NC}"
echo -e "${CYAN}══════════════════════════════════════════════════${NC}"
echo ""

if [[ -n "$TARGET_DIR" ]] && [[ -d "$TARGET_DIR" ]]; then
  info "Plugin directory:  ${TARGET_DIR}"
else
  warn "Plugin directory not found (already removed or custom path)"
fi

if [[ -n "$CONFIG_PATH" ]]; then
  info "Config file:       ${CONFIG_PATH}"
else
  warn "openclaw.json not found (skipping config cleanup)"
fi

if [[ "$KEEP_METRICS" == true ]]; then
  info "diagnostics-otel:  Will be kept (--keep-metrics)"
else
  info "diagnostics-otel:  Will be disabled"
fi
echo ""

# ── Confirm ──
if [[ "$SKIP_CONFIRM" != true ]]; then
  if [[ -t 0 ]]; then
    read -rp "Proceed with uninstall? [y/N] " answer
  elif [[ -e /dev/tty ]]; then
    read -rp "Proceed with uninstall? [y/N] " answer < /dev/tty
  else
    error "Non-interactive mode detected. Use -y/--yes to skip confirmation."
    exit 1
  fi
  if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
    info "Aborted."
    exit 0
  fi
fi

# ── Clean up openclaw.json ──
if [[ -n "$CONFIG_PATH" ]] && [[ -f "$CONFIG_PATH" ]]; then
  info "Cleaning up config: ${CONFIG_PATH}"

  if ! command -v node &>/dev/null; then
    warn "Node.js not found, skipping config cleanup. Please edit ${CONFIG_PATH} manually."
  else
    node -e "
const fs = require('fs');
const configPath     = process.argv[1];
const pluginName     = process.argv[2];
const keepMetrics    = process.argv[3] === 'true';
const diagPluginName = process.argv[4];

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  process.exit(0);
}

if (!config.plugins) { process.exit(0); }

// ── Remove openclaw-cms-plugin ──
if (Array.isArray(config.plugins.allow)) {
  config.plugins.allow = config.plugins.allow.filter(n => n !== pluginName);
}
if (config.plugins.load && Array.isArray(config.plugins.load.paths)) {
  config.plugins.load.paths = config.plugins.load.paths.filter(p => !p.includes(pluginName));
}
if (config.plugins.entries && config.plugins.entries[pluginName]) {
  delete config.plugins.entries[pluginName];
}

// ── Remove diagnostics-otel (unless --keep-metrics) ──
if (!keepMetrics) {
  if (Array.isArray(config.plugins.allow)) {
    config.plugins.allow = config.plugins.allow.filter(n => n !== diagPluginName);
  }
  if (config.plugins.entries && config.plugins.entries[diagPluginName]) {
    delete config.plugins.entries[diagPluginName];
  }
  if (config.diagnostics && config.diagnostics.otel) {
    config.diagnostics.otel.enabled = false;
    config.diagnostics.otel.metrics = false;
    // Only disable diagnostics.enabled if no other otel signals remain active
    const otel = config.diagnostics.otel;
    const anyOtelActive = otel.traces || otel.logs;
    if (!anyOtelActive) {
      config.diagnostics.enabled = false;
    }
  }
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
" \
    "$CONFIG_PATH" \
    "$PLUGIN_NAME" \
    "$KEEP_METRICS" \
    "$DIAG_PLUGIN_NAME"

    ok "Config cleaned"
  fi
fi

# ── Remove plugin directory ──
if [[ -n "$TARGET_DIR" ]] && [[ -d "$TARGET_DIR" ]]; then
  # Safety: refuse to delete root-level or system directories
  real_target=$(cd "$TARGET_DIR" && pwd)
  if [[ "$real_target" == "/" ]] || [[ "$real_target" == "/usr" ]] || [[ "$real_target" == "/etc" ]] || [[ "$real_target" == "$HOME" ]]; then
    error "Refusing to delete unsafe path: ${real_target}"
    exit 1
  fi
  info "Removing ${TARGET_DIR}..."
  rm -rf "$TARGET_DIR"
  ok "Plugin directory removed"
else
  warn "No plugin directory to remove"
fi

# ── Remove Delta temporality + semconv env vars from shell profiles ──
_remove_block_from_file() {
  local file="$1" marker="$2" marker_end="$3"
  [[ -f "$file" ]] || return
  grep -q "$marker" "$file" 2>/dev/null || return
  sed -i "/^${marker}$/,/^${marker_end}$/d" "$file"
  ok "Removed env block from $file"
}
for _f in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.bash_profile"; do
  _remove_block_from_file "$_f" \
    '# BEGIN openclaw-cms-plugin-delta-temporality' \
    '# END openclaw-cms-plugin-delta-temporality'
  _remove_block_from_file "$_f" \
    '# BEGIN openclaw-cms-plugin-semconv-dialect' \
    '# END openclaw-cms-plugin-semconv-dialect'
done

# ── Restart gateway ──
OPENCLAW_CMD="openclaw"
if command -v "$OPENCLAW_CMD" &>/dev/null; then
  info "Restarting OpenClaw gateway..."
  if $OPENCLAW_CMD gateway restart 2>&1; then
    ok "Gateway restarted"
  else
    warn "Gateway restart failed. Run manually: openclaw gateway restart"
  fi
else
  warn "OpenClaw CLI not found, skipping gateway restart."
fi

# ── Done ──
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✅ openclaw-cms-plugin uninstalled successfully!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
echo ""
if [[ "$KEEP_METRICS" == true ]]; then
  echo "  diagnostics-otel: Kept (metrics still active)"
else
  echo "  diagnostics-otel: Disabled"
fi
echo "  Metric tempo env: Removed from shell profiles"
echo ""
