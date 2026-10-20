import type { ExtensionManifest } from "../../shared/extensions";
import { DEFAULT_NOTEBOOK_TYPE, INTERACTIVE_OPENER_ID, INTERACTIVE_VIEW_PREFIX, NOTEBOOK_OPENER_ID } from "../../shared/notebooks";
import { extensionService } from "../lib/extensions";
import { basename } from "../lib/paths";
import type { FeatureCommand, ViewFeature, ViewFeatureApi } from "./types";
import { NotebookEditor } from "./notebooks/NotebookEditor";
import { NotebookVariablesPanel } from "./notebooks/Variables";
import { executeInteractiveInput } from "./notebooks/InteractiveInput";
import { interactiveInputs } from "./notebooks/state";

/** The area's API (the Notebook Variables panel asks the host through it). */
let notebooksApi: ViewFeatureApi | null = null;
import { activePath, call, docs, hostEpoch, loadDoc, onHostMessage, pickController, runCells, selectCell, selectedCell } from "./notebooks/state";

/**
 * Window side of the "notebooks" area: the notebook editor (an editor opener for
 * `.ipynb` files and the notebook types extensions contribute), its commands,
 * and the host's snapshots of the open notebooks. The model lives in the
 * extension host (main/exthost/features/notebooks); styles are in
 * feature-notebooks.css.
 */

type ContributedNotebook = { type: string; selector?: { filenamePattern?: string }[] };

/** Patterns of contributes.notebooks (`*`, `**`, `?`, `{a,b}`), matched against the file name or the path. */
function globMatches(pattern: string, path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const target = pattern.includes("/") ? normalized : normalized.slice(normalized.lastIndexOf("/") + 1);
  let source = "";
  let depth = 0;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          source += "(?:.*/)?";
        } else source += ".*";
      } else source += "[^/]*";
    } else if (ch === "?") source += "[^/]";
    else if (ch === "{") {
      depth++;
      source += "(?:";
    } else if (ch === "}" && depth) {
      depth--;
      source += ")";
    } else if (ch === "," && depth) source += "|";
    else source += ch.replace(/[.+^$()|[\]\\,]/g, "\\$&");
  }
  return new RegExp(`^${pattern.includes("/") && !pattern.startsWith("**") ? "(?:.*/)?" : ""}${source}$`, "i").test(target);
}

function contributedNotebooks(): ContributedNotebook[] {
  return extensionService
    .getSnapshot()
    .extensions.filter((extension) => extension.enabled)
    .flatMap((extension) => ((extension.manifest as ExtensionManifest).contributes as { notebooks?: ContributedNotebook[] } | undefined)?.notebooks ?? []);
}

function matches(path: string): boolean {
  if (path.startsWith("untitled:")) return false;
  if (path.toLowerCase().endsWith(".ipynb")) return true;
  return contributedNotebooks().some((entry) => entry.type !== DEFAULT_NOTEBOOK_TYPE && entry.selector?.some((selector) => selector.filenamePattern && globMatches(selector.filenamePattern, path)));
}

/* ── commands (they act on the notebook that has the focus) ──────────────── */

const hasNotebook = () => {
  const path = activePath.get();
  return !!path && !!docs.get()[path];
};

function command(id: string, title: string, run: (api: ViewFeatureApi, path: string, cell: string | null, index: number) => unknown): FeatureCommand {
  return {
    id,
    title,
    category: "Notebook",
    enabled: hasNotebook,
    run: (api) => {
      const path = activePath.get();
      const doc = path ? docs.get()[path] : undefined;
      if (!path || !doc) return;
      const cell = selectedCell(path) ?? doc.cells[0]?.id ?? null;
      return run(api, path, cell, Math.max(0, doc.cells.findIndex((candidate) => candidate.id === cell)));
    },
  };
}

const insert = (offset: 0 | 1, kind: 1 | 2) => (api: ViewFeatureApi, path: string, _cell: string | null, index: number) => call(api, path, "insert", index + offset, kind);

const commands: FeatureCommand[] = [
  command("notebook.execute", "Run All", (api, path) => runCells(api, path, "all")),
  command("notebook.cell.execute", "Execute Cell", (api, path, cell) => (cell ? runCells(api, path, [cell]) : undefined)),
  command("notebook.cell.executeAndSelectBelow", "Execute Notebook Cell and Select Below", async (api, path, cell, index) => {
    if (!cell) return;
    await runCells(api, path, [cell]);
    const next = docs.get()[path]?.cells[index + 1];
    if (next) selectCell(path, next.id, true);
  }),
  command("notebook.cell.executeAndInsertBelow", "Execute Notebook Cell and Insert Below", async (api, path, cell, index) => {
    if (cell) await runCells(api, path, [cell]);
    await insert(1, 2)(api, path, cell, index);
  }),
  command("notebook.cell.executeCellsAbove", "Execute Above Cells", (api, path, cell) => (cell ? runCells(api, path, "above", cell) : undefined)),
  command("notebook.cell.executeCellAndBelow", "Execute Cell and Below", (api, path, cell) => (cell ? runCells(api, path, "below", cell) : undefined)),
  command("notebook.cancelExecution", "Stop Execution", (api, path) => call(api, path, "interrupt")),
  command("notebook.cell.cancelExecution", "Stop Cell Execution", (api, path) => call(api, path, "interrupt")),
  command("notebook.selectKernel", "Select Notebook Kernel", (api, path) => pickController(api, path)),
  command("notebook.clearAllCellsOutputs", "Clear All Outputs", (api, path) => call(api, path, "clearOutputs")),
  command("notebook.cell.clearOutputs", "Clear Cell Outputs", (api, path, cell) => call(api, path, "clearOutputs", cell ?? undefined)),
  command("notebook.cell.insertCodeCellBelow", "Insert Code Cell Below", insert(1, 2)),
  command("notebook.cell.insertCodeCellAbove", "Insert Code Cell Above", insert(0, 2)),
  command("notebook.cell.insertMarkdownCellBelow", "Insert Markdown Cell Below", insert(1, 1)),
  command("notebook.cell.insertMarkdownCellAbove", "Insert Markdown Cell Above", insert(0, 1)),
  command("notebook.cell.delete", "Delete Cell", (api, path, cell) => (cell ? call(api, path, "delete", cell) : undefined)),
  command("notebook.cell.moveUp", "Move Cell Up", (api, path, cell) => (cell ? call(api, path, "move", cell, -1) : undefined)),
  command("notebook.cell.moveDown", "Move Cell Down", (api, path, cell) => (cell ? call(api, path, "move", cell, 1) : undefined)),
  command("notebook.cell.changeToCode", "Change Cell to Code", (api, path, cell) => (cell ? call(api, path, "setKind", cell, 2) : undefined)),
  command("notebook.cell.changeToMarkdown", "Change Cell to Markdown", (api, path, cell) => (cell ? call(api, path, "setKind", cell, 1) : undefined)),
  command("notebook.revertToSaved", "Revert Notebook to Saved", (api, path) => call(api, path, "revert")),
  command("notebook.save", "Save Notebook", (api, path) => call(api, path, "save")),
  {
    id: "interactive.input.clear",
    title: "Clear the Interactive Window Input",
    category: "Interactive",
    enabled: () => !!activePath.get()?.startsWith(INTERACTIVE_VIEW_PREFIX),
    run: () => {
      const path = activePath.get();
      if (path) interactiveInputs.set((all) => ({ ...all, [path]: { value: "", rev: (all[path]?.rev ?? 0) + 1, cursor: -1 } }));
    },
  },
];

export const notebooksView: ViewFeature = {
  area: "notebooks",

  init: (api) => {
    notebooksApi = api;
  },

  onHostReady: () => hostEpoch.set((epoch) => epoch + 1),

  onHostMessage: (payload, api) => onHostMessage(payload, api),

  onHostRequest: async (method, args, api) => {
    if (method === "show") {
      const [path, options] = args as [string, { preview?: boolean; preserveFocus?: boolean; beside?: boolean } | undefined];
      return await api.openFile(path, { preview: options?.preview, focus: !options?.preserveFocus, beside: options?.beside });
    }
    // interactive.execute: the input box of that Interactive Window (or of the active one).
    if (method === "interactiveExecute") {
      const path = (args[0] as string | null) ?? activePath.get();
      return !!path && path.startsWith(INTERACTIVE_VIEW_PREFIX) && (await executeInteractiveInput(api, path));
    }
    if (method === "reload") {
      await loadDoc(api, String(args[0]));
      return true;
    }
    throw new Error(`Unknown notebooks request '${method}'`);
  },

  commands,

  panelTabs: [{ id: "notebooks.variables", title: "Notebook Variables", render: () => (notebooksApi ? <NotebookVariablesPanel api={notebooksApi} /> : null) }],

  editorOpeners: [
    {
      id: INTERACTIVE_OPENER_ID,
      match: (path) => path.startsWith(INTERACTIVE_VIEW_PREFIX),
      title: (path) => docs.get()[path]?.title ?? "Interactive",
      render: (path, api) => <NotebookEditor key={path} path={path} api={api} interactive />,
    },
    {
      id: NOTEBOOK_OPENER_ID,
      match: matches,
      title: (path) => basename(path),
      render: (path, api) => <NotebookEditor key={path} path={path} api={api} />,
      save: async (path, api) => (await call<boolean>(api, path, "save")) === true,
    },
  ],
};
