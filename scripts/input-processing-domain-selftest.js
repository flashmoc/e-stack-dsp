'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const files = ['pipeline.js', 'input-processing-model.js', 'input-processing-service.js'];
const clone = value => JSON.parse(JSON.stringify(value));

function topology() {
  return {
    devices: { samplerate: 48000, capture: { type: 'Stdin', channels: 8 }, playback: { type: 'File', channels: 8 } },
    mixers: { routing: { mapping: [{ dest: 0, sources: [{ channel: 0, gain: 0 }] }, { dest: 1, sources: [{ channel: 1, gain: 0 }] }] } },
    filters: {
      sub_gain: { type: 'Gain', parameters: { gain: -12, scale: 'dB', inverted: false, mute: false } },
      sub_delay: { type: 'Delay', parameters: { delay: .2, unit: 'ms', subsample: false } },
      sub_peq: { type: 'Biquad', parameters: { type: 'Peaking', freq: 90, gain: 2, q: 1 } },
      sub_limit: { type: 'Limiter', parameters: { clip_limit: -10 } }
    },
    processors: { protection: { type: 'Compressor', parameters: { threshold: -11 } } },
    pipeline: [
      { type: 'Mixer', name: 'routing' },
      { type: 'Filter', channels: [0], names: ['sub_peq', 'sub_gain', 'sub_delay'] },
      { type: 'Processor', name: 'protection' },
      { type: 'Filter', channels: [0], names: ['sub_limit'] }
    ]
  };
}
function create(config) {
  const context = { window: {}, console, JSON, Math, Set, Object, Array, Number, String, Promise };
  context.window.EStackDSPBridge = { mode: 'camillanode', async command(payload) {
    const name = typeof payload === 'string' ? payload : Object.keys(payload)[0];
    if (name === 'GetConfigJson') return clone(config);
    if (name === 'SetConfigJson') { config = JSON.parse(payload.SetConfigJson); return true; }
    throw new Error(`Unexpected command ${name}`);
  } };
  files.forEach(file => vm.runInNewContext(fs.readFileSync(path.join(root, 'public/prototypes/estack-ui/shared/domain', file), 'utf8'), context, { filename: file }));
  return { model: context.window.EStackInputProcessingModel, service: context.window.EStackInputProcessingService, get: () => clone(config) };
}

(async () => {
  let config = topology(); const { model, service, get } = create(config);
  assert.deepStrictEqual(Array.from(model.GLOBAL_EQ_SLOT_NAMES), ['GLOBAL_EQ_01','GLOBAL_EQ_02','GLOBAL_EQ_03','GLOBAL_EQ_04','GLOBAL_EQ_05','GLOBAL_EQ_06','GLOBAL_EQ_07','GLOBAL_EQ_08','GLOBAL_EQ_09','GLOBAL_EQ_10']);
  assert.deepStrictEqual(Array.from(model.GLOBAL_EQ_DEFAULT_FREQUENCIES), [31,63,125,250,500,1000,2000,4000,8000,16000]);
  const range = model.normalizeBand(0, { type: 'Other', freq: -5, gain: 28, q: 90 });
  assert.deepStrictEqual({ type: range.type, frequency: range.frequency, gain: range.gain, q: range.q }, { type: 'Peaking', frequency: 20, gain: 12, q: 20 });
  assert.strictEqual(model.isNeutral(model.normalizeBand(0, { gain: .049 })), true, 'neutral threshold changed');
  assert.strictEqual(model.isNeutral(model.normalizeBand(0, { gain: .05 })), false, 'active threshold changed');
  const original = get();
  await service.setBand('GLOBAL_EQ_01', { gain: 3.2 }, { disabledSlots: [] });
  let changed = get();
  assert.strictEqual(changed.filters.GLOBAL_EQ_01.parameters.gain, 3.2);
  const globalStep = changed.pipeline.find(step => step.description === model.GLOBAL_EQ_STEP_DESCRIPTION);
  assert.deepStrictEqual(globalStep.channels, [0, 1]); assert.deepStrictEqual(globalStep.names, ['GLOBAL_EQ_01']);
  assert.strictEqual(changed.pipeline.indexOf(globalStep), 0, 'Global EQ was not inserted before mixer');
  assert.deepStrictEqual(changed.devices, original.devices); assert.deepStrictEqual(changed.mixers, original.mixers); assert.deepStrictEqual(changed.processors, original.processors);
  assert.deepStrictEqual(changed.filters.sub_peq, original.filters.sub_peq); assert.deepStrictEqual(changed.filters.sub_delay, original.filters.sub_delay); assert.deepStrictEqual(changed.filters.sub_limit, original.filters.sub_limit);
  const activeEqFilter = clone(changed.filters.GLOBAL_EQ_01); const activeEqStep = clone(globalStep);
  await service.setBandsEnabled(['GLOBAL_EQ_01']);
  let bypassed = get();
  assert.strictEqual(bypassed.pipeline.some(step => step.description === model.GLOBAL_EQ_STEP_DESCRIPTION), false, 'global toggle did not bypass EQ');
  assert.deepStrictEqual(bypassed.filters.GLOBAL_EQ_01, activeEqFilter, 'global toggle changed filter parameters');
  assert.deepStrictEqual(bypassed.devices, original.devices); assert.deepStrictEqual(bypassed.mixers, original.mixers);
  await service.setBandsEnabled([]);
  changed = get();
  assert.deepStrictEqual(changed.filters.GLOBAL_EQ_01, activeEqFilter, 'global toggle did not restore filter parameters');
  assert.deepStrictEqual(changed.pipeline.find(step => step.description === model.GLOBAL_EQ_STEP_DESCRIPTION), activeEqStep, 'global toggle did not restore EQ step');
  await service.setDelay(1);
  changed = get(); assert.deepStrictEqual(changed.filters.ESTACK_INPUT_DELAY, { type: 'Delay', description: 'E-Stack shared L/R input delay', parameters: { delay: 1, unit: 'ms', subsample: false } });
  assert.deepStrictEqual(changed.pipeline.find(step => step.description === model.INPUT_DELAY_STEP_DESCRIPTION).channels, [0, 1]);
  assert.deepStrictEqual(changed.filters.GLOBAL_EQ_01, activeEqFilter, 'Delay mutation changed the active Global EQ filter');
  assert.deepStrictEqual(changed.pipeline.find(step => step.description === model.GLOBAL_EQ_STEP_DESCRIPTION), activeEqStep, 'Delay mutation changed the Global EQ step');
  const activeDelayFilter = clone(changed.filters.ESTACK_INPUT_DELAY); const activeDelayStep = clone(changed.pipeline.find(step => step.description === model.INPUT_DELAY_STEP_DESCRIPTION));
  await service.setBand('GLOBAL_EQ_01', { gain: 3.3 }, { disabledSlots: [] });
  changed = get(); assert.deepStrictEqual(changed.filters.ESTACK_INPUT_DELAY, activeDelayFilter, 'Global EQ mutation changed the active delay filter');
  assert.deepStrictEqual(changed.pipeline.find(step => step.description === model.INPUT_DELAY_STEP_DESCRIPTION), activeDelayStep, 'Global EQ mutation changed the delay step');
  const illegalDelayDuringEq = clone(changed); illegalDelayDuringEq.filters.ESTACK_INPUT_DELAY.parameters.delay = 2;
  assert.throws(() => model.assertEqMutation(changed, illegalDelayDuringEq), /unexpectedly/, 'EQ guard accepted a delay mutation');
  const illegalEqDuringDelay = clone(changed); illegalEqDuringDelay.filters.GLOBAL_EQ_01.parameters.gain = 4;
  assert.throws(() => model.assertDelayMutation(changed, illegalEqDuringDelay), /unexpectedly/, 'Delay guard accepted a Global EQ mutation');
  await service.setDelay(0);
  changed = get(); assert.strictEqual(changed.filters.ESTACK_INPUT_DELAY, undefined); assert.strictEqual(changed.pipeline.some(step => step.description === model.INPUT_DELAY_STEP_DESCRIPTION), false);
  assert.deepStrictEqual(changed.filters.sub_delay, original.filters.sub_delay, 'input delay changed output delay');
  await service.setBand('GLOBAL_EQ_01', { gain: .04 }, { disabledSlots: [] });
  changed = get(); assert.strictEqual(changed.pipeline.some(step => step.description === model.GLOBAL_EQ_STEP_DESCRIPTION), false, 'neutral EQ remains in active pipeline');
  const flat = model.responseAt(model.defaultBand(0), 31, 48000); assert.ok(Math.abs(flat) < .00001, `neutral RBJ response was ${flat}`);
  const peak = model.responseAt(model.normalizeBand(4, { gain: 6, frequency: 1000, q: 1 }), 1000, 48000); assert.ok(peak > 5.5, `positive peak response was ${peak}`);
  console.log('OK:   Input Processing global EQ, delay scope and RBJ response');
})().catch(error => { console.error(error.stack || error); process.exit(1); });
