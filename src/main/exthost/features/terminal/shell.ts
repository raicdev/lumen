import { Uri } from "../../types.ts";
import type { ShellIntegrationEvent } from "../../../../shared/terminal-integration.ts";

/**
 * Host side of shell integration: turns the events the view parsed from the
 * shell's OSC 633 / 133 sequences into `Terminal.shellIntegration`,
 * TerminalShellExecution objects and the start / end events.
 */

/** TerminalShellExecutionCommandLineConfidence. */
export const CommandLineConfidence = Object.freeze({ Low: 0, Medium: 1, High: 2, 0: "Low", 1: "Medium", 2: "High" } as const);

/** The shell's name as `Terminal.state.shell` reports it (`pwsh`, `bash`, `gitbash`, …). */
export function shellTypeOf(shellPath: string | undefined): string | undefined {
  if (!shellPath) return undefined;
  const lower = shellPath.replaceAll("\\", "/").toLowerCase();
  const name = (lower.split("/").pop() ?? lower).replace(/\.exe$/, "");
  if (name === "bash" && /\/git\//.test(lower)) return "gitbash";
  if (name === "powershell" || name === "pwsh") return "pwsh";
  return name || undefined;
}

function quoteFor(shell: string | undefined, value: string): string {
  if (shell === "pwsh") return /^[\w./:\\-]+$/.test(value) ? value : `'${value.replace(/['‘’‚‛]/g, (quote) => quote + quote)}'`;
  if (shell === "cmd") return /^[\w./:\\-]+$/.test(value) ? value : `"${value.replaceAll('"', '""')}"`;
  return /^[\w./:=@%+,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The command line for `executeCommand(executable, args)` in the given kind of shell. */
export function commandLineFor(shell: string | undefined, executable: string, args: readonly string[]): string {
  const parts = [quoteFor(shell, executable), ...args.map((arg) => quoteFor(shell, arg))];
  return shell === "pwsh" ? `& ${parts.join(" ")}` : parts.join(" ");
}

/** An AsyncIterable fed with chunks; ends when `end()` is called. */
class OutputStream implements AsyncIterable<string> {
  #chunks: string[] = [];
  #waiters: ((result: IteratorResult<string>) => void)[] = [];
  #done = false;

  push(data: string) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: data, done: false });
    else this.#chunks.push(data);
  }

  end() {
    this.#done = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: () => {
        if (this.#chunks.length) return Promise.resolve({ value: this.#chunks.shift()!, done: false });
        if (this.#done) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<string>>((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

/** Kept for output matchers (terminal quick fixes) and the API's read(): only the end matters. */
const MAX_OUTPUT = 128 * 1024;

export class ShellExecution {
  readonly commandLine: { readonly value: string; readonly isTrusted: boolean; readonly confidence: number };
  readonly cwd: Uri | undefined;
  #streams = new Set<OutputStream>();
  #ended = false;
  #output = "";

  constructor(commandLine: { value: string; isTrusted: boolean; confidence: number }, cwd: Uri | undefined) {
    this.commandLine = commandLine;
    this.cwd = cwd;
  }

  /** Raw output (escape sequences included) written after the first call, like TerminalShellExecution.read. */
  read(): AsyncIterable<string> {
    const stream = new OutputStream();
    if (this.#ended) stream.end();
    else this.#streams.add(stream);
    return stream;
  }

  push(data: string) {
    if (data) this.#output = (this.#output + data).slice(-MAX_OUTPUT);
    for (const stream of this.#streams) stream.push(data);
  }

  /** The raw output written so far (escape sequences included), for output matchers. */
  get output(): string {
    return this.#output;
  }

  end() {
    this.#ended = true;
    for (const stream of this.#streams) stream.end();
    this.#streams.clear();
  }
}

export type ShellHooks = {
  /** Type text (and a newline) into the terminal. */
  send(text: string): void;
  /** The shell's type (`Terminal.state.shell`). */
  shell(): string | undefined;
  /** First sign of integration, or the cwd changed. */
  changed(): void;
  started(execution: ShellExecution): void;
  ended(execution: ShellExecution, exitCode: number | undefined): void;
};

export class ShellIntegrationModel {
  /** The object extensions get as `Terminal.shellIntegration` (once integration was detected). */
  readonly api: {
    readonly cwd: Uri | undefined;
    executeCommand(commandLineOrExecutable: string, args?: readonly string[]): ShellExecution;
  };
  detected = false;
  #cwd: Uri | undefined;
  #hooks: ShellHooks;
  #pendingLine: { value: string; nonceVerified: boolean } | undefined;
  /** Commands an extension sent with executeCommand, waiting for their execution to start. */
  #queued: { value: string; execution?: ShellExecution }[] = [];
  #current: ShellExecution | undefined;

  constructor(hooks: ShellHooks) {
    this.#hooks = hooks;
    const model = this;
    this.api = {
      get cwd() {
        return model.#cwd;
      },
      executeCommand(commandLineOrExecutable, args) {
        const value = args ? commandLineFor(model.#hooks.shell(), commandLineOrExecutable, args) : commandLineOrExecutable;
        // The execution object exists right away; its start event comes when the shell reports it.
        const execution = new ShellExecution({ value, isTrusted: true, confidence: CommandLineConfidence.High }, model.#cwd);
        model.#queued.push({ value, execution });
        model.#hooks.send(`${value}\r`);
        return execution;
      },
    };
  }

  get cwd(): Uri | undefined {
    return this.#cwd;
  }

  get running(): ShellExecution | undefined {
    return this.#current;
  }

  handle(event: ShellIntegrationEvent): void {
    const first = !this.detected;
    this.detected = true;
    let changed = first;
    switch (event.type) {
      case "property":
        if (event.key === "Cwd" && event.value) {
          const next = Uri.file(event.value);
          if (next.toString() !== this.#cwd?.toString()) {
            this.#cwd = next;
            changed = true;
          }
        }
        break;
      case "command-line":
        this.#pendingLine = { value: event.commandLine, nonceVerified: event.nonceVerified };
        break;
      case "executing":
        this.#start();
        break;
      case "output":
        this.#current?.push(event.data);
        break;
      case "finished":
        this.#finish(event.exitCode);
        break;
      default:
        break;
    }
    if (changed) this.#hooks.changed();
  }

  /** The terminal is gone: end what is running. */
  dispose(): void {
    this.#finish(undefined);
  }

  #start() {
    if (this.#current) this.#finish(undefined);
    const reported = this.#pendingLine;
    this.#pendingLine = undefined;
    const queuedIndex = this.#queued.findIndex((entry) => reported === undefined || entry.value === reported.value);
    const queued = queuedIndex >= 0 ? this.#queued.splice(queuedIndex, 1)[0] : undefined;
    if (queued?.execution) {
      this.#current = queued.execution;
    } else {
      // Typed by the user. A line carrying our per-terminal nonce is what VS Code calls
      // trusted / High: only the shell integration script can produce it.
      const verified = reported?.nonceVerified === true;
      const confidence = reported === undefined ? CommandLineConfidence.Low : verified ? CommandLineConfidence.High : CommandLineConfidence.Medium;
      this.#current = new ShellExecution({ value: reported?.value ?? "", isTrusted: verified, confidence }, this.#cwd);
    }
    this.#hooks.started(this.#current);
  }

  #finish(exitCode: number | undefined) {
    const execution = this.#current;
    if (!execution) return;
    this.#current = undefined;
    execution.end();
    this.#hooks.ended(execution, exitCode);
  }
}
