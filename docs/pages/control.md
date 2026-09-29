# Control

Live strips separate measured LEVEL (−60…0 dBFS on every output and Master)
from adjustable GAIN (−60…0 dB for Master, −60…+6 dB for ways). No grid line
connects the two scales. The Master control now reaches −60 dB, with its existing
0.5 dB steps and dedicated SetVolume path; mute remains independent.
Signal colors change at fixed −12/−3 dBFS thresholds. The Master meter shows the
loudest unmuted output peak, explicitly labelled LOUDEST OUTPUT.

Master now exposes native DSP mute (GetMute/SetMute with readback), independent
of Level Lock and without changing volume or way gains. Muted ways show no
limiter event. Missing/silent peak margins are not compared as numeric zero.

The input spectrum is a text-free segmented-bar visualizer using real stereo
band peaks from the spectrum proxy. Its fixed vertical blue/cyan/green gradient
follows the original presentation. Canvas resolution follows actual size and
pixel ratio. Missing or invalid telemetry clears the bars instead of retaining
stale data. No labels, axes or status text are drawn inside the visualizer.

## Status

**Software parity accepted at `d1c803e`; real Raspberry acceptance pending
hardware availability.**

Control is the first product page with product-owned live DSP semantics. Its
live mode is entered through:

```text
/estack-dsp/?transport=camillanode#control
```

It does not load fixture/mock operational data in that mode.

## Product files

| File | Responsibility |
| --- | --- |
| `public/prototypes/estack-ui/pages/control/live-page.js` | Presentation, user events and rendering only |
| `public/prototypes/estack-ui/pages/control/fader-presentation.js` | Shared visual fader geometry for local and live Control pages |
| `public/prototypes/estack-ui/shared/domain/pipeline.js` | CamillaDSP 4.x/legacy Filter-step normalization and post-mixer chain discovery |
| `public/prototypes/estack-ui/shared/domain/control-model.js` | Pure Control graph discovery and structural invariants |
| `public/prototypes/estack-ui/shared/domain/control-service.js` | Reads, telemetry, transactions, links and headroom semantics |
| `public/prototypes/estack-ui/shared/estack-dsp-bridge.js` | Only browser transport for `/ws/dsp`, `/ws/spectrum` and same-origin APIs |

## Reads

The shell derives Audio Load from real output peaks and hard limiter ceilings and sends it
to Control through the same-origin `estack-system-load` presentation message.
Control validates the parent and origin and uses the identical percentage and
70/90 percent warning thresholds; limiter headroom remains a separate dB value.

Live meter refreshes update existing elements rather than rebuilding controls.
Input Trim keeps a local pointer preview and commits on release through the
existing guarded service; exact numeric edits and half-dB nudges are serialized.
Pointer cancellation discards the preview. Mobile places output normalization
and Level Lock on a dedicated row below the protection summary.

- `GetVolume` for Master;
- `GetCaptureSignalPeak` for capture/input meters;
- one shared `GetPlaybackSignalPeak` loop for output meters;
- `GetConfigJson` before/after configuration transactions;
- `/ws/spectrum` for spectrum data.

## Writes

- `SetVolume` for Master only;
- guarded narrow Gain/mute changes on actual post-mixer per-way Gain filters;
- guarded Input Trim transaction using `ESTACK_INPUT_PREAMP` and its dedicated
  pre-mixer stage;
- guarded Normalize transaction applying one common way-gain shift.

## Safety invariants

- Active ways come from explicit first-mixer destinations. E-Stack uses outputs
  `0…5`; unused playback outputs `6/7` are not presented as ways.
- Per-way gain discovery only traverses direct **post-mixer** Filter steps, so
  pre-mixer Input Trim cannot be selected as a way Gain.
- Final hard-limit discovery scans all post-mixer steps, including the final
  Limiter-only steps after protection processors.
- Device, mixer, pipeline, processor, crossover, PEQ, delay, limiter and
  unrelated filter state must remain identical for a narrow Gain/mute write.
- Input Trim/Normalize check Measurement Batch and Signal Generator locks,
  attenuate Master to `−60 dB` during graph changes, read back, verify exact
  scope and restore Master even on failure.
- Headroom uses live Compressor thresholds and Limiter `clip_limit`, a 4-second
  peak hold, calibrated voltage model and `−90 dBFS` no-signal threshold.
  Silence yields `WAITING` / `PLAY SIGNAL`; automatic Input Trim is unavailable.
- MID/HIGH links apply to Gain changes only. Mute remains per selected way.
  Each affected way has a compact link button beside its name; the two buttons
  in a pair reflect one shared state, while MID and HIGH remain independent.

## Faders and Level Lock

- Output way faders cover `−60…+6 dB` with console-style non-linear travel:
  `+6 dB → 4%`, `0 dB → 18%`, `−12 dB → 42%`, `−30 dB → 68%`, and
  `−60 dB → 100%`. The displayed dBFS meter remains independent from this
  control geometry.
- MASTER covers `−50…0 dB` with linear travel and commits in `0.5 dB` steps.
- Level Lock is presentation-only state, stored in browser localStorage as
  `estack.control.level.locked`. It prevents gain edits to the six output ways
  through faders, number inputs and nudges, while keeping MASTER, mute, links,
  meters, Input Trim and Normalize available.
- Level Lock is never DSP state or preset state: it is not included in
  `ControlService` snapshots and cannot alter a saved DSP configuration.

## Pending Raspberry acceptance

When hardware is available, run the staged Control protocol:

1. Read-only transport/topology/meter/spectrum validation.
2. Reversible Master, SUB gain, MID linked gain and independent MID mute checks.
3. Small reversible Input Trim transaction; inspect Normalize preview first.
4. Final complete live-config comparison against the pre-test snapshot.

Do not run Signal Generator or Measurement Batch during that acceptance. Stop
at the first readback/invariant failure and restore only through the recorded
snapshot/explicit guarded transaction.
