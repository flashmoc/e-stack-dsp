(() => {
  'use strict';

  const outputStops = Object.freeze([
    Object.freeze({ value: 6, position: 4 }),
    Object.freeze({ value: 0, position: 18 }),
    Object.freeze({ value: -12, position: 42 }),
    Object.freeze({ value: -30, position: 68 }),
    Object.freeze({ value: -60, position: 100 })
  ]);

  const clamp = (value, min, max) => {
    const numeric = Number(value);
    return Math.min(max, Math.max(min, Number.isFinite(numeric) ? numeric : min));
  };
  const isOutputRange = (min, max) => Number(min) === -60 && Number(max) === 6;

  function outputPosition(value) {
    const current = clamp(value, -60, 6);
    for (let index = 0; index < outputStops.length - 1; index += 1) {
      const top = outputStops[index]; const bottom = outputStops[index + 1];
      if (current <= top.value && current >= bottom.value) return top.position + (top.value - current) / (top.value - bottom.value) * (bottom.position - top.position);
    }
    return current > 0 ? outputStops[0].position : outputStops.at(-1).position;
  }

  function outputValueAtPosition(position) {
    const current = clamp(position, 0, 100);
    for (let index = 0; index < outputStops.length - 1; index += 1) {
      const top = outputStops[index]; const bottom = outputStops[index + 1];
      if (current >= top.position && current <= bottom.position) return top.value - (current - top.position) / (bottom.position - top.position) * (top.value - bottom.value);
    }
    return current < outputStops[0].position ? 6 : -60;
  }

  function positionPercent(value, min, max) {
    if (isOutputRange(min, max)) return outputPosition(value);
    return 100 - (clamp(value, min, max) - min) / (max - min) * 100;
  }

  function valueAtPosition(position, min, max) {
    if (isOutputRange(min, max)) return outputValueAtPosition(position);
    return max - clamp(position, 0, 100) / 100 * (max - min);
  }

  function positionClass(value, min, max) {
    return `fader-position-${Math.round(clamp(positionPercent(value, min, max), 0, 100))}`;
  }

  function roundToStep(value, min, max, step) {
    const increment = Number(step) || .1;
    return Number((Math.round(clamp(value, min, max) / increment) * increment).toFixed(6));
  }

  window.EStackControlFaderPresentation = Object.freeze({
    // Live console: the meter, scale and gain handle share one dB axis.
    // Gain uses -60..max; measured signal always uses -60..0 dBFS.
    axisPosition: (value, max) => 100 * (max - clamp(value, -60, max)) / (max + 60),
    axisValue: (position, min, max) => clamp(max - clamp(position, 0, 100) * (max + 60) / 100, min, max),
    outputStops,
    positionPercent,
    valueAtPosition,
    positionClass,
    roundToStep
  });
})();
