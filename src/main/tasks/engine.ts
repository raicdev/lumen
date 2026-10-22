import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionHost } from "../exthost/host.ts";
import * as T from "../exthost/types.ts";
import { keyOfUri, normalizeKey } from "../exthost/documents.ts";
import { TASK_COMMANDS } from "../../shared/tasks-wire.ts";
import type { TasksHostMessage } from "../../shared/tasks-wire.ts";
import { MatcherRunner, createMatcherRegistry, resolveMatchedFile, resolveProblemMatcher } from "./problem-matchers.ts";
import type { MatcherRegistry, ProblemMatch, ProblemMatcherDef } from "./problem-matchers.ts";
import { runProcess, stripAnsi } from "./process.ts";
import type { RunningProcess } from "./process.ts";
import {
  InputCancelled,
  dependenciesOf,
  expandDeep,
  expandVariables,
  expandVariablesSync,
  groupOf,
  matchersOf,
  parseTasksJson,
  taskDefinitionIssues,
} from "./tasks-json.ts";
import type { InputDef, JsonTask, TaskDefinitionContribution, TaskDefinitionIssue, VariableContext } from "./tasks-json.ts";
import { CustomExecution, ProcessExecution, ShellExecution, Task, TaskGroup, TaskRevealKind } from "./task-types.ts";
import type { TaskExecutionKind } from "./task-types.ts";

/**
 * The task system: finds tasks (tasks.json and registered providers), runs
 * them as child processes (or custom pseudoterminals) and feeds their output to
 * the Tasks panel and the problem matchers.
 */

const AREA = "tasks";
const PROVIDER_TIMEOUT = 10_000;

export type TaskProvider = {
  provideTasks(token: T.CancellationToken): PromiseLike<Task[] | null | undefined> | Task[] | null | undefined;
  resolveTask(task: Task, token: T.CancellationToken): PromiseLike<Task | null | undefined> | Task | null | undefined;
};

export type TaskExecutionFacade = { task: Task; terminate(): void };

type Run = {
  id: string;
  task: Task;
  facade: TaskExecutionFacade;
  key: string;
  background: boolean;
  terminated: boolean;
  exitCode: number | null | undefined;
  finished: boolean;
  /** Resolves when the task finished, or (background) printed its end marker. */
  ready: Promise<void>;
  settleReady: () => void;
  /** Resolves when the task finished. */
  done: Promise<void>;
  stop: () => void;
};

export type TasksState = {
  host: ExtensionHost;
  seq: number;
  providerSeq: number;
  providers: Map<number, { type: string; provider: TaskProvider; extensionId: string }>;
  running: Map<string, Run>;
  last: Task | undefined;
  /** Tasks of recent executions by execution id (the panel's "run again"). */
  history: Map<string, Task>;
  onDidStartTask: T.EventEmitter<{ execution: TaskExecutionFacade }>;
  onDidEndTask: T.EventEmitter<{ execution: TaskExecutionFacade }>;
  onDidStartTaskProcess: T.EventEmitter<{ execution: TaskExecutionFacade; processId: number }>;
  onDidEndTaskProcess: T.EventEmitter<{ execution: TaskExecutionFacade; exitCode: number | undefined }>;
  onDidStartTaskProblemMatchers: T.EventEmitter<{ execution: TaskExecutionFacade }>;
  onDidEndTaskProblemMatchers: T.EventEmitter<{ execution: TaskExecutionFacade; hasErrors: boolean }>;
  /** Diagnostics a task reported, so its next run (or begin marker) can clear them: task key, collection, file key. */
  diagnostics: Map<string, Map<string, Map<string, { uri: T.Uri; list: T.Diagnostic[] }>>>;
};

const states = new WeakMap<ExtensionHost, TasksState>();

export function tasksState(host: ExtensionHost): TasksState {
  let state = states.get(host);
  if (!state) {
    state = {
      host,
      seq: 0,
      providerSeq: 0,
      providers: new Map(),
      running: new Map(),
      last: undefined,
      history: new Map(),
      onDidStartTask: new T.EventEmitter(),
      onDidEndTask: new T.EventEmitter(),
      onDidStartTaskProcess: new T.EventEmitter(),
      onDidEndTaskProcess: new T.EventEmitter(),
      onDidStartTaskProblemMatchers: new T.EventEmitter(),
      onDidEndTaskProblemMatchers: new T.EventEmitter(),
      diagnostics: new Map(),
    };
    states.set(host, state);
  }
  return state;
}

/** Stop everything that still runs (the host is shutting down). */
export function killAllTasks(host: ExtensionHost): void {
  for (const run of tasksState(host).running.values()) run.stop();
}

function post(host: ExtensionHost, message: TasksHostMessage): void {
  host.postFeature(AREA, message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notify(host: ExtensionHost, kind: "info" | "warning" | "error", message: string): void {
  void host.requestView("showMessage", kind, message, [], {}).catch(() => undefined);
}

/* ── tasks.json ──────────────────────────────────────────────────────────── */

export function tasksJsonPath(host: ExtensionHost): string | null {
  return host.workspace ? join(host.workspace, ".vscode", "tasks.json") : null;
}

function workspaceFolder(host: ExtensionHost) {
  return host.workspace ? { uri: T.Uri.file(host.workspace), name: basename(host.workspace), index: 0 } : undefined;
}

export function readTasksFile(host: ExtensionHost) {
  const file = tasksJsonPath(host);
  if (!file || !existsSync(file)) return { tasks: [] as JsonTask[], inputs: [] as InputDef[] };
  try {
    return parseTasksJson(readFileSync(file, "utf8"));
  } catch (error) {
    host.log("warning", `could not read ${file}: ${errorMessage(error)}`);
    return { tasks: [] as JsonTask[], inputs: [] as InputDef[] };
  }
}

function groupFrom(group: ReturnType<typeof groupOf>): TaskGroup | undefined {
  if (!group) return undefined;
  const base = TaskGroup.from(group.kind);
  if (!base) return undefined;
  const copy = new TaskGroup(base.id, base.label);
  if (group.isDefault) copy.isDefault = true;
  return copy;
}

/** The Task a tasks.json entry stands for (shell / process ones with their execution). */
export function jsonToTask(host: ExtensionHost, json: JsonTask): Task {
  const folder = workspaceFolder(host);
  const options = json.options ?? {};
  const shell = options.shell;
  let execution: TaskExecutionKind | undefined;
  if (json.command !== undefined && (json.type === "shell" || json.type === "process")) {
    const env = options.env;
    if (json.type === "process") {
      execution = new ProcessExecution(
        json.command,
        (json.args ?? []).map((arg) => (typeof arg === "string" ? arg : arg.value)),
        { cwd: options.cwd, env },
      );
    } else {
      const shellOptions = { cwd: options.cwd, env, executable: shell?.executable, shellArgs: shell?.args };
      const args = (json.args ?? []).map((arg) =>
        typeof arg === "string" ? arg : { value: arg.value, quoting: arg.quoting === "escape" ? 1 : arg.quoting === "weak" ? 3 : 2 },
      );
      execution = json.args === undefined ? new ShellExecution(json.command, shellOptions) : new ShellExecution(json.command, args, shellOptions);
    }
  }
  const matchers = matchersOf(json.problemMatcher);
  const task = new Task(json.raw as Record<string, unknown> & { type: string }, folder, json.label, "Workspace", execution, matchers as string[]);
  task.isBackground = json.isBackground === true;
  task.group = groupFrom(groupOf(json.group));
  task.detail = json.detail;
  const presentation = json.presentation ?? {};
  const reveal = presentation.reveal;
  task.presentationOptions = {
    ...presentation,
    reveal: reveal === "never" ? TaskRevealKind.Never : reveal === "silent" ? TaskRevealKind.Silent : TaskRevealKind.Always,
  };
  if (json.runOptions) task.runOptions = json.runOptions;
  return task;
}

/* ── finding tasks ───────────────────────────────────────────────────────── */

const withTimeout = <V>(promise: PromiseLike<V> | V, ms: number): Promise<V | undefined> =>
  Promise.race([Promise.resolve(promise), new Promise<undefined>((done) => setTimeout(() => done(undefined), ms).unref())]);

const noToken = (): T.CancellationToken => T.CancellationTokenNone;

/** Extensions that contribute a task definition of `type` (any type when undefined) start so their providers register. */
async function activateTaskExtensions(host: ExtensionHost, type?: string): Promise<void> {
  const wanted: Promise<void>[] = [];
  for (const runtime of host.runtimes.values()) {
    if (runtime.activated) continue;
    const definitions = ((runtime.description.manifest.contributes as { taskDefinitions?: { type?: string }[] } | undefined)?.taskDefinitions ?? []) as {
      type?: string;
    }[];
    const matches = definitions.some((definition) => type === undefined || definition.type === type);
    const declared = runtime.activationEvents.some((event) => (type === undefined ? event.startsWith("onTaskType:") : event === `onTaskType:${type}`));
    if (matches || declared) wanted.push(host.activate(runtime, `onTaskType:${type ?? "*"}`).catch(() => undefined));
  }
  await Promise.all(wanted);
}

async function providerTasks(state: TasksState, type?: string): Promise<Task[]> {
  await activateTaskExtensions(state.host, type);
  const out: Task[] = [];
  for (const { type: providerType, provider, extensionId } of [...state.providers.values()]) {
    if (type !== undefined && providerType !== type) continue;
    try {
      const tasks = await withTimeout(provider.provideTasks(noToken()), PROVIDER_TIMEOUT);
      for (const task of tasks ?? []) if (task instanceof Task) out.push(task);
    } catch (error) {
      state.host.log("error", `task provider '${providerType}' failed: ${errorMessage(error)}`, extensionId);
    }
  }
  return out;
}

/** Fill in the execution of a task a provider listed without one (or that tasks.json configures for a custom type). */
async function resolveWithProvider(state: TasksState, task: Task): Promise<Task> {
  const type = task.definition?.type;
  if (task.execution || !type) return task;
  await activateTaskExtensions(state.host, type);
  for (const { type: providerType, provider, extensionId } of [...state.providers.values()]) {
    if (providerType !== type) continue;
    try {
      const resolved = await withTimeout(provider.resolveTask(task, noToken()), PROVIDER_TIMEOUT);
      if (resolved instanceof Task && resolved.execution) {
        // The configuration keeps its presentation, matchers and group; the provider supplies what runs.
        const merged = new Task(
          task.definition,
          task.scope,
          task.name,
          task.source,
          resolved.execution,
          task.problemMatchers.length ? task.problemMatchers : resolved.problemMatchers,
        );
        merged.isBackground = task.isBackground || resolved.isBackground;
        merged.group = task.group ?? resolved.group;
        merged.detail = task.detail ?? resolved.detail;
        merged.presentationOptions = { ...resolved.presentationOptions, ...task.presentationOptions };
        merged.runOptions = { ...resolved.runOptions, ...task.runOptions };
        return merged;
      }
    } catch (error) {
      state.host.log("error", `task provider '${providerType}' failed to resolve '${task.name}': ${errorMessage(error)}`, extensionId);
    }
  }
  return task;
}

export function workspaceTasks(host: ExtensionHost): Task[] {
  return readTasksFile(host)
    .tasks.filter((json) => !json.hide)
    .map((json) => jsonToTask(host, json));
}

/** Every task: tasks.json (custom types resolved by their provider) then the providers' own. */
export async function allTasks(state: TasksState, type?: string): Promise<Task[]> {
  const out: Task[] = [];
  for (const task of workspaceTasks(state.host)) {
    if (type !== undefined && task.definition.type !== type) continue;
    out.push(await resolveWithProvider(state, task));
  }
  out.push(...(await providerTasks(state, type)));
  return out;
}

const displayLabel = (task: Task): string => (task.source === "Workspace" ? task.name : `${task.definition?.type ?? task.source}: ${task.name}`);

/* ── running ─────────────────────────────────────────────────────────────── */

function taskKey(task: Task): string {
  const scope = task.scope && typeof task.scope === "object" ? "folder" : String(task.scope ?? "");
  return `${task.source}\u0000${task.name}\u0000${scope}`;
}

function matcherRegistry(host: ExtensionHost): MatcherRegistry {
  const contributions = [...host.runtimes.values()].map(
    (runtime) => (runtime.description.manifest.contributes ?? {}) as { problemMatchers?: unknown; problemPatterns?: unknown },
  );
  return createMatcherRegistry(contributions);
}

/** The `contributes.taskDefinitions` entry for a task type (the first extension that contributes it). */
function taskDefinitionOf(host: ExtensionHost, type: string | undefined): TaskDefinitionContribution | undefined {
  if (!type) return undefined;
  for (const runtime of host.runtimes.values()) {
    const contributions = (runtime.description.manifest.contributes ?? {}) as { taskDefinitions?: TaskDefinitionContribution[] };
    const definition = [contributions.taskDefinitions ?? []].flat().find((candidate) => candidate && candidate.type === type);
    if (definition) return definition;
  }
  return undefined;
}

/** tasks.json tasks of a contributed type must match its taskDefinitions `properties` / `required`. */
function taskValidationIssues(host: ExtensionHost, task: Task): TaskDefinitionIssue[] {
  if (task.source !== "Workspace") return [];
  return taskDefinitionIssues(task.definition, taskDefinitionOf(host, task.definition.type));
}

/** Whether a file is open in an editor tab (`problemMatcher.applyTo`). */
function isOpenInEditor(host: ExtensionHost, file: string): boolean {
  return host.document(file)?.open === true || host.editors.has(normalizeKey(file));
}

function activeFile(host: ExtensionHost): { file: string | null; line?: number; selectedText?: string } {
  const key = host.activeEditorKey;
  if (!key || !isAbsolute(key)) return { file: null };
  const out: { file: string | null; line?: number; selectedText?: string } = { file: key };
  try {
    const state = host.editors.get(normalizeKey(key));
    const selection = state?.selections[0];
    if (selection) {
      out.line = selection.active.line + 1;
      if (!selection.isEmpty) out.selectedText = host.document(state!.key)?.getText(selection);
    }
  } catch {
    /* no editor details */
  }
  return out;
}

function variableContext(
  host: ExtensionHost,
  folder: string | null,
  cwd: string | undefined,
  inputs: InputDef[],
  answers: Map<string, string | undefined>,
): VariableContext {
  const active = activeFile(host);
  return {
    workspaceFolder: folder,
    file: active.file,
    lineNumber: active.line,
    selectedText: active.selectedText,
    env: process.env,
    userHome: homedir(),
    cwd,
    config: (key) => host.configValue(key),
    command: (id) => host.executeCommand(id, []),
    input: async (id) => {
      if (answers.has(id)) return answers.get(id);
      const definition = inputs.find((input) => input.id === id);
      if (!definition) return undefined;
      let value: string | undefined;
      if (definition.type === "pickString") {
        const options = (definition.options ?? []).map((option) => (typeof option === "string" ? { label: option, value: option } : option));
        const index = await pick(
          host,
          options.map((option) => ({ label: option.label, description: option.value !== option.label ? option.value : undefined })),
          definition.description ?? id,
        );
        value = index === null ? undefined : options[index]?.value;
      } else if (definition.type === "command" && definition.command) {
        const result = await host.executeCommand(definition.command, definition.args === undefined ? [] : [definition.args]);
        value = result === undefined || result === null ? undefined : String(result);
      } else {
        const answer = await host.requestFeatureView(AREA, "input", [
          { prompt: definition.description ?? id, value: definition.default ?? "", password: definition.password === true },
        ]);
        value = typeof answer === "string" ? answer : undefined;
      }
      answers.set(id, value);
      return value;
    },
  };
}

async function pick(host: ExtensionHost, items: { label: string; description?: string; detail?: string }[], title: string): Promise<number | null> {
  const answer = await host.requestFeatureView(AREA, "pick", [items, title]);
  return typeof answer === "number" ? answer : null;
}

type ResolvedSpec = { execution: ShellExecution | ProcessExecution; cwd: string | undefined; env: Record<string, string | undefined> };

async function resolveSpec(execution: ShellExecution | ProcessExecution, folder: string | null, context: VariableContext): Promise<ResolvedSpec> {
  const options = (execution.options ?? {}) as {
    cwd?: string;
    env?: Record<string, string>;
    executable?: string;
    shellArgs?: string[];
    shellQuoting?: ShellExecution["options"] extends infer O ? (O extends { shellQuoting?: infer Q } ? Q : never) : never;
  };
  let cwd = options.cwd === undefined ? undefined : await expandVariables(options.cwd, context);
  if (cwd && !isAbsolute(cwd)) cwd = resolve(folder ?? process.cwd(), cwd);
  cwd ??= folder ?? undefined;
  const scoped = { ...context, cwd };
  const env: Record<string, string | undefined> = { ...process.env };
  for (const [name, value] of Object.entries(options.env ?? {})) env[name] = await expandVariables(String(value), scoped);
  const expandedOptions = {
    ...options,
    cwd,
    env: undefined as undefined,
    executable: options.executable === undefined ? undefined : await expandVariables(options.executable, scoped),
  };
  delete expandedOptions.env;
  if (execution instanceof ProcessExecution) {
    return {
      execution: new ProcessExecution(await expandVariables(execution.process, scoped), await expandDeep(execution.args, scoped), expandedOptions),
      cwd,
      env,
    };
  }
  const part = async (value: string | { value: string; quoting: number }) =>
    typeof value === "string" ? await expandVariables(value, scoped) : { value: await expandVariables(value.value, scoped), quoting: value.quoting };
  if (execution.commandLine !== undefined) {
    return { execution: new ShellExecution(await expandVariables(execution.commandLine, scoped), expandedOptions), cwd, env };
  }
  const args: (string | { value: string; quoting: number })[] = [];
  for (const arg of execution.args ?? []) args.push(await part(arg));
  return { execution: new ShellExecution((await part(execution.command ?? "")) as string, args, expandedOptions), cwd, env };
}

type Pty = {
  onDidWrite: T.Event<string>;
  onDidClose?: T.Event<number | void>;
  open(dimensions: undefined): void;
  close(): void;
};

/** Run a task; resolves with its execution as soon as it started. */
export async function executeTask(state: TasksState, task: Task, chain: string[] = []): Promise<TaskExecutionFacade> {
  const host = state.host;
  const id = String(++state.seq);
  const key = taskKey(task);
  let settleReady!: () => void;
  const ready = new Promise<void>((done) => (settleReady = done));
  let settleDone!: () => void;
  const done = new Promise<void>((finish) => (settleDone = finish));
  const run: Run = {
    id,
    task,
    key,
    background: task.isBackground,
    terminated: false,
    exitCode: undefined,
    finished: false,
    ready,
    settleReady,
    done,
    stop: () => {},
    facade: { task, terminate: () => terminateRun(run) },
  };
  state.running.set(id, run);
  state.last = task;
  state.history.set(id, task);
  if (state.history.size > 100) state.history.delete(state.history.keys().next().value!);
  post(host, { kind: "start", id, name: displayLabel(task), source: task.source, background: task.isBackground, startedAt: Date.now() });
  const reveal = task.presentationOptions?.reveal ?? TaskRevealKind.Always;
  if (reveal === TaskRevealKind.Always) post(host, { kind: "reveal" });
  state.onDidStartTask.fire({ execution: run.facade });

  void (async () => {
    let revealed = reveal === TaskRevealKind.Always;
    const revealOnce = () => {
      if (revealed || reveal === TaskRevealKind.Never) return;
      revealed = true;
      post(host, { kind: "reveal" });
    };
    // Output is posted in batches; matching works on complete lines.
    let pending = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      if (!pending) return;
      post(host, { kind: "output", id, text: pending });
      pending = "";
    };
    const emit = (text: string) => {
      pending += text;
      if (pending.length > 64_000) flush();
      else timer ??= setTimeout(flush, 30);
    };
    const counts = { errors: 0, warnings: 0 };
    let partial = "";
    const runners: MatcherRunner[] = [];
    const fileLines = new Map<string, string[] | null>();
    const linesOf = (file: string): string[] | null => {
      if (!fileLines.has(file)) {
        try {
          fileLines.set(file, readFileSync(file, "utf8").split(/\r?\n/));
        } catch {
          fileLines.set(file, null);
        }
      }
      return fileLines.get(file) ?? null;
    };
    let cwdForMatchers = host.workspace ?? process.cwd();
    let variables: VariableContext | undefined;

    const clearReported = (owner?: string) => {
      const reported = state.diagnostics.get(key);
      if (!reported) return;
      for (const [hostOwner, files] of [...reported]) {
        if (owner !== undefined && hostOwner !== `task.${owner}`) continue;
        for (const { uri } of files.values()) host.setDiagnostics(hostOwner, uri, undefined);
        reported.delete(hostOwner);
      }
    };

    const report = (runner: MatcherRunner, problem: ProblemMatch) => {
      const matcher = runner.matcher;
      const file = resolveMatchedFile(matcher, problem.file, {
        cwd: cwdForMatchers,
        expand: (text) => (variables ? expandVariablesSync(text, variables) : text),
        exists: existsSync,
      });
      // `applyTo` limits reporting to files that are (or are not) open in an editor.
      if (matcher.applyTo !== "allDocuments") {
        const open = isOpenInEditor(host, file);
        if (matcher.applyTo === "openDocuments" ? !open : open) return;
      }
      const lines = linesOf(file);
      const line = Math.max(0, (problem.line || 1) - 1);
      const lineText = lines?.[line];
      const startCharacter = problem.column > 0 ? problem.column - 1 : 0;
      let endLine = problem.endLine !== undefined && problem.endLine > 0 ? problem.endLine - 1 : line;
      let endCharacter: number;
      if (problem.endColumn !== undefined && problem.endColumn > 0) endCharacter = problem.endColumn - 1;
      else if (problem.column > 0 && lineText !== undefined) endCharacter = startCharacter + (/^\w+/.exec(lineText.slice(startCharacter))?.[0].length ?? 1);
      else if (problem.column > 0) endCharacter = startCharacter + 1;
      else endCharacter = lineText?.length ?? 0;
      if (endLine < line) endLine = line;
      const severity =
        problem.severity === "error"
          ? T.DiagnosticSeverity.Error
          : problem.severity === "warning"
            ? T.DiagnosticSeverity.Warning
            : problem.severity === "info"
              ? T.DiagnosticSeverity.Information
              : T.DiagnosticSeverity.Hint;
      const diagnostic = new T.Diagnostic(
        new T.Range(line, startCharacter, endLine, Math.max(endCharacter, endLine === line ? startCharacter : 0)),
        problem.message,
        severity,
      );
      if (matcher.source) diagnostic.source = matcher.source;
      if (problem.code) diagnostic.code = problem.code;
      if (problem.severity === "error") counts.errors++;
      else if (problem.severity === "warning") counts.warnings++;
      const uri = T.Uri.file(file);
      const hostOwner = `task.${matcher.owner}`;
      let reported = state.diagnostics.get(key);
      if (!reported) state.diagnostics.set(key, (reported = new Map()));
      let files = reported.get(hostOwner);
      if (!files) reported.set(hostOwner, (files = new Map()));
      const fileKey = normalizeKey(keyOfUri(uri));
      const entry = files.get(fileKey) ?? { uri, list: [] };
      entry.list.push(diagnostic);
      files.set(fileKey, entry);
      host.setDiagnostics(hostOwner, uri, entry.list);
      if (problem.severity === "error") revealOnce();
    };

    const onLine = (line: string) => {
      for (const runner of runners) {
        const signal = runner.backgroundSignal(line);
        if (signal === "begin") clearReported(runner.matcher.owner);
        if (signal === "end") settleReady();
        if (runner.matcher.background && !runner.active) continue;
        const problem = runner.processLine(line);
        if (problem) report(runner, problem);
      }
    };
    const write = (raw: string) => {
      const text = stripAnsi(raw).replace(/\r\n/g, "\n").replace(/\r/g, "");
      emit(text);
      if (!runners.length) return;
      partial += text;
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    };

    let exitCode: number | null | undefined;
    try {
      // A tasks.json task of a contributed type is validated like VS Code's tasks.json schema.
      const issues = taskValidationIssues(host, task);
      for (const issue of issues) {
        emit(`${issue.severity === "error" ? "Error" : "Warning"}: ${issue.message}\n`);
        if (issue.severity === "warning") host.log("warning", `task '${task.name}': ${issue.message}`);
      }
      const invalid = issues.filter((issue) => issue.severity === "error");
      if (invalid.length)
        throw new Error(`The task '${task.name}' is not run because its definition is invalid (${invalid.length} error${invalid.length === 1 ? "" : "s"}).`);

      // Tasks this one depends on run first.
      const label = task.name;
      const dependencies = dependenciesOf(task.definition);
      if (dependencies.length) {
        if (chain.includes(key)) throw new Error(`The task '${label}' depends on itself.`);
        const file = readTasksFile(host);
        const sequence = task.definition.dependsOrder === "sequence";
        const started: Run[] = [];
        const startDependency = async (dependency: { label: string; type?: string }) => {
          const json = file.tasks.find((candidate) => candidate.label === dependency.label);
          const target = json
            ? await resolveWithProvider(state, jsonToTask(host, json))
            : (await allTasks(state)).find((candidate) => candidate.name === dependency.label || displayLabel(candidate) === dependency.label);
          if (!target) throw new Error(`Could not find the task '${dependency.label}' that '${label}' depends on.`);
          emit(`> Running dependency '${dependency.label}'\n`);
          const facade = await executeTask(state, target, [...chain, key]);
          const child = [...state.running.values()].find((candidate) => candidate.facade === facade);
          return child;
        };
        const wait = async (child: Run | undefined) => {
          if (!child) return;
          started.push(child);
          await child.ready;
          if (child.finished && child.exitCode !== 0 && child.exitCode !== undefined && !child.terminated)
            throw new Error(`The task '${child.task.name}' failed with exit code ${child.exitCode}.`);
          if (child.terminated) throw new Error(`The task '${child.task.name}' was terminated.`);
        };
        run.stop = () => started.forEach(terminateRun);
        if (sequence) for (const dependency of dependencies) await wait(await startDependency(dependency));
        else await Promise.all(await Promise.all(dependencies.map(startDependency)).then((children) => children.map(wait)));
        if (run.terminated) throw new Error("terminated");
      }

      const resolved = await resolveWithProvider(state, task);
      const execution = resolved.execution;
      if (!execution) {
        if (dependencies.length) {
          exitCode = 0;
          return;
        }
        throw new Error(`The task '${task.name}' has no execution (no task provider for type '${task.definition?.type}').`);
      }

      const folderPath = task.scope && typeof task.scope === "object" ? ((task.scope as { uri: T.Uri }).uri.fsPath ?? host.workspace) : host.workspace;
      const file = readTasksFile(host);
      const answers = new Map<string, string | undefined>();
      variables = variableContext(host, folderPath ?? null, undefined, file.inputs, answers);
      cwdForMatchers = folderPath ?? process.cwd();

      const registry = matcherRegistry(host);
      for (const reference of resolved.problemMatchers as (string | ProblemMatcherDef)[]) {
        const matcher = resolveProblemMatcher(reference, registry);
        if (matcher) runners.push(new MatcherRunner(matcher));
        else host.log("warning", `problem matcher '${typeof reference === "string" ? reference : (reference.owner ?? "inline")}' is not known or invalid`);
      }
      if (runners.length) state.onDidStartTaskProblemMatchers.fire({ execution: run.facade });
      clearReported();

      if (execution instanceof CustomExecution) {
        const definition = await expandDeep({ ...task.definition }, variables);
        const pty = (await execution.callback(definition)) as Pty;
        exitCode = await new Promise<number | null | undefined>((finish) => {
          let closed = false;
          const close = (code: number | void | undefined) => {
            if (closed) return;
            closed = true;
            finish(typeof code === "number" ? code : 0);
          };
          pty.onDidWrite((text) => write(text));
          pty.onDidClose?.((code) => close(code));
          run.stop = () => {
            try {
              pty.close();
            } catch {
              /* already closed */
            }
            close(undefined);
          };
          pty.open(undefined);
        });
      } else {
        const spec = await resolveSpec(execution, folderPath ?? null, variables);
        cwdForMatchers = spec.cwd ?? cwdForMatchers;
        emit(`> Executing task: ${describe(spec.execution)}\n\n`);
        let running: RunningProcess;
        running = runProcess(spec, write, (pid) => {
          if (pid !== undefined) state.onDidStartTaskProcess.fire({ execution: run.facade, processId: pid });
        });
        run.stop = () => running.terminate();
        if (run.terminated) running.terminate();
        exitCode = await running.done;
        state.onDidEndTaskProcess.fire({ execution: run.facade, exitCode: exitCode ?? undefined });
      }
    } catch (error) {
      if (error instanceof InputCancelled) emit("Task cancelled: an input was not provided.\n");
      else if (!(run.terminated && errorMessage(error) === "terminated")) {
        emit(`${errorMessage(error)}\n`);
        host.log("warning", `task '${task.name}' failed: ${errorMessage(error)}`);
      }
      exitCode = undefined;
    } finally {
      if (partial) {
        const rest = partial;
        partial = "";
        onLine(rest);
      }
      if (timer) clearTimeout(timer);
      run.exitCode = exitCode;
      run.finished = true;
      if (run.terminated) emit("\nTask terminated.\n");
      else if (exitCode !== undefined && exitCode !== null) emit(`\nTask finished with exit code ${exitCode}.\n`);
      flush();
      if (exitCode && !run.terminated) revealOnce();
      state.running.delete(id);
      if (runners.length) state.onDidEndTaskProblemMatchers.fire({ execution: run.facade, hasErrors: counts.errors > 0 });
      post(host, { kind: "end", id, exitCode, terminated: run.terminated, errors: counts.errors, warnings: counts.warnings });
      state.onDidEndTask.fire({ execution: run.facade });
      run.settleReady();
      settleDone();
    }
  })();
  return run.facade;
}

function describe(execution: ShellExecution | ProcessExecution): string {
  if (execution instanceof ProcessExecution) return [execution.process, ...execution.args].join(" ");
  if (execution.commandLine !== undefined) return execution.commandLine;
  const part = (value: string | { value: string }) => (typeof value === "string" ? value : value.value);
  return [part(execution.command ?? ""), ...(execution.args ?? []).map(part)].join(" ");
}

export function terminateRun(run: Run): void {
  if (run.finished) return;
  run.terminated = true;
  run.stop();
}

/* ── commands ────────────────────────────────────────────────────────────── */

function tasksJsonTemplate(): string {
  return `{
  // The tasks of this workspace. Run them with "Tasks: Run Task".
  "version": "2.0.0",
  "tasks": [
    {
      "label": "echo",
      "type": "shell",
      "command": "echo Hello"
    }
  ]
}
`;
}

async function openTasksJson(host: ExtensionHost): Promise<void> {
  const file = tasksJsonPath(host);
  if (!file) {
    notify(host, "warning", "Open a folder to configure tasks.");
    return;
  }
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, tasksJsonTemplate(), "utf8");
  }
  await host.requestView("showTextDocument", file, {});
}

async function pickTask(state: TasksState, tasks: Task[], title: string): Promise<Task | undefined> {
  if (!tasks.length) return undefined;
  const index = await pick(
    state.host,
    tasks.map((task) => ({ label: displayLabel(task), description: task.source === "Workspace" ? "Workspace" : task.source, detail: task.detail })),
    title,
  );
  return index === null ? undefined : tasks[index];
}

function findByReference(tasks: Task[], reference: unknown): Task | undefined {
  if (typeof reference === "string") return tasks.find((task) => task.name === reference) ?? tasks.find((task) => displayLabel(task) === reference);
  if (reference && typeof reference === "object") {
    const { type, task } = reference as { type?: string; task?: string };
    return tasks.find(
      (candidate) =>
        (type === undefined || candidate.definition?.type === type) && (task === undefined || candidate.name === task || displayLabel(candidate) === task),
    );
  }
  return undefined;
}

async function runGroup(state: TasksState, group: "build" | "test"): Promise<void> {
  const tasks = (await allTasks(state)).filter((task) => task.group?.id === group);
  const label = group === "build" ? "build" : "test";
  if (!tasks.length) {
    const choice = await state.host
      .requestView("showMessage", "info", `No ${label} task to run found. Configure one in tasks.json.`, ["Configure Tasks"], {})
      .catch(() => null);
    if (choice === 0) await openTasksJson(state.host);
    return;
  }
  const defaults = tasks.filter((task) => task.group?.isDefault);
  const chosen = defaults.length === 1 ? defaults[0] : await pickTask(state, defaults.length ? defaults : tasks, `Select the ${label} task to run`);
  if (chosen) await executeTask(state, chosen);
}

/** Built-in task commands (also `executeCommand("workbench.action.tasks.…")` from extensions). */
export async function runTaskCommand(state: TasksState, command: string, args: unknown[]): Promise<unknown> {
  const host = state.host;
  switch (command) {
    case TASK_COMMANDS.runTask: {
      const tasks = await allTasks(state);
      const direct = args[0] === undefined ? undefined : findByReference(tasks, args[0]);
      if (args[0] !== undefined && !direct) {
        notify(host, "error", `Task '${typeof args[0] === "string" ? args[0] : JSON.stringify(args[0])}' not found.`);
        return undefined;
      }
      if (!tasks.length && !direct) {
        const choice = await host
          .requestView("showMessage", "info", "No tasks found. Configure tasks in tasks.json.", ["Configure Tasks"], {})
          .catch(() => null);
        if (choice === 0) await openTasksJson(host);
        return undefined;
      }
      const chosen = direct ?? (await pickTask(state, tasks, "Select the task to run"));
      if (chosen) await executeTask(state, chosen);
      return undefined;
    }
    case TASK_COMMANDS.build:
      await runGroup(state, "build");
      return undefined;
    case TASK_COMMANDS.test:
      await runGroup(state, "test");
      return undefined;
    case TASK_COMMANDS.terminate: {
      const runs = [...state.running.values()];
      if (!runs.length) {
        notify(host, "info", "No task is running.");
        return undefined;
      }
      const target =
        typeof args[0] === "string" ? runs.find((run) => run.id === args[0] || run.task.name === args[0]) : runs.length === 1 ? runs[0] : undefined;
      if (target) return void terminateRun(target);
      const index = await pick(
        host,
        [{ label: "All running tasks" }, ...runs.map((run) => ({ label: displayLabel(run.task) }))],
        "Select the task to terminate",
      );
      if (index === null) return undefined;
      if (index === 0) runs.forEach(terminateRun);
      else terminateRun(runs[index - 1]!);
      return undefined;
    }
    case TASK_COMMANDS.restart: {
      const runs = [...state.running.values()];
      if (!runs.length) {
        notify(host, "info", "No task is running.");
        return undefined;
      }
      const target =
        runs.length === 1
          ? runs[0]!
          : runs[
              (await pick(
                host,
                runs.map((run) => ({ label: displayLabel(run.task) })),
                "Select the task to restart",
              )) ?? -1
            ];
      if (!target) return undefined;
      terminateRun(target);
      await target.done;
      await executeTask(state, target.task);
      return undefined;
    }
    case TASK_COMMANDS.reRun: {
      if (!state.last) {
        notify(host, "info", "No task was run yet.");
        return undefined;
      }
      await executeTask(state, state.last);
      return undefined;
    }
    case TASK_COMMANDS.showTasks:
    case TASK_COMMANDS.showLog:
      post(host, { kind: "reveal" });
      return undefined;
    case TASK_COMMANDS.configure:
    case TASK_COMMANDS.openTasksJson:
    case TASK_COMMANDS.configureDefaultBuild:
    case TASK_COMMANDS.configureDefaultTest:
      await openTasksJson(host);
      return undefined;
    default:
      return undefined;
  }
}
