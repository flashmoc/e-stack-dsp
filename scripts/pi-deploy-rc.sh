#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/pi-common.sh"
[[ "${ESTACK_BRANCH:-}" == release/raspi-rc1 ]] || die 'Explicit ESTACK_BRANCH=release/raspi-rc1 required'
[[ -z "${ESTACK_CHECK_PORT:-}" ]] || die 'Diagnostic port override is not allowed during deployment'
[[ -z "${ESTACK_EXPECTED_SHA:-}" || "${ESTACK_EXPECTED_SHA}" =~ ^[0-9a-f]{40}$ ]] || die 'Expected SHA must be full 40-character lowercase SHA'
repo_check
deployment_lock
bash "$TOOL_DIR/pi-preflight.sh"
REMOTE="$(git -C "$ROOT_DIR" remote get-url origin)"
[[ "$REMOTE" == https://github.com/flashmoc/e-stack-dsp.git ]] || die 'Unexpected origin; review it explicitly before RC deployment'
PREVIOUS="$(git -C "$ROOT_DIR" rev-parse HEAD)"
git -C "$ROOT_DIR" fetch origin "refs/heads/$ESTACK_BRANCH:refs/remotes/origin/$ESTACK_BRANCH"
FETCHED="$(git -C "$ROOT_DIR" rev-parse "refs/remotes/origin/$ESTACK_BRANCH^{commit}")"
printf 'Expected branch: %s\nExpected SHA: %s\nFetched SHA: %s\n' "$ESTACK_BRANCH" "${ESTACK_EXPECTED_SHA:-unpinned; using fetched immutable SHA}" "$FETCHED"
[[ -z "${ESTACK_EXPECTED_SHA:-}" || "$ESTACK_EXPECTED_SHA" == "$FETCHED" ]] || die 'Fetched SHA differs from reviewed SHA'
git -C "$ROOT_DIR" merge-base --is-ancestor e4929159b86690191cdfc51eac35bc21310acf5b "$FETCHED" || die 'RC does not descend from accepted software'
BACKUP="$(bash "$TOOL_DIR/pi-backup.sh")"
printf 'Backup: %s\n' "$BACKUP"
# Execute a stable copy: checkout may replace the currently running scripts.
TOOL_DIR="$BACKUP/toolkit"
failure() {
    echo 'DEPLOYMENT FAILED. Persistent backup retained; no automatic rollback.' >&2
    printf 'Rollback: ESTACK_ROOT=%q bash %q %q --yes\n' "$ROOT_DIR" "$TOOL_DIR/pi-rollback.sh" "$BACKUP" >&2
    systemctl --no-pager --full status camillanode.service >&2 || true
    journalctl -u camillanode.service -n 80 --no-pager >&2 || true
}
trap failure ERR
# Close browser operators first. Stop only CamillaNode to freeze persistence and
# prevent new temporary workflows between the final check and code replacement.
sudo systemctl stop camillanode.service
node "$TOOL_DIR/pi-inspect.js" offline-safety
node "$TOOL_DIR/pi-inspect.js" unchanged "$BACKUP"
ESTACK_ROOT="$ROOT_DIR" ESTACK_BRANCH="$ESTACK_BRANCH" ESTACK_FETCHED_SHA="$FETCHED" \
    ESTACK_UPDATE_CODE_ONLY=1 bash "$TOOL_DIR/pi-update.sh"
[[ "$(git -C "$ROOT_DIR" rev-parse HEAD)" == "$FETCHED" ]]
cd "$ROOT_DIR"
npm ci --omit=dev --no-audit --no-fund
npm run check
sudo systemctl restart camillanode.service
health_wait
bash "$TOOL_DIR/pi-postdeploy-check.sh"
printf '\nPrevious SHA: %s\nDeployed SHA: %s\nBackup: %s\n' "$PREVIOUS" "$(git rev-parse HEAD)" "$BACKUP"
printf 'Rollback: ESTACK_ROOT=%q bash %q %q --yes\n' "$ROOT_DIR" "$TOOL_DIR/pi-rollback.sh" "$BACKUP"
