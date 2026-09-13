#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="estack-wiim-loudness.service"
CONFIG_FILE="$ROOT/wiimLoudnessConfig.json"
EXAMPLE_FILE="$ROOT/wiimLoudnessConfig.example.json"
NODE_BIN="/usr/bin/node"
RUN_USER="${SUDO_USER:-$USER}"

if [[ ! -x "$NODE_BIN" ]]; then
  echo "Node.js is required but was not found." >&2
  exit 1
fi
if [[ "$ROOT" != /home/bastos/e-stack-dsp || "$RUN_USER" != bastos ]]; then
  echo "Canonical WiiM installation requires /home/bastos/e-stack-dsp and user bastos." >&2
  exit 1
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
  cp "$EXAMPLE_FILE" "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
  echo "Created $CONFIG_FILE"
else
  echo "Keeping existing $CONFIG_FILE"
fi
sudo chown "$RUN_USER:$(id -gn "$RUN_USER")" "$CONFIG_FILE"
chmod 600 "$CONFIG_FILE"

UNIT_FILE="$(mktemp)"
trap 'rm -f "$UNIT_FILE"' EXIT
cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=E-Stack WiiM Loudness Bridge
Wants=network-online.target
After=network-online.target camilladsp.service

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$ROOT
Environment=ESTACK_WIIM_LOUDNESS_CONFIG=$CONFIG_FILE
Environment=ESTACK_WIIM_LOUDNESS_STATUS=/dev/shm/estack-wiim-loudness-status.json
ExecStart=$NODE_BIN $ROOT/scripts/wiim-loudness-service.js
Restart=always
RestartSec=1
TimeoutStopSec=3

[Install]
WantedBy=multi-user.target
UNIT

sudo install -m 0644 "$UNIT_FILE" "/etc/systemd/system/$SERVICE_NAME"
sudo systemctl daemon-reload
sudo systemctl enable --now "$SERVICE_NAME"

# E-Stack DSP needs a restart so the new same-origin status/settings API is live.
if systemctl list-unit-files estack-dsp.service >/dev/null 2>&1; then
  sudo systemctl restart estack-dsp.service
fi

echo
echo "Installed $SERVICE_NAME"
echo "Config: $CONFIG_FILE"
echo
sudo systemctl --no-pager --full status "$SERVICE_NAME" || true
