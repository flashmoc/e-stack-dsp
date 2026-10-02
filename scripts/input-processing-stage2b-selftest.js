'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
const sources = ['pipeline.js', 'input-processing-model.js', 'input-processing-import.js', 'input-processing-service.js', '../saved-config-client.js'];

function topology() {
  return { devices: { samplerate: 48000, capture: { channels: 2 }, playback: { channels: 8 } }, mixers: { routing: { mapping: [{ dest: 0, sources: [{ channel: 0 }] }] } }, filters: { sub_gain: { type: 'Gain', parameters: { gain: -12 } }, sub_delay: { type: 'Delay', parameters: { delay: .3, unit: 'ms', subsample: false } } }, processors: { protection: { type: 'Compressor', parameters: { threshold: -10 } } }, pipeline: [{ type: 'Mixer', name: 'routing' }, { type: 'Filter', channels: [0], names: ['sub_gain', 'sub_delay'] }, { type: 'Processor', name: 'protection' }] };
}
function create(config, stored) {
  const context = { window: {}, console };
  context.window.EStackDSPBridge = { mode: 'camillanode', async command(payload) { const name = typeof payload === 'string' ? payload : Object.keys(payload)[0]; if (name === 'GetConfigJson') return clone(config); if (name === 'SetConfigJson') { config = JSON.parse(payload.SetConfigJson); return true; } throw new Error(`Unexpected ${name}`); }, async api(pathname, options = {}) { if (pathname === '/getConfigFile') return clone(stored); if (pathname === '/saveConfigFile') { const mutation = JSON.parse(options.body); assert.deepStrictEqual(mutation.base, stored); stored = mutation.records; return {}; } throw new Error(`Unexpected ${pathname}`); } };
  sources.forEach(file => vm.runInNewContext(fs.readFileSync(path.join(root, 'public/prototypes/estack-ui', file.startsWith('../') ? `shared/${file.slice(3)}` : `shared/domain/${file}`), 'utf8'), context, { filename: file }));
  return { model: context.window.EStackInputProcessingModel, importer: context.window.EStackInputProcessingImport, service: context.window.EStackInputProcessingService, store: context.window.EStackSavedConfigClient, getConfig: () => clone(config), getStored: () => clone(stored) };
}

(async () => {
  const initialRecords = [{ id: 'system-a', type: 'estack-system', name: 'A', createdDate: '2020-01-01T00:00:00.000Z', data: { untouched: true } }, { id: 'eq-b', type: 'global-eq', name: 'B', createdDate: '2020-01-02T00:00:00.000Z', data: { format: 'estack-global-eq-v1', bands: [] } }, { id: 'other-c', type: 'some-other-type', name: 'C', data: { payload: [1, 2, 3] } }];
  const { model, importer, service, store, getConfig, getStored } = create(topology(), clone(initialRecords));
  let parsed = importer.parse('Filter 1: ON PK Fc 63 Hz Gain 2.5 dB Q 0.70\nFilter 2: OFF PEQ Fc 125 Hz Gain -1.5 dB Q 1.00');
  assert.strictEqual(parsed.format, 'apo'); assert.strictEqual(parsed.bands[0].type, 'Peaking'); assert.strictEqual(parsed.bands[1].enabled, false);
  parsed = importer.parse('Filter 1: ON LS Fc 80 Hz Gain 2 dB Q 0.7\nFilter 2: ON HS Fc 8000 Hz Gain -2 dB Q 0.9');
  assert.deepStrictEqual([parsed.bands[0].type, parsed.bands[1].type], ['Lowshelf', 'Highshelf']);
  parsed = importer.parse('# header\n63, 2.5, 0.70\n125, -1.5, 1.00'); assert.deepStrictEqual(Array.from(parsed.bands.slice(0, 2), band => band.frequency), [63, 125]); assert.strictEqual(parsed.bands[3].frequency, model.GLOBAL_EQ_DEFAULT_FREQUENCIES[3], 'remaining slots reset to canonical defaults');
  parsed = importer.parse('1 63 2.5 .7\n2 125 -1.5 1'); assert.deepStrictEqual(Array.from(parsed.bands.slice(0, 2), band => band.frequency), [63, 125]);
  parsed = importer.parse('{"bands":[{"type":"PK","freq":63,"gain":2,"q":0.7}]}'); assert.strictEqual(parsed.bands[0].gain, 2);
  parsed = importer.parse('{"type":"global-eq","data":{"format":"estack-global-eq-v1","bands":[{"type":"HS","freq":9000,"gain":3,"q":0.8,"enabled":false}]}}'); assert.strictEqual(parsed.bands[0].type, 'Highshelf'); assert.strictEqual(parsed.bands[0].enabled, false);
  parsed = importer.parse('{"filters":{"GLOBAL_EQ_01":{"type":"Biquad","parameters":{"type":"Peaking","freq":63,"gain":2,"q":0.7}},"GLOBAL_EQ_03":{"type":"Biquad","parameters":{"type":"Lowshelf","freq":250,"gain":1,"q":0.8}}},"pipeline":[{"type":"Filter","description":"E-Stack global input EQ","names":["GLOBAL_EQ_01"]}]}');
  assert.strictEqual(parsed.bands[0].frequency, 63, 'Camilla config slot 1'); assert.strictEqual(parsed.bands[1].gain, 0, 'Camilla config missing slot'); assert.strictEqual(parsed.bands[2].enabled, false, 'Camilla config inactive slot');
  parsed = importer.parse(JSON.stringify(Array.from({ length: 12 }, (_, index) => ({ freq: 20 + index, gain: 99, q: 99 }))));
  assert.strictEqual(parsed.detected, 10, 'maximum bands'); assert.strictEqual(parsed.bands[0].gain, 12, 'gain range'); assert.strictEqual(parsed.bands[0].q, 20, 'Q range'); assert.strictEqual(parsed.bands[9].frequency, 29, 'extra imported bands are truncated at ten');
  await service.setDelay(1); const beforeApply = getConfig(); const delayBefore = clone(beforeApply.filters.ESTACK_INPUT_DELAY); const delayStepBefore = clone(beforeApply.pipeline.find(step => step.description === model.INPUT_DELAY_STEP_DESCRIPTION));
  const imported = importer.parse('63, 2.5, .7\n125, -1.5, 1').bands; await service.applyBands(imported, { disabledSlots: [] }); const applied = getConfig();
  assert.strictEqual(applied.filters.GLOBAL_EQ_01.parameters.gain, 2.5); assert.strictEqual(applied.filters.GLOBAL_EQ_02.parameters.gain, -1.5); assert.deepStrictEqual(applied.filters.ESTACK_INPUT_DELAY, delayBefore, 'applyBands changed input delay'); assert.deepStrictEqual(applied.pipeline.find(step => step.description === model.INPUT_DELAY_STEP_DESCRIPTION), delayStepBefore, 'applyBands changed input delay step');
  assert.deepStrictEqual(applied.devices, beforeApply.devices); assert.deepStrictEqual(applied.mixers, beforeApply.mixers); assert.deepStrictEqual(applied.processors, beforeApply.processors); assert.deepStrictEqual(applied.filters.sub_delay, beforeApply.filters.sub_delay);
  const currentBands = model.bandsFromConfig(applied);
  const currentBandCopy = clone(currentBands);
  const presetBands = importer.serializeBands(importer.parse('Filter 1: ON PK Fc 80 Hz Gain 1.5 dB Q 1\nFilter 2: OFF PK Fc 200 Hz Gain 2 dB Q 1\nFilter 3: ON HS Fc 9000 Hz Gain 3 dB Q .8').bands);
  const additions = importer.additionsForPreset(currentBands, presetBands);
  assert.deepStrictEqual(Array.from(additions, band => band.slot), ['GLOBAL_EQ_03', 'GLOBAL_EQ_04']);
  assert.strictEqual(JSON.stringify(currentBands), JSON.stringify(currentBandCopy), 'addition mutated the current band snapshot');
  await service.addBands(additions, { disabledSlots: ['GLOBAL_EQ_02'] });
  const combined = getConfig();
  assert.deepStrictEqual(combined.filters.GLOBAL_EQ_01, applied.filters.GLOBAL_EQ_01, 'addition rewrote current EQ');
  assert.deepStrictEqual(combined.filters.GLOBAL_EQ_02, applied.filters.GLOBAL_EQ_02, 'addition rewrote a disabled band');
  assert.strictEqual(combined.filters.GLOBAL_EQ_03.parameters.freq, 80);
  assert.strictEqual(combined.filters.GLOBAL_EQ_04.parameters.freq, 9000);
  assert.deepStrictEqual(combined.pipeline.find(step => step.description === model.GLOBAL_EQ_STEP_DESCRIPTION).names, ['GLOBAL_EQ_01', 'GLOBAL_EQ_03', 'GLOBAL_EQ_04']);
  assert.deepStrictEqual(combined.devices, beforeApply.devices); assert.deepStrictEqual(combined.mixers, beforeApply.mixers);
  assert.deepStrictEqual(combined.filters.ESTACK_INPUT_DELAY, delayBefore);
  assert.throws(() => importer.additionsForPreset(model.bandsFromConfig(combined), Array.from({ length: 8 }, (_, index) => ({ freq: 100 + index * 100, gain: 1, q: 1 }))), /only 6 of 10 remain/);
  assert.deepStrictEqual(getConfig(), combined, 'rejected addition changed DSP config');
  await assert.rejects(() => service.addBands([{ ...additions[0], slot: 'GLOBAL_EQ_01' }]), /already occupied/);
  assert.deepStrictEqual(getConfig(), combined, 'collision changed DSP config');
  const saved = await store.save({ type: 'global-eq', name: 'New EQ', createdDate: '2021-01-01T00:00:00.000Z', data: { format: 'estack-global-eq-v1', bands: importer.serializeBands(imported) } });
  assert.ok(saved.id); assert.deepStrictEqual(getStored().find(record => record.id === 'system-a'), initialRecords[0]); assert.deepStrictEqual(getStored().find(record => record.id === 'other-c'), initialRecords[2]);
  const renamed = await store.rename(saved.id, 'Renamed EQ');
  assert.equal(renamed.id, saved.id); assert.deepStrictEqual(renamed.data, saved.data);
  assert.deepStrictEqual(getStored().find(record => record.id === 'system-a'), initialRecords[0]);
  await assert.rejects(() => store.rename(saved.id, 'B'), /already exists/);
  await assert.rejects(() => store.rename('system-a', 'System rename'), /System Preset service/);
  const overwritten = await store.save({ type: 'global-eq', name: 'B', createdDate: '2022-01-01T00:00:00.000Z', data: { format: 'estack-global-eq-v1', bands: [] } }, true); assert.strictEqual(overwritten.id, 'eq-b');
  await store.delete(saved.id); assert.strictEqual(getStored().some(record => record.id === saved.id), false); assert.deepStrictEqual(getStored().find(record => record.id === 'system-a'), initialRecords[0]); assert.deepStrictEqual(getStored().find(record => record.id === 'other-c'), initialRecords[2]);
  console.log('OK:   Input Processing import, atomic apply and complete saved-config preservation');
})().catch(error => { console.error(error.stack || error); process.exit(1); });
