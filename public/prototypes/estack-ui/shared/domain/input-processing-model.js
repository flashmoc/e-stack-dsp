(() => {
  'use strict';

  const GLOBAL_EQ_DEFAULT_FREQUENCIES = Object.freeze([31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);
  const GLOBAL_EQ_SLOT_NAMES = Object.freeze(GLOBAL_EQ_DEFAULT_FREQUENCIES.map((_, index) => `GLOBAL_EQ_${String(index + 1).padStart(2, '0')}`));
  const GLOBAL_EQ_STEP_DESCRIPTION = 'E-Stack global input EQ';
  const INPUT_DELAY_FILTER = 'ESTACK_INPUT_DELAY';
  const INPUT_DELAY_STEP_DESCRIPTION = 'E-Stack input delay';
  const EQ_TYPES = Object.freeze(['Peaking', 'Lowshelf', 'Highshelf']);
  const clamp = (value, minimum, maximum) => {
    const numeric = Number(value);
    return Math.min(maximum, Math.max(minimum, Number.isFinite(numeric) ? numeric : minimum));
  };
  const clone = value => JSON.parse(JSON.stringify(value));

  function slotIndex(slot) {
    if (typeof slot === 'number') return Math.max(0, Math.min(GLOBAL_EQ_SLOT_NAMES.length - 1, Math.round(slot)));
    const index = GLOBAL_EQ_SLOT_NAMES.indexOf(String(slot));
    if (index < 0) throw new Error(`Unknown Global EQ slot '${slot}'.`);
    return index;
  }
  function slotName(slot) { return GLOBAL_EQ_SLOT_NAMES[slotIndex(slot)]; }
  function defaultBand(slot) {
    const index = slotIndex(slot);
    return { slot: GLOBAL_EQ_SLOT_NAMES[index], type: 'Peaking', frequency: GLOBAL_EQ_DEFAULT_FREQUENCIES[index], gain: 0, q: .7, present: false };
  }
  function normalizeBand(slot, value = {}) {
    const fallback = defaultBand(slot); const parameters = value.parameters || value;
    const type = EQ_TYPES.includes(parameters.type) ? parameters.type : fallback.type;
    return {
      slot: fallback.slot,
      type,
      frequency: clamp(parameters.frequency ?? parameters.freq ?? fallback.frequency, 20, 20000),
      gain: clamp(parameters.gain ?? fallback.gain, -12, 12),
      q: clamp(parameters.q ?? fallback.q, .1, 20),
      present: value.present === true
    };
  }
  function filterForBand(band) {
    const next = normalizeBand(band.slot, band); const parameters = { type: next.type, freq: next.frequency, gain: next.gain, q: next.q };
    return { type: 'Biquad', description: `E-Stack Global EQ ${next.slot.slice(-2)}`, parameters };
  }
  function isNeutral(band) { return Math.abs(Number(band?.gain) || 0) < .05; }
  function isDefaultBand(band) {
    const normalized = normalizeBand(band.slot, band); const fallback = defaultBand(normalized.slot);
    return normalized.type === fallback.type && normalized.frequency === fallback.frequency && normalized.gain === fallback.gain && normalized.q === fallback.q;
  }
  function bandsFromConfig(config) {
    return GLOBAL_EQ_SLOT_NAMES.map((name, index) => {
      const filter = config?.filters?.[name];
      return normalizeBand(index, { ...(filter?.parameters || {}), present: !!filter });
    });
  }
  function sampleRateForConfig(config) { return clamp(config?.devices?.samplerate || 48000, 8000, 384000); }
  function delayFromConfig(config) {
    const filter = config?.filters?.[INPUT_DELAY_FILTER];
    if (!filter || filter.type !== 'Delay') return 0;
    return clamp(filter.parameters?.delay || 0, 0, 2000);
  }
  function normalizeDelay(value) { return Math.round(clamp(value, 0, 2000) * 10) / 10; }

  // RBJ Audio EQ Cookbook, evaluated on the unit circle.  This is deliberately
  // pure presentation math: CamillaDSP remains the processing authority.
  function rbjCoefficients(band, sampleRate) {
    const b = band; const rate = sampleRateForConfig({ devices: { samplerate: sampleRate } });
    const omega = 2 * Math.PI * b.frequency / rate; const cos = Math.cos(omega); const sin = Math.sin(omega);
    const A = Math.pow(10, b.gain / 40); const alpha = sin / (2 * b.q); const beta = 2 * Math.sqrt(A) * alpha;
    let b0; let b1; let b2; let a0; let a1; let a2;
    if (b.type === 'Lowshelf') {
      b0 = A * ((A + 1) - (A - 1) * cos + beta); b1 = 2 * A * ((A - 1) - (A + 1) * cos); b2 = A * ((A + 1) - (A - 1) * cos - beta);
      a0 = (A + 1) + (A - 1) * cos + beta; a1 = -2 * ((A - 1) + (A + 1) * cos); a2 = (A + 1) + (A - 1) * cos - beta;
    } else if (b.type === 'Highshelf') {
      b0 = A * ((A + 1) + (A - 1) * cos + beta); b1 = -2 * A * ((A - 1) + (A + 1) * cos); b2 = A * ((A + 1) + (A - 1) * cos - beta);
      a0 = (A + 1) - (A - 1) * cos + beta; a1 = 2 * ((A - 1) - (A + 1) * cos); a2 = (A + 1) - (A - 1) * cos - beta;
    } else {
      b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
    }
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }
  function responseAt(band, frequency, sampleRate) {
    if (isNeutral(band)) return 0;
    return rawResponseAt(normalizeBand(band.slot, band), frequency, sampleRate);
  }
  function rawResponseAt(band, frequency, sampleRate) {
    if (band.gain === 0) return 0;
    const c = rbjCoefficients(band, sampleRate); const omega = 2 * Math.PI * clamp(frequency, 1, sampleRate / 2 - 1) / sampleRate;
    const z1r = Math.cos(omega); const z1i = -Math.sin(omega); const z2r = Math.cos(2 * omega); const z2i = -Math.sin(2 * omega);
    const nr = c.b0 + c.b1 * z1r + c.b2 * z2r; const ni = c.b1 * z1i + c.b2 * z2i;
    const dr = 1 + c.a1 * z1r + c.a2 * z2r; const di = c.a1 * z1i + c.a2 * z2i;
    return 20 * Math.log10(Math.max(1e-12, Math.hypot(nr, ni) / Math.hypot(dr, di)));
  }
  function totalResponse(bands, frequency, sampleRate, disabledSlots = []) {
    const disabled = new Set(disabledSlots);
    return (bands || []).reduce((sum, band) => disabled.has(band.slot) || isNeutral(band) ? sum : sum + responseAt(band, frequency, sampleRate), 0);
  }
  function configWithoutPipelineSteps(config, descriptions) {
    const copy = clone(config); const removable = new Set(descriptions);
    copy.pipeline = (copy.pipeline || []).filter(step => !removable.has(step?.description));
    return copy;
  }
  function configWithoutNamedFilters(config, names) {
    const copy = clone(config); names.forEach(name => delete copy.filters?.[name]); return copy;
  }
  function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') return Object.keys(value).sort().reduce((result, key) => { result[key] = canonicalize(value[key]); return result; }, {});
    return value;
  }
  function assertEqual(value, expected, label) { if (JSON.stringify(canonicalize(value)) !== JSON.stringify(canonicalize(expected))) throw new Error(`${label} changed unexpectedly.`); }
  function assertEqMutation(before, after) {
    const allowed = GLOBAL_EQ_SLOT_NAMES;
    assertEqual(configWithoutPipelineSteps(configWithoutNamedFilters(before, allowed), [GLOBAL_EQ_STEP_DESCRIPTION]), configWithoutPipelineSteps(configWithoutNamedFilters(after, allowed), [GLOBAL_EQ_STEP_DESCRIPTION]), 'Protected DSP configuration');
    const globalSteps = (after.pipeline || []).filter(step => step?.description === GLOBAL_EQ_STEP_DESCRIPTION);
    if (globalSteps.length > 1) throw new Error('More than one dedicated Global EQ step exists.');
    if (globalSteps.length) {
      const mixer = window.EStackPipeline.firstMixerContext(after);
      if (!mixer || after.pipeline.indexOf(globalSteps[0]) >= mixer.index) throw new Error('Global EQ must be before the first mixer.');
      if (JSON.stringify(window.EStackPipeline.channelsForStep(globalSteps[0])) !== JSON.stringify([0, 1])) throw new Error('Global EQ must target capture channels 0 and 1.');
      if ((globalSteps[0].names || []).some(name => !allowed.includes(name))) throw new Error('Global EQ step contains an unrelated filter.');
    }
  }
  function assertDelayMutation(before, after) {
    const allowed = [INPUT_DELAY_FILTER];
    assertEqual(configWithoutPipelineSteps(configWithoutNamedFilters(before, allowed), [INPUT_DELAY_STEP_DESCRIPTION]), configWithoutPipelineSteps(configWithoutNamedFilters(after, allowed), [INPUT_DELAY_STEP_DESCRIPTION]), 'Protected DSP configuration');
    const steps = (after.pipeline || []).filter(step => step?.description === INPUT_DELAY_STEP_DESCRIPTION);
    if (steps.length > 1) throw new Error('More than one dedicated input delay step exists.');
    if (steps.length) {
      const mixer = window.EStackPipeline.firstMixerContext(after);
      if (!mixer || after.pipeline.indexOf(steps[0]) >= mixer.index) throw new Error('Input delay must be before the first mixer.');
      if (JSON.stringify(window.EStackPipeline.channelsForStep(steps[0])) !== JSON.stringify([0, 1]) || JSON.stringify(steps[0].names) !== JSON.stringify([INPUT_DELAY_FILTER])) throw new Error('Input delay step scope is invalid.');
    }
  }
  const api = Object.freeze({ GLOBAL_EQ_DEFAULT_FREQUENCIES, GLOBAL_EQ_SLOT_NAMES, GLOBAL_EQ_STEP_DESCRIPTION, INPUT_DELAY_FILTER, INPUT_DELAY_STEP_DESCRIPTION, EQ_TYPES, clamp, clone, slotIndex, slotName, defaultBand, normalizeBand, filterForBand, isNeutral, isDefaultBand, bandsFromConfig, sampleRateForConfig, delayFromConfig, normalizeDelay, rbjCoefficients, responseAt, rawResponseAt, totalResponse, assertEqMutation, assertDelayMutation });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.EStackInputProcessingModel = api;
})();
