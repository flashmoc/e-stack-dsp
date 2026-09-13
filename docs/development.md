# E-Stack DSP development simulation and E2E

## Canonical software environment

The only development DSP simulation is the Linux stack started by
`.devcontainer`, `dev/start-demo.sh`, `dev/estack-demo.yml`,
`dev/generate-input-demo.py` and `dev/make-spectrum-demo.py`. It is shared by
GitHub Codespaces and VS Code Dev Containers on a Windows/Docker workstation.
There is no Windows CamillaDSP substitute, fake Node DSP server or browser
fixture used as the live E2E backend.

The canonical Dev Container is
`mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm` (Debian 12,
Node 22). It intentionally uses a Playwright-supported Linux base instead of
the historical generic Ubuntu 20.04 image.

```text
CamillaDSP main       127.0.0.1:1234  internal
CamillaDSP spectrum   127.0.0.1:6413  internal
CamillaGUI            0.0.0.0:5005    browser-facing
E-Stack DSP           0.0.0.0:8080    browser-facing

Product: http://localhost:8080/estack-dsp/?transport=camillanode#control
GUI:     http://localhost:5005/gui/index.html
```

E-Stack DSP owns the browser-facing `/ws/dsp` and `/ws/spectrum` proxies.
Ports `1234` and `6413` are not exposed to the host browser for product use.

## Local Windows workstation

1. Clone/open the repository in VS Code.
2. Start Docker Desktop (or an equivalent Linux container runtime).
3. Run **Dev Containers: Reopen in Container**.
4. After an image or dependency change, use **Dev Containers: Rebuild
   Container** rather than reusing a previous container filesystem.
5. Let `postCreateCommand` run deterministic `npm ci` and install the Chromium
   revision paired with Playwright.
6. The demo starts automatically on container start. If necessary run
   `npm run demo:bg`, then wait with `npm run demo:check`.
7. Open `http://localhost:8080/estack-dsp/?transport=camillanode#control`.
8. Open `http://localhost:5005/gui/index.html` for CamillaGUI.
9. Run `npm test` and `npm run e2e` inside the Dev Container.

The Windows host needs only Docker Desktop, VS Code and the Dev Containers
extension. Native Windows Bash, CamillaDSP, CamillaGUI and a second Node
backend are not prerequisites. Native source editing is fine; the complete
software validation environment is Linux in the container.

Tracked shell scripts are always committed and checked out as LF through
`.gitattributes`; `npm run check` fails with the exact path if a tracked `.sh`
contains CRLF or a bare carriage return. This protects bind-mounted Windows
checkouts without relying on a developer-specific `core.autocrlf` setting.

## Codespaces

Codespaces uses the same `.devcontainer`, launcher, generated input and
spectrum configuration. Its forwarded ports expose `8080` and `5005`; all
commands below are identical to the local Dev Container workflow.

## Demo lifecycle and logs

The launcher runs only with `ESTACK_DEMO_CONTEXT=1`, which `.devcontainer`
sets. This prevents accidental use on Raspberry hardware.

- `npm run demo` — foreground launcher; Ctrl+C stops the complete demo.
- `npm run demo:bg` — idempotent background launcher.
- `npm run demo:restart` — stop only verified demo-owned PIDs, then launch in
  the background.
- `npm run demo:check` — wait for the existing background demo to become ready,
  then verify every service and the product/runtime route. It waits up to 75
  seconds by default (`ESTACK_DEMO_CHECK_TIMEOUT_SEC` can override this) and
  never starts services itself.

State, PID files and logs live in `/workspaces/.estack-camillanode-demo/` in
Codespaces or `$XDG_CACHE_HOME/estack-camillanode-demo/` in a local Dev
Container. Inspect `<cache>/log/launcher.log`, `camilladsp-main.log`,
`camilladsp-spectrum.log`, `camillagui.log`, `camillanode.log` and
`input-demo.log` when a check fails.

The launcher only stops PIDs recorded in its own runtime directory after
checking their Linux command lines. A conflicting non-demo process on a demo
port is reported and left untouched.

## Software validation

```bash
npm ci
npx playwright install --with-deps chromium
npm run demo:restart
npm run demo:check
npm test
npm run e2e
```

`npm run e2e` uses Playwright `1.63.0` and its matching Chromium revision,
installed by `.devcontainer` with `npx playwright install --with-deps chromium`.
The browser runs inside Linux, not through Windows automation.

For a clean local validation after rebuilding the container, run the sequence
above and then repeat `npm run demo:restart` followed by `npm run demo:check`.
The second cycle proves that only demo-owned processes are cleaned up and that
the canonical readiness check remains reliable after a restart.

The Stage 0 Control test opens the product with
`?transport=camillanode`, requires loopback plus `/api/runtime` demo mode,
checks the live product surface, then performs `SUB gain -> -0.2 dB` through
the product UI. It reads back the simulated DSP through the CamillaNode
`/ws/dsp` proxy, verifies protected state, restores the original value, and
verifies the complete original live configuration in `finally` cleanup. It
refuses non-local URLs, non-Linux execution and any runtime other than the
canonical demo.

## Deferred Control Stage 1 E2E coverage

The following assertions are intentionally reserved for the next dedicated
Control parity task. They are known regressions, not accepted behaviour, and
are not weakened or marked passing in Stage 0:

- visible `.legacy-fader-handle` and `.legacy-gain-scale`;
- non-linear output fader positioning and Master positioning;
- `.level-lock`, lock persistence and disabling output-way controls while
  locked;
- Master and mute interaction remaining independent of Level Lock.

## Hardware boundary

`SIMULATION/E2E PASS != RASPBERRY HARDWARE ACCEPTANCE`.

The current Raspberry status remains **HARDWARE ACCEPTANCE PENDING**. E2E may
write only the explicitly identified local demo after its runtime guard passes;
it never performs discovery, DNS changes, tunnels or connections to Raspberry
hardware.
