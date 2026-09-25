"use strict";
const express = require("express");
const model = require("./advancedModel");
module.exports = (app, system) => {
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
