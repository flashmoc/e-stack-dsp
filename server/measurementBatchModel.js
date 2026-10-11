'use strict';

const inputEqState = require('../public/prototypes/estack-ui/shared/domain/input-eq-state');
const inputModel = require('../public/prototypes/estack-ui/shared/domain/input-processing-model');

const WAY_DEFS = Object.freeze({
    SUB: Object.freeze({ key: 'SUB', channel: 0, label: 'SUB', out: 1 }),
    KICK: Object.freeze({ key: 'KICK', channel: 1, label: 'KICK', out: 2 }),
    MID_L: Object.freeze({ key: 'MID_L', channel: 2, label: 'MID L', out: 3 }),
    MID_R: Object.freeze({ key: 'MID_R', channel: 3, label: 'MID R', out: 4 }),
    HIGH_L: Object.freeze({ key: 'HIGH_L', channel: 4, label: 'HIGH L', out: 5 }),
    HIGH_R: Object.freeze({ key: 'HIGH_R', channel: 5, label: 'HIGH R', out: 6 })
});

const WAY_ALIASES = Object.freeze({
    SUB: 'SUB', SUBWOOFER: 'SUB',
    KICK: 'KICK',
    MIDL: 'MID_L', MIDLEFT: 'MID_L', MID_L: 'MID_L',
    MIDR: 'MID_R', MIDRIGHT: 'MID_R', MID_R: 'MID_R',
    HIGHL: 'HIGH_L', HIGHLEFT: 'HIGH_L', HIGH_L: 'HIGH_L',
    HIGHR: 'HIGH_R', HIGHRIGHT: 'HIGH_R', HIGH_R: 'HIGH_R'
});

const CROSSOVER_FAMILIES = new Set(['LinkwitzRiley', 'Butterworth']);
const PHASE_REFERENCES = new Set(['auto', 'hpf', 'lpf']);
const PHASE_PREFIX = 'ESTACK_PHASE_';
const MAX_PEQ_SLOTS = 10;
const MAX_STEPS = 500;
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
        const result = {};
        for (const key of Object.keys(value).sort()) result[key] = stable(value[key]);
        return result;
    }
    return value;
}

function boundedNumber(value, min, max, label) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < min || number > max) {
        throw new Error(`${label} must be between ${min} and ${max}`);
    }
    return number;
}

function text(value, max, label, fallback = '') {
    const result = String(value ?? fallback).trim();
    if (result.length > max) throw new Error(`${label} is too long`);
    return result;
}

function assertKnownKeys(value, allowed, label) {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label}.${key} is not supported`);
}

function normalizeWayKey(value) {
    const raw = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
    const key = WAY_ALIASES[raw] || WAY_ALIASES[raw.replace(/_/g, '')];
    if (!key) throw new Error(`Unknown E-Stack way '${value}'`);
    return key;
}

function normalizeWayList(value, label) {
    if (!Array.isArray(value) || !value.length) throw new Error(`${label} must contain at least one way`);
    return [...new Set(value.map(normalizeWayKey))];
}

function normalizeDisabledFilters(value, label) {
    if (value == null) return [];
    if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
    const result = [];
    for (const item of value) {
        const name = String(item || '').trim();
        if (!name || name.length > 160) throw new Error(`${label} contains an invalid filter name`);
        if (!result.includes(name)) result.push(name);
    }
    return result;
}

function normalizePhase(value, label) {
    const raw = typeof value === 'number' ? { degrees: value } : value;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`${label}.phase must be a degree value or object`);
    }
    if (raw.degrees == null) throw new Error(`${label}.phase.degrees is required`);
    const result = {
        degrees: boundedNumber(raw.degrees, -179, 0, `${label}.phase.degrees`)
    };
    if (raw.reference != null && raw.referenceHz != null) {
        throw new Error(`${label}.phase cannot define both reference and referenceHz`);
    }
    if (raw.referenceHz != null) {
        result.referenceHz = boundedNumber(raw.referenceHz, 5, 24000, `${label}.phase.referenceHz`);
    } else {
        const reference = String(raw.reference ?? 'auto').trim().toLowerCase();
        if (!PHASE_REFERENCES.has(reference)) {
            throw new Error(`${label}.phase.reference must be auto, hpf or lpf`);
        }
        result.reference = reference;
    }
    return result;
}

function normalizePeq(value, label, version) {
    if (!Array.isArray(value) || !value.length || value.length > MAX_PEQ_SLOTS) {
        throw new Error(`${label}.peq must contain 1..${MAX_PEQ_SLOTS} filters`);
    }
    const slots = new Set();
    return value.map((raw, index) => {
        const name = `${label}.peq[${index}]`;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${name} must be an object`);
        for (const key of ['slot', 'freqHz', 'q', 'gainDb']) {
            if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) {
                throw new Error(`${name}.${key} must be a finite number`);
            }
        }
        const slot = boundedNumber(raw.slot, 1, MAX_PEQ_SLOTS, `${name}.slot`);
        if (!Number.isInteger(slot) || slots.has(slot)) throw new Error(`${name}.slot must be a unique integer`);
        slots.add(slot);
        const type = raw.type == null ? 'Peaking' : String(raw.type);
        if (version < 3 && raw.type != null) throw new Error(`${name}.type requires batch version 3`);
        if (!inputModel.EQ_TYPES.includes(type)) throw new Error(`${name}.type must be Peaking, Lowshelf or Highshelf`);
        if (version < 3 && raw.enabled != null) throw new Error(`${name}.enabled requires batch version 3`);
        if (raw.enabled != null && typeof raw.enabled !== 'boolean') throw new Error(`${name}.enabled must be a boolean`);
        return {
            slot,
            freqHz: boundedNumber(raw.freqHz, 20, 20000, `${name}.freqHz`),
            q: boundedNumber(raw.q, version >= 3 ? 0.1 : 0.3, version >= 3 ? 20 : 12, `${name}.q`),
            gainDb: boundedNumber(raw.gainDb, version >= 3 ? -12 : -18, version >= 3 ? 12 : 0, `${name}.gainDb`),
            ...(version >= 3 ? { type, enabled: raw.enabled !== false } : {})
        };
    });
}

function normalizeWayOverride(value, label, version) {
    if (value == null) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
    if (version >= 3) assertKnownKeys(value, ['delayMs', 'delayOffsetMs', 'gainOffsetDb', 'gainDb', 'polarity', 'phase', 'peq'], label);
    if (value.delayMs != null && value.delayOffsetMs != null) throw new Error(`${label} cannot define both delayMs and delayOffsetMs`);
    const result = {};
    if (value.delayMs != null) result.delayMs = boundedNumber(value.delayMs, 0, 100, `${label}.delayMs`);
    if (value.delayOffsetMs != null) result.delayOffsetMs = boundedNumber(value.delayOffsetMs, -50, 50, `${label}.delayOffsetMs`);
    // Measurement batches may attenuate a way but never raise it above the captured baseline.
    if (value.gainOffsetDb != null) result.gainOffsetDb = boundedNumber(value.gainOffsetDb, -60, 0, `${label}.gainOffsetDb`);
    if (value.gainDb != null) {
        if (version < 3) throw new Error(`${label}.gainDb requires batch version 3`);
        result.gainDb = boundedNumber(value.gainDb, -60, 6, `${label}.gainDb`);
    }
    if (result.gainDb != null && result.gainOffsetDb != null) throw new Error(`${label} cannot define both gainDb and gainOffsetDb`);
    if (value.polarity != null) {
        const polarity = String(value.polarity).trim().toLowerCase();
        if (!['normal', 'inverted'].includes(polarity)) throw new Error(`${label}.polarity must be normal or inverted`);
        result.polarity = polarity;
    }
    if (value.phase != null) result.phase = normalizePhase(value.phase, label);
    if (value.peq != null) result.peq = normalizePeq(value.peq, label, version);
    return result;
}

function normalizeInputEq(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
    for (const key of Object.keys(value)) if (!['geq', 'peq'].includes(key)) throw new Error(`${label}.${key} is not an input EQ setting`);
    const result = {};
    if (value.geq != null) {
        const geq = value.geq;
        if (!geq || typeof geq !== 'object' || Array.isArray(geq)) throw new Error(`${label}.geq must be an object`);
        for (const key of Object.keys(geq)) if (!['enabled', 'targets'].includes(key)) throw new Error(`${label}.geq.${key} is not supported`);
        result.geq = {};
        if (geq.enabled != null) {
            if (typeof geq.enabled !== 'boolean') throw new Error(`${label}.geq.enabled must be a boolean`);
            result.geq.enabled = geq.enabled;
        }
        if (geq.targets != null) result.geq.targets = require('../public/prototypes/estack-ui/shared/domain/graphic-eq-fit').targets(geq.targets);
        if (!Object.keys(result.geq).length) throw new Error(`${label}.geq has no settings`);
    }
    if (value.peq != null) {
        const peq = value.peq;
        if (!peq || typeof peq !== 'object' || Array.isArray(peq)) throw new Error(`${label}.peq must be an object`);
        for (const key of Object.keys(peq)) if (!['enabled', 'bands'].includes(key)) throw new Error(`${label}.peq.${key} is not supported`);
        result.peq = {};
        if (peq.enabled != null) {
            if (typeof peq.enabled !== 'boolean') throw new Error(`${label}.peq.enabled must be a boolean`);
            result.peq.enabled = peq.enabled;
        }
        if (peq.bands != null) {
            if (!Array.isArray(peq.bands) || !peq.bands.length || peq.bands.length > 10) throw new Error(`${label}.peq.bands must contain 1..10 bands`);
            const slots = new Set();
            result.peq.bands = peq.bands.map((raw, index) => {
                const name = `${label}.peq.bands[${index}]`;
                if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${name} must be an object`);
                for (const key of Object.keys(raw)) if (!['slot', 'type', 'freqHz', 'q', 'gainDb', 'enabled'].includes(key)) throw new Error(`${name}.${key} is not supported`);
                if (!Number.isInteger(raw.slot) || raw.slot < 1 || raw.slot > 10 || slots.has(raw.slot)) throw new Error(`${name}.slot must be a unique integer from 1 to 10`);
                slots.add(raw.slot);
                const type = raw.type == null ? 'Peaking' : String(raw.type);
                if (!inputModel.EQ_TYPES.includes(type)) throw new Error(`${name}.type must be Peaking, Lowshelf or Highshelf`);
                if (raw.enabled != null && typeof raw.enabled !== 'boolean') throw new Error(`${name}.enabled must be a boolean`);
                for (const key of ['freqHz', 'q', 'gainDb']) if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) throw new Error(`${name}.${key} must be a finite number`);
                return { slot: raw.slot, type,
                    freqHz: boundedNumber(raw.freqHz, 20, 20000, `${name}.freqHz`),
                    q: boundedNumber(raw.q, 0.1, 20, `${name}.q`),
                    gainDb: boundedNumber(raw.gainDb, -12, 12, `${name}.gainDb`),
                    enabled: raw.enabled !== false };
            });
        }
        if (!Object.keys(result.peq).length) throw new Error(`${label}.peq has no settings`);
    }
    if (!Object.keys(result).length) throw new Error(`${label} has no settings`);
    return result;
}

function normalizeCrossoverSide(value, side, label) {
    if (value == null) return null;
    const raw = typeof value === 'number' ? { freqHz: value } : value;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${label}.${side} must be a number or object`);
    const result = {};
    const freq = raw.freqHz ?? raw.freq;
    if (freq != null) result.freqHz = boundedNumber(freq, 10, 24000, `${label}.${side}.freqHz`);
    if (raw.family != null) {
        const family = String(raw.family).trim();
        if (!CROSSOVER_FAMILIES.has(family)) throw new Error(`${label}.${side}.family must be LinkwitzRiley or Butterworth`);
        result.family = family;
    }
    if (raw.order != null) {
        const order = boundedNumber(raw.order, 2, 8, `${label}.${side}.order`);
        if (!Number.isInteger(order)) throw new Error(`${label}.${side}.order must be an integer`);
        if (result.family === 'LinkwitzRiley' && order % 2) throw new Error(`${label}.${side}.order must be even for LinkwitzRiley`);
        result.order = order;
    }
    if (!Object.keys(result).length) throw new Error(`${label}.${side} has no crossover parameters`);
    return result;
}

function normalizeCrossoverOverride(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
    const result = {};
    const hpf = value.hpf ?? (value.hpfHz != null ? { freqHz: value.hpfHz } : null);
    const lpf = value.lpf ?? (value.lpfHz != null ? { freqHz: value.lpfHz } : null);
    if (hpf != null) result.hpf = normalizeCrossoverSide(hpf, 'hpf', label);
    if (lpf != null) result.lpf = normalizeCrossoverSide(lpf, 'lpf', label);
    if (!Object.keys(result).length) throw new Error(`${label} has no hpf/lpf override`);
    return result;
}

function normalizeRew(value, id, name) {
    const raw = value == null ? {} : value;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Step ${id} rew must be an object`);
    const result = {
        measurementName: text(raw.measurementName, 120, `Step ${id} rew.measurementName`, `${id}_${name}`.replace(/\s+/g, '_')) || id
    };
    const hasStart = raw.startHz != null;
    const hasEnd = raw.endHz != null;
    if (hasStart !== hasEnd) throw new Error(`Step ${id} rew.startHz and rew.endHz must be provided together`);
    if (hasStart) {
        result.startHz = boundedNumber(raw.startHz, 5, 24000, `Step ${id} rew.startHz`);
        result.endHz = boundedNumber(raw.endHz, 5, 24000, `Step ${id} rew.endHz`);
        if (result.endHz <= result.startHz) throw new Error(`Step ${id} rew.endHz must be above rew.startHz`);
    }
    if (raw.levelDbfs != null) result.levelDbfs = boundedNumber(raw.levelDbfs, -80, 0, `Step ${id} rew.levelDbfs`);
    if (raw.timingReference != null) result.timingReference = !!raw.timingReference;
    if (raw.notes != null) result.notes = text(raw.notes, 800, `Step ${id} rew.notes`);
    return result;
}

function normalizeBatch(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Measurement batch must be a JSON object');
    const version = Number(input.version ?? 1);
    if (![1, 2, 3].includes(version)) throw new Error(`Unsupported measurement batch version '${input.version}'`);
    if (version >= 3) assertKnownKeys(input, ['schema', 'version', 'name', 'description', 'defaults', 'steps'], 'batch');
    const name = text(input.name, 120, 'Batch name');
    if (!name) throw new Error('Batch name is required');
    const description = text(input.description, 1200, 'Batch description');
    if (!Array.isArray(input.steps) || !input.steps.length) throw new Error('Batch must contain at least one measurement step');
    if (input.steps.length > MAX_STEPS) throw new Error(`Batch cannot exceed ${MAX_STEPS} steps`);

    const rawDefaults = input.defaults && typeof input.defaults === 'object' && !Array.isArray(input.defaults) ? input.defaults : {};
    if (version >= 3) assertKnownKeys(rawDefaults, ['muteUnlisted', 'settleMs', 'disabledFilters', 'processingMode', 'measurementInput'], 'defaults');
    const defaults = {
        muteUnlisted: rawDefaults.muteUnlisted !== false,
        settleMs: rawDefaults.settleMs == null ? 500 : Math.round(boundedNumber(rawDefaults.settleMs, 0, 5000, 'defaults.settleMs')),
        disabledFilters: normalizeDisabledFilters(rawDefaults.disabledFilters, 'defaults.disabledFilters'),
        processingMode: rawDefaults.processingMode === 'live-snapshot' ? 'live-snapshot' : 'calibration'
    };
    if (rawDefaults.processingMode != null && !['calibration', 'live-snapshot'].includes(rawDefaults.processingMode)) {
        throw new Error('defaults.processingMode must be calibration or live-snapshot');
    }

    const ids = new Set();
    const steps = input.steps.map((raw, index) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Step ${index + 1} must be an object`);
        if (version >= 3) assertKnownKeys(raw, ['id', 'name', 'instruction', 'position', 'activeWays', 'ways', 'crossovers', 'disabledFilters', 'rew', 'inputEq'], `Step ${index + 1}`);
        const id = text(raw.id, 64, `Step ${index + 1} id`, `M${String(index + 1).padStart(2, '0')}`);
        if (ids.has(id)) throw new Error(`Duplicate step id '${id}'`);
        ids.add(id);
        const stepName = text(raw.name, 160, `Step ${id} name`, id);
        const ways = {};
        const crossovers = {};

        if (raw.ways != null) {
            if (!raw.ways || typeof raw.ways !== 'object' || Array.isArray(raw.ways)) throw new Error(`Step ${id} ways must be an object`);
            for (const [rawKey, value] of Object.entries(raw.ways)) {
                const key = normalizeWayKey(rawKey);
                ways[key] = normalizeWayOverride(value, `Step ${id} ways.${key}`, version);
                if (version < 2 && ways[key].peq) throw new Error(`Step ${id} output PEQ requires batch version 2`);
            }
        }
        if (raw.crossovers != null) {
            if (!raw.crossovers || typeof raw.crossovers !== 'object' || Array.isArray(raw.crossovers)) throw new Error(`Step ${id} crossovers must be an object`);
            for (const [rawKey, value] of Object.entries(raw.crossovers)) {
                const key = normalizeWayKey(rawKey);
                crossovers[key] = normalizeCrossoverOverride(value, `Step ${id} crossovers.${key}`);
            }
        }

        if (raw.inputEq != null && version < 3) throw new Error(`Step ${id} inputEq requires batch version 3`);
        const inputEq = raw.inputEq == null ? null : normalizeInputEq(raw.inputEq, `Step ${id} inputEq`);
        if (inputEq && [...defaults.disabledFilters, ...normalizeDisabledFilters(raw.disabledFilters, `Step ${id} disabledFilters`)]
            .some(name => [...inputEqState.GEQ_NAMES, ...inputModel.GLOBAL_EQ_SLOT_NAMES].includes(name))) {
            throw new Error(`Step ${id} cannot combine inputEq with disabledFilters targeting input EQ; use enabled instead`);
        }
        const activeWays = normalizeWayList(raw.activeWays, `Step ${id} activeWays`);
        if (version >= 3) for (const key of [...Object.keys(ways), ...Object.keys(crossovers)]) {
            if (!activeWays.includes(key)) throw new Error(`Step ${id} changes ${key} but does not include it in activeWays`);
        }
        return {
            id,
            name: stepName,
            instruction: text(raw.instruction, 1000, `Step ${id} instruction`),
            position: text(raw.position, 240, `Step ${id} position`),
            activeWays,
            ways,
            crossovers,
            ...(inputEq ? { inputEq } : {}),
            disabledFilters: normalizeDisabledFilters(raw.disabledFilters, `Step ${id} disabledFilters`),
            rew: normalizeRew(raw.rew, id, stepName)
        };
    });

    if (defaults.processingMode === 'live-snapshot') {
        if (steps.length !== 1 || !defaults.muteUnlisted || defaults.disabledFilters.length ||
            steps.some(step => Object.keys(step.ways).length || Object.keys(step.crossovers).length || step.disabledFilters.length || step.inputEq)) {
            throw new Error('Live snapshot must contain one measurement with no gain, filter or crossover overrides');
        }
    }
    return { schema: 'estack.measurement-batch', version, name, description, defaults, steps };
}

function firstMixerIndex(config) {
    return (config?.pipeline || []).findIndex(step => step?.type === 'Mixer');
}

function stepChannels(step) {
    if (Array.isArray(step?.channels)) return step.channels.map(Number).filter(Number.isInteger);
    if (step?.channel != null && Number.isInteger(Number(step.channel))) return [Number(step.channel)];
    return [];
}

function wayFilterNames(config, channel) {
    const pipeline = config?.pipeline || [];
    const mixerIndex = firstMixerIndex(config);
    if (mixerIndex < 0) throw new Error('Measurement Batch requires a Mixer stage in the DSP pipeline');
    const names = [];
    for (let index = mixerIndex + 1; index < pipeline.length; index += 1) {
        const step = pipeline[index];
        if (step?.type !== 'Filter') continue;
        if (!stepChannels(step).includes(channel)) continue;
        for (const name of step.names || []) if (!names.includes(name)) names.push(name);
    }
    return names;
}

function matchingWayFilters(config, wayKey, predicate) {
    const def = WAY_DEFS[wayKey];
    return wayFilterNames(config, def.channel).filter(name => predicate(config?.filters?.[name], name));
}

function uniqueWayFilter(config, wayKey, predicate, label) {
    const def = WAY_DEFS[wayKey];
    const matches = matchingWayFilters(config, wayKey, predicate);
    if (matches.length !== 1) throw new Error(`${def.label} requires exactly one ${label} filter after routing; found ${matches.length}`);
    return matches[0];
}

function gainFilterName(config, wayKey) {
    return uniqueWayFilter(config, wayKey, filter => filter?.type === 'Gain', 'Gain');
}

function delayFilterName(config, wayKey) {
    const channel = WAY_DEFS[wayKey].channel;
    const matches = matchingWayFilters(config, wayKey, filter => filter?.type === 'Delay');
    // A protection stage can reuse a Delay filter definition on several
    // outputs. Changing that definition would change every output using it.
    // Inspect every reference, including pre-mixer stages, before selecting a
    // candidate. Filter names and current delay values are not proof of ownership.
    const gainName = gainFilterName(config, wayKey);
    const pipeline = config?.pipeline || [];
    const mixerIndex = firstMixerIndex(config);
    const independent = matches.filter(name => pipeline.every((stage, index) => {
        if (stage?.type !== 'Filter' || !Array.isArray(stage.names) || !stage.names.includes(name)) return true;
        const channels = stepChannels(stage);
        return index > mixerIndex && channels.length === 1 && channels[0] === channel;
    }));
    const wayStageDelays = [];
    for (let index = mixerIndex + 1; index < pipeline.length; index += 1) {
        const stage = pipeline[index];
        if (stage?.type !== 'Filter' || !Array.isArray(stage.names)) continue;
        const channels = stepChannels(stage);
        if (channels.length !== 1 || channels[0] !== channel) continue;
        if (!stage.names.includes(gainName)) continue;
        for (const name of stage.names) {
            if (independent.includes(name) && !wayStageDelays.includes(name)) wayStageDelays.push(name);
        }
    }
    if (wayStageDelays.length > 1) {
        throw new Error(`${WAY_DEFS[wayKey].label} has ${wayStageDelays.length} independent Delay filters in its Gain stage; delay target is ambiguous`);
    }
    if (wayStageDelays.length === 1) return wayStageDelays[0];
    if (independent.length === 1) return independent[0];
    if (!independent.length && matches.length) {
        throw new Error(`${WAY_DEFS[wayKey].label} has no independent Delay filter; ${matches.join(', ')} is shared with another output or input`);
    }
    throw new Error(`${WAY_DEFS[wayKey].label} requires exactly one independent way Delay filter after routing; found ${independent.length}`);
}

function crossoverMatches(config, wayKey, side) {
    const suffix = side === 'hpf' ? /Highpass$/ : /Lowpass$/;
    return matchingWayFilters(
        config,
        wayKey,
        filter => filter?.type === 'BiquadCombo' && suffix.test(String(filter?.parameters?.type || ''))
    );
}

function crossoverFilterName(config, wayKey, side) {
    const matches = crossoverMatches(config, wayKey, side);
    if (matches.length !== 1) {
        throw new Error(`${WAY_DEFS[wayKey].label} requires exactly one ${side.toUpperCase()} filter after routing; found ${matches.length}`);
    }
    return matches[0];
}

function disableInputFilter(config, filterName) {
    if (!config?.filters?.[filterName]) throw new Error(`Cannot disable missing filter '${filterName}'`);
    const pipeline = config.pipeline || [];
    const mixerIndex = firstMixerIndex(config);
    if (mixerIndex < 0) throw new Error('Measurement Batch requires a Mixer stage in the DSP pipeline');
    let found = false;

    for (let index = 0; index < pipeline.length; index += 1) {
        const step = pipeline[index];
        if (step?.type !== 'Filter' || !Array.isArray(step.names) || !step.names.includes(filterName)) continue;
        found = true;
        if (index > mixerIndex) {
            throw new Error(`disabledFilters can only bypass pre-routing/input processing; '${filterName}' is in output processing`);
        }
        step.names = step.names.filter(name => name !== filterName);
    }
    if (!found) throw new Error(`Filter '${filterName}' is not active in the baseline pipeline`);
    config.pipeline = pipeline.filter(step => !(step?.type === 'Filter' && Array.isArray(step.names) && step.names.length === 0));
}

function applyCrossoverSpec(filter, baselineFilter, spec, side, wayKey) {
    if (!filter || filter.type !== 'BiquadCombo') throw new Error(`Target ${side.toUpperCase()} is not a BiquadCombo`);
    filter.parameters = filter.parameters || {};
    const baselineFreq = Number(baselineFilter?.parameters?.freq);
    if (spec.freqHz != null) {
        if (Number.isFinite(baselineFreq) && baselineFreq > 0) {
            const low = Math.max(10, baselineFreq * 0.4);
            const high = Math.min(24000, baselineFreq * 2.5);
            if (spec.freqHz < low || spec.freqHz > high) {
                throw new Error(`${WAY_DEFS[wayKey].label} ${side.toUpperCase()} ${spec.freqHz} Hz is outside the guarded range ${low.toFixed(1)}–${high.toFixed(1)} Hz around the captured baseline`);
            }
        }
        filter.parameters.freq = spec.freqHz;
    }
    if (spec.family) filter.parameters.type = `${spec.family}${side === 'hpf' ? 'Highpass' : 'Lowpass'}`;
    if (spec.order != null) filter.parameters.order = spec.order;
    if (String(filter.parameters.type || '').startsWith('LinkwitzRiley') && Number(filter.parameters.order) % 2) {
        throw new Error('Linkwitz-Riley crossover order must be even');
    }
}

function phaseFilterName(wayKey) {
    return `${PHASE_PREFIX}CH${WAY_DEFS[wayKey].channel}`;
}

function removePhase(config, wayKey) {
    const name = phaseFilterName(wayKey);
    for (const step of config?.pipeline || []) {
        if (step?.type !== 'Filter' || !Array.isArray(step.names)) continue;
        step.names = step.names.filter(item => item !== name);
    }
    if (config?.filters) delete config.filters[name];
}

function outputStageForPhase(config, wayKey) {
    const channel = WAY_DEFS[wayKey].channel;
    const mixerIndex = firstMixerIndex(config);
    if (mixerIndex < 0) throw new Error('Measurement Batch requires a Mixer stage in the DSP pipeline');
    const candidates = (config.pipeline || [])
        .slice(mixerIndex + 1)
        .filter(step => step?.type === 'Filter' && stepChannels(step).includes(channel))
        .filter(step => (step.names || []).some(name => ['Gain', 'Delay', 'BiquadCombo'].includes(config?.filters?.[name]?.type)));
    if (!candidates.length) throw new Error(`${WAY_DEFS[wayKey].label} has no output filter stage for phase trim`);
    const stage = candidates[0];
    const channels = stepChannels(stage);
    if (channels.length !== 1 || channels[0] !== channel) {
        throw new Error(`${WAY_DEFS[wayKey].label} phase trim requires an independent per-output filter stage`);
    }
    return stage;
}

function attachPhaseBeforeGain(config, wayKey, name) {
    const stage = outputStageForPhase(config, wayKey);
    stage.names = Array.isArray(stage.names) ? stage.names.filter(item => item !== name) : [];
    let index = stage.names.findIndex(item => config?.filters?.[item]?.type === 'Gain');
    if (index < 0) index = stage.names.findIndex(item => config?.filters?.[item]?.type === 'Delay');
    if (index < 0) index = stage.names.length;
    stage.names.splice(index, 0, name);
}

function phaseReferenceFrequency(config, wayKey, spec) {
    const fs = Number(config?.devices?.samplerate || 48000);
    const nyquist = fs / 2;
    if (spec.referenceHz != null) {
        if (spec.referenceHz >= nyquist) throw new Error(`${WAY_DEFS[wayKey].label} phase reference must be below Nyquist (${nyquist} Hz)`);
        return spec.referenceHz;
    }

    const reference = spec.reference || 'auto';
    const sides = reference === 'auto' ? ['lpf', 'hpf'] : [reference];
    for (const side of sides) {
        const matches = crossoverMatches(config, wayKey, side);
        if (!matches.length) continue;
        if (matches.length !== 1) throw new Error(`${WAY_DEFS[wayKey].label} phase reference ${side.toUpperCase()} is ambiguous`);
        const freq = Number(config?.filters?.[matches[0]]?.parameters?.freq);
        if (!Number.isFinite(freq) || freq <= 0 || freq >= nyquist) {
            throw new Error(`${WAY_DEFS[wayKey].label} ${side.toUpperCase()} frequency is invalid for phase reference`);
        }
        return freq;
    }
    throw new Error(`${WAY_DEFS[wayKey].label} has no ${reference === 'auto' ? 'crossover' : reference.toUpperCase()} available for phase reference`);
}

// Same first-order all-pass law used by the manual Output Processing PHASE control.
function allpassFrequencyForPhase(phaseDeg, referenceHz, samplerate) {
    const fs = Number(samplerate || 48000);
    const phase = Math.max(0.01, Math.min(179.5, Math.abs(Number(phaseDeg))));
    const reference = Math.max(1, Math.min(fs / 2 - 1, Number(referenceHz)));
    const tReference = Math.tan(Math.PI * reference / fs);
    const divisor = Math.tan(phase * Math.PI / 360);
    const tDesign = tReference / Math.max(1e-9, divisor);
    return Math.max(1, Math.min(fs / 2 - 1, (fs / Math.PI) * Math.atan(tDesign)));
}

function applyPhase(config, wayKey, spec) {
    const name = phaseFilterName(wayKey);
    removePhase(config, wayKey);
    if (Math.abs(Number(spec.degrees)) < 0.05) return;

    const referenceHz = phaseReferenceFrequency(config, wayKey, spec);
    const filterHz = allpassFrequencyForPhase(spec.degrees, referenceHz, config?.devices?.samplerate || 48000);
    config.filters = config.filters || {};
    config.filters[name] = {
        type: 'Biquad',
        description: `E-Stack phase trim ${WAY_DEFS[wayKey].label} (${Number(spec.degrees).toFixed(1)} deg @ ${referenceHz.toFixed(1)} Hz; Measurement Batch)`,
        parameters: {
            type: 'AllpassFO',
            freq: Math.round(filterHz * 10) / 10
        }
    };
    attachPhaseBeforeGain(config, wayKey, name);
}

function applyOutputPeq(config, wayKey, peqs, version) {
    const channel = WAY_DEFS[wayKey].channel;
    const gainName = gainFilterName(config, wayKey);
    const mixerIndex = firstMixerIndex(config);
    const stages = (config.pipeline || []).slice(mixerIndex + 1)
        .filter(step => step?.type === 'Filter' && Array.isArray(step.names) && step.names.includes(gainName));
    if (stages.length !== 1 || stepChannels(stages[0]).length !== 1 || stepChannels(stages[0])[0] !== channel || stages[0].bypassed === true) {
        throw new Error(`${WAY_DEFS[wayKey].label} output PEQ requires one active independent Gain stage`);
    }
    const stage = stages[0];
    const nyquist = Number(config?.devices?.samplerate || 48000) / 2;
    for (const spec of peqs) {
        if (spec.freqHz >= nyquist) throw new Error(`${WAY_DEFS[wayKey].label} PEQ frequency must be below Nyquist`);
        const name = `USER_CH${channel}_PEQ_${String(spec.slot).padStart(2, '0')}`;
        for (const reference of config.pipeline || []) {
            if (reference?.type === 'Filter' && reference !== stage && (reference.names || []).includes(name)) {
                throw new Error(`${WAY_DEFS[wayKey].label} PEQ '${name}' is shared with another stage`);
            }
        }
        const existing = config.filters[name];
        if (existing && (existing.type !== 'Biquad' ||
            !(version >= 3 ? inputModel.EQ_TYPES : ['Peaking']).includes(existing.parameters?.type))) {
            throw new Error(`${WAY_DEFS[wayKey].label} PEQ slot ${spec.slot} is not an independent supported EQ filter`);
        }
        if (existing && !stage.names.includes(name) &&
            (version < 3 || spec.enabled === false)) {
            throw new Error(`${WAY_DEFS[wayKey].label} PEQ slot ${spec.slot} is not active in its independent Gain stage`);
        }
        if (existing && (typeof existing.parameters.gain !== 'number' || !Number.isFinite(existing.parameters.gain))) {
            throw new Error(`${WAY_DEFS[wayKey].label} PEQ slot ${spec.slot} has an invalid captured gain`);
        }
        if (spec.enabled === false) {
            if (!existing) throw new Error(`${WAY_DEFS[wayKey].label} cannot disable missing PEQ slot ${spec.slot}`);
            stage.names = stage.names.filter(item => item !== name);
            continue;
        }
        if (existing && spec.gainDb > Number(existing.parameters.gain) + 3) {
            throw new Error(`${WAY_DEFS[wayKey].label} PEQ slot ${spec.slot} cannot raise its captured baseline by more than 3 dB`);
        }
        if (!existing && spec.gainDb > 3) throw new Error(`${WAY_DEFS[wayKey].label} new PEQ slot ${spec.slot} cannot boost by more than 3 dB`);
        if (!existing) {
            config.filters[name] = {
                type: 'Biquad',
                description: `E-Stack PEQ ${String(spec.slot).padStart(2, '0')} · ${WAY_DEFS[wayKey].label}`,
                parameters: { type: 'Peaking' }
            };
            stage.names.splice(stage.names.indexOf(gainName), 0, name);
        } else if (!stage.names.includes(name)) {
            stage.names.splice(stage.names.indexOf(gainName), 0, name);
        }
        Object.assign(config.filters[name].parameters, {
            type: spec.type || 'Peaking', freq: spec.freqHz, q: spec.q, gain: spec.gainDb
        });
    }
}

function activeInputEqResponse(config, frequency) {
    const mixer = firstMixerIndex(config);
    const names = new Set((config.pipeline || []).slice(0, mixer).filter(stage =>
        stage?.type === 'Filter' && stage.bypassed !== true &&
        stepChannels(stage).includes(0) && stepChannels(stage).includes(1)
    ).flatMap(stage => stage.names || []));
    const rate = Number(config.devices.samplerate);
    return [...names].reduce((sum, name) => {
        if (config.filters[name]?.type !== 'Biquad' || !inputModel.EQ_TYPES.includes(config.filters[name]?.parameters?.type)) return sum;
        const p = config.filters[name]?.parameters;
        if (![p.freq, p.gain, p.q].every(Number.isFinite)) throw new Error(`Input EQ '${name}' has invalid parameters`);
        return sum + inputModel.rawResponseAt({ type: p.type, frequency: p.freq, gain: p.gain, q: p.q }, frequency, rate);
    }, 0);
}

function applyInputEq(config, baseline, candidate) {
    // The same semantic state and fit are used by Input Processing. Refuse
    // ambiguous ownership before touching any shared L/R filter definition.
    inputEqState.validate(baseline);
    const state = inputEqState.read(config);
    if (candidate.geq) {
        if (candidate.geq.enabled != null) state.geq.enabled = candidate.geq.enabled;
        if (candidate.geq.targets) state.geq.targets = candidate.geq.targets;
    }
    if (candidate.peq) {
        if (candidate.peq.enabled != null) state.peq.enabled = candidate.peq.enabled;
        for (const band of candidate.peq.bands || []) {
            const name = inputModel.GLOBAL_EQ_SLOT_NAMES[band.slot - 1];
            const existing = config.filters[name];
            if (existing && existing.type !== 'Biquad') throw new Error(`Input PEQ slot ${band.slot} is not a Biquad`);
            config.filters[name] = inputModel.filterForBand({ slot: name, type: band.type, frequency: band.freqHz,
                q: band.q, gain: band.gainDb });
            state.peq.disabled = state.peq.disabled.filter(item => item !== name);
            if (!band.enabled) state.peq.disabled.push(name);
        }
    }
    inputEqState.rebuild(config, state, { fitGeq: !!candidate.geq?.targets });
}

function activeOutputPeqResponse(config, wayKey, frequency) {
    const mixer = firstMixerIndex(config);
    const channel = WAY_DEFS[wayKey].channel;
    const names = new Set((config.pipeline || []).slice(mixer + 1)
        .filter(stage => stage?.type === 'Filter' && stage.bypassed !== true && stepChannels(stage).includes(channel))
        .flatMap(stage => stage.names || []));
    const prefix = `USER_CH${channel}_PEQ_`;
    const rate = Number(config.devices.samplerate);
    return [...names].filter(name => name.startsWith(prefix)).reduce((sum, name) => {
        const p = config.filters[name]?.parameters;
        if (!p || !inputModel.EQ_TYPES.includes(p.type)) throw new Error(`${WAY_DEFS[wayKey].label} PEQ '${name}' is not a supported EQ filter`);
        if (![p.freq, p.gain, p.q].every(Number.isFinite)) throw new Error(`${WAY_DEFS[wayKey].label} PEQ '${name}' has invalid parameters`);
        return sum + inputModel.rawResponseAt({ type: p.type, frequency: p.freq, gain: p.gain, q: p.q }, frequency, rate);
    }, 0);
}

function assertV3CandidateBoost(baseline, candidate, activeWays) {
    // Evaluate input EQ, output PEQ and way gain together. Separate +3 dB
    // allowances would stack into a much larger acoustic candidate. The
    // spectral check also catches switching off a deep cut or changing its
    // frequency/type while leaving the gain parameter numerically unchanged.
    for (const wayKey of activeWays) {
        const baselineName = gainFilterName(baseline, wayKey);
        const nextName = gainFilterName(candidate, wayKey);
        const oldGain = Number(baseline.filters[baselineName].parameters?.gain);
        const nextGain = Number(candidate.filters[nextName].parameters?.gain);
        if (!Number.isFinite(oldGain) || !Number.isFinite(nextGain) ||
            baseline.filters[baselineName].parameters?.scale !== 'dB' || candidate.filters[nextName].parameters?.scale !== 'dB') {
            throw new Error(`${WAY_DEFS[wayKey].label} requires a valid dB Gain filter for version 3 candidates`);
        }
        for (let i = 0; i <= 160; i++) {
            const frequency = 20 * (1000 ** (i / 160));
            const boost = nextGain - oldGain +
                activeInputEqResponse(candidate, frequency) - activeInputEqResponse(baseline, frequency) +
                activeOutputPeqResponse(candidate, wayKey, frequency) - activeOutputPeqResponse(baseline, wayKey, frequency);
            if (boost > 3.05) {
                throw new Error(`${WAY_DEFS[wayKey].label} candidate boosts the captured EQ and gain response by ${boost.toFixed(1)} dB at ${frequency.toFixed(0)} Hz; maximum is +3 dB`);
            }
        }
    }
}

function applyStep(baselineConfig, batchInput, stepOrIndex) {
    const batch = normalizeBatch(batchInput);
    const step = typeof stepOrIndex === 'number' ? batch.steps[stepOrIndex] : stepOrIndex;
    if (!step) throw new Error('Measurement step not found');
    const next = clone(baselineConfig || {});
    if (!next.filters || !Array.isArray(next.pipeline)) throw new Error('Current CamillaDSP processing configuration is incomplete');

    const active = new Set(step.activeWays);
    if (batch.defaults.muteUnlisted) {
        for (const wayKey of Object.keys(WAY_DEFS)) {
            const name = gainFilterName(next, wayKey);
            next.filters[name].parameters = next.filters[name].parameters || {};
            if (!active.has(wayKey)) next.filters[name].parameters.mute = true;
            else if (batch.defaults.processingMode !== 'live-snapshot') next.filters[name].parameters.mute = false;
        }
    } else if (batch.defaults.processingMode !== 'live-snapshot') {
        for (const wayKey of active) {
            const name = gainFilterName(next, wayKey);
            next.filters[name].parameters = next.filters[name].parameters || {};
            next.filters[name].parameters.mute = false;
        }
    }

    if (step.inputEq) applyInputEq(next, baselineConfig, step.inputEq);
    for (const filterName of [...batch.defaults.disabledFilters, ...step.disabledFilters]) disableInputFilter(next, filterName);

    for (const [wayKey, override] of Object.entries(step.ways || {})) {
        if (override.delayMs != null || override.delayOffsetMs != null) {
            const name = delayFilterName(next, wayKey);
            const baseDelay = Number(baselineConfig?.filters?.[name]?.parameters?.delay);
            if (!Number.isFinite(baseDelay)) throw new Error(`${WAY_DEFS[wayKey].label} baseline delay is invalid`);
            const delay = override.delayMs != null ? override.delayMs : baseDelay + override.delayOffsetMs;
            if (delay < 0 || delay > 100) throw new Error(`${WAY_DEFS[wayKey].label} resulting delay ${delay} ms is outside 0..100 ms`);
            next.filters[name].parameters.delay = delay;
            if (!next.filters[name].parameters.unit) next.filters[name].parameters.unit = 'ms';
        }
        if (override.polarity) {
            const name = gainFilterName(next, wayKey);
            next.filters[name].parameters.inverted = override.polarity === 'inverted';
        }
        if (override.gainOffsetDb != null) {
            const name = gainFilterName(next, wayKey);
            const baselineGain = Number(baselineConfig?.filters?.[name]?.parameters?.gain);
            if (!Number.isFinite(baselineGain)) throw new Error(`${WAY_DEFS[wayKey].label} baseline gain is invalid`);
            next.filters[name].parameters.gain = baselineGain + override.gainOffsetDb;
            next.filters[name].parameters.scale = 'dB';
        }
        if (override.gainDb != null) {
            const name = gainFilterName(next, wayKey);
            const baselineGain = Number(baselineConfig?.filters?.[name]?.parameters?.gain);
            if (!Number.isFinite(baselineGain)) throw new Error(`${WAY_DEFS[wayKey].label} baseline gain is invalid`);
            if (override.gainDb > baselineGain + 3) throw new Error(`${WAY_DEFS[wayKey].label} gainDb cannot exceed captured gain by more than 3 dB`);
            next.filters[name].parameters.gain = override.gainDb;
            next.filters[name].parameters.scale = 'dB';
        }
    }

    const sharedRequests = new Map();
    for (const [wayKey, crossover] of Object.entries(step.crossovers || {})) {
        for (const side of ['hpf', 'lpf']) {
            const spec = crossover[side];
            if (!spec) continue;
            const name = crossoverFilterName(next, wayKey, side);
            const request = JSON.stringify(stable(spec));
            if (sharedRequests.has(name) && sharedRequests.get(name) !== request) {
                throw new Error(`Conflicting crossover overrides target shared filter '${name}'`);
            }
            sharedRequests.set(name, request);
            applyCrossoverSpec(next.filters[name], baselineConfig?.filters?.[name], spec, side, wayKey);
        }
    }

    // Phase is deliberately applied after crossover overrides. A reference such
    // as HPF/LPF therefore uses the actual crossover frequency of this step.
    for (const [wayKey, override] of Object.entries(step.ways || {})) {
        if (override.phase) applyPhase(next, wayKey, override.phase);
        if (override.peq) applyOutputPeq(next, wayKey, override.peq, batch.version);
    }

    if (batch.version >= 3 && (step.inputEq || Object.values(step.ways || {}).some(way => way.gainDb != null || way.peq))) {
        assertV3CandidateBoost(baselineConfig, next, step.activeWays);
    }

    return next;
}

function processingOf(config) {
    return {
        filters: clone(config?.filters || {}),
        pipeline: clone(config?.pipeline || []),
        processors: clone(config?.processors || {})
    };
}

function mergeProcessingIntoLive(liveConfig, targetConfig) {
    const next = clone(liveConfig || {});
    const processing = processingOf(targetConfig);
    next.filters = processing.filters;
    next.pipeline = processing.pipeline;
    next.processors = processing.processors;
    return next;
}

function sameProcessing(a, b) {
    return JSON.stringify(stable(processingOf(a))) === JSON.stringify(stable(processingOf(b)));
}

function describeStep(step, index, total) {
    if (!step) return null;
    const ways = step.activeWays.map(key => WAY_DEFS[key]?.label || key).join(' + ');
    const rew = clone(step.rew || {});
    const sweep = Number.isFinite(Number(rew.startHz)) && Number.isFinite(Number(rew.endHz))
        ? `${Number(rew.startHz)}–${Number(rew.endHz)} Hz`
        : null;
    return {
        index,
        number: index + 1,
        total,
        id: step.id,
        name: step.name,
        instruction: step.instruction,
        position: step.position,
        activeWays: [...step.activeWays],
        activeWayLabels: step.activeWays.map(key => WAY_DEFS[key]?.label || key),
        ways: clone(step.ways || {}),
        crossovers: clone(step.crossovers || {}),
        inputEq: clone(step.inputEq || null),
        disabledFilters: [...(step.disabledFilters || [])],
        rew,
        summary: `${step.id} · ${step.name} · ${ways}${sweep ? ` · ${sweep}` : ''}`
    };
}

module.exports = {
    WAY_DEFS,
    PHASE_PREFIX,
    normalizeWayKey,
    normalizeBatch,
    applyStep,
    processingOf,
    mergeProcessingIntoLive,
    sameProcessing,
    describeStep,
    allpassFrequencyForPhase,
    clone
};
