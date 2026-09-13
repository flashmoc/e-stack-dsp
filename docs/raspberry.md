# Raspberry Pi deployment

## Scope

The deployment scripts in this repository manage **CamillaNode only**. They do not install or rewrite CamillaDSP, ALSA, RASPIAUDIO configuration or the live DSP YAML.

## First software-complete release candidate

Use the [RC1 preparation and acceptance procedure](raspberry-rc1.md) for
`release/raspi-rc1`, based on `e4929159b86690191cdfc51eac35bc21310acf5b`.
It adds read-only preflight, a persistent backup, exact commit pinning, a
CamillaNode-only deploy, read-only smoke and deterministic application rollback.
Do not use the bootstrap/setup instructions below to commission RC1 hardware.
The normal updater's default remains `camilladsp-4.1-estack`.

**DEPLOYMENT SCRIPTS SOFTWARE-VALIDATED. PHYSICAL RASPBERRY DEPLOYMENT PENDING.**

## Existing E-Stack Raspberry

### First update from a legacy checkout

Older E-Stack checkouts tracked runtime files such as `camillaNodeConfig.json` and saved configs. They also do not yet contain the new safe updater. Bootstrap the first cleanup update directly from the current branch while explicitly pointing it at the existing checkout:

```bash
curl -fsSL https://raw.githubusercontent.com/flashmoc/e-stack-dsp/camilladsp-4.1-estack/scripts/pi-update.sh \
  | ESTACK_ROOT="$HOME/camillanode" bash
```

The updater first accepts differences only in known runtime paths, backs those files up, normalizes the old tracked copies, fast-forwards Git, then restores the runtime snapshot. Unknown application-code edits still abort the migration.

### Normal updates after migration

From the existing checkout:

```bash
cd ~/camillanode
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
8. restart `camillanode.service` if it exists;
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

## Fresh CamillaNode service

Clone the branch, then run:

```bash
git clone --branch camilladsp-4.1-estack --single-branch \
  https://github.com/flashmoc/e-stack-dsp.git ~/camillanode
cd ~/camillanode
bash setup.sh
```

`setup.sh` installs production Node dependencies, creates `camillaNodeConfig.json` with port `8080` when missing, validates the repository and creates `/etc/systemd/system/camillanode.service` for the current Linux user.

The generated unit uses the actual `node` binary path and current checkout path. `CAP_NET_BIND_SERVICE` is granted so an existing low HTTP port can still be used without running the whole Node process as root.

## Useful checks

```bash
sudo systemctl status camillanode --no-pager
journalctl -u camillanode -n 80 --no-pager
ss -ltnp | grep -E '8080|80|1234|6413'
npm run check
```

The application health endpoint is:

```text
/api/runtime
```

It exposes only runtime mode and endpoint ports; it does not expose the DSP configuration.

## Safety

The Signal Generator stores its temporary normal-config snapshot under `/tmp` with restrictive permissions. If CamillaNode restarts while the capture device is still a test generator, the backend attempts to restore the normal configuration automatically.

The Raspberry updater never deliberately edits the main CamillaDSP configuration. A UI update should therefore remain separate from hardware routing and limiter commissioning.

CamillaNode startup may recall a selected System Preset or recover a temporary
Measurement/Signal session. The RC preflight refuses these states by default;
normal legacy updates do not provide that RC gate. No optional startup hook or
WiiM service is installed by the RC deploy script.
