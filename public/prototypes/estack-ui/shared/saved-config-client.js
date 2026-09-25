(() => {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const identifier = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  async function loadAll() {
    const records = await window.EStackDSPBridge.api('/getConfigFile');
    if (!Array.isArray(records)) throw new Error('CamillaNode returned an invalid saved configuration collection.');
    return clone(records);
  }
  async function writeAll(records, base) {
    if (!Array.isArray(records)) throw new Error('Saved configuration collection must be an array.');
    await window.EStackDSPBridge.api('/saveConfigFile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base, records }) });
  }
  async function listByType(type) { return (await loadAll()).filter(record => record?.type === type).sort((left, right) => String(left?.name || '').localeCompare(String(right?.name || ''))); }
  async function getById(id) { return (await loadAll()).find(record => String(record?.id) === String(id)) || null; }
  async function save(record, overwrite = false) {
    if (!record?.type || !String(record.name || '').trim()) throw new Error('Saved configuration needs a type and name.');
    const all = await loadAll(); const index = all.findIndex(item => item?.type === record.type && item?.name === record.name);
    const base = clone(all);
    const next = clone(record);
    if (index >= 0) {
      if (!overwrite) { const error = new Error(`A ${record.type} preset named '${record.name}' already exists.`); error.code = 'exists'; throw error; }
      next.id = all[index].id; all.splice(index, 1, next);
    } else { next.id = next.id || identifier(); all.push(next); }
    await writeAll(all, base); return clone(next);
  }
  async function remove(id) {
    const all = await loadAll(); const index = all.findIndex(record => String(record?.id) === String(id));
    if (index < 0) return false;
    const base = clone(all);
    all.splice(index, 1); await writeAll(all, base); return true;
  }
  async function rename(id, value) {
    const name = String(value || '').trim();
    if (!name || name.length > 80) throw new Error('Use a name of 1–80 characters.');
    const all = await loadAll(), base = clone(all);
    const record = all.find(item => String(item.id) === String(id));
    if (!record) throw new Error('Preset no longer exists.');
    if (record.type === 'estack-system') throw new Error('Use the System Preset service.');
    if (all.some(item => item !== record && item.type === record.type && item.name === name)) throw new Error('Name already exists.');
    record.name = name;
    await writeAll(all, base); return clone(record);
  }
  window.EStackSavedConfigClient = Object.freeze({ loadAll, listByType, getById, save, rename, delete: remove });
})();
