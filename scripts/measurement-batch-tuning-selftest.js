'use strict';

const assert = require('assert');
const fs = require('fs');
const model = require('../server/measurementBatchModel');
require('../server/measurementBatchInputRouting')(model);
const inputState = require('../public/prototypes/estack-ui/shared/domain/input-eq-state');
const schema = require('../schemas/measurement-batch-v3.schema.json');
assert.strictEqual(schema.properties.version.const, 3);
assert.ok(schema.$defs.step.properties.inputEq && schema.$defs.wayOverride.properties.gainDb);

function fixture() {
    const filters = {
        GLOBAL_EQ_01: { type: 'Biquad', parameters: { type: 'Peaking', freq: 125, q: 1, gain: -3 } },
        USER_CH2_PEQ_01: { type: 'Biquad', parameters: { type: 'Peaking', freq: 1350, q: 1, gain: -5 } }
    };
    const pipeline = [{ type: 'Mixer', name: 'routing' }];
    for (let channel = 0; channel < 6; channel++) {
        filters[`gain_${channel}`] = { type: 'Gain', parameters: { gain: -10, scale: 'dB', mute: false, inverted: false } };
        filters[`delay_${channel}`] = { type: 'Delay', parameters: { delay: 1, unit: 'ms' } };
        pipeline.push({ type: 'Filter', channels: [channel], names: [
            ...(channel === 2 ? ['USER_CH2_PEQ_01'] : []), `gain_${channel}`, `delay_${channel}`
        ] });
    }
    const config = {
        devices: { samplerate: 48000, chunksize: 512, capture: { channels: 8 }, playback: { channels: 8 } },
        mixers: { routing: { channels: { in: 8, out: 8 }, mapping: Array.from({ length: 8 }, (_, dest) =>
            ({ dest, sources: [{ channel: dest < 6 ? 0 : 1, gain: 0, scale: 'dB', inverted: false }] })) } },
        processors: { protected: { type: 'Compressor', parameters: { threshold: -10 } } },
        filters, pipeline
    };
    inputState.rebuild(config, { version: 1,
        geq: { enabled: true, fitVersion: 1, targets: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
        peq: { enabled: true, disabled: [] }
    }, { fitGeq: true });
    return config;
}

const base = fixture();
const original = JSON.stringify(base);
const batch = { version: 3, name: 'EQ and way tuning', defaults: { measurementInput: 3 }, steps: [
    { id: 'A', activeWays: ['MID_L', 'HIGH_L'], inputEq: {
        geq: { targets: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
        peq: { bands: [{ slot: 1, freqHz: 125, q: 1, gainDb: -5 }] }
    }, ways: {
        MID_L: { gainDb: -13, peq: [{ slot: 1, type: 'Lowshelf', freqHz: 500, q: 1, gainDb: -4 }] },
        HIGH_L: { peq: [{ slot: 2, freqHz: 4200, q: 1, gainDb: -2 }] }
    } },
    { id: 'B', activeWays: ['MID_L', 'HIGH_L'] }
] };
const normalized = model.normalizeBatch(batch);
const a = model.applyStep(base, normalized, 0);
const b = model.applyStep(base, normalized, 1);
assert.strictEqual(a.filters.GLOBAL_EQ_01.parameters.gain, -5);
assert.strictEqual(inputState.read(a).geq.targets[0], 0);
assert.strictEqual(a.filters.gain_2.parameters.gain, -13);
assert.strictEqual(a.filters.USER_CH2_PEQ_01.parameters.type, 'Lowshelf');
assert.strictEqual(a.filters.USER_CH4_PEQ_02.parameters.gain, -2);
assert.strictEqual(a.filters.gain_0.parameters.mute, true);
assert.deepStrictEqual(a.pipeline.find(s => s.description === 'E-Stack global input EQ').channels, [0, 1, 2]);
assert.deepStrictEqual(a.mixers.routing.mapping[2].sources, [{ channel: 2, gain: 0, scale: 'dB', inverted: false }]);
assert.deepStrictEqual(a.mixers.routing.mapping[6], base.mixers.routing.mapping[6]);
assert.strictEqual(b.filters.GLOBAL_EQ_01.parameters.gain, -3);
assert.strictEqual(inputState.read(b).geq.targets[0], 2);
assert.strictEqual(b.filters.gain_2.parameters.gain, -10);
assert.strictEqual(b.filters.USER_CH2_PEQ_01.parameters.type, 'Peaking');
assert.strictEqual(b.filters.USER_CH4_PEQ_02, undefined);
for (const result of [a, b]) {
    assert.deepStrictEqual(result.devices, base.devices);
    assert.deepStrictEqual(result.processors, base.processors);
    assert.deepStrictEqual(result.mixers.routing.channels, base.mixers.routing.channels);
    assert.deepStrictEqual(result.mixers.routing.mapping.slice(6), base.mixers.routing.mapping.slice(6));
}
assert.strictEqual(JSON.stringify(base), original, 'captured baseline mutated');

const disabled = model.applyStep(base, { version: 3, name: 'disable EQ', steps: [{
    activeWays: ['MID_L'], inputEq: { geq: { enabled: false }, peq: { enabled: false } },
    ways: { MID_L: { gainDb: -16, peq: [{ slot: 1, freqHz: 1350, q: 1, gainDb: -5, enabled: false }] } }
}] }, 0);
assert.strictEqual(inputState.read(disabled).geq.enabled, false);
assert.strictEqual(inputState.read(disabled).peq.enabled, false);
assert.ok(!disabled.pipeline.some(stage => (stage.names || []).includes('USER_CH2_PEQ_01')));
assert.deepStrictEqual(disabled.filters.USER_CH2_PEQ_01, base.filters.USER_CH2_PEQ_01);

function campaign(step) { return { version: 3, name: 'unsafe candidate', steps: [{ activeWays: ['MID_L'], ...step }] }; }
assert.throws(() => model.normalizeBatch({ ...batch, version: 2 }), /inputEq requires batch version 3|gainDb requires batch version 3/);
assert.throws(() => model.normalizeBatch(campaign({ inputEq: { peq: { bands: [{ slot: 1, freqHz: null, q: 1, gainDb: -1 }] } } })), /freqHz must be a finite number/);
assert.throws(() => model.normalizeBatch(campaign({ inputEq: { geq: { targets: [1] } } })), /ten target gains/);
assert.throws(() => model.normalizeBatch(campaign({ inputEq: { peq: { bands: [{ slot: 1, freqHz: 125, q: 1, gainDb: -1 }] } }, disabledFilters: ['GLOBAL_EQ_01'] })), /cannot combine inputEq with disabledFilters/);
assert.throws(() => model.normalizeBatch(campaign({ ways: { MID_L: { muted: true } } })), /muted is not supported/);
assert.throws(() => model.normalizeBatch(campaign({ ways: { MID_L: { peq: [{ slot: 1, freqHz: 1350, q: 1, gainDb: -5, unknown: true }] } } })), /unknown is not supported/);
assert.throws(() => model.normalizeBatch(campaign({ ways: { HIGH_L: { gainDb: -12 } } })), /does not include it in activeWays/);
assert.throws(() => model.normalizeBatch({ ...campaign({}), defaults: { masterDb: -20 } }), /masterDb is not supported/);
assert.throws(() => model.applyStep(base, campaign({ ways: { MID_L: { gainDb: -6 } } }), 0), /captured gain by more than 3 dB/);
assert.throws(() => model.applyStep(base, campaign({ inputEq: { geq: { targets: Array(10).fill(12) } } }), 0), /boosts the captured EQ and gain response/);
assert.throws(() => model.applyStep(base, campaign({ ways: { MID_L: { peq: [{ slot: 1, freqHz: 1350, q: 1, gainDb: -5, enabled: false }] } } }), 0), /boosts the captured EQ and gain response/);
const legacyCut = model.clone(base);
legacyCut.filters.LEGACY_INPUT_CUT = { type: 'Biquad', parameters: { type: 'Peaking', freq: 1000, q: 1, gain: -8 } };
legacyCut.pipeline.unshift({ type: 'Filter', channels: [0, 1], names: ['LEGACY_INPUT_CUT'] });
assert.throws(() => model.applyStep(legacyCut, campaign({ disabledFilters: ['LEGACY_INPUT_CUT'] }), 0), /boosts the captured EQ and gain response/);
assert.throws(() => model.applyStep(base, campaign({ ways: { MID_L: { peq: [{ slot: 1, type: 'Peaking', freqHz: 1350, q: 1, gainDb: 0 }] } } }), 0), /captured baseline by more than 3 dB/);
const shared = model.clone(base);
shared.pipeline.push({ type: 'Filter', channels: [3], names: ['USER_CH2_PEQ_01'] });
assert.throws(() => model.applyStep(shared, campaign({ ways: { MID_L: { peq: [{ slot: 1, freqHz: 1350, q: 1, gainDb: -5 }] } } }), 0), /shared with another stage/);

if (process.env.ESTACK_LIVE_EXPORT_CONFIG) {
    const exported = JSON.parse(fs.readFileSync(process.env.ESTACK_LIVE_EXPORT_CONFIG, 'utf8'));
    assert.strictEqual(exported.schema, 'estack.system-export');
    const live = exported.config;
    inputState.validate(live);
    const liveBatch = campaign({ inputEq: {
        geq: { enabled: false }, peq: { enabled: true, bands: [{ slot: 3, freqHz: 162, q: 0.7, gainDb: -5.8 }] }
    }, ways: { MID_L: { gainDb: Number(live.filters.mid_l_gain.parameters.gain) - 2 } } });
    const changed = model.applyStep(live, liveBatch, 0);
    assert.strictEqual(changed.filters.mid_l_gain.parameters.gain, Number(live.filters.mid_l_gain.parameters.gain) - 2);
    assert.strictEqual(inputState.read(changed).peq.enabled, true);
    assert.deepStrictEqual(changed.devices, live.devices);
    assert.deepStrictEqual(changed.processors, live.processors);
    assert.deepStrictEqual(changed.mixers, live.mixers);
}
console.log('Measurement Batch v3 EQ and way candidates passed');
