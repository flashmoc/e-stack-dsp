# Preferences

Browser-only product preferences live at `estack.product.presentation` in
localStorage. They include density (comfortable/compact), contrast
(standard/high), background palette (graphite/midnight/slate/warm), accent
(cyan/mint/amber/violet), corner style (soft/crisp), and default page.
`shared/appearance.js` validates stored values and applies appearance to the
shell and the currently loaded same-origin workspace. The Preferences page
notifies the shell after same-tab changes; other tabs use the storage event.
The existing product-surface density/contrast rules continue to apply.

The default page is selected only when `/estack-dsp/` opens without a hash.
An explicit `#page` route takes precedence, so bookmarks keep their target.
The page choice does not change during navigation, and resetting preferences
returns it to Control. System Presets is opened as a shell dialog, so it is
not offered as a default tuning page.

Background palettes remain dark to preserve the readability of level and
protection states. These settings never enter DSP configurations, server
presets or safety workflows. Reset removes only this browser presentation key.
There is no EStackPrototypeDSP dependency in either transport mode.
E2E verifies visible shell/workspace colors, layout and contrast, route
precedence, persistence, and reset.

Connections is the read-only diagnostic section of Preferences. It polls the
runtime, DSP and spectrum through EStackDSPBridge, shows current capture and
playback devices, and offers a refresh action. It does not save browser
preferences or send DSP writes. The former `#connections` route opens
Preferences; stored Connections default-page choices migrate to Preferences.

## Audio buffer

Preferences also offers a **separate live DSP chunk-size control**. The server
reads the actual sample rate and chunksize, then offers power-of-two presets
around a roughly 22 ms starting point: 1024 samples at 44.1/48 kHz, 2048 at
88.2/96 kHz and 4096 at 176.4/192 kHz. The UI computes each block duration as
`chunksize / samplerate`; this is **not end-to-end latency**. Capture, playback,
driver and any explicit `target_level` buffers also contribute. Smaller chunks
can increase CPU load and underrun risk. Presets that would exceed CamillaDSP's
configured target playback-buffer limit are omitted. See [CamillaDSP's chunk-size
guidance](https://github.com/HEnquist/camilladsp/blob/master/README.md).

Changing a value requires an explicit confirmation. The browser sends only the
selected preset and a live revision to the server; it never uploads a DSP graph.
The server blocks Signal Generator and Measurement Batch, uses a safe Master
transition, verifies DSP configuration and Master readback, and attempts to hold
Master attenuated after an unverified write, reporting whether that hold was
verified. Only `devices.chunksize` changes. Applying
may briefly interrupt audio. **The hardware YAML, ALSA, sample rate, devices,
mixers and startup settings are not edited.** This is a live-session setting;
the next CamillaDSP restart can restore the YAML value. The control is distinct
from the browser-only appearance preferences and is disabled when the live DSP
cannot be read.
