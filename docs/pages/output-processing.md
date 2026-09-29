# Output Processing

Status: **OUTPUT PROCESSING SOFTWARE PARITY ACCEPTED IN SIMULATION —
RASPBERRY HARDWARE ACCEPTANCE PENDING**.

## Ownership and topology

The Output Processing product page is a post-mixer editor. Its UI calls the
Output Processing domain service, which uses `EStackDSPBridge` and the existing
same-origin CamillaNode `/ws/dsp` transport. The page never builds a raw DSP
configuration upload itself.

The six operator ways are fixed:

| Channel | Way |
| --- | --- |
| 0 | SUB |
| 1 | KICK |
| 2 | MID L |
| 3 | MID R |
| 4 | HIGH L |
| 5 | HIGH R |

OUT7/OUT8 are intentionally not operator ways. Discovery begins after the
first mixer and requires verified post-mixer Gain, Delay and Limiter anchors,
so Input Processing filters such as `GLOBAL_EQ_*`, `ESTACK_INPUT_DELAY`,
`ESTACK_INPUT_PREAMP` and `INPUT_TRIM_*` are never discovered as output
filters.

## System Edit lock

Each new page session starts **LOCKED**. The lock is session/UI state only and
does not persist to browser storage, presets or DSP configuration. While
locked, Output Processing cannot change gain, mute, polarity, delay, phase,
crossover, PEQ or hard-limiter threshold. Reading topology and the magnitude
graph remains available. Unlocking enables explicit guarded commits; it is not
a mock apply/revert transaction.

## Existing output filters

Gain, mute and polarity use each way’s existing `Gain` filter:

- gain: `Gain.parameters.gain`, range `-60…+6 dB`, step `0.1 dB`;
- mute: `Gain.parameters.mute`;
- polarity: `Gain.parameters.inverted`.

The Gain identity is the same verified per-way identity as Control. Output
Processing retains its own narrow writer, with the same `−60…+6 dB`, `0.1 dB`
operator range as Control. `GAIN_RANGE` and `normalizeGain()` in the Output
model define that range; the UI and service use it. Gain mutation
readback also rejects a changed gain outside this range or step. Reading an older
configuration never silently rewrites its gain.

MID L/R and HIGH L/R processing links use the same browser-local pair choices
as Control (`estack.control.link.mid` and `.high`, linked by default). In Output
Processing the link applies to the next Gain, Delay, phase trim and PEQ edit.
It also applies to crossover edits: the canonical MID and HIGH crossover
filters are already shared, while independently named edges are updated as a
verified pair. Each linked edit is one guarded config transaction with readback
for both ways. PEQ add, value/type change, enable/disable, reset and delete
act on the same slot on both ways. Toggling a link alone makes no DSP write and
does not silently synchronize different current values. Mute, polarity and
hard limiter remain independent per way; Control continues to link Gain only.

Per-way delay changes only the existing Delay filter’s `parameters.delay`:
`0…100 ms`, step `0.01 ms`. Its `unit` and `subsample` properties are
preserved. Samples and distance shown by the UI are presentation calculations
using the live sample rate and 343 m/s.

## Crossovers

Stage 3A edits only existing `BiquadCombo` crossover filters. It can change
only `parameters.type`, `parameters.freq` and `parameters.order` for the exact
filter already in the output stage. Supported live families are
Linkwitz–Riley and Butterworth; slopes are 12/24/36/48 dB/oct.

Some anchors are shared deliberately:

- MID L/R share `mid_hpf_300_lr24` and `mid_lpf_2000_lr24`;
- HIGH L/R share `high_hpf_2000_lr24`.

The UI marks shared ownership. A shared edit changes that one definition while
the existing references in both channel stages must remain unchanged. Missing
edges (for example the current HIGH LPF) are read-only `NOT PRESENT`; Stage 3A
does not invent new crossover edges.

## Phase trim and PEQ

Phase trim uses a first-order all-pass Biquad named
`ESTACK_PHASE_CH0` through `ESTACK_PHASE_CH5`. It is `AllpassFO`, uses the live
sample rate and a reference selected from existing description metadata, then
LPF, then HPF, then 1000 Hz. Its historical description is retained:
`E-Stack phase trim <WAY> (<degrees> deg @ <reference> Hz)`. The edit range is
`-179…0°`, step `0.1°`. At less than `0.05°` magnitude it removes only that
phase filter and its reference. An active phase trim is placed after crossover
and user PEQ, before Gain.

Each channel owns ten stable PEQ identities:

`USER_CH0_PEQ_01…10` through `USER_CH5_PEQ_01…10`.

Defaults are Peaking / 31, 63, 125, 250, 500, 1000, 2000, 4000, 8000 or
16000 Hz / 0 dB / Q 0.70. Supported types are Peaking, Lowshelf and Highshelf;
ranges are frequency `20…20000 Hz`, gain `-20…+20 dB` and Q `0.1…20`.

`+ ADD PEQ` chooses the first unused stable slot. Deleting removes only that
filter and references and never renumbers another slot. A neutral band
(`abs(gain) < 0.05 dB`) or a disabled band remains defined but is absent from
the processing stage. Disabled state is UI-only browser storage at
`estack.peq.disabled.<channel>.<slot>`; it is not an invented DSP parameter.
Active PEQs are deterministically ordered by slot before phase, Gain and Delay.

## Protection and graph

The associated Compressor threshold follows the Hard Limiter by −1 dB.
Hard Limiter filters remain mandatory and cannot be bypassed or removed by this
page. When System Edit is unlocked, the exact existing limiter can change only
`parameters.clip_limit`, range `-60…0 dBFS`, step `0.1`, together with the
associated compressor threshold. Type, soft clipping, description, placement,
attack/release/ratio and other ways remain unchanged. The domain service calls
POST /api/output-protection for a server-owned, workflow-locked, attenuated and
verified transaction. Missing/shared protection is refused.

The dense calibration workspace follows the per-way operator layout: six
compact output selectors, response graph, Output/Align/Protection rack, and
simultaneously accessible PEQ/Crossover controls. It does not load the mock
per-way prototype at runtime.

The response graph is read-only and works while System Edit is locked. Its
**Magnitude** mode remains a live-config theoretical plot on a logarithmic
20 Hz…20 kHz axis: crossover, active user PEQ and output Gain are included;
input processing, dynamics and limiter non-linearity are excluded. **Phase**
uses the actual output filter stage and sample rate: BiquadCombo crossover,
USER PEQ, Delay, Gain inversion and `ESTACK_PHASE_CHx` AllpassFO all
contribute to the wrapped phase trace. **XO Align** provides SUB/KICK,
KICK/MID L, KICK/MID R, MID L/HIGH L and MID R/HIGH R pairs; its region and
marker come from the current lower LPF and upper HPF (geometric mean when both
exist). Compare and All XOs are graph overlays only.

The analyzer is a live `/ws/spectrum` read through `EStackDSPBridge`, using
the historical thirty fixed analyzer bands and straight segments between actual
samples. It never fabricates FFT points. RAW, FAST and SLOW smoothing, optional
Infinite averaging/reset, and FULL/SUB/LOW/MID/HIGH graph views are
presentation-only. A failed spectrum transport reports unavailable without
affecting theoretical graph modes or DSP configuration.

## Transaction protection

Every mutation uses GetConfig → validated narrow clone → SetConfig → GetConfig
readback. Guards are transaction-specific: delay, crossover, limiter, phase
and per-channel PEQ operations each allow only their own explicit scope. All
pipeline Mixer/Filter/Processor references are validated before upload. Shared
crossover operations additionally assert that both original shared references
remain in place.

The standalone `/prototypes/per-way/` editor remains mock-only design
reference. Live Output Processing does not load its fixtures, scenario state,
fake analyzer or apply/revert model.

## Frontend rendering and calibration workspace

The Output frontend places a compact six-way selection rail beneath the wide
response plot, aligned with the Input EQ band rail. Pair link controls sit next
to System Edit, leaving the selection rail without an extra heading. It uses a
horizontal Gain / Delay / Phase alignment row. Gain and phase have sliders plus
exact fields; delay has an exact field and four millisecond nudges. PEQ uses
stable horizontal rows with frequency/gain/Q entry. HPF and LPF have logarithmic
frequency sliders plus exact frequency, family and slope controls. Shared edges
identify both owners. The protection rail reports the existing hard limiter and
read-only compressor parameters; it does not infer live headroom or claim a
normal protection state from configuration alone.

`live-page.js` mounts alignment, limiter and crossover controls once. Delegated
event handlers resolve the current selected channel and current snapshot at
interaction time. Readbacks synchronize values and button states without
replacing controls. PEQ reconciliation inserts/removes only affected stable slot
rows. In-progress input drafts are separate from service snapshots, and numeric
inputs remain focused during commits. Unchanged change/blur events do not start
redundant writes. System Edit remains session-only and starts locked; all write
events, including synthetic events, pass through the same frontend lock gate.

Selected way, graph mode, comparison, XO pair, spectrum settings and editing
context stay in the mounted frontend independently of DSP refreshes. Response
paths are cached by configuration identity, graph range, geometry, channel and
PEQ disabled state. Spectrum samples redraw the overlay without recomputing the
unchanged theoretical response. Phase mode does not redraw on spectrum ticks.
ResizeObserver invalidates geometry through the path cache key. Response
mathematics, topology, service transactions and transport remain unchanged.

At desktop widths all six ways remain in one row beneath the plot, with PEQ beside crossover.
Below 1200 CSS pixels alignment reflows and PEQ/crossover become full-width
sections; below 850 the way selector scrolls horizontally within its own bounds.
Below 600 PEQ fields recompose into labeled rows and crossover edges stack.
The page was screenshot-reviewed in four refinement passes, with final checks at
1920×1080, 1440×900, 1280×800, 1024×768 and 390×844, each at Chromium browser zoom
80%, 100%, 125% and 150%. Review artifacts are local development files under
`artifacts/ui-review/`, not runtime assets.

The Output E2E retains the shared-crossover and PEQ safety round trip, and adds
coverage for persistent DOM identity, numerical focus and scroll, Phase mode
stability, all six ways, XO pairs, comparison/spectrum state, repeated delay and
mute operations, phase/limiter/PEQ/crossover controls, locked-event rejection and
lock reset on reload. Each write test restores and compares the complete demo
configuration. This is software validation only; hardware acceptance remains
pending.

## Touch and product polish

Way tiles show the current live Gain numerically on the −60…+6 dB scale, not
a signal-level meter. Output state (`ON` / `MUTED`) is separate from its
`Mute` / `Unmute` action.

Native range inputs retain keyboard and pointer behavior, with a 44 CSS pixel
interaction area on phones/coarse pointers. Pointer capture retains an active
drag; `touch-action: none` applies only to range inputs, leaving surrounding
content available for ordinary scrolling. Movement previews the range and exact
field locally; release commits once. Cancelled gestures restore the live value.

Alignment and crossover edits can be queued while a guarded write is in flight.
The frontend executes them serially through the unchanged service transaction
architecture. Pending local values survive intervening readbacks; delay nudges
resolve the latest delay when executed. A failed transaction cancels dependent
pending edits. PEQ structural actions remain unavailable during a commit.
Controls and canvas retain their DOM identity, and graph/view state is independent
of the write queue.

On mobile the Output header is compact, two full way tiles fit the scrolling
selector, selected ways scroll into view, and graph modes occupy their own touch
row. Alignment/nudges/polarity and EQ actions have comfortable touch targets.
Each PEQ band is a card with separate frequency, gain and Q rows, 16 px numeric
fields, and clear band/type/power/actions. HPF and LPF stack with prominent exact
frequency and a full-width slider; family, slope and ownership stay secondary.
The current desktop structure is retained.

The focused mobile E2E sends real Chromium touch events through the product UI
against the canonical Linux demo. It checks one write per slider release, no
write during movement, Gain/Phase/Delay sequencing under delayed acknowledgements
on SUB and MID L, crossover drags, touch actions, way scrolling, the +6/−60
bounds, gain-bar mapping and exact final configuration restoration.

This focused polish received two screenshot-based refinement passes, across all
five viewport sizes above at 80/100/125/150% browser zoom, with no document or
editor overflow. Touch QA additionally checks cancelled gestures perform no write
and verifies normal vertical scrolling away from the slider.

The PEQ editor pairs exact frequency/gain/Q fields with native sliders using
the same typography as Input Processing. Frequency dragging is logarithmic.
Pointer movement updates the local field; release queues one guarded scoped
write. Pending controls survive readbacks, and cancellation discards previews.
