# DSP safety model

## Standard product configuration transaction

When a product domain service must make a narrow CamillaDSP configuration
change, it follows this sequence:

1. Read the live configuration.
2. Check incompatible active workflows where applicable.
3. Snapshot relevant state, including the current Master where a graph swap is
   involved.
4. Discover and validate the exact target scope in the live graph.
5. Attenuate Master when the operation replaces/uploads a processing graph.
6. Apply only the targeted mutation to a cloned configuration.
7. Validate allowed structure and protected invariants before upload.
8. Send `SetConfigJson` through the shared domain service and bridge.
9. Read the configuration back.
10. Verify that only allowed differences occurred.
11. Restore Master and temporary state even if an operation fails.

Page UI must not duplicate this sequence. The page calls a domain service and
renders its result. Every safety-critical change requires regression coverage
for the protected invariant.

## Existing server-owned safety workflows

Do **not** reimplement these workflows in a product domain module:

- **Measurement Batch:** server captures a baseline, applies validated temporary
  deltas, owns measurement routing and restores baseline processing/routing.
- **Signal Generator:** server snapshots the normal configuration, restricts
  routing, has timeout/page-exit/restart recovery and restores it.
- **Loudness:** its backend owns live preset application and persistence rules.
- **Startup recall:** the backend restores selected processing safely at boot
  while retaining hardware devices/mixers owned by the live YAML.

Product pages call their same-origin APIs and display returned state.

## Control-specific application

Control way gain/mute uses a narrow mutation with device, mixer, pipeline,
processor, crossover, PEQ, delay and limiter invariants. Input Trim and
Normalize also lock against an active Measurement Batch or Signal Generator and
use a temporary `−60 dB` Master transition with readback and restoration. See
[Control](pages/control.md).

## Hardware acceptance

Code tests are not hardware acceptance. Real DSP writes require an explicit
hardware task, an initial live snapshot, reversible steps, readback checks and
restoration. If any invariant fails, stop; do not fix forward on the Raspberry.

## System Preset transaction and workflow exclusion

System Preset capture/apply runs in the shared server workflowGate, as do
existing Signal Generator and Measurement Batch transition queues (including
stop, timeout and restart recovery). Once acquired, the system operation checks
both persistent temporary-session files. It refuses capture/apply if either
exists, so it cannot capture temporary routing or invalidate a pending restore.
Existing Signal-vs-Measurement checks remain unchanged and now share ordering.
This gate covers operations in the E-Stack DSP server; Raspberry service restart
integration remains a separately accepted hardware boundary, unchanged here.

Apply reads live configuration, sets -60 dB Master, validates saved references,
merges processing into the live hardware/mixer configuration, uploads and verifies
the expected full readback before restoring the intended Master. Master readback
is verified before active/last-used metadata is written. Failure attempts to
retain -60 dB and reports an error, rather than claiming the requested preset active.
Captured Master is restricted to finite -100..0 dB; old missing/null values use
the existing -40 dB fallback instead of accidental 0 dB.

## Advanced edits and paired output protection

Both are server-owned typed operations, serialized through the same workflow
gate. Active Signal/Measurement snapshots and SignalGenerator capture are
rejected. Advanced requires the exact current configuration revision. Operations
clone live state, preserve devices, validate references, attenuate to the lower
of current Master and −60 dB, upload once, verify the entire readback, then restore
and verify Master. Failure after attenuation holds that safe value and reports
it; the UI never silently restores volume after an unverified graph write.

Output protection requires a unique per-way Limiter and independent active
Compressor. Only clip_limit and threshold change; threshold is always clip_limit
minus 1 dB. Ambiguous/shared/missing protection is refused. Attack, release,
ratio, routing and other ways remain unchanged.

Master mute uses native GetMute/SetMute and verifies the result. It never emulates
mute by changing volume or rewriting way gains.

## Live chunk size

Preferences uses the server-owned `/api/chunk-size` operation. The request
contains a reviewed configuration revision and one offered power-of-two size;
the browser cannot send a replacement configuration. The server refuses active
Signal Generator or Measurement Batch state and SignalGenerator capture, checks
the exact revision and playback-buffer compatibility, clones the live DSP
configuration, and changes only `devices.chunksize`. It validates processing,
attenuates Master to the lower of its current value and −60 dB, uploads once,
verifies the full config readback, then restores and verifies Master. On a
post-attenuation failure the server attempts and verifies a safe Master hold;
if it cannot verify the hold, the error says so. The transaction does not write
hardware YAML, ALSA or startup state;
CamillaDSP may briefly interrupt audio when applying a new buffer size.
