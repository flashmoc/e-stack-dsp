"use strict";
const crypto = require("crypto");
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
const revision = config => crypto.createHash("sha256").update(JSON.stringify(stable(config))).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));
const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
const protectedName = name => /^(GLOBAL_EQ_|ESTACK_|USER_CH)|loudness|protection|hard_limit|[hl]pf|crossover/i.test(name);
const filterTypes = ["Gain", "Volume", "Loudness", "Delay", "Conv", "Biquad", "BiquadCombo", "Dither", "Limiter", "DiffEq"];

function finiteTree(value) {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Use finite numbers");
  if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Invalid parameter key");
    finiteTree(child);
  }
}
function apply(config, operation) {
  finiteTree(operation);
  const { kind, name } = operation || {};
  if (kind === "protection") {
    const channel = operation.channel, clip = operation.clip;
    if (!Number.isInteger(channel) || channel < 0 || channel > 5 || !Number.isFinite(clip) || clip < -60 || clip > 0) throw new Error("Invalid output protection threshold");
    const mixerIndex = config.pipeline.findIndex(s => s.type === 'Mixer');
    if (mixerIndex < 0) throw new Error('Output mixer is missing');
    const stages = config.pipeline.slice(mixerIndex + 1).filter(s => s.type === 'Filter' && !s.bypassed && (s.channels || [s.channel]).includes(channel));
    const names = [...new Set(stages.flatMap(s => s.names).filter(n => config.filters[n]?.type === 'Limiter'))];
    if (names.length !== 1) throw new Error('Expected one independent hard limiter');
    const limiter = names[0];
    if (config.pipeline.some(s => s.type === 'Filter' && s.names?.includes(limiter) && (s.channels || [s.channel]).some(c => c !== channel))) throw new Error('Hard limiter is shared');
    const processors = config.pipeline.slice(mixerIndex + 1).filter(s => s.type === 'Processor' && !s.bypassed).map(s => config.processors?.[s.name]).filter(p => p?.type === 'Compressor' && p.parameters.process_channels?.includes(channel));
    if (processors.length !== 1 || processors[0].parameters.process_channels.length !== 1) throw new Error('Expected one independent protection compressor');
    config.filters[limiter].parameters.clip_limit = clip;
    processors[0].parameters.threshold = Number((clip - 1).toFixed(6));
  } else if (kind === "filter") {
    if (!own(config.filters, name)) throw new Error("Filter no longer exists");
    const old = config.filters[name], next = operation.value;
    if (!next || !filterTypes.includes(next.type) || !next.parameters || typeof next.parameters !== 'object' || Array.isArray(next.parameters)) throw new Error("Unsupported filter definition");
    if (protectedName(name) && next.type !== old.type) throw new Error("System anchor type must remain unchanged");
    config.filters[name] = { ...old, type: next.type, parameters: clone(next.parameters) };
    if (old.type === "Limiter") {
      if (next.type !== "Limiter") throw new Error("Keep the hard limiter in place");
      const clip = next.parameters.clip_limit;
      if (!Number.isFinite(clip) || clip < -60 || clip > 0) throw new Error("Hard limiter must be −60…0 dBFS");
      const stages = config.pipeline.filter(s => s.type === "Filter" && s.names?.includes(name));
      const channels = [...new Set(stages.flatMap(s => s.channels || [s.channel]))];
      if (channels.length !== 1) throw new Error('Select an independent output hard limiter');
      apply(config, { kind: 'protection', channel: channels[0], clip });
    }
  } else if (kind === "processor") {
    const old = config.processors?.[name];
    if (!old || !operation.value?.parameters) throw new Error("Processor no longer exists");
    const next = operation.value;
    if (next.type !== old.type) throw new Error("Processor type must remain unchanged");
    for (const key of ["channels", "process_channels", "monitor_channels"]) {
      if (JSON.stringify(next.parameters[key]) !== JSON.stringify(old.parameters[key])) throw new Error("Processor channel ownership must remain unchanged");
    }
    const isProtection = /protection/i.test(name) || (old.type === 'Compressor' && config.pipeline.some(s => s.type === 'Filter' && (s.channels || [s.channel]).some(c => old.parameters.process_channels?.includes(c)) && s.names?.some(n => config.filters[n]?.type === 'Limiter')));
    if (isProtection && next.parameters.threshold !== old.parameters.threshold) throw new Error("Set the Hard Limiter to adjust the protection threshold");
    config.processors[name] = { ...old, parameters: clone(next.parameters) };
  } else if (kind === "mixer") {
    const mixer = config.mixers?.[name];
    const mapping = mixer?.mapping?.[operation.mapping];
    const source = mapping?.sources?.[operation.source];
    if (!source) throw new Error("Mixer source no longer exists");
    const value = operation.value;
    if (!Number.isFinite(value.gain) || value.gain < -100 || value.gain > 24 || typeof value.mute !== "boolean" || typeof value.inverted !== "boolean") throw new Error("Invalid mixer gain, mute or polarity");
    if (!Number.isInteger(value.channel) || value.channel < 0 || value.channel >= mixer.channels.in) throw new Error("Source channel outside mixer input range");
    Object.assign(source, { gain: value.gain, mute: value.mute, inverted: value.inverted, channel: value.channel });
  } else if (kind === "insertFilter") {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_ -]{0,79}$/.test(name) || protectedName(name) || own(config.filters, name)) throw new Error("Choose a unique non-system filter name");
    const stage = config.pipeline[operation.stage];
    if (stage?.type !== "Filter" || stage.bypassed) throw new Error("Select an enabled filter stage");
    config.filters[name] = { type: "Biquad", parameters: { type: "Peaking", freq: 1000, gain: 0, q: 1 } };
    // Insert before existing processing, never after the final safety limiter.
    stage.names.unshift(name);
  } else if (kind === "removeFilter") {
    if (!own(config.filters, name)) throw new Error("Filter no longer exists");
    if (protectedName(name) || ["Gain", "Delay", "Limiter", "BiquadCombo"].includes(config.filters[name].type)) throw new Error("System anchors cannot be deleted");
    for (const stage of config.pipeline) if (stage.type === "Filter") stage.names = stage.names.filter(n => n !== name);
    delete config.filters[name];
  } else throw new Error("Unknown Advanced operation");
  return config;
}
module.exports = { apply, revision, protectedName };
