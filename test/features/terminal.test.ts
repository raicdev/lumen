import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ExtensionHost } from "../../src/main/exthost/host.ts";
import { EventEmitter } from "../../src/main/exthost/types.ts";
import { ShellIntegrationModel, commandLineFor, shellTypeOf } from "../../src/main/exthost/features/terminal/shell.ts";
import { ShellIntegrationParser, escapeIntegrationValue, unescapeIntegrationValue } from "../../src/shared/terminal-integration.ts";
import type { ShellIntegrationEvent } from "../../src/shared/terminal-integration.ts";
import { decodeSpawnSpec, encodeSpawnSpec } from "../../src/shared/terminal-spawn.ts";
import { BASH_SCRIPT, PWSH_SCRIPT, ZSH_SCRIPT, injectShellIntegration, shellKindOf } from "../../src/main/terminal-integration.ts";
import type { HostToView } from "../../src/shared/extensions.ts";

/**
 * Terminals of the extension API: shell integration parsing and executions,
 * pseudo-terminals, link and profile providers, terminal state.
 *
 *   node --test test/features/terminal.test.ts
 */

const ROOT = resolve(import.meta.dirname, "../..");
const OSC = (body: string) => `\x1b]${body}\x07`;

/* ── parser ──────────────────────────────────────────────────────────────── */

test("the parser turns OSC 633 sequences into events and keeps command output", () => {
  const parser = new ShellIntegrationParser();
  const events = parser.feed(`${OSC("633;A")}$ ${OSC("633;B")}ls${OSC("633;E;ls")}${OSC("633;C")}file-a\r\nfile-b\r\n${OSC("633;D;0")}${OSC("633;P;Cwd=/tmp/x")}`);
  assert.deepEqual(events, [
    { type: "prompt-start" },
    { type: "command-start" },
    { type: "command-line", commandLine: "ls" },
    { type: "executing" },
    { type: "output", data: "file-a\r\nfile-b\r\n" },
    { type: "finished", exitCode: 0 },
    { type: "property", key: "Cwd", value: "/tmp/x" },
  ]);
  assert.equal(parser.detected, true);
});

test("the parser handles sequences split across chunks, ST terminators and FinalTerm 133", () => {
  const parser = new ShellIntegrationParser();
  const all: ShellIntegrationEvent[] = [];
  const text = `${OSC("133;C")}out\x1b]633;D;3\x1b\\`;
  for (let at = 0; at < text.length; at += 3) all.push(...parser.feed(text.slice(at, at + 3)));
  const output = all.filter((event) => event.type === "output").map((event) => (event as { data: string }).data).join("");
  assert.equal(output, "out");
  assert.deepEqual(all.filter((event) => event.type !== "output"), [{ type: "executing" }, { type: "finished", exitCode: 3 }]);
  // Other OSC sequences and plain text pass through untouched outside a command.
  assert.deepEqual(new ShellIntegrationParser().feed("\x1b]0;title\x07hello"), []);
});

test("a prompt while a command is 'running' ends it; values round-trip through the escaping", () => {
  const parser = new ShellIntegrationParser();
  const events = parser.feed(`${OSC("633;C")}x${OSC("633;A")}`);
  assert.deepEqual(events.map((event) => event.type), ["executing", "output", "finished", "prompt-start"]);
  const line = "echo 'a;b' \\ \n";
  assert.equal(unescapeIntegrationValue(escapeIntegrationValue(line)), line);
  assert.equal(new ShellIntegrationParser().feed(OSC(`633;E;${escapeIntegrationValue(line)}`))[0]?.type, "command-line");
});

/* ── shell model ─────────────────────────────────────────────────────────── */

test("shell executions: user commands, executeCommand and read()", async () => {
  const sent: string[] = [];
  const log: string[] = [];
  const model = new ShellIntegrationModel({
    send: (text) => void sent.push(text),
    shell: () => "bash",
    changed: () => void log.push("changed"),
    started: (execution) => void log.push(`start:${execution.commandLine.value}:${execution.commandLine.confidence}`),
    ended: (execution, code) => void log.push(`end:${execution.commandLine.value}:${code}`),
  });
  model.handle({ type: "property", key: "Cwd", value: "/work" });
  assert.equal(model.api.cwd?.path, "/work");
  // The user types ls.
  model.handle({ type: "command-line", commandLine: "ls" });
  model.handle({ type: "executing" });
  model.handle({ type: "finished", exitCode: 0 });
  // An extension runs a command; its execution object is the one the shell then reports.
  const execution = model.api.executeCommand("git", ["status", "a b"]);
  assert.deepEqual(sent, ["git status 'a b'\r"]);
  const chunks: string[] = [];
  const reading = (async () => {
    for await (const chunk of execution.read()) chunks.push(chunk);
  })();
  model.handle({ type: "command-line", commandLine: "git status 'a b'" });
  model.handle({ type: "executing" });
  model.handle({ type: "output", data: "clean" });
  model.handle({ type: "finished", exitCode: 1 });
  await reading;
  assert.deepEqual(chunks, ["clean"]);
  assert.deepEqual(log, ["changed", "start:ls:1", "end:ls:0", "start:git status 'a b':2", "end:git status 'a b':1"]);
});

test("quoting and shell names", () => {
  assert.equal(commandLineFor("pwsh", "C:\\Program Files\\x.exe", ["it's"]), "& 'C:\\Program Files\\x.exe' 'it''s'");
  assert.equal(commandLineFor("cmd", "tool", ["a b"]), 'tool "a b"');
  assert.equal(shellTypeOf("C:\\Program Files\\PowerShell\\7\\pwsh.exe"), "pwsh");
  assert.equal(shellTypeOf("C:\\Program Files\\Git\\bin\\bash.exe"), "gitbash");
  assert.equal(shellTypeOf("/usr/bin/zsh"), "zsh");
});

/* ── main process helpers ────────────────────────────────────────────────── */

test("spawn specs travel in the profile string; the shells get their integration", () => {
  const spec = { shellPath: "/bin/zsh", shellArgs: ["-l"], env: { A: "é;1", B: null }, strictEnv: true, nonce: "abc" };
  assert.deepEqual(decodeSpawnSpec(encodeSpawnSpec(spec)), spec);
  assert.equal(decodeSpawnSpec("powershell"), null);

  assert.equal(shellKindOf("C:\\x\\pwsh.exe"), "pwsh");
  assert.equal(shellKindOf("/usr/bin/fish"), null);
  const bash = injectShellIntegration("/usr/bin/bash", ["-l"], {});
  assert.ok(bash && bash.args[0] === "--rcfile" && !bash.args.includes("-l") && bash.env.LUMEN_SHELL_INTEGRATION_DIR);
  const zsh = injectShellIntegration("/usr/bin/zsh", ["-l"], { ZDOTDIR: "/z" });
  assert.ok(zsh && zsh.env.USER_ZDOTDIR === "/z" && zsh.env.ZDOTDIR !== "/z");
  const pwsh = injectShellIntegration("pwsh.exe", ["-NoLogo"], {});
  assert.ok(pwsh && pwsh.args.includes("-Command") && pwsh.args.at(-1)!.includes("lumen-integration.ps1"));
  assert.equal(injectShellIntegration("/usr/bin/fish", [], {}), null);
  for (const script of [BASH_SCRIPT, ZSH_SCRIPT, PWSH_SCRIPT]) assert.ok(script.includes("633;"));
  assert.ok(BASH_SCRIPT.includes("${#s}") && !BASH_SCRIPT.includes("@{"));
});

/* ── extension host ──────────────────────────────────────────────────────── */

function startedHost(answer: (method: string, args: unknown[]) => unknown) {
  const host = new ExtensionHost();
  host.init = { extensions: [], config: { lumen: {}, user: {} }, workspace: null, userData: mkdtempSync(join(tmpdir(), "lumen-terminal-test-")), appRoot: ROOT, appName: "Lumen", appVersion: "0.1.0", languages: [], webviewPort: 1, webviewToken: "t" };
  const posted: HostToView[] = [];
  host.post = (message) => {
    posted.push(message);
    if (message.type === "request") queueMicrotask(() => host.handleView({ type: "reply", id: message.id, result: answer(message.method, message.args as unknown[]) } as never));
  };
  const features = () => posted.filter((message) => message.type === "feature").map((message) => (message as { payload: any }).payload);
  const viewMessage = (payload: unknown) => host.handleView({ type: "feature", area: "terminal", payload } as never);
  return { host, posted, features, viewMessage, api: host.apiFor(null) as Record<string, any> };
}

const tick = () => new Promise<void>((done) => setTimeout(done, 5));

test("pseudo-terminals: output, input, dimensions, name, close", async () => {
  const requests: [string, unknown[]][] = [];
  const { host, features, viewMessage, api } = startedHost((method, args) => {
    requests.push([method, args]);
    if (method === "feature" && args[1] === "create") return { id: "7", cols: 100, rows: 30 };
    return true;
  });
  const writes = new EventEmitter<string>();
  const closes = new EventEmitter<number | void>();
  const names = new EventEmitter<string>();
  const calls: string[] = [];
  const pty = {
    onDidWrite: writes.event,
    onDidClose: closes.event,
    onDidChangeName: names.event,
    open: (dimensions: unknown) => void calls.push(`open:${JSON.stringify(dimensions)}`),
    close: () => void calls.push("close"),
    handleInput: (data: string) => void calls.push(`input:${data}`),
    setDimensions: (dimensions: { columns: number; rows: number }) => void calls.push(`dims:${dimensions.columns}x${dimensions.rows}`),
  };
  const opened: unknown[] = [];
  const closed: any[] = [];
  api.window.onDidOpenTerminal((terminal: unknown) => opened.push(terminal));
  api.window.onDidCloseTerminal((terminal: unknown) => closed.push(terminal));

  const terminal = api.window.createTerminal({ name: "My Pty", pty, location: { viewColumn: -1 } });
  assert.equal(terminal.name, "My Pty");
  assert.equal(await terminal.processId, undefined);
  await tick();
  const create = requests.find(([method, args]) => method === "feature" && args[1] === "create")![1][2] as [any];
  assert.equal(create[0].pty, true);
  assert.equal(create[0].location, "editor");
  assert.deepEqual(calls, ['open:{"columns":100,"rows":30}']);
  assert.deepEqual(opened, [terminal]);
  assert.deepEqual(api.window.terminals, [terminal]);

  writes.fire("hello\r\n");
  assert.deepEqual(features().at(-1), { kind: "write", id: "7", data: "hello\r\n" });
  viewMessage({ kind: "input", id: "7", data: "ls" });
  viewMessage({ kind: "resized", id: "7", cols: 90, rows: 20 });
  terminal.sendText("echo", true);
  assert.deepEqual(calls.slice(1), ["input:ls", "dims:90x20", "input:echo\r"]);
  names.fire("Renamed");
  assert.equal(terminal.name, "Renamed");
  assert.deepEqual(features().at(-1), { kind: "title", id: "7", title: "Renamed" });

  // The pty ends itself: the window is asked to close the terminal, whose "closed" message completes it.
  closes.fire(3);
  await tick();
  assert.ok(requests.some(([method, args]) => method === "terminalDispose" && args[0] === "7"));
  viewMessage({ kind: "closed", id: "7", code: null });
  assert.deepEqual(closed, [terminal]);
  assert.deepEqual(terminal.exitStatus, { code: 3, reason: 2 });
  assert.equal(api.window.terminals.length, 0);
  host.onDidOpenTerminal.dispose();
});

test("createTerminal: editor view column, preserveFocus, split and shellIntegrationNonce reach the window", async () => {
  const creates: any[] = [];
  let seq = 0;
  const { api } = startedHost((method, args) => {
    if (method === "feature" && args[1] === "create") {
      creates.push((args[2] as [any])[0]);
      return { id: String(++seq), cols: 80, rows: 24 };
    }
    return true;
  });
  const parent = api.window.createTerminal({ name: "a", shellIntegrationNonce: "n0nce", env: { X: "1" } });
  api.window.createTerminal({ name: "b", location: { viewColumn: 2, preserveFocus: true } });
  api.window.createTerminal({ name: "c", location: { viewColumn: -2 } });
  api.window.createTerminal({ name: "d", location: api.TerminalLocation.Editor });
  api.window.createTerminal({ name: "e", location: { parentTerminal: parent } });
  api.window.createTerminal({ name: "f", location: api.TerminalLocation.Panel });
  await tick();
  const byName = Object.fromEntries(creates.map((request) => [request.name, request]));
  assert.deepEqual(byName.a.spawn, { env: { X: "1" }, nonce: "n0nce" });
  assert.equal(byName.a.location, "panel");
  assert.deepEqual([byName.b.location, byName.b.viewColumn, byName.b.preserveFocus], ["editor", 2, true]);
  assert.deepEqual([byName.c.location, byName.c.viewColumn, byName.c.preserveFocus], ["editor", -2, undefined]);
  assert.deepEqual([byName.d.location, byName.d.viewColumn], ["editor", undefined]);
  assert.deepEqual([byName.e.location, byName.e.splitWith, byName.e.viewColumn], ["panel", "1", undefined]);
  assert.equal(byName.f.location, "panel");
});

test("terminal state, shell integration and executions reach the API", async () => {
  const { viewMessage, api } = startedHost((method, args) => (method === "feature" && args[1] === "create" ? { id: "3", cols: 80, rows: 24 } : true));
  const events: string[] = [];
  api.window.onDidChangeTerminalState((terminal: any) => events.push(`state:${terminal.state.isInteractedWith}:${terminal.state.shell}`));
  api.window.onDidChangeTerminalShellIntegration((event: any) => events.push(`integration:${event.shellIntegration.cwd?.path}`));
  api.window.onDidStartTerminalShellExecution((event: any) => events.push(`start:${event.execution.commandLine.value}:${event.execution.commandLine.confidence}`));
  api.window.onDidEndTerminalShellExecution((event: any) => events.push(`end:${event.exitCode}`));

  const terminal = api.window.createTerminal({ name: "sh" });
  await tick();
  assert.equal(terminal.shellIntegration, undefined);
  viewMessage({ kind: "started", id: "3", pid: 4242, shell: "/usr/bin/bash" });
  assert.equal(await terminal.processId, 4242);
  viewMessage({ kind: "interacted", id: "3" });
  viewMessage({ kind: "shell", id: "3", event: { type: "property", key: "Cwd", value: "/proj" } });
  assert.equal(terminal.shellIntegration.cwd.path, "/proj");
  viewMessage({ kind: "shell", id: "3", event: { type: "command-line", commandLine: "make" } });
  viewMessage({ kind: "shell", id: "3", event: { type: "executing" } });
  viewMessage({ kind: "shell", id: "3", event: { type: "finished", exitCode: 2 } });
  assert.deepEqual(events, ["state:false:bash", "state:true:bash", "integration:/proj", "start:make:1", "end:2"]);
});

test("link providers are asked per line and activated by id", async () => {
  const { host, features, viewMessage, api } = startedHost((method, args) => (method === "feature" && args[1] === "create" ? { id: "5", cols: 80, rows: 24 } : true));
  const handled: { startIndex: number }[] = [];
  api.window.createTerminal({ name: "links" });
  await tick();
  const registration = api.window.registerTerminalLinkProvider({
    provideTerminalLinks: (context: { line: string }) => {
      const index = context.line.indexOf("TICKET-1");
      return index < 0 ? [] : [new api.TerminalLink(index, 8, "Open ticket")];
    },
    handleTerminalLink: (link: { startIndex: number }) => void handled.push(link),
  });
  assert.deepEqual(features().at(-1), { kind: "linkProviders", count: 1 });
  const links = (await host.methods.feature("terminal", "links", ["5", "see TICKET-1 now"])) as { linkId: string; startIndex: number; length: number; tooltip: string }[];
  assert.equal(links.length, 1);
  assert.deepEqual([links[0]!.startIndex, links[0]!.length, links[0]!.tooltip], [4, 8, "Open ticket"]);
  assert.deepEqual(await host.methods.feature("terminal", "links", ["5", "nothing"]), []);
  viewMessage({ kind: "linkActivated", id: "5", linkId: links[0]!.linkId });
  await tick();
  assert.equal(handled[0]?.startIndex, 4);
  registration.dispose();
  assert.deepEqual(features().at(-1), { kind: "linkProviders", count: 0 });
});

test("profile providers resolve a contributed profile to spawn options or a pseudo-terminal", async () => {
  const { host, api } = startedHost((method, args) => (method === "feature" && args[1] === "create" ? { id: "5", cols: 80, rows: 24 } : true));
  api.window.registerTerminalProfileProvider("demo.shell", {
    provideTerminalProfile: () => new api.TerminalProfile({ name: "Demo", shellPath: "/bin/sh", shellArgs: ["-i"], env: { A: "1", B: null }, color: new api.ThemeColor("terminal.ansiRed") }),
  });
  const resolved = (await host.methods.feature("terminal", "resolveProfile", ["ext:demo.shell", "9", null])) as any;
  assert.equal(resolved.title, "Demo");
  assert.deepEqual(resolved.spawn, { shellPath: "/bin/sh", shellArgs: ["-i"], env: { A: "1", B: null } });
  assert.equal(resolved.color, "terminal.ansiRed");

  const opened: unknown[] = [];
  const writes = new EventEmitter<string>();
  const pty = { onDidWrite: writes.event, open: (dimensions: unknown) => void opened.push(dimensions), close() {} };
  api.window.registerTerminalProfileProvider("demo.pty", { provideTerminalProfile: () => new api.TerminalProfile({ name: "Pty", pty }) });
  const ptyProfile = (await host.methods.feature("terminal", "resolveProfile", ["ext:demo.pty", "11", { cols: 70, rows: 10 }])) as any;
  assert.equal(ptyProfile.pty, true);
  assert.deepEqual(opened, [{ columns: 70, rows: 10 }]);
  assert.equal(await host.methods.feature("terminal", "resolveProfile", ["ext:nobody", "10", null]), null);
  assert.equal(api.window.terminals.length, 2);
});

test("exported terminal classes", () => {
  const { api } = startedHost(() => true);
  assert.equal(new api.TerminalProfile({ name: "x" }).options.name, "x");
  const link = new api.TerminalLink(1, 2, "t");
  assert.deepEqual([link.startIndex, link.length, link.tooltip], [1, 2, "t"]);
  assert.deepEqual([api.TerminalShellExecutionCommandLineConfidence.Low, api.TerminalShellExecutionCommandLineConfidence.Medium, api.TerminalShellExecutionCommandLineConfidence.High], [0, 1, 2]);
  assert.equal(typeof api.window.onDidChangeTextEditorViewColumn, "function");
});
