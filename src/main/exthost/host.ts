import * as workerThreadsModule from "worker_threads";
import { parentPort } from "worker_threads";
import Module from "module";
import { ChildProcess } from "child_process";
import { createHash, randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { readdir, stat } from "fs/promises";
import { hostname, userInfo } from "os";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { matchesSelector, matchGlob } from "../../shared/glob.ts";
import { parseJsonc } from "../../shared/jsonc.ts";
import type { ColorThemeKind } from "../../shared/color-theme.ts";
import { customEditorContributions, wireLanguageConfiguration } from "../../shared/extensions.ts";
import type {
  ConfigSnapshot,
  ExtensionDescription,
  HostCodeAction,
  HostCodeLens,
  HostColor,
  HostColorInformation,
  HostColorPresentation,
  HostCompletionItem,
  HostDocumentFilter,
  HostDocumentHighlight,
  HostDocumentLink,
  HostFileOperation,
  HostFoldingRange,
  HostHover,
  HostInlayHint,
  HostInlineCompletionItem,
  HostLanguageConfiguration,
  HostLinkedEditingRanges,
  HostLocation,
  HostMethods,
  HostPrepareRename,
  HostProvider,
  HostRenameEdits,
  HostSelection,
  HostSemanticToken,
  HostSignatureHelp,
  HostToView,
  HostWorkspaceSymbol,
  MainMethods,
  ProviderKind,
  ViewMethods,
  ViewToHost,
} from "../../shared/extensions.ts";
import type { Diagnostic as WireDiagnostic, DocumentSymbol as WireSymbol, FileEdits as WireFileEdits, TextEdit as WireTextEdit, TextRange } from "../../shared/types.ts";
import { detectLanguage, firstLineOf, setContributedLanguages } from "../language.ts";
import { createApi, createEditorFacade } from "./api.ts";
import { NOT_HANDLED, featureByArea, featureCommandIds, hostFeatures } from "./features/registry.ts";
import { CustomEditorManager } from "./custom-editors.ts";
import { DebugSessionManager } from "./debug.ts";
import { ExtHostDocument, keyOfUri, normalizeKey, uriOfKey } from "./documents.ts";
import { FileSystems, messageOf } from "./filesystems.ts";
import { ContentProviders } from "./content-providers.ts";
import { FileDecorations } from "./file-decorations.ts";
import { TabGroups } from "./tabs.ts";
import { TreeViewManager } from "./trees.ts";
import { WebviewManager } from "./webviews.ts";
import { applyWorkspaceEdit, wireWorkspaceEdit } from "./workspace-edit.ts";
import type { HostInit, HostToMain, MainToHost } from "./protocol.ts";
import * as T from "./types.ts";
import { logTimestamp, markdownOf, toWire, wireDiagnostic, wireEdit, wireRange } from "./wire.ts";

/**
 * The extension host: runs in a worker thread of the main process, loads the
 * enabled extensions (CommonJS or ESM) with `require("lumen")` /
 * `require("vscode")` resolving to the extension API, activates them on their
 * activation events and serves the view's requests (commands, completions,
 * hovers, …). Everything the API needs from the window goes to the view as
 * messages, relayed by the main thread.
 */

export type ExtensionRuntime = {
  id: string;
  description: ExtensionDescription;
  api: Record<string, unknown> | null;
  activated: boolean;
  activating: Promise<void> | null;
  exports: unknown;
  module: { deactivate?: () => unknown } | null;
  context: { subscriptions: { dispose(): unknown }[] } | null;
  error?: string;
  activationEvents: string[];
};

type ProviderEntry = HostProvider & {
  provider: Record<string, (...args: unknown[]) => unknown>;
  /** The extra registration argument (semantic tokens legend, code action metadata, …); stays in the host. */
  metadata?: unknown;
};

/** A workspace symbol as a provider returns it (SymbolInformation, or a WorkspaceSymbol without a range). */
type WorkspaceSymbolLike = { name: string; kind: number; containerName?: string; location?: { uri: T.Uri; range?: T.Range } };

type EditorState = {
  key: string;
  selections: T.Selection[];
  facade: Record<string, unknown> | null;
  /** Visible ranges as the view last reported them (scrolling). */
  visibleRanges?: TextRange[];
  /** Indentation overrides set through `TextEditor.options`. */
  options?: { tabSize: number; insertSpaces: boolean };
};

type FileWatcher = {
  matches: (path: string) => boolean;
  /** A change of a provided file system (workspace.createFileSystemWatcher of a provider scheme). */
  matchesUri: (uri: T.Uri) => boolean;
  create: T.EventEmitter<T.Uri> | null;
  change: T.EventEmitter<T.Uri> | null;
  delete: T.EventEmitter<T.Uri> | null;
};

const API_GLOBAL = Symbol.for("lumen.extensionApi");
const WORKER_THREADS_GLOBAL = Symbol.for("lumen.workerThreads");
const DEFAULT_EXCLUDES = ["**/.git", "**/node_modules", "**/.svn", "**/.hg", "**/CVS", "**/.DS_Store", "**/Thumbs.db"];

const COMPLETION_TYPES = [
  "text", "method", "function", "function", "property", "variable", "class", "interface", "namespace", "property",
  "constant", "constant", "enum", "keyword", "snippet", "constant", "text", "variable", "namespace", "enum",
  "constant", "class", "property", "keyword", "type", "text", "text",
];

const SYMBOL_KINDS = [
  "file", "module", "module", "module", "class", "method", "property", "property", "constructor", "enum",
  "interface", "function", "variable", "constant", "constant", "constant", "constant", "variable", "variable", "property",
  "constant", "enumMember", "class", "property", "function", "type",
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ExtensionHost {
  init!: HostInit;
  readonly sessionId = randomUUID();
  readonly machineId = createHash("sha256").update(`${hostname()}:${userInfo().username}`).digest("hex");
  runtimes = new Map<string, ExtensionRuntime>();
  readonly commands = new Map<string, { callback: (...args: unknown[]) => unknown; thisArg: unknown; extensionId: string }>();
  readonly providers = new Map<number, ProviderEntry>();
  readonly documents = new Map<string, ExtHostDocument>();
  readonly editors = new Map<string, EditorState>();
  activeEditorKey: string | null = null;
  visibleEditorKeys: string[] = [];
  config: ConfigSnapshot = { lumen: {}, user: {} };
  configDefaults: Record<string, unknown> = {};
  /** contributes.configurationDefaults: win over the defaults declared by the settings' own extension. */
  configDefaultOverrides: Record<string, unknown> = {};
  workspace: string | null = null;
  focused = true;
  readonly diagnostics = new Map<string, Map<string, { uri: T.Uri; list: T.Diagnostic[] }>>();
  readonly watchers = new Set<FileWatcher>();
  readonly contextKeys = new Map<string, unknown>();
  /** Language contributions: file extension / name → language id. */
  readonly languageIds = new Set<string>();
  #providerSeq = 0;
  /** The links last returned for a document, so resolveDocumentLink can reach their provider. */
  #documentLinks = new Map<string, { entry: ProviderEntry; link: T.DocumentLink }[]>();
  #workspaceSymbolSeq = 0;
  /** The symbols of the last workspace symbol query, so resolveWorkspaceSymbol can reach their provider. */
  #workspaceSymbols = new Map<number, { entry: ProviderEntry; symbol: WorkspaceSymbolLike }>();
  /** onDidChange subscriptions of registered providers, keyed by provider id (the view is told to ask again). */
  readonly #providerChanges = new Map<number, { dispose(): unknown }>();
  #codeLensSeq = 0;
  /** Commands of the code lenses handed to the view, keyed by the id it was given. */
  readonly #codeLensCommands = new Map<string, { path: string; command: T.Command }>();
  #codeActionSeq = 0;
  /** Code actions handed to the view, keyed by the id it was given (their edits stay in the host). */
  readonly #codeActions = new Map<string, { path: string; entry: ProviderEntry; action: T.CodeAction }>();
  #requestSeq = 0;
  #untitledSeq = 0;
  #viewRequests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #mainRequests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #providersPosted = false;
  #commandsPosted = false;
  #output = new Map<string, string>();
  #outputScheduled = false;
  readonly #fired = new Set<string>();

  readonly onDidOpenTextDocument = new T.EventEmitter<unknown>();
  readonly onDidCloseTextDocument = new T.EventEmitter<unknown>();
  readonly onDidChangeTextDocument = new T.EventEmitter<unknown>();
  readonly onDidSaveTextDocument = new T.EventEmitter<unknown>();
  readonly onDidChangeActiveTextEditor = new T.EventEmitter<unknown>();
  readonly onDidChangeVisibleTextEditors = new T.EventEmitter<unknown>();
  readonly onDidChangeTextEditorSelection = new T.EventEmitter<unknown>();
  readonly onDidChangeTextEditorVisibleRanges = new T.EventEmitter<unknown>();
  readonly onDidChangeTextEditorOptions = new T.EventEmitter<unknown>();
  readonly onWillSaveTextDocument = new T.EventEmitter<unknown>();
  readonly onDidChangeConfiguration = new T.EventEmitter<unknown>();
  /** window.activeColorTheme.kind, from the view. */
  colorThemeKind: number = T.ColorThemeKind.Dark;
  readonly onDidChangeActiveColorTheme = new T.EventEmitter<{ kind: number }>();
  readonly onDidChangeWorkspaceFolders = new T.EventEmitter<unknown>();
  readonly onDidChangeDiagnostics = new T.EventEmitter<unknown>();
  readonly onDidChangeWindowState = new T.EventEmitter<unknown>();
  readonly onDidChangeExtensions = new T.EventEmitter<void>();
  readonly onWillCreateFiles = new T.EventEmitter<unknown>();
  readonly onWillDeleteFiles = new T.EventEmitter<unknown>();
  readonly onWillRenameFiles = new T.EventEmitter<unknown>();
  readonly onDidCreateFiles = new T.EventEmitter<unknown>();
  readonly onDidDeleteFiles = new T.EventEmitter<unknown>();
  readonly onDidRenameFiles = new T.EventEmitter<unknown>();
  readonly onDidOpenTerminal = new T.EventEmitter<unknown>();
  readonly onDidCloseTerminal = new T.EventEmitter<unknown>();
  readonly onDidChangeActiveTerminal = new T.EventEmitter<unknown>();
  /** `window.activeTerminal` (the facade of the view's active terminal, if an extension made it). */
  activeTerminal: Record<string, unknown> | undefined;
  activeTerminalId: string | null = null;
  /** Live quick picks / input boxes by id (createQuickPick, showInputBox validation). */
  readonly quickInputs = new Map<number, (event: Extract<ViewToHost, { type: "quickPickEvent" | "inputBoxValue" }>) => void>();
  /** Terminals created by extensions, by view terminal id. */
  readonly terminals = new Map<string, { facade: Record<string, unknown>; closed: () => void }>();
  readonly webviews = new WebviewManager(this);
  readonly customEditors = new CustomEditorManager(this);
  readonly trees = new TreeViewManager(this);
  readonly fileSystems = new FileSystems(this);
  readonly contentProviders = new ContentProviders(this);
  readonly fileDecorations = new FileDecorations(this);
  readonly tabGroups = new TabGroups(this);
  readonly debug = new DebugSessionManager(this);

  /* ── transport ───────────────────────────────────────────────────────── */

  send(message: HostToMain): void {
    parentPort?.postMessage(message);
  }

  post(message: HostToView): void {
    this.send({ type: "view", message });
  }

  requestView<M extends keyof ViewMethods>(method: M, ...args: Parameters<ViewMethods[M]>): Promise<ReturnType<ViewMethods[M]>> {
    const id = ++this.#requestSeq;
    return new Promise((resolvePromise, reject) => {
      this.#viewRequests.set(id, { resolve: resolvePromise as (value: unknown) => void, reject });
      this.post({ type: "request", id, method, args: toWire(args) as unknown[] });
    });
  }

  requestMain<M extends keyof MainMethods>(method: M, ...args: Parameters<MainMethods[M]>): Promise<ReturnType<MainMethods[M]>> {
    const id = ++this.#requestSeq;
    return new Promise((resolvePromise, reject) => {
      this.#mainRequests.set(id, { resolve: resolvePromise as (value: unknown) => void, reject });
      this.send({ type: "mainRequest", id, method, args: toWire(args) as unknown[] });
    });
  }

  nextId(): number {
    return ++this.#requestSeq;
  }

  /** A message to the view feature of `area` (mainview/features/<area>.tsx, `onHostMessage`). */
  postFeature(area: string, payload: unknown): void {
    this.post({ type: "feature", area, payload: toWire(payload) });
  }

  /** A request to the view feature of `area` (`onHostRequest`); resolves with its answer. */
  requestFeatureView(area: string, method: string, args: unknown[] = []): Promise<unknown> {
    return this.requestView("feature", area, method, args);
  }

  /* ── logging & output ─────────────────────────────────────────────────── */

  /** Append to an output channel (batched per tick). */
  appendOutput(channel: string, text: string, extensionId?: string, log = false): void {
    const key = JSON.stringify([channel, extensionId ?? null, log]);
    this.#output.set(key, (this.#output.get(key) ?? "") + text);
    if (this.#outputScheduled) return;
    this.#outputScheduled = true;
    queueMicrotask(() => this.flushOutput());
  }

  flushOutput(): void {
    this.#outputScheduled = false;
    for (const [key, text] of this.#output) {
      const [channel, extensionId, log] = JSON.parse(key) as [string, string | null, boolean];
      this.post({ type: "output", channel, extensionId: extensionId ?? undefined, op: "append", text, log });
    }
    this.#output.clear();
  }

  log(level: "trace" | "debug" | "info" | "warning" | "error", message: string, extensionId?: string): void {
    const stamp = logTimestamp();
    this.appendOutput("Extension Host", `${stamp} [${level}] ${extensionId ? `[${extensionId}] ` : ""}${message}\n`, undefined, true);
    if (level === "error") consoleOriginal.error(`[exthost] ${extensionId ?? ""} ${message}`);
  }

  /* ── startup ─────────────────────────────────────────────────────────── */

  async start(init: HostInit): Promise<void> {
    this.init = init;
    this.config = init.config;
    this.workspace = init.workspace;
    for (const language of init.languages) this.languageIds.add(language);
    const languageConfigurations: { languageId: string; config: HostLanguageConfiguration }[] = [];
    for (const description of init.extensions) {
      const manifest = description.manifest;
      const runtime: ExtensionRuntime = {
        id: description.id,
        description,
        api: null,
        activated: false,
        activating: null,
        exports: undefined,
        module: null,
        context: null,
        activationEvents: this.#activationEvents(description),
      };
      this.runtimes.set(description.id.toLowerCase(), runtime);
      for (const section of [manifest.contributes?.configuration ?? []].flat()) {
        for (const [key, property] of Object.entries(section.properties ?? {})) {
          if (property.default !== undefined) this.configDefaults[key] = property.default;
        }
      }
      // contributes.configurationDefaults override defaults of other extensions' and Lumen's settings
      for (const [key, value] of Object.entries((manifest.contributes as { configurationDefaults?: Record<string, unknown> } | undefined)?.configurationDefaults ?? {})) {
        const current = this.configDefaultOverrides[key];
        this.configDefaultOverrides[key] =
          key.startsWith("[") && current && typeof current === "object" && value && typeof value === "object" ? { ...current, ...value } : value;
      }
      for (const language of manifest.contributes?.languages ?? []) {
        this.languageIds.add(language.id);
        if (language.configuration) {
          const config = this.#loadLanguageConfiguration(description.location, language.configuration);
          if (config) languageConfigurations.push({ languageId: language.id, config });
        }
      }
    }
    setContributedLanguages(init.extensions.flatMap((description) => description.manifest.contributes?.languages ?? []));
    installModuleHooks(this);
    this.log("info", `Extension host started with ${init.extensions.length} extension(s)`);
    this.post({ type: "ready", extensions: init.extensions });
    this.debug.loadState();
    for (const feature of hostFeatures) {
      try {
        feature.init?.(this);
      } catch (error) {
        this.log("error", `feature '${feature.area}' failed to start: ${errorMessage(error)}`);
      }
    }
    if (featureCommandIds().length) this.postCommands();
    // Contributed language-configuration.json files, after `ready` so the view keeps them.
    for (const entry of languageConfigurations) this.post({ type: "languageConfiguration", languageId: entry.languageId, config: entry.config });
    await this.activateByEvent("*");
    await this.activateByEvent("onFileSystem:file");
    void this.#checkWorkspaceContains();
  }

  #activationEvents(description: ExtensionDescription): string[] {
    const manifest = description.manifest;
    const events = new Set(manifest.activationEvents ?? []);
    // Implicit events (VS Code ≥ 1.74): contributed commands and languages.
    for (const command of [manifest.contributes?.commands ?? []].flat()) events.add(`onCommand:${command.command}`);
    for (const language of manifest.contributes?.languages ?? []) events.add(`onLanguage:${language.id}`);
    // Walkthrough activation is `onWalkthrough:<walkthrough id>` in VS Code (the contribution point generates it).
    for (const walkthrough of [manifest.contributes?.walkthroughs ?? []].flat()) {
      const id = (walkthrough as { id?: unknown } | null)?.id;
      if (typeof id === "string" && id) events.add(`onWalkthrough:${id}`);
    }
    for (const views of Object.values((manifest.contributes?.views ?? {}) as Record<string, { id?: string }[]>)) {
      for (const view of views ?? []) if (view?.id) events.add(`onView:${view.id}`);
    }
    for (const editor of customEditorContributions(description.id, manifest.contributes)) events.add(`onCustomEditor:${editor.viewType}`);
    // contributes.debuggers activates on resolve / dynamic configurations for its type.
    for (const debugger_ of [(manifest.contributes as { debuggers?: unknown } | undefined)?.debuggers ?? []].flat()) {
      const type = (debugger_ as { type?: unknown } | null)?.type;
      if (typeof type === "string" && type) {
        events.add(`onDebugResolve:${type}`);
        events.add(`onDebugDynamicConfigurations:${type}`);
      }
    }
    return [...events];
  }

  /** Language id of a file: contributed associations first, then Lumen's own (the text's first line for `firstLine`). */
  languageOf(path: string, text?: string): string {
    return detectLanguage(path, text === undefined ? undefined : firstLineOf(text));
  }

  /** Read a language contribution's `configuration` file (JSON with comments allowed). */
  #loadLanguageConfiguration(location: string, configuration: string): HostLanguageConfiguration | null {
    try {
      const file = resolve(location, configuration);
      if (!existsSync(file)) return null;
      return wireLanguageConfiguration(parseJsonc(readFileSync(file, "utf8")));
    } catch (error) {
      this.log("warning", `could not read language configuration ${configuration}: ${errorMessage(error)}`);
      return null;
    }
  }

  /* ── activation ──────────────────────────────────────────────────────── */

  async activateByEvent(event: string): Promise<void> {
    const matching = [...this.runtimes.values()].filter(
      (runtime) =>
        !runtime.activated &&
        runtime.activationEvents.some((candidate) => candidate === event || (event.startsWith("onLanguage:") && candidate === "onLanguage")),
    );
    if (event === "onStartupFinished" || event === "*") this.#fired.add(event);
    await Promise.all(matching.map((runtime) => this.activate(runtime, event)));
  }

  activate(runtime: ExtensionRuntime, reason: string): Promise<void> {
    if (runtime.activated) return Promise.resolve();
    runtime.activating ??= this.#doActivate(runtime, reason);
    return runtime.activating;
  }

  async #doActivate(runtime: ExtensionRuntime, reason: string): Promise<void> {
    const { manifest, location } = runtime.description;
    for (const dependency of manifest.extensionDependencies ?? []) {
      const other = this.runtimes.get(dependency.toLowerCase());
      if (other) await this.activate(other, `dependency of ${runtime.id}`);
      else if (!dependency.startsWith("vscode.")) this.log("warning", `missing dependency ${dependency}`, runtime.id);
    }
    const started = performance.now();
    if (!manifest.main) {
      runtime.activated = true;
      return;
    }
    try {
      const entry = resolveEntry(location, manifest.main);
      runtime.module = (await loadModule(entry)) as ExtensionRuntime["module"];
      const context = this.#createContext(runtime);
      runtime.context = context;
      const exported = runtime.module as { activate?: (context: unknown) => unknown; default?: { activate?: (context: unknown) => unknown } } | null;
      const activateFn = exported?.activate ?? exported?.default?.activate;
      runtime.exports = activateFn ? await activateFn.call(exported, context) : undefined;
      runtime.activated = true;
      const ms = Math.round(performance.now() - started);
      this.log("info", `activated (${reason}) in ${ms} ms`, runtime.id);
      this.post({ type: "activated", extensionId: runtime.id, ms });
    } catch (error) {
      // Like VS Code, a failed activation is not retried (half-registered commands would clash).
      runtime.error = errorMessage(error);
      this.log("error", `activation failed: ${error instanceof Error ? (error.stack ?? error.message) : error}`, runtime.id);
      this.post({ type: "activated", extensionId: runtime.id, ms: Math.round(performance.now() - started), error: runtime.error });
      this.post({ type: "message", kind: "error", message: `Activating extension '${runtime.id}' failed: ${runtime.error}`, extensionId: runtime.id });
    }
    this.onDidChangeExtensions.fire();
  }

  async deactivateAll(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      if (!runtime.activated) continue;
      try {
        await Promise.race([runtime.module?.deactivate?.(), new Promise((r) => setTimeout(r, 2000))]);
      } catch (error) {
        this.log("warning", `deactivate failed: ${errorMessage(error)}`, runtime.id);
      }
      for (const disposable of runtime.context?.subscriptions ?? []) {
        try {
          disposable?.dispose();
        } catch {
          /* keep disposing the rest */
        }
      }
    }
    this.flushOutput();
  }

  runtimeForFile(file: string | undefined | null): ExtensionRuntime | null {
    if (!file) return null;
    const path = normalizeKey(file.startsWith("file:") ? fileURLToPath(file) : file);
    let best: ExtensionRuntime | null = null;
    for (const runtime of this.runtimes.values()) {
      const root = normalizeKey(runtime.description.location);
      if (path === root || path.startsWith(root + (process.platform === "win32" ? "\\" : "/"))) {
        if (!best || root.length > normalizeKey(best.description.location).length) best = runtime;
      }
    }
    return best;
  }

  apiFor(runtime: ExtensionRuntime | null): Record<string, unknown> {
    if (!runtime) {
      this.#anonymousApi ??= createApi(this, null);
      return this.#anonymousApi;
    }
    runtime.api ??= createApi(this, runtime);
    return runtime.api;
  }
  #anonymousApi: Record<string, unknown> | null = null;

  /* ── extension context ───────────────────────────────────────────────── */

  storagePaths(runtime: ExtensionRuntime) {
    const id = runtime.id.toLowerCase();
    const root = this.init.userData;
    const workspaceHash = this.workspace
      ? createHash("sha1").update(process.platform === "win32" ? this.workspace.toLowerCase() : this.workspace).digest("hex").slice(0, 20)
      : null;
    return {
      global: join(root, "globalStorage", id),
      workspace: workspaceHash ? join(root, "workspaceStorage", workspaceHash, id) : null,
      state: join(root, "extensionState"),
      workspaceHash,
      log: join(root, "logs", id),
    };
  }

  #createContext(runtime: ExtensionRuntime) {
    const paths = this.storagePaths(runtime);
    const id = runtime.id.toLowerCase();
    const memento = (file: string | null) => {
      let data: Record<string, unknown> = {};
      if (file) {
        try {
          data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
        } catch {
          /* nothing stored yet */
        }
      }
      const persist = () => {
        if (!file) return;
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
      };
      return {
        keys: () => Object.keys(data),
        get: (key: string, defaultValue?: unknown) => (key in data ? structuredClone(data[key]) : defaultValue),
        update: async (key: string, value: unknown) => {
          if (value === undefined) delete data[key];
          else data[key] = structuredClone(value);
          persist();
        },
        setKeysForSync: () => {},
      };
    };
    const secretsFile = join(paths.state, "secrets", `${id}.json`);
    const secrets = memento(secretsFile);
    const secretChanges = new T.EventEmitter<{ key: string }>();
    const description = runtime.description;
    const extensionUri = T.Uri.file(description.location);
    const environmentVariableCollection = {
      persistent: true,
      description: undefined,
      replace: () => {},
      append: () => {},
      prepend: () => {},
      get: () => undefined,
      forEach: () => {},
      delete: () => {},
      clear: () => {},
      getScoped: () => environmentVariableCollection,
      [Symbol.iterator]: function* () {},
    };
    const ensure = (dir: string | null) => {
      if (dir) mkdirSync(dir, { recursive: true });
      return dir;
    };
    return {
      subscriptions: [] as { dispose(): unknown }[],
      extensionPath: description.location,
      extensionUri,
      extension: this.extensionFacade(runtime),
      extensionMode: description.development ? T.ExtensionMode.Development : T.ExtensionMode.Production,
      globalState: memento(join(paths.state, "global", `${id}.json`)),
      workspaceState: memento(paths.workspaceHash ? join(paths.state, paths.workspaceHash, `${id}.json`) : null),
      secrets: {
        get: async (key: string) => secrets.get(key) as string | undefined,
        store: async (key: string, value: string) => {
          await secrets.update(key, value);
          secretChanges.fire({ key });
        },
        delete: async (key: string) => {
          await secrets.update(key, undefined);
          secretChanges.fire({ key });
        },
        keys: async () => secrets.keys(),
        onDidChange: secretChanges.event,
      },
      get globalStorageUri() {
        return T.Uri.file(ensure(paths.global)!);
      },
      get globalStoragePath() {
        return ensure(paths.global)!;
      },
      get storageUri() {
        const dir = ensure(paths.workspace);
        return dir ? T.Uri.file(dir) : undefined;
      },
      get storagePath() {
        return ensure(paths.workspace) ?? undefined;
      },
      get logUri() {
        return T.Uri.file(ensure(paths.log)!);
      },
      get logPath() {
        return ensure(paths.log)!;
      },
      environmentVariableCollection,
      languageModelAccessInformation: { onDidChange: T.noneEvent, canSendRequest: () => undefined },
      asAbsolutePath: (relativePath: string) => join(description.location, relativePath),
    };
  }

  extensionFacade(runtime: ExtensionRuntime): Record<string, unknown> {
    const host = this;
    return {
      id: runtime.id,
      extensionUri: T.Uri.file(runtime.description.location),
      extensionPath: runtime.description.location,
      get isActive() {
        return runtime.activated;
      },
      packageJSON: runtime.description.manifest,
      extensionKind: T.ExtensionKind.Workspace,
      get exports() {
        return runtime.exports;
      },
      activate: async () => {
        await host.activate(runtime, "api");
        return runtime.exports;
      },
    };
  }

  /* ── configuration ───────────────────────────────────────────────────── */

  configValue(key: string): unknown {
    if (key in this.config.user) return this.config.user[key];
    if (key in this.config.lumen) return this.config.lumen[key];
    if (key in this.configDefaultOverrides) return this.configDefaultOverrides[key];
    if (key in this.configDefaults) return this.configDefaults[key];
    // A section: gather `key.*` into an object.
    const prefix = `${key}.`;
    let found = false;
    const out: Record<string, unknown> = {};
    for (const source of [this.configDefaults, this.configDefaultOverrides, this.config.lumen, this.config.user]) {
      for (const [full, value] of Object.entries(source)) {
        if (!full.startsWith(prefix)) continue;
        found = true;
        const path = full.slice(prefix.length).split(".");
        let target = out;
        for (const part of path.slice(0, -1)) {
          if (typeof target[part] !== "object" || target[part] === null) target[part] = {};
          target = target[part] as Record<string, unknown>;
        }
        target[path.at(-1)!] = value;
      }
    }
    return found ? out : undefined;
  }

  /* ── documents & editors ─────────────────────────────────────────────── */

  document(key: string): ExtHostDocument | undefined {
    return this.documents.get(normalizeKey(key));
  }

  documentForUri(uri: T.Uri): ExtHostDocument | undefined {
    return this.document(keyOfUri(uri));
  }

  async saveDocument(document: ExtHostDocument): Promise<boolean> {
    return !!(await this.requestView("saveDocument", document.key));
  }

  /** Open a document for an extension (from the view's copy, or from disk). */
  async openDocument(uri: T.Uri): Promise<ExtHostDocument> {
    const existing = this.documentForUri(uri);
    if (existing) return existing;
    if (uri.scheme !== "file" && uri.scheme !== "untitled") {
      // A text document content provider, or a file system provided by an extension.
      const key = keyOfUri(uri);
      const provided = this.contentProviders.has(uri.scheme) ? await this.contentProviders.provide(uri) : undefined;
      const raw = provided ?? new TextDecoder().decode(await this.fileSystems.readFile(uri));
      const document = new ExtHostDocument(
        { path: key, languageId: this.languageOf(uri.path, raw), version: 1, text: raw.replace(/\r\n/g, "\n"), eol: raw.includes("\r\n") ? "CRLF" : "LF", dirty: false },
        false,
        (doc) => this.saveDocument(doc),
      );
      this.documents.set(normalizeKey(key), document);
      this.onDidOpenTextDocument.fire(document.toApi());
      return document;
    }
    if (uri.scheme !== "file") throw new Error(`cannot open ${uri.toString()}: no such untitled document`);
    const text = readFileSync(uri.fsPath, "utf8");
    const document = new ExtHostDocument(
      { path: uri.fsPath, languageId: this.languageOf(uri.fsPath, text), version: 1, text: text.replace(/\r\n/g, "\n"), eol: text.includes("\r\n") ? "CRLF" : "LF", dirty: false },
      false,
      (doc) => this.saveDocument(doc),
    );
    this.documents.set(normalizeKey(uri.fsPath), document);
    this.onDidOpenTextDocument.fire(document.toApi());
    return document;
  }

  createUntitled(language: string, content: string): ExtHostDocument {
    const key = `untitled:Untitled-ext-${++this.#untitledSeq}`;
    const document = new ExtHostDocument({ path: key, languageId: language, version: 1, text: content, eol: "LF", dirty: !!content }, false, (doc) =>
      this.saveDocument(doc),
    );
    this.documents.set(normalizeKey(key), document);
    this.onDidOpenTextDocument.fire(document.toApi());
    return document;
  }

  editorFacade = (state: EditorState): Record<string, unknown> => createEditorFacade(this, state);

  activeEditor(): Record<string, unknown> | undefined {
    const state = this.activeEditorKey ? this.editors.get(normalizeKey(this.activeEditorKey)) : undefined;
    return state && this.document(state.key) ? this.editorFacade(state) : undefined;
  }

  visibleEditors(): Record<string, unknown>[] {
    return this.visibleEditorKeys.flatMap((key) => {
      const state = this.editors.get(normalizeKey(key));
      return state && this.document(state.key) ? [this.editorFacade(state)] : [];
    });
  }

  #ensureEditor(key: string, selections: HostSelection[] = []): EditorState {
    const normalized = normalizeKey(key);
    let state = this.editors.get(normalized);
    if (!state) {
      state = { key, selections: [new T.Selection(0, 0, 0, 0)], facade: null };
      this.editors.set(normalized, state);
    }
    if (selections.length) {
      state.selections = selections.map((s) => new T.Selection(s.anchorLine, s.anchorCharacter, s.activeLine, s.activeCharacter));
    }
    return state;
  }

  /* ── providers ───────────────────────────────────────────────────────── */

  normalizeSelector(selector: unknown): HostDocumentFilter[] {
    const list = Array.isArray(selector) ? selector : [selector];
    return list.flatMap((entry): HostDocumentFilter[] => {
      if (typeof entry === "string") return [{ language: entry }];
      if (!entry || typeof entry !== "object") return [];
      const filter = entry as { language?: string; scheme?: string; pattern?: string | T.RelativePattern; notebookType?: string };
      if (filter.notebookType) return [];
      const pattern =
        filter.pattern instanceof T.RelativePattern || (filter.pattern && typeof filter.pattern === "object")
          ? `${(filter.pattern as T.RelativePattern).baseUri.fsPath.replace(/\\/g, "/")}/${(filter.pattern as T.RelativePattern).pattern}`
          : filter.pattern;
      return [{ language: filter.language, scheme: filter.scheme, pattern }];
    });
  }

  registerProvider(kind: ProviderKind, selector: unknown, provider: object, extensionId: string, triggerCharacters?: string[], metadata?: unknown): T.Disposable {
    const id = ++this.#providerSeq;
    const entry: ProviderEntry = {
      id,
      kind,
      extensionId,
      selector: this.normalizeSelector(selector),
      triggerCharacters,
      provider: provider as ProviderEntry["provider"],
      metadata,
    };
    this.providers.set(id, entry);
    // Inlay hints providers ask to be asked again when their hints change.
    const onDidChange = entry.provider.onDidChangeInlayHints;
    if (kind === "inlayHints" && typeof onDidChange === "function") {
      this.#providerChanges.set(id, onDidChange(() => this.post({ type: "inlayHintsChanged" })) as { dispose(): unknown });
    }
    // Code lens providers, likewise, when their lenses change.
    const onDidChangeCodeLenses = entry.provider.onDidChangeCodeLenses;
    if (kind === "codeLens" && typeof onDidChangeCodeLenses === "function") {
      this.#providerChanges.set(id, onDidChangeCodeLenses(() => this.post({ type: "codeLensesChanged" })) as { dispose(): unknown });
    }
    this.#postProviders();
    return new T.Disposable(() => {
      this.#providerChanges.get(id)?.dispose();
      this.#providerChanges.delete(id);
      this.providers.delete(id);
      this.#postProviders();
    });
  }

  #postProviders(): void {
    if (this.#providersPosted) return;
    this.#providersPosted = true;
    queueMicrotask(() => {
      this.#providersPosted = false;
      this.post({
        type: "providers",
        providers: [...this.providers.values()].map(({ provider: _provider, ...info }) => info),
      });
    });
  }

  /** Providers of a kind, regardless of the document (workspace symbols, …). */
  providersOf(kind: ProviderKind): ProviderEntry[] {
    return [...this.providers.values()].filter((entry) => entry.kind === kind);
  }

  /** Providers of a kind whose selector matches the document. */
  matchingProviders(kind: ProviderKind, document: ExtHostDocument): ProviderEntry[] {
    return this.#matching(kind, document);
  }

  #matching(kind: ProviderKind, document: ExtHostDocument): ProviderEntry[] {
    return [...this.providers.values()].filter((entry) => entry.kind === kind && matchesSelector(entry.selector, document.key, document.languageId));
  }

  /** The full command list, once per tick (an activation registers dozens). */
  postCommands(): void {
    if (this.#commandsPosted) return;
    this.#commandsPosted = true;
    queueMicrotask(() => {
      this.#commandsPosted = false;
      const commands = [...this.commands].map(([command, { extensionId }]) => ({ command, extensionId }));
      // Built-in commands of features are run by the host too (executeCommand), so the view routes them here.
      for (const command of featureCommandIds()) if (!this.commands.has(command)) commands.push({ command, extensionId: "lumen" });
      this.post({ type: "commands", commands });
    });
  }

  /* ── view → host calls ───────────────────────────────────────────────── */

  readonly methods: { [K in keyof HostMethods]: (...args: Parameters<HostMethods[K]>) => Promise<ReturnType<HostMethods[K]>> } = {
    executeCommand: async (command, args) => this.executeCommand(command, args),
    feature: async (area, method, args) => {
      const feature = featureByArea(area);
      if (!feature?.onViewRequest) throw new Error(`feature '${area}' does not handle '${method}'`);
      return await feature.onViewRequest(this, method, args);
    },

    provideCompletions: async (path, line, character, triggerCharacter) => {
      const document = this.document(path);
      if (!document) return [];
      const position = new T.Position(line, character);
      const items: HostCompletionItem[] = [];
      const token = new T.CancellationTokenSource().token;
      await Promise.all(
        this.#matching("completion", document).map(async (entry) => {
          if (triggerCharacter && !entry.triggerCharacters?.includes(triggerCharacter)) return;
          try {
            const context = {
              triggerKind: triggerCharacter ? T.CompletionTriggerKind.TriggerCharacter : T.CompletionTriggerKind.Invoke,
              triggerCharacter: triggerCharacter ?? undefined,
            };
            const result = (await entry.provider.provideCompletionItems?.(document.toApi(), position, token, context)) as
              | T.CompletionItem[]
              | T.CompletionList
              | null
              | undefined;
            const list = Array.isArray(result) ? result : (result?.items ?? []);
            for (const item of list) items.push(convertCompletion(item));
          } catch (error) {
            this.log("error", `completion provider failed: ${errorMessage(error)}`, entry.extensionId);
          }
        }),
      );
      items.push(...this.snippetCompletions(document));
      return items;
    },

    provideHover: async (path, line, character) => {
      const document = this.document(path);
      if (!document) return null;
      const position = new T.Position(line, character);
      const contents: string[] = [];
      let range: TextRange | undefined;
      await Promise.all(
        this.#matching("hover", document).map(async (entry) => {
          try {
            const hover = (await entry.provider.provideHover?.(document.toApi(), position, new T.CancellationTokenSource().token)) as T.Hover | null | undefined;
            if (!hover) return;
            for (const part of hover.contents ?? []) {
              const text = markdownOf(part);
              if (text.trim()) contents.push(text);
            }
            if (hover.range && !range) range = wireRange(hover.range);
          } catch (error) {
            this.log("error", `hover provider failed: ${errorMessage(error)}`, entry.extensionId);
          }
        }),
      );
      const result: HostHover | null = contents.length ? { contents, range } : null;
      return result;
    },

    provideInlayHints: async (path, range) => {
      const document = this.document(path);
      if (!document) return [];
      const target = new T.Range(range.startLine, range.startCharacter, range.endLine, range.endCharacter);
      const token = new T.CancellationTokenSource().token;
      const out: HostInlayHint[] = [];
      await Promise.all(
        this.#matching("inlayHints", document).map(async (entry) => {
          try {
            const hints = (await entry.provider.provideInlayHints?.(document.toApi(), target, token)) as T.InlayHint[] | null | undefined;
            for (const hint of hints ?? []) {
              if (!hint?.position) continue;
              const label = typeof hint.label === "string" ? hint.label : (hint.label ?? []).map((part) => part.value).join("");
              if (!label) continue;
              out.push({
                line: hint.position.line,
                character: hint.position.character,
                label,
                tooltip: hint.tooltip === undefined ? undefined : markdownOf(hint.tooltip) || undefined,
                paddingLeft: hint.paddingLeft,
                paddingRight: hint.paddingRight,
                kind: hint.kind === T.InlayHintKind.Type ? "type" : hint.kind === T.InlayHintKind.Parameter ? "parameter" : undefined,
              });
            }
          } catch (error) {
            this.log("error", `inlay hints provider failed: ${errorMessage(error)}`, entry.extensionId);
          }
        }),
      );
      return out;
    },

    provideSemanticTokens: async (path) => {
      const document = this.document(path);
      if (!document) return [];
      const token = new T.CancellationTokenSource().token;
      const full = new T.Range(0, 0, document.lineCount, 0);
      const out: HostSemanticToken[] = [];
      // uint32 relative encoding (deltaLine, deltaCharacter, length, type, modifiers).
      const decode = (entry: ProviderEntry, result: T.SemanticTokens | null | undefined) => {
        const legend = entry.metadata as { tokenTypes?: string[]; tokenModifiers?: string[] } | undefined;
        const types = legend?.tokenTypes ?? [];
        const modifiers = legend?.tokenModifiers ?? [];
        const data = result?.data ?? new Uint32Array(0);
        let line = 0;
        let character = 0;
        for (let i = 0; i + 4 < data.length; i += 5) {
          const deltaLine = data[i]!;
          const deltaCharacter = data[i + 1]!;
          line += deltaLine;
          character = deltaLine === 0 ? character + deltaCharacter : deltaCharacter;
          const mask = data[i + 4]!;
          const mods: string[] = [];
          for (let bit = 0; bit < modifiers.length; bit++) if (mask & (1 << bit)) mods.push(modifiers[bit]!);
          out.push({ line, character, length: data[i + 2]!, type: types[data[i + 3]!] ?? "variable", modifiers: mods });
        }
      };
      const documents = this.#matching("semanticTokens", document);
      const candidates = documents.length ? documents : this.#matching("rangeSemanticTokens", document);
      await Promise.all(
        candidates.map(async (entry) => {
          try {
            const result =
              entry.kind === "rangeSemanticTokens"
                ? await entry.provider.provideDocumentRangeSemanticTokens?.(document.toApi(), full, token)
                : await entry.provider.provideDocumentSemanticTokens?.(document.toApi(), token);
            decode(entry, result as T.SemanticTokens | null | undefined);
          } catch (error) {
            this.log("error", `semantic tokens provider failed: ${errorMessage(error)}`, entry.extensionId);
          }
        }),
      );
      return out;
    },

    provideCodeLenses: async (path) => {
      const document = this.document(path);
      if (!document) return [];
      const token = new T.CancellationTokenSource().token;
      const lenses: HostCodeLens[] = [];
      // The commands stay in the host: the view only gets an id.
      for (const [id, entry] of this.#codeLensCommands) if (entry.path === document.key) this.#codeLensCommands.delete(id);
      await Promise.all(
        this.#matching("codeLens", document).map(async (entry) => {
          try {
            const provided = (await entry.provider.provideCodeLenses?.(document.toApi(), token)) as T.CodeLens[] | null | undefined;
            for (const original of provided ?? []) {
              let lens = original;
              if (!lens.command && entry.provider.resolveCodeLens) {
                try {
                  lens = ((await entry.provider.resolveCodeLens(document.toApi(), lens, token)) as T.CodeLens | null | undefined) ?? lens;
                } catch (error) {
                  this.log("error", `code lens resolution failed: ${errorMessage(error)}`, entry.extensionId);
                }
              }
              if (!lens.command) continue;
              const id = `codeLens:${++this.#codeLensSeq}`;
              this.#codeLensCommands.set(id, { path: document.key, command: lens.command });
              lenses.push({ id, line: lens.range.start.line, title: lens.command.title, tooltip: lens.command.tooltip });
            }
          } catch (error) {
            this.log("error", `code lens provider failed: ${errorMessage(error)}`, entry.extensionId);
          }
        }),
      );
      lenses.sort((a, b) => a.line - b.line);
      return lenses;
    },

    runCodeLens: async (id) => {
      const entry = this.#codeLensCommands.get(id);
      if (!entry) return;
      await this.executeCommand(entry.command.command, entry.command.arguments ?? []);
    },

    provideCodeActions: async (path, range, diagnostics, only) => {
      const document = this.document(path);
      if (!document) return [];
      const target = new T.Range(range.startLine, range.startCharacter, range.endLine, range.endCharacter);
      const context = {
        diagnostics: reviveDiagnostics(diagnostics),
        triggerKind: T.CodeActionTriggerKind.Invoke,
        only: only ? new T.CodeActionKind(only) : undefined,
      };
      const token = new T.CancellationTokenSource().token;
      const out: HostCodeAction[] = [];
      // The actions stay in the host: the view only gets an id.
      for (const [id, entry] of this.#codeActions) if (entry.path === document.key) this.#codeActions.delete(id);
      await Promise.all(
        this.#matching("codeAction", document).map(async (entry) => {
          try {
            const provided = (await entry.provider.provideCodeActions?.(document.toApi(), target, context, token)) as
              | (T.Command | T.CodeAction)[]
              | null
              | undefined;
            for (const value of provided ?? []) {
              const action = codeActionOf(value);
              if (!action) continue;
              const id = `codeAction:${++this.#codeActionSeq}`;
              this.#codeActions.set(id, { path: document.key, entry, action });
              out.push({
                id,
                title: action.title,
                kind: action.kind?.value || undefined,
                isPreferred: action.isPreferred,
                disabled: !!action.disabled,
                disabledReason: action.disabled?.reason,
              });
            }
          } catch (error) {
            this.log("error", `code action provider failed: ${errorMessage(error)}`, entry.extensionId);
          }
        }),
      );
      return out;
    },

    runCodeAction: async (id) => {
      const stored = this.#codeActions.get(id);
      if (!stored) return;
      this.#codeActions.delete(id);
      let action = stored.action;
      // Resolve lazily: the provider fills in the edit (and command) when the user picks the action.
      if (!action.edit && stored.entry.provider.resolveCodeAction) {
        try {
          action = ((await stored.entry.provider.resolveCodeAction(action, new T.CancellationTokenSource().token)) as T.CodeAction | null | undefined) ?? action;
        } catch (error) {
          this.log("error", `code action resolution failed: ${errorMessage(error)}`, stored.entry.extensionId);
        }
      }
      if (action.edit && !(await applyWorkspaceEdit(this, action.edit, stored.entry.extensionId))) {
        this.log("error", `code action '${action.title}' could not apply its edit`, stored.entry.extensionId);
      }
      if (action.command) await this.executeCommand(action.command.command, action.command.arguments ?? []);
    },

    provideSignatureHelp: async (path, line, character, triggerCharacter) => {
      const document = this.document(path);
      if (!document) return null;
      const position = new T.Position(line, character);
      for (const entry of this.#matching("signatureHelp", document)) {
        try {
          const context = {
            triggerKind: triggerCharacter ? T.SignatureHelpTriggerKind.TriggerCharacter : T.SignatureHelpTriggerKind.Invoke,
            triggerCharacter: triggerCharacter ?? undefined,
            isRetrigger: false,
            activeSignatureHelp: undefined,
          };
          const help = (await entry.provider.provideSignatureHelp?.(document.toApi(), position, new T.CancellationTokenSource().token, context)) as
            | T.SignatureHelp
            | null
            | undefined;
          if (!help?.signatures?.length) continue;
          const signatures: HostSignatureHelp["signatures"] = help.signatures.map((signature) => ({
            label: signature.label,
            documentation: signature.documentation === undefined ? undefined : markdownOf(signature.documentation),
            parameters: (signature.parameters ?? []).map((parameter) => ({
              label: parameter.label,
              documentation: parameter.documentation === undefined ? undefined : markdownOf(parameter.documentation),
            })),
          }));
          const activeSignature = Math.min(Math.max(0, help.activeSignature ?? 0), signatures.length - 1);
          const activeParameter = Math.min(Math.max(0, help.activeParameter ?? 0), Math.max(0, (signatures[activeSignature]?.parameters.length ?? 1) - 1));
          return { signatures, activeSignature, activeParameter };
        } catch (error) {
          this.log("error", `signature help provider failed: ${errorMessage(error)}`, entry.extensionId);
        }
      }
      return null;
    },

    provideDefinition: async (path, line, character) => this.#locations("definition", "provideDefinition", path, line, character),

    provideTypeDefinition: async (path, line, character) => this.#locations("typeDefinition", "provideTypeDefinition", path, line, character),

    provideImplementation: async (path, line, character) => this.#locations("implementation", "provideImplementation", path, line, character),

    provideDeclaration: async (path, line, character) => this.#locations("declaration", "provideDeclaration", path, line, character),

    provideReferences: async (path, line, character) => this.#locations("references", "provideReferences", path, line, character, { includeDeclaration: true }),

    provideDocumentHighlights: async (path, line, character) => {
      const document = this.document(path);
      if (!document) return [];
      const position = new T.Position(line, character);
      const kinds: HostDocumentHighlight["kind"][] = ["text", "read", "write"];
      const out: HostDocumentHighlight[] = [];
      await Promise.all(
        this.#matching("documentHighlight", document).map(async (entry) => {
          try {
            const highlights = (await entry.provider.provideDocumentHighlights?.(document.toApi(), position, new T.CancellationTokenSource().token)) as
              | T.DocumentHighlight[]
              | null
              | undefined;
            for (const highlight of highlights ?? []) {
              if (!highlight?.range) continue;
              out.push({ range: wireRange(highlight.range), kind: kinds[highlight.kind ?? 0] ?? "text" });
            }
          } catch (error) {
            this.log("error", `document highlight provider failed: ${errorMessage(error)}`, entry.extensionId);
          }
        }),
      );
      return out;
    },

    provideDocumentLinks: async (path) => {
      const document = this.document(path);
      if (!document) return [];
      const out: HostDocumentLink[] = [];
      const cache: { entry: ProviderEntry; link: T.DocumentLink }[] = [];
      await Promise.all(
        this.#matching("documentLink", document).map(async (entry) => {
          try {
            const links = (await entry.provider.provideDocumentLinks?.(document.toApi(), new T.CancellationTokenSource().token)) as
              | T.DocumentLink[]
              | null
              | undefined;
            for (const link of links ?? []) {
              if (!link?.range) continue;
              cache.push({ entry, link });
              out.push(wireDocumentLink(link));
            }
          } catch (error) {
            this.log("error", `document link provider failed: ${errorMessage(error)}`, entry.extensionId);
          }
        }),
      );
      this.#documentLinks.set(normalizeKey(path), cache);
      return out;
    },

    resolveDocumentLink: async (path, index) => {
      const document = this.document(path);
      const cached = this.#documentLinks.get(normalizeKey(path))?.[index];
      if (!document || !cached) return null;
      try {
        const resolved = (await cached.entry.provider.resolveDocumentLink?.(cached.link, new T.CancellationTokenSource().token)) as T.DocumentLink | null | undefined;
        const link = resolved ?? cached.link;
        return link?.range ? wireDocumentLink(link) : null;
      } catch (error) {
        this.log("error", `document link provider failed: ${errorMessage(error)}`, cached.entry.extensionId);
        return null;
      }
    },

    provideDocumentColors: async (path) => {
      const document = this.document(path);
      if (!document) return [];
      const out: HostColorInformation[] = [];
      await Promise.all(
        this.#matching("color", document).map(async (entry) => {
          try {
            const colors = (await entry.provider.provideDocumentColors?.(document.toApi(), new T.CancellationTokenSource().token)) as
              | T.ColorInformation[]
              | null
              | undefined;
            for (const info of colors ?? []) {
              if (!info?.range || !info.color) continue;
              out.push({ range: wireRange(info.range), color: wireColor(info.color) });
            }
          } catch (error) {
            this.log("error", `color provider failed: ${errorMessage(error)}`, entry.extensionId);
          }
        }),
      );
      return out;
    },

    provideColorPresentations: async (path, color, range) => {
      const document = this.document(path);
      if (!document) return [];
      const apiColor = new T.Color(color.red, color.green, color.blue, color.alpha);
      const apiRange = new T.Range(range.startLine, range.startCharacter, range.endLine, range.endCharacter);
      const context = { document: document.toApi(), range: apiRange };
      const out: HostColorPresentation[] = [];
      await Promise.all(
        this.#matching("color", document).map(async (entry) => {
          try {
            const presentations = (await entry.provider.provideColorPresentations?.(
              apiColor,
              context,
              new T.CancellationTokenSource().token,
            )) as T.ColorPresentation[] | null | undefined;
            for (const presentation of presentations ?? []) {
              if (!presentation) continue;
              out.push({ label: presentation.label, textEdit: presentation.textEdit ? wireEdit(presentation.textEdit) : undefined });
            }
          } catch (error) {
            this.log("error", `color provider failed: ${errorMessage(error)}`, entry.extensionId);
          }
        }),
      );
      return out;
    },

    prepareRename: async (path, line, character) => {
      const document = this.document(path);
      if (!document) return null;
      const position = new T.Position(line, character);
      for (const entry of this.#matching("rename", document)) {
        if (!entry.provider.prepareRename) continue;
        try {
          const result = (await entry.provider.prepareRename(document.toApi(), position, new T.CancellationTokenSource().token)) as
            | T.Range
            | { range: T.Range; placeholder: string }
            | null
            | undefined;
          if (!result) continue;
          if (T.Range.isRange(result)) return { range: wireRange(result), placeholder: document.getText(result) };
          if (T.Range.isRange(result.range)) return { range: wireRange(result.range), placeholder: result.placeholder };
        } catch (error) {
          return { error: `${entry.extensionId}: ${errorMessage(error)}` };
        }
      }
      return null;
    },

    provideRenameEdits: async (path, line, character, newName) => {
      const document = this.document(path);
      if (!document) return null;
      const position = new T.Position(line, character);
      for (const entry of this.#matching("rename", document)) {
        if (!entry.provider.provideRenameEdits) continue;
        try {
          const edit = (await entry.provider.provideRenameEdits(document.toApi(), position, newName, new T.CancellationTokenSource().token)) as
            | T.WorkspaceEdit
            | null
            | undefined;
          if (!edit) continue;
          return { edits: wireWorkspaceEdit(edit) };
        } catch (error) {
          return { error: `${entry.extensionId}: ${errorMessage(error)}` };
        }
      }
      return null;
    },

    provideFormatting: async (path, options, range) => {
      const document = this.document(path);
      if (!document) return null;
      const formatting = { tabSize: options.tabSize, insertSpaces: options.insertSpaces };
      const token = new T.CancellationTokenSource().token;
      const candidates = range
        ? [...this.#matching("rangeFormatting", document), ...this.#matching("formatting", document)]
        : [...this.#matching("formatting", document), ...this.#matching("rangeFormatting", document)];
      for (const entry of candidates) {
        try {
          const edits =
            entry.kind === "formatting"
              ? await entry.provider.provideDocumentFormattingEdits?.(document.toApi(), formatting, token)
              : await entry.provider.provideDocumentRangeFormattingEdits?.(
                  document.toApi(),
                  range ? new T.Range(range.startLine, range.startCharacter, range.endLine, range.endCharacter) : new T.Range(0, 0, document.lineCount, 0),
                  formatting,
                  token,
                );
          if (Array.isArray(edits)) return edits.map(wireEdit);
        } catch (error) {
          this.log("error", `formatter failed: ${errorMessage(error)}`, entry.extensionId);
          throw new Error(`${entry.extensionId}: ${errorMessage(error)}`);
        }
      }
      return null;
    },

    provideOnTypeFormatting: async (path, line, character, ch, options) => {
      const document = this.document(path);
      if (!document) return [];
      const position = new T.Position(line, character);
      const formatting = { tabSize: options.tabSize, insertSpaces: options.insertSpaces };
      const token = new T.CancellationTokenSource().token;
      for (const entry of this.#matching("onTypeFormatting", document)) {
        if (!entry.triggerCharacters?.includes(ch)) continue;
        try {
          const edits = (await entry.provider.provideOnTypeFormattingEdits?.(document.toApi(), position, ch, formatting, token)) as
            | T.TextEdit[]
            | null
            | undefined;
          if (Array.isArray(edits)) return edits.map(wireEdit);
        } catch (error) {
          this.log("error", `on-type formatter failed: ${errorMessage(error)}`, entry.extensionId);
        }
      }
      return [];
    },

    provideInlineCompletions: async (path, line, character, triggerKind) => {
      const document = this.document(path);
      if (!document) return [];
      const position = new T.Position(line, character);
      const token = new T.CancellationTokenSource().token;
      const context = { triggerKind: triggerKind ? T.InlineCompletionTriggerKind.Automatic : T.InlineCompletionTriggerKind.Invoke };
      const items: HostInlineCompletionItem[] = [];
      for (const entry of this.#matching("inlineCompletion", document)) {
        try {
          const result = (await entry.provider.provideInlineCompletionItems?.(document.toApi(), position, context, token)) as
            | T.InlineCompletionItem[]
            | T.InlineCompletionList
            | null
            | undefined;
          const list = Array.isArray(result) ? result : (result?.items ?? []);
          for (const item of list) items.push(convertInlineCompletion(item));
        } catch (error) {
          this.log("error", `inline completion provider failed: ${errorMessage(error)}`, entry.extensionId);
        }
      }
      return items;
    },

    provideSymbols: async (path) => {
      const document = this.document(path);
      if (!document) return null;
      for (const entry of this.#matching("documentSymbol", document)) {
        try {
          const symbols = (await entry.provider.provideDocumentSymbols?.(document.toApi(), new T.CancellationTokenSource().token)) as
            | (T.DocumentSymbol | T.SymbolInformation)[]
            | null
            | undefined;
          if (Array.isArray(symbols)) return symbols.map(wireSymbol);
        } catch (error) {
          this.log("error", `symbol provider failed: ${errorMessage(error)}`, entry.extensionId);
        }
      }
      return null;
    },

    provideFoldingRanges: async (path) => {
      const document = this.document(path);
      if (!document) return [];
      const kinds: HostFoldingRange["kind"][] = ["comment", "imports", "region"];
      const out: HostFoldingRange[] = [];
      await Promise.all(
        this.#matching("foldingRange", document).map(async (entry) => {
          try {
            const ranges = (await entry.provider.provideFoldingRanges?.(document.toApi(), {}, new T.CancellationTokenSource().token)) as
              | T.FoldingRange[]
              | null
              | undefined;
            for (const range of ranges ?? []) {
              if (!range || typeof range.start !== "number" || typeof range.end !== "number") continue;
              out.push({ start: range.start, end: range.end, kind: range.kind ? kinds[range.kind - 1] : undefined });
            }
          } catch (error) {
            this.log("error", `folding range provider failed: ${errorMessage(error)}`, entry.extensionId);
          }
        }),
      );
      return out;
    },

    provideSelectionRanges: async (path, positions) => {
      const document = this.document(path);
      if (!document || !positions.length) return [];
      const list = positions.map((position) => new T.Position(position.line, position.character));
      const out: TextRange[][] = positions.map(() => []);
      await Promise.all(
        this.#matching("selectionRange", document).map(async (entry) => {
          try {
            const ranges = (await entry.provider.provideSelectionRanges?.(document.toApi(), list, new T.CancellationTokenSource().token)) as
              | T.SelectionRange[]
              | null
              | undefined;
            if (!Array.isArray(ranges)) return;
            for (let index = 0; index < positions.length && index < ranges.length; index++) {
              if (out[index].length) continue; // the first provider that answers wins
              const chain: TextRange[] = [];
              for (let node: T.SelectionRange | undefined = ranges[index]; node; node = node.parent) {
                if (T.Range.isRange(node.range)) chain.push(wireRange(node.range));
              }
              out[index] = chain;
            }
          } catch (error) {
            this.log("error", `selection range provider failed: ${errorMessage(error)}`, entry.extensionId);
          }
        }),
      );
      return out;
    },

    provideWorkspaceSymbols: async (query) => {
      const out: HostWorkspaceSymbol[] = [];
      this.#workspaceSymbols.clear();
      await Promise.all(
        this.providersOf("workspaceSymbol").map(async (entry) => {
          try {
            const symbols = (await entry.provider.provideWorkspaceSymbols?.(query, new T.CancellationTokenSource().token)) as
              | WorkspaceSymbolLike[]
              | null
              | undefined;
            for (const symbol of symbols ?? []) {
              if (!symbol?.name) continue;
              const id = ++this.#workspaceSymbolSeq;
              this.#workspaceSymbols.set(id, { entry, symbol });
              out.push(wireWorkspaceSymbol(id, symbol));
            }
          } catch (error) {
            this.log("error", `workspace symbol provider failed: ${errorMessage(error)}`, entry.extensionId);
          }
        }),
      );
      return out;
    },

    resolveWorkspaceSymbol: async (id) => {
      const cached = this.#workspaceSymbols.get(id);
      if (!cached) return null;
      try {
        const resolved = (cached.entry.provider.resolveWorkspaceSymbol
          ? await cached.entry.provider.resolveWorkspaceSymbol(cached.symbol, new T.CancellationTokenSource().token)
          : cached.symbol) as WorkspaceSymbolLike | null | undefined;
        return resolved ? wireWorkspaceLocation(resolved) : null;
      } catch (error) {
        this.log("error", `workspace symbol provider failed: ${errorMessage(error)}`, cached.entry.extensionId);
        return null;
      }
    },

    provideLinkedEditingRanges: async (path, line, character) => {
      const document = this.document(path);
      if (!document) return null;
      const position = new T.Position(line, character);
      for (const entry of this.#matching("linkedEditingRange", document)) {
        try {
          const result = (await entry.provider.provideLinkedEditingRanges?.(document.toApi(), position, new T.CancellationTokenSource().token)) as
            | { ranges: T.Range[]; wordPattern?: RegExp }
            | null
            | undefined;
          if (!result?.ranges?.length) continue;
          return { ranges: result.ranges.map(wireRange), wordPattern: result.wordPattern?.source };
        } catch (error) {
          this.log("error", `linked editing provider failed: ${errorMessage(error)}`, entry.extensionId);
        }
      }
      return null;
    },

    deserializeWebviewPanel: async (viewType, webviewId, title, state, options) => this.webviews.deserialize(viewType, webviewId, title, state, options),

    readVirtualFile: async (path) => {
      const uri = uriOfKey(path);
      const language = this.languageOf(uri.path);
      // A text document content provider wins over a file system provider of the same scheme.
      if (this.contentProviders.has(uri.scheme)) {
        const content = await this.contentProviders.provide(uri);
        if (content !== undefined) return { content, language, readOnly: true };
      }
      let content: string;
      try {
        content = new TextDecoder().decode(await this.fileSystems.readFile(uri));
      } catch (error) {
        // FileSystemError codes are readable in the window's "Cannot open" message.
        throw new Error(messageOf(error));
      }
      let readOnly = !this.fileSystems.isWritable(uri.scheme);
      let readOnlyMessage = readOnly ? this.fileSystems.readOnlyMessage(uri.scheme) : undefined;
      // FilePermission.Readonly makes a single file read-only (workspace.fs.stat / FileStat).
      if (!readOnly) {
        try {
          const stat = await this.fileSystems.stat(uri);
          if (stat.permissions && stat.permissions & 1) {
            readOnly = true;
            readOnlyMessage = "This file is read-only.";
          }
        } catch {
          /* a provider may not answer stat for every file */
        }
      }
      return { content, language, readOnly, ...(readOnlyMessage ? { readOnlyMessage } : {}) };
    },

    writeVirtualFile: async (path, content) => {
      try {
        await this.fileSystems.writeFile(uriOfKey(path), new TextEncoder().encode(content));
        return true;
      } catch (error) {
        // FileSystemError codes are readable in the window's save error.
        throw new Error(messageOf(error));
      }
    },

    virtualSchemes: async () => [...this.fileSystems.providers.keys()],

    providerReadDirectory: async (path) => await this.fileSystems.list(uriOfKey(path)),

    providerCreateFile: async (path, content) => await this.fileSystems.createFile(uriOfKey(path), new TextEncoder().encode(content)),

    providerCreateDirectory: async (path) => await this.fileSystems.createDirectory(uriOfKey(path)),

    providerRename: async (oldPath, newPath) => await this.fileSystems.rename(uriOfKey(oldPath), uriOfKey(newPath)),

    providerCopy: async (source, destination) => await this.fileSystems.copy(uriOfKey(source), uriOfKey(destination)),

    providerDelete: async (path) => await this.fileSystems.delete(uriOfKey(path)),

    providerWatch: async (path, recursive) => await this.fileSystems.watch(uriOfKey(path), recursive),

    providerUnwatch: async (path) => this.fileSystems.unwatch(uriOfKey(path)),

    providerListFiles: async (roots, limit) => await this.fileSystems.listFiles(roots, limit),

    providerSearchFiles: async (roots, query, options) => await this.fileSystems.searchFiles(roots, query, options),

    providerReplaceFiles: async (roots, query, replacement, options, paths) => await this.fileSystems.replaceFiles(roots, query, replacement, options, paths),

    provideFileDecorations: async (paths) => this.fileDecorations.provide(paths),

    treeChildren: async (viewId, handle) => this.trees.children(viewId, handle),

    resolveTreeItem: async (viewId, handle) => this.trees.resolveItem(viewId, handle),

    treeDrag: async (viewId, handles) => this.trees.drag(viewId, handles),

    treeDrop: async (viewId, targetHandle, dragId, files) => this.trees.drop(viewId, targetHandle, dragId, files),

    willSaveDocument: async (path, reason) => {
      const document = this.document(path);
      if (!document) return [];
      // Collect edits registered through waitUntil; VS Code saves anyway after a timeout.
      const results: WireTextEdit[] = [];
      const waits: Promise<unknown>[] = [];
      this.onWillSaveTextDocument.fire({
        document: document.toApi(),
        reason,
        waitUntil: (thenable: PromiseLike<unknown>) => {
          waits.push(
            Promise.resolve(thenable).then((value) => {
              for (const edit of [value ?? []].flat() as T.TextEdit[]) {
                if (edit && edit.range && typeof edit.newText === "string") results.push(wireEdit(edit));
              }
            }),
          );
        },
      });
      if (!waits.length) return [];
      await Promise.race([Promise.allSettled(waits), new Promise((resolve) => setTimeout(resolve, 1500))]);
      return results;
    },

    willFileOperation: async (kind, files) => this.fireWillFileOperation(kind, files),

    openCustomEditor: async (path, viewType, options) =>
      this.customEditors.open(path, viewType, { viewColumn: options?.beside ? T.ViewColumn.Beside : T.ViewColumn.Active, preserveFocus: false }),

    saveCustomEditor: async (path, viewType) => this.customEditors.save(path, viewType),

    saveCustomEditorAs: async (path, viewType) => {
      const chosen = await this.requestMain("showSaveDialog", { defaultPath: path });
      return chosen ? this.customEditors.saveAs(path, viewType, chosen) : false;
    },

    revertCustomEditor: async (path, viewType) => this.customEditors.revert(path, viewType),

    undoCustomEditor: async (path, viewType) => this.customEditors.undo(path, viewType),

    redoCustomEditor: async (path, viewType) => this.customEditors.redo(path, viewType),

    backupCustomEditor: async (path, viewType, destination) =>
      this.customEditors.backup(path, viewType, destination ? { destination: uriOfKey(destination) } : {}),

    deserializeCustomEditor: async (path, viewType, webviewId, state) => this.customEditors.deserialize(path, viewType, webviewId, state),

    debugListConfigurations: (folder) => this.debug.listConfigurations(folder),
    debugStart: async (folder, name) => {
      try {
        return { sessionId: await this.debug.startNamed(folder, name) };
      } catch (error) {
        return { error: errorMessage(error) };
      }
    },
    debugStartConfiguration: async (folder, config) => {
      try {
        return { sessionId: await this.debug.startWithConfiguration(config, folder) };
      } catch (error) {
        return { error: errorMessage(error) };
      }
    },
    debugStop: (sessionId) => this.debug.stopDebugging(sessionId ? { id: sessionId } : undefined),
    debugRestart: async (sessionId) => {
      try {
        return { sessionId: await this.debug.restart(sessionId) };
      } catch (error) {
        return { error: errorMessage(error) };
      }
    },
    debugResume: (sessionId, threadId) => this.debug.resume(sessionId, threadId),
    debugPause: (sessionId, threadId) => this.debug.pause(sessionId, threadId),
    debugStep: (sessionId, threadId, kind) => this.debug.step(sessionId, threadId, kind),
    debugThreads: (sessionId) => this.debug.threads(sessionId),
    debugStackTrace: (sessionId, threadId, startFrame, levels) => this.debug.stackTrace(sessionId, threadId, startFrame, levels),
    debugScopes: (sessionId, frameId) => this.debug.scopes(sessionId, frameId),
    debugVariables: (sessionId, variablesReference, filter, start, count) => this.debug.variables(sessionId, variablesReference, filter, start, count),
    debugSetVariable: (sessionId, variablesReference, name, value) => this.debug.setVariable(sessionId, variablesReference, name, value),
    debugEvaluate: (sessionId, expression, frameId, context) => this.debug.evaluate(sessionId, expression, frameId, context),
    debugCustomRequest: (sessionId, command, args) => this.debug.customRequest(sessionId, command, args),
    debugSetBreakpoints: async (path, breakpoints) => this.debug.setBreakpoints(path, breakpoints),
    debugToggleBreakpoint: async (path, line) => this.debug.toggleBreakpoint(path, line),
    debugSetBreakpointEnabled: async (id, enabled) => this.debug.setBreakpointEnabled(id, enabled),
    debugEditBreakpoint: async (id, changes) => this.debug.editBreakpoint(id, changes),
    debugRemoveAllBreakpoints: async () => {
      this.debug.removeAllBreakpoints();
      return this.debug.wireBreakpoints();
    },
    debugSetExceptionBreakpoints: async (sessionId, filters) => this.debug.setExceptionBreakpoints(sessionId, filters),
    debugLoadedSources: (sessionId) => this.debug.loadedSources(sessionId),
  };

  async #locations(kind: ProviderKind, method: string, path: string, line: number, character: number, extra?: unknown): Promise<HostLocation[]> {
    const document = this.document(path);
    if (!document) return [];
    const position = new T.Position(line, character);
    const out: HostLocation[] = [];
    await Promise.all(
      this.#matching(kind, document).map(async (entry) => {
        try {
          const args: unknown[] = [document.toApi(), position];
          if (extra) args.push(extra);
          args.push(new T.CancellationTokenSource().token);
          const result = (await entry.provider[method]?.(...args)) as unknown;
          for (const location of [result ?? []].flat() as (T.Location | { targetUri: T.Uri; targetRange: T.Range; targetSelectionRange?: T.Range })[]) {
            const uri = "targetUri" in location ? location.targetUri : location.uri;
            const target = "targetUri" in location ? (location.targetSelectionRange ?? location.targetRange) : location.range;
            if (!uri || !target) continue;
            out.push({
              path: keyOfUri(T.Uri.revive(uri)!),
              line: target.start.line,
              character: target.start.character,
              endLine: target.end.line,
              endCharacter: target.end.character,
            });
          }
        } catch (error) {
          this.log("error", `${kind} provider failed: ${errorMessage(error)}`, entry.extensionId);
        }
      }),
    );
    return out;
  }

  /* ── snippets (contributes.snippets) ─────────────────────────────────── */

  #snippetCache = new Map<string, { prefix: string; body: string; description?: string; languages: string[] | null }[]>();

  snippetCompletions(document: ExtHostDocument): HostCompletionItem[] {
    const items: HostCompletionItem[] = [];
    for (const runtime of this.runtimes.values()) {
      for (const contribution of runtime.description.manifest.contributes?.snippets ?? []) {
        if (contribution.language && contribution.language !== document.languageId) continue;
        const file = resolve(runtime.description.location, contribution.path);
        let snippets = this.#snippetCache.get(file);
        if (!snippets) {
          snippets = loadSnippets(file);
          this.#snippetCache.set(file, snippets);
        }
        for (const snippet of snippets) {
          if (snippet.languages && !snippet.languages.includes(document.languageId)) continue;
          items.push({ label: snippet.prefix, detail: snippet.description, documentation: snippet.body, kind: "snippet", insertText: snippet.body, snippet: true });
        }
      }
    }
    return items;
  }

  /* ── commands ────────────────────────────────────────────────────────── */

  async executeCommand(command: string, args: unknown[] = []): Promise<unknown> {
    await this.activateByEvent(`onCommand:${command}`);
    const entry = this.commands.get(command);
    if (entry) return await entry.callback.apply(entry.thisArg, args);
    for (const feature of hostFeatures) {
      if (!feature.executeCommand) continue;
      const result = await feature.executeCommand(this, command, args);
      if (result !== NOT_HANDLED) return result;
    }
    switch (command) {
      case "setContext": {
        const [key, value] = args as [string, unknown];
        this.contextKeys.set(key, value);
        this.post({ type: "context", key, value: toWire(value) });
        return undefined;
      }
      case "vscode.open": {
        const uri = T.Uri.revive(args[0] as T.Uri);
        if (uri?.scheme === "http" || uri?.scheme === "https" || uri?.scheme === "mailto") return this.requestMain("openExternal", uri.toString());
        if (uri) return this.requestView("showTextDocument", keyOfUri(uri), {});
        return undefined;
      }
      case "vscode.openWith": {
        const uri = T.Uri.revive(args[0] as T.Uri);
        const viewType = typeof args[1] === "string" ? (args[1] as string) : "default";
        if (!uri) return undefined;
        if (viewType === "default") return this.requestView("showTextDocument", keyOfUri(uri), {});
        const columnOrOptions = args[2] as number | { viewColumn?: number; preserveFocus?: boolean } | undefined;
        return this.customEditors.open(keyOfUri(uri), viewType, columnOrOptions);
      }
      case "vscode.diff": {
        const original = T.Uri.revive(args[0] as T.Uri);
        const modified = T.Uri.revive(args[1] as T.Uri);
        if (!original || !modified) return undefined;
        const title = typeof args[2] === "string" ? (args[2] as string) : undefined;
        const options = (args[3] ?? {}) as { viewColumn?: number; preview?: boolean; preserveFocus?: boolean; selection?: T.Range };
        return this.requestView("openDiff", keyOfUri(original), keyOfUri(modified), {
          title,
          preview: options.preview,
          preserveFocus: options.preserveFocus,
          viewColumn: options.viewColumn,
          selection: options.selection ? wireRange(T.toRange(options.selection)) : undefined,
        });
      }
      case "workbench.action.openSettings":
      case "workbench.action.openGlobalSettings":
        return this.requestView("executeCommand", "workbench.action.openSettings", []);
      case "vscode.executeFormatDocumentProvider": {
        const uri = T.Uri.revive(args[0] as T.Uri);
        const document = uri && this.documentForUri(uri);
        if (!document) return [];
        const edits = await this.methods.provideFormatting(document.key, { tabSize: 2, insertSpaces: true }, null);
        return (edits ?? []).map((edit) => new T.TextEdit(new T.Range(edit.startLine, edit.startCharacter, edit.endLine, edit.endCharacter), edit.newText));
      }
      default:
        return this.requestView("executeCommand", command, args);
    }
  }

  /* ── workspace files ─────────────────────────────────────────────────── */

  async findFiles(include: string | T.RelativePattern, exclude: string | T.RelativePattern | null | undefined, maxResults?: number, token?: T.CancellationToken): Promise<T.Uri[]> {
    const base = include instanceof T.RelativePattern ? include.baseUri.fsPath : this.workspace;
    if (!base) return [];
    const pattern = include instanceof T.RelativePattern ? include.pattern : include;
    const excludes =
      exclude === null ? [] : exclude === undefined ? DEFAULT_EXCLUDES : [exclude instanceof T.RelativePattern ? exclude.pattern : exclude];
    const isExcluded = (rel: string) => excludes.some((glob) => matchGlob(glob, rel) || matchGlob(`${glob}/**`, rel));
    const results: T.Uri[] = [];
    let visited = 0;
    const walk = async (dir: string): Promise<void> => {
      if (token?.isCancellationRequested || (maxResults !== undefined && results.length >= maxResults) || visited > 200_000) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        visited++;
        const full = join(dir, entry.name);
        const rel = relative(base, full).replace(/\\/g, "/");
        if (isExcluded(rel)) continue;
        if (entry.isDirectory()) await walk(full);
        else if (matchGlob(pattern, rel)) {
          results.push(T.Uri.file(full));
          if (maxResults !== undefined && results.length >= maxResults) return;
        }
      }
    };
    await walk(base);
    return results;
  }

  async #checkWorkspaceContains(): Promise<void> {
    if (!this.workspace) return;
    for (const runtime of this.runtimes.values()) {
      for (const event of runtime.activationEvents) {
        if (!event.startsWith("workspaceContains:") || runtime.activated) continue;
        const pattern = event.slice("workspaceContains:".length);
        const found = await this.findFiles(pattern.includes("/") || pattern.includes("*") ? pattern : `**/${pattern}`, undefined, 1);
        if (found.length) void this.activate(runtime, event);
      }
    }
  }

  filesChanged(paths: string[]): void {
    if (!this.watchers.size) return;
    const now = Date.now();
    for (const path of paths) {
      let kind: "create" | "change" | "delete" = "delete";
      try {
        const stats = statSync(path);
        kind = now - stats.birthtimeMs < 3000 ? "create" : "change";
      } catch {
        /* gone */
      }
      const uri = T.Uri.file(path);
      for (const watcher of this.watchers) if (watcher.matches(path)) watcher[kind]?.fire(uri);
    }
  }

  /** A file system provider reported changes (onDidChangeFile, or Lumen wrote through it). */
  filesChangedUris(events: readonly { uri: T.Uri; type: number }[]): void {
    if (!this.watchers.size) return;
    for (const { uri, type } of events) {
      const kind = type === T.FileChangeType.Created ? "create" : type === T.FileChangeType.Deleted ? "delete" : "change";
      for (const watcher of this.watchers) if (watcher.matchesUri(uri)) watcher[kind]?.fire(uri);
    }
  }

  /** The files of a view file operation as the objects the onWill* / onDid* events hand out. */
  #fileOperationFiles(kind: "create" | "delete" | "rename", files: HostFileOperation[]) {
    if (kind === "rename") return files.map((file) => ({ oldUri: uriOfKey(file.oldPath!), newUri: uriOfKey(file.newPath!) }));
    return files.map((file) => uriOfKey(file.path!));
  }

  /**
   * Fire workspace.onWillCreateFiles / onWillDeleteFiles / onWillRenameFiles for a
   * user file operation, wait for the `waitUntil` thenables (1.5 s, like save
   * participants) and return the text edits the listeners produced.
   */
  async fireWillFileOperation(kind: "create" | "delete" | "rename", files: HostFileOperation[]): Promise<WireFileEdits[]> {
    const edits: WireFileEdits[] = [];
    const waits: Promise<unknown>[] = [];
    const event = {
      files: this.#fileOperationFiles(kind, files),
      waitUntil: (thenable: PromiseLike<unknown>) => {
        waits.push(
          Promise.resolve(thenable).then((value) => {
            if (value instanceof T.WorkspaceEdit) edits.push(...wireWorkspaceEdit(value));
          }),
        );
      },
    };
    if (kind === "create") this.onWillCreateFiles.fire(event);
    else if (kind === "delete") this.onWillDeleteFiles.fire(event);
    else this.onWillRenameFiles.fire(event);
    if (!waits.length) return [];
    await Promise.race([Promise.allSettled(waits), new Promise((resolve) => setTimeout(resolve, 1500))]);
    const merged = new Map<string, WireFileEdits>();
    for (const entry of edits) {
      const key = normalizeKey(entry.path);
      const target = merged.get(key) ?? { path: entry.path, edits: [] };
      target.edits.push(...entry.edits);
      merged.set(key, target);
    }
    return [...merged.values()];
  }

  /** Fire the workspace.onDid* event that matches a finished user file operation. */
  fireDidFileOperation(kind: "create" | "delete" | "rename", files: HostFileOperation[]): void {
    const event = { files: this.#fileOperationFiles(kind, files) };
    if (kind === "create") this.onDidCreateFiles.fire(event);
    else if (kind === "delete") this.onDidDeleteFiles.fire(event);
    else this.onDidRenameFiles.fire(event);
  }

  /* ── messages from the view ──────────────────────────────────────────── */

  handleView(message: ViewToHost): void {
    switch (message.type) {
      case "documentOpen": {
        const data = message.doc;
        const existing = this.document(data.path);
        if (existing) {
          existing.open = true;
          existing.languageId = data.languageId;
          existing.isDirty = data.dirty;
          existing.setEol(data.eol);
          if (existing.getText() !== data.text) existing.setText(data.text, Math.max(existing.version + 1, data.version));
          else existing.version = Math.max(existing.version, data.version);
          void this.activateByEvent(`onLanguage:${data.languageId}`);
          return;
        }
        const document = new ExtHostDocument(data, true, (doc) => this.saveDocument(doc));
        this.documents.set(normalizeKey(data.path), document);
        void this.activateByEvent(`onLanguage:${data.languageId}`);
        this.onDidOpenTextDocument.fire(document.toApi());
        return;
      }
      case "documentChange": {
        const document = this.document(message.path);
        if (!document) return;
        const before = message.changes.map((change) => ({
          range: new T.Range(change.startLine, change.startCharacter, change.endLine, change.endCharacter),
          rangeOffset: change.rangeOffset,
          rangeLength: change.rangeLength,
          text: change.text,
        }));
        document.applyChanges(message.changes, message.version);
        document.isDirty = message.dirty;
        this.onDidChangeTextDocument.fire({ document: document.toApi(), contentChanges: before, reason: undefined });
        return;
      }
      case "documentDirty": {
        const document = this.document(message.path);
        if (document) document.isDirty = message.dirty;
        return;
      }
      case "documentClose": {
        const key = normalizeKey(message.path);
        const document = this.documents.get(key);
        if (!document) return;
        this.documents.delete(key);
        this.editors.delete(key);
        document.isClosed = true;
        document.open = false;
        this.onDidCloseTextDocument.fire(document.toApi());
        return;
      }
      case "documentSave": {
        const document = this.document(message.path);
        if (!document) return;
        document.isDirty = false;
        this.onDidSaveTextDocument.fire(document.toApi());
        return;
      }
      case "colorTheme": {
        const kind = COLOR_THEME_KINDS[message.kind];
        if (kind === this.colorThemeKind) break;
        this.colorThemeKind = kind;
        this.onDidChangeActiveColorTheme.fire({ kind });
        break;
      }
      case "activeEditor": {
        const previousVisible = this.visibleEditorKeys.join("\n");
        const previousActive = this.activeEditorKey;
        if (message.path) this.#ensureEditor(message.path, message.selections);
        for (const key of message.visible) this.#ensureEditor(key);
        for (const key of [...this.editors.keys()]) {
          if (!message.visible.some((visible) => normalizeKey(visible) === key) && key !== normalizeKey(message.path ?? "")) this.editors.delete(key);
        }
        this.activeEditorKey = message.path;
        this.visibleEditorKeys = message.visible;
        if (previousActive !== message.path) this.onDidChangeActiveTextEditor.fire(this.activeEditor());
        if (previousVisible !== message.visible.join("\n")) this.onDidChangeVisibleTextEditors.fire(this.visibleEditors());
        return;
      }
      case "selection": {
        const state = this.#ensureEditor(message.path, message.selections);
        this.onDidChangeTextEditorSelection.fire({
          textEditor: this.editorFacade(state),
          selections: state.selections,
          kind: T.TextEditorSelectionChangeKind.Keyboard,
        });
        return;
      }
      case "visibleRanges": {
        const state = this.#ensureEditor(message.path);
        state.visibleRanges = message.ranges.map((range) => ({ ...range }));
        this.onDidChangeTextEditorVisibleRanges.fire({
          textEditor: this.editorFacade(state),
          visibleRanges: state.visibleRanges.map((range) => new T.Range(range.startLine, range.startCharacter, range.endLine, range.endCharacter)),
        });
        return;
      }
      case "options": {
        const state = this.#ensureEditor(message.path);
        state.options = { tabSize: message.options.tabSize, insertSpaces: message.options.insertSpaces };
        const textEditor = this.editorFacade(state);
        this.onDidChangeTextEditorOptions.fire({ textEditor, options: textEditor.options });
        return;
      }
      case "configuration": {
        this.config = message.config;
        const changed = message.changed;
        this.onDidChangeConfiguration.fire({
          affectsConfiguration: (section: string) =>
            changed.some((key) => key === section || key.startsWith(`${section}.`) || section.startsWith(`${key}.`)),
        });
        return;
      }
      case "workspace": {
        const previous = this.workspace;
        this.workspace = message.root;
        if (previous === message.root) return;
        const folder = (root: string) => ({ uri: T.Uri.file(root), name: root.split(/[/\\]/).pop() ?? root, index: 0 });
        this.onDidChangeWorkspaceFolders.fire({ added: message.root ? [folder(message.root)] : [], removed: previous ? [folder(previous)] : [] });
        void this.#checkWorkspaceContains();
        return;
      }
      case "executeCommand":
        void this.executeCommand(message.command, message.args).catch((error: unknown) => {
          this.log("error", `command ${message.command} failed: ${errorMessage(error)}`);
          this.post({ type: "message", kind: "error", message: `Running the contributed command '${message.command}' failed: ${errorMessage(error)}` });
        });
        return;
      case "activate":
        void this.activateByEvent(message.event);
        return;
      case "reply": {
        const pending = this.#viewRequests.get(message.id);
        if (!pending) return;
        this.#viewRequests.delete(message.id);
        if (message.error !== undefined) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
        return;
      }
      case "quickPickEvent":
      case "inputBoxValue":
        this.quickInputs.get(message.id)?.(message);
        return;
      case "terminalClosed": {
        const terminal = this.terminals.get(message.id);
        if (terminal) {
          this.terminals.delete(message.id);
          terminal.closed();
          this.onDidCloseTerminal.fire(terminal.facade);
        }
        if (this.activeTerminalId === message.id) {
          this.activeTerminalId = null;
          this.activeTerminal = undefined;
          this.onDidChangeActiveTerminal.fire(undefined);
        }
        return;
      }
      case "activeTerminal": {
        if (message.id === this.activeTerminalId) return;
        this.activeTerminalId = message.id;
        this.activeTerminal = message.id ? this.terminals.get(message.id)?.facade : undefined;
        this.onDidChangeActiveTerminal.fire(this.activeTerminal);
        return;
      }
      case "focus":
        this.focused = message.focused;
        this.onDidChangeWindowState.fire({ focused: message.focused, active: message.focused });
        return;
      case "tabs":
        this.tabGroups.update(message.groups);
        return;
      case "webviewViewVisible":
        this.webviews.viewVisible(message.viewId, message.webviewId, message.state);
        return;
      case "webviewMessage":
        this.webviews.receive(message.id, message.message);
        return;
      case "webviewViewState":
        this.webviews.viewState(message.id, message.visible, message.active);
        return;
      case "webviewClosed":
        this.webviews.closed(message.id);
        return;
      case "treeEvent":
        this.trees.event(message.viewId, message.event, message.handles, message.checked);
        return;
      case "treeCommand":
        this.trees.command(message.viewId, message.command, message.handles);
        return;
      case "didFileOperation":
        this.fireDidFileOperation(message.kind, message.files);
        return;
      case "feature":
        try {
          const result = featureByArea(message.area)?.onViewMessage?.(this, message.payload);
          void Promise.resolve(result).catch((error: unknown) => this.log("error", `feature '${message.area}' failed: ${errorMessage(error)}`));
        } catch (error) {
          this.log("error", `feature '${message.area}' failed: ${errorMessage(error)}`);
        }
        return;
    }
  }

  handleMainReply(id: number, result: unknown, error?: string): void {
    const pending = this.#mainRequests.get(id);
    if (!pending) return;
    this.#mainRequests.delete(id);
    if (error !== undefined) pending.reject(new Error(error));
    else pending.resolve(result);
  }

  /* ── diagnostics ─────────────────────────────────────────────────────── */

  setDiagnostics(owner: string, uri: T.Uri, list: T.Diagnostic[] | undefined): void {
    let collection = this.diagnostics.get(owner);
    if (!collection) {
      collection = new Map();
      this.diagnostics.set(owner, collection);
    }
    const key = normalizeKey(keyOfUri(uri));
    if (list?.length) collection.set(key, { uri, list: [...list] });
    else collection.delete(key);
    this.post({ type: "diagnostics", owner, entries: [[keyOfUri(uri), (list ?? []).map(wireDiagnostic)]] });
    this.onDidChangeDiagnostics.fire({ uris: [uri] });
  }

  clearDiagnostics(owner: string): void {
    const collection = this.diagnostics.get(owner);
    const uris = collection ? [...collection.values()].map((entry) => entry.uri) : [];
    this.diagnostics.delete(owner);
    this.post({ type: "diagnostics", owner, entries: [], clear: true });
    if (uris.length) this.onDidChangeDiagnostics.fire({ uris });
  }
}

/* ── conversions ─────────────────────────────────────────────────────────── */

function wireSymbol(symbol: T.DocumentSymbol | T.SymbolInformation): WireSymbol {
  if ("location" in symbol && symbol.location) {
    const range = symbol.location.range;
    return { name: symbol.name, kind: SYMBOL_KINDS[symbol.kind] ?? "variable", ...wireRange(range), line: range.start.line, character: range.start.character };
  }
  const documentSymbol = symbol as T.DocumentSymbol;
  const selection = documentSymbol.selectionRange ?? documentSymbol.range;
  return {
    name: documentSymbol.name,
    kind: SYMBOL_KINDS[documentSymbol.kind] ?? "variable",
    ...wireRange(documentSymbol.range),
    line: selection.start.line,
    character: selection.start.character,
    children: documentSymbol.children?.length ? documentSymbol.children.map(wireSymbol) : undefined,
  };
}

/** A workspace symbol as sent to the view (the location is resolved later when it has no range). */
function wireWorkspaceSymbol(id: number, symbol: WorkspaceSymbolLike): HostWorkspaceSymbol {
  const location = symbol.location ? wireWorkspaceLocation(symbol) : null;
  const ranged = !!symbol.location?.range;
  return {
    id,
    name: symbol.name,
    kind: SYMBOL_KINDS[symbol.kind] ?? "variable",
    containerName: symbol.containerName || undefined,
    path: location?.path ?? "",
    line: ranged ? location?.line : undefined,
    character: ranged ? location?.character : undefined,
    endLine: ranged ? location?.endLine : undefined,
    endCharacter: ranged ? location?.endCharacter : undefined,
  };
}

/** The location of a workspace symbol (its range, or a point at the file's start when there is none). */
function wireWorkspaceLocation(symbol: WorkspaceSymbolLike): HostLocation | null {
  const uri = symbol.location?.uri ? T.Uri.revive(symbol.location.uri) : undefined;
  if (!uri) return null;
  const range = symbol.location?.range;
  if (!range) return { path: keyOfUri(uri), line: 0, character: 0 };
  return {
    path: keyOfUri(uri),
    line: range.start.line,
    character: range.start.character,
    endLine: range.end.line,
    endCharacter: range.end.character,
  };
}

/** A provider result that is a Command (or a CodeAction-shaped object) becomes a CodeAction. */
function codeActionOf(value: T.Command | T.CodeAction): T.CodeAction | null {
  if (!value || typeof value.title !== "string") return null;
  if (value instanceof T.CodeAction) return value;
  const bareCommand =
    typeof (value as T.Command).command === "string" &&
    !("edit" in value) &&
    !("kind" in value) &&
    !("isPreferred" in value) &&
    !("disabled" in value);
  if (bareCommand) {
    const action = new T.CodeAction(value.title);
    action.command = value as T.Command;
    return action;
  }
  // A CodeAction-shaped plain object (some extensions return them): keep it as is.
  return value as unknown as T.CodeAction;
}

const DIAGNOSTIC_SEVERITIES: Record<string, number> = { error: 0, warning: 1, info: 2, hint: 3 };

const COLOR_THEME_KINDS: Record<ColorThemeKind, number> = {
  light: T.ColorThemeKind.Light,
  dark: T.ColorThemeKind.Dark,
  hcDark: T.ColorThemeKind.HighContrast,
  hcLight: T.ColorThemeKind.HighContrastLight,
};

/** Diagnostics the view sent as provider context, as the API's Diagnostic objects. */
function reviveDiagnostics(diagnostics: WireDiagnostic[]): T.Diagnostic[] {
  return diagnostics.map((value) => {
    const diagnostic = new T.Diagnostic(
      new T.Range(value.startLine, value.startCharacter, value.endLine, value.endCharacter),
      value.message,
      DIAGNOSTIC_SEVERITIES[value.severity] ?? 0,
    );
    if (value.source !== undefined) diagnostic.source = value.source;
    if (value.code !== undefined) diagnostic.code = value.code;
    return diagnostic;
  });
}

/** A DocumentLink as sent to the view (the target as a URI string, if there is one). */
function wireDocumentLink(link: T.DocumentLink): HostDocumentLink {
  return { range: wireRange(link.range), target: link.target ? link.target.toString() : undefined, tooltip: link.tooltip };
}

/** A Color as sent to the view (plain numbers). */
function wireColor(color: T.Color): HostColor {
  return { red: color.red, green: color.green, blue: color.blue, alpha: color.alpha ?? 1 };
}

function convertCompletion(item: T.CompletionItem): HostCompletionItem {
  const label = typeof item.label === "string" ? item.label : item.label.label;
  const labelDetail = typeof item.label === "string" ? undefined : [item.label.detail, item.label.description].filter(Boolean).join(" ");
  const insert = item.insertText ?? label;
  const snippet = T.SnippetString.isSnippetString(insert);
  const range = item.range && "replacing" in item.range ? item.range.replacing : (item.range as T.Range | undefined);
  return {
    label,
    detail: item.detail ?? (labelDetail || undefined),
    documentation: item.documentation === undefined ? undefined : markdownOf(item.documentation),
    kind: item.kind === undefined ? undefined : COMPLETION_TYPES[item.kind],
    insertText: snippet ? insert.value : String(insert),
    snippet,
    range: range ? wireRange(range) : undefined,
    sortText: item.sortText,
    filterText: item.filterText,
    preselect: item.preselect,
    command: item.command ? { command: item.command.command, arguments: toWire(item.command.arguments) as unknown[] } : undefined,
    additionalTextEdits: item.additionalTextEdits?.map(wireEdit),
  };
}

function convertInlineCompletion(item: T.InlineCompletionItem): HostInlineCompletionItem {
  const insert = item.insertText;
  return {
    insertText: T.SnippetString.isSnippetString(insert) ? insert.value : String(insert ?? ""),
    range: item.range ? wireRange(item.range) : undefined,
    command: item.command ? { command: item.command.command, arguments: toWire(item.command.arguments) as unknown[] } : undefined,
  };
}

/** Parse a snippets file (JSON with comments / trailing commas). */
function loadSnippets(file: string): { prefix: string; body: string; description?: string; languages: string[] | null }[] {
  try {
    const raw = readFileSync(file, "utf8")
      .replace(/^\uFEFF/, "")
      .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match, string: string | undefined) => string ?? "")
      .replace(/,(\s*[}\]])/g, "$1");
    const data = JSON.parse(raw) as Record<string, { prefix?: string | string[]; body?: string | string[]; description?: string; scope?: string }>;
    const out: { prefix: string; body: string; description?: string; languages: string[] | null }[] = [];
    for (const [name, snippet] of Object.entries(data)) {
      if (!snippet || typeof snippet !== "object" || snippet.body === undefined) continue;
      const body = Array.isArray(snippet.body) ? snippet.body.join("\n") : String(snippet.body);
      const languages = snippet.scope ? snippet.scope.split(",").map((s) => s.trim()) : null;
      for (const prefix of [snippet.prefix ?? name].flat()) out.push({ prefix, body, description: snippet.description ?? name, languages });
    }
    return out;
  } catch {
    return [];
  }
}

/* ── module loading ──────────────────────────────────────────────────────── */

function resolveEntry(location: string, main: string): string {
  const base = resolve(location, main);
  for (const candidate of [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, join(base, "index.js")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`entry point not found: ${main}`);
}

async function loadModule(entry: string): Promise<unknown> {
  const require = Module.createRequire(entry);
  try {
    return require(entry);
  } catch (error) {
    // ESM with top-level await cannot be required: import it instead.
    if ((error as { code?: string }).code === "ERR_REQUIRE_ASYNC_MODULE" || (error as { code?: string }).code === "ERR_REQUIRE_ESM") {
      return await import(pathToFileURL(entry).href);
    }
    throw error;
  }
}

let hooksInstalled = false;
/** The host the (once-installed) module hooks resolve against (a worker runs one; tests rebind it). */
let hooksHost: ExtensionHost | null = null;

/** `require("lumen")` / `require("vscode")` / `import … from "lumen"` → the API of the importing extension. */
/**
 * Extensions run in a worker thread here, but in VS Code they run on a main
 * thread. Bundles that also contain worker code (js-debug, …) check
 * `isMainThread` / `parentPort` at load time and would otherwise answer the
 * host's own messages. Extension code gets a main-thread view of the module.
 */
const WORKER_THREADS = new Set(["worker_threads", "node:worker_threads"]);
let mainThreadView: Record<string, unknown> | null = null;
function workerThreadsForExtensions(): Record<string, unknown> {
  mainThreadView ??= { ...(workerThreadsModule as unknown as Record<string, unknown>), isMainThread: true, parentPort: null, workerData: null, threadId: 0 };
  return mainThreadView;
}

function installModuleHooks(host: ExtensionHost): void {
  hooksHost = host;
  if (hooksInstalled) return;
  hooksInstalled = true;
  const moduleInternals = Module as unknown as { _load: (request: string, parent: { filename?: string } | null, isMain: boolean) => unknown };
  const originalLoad = moduleInternals._load;
  const warned = new Set<string>();
  moduleInternals._load = function (request, parent, isMain) {
    if (request === "lumen" || request === "vscode") {
      const active = hooksHost!;
      const runtime = active.runtimeForFile(parent?.filename);
      if (request === "vscode" && runtime && runtime.description.kind === "lumen" && !warned.has(runtime.id)) {
        warned.add(runtime.id);
        active.log("info", 'imports "vscode"; served by the compatibility layer', runtime.id);
      }
      return active.apiFor(runtime);
    }
    if (WORKER_THREADS.has(request) && hooksHost!.runtimeForFile(parent?.filename)) return workerThreadsForExtensions();
    return originalLoad.call(this, request, parent, isMain);
  };

  (globalThis as Record<symbol, unknown>)[WORKER_THREADS_GLOBAL] = workerThreadsForExtensions;
  (globalThis as Record<symbol, unknown>)[API_GLOBAL] = (id: string) => {
    const active = hooksHost!;
    return active.apiFor(active.runtimes.get(id) ?? null);
  };
  const registerHooks = (Module as unknown as { registerHooks?: (hooks: object) => unknown }).registerHooks;
  registerHooks?.({
    resolve(specifier: string, context: { parentURL?: string }, next: (specifier: string, context: unknown) => unknown) {
      if (specifier === "lumen" || specifier === "vscode") {
        const runtime = hooksHost!.runtimeForFile(context.parentURL);
        return { url: `lumen-api:${encodeURIComponent(runtime?.id.toLowerCase() ?? "")}`, shortCircuit: true };
      }
      if (WORKER_THREADS.has(specifier) && hooksHost!.runtimeForFile(context.parentURL)) return { url: "lumen-worker-threads:", shortCircuit: true };
      return next(specifier, context);
    },
    load(url: string, context: unknown, next: (url: string, context: unknown) => unknown) {
      if (url.startsWith("lumen-api:")) {
        const id = decodeURIComponent(url.slice("lumen-api:".length));
        const active = hooksHost!;
        const names = Object.keys(active.apiFor(active.runtimes.get(id) ?? null)).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
        const source =
          `const api = globalThis[Symbol.for("lumen.extensionApi")](${JSON.stringify(id)});\n` +
          `export default api;\n` +
          `export const { ${names.join(", ")} } = api;\n`;
        return { format: "module", source, shortCircuit: true };
      }
      if (url === "lumen-worker-threads:") {
        const names = Object.keys(workerThreadsForExtensions()).filter((name) => /^[A-Za-z_$][w$]*$/.test(name));
        const source =
          `const wt = globalThis[Symbol.for("lumen.workerThreads")]();
` +
          `export default wt;
` +
          `export const { ${names.join(", ")} } = wt;
`;
        return { format: "module", source, shortCircuit: true };
      }
      return next(url, context);
    },
  });
}

/**
 * Tell the main process which extension started each child process: spawn,
 * exec, execFile and fork all go through ChildProcess#spawn, and the
 * innermost extension file on the caller's stack names the extension.
 */
function trackChildProcesses(host: ExtensionHost): void {
  const prototype = ChildProcess.prototype as unknown as { spawn: (this: ChildProcess, options: unknown) => unknown };
  const spawn = prototype.spawn;
  prototype.spawn = function (this: ChildProcess, options: unknown) {
    const result = spawn.call(this, options);
    if (this.pid) {
      const extensionId = callingExtension(host);
      if (extensionId) host.send({ type: "childProcess", pid: this.pid, extensionId });
    }
    return result;
  };
}

function callingExtension(host: ExtensionHost): string | null {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 64;
  const stack = new Error().stack ?? "";
  Error.stackTraceLimit = limit;
  // "    at name (C:\path\file.js:1:2)", "    at file:///path/file.mjs:1:2"
  for (const match of stack.matchAll(/^\s*at (?:.*\()?((?:file:\/\/|[A-Za-z]:[\\/]|\/).+?):\d+:\d+\)?$/gm)) {
    const runtime = host.runtimeForFile(match[1]);
    if (runtime) return runtime.id;
  }
  return null;
}

/* ── worker entry ────────────────────────────────────────────────────────── */

const consoleOriginal = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };

export async function runExtensionHost(): Promise<void> {
  if (!parentPort) return;
  const host = new ExtensionHost();
  trackChildProcesses(host);
  const { format } = await import("util");
  // Extensions' console output also goes to the "Extension Host" output channel.
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    console[level] = (...args: unknown[]) => {
      consoleOriginal[level](...args);
      try {
        const mapped = level === "warn" ? "warning" : level === "error" ? "error" : level === "debug" ? "debug" : "info";
        host.log(mapped, format(...args));
      } catch {
        /* never break logging */
      }
    };
  }
  process.on("unhandledRejection", (reason) => host.log("error", `unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : reason}`));
  process.on("uncaughtException", (error) => host.log("error", `uncaught exception: ${error.stack ?? error.message}`));

  parentPort.on("message", (message: MainToHost) => {
    switch (message.type) {
      case "init":
        void host.start(message.init);
        break;
      case "view":
        host.handleView(message.message);
        break;
      case "call": {
        const method = host.methods[message.method] as (...args: unknown[]) => Promise<unknown>;
        void Promise.resolve()
          .then(() => method(...message.args))
          .then(
            (result) => host.send({ type: "callResult", id: message.id, result: toWire(result) }),
            (error: unknown) => host.send({ type: "callResult", id: message.id, error: errorMessage(error) }),
          );
        break;
      }
      case "mainReply":
        host.handleMainReply(message.id, message.result, message.error);
        break;
      case "filesChanged":
        host.filesChanged(message.paths);
        break;
      case "shutdown":
        void host.deactivateAll().finally(() => host.send({ type: "shutdownDone" }));
        break;
    }
  });
}

