const { test, expect } = require('@playwright/test');
const { demo, dsp } = require('./batch-helpers');
const fs = require('fs');

test('version 2 output PEQ is temporary and exact DSP state is restored', async ({ request }) => {
    await demo(request);
    expect((await (await request.get('/api/measurement-batch/status')).json()).active).toBe(false);
    const baseline = await dsp('GetConfigJson');
    const master = await dsp('GetVolume');
    const file = 'config/measurement-batch.json';
    const saved = fs.existsSync(file) ? fs.readFileSync(file) : null;
    const slot = Array.from({ length: 10 }, (_, index) => index + 1)
        .find(index => !baseline.filters[`USER_CH1_PEQ_${String(index).padStart(2, '0')}`]);
    expect(slot).toBeDefined();
    const filterName = `USER_CH1_PEQ_${String(slot).padStart(2, '0')}`;
    const batch = { version: 2, name: 'Output PEQ E2E', defaults: { settleMs: 0 }, steps: [
        { id: 'A', activeWays: ['KICK'], ways: { KICK: { peq: [{ slot, freqHz: 180, q: 1.2, gainDb: -2 }] } } },
        { id: 'B', activeWays: ['KICK'] }
    ] };
    const post = async path => request.post(path, { data: {} });
    try {
        expect((await request.post('/api/measurement-batch/import', { data: batch })).ok()).toBe(true);
        expect((await post('/api/measurement-batch/start')).ok()).toBe(true);
        const candidate = await dsp('GetConfigJson');
        expect(candidate.filters[filterName].parameters).toEqual({ type: 'Peaking', freq: 180, q: 1.2, gain: -2 });
        expect(candidate.devices).toEqual(baseline.devices);
        expect(candidate.mixers).toEqual(baseline.mixers);
        expect(candidate.processors).toEqual(baseline.processors);
        expect((await post('/api/measurement-batch/next')).ok()).toBe(true);
        const unchangedStep = await dsp('GetConfigJson');
        expect(unchangedStep.filters[filterName]).toBeUndefined();
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
