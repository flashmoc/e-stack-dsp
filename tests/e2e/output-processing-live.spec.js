'use strict';

const { test, expect } = require('@playwright/test');
const WebSocket = require('ws');

const baseURL = process.env.ESTACK_E2E_BASE_URL || 'http://127.0.0.1:8080';
const target = new URL(baseURL);
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
async function outputFrame(page) {
  await expect.poll(() => page.frames().some(frame => new URL(frame.url()).pathname.endsWith('/pages/output-processing/page.html'))).toBeTruthy();
  return page.frames().find(frame => new URL(frame.url()).pathname.endsWith('/pages/output-processing/page.html'));
}
function stage(config, channel, matcher) { return config.pipeline.find(entry => entry.type === 'Filter' && (entry.channels || []).map(Number).includes(channel) && matcher(entry)); }
function protectedView(config, allowedFilter, selectedStage) {
  const next = clone(config); delete next.filters[allowedFilter]; if (selectedStage) { const copy = next.pipeline[next.pipeline.indexOf(selectedStage)]; copy.names = copy.names.filter(name => name !== allowedFilter); } return next;
}

for (const width of [390, 768, 1920]) {
  test(`graph modes keep the plot and alignment in place at ${width}px`, async ({ page, request }) => {
    await requireDemoRuntime(request);
    await page.setViewportSize({ width, height: 1080 });
    await page.goto('/estack-dsp/?transport=camillanode#output-processing');
    const frame = await outputFrame(page);
    await expect(frame.locator('.way-card')).toHaveCount(6);
    const layout = await frame.evaluate(() => {
      const page = document.querySelector('.output-page').getBoundingClientRect();
      const plot = document.querySelector('.graph-wrap').getBoundingClientRect();
      return { pageLeft: page.left, pageWidth: page.width, plotHeight: plot.height, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(layout.overflow).toBe(false);
    expect(layout.plotHeight).toBeGreaterThanOrEqual(250);
    if (width === 1920) {
      expect(layout.pageWidth).toBeLessThanOrEqual(1800);
      expect(layout.pageLeft).toBeGreaterThanOrEqual(50);
    }
    const positions = () => frame.evaluate(() => ['.graph-wrap', '.output-section'].map(selector => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { top: rect.top + scrollY, height: rect.height };
    }));
    await frame.locator('[data-graph-mode="phase"]').click();
    const baseline = await positions();
    for (const mode of ['xo', 'magnitude', 'phase', 'xo']) {
      await frame.locator(`[data-graph-mode="${mode}"]`).click();
      await expect(frame.locator('#responseGraph')).toHaveAttribute('data-graph-mode', mode);
      await expect.poll(positions).toEqual(baseline);
      if (mode === 'xo') {
        await expect(frame.locator('#xoPair')).toBeEnabled();
        const pairs = await frame.locator('#xoPair option').evaluateAll(options => options.map(option => option.value));
        for (const pair of pairs) {
          await frame.locator('#xoPair').selectOption(pair);
          await expect.poll(positions).toEqual(baseline);
        }
      } else await expect(frame.locator('#xoPair')).toBeDisabled();
    }
  });
}

test('compact way rail follows the graph and stereo links remain pair-scoped', async ({ page, request }) => {
  await requireDemoRuntime(request);
  const original = await dspCommand('GetConfigJson');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/estack-dsp/?transport=camillanode#output-processing');
  const frame = await outputFrame(page);
  try {
    const layout = await frame.evaluate(() => {
      const graph = document.querySelector('.graph-wrap').getBoundingClientRect();
      const rail = document.querySelector('.way-strip').getBoundingClientRect();
      return { graphTop: graph.top, graphBottom: graph.bottom, railTop: rail.top, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(layout.graphTop).toBeLessThan(480);
    expect(layout.railTop).toBeGreaterThanOrEqual(layout.graphBottom);
    expect(layout.overflow).toBe(false);
    await expect(frame.locator('.output-toolbar [data-processing-link]')).toHaveCount(2);
    await expect(frame.locator('.way-strip .section-kicker')).toHaveCount(0);
    await expect(frame.locator('[data-processing-link="mid"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(frame.locator('[data-processing-link="high"]')).toHaveAttribute('aria-pressed', 'true');
    await frame.locator('#systemEdit').click();
    await frame.locator('[data-way-channel="2"]').click();
    await frame.locator('[data-value="gain"]').fill('-8.7');
    await frame.locator('[data-value="gain"]').press('Tab');
    await expect.poll(async () => {
      const config = await dspCommand('GetConfigJson');
      return [config.filters.mid_l_gain.parameters.gain, config.filters.mid_r_gain.parameters.gain];
    }).toEqual([-8.7, -8.7]);
    const linked = await dspCommand('GetConfigJson');
    const scoped = clone(linked);
    scoped.filters.mid_l_gain.parameters.gain = original.filters.mid_l_gain.parameters.gain;
    scoped.filters.mid_r_gain.parameters.gain = original.filters.mid_r_gain.parameters.gain;
    expect(scoped).toEqual(original);
    await frame.locator('[data-processing-link="mid"]').click();
    await expect(frame.locator('[data-processing-link="mid"]')).toHaveAttribute('aria-pressed', 'false');
    expect(await dspCommand('GetConfigJson')).toEqual(linked);
    await frame.locator('[data-value="gain"]').fill('-8.6');
    await frame.locator('[data-value="gain"]').press('Tab');
    await expect.poll(async () => {
      const config = await dspCommand('GetConfigJson');
      return [config.filters.mid_l_gain.parameters.gain, config.filters.mid_r_gain.parameters.gain];
    }).toEqual([-8.6, -8.7]);
  } finally {
    const current = await dspCommand('GetConfigJson');
    if (JSON.stringify(current) !== JSON.stringify(original)) await dspCommand({ SetConfigJson: JSON.stringify(original) });
    expect(await dspCommand('GetConfigJson')).toEqual(original);
  }
});

test('linked MID and HIGH mute and polarity change together, then independently when free', async ({ page, request }) => {
  await requireDemoRuntime(request);
  const original = await dspCommand('GetConfigJson');
  await page.goto('/estack-dsp/?transport=camillanode#output-processing');
  const frame = await outputFrame(page);
  await frame.locator('#systemEdit').click();
  const pairs = [['mid', 2, 3, 'mid_l_gain', 'mid_r_gain'], ['high', 4, 5, 'high_l_gain', 'high_r_gain']];
  try {
    for (const [pair, left, right, leftName, rightName] of pairs) {
      const link = frame.locator(`[data-processing-link="${pair}"]`);
      await expect(link).toHaveAttribute('aria-pressed', 'true');
      await frame.locator(`[data-way-channel="${left}"]`).click();
      const before = await dspCommand('GetConfigJson');
      const muteTarget = !before.filters[leftName].parameters.mute;
      const polarityTarget = !before.filters[leftName].parameters.inverted;
      await frame.locator('[data-mute]').click();
      await expect.poll(async () => {
        const config = await dspCommand('GetConfigJson');
        return [config.filters[leftName].parameters.mute, config.filters[rightName].parameters.mute];
      }).toEqual([muteTarget, muteTarget]);
      await frame.locator(`[data-polarity="${polarityTarget}"]`).click();
      await expect.poll(async () => {
        const config = await dspCommand('GetConfigJson');
        return [config.filters[leftName].parameters.inverted, config.filters[rightName].parameters.inverted];
      }).toEqual([polarityTarget, polarityTarget]);
      const linked = await dspCommand('GetConfigJson');
      const scoped = clone(linked);
      for (const name of [leftName, rightName]) {
        scoped.filters[name].parameters.mute = before.filters[name].parameters.mute;
        scoped.filters[name].parameters.inverted = before.filters[name].parameters.inverted;
      }
      expect(scoped).toEqual(before);

      await link.click();
      await expect(link).toHaveAttribute('aria-pressed', 'false');
      await frame.locator('[data-mute]').click();
      await frame.locator(`[data-polarity="${!polarityTarget}"]`).click();
      await expect.poll(async () => {
        const config = await dspCommand('GetConfigJson');
        return [config.filters[leftName].parameters.mute, config.filters[rightName].parameters.mute,
          config.filters[leftName].parameters.inverted, config.filters[rightName].parameters.inverted];
      }).toEqual([!muteTarget, muteTarget, !polarityTarget, polarityTarget]);
      await link.click();
    }
  } finally {
    const current = await dspCommand('GetConfigJson');
    if (JSON.stringify(current) !== JSON.stringify(original)) await dspCommand({ SetConfigJson: JSON.stringify(original) });
    expect(await dspCommand('GetConfigJson')).toEqual(original);
  }
});

test('linked MID delay, phase and crossover stay paired while PEQ needs explicit copy', async ({ page, request }) => {
  await requireDemoRuntime(request);
  const original = await dspCommand('GetConfigJson');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/estack-dsp/?transport=camillanode#output-processing');
  const frame = await outputFrame(page);
  try {
    await expect(frame.locator('[data-processing-link="mid"]')).toHaveAttribute('aria-pressed', 'true');
    await frame.locator('#systemEdit').click();
    await frame.locator('[data-way-channel="2"]').click();
    await frame.locator('[data-value="delay"]').fill('1.23');
    await frame.locator('[data-value="delay"]').press('Tab');
    await expect.poll(async () => {
      const config = await dspCommand('GetConfigJson');
      return [config.filters.mid_l_delay.parameters.delay, config.filters.mid_r_delay.parameters.delay];
    }).toEqual([1.23, 1.23]);
    await frame.locator('[data-processing-link="mid"]').click();
    await frame.locator('[data-value="delay"]').fill('1.24');
    await frame.locator('[data-value="delay"]').press('Tab');
    await expect.poll(async () => {
      const config = await dspCommand('GetConfigJson');
      return [config.filters.mid_l_delay.parameters.delay, config.filters.mid_r_delay.parameters.delay];
    }).toEqual([1.24, 1.23]);
    await frame.locator('[data-processing-link="mid"]').click();
    await frame.locator('[data-value="delay"]').fill('1.23');
    await frame.locator('[data-value="delay"]').press('Tab');
    await expect.poll(async () => {
      const config = await dspCommand('GetConfigJson');
      return [config.filters.mid_l_delay.parameters.delay, config.filters.mid_r_delay.parameters.delay];
    }).toEqual([1.23, 1.23]);

    await frame.locator('[data-value="phase"]').fill('-30');
    await frame.locator('[data-value="phase"]').press('Tab');
    await expect.poll(async () => {
      const config = await dspCommand('GetConfigJson');
      return [config.filters.ESTACK_PHASE_CH2?.description, config.filters.ESTACK_PHASE_CH3?.description];
    }).toEqual([expect.stringContaining('-30.0 deg'), expect.stringContaining('-30.0 deg')]);

    const hpf = original.filters.mid_hpf_300_lr24.parameters.freq;
    await frame.locator('[data-xo-freq="hpf"]').fill(String(hpf + 1));
    await frame.locator('[data-xo-freq="hpf"]').press('Tab');
    await expect.poll(async () => (await dspCommand('GetConfigJson')).filters.mid_hpf_300_lr24.parameters.freq).toBe(hpf + 1);

    const slot = Array.from({ length: 10 }, (_, index) => index).find(index => [2, 3].every(channel => !original.filters[`USER_CH${channel}_PEQ_${String(index + 1).padStart(2, '0')}`]));
    expect(slot).toBeDefined();
    await frame.locator('#addPeq').click();
    await expect(frame.locator(`[data-peq-slot="${slot}"]`)).toHaveCount(1);
    await frame.locator(`[data-peq-field="freq"][data-slot="${slot}"]`).fill('710');
    await frame.locator(`[data-peq-field="freq"][data-slot="${slot}"]`).press('Tab');
    await frame.locator(`[data-peq-field="gain"][data-slot="${slot}"]`).fill('2');
    await frame.locator(`[data-peq-field="gain"][data-slot="${slot}"]`).press('Tab');
    await expect.poll(async () => {
      const config = await dspCommand('GetConfigJson');
      return [2, 3].map(channel => config.filters[`USER_CH${channel}_PEQ_${String(slot + 1).padStart(2, '0')}`]?.parameters);
    }).toEqual([expect.objectContaining({ freq: 710, gain: 2 }), undefined]);
    await frame.locator('[data-way-channel="3"]').click();
    await expect(frame.locator('#copyPeq')).toHaveText('Copy from MID L');
    await frame.locator('#copyPeq').click();
    await expect.poll(async () => {
      const config = await dspCommand('GetConfigJson');
      return [config.filters[`USER_CH2_PEQ_${String(slot + 1).padStart(2, '0')}`]?.parameters,
        config.filters[`USER_CH3_PEQ_${String(slot + 1).padStart(2, '0')}`]?.parameters];
    }).toEqual([expect.objectContaining({ freq: 710, gain: 2 }), expect.objectContaining({ freq: 710, gain: 2 })]);
    await frame.locator(`[data-peq-field="gain"][data-slot="${slot}"]`).fill('3');
    await frame.locator(`[data-peq-field="gain"][data-slot="${slot}"]`).press('Tab');
    await expect.poll(async () => {
      const config = await dspCommand('GetConfigJson');
      return [config.filters[`USER_CH2_PEQ_${String(slot + 1).padStart(2, '0')}`].parameters.gain,
        config.filters[`USER_CH3_PEQ_${String(slot + 1).padStart(2, '0')}`].parameters.gain];
    }).toEqual([2, 3]);
    await frame.locator('#copyPeq').click();
    await expect.poll(async () => (await dspCommand('GetConfigJson')).filters[`USER_CH3_PEQ_${String(slot + 1).padStart(2, '0')}`].parameters.gain).toBe(2);
    await frame.locator('[data-way-channel="2"]').click();
    await frame.locator(`[data-peq-toggle="${slot}"]`).click();
    await expect.poll(async () => {
      const config = await dspCommand('GetConfigJson');
      return [2, 3].map(channel => stage(config, channel, entry => entry.names.includes(channel === 2 ? 'mid_l_gain' : 'mid_r_gain')).names.includes(`USER_CH${channel}_PEQ_${String(slot + 1).padStart(2, '0')}`));
    }).toEqual([false, true]);
    await frame.locator('[data-way-channel="3"]').click();
    await frame.locator('#copyPeq').click();
    await expect.poll(async () => {
      const config = await dspCommand('GetConfigJson');
      return [2, 3].map(channel => stage(config, channel, entry => entry.names.includes(channel === 2 ? 'mid_l_gain' : 'mid_r_gain')).names.includes(`USER_CH${channel}_PEQ_${String(slot + 1).padStart(2, '0')}`));
    }).toEqual([false, false]);
    await frame.locator(`[data-peq-delete="${slot}"]`).click();
    await expect.poll(async () => (await dspCommand('GetConfigJson')).filters[`USER_CH3_PEQ_${String(slot + 1).padStart(2, '0')}`]).toBeUndefined();
    await frame.locator('[data-way-channel="2"]').click();
    await expect.poll(async () => (await dspCommand('GetConfigJson')).filters[`USER_CH2_PEQ_${String(slot + 1).padStart(2, '0')}`]).toBeDefined();

    await frame.locator(`[data-peq-delete="${slot}"]`).click();
    await frame.locator('[data-value="phase"]').fill('0');
    await frame.locator('[data-value="phase"]').press('Tab');
    await frame.locator('[data-value="delay"]').fill(String(original.filters.mid_l_delay.parameters.delay));
    await frame.locator('[data-value="delay"]').press('Tab');
    await frame.locator('[data-xo-freq="hpf"]').fill(String(hpf));
    await frame.locator('[data-xo-freq="hpf"]').press('Tab');
    const expectedAfterZeroPhase = clone(original);
    for (const channel of [2, 3]) {
      const name = `ESTACK_PHASE_CH${channel}`;
      delete expectedAfterZeroPhase.filters[name];
      stage(expectedAfterZeroPhase, channel, entry => entry.names.includes(channel === 2 ? 'mid_l_gain' : 'mid_r_gain')).names =
        stage(expectedAfterZeroPhase, channel, entry => entry.names.includes(channel === 2 ? 'mid_l_gain' : 'mid_r_gain')).names.filter(item => item !== name);
    }
    expectedAfterZeroPhase.filters.mid_r_delay.parameters.delay = original.filters.mid_l_delay.parameters.delay;
    await expect.poll(async () => await dspCommand('GetConfigJson')).toEqual(expectedAfterZeroPhase);
    await frame.locator('[data-way-channel="5"]').click();
    await frame.locator('[data-value="delay"]').fill('0.75');
    await frame.locator('[data-value="delay"]').press('Tab');
    await expect.poll(async () => {
      const config = await dspCommand('GetConfigJson');
      return [config.filters.high_l_delay.parameters.delay, config.filters.high_r_delay.parameters.delay];
    }).toEqual([.75, .75]);
  } finally {
    const current = await dspCommand('GetConfigJson');
    if (JSON.stringify(current) !== JSON.stringify(original)) await dspCommand({ SetConfigJson: JSON.stringify(original) });
    expect(await dspCommand('GetConfigJson')).toEqual(original);
  }
});

test('HIGH PEQ copies explicitly from R to L without linking later edits', async ({ page, request }) => {
  await requireDemoRuntime(request);
  const original = await dspCommand('GetConfigJson');
  await page.goto('/estack-dsp/?transport=camillanode#output-processing');
  const frame = await outputFrame(page);
  const slot = Array.from({ length: 10 }, (_, index) => index).find(index => [4, 5].every(channel => !original.filters[`USER_CH${channel}_PEQ_${String(index + 1).padStart(2, '0')}`]));
  expect(slot).toBeDefined();
  const leftName = `USER_CH4_PEQ_${String(slot + 1).padStart(2, '0')}`;
  const rightName = `USER_CH5_PEQ_${String(slot + 1).padStart(2, '0')}`;
  try {
    await expect(frame.locator('#copyPeq')).toBeHidden();
    await frame.locator('#systemEdit').click();
    await frame.locator('[data-way-channel="5"]').click();
    await expect(frame.locator('#copyPeq')).toHaveText('Copy from HIGH L');
    await frame.locator('#addPeq').click();
    await frame.locator(`[data-peq-field="gain"][data-slot="${slot}"]`).fill('2');
    await frame.locator(`[data-peq-field="gain"][data-slot="${slot}"]`).press('Tab');
    await expect.poll(async () => {
      const config = await dspCommand('GetConfigJson');
      return [config.filters[leftName], config.filters[rightName]?.parameters?.gain];
    }).toEqual([undefined, 2]);
    await frame.locator('[data-way-channel="4"]').click();
    await expect(frame.locator('#copyPeq')).toHaveText('Copy from HIGH R');
    await frame.locator('#copyPeq').click();
    await expect.poll(async () => (await dspCommand('GetConfigJson')).filters[leftName]?.parameters?.gain).toBe(2);
    await frame.locator(`[data-peq-field="gain"][data-slot="${slot}"]`).fill('3');
    await frame.locator(`[data-peq-field="gain"][data-slot="${slot}"]`).press('Tab');
    await expect.poll(async () => {
      const config = await dspCommand('GetConfigJson');
      return [config.filters[leftName]?.parameters?.gain, config.filters[rightName]?.parameters?.gain];
    }).toEqual([3, 2]);
  } finally {
    const current = await dspCommand('GetConfigJson');
    if (JSON.stringify(current) !== JSON.stringify(original)) await dspCommand({ SetConfigJson: JSON.stringify(original) });
    expect(await dspCommand('GetConfigJson')).toEqual(original);
  }
});

test.describe('Output Processing live CamillaNode demo', () => {
  test('round trips a shared MID crossover and a temporary MID L PEQ through the product', async ({ page, request }) => {
    await requireDemoRuntime(request); const original = await dspCommand('GetConfigJson');
    await page.goto('/estack-dsp/?transport=camillanode#output-processing'); const frame = await outputFrame(page);
    try {
      await expect(page.locator('html')).toHaveAttribute('data-transport', 'live');
      await expect.poll(() => frame.evaluate(() => ({ mode: window.EStackDSPBridge?.mode, page: document.documentElement.dataset.prototypePage, mock: !!window.EStackPrototypeFixtures || !!window.EStackPrototypeDSP }))).toEqual({ mode: 'camillanode', page: 'output-processing', mock: false });
      await expect(frame.locator('.way-card')).toHaveCount(6); await expect(frame.locator('[data-way-channel="6"],[data-way-channel="7"]')).toHaveCount(0);
      await expect(frame.locator('button[data-graph-mode="magnitude"]')).toBeVisible(); await expect(frame.locator('#responseGraph')).toHaveAttribute('data-graph-mode', 'magnitude');
      const graphOnlyConfig = await dspCommand('GetConfigJson');
      await frame.locator('button[data-graph-mode="phase"]').click(); await expect(frame.locator('#responseGraph')).toHaveAttribute('data-graph-mode', 'phase');
      await frame.locator('button[data-graph-mode="xo"]').click(); await frame.locator('#xoPair').selectOption('sub-kick'); await expect(frame.locator('#xoReadout')).toContainText('SUB / KICK');
      await frame.locator('button[data-graph-mode="magnitude"]').click(); await frame.locator('#analyzerEnabled').check(); await expect.poll(() => frame.locator('#analyzerStatus').textContent()).toMatch(/LIVE|UNAVAILABLE/);
      expect(await dspCommand('GetConfigJson')).toEqual(graphOnlyConfig);
      await expect(frame.locator('#systemEdit')).toContainText('LOCKED'); await expect(frame.locator('[data-xo-freq="hpf"]')).toBeDisabled();
      const originalMid = original.filters.mid_hpf_300_lr24.parameters.freq; const lockedView = await dspCommand('GetConfigJson');
      await frame.locator('[data-xo-freq="hpf"]').evaluate((element, value) => { element.value = String(value); element.dispatchEvent(new Event('change', { bubbles: true })); }, originalMid + 1);
      await page.waitForTimeout(200); expect(await dspCommand('GetConfigJson')).toEqual(lockedView);

      await frame.locator('#systemEdit').click(); await frame.locator('[data-way-channel="2"]').click(); await expect(frame.locator('[data-xo-freq="hpf"]')).toBeEnabled();
      await frame.locator('button[data-graph-mode="phase"]').click();
      await expect(frame.locator('#responseGraph')).toHaveAttribute('data-graph-mode', 'phase');
      const originalMidGain = original.filters.mid_l_gain.parameters.gain;
      const gainControl = frame.locator('input[data-range="gain"]');
      await gainControl.fill((originalMidGain - 0.1).toFixed(1)); await gainControl.dispatchEvent('change');
      await expect.poll(() => frame.locator('#responseGraph').getAttribute('data-graph-mode')).toBe('phase');
      await expect.poll(async () => (await dspCommand('GetConfigJson')).filters.mid_l_gain.parameters.gain).toBeCloseTo(originalMidGain - 0.1, 5);
      await gainControl.fill(String(originalMidGain)); await gainControl.dispatchEvent('change');
      await expect.poll(async () => (await dspCommand('GetConfigJson')).filters.mid_l_gain.parameters.gain).toBeCloseTo(originalMidGain, 5); await expect(frame.locator('#editState')).toHaveText('EDITING');
      await expect(frame.locator('#responseGraph')).toHaveAttribute('data-graph-mode', 'phase');

      const midLStageOriginal = stage(original, 2, entry => entry.names.includes('mid_l_gain')); const midRStageOriginal = stage(original, 3, entry => entry.names.includes('mid_r_gain'));
      await frame.locator('[data-xo-freq="hpf"]').fill(String(originalMid + 1)); await frame.locator('[data-xo-freq="hpf"]').press('Tab');
      await expect.poll(async () => (await dspCommand('GetConfigJson')).filters.mid_hpf_300_lr24.parameters.freq).toBe(originalMid + 1);
      const crossoverChanged = await dspCommand('GetConfigJson'); const midLStageChanged = stage(crossoverChanged, 2, entry => entry.names.includes('mid_l_gain')); const midRStageChanged = stage(crossoverChanged, 3, entry => entry.names.includes('mid_r_gain'));
      expect(midLStageChanged.names).toEqual(midLStageOriginal.names); expect(midRStageChanged.names).toEqual(midRStageOriginal.names); expect(midLStageChanged.names).toContain('mid_hpf_300_lr24'); expect(midRStageChanged.names).toContain('mid_hpf_300_lr24');
      await frame.locator('[data-xo-freq="hpf"]').fill(String(originalMid)); await frame.locator('[data-xo-freq="hpf"]').press('Tab'); await expect.poll(async () => (await dspCommand('GetConfigJson')).filters.mid_hpf_300_lr24.parameters.freq).toBe(originalMid); await expect(frame.locator('#editState')).toHaveText('EDITING');
      console.log(`Output E2E shared MID HPF: ${originalMid} Hz -> ${originalMid + 1} Hz -> ${originalMid} Hz`);

      const temporarySlot = Array.from({ length: 10 }, (_, slot) => slot).find(slot => !original.filters[`USER_CH2_PEQ_${String(slot + 1).padStart(2, '0')}`]); const temporaryName = `USER_CH2_PEQ_${String(temporarySlot + 1).padStart(2, '0')}`;
      await frame.locator('#addPeq').click(); await expect(frame.locator(`[data-peq-slot="${temporarySlot}"]`)).toHaveCount(1);
      const gain = frame.locator(`[data-peq-field="gain"][data-slot="${temporarySlot}"]`); await gain.fill('1'); await gain.press('Tab');
      await expect.poll(async () => (await dspCommand('GetConfigJson')).filters[temporaryName]?.parameters?.gain).toBe(1);
      const peqChanged = await dspCommand('GetConfigJson'); const midLPeqStage = stage(peqChanged, 2, entry => entry.names.includes('mid_l_gain')); const midRPeqStage = stage(peqChanged, 3, entry => entry.names.includes('mid_r_gain'));
      expect(midLPeqStage.names.indexOf(temporaryName)).toBeLessThan(midLPeqStage.names.indexOf('mid_l_gain')); expect(midRPeqStage.names).not.toContain(temporaryName);
      await frame.locator(`[data-peq-delete="${temporarySlot}"]`).click(); await expect.poll(async () => (await dspCommand('GetConfigJson')).filters[temporaryName]).toBeUndefined();
      expect(await dspCommand('GetConfigJson')).toEqual(original); console.log(`Output E2E MID L PEQ: ${temporaryName} added at +1.0 dB then deleted.`);
    } finally {
      const current = await dspCommand('GetConfigJson'); if (JSON.stringify(current) !== JSON.stringify(original)) await dspCommand({ SetConfigJson: JSON.stringify(original) });
      expect(await dspCommand('GetConfigJson')).toEqual(original);
    }
  });
});

test('keeps the calibration surface stable across live parameter readbacks', async ({ page, request }) => {
  test.setTimeout(90_000);
  await requireDemoRuntime(request);
  const original = await dspCommand('GetConfigJson');
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({width:1440,height:900});
  await page.goto('/estack-dsp/?transport=camillanode#output-processing');
  const frame = await outputFrame(page);
  const ready = () => expect(frame.locator('#editState')).toHaveText('EDITING');
  const change = async (selector, next) => {
    const control = frame.locator(selector); await control.fill(String(next));
    await control.dispatchEvent('change'); await ready();
  };
  try {
    await expect(frame.locator('.way-card')).toHaveCount(6);
    for (let channel=0;channel<6;channel++) {
      await frame.locator(`[data-way-channel="${channel}"]`).click();
      await expect(frame.locator(`[data-way-channel="${channel}"]`)).toHaveAttribute('aria-pressed','true');
      await expect(frame.locator('#outputMeta')).toContainText(`OUT ${channel+1}`);
    }
    await frame.locator('button[data-graph-mode="xo"]').click();
    for(const pair of ['sub-kick','kick-mid-l','kick-mid-r','mid-high-l','mid-high-r']) {
      await frame.locator('#xoPair').selectOption(pair);
      await expect(frame.locator('#xoReadout')).toContainText('Δ');
    }
    await frame.locator('[data-way-channel="2"]').click();
    await frame.locator('#compareWay').selectOption('3');
    await frame.locator('#allXos').uncheck();
    await frame.locator('button[data-graph-mode="magnitude"]').click();
    await frame.locator('#analyzerEnabled').check();
    for(const mode of ['raw','slow','fast']) await frame.locator(`[data-analyzer-mode="${mode}"]`).click();
    for(const view of ['sub','low','mid','high','full']) await frame.locator(`[data-analyzer-view="${view}"]`).click();
    await frame.locator('#analyzerInfinite').check(); await frame.locator('#analyzerReset').click();
    await expect.poll(()=>frame.locator('#analyzerStatus').textContent()).toMatch(/LIVE|UNAVAILABLE/);
    expect(await dspCommand('GetConfigJson')).toEqual(original);
    await frame.locator('button[data-graph-mode="phase"]').click();
    await frame.locator('#systemEdit').click(); await ready();
    await frame.locator('[data-value="gain"]').focus();
    await frame.evaluate(() => {
      window.reviewNodes = ['[data-value="gain"]','[data-value="delay"]','[data-value="phase"]','[data-value="limiter"]','#responseGraph','#compareWay','[data-way-channel="2"]'].map(s=>[s,document.querySelector(s)]);
      window.reviewModes = [];
      window.reviewObserver = new MutationObserver(records=>records.forEach(r=>window.reviewModes.push(r.oldValue, r.target.dataset.graphMode)));
      window.reviewObserver.observe(document.querySelector('#responseGraph'),{attributes:true,attributeFilter:['data-graph-mode'],attributeOldValue:true});
      window.reviewScroll = scrollY;
    });
    const gain = original.filters.mid_l_gain.parameters.gain;
    await change('[data-value="gain"]',gain-.2);
    expect((await dspCommand('GetConfigJson')).filters.mid_l_gain.parameters.gain).toBeCloseTo(gain-.2,5);
    expect(await frame.evaluate(()=>document.activeElement===window.reviewNodes[0][1])).toBe(true);
    expect(await frame.evaluate(()=>scrollY)).toBe(await frame.evaluate(()=>window.reviewScroll));
    await change('[data-value="gain"]',gain);
    // Repeated actions catch handlers closed over obsolete snapshot values.
    const delayBefore = Number(await frame.locator('[data-value="delay"]').inputValue());
    for(let i=0;i<2;i++){await frame.locator('[data-delta="0.01"]').click();await ready();}
    await expect(frame.locator('[data-value="delay"]')).toHaveValue((delayBefore+.02).toFixed(2));
    await change('[data-value="delay"]',delayBefore);
    await change('[data-value="phase"]',-8);
    await expect(frame.locator('[data-value="phase"]')).toHaveValue('-8.0');
    expect((await dspCommand('GetConfigJson')).filters.ESTACK_PHASE_CH2.parameters.type).toBe('AllpassFO');
    await change('[data-value="phase"]',-12);
    await frame.locator('[data-polarity="true"]').click();await ready();
    await expect(frame.locator('[data-polarity="true"]')).toHaveAttribute('aria-pressed','true');
    await frame.locator('[data-polarity="false"]').click();await ready();
    await expect(frame.locator('[data-polarity="false"]')).toHaveAttribute('aria-pressed','true');
    for(let i=0;i<2;i++){await frame.locator('[data-mute]').click();await ready();await expect(frame.locator('[data-mute]')).toHaveAttribute('aria-pressed',String(i===0));}
    const limiterBefore = Number(await frame.locator('[data-value="limiter"]').inputValue());
    await change('[data-value="limiter"]',limiterBefore-.1);await change('[data-value="limiter"]',limiterBefore);
    await expect(frame.locator('[data-value="limiter"]')).toHaveValue(limiterBefore.toFixed(1));
    const slot=Array.from({length:10},(_,s)=>s).find(s=>!original.filters[`USER_CH2_PEQ_${String(s+1).padStart(2,'0')}`]);
    const name=`USER_CH2_PEQ_${String(slot+1).padStart(2,'0')}`;
    await frame.locator('#addPeq').click();await ready();
    await frame.evaluate(slot=>{window.reviewPeq=document.querySelector(`[data-peq-slot="${slot}"]`);},slot);
    await change(`[data-peq-field="freq"][data-slot="${slot}"]`,700);
    await change(`[data-peq-field="gain"][data-slot="${slot}"]`,1.5);
    await change(`[data-peq-field="q"][data-slot="${slot}"]`,1.2);
    await frame.locator(`[data-peq-type="${slot}"]`).selectOption('Lowshelf');await ready();
    expect((await dspCommand('GetConfigJson')).filters[name].parameters).toMatchObject({freq:700,gain:1.5,q:1.2,type:'Lowshelf'});
    await frame.locator(`[data-peq-toggle="${slot}"]`).click();await ready();
    await expect(frame.locator(`[data-peq-toggle="${slot}"]`)).toHaveText('OFF');
    expect((await dspCommand('GetConfigJson')).pipeline.filter(s=>s.type==='Filter'&&(s.channels||[]).includes(2)).flatMap(s=>s.names)).not.toContain(name);
    await frame.locator(`[data-peq-toggle="${slot}"]`).click();await ready();
    expect(await frame.evaluate(slot=>window.reviewPeq===document.querySelector(`[data-peq-slot="${slot}"]`),slot)).toBe(true);
    await frame.locator(`[data-peq-reset="${slot}"]`).click();await ready();
    await frame.locator(`[data-peq-delete="${slot}"]`).click();await ready();
    await expect(frame.locator(`[data-peq-slot="${slot}"]`)).toHaveCount(0);
    await frame.locator('[data-xo-range="hpf"]').fill('420');await frame.locator('[data-xo-range="hpf"]').dispatchEvent('change');await ready();
    await frame.locator('[data-xo-family="hpf"]').selectOption('Butterworth');await ready();
    await frame.locator('[data-xo-slope="hpf"]').selectOption('12');await ready();
    const xo=(await dspCommand('GetConfigJson')).filters.mid_hpf_300_lr24.parameters;
    expect(xo.type).toBe('ButterworthHighpass');expect(xo.order).toBe(2);
    expect(await frame.evaluate(()=>window.reviewNodes.every(([s,node])=>node===document.querySelector(s)))).toBe(true);
    expect(await frame.evaluate(()=>window.reviewModes.every(mode=>mode==='phase'))).toBe(true);
    await expect(frame.locator('[data-way-channel="2"]')).toHaveAttribute('aria-pressed','true');
    await expect(frame.locator('#compareWay')).toHaveValue('3');
    await expect(frame.locator('#analyzerEnabled')).toBeChecked();await expect(frame.locator('#analyzerInfinite')).toBeChecked();
    await frame.locator('#systemEdit').click();await expect(frame.locator('#editState')).toHaveText('LOCKED');
    const lockedConfig=await dspCommand('GetConfigJson');
    for(const selector of ['[data-value="phase"]','[data-value="limiter"]','[data-xo-freq="hpf"]']) {
      await expect(frame.locator(selector)).toBeDisabled();
      await frame.locator(selector).evaluate(el=>{el.value='-2';el.dispatchEvent(new Event('change',{bubbles:true}));});
    }
    expect(await dspCommand('GetConfigJson')).toEqual(lockedConfig);
    await frame.locator('button[data-graph-mode="magnitude"]').click();
    await expect(frame.locator('#responseGraph')).toHaveAttribute('data-graph-mode','magnitude');
    await page.reload();const fresh=await outputFrame(page);await expect(fresh.locator('#systemEdit')).toContainText('LOCKED');
    expect(errors).toEqual([]);
  } finally {
    const current=await dspCommand('GetConfigJson');
    if(JSON.stringify(current)!==JSON.stringify(original))await dspCommand({SetConfigJson:JSON.stringify(original)});
    expect(await dspCommand('GetConfigJson')).toEqual(original);
  }
});

test.describe('Output mobile touch', () => {
  test.use({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true });
  test('drags native controls once per release and preserves Phase through queued readbacks', async ({page,request}) => {
    test.setTimeout(90_000);
    await requireDemoRuntime(request); const original=await dspCommand('GetConfigJson');
    let writes=0, holdAck=false; const acknowledgements=[];
    // Real demo WebSocket, with an explicitly delayed acknowledgement to cover
    // another gesture and a delay nudge while the preceding write is in flight.
    await page.routeWebSocket('**/ws/dsp', socket => {
      const server=socket.connectToServer();
      socket.onMessage(message=>{if(JSON.parse(String(message)).SetConfigJson!==undefined)writes++;server.send(message);});
      server.onMessage(message=>{if(holdAck && JSON.parse(String(message)).SetConfigJson!==undefined)acknowledgements.push(()=>socket.send(message));else socket.send(message);});
    });
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('/estack-dsp/?transport=camillanode#output-processing');const frame=await outputFrame(page);
    const cdp=await page.context().newCDPSession(page);
    const touch=async(type,x,y)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:['touchEnd','touchCancel'].includes(type)?[]:[{x,y,id:1,radiusX:7,radiusY:7,force:1}]});
    const ready=()=>expect(frame.locator('#editState')).toHaveText('EDITING');
    const drag=async(selector,from,to)=>{
      const control=frame.locator(selector);await control.evaluate(el=>el.scrollIntoView({block:'center'}));
      const box=await control.boundingBox();expect(box.height).toBeGreaterThanOrEqual(44);
      const priorWrites=writes,priorValue=await control.inputValue();
      const beforeScroll=[await page.evaluate(()=>scrollY),await frame.evaluate(()=>scrollY)];
      const y=box.y+box.height/2+13; // Start outside the tiny visual thumb.
      await touch('touchStart',box.x+box.width*from,y);
      for(let i=1;i<=6;i++)await touch('touchMove',box.x+box.width*(from+(to-from)*i/6),y);
      expect(await control.inputValue()).not.toBe(priorValue);
      expect(writes).toBe(priorWrites);
      expect([await page.evaluate(()=>scrollY),await frame.evaluate(()=>scrollY)]).toEqual(beforeScroll);
      await expect(frame.locator('#responseGraph')).toHaveAttribute('data-graph-mode','phase');
      await touch('touchEnd');
    };
    try {
      await expect(frame.locator('.way-card')).toHaveCount(6);
      await expect(frame.locator('[data-range="gain"]')).toHaveAttribute('max','6');
      await expect(frame.locator('[data-value="gain"]')).toHaveAttribute('max','6');
      await expect(frame.locator('[data-range="gain"]')).toHaveAttribute('step','0.1');
      await frame.locator('#systemEdit').tap();await ready();
      await frame.locator('button[data-graph-mode="phase"]').tap();
      for(const channel of [0,2]) {
        await frame.locator(`[data-way-channel="${channel}"]`).scrollIntoViewIfNeeded();
        await frame.locator(`[data-way-channel="${channel}"]`).tap();
        await frame.evaluate(()=>{
          window.touchNodes=[...document.querySelectorAll('#responseGraph,#outputControls input,#crossoverControls input')];
          window.touchModes=[];window.touchObserver=new MutationObserver(records=>records.forEach(r=>window.touchModes.push(r.oldValue,r.target.dataset.graphMode)));
          window.touchObserver.observe(document.querySelector('#responseGraph'),{attributes:true,attributeFilter:['data-graph-mode'],attributeOldValue:true});
        });
        const start=writes,delayBefore=Number(await frame.locator('[data-value="delay"]').inputValue());
        holdAck=true;
        await drag('[data-range="gain"]',.65,.8);
        await expect.poll(()=>writes).toBe(start+1);
        await drag('[data-range="phase"]',.85,.7);
        await frame.locator('[data-delta="0.01"]').tap();
        expect(writes).toBe(start+1); // Later edits must wait for readback.
        holdAck=false;acknowledgements.splice(0).forEach(send=>send());await ready();
        expect(writes).toBe(start+3);
        await expect(frame.locator('[data-value="delay"]')).toHaveValue((delayBefore+.01).toFixed(2));
        await expect(frame.locator(`[data-way-channel="${channel}"]`)).toHaveAttribute('aria-pressed','true');
        expect(await frame.evaluate(()=>window.touchNodes.every(el=>el.isConnected))).toBe(true);
        expect(await frame.evaluate(()=>window.touchModes.every(mode=>mode==='phase'))).toBe(true);
        await frame.evaluate(()=>window.touchObserver.disconnect());
      }
      for(const edge of ['hpf','lpf']) {const start=writes;await drag(`[data-xo-range="${edge}"]`,.25,.55);await ready();expect(writes).toBe(start+1);}
      for(const [value,expected] of [['99','6.0'],['-99','-60.0']]) {
        const input=frame.locator('[data-value="gain"]');await input.fill(value);await input.press('Tab');await ready();
        await expect(input).toHaveValue(expected);
        expect((await dspCommand('GetConfigJson')).filters.mid_l_gain.parameters.gain).toBe(Number(expected));
        await expect(frame.locator('[data-way-channel="2"] .way-gain')).toHaveText(`${Number(expected)>0?'+':''}${expected.replace('-', '−')} dB`);
        await expect(frame.locator('[data-range="gain"]')).toHaveAttribute('min','-60');
        await expect(frame.locator('[data-range="gain"]')).toHaveAttribute('max','6');
      }
      await frame.locator('[data-polarity="true"]').tap();await ready();await expect(frame.locator('[data-polarity="true"]')).toHaveAttribute('aria-pressed','true');
      await frame.locator('[data-mute]').tap();await ready();await expect(frame.locator('#muteDetail')).toHaveText('MUTED');await expect(frame.locator('[data-mute]')).toHaveText('Unmute');
      // A fresh canonical demo has no MID PEQ. Create the test band explicitly;
      // the original configuration is restored in finally below.
      if(await frame.locator('.peq-row').count()===0){await frame.locator('#addPeq').tap();await ready();}
      const row=frame.locator('.peq-row').first(),power=row.locator('[data-peq-toggle]');
      const state=await power.getAttribute('aria-pressed');await power.tap();await ready();await expect(power).toHaveAttribute('aria-pressed',String(state!=='true'));
      const frequency=row.locator('[data-peq-field="freq"]');await frequency.fill('710');await frequency.press('Tab');await ready();await expect(frequency).toHaveValue('710');
      const peqSlot=await row.getAttribute('data-peq-slot');
      for(const field of ['freq','gain','q']) {
        const before=writes;
        await drag(`[data-peq-slider="${field}"][data-slot="${peqSlot}"]`,.35,.6);
        await ready();expect(writes).toBe(before+1);
        await expect(row.locator(`[data-peq-field="${field}"]`)).not.toHaveValue('');
      }
      // Horizontal way scrolling remains native, and vertical page scrolling is
      // available outside the range's isolated touch gesture area.
      const strip=frame.locator('#waySelector');await strip.evaluate(el=>{el.scrollLeft=0;el.scrollIntoView({block:'center'});});
      const box=await strip.boundingBox();await touch('touchStart',box.x+box.width*.85,box.y+30);
      for(let i=1;i<=8;i++)await touch('touchMove',box.x+box.width*(.85-.7*i/8),box.y+30);
      await touch('touchEnd');await expect.poll(()=>strip.evaluate(el=>el.scrollLeft)).toBeGreaterThan(20);
      for(const mode of ['magnitude','xo','phase']){await frame.locator(`button[data-graph-mode="${mode}"]`).tap();await expect(frame.locator('#responseGraph')).toHaveAttribute('data-graph-mode',mode);}
      const gainControl=frame.locator('[data-range="gain"]');await gainControl.evaluate(el=>el.scrollIntoView({block:'center'}));
      const gainBox=await gainControl.boundingBox(),cancelWrites=writes,cancelValue=await gainControl.inputValue();
      await touch('touchStart',gainBox.x+gainBox.width*.4,gainBox.y+30);await touch('touchMove',gainBox.x+gainBox.width*.6,gainBox.y+30);await touch('touchCancel');
      await expect(gainControl).toHaveValue(cancelValue);expect(writes).toBe(cancelWrites);
      const canvas=frame.locator('#responseGraph');await canvas.evaluate(el=>el.scrollIntoView({block:'center'}));
      const graphBox=await canvas.boundingBox(),scrollBefore=await page.evaluate(()=>scrollY)+await frame.evaluate(()=>scrollY);
      await touch('touchStart',graphBox.x+graphBox.width/2,graphBox.y+graphBox.height*.85);
      for(let i=1;i<=8;i++)await touch('touchMove',graphBox.x+graphBox.width/2,graphBox.y+graphBox.height*(.85-.6*i/8));
      await touch('touchEnd');
      await expect.poll(async()=>await page.evaluate(()=>scrollY)+await frame.evaluate(()=>scrollY)).toBeGreaterThan(scrollBefore+5);
      expect(await frame.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      holdAck=false;acknowledgements.splice(0).forEach(send=>send());
      await ready();
      if(JSON.stringify(await dspCommand('GetConfigJson'))!==JSON.stringify(original))await dspCommand({SetConfigJson:JSON.stringify(original)});
      expect(await dspCommand('GetConfigJson')).toEqual(original);
    }
  });
});
