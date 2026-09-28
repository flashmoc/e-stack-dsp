const { test, expect } = require('@playwright/test');
const { demo, dsp, frame } = require('./batch-helpers');
const fs = require('fs');

test('Master mute preserves volume; muted way has no false limiter; protection is paired', async ({ page, request }) => {
  await demo(request);
  const original = await dsp('GetConfigJson'), volume = await dsp('GetVolume'), mute = await dsp('GetMute');
  try {
    const f = await frame(page, 'control');
    await expect(f.locator('[data-mute="master"]')).toBeEnabled();
    await f.locator('[data-mute="master"]').click();
    await expect.poll(() => dsp('GetMute')).toBe(!mute);
    expect(await dsp('GetVolume')).toBe(volume);
    expect(await dsp('GetConfigJson')).toEqual(original);
    await f.locator('[data-mute="master"]').click();
    await expect.poll(() => dsp('GetMute')).toBe(mute);
    if (!original.filters.sub_gain.parameters.mute) await f.locator('[data-mute="0"]').click();
    await expect(f.locator('.way-sub .strip-protection')).toHaveText('—');
    await expect(f.locator('[data-mute="0"]')).toHaveText('MUTED');
    await page.setViewportSize({ width:390, height:844 });
    await page.screenshot({ path:'test-results/control-mute-mobile.png', fullPage:true });
    const out = await frame(page, 'output-processing');
    await expect(out.locator('#outputState')).toContainText('READY');
    await out.locator('#systemEdit').click();
    await out.locator('[data-value="limiter"]').fill('-10');
    await out.locator('[data-value="limiter"]').press('Tab');
    await expect.poll(async () => (await dsp('GetConfigJson')).filters.sub_hard_limit.parameters.clip_limit).toBe(-10);
    const actual = await dsp('GetConfigJson');
    expect(actual.processors.sub_protection.parameters.threshold).toBe(-11);
    expect(actual.devices).toEqual(original.devices);
    expect(actual.mixers).toEqual(original.mixers);
    expect(actual.pipeline).toEqual(original.pipeline);
  } finally {
    await dsp({ SetConfigJson:JSON.stringify(original) });
    await dsp({ SetVolume:volume }); await dsp({ SetMute:mute });
    expect(await dsp('GetConfigJson')).toEqual(original);
  }
});

test('Advanced stages edits, verifies apply, preserves drafts and supports mixer controls', async ({ page, request }) => {
  await demo(request);
  const original = await dsp('GetConfigJson'), volume = await dsp('GetVolume');
  page.on('dialog', dialog => dialog.accept());
  try {
    const f = await frame(page, 'advanced');
    await f.locator('[data-kind="filters"]').click();
    await expect(f.locator('#component')).toBeVisible();
    await f.locator('#component').selectOption('sub_gain');
    const gain = f.getByRole('spinbutton', { name:'Gain · dB', exact:true });
    await gain.fill(String(original.filters.sub_gain.parameters.gain - .1));
    const field = await gain.elementHandle();
    await page.waitForTimeout(5200);
    expect(await field.evaluate(el => el.isConnected)).toBe(true);
    expect(await dsp('GetConfigJson')).toEqual(original);
    await f.locator('#applyEdit').click();
    await expect(f.locator('#notice')).toHaveText('Applied and verified.');
    await expect.poll(async () => (await dsp('GetConfigJson')).filters.sub_gain.parameters.gain).toBeCloseTo(original.filters.sub_gain.parameters.gain - .1);
    expect(await dsp('GetVolume')).toBe(volume);
    await f.locator('[data-kind="mixers"]').click();
    await expect(f.locator('.mixer-source')).not.toHaveCount(0);
    await f.locator('[data-kind="processors"]').click();
    await expect(f.locator('#component')).toBeVisible();
    await f.locator('[data-kind="pipeline"]').click();
    await expect(f.locator('.signal-path')).toHaveCount(original.devices.playback.channels);
    for (const width of [1440,390]) {
      await page.setViewportSize({width,height:width===390?844:900});
      await f.locator('[data-kind="filters"]').click();
      await f.locator('#component').selectOption('sub_gain');
      expect(await f.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({path:`test-results/advanced-editor-${width}.png`,fullPage:true});
    }
  } finally {
    await dsp({ SetConfigJson:JSON.stringify(original) }); await dsp({ SetVolume:volume });
    expect(await dsp('GetConfigJson')).toEqual(original);
  }
});

test('System preset rename keeps identity and startup selection without DSP writes', async ({ page, request }) => {
  await demo(request);
  const files = ['savedConfigs.dat','startupConfig.json'];
  const backup = files.map(file => fs.existsSync(file) ? fs.readFileSync(file) : null);
  const original = await dsp('GetConfigJson');
  try {
    const capture = await request.post('/api/system-presets/capture', {data:{name:'Rename E2E'}});
    expect(capture.ok()).toBe(true); const {id} = await capture.json();
    await request.post('/api/startup-config', {data:{mode:'specific',configId:id}});
    const f = await frame(page,'system-presets');
    page.on('dialog', d => d.accept('Renamed E2E'));
    await f.locator(`.preset-row[data-id="${id}"] [data-action="rename"]`).click();
    await expect(f.locator(`.preset-row[data-id="${id}"] h3`)).toHaveText('Renamed E2E');
    const state = await (await request.get('/api/startup-config')).json();
    expect(state.configId).toBe(id); expect(state.configName).toBe('Renamed E2E');
    expect(await dsp('GetConfigJson')).toEqual(original);
  } finally { files.forEach((file,i) => backup[i] ? fs.writeFileSync(file,backup[i]) : fs.existsSync(file) && fs.unlinkSync(file)); }
});
