"use strict";

const assert = require("assert").strict;
const { waitForProcessingReadback } = require("../server/processingReadback");

(async () => {
  const expected = { filters: { eq: { gain: 2 } }, pipeline: [{ names: ["eq"] }] };
  const stale = { filters: { eq: { gain: 2 } }, pipeline: [] };
  let reads = 0, pauses = 0;
  const actual = await waitForProcessingReadback(async () => ++reads < 3 ? stale : expected,
    expected, { attempts: 3, intervalMs: 0, pause: async () => { pauses++; } });
  assert.deepEqual(actual, expected);
  assert.equal(reads, 3);
  assert.equal(pauses, 2);

  reads = 0;
  await assert.rejects(
    waitForProcessingReadback(async () => { reads++; return stale; }, expected,
      { attempts: 3, intervalMs: 0, pause: async () => {} }),
    /Processing readback mismatch/,
  );
  assert.equal(reads, 3);
  console.log("OK: processing readback accepts only the exact eventual graph and times out safely");
})().catch(error => { console.error(error); process.exitCode = 1; });
