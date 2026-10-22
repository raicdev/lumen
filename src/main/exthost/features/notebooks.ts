import type { NbRequest, NbViewMessage } from "../../../shared/notebooks.ts";
import { DEFAULT_NOTEBOOK_TYPE, INTERACTIVE_OPENER_ID, NOTEBOOK_OPENER_ID } from "../../../shared/notebooks.ts";
import { NotebookRange, TabInputNotebook } from "../compat-types.ts";
import { keyOfUri, uriOfKey } from "../documents.ts";
import type { ExtensionHost } from "../host.ts";
import * as T from "../types.ts";
import type { HostFeature } from "./contract.ts";
import { NOT_HANDLED } from "./contract.ts";
import { executeInteractive, inputUriOf, openInteractive } from "./notebooks/interactive.ts";
import { NotebookService, globMatches, notebookService } from "./notebooks/model.ts";
import type { Serializer } from "./notebooks/model.ts";
import { NotebookVariablesRequestKind, notebookVariables, variableMenuArg } from "./notebooks/variables.ts";
import { NotebookCellOutput, NotebookCellStatusBarAlignment, NotebookCellStatusBarItem, NotebookEdit, NotebookEditorRevealType, TabInputInteractiveWindow, TabInputNotebookDiff } from "./notebooks/types.ts";

/**
 * Host side of the "notebooks" area: workspace.registerNotebookSerializer /
 * openNotebookDocument, the notebooks namespace (controllers, renderer messaging,
 * cell status bar items), notebook editors of the window namespace, and the
 * requests of the notebook editor in the window (mainview/features/notebooks).
 * The model lives in notebooks/model.ts.
 */

let current: NotebookService | null = null;

type Options = { viewColumn?: number; preserveFocus?: boolean; preview?: boolean; selections?: { start: number; end: number }[] };

async function showNotebook(service: NotebookService, host: ExtensionHost, document: { uri: T.Uri }, options: Options = {}): Promise<unknown> {
  const doc = service.find(keyOfUri(document.uri));
  if (!doc) throw new Error(`The notebook ${document.uri.toString()} is not open`);
  if (doc.untitled) throw new Error("Untitled notebooks live in memory only: save the notebook before showing it");
  // Like window.showTextDocument: the view column and preserveFocus go to the window, which
  // picks the editor group (Beside asks for a new one; One..Nine for a group by its position).
  await host.requestFeatureView("notebooks", "show", [doc.viewPath, { preview: options.preview, preserveFocus: options.preserveFocus, viewColumn: options.viewColumn, beside: options.viewColumn === T.ViewColumn.Beside }]);
  // The editor appears when the window has mounted the notebook.
  for (let waited = 0; waited < 5000; waited += 50) {
    const editor = service.editorOf(doc);
    if (editor && service.visibleEditors.includes(editor)) {
      if (options.selections?.length) (editor as { selections: unknown }).selections = options.selections.map((range) => new NotebookRange(range.start, range.end));
      return editor;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`The notebook ${document.uri.toString()} did not open`);
}

const emptyDoc = (path: string, error: string) => ({ path, notebookType: "", version: 0, dirty: false, metadata: {}, cells: [], controller: null, controllers: [], error });

/** Does some `contributes.notebooks` selector claim the file (whatever its priority)? */
function hasNotebookEditor(host: ExtensionHost, path: string): boolean {
  if (path.toLowerCase().endsWith(".ipynb")) return true;
  for (const runtime of host.runtimes.values()) {
    const contributed = (runtime.description.manifest.contributes as { notebooks?: { selector?: { filenamePattern?: string }[] }[] } | undefined)?.notebooks;
    if (contributed?.some((entry) => entry.selector?.some((selector) => !!selector.filenamePattern && globMatches(selector.filenamePattern, path)))) return true;
  }
  return false;
}

/**
 * "Open in Notebook Editor": the active file gets the notebook editor even when its
 * contribution has `"priority": "option"` (which leaves it to the text editor by default).
 */
async function openActiveAsNotebook(service: NotebookService, host: ExtensionHost): Promise<boolean> {
  const tab = host.tabGroups.activeTabGroup.activeTab;
  if (tab?.input instanceof TabInputNotebook || tab?.input instanceof TabInputInteractiveWindow) return true;
  const path = tab?.viewPath();
  if (!path || path.startsWith("feature-editor:")) throw new Error("There is no file in the active editor");
  if (!hasNotebookEditor(host, path)) throw new Error("No notebook editor is contributed for this file");
  const doc = service.find(path) ?? (await service.open(path, path));
  doc.viewed = true;
  await showNotebook(service, host, doc);
  return true;
}

async function onRequest(host: ExtensionHost, method: string, args: unknown[]): Promise<unknown> {
  const service = notebookService(host);
  if (method === "openWith") return await openActiveAsNotebook(service, host);
  const request = { method, args } as NbRequest;
  if (request.method === "open") {
    const path = request.args[0];
    try {
      // An Interactive Window is already in memory under its own view path.
      const found = service.find(path);
      const doc = found?.interactive ? found : await service.open(path, path);
      doc.viewed = true;
      return service.wire(doc);
    } catch (error) {
      return emptyDoc(path, error instanceof Error ? error.message : String(error));
    }
  }
  const doc = service.find(String(args[0]));
  if (!doc) throw new Error(`The notebook ${String(args[0])} is not open`);
  const cellOf = (id: unknown) => {
    const cell = doc.cells.find((candidate) => candidate.id === id);
    if (!cell) throw new Error("The cell does not exist anymore");
    return cell;
  };
  switch (request.method) {
    case "save":
      return await service.save(doc);
    case "revert":
      await service.revert(doc);
      return true;
    case "run": {
      const [, which, from] = request.args;
      const index = from ? cellOf(from).index : 0;
      const cells = which === "all" ? doc.cells : which === "above" ? doc.cells.slice(0, index) : which === "below" ? doc.cells.slice(index) : which.map(cellOf);
      service.run(doc, cells);
      return true;
    }
    case "interrupt":
      await service.interrupt(doc);
      return true;
    case "selectController":
      service.selectController(doc, request.args[1]);
      return true;
    case "insert":
      service.insertCell(doc, request.args[1], request.args[2], request.args[3], request.args[4]);
      return true;
    case "delete": {
      const cell = cellOf(request.args[1]);
      service.splice(doc, cell.index, 1, []);
      return true;
    }
    case "move":
      service.moveCell(doc, cellOf(request.args[1]), request.args[2]);
      return true;
    case "setKind":
      service.setKind(doc, cellOf(request.args[1]), request.args[2]);
      return true;
    case "setLanguage":
      service.setLanguage(doc, cellOf(request.args[1]), request.args[2]);
      return true;
    case "variables":
      return await notebookVariables(service, doc.viewPath, request.args[1], request.args[2], request.args[3]);
    case "interactiveExecute":
      return executeInteractive(service, doc.viewPath, request.args[1]);
    case "clearOutputs":
      service.clearOutputs(doc, request.args[1] ? [cellOf(request.args[1])] : doc.cells);
      return true;
    default:
      throw new Error(`Unknown notebooks request '${method}'`);
  }
}

export const notebooksFeature: HostFeature = {
  area: "notebooks",

  api: ({ host, extensionId }) => {
    const service = notebookService(host);
    return {
      notebooks: {
        createNotebookController: (id: string, notebookType: string, label: string, handler?: (cells: unknown[], notebook: unknown, controller: unknown) => unknown) =>
          service.createController(extensionId, id, notebookType, label, handler),
        createRendererMessaging: (rendererId: string) => {
          // Renderer scripts do not run in Lumen (outputs are rendered natively), so no renderer ever answers.
          const received = new T.EventEmitter<{ editor: unknown; message: unknown }>();
          return {
            rendererId,
            onDidReceiveMessage: received.event,
            postMessage: async (_message: unknown, _editor?: unknown) => false,
          };
        },
        registerNotebookCellStatusBarItemProvider: (notebookType: string, provider: Parameters<NotebookService["registerStatusProvider"]>[2]) =>
          service.registerStatusProvider(extensionId, notebookType, provider),
      },
      workspace: {
        get notebookDocuments() {
          return service.documents;
        },
        openNotebookDocument: async (target: T.Uri | string, content?: unknown) => {
          if (typeof target === "string") return service.createUntitled(target, content as never).facade;
          return (await service.open(T.Uri.revive(target) ?? target)).facade;
        },
        registerNotebookSerializer: (notebookType: string, serializer: Serializer, options?: Record<string, unknown>) =>
          service.registerSerializer(extensionId, notebookType, serializer, options),
        onDidOpenNotebookDocument: service.onDidOpen.event,
        onDidCloseNotebookDocument: service.onDidClose.event,
        onDidChangeNotebookDocument: service.onDidChange.event,
        onWillSaveNotebookDocument: service.onWillSave.event,
        onDidSaveNotebookDocument: service.onDidSave.event,
      },
      window: {
        get activeNotebookEditor() {
          return service.activeEditor;
        },
        get visibleNotebookEditors() {
          return service.visibleEditors;
        },
        showNotebookDocument: (document: { uri: T.Uri }, options?: Options) => showNotebook(service, host, document, options),
        onDidChangeActiveNotebookEditor: service.onDidChangeActiveEditor.event,
        onDidChangeVisibleNotebookEditors: service.onDidChangeVisibleEditors.event,
        onDidChangeNotebookEditorSelection: service.onDidChangeSelection.event,
        onDidChangeNotebookEditorVisibleRanges: service.onDidChangeVisibleRanges.event,
      },
    };
  },

  // notebook/cell/* menus get the `NotebookCell`; notebook/toolbar gets VS Code's `{ notebookEditor: { notebookUri }, ui: true }`.
  menuArg: (host, ref) => {
    const doc = notebookService(host).find(String(ref.path));
    if (!doc) return undefined;
    if (ref.cell !== undefined) return doc.cells.find((cell) => cell.id === ref.cell)?.facade;
    if (typeof ref.variable === "string") return variableMenuArg(notebookService(host), ref.variable);
    return { notebookEditor: { notebookUri: doc.uri }, ui: true };
  },

  // Interactive Windows (Jupyter's "Run in Interactive Window").
  commands: ["interactive.open", "_interactive.open", "interactive.execute"],

  executeCommand: async (host, command, args) => {
    if (command === "interactive.open" || command === "_interactive.open") return await openInteractive(notebookService(host), host, args);
    // The input box is the window's: it sends its text back with "interactiveExecute".
    if (command === "interactive.execute") {
      const uri = T.Uri.revive(args[0] as T.Uri | undefined);
      return await host.requestFeatureView("notebooks", "interactiveExecute", [uri ? (notebookService(host).find(keyOfUri(uri))?.viewPath ?? null) : null]);
    }
    return NOT_HANDLED;
  },

  types: { TabInputInteractiveWindow, NotebookVariablesRequestKind, NotebookCellOutput, NotebookEdit, NotebookEditorRevealType, NotebookCellStatusBarAlignment, NotebookCellStatusBarItem, TabInputNotebookDiff },

  init: (host) => {
    const service = notebookService(host);
    current = service;
    // A notebook closes with its last editor tab.
    host.tabGroups.onDidChangeTabs.event((event) => {
      for (const tab of event.closed) {
        const input = tab.input;
        // An Interactive Window ends with its tab.
        if (input instanceof TabInputInteractiveWindow) {
          const doc = service.find(keyOfUri(input.uri));
          if (doc) service.close(doc);
          continue;
        }
        if (!(input instanceof TabInputNotebook)) continue;
        const key = keyOfUri(input.uri);
        const stillOpen = host.tabGroups.all.some((group) => group.tabs.some((other) => other.input instanceof TabInputNotebook && keyOfUri(other.input.uri) === key));
        const doc = service.find(key);
        if (doc && !stillOpen && doc.viewed) service.close(doc);
      }
    });
  },

  onViewMessage: (host, payload) => {
    const service = notebookService(host);
    const message = payload as NbViewMessage;
    switch (message.t) {
      case "text": {
        const doc = service.find(message.path);
        if (doc) service.viewText(doc, message.cell, message.value);
        break;
      }
      case "visible":
        service.setVisible(message.path, message.visible);
        break;
      case "focus":
        service.setFocus(message.path);
        break;
      case "selection":
        service.setSelections(message.path, message.selections);
        break;
      case "ranges":
        service.setVisibleRanges(message.path, message.ranges);
        break;
    }
  },

  onViewRequest: (host, method, args) => onRequest(host, method, args),

  tabInput: ({ openerId, uri }) => {
    if (openerId === INTERACTIVE_OPENER_ID) {
      const doc = current?.find(uri);
      const input = doc && current ? inputUriOf(current, doc.viewPath) : undefined;
      return doc && input ? new TabInputInteractiveWindow(doc.uri, input) : undefined;
    }
    if (openerId !== NOTEBOOK_OPENER_ID) return undefined;
    const parsed = uriOfKey(uri);
    return new TabInputNotebook(parsed, current?.find(uri)?.notebookType ?? (current ? current.typeFor(parsed) : DEFAULT_NOTEBOOK_TYPE));
  },
};
