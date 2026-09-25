(() => {
  "use strict";
  const { B, $, note } = window.EStackSurface;
  let signature = "",
    pending = false,
    stopped = false;
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function owner(name, definition, kind) {
    if (kind === "mixers") return ["Hardware routing", "connections"];
    if (/GLOBAL_EQ_|ESTACK_INPUT_DELAY/.test(name))
      return ["Input Processing", "input-processing"];
    if (/INPUT_PREAMP|INPUT_TRIM/i.test(name))
      return ["Control · Input Trim", "control"];
    if (/loudness/i.test(name + " " + (definition.description || "")))
      return ["Loudness · server workflow", "loudness"];
    if (/USER_CH\d+_PEQ|ESTACK_PHASE_CH/i.test(name))
      return ["Output Processing", "output-processing"];
    if (definition.type === "Limiter" || kind === "processors")
      return ["Output Processing · protection inspection", "output-processing"];
    if (definition.type === "Gain")
      return ["Control / Output Processing", "control"];
    if (
      definition.type === "Delay" ||
      definition.type === "BiquadCombo" ||
      /[hl]pf|crossover/i.test(name)
    )
      return ["Output Processing", "output-processing"];
    return ["System configuration · inspection only", null];
  }
  function values(value) {
    const dl = element('dl');
    for (const [key, entry] of Object.entries(value || {})) {
      const row = element('div'), description = element('dd');
      if (entry && typeof entry === 'object') {
        description.className = 'nested-value';
        if (Array.isArray(entry)) {
          if (entry.every(item => item === null || typeof item !== 'object')) description.textContent = entry.join(', ') || 'None';
          else entry.forEach((item, index) => {
            const disclosure = element('details');
            const title = item?.dest !== undefined ? 'Destination ' + item.dest : item?.channel !== undefined ? 'Source channel ' + item.channel : 'Item ' + (index + 1);
            disclosure.append(element('summary', title), values(item)); description.append(disclosure);
          });
        } else description.append(values(entry));
      } else description.textContent = String(entry ?? '—');
      row.append(element('dt', key), description); dl.append(row);
    }
    return dl;
  }
  function detail(key, title, subtitle, content) {
    const node = element("details");
    node.dataset.key = key;
    const summary = element("summary", title);
    summary.append(element("small", subtitle));
    const body = element("div", undefined, "definition-body");
    body.append(content);
    node.append(summary, body);
    return node;
  }
  function filter() {
    const query = $("search").value.toLowerCase();
    let matches = 0;
    $("definitions")
      .querySelectorAll("details[data-key]")
      .forEach((node) => {
        node.hidden = !node.textContent.toLowerCase().includes(query);
        if (!node.hidden) matches++;
      });
    $("noMatches").hidden = matches > 0;
  }
  function render(config, revision) {
    const next = JSON.stringify(config);
    if (next === signature) return;
    signature = next;
    window.EStackAdvancedEditor.receive(config, revision);
    const expanded = new Set(
      [...document.querySelectorAll("details[open][data-key]")].map(
        (node) => node.dataset.key,
      ),
    );
    $("rate").textContent = config.devices?.samplerate
      ? `${config.devices.samplerate} Hz`
      : "Unavailable";
    $("chunksize").textContent = config.devices?.chunksize ?? "Unavailable";
    $("stages").textContent = config.pipeline?.length ?? 0;
    $("devices").replaceChildren();
    for (const name of ["capture", "playback"]) {
      const device = config.devices?.[name];
      const row = element("div");
      row.append(
        element("dt", name === "capture" ? "Capture" : "Playback"),
        element(
          "dd",
          device
            ? `${device.type} · ${device.device || device.filename || "runtime source"} · ${device.channels} channels`
            : "Unavailable",
        ),
      );
      $("devices").append(row);
    }
    $("pipeline").replaceChildren();
    (config.pipeline || []).forEach((step, index) => {
      const row = element("li");
      const names = step.name ? [step.name] : step.names || [];
      const channels =
        step.channels ?? (step.channel == null ? null : [step.channel]);
      const context = [
        channels ? `Channels ${channels.join(", ")}` : "Configured stage",
        step.bypassed ? "Bypassed" : "",
        step.description || "",
      ]
        .filter(Boolean)
        .join(" · ");
      row.append(
        detail(
          `stage-${index}`,
          `${step.type} · ${names.join(" → ") || "No references"}`,
          context,
          values(step),
        ),
      );
      $("pipeline").append(row);
    });
    $("definitions").replaceChildren();
    for (const kind of ["mixers", "filters", "processors"]) {
      const entries = Object.entries(config[kind] || {});
      $("definitions").append(
        element("h3", `${kind.toUpperCase()} · ${entries.length}`),
      );
      if (!entries.length)
        $("definitions").append(element("p", "None configured", "muted"));
      for (const [name, definition] of entries) {
        const [label, route] = owner(name, definition, kind);
        const content = element("div");
        content.append(element("p", label, "muted"), values(definition));
        if (route) {
          const link = element("a", `Open ${label.split(" · ")[0]}`);
          link.href = `../../?transport=camillanode#${route}`;
          link.target = "_top";
          link.addEventListener("click", (event) => {
            if (parent === window) return;
            event.preventDefault();
            parent.postMessage(
              { type: "estack-navigate", page: route },
              location.origin,
            );
          });
          content.append(link);
        }
        const anchor =
          /GLOBAL_EQ_|ESTACK_|limiter|[hl]pf|gain|delay/i.test(name) ||
          ["Limiter", "Compressor"].includes(definition.type);
        $("definitions").append(
          detail(
            `${kind}-${name}`,
            name,
            `${definition.type || "Mixer"} · ${label}${anchor ? " · System-owned anchor" : ""}`,
            content,
          ),
        );
      }
    }
    document.querySelectorAll("details[data-key]").forEach((node) => {
      node.open = expanded.has(node.dataset.key);
    });
    $("raw").textContent = JSON.stringify(config, null, 2);
    filter();
  }
  async function refresh() {
    if (pending || stopped || window.EStackAdvancedEditor.holding()) return;
    pending = true;
    $("refresh").disabled = true;
    try {
      const snapshot = await B.api('/api/advanced');
      render(snapshot.config, snapshot.revision);
      $("state").textContent = `Live · ${new Date().toLocaleTimeString()}`;
      note("");
    } catch (error) {
      $("state").textContent = "Unavailable";
      note(
        `Live read failed. Any retained details are the last successful snapshot. ${error.message}`,
        true,
      );
    } finally {
      pending = false;
      $("refresh").disabled = false;
    }
  }
  $("search").addEventListener("input", filter);
  $("refresh").addEventListener("click", refresh);
  const timer = setInterval(refresh, 5000);
  addEventListener("pagehide", () => {
    stopped = true;
    clearInterval(timer);
    B.disconnect();
  });
  if (B.mode === "camillanode") refresh();
  else {
    clearInterval(timer);
    $("state").textContent = "Live connection required";
    $("refresh").disabled = true;
  }
})();
