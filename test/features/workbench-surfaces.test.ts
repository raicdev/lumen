import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ExtensionHost } from "../../src/main/exthost/host.ts";
import { reviveMenuArg } from "../../src/main/exthost/features/menus-walkthroughs.ts";
import "../../src/main/exthost/features/registry.ts";
import { parseIssueArgs } from "../../src/main/exthost/features/issue-reporter.ts";
import { parsePortInput, portsSnapshot } from "../../src/main/exthost/features/ports.ts";
import { GIT_SOURCE, provideTimeline, timelineFeature, timelineSources } from "../../src/main/exthost/features/timeline.ts";
import { terminalFeature } from "../../src/main/exthost/features/terminal.ts";
import { githubIssueUrl, githubRepository, issueBody, issueTarget } from "../../src/shared/issue-reporter.ts";
import type { HostToView } from "../../src/shared/extensions.ts";

/**
 * Timeline, Ports, editor view columns and the issue reporter (host side and the pure helpers).
 *
 *   node --test test/features/workbench-surfaces.test.ts
 */

const ROOT = resolve(import.meta.dirname, "..", "..");

function startedHost() {
  const host = new ExtensionHost();
  host.init = { extensions: [], config: { lumen: {}, user: {} }, workspace: null, userData: mkdtempSync(join(tmpdir(), "lumen-surfaces-test-")), appRoot: ROOT, appName: "Lumen", appVersion: "0.1.0", languages: [], webviewPort: 1, webviewToken: "t" };
  const posted: HostToView[] = [];
  host.post = (message) => void posted.push(message);
  const features = (area: string) => posted.filter((m) => m.type === "feature" && (m as { area: string }).area === area).map((m) => (m as { payload: any }).payload);
  return { host, posted, features, api: host.apiFor(null) as any };
}

/* ── timeline ─────────────────────────────────────────────────────────────── */

test("timeline providers are listed by scheme, paged, and their items revived for menus", async () => {
  const { host, api, features } = startedHost();
  const fired = new api.EventEmitter();
  const item = new api.TimelineItem("Saved", 1000);
  item.contextValue = "local:save";
  item.command = { command: "demo.open", title: "Open" };
  const registration = api.workspace.registerTimelineProvider(["file"], {
    id: "demo",
    label: "Demo History",
    onDidChangeTimeline: fired.event,
    provideTimeline: async (_uri: unknown, options: { cursor?: string }) => (options.cursor ? { items: [new api.TimelineItem("Older", 10)] } : { items: [item], paging: { cursor: "1" } }),
  });
  const file = join(tmpdir(), "a.txt");
  assert.deepEqual(timelineSources(host, file).map((source) => source.id), ["demo"]);
  assert.deepEqual(timelineSources(host, "untitled:x"), []);
  const first = await provideTimeline(host, file, "demo", undefined, 1);
  assert.equal(first.items[0]!.label, "Saved");
  assert.equal(first.items[0]!.contextValue, "local:save");
  assert.equal(first.items[0]!.hasCommand, true);
  assert.equal(first.cursor, "1");
  assert.equal((await provideTimeline(host, file, "demo", "1", 1)).items[0]!.label, "Older");
  // timeline/item/context gets the TimelineItem itself.
  assert.equal(reviveMenuArg({ $ref: { area: "timeline", item: first.items[0]!.handle } }, host), item);
  fired.fire({ uri: api.Uri.file(file) });
  assert.ok(features("timeline").some((message) => message.kind === "changed" && message.source === "demo"));
  registration.dispose();
  assert.deepEqual(timelineSources(host, file), []);
  assert.equal(api.TimelineTriggerKind.Invoke, 1);
});

test("Lumen's Git History source lists a file's commits and opens a revision", async (t) => {
  const repo = mkdtempSync(join(tmpdir(), "lumen-git-timeline-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=t@example.com", ...args], { cwd: repo, encoding: "utf8" });
  try {
    git("init", "-q");
  } catch {
    t.skip("git is not available");
    return;
  }
  const file = join(repo, "a.txt");
  writeFileSync(file, "one\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "first");
  writeFileSync(file, "two\n");
  git("commit", "-q", "-am", "second");

  const { host } = startedHost();
  timelineFeature.init!(host);
  assert.ok(timelineSources(host, file).some((source) => source.id === GIT_SOURCE));
  const page = await provideTimeline(host, file, GIT_SOURCE, undefined, 1);
  assert.deepEqual(page.items.map((item) => item.label), ["second", "first"]);
  assert.equal(page.items[0]!.contextValue, "git:file:commit");
  assert.equal(page.cursor, undefined);
  // The item's command opens the file at that commit (a read-only virtual document).
  const item = reviveMenuArg({ $ref: { area: "timeline", item: page.items[1]!.handle } }, host) as any;
  assert.equal(item.command.command, "vscode.open");
  assert.equal(await host.contentProviders.provide(item.command.arguments[0]), "one\n");
});

/* ── editor view columns ──────────────────────────────────────────────────── */

function textTab(label: string, path: string): Record<string, unknown> {
  return { label, path, kind: "text", isActive: true, isDirty: false, isPinned: false, isPreview: false };
}

test("TextEditor.viewColumn reports the editor's group and moving between groups fires the event", () => {
  const { host, api } = startedHost();
  terminalFeature.init!(host);
  const file = join(tmpdir(), "column.txt");
  const other = join(tmpdir(), "other.txt");
  host.handleView({ type: "documentOpen", doc: { path: file, languageId: "plaintext", version: 1, text: "a\n", eol: "LF", dirty: false } } as never);
  host.handleView({ type: "documentOpen", doc: { path: other, languageId: "plaintext", version: 1, text: "b\n", eol: "LF", dirty: false } } as never);
  host.handleView({ type: "tabs", groups: [{ viewColumn: 1, isActive: true, tabs: [textTab("column.txt", file)] }] } as never);
  host.handleView({ type: "activeEditor", path: file, selections: [{ anchorLine: 0, anchorCharacter: 0, activeLine: 0, activeCharacter: 0 }], visible: [file] } as never);
  assert.equal(api.window.activeTextEditor.viewColumn, 1);
  assert.deepEqual(api.window.visibleTextEditors.map((editor: any) => editor.viewColumn), [1]);

  const moved: any[] = [];
  api.window.onDidChangeTextEditorViewColumn((event: any) => moved.push(event));
  // Split right: the editor is now the visible tab of column 2, another file stays in column 1.
  host.handleView({
    type: "tabs",
    groups: [
      { viewColumn: 1, isActive: false, tabs: [textTab("other.txt", other)] },
      { viewColumn: 2, isActive: true, tabs: [textTab("column.txt", file)] },
    ],
  } as never);
  host.handleView({ type: "activeEditor", path: file, selections: [], visible: [other, file] } as never);

  assert.equal(api.window.activeTextEditor.viewColumn, 2);
  assert.deepEqual(api.window.visibleTextEditors.map((editor: any) => editor.viewColumn), [1, 2]);
  assert.deepEqual(moved.map((event) => event.viewColumn), [2]);
  assert.equal(moved[0]!.textEditor.viewColumn, 2);
  assert.equal(moved[0]!.textEditor.document.uri.fsPath.toLowerCase(), file.toLowerCase());
});

/* ── ports ────────────────────────────────────────────────────────────────── */

test("ports: openTunnel forwards a local port through a forwarder, lists it and closes it", async () => {
  const { host, api, features } = startedHost();
  const target = createServer((socket) => socket.end("hello"));
  await new Promise<void>((done) => target.listen(0, "127.0.0.1", done));
  const port = (target.address() as { port: number }).port;
  let changes = 0;
  api.workspace.onDidChangeTunnels(() => changes++);
  try {
    // Another local port number: a real forwarder.
    const tunnel = await api.workspace.openTunnel({ remoteAddress: { host: "127.0.0.1", port }, localAddressPort: 0, label: "web" });
    const local = Number(String(tunnel.localAddress).split(":")[1]);
    assert.ok(local > 0 && local !== port);
    const received = await new Promise<string>((done, fail) => {
      const socket = connect(local, "127.0.0.1");
      let data = "";
      socket.on("data", (chunk) => (data += chunk));
      socket.on("end", () => done(data));
      socket.on("error", fail);
    });
    assert.equal(received, "hello");
    assert.equal((await api.workspace.tunnels).length, 1);
    assert.equal(portsSnapshot(host)[0]!.label, "web");
    assert.ok(features("ports").some((message) => message.kind === "ports" && message.ports.length === 1));
    let disposed = false;
    tunnel.onDidDispose(() => (disposed = true));
    await tunnel.dispose();
    assert.equal(disposed, true);
    assert.equal(portsSnapshot(host).length, 0);
    assert.ok(changes >= 2);
  } finally {
    target.close();
  }
  assert.deepEqual(parsePortInput("3000"), { host: "localhost", port: 3000 });
  assert.deepEqual(parsePortInput("10.0.0.1:22"), { host: "10.0.0.1", port: 22 });
  assert.equal(parsePortInput("abc"), null);
  assert.equal(parsePortInput("70000"), null);
});

/* ── issue reporter ───────────────────────────────────────────────────────── */

test("the issue reporter reads VS Code's arguments and builds the GitHub issue", async () => {
  assert.deepEqual(parseIssueArgs(["pub.ext"]), { extensionId: "pub.ext" });
  assert.deepEqual(parseIssueArgs([["pub.ext"]]), { extensionId: "pub.ext" });
  assert.deepEqual(parseIssueArgs([{ extensionId: "pub.ext", issueTitle: "T", issueBody: "B" }]), { extensionId: "pub.ext", title: "T", body: "B", extensionData: undefined });
  assert.deepEqual(parseIssueArgs([]), {});

  assert.equal(githubRepository("git+https://github.com/o/r.git"), "https://github.com/o/r");
  assert.equal(githubRepository("github:o/r"), "https://github.com/o/r");
  assert.equal(githubRepository("https://gitlab.com/o/r"), undefined);
  assert.deepEqual(issueTarget({ bugs: { url: "https://github.com/o/r/issues" } }), { kind: "github", url: "https://github.com/o/r/issues/new" });
  assert.deepEqual(issueTarget({ repository: { url: "https://github.com/o/r.git" } }), { kind: "github", url: "https://github.com/o/r/issues/new" });
  assert.deepEqual(issueTarget({ bugs: "https://example.com/bugs" }), { kind: "page", url: "https://example.com/bugs" });
  assert.equal(issueTarget({}), null);
  const body = issueBody("It breaks", { app: "Lumen 0.1.0", os: "win32", runtime: "Node" }, { id: "o.r", version: "1.2.3" }, "data");
  assert.match(body, /It breaks[\s\S]*o\.r@1\.2\.3[\s\S]*Lumen 0\.1\.0[\s\S]*data/);
  assert.equal(githubIssueUrl("https://github.com/o/r/issues/new", "a b", "c"), "https://github.com/o/r/issues/new?title=a%20b&body=c");

  // The commands reach the window with the system information.
  const { host, features } = startedHost();
  await host.executeCommand("vscode.openIssueReporter", [{ extensionId: "pub.ext", issueTitle: "T" }]);
  const open = features("issue-reporter").at(-1);
  assert.equal(open.kind, "open");
  assert.equal(open.open.extensionId, "pub.ext");
  assert.equal(open.open.title, "T");
  assert.match(open.open.system.app, /Lumen/);
});

/* ── custom editors ───────────────────────────────────────────────────────── */

function customEditorProvider(log: string[]) {
  const changed = new (startedHost().api.EventEmitter)();
  let opened = 0;
  return {
    provider: {
      onDidChangeCustomDocument: changed.event,
      openCustomDocument(uri: any, context: { backupId?: string }) {
        opened++;
        log.push(`open ${context.backupId ?? "-"}`);
        return { uri, dispose: () => log.push("dispose") };
      },
      resolveCustomEditor(_document: unknown, panel: any) {
        log.push(`resolve ${panel.viewType}`);
      },
      backupCustomDocument(_document: unknown, context: { destination: any }) {
        log.push(`backup ${context.destination.scheme}`);
        return { id: "backup-1", delete() {} };
      },
      saveCustomDocument() {},
      saveCustomDocumentAs() {},
      revertCustomDocument() {},
    },
    changed,
    opened: () => opened,
  };
}

test("custom editors: several editors share a document with supportsMultipleEditorsPerDocument", async () => {
  const { host, posted } = startedHost();
  const log: string[] = [];
  const { provider, changed } = customEditorProvider(log);
  host.customEditors.register(null, "test.multi", provider, { supportsMultipleEditorsPerDocument: true });
  const path = join(host.init.userData, "a.bin");
  writeFileSync(path, "x");
  const first = await host.customEditors.open(path, "test.multi");
  const second = await host.customEditors.open(path, "test.multi");
  assert.ok(first && second && first.id !== second.id);
  assert.deepEqual(log, ["open -", "resolve test.multi", "resolve test.multi"]);
  // A change marks both editors dirty.
  changed.fire({ document: {}, undo() {}, redo() {} });
  assert.deepEqual(
    posted.filter((m: any) => m.type === "webviewUpdate" && m.dirty === true).map((m: any) => m.id).sort(),
    [first!.id, second!.id].sort(),
  );
  // Without the option, opening again reveals the one editor.
  host.customEditors.register(null, "test.single", customEditorProvider([]).provider);
  const single = await host.customEditors.open(path, "test.single");
  assert.equal((await host.customEditors.open(path, "test.single"))?.id, single?.id);
});

test("custom editors: a backed-up document is reopened from its backup and starts dirty", async () => {
  const { host } = startedHost();
  const log: string[] = [];
  host.customEditors.register(null, "test.backup", customEditorProvider(log).provider);
  const path = join(host.init.userData, "b.bin");
  writeFileSync(path, "x");
  await host.customEditors.open(path, "test.backup");
  assert.equal(await host.customEditors.backup(path, "test.backup"), "backup-1");
  assert.ok(log.includes("backup file"));

  // The next session (same user data) opens the file with the backup id.
  const next = startedHost();
  next.host.init = { ...next.host.init, userData: host.init.userData };
  const nextLog: string[] = [];
  next.host.customEditors.register(null, "test.backup", customEditorProvider(nextLog).provider);
  const opened = await next.host.customEditors.open(path, "test.backup");
  assert.equal(nextLog[0], "open backup-1");
  assert.ok(next.posted.some((m: any) => m.type === "webviewUpdate" && m.id === opened?.id && m.dirty === true));
  // Used once: a later open starts from the file.
  const third = startedHost();
  third.host.init = { ...third.host.init, userData: host.init.userData };
  const thirdLog: string[] = [];
  third.host.customEditors.register(null, "test.backup", customEditorProvider(thirdLog).provider);
  await third.host.customEditors.open(path, "test.backup");
  assert.equal(thirdLog[0], "open -");
});
