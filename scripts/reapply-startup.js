'use strict';

// Invoked by camilladsp.service ExecStartPost.
// Re-applies the E-Stack DSP Startup system preset after every CamillaDSP start
// or restart. The existing startupConfiguration.applyRecord() performs the safe
// processing-only swap: master attenuation first, live hardware devices/mixers
// preserved, then the preset master volume restored.

const fs = require('fs');
const path = require('path');
const express = require('express');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const STATE_FILE = path.join(ROOT, 'startupConfig.json');
const SAVED_CONFIGS_FILE = path.join(ROOT, 'savedConfigs.dat');
const SYSTEM_TYPE = 'estack-system';
const DSP_HOST = process.env.CAMILLADSP_PROXY_HOST || '127.0.0.1';
const DSP_PORT = Number.parseInt(process.env.CAMILLADSP_PORT || '1234', 10);
const MAX_ATTEMPTS = 15;
const RETRY_MS = 800;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function readJson(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        throw new Error(`${path.basename(file)}: ${error.message}`);
    }
}

function currentBootId() {
    try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); }
    catch (_) { return null; }
}

function resolveStartupRecord(state, configs) {
    if (!state || state.mode === 'yaml') return null;
    const systems = Array.isArray(configs) ? configs.filter(item => item?.type === SYSTEM_TYPE) : [];

    let id;
    let name;
    if (state.mode === 'specific') {
        id = state.configId;
        name = state.configName;
    } else if (state.mode === 'last') {
        id = state.lastUsedId;
        name = state.lastUsedName;
    } else {
        throw new Error(`Unsupported startup mode '${state.mode}'`);
    }

    let record = null;
    if (id !== undefined && id !== null && String(id).length) {
        record = systems.find(item => String(item.id) === String(id)) || null;
    }
    if (!record && name) record = systems.find(item => item.name === name) || null;
    if (!record) throw new Error(`Startup preset '${name || id || 'unknown'}' was not found`);
    if (!record?.data?.processing) throw new Error(`Startup preset '${record.name}' has no processing snapshot`);
    return record;
}

function writeAppliedState(previous, record, targetVolume) {
    const now = new Date().toISOString();
    const bootId = currentBootId();
    const next = {
        ...(previous || {}),
        activeOrigin: 'system',
        activeId: record.id,
        activeName: record.name,
        lastUsedId: record.id,
        lastUsedName: record.name,
        lastBootIdApplied: bootId || previous?.lastBootIdApplied || null,
        lastBootAppliedId: record.id,
        lastBootAppliedName: record.name,
        lastBootAppliedAt: now,
        lastBootStatus: `applied @ ${Number(targetVolume).toFixed(1)} dB`,
        lastDspStartAppliedAt: now,
        lastDspStartAppliedName: record.name,
        lastDspStartStatus: 'applied'
    };
    const temp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(temp, STATE_FILE);
}

function writeFailureState(previous, record, error) {
    try {
        const next = {
            ...(previous || {}),
            lastDspStartAppliedAt: new Date().toISOString(),
            lastDspStartAppliedName: record?.name || previous?.configName || previous?.lastUsedName || null,
            lastDspStartStatus: `error: ${error.message}`
        };
        const temp = `${STATE_FILE}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
        fs.renameSync(temp, STATE_FILE);
    } catch (_) {}
}

async function main() {
    const state = readJson(STATE_FILE, { mode: 'yaml' });
    if (state.mode === 'yaml') {
        console.log('E-Stack startup recall: Hardware YAML selected; no preset reapply.');
        return;
    }

    const configs = readJson(SAVED_CONFIGS_FILE, []);
    const record = resolveStartupRecord(state, configs);

    const startupConfiguration = require('../server/startupConfiguration')(express(), {
        WebSocket,
        host: DSP_HOST,
        port: DSP_PORT,
        root: ROOT,
        stateFile: STATE_FILE,
        savedConfigsFile: SAVED_CONFIGS_FILE,
        demo: false
    });

    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
            const targetVolume = await startupConfiguration.applyRecord(record);
            writeAppliedState(readJson(STATE_FILE, state), record, targetVolume);
            console.log(`E-Stack startup recall: ${record.name} restored after CamillaDSP start @ ${Number(targetVolume).toFixed(1)} dB master.`);
            return;
        } catch (error) {
            lastError = error;
            if (attempt < MAX_ATTEMPTS) await sleep(RETRY_MS);
        }
    }

    throw lastError || new Error('Unknown startup recall failure');
}

main().catch(error => {
    console.error(`E-Stack startup recall WARNING: ${error.message}`);
    try {
        const state = readJson(STATE_FILE, {});
        const configs = readJson(SAVED_CONFIGS_FILE, []);
        let record = null;
        try { record = resolveStartupRecord(state, configs); } catch (_) {}
        writeFailureState(state, record, error);
    } catch (_) {}

    // Never make CamillaDSP itself fail because an optional preset cannot be
    // restored. The DSP remains on its hardware YAML and the warning is logged.
    process.exitCode = 0;
});
