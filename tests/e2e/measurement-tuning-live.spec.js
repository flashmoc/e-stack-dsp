const { test, expect } = require('@playwright/test');
const { demo, dsp } = require('./batch-helpers');
const fs = require('fs');

test('version 3 input and way EQ candidates use the captured baseline and restore it', async ({ request }) => {
    await demo(request);
    expect((await (await request.get('/api/measurement-batch/status')).json()).active).toBe(false);
    const baseline = await dsp('GetConfigJson');
    const master = await dsp('GetVolume');
    const file = 'config/measurement-batch.json';
    const saved = fs.existsSync(file) ? fs.readFileSync(file) : null;
    const gain = baseline.filters.mid_l_gain.parameters.gain;
    const batch = { version: 3, name: 'Input EQ E2E', defaults: { settleMs: 0, measurementInput: 3 }, steps: [
        { id: 'A', activeWays: ['MID_L'], inputEq: {
            geq: { enabled: true, targets: [-1, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
            peq: { enabled: true, bands: [{ slot: 1, freqHz: 125, q: 1, gainDb: -2 }] }
        }, ways: { MID_L: { gainDb: gain - 2, peq: [{ slot: 8, freqHz: 1400, q: 1, gainDb: -2 }] } } },
        { id: 'B', activeWays: ['MID_L'] }
    ] };
    const post = async path => request.post(path, { data: {} });
    try {
        expect((await request.post('/api/measurement-batch/import', { data: batch })).ok()).toBe(true);
        expect((await post('/api/measurement-batch/start')).ok()).toBe(true);
        const candidate = await dsp('GetConfigJson');
        expect(candidate.filters.GLOBAL_EQ_01.parameters.gain).toBe(-2);
        expect(candidate.filters.USER_CH2_PEQ_08.parameters.gain).toBe(-2);
        expect(candidate.filters.mid_l_gain.parameters.gain).toBe(gain - 2);
        expect(candidate.devices).toEqual(baseline.devices);
        expect(candidate.processors).toEqual(baseline.processors);
        for (const name of Object.keys(baseline.mixers)) expect(candidate.mixers[name].channels).toEqual(baseline.mixers[name].channels);
        expect((await post('/api/measurement-batch/next')).ok()).toBe(true);
        const unchanged = await dsp('GetConfigJson');
        expect(unchanged.filters.USER_CH2_PEQ_08).toBeUndefined();
        expect(unchanged.filters.mid_l_gain.parameters.gain).toBe(gain);
        expect((await post('/api/measurement-batch/next')).ok()).toBe(true);
        expect(await dsp('GetConfigJson')).toEqual(baseline);
        expect(await dsp('GetVolume')).toBe(master);
        expect((await post('/api/measurement-batch/start')).ok()).toBe(true);
        expect((await post('/api/measurement-batch/abort')).ok()).toBe(true);
        expect(await dsp('GetConfigJson')).toEqual(baseline);
        expect(await dsp('GetVolume')).toBe(master);
    } finally {
        await post('/api/measurement-batch/abort');
        expect(await dsp('GetConfigJson')).toEqual(baseline);
        if (saved) fs.writeFileSync(file, saved);
        else if (fs.existsSync(file)) fs.unlinkSync(file);
    }
});
