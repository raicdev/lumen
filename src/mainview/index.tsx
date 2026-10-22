import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./lib/rpc"; // initialize the Lumen Shell bridge
import { reloadConfiguredColorTheme } from "./lib/theme";
import { startUpdates } from "./lib/updates";
import "./lib/ui-style"; // modern / legacy look (workbench.style)
import "./lib/tooltip"; // the workbench's own tooltips in place of the browser's

// Lumen Dark is in place already; a configured theme from an extension follows once it is read.
void reloadConfiguredColorTheme();
startUpdates();

// The browser's own menu (Back, Refresh, Save as, Print...) never shows; text fields keep it for cut/copy/paste.
window.addEventListener("contextmenu", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest("input, textarea")) return;
  event.preventDefault();
});

// With an IME (Japanese, Chinese, Korean input), Enter confirms a conversion and Escape cancels it:
// those keys belong to the IME, not to the field's own handlers (which would accept a Quick Open
// row, submit an input box or close a dialog). CodeMirror and xterm handle composition themselves.
window.addEventListener(
  "keydown",
  (event) => {
    if (!event.isComposing && event.keyCode !== 229) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(".cm-editor, .xterm")) return;
    event.stopImmediatePropagation();
  },
  true,
);

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

createRoot(rootEl).render(<App />);

console.log("✦ Lumen React view ready");
