# E-Stack DSP documentation

This directory is the canonical entry point for developers and coding agents.
The current product frontend starts at **`/estack-dsp/`**. It is a replacement
frontend served by the standalone E-Stack DSP runtime. It retains the established
CamillaNode-compatible APIs and transport; it is not a second DSP backend.

## Read in this order

1. [E-Stack DSP architecture](estack-dsp-architecture.md) — product layers,
   ownership and migration boundary.
2. [Runtime contracts](runtime-contracts.md) — stable WebSocket and HTTP
   interfaces that product migrations must preserve.
3. [DSP safety model](dsp-safety.md) — required configuration-transaction
   sequence and server-owned workflows.
4. [Persistence](persistence.md) — saved presets, startup recall and browser
   preferences.
5. [Control](pages/control.md) — the current migrated page and its hardware
   acceptance state.
6. [Input Processing](pages/input-processing.md) — live Global EQ/Input Delay
   core and its Stage 2B boundary.
7. [Output Processing](pages/output-processing.md) — six-way post-mixer
   migration and its Stage 3A boundary.
8. [Development simulation and E2E](development.md) — canonical Linux
   Dev Container/Codespaces workflow and software-validation gate.

## Completed product workflow surfaces

- [Loudness](pages/loudness.md) — live server presets and WiiM bridge state.
- [Signal Generator](pages/signal-generator.md) — server-owned safe test workflow.
- [Measurement Batch operator UI](pages/measurement-batch.md) — imported calibration vs. **Measure current system (IN3)**, actual DSP diagnostics, safety and restore.
- [Preferences](pages/preferences.md) — browser-only presentation settings and
  [read-only Connections diagnostics](pages/connections.md).

## Supporting documents

- [Raspberry deployment](raspberry.md) — standalone E-Stack DSP installation/update and
  the boundary with the physical audio stack.
- [Raspberry RC1 procedure](raspberry-rc1.md) — reversible CamillaNode-only
  deployment preparation; physical deployment and hardware acceptance pending.
- [Standalone Raspberry runtime](standalone-runtime.md) — canonical
  `/home/bastos/e-stack-dsp` service layout, one-time migration and rollback.
- [Measurement Batch](measurement-batch.md) — mode comparison, IN3 current-system measurements,
  batch format, gain/mute semantics and server-owned safety workflow.
- [Product entry and migration status](estack-dsp-product.md) — launch modes
  and product mount path.

## Legacy reference material

[architecture.md](architecture.md) and [ui-architecture.md](ui-architecture.md)
document the still-present **legacy CamillaNode frontend** under `public/html/`,
`public/src/` and `public/css/`. They are behavioral/reference material during
migration. New product work belongs under `public/prototypes/estack-ui/` and
must follow the canonical documents above.

## Software release gate

- [System Presets and Startup](pages/system-presets.md) — server-owned capture, recall and boot selection.
- [Advanced](pages/advanced.md) — expert processing controls and secondary live inspector.
- [Operational ownership matrix](operational-ownership.md).
- [Complete live/mock audit](live-mock-audit.md).
- [Software release audit](software-release-audit.md).

**E-STACK DSP SOFTWARE PRODUCT COMPLETE — SOFTWARE ACCEPTED IN SIMULATION.**

## Hardware status

Control is **CODE ACCEPTED — HARDWARE ACCEPTANCE PENDING** at `d1c803e`.
The Raspberry acceptance protocol must be run only when the E-Stack hardware is
available and the task explicitly authorizes real DSP writes.
