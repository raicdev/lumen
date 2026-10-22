import { getSettings, onSettingsChange } from "./settings";

/**
 * workbench.style: modern.css is a layer over the flat (legacy) look, so the
 * legacy style is that stylesheet switched off.
 */
function applyStyle() {
  const style = getSettings()["workbench.style"];
  const link = document.getElementById("modern-css") as HTMLLinkElement | null;
  if (link) link.disabled = style === "legacy";
  document.documentElement.dataset.workbenchStyle = style;
}

applyStyle();
onSettingsChange(applyStyle);
