(() => {
  'use strict';

  const numeric = value => value == null || value === '' || typeof value === 'boolean' ? null : Number.isInteger(Number(value)) ? Number(value) : null;
  const LOGICAL_WAY_CHANNELS = Object.freeze([0, 1, 2, 3, 4, 5]);

  // CamillaDSP 4.x uses `channels: [0]`; older saved configurations use
  // `channel: 0`. Product domain services always consume this normalized view.
  function channelsForStep(step) {
    if (Array.isArray(step?.channels)) return [...new Set(step.channels.map(numeric).filter(Number.isInteger))];
    const channel = numeric(step?.channel);
    return channel === null ? [] : [channel];
  }
  function stepHasChannel(step, channel) { return step?.type === 'Filter' && channelsForStep(step).includes(Number(channel)); }
  function firstMixerContext(config) {
    const index = (config?.pipeline || []).findIndex(step => step?.type === 'Mixer');
    if (index < 0) return null;
    const step = config.pipeline[index]; const mixer = config?.mixers?.[step?.name];
    return mixer ? { index, step, mixer } : null;
  }
  function activeOutputChannels(config) {
    const context = firstMixerContext(config);
    const destinations = new Set((context?.mixer?.mapping || []).map(item => numeric(item?.dest)).filter(Number.isInteger));
    if (destinations.size) return [...destinations].sort((a, b) => a - b);
    const playback = Number(config?.devices?.playback?.channels || 0);
    return Array.from({ length: Math.max(0, playback) }, (_, channel) => channel);
  }
  function hardwarePlaybackChannels(config) { return numeric(config?.devices?.playback?.channels); }
  function logicalWayChannels(config) {
    const playback = hardwarePlaybackChannels(config);
    const context = firstMixerContext(config);
    const mixerOut = numeric(context?.mixer?.channels?.out);
    if (!Number.isInteger(playback) || playback < LOGICAL_WAY_CHANNELS.length)
      throw new Error('E-Stack requires at least 6 hardware playback channels.');
    if (!context || !Number.isInteger(mixerOut) || mixerOut !== playback)
      throw new Error(`Mixer output size must match hardware playback channels (${playback}).`);
    if (!Array.isArray(context.mixer.mapping)) throw new Error('Mixer mapping is missing.');
    const destinations = context.mixer.mapping.map(item => numeric(item?.dest));
    if (destinations.some(dest => dest === null || dest < 0 || dest >= mixerOut) || new Set(destinations).size !== destinations.length)
      throw new Error(`Mixer destinations must be unique and within 0..${mixerOut - 1}.`);
    if (LOGICAL_WAY_CHANNELS.some(channel => !destinations.includes(channel)))
      throw new Error('Mixer mapping must include all six E-Stack logical ways (destinations 0..5).');
    return [...LOGICAL_WAY_CHANNELS];
  }
  function directPostMixerFilterSteps(config, channel) {
    const context = firstMixerContext(config); const pipeline = config?.pipeline || [];
    const start = context ? context.index + 1 : 0;
    return pipeline.slice(start).filter(step => stepHasChannel(step, channel));
  }
  function directPostMixerFilterNames(config, channel) {
    return directPostMixerFilterSteps(config, channel).flatMap(step => Array.isArray(step?.names) ? step.names.map(String) : []);
  }
  window.EStackPipeline = Object.freeze({ LOGICAL_WAY_CHANNELS, channelsForStep, stepHasChannel, firstMixerContext, activeOutputChannels, hardwarePlaybackChannels, logicalWayChannels, directPostMixerFilterSteps, directPostMixerFilterNames });
})();
