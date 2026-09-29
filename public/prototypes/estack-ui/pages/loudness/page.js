(() => {
  "use strict";
  const { B, $, note, post } = EStackSurface;
  let busy = false,
    live = null,
    curve = null,
    dirty = false,
    timer,
    closed = false;
  const presets = [
    ["reference", "Reference", "Flat · disabled"],
    ["home", "Home", "Low +6 / high +2.5 dB"],
    ["punch", "Punch", "Low +8 / high +2.5 dB"],
    ["night", "Night", "Low +4 / high +1.5 dB"],
    ["outdoor", "Outdoor", "Low +3 / high +2.5 dB"],
    ["maxspl", "Max SPL", "Flat · disabled"],
  ];
  // Match the server-owned preset definitions. This graph is a frequency-contour
  // estimate, not a measurement or a replacement for CamillaDSP's Loudness filter.
  const boosts = {
    reference: [0, 0],
    home: [6, 2.5],
    punch: [8, 2.5],
    night: [4, 1.5],
    outdoor: [3, 2.5],
    maxspl: [0, 0],
  };
  const svgNS = "http://www.w3.org/2000/svg";
  const response = { left: 48, right: 738, top: 20, bottom: 238 };

  function responseX(frequency) {
    return response.left +
      (Math.log10(frequency / 20) / 3) * (response.right - response.left);
  }

  function responseY(gain) {
    return response.bottom - (Math.max(0, Math.min(10, gain)) / 10) *
      (response.bottom - response.top);
  }

  function responseGain(frequency, low, high) {
    const lowWeight = 1 / (1 + (frequency / 70) ** 4);
    const highWeight = 1 / (1 + (3500 / frequency) ** 4);
    return low * lowWeight + high * highWeight;
  }

  function responsePath(low, high) {
    const points = [];
    for (let i = 0; i <= 120; i++) {
      const frequency = 20 * 1000 ** (i / 120);
      points.push(`${i ? "L" : "M"}${responseX(frequency).toFixed(1)},${responseY(responseGain(frequency, low, high)).toFixed(1)}`);
    }
    return points.join(" ");
  }

  function drawResponseGrid() {
    const root = $("responseGrid");
    root.replaceChildren();
    const add = (tag, attributes, content) => {
      const element = document.createElementNS(svgNS, tag);
      for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
      if (content !== undefined) element.textContent = content;
      root.appendChild(element);
    };
    for (const db of [0, 2, 4, 6, 8, 10]) {
      const y = responseY(db);
      add("line", { x1: response.left, x2: response.right, y1: y, y2: y, class: db === 0 ? "zero-line" : "" });
      add("text", { x: 39, y: y + 4, "text-anchor": "end" }, db === 0 ? "0" : `+${db}`);
    }
    const frequencies = response.right < 500
      ? [20, 100, 1000, 20000]
      : [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    for (const frequency of frequencies) {
      const x = responseX(frequency);
      add("line", { x1: x, x2: x, y1: response.top, y2: response.bottom });
      add("text", { x, y: 260, "text-anchor": "middle" }, frequency >= 1000 ? `${frequency / 1000}k` : String(frequency));
    }
  }

  function resizeResponse() {
    const chart = $("responseChart");
    const width = Math.round(chart.getBoundingClientRect().width);
    if (!width) return;
    response.right = width - 22;
    chart.setAttribute("viewBox", `0 0 ${width} 280`);
    drawResponseGrid();
    drawResponse(lastBridge);
  }

  function drawResponse(bridge) {
    const maximum = $("responseMaximum");
    const current = $("responseCurrent");
    const area = $("responseArea");
    const status = $("responseStatus");
    maximum.removeAttribute("d");
    current.removeAttribute("d");
    area.removeAttribute("d");
    status.dataset.live = "false";

    if (!live) {
      status.textContent = "DSP state unavailable";
      return;
    }
    const presetBoosts = boosts[live.preset];
    if (!presetBoosts) {
      status.textContent = "Custom loudness contour · response unavailable";
      return;
    }
    const [low, high] = presetBoosts;
    maximum.setAttribute("d", responsePath(low, high));
    let factor;
    if (!live.enabled) {
      factor = 0;
      status.textContent = "Loudness off · flat response";
    } else if (bridge?.connected && typeof bridge.compensationFactor === "number" && Number.isFinite(bridge.compensationFactor)) {
      factor = Math.max(0, Math.min(1, bridge.compensationFactor));
      status.textContent = `Current · ${Math.round(factor * 100)}% of maximum`;
      status.dataset.live = "true";
    } else {
      status.textContent = "Current response unavailable · WiiM bridge offline";
      return;
    }
    const path = responsePath(low * factor, high * factor);
    current.setAttribute("d", path);
    area.setAttribute("d", `${path} L${response.right},${response.bottom} L${response.left},${response.bottom} Z`);
  }

  let lastBridge = null;
  new ResizeObserver(resizeResponse).observe($("responseChart"));
  $("presets").innerHTML = presets
    .map(
      ([key, name, desc]) =>
        '<button data-preset="' +
        key +
        '" disabled><strong>' +
        name +
        "</strong><small>" +
        desc +
        "</small></button>",
    )
    .join("");
  function controls() {
    document
      .querySelectorAll("#presets button,#toggle,#saveCurve")
      .forEach(
        (el) => (el.disabled = busy || !live || B.mode !== "camillanode"),
      );
    const mode = $("loudnessMode");
    mode.dataset.state = !live
      ? "unknown"
      : !live.enabled
        ? "off"
        : lastBridge?.connected
          ? "ready"
          : "degraded";
    mode.textContent = !live
      ? "UNKNOWN"
      : !live.enabled
        ? "OFF"
        : lastBridge?.connected
          ? "ON"
          : "ON · LINK DOWN";
    mode.setAttribute("aria-label", !live
      ? "Loudness state unavailable"
      : !live.enabled
        ? "Loudness is off"
        : lastBridge?.connected
          ? "Loudness is on and the WiiM link is connected"
          : "Loudness is on but the WiiM link is unavailable");
    $("toggle").textContent = live?.enabled ? "Turn off" : "Turn on";
    $("toggle").setAttribute("aria-pressed", String(!!live?.enabled));
    document
      .querySelectorAll("[data-preset]")
      .forEach((el) =>
        el.setAttribute(
          "aria-pressed",
          String(el.dataset.preset === live?.preset),
        ),
      );
  }
  function draw() {
    if (!curve) return;
    let d = "";
    for (let i = 0; i <= 100; i++) {
      const db = -60 + i * 0.6;
      const n =
        Math.max(
          0,
          Math.min(1, (curve.startDb - db) / (curve.startDb - curve.fullDb)),
        ) ** curve.power;
      d += (i ? "L" : "M") + (20 + i * 4.6) + "," + (130 - n * 110);
    }
    $("curvePath").setAttribute("d", d);
  }
  async function refresh() {
    const results = await Promise.allSettled(
      ["preset", "settings", "bridge"].map((p) => B.api("/api/loudness/" + p)),
    );
    const [p, s, b] = results;
    live = p.status === "fulfilled" ? p.value : null;
    $("state").textContent = live ? "" : "DSP unavailable";
    $("presetName").textContent = live?.preset?.toUpperCase() || "—";
    if (s.status === "fulfilled") {
      curve = s.value.curve;
      $("curveSummary").textContent = `Start ${curve.startDb} → full ${curve.fullDb} dB`;
      if (!dirty)
        for (const k of ["startDb", "fullDb", "power"]) $(k).value = curve[k];
      draw();
    } else {
      $("curveSummary").textContent = "Settings unavailable";
    }
    const bridge = b.status === "fulfilled" ? b.value : null;
    lastBridge = bridge;
    const linkState = !bridge
      ? "Unavailable"
      : !bridge.serviceAlive
        ? "Bridge off"
        : !bridge.wiimConnected
          ? "WiiM offline"
          : !bridge.camillaConnected
            ? "DSP link lost"
            : "Connected";
    const wiimFresh = bridge?.serviceAlive && bridge.wiimConnected &&
      typeof bridge.wiimVolume === "number" && Number.isFinite(bridge.wiimVolume);
    $("wiimVolume").textContent = wiimFresh
      ? `${Math.round(bridge.wiimVolume)} %`
      : "—";
    const calibratedDb = wiimFresh && typeof bridge.realAttenuationDb === "number" &&
      Number.isFinite(bridge.realAttenuationDb)
      ? `${bridge.realAttenuationDb.toFixed(1)} dB attenuation`
      : "";
    $("wiimDetail").textContent = wiimFresh
      ? [bridge.wiimMute ? "Muted" : "", calibratedDb, bridge.camillaConnected ? "" : "DSP link lost"]
        .filter(Boolean).join(" · ") || linkState
      : linkState;
    $("wiimDetail").title = wiimFresh
      ? "Calibrated WiiM attenuation; not a measured dBFS signal level"
      : bridge?.reason || "";
    $("compensation").textContent =
      live && !live.enabled
        ? "Off"
        : bridge?.connected && Number.isFinite(bridge.compensationFactor)
        ? (bridge.compensationFactor * 100).toFixed(0) + " %"
        : "—";
    drawResponse(bridge);
    controls();
  }
  async function apply(path, data) {
    if (busy) return;
    busy = true;
    controls();
    note("Applying…");
    try {
      await post("/api/loudness/" + path, data);
      await refresh();
      note("Saved and read back from CamillaNode.");
    } catch (e) {
      note(e.message, true);
    } finally {
      busy = false;
      controls();
    }
  }
  $("toggle").onclick = () =>
    live?.enabled ? apply("preset", { preset: "reference" }) : apply("toggle");
  $("presets").onclick = (e) => {
    const b = e.target.closest("[data-preset]");
    if (b) apply("preset", { preset: b.dataset.preset });
  };
  $("curveForm").oninput = () => (dirty = true);
  $("curveForm").onsubmit = async (e) => {
    e.preventDefault();
    const next = Object.fromEntries(
      ["startDb", "fullDb", "power"].map((k) => [k, Number($(k).value)]),
    );
    if (next.fullDb >= next.startDb - 2) {
      note("Full compensation must be at least 2 dB below Start.", true);
      return;
    }
    await apply("settings", { curve: next });
  };
  async function poll() {
    if (closed) return;
    if (!busy) await refresh().catch((e) => note(e.message, true));
    if (!closed) timer = setTimeout(poll, 1500);
  }
  if (B.mode === "camillanode") poll();
  else {
    $("state").textContent = "Offline preview";
    note("Open with transport=camillanode for live loudness.");
    document
      .querySelectorAll("input,button")
      .forEach((e) => (e.disabled = true));
  }
  addEventListener("pagehide", () => {
    closed = true;
    clearTimeout(timer);
  });
})();
