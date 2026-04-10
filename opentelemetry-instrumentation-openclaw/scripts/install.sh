#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# openclaw-cms-plugin one-line installer
#
# Usage:
#   curl -fsSL https://<oss-host>/install.sh | bash -s -- \
#     --endpoint "https://..." \
#     --x-arms-license-key "xxx" \
#     --x-arms-project "xxx" \
#     --x-cms-workspace "xxx" \
#     --serviceName "my-service"
# ---------------------------------------------------------------------------
set -euo pipefail

PLUGIN_NAME="openclaw-cms-plugin"
DIAG_PLUGIN_NAME="diagnostics-otel"
# ── Replace with your actual OSS URL after uploading ──
DEFAULT_PLUGIN_URL="https://arms-apm-cn-hangzhou-pre.oss-cn-hangzhou.aliyuncs.com/openclaw-cms-plugin/openclaw-cms-plugin.tar.gz"

# ── Defaults ──
ENDPOINT=""
LICENSE_KEY=""
ARMS_PROJECT=""
CMS_WORKSPACE=""
SERVICE_NAME=""
PLUGIN_URL="${DEFAULT_PLUGIN_URL}"
INSTALL_DIR=""
ENABLE_METRICS=true

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
need_value() {
  if [[ $# -lt 2 ]] || [[ "$2" == --* ]]; then
    error "Option $1 requires a value"
    exit 1
  fi
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --endpoint)           need_value "$@"; ENDPOINT="$2";       shift 2 ;;
    --x-arms-license-key) need_value "$@"; LICENSE_KEY="$2";    shift 2 ;;
    --x-arms-project)     need_value "$@"; ARMS_PROJECT="$2";   shift 2 ;;
    --x-cms-workspace)    need_value "$@"; CMS_WORKSPACE="$2";  shift 2 ;;
    --serviceName)        need_value "$@"; SERVICE_NAME="$2";   shift 2 ;;
    --plugin-url)         need_value "$@"; PLUGIN_URL="$2";     shift 2 ;;
    --install-dir)        need_value "$@"; INSTALL_DIR="$2";    shift 2 ;;
    --disable-metrics)    ENABLE_METRICS=false; shift ;;
    *)
      error "Unknown option: $1"
      exit 1
      ;;
  esac
done

# ── Validate required parameters ──
MISSING=()
[[ -z "$ENDPOINT" ]]      && MISSING+=("--endpoint")
[[ -z "$SERVICE_NAME" ]]   && MISSING+=("--serviceName")

if [[ ${#MISSING[@]} -gt 0 ]]; then
  error "Missing required parameters: ${MISSING[*]}"
  echo ""
  echo "Usage:"
  echo "  curl -fsSL https://<host>/install.sh | bash -s -- \\"
  echo "    --endpoint \"https://...\" \\"
  echo "    --serviceName \"my-service\""
  echo ""
  echo "Optional:"
  echo "    --x-arms-license-key \"xxx\" \\"
  echo "    --x-arms-project \"xxx\" \\"
  echo "    --x-cms-workspace \"xxx\""
  exit 1
fi

# ── Check prerequisites ──
info "Checking prerequisites..."

if ! command -v node &>/dev/null; then
  error "Node.js is not installed. Please install Node.js >= 18 first."
  exit 1
fi

NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  error "Node.js >= 18 is required (current: $(node --version))"
  exit 1
fi
ok "Node.js $(node --version)"

if ! command -v npm &>/dev/null; then
  error "npm is not installed."
  exit 1
fi
ok "npm $(npm --version)"

OPENCLAW_CMD="openclaw"
if ! command -v "$OPENCLAW_CMD" &>/dev/null; then
  error "OpenClaw CLI not found. Please install OpenClaw first before installing this plugin."
  exit 1
fi
ok "OpenClaw CLI found"

# ── Check endpoint connectivity ──
info "Checking endpoint connectivity: ${ENDPOINT}"
ENDPOINT_HTTP_CODE=$(curl -o /dev/null -s -w "%{http_code}" "$ENDPOINT" -m 10 2>/dev/null || echo "000")
if [[ "$ENDPOINT_HTTP_CODE" == "000" ]]; then
  if echo "$ENDPOINT" | grep -q -- '-intranet\.'; then
    error "Endpoint is unreachable (HTTP code: 000)."
    error "The endpoint appears to be an intranet address."
    error "Please go to the CMS 2.0 console → Integration Center to obtain the public endpoint, then re-run the install command."
    exit 1
  else
    error "Endpoint is unreachable (HTTP code: 000)."
    error "Please check your network connectivity to: ${ENDPOINT}"
    error "Data will not be reported if the endpoint is not reachable."
    exit 1
  fi
else
  ok "Endpoint reachable (HTTP ${ENDPOINT_HTTP_CODE})"
fi

# ── Determine install directory ──
if [[ -n "$INSTALL_DIR" ]]; then
  TARGET_DIR="$INSTALL_DIR"
elif [[ -n "${OPENCLAW_STATE_DIR:-}" ]] && [[ -d "$OPENCLAW_STATE_DIR" ]]; then
  TARGET_DIR="${OPENCLAW_STATE_DIR}/extensions/${PLUGIN_NAME}"
elif [[ -d "$HOME/.openclaw" ]]; then
  TARGET_DIR="$HOME/.openclaw/extensions/${PLUGIN_NAME}"
else
  TARGET_DIR="/opt/${PLUGIN_NAME}"
fi

info "Install directory: ${TARGET_DIR}"

# ── Clean previous installation ──
if [[ -d "$TARGET_DIR" ]]; then
  if [[ -z "$(ls -A "$TARGET_DIR" 2>/dev/null)" ]]; then
    info "Target directory exists but is empty, skipping cleanup."
  elif [[ -f "$TARGET_DIR/package.json" ]] || [[ -f "$TARGET_DIR/openclaw.plugin.json" ]]; then
    info "Removing previous installation..."
    rm -rf "$TARGET_DIR"
  else
    error "Target directory exists but does not look like a plugin installation: ${TARGET_DIR}"
    error "Expected package.json or openclaw.plugin.json inside the directory."
    error "Please verify --install-dir or remove the directory manually."
    exit 1
  fi
fi
mkdir -p "$TARGET_DIR"

# ── Download and extract ──
info "Downloading plugin from ${PLUGIN_URL}..."
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

if command -v curl &>/dev/null; then
  curl -fsSL -H "Cache-Control: no-cache" "$PLUGIN_URL" -o "$TMP_DIR/plugin.tar.gz"
elif command -v wget &>/dev/null; then
  wget -q --no-cache "$PLUGIN_URL" -O "$TMP_DIR/plugin.tar.gz"
else
  error "Neither curl nor wget is available."
  exit 1
fi
ok "Downloaded"

info "Extracting to ${TARGET_DIR}..."
tar -xzf "$TMP_DIR/plugin.tar.gz" -C "$TMP_DIR"
if [[ -d "$TMP_DIR/${PLUGIN_NAME}" ]]; then
  cp -rf "$TMP_DIR/${PLUGIN_NAME}/." "$TARGET_DIR/"
else
  cp -rf "$TMP_DIR/." "$TARGET_DIR/"
fi
ok "Extracted"

# ── Install npm dependencies for openclaw-cms-plugin ──
info "Installing npm dependencies (production only)..."
cd "$TARGET_DIR"
if ! npm install --omit=dev --ignore-scripts 2>&1; then
  error "npm install failed in ${TARGET_DIR}"
  exit 1
fi
ok "Dependencies installed"

# ══════════════════════════════════════════════════════
# ── diagnostics-otel: locate, install deps, configure ──
# ══════════════════════════════════════════════════════
DIAG_OTEL_DIR=""
DIAG_OTEL_STATUS="skipped"

if [[ "$ENABLE_METRICS" == true ]]; then
  info "Locating ${DIAG_PLUGIN_NAME} extension..."

  find_diag_otel() {
    local candidate="$1"
    if [[ -d "$candidate" ]] && [[ -f "$candidate/package.json" ]]; then
      DIAG_OTEL_DIR="$candidate"
      return 0
    fi
    return 1
  }

  # 1) OPENCLAW_BUNDLED_PLUGINS_DIR env
  if [[ -n "${OPENCLAW_BUNDLED_PLUGINS_DIR:-}" ]]; then
    find_diag_otel "${OPENCLAW_BUNDLED_PLUGINS_DIR}/${DIAG_PLUGIN_NAME}" || true
  fi

  # 2) Sibling of openclaw executable
  if [[ -z "$DIAG_OTEL_DIR" ]] && command -v openclaw &>/dev/null; then
    OPENCLAW_BIN=$(command -v openclaw)
    # macOS readlink has no -f; use realpath or fall back to the raw path
    OPENCLAW_BIN_REAL=$(realpath "$OPENCLAW_BIN" 2>/dev/null || readlink -f "$OPENCLAW_BIN" 2>/dev/null || echo "$OPENCLAW_BIN")
    OPENCLAW_BIN_DIR=$(dirname "$OPENCLAW_BIN_REAL")
    find_diag_otel "${OPENCLAW_BIN_DIR}/extensions/${DIAG_PLUGIN_NAME}" || true
    # Also check parent dir (npm global: .../bin/../lib/...)
    if [[ -z "$DIAG_OTEL_DIR" ]]; then
      OPENCLAW_PARENT=$(dirname "$OPENCLAW_BIN_DIR")
      find_diag_otel "${OPENCLAW_PARENT}/extensions/${DIAG_PLUGIN_NAME}" || true
      find_diag_otel "${OPENCLAW_PARENT}/lib/node_modules/openclaw/extensions/${DIAG_PLUGIN_NAME}" || true
    fi
  fi

  # 3) npm global root
  if [[ -z "$DIAG_OTEL_DIR" ]] && command -v npm &>/dev/null; then
    NPM_GLOBAL_ROOT=$(npm root -g 2>/dev/null || true)
    if [[ -n "$NPM_GLOBAL_ROOT" ]]; then
      find_diag_otel "${NPM_GLOBAL_ROOT}/openclaw/extensions/${DIAG_PLUGIN_NAME}" || true
    fi
  fi

  # 4) OPENCLAW_STATE_DIR / ~/.openclaw
  if [[ -z "$DIAG_OTEL_DIR" ]]; then
    if [[ -n "${OPENCLAW_STATE_DIR:-}" ]]; then
      find_diag_otel "${OPENCLAW_STATE_DIR}/extensions/${DIAG_PLUGIN_NAME}" || true
    fi
    if [[ -z "$DIAG_OTEL_DIR" ]]; then
      find_diag_otel "$HOME/.openclaw/extensions/${DIAG_PLUGIN_NAME}" || true
    fi
  fi

  if [[ -n "$DIAG_OTEL_DIR" ]]; then
    ok "Found ${DIAG_PLUGIN_NAME} at: ${DIAG_OTEL_DIR}"

    # Install dependencies if node_modules is missing
    if [[ ! -d "${DIAG_OTEL_DIR}/node_modules" ]]; then
      info "Installing ${DIAG_PLUGIN_NAME} dependencies (first-time setup)..."
      if ! (cd "$DIAG_OTEL_DIR" && npm install --omit=dev --ignore-scripts 2>&1); then
        warn "${DIAG_PLUGIN_NAME} npm install failed. You may need to install manually: cd ${DIAG_OTEL_DIR} && npm install --omit=dev"
        DIAG_OTEL_STATUS="npm_failed"
      else
        ok "${DIAG_PLUGIN_NAME} dependencies installed"
        DIAG_OTEL_STATUS="fresh_install"
      fi
    else
      ok "${DIAG_PLUGIN_NAME} dependencies already present"
      DIAG_OTEL_STATUS="already_installed"
    fi
  else
    warn "${DIAG_PLUGIN_NAME} not found. Metrics configuration will be written but the plugin may not load until OpenClaw is properly installed."
    DIAG_OTEL_STATUS="not_found"
  fi
fi

# ── Determine openclaw.json path ──
if [[ -n "${OPENCLAW_STATE_DIR:-}" ]]; then
  CONFIG_PATH="${OPENCLAW_STATE_DIR}/openclaw.json"
elif [[ -f "$HOME/.openclaw/openclaw.json" ]]; then
  CONFIG_PATH="$HOME/.openclaw/openclaw.json"
else
  CONFIG_PATH="$HOME/.openclaw/openclaw.json"
  mkdir -p "$(dirname "$CONFIG_PATH")"
fi

info "Updating config: ${CONFIG_PATH}"

# ── Update openclaw.json using inline Node.js ──
DIAG_CHANGES=$(node -e "
const fs = require('fs');
const configPath     = process.argv[1];
const pluginName     = process.argv[2];
const installDir     = process.argv[3];
const endpoint       = process.argv[4];
const licenseKey     = process.argv[5];
const armsProject    = process.argv[6];
const cmsWorkspace   = process.argv[7];
const serviceName    = process.argv[8];
const enableMetrics  = process.argv[9] === 'true';
const diagPluginName = process.argv[10];

let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}

if (!config.plugins) config.plugins = {};

// ── openclaw-cms-plugin: plugins.allow ──
if (!Array.isArray(config.plugins.allow)) config.plugins.allow = [];
if (!config.plugins.allow.includes(pluginName)) {
  config.plugins.allow.push(pluginName);
}

// ── openclaw-cms-plugin: plugins.load.paths ──
if (!config.plugins.load) config.plugins.load = {};
if (!Array.isArray(config.plugins.load.paths)) config.plugins.load.paths = [];
const paths = config.plugins.load.paths;
const idx = paths.findIndex(p => p.includes(pluginName));
if (idx >= 0) paths[idx] = installDir;
else paths.push(installDir);

// ── openclaw-cms-plugin: plugins.entries ──
if (!config.plugins.entries) config.plugins.entries = {};
const pluginHeaders = {};
if (licenseKey) pluginHeaders['x-arms-license-key'] = licenseKey;
if (armsProject) pluginHeaders['x-arms-project'] = armsProject;
if (cmsWorkspace) pluginHeaders['x-cms-workspace'] = cmsWorkspace;
config.plugins.entries[pluginName] = {
  enabled: true,
  config: {
    endpoint,
    headers: pluginHeaders,
    serviceName
  }
};

// ── diagnostics-otel ──
const diagChanges = [];
if (enableMetrics) {
  // plugins.allow
  if (!config.plugins.allow.includes(diagPluginName)) {
    config.plugins.allow.push(diagPluginName);
    diagChanges.push('added to plugins.allow');
  }

  // plugins.entries
  const existingEntry = config.plugins.entries[diagPluginName];
  if (existingEntry) {
    if (!existingEntry.enabled) {
      existingEntry.enabled = true;
      diagChanges.push('enabled in plugins.entries');
    }
  } else {
    config.plugins.entries[diagPluginName] = { enabled: true };
    diagChanges.push('added to plugins.entries');
  }

  // diagnostics section
  if (!config.diagnostics) config.diagnostics = {};
  const prevDiagEnabled = config.diagnostics.enabled;
  config.diagnostics.enabled = true;
  if (!prevDiagEnabled) diagChanges.push('diagnostics.enabled -> true');

  if (!config.diagnostics.otel) config.diagnostics.otel = {};
  const otel = config.diagnostics.otel;

  const prevOtelEnabled = otel.enabled;
  otel.enabled = true;
  if (!prevOtelEnabled) diagChanges.push('diagnostics.otel.enabled -> true');

  // endpoint & headers: always update to match ARMS config
  const prevEndpoint = otel.endpoint;
  otel.endpoint = endpoint;
  if (prevEndpoint && prevEndpoint !== endpoint) diagChanges.push('diagnostics.otel.endpoint updated');

  if (!otel.protocol) otel.protocol = 'http/protobuf';

  const prevHeaders = JSON.stringify(otel.headers || {});
  const diagHeaders = {};
  if (licenseKey) diagHeaders['x-arms-license-key'] = licenseKey;
  if (armsProject) diagHeaders['x-arms-project'] = armsProject;
  if (cmsWorkspace) diagHeaders['x-cms-workspace'] = cmsWorkspace;
  otel.headers = diagHeaders;
  if (prevHeaders !== '{}' && prevHeaders !== JSON.stringify(otel.headers)) {
    diagChanges.push('diagnostics.otel.headers updated');
  }

  const prevServiceName = otel.serviceName;
  otel.serviceName = serviceName;
  if (prevServiceName && prevServiceName !== serviceName) diagChanges.push('diagnostics.otel.serviceName updated');

  // metrics: always enable
  const prevMetrics = otel.metrics;
  otel.metrics = true;
  if (prevMetrics === false) diagChanges.push('diagnostics.otel.metrics -> true');

  // traces & logs: only set defaults if not previously configured
  if (otel.traces === undefined) otel.traces = false;
  if (otel.logs === undefined) otel.logs = false;

  if (diagChanges.length === 0) diagChanges.push('no changes needed');
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
process.stdout.write(diagChanges.join('|'));
" \
  "$CONFIG_PATH" \
  "$PLUGIN_NAME" \
  "$TARGET_DIR" \
  "$ENDPOINT" \
  "$LICENSE_KEY" \
  "$ARMS_PROJECT" \
  "$CMS_WORKSPACE" \
  "$SERVICE_NAME" \
  "$ENABLE_METRICS" \
  "$DIAG_PLUGIN_NAME"
)

ok "Config updated"

# ── Restart gateway ──
info "Restarting OpenClaw gateway..."
if $OPENCLAW_CMD gateway restart 2>&1; then
  ok "Gateway restarted"
else
  echo ""
  echo -e "${YELLOW}  ⚠  Gateway restart failed.${NC}"
  echo -e "     Please restart manually: ${CYAN}openclaw gateway restart${NC}"
  echo ""
  echo -e "     If the issue persists, run: ${RED}openclaw doctor${NC}"
  echo -e "     This command will diagnose and report common configuration issues."
  echo ""
fi

# ── Summary ──
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✅ openclaw-cms-plugin installed successfully!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
echo ""
echo "  Install dir:   ${TARGET_DIR}"
echo "  Config file:   ${CONFIG_PATH}"
echo "  Endpoint:      ${ENDPOINT}"
echo "  Service name:  ${SERVICE_NAME}"
echo ""

if [[ "$ENABLE_METRICS" == true ]]; then
  echo -e "${CYAN}  ── diagnostics-otel (metrics) ──${NC}"
  case "$DIAG_OTEL_STATUS" in
    fresh_install)
      echo -e "  Status:        ${GREEN}Newly installed${NC} (npm dependencies installed)"
      echo "  Location:      ${DIAG_OTEL_DIR}"
      ;;
    already_installed)
      echo -e "  Status:        ${GREEN}Already installed${NC}"
      echo "  Location:      ${DIAG_OTEL_DIR}"
      ;;
    npm_failed)
      echo -e "  Status:        ${YELLOW}Dependencies install failed${NC}"
      echo "  Location:      ${DIAG_OTEL_DIR}"
      echo "                 Please run manually: cd ${DIAG_OTEL_DIR} && npm install --omit=dev"
      ;;
    not_found)
      echo -e "  Status:        ${YELLOW}Plugin directory not found${NC}"
      echo "                 Config written; will activate when OpenClaw is installed."
      ;;
  esac

  # Show config changes
  if [[ -n "$DIAG_CHANGES" ]] && [[ "$DIAG_CHANGES" != "no changes needed" ]]; then
    echo -e "  Config changes: ${YELLOW}${DIAG_CHANGES//|/, }${NC}"
  else
    echo -e "  Config changes: ${GREEN}No changes needed (already configured)${NC}"
  fi

  # Warn about traces conflict
  CURRENT_TRACES=$(node -e "
    try {
      const c = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
      process.stdout.write(String(c.diagnostics?.otel?.traces ?? false));
    } catch { process.stdout.write('false'); }
  " "$CONFIG_PATH")
  if [[ "$CURRENT_TRACES" == "true" ]]; then
    echo ""
    echo -e "  ${YELLOW}⚠ diagnostics.otel.traces is enabled.${NC}"
    echo -e "  ${YELLOW}  openclaw-cms-plugin already handles trace reporting to ARMS.${NC}"
    echo -e "  ${YELLOW}  Having both enabled may cause duplicate traces.${NC}"
  fi
  echo ""
else
  echo "  Metrics:       Skipped (--disable-metrics)"
  echo ""
fi
