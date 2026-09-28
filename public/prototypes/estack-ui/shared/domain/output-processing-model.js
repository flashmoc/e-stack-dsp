(() => {
  'use strict';
  const P = window.EStackPipeline;
  if (!P) throw new Error('Output Processing requires the shared pipeline model.');

  const WAY_DEFINITIONS = Object.freeze([
    { channel: 0, id: 'sub', name: 'SUB', color: '#55d8e7' },
    { channel: 1, id: 'kick', name: 'KICK', color: '#f2a532' },
    { channel: 2, id: 'mid-l', name: 'MID L', color: '#59cc86' },
    { channel: 3, id: 'mid-r', name: 'MID R', color: '#50b884' },
    { channel: 4, id: 'high-l', name: 'HIGH L', color: '#a878e7' },
    { channel: 5, id: 'high-r', name: 'HIGH R', color: '#d664ca' }
  ]);
  const PEQ_DEFAULT_FREQUENCIES = Object.freeze([31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);
  const PEQ_TYPES = Object.freeze(['Peaking', 'Lowshelf', 'Highshelf']);
  const GAIN_RANGE = Object.freeze({ min: -60, max: 6, step: .1 });
  const clone = value => JSON.parse(JSON.stringify(value));
  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number.isFinite(Number(value)) ? Number(value) : minimum));
  const round = (value, precision = 6) => Number(Number(value).toFixed(precision));
  const normalizeGain = value => round(clamp(value, GAIN_RANGE.min, GAIN_RANGE.max), 1);
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.keys(value).sort().reduce((result, key) => { result[key] = stable(value[key]); return result; }, {}) : value;
  const fingerprint = value => JSON.stringify(stable(value));
  const way = channel => WAY_DEFINITIONS.find(item => item.channel === Number(channel));
  const phaseName = channel => `ESTACK_PHASE_CH${Number(channel)}`;
  const peqName = (channel, slot) => `USER_CH${Number(channel)}_PEQ_${String(Number(slot) + 1).padStart(2, '0')}`;
  const peqNames = channel => PEQ_DEFAULT_FREQUENCIES.map((_, slot) => peqName(channel, slot));

  function validateReferences(config) {
    const errors = [];
    if (!config?.devices?.capture || !config?.devices?.playback) errors.push('DSP devices are missing');
    for (const [index, step] of (config?.pipeline || []).entries()) {
      if (step?.type === 'Mixer' && !config?.mixers?.[step.name]) errors.push(`pipeline ${index}: missing mixer '${step.name}'`);
      if (step?.type === 'Processor' && !config?.processors?.[step.name]) errors.push(`pipeline ${index}: missing processor '${step.name}'`);
      if (step?.type === 'Filter') (step.names || []).forEach(name => { if (!config?.filters?.[name]) errors.push(`pipeline ${index}: missing filter '${name}'`); });
    }
    return errors;
  }
  function assertReferences(config) { const errors = validateReferences(config); if (errors.length) throw new Error(`Invalid DSP graph: ${errors.join('; ')}`); }
  function postMixerFilterSteps(config, channel) {
    const context = P.firstMixerContext(config); if (!context) throw new Error('Output Processing requires a first Mixer stage.');
    return (config.pipeline || []).map((step, index) => ({ step, index })).filter(item => item.index > context.index && P.stepHasChannel(item.step, channel));
  }
  function outputStage(config, channel) {
    const stage = postMixerFilterSteps(config, channel).find(item => (item.step.names || []).some(name => config.filters?.[name]?.type === 'Gain'));
    if (!stage) throw new Error(`${way(channel)?.name || `OUT ${Number(channel) + 1}`}: no post-mixer output Gain stage.`);
    if (P.channelsForStep(stage.step).length !== 1 || P.channelsForStep(stage.step)[0] !== Number(channel)) throw new Error(`${way(channel)?.name || channel}: output stage must be independent.`);
    return stage;
  }
  function entryForType(config, channel, type) {
    return (outputStage(config, channel).step.names || []).map(name => ({ name, filter: config.filters?.[name] })).find(item => item.filter?.type === type) || null;
  }
  function limiterEntry(config, channel) {
    return postMixerFilterSteps(config, channel).flatMap(item => item.step.names || []).map(name => ({ name, filter: config.filters?.[name] })).find(item => item.filter?.type === 'Limiter') || null;
  }
  function crossovers(config, channel) {
    const result = { hpf: null, lpf: null };
    for (const name of outputStage(config, channel).step.names || []) {
      const filter = config.filters?.[name]; const type = String(filter?.parameters?.type || '');
      if (filter?.type !== 'BiquadCombo') continue;
      if (/Highpass$/i.test(type)) result.hpf = { name, filter };
      if (/Lowpass$/i.test(type)) result.lpf = { name, filter };
    }
    return result;
  }
  function protectionEntry(config, channel) {
    const active = new Set((config.pipeline || []).filter(step => step?.type === 'Processor').map(step => step.name));
    return Object.entries(config.processors || {}).map(([name, processor]) => ({ name, processor })).find(item => active.has(item.name) && item.processor?.type === 'Compressor' && (item.processor.parameters?.process_channels || []).map(Number).includes(Number(channel))) || null;
  }
  function phaseEntry(config, channel) {
    const name = phaseName(channel); const filter = config.filters?.[name]; const stage = outputStage(config, channel);
    return filter?.type === 'Biquad' && filter.parameters?.type === 'AllpassFO' && stage.step.names?.includes(name) ? { name, filter } : null;
  }
  function phaseMetadata(filter) {
    const match = String(filter?.description || '').match(/\((-?\d+(?:\.\d+)?)\s*deg\s*@\s*(\d+(?:\.\d+)?)\s*Hz\)/i);
    return match ? { degrees: Number(match[1]), referenceHz: Number(match[2]) } : null;
  }
  function phaseReference(config, channel) {
    const metadata = phaseMetadata(phaseEntry(config, channel)?.filter); if (metadata?.referenceHz > 0) return metadata.referenceHz;
    const crossover = crossovers(config, channel); return Number(crossover.lpf?.filter.parameters?.freq || crossover.hpf?.filter.parameters?.freq || 1000);
  }
  function phaseDegrees(config, channel) { return phaseMetadata(phaseEntry(config, channel)?.filter)?.degrees || 0; }
  function phaseFrequency(degrees, referenceHz, sampleRate) {
    const phase = clamp(Math.abs(degrees), .01, 179.5); const fs = clamp(sampleRate || 48000, 8000, 384000); const reference = clamp(referenceHz, 1, fs / 2 - 1);
    const result = (fs / Math.PI) * Math.atan(Math.tan(Math.PI * reference / fs) / Math.max(1e-9, Math.tan(phase * Math.PI / 360)));
    return round(clamp(result, 1, fs / 2 - 1), 1);
  }
  function peqSlots(config, channel) { return PEQ_DEFAULT_FREQUENCIES.map((_, slot) => { const name = peqName(channel, slot); const filter = config.filters?.[name]; return filter?.type === 'Biquad' ? { slot, name, filter } : null; }); }
  function defaultPeq(channel, slot) { return { name: peqName(channel, slot), filter: { type: 'Biquad', description: `E-Stack PEQ ${String(slot + 1).padStart(2, '0')} · ${way(channel).name}`, parameters: { type: 'Peaking', freq: PEQ_DEFAULT_FREQUENCIES[slot], gain: 0, q: .7 } } }; }
  function normalizePeq(channel, slot, value = {}) {
    const fallback = defaultPeq(channel, slot).filter.parameters; const parameters = value.parameters || value;
    return { type: PEQ_TYPES.includes(parameters.type) ? parameters.type : fallback.type, freq: round(clamp(parameters.freq ?? parameters.frequency, 20, 20000), 1), gain: round(clamp(parameters.gain, -20, 20), 1), q: round(clamp(parameters.q, .1, 20), 2) };
  }
  function isNeutralPeq(filter) { return Math.abs(Number(filter?.parameters?.gain) || 0) < .05; }
  function isPeqActive(filter, disabled) { return !!filter && !disabled && !isNeutralPeq(filter); }
  function crossoverOwners(config, name) { return WAY_DEFINITIONS.filter(item => outputStage(config, item.channel).step.names?.includes(name)).map(item => item.channel); }
  function discover(config) {
    const active = P.activeOutputChannels(config).filter(channel => channel >= 0 && channel <= 5);
    if (fingerprint(active) !== fingerprint(WAY_DEFINITIONS.map(item => item.channel))) throw new Error('Output Processing requires exactly E-Stack channels 0 through 5; OUT7/OUT8 are excluded.');
    return WAY_DEFINITIONS.map(definition => {
      const stage = outputStage(config, definition.channel); const gain = entryForType(config, definition.channel, 'Gain'); const delay = entryForType(config, definition.channel, 'Delay'); const limiter = limiterEntry(config, definition.channel);
      if (!gain || !delay || !limiter) throw new Error(`${definition.name}: required Gain, Delay or Limiter anchor is missing.`);
      const xo = crossovers(config, definition.channel); const protection = protectionEntry(config, definition.channel);
      return { ...definition, stageIndex: stage.index, stageNames: [...stage.step.names], gain, delay, limiter, crossover: xo, protection, phase: phaseEntry(config, definition.channel), peq: peqSlots(config, definition.channel) };
    });
  }
  function projection(config, allowedFilters = [], stageIndex = null, allowedNames = []) {
    const next = clone(config); const allowed = new Set(allowedFilters); const stageAllowed = new Set(allowedNames);
    allowed.forEach(name => delete next.filters?.[name]);
    next.pipeline = (next.pipeline || []).map((step, index) => {
      if (index !== stageIndex || step?.type !== 'Filter') return step;
      const copy = clone(step); copy.names = (copy.names || []).filter(name => !stageAllowed.has(name)); return copy;
    });
    return next;
  }
  function assertScoped(before, after, { filters = [], stageIndex = null, names = [] } = {}) {
    assertReferences(after);
    if (fingerprint(projection(before, filters, stageIndex, names)) !== fingerprint(projection(after, filters, stageIndex, names))) throw new Error('Protected DSP configuration changed unexpectedly.');
  }
  function assertParamOnly(before, after, name, type, fields) {
    assertScoped(before, after, { filters: [name] }); const oldFilter = before.filters?.[name]; const nextFilter = after.filters?.[name];
    if (!oldFilter || !nextFilter || oldFilter.type !== type || nextFilter.type !== type) throw new Error(`${name}: filter type or identity changed unexpectedly.`);
    const oldRest = clone(oldFilter); const nextRest = clone(nextFilter); fields.forEach(field => { delete oldRest.parameters?.[field]; delete nextRest.parameters?.[field]; });
    if (fingerprint(oldRest) !== fingerprint(nextRest)) throw new Error(`${name}: changed outside its permitted parameters.`);
  }
  function assertGainMutation(before, after, channel) {
    const gain = entryForType(before, channel, 'Gain');
    assertParamOnly(before, after, gain.name, 'Gain', ['gain', 'mute', 'inverted']);
    const value = after.filters[gain.name].parameters.gain;
    if (value !== gain.filter.parameters.gain && value !== normalizeGain(value)) throw new Error('Output Gain must be -60…+6 dB in 0.1 dB steps.');
  }
  function assertLinkedGainMutation(before, after, channels, target) {
    const pair = channels.map(Number);
    if (fingerprint(pair) !== fingerprint([2, 3]) && fingerprint(pair) !== fingerprint([4, 5])) throw new Error('Only MID L/R and HIGH L/R may share a gain transaction.');
    const entries = pair.map(channel => entryForType(before, channel, 'Gain'));
    if (entries.some(entry => !entry)) throw new Error('Linked Gain anchor is missing.');
    const names = entries.map(entry => entry.name);
    if (new Set(names).size !== 2) throw new Error('Linked Gain anchors must be distinct.');
    assertScoped(before, after, { filters: names });
    for (const entry of entries) {
      const oldFilter = clone(entry.filter);
      const nextFilter = clone(after.filters?.[entry.name]);
      if (!nextFilter || oldFilter.type !== 'Gain' || nextFilter.type !== 'Gain') throw new Error('Linked Gain identity changed unexpectedly.');
      const actual = nextFilter.parameters?.gain;
      if (actual !== normalizeGain(target)) throw new Error('Linked Gain readback differs from the requested value.');
      delete oldFilter.parameters.gain;
      delete nextFilter.parameters.gain;
      if (fingerprint(oldFilter) !== fingerprint(nextFilter)) throw new Error('Linked Gain changed outside its permitted parameter.');
    }
  }
  function assertDelayMutation(before, after, channel) { const delay = entryForType(before, channel, 'Delay'); assertParamOnly(before, after, delay.name, 'Delay', ['delay']); }
  function protectionPair(config, channel) {
    const limiter = limiterEntry(config, channel);
    const candidates = (config.pipeline || []).filter(step => step.type === 'Processor' && !step.bypassed)
      .map(step => ({ name: step.name, processor: config.processors?.[step.name] }))
      .filter(entry => entry.processor?.type === 'Compressor' && entry.processor.parameters?.process_channels?.includes(Number(channel)));
    if (!limiter || candidates.length !== 1 || candidates[0].processor.parameters.process_channels.length !== 1)
      throw new Error('Protection requires one independent compressor and hard limiter for this way.');
    const owners = WAY_DEFINITIONS.filter(way => limiterEntry(config, way.channel)?.name === limiter.name);
    if (owners.length !== 1) throw new Error('A shared hard limiter cannot be edited per way.');
    return { limiter, compressor: candidates[0] };
  }
  function assertLimiterMutation(before, after, channel) {
    const { limiter, compressor } = protectionPair(before, channel);
    assertReferences(after);
    const clip = after.filters?.[limiter.name]?.parameters?.clip_limit;
    const threshold = after.processors?.[compressor.name]?.parameters?.threshold;
    if (!Number.isFinite(clip) || clip < -60 || clip > 0 || Math.abs(threshold - (clip - 1)) > 1e-6)
      throw new Error('Compressor threshold must be exactly 1 dB below the hard limiter.');
    const restored = clone(after);
    restored.filters[limiter.name].parameters.clip_limit = limiter.filter.parameters.clip_limit;
    restored.processors[compressor.name].parameters.threshold = compressor.processor.parameters.threshold;
    if (fingerprint(before) !== fingerprint(restored)) throw new Error('Protected DSP configuration changed unexpectedly.');
  }
  function assertCrossoverMutation(before, after, channel, edge) {
    const entry = crossovers(before, channel)[edge]; if (!entry) throw new Error(`${way(channel).name}: ${edge.toUpperCase()} crossover is unavailable.`);
    assertParamOnly(before, after, entry.name, 'BiquadCombo', ['type', 'freq', 'order']);
    if (fingerprint(crossoverOwners(before, entry.name)) !== fingerprint(crossoverOwners(after, entry.name))) throw new Error(`${entry.name}: shared crossover references changed unexpectedly.`);
  }
  function assertPhaseMutation(before, after, channel) {
    const stage = outputStage(before, channel); const name = phaseName(channel); assertScoped(before, after, { filters: [name], stageIndex: stage.index, names: [name] });
    const matches = (after.pipeline || []).filter(step => step?.type === 'Filter' && step.names?.includes(name)); if (matches.length > 1 || (matches.length === 1 && matches[0] !== after.pipeline[stage.index])) throw new Error(`${name}: phase reference moved outside its output stage.`);
  }
  function assertPeqMutation(before, after, channel) {
    const stage = outputStage(before, channel); const names = peqNames(channel); assertScoped(before, after, { filters: names, stageIndex: stage.index, names });
    const outputNames = after.pipeline[stage.index]?.names || []; const gainIndex = outputNames.findIndex(name => after.filters?.[name]?.type === 'Gain'); const phaseIndex = outputNames.indexOf(phaseName(channel));
    const active = names.filter(name => outputNames.includes(name)); if (active.some(name => outputNames.indexOf(name) >= gainIndex || (phaseIndex >= 0 && outputNames.indexOf(name) >= phaseIndex))) throw new Error(`${way(channel).name}: PEQ must remain before phase trim and Gain.`);
    if (fingerprint(active) !== fingerprint([...active].sort())) throw new Error(`${way(channel).name}: PEQ order must follow stable slot order.`);
  }
  function crossoverMagnitude(filter, frequency) {
    if (!filter?.parameters) return 0; const type = String(filter.parameters.type || ''); const order = Math.max(1, Number(filter.parameters.order) || 1); const ratio = Math.max(.00001, Number(frequency) / Math.max(1, Number(filter.parameters.freq) || 1000));
    const high = /Highpass$/i.test(type); const lr = /^LinkwitzRiley/i.test(type); const amplitude = lr ? (high ? Math.pow(ratio, order) / (1 + Math.pow(ratio, order)) : 1 / (1 + Math.pow(ratio, order))) : (high ? Math.pow(ratio, order) / Math.sqrt(1 + Math.pow(ratio, order * 2)) : 1 / Math.sqrt(1 + Math.pow(ratio, order * 2)));
    return 20 * Math.log10(Math.max(1e-12, amplitude));
  }
  function peqMagnitude(filter, frequency, sampleRate) {
    if (!filter || isNeutralPeq(filter)) return 0; const p = normalizePeq(0, 0, filter.parameters); const fs = clamp(sampleRate || 48000, 8000, 384000); const omega = 2 * Math.PI * p.freq / fs; const cosine = Math.cos(omega); const sine = Math.sin(omega); const A = Math.pow(10, p.gain / 40); const alpha = sine / (2 * p.q); const beta = 2 * Math.sqrt(A) * alpha;
    let b0; let b1; let b2; let a0; let a1; let a2;
    if (p.type === 'Lowshelf') { b0 = A * ((A + 1) - (A - 1) * cosine + beta); b1 = 2 * A * ((A - 1) - (A + 1) * cosine); b2 = A * ((A + 1) - (A - 1) * cosine - beta); a0 = (A + 1) + (A - 1) * cosine + beta; a1 = -2 * ((A - 1) + (A + 1) * cosine); a2 = (A + 1) + (A - 1) * cosine - beta; }
    else if (p.type === 'Highshelf') { b0 = A * ((A + 1) + (A - 1) * cosine + beta); b1 = -2 * A * ((A - 1) + (A + 1) * cosine); b2 = A * ((A + 1) + (A - 1) * cosine - beta); a0 = (A + 1) - (A - 1) * cosine + beta; a1 = 2 * ((A - 1) - (A + 1) * cosine); a2 = (A + 1) - (A - 1) * cosine - beta; }
    else { b0 = 1 + alpha * A; b1 = -2 * cosine; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cosine; a2 = 1 - alpha / A; }
    const f = 2 * Math.PI * clamp(frequency, 1, fs / 2 - 1) / fs; const z1r = Math.cos(f); const z1i = -Math.sin(f); const z2r = Math.cos(2 * f); const z2i = -Math.sin(2 * f);
    const nr = b0 / a0 + b1 / a0 * z1r + b2 / a0 * z2r; const ni = b1 / a0 * z1i + b2 / a0 * z2i; const dr = 1 + a1 / a0 * z1r + a2 / a0 * z2r; const di = a1 / a0 * z1i + a2 / a0 * z2i;
    return 20 * Math.log10(Math.max(1e-12, Math.hypot(nr, ni) / Math.hypot(dr, di)));
  }
  function magnitudeResponse(config, channel, frequency, disabledSlots = []) {
    const data = discover(config).find(item => item.channel === Number(channel)); if (!data) return 0; const disabled = new Set(disabledSlots.map(Number));
    const xo = Object.values(data.crossover).reduce((sum, item) => sum + crossoverMagnitude(item?.filter, frequency), 0); const peq = data.peq.reduce((sum, item) => sum + (!item || disabled.has(item.slot) ? 0 : peqMagnitude(item.filter, frequency, config.devices?.samplerate)), 0);
    return xo + peq + Number(data.gain.filter.parameters?.gain || 0);
  }
  window.EStackOutputProcessingModel = Object.freeze({ GAIN_RANGE, normalizeGain, WAY_DEFINITIONS, PEQ_DEFAULT_FREQUENCIES, PEQ_TYPES, clone, clamp, round, fingerprint, way, phaseName, peqName, peqNames, validateReferences, assertReferences, outputStage, entryForType, limiterEntry, crossovers, protectionEntry, protectionPair, phaseEntry, phaseMetadata, phaseReference, phaseDegrees, phaseFrequency, peqSlots, defaultPeq, normalizePeq, isNeutralPeq, isPeqActive, crossoverOwners, discover, assertGainMutation, assertLinkedGainMutation, assertDelayMutation, assertLimiterMutation, assertCrossoverMutation, assertPhaseMutation, assertPeqMutation, magnitudeResponse });
})();
