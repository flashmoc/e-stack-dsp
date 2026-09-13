'use strict';

// Deployment diagnostics only. The wire allowlists below are intentionally
// independent of application services: importing a service can trigger recovery.
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { createRequire } = require('module');
const ROOT = path.resolve(process.env.ESTACK_ROOT || path.join(__dirname, '..'));
const READ_COMMANDS = new Set(['GetState', 'GetConfigJson', 'GetVolume']);
const PAGES = ['control', 'input-processing', 'output-processing', 'loudness',
  'system-presets', 'advanced', 'signal-generator', 'measurement-batch', 'connections', 'preferences'];
const GET_PATHS = ['/api/runtime', '/api/system-presets', '/api/startup-config',
  '/api/loudness/preset', '/api/loudness/settings', '/api/loudness/bridge',
  '/api/test-signal/status', '/api/measurement-batch/status'];
const RUNTIME = ['camillaNodeConfig.json', 'currentConfig.json', 'savedConfigs.dat',
  'startupConfig.json', 'wiimLoudnessConfig.json', 'wiimLoudnessStatus.json', 'config',
  ...['preview', 'real', 'white'].flatMap(x => [`setupFiles/spectrum_${x}.yml`, `setupFiles/spectrum_${x}.yml.bak`])];
const run = (exe, args) => execFileSync(exe, args, { cwd: ROOT, encoding: 'utf8', timeout: 15000 }).trim();
const git = (...args) => run('git', args);
const read = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
};
function port() {
  const value = Number(process.env.ESTACK_CHECK_PORT || read(path.join(ROOT, 'camillaNodeConfig.json'), { port: 80 }).port || 80);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw Error('Invalid configured HTTP port');
  return value;
}
function nodeStatus(version) {
  const major = Number(version.replace(/^v/, '').split('.')[0]);
  if (!Number.isInteger(major) || major < 22 || major === 23 || major === 25) return 'FAIL';
  return major === 22 || major === 24 ? 'PASS' : 'WARN';
}
function startup(file) {
  const state = read(file, { mode: 'yaml' });
  if (!['yaml', 'specific', 'last'].includes(state?.mode)) throw Error('Invalid startup mode');
  if (state.mode !== 'yaml') {
    if (process.env.ESTACK_ALLOW_STARTUP_RECALL !== '1') {
      throw Error(`Startup mode ${state.mode}: restarting CamillaNode may recall processing. Use ESTACK_ALLOW_STARTUP_RECALL=1 only after explicit operator acceptance.`);
    }
    console.error(`WARN: explicit startup recall override; mode=${state.mode}. Restart may WRITE DSP processing and Master.`);
  } else console.error('PASS: Hardware YAML / absent startup state; no preset recall');
  return state;
}
function temporary(root = ROOT, snapshot = '/tmp/camillanode-estack-test-signal.json') {
  for (const file of [path.join(root, 'config/measurement-batch-session.json'),
    snapshot]) {
    // Fail even on an unreadable/malformed/stale file: recovery owns its removal.
    try { fs.lstatSync(file); throw Error(`Temporary workflow file present: ${file}`); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
function clean() {
  const changes = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const entry of changes) {
    const filename = entry.slice(3);
    if (!RUNTIME.some(p => filename === p || (p === 'config' && filename.startsWith('config/')))) {
      throw Error(`Local application change requires review: ${entry}`);
    }
  }
  for (const parent of ['config', 'setupFiles']) {
    try { if (fs.lstatSync(path.join(ROOT, parent)).isSymbolicLink()) throw Error(`Symlink parent: ${parent}`); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
function request(url, command) {
  if (!READ_COMMANDS.has(command)) return Promise.reject(Error('Non-read command rejected'));
  if (!/^ws:\/\/127\.0\.0\.1:\d+(\/ws\/(dsp|spectrum))?$/.test(url)) return Promise.reject(Error('Only loopback WS allowed'));
  // Backup toolkit carries ws independently: rollback must still be able to
  // inspect the DSP if the application npm installation failed halfway.
  let WebSocket;
  try { WebSocket = require('ws'); }
  catch (_) { WebSocket = createRequire(path.join(ROOT, 'package.json'))('ws'); }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => finish(Error(`${command} timeout`)), 4000);
    function finish(err, value) {
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on('error', () => {});
      ws.terminate();
      if (err) reject(err); else resolve(value);
    }
    ws.on('open', () => ws.send(JSON.stringify(command)));
    ws.on('error', e => finish(e));
    ws.on('close', () => finish(Error('WebSocket closed before response')));
    ws.on('message', raw => {
      try {
        const response = JSON.parse(raw)[command];
        if (!response) return;
        if (response.result !== 'Ok') throw Error(`${command}: ${JSON.stringify(response)}`);
        finish(null, command === 'GetConfigJson' && typeof response.value === 'string' ? JSON.parse(response.value) : response.value);
      } catch (e) { finish(e); }
    });
  });
}
function get(route) {
  const staticAllowed = route === '/estack-dsp/?transport=camillanode' || PAGES.some(p => route === `/estack-dsp/pages/${p}/page.html`);
  if (!GET_PATHS.includes(route) && !staticAllowed) return Promise.reject(Error('HTTP route not read-allowlisted'));
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: port(), path: route, timeout: 4000 }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; if (body.length > 8e6) req.destroy(Error('Oversize response')); });
      res.on('end', () => res.statusCode === 200 ? resolve(body) : reject(Error(`${route}: HTTP ${res.statusCode}`)));
    });
    req.on('timeout', () => req.destroy(Error(`${route}: timeout`)));
    req.on('error', reject);
  });
}
async function dsp(proxy = false) {
  const url = proxy ? `ws://127.0.0.1:${port()}/ws/dsp` : 'ws://127.0.0.1:1234';
  const config = await request(url, 'GetConfigJson');
  const volume = await request(url, 'GetVolume');
  const state = await request(url, 'GetState');
  if (!config?.devices || !Array.isArray(config.pipeline) || !Number.isFinite(volume)) throw Error('Invalid live DSP response');
  if (config.devices.capture?.type === 'SignalGenerator') throw Error('Live capture is SignalGenerator; recovery required');
  return { config, volume, state };
}
function topology(config) {
  const findings = [];
  const report = (level, message) => findings.push({ level, message });
  const filters = config.filters || {};
  const pipeline = config.pipeline || [];
  const mixers = pipeline.filter(s => s.type === 'Mixer');
  if (!mixers.length || mixers.some(s => !config.mixers?.[s.name])) report('FAIL', 'Missing referenced mixer');
  if (!(config.devices?.samplerate > 0) || config.devices?.playback?.channels < 6) report('FAIL', 'Sample rate / six playback channels missing');
  for (const [channel, way] of ['sub', 'kick', 'mid_l', 'mid_r', 'high_l', 'high_r'].entries()) {
    const stages = pipeline.filter(s => s.type === 'Filter' && (s.channels || [s.channel]).includes(channel) && !s.bypassed);
    for (const [suffix, type] of [['gain', 'Gain'], ['delay', 'Delay'], ['hard_limit', 'Limiter']]) {
      const name = `${way}_${suffix}`;
      const valid = filters[name]?.type === type && stages.some(s => s.names?.includes(name));
      report(valid ? 'PASS' : 'FAIL', `OUT ${channel + 1} ${name}: ${valid ? 'present in pipeline' : 'missing/wrong type/inactive'}`);
    }
    const protection = `${way}_protection`;
    const protectedWay = config.processors?.[protection]?.type === 'Compressor' && pipeline.some(s => s.type === 'Processor' && s.name === protection && !s.bypassed);
    report(protectedWay ? 'PASS' : 'FAIL', `${protection}: ${protectedWay ? 'present' : 'missing/inactive'}`);
    const names = stages.flatMap(s => s.names || []);
    for (const edge of channel < 4 ? ['Highpass', 'Lowpass'] : ['Highpass']) {
      const present = names.some(n => String(filters[n]?.parameters?.type).endsWith(edge));
      report(present ? 'PASS' : 'FAIL', `${way} ${edge}: ${present ? 'present' : 'missing'}`);
    }
  }
  for (const s of pipeline) {
    if (s.type === 'Filter') for (const name of s.names || []) if (!filters[name]) report('FAIL', `Unresolved filter ${name}`);
    if (s.type === 'Processor' && !config.processors?.[s.name]) report('FAIL', `Unresolved processor ${s.name}`);
  }
  for (const name of ['ESTACK_INPUT_PREAMP', 'ESTACK_INPUT_DELAY', ...Array.from({ length: 10 }, (_, i) => `GLOBAL_EQ_${String(i + 1).padStart(2, '0')}`)]) {
    report(filters[name] ? 'PASS' : 'WARN', `${name}: ${filters[name] ? 'defined' : 'absent; owning UI must validate/create only on explicit edit'}`);
  }
  report('WARN', 'Physical routing, limiter calibration and crossover acoustics require hardware acceptance; presence is not calibration');
  return findings;
}
function serviceSafety(options = {}) {
  const service = options.service || 'estack-dsp.service';
  const expectedRoot = path.resolve(options.root || ROOT);
  const legacy = options.legacy === true;
  const systemctl = options.runSystemctl || (args => run('systemctl', args));
  const props = systemctl(['show', service, '--no-pager']);
  const values = Object.fromEntries(props.split('\n').map(s => [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)]));
  if (values.LoadState !== 'loaded') throw Error(`${service} not loaded`);
  if (values.WorkingDirectory?.replace(/\/$/, '') !== expectedRoot) throw Error('Service WorkingDirectory differs from selected repository');
  for (const key of ['ExecCondition', 'ExecStartPre', 'ExecStartPost', 'ExecStop', 'ExecStopPost', 'OnFailure', 'OnSuccess', 'PropagatesStopTo', 'ConsistsOf', 'BoundBy', 'RequiredBy', 'TriggeredBy', 'Upholds', 'UpheldBy', 'EnvironmentFiles', 'RootDirectory', 'RootImage', 'BindPaths', 'BindReadOnlyPaths']) {
    if (values[key]) throw Error(`Service ${key} requires separate manual audit; RC refuses automatic restart`);
  }
  if (values.PrivateTmp && values.PrivateTmp !== 'no') throw Error('PrivateTmp hides temporary workflow files; manual audit required');
  if (values.RuntimeDirectory && values.RuntimeDirectoryPreserve !== 'yes') throw Error('Service restart would remove a runtime directory; manual audit required');
  const envPattern = /(?:CAMILLANODE_PORT|CAMILLADSP_PORT|CAMILLADSP_PROXY_HOST|CAMILLA_SPECTRUM_PORT|ESTACK_|NODE_OPTIONS)=/;
  if (envPattern.test(values.Environment || '') || /ESTACK_/.test(values.Environment || '')) throw Error('Service runtime environment overrides require separate audit');
  if (Number(values.MainPID) > 0) {
    const env = fs.readFileSync(`/proc/${values.MainPID}/environ`, 'utf8');
    if (envPattern.test(env) || /ESTACK_/.test(env)) throw Error('Running service environment overrides require separate audit');
  }
  const executable = /path=(.*?) ;/.exec(values.ExecStart || '')?.[1];
  const expectedEntry = path.join(expectedRoot, 'index.js');
  if (!executable || !values.ExecStart.includes(expectedEntry) || !/^node(?:js)?(?:\.exe)?$/i.test(path.basename(executable))) throw Error(`Nonstandard ${service} ExecStart requires manual audit`);
  const argv = /argv\[\]=(.*?)(?: ;|$)/.exec(values.ExecStart)?.[1]?.trim();
  if (argv !== `${executable} ${expectedEntry}`) throw Error('Additional service arguments require manual audit');
  for (const unit of new Set(`${values.Requires || ''} ${values.Wants || ''} ${values.Requisite || ''}`.split(/\s+/).filter(Boolean))) {
    if (systemctl(['is-active', '--', unit]) !== 'active') throw Error(`Inactive dependency ${unit}; restart could start another integration`);
  }
  const version = run(executable, ['--version']);
  if (nodeStatus(version) === 'FAIL') throw Error(`Service Node ${version} is unsupported`);
  if (fs.realpathSync(executable) !== fs.realpathSync(process.execPath)) throw Error('Shell Node and systemd Node differ; use service Node in PATH');
  if (systemctl(['is-active', '--', 'camilladsp.service']) !== 'active') throw Error('Main DSP service not active');
  // A running old bridge keeps old code in memory during checkout. Defer its
  // integration rather than stopping/restarting it as an implicit side effect.
  try { if (!options.allowWiim && systemctl(['is-active', '--', 'estack-wiim-loudness.service']) === 'active') throw Error('WiiM bridge active: separate maintenance acceptance required'); }
  catch (e) { if (!e.status) throw e; }
  console.error(`PASS: ${legacy ? 'legacy migration source' : 'E-Stack DSP'} restart boundary; service Node ${version}`);
}

function startupResolvable(root) {
  const state = read(path.join(root, 'startupConfig.json'), { mode: 'yaml' });
  if (state.mode === 'yaml') return { state, record: null };
  if (!['specific', 'last'].includes(state.mode)) throw Error(`Invalid startup mode ${state.mode}`);
  const records = read(path.join(root, 'savedConfigs.dat'), []);
  if (!Array.isArray(records)) throw Error('savedConfigs.dat is invalid');
  const id = state.mode === 'specific' ? state.configId : state.lastUsedId;
  const name = state.mode === 'specific' ? state.configName : state.lastUsedName;
  const record = records.find(item => item?.type === 'estack-system' &&
    ((id !== undefined && id !== null && String(item.id) === String(id)) || (name && item.name === name)));
  if (!record?.data?.processing) throw Error(`Startup ${state.mode} target is missing or invalid`);
  let bootId = null;
  try { bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch (_) { /* non-Linux test */ }
  if (!bootId || state.lastBootIdApplied !== bootId) throw Error('Startup preset is resolvable but not recorded as applied for this boot; migration would risk a DSP recall');
  return { state, record };
}
function inventory(base) {
  const result = {};
  function visit(relative) {
    const file = path.join(base, relative);
    let st;
    try { st = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (st.isSymbolicLink()) throw Error(`Runtime symlink: ${relative}`);
    if (st.isDirectory()) {
      result[relative] = { directory: true, mode: st.mode & 0o777 };
      for (const name of fs.readdirSync(file).sort()) visit(`${relative}/${name}`);
    } else {
      if (!st.isFile()) throw Error(`Unsupported runtime entry ${relative}`);
      result[relative] = { sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), mode: st.mode & 0o777 };
    }
  }
  RUNTIME.forEach(visit);
  return result;
}
function validateBackup(directory) {
  const manifest = read(path.join(directory, 'manifest.json'));
  if (!manifest || manifest.version !== 1 || !/^[0-9a-f]{40}$/.test(manifest.sha) || manifest.root !== ROOT || manifest.hostname !== os.hostname()) throw Error('Backup identity/host/root mismatch');
  if (JSON.stringify(inventory(path.join(directory, 'runtime'))) !== JSON.stringify(manifest.inventory)) throw Error('Backup runtime integrity mismatch');
  return manifest;
}
async function main(mode, directory) {
  if (mode === 'ws-path') {
    console.log(path.dirname(createRequire(path.join(ROOT, 'package.json')).resolve('ws/package.json')));
    return;
  }
  if (mode === 'clean') return clean();
  if (mode === 'health') {
    const runtime = JSON.parse(await get('/api/runtime'));
    if (!['demo', 'hardware'].includes(runtime.mode) || runtime.httpPort !== port()) throw Error('Unexpected runtime health response');
    return;
  }
  if (mode === 'rollback-target') { console.log(validateBackup(directory).sha); return; }
  if (mode === 'startup-backup') { validateBackup(directory); startup(path.join(directory, 'runtime/startupConfig.json')); return; }
  if (mode === 'unchanged') {
    const m = validateBackup(directory);
    if (JSON.stringify(inventory(ROOT)) !== JSON.stringify(m.inventory)) throw Error('Runtime changed during backup/deploy; node is stopped. Review and take a fresh backup before retrying.');
    return;
  }
  if (mode === 'service-safety') return serviceSafety();
  if (mode === 'migration-service-safety') {
    const legacyRoot = path.resolve(directory || process.env.ESTACK_LEGACY_ROOT || '/home/bastos/camillanode');
    return serviceSafety({ service: 'camillanode.service', root: legacyRoot, legacy: true, allowWiim: true });
  }
  if (mode === 'startup-resolvable') {
    console.log(JSON.stringify(startupResolvable(path.resolve(directory || ROOT)), null, 2));
    return;
  }
  if (mode === 'compare-runtime') {
    const source = path.resolve(directory || '');
    const target = path.resolve(process.argv[4] || '');
    if (JSON.stringify(inventory(source)) !== JSON.stringify(inventory(target))) throw Error('Staged runtime state differs from migration source');
    console.log('PASS: staged runtime bytes and modes match migration source');
    return;
  }
  if (mode === 'compare-dsp-evidence') {
    const evidence = read(path.join(path.resolve(directory || ''), 'dsp-evidence.json'));
    const live = await dsp();
    if (!evidence || JSON.stringify(live.config) !== JSON.stringify(evidence.config) || live.volume !== evidence.volume) {
      throw Error('Live DSP configuration or Master differs from the pre-migration evidence');
    }
    console.log('PASS: live DSP configuration and Master match pre-migration evidence');
    return;
  }
  if (mode === 'migration-preflight') {
    const legacyRoot = path.resolve(directory || '/home/bastos/camillanode');
    if (legacyRoot !== ROOT) throw Error('Migration inspection root mismatch');
    if (port() !== 8080) throw Error(`Standalone migration requires preserved HTTP port 8080, found ${port()}`);
    serviceSafety({ service: 'camillanode.service', root: legacyRoot, legacy: true, allowWiim: true });
    const resolved = startupResolvable(legacyRoot);
    console.log(`PASS: startup ${resolved.state.mode}${resolved.record ? ` -> ${resolved.record.name}` : ''} is resolved for this boot`);
    temporary(legacyRoot);
    const live = await dsp();
    const findings = topology(live.config);
    findings.forEach(x => console.log(`${x.level}: ${x.message}`));
    if (findings.some(x => x.level === 'FAIL')) throw Error('Missing required operator/protection topology');
    await request('ws://127.0.0.1:6413', 'GetState');
    for (const route of ['/api/test-signal/status', '/api/measurement-batch/status']) {
      const state = JSON.parse(await get(route));
      if (state.active || state.phase === 'active') throw Error(`Active temporary workflow: ${route}`);
    }
    console.log('PASS: standalone migration preflight is read-only and complete');
    return;
  }
  if (mode === 'migration-offline-safety') {
    const legacyRoot = path.resolve(directory || '/home/bastos/camillanode');
    if (legacyRoot !== ROOT) throw Error('Migration inspection root mismatch');
    startupResolvable(legacyRoot);
    temporary(legacyRoot);
    const live = await dsp();
    const findings = topology(live.config);
    if (findings.some(x => x.level === 'FAIL')) throw Error('Required topology changed during migration staging');
    await request('ws://127.0.0.1:6413', 'GetState');
    console.log('PASS: offline startup/workflow/DSP/spectrum state remains safe');
    return;
  }
  if (mode === 'offline-safety') { startup(path.join(ROOT, 'startupConfig.json')); temporary(); await dsp(); return; }
  if (mode === 'backup') {
    const live = await dsp();
    fs.writeFileSync(path.join(directory, 'dsp-evidence.json'), JSON.stringify(live, null, 2), { mode: 0o600 });
    let upstream = null;
    try { upstream = git('rev-parse', '--abbrev-ref', '@{upstream}'); } catch (_) { /* detached */ }
    const backedUp = inventory(path.join(directory, 'runtime'));
    if (JSON.stringify(backedUp) !== JSON.stringify(inventory(ROOT))) throw Error('Runtime changed during backup; incomplete backup must not be used');
    const manifest = { version: 1, root: ROOT, hostname: os.hostname(), timestamp: new Date().toISOString(),
      sha: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'), upstream,
      node: process.version, npm: run('npm', ['--version']), port: port(), inventory: backedUp };
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return;
  }
  if (mode === 'preflight') {
    const status = nodeStatus(process.version);
    console.log(`${status}: Node ${process.version}; RC supported minimum 22 LTS`);
    if (status === 'FAIL') throw Error('Unsupported/EOL Node runtime');
    for (const key of Object.keys(process.env)) if (/^(ESTACK_(SIGNAL|MEASUREMENT|WIIM)|CAMILLADSP_|CAMILLANODE_PORT|CAMILLA_SPECTRUM_PORT)/.test(key)) throw Error(`Custom runtime ${key} requires separate audit`);
    console.log(`HTTP ${port()}, main DSP 1234, spectrum 6413 (loopback only)`);
    serviceSafety();
    startup(path.join(ROOT, 'startupConfig.json'));
    temporary();
    const stat = fs.statfsSync(ROOT);
    if (Number(stat.bavail) * Number(stat.bsize) < 512 * 1024 * 1024) throw Error('Less than 512 MiB free on repository filesystem');
    const live = await dsp();
    console.log(JSON.stringify({ state: live.state, volume: live.volume, devices: live.config.devices, mixers: Object.keys(live.config.mixers || {}) }, null, 2));
    const findings = topology(live.config);
    findings.forEach(x => console.log(`${x.level}: ${x.message}`));
    if (findings.some(x => x.level === 'FAIL')) throw Error('Missing required operator/protection topology');
    try {
      console.log('PASS: spectrum proxy', await request(`ws://127.0.0.1:${port()}/ws/spectrum`, 'GetState'));
    } catch (e) { console.log(`WARN: spectrum unavailable: ${e.message}; analyzer acceptance pending`); }
    for (const route of ['/api/test-signal/status', '/api/measurement-batch/status']) {
      try { const s = JSON.parse(await get(route)); if (s.active || s.phase === 'active') throw Error(`ACTIVE ${route}`); }
      catch (e) { if (e.message.startsWith('ACTIVE')) throw e; console.log(`WARN: legacy status endpoint unavailable: ${route}`); }
    }
    console.log('PASS: deployment preflight; no processing changed');
    return;
  }
  if (mode === 'smoke') {
    for (const route of GET_PATHS) {
      const value = JSON.parse(await get(route));
      if (value.active && route.includes('/status')) throw Error(`Unexpected active workflow: ${route}`);
      if (value.ok === false || value.status === 'error') throw Error(`API reported failure: ${route}`);
      console.log(`PASS: GET ${route}`);
    }
    const shell = await get('/estack-dsp/?transport=camillanode');
    if (!/<title>E-Stack DSP<\/title>/.test(shell)) throw Error('Incorrect product shell title');
    for (const page of PAGES) {
      const body = await get(`/estack-dsp/pages/${page}/page.html`);
      if (!/<(?:html|section|div|main)\b/i.test(body)) throw Error(`Invalid page resource ${page}`);
      console.log(`PASS: page ${page}`);
    }
    const live = await dsp(true);
    console.log(`PASS: DSP proxy state=${live.state}, Master=${live.volume}`);
    console.log('PASS: spectrum proxy', await request(`ws://127.0.0.1:${port()}/ws/spectrum`, 'GetState'));
    return;
  }
  throw Error('Unknown inspection operation');
}
module.exports = { nodeStatus, startup, startupResolvable, temporary, topology, inventory, validateBackup, request, get, RUNTIME, READ_COMMANDS, serviceSafety, main };
if (require.main === module) main(process.argv[2], process.argv[3]).catch(e => { console.error(`FAIL: ${e.message}`); process.exitCode = 1; });
