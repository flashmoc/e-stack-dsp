"use strict";
const express = require("express");
const model = require("./advancedModel");
const chunkSizePolicy = require("./chunkSizePolicy");
module.exports = (app, system) => {
  const chunkState = ({ config, revision }) => ({
    ...chunkSizePolicy.describe(config.devices?.samplerate, config.devices?.chunksize,
      config.devices?.target_level, config.devices?.queuelimit),
    revision,
    targetLevel: config.devices?.target_level ?? null,
    persistence: "live-only",
  });
  app.get("/api/chunk-size", async (_req, res) => {
    try { res.json(chunkState(await system.readProcessing())); }
    catch (error) { res.status(503).json({ error: error.message }); }
  });
  app.post("/api/chunk-size", express.json({ limit: "4kb" }), async (req, res) => {
    try {
      if (typeof req.body?.revision !== "string" ||
          req.body?.acknowledgeAudioInterruption !== true)
        throw new Error("Review the live configuration and confirm the audio interruption");
      res.json(chunkState(await system.editChunkSize(req.body.revision, req.body.chunksize)));
    } catch (error) { res.status(409).json({ error: error.message }); }
  });
  app.post("/api/output-protection", express.json({ limit: "4kb" }), async (req, res) => {
    try {
      const before = await system.readProcessing();
      res.json(await system.editProcessing(before.revision, config => model.apply(config, { kind: 'protection', channel: req.body?.channel, clip: req.body?.clip })));
    } catch (error) { res.status(409).json({ reason: error.message }); }
  });
  app.get("/api/advanced", async (_req, res) => {
    try { res.json(await system.readProcessing()); }
    catch (error) { res.status(503).json({ reason: error.message }); }
  });
  app.post("/api/advanced/edit", express.json({ limit: "128kb" }), async (req, res) => {
    try {
      if (typeof req.body?.revision !== "string") throw new Error("A live revision is required");
      res.json(await system.editProcessing(req.body.revision, config => model.apply(config, req.body.operation)));
    } catch (error) { res.status(409).json({ reason: error.message }); }
  });
};
