# Connections

Connections now lives inside Preferences, beneath display settings. The former
`#connections` bookmark opens Preferences; its standalone page URL remains a
read-only compatibility surface. The diagnostics automatically inspect GET /api/runtime,
GetConfigJson through /ws/dsp and GetState through /ws/spectrum, exclusively
via EStackDSPBridge. A non-overlapping three-second poll updates mounted text
nodes. Runtime, main DSP and spectrum have independent availability states.
Capture/playback types, device identifiers, channel counts and sample rate
come from current DSP configuration, never fixture defaults. Failed checks
clear device readings; last successful check remains explicitly dated.
There are no write controls or raw configuration operations. Offline mode is
an explanatory disabled surface; no prototype adapter is loaded.
