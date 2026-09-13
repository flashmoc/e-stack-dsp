# E-Stack DSP

E-Stack DSP is a standalone web control application for a multi-way CamillaDSP
loudspeaker system. It provides speaker management, measurement and protection
workflows through the existing CamillaDSP runtime.

## Current UI

- **Control** — input meters, output levels and mutes.
- **Loudness** — master-linked loudness compensation.
- **Input Processing** — global L/R PEQ and input delay.
- **Output Processing** — per-way crossover, PEQ, gain, delay, polarity, phase, dynamics/limiter, magnitude graph, phase graph and XO Align.
- **Signal Generator** — protected internal sine or full-band white-noise source with per-way routing and automatic restore.
- **Advanced** — read-only live CamillaDSP topology inspection.
- **Preferences / Connections** — E-Stack UI and DSP endpoints.

The internal test generator is injected as the CamillaDSP **capture source**, so the test signal traverses the real downstream chain:

`SignalGenerator → mixer/routing → crossover → PEQ → gain/delay/phase → protection → output`

For REW sweeps, leave the internal generator off and send the REW sweep through the normal E-Stack input.

## Repository layout

```text
index.js                     E-Stack DSP HTTP/WebSocket server
server/                      server-only E-Stack features
public/html/                 active pages
public/src/                  browser DSP/UI modules
public/css/                  active UI styles
dev/                         Codespaces/demo CamillaDSP environment
scripts/                     repository checks and Raspberry deployment
docs/                        E-Stack architecture/deployment notes
config/                      machine-local saved configs (.gitkeep only)
```

Machine-local runtime state is intentionally not tracked by Git:

- `camillaNodeConfig.json`
- `currentConfig.json`
- `savedConfigs.dat`
- `config/*.json`

## Development simulation

The canonical software environment is Linux in the repository Dev Container:
it is identical in Codespaces and on a Windows workstation with Docker Desktop.
Run `npm run demo:check`, `npm test` and `npm run e2e` inside that container.
See [development simulation and E2E](docs/development.md) for the full workflow,
ports, logs, restart procedure and the separate Raspberry acceptance boundary.

## Raspberry Pi

This repository deliberately does **not** install, replace or reconfigure CamillaDSP, ALSA, the RASPIAUDIO device or the DSP YAML during an application update.

For an existing standalone E-Stack DSP checkout:

```bash
cd /home/bastos/e-stack-dsp
bash pi-update.sh
```

The updater preserves machine-local runtime state, performs a fast-forward-only
Git update, installs production Node dependencies, runs repository checks,
restarts `estack-dsp.service` when present and verifies `/api/runtime`.

For a fresh standalone application/service install after cloning the repository:

```bash
git clone https://github.com/flashmoc/e-stack-dsp.git /home/bastos/e-stack-dsp
cd /home/bastos/e-stack-dsp
bash setup.sh
```

Existing `/home/bastos/camillanode` installations must use the guarded
[standalone migration](docs/standalone-runtime.md), which retains the old root
and service for rollback. See [docs/raspberry.md](docs/raspberry.md) before a
hardware deployment.

## Documentation and architecture

Start with [docs/README.md](docs/README.md). The canonical future architecture
is [E-Stack DSP](docs/estack-dsp-architecture.md); the legacy frontend
architecture remains available as behavioral reference during migration.

## License

MIT. The project is derived from CamillaNode by Ismail Ataman; the original copyright and MIT terms are retained in [LICENSE](LICENSE).
