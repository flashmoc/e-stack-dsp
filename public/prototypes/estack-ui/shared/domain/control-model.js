(() => {
  'use strict';

  const P = window.EStackPipeline;
  if (!P) throw new Error('E-Stack pipeline domain must load before Control model');
  const WAY_DEFINITIONS = Object.freeze([
    { channel: 0, id: 'sub', name: 'SUB', color: '#55d8e7' },
    { channel: 1, id: 'kick', name: 'KICK', color: '#f2a532' },
    { channel: 2, id: 'mid-l', name: 'MID L', color: '#59cc86' },
    { channel: 3, id: 'mid-r', name: 'MID R', color: '#50b884' },
    { channel: 4, id: 'high-l', name: 'HIGH L', color: '#a878e7' },
    { channel: 5, id: 'high-r', name: 'HIGH R', color: '#d664ca' }
  ]);
  const LINK_DEFINITIONS = Object.freeze({
    mid: { label: 'MID L/R', channels: [2, 3], storageKey: 'estack.control.link.mid' },
    high: { label: 'HIGH L/R', channels: [4, 5], storageKey: 'estack.control.link.high' }
  });
  const CALIBRATED_LIMIT_VRMS = Object.freeze({ 0: 50.0, 1: 34.64, 2: 25.30, 3: 25.30, 4: 11.50, 5: 11.50 });
  const INPUT_TRIM_FILTER = 'ESTACK_INPUT_PREAMP';
  const INPUT_TRIM_DESCRIPTION = 'E-Stack input preamp';

  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const stable = value => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
    return value;
  };
  const fingerprint = value => JSON.stringify(stable(value));
  const protectedStructure = config => fingerprint({ devices: config?.devices || {}, pipeline: config?.pipeline || [], mixers: config?.mixers || {}, processors: config?.processors || {} });
  const activeOutputs = config => P.logicalWayChannels(config);
  const way = channel => WAY_DEFINITIONS.find(item => item.channel === Number(channel)) || { channel: Number(channel), name: `OUT ${Number(channel) + 1}`, color: '#55d8e7' };
  const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;

  function gainEntryForChannel(config, channel) {
    for (const name of P.directPostMixerFilterNames(config, channel)) {
      const filter = config?.filters?.[name];
      if (filter?.type === 'Gain') return { name, filter };
    }
    return null;
  }

  function hardLimitForChannel(config, channel) {
    return P.directPostMixerFilterNames(config, channel)
      .map(name => ({ name, clip: finite(config?.filters?.[name]?.parameters?.clip_limit), filter: config?.filters?.[name] }))
      .filter(item => item.filter?.type === 'Limiter' && item.clip !== null)
      .sort((a, b) => a.clip - b.clip)[0] || null;
  }

  function protectionForChannel(config, channel) {
    const active = new Set((config?.pipeline || []).filter(item => item?.type === 'Processor' && item?.name).map(item => String(item.name)));
    return Object.entries(config?.processors || {})
      .filter(([name, processor]) => active.has(name) && processor?.type === 'Compressor')
      .map(([name, processor]) => ({ name, threshold: finite(processor?.parameters?.threshold), channels: (processor?.parameters?.process_channels || []).map(Number) }))
      .filter(item => item.threshold !== null && item.channels.includes(Number(channel)))
      .sort((a, b) => a.threshold - b.threshold)[0] || null;
  }

  function assertOnlyWayGainChanged(before, after, targets) {
    const allowed = new Set(targets.map(target => target.name));
    if (protectedStructure(before) !== protectedStructure(after)) throw new Error('Protected DSP structure changed unexpectedly');
    const beforeFilters = before?.filters || {}; const afterFilters = after?.filters || {};
    if (fingerprint(Object.keys(beforeFilters).sort()) !== fingerprint(Object.keys(afterFilters).sort())) throw new Error('DSP filter inventory changed unexpectedly');
    for (const name of Object.keys(beforeFilters)) {
      if (!allowed.has(name) && fingerprint(beforeFilters[name]) !== fingerprint(afterFilters[name])) throw new Error(`Unrelated filter '${name}' changed unexpectedly`);
    }
    for (const target of targets) {
      const oldFilter = beforeFilters[target.name]; const nextFilter = afterFilters[target.name];
      if (!oldFilter || oldFilter.type !== 'Gain' || !nextFilter || nextFilter.type !== 'Gain') throw new Error(`Gain filter '${target.name}' changed type or disappeared`);
      const oldRest = clone(oldFilter); const nextRest = clone(nextFilter);
      delete oldRest.parameters?.gain; delete oldRest.parameters?.mute;
      delete nextRest.parameters?.gain; delete nextRest.parameters?.mute;
      if (fingerprint(oldRest) !== fingerprint(nextRest)) throw new Error(`Gain filter '${target.name}' changed outside gain/mute`);
    }
  }

  function assertOnlyWayMuteChanged(before, after, targets, muted) {
    assertOnlyWayGainChanged(before, after, targets);
    for (const target of targets) {
      const oldFilter = clone(before.filters[target.name]);
      const nextFilter = clone(after.filters[target.name]);
      if (nextFilter.parameters.mute !== !!muted) throw new Error(`${target.name}: mute readback differs from the requested state`);
      delete oldFilter.parameters.mute;
      delete nextFilter.parameters.mute;
      if (fingerprint(oldFilter) !== fingerprint(nextFilter)) throw new Error(`${target.name}: changed outside mute`);
    }
  }

  function removeInputTrim(config) {
    for (const step of config?.pipeline || []) {
      if (step?.type === 'Filter' && Array.isArray(step.names)) step.names = step.names.filter(name => name !== INPUT_TRIM_FILTER);
    }
    if (Array.isArray(config?.pipeline)) config.pipeline = config.pipeline.filter(step => !(step?.type === 'Filter' && step?.description === INPUT_TRIM_DESCRIPTION && (!step.names || step.names.length === 0)));
    if (config?.filters) delete config.filters[INPUT_TRIM_FILTER];
    return config;
  }

  function installInputTrim(config, gain) {
    removeInputTrim(config);
    if (Math.abs(gain) <= .01) return config;
    if (Number(config?.devices?.capture?.channels) < 2) throw new Error('Input Trim requires capture channels 1 + 2');
    if (!(config?.pipeline || []).some(step => step?.type === 'Mixer')) throw new Error('Input Trim requires a Mixer stage');
    config.filters = config.filters || {};
    config.filters[INPUT_TRIM_FILTER] = { type: 'Gain', description: `E-Stack global input trim · ${gain > 0 ? '+' : ''}${gain.toFixed(1)} dB`, parameters: { gain, scale: 'dB', inverted: false, mute: false } };
    config.pipeline.unshift({ type: 'Filter', channels: [0, 1], names: [INPUT_TRIM_FILTER], description: INPUT_TRIM_DESCRIPTION, bypassed: false });
    return config;
  }

  function inputTrimValue(config) {
    const filter = config?.filters?.[INPUT_TRIM_FILTER];
    const step = (config?.pipeline || []).find(item => item?.type === 'Filter' && (item?.description === INPUT_TRIM_DESCRIPTION || item?.names?.includes(INPUT_TRIM_FILTER)));
    return filter?.type === 'Gain' && step && finite(filter?.parameters?.gain) !== null ? finite(filter.parameters.gain) : 0;
  }

  function assertOnlyInputTrimChanged(before, after) {
    const withoutBefore = clone(before); const withoutAfter = clone(after);
    removeInputTrim(withoutBefore); removeInputTrim(withoutAfter);
    if (fingerprint(withoutBefore) !== fingerprint(withoutAfter)) throw new Error('DSP processing outside Input Trim changed unexpectedly');
  }

  window.EStackControlModel = Object.freeze({ WAY_DEFINITIONS, LINK_DEFINITIONS, CALIBRATED_LIMIT_VRMS, clone, fingerprint, protectedStructure, activeOutputs, way, finite, gainEntryForChannel, hardLimitForChannel, protectionForChannel, assertOnlyWayGainChanged, assertOnlyWayMuteChanged, removeInputTrim, installInputTrim, inputTrimValue, assertOnlyInputTrimChanged });
})();
