import type { ExtensionHost } from "../../host.ts";
import * as T from "../../types.ts";
import { CELL_SCHEME, notebookService } from "./model.ts";
import type { NotebookEdit } from "./types.ts";

/** Entries of a WorkspaceEdit that address notebooks (called by workspace-edit.ts). */

/** A text edit whose file is a notebook cell (`vscode-notebook-cell:` URI). */
export function isNotebookCellText(entry: T.WorkspaceEditEntry): boolean {
  return (entry.kind === "text" || entry.kind === "snippet") && T.Uri.revive(entry.uri)?.scheme === CELL_SCHEME;
}

/** A NotebookEdit (the notebook is opened when it is not yet); false when it cannot be applied. */
export async function applyNotebookEdit(host: ExtensionHost, entry: Extract<T.WorkspaceEditEntry, { kind: "notebook" }>): Promise<boolean> {
  const service = notebookService(host);
  const doc = await service.open(T.Uri.revive(entry.uri)!);
  service.applyEdit(doc, entry.edit as NotebookEdit);
  return true;
}

/** All text edits of one cell, positions against its text before the edit; false when the cell does not exist. */
export function applyCellTextEdits(host: ExtensionHost, uri: T.Uri, edits: T.TextEdit[]): boolean {
  return notebookService(host).applyCellTextEdits(uri, edits);
}
