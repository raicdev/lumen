/**
 * Wire format of the notebooks area between the extension host
 * (main/exthost/features/notebooks) and the window (mainview/features/notebooks).
 * Plain JSON; no imports, so both sides can use it.
 */

export const NOTEBOOK_OPENER_ID = "notebooks.editor";
export const DEFAULT_NOTEBOOK_TYPE = "jupyter-notebook";

/** An output item: text is sent as is, binary data (images, ...) as base64. */
export type NbWireOutputItem = { mime: string; data: string; base64?: boolean };

export type NbWireOutput = { id: string; items: NbWireOutputItem[]; metadata?: Record<string, unknown> };

export type NbCellState = "idle" | "pending" | "running";

export type NbWireStatusItem = {
  text: string;
  alignment: "left" | "right";
  priority: number;
  tooltip?: string;
  command?: { command: string; arguments?: unknown[] };
};

export type NbWireCell = {
  id: string;
  /** 1 = markup, 2 = code (vscode.NotebookCellKind). */
  kind: 1 | 2;
  languageId: string;
  value: string;
  /** Bumped when the host changed the text (edits of extensions); the view applies `value` then. */
  rev: number;
  outputs: NbWireOutput[];
  metadata: Record<string, unknown>;
  state: NbCellState;
  executionOrder?: number;
  success?: boolean;
  /** Duration of the last execution. */
  durationMs?: number;
  status: NbWireStatusItem[];
};

export type NbWireController = { id: string; label: string; description?: string; detail?: string };

export type NbWireDoc = {
  path: string;
  /** The tab title of an Interactive Window. */
  title?: string;
  notebookType: string;
  version: number;
  dirty: boolean;
  metadata: Record<string, unknown>;
  cells: NbWireCell[];
  /** The selected controller (kernel). */
  controller: NbWireController | null;
  /** Controllers that can run this notebook. */
  controllers: NbWireController[];
  error?: string;
};

/** Host to window (`host.postFeature`). */
export type NbHostMessage =
  | { t: "doc"; doc: NbWireDoc }
  | { t: "closed"; path: string }
  /** Scroll a cell into view (NotebookEditor.revealRange). */
  | { t: "reveal"; path: string; index: number; type: number }
  /** Select cells (NotebookEditor.selections). */
  | { t: "select"; path: string; selections: [number, number][] }
  /** The variables of the notebook's controller changed (the Notebook Variables panel reloads). */
  | { t: "variables"; path: string };

/** Window to host (`api.sendToHost`). */
export type NbViewMessage =
  | { t: "text"; path: string; cell: string; value: string }
  | { t: "visible"; path: string; visible: boolean }
  | { t: "focus"; path: string }
  | { t: "selection"; path: string; selections: [number, number][] }
  | { t: "ranges"; path: string; ranges: [number, number][] };

/** Window to host requests (`api.requestHost`): method name and the arguments. */
export type NbRequest =
  | { method: "open"; args: [path: string] }
  | { method: "save"; args: [path: string] }
  | { method: "run"; args: [path: string, cells: string[] | "all" | "above" | "below", from?: string] }
  | { method: "interrupt"; args: [path: string] }
  | { method: "selectController"; args: [path: string, id: string] }
  | { method: "insert"; args: [path: string, index: number, kind: 1 | 2, value?: string, languageId?: string] }
  | { method: "delete"; args: [path: string, cell: string] }
  | { method: "move"; args: [path: string, cell: string, delta: number] }
  | { method: "setKind"; args: [path: string, cell: string, kind: 1 | 2] }
  | { method: "setLanguage"; args: [path: string, cell: string, languageId: string] }
  | { method: "clearOutputs"; args: [path: string, cell?: string] }
  | { method: "revert"; args: [path: string] }
  /** Interactive Window: append the input as a code cell and run it. */
  | { method: "interactiveExecute"; args: [path: string, code: string] }
  /** One level of the Notebook Variables panel: the globals, or a variable's children (kind 1 named, 2 indexed from `start`). */
  | { method: "variables"; args: [path: string, parent: string | undefined, kind: 1 | 2, start: number] };

/** Interactive Windows: their notebooks are shown under `lumen-interactive:<n>` (untitled paths bypass editor openers). */
export const INTERACTIVE_VIEW_PREFIX = "lumen-interactive:";
export const INTERACTIVE_TYPE = "interactive";
/** The window's editor opener of Interactive Windows. */
export const INTERACTIVE_OPENER_ID = "notebooks.interactive";

/** A variable of the Notebook Variables panel (`handle`: its children, its menu argument). */
export type NbVariableWire = {
  handle: string;
  name: string;
  value: string;
  type?: string;
  expression?: string;
  language?: string;
  hasNamedChildren: boolean;
  indexedChildrenCount: number;
};
