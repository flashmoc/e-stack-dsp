'use strict';
// Isolated parsing/filesystem/Git fixtures only. No systemd or DSP hardware.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const inspect = require('./pi-inspect');
const ROOT = path.resolve(__dirname, '..');
const bashPath = value => path.relative(fs.realpathSync.native(ROOT), fs.realpathSync.native(value)).replaceAll('\\', '/');
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`PASS: ${name}`); }
async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'estack-deployment-test-'));
  const file = path.join(temp, 'startup.json');
  const runtimeHelper = path.join(temp, 'runtime-helper.sh');
  fs.writeFileSync(runtimeHelper, [
    '#!/bin/bash',
    'set -euo pipefail',
    'operation="$1"; common="$2"; shift 2',
    'source "$common"',
    'case "$operation" in',
    '  restore) runtime_restore "$1";;',
    '  stage) runtime_replace_from "$1" "$2"; runtime_copy_from "$1" "$3";;',
    '  *) exit 2;;',
    'esac',
    ''
  ].join('\n'));
  try {
    await test('Node policy rejects EOL versions, accepts oldest maintained LTS', () => {
      for (const version of ['v10.0.0', 'v18.20.0', 'v20.20.0', 'v23.0.0', 'v25.0.0']) assert.equal(inspect.nodeStatus(version), 'FAIL');
      assert.equal(inspect.nodeStatus('v22.22.0'), 'PASS');
      assert.equal(inspect.nodeStatus('v24.0.0'), 'PASS');
      assert.equal(inspect.nodeStatus('v26.0.0'), 'WARN');
    });
    await test('Startup missing/YAML passes, specific/last/invalid fail closed', () => {
      assert.equal(inspect.startup(file).mode, 'yaml');
      for (const mode of ['specific', 'last', 'bogus']) {
        fs.writeFileSync(file, JSON.stringify({ mode }));
        assert.throws(() => inspect.startup(file));
      }
      fs.writeFileSync(file, '{');
      assert.throws(() => inspect.startup(file));
      fs.writeFileSync(file, JSON.stringify({ mode: 'yaml' }));
      assert.equal(inspect.startup(file).mode, 'yaml');
    });
    await test('Standalone startup target must exist and be recorded for the current boot', () => {
      const root = path.join(temp, 'startup-resolvable');
      fs.mkdirSync(root);
      let bootId = '';
      try { bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch (_) {}
      fs.writeFileSync(path.join(root, 'savedConfigs.dat'), JSON.stringify([
        { id: 'home', name: 'HOME', type: 'estack-system', data: { processing: { pipeline: [] } } }
      ]));
      fs.writeFileSync(path.join(root, 'startupConfig.json'), JSON.stringify({ mode: 'specific', configId: 'home', lastBootIdApplied: bootId }));
      if (bootId) assert.equal(inspect.startupResolvable(root).record.name, 'HOME');
      fs.writeFileSync(path.join(root, 'startupConfig.json'), JSON.stringify({ mode: 'specific', configId: 'missing', lastBootIdApplied: bootId }));
      assert.throws(() => inspect.startupResolvable(root));
      fs.writeFileSync(path.join(root, 'startupConfig.json'), JSON.stringify({ mode: 'specific', configId: 'home', lastBootIdApplied: 'another-boot' }));
      assert.throws(() => inspect.startupResolvable(root));
    });
    await test('Any pending snapshot/session refuses preflight without deleting it', () => {
      const snapshot = path.join(temp, 'snapshot.json');
      inspect.temporary(temp, snapshot);
      fs.writeFileSync(snapshot, '{broken');
      assert.throws(() => inspect.temporary(temp, snapshot));
      assert.equal(fs.readFileSync(snapshot, 'utf8'), '{broken');
      fs.unlinkSync(snapshot);
      fs.mkdirSync(path.join(temp, 'config'));
      fs.writeFileSync(path.join(temp, 'config/measurement-batch-session.json'), '{}');
      assert.throws(() => inspect.temporary(temp, snapshot));
      fs.unlinkSync(path.join(temp, 'config/measurement-batch-session.json'));
    });
    await test('Read transport rejects mutations and non-loopback targets before connecting', async () => {
      await assert.rejects(inspect.request('ws://127.0.0.1:1234', 'SetVolume'));
      await assert.rejects(inspect.request('ws://example.invalid:1234', 'GetConfigJson'));
      await assert.rejects(inspect.get('/deleteConfig?name=test'));
      await assert.rejects(inspect.get('/api/test-signal/start'));
    });
    await test('Backup toolkit resolves its own ws even when application dependencies are missing', () => {
      const toolkit = path.join(temp, 'toolkit');
      fs.mkdirSync(path.join(toolkit, 'node_modules/ws'), { recursive: true });
      fs.copyFileSync(path.join(__dirname, 'pi-inspect.js'), path.join(toolkit, 'pi-inspect.js'));
      // This fixture never opens a socket; it proves resolution before connecting.
      fs.writeFileSync(path.join(toolkit, 'node_modules/ws/index.js'), 'module.exports = class { constructor() { throw Error("TOOLKIT_WS_RESOLVED"); } };');
      const result = spawnSync(process.execPath, ['-e', 'require(process.argv[1]).request("ws://127.0.0.1:1234","GetState").catch(e=>console.log(e.message))', path.join(toolkit, 'pi-inspect.js')], {
        env: { ...process.env, ESTACK_ROOT: temp }, encoding: 'utf8'
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /TOOLKIT_WS_RESOLVED/);
    });
    await test('Topology inspection fails absent operator/protection anchors', () => {
      assert(inspect.topology({ devices: {}, pipeline: [] }).some(x => x.level === 'FAIL'));
    });
    await test('Service gate refuses hooks, propagation, hidden state and custom runtime (systemctl fixture)', () => {
      const bin = path.join(temp, 'bin');
      fs.mkdirSync(bin);
      const unit = path.join(temp, 'unit.txt');
      const systemctlTrace = path.join(temp, 'systemctl-trace.txt');
      const bashUnit = path.relative(ROOT, unit).replaceAll('\\', '/');
      const bashTrace = path.relative(ROOT, systemctlTrace).replaceAll('\\', '/');
      const fixture = path.join(bin, 'systemctl-fixture.sh');
      fs.writeFileSync(fixture, [
        '#!/bin/bash',
        'case "$1:$2:$3" in',
        `show:estack-dsp.service:*) cat "${bashUnit}";;`,
        'is-active:--:estack-wiim-loudness.service) exit 3;;',
        `is-active:--:*) printf "%s:%s\\n" "$2" "$3" >> "${bashTrace}"; echo active;;`,
        '*) exit 1;;',
        'esac',
        ''
      ].join('\n'), { mode: 0o755 });
      const normal = `LoadState=loaded\nWorkingDirectory=${temp}\nMainPID=0\nExecStart={ path=${process.execPath} ; argv[]=${process.execPath} ${path.join(temp, 'index.js')} ; }\nWants=-.mount\n`;
      function check(extra) {
        fs.writeFileSync(unit, normal + extra);
        try {
          inspect.serviceSafety({
            root: temp,
            runSystemctl: args => execFileSync('bash', [bashPath(fixture), ...args], {
              cwd: ROOT,
              encoding: 'utf8'
            }).trim()
          });
          return true;
        } catch (_) { return false; }
      }
      const pass = check('');
      assert.equal(pass, true);
      assert(fs.readFileSync(systemctlTrace, 'utf8').split('\n').includes('--:-.mount'), 'dash-prefixed unit must follow --');
      for (const extra of ['ExecStartPost=/unsafe', 'ExecCondition=/unsafe', 'RequiredBy=other.service', 'PropagatesStopTo=camilladsp.service',
        'PrivateTmp=yes', 'EnvironmentFiles=/hidden', 'Environment=CAMILLADSP_PORT=9999', 'RootDirectory=/hidden', 'RuntimeDirectory=ephemeral']) {
        assert.equal(check(extra), false, extra);
      }
    });
    await test('Runtime inventory includes WiiM, permissions, nested files and rejects symlinks', () => {
      fs.writeFileSync(path.join(temp, 'wiimLoudnessConfig.json'), '{"secret":"local"}', { mode: 0o600 });
      fs.writeFileSync(path.join(temp, 'config/preset.json'), '{}');
      const first = inspect.inventory(temp);
      if (process.platform !== 'win32') assert.equal(first['wiimLoudnessConfig.json'].mode, 0o600);
      fs.writeFileSync(path.join(temp, 'config/preset.json'), '{"changed":true}');
      assert.notDeepEqual(inspect.inventory(temp), first);
      if (process.platform !== 'win32') {
        fs.symlinkSync(file, path.join(temp, 'savedConfigs.dat'));
        assert.throws(() => inspect.inventory(temp));
        fs.unlinkSync(path.join(temp, 'savedConfigs.dat'));
      }
    });
    await test('Rollback runtime restore removes newly-created state and restores nested bytes/modes', () => {
      const root = path.join(temp, 'restore-repo');
      const backup = path.join(temp, 'runtime-copy');
      fs.mkdirSync(root); fs.mkdirSync(backup);
      fs.writeFileSync(path.join(root, 'startupConfig.json'), '{"mode":"last"}');
      fs.writeFileSync(path.join(root, 'savedConfigs.dat'), 'new');
      fs.writeFileSync(path.join(backup, 'savedConfigs.dat'), 'previous-mixed-collection', { mode: 0o600 });
      const result = spawnSync('bash', [bashPath(runtimeHelper), 'restore', bashPath(path.join(__dirname, 'pi-common.sh')), bashPath(backup)], {
        cwd: ROOT, env: { ...process.env, ESTACK_ROOT: bashPath(root) }, encoding: 'utf8'
      });
      assert.equal(result.status, 0, result.stderr);
      assert(!fs.existsSync(path.join(root, 'startupConfig.json')));
      assert.equal(fs.readFileSync(path.join(root, 'savedConfigs.dat'), 'utf8'), 'previous-mixed-collection');
      if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(root, 'savedConfigs.dat')).mode & 0o777, 0o600);
    });
    await test('Updater code-only pin, persistent runtime restoration and failure rollback evidence', () => {
      const repo = path.join(temp, 'repo');
      const remote = path.join(temp, 'remote.git');
      fs.mkdirSync(repo);
      const command = (args, cwd = repo) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
      command(['init', '-b', 'stable']);
      command(['config', 'user.email', 'test@example.invalid']);
      command(['config', 'user.name', 'Deployment test']);
      fs.writeFileSync(path.join(repo, 'app.txt'), 'old');
      fs.writeFileSync(path.join(repo, 'wiimLoudnessConfig.json'), 'tracked-old');
      command(['add', '.']); command(['commit', '-m', 'old']);
      const old = command(['rev-parse', 'HEAD']);
      command(['clone', '--bare', repo, remote]);
      command(['remote', 'add', 'origin', remote]);
      command(['switch', '-c', 'release/raspi-rc1']);
      command(['rm', 'wiimLoudnessConfig.json']);
      fs.writeFileSync(path.join(repo, '.gitignore'), 'wiimLoudnessConfig.json\nconfig/\n');
      fs.writeFileSync(path.join(repo, 'app.txt'), 'new');
      command(['add', '.']); command(['commit', '-m', 'new']);
      const target = command(['rev-parse', 'HEAD']);
      command(['push', 'origin', 'release/raspi-rc1']);
      command(['switch', 'stable']);
      fs.writeFileSync(path.join(repo, 'wiimLoudnessConfig.json'), 'machine-local');
      fs.chmodSync(path.join(repo, 'wiimLoudnessConfig.json'), 0o600);
      const env = { ...process.env, ESTACK_ROOT: bashPath(repo), ESTACK_BRANCH: 'release/raspi-rc1', ESTACK_FETCHED_SHA: target, ESTACK_UPDATE_CODE_ONLY: '1' };
      const script = path.join(ROOT, 'scripts/pi-update.sh');
      const success = spawnSync('bash', [bashPath(script)], { cwd: ROOT, env, encoding: 'utf8' });
      assert.equal(success.status, 0, success.stdout + success.stderr);
      assert.equal(command(['rev-parse', 'HEAD']), target);
      assert.equal(fs.readFileSync(path.join(repo, 'wiimLoudnessConfig.json'), 'utf8'), 'machine-local');
      if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(repo, 'wiimLoudnessConfig.json')).mode & 0o777, 0o600);
      // Invalid pin must restore the runtime snapshot even after legacy reset.
      command(['checkout', '--detach', old]);
      fs.writeFileSync(path.join(repo, 'wiimLoudnessConfig.json'), 'machine-local-again');
      const failure = spawnSync('bash', [bashPath(script)], { cwd: ROOT, env: { ...env, ESTACK_FETCHED_SHA: '0'.repeat(40) }, encoding: 'utf8' });
      assert.notEqual(failure.status, 0);
      assert.equal(fs.readFileSync(path.join(repo, 'wiimLoudnessConfig.json'), 'utf8'), 'machine-local-again');
      assert.equal(command(['rev-parse', 'HEAD']), old);
    });
    await test('RC requires explicit branch; no implicit install/restart integrations', () => {
      const previousCanonicalRepository = ['flashmoc', 'camillaNode-EStack'].join('/');
      const source = fs.readFileSync(path.join(ROOT, 'scripts/pi-deploy-rc.sh'), 'utf8');
      assert(source.includes('ESTACK_BRANCH:-'));
      assert(source.includes('ESTACK_EXPECTED_SHA'));
      assert(source.includes('https://github.com/flashmoc/e-stack-dsp.git'));
      assert(!source.includes(previousCanonicalRepository));
      assert(!/install-(startup|wiim)|restart camilladsp|reboot/.test(source));
      const stable = fs.readFileSync(path.join(ROOT, 'scripts/pi-update.sh'), 'utf8');
      assert(stable.includes('ESTACK_BRANCH:-camilladsp-4.1-estack'));
      assert(stable.includes('https://github.com/flashmoc/e-stack-dsp.git'));
      assert(!stable.includes(previousCanonicalRepository));
    });
    await test('Normal Raspberry tooling has standalone root/service identity only', () => {
      const normalFiles = ['pi-common.sh', 'pi-preflight.sh', 'pi-backup.sh',
        'pi-deploy-rc.sh', 'pi-postdeploy-check.sh', 'pi-rollback.sh', 'pi-update.sh',
        'pi-install.sh', 'install-startup-recall.sh', 'install-wiim-loudness.sh'];
      const combined = normalFiles.map(name => fs.readFileSync(path.join(ROOT, 'scripts', name), 'utf8')).join('\n');
      assert(combined.includes('estack-dsp.service'));
      for (const name of normalFiles) {
        const source = fs.readFileSync(path.join(ROOT, 'scripts', name), 'utf8');
        assert(!source.includes('camillanode.service'), `${name} still depends on legacy service`);
      }
      const inspector = fs.readFileSync(path.join(ROOT, 'scripts/pi-inspect.js'), 'utf8');
      assert(inspector.includes("options.service || 'estack-dsp.service'"));
      assert(inspector.includes("mode === 'migration-service-safety'"));
      assert(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8').includes('"name": "e-stack-dsp"'));
    });
    await test('Standalone migration stages exact roots and has a dedicated retained-install rollback', () => {
      const migration = fs.readFileSync(path.join(ROOT, 'scripts/pi-migrate-standalone.sh'), 'utf8');
      const rollback = fs.readFileSync(path.join(ROOT, 'scripts/pi-migrate-standalone-rollback.sh'), 'utf8');
      for (const value of ['/home/bastos/camillanode', '/home/bastos/e-stack-dsp', 'feature/standalone-runtime',
        'estack-dsp.service', 'camilladsp2.service', 'estack-wiim-loudness.service', 'scripts/reapply-startup.js',
        'setupFiles/spectrum_real.yml']) assert(migration.includes(value), `migration missing ${value}`);
      assert(migration.includes('runtime_replace_from "$LEGACY_ROOT" "$STAGE"'));
      assert(migration.includes("branch --show-current)\" == main"));
      assert(migration.includes('compare-runtime'));
      assert(migration.includes('compare-dsp-evidence'));
      assert(migration.includes('WorkingDirectory=/home/bastos/e-stack-dsp'));
      assert(migration.includes('ExecStart=/usr/bin/node /home/bastos/e-stack-dsp/index.js'));
      assert(migration.includes('/home/bastos/e-stack-dsp/scripts/reapply-startup.js'));
      assert(migration.includes('/home/bastos/e-stack-dsp/wiimLoudnessConfig.json'));
      assert(migration.includes('zz-estack-standalone-root.conf'));
      assert(migration.includes('disable camillanode.service'));
      assert(rollback.includes('runtime_restore "$BACKUP/runtime"'));
      assert(rollback.includes('start camillanode.service'));
      assert(!migration.includes('restart camilladsp.service'));
      assert(!rollback.includes('restart camilladsp.service'));
      assert(!/(?:^|\n)\s*(?:sudo\s+)?reboot\b/m.test(migration));
      assert(!/(?:^|\n)\s*(?:sudo\s+)?reboot\b/m.test(rollback));
      assert(!/SetConfigJson|SetVolume/.test(migration + rollback));
    });
    await test('Standalone staging copies only the runtime allowlist and rollback restores it', () => {
      const legacy = path.join(temp, 'legacy-stage');
      const staged = path.join(temp, 'new-stage');
      const backup = path.join(temp, 'standalone-backup');
      fs.mkdirSync(path.join(legacy, 'config'), { recursive: true });
      fs.mkdirSync(staged); fs.mkdirSync(backup);
      fs.writeFileSync(path.join(legacy, 'savedConfigs.dat'), '[{"type":"estack-system"}]', { mode: 0o600 });
      fs.writeFileSync(path.join(legacy, 'config/session.json'), '{"safe":true}', { mode: 0o600 });
      fs.writeFileSync(path.join(legacy, 'application-code.js'), 'must-not-copy');
      const common = path.join(ROOT, 'scripts/pi-common.sh');
      fs.writeFileSync(path.join(staged, 'application-code.js'), 'must-remain');
      fs.mkdirSync(path.join(staged, 'config')); fs.writeFileSync(path.join(staged, 'config/.gitkeep'), 'tracked-placeholder');
      let result = spawnSync('bash', [bashPath(runtimeHelper), 'stage', bashPath(common), bashPath(legacy), bashPath(staged), bashPath(backup)],
        { cwd: ROOT, env: { ...process.env, ESTACK_ROOT: bashPath(legacy) }, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.readFileSync(path.join(staged, 'config/session.json'), 'utf8'), '{"safe":true}');
      assert.equal(fs.readFileSync(path.join(staged, 'application-code.js'), 'utf8'), 'must-remain');
      assert(!fs.existsSync(path.join(staged, 'config/.gitkeep')));
      fs.writeFileSync(path.join(legacy, 'savedConfigs.dat'), 'changed-after-cutover');
      result = spawnSync('bash', [bashPath(runtimeHelper), 'restore', bashPath(common), bashPath(backup)],
        { cwd: ROOT, env: { ...process.env, ESTACK_ROOT: bashPath(legacy) }, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.readFileSync(path.join(legacy, 'savedConfigs.dat'), 'utf8'), '[{"type":"estack-system"}]');
    });
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  console.log(`Deployment selftests: ${passed} passed, 0 failed (fixtures only; no Raspberry/systemd deployment)`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
