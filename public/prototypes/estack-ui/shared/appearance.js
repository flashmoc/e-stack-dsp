(() => {
  "use strict";

  const KEY = "estack.product.presentation";
  const defaults = Object.freeze({
    density: "comfortable",
    contrast: "standard",
    background: "graphite",
    accent: "cyan",
    corners: "soft",
    homePage: "control",
  });
  const allowed = {
    density: ["comfortable", "compact"],
    contrast: ["standard", "high"],
    background: ["graphite", "midnight", "slate", "warm"],
    accent: ["cyan", "mint", "amber", "violet"],
    corners: ["soft", "crisp"],
    homePage: [
      "control", "input-processing", "output-processing", "loudness",
      "signal-generator", "measurement-batch",
      "advanced", "preferences",
    ],
  };

  function normalize(value) {
    const result = {};
    for (const [key, options] of Object.entries(allowed)) {
      result[key] = key === "homePage" && value?.[key] === "connections"
        ? "preferences"
        : options.includes(value?.[key]) ? value[key] : defaults[key];
    }
    return result;
  }
  function read() {
    try { return normalize(JSON.parse(localStorage.getItem(KEY) || "{}")); }
    catch { return { ...defaults }; }
  }
  function apply(target, value = read()) {
    const root = target.documentElement;
    if (!root) return;
    const settings = normalize(value);
    for (const key of ["density", "contrast", "background", "accent", "corners"]) {
      root.dataset[key] = settings[key];
    }
  }
  function save(value) {
    const settings = normalize(value);
    localStorage.setItem(KEY, JSON.stringify(settings));
    return settings;
  }

  window.EStackAppearance = Object.freeze({ KEY, defaults, normalize, read, apply, save });
})();
