(() => {
  "use strict";
  const { B, $, post, note } = window.EStackSurface;
  let busy = false,
    polling = false,
    stopped = false,
    bootDraft = false;
  let epoch = 0;
  let model = null,
    signature = "";
  const help = {
    yaml: "Use the processing supplied by the hardware YAML.",
    specific: "Recall this saved system after CamillaDSP starts.",
    last: "Recall the last successfully applied system preset. Unsaved edits are not recalled.",
  };
  function bootFields() {
    $("targetLabel").hidden = $("bootMode").value !== "specific";
    $("bootHelp").textContent = help[$("bootMode").value];
  }
  function controls() {
    const unavailable = !model || busy;
    document.querySelectorAll("button").forEach((button) => {
      button.disabled =
        unavailable ||
        (model.blocked &&
          ["capture", "apply", "update"].includes(
            button.dataset.action || button.id,
          )) ||
        button.dataset.protected === "true";
    });
    $("state").textContent = busy
      ? "Working…"
      : model
        ? "Live system"
        : "Unavailable";
  }
  function render(next) {
    model = next;
    const s = next.state;
    $("activeName").textContent =
      s.activeOrigin === "system" ? s.activeName : "Hardware YAML";
    $("dirty").textContent = s.activeMissing
      ? "MISSING"
      : s.dirty === null
        ? "UNKNOWN"
        : s.dirty
          ? "MODIFIED"
          : s.activeOrigin === "system"
            ? "ACTIVE"
            : "YAML SOURCE";
    $("master").textContent = Number.isFinite(s.masterVolume)
      ? `${s.masterVolume.toFixed(1)} dB`
      : "—";
    $("bootSummary").textContent =
      s.mode === "yaml"
        ? "Hardware YAML"
        : s.mode === "last"
          ? "Last used"
          : s.resolvedName || "Unresolved";
    $("blocked").hidden = !next.blocked;
    $("resolution").textContent =
      s.resolutionError ||
      (s.mode === "yaml"
        ? "Next boot: hardware YAML"
        : `Next boot: ${s.resolvedName}`);
    $("lastBoot").textContent =
      `${s.lastBootStatus || "Not recorded"}${s.lastBootAppliedAt ? ` · ${new Date(s.lastBootAppliedAt).toLocaleString()}` : ""}`;
    const key = JSON.stringify(next.presets);
    if (key !== signature) {
      signature = key;
      const selected = $("bootTarget").value;
      $("presets").replaceChildren();
      $("bootTarget").replaceChildren();
      next.presets.forEach((preset) => {
        const option = new Option(preset.name, preset.id);
        $("bootTarget").append(option);
        const row = document.createElement("article");
        row.className = "preset-row";
        row.dataset.id = preset.id;
        const title = document.createElement("h3");
        title.textContent = preset.name;
        const meta = document.createElement("p");
        meta.className = "muted";
        meta.textContent = `Master ${preset.masterVolume ?? "unknown"} dB · ${preset.createdDate ? new Date(preset.createdDate).toLocaleDateString() : "Legacy preset"}`;
        if (!preset.deletable) meta.textContent += " · Retained: active, startup or last-used reference";
        const actions = document.createElement("div");
        actions.className = "surface-actions";
        for (const [action, label] of [
          ["apply", "Apply"],
          ["boot", "Use at boot"],
          ["update", "Update from live"],
          ["rename", "Rename"],
          ["delete", "Delete"],
        ]) {
          const button = document.createElement("button");
          button.textContent = label;
          button.dataset.action = action;
          button.className =
            action === "apply"
              ? "primary"
              : action === "delete"
                ? "danger"
                : "";
          if (action === "delete" && !preset.deletable) {
            button.dataset.protected = "true";
            button.title =
              "Retained because this preset is active, selected for boot or last used";
          }
          button.addEventListener("click", () => act(action, preset));
          actions.append(button);
        }
        row.append(title, meta, actions);
        $("presets").append(row);
      });
      if (
        [...$("bootTarget").options].some((option) => option.value === selected)
      )
        $("bootTarget").value = selected;
    }
    $("presets")
      .querySelectorAll(".preset-row")
      .forEach((row) => {
        row.dataset.active = String(row.dataset.id === String(s.activeId));
      });
    $("empty").hidden = next.presets.length > 0;
    if (!bootDraft) {
      $("bootMode").value = s.mode;
      if (s.configId != null) $("bootTarget").value = String(s.configId);
    }
    bootFields();
    controls();
  }
  async function refresh() {
    if (busy || polling || stopped) return;
    polling = true;
    const generation = epoch;
    try {
      const next = await B.api("/api/system-presets");
      if (!busy && generation === epoch) render(next);
    } catch (error) {
      model = null;
      note(error.message, true);
      controls();
    } finally {
      polling = false;
    }
  }
  async function run(operation, message) {
    if (busy) return;
    busy = true;
    epoch++;
    controls();
    note("Working…");
    try {
      await operation();
      note(message);
    } catch (error) {
      note(error.message, true);
    } finally {
      busy = false;
      await refresh();
      controls();
    }
  }
  async function syncBandPresentation() {
    // Full-system recall replaces pipeline membership. Reconcile only existing
    // browser display flags so later EQ pages describe that actual live state.
    const config = await B.command('GetConfigJson');
    const active = new Set((config.pipeline || []).filter(step => step.type === 'Filter' && !step.bypassed).flatMap(step => step.names || []));
    const disabled = name => !!config.filters?.[name] && Math.abs(Number(config.filters[name].parameters?.gain || 0)) >= 0.05 && !active.has(name);
    for (let slot = 0; slot < 10; slot++) {
      const suffix = String(slot + 1).padStart(2, '0');
      const globalName = 'GLOBAL_EQ_' + suffix;
      localStorage.setItem('estack.globalEq.disabled.' + globalName, String(disabled(globalName)));
      for (let channel = 0; channel < 6; channel++) localStorage.setItem('estack.peq.disabled.' + channel + '.' + slot, String(disabled('USER_CH' + channel + '_PEQ_' + suffix)));
    }
  }
  function act(action, preset) {
    if (action === "rename") {
      const name = prompt("New preset name", preset.name)?.trim();
      if (name && name !== preset.name) run(() => post("/api/system-presets/rename", { id: preset.id, name }), "Preset renamed");
      return;
    }
    if (action === "boot") {
      bootDraft = true;
      $("bootMode").value = "specific";
      $("bootTarget").value = preset.id;
      bootFields();
      $("startupForm").scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    const messages = {
      apply: `Apply “${preset.name}”? This replaces processing and recalls its Master level.`,
      update: `Overwrite “${preset.name}” with current processing and Master?`,
      delete: `Delete “${preset.name}”?`,
    };
    if (!confirm(messages[action])) return;
    run(
      async () => {
        await post(
          `/api/system-presets/${action === "update" ? "capture" : action}`,
          action === "update"
            ? { name: preset.name, overwrite: true }
            : { id: preset.id },
        );
        if (action === "apply") {
          try { await syncBandPresentation(); } catch (error) { throw new Error("Preset applied; EQ display synchronization failed: " + error.message); }
        }
      },
      `${action === "apply" ? "Applied" : action === "update" ? "Updated" : "Deleted"} ${preset.name}`,
    );
  }
  $("captureForm").addEventListener("submit", (event) => {
    event.preventDefault();
    run(
      () => post("/api/system-presets/capture", { name: $("name").value }),
      "System preset saved",
    );
  });
  $("startupForm").addEventListener("submit", (event) => {
    event.preventDefault();
    run(async () => {
      await post("/api/startup-config", {
        mode: $("bootMode").value,
        configId: $("bootTarget").value,
      });
      bootDraft = false;
    }, "Startup choice saved. Current processing is unchanged.");
  });
  $("bootMode").addEventListener("change", () => {
    bootDraft = true;
    bootFields();
  });
  $("bootTarget").addEventListener("change", () => {
    bootDraft = true;
  });
  addEventListener("pagehide", () => {
    stopped = true;
    B.disconnect();
    clearInterval(timer);
  });
  controls();
  bootFields();
  const timer = setInterval(refresh, 2500);
  if (B.mode === "camillanode") refresh();
  else {
    clearInterval(timer);
    note("Open the live product to manage system presets.");
  }
})();
