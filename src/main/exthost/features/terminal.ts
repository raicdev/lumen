import { readFile } from "node:fs/promises";
import type { ExtensionHost } from "../host.ts";
import type { HostFeature } from "./contract.ts";
import * as T from "../types.ts";
import { normalizeKey } from "../documents.ts";
import { CommandLineConfidence, ShellIntegrationModel, shellTypeOf } from "./terminal/shell.ts";
import type { ShellExecution } from "./terminal/shell.ts";
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  ResolvedProfileWire,
  TerminalHostMessage,
  TerminalIconWire,
  TerminalLinkWire,
  TerminalViewMessage,
} from "../../../shared/terminal-protocol.ts";
import { TERMINAL_AREA } from "../../../shared/terminal-protocol.ts";
import type { TerminalSpawnSpec } from "../../../shared/terminal-spawn.ts";

/**
 * Terminals for extensions: pseudo-terminals (`createTerminal({ pty })`), link
 * providers, profile providers, terminal state and shell integration events.
 * Shell terminals are made by the window (lib/terminals.ts); this side keeps a
 * `Terminal` object per window terminal and talks to features/terminal.tsx.
 */

export class TerminalProfile {
  options: unknown;
  constructor(options: unknown) {
    this.options = options;
  }
}

export class TerminalLink {
  startIndex: number;
  length: number;
  tooltip?: string;
  constructor(startIndex: number, length: number, tooltip?: string) {
    this.startIndex = startIndex;
    this.length = length;
    this.tooltip = tooltip;
  }
}

const TerminalShellExecutionCommandLineConfidence = CommandLineConfidence;

type Dimensions = { columns: number; rows: number };

/** vscode.Pseudoterminal */
type Pseudoterminal = {
  onDidWrite: T.Event<string>;
  onDidOverrideDimensions?: T.Event<Dimensions | undefined>;
  onDidClose?: T.Event<number | void>;
  onDidChangeName?: T.Event<string>;
  open(initialDimensions: Dimensions | undefined): void;
  close(): void;
  handleInput?(data: string): void;
  setDimensions?(dimensions: Dimensions): void;
};

type TerminalState = { readonly isInteractedWith: boolean; readonly shell: string | undefined };

type Record_ = {
  extensionId: string;
  facade: Record<string, unknown>;
  viewId: string | undefined;
  /** Resolves with the window's terminal id once it exists. */
  ready: Promise<string>;
  name: string;
  creationOptions: unknown;
  exit: { code: number | undefined; reason: number } | undefined;
  state: TerminalState;
  pid: Promise<number | undefined>;
  resolvePid: (pid: number | undefined) => void;
  pty: Pseudoterminal | undefined;
  ptySubscriptions: T.Disposable[];
  ptyClosed: boolean;
  /** `dispose()` was called by the extension. */
  disposing: boolean;
  closed: boolean;
  model: ShellIntegrationModel | undefined;
};

type FeatureState = {
  records: Map<string, Record_>;
  byFacade: WeakMap<object, Record_>;
  linkProviders: Map<number, { extensionId: string; provider: any }>;
  linkProviderSeq: number;
  links: Map<string, { provider: any; link: unknown }>;
  linkSeq: number;
  profileProviders: Map<string, { extensionId: string; provider: any }>;
  onDidChangeState: T.EventEmitter<unknown>;
  onDidChangeShellIntegration: T.EventEmitter<unknown>;
  onDidStartExecution: T.EventEmitter<unknown>;
  onDidEndExecution: T.EventEmitter<unknown>;
  onDidChangeViewColumn: T.EventEmitter<unknown>;
  columns: Map<string, number>;
};

const states = new WeakMap<ExtensionHost, FeatureState>();

function stateOf(host: ExtensionHost): FeatureState {
  let state = states.get(host);
  if (!state) {
    state = {
      records: new Map(),
      byFacade: new WeakMap(),
      linkProviders: new Map(),
      linkProviderSeq: 0,
      links: new Map(),
      linkSeq: 0,
      profileProviders: new Map(),
      onDidChangeState: new T.EventEmitter(),
      onDidChangeShellIntegration: new T.EventEmitter(),
      onDidStartExecution: new T.EventEmitter(),
      onDidEndExecution: new T.EventEmitter(),
      onDidChangeViewColumn: new T.EventEmitter(),
      columns: new Map(),
    };
    states.set(host, state);
  }
  return state;
}

const MAX_LINKS = 400;
const LINK_TIMEOUT_MS = 2000;
const MAX_ICON_BYTES = 512 * 1024;
const IMAGE_TYPES: Record<string, string> = { svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

const post = (host: ExtensionHost, message: TerminalHostMessage) => host.postFeature(TERMINAL_AREA, message);

/* ── records ─────────────────────────────────────────────────────────────── */

function newRecord(host: ExtensionHost, state: FeatureState, extensionId: string, name: string, creationOptions: unknown, pty?: Pseudoterminal): Record_ {
  let resolvePid: (pid: number | undefined) => void = () => {};
  const pid = new Promise<number | undefined>((resolve) => (resolvePid = resolve));
  const record: Record_ = {
    extensionId,
    facade: {},
    viewId: undefined,
    ready: Promise.reject(new Error("terminal not created")),
    name,
    creationOptions,
    exit: undefined,
    state: { isInteractedWith: false, shell: undefined },
    pid,
    resolvePid,
    pty,
    ptySubscriptions: [],
    ptyClosed: false,
    disposing: false,
    closed: false,
    model: undefined,
  };
  record.ready.catch(() => {});
  if (pty) resolvePid(undefined);
  Object.defineProperties(record.facade, {
    name: { get: () => record.name, enumerable: true },
    processId: { get: () => record.pid, enumerable: true },
    creationOptions: { get: () => record.creationOptions, enumerable: true },
    exitStatus: { get: () => record.exit, enumerable: true },
    state: { get: () => record.state, enumerable: true },
    shellIntegration: { get: () => (record.model?.detected ? record.model.api : undefined), enumerable: true },
    sendText: {
      value: (text: string, addNewLine = true) => {
        if (record.pty) {
          record.pty.handleInput?.(addNewLine ? `${text}\r` : text);
          return;
        }
        void record.ready.then((id) => host.requestView("terminalSendText", id, text, addNewLine)).catch(() => {});
      },
    },
    show: {
      value: (preserveFocus = false) => {
        void record.ready
          .then(async (id) => {
            await host.requestFeatureView(TERMINAL_AREA, "reveal", [id]);
            await host.requestView("terminalShow", id, preserveFocus);
          })
          .catch(() => {});
      },
    },
    // The panel is shared by all terminals and Lumen has no way to hide it from here: a no-op.
    hide: { value: () => {} },
    dispose: { value: () => disposeRecord(host, record) },
  });
  state.byFacade.set(record.facade, record);
  return record;
}

/** The window's terminal `id` exists: make it visible to the API (`window.terminals`, onDidOpenTerminal). */
function registerRecord(host: ExtensionHost, state: FeatureState, record: Record_, id: string) {
  record.viewId = id;
  record.ready = Promise.resolve(id);
  state.records.set(id, record);
  host.terminals.set(id, { facade: record.facade, closed: () => markClosed(record) });
  if (host.activeTerminalId === id && host.activeTerminal !== record.facade) host.activeTerminal = record.facade;
  host.onDidOpenTerminal.fire(record.facade);
}

function markClosed(record: Record_) {
  if (record.closed) return;
  record.closed = true;
  record.exit ??= { code: undefined, reason: record.disposing ? T.TerminalExitReason.Extension : T.TerminalExitReason.User };
  closePty(record);
  record.model?.dispose();
}

function closePty(record: Record_) {
  const pty = record.pty;
  if (!pty) return;
  for (const subscription of record.ptySubscriptions.splice(0)) subscription.dispose();
  if (record.ptyClosed) return;
  record.ptyClosed = true;
  try {
    pty.close();
  } catch (error) {
    console.error("[extension host] Pseudoterminal.close failed:", error);
  }
}

function disposeRecord(host: ExtensionHost, record: Record_) {
  if (record.disposing) return;
  record.disposing = true;
  closePty(record);
  void record.ready.then((id) => host.requestView("terminalDispose", id)).catch(() => {});
}

/** The window closed terminal `id` (or told us after the fact): the same as the host's `terminalClosed`. */
function closeRecord(host: ExtensionHost, state: FeatureState, id: string) {
  const record = state.records.get(id);
  state.records.delete(id);
  const entry = host.terminals.get(id);
  if (entry) {
    host.terminals.delete(id);
    entry.closed();
    host.onDidCloseTerminal.fire(entry.facade);
  }
  if (record && !entry) markClosed(record);
  if (host.activeTerminalId === id) {
    host.activeTerminalId = null;
    host.activeTerminal = undefined;
    host.onDidChangeActiveTerminal.fire(undefined);
  }
}

function setState(state: FeatureState, record: Record_, patch: Partial<{ isInteractedWith: boolean; shell: string | undefined }>) {
  const next = { ...record.state, ...patch };
  if (next.isInteractedWith === record.state.isInteractedWith && next.shell === record.state.shell) return;
  record.state = next;
  state.onDidChangeState.fire(record.facade);
}

/* ── pseudo-terminals ────────────────────────────────────────────────────── */

function bindPty(host: ExtensionHost, record: Record_, id: string, size: { cols: number; rows: number } | undefined) {
  const pty = record.pty;
  if (!pty) return;
  const subscribe = (event: T.Event<any> | undefined, listener: (value: any) => void) => {
    if (typeof event === "function") record.ptySubscriptions.push(event(listener));
  };
  subscribe(pty.onDidWrite, (data) => post(host, { kind: "write", id, data: String(data) }));
  subscribe(pty.onDidOverrideDimensions, (dimensions: Dimensions | undefined) =>
    post(host, { kind: "dimensions", id, cols: dimensions?.columns, rows: dimensions?.rows }),
  );
  subscribe(pty.onDidChangeName, (name: string) => {
    record.name = String(name);
    post(host, { kind: "title", id, title: record.name });
  });
  subscribe(pty.onDidClose, (code: number | void) => {
    if (record.closed) return;
    record.ptyClosed = true;
    record.exit = { code: typeof code === "number" ? code : undefined, reason: T.TerminalExitReason.Process };
    // The window closes it like the user would (tab, empty panel); its "closed" message follows.
    void host.requestView("terminalDispose", id).catch(() => {});
  });
  try {
    pty.open(size ? { columns: size.cols, rows: size.rows } : undefined);
  } catch (error) {
    host.log("error", `Pseudoterminal.open failed: ${error instanceof Error ? error.message : String(error)}`, record.extensionId);
  }
}

/* ── options ─────────────────────────────────────────────────────────────── */

async function iconOf(iconPath: any): Promise<TerminalIconWire | undefined> {
  if (!iconPath) return undefined;
  if (typeof iconPath.id === "string") return { kind: "codicon", id: iconPath.id };
  const target = T.Uri.isUri(iconPath) ? iconPath : (iconPath.dark ?? iconPath.light);
  if (!T.Uri.isUri(target)) return undefined;
  if (target.scheme === "http" || target.scheme === "https" || target.scheme === "data") return { kind: "image", src: target.toString(true) };
  try {
    const type = IMAGE_TYPES[(target.fsPath.split(".").pop() ?? "").toLowerCase()];
    if (!type) return undefined;
    const bytes = await readFile(target.fsPath);
    if (bytes.length > MAX_ICON_BYTES) return undefined;
    return { kind: "image", src: `data:${type};base64,${bytes.toString("base64")}` };
  } catch {
    return undefined;
  }
}

function colorOf(color: any): string | undefined {
  return color && typeof color.id === "string" ? color.id : undefined;
}

function spawnOf(options: any): TerminalSpawnSpec | undefined {
  const spec: TerminalSpawnSpec = {};
  if (typeof options.shellPath === "string" && options.shellPath) spec.shellPath = options.shellPath;
  if (Array.isArray(options.shellArgs)) spec.shellArgs = options.shellArgs.map(String);
  else if (typeof options.shellArgs === "string") spec.shellArgs = options.shellArgs;
  if (options.env && typeof options.env === "object") {
    spec.env = {};
    for (const [key, value] of Object.entries(options.env)) {
      if (value === null) spec.env[key] = null;
      else if (value !== undefined) spec.env[key] = String(value);
    }
  }
  if (options.strictEnv) spec.strictEnv = true;
  if (typeof options.shellIntegrationNonce === "string" && options.shellIntegrationNonce) spec.nonce = options.shellIntegrationNonce;
  return Object.keys(spec).length ? spec : undefined;
}

function cwdOf(cwd: unknown): string | undefined {
  if (typeof cwd === "string") return cwd;
  return T.Uri.isUri(cwd) ? cwd.fsPath : undefined;
}

/* ── links ───────────────────────────────────────────────────────────────── */

async function provideLinks(host: ExtensionHost, state: FeatureState, id: string, line: string): Promise<TerminalLinkWire[]> {
  const record = state.records.get(id);
  if (!record) return [];
  const out: TerminalLinkWire[] = [];
  for (const { extensionId, provider } of [...state.linkProviders.values()]) {
    const source = new T.CancellationTokenSource();
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          source.cancel();
          resolve(undefined);
        }, LINK_TIMEOUT_MS);
      });
      const result = (await Promise.race([Promise.resolve(provider.provideTerminalLinks({ line, terminal: record.facade }, source.token)), timeout])) as unknown;
      clearTimeout(timer);
      if (!Array.isArray(result)) continue;
      for (const link of result as any[]) {
        if (!link || !Number.isInteger(link.startIndex) || !Number.isInteger(link.length) || link.length <= 0) continue;
        const linkId = String(++state.linkSeq);
        state.links.set(linkId, { provider, link });
        out.push({ linkId, startIndex: link.startIndex, length: link.length, tooltip: typeof link.tooltip === "string" ? link.tooltip : undefined });
      }
    } catch (error) {
      host.log("warning", `terminal link provider failed: ${error instanceof Error ? error.message : String(error)}`, extensionId);
    } finally {
      source.dispose();
    }
  }
  while (state.links.size > MAX_LINKS) state.links.delete(state.links.keys().next().value!);
  return out;
}

function activateLink(host: ExtensionHost, state: FeatureState, linkId: string) {
  const entry = state.links.get(linkId);
  if (!entry) return;
  try {
    void Promise.resolve(entry.provider.handleTerminalLink(entry.link)).catch((error: unknown) => host.log("error", `handleTerminalLink failed: ${String(error)}`));
  } catch (error) {
    host.log("error", `handleTerminalLink failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* ── profiles ────────────────────────────────────────────────────────────── */

async function resolveProfile(host: ExtensionHost, state: FeatureState, profileId: string, viewId: string, size?: { cols: number; rows: number }): Promise<ResolvedProfileWire | null> {
  const id = profileId.replace(/^ext:/, "");
  await host.activateByEvent(`onTerminalProfile:${id}`);
  const entry = state.profileProviders.get(id);
  if (!entry) {
    host.log("warning", `no terminal profile provider registered for '${id}'`);
    return null;
  }
  const source = new T.CancellationTokenSource();
  let profile: any;
  try {
    profile = await entry.provider.provideTerminalProfile(source.token);
  } finally {
    source.dispose();
  }
  const options = profile?.options;
  if (!options || typeof options !== "object") return null;
  let record = state.records.get(viewId);
  if (!record) {
    record = newRecord(host, state, entry.extensionId, options.name ?? id, options, options.pty);
    registerRecord(host, state, record, viewId);
  }
  record.creationOptions = options;
  if (typeof options.name === "string") record.name = options.name;
  const common = { title: typeof options.name === "string" ? options.name : undefined, cwd: cwdOf(options.cwd), icon: await iconOf(options.iconPath), color: colorOf(options.color) };
  if (options.pty) {
    record.pty = options.pty;
    record.resolvePid(undefined);
    bindPty(host, record, viewId, size);
    return { ...common, pty: true };
  }
  return { ...common, spawn: spawnOf(options) };
}

/* ── shell integration ───────────────────────────────────────────────────── */

function modelOf(host: ExtensionHost, state: FeatureState, record: Record_): ShellIntegrationModel {
  if (record.model) return record.model;
  const terminal = record.facade;
  const model: ShellIntegrationModel = new ShellIntegrationModel({
    send: (text) => void record.ready.then((id) => host.requestView("terminalSendText", id, text, false)).catch(() => {}),
    shell: () => record.state.shell,
    changed: () => state.onDidChangeShellIntegration.fire({ terminal, shellIntegration: model.api }),
    started: (execution: ShellExecution) => state.onDidStartExecution.fire({ terminal, shellIntegration: model.api, execution }),
    ended: (execution: ShellExecution, exitCode: number | undefined) => state.onDidEndExecution.fire({ terminal, shellIntegration: model.api, execution, exitCode }),
  });
  record.model = model;
  return model;
}

/* ── editors' view columns ───────────────────────────────────────────────── */

function visibleColumns(host: ExtensionHost): Map<string, number> {
  const columns = new Map<string, number>();
  for (const group of host.tabGroups.all) {
    const path = group.activeTab?.viewPath();
    if (path) columns.set(normalizeKey(path), group.viewColumn);
  }
  return columns;
}

function trackViewColumns(host: ExtensionHost, state: FeatureState) {
  state.columns = visibleColumns(host);
  const update = () => {
    const next = visibleColumns(host);
    const previous = state.columns;
    state.columns = next;
    for (const [key, viewColumn] of next) {
      const before = previous.get(key);
      if (before === undefined || before === viewColumn) continue;
      const editor = host.editors.get(key);
      if (editor) state.onDidChangeViewColumn.fire({ textEditor: host.editorFacade(editor), viewColumn });
    }
  };
  host.tabGroups.onDidChangeTabGroups.event(update);
  host.tabGroups.onDidChangeTabs.event(update);
}

/* ── the feature ─────────────────────────────────────────────────────────── */

function handleViewMessage(host: ExtensionHost, state: FeatureState, message: TerminalViewMessage) {
  const record = "id" in message ? state.records.get(message.id) : undefined;
  switch (message.kind) {
    case "opened": {
      if (state.records.has(message.id)) return;
      const created = newRecord(host, state, "unknown", message.name, {});
      registerRecord(host, state, created, message.id);
      return;
    }
    case "started": {
      if (!record) return;
      // A fresh shell process: the old integration state is stale.
      record.model?.dispose();
      record.model = undefined;
      record.resolvePid(message.pid);
      setState(state, record, { shell: shellTypeOf(message.shell) });
      return;
    }
    case "exited":
      if (record) record.exit = { code: message.code ?? undefined, reason: T.TerminalExitReason.Process };
      return;
    case "closed":
      if (record && message.code !== undefined && message.code !== null && !record.exit) record.exit = { code: message.code, reason: T.TerminalExitReason.Process };
      closeRecord(host, state, message.id);
      return;
    case "interacted":
      if (record) setState(state, record, { isInteractedWith: true });
      return;
    case "input":
      if (record?.pty && !record.ptyClosed) record.pty.handleInput?.(message.data);
      return;
    case "resized":
      if (record?.pty && !record.ptyClosed) record.pty.setDimensions?.({ columns: message.cols, rows: message.rows });
      return;
    case "name":
      if (record) record.name = message.name;
      return;
    case "shell":
      if (record && !record.pty) modelOf(host, state, record).handle(message.event);
      return;
    case "linkActivated":
      activateLink(host, state, message.linkId);
      return;
  }
}

export const terminalFeature: HostFeature = {
  area: TERMINAL_AREA,

  api: ({ host, extensionId }) => {
    const state = stateOf(host);

    function createTerminal(nameOrOptions?: any, shellPath?: string, shellArgs?: string[] | string) {
      const options = typeof nameOrOptions === "object" && nameOrOptions ? nameOrOptions : { name: nameOrOptions, shellPath, shellArgs };
      const pty = options.pty as Pseudoterminal | undefined;
      if (pty && (typeof pty.onDidWrite !== "function" || typeof pty.open !== "function")) {
        throw new Error("createTerminal: a Pseudoterminal needs onDidWrite and open");
      }
      const record = newRecord(host, state, extensionId, options.name ?? "terminal", options, pty);
      record.ready = (async () => {
        const location = options.location;
        let splitWith: string | undefined;
        if (location && typeof location === "object" && location.parentTerminal) {
          const parent = state.byFacade.get(location.parentTerminal);
          splitWith = parent ? await parent.ready.catch(() => undefined) : undefined;
        }
        // TerminalEditorLocationOptions: { viewColumn, preserveFocus? }.
        const editorOptions = !!location && typeof location === "object" && !location.parentTerminal && ("viewColumn" in location || "preserveFocus" in location) ? location : undefined;
        const editor = location === T.TerminalLocation.Editor || !!editorOptions;
        const request: CreateTerminalRequest = {
          name: options.name,
          cwd: cwdOf(options.cwd),
          location: editor ? "editor" : "panel",
          splitWith,
          spawn: pty ? undefined : spawnOf(options),
          pty: !!pty,
          message: typeof options.message === "string" ? options.message : undefined,
          hidden: !!options.hideFromUser,
          transient: !!options.isTransient,
          icon: await iconOf(options.iconPath),
          color: colorOf(options.color),
          viewColumn: editor && typeof editorOptions?.viewColumn === "number" ? editorOptions.viewColumn : undefined,
          preserveFocus: editor && editorOptions?.preserveFocus === true ? true : undefined,
        };
        const response = (await host.requestFeatureView(TERMINAL_AREA, "create", [request])) as CreateTerminalResponse;
        registerRecord(host, state, record, response.id);
        if (record.disposing) void host.requestView("terminalDispose", response.id).catch(() => {});
        else if (pty) bindPty(host, record, response.id, { cols: response.cols, rows: response.rows });
        return response.id;
      })();
      record.ready.catch((error) => {
        record.exit ??= { code: undefined, reason: T.TerminalExitReason.Unknown };
        host.log("error", `createTerminal failed: ${error instanceof Error ? error.message : String(error)}`, extensionId);
      });
      host.activeTerminal = record.facade;
      return record.facade;
    }

    return {
      window: {
        createTerminal,
        onDidChangeTerminalState: state.onDidChangeState.event,
        onDidChangeTerminalShellIntegration: state.onDidChangeShellIntegration.event,
        onDidStartTerminalShellExecution: state.onDidStartExecution.event,
        onDidEndTerminalShellExecution: state.onDidEndExecution.event,
        onDidChangeTextEditorViewColumn: state.onDidChangeViewColumn.event,
        registerTerminalLinkProvider(provider: any) {
          if (!provider || typeof provider.provideTerminalLinks !== "function") throw new Error("registerTerminalLinkProvider: provideTerminalLinks is required");
          const key = ++state.linkProviderSeq;
          state.linkProviders.set(key, { extensionId, provider });
          post(host, { kind: "linkProviders", count: state.linkProviders.size });
          return new T.Disposable(() => {
            state.linkProviders.delete(key);
            post(host, { kind: "linkProviders", count: state.linkProviders.size });
          });
        },
        registerTerminalProfileProvider(id: string, provider: any) {
          if (!provider || typeof provider.provideTerminalProfile !== "function") throw new Error("registerTerminalProfileProvider: provideTerminalProfile is required");
          const entry = { extensionId, provider };
          state.profileProviders.set(String(id), entry);
          return new T.Disposable(() => {
            if (state.profileProviders.get(String(id)) === entry) state.profileProviders.delete(String(id));
          });
        },
      },
    };
  },

  types: {
    TerminalProfile,
    TerminalLink,
    TerminalShellExecutionCommandLineConfidence,
  },

  init(host) {
    trackViewColumns(host, stateOf(host));
  },

  // terminal/context and terminal/title/context: the `Terminal` of a window terminal id.
  menuArg(host, ref) {
    return host.terminals.get(String(ref.id))?.facade;
  },

  onViewMessage(host, payload) {
    if (!payload || typeof payload !== "object") return;
    handleViewMessage(host, stateOf(host), payload as TerminalViewMessage);
  },

  async onViewRequest(host, method, args) {
    const state = stateOf(host);
    switch (method) {
      case "links":
        return provideLinks(host, state, String(args[0]), String(args[1]));
      case "show":
        return host.requestView("terminalShow", String(args[0]), false);
      case "resolveProfile":
        return resolveProfile(host, state, String(args[0]), String(args[1]), (args[2] as { cols: number; rows: number } | null) ?? undefined);
      default:
        throw new Error(`terminal: unknown request '${method}'`);
    }
  },
};
