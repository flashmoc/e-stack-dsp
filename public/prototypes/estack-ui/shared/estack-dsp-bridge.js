(() => {
  'use strict';

  const hardware = new URLSearchParams(location.search).get('transport') === 'camillanode';
  const listeners = new Set();
  let socket = null;
  let spectrumSocket = null;
  let phase = 'offline';
  let commandQueue = Promise.resolve();
  let spectrumQueue = Promise.resolve();

  const emit = detail => listeners.forEach(listener => listener({ mode: hardware ? 'camillanode' : 'local', phase, ...detail }));
  const socketUrl = () => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/dsp`;
  const spectrumSocketUrl = () => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/spectrum`;

  function requireHardware() {
    if (!hardware) throw new Error('Open this workspace with ?transport=camillanode to use the CamillaNode API.');
  }

  function connect(timeoutMs = 3500) {
    requireHardware();
    if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket);
    if (socket?.readyState === WebSocket.CONNECTING) return new Promise((resolve, reject) => {
      socket.addEventListener('open', () => resolve(socket), { once: true });
      socket.addEventListener('error', () => reject(new Error('CamillaDSP proxy connection failed.')), { once: true });
    });
    phase = 'connecting'; emit({ endpoint: socketUrl() });
    return new Promise((resolve, reject) => {
      const next = new WebSocket(socketUrl());
      const timer = window.setTimeout(() => { try { next.close(); } catch (_) {} reject(new Error('CamillaDSP proxy connection timed out.')); }, timeoutMs);
      const fail = () => { window.clearTimeout(timer); phase = 'offline'; emit({ endpoint: socketUrl() }); reject(new Error('CamillaDSP proxy is unavailable.')); };
      next.addEventListener('open', () => { window.clearTimeout(timer); socket = next; phase = 'connected'; emit({ endpoint: socketUrl() }); resolve(socket); }, { once: true });
      next.addEventListener('error', fail, { once: true });
      next.addEventListener('close', () => { if (socket === next) socket = null; phase = 'offline'; emit({ endpoint: socketUrl() }); });
    });
  }

  async function sendCommand(ws, payload, timeoutMs = 5000) {
    const name = typeof payload === 'string' ? payload : Object.keys(payload || {})[0];
    if (!name) throw new Error('Invalid CamillaDSP command.');
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => { ws.removeEventListener('message', receive); reject(new Error(`${name} timed out.`)); }, timeoutMs);
      const receive = event => {
        let reply;
        try { reply = JSON.parse(event.data); } catch (_) { return; }
        if (!Object.prototype.hasOwnProperty.call(reply, name)) return;
        window.clearTimeout(timer); ws.removeEventListener('message', receive);
        const result = reply[name] || {};
        if (result.result !== 'Ok') { reject(new Error(result.value || `${name} failed.`)); return; }
        let value = result.value;
        if (name === 'GetConfigJson' && typeof value === 'string') {
          try { value = JSON.parse(value); } catch (_) { reject(new Error('CamillaDSP returned invalid configuration JSON.')); return; }
        }
        resolve(value);
      };
      ws.addEventListener('message', receive);
      try { ws.send(JSON.stringify(payload)); } catch (error) { window.clearTimeout(timer); ws.removeEventListener('message', receive); reject(error); }
    });
  }

  function command(payload, timeoutMs = 5000) {
    const run = async () => sendCommand(await connect(), payload, timeoutMs);
    const queued = commandQueue.then(run, run);
    commandQueue = queued.catch(() => {});
    return queued;
  }

  function connectSpectrum(timeoutMs = 3500) {
    requireHardware();
    if (spectrumSocket?.readyState === WebSocket.OPEN) return Promise.resolve(spectrumSocket);
    if (spectrumSocket?.readyState === WebSocket.CONNECTING) return new Promise((resolve, reject) => {
      spectrumSocket.addEventListener('open', () => resolve(spectrumSocket), { once: true });
      spectrumSocket.addEventListener('error', () => reject(new Error('Spectrum proxy connection failed.')), { once: true });
    });
    return new Promise((resolve, reject) => {
      const next = new WebSocket(spectrumSocketUrl());
      const timer = window.setTimeout(() => { try { next.close(); } catch (_) {} reject(new Error('Spectrum proxy connection timed out.')); }, timeoutMs);
      const fail = () => { window.clearTimeout(timer); reject(new Error('Spectrum proxy is unavailable.')); };
      next.addEventListener('open', () => { window.clearTimeout(timer); spectrumSocket = next; resolve(next); }, { once: true });
      next.addEventListener('error', fail, { once: true });
      next.addEventListener('close', () => { if (spectrumSocket === next) spectrumSocket = null; });
    });
  }

  function spectrumCommand(payload, timeoutMs = 5000) {
    const run = async () => sendCommand(await connectSpectrum(), payload, timeoutMs);
    const queued = spectrumQueue.then(run, run);
    spectrumQueue = queued.catch(() => {});
    return queued;
  }

  async function api(path, options = {}) {
    requireHardware();
    const response = await fetch(path, { cache: 'no-store', ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      const error = new Error(data.error || `CamillaNode API request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function disconnect() { if (socket) socket.close(); if (spectrumSocket) spectrumSocket.close(); socket = null; spectrumSocket = null; phase = 'offline'; emit({ endpoint: socketUrl() }); }

  window.EStackDSPBridge = Object.freeze({
    mode: hardware ? 'camillanode' : 'local',
    get endpoint() { return hardware ? socketUrl() : null; },
    get connected() { return phase === 'connected'; },
    connect, disconnect, command, connectSpectrum, spectrumCommand, api,
    subscribe(listener) { listeners.add(listener); listener({ mode: hardware ? 'camillanode' : 'local', phase, endpoint: hardware ? socketUrl() : null }); return () => listeners.delete(listener); }
  });
})();
