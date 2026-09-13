#!/usr/bin/env bash
set -Eeuo pipefail

[[ $# -ge 1 && $# -le 2 ]] || { echo 'Usage: pi-migrate-standalone-rollback.sh BACKUP [--yes]' >&2; exit 1; }
BACKUP="$(realpath "$1")"
[[ -f "$BACKUP/SHA256SUMS" && -f "$BACKUP/manifest.txt" ]] || { echo 'Invalid migration backup' >&2; exit 1; }
cd "$BACKUP"
sha256sum -c SHA256SUMS
LEGACY_ROOT="$(<metadata/legacy-root)"
NEW_ROOT="$(<metadata/new-root)"
OLD_MAIN_DSP_PID="$(<metadata/main-dsp-pid)"
[[ "$LEGACY_ROOT" == /home/bastos/camillanode && "$NEW_ROOT" == /home/bastos/e-stack-dsp ]] || { echo 'Backup roots are not canonical' >&2; exit 1; }
[[ "$(id -un)" == bastos && -d "$LEGACY_ROOT/.git" && -d "$NEW_ROOT/.git" ]] || { echo 'Expected migration roots are unavailable' >&2; exit 1; }
export ESTACK_ROOT="$LEGACY_ROOT"
source "$BACKUP/toolkit/pi-common.sh"
deployment_lock
if [[ "${2:-}" != --yes ]]; then
  read -r -p 'Restore the retained CamillaNode installation? Type RESTORE: ' answer
  [[ "$answer" == RESTORE ]] || { echo 'Cancelled' >&2; exit 1; }
fi
if [[ "$(systemctl show -p MainPID --value -- camilladsp.service)" != "$OLD_MAIN_DSP_PID" ]]; then
  echo 'FAIL: Main CamillaDSP PID differs from migration backup; explicit hardware review required' >&2
  exit 1
fi
ESTACK_ROOT="$NEW_ROOT" node "$BACKUP/toolkit/pi-inspect.js" migration-offline-safety "$NEW_ROOT"

failure() {
  echo "ROLLBACK FAILED. Backup retained: $BACKUP" >&2
  systemctl --no-pager --full status -- estack-dsp.service camillanode.service camilladsp2.service estack-wiim-loudness.service >&2 || true
}
trap failure ERR
sudo systemctl stop estack-dsp.service || true
sudo systemctl stop estack-wiim-loudness.service || true
sudo systemctl stop camilladsp2.service || true

SYSTEMD_ETC=/etc/systemd/system
SYSTEMD_PATHS=(camillanode.service camillanode.service.d estack-dsp.service estack-dsp.service.d
  camilladsp.service camilladsp.service.d camilladsp2.service camilladsp2.service.d
  estack-wiim-loudness.service estack-wiim-loudness.service.d)
for relative in "${SYSTEMD_PATHS[@]}"; do
  sudo rm -rf -- "$SYSTEMD_ETC/$relative"
  if [[ -e "$BACKUP/systemd-etc/$relative" || -L "$BACKUP/systemd-etc/$relative" ]]; then
    sudo mkdir -p "$SYSTEMD_ETC/$(dirname "$relative")"
    sudo cp -a "$BACKUP/systemd-etc/$relative" "$SYSTEMD_ETC/$relative"
  fi
done

runtime_restore "$BACKUP/runtime"
sudo systemctl daemon-reload
if grep -Eq '^(enabled|enabled-runtime|linked|linked-runtime|alias)$' "$BACKUP/service-state/camillanode.service.enabled"; then
  sudo systemctl enable camillanode.service
else
  sudo systemctl disable camillanode.service || true
fi
sudo systemctl disable estack-dsp.service || true
if grep -qx active "$BACKUP/service-state/camilladsp2.service.active"; then sudo systemctl start camilladsp2.service; fi
if grep -qx active "$BACKUP/service-state/estack-wiim-loudness.service.active"; then sudo systemctl start estack-wiim-loudness.service; fi
if grep -qx active "$BACKUP/service-state/camillanode.service.active"; then sudo systemctl start camillanode.service; fi
ESTACK_ROOT="$LEGACY_ROOT" node "$BACKUP/toolkit/pi-inspect.js" health
[[ "$(systemctl show -p MainPID --value -- camilladsp.service)" == "$OLD_MAIN_DSP_PID" ]] || { echo 'Main CamillaDSP PID changed during rollback' >&2; exit 1; }
printf 'Standalone rollback complete. Legacy root active: %s\nNew root retained but inactive: %s\n' "$LEGACY_ROOT" "$NEW_ROOT"
echo 'camilladsp.service was not restarted; DSP evidence was not applied; no reboot was performed.'
