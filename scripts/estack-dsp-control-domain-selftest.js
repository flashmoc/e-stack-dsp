'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const sources = ['pipeline.js', 'control-model.js', 'control-service.js'].map(name => fs.readFileSync(path.join(root, 'public/prototypes/estack-ui/shared/domain', name), 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
const gain = value => ({ type: 'Gain', parameters: { gain: value, scale: 'dB', inverted: false, mute: false } });
const limiter = value => ({ type: 'Limiter', parameters: { clip_limit: value } });
const delay = value => ({ type: 'Delay', parameters: { delay: value, unit: 'ms', subsample: false } });
const xo = value => ({ type: 'BiquadCombo', parameters: { type: 'LinkwitzRileyHighpass', freq: value, order: 4 } });
const peq = () => ({ type: 'Biquad', parameters: { type: 'Peaking', freq: 800, gain: 2, q: 1.1 } });

// Mirrors dev/estack-demo.yml's relevant modern topology: Filter `channels`,
// first routing mixer with only OUT 1…6, protection processors and final
// limiter-only Filter steps. The inserted preamp is deliberately pre-mixer.
function currentTopology() {
  const names = ['sub', 'kick', 'mid_l', 'mid_r', 'high_l', 'high_r'];
  const gains = [-13.5, -18.2, -8.8, -8.8, -.1, -.1];
  const limits = [-13.5, -16.7, -4.4, -4.4, -.5, -.5];
  const thresholds = [-14.5, -17.7, -5.4, -5.4, -1.5, -1.5];
  const filters = { ESTACK_INPUT_PREAMP: gain(4) };
  const processors = {};
  const pipeline = [{ type: 'Filter', channels: [0, 1], names: ['ESTACK_INPUT_PREAMP'], description: 'E-Stack input preamp' }, { type: 'Mixer', name: 'estack_preview' }];
  names.forEach((name, channel) => {
    filters[`${name}_hpf`] = xo(channel < 2 ? 130 : 300);
    filters[`${name}_peq`] = peq();
    filters[`${name}_gain`] = gain(gains[channel]);
    filters[`${name}_delay`] = delay(channel / 10);
    filters[`${name}_hard_limit`] = limiter(limits[channel]);
    processors[`${name}_protection`] = { type: 'Compressor', parameters: { process_channels: [channel], threshold: thresholds[channel] } };
    pipeline.push({ type: 'Filter', channels: [channel], names: [`${name}_hpf`, `${name}_peq`, `${name}_gain`, `${name}_delay`] });
  });
  names.forEach(name => pipeline.push({ type: 'Processor', name: `${name}_protection` }));
  names.forEach((name, channel) => pipeline.push({ type: 'Filter', channels: [channel], names: [`${name}_hard_limit`] }));
  return {
    devices: { capture: { type: 'Stdin', channels: 8 }, playback: { type: 'File', channels: 8 } },
    mixers: { estack_preview: { channels: { in: 8, out: 8 }, mapping: names.map((_, dest) => ({ dest, sources: [{ channel: dest < 2 ? dest : dest % 2, gain: 0, mute: false }] })) } },
    processors, filters, pipeline
  };
}

function createDomain(config) {
  let muted = false;
  const local = new Map();
  const bridge = { async command(payload) {
    const name = typeof payload === 'string' ? payload : Object.keys(payload)[0];
    if (name === 'GetConfigJson') return clone(config);
    if (name === 'GetVolume') return -12;
    if (name === 'GetMute') return muted;
    if (name === 'SetMute') { muted = payload.SetMute; return true; }
    if (name === 'SetVolume') return payload.SetVolume;
    if (name === 'SetConfigJson') { config = JSON.parse(payload.SetConfigJson); return true; }
    if (name === 'GetCaptureSignalPeak') return [-100, -100];
    if (name === 'GetPlaybackSignalPeak') return [-100, -100, -100, -100, -100, -100];
    throw new Error(`Unexpected ${name}`);
  }, async api() { return { active: false }; } };
  const context = { window: { EStackDSPBridge: bridge }, localStorage: { getItem: key => local.has(key) ? local.get(key) : null, setItem: (key, value) => local.set(key, String(value)) }, console, setInterval, clearInterval, Date, Math, JSON, Promise };
  context.window.localStorage = context.localStorage;
  sources.forEach((source, index) => vm.runInNewContext(source, context, { filename: ['pipeline.js', 'control-model.js', 'control-service.js'][index] }));
  return { P: context.window.EStackPipeline, M: context.window.EStackControlModel, service: context.window.EStackControlService, getConfig: () => clone(config) };
}

(async () => {
  const { P, M, service, getConfig } = createDomain(currentTopology());
  const base = getConfig();
  await service.refresh();
  await service.setMasterMute(true);
  assert.equal(service.snapshot().masterMuted, true);
  assert.equal(service.snapshot().master, -12);
  assert.deepStrictEqual(getConfig(), base, 'Master mute must not rewrite any way gain or graph');
  await service.setMasterMute(false);
  assert.equal(service.snapshot().masterMuted, false);
  assert.deepStrictEqual(Array.from(P.channelsForStep(base.pipeline[0])), [0, 1], 'modern channels schema is not normalized');
  assert.strictEqual(P.firstMixerContext(base).index, 1, 'first mixer context is wrong');
  assert.deepStrictEqual(Array.from(M.activeOutputs(base)), [0, 1, 2, 3, 4, 5], 'unused playback outputs 6/7 were treated as E-Stack ways');
  const expectedGains = ['sub_gain', 'kick_gain', 'mid_l_gain', 'mid_r_gain', 'high_l_gain', 'high_r_gain'];
  const expectedLimits = ['sub_hard_limit', 'kick_hard_limit', 'mid_l_hard_limit', 'mid_r_hard_limit', 'high_l_hard_limit', 'high_r_hard_limit'];
  expectedGains.forEach((name, channel) => {
    assert.strictEqual(M.gainEntryForChannel(base, channel).name, name, `Gain discovery failed for channel ${channel}`);
    assert.strictEqual(M.hardLimitForChannel(base, channel).name, expectedLimits[channel], `Limiter discovery failed for channel ${channel}`);
    assert.ok(M.protectionForChannel(base, channel), `Protection discovery failed for channel ${channel}`);
  });
  assert.notStrictEqual(M.gainEntryForChannel(base, 0).name, 'ESTACK_INPUT_PREAMP', 'pre-mixer Input Trim was selected as SUB gain');
  const target = { channel: 0, name: 'sub_gain', filter: base.filters.sub_gain };
  const narrow = clone(base); narrow.filters.sub_gain.parameters.gain = -10; narrow.filters.sub_gain.parameters.mute = true;
  assert.doesNotThrow(() => M.assertOnlyWayGainChanged(base, narrow, [target]));
  for (const [label, edit] of [
    ['devices', next => { next.devices.playback.channels = 6; }],
    ['mixer routing', next => { next.mixers.estack_preview.mapping[0].sources[0].mute = true; }],
    ['XO', next => { next.filters.sub_hpf.parameters.freq = 180; }],
    ['PEQ', next => { next.filters.sub_peq.parameters.gain = 5; }],
    ['delay', next => { next.filters.sub_delay.parameters.delay = 3; }],
    ['processor', next => { next.processors.sub_protection.parameters.threshold = -20; }],
    ['hard limiter', next => { next.filters.sub_hard_limit.parameters.clip_limit = -20; }],
    ['unrelated filter', next => { next.filters.kick_gain.parameters.gain = -2; }]
  ]) assert.throws(() => { const next = clone(base); edit(next); M.assertOnlyWayGainChanged(base, next, [target]); }, /unexpectedly/, `${label} mutation was not rejected`);
  await service.setWayGain(2, -7.5);
  let afterGain = getConfig();
  assert.strictEqual(afterGain.filters.mid_l_gain.parameters.gain, -7.5, 'linked MID L gain did not change');
  assert.strictEqual(afterGain.filters.mid_r_gain.parameters.gain, -7.5, 'linked MID R gain did not change');
  assert.strictEqual(afterGain.filters.ESTACK_INPUT_PREAMP.parameters.gain, 4, 'gain operation altered pre-mixer Input Trim');
  await service.setWayMute(2, true);
  let afterMute = getConfig();
  assert.strictEqual(afterMute.filters.mid_l_gain.parameters.mute, true, 'selected MID L mute did not change');
  assert.strictEqual(afterMute.filters.mid_r_gain.parameters.mute, true, 'linked MID R mute did not follow MID L');
  assert.doesNotThrow(() => M.assertOnlyWayMuteChanged(afterGain, afterMute,
    [2, 3].map(channel => ({ name: M.gainEntryForChannel(afterGain, channel).name })), true));
  const invalidMute = clone(afterMute); invalidMute.filters.mid_r_gain.parameters.mute = false;
  assert.throws(() => M.assertOnlyWayMuteChanged(afterGain, invalidMute,
    [2, 3].map(channel => ({ name: M.gainEntryForChannel(afterGain, channel).name })), true), /readback differs/);
  service.setLink('mid', false);
  await service.setWayMute(3, false);
  afterMute = getConfig();
  assert.strictEqual(afterMute.filters.mid_l_gain.parameters.mute, true, 'FREE MID R mute altered MID L');
  assert.strictEqual(afterMute.filters.mid_r_gain.parameters.mute, false, 'FREE MID R mute did not change');
  await service.setWayMute(4, true);
  afterMute = getConfig();
  assert.strictEqual(afterMute.filters.high_l_gain.parameters.mute, true, 'linked HIGH L mute did not change');
  assert.strictEqual(afterMute.filters.high_r_gain.parameters.mute, true, 'linked HIGH R mute did not follow HIGH L');
  await service.telemetry();
  assert.strictEqual(service.availableInputTrim(), null, 'silence produced an automatic Input Trim recommendation');
  console.log('OK:   E-Stack DSP Control modern pipeline, scoped mutations and silence safety');
})().catch(error => { console.error(error.stack || error); process.exit(1); });
