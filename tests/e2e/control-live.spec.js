'use strict';

const { test, expect } = require('@playwright/test');
const WebSocket = require('ws');

const baseURL = process.env.ESTACK_E2E_BASE_URL || 'http://127.0.0.1:8080';
const target = new URL(baseURL);
const LEVEL_LOCK_STORAGE_KEY = 'estack.control.level.locked';

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function assertLocalLinuxDemo() {
    if (process.platform !== 'linux') throw new Error('E-Stack E2E must run inside the Linux Dev Container.');
    if (!['127.0.0.1', 'localhost', '::1'].includes(target.hostname)) throw new Error(`E-Stack E2E refuses non-local target '${baseURL}'.`);
}

function dspCommand(command, timeoutMs = 5_000) {
    const name = typeof command === 'string' ? command : Object.keys(command || {})[0];
    if (!name) return Promise.reject(new Error('Invalid CamillaDSP command.'));
    const endpoint = `${target.protocol === 'https:' ? 'wss:' : 'ws:'}//${target.host}/ws/dsp`;
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(endpoint);
        const finish = (error, value) => {
            clearTimeout(timer);
            socket.removeAllListeners();
            try { socket.close(); } catch (_) {}
            if (error) reject(error); else resolve(value);
        };
        const timer = setTimeout(() => finish(new Error(`${name} timed out through CamillaNode /ws/dsp.`)), timeoutMs);
        socket.once('error', error => finish(error));
        socket.once('open', () => socket.send(JSON.stringify(command)));
        socket.on('message', raw => {
            let reply;
            try { reply = JSON.parse(String(raw)); } catch (_) { return; }
            if (!Object.prototype.hasOwnProperty.call(reply, name)) return;
            const result = reply[name] || {};
            if (result.result !== 'Ok') return finish(new Error(result.value || `${name} failed.`));
            let value = result.value;
            if (name === 'GetConfigJson' && typeof value === 'string') {
                try { value = JSON.parse(value); } catch (_) { return finish(new Error('CamillaDSP returned invalid configuration JSON.')); }
            }
            finish(null, value);
        });
    });
}

async function requireDemoRuntime(request) {
    assertLocalLinuxDemo();
    const response = await request.get('/api/runtime');
    expect(response.ok()).toBeTruthy();
    const runtime = await response.json();
    expect(runtime).toMatchObject({ mode: 'demo', httpPort: 8080, dspPort: 1234, spectrumPort: 6413 });
}

async function controlFrame(page) {
    await expect.poll(() => page.frames().some(frame => new URL(frame.url()).pathname.endsWith('/pages/control/page.html'))).toBeTruthy();
    return page.frames().find(frame => new URL(frame.url()).pathname.endsWith('/pages/control/page.html'));
}

function assertOnlySubGainChanged(before, after, targetGain) {
    expect(after.devices).toEqual(before.devices);
    expect(after.mixers).toEqual(before.mixers);
    expect(after.pipeline).toEqual(before.pipeline);
    expect(after.processors).toEqual(before.processors);
    expect(Object.keys(after.filters).sort()).toEqual(Object.keys(before.filters).sort());
    for (const name of Object.keys(before.filters)) {
        if (name === 'sub_gain') continue;
        expect(after.filters[name]).toEqual(before.filters[name]);
    }
    const originalSub = clone(before.filters.sub_gain);
    const changedSub = clone(after.filters.sub_gain);
    delete originalSub.parameters.gain;
    delete changedSub.parameters.gain;
    expect(changedSub).toEqual(originalSub);
    expect(after.filters.sub_gain.parameters.mute).toBe(before.filters.sub_gain.parameters.mute);
    expect(after.filters.sub_gain.parameters.gain).toBeCloseTo(targetGain, 6);
}

async function setSubGainThroughFader(frame, targetGain) {
    const core = frame.locator('[data-fader-core="0"]');
    await expect(core).toBeVisible();
    const position = await frame.evaluate(value => window.EStackControlFaderPresentation.positionPercent(value, -60, 6), targetGain);
    const box = await core.boundingBox();
    if (!box) throw new Error('SUB fader is not measurable.');
    await core.click({ position: { x: box.width / 2, y: box.height * position / 100 } });
}

test.describe('Control live CamillaNode demo', () => {
    test('mobile trim survives telemetry and shares shell processing load', async ({ page, request }) => {
        await requireDemoRuntime(request);
        const original = await dspCommand('GetConfigJson');
        const volume = await dspCommand('GetVolume');
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto('/estack-dsp/?transport=camillanode#control');
        const frame = await controlFrame(page);
        const slider = frame.locator('#inputTrimRange');
        await expect(slider).toBeEnabled();
        await expect.poll(() => frame.locator('[data-control-load]').textContent()).toMatch(/\d+\.\d+ %/);
        await expect.poll(async () => {
            return (await page.locator('[data-shell-load]').textContent()) === (await frame.locator('[data-control-load]').textContent());
        }).toBeTruthy();
        const initial = Number(await slider.inputValue());
        const target = initial > 0 ? initial - 1 : initial + 1;
        try {
            await slider.scrollIntoViewIfNeeded();
            await slider.dispatchEvent('pointerdown', { pointerId: 7, pointerType: 'touch' });
            await slider.evaluate((element, value) => { element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); }, String(target));
            await page.waitForTimeout(650);
            await expect(slider).toHaveValue(String(target));
            expect(await dspCommand('GetConfigJson')).toEqual(original);
            await slider.dispatchEvent('pointerup', { pointerId: 7, pointerType: 'touch' });
            await expect(frame.locator('#controlStatus')).toContainText('synchronized');
            expect(await dspCommand('GetVolume')).toBeCloseTo(volume, 5);
            const number = frame.locator('#inputTrimNumber');
            await number.fill(String(initial));
            await number.press('Tab');
            await expect.poll(() => dspCommand('GetConfigJson')).toEqual(original);
            await expect(slider).toBeEnabled();
            expect(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
        } finally {
            if (JSON.stringify(await dspCommand('GetConfigJson')) !== JSON.stringify(original)) await dspCommand({ SetConfigJson: JSON.stringify(original) });
            if ((await dspCommand('GetVolume')) !== volume) await dspCommand({ SetVolume: volume });
        }
    });
    test('renders live Control and restores a narrow SUB gain round trip', async ({ page, request }) => {
        await requireDemoRuntime(request);
        const original = await dspCommand('GetConfigJson');
        const originalGain = Number(original?.filters?.sub_gain?.parameters?.gain);
        expect(Number.isFinite(originalGain)).toBeTruthy();
        const testGain = originalGain <= -59.5 ? Number((originalGain + 0.5).toFixed(1)) : Number((originalGain - 0.5).toFixed(1));
        expect(testGain).not.toBe(originalGain);

        await page.goto('/estack-dsp/?transport=camillanode#control');
        const previousLock = await page.evaluate(key => window.localStorage.getItem(key), LEVEL_LOCK_STORAGE_KEY);
        await page.evaluate(key => window.localStorage.removeItem(key), LEVEL_LOCK_STORAGE_KEY);
        await page.reload();
        await expect(page.locator('html')).toHaveAttribute('data-transport', 'live');
        await expect(page.locator('.shell-context')).toContainText('DSP ONLINE');
        let frame = await controlFrame(page);
        await expect(frame.locator('.control-page')).toBeVisible();
        await expect.poll(() => frame.evaluate(() => ({
            mode: window.EStackDSPBridge?.mode,
            connected: window.EStackDSPBridge?.connected,
            page: document.documentElement.dataset.prototypePage
        }))).toEqual({ mode: 'camillanode', connected: true, page: 'control' });
        await expect(frame.locator('article.mixer-strip:not(.master-strip)')).toHaveCount(6);
        await expect(frame.locator('article.master-strip')).toHaveCount(1);
        await expect(frame.locator('[data-link-toggle]')).toHaveCount(2);
            await expect(frame.locator('[data-mute]')).toHaveCount(7);
        await expect(frame.locator('article.mixer-strip').filter({ hasText: 'OUT 7' })).toHaveCount(0);
        await expect(frame.locator('article.mixer-strip').filter({ hasText: 'OUT 8' })).toHaveCount(0);
        await expect.poll(() => frame.locator('[data-input-meter]').count()).toBeGreaterThan(0);
        const liveWays = frame.locator('article.mixer-strip:not(.master-strip)');
        await expect(liveWays.locator('.legacy-fader-handle')).toHaveCount(6);
        await expect(liveWays.locator('.legacy-gain-scale')).toHaveCount(6);
        for (let index = 0; index < 6; index += 1) {
            await expect(liveWays.nth(index).locator('.legacy-fader-handle')).toBeVisible();
            await expect(liveWays.nth(index).locator('.legacy-gain-scale')).toBeVisible();
        }
        const levelLock = frame.locator('[data-level-lock]');
        await expect(levelLock).toBeVisible();

        let restoredByProduct = false;
        try {
            await levelLock.click();
            await expect(frame.locator('[data-level-lock]')).toHaveAttribute('aria-pressed', 'true');
            await expect(frame.locator('input[data-number="0"]')).toBeDisabled();
            await expect(frame.locator('[data-fader-core="0"]')).toHaveAttribute('aria-disabled', 'true');
            await expect(frame.locator('[data-nudge="0"]')).toHaveCount(4);
            await expect(frame.locator('[data-nudge="0"]').first()).toBeDisabled();
            await expect(frame.locator('article.master-strip input[data-number="master"]')).not.toBeDisabled();
            await expect(frame.locator('[data-fader-core="master"]')).toHaveAttribute('aria-disabled', 'false');
            await expect(frame.locator('[data-mute="0"]')).not.toBeDisabled();
            await frame.locator('[data-fader-core="0"]').dispatchEvent('pointerdown', { pointerId: 1, button: 0, clientY: 8 });
            await frame.locator('[data-fader-core="0"]').dispatchEvent('pointerup', { pointerId: 1, button: 0, clientY: 8 });
            await expect.poll(async () => Number((await dspCommand('GetConfigJson')).filters.sub_gain.parameters.gain)).toBeCloseTo(originalGain, 6);

            await page.reload();
            frame = await controlFrame(page);
            await expect(frame.locator('[data-level-lock]')).toHaveAttribute('aria-pressed', 'true');
            await expect(frame.locator('input[data-number="0"]')).toBeDisabled();
            await frame.locator('[data-level-lock]').click();
            await expect(frame.locator('[data-level-lock]')).toHaveAttribute('aria-pressed', 'false');

            await setSubGainThroughFader(frame, testGain);
            await expect.poll(async () => Number((await dspCommand('GetConfigJson')).filters.sub_gain.parameters.gain)).toBeCloseTo(testGain, 6);
            const changed = await dspCommand('GetConfigJson');
            assertOnlySubGainChanged(original, changed, testGain);

            await setSubGainThroughFader(frame, originalGain);
            await expect.poll(async () => Number((await dspCommand('GetConfigJson')).filters.sub_gain.parameters.gain)).toBeCloseTo(originalGain, 6);
            const restored = await dspCommand('GetConfigJson');
            expect(restored).toEqual(original);
            restoredByProduct = true;
            console.log(`Control E2E SUB gain: ${originalGain.toFixed(1)} dB -> ${testGain.toFixed(1)} dB -> ${originalGain.toFixed(1)} dB`);
        } finally {
            // An assertion failure must not leave the demo altered. Prefer the
            // product path; the guarded same-origin proxy fallback restores the
            // exact captured demo snapshot only after the demo-only guard above.
            const live = await dspCommand('GetConfigJson');
            if (JSON.stringify(live) !== JSON.stringify(original)) {
                if (!restoredByProduct) {
                    try {
                        await setSubGainThroughFader(frame, originalGain);
                        await expect.poll(async () => Number((await dspCommand('GetConfigJson')).filters.sub_gain.parameters.gain)).toBeCloseTo(originalGain, 6);
                    } catch (_) {
                        await dspCommand({ SetConfigJson: JSON.stringify(original) });
                    }
                } else {
                    await dspCommand({ SetConfigJson: JSON.stringify(original) });
                }
            }
            expect(await dspCommand('GetConfigJson')).toEqual(original);
            await page.evaluate(({ key, value }) => {
                if (value === null) window.localStorage.removeItem(key);
                else window.localStorage.setItem(key, value);
            }, { key: LEVEL_LOCK_STORAGE_KEY, value: previousLock });
        }
    });
});
