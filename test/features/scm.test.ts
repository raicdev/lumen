import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ExtensionHost } from "../../src/main/exthost/host.ts";
import { scmSnapshot } from "../../src/main/exthost/features/scm.ts";
import { reviveMenuArg } from "../../src/main/exthost/features/menus-walkthroughs.ts";
import "../../src/main/exthost/features/registry.ts";
import { computeLineChanges, vscodeLineChanges } from "../../src/shared/scm-diff.ts";
import type { HostToView } from "../../src/shared/extensions.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");

function startedHost() {
  const host = new ExtensionHost();
  const userData = mkdtempSync(join(tmpdir(), "lumen-scm-test-"));
  host.init = {
    extensions: [],
    config: { lumen: {}, user: {} },
    workspace: null,
    userData,
    appRoot: ROOT,
    appName: "Lumen",
    appVersion: "0.1.0",
    languages: [],
    webviewPort: 1,
    webviewToken: "t",
  };
  const posted: HostToView[] = [];
  host.post = (message) => void posted.push(message);
  return { host, posted, userData };
}

type Any = any;

test("source controls, groups, input box and counts reach the snapshot", async () => {
  const { host, posted } = startedHost();
  const api = host.apiFor(null) as Any;
  const root = api.Uri.file(join(tmpdir(), "repo"));
  const control = api.scm.createSourceControl("fake", "Fake SCM", root);
  const group = control.createResourceGroup("work", "Changes");
  group.resourceStates = [
    {
      resourceUri: api.Uri.file(join(tmpdir(), "repo", "src", "a.ts")),
      command: { command: "fake.open", title: "Open" },
      contextValue: "modified",
      decorations: { tooltip: "Modified", strikeThrough: true },
    },
  ];
  control.inputBox.placeholder = "Message";
  control.acceptInputCommand = { command: "fake.commit", title: "Commit" };
  control.statusBarCommands = [{ command: "fake.sync", title: "sync" }];
  control.commitTemplate = "feat: ";

  const snapshot = scmSnapshot(host);
  assert.equal(snapshot.controls.length, 1);
  const data = snapshot.controls[0]!;
  assert.equal(data.label, "Fake SCM");
  assert.equal(data.count, 1);
  assert.equal(data.inputBox.value, "feat: ");
  assert.equal(data.inputBox.placeholder, "Message");
  assert.equal(data.accept?.title, "Commit");
  assert.equal(data.groups[0]!.id, "work");
  assert.equal(data.groups[0]!.resources[0]!.label, "a.ts");
  assert.equal(data.groups[0]!.resources[0]!.description, "src");
  assert.equal(data.groups[0]!.resources[0]!.letter, "M");
  assert.equal(data.groups[0]!.resources[0]!.contextValue, "modified");
  assert.equal(data.groups[0]!.resources[0]!.strikeThrough, true);
  assert.equal(api.scm.inputBox, control.inputBox);

  control.count = 7;
  assert.equal(scmSnapshot(host).controls[0]!.count, 7);

  // Changes are posted to the view (coalesced).
  await new Promise((done) => setTimeout(done, 80));
  const messages = posted.filter((m) => m.type === "feature" && m.area === "scm");
  assert.equal(messages.length, 1);

  group.dispose();
  assert.equal(scmSnapshot(host).controls[0]!.groups.length, 0);
  control.dispose();
  assert.equal(scmSnapshot(host).controls.length, 0);
});

test("resource decorations send their icon (light/dark or theme icon) and text styles", async () => {
  const { host, userData } = startedHost();
  const api = host.apiFor(null) as Any;
  const lightIcon = join(userData, "modified-light.svg");
  const darkIcon = join(userData, "modified-dark.png");
  writeFileSync(lightIcon, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(darkIcon, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const control = api.scm.createSourceControl("fake", "Fake");
  const group = control.createResourceGroup("g", "G");
  group.resourceStates = [
    {
      resourceUri: api.Uri.file(join(tmpdir(), "a.ts")),
      decorations: { iconPath: { light: api.Uri.file(lightIcon), dark: api.Uri.file(darkIcon) }, tooltip: "Modified", faded: true, strikeThrough: true },
    },
    { resourceUri: api.Uri.file(join(tmpdir(), "b.ts")), decorations: { iconPath: new api.ThemeIcon("diff-modified") } },
    { resourceUri: api.Uri.file(join(tmpdir(), "c.ts")), decorations: { iconPath: join(userData, "missing.svg") } },
  ];

  const resources = scmSnapshot(host).controls[0]!.groups[0]!.resources as Any[];
  assert.match(resources[0]!.icon!.light!, /^data:image\/svg\+xml;base64,/);
  assert.match(resources[0]!.icon!.dark!, /^data:image\/png;base64,/);
  assert.equal(resources[0]!.tooltip, "Modified");
  assert.equal(resources[0]!.faded, true);
  assert.equal(resources[0]!.strikeThrough, true);
  assert.equal(resources[1]!.icon!.codicon, "diff-modified");
  // A missing icon file silently falls back to the file type icon in the view.
  assert.equal(resources[2]!.icon, undefined);
});

test("view messages run the extension's commands and typing does not echo", async () => {
  const { host } = startedHost();
  const api = host.apiFor(null) as Any;
  const ran: unknown[][] = [];
  api.commands.registerCommand("fake.commit", (...args: unknown[]) => void ran.push(["commit", ...args]));
  api.commands.registerCommand("fake.open", (...args: unknown[]) => void ran.push(["open", ...args]));
  api.commands.registerCommand("fake.sync", () => void ran.push(["sync"]));
  const control = api.scm.createSourceControl("fake", "Fake");
  const group = control.createResourceGroup("g", "G");
  group.resourceStates = [{ resourceUri: api.Uri.file(join(tmpdir(), "x.txt")), command: { command: "fake.open", title: "Open", arguments: [1] } }];
  control.acceptInputCommand = { command: "fake.commit", title: "Commit" };
  control.statusBarCommands = [{ command: "fake.sync", title: "sync" }];
  control.inputBox.validateInput = (value: string) => (value ? undefined : { message: "empty", type: 2 });
  const handle = scmSnapshot(host).controls[0]!.handle;
  const groupHandle = scmSnapshot(host).controls[0]!.groups[0]!.handle;
  const rev = scmSnapshot(host).controls[0]!.inputBox.valueRev;

  host.handleView({ type: "feature", area: "scm", payload: { kind: "input", handle, value: "hello" } });
  assert.equal(control.inputBox.value, "hello");
  assert.equal(scmSnapshot(host).controls[0]!.inputBox.valueRev, rev);
  host.handleView({ type: "feature", area: "scm", payload: { kind: "accept", handle } });
  host.handleView({ type: "feature", area: "scm", payload: { kind: "resource", handle, group: groupHandle, index: 0 } });
  host.handleView({ type: "feature", area: "scm", payload: { kind: "statusCommand", handle, index: 0 } });
  await new Promise((done) => setTimeout(done, 30));
  assert.deepEqual(ran, [["commit"], ["open", 1], ["sync"]]);

  host.handleView({ type: "feature", area: "scm", payload: { kind: "input", handle, value: "" } });
  await new Promise((done) => setTimeout(done, 10));
  assert.deepEqual(scmSnapshot(host).controls[0]!.inputBox.validation, { message: "empty", type: 2 });

  control.inputBox.value = "set by extension";
  assert.equal(scmSnapshot(host).controls[0]!.inputBox.valueRev, rev + 1);
});

test("quick diff provider returns the original text and withScmProgress tracks busy", async () => {
  const { host, userData } = startedHost();
  const api = host.apiFor(null) as Any;
  const original = join(userData, "orig.txt");
  writeFileSync(original, "one\ntwo\n");
  const control = api.scm.createSourceControl("fake", "Fake", api.Uri.file(userData));
  control.quickDiffProvider = { provideOriginalResource: () => api.Uri.file(original) };
  assert.equal(scmSnapshot(host).controls[0]!.hasQuickDiff, true);
  assert.equal(await host.methods.feature("scm", "quickDiff", [join(userData, "file.txt")]), "one\ntwo\n");
  assert.equal(await host.methods.feature("scm", "quickDiff", [join(tmpdir(), "elsewhere.txt")]), null);

  let during = -1;
  const result = await api.window.withScmProgress(async () => {
    during = scmSnapshot(host).busy;
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(during, 1);
  assert.equal(scmSnapshot(host).busy, 0);
});

test("scm/* menu arguments are revived into the source control, group and resource state", () => {
  const { host } = startedHost();
  const api = host.apiFor(null) as Any;
  const control = api.scm.createSourceControl("fake", "Fake SCM");
  const group = control.createResourceGroup("work", "Changes");
  const state = { resourceUri: api.Uri.file(join(tmpdir(), "a.ts")) };
  // A state without a resource is not sent: indexes stay those of resourceStates.
  group.resourceStates = [{ resourceUri: undefined }, state];
  const data = scmSnapshot(host).controls[0]!;
  const resource = data.groups[0]!.resources[0]!;
  assert.equal(resource.index, 1);
  const ref = (fields: Record<string, unknown>) => ({ $ref: { area: "scm", ...fields } });
  const [c, g, s, gone] = reviveMenuArg(
    [
      ref({ control: data.handle }),
      ref({ control: data.handle, group: group.handle }),
      ref({ control: data.handle, group: group.handle, index: resource.index }),
      ref({ control: 999 }),
    ],
    host,
  ) as unknown[];
  assert.equal(c, control);
  assert.equal(g, group);
  assert.equal(s, state);
  assert.equal(gone, undefined);
});

test("vscodeLineChanges gives VS Code's LineChange form (scm/change/title)", () => {
  assert.deepEqual(vscodeLineChanges("a\nb\nc", "a\nX\nc"), [
    { originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 2, modifiedEndLineNumber: 2 },
  ]);
  assert.deepEqual(vscodeLineChanges("a\nb", "a\nb\nc"), [
    { originalStartLineNumber: 2, originalEndLineNumber: 0, modifiedStartLineNumber: 3, modifiedEndLineNumber: 3 },
  ]);
  assert.deepEqual(vscodeLineChanges("a\nb\nc", "a\nc"), [
    { originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 1, modifiedEndLineNumber: 0 },
  ]);
});

test("computeLineChanges marks added, modified and deleted lines", () => {
  assert.deepEqual(computeLineChanges("a\nb\nc", "a\nb\nc"), []);
  assert.deepEqual(computeLineChanges("a\nb\nc", "a\nb\nc\nd"), [{ kind: "added", line: 4, count: 1 }]);
  assert.deepEqual(computeLineChanges("a\nb\nc", "a\nX\nc"), [{ kind: "modified", line: 2, count: 1 }]);
  assert.deepEqual(computeLineChanges("a\nb\nc", "a\nc"), [{ kind: "deleted", line: 1, count: 1 }]);
  assert.deepEqual(computeLineChanges("", "x"), [{ kind: "added", line: 1, count: 1 }]);
});
