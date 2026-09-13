#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

for cmd in node npm git; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "ERROR: '$cmd' is required. Install Node.js/npm and git first." >&2
        exit 1
    fi
done

NODE_BIN="/usr/bin/node"
RUN_USER="$(id -un)"
RUN_GROUP="$(id -gn)"
[[ "$ROOT_DIR" == /home/bastos/e-stack-dsp ]] || { echo 'ERROR: canonical install root is /home/bastos/e-stack-dsp.' >&2; exit 1; }
[[ "$RUN_USER" == bastos && "$RUN_GROUP" == bastos ]] || { echo 'ERROR: canonical service user/group must be bastos.' >&2; exit 1; }
[[ -x "$NODE_BIN" ]] || { echo 'ERROR: canonical service requires /usr/bin/node.' >&2; exit 1; }

mkdir -p config
if [[ ! -f camillaNodeConfig.json ]]; then
    printf '{"port":8080}\n' > camillaNodeConfig.json
    chmod 600 camillaNodeConfig.json
fi

npm ci --omit=dev --no-audit --no-fund
npm run check

SERVICE_TMP="$(mktemp)"
trap 'rm -f "$SERVICE_TMP"' EXIT
cat > "$SERVICE_TMP" <<EOF
[Unit]
Description=E-Stack DSP
After=network-online.target camilladsp.service
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$ROOT_DIR
ExecStart=$NODE_BIN $ROOT_DIR/index.js
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=false
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF

sudo install -m 0644 "$SERVICE_TMP" /etc/systemd/system/estack-dsp.service
sudo systemctl daemon-reload
sudo systemctl enable --now estack-dsp.service

PORT="$(node -e "const fs=require('fs');let p=8080;try{p=JSON.parse(fs.readFileSync('camillaNodeConfig.json','utf8')).port||p}catch(_){};process.stdout.write(String(p))")"
for attempt in {1..12}; do
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
        printf '\nE-Stack DSP installed and healthy on port %s.\n' "$PORT"
        echo "CamillaDSP, ALSA and DSP configuration were not modified."
        exit 0
    fi
    sleep 1
done

echo "ERROR: estack-dsp.service started but the HTTP health check failed." >&2
sudo journalctl -u estack-dsp.service -n 60 --no-pager || true
exit 1
