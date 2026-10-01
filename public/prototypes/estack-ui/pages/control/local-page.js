(() => {
  'use strict';
  document.documentElement.dataset.prototypePage = 'control-local';
  const fixture = window.EStackPageFixtures;
  const spectrumFrequencies = [25,30,40,50,63,80,100,125,160,200,250,315,400,500,630,800,1000,1250,1600,2000,2500,3150,4000,5000,6300,8000,10000,12500,16000,20000];
  const $ = selector => document.querySelector(selector);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
  const meter = value => `${clamp((value + 60) / 60 * 100, 2, 100)}%`;
  const faderPresentation = window.EStackControlFaderPresentation;
  if (!faderPresentation) throw new Error('E-Stack fader presentation is unavailable');
  const { positionClass: faderPositionClass, valueAtPosition: faderValueAtPosition } = faderPresentation;
  const meterScale = [-60, -48, -36, -24, -12, 0];
  const limiterThresholds = [-1.5, -3, -4.5, -4.5, -6, -6];
  const numberOr = (value, fallback) => Number.isFinite(value) ? value : fallback;
  const newState = (saved = window.EStackPrototypeDSP?.snapshot?.().control || {}) => ({
    master: numberOr(saved.master, -12), inputTrim: numberOr(saved.inputTrim, 0), muted: !!saved.muted, locked: !!saved.locked, normalizeBlocked: false, dragging: false, tick: 0,
    links: { mid: saved.links?.mid !== false, high: saved.links?.high !== false },
    outputs: fixture.outputs.map(item => {
      const savedOutput = saved.outputs?.[item.id] || {};
      return { ...item, gain: numberOr(savedOutput.gain, item.gain), meterReferenceGain: item.gain, muted: !!savedOutput.muted };
    })
  });
  let state = newState();
  let mixerFrame = 0;
  const scheduleMixer = () => {
    if (mixerFrame) return;
    mixerFrame = window.requestAnimationFrame(() => { mixerFrame = 0; mixer(); });
  };
  const rawOutputLevel = (item, index) => item.level + state.master + state.inputTrim + (item.gain - item.meterReferenceGain) + Math.sin(state.tick * 1.14 + index * 1.77) * 4.4 + Math.sin(state.tick * 2.87 + index) * 1.7;
  // The displayed meter is post-limiter. The protection indicator reports if
  // the pre-limiter peak is exceeding the protected ceiling.
  const outputLevel = (item, index) => clamp(rawOutputLevel(item, index), -60, limiterThresholds[index]);
  const outputPeakCeiling = item => item.level + state.master + state.inputTrim + (item.gain - item.meterReferenceGain) + 6.1;
  const inputLevel = (item, index) => item.level + Math.sin(state.tick * 1.34 + index * 1.91) * 5.1 + Math.sin(state.tick * 3.7 + index) * 1.8;
  const protectionFor = (item, index) => {
    const peak = outputPeakCeiling(item); const clip = limiterThresholds[index];
    const margin = clip - peak;
    return { margin, attenuation: Math.max(0, -margin), state: margin <= 0 ? 'hard' : margin < 3 ? 'compress' : 'safe' };
  };
  function publishShellStatus(systemState, margin) {
    if (window.parent === window) return;
    window.parent.postMessage({ type: 'estack-control-status', master: state.master, headroom: Math.max(0, margin), condition: systemState }, window.location.origin);
  }
  function persistControl(reason) {
    const adapter = window.EStackPrototypeDSP;
    if (!adapter) return;
    const active = state.outputs.map((item, index) => protectionFor(item, index)).sort((a, b) => a.margin - b.margin)[0];
    adapter.apply(config => {
      config.volume = state.master;
      config.control = {
        master: state.master, inputTrim: state.inputTrim, muted: state.muted, locked: state.locked, links: { ...state.links },
        outputs: Object.fromEntries(state.outputs.map(item => [item.id, { gain: item.gain, muted: item.muted }]))
      };
      config.processors.ESTACK_LIMITER = { enabled: true, ceiling: Math.min(...limiterThresholds), state: active?.state || 'safe', margin: active?.margin ?? 0 };
    }, reason);
  }

  function inputMeters() {
    $('#inputMeters').innerHTML = fixture.inputs.map((input, index) => `<article class="input-meter" data-input-meter="${index}"><header><strong>${input.name}</strong><span>IN ${index + 1}</span></header><output data-input-readout="${index}"></output><div class="horizontal-meter"><i data-input-fill="${index}"></i><b data-input-peak="${index}"></b><span>−60</span><span>0</span></div></article>`).join('');
    paintInputMeters();
  }
  function paintInputMeters() {
    fixture.inputs.forEach((input, index) => {
      const level = inputLevel(input, index);
      const readout = document.querySelector(`[data-input-readout="${index}"]`);
      const fill = document.querySelector(`[data-input-fill="${index}"]`);
      const peak = document.querySelector(`[data-input-peak="${index}"]`);
      if (readout) readout.textContent = `${level.toFixed(1).replace('-', '−')} dBFS`;
      if (fill) fill.style.width = meter(level);
      if (peak) peak.style.left = meter(level + 1.8);
    });
  }
  function availableInputTrim() {
    const margins = state.outputs.map((item, index) => item.muted ? Infinity : limiterThresholds[index] - outputPeakCeiling(item));
    const protectionMargin = margins.length ? Math.min(...margins) : 0;
    const reserved = protectionMargin - 1;
    return Math.max(0, Math.min(12 - state.inputTrim, Math.floor((reserved + 1e-9) / .5) * .5));
  }
  const protectionContent = protection => `<span class="limiter-chip">${protection.state === 'hard' ? 'HARD LIMIT' : protection.state === 'compress' ? 'NEAR LIMIT' : 'SAFE'}</span><strong>${protection.state === 'hard' ? `−${protection.attenuation.toFixed(1)} dB` : `+${protection.margin.toFixed(1)} dB`}</strong>`;
  function paintProtectionIndicators() {
    state.outputs.forEach((item, index) => {
      const protection = protectionFor(item, index);
      const card = document.querySelector(`[data-protection-card="${index}"]`);
      const indicator = document.querySelector(`[data-protection-indicator="${index}"]`);
      if (card) card.dataset.protection = protection.state;
      if (indicator) { indicator.dataset.state = protection.state; indicator.innerHTML = protectionContent(protection); }
    });
  }
  function renderInputTrim() {
    const root = $('#inputTrim'); if (!root) return;
    const safe = availableInputTrim();
    root.dataset.active = String(Math.abs(state.inputTrim) > .01);
    root.dataset.state = safe < 1 ? 'near' : 'safe';
    const range = $('#inputTrimRange'); const value = $('#inputTrimValue'); const available = $('#inputTrimAvailable'); const use = $('#inputTrimUse');
    if (range) range.value = String(state.inputTrim);
    if (value) value.textContent = `${state.inputTrim > 0 ? '+' : ''}${state.inputTrim.toFixed(1)} dB`;
    if (available) available.textContent = safe >= .5 ? `+${safe.toFixed(1)} dB` : 'HOLD';
    if (use) use.disabled = safe < .5;
  }
  function setInputTrim(raw, preview = false) {
    state.inputTrim = Number(clamp(Math.round(Number(raw || 0) / .5) * .5, -20, 12).toFixed(1));
    state.normalizeBlocked = false;
    renderInputTrim();
    renderProtectionSummary();
    paintProtectionIndicators();
    paintMixerMeters();
    if (!preview) persistControl('input trim');
    scheduleMixer();
  }
  function bindInputTrim() {
    $('#inputTrimDown').addEventListener('click', () => setInputTrim(state.inputTrim - .5));
    $('#inputTrimUp').addEventListener('click', () => setInputTrim(state.inputTrim + .5));
    $('#inputTrimRange').addEventListener('input', event => setInputTrim(event.target.value, true));
    $('#inputTrimRange').addEventListener('change', event => setInputTrim(event.target.value));
    $('#inputTrimUse').addEventListener('click', () => setInputTrim(state.inputTrim + availableInputTrim()));
  }
  function strip(item, index, master = false) {
    const value = master ? state.master : item.gain;
    const faderStep = master ? '.5' : '.1';
    const displayValue = Number(value).toFixed(1);
    const level = master ? Math.max(...state.outputs.map((output, itemIndex) => output.muted ? -60 : outputLevel(output, itemIndex)), -60) : outputLevel(item, index);
    const isMuted = master ? state.muted : item.muted;
    const color = master ? 'var(--color-accent)' : item.color;
    const levelPercent = Number(meter(isMuted ? -60 : level).replace('%', ''));
    const peakPercent = Number(meter(isMuted ? -60 : level + 1.6).replace('%', ''));
    const protection = master ? null : protectionFor(item, index);
    const wayClass = master ? ' way-master' : ` way-${item.name.toLowerCase().replace(/\s+/g, '-')}`;
    const pair = !master && index >= 2 && index < 6 ? (index < 4 ? 'mid' : 'high') : null;
    const pairLabel = pair === 'mid' ? 'MID L/R' : 'HIGH L/R';
    const link = pair ? `<button class="strip-pair-link" data-link-toggle="${pair}" type="button" aria-pressed="${state.links[pair]}" aria-label="${pairLabel} processing link, ${state.links[pair] ? 'linked' : 'free'}" title="Links gain and mute for ${pairLabel}">${state.links[pair] ? 'LINKED' : 'FREE'}</button>` : '';
    return `<article class="mixer-strip${master ? ' master-strip' : ''}${isMuted ? ' is-muted' : ''}${wayClass}" ${protection ? `data-protection="${protection.state}" data-protection-card="${index}"` : ''} style="--way:${color}">
      <header><div><strong>${master ? 'MASTER' : item.name}</strong>${link}<span>${master ? '0 dB LIMIT' : `OUT ${index + 1} · POST LIMIT`}</span></div><output data-meter-readout="${master ? 'master' : index}">${isMuted ? '−∞' : master ? `${displayValue.replace('-', '−')} dB` : `${level.toFixed(1).replace('-', '−')} dBFS`}</output></header>
      <div class="legacy-meter-console"><div class="legacy-dbfs-scale">${meterScale.map(mark => `<span style="top:${100 - (mark + 60) / 60 * 100}%">${mark}</span>`).join('')}</div><div class="legacy-meter-core" data-fader-core="${master ? 'master' : index}" role="slider" tabindex="${(!master && state.locked) ? '-1' : '0'}" aria-label="${master ? 'Master level' : `${item.name} gain`}" aria-valuemin="${master ? -50 : -60}" aria-valuemax="${master ? 0 : 6}" aria-valuenow="${value}"><div class="legacy-meter-track"><i class="legacy-meter-fill" data-meter-fill="${master ? 'master' : index}" style="height:${levelPercent}%"></i><b class="legacy-meter-peak" data-meter-peak="${master ? 'master' : index}" style="bottom:${peakPercent}%"></b></div><div class="legacy-gain-rail"></div><input class="mixer-fader legacy-fader-input" data-fader="${master ? 'master' : index}" type="range" min="${master ? -50 : -60}" max="${master ? 0 : 6}" step="${faderStep}" value="${value}" ${(!master && state.locked) ? 'disabled' : ''}><div class="legacy-fader-handle ${faderPositionClass(value, master ? -50 : -60, master ? 0 : 6)}"></div><div class="legacy-gain-scale">${(master ? [0,-12,-24,-36,-48] : [6,0,-12,-30,-60]).map(mark => `<span class="gain-tick ${mark === 0 ? 'unity' : ''} ${faderPositionClass(mark, master ? -50 : -60, master ? 0 : 6)}">${mark > 0 ? `+${mark}` : mark}</span>`).join('')}</div></div></div>
      <div class="strip-value"><input class="ui-number" data-number="${master ? 'master' : index}" type="number" min="${master ? -50 : -60}" max="${master ? 0 : 6}" step="${faderStep}" value="${displayValue}" ${(!master && state.locked) ? 'disabled' : ''}><span>dB</span></div>
      <div class="nudge-row"><button data-nudge="${master ? 'master' : index}" data-delta="-1" type="button" ${(!master && state.locked) ? 'disabled' : ''}>−1</button><button data-nudge="${master ? 'master' : index}" data-delta="${master ? '-.5' : '-.2'}" type="button" ${(!master && state.locked) ? 'disabled' : ''}>${master ? '−0.5' : '−0.2'}</button><button data-nudge="${master ? 'master' : index}" data-delta="${master ? '.5' : '.2'}" type="button" ${(!master && state.locked) ? 'disabled' : ''}>${master ? '+0.5' : '+0.2'}</button><button data-nudge="${master ? 'master' : index}" data-delta="1" type="button" ${(!master && state.locked) ? 'disabled' : ''}>+1</button></div>
      ${master ? '<div class="strip-protection master-protection"><strong>LIMITERS ARMED</strong></div>' : `<div class="strip-protection" data-state="${protection.state}" data-protection-indicator="${index}">${protectionContent(protection)}</div>`}
      <button class="mute-button" data-mute="${master ? 'master' : index}" type="button" aria-pressed="${isMuted}">${isMuted ? 'MUTED' : 'MUTE'}</button>
    </article>`;
  }
  function linkedPair(key, leftIndex, rightIndex) {
    const label = key === 'mid' ? 'MID L/R' : 'HIGH L/R';
    return `<section class="channel-pair channel-pair-${key}" aria-label="${label} stereo pair">${strip(state.outputs[leftIndex], leftIndex)}${strip(state.outputs[rightIndex], rightIndex)}</section>`;
  }
  function mixer() {
    $('#controlMixer').innerHTML = `<div class="console-bank">${strip(null, 0, true)}${strip(state.outputs[0], 0)}${strip(state.outputs[1], 1)}${linkedPair('mid', 2, 3)}${linkedPair('high', 4, 5)}</div>`;
    document.querySelectorAll('[data-fader]').forEach(input => {
      input.addEventListener('input', event => setGain(event.target.dataset.fader, event.target.value, true));
      input.addEventListener('change', event => setGain(event.target.dataset.fader, event.target.value));
    });
    document.querySelectorAll('[data-fader-core]').forEach(core => attachFaderPointer(core));
    document.querySelectorAll('[data-number]').forEach(input => input.addEventListener('change', event => setGain(event.target.dataset.number, event.target.value)));
    document.querySelectorAll('[data-nudge]').forEach(button => button.addEventListener('click', () => { const key = button.dataset.nudge; const current = key === 'master' ? state.master : state.outputs[Number(key)].gain; setGain(key, current + Number(button.dataset.delta)); }));
    document.querySelectorAll('[data-link-toggle]').forEach(button => button.addEventListener('click', () => toggleLink(button.dataset.linkToggle)));
    document.querySelectorAll('[data-normalize]').forEach(button => button.addEventListener('click', normalize));
    document.querySelectorAll('[data-mute]').forEach(button => button.addEventListener('click', () => { const key = button.dataset.mute; if (key === 'master') state.muted = !state.muted; else { const output = state.outputs[Number(key)]; const muted = !output.muted; output.muted = muted; if (output.link && state.links[output.link]) state.outputs.filter(item => item !== output && item.link === output.link).forEach(item => { item.muted = muted; }); } persistControl('output mute'); mixer(); }));
    renderProtectionSummary();
    renderInputTrim();
  }
  function paintMixerMeters() {
    const levels = state.outputs.map((item, index) => outputLevel(item, index));
    const masterLevel = Math.max(...state.outputs.map((item, index) => item.muted ? -60 : levels[index]), -60);
    const paint = (key, level, muted, readout) => {
      const fill = document.querySelector(`[data-meter-fill="${key}"]`);
      const peak = document.querySelector(`[data-meter-peak="${key}"]`);
      const output = document.querySelector(`[data-meter-readout="${key}"]`);
      const visualLevel = muted ? -60 : level;
      if (fill) fill.style.height = meter(visualLevel);
      if (peak) peak.style.bottom = meter(visualLevel + 1.6);
      if (output) output.textContent = muted ? '−∞' : readout(visualLevel);
    };
    paint('master', masterLevel, state.muted, () => `${state.master.toFixed(1).replace('-', '−')} dB`);
    state.outputs.forEach((item, index) => paint(index, levels[index], item.muted, value => `${value.toFixed(1).replace('-', '−')} dBFS`));
  }
  function attachFaderPointer(core) {
    const key = core.dataset.faderCore;
    const fader = core.querySelector('[data-fader]');
    if (!fader || fader.disabled) return;
    const valueAt = clientY => {
      const bounds = core.getBoundingClientRect();
      const min = Number(fader.min), max = Number(fader.max), step = Number(fader.step) || .1;
      return Math.round(faderValueAtPosition((clientY - bounds.top) / bounds.height * 100, min, max) / step) * step;
    };
    let pointerId = null;
    const preview = clientY => {
      const next = valueAt(clientY);
      fader.value = String(next);
      setGain(key, next, true);
      core.setAttribute('aria-valuenow', String(next));
      const handle = core.querySelector('.legacy-fader-handle');
      if (handle) handle.className = `legacy-fader-handle ${faderPositionClass(next, Number(fader.min), Number(fader.max))}`;
    };
    const release = event => {
      if (event.pointerId !== pointerId) return;
      event.preventDefault();
      const next = valueAt(event.clientY);
      state.dragging = false;
      setGain(key, next);
      try { core.releasePointerCapture?.(pointerId); } catch (_) {}
      pointerId = null;
    };
    core.addEventListener('pointerdown', event => {
      if (event.button > 0) return;
      event.preventDefault(); pointerId = event.pointerId; state.dragging = true; core.setPointerCapture?.(pointerId); core.focus({ preventScroll:true }); preview(event.clientY);
    });
    core.addEventListener('pointermove', event => { if (event.pointerId === pointerId) { event.preventDefault(); preview(event.clientY); } });
    core.addEventListener('pointerup', release);
    core.addEventListener('pointercancel', event => { if (event.pointerId === pointerId) { state.dragging = false; try { core.releasePointerCapture?.(pointerId); } catch (_) {} pointerId = null; } });
    core.addEventListener('keydown', event => {
      const keyboardStep = Number(fader.step) || .1;
      const increments={ArrowUp:keyboardStep,ArrowRight:keyboardStep,ArrowDown:-keyboardStep,ArrowLeft:-keyboardStep,PageUp:1,PageDown:-1};
      if (!(event.key in increments)) return; event.preventDefault(); const next=Number(fader.value)+increments[event.key]; setGain(key,next,true); core.setAttribute('aria-valuenow', String(next));
    });
    core.addEventListener('keyup', event => { if (['ArrowUp','ArrowRight','ArrowDown','ArrowLeft','PageUp','PageDown'].includes(event.key)) setGain(key,fader.value); });
  }
  function renderProtectionSummary() {
    const active = state.outputs.map((item, index) => ({ item, ...protectionFor(item, index) })).filter(entry => !entry.item.muted).sort((a, b) => a.margin - b.margin)[0];
    const name = active?.item.name || '—';
    const margin = active?.margin ?? 0;
    const load = Math.round(clamp((12 - margin) / 12 * 100, 0, 100));
    const systemState = margin <= 0 ? 'hard' : margin < 3 ? 'compress' : 'normal';
    publishShellStatus(systemState, margin);
    $('#protectionSummary').dataset.state = systemState;
    const normalizeLabel = state.normalizeBlocked ? 'MAX 0 BLOCKED' : 'MAX 0 dB';
    const normalizeTitle = state.normalizeBlocked ? 'Blocked: this would put at least one output into hard limit' : 'Set the loudest output to 0 dB';
    $('#protectionSummary').innerHTML = `<div><span>SYSTEM</span><strong>${systemState === 'hard' ? 'HARD LIMIT' : systemState === 'compress' ? 'COMPRESSING' : 'NORMAL'}</strong></div><div><span>HEADROOM</span><strong>${Math.max(0, margin).toFixed(1)} dB</strong></div><div class="protection-load"><span>LIMIT LOAD</span><i><b style="width:${load}%"></b></i><strong>${load}%</strong></div><div><span>ACTIVE WAY</span><strong>${name}</strong></div><button class="normalize-ways${state.normalizeBlocked ? ' is-blocked' : ''}" data-normalize type="button" title="${normalizeTitle}"><i class="normalize-icon" aria-hidden="true">⇡</i><span>${normalizeLabel}</span></button><button class="level-lock${state.locked ? ' is-locked' : ''}" data-level-lock type="button" aria-pressed="${state.locked}" aria-label="${state.locked ? 'Unlock output ways' : 'Lock output ways'}"><i class="lock-icon" aria-hidden="true"></i><span>${state.locked ? 'LOCKED' : 'UNLOCKED'}</span></button>`;
    const lock = $('[data-level-lock]');
    if (lock) lock.addEventListener('click', () => { state.locked = !state.locked; mixer(); });
    const normalizeButton = $('[data-normalize]');
    if (normalizeButton) normalizeButton.addEventListener('click', normalize);
  }
  function setGain(key, raw, preview = false) {
    const master = key === 'master'; const min = master ? -50 : -60; const max = master ? 0 : 6; const step = master ? .5 : .1; const next = Number((Math.round(clamp(raw, min, max) / step) * step).toFixed(1));
    if (master) state.master = next;
    else { const output = state.outputs[Number(key)]; output.gain = next; if (output.link && state.links[output.link]) state.outputs.filter(item => item !== output && item.link === output.link).forEach(item => { item.gain = next; }); }
    state.normalizeBlocked = false;
    renderInputTrim();
    renderProtectionSummary();
    paintProtectionIndicators();
    if (preview) {
      document.querySelectorAll('[data-fader],[data-number]').forEach(control => {
        const controlKey = control.dataset.fader ?? control.dataset.number;
        if (controlKey === 'master') { if (master) control.value = control.dataset.number !== undefined ? next.toFixed(1) : String(next); return; }
        const gain = state.outputs[Number(controlKey)]?.gain;
        if (Number.isFinite(gain)) control.value = control.dataset.number !== undefined ? gain.toFixed(1) : String(gain);
      });
      document.querySelectorAll('[data-fader-core]').forEach(core => {
        const fader = core.querySelector('[data-fader]');
        const handle = core.querySelector('.legacy-fader-handle');
        if (!fader || !handle) return;
        handle.className = `legacy-fader-handle ${faderPositionClass(Number(fader.value), Number(fader.min), Number(fader.max))}`;
        core.setAttribute('aria-valuenow', fader.value);
      });
      return;
    }
    persistControl(master ? 'master gain' : 'output gain');
    scheduleMixer();
  }
  function normalize() {
    const highest = Math.max(...state.outputs.map(item => item.gain));
    const shift = -highest;
    // Keep a 1 dB reserve below every hard-limit threshold. A normalisation
    // may lower outputs freely, but it may never raise them into limiting.
    const safeLift = Math.min(...state.outputs.map((item, index) => limiterThresholds[index] - outputPeakCeiling(item) - 1));
    if (shift > 0 && shift > safeLift + 1e-9) {
      state.normalizeBlocked = true;
      renderProtectionSummary();
      return;
    }
    state.normalizeBlocked = false;
    state.outputs.forEach(item => { item.gain = clamp(item.gain + shift, -60, 6); });
    persistControl('normalise output gains');
    mixer();
  }
  function drawScope() { const canvas = $('#inputScope'); if (!$('#analyzerToggle').checked) { canvas.hidden = true; return; } canvas.hidden = false; const ctx = canvas.getContext('2d'), { width, height } = canvas; ctx.clearRect(0, 0, width, height); const top = 18, bottom = 5, gap = Math.max(2, Math.min(4, width / 360)), bar = Math.max(4, (width - gap * (spectrumFrequencies.length - 1) - 4) / spectrumFrequencies.length), segment = 4, segmentGap = 2, count = Math.floor((height - top - bottom) / (segment + segmentGap)); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `${Math.max(6, Math.min(8, bar * .32))}px sans-serif`; spectrumFrequencies.forEach((frequency, index) => { const x = 2 + index * (bar + gap); const wave = -65 + 25 * Math.exp(-Math.pow((index - 8) / 8, 2)) + 14 * Math.exp(-Math.pow((index - 20) / 5, 2)) + Math.sin(state.tick * .5 + index * .76) * 5; const active = Math.max(0, Math.min(count, Math.round((wave + 80) / 80 * count))); if (bar >= 13 || index % 2 === 0) { ctx.fillStyle = 'rgba(235,244,246,.40)'; ctx.fillText(frequency >= 1000 ? `${frequency / 1000}k` : frequency, x + bar / 2, 7); } for (let part = 0; part < count; part += 1) { const y = height - bottom - segment - part * (segment + segmentGap); ctx.fillStyle = part < active ? `hsl(${214 - 164 * part / count},${58 + 24 * part / count}%,${55 + 5 * part / count}%)` : 'rgba(8,18,26,.82)'; ctx.fillRect(x, y, bar, segment); } }); }
  function toggleLink(key) { state.links[key] = !state.links[key]; persistControl('output link'); scheduleMixer(); }
  function renderAll() { inputMeters(); mixer(); renderInputTrim(); drawScope(); }
  renderAll();
  bindInputTrim();
  $('#analyzerToggle').addEventListener('change', drawScope);
  let controlStateHydrated = false;
  window.EStackPrototypeDSP?.subscribe(config => {
    if (controlStateHydrated || !config.control) return;
    state = newState(config.control);
    controlStateHydrated = true;
    renderAll();
  });
  window.EStackControlMock = Object.freeze({ snapshot: () => JSON.parse(JSON.stringify(state)), reset: () => { state = newState(); renderAll(); } });
  let previousFrame = performance.now();
  function animate(now) {
    state.tick += Math.min((now - previousFrame) / 1000, .05) * 1.05;
    previousFrame = now;
    paintInputMeters();
    paintMixerMeters();
    drawScope();
    window.requestAnimationFrame(animate);
  }
  window.requestAnimationFrame(animate);
})();
