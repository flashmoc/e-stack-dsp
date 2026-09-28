const { test, expect } = require("@playwright/test");
const { demo, dsp, frame } = require("./batch-helpers");
test("Advanced inspects actual topology without DSP writes at phone width", async ({
  page,
  request,
}) => {
  await demo(request);
  await page.setViewportSize({ width: 390, height: 844 });
  const config = await dsp("GetConfigJson"),
    writes = [];
  page.on("websocket", (ws) =>
    ws.on("framesent", ({ payload }) => {
      if (/SetConfigJson|SetVolume/.test(String(payload))) writes.push(payload);
    }),
  );
  const f = await frame(page, "advanced");
  await expect(f.locator("#state")).toContainText("Live");
  expect(await f.evaluate(() => typeof EStackPrototypeDSP)).toBe("undefined");
  await expect(f.locator("#devices")).toContainText(
    config.devices.capture.type,
  );
  await expect(f.locator("#devices")).toContainText(
    config.devices.playback.device ||
      config.devices.playback.filename ||
      "runtime source",
  );
  await expect(f.locator("#pipeline>li")).toHaveCount(config.pipeline.length);
  for (const kind of ["mixers", "filters", "processors"])
    for (const name of Object.keys(config[kind] || {}))
      await expect(f.locator("#definitions")).toContainText(name);
  await f.locator(".inspector > summary").click();
  await f.locator("#pipeline summary").first().click();
  await f.locator("#refresh").click();
  await expect(f.locator("#pipeline details").first()).toHaveAttribute(
    "open",
    "",
  );
  await expect(f.locator("#raw")).toHaveText(JSON.stringify(config, null, 2));
  expect(
    await f.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  expect(writes).toEqual([]);
  expect(await dsp("GetConfigJson")).toEqual(config);
});

for (const width of [1440, 1024, 390]) test(`Advanced shows ordered per-output paths and mixer sources at ${width}px`, async ({ page, request }) => {
  await demo(request);
  await page.setViewportSize({width, height:width===390?844:900});
  const config = await dsp('GetConfigJson');
  const writes = [];
  page.on('websocket', ws => ws.on('framesent', ({payload}) => {
    if (/SetConfigJson|SetVolume/.test(String(payload))) writes.push(payload);
  }));
  const f = await frame(page, 'advanced');
  await expect(f.locator('[data-kind="pipeline"]')).toHaveAttribute('aria-pressed', 'true');
  const count = config.devices.playback.channels;
  await expect(f.locator('#pathOutput option')).toHaveCount(count + 1);
  for (let channel = 0; channel < count; channel++) {
    await f.locator('#pathOutput').selectOption(String(channel));
    const path = f.locator(`.signal-path[data-output-channel="${channel}"]`);
    await expect(path).toBeVisible();
    await expect(f.locator('.signal-path')).toHaveCount(1);
    const stages = await path.locator('.path-step').evaluateAll(nodes => nodes.map(node => Number(node.dataset.stage)));
    expect(stages).toEqual([...stages].sort((a,b) => a-b));
    const mixer = config.mixers[config.pipeline.find(step => step.type === 'Mixer').name];
    const mapping = mixer.mapping.find(entry => entry.dest === channel);
    if (mapping) for (const source of mapping.sources) await expect(path).toContainText(`IN ${source.channel + 1} ${Number(source.gain).toFixed(1)} dB`);
    for (const step of config.pipeline.filter(step => step.type === 'Filter' && (step.channels || []).includes(channel))) {
      if (config.pipeline.indexOf(step) < config.pipeline.findIndex(entry => entry.type === 'Mixer')) continue;
      for (const name of step.names) await expect(path).toContainText(name);
    }
  }
  await f.locator('#pathOutput').selectOption(width===390?'0':'all');
  await f.locator('#pipelineEditor').screenshot({path:`test-results/advanced-paths-${width}.png`});
  const firstComponent = await f.locator('.signal-path').first().locator('.path-component').first().textContent();
  await f.locator('.signal-path').first().locator('.path-component').first().click();
  await expect(f.locator('[data-kind="filters"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(f.locator('#component')).toHaveValue(firstComponent);
  await f.locator('[data-kind="mixers"]').click();
  const mixer = Object.values(config.mixers)[0];
  await expect(f.locator('.mixer-destination')).toHaveCount(mixer.mapping.length);
  await expect(f.locator('.mixer-source')).toHaveCount(mixer.mapping.reduce((total, entry) => total + entry.sources.length, 0));
  await expect(f.locator('.capture-peak').first()).toHaveText(/dBFS/);
  await f.locator('#advancedForm').screenshot({path:`test-results/advanced-mixer-${width}.png`});
  expect(await f.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(writes).toEqual([]);
  expect(await dsp('GetConfigJson')).toEqual(config);
});

test('Advanced mixer source gain uses the guarded edit and exact readback', async ({page, request}) => {
  await demo(request);
  const original = await dsp('GetConfigJson');
  const volume = await dsp('GetVolume');
  page.on('dialog', dialog => dialog.accept());
  try {
    const f = await frame(page, 'advanced');
    await f.locator('[data-kind="mixers"]').click();
    const source = f.locator('.mixer-source').first();
    await expect(source.getByRole('combobox', {name:'Input channel'})).toHaveValue(String(original.mixers[Object.keys(original.mixers)[0]].mapping[0].sources[0].channel));
    const gain = source.getByRole('spinbutton', {name:'Gain · dB'});
    const target = Number((Number(await gain.inputValue()) - .1).toFixed(4));
    await gain.fill(String(target));
    expect(await dsp('GetConfigJson')).toEqual(original);
    await source.getByRole('button', {name:'Apply source'}).click();
    await expect(f.locator('#notice')).toHaveText('Applied and verified.');
    const current = await dsp('GetConfigJson');
    const name = Object.keys(original.mixers)[0];
    expect(current.mixers[name].mapping[0].sources[0].gain).toBe(target);
    expect(current.devices).toEqual(original.devices);
    expect(current.filters).toEqual(original.filters);
    expect(current.processors).toEqual(original.processors);
    expect(current.pipeline).toEqual(original.pipeline);
    expect(await dsp('GetVolume')).toBe(volume);
  } finally {
    await dsp({SetConfigJson:JSON.stringify(original)});
    await dsp({SetVolume:volume});
    expect(await dsp('GetConfigJson')).toEqual(original);
  }
});
