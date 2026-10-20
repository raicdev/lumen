/**
 * Classes and enums of the `tasks` API (Task, ShellExecution, TaskGroup, ...).
 * Plain data holders: running them is src/main/exthost/features/tasks.ts.
 */

function frozenEnum<T extends Record<string, number>>(values: T): Readonly<T> & Readonly<Record<number, string>> {
  const out: Record<string | number, string | number> = { ...values };
  for (const [name, value] of Object.entries(values)) out[value] = name;
  return Object.freeze(out) as Readonly<T> & Readonly<Record<number, string>>;
}

export const TaskScope = frozenEnum({ Global: 1, Workspace: 2 });
export const TaskRevealKind = frozenEnum({ Always: 1, Silent: 2, Never: 3 });
export const TaskPanelKind = frozenEnum({ Shared: 1, Dedicated: 2, New: 3 });
export const ShellQuoting = frozenEnum({ Escape: 1, Strong: 2, Weak: 3 });

export type ShellQuotedString = { value: string; quoting: number };

export class TaskGroup {
  static readonly Clean = new TaskGroup("clean", "Clean");
  static readonly Build = new TaskGroup("build", "Build");
  static readonly Rebuild = new TaskGroup("rebuild", "Rebuild");
  static readonly Test = new TaskGroup("test", "Test");

  /** The group a tasks.json `group` kind names ("build", "test", ...), or undefined. */
  static from(value: string): TaskGroup | undefined {
    switch (value) {
      case "clean":
        return TaskGroup.Clean;
      case "build":
        return TaskGroup.Build;
      case "rebuild":
        return TaskGroup.Rebuild;
      case "test":
        return TaskGroup.Test;
      default:
        return undefined;
    }
  }

  readonly id: string;
  readonly label: string;
  isDefault?: boolean;
  constructor(id: string, label: string) {
    this.id = id;
    this.label = label;
  }
}

export type ShellExecutionOptions = {
  executable?: string;
  shellArgs?: string[];
  shellQuoting?: { escape?: string | { escapeChar: string; charsToEscape: string }; strong?: string; weak?: string };
  cwd?: string;
  env?: Record<string, string>;
};

export type ProcessExecutionOptions = { cwd?: string; env?: Record<string, string> };

export class ShellExecution {
  commandLine?: string;
  command?: string | ShellQuotedString;
  args?: (string | ShellQuotedString)[];
  options?: ShellExecutionOptions;
  constructor(commandLine: string, options?: ShellExecutionOptions);
  constructor(command: string | ShellQuotedString, args: (string | ShellQuotedString)[], options?: ShellExecutionOptions);
  constructor(commandOrLine: string | ShellQuotedString, argsOrOptions?: (string | ShellQuotedString)[] | ShellExecutionOptions, options?: ShellExecutionOptions) {
    if (Array.isArray(argsOrOptions)) {
      this.command = commandOrLine;
      this.args = argsOrOptions;
      this.options = options;
    } else {
      if (typeof commandOrLine !== "string") throw new Error("illegal argument: commandLine must be a string");
      this.commandLine = commandOrLine;
      this.options = argsOrOptions;
    }
  }
}

export class ProcessExecution {
  process: string;
  args: string[];
  options?: ProcessExecutionOptions;
  constructor(process: string, options?: ProcessExecutionOptions);
  constructor(process: string, args: string[], options?: ProcessExecutionOptions);
  constructor(process: string, argsOrOptions?: string[] | ProcessExecutionOptions, options?: ProcessExecutionOptions) {
    if (typeof process !== "string") throw new Error("illegal argument: process must be a string");
    this.process = process;
    if (Array.isArray(argsOrOptions)) {
      this.args = argsOrOptions;
      this.options = options;
    } else {
      this.args = [];
      this.options = argsOrOptions;
    }
  }
}

export class CustomExecution {
  /** The callback is private in VS Code; kept readable here for the runner. */
  readonly callback: (resolvedDefinition: Record<string, unknown>) => PromiseLike<unknown>;
  constructor(callback: (resolvedDefinition: Record<string, unknown>) => PromiseLike<unknown>) {
    this.callback = callback;
  }
}

export type TaskExecutionKind = ShellExecution | ProcessExecution | CustomExecution;

export class Task {
  definition: Record<string, unknown> & { type: string };
  scope: number | { uri: unknown; name: string; index: number } | undefined;
  name: string;
  source: string;
  execution?: TaskExecutionKind;
  problemMatchers: string[];
  isBackground = false;
  group?: TaskGroup;
  detail?: string;
  presentationOptions: Record<string, unknown> = {};
  runOptions: { reevaluateOnRerun?: boolean } = {};

  constructor(definition: Record<string, unknown> & { type: string }, scope: Task["scope"], name: string, source: string, execution?: TaskExecutionKind, problemMatchers?: string | string[]);
  /** Deprecated form without a scope. */
  constructor(definition: Record<string, unknown> & { type: string }, name: string, source: string, execution?: TaskExecutionKind, problemMatchers?: string | string[]);
  constructor(definition: Record<string, unknown> & { type: string }, ...rest: unknown[]) {
    this.definition = definition;
    let matchers: string | string[] | undefined;
    if (typeof rest[0] === "string") {
      // (definition, name, source, execution?, problemMatchers?)
      this.scope = undefined;
      this.name = rest[0];
      this.source = String(rest[1] ?? "");
      this.execution = rest[2] as TaskExecutionKind | undefined;
      matchers = rest[3] as string | string[] | undefined;
    } else {
      this.scope = rest[0] as Task["scope"];
      this.name = String(rest[1] ?? "");
      this.source = String(rest[2] ?? "");
      this.execution = rest[3] as TaskExecutionKind | undefined;
      matchers = rest[4] as string | string[] | undefined;
    }
    if (!this.name) throw new Error("name is required");
    this.problemMatchers = matchers === undefined ? [] : typeof matchers === "string" ? [matchers] : [...matchers];
  }
}
