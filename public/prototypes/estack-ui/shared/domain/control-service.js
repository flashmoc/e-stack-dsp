(() => {
  'use strict';

  const M = window.EStackControlModel;
  if (!M) throw new Error('E-Stack Control model must load before Control service');

  const SAFE_TRANSITION_DB = -60;
  const INPUT_TRIM_MIN_DB = -20;
  const INPUT_TRIM_MAX_DB = 12;
  const INPUT_TRIM_STEP_DB = .5;
  const INPUT_TRIM_RESERVE_DB = 1;
  const HOLD_MS = 4000;
  const NO_SIGNAL_DBFS = -90;
  const listeners = new Set();
  let telemetryTimer = null;
  let state = { config: null, master: null, masterMuted: false, inputPeaks: [], outputPeaks: [], heldPeaks: new Map(), links: loadLinks(), telemetryAt: 0 };

  const emit = () => listeners.forEach(listener => listener(snapshot()));
  const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value)));
  const round = value => Number(Number(value).toFixed(6));
  const clone = M.clone;
  const currentLinks = () => ({ ...state.links });
  const command = (...args) => window.EStackDSPBridge.command(...args);

  function loadLinks() {
    return Object.fromEntries(Object.entries(M.LINK_DEFINITIONS).map(([key, link]) => [key, localStorage.getItem(link.storageKey) !== 'false']));
  }
  function saveLink(key, value) { localStorage.setItem(M.LINK_DEFINITIONS[key].storageKey, String(!!value)); }
  function activeChannels() { return M.activeOutputs(state.config); }
  function linkedChannels(channel) {
    const numeric = Number(channel);
    const link = Object.entries(M.LINK_DEFINITIONS).find(([, item]) => item.channels.includes(numeric));
    return link && state.links[link[0]] ? link[1].channels.filter(item => activeChannels().includes(item)) : [numeric];
  }
  function linkedChannelsForConfig(channel, config) {
    const numeric = Number(channel); const link = Object.entries(M.LINK_DEFINITIONS).find(([, item]) => item.channels.includes(numeric));
    return link && state.links[link[0]] ? link[1].channels.filter(item => M.activeOutputs(config).includes(item)) : [numeric];
  }
  function wayEntries(config = state.config, channels = activeChannels()) {
    if (!config) throw new Error('CamillaDSP configuration is unavailable');
    return channels.map(channel => {
      const entry = M.gainEntryForChannel(config, channel);
      const gain = Number(entry?.filter?.parameters?.gain);
      if (!entry || !Number.isFinite(gain)) throw new Error(`${M.way(channel).name}: no valid per-way Gain filter found`);
      return { channel, name: M.way(channel).name, ...entry, gain, muted: !!entry.filter.parameters?.mute };
    });
  }
  function rememberPeaks(peaks) {
    const now = Date.now();
    activeChannels().forEach(channel => {
      const peak = Number(peaks?.[channel]);
      if (!Number.isFinite(peak)) return;
      const history = state.heldPeaks.get(channel) || [];
      history.push({ at: now, value: peak });
      while (history.length && history[0].at < now - HOLD_MS) history.shift();
      state.heldPeaks.set(channel, history);
    });
  }
  function heldPeak(channel) {
    const values = state.heldPeaks.get(Number(channel)) || [];
    const result = values.reduce((max, item) => Math.max(max, item.value), -Infinity);
    return Number.isFinite(result) ? result : null;
  }
  function headroom() {
    if (!state.config) return [];
    return activeChannels().map(channel => {
      const peak = heldPeak(channel); const hard = M.hardLimitForChannel(state.config, channel); const protection = M.protectionForChannel(state.config, channel); const gain = M.gainEntryForChannel(state.config, channel);
      const muted = !!gain?.filter?.parameters?.mute;
      const hasSignal = !muted && !state.masterMuted && Number.isFinite(peak) && peak > NO_SIGNAL_DBFS;
      const hardMargin = hasSignal && hard ? hard.clip - peak : null;
      const protectionMargin = hasSignal ? (protection?.threshold ?? hard?.clip ?? null) - peak : null;
      const limitVrms = M.CALIBRATED_LIMIT_VRMS[channel];
      const estimateVrms = Number.isFinite(hardMargin) && Number.isFinite(limitVrms) ? Math.min(limitVrms, limitVrms * Math.pow(10, -Math.max(0, hardMargin) / 20)) : null;
      return { channel, name: M.way(channel).name, peak, hasSignal, muted, hardThreshold: hard?.clip ?? null, protectionThreshold: protection?.threshold ?? hard?.clip ?? null, hardMargin, protectionMargin, limitVrms, estimateVrms };
    });
  }
  function systemHeadroom() {
    const candidates = headroom().filter(item => !item.muted && Number.isFinite(item.hardMargin));
    return candidates.sort((a, b) => a.hardMargin - b.hardMargin)[0] || null;
  }
  function snapshot() {
    const ways = state.config ? wayEntries().map(entry => ({ channel: entry.channel, ...M.way(entry.channel), gain: entry.gain, muted: entry.muted })) : [];
    return { config: clone(state.config), master: state.master, masterMuted: state.masterMuted, ways, inputPeaks: [...state.inputPeaks], outputPeaks: [...state.outputPeaks], links: currentLinks(), trim: M.inputTrimValue(state.config), headroom: headroom(), system: systemHeadroom(), telemetryAt: state.telemetryAt };
  }
  async function refresh() {
    const [config, master, muted] = await Promise.all([command('GetConfigJson'), command('GetVolume'), command('GetMute')]);
    state.config = config; state.master = Number(master); state.masterMuted = muted === true; emit(); return snapshot();
  }
  async function setMasterMute(muted) {
    await command({ SetMute: !!muted });
    const actual = await command('GetMute');
    if (actual !== !!muted) throw new Error('Master mute readback did not match.');
    state.masterMuted = actual; state.heldPeaks.clear(); emit(); return snapshot();
  }
  async function telemetry() {
    const [inputPeaks, outputPeaks] = await Promise.all([command('GetCaptureSignalPeak'), command('GetPlaybackSignalPeak')]);
    state.inputPeaks = Array.isArray(inputPeaks) ? inputPeaks.map(Number) : [];
    state.outputPeaks = Array.isArray(outputPeaks) ? outputPeaks.map(Number) : [];
    rememberPeaks(state.outputPeaks); state.telemetryAt = Date.now(); emit(); return snapshot();
  }
  async function startTelemetry(intervalMs = 120) {
    await refresh(); await telemetry();
    if (telemetryTimer) clearInterval(telemetryTimer);
    telemetryTimer = setInterval(() => telemetry().catch(() => {}), intervalMs);
    return snapshot();
  }
  function stopTelemetry() { if (telemetryTimer) clearInterval(telemetryTimer); telemetryTimer = null; }
  async function setMaster(value) { const next = Math.round(clamp(value, -60, 0) / .5) * .5; await command({ SetVolume: next }); state.master = next; state.heldPeaks.clear(); emit(); return next; }
  function setLink(key, value) { if (!M.LINK_DEFINITIONS[key]) throw new Error('Unknown linked pair'); state.links[key] = !!value; saveLink(key, value); emit(); }

  async function mutateWay(channel, change, targetChannels = null, verify = null) {
    const before = await command('GetConfigJson');
    const targets = (targetChannels || linkedChannelsForConfig(channel, before)).map(item => ({ channel: item, ...M.gainEntryForChannel(before, item) }));
    if (targets.some(item => !item.name || item.filter?.type !== 'Gain')) throw new Error('Expected per-way Gain filter is unavailable');
    const next = clone(before);
    for (const target of targets) {
      const filter = next.filters[target.name]; filter.parameters = filter.parameters || {};
      change(filter.parameters, target.channel);
    }
    (verify || M.assertOnlyWayGainChanged)(before, next, targets);
    await command({ SetConfigJson: JSON.stringify(next) });
    const verified = await command('GetConfigJson');
    (verify || M.assertOnlyWayGainChanged)(before, verified, targets);
    for (const target of targets) {
      const actual = M.gainEntryForChannel(verified, target.channel);
      if (!actual || actual.name !== target.name) throw new Error(`${M.way(target.channel).name}: Gain filter changed unexpectedly`);
    }
    state.config = verified; state.heldPeaks.clear(); emit(); return snapshot();
  }
  function setWayGain(channel, value) {
    const target = clamp(value, -60, 6);
    return mutateWay(channel, parameters => { parameters.gain = target; });
  }
  function setWayMute(channel, muted) {
    const target = !!muted;
    return mutateWay(channel, parameters => { parameters.mute = target; }, null,
      (before, after, targets) => M.assertOnlyWayMuteChanged(before, after, targets, target));
  }
  async function measurementBatchActive() { try { return !!(await window.EStackDSPBridge.api('/api/measurement-batch/status')).active; } catch (_) { return false; } }
  function signalGeneratorActive(config = state.config) { return config?.devices?.capture?.type === 'SignalGenerator'; }
  function clampTrim(value) { return Math.max(INPUT_TRIM_MIN_DB, Math.min(INPUT_TRIM_MAX_DB, Math.round(Number(value) / INPUT_TRIM_STEP_DB) * INPUT_TRIM_STEP_DB)); }
  function availableInputTrim() {
    const system = systemHeadroom(); const current = M.inputTrimValue(state.config);
    if (!system || !Number.isFinite(system.hardMargin)) return null;
    return Math.max(0, Math.floor((Math.min(INPUT_TRIM_MAX_DB - current, system.hardMargin - INPUT_TRIM_RESERVE_DB) + 1e-9) / INPUT_TRIM_STEP_DB) * INPUT_TRIM_STEP_DB);
  }
  async function withSafeMaster(operation) {
    const original = Number(await command('GetVolume')); const safe = Number.isFinite(original) ? Math.min(original, SAFE_TRANSITION_DB) : SAFE_TRANSITION_DB;
    if (Number.isFinite(original)) await command({ SetVolume: safe });
    let restored = false;
    try { const result = await operation(); if (Number.isFinite(original)) { await command({ SetVolume: original }); restored = true; } return result; }
    finally { if (!restored && Number.isFinite(original)) try { await command({ SetVolume: original }); } catch (_) {} }
  }
  async function setInputTrim(value) {
    const target = clampTrim(value);
    if (await measurementBatchActive()) throw new Error('Finish or abort Measurement Batch before changing Input Trim');
    const before = await command('GetConfigJson');
    if (signalGeneratorActive(before)) throw new Error('Stop Signal Generator before changing Input Trim');
    return withSafeMaster(async () => {
      const next = M.installInputTrim(clone(before), target);
      M.assertOnlyInputTrimChanged(before, next);
      await command({ SetConfigJson: JSON.stringify(next) });
      const verified = await command('GetConfigJson');
      M.assertOnlyInputTrimChanged(before, verified);
      if (Math.abs(M.inputTrimValue(verified) - target) > .02) throw new Error(`Input Trim verification failed: requested ${target.toFixed(1)} dB`);
      state.config = verified; state.heldPeaks.clear(); emit(); return snapshot();
    });
  }
  async function normalizeWays() {
    if (await measurementBatchActive()) throw new Error('Finish or abort Measurement Batch before normalizing output gains');
    const before = await command('GetConfigJson');
    if (signalGeneratorActive(before)) throw new Error('Stop Signal Generator before normalizing output gains');
    const entries = wayEntries(before, M.activeOutputs(before)); const highest = Math.max(...entries.map(entry => entry.gain)); const shift = round(-highest);
    if (Math.abs(shift) <= .005) { state.config = before; emit(); return { ...snapshot(), shift: 0 }; }
    return withSafeMaster(async () => {
      const next = clone(before); const targets = entries.map(entry => ({ channel: entry.channel, name: entry.name, filter: entry.filter }));
      for (const entry of entries) next.filters[entry.name].parameters.gain = round(entry.gain + shift);
      M.assertOnlyWayGainChanged(before, next, targets);
      await command({ SetConfigJson: JSON.stringify(next) });
      const verified = await command('GetConfigJson'); M.assertOnlyWayGainChanged(before, verified, targets);
      const checked = wayEntries(verified, M.activeOutputs(verified)); const highestVerified = Math.max(...checked.map(entry => entry.gain));
      if (Math.abs(highestVerified) > .01) throw new Error(`Normalization verification failed: highest way is ${highestVerified.toFixed(3)} dB`);
      entries.forEach(entry => { const after = checked.find(item => item.channel === entry.channel); if (!after || Math.abs((after.gain - entry.gain) - shift) > .01) throw new Error(`${entry.name}: relative gain shift was not preserved`); });
      state.config = verified; state.heldPeaks.clear(); emit(); return { ...snapshot(), shift };
    });
  }

  window.EStackControlService = Object.freeze({ refresh, telemetry, startTelemetry, stopTelemetry, snapshot, setMaster, setMasterMute, setLink, setWayGain, setWayMute, setInputTrim, availableInputTrim, normalizeWays, subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); } });
})();
