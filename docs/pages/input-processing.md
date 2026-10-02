# Input Processing

## Status

**SOFTWARE PARITY ACCEPTED IN SIMULATION — RASPBERRY HARDWARE ACCEPTANCE
PENDING**

Live Input Processing is available through:

```text
/estack-dsp/?transport=camillanode#input-processing
```

The page is product-owned. Its UI calls `EStackInputProcessingService`, which
uses `EStackDSPBridge` as the only browser transport to the existing
CamillaNode `/ws/dsp` and `/ws/spectrum` proxies. The local prototype remains
separate; it is never an operational fallback in `transport=camillanode` mode.

## Parametric EQ

There are always ten stable UI slots; they are never reordered or spliced:

```text
GLOBAL_EQ_01  31 Hz       GLOBAL_EQ_06  1000 Hz
GLOBAL_EQ_02  63 Hz       GLOBAL_EQ_07  2000 Hz
GLOBAL_EQ_03  125 Hz      GLOBAL_EQ_08  4000 Hz
GLOBAL_EQ_04  250 Hz      GLOBAL_EQ_09  8000 Hz
GLOBAL_EQ_05  500 Hz      GLOBAL_EQ_10  16000 Hz
```

Each reset slot is `Peaking`, its canonical frequency, `0 dB` and `Q 0.70`.
Types are `Peaking`, `Lowshelf` and `Highshelf`. Ranges are frequency
`20…20000 Hz`, gain `−12…+12 dB`, and Q `0.1…20`.

Processor ON/OFF and per-band disabled states are stored with the DSP configuration,
not browser localStorage. Turning Parametric EQ OFF preserves each band's enable
state; turning it ON restores only enabled, non-neutral bands. Historical browser
keys are no longer authoritative. Legacy configs infer disabled non-neutral bands
from their absence in the active dedicated pipeline step.

Active filters are represented by the dedicated pre-mixer filter step:

```yaml
type: Filter
channels: [0, 1]
names: [GLOBAL_EQ_01, ...]
description: E-Stack global input EQ
bypassed: false
```

The active order immediately before the mixer is Graphic EQ → Parametric EQ →
Input Delay. Absent, bypassed or neutral stages are omitted. Input trim/loudness
and unrelated stages retain their existing order.

## Graphic EQ and independent editors

Graphic EQ provides ten target-response gains at 31, 63, 125, 250, 500, 1000,
2000, 4000, 8000 and 16000 Hz (−12…+12 dB, 0.1 dB steps). These describe the
combined desired response, not the hidden biquad gains. It is for tonal shaping;
Parametric EQ retains frequency/type/gain/Q controls for corrective work such as REW.
Both can run simultaneously. The editor tabs change presentation only, while the
two ON/OFF switches change processing independently. Flat/Reset affects GEQ only.

A shape-preserving cubic Hermite target interpolates log frequency, with constant
edge targets outside 31 Hz–16 kHz. A deterministic Newton gain solver evaluates
eight hidden bells and two shelves over a bounded Q/edge-frequency search. Candidate
selection minimizes dense response error while enforcing anchor accuracy. It reuses
the PEQ RBJ response math. No FIR, coefficient files or runtime dependencies are added.
Generated GLOBAL_GEQ_01…10 parameters are rounded to eight decimals for identical
browser/server validation. Flat targets generate no filters. Supported sample rates
are 44.1–384 kHz; preset recall refits for the current hardware sample rate.

At 48 kHz the WiiM Acoustic example achieves maximum anchor error 0.000012 dB
and log-grid RMS error 0.064086 dB. This is the E-Stack interpretation of those slider
settings, not a reverse-engineered WiiM transfer function. Alternating ±12 dB targets
have approximately 1.27 dB RMS interpolation error between anchors; an IIR fit is an
approximation. The graph always draws the actual biquad response, including this error.

Graphic EQ presets use the mixed saved-config store with type graphic-eq and data:

```json
{"format":"estack-geq-v1","enabled":true,"bands":[{"freq":31,"gain":5.0}]}
```

The bands array must contain all ten fixed frequencies in order. Saved values are
semantic targets; load regenerates hidden filters and changes GEQ only. WiiM Acoustic
is built in; save, load, rename and delete use the existing saved-config client.
PEQ retains the historical global-eq format and changes PEQ only. System Presets
capture both processors, their bypass states, input delay and existing output processing.

The page header's Import and Presets buttons follow the visible editor tab:
Graphic EQ opens GEQ import/presets, and Parametric EQ opens PEQ import/presets.
The GEQ preset dialog also links to GEQ import. Switching tabs only changes
the editor and these actions; it does not change DSP processing. GEQ import accepts
the same REW/Equalizer APO and JSON sources as Import PEQ, plus two-column
frequency/gain target tables. A complete ten-band file at the fixed GEQ
frequencies supplies target gains directly. An arbitrary PEQ file is evaluated
at those ten frequencies to make GEQ targets; the preview explicitly labels
that conversion. Values beyond ±12 dB are rejected, not silently clipped.
After preview, Apply GEQ turns on GEQ and refits its hidden biquads in one
guarded transaction. PEQ, input delay, routing and output processing are
unchanged. Import changes the active GEQ; use Save current GEQ to retain it as
a separate GEQ preset.

## State and transaction contract

A reserved, unreferenced valid Gain filter ESTACK_INPUT_EQ_STATE carries a versioned
JSON envelope in its description (prefix E-Stack input EQ state v1:). It never appears
in pipeline names and consumes no audio processing. The envelope is:

```json
{"version":1,"geq":{"enabled":false,"fitVersion":1,"targets":[0,0,0,0,0,0,0,0,0,0]},"peq":{"enabled":true,"disabled":[]}}
```

This keeps semantic targets, enabled states, generated filters and pipeline in one
CamillaDSP configuration transaction and in existing System Preset processing snapshots.
The envelope is omitted for the default legacy-compatible state. Unknown versions,
missing GEQ metadata, mismatched fits or ambiguous stage ownership are rejected.
Reload and an E-Stack server restart reconstruct from the running DSP. A DSP/device
restart restores the saved state through the existing configured System Preset startup
recall; unsaved edits are not silently written to hardware YAML.

EStackInputProcessingService uses EStackDSPBridge to POST /api/input-processing with
scope (geq, peq or delay), before and next. Server-side scope validation protects
all other processing, devices and mixers. The existing server editProcessing workflow
serializes edits, refuses stale revisions/temporary workflows, temporarily lowers Master,
uploads, verifies full readback and restores the previous Master. Failure after attenuation
holds the safe level and reports an error. This safety transaction is independent of the
headroom warning; no additional automatic gain compensation is introduced.

## Input Delay

Input Delay is shared by Input L/R before the mixer. It is `0…2000 ms` in
`0.1 ms` steps. A non-zero value uses only:

```yaml
filters:
  ESTACK_INPUT_DELAY:
    type: Delay
    parameters: { delay: <ms>, unit: ms, subsample: false }
pipeline:
  - type: Filter
    channels: [0, 1]
    names: [ESTACK_INPUT_DELAY]
    description: E-Stack input delay
    bypassed: false
```

At exactly `0 ms`, the service removes only that filter and dedicated step.
It does not alter Global EQ, output delays, mixer routing, crossovers,
protection or other processing.

## Presentation and analyzer

The graph is the main workspace, followed by a compact ten-band selector and
one persistent selected-band editor. Desktop shows all ten slots in a row
(two rows on smaller tablets); phone uses a horizontal strip. Active, neutral
and disabled bands are distinct. Each slot has a stable presentation
color shared by its individual response, graph point and editor.

The white combined curve sums enabled GEQ and PEQ actual responses in dB. Dashed
GEQ and PEQ curves distinguish the two contributions. Individual
colored curves and their translucent fills use the unchanged per-band response.
Both use the real configuration sample rate and a logarithmic 20 Hz–20 kHz
axis. EQ uses a symmetric dB scale; real spectrum uses a separate labeled
0…−96 dBFS scale. Disabled/neutral contributions are excluded. No synthetic
spectrum or response fallback is used while live data is unavailable.

Graph points adjust frequency horizontally and gain vertically. Native ranges
and numerical fields expose exact frequency/gain/Q; type, enable and band reset
are adjacent. Pointer movement is a local preview; release enqueues exactly one
existing guarded service transaction. Cancellation restores the preview without
writing. Numerical edits remain available during queued readbacks. Structural
DOM is mounted once; readbacks update data and retained nodes, preserving focus,
selection, scrolling and active gestures. A failed transaction clears pending
edits, refreshes state and reports the error.

Spectrum still reads real GetPlaybackSignalPeak samples through /ws/spectrum,
with FAST 0.58 and SLOW 0.16 smoothing. Polling does not overlap. A restrained
unavailable state replaces invalid/disconnected data.

Input Delay presents an exact millisecond value, a 0…2000 ms native slider,
−10/−1/+1/+10 ms nudges and its own reset. Global EQ reset remains separate and
confirmed. Import and Presets are secondary header actions in touch-friendly
dialogs. Import requires text/file → parsed preview → explicit Apply; modifying
the source invalidates the parsed preview.

The frontend was reviewed in four deliberate desktop/phone visual passes,
including the final individual colored-band direction. The responsive matrix
covers 1920×1080, 1440×900, 1280×800, 1024×768 and 390×844, each at browser zoom
80%, 100%, 125% and 150%. Input E2E retains the original DSP/preset preservation
assertions and adds one touch/queue/DOM stability regression.

## Global EQ presets and import

Global EQ presets use the existing same-origin CamillaNode saved-config APIs:
`GET /getConfigFile` and `POST /saveConfigFile`. They remain a mixed
`savedConfigs.dat` collection, so product writes always load the complete
collection, change only the intended `global-eq` record, and save the complete
collection again. Filtering by type is presentation-only: a Global EQ save or
delete must never remove `estack-system` or any other record type.

The product's shared `EStackSavedConfigClient` owns those collection
operations. A preset has the historical contract below; exactly ten bands are
saved in stable slot order and Input Delay is deliberately excluded.

`Load EQ` replaces the current ten-band EQ. `Add to current` instead takes
only the selected preset's enabled, non-neutral bands, appends them in preset
order to empty `GLOBAL_EQ_*` slots, and preserves occupied filters and their
disabled state. It rejects the entire addition before upload if too few of
the ten slots are empty. Neither action changes Input Delay, mixer routing,
hardware channels, or other DSP processing.

```json
{
  "id": "<generated or existing id>",
  "type": "global-eq",
  "name": "My EQ",
  "createdDate": "<ISO date>",
  "data": {
    "format": "estack-global-eq-v1",
    "bands": [
      { "type": "Peaking", "freq": 63, "gain": -2.5, "q": 0.7, "enabled": true }
    ]
  }
}
```

Imports accept REW/Equalizer APO (`PK`, `LS`/`LSC`, `HS`/`HSC`, including
`OFF`), comma or whitespace tables (with optional leading index), E-Stack JSON
arrays/preset records, and CamillaDSP configuration JSON containing
`GLOBAL_EQ_01`…`GLOBAL_EQ_10`. Values are normalized through the Global EQ
model and capped at ten bands; missing slots become canonical neutral slots.
Parsing has no DSP side effects. The operator explicitly applies the parsed
data, then `applyBands()` performs one guarded live DSP transaction affecting
only `GLOBAL_EQ_*` filters and `E-Stack global input EQ`. It preserves
`ESTACK_INPUT_DELAY`, `E-Stack input delay`, and all unrelated DSP state.

## Acceptance boundary

The Input Processing simulation test performs reversible Global EQ, delay,
import and preset mutations through the product, verifies protected
configuration, and restores the exact demo DSP configuration and complete
saved-config collection. `SIMULATION/E2E PASS != RASPBERRY HARDWARE
ACCEPTANCE`.

## Headroom display

EQ MAX BOOST is sampled over the actual combined response. CAPTURE HEADROOM is
estimated from current capture peaks; silence/unavailable telemetry shows no estimate.
A warning appears when boost exceeds this margin. This is not output protection or
a guarantee against clipping: it excludes upstream trim/loudness and future signal
peaks. Existing hard limiters and safety controls are unchanged.

## Dual EQ regression coverage

npm test covers six deterministic fitting profiles at 44.1/48/96 kHz, semantic state,
all four bypass combinations, ordering, isolation, hardware preservation, stale/invalid
scoped edits, workflow exclusion, failed readback and simulated startup recall/refitting.
input-dual-eq.spec.js additionally verifies editor tabs without DSP writes, separate
preset round trips, System Preset recall, page reload and actual demo pipeline readback.
