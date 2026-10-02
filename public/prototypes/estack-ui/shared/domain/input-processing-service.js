(() => {
  'use strict';
  const model = window.EStackInputProcessingModel;
  const pipeline = window.EStackPipeline;
  if (!model || !pipeline) throw new Error('Input Processing domain prerequisites are unavailable.');
  const listeners = new Set();
  let latest = null;
  const clone = model.clone;
  const emit = snapshot => listeners.forEach(listener => listener(snapshot));
  const stepByDescription = (config, description) => (config.pipeline || []).find(step => step?.type === 'Filter' && step?.description === description) || null;
  const canonicalNames = names => [...new Set(names)].sort((a, b) => model.GLOBAL_EQ_SLOT_NAMES.indexOf(a) - model.GLOBAL_EQ_SLOT_NAMES.indexOf(b));
  const disabledSet = slots => new Set((slots || []).map(model.slotName));

  async function getConfig() { return clone(await window.EStackDSPBridge.command('GetConfigJson')); }
  function snapshot(config) {
    return Object.freeze({ config: clone(config), slots: model.bandsFromConfig(config), delay: model.delayFromConfig(config), sampleRate: model.sampleRateForConfig(config), mode: window.EStackDSPBridge.mode });
  }
  async function refresh() { latest = snapshot(await getConfig()); emit(latest); return latest; }
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
  async function upload(before, next, assertion) {
    try { assertion(before, next); } catch (error) { error.message = `Mutation preflight failed: ${error.message}`; throw error; }
    await window.EStackDSPBridge.command({ SetConfigJson: JSON.stringify(next) });
    const after = await getConfig(); try { assertion(before, after); } catch (error) { error.message = `Mutation readback failed: ${error.message}`; throw error; } latest = snapshot(after); emit(latest); return latest;
  }
  function currentBands(config) { return model.bandsFromConfig(config); }
  function applyGlobalStep(config, allBands, disabledSlots) {
    const disabled = disabledSet(disabledSlots);
    const names = allBands.filter(band => !disabled.has(band.slot) && !model.isNeutral(band) && !!config.filters?.[band.slot]).map(band => band.slot);
    if (!names.length) { removeDedicatedStep(config, model.GLOBAL_EQ_STEP_DESCRIPTION); return; }
    const step = ensureStep(config, model.GLOBAL_EQ_STEP_DESCRIPTION); step.names = canonicalNames(names);
  }
  async function setBand(slot, patch, options = {}) {
    const before = await getConfig(); requireInputTopology(before); const next = clone(before); const index = model.slotIndex(slot); const name = model.slotName(index);
    const old = currentBands(before)[index]; const candidate = model.normalizeBand(index, { ...old, ...patch, present: true });
    if (model.isDefaultBand(candidate)) delete next.filters[name]; else next.filters[name] = model.filterForBand(candidate);
    applyGlobalStep(next, currentBands(next), options.disabledSlots || []);
    return upload(before, next, model.assertEqMutation);
  }
  async function applyBands(bands, options = {}) {
    if (!Array.isArray(bands)) throw new Error('Global EQ import must contain bands.');
    const before = await getConfig(); requireInputTopology(before); const next = clone(before);
    const complete = model.GLOBAL_EQ_SLOT_NAMES.map((name, index) => model.normalizeBand(index, { ...(bands[index] || model.defaultBand(index)), present: true }));
    complete.forEach(band => {
      if (model.isDefaultBand(band)) delete next.filters[band.slot]; else next.filters[band.slot] = model.filterForBand(band);
    });
    applyGlobalStep(next, currentBands(next), options.disabledSlots || []);
    return upload(before, next, model.assertEqMutation);
  }
  async function setBandsEnabled(disabledSlots) {
    const before = await getConfig(); requireInputTopology(before); const next = clone(before);
    applyGlobalStep(next, currentBands(next), disabledSlots);
    return upload(before, next, model.assertEqMutation);
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
    applyGlobalStep(next, currentBands(next), options.disabledSlots || []);
    return upload(before, next, model.assertEqMutation);
  }
  async function resetAll(options = {}) {
    const before = await getConfig(); requireInputTopology(before); const next = clone(before);
    model.GLOBAL_EQ_SLOT_NAMES.forEach(name => delete next.filters[name]); removeDedicatedStep(next, model.GLOBAL_EQ_STEP_DESCRIPTION);
    return upload(before, next, model.assertEqMutation);
  }
  async function setDelay(value) {
    const before = await getConfig(); requireInputTopology(before); const next = clone(before); const delay = model.normalizeDelay(value);
    if (delay === 0) { delete next.filters[model.INPUT_DELAY_FILTER]; removeDedicatedStep(next, model.INPUT_DELAY_STEP_DESCRIPTION); }
    else {
      next.filters[model.INPUT_DELAY_FILTER] = { type: 'Delay', description: 'E-Stack shared L/R input delay', parameters: { delay, unit: 'ms', subsample: false } };
      const step = ensureStep(next, model.INPUT_DELAY_STEP_DESCRIPTION); step.names = [model.INPUT_DELAY_FILTER];
    }
    return upload(before, next, model.assertDelayMutation);
  }
  async function readSpectrum() { return window.EStackDSPBridge.spectrumCommand('GetPlaybackSignalPeak'); }
  window.EStackInputProcessingService = Object.freeze({ refresh, setBand, applyBands, setBandsEnabled, addBands, resetAll, setDelay, readSpectrum, get snapshot() { return latest; }, subscribe(listener) { listeners.add(listener); if (latest) listener(latest); return () => listeners.delete(listener); } });
})();
