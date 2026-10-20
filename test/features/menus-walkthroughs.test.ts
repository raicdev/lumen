import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { ExtensionHost } from "../../src/main/exthost/host.ts";
import { hostFeatures } from "../../src/main/exthost/features/registry.ts";
import { parseOpenWalkthroughArgs, reviveMenuArg, watchedCommands } from "../../src/main/exthost/features/menus-walkthroughs.ts";
import { applyTsServerPlugins, setTsPluginConfig, tsServerPluginsOf } from "../../src/main/menus-walkthroughs-ts-plugins.ts";
import type * as T from "../../src/main/exthost/types.ts";
import {
  completesOnSelect,
  featuredFor,
  findWalkthrough,
  flattenMenu,
  formatResourceLabel,
  labelFormattersOf,
  parseCommandLink,
  parseCompletionEvent,
  parseResourceKey,
  parseWalkthroughs,
  replaceCommandLinks,
  resolveMenu,
  undeclaredSubmenus,
  type ContributionSource,
} from "../../src/shared/menus-walkthroughs.ts";
import type { HostToView, ExtensionDescription } from "../../src/shared/extensions.ts";

/**
 * The "menus-walkthroughs" area: submenus, walkthroughs, label formatters,
 * typescriptServerPlugins and the host feature around them.
 *
 *   node --test test/features/menus-walkthroughs.test.ts
 */

const ROOT = resolve(import.meta.dirname, "../..");
const always = () => true;

const ext = (id: string, contributes: Record<string, unknown>): ContributionSource => ({ id, manifest: { contributes } });

test("submenus nest, are sorted by group and hide when empty", () => {
  const sources = [
    ext("a.one", {
      commands: [
        { command: "a.run", title: "Run" },
        { command: "a.stop", title: { value: "Stop", original: "Stop" } },
        { command: "a.hidden", title: "Hidden" },
      ],
      submenus: [
        { id: "a.sub", label: "More" },
        { id: "a.empty", label: "Nothing" },
      ],
      menus: {
        "editor/context": [
          { command: "a.run", group: "z_last@2" },
          { submenu: "a.sub", group: "1_modification@1" },
          { submenu: "a.empty", group: "2_x" },
          { submenu: "a.unknown", group: "2_y" },
        ],
        "a.sub": [{ command: "a.stop" }, { command: "a.hidden", when: "false" }],
        "a.empty": [{ command: "a.hidden", when: "false" }],
      },
    }),
  ];
  const items = resolveMenu(sources, "editor/context", (clause) => clause !== "false");
  assert.deepEqual(
    items.map((item) => [item.type, item.title]),
    [
      ["submenu", "More"],
      ["command", "Run"],
    ],
  );
  const sub = items[0]!;
  assert.equal(sub.type, "submenu");
  if (sub.type === "submenu") assert.deepEqual(sub.items.map((item) => item.title), ["Stop"]);
  assert.deepEqual(flattenMenu(items).map((item) => item.command), ["a.stop", "a.run"]);
  assert.deepEqual(undeclaredSubmenus(sources), ["a.unknown"]);
});

test("submenus of one extension are filled by another, cycles stop", () => {
  const sources = [
    ext("a.one", { submenus: [{ id: "a.sub", label: "Sub" }], menus: { "view/title": [{ submenu: "a.sub", group: "navigation" }] } }),
    ext("b.two", { commands: [{ command: "b.do", title: "Do" }], menus: { "a.sub": [{ command: "b.do" }, { submenu: "a.sub" }] } }),
  ];
  const items = resolveMenu(sources, "view/title", always);
  assert.equal(items.length, 1);
  const sub = items[0]!;
  assert.ok(sub.type === "submenu" && sub.items.length === 1 && sub.items[0]!.type === "command");
});

test("walkthroughs parse with steps, media, events and legacy doneOn", () => {
  const sources = [
    ext("pub.ext", {
      walkthroughs: [
        {
          id: "start",
          title: "Get started",
          description: "Learn",
          featuredFor: [".ts", "python"],
          steps: [
            { id: "one", title: "One", description: "[Run](command:pub.run?%5B1%5D)", media: { image: "media/a.png", altText: "A" }, completionEvents: ["onCommand:pub.run", "onSettingChanged:editor.tabSize"] },
            { id: "two", title: "Two", description: "text", media: { markdown: "media/b.md" }, doneOn: { command: "pub.two" } },
            { id: "three", title: "Three", description: "x", media: { image: { dark: "d.png", light: "l.png" } } },
            { id: "gone", title: "Gone", description: "x", when: "false" },
          ],
        },
        { id: "hidden", title: "Hidden", when: "false", steps: [] },
      ],
    }),
  ];
  const walkthroughs = parseWalkthroughs(sources, (clause) => clause !== "false");
  assert.equal(walkthroughs.length, 1);
  const w = walkthroughs[0]!;
  assert.equal(w.key, "pub.ext#start");
  assert.deepEqual(w.steps.map((step) => step.id), ["one", "two", "three"]);
  assert.deepEqual(w.steps[1]!.completionEvents, ["onCommand:pub.two"]);
  assert.equal(w.steps[0]!.media?.kind, "image");
  assert.equal(w.steps[1]!.media?.kind, "markdown");
  assert.deepEqual(w.steps[2]!.media?.path, { dark: "d.png", light: "l.png" });
  assert.equal(findWalkthrough(walkthroughs, "PUB.EXT#start"), w);
  assert.ok(featuredFor(w, "a.TS"));
  assert.ok(featuredFor(w, "x", "python"));
  assert.ok(!featuredFor(w, "a.rs", "rust"));
  assert.ok(!completesOnSelect(w.steps[0]!));
  assert.ok(completesOnSelect(w.steps[2]!));
});

test("completion events and command links", () => {
  assert.deepEqual(parseCompletionEvent("onCommand:a.b"), { kind: "command", arg: "a.b" });
  assert.deepEqual(parseCompletionEvent("onSettingChanged:x.y"), { kind: "settingChanged", arg: "x.y" });
  assert.deepEqual(parseCompletionEvent("onContext:a && b"), { kind: "context", arg: "a && b" });
  assert.deepEqual(parseCompletionEvent("onView:v"), { kind: "view", arg: "v" });
  assert.deepEqual(parseCompletionEvent("extensionInstalled:p.e"), { kind: "extensionInstalled", arg: "p.e" });
  assert.deepEqual(parseCompletionEvent("onStepSelected"), { kind: "stepSelected" });
  assert.equal(parseCompletionEvent("onNothing:x"), null);
  assert.deepEqual(parseCommandLink("command:a.b?%5B%22x%22%2C2%5D"), { command: "a.b", args: ["x", 2] });
  assert.deepEqual(parseCommandLink("command:a.b"), { command: "a.b", args: [] });
  assert.equal(parseCommandLink("https://x"), null);
  const { markdown, links } = replaceCommandLinks("a [Go](command:x.y) b [Web](https://e.com) [Z](command:z?%5B1%5D)");
  assert.deepEqual(links, ["command:x.y", "command:z?%5B1%5D"]);
  assert.ok(markdown.includes("[Web](https://e.com)") && !markdown.includes("command:"));
});

test("resource label formatters", () => {
  const formatters = labelFormattersOf([
    ext("a.b", {
      resourceLabelFormatters: [
        { scheme: "ssh", formatting: { label: "${path} [${authority}]", separator: "/" } },
        { scheme: "ssh", authority: "prod*", formatting: { label: "PROD ${path}", stripPathStartingSeparator: true } },
        { scheme: "win", formatting: { label: "${path}", separator: "\\", normalizeDriveLetter: true } },
        { scheme: "bad" },
      ],
    }),
  ]);
  assert.equal(formatters.length, 3);
  const label = (key: string) => {
    const resource = parseResourceKey(key);
    return resource ? formatResourceLabel(formatters, resource) : undefined;
  };
  assert.equal(label("ssh://dev/home/a.ts"), "/home/a.ts [dev]");
  assert.equal(label("ssh://prod1/etc/x"), "PROD etc/x");
  assert.equal(label("win://h/c:/dir/f.txt"), "C:\\dir\\f.txt");
  assert.equal(label("other://x/y"), undefined);
  assert.equal(label("C:\\dir\\f.txt"), undefined);
  assert.equal(label("untitled:Untitled-1"), undefined);
});

test("typescriptServerPlugins are listed and decorate the language service", () => {
  const location = resolve(ROOT, "test/fixtures/menus-walkthroughs/plugin");
  const specs = tsServerPluginsOf([
    { id: "p.e", location, manifest: { contributes: { typescriptServerPlugins: [{ name: "lumen-test-plugin", enableForWorkspaceTypeScriptVersions: true }, { name: "missing-plugin" }] } } },
    { id: "q.f", location, manifest: {} },
  ]);
  assert.deepEqual(specs.map((spec) => spec.name), ["lumen-test-plugin", "missing-plugin"]);

  const file = "/virtual/a.ts";
  const files = new Map([[file, "const x = 1;"]]);
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: () => "1",
    getScriptSnapshot: (name) => (files.has(name) ? ts.ScriptSnapshot.fromString(files.get(name)!) : undefined),
    getCurrentDirectory: () => "/virtual",
    getCompilationSettings: () => ({}),
    getDefaultLibFileName: () => "lib.d.ts",
    fileExists: (name) => files.has(name),
    readFile: (name) => files.get(name),
  };
  const base = ts.createLanguageService(host);
  const logs: string[] = [];
  setTsPluginConfig("lumen-test-plugin", { greeting: "hello" });
  const service = applyTsServerPlugins(ts, base, host, specs, (message) => logs.push(message));
  assert.notEqual(service, base);
  // The plug-in answers where the base service has nothing.
  assert.equal(service.getQuickInfoAtPosition(file, 5)?.displayParts?.[0]?.text, "hello");
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /missing-plugin/);
});

test("menu arguments are revived into Uris, openWalkthrough arguments parsed", () => {
  const [uri, list] = reviveMenuArg([{ $uri: "C:\\a\\b.txt" }, [{ $uri: "ssh://h/p" }]]) as [T.Uri, T.Uri[]];
  assert.equal(uri.scheme, "file");
  assert.equal(list[0]!.scheme, "ssh");
  assert.deepEqual(reviveMenuArg(["x", 1]), ["x", 1]);
  // Plain objects are revived inside (editor/lineNumber/context's `{ lineNumber, uri }`).
  const context = reviveMenuArg({ lineNumber: 3, uri: { $uri: "C:\\a\\b.txt" } }) as { lineNumber: number; uri: T.Uri };
  assert.equal(context.lineNumber, 3);
  assert.equal(context.uri.scheme, "file");
  // `{ $ref }` goes to the feature of its area; without a host (or an unknown area) it is undefined.
  assert.equal(reviveMenuArg({ $ref: { area: "scm", control: 1 } }), undefined);
  assert.deepEqual(parseOpenWalkthroughArgs(["p.e#w"]), { key: "p.e#w", toSide: false });
  assert.deepEqual(parseOpenWalkthroughArgs([{ category: "p.e#w", step: "p.e#w#s1" }, true]), { key: "p.e#w", step: "s1", toSide: true });
  assert.equal(parseOpenWalkthroughArgs([]), null);
});

function startedHost(extensions: ExtensionDescription[] = []): { host: ExtensionHost; posted: HostToView[] } {
  const host = new ExtensionHost();
  host.init = { extensions, config: { lumen: {}, user: {} }, workspace: null, userData: mkdtempSync(join(tmpdir(), "lumen-mw-test-")), appRoot: ROOT, appName: "Lumen", appVersion: "0.1.0", languages: [], webviewPort: 1, webviewToken: "t" };
  const posted: HostToView[] = [];
  host.post = (message) => void posted.push(message);
  return { host, posted };
}

function featureMessages(posted: HostToView[]): { type: string; [key: string]: unknown }[] {
  return posted
    .filter((message) => message.type === "feature" && (message as { area: string }).area === "menus-walkthroughs")
    .map((message) => (message as unknown as { payload: { type: string } }).payload);
}

test("host feature: openWalkthrough, command observation, media and label formatters", async () => {
  const folder = mkdtempSync(join(tmpdir(), "lumen-mw-ext-"));
  writeFileSync(join(folder, "a.md"), "# Hello");
  writeFileSync(join(folder, "a.png"), Buffer.from([137, 80, 78, 71]));
  const description: ExtensionDescription = {
    id: "pub.ext",
    location: folder,
    enabled: true,
    kind: "lumen",
    development: false,
    manifest: {
      name: "ext",
      publisher: "pub",
      version: "1.0.0",
      activationEvents: ["onWalkthrough:pub.ext#w"],
      contributes: { walkthroughs: [{ id: "w", title: "W", description: "d", steps: [{ id: "s", title: "S", description: "x", completionEvents: ["onCommand:pub.watched"] }] }] },
    },
  };
  const { host, posted } = startedHost([description]);
  host.runtimes.set("pub.ext", { id: "pub.ext", description, api: null, activated: false, activating: null, exports: undefined, module: null, context: null, activationEvents: ["onWalkthrough:pub.ext#w"] });
  const feature = hostFeatures.find((candidate) => candidate.area === "menus-walkthroughs")!;
  assert.deepEqual([...watchedCommands(host)], ["pub.watched"]);
  assert.ok(feature.commands?.includes("workbench.action.openWalkthrough"));
  feature.init?.(host);

  // openWalkthrough: unknown ids are an error, known ones reach the window
  await assert.rejects(host.executeCommand("workbench.action.openWalkthrough", ["nope#x"]), /not found/);
  await host.executeCommand("workbench.action.openWalkthrough", ["PUB.EXT#W"]);
  await host.executeCommand("workbench.action.openWalkthrough", []);
  const messages = featureMessages(posted);
  assert.deepEqual(messages.map((message) => message.type), ["open", "pick"]);
  assert.equal(messages[0]!.key, "pub.ext#w");

  // onCommand completion: only commands a step waits for are reported
  posted.length = 0;
  const commands = (host.apiFor(null) as { commands: { registerCommand(id: string, callback: () => unknown): unknown } }).commands;
  commands.registerCommand("pub.other", () => 1);
  commands.registerCommand("pub.watched", () => 2);
  assert.equal(await host.executeCommand("pub.other", []), 1);
  assert.equal(await host.executeCommand("pub.watched", []), 2);
  await new Promise((done) => setTimeout(done, 5));
  assert.deepEqual(featureMessages(posted), [{ type: "commands", ids: ["pub.watched"] }]);

  // media: images as data URLs, markdown as text, nothing outside the extension folder
  const image = (await feature.onViewRequest!(host, "media", ["pub.ext", "a.png"])) as { kind: string; dataUrl: string };
  assert.match(image.dataUrl, /^data:image\/png;base64,/);
  assert.deepEqual(await feature.onViewRequest!(host, "media", ["pub.ext", "a.md"]), { kind: "text", text: "# Hello" });
  await assert.rejects(Promise.resolve(feature.onViewRequest!(host, "media", ["pub.ext", "../outside.png"])), /outside/);
  await assert.rejects(Promise.resolve(feature.onViewRequest!(host, "media", ["unknown.ext", "a.png"])), /unknown extension/);

  // workspace.registerResourceLabelFormatter
  posted.length = 0;
  const api = host.apiFor(null) as { workspace: { registerResourceLabelFormatter(formatter: unknown): { dispose(): void } } };
  const registration = api.workspace.registerResourceLabelFormatter({ scheme: "s", formatting: { label: "${path}" } });
  assert.equal((featureMessages(posted).at(-1)!.formatters as unknown[]).length, 1);
  registration.dispose();
  assert.equal((featureMessages(posted).at(-1)!.formatters as unknown[]).length, 0);
  assert.throws(() => api.workspace.registerResourceLabelFormatter({ scheme: "s" }), /formatting\.label/);
});
