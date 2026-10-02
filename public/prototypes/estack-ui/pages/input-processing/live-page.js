(() => {
  'use strict';
  const service = window.EStackInputProcessingService, model = window.EStackInputProcessingModel;
  const importer = window.EStackInputProcessingImport, savedConfigs = window.EStackSavedConfigClient;
  if (!service || !model || !importer || !savedConfigs || window.EStackDSPBridge?.mode !== 'camillanode') throw new Error('Live Input Processing domain is unavailable.');
  const $ = selector => document.querySelector(selector);
  const names = model.GLOBAL_EQ_SLOT_NAMES;
  const bandColors = ['#58cce4','#ed83bd','#ebae59','#78d19a','#809eec','#b693e8','#ed887a','#bfce72','#62c5ba','#d4a37f'];
  const spectrumFrequencies = [25,30,40,50,63,80,100,125,160,200,250,315,400,500,630,800,1000,1250,1600,2000,2500,3150,4000,5000,6300,8000,10000,12500,16000,20000];
  const disabledKey = slot => `estack.globalEq.disabled.${slot}`;
  const clamp = model.clamp;
  let latest = null, selectedBand = names[0], analyzerFast = true, spectrum = [], spectrumTimer;
  let disabled = new Set(names.filter(slot => localStorage.getItem(disabledKey(slot)) === 'true'));
  let dragging = null, processing = false, busy = false, pendingImport = null, selectedPresetId = null;
  let operations = [], graphGeometry = null, responseCache = null, drawFrame = 0, stopped = false, hoverFrequency = null;
  const db = value => Number(value).toFixed(1).replace('-', '−');
  const hz = value => value >= 1000 ? `${Number((value / 1000).toFixed(2))} kHz` : `${Math.round(value)} Hz`;
  const number = slot => String(model.slotIndex(slot) + 1).padStart(2, '0');
  const valueLimits = field => field === 'frequency' ? [20,20000,1] : field === 'gain' ? [-12,12,.1] : [.1,20,.1];
  const effectiveDisabled = () => new Set(operations.length ? operations[operations.length - 1].disabled : disabled);
  const disabledSlots = () => [...effectiveDisabled()];
  function liveBands() {
    let bands = (latest?.slots || names.map(model.defaultBand)).map(band => ({...band}));
    operations.forEach(op => { if (op.bands) bands = op.bands.map(b => ({...b})); if (op.additions) op.additions.forEach(b => { bands[model.slotIndex(b.slot)] = {...b}; }); if (op.slot) { const i = model.slotIndex(op.slot); bands[i] = model.normalizeBand(i, {...bands[i], ...op.patch}); } });
    if (dragging?.slot) { const i = model.slotIndex(dragging.slot); bands[i] = model.normalizeBand(i, {...bands[i], ...dragging.patch}); }
    return bands;
  }
  function liveDelay() { let value = latest?.delay || 0; operations.forEach(op => { if (op.delay !== undefined) value = op.delay; }); return dragging?.kind === 'delay' ? dragging.value : value; }
  const activeBands = () => liveBands().filter(band => !effectiveDisabled().has(band.slot) && !model.isNeutral(band));
  const serializableBands = () => importer.serializeBands(liveBands().map(band => ({...band,enabled:!effectiveDisabled().has(band.slot)})));
  function setStatus(text, state = '') { $('#inputState').textContent = text; $('#inputState').dataset.state = state; }
  function persistDisabled() { names.forEach(slot => localStorage.setItem(disabledKey(slot), String(disabled.has(slot)))); }
  function setBusy() {
    busy = operations.length > 0;
    document.querySelectorAll('#eqReset,#eqToggleAll,#bandReset,#savePreset,#loadPreset,#addPreset,#deletePreset').forEach(el => { el.disabled = busy || !latest; });
    $('#loadPreset').disabled = busy || !selectedPresetId;
    $('#addPreset').disabled = busy || !selectedPresetId;
    $('#deletePreset').disabled = busy || !selectedPresetId;
    $('#renamePreset').disabled = busy || !selectedPresetId;
    $('#applyImport').disabled = busy || !pendingImport;
    $('#eqInspector').setAttribute('aria-busy', String(busy));
  }
  function enqueue(operation) {
    return new Promise((resolve,reject) => {
      operations.push({...operation, disabled:operation.disabled || disabledSlots(), resolve,reject});
      setBusy(); render(); drain();
    });
  }
  async function drain() {
    if (processing) return; processing = true;
    while (operations.length) {
      const op = operations[0]; setStatus('Applying…', 'pending');
      try {
        if (op.bands) await service.applyBands(op.bands,{disabledSlots:op.disabled});
        else if (op.additions) await service.addBands(op.additions,{disabledSlots:op.disabled});
        else if (op.toggleAll) await service.setBandsEnabled(op.disabled);
        else if (op.reset) await service.resetAll();
        else if (op.slot) await service.setBand(op.slot,op.patch,{disabledSlots:op.disabled});
        else await service.setDelay(op.delay);
        disabled = new Set(op.disabled); persistDisabled(); operations.shift(); op.resolve(true);
      } catch(error) {
        const failed = operations; operations = []; dragging = null;
        await service.refresh().catch(() => {}); failed.forEach(item => item.reject(error));
        setStatus(`Not applied · ${error.message}`, 'error'); processing = false; setBusy(); render(true); return;
      }
      setBusy(); render();
    }
    processing = false; setStatus('EQ synchronized', 'success');
  }
  function commitBand(slot, patch, nextDisabled) { if (!latest) return; return enqueue({slot,patch,disabled:nextDisabled}).catch(() => {}); }
  function setDelay(value) { if (!latest || !Number.isFinite(Number(value))) return; return enqueue({delay:model.normalizeDelay(value)}).catch(() => {}); }
  async function applyCompleteBands(bands) {
    if (busy) throw new Error('Wait for the current edit to finish.');
    const complete = importer.completeBands(bands);
    return enqueue({bands:complete,disabled:complete.filter(b=>b.enabled===false).map(b=>b.slot)});
  }
  function writeValue(el,value,force=false) { if (force || (document.activeElement !== el && dragging?.target !== el)) el.value = String(value); }
  function selectBand(slot) { if (dragging) return; selectedBand = slot; render(true); }
  function mount() {
    $('#eqBands').innerHTML = names.map(slot=>`<button type="button" class="eq-band" data-band="${slot}"><strong>${number(slot)}</strong><span></span><small></small></button>`).join('');
    $('#eqBands').addEventListener('click',e=>{const button=e.target.closest('[data-band]');if(button)selectBand(button.dataset.band);});
    $('#eqPoints').innerHTML = names.map(slot=>`<button type="button" class="eq-point" data-point="${slot}" aria-label="Band ${number(slot)} frequency and gain"><span>${Number(number(slot))}</span></button>`).join('');
    document.querySelectorAll('[data-band],[data-point]').forEach(el=>el.style.setProperty('--band-color',bandColors[model.slotIndex(el.dataset.band||el.dataset.point)]));
    $('#bandFields').innerHTML = ['frequency','gain','q'].map(field=>{const [min,max,step]=valueLimits(field);return `<label class="parameter"><span>${field==='frequency'?'FREQUENCY':field==='q'?'Q / WIDTH':'GAIN'}</span><div class="parameter-value"><input type="number" min="${min}" max="${max}" step="${step}" data-input-slot="${selectedBand}" data-field="${field}" aria-label="Band ${field}"><b>${field==='frequency'?'Hz':field==='gain'?'dB':'Q'}</b></div><input type="range" data-range="${field}" min="${field==='frequency'?0:min}" max="${field==='frequency'?1000:max}" step="${field==='frequency'?1:step}" aria-label="Adjust band ${field}"><small>${field==='frequency'?'20 Hz – 20 kHz':field==='gain'?'−12 dB – +12 dB':'Wide 0.1 — Narrow 20'}</small></label>`;}).join('');
    document.querySelectorAll('[data-range]').forEach(el=>bindRange(el,'band'));
    bindRange($('#delayRange'),'delay');
    document.querySelectorAll('[data-point]').forEach(el=>{el.title='Drag horizontally for frequency, vertically for gain. Arrow keys make fine adjustments.';bindPoint(el);});
  }
  function render(force=false) {
    if (!latest) return;
    const bands=liveBands(), off=effectiveDisabled(), band=bands[model.slotIndex(selectedBand)];
    $('#eqInspector').style.setProperty('--selected-color',bandColors[model.slotIndex(selectedBand)]);
    document.querySelectorAll('[data-band]').forEach(el=>{
      const b=bands[model.slotIndex(el.dataset.band)], state=off.has(b.slot)?'disabled':model.isNeutral(b)?'neutral':'active';
      el.dataset.state=state;el.setAttribute('aria-current',String(b.slot===selectedBand));el.querySelector('span').textContent=hz(b.frequency);el.querySelector('small').textContent=state==='active'?`${b.gain>0?'+':''}${db(b.gain)} dB`:state==='disabled'?'Disabled':'Neutral';el.setAttribute('aria-label',`Band ${number(b.slot)}, ${hz(b.frequency)}, ${state}`);
    });
    $('#bandNumber').textContent=number(band.slot);$('#bandTitle').textContent=`Band ${number(band.slot)}`;
    $('#bandState').textContent=off.has(band.slot)?'Disabled':model.isNeutral(band)?'Neutral':'Active';$('#bandState').dataset.state=off.has(band.slot)?'disabled':model.isNeutral(band)?'neutral':'active';
    $('#bandToggle').dataset.toggleSlot=band.slot;$('#bandToggle').setAttribute('aria-pressed',String(!off.has(band.slot)));$('#bandToggle').textContent=off.has(band.slot)?'Enable':'Enabled';
    $('#bandType').dataset.typeSlot=band.slot;writeValue($('#bandType'),band.type,force);
    $('#typeHelp').textContent=band.type==='Peaking'?'Bell-shaped correction':band.type==='Lowshelf'?'Shape below the frequency':'Shape above the frequency';
    document.querySelectorAll('[data-input-slot]').forEach(el=>{el.dataset.inputSlot=band.slot;writeValue(el,band[el.dataset.field],force);});
    document.querySelectorAll('[data-range]').forEach(el=>{const value=band[el.dataset.range];writeValue(el,el.dataset.range==='frequency'?Math.log(value/20)/Math.log(1000)*1000:value,force);el.setAttribute('aria-valuetext',el.dataset.range==='frequency'?hz(value):String(value));});
    $('#eqActiveCount').textContent=`${activeBands().length} active`;
    const allDisabled = off.size === names.length;
    $('#eqToggleAll').textContent = allDisabled ? 'Enable EQ' : 'Disable EQ';
    $('#eqToggleAll').setAttribute('aria-pressed', String(!allDisabled));
    $('#eqToggleAll').title = allDisabled ? 'Restore all EQ bands without changing their settings' : 'Bypass all EQ bands without changing their settings';
    const delay=liveDelay();writeValue($('#delayRange'),delay,force);writeValue($('#delayNumber'),delay.toFixed(1),force);
    $('#delayReadout').textContent=`${delay.toFixed(1)} ms`;$('#delayState').textContent=delay>0?'Active':'Bypassed';$('#delayState').dataset.active=String(delay>0);
    $('#sampleRate').textContent=`${Number(latest.sampleRate)/1000} kHz · L/R`;
    setBusy();draw();
  }
  function rangeValue(el) { return el.dataset.range==='frequency'?Math.round(20*Math.pow(1000,Number(el.value)/1000)):Number(el.value); }
  function bindRange(el,kind) {
    let pointerActive=false;
    el.addEventListener('pointerdown',event=>{
      if(!latest||dragging)return;pointerActive=true;el.setPointerCapture(event.pointerId);
      const start=kind==='delay'?liveDelay():liveBands()[model.slotIndex(selectedBand)][el.dataset.range];
      dragging={kind,slot:kind==='band'?selectedBand:null,patch:{},value:start,start,target:el,id:event.pointerId};
    });
    el.addEventListener('input',()=>{
      if(!latest)return;const value=rangeValue(el);
      if(dragging?.target===el){if(kind==='delay')dragging.value=value;else dragging.patch[el.dataset.range]=value;render();}
    });
    function finish(event,cancel=false){
      if(dragging?.target!==el||dragging.id!==event.pointerId)return;
      const d=dragging,value=rangeValue(el);dragging=null;
      if(!cancel&&value!==d.start){if(kind==='delay')setDelay(value);else commitBand(d.slot,{[el.dataset.range]:value});}
      writeValue(el,cancel?(el.dataset.range==='frequency'?Math.log(d.start/20)/Math.log(1000)*1000:d.start):el.value,true);
      render();setTimeout(()=>{pointerActive=false;},0);
    }
    el.addEventListener('pointerup',e=>finish(e));el.addEventListener('pointercancel',e=>finish(e,true));el.addEventListener('lostpointercapture',e=>{if(dragging?.target===el)finish(e,true);});
    el.addEventListener('change',()=>{if(pointerActive||!latest)return;const value=rangeValue(el);if(kind==='delay')setDelay(value);else commitBand(selectedBand,{[el.dataset.range]:value});});
  }
  function bindPoint(el) {
    el.addEventListener('pointerdown',event=>{
      if(!latest||dragging)return;event.preventDefault();selectedBand=el.dataset.point;render(true);
      const b=liveBands()[model.slotIndex(selectedBand)];dragging={kind:'graph',slot:selectedBand,patch:{},start:{frequency:b.frequency,gain:b.gain},x:event.clientX,y:event.clientY,target:el,id:event.pointerId,geometry:{...graphGeometry}};el.setPointerCapture(event.pointerId);
    });
    el.addEventListener('pointermove',event=>{
      if(dragging?.target!==el||dragging.id!==event.pointerId)return;
      const d=dragging,g=d.geometry;d.patch={frequency:Math.round(clamp(d.start.frequency*Math.pow(1000,(event.clientX-d.x)/g.plotW),20,20000)),gain:Math.round(clamp(d.start.gain-(event.clientY-d.y)/g.plotH*2*g.range,-12,12)*10)/10};render();
    });
    const finish=(e,cancel=false)=>{if(dragging?.target!==el||dragging.id!==e.pointerId)return;const d=dragging;dragging=null;if(!cancel&&Object.keys(d.patch).some(k=>d.patch[k]!==d.start[k]))commitBand(d.slot,d.patch);render();};
    el.addEventListener('pointerup',e=>finish(e));el.addEventListener('pointercancel',e=>finish(e,true));el.addEventListener('lostpointercapture',e=>finish(e,true));
    el.addEventListener('click',()=>selectBand(el.dataset.point));
    el.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();const b=liveBands()[model.slotIndex(el.dataset.point)];const field=e.key==='ArrowLeft'||e.key==='ArrowRight'?'frequency':'gain';const value=field==='frequency'?Math.round(b.frequency*Math.pow(2,(e.key==='ArrowRight'?1:-1)/24)):Math.round(clamp(b.gain+(e.key==='ArrowUp'?.1:-.1),-12,12)*10)/10;commitBand(b.slot,{[field]:value});});
  }
  function draw() { if(drawFrame)return;drawFrame=requestAnimationFrame(()=>{drawFrame=0;paint();}); }
  function paint() {
    if(!latest)return;const canvas=$('#eqCanvas'),box=canvas.getBoundingClientRect();if(!box.width)return;
    const w=box.width,h=box.height,ratio=Math.min(devicePixelRatio||1,2);if(canvas.width!==Math.round(w*ratio)||canvas.height!==Math.round(h*ratio)){canvas.width=Math.round(w*ratio);canvas.height=Math.round(h*ratio);}
    const ctx=canvas.getContext('2d');ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,w,h);
    const left=w<600?35:46,right=w<600?34:44,top=24,bottom=28,plotW=w-left-right,plotH=h-top-bottom;
    const bands=liveBands(),off=disabledSlots();const key=JSON.stringify([bands,off,latest.sampleRate,plotW]);
    if(responseCache?.key!==key){
      const values=[],individual=bands.map(()=>[]);
      for(let x=0;x<=plotW;x+=2){
        const frequency=20*Math.pow(1000,x/plotW);
        values.push({x,value:model.totalResponse(bands,frequency,latest.sampleRate,off)});
        bands.forEach((band,i)=>{if(!off.includes(band.slot)&&!model.isNeutral(band))individual[i].push({x,value:model.responseAt(band,frequency,latest.sampleRate)});});
      }
      responseCache={key,values,individual};
    }
    const max=Math.max(...responseCache.values.map(v=>Math.abs(v.value)));const range=dragging?.geometry?.range||Math.max(18,Math.ceil(max/6)*6);
    graphGeometry={left,right,top,bottom,plotW,plotH,range};const xFor=f=>left+Math.log(f/20)/Math.log(1000)*plotW,yFor=v=>top+(range-v)/(2*range)*plotH,ySpectrum=v=>top+(0-clamp(v,-96,0))/96*plotH;
    ctx.font='10px ui-monospace,monospace';ctx.fillStyle='#81979b';ctx.textAlign='left';ctx.fillText('dB',8,13);ctx.textAlign='right';ctx.fillText('dBFS',w-4,13);
    for(let i=0;i<=6;i++){const value=range-i*range/3,y=yFor(value);ctx.strokeStyle=i===3?'#3c6166':'#1a3034';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(w-right,y);ctx.stroke();ctx.fillStyle=i===3?'#c2d5d7':'#7d999e';ctx.textAlign='right';ctx.fillText(`${value>0?'+':''}${Math.round(value)}`,left-8,y+3);ctx.textAlign='left';ctx.fillStyle='#677d82';ctx.fillText(String(-i*16),w-right+6,y+3);}
    const ticks=w<600?[20,50,100,500,1000,5000,20000]:[20,30,50,100,200,500,1000,2000,5000,10000,20000];
    ticks.forEach(f=>{const x=xFor(f);ctx.strokeStyle=[100,1000,10000].includes(f)?'#294146':'#182c30';ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,h-bottom);ctx.stroke();ctx.textAlign=f===20?'left':f===20000?'right':'center';ctx.fillStyle='#89a2a6';ctx.fillText(f>=1000?`${f/1000}k`:String(f),x,h-8);});
    ctx.save();ctx.beginPath();ctx.rect(left,top,plotW,plotH);ctx.clip();
    if(spectrum.length){ctx.beginPath();ctx.moveTo(xFor(spectrumFrequencies[0]),h-bottom);spectrum.forEach((value,i)=>ctx.lineTo(xFor(spectrumFrequencies[i]),ySpectrum(value)));ctx.lineTo(xFor(spectrumFrequencies.at(-1)),h-bottom);ctx.closePath();ctx.fillStyle='rgba(135,161,172,.06)';ctx.fill();ctx.beginPath();spectrum.forEach((value,i)=>i?ctx.lineTo(xFor(spectrumFrequencies[i]),ySpectrum(value)):ctx.moveTo(xFor(spectrumFrequencies[i]),ySpectrum(value)));ctx.strokeStyle='rgba(149,175,185,.42)';ctx.lineWidth=1.2;ctx.stroke();}
    responseCache.individual.forEach((curve,i)=>{
      if(!curve.length)return;
      const selected=bands[i].slot===selectedBand;
      ctx.beginPath();ctx.moveTo(left,yFor(0));curve.forEach(({x,value})=>ctx.lineTo(left+x,yFor(value)));ctx.lineTo(left+curve.at(-1).x,yFor(0));ctx.closePath();
      ctx.fillStyle=bandColors[i];ctx.globalAlpha=selected?.28:.18;ctx.fill();
      ctx.beginPath();curve.forEach(({x,value},index)=>index?ctx.lineTo(left+x,yFor(value)):ctx.moveTo(left+x,yFor(value)));ctx.strokeStyle=bandColors[i];ctx.globalAlpha=selected?.95:.65;ctx.lineWidth=selected?1.7:1;ctx.stroke();ctx.globalAlpha=1;
    });
    const selected=bands[model.slotIndex(selectedBand)];const sx=xFor(selected.frequency);ctx.fillStyle='rgba(89,213,227,.035)';ctx.fillRect(sx-12,top,24,plotH);ctx.strokeStyle='rgba(89,213,227,.35)';ctx.setLineDash([3,5]);ctx.beginPath();ctx.moveTo(sx,top);ctx.lineTo(sx,h-bottom);ctx.stroke();ctx.setLineDash([]);
    ctx.beginPath();responseCache.values.forEach(({x,value},i)=>i?ctx.lineTo(left+x,yFor(value)):ctx.moveTo(left+x,yFor(value)));ctx.strokeStyle='#e6f7fa';ctx.lineWidth=2.6;ctx.stroke();ctx.restore();
    if(hoverFrequency!==null&&!dragging){const x=xFor(hoverFrequency),value=model.totalResponse(bands,hoverFrequency,latest.sampleRate,off);ctx.strokeStyle='#78989d';ctx.setLineDash([2,4]);ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,h-bottom);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='#e4f9fb';ctx.beginPath();ctx.arc(x,yFor(value),3,0,Math.PI*2);ctx.fill();}
    document.querySelectorAll('[data-point]').forEach(el=>{const b=bands[model.slotIndex(el.dataset.point)],selected=b.slot===selectedBand;el.hidden=!selected&&(off.includes(b.slot)||model.isNeutral(b));el.dataset.selected=String(selected);el.dataset.disabled=String(off.includes(b.slot));el.style.left=`${xFor(b.frequency)}px`;el.style.top=`${yFor(b.gain)}px`;el.setAttribute('aria-label',`Band ${number(b.slot)}, ${hz(b.frequency)}, ${db(b.gain)} dB. Drag to adjust.`);});
    $('#graphReadout').textContent=`${dragging?'Preview · ':''}Band ${number(selectedBand)} · ${hz(selected.frequency)} · ${selected.gain>0?'+':''}${db(selected.gain)} dB · Q ${selected.q.toFixed(2)}`;
    if(hoverFrequency!==null&&!dragging)$('#graphReadout').textContent=`${hz(hoverFrequency)} · EQ response ${db(model.totalResponse(bands,hoverFrequency,latest.sampleRate,off))} dB`;
  }
  function importStatus(text, state = '') { const output = $('#importStatus'); output.textContent = text; output.dataset.state = state; }
  function presetStatus(text, state = '') { const output = $('#presetStatus'); output.textContent = text; output.dataset.state = state; }
  async function refreshPresetList() {
    const list = $('#presetList'); const records = await savedConfigs.listByType('global-eq'); selectedPresetId = null; list.replaceChildren(); setBusy();
    if (!records.length) { const empty = document.createElement('p'); empty.className = 'preset-empty'; empty.textContent = 'No saved Global EQ presets.'; list.append(empty); return records; }
    records.forEach(record => { const button = document.createElement('button'); button.type = 'button'; button.className = 'preset-item'; button.dataset.presetId = String(record.id); button.textContent = record.name; button.addEventListener('click', () => { selectedPresetId = String(record.id); list.querySelectorAll('.preset-item').forEach(item => item.classList.toggle('is-selected', item === button)); $('#presetName').value = record.name; presetStatus(`Selected '${record.name}'.`); setBusy(); }); list.append(button); }); return records;
  }
  async function saveCurrentPreset() {
    const name = String($('#presetName').value || '').trim(); if (!name) { presetStatus('Enter a preset name.', 'error'); return; }
    try {
      const existing = (await savedConfigs.listByType('global-eq')).find(record => record.name === name); if (existing && !confirm(`Replace Global EQ preset '${name}'?`)) { presetStatus('Save cancelled.'); return; }
      const record = { type: 'global-eq', name, createdDate: existing?.createdDate || new Date().toISOString(), data: { format: 'estack-global-eq-v1', bands: serializableBands() } };
      await savedConfigs.save(record, !!existing); await refreshPresetList(); presetStatus(`'${name}' saved.`, 'success');
    } catch (error) { presetStatus(`SAVE ERROR · ${error.message}`, 'error'); }
  }
  async function loadSelectedPreset() {
    if (!selectedPresetId) { presetStatus('Select a preset first.', 'error'); return; }
    try {
      const record = await savedConfigs.getById(selectedPresetId); if (!record || record.type !== 'global-eq' || record.data?.format !== 'estack-global-eq-v1' || !Array.isArray(record.data?.bands)) throw new Error('Invalid Global EQ preset.');
      await applyCompleteBands(record.data.bands, `Preset '${record.name}'`); presetStatus(`'${record.name}' loaded.`, 'success');
    } catch (error) { presetStatus(`LOAD ERROR · ${error.message}`, 'error'); }
  }
  async function addSelectedPreset() {
    if (!selectedPresetId) { presetStatus('Select a preset first.', 'error'); return; }
    try {
      if (busy) throw new Error('Wait for the current edit to finish.');
      const record = await savedConfigs.getById(selectedPresetId);
      if (!record || record.type !== 'global-eq' || record.data?.format !== 'estack-global-eq-v1' || !Array.isArray(record.data?.bands)) throw new Error('Invalid Global EQ preset.');
      const additions = importer.additionsForPreset(liveBands(), record.data.bands);
      const off = effectiveDisabled();
      if (off.size !== names.length) additions.forEach(band => off.delete(band.slot));
      await enqueue({additions, disabled:[...off]});
      presetStatus(`${additions.length} band${additions.length === 1 ? '' : 's'} from '${record.name}' added.`, 'success');
    } catch (error) { presetStatus(`ADD ERROR · ${error.message}`, 'error'); }
  }
  async function renameSelectedPreset() {
    if (!selectedPresetId) return;
    try {
      const record = await savedConfigs.getById(selectedPresetId);
      if (!record) throw new Error('Preset no longer exists.');
      const name = prompt('New preset name', record.name)?.trim();
      if (!name || name === record.name) return;
      await savedConfigs.rename(record.id, name);
      await refreshPresetList(); presetStatus(`'${name}' renamed.`, 'success');
    } catch (error) { presetStatus(error.message, 'error'); }
  }
  async function deleteSelectedPreset() {
    if (!selectedPresetId) { presetStatus('Select a preset first.', 'error'); return; }
    try { const record = await savedConfigs.getById(selectedPresetId); if (!record) throw new Error('Preset no longer exists.'); if (!confirm(`Delete Global EQ preset '${record.name}'?`)) return; await savedConfigs.delete(record.id); await refreshPresetList(); presetStatus(`'${record.name}' deleted.`, 'success'); }
    catch (error) { presetStatus(`DELETE ERROR · ${error.message}`, 'error'); }
  }
  async function pollSpectrum() {
    if(stopped)return;
    try {
      const levels=await service.readSpectrum();const samples=spectrumFrequencies.map((_,i)=>levels?.[i*2]);
      if(samples.some(v=>typeof v!=='number'||!Number.isFinite(v)))throw new Error('Invalid spectrum');
      const alpha=analyzerFast?.58:.16;spectrum=samples.map((v,i)=>spectrum.length?alpha*v+(1-alpha)*spectrum[i]:v);
      $('#spectrumState').textContent='LIVE';$('#spectrumState').className='spectrum-state is-live';draw();
    } catch(_){spectrum=[];$('#spectrumState').textContent='UNAVAILABLE';$('#spectrumState').className='spectrum-state is-unavailable';draw();}
    if(!stopped)spectrumTimer=setTimeout(pollSpectrum,170);
  }
  function bind() {
    $('#eqCanvas').addEventListener('pointermove',event=>{if(event.pointerType!=='mouse'||dragging||!graphGeometry)return;const box=event.currentTarget.getBoundingClientRect(),g=graphGeometry;hoverFrequency=20*Math.pow(1000,clamp((event.clientX-box.left-g.left)/g.plotW,0,1));draw();});
    $('#eqCanvas').addEventListener('pointerleave',()=>{hoverFrequency=null;draw();});
    $('#bandToggle').addEventListener('click',()=>{if(!latest)return;const off=effectiveDisabled();if(off.has(selectedBand))off.delete(selectedBand);else off.add(selectedBand);commitBand(selectedBand,{},[...off]);});
    $('#eqToggleAll').addEventListener('click',()=>{if(!latest||busy)return;enqueue({toggleAll:true,disabled:effectiveDisabled().size===names.length?[]:[...names]}).catch(()=>{});});
    $('#bandType').addEventListener('change',e=>commitBand(selectedBand,{type:e.target.value}));
    $('#bandReset').addEventListener('click',()=>commitBand(selectedBand,model.defaultBand(model.slotIndex(selectedBand)),disabledSlots().filter(s=>s!==selectedBand)));
    document.querySelectorAll('[data-input-slot]').forEach(el=>{
      el.addEventListener('change',()=>{if(el.value===''||!Number.isFinite(el.valueAsNumber)){render(true);return;}const[min,max]=valueLimits(el.dataset.field);const value=clamp(el.valueAsNumber,min,max);el.value=value;commitBand(el.dataset.inputSlot,{[el.dataset.field]:value});});
    });
    $('#eqReset').addEventListener('click',()=>{if(busy||!confirm('Reset all 10 EQ bands to neutral? Input delay will stay unchanged.'))return;enqueue({reset:true,disabled:[]}).catch(()=>{});});
    $('#analyzerSpeed').addEventListener('click',e=>{analyzerFast=!analyzerFast;e.currentTarget.textContent=analyzerFast?'FAST':'SLOW';e.currentTarget.setAttribute('aria-pressed',String(analyzerFast));});
    $('#delayNumber').addEventListener('change',e=>{if(e.target.value===''){render(true);return;}const value=model.normalizeDelay(e.target.value);e.target.value=value.toFixed(1);setDelay(value);});
    $('#delayReset').addEventListener('click',()=>setDelay(0));
    document.querySelectorAll('[data-nudge]').forEach(el=>el.addEventListener('click',()=>setDelay(liveDelay()+Number(el.dataset.nudge))));
    document.querySelectorAll('[data-dialog-close]').forEach(el=>el.addEventListener('click',()=>$('#'+el.dataset.dialogClose).close()));
    $('#importEq').addEventListener('click',()=>{pendingImport=null;$('#importText').value='';$('#importFile').value='';$('#applyImport').disabled=true;$('#importPreview').replaceChildren();importStatus('Paste EQ text or choose a file, then preview.');$('#importDialog').showModal();});
    $('#chooseImportFile').addEventListener('click',()=>$('#importFile').click());
    function invalidateImport(){pendingImport=null;$('#applyImport').disabled=true;$('#importPreview').replaceChildren();importStatus('Preview this text before applying.');}
    $('#importText').addEventListener('input',invalidateImport);
    $('#importFile').addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;$('#importText').value=await file.text();invalidateImport();importStatus(`${file.name} loaded. Preview before applying.`);});
    $('#parseImport').addEventListener('click',()=>{
      try{pendingImport=importer.parse($('#importText').value);$('#applyImport').disabled=busy;importStatus(`${pendingImport.detected} band${pendingImport.detected===1?'':'s'} detected (${pendingImport.format}).`,'success');
        const rows=importer.completeBands(pendingImport.bands);$('#importPreview').replaceChildren(...rows.map((b,i)=>{const row=document.createElement('div');row.textContent=`${String(i+1).padStart(2,'0')} · ${hz(b.frequency)} · ${db(b.gain)} dB · Q ${b.q} · ${b.enabled===false?'Disabled':model.isNeutral(b)?'Neutral':b.type}`;return row;}));
      }catch(error){invalidateImport();importStatus(error.message,'error');}
    });
    $('#applyImport').addEventListener('click',async()=>{if(!pendingImport||busy)return;const parsed=pendingImport;try{await applyCompleteBands(parsed.bands);importStatus(`${parsed.detected} band${parsed.detected===1?'':'s'} imported.`,'success');pendingImport=null;$('#applyImport').disabled=true;}catch(error){importStatus(error.message,'error');}});
    $('#presetEq').addEventListener('click',async()=>{$('#presetDialog').showModal();presetStatus('Loading presets…');try{await refreshPresetList();presetStatus('Select a preset or save the current EQ.');}catch(error){presetStatus(error.message,'error');}});
    $('#savePreset').addEventListener('click',saveCurrentPreset);$('#loadPreset').addEventListener('click',loadSelectedPreset);$('#addPreset').addEventListener('click',addSelectedPreset);$('#deletePreset').addEventListener('click',deleteSelectedPreset);$('#renamePreset').addEventListener('click',renameSelectedPreset);
    new ResizeObserver(draw).observe($('#eqCanvas'));
  }
  mount();bind();setBusy();service.subscribe(snapshot=>{latest={...snapshot,slots:snapshot.slots.map(b=>({...b}))};render();});
  service.refresh().then(()=>{setStatus('EQ synchronized','success');pollSpectrum();}).catch(error=>setStatus(`Unavailable · ${error.message}`,'error'));
  window.addEventListener('beforeunload',()=>{stopped=true;clearTimeout(spectrumTimer);cancelAnimationFrame(drawFrame);});
})();
