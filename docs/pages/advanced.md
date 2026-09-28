# Advanced

Advanced is the expert processing workspace. Its functional reference is legacy
CamillaNode `public/src/advanced.js` and `filter.js`; neither is loaded by the
product. The topology inspector is retained as a secondary disclosure.

The main workspace opens on **Signal paths**. It derives each playback channel's
capture sources, applicable input filters, mixer mapping, output filters,
processors and final limiter from the live pipeline, preserving their actual
stage order. Each component opens its existing typed editor. Desktop shows all
outputs with independently scrollable paths; phone focuses one output at a
time. Unrouted outputs remain visible as such. The full original stage list
remains in the secondary inspector.

The **Mixer** view groups mappings by destination, shows every input source's
gain, mute and inversion, and reads actual capture peaks for a live level and
meter. If capture telemetry is unavailable, it shows no fabricated reading.
Input channel selection is presented as IN 1…N while the server operation
continues to use CamillaDSP's zero-based channel index. Source changes still
use the guarded server transaction.

Filters and Processors retain the existing exact editor. In all sections:

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
focus. Phone uses compact section tabs, an output selector, a vertical signal
path and explicit Apply/Discard actions. Raw JSON stays read-only. This replaces the earlier
read-only-only product policy at the user's request, without a raw upload editor.

Software-tested in the Linux demo. No Raspberry was contacted; hardware
acceptance of these new editing capabilities remains pending.
