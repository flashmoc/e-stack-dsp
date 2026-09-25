(() => {
  'use strict';

  const service = window.EStackControlService;
  const model = window.EStackControlModel;
  const faderPresentation = window.EStackControlFaderPresentation;
  if (!service || !model || !faderPresentation) throw new Error('E-Stack Control domain is unavailable');
  const $ = selector => document.querySelector(selector);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || min));
  const meter = value => `${clamp((Number(value) + 60) / 60 * 100, 0, 100)}%`;
  const meterScale = [-60, -48, -36, -24, -12, 0];
  const spectrumFrequencies = [25,30,40,50,63,80,100,125,160,200,250,315,400,500,630,800,1000,1250,1600,2000,2500,3150,4000,5000,6300,8000,10000,12500,16000,20000];
  const LEVEL_LOCK_STORAGE_KEY = 'estack.control.level.locked';
  let latest = null;
  let busy = false;
  let trimGesture=null, trimTargets=[], trimWorking=false, trimInFlight=null, dspLoad=null;
  let levelLocked = readLevelLock();
  let faderDragging = false;
  let spectrumBusy = false;
  let spectrumLevels = spectrumFrequencies.map(() => -80);
  let spectrumTimer = null;
  const inputActivity = new Map();
  const INPUT_SHOW_THRESHOLD_DB = -70;
  const INPUT_HOLD_THRESHOLD_DB = -76;
  const INPUT_HIDE_DELAY_MS = 2500;

  function readLevelLock() {
    try { return window.localStorage.getItem(LEVEL_LOCK_STORAGE_KEY) === 'true'; } catch (_) { return false; }
  }
  function setLevelLock(value) {
    levelLocked = !!value;
    try { window.localStorage.setItem(LEVEL_LOCK_STORAGE_KEY, String(levelLocked)); } catch (_) { /* Storage is optional presentation state. */ }
    render();
  }
  const isWayLocked = key => levelLocked && key !== 'master';

  const formatDb = (value, suffix = 'dB') => Number.isFinite(Number(value)) ? `${Number(value).toFixed(1).replace('-', '−')} ${suffix}` : '—';
  const wayHeadroom = channel => latest?.headroom?.find(item => item.channel === channel) || null;
  const wayPeak = channel => Number(latest?.outputPeaks?.[channel]);
  const message = (text, state = 'info') => { const root = $('.control-page'); if (root) { root.dataset.message = state; $('#controlStatus').textContent = text; $('#controlStatus').dataset.state = state; } };
  const setBusy = value => {
    busy = value;
    render();
  };
  const sendShellStatus = () => {
    const item = latest?.system;
    if (!item || !Number.isFinite(item.hardMargin)) return;
    const condition = item.hardMargin <= 0.1 ? 'hard' : item.protectionMargin <= 0 ? 'compress' : 'normal';
    window.parent?.postMessage({ type: 'estack-control-status', master: Number(latest.master), headroom: Math.max(0, item.hardMargin), condition }, location.origin);
  };

  function inputMeters() {
    const count = Math.max(2, Number(latest?.config?.devices?.capture?.channels || 2));
    const now = performance.now();
    const active = Array.from({ length: count }, (_, index) => {
      const level = Number(latest?.inputPeaks?.[index]); const previous = inputActivity.get(index) || { lastSignalAt: -Infinity, visible: false };
      if (level > INPUT_SHOW_THRESHOLD_DB || (previous.visible && level > INPUT_HOLD_THRESHOLD_DB)) previous.lastSignalAt = now;
      previous.visible = level > INPUT_SHOW_THRESHOLD_DB || (previous.visible && now - previous.lastSignalAt <= INPUT_HIDE_DELAY_MS);
      inputActivity.set(index, previous); return previous.visible ? index : null;
    }).filter(Number.isInteger);
    const signature=active.join(','); if ($('#inputMeters').dataset.channels === signature) return; $('#inputMeters').dataset.channels=signature;
    $('#inputMeters').innerHTML = active.length ? active.map(index => `<article class="input-meter" data-input-meter="${index}"><header><strong>${index === 0 ? 'IN L' : index === 1 ? 'IN R' : `IN ${index + 1}`}</strong><span>CAPTURE ${index + 1}</span></header><output data-input-readout="${index}">—</output><div class="horizontal-meter"><i data-input-fill="${index}"></i><b data-input-peak="${index}"></b><span>−60</span><span>0</span></div></article>`).join('') : '<div class="input-meter-empty">No active input</div>';
  }
  function paintInputMeters() {
    document.querySelectorAll('[data-input-meter]').forEach(card => {
      const index = Number(card.dataset.inputMeter); const level = Number(latest?.inputPeaks?.[index]);
      const display = Number.isFinite(level) ? level : -60;
      card.querySelector('[data-input-readout]').textContent = Number.isFinite(level) ? formatDb(level, 'dBFS') : '—';
      card.querySelector('[data-input-fill]').style.width = meter(display);
      card.querySelector('[data-input-peak]').style.left = meter(display);
    });
  }
  function protectionState(item) {
    if (!item || item.muted || !Number.isFinite(item.hardMargin)) return 'idle';
    if (item.hardMargin <= .1) return 'hard';
    if (Number.isFinite(item.protectionMargin) && item.protectionMargin <= 0) return 'compress';
    return 'safe';
  }
  function protectionLabel(item) {
    if (item?.muted || latest?.masterMuted) return '—';
    const state = protectionState(item);
    return state === 'hard' ? 'HARD LIMIT' : state === 'compress' ? 'COMPRESSION' : state === 'safe' ? `SAFE +${Math.max(0, item.hardMargin).toFixed(1)} dB` : 'NO SIGNAL';
  }
  function strip(item, master = false) {
    const key = master ? 'master' : String(item.channel); const gain = master ? latest.master : item.gain; const peak = master ? Math.max(-60, ...latest.ways.filter(way => !way.muted).map(way => Number(latest.outputPeaks?.[way.channel]) || -60)) : wayPeak(item.channel);
    const level = Number.isFinite(peak) ? peak : -60; const muted = master ? latest.masterMuted : item.muted; const headroom = master ? null : wayHeadroom(item.channel); const protection = protectionState(headroom); const min = master ? -50 : -60; const max = master ? 0 : 6; const step = master ? '.5' : '.1'; const locked = isWayLocked(key);
    return `<article class="mixer-strip${master ? ' master-strip' : ''}${muted ? ' is-muted' : ''} way-${master ? 'master' : item.id}" ${master ? '' : `data-protection="${protection}"`} style="--way:${master ? 'var(--color-accent)' : item.color}">
      <header><div><strong>${master ? 'MASTER' : item.name}</strong><span>${master ? 'DSP VOLUME · 0 dB LIMIT' : `OUT ${item.channel + 1} · POST LIMIT`}</span></div><output data-meter-readout="${key}">${master ? formatDb(gain) : muted ? '−∞' : formatDb(level, 'dBFS')}</output></header>
      <div class="legacy-meter-console"><div class="legacy-dbfs-scale">${meterScale.map(mark => `<span style="top:${100 - (mark + 60) / 60 * 100}%">${mark}</span>`).join('')}</div><div class="legacy-meter-core" data-fader-core="${key}" role="slider" tabindex="${locked ? '-1' : '0'}" aria-disabled="${locked}" aria-label="${master ? 'Master level' : `${item.name} gain`}" aria-valuemin="${min}" aria-valuemax="${max}" aria-valuenow="${gain}"><div class="legacy-meter-track"><i class="legacy-meter-fill" data-meter-fill="${key}" style="height:${meter(muted ? -60 : level)}"></i><b class="legacy-meter-peak" data-meter-peak="${key}" style="bottom:${meter(muted ? -60 : level)}"></b></div><div class="legacy-gain-rail"></div><input class="mixer-fader legacy-fader-input" data-fader="${key}" type="range" min="${min}" max="${max}" step="${step}" value="${gain}" ${locked ? 'disabled' : ''}><div class="legacy-fader-handle ${faderPresentation.positionClass(gain, min, max)}"></div><div class="legacy-gain-scale">${(master ? [0,-12,-24,-36,-48] : [6,0,-12,-30,-60]).map(mark => `<span class="gain-tick ${mark === 0 ? 'unity' : ''} ${faderPresentation.positionClass(mark, min, max)}">${mark > 0 ? `+${mark}` : mark}</span>`).join('')}</div></div></div>
      <div class="strip-value"><input class="ui-number" data-number="${key}" type="number" min="${min}" max="${max}" step="${step}" value="${Number(gain).toFixed(1)}" ${locked ? 'disabled' : ''}><span>dB</span></div>
      <div class="nudge-row"><button data-nudge="${key}" data-delta="-1" type="button" ${locked ? 'disabled' : ''}>−1</button><button data-nudge="${key}" data-delta="${master ? '-.5' : '-.2'}" type="button" ${locked ? 'disabled' : ''}>${master ? '−0.5' : '−0.2'}</button><button data-nudge="${key}" data-delta="${master ? '.5' : '.2'}" type="button" ${locked ? 'disabled' : ''}>${master ? '+0.5' : '+0.2'}</button><button data-nudge="${key}" data-delta="1" type="button" ${locked ? 'disabled' : ''}>+1</button></div>
      <div class="strip-protection" data-state="${protection}"><strong>${master ? 'MASTER OUTPUT' : protectionLabel(headroom)}</strong></div>
      <button class="mute-button" data-mute="${key}" type="button" aria-label="${master ? 'Master' : item.name} mute" aria-pressed="${muted}">${muted ? 'MUTED' : 'MUTE'}</button>
    </article>`;
  }
  function pairs(key, left, right) { const label = model.LINK_DEFINITIONS[key].label; return `<section class="channel-pair channel-pair-${key}">${strip(left)}${strip(right)}<button class="pair-link" data-link-toggle="${key}" type="button" aria-pressed="${latest.links[key]}">${label} · ${latest.links[key] ? 'LINKED' : 'FREE'}</button></section>`; }
  function mixer() {
    if ($('#controlMixer').children.length) { updateMixer(); return; }
    const ways = latest.ways; const by = channel => ways.find(item => item.channel === channel);
    $('#controlMixer').innerHTML = `<div class="console-bank">${strip(null, true)}${[0,1].map(channel => strip(by(channel))).join('')}${pairs('mid', by(2), by(3))}${pairs('high', by(4), by(5))}</div>`;
    document.querySelectorAll('[data-fader]').forEach(input => {
      input.addEventListener('input', event => previewGain(event.target.closest('[data-fader-core]'), event.target.dataset.fader, event.target.value));
      input.addEventListener('change', event => applyGain(event.target.dataset.fader, event.target.value));
    });
    document.querySelectorAll('[data-fader-core]').forEach(core => attachFaderPointer(core));
    document.querySelectorAll('[data-number]').forEach(input => input.addEventListener('change', event => { if (isWayLocked(event.target.dataset.number)) return; applyGain(event.target.dataset.number, event.target.value); }));
    document.querySelectorAll('[data-nudge]').forEach(button => button.addEventListener('click', () => { const key = button.dataset.nudge; if (busy) return; if (isWayLocked(key)) return; const value = key === 'master' ? latest.master : latest.ways.find(item => item.channel === Number(key))?.gain; applyGain(key, Number(value) + Number(button.dataset.delta)); }));
    document.querySelectorAll('[data-link-toggle]').forEach(button => button.addEventListener('click', () => service.setLink(button.dataset.linkToggle, !latest.links[button.dataset.linkToggle])));
    document.querySelectorAll('[data-mute]').forEach(button => button.addEventListener('click', () => run(() => button.dataset.mute === 'master' ? service.setMasterMute(!latest.masterMuted) : service.setWayMute(Number(button.dataset.mute), !latest.ways.find(item => item.channel === Number(button.dataset.mute))?.muted))));
  }
  function updateMixer() {
    document.querySelectorAll('[data-fader-core]').forEach(core=>{
      const key=core.dataset.faderCore, master=key==='master', item=latest.ways.find(w=>String(w.channel)===key);
      const card=core.closest('.mixer-strip'), gain=master?latest.master:item.gain, muted=master?latest.masterMuted:item.muted;
      const peak=master?Math.max(-60,...latest.ways.filter(w=>!w.muted).map(w=>Number(latest.outputPeaks[w.channel])||-60)):wayPeak(item.channel);
      const level=muted?-60:Number.isFinite(peak)?peak:-60, locked=isWayLocked(key);
      card.querySelector('[data-meter-readout]').textContent=master?formatDb(gain):muted?'−∞':formatDb(level,'dBFS');
      card.querySelector('[data-meter-fill]').style.height=meter(level);card.querySelector('[data-meter-peak]').style.bottom=meter(level);
      const fader=card.querySelector('[data-fader]'),numeric=card.querySelector('[data-number]');
      if(!faderDragging&&document.activeElement!==numeric&&document.activeElement!==core&&document.activeElement!==fader){
        fader.value=String(gain);numeric.value=Number(gain).toFixed(1);core.setAttribute('aria-valuenow',String(gain));
        card.querySelector('.legacy-fader-handle').className=`legacy-fader-handle ${faderPresentation.positionClass(gain,Number(fader.min),Number(fader.max))}`;
      }
      fader.disabled=busy||locked;numeric.disabled=busy||locked;core.setAttribute('aria-disabled',String(busy||locked));core.tabIndex=busy||locked?-1:0;
      card.querySelectorAll('[data-nudge]').forEach(el=>el.disabled=busy||locked);
      card.classList.toggle('is-muted',muted);
      const mute=card.querySelector('[data-mute]');mute.disabled=busy;mute.textContent=muted?'MUTED':'MUTE';mute.setAttribute('aria-pressed',String(muted));
      if(!master){const room=wayHeadroom(item.channel),protection=protectionState(room);card.dataset.protection=protection;
        const status=card.querySelector('.strip-protection');status.dataset.state=protection;status.querySelector('strong').textContent=protectionLabel(room);
      }
    });
    document.querySelectorAll('[data-link-toggle]').forEach(el=>{const key=el.dataset.linkToggle;el.disabled=busy;el.setAttribute('aria-pressed',String(latest.links[key]));el.textContent=`${model.LINK_DEFINITIONS[key].label} · ${latest.links[key]?'LINKED':'FREE'}`;});
  }
  function previewGain(core, key, value) {
    if (!core || isWayLocked(key)) return;
    const fader = core.querySelector('[data-fader]'); if (!fader) return;
    const next = faderPresentation.roundToStep(value, Number(fader.min), Number(fader.max), Number(fader.step));
    fader.value = String(next);
    const numeric = core.closest('.mixer-strip')?.querySelector('[data-number]'); if (numeric) numeric.value = next.toFixed(1);
    core.setAttribute('aria-valuenow', String(next));
    const handle = core.querySelector('.legacy-fader-handle');
    if (handle) handle.className = `legacy-fader-handle ${faderPresentation.positionClass(next, Number(fader.min), Number(fader.max))}`;
  }
  function attachFaderPointer(core) {
    const key = core.dataset.faderCore; const fader = core.querySelector('[data-fader]');
    if (!fader) return;
    const valueAt = clientY => {
      const bounds = core.getBoundingClientRect();
      return faderPresentation.roundToStep(faderPresentation.valueAtPosition((clientY - bounds.top) / bounds.height * 100, Number(fader.min), Number(fader.max)), Number(fader.min), Number(fader.max), Number(fader.step));
    };
    let pointerId = null; let keyboardPreview = false;
    const preview = clientY => previewGain(core, key, valueAt(clientY));
    const release = event => {
      if (event.pointerId !== pointerId) return;
      event.preventDefault();
      const next = valueAt(event.clientY); previewGain(core, key, next);
      try { core.releasePointerCapture?.(pointerId); } catch (_) {}
      pointerId = null; faderDragging = false;
      if (!isWayLocked(key)) applyGain(key, next);
    };
    core.addEventListener('pointerdown', event => {
      if (busy || event.button > 0 || isWayLocked(key)) return;
      event.preventDefault(); pointerId = event.pointerId; faderDragging = true; core.setPointerCapture?.(pointerId); core.focus({ preventScroll:true }); preview(event.clientY);
    });
    core.addEventListener('pointermove', event => { if (event.pointerId === pointerId && !isWayLocked(key)) { event.preventDefault(); preview(event.clientY); } });
    core.addEventListener('pointerup', release);
    core.addEventListener('pointercancel', event => { if (event.pointerId === pointerId) { try { core.releasePointerCapture?.(pointerId); } catch (_) {} pointerId = null; faderDragging = false; } });
    core.addEventListener('keydown', event => {
      if (busy) return; if (isWayLocked(key)) return;
      const keyboardStep = Number(fader.step) || .1;
      const increments = { ArrowUp: keyboardStep, ArrowRight: keyboardStep, ArrowDown: -keyboardStep, ArrowLeft: -keyboardStep, PageUp: 1, PageDown: -1 };
      if (!(event.key in increments)) return;
      event.preventDefault(); keyboardPreview = true;
      previewGain(core, key, Number(fader.value) + increments[event.key]);
    });
    core.addEventListener('keyup', event => {
      if (!keyboardPreview || !['ArrowUp','ArrowRight','ArrowDown','ArrowLeft','PageUp','PageDown'].includes(event.key)) return;
      keyboardPreview = false;
      if (!isWayLocked(key)) applyGain(key, fader.value);
    });
  }
  function trimValue() { return trimGesture ? Number($('#inputTrimRange').value) : trimTargets.length ? trimTargets.at(-1) : trimInFlight ?? Number(latest?.trim || 0); }
  function renderTrim() {
    const trim=trimValue(), available=service.availableInputTrim();
    if(!trimGesture) $('#inputTrimRange').value=String(trim);
    if(document.activeElement!==$('#inputTrimNumber')) $('#inputTrimNumber').value=trim.toFixed(1);
    $('#inputTrimValue').textContent=formatDb(trim); $('#inputTrimAvailable').textContent=Number.isFinite(available)&&available>=.5 ? '+'+available.toFixed(1)+' dB' : 'HOLD';
    $('#inputTrimUse').disabled=busy||trimWorking||!Number.isFinite(available)||available<.5;
    $('#inputTrimDown').disabled=trim<=-20; $('#inputTrimUp').disabled=trim>=12;
  }
  function renderSummary() {
    const root=$('#protectionSummary');
    if(!root.children.length) {
      root.innerHTML='<div><span>PROTECTION</span><strong data-summary="state"></strong></div><div><span>HEADROOM</span><strong data-summary="margin"></strong></div><div class="protection-load"><span>AUDIO LOAD</span><i><b data-load-bar></b></i><strong data-control-load></strong></div><div><span>ACTIVE WAY</span><strong data-summary="way"></strong></div>';
      $('#mixerActions').innerHTML='<div><strong>Output levels</strong><span>Preserve the balance between ways</span></div><button class="normalize-ways" data-normalize type="button">Max gain → 0 dB</button><button class="level-lock" data-level-lock type="button"><i class="lock-icon" aria-hidden="true"></i><span></span></button>';
      $('[data-normalize]').addEventListener('click',normalize); $('[data-level-lock]').addEventListener('click',()=>setLevelLock(!levelLocked));
    }
    const system=latest.system,state=protectionState(system),margin=Number.isFinite(system?.hardMargin)?Math.max(0,system.hardMargin):null;
    root.dataset.state=state;
    $('[data-summary="state"]').textContent=state==='hard'?'HARD LIMIT':state==='compress'?'COMPRESSION':system?'NORMAL':'WAITING';
    $('[data-summary="margin"]').textContent=margin===null?'—':margin.toFixed(1)+' dB'; $('[data-summary="way"]').textContent=system?.name||'PLAY SIGNAL';
    $('[data-control-load]').textContent=dspLoad===null?'— %':dspLoad.toFixed(1)+' %';
    $('[data-load-bar]').style.width=(dspLoad===null?0:Math.min(100,dspLoad))+'%';
    $('.protection-load').dataset.loadState=dspLoad===null?'unknown':dspLoad>=90?'critical':dspLoad>=70?'warning':'ok';
    const lock=$('[data-level-lock]'); lock.classList.toggle('is-locked',levelLocked);lock.setAttribute('aria-pressed',String(levelLocked));lock.setAttribute('aria-label',levelLocked?'Unlock output ways':'Lock output ways');lock.querySelector('span').textContent=levelLocked?'LOCKED':'UNLOCKED';
    lock.disabled=busy;$('[data-normalize]').disabled=busy;
  }
  function render() { if (!latest?.config) return; inputMeters(); paintInputMeters(); mixer(); renderTrim(); renderSummary(); sendShellStatus(); drawSpectrum(); }
  async function run(action) { if (busy) return; try { setBusy(true); await action(); } catch (error) { console.error(error); message(error.message || String(error), 'error'); } finally { setBusy(false); drainTrim(); } }
  function applyGain(key, value) { if (busy) return; if (isWayLocked(key)) return; run(() => key === 'master' ? service.setMaster(value) : service.setWayGain(Number(key), value)); }
  function normalize() { const highest = Math.max(...latest.ways.map(way => way.gain)); const shift = -highest; const gains = latest.ways.map(way => `${way.name}: ${way.gain.toFixed(1)} → ${(way.gain + shift).toFixed(1)} dB`).join('\n'); if (window.confirm(`Normalize E-Stack ways?\n\nCommon shift: ${shift > 0 ? '+' : ''}${shift.toFixed(1)} dB\nRelative differences are preserved exactly. MASTER is unchanged.\n\n${gains}`)) run(() => service.normalizeWays()); }
  function useInputHeadroom() { const add = service.availableInputTrim(); if (!Number.isFinite(add) || add < .5) return; const current = Number(latest.trim); const target = current + add; if (add >= 3 && !window.confirm(`Use available input headroom?\n\nINPUT TRIM: ${current > 0 ? '+' : ''}${current.toFixed(1)} → ${target > 0 ? '+' : ''}${target.toFixed(1)} dB\nAutomatic increase: +${add.toFixed(1)} dB\nReserve kept before first protection threshold: at least 1.0 dB\n\nThis estimate uses only the loudest peak seen in the last 4 seconds. Play representative loud programme material before confirming.`)) return; run(() => service.setInputTrim(target)); }
  function queueTrim(value) {
    const numeric=Number(value);if(!Number.isFinite(numeric))return;
    trimTargets.push(Math.max(-20,Math.min(12,Math.round(numeric*2)/2)));renderTrim();drainTrim();
  }
  async function drainTrim() {
    if(trimWorking||busy||!trimTargets.length)return;
    trimWorking=true;
    while(trimTargets.length) {
      trimInFlight=trimTargets.shift();setBusy(true);message('Applying input trim…');
      try { await service.setInputTrim(trimInFlight);message('Input trim synchronized'); }
      catch(error) { trimTargets=[];await service.refresh().catch(()=>{});message(error.message,'error'); }
      finally { trimInFlight=null;setBusy(false); }
    }
    trimWorking=false;renderTrim();
  }
  function bindTrim() {
    const slider=$('#inputTrimRange'); let pointerActive=false;
    $('#inputTrimDown').addEventListener('click',()=>queueTrim(trimValue()-.5));$('#inputTrimUp').addEventListener('click',()=>queueTrim(trimValue()+.5));
    slider.addEventListener('pointerdown',event=>{if(!latest)return;pointerActive=true;trimGesture={id:event.pointerId,start:trimValue()};slider.setPointerCapture(event.pointerId);});
    slider.addEventListener('input',()=>{if(trimGesture){$('#inputTrimNumber').value=Number(slider.value).toFixed(1);$('#inputTrimValue').textContent=formatDb(slider.value);}});
    function finish(event,cancel=false){if(trimGesture?.id!==event.pointerId)return;const gesture=trimGesture,value=Number(slider.value);trimGesture=null;if(!cancel&&value!==gesture.start)queueTrim(value);slider.value=String(trimValue());$('#inputTrimNumber').value=trimValue().toFixed(1);renderTrim();setTimeout(()=>pointerActive=false,0);}
    slider.addEventListener('pointerup',event=>finish(event));slider.addEventListener('pointercancel',event=>finish(event,true));slider.addEventListener('lostpointercapture',event=>finish(event,true));
    slider.addEventListener('change',()=>{if(!pointerActive)queueTrim(slider.value);});
    $('#inputTrimNumber').addEventListener('change',event=>{if(event.target.value===''){event.target.value=trimValue().toFixed(1);return;}const value=Math.round(Math.max(-20,Math.min(12,Number(event.target.value)))*2)/2;event.target.value=value.toFixed(1);queueTrim(value);});
    $('#inputTrimUse').addEventListener('click',useInputHeadroom);
  }
  function drawSpectrum() {
    const canvas = $('#inputScope'); if (!$('#analyzerToggle').checked) { canvas.hidden = true; return; } canvas.hidden = false;
    const ctx = canvas.getContext('2d'); const width = canvas.width; const height = canvas.height; ctx.clearRect(0, 0, width, height); const top = 18, bottom = 5, gap = Math.max(2, Math.min(4, width / 360)), bar = Math.max(4, (width - gap * (spectrumFrequencies.length - 1) - 4) / spectrumFrequencies.length), part = 4, partGap = 2, count = Math.floor((height - top - bottom) / (part + partGap));
    spectrumFrequencies.forEach((frequency, index) => { const x = 2 + index * (bar + gap); const active = Math.max(0, Math.min(count, Math.round((clamp(spectrumLevels[index], -80, 0) + 80) / 80 * count))); if (bar >= 13 || index % 2 === 0) { ctx.fillStyle = 'rgba(235,244,246,.40)'; ctx.fillText(frequency >= 1000 ? `${frequency / 1000}k` : frequency, x + bar / 2, 7); } for (let p = 0; p < count; p += 1) { const y = height - bottom - part - p * (part + partGap); ctx.fillStyle = p < active ? `hsl(${214 - 164 * p / count},${58 + 24 * p / count}%,${55 + 5 * p / count}%)` : 'rgba(8,18,26,.82)'; ctx.fillRect(x, y, bar, part); } });
  }
  async function updateSpectrum() { if (spectrumBusy || !$('#analyzerToggle').checked) return; spectrumBusy = true; try { const raw = await window.EStackDSPBridge.spectrumCommand('GetPlaybackSignalPeak'); if (Array.isArray(raw)) spectrumLevels = spectrumFrequencies.map((_, index) => Math.max(Number(raw[index * 2] ?? -80), Number(raw[index * 2 + 1] ?? -80))); drawSpectrum(); } catch (_) { /* Live spectrum remains empty while its service is unavailable. */ } finally { spectrumBusy = false; } }
  async function init() {
    window.addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==window.parent||event.data?.type!=='estack-system-load')return;const value=event.data.load;dspLoad=typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;if(latest)renderSummary();});
    $('#analyzerToggle').addEventListener('change', drawSpectrum); bindTrim(); service.subscribe(next => { latest = next; if (!faderDragging) render(); });
    try { await service.startTelemetry(); spectrumTimer = setInterval(updateSpectrum, 80); updateSpectrum(); } catch (error) { document.body.innerHTML = `<main class="control-page"><section class="ui-panel"><h1>CamillaDSP unavailable</h1><p>${error.message}</p><p>Check the CamillaNode proxy and then use Connections to retry.</p></section></main>`; }
  }
  window.addEventListener('beforeunload', () => { service.stopTelemetry(); if (spectrumTimer) clearInterval(spectrumTimer); });
  init();
})();
