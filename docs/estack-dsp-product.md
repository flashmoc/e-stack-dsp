# E-Stack DSP product entry and migration status

> The canonical architecture is [E-Stack DSP product architecture](estack-dsp-architecture.md).
> This document records the product mount path and transport activation, not a
> second ownership model.

`/estack-dsp/` is the product entry point for the new E-Stack DSP workspace.
It is served by the standalone E-Stack DSP Node process and retains the accepted
origin, authentication boundary, HTTP port and CamillaDSP proxy contracts.

## Connection contract

The product never opens a browser connection to CamillaDSP directly.

```text
E-Stack DSP browser
  ├─ same-origin HTTP → /api/*
  └─ same-origin WebSocket → /ws/dsp
                              └─ E-Stack DSP → ws://127.0.0.1:1234
```

This is the exact accepted compatibility path used by E-Stack DSP.
`CAMILLADSP_PROXY_HOST` and `CAMILLADSP_PORT` remain the only runtime
configuration for the main DSP endpoint. Spectrum remains on the existing
`/ws/spectrum` → `CAMILLA_SPECTRUM_PORT` path.

## Modes

Default product mode is local and makes no network request. To enable the
same-origin compatibility transport, use:

```text
http://<camillanode-host>:<port>/estack-dsp/?transport=camillanode#connections
```

Connections automatically reads runtime, DSP configuration and spectrum status.
It is read-only. Measurement Batch uses its existing server runner and exact
baseline/restore safeguards. System Presets includes future startup selection;
Advanced is a live read-only inspector.

## Compatibility

The product reuses the established server modules without a second runner:

- `server/measurementBatch.js`
- `server/signalGenerator.js`
- `server/wiimLoudnessApi.js`
- `server/startupConfiguration.js`

Future product pages must use `public/prototypes/estack-ui/shared/estack-dsp-bridge.js`
for any same-origin API or DSP-proxy transport. Direct sockets to port `1234`
and direct browser DSP writes are intentionally not allowed.

## Control migration note

For the complete current Control implementation, safety invariants and hardware
status, see [Control](pages/control.md). It is the single canonical Control
contract; do not duplicate or extend it from this mount/transport note.
