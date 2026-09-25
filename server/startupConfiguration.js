"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");
const store = require("./presetStore");
const gate = require("./workflowGate");
const { randomUUID } = require("crypto");

const SYSTEM_TYPE = "estack-system";
const SAFE_BOOT_VOLUME_DB = -60;
const LEGACY_FALLBACK_VOLUME_DB = -40;
const DEFAULT_STATE = {
  version: 3,
  mode: "yaml",
  configId: null,
  configName: null,
  lastUsedId: null,
  lastUsedName: null,
  activeOrigin: "yaml",
  activeId: null,
  activeName: "Hardware YAML",
  presetVolumes: {},
  lastBootIdApplied: null,
  lastBootAppliedId: null,
  lastBootAppliedName: null,
  lastBootAppliedAt: null,
  lastBootStatus: "never",
};

module.exports = function registerStartupConfiguration(app, options = {}) {
  const WebSocket = options.WebSocket;
  const host = options.host || "127.0.0.1";
  const port = Number(options.port || 1234);
  const root = options.root || path.resolve(__dirname, "..");
  const stateFile = options.stateFile || path.join(root, "startupConfig.json");
  const savedConfigsFile =
    options.savedConfigsFile || path.join(root, "savedConfigs.dat");
  const demo = options.demo === true;
  const jsonParser = express.json({ limit: "64kb" });
  const signalSnapshot =
    options.signalSnapshotPath ||
    process.env.ESTACK_SIGNAL_SNAPSHOT ||
    "/tmp/camillanode-estack-test-signal.json";
  const measurementSession =
    options.measurementSessionPath ||
    path.join(root, "config", "measurement-batch-session.json");

  function assertNormalWorkflow() {
    if (fs.existsSync(signalSnapshot))
      throw new Error(
        "Stop and restore Signal Generator before saving or applying a system preset",
      );
    if (fs.existsSync(measurementSession))
      throw new Error(
        "Complete or abort Measurement Batch before saving or applying a system preset",
      );
  }

  if (!WebSocket)
    throw new Error("startupConfiguration requires a WebSocket implementation");

  const clone = (value) =>
    value == null ? value : JSON.parse(JSON.stringify(value));

  function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") {
      const result = {};
      for (const key of Object.keys(value).sort())
        result[key] = stable(value[key]);
      return result;
    }
    return value;
  }

  function processingOf(config) {
    return {
      filters: clone(config?.filters || {}),
      pipeline: clone(config?.pipeline || []),
      processors: clone(config?.processors || {}),
    };
  }

  function sameProcessing(a, b) {
    return (
      JSON.stringify(stable(processingOf(a))) ===
      JSON.stringify(stable(processingOf(b)))
    );
  }

  function readState() {
    if (!fs.existsSync(stateFile))
      return { ...DEFAULT_STATE, presetVolumes: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      return {
        ...DEFAULT_STATE,
        ...parsed,
        presetVolumes:
          parsed?.presetVolumes && typeof parsed.presetVolumes === "object"
            ? parsed.presetVolumes
            : {},
      };
    } catch (error) {
      console.error(
        "Invalid startupConfig.json; using hardware YAML startup:",
        error.message,
      );
      return { ...DEFAULT_STATE, presetVolumes: {} };
    }
  }

  function writeState(next) {
    const state = {
      ...DEFAULT_STATE,
      ...next,
      version: 3,
      presetVolumes:
        next?.presetVolumes && typeof next.presetVolumes === "object"
          ? next.presetVolumes
          : {},
    };
    store.atomicWrite(stateFile, state);
    return state;
  }

  function readSavedConfigs() {
    return store.read(savedConfigsFile);
  }

  function findSystemConfig(id, name) {
    const configs = readSavedConfigs().filter(
      (item) => item?.type === SYSTEM_TYPE,
    );
    let found = null;
    if (id !== undefined && id !== null && String(id).length) {
      found = configs.find((item) => String(item.id) === String(id)) || null;
    }
    if (!found && name)
      found = configs.find((item) => item.name === name) || null;
    return found;
  }

  function resolveConfiguredRecord(state) {
    if (state.mode === "yaml") return null;
    if (state.mode === "specific") {
      const record = findSystemConfig(state.configId, state.configName);
      if (!record)
        throw new Error(
          `Startup configuration '${state.configName || state.configId || "unknown"}' no longer exists`,
        );
      return record;
    }
    if (state.mode === "last") {
      const record = findSystemConfig(state.lastUsedId, state.lastUsedName);
      if (!record)
        throw new Error("No valid last-used system configuration is available");
      return record;
    }
    throw new Error(`Unsupported startup mode '${state.mode}'`);
  }

  function currentBootId() {
    try {
      return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } catch (_) {
      return null;
    }
  }

  function openDsp(timeoutMs = 2500) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${host}:${port}`);
      const timer = setTimeout(() => {
        try {
          ws.terminate?.();
        } catch (_) {}
        reject(new Error("CamillaDSP connection timeout"));
      }, timeoutMs);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve(ws);
      });
      ws.once("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`CamillaDSP unavailable: ${error.message}`));
      });
    });
  }

  function dspRequest(ws, message, timeoutMs = 3500) {
    const command =
      typeof message === "string" ? message : Object.keys(message || {})[0];
    if (!command)
      return Promise.reject(new Error("Invalid CamillaDSP command"));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.off("message", onMessage);
        reject(new Error(`${command} timed out`));
      }, timeoutMs);

      function onMessage(data) {
        let response;
        try {
          response = JSON.parse(String(data));
        } catch (_) {
          return;
        }
        if (!Object.prototype.hasOwnProperty.call(response, command)) return;

        clearTimeout(timer);
        ws.off("message", onMessage);
        const payload = response[command] || {};
        if (payload.result !== "Ok") {
          reject(
            new Error(
              `${command} failed: ${payload.value || payload.result || "unknown error"}`,
            ),
          );
          return;
        }

        let value = payload.value;
        if (command === "GetConfigJson") {
          try {
            value = JSON.parse(value);
          } catch (_) {
            reject(new Error("CamillaDSP returned invalid configuration JSON"));
            return;
          }
        }
        resolve(value);
      }

      ws.on("message", onMessage);
      try {
        ws.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        reject(error);
      }
    });
  }

  function validateProcessingSnapshot(processing, liveMixers, devices) {
    if (!processing || typeof processing !== "object")
      throw new Error("Saved processing snapshot is missing");
    if (!processing.filters || typeof processing.filters !== "object")
      throw new Error("Saved filters are missing");
    if (!Array.isArray(processing.pipeline))
      throw new Error("Saved pipeline is missing");

    const filters = processing.filters;
    const processors = processing.processors || {};
    const mixerNames = new Set(Object.keys(liveMixers || {}));
    let channels = devices?.capture?.channels;
    for (const step of processing.pipeline) {
      if (!["Mixer", "Filter", "Processor"].includes(step?.type))
        throw new Error("Unsupported saved pipeline step");
      if (step.type === "Mixer" && liveMixers[step.name]) {
        const mixer = liveMixers[step.name];
        if (
          channels != null &&
          mixer.channels?.in != null &&
          mixer.channels.in !== channels
        )
          throw new Error("Mixer channel count does not match live hardware");
        channels = mixer.channels?.out ?? channels;
      }
      if (step?.type === "Mixer" && !mixerNames.has(step.name)) {
        throw new Error(
          `Saved configuration expects unavailable mixer '${step.name}'`,
        );
      }
      if (step?.type === "Filter") {
        const selected =
          step.channels ?? (step.channel == null ? [] : [step.channel]);
        if (
          !Array.isArray(selected) ||
          selected.some(
            (channel) =>
              !Number.isInteger(channel) ||
              channel < 0 ||
              (channels != null && channel >= channels),
          )
        )
          throw new Error("Filter channel is outside live topology");
        for (const name of step.names || []) {
          if (!filters[name])
            throw new Error(
              `Saved pipeline references missing filter '${name}'`,
            );
        }
      }
      if (step?.type === "Processor") {
        for (const name of step.name ? [step.name] : step.names || []) {
          if (!processors[name])
            throw new Error(
              `Saved pipeline references missing processor '${name}'`,
            );
        }
      }
    }
  }

  function storedVolumeFor(record, state) {
    const byId = state?.presetVolumes?.[String(record?.id)];
    const embedded = record?.data?.masterVolume;
    const candidate =
      typeof embedded === "number"
        ? embedded
        : typeof byId === "number"
          ? byId
          : LEGACY_FALLBACK_VOLUME_DB;
    if (!Number.isFinite(candidate) || candidate < -100 || candidate > 0)
      throw new Error("Saved Master must be between -100 and 0 dB");
    return candidate;
  }

  async function applyRecord(record) {
    assertNormalWorkflow();
    if (!record?.data?.processing)
      throw new Error(
        "Selected startup item is not a full E-Stack system configuration",
      );
    const state = readState();
    const targetVolume = storedVolumeFor(record, state);
    const ws = await openDsp();
    try {
      const live = await dspRequest(ws, "GetConfigJson");
      // Attenuate before swapping the processing graph. This does not make
      // the very first milliseconds of CamillaDSP boot intrinsically safe,
      // but it prevents the preset recall itself from happening at 0 dB.
      await dspRequest(ws, { SetVolume: SAFE_BOOT_VOLUME_DB });

      validateProcessingSnapshot(
        record.data.processing,
        live?.mixers,
        live?.devices,
      );
      const next = clone(live || {});
      next.filters = clone(record.data.processing.filters || {});
      next.pipeline = clone(record.data.processing.pipeline || []);
      next.processors = clone(record.data.processing.processors || {});
      next.title =
        record.name || record.data.processing.title || next.title || "";

      // Preserve devices/chunksize/ALSA settings and live mixer routing.
      await dspRequest(ws, { SetConfigJson: JSON.stringify(next) });
      const readback = await dspRequest(ws, "GetConfigJson");
      if (JSON.stringify(stable(readback)) !== JSON.stringify(stable(next))) {
        throw new Error(
          "System preset readback mismatch; Master remains safely attenuated",
        );
      }
      await dspRequest(ws, { SetVolume: targetVolume });
      const volume = Number(await dspRequest(ws, "GetVolume"));
      if (!Number.isFinite(volume) || Math.abs(volume - targetVolume) > 0.05)
        throw new Error("Master readback mismatch");
    } catch (error) {
      await dspRequest(ws, { SetVolume: SAFE_BOOT_VOLUME_DB }).catch(() => {});
      throw error;
    } finally {
      try {
        ws.close();
      } catch (_) {}
    }
    return targetVolume;
  }

  async function readLiveVolume() {
    let ws;
    try {
      ws = await openDsp(1400);
      const value = Number(await dspRequest(ws, "GetVolume", 1800));
      return Number.isFinite(value) ? value : null;
    } catch (_) {
      return null;
    } finally {
      try {
        ws?.close();
      } catch (_) {}
    }
  }

  async function livePresetState(state) {
    if (state.activeOrigin !== "system") {
      return {
        activeName: state.activeName || "Hardware YAML",
        activeId: null,
        activeOrigin: "yaml",
        dirty: false,
        activeMissing: false,
        masterVolume: await readLiveVolume(),
        presetMasterVolume: null,
      };
    }

    const record = findSystemConfig(state.activeId, state.activeName);
    if (!record?.data?.processing) {
      return {
        activeName: state.activeName || "Unknown preset",
        activeId: state.activeId,
        activeOrigin: "system",
        dirty: true,
        activeMissing: true,
        masterVolume: await readLiveVolume(),
        presetMasterVolume: null,
      };
    }

    let ws;
    try {
      ws = await openDsp(1400);
      const [live, rawVolume] = await Promise.all([
        dspRequest(ws, "GetConfigJson", 1800),
        dspRequest(ws, "GetVolume", 1800),
      ]);
      const liveVolume = Number(rawVolume);
      const presetVolume = storedVolumeFor(record, state);
      const volumeDirty =
        Number.isFinite(liveVolume) &&
        Math.abs(liveVolume - presetVolume) > 0.05;
      return {
        activeName: record.name,
        activeId: record.id,
        activeOrigin: "system",
        dirty: !sameProcessing(live, record.data.processing) || volumeDirty,
        activeMissing: false,
        masterVolume: Number.isFinite(liveVolume) ? liveVolume : null,
        presetMasterVolume: presetVolume,
      };
    } catch (_) {
      return {
        activeName: record.name,
        activeId: record.id,
        activeOrigin: "system",
        dirty: null,
        activeMissing: false,
        masterVolume: null,
        presetMasterVolume: storedVolumeFor(record, state),
      };
    } finally {
      try {
        ws?.close();
      } catch (_) {}
    }
  }

  async function publicState() {
    const state = readState();
    let resolvedName = null;
    let resolutionError = null;
    try {
      const resolved = resolveConfiguredRecord(state);
      resolvedName = resolved?.name || null;
      if (resolved) {
        const ws = await openDsp(1400);
        try {
          const live = await dspRequest(ws, "GetConfigJson");
          validateProcessingSnapshot(
            resolved.data?.processing,
            live.mixers,
            live.devices,
          );
          storedVolumeFor(resolved, state);
        } finally {
          ws.close();
        }
      }
    } catch (error) {
      resolutionError = error.message;
    }
    const live = await livePresetState(state);
    return {
      mode: state.mode,
      configId: state.configId,
      configName: state.configName,
      lastUsedId: state.lastUsedId,
      lastUsedName: state.lastUsedName,
      resolvedName,
      resolutionError,
      ...live,
      lastBootAppliedName: state.lastBootAppliedName,
      lastBootAppliedAt: state.lastBootAppliedAt,
      lastBootStatus: state.lastBootStatus,
    };
  }

  app.get("/api/startup-config", async (_req, res) => {
    try {
      res.json(await publicState());
    } catch (error) {
      res.status(500).json({ status: "error", reason: error.message });
    }
  });

  function markApplied(record) {
    writeState({
      ...readState(),
      activeOrigin: "system",
      activeId: record.id,
      activeName: record.name,
      lastUsedId: record.id,
      lastUsedName: record.name,
    });
  }

  function referenced(record) {
    const state = readState();
    return (
      [state.activeId, state.configId, state.lastUsedId].some(
        (id) => id != null && String(id) === String(record.id),
      ) ||
      [state.activeName, state.configName, state.lastUsedName].includes(
        record.name,
      )
    );
  }

  app.get("/api/system-presets", async (_req, res) => {
    try {
      const records = readSavedConfigs().filter(
        (record) => record.type === SYSTEM_TYPE,
      );
      res.json({
        state: await publicState(),
        blocked:
          fs.existsSync(signalSnapshot) || fs.existsSync(measurementSession),
        presets: records.map((record) => ({
          id: record.id,
          name: record.name,
          createdDate: record.createdDate,
          deletable: !referenced(record),
          masterVolume: (() => {
            try {
              return storedVolumeFor(record, readState());
            } catch (_) {
              return null;
            }
          })(),
        })),
      });
    } catch (error) {
      res.status(503).json({ reason: error.message });
    }
  });

  app.post("/api/system-presets/capture", jsonParser, async (req, res) => {
    try {
      const result = await gate(async () => {
        assertNormalWorkflow();
        const name = String(req.body?.name || "").trim();
        if (name.length < 3 || name.length > 80)
          throw new Error("Use a name of 3–80 characters");
        const ws = await openDsp();
        let live, volume;
        try {
          live = await dspRequest(ws, "GetConfigJson");
          volume = Number(await dspRequest(ws, "GetVolume"));
        } finally {
          ws.close();
        }
        if (live.devices?.capture?.type === "SignalGenerator")
          throw new Error("Temporary capture cannot be saved");
        if (!Number.isFinite(volume) || volume > 0 || volume < -100)
          throw new Error("Invalid live Master");
        validateProcessingSnapshot(
          processingOf(live),
          live.mixers,
          live.devices,
        );
        return store.update(savedConfigsFile, (records) => {
          const existing = records.find(
            (r) => r.type === SYSTEM_TYPE && r.name === name,
          );
          if (existing && req.body?.overwrite !== true)
            throw new Error("Name already exists; explicitly choose Update");
          const record = {
            id: existing?.id || randomUUID(),
            type: SYSTEM_TYPE,
            name,
            createdDate: existing?.createdDate || new Date().toISOString(),
            data: {
              version: 1,
              sourcePage: "system-presets",
              processing: { title: live.title || "", ...processingOf(live) },
              masterVolume: volume,
            },
          };
          if (existing) records.splice(records.indexOf(existing), 1, record);
          else records.push(record);
          return record;
        });
      });
      res.json({ id: result.id, name: result.name });
    } catch (error) {
      res.status(409).json({ reason: error.message });
    }
  });

  app.post("/api/system-presets/apply", jsonParser, async (req, res) => {
    try {
      await gate(async () => {
        const record = findSystemConfig(req.body?.id);
        if (!record) throw new Error("System preset not found");
        await applyRecord(record);
        markApplied(record);
      });
      res.json({ status: "ok", ...(await publicState()) });
    } catch (error) {
      res.status(409).json({ reason: error.message });
    }
  });

  app.post("/api/system-presets/rename", jsonParser, async (req, res) => {
    try {
      const result = await gate(() => {
        const name = String(req.body?.name || "").trim();
        if (name.length < 3 || name.length > 80) throw new Error("Use a name of 3–80 characters");
        const records = readSavedConfigs();
        const record = records.find(r => r.type === SYSTEM_TYPE && String(r.id) === String(req.body?.id));
        if (!record) throw new Error("System preset not found");
        if (records.some(r => r !== record && r.type === SYSTEM_TYPE && r.name === name)) throw new Error("Name already exists");
        const previous = clone(records), state = readState(), next = clone(state);
        for (const [idKey, nameKey] of [["activeId", "activeName"], ["configId", "configName"], ["lastUsedId", "lastUsedName"], ["lastBootAppliedId", "lastBootAppliedName"]]) {
          if ((next[idKey] != null && String(next[idKey]) === String(record.id)) || (next[idKey] == null && next[nameKey] === record.name)) {
            next[idKey] = record.id;
            next[nameKey] = name;
          }
        }
        record.name = name;
        store.atomicWrite(savedConfigsFile, records);
        try { writeState(next); }
        catch (error) { store.atomicWrite(savedConfigsFile, previous); throw error; }
        return { id: record.id, name };
      });
      res.json(result);
    } catch (error) { res.status(409).json({ reason: error.message }); }
  });

  app.post("/api/system-presets/delete", jsonParser, async (req, res) => {
    try {
      await gate(() =>
        store.update(savedConfigsFile, (records) => {
          const record = records.find(
            (r) =>
              r.type === SYSTEM_TYPE && String(r.id) === String(req.body?.id),
          );
          if (!record) throw new Error("System preset not found");
          if (referenced(record))
            throw new Error(
              "Preset is active, selected for startup or last used; keep this referenced preset",
            );
          records.splice(records.indexOf(record), 1);
        }),
      );
      res.json({ status: "ok" });
    } catch (error) {
      res.status(409).json({ reason: error.message });
    }
  });

  app.post("/api/startup-config", jsonParser, async (req, res) => {
    try {
      const mode = String(req.body?.mode || "").trim();
      if (!["yaml", "specific", "last"].includes(mode))
        throw new Error("Invalid startup mode");
      await gate(() => {
        const current = readState();
        const next = { ...current, mode };
        if (mode === "specific") {
          const record = findSystemConfig(
            req.body?.configId,
            req.body?.configName,
          );
          if (!record)
            throw new Error("Select an existing system configuration first");
          next.configId = record.id;
          next.configName = record.name;
        } else {
          next.configId = null;
          next.configName = null;
        }
        if (
          mode === "last" &&
          !findSystemConfig(current.lastUsedId, current.lastUsedName)
        ) {
          throw new Error("No last-used system configuration is available yet");
        }
        writeState(next);
      });
      res.json({ status: "ok", ...(await publicState()) });
    } catch (error) {
      res.status(400).json({ status: "error", reason: error.message });
    }
  });

  app.post("/api/startup-config/active", jsonParser, async (req, res) => {
    try {
      await gate(async () => {
        assertNormalWorkflow();
        const record = findSystemConfig(
          req.body?.configId,
          req.body?.configName,
        );
        if (!record)
          throw new Error("Applied system configuration no longer exists");
        const ws = await openDsp();
        try {
          const live = await dspRequest(ws, "GetConfigJson");
          if (!sameProcessing(live, record.data?.processing))
            throw new Error("Preset does not match live processing");
          const volume = Number(await dspRequest(ws, "GetVolume"));
          if (
            !Number.isFinite(volume) ||
            Math.abs(volume - storedVolumeFor(record, readState())) > 0.05
          )
            throw new Error("Preset Master does not match live Master");
        } finally {
          ws.close();
        }
        const current = readState();
        const liveVolume = await readLiveVolume();
        const presetVolumes = { ...(current.presetVolumes || {}) };
        if (Number.isFinite(liveVolume))
          presetVolumes[String(record.id)] = liveVolume;
        writeState({
          ...current,
          activeOrigin: "system",
          activeId: record.id,
          activeName: record.name,
          lastUsedId: record.id,
          lastUsedName: record.name,
          presetVolumes,
        });
      });
      res.json({ status: "ok", ...(await publicState()) });
    } catch (error) {
      res.status(400).json({ status: "error", reason: error.message });
    }
  });

  async function runBootApplyUnlocked(bootId, attempt = 1) {
    const state = readState();
    if (!bootId || state.lastBootIdApplied === bootId) return;

    if (state.mode === "yaml") {
      writeState({
        ...state,
        activeOrigin: "yaml",
        activeId: null,
        activeName: "Hardware YAML",
        lastBootIdApplied: bootId,
        lastBootAppliedId: null,
        lastBootAppliedName: "Hardware YAML",
        lastBootAppliedAt: new Date().toISOString(),
        lastBootStatus: "yaml",
      });
      console.log("Startup configuration: using CamillaDSP hardware YAML.");
      return;
    }

    let record;
    try {
      record = resolveConfiguredRecord(state);
    } catch (error) {
      writeState({
        ...state,
        activeOrigin: "yaml",
        activeId: null,
        activeName: "Hardware YAML",
        lastBootIdApplied: bootId,
        lastBootAppliedId: null,
        lastBootAppliedName: null,
        lastBootAppliedAt: new Date().toISOString(),
        lastBootStatus: `error: ${error.message}`,
      });
      console.error(`Startup configuration skipped: ${error.message}`);
      return;
    }

    try {
      const targetVolume = await applyRecord(record);
      const latest = readState();
      writeState({
        ...latest,
        activeOrigin: "system",
        activeId: record.id,
        activeName: record.name,
        lastUsedId: record.id,
        lastUsedName: record.name,
        lastBootIdApplied: bootId,
        lastBootAppliedId: record.id,
        lastBootAppliedName: record.name,
        lastBootAppliedAt: new Date().toISOString(),
        lastBootStatus: `applied @ ${targetVolume.toFixed(1)} dB`,
      });
      console.log(
        `Startup configuration applied: ${record.name} @ ${targetVolume.toFixed(1)} dB master`,
      );
    } catch (error) {
      if (attempt < 20) {
        setTimeout(() => runBootApply(bootId, attempt + 1), 1500);
        return;
      }
      const latest = readState();
      writeState({
        ...latest,
        activeOrigin: "yaml",
        activeId: null,
        activeName: "Hardware YAML",
        lastBootIdApplied: bootId,
        lastBootAppliedId: null,
        lastBootAppliedName: record.name,
        lastBootAppliedAt: new Date().toISOString(),
        lastBootStatus: `error: ${error.message}`,
      });
      console.error(
        `Startup configuration '${record.name}' could not be applied: ${error.message}`,
      );
    }
  }

  const runBootApply = (bootId, attempt) =>
    gate(() => runBootApplyUnlocked(bootId, attempt));

  function scheduleBootApply() {
    if (demo) return;
    const bootId = currentBootId();
    if (!bootId) {
      console.warn(
        "Startup configuration: Linux boot id unavailable; automatic boot recall disabled.",
      );
      return;
    }
    if (readState().lastBootIdApplied === bootId) return;
    setTimeout(() => runBootApply(bootId), 1500);
  }

  return {
    scheduleBootApply,
    getState: publicState,
    readProcessing: async () => {
      const ws = await openDsp();
      try {
        const config = await dspRequest(ws, "GetConfigJson");
        return { config, revision: require("./advancedModel").revision(config) };
      } finally { ws.close(); }
    },
    applyRecord: (record) => gate(() => applyRecord(record)),
    // Advanced submits a typed operation, never a replacement configuration.
    editProcessing: (expected, mutate) => gate(async () => {
      assertNormalWorkflow();
      const ws = await openDsp();
      let attenuated = false, safeVolume = SAFE_BOOT_VOLUME_DB;
      try {
        const live = await dspRequest(ws, "GetConfigJson");
        if (live.devices?.capture?.type === "SignalGenerator") throw new Error("Stop Signal Generator before editing processing");
        const revision = require("./advancedModel").revision;
        if (revision(live) !== expected) throw new Error("DSP changed since editing began. Refresh and review your changes.");
        const next = mutate(clone(live));
        if (JSON.stringify(stable(next.devices)) !== JSON.stringify(stable(live.devices))) throw new Error("Hardware devices are not editable here");
        validateProcessingSnapshot(processingOf(next), next.mixers, next.devices);
        const volume = await dspRequest(ws, "GetVolume");
        if (!Number.isFinite(volume) || volume < -100 || volume > 0) throw new Error("Invalid live Master");
        safeVolume = Math.min(volume, SAFE_BOOT_VOLUME_DB);
        attenuated = true;
        await dspRequest(ws, { SetVolume: safeVolume });
        await dspRequest(ws, { SetConfigJson: JSON.stringify(next) });
        const actual = await dspRequest(ws, "GetConfigJson");
        if (revision(actual) !== revision(next)) throw new Error("Processing readback mismatch");
        await dspRequest(ws, { SetVolume: volume });
        const actualVolume = await dspRequest(ws, "GetVolume");
        if (!Number.isFinite(actualVolume) || Math.abs(actualVolume - volume) > .05) throw new Error("Master readback mismatch");
        return { config: actual, revision: revision(actual) };
      } catch (error) {
        if (attenuated) {
          await dspRequest(ws, { SetVolume: safeVolume }).catch(() => {});
          error.message += `; Master held at ${safeVolume} dB. Inspect the system before raising it.`;
        }
        throw error;
      } finally { ws.close(); }
    }),
  };
};
