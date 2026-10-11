'use strict';

const assert = require('assert');
const { applyStep, normalizeBatch } = require('../server/measurementBatchModel');

const gain = () => ({ type: 'Gain', parameters: { gain: -12, scale: 'dB', mute: false, inverted: false } });
const delay = ms => ({ type: 'Delay', parameters: { delay: ms, unit: 'ms' } });
const baseline = {
    devices: { samplerate: 48000 },
    filters: {
        sub_gain: gain(), kick_gain: gain(), mid_l_gain: gain(), mid_r_gain: gain(),
        high_l_gain: gain(), high_r_gain: gain(),
        sub_delay: delay(0), kick_delay: delay(1.3), mid_l_delay: delay(2.76),
        mid_r_delay: delay(2.76), high_l_delay: delay(2.72), high_r_delay: delay(2.72)
    },
    pipeline: [
        { type: 'Mixer', name: 'main' },
        { type: 'Filter', channels: [0], names: ['sub_gain', 'sub_delay'] },
        { type: 'Filter', channels: [1], names: ['kick_gain', 'kick_delay'] },
        { type: 'Filter', channels: [2], names: ['mid_l_gain', 'mid_l_delay'] },
        { type: 'Filter', channels: [3], names: ['mid_r_gain', 'mid_r_delay'] },
        { type: 'Filter', channels: [4], names: ['high_l_gain', 'high_l_delay'] },
        { type: 'Filter', channels: [5], names: ['high_r_gain', 'high_r_delay'] },
        // An existing protection path reuses the zero-ms SUB Delay on all ways.
        ...Array.from({ length: 6 }, (_, channel) => ({ type: 'Filter', channels: [channel], names: ['sub_delay'] }))
    ]
};

const batch = normalizeBatch({ version: 1, name: 'way delay', steps: [{
    activeWays: ['KICK', 'MID_L'],
    ways: { MID_L: { delayOffsetMs: 0.75 }, KICK: { delayOffsetMs: -0.5 } }
}] });
const result = applyStep(baseline, batch, 0);
assert.strictEqual(result.filters.mid_l_delay.parameters.delay, 3.51);
assert.strictEqual(result.filters.kick_delay.parameters.delay, 0.8);
assert.strictEqual(result.filters.sub_delay.parameters.delay, 0);
assert.strictEqual(baseline.filters.mid_l_delay.parameters.delay, 2.76);

const sharedSub = normalizeBatch({ version: 1, name: 'unsafe shared delay', steps: [{
    activeWays: ['SUB'], ways: { SUB: { delayOffsetMs: 0.5 } }
}] });
assert.throws(() => applyStep(baseline, sharedSub, 0), /shared with another output/);

const ambiguous = JSON.parse(JSON.stringify(baseline));
ambiguous.filters.mid_l_extra = delay(0);
ambiguous.pipeline[3].names.push('mid_l_extra');
assert.throws(() => applyStep(ambiguous, batch, 0), /exactly one independent way Delay/);

console.log('OK:   Measurement Batch selects per-way delays without editing shared protection delays');
