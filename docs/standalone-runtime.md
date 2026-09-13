# Standalone Raspberry runtime

E-Stack DSP is installed as an independent Raspberry application:

```text
/home/bastos/e-stack-dsp
└─ estack-dsp.service (User/Group bastos)
   ├─ HTTP/UI :8080 → /estack-dsp/
   ├─ /api/*
   ├─ /ws/dsp → 127.0.0.1:1234
   └─ /ws/spectrum → 127.0.0.1:6413

camilladsp.service             main DSP, independent
camilladsp2.service            spectrum DSP, independent
estack-wiim-loudness.service   WiiM bridge, independent
```

The browser compatibility query remains `?transport=camillanode`. The persisted
filename `camillaNodeConfig.json`, temporary signal snapshot name and internal
transport/API terminology also remain compatibility contracts. They do not make
the standalone service depend on the former installation.

## Fresh standalone install

This is for a new application installation after the hardware DSP, ALSA and
CamillaDSP services have been commissioned separately:

```bash
git clone https://github.com/flashmoc/e-stack-dsp.git /home/bastos/e-stack-dsp
cd /home/bastos/e-stack-dsp
npm ci --omit=dev --no-audit --no-fund
npm run check
bash scripts/pi-install.sh
```

`pi-install.sh` creates `estack-dsp.service`, ordered after network-online and
CamillaDSP, with exactly `/usr/bin/node`,
`NODE_ENV=production`, `NoNewPrivileges=true`, `PrivateTmp=false` and
`Restart=on-failure`. It does not install/modify CamillaDSP, ALSA or a DSP YAML.
Install startup recall and WiiM only as separately accepted integrations.

## Migration from the hardware-accepted installation

The one-time migration source is retained at `/home/bastos/camillanode`, SHA
`16385076c553eaf4d5b26e90fc96f04969ee026f`. Prepare a reviewed commit on
`feature/standalone-runtime`, then extract the migration tools without changing
the running checkout:

```bash
cd /home/bastos/camillanode
REVIEWED_SHA='<full reviewed standalone commit SHA>'
git ls-remote https://github.com/flashmoc/e-stack-dsp.git \
  refs/heads/feature/standalone-runtime
TOOLS="$(mktemp -d)"
git -C "$TOOLS" init
git -C "$TOOLS" fetch https://github.com/flashmoc/e-stack-dsp.git "$REVIEWED_SHA"
git -C "$TOOLS" archive FETCH_HEAD scripts | tar -x -C "$TOOLS"

ESTACK_BRANCH=feature/standalone-runtime \
ESTACK_EXPECTED_SHA="$REVIEWED_SHA" \
bash "$TOOLS/scripts/pi-migrate-standalone.sh" --yes
```

The script refuses alternate roots/users, an unreviewed SHA, a dirty application
checkout, Node below 22, non-8080 HTTP configuration, insufficient disk, missing
service topology, unresolved startup state, temporary Signal/Measurement state,
SignalGenerator capture or invalid DSP topology. All preflight interactions are
read-only (`GetState`, `GetConfigJson`, `GetVolume` and GET status APIs).

For the verified `specific` startup mode, the target preset must exist and the
persisted `lastBootIdApplied` must equal the current Linux boot ID. This preserves
startup semantics while preventing the new service start from unexpectedly
reapplying processing during migration.

Before staging, a persistent backup outside both repositories records runtime
bytes/modes/hashes, old Git bundle/status, direct DSP evidence, listening ports,
effective status/cat/show/fragment and enabled/active state for:

- `camillanode.service`;
- `estack-dsp.service`;
- `camilladsp.service`;
- `camilladsp2.service`;
- `estack-wiim-loudness.service`.

The exact reviewed checkout is cloned to a temporary sibling, production
dependencies and repository checks run, and only the fixed runtime allowlist is
copied with symlink rejection. The final target appears only after staging passes.

Cutover stops WiiM and the legacy application, installs `estack-dsp.service`,
updates the future startup recall path, overlays the spectrum ExecStart with the
same command and new YAML root, and overlays the WiiM working/config/script paths.
It starts E-Stack DSP, restarts only `camilladsp2.service`, starts WiiM, performs
the complete read-only smoke check and confirms the main CamillaDSP PID did not
change. Only then is `camillanode.service` disabled.

The migration never restarts `camilladsp.service`, never applies a DSP snapshot,
never changes Master/processing, never modifies ALSA, and never reboots. The old
directory and unit remain present until hardware acceptance explicitly permits
removal.

## Rollback

Migration prints a command using the backup's own toolkit:

```bash
bash /home/bastos/estack-backups/<migration-backup>/toolkit/pi-migrate-standalone-rollback.sh \
  /home/bastos/estack-backups/<migration-backup> --yes
```

Rollback verifies all backup hashes and the unchanged main DSP PID, stops the
new application/WiiM/spectrum services, restores the exact backed-up `/etc`
units/drop-ins, runtime state and old enablement, then restarts spectrum, WiiM
and the old application only when they were active before migration. The new
directory is retained but inactive for diagnosis. It never applies DSP evidence,
restarts main CamillaDSP or reboots.

## Hardware acceptance boundary

The scripts and fixtures can be software-tested without a Raspberry. That does
not accept systemd cutover or hardware behavior. After a separately authorized
physical run, verify UI/API, exact DSP config/Master, spectrum, specific startup
metadata, WiiM state and reboot behavior before removing the old installation.
