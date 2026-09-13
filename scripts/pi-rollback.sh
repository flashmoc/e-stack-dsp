#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/pi-common.sh"
[[ $# -ge 1 && $# -le 2 ]] || die 'Usage: pi-rollback.sh BACKUP_DIRECTORY [--yes]'
BACKUP="$(realpath "$1")"
[[ -z "${ESTACK_CHECK_PORT:-}" ]] || die 'Diagnostic port override is not allowed during rollback'
[[ -f "$BACKUP/manifest.json" ]] || die 'Backup manifest missing'
repo_check
deployment_lock
TARGET="$(node "$TOOL_DIR/pi-inspect.js" rollback-target "$BACKUP")"
printf 'Current SHA: %s\nRestore SHA: %s\nBackup: %s\n' "$(git -C "$ROOT_DIR" rev-parse HEAD)" "$TARGET" "$BACKUP"
if [[ "${2:-}" != --yes ]]; then
    read -r -p 'Restore E-Stack DSP code and saved runtime state? Type RESTORE: ' answer
    [[ "$answer" == RESTORE ]] || die 'Cancelled'
fi
node "$TOOL_DIR/pi-inspect.js" service-safety
node "$TOOL_DIR/pi-inspect.js" offline-safety
node "$TOOL_DIR/pi-inspect.js" startup-backup "$BACKUP"
git -C "$ROOT_DIR" bundle verify "$BACKUP/repository.bundle"
git -C "$ROOT_DIR" fetch "$BACKUP/repository.bundle" HEAD
rollback_failure() {
    echo "Rollback failed. Backup intact: $BACKUP. CamillaDSP evidence was not applied." >&2
    systemctl --no-pager --full status -- "$SERVICE_NAME" >&2 || true
    journalctl -u "$SERVICE_NAME" -n 80 --no-pager >&2 || true
}
trap rollback_failure ERR
sudo systemctl stop "$SERVICE_NAME"
node "$TOOL_DIR/pi-inspect.js" offline-safety
cd "$ROOT_DIR"
# Deliberately detach; neither stable nor development branches are moved.
git reset --hard HEAD
git checkout --detach "$TARGET"
runtime_restore "$BACKUP/runtime"
npm ci --omit=dev --no-audit --no-fund
npm run check --if-present
sudo systemctl restart "$SERVICE_NAME"
health_wait
printf 'Rollback complete: %s (detached)\nBackup retained: %s\n' "$(git rev-parse HEAD)" "$BACKUP"
echo 'DSP evidence was not applied; CamillaDSP and ALSA were not changed.'
