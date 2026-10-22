import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ExtensionHost } from "../src/main/exthost/host.ts";
import type { ExtensionDescription, HostToView } from "../src/shared/extensions.ts";

/**
 * Debugging: the `vscode.debug` API and the DAP client, end to end through an
 * ExtensionHost whose extension registers a DebugAdapterDescriptorFactory for a
 * tiny fake adapter (test/fixtures/fake-debug-adapter.mjs).
 *
 *   node --test test/debug.test.ts
 */

const ROOT = resolve(import.meta.dirname, "..");
const FIXTURE = join(ROOT, "test", "fixtures", "fake-debug-adapter.mjs");

function temp(): string {
  return mkdtempSync(join(tmpdir(), "lumen-debug-test-"));
}

/** Compare paths ignoring separators and (Windows) case. */
function norm(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function describe(location: string): ExtensionDescription {
  const manifest = JSON.parse(readFileSync(join(location, "package.json"), "utf8"));
  return { id: `${manifest.publisher ?? "test"}.${manifest.name}`, manifest, location, enabled: true, kind: "lumen", development: true };
}

type Harness = {
  host: ExtensionHost;
  posted: HostToView[];
  waitFor: (match: (message: HostToView) => boolean) => Promise<HostToView>;
};

async function harness(dir: string, main: string, manifest: Record<string, unknown>, folder = "ext"): Promise<Harness> {
  const location = join(dir, folder);
  mkdirSync(location, { recursive: true });
  writeFileSync(
    join(location, "package.json"),
    JSON.stringify({
      name: "debugger-ext",
      publisher: "test",
      version: "1.0.0",
      main: "./main.js",
      engines: { lumen: "^0.1.0" },
      activationEvents: ["*"],
      ...manifest,
    }),
  );
  writeFileSync(join(location, "main.js"), main);
  const host = new ExtensionHost();
  const posted: HostToView[] = [];
  const waiters: { match: (message: HostToView) => boolean; resolve: (message: HostToView) => void }[] = [];
  host.post = (message) => {
    posted.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.match(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  };
  const waitFor = (match: (message: HostToView) => boolean) =>
    new Promise<HostToView>((resolvePromise) => {
      const found = posted.find(match);
      if (found) resolvePromise(found);
      else waiters.push({ match, resolve: resolvePromise });
    });
  await host.start({
    extensions: [describe(location)],
    config: { lumen: { "editor.tabSize": 2 }, user: {} },
    workspace: dir,
    userData: join(dir, "userData"),
    appRoot: ROOT,
    appName: "Lumen",
    appVersion: "0.1.0",
    languages: ["javascript"],
    webviewPort: 1,
    webviewToken: "t",
  });
  return { host, posted, waitFor };
}

/** The main.js of the fake debugger extension: a descriptor factory + a config provider. */
function debuggerMain(): string {
  return [
    `const lumen = require("lumen");`,
    `exports.activate = () => {`,
    `  lumen.commands.registerCommand("fake.echo", () => "workspace-command-result");`,
    `  lumen.debug.registerDebugAdapterDescriptorFactory("fake", {`,
    `    createDebugAdapterDescriptor: () => new lumen.DebugAdapterExecutable(process.execPath, [${JSON.stringify(FIXTURE)}]),`,
    `  });`,
    `  lumen.debug.registerDebugConfigurationProvider("fake", {`,
    `    provideDebugConfigurations: () => [{ type: "fake", name: "Dynamic Fake", request: "launch", program: "dynamic.js" }],`,
    `    resolveDebugConfiguration: (folder, config) => { config.resolved = true; return config; },`,
    `    resolveDebugConfigurationWithSubstitutedVariables: (folder, config) => { config.substituted = true; return config; },`,
    `  }, lumen.DebugConfigurationProviderTriggerKind.Dynamic);`,
    `  let trackers = 0;`,
    `  lumen.debug.registerDebugAdapterTrackerFactory("fake", {`,
    `    createDebugAdapterTracker: () => { trackers++; exports.trackers = trackers; return { onWillStartSession() {}, onDidSendMessage() {} }; },`,
    `  });`,
    `};`,
  ].join("\n");
}

/** The main.js of an extension whose adapter runs in-process (DebugAdapterInlineImplementation). */
function inlineMain(): string {
  return [
    `const lumen = require("lumen");`,
    `exports.activate = () => {`,
    `  let seq = 0;`,
    `  const implementation = {`,
    `    onDidSendMessage: (listener) => { implementation.send = listener; return { dispose() {} }; },`,
    `    handleMessage: (message) => {`,
    `      if (!message || message.type !== "request") return;`,
    `      const reply = (body) => implementation.send({ seq: ++seq, type: "response", request_seq: message.seq, success: true, command: message.command, body: body || {} });`,
    `      const event = (name, body) => implementation.send({ seq: ++seq, type: "event", event: name, body: body || {} });`,
    `      switch (message.command) {`,
    `        case "initialize": reply({ supportsConfigurationDoneRequest: true }); return;`,
    `        case "launch": reply(); event("initialized"); return;`,
    `        case "setBreakpoints": reply({ breakpoints: (message.arguments.breakpoints || []).map((bp) => ({ verified: true, line: bp.line })) }); return;`,
    `        case "setFunctionBreakpoints": case "setExceptionBreakpoints": reply(); return;`,
    `        case "configurationDone": reply(); event("stopped", { reason: "breakpoint", threadId: 7 }); return;`,
    `        case "threads": reply({ threads: [{ id: 7, name: "Inline Thread" }] }); return;`,
    `        case "stackTrace": reply({ stackFrames: [{ id: 5, name: "inline", line: 4, column: 1, source: { name: "inline.js", path: "inline.js" } }] }); return;`,
    `        case "scopes": reply({ scopes: [{ name: "Locals", variablesReference: 1 }] }); return;`,
    `        case "variables": reply({ variables: [{ name: "inlined", value: "yes", variablesReference: 0 }] }); return;`,
    `        case "continue": reply(); event("terminated"); return;`,
    `        case "disconnect": reply(); return;`,
    `        default: reply(); return;`,
    `      }`,
    `    },`,
    `  };`,
    `  lumen.debug.registerDebugAdapterDescriptorFactory("inline", {`,
    `    createDebugAdapterDescriptor: () => new lumen.DebugAdapterInlineImplementation(implementation),`,
    `  });`,
    `};`,
  ].join("\n");
}

test("runs an in-process adapter (DebugAdapterInlineImplementation)", { timeout: 30_000 }, async () => {
  const dir = temp();
  try {
    const { host, waitFor } = await harness(dir, inlineMain(), { contributes: { debuggers: [{ type: "inline", label: "Inline" }] } });
    const started = await host.methods.debugStartConfiguration(dir, { type: "inline", name: "Inline Launch", request: "launch" });
    assert.equal(started.error, undefined);
    const sessionId = started.sessionId!;
    const stopped = (await waitFor((message) => message.type === "debugStopped")) as Extract<HostToView, { type: "debugStopped" }>;
    assert.equal(stopped.stopped.threadId, 7);
    assert.equal(stopped.stopped.path, "inline.js");
    assert.deepEqual(await host.methods.debugThreads(sessionId), [{ id: 7, name: "Inline Thread" }]);
    const frames = await host.methods.debugStackTrace(sessionId, 7, 0, 20);
    assert.equal(frames[0]!.id, 5);
    assert.deepEqual(await host.methods.debugVariables(sessionId, 1), [{ name: "inlined", value: "yes", variablesReference: 0 }]);
    assert.equal(await host.methods.debugResume(sessionId, 7), true);
    await waitFor((message) => message.type === "debugSessions" && message.sessions.length === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startDebugging reverse requests create child sessions with a parent", { timeout: 30_000 }, async () => {
  const dir = temp();
  try {
    const app = join(dir, "app.js");
    writeFileSync(app, "// app\n");
    const { host, waitFor } = await harness(dir, debuggerMain(), { contributes: { debuggers: [{ type: "fake", label: "Fake" }] } });
    const started = await host.methods.debugStartConfiguration(dir, { type: "fake", name: "Parent", request: "launch", program: app, startChild: true });
    assert.equal(started.error, undefined);
    const parentId = started.sessionId!;
    const both = (await waitFor((message) => message.type === "debugSessions" && message.sessions.some((session) => session.id !== parentId))) as Extract<
      HostToView,
      { type: "debugSessions" }
    >;
    const child = both.sessions.find((session) => session.id !== parentId)!;
    assert.equal(child.parentId, parentId);
    assert.equal(child.name, "Child Session");
    // Stopping the parent also disconnects its children.
    await host.methods.debugStop(parentId);
    await waitFor((message) => message.type === "debugSessions" && message.sessions.length === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("breakpoints are persisted per workspace and restored", async () => {
  const dir = temp();
  try {
    const app = join(dir, "app.js");
    writeFileSync(app, "// app\n");
    const first = await harness(dir, debuggerMain(), { contributes: { debuggers: [{ type: "fake", label: "Fake" }] } });
    await first.host.methods.debugSetBreakpoints(app, [
      { line: 3, condition: "x > 1" },
      { line: 9, enabled: false, logMessage: "value is {x}" },
    ]);
    const functionBreakpoint = new (first.host.apiFor(null) as { FunctionBreakpoint: new (name: string) => unknown }).FunctionBreakpoint("main");
    first.host.debug.addBreakpoints([functionBreakpoint as never]);
    assert.equal(first.host.debug.breakpoints.length, 3);

    const second = await harness(dir, debuggerMain(), { contributes: { debuggers: [{ type: "fake", label: "Fake" }] } }, "ext2");
    const restored = second.host.debug.wireBreakpoints();
    assert.deepEqual(
      restored.map((breakpoint) => [
        breakpoint.kind,
        breakpoint.path ? norm(breakpoint.path) : breakpoint.functionName,
        breakpoint.line,
        breakpoint.enabled,
        breakpoint.condition,
        breakpoint.logMessage,
      ]),
      [
        ["source", norm(app), 3, true, "x > 1", undefined],
        ["source", norm(app), 9, false, undefined, "value is {x}"],
        ["function", "main", undefined, true, undefined, undefined],
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("starts a session from launch.json, hits a breakpoint and inspects the stack", { timeout: 30_000 }, async () => {
  const dir = temp();
  try {
    mkdirSync(join(dir, ".vscode"), { recursive: true });
    writeFileSync(
      join(dir, ".vscode", "launch.json"),
      [
        `{`,
        `  // a comment and a trailing comma, like VS Code allows`,
        `  "version": "0.2.0",`,
        `  "configurations": [`,
        `    { "type": "fake", "name": "Fake Launch", "request": "launch", "program": "\${workspaceFolder}/app.js", "cwd": "\${workspaceFolder}", "echo": "\${command:fake.echo}", "tab": "\${config:editor.tabSize}" },`,
        `  ],`,
        `  "compounds": [{ "name": "Both", "configurations": ["Fake Launch"] }],`,
        `}`,
      ].join("\n"),
    );
    const app = join(dir, "app.js");
    writeFileSync(app, "const a = 1;\nconst b = 2;\nconsole.log(a + b);\n");

    const { host, waitFor } = await harness(dir, debuggerMain(), {
      contributes: { debuggers: [{ type: "fake", label: "Fake", languages: ["javascript"] }], breakpoints: [{ language: "javascript" }] },
    });

    // launch.json + a provider's dynamic configuration.
    const listed = await host.methods.debugListConfigurations(dir);
    assert.deepEqual(listed.configurations.map((configuration) => configuration.name).sort(), ["Dynamic Fake", "Fake Launch"]);
    assert.deepEqual(listed.compounds, [{ name: "Both", configurations: ["Fake Launch"], folder: dir }]);

    // Breakpoints are the host's, exposed to the UI and persisted.
    const breakpoints = await host.methods.debugSetBreakpoints(app, [{ line: 2 }]);
    assert.deepEqual(
      breakpoints.map((breakpoint) => [norm(breakpoint.path ?? ""), breakpoint.line, breakpoint.enabled]),
      [[norm(app), 2, true]],
    );
    assert.equal(host.debug.breakpoints.length, 1);

    const started = await host.methods.debugStart(dir, "Fake Launch");
    assert.equal(started.error, undefined);
    assert.ok(started.sessionId);
    const sessionId = started.sessionId!;

    const sessions = (await waitFor((message) => message.type === "debugSessions" && message.sessions.length > 0)) as Extract<
      HostToView,
      { type: "debugSessions" }
    >;
    assert.equal(sessions.sessions[0]!.name, "Fake Launch");
    assert.equal(sessions.sessions[0]!.type, "fake");

    // The adapter's `initialized`/`configurationDone` handshake stops on the breakpoint.
    const stopped = (await waitFor((message) => message.type === "debugStopped")) as Extract<HostToView, { type: "debugStopped" }>;
    assert.equal(stopped.stopped.reason, "breakpoint");
    assert.equal(stopped.stopped.threadId, 1);
    assert.equal(stopped.stopped.line, 2);
    // \${workspaceFolder} and the resolved program from the provider reached the adapter.
    assert.equal(norm(stopped.stopped.path ?? ""), norm(app));
    assert.ok(
      (await waitFor((message) => message.type === "debugOutput" && message.output.category === "stdout")) as Extract<HostToView, { type: "debugOutput" }>,
    );
    // Variables were substituted before launch: workspaceFolder, command and config.
    const launchOutput = (await waitFor((message) => message.type === "debugOutput" && message.output.category === "console")) as Extract<
      HostToView,
      { type: "debugOutput" }
    >;
    assert.match(launchOutput.output.text, /"program":"[^"]*app\.js"/);
    assert.match(launchOutput.output.text, /"echo":"workspace-command-result"/);
    assert.match(launchOutput.output.text, /"tab":"2"/);
    assert.match(launchOutput.output.text, /"resolved":true/);
    assert.match(launchOutput.output.text, /"substituted":true/);
    await waitFor((message) => message.type === "debugCapabilities");

    // Adapter verification of the breakpoint reaches the UI.
    const verified = (await waitFor(
      (message) => message.type === "debugBreakpoints" && message.breakpoints.some((breakpoint) => breakpoint.verified),
    )) as Extract<HostToView, { type: "debugBreakpoints" }>;
    assert.equal(verified.breakpoints[0]!.verifiedLine, 2);

    // Threads, stack, scopes and variables.
    assert.deepEqual(await host.methods.debugThreads(sessionId), [{ id: 1, name: "Main Thread" }]);
    const frames = await host.methods.debugStackTrace(sessionId, 1, 0, 20);
    assert.equal(frames.length, 2);
    assert.equal(norm(frames[0]!.source?.path ?? ""), norm(app));
    assert.equal(frames[0]!.name, "main");
    const scopes = await host.methods.debugScopes(sessionId, frames[0]!.id);
    assert.deepEqual(scopes, [{ name: "Locals", variablesReference: 1000, expensive: false }]);
    const variables = await host.methods.debugVariables(sessionId, 1000);
    assert.deepEqual(
      variables.map((variable) => [variable.name, variable.value]),
      [
        ["counter", "42"],
        ["greeting", '"hello"'],
      ],
    );
    assert.equal((await host.methods.debugEvaluate(sessionId, "counter + 1", frames[0]!.id, "repl"))?.result, "42");
    await assert.rejects(async () => await host.methods.debugEvaluate(sessionId, "please fail", frames[0]!.id, "watch"));

    // A tracker was created for the session.
    assert.equal((host.runtimes.get("test.debugger-ext")!.module as { trackers?: number }).trackers, 1);

    // Continue: the adapter stops the debuggee and the session ends.
    assert.equal(await host.methods.debugResume(sessionId, 1), true);
    await waitFor((message) => message.type === "debugSessions" && message.sessions.length === 0);
    assert.equal(host.debug.activeSession, undefined);

    // The provider ran both resolution hooks.
    assert.equal(listed.configurations.find((configuration) => configuration.name === "Fake Launch")?.request, "launch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** An extension whose "alias" configurations resolve to the "recorded" type, served by an in-process adapter that records requests. */
function aliasMain(): string {
  return [
    `const lumen = require("lumen");`,
    `exports.activate = () => {`,
    `  const recorded = (globalThis.__lumenRecordedDap = []);`,
    `  let seq = 0;`,
    `  const implementation = {`,
    `    onDidSendMessage: (listener) => { implementation.send = listener; return { dispose() {} }; },`,
    `    handleMessage: (message) => {`,
    `      if (!message || message.type !== "request") return;`,
    `      recorded.push(message);`,
    `      const reply = (body) => implementation.send({ seq: ++seq, type: "response", request_seq: message.seq, success: true, command: message.command, body: body || {} });`,
    `      switch (message.command) {`,
    `        case "initialize": reply({ supportsConfigurationDoneRequest: true }); return;`,
    `        case "launch": reply(); implementation.send({ seq: ++seq, type: "event", event: "initialized", body: {} }); return;`,
    `        case "setBreakpoints": reply({ breakpoints: (message.arguments.breakpoints || []).map((bp) => ({ verified: true, line: bp.line })) }); return;`,
    `        case "evaluate": implementation.send({ seq: ++seq, type: "response", request_seq: message.seq, success: false, command: "evaluate", message: "short", body: { error: { id: 1, format: "{name} is not defined", variables: { name: "nope" } } } }); return;`,
    `        default: reply(); return;`,
    `      }`,
    `    },`,
    `  };`,
    `  // Like js-debug turning "node" into "pwa-node": the resolved type picks the adapter.`,
    `  lumen.debug.registerDebugConfigurationProvider("alias", { resolveDebugConfiguration: (folder, config) => ({ ...config, type: "recorded" }) });`,
    `  lumen.debug.registerDebugAdapterDescriptorFactory("recorded", { createDebugAdapterDescriptor: () => new lumen.DebugAdapterInlineImplementation(implementation) });`,
    `};`,
  ].join("\n");
}

test("resolution can change the type; removed breakpoints are cleared on the adapter", { timeout: 30_000 }, async () => {
  const dir = temp();
  try {
    const app = join(dir, "app.js");
    writeFileSync(app, "a\nb\nc\n");
    const { host, waitFor } = await harness(dir, aliasMain(), {
      contributes: {
        debuggers: [
          { type: "alias", label: "Alias" },
          { type: "recorded", label: "Recorded" },
        ],
      },
    });
    await host.methods.debugToggleBreakpoint(app, 3);
    const started = await host.methods.debugStartConfiguration(dir, { type: "alias", name: "Alias Launch", request: "launch" });
    assert.equal(started.error, undefined);
    const sessions = (await waitFor((message) => message.type === "debugSessions" && message.sessions.some((s) => s.state === "running"))) as Extract<
      HostToView,
      { type: "debugSessions" }
    >;
    assert.equal(sessions.sessions[0]!.type, "recorded");

    const recorded = (
      globalThis as unknown as { __lumenRecordedDap: { command: string; arguments?: { breakpoints?: unknown[]; source?: { path?: string } } }[] }
    ).__lumenRecordedDap;
    const setBreakpoints = () => recorded.filter((request) => request.command === "setBreakpoints");
    assert.deepEqual(setBreakpoints().at(-1)!.arguments!.breakpoints, [{ line: 3 }]);
    // The adapter did not announce supportsFunctionBreakpoints.
    assert.equal(
      recorded.some((request) => request.command === "setFunctionBreakpoints"),
      false,
    );

    await host.methods.debugRemoveAllBreakpoints();
    for (let i = 0; i < 50 && !(setBreakpoints().at(-1)!.arguments!.breakpoints!.length === 0); i++) await new Promise((r) => setTimeout(r, 20));
    const cleared = setBreakpoints().at(-1)!;
    assert.deepEqual(cleared.arguments!.breakpoints, []);
    assert.equal(norm(cleared.arguments!.source!.path!), norm(app));

    // Failed requests carry the adapter's formatted message.
    await assert.rejects(host.methods.debugEvaluate(started.sessionId!, "nope", null, "repl"), /nope is not defined/);
    await host.methods.debugStop(started.sessionId!);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
