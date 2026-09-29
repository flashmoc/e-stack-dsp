(() => {
  "use strict";
  const { B, $ } = EStackSurface;
  let live = null;
  let busy = false;

  function notice(message, error = false) {
    $("chunkSizeNotice").textContent = message;
    $("chunkSizeNotice").dataset.error = String(error);
  }
  function render() {
    const value = Number($("chunkSizeChoice").value);
    const selected = live?.options?.find(option => option.size === value) ||
      (live && value === live.current ? {
        size: live.current, chunkMs: live.currentChunkMs, label: "Current live value",
      } : null);
    $("chunkSizeCurrent").textContent = live ? `${live.current} samples` : "—";
    $("chunkSizeRate").textContent = live
      ? `${(live.sampleRate / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} kHz · ${live.currentChunkMs} ms per block`
      : "DSP unavailable";
    $("chunkSizeEstimate").textContent = selected ? `${selected.chunkMs} ms` : "—";
    $("chunkSizeProfile").textContent = selected?.label || "Select a preset";
    $("chunkSizeChoice").disabled = busy || !live;
    $("chunkSizeRefresh").disabled = busy;
    $("chunkSizeApply").disabled = busy || !selected || selected.size === live.current;
  }
  async function refresh() {
    busy = true;
    $("chunkSizeState").textContent = "Reading live DSP…";
    render();
    try {
      live = await B.api("/api/chunk-size");
      const select = $("chunkSizeChoice");
      select.replaceChildren();
      if (!live.options.some(option => option.size === live.current)) {
        select.add(new Option(`${live.current} samples · current`, String(live.current)));
      }
      for (const option of live.options) {
        const name = option.size === live.recommended ? " · recommended" : "";
        select.add(new Option(`${option.size} samples · ${option.chunkMs} ms${name}`, String(option.size)));
      }
      select.value = String(live.current);
      $("chunkSizeState").textContent = "Live · session only";
      notice("");
    } catch (error) {
      live = null;
      $("chunkSizeChoice").replaceChildren(new Option("DSP unavailable", ""));
      $("chunkSizeState").textContent = "Unavailable";
      notice(error.message, true);
    } finally { busy = false; render(); }
  }
  $("chunkSizeChoice").addEventListener("change", render);
  $("chunkSizeRefresh").addEventListener("click", refresh);
  $("chunkSizeApply").addEventListener("click", async () => {
    const selected = live?.options?.find(option => option.size === Number($("chunkSizeChoice").value));
    if (!selected || selected.size === live.current) return;
    if (!confirm(`Apply ${selected.size} samples (${selected.chunkMs} ms per block) to the live CamillaDSP configuration? Audio may briefly stop. The hardware YAML will not change.`)) return;
    busy = true; render();
    try {
      live = await B.api("/api/chunk-size", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision: live.revision, chunksize: selected.size, acknowledgeAudioInterruption: true }),
      });
      $("chunkSizeState").textContent = "Live · session only";
      notice(`Applied ${live.current} samples. The hardware YAML is unchanged.`);
    } catch (error) {
      await refresh();
      notice(error.message, true);
    } finally { busy = false; render(); }
  });
  refresh();
})();
