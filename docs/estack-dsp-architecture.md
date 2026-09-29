# E-Stack DSP product architecture

## Product boundary

**E-Stack DSP** is the canonical frontend for E-Stack. Its mount point
is `/estack-dsp/`, served by the standalone E-Stack DSP Node process. The legacy
frontend remains temporarily in the repository as a behavioral specification;
it is not a runtime dependency of the product and must not be extended as the
future architecture.

```text
E-Stack DSP UI
    ↓
page UI modules
    ↓
shared E-Stack domain / services
    ↓
EStackDSPBridge
    ↓
same-origin E-Stack DSP runtime
    ├── /ws/dsp
    ├── /ws/spectrum
    └── /api/*
            ↓
existing backend safety services
            ↓
CamillaDSP / WiiM / persisted configuration
```

## Ownership rules

| Layer | Owns | Must not own |
| --- | --- | --- |
| Page modules | Presentation, layout, input events and rendering service state | DSP graph mutation rules or direct transport |
| `shared/domain/` | E-Stack graph discovery, validation, scoped mutations and readback invariants | Visual layout or arbitrary server workflow replacement |
| `shared/estack-dsp-bridge.js` | The only browser transport: same-origin WebSocket/API requests and command serialization | DSP policy or page-specific config merging |
| `server/` modules | Long-lived/host-side safety workflows, persistence and recovery | Product visual state |
| CamillaDSP | Live audio processing and device/routing runtime | Product UI preferences |

This separation lets the UI be redesigned without rewriting safety-critical DSP
behavior. Page code calls a domain service; it must not assemble arbitrary
`SetConfigJson` operations or connect directly to DSP port `1234`.

## Product source layout

```text
public/prototypes/estack-ui/
  index.html                 product shell
  pages/<page>/              page UI, layout and page-specific presentation
  shared/estack-dsp-bridge.js browser transport
  shared/domain/             reusable E-Stack semantics and transactions
```

The first migrated domain is Control. `pipeline.js` is deliberately generic:
future Input Processing and Output Processing must reuse its modern/legacy
CamillaDSP pipeline schema normalization rather than reimplement it.

## Runtime ownership

The product owns the E-Stack DSP origin and standalone `estack-dsp.service` at
`/home/bastos/e-stack-dsp`. Established server modules remain authoritative for Measurement Batch,
Signal Generator, loudness and startup recall. See
[runtime contracts](runtime-contracts.md) and [DSP safety](dsp-safety.md).

## Migration rule

Study legacy browser modules to port their behavior, algorithms and invariants
into product-owned modules. Do not embed legacy pages, iframes, globals or
compatibility wrappers that require the legacy UI to remain loaded. A migrated
capability belongs in the product page plus a reusable domain/service layer.

## Current status

- **Control:** product domain implementation; code parity accepted at `d1c803e`;
  Raspberry acceptance pending.
- **Input/Output Processing:** existing validated workflows, unchanged by this batch.
- **Loudness, Signal Generator, Measurement Batch:** live server-owned workflows;
  software validation only, hardware acceptance remains separate.
- **Connections:** read-only live runtime/DSP/spectrum diagnostics.
- **Preferences:** browser-local appearance and default page consumed by the shell and current workspace; no DSP ownership.
- **System Presets/Startup:** server-owned capture, verified apply, protected deletion and boot selection.
- **Advanced:** structured expert controls backed by a revision-checked server transaction; secondary topology/ownership inspector.
- **Legacy frontend:** retained as behavioral reference until each capability
  has a product-owned replacement.

## Persistent system overview and phone layout

The product shell owns a read-only telemetry loop in `shared/system-status.js`,
using `EStackDSPBridge` independently of the selected iframe. It reads
`GetConfigJson`, `GetPlaybackSignalPeak`, `GetProcessingLoad` and `GetVolume`,
then schedules the next poll one second after completion (no overlapping polls).
Navigation does not reset these values to preview fixtures.

`shared/domain/system-status.js` derives display states using the existing
Control/pipeline discovery helpers. AUDIO LOAD expresses the largest output
peak amplitude relative to its hard limiter ceiling: `100 * 10^(-margin/20)`,
capped at 100%. Thus -6 dB of margin is approximately 50%, and the ceiling is
100%. Green is below 70%, orange from 70%, red from 90%. It is not CPU load,
amplifier power, or measured gain reduction. The shell publishes this same
reading to Control. Missing coverage or unavailable telemetry is unknown;
valid silent/muted outputs contribute zero. CPU processing load remains a
separate raw measurement and does not drive this audio indication.
HARD LIMITER reports ARMED only when every active output has an enabled hard
limiter. It reports MISSING for incomplete coverage. For unmuted outputs with
signal above -90 dBFS, the smallest sampled margin is shown as HEADROOM;
NEAR LIMIT means at most 3 dB remaining, AT LIMIT means at most 0.1 dB.
These are sampled post-processing peak comparisons, not limiter gain-reduction
telemetry or proof of an actual limiting event. Silent/muted outputs provide no
headroom estimate. Failed/stale telemetry clears the readings and protection
state instead of retaining a green status. Local preview uses unknown readings.

`shared/mobile.css`, loaded after each page stylesheet, owns the common phone
spacing, 44 px touch targets, 16 px editable fields and page-specific responsive
arrangements. The shell occupies the viewport; only the selected workspace
scrolls, keeping the system overview and navigation visible.

## Final shell and workflow integration

The shell mounts once and defaults to the browser-selected page (Control by
default). Desktop navigation groups Processing (Control/Input/Output), Systems
(Loudness), Tools (Signal/Measurement), and System
(Advanced/Connections/Preferences). System Presets and Startup open in a
dialog from the shell beside CamillaGUI, preserving the tuning page beneath.
Mobile uses a grouped native select and a separate Presets button. Direct
`#system-presets` links open the same dialog. Every route preserves
transport=camillanode.
The live shell imports no fixtures; preview messaging is isolated in a separate
conditionally loaded module. Design System is retained only as developer reference.

New system APIs extend startupConfiguration rather than creating a second
backend. workflowGate serializes system capture/apply and Signal/Measurement
transitions, including recovery, within E-Stack DSP. See the safety and
persistence contracts, ownership matrix and release audit for exact boundaries.
