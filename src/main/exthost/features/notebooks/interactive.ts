import type { ExtensionHost } from "../../host.ts";
import * as T from "../../types.ts";
import { INTERACTIVE_VIEW_PREFIX } from "../../../../shared/notebooks.ts";
import { NotebookCellKind } from "../../compat-types.ts";
import type { NotebookService } from "./model.ts";

/**
 * Interactive Windows (Jupyter's "Run in Interactive Window"): `interactive.open`
 * makes an in-memory notebook of type `interactive` that the window shows as
 * its cells plus an input box; `interactive.execute` (and the input box)
 * appends the input as a code cell and runs it with the selected kernel.
 */

export const INPUT_SCHEME = "vscode-interactive-input";

type Window = { n: number; inputUri: T.Uri };
const windows = new WeakMap<NotebookService, { seq: number; byPath: Map<string, Window> }>();

function windowsOf(service: NotebookService) {
  let entry = windows.get(service);
  if (!entry) windows.set(service, (entry = { seq: 0, byPath: new Map() }));
  return entry;
}

export function inputUriOf(service: NotebookService, viewPath: string): T.Uri | undefined {
  return windowsOf(service).byPath.get(viewPath)?.inputUri;
}

/** `interactive.open(showOptions?, resource?, controllerId?, title?)` → `{ notebookUri, inputUri, notebookEditor }`. */
export async function openInteractive(service: NotebookService, host: ExtensionHost, args: unknown[]): Promise<unknown> {
  const [showOptions, resource, controllerId, title] = args as [unknown, unknown, unknown, unknown];
  const options = typeof showOptions === "number" ? { viewColumn: showOptions } : ((showOptions ?? {}) as { viewColumn?: number; preserveFocus?: boolean });
  const state = windowsOf(service);
  const wanted = T.Uri.revive(resource as T.Uri | undefined);
  // An open Interactive Window of that resource is shown again.
  let doc = wanted && wanted.path.endsWith(".interactive") ? [...service.docs.values()].find((candidate) => candidate.interactive && candidate.uri.toString() === wanted.toString()) : undefined;
  if (!doc) {
    let n = ++state.seq;
    while ([...service.docs.values()].some((candidate) => candidate.uri.path === `/Interactive-${n}.interactive`)) n = ++state.seq;
    const uri = T.Uri.from({ scheme: "untitled", path: `/Interactive-${n}.interactive` });
    doc = service.createInteractive(uri, `${INTERACTIVE_VIEW_PREFIX}${n}`, typeof title === "string" && title ? title : `Interactive - ${n}`);
    state.byPath.set(doc.viewPath, { n, inputUri: T.Uri.from({ scheme: INPUT_SCHEME, path: `/InteractiveInput-${n}` }) });
  } else if (typeof title === "string" && title) {
    doc.title = title;
    service.scheduleSnapshot(doc);
  }
  if (typeof controllerId === "string" && controllerId && service.controllers.get(controllerId)?.matches(doc.notebookType)) service.selectController(doc, controllerId);
  await host.requestFeatureView("notebooks", "show", [doc.viewPath, { preserveFocus: options.preserveFocus ?? false, viewColumn: options.viewColumn, beside: options.viewColumn === T.ViewColumn.Beside }]);
  let editor: unknown;
  for (let waited = 0; waited < 5000 && !editor; waited += 50) {
    editor = service.editorOf(doc);
    if (!editor) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { notebookUri: doc.uri, inputUri: inputUriOf(service, doc.viewPath), notebookEditorId: undefined, notebookEditor: editor };
}

/** The input box's code: a new code cell at the end (in the kernel's first language), run at once. */
export function executeInteractive(service: NotebookService, viewPath: string, code: string): boolean {
  const doc = service.find(viewPath);
  if (!doc || !code.trim()) return false;
  const controller = doc.controllerId ? service.controllers.get(doc.controllerId) : undefined;
  const lastCode = [...doc.cells].reverse().find((cell) => cell.kind === NotebookCellKind.Code);
  const language = controller?.supportedLanguages?.[0] ?? lastCode?.document.languageId ?? "plaintext";
  service.insertCell(doc, doc.cells.length, NotebookCellKind.Code, code, language);
  const cell = doc.cells[doc.cells.length - 1];
  if (cell) service.run(doc, [cell]);
  return true;
}
