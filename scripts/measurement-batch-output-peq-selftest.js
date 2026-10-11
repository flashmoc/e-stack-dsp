'use strict';

const assert = require('assert');
const model = require('../server/measurementBatchModel');

const filters = {};
const pipeline = [{ type: 'Mixer', name: 'test' }];
for (let channel = 0; channel < 6; channel++) {
    filters[`gain_${channel}`] = { type: 'Gain', parameters: { gain: -6, scale: 'dB', mute: false } };
    filters[`delay_${channel}`] = { type: 'Delay', parameters: { delay: 0, unit: 'ms' } };
    pipeline.push({ type: 'Filter', channels: [channel], names: [
        ...(channel === 2 ? ['USER_CH2_PEQ_01'] : []), `gain_${channel}`, `delay_${channel}`
    ] });
}
filters.USER_CH2_PEQ_01 = { type: 'Biquad', parameters: { type: 'Peaking', freq: 1250, q: 1.6, gain: -9 } };
const baseline = { devices: { samplerate: 48000 }, mixers: { test: { channels: { in: 8, out: 8 } } },
    filters, pipeline, processors: { protection: { type: 'Compressor' } } };
const before = JSON.stringify(baseline);
const batch = {
    schema: 'estack.measurement-batch', version: 2, name: 'PEQ self-test',
    defaults: { muteUnlisted: true },
    steps: [
        { id: 'A', activeWays: ['MID_L', 'HIGH_L'], ways: {
            MID_L: { peq: [{ slot: 1, freqHz: 1250, q: 1.6, gainDb: -7 }] },
            HIGH_L: { peq: [{ slot: 1, freqHz: 3900, q: 1.5, gainDb: -2 }] }
        } },
        { id: 'B', activeWays: ['MID_L', 'HIGH_L'], ways: {
            MID_L: { peq: [{ slot: 1, freqHz: 1250, q: 1.6, gainDb: -11 }] }
        } },
        { id: 'C', activeWays: ['MID_L', 'HIGH_L'] }
    ]
};
const normalized = model.normalizeBatch(batch);
assert.strictEqual(normalized.version, 2);
const a = model.applyStep(baseline, normalized, 0);
const b = model.applyStep(baseline, normalized, 1);
const c = model.applyStep(baseline, normalized, 2);
assert.strictEqual(a.filters.USER_CH2_PEQ_01.parameters.gain, -7);
assert.strictEqual(b.filters.USER_CH2_PEQ_01.parameters.gain, -11);
assert.strictEqual(c.filters.USER_CH2_PEQ_01.parameters.gain, -9);
assert.strictEqual(a.filters.USER_CH4_PEQ_01.parameters.gain, -2);
assert.ok(a.pipeline.find(s => s.type === 'Filter' && s.channels?.[0] === 4 && s.names?.includes('gain_4')).names.includes('USER_CH4_PEQ_01'));
assert.ok(!b.filters.USER_CH4_PEQ_01);
assert.deepStrictEqual(a.processors, baseline.processors);
assert.deepStrictEqual(a.devices, baseline.devices);
assert.deepStrictEqual(a.mixers, baseline.mixers);
assert.strictEqual(JSON.stringify(baseline), before);

assert.throws(() => model.normalizeBatch({ ...batch, version: 1 }), /version 2/);
assert.throws(() => model.normalizeBatch({ ...batch, steps: [{ id: 'X', activeWays: ['SUB'], ways: { SUB: { peq: [{ slot: 1, freqHz: 78, q: 2, gainDb: 3 }] } } }] }), /gainDb/);
assert.throws(() => model.normalizeBatch({ ...batch, steps: [{ id: 'X', activeWays: ['SUB'], ways: { SUB: { peq: [{ slot: 1, freqHz: 78, q: 2, gainDb: -2 }, { slot: 1, freqHz: 90, q: 2, gainDb: -2 }] } } }] }), /slot/);
assert.throws(() => model.applyStep(baseline, { ...batch, steps: [{ id: 'X', activeWays: ['MID_L'], ways: {
    MID_L: { peq: [{ slot: 1, freqHz: 1250, q: 1.6, gainDb: -5 }] }
} }] }, 0), /captured baseline/);
const shared = model.clone(baseline);
shared.pipeline.push({ type: 'Filter', channels: [3], names: ['USER_CH2_PEQ_01'] });
assert.throws(() => model.applyStep(shared, batch, 0), /shared with another stage/);
console.log('Measurement Batch output PEQ self-test passed');
