'use strict';

const assert = require('assert');
const fs = require('fs');
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
assert.throws(() => model.normalizeBatch({ ...batch, steps: [{ id: 'X', activeWays: ['SUB'], ways: { SUB: { peq: [{ slot: 1, freqHz: 78, q: 2, gainDb: null }] } } }] }), /gainDb must be a finite number/);
assert.throws(() => model.normalizeBatch({ ...batch, steps: [{ id: 'X', activeWays: ['SUB'], ways: { SUB: { peq: [{ slot: 1, freqHz: '78', q: 2, gainDb: -2 }] } } }] }), /freqHz must be a finite number/);
assert.throws(() => model.normalizeBatch({ ...batch, steps: [{ id: 'X', activeWays: ['SUB'], ways: { SUB: { peq: [{ slot: 1, freqHz: 78, q: 2, gainDb: -2 }, { slot: 1, freqHz: 90, q: 2, gainDb: -2 }] } } }] }), /slot/);
assert.throws(() => model.applyStep(baseline, { ...batch, steps: [{ id: 'X', activeWays: ['MID_L'], ways: {
    MID_L: { peq: [{ slot: 1, freqHz: 1250, q: 1.6, gainDb: -5 }] }
} }] }, 0), /captured baseline/);
const shared = model.clone(baseline);
shared.pipeline.push({ type: 'Filter', channels: [3], names: ['USER_CH2_PEQ_01'] });
assert.throws(() => model.applyStep(shared, batch, 0), /shared with another stage/);
const bypassed = model.clone(baseline);
bypassed.pipeline[3].bypassed = true;
assert.throws(() => model.applyStep(bypassed, batch, 0), /active independent Gain stage/);
const invalidGain = model.clone(baseline);
invalidGain.filters.USER_CH2_PEQ_01.parameters.gain = null;
assert.throws(() => model.applyStep(invalidGain, batch, 0), /invalid captured gain/);

// Keep the operator's export outside the repository; replay against it when
// ESTACK_LIVE_EXPORT_CONFIG is supplied locally.
if (process.env.ESTACK_LIVE_EXPORT_CONFIG) {
    const exported = JSON.parse(fs.readFileSync(process.env.ESTACK_LIVE_EXPORT_CONFIG, 'utf8'));
    assert.strictEqual(exported.schema, 'estack.system-export');
    assert.strictEqual(exported.scope, 'live');
    const live = exported.config;
    const captured = model.clone(live);
    const mid = live.filters.USER_CH2_PEQ_01.parameters;
    const subSlot = Array.from({ length: 10 }, (_, index) => index + 1)
        .find(slot => !live.filters[`USER_CH0_PEQ_${String(slot).padStart(2, '0')}`]);
    assert(subSlot, 'live SUB has no free PEQ slot');
    const candidate = { version: 2, name: 'Live export PEQ check',
        steps: [{ activeWays: ['MID_L', 'SUB'], ways: {
            MID_L: { peq: [{ slot: 1, freqHz: mid.freq, q: mid.q, gainDb: Math.max(-18, mid.gain - 1) }] },
            SUB: { peq: [{ slot: subSlot, freqHz: 80, q: 1, gainDb: -2 }] }
        } }, { activeWays: ['MID_L', 'SUB'] }] };
    const changed = model.applyStep(live, candidate, 0);
    const reset = model.applyStep(live, candidate, 1);
    const subName = `USER_CH0_PEQ_${String(subSlot).padStart(2, '0')}`;
    assert.strictEqual(changed.filters.USER_CH2_PEQ_01.parameters.gain, Math.max(-18, mid.gain - 1));
    assert.strictEqual(changed.filters[subName].parameters.gain, -2);
    assert.strictEqual(reset.filters[subName], undefined);
    assert.deepStrictEqual(reset.filters.USER_CH2_PEQ_01, live.filters.USER_CH2_PEQ_01);
    for (const config of [changed, reset]) {
        assert.deepStrictEqual(config.devices, live.devices);
        assert.deepStrictEqual(config.mixers, live.mixers);
        assert.deepStrictEqual(config.processors, live.processors);
    }
    assert.deepStrictEqual(live, captured, 'candidate mutated the captured baseline');
    console.log('Measurement Batch output PEQ passed against attached live export');
}
console.log('Measurement Batch output PEQ self-test passed');
