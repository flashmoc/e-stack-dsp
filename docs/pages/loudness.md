# Loudness

Product live surface uses EStackDSPBridge with GET /api/loudness/preset,
/settings and /bridge; POST /preset, /toggle and /settings. Presets and their
scope verification remain server-owned. No browser DSP graph mutation.
Curve fields are drafts until Save; polling never overwrites an edited field.
The WiiM level-mapping curve is configured volume compensation, not a measured
EQ response.
Bridge/WiiM unavailability is explicit, independently of DSP preset connectivity.
The frequency-response graph shows the preset's maximum contour (dashed) and
the current estimated contour (solid), scaled by the live `compensationFactor`
reported by `/api/loudness/bridge`. It uses the established legacy contour
approximation; it is not a measured CamillaDSP transfer function. A current
curve is withheld when WiiM/bridge telemetry is unavailable, and disabled
presets show a flat response. The separate volume-response chart continues to
show how WiiM attenuation maps to compensation factor.
The product page keeps preset, WiiM link, compensation and enable/disable in
one compact status row. Detailed WiiM level mapping is expandable; connection
diagnostics remain on the Connections page rather than duplicating that panel.
Offline mode is a disabled explanatory surface; no operational mock is loaded.
Software validation: scoped preset/curve E2E and responsive viewport checks.
Actual WiiM/hardware acceptance remains separate.
Disable uses the server's Reference preset endpoint; enable uses /toggle to
recall the server-owned last enabled preset. This avoids the existing toggle-off
metadata rewrite error on the Windows-mounted demo without changing backend
code, mutation scope or persisted preset semantics.
