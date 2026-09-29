"use strict";

function describe(sampleRate, current, targetLevel, queueLimit) {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 384000)
    throw new Error("Unsupported live sample rate for chunk-size selection");
  const recommended = Math.min(8192, Math.max(256,
    2 ** Math.round(Math.log2(sampleRate * 0.022))));
  const tiers = [
    [0.25, "Lowest delay · highest underrun risk"],
    [0.5, "Low delay"],
    [1, "Recommended starting point"],
    [2, "More buffering"],
    [4, "Maximum buffering"],
  ];
  const queue = Number.isInteger(queueLimit) ? queueLimit : 4;
  const options = tiers.map(([factor, label]) => ({
    size: recommended * factor,
    label,
    chunkMs: Number((recommended * factor * 1000 / sampleRate).toFixed(1)),
  })).filter(option => option.size >= 256 && option.size <= 8192 &&
    (!Number.isInteger(targetLevel) || targetLevel <= (2 + queue) * option.size));
  return {
    sampleRate,
    current,
    currentChunkMs: Number.isInteger(current)
      ? Number((current * 1000 / sampleRate).toFixed(1)) : null,
    recommended,
    options,
  };
}

function assertAllowed(sampleRate, size, targetLevel, queueLimit) {
  if (!Number.isInteger(size) || !describe(sampleRate, undefined, targetLevel, queueLimit).options.some(option => option.size === size))
    throw new Error("Select one of the offered chunk sizes for the live sample rate");
}

module.exports = { describe, assertAllowed };
