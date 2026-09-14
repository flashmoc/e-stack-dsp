#!/usr/bin/env bash
set -Eeuo pipefail

TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEGACY_ROOT="${ESTACK_LEGACY_ROOT:-/home/bastos/camillanode}"
NEW_ROOT="${ESTACK_NEW_ROOT:-/home/bastos/e-stack-dsp}"
REPOSITORY="https://github.com/flashmoc/e-stack-dsp.git"
BRANCH="${ESTACK_BRANCH:-}"
EXPECTED_SHA="${ESTACK_EXPECTED_SHA:-}"
HARDWARE_BASE="16385076c553eaf4d5b26e90fc96f04969ee026f"
BACKUP_BASE="${ESTACK_BACKUP_BASE:-/home/bastos/estack-backups}"
LEGACY_SERVICE="camillanode.service"
NEW_SERVICE="estack-dsp.service"
SYSTEMD_ETC="/etc/systemd/system"
SYSTEMD_PATHS=(camillanode.service camillanode.service.d estack-dsp.service estack-dsp.service.d
  camilladsp.service camilladsp.service.d camilladsp2.service camilladsp2.service.d
  estack-wiim-loudness.service estack-wiim-loudness.service.d)

die() { echo "FAIL: $*" >&2; exit 1; }
[[ "${1:-}" == --yes && $# -eq 1 ]] || die 'Usage: ESTACK_BRANCH=... ESTACK_EXPECTED_SHA=<40-char SHA> bash pi-migrate-standalone.sh --yes'
[[ "$BRANCH" == feature/standalone-runtime ]] || die 'Explicit ESTACK_BRANCH=feature/standalone-runtime required for first migration'
[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]] || die 'Full reviewed ESTACK_EXPECTED_SHA required'
[[ "$(id -un)" == bastos ]] || die 'First migration must run as user bastos'
[[ "$LEGACY_ROOT" == /home/bastos/camillanode && "$NEW_ROOT" == /home/bastos/e-stack-dsp ]] || die 'Canonical migration roots must not be overridden'
[[ -d "$LEGACY_ROOT/.git" && ! -e "$NEW_ROOT" ]] || die 'Legacy checkout must exist and new root must not exist'
export ESTACK_ROOT="$LEGACY_ROOT"
source "$TOOL_DIR/pi-common.sh"
deployment_lock

for tool in git node npm systemctl ss flock realpath find cp install sha256sum awk sed; do
  command -v "$tool" >/dev/null || die "Required tool missing: $tool"
done
[[ -x /usr/bin/node ]] || die '/usr/bin/node is required by the canonical service contract'
[[ "$(/usr/bin/node -p 'parseInt(process.versions.node, 10)')" -ge 22 ]] || die 'Node 22+ required'
[[ "$(git -C "$LEGACY_ROOT" rev-parse HEAD)" == "$HARDWARE_BASE" ]] || die 'Legacy checkout is not at the hardware-accepted base SHA'
[[ "$(git -C "$LEGACY_ROOT" branch --show-current)" == release/raspi-rc1 ]] || die 'Hardware-accepted migration source must be on release/raspi-rc1'
node "$TOOL_DIR/pi-inspect.js" clean
LEGACY_ORIGIN="$(git -C "$LEGACY_ROOT" remote get-url origin)"
[[ "$LEGACY_ORIGIN" == "$REPOSITORY" || "$LEGACY_ORIGIN" == https://github.com/flashmoc/camillaNode-EStack.git ]] || die 'Legacy checkout origin is not recognized'
REMOTE_SHA="$(git ls-remote "$REPOSITORY" "refs/heads/$BRANCH" | awk 'NR==1 {print $1}')"
[[ "$REMOTE_SHA" == "$EXPECTED_SHA" ]] || die 'Reviewed SHA does not match the remote migration branch'

for unit in "$LEGACY_SERVICE" camilladsp.service camilladsp2.service estack-wiim-loudness.service; do
  systemctl is-active --quiet -- "$unit" || die "$unit must be active before migration"
done
if systemctl is-active --quiet -- "$NEW_SERVICE"; then die "$NEW_SERVICE is already active"; fi
[[ "$(systemctl show -p MainPID --value -- camilladsp.service)" =~ ^[1-9][0-9]*$ ]] || die 'Main CamillaDSP PID unavailable'
MAIN_DSP_PID="$(systemctl show -p MainPID --value -- camilladsp.service)"
DSP_DROPINS="$(systemctl show -p DropInPaths --value -- camilladsp.service)"
grep -Fq '/etc/systemd/system/camilladsp.service.d/estack-startup-recall.conf' <<<"$DSP_DROPINS" || die 'Startup recall is not owned by the expected audited drop-in'
systemctl show -p ExecStartPost --value -- camilladsp.service | grep -Fq "$LEGACY_ROOT/scripts/reapply-startup.js" || die 'Startup recall does not point to legacy root'
systemctl show -p ExecStart --value -- camilladsp2.service | grep -Fq "$LEGACY_ROOT/setupFiles/spectrum_real.yml" || die 'Spectrum service does not use expected legacy YAML'
WIIM_SHOW="$(systemctl show -p WorkingDirectory -p ExecStart -p Environment -- estack-wiim-loudness.service)"
grep -Fq "$LEGACY_ROOT" <<<"$WIIM_SHOW" || die 'WiiM service does not use legacy root'

node "$TOOL_DIR/pi-inspect.js" migration-preflight "$LEGACY_ROOT"
df -Pk "$LEGACY_ROOT" "$(dirname "$NEW_ROOT")" "$BACKUP_BASE" 2>/dev/null || true
AVAILABLE_KB="$(df -Pk "$(dirname "$NEW_ROOT")" | awk 'NR==2 {print $4}')"
[[ "$AVAILABLE_KB" =~ ^[0-9]+$ && "$AVAILABLE_KB" -ge 1048576 ]] || die 'At least 1 GiB free is required for standalone staging'

umask 077
mkdir -p "$BACKUP_BASE"
BACKUP="$(mktemp -d "$BACKUP_BASE/standalone-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")"
BACKUP="$(realpath "$BACKUP")"
[[ "$BACKUP/" != "$LEGACY_ROOT/"* && "$BACKUP/" != "$NEW_ROOT/"* ]] || die 'Backup must be outside both repositories'
failure() {
  echo "MIGRATION FAILED. Persistent backup retained: $BACKUP" >&2
  printf 'Rollback: bash %q %q --yes\n' "$BACKUP/toolkit/pi-migrate-standalone-rollback.sh" "$BACKUP" >&2
  systemctl --no-pager --full status -- "$LEGACY_SERVICE" "$NEW_SERVICE" camilladsp2.service estack-wiim-loudness.service >&2 || true
}
trap failure ERR

mkdir -p "$BACKUP/runtime" "$BACKUP/toolkit/node_modules" "$BACKUP/systemd-etc" "$BACKUP/systemd-evidence" "$BACKUP/service-state" "$BACKUP/metadata"
runtime_copy_from "$LEGACY_ROOT" "$BACKUP/runtime"
cp "$TOOL_DIR"/pi-{common.sh,inspect.js,postdeploy-check.sh,migrate-standalone-rollback.sh} "$BACKUP/toolkit/"
cp -a "$(node "$TOOL_DIR/pi-inspect.js" ws-path)" "$BACKUP/toolkit/node_modules/ws"
git -C "$LEGACY_ROOT" bundle create "$BACKUP/legacy-repository.bundle" HEAD
git -C "$LEGACY_ROOT" status --porcelain=v1 > "$BACKUP/legacy-git-status.txt"
git -C "$LEGACY_ROOT" diff --binary HEAD > "$BACKUP/legacy-git-diff.patch"
for unit in "$LEGACY_SERVICE" "$NEW_SERVICE" camilladsp.service camilladsp2.service estack-wiim-loudness.service; do
  systemctl --no-pager --full status -- "$unit" > "$BACKUP/systemd-evidence/$unit.status.txt" 2>&1 || true
  systemctl --no-pager cat -- "$unit" > "$BACKUP/systemd-evidence/$unit.cat.txt" 2>&1 || true
  systemctl show -- "$unit" > "$BACKUP/systemd-evidence/$unit.show.txt" 2>&1 || true
  systemctl is-enabled -- "$unit" > "$BACKUP/service-state/$unit.enabled" 2>&1 || true
  systemctl is-active -- "$unit" > "$BACKUP/service-state/$unit.active" 2>&1 || true
  fragment="$(systemctl show -p FragmentPath --value -- "$unit" 2>/dev/null || true)"
  [[ -z "$fragment" || ! -f "$fragment" ]] || cp -a "$fragment" "$BACKUP/systemd-evidence/$unit.fragment"
done
for relative in "${SYSTEMD_PATHS[@]}"; do
  [[ ! -e "$SYSTEMD_ETC/$relative" && ! -L "$SYSTEMD_ETC/$relative" ]] || { mkdir -p "$BACKUP/systemd-etc/$(dirname "$relative")"; cp -a "$SYSTEMD_ETC/$relative" "$BACKUP/systemd-etc/$relative"; }
done
ss -ltnp > "$BACKUP/listening-ports.txt" 2>&1 || true
node "$TOOL_DIR/pi-inspect.js" backup "$BACKUP"
printf '%s\n' "$LEGACY_ROOT" > "$BACKUP/metadata/legacy-root"
printf '%s\n' "$NEW_ROOT" > "$BACKUP/metadata/new-root"
printf '%s\n' "$EXPECTED_SHA" > "$BACKUP/metadata/target-sha"
printf '%s\n' "$MAIN_DSP_PID" > "$BACKUP/metadata/main-dsp-pid"
printf '%s\n' "$REPOSITORY" > "$BACKUP/metadata/repository"
printf 'E-Stack DSP standalone migration\nhost=%s\ntime=%s\nsource=%s\ntarget=%s\nsource_sha=%s\ntarget_sha=%s\n' \
  "$(hostname)" "$(date -u --iso-8601=seconds)" "$LEGACY_ROOT" "$NEW_ROOT" "$HARDWARE_BASE" "$EXPECTED_SHA" > "$BACKUP/manifest.txt"
(cd "$BACKUP" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
echo "Persistent migration backup: $BACKUP"

STAGE="${NEW_ROOT}.staging.$$"
[[ ! -e "$STAGE" ]] || die "Unexpected staging path exists: $STAGE"
cleanup_stage() { [[ ! -d "$STAGE" ]] || rm -rf -- "$STAGE"; }
trap 'cleanup_stage; failure' ERR
git clone --no-checkout "$REPOSITORY" "$STAGE"
git -C "$STAGE" checkout --detach "$EXPECTED_SHA"
[[ "$(git -C "$STAGE" rev-parse HEAD)" == "$EXPECTED_SHA" ]] || die 'Staged checkout SHA mismatch'
git -C "$STAGE" merge-base --is-ancestor "$HARDWARE_BASE" "$EXPECTED_SHA" || die 'Reviewed SHA does not descend from hardware-accepted base'
(cd "$STAGE" && npm ci --omit=dev --no-audit --no-fund && npm run check)
runtime_replace_from "$LEGACY_ROOT" "$STAGE"
node "$TOOL_DIR/pi-inspect.js" compare-runtime "$LEGACY_ROOT" "$STAGE"
mv "$STAGE" "$NEW_ROOT"

SPECTRUM_EXEC="$(systemctl --no-pager cat -- camilladsp2.service | awk '/^ExecStart=/{line=substr($0,11); if(length(line)) value=line} END{print value}')"
[[ "$SPECTRUM_EXEC" == *"$LEGACY_ROOT/setupFiles/spectrum_real.yml"* ]] || die 'Cannot derive safe spectrum ExecStart'
NEW_SPECTRUM_EXEC="${SPECTRUM_EXEC/$LEGACY_ROOT\/setupFiles\/spectrum_real.yml/$NEW_ROOT\/setupFiles\/spectrum_real.yml}"
[[ "$NEW_SPECTRUM_EXEC" != "$SPECTRUM_EXEC" ]] || die 'Spectrum ExecStart replacement failed'
GENERATED="$BACKUP/generated"
mkdir -p "$GENERATED"
cat > "$GENERATED/estack-dsp.service" <<UNIT
[Unit]
Description=E-Stack DSP
After=network-online.target camilladsp.service
Wants=network-online.target

[Service]
Type=simple
User=bastos
Group=bastos
WorkingDirectory=/home/bastos/e-stack-dsp
ExecStart=/usr/bin/node /home/bastos/e-stack-dsp/index.js
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=false
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
UNIT
cat > "$GENERATED/startup-recall.conf" <<UNIT
[Service]
ExecStartPost=/usr/bin/node /home/bastos/e-stack-dsp/scripts/reapply-startup.js
UNIT
cat > "$GENERATED/spectrum-root.conf" <<UNIT
[Service]
ExecStart=
ExecStart=$NEW_SPECTRUM_EXEC
UNIT
cat > "$GENERATED/wiim-root.conf" <<UNIT
[Service]
WorkingDirectory=/home/bastos/e-stack-dsp
Environment=ESTACK_WIIM_LOUDNESS_CONFIG=/home/bastos/e-stack-dsp/wiimLoudnessConfig.json
Environment=ESTACK_WIIM_LOUDNESS_STATUS=/dev/shm/estack-wiim-loudness-status.json
ExecStart=
ExecStart=/usr/bin/node /home/bastos/e-stack-dsp/scripts/wiim-loudness-service.js
UNIT
(cd "$BACKUP" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)

sudo systemctl stop estack-wiim-loudness.service
sudo systemctl stop camillanode.service
node "$TOOL_DIR/pi-inspect.js" migration-offline-safety "$LEGACY_ROOT"
sudo install -m 0644 "$GENERATED/estack-dsp.service" "$SYSTEMD_ETC/estack-dsp.service"
sudo install -d -m 0755 "$SYSTEMD_ETC/camilladsp.service.d" "$SYSTEMD_ETC/camilladsp2.service.d" "$SYSTEMD_ETC/estack-wiim-loudness.service.d"
sudo install -m 0644 "$GENERATED/startup-recall.conf" "$SYSTEMD_ETC/camilladsp.service.d/estack-startup-recall.conf"
sudo install -m 0644 "$GENERATED/spectrum-root.conf" "$SYSTEMD_ETC/camilladsp2.service.d/zz-estack-standalone-root.conf"
sudo install -m 0644 "$GENERATED/wiim-root.conf" "$SYSTEMD_ETC/estack-wiim-loudness.service.d/zz-estack-standalone-root.conf"
sudo systemctl daemon-reload

ESTACK_SHOW="$(systemctl show -p LoadState -p User -p Group -p WorkingDirectory -p ExecStart -p Environment -p NoNewPrivileges -p PrivateTmp -p Restart -- estack-dsp.service)"
for required in 'LoadState=loaded' 'User=bastos' 'Group=bastos' 'WorkingDirectory=/home/bastos/e-stack-dsp' \
  'Environment=NODE_ENV=production' 'NoNewPrivileges=yes' 'PrivateTmp=no' 'Restart=on-failure'; do
  grep -Fq "$required" <<<"$ESTACK_SHOW" || die "Resolved estack-dsp.service property missing: $required"
done
grep -Fq 'path=/usr/bin/node ; argv[]=/usr/bin/node /home/bastos/e-stack-dsp/index.js' <<<"$ESTACK_SHOW" || die 'Resolved E-Stack ExecStart is not canonical'
STARTUP_SHOW="$(systemctl show -p ExecStartPost --value -- camilladsp.service)"
grep -Fq "$NEW_ROOT/scripts/reapply-startup.js" <<<"$STARTUP_SHOW" || die 'Resolved startup recall does not use standalone root'
! grep -Fq "$LEGACY_ROOT/scripts/reapply-startup.js" <<<"$STARTUP_SHOW" || die 'Resolved startup recall still uses legacy root'
SPECTRUM_SHOW="$(systemctl show -p ExecStart --value -- camilladsp2.service)"
grep -Fq "$NEW_ROOT/setupFiles/spectrum_real.yml" <<<"$SPECTRUM_SHOW" || die 'Resolved spectrum service does not use standalone root'
! grep -Fq "$LEGACY_ROOT/setupFiles/spectrum_real.yml" <<<"$SPECTRUM_SHOW" || die 'Resolved spectrum service still uses legacy root'
WIIM_SHOW="$(systemctl show -p WorkingDirectory -p ExecStart -p Environment -- estack-wiim-loudness.service)"
grep -Fq "$NEW_ROOT" <<<"$WIIM_SHOW" || die 'Resolved WiiM service does not use standalone root'
! grep -Fq "$LEGACY_ROOT" <<<"$WIIM_SHOW" || die 'Resolved WiiM service still uses legacy root'

sudo systemctl enable estack-dsp.service
sudo systemctl start estack-dsp.service
ESTACK_ROOT="$NEW_ROOT" node "$NEW_ROOT/scripts/pi-inspect.js" health
sudo systemctl restart camilladsp2.service
sudo systemctl start estack-wiim-loudness.service
ESTACK_ROOT="$NEW_ROOT" bash "$NEW_ROOT/scripts/pi-postdeploy-check.sh"
ESTACK_ROOT="$NEW_ROOT" node "$NEW_ROOT/scripts/pi-inspect.js" compare-dsp-evidence "$BACKUP"
[[ "$(systemctl show -p MainPID --value -- camilladsp.service)" == "$MAIN_DSP_PID" ]] || die 'Main CamillaDSP PID changed; migration safety violated'
sudo systemctl disable camillanode.service
systemctl is-active --quiet -- estack-dsp.service
! systemctl is-active --quiet -- camillanode.service

printf '\nStandalone migration complete.\nOld root retained: %s\nNew root: %s\nDeployed SHA: %s\nBackup: %s\n' "$LEGACY_ROOT" "$NEW_ROOT" "$EXPECTED_SHA" "$BACKUP"
printf 'Rollback: bash %q %q --yes\n' "$BACKUP/toolkit/pi-migrate-standalone-rollback.sh" "$BACKUP"
echo 'camilladsp.service was not restarted; no reboot or DSP configuration write was performed.'
