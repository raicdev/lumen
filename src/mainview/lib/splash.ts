/** The splash stays at least this long, so its star animation is seen rather than flashing by. */
const MIN_VISIBLE_MS = 700;
/** A startup that never finishes (a hung workspace restore) still shows the workbench. */
const MAX_VISIBLE_MS = 8000;

let hidden = false;

/** Fades the startup splash (index.html) out and the workbench in. Later calls do nothing. */
export function hideSplash(): void {
  if (hidden) return;
  hidden = true;
  const splash = document.getElementById("splash");
  if (!splash) return;
  window.setTimeout(
    () => {
      // The class goes once played: a transform left on #root would anchor the fixed overlays to it.
      const root = document.getElementById("root");
      root?.classList.add("revealing");
      root?.addEventListener("animationend", (event) => event.target === root && root.classList.remove("revealing"));
      window.setTimeout(() => root?.classList.remove("revealing"), 500);
      splash.classList.add("hidden");
      splash.addEventListener("transitionend", () => splash.remove(), { once: true });
      // No transition with reduced motion.
      window.setTimeout(() => splash.remove(), 500);
    },
    Math.max(0, MIN_VISIBLE_MS - performance.now()),
  );
}

window.setTimeout(hideSplash, MAX_VISIBLE_MS);
