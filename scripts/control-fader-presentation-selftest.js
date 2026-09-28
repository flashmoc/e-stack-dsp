'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const helperPath = path.join(root, 'public/prototypes/estack-ui/pages/control/fader-presentation.js');
const livePath = path.join(root, 'public/prototypes/estack-ui/pages/control/live-page.js');
const localPath = path.join(root, 'public/prototypes/estack-ui/pages/control/local-page.js');
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(helperPath, 'utf8'), context, { filename: helperPath });
const fader = context.window.EStackControlFaderPresentation;

assert.ok(fader, 'Control fader presentation helper was not loaded');
for (const max of [0, 6]) {
  for (const value of [-60, -48, -36, -24, -12, 0, max]) {
    const position = fader.axisPosition(value, max);
    assert(Math.abs(fader.axisValue(position, -60, max) - value) < 1e-9);
    assert(Math.abs(position - (max - value) / (max + 60) * 100) < 1e-9);
  }
  assert.equal(fader.axisPosition(max, max), 0, 'top gain must reach the top');
  assert.equal(fader.axisPosition(-60, max), 100);
}
assert.equal(fader.axisValue(100, -60, 0), -60, 'Master reaches -60 dB');
for (const [value, position] of [[6, 4], [0, 18], [-12, 42], [-30, 68], [-60, 100]]) {
  assert.strictEqual(fader.positionPercent(value, -60, 6), position, `output fader anchor ${value} dB is wrong`);
  assert.strictEqual(fader.valueAtPosition(position, -60, 6), value, `output fader inverse anchor ${position}% is wrong`);
}
assert.strictEqual(fader.positionPercent(0, -50, 0), 0, 'MASTER 0 dB must be at the top of its linear fader');
assert.strictEqual(fader.positionPercent(-25, -50, 0), 50, 'MASTER linear midpoint is wrong');
assert.strictEqual(fader.positionPercent(-50, -50, 0), 100, 'MASTER -50 dB must be at the bottom of its linear fader');
assert.strictEqual(fader.roundToStep(-12.24, -50, 0, .5), -12, 'MASTER commits must quantize to 0.5 dB');
assert.strictEqual(fader.roundToStep(-12.26, -50, 0, .5), -12.5, 'MASTER commits must quantize to 0.5 dB');

const live = fs.readFileSync(livePath, 'utf8');
const local = fs.readFileSync(localPath, 'utf8');
assert.match(live, /legacy-fader-handle/, 'live Control is missing the visible fader handle');
assert.match(live, /legacy-gain-scale/, 'live Control is missing the gain scale');
assert.match(live, /data-level-lock/, 'live Control is missing Level Lock');
assert.match(live, /estack\.control\.level\.locked/, 'Level Lock persistence key changed unexpectedly');
assert.match(live, /if \(isWayLocked\(key\)\) return;/, 'way-gain mutations are not guarded by Level Lock');
assert.match(live, /key === 'master' \? service\.setMaster\(value\) : service\.setWayGain/, 'MASTER no longer uses its dedicated mutation path');
assert.match(live, /const keyboardStep = Number\(fader\.step\) \|\| \.1;/, 'live keyboard increments no longer derive from the fader step');
assert.match(local, /const keyboardStep = Number\(fader\.step\) \|\| \.1;/, 'local keyboard increments no longer derive from the fader step');
assert.match(local, /const faderStep = master \? '\.5' : '\.1';/, 'local MASTER fader is not configured for 0.5 dB steps');

console.log('OK:   Control fader presentation anchors, MASTER stepping and Level Lock surface');
