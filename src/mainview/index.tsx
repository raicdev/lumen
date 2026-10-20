import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./lib/rpc"; // initialize the Lumen Shell bridge
import { reloadConfiguredColorTheme } from "./lib/theme";

// Lumen Dark is in place already; a configured theme from an extension follows once it is read.
void reloadConfiguredColorTheme();

// The browser's own menu (Back, Refresh, Save as, Print...) never shows; text fields keep it for cut/copy/paste.
window.addEventListener("contextmenu", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest("input, textarea")) return;
  event.preventDefault();
});

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

createRoot(rootEl).render(<App />);

console.log("✦ Lumen React view ready");
