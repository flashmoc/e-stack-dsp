(() => {
  'use strict';
  const model = window.EStackInputProcessingModel;
  const pipeline = window.EStackPipeline;
  const stateModel = window.EStackInputEqState;
  if (!model || !pipeline) throw new Error('Input Processing domain prerequisites are unavailable.');
  const listeners = new Set();
  let latest = null, generation = 0;
  const clone = model.clone;
  const emit = snapshot => listeners.forEach(listener => listener(snapshot));
  const stepByDescription = (config, description) => (config.pipeline || []).find(step => step?.type === 'Filter' && step?.description === description) || null;
  const disabledSet = slots => new Set((slots || []).map(model.slotName));

  async function getConfig() { return clone(await window.EStackDSPBridge.command('GetConfigJson')); }
  function snapshot(config) {
    return Object.freeze({ config: clone(config), eq: stateModel.read(config), slots: model.bandsFromConfig(config), delay: model.delayFromConfig(config), sampleRate: model.sampleRateForConfig(config), mode: window.EStackDSPBridge.mode });
  }
  async function refresh() { const request=++generation, config=await getConfig(); if(request===generation){latest=snapshot(config);emit(latest);} return latest; }
  function requireInputTopology(config) {
    const mixer = pipeline.firstMixerContext(config);
    if (!mixer) throw new Error('Input Processing requires a mixer stage.');
    if (Number(config?.devices?.capture?.channels || 0) < 2) throw new Error('Input Processing requires capture channels 0 and 1.');
    return mixer;
  }
  function ensureStep(config, description) {
    const current = stepByDescription(config, description);
    if (current) { current.type = 'Filter'; current.channels = [0, 1]; delete current.channel; current.description = description; current.bypassed = false; current.names = Array.isArray(current.names) ? current.names : []; return current; }
    const mixer = requireInputTopology(config); const step = { type: 'Filter', channels: [0, 1], names: [], description, bypassed: false };
    config.pipeline.splice(mixer.index, 0, step); return step;
  }
  function removeDedicatedStep(config, description) { config.pipeline = (config.pipeline || []).filter(step => step?.description !== description); }
  async function upload(before, next, scope) {
    ++generation; // Do not publish a poll started before this transaction.
    stateModel.assertMutation(before,next,scope);
    const result = await window.EStackDSPBridge.api('/api/input-processing', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scope,before,next})});
    const after=result.config;
    stateModel.assertMutation(before,after,scope);
    latest = snapshot(after); emit(latest); return latest;
  }
  function currentBands(config) { return model.bandsFromConfig(config); }
  function applyGlobalStep(config, allBands, disabledSlots, state=stateModel.read(config)) {
    if(disabledSlots) state.peq.disabled=[...disabledSet(disabledSlots)];
    stateModel.rebuild(config,state);
  }
  async function setBand(slot, patch, options = {}) {
    const before = await getConfig(); requireInputTopology(before); const next = clone(before); const index = model.slotIndex(slot); const name = model.slotName(index);
    const old = currentBands(before)[index]; const candidate = model.normalizeBand(index, { ...old, ...patch, present: true });
    if (model.isDefaultBand(candidate)) delete next.filters[name]; else next.filters[name] = model.filterForBand(candidate);
    applyGlobalStep(next, currentBands(next), options.disabledSlots, stateModel.read(before));
    return upload(before, next, 'peq');
  }
  async function applyBands(bands, options = {}) {
    if (!Array.isArray(bands)) throw new Error('Global EQ import must contain bands.');
    const before = await getConfig(); requireInputTopology(before); const next = clone(before);
    const complete = model.GLOBAL_EQ_SLOT_NAMES.map((name, index) => model.normalizeBand(index, { ...(bands[index] || model.defaultBand(index)), present: true }));
    complete.forEach(band => {
      if (model.isDefaultBand(band)) delete next.filters[band.slot]; else next.filters[band.slot] = model.filterForBand(band);
    });
    applyGlobalStep(next, currentBands(next), options.disabledSlots || [], stateModel.read(before));
    return upload(before, next, 'peq');
  }
  async function setBandsEnabled(disabledSlots) {
    const before = await getConfig(); requireInputTopology(before); const next = clone(before);
    applyGlobalStep(next, currentBands(next), disabledSlots);
    return upload(before, next, 'peq');
  }
  async function addBands(additions, options = {}) {
    if (!Array.isArray(additions) || !additions.length) throw new Error('No EQ bands to add.');
    const before = await getConfig(); requireInputTopology(before); const next = clone(before);
    const unique = new Set();
    additions.forEach(band => {
      const slot = model.slotName(band.slot);
      if (unique.has(slot) || next.filters?.[slot]) throw new Error(`EQ slot ${slot} is already occupied. Nothing changed.`);
      unique.add(slot);
      next.filters[slot] = model.filterForBand(band);
    });
    applyGlobalStep(next, currentBands(next), options.disabledSlots, stateModel.read(before));
    return upload(before, next, 'peq');
  }
  async function resetAll(options = {}) {
    const before = await getConfig(); requireInputTopology(before); const next = clone(before);
    model.GLOBAL_EQ_SLOT_NAMES.forEach(name => delete next.filters[name]); removeDedicatedStep(next, model.GLOBAL_EQ_STEP_DESCRIPTION);
    const state=stateModel.read(before);state.peq.disabled=[];stateModel.rebuild(next,state);
    return upload(before, next, 'peq');
  }
  async function setDelay(value) {
    const before = await getConfig(); requireInputTopology(before); const next = clone(before); const delay = model.normalizeDelay(value);
    if (delay === 0) { delete next.filters[model.INPUT_DELAY_FILTER]; removeDedicatedStep(next, model.INPUT_DELAY_STEP_DESCRIPTION); }
    else {
      next.filters[model.INPUT_DELAY_FILTER] = { type: 'Delay', description: 'E-Stack shared L/R input delay', parameters: { delay, unit: 'ms', subsample: false } };
      const step = ensureStep(next, model.INPUT_DELAY_STEP_DESCRIPTION); step.names = [model.INPUT_DELAY_FILTER];
    }
    stateModel.rebuild(next,stateModel.read(before));
    return upload(before, next, 'delay');
  }
  async function setProcessorEnabled(processor, enabled) {
    if(!['geq','peq'].includes(processor)||typeof enabled!=='boolean') throw new Error('Invalid EQ processor state.');
    const before=await getConfig(), next=clone(before), state=stateModel.read(before);
    state[processor].enabled=enabled; stateModel.rebuild(next,state);
    return upload(before,next,processor);
  }
  async function setGraphicEq(targets, enabled) {
    const before=await getConfig(),next=clone(before),state=stateModel.read(before);
    state.geq.targets=targets; if(enabled!==undefined) state.geq.enabled=enabled;
    stateModel.rebuild(next,state,{fitGeq:true});
    return upload(before,next,'geq');
  }
  async function readSpectrum() { return window.EStackDSPBridge.spectrumCommand('GetPlaybackSignalPeak'); }
  async function readCapturePeaks() { return window.EStackDSPBridge.command('GetCaptureSignalPeak'); }
  window.EStackInputProcessingService = Object.freeze({ refresh, setBand, applyBands, setBandsEnabled, addBands, resetAll, setDelay, setGraphicEq, setProcessorEnabled, readSpectrum, readCapturePeaks, get snapshot() { return latest; }, subscribe(listener) { listeners.add(listener); if (latest) listener(latest); return () => listeners.delete(listener); } });
})();
