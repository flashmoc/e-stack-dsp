# E-Stack DSP live/mock audit

The release navigation exposes ten pages. All are live operational, browser-only
preferences, or read-only live inspection. System Presets includes Startup.
The native mobile select groups Processing, Systems, Tools and System.
Design System is not navigable from the operator shell.

Search scope: complete public/prototypes/estack-ui tree, case-insensitive:
EStackPrototypeDSP, mock-camilladsp, fixtures, LOCAL MODEL, LOCAL SIMULATION,
MOCK, PROTOTYPE. The complete hit inventory is classified below. No operational
category C (fake state reachable as live truth) remains.

## A — explicitly isolated development preview

- shared/mock-camilladsp.js: local adapter and mock message protocol; not loaded live.
- shared/preview-shell.js: local shell model, dynamically loaded only without
  transport=camillanode; also guards itself against live execution.
- pages/control/page.js and pages/input-processing/page.js: conditional loaders;
  mock adapter, local-page.js and fixtures.js occur only in their local branches.
- pages/control/local-page.js, pages/input-processing/local-page.js and their
  fixtures.js: local-only models and LOCAL SIMULATION wording.
- pages/output-processing/page.js: local-mode explanatory text; live branch
  loads the validated real Output page. No local adapter is loaded in live mode.
- pages/measurement-batch/entry.js: local-only dynamic adapter load.
- pages/measurement-batch/page.js: EStackPrototypeDSP is selected only when
  bridge mode is not camillanode. LOCAL MODEL is only that local branch's label.
  The sample import control is hidden and unbound in live mode.

## B — retained reference assets and inert identifiers

- design-system/index.html: explicit developer reference, outside product navigation.
- shared/fixtures.js: retained reference, removed from shell imports.
- pages/{advanced,connections,loudness,preferences,signal-generator,measurement-batch}/fixtures.js:
  unused reference fixtures; none is imported by a live product document.
- pages/loudness/page.css: previous layout reference; current live HTML loads
  workflow-surface.css, not this file.
- prototype-guard.mjs: historical development guard; not part of the runtime or
  release gate. Its filename contains the searched term.
- data-prototype-page and associated selectors in Control/Input/Output loaders,
  Control CSS and shared styles: inert compatibility hooks, not user-visible
  wording or operational state. Preserved to avoid specialist page regressions.
- shared/tokens.css --prototype-* custom properties, shared/components.css,
  shared/product-surface.css and shared/shell.css .prototype-banner/.mock-note
  selectors: compatibility styling/reference; no live mock data source.
- shared/estack-dsp-bridge.js Object.prototype.hasOwnProperty: JavaScript built-in,
  not a mock dependency.
- README.md documents the retained source path and preview boundary; occurrences
  of the search words are documentation only.

## Runtime verification

The release shell E2E traverses every page on desktop and phone, asserts no
EStackPrototypeDSP global, no fixture/mock/preview-shell request and no visible
mock/prototype language. Existing live health tests verify continuous telemetry
and offline clearing. Advanced inspection asserts no writes on opening, and
compares rendered details with the actual demo configuration. Explicit Advanced
edits now use the guarded server API; operator E2E checks staged editing, actual
readback, Master restoration and preserved drafts at phone width.
