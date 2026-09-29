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
