# Raspberry Pi deployment

## Scope

The deployment scripts manage the standalone **E-Stack DSP application only**.
They do not install or rewrite CamillaDSP, ALSA, RASPIAUDIO configuration or
the live DSP YAML. The canonical root/service are `/home/bastos/e-stack-dsp`
and `estack-dsp.service`; see the [standalone migration guide](standalone-runtime.md).

## Historical first software-complete release candidate

The [RC1 preparation and acceptance procedure](raspberry-rc1.md) documents the
pre-standalone CamillaNode deployment that produced the hardware-accepted base.
For current installations use the standalone guide. RC1 used
`release/raspi-rc1`, based on `e4929159b86690191cdfc51eac35bc21310acf5b`.
It adds read-only preflight, a persistent backup, exact commit pinning, a
CamillaNode-only deploy, read-only smoke and deterministic application rollback.
The normal updater's default remains `camilladsp-4.1-estack`.

**DEPLOYMENT SCRIPTS SOFTWARE-VALIDATED. PHYSICAL RASPBERRY DEPLOYMENT PENDING.**

## Existing pre-standalone E-Stack Raspberry

### One-time migration

Do not convert `/home/bastos/camillanode` with the normal updater. Use
`scripts/pi-migrate-standalone.sh` from the reviewed standalone branch. It keeps
the old checkout/unit for rollback and performs the systemd cutover only after
read-only preflight, persistent backup and exact-SHA staging.

### Normal updates after migration

From the existing checkout:

```bash
cd /home/bastos/e-stack-dsp
bash pi-update.sh
```

The update sequence is:

1. abort if local application code has uncommitted edits;
2. copy machine-local runtime files to a temporary backup;
3. normalize legacy tracked runtime files when needed;
4. fast-forward the `camilladsp-4.1-estack` branch;
5. restore runtime state;
6. run `npm ci --omit=dev`;
7. run `npm run check`;
8. restart `estack-dsp.service` if it exists;
9. verify the local `/api/runtime` endpoint.

Runtime files preserved by the updater:

```text
camillaNodeConfig.json
currentConfig.json
savedConfigs.dat
startupConfig.json
wiimLoudnessConfig.json
wiimLoudnessStatus.json
config/
setupFiles/spectrum_{preview,real,white}.yml
setupFiles/spectrum_{preview,real,white}.yml.bak
```

If the update script reports local **code** changes, inspect them before continuing. Do not force/reset a Raspberry that contains unidentified hardware-specific edits.

## Fresh standalone E-Stack DSP service

Clone the branch, then run:

```bash
git clone https://github.com/flashmoc/e-stack-dsp.git /home/bastos/e-stack-dsp
cd /home/bastos/e-stack-dsp
bash setup.sh
```

`setup.sh` installs production Node dependencies, creates the compatibility
`camillaNodeConfig.json` with port `8080` when missing, validates the repository
and creates `/etc/systemd/system/estack-dsp.service` for the current Linux user.

The generated unit uses the actual `node` binary path and current checkout path. `CAP_NET_BIND_SERVICE` is granted so an existing low HTTP port can still be used without running the whole Node process as root.

## Useful checks

```bash
sudo systemctl status estack-dsp --no-pager
journalctl -u estack-dsp -n 80 --no-pager
ss -ltnp | grep -E '8080|80|1234|6413'
npm run check
```

The application health endpoint is:

```text
/api/runtime
```

It exposes only runtime mode and endpoint ports; it does not expose the DSP configuration.

## Safety

The Signal Generator stores its temporary normal-config snapshot under `/tmp`
with restrictive permissions. If E-Stack DSP restarts while the capture device
is still a test generator, the backend attempts to restore the normal configuration automatically.

The Raspberry updater never deliberately edits the main CamillaDSP configuration. A UI update should therefore remain separate from hardware routing and limiter commissioning.

E-Stack DSP startup may recall a selected System Preset or recover a temporary
Measurement/Signal session. The RC preflight refuses these states by default;
normal legacy updates do not provide that RC gate. No optional startup hook or
WiiM service is installed by the RC deploy script.
