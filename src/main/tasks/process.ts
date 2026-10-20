import { spawn, spawnSync } from "node:child_process";
import { basename } from "node:path";
import type { ProcessExecution, ShellExecution, ShellQuotedString } from "./task-types.ts";

/**
 * Running shell / process task executions as child processes, with output
 * streamed to a callback (the Tasks panel and the problem matchers read it).
 */

export type ShellFlavor = "cmd" | "powershell" | "posix";

export function shellFlavor(executable: string): ShellFlavor {
  const name = basename(executable).toLowerCase().replace(/\.exe$/, "");
  if (name === "cmd") return "cmd";
  if (name === "powershell" || name === "pwsh") return "powershell";
  return "posix";
}

export function defaultShell(platform: string = process.platform, env: Record<string, string | undefined> = process.env): string {
  if (platform === "win32") return env.ComSpec || "cmd.exe";
  return env.SHELL || "/bin/sh";
}

function shellArgsFor(flavor: ShellFlavor): string[] {
  return flavor === "cmd" ? ["/d", "/s", "/c"] : flavor === "powershell" ? ["-NoProfile", "-Command"] : ["-c"];
}

function quoteWith(value: string, quoting: number, flavor: ShellFlavor, options: ShellExecution["options"]): string {
  const custom = options?.shellQuoting;
  switch (quoting) {
    case 1: {
      // Escape
      const escape = custom?.escape;
      const escapeChar = typeof escape === "string" ? escape : (escape?.escapeChar ?? (flavor === "cmd" ? "^" : flavor === "powershell" ? "`" : "\\"));
      const chars = typeof escape === "object" && escape ? escape.charsToEscape : null;
      return [...value].map((char) => ((chars ? chars.includes(char) : /[\s"'&|<>;()$`\\*?#~{}[\]!%^]/.test(char)) ? escapeChar + char : char)).join("");
    }
    case 3: {
      // Weak: double quotes, the shell still expands variables.
      const mark = custom?.weak ?? '"';
      return `${mark}${value.split(mark).join(flavor === "cmd" ? mark + mark : flavor === "powershell" ? "`" + mark : "\\" + mark)}${mark}`;
    }
    default: {
      // Strong: nothing is expanded.
      const mark = custom?.strong ?? (flavor === "cmd" ? '"' : "'");
      let inner = mark === "'" ? value.split("'").join(flavor === "powershell" ? "''" : "'\\''") : value.split(mark).join(mark + mark);
      // PowerShell also takes the typographic single quotes as delimiters.
      if (flavor === "powershell" && mark === "'") inner = inner.replace(/[‘’‚‛]/g, (quote) => quote + quote);
      // cmd expands %VAR% even inside double quotes: leave the quotes around the percent sign.
      if (flavor === "cmd" && mark === '"') inner = inner.replaceAll("%", '"^%"');
      return `${mark}${inner}${mark}`;
    }
  }
}

function quotedPart(part: string | ShellQuotedString, flavor: ShellFlavor, options: ShellExecution["options"]): string {
  if (typeof part !== "string") return quoteWith(part.value, part.quoting, flavor, options);
  // Plain strings are quoted only when the shell would otherwise split them.
  // Only when the quotes are balanced: `"a" & calc & "b"` is not one quoted word.
  if (/^("(?:[^"\\]|\\.)*"|'[^']*')$/.test(part)) return part;
  return part === "" || /\s/.test(part) ? quoteWith(part, 2, flavor, options) : part;
}

/** The shell and the command line a ShellExecution runs. */
export function shellInvocation(execution: ShellExecution, platform: string = process.platform, env: Record<string, string | undefined> = process.env): { executable: string; args: string[]; line: string; flavor: ShellFlavor } {
  const executable = execution.options?.executable || defaultShell(platform, env);
  const flavor = shellFlavor(executable);
  let line: string;
  if (execution.commandLine !== undefined) line = execution.commandLine;
  else {
    const command = execution.command ?? "";
    const parts = [typeof command === "string" ? command : quoteWith(command.value, command.quoting, flavor, execution.options), ...(execution.args ?? []).map((arg) => quotedPart(arg, flavor, execution.options))];
    line = parts.join(" ");
    // A quoted command in PowerShell needs the call operator.
    if (flavor === "powershell" && typeof command !== "string") line = `& ${line}`;
  }
  return { executable, args: [...(execution.options?.shellArgs ?? shellArgsFor(flavor))], line, flavor };
}

export type RunSpec = {
  execution: ShellExecution | ProcessExecution;
  cwd: string | undefined;
  env: Record<string, string | undefined>;
};

export type RunningProcess = {
  pid: number | undefined;
  /** Resolves with the exit code (null when killed by a signal or failed to start). */
  done: Promise<number | null>;
  terminate(): void;
};

export function killTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } catch {
      /* already gone */
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

export function runProcess(spec: RunSpec, onOutput: (text: string) => void, onStart?: (pid: number | undefined) => void): RunningProcess {
  const { execution } = spec;
  const isShell = "commandLine" in execution || "command" in execution;
  let file: string;
  let args: string[];
  let verbatim = false;
  if (isShell) {
    const invocation = shellInvocation(execution as ShellExecution, process.platform, spec.env);
    file = invocation.executable;
    args = invocation.flavor === "cmd" ? [...invocation.args, `"${invocation.line}"`] : [...invocation.args, invocation.line];
    verbatim = invocation.flavor === "cmd";
  } else {
    file = (execution as ProcessExecution).process;
    args = (execution as ProcessExecution).args.map(String);
  }
  const env = Object.fromEntries(Object.entries(spec.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  let child: ReturnType<typeof spawn>;
  let settle!: (code: number | null) => void;
  const done = new Promise<number | null>((resolve) => (settle = resolve));
  try {
    child = spawn(file, args, { cwd: spec.cwd, env, windowsHide: true, windowsVerbatimArguments: verbatim, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    onOutput(`Failed to start '${file}': ${error instanceof Error ? error.message : String(error)}\r\n`);
    settle(null);
    return { pid: undefined, done, terminate: () => {} };
  }
  child.stdout?.setEncoding("utf8").on("data", onOutput);
  child.stderr?.setEncoding("utf8").on("data", onOutput);
  let finished = false;
  child.on("error", (error) => {
    onOutput(`Failed to run '${file}': ${error.message}\r\n`);
    if (!finished) {
      finished = true;
      settle(null);
    }
  });
  child.on("close", (code) => {
    if (finished) return;
    finished = true;
    settle(code);
  });
  if (child.pid !== undefined) onStart?.(child.pid);
  return {
    pid: child.pid,
    done,
    terminate: () => {
      if (child.pid !== undefined && !finished) killTree(child.pid);
    },
  };
}

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][A-Za-z0-9]/g;

/** Output without colour codes and carriage returns, for matching and display. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}
