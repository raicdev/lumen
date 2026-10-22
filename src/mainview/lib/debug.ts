import { useSyncExternalStore } from "react";
import { extensionService } from "./extensions";
import type {
  HostDebugBreakpoint,
  HostDebugCapabilities,
  HostDebugConfiguration,
  HostDebugConfigurations,
  HostDebugEvaluateResult,
  HostDebugScope,
  HostDebugSession,
  HostDebugSetBreakpoint,
  HostDebugSource,
  HostDebugStackFrame,
  HostDebugStopped,
  HostDebugThread,
  HostDebugVariable,
  HostToView,
} from "../../shared/extensions";

/**
 * The view's side of debugging: receives the events the extension host pushes
 * (sessions, stopped locations, output, breakpoints, capabilities) as a store
 * React components can subscribe to, and forwards the debug requests. The
 * backend lives in src/main/exthost/debug.ts — see the RPC surface documented
 * there. This file has no UI: the debug panels build on it.
 */

export type DebugConsoleLine = { sessionId: string; category: string; text: string; path?: string; line?: number; column?: number };

export type DebugSnapshot = {
  sessions: HostDebugSession[];
  activeSessionId: string | null;
  stopped: HostDebugStopped | null;
  breakpoints: HostDebugBreakpoint[];
  capabilities: HostDebugCapabilities | null;
  console: DebugConsoleLine[];
  activeStack: { sessionId: string | null; threadId?: number; frameId?: number } | null;
};

const MAX_CONSOLE = 2000;

class DebugService {
  #snapshot: DebugSnapshot = {
    sessions: [],
    activeSessionId: null,
    stopped: null,
    breakpoints: [],
    capabilities: null,
    console: [],
    activeStack: null,
  };
  #listeners = new Set<() => void>();
  #stoppedListeners = new Set<(stopped: HostDebugStopped) => void>();
  #frame = 0;

  constructor() {
    window.addEventListener("lumen:ext-host", (e) => this.#onMessage((e as CustomEvent<HostToView>).detail));
  }

  /* ── store ─────────────────────────────────────────────────────────────── */

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = () => this.#snapshot;

  #update(patch: Partial<DebugSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...patch };
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      for (const listener of this.#listeners) listener();
    });
  }

  /** A session stopped: the editor reveals the location. */
  onStopped(listener: (stopped: HostDebugStopped) => void) {
    this.#stoppedListeners.add(listener);
    return () => this.#stoppedListeners.delete(listener);
  }

  #onMessage(message: HostToView) {
    switch (message.type) {
      case "debugSessions":
        this.#update({ sessions: message.sessions });
        return;
      case "debugActiveSession":
        this.#update({ activeSessionId: message.sessionId });
        return;
      case "debugStopped":
        this.#update({ stopped: message.stopped });
        for (const listener of this.#stoppedListeners) listener(message.stopped);
        return;
      case "debugContinued":
        if (this.#snapshot.stopped?.sessionId === message.sessionId && (message.threadId === undefined || message.threadId === this.#snapshot.stopped.threadId))
          this.#update({ stopped: null });
        return;
      case "debugOutput": {
        const console_ = [...this.#snapshot.console, message.output];
        this.#update({ console: console_.length > MAX_CONSOLE ? console_.slice(-MAX_CONSOLE) : console_ });
        return;
      }
      case "debugBreakpoints":
        this.#update({ breakpoints: message.breakpoints });
        return;
      case "debugCapabilities":
        this.#update({ capabilities: message.capabilities });
        return;
      case "debugActiveStackItem":
        this.#update({ activeStack: message.sessionId ? { sessionId: message.sessionId, threadId: message.threadId, frameId: message.frameId } : null });
        return;
      case "ready":
        // The host restarted: the sessions are gone.
        this.#update({ sessions: [], activeSessionId: null, stopped: null, capabilities: null, activeStack: null });
        return;
    }
  }

  /* ── requests (thin wrappers over the host RPC) ────────────────────────── */

  listConfigurations(folder: string | null = null): Promise<HostDebugConfigurations> {
    return extensionService.call("debugListConfigurations", folder);
  }

  start(folder: string | null, name: string) {
    return extensionService.call("debugStart", folder, name);
  }

  startConfiguration(folder: string | null, configuration: Record<string, unknown>) {
    return extensionService.call("debugStartConfiguration", folder, configuration);
  }

  stop(sessionId: string | null = null) {
    return extensionService.call("debugStop", sessionId);
  }

  restart(sessionId: string) {
    return extensionService.call("debugRestart", sessionId);
  }

  resume(sessionId: string, threadId: number) {
    return extensionService.call("debugResume", sessionId, threadId);
  }

  pause(sessionId: string, threadId: number) {
    return extensionService.call("debugPause", sessionId, threadId);
  }

  step(sessionId: string, threadId: number, kind: "next" | "in" | "out") {
    return extensionService.call("debugStep", sessionId, threadId, kind);
  }

  threads(sessionId: string): Promise<HostDebugThread[]> {
    return extensionService.call("debugThreads", sessionId);
  }

  stackTrace(sessionId: string, threadId: number, startFrame = 0, levels = 20): Promise<HostDebugStackFrame[]> {
    return extensionService.call("debugStackTrace", sessionId, threadId, startFrame, levels);
  }

  scopes(sessionId: string, frameId: number): Promise<HostDebugScope[]> {
    return extensionService.call("debugScopes", sessionId, frameId);
  }

  variables(sessionId: string, variablesReference: number, filter?: "named" | "indexed", start?: number, count?: number): Promise<HostDebugVariable[]> {
    return extensionService.call("debugVariables", sessionId, variablesReference, filter, start, count);
  }

  evaluate(
    sessionId: string,
    expression: string,
    frameId: number | null,
    context: "repl" | "watch" | "hover" = "repl",
  ): Promise<HostDebugEvaluateResult | null> {
    return extensionService.call("debugEvaluate", sessionId, expression, frameId, context);
  }

  setBreakpoints(path: string, breakpoints: HostDebugSetBreakpoint[]): Promise<HostDebugBreakpoint[]> {
    return extensionService.call("debugSetBreakpoints", path, breakpoints);
  }

  toggleBreakpoint(path: string, line: number): Promise<HostDebugBreakpoint[]> {
    return extensionService.call("debugToggleBreakpoint", path, line);
  }

  removeAllBreakpoints(): Promise<HostDebugBreakpoint[]> {
    return extensionService.call("debugRemoveAllBreakpoints");
  }

  setExceptionBreakpoints(sessionId: string, filters: string[]) {
    return extensionService.call("debugSetExceptionBreakpoints", sessionId, filters);
  }

  loadedSources(sessionId: string): Promise<HostDebugSource[]> {
    return extensionService.call("debugLoadedSources", sessionId);
  }

  /** contributes.debuggers of the enabled extensions. */
  debuggers() {
    return extensionService.contributedDebuggers();
  }

  /** The launch configuration for the active file's language, when no launch.json exists. */
  async defaultConfiguration(folder: string | null, language: string): Promise<HostDebugConfiguration | null> {
    const listed = await this.listConfigurations(folder);
    if (listed.configurations.length) return null;
    const debugger_ = this.debuggers().find((entry) => (entry.languages ?? []).includes(language));
    if (!debugger_) return null;
    return {
      type: debugger_.type,
      name: debugger_.label ?? `Debug ${language}`,
      request: "launch",
      ...(debugger_.initialConfigurations?.[0] as Record<string, unknown> | undefined),
    } as HostDebugConfiguration;
  }
}

export const debugService = new DebugService();

export function useDebug(): DebugSnapshot {
  return useSyncExternalStore(debugService.subscribe, debugService.getSnapshot);
}
