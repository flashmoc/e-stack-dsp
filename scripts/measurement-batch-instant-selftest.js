'use strict';

const assert = require('assert');
const model = require('../server/measurementBatchModel');
require('../server/measurementBatchInputRouting')(model);
const { summarizeBaseline } = require('../server/measurementBatchBaseline');

const keys = ['sub', 'kick', 'mid_l', 'mid_r', 'high_l', 'high_r'];
const gain = (value, mute = false) => ({ type: 'Gain', parameters: { gain: value, scale: 'dB', mute, inverted: false } });
const baseline = {
    devices: { samplerate: 48000, playback: { channels: 8, device: 'hw:fixture' }, capture: { channels: 8 } },
    filters: {
        ESTACK_INPUT_PREAMP: gain(0.5),
        ESTACK_LOUDNESS: { type: 'Loudness', parameters: { fader: 'Aux1', reference_level: -10, low_boost: 6 } },
        GLOBAL_EQ: { type: 'Biquad', parameters: { type: 'Peaking', freq: 65, gain: 3, q: 1 } },
        high_peq: { type: 'Biquad', parameters: { type: 'Peaking', freq: 2800, gain: -2, q: 1.5 } },
        high_hpf: { type: 'BiquadCombo', parameters: { type: 'LinkwitzRileyHighpass', freq: 2000, order: 4 } },
        ...Object.fromEntries(keys.map(key => [`${key}_gain`, gain(key.startsWith('high') ? -24 : -12, key === 'high_r')]))
    },
    mixers: { estack: { channels: { in: 8, out: 8 }, mapping: Array.from({ length: 8 }, (_, dest) => ({ dest, sources: [{ channel: dest % 2, gain: -6.0206 }] })) } },
    processors: {},
    pipeline: [
        { type: 'Filter', channels: [0, 1], names: ['ESTACK_INPUT_PREAMP', 'ESTACK_LOUDNESS', 'GLOBAL_EQ'] },
        { type: 'Mixer', name: 'estack' },
        ...keys.map((key, channel) => ({ type: 'Filter', channels: [channel], names: [...(key.startsWith('high') ? ['high_hpf', 'high_peq'] : []), `${key}_gain`] }))
    ]
};
const original = JSON.parse(JSON.stringify(baseline));
const batch = model.normalizeBatch({ version: 1, name: 'Current system', defaults: { processingMode: 'live-snapshot', measurementInput: 3 }, steps: [{ activeWays: ['SUB', 'HIGH_L', 'HIGH_R'] }] });
const measured = model.applyStep(baseline, batch, 0);
assert.deepStrictEqual(baseline, original, 'capture mutated the live baseline');
assert.deepStrictEqual(measured.devices, original.devices, 'hardware settings changed');
assert.deepStrictEqual(measured.mixers.estack.channels, original.mixers.estack.channels, 'hardware mixer size changed');
for (const mapping of measured.mixers.estack.mapping) {
    if (mapping.dest <= 5) assert.deepStrictEqual(mapping.sources, [{ channel: 2, gain: 0, scale: 'dB', inverted: false }], `OUT${mapping.dest + 1} is not fed from IN3 at unity`);
    else assert.deepStrictEqual(mapping, original.mixers.estack.mapping[mapping.dest], 'non-logical output routing changed');
}
assert.deepStrictEqual(measured.pipeline[0].channels, [0, 1, 2], 'shared input processing was not mirrored onto IN3');
assert.deepStrictEqual(measured.pipeline.slice(1), original.pipeline.slice(1), 'output processing order changed');
for (const name of ['ESTACK_LOUDNESS', 'ESTACK_INPUT_PREAMP', 'GLOBAL_EQ', 'high_peq', 'high_hpf']) {
    assert.deepStrictEqual(measured.filters[name], original.filters[name], `${name} was changed`);
}
assert.equal(measured.filters.high_l_gain.parameters.gain, -24);
assert.equal(measured.filters.high_l_gain.parameters.mute, false);
assert.equal(measured.filters.high_r_gain.parameters.mute, true, 'selected muted way was forcibly unmuted');
assert.equal(measured.filters.mid_l_gain.parameters.mute, true, 'unselected way was not muted');
const view = summarizeBaseline(measured, { processingMode: 'live-snapshot' });
assert.equal(view.measurementPolicy.loudness, 'captured-live');
assert.deepStrictEqual(view.measurementPolicy.forcedOffFilters, []);
assert.equal(view.ways.HIGH_L.eqCount, 1);
assert.equal(view.ways.HIGH_L.filters.find(item => item.kind === 'gain').gainDb, -24);

const revised = JSON.parse(JSON.stringify(baseline));
revised.filters.high_l_gain.parameters.gain = -36;
assert.equal(model.applyStep(revised, batch, 0).filters.high_l_gain.parameters.gain, -36, 'new measurement reused stale gain');
assert.equal(model.applyStep(baseline, batch, 0).filters.high_l_gain.parameters.gain, -24, 'earlier snapshot was mutated');
assert.throws(() => model.normalizeBatch({ version: 1, name: 'bad', defaults: { processingMode: 'live-snapshot', measurementInput: 9 }, steps: [{ activeWays: ['HIGH_L'] }] }), /measurementInput/i);
const tooFewInputs = JSON.parse(JSON.stringify(baseline));
tooFewInputs.mixers.estack.channels.in = 2;
tooFewInputs.devices.capture.channels = 2;
assert.throws(() => model.applyStep(tooFewInputs, batch, 0), /IN3 is unavailable/i);
tooFewInputs.mixers.estack.channels.in = 8;
assert.throws(() => model.applyStep(tooFewInputs, batch, 0), /IN3 is unavailable/i, 'physical capture input count was ignored');
assert.throws(() => model.normalizeBatch({ version: 1, name: 'bad', defaults: { processingMode: 'live-snapshot' }, steps: [{ activeWays: ['HIGH_L'], ways: { HIGH_L: { gainOffsetDb: -2 } } }] }), /no gain/i);
assert.throws(() => model.normalizeBatch({ version: 1, name: 'bad', defaults: { processingMode: 'live-snapshot', disabledFilters: ['GLOBAL_EQ'] }, steps: [{ activeWays: ['HIGH_L'] }] }), /no gain/i);

const calibration = model.applyStep(baseline, { version: 1, name: 'calibration', steps: [{ activeWays: ['HIGH_R'] }] }, 0);
assert.equal(calibration.filters.high_r_gain.parameters.mute, false, 'calibration behavior changed');
assert.ok(!calibration.filters.ESTACK_LOUDNESS || !calibration.pipeline.some(step => step.names?.includes('ESTACK_LOUDNESS')), 'calibration loudness should remain forced off');
console.log('OK:   Measurement current-system capture and calibration separation');
