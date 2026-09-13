'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
let failures = 0;

function fail(message) {
    failures += 1;
    console.error(`FAIL: ${message}`);
}

function ok(message) {
    console.log(`OK:   ${message}`);
}

function exists(relative) {
    return fs.existsSync(path.join(ROOT, relative));
}

function checkRequired(relative) {
    if (!exists(relative)) fail(`missing ${relative}`);
}

const required = [
    'index.js',
    'server/signalGenerator.js',
    'server/measurementBatch.js',
    'server/measurementBatchModel.js',
    'server/startupConfiguration.js',
    'server/wiimLoudnessApi.js',
    'server/loudnessPresetModel.js',
    'scripts/wiim-loudness-service.js',
    'scripts/install-wiim-loudness.sh',
    'scripts/reapply-startup.js',
    'scripts/install-startup-recall.sh',
    'scripts/pi-migrate-standalone.sh',
    'scripts/pi-migrate-standalone-rollback.sh',
    'docs/standalone-runtime.md',
    'scripts/measurement-batch-selftest.js',
    'wiimLoudnessConfig.example.json',
    'examples/measurement-batch-kick-mid.example.json',
    'docs/measurement-batch.md',
    'docs/ui-architecture.md',
    'public/html/main.html',
    'public/html/basic.html',
    'public/html/loudness.html',
    'public/html/global-eq.html',
    'public/html/equalizer.html',
    'public/html/signal-generator.html',
    'public/html/measurement-batch.html',
    'public/html/advanced.html',
    'public/html/preferences.html',
    'public/html/connections.html',
    'public/src/estackConfigManagerFix.js',
    'public/src/estackPeqModel.js',
    'public/src/estackOutputPeq.js',
    'public/src/estackOutputWorkspace.js',
    'public/src/estackPhaseGraph.js',
    'public/src/estackQInputFix.js',
    'public/src/estackMeasurementBatch.js',
    'public/css/estackDesignSystem.css',
    'public/css/estackTheme.css',
    'public/css/estackOutputProcessing.css',
    'public/css/estackInputProcessingPage.css',
    'public/css/estackSignalGenerator.css',
    'public/css/estackMeasurementBatch.css'
];
required.forEach(checkRequired);

const forbiddenTracked = [
    'public/html/per-way.html',
    'public/src/estackPerWay.js',
    'public/css/estackPerWay.css',
    'public/src/estackPeqIsolationFix.js',
    'public/src/estackDynamicPeq.js',
    'public/src/estackOutputPresetGuard.js',

    // Retired Output Processing presentation stack. A new numbered visual layer
    // is an architecture regression; edit the owning workspace/page file instead.
    'public/src/estackOutputWorkspaceV2.js',
    'public/src/estackOutputWorkspaceV3.js',
    'public/src/estackOutputWorkspaceV4.js',
    'public/src/estackOutputWorkspaceV5.js',
    'public/src/estackOutputPhase.js',
    'public/src/estackEqEightV2.js',
    'public/css/estackOutputWorkspace.css',
    'public/css/estackOutputWorkspaceV2.css',
    'public/css/estackOutputWorkspaceV3.css',
    'public/css/estackOutputWorkspaceV4.css',
    'public/css/estackOutputWorkspaceV5.css',
    'public/css/estackOutputWorkspaceV6.css',
    'public/css/estackPhaseGraph.css',
    'public/css/estackProcessingUnified.css',
    'public/css/estackProcessingPolish.css',
    'public/css/estackProcessingEnergy.css',
    'public/css/estackGlobalEqGraphHeight.css',
    'public/css/estackInputProcessing.css',
    'public/css/estackEqKnobGeometry.css',
    'public/css/estackEqResponsive.css',
    'public/css/estackEqV4.css',

    'views',
    'install.sh',
    '_dev.log'
];

function trackedFiles() {
    try {
        return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
            .split(/\r?\n/)
            .filter(Boolean);
    } catch (error) {
        fail(`git ls-files failed: ${error.message}`);
        return [];
    }
}

const tracked = trackedFiles();
for (const file of tracked.filter(file => file.endsWith('.sh'))) {
    const contents = fs.readFileSync(path.join(ROOT, file));
    if (contents.includes(0x0d)) {
        fail(`shell script has CRLF/CR line endings: ${file} (tracked .sh files must use LF)`);
    }
}

for (const forbidden of forbiddenTracked) {
    if (tracked.some(file => file === forbidden || file.startsWith(`${forbidden}/`))) {
        fail(`legacy path is still tracked: ${forbidden}`);
    }
}

for (const runtime of [
    'camillaNodeConfig.json', 'currentConfig.json', 'savedConfigs.dat', 'startupConfig.json',
    'wiimLoudnessConfig.json', 'wiimLoudnessStatus.json',
    'measurement-batch.json', 'measurement-batch-session.json'
]) {
    if (tracked.includes(runtime)) fail(`runtime file must not be tracked: ${runtime}`);
}
for (const file of tracked.filter(file => file.startsWith('config/') && file !== 'config/.gitkeep')) {
    fail(`runtime config must not be tracked: ${file}`);
}

const activeHtml = [
    'main.html', 'basic.html', 'loudness.html', 'global-eq.html', 'equalizer.html',
    'signal-generator.html', 'measurement-batch.html', 'advanced.html', 'preferences.html', 'connections.html'
];
const assetPattern = /(?:src|href)=["'](\/(?:src|css|img)\/[^"'#?]+)["']/g;
for (const file of activeHtml) {
    const full = path.join(PUBLIC, 'html', file);
    if (!fs.existsSync(full)) continue;
    const html = fs.readFileSync(full, 'utf8');
    for (const match of html.matchAll(assetPattern)) {
        const asset = path.join(PUBLIC, match[1].replace(/^\//, ''));
        if (!fs.existsSync(asset)) fail(`${file} references missing asset ${match[1]}`);
    }
}

/* --------------------------------------------------------------------------
   Unified UI architecture
   -------------------------------------------------------------------------- */
const themeSource = fs.readFileSync(path.join(PUBLIC, 'css', 'estackTheme.css'), 'utf8');
if (!themeSource.includes("@import url('/css/estackDesignSystem.css')")) {
    fail('estackTheme.css is no longer the design-system compatibility entrypoint');
}

const outputHtml = fs.readFileSync(path.join(PUBLIC, 'html', 'equalizer.html'), 'utf8');
if (!outputHtml.includes('/css/estackOutputProcessing.css')) fail('Output Processing is missing its single page stylesheet');
if (!outputHtml.includes('/src/estackOutputWorkspace.js')) fail('Output Processing is missing its unified workspace module');
for (const legacy of [
    'estackOutputWorkspaceV2', 'estackOutputWorkspaceV3', 'estackOutputWorkspaceV4',
    'estackOutputWorkspaceV5', 'estackOutputWorkspaceV6', 'estackProcessingPolish',
    'estackProcessingEnergy', 'estackPhaseGraph.css', 'estackEqV4.css'
]) {
    if (outputHtml.includes(legacy)) fail(`Output Processing still loads legacy presentation layer ${legacy}`);
}

const inputHtml = fs.readFileSync(path.join(PUBLIC, 'html', 'global-eq.html'), 'utf8');
if (!inputHtml.includes('/css/estackInputProcessingPage.css')) fail('Input Processing is missing its single page stylesheet');
for (const legacy of [
    'estackProcessingUnified.css', 'estackProcessingPolish.css', 'estackProcessingEnergy.css',
    'estackGlobalEqGraphHeight.css', 'estackInputProcessing.css', 'estackEqV4.css',
    'estackEqKnobGeometry.css', 'estackEqResponsive.css'
]) {
    if (inputHtml.includes(legacy)) fail(`Input Processing still loads legacy presentation layer ${legacy}`);
}

for (const htmlName of ['basic.html', 'loudness.html', 'global-eq.html', 'equalizer.html', 'signal-generator.html', 'measurement-batch.html', 'advanced.html', 'preferences.html', 'connections.html']) {
    const html = fs.readFileSync(path.join(PUBLIC, 'html', htmlName), 'utf8');
    if (!html.includes('/css/estackTheme.css')) fail(`${htmlName} is not connected to the shared E-Stack design system`);
}

const workspaceSource = fs.readFileSync(path.join(PUBLIC, 'src', 'estackOutputWorkspace.js'), 'utf8');
if (!workspaceSource.includes('wsOutput(), wsPeq(), wsCrossover()')) {
    fail('Output Processing workflow order is not Output / PEQ / Crossover');
}
if (!workspaceSource.includes('estackEq8MakeKnob')) {
    fail('Output Processing does not reuse the shared E-Stack rotary control');
}
if (!workspaceSource.includes('allowedFilterPrefixes: [PHASE_PREFIX]')) {
    fail('Unified Output Processing phase edit is missing guarded upload');
}

const mainHtml = fs.readFileSync(path.join(PUBLIC, 'html', 'main.html'), 'utf8');
if (!mainHtml.includes('target="/signal-generator"')) fail('main navigation is missing /signal-generator');
if (!mainHtml.includes('target="/measurement-batch"')) fail('main navigation is missing /measurement-batch');
if (mainHtml.includes('target="/per-way"')) fail('main navigation still exposes legacy /per-way');
if (!mainHtml.includes('System Configurations')) fail('main navigation is missing system configuration manager label');
if (!mainHtml.includes('id="presetInd"')) fail('header is missing active preset indicator');
if (mainHtml.includes('estackOutputPresetGuard.js')) fail('obsolete page-scoped output preset layer is still loaded');

const serverSource = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
if (!serverSource.includes("app.get('/signal-generator'")) fail('server is missing /signal-generator route');
if (!serverSource.includes("app.get('/measurement-batch'")) fail('server is missing /measurement-batch route');
if (!serverSource.includes("app.get('/per-way'")) fail('legacy /per-way redirect is missing');
if (!serverSource.includes("require('./server/signalGenerator')")) fail('signal generator backend is not isolated under server/');
if (!serverSource.includes("require('./server/measurementBatch')")) fail('Measurement Batch backend is not registered');
if (!serverSource.includes("require('./server/startupConfiguration')")) fail('startup configuration backend is not registered');
if (!serverSource.includes("require('./server/wiimLoudnessApi')")) fail('WiiM loudness backend is not registered');

const loudnessSource = fs.readFileSync(path.join(PUBLIC, 'src', 'estackLoudness.js'), 'utf8');
if (!loudnessSource.includes('ESTACK_LOUDNESS_FADER = "Aux1"')) fail('Loudness UI is not Aux1-linked');
if (!loudnessSource.includes('/api/loudness/bridge')) fail('Loudness UI is missing bridge status monitoring');
if (!loudnessSource.includes('/api/loudness/settings')) fail('Loudness UI is missing curve settings API');

const measurementSource = fs.readFileSync(path.join(ROOT, 'server', 'measurementBatch.js'), 'utf8');
for (const route of ['status', 'import', 'next', 'previous', 'retry', 'goto', 'abort']) {
    if (!measurementSource.includes(`/api/measurement-batch/${route}`)) fail(`Measurement Batch backend is missing ${route} endpoint`);
}
if (!measurementSource.includes('SAFE_VOLUME_DB = -60')) fail('Measurement Batch is missing safe transition attenuation');
if (!measurementSource.includes('baselineConfig')) fail('Measurement Batch is missing captured baseline restoration');
if (!measurementSource.includes('mergeProcessingIntoLive')) fail('Measurement Batch does not preserve live hardware/mixer ownership');

const measurementModelSource = fs.readFileSync(path.join(ROOT, 'server', 'measurementBatchModel.js'), 'utf8');
if (!measurementModelSource.includes("gainOffsetDb, -60, 0")) fail('Measurement Batch gain deltas can exceed the captured baseline');
if (!measurementModelSource.includes('pre-routing/input processing')) fail('Measurement Batch input-filter bypass guard is missing');
if (!measurementModelSource.includes('Conflicting crossover overrides')) fail('Measurement Batch shared-crossover conflict guard is missing');

const signalSource = fs.readFileSync(path.join(ROOT, 'server', 'signalGenerator.js'), 'utf8');
if (!signalSource.includes('measurement-batch-session.json')) fail('Signal Generator is not interlocked with Measurement Batch');

const measurementClient = fs.readFileSync(path.join(PUBLIC, 'src', 'estackMeasurementBatch.js'), 'utf8');
if (!measurementClient.includes('/api/measurement-batch/next')) fail('Measurement Batch UI is missing NEXT API integration');
if (!measurementClient.includes('/api/measurement-batch/abort')) fail('Measurement Batch UI is missing restore/abort integration');

const configManagerSource = fs.readFileSync(path.join(PUBLIC, 'src', 'estackConfigManagerFix.js'), 'utf8');
if (!configManagerSource.includes('/api/startup-config')) fail('system configuration UI is missing startup configuration API');
if (!configManagerSource.includes('/api/startup-config/active')) fail('system configuration UI is missing active preset tracking');

const startupRecallSource = fs.readFileSync(path.join(ROOT, 'scripts', 'reapply-startup.js'), 'utf8');
if (!startupRecallSource.includes('startupConfiguration.applyRecord(record)')) fail('CamillaDSP restart recall does not reuse guarded startup processing apply');
if (!startupRecallSource.includes('lastBootIdApplied')) fail('CamillaDSP restart recall does not synchronize boot recall state');
const startupInstallerSource = fs.readFileSync(path.join(ROOT, 'scripts', 'install-startup-recall.sh'), 'utf8');
if (!startupInstallerSource.includes('ExecStartPost=')) fail('startup recall installer is missing CamillaDSP ExecStartPost');
if (!startupInstallerSource.includes('After=camilladsp.service')) fail('startup recall installer is missing E-Stack DSP boot ordering');
if (!startupInstallerSource.includes('estack-dsp.service.d')) fail('startup recall installer is not standalone');
const standaloneInstaller = fs.readFileSync(path.join(ROOT, 'scripts', 'pi-install.sh'), 'utf8');
if (!standaloneInstaller.includes('/etc/systemd/system/estack-dsp.service')) fail('standalone service installer is missing');
if (standaloneInstaller.includes('/etc/systemd/system/camillanode.service')) fail('installer still owns legacy CamillaNode service');

for (const htmlName of ['equalizer.html', 'global-eq.html', 'advanced.html']) {
    const html = fs.readFileSync(path.join(PUBLIC, 'html', htmlName), 'utf8');
    if (!html.includes('/src/estackQInputFix.js')) fail(`${htmlName} is missing keyboard Q input fix`);
}
const qInputSource = fs.readFileSync(path.join(PUBLIC, 'src', 'estackQInputFix.js'), 'utf8');
if (!qInputSource.includes("window.estackEq8QControl = function")) fail('Output Processing Q readout is not replaced by an editable control');
if (!qInputSource.includes("estackCommitPeqValue(slot, 'q'")) fail('Output Processing Q input is missing safe PEQ commit');

for (const file of [
    'index.js',
    'server/signalGenerator.js',
    'server/measurementBatch.js',
    'server/measurementBatchModel.js',
    'server/startupConfiguration.js',
    'server/wiimLoudnessApi.js',
    'server/loudnessPresetModel.js',
    'scripts/wiim-loudness-service.js',
    'scripts/reapply-startup.js',
    'scripts/repo-check.js',
    'scripts/measurement-batch-selftest.js',
    'scripts/output-phase-reference-selftest.js',
    'public/src/estackConfigManagerFix.js',
    'public/src/estackLoudness.js',
    'public/src/estackMeasurementBatch.js',
    'public/src/estackQInputFix.js',
    'public/src/estackOutputWorkspace.js',
    'public/src/estackPhaseGraph.js',
    'public/src/estackOutputPeq.js'
]) {
    try {
        execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' });
    } catch (error) {
        fail(`syntax check failed for ${file}: ${String(error.stderr || error.message).trim()}`);
    }
}

for (const file of ['scripts/install-wiim-loudness.sh', 'scripts/install-startup-recall.sh']) {
    try {
        execFileSync('bash', ['-n', file], { cwd: ROOT, stdio: 'pipe' });
    } catch (error) {
        fail(`shell syntax check failed for ${file}: ${String(error.stderr || error.message).trim()}`);
    }
}

if (failures) {
    console.error(`\nE-Stack repository check failed: ${failures} issue(s).`);
    process.exit(1);
}

ok('active UI assets resolve');
ok('unified UI architecture is enforced');
ok('legacy duplicate paths are not tracked');
ok('runtime state is repository-independent');
ok('startup configuration integration is present');
ok('CamillaDSP restart startup recall integration is present');
ok('keyboard Q entry integration is present');
ok('WiiM loudness bridge integration is present');
ok('Measurement Batch integration and interlocks are present');
ok('tracked shell scripts use LF line endings');
ok('JavaScript and installer syntax parse');
console.log('\nE-Stack repository check passed.');
