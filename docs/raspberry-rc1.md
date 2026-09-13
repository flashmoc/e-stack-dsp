# Raspberry RC1: deployment preparation

**DEPLOYMENT SCRIPTS SOFTWARE-VALIDATED — PHYSICAL RASPBERRY DEPLOYMENT PENDING.**

Software base: `e4929159b86690191cdfc51eac35bc21310acf5b`.
Release branch: `release/raspi-rc1`. The development branch and
`camilladsp-4.1-estack` remain unchanged. RC1 updates CamillaNode application
code/dependencies only. Do not run `setup.sh`, either optional integration
installer, or copy anything from `setupFiles/` for this procedure.

## Preparation (before any Raspberry session)

Review and publish the release branch separately. Record its **full reviewed
40-character commit SHA**. Do not use the software base SHA as the deployment
SHA: the reviewed RC must include these deployment tools.

Use the existing Raspberry account and checkout, with permission to read the
running CamillaNode process environment and all runtime files, and permission
to stop/restart **only camillanode.service** through sudo. The scripts do not
use SSH or discover hosts. Every DSP/HTTP connection is local loopback.

Supported RC runtime: **Node 22 LTS minimum**, current security patch preferred;
Node 24 LTS is also within policy. Software tests use Node 22. Newer versions
produce WARN until separately validated; known EOL odd releases fail. Node 20
and older fail. This is a maintained-runtime decision, not an invented Node 22
application syntax requirement: the locked production dependencies are Express
4 and ws 8 (the highest declared production Node floor is ws's Node 10); the
server uses optional chaining/nullish coalescing, and the deployment helper uses
`fs.statfsSync` (available since Node 18.15). Neither justifies Node 22 by itself.
However, Node 20 reached EOL on 2026-04-30; Node 22 is the oldest maintained LTS
at the 2026-09 release audit. See the [official Node release schedule](https://github.com/nodejs/Release#release-schedule).
No automatic Node/npm upgrade is performed. npm 7+ supports the lockfile v2 and
`--omit=dev`; the Node 22 bundled npm is preferred. Git must support `switch`
(2.23+). Linux bash/coreutils, util-linux (`flock`), iproute2 (`ss`), systemd
and the existing application's installed `ws` dependency are required.

Keep sufficient space for a persistent Git bundle, runtime files and npm install
on both the backup and checkout filesystems. Preflight reports disk/memory and
fails below 512 MiB free on the checkout filesystem; that floor is not a backup
size estimate. A failed/incomplete backup cannot authorize deployment.

## Canonical first-RC procedure (operator, later)

This also works when the existing checkout lacks the new scripts. Fetching and
extracting the reviewed tools changes Git metadata/a separate temporary directory,
not the checkout, running service or hardware config. Confirm origin is the
expected repository before fetching. The deploy script verifies the exact HTTPS
origin and does not rewrite it.

```bash
cd ~/camillanode
git remote get-url origin
# Expected: https://github.com/flashmoc/e-stack-dsp.git
REVIEWED_SHA='<full reviewed RC commit SHA>'
git fetch origin refs/heads/release/raspi-rc1:refs/remotes/origin/release/raspi-rc1
test "$(git rev-parse refs/remotes/origin/release/raspi-rc1)" = "$REVIEWED_SHA" || exit 1
RC_TOOLS="$(mktemp -d)"
git archive "$REVIEWED_SHA" scripts | tar -x -C "$RC_TOOLS"

# Optional read-only preview of the gate; it creates no backup and changes nothing.
ESTACK_ROOT="$PWD" bash "$RC_TOOLS/scripts/pi-preflight.sh"

# Close all DSP operator UIs and stop external automation through its own
# acceptance procedure first. This performs its own fresh preflight and backup.
ESTACK_ROOT="$PWD" \
ESTACK_BRANCH=release/raspi-rc1 \
ESTACK_EXPECTED_SHA="$REVIEWED_SHA" \
bash "$RC_TOOLS/scripts/pi-deploy-rc.sh"
```

Do **not** manually run `pi-backup.sh` before deploy: deploy already creates a
fresh backup. Standalone archival backups remain available as:

```bash
ESTACK_ROOT="$PWD" bash "$RC_TOOLS/scripts/pi-backup.sh"
```

The default destination is `$HOME/estack-backups/<UTC timestamp>-<unique suffix>/`.
`ESTACK_BACKUP_BASE` may select another persistent filesystem outside the checkout.
Backups contain private configuration: keep the default restrictive permissions,
do not publish them, and retain at least the pre-RC backup through acceptance.

## Read-only preflight

Reports host/OS/architecture/kernel/user/time/disk/memory, git/node/npm versions,
root/origin/branch/SHA/status/upstream, systemd status and effective unit text,
listening ports, configured HTTP port (same default **80** as `index.js`, not the
installer's newly-created 8080 config), main DSP 1234 and spectrum 6413.

Reads `GetState`, `GetConfigJson`, `GetVolume`: sample rate, chunksize, devices,
capture/playback channels, mixers, six operator outputs and named gain/delay/hard
limiter anchors, compressor protection and crossover edges. Missing required
operator/protection anchors or unresolved pipeline references **FAIL**. Absent
lazy-created Input Trim/Input Delay/Global EQ anchors **WARN**, never get created.
Presence does not establish correct acoustic routing/calibration. Missing
spectrum during preflight **WARN**; the post-deploy spectrum proxy must work.

Any Signal Generator snapshot, any Measurement Batch session file (including
invalid/stale/unreadable state), or live `SignalGenerator` capture **FAIL**.
Read-only status APIs supplement filesystem checks; older APIs may be unavailable.
Recovery belongs to those workflows, never to deployment scripts.

Missing startup state or `mode: yaml` **PASS**. `specific` or `last` **FAIL**,
even if a boot ID suggests recall already ran. Invalid state **FAIL**. Nothing
rewrites `startupConfig.json`. An explicitly accepted later operator can set
`ESTACK_ALLOW_STARTUP_RECALL=1` to downgrade specific/last to WARN: restarting
CamillaNode can then **write processing/Master**. This override is outside the
conservative first-RC command and does not bypass temporary workflow checks.

The scripts conservatively refuse nonstandard service arguments, pre/post/stop
hooks, failure/success actions, stop propagation, dependants, socket activation,
private `/tmp`, environment files/runtime overrides, mismatched working directory
or Node executable, inactive service dependencies and an active WiiM bridge.
These need separate inspection/acceptance, not an automatic bypass. Optional
services may be absent. Standard `After=camilladsp.service` ordering is fine;
no new ordering or recall hooks are installed. A root-owned process environment
that the operator cannot read also fails closed; arrange appropriate local
permissions during the separately authorized hardware phase.

## Persistent backup and consistency

`manifest.json` records host/time/root/SHA/branch/upstream/Node/npm/port and a
SHA-256/mode inventory. `repository.bundle` preserves the old Git HEAD offline.
The toolkit survives checkout changes and carries the already-installed `ws`
library independently, so rollback diagnostics still work after a failed npm
installation. Runtime copies preserve bytes and modes:

```text
camillaNodeConfig.json        currentConfig.json
savedConfigs.dat              startupConfig.json
wiimLoudnessConfig.json       wiimLoudnessStatus.json
config/ (including measurement definitions)
setupFiles/spectrum_{preview,real,white}.yml
setupFiles/spectrum_{preview,real,white}.yml.bak
```

Copies/snapshots also include Git status and tracked differences; `systemctl
status/cat/show` for CamillaNode, main DSP, `camilladsp2.service`, detected spectrum
units and WiiM (effective fragments/drop-ins, ExecStart and visible YAML paths);
listening ports; actual DSP config/Master/state in `dsp-evidence.json`.
Missing optional units are recorded, not installed. The textual effective unit
snapshots are evidence, not files to install during rollback. External custom
runtime paths require separate audit and are refused by this RC's service gate.

The backup fails if runtime bytes/modes change while copying. Deployment then
stops only CamillaNode, repeats direct DSP/startup/session safety reads and checks
runtime against that backup. Any intervening change aborts **before code update**,
with the backup and rollback command retained. This prevents writing against a
mixed persistence snapshot. Keep other operators/automation inactive throughout.
No script can lock out unrelated external CamillaDSP clients.

## Deploy CamillaNode

1. Read-only preflight; abort on FAIL.
2. Fetch the explicit RC branch once, resolve immutable SHA, compare optional
   `ESTACK_EXPECTED_SHA`, verify accepted software-base ancestry.
3. Persistent backup; print its path. All subsequent tools run from that backup.
4. Briefly stop only CamillaNode to freeze its writes; recheck startup/temp state
   and backup consistency. No DSP stop/restart.
5. Reuse `pi-update.sh` runtime-preserving code update in explicit code-only mode;
   fast-forward to the already-fetched immutable SHA, no second branch fetch.
6. `npm ci --omit=dev --no-audit --no-fund`, `npm run check`.
7. Restart **camillanode.service only**, wait up to 30 checks for `/api/runtime`.
8. Read-only smoke. Print previous/deployed SHA, backup path and exact rollback.

Existing normal updater still defaults to `camilladsp-4.1-estack`. Its runtime
list now includes WiiM files and every listed spectrum backup; a failure after
normalizing legacy tracked state restores the temporary runtime copy before exit.
It is not a substitute for the persistent RC backup/orchestrator.

No CamillaDSP/main/spectrum restart, no reboot, no ALSA/RASPIAUDIO/YAML changes,
no service installation/enabling, no System Apply/Signal/Measurement POST.
The only service stopped/restarted is CamillaNode. On failure, logs/status and a
rollback command are printed; it may remain stopped. Nothing silently continues.

## Read-only smoke

```bash
ESTACK_ROOT="$PWD" bash "$RC_TOOLS/scripts/pi-postdeploy-check.sh"
```

Requires 200/valid responses for runtime, final product shell/title, all ten page
HTML resources, System Presets, Startup, loudness preset/settings/bridge, Signal
status and Measurement status. Reads main `/ws/dsp` config/state/Master and
`/ws/spectrum` state. No redirects to arbitrary routes, no POST, no Set commands.
Backend failures fail smoke; an unavailable optional WiiM bridge can be reported
by its successful read-only API without requiring its installation.

`ESTACK_CHECK_PORT=8080` exists solely for local demo read-only smoke validation;
deploy and rollback reject this diagnostic override. The actual Raspberry port
comes from its local configuration and must match service configuration.

## Rollback (CamillaNode only)

Use the **backup toolkit** command printed by deployment, not scripts from a
potentially broken/current checkout:

```bash
ESTACK_ROOT="$HOME/camillanode" \
bash "$HOME/estack-backups/<backup>/toolkit/pi-rollback.sh" \
     "$HOME/estack-backups/<backup>" --yes
```

Without `--yes`, type `RESTORE` at the prompt. The manifest's root/host/SHA and
runtime hashes/modes are checked. Local code edits refuse rollback. Current and
backed-up startup state and temporary workflows are checked first; if either
would trigger recall, the same explicit startup override is required. The old
revision comes from the verified local Git bundle. CamillaNode alone is stopped;
the previous revision is checked out **detached** (no stable branch movement),
runtime files restored, files absent in the backup removed from the audited
runtime path list, production dependencies reinstalled and checks run. CamillaNode
alone restarts, `/api/runtime` must become healthy. Branch/upstream history remains
in the manifest; rollback intentionally does not rewrite a remote or stable branch.
The repository check is run when present; a legacy pre-product revision may not
define `npm run check`, so absence alone does not prevent rollback health checks.

The DSP snapshot is **evidence only**. Rollback never sends `SetConfigJson` or
`SetVolume`, never restores a YAML or systemd unit, and never restarts DSP. It
does not undo audio changes made during later hardware acceptance. If a temporary
workflow is stranded, recover it through its separately accepted workflow before
retrying; do not delete snapshots to bypass the gate.

## Software gate and remaining acceptance

Linux Dev Container: bash syntax for all `scripts/pi-*.sh`; focused selftests
(runtime/version/startup/temporary-state/read allowlists, Git pinned update/failure
restoration and runtime rollback); read-only smoke against canonical demo;
`npm run demo:restart`, `npm run demo:check`, `npm test`, `npm run e2e`.
ShellCheck is optional and was unavailable in the validation container.
Systemd execution and physical Raspberry deployment were **not** tested.

Validation recorded for this preparation: `demo:restart` PASS, `demo:check`
PASS, `npm test` PASS (18 existing selftest scripts plus 11 deployment fixture
cases), full E2E **25 passed / 0 failed**. Playwright's existing output folder was
not writable by the container's `node` account; the successful full run used
`npm run e2e -- --output=/tmp/estack-rc1-e2e-results` with unchanged tests.
Read-only smoke passed with exact before/after DSP configuration and Master
comparison. Bash syntax and JavaScript syntax checks passed. The systemctl
fixture tests refusal logic only; they are not a real systemd deployment test.

After independent review, hardware acceptance is a new task, in this order:

1. CamillaNode/live UI/read-only topology and hardware I/O observation.
2. Narrow DSP controls and physical limiter/routing calibration.
3. Signal Generator with exact restoration.
4. Measurement Batch with exact restoration.
5. WiiM Loudness bridge (separately review `install-wiim-loudness.sh`).
6. System Preset startup recall (separately review `install-startup-recall.sh`).
7. Reboot behavior and verified rollback.
8. Independent acceptance and explicit promotion to `camilladsp-4.1-estack`.

No optional integration or promotion is part of RC1 deployment preparation.
