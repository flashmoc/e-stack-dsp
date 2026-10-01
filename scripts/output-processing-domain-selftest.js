'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const files = ['pipeline.js', 'output-processing-model.js', 'output-processing-service.js'];
const clone = value => JSON.parse(JSON.stringify(value));

const gain = value => ({ type: 'Gain', parameters: { gain: value, scale: 'dB', inverted: false, mute: false } });
const delay = value => ({ type: 'Delay', parameters: { delay: value, unit: 'ms', subsample: false } });
const limiter = name => ({ type: 'Limiter', description: `${name} final limiter`, parameters: { clip_limit: -3, soft_clip: false } });
const crossover = (type, freq, order = 4) => ({ type: 'BiquadCombo', parameters: { type, freq, order } });

function demoTopology() {
  const filters = {
    GLOBAL_EQ_01: { type: 'Biquad', parameters: { type: 'Peaking', freq: 63, gain: 2, q: .7 } },
    ESTACK_INPUT_DELAY: { type: 'Delay', parameters: { delay: 1, unit: 'ms', subsample: false } },
    sub_hpf_40_bw24: crossover('ButterworthHighpass', 40), sub_lpf_130_lr24: crossover('LinkwitzRileyLowpass', 130), sub_gain: gain(-12), sub_delay: delay(.2), sub_hard_limit: limiter('sub'),
    kick_hpf_130_lr24: crossover('LinkwitzRileyHighpass', 130), kick_lpf_300_lr24: crossover('LinkwitzRileyLowpass', 300), kick_gain: gain(-16), kick_delay: delay(.3), kick_hard_limit: limiter('kick'),
    mid_hpf_300_lr24: crossover('LinkwitzRileyHighpass', 300), mid_lpf_2000_lr24: crossover('LinkwitzRileyLowpass', 2000), mid_l_gain: gain(-12), mid_l_delay: delay(.4), mid_l_hard_limit: limiter('mid-l'), mid_r_gain: gain(-12), mid_r_delay: delay(.4), mid_r_hard_limit: limiter('mid-r'),
    high_hpf_2000_lr24: crossover('LinkwitzRileyHighpass', 2000), high_l_gain: gain(-10), high_l_delay: delay(.5), high_l_hard_limit: limiter('high-l'), high_r_gain: gain(-10), high_r_delay: delay(.5), high_r_hard_limit: limiter('high-r')
  };
  const names = (prefix, hpf, lpf, gainName, delayName) => [hpf, ...(lpf ? [lpf] : []), gainName, delayName];
  return {
    devices: { samplerate: 48000, capture: { type: 'Stdin', channels: 2 }, playback: { type: 'File', channels: 8 } },
    mixers: { routing: { mapping: [0, 1, 2, 3, 4, 5].map(dest => ({ dest, sources: [{ channel: dest, gain: 0 }] })) } },
    filters,
    processors: {
      sub_protection: { type: 'Compressor', parameters: { process_channels: [0], threshold: -12 } }, kick_protection: { type: 'Compressor', parameters: { process_channels: [1], threshold: -12 } }, mid_l_protection: { type: 'Compressor', parameters: { process_channels: [2], threshold: -12 } }, mid_r_protection: { type: 'Compressor', parameters: { process_channels: [3], threshold: -12 } }, high_l_protection: { type: 'Compressor', parameters: { process_channels: [4], threshold: -12 } }, high_r_protection: { type: 'Compressor', parameters: { process_channels: [5], threshold: -12 } }
    },
    pipeline: [
      { type: 'Filter', channels: [0, 1], names: ['GLOBAL_EQ_01', 'ESTACK_INPUT_DELAY'] }, { type: 'Mixer', name: 'routing' },
      { type: 'Filter', channels: [0], names: names('sub', 'sub_hpf_40_bw24', 'sub_lpf_130_lr24', 'sub_gain', 'sub_delay') }, { type: 'Processor', name: 'sub_protection' }, { type: 'Filter', channels: [0], names: ['sub_hard_limit'] },
      { type: 'Filter', channels: [1], names: names('kick', 'kick_hpf_130_lr24', 'kick_lpf_300_lr24', 'kick_gain', 'kick_delay') }, { type: 'Processor', name: 'kick_protection' }, { type: 'Filter', channels: [1], names: ['kick_hard_limit'] },
      { type: 'Filter', channels: [2], names: names('mid-l', 'mid_hpf_300_lr24', 'mid_lpf_2000_lr24', 'mid_l_gain', 'mid_l_delay') }, { type: 'Processor', name: 'mid_l_protection' }, { type: 'Filter', channels: [2], names: ['mid_l_hard_limit'] },
      { type: 'Filter', channels: [3], names: names('mid-r', 'mid_hpf_300_lr24', 'mid_lpf_2000_lr24', 'mid_r_gain', 'mid_r_delay') }, { type: 'Processor', name: 'mid_r_protection' }, { type: 'Filter', channels: [3], names: ['mid_r_hard_limit'] },
      { type: 'Filter', channels: [4], names: names('high-l', 'high_hpf_2000_lr24', null, 'high_l_gain', 'high_l_delay') }, { type: 'Processor', name: 'high_l_protection' }, { type: 'Filter', channels: [4], names: ['high_l_hard_limit'] },
      { type: 'Filter', channels: [5], names: names('high-r', 'high_hpf_2000_lr24', null, 'high_r_gain', 'high_r_delay') }, { type: 'Processor', name: 'high_r_protection' }, { type: 'Filter', channels: [5], names: ['high_r_hard_limit'] }
    ]
  };
}
function create(config, alterReadback = null) {
  let wrote = false;
  const context = { window: {}, console, JSON, Math, Set, Object, Array, Number, String, Promise };
  context.window.EStackDSPBridge = { mode: 'camillanode', async command(payload) { const name = typeof payload === 'string' ? payload : Object.keys(payload)[0]; if (name === 'GetConfigJson') { const result = clone(config); return wrote && alterReadback ? alterReadback(result) : result; } if (name === 'SetConfigJson') { config = JSON.parse(payload.SetConfigJson); wrote = true; return true; } throw new Error(`Unexpected ${name}`); } };
  context.window.EStackDSPBridge.api = async (url, options) => {
    assert.equal(url, '/api/output-protection');
    const { channel, clip } = JSON.parse(options.body);
    config = require('../server/advancedModel').apply(clone(config), { kind: 'protection', channel, clip });
    return { config: clone(config) };
  };
  files.forEach(file => vm.runInNewContext(fs.readFileSync(path.join(root, 'public/prototypes/estack-ui/shared/domain', file), 'utf8'), context, { filename: file }));
  return { model: context.window.EStackOutputProcessingModel, service: context.window.EStackOutputProcessingService, get: () => clone(config) };
}

(async () => {
  const { model, service, get } = create(demoTopology());
  const discovery = await service.refresh();
  assert.deepStrictEqual(Array.from(discovery.ways, item => item.name), ['SUB', 'KICK', 'MID L', 'MID R', 'HIGH L', 'HIGH R']);
  assert.deepStrictEqual(Array.from(discovery.ways, item => item.channel), [0, 1, 2, 3, 4, 5]);
  assert.strictEqual(discovery.ways[2].crossover.hpf.name, discovery.ways[3].crossover.hpf.name);
  assert.strictEqual(discovery.ways[2].crossover.lpf.name, discovery.ways[3].crossover.lpf.name);
  assert.ok(!discovery.ways.some(item => item.stageNames.includes('GLOBAL_EQ_01')), 'pre-mixer Input Processing leaked into an output way');

  assert.deepStrictEqual(clone(model.GAIN_RANGE), { min: -60, max: 6, step: .1 });
  const gainBaseline = get();
  for (const [input, expected] of [[99, 6], [6.1, 6], [-99, -60], [-60, -60], [1.26, 1.3]]) {
    const previous = get(); await service.setGain(0, input); const actual = get();
    assert.strictEqual(actual.filters.sub_gain.parameters.gain, expected);
    const untouched = clone(actual); untouched.filters.sub_gain.parameters.gain = previous.filters.sub_gain.parameters.gain;
    assert.deepStrictEqual(untouched, previous, 'gain normalization changed protected DSP state');
  }
  const invalidGain = get(); invalidGain.filters.sub_gain.parameters.gain = 6.1;
  assert.throws(() => model.assertGainMutation(get(), invalidGain, 0), /Output Gain/);
  invalidGain.filters.sub_gain.parameters.gain = -60.1;
  assert.throws(() => model.assertGainMutation(get(), invalidGain, 0), /Output Gain/);
  await service.setGain(0, gainBaseline.filters.sub_gain.parameters.gain);
  assert.deepStrictEqual(get(), gainBaseline);

  for (const [channel, targets] of [[2, [[2, 'mid_l_gain'], [3, 'mid_r_gain']]], [5, [[4, 'high_l_gain'], [5, 'high_r_gain']]]]) {
    const names = targets.map(([, name]) => name);
    const original = get();
    await service.setLinkedGain(channel, -8.7);
    const linked = get();
    names.forEach(name => assert.strictEqual(linked.filters[name].parameters.gain, -8.7));
    const restored = clone(linked);
    names.forEach(name => { restored.filters[name].parameters.gain = original.filters[name].parameters.gain; });
    assert.deepStrictEqual(restored, original, 'linked gain changed another DSP field');
    const illegal = clone(linked); illegal.filters[names[1]].parameters.mute = true;
    assert.throws(() => model.assertLinkedGainMutation(original, illegal, channel === 2 ? [2, 3] : [4, 5], -8.7), /outside its permitted parameter/);
    const wrongReadback = clone(linked); wrongReadback.filters[names[1]].parameters.gain = -8.8;
    assert.throws(() => model.assertLinkedGainMutation(original, wrongReadback, channel === 2 ? [2, 3] : [4, 5], -8.7), /readback differs/);
    assert.throws(() => model.assertLinkedGainMutation(original, linked, [0, 1], -8.7), /Only MID/);
    for (const [targetChannel, name] of targets) await service.setGain(targetChannel, original.filters[name].parameters.gain);
    assert.deepStrictEqual(get(), original);
  }
  await assert.rejects(() => service.setLinkedGain(0, -8), /Only MID/);

  for (const [channel, pair, names] of [[3, [2, 3], ['mid_l_gain', 'mid_r_gain']], [4, [4, 5], ['high_l_gain', 'high_r_gain']]]) {
    const domain = create(demoTopology());
    const original = domain.get();
    for (const [field, linkedMethod, singleMethod] of [['mute', 'setLinkedMute', 'setMute'], ['inverted', 'setLinkedPolarity', 'setPolarity']]) {
      const before = domain.get();
      await domain.service[linkedMethod](channel, true);
      const linked = domain.get();
      names.forEach(name => assert.strictEqual(linked.filters[name].parameters[field], true));
      const scoped = clone(linked);
      names.forEach(name => { scoped.filters[name].parameters[field] = before.filters[name].parameters[field]; });
      assert.deepStrictEqual(scoped, before, `linked ${field} changed another DSP field`);
      const wrongReadback = clone(linked); wrongReadback.filters[names[1]].parameters[field] = false;
      assert.throws(() => domain.model.assertLinkedGainFlagMutation(before, wrongReadback, pair, field, true), /readback differs/);
      const unrelated = clone(linked); unrelated.filters.sub_gain.parameters.gain = 1;
      assert.throws(() => domain.model.assertLinkedGainFlagMutation(before, unrelated, pair, field, true), /unexpectedly/);
      await domain.service[singleMethod](channel, false);
      assert.strictEqual(domain.get().filters[names[0]].parameters[field], channel === pair[0] ? false : true);
      assert.strictEqual(domain.get().filters[names[1]].parameters[field], channel === pair[1] ? false : true);
      await domain.service[linkedMethod](channel, false);
    }
    assert.deepStrictEqual(domain.get(), original, 'linked mute/polarity round trip did not restore the configuration');
  }
  await assert.rejects(() => service.setLinkedMute(0, true), /Only MID/);

  const stereo = create(demoTopology());
  const stereoOriginal = stereo.get();
  await stereo.service.setLinkedDelay(3, 1.25);
  assert.strictEqual(stereo.get().filters.mid_l_delay.parameters.delay, 1.25);
  assert.strictEqual(stereo.get().filters.mid_r_delay.parameters.delay, 1.25);
  const illegalLinkedDelay = stereo.get(); illegalLinkedDelay.filters.sub_gain.parameters.gain = 1;
  assert.throws(() => stereo.model.assertLinkedWayMutation(stereoOriginal, illegalLinkedDelay, 2, 'delay', { target: 1.25 }), /unexpectedly/);
  await stereo.service.setLinkedDelay(2, .4);
  await stereo.service.setLinkedPhase(2, -30);
  assert.strictEqual(stereo.model.phaseDegrees(stereo.get(), 2), -30);
  assert.strictEqual(stereo.model.phaseDegrees(stereo.get(), 3), -30);
  await stereo.service.setLinkedPhase(3, 0);
  assert.strictEqual(stereo.get().filters.ESTACK_PHASE_CH2, undefined);
  assert.strictEqual(stereo.get().filters.ESTACK_PHASE_CH3, undefined);
  await stereo.service.setLinkedCrossover(3, 'hpf', { freq: 301 });
  assert.strictEqual(stereo.get().filters.mid_hpf_300_lr24.parameters.freq, 301);
  await stereo.service.setLinkedCrossover(2, 'hpf', { freq: 300 });
  assert.deepStrictEqual(stereo.get(), stereoOriginal, 'linked delay, phase and crossover round trip did not restore the exact configuration');

  const highStereo = create(demoTopology());
  const highOriginal = highStereo.get();
  await highStereo.service.setLinkedDelay(5, .87);
  assert.strictEqual(highStereo.get().filters.high_l_delay.parameters.delay, .87);
  assert.strictEqual(highStereo.get().filters.high_r_delay.parameters.delay, .87);
  await highStereo.service.setLinkedDelay(4, .5);
  await highStereo.service.setLinkedPhase(5, -20);
  assert.strictEqual(highStereo.model.phaseDegrees(highStereo.get(), 4), -20);
  assert.strictEqual(highStereo.model.phaseDegrees(highStereo.get(), 5), -20);
  await highStereo.service.setLinkedPhase(4, 0);
  await highStereo.service.setLinkedCrossover(4, 'hpf', { freq: 2001 });
  await highStereo.service.setLinkedCrossover(5, 'hpf', { freq: 2000 });
  assert.deepStrictEqual(highStereo.get(), highOriginal, 'linked HIGH delay, phase and crossover round trip did not restore the exact configuration');

  const peqPair = create(demoTopology());
  await peqPair.service.addPeq(2);
  await peqPair.service.setPeq(2, 0, { freq: 710, gain: 2, q: 1.2 });
  assert.strictEqual(peqPair.get().filters.USER_CH3_PEQ_01, undefined, 'PEQ edit followed the processing link');
  await peqPair.service.addPeq(2);
  await peqPair.service.setPeq(2, 1, { gain: 3 }, [1]);
  await peqPair.service.addPeq(3);
  await peqPair.service.setPeq(3, 0, { gain: -4 });
  await peqPair.service.addPeq(3);
  await peqPair.service.addPeq(3);
  await peqPair.service.setPeq(3, 2, { gain: 1 });
  const beforeCopy = peqPair.get();
  const copied = await peqPair.service.copyPeq(2, 3, [1]);
  assert.deepStrictEqual(Array.from(copied.disabledSlots), [1]);
  assert.deepStrictEqual(peqPair.get().filters.USER_CH3_PEQ_01.parameters, peqPair.get().filters.USER_CH2_PEQ_01.parameters);
  assert.deepStrictEqual(peqPair.get().filters.USER_CH3_PEQ_02.parameters, peqPair.get().filters.USER_CH2_PEQ_02.parameters);
  assert.strictEqual(peqPair.get().filters.USER_CH3_PEQ_03, undefined, 'copy left an extra destination band');
  assert.ok(peqPair.model.outputStage(peqPair.get(), 3).step.names.includes('USER_CH3_PEQ_01'));
  assert.ok(!peqPair.model.outputStage(peqPair.get(), 3).step.names.includes('USER_CH3_PEQ_02'));
  peqPair.model.assertPeqMutation(beforeCopy, peqPair.get(), 3);
  await peqPair.service.setPeq(2, 0, { gain: 4 }, [1]);
  assert.strictEqual(peqPair.get().filters.USER_CH3_PEQ_01.parameters.gain, 2, 'later source edit changed copied PEQ');
  await peqPair.service.copyPeq(3, 2, [1]);
  assert.strictEqual(peqPair.get().filters.USER_CH2_PEQ_01.parameters.gain, 2, 'reverse copy did not update the selected destination');
  await assert.rejects(() => peqPair.service.copyPeq(0, 2), /Only MID|opposite way/);
  const unsupportedCopy = clone(peqPair.get());
  unsupportedCopy.filters.USER_CH3_PEQ_01.parameters.freq = 25000;
  const rejectedCopy = create(unsupportedCopy);
  await assert.rejects(() => rejectedCopy.service.copyPeq(3, 2), /unsupported band/);
  assert.deepStrictEqual(rejectedCopy.get(), unsupportedCopy, 'invalid PEQ copy wrote a DSP configuration');

  const separateEdges = demoTopology();
  separateEdges.filters.mid_r_hpf = clone(separateEdges.filters.mid_hpf_300_lr24);
  separateEdges.pipeline.find(step => step.type === 'Filter' && step.channels?.[0] === 3).names[0] = 'mid_r_hpf';
  const separate = create(separateEdges);
  await separate.service.setLinkedCrossover(2, 'hpf', { freq: 315 });
  assert.strictEqual(separate.get().filters.mid_hpf_300_lr24.parameters.freq, 315);
  assert.strictEqual(separate.get().filters.mid_r_hpf.parameters.freq, 315);
  await separate.service.setLinkedCrossover(3, 'hpf', { freq: 300 });
  assert.deepStrictEqual(separate.get(), separateEdges, 'distinct linked crossover filters did not round trip');
  const copySource = demoTopology();
  copySource.filters.USER_CH2_PEQ_01 = { type: 'Biquad', parameters: { type: 'Peaking', freq: 700, gain: 2, q: 1 } };
  copySource.pipeline.find(step => step.type === 'Filter' && step.channels?.[0] === 2 && step.names.includes('mid_l_gain')).names.splice(2, 0, 'USER_CH2_PEQ_01');
  const changedReadback = create(copySource, config => { config.filters.USER_CH3_PEQ_01.parameters.gain = .1; return config; });
  await assert.rejects(() => changedReadback.service.copyPeq(2, 3), /Copied PEQ readback differs/);

  let before = get(); const midRefs = before.pipeline.filter(step => step.type === 'Filter' && [2, 3].includes(step.channels?.[0])).map(step => clone(step.names));
  await service.setCrossover(2, 'hpf', { freq: 301, family: 'LinkwitzRiley', slope: 24 }); let changed = get();
  assert.strictEqual(changed.filters.mid_hpf_300_lr24.parameters.freq, 301); assert.deepStrictEqual(changed.pipeline.filter(step => step.type === 'Filter' && [2, 3].includes(step.channels?.[0])).map(step => step.names), midRefs);
  assert.deepStrictEqual(changed.filters.sub_delay, before.filters.sub_delay); assert.deepStrictEqual(changed.mixers, before.mixers); assert.deepStrictEqual(changed.devices, before.devices);

  before = get(); await service.setDelay(0, 1.25); changed = get(); assert.strictEqual(changed.filters.sub_delay.parameters.delay, 1.25); assert.deepStrictEqual(changed.filters.kick_delay, before.filters.kick_delay); assert.deepStrictEqual(changed.filters.mid_hpf_300_lr24, before.filters.mid_hpf_300_lr24);
  before = get(); await service.setPolarity(1, true); changed = get(); assert.strictEqual(changed.filters.kick_gain.parameters.inverted, true); assert.deepStrictEqual(changed.filters.sub_gain, before.filters.sub_gain);

  await service.setPhase(0, -20); changed = get(); assert.strictEqual(changed.filters.ESTACK_PHASE_CH0.parameters.type, 'AllpassFO'); let stage = changed.pipeline.find(step => step.type === 'Filter' && step.channels?.[0] === 0 && step.names.includes('sub_gain')); assert.ok(stage.names.indexOf('ESTACK_PHASE_CH0') < stage.names.indexOf('sub_gain'));
  await service.setPhase(0, 0); changed = get(); assert.strictEqual(changed.filters.ESTACK_PHASE_CH0, undefined); assert.ok(!changed.pipeline.some(step => step.names?.includes('ESTACK_PHASE_CH0')));

  const added = await service.addPeq(2, []); assert.strictEqual(added.createdSlot, 0); await service.setPeq(2, 0, { gain: 2, freq: 1000, q: 1 }, []); changed = get(); stage = changed.pipeline.find(step => step.type === 'Filter' && step.channels?.[0] === 2 && step.names.includes('mid_l_gain')); assert.ok(stage.names.indexOf('USER_CH2_PEQ_01') < stage.names.indexOf('mid_l_gain')); assert.ok(!changed.pipeline.some(step => step.channels?.[0] === 3 && step.names?.includes('USER_CH2_PEQ_01')));
  await service.setPeq(2, 0, {}, [0]); changed = get(); assert.ok(changed.filters.USER_CH2_PEQ_01); assert.ok(!changed.pipeline.some(step => step.names?.includes('USER_CH2_PEQ_01')));
  await service.resetPeq(2, 0, []); changed = get(); assert.deepStrictEqual(changed.filters.USER_CH2_PEQ_01.parameters, { type: 'Peaking', freq: 31, gain: 0, q: .7 }); assert.ok(!changed.pipeline.some(step => step.names?.includes('USER_CH2_PEQ_01')));
  await service.deletePeq(2, 0, []); changed = get(); assert.strictEqual(changed.filters.USER_CH2_PEQ_01, undefined);

  before = get(); const originalLimiter = clone(before.filters.sub_hard_limit); await service.setHardLimiter(0, -4); changed = get(); assert.strictEqual(changed.filters.sub_hard_limit.parameters.clip_limit, -4); const unchangedLimiter = clone(changed.filters.sub_hard_limit); delete originalLimiter.parameters.clip_limit; delete unchangedLimiter.parameters.clip_limit; assert.deepStrictEqual(unchangedLimiter, originalLimiter);
  const illegalWay = clone(before); illegalWay.filters.kick_delay.parameters.delay = 9; assert.throws(() => model.assertDelayMutation(before, illegalWay, 0), /unexpectedly/);
  assert.strictEqual(changed.processors.sub_protection.parameters.threshold, -5);
  const unpaired = clone(changed); unpaired.processors.sub_protection.parameters.threshold = -4;
  assert.throws(() => model.assertLimiterMutation(before, unpaired, 0), /exactly 1 dB/);
  const unrelatedProtection = clone(changed); unrelatedProtection.processors.kick_protection.parameters.threshold = -5;
  assert.throws(() => model.assertLimiterMutation(before, unrelatedProtection, 0), /unexpectedly/);
  const sharedProtection = clone(before); sharedProtection.processors.sub_protection.parameters.process_channels = [0, 1];
  await assert.rejects(() => create(sharedProtection).service.setHardLimiter(0, -10), /independent/);
  const missingProtection = clone(before); delete missingProtection.processors.sub_protection;
  await assert.rejects(() => create(missingProtection).service.setHardLimiter(0, -10), /independent/);
  const illegalInput = clone(before); illegalInput.filters.GLOBAL_EQ_01.parameters.gain = 7; assert.throws(() => model.assertDelayMutation(before, illegalInput, 0), /unexpectedly/);
  const illegalMixer = clone(before); illegalMixer.mixers.routing.mapping[0].sources[0].gain = 1; assert.throws(() => model.assertDelayMutation(before, illegalMixer, 0), /unexpectedly/);
  console.log('OK:   Output Processing six-way topology, scoped transactions, PEQ, phase and shared crossover guards');
})().catch(error => { console.error(error.stack || error); process.exit(1); });
