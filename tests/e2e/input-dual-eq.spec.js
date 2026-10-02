const {test,expect}=require('@playwright/test');
const {demo,dsp}=require('./batch-helpers');
const fs=require('fs');
const S=require('../../public/prototypes/estack-ui/shared/domain/input-eq-state');
const F=require('../../public/prototypes/estack-ui/shared/domain/graphic-eq-fit');
const M=require('../../public/prototypes/estack-ui/shared/domain/input-processing-model');

test('Graphic EQ imports fixed targets and sampled PEQ text without changing Parametric EQ',async({page,request})=>{
  await demo(request);const original=await dsp('GetConfigJson'),volume=await dsp('GetVolume');
  try {
    await page.goto('/estack-dsp/?transport=camillanode#input-processing');
    await expect.poll(()=>page.frames().some(f=>f.url().includes('/input-processing/page.html'))).toBe(true);
    const frame=page.frames().find(f=>f.url().includes('/input-processing/page.html'));
    await expect(frame.locator('#inputState')).toHaveText('EQ synchronized');
    await frame.locator('#geqTab').click();await frame.locator('#geqPresets').click();await frame.locator('#geqImportPreset').click();
    const fixed=F.FREQUENCIES.map((freq,i)=>`Filter ${i+1}: ON PK Fc ${freq} Hz Gain ${F.ACOUSTIC[i]} dB Q 0.7`).join('\n');
    await frame.locator('#importFile').setInputFiles({name:'acoustic.txt',mimeType:'text/plain',buffer:Buffer.from(fixed)});
    await frame.locator('#parseImport').click();
    await expect(frame.locator('#importStatus')).toContainText('Fixed-frequency target gains');
    await expect(frame.locator('#importPreview div')).toHaveCount(10);
    await frame.locator('#applyImport').click();await expect(frame.locator('#importStatus')).toContainText('imported to GEQ');
    let config=await dsp('GetConfigJson');expect(S.validate(config).geq.targets).toEqual(F.ACOUSTIC);
    expect(config.devices).toEqual(original.devices);expect(config.mixers).toEqual(original.mixers);
    for(const name of M.GLOBAL_EQ_SLOT_NAMES)expect(config.filters[name]).toEqual(original.filters[name]);
    await frame.locator('[data-dialog-close="importDialog"]').click();
    await frame.locator('#geqImport').click();
    await frame.locator('#importText').fill('Filter 1: ON PK Fc 100 Hz Gain 3 dB Q 1');
    await frame.locator('#parseImport').click();await expect(frame.locator('#importStatus')).toContainText('PEQ response sampled');
    const expected=F.FREQUENCIES.map(freq=>Math.round(M.responseAt({slot:'GLOBAL_EQ_01',type:'Peaking',frequency:100,gain:3,q:1},freq,original.devices.samplerate)*10)/10);
    await frame.locator('#applyImport').click();await expect(frame.locator('#importStatus')).toContainText('imported to GEQ');
    config=await dsp('GetConfigJson');expect(S.validate(config).geq.targets).toEqual(expected);
    for(const name of M.GLOBAL_EQ_SLOT_NAMES)expect(config.filters[name]).toEqual(original.filters[name]);
    expect(config.devices).toEqual(original.devices);expect(config.mixers).toEqual(original.mixers);
    expect(await dsp('GetVolume')).toBe(volume);
  } finally {await dsp({SetConfigJson:JSON.stringify(original)});await dsp({SetVolume:volume});expect(await dsp('GetConfigJson')).toEqual(original);}
});
test('independent input EQ processors, target presets, actual pipeline and full system recall',async({page,request})=>{
  await demo(request);const original=await dsp('GetConfigJson'),volume=await dsp('GetVolume');
  const files=['savedConfigs.dat','startupConfig.json'],bytes=files.map(f=>fs.existsSync(f)?fs.readFileSync(f):null);
  page.on('dialog',d=>d.accept());const errors=[];page.on('pageerror',e=>errors.push(e.message));
  try {
    await page.goto('/estack-dsp/?transport=camillanode#input-processing');
    await expect.poll(()=>page.frames().some(f=>f.url().includes('/input-processing/page.html'))).toBe(true);
    const frame=page.frames().find(f=>f.url().includes('/input-processing/page.html'));
    await expect(frame.locator('#inputState')).toHaveText('EQ synchronized');
    const beforeTabs=await dsp('GetConfigJson');
    await frame.locator('#geqTab').click();await expect(frame.locator('#geqEditor')).toBeVisible();await expect(frame.locator('#eqCanvas')).toBeVisible();
    await frame.locator('#peqTab').click();await frame.locator('#geqTab').click();expect(await dsp('GetConfigJson')).toEqual(beforeTabs);
    await frame.locator('#geqPresets').click();await frame.locator('[data-geq-preset="wiim-acoustic"]').click();await frame.locator('#geqLoadPreset').click();
    await expect(frame.locator('#geqPresetStatus')).toContainText('loaded');
    await frame.locator('[data-dialog-close="geqPresetDialog"]').click();
    const acoustic=await dsp('GetConfigJson');expect(S.validate(acoustic).geq.targets).toEqual(F.ACOUSTIC);
    expect(acoustic.devices).toEqual(original.devices);expect(acoustic.mixers).toEqual(original.mixers);
    for(const name of Object.keys(original.filters).filter(name=>name!==S.STATE&&!S.GEQ_NAMES.includes(name))) expect(acoustic.filters[name]).toEqual(original.filters[name]);
    expect(acoustic.pipeline.findIndex(s=>s.description===S.GEQ_STEP)).toBeLessThan(acoustic.pipeline.findIndex(s=>s.type==='Mixer'));
    await expect(frame.locator('#geqToggle')).toHaveText('Graphic EQ · ON');
    await frame.locator('#geqPresets').click();await frame.locator('#geqPresetName').fill('Acoustic target test');await frame.locator('#geqSavePreset').click();await expect(frame.locator('#geqPresetStatus')).toContainText('saved');await frame.locator('[data-dialog-close="geqPresetDialog"]').click();
    await frame.locator('#geqReset').click();await expect.poll(async()=>S.read(await dsp('GetConfigJson')).geq.targets).toEqual(Array(10).fill(0));
    await frame.locator('#geqPresets').click();await frame.locator('.preset-item',{hasText:'Acoustic target test'}).click();await frame.locator('#geqLoadPreset').click();await expect(frame.locator('#geqPresetStatus')).toContainText('loaded');await frame.locator('[data-dialog-close="geqPresetDialog"]').click();
    await frame.locator('#peqTab').click();
    if(!S.read(await dsp('GetConfigJson')).peq.enabled){await frame.locator('#eqToggleAll').click();await expect(frame.locator('#inputState')).toHaveText('EQ synchronized');}
    if(S.read(await dsp('GetConfigJson')).peq.disabled.includes('GLOBAL_EQ_01')){await frame.locator('#bandToggle').click();await expect(frame.locator('#inputState')).toHaveText('EQ synchronized');}
    const gain=frame.locator('[data-input-slot="GLOBAL_EQ_01"][data-field="gain"]');await gain.fill('-3');await gain.press('Tab');await expect(frame.locator('#inputState')).toHaveText('EQ synchronized');
    await frame.locator('#delayNumber').fill('1');await frame.locator('#delayNumber').press('Tab');await expect(frame.locator('#inputState')).toHaveText('EQ synchronized');
    const both=await dsp('GetConfigJson');
    for(const name of S.GEQ_NAMES) expect(both.filters[name]).toEqual(acoustic.filters[name]);
    expect(both.pipeline.filter(s=>S.STEPS.includes(s.description)).map(s=>s.description)).toEqual(S.STEPS);
    console.log('Demo input chain:',both.pipeline.map(s=>s.description||s.name||s.type).join(' → '));
    await frame.locator('#presetEq').click();await frame.locator('#presetName').fill('PEQ isolation test');await frame.locator('#savePreset').click();await expect(frame.locator('#presetStatus')).toContainText('saved');await frame.locator('[data-dialog-close="presetDialog"]').click();
    await gain.fill('-6');await gain.press('Tab');await expect.poll(async()=> (await dsp('GetConfigJson')).filters.GLOBAL_EQ_01.parameters.gain).toBe(-6);
    await frame.locator('#presetEq').click();await frame.locator('.preset-item',{hasText:'PEQ isolation test'}).click();await frame.locator('#loadPreset').click();await expect(frame.locator('#presetStatus')).toContainText('loaded');await frame.locator('[data-dialog-close="presetDialog"]').click();
    const restoredPeq=await dsp('GetConfigJson');for(const name of S.GEQ_NAMES) expect(restoredPeq.filters[name]).toEqual(both.filters[name]);
    for(const [geq,peq] of [[false,true],[false,false],[true,false],[true,true]]) {
      if(S.read(await dsp('GetConfigJson')).geq.enabled!==geq)await frame.locator('#geqToggle').click();
      await expect(frame.locator('#inputState')).toHaveText('EQ synchronized');
      if(S.read(await dsp('GetConfigJson')).peq.enabled!==peq)await frame.locator('#eqToggleAll').click();
      await expect(frame.locator('#inputState')).toHaveText('EQ synchronized');
      const config=await dsp('GetConfigJson');expect(S.validate(config).geq.enabled).toBe(geq);expect(S.read(config).peq.enabled).toBe(peq);
      expect(config.pipeline.some(s=>s.description===S.GEQ_STEP)).toBe(geq);expect(config.pipeline.some(s=>s.description===S.STEPS[1])).toBe(peq);
    }
    const captured=await request.post('/api/system-presets/capture',{data:{name:'Dual input EQ test'}});expect(captured.ok()).toBe(true);const {id}=await captured.json();
    const saved=(await (await request.get('/getConfigFile')).json()).find(r=>r.id===id);
    expect(S.read(saved.data.processing).geq.targets).toEqual(F.ACOUSTIC);
    await frame.locator('#geqTab').click();await frame.locator('#geqReset').click();await expect(frame.locator('#inputState')).toHaveText('EQ synchronized');await frame.locator('#eqToggleAll').click();await expect(frame.locator('#inputState')).toHaveText('EQ synchronized');
    expect((await request.post('/api/system-presets/apply',{data:{id}})).ok()).toBe(true);
    const recalled=await dsp('GetConfigJson');expect(recalled.devices).toEqual(original.devices);expect(recalled.mixers).toEqual(original.mixers);expect(S.validate(recalled).geq.targets).toEqual(F.ACOUSTIC);expect(S.read(recalled).peq.enabled).toBe(true);
    await page.reload();
    await expect.poll(()=>page.frames().some(f=>f.url().includes('/input-processing/page.html'))).toBe(true);
    const loaded=page.frames().find(f=>f.url().includes('/input-processing/page.html'));
    await expect(loaded.locator('#geqToggle')).toHaveText('Graphic EQ · ON');await loaded.locator('#geqTab').click();await expect(loaded.locator('[data-geq-number="0"]')).toHaveValue('5');
    await page.setViewportSize({width:390,height:844});
    await expect(loaded.locator('[data-geq-range="0"]')).toBeVisible();
    expect(await loaded.locator('body').evaluate(el=>el.scrollWidth<=innerWidth+1)).toBe(true);
    await loaded.locator('[data-geq-number="0"]').fill('5.1');
    await loaded.locator('[data-geq-number="0"]').press('Tab');
    await expect.poll(async()=>S.validate(await dsp('GetConfigJson')).geq.targets[0]).toBe(5.1);
    const edited=await dsp('GetConfigJson');
    expect(edited.filters.GLOBAL_EQ_01).toEqual(recalled.filters.GLOBAL_EQ_01);
    expect(edited.devices).toEqual(original.devices);expect(edited.mixers).toEqual(original.mixers);
    expect(await dsp('GetVolume')).toBe(volume);expect(errors).toEqual([]);
  } finally {
    await dsp({SetConfigJson:JSON.stringify(original)});await dsp({SetVolume:volume});
    files.forEach((f,i)=>bytes[i]===null?fs.existsSync(f)&&fs.unlinkSync(f):fs.writeFileSync(f,bytes[i]));
    expect(await dsp('GetConfigJson')).toEqual(original);
  }
});
