"use strict";

const { revision } = require("./advancedModel");

// SetConfigJson can acknowledge before GetConfigJson exposes the new graph.
// Only the exact requested configuration is accepted; a persistent mismatch
// still leaves the caller's Master safety hold in place.
async function waitForProcessingReadback(read, expected, options = {}) {
  const attempts = options.attempts ?? 26;
  const intervalMs = options.intervalMs ?? 40;
  const pause = options.pause ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const expectedRevision = revision(expected);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const actual = await read();
    if (revision(actual) === expectedRevision) return actual;
    if (attempt + 1 < attempts) await pause(intervalMs);
  }
  throw new Error("Processing readback mismatch");
}

module.exports = { waitForProcessingReadback };
