import { useSyncExternalStore } from "react";
import type { HostDebugBreakpoint, HostDebugConfiguration, HostDebugSession, HostDebugStackFrame } from "../../shared/extensions";
import { debugService } from "./debug";
import { extensionService } from "./extensions";
import { showPrompt } from "./dialog";
import { toast } from "./toast";
import { t } from "./i18n";

/**
 * View-only debugging state on top of `debugService` (src/mainview/lib/debug.ts):
 * the stack frame the user is looking at, watch expressions and the selected
 * launch configuration — plus the start / breakpoint actions the debug UI,
 * the editor gutter and the commands share.
 */

/** Paths from adapters and from the editor may differ in case and slashes on Windows. */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

export type FocusedFrame = {
  sessionId: string;
  threadId: number;
  frameId: number;
  path?: string;
  line?: number;
  column?: number;
  /** The top frame of the stopped thread (the yellow arrow) vs. one picked in the call stack. */
  top: boolean;
};

type UiState = {
  focused: FocusedFrame | null;
  watches: string[];
  selectedConfig: string | null;
  /** Bumped to re-evaluate watches and reload variables. */
  generation: number;
};

const WATCH_KEY = "lumen.debug.watches";
const CONFIG_KEY = "lumen.debug.selectedConfig";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

class DebugUi {
  #state: UiState = {
    focused: null,
    watches: readJson<string[]>(WATCH_KEY, []),
    selectedConfig: readJson<string | null>(CONFIG_KEY, null),
    generation: 0,
  };
  #listeners = new Set<() => void>();

  constructor() {
    debugService.onStopped((stopped) => {
      this.#set({
        focused:
          stopped.frameId !== undefined
            ? {
                sessionId: stopped.sessionId,
                threadId: stopped.threadId,
                frameId: stopped.frameId,
                path: stopped.path,
                line: stopped.line,
                column: stopped.column,
                top: true,
              }
            : null,
        generation: this.#state.generation + 1,
      });
    });
    debugService.subscribe(() => {
      const { focused } = this.#state;
      if (!focused) return;
      const snapshot = debugService.getSnapshot();
      const session = snapshot.sessions.find((s) => s.id === focused.sessionId);
      // Running again (or gone): nothing is focused until the next stop.
      if (!session || session.state !== "stopped" || !snapshot.stopped) this.#set({ focused: null });
    });
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = () => this.#state;

  #set(patch: Partial<UiState>) {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }

  focusFrame(sessionId: string, threadId: number, frame: HostDebugStackFrame, top: boolean) {
    this.#set({
      focused: { sessionId, threadId, frameId: frame.id, path: frame.source?.path, line: frame.line, column: frame.column, top },
      generation: this.#state.generation + 1,
    });
  }

  refresh() {
    this.#set({ generation: this.#state.generation + 1 });
  }

  addWatch(expression: string) {
    const watches = [...this.#state.watches, expression];
    writeJson(WATCH_KEY, watches);
    this.#set({ watches });
  }

  editWatch(index: number, expression: string) {
    const watches = this.#state.watches.map((w, i) => (i === index ? expression : w));
    writeJson(WATCH_KEY, watches);
    this.#set({ watches });
  }

  removeWatch(index: number | "all") {
    const watches = index === "all" ? [] : this.#state.watches.filter((_, i) => i !== index);
    writeJson(WATCH_KEY, watches);
    this.#set({ watches });
  }

  selectConfig(name: string | null) {
    writeJson(CONFIG_KEY, name);
    this.#set({ selectedConfig: name });
  }
}

export const debugUi = new DebugUi();

export function useDebugUi(): UiState {
  return useSyncExternalStore(debugUi.subscribe, debugUi.getSnapshot);
}

/* ── actions shared by the debug view, the toolbar, the gutter and commands ── */

/** The session the toolbar and the step commands act on. */
export function currentSession() {
  const snapshot = debugService.getSnapshot();
  const focused = debugUi.getSnapshot().focused;
  const id = focused?.sessionId ?? snapshot.activeSessionId ?? snapshot.stopped?.sessionId ?? null;
  return snapshot.sessions.find((s) => s.id === id && s.state !== "terminated") ?? snapshot.sessions.find((s) => s.state !== "terminated") ?? null;
}

/** The thread to continue / step: the focused one, else the stopped one, else the first. */
export async function currentThread(sessionId: string): Promise<number | null> {
  const focused = debugUi.getSnapshot().focused;
  if (focused?.sessionId === sessionId) return focused.threadId;
  const stopped = debugService.getSnapshot().stopped;
  if (stopped?.sessionId === sessionId) return stopped.threadId;
  const session = debugService.getSnapshot().sessions.find((s) => s.id === sessionId);
  if (session?.stoppedThreadId !== undefined) return session.stoppedThreadId;
  try {
    const threads = await debugService.threads(sessionId);
    return threads[0]?.id ?? null;
  } catch {
    return null;
  }
}

export async function debugStep(kind: "continue" | "next" | "in" | "out" | "pause") {
  const session = currentSession();
  if (!session) return;
  const threadId = await currentThread(session.id);
  if (threadId === null) return;
  if (kind === "continue") await debugService.resume(session.id, threadId);
  else if (kind === "pause") await debugService.pause(session.id, threadId);
  else await debugService.step(session.id, threadId, kind);
}

export function isDebugging(): boolean {
  return debugService.getSnapshot().sessions.some((s) => s.state !== "terminated");
}

export function isStopped(): boolean {
  return currentSession()?.state === "stopped";
}

/**
 * Start debugging: the selected launch configuration, else the only one,
 * else the default configuration of a debugger for the active file's language.
 */
export async function startDebugging(
  folder: string | null,
  activeLanguage: string | null,
  options: { noDebug?: boolean; pick?: (configs: HostDebugConfiguration[]) => Promise<HostDebugConfiguration | null> } = {},
) {
  let listed;
  try {
    listed = await debugService.listConfigurations(folder, true);
  } catch (error) {
    toast(t("Could not read launch configurations: {0}", error instanceof Error ? error.message : String(error)), "error");
    return;
  }
  if (listed.error) toast(`launch.json: ${listed.error}`, "error");
  let config: HostDebugConfiguration | null = null;
  const selected = debugUi.getSnapshot().selectedConfig;
  if (listed.configurations.length) {
    // Like VS Code's F5: the configuration selected in the Run and Debug view, else the first one;
    // `pick` ("Select and Start Debugging") asks instead.
    if (options.pick) {
      config = await options.pick(listed.configurations);
      if (!config) return;
    } else config = listed.configurations.find((c) => c.name === selected) ?? listed.configurations[0]!;
    debugUi.selectConfig(config.name);
  } else if (activeLanguage) {
    config = await debugService.defaultConfiguration(folder, activeLanguage);
  }
  if (!config) {
    const debuggers = debugService.debuggers();
    toast(
      debuggers.length
        ? activeLanguage
          ? t("No launch configuration, and no installed debugger supports {0}. Add a .vscode/launch.json.", activeLanguage)
          : t("No launch configuration, and no installed debugger supports this file. Add a .vscode/launch.json.")
        : t("No debugger is installed. Install a debugger extension (e.g. Python Debugger, JavaScript Debugger)."),
      "error",
    );
    return;
  }
  const configuration = options.noDebug ? { ...config, noDebug: true } : config;
  const result = (await debugService.startConfiguration(folder, configuration).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }))) as { sessionId?: string; error?: string } | undefined;
  if (result?.error) toast(t("Could not start debugging: {0}", result.error), "error");
}

export async function stopDebugging() {
  const session = currentSession();
  if (session) await debugService.stop(session.id);
}

export async function restartDebugging() {
  const session = currentSession();
  if (!session) return;
  const result = (await debugService.restart(session.id)) as { error?: string } | undefined;
  if (result?.error) toast(t("Could not restart: {0}", result.error), "error");
}

/* ── breakpoints ─────────────────────────────────────────────────────────── */

export function breakpointsFor(path: string): HostDebugBreakpoint[] {
  return debugService.getSnapshot().breakpoints.filter((bp) => bp.kind === "source" && samePath(bp.path, path));
}

export function toggleBreakpoint(path: string, line: number) {
  void debugService.toggleBreakpoint(path, line).catch(() => {});
}

export function setBreakpointEnabled(id: string, enabled: boolean) {
  void extensionService.call("debugSetBreakpointEnabled", id, enabled).catch(() => {});
}

export function removeBreakpoint(bp: HostDebugBreakpoint) {
  if (bp.kind === "source" && bp.path && bp.line) toggleBreakpoint(bp.path, bp.line);
}

/** Moves the breakpoints of a file to new lines (the user edited the document). */
export function moveBreakpoints(path: string, moved: { id: string; line: number }[]) {
  const lines = new Map(moved.map((m) => [m.id, m.line]));
  const next = breakpointsFor(path).map((bp) => ({
    line: lines.get(bp.id) ?? bp.line!,
    enabled: bp.enabled,
    condition: bp.condition,
    hitCondition: bp.hitCondition,
    logMessage: bp.logMessage,
  }));
  void debugService.setBreakpoints(path, next).catch(() => {});
}

/** Add or edit a conditional breakpoint / logpoint at a line. */
export async function editBreakpoint(path: string, line: number, kind: "condition" | "hitCondition" | "logMessage") {
  const existing = breakpointsFor(path).find((bp) => bp.line === line);
  const labels = {
    condition: {
      title: t("Conditional Breakpoint"),
      message: t("Break on line {0} when the expression is true.", line),
      placeholder: t("e.g. count > 10"),
    },
    hitCondition: {
      title: t("Hit Count Breakpoint"),
      message: t("Break on line {0} when the hit count condition is met.", line),
      placeholder: t("e.g. >= 5"),
    },
    logMessage: {
      title: t("Logpoint"),
      message: t("Log a message when line {0} is reached. Use {expression} to interpolate.", line),
      placeholder: t("e.g. value is {value}"),
    },
  }[kind];
  const value = await showPrompt({ ...labels, defaultValue: existing?.[kind] ?? "" });
  if (value === null) return;
  const others = breakpointsFor(path).filter((bp) => bp.line !== line);
  const next = [
    ...others.map((bp) => ({ line: bp.line!, enabled: bp.enabled, condition: bp.condition, hitCondition: bp.hitCondition, logMessage: bp.logMessage })),
    {
      line,
      enabled: true,
      condition: kind === "condition" ? value || undefined : existing?.condition,
      hitCondition: kind === "hitCondition" ? value || undefined : existing?.hitCondition,
      logMessage: kind === "logMessage" ? value || undefined : existing?.logMessage,
    },
  ];
  await debugService.setBreakpoints(path, next).catch(() => {});
}

/**
 * Context keys of the debug menus (debug/toolBar, debug/callstack/context,
 * debug/variables/context, debug/watch/context) for `session`; `extra` adds
 * the keys of the clicked element (callStackItemType, watchItemType, …).
 */
export function debugMenuLookup(session: HostDebugSession | null, extra: Record<string, unknown> = {}): (key: string) => unknown {
  return (key) => {
    if (key in extra) return extra[key];
    switch (key) {
      case "inDebugMode":
        return !!session;
      case "debugState":
        return !session ? "inactive" : session.state === "starting" ? "initializing" : session.state;
      case "debugType":
      case "debugConfigurationType":
        return session?.type;
      default:
        return undefined;
    }
  };
}
