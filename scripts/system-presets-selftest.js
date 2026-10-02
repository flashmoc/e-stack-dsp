"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const express = require("express");
const store = require("../server/presetStore");
const gate = require("../server/workflowGate");
const chunkSizePolicy = require("../server/chunkSizePolicy");
const clone = (value) => JSON.parse(JSON.stringify(value));
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "estack-system-test-"));
  const saved = path.join(root, "savedConfigs.dat");
  const stateFile = path.join(root, "startupConfig.json");
  const signal = path.join(root, "signal.json"),
    batch = path.join(root, "batch.json");
  let config = {
    devices: {
      samplerate: 48000,
      chunksize: 1024,
      capture: { type: "Alsa", device: "hardware-in", channels: 2 },
      playback: { type: "Alsa", device: "hardware-out", channels: 2 },
    },
    mixers: { main: { channels: { in: 2, out: 2 }, mapping: [] } },
    filters: { gain: { type: "Gain", parameters: { gain: -3 } } },
    processors: {},
    pipeline: [
      { type: "Mixer", name: "main" },
      { type: "Filter", channels: [0, 1], names: ["gain"] },
    ],
  };
  let volume = -18,
    corrupt = false,
    driftOnSecondRead = false,
    exportReads = 0;
  const commands = [];
  class Socket extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => this.emit("open"));
    }
    close() {}
    terminate() {}
    send(text) {
      const payload = JSON.parse(text),
        name = typeof payload === "string" ? payload : Object.keys(payload)[0];
      commands.push(clone(payload));
      let value;
      if (name === "GetConfigJson") {
        if (driftOnSecondRead && ++exportReads === 2) config.filters.gain.parameters.gain = -4;
        value = JSON.stringify(config);
      }
      if (name === "GetState") value = "Running";
      if (name === "GetVolume") value = volume;
      if (name === "SetVolume") volume = payload.SetVolume;
      if (name === "SetConfigJson") {
        config = JSON.parse(payload.SetConfigJson);
        if (corrupt) config.filters.gain.parameters.gain = -99;
      }
      queueMicrotask(() =>
        this.emit(
          "message",
          JSON.stringify({ [name]: { result: "Ok", value } }),
        ),
      );
    }
  }
  const unrelated = [
    { id: "eq", type: "global-eq", name: "EQ", data: { bands: [] } },
    { id: "other", type: "foreign", data: { keep: true } },
  ];
  store.atomicWrite(saved, unrelated);
  const app = express();
  const system = require("../server/startupConfiguration")(app, {
    root,
    stateFile,
    savedConfigsFile: saved,
    signalSnapshotPath: signal,
    measurementSessionPath: batch,
    WebSocket: Socket,
    demo: true,
  });
  require('../server/advanced')(app, system);
  require('../server/inputProcessing')(app, system);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  async function api(url, data) {
    const response = await fetch(
      base + url,
      data === undefined
        ? {}
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(data),
          },
    );
    return { ok: response.ok, body: await response.json() };
  }
  try {
    const original = clone(config);
    commands.length = 0;
    const liveExport = await api('/api/system-presets/export?scope=live');
    assert(liveExport.ok);
    assert.equal(liveExport.body.schema, 'estack.system-export');
    assert.equal(liveExport.body.scope, 'live');
    assert.deepEqual(liveExport.body.config, original);
    assert.equal(liveExport.body.configRevision, require('../server/advancedModel').revision(original));
    assert.equal(liveExport.body.masterVolume, -18);
    assert(!commands.some(command => typeof command === 'object'), 'export must not write DSP state');
    driftOnSecondRead = true; exportReads = 0;
    assert.equal((await api('/api/system-presets/export?scope=live')).ok, false,
      'concurrent DSP edits must invalidate the exported baseline');
    driftOnSecondRead = false; config = clone(original);
    config.devices.capture.type = 'SignalGenerator';
    assert.equal((await api('/api/system-presets/export?scope=live')).ok, false);
    config.devices.capture.type = original.devices.capture.type;
    assert.equal((await api('/api/system-presets/export?scope=preset&id=missing')).ok, false);
    assert.equal((await api('/api/system-presets/export?scope=unknown')).ok, false);
    const advanced = await api('/api/advanced');
    const advancedChange = { revision: advanced.body.revision, operation: { kind: 'filter', name: 'gain', value: { type: 'Gain', parameters: { gain: -4 } } } };
    commands.length = 0;
    assert((await api('/api/advanced/edit', advancedChange)).ok);
    assert.equal(config.filters.gain.parameters.gain, -4);
    assert.deepEqual(config.devices, original.devices);
    assert.deepEqual(config.mixers, original.mixers);
    assert.equal(volume, -18);
    assert.deepEqual(commands.filter(c => typeof c === 'object').map(c => Object.keys(c)[0]), ['SetVolume', 'SetConfigJson', 'SetVolume']);
    const calls = commands.length;
    assert.equal((await api('/api/advanced/edit', advancedChange)).ok, false, 'stale edits must fail');
    assert(!commands.slice(calls).some(c => typeof c === 'object'), 'stale edits must not write');
    for (const file of [signal, batch]) {
      store.atomicWrite(file, {});
      assert.equal((await api('/api/advanced/edit', { ...advancedChange, revision: (await api('/api/advanced')).body.revision })).ok, false);
      fs.unlinkSync(file);
    }
    const currentRevision = (await api('/api/advanced')).body.revision;
    corrupt = true;
    assert.equal((await api('/api/advanced/edit', { ...advancedChange, revision: currentRevision })).ok, false);
    assert.equal(volume, -60, 'failed Advanced readback must hold safe Master');
    corrupt = false; config = clone(original); volume = -18;
    assert.equal(chunkSizePolicy.describe(48000, 1024).recommended, 1024);
    assert.equal(chunkSizePolicy.describe(96000, 2048).recommended, 2048);
    assert.equal(chunkSizePolicy.describe(192000, 4096).recommended, 4096);
    assert.equal(chunkSizePolicy.describe(48000, 1024).currentChunkMs, 21.3);
    assert(!chunkSizePolicy.describe(48000, 2048, 8000).options.some(option => option.size < 2048),
      'presets must retain the configured target playback buffer');
    const chunkBefore = await api('/api/chunk-size');
    assert(chunkBefore.ok);
    assert.equal(chunkBefore.body.persistence, 'live-only');
    assert.equal(chunkBefore.body.current, 1024);
    const chunkChange = { revision: chunkBefore.body.revision, chunksize: 512, acknowledgeAudioInterruption: true };
    commands.length = 0;
    assert.equal((await api('/api/chunk-size', { ...chunkChange, acknowledgeAudioInterruption: false })).ok, false);
    assert.equal((await api('/api/chunk-size', { ...chunkChange, chunksize: 513 })).ok, false);
    assert(!commands.some(c => typeof c === 'object'), 'invalid chunk requests must not write');
    for (const file of [signal, batch]) {
      store.atomicWrite(file, {});
      assert.equal((await api('/api/chunk-size', chunkChange)).ok, false);
      fs.unlinkSync(file);
    }
    config.devices.capture.type = 'SignalGenerator';
    assert.equal((await api('/api/chunk-size', chunkChange)).ok, false);
    config.devices.capture.type = original.devices.capture.type;
    assert(!commands.some(c => typeof c === 'object'), 'temporary workflows must block chunk writes');
    assert((await api('/api/chunk-size', chunkChange)).ok);
    assert.equal(config.devices.chunksize, 512);
    assert.deepEqual({ ...config.devices, chunksize: 1024 }, original.devices);
    assert.deepEqual(config.mixers, original.mixers);
    assert.deepEqual(config.filters, original.filters);
    assert.equal(volume, -18);
    assert.deepEqual(commands.filter(c => typeof c === 'object').map(c => Object.keys(c)[0]), ['SetVolume', 'SetConfigJson', 'SetVolume']);
    const chunkWrites = commands.length;
    assert.equal((await api('/api/chunk-size', chunkChange)).ok, false, 'stale chunk revision must fail');
    assert(!commands.slice(chunkWrites).some(c => typeof c === 'object'));
    corrupt = true;
    assert.equal((await api('/api/chunk-size', { ...chunkChange, revision: (await api('/api/chunk-size')).body.revision, chunksize: 1024 })).ok, false);
    assert.equal(volume, -60, 'failed chunk readback must hold safe Master');
    corrupt = false; config = clone(original); volume = -18;
    const capture = await api("/api/system-presets/capture", {
      name: "Reference",
    });
    assert(capture.ok);
    const id = capture.body.id;
    const record = store.read(saved).find((r) => r.id === id);
    const savedExport = await api(`/api/system-presets/export?scope=preset&id=${encodeURIComponent(id)}`);
    assert(savedExport.ok);
    assert.equal(savedExport.body.scope, 'saved-preset');
    assert.equal(savedExport.body.id, id);
    assert.deepEqual(savedExport.body.processing, record.data.processing);
    assert.equal(savedExport.body.masterVolume, record.data.masterVolume);
    assert.equal(savedExport.body.config, undefined, 'saved export must not claim live hardware state');
    for (const file of [signal, batch]) {
      store.atomicWrite(file, {});
      assert.equal((await api('/api/system-presets/export?scope=live')).ok, false);
      assert((await api(`/api/system-presets/export?scope=preset&id=${encodeURIComponent(id)}`)).ok);
      fs.unlinkSync(file);
    }
    assert.equal(record.data.version, 1);
    assert.equal(record.data.masterVolume, -18);
    assert.equal(record.data.processing.devices, undefined);
    assert.equal(record.data.processing.mixers, undefined);
    assert.deepEqual(store.read(saved).slice(0, 2), unrelated);
    assert.equal(
      (await api("/api/system-presets/capture", { name: "Reference" })).ok,
      false,
    );
    assert(
      (
        await api("/api/system-presets/capture", {
          name: "Reference",
          overwrite: true,
        })
      ).ok,
    );
    assert.equal(store.read(saved).find((r) => r.name === "Reference").id, id);
    config.filters.gain.parameters.gain = -7;
    commands.length = 0;
    assert((await api("/api/system-presets/apply", { id })).ok);
    assert.deepEqual(config.devices, original.devices);
    assert.deepEqual(config.mixers, original.mixers);
    assert.deepEqual(config.filters, record.data.processing.filters);
    assert.equal(volume, -18);
    const writes = commands.filter((x) => typeof x === "object");
    assert.deepEqual(writes[0], { SetVolume: -60 });
    assert("SetConfigJson" in writes[1]);
    assert.deepEqual(writes[2], { SetVolume: -18 });
    assert.equal((await api("/api/startup-config")).body.dirty, false);
    config.filters.gain.parameters.gain = -5;
    assert.equal((await api("/api/startup-config")).body.dirty, true);
    for (const mode of ["specific", "last", "yaml"]) {
      const before = clone(config);
      assert((await api("/api/startup-config", { mode, configId: id })).ok);
      assert.deepEqual(config, before);
      assert.equal((await api("/api/startup-config")).body.mode, mode);
    }
    assert.equal((await api("/api/system-presets/delete", { id })).ok, false);
    const renameState = JSON.parse(fs.readFileSync(stateFile));
    Object.assign(renameState, { configId: id, configName: 'Reference', lastBootAppliedId: id, lastBootAppliedName: 'Reference' });
    store.atomicWrite(stateFile, renameState);
    const beforeRename = clone(config), callsBeforeRename = commands.length;
    assert((await api('/api/system-presets/rename', { id, name: 'Renamed reference' })).ok);
    const renamedState = JSON.parse(fs.readFileSync(stateFile));
    for (const key of ['activeName', 'configName', 'lastUsedName', 'lastBootAppliedName']) assert.equal(renamedState[key], 'Renamed reference');
    assert.deepEqual(store.read(saved).slice(0, 2), unrelated);
    assert.deepEqual(store.read(saved).find(r => r.id === id).data, record.data);
    assert.deepEqual(config, beforeRename);
    assert.equal(commands.length, callsBeforeRename, 'Rename must not contact DSP');
    assert((await api('/api/system-presets/rename', { id, name: 'Reference' })).ok);
    for (const file of [signal, batch]) {
      store.atomicWrite(file, {});
      assert.equal((await api("/api/system-presets/apply", { id })).ok, false);
      assert.equal(
        (await api("/api/system-presets/capture", { name: "Blocked" })).ok,
        false,
      );
      fs.unlinkSync(file);
    }
    // Lock acquired before a temporary workflow creates its snapshot must
    // still block a queued system application once that workflow starts.
    let release;
    const pending = gate(async () => {
      await new Promise((r) => {
        release = r;
      });
      store.atomicWrite(signal, {});
    });
    await new Promise((r) => setImmediate(r));
    const attempt = api("/api/system-presets/apply", { id });
    release();
    await pending;
    assert.equal((await attempt).ok, false);
    fs.unlinkSync(signal);
    const spare = await api("/api/system-presets/capture", { name: "Spare" });
    assert(spare.ok);
    assert((await api("/api/system-presets/delete", { id: spare.body.id })).ok);
    const broken = await api("/api/system-presets/capture", { name: "Broken" });
    const metadata = fs.readFileSync(stateFile, "utf8");
    corrupt = true;
    assert.equal(
      (await api("/api/system-presets/apply", { id: broken.body.id })).ok,
      false,
    );
    assert.equal(volume, -60);
    assert.equal(fs.readFileSync(stateFile, "utf8"), metadata);
    corrupt = false;
    store.update(saved, (records) => {
      const r = records.find((r) => r.id === broken.body.id);
      r.data.processing.pipeline.push({ type: "Processor", name: "missing" });
    });
    assert.equal(
      (await api("/api/system-presets/apply", { id: broken.body.id })).ok,
      false,
    );
    assert(
      (
        await api("/api/startup-config", {
          mode: "specific",
          configId: broken.body.id,
        })
      ).ok,
    );
    assert.match(
      (await api("/api/startup-config")).body.resolutionError,
      /missing processor/,
    );
    store.update(saved, (records) =>
      records.splice(
        records.findIndex((r) => r.id === broken.body.id),
        1,
      ),
    );
    assert.match(
      (await api("/api/startup-config")).body.resolutionError,
      /no longer exists/,
    );
    assert.deepEqual(store.read(saved).slice(0, 2), unrelated);
    const legacy = store.read(saved).find((r) => r.id === id);
    delete legacy.data.masterVolume;
    store.update(saved, (records) => {
      records[records.findIndex((r) => r.id === id)] = legacy;
    });
    assert((await api("/api/system-presets/apply", { id })).ok);
    assert.equal(volume, -40);
    fs.chmodSync(saved, 0o640);
    store.update(saved, () => {});
    assert.equal(fs.statSync(saved).mode & 0o777, 0o640);
    const bytes = fs.readFileSync(saved);
    assert.throws(() =>
      store.update(saved, () => {
        throw Error("interrupted");
      }),
    );
    assert.deepEqual(fs.readFileSync(saved), bytes);
    // The six named ways do not determine the physical playback or mixer size.
    const hardwareEight = clone(original);
    hardwareEight.devices.capture.channels = 8;
    hardwareEight.devices.playback.channels = 8;
    hardwareEight.mixers.main.channels = { in: 8, out: 8 };
    hardwareEight.mixers.main.mapping = [0, 1, 2, 3, 4, 5].map(dest => ({ dest, sources: [{ channel: dest % 2, gain: 0 }] }));
    hardwareEight.pipeline[1].channels = [0, 1, 2, 3, 4, 5];
    for (const destinations of [[0, 1, 2, 3, 4, 5], [0, 1, 2, 3, 4, 5, 6, 7]]) {
      config = clone(hardwareEight);
      config.mixers.main.mapping = destinations.map(dest => ({ dest, sources: [{ channel: dest % 2, gain: 0 }] }));
      const hardware = clone({ devices: config.devices, mixers: config.mixers });
      const captured = await api('/api/system-presets/capture', { name: `Eight channel ${destinations.length}` });
      assert(captured.ok, captured.body.error);
      const eightRecord = store.read(saved).find(item => item.id === captured.body.id);
      eightRecord.data.processing.devices = { playback: { channels: 6, device: 'wrong' } };
      eightRecord.data.processing.mixers = { main: { channels: { in: 6, out: 6 }, mapping: [] } };
      store.update(saved, records => {
        const stored = records.find(item => item.id === eightRecord.id);
        stored.data.processing.devices = clone(eightRecord.data.processing.devices);
        stored.data.processing.mixers = clone(eightRecord.data.processing.mixers);
      });
      config.filters.gain.parameters.gain = -9;
      commands.length = 0;
      assert((await api('/api/system-presets/apply', { id: eightRecord.id })).ok);
      assert.deepEqual({ devices: config.devices, mixers: config.mixers }, hardware, 'preset apply changed live hardware');
      for (const write of commands.filter(item => typeof item === 'object' && item.SetConfigJson)) {
        const uploaded = JSON.parse(write.SetConfigJson);
        assert.deepEqual({ devices: uploaded.devices, mixers: uploaded.mixers }, hardware, 'preset upload changed hardware');
      }
      config = clone(hardwareEight); // Simulate CamillaDSP restarting from its hardware YAML.
      config.mixers = clone(hardware.mixers);
      config.filters.gain.parameters.gain = -20;
      await system.applyRecord(eightRecord);
      assert.equal(config.filters.gain.parameters.gain, -3, 'startup recall did not restore processing');
      assert.deepEqual({ devices: config.devices, mixers: config.mixers }, hardware, 'startup recall changed hardware');
    }
    const previousEight = clone(config);
    // Dual input EQ state travels with the processing snapshot, including bypassed targets.
    const inputState = require('../public/prototypes/estack-ui/shared/domain/input-eq-state');
    const fit = require('../public/prototypes/estack-ui/shared/domain/graphic-eq-fit');
    config = clone(hardwareEight);
    config.filters.GLOBAL_EQ_01 = {type:'Biquad',parameters:{type:'Peaking',freq:125,gain:-3,q:1}};
    const eq = inputState.read(config);
    eq.geq = {enabled:false,fitVersion:1,targets:fit.ACOUSTIC};
    eq.peq = {enabled:true,disabled:[]};
    inputState.rebuild(config,eq,{fitGeq:true});
    const inputBefore = clone(config), inputNext = clone(config);
    const nextState = inputState.read(inputNext); nextState.geq.enabled=true;
    inputState.rebuild(inputNext,nextState);
    const proposed = () => api('/api/input-processing',{scope:'geq',before:inputBefore,next:inputNext});
    const protectedProposal = clone(inputNext); protectedProposal.devices.playback.channels=6;
    commands.length=0;
    assert(!(await api('/api/input-processing',{scope:'geq',before:inputBefore,next:protectedProposal})).ok);
    assert(!commands.some(c=>typeof c==='object'),'invalid scope must not write DSP');
    store.atomicWrite(signal,{}); assert(!(await proposed()).ok); fs.unlinkSync(signal);
    assert((await proposed()).ok);
    assert(!(await proposed()).ok,'stale revision must be rejected');
    config=clone(inputBefore);
    corrupt=true;assert(!(await proposed()).ok);corrupt=false;
    assert.equal(volume,-60,'failed readback must retain safe Master');
    assert.deepEqual(inputState.read(config),nextState,'semantic state and submitted DSP filters travel atomically');
    config=clone(inputBefore);
    const dual = await api('/api/system-presets/capture',{name:'Dual EQ restart'});
    assert(dual.ok,dual.body.error);
    const dualRecord = store.read(saved).find(r=>r.id===dual.body.id);
    const dualHardware = clone({devices:config.devices,mixers:config.mixers});
    config = clone(hardwareEight); // Simulate fresh DSP hardware configuration at restart.
    await system.applyRecord(dualRecord);
    assert.deepEqual(inputState.validate(config),eq);
    assert.deepEqual({devices:config.devices,mixers:config.mixers},dualHardware);
    assert.equal(config.filters.GLOBAL_EQ_01.parameters.gain,-3);
    assert(!config.pipeline.some(s=>s.description===inputState.GEQ_STEP));
    config = clone(hardwareEight);
    config.devices.samplerate = 96000;
    await system.applyRecord(dualRecord);
    assert.equal(config.devices.samplerate,96000);
    assert.deepEqual(inputState.validate(config),eq,'startup must regenerate the fit for the live sample rate');
    config = clone(hardwareEight);
    const validEight = clone(previousEight);
    const missingMixer = clone(validEight);
    missingMixer.pipeline = missingMixer.pipeline.filter(step => step.type !== 'Mixer');
    const noMixerRecord = clone(store.read(saved).find(item => item.name === 'Eight channel 8'));
    noMixerRecord.data.processing.pipeline = missingMixer.pipeline;
    commands.length = 0;
    await assert.rejects(() => system.applyRecord(noMixerRecord), /requires a live hardware mixer/);
    assert(!commands.some(item => typeof item === 'object'), 'missing mixer caused a DSP write');
    for (const [label, edit, error] of [
      ['mixer output size', next => { next.mixers.main.channels.out = 6; }, /destination must be within 0\.\.5/],
      ['duplicate destination', next => { next.mixers.main.mapping[1].dest = 0; }, /duplicate destination 0/],
      ['out-of-range destination', next => { next.mixers.main.mapping[1].dest = 8; }, /destination must be within 0\.\.7/],
      ['missing logical way', next => { next.mixers.main.mapping = next.mixers.main.mapping.filter(item => item.dest !== 5); }, /must map all six E-Stack logical ways/],
      ['invalid source', next => { next.mixers.main.mapping[0].sources[0].channel = 8; }, /invalid source channel/]
    ]) {
      config = clone(validEight); edit(config);
      commands.length = 0;
      const rejected = await api('/api/system-presets/apply', { id: store.read(saved).find(item => item.name === 'Eight channel 8').id });
      assert.equal(rejected.ok, false, label);
      assert.match(rejected.body.reason, error, label);
      assert(!commands.some(item => typeof item === 'object'), `${label}: invalid topology caused a DSP write`);
    }
    console.log(
      "OK: System presets capture, mixed persistence, guarded apply/readback, Master, dirty state, startup, references, failure and cross-workflow ordering",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
