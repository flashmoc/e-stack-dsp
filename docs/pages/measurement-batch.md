# Measurement Batch product operator surface

Live mode uses the existing /api/measurement-batch/ status, baseline, import,
next, previous, retry, goto, abort and clear endpoints through EStackDSPBridge,
plus `instant` and `effective` for current-system measurements.
The server still owns baseline capture, scoped deltas, sequencing and exact
restore. The page never generates a DSP configuration.

The current-system action captures the live DSP at the instant of starting one
measurement. It routes IN3 at unity mixer gain to the six logical ways, mirrors
shared L/R input processing onto IN3, and preserves input trim, loudness, EQ, gain,
crossover, delay, polarity and existing mutes for selected ways; other ways are
temporarily muted. An imported campaign remains saved for later use. The
effective-state readback displays actual Master, per-way gain/mute, EQ count,
input processing and whether the live DSP still matches the captured snapshot.
Finishing or aborting restores the captured processing and routing.

The operator sees preview versus active measurement, REW instructions, active
ways and baseline-relative deltas. Current measurement precedes sequence on
phone. Sequence buttons remain mounted across polling and operations; current
content updates only when its state changes. Live status is polled and errors
remain visible. Abort/restore stays available during a status outage.

The local adapter is loaded only by entry.js outside camillanode mode. Local
sample import is hidden and unbound in live mode. Local preview is intentionally
retained for campaign demonstrations. Live import is explicit JSON import.
Demo E2E covers import, start, next/previous/retry, abort, completion and exact
configuration/volume restoration, plus Signal Generator exclusion.
