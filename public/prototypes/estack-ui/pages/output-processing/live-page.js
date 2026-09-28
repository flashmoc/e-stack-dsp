(() => {
  'use strict';
  const service = window.EStackOutputProcessingService;
  const model = window.EStackOutputProcessingModel;
  const graph = window.EStackOutputGraphAnalysis;
  if (!service || !model || !graph || window.EStackDSPBridge?.mode !== 'camillanode') throw new Error('Live Output Processing domain is unavailable.');
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const clamp = model.clamp, db = v => `${Number(v)>0?'+':''}${Number(v).toFixed(1).replace('-', '−')} dB`;
  const hz = v => Number(v) >= 1000 ? `${+(Number(v) / 1000).toFixed(2)} kHz` : `${Math.round(v)} Hz`;
  // View state belongs to this mounted page, never to a DSP snapshot.
  let latest = null, selectedChannel = 0, editing = false, busy = false;
  let graphMode = localStorage.getItem('estack.output.graphMode') || 'magnitude';
  let xoPairId = localStorage.getItem('estack.output.xoPair') || 'sub-kick', compareChannel = null, allXos = true;
  let analyzerEnabled = false, analyzerMode = localStorage.getItem('estack.spectrum.speed') || 'fast';
  let analyzerView = localStorage.getItem('estack.spectrum.view') || 'full', analyzerInfinite = localStorage.getItem('estack.spectrum.infinite') === 'true';
  let realtimeSpectrum = null, infiniteSpectrum = null, spectrumPower = null, spectrumCount = 0, spectrumTimer = null, spectrumBusy = false;
  const drafts = new WeakSet();
  const pendingControls = new Map();
  const queueable = '[data-value],[data-range],[data-xo-freq],[data-xo-range],[data-xo-family],[data-xo-slope],[data-peq-field],[data-peq-slider]';
  let writeQueue = Promise.resolve(), pendingWrites = 0, queueEpoch = 0, activeRange = null;
  const responsePaths = new Map();
  let responseConfig = null;
  const disabledKey = (channel, slot) => `estack.peq.disabled.${channel}.${slot}`;
  const disabledSlots = channel => model.PEQ_DEFAULT_FREQUENCIES.map((_, slot) => slot).filter(slot => localStorage.getItem(disabledKey(channel, slot)) === 'true');
  const setDisabled = (channel, slot, value) => value ? localStorage.setItem(disabledKey(channel, slot), 'true') : localStorage.removeItem(disabledKey(channel, slot));
  const selected = () => latest?.ways?.find(item => item.channel === selectedChannel);
  const locked = () => !editing || busy;
  const status = (text, kind = '') => { $('#outputState').textContent = text; $('#outputState').className = `ui-status ${kind ? `is-${kind}` : ''}`; };
  const text = (selector, value) => { const el = $(selector); if (el && el.textContent !== String(value)) el.textContent = value; };
  function value(el, next) {
    if (el && !drafts.has(el) && pendingControls.get(el)?.channel !== selectedChannel && el.value !== String(next)) el.value = next;
  }
  function pairedControls(el) {
    const field=el.dataset.peqField || el.dataset.peqSlider;
    if(field) return $$(`[data-peq-field="${field}"][data-slot="${el.dataset.slot}"],[data-peq-slider="${field}"][data-slot="${el.dataset.slot}"]`);
    const id = el.dataset.range || el.dataset.value, edge = el.dataset.xoRange || el.dataset.xoFreq;
    return id ? $$(`[data-range="${id}"],[data-value="${id}"]`) : edge ? $$(`[data-xo-range="${edge}"],[data-xo-freq="${edge}"]`) : [el];
  }
  const peqPosition = (field,n) => field==='freq' ? Math.log(n/20)/Math.log(1000)*1000 : n;
  const peqValue = (field,n) => field==='freq' ? Math.round(20*1000**(n/1000)) : Number(n);
  function numberInput(attributes, label, unit) { return `<div class="value-unit"><input type="number" ${attributes} aria-label="${label}" data-mutation><span>${unit}</span></div>`; }
  function range(id, min, max, step, label) { return `<input type="range" data-range="${id}" min="${min}" max="${max}" step="${step}" aria-label="${label}" data-mutation>`; }
  function mountEditors() {
    $('#outputControls').innerHTML = `
      <div class="control-block"><label for="gainValue">GAIN</label>${numberInput('id="gainValue" data-value="gain" min="-60" max="6" step=".1"', 'Gain', 'dB')}${range('gain', model.GAIN_RANGE.min, model.GAIN_RANGE.max, model.GAIN_RANGE.step, 'Gain adjustment')}<span class="range-endpoints"><span>−60</span><span>0</span><span>+6 dB</span></span></div>
      <div class="control-block delay-control"><label for="delayValue">DELAY</label>${numberInput('id="delayValue" data-value="delay" min="0" max="100" step=".01"', 'Delay', 'ms')}<div class="nudge-row">${[-.1, -.01, .01, .1].map(d => `<button type="button" data-nudge="delay" data-delta="${d}" data-mutation aria-label="${d < 0 ? 'Decrease' : 'Increase'} delay by ${Math.abs(d)} milliseconds">${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(2)}</button>`).join('')}</div><span class="secondary-value" data-secondary="delay"></span></div>
      <div class="control-block"><label for="phaseValue">PHASE TRIM</label>${numberInput('id="phaseValue" data-value="phase" min="-179" max="0" step=".1"', 'Phase trim', '°')}${range('phase', -179, 0, .1, 'Phase trim adjustment')}<span class="secondary-value" data-secondary="phase"></span></div>
      <div class="control-block state-control"><span class="field-label">POLARITY</span><div class="segmented two" role="group" aria-label="Polarity"><button type="button" data-polarity="false" data-mutation>Normal</button><button type="button" data-polarity="true" data-mutation>Inverted</button></div><span class="secondary-value">Signal polarity</span></div>
      <div class="control-block state-control"><span class="field-label">OUTPUT STATE</span><div class="output-state-row"><output id="muteDetail" class="output-state"></output><button type="button" data-mute data-mutation></button></div></div>`;
    $('#protectionMetrics').innerHTML = `<div class="protection-summary"><span class="field-label">PROTECTION</span><strong>Limiter present</strong><span>Compressor follows · −1 dB</span></div><label class="inline-field">HARD LIMIT${numberInput('data-value="limiter" min="-60" max="0" step=".1"', 'Hard limiter threshold', 'dBFS')}</label>${['threshold', 'attack', 'release', 'ratio'].map(k => `<div><small>${k.toUpperCase()}</small><span data-protection="${k}"></span></div>`).join('')}`;
    $('#crossoverControls').innerHTML = ['hpf', 'lpf'].map(edge => `<div class="crossover-module" data-edge="${edge}"><div class="crossover-head"><strong>${edge === 'hpf' ? 'High pass' : 'Low pass'} <small>${edge.toUpperCase()}</small></strong><span data-owner="${edge}"></span></div><p data-missing="${edge}" hidden>Not present in this output</p><div class="xo-fields" data-xo-fields="${edge}"><label>FREQUENCY${numberInput(`data-xo-freq="${edge}" min="16" max="20000" step=".1"`, `${edge.toUpperCase()} frequency`, 'Hz')}</label><input type="range" data-xo-range="${edge}" min="0" max="1000" step="1" aria-label="${edge.toUpperCase()} frequency adjustment" data-mutation><div class="xo-types"><label>TYPE<select data-xo-family="${edge}" aria-label="${edge.toUpperCase()} family" data-mutation><option value="LinkwitzRiley">Linkwitz–Riley</option><option value="Butterworth">Butterworth</option></select></label><label>SLOPE<select data-xo-slope="${edge}" aria-label="${edge.toUpperCase()} slope" data-mutation>${[12,24,36,48].map(v => `<option value="${v}">${v} dB/oct</option>`).join('')}</select></label></div></div></div>`).join('');
  }
  // One delegated event layer; handlers resolve current data, never a rendered snapshot.
  function run(operation, after = () => {}, options = {}) {
    if (!editing || (busy && !options.queue)) { updateValues(); return; }
    const token = {}, epoch = queueEpoch;
    const controls = options.controls || [];
    controls.forEach(el => pendingControls.set(el,{token,channel:selectedChannel,value:el.value}));
    pendingWrites++; busy = true; syncLock();
    const execute = async () => {
      try {
        if (epoch !== queueEpoch) return;
        status('COMMITTING');
        const result = await operation(); await after(result); status('DSP API READY', 'success');
      } catch (error) {
        queueEpoch++; // Cancel dependent pending edits after a failed transaction.
        status(`ERROR · ${error.message}`, 'critical'); await service.refresh().catch(() => {});
      } finally {
        controls.forEach(el => { if (pendingControls.get(el)?.token === token) pendingControls.delete(el); });
        pendingWrites--; busy = pendingWrites > 0; updateValues();
      }
    };
    writeQueue = writeQueue.then(execute);
    return writeQueue;
  }
  function syncLock() {
    $('#systemEdit').setAttribute('aria-busy', String(busy));
    $('#systemEdit').setAttribute('aria-pressed', String(editing));
    text('#systemEdit', editing ? 'System Edit · UNLOCKED' : 'System Edit · LOCKED');
    text('#editState', busy ? 'COMMITTING' : editing ? 'EDITING' : 'LOCKED');
    text('#sharedState', editing ? 'LIVE EDITING' : 'READ ONLY');
    $$('[data-mutation]').forEach(el => {
      // readOnly keeps the active numerical field focused through readback.
      el.disabled = !editing;
      if (el.matches('input[type=number]')) el.readOnly = busy && !el.matches(queueable);
      el.setAttribute('aria-disabled', String(!editing || (busy && !el.matches(`${queueable},[data-nudge]`))));
    });
    $('#addPeq').disabled = locked() || (selected()?.peq.filter(Boolean).length || 0) >= 10;
  }
  function updateSelector() {
    if (!$('#waySelector').children.length) {
      $('#waySelector').innerHTML = latest.ways.map(w => `<button type="button" class="way-card" data-way-channel="${w.channel}" data-way-color="${w.color}"><span class="way-heading"><strong>${w.name}</strong><small>OUT ${w.channel + 1}</small></span><span class="way-gain"></span><span class="way-detail"></span><meter class="way-gain-bar" min="${model.GAIN_RANGE.min}" max="${model.GAIN_RANGE.max}" aria-label="${w.name} gain" title="Output gain · −60…+6 dB"></meter></button>`).join('');
      $('#compareWay').innerHTML = '<option value="">None</option>' + latest.ways.map(w => `<option value="${w.channel}">${w.name}</option>`).join('');
      $('#xoPair').innerHTML = graph.XO_PAIRS.map(p => `<option value="${p.id}">${p.label}</option>`).join('');
    }
    latest.ways.forEach(w => {
      const el = $(`[data-way-channel="${w.channel}"]`), g = w.gain.filter.parameters;
      el.setAttribute('aria-pressed', String(w.channel === selectedChannel));
      el.querySelector('.way-gain').textContent = db(g.gain);
      el.querySelector('.way-detail').textContent = `${g.mute ? 'MUTED' : 'ON'} · ${Number(w.delay.filter.parameters.delay).toFixed(2)} ms${g.inverted ? ' · INV' : ''}`;
      el.classList.toggle('is-muted', !!g.mute);
      el.querySelector('.way-gain-bar').value = model.normalizeGain(g.gain);
      el.querySelector('.way-gain-bar').setAttribute('aria-valuetext',db(g.gain));
    });
  }
  function createPeqRow(slot) {
    const row = document.createElement('div'); row.className = 'peq-row'; row.dataset.peqSlot = slot;
    row.innerHTML = `<strong class="band-number">${String(slot + 1).padStart(2, '0')}</strong><button type="button" class="peq-power" data-peq-toggle="${slot}" aria-label="Band ${slot + 1} enabled" data-mutation></button><select data-peq-type="${slot}" aria-label="Band ${slot + 1} type" data-mutation><option value="Peaking">Peak</option><option value="Lowshelf">Low shelf</option><option value="Highshelf">High shelf</option></select>${[['freq',20,20000,1,'Hz'],['gain',-20,20,.1,'dB'],['q',.1,20,.1,'Q']].map(([f,min,max,step,unit]) => `<label class="peq-${f}"><span>${f === 'freq' ? 'FREQUENCY' : f === 'gain' ? 'GAIN' : 'Q'}</span>${numberInput(`data-peq-field="${f}" data-slot="${slot}" min="${min}" max="${max}" step="${step}"`, `Band ${slot + 1} ${f}`, unit)}<input type="range" data-peq-slider="${f}" data-slot="${slot}" min="${f === 'freq' ? 0 : min}" max="${f === 'freq' ? 1000 : max}" step="${f === 'freq' ? 1 : step}" aria-label="Band ${slot + 1} ${f} slider" data-mutation></label>`).join('')}<button class="peq-reset" type="button" data-peq-reset="${slot}" aria-label="Reset band ${slot + 1}" data-mutation>Reset</button><button class="remove-band" type="button" data-peq-delete="${slot}" aria-label="Delete band ${slot + 1}" data-mutation>×</button>`;
    return row;
  }
  function updatePeq(item) {
    const container = $('#peqRows'), entries = item.peq.filter(Boolean), disabled = new Set(disabledSlots(item.channel));
    // Key by stable slot. Addition/deletion touches only that row; ordinary writes touch values.
    $$('.peq-row').forEach(row => { if (!entries.some(e => e.slot === Number(row.dataset.peqSlot))) row.remove(); });
    entries.forEach(entry => {
      let row = $(`[data-peq-slot="${entry.slot}"]`);
      if (!row) { row = createPeqRow(entry.slot); const next = [...container.children].find(el => Number(el.dataset.peqSlot) > entry.slot); container.insertBefore(row, next || null); }
      const p = entry.filter.parameters, off = disabled.has(entry.slot);
      row.classList.toggle('is-disabled', off);
      row.querySelector('[data-peq-toggle]').textContent = off ? 'OFF' : 'ON';
      row.querySelector('[data-peq-toggle]').setAttribute('aria-pressed', String(!off));
      value(row.querySelector('select'), p.type);
      ['freq','gain','q'].forEach(f => value(row.querySelector(`[data-peq-field="${f}"]`), p[f]));
      ['freq','gain','q'].forEach(f => value(row.querySelector(`[data-peq-slider="${f}"]`), peqPosition(f,p[f])));
    });
    $('#peqEmpty').hidden = entries.length > 0;
    text('#peqMeta', `${entries.length} / 10 bands · ${item.name}`);
  }
  function updateEditors(item) {
    const g = item.gain.filter.parameters, delay = Number(item.delay.filter.parameters.delay || 0);
    const phase = model.phaseDegrees(latest.config, item.channel), ref = model.phaseReference(latest.config, item.channel);
    for (const [id, v] of Object.entries({ gain:g.gain, delay, phase, limiter:item.limiter.filter.parameters.clip_limit })) {
      value($(`[data-value="${id}"]`), Number(v).toFixed(id === 'delay' ? 2 : 1)); value($(`[data-range="${id}"]`), v);
    }
    text('[data-secondary="delay"]', `${(delay * latest.sampleRate / 1000).toFixed(1)} samples · ${(delay * .343).toFixed(3)} m`);
    text('[data-secondary="phase"]', `Reference ${hz(ref)}`);
    $$('[data-polarity]').forEach(el => { const on = (el.dataset.polarity === 'true') === !!g.inverted; el.classList.toggle('polarity-active', on); el.setAttribute('aria-pressed', String(on)); });
    text('[data-mute]', g.mute ? 'Unmute' : 'Mute');
    $('[data-mute]').classList.toggle('is-active', !!g.mute); $('[data-mute]').setAttribute('aria-pressed', String(!!g.mute));
    text('#muteDetail', g.mute ? 'MUTED' : 'ON');
    $('#muteDetail').classList.toggle('is-muted', !!g.mute);
    text('#outputMeta', `${item.name} · OUT ${item.channel + 1}`);
    const p = item.protection?.processor?.parameters;
    text('.protection-summary strong', 'Hard limiter present');
    text('.protection-summary span:last-child', p ? 'Compressor follows · −1 dB' : 'Compressor not present');
    ['threshold','attack','release','ratio'].forEach(k => { const v = p?.[k === 'ratio' ? 'factor' : k]; text(`[data-protection="${k}"]`, v == null ? '—' : k === 'ratio' ? `${v}:1` : `${Number(v).toFixed(k === 'threshold' ? 1 : 3)} ${k === 'threshold' ? 'dBFS' : 's'}`); });
    for (const edge of ['hpf','lpf']) {
      const entry = item.crossover[edge]; $(`[data-xo-fields="${edge}"]`).hidden = !entry; $(`[data-missing="${edge}"]`).hidden = !!entry;
      if (!entry) { text(`[data-owner="${edge}"]`, 'NOT PRESENT'); continue; }
      const p = entry.filter.parameters, owners = model.crossoverOwners(latest.config, entry.name);
      text(`[data-owner="${edge}"]`, owners.length > 1 ? `Shared · ${owners.map(c => model.way(c).name).join(' / ')}` : 'This way');
      value($(`[data-xo-freq="${edge}"]`), p.freq);
      value($(`[data-xo-range="${edge}"]`), Math.round(Math.log(p.freq / 16) / Math.log(20000 / 16) * 1000));
      value($(`[data-xo-family="${edge}"]`), /^Butterworth/.test(p.type) ? 'Butterworth' : 'LinkwitzRiley');
      value($(`[data-xo-slope="${edge}"]`), p.order * 6);
    }
    text('#crossoverScope', 'LIVE EDGES'); updatePeq(item);
  }
  function bindEditors() {
    document.addEventListener('pointerdown', e => {
      if (!e.isPrimary || !editing || !e.target.matches('input[type=range]')) return;
      activeRange = {element:e.target,pointerId:e.pointerId,changed:false};
      pairedControls(e.target).forEach(el => drafts.add(el));
      // Native range interaction owns the gesture; pointer capture preserves it
      // outside the thin track. touch-action is restricted to the range itself.
      e.target.setPointerCapture(e.pointerId);
    });
    document.addEventListener('pointerup', e => {
      if (activeRange?.pointerId !== e.pointerId) return;
      const gesture = activeRange; activeRange = null;
      if (!gesture.changed) { pairedControls(gesture.element).forEach(el => drafts.delete(el)); updateValues(); }
    });
    document.addEventListener('pointercancel', e => {
      if (activeRange?.pointerId !== e.pointerId) return;
      pairedControls(activeRange.element).forEach(el => drafts.delete(el));
      activeRange = null; updateValues();
    });
    document.addEventListener('input', e => {
      const el = e.target; if (!el.matches('[data-mutation]') || !editing || (busy && !el.matches(queueable))) return;
      pairedControls(el).forEach(control => drafts.add(control));
      if(el.dataset.peqSlider) {
        const field=el.dataset.peqSlider;
        $(`[data-peq-field="${field}"][data-slot="${el.dataset.slot}"]`).value=peqValue(field,el.value);
      } else if(el.dataset.peqField && Number(el.value)>=(el.dataset.peqField==='freq'?20:-20)) {
        $(`[data-peq-slider="${el.dataset.peqField}"][data-slot="${el.dataset.slot}"]`).value=peqPosition(el.dataset.peqField,Number(el.value));
      }
      if (activeRange?.element === el) activeRange.changed = true;
      if (el.dataset.range) $(`[data-value="${el.dataset.range}"]`).value = el.value;
      if (el.dataset.xoRange) $(`[data-xo-freq="${el.dataset.xoRange}"]`).value = Math.round(16 * (20000 / 16) ** (Number(el.value) / 1000));
      if (el.value !== '' && Number.isFinite(Number(el.value))) {
        const pairedRange = el.dataset.value && $(`[data-range="${el.dataset.value}"]`);
        if (pairedRange) pairedRange.value = el.dataset.value === 'gain' ? model.normalizeGain(el.value) : el.value;
        if (el.dataset.xoFreq && Number(el.value)>0) $(`[data-xo-range="${el.dataset.xoFreq}"]`).value = Math.round(Math.log(Number(el.value)/16)/Math.log(20000/16)*1000);
      }
    });
    document.addEventListener('change', e => {
      const el = e.target; if (!el.matches('[data-mutation]')) return;
      const controls = pairedControls(el); controls.forEach(control => drafts.delete(control));
      if (!editing || (busy && !el.matches(queueable))) { updateValues(); return; }
      if (el.dataset.value === 'gain' && el.value !== '') el.value = model.normalizeGain(el.value);
      if (el.validity && !el.validity.valid) { el.reportValidity(); updateValues(); return; }
      const pending = pendingControls.get(el);
      if (pending?.channel === selectedChannel && pending.value === el.value) return;
      const channel = selectedChannel, id = el.dataset.value || el.dataset.range;
      if (id) {
        const item = selected(), next = Number(el.value);
        const current = {gain:item.gain.filter.parameters.gain, delay:item.delay.filter.parameters.delay, phase:model.phaseDegrees(latest.config,channel), limiter:item.limiter.filter.parameters.clip_limit}[id];
        // Native blur can follow an explicit change on the same field. Never
        // start a second transaction for an already acknowledged value.
        if (!pending && next === Number(current)) return;
        const method = {gain:'setGain', delay:'setDelay', phase:'setPhase', limiter:'setHardLimiter'}[id];
        return run(() => service[method](channel, next), undefined, {queue:true,controls});
      }
      const edge = el.dataset.xoFamily || el.dataset.xoFreq || el.dataset.xoSlope || el.dataset.xoRange;
      if (edge) {
        const patch = {family:$(`[data-xo-family="${edge}"]`).value, freq:Number($(`[data-xo-freq="${edge}"]`).value), slope:Number($(`[data-xo-slope="${edge}"]`).value)};
        const current = selected().crossover[edge]?.filter.parameters;
        if (!current || (!pending && patch.freq === current.freq && patch.slope === current.order*6 && patch.family === (/^Butterworth/.test(current.type) ? 'Butterworth' : 'LinkwitzRiley'))) return;
        // Patch only the manipulated property, so a queued edit cannot replay
        // obsolete frequency/family/slope values over the preceding readback.
        const field = el.dataset.xoFamily ? 'family' : el.dataset.xoSlope ? 'slope' : 'freq';
        return run(() => service.setCrossover(channel, edge, {[field]:patch[field]}), undefined, {queue:true,controls});
      }
      if (el.dataset.peqField || el.dataset.peqSlider || el.dataset.peqType !== undefined) {
        const slot = Number(el.dataset.slot ?? el.dataset.peqType), field = el.dataset.peqField || el.dataset.peqSlider || 'type';
        const next = field === 'type' ? el.value : el.dataset.peqSlider ? peqValue(field,el.value) : Number(el.value);
        if (selected().peq[slot]?.filter.parameters[field] === next) return;
        return run(() => service.setPeq(channel, slot, {[field]:next}, disabledSlots(channel)),undefined,{queue:true,controls});
      }
    });
    document.addEventListener('click', e => {
      const el = e.target.closest('button'); if (!el) return;
      if (el.dataset.wayChannel !== undefined) {
        if (activeRange) return;
        selectedChannel = Number(el.dataset.wayChannel); if (compareChannel === selectedChannel) compareChannel = null;
        $$('[data-mutation]').forEach(i => drafts.delete(i)); updateValues();
        const strip = $('#waySelector');
        if (strip.scrollWidth > strip.clientWidth) strip.scrollTo({left:el.offsetLeft-strip.offsetLeft-(strip.clientWidth-el.clientWidth)/2,behavior:'smooth'});
        return;
      }
      if (el.dataset.nudge && editing) {
        const channel = selectedChannel, delta = Number(el.dataset.delta);
        return run(() => service.setDelay(channel,clamp(Number(latest.ways.find(w=>w.channel===channel).delay.filter.parameters.delay)+delta,0,100)),undefined,{queue:true});
      }
      const item = selected(); if (!item || locked()) return; const channel = item.channel;
      if (el.hasAttribute('data-mute')) return run(() => service.setMute(channel, !item.gain.filter.parameters.mute));
      if (el.dataset.polarity !== undefined) return run(() => service.setPolarity(channel, el.dataset.polarity === 'true'));
      if (el.id === 'addPeq') return run(() => service.addPeq(channel, disabledSlots(channel)), r => {setDisabled(channel,r.createdSlot,false); updateValues(); $(`[data-peq-field="freq"][data-slot="${r.createdSlot}"]`)?.focus({preventScroll:true});});
      if (el.dataset.peqToggle !== undefined) { const slot = Number(el.dataset.peqToggle), off = !disabledSlots(channel).includes(slot); return run(() => service.setPeq(channel,slot,{},off ? [...disabledSlots(channel),slot] : disabledSlots(channel).filter(s => s !== slot)), () => setDisabled(channel,slot,off)); }
      if (el.dataset.peqReset !== undefined) return run(() => service.resetPeq(channel,Number(el.dataset.peqReset),disabledSlots(channel)));
      if (el.dataset.peqDelete !== undefined) return run(() => service.deletePeq(channel,Number(el.dataset.peqDelete),disabledSlots(channel)), () => $('#addPeq').focus({preventScroll:true}));
    });
  }
  function renderGraphToolbar() {
    const item = selected(); if (!item) return;
    text('#selectedWayTitle', `${item.name} · ${graphMode === 'xo' ? 'XO ALIGN' : graphMode.toUpperCase()}`);
    text('#selectedWayMeta', graphMode === 'xo' ? 'Live signal-path phase' : `Theoretical ${graphMode} · ${hz(graphRange()[0])} – ${hz(graphRange()[1])}`);
    $$('button[data-graph-mode]').forEach(b => { const on = b.dataset.graphMode === graphMode; b.classList.toggle('is-active',on); b.setAttribute('aria-pressed',String(on)); });
    $$('[data-analyzer-mode],[data-analyzer-view]').forEach(b => { const on = b.dataset.analyzerMode === analyzerMode || b.dataset.analyzerView === analyzerView; b.classList.toggle('is-active',on); b.setAttribute('aria-pressed',String(on)); });
    [...$('#compareWay').options].forEach(o => { o.hidden = o.value === String(selectedChannel); });
    value($('#compareWay'),compareChannel ?? ''); value($('#xoPair'),xoPairId);
    $('#xoPair').disabled = graphMode !== 'xo';
    if (graphMode !== 'xo') text('#xoReadout', 'Available in XO Align');
    $('#analyzerControls').hidden = !analyzerEnabled;
    $('#analyzerEnabled').checked = analyzerEnabled; $('#allXos').checked = allXos; $('#analyzerInfinite').checked = analyzerInfinite;
    const pair = graph.XO_PAIRS.find(p => p.id === xoPairId);
    const channels = graphMode === 'xo' ? [pair.lower,pair.upper] : [selectedChannel, ...(compareChannel === null ? [] : [compareChannel])];
    $('#graphLegend').replaceChildren(...channels.map((c,i) => { const s = document.createElement('span'); s.dataset.wayColor = latest.ways.find(w => w.channel === c).color; s.className = i ? 'legend-compare' : ''; s.textContent = `${model.way(c).name}${graphMode !== 'xo' && i ? ' · compare' : ''}`; return s; }));
  }
  function graphRange(){if(graphMode==='xo'){const p=graph.XO_PAIRS.find(v=>v.id===xoPairId),c=graph.pairFrequency(latest.config,p);return [Math.max(20,c/4),Math.min(20000,c*4)];}return graph.SPECTRUM_VIEWS[analyzerView]||graph.SPECTRUM_VIEWS.full;}
  function drawGraph() {
    const canvas = $('#responseGraph'); if (!canvas || !selected()) return;
    if (responseConfig !== latest.config) { responsePaths.clear(); responseConfig = latest.config; }
    const box = canvas.getBoundingClientRect(), ratio = Math.min(devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(box.width * ratio)), height = Math.max(1, Math.round(box.height * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const ctx = canvas.getContext('2d'), w = width / ratio, h = height / ratio;
    ctx.setTransform(ratio,0,0,ratio,0,0); ctx.clearRect(0,0,w,h);
    const [fmin,fmax] = graphRange(), left = w < 600 ? 38 : 48, right = w < 600 ? 14 : 22, top = 25, bottom = 30, pw = w-left-right, ph = h-top-bottom;
    const phaseMode = graphMode !== 'magnitude', minY = phaseMode ? -180 : -72, maxY = phaseMode ? 180 : 18;
    const x = f => left + Math.log(f/fmin) / Math.log(fmax/fmin) * pw, y = v => top + (maxY-v)/(maxY-minY)*ph;
    ctx.font = '11px ui-monospace,monospace';
    const segment = (x1,y1,x2,y2) => { ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke(); };
    ctx.fillStyle = '#81979b'; ctx.textAlign = 'left';
    ctx.fillText(phaseMode ? '°' : 'dB', 8, 14);
    (phaseMode ? [-180,-90,0,90,180] : [-60,-48,-36,-24,-12,0,12]).forEach(v => {
      ctx.strokeStyle = v === 0 ? '#48666c' : '#20363a'; ctx.lineWidth = 1; segment(left,y(v),w-right,y(v));
      ctx.fillStyle = v === 0 ? '#c2d5d7' : '#829fa3'; ctx.textAlign = 'right';
      ctx.fillText(v > 0 && !phaseMode ? `+${v}` : String(v), left-9,y(v)+4);
    });
    const ticks = w < 600 ? [20,50,100,500,1000,5000,20000] : [20,30,50,100,200,500,1000,2000,5000,10000,20000];
    const visibleTicks = [...new Set([fmin,...ticks.filter(v => v > fmin && v < fmax),fmax])];
    let lastLabelX = -Infinity;
    visibleTicks.forEach((v,i) => {
      const px = x(v), major = [100,1000,10000].includes(v);
      ctx.strokeStyle = major ? '#2b464a' : '#1b3034'; segment(px,top,px,h-bottom);
      const isEdge = i === 0 || i === visibleTicks.length - 1;
      const labelSpacing = w < 600 ? 31 : 38;
      if (!isEdge && (px - lastLabelX < labelSpacing || x(fmax) - px < labelSpacing)) return;
      ctx.fillStyle = major ? '#a4b9bc' : '#839ea2';
      ctx.textAlign = i === 0 ? 'left' : i === visibleTicks.length - 1 ? 'right' : 'center';
      ctx.fillText(v >= 1000 ? `${Number((v/1000).toFixed(1))}k` : String(Math.round(v)),px,h-8);
      lastLabelX = px;
    });
    const item = selected();
    text('#edgeContext', ['hpf','lpf'].map(edge => `${edge.toUpperCase()} ${item.crossover[edge] ? hz(item.crossover[edge].filter.parameters.freq) : '—'}`).join('  /  '));
    ctx.save(); ctx.beginPath(); ctx.rect(left,top,pw,ph); ctx.clip();
    // Plotting only: all response and phase mathematics remain in the validated modules.
    const line = (way, role) => {
      const key = `${way.channel}:${graphMode}:${fmin}:${fmax}:${pw}:${ph}:${disabledSlots(way.channel).join(',')}`;
      let path = responsePaths.get(key);
      if (!path) {
        path = new Path2D(); let previous = null;
        for (let px=0;px<=pw;px+=phaseMode ? 1 : 3) {
        const f = Math.exp(Math.log(fmin)+px/pw*Math.log(fmax/fmin));
        const v = graphMode==='magnitude' ? model.magnitudeResponse(latest.config,way.channel,f,disabledSlots(way.channel)) : graph.wrapPhase(graph.phase(graph.channelResponse(latest.config,way.channel,f)));
          if (previous===null || (phaseMode && Math.abs(v-previous)>170)) path.moveTo(left+px,y(v)); else path.lineTo(left+px,y(v)); previous=v;
        }
        if (responsePaths.size > 60) responsePaths.clear();
        responsePaths.set(key,path);
      }
      ctx.strokeStyle = way.color; ctx.globalAlpha = role==='context' ? (phaseMode ? .25 : .38) : 1;
      ctx.lineWidth = role==='selected' ? 2.4 : role==='compare' ? 1.8 : 1;
      ctx.setLineDash(role==='compare' ? [7,4] : []); ctx.stroke(path); ctx.setLineDash([]); ctx.globalAlpha=1;
    };
    if (graphMode==='xo') {
      const p=graph.XO_PAIRS.find(p=>p.id===xoPairId),fc=graph.pairFrequency(latest.config,p);
      ctx.fillStyle='#e7b34d0a'; ctx.fillRect(x(fc/1.25),top,x(fc*1.25)-x(fc/1.25),ph);
      line(latest.ways.find(w=>w.channel===p.lower),'selected'); line(latest.ways.find(w=>w.channel===p.upper),'compare');
      ctx.setLineDash([3,5]); ctx.strokeStyle='#ba9959'; segment(x(fc),top,x(fc),h-bottom); ctx.setLineDash([]);
      const a=graph.wrapPhase(graph.phase(graph.channelResponse(latest.config,p.lower,fc))),b=graph.wrapPhase(graph.phase(graph.channelResponse(latest.config,p.upper,fc)));
      text('#xoReadout',`${p.label} · ${Math.round(fc)} Hz · Δ ${graph.wrapPhase(b-a).toFixed(1)}°`);
    } else {
      if (allXos) latest.ways.filter(w=>w.channel!==selectedChannel && w.channel!==compareChannel).forEach(w=>line(w,'context'));
      if (compareChannel!==null) line(latest.ways.find(w=>w.channel===compareChannel),'compare');
      for(const edge of ['hpf','lpf']) { const entry=item.crossover[edge]; if(!entry)continue; const f=entry.filter.parameters.freq;ctx.setLineDash([2,5]);ctx.strokeStyle='#617478';segment(x(f),top,x(f),h-bottom);ctx.setLineDash([]); }
      if (graphMode==='magnitude' && analyzerEnabled && realtimeSpectrum) {
        const spectrum=(values,color)=>{ctx.beginPath();let started=false;values.forEach((v,i)=>{const f=graph.SPECTRUM_FREQUENCIES[i];if(f<fmin||f>fmax)return;started?ctx.lineTo(x(f),y(v)):ctx.moveTo(x(f),y(v));started=true;});ctx.strokeStyle=color;ctx.lineWidth=1;ctx.stroke();};
        spectrum(realtimeSpectrum,'#b6c5c999'); if(infiniteSpectrum)spectrum(infiniteSpectrum,'#e7bd6c88'); canvas.dataset.spectrum='live';
      } else delete canvas.dataset.spectrum;
      line(item,'selected');
    }
    if(graphMode==='xo')delete canvas.dataset.spectrum;
    ctx.restore(); canvas.dataset.graphMode=graphMode;
    text('#graphState',analyzerEnabled ? graphMode!=='magnitude' ? 'SPECTRUM · MAGNITUDE ONLY' : realtimeSpectrum ? 'LIVE DSP + SPECTRUM' : 'SPECTRUM UNAVAILABLE' : 'LIVE DSP CONFIG');
  }
  async function pollSpectrum() {
    if (!analyzerEnabled || spectrumBusy) return;
    spectrumBusy = true;
    try {
      const raw = await window.EStackDSPBridge.spectrumCommand('GetPlaybackSignalPeak');
      const levels = Array.isArray(raw) ? raw : raw?.values || raw?.levels || [];
      const next = graph.SPECTRUM_FREQUENCIES.map((_,i) => clamp(Number(levels[i*2]),-90,0));
      const alpha = analyzerMode === 'raw' ? 1 : analyzerMode === 'fast' ? .82 : .24;
      realtimeSpectrum = next.map((v,i) => realtimeSpectrum ? alpha*v+(1-alpha)*realtimeSpectrum[i] : v);
      if (analyzerInfinite) {
        spectrumPower = realtimeSpectrum.map((v,i) => (spectrumPower?.[i] || 0)+10**(v/10));
        spectrumCount++;
        infiniteSpectrum = spectrumPower.map(v => 10*Math.log10(v/spectrumCount));
      }
      if (graphMode === 'magnitude') drawGraph();
      text('#analyzerStatus','LIVE SPECTRUM');
    } catch (_) {
      realtimeSpectrum = null;
      text('#analyzerStatus','UNAVAILABLE');
      if (graphMode === 'magnitude') drawGraph();
    } finally { spectrumBusy = false; }
  }
  function startSpectrum() {
    clearInterval(spectrumTimer);
    if (!analyzerEnabled) return;
    spectrumTimer = setInterval(pollSpectrum,analyzerMode === 'raw' ? 75 : analyzerMode === 'slow' ? 160 : 95);
    pollSpectrum();
  }
  function resetSpectrum() { spectrumPower = null; infiniteSpectrum = null; spectrumCount = 0; }
  function bindGraph() {
    $$('button[data-graph-mode]').forEach(button => button.onclick = () => {
      graphMode = button.dataset.graphMode;
      localStorage.setItem('estack.output.graphMode',graphMode);
      renderGraphToolbar(); drawGraph();
    });
    $('#compareWay').onchange = e => {
      compareChannel = e.target.value === '' ? null : Number(e.target.value);
      renderGraphToolbar(); drawGraph();
    };
    $('#allXos').onchange = e => { allXos = e.target.checked; drawGraph(); };
    $('#xoPair').onchange = e => {
      xoPairId = e.target.value;
      localStorage.setItem('estack.output.xoPair',xoPairId);
      renderGraphToolbar(); drawGraph();
    };
    $('#analyzerEnabled').onchange = e => {
      analyzerEnabled = e.target.checked;
      renderGraphToolbar(); startSpectrum(); drawGraph();
    };
    $$('[data-analyzer-mode]').forEach(button => button.onclick = () => {
      analyzerMode = button.dataset.analyzerMode;
      localStorage.setItem('estack.spectrum.speed',analyzerMode);
      startSpectrum(); renderGraphToolbar();
    });
    $$('[data-analyzer-view]').forEach(button => button.onclick = () => {
      analyzerView = button.dataset.analyzerView;
      localStorage.setItem('estack.spectrum.view',analyzerView);
      renderGraphToolbar(); drawGraph();
    });
    $('#analyzerInfinite').onchange = e => {
      analyzerInfinite = e.target.checked; resetSpectrum();
      localStorage.setItem('estack.spectrum.infinite',String(analyzerInfinite));
      drawGraph();
    };
    $('#analyzerReset').onclick = () => { resetSpectrum(); drawGraph(); };
  }
  function updateValues() {
    if (!latest?.ways?.length) return;
    updateSelector();
    $('.output-page').dataset.wayColor = selected().color;
    updateEditors(selected()); syncLock(); renderGraphToolbar(); drawGraph();
  }
  mountEditors(); syncLock(); bindEditors(); bindGraph();
  text('.protection-summary strong','Awaiting DSP');
  $('#systemEdit').onclick = () => { if (!busy) { editing = !editing; syncLock(); } };
  new ResizeObserver(() => drawGraph()).observe($('#responseGraph'));
  window.addEventListener('pagehide', () => clearInterval(spectrumTimer), {once:true});
  service.subscribe(snapshot => { latest = snapshot; updateValues(); });
  status('CONNECTING');
  service.refresh().then(() => status('DSP API READY','success')).catch(e => status(`DISCONNECTED · ${e.message}`,'critical'));
})();
