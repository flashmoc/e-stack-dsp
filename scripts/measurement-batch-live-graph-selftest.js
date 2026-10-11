'use strict';

const assert = require('assert');
const fs = require('fs');
const model = require('../server/measurementBatchModel');
require('../server/measurementBatchInputRouting')(model);

const clone = value => JSON.parse(JSON.stringify(value));
const gain = () => ({ type: 'Gain', parameters: { gain: -12, scale: 'dB', mute: false, inverted: false } });
const delay = ms => ({ type: 'Delay', parameters: { delay: ms, unit: 'ms' } });
const xo = (type, freq) => ({ type: 'BiquadCombo', parameters: { type, freq, order: 4 } });
const ways = ['sub', 'kick', 'mid_l', 'mid_r', 'high_l', 'high_r'];

// Output stages and shared protection Delay follow the processing graph the
// operator exported. Hardware device names below are synthetic; the fixture
// cannot establish physical connector order on the Raspberry.
function exportedProcessingShape() {
    const filters = {
        sub_delay: delay(0),
        sub_hpf: xo('ButterworthHighpass', 40), sub_lpf: xo('LinkwitzRileyLowpass', 130),
        kick_hpf: xo('LinkwitzRileyHighpass', 130), kick_lpf: xo('LinkwitzRileyLowpass', 300),
        mid_hpf: xo('LinkwitzRileyHighpass', 300), mid_lpf: xo('LinkwitzRileyLowpass', 2000),
        high_hpf: xo('LinkwitzRileyHighpass', 2000)
    };
    const crossoverNames = [
        ['sub_hpf', 'sub_lpf'], ['kick_hpf', 'kick_lpf'],
        ['mid_hpf', 'mid_lpf'], ['mid_hpf', 'mid_lpf'], ['high_hpf'], ['high_hpf']
    ];
    const delays = [0, 1.3, 2.76, 2.76, 2.72, 2.72];
    const pipeline = [{ type: 'Mixer', name: 'estack_preview' }];
    const processors = {};
    for (let channel = 0; channel < ways.length; channel += 1) {
        const way = ways[channel];
        filters[`${way}_gain`] = gain();
        filters[`${way}_hard_limit`] = { type: 'Limiter', parameters: { clip_limit: -5.1, soft_clip: false } };
        if (channel) filters[`${way}_delay`] = delay(delays[channel]);
        pipeline.push({ type: 'Filter', channels: [channel], names: [
            ...crossoverNames[channel], `${way}_gain`, `${way}_delay`
        ] });
    }
    for (let channel = 0; channel < ways.length; channel += 1) {
        const way = ways[channel];
        processors[`${way}_protection`] = { type: 'Compressor', parameters: {
            channels: 8, monitor_channels: [channel], process_channels: [channel], threshold: -6.1
        } };
        pipeline.push({ type: 'Processor', name: `${way}_protection` });
    }
    for (let channel = 0; channel < ways.length; channel += 1) {
        pipeline.push({ type: 'Filter', channels: [channel], names: [
            'sub_delay', `${ways[channel]}_hard_limit`
        ] });
    }
    return {
        devices: { samplerate: 48000, chunksize: 512,
            capture: { type: 'Alsa', channels: 8, device: 'test_capture' },
            playback: { type: 'Alsa', channels: 8, device: 'test_playback' } },
        mixers: { estack_preview: { channels: { in: 8, out: 8 }, mapping:
            Array.from({ length: 8 }, (_, dest) => ({ dest, sources: dest < 6
                ? [{ channel: dest % 2, gain: 0, scale: 'dB', inverted: false }] : [] })) } },
        filters, processors, pipeline
    };
}

const baseline = exportedProcessingShape();
const original = clone(baseline);
const batch = model.normalizeBatch({ version: 1, name: 'independent delays',
    defaults: { measurementInput: 3 }, steps: [{ activeWays: ['KICK', 'MID_L', 'MID_R'],
        ways: { KICK: { delayOffsetMs: -0.5 }, MID_L: { delayOffsetMs: 0.75 },
            MID_R: { delayOffsetMs: -0.75 } } }] });
const applied = model.applyStep(baseline, batch, 0);
assert.strictEqual(applied.filters.kick_delay.parameters.delay, 0.8);
assert.strictEqual(applied.filters.mid_l_delay.parameters.delay, 3.51);
assert.strictEqual(applied.filters.mid_r_delay.parameters.delay, 2.01);
assert.deepStrictEqual(applied.filters.sub_delay, baseline.filters.sub_delay);
assert.deepStrictEqual(applied.devices, baseline.devices);
assert.deepStrictEqual(applied.processors, baseline.processors);
assert.deepStrictEqual(applied.mixers.estack_preview.mapping.slice(6), baseline.mixers.estack_preview.mapping.slice(6));
for (const way of ways) assert.deepStrictEqual(applied.filters[`${way}_hard_limit`], baseline.filters[`${way}_hard_limit`]);
assert.deepStrictEqual(baseline, original, 'step mutated the captured baseline');

const ambiguous = clone(baseline);
ambiguous.filters.mid_l_extra = delay(0);
ambiguous.pipeline[3].names.push('mid_l_extra');
assert.throws(() => model.applyStep(ambiguous, batch, 0), /delay target is ambiguous/);

const multichannel = clone(baseline);
multichannel.pipeline.push({ type: 'Filter', channels: [2, 3], names: ['mid_l_delay'] });
assert.throws(() => model.applyStep(multichannel, batch, 0), /no independent Delay filter.*shared/);

const beforeMixer = clone(baseline);
beforeMixer.pipeline.unshift({ type: 'Filter', channels: [2], names: ['mid_l_delay'] });
assert.throws(() => model.applyStep(beforeMixer, batch, 0), /no independent Delay filter.*shared/);

const sharedInWayStage = clone(baseline);
sharedInWayStage.pipeline[3].names.push('sub_delay');
const stillIndependent = model.applyStep(sharedInWayStage, batch, 0);
assert.strictEqual(stillIndependent.filters.mid_l_delay.parameters.delay, 3.51);
assert.strictEqual(stillIndependent.filters.sub_delay.parameters.delay, 0);

// A full live export was not attached. If provided locally, test the complete
// 34-step campaign against that exact config via ESTACK_LIVE_EXPORT_CONFIG.
const campaignPath = process.env.ESTACK_DELAY_PHASE_CAMPAIGN;
if (campaignPath) {
    const campaign = model.normalizeBatch(JSON.parse(fs.readFileSync(campaignPath, 'utf8')));
    assert.strictEqual(campaign.steps.length, 34);
    const livePath = process.env.ESTACK_LIVE_EXPORT_CONFIG;
    const liveExport = livePath ? JSON.parse(fs.readFileSync(livePath, 'utf8')) : null;
    if (liveExport?.schema === 'estack.system-export') assert.strictEqual(liveExport.scope, 'live');
    const live = liveExport?.config || liveExport || baseline;
    const liveBefore = clone(live);
    for (let index = 0; index < campaign.steps.length; index += 1) {
        const step = model.applyStep(live, campaign, index);
        assert.deepStrictEqual(step.devices, live.devices, `step ${index + 1} changed hardware devices`);
        assert.deepStrictEqual(step.processors, live.processors, `step ${index + 1} changed protections`);
        assert.deepStrictEqual(step.filters.sub_delay, live.filters.sub_delay, `step ${index + 1} changed shared Delay`);
        assert.deepStrictEqual(step.mixers.estack_preview.mapping.slice(6), live.mixers.estack_preview.mapping.slice(6),
            `step ${index + 1} changed the two non-way destinations`);
    }
    assert.deepStrictEqual(live, liveBefore, 'campaign mutated the captured baseline');
    console.log(`OK:   ${campaign.steps.length} campaign steps against ${livePath ? 'attached live export' : 'exported processing shape'}`);
}

console.log('OK:   shared protection Delay, independent way Delays, hardware and ambiguous cases');
