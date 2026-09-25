# Advanced

Advanced is the expert processing workspace. Its functional reference is legacy
CamillaNode `public/src/advanced.js` and `filter.js`; neither is loaded by the
product. The topology inspector is retained as a secondary disclosure.

The main workspace has Filters, Mixers, Processors and Pipeline sections:

- Filter type/subtype and exact numeric, boolean, enum and array parameters.
  Gain, Volume, Loudness, Delay, convolution, Biquad, BiquadCombo, Dither and
  Limiter controls follow the legacy concepts. Changing type/subtype creates a
  visible draft; existing parameters are otherwise retained.
- Mixer input source, gain, mute and polarity within existing channel counts.
- Existing processor parameters, retaining channel ownership. Protection
  thresholds are adjusted through their hard limiter, not independently.
- Ordered stages link to component controls and allow neutral filter insertion.
  Non-system filters can be removed. System anchors and device topology cannot
  be deleted. The legacy non-persisting Add Node placeholder is replaced by a
  verified insertion into a selected filter stage.

Apply requires confirmation. EStackDSPBridge calls GET /api/advanced and
POST /api/advanced/edit. The server accepts a typed operation and the revision
of the edited snapshot, not an arbitrary full configuration. It rejects stale
drafts and active Signal/Measurement sessions. Devices stay immutable. The
server owns attenuation, reference validation, full readback and Master restore.
Failure after attenuation holds Master at the safe level.

Opening/inspecting never writes. Polling pauses during a draft/apply, preserving
focus. Phone uses a compact section selector, two-column editor and explicit
Apply/Discard actions. Raw JSON stays read-only. This replaces the earlier
read-only-only product policy at the user's request, without a raw upload editor.

Software-tested in the Linux demo. No Raspberry was contacted; hardware
acceptance of these new editing capabilities remains pending.
