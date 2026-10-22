import type { NbHostMessage, NbViewMessage, NbWireDoc } from "../../../shared/notebooks";
import { createStore } from "../store";
import type { ViewFeatureApi } from "../types";

/**
 * State of the notebook editors: the host's snapshots of the open notebooks,
 * which cell is selected, and the traffic to the host (cell text is sent
 * debounced and flushed before anything that depends on it).
 */

export const docs = createStore<Record<string, NbWireDoc>>({});
/** The notebook of the editor that has the focus (what the palette commands act on). */
export const activePath = createStore<string | null>(null);
/** The input box of each Interactive Window: its text, a counter bumped when it is replaced (run, history), the history position. */
export const interactiveInputs = createStore<Record<string, { value: string; rev: number; cursor: number }>>({});
/** Per notebook: bumped when its kernel's variables changed (the Notebook Variables panel reloads). */
export const variablesVersion = createStore<Record<string, number>>({});
/** Bumped when the extension host restarted: mounted editors reload their notebook. */
export const hostEpoch = createStore(0);
/** Per notebook: the selected cell id, and a counter that asks the editor to scroll it into view. */
export const selection = createStore<Record<string, { cell: string | null; reveal: number }>>({});

const lastDirty = new Map<string, boolean>();

export function selectCell(path: string, cell: string | null, reveal = false): void {
  selection.set((all) => {
    const current = all[path];
    if (current && current.cell === cell && !reveal) return all;
    return { ...all, [path]: { cell, reveal: (current?.reveal ?? 0) + (reveal ? 1 : 0) } };
  });
}

export function selectedCell(path: string): string | null {
  return selection.get()[path]?.cell ?? null;
}

export function applyDoc(doc: NbWireDoc, api: ViewFeatureApi): void {
  docs.set((all) => ({ ...all, [doc.path]: doc }));
  if (lastDirty.get(doc.path) !== doc.dirty && !doc.error) {
    lastDirty.set(doc.path, doc.dirty);
    api.setEditorDirty(doc.path, doc.dirty);
  }
}

export function dropDoc(path: string, api: ViewFeatureApi): void {
  docs.set((all) => {
    const { [path]: _gone, ...rest } = all;
    return rest;
  });
  lastDirty.delete(path);
  api.setEditorDirty(path, false);
}

export function onHostMessage(payload: unknown, api: ViewFeatureApi): void {
  const message = payload as NbHostMessage;
  if (message.t === "doc") applyDoc(message.doc, api);
  else if (message.t === "closed") dropDoc(message.path, api);
  else if (message.t === "select") {
    const doc = docs.get()[message.path];
    const first = message.selections[0];
    if (doc && first) selectCell(message.path, doc.cells[first[0]]?.id ?? null);
  } else if (message.t === "variables") {
    variablesVersion.set((all) => ({ ...all, [message.path]: (all[message.path] ?? 0) + 1 }));
  } else if (message.t === "reveal") {
    const doc = docs.get()[message.path];
    const cell = doc?.cells[message.index];
    if (cell) selectCell(message.path, cell.id, true);
  }
}

/* ── to the host ────────────────────────────────────────────────────────── */

const pending = new Map<string, { api: ViewFeatureApi; message: NbViewMessage & { t: "text" }; timer: ReturnType<typeof setTimeout> }>();

/** A cell's text changed in the editor: send it soon (the latest text per cell). */
export function queueText(api: ViewFeatureApi, path: string, cell: string, value: string): void {
  const key = `${path}\u0000${cell}`;
  const previous = pending.get(key);
  if (previous) clearTimeout(previous.timer);
  const message = { t: "text" as const, path, cell, value };
  pending.set(key, {
    api,
    message,
    timer: setTimeout(() => {
      pending.delete(key);
      api.sendToHost(message);
    }, 150),
  });
}

export function flushText(path: string): void {
  for (const [key, entry] of [...pending]) {
    if (entry.message.path !== path) continue;
    clearTimeout(entry.timer);
    pending.delete(key);
    entry.api.sendToHost(entry.message);
  }
}

/** A request to the host about a notebook (after the pending text); failures are shown as an error message. */
export async function call<T = unknown>(api: ViewFeatureApi, path: string, method: string, ...args: unknown[]): Promise<T | undefined> {
  flushText(path);
  try {
    return (await api.requestHost<T>(method, [path, ...args])) as T;
  } catch (error) {
    void api.showMessage("error", error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

export async function loadDoc(api: ViewFeatureApi, path: string): Promise<NbWireDoc | undefined> {
  try {
    const doc = await api.requestHost<NbWireDoc>("open", [path]);
    applyDoc(doc, api);
    return doc;
  } catch (error) {
    void api.showMessage("error", error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

/* ── actions shared by the editor and the commands ──────────────────────── */

export async function pickController(api: ViewFeatureApi, path: string): Promise<boolean> {
  const doc = docs.get()[path];
  if (!doc) return false;
  if (!doc.controllers.length) {
    void api.showMessage("info", `No notebook kernel is available for '${doc.notebookType}'. Install an extension that provides one.`);
    return false;
  }
  const picked = await api.showQuickPick(
    doc.controllers.map((controller) => ({
      label: controller.label,
      description: controller.description,
      detail: controller.detail,
      picked: controller.id === doc.controller?.id,
    })),
    { title: "Select Notebook Kernel", placeholder: "Select a kernel to run this notebook" },
  );
  const controller = picked?.[0] !== undefined ? doc.controllers[picked[0]] : undefined;
  if (!controller) return false;
  await call(api, path, "selectController", controller.id);
  return true;
}

/** Run cells, asking for a kernel first when none is selected. */
export async function runCells(api: ViewFeatureApi, path: string, cells: string[] | "all" | "above" | "below", from?: string): Promise<void> {
  const doc = docs.get()[path];
  if (!doc) return;
  if (!doc.controller && !(await pickController(api, path))) return;
  await call(api, path, "run", cells, from);
}
