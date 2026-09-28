(() => {
  'use strict';
  const { B, $, post, note } = window.EStackSurface;
  const clone = value => JSON.parse(JSON.stringify(value));
  let config, revision, kind = 'pipeline', selected = '', dirty = false, busy = false, draft;
  let pathSelection = matchMedia('(max-width: 700px)').matches ? '0' : 'all';
  const wayNames = ['SUB', 'KICK', 'MID L', 'MID R', 'HIGH L', 'HIGH R'];
  const wayName = channel => wayNames[channel] || `OUT ${channel + 1}`;
  const types = {
    Gain: { gain: 0, inverted: false, mute: false, scale: 'dB' },
    Volume: { ramp_time: 400, fader: 'Aux1' },
    Loudness: { fader: 'Main', reference_level: -25, high_boost: 10, low_boost: 10, attenuate_mid: false },
    Delay: { delay: 0, unit: 'ms', subsample: false },
    Conv: { type: 'Values', values: [1] },
    Biquad: { type: 'Peaking', freq: 1000, gain: 0, q: 1 },
    BiquadCombo: { type: 'LinkwitzRileyHighpass', freq: 1000, order: 4 },
    Dither: { type: 'None', bits: 16 },
    Limiter: { clip_limit: -6, soft_clip: false },
  };
  const biquads = {
    Peaking: { freq: 1000, gain: 0, q: 1 }, Lowshelf: { freq: 100, gain: 0, q: .7 }, Highshelf: { freq: 10000, gain: 0, q: .7 },
    Highpass: { freq: 100, q: .7 }, Lowpass: { freq: 10000, q: .7 }, Bandpass: { freq: 1000, q: 1 }, Allpass: { freq: 1000, q: 1 },
    Free: { a1: 0, a2: 0, b0: 1, b1: 0, b2: 0 }, LinkwitzTransform: { freq_act: 50, q_act: .7, freq_target: 30, q_target: .7 },
    HighpassFO: { freq: 100 }, LowpassFO: { freq: 10000 }, AllpassFO: { freq: 1000 }, Notch: { freq: 1000, q: 1 },
  };
  const enums = { scale: ['dB', 'linear'], unit: ['ms', 'mm', 'samples'], fader: ['Main', 'Aux1', 'Aux2', 'Aux3', 'Aux4'] };
  const label = key => ({ freq: 'Frequency · Hz', gain: 'Gain · dB', q: 'Q', clip_limit: 'Hard limiter · dBFS', threshold: 'Threshold · dBFS', attack: 'Attack · s', release: 'Release · s', factor: 'Ratio', process_channels: 'Process channels', monitor_channels: 'Monitor channels' }[key] || key.replaceAll('_', ' '));
  function el(tag, text, className) { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; }
  function button(text, action, className) { const b = el('button', text, className); b.type = 'button'; b.addEventListener('click', action); return b; }
  function controls() {
    $('applyEdit').disabled = !dirty || busy;
    $('discard').disabled = !dirty || busy;
    $('draftState').textContent = busy ? 'Applying…' : dirty ? 'Unapplied changes' : 'Live settings';
    $('component').disabled = busy;
    $('advancedForm').querySelectorAll('input,select').forEach(input => input.disabled = busy || input.dataset.readonly === 'true');
  }
  function mark() { dirty = true; controls(); }
  function field(key, value, changed, choices, readonly = false) {
    const wrap = el('label', label(key));
    const input = el(choices ? 'select' : 'input');
    input.setAttribute('aria-label', label(key));
    if (choices) { [...new Set([...choices, value])].forEach(v => input.append(new Option(v, v))); input.value = value; }
    else if (typeof value === 'boolean') { input.type = 'checkbox'; input.checked = value; }
    else { input.type = typeof value === 'number' ? 'number' : 'text'; if (input.type === 'number') input.step = 'any'; input.value = Array.isArray(value) ? value.join(', ') : value ?? ''; }
    input.dataset.readonly = String(readonly); input.disabled = readonly;
    if (input.type === 'number') input.required = true;
    input.addEventListener('input', () => {
      let next = input.type === 'checkbox' ? input.checked : input.type === 'number' ? input.valueAsNumber : input.value;
      if (Array.isArray(value)) next = String(next).trim() ? String(next).split(',').map(v => Number(v.trim())) : [];
      changed(next); mark();
    });
    wrap.append(input); return wrap;
  }
  function parameters() {
    const root = $('editor'); root.replaceChildren();
    if (!draft) { root.append(el('p', 'No component configured.')); return; }
    if (kind === 'filters') {
      const type = field('Filter type', draft.type, value => { draft.type = value; draft.parameters = clone(types[value]); parameters(); }, Object.keys(types));
      root.append(type);
      if (draft.type === 'Biquad' || draft.type === 'Conv' || draft.type === 'BiquadCombo') {
        const variants = draft.type === 'Biquad' ? Object.keys(biquads) : draft.type === 'Conv' ? ['Values', 'Raw', 'Wav'] : ['ButterworthHighpass', 'ButterworthLowpass', 'LinkwitzRileyHighpass', 'LinkwitzRileyLowpass'];
        root.append(field('Response type', draft.parameters.type, value => {
          draft.parameters = draft.type === 'Biquad' ? { type: value, ...clone(biquads[value]) } : draft.type === 'Conv' ? value === 'Values' ? { type: value, values: [1] } : value === 'Wav' ? { type: value, filename: '', channel: 0 } : { type: value, filename: '', format: 'FLOAT32LE', skip_bytes_lines: 0, read_bytes_lines: 0 } : { type: value, freq: 1000, order: 4 };
          parameters();
        }, variants));
      }
    }
    const grid = el('div', null, 'parameter-grid');
    for (const [key, value] of Object.entries(draft.parameters || {})) {
      if (key === 'type' && ['Biquad', 'Conv', 'BiquadCombo'].includes(draft.type)) continue;
      const readonly = kind === 'processors' && (['channels', 'process_channels', 'monitor_channels'].includes(key) || (/protection/i.test(selected) && key === 'threshold'));
      grid.append(field(key, value, next => draft.parameters[key] = next, enums[key], readonly));
    }
    root.append(grid);
    if (draft.type === 'Limiter') root.append(el('p', 'The associated compressor threshold follows 1 dB below this ceiling.', 'muted'));
    if (kind === 'processors' && /protection/i.test(selected)) root.append(el('p', 'Adjust the threshold with its Hard Limiter in Output Processing.', 'muted'));
    if (kind === 'filters' && !/^(GLOBAL_EQ_|ESTACK_|USER_CH)|loudness|protection|hard_limit|[hl]pf|crossover/i.test(selected) && !['Gain','Delay','Limiter','BiquadCombo'].includes(draft.type)) root.append(button('Remove filter…', () => commit({ kind: 'removeFilter', name: selected }), 'danger remove-filter'));
    controls();
  }
  function mixer() {
    $('editor').replaceChildren();
    const mixer = config.mixers[selected];
    if (!mixer) return;
    const introduction = el('div', null, 'mixer-intro');
    introduction.append(el('strong', selected), el('span', `${mixer.channels.in} inputs → ${mixer.channels.out} outputs · live routing`));
    $('editor').append(introduction);
    const destinations = el('div', null, 'mixer-destinations');
    (mixer.mapping || []).forEach((mapping, m) => {
      const section = el('section', null, 'mixer-destination');
      const heading = el('header', null, 'mixer-destination-head');
      heading.append(el('h3', wayName(mapping.dest)), el('small', `OUT ${mapping.dest + 1} · ${mapping.sources.length} source${mapping.sources.length === 1 ? '' : 's'}`));
      section.append(heading);
      mapping.sources.forEach((source, s) => {
        const form = el('div', null, 'mixer-source'), value = { channel: source.channel, gain: source.gain, mute: !!source.mute, inverted: !!source.inverted };
        const sourceHead = el('div', null, 'mixer-source-head');
        sourceHead.append(el('strong', `INPUT ${source.channel + 1}`));
        const peak = el('output', '— dBFS', 'capture-peak');
        peak.dataset.capturePeak = String(source.channel);
        sourceHead.append(peak);
        form.append(sourceHead);
        const meter = el('div', null, 'capture-level');
        meter.dataset.captureBar = String(source.channel);
        meter.append(el('i'));
        form.append(meter);
        const channelField = el('label', 'Input channel');
        const channelSelect = el('select');
        channelSelect.setAttribute('aria-label', 'Input channel');
        for (let input = 0; input < mixer.channels.in; input++) channelSelect.append(new Option(`IN ${input + 1}`, String(input)));
        channelSelect.value = String(value.channel);
        channelSelect.addEventListener('change', () => { value.channel = Number(channelSelect.value); mark(); });
        channelField.append(channelSelect);
        form.append(channelField);
        for (const key of ['gain', 'mute', 'inverted']) form.append(field(key, value[key], next => value[key] = next));
        form.append(button('Apply source', () => commit({ kind: 'mixer', name: selected, mapping: m, source: s, value }), 'primary'));
        section.append(form);
      });
      destinations.append(section);
    });
    $('editor').append(destinations);
    updateCapturePeaks();
    $('advancedForm').querySelector('.editor-actions').hidden = true;
  }
  let readingPeaks = false;
  async function updateCapturePeaks() {
    if (kind !== 'mixers' || readingPeaks || B.mode !== 'camillanode') return;
    readingPeaks = true;
    let peaks = null;
    try {
      const result = await B.command('GetCaptureSignalPeak');
      if (Array.isArray(result)) peaks = result;
    } catch (_) { /* No synthetic meter values when the capture reading is unavailable. */ }
    document.querySelectorAll('[data-capture-peak]').forEach(output => {
      const level = peaks?.[Number(output.dataset.capturePeak)];
      output.textContent = Number.isFinite(level) ? `${level.toFixed(1)} dBFS` : '— dBFS';
    });
    document.querySelectorAll('[data-capture-bar]').forEach(bar => {
      const level = peaks?.[Number(bar.dataset.captureBar)];
      bar.firstElementChild.style.width = Number.isFinite(level) ? `${Math.max(0, Math.min(100, (level + 60) / 60 * 100))}%` : '0%';
    });
    readingPeaks = false;
  }
  function filterSummary(definition) {
    if (!definition) return 'Definition unavailable';
    const p = definition.parameters || {};
    if (definition.type === 'Gain') return `${Number(p.gain).toFixed(1)} dB${p.mute ? ' · muted' : ''}${p.inverted ? ' · inverted' : ''}`;
    if (definition.type === 'Delay') return `${p.delay} ${p.unit || 'ms'}`;
    if (definition.type === 'Limiter') return `${p.clip_limit} dBFS ceiling`;
    if (definition.type === 'BiquadCombo' && p.type && p.freq != null) {
      const family = p.type.startsWith('LinkwitzRiley') ? 'LR' : p.type.startsWith('Butterworth') ? 'Butterworth' : p.type;
      const edge = p.type.endsWith('Highpass') ? 'high-pass' : p.type.endsWith('Lowpass') ? 'low-pass' : '';
      return `${family} ${edge} · ${p.freq} Hz`;
    }
    if (p.freq != null) return `${p.type || definition.type} · ${p.freq} Hz${p.gain == null ? '' : ` · ${p.gain} dB`}`;
    return p.type || definition.type;
  }
  function openComponent(nextKind, name) {
    kind = nextKind; selected = name; dirty = false; render();
  }
  function pipeline() {
    const root = $('pipelineEditor');
    root.replaceChildren();
    const mixerIndex = (config.pipeline || []).findIndex(step => step.type === 'Mixer');
    const mixerStep = config.pipeline?.[mixerIndex];
    const mixerDefinition = config.mixers?.[mixerStep?.name];
    const count = config.devices?.playback?.channels || mixerDefinition?.channels?.out || 0;
    const header = el('header', null, 'path-heading');
    const title = el('div');
    title.append(el('h2', 'Signal paths'), el('p', 'Live processing order · select a component to inspect or edit it.'));
    const select = el('select');
    select.id = 'pathOutput';
    select.setAttribute('aria-label', 'Choose output signal path');
    select.append(new Option('All outputs', 'all'));
    for (let channel = 0; channel < count; channel++) select.append(new Option(`${wayName(channel)} · OUT ${channel + 1}`, String(channel)));
    if (pathSelection !== 'all' && Number(pathSelection) >= count) pathSelection = 'all';
    select.value = pathSelection;
    select.addEventListener('change', () => { pathSelection = select.value; pipeline(); });
    header.append(title, select);
    root.append(header);
    const list = el('div', null, 'signal-paths');
    for (let channel = 0; channel < count; channel++) {
      if (pathSelection !== 'all' && pathSelection !== String(channel)) continue;
      const mapping = mixerDefinition?.mapping?.find(entry => entry.dest === channel);
      const sources = mapping?.sources || [];
      const activeSources = sources.filter(source => !source.mute);
      const sourceChannels = new Set(activeSources.map(source => source.channel));
      const path = el('section', null, 'signal-path');
      path.dataset.outputChannel = String(channel);
      const pathTitle = el('header', null, 'signal-path-title');
      pathTitle.append(el('h3', wayName(channel)), el('span', `OUT ${channel + 1} · ${sources.length ? `${sources.length} input${sources.length === 1 ? '' : 's'}` : 'No mixer source'}`));
      path.append(pathTitle);
      const chain = el('div', null, 'signal-chain');
      const input = el('div', null, 'path-endpoint');
      input.append(el('small', 'CAPTURE'), el('strong', activeSources.length ? [...new Set(activeSources.map(source => `IN ${source.channel + 1}`))].join(' + ') : 'NO ACTIVE INPUT'));
      chain.append(input);
      (config.pipeline || []).forEach((stage, index) => {
        const beforeMixer = mixerIndex < 0 || index < mixerIndex;
        if (stage.type === 'Mixer') {
          if (index !== mixerIndex || !mapping) return;
          const node = el('div', null, 'path-step path-mixer');
          node.dataset.stage = String(index);
          if (stage.bypassed) node.classList.add('is-bypassed');
          node.append(el('small', `${String(index + 1).padStart(2, '0')} · MIXER`));
          node.append(button(stage.name, () => openComponent('mixers', stage.name), 'path-component'));
          node.append(el('span', sources.map(source => `IN ${source.channel + 1} ${Number(source.gain).toFixed(1)} dB${source.mute ? ' MUTED' : ''}`).join('  +  ') || 'No source'));
          if (stage.bypassed) node.append(el('em', 'Bypassed'));
          chain.append(node);
          return;
        }
        const channels = stage.channels || (stage.channel == null ? [] : [stage.channel]);
        if (stage.type === 'Filter' && !channels.some(source => beforeMixer ? sourceChannels.has(source) : source === channel)) return;
        if (stage.type === 'Processor') {
          const owned = config.processors?.[stage.name]?.parameters?.process_channels || [];
          if (!owned.some(source => beforeMixer ? sourceChannels.has(source) : source === channel)) return;
        }
        if (!['Filter', 'Processor'].includes(stage.type)) return;
        const names = stage.type === 'Filter' ? stage.names || [] : [stage.name];
        for (const name of names) {
          const definition = stage.type === 'Filter' ? config.filters?.[name] : config.processors?.[name];
          const node = el('div', null, 'path-step');
          node.dataset.stage = String(index);
          if (stage.bypassed) node.classList.add('is-bypassed');
          node.append(el('small', `${String(index + 1).padStart(2, '0')} · ${definition?.type || stage.type}`));
          node.append(button(name, () => openComponent(stage.type === 'Filter' ? 'filters' : 'processors', name), 'path-component'));
          node.append(el('span', stage.type === 'Filter' ? filterSummary(definition) : `Threshold ${definition?.parameters?.threshold ?? '—'} dBFS`));
          if (stage.bypassed) node.append(el('em', 'Bypassed'));
          if (stage.type === 'Filter' && !stage.bypassed && name === names[0]) {
            const shared = beforeMixer || channels.length > 1;
            const add = button(shared ? '+ Shared filter' : '+ Filter', () => {
              const next = prompt(`New filter name for ${shared ? 'shared' : wayName(channel)} stage ${index + 1}`);
              if (next) commit({ kind: 'insertFilter', stage: index, name: next.trim() });
            }, 'path-add');
            add.title = `Stage ${index + 1} applies to ${beforeMixer ? 'input' : 'output'} channels ${channels.map(value => value + 1).join(', ')}`;
            node.append(add);
          }
          chain.append(node);
        }
      });
      const output = el('div', null, 'path-endpoint');
      output.append(el('small', 'PLAYBACK'), el('strong', `OUT ${channel + 1}`));
      chain.append(output);
      path.append(chain);
      list.append(path);
    }
    root.append(list);
  }
  function render() {
    document.querySelectorAll('[data-kind]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.kind === kind)));
    $('advancedForm').hidden = kind === 'pipeline'; $('pipelineEditor').hidden = kind !== 'pipeline';
    document.querySelector('.advanced-selection').hidden = kind === 'pipeline';
    if (kind === 'pipeline') { pipeline(); return; }
    const names = Object.keys(config[kind] || {}); if (!names.includes(selected)) selected = names[0] || '';
    $('component').replaceChildren(...names.map(name => new Option(name, name))); $('component').value = selected;
    $('componentContext').textContent = `${names.length} ${kind}`;
    draft = selected ? clone(config[kind][selected]) : null;
    $('advancedForm').querySelector('.editor-actions').hidden = false;
    if (kind === 'mixers') mixer(); else parameters();
    controls();
  }
  async function commit(operation) {
    if (busy || !confirm('Apply this processing change? Master is temporarily attenuated during application.')) return;
    busy = true; controls();
    try {
      const next = await post('/api/advanced/edit', { revision, operation });
      config = next.config; revision = next.revision; dirty = false; render(); note('Applied and verified.');
    } catch (error) { note(error.message, true); }
    finally { busy = false; controls(); }
  }
  $('advancedForm').addEventListener('submit', event => { event.preventDefault(); if ($('advancedForm').reportValidity()) commit({ kind: kind === 'filters' ? 'filter' : 'processor', name: selected, value: draft }); });
  $('discard').addEventListener('click', () => { dirty = false; render(); });
  $('component').addEventListener('change', () => { if (dirty && !confirm('Discard unapplied changes?')) { $('component').value = selected; return; } dirty = false; selected = $('component').value; render(); });
  document.querySelectorAll('[data-kind]').forEach(button => button.addEventListener('click', () => { if (busy || (dirty && !confirm('Discard unapplied changes?'))) return; dirty = false; kind = button.dataset.kind; render(); }));
  const captureTimer = setInterval(updateCapturePeaks, 500);
  addEventListener('pagehide', () => clearInterval(captureTimer));
  addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  window.EStackAdvancedEditor = { receive(next, version) { if (!dirty && !busy) { config = clone(next); revision = version; render(); } }, holding: () => dirty || busy };
})();
