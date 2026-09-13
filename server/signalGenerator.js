const fs = require('fs');
const path = require('path');

module.exports = function installEStackSignalGenerator(app, options = {}) {
    const WebSocket = options.WebSocket || require('ws');
    const host = options.host || process.env.CAMILLADSP_PROXY_HOST || '127.0.0.1';
    const port = Number.parseInt(options.port || process.env.CAMILLADSP_PORT || '1234', 10);
    const snapshotPath = options.snapshotPath || process.env.ESTACK_SIGNAL_SNAPSHOT || '/tmp/camillanode-estack-test-signal.json';
    const measurementSessionPath = options.measurementSessionPath
        || process.env.ESTACK_MEASUREMENT_SESSION
        || path.resolve(__dirname, '..', 'config', 'measurement-batch-session.json');
    const OUTPUTS = new Set([0, 1, 2, 3, 4, 5]);
    const MAX_DURATION_SECONDS = 120;

    let state = {
        active: false,
        startedAt: null,
        stopsAt: null,
        type: null,
        freq: null,
        level: null,
        targets: [],
        duration: null
    };
    let restoreTimer = null;
    let transition = Promise.resolve();

    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

    function commandName(command) {
        return typeof command === 'string' ? command : Object.keys(command || {})[0];
    }

    function sendCommand(command, timeoutMs = 3000) {
        const expected = commandName(command);
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://${host}:${port}`);
            let settled = false;
            const timeout = setTimeout(() => finish(new Error(`CamillaDSP ${expected} timed out`)), timeoutMs);

            function finish(error, value) {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                try { ws.close(); } catch (_) {}
                if (error) reject(error); else resolve(value);
            }

            ws.on('open', () => {
                try { ws.send(JSON.stringify(command)); }
                catch (error) { finish(error); }
            });
            ws.on('message', data => {
                try {
                    const response = JSON.parse(data.toString());
                    const name = Object.keys(response || {})[0];
                    if (name !== expected) return;
                    const result = response[name] || {};
                    if (result.result !== 'Ok') {
                        finish(new Error(`${expected} failed: ${result.value || result.result || 'unknown error'}`));
                        return;
                    }
                    finish(null, result.value);
                } catch (error) {
                    finish(error);
                }
            });
            ws.on('error', finish);
            ws.on('close', () => {
                if (!settled) finish(new Error(`CamillaDSP connection closed during ${expected}`));
            });
        });
    }

    async function getConfig() {
        const value = await sendCommand('GetConfigJson');
        return typeof value === 'string' ? JSON.parse(value) : value;
    }

    async function setConfig(config) {
        await sendCommand({ SetConfigJson: JSON.stringify(config) }, 5000);
    }

    function clearTimer() {
        if (restoreTimer) clearTimeout(restoreTimer);
        restoreTimer = null;
    }

    function clearSnapshotFile() {
        try { fs.unlinkSync(snapshotPath); } catch (error) {
            if (error.code !== 'ENOENT') console.error('E-Stack signal snapshot cleanup failed:', error.message);
        }
    }

    function readSnapshotFile() {
        try {
            return JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
        } catch (error) {
            if (error.code !== 'ENOENT') console.error('E-Stack signal snapshot read failed:', error.message);
            return null;
        }
    }

    function writeSnapshotFile(snapshot, metadata) {
        fs.writeFileSync(snapshotPath, JSON.stringify({
            version: 1,
            createdAt: new Date().toISOString(),
            snapshot,
            metadata
        }), { mode: 0o600 });
    }

    function firstMixer(config) {
        const step = (config?.pipeline || []).find(item => item?.type === 'Mixer');
        if (!step) throw new Error('E-Stack test generator requires a mixer in the DSP pipeline');
        const mixer = config?.mixers?.[step.name];
        if (!mixer || !Array.isArray(mixer.mapping)) throw new Error(`Mixer '${step.name}' has no editable mapping`);
        return mixer;
    }

    function inputChannelCount(config) {
        const direct = Number(config?.devices?.capture?.channels);
        if (Number.isInteger(direct) && direct > 0) return direct;
        const mixer = firstMixer(config);
        const count = Number(mixer?.channels?.in);
        if (Number.isInteger(count) && count > 0) return count;
        throw new Error('Cannot determine SignalGenerator input channel count');
    }

    function routeOnlyTargets(config, targets) {
        const targetSet = new Set(targets.map(Number));
        const mixer = firstMixer(config);
        const seen = new Set();
        for (const mapping of mixer.mapping) {
            const dest = Number(mapping?.dest);
            if (!Number.isInteger(dest)) continue;
            seen.add(dest);
            mapping.mute = !targetSet.has(dest);
        }
        for (const target of targetSet) {
            if (!seen.has(target)) throw new Error(`Output ${target + 1} is not routed by the first E-Stack mixer`);
        }
    }

    function normalizeTargets(input) {
        const values = Array.isArray(input) ? input : [input];
        const targets = [...new Set(values.map(Number).filter(value => Number.isInteger(value) && OUTPUTS.has(value)))];
        if (!targets.length) throw new Error('Select at least one E-Stack output');
        return targets.sort((a, b) => a - b);
    }

    function safeLevelCap(type, targets) {
        const white = type === 'WhiteNoise';
        if (targets.some(channel => channel >= 4)) return white ? -30 : -20;
        if (targets.some(channel => channel >= 2)) return white ? -25 : -15;
        return white ? -20 : -10;
    }

    function normalizeRequest(body) {
        const type = body?.type === 'WhiteNoise' ? 'WhiteNoise' : 'Sine';
        const targets = normalizeTargets(body?.targets);
        const cap = safeLevelCap(type, targets);
        const requestedLevel = Number(body?.level);
        const level = Number.isFinite(requestedLevel) ? Math.max(-80, Math.min(cap, requestedLevel)) : -40;
        const requestedDuration = Number(body?.duration);
        const duration = Number.isFinite(requestedDuration)
            ? Math.max(5, Math.min(MAX_DURATION_SECONDS, Math.round(requestedDuration)))
            : 30;
        let freq = null;
        if (type === 'Sine') {
            const requestedFreq = Number(body?.freq);
            if (!Number.isFinite(requestedFreq)) throw new Error('Sine frequency is required');
            freq = Math.max(10, Math.min(20000, requestedFreq));
        }
        return { type, targets, level, freq, duration, cap };
    }

    async function restoreFromRecord(record, reason = 'manual stop') {
        if (!record?.snapshot) return false;
        // Do not cancel the existing safety timer until the normal configuration
        // has actually been accepted by CamillaDSP. A temporary DSP outage must
        // never silently disarm the automatic restore path.
        await setConfig(record.snapshot);
        clearTimer();
        clearSnapshotFile();
        state = {
            active: false,
            startedAt: null,
            stopsAt: null,
            type: null,
            freq: null,
            level: null,
            targets: [],
            duration: null,
            lastStopReason: reason
        };
        return true;
    }

    async function stopInternal(reason = 'manual stop') {
        const record = readSnapshotFile();
        if (!record?.snapshot) {
            state.active = false;
            return false;
        }
        return restoreFromRecord(record, reason);
    }

    function scheduleRestore(durationSeconds) {
        clearTimer();
        const retryRestore = () => {
            restoreTimer = setTimeout(() => {
                queueTransition(() => stopInternal('automatic timeout')).catch(error => {
                    console.error('E-Stack signal generator automatic restore failed; retrying:', error.message);
                    retryRestore();
                });
            }, 1000);
        };
        restoreTimer = setTimeout(() => {
            queueTransition(() => stopInternal('automatic timeout')).catch(error => {
                console.error('E-Stack signal generator automatic restore failed; retrying:', error.message);
                retryRestore();
            });
        }, durationSeconds * 1000);
    }

    function queueTransition(operation) {
        const run = () => require('./workflowGate')(operation);
        const next = transition.then(run, run);
        transition = next.catch(() => {});
        return next;
    }

    async function startInternal(body) {
        if (fs.existsSync(measurementSessionPath)) {
            throw new Error('Measurement Batch is active. Abort or finish it before starting the Signal Generator.');
        }
        if (state.active || readSnapshotFile()?.snapshot) {
            await stopInternal('replaced by new test signal');
        }

        const request = normalizeRequest(body);
        const original = await getConfig();
        if (!original?.devices?.capture || !original?.devices?.playback) throw new Error('Current CamillaDSP device configuration is incomplete');
        if (original.devices.capture.type === 'SignalGenerator') {
            throw new Error('CamillaDSP is already using an unmanaged SignalGenerator. Restore the normal capture configuration first.');
        }

        const testConfig = clone(original);
        testConfig.devices.capture = {
            type: 'SignalGenerator',
            channels: inputChannelCount(original),
            signal: request.type === 'Sine'
                ? { type: 'Sine', freq: request.freq, level: request.level }
                : { type: 'WhiteNoise', level: request.level }
        };
        routeOnlyTargets(testConfig, request.targets);

        const startedAt = Date.now();
        const metadata = {
            type: request.type,
            freq: request.freq,
            level: request.level,
            targets: request.targets,
            duration: request.duration,
            startedAt,
            stopsAt: startedAt + request.duration * 1000
        };

        // Persist the exact normal configuration before touching CamillaDSP. If
        // E-Stack DSP is restarted while a tone is active, startup recovery can
        // restore the normal capture device and mixer routing.
        writeSnapshotFile(original, metadata);
        try {
            await setConfig(testConfig);
        } catch (error) {
            clearSnapshotFile();
            throw error;
        }

        state = { active: true, ...metadata };
        scheduleRestore(request.duration);
        return { ...state, safeLevelCap: request.cap };
    }

    function publicStatus() {
        const remainingMs = state.active && state.stopsAt ? Math.max(0, state.stopsAt - Date.now()) : 0;
        return { ...state, remainingMs, blockedByMeasurementBatch: fs.existsSync(measurementSessionPath) };
    }

    function readJson(req) {
        return new Promise((resolve, reject) => {
            let text = '';
            req.on('data', chunk => {
                text += chunk;
                if (text.length > 16 * 1024) reject(new Error('Request too large'));
            });
            req.on('end', () => {
                if (!text.trim()) return resolve({});
                try { resolve(JSON.parse(text)); }
                catch (_) { reject(new Error('Invalid JSON body')); }
            });
            req.on('error', reject);
        });
    }

    app.get('/api/test-signal/status', (_req, res) => {
        res.json(publicStatus());
    });

    app.post('/api/test-signal/start', async (req, res) => {
        try {
            const body = await readJson(req);
            const result = await queueTransition(() => startInternal(body));
            res.json({ ok: true, ...result });
        } catch (error) {
            console.error('E-Stack test signal start failed:', error.message);
            res.status(400).json({ ok: false, error: error.message });
        }
    });

    app.post('/api/test-signal/stop', async (req, res) => {
        try {
            // Drain an optional beacon body so keepalive/navigation stops do not
            // leave a half-read request on the connection.
            await readJson(req).catch(() => ({}));
            const restored = await queueTransition(() => stopInternal('manual stop'));
            res.json({ ok: true, restored, ...publicStatus() });
        } catch (error) {
            console.error('E-Stack test signal stop failed:', error.message);
            res.status(500).json({ ok: false, error: error.message });
        }
    });

    // Crash/restart recovery: if a snapshot exists and CamillaDSP is still on
    // SignalGenerator, restore the saved normal configuration. If the DSP is
    // already normal, discard the stale snapshot. Retry while CamillaDSP is
    // still starting so a Node restart cannot strand the generator.
    function recoverAfterRestart(attempt = 1) {
        queueTransition(async () => {
            const record = readSnapshotFile();
            if (!record?.snapshot) return true;
            try {
                const current = await getConfig();
                if (current?.devices?.capture?.type === 'SignalGenerator') {
                    await restoreFromRecord(record, 'E-Stack DSP restart recovery');
                    console.warn('E-Stack restored normal capture after a stale test signal.');
                } else {
                    clearSnapshotFile();
                }
                return true;
            } catch (error) {
                console.error(`E-Stack signal generator startup recovery attempt ${attempt} failed:`, error.message);
                return false;
            }
        }).then(done => {
            if (!done && attempt < 15) setTimeout(() => recoverAfterRestart(attempt + 1), 2000);
        }).catch(error => {
            console.error('E-Stack signal generator startup recovery failed:', error.message);
            if (attempt < 15) setTimeout(() => recoverAfterRestart(attempt + 1), 2000);
        });
    }
    setTimeout(() => recoverAfterRestart(), 1500);

    return { getStatus: publicStatus, stop: () => queueTransition(() => stopInternal('external stop')) };
};
