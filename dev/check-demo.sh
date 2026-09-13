#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=demo-environment.sh
source "$ROOT_DIR/dev/demo-environment.sh"
estack_demo_require_context

CHECK_TIMEOUT_SEC="${ESTACK_DEMO_CHECK_TIMEOUT_SEC:-75}"
if ! [[ "$CHECK_TIMEOUT_SEC" =~ ^[1-9][0-9]*$ ]]; then
    echo 'FAIL: ESTACK_DEMO_CHECK_TIMEOUT_SEC must be a positive number of seconds.' >&2
    exit 2
fi

LOG_DIR="$(estack_demo_cache_dir)/log"
LAST_FAILURE=''

port_reachable() {
    local port="$1"
    python3 - "$port" <<'PY' >/dev/null 2>&1
import socket
import sys

socket_handle = socket.socket()
socket_handle.settimeout(1)
try:
    socket_handle.connect(("127.0.0.1", int(sys.argv[1])))
except OSError:
    raise SystemExit(1)
finally:
    socket_handle.close()
PY
}

runtime_is_canonical_demo() {
    python3 - "$1" <<'PY'
import json
import sys

runtime = json.loads(sys.argv[1])
expected = {"mode": "demo", "httpPort": 8080, "dspPort": 1234, "spectrumPort": 6413}
for key, value in expected.items():
    if runtime.get(key) != value:
        raise SystemExit(f"/api/runtime {key}={runtime.get(key)!r}, expected {value!r}")
PY
}

check_once() {
    local product runtime runtime_error
    LAST_FAILURE=''

    if ! port_reachable 1234; then
        LAST_FAILURE='CamillaDSP main is not reachable on 127.0.0.1:1234'
        return 1
    fi
    if ! port_reachable 6413; then
        LAST_FAILURE='CamillaDSP spectrum is not reachable on 127.0.0.1:6413'
        return 1
    fi
    if ! port_reachable 5005; then
        LAST_FAILURE='CamillaGUI is not reachable on 127.0.0.1:5005'
        return 1
    fi
    if ! port_reachable 8080; then
        LAST_FAILURE='E-Stack DSP is not reachable on 127.0.0.1:8080'
        return 1
    fi

    if ! product="$(curl --fail --silent --max-time 5 http://127.0.0.1:8080/estack-dsp/)"; then
        LAST_FAILURE='E-Stack DSP product route did not respond.'
        return 1
    fi
    if [[ "$product" != *'pageFrame'* || "$product" != *'<title>E-Stack DSP</title>'* ]]; then
        LAST_FAILURE='E-Stack DSP product route did not return the product shell.'
        return 1
    fi

    if ! curl --fail --silent --max-time 5 http://127.0.0.1:5005/gui/index.html >/dev/null; then
        LAST_FAILURE='CamillaGUI HTTP route did not respond.'
        return 1
    fi

    if ! runtime="$(curl --fail --silent --max-time 5 http://127.0.0.1:8080/api/runtime)"; then
        LAST_FAILURE='E-Stack DSP /api/runtime did not respond.'
        return 1
    fi
    if ! runtime_error="$(runtime_is_canonical_demo "$runtime" 2>&1)"; then
        LAST_FAILURE="${runtime_error:-E-Stack DSP /api/runtime is not the canonical demo runtime.}"
        return 1
    fi
}

started_at="$SECONDS"
echo "Waiting up to ${CHECK_TIMEOUT_SEC}s for the canonical E-Stack demo to become ready..."
until check_once; do
    elapsed=$((SECONDS - started_at))
    if (( elapsed >= CHECK_TIMEOUT_SEC )); then
        echo "FAIL: canonical demo was not ready after ${CHECK_TIMEOUT_SEC}s." >&2
        echo "Last failing check: ${LAST_FAILURE}" >&2
        echo "Demo logs: ${LOG_DIR}" >&2
        echo 'Relevant logs: launcher.log, camilladsp-main.log, camilladsp-spectrum.log, camillagui.log, camillanode.log, input-demo.log' >&2
        exit 1
    fi
    echo "Waiting (${elapsed}s/${CHECK_TIMEOUT_SEC}s): ${LAST_FAILURE}"
    sleep 1
done

echo 'OK:   CamillaDSP main reachable on 1234'
echo 'OK:   CamillaDSP spectrum reachable on 6413'
echo 'OK:   CamillaGUI reachable on 5005 and its HTTP route responds'
echo 'OK:   E-Stack DSP reachable on 8080'
echo 'OK:   E-Stack DSP product route responds'
echo 'OK:   E-Stack DSP reports the canonical demo runtime'
echo "Demo logs: ${LOG_DIR}"
