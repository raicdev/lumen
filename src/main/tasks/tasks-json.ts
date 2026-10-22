import { basename, dirname, extname, relative, sep } from "node:path";
import { parseJsonc } from "../../shared/jsonc.ts";

/**
 * .vscode/tasks.json: parsing (comments, platform overrides, global defaults)
 * and the `${...}` variables of task fields.
 */

export type JsonTaskGroup = string | { kind?: string; isDefault?: boolean };

export type JsonTask = {
  label: string;
  type: string;
  command?: string;
  args?: (string | { value: string; quoting: string })[];
  options?: { cwd?: string; env?: Record<string, string>; shell?: { executable?: string; args?: string[] } };
  group?: JsonTaskGroup;
  problemMatcher?: unknown;
  isBackground?: boolean;
  presentation?: Record<string, unknown>;
  dependsOn?: unknown;
  dependsOrder?: "parallel" | "sequence";
  runOptions?: Record<string, unknown>;
  detail?: string;
  hide?: boolean;
  /** The task as written (platform keys resolved); the Task `definition`. */
  raw: Record<string, unknown>;
  [key: string]: unknown;
};

export type InputDef = { id: string; type: string; description?: string; default?: string; password?: boolean; options?: (string | { label: string; value: string })[]; command?: string; args?: unknown };

export type TasksFile = { version?: string; tasks: JsonTask[]; inputs: InputDef[] };

const PLATFORM_KEY: Record<string, string> = { win32: "windows", darwin: "osx", linux: "linux" };

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A task (or the file's top level) with its `windows` / `osx` / `linux` block laid over it. */
function withPlatform(value: Record<string, unknown>, platform: string): Record<string, unknown> {
  const override = value[PLATFORM_KEY[platform] ?? "linux"];
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) if (key !== "windows" && key !== "osx" && key !== "linux") out[key] = item;
  if (isObject(override)) {
    for (const [key, item] of Object.entries(override)) out[key] = key === "options" && isObject(item) && isObject(out.options) ? { ...out.options, ...item } : item;
  }
  return out;
}

export function parseTasksJson(text: string, platform: string = process.platform): TasksFile {
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch {
    return { tasks: [], inputs: [] };
  }
  if (!isObject(parsed)) return { tasks: [], inputs: [] };
  const top = withPlatform(parsed, platform);
  const list = Array.isArray(top.tasks) ? top.tasks : [];
  const inputs = (Array.isArray(top.inputs) ? top.inputs : []).filter((item): item is InputDef => isObject(item) && typeof item.id === "string" && typeof item.type === "string");
  const globalCommand = typeof top.command === "string" ? top.command : undefined;
  const tasks: JsonTask[] = [];
  for (const entry of list) {
    if (!isObject(entry)) continue;
    const task = withPlatform(entry, platform);
    // Version 0.1.0 style: `taskName` and a global command the tasks only pass arguments to.
    const label = typeof task.label === "string" ? task.label : typeof task.taskName === "string" ? task.taskName : typeof task.script === "string" && typeof task.type === "string" ? `${task.type}: ${task.script}` : undefined;
    if (!label) continue;
    let command = typeof task.command === "string" ? task.command : undefined;
    let args = Array.isArray(task.args) ? (task.args as JsonTask["args"]) : undefined;
    let options = isObject(task.options) ? (task.options as JsonTask["options"]) : undefined;
    let type = typeof task.type === "string" ? task.type : undefined;
    if (!command && globalCommand) {
      command = globalCommand;
      args = [...(Array.isArray(top.args) ? (top.args as NonNullable<JsonTask["args"]>) : []), ...(args ?? [])];
      options = { ...(isObject(top.options) ? (top.options as JsonTask["options"]) : {}), ...options };
      type ??= typeof top.type === "string" ? top.type : undefined;
    }
    type ??= "shell";
    const inherited = (key: string) => (task[key] !== undefined ? task[key] : top[key]);
    tasks.push({
      ...task,
      label,
      type,
      command,
      args,
      options,
      group: inherited("group") as JsonTaskGroup | undefined,
      problemMatcher: inherited("problemMatcher"),
      isBackground: (inherited("isBackground") ?? inherited("isWatching")) as boolean | undefined,
      presentation: { ...(isObject(top.presentation) ? top.presentation : {}), ...(isObject(task.presentation) ? task.presentation : {}) },
      dependsOn: task.dependsOn,
      dependsOrder: task.dependsOrder === "sequence" ? "sequence" : "parallel",
      runOptions: isObject(task.runOptions) ? task.runOptions : undefined,
      detail: typeof task.detail === "string" ? task.detail : undefined,
      hide: task.hide === true,
      raw: { ...task, label, type },
    });
  }
  return { version: typeof top.version === "string" ? top.version : undefined, tasks, inputs };
}

/** `group` as `{ kind, isDefault }`. */
export function groupOf(group: JsonTaskGroup | undefined): { kind: string; isDefault: boolean } | undefined {
  if (typeof group === "string") return { kind: group, isDefault: false };
  if (isObject(group) && typeof group.kind === "string") return { kind: group.kind, isDefault: group.isDefault === true };
  return undefined;
}

/** The labels a task depends on. */
export function dependenciesOf(task: Record<string, unknown>): { label: string; type?: string }[] {
  const value = task.dependsOn;
  if (value === undefined || value === null) return [];
  return [value].flat().flatMap((item) => {
    if (typeof item === "string") return [{ label: item }];
    if (isObject(item) && typeof item.task === "string") return [{ label: item.task, type: typeof item.type === "string" ? item.type : undefined }];
    return [];
  });
}

/** `problemMatcher` as a list of references / definitions. */
export function matchersOf(value: unknown): (string | Record<string, unknown>)[] {
  if (value === undefined || value === null) return [];
  return [value].flat().filter((item): item is string | Record<string, unknown> => typeof item === "string" || isObject(item));
}

/* ── taskDefinitions ─────────────────────────────────────────────────────── */

export type TaskDefinitionProperty = { type?: string | string[]; description?: string };

/** A `contributes.taskDefinitions` entry. */
export type TaskDefinitionContribution = {
  type?: string;
  properties?: Record<string, TaskDefinitionProperty | undefined>;
  required?: string[];
};

export type TaskDefinitionIssue = { severity: "error" | "warning"; message: string };

function valueTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isObject(value);
    case "null":
      return value === null;
    // An unknown type keyword constrains nothing.
    default:
      return true;
  }
}

/**
 * Validate a tasks.json entry of a contributed type against its taskDefinitions
 * entry, like the tasks.json schema VS Code generates: missing `required`
 * properties are errors, values that do not match a declared property type are
 * warnings.
 */
export function taskDefinitionIssues(task: Record<string, unknown>, definition: TaskDefinitionContribution | undefined): TaskDefinitionIssue[] {
  if (!definition) return [];
  const issues: TaskDefinitionIssue[] = [];
  for (const name of definition.required ?? []) {
    if (typeof name === "string" && task[name] === undefined) issues.push({ severity: "error", message: `Required property '${name}' is missing.` });
  }
  for (const [name, property] of Object.entries(definition.properties ?? {})) {
    const value = task[name];
    if (value === undefined || !property) continue;
    const types = [property.type ?? []].flat().filter((type): type is string => typeof type === "string");
    if (!types.length || types.some((type) => matchesType(value, type))) continue;
    issues.push({
      severity: "warning",
      message: `Property '${name}' should be of type ${types.map((type) => `'${type}'`).join(" or ")} but is of type '${valueTypeOf(value)}'.`,
    });
  }
  return issues;
}

/* ── variables ───────────────────────────────────────────────────────────── */

export type VariableContext = {
  workspaceFolder: string | null;
  /** The active editor's file, for `${file}` and friends. */
  file: string | null;
  lineNumber?: number;
  selectedText?: string;
  env: Record<string, string | undefined>;
  userHome: string;
  /** `${config:key}`. */
  config: (key: string) => unknown;
  /** `${input:id}`; undefined when there is no such input. May ask the user. */
  input?: (id: string) => Promise<string | undefined> | string | undefined;
  /** `${command:id}`. */
  command?: (id: string) => Promise<unknown> | unknown;
  /** The directory `${cwd}` stands for (the task's working directory). */
  cwd?: string;
};

/** Thrown when an input was cancelled: the task is not run. */
export class InputCancelled extends Error {
  constructor() {
    super("input cancelled");
  }
}

function variableValue(name: string, argument: string | undefined, context: VariableContext): string | undefined | Promise<string | undefined> {
  const workspace = context.workspaceFolder ?? "";
  const file = context.file ?? "";
  switch (name) {
    case "workspaceFolder":
      return workspace;
    case "workspaceFolderBasename":
      return workspace ? basename(workspace) : "";
    case "file":
      return file;
    case "fileWorkspaceFolder":
      return workspace;
    case "relativeFile":
      return file && workspace ? relative(workspace, file) : file;
    case "relativeFileDirname":
      return file && workspace ? dirname(relative(workspace, file)) : file ? dirname(file) : "";
    case "fileBasename":
      return file ? basename(file) : "";
    case "fileBasenameNoExtension":
      return file ? basename(file, extname(file)) : "";
    case "fileExtname":
      return file ? extname(file) : "";
    case "fileDirname":
      return file ? dirname(file) : "";
    case "fileDirnameBasename":
      return file ? basename(dirname(file)) : "";
    case "cwd":
      return context.cwd ?? workspace;
    case "lineNumber":
      return String(context.lineNumber ?? "");
    case "selectedText":
      return context.selectedText ?? "";
    case "userHome":
      return context.userHome;
    case "pathSeparator":
    case "/":
      return sep;
    case "env":
      return argument === undefined ? undefined : (context.env[argument] ?? context.env[argument.toUpperCase()] ?? "");
    case "config": {
      const value = argument === undefined ? undefined : context.config(argument);
      return value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    }
    case "input":
      return argument === undefined ? undefined : Promise.resolve(context.input?.(argument)).then((value) => {
        if (value === undefined) throw new InputCancelled();
        return value;
      });
    case "command":
      return argument === undefined ? undefined : Promise.resolve(context.command?.(argument)).then((value) => (value === undefined || value === null ? "" : String(value)));
    default:
      return undefined;
  }
}

const VARIABLE = /\$\{([^}:]+)(?::([^}]*))?\}/g;

/** Substitute `${...}` in a string; unknown variables are kept as written. */
export async function expandVariables(text: string, context: VariableContext): Promise<string> {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(VARIABLE)) {
    out += text.slice(last, match.index);
    const value = await variableValue(match[1]!, match[2], context);
    out += value === undefined ? match[0] : value;
    last = match.index + match[0].length;
  }
  return out + text.slice(last);
}

/** Synchronous variant (no `input` / `command`; those are kept as written). */
export function expandVariablesSync(text: string, context: VariableContext): string {
  return text.replace(VARIABLE, (whole, name: string, argument: string | undefined) => {
    if (name === "input" || name === "command") return whole;
    const value = variableValue(name, argument, context);
    return typeof value === "string" ? value : whole;
  });
}

/** Expand every string inside a value (arrays and plain objects included). */
export async function expandDeep<T>(value: T, context: VariableContext): Promise<T> {
  if (typeof value === "string") return (await expandVariables(value, context)) as T;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) out.push(await expandDeep(item, context));
    return out as T;
  }
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = await expandDeep(item, context);
    return out as T;
  }
  return value;
}
