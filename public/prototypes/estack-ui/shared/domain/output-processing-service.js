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
  async function transact(mutator, assertion, { exactReadback = false } = {}) {
    const before = await getConfig(); M.discover(before); const next = clone(before); await mutator(next, before); M.assertReferences(next); assertion(before, next);
    await command({ SetConfigJson: JSON.stringify(next) }); const after = await getConfig(); assertion(before, after);
    if (exactReadback && M.fingerprint(after) !== M.fingerprint(next)) throw new Error('Linked output processing readback differs from the requested configuration.');
    latest = after; emit(); return snapshot();
  }
  function selected(config, channel) { const data = M.discover(config).find(item => item.channel === Number(channel)); if (!data) throw new Error(`Unknown E-Stack output channel ${channel}.`); return data; }
  async function setGain(channel, value) {
    return transact(next => { const entry = M.entryForType(next, channel, 'Gain'); entry.filter.parameters.gain = M.normalizeGain(value); }, (before, after) => M.assertGainMutation(before, after, channel));
  }
  async function setLinkedGain(channel, value) {
    const channels = M.linkedPair(channel);
    const target = M.normalizeGain(value);
    return transact(next => {
      channels.forEach(item => { M.entryForType(next, item, 'Gain').filter.parameters.gain = target; });
    }, (before, after) => M.assertLinkedGainMutation(before, after, channels, target), { exactReadback: true });
  }
  async function setMute(channel, muted) { return transact(next => { M.entryForType(next, channel, 'Gain').filter.parameters.mute = !!muted; }, (before, after) => M.assertGainMutation(before, after, channel)); }
  async function setPolarity(channel, inverted) { return transact(next => { M.entryForType(next, channel, 'Gain').filter.parameters.inverted = !!inverted; }, (before, after) => M.assertGainMutation(before, after, channel)); }
  async function setLinkedGainFlag(channel, field, value) {
    const pair = M.linkedPair(channel);
    return transact(next => {
      pair.forEach(item => { M.entryForType(next, item, 'Gain').filter.parameters[field] = !!value; });
    }, (before, after) => M.assertLinkedGainFlagMutation(before, after, pair, field, value), { exactReadback: true });
  }
  function setLinkedMute(channel, muted) { return setLinkedGainFlag(channel, 'mute', muted); }
  function setLinkedPolarity(channel, inverted) { return setLinkedGainFlag(channel, 'inverted', inverted); }
  async function setDelay(channel, value) {
    return transact(next => { const entry = M.entryForType(next, channel, 'Delay'); entry.filter.parameters.delay = M.round(M.clamp(value, 0, 100), 2); }, (before, after) => M.assertDelayMutation(before, after, channel));
  }
  async function setLinkedDelay(channel, value) {
    const target = M.round(M.clamp(value, 0, 100), 2);
    return transact(next => {
      M.linkedPair(channel).forEach(item => { M.entryForType(next, item, 'Delay').filter.parameters.delay = target; });
    }, (before, after) => M.assertLinkedWayMutation(before, after, channel, 'delay', { target }), { exactReadback: true });
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
  async function setLinkedCrossover(channel, edge, patch) {
    const pair = M.linkedPair(channel);
    return transact(next => {
      const selected = M.crossovers(next, channel)[edge];
      if (!selected || pair.some(item => !M.crossovers(next, item)[edge])) throw new Error('Linked crossover edge is missing.');
      const parameters = selected.filter.parameters;
      const currentFamily = /^Butterworth/i.test(parameters.type) ? 'Butterworth' : 'LinkwitzRiley';
      const family = patch.family || currentFamily;
      const slope = [12, 24, 36, 48].includes(Number(patch.slope)) ? Number(patch.slope) : Number(parameters.order || 4) * 6;
      const target = { type: crossoverType(family, edge), freq: M.round(M.clamp(patch.freq ?? parameters.freq, 16, 20000), 1), order: slope / 6 };
      pair.forEach(item => Object.assign(M.crossovers(next, item)[edge].filter.parameters, target));
    }, (before, after) => M.assertLinkedCrossoverMutation(before, after, channel, edge), { exactReadback: true });
  }
  function stageNames(config, channel) { return M.outputStage(config, channel).step.names; }
  function placePhase(config, channel, name) {
    const names = stageNames(config, channel); const gainIndex = names.findIndex(item => config.filters?.[item]?.type === 'Gain'); if (gainIndex < 0) throw new Error(`${M.way(channel).name}: output Gain anchor is missing.`);
    const existing = names.indexOf(name); if (existing >= 0) names.splice(existing, 1); names.splice(gainIndex, 0, name);
  }
  function applyPhase(next, channel, target) {
    const name = M.phaseName(channel); const names = stageNames(next, channel); const existing = names.indexOf(name); if (existing >= 0) names.splice(existing, 1);
    if (Math.abs(target) < .05) { delete next.filters[name]; return; }
    const reference = M.phaseReference(next, channel); const frequency = M.phaseFrequency(target, reference, next.devices?.samplerate);
    next.filters[name] = { type: 'Biquad', description: `E-Stack phase trim ${M.way(channel).name} (${target.toFixed(1)} deg @ ${reference.toFixed(1)} Hz)`, parameters: { type: 'AllpassFO', freq: frequency } };
    placePhase(next, channel, name);
  }
  async function setPhase(channel, degrees) {
    const target = M.round(M.clamp(degrees, -179, 0), 1);
    return transact(next => applyPhase(next, channel, target), (before, after) => M.assertPhaseMutation(before, after, channel));
  }
  async function setLinkedPhase(channel, degrees) {
    const target = M.round(M.clamp(degrees, -179, 0), 1);
    return transact(next => M.linkedPair(channel).forEach(item => applyPhase(next, item, target)),
      (before, after) => M.assertLinkedWayMutation(before, after, channel, 'phase', { target }), { exactReadback: true });
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
  async function copyPeq(sourceChannel, targetChannel, sourceDisabledSlots = []) {
    const source = Number(sourceChannel), target = Number(targetChannel);
    if (!M.linkedPair(source).includes(target) || source === target) throw new Error('PEQ copy requires the opposite way in the same MID or HIGH pair.');
    let copiedDisabled = [];
    const result = await transact((next, before) => {
      const sourceSlots = M.peqSlots(before, source);
      const sourceStage = M.outputStage(before, source).step.names;
      sourceSlots.forEach((entry, slot) => {
        const sourceFilter = before.filters?.[M.peqName(source, slot)];
        const targetFilter = before.filters?.[M.peqName(target, slot)];
        if ((sourceFilter && !entry) || (targetFilter && targetFilter.type !== 'Biquad'))
          throw new Error('PEQ copy found an unexpected filter type in a user slot.');
        if (entry) {
          const p = entry.filter.parameters;
          if (!M.PEQ_TYPES.includes(p?.type) || !Number.isFinite(p?.freq) || !Number.isFinite(p?.gain) || !Number.isFinite(p?.q) ||
              p.freq < 20 || p.freq > 20000 || p.gain < -20 || p.gain > 20 || p.q < .1 || p.q > 20)
            throw new Error('PEQ copy source has an unsupported band.');
        }
      });
      const browserDisabled = normalizeDisabled(sourceDisabledSlots);
      copiedDisabled = sourceSlots.filter(entry => entry && !sourceStage.includes(entry.name) &&
        (browserDisabled.has(entry.slot) || !M.isNeutralPeq(entry.filter))).map(entry => entry.slot);
      sourceSlots.forEach((entry, slot) => {
        const name = M.peqName(target, slot);
        if (!entry) { delete next.filters[name]; return; }
        const copy = M.defaultPeq(target, slot).filter;
        copy.parameters = clone(entry.filter.parameters);
        next.filters[name] = copy;
      });
      syncPeq(next, target, copiedDisabled);
    }, (before, after) => {
      M.assertPeqMutation(before, after, target);
      const sourceSlots = M.peqSlots(before, source);
      const sourceNames = M.outputStage(before, source).step.names;
      const targetNames = M.outputStage(after, target).step.names;
      sourceSlots.forEach((entry, slot) => {
        const copied = after.filters?.[M.peqName(target, slot)];
        if (!!entry !== !!copied || (entry && M.fingerprint(entry.filter.parameters) !== M.fingerprint(copied.parameters)))
          throw new Error('Copied PEQ readback differs from the source.');
        if (entry && sourceNames.includes(entry.name) !== targetNames.includes(M.peqName(target, slot)))
          throw new Error('Copied PEQ activation differs from the source.');
      });
    }, { exactReadback: true });
    return { ...result, disabledSlots: copiedDisabled };
  }
  window.EStackOutputProcessingService = Object.freeze({ refresh, snapshot, setGain, setLinkedGain, setMute, setLinkedMute, setPolarity, setLinkedPolarity, setDelay, setLinkedDelay, setHardLimiter, setCrossover, setLinkedCrossover, setPhase, setLinkedPhase, addPeq, setPeq, resetPeq, deletePeq, copyPeq, subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); } });
})();
