const { test, expect } = require('@playwright/test');
const { demo, dsp, frame } = require('./batch-helpers');

test('current-system measurement captures each live HIGH gain and restores the DSP', async ({ page, request }) => {
  await demo(request);
  expect((await (await request.get('/api/measurement-batch/status')).json()).active).toBe(false);
  const original = await dsp('GetConfigJson');
  const volume = await dsp('GetVolume');
  const findHighGain = (config, channel) => {
    const mixerIndex = config.pipeline.findIndex(step => step.type === 'Mixer');
    const names = config.pipeline.slice(mixerIndex + 1).filter(step => step.type === 'Filter' && step.channels?.includes(channel)).flatMap(step => step.names || []);
    return names.find(name => config.filters?.[name]?.type === 'Gain');
  };
  const gainNames = [findHighGain(original, 4), findHighGain(original, 5)];
  expect(gainNames.every(Boolean)).toBe(true);
  const setHigh = async value => {
    const config = await dsp('GetConfigJson');
    for (const name of gainNames) config.filters[name].parameters.gain = value;
    await dsp({ SetConfigJson: JSON.stringify(config) });
    await expect.poll(async () => (await dsp('GetConfigJson')).filters[gainNames[0]].parameters.gain).toBe(value);
    return await dsp('GetConfigJson');
  };
  try {
    const f = await frame(page, 'measurement-batch');
    for (const value of [-60, -24]) {
      const captured = await setHigh(value);
      await f.locator('#startInstant').click();
      await expect(f.locator('#currentCounter')).toHaveText('MEASUREMENT 1 / 1');
      await expect(f.locator('#effectiveSummary')).toContainText(`${value.toFixed(1)} dB`);
      const effective = await (await request.get('/api/measurement-batch/effective')).json();
      expect(effective.active).toBe(true);
      expect(effective.matchesExpected).toBe(true);
      expect(effective.masterDb).toBe(volume);
      const during = await dsp('GetConfigJson');
      for (const name of gainNames) expect(during.filters[name].parameters.gain).toBe(value);
      expect(during.mixers).toEqual(captured.mixers);
      expect(during.devices).toEqual(captured.devices);
      expect(during.filters.ESTACK_LOUDNESS).toEqual(captured.filters.ESTACK_LOUDNESS);
      await f.locator('#next').click();
      await expect.poll(() => dsp('GetConfigJson')).toEqual(captured);
      expect(await dsp('GetVolume')).toBe(volume);
    }
    const beforeExclusion = await dsp('GetConfigJson');
    await f.locator('#instantWays input[value="HIGH_L"]').uncheck();
    await f.locator('#instantWays input[value="HIGH_R"]').uncheck();
    await f.locator('#startInstant').click();
    await expect(f.locator('#currentCounter')).toHaveText('MEASUREMENT 1 / 1');
    const excluded = await dsp('GetConfigJson');
    for (const name of gainNames) expect(excluded.filters[name].parameters.mute).toBe(true);
    await f.locator('#next').click();
    await expect.poll(() => dsp('GetConfigJson')).toEqual(beforeExclusion);
  } finally {
    await request.post('/api/measurement-batch/abort', { data: {} });
    await dsp({ SetVolume: -60 });
    await dsp({ SetConfigJson: JSON.stringify(original) });
    await dsp({ SetVolume: volume });
  }
  expect(await dsp('GetConfigJson')).toEqual(original);
});
