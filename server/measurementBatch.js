'use strict';

const fs = require('fs');
const path = require('path');
const model = require('./measurementBatchModel');
require('./measurementBatchInputRouting')(model);
const baselineView = require('./measurementBatchBaseline');

const SAFE_VOLUME_DB = -60;

module.exports = function registerMeasurementBatch(app, options = {}) {
    const WebSocket = options.WebSocket || require('ws');
    const host = options.host || process.env.CAMILLADSP_PROXY_HOST || '127.0.0.1';
    const port = Number(options.port || process.env.CAMILLADSP_PORT || 1234);
    const root = options.root || path.resolve(__dirname, '..');
    const runtimeDir = options.runtimeDir || path.join(root, 'config');
    const batchFile = options.batchFile || path.join(runtimeDir, 'measurement-batch.json');
    const sessionFile = options.sessionFile || path.join(runtimeDir, 'measurement-batch-session.json');
    const signalSnapshotPath = options.signalSnapshotPath || process.env.ESTACK_SIGNAL_SNAPSHOT || '/tmp/camillanode-estack-test-signal.json';

    fs.mkdirSync(runtimeDir, { recursive: true });
    let transition = Promise.resolve();

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    function bootId() {
        try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); }
        catch (_) { return null; }
    }

    function atomicWrite(file, value) {
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(tmp, file);
    }

    function readFile(file, fallback = null) {
        try {
            if (!fs.existsSync(file)) return fallback;
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (error) {
            throw new Error(`${path.basename(file)} is invalid: ${error.message}`);
        }
    }

    function readBatch() {
        const raw = readFile(batchFile);
        return raw ? model.normalizeBatch(raw) : null;
    }
    const writeBatch = batch => atomicWrite(batchFile, model.normalizeBatch(batch));
    const readSession = () => readFile(sessionFile);
    const writeSession = session => atomicWrite(sessionFile, session);
    function clearSession() {
        try { fs.unlinkSync(sessionFile); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }

    function readBody(req, limit = 2 * 1024 * 1024) {
        return new Promise((resolve, reject) => {
            let body = '';
            req.on('data', chunk => {
                body += chunk;
                if (Buffer.byteLength(body, 'utf8') > limit) {
                    reject(new Error('Measurement batch request is too large'));
                    req.destroy();
                }
            });
            req.on('end', () => {
                if (!body.trim()) return resolve({});
                try { resolve(JSON.parse(body)); }
                catch (_) { reject(new Error('Invalid JSON body')); }
            });
            req.on('error', reject);
        });
    }

    function openDsp(timeoutMs = 2500) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://${host}:${port}`);
            const timer = setTimeout(() => {
                try { ws.terminate?.(); } catch (_) {}
                reject(new Error('CamillaDSP connection timeout'));
            }, timeoutMs);
            ws.once('open', () => { clearTimeout(timer); resolve(ws); });
            ws.once('error', error => {
                clearTimeout(timer);
                reject(new Error(`CamillaDSP unavailable: ${error.message}`));
            });
        });
    }

    function request(ws, command, timeoutMs = 4000) {
        const name = typeof command === 'string' ? command : Object.keys(command || {})[0];
        if (!name) return Promise.reject(new Error('Invalid CamillaDSP command'));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                ws.off('message', onMessage);
                reject(new Error(`${name} timed out`));
            }, timeoutMs);

            function onMessage(data) {
                let response;
                try { response = JSON.parse(String(data)); }
                catch (_) { return; }
                if (!Object.prototype.hasOwnProperty.call(response, name)) return;
                clearTimeout(timer);
                ws.off('message', onMessage);
                const payload = response[name] || {};
                if (payload.result !== 'Ok') return reject(new Error(`${name} failed: ${payload.value || payload.result || 'unknown error'}`));
                let value = payload.value;
                if (name === 'GetConfigJson') {
                    try { value = JSON.parse(value); }
                    catch (_) { return reject(new Error('CamillaDSP returned invalid configuration JSON')); }
                }
                resolve(value);
            }

            ws.on('message', onMessage);
            try { ws.send(JSON.stringify(command)); }
            catch (error) {
                clearTimeout(timer);
                ws.off('message', onMessage);
                reject(error);
            }
        });
    }

    function queue(operation) {
        const run = () => require('./workflowGate')(operation);
        const next = transition.then(run, run);
        transition = next.catch(() => {});
        return next;
    }

    async function liveConfig() {
        const ws = await openDsp();
        try { return await request(ws, 'GetConfigJson'); }
        finally { try { ws.close(); } catch (_) {} }
    }

    async function applyProcessing(targetConfig, settleMs = 0) {
        const ws = await openDsp();
        let oldVolume = null;
        let restored = false;
        try {
            const value = Number(await request(ws, 'GetVolume'));
            if (Number.isFinite(value)) oldVolume = value;
            await request(ws, { SetVolume: oldVolume == null ? SAFE_VOLUME_DB : Math.min(oldVolume, SAFE_VOLUME_DB) });
            const live = await request(ws, 'GetConfigJson');
            await request(ws, { SetConfigJson: JSON.stringify(model.mergeProcessingIntoLive(live, targetConfig)) }, 6500);
            const verified = await request(ws, 'GetConfigJson', 5000);
            if (!model.sameProcessing(verified, targetConfig)) throw new Error('CamillaDSP did not retain the requested measurement processing state');
            if (oldVolume != null) {
                await request(ws, { SetVolume: oldVolume });
                restored = true;
            }
        } finally {
            if (!restored && oldVolume != null) {
                try { await request(ws, { SetVolume: oldVolume }, 1800); } catch (_) {}
            }
            try { ws.close(); } catch (_) {}
        }
        if (settleMs > 0) await sleep(settleMs);
    }

    function preflight(batch, baseline) {
        if (baseline?.devices?.capture?.type === 'SignalGenerator' || fs.existsSync(signalSnapshotPath)) {
            throw new Error('Stop the E-Stack Signal Generator before starting a measurement batch');
        }
        for (let i = 0; i < batch.steps.length; i += 1) {
            try { model.applyStep(baseline, batch, i); }
            catch (error) { throw new Error(`${batch.steps[i].id}: ${error.message}`); }
        }
    }

    const normalizedSessionBatch = session => session?.batch ? model.normalizeBatch(session.batch) : null;

    function summarizeSessionBaseline(session, batch) {
        if (!session?.baselineConfig) return null;
        return baselineView.summarizeBaseline(session.baselineConfig, {
            captured: true,
            capturedAt: session.startedAt || null,
            measurementInput: batch?.defaults?.measurementInput
        });
    }

    async function baselineState() {
        const session = readSession();
        if (session?.baselineConfig) {
            const batch = normalizedSessionBatch(session);
            return { ok: true, baseline: summarizeSessionBaseline(session, batch) };
        }
        const batch = readBatch();
        const config = await liveConfig();
        return {
            ok: true,
            baseline: baselineView.summarizeBaseline(config, {
                captured: false,
                capturedAt: null,
                measurementInput: batch?.defaults?.measurementInput
            })
        };
    }

    function state(extra = {}) {
        let batch = null;
        let session = null;
        let error = null;
        try { batch = readBatch(); } catch (err) { error = err.message; }
        try {
            session = readSession();
            if (session) batch = normalizedSessionBatch(session);
        } catch (err) { error = error || err.message; }

        const total = batch?.steps?.length || 0;
        const active = !!session && !!batch;
        const completed = active
            ? [...new Set((session.completed || []).map(Number))].filter(Number.isInteger).sort((a, b) => a - b)
            : [];
        const sequence = batch ? batch.steps.map((step, index) => model.describeStep(step, index, total)) : [];
        const current = active ? sequence[session.currentIndex] : null;
        const next = active && session.currentIndex + 1 < total ? sequence[session.currentIndex + 1] : null;
        const message = error
            || (!batch ? 'NO BATCH · import a Measurement Batch JSON file'
                : !active ? `READY · ${batch.name} · ${total} measurements`
                    : `READY · ${current.summary}`);

        return {
            ok: !error,
            phase: error ? 'error' : active ? 'active' : batch ? 'ready' : 'empty',
            error,
            batch: batch ? {
                schema: batch.schema,
                version: batch.version,
                name: batch.name,
                description: batch.description,
                total,
                defaults: model.clone(batch.defaults)
            } : null,
            baseline: active ? summarizeSessionBaseline(session, batch) : null,
            sequence,
            active,
            progress: {
                currentIndex: active ? session.currentIndex : null,
                currentNumber: active ? session.currentIndex + 1 : null,
                total,
                completedCount: completed.length,
                completed
            },
            current,
            next,
            startedAt: active ? session.startedAt : null,
            message,
            endpoints: {
                status: '/api/measurement-batch/status',
                baseline: '/api/measurement-batch/baseline',
                next: '/api/measurement-batch/next',
                previous: '/api/measurement-batch/previous',
                retry: '/api/measurement-batch/retry',
                abort: '/api/measurement-batch/abort'
            },
            ...extra
        };
    }

    async function start() {
        if (readSession()) return state();
        const batch = readBatch();
        if (!batch) throw new Error('Import a Measurement Batch before starting');
        const baselineConfig = await liveConfig();
        preflight(batch, baselineConfig);

        const session = {
            version: 1,
            bootId: bootId(),
            startedAt: new Date().toISOString(),
            batch,
            baselineConfig,
            currentIndex: 0,
            completed: []
        };
        writeSession(session);
        try {
            await applyProcessing(model.applyStep(baselineConfig, batch, 0), batch.defaults.settleMs);
            return state({ applied: true });
        } catch (error) {
            try { await applyProcessing(baselineConfig, 0); } catch (_) {}
            clearSession();
            throw error;
        }
    }

    async function applyIndex(index, completed) {
        const session = readSession();
        if (!session) throw new Error('No active measurement batch');
        const batch = normalizedSessionBatch(session);
        if (!Number.isInteger(index) || index < 0 || index >= batch.steps.length) throw new Error('Measurement index is out of range');
        await applyProcessing(model.applyStep(session.baselineConfig, batch, index), batch.defaults.settleMs);
        session.currentIndex = index;
        session.completed = [...new Set((completed ?? session.completed ?? []).map(Number))]
            .filter(value => Number.isInteger(value) && value >= 0 && value < batch.steps.length)
            .sort((a, b) => a - b);
        writeSession(session);
        return state({ applied: true });
    }

    async function next() {
        const session = readSession();
        if (!session) return start();
        const batch = normalizedSessionBatch(session);
        const completed = [...new Set([...(session.completed || []), session.currentIndex])].sort((a, b) => a - b);
        if (session.currentIndex < batch.steps.length - 1) return applyIndex(session.currentIndex + 1, completed);

        await applyProcessing(session.baselineConfig, batch.defaults.settleMs);
        clearSession();
        const result = state();
        return {
            ...result,
            phase: 'complete',
            active: false,
            restored: true,
            completed: true,
            progress: {
                currentIndex: null,
                currentNumber: null,
                total: batch.steps.length,
                completedCount: batch.steps.length,
                completed: Array.from({ length: batch.steps.length }, (_, index) => index)
            },
            message: `COMPLETE · ${batch.name} · ${batch.steps.length}/${batch.steps.length} · normal DSP processing restored`
        };
    }

    async function previous() {
        const session = readSession();
        if (!session) throw new Error('No active measurement batch');
        const index = Math.max(0, session.currentIndex - 1);
        return applyIndex(index, (session.completed || []).filter(value => Number(value) < index));
    }

    async function retry() {
        const session = readSession();
        if (!session) throw new Error('No active measurement batch');
        return applyIndex(session.currentIndex, session.completed || []);
    }

    async function goTo(body) {
        const session = readSession();
        if (!session) throw new Error('No active measurement batch');
        const batch = normalizedSessionBatch(session);
        let index = body?.index != null ? Number(body.index) : null;
        if (index == null && body?.number != null) index = Number(body.number) - 1;
        if (!Number.isInteger(index) || index < 0 || index >= batch.steps.length) throw new Error('Provide a valid measurement index or 1-based number');
        return applyIndex(index, (session.completed || []).filter(value => Number(value) < index));
    }

    async function abort(reason = 'manual abort') {
        const session = readSession();
        if (!session) return state({ restored: false, reason: 'No active measurement batch' });
        const batch = normalizedSessionBatch(session);
        await applyProcessing(session.baselineConfig, batch.defaults.settleMs);
        clearSession();
        return state({ restored: true, aborted: true, message: `RESTORED · ${batch.name} · ${reason} · normal DSP processing restored` });
    }

    function statusCode(error) {
        return /CamillaDSP|GetConfigJson|SetConfigJson|GetVolume|SetVolume|connection timeout|ECONNREFUSED/i.test(String(error?.message || error)) ? 503 : 400;
    }
    function fail(res, error) {
        res.status(statusCode(error)).json({ ok: false, phase: 'error', error: error.message, message: error.message });
    }

    app.get('/api/measurement-batch/status', (_req, res) => {
        try { res.json(state()); }
        catch (error) { res.status(500).json({ ok: false, phase: 'error', error: error.message, message: error.message }); }
    });

    app.get('/api/measurement-batch/baseline', async (_req, res) => {
        try { res.json(await baselineState()); }
        catch (error) { fail(res, error); }
    });

    app.post('/api/measurement-batch/import', async (req, res) => {
        try {
            if (readSession()) throw new Error('Abort or complete the active measurement batch before importing another batch');
            const body = await readBody(req);
            writeBatch(body.batch ?? body);
            res.json(state({ imported: true }));
        } catch (error) { fail(res, error); }
    });

    app.post('/api/measurement-batch/start', async (_req, res) => {
        try { res.json(await queue(start)); } catch (error) { fail(res, error); }
    });
    app.post('/api/measurement-batch/next', async (_req, res) => {
        try { res.json(await queue(next)); } catch (error) { fail(res, error); }
    });
    app.post('/api/measurement-batch/previous', async (_req, res) => {
        try { res.json(await queue(previous)); } catch (error) { fail(res, error); }
    });
    app.post('/api/measurement-batch/retry', async (_req, res) => {
        try { res.json(await queue(retry)); } catch (error) { fail(res, error); }
    });
    app.post('/api/measurement-batch/goto', async (req, res) => {
        try {
            const body = await readBody(req, 64 * 1024);
            res.json(await queue(() => goTo(body)));
        } catch (error) { fail(res, error); }
    });
    app.post('/api/measurement-batch/abort', async (_req, res) => {
        try { res.json(await queue(() => abort('manual abort'))); } catch (error) { fail(res, error); }
    });
    app.post('/api/measurement-batch/clear', async (_req, res) => {
        try {
            if (readSession()) throw new Error('Abort or complete the active batch before clearing it');
            try { fs.unlinkSync(batchFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            res.json(state({ cleared: true }));
        } catch (error) { fail(res, error); }
    });

    function recover(attempt = 1) {
        const session = readSession();
        if (!session) return;
        const currentBoot = bootId();
        if (session.bootId && currentBoot && session.bootId !== currentBoot) {
            clearSession();
            console.warn('Measurement Batch: discarded stale session from a previous Raspberry boot; startup recall owns the new boot state.');
            return;
        }

        queue(async () => {
            const current = readSession();
            if (!current?.baselineConfig) return true;
            const batch = normalizedSessionBatch(current);
            try {
                await applyProcessing(current.baselineConfig, batch?.defaults?.settleMs || 0);
                clearSession();
                console.warn('Measurement Batch: restored normal DSP processing after E-Stack DSP restart.');
                return true;
            } catch (error) {
                console.error(`Measurement Batch recovery attempt ${attempt} failed:`, error.message);
                return false;
            }
        }).then(done => {
            if (!done && attempt < 15) setTimeout(() => recover(attempt + 1), 2000);
        }).catch(error => {
            console.error('Measurement Batch recovery failed:', error.message);
            if (attempt < 15) setTimeout(() => recover(attempt + 1), 2000);
        });
    }

    setTimeout(() => recover(), 1800);

    return {
        getState: state,
        getBaseline: baselineState,
        start: () => queue(start),
        next: () => queue(next),
        abort: () => queue(() => abort('external abort'))
    };
};
