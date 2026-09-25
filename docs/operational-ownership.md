# E-Stack DSP operational ownership

Status: SOFTWARE ACCEPTED IN SIMULATION — RASPBERRY HARDWARE ACCEPTANCE PENDING.
Hardware-backed features still require physical Raspberry acceptance. The browser uses
EStackDSPBridge exclusively; WS means its same-origin /ws/dsp proxy.

| Feature | Operational owner | Read path | Write path | Persistence | Hardware acceptance |
|---|---|---|---|---|---|
| Master | Control / CamillaDSP Master | WS GetVolume | WS SetVolume | System preset Master when explicitly captured | Pending |
| Master mute | CamillaDSP native Master mute | WS GetMute | WS SetMute + readback | Live DSP state, no way-gain rewrite | New capability pending |
| Way gain | Control domain; Output shares the same named Gain anchors | WS GetConfigJson | Scoped Control/Output transaction | DSP processing / system snapshot | Pending |
| Mute | Control/Output per-way Gain anchor | WS GetConfigJson | Scoped Gain mutation | DSP processing / system snapshot | Pending |
| Input Trim | Control domain | WS GetConfigJson + capture peaks | Guarded Input Trim transaction | ESTACK_INPUT_PREAMP / system snapshot | Pending |
| Normalize | Control domain | Live ways + headroom | Guarded common way-gain shift | Same existing way Gain anchors | Pending |
| Global EQ | Input Processing domain | WS GetConfigJson | Scoped GLOBAL_EQ transaction | DSP; global-eq record; browser disabled presentation | Pending |
| Input Delay | Input Processing domain | WS GetConfigJson | Scoped ESTACK_INPUT_DELAY transaction | DSP / system snapshot | Pending |
| Per-way Delay | Output Processing domain | WS GetConfigJson | Scoped existing Delay transaction | DSP / system snapshot | Pending |
| Phase Trim | Output Processing domain | WS GetConfigJson | Scoped ESTACK_PHASE_CH transaction | DSP / system snapshot | Pending |
| PEQ | Output Processing domain | WS GetConfigJson | Scoped USER_CHx_PEQ transaction | DSP; browser disabled presentation | Pending |
| Crossovers | Output Processing domain | WS GetConfigJson | Existing shared crossover transaction | DSP / system snapshot | Pending |
| Hard limiter | Server paired protection transaction | WS config + playback peaks | POST /api/output-protection: clip_limit + compressor threshold −1 dB | DSP / system snapshot | New capability pending |
| Loudness | server/wiimLoudnessApi + loudnessPresetModel | /api/loudness/preset, settings, bridge | Same server preset/toggle/settings APIs | WiiM loudness settings and server-owned processing | Pending |
| Signal Generator | server/signalGenerator | /api/test-signal/status | /start, /stop; server timeout/recovery | Temporary exact snapshot, restored | Pending |
| Measurement Batch | server/measurementBatch | /api/measurement-batch/status, baseline | import/start/next/previous/retry/goto/abort/clear | Batch + exact temporary baseline/session | Pending |
| System Presets | server/startupConfiguration | /api/system-presets | capture/apply/rename/delete | Mixed savedConfigs.dat; estack-system v1 | Pending |
| Startup Configuration | server/startupConfiguration | /api/startup-config | POST mode/target; server boot recall | startupConfig.json | Pending |
| Preferences | Browser presentation only | localStorage | Density/contrast key only | estack.product.presentation | Browser-only; no hardware state |
| Connections | Read-only product diagnostics | /api/runtime; WS GetConfigJson; /ws/spectrum GetState | None | None | Pending |
| Advanced | Server typed expert processing operations | GET /api/advanced | POST /api/advanced/edit | Live DSP; explicit system snapshot to save | New capability pending |

Control and Output intentionally expose the same per-way Gain/Mute anchors;
they do not maintain competing stores. System Presets snapshot these owned
processing definitions as an explicit whole-system recall, not a parallel editor.
Advanced now exposes explicit expert edits to these same live definitions through
the server safety gate; it has no parallel state store or raw graph uploader.
Browser preferences never become DSP state.

The shell alone owns its persistent health presentation loop: Audio Load,
Hard Limiter, Master and Headroom. Navigation preserves the shell and transport.
