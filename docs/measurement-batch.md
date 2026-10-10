# E-Stack Measurement Batch

Measurement Batch is the repeatable measurement-campaign layer for CamillaNode. It is designed for crossover, polarity, delay, variable-phase and level-alignment work with REW while keeping CamillaDSP hardware devices unchanged.

## Current-system measurement

`POST /api/measurement-batch/instant` with `{ "activeWays": ["SUB", "KICK", "MID_L", "MID_R", "HIGH_L", "HIGH_R"] }` starts a one-step session from the **current** live CamillaDSP processing. It does not replace the saved campaign. The server temporarily routes physical **IN3** (CamillaDSP channel 2) at **0 dB mixer-source gain** to logical destinations OUT1..OUT6, and mirrors shared pre-mixer L/R processing onto IN3. It preserves selected ways' output gain and mute, EQ, crossover, delay, polarity, input trim and loudness. Unselected ways are temporarily muted. A selected way already muted stays muted. A fresh invocation after finish/abort captures a fresh snapshot, so later Control gain changes are included. The original mixer mapping and pipeline are restored on finish/abort.

`GET /api/measurement-batch/effective` reads the **actual** DSP configuration and Master during a session, reports selected ways and a per-way filter summary, and flags any difference from the expected captured processing. The product UI shows this next to the current measurement. The 0 dB IN3 mixer gain is distinct from a way's output Gain filter. A `-60 dB` way gain is attenuation, not a true mute; to exclude a way completely, deselect it or mute it in Control before capture. A dynamic loudness filter can still change its response as the WiiM volume changes during a measurement. The current-system mode must therefore be used with a stable source level for comparable sweeps.

Imported campaigns retain their existing calibration behavior: they can reroute a dedicated measurement input, apply gain offsets, force selected ways unmuted and force loudness/input trim off. Those values derive from the single baseline captured at `START BATCH`, even if Control changes later while the campaign remains active.

## Design invariants

1. **The live DSP state at `START BATCH` is the baseline.** Every measurement is rebuilt from that same captured baseline plus a small validated delta. Steps never accumulate changes from the previous step.
2. **Hardware devices are never replaced by the batch runner.** Capture/playback device ownership stays with the current live CamillaDSP configuration. Mixer routing is normally copied from the captured baseline; when `measurementInput` is configured, only the first E-Stack mixer's OUT1..OUT6 source routing is temporarily replaced so the selected physical input feeds the measurement ways.
3. **A dedicated measurement input inherits shared Input L/R processing.** Any active pre-routing `Filter` stage that explicitly processes both normal channels 0 and 1 is temporarily extended to the selected measurement channel before the mixer. This keeps shared Global/Input PEQ and other shared L/R filtering in the acoustic measurement path even when REW enters through IN3/IN4. Independent L-only or R-only stages are never guessed or duplicated.
4. **Physical input numbering is one-based.** `measurementInput: 4` means physical `IN4`, which is CamillaDSP source channel `3` internally. The selected input is validated against the active mixer/capture channel count before any DSP state is changed.
5. **Master volume is attenuated during graph swaps.** The runner transitions at at most `-60 dB`, applies and verifies the processing graph and mixer routing, then restores the previous master volume.
6. **Unlisted ways are muted with their existing output Gain filters.** Crossovers, hard limiters and protection processors stay present.
7. **A batch may attenuate a way but cannot boost it above the captured baseline.** `gainOffsetDb` is limited to `-60..0 dB`.
8. **`disabledFilters` is input-processing only.** It cannot bypass output Gain, Delay, crossover, limiter or protection stages. A disabled shared Input filter is removed before measurement-input inheritance, so it is not mirrored to IN3/IN4.
9. **Crossover exploration is guarded around the captured baseline.** A requested crossover frequency must remain within `0.4x..2.5x` the corresponding baseline HPF/LPF frequency. Supported families are Linkwitz-Riley and Butterworth, order 2..8; LR orders must be even.
10. **Variable phase uses the same first-order CamillaDSP `AllpassFO` law as the manual Output Processing PHASE control.** A batch phase value is applied only after that step's crossover overrides, so an `hpf` or `lpf` phase reference follows the actual crossover frequency being measured. The phase filter description stores both requested degrees and reference frequency so Output Processing displays the same reference instead of reinterpreting a band-pass all-pass at another crossover.
11. **Baseline processing provenance is explicit.** Before START the UI shows a live preview; after START it shows the exact captured `baselineConfig` used by the session. A 12-character SHA-256-derived baseline ID fingerprints filters, pipeline, processors and mixer routing. Input EQ, per-way output EQ and dynamic input filters are listed in `VIEW BASELINE`.
12. **The exact baseline processing and mixer routing are restored on finish or abort.** A same-boot CamillaNode restart also restores the baseline. After a full Raspberry reboot the stale session is discarded so normal startup recall owns the new boot state.
13. **The E-Stack Signal Generator must be stopped before starting a batch.** The batch runner refuses to start while the managed Signal Generator snapshot is active.

## Batch format — v1

```json
{
  "schema": "estack.measurement-batch",
  "version": 1,
  "name": "KICK ↔ MID optimisation",
  "description": "Broad exploration pass",
  "defaults": {
    "muteUnlisted": true,
    "settleMs": 500,
    "measurementInput": 4,
    "disabledFilters": []
  },
  "steps": [
    {
      "id": "M01",
      "name": "KICK + MID test",
      "position": "Mic on-axis, 2.00 m",
      "instruction": "Run the sweep, then press NEXT on the iPhone.",
      "activeWays": ["KICK", "MID_L"],
      "ways": {
        "MID_L": {
          "delayOffsetMs": 0.5,
          "polarity": "normal",
          "gainOffsetDb": -1.0,
          "phase": {
            "degrees": -45,
            "reference": "hpf"
          }
        }
      },
      "crossovers": {
        "KICK": {
          "lpf": { "freqHz": 285, "family": "LinkwitzRiley", "order": 4 }
        },
        "MID_L": {
          "hpf": { "freqHz": 285, "family": "LinkwitzRiley", "order": 4 }
        }
      },
      "disabledFilters": [],
      "rew": {
        "measurementName": "M01_KICK_MID_285_PHASE_M45",
        "startHz": 120,
        "endHz": 1200,
        "levelDbfs": -20,
        "timingReference": true,
        "notes": "Crossover + phase exploration"
      }
    }
  ]
}
```

### Measurement input

`defaults.measurementInput` is optional and uses the labels printed on the physical E-Stack input side:

```json
"measurementInput": 4
```

means **physical IN4**. Internally the runner routes CamillaDSP source channel `3` at `0 dB`, non-inverted, to E-Stack mixer destinations OUT1..OUT6. Output selection is then handled by the normal per-way Gain mutes from `activeWays`.

If `measurementInput` is omitted, the batch preserves the captured baseline mixer routing. The CamillaNode Batch Editor exposes this as `BASELINE ROUTING / IN1 ... IN8`, and the active measurement page shows the selected source explicitly.

The routing is temporary. `FINISH & RESTORE`, `ABORT & RESTORE`, and same-boot restart recovery restore the exact mixer mapping captured at `START BATCH`.

### Shared Input L/R processing with IN3/IN4

A dedicated REW input must represent the same processing chain as the normal programme input. Consider this normal configuration:

```text
Input L/R → GLOBAL PEQ → Mixer → KICK/MID/... processing
```

If REW arrives on IN4 and the mixer simply selects IN4, the normal Input L/R PEQ would otherwise be bypassed. Measurement Batch therefore detects every active pre-mixer `Filter` stage whose channel list includes both normal L and R (`0` and `1`) and temporarily adds the selected REW channel to that same stage.

Example while measuring from IN4:

```text
normal baseline stage: channels [0, 1] → GLOBAL_EQ_162
measurement stage:     channels [0, 1, 3] → GLOBAL_EQ_162
```

The actual filter definition is not copied or modified; only the temporary stage channel membership is extended. This means the dedicated measurement source receives exactly the same shared PEQ/filter object. On restore the original `[0, 1]` stage returns.

Independent L-only or R-only stages are not automatically inherited because there is no safe way to infer which side should define a mono measurement reference. If a future system configuration needs that behavior it must be made explicit rather than guessed.

### Baseline Processing provenance

The Measurement Batch header contains a compact **BASELINE PROCESSING** strip:

```text
BASELINE PROCESSING · LIVE/CAPTURED · ID 12AB34CD56EF · INPUT EQ n · KICK EQ n · MID L EQ n · OUT EQ n · VIEW BASELINE
```

Before START, `LIVE` is an advisory preview fetched from the current CamillaDSP configuration. When START captures the session, the strip becomes `CAPTURED` and the source of truth is the exact `baselineConfig` already persisted for batch restore.

`VIEW BASELINE` shows:

- baseline fingerprint;
- measurement source and whether shared Input L/R filtering is mirrored to it;
- all active Input/Global filters, including PEQ parameters such as frequency, gain and Q;
- active per-way output EQ for SUB, KICK, MID L/R and HIGH L/R;
- warnings for dynamic input processing such as an active Loudness filter.

The baseline ID is the first 12 hexadecimal characters of a SHA-256 fingerprint over the captured filters, pipeline, processors and mixer routing. It is not a preset name: two campaigns with the same visible preset name but different DSP processing will receive different IDs.

For system calibration, dynamic Loudness should normally be disabled/reference unless the campaign is specifically intended to characterize that dynamic listening mode. The baseline warning exists to make such accidental processing visible before a long measurement run.

### Ways

Canonical keys:

- `SUB` → OUT1 / channel 0
- `KICK` → OUT2 / channel 1
- `MID_L` → OUT3 / channel 2
- `MID_R` → OUT4 / channel 3
- `HIGH_L` → OUT5 / channel 4
- `HIGH_R` → OUT6 / channel 5

Human aliases such as `MID L`, `MID-L`, `HIGH R` are accepted and normalized.

### Way deltas

- `delayMs`: absolute delay for the measurement.
- `delayOffsetMs`: offset from the captured baseline delay. Cannot be used together with `delayMs`.
- `polarity`: `normal` or `inverted`.
- `gainOffsetDb`: attenuation relative to baseline; positive values are rejected.
- `phase`: variable phase trim from `-179..0°` implemented with a first-order all-pass. `0°` removes the E-Stack phase filter for that step.

The compact phase form uses the same automatic reference rule as the manual PHASE control:

```json
"phase": -45
```

For crossover optimisation, explicit references are preferred:

```json
"phase": { "degrees": -45, "reference": "hpf" }
```

or:

```json
"phase": { "degrees": -45, "reference": "lpf" }
```

This matters for a band-pass way such as `MID_L`, which has both an HPF and an LPF. For a KICK↔MID campaign the MID phase should normally reference its **HPF**; for a MID↔HIGH campaign it should normally reference the MID **LPF**. A fixed experimental reference is also supported:

```json
"phase": { "degrees": -45, "referenceHz": 300 }
```

When `reference` is `hpf` or `lpf`, the phase all-pass is calculated **after** the step's crossover change. Example: if the MID HPF is changed from 300 Hz to 275 Hz in the same step, `-45° @ hpf` is recalculated as `-45° @ 275 Hz` rather than reusing the previous all-pass frequency.

### Crossover deltas

`hpf` and `lpf` may be a frequency number or an object containing:

- `freqHz`
- `family`: `LinkwitzRiley` or `Butterworth`
- `order`: integer 2..8; Linkwitz-Riley must be even.

The runner discovers the actual post-routing crossover filter on the requested way from the live baseline. It does not depend on frequency-bearing filter names such as `kick_lpf_300_lr24`.

### REW metadata

The `rew` object is informational in the first semi-automatic implementation. CamillaNode displays it and returns it through the API so the user knows exactly what sweep/name to use. The schema is intentionally compatible with a future REW API agent.

## REST API

### State

```http
GET /api/measurement-batch/status
```

Returns batch metadata, complete sequence, progress, current measurement, next measurement and a human-readable `message` suitable for an iPhone Shortcut notification. `batch.defaults.measurementInput` identifies the physical measurement source when configured. During an active session the response also contains `baseline`, summarized from the captured session baseline.

### Baseline processing

```http
GET /api/measurement-batch/baseline
```

When no batch session is active this fetches CamillaDSP and returns a `LIVE` baseline preview. During a session it never summarizes the temporarily modified measurement state: it reads the session's persisted `baselineConfig` and returns that exact `CAPTURED` reference instead.

### Import

```http
POST /api/measurement-batch/import
Content-Type: application/json

{ "batch": { ... } }
```

The UI performs this automatically when a JSON file is selected or the structured Batch Editor saves a draft.

### Start / advance

```http
POST /api/measurement-batch/next
```

`next` is intentionally smart:

- no active session → captures the live DSP baseline and prepares measurement 1;
- active session → marks the current step complete and prepares the next;
- current step is the final one → restores the baseline and returns `phase: "complete"`.

This makes it the preferred single-button iPhone workflow.

### Other controls

```http
POST /api/measurement-batch/previous
POST /api/measurement-batch/retry
POST /api/measurement-batch/goto   { "number": 7 }
POST /api/measurement-batch/abort
POST /api/measurement-batch/clear
```

`abort` always restores the captured processing and mixer routing before ending the session.

## iPhone Shortcut

The minimal shortcut is one action:

- **Get Contents of URL / Obtenir le contenu de l’URL**
- URL: `http://estack-dsp.local:8080/api/measurement-batch/next`
- Method: `POST`

The response field `message` can be displayed as a notification. For a richer shortcut, read `batch.defaults.measurementInput`, `current.name`, `current.activeWayLabels`, `current.rew.measurementName`, `current.rew.startHz` and `current.rew.endHz`.

## Future automatic REW mode

The batch schema already carries the REW metadata required by an automatic runner. The intended second-stage architecture is:

```text
iPhone / CamillaNode UI
          |
          v
Measurement Batch runner (Raspberry)
       |                 |
       v                 v
  CamillaDSP       E-Stack REW Agent (Windows)
                         |
                         v
                    REW localhost API
```

The Windows agent should keep REW bound to localhost, expose only the narrow E-Stack operations needed by the Raspberry, verify REW readiness, start the sweep, wait for completion, name the measurement and save the `.mdat`. The existing batch format should not need to change when this layer is added.
