#!/usr/bin/env bash
# Shared deployment mechanics. Sourcing this file performs no writes.
set -Eeuo pipefail
TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(realpath "${ESTACK_ROOT:-$TOOL_DIR/..}")"
export ESTACK_ROOT="$ROOT_DIR"
export GIT_OPTIONAL_LOCKS=0
RUNTIME_PATHS=(camillaNodeConfig.json currentConfig.json savedConfigs.dat startupConfig.json
    wiimLoudnessConfig.json wiimLoudnessStatus.json config
    setupFiles/spectrum_preview.yml setupFiles/spectrum_real.yml setupFiles/spectrum_white.yml
    setupFiles/spectrum_preview.yml.bak setupFiles/spectrum_real.yml.bak setupFiles/spectrum_white.yml.bak)
die() { echo "FAIL: $*" >&2; exit 1; }
repo_check() {
    [[ "$(git -C "$ROOT_DIR" rev-parse --show-toplevel)" == "$ROOT_DIR" ]] || die 'Not the repository root'
    node "$TOOL_DIR/pi-inspect.js" clean
}
service_info() {
    local unit
    for unit in camillanode.service camilladsp.service camilladsp2.service estack-wiim-loudness.service \
        $(systemctl list-unit-files --no-legend 2>/dev/null | awk 'tolower($1) ~ /spectrum.*\.service$/ {print $1}'); do
        echo "--- $unit ---"
        systemctl --no-pager --full status -- "$unit" 2>&1 || true
        systemctl --no-pager cat -- "$unit" 2>&1 || true
        systemctl --no-pager -p ExecStart -p FragmentPath -p DropInPaths show -- "$unit" 2>&1 || true
    done
}
runtime_copy() {
    local dest="$1" item
    mkdir -p "$dest"
    for item in "${RUNTIME_PATHS[@]}"; do
        if [[ -e "$ROOT_DIR/$item" || -L "$ROOT_DIR/$item" ]]; then
            [[ -z "$(find "$ROOT_DIR/$item" -type l -print -quit)" ]] || die "Runtime symlink requires manual handling: $item"
            mkdir -p "$dest/$(dirname "$item")"
            cp -a "$ROOT_DIR/$item" "$dest/$item"
        fi
    done
}
runtime_restore() {
    local source="$1" item
    # Only fixed, audited relative paths; absent-at-backup files are removed too.
    for item in "${RUNTIME_PATHS[@]}"; do
        [[ ! -L "$ROOT_DIR/$(dirname "$item")" ]] || die "Symlink parent: $item"
        rm -rf -- "$ROOT_DIR/$item"
        if [[ -e "$source/$item" ]]; then
            mkdir -p "$ROOT_DIR/$(dirname "$item")"
            cp -a "$source/$item" "$ROOT_DIR/$item"
        fi
    done
}
health_wait() {
    local attempt
    for attempt in {1..30}; do
        if node "$TOOL_DIR/pi-inspect.js" health; then return 0; fi
        sleep 1
    done
    systemctl --no-pager --full status camillanode.service >&2 || true
    journalctl -u camillanode.service -n 80 --no-pager >&2 || true
    return 1
}
deployment_lock() {
    # Existing .git is application metadata; no machine/global lock files needed.
    exec 9>"$ROOT_DIR/.git/estack-deploy.lock"
    flock -n 9 || die 'Another deployment/rollback is running'
}
