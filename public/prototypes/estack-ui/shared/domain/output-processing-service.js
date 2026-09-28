(() => {
  'use strict';
  const M = window.EStackOutputProcessingModel;
  if (!M) throw new Error('Output Processing model is unavailable.');
  const listeners = new Set();
  let latest = null;
  const command = payload => window.EStackDSPBridge.command(payload);
  const emit = () => listeners.forEach(listener => listener(snapshot()));
  const clone = M.clone;
  const normalizeDisabled = slots => new Set((slots || []).map(Number));

  function snapshot(config = latest) {
    if (!config) return { config: null, ways: [], mode: window.EStackDSPBridge.mode };
    return Object.freeze({ config: clone(config), ways: M.discover(config), sampleRate: Number(config.devices?.samplerate || 48000), mode: window.EStackDSPBridge.mode });
  }
  async function getConfig() { return clone(await command('GetConfigJson')); }
  async function refresh() { latest = await getConfig(); M.discover(latest); emit(); return snapshot(); }
  async function transact(mutator, assertion) {
    const before = await getConfig(); M.discover(before); const next = clone(before); await mutator(next, before); M.assertReferences(next); assertion(before, next);
    await command({ SetConfigJson: JSON.stringify(next) }); const after = await getConfig(); assertion(before, after); latest = after; emit(); return snapshot();
  }
  function selected(config, channel) { const data = M.discover(config).find(item => item.channel === Number(channel)); if (!data) throw new Error(`Unknown E-Stack output channel ${channel}.`); return data; }
  async function setGain(channel, value) {
    return transact(next => { const entry = M.entryForType(next, channel, 'Gain'); entry.filter.parameters.gain = M.normalizeGain(value); }, (before, after) => M.assertGainMutation(before, after, channel));
  }
  async function setLinkedGain(channel, value) {
    const numeric = Number(channel);
    const channels = [2, 3].includes(numeric) ? [2, 3] : [4, 5].includes(numeric) ? [4, 5] : null;
    if (!channels) throw new Error('Only MID L/R and HIGH L/R can have linked Gain.');
    const target = M.normalizeGain(value);
    return transact(next => {
      channels.forEach(item => { M.entryForType(next, item, 'Gain').filter.parameters.gain = target; });
    }, (before, after) => M.assertLinkedGainMutation(before, after, channels, target));
  }
  async function setMute(channel, muted) { return transact(next => { M.entryForType(next, channel, 'Gain').filter.parameters.mute = !!muted; }, (before, after) => M.assertGainMutation(before, after, channel)); }
  async function setPolarity(channel, inverted) { return transact(next => { M.entryForType(next, channel, 'Gain').filter.parameters.inverted = !!inverted; }, (before, after) => M.assertGainMutation(before, after, channel)); }
  async function setDelay(channel, value) {
    return transact(next => { const entry = M.entryForType(next, channel, 'Delay'); entry.filter.parameters.delay = M.round(M.clamp(value, 0, 100), 2); }, (before, after) => M.assertDelayMutation(before, after, channel));
  }
  async function setHardLimiter(channel, value) {
    if (!Number.isFinite(Number(value))) throw new Error('Enter a finite hard limiter threshold.');
    const clip = M.round(M.clamp(value, -60, 0), 1);
    const result = await window.EStackDSPBridge.api('/api/output-protection', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: Number(channel), clip })
    });
    latest = result.config; M.discover(latest); emit(); return snapshot();
  }
  function crossoverType(family, edge) {
    const selected = family === 'Butterworth' ? 'Butterworth' : 'LinkwitzRiley'; return `${selected}${edge === 'hpf' ? 'Highpass' : 'Lowpass'}`;
  }
  async function setCrossover(channel, edge, patch) {
    return transact(next => {
      const entry = M.crossovers(next, channel)[edge]; if (!entry) throw new Error(`${M.way(channel).name}: ${edge.toUpperCase()} is not present.`);
      const parameters = entry.filter.parameters; const currentFamily = /^Butterworth/i.test(parameters.type) ? 'Butterworth' : 'LinkwitzRiley'; const family = patch.family || currentFamily;
      const slope = [12, 24, 36, 48].includes(Number(patch.slope)) ? Number(patch.slope) : Number(parameters.order || 4) * 6;
      parameters.type = crossoverType(family, edge); parameters.freq = M.round(M.clamp(patch.freq ?? parameters.freq, 16, 20000), 1); parameters.order = slope / 6;
    }, (before, after) => M.assertCrossoverMutation(before, after, channel, edge));
  }
  function stageNames(config, channel) { return M.outputStage(config, channel).step.names; }
  function placePhase(config, channel, name) {
    const names = stageNames(config, channel); const gainIndex = names.findIndex(item => config.filters?.[item]?.type === 'Gain'); if (gainIndex < 0) throw new Error(`${M.way(channel).name}: output Gain anchor is missing.`);
    const existing = names.indexOf(name); if (existing >= 0) names.splice(existing, 1); names.splice(gainIndex, 0, name);
  }
  async function setPhase(channel, degrees) {
    const target = M.round(M.clamp(degrees, -179, 0), 1);
    return transact(next => {
      const name = M.phaseName(channel); const names = stageNames(next, channel); const existing = names.indexOf(name); if (existing >= 0) names.splice(existing, 1);
      if (Math.abs(target) < .05) { delete next.filters[name]; return; }
      const reference = M.phaseReference(next, channel); const frequency = M.phaseFrequency(target, reference, next.devices?.samplerate);
      next.filters[name] = { type: 'Biquad', description: `E-Stack phase trim ${M.way(channel).name} (${target.toFixed(1)} deg @ ${reference.toFixed(1)} Hz)`, parameters: { type: 'AllpassFO', freq: frequency } };
      placePhase(next, channel, name);
    }, (before, after) => M.assertPhaseMutation(before, after, channel));
  }
  function syncPeq(config, channel, disabledSlots) {
    const stage = M.outputStage(config, channel).step; const names = M.peqNames(channel); const disabled = normalizeDisabled(disabledSlots); stage.names = (stage.names || []).filter(name => !names.includes(name));
    const active = M.peqSlots(config, channel).filter(entry => entry && M.isPeqActive(entry.filter, disabled.has(entry.slot))).map(entry => entry.name);
    const gainIndex = stage.names.findIndex(name => config.filters?.[name]?.type === 'Gain'); if (gainIndex < 0) throw new Error(`${M.way(channel).name}: output Gain anchor is missing.`);
    const phaseIndex = stage.names.findIndex(name => name === M.phaseName(channel)); stage.names.splice(phaseIndex >= 0 ? phaseIndex : gainIndex, 0, ...active);
  }
  async function addPeq(channel, disabledSlots = []) {
    let created = null;
    const result = await transact(next => {
      const slot = M.peqSlots(next, channel).findIndex(entry => !entry); if (slot < 0) throw new Error(`${M.way(channel).name}: all 10 PEQ slots are in use.`);
      const entry = M.defaultPeq(channel, slot); next.filters[entry.name] = entry.filter; syncPeq(next, channel, disabledSlots); created = slot;
    }, (before, after) => M.assertPeqMutation(before, after, channel));
    return { ...result, createdSlot: created };
  }
  async function setPeq(channel, slot, patch, disabledSlots = []) {
    return transact(next => {
      const name = M.peqName(channel, slot); const existing = next.filters[name]?.type === 'Biquad' ? next.filters[name] : M.defaultPeq(channel, slot).filter;
      existing.parameters = M.normalizePeq(channel, slot, { ...existing.parameters, ...patch }); next.filters[name] = existing; syncPeq(next, channel, disabledSlots);
    }, (before, after) => M.assertPeqMutation(before, after, channel));
  }
  async function resetPeq(channel, slot, disabledSlots = []) { return setPeq(channel, slot, { type: 'Peaking', freq: M.PEQ_DEFAULT_FREQUENCIES[slot], gain: 0, q: .7 }, disabledSlots); }
  async function deletePeq(channel, slot, disabledSlots = []) {
    return transact(next => { delete next.filters[M.peqName(channel, slot)]; syncPeq(next, channel, disabledSlots); }, (before, after) => M.assertPeqMutation(before, after, channel));
  }
  window.EStackOutputProcessingService = Object.freeze({ refresh, snapshot, setGain, setLinkedGain, setMute, setPolarity, setDelay, setHardLimiter, setCrossover, setPhase, addPeq, setPeq, resetPeq, deletePeq, subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); } });
})();
