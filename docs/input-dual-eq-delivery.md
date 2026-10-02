# Independent input EQ delivery

Local branch: codex/input-graphic-eq. No GitHub push or Raspberry deployment.

## Architecture

The product frontend retains its ten-slot Parametric EQ and adds an independent
Graphic EQ editor. EStackInputProcessingService uses EStackDSPBridge only.
A shared pure state module enforces processor isolation; a server scoped endpoint
reuses the existing serialized safe processing transaction. Device configuration,
mixer topology, routing and output processing are protected.

Before: capture → existing input stages → PEQ → input delay → mixer → outputs.
After: capture → existing input stages → GEQ → PEQ → input delay → mixer → outputs.
Inactive/neutral stages are omitted. Actual demo readback confirmed this order.

## Presets and state

GEQ presets: type graphic-eq, data.format estack-geq-v1, enabled boolean and ten
fixed-frequency {freq,gain} targets. PEQ presets retain type global-eq and their
historical estack-global-eq-v1 format, including individual band enable states.

System Presets carry both through their existing processing filters/pipeline.
A reserved unreferenced Gain filter ESTACK_INPUT_EQ_STATE stores version 1 metadata
in its description: geq {enabled,fitVersion,targets} and peq {enabled,disabled}.
It is never processed. This avoids separate writes of metadata and DSP parameters.
Defaults omit the envelope. Browser localStorage is no longer authoritative.
See [full contract](pages/input-processing.md#state-and-transaction-contract).

Reload and server restart read the running DSP configuration. DSP restart uses the
existing selected System Preset recall. Unsaved edits are not written to hardware YAML.
Existing GLOBAL_EQ names and preset records remain unchanged. Legacy disabled
non-neutral PEQs are inferred from their absence in the active pipeline. Legacy
browser-only flags for neutral bands cannot be reconstructed and are not imported.

## Fitting and response

Log-frequency shape-preserving cubic interpolation defines the target. A bounded,
deterministic search chooses hidden shelf/bell parameters; a numerical gain solve
matches anchors, and dense log-grid error selects the smoothest candidate. The
same RBJ math calculates actual GEQ, PEQ and their combined response. Parameters
are rounded to eight decimals to avoid cross-runtime floating-point mismatches.

At 48 kHz, WiiM Acoustic: maximum anchor error approximately 0.0000112 dB,
RMS over 20 Hz–20 kHz approximately 0.064086 dB. Tests cover 44.1, 48 and 96 kHz.
Flat produces no filters; all +6, alternating ±12 and isolated ±12 also pass.
Alternating extremes have approximately 1.27 dB RMS error between anchors; actual
response can modestly overshoot targets. This is not an exact WiiM transfer function.

## Validation

Canonical Linux Dev Container, real demo CamillaDSP (software audio sources):
- npm test: passed, including repository checks and 21 self-test scripts;
  deployment suite reports 16 fixture tests passed, zero failed.
- npm run demo:check: all four services and product/runtime routes passed.
- npm run e2e: 52 passed, zero failed (2.4 minutes).
- Targeted Input/dual-EQ/System Preset tests: 4 passed on separate follow-up runs.
- Visual inspection at 1440 and 390 pixels: vertical sliders and responsive layout.
- Hardware eight-channel preservation, four bypass combinations, scoped mutations,
  stale revisions, workflow exclusion, failure readback, startup reconstruction,
  sample-rate refitting, preset isolation and editor-tab non-mutation covered.

Earlier development runs caught cross-runtime float equality and test runs during
demo restart; these were investigated rather than suppressed. There were no known
baseline failures (51 browser tests passed before this feature).

## Added files

- `public/prototypes/estack-ui/pages/input-processing/graphic-eq-editor.js`
- `public/prototypes/estack-ui/shared/domain/graphic-eq-fit.js`
- `public/prototypes/estack-ui/shared/domain/input-eq-state.js`
- `scripts/graphic-eq-fit-selftest.js`
- `scripts/input-eq-state-selftest.js`
- `server/inputProcessing.js`
- `tests/e2e/input-dual-eq.spec.js`
- docs/input-dual-eq-delivery.md (this report)

## Modified files

- `docs/pages/input-processing.md`
- `docs/persistence.md`
- `docs/runtime-contracts.md`
- `index.js`
- `package.json`
- `public/prototypes/estack-ui/pages/input-processing/live-page.js`
- `public/prototypes/estack-ui/pages/input-processing/page.css`
- `public/prototypes/estack-ui/pages/input-processing/page.html`
- `public/prototypes/estack-ui/pages/input-processing/page.js`
- `public/prototypes/estack-ui/shared/domain/input-processing-import.js`
- `public/prototypes/estack-ui/shared/domain/input-processing-model.js`
- `public/prototypes/estack-ui/shared/domain/input-processing-service.js`
- `scripts/input-processing-domain-selftest.js`
- `scripts/input-processing-stage2b-selftest.js`
- `scripts/system-presets-selftest.js`
- `server/startupConfiguration.js`
- `tests/e2e/input-processing-live.spec.js`

## Commits

- bc585a6 — deterministic target-response fitter and tests.
- 444c45e — semantic state, scoped API, preset/startup integration and tests.
- 40477d2 — independent editors, preset UI, actual response and browser tests.
- Documentation commit follows these implementation commits.

## Remaining limits

Software validation is not Raspberry hardware acceptance. The reserved metadata
filter must be retained when editing a config with another tool. GEQ state without
its metadata is rejected rather than guessed. Supported fitting range starts at
44.1 kHz. Capture headroom is a current raw-input estimate, excludes other input
processing and future peaks, and is not a clipping guarantee. No automatic EQ gain
compensation is applied. The existing temporary Master attenuation/readback safety
transaction remains active during edits; failed readback holds the safe Master.
