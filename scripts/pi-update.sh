#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="${ESTACK_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BRANCH="${ESTACK_BRANCH:-camilladsp-4.1-estack}"
REPO="${ESTACK_REPO:-https://github.com/flashmoc/e-stack-dsp.git}"
cd "$ROOT_DIR"

if [[ ! -d .git ]]; then
    echo "ERROR: $ROOT_DIR is not a Git checkout." >&2
    exit 1
fi

RUNTIME_PATHS=(
    camillaNodeConfig.json
    currentConfig.json
    savedConfigs.dat
    startupConfig.json
    wiimLoudnessConfig.json
    wiimLoudnessStatus.json
    config
    setupFiles/spectrum_preview.yml
    setupFiles/spectrum_real.yml
    setupFiles/spectrum_real.yml.bak
    setupFiles/spectrum_white.yml
    setupFiles/spectrum_preview.yml.bak
    setupFiles/spectrum_white.yml.bak
)
RUNTIME_PATTERN='^(camillaNodeConfig\.json|currentConfig\.json|savedConfigs\.dat|startupConfig\.json|wiimLoudness(Config|Status)\.json|config(/.*)?|setupFiles/spectrum_(preview|real|white)\.yml(\.bak)?)$'
# package-lock.json is repository-owned, not runtime state. Old npm versions or
# previous installs can leave it locally modified; it is safe to discard because
# the update restores the canonical lockfile from Git before running npm ci.
SAFE_RESET_PATTERN='^package-lock\.json$'
BACKUP_DIR="$(mktemp -d)"
RUNTIME_SAVED=0
cleanup() {
    local result=$?
    if [[ "$RUNTIME_SAVED" == 1 ]]; then
        if ! restore_runtime; then
            echo "ERROR: runtime restore failed; backup retained: $BACKUP_DIR" >&2
            exit 1
        fi
    fi
    rm -rf "$BACKUP_DIR"
    exit "$result"
}
trap cleanup EXIT

backup_runtime() {
    for item in "${RUNTIME_PATHS[@]}"; do
        if [[ -e "$item" ]]; then
            mkdir -p "$BACKUP_DIR/$(dirname "$item")"
            cp -a "$item" "$BACKUP_DIR/$item"
        fi
    done
}

restore_runtime() {
    for item in "${RUNTIME_PATHS[@]}"; do
        if [[ -e "$BACKUP_DIR/$item" ]]; then
            rm -rf "$item" || return 1
            mkdir -p "$(dirname "$item")" || return 1
            cp -a "$BACKUP_DIR/$item" "$item" || return 1
        fi
    done
    mkdir -p config
}

printf '\nE-Stack Raspberry update\n'
printf 'Repository : %s\n' "$REPO"
printf 'Branch     : %s\n\n' "$BRANCH"

# Runtime files are allowed to differ. Any local application-code modification
# aborts the update rather than being silently overwritten. Raspberry-specific
# spectrum variants are runtime configuration. package-lock.json is explicitly
# safe to normalize to the repository copy before npm ci.
while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    file="${line:3}"
    file="${file##* -> }"
    if [[ "$file" =~ $RUNTIME_PATTERN ]]; then
        continue
    fi
    if [[ "$file" =~ $SAFE_RESET_PATTERN ]]; then
        echo "Normalizing generated dependency lockfile: $file"
        continue
    fi
    echo "ERROR: local code/content changes detected; update aborted:" >&2
    git status --short >&2
    exit 1
done < <(git status --porcelain=v1)

backup_runtime
RUNTIME_SAVED=1
PREVIOUS_HEAD="$(git rev-parse HEAD)"

# Before the cleanup release some runtime files were tracked by Git. Normalize
# only the tracked working tree after the backup so the first fast-forward can
# delete those legacy tracked files without losing the local runtime copy.
# This also restores package-lock.json to the repository-owned version.
git reset --hard HEAD >/dev/null

if [[ -n "${ESTACK_FETCHED_SHA:-}" ]]; then
    [[ "$ESTACK_FETCHED_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid pinned SHA' >&2; exit 1; }
    [[ "$(git rev-parse "refs/remotes/origin/$BRANCH^{commit}")" == "$ESTACK_FETCHED_SHA" ]] || { echo 'Pinned ref changed' >&2; exit 1; }
else
    git remote set-url origin "$REPO"
    git fetch --prune origin "$BRANCH"
fi
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git switch "$BRANCH"
else
    git switch --track -c "$BRANCH" "origin/$BRANCH"
fi

# Some early Raspberry checkouts tracked an older remote named "estack". Make
# origin authoritative so ordinary `git status` / `git pull` no longer report
# misleading ahead/behind counts against that stale remote.
git branch --set-upstream-to="origin/$BRANCH" "$BRANCH" >/dev/null

if [[ -n "${ESTACK_FETCHED_SHA:-}" ]]; then
    git merge --ff-only "$ESTACK_FETCHED_SHA"
    [[ "$(git rev-parse HEAD)" == "$ESTACK_FETCHED_SHA" ]] || { echo 'Deployed SHA mismatch' >&2; exit 1; }
else
    git pull --ff-only origin "$BRANCH"
fi
restore_runtime
RUNTIME_SAVED=0

# The RC orchestrator owns dependencies, health checks and the sole service
# restart. Normal updater defaults and behavior remain unchanged.
if [[ "${ESTACK_UPDATE_CODE_ONLY:-0}" == 1 ]]; then
    printf 'Application code updated: %s\n' "$(git rev-parse HEAD)"
    exit 0
fi

# Deterministic production dependencies only. CamillaDSP itself is not touched.
npm ci --omit=dev --no-audit --no-fund
npm run check

if command -v systemctl >/dev/null 2>&1 && systemctl cat camillanode.service >/dev/null 2>&1; then
    echo "Restarting camillanode.service..."
    sudo systemctl restart camillanode.service

    if ! sudo systemctl is-active --quiet camillanode.service; then
        echo "ERROR: camillanode.service did not become active." >&2
        sudo systemctl --no-pager --full status camillanode.service || true
        exit 1
    fi

    PORT="$(node -e "const fs=require('fs');let p=8080;try{p=JSON.parse(fs.readFileSync('camillaNodeConfig.json','utf8')).port||p}catch(_){};process.stdout.write(String(p))")"
    HEALTH_OK=0
    for _ in {1..12}; do
        if node - "$PORT" <<'NODE' >/dev/null 2>&1
const http = require('http');
const port = Number(process.argv[2]);
const req = http.get({ host: '127.0.0.1', port, path: '/api/runtime', timeout: 800 }, res => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('timeout', () => { req.destroy(); process.exit(1); });
req.on('error', () => process.exit(1));
NODE
        then
            HEALTH_OK=1
            break
        fi
        sleep 1
    done

    if [[ "$HEALTH_OK" -ne 1 ]]; then
        echo "ERROR: CamillaNode service is active but /api/runtime is not healthy on port $PORT." >&2
        sudo journalctl -u camillanode.service -n 60 --no-pager || true
        exit 1
    fi
else
    echo "NOTE: camillanode.service not found; repository updated but no service was restarted."
fi

printf '\nUpdate complete.\n'
printf 'Previous commit : %s\n' "$PREVIOUS_HEAD"
printf 'Current commit  : %s\n' "$(git rev-parse HEAD)"
echo "Runtime configs/presets, startup preset state and local spectrum variants were preserved."
echo "CamillaDSP, ALSA and DSP YAML were not modified."
