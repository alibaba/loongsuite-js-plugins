#!/usr/bin/env bash
# setup-temporality.sh — Add or remove the OTLP metrics Delta temporality env var
# from shell profiles. Called by install.sh and uninstall.sh.
#
# Usage:
#   bash setup-temporality.sh --install   # write env var to shell profiles
#   bash setup-temporality.sh --remove    # remove env var from shell profiles

set -euo pipefail

DELTA_ENV_LINE='export OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta'
DELTA_MARKER='# BEGIN openclaw-cms-plugin-delta-temporality'
DELTA_MARKER_END='# END openclaw-cms-plugin-delta-temporality'

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

info() { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()   { echo -e "${GREEN}[OK]${NC}    $*"; }
error(){ echo -e "${RED}[ERROR]${NC} $*" >&2; }

MODE="${1:-}"
if [[ "$MODE" != "--install" && "$MODE" != "--remove" ]]; then
  error "Usage: $0 --install | --remove"
  exit 1
fi

# ── Install: write env var block to each profile ──
install_to_file() {
  local file="$1"
  [[ -f "$file" ]] || return
  if grep -q "$DELTA_MARKER" "$file" 2>/dev/null; then
    info "Already present in $file (skipped)"
    return
  fi
  cat >> "$file" << BLOCK

${DELTA_MARKER}
${DELTA_ENV_LINE}
${DELTA_MARKER_END}
BLOCK
  ok "Written to $file"
}

# ── Remove: delete env var block from each profile ──
remove_from_file() {
  local file="$1"
  [[ -f "$file" ]] || return
  if ! grep -q "$DELTA_MARKER" "$file" 2>/dev/null; then
    return
  fi
  sed -i "/^${DELTA_MARKER}$/,/^${DELTA_MARKER_END}$/d" "$file"
  ok "Removed from $file"
}

PROFILES=("$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.bash_profile")

if [[ "$MODE" == "--install" ]]; then
  for f in "${PROFILES[@]}"; do install_to_file "$f"; done
else
  for f in "${PROFILES[@]}"; do remove_from_file "$f"; done
  echo ""
  info "Please reload your shell: source ~/.bashrc  # or ~/.zshrc"
fi
