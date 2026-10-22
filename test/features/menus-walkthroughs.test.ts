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
import { labelOf } from "../../src/mainview/features/menus-walkthroughs/labels.ts";
import {
  completesOnSelect,
  defaultCompletionEvents,
  featuredFor,
  findWalkthrough,
  flattenMenu,
  formatResourceLabel,
  labelFormattersOf,
  markdownImageSources,
  mediaPathFor,
  orderWalkthroughs,
  parseCommandLink,
  parseCompletionEvent,
  parseResourceKey,
  parseStepDescription,
  parseWalkthroughs,
  replaceCommandLinks,
  replaceMarkdownImages,
  resolveMenu,
  setWalkthroughHidden,
  undeclaredSubmenus,
  type ContributionSource,
} from "../../src/shared/menus-walkthroughs.ts";
import { isViewVisible, onViewVisibility, setVisibleViews, viewAliases } from "../../src/mainview/features/menus-walkthroughs/views.ts";
import { embedMarkdownImages, featuredWalkthroughs } from "../../src/main/exthost/features/menus-walkthroughs.ts";
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
          featuredFor: ["*.ts", "*.py"],
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
  assert.ok(featuredFor(w, "src/a.TS"));
  assert.ok(featuredFor(w, "scripts/x.py"));
  assert.ok(!featuredFor(w, "a.rs"));
  assert.ok(!completesOnSelect(w.steps[0]!));
  assert.ok(completesOnSelect(w.steps[2]!));
});

test("hidden walkthrough categories are case-insensitive and can be shown again", () => {
  let hidden = setWalkthroughHidden(undefined, "pub.ext#start", true);
  assert.deepEqual(hidden, ["pub.ext#start"]);
  // Hiding an already hidden walkthrough (with another casing) keeps one entry.
  hidden = setWalkthroughHidden(hidden, "PUB.EXT#START", true);
  assert.equal(hidden.length, 1);
  hidden = setWalkthroughHidden(hidden, "pub.ext#start", false);
  assert.deepEqual(hidden, []);
  // The other categories stay when one is shown.
  assert.deepEqual(setWalkthroughHidden(["a.b#one", "c.d#two"], "A.B#ONE", false), ["c.d#two"]);
});

test("completion events and command links", () => {
  assert.deepEqual(parseCompletionEvent("onCommand:a.b"), { kind: "command", arg: "a.b" });
  // `command:toSide:` links are onCommand events of the plain command.
  assert.deepEqual(parseCompletionEvent("onCommand:toSide:a.b"), { kind: "command", arg: "a.b" });
  assert.deepEqual(parseCompletionEvent("onSettingChanged:x.y"), { kind: "settingChanged", arg: "x.y" });
  assert.deepEqual(parseCompletionEvent("onContext:a && b"), { kind: "context", arg: "a && b" });
  assert.deepEqual(parseCompletionEvent("onView:v"), { kind: "view", arg: "v" });
  assert.deepEqual(parseCompletionEvent("extensionInstalled:p.e"), { kind: "extensionInstalled", arg: "p.e" });
  assert.deepEqual(parseCompletionEvent("onExtensionInstalled:p.e"), { kind: "extensionInstalled", arg: "p.e" });
  assert.deepEqual(parseCompletionEvent("onStepSelected"), { kind: "stepSelected" });
  assert.equal(parseCompletionEvent("onNothing:x"), null);
  assert.deepEqual(parseCommandLink("command:a.b?%5B%22x%22%2C2%5D"), { command: "a.b", args: ["x", 2], toSide: false });
  assert.deepEqual(parseCommandLink("command:a.b"), { command: "a.b", args: [], toSide: false });
  assert.deepEqual(parseCommandLink("command:toSide:a.b?%5B1%5D"), { command: "a.b", args: [1], toSide: true });
  assert.equal(parseCommandLink("https://x"), null);
  const { markdown, links } = replaceCommandLinks("a [Go](command:x.y) b [Web](https://e.com) [Z](command:z?%5B1%5D)");
  assert.deepEqual(links, ["command:x.y", "command:z?%5B1%5D"]);
  assert.ok(markdown.includes("[Web](https://e.com)") && !markdown.includes("command:"));
});

test("steps without completionEvents use their buttons, else selection", () => {
  // A lone link is a button; its command and external links become the step's events.
  assert.deepEqual(parseStepDescription("Hello\n\n[Run](command:pub.run)\nText [Web](https://e.com)"), [
    { text: "Hello" },
    { text: "[Run](command:pub.run)", button: { label: "Run", href: "command:pub.run" } },
    { text: "Text [Web](https://e.com)" },
  ]);
  assert.deepEqual(defaultCompletionEvents("[Run](command:toSide:pub.run)\n[Web](https://e.com)\n[Other](command:pub.other?%5B1%5D)"), [
    "onCommand:pub.run",
    "onLink:https://e.com",
    "onCommand:pub.other",
  ]);
  assert.deepEqual(defaultCompletionEvents("Text with [a link](command:x.y)"), []);
  assert.deepEqual(defaultCompletionEvents(""), []);

  const sources = [
    ext("p.e", {
      walkthroughs: [
        {
          id: "w",
          title: "W",
          steps: [
            { id: "button", title: "B", media: { markdown: "a.md" }, description: "[Run](command:run)" },
            { id: "link", title: "L", media: { markdown: "a.md" }, description: "[Site](https://e.com)" },
            { id: "plain", title: "P", media: { markdown: "a.md" }, description: "Text" },
          ],
        },
      ],
    }),
  ];
  const steps = parseWalkthroughs(sources)[0]!.steps;
  assert.deepEqual(steps.map((step) => step.completionEvents), [["onCommand:run"], ["onLink:https://e.com"], ["onStepSelected"]]);
  assert.ok(completesOnSelect(steps[2]!));
  assert.ok(!completesOnSelect(steps[0]!));
});

test("featured walkthroughs use globs and come first", () => {
  const sources = [
    ext("a.one", {
      walkthroughs: [
        { id: "plain", title: "Plain", steps: [{ id: "s", title: "S", media: { markdown: "a.md" } }] },
        { id: "ts", title: "TS", featuredFor: ["**/*.ts", "tsconfig.json"], steps: [{ id: "s", title: "S", media: { markdown: "a.md" } }] },
        { id: "empty", title: "Empty", steps: [] },
        { id: "icon", title: "Icon", icon: "media/icon.png", steps: [{ id: "s", title: "S", media: { markdown: "a.md" } }] },
      ],
    }),
  ];
  const walkthroughs = parseWalkthroughs(sources);
  assert.deepEqual(walkthroughs.map((walkthrough) => walkthrough.id), ["plain", "ts", "icon"]);
  assert.equal(walkthroughs[2]!.icon, "media/icon.png");
  const ts = walkthroughs[1]!;
  assert.ok(featuredFor(ts, "src/a.ts"));
  assert.ok(featuredFor(ts, "tsconfig.json"));
  assert.ok(!featuredFor(ts, "src/a.js"));
  const ordered = orderWalkthroughs(walkthroughs, (walkthrough) => walkthrough.id === "ts");
  assert.deepEqual(ordered.map((walkthrough) => [walkthrough.id, !!walkthrough.featured]), [["ts", true], ["plain", false], ["icon", false]]);
});

test("media paths follow the theme kind, markdown images resolve", () => {
  const media = { kind: "image" as const, path: { light: "l.png", dark: "d.png", hc: "h.png", hcLight: "hl.png" } };
  assert.equal(mediaPathFor(media, "dark"), "d.png");
  assert.equal(mediaPathFor(media, "light"), "l.png");
  assert.equal(mediaPathFor(media, "hcDark"), "h.png");
  assert.equal(mediaPathFor(media, "hcLight"), "hl.png");
  // Missing variants fall back to the other kind rather than disappearing.
  assert.equal(mediaPathFor({ kind: "image", path: { light: "l.png", dark: "d.png" } }, "hcLight"), "l.png");
  assert.equal(mediaPathFor({ kind: "image", path: "a.png" }, "hcDark"), "a.png");

  const markdown = "![A](media/a.png) and <img src=\"media/b.png\">\n![](https://e.com/c.png)";
  assert.deepEqual(markdownImageSources(markdown), ["media/a.png", "media/b.png", "https://e.com/c.png"]);
  const replaced = replaceMarkdownImages(markdown, (source) => (source.startsWith("media/") ? `data:image/png;base64,${source.length}` : undefined));
  assert.match(replaced, /!\[A\]\(data:image\/png;base64,11\)/);
  assert.match(replaced, /src="data:image\/png;base64,11"/);
  assert.match(replaced, /https:\/\/e.com\/c.png/);
});

test("visible views report their VS Code ids", () => {
  assert.deepEqual(viewAliases("explorer"), ["explorer", "workbench.explorer.fileView"]);
  assert.deepEqual(viewAliases("view:feature:timeline"), ["timeline"]);
  assert.deepEqual(viewAliases("my.view"), ["my.view"]);
  const heard: string[] = [];
  const stop = onViewVisibility((id, visible) => heard.push(`${id}:${visible}`));
  setVisibleViews(["explorer", "my.view"]);
  assert.ok(isViewVisible("workbench.explorer.fileView"));
  setVisibleViews(["my.view"]);
  stop();
  assert.ok(heard.includes("workbench.explorer.fileView:true"));
  assert.ok(heard.includes("workbench.explorer.fileView:false"));
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

test("tab and breadcrumb labels use the formatter, files keep their name", () => {
  const formatters = labelFormattersOf([
    ext("a.b", {
      resourceLabelFormatters: [
        { scheme: "ssh", formatting: { label: "${path} [${authority}]", separator: "/" } },
        { scheme: "git", authority: "pr", formatting: { label: "${authoritySuffix} ${path}" } },
      ],
    }),
  ]);
  // Tabs and breadcrumbs show the formatter's label, not the raw basename.
  assert.equal(labelOf(formatters, "ssh://dev/home/a.ts", "a.ts"), "/home/a.ts [dev]");
  assert.equal(labelOf(formatters, "git://pr/head/b.ts", "b.ts"), "@pr /head/b.ts");
  // Files, untitled documents and schemes without a formatter keep their name.
  assert.equal(labelOf(formatters, "C:\\dir\\f.ts", "f.ts"), "f.ts");
  assert.equal(labelOf(formatters, "untitled:Untitled-1", "Untitled-1"), "Untitled-1");
  assert.equal(labelOf(formatters, "other://x/y.ts", "y.ts"), "y.ts");
  assert.equal(labelOf([], "ssh://dev/home/a.ts", "a.ts"), "a.ts");
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
  assert.deepEqual(parseOpenWalkthroughArgs([{ category: "p.e#w", step: "p.e#w#s1" }, { toSide: true, inactive: true }]), { key: "p.e#w", step: "s1", toSide: true });
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
  writeFileSync(join(folder, "b.md"), "![A](a.png)");
  writeFileSync(join(folder, "i.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="var(--vscode-editor-foreground)"/></svg>');
  writeFileSync(join(folder, "a.png"), Buffer.from([137, 80, 78, 71]));
  writeFileSync(join(folder, "main.py"), "print(1)");
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
      contributes: {
        walkthroughs: [
          {
            id: "w",
            title: "W",
            description: "d",
            featuredFor: ["*.py"],
            steps: [{ id: "s", title: "S", description: "x", completionEvents: ["onCommand:pub.watched"] }],
          },
        ],
      },
    },
  };
  const { host, posted } = startedHost([description]);
  host.workspace = folder;
  host.runtimes.set("pub.ext", { id: "pub.ext", description, api: null, activated: false, activating: null, exports: undefined, module: null, context: null, activationEvents: ["onWalkthrough:pub.ext#w"] });
  const feature = hostFeatures.find((candidate) => candidate.area === "menus-walkthroughs")!;
  assert.deepEqual([...watchedCommands(host)], ["pub.watched"]);
  assert.ok(feature.commands?.includes("workbench.action.openWalkthrough"));
  for (const id of ["welcome.markStepComplete", "welcome.markStepIncomplete", "walkthroughs.selectStep", "resetGettingStartedProgress"]) assert.ok(feature.commands?.includes(id));
  feature.init?.(host);

  // openWalkthrough: unknown ids are an error, known ones reach the window, no id opens the Welcome page
  await assert.rejects(host.executeCommand("workbench.action.openWalkthrough", ["nope#x"]), /not found/);
  await host.executeCommand("workbench.action.openWalkthrough", ["PUB.EXT#W"]);
  await host.executeCommand("workbench.action.openWalkthrough", [{ category: "pub.ext#w", step: "pub.ext#w#s" }, { toSide: true }]);
  await host.executeCommand("workbench.action.openWalkthrough", []);
  const messages = featureMessages(posted);
  assert.deepEqual(messages.map((message) => message.type), ["open", "open", "welcome"]);
  assert.equal(messages[0]!.key, "pub.ext#w");
  assert.equal(messages[1]!.step, "s");
  assert.equal(messages[1]!.toSide, true);

  // VS Code's walkthrough progress actions are forwarded to the window.
  posted.length = 0;
  await host.executeCommand("welcome.markStepComplete", ["pub.ext#w#s"]);
  await host.executeCommand("welcome.markStepIncomplete", ["pub.ext#w#s"]);
  await host.executeCommand("walkthroughs.selectStep", ["pub.ext#w#s"]);
  await host.executeCommand("resetGettingStartedProgress", []);
  assert.deepEqual(featureMessages(posted).map((message) => [message.type, message.key, message.done]), [
    ["mark", "pub.ext#w#s", true],
    ["mark", "pub.ext#w#s", false],
    ["select", "pub.ext#w#s", undefined],
    ["reset", undefined, undefined],
  ]);

  // onCommand completion: only commands a step waits for are reported
  posted.length = 0;
  const commands = (host.apiFor(null) as { commands: { registerCommand(id: string, callback: () => unknown): unknown } }).commands;
  commands.registerCommand("pub.other", () => 1);
  commands.registerCommand("pub.watched", () => 2);
  assert.equal(await host.executeCommand("pub.other", []), 1);
  assert.equal(await host.executeCommand("pub.watched", []), 2);
  await new Promise((done) => setTimeout(done, 5));
  assert.deepEqual(featureMessages(posted), [{ type: "commands", ids: ["pub.watched"] }]);

  // media: images as data URLs, svg as inline text, markdown with its images resolved, nothing outside the extension folder
  const image = (await feature.onViewRequest!(host, "media", ["pub.ext", "a.png"])) as { kind: string; dataUrl: string };
  assert.match(image.dataUrl, /^data:image\/png;base64,/);
  assert.deepEqual(await feature.onViewRequest!(host, "media", ["pub.ext", "a.md"]), { kind: "text", text: "# Hello" });
  assert.deepEqual((await feature.onViewRequest!(host, "media", ["pub.ext", "i.svg"])) as { kind: string; text: string }, {
    kind: "svg",
    text: '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="var(--vscode-editor-foreground)"/></svg>',
  });
  const markdown = (await feature.onViewRequest!(host, "media", ["pub.ext", "b.md"])) as { kind: string; text: string };
  assert.equal(markdown.kind, "text");
  assert.match(markdown.text, /!\[A\]\(data:image\/png;base64,/);
  const embedded = await embedMarkdownImages(host, "pub.ext", "![A](a.png) ![W](https://e.com/x.png)", folder);
  assert.match(embedded, /data:image\/png;base64,/);
  assert.match(embedded, /https:\/\/e.com\/x.png/);
  await assert.rejects(Promise.resolve(feature.onViewRequest!(host, "media", ["pub.ext", "../outside.png"])), /outside/);
  await assert.rejects(Promise.resolve(feature.onViewRequest!(host, "media", ["unknown.ext", "a.png"])), /unknown extension/);

  // featuredFor patterns are matched against the workspace's files
  assert.deepEqual(await feature.onViewRequest!(host, "featured", []), ["pub.ext#w"]);
  host.workspace = mkdtempSync(join(tmpdir(), "lumen-mw-empty-"));
  assert.deepEqual(await featuredWalkthroughs(host), []);

  // workspace.registerResourceLabelFormatter
  posted.length = 0;
  const api = host.apiFor(null) as { workspace: { registerResourceLabelFormatter(formatter: unknown): { dispose(): void } } };
  const registration = api.workspace.registerResourceLabelFormatter({ scheme: "s", formatting: { label: "${path}" } });
  assert.equal((featureMessages(posted).at(-1)!.formatters as unknown[]).length, 1);
  registration.dispose();
  assert.equal((featureMessages(posted).at(-1)!.formatters as unknown[]).length, 0);
  assert.throws(() => api.workspace.registerResourceLabelFormatter({ scheme: "s" }), /formatting\.label/);
});
