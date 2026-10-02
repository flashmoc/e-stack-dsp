'use strict';

const { test, expect } = require('@playwright/test');
const WebSocket = require('ws');

const baseURL = process.env.ESTACK_E2E_BASE_URL || 'http://127.0.0.1:8080';
const target = new URL(baseURL);
const globalNames = Array.from({ length: 10 }, (_, index) => `GLOBAL_EQ_${String(index + 1).padStart(2, '0')}`);
const GLOBAL_STEP = 'E-Stack global input EQ';
const DELAY_STEP = 'E-Stack input delay';
const DELAY_FILTER = 'ESTACK_INPUT_DELAY';
const clone = value => JSON.parse(JSON.stringify(value));

function assertLocalLinuxDemo() {
  if (process.platform !== 'linux') throw new Error('E-Stack E2E must run inside the Linux Dev Container.');
  if (!['127.0.0.1', 'localhost', '::1'].includes(target.hostname)) throw new Error(`E-Stack E2E refuses non-local target '${baseURL}'.`);
}
function dspCommand(command, timeoutMs = 5_000) {
  const name = typeof command === 'string' ? command : Object.keys(command || {})[0];
  const endpoint = `${target.protocol === 'https:' ? 'wss:' : 'ws:'}//${target.host}/ws/dsp`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint); const finish = (error, value) => { clearTimeout(timer); socket.removeAllListeners(); try { socket.close(); } catch (_) {} error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(new Error(`${name} timed out through CamillaNode /ws/dsp.`)), timeoutMs);
    socket.once('error', error => finish(error)); socket.once('open', () => socket.send(JSON.stringify(command)));
    socket.on('message', raw => { let reply; try { reply = JSON.parse(String(raw)); } catch (_) { return; } if (!Object.prototype.hasOwnProperty.call(reply, name)) return; const result = reply[name] || {}; if (result.result !== 'Ok') return finish(new Error(result.value || `${name} failed.`)); let value = result.value; if (name === 'GetConfigJson' && typeof value === 'string') { try { value = JSON.parse(value); } catch (_) { return finish(new Error('CamillaDSP returned invalid configuration JSON.')); } } finish(null, value); });
  });
}
async function requireDemoRuntime(request) {
  assertLocalLinuxDemo(); const response = await request.get('/api/runtime'); expect(response.ok()).toBeTruthy(); expect(await response.json()).toMatchObject({ mode: 'demo', httpPort: 8080, dspPort: 1234, spectrumPort: 6413 });
}
async function loadSavedConfigs(request) {
  const response = await request.get('/getConfigFile'); expect(response.ok()).toBeTruthy();
  const records = await response.json(); expect(Array.isArray(records)).toBeTruthy(); return records;
}
async function restoreSavedConfigs(request, records) {
  const current = await request.get('/getConfigFile');
  const response = await request.post('/saveConfigFile', { data: records, headers: { 'If-Match': current.headers().etag } }); expect(response.ok()).toBeTruthy();
}
async function inputFrame(page) {
  await expect.poll(() => page.frames().some(frame => new URL(frame.url()).pathname.endsWith('/pages/input-processing/page.html'))).toBeTruthy();
  return page.frames().find(frame => new URL(frame.url()).pathname.endsWith('/pages/input-processing/page.html'));
}
function eqProtectedView(config) {
  const next = clone(config); globalNames.forEach(name => delete next.filters[name]); delete next.filters.ESTACK_INPUT_EQ_STATE; next.pipeline = next.pipeline.filter(step => step.description !== GLOBAL_STEP); return next;
}
function delayProtectedView(config) {
  const next = clone(config); delete next.filters[DELAY_FILTER]; next.pipeline = next.pipeline.filter(step => step.description !== DELAY_STEP); return next;
}
function assertEqScope(before, after, expectedGain) {
  expect(eqProtectedView(after)).toEqual(eqProtectedView(before));
  expect(after.filters.GLOBAL_EQ_01.parameters.gain).toBeCloseTo(expectedGain, 6);
  const disabled = require('../../public/prototypes/estack-ui/shared/domain/input-eq-state').read(before).peq.disabled;
  const expectedNames = globalNames.filter(name => !disabled.includes(name) && Number(name === 'GLOBAL_EQ_01' ? expectedGain : before.filters[name]?.parameters?.gain || 0) !== 0);
  for (const name of globalNames.slice(1)) if (before.filters[name]) expect(after.filters[name]).toEqual(before.filters[name]);
  const step = after.pipeline.find(entry => entry.description === GLOBAL_STEP); expect(step).toMatchObject({ type: 'Filter', channels: [0, 1], names: expectedNames, bypassed: false });
  expect(after.pipeline.indexOf(step)).toBeLessThan(after.pipeline.findIndex(entry => entry.type === 'Mixer'));
}

test.describe('Input Processing live CamillaNode demo', () => {
  test('round trips Global EQ and Input Delay through the product and restores the exact demo configuration', async ({ page, request }) => {
    await requireDemoRuntime(request); const original = await dspCommand('GetConfigJson'); const originalSavedConfigs = await loadSavedConfigs(request); const originalEq = original.filters.GLOBAL_EQ_01?.parameters?.gain ?? 0; expect(Number(originalEq)).toBeGreaterThanOrEqual(-12); expect(Number(originalEq)).toBeLessThanOrEqual(12);
    expect(Number(original.filters[DELAY_FILTER]?.parameters?.delay || 0)).toBe(0);
    const testGain = Number(originalEq) >= 11.8 ? Number((Number(originalEq) - .2).toFixed(1)) : Number((Number(originalEq) + .2).toFixed(1));
    const secondGain = testGain >= 11.8 ? Number((testGain - .2).toFixed(1)) : Number((testGain + .2).toFixed(1));
    const keys = globalNames.map(name => `estack.globalEq.disabled.${name}`); const storage = {};
    await page.goto('/estack-dsp/?transport=camillanode#input-processing'); keys.forEach(key => { storage[key] = null; });
    for (const key of keys) storage[key] = await page.evaluate(item => window.localStorage.getItem(item), key);
    await page.evaluate(items => items.forEach(key => window.localStorage.removeItem(key)), keys); await page.reload();
    let frame = await inputFrame(page); const temporaryPresetName = `Stage 2B E2E ${Date.now()}`; let temporaryPresetId = null, baseline = original;
    page.on('dialog', dialog => dialog.accept());
    try {
      const state = require('../../public/prototypes/estack-ui/shared/domain/input-eq-state').read(original).peq;
      if (!state.enabled) { await frame.locator('#eqToggleAll').click(); await expect(frame.locator('#inputState')).toHaveText('EQ synchronized'); }
      if (state.disabled.includes('GLOBAL_EQ_01')) { await frame.locator('#bandToggle').click(); await expect(frame.locator('#inputState')).toHaveText('EQ synchronized'); }
      baseline = await dspCommand('GetConfigJson');
      await expect(page.locator('html')).toHaveAttribute('data-transport', 'live'); await expect(page.locator('.shell-context')).toContainText('DSP ONLINE');
      await expect.poll(() => frame.evaluate(() => ({ mode: window.EStackDSPBridge?.mode, page: document.documentElement.dataset.prototypePage, mock: !!window.EStackPrototypeDSP }))).toEqual({ mode: 'camillanode', page: 'input-processing', mock: false });
      await expect(frame.locator('.eq-band')).toHaveCount(10); await expect(frame.locator('[data-range]')).toHaveCount(3); await expect(frame.locator('#spectrumState')).toHaveClass(/is-live/);
      const gain = frame.locator('[data-input-slot="GLOBAL_EQ_01"][data-field="gain"]'); await gain.fill(String(testGain)); await gain.press('Tab');
      await expect.poll(async () => Number((await dspCommand('GetConfigJson')).filters.GLOBAL_EQ_01?.parameters?.gain)).toBeCloseTo(testGain, 6);
      const eqChanged = await dspCommand('GetConfigJson'); assertEqScope(baseline, eqChanged, testGain);
      const delay = frame.locator('#delayNumber'); await delay.fill('1.0'); await delay.press('Tab');
      await expect.poll(async () => Number((await dspCommand('GetConfigJson')).filters[DELAY_FILTER]?.parameters?.delay)).toBeCloseTo(1, 6);
      const delayChanged = await dspCommand('GetConfigJson'); expect(delayProtectedView(delayChanged)).toEqual(delayProtectedView(eqChanged)); expect(delayChanged.filters.GLOBAL_EQ_01).toEqual(eqChanged.filters.GLOBAL_EQ_01); expect(delayChanged.pipeline.find(step => step.description === GLOBAL_STEP)).toEqual(eqChanged.pipeline.find(step => step.description === GLOBAL_STEP)); expect(delayChanged.pipeline.find(step => step.description === DELAY_STEP)).toMatchObject({ type: 'Filter', channels: [0, 1], names: [DELAY_FILTER], bypassed: false });
      await gain.fill(String(secondGain)); await gain.press('Tab'); await expect.poll(async () => Number((await dspCommand('GetConfigJson')).filters.GLOBAL_EQ_01?.parameters?.gain)).toBeCloseTo(secondGain, 6);
      const eqWithDelay = await dspCommand('GetConfigJson'); assertEqScope(delayChanged, eqWithDelay, secondGain); expect(eqWithDelay.filters[DELAY_FILTER]).toEqual(delayChanged.filters[DELAY_FILTER]); expect(eqWithDelay.pipeline.find(step => step.description === DELAY_STEP)).toEqual(delayChanged.pipeline.find(step => step.description === DELAY_STEP));
      await delay.fill('0'); await delay.press('Tab'); await expect.poll(async () => (await dspCommand('GetConfigJson')).filters[DELAY_FILTER]).toBeUndefined();
      const delayRemoved = await dspCommand('GetConfigJson'); expect(delayProtectedView(delayRemoved)).toEqual(delayProtectedView(eqWithDelay));
      await gain.fill(String(originalEq)); await gain.press('Tab'); await expect.poll(async () => (await dspCommand('GetConfigJson')).filters.GLOBAL_EQ_01?.parameters?.gain ?? 0).toBeCloseTo(Number(originalEq), 6);
      expect(await dspCommand('GetConfigJson')).toEqual(baseline);
      console.log(`Input E2E GLOBAL_EQ_01 gain: ${Number(originalEq).toFixed(1)} dB -> ${testGain.toFixed(1)} dB -> ${Number(originalEq).toFixed(1)} dB`); console.log('Input E2E delay: 0.0 ms -> 1.0 ms -> 0.0 ms');

      await frame.locator('#importEq').click();
      await frame.locator('#importText').fill('Filter 1: ON PK Fc 63 Hz Gain 2.5 dB Q 0.70\nFilter 2: OFF HS Fc 8000 Hz Gain -1.5 dB Q 0.90');
      await frame.locator('#parseImport').click(); await expect(frame.locator('#importStatus')).toContainText('2 bands detected');
      await frame.locator('#applyImport').click(); await expect(frame.locator('#importStatus')).toContainText('2 bands imported');
      await expect.poll(async () => Number((await dspCommand('GetConfigJson')).filters.GLOBAL_EQ_01?.parameters?.gain)).toBeCloseTo(2.5, 6);
      const imported = await dspCommand('GetConfigJson');
      expect(eqProtectedView(imported)).toEqual(eqProtectedView(baseline));
      expect(imported.filters.GLOBAL_EQ_02).toMatchObject({ type: 'Biquad', parameters: { type: 'Highshelf', freq: 8000, gain: -1.5, q: .9 } });
      expect(imported.filters.GLOBAL_EQ_03).toBeUndefined();
      expect(imported.pipeline.find(step => step.description === GLOBAL_STEP)?.names).toEqual(['GLOBAL_EQ_01']);
      expect(imported.filters[DELAY_FILTER]).toEqual(baseline.filters[DELAY_FILTER]);
      expect(imported.pipeline.find(step => step.description === DELAY_STEP)).toEqual(baseline.pipeline.find(step => step.description === DELAY_STEP));
      expect(await frame.evaluate(() => window.EStackInputProcessingService.snapshot.eq.peq.disabled)).toContain('GLOBAL_EQ_02');
      console.log('Input E2E import: GLOBAL_EQ_01 +2.5 dB, GLOBAL_EQ_02 −1.5 dB disabled; GLOBAL_EQ_03…10 reset.');

      await frame.locator('[data-dialog-close="importDialog"]').click(); await frame.locator('#presetEq').click();
      await frame.locator('#presetName').fill(temporaryPresetName); await frame.locator('#savePreset').click(); await expect(frame.locator('#presetStatus')).toContainText('saved');
      const savedAfterCreate = await loadSavedConfigs(request); const temporaryPreset = savedAfterCreate.find(record => record.type === 'global-eq' && record.name === temporaryPresetName);
      expect(temporaryPreset).toMatchObject({ type: 'global-eq', name: temporaryPresetName, data: { format: 'estack-global-eq-v1' } }); expect(temporaryPreset.data.bands).toHaveLength(10); temporaryPresetId = temporaryPreset.id;
      expect(savedAfterCreate.filter(record => record.id !== temporaryPresetId)).toEqual(originalSavedConfigs);

      await frame.locator('[data-dialog-close="presetDialog"]').click(); const gainAfterImport = frame.locator('[data-input-slot="GLOBAL_EQ_01"][data-field="gain"]'); await gainAfterImport.fill('4.0'); await gainAfterImport.press('Tab');
      await expect.poll(async () => Number((await dspCommand('GetConfigJson')).filters.GLOBAL_EQ_01?.parameters?.gain)).toBeCloseTo(4, 6);
      const altered = await dspCommand('GetConfigJson'); expect(altered.filters[DELAY_FILTER]).toEqual(imported.filters[DELAY_FILTER]); expect(altered.pipeline.find(step => step.description === DELAY_STEP)).toEqual(imported.pipeline.find(step => step.description === DELAY_STEP));
      await frame.locator('#presetEq').click(); await frame.locator(`[data-preset-id="${temporaryPresetId}"]`).click(); await frame.locator('#loadPreset').click();
      await expect.poll(async () => Number((await dspCommand('GetConfigJson')).filters.GLOBAL_EQ_01?.parameters?.gain)).toBeCloseTo(2.5, 6);
      const loaded = await dspCommand('GetConfigJson'); expect(loaded.filters.GLOBAL_EQ_02).toEqual(imported.filters.GLOBAL_EQ_02); expect(loaded.filters[DELAY_FILTER]).toEqual(imported.filters[DELAY_FILTER]); expect(loaded.pipeline.find(step => step.description === DELAY_STEP)).toEqual(imported.pipeline.find(step => step.description === DELAY_STEP));
      await frame.locator('#addPreset').click(); await expect(frame.locator('#presetStatus')).toContainText('1 band');
      const combined = await dspCommand('GetConfigJson');
      expect(combined.filters.GLOBAL_EQ_01).toEqual(loaded.filters.GLOBAL_EQ_01);
      expect(combined.filters.GLOBAL_EQ_02).toEqual(loaded.filters.GLOBAL_EQ_02);
      expect(combined.filters.GLOBAL_EQ_03.parameters).toMatchObject({ freq: 63, gain: 2.5, q: .7 });
      expect(combined.pipeline.find(step => step.description === GLOBAL_STEP).names).toEqual(['GLOBAL_EQ_01', 'GLOBAL_EQ_03']);
      expect(eqProtectedView(combined)).toEqual(eqProtectedView(baseline));
      await frame.locator('[data-dialog-close="presetDialog"]').click();
      await frame.locator('#eqToggleAll').click(); await expect(frame.locator('#eqToggleAll')).toHaveText('Parametric EQ · OFF');
      const bypassed = await dspCommand('GetConfigJson');
      expect(bypassed.pipeline.some(step => step.description === GLOBAL_STEP)).toBeFalsy();
      for (const name of globalNames) expect(bypassed.filters[name]).toEqual(combined.filters[name]);
      expect(eqProtectedView(bypassed)).toEqual(eqProtectedView(baseline));
      await frame.locator('#eqToggleAll').click(); await expect(frame.locator('#eqToggleAll')).toHaveText('Parametric EQ · ON');
      const reenabled = await dspCommand('GetConfigJson');
      for (const name of globalNames) expect(reenabled.filters[name]).toEqual(combined.filters[name]);
      expect(reenabled.pipeline.find(step => step.description === GLOBAL_STEP).names).toEqual(['GLOBAL_EQ_01', 'GLOBAL_EQ_03']);
      await frame.locator('#presetEq').click(); await frame.locator(`[data-preset-id="${temporaryPresetId}"]`).click();
      await frame.locator('#deletePreset').click(); await expect(frame.locator('#presetStatus')).toContainText('deleted');
      const savedAfterDelete = await loadSavedConfigs(request); expect(savedAfterDelete.some(record => record.id === temporaryPresetId)).toBeFalsy(); expect(savedAfterDelete).toEqual(originalSavedConfigs);
      console.log(`Input E2E preset: saved, restored and deleted '${temporaryPresetName}'.`);
    } finally {
      const live = await dspCommand('GetConfigJson'); if (JSON.stringify(live) !== JSON.stringify(original)) await dspCommand({ SetConfigJson: JSON.stringify(original) });
      expect(await dspCommand('GetConfigJson')).toEqual(original);
      if (JSON.stringify(await loadSavedConfigs(request)) !== JSON.stringify(originalSavedConfigs)) await restoreSavedConfigs(request, originalSavedConfigs);
      expect(await loadSavedConfigs(request)).toEqual(originalSavedConfigs);
      await page.evaluate(items => items.forEach(({ key, value }) => value === null ? window.localStorage.removeItem(key) : window.localStorage.setItem(key, value)), Object.entries(storage).map(([key, value]) => ({ key, value })));
    }
  });
});

test.describe('Input EQ touch workspace', () => {
  test.use({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true });
  test('keeps controls stable, queues edits, and commits touch previews only on release', async ({page,request}) => {
    test.setTimeout(90000);await requireDemoRuntime(request);const original=await dspCommand('GetConfigJson');
    let writes=0,hold=false,release=null;
    await page.route('**/api/input-processing',async route=>{writes++;const response=await route.fetch();if(hold){hold=false;await new Promise(resolve=>{release=resolve;});}await route.fulfill({response});});
    page.on('dialog',dialog=>dialog.accept());const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto('/estack-dsp/?transport=camillanode#input-processing');const frame=await inputFrame(page);
    const cdp=await page.context().newCDPSession(page);
    const touch=(type,x,y)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:['touchEnd','touchCancel'].includes(type)?[]:[{x,y,id:1,radiusX:7,radiusY:7,force:1}]});
    const settled=()=>expect(frame.locator('#inputState')).toHaveText('EQ synchronized');
    const drag=async(selector,from,to,cancel=false)=>{
      const el=frame.locator(selector);await el.evaluate(e=>e.scrollIntoView({block:'center'}));const box=await el.boundingBox();expect(box.height).toBeGreaterThanOrEqual(44);
      const before=writes,scroll=await frame.evaluate(()=>scrollY),value=await el.inputValue();const y=box.y+box.height/2+10;
      await touch('touchStart',box.x+box.width*from,y);for(let i=1;i<=6;i++)await touch('touchMove',box.x+box.width*(from+(to-from)*i/6),y);
      expect(writes).toBe(before);expect(await frame.evaluate(()=>scrollY)).toBe(scroll);expect(await el.inputValue()).not.toBe(value);
      await touch(cancel?'touchCancel':'touchEnd');if(cancel){await expect(el).toHaveValue(value);expect(writes).toBe(before);}else await expect.poll(()=>writes).toBe(before+1);
    };
    try {
      await settled();await expect(frame.locator('.eq-band')).toHaveCount(10);
      await frame.evaluate(()=>{window.inputNodes=[document.querySelector('#eqInspector'),...document.querySelectorAll('[data-input-slot]'),...document.querySelectorAll('[data-range]')];});
      for(const slot of globalNames){const band=frame.locator(`[data-band="${slot}"]`);await band.scrollIntoViewIfNeeded();await band.tap();await expect(band).toHaveAttribute('aria-current','true');await expect(frame.locator('#bandTitle')).toHaveText(`Band ${slot.slice(-2)}`);}
      await frame.locator('[data-band="GLOBAL_EQ_04"]').scrollIntoViewIfNeeded();await frame.locator('[data-band="GLOBAL_EQ_04"]').tap();
      hold=true;await drag('[data-range="gain"]',.5,.65);await expect.poll(()=>typeof release).toBe('function');
      const q=frame.locator('[data-input-slot][data-field="q"]');await q.fill('1.3');await q.dispatchEvent('change');await q.focus();
      const beforeScroll=await frame.evaluate(()=>scrollY);release();await settled();await expect(q).toBeFocused();expect(await frame.evaluate(()=>scrollY)).toBe(beforeScroll);
      expect((await dspCommand('GetConfigJson')).filters.GLOBAL_EQ_04.parameters.q).toBe(1.3);
      await frame.locator('#bandType').selectOption('Lowshelf');await settled();await frame.locator('#bandType').selectOption('Highshelf');await settled();await frame.locator('#bandType').selectOption('Peaking');await settled();
      const freq=frame.locator('[data-input-slot][data-field="frequency"]');await freq.fill('600');await freq.dispatchEvent('change');await settled();
      await frame.locator('#bandToggle').tap();await settled();await expect(frame.locator('[data-band="GLOBAL_EQ_04"]')).toHaveAttribute('data-state','disabled');
      expect((await dspCommand('GetConfigJson')).pipeline.find(step=>step.description===GLOBAL_STEP)?.names||[]).not.toContain('GLOBAL_EQ_04');
      await frame.locator('#bandToggle').tap();await settled();
      await drag('[data-range="frequency"]',.35,.45);await settled();await drag('[data-range="q"]',.1,.3);await settled();await drag('[data-range="gain"]',.6,.7,true);
      const point=frame.locator('[data-point="GLOBAL_EQ_04"]');await point.evaluate(e=>e.scrollIntoView({block:'center'}));let box=await point.boundingBox();let before=writes;
      await touch('touchStart',box.x+22,box.y+22);await touch('touchMove',box.x+52,box.y+12);expect(writes).toBe(before);await expect(frame.locator('#graphReadout')).toContainText('Preview');await touch('touchEnd');await expect.poll(()=>writes).toBe(before+1);await settled();
      await point.evaluate(e=>e.scrollIntoView({block:'center'}));box=await point.boundingBox();before=writes;const bandBefore=(await dspCommand('GetConfigJson')).filters.GLOBAL_EQ_04;
      await touch('touchStart',box.x+22,box.y+22);await touch('touchMove',box.x+12,box.y+32);await touch('touchCancel');expect(writes).toBe(before);expect((await dspCommand('GetConfigJson')).filters.GLOBAL_EQ_04).toEqual(bandBefore);
      await frame.locator('#analyzerSpeed').tap();await expect(frame.locator('#analyzerSpeed')).toHaveText('SLOW');
      await frame.locator('#bandReset').tap();await settled();await expect(frame.locator('[data-band="GLOBAL_EQ_04"]')).toHaveAttribute('data-state','neutral');await expect(frame.locator('#analyzerSpeed')).toHaveText('SLOW');
      await drag('#delayRange',.001,.05);await settled();await frame.locator('#delayNumber').fill('1.2');await frame.locator('#delayNumber').dispatchEvent('change');await settled();
      for(const nudge of [-10,-1,1,10]){await frame.locator(`[data-nudge="${nudge}"]`).tap();await settled();}
      await frame.locator('#delayReset').tap();await settled();await expect(frame.locator('#delayNumber')).toHaveValue('0.0');
      await frame.locator('#eqReset').tap();await settled();expect((await dspCommand('GetConfigJson')).pipeline.some(step=>step.description===GLOBAL_STEP)).toBe(false);
      expect(await frame.evaluate(()=>window.inputNodes.every(el=>el.isConnected))).toBe(true);
      await frame.locator('#importEq').tap();await frame.locator('#importText').fill('Filter 1: ON PK Fc 125 Hz Gain 2 dB Q 0.7');await frame.locator('#parseImport').tap();await expect(frame.locator('#importPreview')).toContainText('125 Hz');await frame.locator('#importText').fill('invalid');await expect(frame.locator('#applyImport')).toBeDisabled();await frame.locator('[data-dialog-close="importDialog"]').tap();
      await frame.locator('#eqInspector').evaluate(el=>el.scrollIntoView({block:'start'}));const oldScroll=await frame.evaluate(()=>scrollY);box=await frame.locator('#bandTitle').boundingBox();
      await touch('touchStart',box.x+10,box.y+20);await touch('touchMove',box.x+10,box.y-80);await touch('touchEnd');await expect.poll(()=>frame.evaluate(()=>scrollY)).not.toBe(oldScroll);
      expect(errors).toEqual([]);
    } finally { if(release)release();await dspCommand({SetConfigJson:JSON.stringify(original)});expect(await dspCommand('GetConfigJson')).toEqual(original); }
  });
});
