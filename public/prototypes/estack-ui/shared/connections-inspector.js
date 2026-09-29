(() => {
  "use strict";

  function mount(root, ids) {
    if (!root) return;
    const B = EStackSurface.B;
    const field = id => root.querySelector(`#${id}`);
    const state = field(ids.state);
    const refresh = field(ids.refresh);
    const notice = field(ids.notice);
    let busy = false;
    let closed = false;
    let timer;

    function device(kind, data) {
      field(`${kind}Type`).textContent = data?.type || "—";
      field(`${kind}Device`).textContent = data?.device || data?.filename ||
        (data?.type === "Stdin" ? "Standard input" :
          data?.type === "SignalGenerator" ? "Temporary test signal" :
            data ? "Not specified" : "—");
      field(`${kind}Channels`).textContent = data?.channels ?? "—";
    }

    async function inspect() {
      if (busy || closed) return;
      busy = true;
      refresh.disabled = true;
      const [runtime, dsp, spectrum] = await Promise.allSettled([
        B.api("/api/runtime"),
        B.command("GetConfigJson", 1500),
        B.spectrumCommand("GetState", 1500),
      ]);
      if (closed) return;
      const config = dsp.status === "fulfilled" ? dsp.value : null;
      field("runtime").textContent = runtime.status === "fulfilled"
        ? `Online · ${runtime.value.mode}` : "Unavailable";
      field("dsp").textContent = config ? "Connected" : "Unavailable";
      field("spectrum").textContent = spectrum.status === "fulfilled"
        ? String(spectrum.value) : "Unavailable";
      state.textContent = config ? "Read-only · live" : "DSP unavailable";
      field("proxy").textContent = config ? "Connected · /ws/dsp" : "Unavailable · /ws/dsp";
      field("rate").textContent = config?.devices?.samplerate
        ? `${config.devices.samplerate.toLocaleString()} Hz` : "—";
      if (config) field("checked").textContent = new Date().toLocaleTimeString();
      device("capture", config?.devices?.capture);
      device("playback", config?.devices?.playback);
      notice.textContent = config ? "Checks update every three seconds."
        : dsp.reason?.message || "Live configuration unavailable.";
      notice.dataset.state = config ? "ready" : "error";
      busy = false;
      refresh.disabled = false;
    }

    async function poll() {
      await inspect();
      if (!closed) timer = setTimeout(poll, 3000);
    }

    refresh.addEventListener("click", inspect);
    field("transport").textContent = B.mode === "camillanode"
      ? "CamillaNode · same origin" : "Offline preview";
    if (B.mode === "camillanode") poll();
    else {
      state.textContent = "Offline preview";
      refresh.disabled = true;
      notice.textContent = "Open with transport=camillanode to inspect the runtime.";
    }
    addEventListener("pagehide", () => {
      closed = true;
      clearTimeout(timer);
      B.disconnect();
    });
  }

  window.EStackConnectionsInspector = Object.freeze({ mount });
})();
