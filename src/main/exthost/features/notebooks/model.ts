import { mkdir, readFile, writeFile } from "fs/promises";
import { basename, dirname } from "path";
import type { NbWireCell, NbWireController, NbWireDoc, NbWireOutput, NbWireStatusItem } from "../../../../shared/notebooks.ts";
import { DEFAULT_NOTEBOOK_TYPE } from "../../../../shared/notebooks.ts";
import { NotebookCellData, NotebookCellKind, NotebookControllerAffinity, NotebookData, NotebookRange } from "../../compat-types.ts";
import { ExtHostDocument, keyOfUri, normalizeKey, uriOfKey } from "../../documents.ts";
import type { ExtensionHost } from "../../host.ts";
import * as T from "../../types.ts";
import { ipynbSerializer } from "./ipynb.ts";
import { NotebookCellOutput, NotebookEdit } from "./types.ts";

/**
 * The extension host's notebook model: documents and cells (vscode.NotebookDocument /
 * NotebookCell), serializers, controllers and cell executions, editors, and the
 * status bar item providers. The window (mainview/features/notebooks) renders a
 * document from snapshots of it and sends the user's edits back; extensions edit it
 * through the API (NotebookEdit in a WorkspaceEdit, executions, ...).
 */

type Json = Record<string, unknown>;

export const CELL_SCHEME = "vscode-notebook-cell";
const MIME_ERROR = "application/vnd.code.notebook.error";

/* ── model ──────────────────────────────────────────────────────────────── */

type OutputItemLike = { mime: string; data: Uint8Array };

export type Serializer = {
  deserializeNotebook(content: Uint8Array, token: T.CancellationToken): NotebookData | PromiseLike<NotebookData>;
  serializeNotebook(data: NotebookData, token: T.CancellationToken): Uint8Array | PromiseLike<Uint8Array>;
};

type SerializerEntry = { serializer: Serializer; options?: Json; extensionId: string };

type StatusProvider = {
  notebookType: string;
  provider: { onDidChangeCellStatusBarItems?: T.Event<void>; provideCellStatusBarItems(cell: unknown, token: T.CancellationToken): unknown };
  extensionId: string;
};

let cellSeq = 0;

class Cell {
  readonly id: string;
  kind: number;
  metadata: Json;
  outputs: NotebookCellOutput[];
  summary: { executionOrder?: number; success?: boolean; timing?: { startTime: number; endTime: number } } | undefined;
  readonly document: ExtHostDocument;
  doc: Doc;
  /** Bumped when the text was changed by the host (the view then applies it). */
  rev = 0;
  state: "idle" | "pending" | "running" = "idle";
  status: NbWireStatusItem[] = [];
  statusRun = 0;
  execution: Execution | null = null;
  facade: Record<string, unknown>;

  constructor(doc: Doc, data: NotebookCellData) {
    this.id = `W${(++cellSeq).toString(36)}`;
    this.doc = doc;
    this.kind = data.kind === NotebookCellKind.Code ? NotebookCellKind.Code : NotebookCellKind.Markup;
    this.metadata = { ...(data.metadata ?? {}) };
    this.outputs = (data.outputs ?? []).map(normalizeOutput);
    const summary = (data as unknown as { executionSummary?: Cell["summary"] }).executionSummary;
    this.summary = summary ? { ...summary } : undefined;
    const uri = doc.uri.with({ scheme: CELL_SCHEME, fragment: this.id });
    this.document = new ExtHostDocument(
      { path: uri.toString(), languageId: data.languageId || (this.kind === NotebookCellKind.Code ? "plaintext" : "markdown"), version: 1, text: data.value ?? "", eol: "LF", dirty: false },
      true,
      async () => doc.service.save(doc),
    );
    this.facade = this.#buildFacade();
  }

  get index(): number {
    return this.doc.cells.indexOf(this);
  }

  #buildFacade(): Record<string, unknown> {
    const cell = this;
    const facade: Record<string, unknown> = {};
    Object.defineProperties(facade, {
      index: { get: () => cell.index, enumerable: true },
      notebook: { get: () => cell.doc.facade, enumerable: true },
      kind: { get: () => cell.kind, enumerable: true },
      document: { get: () => cell.document.toApi(), enumerable: true },
      metadata: { get: () => cell.metadata, enumerable: true },
      outputs: { get: () => [...cell.outputs], enumerable: true },
      executionSummary: { get: () => cell.summary, enumerable: true },
    });
    return facade;
  }
}

class Doc {
  readonly service: NotebookService;
  uri: T.Uri;
  /** The path the window uses for this notebook (its tab). */
  viewPath: string;
  readonly notebookType: string;
  metadata: Json;
  cells: Cell[] = [];
  version = 1;
  dirty = false;
  closed = false;
  untitled: boolean;
  /** An Interactive Window (`interactive.open`): never dirty, its tab shows `title`. */
  interactive = false;
  title: string | undefined;
  /** The window opened it (it wants snapshots). */
  viewed = false;
  controllerId: string | null = null;
  affinity = new Map<string, number>();
  queue: Promise<unknown> = Promise.resolve();
  saving: Promise<boolean> | null = null;
  facade: Record<string, unknown>;
  timer: ReturnType<typeof setTimeout> | null = null;
  statusTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(service: NotebookService, uri: T.Uri, notebookType: string, metadata: Json, untitled: boolean) {
    this.service = service;
    this.uri = uri;
    this.viewPath = keyOfUri(uri);
    this.notebookType = notebookType;
    this.metadata = { ...metadata };
    this.untitled = untitled;
    this.facade = this.#buildFacade();
  }

  #buildFacade(): Record<string, unknown> {
    const doc = this;
    const facade: Record<string, unknown> = {};
    Object.defineProperties(facade, {
      uri: { get: () => doc.uri, enumerable: true },
      notebookType: { get: () => doc.notebookType, enumerable: true },
      version: { get: () => doc.version, enumerable: true },
      isDirty: { get: () => doc.dirty, enumerable: true },
      isUntitled: { get: () => doc.untitled, enumerable: true },
      isClosed: { get: () => doc.closed, enumerable: true },
      metadata: { get: () => doc.metadata, enumerable: true },
      cellCount: { get: () => doc.cells.length, enumerable: true },
    });
    Object.assign(facade, {
      cellAt: (index: number) => {
        const cell = doc.cells[index < 0 ? doc.cells.length + index : index];
        if (!cell) throw new Error(`Invalid index ${index}: the notebook has ${doc.cells.length} cell(s)`);
        return cell.facade;
      },
      getCells: (range?: { start: number; end: number }) => doc.cells.slice(range?.start ?? 0, range?.end ?? doc.cells.length).map((cell) => cell.facade),
      save: () => doc.service.save(doc),
    });
    return facade;
  }
}

class Execution {
  readonly cell: Cell;
  readonly source = new T.CancellationTokenSource();
  controller: Controller;
  ended = false;
  startTime: number | undefined;
  order: number | undefined;
  constructor(cell: Cell, controller: Controller) {
    this.cell = cell;
    this.controller = controller;
  }
}

export class Controller {
  readonly id: string;
  readonly notebookType: string;
  readonly extensionId: string;
  label: string;
  description?: string;
  detail?: string;
  supportedLanguages?: string[];
  supportsExecutionOrder = false;
  executeHandler: (cells: unknown[], notebook: unknown, controller: unknown) => unknown;
  interruptHandler?: (notebook: unknown) => unknown;
  /** Proposed `NotebookController.variableProvider` (the Notebook Variables panel). */
  variableProvider?: { onDidChangeVariables?: T.Event<unknown>; provideVariables(notebook: unknown, parent: unknown, kind: number, start: number, token: unknown): AsyncIterable<unknown> };
  variableSubscription?: T.Disposable;
  readonly onDidChangeSelectedNotebooks = new T.EventEmitter<{ notebook: unknown; selected: boolean }>();
  disposed = false;
  api: Record<string, unknown> = {};

  constructor(id: string, notebookType: string, label: string, extensionId: string, handler: Controller["executeHandler"] | undefined) {
    this.id = id;
    this.notebookType = notebookType;
    this.label = label;
    this.extensionId = extensionId;
    this.executeHandler = handler ?? (() => undefined);
  }

  matches(type: string): boolean {
    return this.notebookType === type || this.notebookType === "*";
  }
}

/* ── helpers ────────────────────────────────────────────────────────────── */

function normalizeOutput(output: unknown): NotebookCellOutput {
  if (output instanceof NotebookCellOutput) return output;
  const like = output as { items?: NotebookCellOutput["items"]; metadata?: Json };
  return new NotebookCellOutput([...(like.items ?? [])], like.metadata);
}

const TEXT_MIME = /^(text\/|application\/(json|javascript|xml|x-latex|x-tex)$|image\/svg\+xml$|application\/vnd\.code\.notebook\.(stdout|stderr|error)$)|\+json$|\+xml$/;

export function wireOutput(output: NotebookCellOutput): NbWireOutput {
  return {
    id: output.id,
    items: output.items.map((item) =>
      TEXT_MIME.test(item.mime) ? { mime: item.mime, data: Buffer.from(item.data).toString("utf8") } : { mime: item.mime, data: Buffer.from(item.data).toString("base64"), base64: true },
    ),
    metadata: output.metadata,
  };
}

/** Does a `contributes.notebooks[].selector` filenamePattern match the file? */
export function globMatches(pattern: string, path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const target = pattern.includes("/") ? normalized : normalized.slice(normalized.lastIndexOf("/") + 1);
  let source = "";
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
    else if (ch === "{") source += "(?:";
    else if (ch === "}") source += ")";
    else if (ch === ",") source += source.lastIndexOf("(?:") > source.lastIndexOf(")") ? "|" : ",";
    else source += ch.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern.includes("/") && !pattern.startsWith("**") && !pattern.startsWith("/") ? "(?:.*/)?" : ""}${source}$`, "i").test(target);
}

const toStatusItem = (item: Json): NbWireStatusItem => {
  const command = item.command;
  return {
    text: String(item.text ?? ""),
    alignment: item.alignment === 2 ? "right" : "left",
    priority: typeof item.priority === "number" ? item.priority : 0,
    tooltip: typeof item.tooltip === "string" ? item.tooltip : undefined,
    command: typeof command === "string" ? { command } : command && typeof command === "object" && typeof (command as Json).command === "string" ? { command: (command as Json).command as string, arguments: (command as Json).arguments as unknown[] | undefined } : undefined,
  };
};

/* ── the service ────────────────────────────────────────────────────────── */

type Editor = { doc: Doc; selections: NotebookRange[]; visibleRanges: NotebookRange[]; views: number; api: Record<string, unknown> };

export class NotebookService {
  readonly host: ExtensionHost;
  readonly serializers = new Map<string, SerializerEntry>();
  readonly controllers = new Map<string, Controller>();
  readonly statusProviders = new Set<StatusProvider>();
  readonly docs = new Map<string, Doc>();
  readonly #opening = new Map<string, Promise<Doc>>();
  readonly #editors = new Map<string, Editor>();
  readonly #statusDirty = new Set<Cell>();
  #focused: string | null = null;
  #order: string[] = [];

  readonly onDidOpen = new T.EventEmitter<unknown>();
  readonly onDidClose = new T.EventEmitter<unknown>();
  readonly onDidChange = new T.EventEmitter<unknown>();
  readonly onWillSave = new T.EventEmitter<unknown>();
  readonly onDidSave = new T.EventEmitter<unknown>();
  readonly onDidChangeActiveEditor = new T.EventEmitter<unknown>();
  readonly onDidChangeVisibleEditors = new T.EventEmitter<unknown>();
  readonly onDidChangeSelection = new T.EventEmitter<unknown>();
  readonly onDidChangeVisibleRanges = new T.EventEmitter<unknown>();

  constructor(host: ExtensionHost) {
    this.host = host;
  }

  /* registrations */

  registerSerializer(extensionId: string, notebookType: string, serializer: Serializer, options?: Json): T.Disposable {
    const entry: SerializerEntry = { serializer, options, extensionId };
    this.serializers.set(notebookType, entry);
    return new T.Disposable(() => {
      if (this.serializers.get(notebookType) === entry) this.serializers.delete(notebookType);
    });
  }

  registerStatusProvider(extensionId: string, notebookType: string, provider: StatusProvider["provider"]): T.Disposable {
    const entry: StatusProvider = { notebookType, provider, extensionId };
    this.statusProviders.add(entry);
    const subscription = provider.onDidChangeCellStatusBarItems?.(() => {
      for (const doc of this.docs.values()) if (this.#providersFor(doc).includes(entry)) this.scheduleStatus(doc, true);
    });
    for (const doc of this.docs.values()) this.scheduleStatus(doc, true);
    return new T.Disposable(() => {
      this.statusProviders.delete(entry);
      subscription?.dispose();
      for (const doc of this.docs.values()) {
        for (const cell of doc.cells) cell.status = [];
        this.scheduleStatus(doc, true);
      }
    });
  }

  createController(extensionId: string, id: string, notebookType: string, label: string, handler?: Controller["executeHandler"]): Record<string, unknown> {
    const service = this;
    const controller = new Controller(id, notebookType, label, extensionId, handler);
    const replaced = this.controllers.get(id);
    if (replaced) this.#disposeController(replaced);
    this.controllers.set(id, controller);
    const changed = () => service.#controllersChanged();
    const api: Record<string, unknown> = {};
    const accessor = <K extends keyof Controller>(key: K, readonly = false) => ({
      get: () => controller[key],
      set: readonly ? undefined : (value: Controller[K]) => {
        controller[key] = value;
        changed();
      },
      enumerable: true,
    });
    Object.defineProperties(api, {
      id: { value: id, enumerable: true },
      notebookType: { value: notebookType, enumerable: true },
      label: accessor("label"),
      description: accessor("description"),
      detail: accessor("detail"),
      supportedLanguages: accessor("supportedLanguages"),
      supportsExecutionOrder: accessor("supportsExecutionOrder"),
      executeHandler: accessor("executeHandler"),
      interruptHandler: accessor("interruptHandler"),
      variableProvider: {
        get: () => controller.variableProvider,
        set: (value: Controller["variableProvider"]) => {
          controller.variableSubscription?.dispose();
          controller.variableProvider = value;
          // The panel reloads the variables of the notebooks this controller runs.
          const event = value?.onDidChangeVariables;
          controller.variableSubscription = typeof event === "function" ? event((notebook) => service.variablesChanged(controller, notebook)) : undefined;
          service.variablesChanged(controller);
        },
        enumerable: true,
      },
      rendererScripts: { value: [], enumerable: true, writable: true },
      onDidChangeSelectedNotebooks: { value: controller.onDidChangeSelectedNotebooks.event, enumerable: true },
    });
    Object.assign(api, {
      updateNotebookAffinity: (notebook: { uri: T.Uri }, affinity: number) => {
        const doc = service.#docOf(notebook.uri);
        if (!doc) return;
        doc.affinity.set(id, affinity);
        if (affinity === NotebookControllerAffinity.Preferred && !doc.controllerId) service.selectController(doc, id);
        changed();
      },
      createNotebookCellExecution: (cell: unknown) => service.createExecution(controller, cell),
      dispose: () => service.#disposeController(controller),
    });
    controller.api = api;
    for (const doc of this.docs.values()) if (!doc.controllerId) this.#autoSelect(doc);
    changed();
    return api;
  }

  #disposeController(controller: Controller): void {
    if (controller.disposed) return;
    controller.disposed = true;
    controller.variableSubscription?.dispose();
    if (this.controllers.get(controller.id) === controller) this.controllers.delete(controller.id);
    for (const doc of this.docs.values()) {
      if (doc.controllerId === controller.id) this.selectController(doc, null);
      for (const cell of doc.cells) if (cell.execution?.controller === controller) this.endExecution(cell.execution, false);
    }
    controller.onDidChangeSelectedNotebooks.dispose();
    this.#controllersChanged();
  }

  #controllersChanged(): void {
    for (const doc of this.docs.values()) this.scheduleSnapshot(doc);
  }

  controllersFor(doc: Doc): Controller[] {
    return [...this.controllers.values()].filter((controller) => controller.matches(doc.notebookType));
  }

  #autoSelect(doc: Doc): void {
    const candidates = this.controllersFor(doc);
    const preferred = candidates.find((controller) => doc.affinity.get(controller.id) === NotebookControllerAffinity.Preferred);
    const chosen = preferred ?? (candidates.length === 1 ? candidates[0] : candidates.find((controller) => doc.affinity.get(controller.id) === NotebookControllerAffinity.Default));
    if (chosen) this.selectController(doc, chosen.id);
  }

  selectController(doc: Doc, id: string | null): void {
    const previous = doc.controllerId ? this.controllers.get(doc.controllerId) : undefined;
    const next = id ? this.controllers.get(id) : undefined;
    if (id && !next) throw new Error(`Unknown notebook controller '${id}'`);
    if (previous === next) return;
    doc.controllerId = next?.id ?? null;
    previous?.onDidChangeSelectedNotebooks.fire({ notebook: doc.facade, selected: false });
    next?.onDidChangeSelectedNotebooks.fire({ notebook: doc.facade, selected: true });
    this.scheduleSnapshot(doc);
  }

  /* documents */

  #docOf(uri: T.Uri | string): Doc | undefined {
    const key = typeof uri === "string" ? uri : keyOfUri(uri);
    const direct = this.docs.get(normalizeKey(key));
    if (direct) return direct;
    // Cell URIs address the notebook they belong to.
    const parsed = typeof uri === "string" ? uriOfKey(uri) : uri;
    if (parsed.scheme === CELL_SCHEME) return this.docs.get(normalizeKey(keyOfUri(parsed.with({ scheme: "file", fragment: "" }))));
    return undefined;
  }

  find(path: string): Doc | undefined {
    const direct = this.docs.get(normalizeKey(path));
    if (direct) return direct;
    // Interactive Windows are shown under a path of their own (untitled paths bypass the window's editor openers).
    for (const doc of this.docs.values()) if (doc.viewPath === path) return doc;
    return undefined;
  }

  get documents(): unknown[] {
    return [...this.docs.values()].map((doc) => doc.facade);
  }

  /** The notebook type a file opens as: a contributed `notebooks` selector, else Jupyter for `.ipynb`. */
  typeFor(uri: T.Uri): string {
    const path = uri.scheme === "file" ? uri.fsPath : uri.path;
    for (const runtime of this.host.runtimes.values()) {
      const contributed = (runtime.description.manifest.contributes as { notebooks?: { type: string; selector?: { filenamePattern?: string }[] }[] } | undefined)?.notebooks;
      for (const entry of contributed ?? []) {
        if (entry.type !== DEFAULT_NOTEBOOK_TYPE && entry.selector?.some((selector) => selector.filenamePattern && globMatches(selector.filenamePattern, path))) return entry.type;
      }
    }
    return DEFAULT_NOTEBOOK_TYPE;
  }

  async #read(uri: T.Uri): Promise<Uint8Array> {
    if (uri.scheme === "file") return await readFile(uri.fsPath);
    return await this.host.fileSystems.api().readFile(uri);
  }

  async #write(uri: T.Uri, content: Uint8Array): Promise<void> {
    if (uri.scheme === "file") {
      await mkdir(dirname(uri.fsPath), { recursive: true });
      await writeFile(uri.fsPath, content);
    } else await this.host.fileSystems.api().writeFile(uri, content);
  }

  serializerFor(type: string): Serializer | undefined {
    return this.serializers.get(type)?.serializer ?? (type === DEFAULT_NOTEBOOK_TYPE ? (ipynbSerializer as unknown as Serializer) : undefined);
  }

  /** Open (or return) the notebook of a file. */
  open(target: T.Uri | string, viewPath?: string): Promise<Doc> {
    const uri = typeof target === "string" ? uriOfKey(target) : target;
    const key = normalizeKey(keyOfUri(uri));
    let pending: Promise<Doc> | undefined = this.docs.has(key) ? Promise.resolve(this.docs.get(key)!) : this.#opening.get(key);
    if (!pending) {
      pending = this.#load(uri).finally(() => this.#opening.delete(key));
      this.#opening.set(key, pending);
    }
    return pending.then((doc) => {
      if (viewPath) doc.viewPath = viewPath;
      return doc;
    });
  }

  async #load(uri: T.Uri): Promise<Doc> {
    const type = this.typeFor(uri);
    await this.host.activateByEvent(`onNotebook:${type}`);
    const serializer = this.serializerFor(type);
    if (!serializer) throw new Error(`No notebook serializer is registered for '${type}'`);
    const data = await serializer.deserializeNotebook(await this.#read(uri), T.CancellationTokenNone);
    return this.#add(uri, type, data, false);
  }

  /** An Interactive Window's notebook (`interactive.open`): in memory, shown under `viewPath`. */
  createInteractive(uri: T.Uri, viewPath: string, title: string): Doc {
    const doc = this.#add(uri, "interactive", new NotebookData([]), true);
    doc.interactive = true;
    doc.viewPath = viewPath;
    doc.title = title;
    return doc;
  }

  /** `workspace.openNotebookDocument(type, content)`: an untitled notebook that lives in memory until it is saved. */
  createUntitled(type: string, data?: NotebookData): Doc {
    let n = 1;
    while (this.docs.has(`untitled:untitled-${n}.ipynb`)) n++;
    return this.#add(T.Uri.from({ scheme: "untitled", path: `Untitled-${n}.ipynb` }), type, data ?? new NotebookData([]), true);
  }

  #add(uri: T.Uri, type: string, data: NotebookData, untitled: boolean): Doc {
    const doc = new Doc(this, uri, type, (data.metadata ?? {}) as Json, untitled);
    doc.cells = (data.cells ?? []).map((cell) => new Cell(doc, cell));
    this.docs.set(normalizeKey(keyOfUri(uri)), doc);
    this.#autoSelect(doc);
    this.onDidOpen.fire(doc.facade);
    this.scheduleStatus(doc, true);
    return doc;
  }

  close(doc: Doc): void {
    if (doc.closed) return;
    doc.closed = true;
    for (const cell of doc.cells) {
      cell.document.isClosed = true;
      if (cell.execution) this.endExecution(cell.execution, false);
    }
    this.docs.delete(normalizeKey(keyOfUri(doc.uri)));
    if (doc.controllerId) this.controllers.get(doc.controllerId)?.onDidChangeSelectedNotebooks.fire({ notebook: doc.facade, selected: false });
    if (this.#editors.delete(normalizeKey(keyOfUri(doc.uri)))) this.#editorsChanged();
    if (doc.timer) clearTimeout(doc.timer);
    if (doc.statusTimer) clearTimeout(doc.statusTimer);
    this.onDidClose.fire(doc.facade);
    if (doc.viewed) this.host.postFeature("notebooks", { t: "closed", path: doc.viewPath });
  }

  /* edits */

  #touch(doc: Doc, dirty = true): void {
    doc.version++;
    if (dirty && !doc.dirty && !doc.interactive) {
      doc.dirty = true;
      this.scheduleSnapshot(doc);
    }
  }

  #fire(doc: Doc, change: { metadata?: Json; contentChanges?: { range: NotebookRange; addedCells: unknown[]; removedCells: unknown[] }[]; cellChanges?: { cell: unknown; document?: unknown; metadata?: Json; outputs?: unknown[]; executionSummary?: unknown }[] }): void {
    this.onDidChange.fire({ notebook: doc.facade, metadata: change.metadata, contentChanges: change.contentChanges ?? [], cellChanges: change.cellChanges ?? [] });
  }

  /** Replace `deleteCount` cells at `start` with cells (new ones from data, or existing ones that move). */
  splice(doc: Doc, start: number, deleteCount: number, insert: (NotebookCellData | Cell)[], options: { keepStatus?: boolean } = {}): void {
    const first = Math.max(0, Math.min(start, doc.cells.length));
    const count = Math.max(0, Math.min(deleteCount, doc.cells.length - first));
    const added = insert.map((item) => (item instanceof Cell ? item : new Cell(doc, item)));
    const removed = doc.cells.splice(first, count, ...added);
    for (const cell of removed) {
      if (cell.execution && !added.includes(cell)) this.endExecution(cell.execution, false);
      if (!added.includes(cell)) cell.document.isClosed = true;
    }
    this.#touch(doc);
    this.#fire(doc, { contentChanges: [{ range: new NotebookRange(first, first + count), addedCells: added.map((cell) => cell.facade), removedCells: removed.map((cell) => cell.facade) }] });
    this.scheduleStatus(doc, false);
    this.scheduleSnapshot(doc);
  }

  /** NotebookEdit entries of a WorkspaceEdit (and what the window asks for). */
  applyEdit(doc: Doc, edit: NotebookEdit): void {
    if (edit.newNotebookMetadata) {
      doc.metadata = { ...edit.newNotebookMetadata };
      this.#touch(doc);
      this.#fire(doc, { metadata: doc.metadata });
      this.scheduleSnapshot(doc);
      return;
    }
    if (edit.newCellMetadata) {
      const cell = doc.cells[edit.range.start];
      if (!cell) throw new Error(`notebook edit: no cell at index ${edit.range.start}`);
      cell.metadata = { ...edit.newCellMetadata };
      this.#touch(doc);
      this.#fire(doc, { cellChanges: [{ cell: cell.facade, metadata: cell.metadata }] });
      this.scheduleSnapshot(doc);
      return;
    }
    if (edit.range.start > doc.cells.length || edit.range.end > doc.cells.length) throw new Error(`notebook edit: range ${edit.range.start}-${edit.range.end} is outside the ${doc.cells.length} cell(s)`);
    this.splice(doc, edit.range.start, edit.range.end - edit.range.start, edit.newCells);
  }

  /** The window changed a cell's text. */
  viewText(doc: Doc, cellId: string, value: string): void {
    const cell = doc.cells.find((candidate) => candidate.id === cellId);
    if (!cell || cell.document.getText() === value) return;
    cell.document.setText(value, cell.document.version + 1);
    cell.document.isDirty = true;
    this.#touch(doc);
    this.#fire(doc, { cellChanges: [{ cell: cell.facade, document: cell.document.toApi() }] });
    this.scheduleStatus(doc, false, cell);
  }

  /** TextEdits of an extension on a cell's document (`vscode-notebook-cell:` URI). */
  applyCellTextEdits(uri: T.Uri, edits: T.TextEdit[]): boolean {
    const doc = this.#docOf(uri);
    const cell = doc?.cells.find((candidate) => candidate.id === uri.fragment);
    if (!doc || !cell) return false;
    const document = cell.document;
    const resolved = edits
      .map((edit) => ({ start: document.offsetAt(edit.range.start), end: document.offsetAt(edit.range.end), text: edit.newText }))
      .sort((a, b) => b.start - a.start || b.end - a.end);
    let text = document.getText();
    for (const edit of resolved) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    document.setText(text, document.version + 1);
    document.isDirty = true;
    cell.rev++;
    this.#touch(doc);
    this.#fire(doc, { cellChanges: [{ cell: cell.facade, document: document.toApi() }] });
    this.scheduleStatus(doc, false, cell);
    this.scheduleSnapshot(doc);
    return true;
  }

  setLanguage(doc: Doc, cell: Cell, languageId: string): void {
    if (cell.document.languageId === languageId) return;
    cell.document.languageId = languageId;
    cell.document.version++;
    this.#touch(doc);
    this.#fire(doc, { cellChanges: [{ cell: cell.facade, document: cell.document.toApi() }] });
    this.scheduleSnapshot(doc);
  }

  setKind(doc: Doc, cell: Cell, kind: number): void {
    if (cell.kind === kind) return;
    const data = new NotebookCellData(kind, cell.document.getText(), kind === NotebookCellKind.Code ? (typeof doc.metadata.language === "string" ? doc.metadata.language : this.#defaultLanguage(doc)) : "markdown");
    data.metadata = cell.metadata;
    this.splice(doc, cell.index, 1, [data]);
  }

  #defaultLanguage(doc: Doc): string {
    const info = (doc.metadata.language_info as Json | undefined)?.name ?? (doc.metadata.kernelspec as Json | undefined)?.language;
    const code = doc.cells.find((cell) => cell.kind === NotebookCellKind.Code);
    return typeof info === "string" ? info.toLowerCase() : (code?.document.languageId ?? "python");
  }

  insertCell(doc: Doc, index: number, kind: number, value = "", languageId?: string): void {
    const data = new NotebookCellData(kind, value, languageId ?? (kind === NotebookCellKind.Code ? this.#defaultLanguage(doc) : "markdown"));
    this.splice(doc, index, 0, [data]);
  }

  moveCell(doc: Doc, cell: Cell, delta: number): void {
    const from = cell.index;
    const to = Math.max(0, Math.min(doc.cells.length - 1, from + delta));
    if (from === to) return;
    doc.cells.splice(from, 1);
    doc.cells.splice(to, 0, cell);
    this.#touch(doc);
    this.#fire(doc, {
      contentChanges: [
        { range: new NotebookRange(from, from + 1), addedCells: [], removedCells: [cell.facade] },
        { range: new NotebookRange(to, to), addedCells: [cell.facade], removedCells: [] },
      ],
    });
    this.scheduleSnapshot(doc);
  }

  clearOutputs(doc: Doc, cells: Cell[]): void {
    const changes = [];
    for (const cell of cells) {
      if (!cell.outputs.length && !cell.summary) continue;
      cell.outputs = [];
      cell.summary = undefined;
      changes.push({ cell: cell.facade, outputs: [] as unknown[], executionSummary: undefined });
    }
    if (!changes.length) return;
    this.#touch(doc);
    this.#fire(doc, { cellChanges: changes });
    this.scheduleSnapshot(doc);
  }

  /* execution */

  createExecution(controller: Controller, cellFacade: unknown): Record<string, unknown> {
    const cell = this.#cellOf(cellFacade);
    if (!cell) throw new Error("createNotebookCellExecution: the cell does not belong to an open notebook");
    if (cell.execution && !cell.execution.ended) throw new Error("NotebookCellExecution has already been created for this cell");
    const execution = new Execution(cell, controller);
    cell.execution = execution;
    const service = this;
    const live = () => {
      if (execution.ended) throw new Error("NotebookCellExecution has already ended");
    };
    const target = (other?: unknown): Cell => {
      const found = other ? service.#cellOf(other) : cell;
      if (!found) throw new Error("the cell does not belong to an open notebook");
      return found;
    };
    const changed = (found: Cell) => {
      service.#touch(found.doc);
      service.#fire(found.doc, { cellChanges: [{ cell: found.facade, outputs: [...found.outputs] }] });
      service.scheduleSnapshot(found.doc);
    };
    const api: Record<string, unknown> = {};
    Object.defineProperties(api, {
      cell: { value: cell.facade, enumerable: true },
      token: { value: execution.source.token, enumerable: true },
      executionOrder: {
        get: () => execution.order,
        set: (value: number | undefined) => {
          execution.order = value;
          cell.summary = { ...cell.summary, executionOrder: value };
          service.scheduleSnapshot(cell.doc);
        },
        enumerable: true,
      },
    });
    Object.assign(api, {
      start: (startTime?: number) => {
        live();
        execution.startTime = startTime ?? Date.now();
        cell.state = "running";
        service.scheduleSnapshot(cell.doc);
      },
      end: (success?: boolean, endTime?: number) => {
        live();
        service.endExecution(execution, success, endTime);
      },
      clearOutput: (other?: unknown) => {
        live();
        const found = target(other);
        found.outputs = [];
        changed(found);
        return Promise.resolve();
      },
      replaceOutput: (output: unknown, other?: unknown) => {
        live();
        const found = target(other);
        found.outputs = ([] as unknown[]).concat(output).map(normalizeOutput);
        changed(found);
        return Promise.resolve();
      },
      appendOutput: (output: unknown, other?: unknown) => {
        live();
        const found = target(other);
        found.outputs.push(...([] as unknown[]).concat(output).map(normalizeOutput));
        changed(found);
        return Promise.resolve();
      },
      replaceOutputItems: (items: unknown, output: NotebookCellOutput) => {
        live();
        output.items = ([] as unknown[]).concat(items) as NotebookCellOutput["items"];
        const found = service.#cellWithOutput(cell.doc, output);
        if (found) changed(found);
        return Promise.resolve();
      },
      appendOutputItems: (items: unknown, output: NotebookCellOutput) => {
        live();
        output.items = [...output.items, ...(([] as unknown[]).concat(items) as NotebookCellOutput["items"])];
        const found = service.#cellWithOutput(cell.doc, output);
        if (found) changed(found);
        return Promise.resolve();
      },
    });
    return api;
  }

  #cellWithOutput(doc: Doc, output: NotebookCellOutput): Cell | undefined {
    return doc.cells.find((cell) => cell.outputs.includes(output));
  }

  #cellOf(facade: unknown): Cell | undefined {
    for (const doc of this.docs.values()) {
      const cell = doc.cells.find((candidate) => candidate.facade === facade);
      if (cell) return cell;
    }
    return undefined;
  }

  endExecution(execution: Execution, success?: boolean, endTime?: number): void {
    if (execution.ended) return;
    execution.ended = true;
    const cell = execution.cell;
    const end = endTime ?? Date.now();
    cell.summary = {
      executionOrder: execution.order ?? cell.summary?.executionOrder,
      success,
      timing: execution.startTime !== undefined ? { startTime: execution.startTime, endTime: end } : undefined,
    };
    cell.state = "idle";
    cell.execution = null;
    execution.source.dispose();
    this.#touch(cell.doc);
    this.#fire(cell.doc, { cellChanges: [{ cell: cell.facade, executionSummary: cell.summary }] });
    this.scheduleStatus(cell.doc, false, cell);
    this.scheduleSnapshot(cell.doc);
  }

  /** Run cells with the selected controller; the handler's promise is not awaited by the caller. */
  run(doc: Doc, cells: Cell[]): void {
    const code = cells.filter((cell) => cell.kind === NotebookCellKind.Code && cell.state === "idle");
    if (!code.length) return;
    const controller = doc.controllerId ? this.controllers.get(doc.controllerId) : undefined;
    if (!controller) throw new Error("No kernel is selected for this notebook");
    for (const cell of code) cell.state = "pending";
    this.scheduleSnapshot(doc);
    doc.queue = doc.queue.then(async () => {
      const alive = code.filter((cell) => cell.doc === doc && !doc.closed && cell.state === "pending");
      try {
        if (alive.length) await controller.executeHandler.call(controller.api, alive.map((cell) => cell.facade), doc.facade, controller.api);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.host.log("error", `notebook execution failed: ${message}`, controller.extensionId);
        void this.host.requestView("showMessage", "error", `Running the notebook failed: ${message}`, [], {}).catch(() => undefined);
        for (const cell of alive) if (cell.execution) this.endExecution(cell.execution, false);
      } finally {
        for (const cell of alive) if (cell.state === "pending") cell.state = "idle";
        this.scheduleSnapshot(doc);
      }
    });
  }

  async interrupt(doc: Doc): Promise<void> {
    const controller = doc.controllerId ? this.controllers.get(doc.controllerId) : undefined;
    for (const cell of doc.cells) if (cell.state === "pending") cell.state = "idle";
    if (controller?.interruptHandler) await controller.interruptHandler.call(controller.api, doc.facade);
    else for (const cell of doc.cells) cell.execution?.source.cancel();
    this.scheduleSnapshot(doc);
  }

  /* save */

  save(doc: Doc): Promise<boolean> {
    doc.saving ??= this.#save(doc).finally(() => (doc.saving = null));
    return doc.saving;
  }

  toData(doc: Doc): NotebookData {
    const cells = doc.cells.map((cell) => {
      const data = new NotebookCellData(cell.kind, cell.document.getText(), cell.document.languageId);
      data.metadata = cell.metadata;
      data.outputs = [...cell.outputs];
      (data as unknown as { executionSummary?: unknown }).executionSummary = cell.summary;
      return data;
    });
    const data = new NotebookData(cells);
    data.metadata = doc.metadata;
    return data;
  }

  async #save(doc: Doc): Promise<boolean> {
    if (doc.closed) return false;
    const serializer = this.serializerFor(doc.notebookType);
    if (!serializer) throw new Error(`No notebook serializer is registered for '${doc.notebookType}'`);
    if (doc.untitled) {
      const chosen = await this.host.requestMain("showSaveDialog", { title: "Save notebook", defaultPath: basename(doc.uri.path) });
      if (!chosen) return false;
      this.docs.delete(normalizeKey(keyOfUri(doc.uri)));
      doc.uri = T.Uri.file(chosen);
      doc.viewPath = keyOfUri(doc.uri);
      doc.untitled = false;
      this.docs.set(normalizeKey(keyOfUri(doc.uri)), doc);
    }
    const waits: Promise<unknown>[] = [];
    this.onWillSave.fire({
      notebook: doc.facade,
      reason: 1,
      waitUntil: (thenable: PromiseLike<unknown>) => {
        waits.push(
          Promise.resolve(thenable).then(async (value) => {
            if (value instanceof T.WorkspaceEdit) {
              const { applyWorkspaceEdit } = await import("../../workspace-edit.ts");
              await applyWorkspaceEdit(this.host, value);
            }
          }),
        );
      },
    });
    if (waits.length) await Promise.race([Promise.allSettled(waits), new Promise((resolve) => setTimeout(resolve, 1500))]);
    const bytes = await serializer.serializeNotebook(this.toData(doc), T.CancellationTokenNone);
    await this.#write(doc.uri, bytes);
    doc.dirty = false;
    for (const cell of doc.cells) cell.document.isDirty = false;
    this.onDidSave.fire(doc.facade);
    this.scheduleSnapshot(doc);
    return true;
  }

  /** Reload the notebook from disk (discarding the changes). */
  async revert(doc: Doc): Promise<void> {
    const serializer = this.serializerFor(doc.notebookType);
    if (!serializer || doc.untitled) return;
    const data = await serializer.deserializeNotebook(await this.#read(doc.uri), T.CancellationTokenNone);
    doc.metadata = { ...((data.metadata ?? {}) as Json) };
    this.splice(doc, 0, doc.cells.length, data.cells ?? []);
    doc.dirty = false;
    this.scheduleSnapshot(doc);
  }

  /* editors */

  #editorFor(doc: Doc): Editor {
    const key = normalizeKey(keyOfUri(doc.uri));
    let editor = this.#editors.get(key);
    if (editor) return editor;
    const service = this;
    const state: Editor = { doc, selections: [new NotebookRange(0, doc.cells.length ? 1 : 0)], visibleRanges: [], views: 0, api: {} };
    Object.defineProperties(state.api, {
      notebook: { get: () => doc.facade, enumerable: true },
      selections: {
        get: () => state.selections,
        set: (value: NotebookRange[]) => {
          state.selections = value.length ? [...value] : [new NotebookRange(0, 0)];
          service.host.postFeature("notebooks", { t: "select", path: doc.viewPath, selections: state.selections.map((range) => [range.start, range.end]) });
          service.onDidChangeSelection.fire({ notebookEditor: state.api, selections: state.selections });
        },
        enumerable: true,
      },
      selection: {
        get: () => state.selections[0],
        set: (value: NotebookRange) => ((state.api as { selections: NotebookRange[] }).selections = [value]),
        enumerable: true,
      },
      visibleRanges: { get: () => state.visibleRanges, enumerable: true },
      viewColumn: { value: T.ViewColumn.One, enumerable: true },
    });
    Object.assign(state.api, {
      revealRange: (range: NotebookRange, type?: number) => service.host.postFeature("notebooks", { t: "reveal", path: doc.viewPath, index: range.start, type: type ?? 0 }),
    });
    editor = state;
    this.#editors.set(key, editor);
    return editor;
  }

  /** A controller's variables changed (`notebook` given: that notebook only): the Notebook Variables panel reloads. */
  variablesChanged(controller: Controller, notebook?: unknown): void {
    for (const doc of this.docs.values()) {
      if (doc.controllerId !== controller.id || (notebook && doc.facade !== notebook)) continue;
      this.host.postFeature("notebooks", { t: "variables", path: doc.viewPath });
    }
  }

  /** The editor of a notebook (an API object), while its tab is shown. */
  editorOf(doc: Doc): Record<string, unknown> | undefined {
    return this.#editors.get(normalizeKey(keyOfUri(doc.uri)))?.api;
  }

  get visibleEditors(): Record<string, unknown>[] {
    return [...this.#editors.values()].filter((editor) => editor.views > 0).map((editor) => editor.api);
  }

  get activeEditor(): Record<string, unknown> | undefined {
    const focused = this.#focused ? this.#editors.get(this.#focused) : undefined;
    return focused && focused.views > 0 ? focused.api : undefined;
  }

  /** A notebook tab is shown (or hidden) in an editor group of the window. */
  setVisible(path: string, visible: boolean): void {
    const doc = this.find(path);
    if (!doc) return;
    const key = normalizeKey(keyOfUri(doc.uri));
    const before = { active: this.activeEditor, visible: this.visibleEditors.length };
    if (visible) {
      const editor = this.#editorFor(doc);
      editor.views++;
      this.#focused = key;
      this.#order = [...this.#order.filter((candidate) => candidate !== key), key];
    } else {
      const editor = this.#editors.get(key);
      if (!editor) return;
      editor.views = Math.max(0, editor.views - 1);
      if (!editor.views) {
        this.#editors.delete(key);
        this.#order = this.#order.filter((candidate) => candidate !== key);
        if (this.#focused === key) this.#focused = this.#order[this.#order.length - 1] ?? null;
      }
    }
    if (before.visible !== this.visibleEditors.length || visible) this.#editorsChanged();
    if (before.active !== this.activeEditor) this.onDidChangeActiveEditor.fire(this.activeEditor);
  }

  #editorsChanged(): void {
    this.onDidChangeVisibleEditors.fire(this.visibleEditors);
  }

  setFocus(path: string): void {
    const doc = this.find(path);
    const key = doc && normalizeKey(keyOfUri(doc.uri));
    if (!key || !this.#editors.has(key) || this.#focused === key) return;
    const before = this.activeEditor;
    this.#focused = key;
    if (before !== this.activeEditor) this.onDidChangeActiveEditor.fire(this.activeEditor);
  }

  setSelections(path: string, ranges: [number, number][]): void {
    const doc = this.find(path);
    const editor = doc && this.#editors.get(normalizeKey(keyOfUri(doc.uri)));
    if (!editor || !ranges.length) return;
    editor.selections = ranges.map(([start, end]) => new NotebookRange(start, end));
    this.onDidChangeSelection.fire({ notebookEditor: editor.api, selections: editor.selections });
  }

  setVisibleRanges(path: string, ranges: [number, number][]): void {
    const doc = this.find(path);
    const editor = doc && this.#editors.get(normalizeKey(keyOfUri(doc.uri)));
    if (!editor) return;
    editor.visibleRanges = ranges.map(([start, end]) => new NotebookRange(start, end));
    this.onDidChangeVisibleRanges.fire({ notebookEditor: editor.api, visibleRanges: editor.visibleRanges });
  }

  /* status bar items */

  #providersFor(doc: Doc): StatusProvider[] {
    return [...this.statusProviders].filter((entry) => entry.notebookType === doc.notebookType || entry.notebookType === "*");
  }

  scheduleStatus(doc: Doc, all: boolean, cell?: Cell): void {
    if (doc.closed || !this.#providersFor(doc).length) return;
    if (doc.statusTimer) clearTimeout(doc.statusTimer);
    const dirty = this.#statusDirty;
    if (all || !cell) for (const candidate of doc.cells) dirty.add(candidate);
    else dirty.add(cell);
    doc.statusTimer = setTimeout(() => {
      doc.statusTimer = null;
      const cells = [...dirty].filter((candidate) => candidate.doc === doc);
      for (const candidate of cells) dirty.delete(candidate);
      void this.#refreshStatus(doc, cells);
    }, 100);
  }

  async #refreshStatus(doc: Doc, cells: Cell[]): Promise<void> {
    const providers = this.#providersFor(doc);
    await Promise.all(
      cells.map(async (cell) => {
        const run = ++cell.statusRun;
        const items: NbWireStatusItem[] = [];
        for (const entry of providers) {
          try {
            const source = new T.CancellationTokenSource();
            const result = await entry.provider.provideCellStatusBarItems(cell.facade, source.token);
            source.dispose();
            for (const item of ([] as unknown[]).concat(result ?? [])) if (item && typeof item === "object") items.push(toStatusItem(item as Json));
          } catch (error) {
            this.host.log("warning", `notebook cell status bar provider failed: ${error instanceof Error ? error.message : error}`, entry.extensionId);
          }
        }
        if (run === cell.statusRun) cell.status = items;
      }),
    );
    if (!doc.closed) this.scheduleSnapshot(doc);
  }

  /* snapshots */

  wire(doc: Doc, error?: string): NbWireDoc {
    const controllers: NbWireController[] = this.controllersFor(doc).map((controller) => ({ id: controller.id, label: controller.label, description: controller.description, detail: controller.detail }));
    return {
      path: doc.viewPath,
      title: doc.title,
      notebookType: doc.notebookType,
      version: doc.version,
      dirty: doc.dirty,
      metadata: doc.metadata,
      cells: doc.cells.map((cell): NbWireCell => ({
        id: cell.id,
        kind: cell.kind === NotebookCellKind.Code ? 2 : 1,
        languageId: cell.document.languageId,
        value: cell.document.getText(),
        rev: cell.rev,
        outputs: cell.outputs.map(wireOutput),
        metadata: cell.metadata,
        state: cell.state,
        executionOrder: cell.summary?.executionOrder,
        success: cell.summary?.success,
        durationMs: cell.summary?.timing ? cell.summary.timing.endTime - cell.summary.timing.startTime : undefined,
        status: cell.status,
      })),
      controller: controllers.find((controller) => controller.id === doc.controllerId) ?? null,
      controllers,
      error,
    };
  }

  scheduleSnapshot(doc: Doc): void {
    if (!doc.viewed || doc.closed || doc.timer) return;
    doc.timer = setTimeout(() => {
      doc.timer = null;
      if (!doc.closed) this.host.postFeature("notebooks", { t: "doc", doc: this.wire(doc) });
    }, 30);
  }

  /** Used by the tests and `showNotebookDocument`: the window path of a document. */
  viewPathOf(doc: Doc): string {
    return doc.viewPath;
  }
}

export type { Cell, Doc };
export { MIME_ERROR };

const services = new WeakMap<ExtensionHost, NotebookService>();

export function notebookService(host: ExtensionHost): NotebookService {
  let service = services.get(host);
  if (!service) {
    service = new NotebookService(host);
    services.set(host, service);
  }
  return service;
}
