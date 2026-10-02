(() => {
  'use strict';
  const model = window.EStackInputProcessingModel;
  if (!model) throw new Error('Input Processing import model is unavailable.');
  const MAX_BANDS = 10;
  const aliases = new Map([
    ['pk', 'Peaking'], ['peq', 'Peaking'], ['peaking', 'Peaking'],
    ['ls', 'Lowshelf'], ['lsc', 'Lowshelf'], ['lowshelf', 'Lowshelf'], ['low-shelf', 'Lowshelf'], ['low_shelf', 'Lowshelf'],
    ['hs', 'Highshelf'], ['hsc', 'Highshelf'], ['highshelf', 'Highshelf'], ['high-shelf', 'Highshelf'], ['high_shelf', 'Highshelf']
  ]);
  const clone = model.clone;
  function normalizeType(value) { return aliases.get(String(value || 'Peaking').trim().toLowerCase()) || 'Peaking'; }
  function normalizeRawBand(slot, raw = {}) {
    const normalized = model.normalizeBand(slot, { type: normalizeType(raw.type ?? raw.filterType ?? raw.kind), frequency: raw.frequency ?? raw.freq ?? raw.fc, gain: raw.gain ?? raw.db, q: raw.q ?? raw.Q });
    return { ...normalized, enabled: raw.enabled === undefined ? raw.on !== false : !!raw.enabled };
  }
  function completeBands(rawBands = []) {
    return model.GLOBAL_EQ_SLOT_NAMES.map((_, index) => index < Math.min(MAX_BANDS, rawBands.length) ? normalizeRawBand(index, rawBands[index]) : { ...model.defaultBand(index), enabled: true });
  }
  function apoLine(line) {
    const frequency = line.match(/\bFc\s*=?\s*([-+]?\d*\.?\d+)\s*Hz\b/i); const gain = line.match(/\bGain\s*=?\s*([-+]?\d*\.?\d+)\s*dB\b/i);
    if (!frequency || !gain) return null;
    const q = line.match(/\bQ\s*=?\s*([-+]?\d*\.?\d+)/i); const type = line.match(/\b(PK|PEQ|Peaking|LSC?|Lowshelf|low-shelf|low_shelf|HSC?|Highshelf|high-shelf|high_shelf)\b/i)?.[1];
    return { type, freq: Number(frequency[1]), gain: Number(gain[1]), q: q ? Number(q[1]) : .7, enabled: !/\bOFF\b/i.test(line) };
  }
  function tableLine(line) {
    const clean = line.replace(/#.*/, '').replace(/\/\/.*/, '').trim(); if (!clean) return null;
    const numbers = clean.match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g)?.map(Number) || []; if (numbers.length < 3) return null;
    const indexed = numbers.length >= 4 && Number.isInteger(numbers[0]) && numbers[0] >= 1 && numbers[0] <= 99 && numbers[1] >= 20;
    const [freq, gain, q] = numbers.slice(indexed ? 1 : 0, indexed ? 4 : 3);
    if (!(Number.isFinite(freq) && Number.isFinite(gain) && Number.isFinite(q))) return null;
    const type = clean.match(/\b(PK|PEQ|Peaking|LSC?|Lowshelf|low-shelf|low_shelf|HSC?|Highshelf|high-shelf|high_shelf)\b/i)?.[1];
    return { type, freq, gain, q, enabled: !/\bOFF\b/i.test(clean) };
  }
  function jsonBands(parsed) {
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.bands)) return parsed.bands;
    if (Array.isArray(parsed?.data?.bands)) return parsed.data.bands;
    if (parsed?.filters && typeof parsed.filters === 'object') {
      const active = new Set((parsed.pipeline || []).filter(step => step?.description === model.GLOBAL_EQ_STEP_DESCRIPTION).flatMap(step => step.names || []));
      return model.GLOBAL_EQ_SLOT_NAMES.map((name, index) => {
        const filter = parsed.filters[name]; return filter ? { ...(filter.parameters || filter), enabled: active.size ? active.has(name) : true } : { ...model.defaultBand(index), enabled: true };
      });
    }
    return null;
  }
  function parse(text) {
    const source = String(text || '').trim(); if (!source) throw new Error('Paste an EQ file or text first.');
    try { const parsed = jsonBands(JSON.parse(source)); if (parsed) return { format: 'json', detected: Math.min(MAX_BANDS, parsed.length), bands: completeBands(parsed) }; } catch (error) { if (/^[\[{]/.test(source)) throw error; /* text format */ }
    const lines = source.split(/\r?\n/); const apo = lines.map(apoLine).filter(Boolean);
    if (apo.length) return { format: 'apo', detected: Math.min(MAX_BANDS, apo.length), bands: completeBands(apo) };
    const table = lines.map(tableLine).filter(Boolean);
    if (table.length) return { format: 'table', detected: Math.min(MAX_BANDS, table.length), bands: completeBands(table) };
    throw new Error('Unsupported EQ format. Use REW/Equalizer APO, CSV/table text, E-Stack JSON or CamillaDSP JSON.');
  }
  function serializeBands(bands) { return completeBands(bands).map(band => ({ type: band.type, freq: band.frequency, gain: band.gain, q: band.q, enabled: band.enabled !== false })); }
  function additionsForPreset(currentBands, presetBands) {
    if (!Array.isArray(currentBands) || currentBands.length !== MAX_BANDS || !Array.isArray(presetBands) || presetBands.length > MAX_BANDS) throw new Error('Invalid Global EQ bands.');
    const incoming = completeBands(presetBands).filter(band => band.enabled && !model.isNeutral(band));
    if (!incoming.length) throw new Error('This preset has no enabled EQ bands to add.');
    const empty = currentBands.filter(band => !band.present).map(band => band.slot);
    if (incoming.length > empty.length) throw new Error(`This preset needs ${incoming.length} free EQ slots; only ${empty.length} of ${MAX_BANDS} remain. Nothing changed.`);
    return incoming.map((band, index) => ({ ...band, slot: empty[index], present: true }));
  }
  window.EStackInputProcessingImport = Object.freeze({ MAX_BANDS, normalizeType, normalizeRawBand, completeBands, parse, serializeBands, additionsForPreset, clone });
})();
