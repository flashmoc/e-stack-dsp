# System Presets and Startup Configuration

The shell opens this workspace in a dialog from the System Presets button
beside CamillaGUI; it is not a tuning navigation tab. The same live page and
server APIs handle choosing, saving, renaming, applying, deleting and startup
selection. A direct `#system-presets` URL opens the dialog above Control;
closing it returns to the underlying tuning page. On phone the separate
Presets button remains available beside the page selector. The standalone
page URL remains usable for diagnostics and existing integrations.

Saved systems can be renamed by ID through /api/system-presets/rename. Names
must be unique within estack-system. Snapshot data, ID and creation date remain
unchanged; active/startup/last-used/boot-applied reference names follow the rename.

Export is available for the **current live system** and for each saved preset.
The export dialog offers a downloadable `.json` file or formatted JSON text
that the operator can copy into a measurement-planning conversation. Live export
contains the complete read-only `GetConfigJson` snapshot, its revision and
current Master, including mixer routing, hardware channel/device details and
unsaved edits. Configuration and Master are reread before export; a concurrent
change makes the export fail so the operator can retry. It
is refused while Signal Generator or Measurement Batch is active, or while DSP
capture is SignalGenerator, so temporary routing is not mistaken for a baseline.
A saved-preset export contains its stored processing and Master but no claim
about current hardware, mixer routing or unsaved live changes. Both exports
have schema `estack.system-export`, version 1 and an explicit `scope`. They may
contain local device names or paths; sharing remains an operator action. Export
never changes DSP, startup state or saved records.

Software validation uses the canonical Linux demo. Raspberry hardware acceptance
is pending; this feature does not change hardware YAML or deployment scripts.

## Ownership and format

`server/startupConfiguration.js` is the single owner. The historical record is
retained: `{id, type: "estack-system", name, createdDate, data: {version: 1,
sourcePage, processing: {title, filters, pipeline, processors}, masterVolume}}`.
Old optional `data.ui` remains readable historical metadata, not operational truth.
New captures use live DSP processing, not browser disabled-band preferences.
Pipeline membership remains the saved enable/disable processing truth.

Devices, ALSA configuration, sample rate, chunksize, mixer definitions/mappings,
hardware channels, clock and services are excluded. Recall clones the live
configuration and replaces only filters, processors, pipeline and display title.

## Product operations

- `GET /api/system-presets`: live current/startup state, saved summaries and
  temporary-workflow block state.
- `POST /api/system-presets/capture`: `{name, overwrite?: true}`. Server captures
  live processing and Master. Update preserves ID and creation date; no rename.
- `POST /api/system-presets/apply`: `{id}` selects an existing server record.
  No uploaded browser processing graph is accepted.
- `POST /api/system-presets/delete`: `{id}`. Active, specific startup and
  last-used references prevent deletion. No automatic fallback on deletion.
- `GET /api/system-presets/export?scope=live` or
  `?scope=preset&id=<id>`: read-only, explicitly scoped JSON for download or
  copying. The live scope is guarded against temporary workflows.
- `GET/POST /api/startup-config`: existing startup state and future boot choice.
  The legacy `/active` endpoint now verifies processing and Master before marking.

Apply runs under the shared server workflow gate: inspect live state, attenuate
Master to -60 dB, validate references and hardware mixer/channel compatibility,
replace allowed processing, read back and compare the full expected config,
set intended Master and verify it, then update active/last-used metadata.
Failures attempt to retain -60 dB and never mark the requested preset active.
Old presets without a recorded Master retain the established -40 dB fallback.
Embedded Master takes precedence over historical `presetVolumes`; null is not 0 dB.

Current/dirty state is server-derived from processing and Master. Unknown DSP
state is displayed as unknown. Saving is explicit and does not apply a preset.
The retained form and list nodes avoid focus loss from periodic status refreshes.

## Startup

YAML uses hardware YAML processing. Specific recalls the selected system record.
Last recalls the last successfully applied preset, not unsaved current edits.
Changing the selection does not write DSP state. Resolved target, validation
errors, current source and last boot result are displayed separately. Missing
targets retain the existing YAML fallback and visible recorded error. Boot
application failures retain attenuation and retry according to the existing
service; they are not advertised as successful recalls.

## Cross-workflow and persistence safety

System capture/apply refuse while either Signal Generator snapshot or Measurement
Batch session exists. Their transitions, timeout/recovery and system operations
share `workflowGate.js`, closing the check/start race. Existing signal/batch
limits and exact restore implementations are unchanged.

`presetStore.js` writes a uniquely named temporary file, fsyncs and renames,
preserving existing permissions. System mutations synchronously read/modify the
complete mixed collection. Global EQ collection updates use compare-and-swap
through the existing client/API, so stale collections are rejected rather than
erasing concurrent saves. Generic persistence cannot mutate system records.
Startup mode/metadata and system deletion share the workflow gate.

Coverage: focused server selftest covers capture, overwrite, mixed records,
Master transition/fallback, readback failure, references, dirty state, startup
modes and ordering. Live E2E covers actual DSP apply, both workflow exclusions,
browser actions and exact original config/Master/file restoration.

After a successful browser Apply, the System page reads back configuration and
reconciles the existing Global EQ/PEQ browser display flags with actual pipeline
membership. Neutral or absent bands use the neutral enabled presentation. This
does not write DSP state or change the Input/Output domain semantics. A failed
presentation sync reports that the preset was applied but display sync failed.
