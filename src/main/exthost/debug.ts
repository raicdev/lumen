import { spawn } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { connect } from "net";
import { homedir } from "os";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "path";
import type {
  HostDebugBreakpoint,
  HostDebugCompound,
  HostDebugConfiguration,
  HostDebugConfigurations,
  HostDebugEvaluateResult,
  HostDebugExceptionFilter,
  HostDebugScope,
  HostDebugSession,
  HostDebugSessionState,
  HostDebugSetBreakpoint,
  HostDebugSource,
  HostDebugStackFrame,
  HostDebugThread,
  HostDebugVariable,
} from "../../shared/extensions.ts";
import { normalizeKey } from "./documents.ts";
import type { ExtensionHost, ExtensionRuntime } from "./host.ts";
import * as T from "./types.ts";
import { parseJsonc } from "../../shared/jsonc.ts";

/**
 * Debugging: the host's side of the `vscode.debug` API and a Debug Adapter
 * Protocol (DAP) client. One manager per extension host.
 *
 * ── RPC surface the view can call (through extensionService.call) ───────────
 *
 *   debugListConfigurations(folder, initial?)  → { configurations, compounds, error? }
 *   debugStart(folder, name)                   → { sessionId?, error? }
 *   debugStartConfiguration(folder, config)    → { sessionId?, error? }
 *   debugStop(sessionId | null)                → boolean
 *   debugRestart(sessionId)                    → { sessionId?, error? }
 *   debugResume(sessionId, threadId)           → boolean
 *   debugPause(sessionId, threadId)            → boolean
 *   debugStep(sessionId, threadId, kind)       → boolean   (kind: next|in|out)
 *   debugThreads(sessionId)                    → { id, name }[]
 *   debugStackTrace(sessionId, threadId, startFrame, levels) → HostDebugStackFrame[]
 *   debugScopes(sessionId, frameId)            → { name, variablesReference, expensive }[]
 *   debugVariables(sessionId, ref, filter?, start?, count?) → HostDebugVariable[]
 *   debugSetVariable(sessionId, ref, name, value) → HostDebugVariable | null
 *   debugEvaluate(sessionId, expr, frameId, context) → { result, type?, variablesReference } | null
 *   debugCustomRequest(sessionId, command, args) → unknown
 *   debugSetBreakpoints(path, [{ line, enabled?, condition?, hitCondition?, logMessage? }])
 *                                              → HostDebugBreakpoint[]
 *   debugToggleBreakpoint(path, line)          → HostDebugBreakpoint[]
 *   debugSetBreakpointEnabled(id, enabled)     → HostDebugBreakpoint[]
 *   debugEditBreakpoint(id, changes)           → HostDebugBreakpoint[]
 *   debugRemoveAllBreakpoints()                → HostDebugBreakpoint[]
 *   debugSetExceptionBreakpoints(sessionId, filters) → boolean
 *   debugLoadedSources(sessionId)              → { name?, path?, sourceReference? }[]
 *
 * Events pushed to the view (HostToView):
 *   debugSessions     { sessions: HostDebugSession[] }
 *   debugActiveSession{ sessionId: string | null }
 *   debugStopped      { stopped: { sessionId, threadId, reason, description?, path?, line?, column?, frameId? } }
 *   debugContinued    { sessionId, threadId?, allThreadsContinued? }
 *   debugOutput       { output: { sessionId, category, text, path?, line?, column? } }
 *   debugBreakpoints  { breakpoints: HostDebugBreakpoint[] }
 *   debugCapabilities { capabilities: { sessionId, capabilities, exceptionBreakpointFilters } }
 *   debugCustomEvent  { event: { sessionId, event, body } }
 *   debugActiveStackItem { sessionId: string | null, threadId?, frameId? }
 *
 * The host owns the breakpoints and persists them per workspace under
 * <userData>/debugState/<workspace-hash>.json, so they survive restarts.
 */

/* ── DAP framing ─────────────────────────────────────────────────────────── */

/** Incrementally reads `Content-Length`-framed JSON messages from a byte stream. */
class FrameParser {
  #buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const messages: unknown[] = [];
    for (;;) {
      const separator = this.#buffer.indexOf("\r\n\r\n");
      if (separator < 0) break;
      const header = this.#buffer.subarray(0, separator).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(header);
      const start = separator + 4;
      if (!match) {
        this.#buffer = this.#buffer.subarray(start);
        continue;
      }
      const length = Number(match[1]);
      if (this.#buffer.length < start + length) break;
      const body = this.#buffer.subarray(start, start + length).toString("utf8");
      this.#buffer = this.#buffer.subarray(start + length);
      try {
        messages.push(JSON.parse(body));
      } catch {
        /* malformed frame: skip it */
      }
    }
    return messages;
  }
}

export function encodeDapMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

/** What a connection needs from a transport (a process, a socket or an in-process adapter). */
export type DapTransport = {
  send(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  onClose(listener: (error?: Error) => void): void;
  close(): void;
};

/**
 * The text of a failed DAP response: `body.error.format` with its {variables}
 * filled in (what adapters show to users), else the short `message`.
 */
function dapErrorText(message: { [key: string]: unknown }): string {
  const error = (message.body as { error?: { format?: string; variables?: Record<string, string> } } | undefined)?.error;
  if (error?.format) return error.format.replace(/{([^}]+)}/g, (match, name: string) => error.variables?.[name] ?? match);
  if (typeof message.message === "string" && message.message) return message.message;
  return `debug adapter error in ${String(message.command)}`;
}

/** A DAP connection: correlates responses with requests and dispatches events/reverse requests. */
export class DapConnection {
  #seq = 0;
  readonly #pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  #messageListener: ((message: any) => void) | null = null;
  #reverseListener: ((message: any) => void) | null = null;
  readonly #anyListeners = new Set<(message: any) => void>();
  readonly #sendListeners = new Set<(message: any) => void>();
  #closeListeners = new Set<(error?: Error) => void>();
  #closed = false;
  #transport: DapTransport;

  constructor(transport: DapTransport, traceName?: string) {
    this.#transport = transport;
    // LUMEN_DAP_TRACE=1 logs every DAP message (adapter debugging).
    if (traceName && process.env.LUMEN_DAP_TRACE) {
      const inner = transport;
      const trace = (arrow: string, message: unknown) => console.error(`[dap ${traceName}] ${arrow}`, JSON.stringify(message).slice(0, 600));
      transport = {
        send: (message) => (trace("→", message), inner.send(message)),
        onMessage: (listener) => inner.onMessage((message) => (trace("←", message), listener(message))),
        onClose: (listener) => inner.onClose(listener),
        close: () => inner.close(),
      };
      this.#transport = transport;
    }
    transport.onMessage((message) => this.#receive(message as { type: string; [key: string]: unknown }));
    transport.onClose((error) => this.#closedByPeer(error));
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** A message from the adapter (an event or a reverse request), other than responses. */
  onMessage(listener: (message: any) => void): void {
    this.#messageListener = listener;
  }

  /** All adapter → client messages, for trackers/telemetry. */
  onAnyMessage(listener: (message: any) => void): () => void {
    this.#anyListeners.add(listener);
    return () => this.#anyListeners.delete(listener);
  }

  /** All client → adapter messages (requests and reverse-request responses). */
  onSendMessage(listener: (message: any) => void): () => void {
    this.#sendListeners.add(listener);
    return () => this.#sendListeners.delete(listener);
  }

  onReverseRequest(listener: (message: any) => void): void {
    this.#reverseListener = listener;
  }

  onClose(listener: (error?: Error) => void): void {
    if (this.#closed) listener();
    else this.#closeListeners.add(listener);
  }

  /** Send a request; resolves with its response body (`body` of the response message). */
  request(command: string, args?: unknown, timeoutMs = 0): Promise<any> {
    if (this.#closed) return Promise.reject(new Error("the debug adapter is not connected"));
    const seq = ++this.#seq;
    return new Promise((resolve, reject) => {
      this.#pending.set(seq, { resolve, reject });
      this.#transport.send({ seq, type: "request", command, arguments: args });
      if (timeoutMs > 0) {
        setTimeout(() => {
          if (!this.#pending.delete(seq)) return;
          reject(new Error(`the debug adapter did not answer '${command}' within ${timeoutMs} ms`));
        }, timeoutMs);
      }
    });
  }

  /** Push a message to the adapter (used for reverse-request responses). */
  send(message: unknown): void {
    if (this.#closed) return;
    for (const listener of this.#sendListeners) listener(message);
    this.#transport.send(message);
  }

  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#transport.close();
    } catch {
      /* already gone */
    }
    for (const pending of this.#pending.values()) pending.reject(new Error("the debug adapter was disconnected"));
    this.#pending.clear();
    for (const listener of this.#closeListeners) listener();
    this.#closeListeners.clear();
  }

  #receive(message: { type: string; [key: string]: unknown }): void {
    for (const listener of this.#anyListeners) listener(message);
    if (message.type === "response") {
      const pending = this.#pending.get(message.request_seq as number);
      if (!pending) return;
      this.#pending.delete(message.request_seq as number);
      if (message.success === false) pending.reject(new Error(dapErrorText(message)));
      else pending.resolve(message.body ?? {});
      return;
    }
    if (message.type === "request") {
      this.#reverseListener?.(message);
      return;
    }
    if (message.type === "event") this.#messageListener?.(message);
  }

  #closedByPeer(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(error ?? new Error("the debug adapter disconnected"));
    this.#pending.clear();
    for (const listener of this.#closeListeners) listener(error);
    this.#closeListeners.clear();
  }
}

/* ── transports ──────────────────────────────────────────────────────────── */

/** A child process speaking DAP on its stdio. */
export function executableTransport(descriptor: T.DebugAdapterExecutable, onStderr: (text: string) => void): DapTransport {
  const env = { ...process.env, ...descriptor.options?.env };
  // The packaged app runs on Lumen.exe, a Node SEA whose launcher starts a
  // script (instead of a second app window) when it has an IPC channel and the
  // script in argv[2] — the way child_process.fork starts it. DAP still uses
  // stdin/stdout; in dev (plain node.exe) the extra channel is harmless.
  const forked = descriptor.command === process.execPath;
  const child = spawn(descriptor.command, descriptor.args, {
    cwd: descriptor.options?.cwd,
    env,
    stdio: forked ? ["pipe", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const parser = new FrameParser();
  const messageListeners: ((message: unknown) => void)[] = [];
  const closeListeners: ((error?: Error) => void)[] = [];
  child.stdout?.on("data", (chunk: Buffer) => {
    for (const message of parser.push(chunk)) for (const listener of messageListeners) listener(message);
  });
  child.stderr?.on("data", (chunk: Buffer) => onStderr(chunk.toString("utf8")));
  const closed = (error?: Error) => {
    for (const listener of closeListeners) listener(error);
  };
  child.on("error", (error) => closed(error));
  child.on("exit", (code, signal) => {
    // The IPC channel (when there is one) must not keep the host's event loop alive.
    if (child.connected) child.disconnect();
    closed(new Error(`the debug adapter exited (code ${code ?? "?"}${signal ? `, signal ${signal}` : ""})`));
  });
  return {
    send: (message) => {
      try {
        child.stdin?.write(encodeDapMessage(message));
      } catch {
        /* the process is gone */
      }
    },
    onMessage: (listener) => void messageListeners.push(listener),
    onClose: (listener) => void closeListeners.push(listener),
    close: () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    },
  };
}

/** A TCP socket to a `DebugAdapterServer`. */
export function socketTransport(port: number, host: string | undefined, onError: (error: Error) => void): DapTransport {
  const socket = connect({ port, host });
  const parser = new FrameParser();
  const messageListeners: ((message: unknown) => void)[] = [];
  const closeListeners: ((error?: Error) => void)[] = [];
  let closed = false;
  const finish = (error?: Error) => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) listener(error);
  };
  socket.on("data", (chunk: Buffer) => {
    for (const message of parser.push(chunk)) for (const listener of messageListeners) listener(message);
  });
  socket.on("error", (error) => {
    onError(error);
    finish(error);
  });
  socket.on("close", () => finish());
  return {
    send: (message) => socket.write(encodeDapMessage(message)),
    onMessage: (listener) => void messageListeners.push(listener),
    onClose: (listener) => void closeListeners.push(listener),
    close: () => socket.destroy(),
  };
}

/** A named pipe (`DebugAdapterNamedPipeServer`). */
export function namedPipeTransport(path: string, onError: (error: Error) => void): DapTransport {
  const socket = connect({ path });
  const parser = new FrameParser();
  const messageListeners: ((message: unknown) => void)[] = [];
  const closeListeners: ((error?: Error) => void)[] = [];
  let closed = false;
  const finish = (error?: Error) => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) listener(error);
  };
  socket.on("data", (chunk: Buffer) => {
    for (const message of parser.push(chunk)) for (const listener of messageListeners) listener(message);
  });
  socket.on("error", (error) => {
    onError(error);
    finish(error);
  });
  socket.on("close", () => finish());
  return {
    send: (message) => socket.write(encodeDapMessage(message)),
    onMessage: (listener) => void messageListeners.push(listener),
    onClose: (listener) => void closeListeners.push(listener),
    close: () => socket.destroy(),
  };
}

/** An in-process adapter: an object with `handleMessage` and an `onDidSendMessage` event. */
export function inlineTransport(implementation: {
  handleMessage(message: unknown): void;
  onDidSendMessage: (listener: (message: unknown) => void, thisArgs?: unknown, disposables?: unknown[]) => { dispose(): unknown };
}): DapTransport {
  const messageListeners: ((message: unknown) => void)[] = [];
  const closeListeners: ((error?: Error) => void)[] = [];
  const subscription = implementation.onDidSendMessage((message) => {
    for (const listener of messageListeners) listener(message);
  });
  return {
    send: (message) => {
      try {
        implementation.handleMessage(JSON.parse(JSON.stringify(message)));
      } catch (error) {
        for (const listener of closeListeners) listener(error instanceof Error ? error : new Error(String(error)));
      }
    },
    onMessage: (listener) => void messageListeners.push(listener),
    onClose: (listener) => void closeListeners.push(listener),
    close: () => subscription.dispose(),
  };
}

/* ── the session manager ─────────────────────────────────────────────────── */

type DebugConfigurationProvider = {
  extensionId: string;
  type: string;
  provider: Record<string, (...args: any[]) => any>;
  triggerKind: number;
};

type ManagedSession = {
  id: string;
  type: string;
  name: string;
  configuration: Record<string, unknown>;
  folder: string | null;
  parent: ManagedSession | null;
  children: Set<string>;
  state: HostDebugSessionState;
  connection: DapConnection | null;
  capabilities: Record<string, unknown>;
  exceptionFilters: HostDebugExceptionFilter[];
  /** Whether launch/attach was sent (breakpoints wait for `initialized`). */
  launchSent: boolean;
  configurationDone: boolean;
  initialized: boolean;
  pendingInitialized: boolean;
  terminated: boolean;
  disconnectRequested: boolean;
  stoppedThreadId?: number;
  stoppedReason?: string;
  stoppedDescription?: string;
  stoppedAllThreads?: boolean;
  /** The trackers created for this session (once). */
  trackers?: Tracker[];
  /** DAP breakpoint id → the host breakpoint id it belongs to. */
  dapBreakpoints: Map<number, string>;
  /** Files this adapter got breakpoints for (key → path), so removing the last one clears it there. */
  breakpointFiles: Map<string, string>;
};

/** A tracker (debug.registerDebugAdapterTrackerFactory) plus its owner. */
type Tracker = { extensionId: string; tracker: Record<string, (...args: any[]) => any> };

const CLIENT_ID = "lumen";
const REQUEST_TIMEOUT = 30_000;

export class DebugSessionManager {
  readonly onDidChangeActiveDebugSession = new T.EventEmitter<T.DebugSession | undefined>();
  readonly onDidStartDebugSession = new T.EventEmitter<T.DebugSession>();
  readonly onDidTerminateDebugSession = new T.EventEmitter<T.DebugSession>();
  readonly onDidReceiveDebugSessionCustomEvent = new T.EventEmitter<{ session: T.DebugSession; event: string; body: unknown }>();
  readonly onDidChangeBreakpoints = new T.EventEmitter<{ added: T.Breakpoint[]; removed: T.Breakpoint[]; changed: T.Breakpoint[] }>();
  readonly onDidChangeActiveStackItem = new T.EventEmitter<{ thread?: T.DebugThread; frame?: T.DebugStackFrame } | undefined>();

  #host: ExtensionHost;
  #seq = 0;
  #breakpoints: T.Breakpoint[] = [];
  /** DAP breakpoint (per session) by host breakpoint id: what getDebugProtocolBreakpoint returns. */
  readonly #dapByBreakpoint = new Map<string, Record<string, unknown>>();
  readonly #providers = new Map<string, DebugConfigurationProvider[]>();
  readonly #descriptorFactories = new Map<string, { extensionId: string; factory: Record<string, (...args: any[]) => any> }>();
  readonly #trackerFactories = new Map<string, { extensionId: string; factory: Record<string, (...args: any[]) => any> }[]>();
  readonly #sessions = new Map<string, ManagedSession>();
  #activeSessionId: string | null = null;
  #activeStackItem: { sessionId: string; threadId?: number; frameId?: number } | null = null;
  #unsupportedVariables = new Set<string>();

  #loaded = false;

  constructor(host: ExtensionHost) {
    this.#host = host;
  }

  /** Load the persisted breakpoints and tell the view about them (once the host knows its workspace). */
  loadState(): void {
    if (this.#loaded) return;
    this.#loaded = true;
    this.#loadBreakpoints();
    this.#postBreakpoints();
  }

  /* ── breakpoints (the host is the source of truth) ─────────────────────── */

  get breakpoints(): T.Breakpoint[] {
    return [...this.#breakpoints];
  }

  apiBreakpoint(id: string): T.Breakpoint | undefined {
    return this.#breakpoints.find((breakpoint) => breakpoint.id === id);
  }

  addBreakpoints(breakpoints: readonly T.Breakpoint[]): void {
    const added: T.Breakpoint[] = [];
    for (const breakpoint of breakpoints) {
      if (this.#breakpoints.includes(breakpoint)) continue;
      this.#breakpoints.push(breakpoint);
      added.push(breakpoint);
    }
    if (!added.length) return;
    this.#persistBreakpoints();
    this.#postBreakpoints();
    this.onDidChangeBreakpoints.fire({ added, removed: [], changed: [] });
    void this.#applyBreakpoints();
  }

  removeBreakpoints(breakpoints: readonly T.Breakpoint[]): void {
    const removed = breakpoints.filter((breakpoint) => this.#breakpoints.includes(breakpoint));
    if (!removed.length) return;
    this.#breakpoints = this.#breakpoints.filter((breakpoint) => !removed.includes(breakpoint));
    for (const breakpoint of removed) this.#dapByBreakpoint.delete(breakpoint.id);
    this.#persistBreakpoints();
    this.#postBreakpoints();
    this.onDidChangeBreakpoints.fire({ added: [], removed, changed: [] });
    void this.#applyBreakpoints();
  }

  removeAllBreakpoints(): void {
    if (!this.#breakpoints.length) return;
    const removed = [...this.#breakpoints];
    this.#breakpoints = [];
    this.#dapByBreakpoint.clear();
    this.#persistBreakpoints();
    this.#postBreakpoints();
    this.onDidChangeBreakpoints.fire({ added: [], removed, changed: [] });
    void this.#applyBreakpoints();
  }

  #changedBreakpoint(breakpoint: T.Breakpoint): void {
    this.#persistBreakpoints();
    this.#postBreakpoints();
    this.onDidChangeBreakpoints.fire({ added: [], removed: [], changed: [breakpoint] });
    void this.#applyBreakpoints();
  }

  setBreakpoints(path: string, desired: HostDebugSetBreakpoint[]): HostDebugBreakpoint[] {
    const existing = this.#breakpoints.filter(
      (breakpoint): breakpoint is T.SourceBreakpoint => breakpoint instanceof T.SourceBreakpoint && samePath(breakpoint.location.uri.fsPath, path),
    );
    const removed: T.Breakpoint[] = [];
    const remaining = [...desired];
    for (const breakpoint of existing) {
      const index = remaining.findIndex((entry) => entry.line === breakpoint.location.range.start.line + 1);
      if (index < 0) {
        removed.push(breakpoint);
        continue;
      }
      const entry = remaining.splice(index, 1)[0]!;
      breakpoint.enabled = entry.enabled !== false;
      breakpoint.condition = entry.condition;
      breakpoint.hitCondition = entry.hitCondition;
      breakpoint.logMessage = entry.logMessage;
    }
    const added = remaining.map((entry) => {
      const line = Math.max(0, entry.line - 1);
      return new T.SourceBreakpoint(
        new T.Location(T.Uri.file(path), new T.Range(line, 0, line, 0)),
        entry.enabled !== false,
        entry.condition,
        entry.hitCondition,
        entry.logMessage,
      );
    });
    this.#breakpoints = this.#breakpoints.filter((breakpoint) => !removed.includes(breakpoint)).concat(added);
    for (const breakpoint of removed) this.#dapByBreakpoint.delete(breakpoint.id);
    this.#persistBreakpoints();
    this.#postBreakpoints();
    void this.#applyBreakpoints();
    return this.wireBreakpoints();
  }

  toggleBreakpoint(path: string, line: number): HostDebugBreakpoint[] {
    const index = this.#breakpoints.findIndex(
      (breakpoint) =>
        breakpoint instanceof T.SourceBreakpoint && samePath(breakpoint.location.uri.fsPath, path) && breakpoint.location.range.start.line + 1 === line,
    );
    if (index >= 0) this.removeBreakpoints([this.#breakpoints[index]!]);
    else this.addBreakpoints([new T.SourceBreakpoint(new T.Location(T.Uri.file(path), new T.Range(line - 1, 0, line - 1, 0)))]);
    return this.wireBreakpoints();
  }

  setBreakpointEnabled(id: string, enabled: boolean): HostDebugBreakpoint[] {
    const breakpoint = this.apiBreakpoint(id);
    if (breakpoint && breakpoint.enabled !== enabled) {
      breakpoint.enabled = enabled;
      this.#changedBreakpoint(breakpoint);
    }
    return this.wireBreakpoints();
  }

  editBreakpoint(id: string, changes: { condition?: string; hitCondition?: string; logMessage?: string }): HostDebugBreakpoint[] {
    const breakpoint = this.apiBreakpoint(id);
    if (breakpoint) {
      if ("condition" in changes) breakpoint.condition = changes.condition;
      if ("hitCondition" in changes) breakpoint.hitCondition = changes.hitCondition;
      if ("logMessage" in changes) breakpoint.logMessage = changes.logMessage;
      this.#changedBreakpoint(breakpoint);
    }
    return this.wireBreakpoints();
  }

  /** The host's breakpoints as the view sees them (with the adapter's verification). */
  wireBreakpoints(): HostDebugBreakpoint[] {
    return this.#breakpoints.map((breakpoint) => {
      const dap = this.#dapByBreakpoint.get(breakpoint.id);
      const source = breakpoint instanceof T.SourceBreakpoint ? breakpoint.location.uri.fsPath : undefined;
      return {
        id: breakpoint.id,
        kind: breakpoint instanceof T.FunctionBreakpoint ? "function" : "source",
        enabled: breakpoint.enabled,
        condition: breakpoint.condition,
        hitCondition: breakpoint.hitCondition,
        logMessage: breakpoint.logMessage,
        path: source,
        line: breakpoint instanceof T.SourceBreakpoint ? breakpoint.location.range.start.line + 1 : undefined,
        functionName: breakpoint instanceof T.FunctionBreakpoint ? breakpoint.functionName : undefined,
        verified: typeof dap?.verified === "boolean" ? !!dap.verified : undefined,
        verifiedLine: typeof dap?.line === "number" ? dap.line : undefined,
        message: typeof dap?.message === "string" ? dap.message : undefined,
        sourcePath: (dap?.source as { path?: string } | undefined)?.path,
      };
    });
  }

  #postBreakpoints(): void {
    this.#host.post({ type: "debugBreakpoints", breakpoints: this.wireBreakpoints() });
  }

  async #applyBreakpoints(): Promise<void> {
    for (const session of this.#liveSessions()) {
      if (!session.initialized) continue;
      await this.#sendBreakpoints(session).catch(() => {});
      if (session.capabilities.supportsFunctionBreakpoints) await this.#sendFunctionBreakpoints(session).catch(() => {});
    }
  }

  /* ── persistence ───────────────────────────────────────────────────────── */

  #statePath(): string {
    const workspace = this.#host.workspace ?? "";
    const hash = createHash("sha1")
      .update(process.platform === "win32" ? workspace.toLowerCase() : workspace)
      .digest("hex")
      .slice(0, 20);
    return join(this.#host.init.userData, "debugState", `${hash}.json`);
  }

  #loadBreakpoints(): void {
    try {
      const data = JSON.parse(readFileSync(this.#statePath(), "utf8")) as { breakpoints?: HostDebugBreakpoint[] };
      for (const entry of data.breakpoints ?? []) {
        if (!entry || typeof entry !== "object") continue;
        if (entry.kind === "function" && typeof entry.functionName === "string") {
          this.#breakpoints.push(
            new T.FunctionBreakpoint(entry.functionName, entry.enabled !== false, entry.condition, entry.hitCondition, entry.logMessage, entry.id),
          );
        } else if (typeof entry.path === "string" && typeof entry.line === "number") {
          this.#breakpoints.push(
            new T.SourceBreakpoint(
              new T.Location(T.Uri.file(entry.path), new T.Range(entry.line - 1, 0, entry.line - 1, 0)),
              entry.enabled !== false,
              entry.condition,
              entry.hitCondition,
              entry.logMessage,
              entry.id,
            ),
          );
        }
      }
    } catch {
      /* nothing stored yet */
    }
  }

  #persistBreakpoints(): void {
    try {
      const file = this.#statePath();
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ breakpoints: this.wireBreakpoints() }), "utf8");
    } catch (error) {
      this.#host.log("warning", `could not save breakpoints: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /* ── registration ──────────────────────────────────────────────────────── */

  registerProvider(runtime: ExtensionRuntime | null, type: string, provider: Record<string, (...args: any[]) => any>, triggerKind?: number): T.Disposable {
    const entry: DebugConfigurationProvider = {
      extensionId: runtime?.id ?? "unknown",
      type,
      provider,
      triggerKind: triggerKind ?? T.DebugConfigurationProviderTriggerKind.Initial,
    };
    const list = this.#providers.get(type) ?? [];
    list.push(entry);
    this.#providers.set(type, list);
    return new T.Disposable(() => {
      const current = this.#providers.get(type);
      if (current)
        this.#providers.set(
          type,
          current.filter((candidate) => candidate !== entry),
        );
    });
  }

  registerDescriptorFactory(runtime: ExtensionRuntime | null, type: string, factory: Record<string, (...args: any[]) => any>): T.Disposable {
    if (this.#descriptorFactories.has(type)) throw new Error(`a debug adapter descriptor factory is already registered for '${type}'`);
    this.#descriptorFactories.set(type, { extensionId: runtime?.id ?? "unknown", factory });
    void this.#host.activateByEvent(`onDebugAdapterProtocolTracker:${type}`);
    return new T.Disposable(() => this.#descriptorFactories.delete(type));
  }

  registerTrackerFactory(runtime: ExtensionRuntime | null, type: string, factory: Record<string, (...args: any[]) => any>): T.Disposable {
    const entry = { extensionId: runtime?.id ?? "unknown", factory };
    const list = this.#trackerFactories.get(type) ?? [];
    list.push(entry);
    this.#trackerFactories.set(type, list);
    return new T.Disposable(() => {
      const current = this.#trackerFactories.get(type);
      if (current)
        this.#trackerFactories.set(
          type,
          current.filter((candidate) => candidate !== entry),
        );
    });
  }

  /* ── launch configurations ─────────────────────────────────────────────── */

  /** Every type a debugger was contributed for or a provider/factory registered. */
  debuggerTypes(): string[] {
    const types = new Set<string>([...this.#providers.keys(), ...this.#descriptorFactories.keys()]);
    for (const runtime of this.#host.runtimes.values()) for (const debugger_ of debuggersOf(runtime)) if (debugger_.type) types.add(debugger_.type);
    return [...types];
  }

  /**
   * launch.json and the configurations providers offer. Providers of the Initial
   * trigger kind are asked only with `initial` (the user starts debugging without a
   * launch.json): like in VS Code they may ask the user (debugpy shows a quick pick),
   * which must not happen when the Run and Debug view merely lists configurations.
   */
  async listConfigurations(folderInput: string | null, initial = false): Promise<HostDebugConfigurations> {
    const folder = folderInput ?? this.#host.workspace;
    const fromJson = this.#readLaunchJson(folder);
    const configurations: HostDebugConfiguration[] = [...fromJson.configurations];
    const compounds: HostDebugCompound[] = [...fromJson.compounds];
    const known = new Set(configurations.map((configuration) => configuration.name));
    // Activate first: a debugger extension may only wake up for these events.
    const askInitial = initial && !fromJson.present;
    if (askInitial) await this.#host.activateByEvent("onDebugInitialConfigurations");
    await this.#host.activateByEvent("onDebugDynamicConfigurations");
    for (const type of this.debuggerTypes()) await this.#host.activateByEvent(`onDebugDynamicConfigurations:${type}`);
    const initialProviders = askInitial ? this.#allProviders().filter((entry) => entry.triggerKind === T.DebugConfigurationProviderTriggerKind.Initial) : [];
    const dynamic = this.#allProviders().filter((entry) => entry.triggerKind === T.DebugConfigurationProviderTriggerKind.Dynamic);
    for (const entry of [...initialProviders, ...dynamic]) {
      const list = await this.#provideConfigurations(entry, folder).catch((error: unknown) => {
        this.#host.log("warning", `provideDebugConfigurations failed: ${error instanceof Error ? error.message : String(error)}`, entry.extensionId);
        return [] as Record<string, unknown>[];
      });
      for (const configuration of list) {
        if (!configuration || typeof configuration !== "object" || typeof configuration.name !== "string" || known.has(configuration.name)) continue;
        known.add(configuration.name);
        configurations.push({
          ...(configuration as Record<string, unknown>),
          name: configuration.name,
          type: String(configuration.type ?? entry.type),
          folder: folder ?? undefined,
        });
      }
    }
    return { configurations, compounds, error: fromJson.error };
  }

  #allProviders(): DebugConfigurationProvider[] {
    return [...this.#providers.values()].flat();
  }

  async #provideConfigurations(entry: DebugConfigurationProvider, folder: string | null): Promise<Record<string, unknown>[]> {
    const provide = entry.provider?.provideDebugConfigurations;
    if (typeof provide !== "function") return [];
    const result = await provide.call(entry.provider, workspaceFolderOf(folder), new T.CancellationTokenSource().token);
    return Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
  }

  #readLaunchJson(folder: string | null): { present: boolean; configurations: HostDebugConfiguration[]; compounds: HostDebugCompound[]; error?: string } {
    if (!folder) return { present: false, configurations: [], compounds: [] };
    const file = join(folder, ".vscode", "launch.json");
    if (!existsSync(file)) return { present: false, configurations: [], compounds: [] };
    try {
      const data = parseJsonc(readFileSync(file, "utf8")) as { configurations?: unknown[]; compounds?: unknown[] };
      const configurations: HostDebugConfiguration[] = [];
      for (const raw of data.configurations ?? []) {
        const configuration = raw as Record<string, unknown>;
        if (configuration && typeof configuration.name === "string" && typeof configuration.type === "string") {
          configurations.push({ ...configuration, name: configuration.name, type: configuration.type, folder: folder ?? undefined });
        }
      }
      const compounds: HostDebugCompound[] = [];
      for (const raw of data.compounds ?? []) {
        const compound = raw as { name?: unknown; configurations?: unknown };
        if (typeof compound.name === "string" && Array.isArray(compound.configurations)) {
          compounds.push({ name: compound.name, configurations: compound.configurations.map(String), folder: folder ?? undefined });
        }
      }
      return { present: true, configurations, compounds };
    } catch (error) {
      return { present: true, configurations: [], compounds: [], error: `launch.json: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async startNamed(folder: string | null, name: string): Promise<string> {
    const resolvedFolder = folder ?? this.#host.workspace;
    const { configurations } = this.#readLaunchJson(resolvedFolder);
    const configuration = configurations.find((entry) => entry.name === name);
    if (configuration) return (await this.start(configuration, resolvedFolder)).id;
    const listed = await this.listConfigurations(resolvedFolder);
    const fromProvider = listed.configurations.find((entry) => entry.name === name);
    if (!fromProvider) throw new Error(`no launch configuration named '${name}'`);
    return (await this.start(fromProvider, resolvedFolder)).id;
  }

  async startWithConfiguration(configuration: Record<string, unknown>, folder: string | null): Promise<string> {
    return (await this.start(configuration, folder ?? this.#host.workspace)).id;
  }

  /** Resolve a configuration through the providers and subscribe to its substitution. */
  /** Providers of a type, then those registered for every type ("*"). */
  #providersFor(type: string) {
    return [...(this.#providers.get(type) ?? []), ...(type === "*" ? [] : (this.#providers.get("*") ?? []))];
  }

  /**
   * VS Code's resolution: resolveDebugConfiguration (again for the new type
   * whenever a provider changes `type`, e.g. js-debug turns "node" into
   * "pwa-node"), variable substitution, then
   * resolveDebugConfigurationWithSubstitutedVariables for the final type.
   */
  async #resolve(configuration: Record<string, unknown>, folder: string | null): Promise<Record<string, unknown> | null> {
    let resolved: Record<string, unknown> = { ...configuration };
    let firstError: unknown;
    const run = async (type: string, method: "resolveDebugConfiguration" | "resolveDebugConfigurationWithSubstitutedVariables") => {
      for (const entry of this.#providersFor(type)) {
        const resolve = entry.provider?.[method];
        if (typeof resolve !== "function") continue;
        try {
          const result = await resolve.call(entry.provider, workspaceFolderOf(folder), resolved, new T.CancellationTokenSource().token);
          if (result === null || result === undefined) return false; // cancelled
          if (typeof result === "object") resolved = result as Record<string, unknown>;
        } catch (error) {
          firstError ??= error;
        }
        // A provider switched the type: the new type's providers take over.
        if (String(resolved.type ?? "") !== type) return true;
      }
      return true;
    };

    const seen = new Set<string>();
    for (;;) {
      const type = String(resolved.type ?? "");
      seen.add(type);
      await this.#host.activateByEvent(`onDebugResolve:${type}`);
      if (!(await run(type, "resolveDebugConfiguration"))) return null;
      const next = String(resolved.type ?? "");
      if (next === type || seen.has(next)) break;
    }
    if (resolved.noDebug === undefined && configuration.noDebug !== undefined) resolved.noDebug = configuration.noDebug;
    resolved = (await this.#substitute(resolved, folder)) as Record<string, unknown>;
    if (!(await run(String(resolved.type ?? ""), "resolveDebugConfigurationWithSubstitutedVariables"))) return null;
    if (firstError) throw firstError;
    return resolved;
  }

  async #substitute(value: unknown, folder: string | null): Promise<unknown> {
    if (typeof value === "string") {
      const context = this.#substitutionContext(folder);
      return replaceVariables(value, context, async (command) => String((await this.#host.executeCommand(command, [])) ?? ""));
    }
    if (Array.isArray(value)) return Promise.all(value.map((entry) => this.#substitute(entry, folder)));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) out[key] = await this.#substitute(entry, folder);
      return out;
    }
    return value;
  }

  #substitutionContext(folder: string | null): SubstitutionContext {
    const workspace = folder ?? this.#host.workspace ?? "";
    const editorKey = this.#host.activeEditorKey;
    const document = editorKey ? this.#host.document(editorKey) : undefined;
    const file = document && !document.isUntitled ? document.key : undefined;
    const selections = editorKey ? (this.#host.editors.get(normalizeKey(editorKey))?.selections ?? []) : [];
    const primary = selections[0] as { start: { line: number; character: number }; end: { line: number; character: number } } | undefined;
    const text = document && !document.isUntitled ? document.getText() : "";
    const selectedText = primary ? sliceLines(text, primary) : undefined;
    return {
      workspaceFolder: workspace,
      file: file ?? "",
      lineNumber: primary ? primary.start.line + 1 : undefined,
      selectedText,
      configValue: (key) => this.#host.configValue(key),
      unsupported: (name) => {
        if (this.#unsupportedVariables.has(name)) return;
        this.#unsupportedVariables.add(name);
        this.#host.log("warning", `debug variable \${${name}} is not supported by Lumen and was left empty`);
      },
    };
  }

  /* ── starting & stopping ───────────────────────────────────────────────── */

  async startDebugging(folderInput: string | null, nameOrConfiguration: string | Record<string, unknown>, parentSessionOrOptions?: unknown): Promise<boolean> {
    const folder = folderInput ?? this.#host.workspace;
    const options = (
      parentSessionOrOptions && typeof parentSessionOrOptions === "object" && "id" in (parentSessionOrOptions as object) ? undefined : parentSessionOrOptions
    ) as { parentSession?: { id: string }; noDebug?: boolean } | undefined;
    const parent = options?.parentSession ? (this.#sessions.get(options.parentSession.id) ?? null) : null;
    try {
      const configuration = typeof nameOrConfiguration === "string" ? await this.#namedConfiguration(folder, nameOrConfiguration) : nameOrConfiguration;
      if (options?.noDebug) configuration.noDebug = true;
      await this.start(configuration, folder, parent);
      return true;
    } catch (error) {
      this.#host.log("error", `startDebugging failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async #namedConfiguration(folder: string | null, name: string): Promise<Record<string, unknown>> {
    const { configurations } = this.#readLaunchJson(folder);
    const fromJson = configurations.find((entry) => entry.name === name);
    if (fromJson) return fromJson;
    const listed = await this.listConfigurations(folder);
    const fromProvider = listed.configurations.find((entry) => entry.name === name);
    if (!fromProvider) throw new Error(`no launch configuration named '${name}'`);
    return fromProvider;
  }

  async stopDebugging(sessionInput?: { id: string }): Promise<boolean> {
    const session = sessionInput ? this.#sessions.get(sessionInput.id) : this.#sessions.get(this.#activeSessionId ?? "");
    if (!session) return false;
    await this.#disconnect(session, true);
    return true;
  }

  /** The heart of the client: resolve, connect, initialize, launch/attach. */
  async start(configuration: Record<string, unknown>, folder: string | null, parent: ManagedSession | null = null): Promise<ManagedSession> {
    const initialType = String(configuration.type ?? "");
    if (!initialType) throw new Error("a debug configuration needs a 'type'");
    await this.#host.activateByEvent("onDebug");
    await this.#host.activateByEvent("onDebugAdapterProtocolTracker");
    await this.#host.activateByEvent(`onDebugAdapterProtocolTracker:${initialType}`);
    const resolved = await this.#resolve(configuration, folder);
    if (!resolved) throw new Error("the debug configuration was cancelled");
    // Resolution may change the type ("node" → "pwa-node"): the adapter is the final type's.
    const type = String(resolved.type ?? initialType);
    if (type !== initialType) await this.#host.activateByEvent(`onDebugAdapterProtocolTracker:${type}`);
    const id = `debug-${++this.#seq}`;
    const session: ManagedSession = {
      id,
      type,
      name: String(resolved.name ?? type),
      configuration: resolved,
      folder,
      parent,
      children: new Set(),
      state: "starting",
      connection: null,
      capabilities: {},
      exceptionFilters: [],
      launchSent: false,
      configurationDone: false,
      initialized: false,
      pendingInitialized: false,
      terminated: false,
      disconnectRequested: false,
      dapBreakpoints: new Map(),
      breakpointFiles: new Map(),
    };
    this.#sessions.set(id, session);
    if (parent) parent.children.add(id);
    this.#setActiveSession(session);
    this.#postSessions();
    this.onDidStartDebugSession.fire(this.sessionFacade(session));
    try {
      const descriptor = await this.#descriptor(session);
      if (!descriptor) throw new Error(`no debug adapter is registered for '${type}'`);
      const connection = this.#connect(session, descriptor);
      session.connection = connection;
      connection.onClose((error) => this.#terminated(session, error));
      connection.onMessage((message) => void this.#onEvent(session, message));
      connection.onReverseRequest((message) => void this.#onReverseRequest(session, message));
      // Trackers see every message, starting with initialize.
      const trackers = this.#trackers(session);
      for (const tracker of trackers) tracker.tracker?.onWillStartSession?.(this.sessionFacade(session));
      for (const tracker of trackers) {
        connection.onSendMessage((message) => {
          try {
            tracker.tracker?.onWillReceiveMessage?.(this.sessionFacade(session), message);
          } catch {
            /* trackers must not break the session */
          }
        });
        connection.onAnyMessage((message) => {
          try {
            tracker.tracker?.onDidSendMessage?.(this.sessionFacade(session), message);
          } catch {
            /* trackers must not break the session */
          }
        });
      }
      const response = await this.#request(
        session,
        "initialize",
        {
          clientID: CLIENT_ID,
          clientName: "Lumen",
          adapterID: type,
          locale: "en",
          linesStartAt1: true,
          columnsStartAt1: true,
          pathFormat: "path",
          supportsVariableType: true,
          supportsVariablePaging: false,
          supportsRunInTerminalRequest: true,
          supportsStartDebuggingRequest: true,
          supportsProgressReporting: false,
          supportsInvalidatedEvent: true,
          supportsMemoryReferences: false,
          supportsArgsCanBeInterpretedByShell: true,
        },
        REQUEST_TIMEOUT,
      );
      session.capabilities = (response ?? {}) as Record<string, unknown>;
      session.exceptionFilters = normalizeExceptionFilters(session.capabilities);
      this.#host.post({
        type: "debugCapabilities",
        capabilities: { sessionId: id, capabilities: session.capabilities, exceptionBreakpointFilters: session.exceptionFilters },
      });
      const request = String(resolved.request ?? "launch");
      session.launchSent = true;
      await this.#request(session, request === "attach" ? "attach" : "launch", resolved).catch((error: unknown) => {
        this.#host.log("error", `debug ${request} failed: ${error instanceof Error ? error.message : String(error)}`);
        for (const tracker of this.#trackers(session)) tracker.tracker?.onError?.(this.sessionFacade(session), error);
        throw error;
      });
      if (session.pendingInitialized) {
        session.pendingInitialized = false;
        await this.#afterInitialized(session);
      }
      // Launched (or attached): running until a `stopped` event says otherwise.
      if (session.state === "starting") {
        session.state = "running";
        this.#postSessions();
      }
      return session;
    } catch (error) {
      this.#host.log("error", `could not start '${session.name}': ${error instanceof Error ? error.message : String(error)}`, type);
      this.#host.post({
        type: "debugOutput",
        output: {
          sessionId: session.id,
          category: "stderr",
          text: `Could not start '${session.name}': ${error instanceof Error ? error.message : String(error)}\n`,
        },
      });
      for (const tracker of this.#trackers(session)) tracker.tracker?.onError?.(this.sessionFacade(session), error);
      await this.#terminated(session, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async #descriptor(session: ManagedSession): Promise<unknown> {
    const factory = this.#descriptorFactories.get(session.type);
    const executable = this.#legacyExecutable(session.type);
    if (factory) {
      const result = await factory.factory.createDebugAdapterDescriptor?.(this.sessionFacade(session), executable);
      if (result) return result;
    }
    return executable;
  }

  /** contributes.debuggers: the legacy executable (runtime + program), platform overrides applied. */
  #legacyExecutable(type: string): T.DebugAdapterExecutable | undefined {
    for (const runtime of this.#host.runtimes.values()) {
      const debugger_ = debuggersOf(runtime).find((entry) => entry.type === type);
      if (!debugger_) continue;
      const platform = process.platform === "win32" ? debugger_.windows : process.platform === "darwin" ? debugger_.osx : debugger_.linux;
      const program = String(platform?.program ?? debugger_.program ?? "");
      if (!program) continue;
      const runtimeName = String(platform?.runtime ?? debugger_.runtime ?? (program.endsWith(".js") ? "node" : ""));
      const command = runtimeName === "node" ? process.execPath : runtimeName || program;
      const contributedArgs = ((platform?.args ?? debugger_.args ?? []) as string[]).map(String);
      const args = runtimeName ? [resolveProgram(program, runtime.description.location), ...contributedArgs] : contributedArgs;
      return new T.DebugAdapterExecutable(command, args);
    }
    return undefined;
  }

  #connect(session: ManagedSession, descriptor: unknown): DapConnection {
    if (descriptor instanceof T.DebugAdapterInlineImplementation) {
      const implementation = descriptor.implementation as {
        handleMessage: (message: unknown) => void;
        onDidSendMessage: (...args: any[]) => { dispose(): unknown };
      };
      return new DapConnection(inlineTransport(implementation), session.name);
    }
    if (descriptor instanceof T.DebugAdapterServer)
      return new DapConnection(
        socketTransport(descriptor.port, descriptor.host, (error) => this.#host.log("warning", `debug adapter: ${error.message}`)),
        session.name,
      );
    if (descriptor instanceof T.DebugAdapterNamedPipeServer)
      return new DapConnection(
        namedPipeTransport(descriptor.path, (error) => this.#host.log("warning", `debug adapter: ${error.message}`)),
        session.name,
      );
    if (descriptor instanceof T.DebugAdapterExecutable) {
      return new DapConnection(
        executableTransport(descriptor, (text) => this.#emitOutput(session, "stderr", text)),
        session.name,
      );
    }
    throw new Error("unsupported debug adapter descriptor");
  }

  /** The trackers of a session, created once (like VS Code). */
  #trackers(session: ManagedSession): Tracker[] {
    if (session.trackers) return session.trackers;
    const factories = this.#trackerFactories.get(session.type) ?? [];
    const out: Tracker[] = [];
    for (const factory of factories) {
      try {
        const tracker = factory.factory.createDebugAdapterTracker?.(this.sessionFacade(session));
        if (tracker) out.push({ extensionId: factory.extensionId, tracker });
      } catch (error) {
        this.#host.log("warning", `createDebugAdapterTracker failed: ${error instanceof Error ? error.message : String(error)}`, factory.extensionId);
      }
    }
    session.trackers = out;
    return out;
  }

  /* ── sessions ──────────────────────────────────────────────────────────── */

  /** The public DebugSession object extensions (and factories) receive. */
  sessionFacade(session: ManagedSession): T.DebugSession {
    const manager = this;
    return {
      id: session.id,
      type: session.type,
      name: session.name,
      configuration: session.configuration,
      workspaceFolder: workspaceFolderOf(session.folder),
      parentSession: session.parent ? this.sessionFacade(session.parent) : undefined,
      customRequest: (command: string, args?: unknown) => manager.customRequest(session.id, command, args),
      getDebugProtocolBreakpoint: (breakpoint: T.Breakpoint) => manager.#dapByBreakpoint.get(breakpoint.id),
    } as unknown as T.DebugSession;
  }

  get activeSession(): ManagedSession | undefined {
    return this.#activeSessionId ? this.#sessions.get(this.#activeSessionId) : undefined;
  }

  get activeSessionApi(): T.DebugSession | undefined {
    const session = this.activeSession;
    return session ? this.sessionFacade(session) : undefined;
  }

  get activeStackItemApi(): unknown {
    if (!this.#activeStackItem) return undefined;
    const session = this.#sessions.get(this.#activeStackItem.sessionId);
    if (!session) return undefined;
    const item = this.#activeStackItem;
    if (item.frameId !== undefined)
      return new T.DebugStackFrame(item.threadId ?? 0, item.frameId, String(item.frameId), undefined, 0, 0, this.sessionFacade(session));
    return new T.DebugThread(item.threadId ?? 0, `Thread ${item.threadId}`, this.sessionFacade(session));
  }

  sessionById(id: string): ManagedSession | undefined {
    return this.#sessions.get(id);
  }

  #liveSessions(): ManagedSession[] {
    return [...this.#sessions.values()].filter((session) => !session.terminated);
  }

  #postSessions(): void {
    this.#host.post({
      type: "debugSessions",
      sessions: [...this.#sessions.values()].filter((session) => !session.terminated).map((session) => sessionState(session)),
    });
  }

  #setActiveSession(session: ManagedSession | null): void {
    const next = session?.id ?? null;
    if (next === this.#activeSessionId) return;
    this.#activeSessionId = next;
    this.#host.post({ type: "debugActiveSession", sessionId: next });
    this.onDidChangeActiveDebugSession.fire(session ? this.sessionFacade(session) : undefined);
  }

  setActiveStackItem(sessionId: string | null, threadId?: number, frameId?: number): void {
    this.#activeStackItem = sessionId ? { sessionId, threadId, frameId } : null;
    this.#host.post({ type: "debugActiveStackItem", sessionId, threadId, frameId });
    this.onDidChangeActiveStackItem.fire(
      sessionId
        ? frameId !== undefined
          ? { frame: this.activeStackItemApi as T.DebugStackFrame }
          : { thread: this.activeStackItemApi as T.DebugThread }
        : undefined,
    );
  }

  /** Close a session (the adapter stopped, the process exited, or the user asked). */
  async #terminated(session: ManagedSession, _error?: Error): Promise<void> {
    if (session.terminated) return;
    session.terminated = true;
    session.state = "terminated";
    for (const tracker of this.#trackers(session)) {
      try {
        tracker.tracker?.onWillStopSession?.(this.sessionFacade(session));
      } catch {
        /* trackers must not break teardown */
      }
    }
    session.connection?.dispose();
    session.connection = null;
    if (session.parent) session.parent.children.delete(session.id);
    for (const child of session.children) {
      const target = this.#sessions.get(child);
      if (target) void this.#disconnect(target, true);
    }
    this.#host.post({ type: "debugSessions", sessions: [...this.#sessions.values()].filter((entry) => !entry.terminated).map((entry) => sessionState(entry)) });
    this.onDidTerminateDebugSession.fire(this.sessionFacade(session));
    if (this.#activeSessionId === session.id) {
      const remaining = this.#liveSessions();
      this.#setActiveSession(remaining.at(-1) ?? null);
    }
    this.#sessions.delete(session.id);
  }

  /** Ask the adapter to disconnect, then close the transport. */
  async #disconnect(session: ManagedSession, terminateDebuggee: boolean): Promise<void> {
    if (session.terminated) return;
    session.disconnectRequested = true;
    try {
      await session.connection?.request("disconnect", { restart: false, terminateDebuggee }, 3000);
    } catch {
      /* the adapter may already be gone */
    }
    await this.#terminated(session);
  }

  #emitOutput(session: ManagedSession, category: string, text: string, source?: HostDebugSource & { line?: number; column?: number }): void {
    this.#host.post({
      type: "debugOutput",
      output: { sessionId: session.id, category, text, path: source?.path, line: source?.line, column: source?.column },
    });
  }

  /** After the adapter's `initialized` event: breakpoints, exception filters, configurationDone. */
  async #afterInitialized(session: ManagedSession): Promise<void> {
    session.initialized = true;
    // One failing step must not keep the adapter waiting for configurationDone.
    const step = async (name: string, run: () => Promise<void>) => {
      try {
        await run();
      } catch (error) {
        this.#host.log("warning", `${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    await step("setBreakpoints", () => this.#sendBreakpoints(session));
    if (session.capabilities.supportsFunctionBreakpoints) await step("setFunctionBreakpoints", () => this.#sendFunctionBreakpoints(session));
    await step("setExceptionBreakpoints", () => this.#sendExceptionBreakpoints(session, defaultFilters(session.exceptionFilters)));
    if (session.capabilities.supportsConfigurationDoneRequest !== false) {
      await session.connection
        ?.request("configurationDone", {})
        .catch((error: unknown) => this.#host.log("warning", `configurationDone failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    session.configurationDone = true;
  }

  async #sendBreakpoints(session: ManagedSession): Promise<void> {
    if (!session.connection) return;
    const byPath = new Map<string, T.SourceBreakpoint[]>();
    for (const breakpoint of this.#breakpoints) {
      if (!(breakpoint instanceof T.SourceBreakpoint)) continue;
      const path = breakpoint.location.uri.fsPath;
      byPath.set(normalizeKey(path), [...(byPath.get(normalizeKey(path)) ?? []), breakpoint]);
    }
    // Files whose last breakpoint was removed: tell the adapter they have none now.
    for (const [key, path] of session.breakpointFiles) {
      if (byPath.has(key)) continue;
      session.breakpointFiles.delete(key);
      await session.connection.request("setBreakpoints", { source: { name: basename(path), path }, breakpoints: [], sourceModified: false });
    }
    for (const [path, list] of byPath) {
      session.breakpointFiles.set(path, list[0]!.location.uri.fsPath);
      const enabled = list.filter((breakpoint) => breakpoint.enabled);
      const dap = (await session.connection.request("setBreakpoints", {
        source: { name: basename(path), path: list[0]!.location.uri.fsPath },
        breakpoints: enabled.map((breakpoint) => ({
          line: breakpoint.location.range.start.line + 1,
          condition: breakpoint.condition,
          hitCondition: breakpoint.hitCondition,
          logMessage: breakpoint.logMessage,
        })),
        sourceModified: false,
      })) as { breakpoints?: { id?: number; verified?: boolean; line?: number; message?: string; source?: HostDebugSource }[] };
      this.#applyBreakpointResponse(session, enabled, dap?.breakpoints ?? []);
    }
  }

  #applyBreakpointResponse(
    session: ManagedSession,
    hostBreakpoints: T.SourceBreakpoint[],
    dapBreakpoints: { id?: number; verified?: boolean; line?: number; message?: string; source?: HostDebugSource }[],
  ): void {
    let changed = false;
    hostBreakpoints.forEach((breakpoint, index) => {
      const dap = dapBreakpoints[index];
      if (!dap) return;
      if (typeof dap.id === "number") session.dapBreakpoints.set(dap.id, breakpoint.id);
      const previous = this.#dapByBreakpoint.get(breakpoint.id);
      const next = { id: dap.id, verified: dap.verified, line: dap.line, message: dap.message, source: dap.source };
      if (
        JSON.stringify(previous?.verified) !== JSON.stringify(next.verified) ||
        previous?.line !== next.line ||
        previous?.message !== next.message ||
        (previous?.source as { path?: string } | undefined)?.path !== dap.source?.path
      )
        changed = true;
      this.#dapByBreakpoint.set(breakpoint.id, next);
    });
    if (changed) {
      this.#postBreakpoints();
      this.onDidChangeBreakpoints.fire({ added: [], removed: [], changed: [...hostBreakpoints] });
    }
  }

  async #sendFunctionBreakpoints(session: ManagedSession): Promise<void> {
    if (!session.connection) return;
    const functions = this.#breakpoints.filter((breakpoint): breakpoint is T.FunctionBreakpoint => breakpoint instanceof T.FunctionBreakpoint);
    await session.connection
      .request("setFunctionBreakpoints", {
        breakpoints: functions
          .filter((breakpoint) => breakpoint.enabled)
          .map((breakpoint) => ({ name: breakpoint.functionName, condition: breakpoint.condition, hitCondition: breakpoint.hitCondition })),
      })
      .catch(() => undefined);
  }

  async #sendExceptionBreakpoints(session: ManagedSession, filters: string[]): Promise<void> {
    if (!session.connection) return;
    await session.connection
      .request("setExceptionBreakpoints", { filters })
      .catch((error: unknown) => this.#host.log("warning", `setExceptionBreakpoints failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  setExceptionBreakpoints(sessionId: string, filters: string[]): boolean {
    const session = this.#sessions.get(sessionId);
    if (!session) return false;
    void this.#sendExceptionBreakpoints(session, filters);
    return true;
  }

  /** `debug.activeDebugConsole.append` / `appendLine`: write into the debug console. */
  appendConsole(text: string): void {
    this.#host.post({ type: "debugOutput", output: { sessionId: this.#activeSessionId ?? "", category: "console", text } });
  }

  /* ── adapter events ────────────────────────────────────────────────────── */

  async #onEvent(session: ManagedSession, message: { event: string; body?: any }): Promise<void> {
    const body = message.body ?? {};
    switch (message.event) {
      case "initialized":
        if (session.launchSent) await this.#afterInitialized(session);
        else session.pendingInitialized = true;
        return;
      case "stopped": {
        session.state = "stopped";
        session.stoppedThreadId = body.threadId;
        session.stoppedReason = body.reason;
        session.stoppedDescription = body.description;
        session.stoppedAllThreads = body.allThreadsStopped;
        this.#postSessions();
        const location = await this.#stopLocation(session, body.threadId).catch(() => null);
        this.setActiveStackItem(session.id, body.threadId, location?.frameId);
        this.#host.post({
          type: "debugStopped",
          stopped: {
            sessionId: session.id,
            threadId: body.threadId ?? 0,
            reason: String(body.reason ?? "stopped"),
            description: body.description,
            path: location?.source?.path,
            line: location?.line,
            column: location?.column,
            frameId: location?.frameId,
          },
        });
        return;
      }
      case "continued":
        session.state = "running";
        session.stoppedThreadId = undefined;
        this.#postSessions();
        this.#host.post({ type: "debugContinued", sessionId: session.id, threadId: body.threadId, allThreadsContinued: body.allThreadsContinued });
        this.setActiveStackItem(session.id, body.threadId, undefined);
        return;
      case "output":
        this.#emitOutput(
          session,
          String(body.category ?? "console"),
          String(body.output ?? ""),
          body.source && { ...body.source, line: body.line, column: body.column },
        );
        return;
      case "breakpoint": {
        const id = typeof body.breakpoint?.id === "number" ? session.dapBreakpoints.get(body.breakpoint.id) : undefined;
        if (id) {
          this.#dapByBreakpoint.set(id, body.breakpoint);
          this.#postBreakpoints();
          const hostBreakpoint = this.apiBreakpoint(id);
          if (hostBreakpoint) this.onDidChangeBreakpoints.fire({ added: [], removed: [], changed: [hostBreakpoint] });
        }
        return;
      }
      case "thread":
      case "module":
      case "loadedSource":
      case "process":
      case "capabilities":
        if (message.event === "capabilities") {
          session.capabilities = { ...session.capabilities, ...body.capabilities };
          session.exceptionFilters = normalizeExceptionFilters(session.capabilities);
          this.#host.post({
            type: "debugCapabilities",
            capabilities: { sessionId: session.id, capabilities: session.capabilities, exceptionBreakpointFilters: session.exceptionFilters },
          });
        }
        return;
      case "invalidated":
        this.#host.post({ type: "debugContinued", sessionId: session.id, threadId: session.stoppedThreadId });
        return;
      case "exited":
        for (const tracker of this.#trackers(session)) tracker.tracker?.onExit?.(this.sessionFacade(session), body.exitCode, undefined);
        return;
      case "terminated":
        await this.#terminated(session);
        return;
      default:
        this.onDidReceiveDebugSessionCustomEvent.fire({ session: this.sessionFacade(session), event: message.event, body });
        this.#host.post({ type: "debugCustomEvent", event: { sessionId: session.id, event: message.event, body } });
        return;
    }
  }

  /** The first stack frame of a stopped thread: where the editor should reveal. */
  async #stopLocation(
    session: ManagedSession,
    threadId: number,
  ): Promise<{ frameId?: number; source?: HostDebugSource; line?: number; column?: number } | null> {
    const frames = await this.#stackTrace(session, threadId, 0, 1);
    const frame = frames[0];
    if (!frame) return null;
    return { frameId: frame.id, source: frame.source, line: frame.line, column: frame.column };
  }

  #stackTrace(session: ManagedSession, threadId: number, startFrame: number, levels: number): Promise<HostDebugStackFrame[]> {
    return this.#request(session, "stackTrace", { threadId, startFrame, levels }).then(
      (body) => (body as { stackFrames?: HostDebugStackFrame[] }).stackFrames ?? [],
    );
  }

  /** A DAP request from the client to the adapter (with trackers and error handling). */
  async #request(session: ManagedSession, command: string, args?: unknown, timeoutMs = REQUEST_TIMEOUT): Promise<any> {
    if (!session.connection || session.terminated) throw new Error("the debug session is not running");
    for (const tracker of this.#trackers(session)) {
      try {
        tracker.tracker?.onWillReceiveMessage?.(this.sessionFacade(session), { seq: 0, type: "request", command, arguments: args });
      } catch {
        /* ignore */
      }
    }
    return await session.connection.request(command, args, timeoutMs);
  }

  /* ── reverse requests (adapter → Lumen) ────────────────────────────────── */

  async #onReverseRequest(session: ManagedSession, message: { seq: number; command: string; arguments?: any }): Promise<void> {
    const fail = (error: unknown) =>
      session.connection?.send({
        seq: message.seq,
        type: "response",
        request_seq: message.seq,
        success: false,
        message: error instanceof Error ? error.message : String(error),
      });
    const ok = (body?: unknown) => session.connection?.send({ seq: message.seq, type: "response", request_seq: message.seq, success: true, body: body ?? {} });
    switch (message.command) {
      case "runInTerminal": {
        try {
          const args = message.arguments ?? {};
          const id = await this.#host.requestView("createTerminal", { name: args.title ?? session.name, cwd: args.cwd ?? session.folder ?? undefined });
          const command = (Array.isArray(args.args) ? args.args : []).map((part: unknown) => quoteArgument(String(part))).join(" ");
          if (command) await this.#host.requestView("terminalSendText", id, command, true);
          ok({ processId: undefined });
        } catch (error) {
          fail(error);
        }
        return;
      }
      case "startDebugging": {
        try {
          const args = message.arguments ?? {};
          const childConfiguration = { ...args.configuration, type: args.configuration?.type ?? session.type };
          void this.start(childConfiguration, session.folder, session).catch((error: unknown) =>
            this.#host.log("error", `child debug session failed: ${error instanceof Error ? error.message : String(error)}`),
          );
          ok({});
        } catch (error) {
          fail(error);
        }
        return;
      }
      default:
        fail(new Error(`unsupported reverse request '${message.command}'`));
        return;
    }
  }

  /* ── requests the UI makes ─────────────────────────────────────────────── */

  async threads(sessionId: string): Promise<HostDebugThread[]> {
    const session = this.#live(sessionId);
    const body = (await this.#request(session, "threads", {})) as { threads?: HostDebugThread[] };
    return body.threads ?? [];
  }

  stackTrace(sessionId: string, threadId: number, startFrame: number, levels: number): Promise<HostDebugStackFrame[]> {
    return this.#stackTrace(this.#live(sessionId), threadId, startFrame, levels);
  }

  async scopes(sessionId: string, frameId: number): Promise<HostDebugScope[]> {
    const body = (await this.#request(this.#live(sessionId), "scopes", { frameId })) as { scopes?: HostDebugScope[] };
    return (body.scopes ?? []).map((scope) => ({ name: scope.name, variablesReference: scope.variablesReference, expensive: !!scope.expensive }));
  }

  async variables(sessionId: string, variablesReference: number, filter?: "named" | "indexed", start?: number, count?: number): Promise<HostDebugVariable[]> {
    const body = (await this.#request(this.#live(sessionId), "variables", { variablesReference, filter, start, count })) as { variables?: HostDebugVariable[] };
    return body.variables ?? [];
  }

  async setVariable(sessionId: string, variablesReference: number, name: string, value: string): Promise<HostDebugVariable | null> {
    const body = (await this.#request(this.#live(sessionId), "setVariable", { variablesReference, name, value })) as {
      value: string;
      type?: string;
      variablesReference?: number;
    };
    if (!body || typeof body.value !== "string") return null;
    return { name, value: body.value, type: body.type, variablesReference: body.variablesReference ?? 0 };
  }

  async evaluate(sessionId: string, expression: string, frameId: number | null, context: "repl" | "watch" | "hover"): Promise<HostDebugEvaluateResult | null> {
    const body = (await this.#request(this.#live(sessionId), "evaluate", { expression, frameId: frameId ?? undefined, context })) as {
      result?: string;
      type?: string;
      variablesReference?: number;
    };
    if (!body || typeof body.result !== "string") return null;
    return { result: body.result, type: body.type, variablesReference: body.variablesReference ?? 0 };
  }

  customRequest(sessionId: string, command: string, args?: unknown): Promise<unknown> {
    return this.#request(this.#live(sessionId), command, args);
  }

  #live(sessionId: string): ManagedSession {
    const session = this.#sessions.get(sessionId);
    if (!session || session.terminated) throw new Error(`no debug session '${sessionId}'`);
    return session;
  }

  async resume(sessionId: string, threadId: number): Promise<boolean> {
    const session = this.#live(sessionId);
    const body = (await this.#request(session, "continue", { threadId })) as { allThreadsContinued?: boolean };
    session.state = "running";
    session.stoppedThreadId = undefined;
    this.#postSessions();
    this.#host.post({ type: "debugContinued", sessionId, threadId, allThreadsContinued: body.allThreadsContinued });
    return true;
  }

  async pause(sessionId: string, threadId: number): Promise<boolean> {
    await this.#request(this.#live(sessionId), "pause", { threadId });
    return true;
  }

  async step(sessionId: string, threadId: number, kind: "next" | "in" | "out"): Promise<boolean> {
    const session = this.#live(sessionId);
    const command = kind === "in" ? "stepIn" : kind === "out" ? "stepOut" : "next";
    await this.#request(session, command, { threadId });
    session.state = "running";
    session.stoppedThreadId = undefined;
    this.#postSessions();
    return true;
  }

  async restart(sessionId: string): Promise<string> {
    const session = this.#live(sessionId);
    if (session.connection && session.capabilities.supportsRestartRequest) {
      await this.#request(session, "restart", {}, REQUEST_TIMEOUT);
      session.state = "running";
      this.#postSessions();
      return session.id;
    }
    const configuration = session.configuration;
    const folder = session.folder;
    const parent = session.parent;
    await this.#disconnect(session, true);
    return (await this.start(configuration, folder, parent)).id;
  }

  async loadedSources(sessionId: string): Promise<HostDebugSource[]> {
    const body = (await this.#request(this.#live(sessionId), "loadedSources", {})) as { sources?: HostDebugSource[] };
    return body.sources ?? [];
  }

  /** vscode.debug.asDebugSourceUri: file sources map to a file URI directly. */
  asDebugSourceUri(source: HostDebugSource, sessionId?: string): T.Uri {
    if (source.path) return T.Uri.file(source.path);
    const session = sessionId ? this.#sessions.get(sessionId) : this.activeSession;
    if (source.sourceReference !== undefined && session) {
      return T.Uri.from({ scheme: "debug", authority: session.id, path: `/${source.sourceReference}`, query: source.name ?? "" });
    }
    return T.Uri.parse(`debug:${source.name ?? "source"}`);
  }
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

function samePath(a: string, b: string): boolean {
  return normalizeKey(a) === normalizeKey(b);
}

type DebuggerContribution = {
  type?: string;
  label?: string;
  program?: string;
  runtime?: string;
  args?: string[];
  windows?: { program?: string; runtime?: string; args?: string[] };
  linux?: { program?: string; runtime?: string; args?: string[] };
  osx?: { program?: string; runtime?: string; args?: string[] };
};

/** The contributes.debuggers entries of an extension. */
function debuggersOf(runtime: ExtensionRuntime): DebuggerContribution[] {
  const contributes = runtime.description.manifest.contributes as { debuggers?: unknown } | undefined;
  const list = contributes?.debuggers;
  if (!Array.isArray(list)) return [];
  return list.filter((entry): entry is DebuggerContribution => !!entry && typeof entry === "object");
}

function resolveProgram(program: string, location: string): string {
  if (isAbsolute(program) || /^[a-zA-Z]:[\\/]/.test(program)) return program;
  return join(location, program);
}

function workspaceFolderOf(folder: string | null): T.WorkspaceFolder | undefined {
  if (!folder) return undefined;
  return { uri: T.Uri.file(folder), name: basename(folder) || folder, index: 0 };
}

function sessionState(session: ManagedSession): HostDebugSession {
  return {
    id: session.id,
    type: session.type,
    name: session.name,
    parentId: session.parent?.id ?? null,
    state: session.state,
    stoppedThreadId: session.stoppedThreadId,
    stoppedReason: session.stoppedReason,
    stoppedDescription: session.stoppedDescription,
  };
}

function normalizeExceptionFilters(capabilities: Record<string, unknown>): HostDebugExceptionFilter[] {
  const filters = capabilities.exceptionBreakpointFilters;
  if (!Array.isArray(filters)) return [];
  return filters
    .filter((filter): filter is Record<string, unknown> => !!filter && typeof filter === "object")
    .map((filter) => ({
      filter: String(filter.filter ?? ""),
      label: String(filter.label ?? filter.filter ?? ""),
      description: typeof filter.description === "string" ? filter.description : undefined,
      default: filter.default === true,
      supportsCondition: filter.supportsCondition === true,
      conditionDescription: typeof filter.conditionDescription === "string" ? filter.conditionDescription : undefined,
    }))
    .filter((filter) => !!filter.filter);
}

function defaultFilters(filters: HostDebugExceptionFilter[]): string[] {
  return filters.filter((filter) => filter.default).map((filter) => filter.filter);
}

/** A best-effort shell quoting of one argument for runInTerminal. */
function quoteArgument(value: string): string {
  if (!/[\s"'\\$`|&;<>()*?[\]{}#~!]/.test(value)) return value;
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

type SubstitutionContext = {
  workspaceFolder: string;
  file: string;
  lineNumber?: number;
  selectedText?: string;
  configValue: (key: string) => unknown;
  unsupported: (name: string) => void;
};

/** Replace `${...}` variables in a configuration value (strings, arrays, objects). */
async function replaceVariables(value: string, context: SubstitutionContext, runCommand: (command: string) => Promise<string>): Promise<string> {
  const re = /\$\{([^}]+)\}/g;
  let out = "";
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value))) {
    out += value.slice(last, match.index);
    last = match.index + match[0].length;
    out += await resolveVariable(match[1]!, context, runCommand);
  }
  return out + value.slice(last);
}

async function resolveVariable(name: string, context: SubstitutionContext, runCommand: (command: string) => Promise<string>): Promise<string> {
  const folder = context.workspaceFolder;
  const file = context.file;
  const base = file ? basename(file) : "";
  const dir = file ? dirname(file) : "";
  const ext = file ? extname(file) : "";
  switch (name) {
    case "workspaceFolder":
      return folder;
    case "workspaceFolderBasename":
      return folder ? basename(folder) : "";
    case "file":
      return file;
    case "fileBasename":
      return base;
    case "fileBasenameNoExtension":
      return base.slice(0, base.length - ext.length);
    case "fileDirname":
      return dir;
    case "fileExtname":
      return ext;
    case "relativeFile":
      return file && folder ? relative(folder, file).replace(/\\/g, "/") : file;
    case "relativeFileDirname":
      return file && folder ? relative(folder, dir).replace(/\\/g, "/") : dir;
    case "lineNumber":
      return context.lineNumber === undefined ? "" : String(context.lineNumber);
    case "selectedText":
      return context.selectedText ?? "";
    case "cwd":
      return folder;
    case "userHome":
      return homedir();
    case "pathSeparator":
      return sep;
    default:
      if (name.startsWith("env:")) return process.env[name.slice(4)] ?? "";
      if (name.startsWith("config:")) {
        const value = context.configValue(name.slice(7));
        return value === undefined ? "" : String(value);
      }
      if (name.startsWith("command:")) {
        try {
          return await runCommand(name.slice(8));
        } catch {
          return "";
        }
      }
      if (name.startsWith("workspaceFolder:")) return folder;
      context.unsupported(name);
      return "";
  }
}

/** The selected text of a range (0-based line/character) in `text`. */
function sliceLines(text: string, selection: { start: { line: number; character: number }; end: { line: number; character: number } }): string {
  const offsetAt = (line: number, character: number): number => {
    let index = 0;
    let current = 0;
    while (current < line) {
      const nl = text.indexOf("\n", index);
      if (nl < 0) return text.length;
      index = nl + 1;
      current++;
    }
    return Math.min(index + character, text.length);
  };
  const start = offsetAt(selection.start.line, selection.start.character);
  const end = offsetAt(selection.end.line, selection.end.character);
  return text.slice(Math.min(start, end), Math.max(start, end));
}
