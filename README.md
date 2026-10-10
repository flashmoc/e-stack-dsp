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
- **Measurement Batch** — imported REW calibration sequences and a one-click snapshot of the current DSP system, both with automatic restoration.
- **Advanced** — read-only live CamillaDSP topology inspection.
- **Preferences / Connections** — E-Stack UI and DSP endpoints.

The internal test generator is injected as the CamillaDSP **capture source**, so the test signal traverses the real downstream chain:

`SignalGenerator → mixer/routing → crossover → PEQ → gain/delay/phase → protection → output`

For REW sweeps, **stop the internal Signal Generator** and choose the appropriate Measurement Batch mode:

- **Measure current system (MEASURE NOW):** uses physical **IN3** at **0 dB mixer-source gain** and captures the currently running DSP at each start. Keeps the selected ways' Control gains and mute states, EQ, crossover, delays, polarity, protections, Input Trim and Loudness. Unselected ways are muted temporarily. To exclude a way completely, deselect it or mute it before starting; **−60 dB gain is not mute**. Keep WiiM volume fixed if Loudness is enabled.
- **Imported calibration campaign:** imports a JSON measurement sequence and captures one baseline at **START BATCH**; each step derives from that original baseline. Selected ways are unmuted, unlisted ways muted by default, relative gain offsets may only attenuate, and Input Trim/Loudness are forced off. Optional `measurementInput` routes a chosen physical IN1–IN8 to the six logical outputs at 0 dB mixer-source gain; otherwise captured mixer routing remains.

Both modes temporarily lower Master to at most −60 dB during configuration swaps, leave hardware `devices` unchanged, display actual applied DSP processing, and restore the captured processing/routing on finish or abort. See [Measurement Batch documentation](docs/measurement-batch.md) for configuration, diagnostics and API details.

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
