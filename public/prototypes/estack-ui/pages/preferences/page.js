(() => {
  "use strict";

  const { $, note } = EStackSurface;
  const appearance = EStackAppearance;
  const fields = ["density", "contrast", "corners", "homePage"];

  function render() {
    const settings = appearance.read();
    for (const field of fields) $(field).value = settings[field];
    document.querySelectorAll("[data-choice]").forEach(button => {
      button.setAttribute("aria-pressed", String(settings[button.dataset.choice] === button.dataset.value));
    });
    appearance.apply(document, settings);
  }

  function save(patch) {
    try {
      appearance.save({ ...appearance.read(), ...patch });
      render();
      parent.postMessage({ type: "estack-appearance-changed" }, location.origin);
      note("Preferences saved in this browser.");
    } catch {
      note("Browser storage unavailable; preferences could not be saved.", true);
    }
  }

  document.querySelectorAll("[data-choice]").forEach(button => {
    button.addEventListener("click", () => save({ [button.dataset.choice]: button.dataset.value }));
  });
  for (const field of fields) $(field).addEventListener("change", () => save({ [field]: $(field).value }));

  $("reset").addEventListener("click", () => {
    try {
      localStorage.removeItem(appearance.KEY);
      render();
      parent.postMessage({ type: "estack-appearance-changed" }, location.origin);
      note("Display defaults restored.");
    } catch {
      note("Browser storage unavailable.", true);
    }
  });
  addEventListener("storage", event => { if (event.key === appearance.KEY) render(); });
  render();
})();
