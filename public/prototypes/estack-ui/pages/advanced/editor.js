(() => {
  'use strict';
  const { B, $, post, note } = window.EStackSurface;
  const clone = value => JSON.parse(JSON.stringify(value));
  let config, revision, kind = 'filters', selected = '', dirty = false, busy = false, draft;
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
    (config.mixers[selected]?.mapping || []).forEach((mapping, m) => {
      const section = el('section', null, 'mixer-destination'); section.append(el('h3', `Output ${mapping.dest + 1}`));
      mapping.sources.forEach((source, s) => {
        const form = el('div', null, 'mixer-source'), value = { channel: source.channel, gain: source.gain, mute: !!source.mute, inverted: !!source.inverted };
        for (const key of ['channel', 'gain', 'mute', 'inverted']) form.append(field(key, value[key], next => value[key] = next));
        form.append(button('Apply source', () => commit({ kind: 'mixer', name: selected, mapping: m, source: s, value }), 'primary'));
        section.append(form);
      });
      $('editor').append(section);
    });
    $('advancedForm').querySelector('.editor-actions').hidden = true;
  }
  function pipeline() {
    $('pipelineEditor').replaceChildren();
    (config.pipeline || []).forEach((stage, index) => {
      const row = el('section', null, 'pipeline-stage');
      row.append(el('h3', `${String(index + 1).padStart(2, '0')} · ${stage.type}`), el('small', stage.channels ? `Channels ${stage.channels.map(c => c + 1).join(', ')}` : stage.name));
      const names = stage.names || (stage.name ? [stage.name] : []), links = el('div', null, 'stage-filters');
      names.forEach(name => links.append(button(name, () => { kind = stage.type === 'Mixer' ? 'mixers' : stage.type === 'Processor' ? 'processors' : 'filters'; selected = name; render(); })));
      row.append(links);
      if (stage.type === 'Filter') row.append(button('+ Add filter', () => { const name = prompt('New filter name'); if (name) commit({ kind: 'insertFilter', stage: index, name: name.trim() }); }));
      $('pipelineEditor').append(row);
    });
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
  addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  window.EStackAdvancedEditor = { receive(next, version) { if (!dirty && !busy) { config = clone(next); revision = version; render(); } }, holding: () => dirty || busy };
})();
