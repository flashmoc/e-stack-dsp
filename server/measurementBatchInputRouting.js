'use strict';

const loudnessModel = require('./loudnessPresetModel');

const INPUT_PREAMP_FILTER = 'ESTACK_INPUT_PREAMP';
const INPUT_PREAMP_STEP = 'E-Stack input preamp';

/*
 * Optional Measurement Batch capture-input routing.
 *
 * Batch files use one-based physical numbering (IN1..IN8). CamillaDSP mixer
 * source channels are zero-based, so measurementInput: 4 routes channel 3.
 *
 * A dedicated REW input must also hear the same shared pre-routing processing
 * as the normal L/R programme inputs. Otherwise a GLOBAL/Input PEQ on channels
 * 0+1 would be bypassed when measuring from IN3/IN4, and the measured system
 * would not represent the final listening chain. Shared L/R Filter stages are
 * therefore extended temporarily to the selected measurement channel before
 * that channel is routed at unity gain to the E-Stack ways.
 *
 * Measurement mode has two additional invariants: ESTACK_LOUDNESS and the
 * normal-listening ESTACK_INPUT_PREAMP are always OFF. Their captured baseline
 * state is restored exactly on finish/abort, but neither is allowed to bias REW
 * calibration levels or be mirrored from L/R onto a dedicated measurement input.
 *
 * The batch session already captures the complete live config. This module
 * extends the batch-owned temporary state to include mixer routing while still
 * leaving hardware devices under the live CamillaDSP configuration.
 */

module.exports = function installMeasurementBatchInputRouting(model) {
    if (!model || typeof model !== 'object') throw new Error('Measurement Batch model is required');
    if (model.__measurementInputRoutingInstalled) return model;

    const original = {
        normalizeBatch: model.normalizeBatch,
        applyStep: model.applyStep,
        processingOf: model.processingOf,
        mergeProcessingIntoLive: model.mergeProcessingIntoLive,
        sameProcessing: model.sameProcessing
    };
    const clone = model.clone || (value => value == null ? value : JSON.parse(JSON.stringify(value)));

    function stable(value) {
        if (Array.isArray(value)) return value.map(stable);
        if (value && typeof value === 'object') {
            const result = {};
            for (const key of Object.keys(value).sort()) result[key] = stable(value[key]);
            return result;
        }
        return value;
    }

    function normalizeMeasurementInput(value) {
        if (value == null || value === '') return null;
        const input = Number(value);
        if (!Number.isInteger(input) || input < 1 || input > 8) {
            throw new Error('defaults.measurementInput must be an integer from 1 to 8 (physical IN1..IN8)');
        }
        return input;
    }

    function firstMixerIndex(config) {
        return (config?.pipeline || []).findIndex(item => item?.type === 'Mixer');
    }

    function stepChannels(step) {
        if (Array.isArray(step?.channels)) return step.channels.map(Number).filter(Number.isInteger);
        if (step?.channel != null && Number.isInteger(Number(step.channel))) return [Number(step.channel)];
        return [];
    }

    function firstMixer(config) {
        const index = firstMixerIndex(config);
        const step = index >= 0 ? config.pipeline[index] : null;
        if (!step?.name) throw new Error('Measurement input routing requires a named Mixer stage');
        const mixer = config?.mixers?.[step.name];
        if (!mixer || !Array.isArray(mixer.mapping)) {
            throw new Error(`Measurement input routing cannot edit mixer '${step.name}'`);
        }
        return [step.name, mixer, index];
    }

    function inputChannelCount(config, mixer) {
        const mixerInputs = Number(mixer?.channels?.in);
        if (Number.isInteger(mixerInputs) && mixerInputs > 0) return mixerInputs;
        const captureInputs = Number(config?.devices?.capture?.channels);
        if (Number.isInteger(captureInputs) && captureInputs > 0) return captureInputs;
        throw new Error('Cannot determine the number of CamillaDSP capture inputs');
    }

    function removeInputPreamp(config) {
        if (!config) return config;
        const pipeline = config.pipeline || [];
        for (const step of pipeline) {
            if (step?.type !== 'Filter' || !Array.isArray(step.names)) continue;
            step.names = step.names.filter(name => name !== INPUT_PREAMP_FILTER);
        }
        config.pipeline = pipeline.filter(step =>
            !(step?.type === 'Filter' && step?.description === INPUT_PREAMP_STEP && (!Array.isArray(step.names) || step.names.length === 0))
        );
        if (config.filters) delete config.filters[INPUT_PREAMP_FILTER];
        return config;
    }

    function mirrorSharedInputProcessing(config, sourceChannel, mixerIndex) {
        if (sourceChannel === 0 || sourceChannel === 1 || mixerIndex <= 0) return [];
        const mirrored = [];
        const pipeline = config?.pipeline || [];

        for (let index = 0; index < mixerIndex; index += 1) {
            const step = pipeline[index];
            if (step?.type !== 'Filter' || !Array.isArray(step.names) || !step.names.length) continue;
            const channels = stepChannels(step);

            // Only inherit processing that is explicitly shared by normal L + R.
            // Independent L-only/R-only stages are intentionally not guessed.
            if (!channels.includes(0) || !channels.includes(1)) continue;
            if (!channels.includes(sourceChannel)) {
                step.channels = [...new Set([...channels, sourceChannel])].sort((a, b) => a - b);
                delete step.channel;
            }
            for (const name of step.names) if (!mirrored.includes(name)) mirrored.push(name);
        }
        return mirrored;
    }

    function routeMeasurementInput(config, measurementInput) {
        const physicalInput = normalizeMeasurementInput(measurementInput);
        if (physicalInput == null) return config;

        const [, mixer, mixerIndex] = firstMixer(config);
        const inputCount = inputChannelCount(config, mixer);
        if (physicalInput > inputCount) {
            throw new Error(`IN${physicalInput} is unavailable: the active mixer/capture exposes ${inputCount} inputs`);
        }

        const sourceChannel = physicalInput - 1;
        mirrorSharedInputProcessing(config, sourceChannel, mixerIndex);

        const routedDestinations = new Set();
        for (const mapping of mixer.mapping) {
            const dest = Number(mapping?.dest);
            if (!Number.isInteger(dest) || dest < 0 || dest > 5) continue;

            // Keep the mapping strictly within CamillaDSP's canonical Mixer schema.
            // A Mixer mapping has `dest` + `sources`; way selection is handled by
            // the output Gain filters, not by a mapping-level mute flag.
            mapping.sources = [{
                channel: sourceChannel,
                gain: 0,
                scale: 'dB',
                inverted: false
            }];
            routedDestinations.add(dest);
        }

        const missing = [0, 1, 2, 3, 4, 5].filter(dest => !routedDestinations.has(dest));
        if (missing.length) {
            throw new Error(`Measurement input routing is missing E-Stack mixer destinations ${missing.map(dest => `OUT${dest + 1}`).join(', ')}`);
        }
        return config;
    }

    model.normalizeBatch = function normalizeBatchWithMeasurementInput(input) {
        const normalized = original.normalizeBatch(input);
        const raw = input?.defaults?.measurementInput;
        if (raw != null && raw !== '') {
            if (normalized.defaults.processingMode === 'live-snapshot') {
                throw new Error('Live snapshot keeps the current mixer routing; do not set measurementInput');
            }
            normalized.defaults.measurementInput = normalizeMeasurementInput(raw);
        }
        return normalized;
    };

    model.applyStep = function applyStepWithMeasurementInput(baselineConfig, batchInput, stepOrIndex) {
        const batch = model.normalizeBatch(batchInput);
        const processed = original.applyStep(baselineConfig, batch, stepOrIndex);
        if (batch.defaults.processingMode === 'live-snapshot') return processed;
        // Calibration invariants are applied BEFORE measurement-input mirroring.
        // This guarantees the listening preamp cannot be copied onto IN3/IN4.
        const next = loudnessModel.applyPreset(processed, 'reference');
        removeInputPreamp(next);
        if (batch.defaults.measurementInput != null) {
            routeMeasurementInput(next, batch.defaults.measurementInput);
        }
        return next;
    };

    // Mixer routing is now part of the temporary batch state. Devices are still
    // explicitly excluded so ALSA/capture/playback ownership stays live.
    model.processingOf = function processingWithMixer(config) {
        return {
            filters: clone(config?.filters || {}),
            pipeline: clone(config?.pipeline || []),
            processors: clone(config?.processors || {}),
            mixers: clone(config?.mixers || {})
        };
    };

    model.mergeProcessingIntoLive = function mergeProcessingWithMixer(liveConfig, targetConfig) {
        const next = clone(liveConfig || {});
        const processing = model.processingOf(targetConfig);
        next.filters = processing.filters;
        next.pipeline = processing.pipeline;
        next.processors = processing.processors;
        next.mixers = processing.mixers;
        return next;
    };

    function canonicalSource(source) {
        return {
            channel: Number(source?.channel),
            gain: Number(source?.gain || 0),
            scale: String(source?.scale || 'dB'),
            inverted: !!source?.inverted
        };
    }

    function canonicalMixer(mixer) {
        return {
            channels: {
                in: Number(mixer?.channels?.in),
                out: Number(mixer?.channels?.out)
            },
            mapping: (mixer?.mapping || [])
                .map(mapping => ({
                    dest: Number(mapping?.dest),
                    sources: (mapping?.sources || []).map(canonicalSource)
                }))
                .sort((a, b) => a.dest - b.dest)
        };
    }

    model.sameProcessing = function sameProcessingWithMixer(a, b) {
        const pa = original.processingOf(a);
        const pb = original.processingOf(b);
        if (JSON.stringify(stable(pa)) !== JSON.stringify(stable(pb))) return false;

        const aNames = Object.keys(a?.mixers || {}).sort();
        const bNames = Object.keys(b?.mixers || {}).sort();
        if (JSON.stringify(aNames) !== JSON.stringify(bNames)) return false;
        for (const name of aNames) {
            if (JSON.stringify(stable(canonicalMixer(a.mixers[name]))) !== JSON.stringify(stable(canonicalMixer(b.mixers[name])))) {
                return false;
            }
        }
        return true;
    };

    model.routeMeasurementInput = routeMeasurementInput;
    model.mirrorSharedInputProcessing = mirrorSharedInputProcessing;
    model.removeInputPreamp = removeInputPreamp;
    Object.defineProperty(model, '__measurementInputRoutingInstalled', { value: true });
    return model;
};
