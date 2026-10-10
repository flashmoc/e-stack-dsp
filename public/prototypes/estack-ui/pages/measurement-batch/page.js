(() => {
  'use strict';
  document.documentElement.dataset.prototypePage = 'measurement-batch';

  const $ = id => document.getElementById(id);
  const adapter = window.EStackDSPBridge.mode === 'camillanode' ? null : window.EStackPrototypeDSP;
  const transport = new URLSearchParams(location.search).get('transport');
  const apiMode = transport === 'camillanode';
  const wayLabels = { SUB: 'SUB', KICK: 'KICK', MID_L: 'MID L', MID_R: 'MID R', HIGH_L: 'HIGH L', HIGH_R: 'HIGH R' };
  const clone = value => JSON.parse(JSON.stringify(value));
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  let state = null;
  let baseline = null;
  let effective = null;
  const instantSelection = new Set(Object.keys(wayLabels));
  let busy = false, online = !apiMode;
  let localModel = null;
  let localSavedCampaign;

  const sample = {
    schema: 'estack.measurement-batch', version: 1, name: 'KICK ↔ MID alignment',
    description: 'Safe local preview of the CamillaNode campaign contract.',
    defaults: { muteUnlisted: true, settleMs: 500, measurementInput: 4, disabledFilters: [] },
    steps: [
      { id: 'M01', name: 'KICK solo baseline', instruction: 'Run the REW sweep, then advance the campaign.', position: 'Mic on-axis · 2.00 m', activeWays: ['KICK'], ways: { KICK: { gainOffsetDb: -15 } }, crossovers: {}, rew: { measurementName: 'M01_KICK_SOLO', startHz: 30, endHz: 800, levelDbfs: -20, timingReference: true } },
      { id: 'M02', name: 'KICK + MID L crossover', instruction: 'Compare the crossover region before changing delay.', position: 'Mic on-axis · 2.00 m', activeWays: ['KICK', 'MID_L'], ways: { MID_L: { delayOffsetMs: .5, phase: { degrees: -45, reference: 'hpf' } } }, crossovers: { KICK: { lpf: { freqHz: 285, family: 'LinkwitzRiley', order: 4 } }, MID_L: { hpf: { freqHz: 285, family: 'LinkwitzRiley', order: 4 } } }, rew: { measurementName: 'M02_KICK_MID_285', startHz: 80, endHz: 1400, levelDbfs: -20, timingReference: true } }
    ]
  };

  const label = way => wayLabels[way] || String(way || '').replace(/_/g, ' ');
  const summary = step => `${(step.activeWays || []).map(label).join(' + ')} · ${step.rew?.measurementName || step.name}`;
  const describe = (step, index, total) => ({ ...clone(step), index, number: index + 1, total, activeWayLabels: (step.activeWays || []).map(label), summary: summary(step) });

  function localSnapshot() {
    const model = localModel || { batch: null, active: false, currentIndex: null, completed: [] };
    const batch = model.batch;
    const sequence = batch ? batch.steps.map((step, index) => describe(step, index, batch.steps.length)) : [];
    const active = !!model.active && !!batch;
    const current = active ? sequence[model.currentIndex] : null;
    const completed = model.completed || [];
    return {
      ok: true, phase: active ? 'active' : batch ? 'ready' : 'empty', active,
      mode: active && batch?.defaults?.processingMode === 'live-snapshot' ? 'live-snapshot' : 'campaign',
      batch: batch ? { schema: batch.schema, version: batch.version || 1, name: batch.name, description: batch.description, total: sequence.length, defaults: clone(batch.defaults || {}) } : null,
      sequence, current, next: active ? sequence[model.currentIndex + 1] || null : null,
      progress: { currentIndex: active ? model.currentIndex : null, currentNumber: active ? model.currentIndex + 1 : null, total: sequence.length, completedCount: completed.length, completed },
      message: !batch ? 'NO BATCH · import a Measurement Batch JSON file' : active ? `READY · ${current.summary}` : `READY · ${batch.name} · ${sequence.length} measurements`
    };
  }

  function persistLocal(reason) {
    adapter.apply(config => { config.measurementBatch = clone(localModel); }, reason);
    state = localSnapshot();
    return state;
  }

  function localBaseline() {
    const defaults = state?.batch?.defaults || {};
    return { ok: true, baseline: { captured: !!state?.active, id: state?.active ? 'LOCAL-CAPTURED' : 'LOCAL-PREVIEW', measurementInput: defaults.measurementInput ?? null, capturedAt: state?.active ? new Date().toISOString() : null, inputFilters: [], wayFilters: {}, warnings: [] } };
  }

  async function request(path, options = {}) {
    return window.EStackDSPBridge.api(`/api/measurement-batch/${path}`, { headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options });
  }

  const localActions = {
    status: async () => localSnapshot(),
    baseline: async () => localBaseline(),
    effective: async () => ({ ok: true, active: false }),
    instant: async activeWays => {
      if (localModel?.active) throw new Error('Finish the active measurement first');
      localSavedCampaign = localModel?.batch || null;
      localModel = { batch: { schema: 'estack.measurement-batch', version: 1, name: 'Current system', description: 'Local preview only', defaults: { processingMode: 'live-snapshot' }, steps: [{ id: 'LIVE', name: 'Current system', activeWays, ways: {}, crossovers: {} }] }, active: true, currentIndex: 0, completed: [] };
      const result = persistLocal('local current-system preview'); result.mode = 'live-snapshot'; return result;
    },
    import: async batch => { localModel = { batch: clone(batch), active: false, currentIndex: null, completed: [] }; return persistLocal('measurement batch imported locally'); },
    clear: async () => { localModel = { batch: null, active: false, currentIndex: null, completed: [] }; return persistLocal('measurement batch cleared locally'); },
    next: async () => {
      if (!localModel?.batch) throw new Error('Import a campaign before starting');
      if (!localModel.active) { localModel.active = true; localModel.currentIndex = 0; localModel.completed = []; return persistLocal('local batch baseline captured'); }
      const last = localModel.batch.steps.length - 1;
      localModel.completed = [...new Set([...(localModel.completed || []), localModel.currentIndex])];
      if (localModel.currentIndex >= last) { const name = localModel.batch.name; localModel.active = false; localModel.currentIndex = null; if (localSavedCampaign !== undefined) { localModel.batch = localSavedCampaign; localSavedCampaign = undefined; } const result = persistLocal('local batch restored'); result.phase = 'complete'; result.restored = true; result.message = `COMPLETE · ${name} · normal processing restored`; return result; }
      localModel.currentIndex += 1; return persistLocal('local measurement advanced');
    },
    previous: async () => { if (!localModel?.active) throw new Error('No active campaign'); localModel.currentIndex = Math.max(0, localModel.currentIndex - 1); localModel.completed = (localModel.completed || []).filter(index => index < localModel.currentIndex); return persistLocal('local measurement moved back'); },
    retry: async () => { if (!localModel?.active) throw new Error('No active campaign'); return persistLocal('local measurement reapplied'); },
    goto: async index => { if (!localModel?.active) throw new Error('No active campaign'); if (!Number.isInteger(index) || index < 0 || index >= localModel.batch.steps.length) throw new Error('Invalid measurement index'); localModel.currentIndex = index; localModel.completed = (localModel.completed || []).filter(value => value < index); return persistLocal('local measurement selected'); },
    abort: async () => { if (!localModel?.active) return localSnapshot(); const name = localModel.batch.name; localModel.active = false; localModel.currentIndex = null; localModel.completed = []; if (localSavedCampaign !== undefined) { localModel.batch = localSavedCampaign; localSavedCampaign = undefined; } const result = persistLocal('local batch restored'); result.restored = true; result.aborted = true; result.message = `RESTORED · ${name} · normal processing restored`; return result; }
  };

  const apiActions = {
    status: () => request('status'), baseline: () => request('baseline'),
    effective: () => request('effective'),
    instant: activeWays => request('instant', { method: 'POST', body: JSON.stringify({ activeWays }) }),
    import: batch => request('import', { method: 'POST', body: JSON.stringify({ batch }) }),
    clear: () => request('clear', { method: 'POST', body: '{}' }),
    next: () => request('next', { method: 'POST', body: '{}' }),
    previous: () => request('previous', { method: 'POST', body: '{}' }),
    retry: () => request('retry', { method: 'POST', body: '{}' }),
    goto: index => request('goto', { method: 'POST', body: JSON.stringify({ index }) }),
    abort: () => request('abort', { method: 'POST', body: '{}' })
  };
  const actions = apiMode ? apiActions : localActions;

  function currentStep() { return state?.current || state?.sequence?.[0] || null; }
  function setStatus(message, kind = 'pending') { $('measurementNote').textContent = message; $('measurementState').className = `ui-badge is-${kind}`; }

  function renderHeader() {
    const batch = state?.batch;
    $('transportState').textContent = apiMode ? (online ? 'LIVE' : 'OFFLINE') : 'LOCAL MODEL';
    $('transportState').className = `ui-status ${apiMode ? 'is-warning' : 'is-pending'}`;
    $('measurementState').textContent = state?.phase === 'active' ? 'CAPTURED' : state?.phase === 'complete' ? 'RESTORED' : batch ? 'READY' : 'NO BATCH';
    $('measurementState').className = `ui-badge ${state?.active ? 'is-success' : batch ? 'is-pending' : 'is-muted'}`;
    $('batchName').textContent = batch?.name || 'No campaign loaded';
    $('batchDescription').textContent = batch?.description || (apiMode ? 'Import a campaign JSON to prepare a live measurement session.' : 'Import a campaign or use the local sample.');
    $('exportBatch').disabled = !batch || busy;
    $('clearBatch').disabled = !batch || !!state?.active || busy;
    $('importBatch').disabled = !!state?.active || busy;
    $('loadSample').hidden = apiMode; $('loadSample').disabled = !!state?.active || busy;
    const progress = state?.progress || { total: 0, completedCount: 0 };
    const total = progress.total || 0;
    const completed = state?.active ? progress.currentNumber || 1 : progress.completedCount || 0;
    $('progressLabel').textContent = `${completed} / ${total}`;
    $('progressText').textContent = state?.active ? 'Measure in REW, then continue' : state?.phase === 'complete' ? 'Complete · system restored' : batch ? 'Ready to start' : 'Import a campaign to begin';
    $('progressBar').style.width = `${total ? Math.min(100, completed / total * 100) : 0}%`;
  }

  function renderInstant() {
    const locked = busy || !!state?.active;
    $('startInstant').disabled = locked || instantSelection.size === 0;
    $('instantWays').innerHTML = Object.entries(wayLabels).map(([key, name]) => `<label><input type="checkbox" value="${key}" ${instantSelection.has(key) ? 'checked' : ''} ${locked ? 'disabled' : ''}><span>${escape(name)}</span></label>`).join('');
    $('instantHint').textContent = state?.mode === 'live-snapshot' && state.active
      ? 'Snapshot captured. Finish or abort to restore the exact processing state, then start again to capture new adjustments.'
      : 'IN3 mixer gain is 0 dB; output gains remain as captured. To remove HIGH, deselect HIGH or mute it before capture.';
  }

  function renderEffective() {
    $('effectivePanel').hidden = !state?.active || !apiMode;
    if (!state?.active || !apiMode) return;
    if (!effective?.active) { $('effectiveSummary').textContent = 'Reading the actual DSP…'; return; }
    const processing = effective.processing || {};
    const input = processing.input || {};
    const selected = new Set(effective.selectedWays || []);
    const dynamic = input.dynamicFilters || [];
    const loudness = dynamic.find(filter => filter.name === 'ESTACK_LOUDNESS');
    const trim = (input.filters || []).find(filter => filter.name === 'ESTACK_INPUT_PREAMP');
    const wayRows = Object.entries(processing.ways || {}).map(([key, way]) => {
      const gain = (way.filters || []).find(filter => filter.kind === 'gain');
      const active = selected.has(key) && gain?.mute !== true;
      const filterKinds = [...new Set((way.filters || []).filter(filter => filter.kind !== 'gain').map(filter => filter.kind))];
      return `<div><span>${escape(way.label || label(key))}</span><strong>${active ? 'ON' : 'MUTED'} · ${gain?.gainDb == null ? '—' : `${Number(gain.gainDb).toFixed(1)} dB`} · ${way.eqCount || 0} EQ</strong><small>${escape(filterKinds.join(' · ') || 'No other filters')}</small></div>`;
    }).join('');
    $('effectiveSummary').innerHTML = `<p class="${effective.matchesExpected ? 'effective-ok' : 'effective-warning'}">${effective.matchesExpected ? 'Verified against captured state' : 'DSP differs from captured state — check before sweeping'}</p><div class="effective-facts"><span>MASTER</span><strong>${effective.masterDb == null ? '—' : `${Number(effective.masterDb).toFixed(1)} dB`}</strong><span>ROUTING</span><strong>${processing.measurementInputMode === 'dedicated-mono' ? `IN${processing.measurementInput}` : 'Current mixer'}</strong><span>LOUDNESS</span><strong>${processing.measurementPolicy?.loudness === 'forced-off' ? 'Forced off' : loudness ? 'Current live filter' : 'None'}</strong><span>INPUT TRIM</span><strong>${processing.measurementPolicy?.inputTrim === 'forced-off' ? 'Forced off' : trim ? `${trim.gainDb ?? '—'} dB` : 'None'}</strong><span>INPUT EQ</span><strong>${input.eqCount || 0} filters</strong></div><div class="effective-ways">${wayRows}</div><details><summary>Filter names and settings</summary><pre>${escape(JSON.stringify({ input: input.filters, ways: Object.fromEntries(Object.entries(processing.ways || {}).map(([key, way]) => [key, way.filters])) }, null, 2))}</pre></details>`;
  }

  let sequenceSignature='',currentSignature='';
  function renderSequence(){const sequence=state?.sequence||[],signature=JSON.stringify(sequence);$('sequenceCount').textContent=sequence.length+' measurements';if(signature!==sequenceSignature){sequenceSignature=signature;$('sequence').innerHTML=sequence.length?sequence.map(step=>'<button class="sequence-item" data-index="'+step.index+'" type="button"><strong>'+escape(step.id)+' · '+escape(step.name)+'</strong><span>'+escape(step.activeWayLabels.join(' + '))+'</span></button>').join(''):'<p class="empty-state">Import a campaign to see its sequence.</p>';}document.querySelectorAll('[data-index]').forEach(button=>{const index=Number(button.dataset.index);button.disabled=busy||!state?.active;button.classList.toggle('is-current',state?.current?.index===index);button.classList.toggle('is-complete',!!state?.progress?.completed?.includes(index));});}
  $('sequence').addEventListener('click',event=>{const button=event.target.closest('[data-index]');if(button&&!button.disabled)run('goto',Number(button.dataset.index),'Preparing measurement…');});
  function deltaRows(step) {
    const values = [];
    Object.entries(step?.ways || {}).forEach(([way, value]) => {
      const parts = [];
      if (value.delayMs != null) parts.push(`delay ${Number(value.delayMs).toFixed(2)} ms`);
      if (value.delayOffsetMs != null) parts.push(`delay Δ ${Number(value.delayOffsetMs).toFixed(2)} ms`);
      if (value.gainOffsetDb != null) parts.push(`gain Δ ${Number(value.gainOffsetDb).toFixed(1)} dB`);
      if (value.polarity) parts.push(value.polarity);
      if (value.phase != null) { const phase = typeof value.phase === 'object' ? value.phase.degrees : value.phase; parts.push(`phase ${phase}°`); }
      values.push(`<div><span>${escape(label(way))}</span><strong>${escape(parts.join(' · ') || 'baseline')}</strong></div>`);
    });
    Object.entries(step?.crossovers || {}).forEach(([way, value]) => ['hpf', 'lpf'].forEach(side => { const xo = value[side]; if (xo) values.push(`<div><span>${escape(label(way))} ${side.toUpperCase()}</span><strong>${escape(`${xo.freqHz || 'baseline'} Hz · ${xo.family || 'baseline'} ${xo.order ? `· ${xo.order}` : ''}`)}</strong></div>`); }));
    return values.length ? values.join('') : '<p class="empty-state">No processing delta.</p>';
  }

  function renderCurrent() {
    const step = currentStep();
    $('copyRewName').disabled=busy||!step?.rew?.measurementName;
    const signature=JSON.stringify([step,state?.active]);if(signature===currentSignature)return;currentSignature=signature;
    $('currentCounter').textContent = step ? `${state?.active ? 'MEASUREMENT' : 'PREVIEW'} ${step.number} / ${step.total}` : '—';
    $('currentName').textContent = step?.name || 'No active measurement';
    $('currentInstruction').textContent = step?.instruction || (step ? 'Run the sweep in REW, save the measurement, then continue.' : 'Import a campaign, then start the first measurement.');
    $('currentPosition').textContent = step?.position || ''; $('currentPosition').hidden = !step?.position;
    $('activeWays').innerHTML = step ? step.activeWayLabels.map(way => `<span>${escape(way)}</span>`).join('') : '<p class="empty-state">—</p>';
    $('dspDelta').innerHTML = deltaRows(step);
    const rew = step?.rew || {};
    $('rewMeta').innerHTML = step ? `<div><span>NAME</span><strong>${escape(rew.measurementName || '—')}</strong></div><div><span>SWEEP</span><strong>${rew.startHz && rew.endHz ? `${rew.startHz}–${rew.endHz} Hz` : 'Current'}</strong></div><div><span>LEVEL</span><strong>${rew.levelDbfs != null ? `${Number(rew.levelDbfs).toFixed(1)} dBFS` : 'Current'}</strong></div><div><span>TIMING REF</span><strong>${rew.timingReference == null ? 'Current' : rew.timingReference ? 'ON' : 'OFF'}</strong></div>` : '<p class="empty-state">—</p>';
    $('rewNotes').textContent = rew.notes || ''; $('rewNotes').hidden = !rew.notes;
    $('copyRewName').disabled = busy || !rew.measurementName;
  }

  function renderActions() {
    const active = !!state?.active;
    $('previous').disabled = busy || !active || state.mode === 'live-snapshot' || !(state.progress?.currentIndex > 0);
    $('retry').disabled = busy || !active || state.mode === 'live-snapshot';
    $('next').disabled = busy || !state?.batch;
    $('next').textContent = active ? (state.next ? 'NEXT MEASUREMENT' : 'FINISH & RESTORE') : 'START BATCH';
    $('abort').disabled = busy || !active;
  }

  function renderBaseline() {
    const item = baseline?.baseline;
    $('baselineCopy').textContent = item ? `${item.captured ? 'Captured baseline is locked for this campaign.' : 'Live processing preview; it will be captured at start.'}` : 'Baseline unavailable.';
    $('baselineData').innerHTML = item ? `<span>STATE</span><strong>${item.captured ? 'CAPTURED' : 'LIVE PREVIEW'}</strong><span>FINGERPRINT</span><strong>${escape(item.id || '—')}</strong><span>MEASUREMENT SOURCE</span><strong>${item.measurementInput == null ? 'BASELINE ROUTING' : `IN${item.measurementInput}`}</strong>` : '<span>STATE</span><strong>UNAVAILABLE</strong><span>FINGERPRINT</span><strong>—</strong><span>MEASUREMENT SOURCE</span><strong>—</strong>';
  }

  function render() { renderHeader(); renderInstant(); renderSequence(); renderCurrent(); renderEffective(); renderActions(); renderBaseline(); }

  let operationEpoch = 0;
  async function refresh({ silent = false } = {}) {
    const epoch = operationEpoch;
    try { const nextState = await actions.status(); const nextBaseline = await actions.baseline(); const nextEffective = nextState.active ? await actions.effective() : null; if (epoch !== operationEpoch) return; state = nextState; baseline = nextBaseline; effective = nextEffective; online = true; if (!silent) setStatus(state.message || 'Ready', state.active ? 'success' : 'pending'); }
    catch (error) { online = false; setStatus(error.message, 'critical'); if (!state) state = { phase: 'error', sequence: [], progress: {} }; }
    render();
  }

  async function run(name, value, note) {
    if (busy) return;
    operationEpoch++;
    busy = true; setStatus(note, 'warning'); renderHeader(); renderActions(); renderSequence();
    try { state = await actions[name](value); baseline = await actions.baseline(); effective = state.active ? await actions.effective() : null; setStatus(state.message || 'Done', state.phase === 'error' ? 'critical' : state.active ? 'success' : 'pending'); }
    catch (error) { setStatus(error.message, 'critical'); }
    finally { busy = false; render(); }
  }

  async function importFile(file) {
    try { const batch = JSON.parse(await file.text()); await run('import', batch, `Importing ${file.name}…`); }
    catch (error) { setStatus(`Import failed: ${error.message}`, 'critical'); }
    $('batchFile').value = '';
  }

  $('importBatch').addEventListener('click', () => $('batchFile').click());
  $('instantWays').addEventListener('change', event => { const input = event.target.closest('input[type="checkbox"]'); if (!input || state?.active) return; if (input.checked) instantSelection.add(input.value); else instantSelection.delete(input.value); renderInstant(); });
  $('startInstant').addEventListener('click', () => { if (instantSelection.size) run('instant', [...instantSelection], 'Capturing current DSP state…'); });
  $('batchFile').addEventListener('change', event => { const file = event.target.files?.[0]; if (file) importFile(file); });
  if (!apiMode) $('loadSample').addEventListener('click', () => run('import', sample, 'Loading sample campaign…'));
  $('clearBatch').addEventListener('click', () => { if (confirm('Clear the current Measurement Batch?')) run('clear', null, 'Clearing campaign…'); });
  $('previous').addEventListener('click', () => run('previous', null, 'Preparing previous measurement…'));
  $('retry').addEventListener('click', () => run('retry', null, 'Reapplying measurement state…'));
  $('next').addEventListener('click', () => run('next', null, state?.active ? 'Preparing next measurement…' : 'Capturing DSP baseline…'));
  $('abort').addEventListener('click', () => { if (confirm('Abort and restore the captured DSP processing?')) run('abort', null, 'Restoring normal processing…'); });
  $('refreshBaseline').addEventListener('click', () => refresh());
  $('exportBatch').addEventListener('click', () => { const batch = state?.batch; if (!batch) return; const blob = new Blob([JSON.stringify({ ...batch, steps: state.sequence.map(({ index, number, total, activeWayLabels, summary: ignored, ...step }) => step) }, null, 2)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${batch.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'measurement-batch'}.json`; link.click(); URL.revokeObjectURL(link.href); });
  $('copyRewName').addEventListener('click', async () => { const name = currentStep()?.rew?.measurementName; if (!name) return; try { await navigator.clipboard.writeText(name); setStatus('REW name copied.', 'success'); } catch (_) { setStatus(`REW name: ${name}`, 'pending'); } });

  adapter?.subscribe(config => { if (!apiMode && config.measurementBatch && !localModel) localModel = clone(config.measurementBatch); });
  if (!apiMode) localModel = { batch: null, active: false, currentIndex: null, completed: [] };
  let refreshing=false,closed=false,timer;
  async function poll(){if(closed)return;if(!busy&&!refreshing){refreshing=true;await refresh({silent:true});refreshing=false;}if(!closed)timer=setTimeout(poll,2000)}
  refresh().then(()=>{if(apiMode)timer=setTimeout(poll,2000)});
  addEventListener('pagehide',()=>{closed=true;clearTimeout(timer)});
})();
