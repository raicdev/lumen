/**
 * Which views are visible in the workbench, for walkthrough steps waiting for
 * `onView:<id>` (VS Code's `IViewsService.onDidChangeViewVisibility`). The App
 * reports its side bar / panel surface; contributed views of an open container
 * are visible with it, built-in ones under their VS Code ids.
 */

let visible = new Set<string>();
const listeners = new Set<(id: string, visible: boolean) => void>();

/** VS Code ids of Lumen's built-in surfaces (a step may use either spelling). */
const ALIASES: Record<string, string[]> = {
  explorer: ["workbench.explorer.fileView"],
  search: ["workbench.view.search"],
  scm: ["workbench.scm", "workbench.scm.repositories", "workbench.scm.history"],
  debug: [
    "workbench.debug.welcome",
    "workbench.debug.variablesView",
    "workbench.debug.watchExpressionsView",
    "workbench.debug.callStackView",
    "workbench.debug.loadedScriptsView",
    "workbench.debug.breakPointsView",
    "workbench.debug.disassemblyView",
  ],
  outline: ["outline"],
  extensions: ["workbench.view.extensions"],
  problems: ["workbench.panel.markers.view"],
  output: ["workbench.panel.output"],
  terminal: ["terminal"],
  "view:debug-console": ["workbench.panel.repl"],
};

/** View ids a Lumen surface stands for. */
export function viewAliases(id: string): string[] {
  if (id.startsWith("view:feature:")) return [id.slice("view:feature:".length)];
  return [id, ...(ALIASES[id] ?? [])];
}

export function onViewVisibility(listener: (id: string, visible: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isViewVisible(id: string): boolean {
  return visible.has(id);
}

/** Replaces the visible set: listeners hear about views that appeared or disappeared. */
export function setVisibleViews(ids: Iterable<string>): void {
  const next = new Set<string>();
  for (const id of ids) for (const alias of viewAliases(id)) next.add(alias);
  const previous = visible;
  if (next.size === previous.size && [...next].every((id) => previous.has(id))) return;
  visible = next;
  for (const id of previous) if (!next.has(id)) for (const listener of listeners) listener(id, false);
  for (const id of next) if (!previous.has(id)) for (const listener of listeners) listener(id, true);
}
