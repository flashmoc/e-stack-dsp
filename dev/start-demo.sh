#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=demo-environment.sh
source "$ROOT_DIR/dev/demo-environment.sh"
estack_demo_require_context

CACHE_DIR="$(estack_demo_cache_dir)"

BIN_DIR="$CACHE_DIR/bin"
RUN_DIR="$CACHE_DIR/run"
LOG_DIR="$CACHE_DIR/log"
TMP_DIR="$CACHE_DIR/tmp"
GUI_CONFIG_DIR="$CACHE_DIR/configs"
GUI_COEFF_DIR="$CACHE_DIR/coeffs"

CAMILLA_VERSION="${CAMILLA_VERSION:-4.1.3}"
CAMILLAGUI_VERSION="${CAMILLAGUI_VERSION:-4.1.0}"
SOURCE_MAIN_CONFIG="$ROOT_DIR/dev/estack-demo.yml"
MAIN_CONFIG="$GUI_CONFIG_DIR/EStack_Codespaces.yml"
SPECTRUM_CONFIG="$RUN_DIR/spectrum-demo.yml"
STATE_FILE="$RUN_DIR/camilladsp-state.yml"
GUI_CONFIG="$RUN_DIR/camillagui.yml"

mkdir -p "$BIN_DIR" "$RUN_DIR" "$LOG_DIR" "$TMP_DIR" "$GUI_CONFIG_DIR" "$GUI_COEFF_DIR"

MODE="foreground"
for argument in "$@"; do
    case "$argument" in
        --background) MODE="background" ;;
        --foreground) MODE="foreground" ;;
        --restart) ;;
        *) echo "Unknown demo option: $argument" >&2; exit 2 ;;
    esac
done

case "$(uname -m)" in
    x86_64|amd64) CAMILLA_ARCH="amd64" ;;
    aarch64|arm64) CAMILLA_ARCH="aarch64" ;;
    *)
        echo "Unsupported architecture: $(uname -m)" >&2
        exit 1
        ;;
esac

CAMILLA_BIN="$BIN_DIR/camilladsp-$CAMILLA_VERSION-$CAMILLA_ARCH"
CAMILLAGUI_HOME="$CACHE_DIR/camillagui-$CAMILLAGUI_VERSION-$CAMILLA_ARCH"
CAMILLAGUI_BIN="$CAMILLAGUI_HOME/camillagui_backend/camillagui_backend"

pid_command() {
    tr '\0' ' ' <"/proc/$1/cmdline" 2>/dev/null || true
}

is_demo_owned_pid() {
    local command working_directory
    command="$(pid_command "$1")"
    if [[ -n "$command" && ( "$command" == *"$CACHE_DIR"* || "$command" == *"$ROOT_DIR/index.js"* || "$command" == *"$ROOT_DIR/dev/generate-input-demo.py"* || "$command" == *"$ROOT_DIR/dev/start-demo.sh"* ) ]]; then
        return 0
    fi

    # Older background launchers used a relative script path. Accept only that
    # exact command when its process working directory is this workspace; this
    # makes a one-time restart safe while newer launchers use the absolute path.
    working_directory="$(readlink -f "/proc/$1/cwd" 2>/dev/null || true)"
    [[ "$command" == 'bash dev/start-demo.sh --foreground ' && "$working_directory" == "$ROOT_DIR" ]]
}

stop_pid_file() {
    local file="$1" label="$2" pid
    [[ -f "$file" ]] || return 0
    pid="$(<"$file")"
    [[ "$pid" =~ ^[0-9]+$ ]] || { rm -f "$file"; return 0; }
    # A background launcher records its own PID. Never terminate the current
    # launcher while it is bringing its own services up.
    [[ "$pid" == "$$" ]] && return 0
    if ! kill -0 "$pid" >/dev/null 2>&1; then rm -f "$file"; return 0; fi
    if ! is_demo_owned_pid "$pid"; then
        echo "Refusing to stop $label PID $pid: it is not owned by this demo." >&2
        return 1
    fi
    echo "Stopping stale demo $label (PID $pid)..."
    kill "$pid" >/dev/null 2>&1 || true
    for ((attempt=1; attempt<=30; attempt++)); do
        kill -0 "$pid" >/dev/null 2>&1 || { rm -f "$file"; return 0; }
        sleep 0.1
    done
    kill -KILL "$pid" >/dev/null 2>&1 || true
    rm -f "$file"
}

release_demo_port() {
    local port="$1" owners pid attempt
    command -v fuser >/dev/null 2>&1 || return 0
    for ((attempt=1; attempt<=30; attempt++)); do
        owners="$(fuser -n tcp "$port" 2>/dev/null || true)"
        [[ -z "$owners" ]] && return 0
        for pid in $owners; do
            [[ "$pid" =~ ^[0-9]+$ ]] || continue
            if ! is_demo_owned_pid "$pid"; then
                echo "Port $port is occupied by non-demo PID $pid; refusing to kill it." >&2
                return 1
            fi
            echo "Stopping stale demo process on port $port (PID $pid)..."
            kill "$pid" >/dev/null 2>&1 || true
        done
        sleep 0.1
    done
    echo "Demo-owned process did not release port $port in time." >&2
    return 1
}

stop_previous_demo() {
    # This script only runs with ESTACK_DEMO_CONTEXT=1, set by the Dev Container.
    # PID files plus /proc command verification prevent broad host/process cleanup.
    stop_pid_file "$RUN_DIR/launcher.pid" 'launcher'
    stop_pid_file "$RUN_DIR/camillanode.pid" 'E-Stack DSP'
    stop_pid_file "$RUN_DIR/camillagui.pid" 'CamillaGUI'
    stop_pid_file "$RUN_DIR/spectrum.pid" 'spectrum CamillaDSP'
    stop_pid_file "$RUN_DIR/main.pid" 'main CamillaDSP'
    stop_pid_file "$RUN_DIR/input.pid" 'demo input generator'
    release_demo_port 1234
    release_demo_port 6413
    release_demo_port 5005
    release_demo_port 8080
    rm -f "$RUN_DIR/input.fifo" "$RUN_DIR/main.pid" "$RUN_DIR/spectrum.pid" "$RUN_DIR/camillagui.pid" "$RUN_DIR/camillanode.pid" "$RUN_DIR/input.pid"
    sleep 0.3
}

ensure_system_dependencies() {
    # Avoid grep -q with pipefail: an early grep exit can SIGPIPE ldconfig.
    if ldconfig -p 2>/dev/null | grep 'libasound\.so\.2' >/dev/null; then
        return
    fi

    echo "Installing CamillaDSP ALSA runtime library (one-time Dev Container setup)..."
    sudo apt-get update -qq
    if ! sudo apt-get install -y libasound2; then
        sudo apt-get install -y libasound2t64
    fi
}

download_camilladsp() {
    if [[ -x "$CAMILLA_BIN" ]]; then
        return
    fi

    echo "Downloading CamillaDSP $CAMILLA_VERSION for linux-$CAMILLA_ARCH..."
    local temp_dir archive
    temp_dir="$(mktemp -d "$TMP_DIR/camilladsp.XXXXXXXXXX")"
    archive="$temp_dir/camilladsp.tar.gz"

    curl -fL --retry 3 \
        "https://github.com/HEnquist/camilladsp/releases/download/v${CAMILLA_VERSION}/camilladsp-linux-${CAMILLA_ARCH}.tar.gz" \
        -o "$archive"
    tar -xzf "$archive" -C "$temp_dir"
    install -m 0755 "$temp_dir/camilladsp" "$CAMILLA_BIN"
    rm -rf "$temp_dir"
}

download_camillagui() {
    if [[ -x "$CAMILLAGUI_BIN" ]]; then
        return
    fi

    echo "Downloading CamillaGUI $CAMILLAGUI_VERSION official bundle for linux-$CAMILLA_ARCH..."
    local temp_dir archive candidate
    temp_dir="$(mktemp -d "$TMP_DIR/camillagui.XXXXXXXXXX")"
    archive="$temp_dir/camillagui.tar.gz"

    curl -fL --retry 3 \
        "https://github.com/HEnquist/camillagui-backend/releases/download/v${CAMILLAGUI_VERSION}/bundle_linux_${CAMILLA_ARCH}.tar.gz" \
        -o "$archive"

    rm -rf "$CAMILLAGUI_HOME"
    mkdir -p "$CAMILLAGUI_HOME"
    tar -xzf "$archive" -C "$CAMILLAGUI_HOME"
    rm -rf "$temp_dir"

    # Official bundles currently contain camillagui_backend/camillagui_backend.
    # Keep a fallback so a harmless archive-layout change does not break demo setup.
    if [[ ! -x "$CAMILLAGUI_BIN" ]]; then
        candidate="$(find "$CAMILLAGUI_HOME" -type f -name camillagui_backend -perm -u+x -print -quit)"
        if [[ -z "$candidate" ]]; then
            echo "CamillaGUI bundle extracted, but the backend executable was not found." >&2
            exit 1
        fi
        CAMILLAGUI_BIN="$candidate"
    fi
}

validate_config() {
    local label="$1"
    local config="$2"
    local output

    printf 'Validating %-18s ... ' "$label"
    if ! output="$("$CAMILLA_BIN" --check "$config" 2>&1)"; then
        echo "FAILED"
        echo
        echo "$output" >&2
        echo >&2
        echo "The $label configuration is invalid; startup stopped before opening any ports." >&2
        return 1
    fi
    echo "OK"
}

wait_for_port() {
    local port="$1"
    local label="$2"
    local attempts="${3:-150}"

    for ((i=1; i<=attempts; i++)); do
        if python3 - "$port" <<'PY' >/dev/null 2>&1
import socket
import sys
port = int(sys.argv[1])
s = socket.socket()
s.settimeout(0.1)
try:
    s.connect(("127.0.0.1", port))
except OSError:
    raise SystemExit(1)
finally:
    s.close()
PY
        then
            return 0
        fi
        sleep 0.1
    done

    echo "$label did not open port $port in time." >&2
    return 1
}

# Recover only demo-owned processes before preparing binaries and runtime configs.
# The same safe lifecycle is used by Codespaces and local VS Code Dev Containers.
stop_previous_demo
if [[ "$MODE" == "background" ]]; then
    nohup bash "$ROOT_DIR/dev/start-demo.sh" --foreground >"$LOG_DIR/launcher.log" 2>&1 </dev/null &
    launcher_pid=$!
    echo "$launcher_pid" > "$RUN_DIR/launcher.pid"
    echo "E-Stack demo launcher started in background (PID $launcher_pid)."
    echo "Run 'npm run demo:check' to wait for and verify all four services."
    exit 0
fi
ensure_system_dependencies
download_camilladsp
download_camillagui

# CamillaGUI gets a writable runtime copy. Every demo restart resets it to the
# version tracked in Git, while edits applied during a session still reach DSP.
cp "$SOURCE_MAIN_CONFIG" "$MAIN_CONFIG"
python3 "$ROOT_DIR/dev/make-spectrum-demo.py" "$SPECTRUM_CONFIG" >/dev/null

cat >"$GUI_CONFIG" <<EOF
---
camilla_host: "127.0.0.1"
camilla_port: 1234
bind_address: "0.0.0.0"
port: 5005
ssl_certificate: null
ssl_private_key: null
gui_config_file: null
config_dir: "$GUI_CONFIG_DIR"
coeff_dir: "$GUI_COEFF_DIR"
default_config: "$MAIN_CONFIG"
statefile_path: "$STATE_FILE"
log_file: "$LOG_DIR/camilladsp-main.log"
EOF

validate_config "main E-Stack DSP" "$MAIN_CONFIG"
validate_config "30-band spectrum" "$SPECTRUM_CONFIG"

cd "$ROOT_DIR"
if [[ ! -d node_modules ]]; then
    echo "Installing E-Stack DSP dependencies..."
    npm install --no-audit --no-fund
fi

export ESTACK_DEMO=1
export CAMILLANODE_PORT=8080
export CAMILLADSP_PROXY_HOST=127.0.0.1
export CAMILLADSP_PORT=1234
export CAMILLA_SPECTRUM_PORT=6413

MAIN_PID=""
SPECTRUM_PID=""
GUI_PID=""
NODE_PID=""
INPUT_PID=""
INPUT_FIFO="$RUN_DIR/input.fifo"
cleanup() {
    local status=$?
    trap - EXIT INT TERM
    [[ -n "$NODE_PID" ]] && kill "$NODE_PID" >/dev/null 2>&1 || true
    [[ -n "$GUI_PID" ]] && kill "$GUI_PID" >/dev/null 2>&1 || true
    [[ -n "$MAIN_PID" ]] && kill "$MAIN_PID" >/dev/null 2>&1 || true
    [[ -n "$SPECTRUM_PID" ]] && kill "$SPECTRUM_PID" >/dev/null 2>&1 || true
    [[ -n "$INPUT_PID" ]] && kill "$INPUT_PID" >/dev/null 2>&1 || true
    rm -f "$RUN_DIR/launcher.pid" "$RUN_DIR/main.pid" "$RUN_DIR/spectrum.pid" "$RUN_DIR/camillagui.pid" "$RUN_DIR/camillanode.pid" "$RUN_DIR/input.pid" "$INPUT_FIFO"
    exit "$status"
}
trap cleanup EXIT INT TERM

# CH1/CH2 carry -30 dBFS noise. CH3-CH8 remain exact digital silence.
# The statefile lets CamillaGUI resolve this exact runtime config as active.
rm -f "$INPUT_FIFO"
mkfifo -m 600 "$INPUT_FIFO"
python3 "$ROOT_DIR/dev/generate-input-demo.py" >"$INPUT_FIFO" 2>"$LOG_DIR/input-demo.log" &
INPUT_PID=$!
echo "$INPUT_PID" > "$RUN_DIR/input.pid"

"$CAMILLA_BIN" --port 1234 --loglevel warn -s "$STATE_FILE" "$MAIN_CONFIG" \
    < "$INPUT_FIFO" \
    >"$LOG_DIR/camilladsp-main.log" 2>&1 &
MAIN_PID=$!
echo "$MAIN_PID" > "$RUN_DIR/main.pid"

"$CAMILLA_BIN" --port 6413 --loglevel warn "$SPECTRUM_CONFIG" \
    >"$LOG_DIR/camilladsp-spectrum.log" 2>&1 &
SPECTRUM_PID=$!
echo "$SPECTRUM_PID" > "$RUN_DIR/spectrum.pid"

if ! wait_for_port 1234 "Main CamillaDSP"; then
    cat "$LOG_DIR/camilladsp-main.log" >&2 || true
    exit 1
fi
if ! wait_for_port 6413 "Spectrum CamillaDSP"; then
    cat "$LOG_DIR/camilladsp-spectrum.log" >&2 || true
    exit 1
fi

if ! kill -0 "$MAIN_PID" >/dev/null 2>&1; then
    echo "Main CamillaDSP exited unexpectedly:" >&2
    cat "$LOG_DIR/camilladsp-main.log" >&2 || true
    exit 1
fi
if ! kill -0 "$SPECTRUM_PID" >/dev/null 2>&1; then
    echo "Spectrum CamillaDSP exited unexpectedly:" >&2
    cat "$LOG_DIR/camilladsp-spectrum.log" >&2 || true
    exit 1
fi

# Start the official CamillaGUI backend after the main DSP is reachable.
"$CAMILLAGUI_BIN" -c "$GUI_CONFIG" -l WARNING -a WARNING \
    >"$LOG_DIR/camillagui.log" 2>&1 &
GUI_PID=$!
echo "$GUI_PID" > "$RUN_DIR/camillagui.pid"

# Fail fast if the backend exits, otherwise wait for its HTTP listener.
for ((i=1; i<=200; i++)); do
    if ! kill -0 "$GUI_PID" >/dev/null 2>&1; then
        echo "CamillaGUI exited before opening port 5005:" >&2
        cat "$LOG_DIR/camillagui.log" >&2 || true
        exit 1
    fi
    if python3 - <<'PY' >/dev/null 2>&1
import socket
s = socket.socket()
s.settimeout(0.1)
try:
    s.connect(("127.0.0.1", 5005))
except OSError:
    raise SystemExit(1)
finally:
    s.close()
PY
    then
        break
    fi
    if [[ "$i" -eq 200 ]]; then
        echo "CamillaGUI did not open port 5005 in time." >&2
        cat "$LOG_DIR/camillagui.log" >&2 || true
        exit 1
    fi
    sleep 0.1
done

# Start the E-Stack DSP backend last. It owns the browser-facing
# WebSocket proxies; ports 1234/6413 stay internal to this Linux demo stack.
node "$ROOT_DIR/index.js" >"$LOG_DIR/camillanode.log" 2>&1 &
NODE_PID=$!
echo "$NODE_PID" > "$RUN_DIR/camillanode.pid"
if ! wait_for_port 8080 "E-Stack DSP"; then
    echo "E-Stack DSP exited before opening port 8080:" >&2
    cat "$LOG_DIR/camillanode.log" >&2 || true
    exit 1
fi
if ! kill -0 "$NODE_PID" >/dev/null 2>&1; then
    echo "E-Stack DSP exited unexpectedly:" >&2
    cat "$LOG_DIR/camillanode.log" >&2 || true
    exit 1
fi

printf '\nE-Stack Linux demo is ready:\n'
printf '  Demo input:    CH1/CH2 noise @ -30 dBFS; CH3-CH8 digital silence\n'
printf '  Main DSP:      ws://127.0.0.1:1234\n'
printf '  Spectrum DSP:  ws://127.0.0.1:6413\n'
printf '  E-Stack DSP:   http://localhost:8080\n'
printf '  CamillaGUI:    http://localhost:5005/gui/index.html\n'
if [[ -n "${CODESPACE_NAME:-}" && -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]]; then
    printf '  Node browser:  https://%s-8080.%s\n' "$CODESPACE_NAME" "$GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN"
    printf '  GUI browser:   https://%s-5005.%s/gui/index.html\n' "$CODESPACE_NAME" "$GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN"
fi
printf '\nRuntime/cache: %s\n' "$CACHE_DIR"
printf 'Logs: %s\n' "$LOG_DIR"
printf 'Keep this command running while you work. Ctrl+C stops the complete demo.\n\n'

wait "$NODE_PID"
