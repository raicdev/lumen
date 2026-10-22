import type { ExtensionHost } from "../../host.ts";
import type { ExtensionRuntime } from "../../host.ts";
import * as T from "../../types.ts";
import type { ShellExecution } from "./shell.ts";
import { TERMINAL_AREA } from "../../../../shared/terminal-protocol.ts";

/**
 * `contributes.terminal.quickFixes` and
 * `window.registerTerminalQuickFixProvider` (proposed API): when a shell
 * execution ends, matching contributions' providers get the command line,
 * its output and exit code; what they return is shown as a lightbulb in the
 * terminal and run / opened when picked.
 */

/** vscode.TerminalQuickFixTerminalCommand (proposed API): type the command into the terminal. */
export class TerminalQuickFixTerminalCommand {
  terminalCommand: string;
  /** Run it (`sendText(..., true)`); false only types it. Defaults to true. */
  shouldExecute?: boolean;
  constructor(terminalCommand: string, shouldExecute?: boolean) {
    this.terminalCommand = terminalCommand;
    this.shouldExecute = shouldExecute;
  }
}

/** vscode.TerminalQuickFixOpener (proposed API): open a URI. */
export class TerminalQuickFixOpener {
  uri: T.Uri;
  constructor(uri: T.Uri) {
    this.uri = uri;
  }
}

/**
 * vscode.TerminalCommandMatchResult (proposed API), what provideTerminalQuickFixes gets.
 * `exitCode` and `cwd` are extras of Lumen's.
 */
export type TerminalQuickFixContext = {
  commandLine: string;
  commandLineMatch: RegExpMatchArray;
  outputMatch?: { regexMatch: RegExpMatchArray; outputLines: string[] };
  cwd: T.Uri | undefined;
  exitCode: number | undefined;
};

/** One fix in the window's lightbulb menu. */
export type TerminalQuickFixWire = { fixId: string; label: string; kind: "default" | "explain" };

export type TerminalQuickFixAction =
  | { type: "command"; command: string; execute: boolean }
  | { type: "opener"; uri: string }
  | { type: "execute"; command: string; args: unknown[] };

type QuickFixContribution = {
  id: string;
  commandLineMatcher: string;
  outputMatcher?: { lineMatcher?: string; anchor?: string; offset?: number; length?: number };
  commandExitResult?: string;
  kind?: string;
};

type Called = { terminalId: string; action: TerminalQuickFixAction };

type QuickFixState = {
  providers: Map<string, { extensionId: string; provider: any }>;
  /** Fixes the window was shown, by the id it got (activation goes back by id). */
  actions: Map<string, Called>;
  /** Terminals the window currently shows fixes for (no empty message when there are none). */
  shown: Set<string>;
  seq: number;
};

const states = new WeakMap<ExtensionHost, QuickFixState>();

function stateOf(host: ExtensionHost): QuickFixState {
  let state = states.get(host);
  if (!state) {
    state = { providers: new Map(), actions: new Map(), shown: new Set(), seq: 0 };
    states.set(host, state);
  }
  return state;
}

const MAX_ACTIONS = 200;

/** Terminal escape sequences (OSC, CSI) that output matchers should not see. */
// eslint-disable-next-line no-control-regex -- escape sequences start with ESC
const ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** The output split into lines, escape sequences removed (what a line matcher is tested against). */
export function outputLines(output: string): string[] {
  if (!output) return [];
  return output.replace(ESCAPES, "").replace(/\r/g, "").replace(/\n+$/, "").split("\n");
}

/** The `contributes.terminal.quickFixes` entries of every extension (`contributes.terminalQuickFixes` too). */
function contributions(host: ExtensionHost): { entry: QuickFixContribution; extensionId: string; runtime: ExtensionRuntime }[] {
  const out: { entry: QuickFixContribution; extensionId: string; runtime: ExtensionRuntime }[] = [];
  for (const runtime of host.runtimes.values()) {
    const contributes = runtime.description?.manifest?.contributes as { terminal?: { quickFixes?: unknown }; terminalQuickFixes?: unknown } | undefined;
    const lists = [contributes?.terminal?.quickFixes, contributes?.terminalQuickFixes];
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const candidate of list) {
        const entry = candidate as QuickFixContribution;
        if (!entry || typeof entry.id !== "string" || typeof entry.commandLineMatcher !== "string") continue;
        out.push({ entry, extensionId: runtime.id, runtime });
      }
    }
  }
  return out;
}

function matchRegex(source: string, value: string): RegExpMatchArray | null {
  try {
    return value.match(new RegExp(source));
  } catch {
    return null;
  }
}

/**
 * The output matcher's match: `anchor` + `offset` pick where the `length` lines it looks at
 * start, and the first of them the line matcher matches wins (as in VS Code).
 */
function matchOutput(lines: string[], matcher: NonNullable<QuickFixContribution["outputMatcher"]>): TerminalQuickFixContext["outputMatch"] | null {
  if (!lines.length || typeof matcher.lineMatcher !== "string") return null;
  const offset = Math.max(0, Math.floor(Number(matcher.offset) || 0));
  const length = Math.max(1, Math.floor(Number(matcher.length) || 1));
  const start = matcher.anchor === "top" ? offset : Math.max(0, lines.length - offset - length);
  const outputLines = lines.slice(start, start + length);
  for (const line of outputLines) {
    const regexMatch = matchRegex(matcher.lineMatcher, line);
    if (regexMatch) return { regexMatch, outputLines };
  }
  return null;
}

function exitMatches(result: string | undefined, exitCode: number | undefined): boolean {
  if (result === "success") return exitCode === 0;
  // "error" includes an unknown exit code; a contribution without commandExitResult matches either.
  if (result === "error") return exitCode !== 0;
  return result === undefined;
}

function postQuickFixes(host: ExtensionHost, terminalId: string, fixes: TerminalQuickFixWire[]) {
  const state = stateOf(host);
  if (fixes.length) state.shown.add(terminalId);
  else if (!state.shown.delete(terminalId)) return;
  host.postFeature(TERMINAL_AREA, { kind: "quickFixes", id: terminalId, fixes });
}

/** `window.registerTerminalQuickFixProvider(id, provider)`. */
export function registerQuickFixProvider(host: ExtensionHost, id: string, extensionId: string, provider: any): T.Disposable {
  const state = stateOf(host);
  const key = String(id);
  const entry = { extensionId, provider };
  state.providers.set(key, entry);
  return new T.Disposable(() => {
    if (state.providers.get(key) === entry) state.providers.delete(key);
  });
}

/** A new command started in the terminal: the last one's fixes no longer apply. */
export function clearQuickFixes(host: ExtensionHost, terminalId: string) {
  const state = stateOf(host);
  for (const [fixId, entry] of state.actions) if (entry.terminalId === terminalId) state.actions.delete(fixId);
  postQuickFixes(host, terminalId, []);
}

function actionOf(item: any): { label: string; action: TerminalQuickFixAction } | undefined {
  if (!item || typeof item !== "object") return undefined;
  if (typeof item.terminalCommand === "string") {
    // shouldExecute defaults to true, like sendText's.
    return { label: item.terminalCommand, action: { type: "command", command: item.terminalCommand, execute: item.shouldExecute !== false } };
  }
  const uri = T.Uri.isUri(item.uri) ? item.uri : typeof item.uri === "string" ? T.Uri.parse(item.uri) : undefined;
  if (uri) return { label: uri.scheme === "file" ? uri.fsPath : uri.toString(true), action: { type: "opener", uri: uri.toString(true) } };
  if (typeof item.command === "string") {
    const args = Array.isArray(item.arguments) ? item.arguments : item.arguments === undefined ? [] : [item.arguments];
    return { label: typeof item.title === "string" && item.title ? item.title : item.command, action: { type: "execute", command: item.command, args } };
  }
  return undefined;
}

/** A shell execution ended: ask the providers of the matching contributions. */
export async function runQuickFixes(host: ExtensionHost, terminalId: string, execution: ShellExecution, exitCode: number | undefined) {
  const state = stateOf(host);
  const lines = outputLines(execution.output);
  const candidates = contributions(host).flatMap(({ entry, extensionId, runtime }) => {
    if (!exitMatches(entry.commandExitResult, exitCode)) return [];
    const commandLineMatch = matchRegex(entry.commandLineMatcher, execution.commandLine.value);
    if (!commandLineMatch) return [];
    const outputMatch = entry.outputMatcher === undefined ? undefined : matchOutput(lines, entry.outputMatcher);
    if (outputMatch === null) return [];
    const context: TerminalQuickFixContext = { commandLine: execution.commandLine.value, commandLineMatch, outputMatch, cwd: execution.cwd, exitCode };
    return [{ entry, extensionId, runtime, context }];
  });
  const fixes: TerminalQuickFixWire[] = [];
  if (candidates.length) {
    for (const { entry, extensionId, runtime, context } of candidates) {
      // VS Code generates `onTerminalQuickFixRequest:<id>` from the contribution; activate the
      // extension directly so contributions work even when the manifest does not list it.
      if (!runtime.activated) await host.activate(runtime, `terminal quick fix ${entry.id}`).catch(() => {});
      const provider = state.providers.get(entry.id)?.provider;
      if (!provider || typeof provider.provideTerminalQuickFixes !== "function") continue;
      const source = new T.CancellationTokenSource();
      let result: unknown;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        result = await Promise.race([
          Promise.resolve(provider.provideTerminalQuickFixes(context, source.token)),
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => {
              source.cancel();
              resolve(undefined);
            }, 3000);
          }),
        ]);
      } catch (error) {
        host.log("warning", `terminal quick fix provider '${entry.id}' failed: ${error instanceof Error ? error.message : String(error)}`, extensionId);
        continue;
      } finally {
        if (timer) clearTimeout(timer);
        source.dispose();
      }
      const items = Array.isArray(result) ? result : result ? [result] : [];
      for (const item of items) {
        const mapped = actionOf(item);
        if (!mapped) continue;
        const fixId = String(++state.seq);
        state.actions.set(fixId, { terminalId, action: mapped.action });
        fixes.push({ fixId, label: mapped.label, kind: entry.kind === "explain" ? "explain" : "default" });
      }
      if (fixes.length >= 20) break;
    }
    while (state.actions.size > MAX_ACTIONS) state.actions.delete(state.actions.keys().next().value!);
  }
  postQuickFixes(host, terminalId, fixes);
}

/** A fix was picked in the terminal's lightbulb menu: run the command, open the URI or execute the command. */
export async function applyQuickFix(host: ExtensionHost, terminalId: string, fixId: string): Promise<boolean> {
  const state = stateOf(host);
  const entry = state.actions.get(fixId);
  if (!entry || entry.terminalId !== terminalId) return false;
  state.actions.delete(fixId);
  const action = entry.action;
  try {
    if (action.type === "command") {
      await host.requestFeatureView(TERMINAL_AREA, "reveal", [terminalId]);
      await host.requestView("terminalShow", terminalId, false);
      await host.requestView("terminalSendText", terminalId, action.command, action.execute);
    } else if (action.type === "opener") {
      await host.executeCommand("vscode.open", [T.Uri.parse(action.uri)]);
    } else {
      await host.executeCommand(action.command, action.args);
    }
    return true;
  } catch (error) {
    host.log("warning", `terminal quick fix failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
