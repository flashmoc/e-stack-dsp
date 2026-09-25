# Runtime and API contracts

E-Stack DSP retains these CamillaNode-compatible contracts. Do not rename,
replace or bypass them without an explicit architectural decision.

## Browser transport

| Contract | Purpose | Runtime target |
| --- | --- | --- |
| `/ws/dsp` | Main CamillaDSP command channel | `CAMILLADSP_PROXY_HOST` / `CAMILLADSP_PORT` (default `127.0.0.1:1234`) |
| `/ws/spectrum` | Separate analyser command channel | `CAMILLA_SPECTRUM_PORT` (default `6413`) |
| `/api/runtime` | Public runtime mode and port metadata | Standalone E-Stack DSP server |

Browsers connect only to the same-origin paths. They never open a direct
socket to CamillaDSP ports.

## Saved configuration interfaces

| Contract | Role |
| --- | --- |
| `GET /getConfigFile` | Reads the complete `savedConfigs.dat` collection |
| `POST /saveConfigFile` | Atomic compare-and-swap of non-system records; see below |
| `GET /getConfigList`, `GET /getConfig` | Named configuration listing/read |
| `POST /saveConfig`, `/saveConfigName` | Named/current configuration persistence |

## Server-owned workflows

| Contract family | Owner | Notes |
| --- | --- | --- |
| `/api/startup-config/*` | `server/startupConfiguration.js` | Startup mode and selected system preset/recall |
| `/api/loudness/*` | `server/wiimLoudnessApi.js` | WiiM/loudness settings and guarded preset application |
| `/api/measurement-batch/*` | `server/measurementBatch.js` | Baseline capture, sequencing and restore |
| `/api/test-signal/*` | `server/signalGenerator.js` | Signal-generator snapshot, routing and automatic restore |

The product must call these APIs for their owned workflows. A frontend service
must not reimplement their state files, restore timers or DSP routing logic.

## Compatibility requirement

Existing storage names, URL shapes, request/response meanings and baseline
semantics are part of the E-Stack runtime contract. Product work can add a
typed domain façade above them, but may not silently fork the backend or create
a second server.

## System preset and concurrent collection writes

GET /api/system-presets returns current/startup state, preset summaries and
workflow blocking. POST /api/system-presets/capture accepts name and optional
explicit overwrite; /apply and /delete accept an existing id. These operations
never accept a browser-authored processing graph. GET/POST /api/startup-config
retain yaml/specific/last modes and existing state fields. /active verifies live
processing and Master before accepting historical active-state notifications.

GET /getConfigFile retains its array response and adds an ETag revision.
POST /saveConfigFile accepts {base, records}; base must exactly match the current
collection. Historical array clients must send the current ETag as If-Match.
Stale or missing revisions return 409. Both forms reject changes to estack-system
records: use the owned System Preset API. This explicit compatibility tightening
prevents stale Global EQ/legacy writes from erasing concurrent system changes.

## Expert processing and protection

GET /api/advanced returns live config plus its revision. POST /api/advanced/edit
accepts {revision, operation} for filter/processor parameters, an existing mixer
source, neutral filter insertion or permitted deletion, never raw config upload.
POST /api/output-protection accepts {channel, clip} and changes only that way's
limiter ceiling and compressor threshold (clip − 1 dB). Both use the server
workflow gate and verified safe-Master transaction.

POST /api/system-presets/rename accepts {id, name}. It keeps the record ID,
data and creation date, rejects duplicate names and updates matching active,
startup, last-used and boot-applied names without contacting the DSP.
