import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ExtensionHost } from "../../src/main/exthost/host.ts";
import type { HostToView } from "../../src/shared/extensions.ts";
import { MatcherRunner, createMatcherRegistry, resolveMatchedFile, resolveProblemMatcher } from "../../src/main/tasks/problem-matchers.ts";
import { expandVariables, parseTasksJson, taskDefinitionIssues } from "../../src/main/tasks/tasks-json.ts";
import { shellInvocation } from "../../src/main/tasks/process.ts";
import { ShellExecution, ShellQuoting, Task, TaskGroup, TaskScope } from "../../src/main/tasks/task-types.ts";

/**
 *   node --test test/features/tasks.test.ts
 */

const ROOT = resolve(import.meta.dirname, "../..");

function startedHost(workspace: string | null): { host: ExtensionHost; posted: HostToView[] } {
  const host = new ExtensionHost();
  host.init = { extensions: [], config: { lumen: {}, user: {} }, workspace, userData: mkdtempSync(join(tmpdir(), "lumen-tasks-test-")), appRoot: ROOT, appName: "Lumen", appVersion: "0.1.0", languages: [], webviewPort: 1, webviewToken: "t" };
  host.workspace = workspace;
  const posted: HostToView[] = [];
  host.post = (message) => void posted.push(message);
  return { host, posted };
}

const registry = createMatcherRegistry();

function run(matcher: string, lines: string[]) {
  const resolved = resolveProblemMatcher(matcher, registry);
  assert.ok(resolved, matcher);
  const runner = new MatcherRunner(resolved);
  return lines.flatMap((line) => {
    const problem = runner.processLine(line);
    return problem ? [problem] : [];
  });
}

test("$tsc matches errors with file, position, code and severity", () => {
  const [problem] = run("$tsc", ["src/a.ts(3,7): error TS2304: Cannot find name 'x'.", "unrelated"]);
  assert.deepEqual(problem, { file: "src/a.ts", line: 3, column: 7, endLine: undefined, endColumn: undefined, severity: "error", code: "2304", message: "Cannot find name 'x'." });
});

test("$eslint-stylish loops over the lines after a file header", () => {
  const problems = run("$eslint-stylish", ["/work/a.js", "  1:5  error  Unexpected var  no-var", "  2:1  warning  Missing semicolon  semi", "", "/work/b.js", "  9:2  error  Boom"]);
  assert.deepEqual(
    problems.map((p) => [p.file, p.line, p.column, p.severity, p.message, p.code]),
    [
      ["/work/a.js", 1, 5, "error", "Unexpected var", "no-var"],
      ["/work/a.js", 2, 1, "warning", "Missing semicolon", "semi"],
      ["/work/b.js", 9, 2, "error", "Boom", undefined],
    ],
  );
});

test("contributed matchers and patterns, base and inline definitions resolve", () => {
  const custom = createMatcherRegistry([
    {
      problemPatterns: [{ name: "mine", regexp: "^(\\S+) @(\\d+):(\\d+) (.*)$", file: 1, line: 2, column: 3, message: 4 }],
      problemMatchers: [{ name: "mine", owner: "mine", pattern: "$mine", severity: "warning" }],
    },
  ]);
  const matcher = resolveProblemMatcher("$mine", custom)!;
  assert.equal(matcher.owner, "mine");
  assert.equal(new MatcherRunner(matcher).processLine("f.c @4:2 odd")?.severity, "warning");
  const inline = resolveProblemMatcher({ owner: "x", pattern: { regexp: "^E:(.*)$", file: 1, line: 0, message: 1 } as never, base: "$gcc" }, custom);
  assert.ok(inline);
  assert.equal(resolveProblemMatcher("$does-not-exist", custom), undefined);
  const watch = resolveProblemMatcher("$tsc-watch", custom)!;
  const runner = new MatcherRunner(watch);
  assert.equal(runner.active, true);
  assert.equal(runner.backgroundSignal("12:00:01 - File change detected. Starting incremental compilation..."), "begin");
  assert.equal(runner.backgroundSignal("12:00:03 - Found 0 errors. Watching for file changes."), "end");
});

test("matched files resolve against the matcher's file location", () => {
  const gcc = resolveProblemMatcher("$gcc", registry)!;
  const context = { cwd: "/w", expand: (text: string) => text.replace("${workspaceFolder}", "/w") };
  assert.equal(resolveMatchedFile(gcc, "src/x.c", context).replace(/\\/g, "/"), "/w/src/x.c");
  assert.equal(resolveMatchedFile(resolveProblemMatcher("$eslint-compact", registry)!, "rel.js", context), "rel.js");
});

test("tasks.json: platform overrides, global command and dependencies", () => {
  const file = parseTasksJson(
    `{
      // comment
      "version": "2.0.0",
      "tasks": [
        { "label": "build", "type": "shell", "command": "make", "windows": { "command": "nmake" }, "group": { "kind": "build", "isDefault": true }, "problemMatcher": ["$gcc"] },
        { "label": "all", "dependsOn": ["build", "test"], "dependsOrder": "sequence" }
      ],
      "inputs": [{ "id": "who", "type": "promptString" }]
    }`,
    "win32",
  );
  assert.equal(file.tasks[0]!.command, "nmake");
  assert.equal(file.tasks[1]!.dependsOrder, "sequence");
  assert.equal(file.inputs[0]!.id, "who");
  const global = parseTasksJson(`{ "version": "0.1.0", "command": "gulp", "tasks": [{ "taskName": "lint", "args": ["--x"] }] }`, "linux");
  assert.equal(global.tasks[0]!.label, "lint");
  assert.equal(global.tasks[0]!.command, "gulp");
  assert.deepEqual(global.tasks[0]!.args, ["--x"]);
});

test("taskDefinitions required properties are errors and type mismatches are warnings", () => {
  const definition = { type: "demo", required: ["script"], properties: { script: { type: "string" }, port: { type: ["number", "null"] }, watch: { type: "boolean" } } };
  assert.deepEqual(taskDefinitionIssues({ label: "x", type: "demo", port: "80", watch: false }, definition), [
    { severity: "error", message: "Required property 'script' is missing." },
    { severity: "warning", message: "Property 'port' should be of type 'number' or 'null' but is of type 'string'." },
  ]);
  assert.deepEqual(taskDefinitionIssues({ label: "x", type: "demo", script: "build", port: null, watch: true }, definition), []);
  assert.deepEqual(taskDefinitionIssues({ label: "x", type: "demo" }, undefined), []);
});

test("variables are substituted, unknown ones stay", async () => {
  const text = await expandVariables("${workspaceFolder}|${fileBasename}|${env:LUMEN_T}|${config:a.b}|${nope}|${input:q}", {
    workspaceFolder: "/w",
    file: "/w/src/main.ts",
    env: { LUMEN_T: "yes" },
    userHome: "/h",
    config: (key) => (key === "a.b" ? 5 : undefined),
    input: (id) => (id === "q" ? "answer" : undefined),
  });
  assert.equal(text, "/w|main.ts|yes|5|${nope}|answer");
});

test("shell command lines are quoted for the shell", () => {
  const exec = new ShellExecution("echo", ["a b", { value: "$HOME", quoting: ShellQuoting.Strong }, "plain"]);
  assert.equal(shellInvocation(exec, "linux", { SHELL: "/bin/bash" }).line, "echo 'a b' '$HOME' plain");
  assert.equal(shellInvocation(new ShellExecution("dir /b"), "win32", { ComSpec: "cmd.exe" }).line, "dir /b");
  const ps = shellInvocation(new ShellExecution("x", ["it's"], { executable: "pwsh" }), "win32", {});
  assert.equal(ps.flavor, "powershell");
});

test("Task and friends follow the vscode.d.ts shapes", () => {
  const task = new Task({ type: "demo", id: 1 }, TaskScope.Workspace, "name", "src", new ShellExecution("echo hi"), "$tsc");
  assert.equal(task.name, "name");
  assert.deepEqual(task.problemMatchers, ["$tsc"]);
  assert.equal(task.isBackground, false);
  const old = new Task({ type: "demo" }, "n", "s");
  assert.equal(old.scope, undefined);
  assert.equal(old.source, "s");
  assert.equal(TaskGroup.from("build"), TaskGroup.Build);
  assert.equal(TaskScope[1], "Global");
  assert.throws(() => new Task({ type: "x" }, TaskScope.Global, "", "s"));
});

const waitFor = async (check: () => boolean, ms = 10_000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((done) => setTimeout(done, 20));
  }
};

test("runs tasks.json tasks, reports problems as diagnostics and fires events", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "lumen-tasks-ws-"));
  mkdirSync(join(workspace, ".vscode"));
  const script = `console.log("src/a.ts(2,3): error TS2322: Type bad."); console.error("done"); process.exit(3)`;
  writeFileSync(
    join(workspace, ".vscode", "tasks.json"),
    JSON.stringify({ version: "2.0.0", tasks: [{ label: "fail", type: "process", command: process.execPath, args: ["-e", script], problemMatcher: "$tsc", options: { cwd: "${workspaceFolder}" } }] }),
  );
  const { host, posted } = startedHost(workspace);
  const api = host.apiFor(null) as { tasks: Record<string, any> };
  const events: string[] = [];
  api.tasks.onDidStartTask(() => events.push("start"));
  api.tasks.onDidStartTaskProcess((e: { processId: number }) => events.push(`process:${typeof e.processId}`));
  api.tasks.onDidEndTaskProcess((e: { exitCode: number }) => events.push(`exit:${e.exitCode}`));
  api.tasks.onDidEndTask(() => events.push("end"));

  const fetched = await api.tasks.fetchTasks();
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].name, "fail");

  await host.executeCommand("workbench.action.tasks.runTask", ["fail"]);
  assert.equal(api.tasks.taskExecutions.length, 1);
  await waitFor(() => posted.some((m) => m.type === "feature" && (m.payload as { kind: string }).kind === "end"));

  assert.deepEqual(events, ["start", "process:number", "exit:3", "end"]);
  const feature = posted.filter((m) => m.type === "feature").map((m) => m.payload as { kind: string; text?: string; exitCode?: number; errors?: number });
  assert.ok(feature.some((m) => m.kind === "reveal"));
  assert.ok(feature.filter((m) => m.kind === "output").map((m) => m.text).join("").includes("error TS2322"));
  const end = feature.find((m) => m.kind === "end")!;
  assert.equal(end.exitCode, 3);
  assert.equal(end.errors, 1);
  const diagnostics = posted.filter((m) => m.type === "diagnostics" && !("clear" in m && m.clear) && m.entries.some(([, list]) => list.length));
  assert.equal(diagnostics.length, 1);
  assert.equal(api.tasks.taskExecutions.length, 0);
});

test("executeTask runs API tasks, custom executions and dependsOn chains", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "lumen-tasks-ws-"));
  mkdirSync(join(workspace, ".vscode"));
  const log = join(workspace, "order.txt").replace(/\\/g, "/");
  const step = (name: string) => ({ label: name, type: "process", command: process.execPath, args: ["-e", `require("fs").appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name)})`] });
  writeFileSync(join(workspace, ".vscode", "tasks.json"), JSON.stringify({ version: "2.0.0", tasks: [step("one"), step("two"), { label: "both", dependsOn: ["one", "two"], dependsOrder: "sequence" }] }));
  const { host } = startedHost(workspace);
  const vscode = host.apiFor(null) as Record<string, any>;

  // A provider's task with a custom execution.
  const outputs: string[] = [];
  vscode.tasks.registerTaskProvider("demo", {
    provideTasks: () => [new vscode.Task({ type: "demo" }, vscode.TaskScope.Workspace, "hello", "demo", new vscode.CustomExecution(async () => ({
      onDidWrite: (listener: (text: string) => void) => (setTimeout(() => listener("hi from pty\r\n"), 5), { dispose() {} }),
      onDidClose: (listener: (code: number) => void) => (setTimeout(() => listener(0), 40), { dispose() {} }),
      open() {},
      close() {},
    })))],
    resolveTask: () => undefined,
  });
  const ended: unknown[] = [];
  vscode.tasks.onDidEndTask((e: { execution: { task: { name: string } } }) => ended.push(e.execution.task.name));
  const [custom] = (await vscode.tasks.fetchTasks({ type: "demo" })) as unknown[];
  const execution = await vscode.tasks.executeTask(custom);
  assert.equal(execution.task.name, "hello");
  await waitFor(() => ended.includes("hello"));
  void outputs;

  await host.executeCommand("workbench.action.tasks.runTask", ["both"]);
  await waitFor(() => ended.includes("both"));
  const { readFileSync } = await import("node:fs");
  assert.equal(readFileSync(log, "utf8"), "onetwo");
  assert.deepEqual(ended.slice(1), ["one", "two", "both"]);
});

test("problemMatcher applyTo only reports problems of open / closed documents", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "lumen-tasks-ws-"));
  mkdirSync(join(workspace, ".vscode"));
  const script = `console.log("open.ts(1,1): error TS1000: open"); console.log("closed.ts(1,1): error TS1001: closed")`;
  const matcher = (owner: string, applyTo: string) => ({ owner, applyTo, base: "$tsc" });
  writeFileSync(
    join(workspace, ".vscode", "tasks.json"),
    JSON.stringify({
      version: "2.0.0",
      tasks: [
        { label: "open", type: "process", command: process.execPath, args: ["-e", script], options: { cwd: "${workspaceFolder}" }, problemMatcher: matcher("openOnly", "openDocuments") },
        { label: "closed", type: "process", command: process.execPath, args: ["-e", script], options: { cwd: "${workspaceFolder}" }, problemMatcher: matcher("closedOnly", "closedDocuments") },
      ],
    }),
  );
  const { host, posted } = startedHost(workspace);
  host.handleView({ type: "documentOpen", doc: { path: join(workspace, "open.ts"), languageId: "typescript", version: 1, text: "", eol: "LF", dirty: false } });
  const endCount = () => posted.filter((m) => m.type === "feature" && (m.payload as { kind: string }).kind === "end").length;

  await host.executeCommand("workbench.action.tasks.runTask", ["open"]);
  await waitFor(() => endCount() === 1);
  await host.executeCommand("workbench.action.tasks.runTask", ["closed"]);
  await waitFor(() => endCount() === 2);

  const reported = (owner: string): string[] => {
    const files = new Set<string>();
    for (const message of posted) {
      if (message.type !== "diagnostics" || message.owner !== owner) continue;
      for (const [path, list] of message.entries) if (list.length) files.add(path.replace(/\\/g, "/").split("/").pop()!);
    }
    return [...files];
  };
  assert.deepEqual(reported("task.openOnly"), ["open.ts"]);
  assert.deepEqual(reported("task.closedOnly"), ["closed.ts"]);
});

test("tasks.json tasks missing a required taskDefinitions property are reported and not run", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "lumen-tasks-ws-"));
  mkdirSync(join(workspace, ".vscode"));
  const marker = join(workspace, "ran.txt");
  const script = `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")`;
  writeFileSync(
    join(workspace, ".vscode", "tasks.json"),
    JSON.stringify({
      version: "2.0.0",
      tasks: [
        { label: "bad", type: "demo" },
        { label: "good", type: "demo", script: "ok" },
      ],
    }),
  );
  const { host, posted } = startedHost(workspace);
  host.runtimes.set("demo.tasks", {
    id: "demo.tasks",
    description: {
      id: "demo.tasks",
      location: workspace,
      enabled: true,
      kind: "lumen",
      development: false,
      manifest: { contributes: { taskDefinitions: [{ type: "demo", required: ["script"], properties: { script: { type: "string" } } }] } },
    },
    api: null,
    activated: true,
    activating: null,
    exports: undefined,
    module: null,
    context: null,
    activationEvents: [],
  } as never);
  const vscode = host.apiFor(null) as Record<string, any>;
  vscode.tasks.registerTaskProvider("demo", {
    provideTasks: () => [],
    resolveTask: (task: { definition: unknown; scope: unknown; name: string }) =>
      new vscode.Task(task.definition, task.scope, task.name, "demo", new vscode.ProcessExecution(process.execPath, ["-e", script])),
  });

  await host.executeCommand("workbench.action.tasks.runTask", ["bad"]);
  await waitFor(() => posted.some((m) => m.type === "feature" && (m.payload as { kind: string }).kind === "end"));
  const output = posted.filter((m) => m.type === "feature").map((m) => m.payload as { kind: string; text?: string }).filter((m) => m.kind === "output").map((m) => m.text ?? "").join("");
  assert.ok(output.includes("Required property 'script' is missing."));
  assert.equal(existsSync(marker), false);

  await host.executeCommand("workbench.action.tasks.runTask", ["good"]);
  await waitFor(() => existsSync(marker));
});

test("terminate stops a running task", async () => {
  const { host, posted } = startedHost(null);
  const vscode = host.apiFor(null) as Record<string, any>;
  const task = new vscode.Task({ type: "x" }, vscode.TaskScope.Global, "sleep", "t", new vscode.ProcessExecution(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]));
  const execution = await vscode.tasks.executeTask(task);
  await new Promise((done) => setTimeout(done, 300));
  execution.terminate();
  await waitFor(() => posted.some((m) => m.type === "feature" && (m.payload as { kind: string }).kind === "end"));
  const end = posted.filter((m) => m.type === "feature").map((m) => m.payload as { kind: string; terminated?: boolean }).find((m) => m.kind === "end")!;
  assert.equal(end.terminated, true);
});
