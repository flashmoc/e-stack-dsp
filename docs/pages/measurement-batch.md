# Measurement Batch product operator surface

Measurement Batch has **two measurement modes**. Both own their temporary CamillaDSP processing and mixer changes on the server, without replacing hardware `devices`. On each graph swap the server attenuates Master to at most −60 dB, applies and verifies the graph, then restores the prior Master level. On finish or abort it restores the processing and mixer mapping captured when that session started.

## 1. Measure current system (one live snapshot)

The **MEASURE CURRENT SYSTEM · IN3** panel lets the operator select the ways to measure and click **MEASURE NOW**. This calls `POST /api/measurement-batch/instant` with `{ "activeWays": [...] }`.

- At the instant of the click, the server captures the **currently running** CamillaDSP processing. Each later click (after finish/abort) captures a **fresh** baseline including changes made in Control between sessions.
- It sends **physical IN3 (CamillaDSP channel 2)** at **0 dB mixer-source gain** to all six logical ways, OUT1…OUT6. This does **not** set the output way gains to 0 dB.
- Every selected way keeps its **captured output gain and mute flag**. A selected way already muted stays muted. The unselected ways are temporarily muted.
- Captured input EQ (including L/R-shared filters mirrored to IN3), output EQ, crossovers, delays, polarity, limiter/protection, Input Trim and Loudness are **preserved**. The mode applies no step overrides.
- **−60 dB is a gain value, not mute.** To fully exclude a way, uncheck it in the selection panel or mute it in Control **before** MEASURE NOW.
- With Loudness active, changing WiiM volume during the REW sweep can alter its frequency response. Keep source volume fixed, or turn off dynamic Loudness before taking a static reference.

Press **NEXT / FINISH** to end the single step or **ABORT & RESTORE** to cancel.

## 2. Imported campaign (calibration sequence)

**IMPORT CAMPAIGN** loads a versioned JSON batch; **START BATCH** captures one baseline from the currently running DSP. Every later step is derived **independently from that same baseline** rather than from the preceding step.

- Selected ways are forcibly unmuted and other ways are muted by default (`muteUnlisted`).
- `gainOffsetDb` is **relative attenuation**: final output Gain = captured output Gain + offset, where offset is constrained to −60…0 dB.
- The batch may adjust delay, phase, polarity, crossovers or input-filter exclusions within its guarded validation rules. It never removes protections.
- Loudness and the normal listening Input Trim/preamp are **forced off for calibration**, then restored at the end.
- Optional `defaults.measurementInput` chooses a **physical IN1…IN8**, feeding logical OUT1…OUT6 at **0 dB mixer-source gain**, with shared pre-mixer L/R filters also applied to the selected input. If absent, the captured mixer routing stays in use.
- Completion and abort restore the captured mixer mapping and processing.

For batch schema, examples, mode comparison and API details, see [Measurement Batch reference](../../measurement-batch.md).

## Baseline and actual-state diagnostics

- **BASELINE PROCESSING** displays the captured reference, fingerprint and per-way / input-filter inventory. The baseline is a snapshot, not a sequence of incremental states.
- **ACTUAL DSP DURING THIS MEASUREMENT** uses `GET /api/measurement-batch/effective`. It displays live Master, routing source, way gains/mutes and filter summary; `matchesExpected` identifies drift from the expected temporary graph. An unexpected difference should be resolved before interpreting a sweep.
- `GET /api/measurement-batch/baseline` returns the live preview before start or the captured baseline during the session; it does not stand in for the actual applied state.
- The internal Signal Generator must be stopped before starting either mode.

## Implementation and validation boundary

Live mode uses the existing `/api/measurement-batch/` status, baseline, effective, instant, import, start, next, previous, retry, goto, abort and clear endpoints through `EStackDSPBridge`. Server owns all baseline capture, scoped deltas, source routing, sequencing and restoration; the product page never generates a DSP configuration.

Current measurement and live processing are polled without unmounting sequence buttons. The `Abort & Restore` action remains available during an API status outage. The local adapter is loaded only outside CamillaNode mode. Local sample import is hidden/unbound in live mode; local preview is retained for demonstrations.

Repository tests cover imported calibration mode and current-system capture, including IN3 routing, preservation of output gains and selected-way mute, input trim/loudness, fresh per-session snapshot, effective-state reporting, and restoration. These **software simulation checks do not replace physical Raspberry/audio-hardware acceptance**.
