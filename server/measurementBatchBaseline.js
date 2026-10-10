'use strict';

const crypto = require('crypto');

const WAY_DEFS = Object.freeze({
    SUB: { channel: 0, label: 'SUB' },
    KICK: { channel: 1, label: 'KICK' },
    MID_L: { channel: 2, label: 'MID L' },
    MID_R: { channel: 3, label: 'MID R' },
    HIGH_L: { channel: 4, label: 'HIGH L' },
    HIGH_R: { channel: 5, label: 'HIGH R' }
});
const MEASUREMENT_FORCED_OFF = new Set(['ESTACK_LOUDNESS']);

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
        return out;
    }
    return value;
}

function stepChannels(step) {
    if (Array.isArray(step?.channels)) return step.channels.map(Number).filter(Number.isInteger);
    if (step?.channel != null && Number.isInteger(Number(step.channel))) return [Number(step.channel)];
    return [];
}

function firstMixerIndex(config) {
    return (config?.pipeline || []).findIndex(step => step?.type === 'Mixer');
}

function processingFingerprint(config) {
    const processing = {
        filters: config?.filters || {},
        pipeline: config?.pipeline || [],
        processors: config?.processors || {},
        mixers: config?.mixers || {}
    };
    return crypto.createHash('sha256')
        .update(JSON.stringify(stable(processing)))
        .digest('hex')
        .slice(0, 12)
        .toUpperCase();
}

function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function classifyFilter(filter) {
    const type = String(filter?.type || 'Unknown');
    const subtype = String(filter?.parameters?.type || '');
    if (type === 'Gain') return 'gain';
    if (type === 'Delay') return 'delay';
    if (type === 'Limiter') return 'protection';
    if (type === 'Loudness') return 'dynamic';
    if (type === 'Biquad' || type === 'BiquadCombo') {
        if (/allpass/i.test(subtype)) return 'phase';
        if (/highpass|lowpass/i.test(subtype)) return 'crossover';
        if (/peaking|shelf|notch|bandpass|bandstop|parametric|eq/i.test(subtype)) return 'eq';
        return 'eq';
    }
    return 'other';
}

function filterDetail(name, filter, channels = []) {
    const params = filter?.parameters || {};
    return {
        name,
        kind: classifyFilter(filter),
        type: String(filter?.type || 'Unknown'),
        subtype: params.type != null ? String(params.type) : null,
        freqHz: finite(params.freq),
        gainDb: finite(params.gain),
        q: finite(params.q),
        bandwidth: finite(params.bandwidth),
        slope: finite(params.slope),
        order: finite(params.order),
        delayMs: String(params.unit || '').toLowerCase() === 'ms' ? finite(params.delay) : null,
        inverted: typeof params.inverted === 'boolean' ? params.inverted : null,
        mute: typeof params.mute === 'boolean' ? params.mute : null,
        description: filter?.description ? String(filter.description) : null,
        channels: [...new Set(channels)].sort((a, b) => a - b).map(channel => channel + 1)
    };
}

function collectFilterRefs(config, fromIndex, toIndex, channel = null) {
    const refs = new Map();
    const pipeline = config?.pipeline || [];
    for (let index = fromIndex; index < toIndex; index += 1) {
        const step = pipeline[index];
        if (step?.type !== 'Filter' || !Array.isArray(step.names) || !step.names.length) continue;
        const channels = stepChannels(step);
        if (channel != null && !channels.includes(channel)) continue;
        for (const name of step.names) {
            if (!config?.filters?.[name]) continue;
            if (!refs.has(name)) refs.set(name, new Set());
            for (const item of channels) refs.get(name).add(item);
        }
    }
    return [...refs.entries()].map(([name, channels]) => filterDetail(name, config.filters[name], [...channels]));
}

function collectSharedInputRefs(config, mixerIndex) {
    const refs = new Map();
    const pipeline = config?.pipeline || [];
    for (let index = 0; index < mixerIndex; index += 1) {
        const step = pipeline[index];
        if (step?.type !== 'Filter' || !Array.isArray(step.names) || !step.names.length) continue;
        const channels = stepChannels(step);
        if (!channels.includes(0) || !channels.includes(1)) continue;
        for (const name of step.names) {
            if (!config?.filters?.[name]) continue;
            if (!refs.has(name)) refs.set(name, new Set());
            for (const channel of channels) refs.get(name).add(channel);
        }
    }
    return [...refs.entries()].map(([name, channels]) => filterDetail(name, config.filters[name], [...channels]));
}

function summarizeBaseline(config, options = {}) {
    if (!config || typeof config !== 'object') throw new Error('Baseline configuration is unavailable');
    const mixerIndex = firstMixerIndex(config);
    if (mixerIndex < 0) throw new Error('Baseline processing has no Mixer stage');

    const inputFilters = collectFilterRefs(config, 0, mixerIndex);
    const sharedInputFilters = collectSharedInputRefs(config, mixerIndex);
    const ways = {};
    const uniqueOutputEq = new Set();

    for (const [key, def] of Object.entries(WAY_DEFS)) {
        const filters = collectFilterRefs(config, mixerIndex + 1, (config.pipeline || []).length, def.channel);
        const eqFilters = filters.filter(item => item.kind === 'eq');
        for (const item of eqFilters) uniqueOutputEq.add(item.name);
        ways[key] = {
            label: def.label,
            eqCount: eqFilters.length,
            eqFilters,
            filters
        };
    }

    const inputEqFilters = inputFilters.filter(item => item.kind === 'eq');
    const sharedInputEqFilters = sharedInputFilters.filter(item => item.kind === 'eq');
    const dynamicInputFilters = inputFilters.filter(item => item.kind === 'dynamic');
    const liveSnapshot = options.processingMode === 'live-snapshot';
    const forcedOffDynamicFilters = liveSnapshot ? [] : dynamicInputFilters.filter(item => MEASUREMENT_FORCED_OFF.has(item.name));
    const activeMeasurementDynamicFilters = dynamicInputFilters.filter(item => liveSnapshot || !MEASUREMENT_FORCED_OFF.has(item.name));
    for (const item of forcedOffDynamicFilters) {
        item.kind = 'forced-off';
        item.description = `${item.description ? `${item.description} · ` : ''}Measurement Batch forces this filter OFF for every measurement step and restores its baseline state on finish/abort.`;
    }
    const measurementInput = options.measurementInput == null ? null : Number(options.measurementInput);
    const warnings = [];

    if (activeMeasurementDynamicFilters.length) {
        warnings.push(`Dynamic input processing active during measurement: ${activeMeasurementDynamicFilters.map(item => item.name).join(', ')}`);
    }
    if (measurementInput != null && measurementInput > 2 && !sharedInputFilters.length) {
        warnings.push(`IN${measurementInput} has no shared Input L/R Filter stage to inherit`);
    }

    return {
        id: processingFingerprint(config),
        captured: !!options.captured,
        capturedAt: options.capturedAt || null,
        samplerate: finite(config?.devices?.samplerate),
        measurementInput,
        measurementInputMode: measurementInput == null ? 'baseline-routing' : 'dedicated-mono',
        sharedInputMirrored: measurementInput != null && measurementInput > 2,
        measurementPolicy: {
            loudness: liveSnapshot ? 'captured-live' : 'forced-off',
            inputTrim: liveSnapshot ? 'captured-live' : 'forced-off',
            forcedOffFilters: forcedOffDynamicFilters.map(item => item.name)
        },
        counts: {
            inputEq: inputEqFilters.length,
            sharedInputEq: sharedInputEqFilters.length,
            outputEqUnique: uniqueOutputEq.size
        },
        input: {
            eqCount: inputEqFilters.length,
            eqFilters: inputEqFilters,
            filters: inputFilters,
            sharedEqCount: sharedInputEqFilters.length,
            sharedEqFilters: sharedInputEqFilters,
            sharedFilters: sharedInputFilters,
            dynamicFilters: dynamicInputFilters,
            forcedOffDynamicFilters
        },
        ways,
        warnings
    };
}

module.exports = {
    WAY_DEFS,
    classifyFilter,
    processingFingerprint,
    summarizeBaseline
};
