import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { deflateRawSync } from "node:zlib";
import { formatReport, refreshReport, scanApiUsage, transpileExtension, transpileSource, transpileVsix } from "../src/main/extensions/transpiler.ts";
import { readZip } from "../src/main/extensions/vsix.ts";
import { ExtensionManager } from "../src/main/extensions/manager.ts";
import { currentTargetPlatform, platformLabel, runsOn, vsixTargetPlatform } from "../src/main/extensions/platform.ts";
import { API_SUPPORT, API_TYPES, API_TYPES_COMPAT, API_TYPES_MISSING, CONTRIBUTION_SUPPORT } from "../src/shared/extension-api.ts";
import { matchGlob, matchesSelector } from "../src/shared/glob.ts";
import { ExtensionHost } from "../src/main/exthost/host.ts";
import type { ExtensionRuntime } from "../src/main/exthost/host.ts";
import { WebviewResourceServer } from "../src/main/extensions/webview-server.ts";
import { webviewOrigin } from "../src/shared/webview-document.ts";
import { createServer, request as httpRequest } from "node:http";
import type { ExtensionDescription, HostToView, ViewToHost } from "../src/shared/extensions.ts";
import type { HostInit, HostToMain, MainToHost } from "../src/main/exthost/protocol.ts";
import { detectLanguage, firstLineOf, jsonSchemaAssociations, setContributedLanguages } from "../src/main/language.ts";
import { jsonCompletions, jsonDiagnostics, jsonHover, setJsonSchemas } from "../src/main/json-service.ts";
import { contributedThemes, loadColorTheme } from "../src/main/themes.ts";
import { compileTokenRules, kindOfUiTheme, matchTokenStyle, resolveThemeColors } from "../src/shared/color-theme.ts";

/**
 * Extensions: the VS Code → Lumen transpiler, the .vsix reader, glob
 * matching, the API surface and an end-to-end run of the extension host
 * (in a worker, with this test playing the view).
 *
 *   node --test test/extensions.test.ts
 */

const ROOT = resolve(import.meta.dirname, "..");
const SAMPLES = join(ROOT, "examples", "extensions");

function temp(): string {
  return mkdtempSync(join(tmpdir(), "lumen-ext-test-"));
}

/** A minimal zip writer (deflate), to build .vsix packages. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const compressed = deflateRawSync(data);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, compressed);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/* ── transpiler ─────────────────────────────────────────────────────────── */

test("transpileSource rewrites every form of the vscode import", () => {
  const source = [
    `const vscode = require("vscode");`,
    `const v2 = require('vscode');`,
    `import * as v3 from "vscode";`,
    `import { window } from 'vscode';`,
    `const lazy = await import("vscode");`,
    `const other = require("vscode-languageclient");`,
  ].join("\n");
  const { code, rewrites } = transpileSource(source);
  assert.equal(rewrites, 5);
  assert.match(code, /require\("lumen"\)/);
  assert.match(code, /from "lumen"/);
  assert.match(code, /require\("vscode-languageclient"\)/, "other packages are left alone");
});

test("scanApiUsage finds namespace members through aliases and destructuring", () => {
  const usage = new Map<string, number>();
  scanApiUsage(
    [
      `var vs = __toESM(require("vscode"));`,
      `vs.window.showInformationMessage("hi");`,
      `vs.window.createWebviewPanel("x");`,
      `new vs.Range(0, 0, 0, 1);`,
      `const { commands, workspace: ws } = require("vscode");`,
      `commands.registerCommand("a", () => {});`,
      `ws.getConfiguration("a");`,
    ].join("\n"),
    usage,
  );
  assert.equal(usage.get("window.showInformationMessage"), 1);
  assert.equal(usage.get("window.createWebviewPanel"), 1);
  assert.equal(usage.get("Range"), 1);
  assert.equal(usage.get("commands.registerCommand"), 1);
  assert.equal(usage.get("workspace.getConfiguration"), 1);
});

test("transpileExtension converts the VS Code sample and reports compatibility", () => {
  const dir = temp();
  try {
    const target = join(dir, "word-tools");
    const { manifest, report } = transpileExtension(join(SAMPLES, "vscode-word-tools"), target);
    assert.equal(manifest.engines?.lumen, "^0.1.0");
    assert.equal(manifest.lumen?.transpiledFrom, "vscode");
    assert.equal(report.rewrittenImports, 1);
    assert.equal(report.level, "full", "everything the sample uses (commands, menus, webviews) is supported");
    assert.ok(report.apis.some((api) => api.name === "commands.registerTextEditorCommand" && api.status === "supported"));
    const code = readFileSync(join(target, "out", "extension.js"), "utf8");
    assert.match(code, /require\("lumen"\)/);
    assert.doesNotMatch(code, /require\("vscode"\)/);
    // The source folder is untouched.
    assert.match(readFileSync(join(SAMPLES, "vscode-word-tools", "out", "extension.js"), "utf8"), /require\("vscode"\)/);
    assert.match(formatReport(manifest, report), /compatibility: full/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a web-only extension using custom editors is reported as limited", () => {
  const dir = temp();
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "web", publisher: "p", version: "1.0.0", engines: { vscode: "^1.80.0" }, browser: "./b.js" }),
    );
    writeFileSync(join(dir, "b.js"), `const vscode = require("vscode"); vscode.window.registerCustomEditorProvider("a", {});`);
    const { report } = transpileExtension(dir);
    // The API is supported now, but a web-only extension still cannot load.
    assert.equal(report.level, "limited");
    assert.ok(report.apis.some((api) => api.name === "window.registerCustomEditorProvider" && api.status === "supported"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── vsix & manager ─────────────────────────────────────────────────────── */

const SAMPLE_VSIX = () =>
  zip({
    "[Content_Types].xml": "<Types/>",
    "extension.vsixmanifest": "<PackageManifest/>",
    "extension/package.json": readFileSync(join(SAMPLES, "vscode-word-tools", "package.json"), "utf8"),
    "extension/out/extension.js": readFileSync(join(SAMPLES, "vscode-word-tools", "out", "extension.js"), "utf8"),
  });

test("a stored report is re-rated against the current API table", () => {
  const manifest = {
    name: "old",
    publisher: "test",
    version: "1.0.0",
    engines: { vscode: "^1.90.0", lumen: "^0.1.0" },
    contributes: { views: { explorer: [{ id: "a", name: "A", type: "webview" }] } },
  };
  const stale = {
    transpilerVersion: 1,
    rewrittenImports: 1,
    filesScanned: 1,
    filesRewritten: 1,
    apis: [
      { name: "window.createWebviewPanel", status: "unsupported" as const, count: 2, note: "not part of Lumen's API" },
      { name: "window.registerWebviewViewProvider", status: "unsupported" as const, count: 1, note: "not part of Lumen's API" },
    ],
    contributions: [{ name: "views", status: "unsupported" as const }],
    warnings: [],
    level: "limited" as const,
  };
  const report = refreshReport(stale, manifest);
  const panel = report.apis.find((api) => api.name === "window.createWebviewPanel")!;
  assert.equal(panel.status, "supported");
  assert.equal(panel.count, 2);
  assert.deepEqual(
    report.apis.find((api) => api.name === "window.registerWebviewViewProvider"),
    { name: "window.registerWebviewViewProvider", count: 1, status: "supported" },
  );
  assert.equal(report.contributions.find((c) => c.name === "views")?.status, "supported");
  // Everything it uses is supported now: limited becomes full.
  assert.equal(report.level, "full");
});

test("an extension whose APIs are all unsupported is limited, not partial", () => {
  const manifest = {
    name: "gone",
    publisher: "test",
    version: "1.0.0",
    engines: { vscode: "^1.90.0", lumen: "^0.1.0" },
    contributes: { commands: [{ command: "a", title: "A" }] },
  };
  const unsupported = (name: string) => ({ name, status: "unsupported" as const, count: 1, note: "not part of Lumen's API" });
  const stale = {
    transpilerVersion: 1,
    rewrittenImports: 1,
    filesScanned: 1,
    filesRewritten: 1,
    apis: [unsupported("window.someFutureApi"), unsupported("workspace.anotherFutureApi")],
    contributions: [],
    warnings: [],
    level: "partial" as const,
  };
  assert.equal(refreshReport(stale, manifest).level, "limited");
  // Not even a contribution point works: unsupported.
  assert.equal(refreshReport(stale, { ...manifest, contributes: {} }).level, "unsupported");
  // One working API is enough for partial.
  const mixed = { ...stale, apis: [...stale.apis, { name: "commands.registerCommand", status: "supported" as const, count: 1 }] };
  assert.equal(refreshReport(mixed, manifest).level, "partial");
});

test("comment keys are not contribution points, and the Java extensions' points count as supported", () => {
  const manifest = {
    name: "javaish",
    publisher: "test",
    version: "1.0.0",
    engines: { vscode: "^1.90.0", lumen: "^0.1.0" },
    contributes: {
      "//": "comment",
      commands: [{ command: "a", title: "A" }],
      javaExtensions: ["./server/plugin.jar"],
      javaShortcuts: [{ title: "A", command: "a" }],
      javaBuildFilePatterns: ["^build\\.gradle$"],
      javaBuildTools: [{ displayName: "Gradle", buildFileNames: ["build.gradle"] }],
    },
  };
  const stale = {
    transpilerVersion: 1,
    rewrittenImports: 0,
    filesScanned: 0,
    filesRewritten: 0,
    apis: [],
    contributions: [],
    warnings: [],
    level: "partial" as const,
  };
  const report = refreshReport(stale, manifest);
  assert.deepEqual(
    report.contributions.map((c) => [c.name, c.status]),
    [
      ["commands", "supported"],
      ["javaExtensions", "supported"],
      ["javaShortcuts", "supported"],
      ["javaBuildFilePatterns", "supported"],
      ["javaBuildTools", "supported"],
    ],
  );
  assert.equal(report.level, "full");
});

test("partial extensions are graded by how much of what they use works", () => {
  const manifest = {
    name: "graded",
    publisher: "test",
    version: "1.0.0",
    engines: { vscode: "^1.90.0", lumen: "^0.1.0" },
    contributes: { commands: [{ command: "a", title: "A" }] },
  };
  const supported = ["commands.registerCommand", "window.showInformationMessage", "window.showQuickPick", "workspace.getConfiguration"];
  const missing = ["window.someFutureApi", "workspace.anotherFutureApi", "env.yetAnotherApi", "languages.notThereYet", "tasks.neverHeardOf"];
  const rate = (working: number, broken: number) =>
    refreshReport(
      {
        transpilerVersion: 1,
        rewrittenImports: 1,
        filesScanned: 1,
        filesRewritten: 1,
        apis: [
          ...supported.slice(0, working).map((name) => ({ name, status: "supported" as const, count: 1 })),
          ...missing.slice(0, broken).map((name) => ({ name, status: "unsupported" as const, count: 3 })),
        ],
        contributions: [],
        warnings: [],
        level: "partial" as const,
      },
      manifest,
    );
  // The commands contribution point counts as one more working entry.
  const high = rate(4, 1);
  assert.equal(high.coverage, 83);
  assert.equal(high.partialGrade, "high");
  const medium = rate(1, 2);
  assert.equal(medium.coverage, 50);
  assert.equal(medium.partialGrade, "medium");
  const low = rate(1, 5);
  assert.equal(low.coverage, 29);
  assert.equal(low.partialGrade, "low");
  // Full and limited extensions carry no grade, even when a stored report had one.
  const full = refreshReport({ ...rate(4, 0), partialGrade: "low" }, manifest);
  assert.equal(full.level, "full");
  assert.equal(full.partialGrade, undefined);
  assert.equal(full.coverage, 100);
});

test("readZip reads the entries of a package", () => {
  const entries = readZip(SAMPLE_VSIX());
  assert.equal(entries.length, 4);
  assert.equal(
    JSON.parse(
      entries
        .find((e) => e.name === "extension/package.json")!
        .read()
        .toString(),
    ).name,
    "word-tools",
  );
});

test("transpileVsix rejects entries that escape the target folder", () => {
  const dir = temp();
  try {
    const evil = zip({ "extension/package.json": "{}", "extension/../../evil.txt": "x" });
    assert.throws(() => transpileVsix(evil, join(dir, "out")), /unsafe path/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("packages for another platform are recognised and refused", () => {
  assert.equal(currentTargetPlatform("win32", "x64"), "win32-x64");
  assert.equal(currentTargetPlatform("linux", "arm64", false), "linux-arm64");
  assert.equal(currentTargetPlatform("linux", "arm64", true), "alpine-arm64");
  assert.equal(currentTargetPlatform("linux", "arm", false), "linux-armhf");
  assert.ok(runsOn(undefined, "win32-x64"));
  assert.ok(runsOn("universal", "win32-x64"));
  assert.ok(!runsOn("alpine-arm64", "win32-x64"));
  assert.ok(!runsOn("linux-x64", "alpine-x64"), "glibc and musl builds are not interchangeable");

  const other = currentTargetPlatform() === "linux-arm64" ? "darwin-x64" : "linux-arm64";
  const vsix = (target?: string) =>
    zip({
      "extension.vsixmanifest": `<PackageManifest><Metadata><Identity Id="native" Version="1.0.0" Publisher="test"${target ? ` TargetPlatform="${target}"` : ""}/></Metadata></PackageManifest>`,
      "extension/package.json": JSON.stringify({ name: "native", publisher: "test", version: "1.0.0", engines: { lumen: "^0.1.0" } }),
    });
  assert.equal(vsixTargetPlatform(vsix(other)), other);
  assert.equal(vsixTargetPlatform(vsix()), undefined);
  const dir = temp();
  const previous = process.env.LUMEN_EXTENSIONS_DIR;
  process.env.LUMEN_EXTENSIONS_DIR = dir;
  try {
    const manager = new ExtensionManager();
    assert.throws(
      () => manager.installVsix(vsix(other), { type: "vsix", file: "native.vsix" }),
      new RegExp(`test\\.native 1\\.0\\.0 is the package for ${platformLabel(other)}`),
    );
    assert.equal(manager.list().length, 0);
    assert.equal(manager.installVsix(vsix(currentTargetPlatform()), { type: "vsix", file: "native.vsix" }).id, "test.native");
  } finally {
    if (previous === undefined) delete process.env.LUMEN_EXTENSIONS_DIR;
    else process.env.LUMEN_EXTENSIONS_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Open VSX downloads take this platform's build, an older version's, or fail clearly", async () => {
  const here = currentTargetPlatform();
  const other = here === "linux-arm64" ? "darwin-x64" : "linux-arm64";
  const versions: Record<string, Record<string, unknown>> = {
    // Platform builds without this platform; the default file is another platform's.
    "native/latest": { version: "3.0.0", targetPlatform: other, downloads: { [other]: "/file/3-other.vsix" }, files: { download: "/file/3-other.vsix" } },
    "native/2.0.0": { version: "2.0.0", downloads: { [other]: "/file/2-other.vsix" } },
    "native/1.0.0": { version: "1.0.0", downloads: { [here]: "/file/1-here.vsix", [other]: "/file/1-other.vsix" } },
    "missing/latest": { version: "5.0.0", downloads: { [other]: "/file/5-other.vsix" } },
    "plain/latest": { version: "1.2.3", files: { download: "/file/plain.vsix" } },
  };
  const server = createServer((request, response) => {
    const url = request.url ?? "";
    if (url.startsWith("/file/")) return void response.end(url.slice(6));
    const [, , namespace, name, version] = url.split("/");
    const key = `${name}/${version ?? "latest"}`;
    const entry = versions[key];
    response.setHeader("content-type", "application/json");
    if (!entry) return void response.end(JSON.stringify({ error: `not found: ${namespace}/${key}` }));
    const all = Object.fromEntries(
      Object.keys(versions)
        .filter((k) => k.startsWith(`${name}/`) && k !== `${name}/latest`)
        .map((k) => [k.split("/")[1], ""]),
    );
    const absolute = (path: unknown) => (typeof path === "string" ? `http://127.0.0.1:${(server.address() as { port: number }).port}${path}` : path);
    response.end(
      JSON.stringify({
        namespace,
        name,
        ...entry,
        allVersions: { latest: "", ...all },
        downloads: entry.downloads ? Object.fromEntries(Object.entries(entry.downloads).map(([k, v]) => [k, absolute(v)])) : undefined,
        files: entry.files ? { download: absolute((entry.files as { download: string }).download) } : undefined,
      }),
    );
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const previous = process.env.LUMEN_OPENVSX_URL;
  process.env.LUMEN_OPENVSX_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const { downloadFromMarketplace } = await import(`../src/main/extensions/marketplace.ts?registry=${Date.now()}`);
    const latest = await downloadFromMarketplace("test", "native");
    assert.deepEqual(
      [latest.version, latest.vsix.toString()],
      ["1.0.0", "1-here.vsix"],
      "the newest version built for this platform, never another platform's",
    );
    await assert.rejects(
      downloadFromMarketplace("test", "native", "2.0.0"),
      new RegExp(`2\\.0\\.0 has no build for ${platformLabel(here)} on Open VSX \\(published for ${platformLabel(other)}\\)`),
    );
    await assert.rejects(downloadFromMarketplace("test", "missing"), /has no build for/);
    const plain = await downloadFromMarketplace("test", "plain");
    assert.deepEqual([plain.version, plain.vsix.toString()], ["1.2.3", "plain.vsix"], "packages for every platform still install");
  } finally {
    if (previous === undefined) delete process.env.LUMEN_OPENVSX_URL;
    else process.env.LUMEN_OPENVSX_URL = previous;
    server.close();
  }
});

test("the extension manager installs, disables and uninstalls a .vsix", () => {
  const dir = temp();
  const previous = process.env.LUMEN_EXTENSIONS_DIR;
  process.env.LUMEN_EXTENSIONS_DIR = dir;
  try {
    const manager = new ExtensionManager();
    const installed = manager.installVsix(SAMPLE_VSIX(), { type: "vsix", file: "word-tools.vsix" });
    assert.equal(installed.id, "lumen-samples.word-tools");
    assert.equal(installed.kind, "vscode");
    assert.equal(installed.compat?.rewrittenImports, 1);
    assert.equal(manager.enabled().length, 1);
    manager.setEnabled(installed.id, false);
    assert.equal(manager.enabled().length, 0);
    // Reinstalling (an update) keeps the enabled state and replaces the folder.
    manager.installVsix(SAMPLE_VSIX(), { type: "vsix", file: "word-tools.vsix" });
    assert.equal(manager.list().length, 1);
    assert.equal(manager.enabled().length, 0);
    assert.ok(manager.uninstall(installed.id));
    assert.equal(manager.list().length, 0);
  } finally {
    if (previous === undefined) delete process.env.LUMEN_EXTENSIONS_DIR;
    else process.env.LUMEN_EXTENSIONS_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the extension manager refuses names and versions that would escape its folders", () => {
  const dir = temp();
  const previous = process.env.LUMEN_EXTENSIONS_DIR;
  process.env.LUMEN_EXTENSIONS_DIR = dir;
  try {
    const manager = new ExtensionManager();
    const vsix = (manifest: Record<string, unknown>) => zip({ "extension/package.json": JSON.stringify(manifest) });
    const base = { publisher: "test", version: "1.0.0", engines: { lumen: "^0.1.0" } };
    for (const manifest of [
      { ...base, name: "..\\evil" },
      { ...base, name: "evil/../../x" },
      { ...base, publisher: "..\\..\\x", name: "evil" },
      { ...base, name: "evil", version: "1.0.0/../../x" },
      { ...base, name: "evil", version: "nightly" },
    ]) {
      assert.throws(() => manager.installVsix(vsix(manifest), { type: "vsix", file: "evil.vsix" }), /invalid extension name\/version in package manifest/);
    }
    assert.equal(existsSync(join(dir, "..", "evil")), false);
    // The fallback publisher and a semver pre-release are fine.
    const installed = manager.installVsix(vsix({ name: "nopub", version: "1.2.3-beta.1", engines: { lumen: "^0.1.0" } }), { type: "vsix", file: "nopub.vsix" });
    assert.equal(installed.id, "undefined_publisher.nopub");
    assert.equal(installed.location, join(dir, "undefined_publisher.nopub-1.2.3-beta.1"));

    // Copying a development folder does not validate its manifest: the folder check refuses it.
    const source = temp();
    try {
      writeFileSync(join(source, "package.json"), JSON.stringify({ publisher: "test", name: "..\\escape", version: "1.0.0" }));
      assert.throws(() => manager.installFolder(source, { copy: true }), /outside the extensions directory/);
      assert.equal(existsSync(join(dir, "..", "escape-1.0.0")), false);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  } finally {
    if (previous === undefined) delete process.env.LUMEN_EXTENSIONS_DIR;
    else process.env.LUMEN_EXTENSIONS_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── globs & selectors ──────────────────────────────────────────────────── */

test("globs and document selectors match like VS Code", () => {
  assert.ok(matchGlob("**/*.{ts,tsx}", "src/app/App.tsx"));
  assert.ok(matchGlob("*.md", "docs/readme.md"), "relative globs match below any folder");
  assert.ok(!matchGlob("src/*.ts", "src/a/b.ts"));
  assert.ok(matchGlob("**/node_modules/**", "a/node_modules/x/y.js"));
  assert.ok(matchesSelector([{ language: "markdown" }], "/x/a.md", "markdown"));
  assert.ok(!matchesSelector([{ language: "markdown", scheme: "file" }], "untitled:Untitled-1", "markdown"));
  assert.ok(matchesSelector([{ pattern: "**/*.json" }], "C:\\proj\\package.json", "json"));
});

/* ── API surface ────────────────────────────────────────────────────────── */

test("no API member, type or contribution point is listed as unsupported", () => {
  const status = (entry: string | [string, string]) => (typeof entry === "string" ? entry : entry[0]);
  const unsupported = [
    ...Object.entries(API_SUPPORT).filter(([, entry]) => status(entry) === "unsupported"),
    ...Object.entries(CONTRIBUTION_SUPPORT).filter(([, entry]) => status(entry) === "unsupported"),
  ].map(([key]) => key);
  assert.deepEqual(unsupported, []);
  assert.deepEqual(API_TYPES_MISSING, []);
  // Every partial entry says what is missing.
  for (const [key, entry] of [...Object.entries(API_SUPPORT), ...Object.entries(CONTRIBUTION_SUPPORT)]) {
    if (status(entry) === "partial") assert.ok(typeof entry !== "string" && entry[1], `${key} is partial without a note`);
  }
});

test("every supported or partial API member exists on the lumen module", () => {
  const host = new ExtensionHost();
  host.init = {
    extensions: [],
    config: { lumen: {}, user: {} },
    workspace: null,
    userData: temp(),
    appRoot: ROOT,
    appName: "Lumen",
    appVersion: "0.1.0",
    languages: [],
    webviewPort: 1,
    webviewToken: "t",
  };
  const api = host.apiFor(null) as Record<string, Record<string, unknown>>;
  const missing: string[] = [];
  for (const [member, entry] of Object.entries(API_SUPPORT)) {
    const status = typeof entry === "string" ? entry : entry[0];
    if (status === "unsupported" || member.endsWith(".*")) continue;
    const [namespace, name] = member.split(".") as [string, string];
    if (!(name in (api[namespace] ?? {}))) missing.push(member);
  }
  for (const type of [...API_TYPES, ...API_TYPES_COMPAT]) if (!(type in api)) missing.push(type);
  assert.deepEqual(missing, []);
  // Types listed as missing really are: once one is exported, move it to API_TYPES.
  assert.deepEqual(
    API_TYPES_MISSING.filter((type) => type in api),
    [],
  );
  // Unknown members answer gracefully.
  const window = api.window as Record<string, (...args: unknown[]) => unknown>;
  assert.equal(typeof window.onDidChangeSomethingNew, "function");
  assert.throws(() => window.createSomethingNew!("a"), /not supported by Lumen/);
  assert.equal(typeof (window.registerSomethingNew!("a", {}) as { dispose: unknown }).dispose, "function");
});

test("tree views serve items by stable handles, refresh, run commands and reveal", async () => {
  const host = new ExtensionHost();
  host.init = {
    extensions: [],
    config: { lumen: {}, user: {} },
    workspace: null,
    userData: temp(),
    appRoot: ROOT,
    appName: "Lumen",
    appVersion: "0.1.0",
    languages: [],
    webviewPort: 1,
    webviewToken: "t",
  };
  const posted: HostToView[] = [];
  host.post = (message) => void posted.push(message);
  const api = host.apiFor(null) as Record<string, Record<string, (...args: unknown[]) => unknown>> & Record<string, unknown>;
  type Node = { name: string; children?: Node[]; parent?: Node };
  const a1: Node = { name: "a1" };
  const a: Node = { name: "a", children: [a1] };
  a1.parent = a;
  const b: Node = { name: "b" };
  const twin: Node = { name: "b" };
  const changed = new (api.EventEmitter as unknown as new () => { event: unknown; fire(value?: unknown): void })();
  const TreeItem = api.TreeItem as unknown as new (label: string, state?: number) => Record<string, unknown>;
  const ThemeIcon = api.ThemeIcon as unknown as new (id: string) => unknown;
  const ran: unknown[][] = [];
  api.commands.registerCommand("test.open", (...args: unknown[]) => void ran.push(["open", ...args]));
  api.commands.registerCommand("test.remove", (...args: unknown[]) => void ran.push(["remove", ...args]));
  const view = api.window.createTreeView("test.tree", {
    showCollapseAll: true,
    treeDataProvider: {
      onDidChangeTreeData: changed.event,
      getChildren: (node?: Node) => (node ? (node.children ?? []) : [a, b, twin]),
      getParent: (node: Node) => node.parent,
      getTreeItem: (node: Node) => {
        const item = new TreeItem(node.name, node.children ? 1 : 0);
        if (node === b) {
          item.command = { command: "test.open", title: "Open", arguments: [42] };
          item.contextValue = "leaf";
          item.iconPath = new ThemeIcon("star");
        }
        return item;
      },
    },
  }) as { reveal: (element: unknown, options?: unknown) => Promise<void>; selection: unknown[]; dispose(): void };

  assert.ok(posted.some((m) => m.type === "treeView" && m.view.viewId === "test.tree" && m.view.showCollapseAll));
  const root = (await host.methods.treeChildren("test.tree", null))!;
  assert.deepEqual(
    root.map((item) => [item.handle, item.label, item.collapsible]),
    [
      ["/a", "a", "collapsed"],
      ["/b", "b", "none"],
      ["/b#1", "b", "none"],
    ],
  );
  assert.equal(root[1]!.hasCommand, true);
  assert.equal(root[1]!.contextValue, "leaf");
  assert.deepEqual(root[1]!.icon, { codicon: "star", color: undefined });
  const children = (await host.methods.treeChildren("test.tree", "/a"))!;
  assert.deepEqual(
    children.map((item) => item.handle),
    ["/a/a1"],
  );
  assert.equal(await host.methods.treeChildren("missing.view", null), null);

  // Changes are batched per tick and name the handles the view knows.
  changed.fire(a);
  changed.fire(a);
  await Promise.resolve();
  assert.deepEqual(
    posted.filter((m) => m.type === "treeChanged").map((m) => m.type === "treeChanged" && m.handles),
    [["/a"]],
  );
  changed.fire(a);
  changed.fire(undefined);
  await Promise.resolve();
  assert.deepEqual(posted.filter((m) => m.type === "treeChanged").at(-1), { type: "treeChanged", viewId: "test.tree", handles: null });

  host.handleView({ type: "treeEvent", viewId: "test.tree", event: "select", handles: ["/b"] });
  assert.deepEqual(view.selection, [b]);
  host.handleView({ type: "treeEvent", viewId: "test.tree", event: "open", handles: ["/b"] });
  host.handleView({ type: "treeCommand", viewId: "test.tree", command: "test.remove", handles: ["/b"] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(ran, [
    ["open", 42],
    ["remove", b],
  ]);

  await view.reveal(a1, { focus: true });
  assert.deepEqual(posted.at(-1), { type: "treeReveal", viewId: "test.tree", path: ["/a", "/a/a1"], select: true, focus: true, expand: false });

  view.dispose();
  assert.deepEqual(posted.at(-1), { type: "treeDispose", viewId: "test.tree" });
  assert.equal(await host.methods.treeChildren("test.tree", null), null);
});

test("a failed activation is not retried, and editors without documents are not exposed", async () => {
  const dir = temp();
  try {
    const location = join(dir, "broken");
    cpSync(join(SAMPLES, "hello-lumen"), location, { recursive: true, filter: (source) => !source.endsWith("extension.js") });
    writeFileSync(
      join(location, "package.json"),
      JSON.stringify({
        name: "broken",
        publisher: "test",
        version: "1.0.0",
        main: "./main.js",
        engines: { lumen: "^0.1.0" },
        activationEvents: ["onCommand:broken.run", "onStartupFinished"],
      }),
    );
    writeFileSync(
      join(location, "main.js"),
      `const lumen = require("lumen"); exports.activate = () => { lumen.commands.registerCommand("broken.run", () => 1); throw new Error("boom"); };`,
    );
    const host = new ExtensionHost();
    await host.start({
      extensions: [describe(location, "lumen")],
      config: { lumen: {}, user: {} },
      workspace: null,
      userData: join(dir, "userData"),
      appRoot: ROOT,
      appName: "Lumen",
      appVersion: "0.1.0",
      languages: [],
      webviewPort: 1,
      webviewToken: "t",
    });
    await host.activateByEvent("onCommand:broken.run");
    const runtime = host.runtimes.get("test.broken")!;
    assert.equal(runtime.error, "boom");
    await host.activateByEvent("onStartupFinished");
    assert.equal(runtime.error, "boom", "no second activation (it would fail with 'command already exists')");

    host.handleView({ type: "activeEditor", path: "webview:x", selections: [], visible: ["webview:x"] });
    assert.equal(host.activeEditor(), undefined);
    assert.deepEqual(host.visibleEditors(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── webview resources ──────────────────────────────────────────────────── */

test("the webview resource server only serves registered roots with its token", async () => {
  const server = new WebviewResourceServer("test.webviews");
  const port = await server.start();
  const origin = `http://127.0.0.1:${port}`;
  const media = join(SAMPLES, "hello-lumen", "media");

  // Pages are served only from their extension's origin (the Host header), with the bootstrap in front.
  const page = new URL(server.pageUrl("w1", "Pub.Ext"));
  assert.equal(page.origin, webviewOrigin("pub.ext", port));
  server.setHtml("w1", '<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"></head><body>hi</body></html>');
  const get = (path: string, host: string) =>
    new Promise<{ status: number; body: string }>((resolvePromise, reject) => {
      const request = httpRequest({ host: "127.0.0.1", port, path, headers: { Host: host } }, (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolvePromise({ status: response.statusCode ?? 0, body }));
      });
      request.on("error", reject);
      request.end();
    });
  const served = await get(page.pathname, page.host);
  assert.equal(served.status, 200);
  assert.ok(served.body.indexOf("acquireVsCodeApi") < served.body.indexOf("Content-Security-Policy"), "the bootstrap comes before the page's CSP");
  assert.equal((await get(page.pathname, `${new URL(webviewOrigin("other.ext", port)).host}`)).status, 404, "not from another extension's origin");
  assert.equal((await get(page.pathname, `127.0.0.1:${port}`)).status, 404);
  server.setRoots("w1", [media]);
  const url = (webview: string, path: string, token = server.token) =>
    `${origin}/${token}/${webview}/${path.replace(/\\/g, "/").replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/")}`;
  const css = await fetch(url("w1", join(media, "webview.css")));
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type") ?? "", /text\/css/);
  assert.match(await css.text(), /asWebviewUri/);
  assert.equal((await fetch(url("w1", join(SAMPLES, "hello-lumen", "package.json")))).status, 404, "outside the roots");
  assert.equal((await fetch(url("w2", join(media, "webview.css")))).status, 404, "another webview");
  assert.equal((await fetch(url("w1", join(media, "webview.css"), "wrong"))).status, 404, "wrong token");
  assert.equal((await fetch(`${url("w1", media)}/..%2F..%2Fpackage.json`)).status, 404, "no way out with ..");
});

/* ── the extension host, end to end ─────────────────────────────────────── */

function describe(location: string, kind: "lumen" | "vscode"): ExtensionDescription {
  const manifest = JSON.parse(readFileSync(join(location, "package.json"), "utf8"));
  return { id: `${manifest.publisher}.${manifest.name}`, manifest, location, enabled: true, kind, development: true };
}

test("the extension host runs Lumen and VS Code extensions", { timeout: 30_000 }, async () => {
  const dir = temp();
  const worker = new Worker(new URL("../src/main/index.ts", import.meta.url), { workerData: { lumenWorker: "exthost" } });
  const received: HostToView[] = [];
  const waiters: { match: (m: HostToView) => boolean; resolve: (m: HostToView) => void }[] = [];
  const calls = new Map<number, (value: { result?: unknown; error?: string }) => void>();
  let seq = 0;
  const post = (message: MainToHost) => worker.postMessage(message);
  const view = (message: ViewToHost) => post({ type: "view", message });
  const waitFor = (match: (m: HostToView) => boolean) =>
    new Promise<HostToView>((resolvePromise) => {
      const found = received.find(match);
      if (found) resolvePromise(found);
      else waiters.push({ match, resolve: resolvePromise });
    });
  const call = (method: string, args: unknown[]) =>
    new Promise<{ result?: unknown; error?: string }>((resolvePromise) => {
      const id = ++seq;
      calls.set(id, resolvePromise);
      post({ type: "call", id, method: method as never, args });
    });
  /** What the view answers to the host's requests. */
  const answers: Record<string, (...args: unknown[]) => unknown> = {
    showMessage: () => 0,
    editDocument: (path, edits) => {
      edited.push({ path: path as string, edits });
      return true;
    },
    executeCommand: () => null,
  };
  const edited: { path: string; edits: unknown }[] = [];

  worker.on("message", (message: HostToMain) => {
    if (message.type === "callResult") calls.get(message.id)?.(message);
    if (message.type !== "view") return;
    const inner = message.message;
    received.push(inner);
    for (const waiter of [...waiters]) {
      if (waiter.match(inner)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(inner);
      }
    }
    if (inner.type === "request") {
      const answer = answers[inner.method];
      view({ type: "reply", id: inner.id, result: answer ? answer(...inner.args) : null });
    }
  });

  try {
    // The VS Code sample runs in place through the compatibility layer (require("vscode")).
    const vscodeSample = join(dir, "word-tools");
    cpSync(join(SAMPLES, "vscode-word-tools"), vscodeSample, { recursive: true });
    // An ES module extension (import … from "lumen").
    const esm = join(dir, "esm-ext");
    cpSync(join(SAMPLES, "hello-lumen"), esm, { recursive: true, filter: (source) => !source.endsWith(".js") });
    writeFileSync(
      join(esm, "package.json"),
      JSON.stringify({
        name: "esm",
        publisher: "test",
        version: "1.0.0",
        type: "module",
        main: "./main.js",
        engines: { lumen: "^0.1.0" },
        activationEvents: ["onCommand:esm.hello"],
      }),
    );
    writeFileSync(
      join(esm, "main.js"),
      [
        `import * as lumen from "lumen";`,
        `import api, { Position } from "lumen";`,
        `export function activate(context) {`,
        `  context.subscriptions.push(lumen.commands.registerCommand("esm.hello", () => (api === lumen.default || api.commands === lumen.commands) && new Position(1, 2).character));`,
        `}`,
      ].join("\n"),
    );
    const init: HostInit = {
      extensions: [describe(join(SAMPLES, "hello-lumen"), "lumen"), describe(vscodeSample, "vscode"), describe(esm, "lumen")],
      config: { lumen: { "editor.tabSize": 2 }, user: { "helloLumen.greeting": "Howdy" } },
      workspace: dir,
      userData: join(dir, "userData"),
      appRoot: ROOT,
      appName: "Lumen",
      appVersion: "0.1.0",
      languages: ["markdown", "plaintext", "javascript"],
      webviewPort: 4567,
      webviewToken: "secret",
    };
    post({ type: "init", init });
    await waitFor((m) => m.type === "ready");

    const doc = join(dir, "notes.md");
    view({ type: "documentOpen", doc: { path: doc, languageId: "markdown", version: 1, text: "TODO: write docs\nLumen is fast", eol: "LF", dirty: false } });
    view({ type: "activeEditor", path: doc, selections: [{ anchorLine: 1, anchorCharacter: 0, activeLine: 1, activeCharacter: 5 }], visible: [doc] });
    view({ type: "activate", event: "onStartupFinished" });

    // hello-lumen: activation, its commands, a TODO diagnostic, a highlight, a status bar item.
    const activated = (await waitFor((m) => m.type === "activated" && m.extensionId === "lumen.hello-lumen")) as Extract<HostToView, { type: "activated" }>;
    assert.equal(activated.error, undefined);
    const diagnostics = (await waitFor((m) => m.type === "diagnostics" && m.entries.some(([, list]) => list.length > 0))) as Extract<
      HostToView,
      { type: "diagnostics" }
    >;
    assert.equal(diagnostics.entries[0]![1][0]!.message, "Something is left to do here");
    assert.equal(diagnostics.entries[0]![1][0]!.severity, "info");
    await waitFor((m) => m.type === "decorations" && m.ranges.length === 1);
    const status = (await waitFor((m) => m.type === "statusBar" && m.item.visible)) as Extract<HostToView, { type: "statusBar" }>;
    assert.match(status.item.text, /6 words/);

    // Completions: the provider and its snippet item.
    const completions = await call("provideCompletions", [doc, 1, 2, null]);
    const items = completions.result as { label: string; snippet?: boolean }[];
    assert.ok(items.some((item) => item.label === "Lumen"));
    assert.ok(items.some((item) => item.label === "signature" && item.snippet));
    // Contributed snippets for JavaScript.
    const js = join(dir, "a.js");
    view({ type: "documentOpen", doc: { path: js, languageId: "javascript", version: 1, text: "", eol: "LF", dirty: false } });
    const jsItems = (await call("provideCompletions", [js, 0, 0, null])).result as { label: string; insertText: string }[];
    assert.ok(jsItems.some((item) => item.label === "log" && item.insertText.includes("console.log")));

    // Hover counts words.
    const hover = (await call("provideHover", [doc, 1, 2])).result as { contents: string[] };
    assert.match(hover.contents[0]!, /\*\*Lumen\*\* appears 1 time/);

    // Edits flow back: the document mirror follows documentChange.
    view({
      type: "documentChange",
      path: doc,
      version: 2,
      dirty: true,
      changes: [{ startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0, rangeOffset: 0, rangeLength: 0, text: "TODO again\n" }],
    });
    const more = await waitFor((m) => m.type === "diagnostics" && m.entries.some(([, list]) => list.length === 2));
    assert.ok(more);

    // A configuration value set by the user reaches getConfiguration().
    await call("executeCommand", ["helloLumen.sayHello", []]);
    const request = received.find((m) => m.type === "request" && m.method === "showMessage") as Extract<HostToView, { type: "request" }>;
    assert.match(String(request.args[1]), /^Howdy from an extension!/);

    // The VS Code extension (implicit onCommand activation, registerTextEditorCommand).
    view({ type: "selection", path: doc, selections: [{ anchorLine: 2, anchorCharacter: 0, activeLine: 2, activeCharacter: 5 }] });
    const count = await call("executeCommand", ["wordTools.count", []]);
    assert.equal(count.error, undefined);
    assert.equal(count.result, 1, "the selection is 'Lumen'");
    await call("executeCommand", ["wordTools.reverse", []]);
    assert.equal(edited.length, 1);
    assert.deepEqual((edited[0]!.edits as { newText: string }[])[0]!.newText, "nemuL");

    // The ES module extension.
    const esmResult = await call("executeCommand", ["esm.hello", []]);
    assert.equal(esmResult.error, undefined);
    assert.equal(esmResult.result, 2);

    // Webview view: resolved when the view shows it; messages both ways; a badge.
    view({ type: "webviewViewVisible", viewId: "helloLumen.counter", webviewId: "v1", state: undefined });
    const created = (await waitFor((m) => m.type === "webviewCreate" && m.webview.id === "v1")) as Extract<HostToView, { type: "webviewCreate" }>;
    assert.equal(created.webview.kind, "view");
    const viewHtml = (await waitFor((m) => m.type === "webviewHtml" && m.id === "v1")) as Extract<HostToView, { type: "webviewHtml" }>;
    assert.match(viewHtml.html, /<h2>Counter<\/h2>/);
    const helloOrigin = webviewOrigin("lumen.hello-lumen", 4567);
    assert.ok(
      viewHtml.html.includes(`${helloOrigin}/secret/v1/`) && viewHtml.html.includes("webview.css"),
      "asWebviewUri points at the extension's webview origin",
    );
    assert.ok(viewHtml.html.includes(`style-src ${helloOrigin};`), "cspSource is that origin");
    view({ type: "webviewMessage", id: "v1", message: { type: "increment" } });
    const posted = (await waitFor((m) => m.type === "webviewPost" && m.id === "v1")) as Extract<HostToView, { type: "webviewPost" }>;
    assert.deepEqual(posted.message, { type: "count", count: 1 });
    await waitFor((m) => m.type === "webviewUpdate" && m.id === "v1" && m.badge?.value === 1);

    // Webview panel: created by a command, then one restored by its serializer.
    await call("executeCommand", ["helloLumen.openPanel", []]);
    const panel = (await waitFor((m) => m.type === "webviewCreate" && m.webview.kind === "panel")) as Extract<HostToView, { type: "webviewCreate" }>;
    assert.equal(panel.webview.viewType, "helloLumen.preview");
    assert.ok(panel.reveal, "a new panel is revealed");
    const restored = await call("deserializeWebviewPanel", ["helloLumen.preview", "r1", "Preview", { count: 5 }, null]);
    assert.equal(restored.result, true);
    const restoredHtml = (await waitFor((m) => m.type === "webviewHtml" && m.id === "r1")) as Extract<HostToView, { type: "webviewHtml" }>;
    assert.match(restoredHtml.html, /id="count">5</);
    assert.equal((await call("deserializeWebviewPanel", ["unknown.type", "r2", "x", null, null])).result, false);
    view({ type: "webviewMessage", id: "r1", message: { type: "increment", count: 6 } });
    await waitFor((m) => m.type === "webviewUpdate" && m.id === "r1" && m.title === "Preview (6)");

    // File system provider: documents of hello-memfs: read and written through the extension.
    assert.deepEqual((await call("virtualSchemes", [])).result, ["hello-memfs"]);
    const scratch = (await call("readVirtualFile", ["hello-memfs:/scratch.md"])).result as { content: string; language: string };
    assert.match(scratch.content, /^# Scratch/);
    assert.equal(scratch.language, "markdown");
    assert.equal((await call("writeVirtualFile", ["hello-memfs:/scratch.md", "changed"])).result, true);
    await waitFor((m) => m.type === "virtualFilesChanged" && m.paths.includes("hello-memfs:/scratch.md"));
    assert.equal(((await call("readVirtualFile", ["hello-memfs:/scratch.md"])).result as { content: string }).content, "changed");
    await call("executeCommand", ["helloLumen.openScratch", []]);
    const shown = received.find((m) => m.type === "request" && m.method === "showTextDocument" && m.args[0] === "hello-memfs:/scratch.md");
    assert.ok(shown, "openTextDocument + showTextDocument on the provided scheme");
    assert.match(String((await call("readVirtualFile", ["nofs:/x"])).error), /no file system provider/);

    // An unknown command is answered by the view (built-in commands).
    const builtin = await call("executeCommand", ["workbench.action.files.save", []]);
    assert.equal(builtin.error, undefined);
  } finally {
    await worker.terminate();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("language providers registered by extensions are called by the host", async () => {
  const host = new ExtensionHost();
  host.init = {
    extensions: [],
    config: { lumen: {}, user: {} },
    workspace: null,
    userData: temp(),
    appRoot: ROOT,
    appName: "Lumen",
    appVersion: "0.1.0",
    languages: [],
    webviewPort: 1,
    webviewToken: "t",
  };
  const sent: HostToMain[] = [];
  host.send = (message) => void sent.push(message);
  const api = host.apiFor(null) as any;
  const {
    languages,
    Range,
    Position,
    Location,
    Uri,
    TextEdit,
    CodeAction,
    WorkspaceEdit,
    Hover,
    FoldingRange,
    SelectionRange,
    SignatureHelp,
    SignatureInformation,
    ParameterInformation,
    InlayHint,
    DocumentHighlight,
    DocumentLink,
    Color,
    ColorInformation,
    ColorPresentation,
    CodeLens,
    InlineCompletionItem,
    LinkedEditingRanges,
    SymbolInformation,
    SymbolKind,
    SemanticTokensLegend,
    SemanticTokensBuilder,
  } = api;
  void Hover;
  const path = join(temp(), "a.txt");
  host.handleView({ type: "documentOpen", doc: { path, languageId: "plaintext", version: 1, text: "foo(bar)\nbaz\n", eol: "LF", dirty: false } });
  const here = (line: number, a: number, b: number) => new Range(line, a, line, b);
  const loc = () => new Location(Uri.file(path), new Position(1, 0));

  languages.registerTypeDefinitionProvider("plaintext", { provideTypeDefinition: () => loc() });
  languages.registerImplementationProvider("plaintext", { provideImplementation: () => [loc()] });
  languages.registerDeclarationProvider("plaintext", { provideDeclaration: () => loc() });
  languages.registerDocumentHighlightProvider("plaintext", { provideDocumentHighlights: () => [new DocumentHighlight(here(0, 0, 3), 2)] });
  languages.registerRenameProvider("plaintext", {
    prepareRename: () => here(0, 0, 3),
    provideRenameEdits: (_d: unknown, _p: unknown, name: string) => {
      const edit = new WorkspaceEdit();
      edit.replace(Uri.file(path), here(0, 0, 3), name);
      return edit;
    },
  });
  languages.registerSignatureHelpProvider(
    "plaintext",
    {
      provideSignatureHelp: () => {
        const help = new SignatureHelp();
        const signature = new SignatureInformation("foo(bar: string)", "docs");
        signature.parameters = [new ParameterInformation("bar: string")];
        help.signatures = [signature];
        return help;
      },
    },
    "(",
  );
  languages.registerFoldingRangeProvider("plaintext", { provideFoldingRanges: () => [new FoldingRange(0, 1)] });
  languages.registerSelectionRangeProvider("plaintext", {
    provideSelectionRanges: () => [new SelectionRange(here(0, 0, 3), new SelectionRange(here(0, 0, 8)))],
  });
  languages.registerInlayHintsProvider("plaintext", { provideInlayHints: () => [new InlayHint(new Position(0, 4), ": string")] });
  languages.registerDocumentLinkProvider("plaintext", { provideDocumentLinks: () => [new DocumentLink(here(1, 0, 3), Uri.parse("https://example.com"))] });
  languages.registerColorProvider("plaintext", {
    provideDocumentColors: () => [new ColorInformation(here(1, 0, 3), new Color(1, 0, 0, 1))],
    provideColorPresentations: () => [new ColorPresentation("#ff0000")],
  });
  languages.registerCodeLensProvider("plaintext", { provideCodeLenses: () => [new CodeLens(here(0, 0, 3), { title: "Run", command: "x.run" })] });
  languages.registerCodeActionsProvider("plaintext", {
    provideCodeActions: () => {
      const action = new CodeAction("Fix it");
      action.edit = new WorkspaceEdit();
      return [action];
    },
  });
  languages.registerOnTypeFormattingEditProvider("plaintext", { provideOnTypeFormattingEdits: () => [TextEdit.insert(new Position(1, 0), "  ")] }, ";");
  languages.registerInlineCompletionItemProvider("plaintext", { provideInlineCompletionItems: () => [new InlineCompletionItem("bar)")] });
  languages.registerLinkedEditingRangeProvider("plaintext", {
    provideLinkedEditingRanges: () => new LinkedEditingRanges([here(0, 0, 3), here(1, 0, 3)], /[a-z]+/iu),
  });
  languages.registerWorkspaceSymbolProvider({ provideWorkspaceSymbols: () => [new SymbolInformation("foo", SymbolKind.Function, "", loc())] });
  const legend = new SemanticTokensLegend(["function", "variable"], ["readonly"]);
  languages.registerDocumentSemanticTokensProvider(
    "plaintext",
    {
      provideDocumentSemanticTokens: () => {
        const builder = new SemanticTokensBuilder(legend);
        builder.push(0, 0, 3, 0, 0);
        builder.push(0, 4, 3, 1, 1);
        return builder.build();
      },
    },
    legend,
  );

  const m = host.methods;
  assert.equal((await m.provideTypeDefinition(path, 0, 0))[0]?.line, 1);
  assert.equal((await m.provideImplementation(path, 0, 0)).length, 1);
  assert.equal((await m.provideDeclaration(path, 0, 0)).length, 1);
  assert.equal((await m.provideDocumentHighlights(path, 0, 0)).length, 1);
  assert.ok(await m.prepareRename(path, 0, 0));
  assert.match(JSON.stringify(await m.provideRenameEdits(path, 0, 0, "qux")), /qux/);
  assert.equal((await m.provideSignatureHelp(path, 0, 4, "("))?.signatures[0]?.label, "foo(bar: string)");
  assert.deepEqual(
    (await m.provideFoldingRanges(path)).map((r) => [r.start, r.end]),
    [[0, 1]],
  );
  assert.equal((await m.provideSelectionRanges(path, [{ line: 0, character: 1 }]))[0]?.length, 2);
  assert.match(JSON.stringify(await m.provideInlayHints(path, { startLine: 0, startCharacter: 0, endLine: 2, endCharacter: 0 })), /: string/);
  assert.match(JSON.stringify(await m.provideDocumentLinks(path)), /example\.com/);
  assert.equal((await m.provideDocumentColors(path)).length, 1);
  assert.equal(
    (await m.provideColorPresentations(path, { red: 1, green: 0, blue: 0, alpha: 1 }, { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 3 }))[0]
      ?.label,
    "#ff0000",
  );
  assert.equal((await m.provideCodeLenses(path))[0]?.title, "Run");
  assert.equal((await m.provideCodeActions(path, { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0 }, []))[0]?.title, "Fix it");
  assert.equal((await m.provideOnTypeFormatting(path, 0, 8, ";", { tabSize: 2, insertSpaces: true })).length, 1);
  assert.equal((await m.provideInlineCompletions(path, 0, 4, 0))[0]?.insertText, "bar)");
  const linked = await m.provideLinkedEditingRanges(path, 0, 1);
  assert.equal(linked?.ranges.length, 2);
  assert.deepEqual(linked?.wordPattern, { source: "[a-z]+", flags: "iu" });
  assert.equal((await m.provideWorkspaceSymbols("fo"))[0]?.name, "foo");
  const tokens = await m.provideSemanticTokens(path);
  assert.deepEqual(
    tokens.map((t) => [t.character, t.type, t.modifiers]),
    [
      [0, "function", []],
      [4, "variable", ["readonly"]],
    ],
  );
});

test("inline completion lists and file decorations are accepted by the host", async () => {
  const host = new ExtensionHost();
  host.init = {
    extensions: [],
    config: { lumen: {}, user: {} },
    workspace: null,
    userData: temp(),
    appRoot: ROOT,
    appName: "Lumen",
    appVersion: "0.1.0",
    languages: [],
    webviewPort: 1,
    webviewToken: "t",
  };
  host.send = () => {};
  const api = host.apiFor(null) as any;
  const { languages, window, InlineCompletionItem, InlineCompletionList, InlineCompletionTriggerKind, FileDecoration } = api;
  const path = join(temp(), "a.txt");
  host.handleView({ type: "documentOpen", doc: { path, languageId: "plaintext", version: 1, text: "foo\n", eol: "LF", dirty: false } });

  const triggerKinds: number[] = [];
  languages.registerInlineCompletionItemProvider("plaintext", {
    provideInlineCompletionItems: (_document: unknown, _position: unknown, context: { triggerKind: number }) => {
      triggerKinds.push(context.triggerKind);
      return new InlineCompletionList([new InlineCompletionItem("bar"), new InlineCompletionItem("baz")]);
    },
  });
  assert.deepEqual(
    (await host.methods.provideInlineCompletions(path, 0, 3, 1)).map((item) => item.insertText),
    ["bar", "baz"],
  );
  assert.deepEqual(triggerKinds, [InlineCompletionTriggerKind.Automatic]);
  await host.methods.provideInlineCompletions(path, 0, 3, 0);
  assert.deepEqual(triggerKinds, [InlineCompletionTriggerKind.Automatic, InlineCompletionTriggerKind.Invoke]);

  assert.equal(InlineCompletionTriggerKind.Invoke, 0);
  assert.equal(InlineCompletionTriggerKind.Automatic, 1);

  const decoration = new FileDecoration("12");
  assert.equal(FileDecoration.validate(decoration), true);
  assert.throws(() => FileDecoration.validate(new FileDecoration("123")), /2 characters/);
  window.registerFileDecorationProvider({ provideFileDecoration: () => decoration });
  assert.equal((await host.methods.provideFileDecorations([path]))[0]?.decoration.badge, "12");
});

test("workspace and window events reach extensions", async () => {
  const host = new ExtensionHost();
  host.init = {
    extensions: [],
    config: { lumen: {}, user: {} },
    workspace: null,
    userData: temp(),
    appRoot: ROOT,
    appName: "Lumen",
    appVersion: "0.1.0",
    languages: [],
    webviewPort: 1,
    webviewToken: "t",
  };
  host.send = () => {};
  const api = host.apiFor(null) as any;
  const { workspace, window, Uri, TextEdit, Position } = api;
  const dir = temp();
  const path = join(dir, "a.txt");
  host.handleView({ type: "documentOpen", doc: { path, languageId: "plaintext", version: 1, text: "x\n", eol: "LF", dirty: false } });
  host.handleView({ type: "activeEditor", path, selections: [], visible: [path] });

  const seen: string[] = [];
  workspace.onWillCreateFiles((e: any) => seen.push(`willCreate:${e.files.length}`));
  workspace.onDidCreateFiles((e: any) => seen.push(`didCreate:${e.files[0].fsPath.endsWith("b.txt")}`));
  workspace.onWillDeleteFiles((e: any) => seen.push(`willDelete:${e.files.length}`));
  workspace.onDidDeleteFiles((e: any) => seen.push(`didDelete:${e.files.length}`));
  workspace.onWillRenameFiles((e: any) => {
    seen.push(`willRename:${e.files.length}`);
    e.waitUntil(
      Promise.resolve(
        (() => {
          const edit = new api.WorkspaceEdit();
          edit.insert(Uri.file(path), new Position(0, 0), "renamed ");
          return edit;
        })(),
      ),
    );
  });
  workspace.onDidRenameFiles((e: any) => seen.push(`didRename:${e.files[0].newUri.fsPath.endsWith("c.txt")}`));
  workspace.onWillSaveTextDocument((e: any) => e.waitUntil(Promise.resolve([TextEdit.insert(new Position(0, 0), "// ")])));
  window.onDidChangeTextEditorVisibleRanges((e: any) => seen.push(`visible:${e.visibleRanges[0].end.line}`));
  window.onDidChangeTextEditorOptions((e: any) => seen.push(`options:${e.options.tabSize}`));
  window.tabGroups.onDidChangeTabs((e: any) => seen.push(`tabs:${e.opened.length}`));

  const b = join(dir, "b.txt");
  const c = join(dir, "c.txt");
  await host.methods.willFileOperation("create", [{ path: b }]);
  host.handleView({ type: "didFileOperation", kind: "create", files: [{ path: b }] });
  const renameEdits = await host.methods.willFileOperation("rename", [{ oldPath: b, newPath: c }]);
  host.handleView({ type: "didFileOperation", kind: "rename", files: [{ oldPath: b, newPath: c }] });
  await host.methods.willFileOperation("delete", [{ path: c }]);
  host.handleView({ type: "didFileOperation", kind: "delete", files: [{ path: c }] });
  assert.match(JSON.stringify(renameEdits), /renamed /, "waitUntil edits of onWillRenameFiles come back to the view");
  assert.match(JSON.stringify(await host.methods.willSaveDocument(path, 1)), /\/\/ /);

  host.handleView({ type: "visibleRanges", path, ranges: [{ startLine: 0, startCharacter: 0, endLine: 7, endCharacter: 0 }] });
  host.handleView({ type: "options", path, options: { tabSize: 3, insertSpaces: true } } as ViewToHost);
  host.handleView({
    type: "tabs",
    groups: [
      { viewColumn: 1, isActive: true, tabs: [{ label: "a.txt", path, kind: "text", isActive: true, isDirty: false, isPinned: false, isPreview: false }] },
    ],
  });
  await new Promise((resolveTick) => setTimeout(resolveTick, 10));
  assert.equal(window.tabGroups.all.length, 1);
  assert.equal(window.tabGroups.all[0].tabs[0].label, "a.txt");
  assert.deepEqual(seen, [
    "willCreate:1",
    "didCreate:true",
    "willRename:1",
    "didRename:true",
    "willDelete:1",
    "didDelete:1",
    "visible:7",
    "options:3",
    "tabs:1",
  ]);

  // Virtual documents and file decorations.
  workspace.registerTextDocumentContentProvider("demo", { provideTextDocumentContent: (uri: any) => `content of ${uri.path}` });
  assert.match(JSON.stringify(await host.methods.readVirtualFile("demo:/x")), /content of \/x/);
  window.registerFileDecorationProvider({ provideFileDecoration: () => ({ badge: "M", tooltip: "modified" }) });
  assert.equal((await host.methods.provideFileDecorations([path]))[0]?.decoration.badge, "M");
  rmSync(dir, { recursive: true, force: true });
});

test("workspace.applyEdit runs text edits and file operations in order", async () => {
  const host = new ExtensionHost();
  host.init = {
    extensions: [],
    config: { lumen: {}, user: {} },
    workspace: null,
    userData: temp(),
    appRoot: ROOT,
    appName: "Lumen",
    appVersion: "0.1.0",
    languages: [],
    webviewPort: 1,
    webviewToken: "t",
  };
  host.send = () => {};
  host.post = () => {};
  const steps: string[] = [];
  const batches: any[] = [];
  let answer: number | null = 0;
  (host as any).requestView = async (method: string, ...args: any[]) => {
    if (method === "applyWorkspaceEdit") {
      batches.push(args[0]);
      steps.push(`edit:${args[0].map((file: any) => file.path.split(/[/\\]/).pop()).join(",")}`);
      return true;
    }
    if (method === "fileOperation") {
      steps.push(`${args[0]}:${args[1].map((file: any) => (file.path ?? `${file.oldPath}>${file.newPath}`).replace(/[^>]*[/\\]/g, "")).join(",")}`);
      return true;
    }
    if (method === "showMessage") return answer;
    throw new Error(`unexpected ${method}`);
  };
  const api = host.apiFor(null) as any;
  const { workspace, Uri, Position, Range, TextEdit, WorkspaceEdit, SnippetTextEdit, SnippetString, EndOfLine, NotebookEdit, NotebookRange } = api;
  const dir = temp();
  const file = (name: string) => Uri.file(join(dir, name));
  writeFileSync(join(dir, "a.txt"), "a\n");
  writeFileSync(join(dir, "d.txt"), "d\n");
  const events: string[] = [];
  workspace.onWillRenameFiles(() => events.push("willRename"));
  workspace.onDidRenameFiles(() => events.push("didRename"));
  workspace.onDidCreateFiles(() => events.push("didCreate"));
  workspace.onDidDeleteFiles(() => events.push("didDelete"));

  // Edit a.txt, move it to b.txt and edit that, create c.txt (with contents) and fill it with a snippet, delete d.txt.
  const edit = new WorkspaceEdit();
  edit.insert(file("a.txt"), new Position(0, 0), "1");
  edit.renameFile(file("a.txt"), file("b.txt"));
  edit.set(file("b.txt"), [[TextEdit.insert(new Position(0, 0), "2"), { needsConfirmation: false, label: "b" }], TextEdit.setEndOfLine(EndOfLine.CRLF)]);
  edit.createFile(file("c.txt"), { contents: { data: async () => new TextEncoder().encode("c") } });
  edit.set(file("c.txt"), [SnippetTextEdit.insert(new Position(0, 1), new SnippetString("x${1:y}"))]);
  edit.deleteFile(file("d.txt"));
  assert.equal(edit.has(file("c.txt")), true);
  assert.equal(await workspace.applyEdit(edit, { isRefactoring: true }), true);
  assert.deepEqual(steps, ["edit:a.txt", "rename:a.txt>b.txt", "edit:b.txt", "create:c.txt", "edit:c.txt", "delete:d.txt"]);
  assert.deepEqual(events, ["willRename", "didRename", "didCreate", "didDelete"]);
  assert.equal(batches[1][0].eol, "CRLF");
  assert.deepEqual(
    batches[1][0].edits.map((e: any) => e.newText),
    ["2"],
    "a pure setEndOfLine edit changes no text",
  );
  assert.deepEqual(batches[2][0].edits[0], { startLine: 0, startCharacter: 1, endLine: 0, endCharacter: 1, newText: "x${1:y}", snippet: true });
  assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), "a\n");
  assert.equal(readFileSync(join(dir, "c.txt"), "utf8"), "c");
  assert.throws(() => readFileSync(join(dir, "d.txt")));

  // A failing step stops the edit: nothing after it runs.
  steps.length = 0;
  const failing = new WorkspaceEdit();
  failing.createFile(file("b.txt"));
  failing.insert(file("b.txt"), new Position(0, 0), "never");
  assert.equal(await workspace.applyEdit(failing), false);
  assert.deepEqual(steps, []);
  const ignored = new WorkspaceEdit();
  ignored.createFile(file("b.txt"), { ignoreIfExists: true });
  ignored.deleteFile(file("missing.txt"), { ignoreIfNotExists: true });
  ignored.renameFile(file("c.txt"), file("b.txt"), { ignoreIfExists: true });
  assert.equal(await workspace.applyEdit(ignored), true);
  assert.deepEqual(steps, []);
  const missing = new WorkspaceEdit();
  missing.replace(file("nowhere.txt"), new Range(0, 0, 0, 0), "x");
  assert.equal(await workspace.applyEdit(missing), false, "text edits need an existing file");

  // overwrite replaces the target; a folder is only removed with recursive.
  const overwrite = new WorkspaceEdit();
  overwrite.renameFile(file("c.txt"), file("b.txt"), { overwrite: true });
  assert.equal(await workspace.applyEdit(overwrite), true);
  assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), "c");
  mkdirSync(join(dir, "folder"));
  writeFileSync(join(dir, "folder", "x.txt"), "");
  const folder = new WorkspaceEdit();
  folder.deleteFile(file("folder"));
  assert.equal(await workspace.applyEdit(folder), false);
  folder.deleteFile(file("folder"), { recursive: true });
  folder._entries.shift();
  assert.equal(await workspace.applyEdit(folder), true);

  // Entries that need confirmation are confirmed first; declining applies nothing.
  steps.length = 0;
  const confirm = new WorkspaceEdit();
  confirm.insert(file("b.txt"), new Position(0, 0), "?", { needsConfirmation: true, label: "Add a question mark" });
  answer = null;
  assert.equal(await workspace.applyEdit(confirm), false);
  answer = 0;
  assert.equal(await workspace.applyEdit(confirm), true);
  assert.deepEqual(steps, ["edit:b.txt"]);

  // A notebook edit of a notebook that cannot be opened (the file does not exist) fails.
  const notebook = new WorkspaceEdit();
  notebook.set(file("n.ipynb"), [NotebookEdit.deleteCells(new NotebookRange(0, 1))]);
  assert.equal(await workspace.applyEdit(notebook), false);
  rmSync(dir, { recursive: true, force: true });
});

test("contributes.languages associates files by name, pattern, extension and first line", () => {
  setContributedLanguages([
    { id: "dotted", extensions: [".ts"] },
    { id: "declarations", extensions: [".d.ts"] },
    { id: "named", filenames: ["Jakefile"] },
    { id: "ci", filenamePatterns: ["**/.ci/*.conf", "*.pipeline"] },
    { id: "nodescript", firstLine: "^#!.*\\bnode\\b" },
    { id: "broken", firstLine: "(" },
  ]);
  try {
    assert.equal(detectLanguage("/p/types.d.ts"), "declarations", "the longest extension wins");
    assert.equal(detectLanguage("/p/main.ts"), "dotted");
    assert.equal(detectLanguage("/p/jakefile"), "named");
    assert.equal(detectLanguage("/p/.ci/build.conf"), "ci");
    assert.equal(detectLanguage("/p/other/build.conf"), "plaintext");
    assert.equal(detectLanguage("C:\\p\\Deploy.Pipeline"), "ci");
    assert.equal(detectLanguage("/p/bin/run", firstLineOf("#!/usr/bin/env node\nconsole.log(1)")), "nodescript");
    assert.equal(detectLanguage("/p/bin/run", "#!/bin/sh"), "plaintext");
    assert.equal(detectLanguage("/p/notes.md", "#!/usr/bin/env node"), "markdown", "firstLine only claims files nothing else does");
  } finally {
    setContributedLanguages([]);
  }
});

test("contributes.themes loads VS Code color themes with includes and .tmTheme token colors", async () => {
  const dir = temp();
  mkdirSync(join(dir, "themes"));
  writeFileSync(
    join(dir, "themes", "base.json"),
    `{
      // comments and trailing commas, like VS Code's own themes
      "colors": { "editor.background": "#101010", "sideBar.background": "#202020", },
      "tokenColors": [{ "scope": "comment", "settings": { "foreground": "#808080" } }],
    }`,
  );
  writeFileSync(
    join(dir, "themes", "night.json"),
    JSON.stringify({
      include: "./base.json",
      colors: { "editor.background": "#000000" },
      tokenColors: [{ scope: ["string", "keyword.control"], settings: { foreground: "#ff0000", fontStyle: "italic" } }],
      semanticHighlighting: true,
      semanticTokenColors: { "variable.readonly": "#00ff00" },
    }),
  );
  writeFileSync(join(dir, "themes", "paper.json"), JSON.stringify({ tokenColors: "./paper.tmTheme" }));
  writeFileSync(
    join(dir, "themes", "paper.tmTheme"),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>settings</key><array>
      <dict><key>settings</key><dict><key>background</key><string>#fdf6e3</string><key>caret</key><string>#111111</string></dict></dict>
      <dict><key>scope</key><string>keyword</string><key>settings</key><dict><key>foreground</key><string>#859900</string></dict></dict>
    </array></dict></plist>`,
  );
  writeFileSync(join(dir, "themes", "loop.json"), JSON.stringify({ include: "./loop.json" }));
  const extension = {
    id: "test.themes",
    location: dir,
    manifest: {
      name: "themes",
      version: "1.0.0",
      contributes: {
        themes: [
          { id: "night", label: "Night", uiTheme: "vs-dark", path: "./themes/night.json" },
          { label: "Paper", uiTheme: "vs", path: "./themes/paper.json" },
          { label: "Loop", uiTheme: "hc-black", path: "./themes/loop.json" },
          { label: "Outside", uiTheme: "vs", path: "../elsewhere.json" },
        ],
      },
    },
  } as unknown as ExtensionDescription;
  try {
    const themes = contributedThemes([extension]);
    assert.deepEqual(
      themes.map((theme) => [theme.id, theme.kind]),
      [
        ["night", "dark"],
        ["Paper", "light"],
        ["Loop", "hcDark"],
      ],
      "paths outside the extension are ignored",
    );

    const night = await loadColorTheme(themes[0]!, dir);
    assert.equal(night.colors["editor.background"], "#000000", "the theme's own colors win over its include");
    assert.equal(night.colors["sideBar.background"], "#202020");
    assert.deepEqual(
      night.tokenColors.map((rule) => rule.settings.foreground),
      ["#808080", "#ff0000"],
    );
    assert.equal(night.semanticHighlighting, true);
    assert.deepEqual(night.semanticTokenColors, { "variable.readonly": "#00ff00" });

    const paper = await loadColorTheme(themes[1]!, dir);
    assert.equal(paper.colors["editor.background"], "#fdf6e3", "a .tmTheme's global settings become workbench colors");
    assert.equal(paper.colors["editorCursor.foreground"], "#111111");
    assert.equal(matchTokenStyle(compileTokenRules(paper.tokenColors), ["source.ts", "keyword.control.ts"]).foreground, "#859900");

    await assert.rejects(loadColorTheme(themes[2]!, dir), /includes itself/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("color themes resolve workbench colors and match TextMate scopes like VS Code", () => {
  const dark = resolveThemeColors("dark", { "titleBar.activeBackground": "#111111", "my.extension.color": "#123456" });
  assert.equal(dark["editor.background"], "#1a1a1d", "Lumen Dark's defaults fill what the theme leaves out");
  assert.equal(dark["activityBar.background"], "#111111", "references follow the theme's colors");
  assert.equal(dark["my.extension.color"], "#123456", "colors only the theme knows are kept");
  assert.equal(resolveThemeColors("light", {})["editor.background"], "#ffffff");
  assert.equal(resolveThemeColors("hcLight", {})["editor.foreground"], "#000000");
  assert.equal(kindOfUiTheme("vs"), "light");
  assert.equal(kindOfUiTheme("hc-light"), "hcLight");

  const rules = compileTokenRules([
    { settings: { foreground: "#eeeeee" } },
    { scope: "string", settings: { foreground: "#a" } },
    { scope: "string.quoted.double", settings: { foreground: "#b" } },
    { scope: "meta.embedded string", settings: { foreground: "#c" } },
    { scope: "comment", settings: { foreground: "#d", fontStyle: "italic" } },
    { scope: "comment.line -source.python", settings: { foreground: "#e" } },
    { scope: "keyword, storage.type", settings: { foreground: "#f", fontStyle: "bold" } },
    { scope: "keyword.control", settings: { foreground: "#g" } },
  ]);
  const style = (...scopes: string[]) => matchTokenStyle(rules, scopes);
  assert.equal(style("source.js", "string.quoted.single.js").foreground, "#a");
  assert.equal(style("source.js", "string.quoted.double.js").foreground, "#b", "the more specific selector wins");
  assert.equal(
    style("source.html", "meta.embedded.block", "string.quoted.single.js").foreground,
    "#c",
    "a matching parent path wins over the same scope alone",
  );
  assert.equal(
    style("source.html", "meta.embedded.block", "string.quoted.double.js").foreground,
    "#b",
    "a more specific scope wins over a parent path (as in vscode-textmate)",
  );
  assert.deepEqual(
    style("source.js", "comment.line.double-slash.js"),
    { foreground: "#e", fontStyle: "italic" },
    "foreground and font style are chosen separately",
  );
  assert.equal(style("source.python", "comment.line.number-sign.python").foreground, "#d", "excluded scopes do not match");
  assert.deepEqual(style("source.ts", "keyword.control.flow.ts"), { foreground: "#g", fontStyle: "bold" });
  assert.equal(style("source.ts", "storage.type.ts").foreground, "#f");
  assert.deepEqual(
    style("source.ts", "variable.other.ts"),
    { foreground: undefined, fontStyle: undefined },
    "the scope-less rule is the default text color, not a match",
  );
});

test("contributes.jsonValidation validates, completes and describes JSON with the schema", async () => {
  const dir = temp();
  mkdirSync(join(dir, "schemas"));
  writeFileSync(
    join(dir, "schemas", "lumen.json"),
    JSON.stringify({
      type: "object",
      properties: { name: { type: "string", markdownDescription: "The **name**." }, size: { type: "number", enum: [1, 2] } },
      required: ["name"],
      additionalProperties: false,
    }),
  );
  const extension = {
    id: "test.schemas",
    location: dir,
    manifest: {
      name: "schemas",
      version: "1.0.0",
      contributes: {
        jsonValidation: [
          { fileMatch: ["lumen.json", "!skip/lumen.json"], url: "./schemas/lumen.json" },
          { fileMatch: "*.remote.json", url: "https://example.com/s.json" },
          { url: "./x.json" },
        ],
      },
    },
  } as unknown as ExtensionDescription;
  const associations = jsonSchemaAssociations(extension);
  assert.deepEqual(
    associations.map((a) => a.fileMatch),
    [["/lumen.json", "!skip/lumen.json"], ["/*.remote.json"]],
  );
  assert.match(associations[0]!.url, /^file:\/\/.*\/schemas\/lumen\.json$/);
  assert.equal(associations[1]!.url, "https://example.com/s.json");
  setJsonSchemas([associations[0]!]);
  try {
    const file = join(dir, "app", "lumen.json");
    const messages = (await jsonDiagnostics(file, '{ "size": 3, "extra": true }')).map((d) => d.message).join("\n");
    assert.match(messages, /Missing property "name"/);
    assert.match(messages, /Value is not accepted/);
    assert.match(messages, /Property extra is not allowed/);
    assert.deepEqual(await jsonDiagnostics(join(dir, "skip", "lumen.json"), '{ "extra": true }'), [], "negated patterns exclude files");
    assert.deepEqual(await jsonDiagnostics(join(dir, "other.json"), '{ "extra": true }'), []);
    // Syntax: comments are errors in .json, allowed in JSON with comments.
    assert.match((await jsonDiagnostics(join(dir, "other.json"), "{ // c\n}")).map((d) => d.message).join(), /Comments are not permitted/);
    assert.deepEqual(await jsonDiagnostics(join(dir, "tsconfig.json"), '{ // c\n "a": 1, }'), []);
    assert.equal((await jsonDiagnostics(join(dir, "broken.json"), "{ ")).length > 0, true);

    const completions = await jsonCompletions(file, "{ \n}", 0, 2);
    const name = completions.find((item) => item.label === "name");
    assert.ok(name, "schema properties are offered");
    assert.equal(name.snippet, true);
    assert.match(name.insertText, /^"name": "\$1"/);
    assert.equal(name.kind, "property");
    const values = await jsonCompletions(file, '{ "size":  }', 0, 10);
    assert.deepEqual(values.map((item) => item.label).sort(), ["1", "2"]);
    const hover = await jsonHover(file, '{ "name": "x" }', 0, 4);
    assert.match(hover?.contents ?? "", /The \*\*name\*\*\./);
  } finally {
    setJsonSchemas([]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quick input buttons, tree drag and drop / tooltips and language configurations work", async () => {
  const host = new ExtensionHost();
  host.init = {
    extensions: [],
    config: { lumen: {}, user: {} },
    workspace: null,
    userData: temp(),
    appRoot: ROOT,
    appName: "Lumen",
    appVersion: "0.1.0",
    languages: [],
    webviewPort: 1,
    webviewToken: "t",
  };
  const posted: HostToView[] = [];
  host.post = (message) => void posted.push(message);
  const api = host.apiFor(null) as any;
  const { window, languages, ThemeIcon, QuickInputButtons, TreeItem, MarkdownString, DataTransferItem } = api;

  // Quick pick buttons fire with the extension's own objects.
  const pick = window.createQuickPick();
  const gear = { iconPath: new ThemeIcon("gear"), tooltip: "Settings" };
  pick.buttons = [QuickInputButtons.Back, gear];
  pick.items = [{ label: "one", buttons: [gear] }];
  const triggered: unknown[] = [];
  pick.onDidTriggerButton((button: unknown) => triggered.push(button));
  pick.onDidTriggerItemButton((event: { button: unknown; item: { label: string } }) => triggered.push(event.item.label, event.button));
  pick.show();
  await new Promise((resolveTick) => setTimeout(resolveTick, 10));
  const update = posted.findLast((m) => m.type === "quickPickUpdate") as any;
  assert.ok(update, "the quick pick is shown");
  assert.equal(update.pick.buttons.length, 2);
  host.handleView({ type: "quickPickEvent", id: update.pick.id, event: "button", index: 1 });
  host.handleView({ type: "quickPickEvent", id: update.pick.id, event: "itemButton", items: [0], index: 0 });
  assert.deepEqual(triggered, [gear, "one", gear]);

  // Tree views: markdown tooltips resolved lazily, drag and drop through the controller.
  const dropped: string[] = [];
  window.createTreeView("test.dnd", {
    treeDataProvider: {
      getChildren: (node?: string) => (node ? [] : ["a", "b"]),
      getTreeItem: (node: string) => new TreeItem(node, 0),
      resolveTreeItem: (item: any) => {
        item.tooltip = new MarkdownString("**bold**");
        return item;
      },
    },
    dragAndDropController: {
      dragMimeTypes: ["application/x-test"],
      dropMimeTypes: ["application/vnd.code.tree.test.dnd"],
      handleDrag: (source: string[], data: any) => data.set("application/x-test", new DataTransferItem(source.join(","))),
      handleDrop: async (target: string | undefined, data: any) => {
        dropped.push(`${target}:${await data.get("application/x-test")?.asString()}`);
      },
    },
  });
  const items = (await host.methods.treeChildren("test.dnd", null))!;
  assert.match(JSON.stringify(await host.methods.resolveTreeItem("test.dnd", items[0]!.handle)), /\*\*bold\*\*/);
  const dragId = await host.methods.treeDrag("test.dnd", [items[0]!.handle]);
  assert.ok(dragId);
  assert.equal(await host.methods.treeDrop("test.dnd", items[1]!.handle, dragId, undefined), true);
  assert.deepEqual(dropped, ["b:a"]);

  // Language configurations reach the view; disposing removes them.
  const configuration = languages.setLanguageConfiguration("demo", { comments: { lineComment: "#" }, brackets: [["(", ")"]] });
  const sentConfig = posted.findLast((m) => m.type === "languageConfiguration") as any;
  assert.equal(sentConfig.languageId, "demo");
  assert.equal(sentConfig.config.comments.lineComment, "#");
  configuration.dispose();
  assert.equal((posted.findLast((m) => m.type === "languageConfiguration") as any).config, null);
});

/* ── custom editors (window.registerCustomEditorProvider) ───────────────── */

function customEditorManifest() {
  return {
    name: "custo",
    publisher: "test",
    version: "1.0.0",
    main: "./main.js",
    engines: { lumen: "^0.1.0" },
    contributes: {
      customEditors: [
        { viewType: "pdf.preview", displayName: "PDF Preview", selector: [{ filenamePattern: "*.pdf" }], priority: "default" },
        { viewType: "test.text", displayName: "Text Custom Editor", selector: [{ filenamePattern: "*.txt" }], priority: "default" },
        { viewType: "test.editable", displayName: "Editable Custom Editor", selector: [{ filenamePattern: "*.bin" }], priority: "default" },
        { viewType: "test.option", displayName: "Option Editor", selector: [{ filenamePattern: "*.txt" }], priority: "option" },
      ],
    },
  };
}

const CUSTOM_EDITOR_MAIN = [
  `const lumen = require("lumen");`,
  `const changes = new lumen.EventEmitter();`,
  `let customDocument;`,
  `const state = { saved: 0, reverted: 0 };`,
  `exports.activate = () => {`,
  `  lumen.window.registerCustomEditorProvider("test.text", {`,
  `    resolveCustomTextEditor(document, panel) { panel.webview.html = "<p>" + document.getText() + "</p>"; },`,
  `  }, { webviewOptions: { retainContextWhenHidden: true } });`,
  `  lumen.window.registerCustomEditorProvider("test.editable", {`,
  `    openCustomDocument(uri) { customDocument = { uri, dispose() { exports.disposed = true; } }; return customDocument; },`,
  `    resolveCustomEditor(document, panel) { panel.webview.html = "<p>editable</p>"; },`,
  `    onDidChangeCustomDocument: changes.event,`,
  `    saveCustomDocument() { state.saved++; },`,
  `    saveCustomDocumentAs() { state.saved++; },`,
  `    revertCustomDocument() { state.reverted++; },`,
  `    backupCustomDocument() { return "backup"; },`,
  `  });`,
  `  lumen.commands.registerCommand("test.editable.edit", () => {`,
  `    changes.fire({ document: customDocument, undo() { exports.undone = true; }, redo() { exports.redone = true; } });`,
  `  });`,
  `  lumen.commands.registerCommand("test.editable.state", () => ({ ...state }));`,
  `  lumen.commands.registerCommand("test.openWith", (path) => lumen.commands.executeCommand("vscode.openWith", lumen.Uri.file(path), "test.editable"));`,
  `};`,
].join("\n");

test("a file matching a default-priority selector opens with its custom editor", () => {
  const host = new ExtensionHost();
  host.init = {
    extensions: [],
    config: { lumen: {}, user: {} },
    workspace: null,
    userData: temp(),
    appRoot: ROOT,
    appName: "Lumen",
    appVersion: "0.1.0",
    languages: [],
    webviewPort: 1,
    webviewToken: "t",
  };
  const runtime = {
    id: "test.custo",
    description: { id: "test.custo", manifest: customEditorManifest(), location: ROOT, enabled: true, kind: "lumen", development: true },
    api: null,
    activated: true,
    activating: null,
    exports: undefined,
    module: null,
    context: null,
    activationEvents: [],
  } as unknown as ExtensionRuntime;
  host.runtimes.set("test.custo", runtime);

  assert.equal(host.customEditors.defaultEditorFor("C:\\docs\\a.pdf", "plaintext")?.viewType, "pdf.preview");
  assert.equal(host.customEditors.defaultEditorFor("C:\\notes\\a.bin", "plaintext")?.viewType, "test.editable");
  assert.equal(host.customEditors.defaultEditorFor("C:\\notes\\a.txt", "plaintext")?.viewType, "test.text");
  // "option" priority editors are only reachable through Reopen Editor With.
  assert.deepEqual(
    host.customEditors.contributionsFor("C:\\notes\\a.txt", "plaintext").map((entry) => entry.viewType),
    ["test.text", "test.option"],
  );
  assert.equal(host.customEditors.defaultEditorFor("C:\\notes\\a.md", "markdown"), undefined);
});

test("custom editors: text and editable providers, dirty / save and vscode.openWith", { timeout: 30_000 }, async () => {
  const dir = temp();
  const worker = new Worker(new URL("../src/main/index.ts", import.meta.url), { workerData: { lumenWorker: "exthost" } });
  const received: HostToView[] = [];
  const waiters: { match: (m: HostToView) => boolean; resolve: (m: HostToView) => void }[] = [];
  const calls = new Map<number, (value: { result?: unknown; error?: string }) => void>();
  let seq = 0;
  const post = (message: MainToHost) => worker.postMessage(message);
  const view = (message: ViewToHost) => post({ type: "view", message });
  const waitFor = (match: (m: HostToView) => boolean) =>
    new Promise<HostToView>((resolve) => {
      const found = received.find(match);
      if (found) resolve(found);
      else waiters.push({ match, resolve });
    });
  const call = (method: string, args: unknown[]) =>
    new Promise<{ result?: unknown; error?: string }>((resolve) => {
      const id = ++seq;
      calls.set(id, resolve);
      post({ type: "call", id, method: method as never, args });
    });

  worker.on("message", (message: HostToMain) => {
    if (message.type === "callResult") calls.get(message.id)?.(message);
    if (message.type !== "view") return;
    const inner = message.message;
    received.push(inner);
    for (const waiter of [...waiters]) {
      if (waiter.match(inner)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(inner);
      }
    }
  });

  try {
    const location = join(dir, "custo");
    mkdirSync(location, { recursive: true });
    writeFileSync(join(location, "package.json"), JSON.stringify(customEditorManifest()));
    writeFileSync(join(location, "main.js"), CUSTOM_EDITOR_MAIN);
    const textFile = join(dir, "notes.txt");
    writeFileSync(textFile, "hello custom editor");
    const binFile = join(dir, "data.bin");
    writeFileSync(binFile, "abc");

    post({
      type: "init",
      init: {
        extensions: [describe(location, "lumen")],
        config: { lumen: {}, user: {} },
        workspace: dir,
        userData: join(dir, "userData"),
        appRoot: ROOT,
        appName: "Lumen",
        appVersion: "0.1.0",
        languages: ["plaintext"],
        webviewPort: 1,
        webviewToken: "t",
      },
    });
    await waitFor((m) => m.type === "ready");

    // (a) CustomTextEditorProvider: the file's TextDocument and a panel whose html can be set.
    const textOpened = await call("openCustomEditor", [textFile, "test.text", {}]);
    assert.equal(textOpened.error, undefined);
    const textInfo = textOpened.result as { id: string; kind: string };
    assert.equal(textInfo.kind, "text");
    const textPanel = (await waitFor((m) => m.type === "webviewCreate" && m.webview.id === textInfo.id)) as Extract<HostToView, { type: "webviewCreate" }>;
    assert.equal(textPanel.webview.viewType, "test.text");
    assert.equal(textPanel.webview.uri!.toLowerCase(), textFile.toLowerCase());
    assert.equal(textPanel.webview.customKind, "text");
    assert.equal(textPanel.webview.dirty, false);
    const textHtml = (await waitFor((m) => m.type === "webviewHtml" && m.id === textInfo.id)) as Extract<HostToView, { type: "webviewHtml" }>;
    assert.match(textHtml.html, /hello custom editor/);

    // (b) CustomEditorProvider: onDidChangeCustomDocument marks dirty, save calls saveCustomDocument.
    const binOpened = await call("openCustomEditor", [binFile, "test.editable", {}]);
    const binInfo = binOpened.result as { id: string; kind: string };
    assert.equal(binInfo.kind, "editable");
    await waitFor((m) => m.type === "webviewCreate" && m.webview.id === binInfo.id);
    await waitFor((m) => m.type === "webviewHtml" && m.id === binInfo.id);
    view({ type: "executeCommand", command: "test.editable.edit", args: [] });
    await waitFor((m) => m.type === "webviewUpdate" && m.id === binInfo.id && m.dirty === true);
    const saved = await call("saveCustomEditor", [binFile, "test.editable"]);
    assert.equal(saved.result, true);
    await waitFor((m) => m.type === "webviewUpdate" && m.id === binInfo.id && m.dirty === false);
    const state = await call("executeCommand", ["test.editable.state", []]);
    assert.match(JSON.stringify(state.result), /"saved":1/);
    const reverted = await call("revertCustomEditor", [binFile, "test.editable"]);
    assert.equal(reverted.result, true);

    // (c) vscode.openWith routes to the provider.
    const other = join(dir, "other.bin");
    writeFileSync(other, "x");
    view({ type: "executeCommand", command: "test.openWith", args: [other] });
    const opened = (await waitFor((m) => m.type === "webviewCreate" && (m.webview.uri ?? "").toLowerCase() === other.toLowerCase())) as Extract<
      HostToView,
      { type: "webviewCreate" }
    >;
    assert.equal(opened.webview.viewType, "test.editable");
  } finally {
    await worker.terminate();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extensions see worker_threads as on a main thread (bundles with worker code stay quiet)", { timeout: 30_000 }, async () => {
  const dir = temp();
  const worker = new Worker(new URL("../src/main/index.ts", import.meta.url), { workerData: { lumenWorker: "exthost" } });
  const messages: unknown[] = [];
  const calls = new Map<number, (value: { result?: unknown; error?: string }) => void>();
  let ready: () => void = () => {};
  const readyPromise = new Promise<void>((resolvePromise) => (ready = resolvePromise));
  worker.on("message", (message: HostToMain) => {
    messages.push(message);
    if (message?.type === "callResult") calls.get(message.id)?.(message);
    if (message?.type === "view" && message.message.type === "ready") ready();
  });
  const call = (method: string, args: unknown[]) =>
    new Promise<{ result?: unknown; error?: string }>((resolvePromise) => {
      const id = calls.size + 1;
      calls.set(id, resolvePromise);
      worker.postMessage({ type: "call", id, method, args } as MainToHost);
    });
  try {
    const location = join(dir, "wt");
    mkdirSync(location, { recursive: true });
    writeFileSync(
      join(location, "package.json"),
      JSON.stringify({ name: "wt", publisher: "test", version: "1.0.0", main: "./main.js", engines: { vscode: "^1.90.0" }, activationEvents: ["*"] }),
    );
    writeFileSync(
      join(location, "main.js"),
      [
        `const wt = require("worker_threads");`,
        `const vscode = require("vscode");`,
        // What js-debug's bundle does at load time: worker-side code that answers on parentPort.
        `wt.parentPort && wt.parentPort.on("message", () => wt.parentPort.postMessage(undefined));`,
        `wt.isMainThread || wt.parentPort?.postMessage(wt.workerData);`,
        `exports.activate = () => vscode.commands.registerCommand("wt.info", () => ({ isMainThread: wt.isMainThread, parentPort: wt.parentPort, workerData: wt.workerData ?? null, hasWorker: typeof wt.Worker === "function" }));`,
      ].join("\n"),
    );
    worker.postMessage({
      type: "init",
      init: {
        extensions: [describe(location, "vscode")],
        config: { lumen: {}, user: {} },
        workspace: dir,
        userData: join(dir, "userData"),
        appRoot: ROOT,
        appName: "Lumen",
        appVersion: "0.1.0",
        languages: ["plaintext"],
        webviewPort: 1,
        webviewToken: "t",
      },
    } as MainToHost);
    await readyPromise;
    const info = await call("executeCommand", ["wt.info", []]);
    assert.deepEqual(info.result, { isMainThread: true, parentPort: null, workerData: null, hasWorker: true });
    // The host's own messages were not answered by the extension.
    assert.deepEqual(
      messages.filter((message) => !message || typeof message !== "object"),
      [],
    );
  } finally {
    await worker.terminate();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refreshing a stored report recomputes the manifest warnings", () => {
  const manifest = {
    name: "dbg",
    publisher: "test",
    version: "1.0.0",
    engines: { vscode: "^1.90.0", lumen: "^0.1.0" },
    activationEvents: ["onDebugResolve:node", "onUri"],
  };
  const stale = {
    transpilerVersion: 1,
    rewrittenImports: 1,
    filesScanned: 1,
    filesRewritten: 1,
    apis: [],
    contributions: [],
    warnings: ["Activation event “onDebugResolve:node” is never raised by Lumen.", "The entry point ./out/main.js is missing from the package."],
    level: "partial" as const,
  };
  const report = refreshReport(stale, manifest);
  // Lumen raises debug activation events now; onUri still is not; code-scan warnings stay.
  assert.deepEqual(report.warnings, ["Activation event “onUri” is never raised by Lumen.", "The entry point ./out/main.js is missing from the package."]);
});

test("getConfiguration() without a section shows every setting as a nested tree, like VS Code", () => {
  const host = new ExtensionHost();
  host.init = {
    extensions: [],
    config: { lumen: {}, user: {} },
    workspace: null,
    userData: temp(),
    appRoot: ROOT,
    appName: "Lumen",
    appVersion: "0.1.0",
    languages: [],
    webviewPort: 1,
    webviewToken: "t",
  };
  host.configDefaults = { "vsicons.associations.files": [], "vsicons.associations.folders": [], "vsicons.dontShowNewVersionMessage": false };
  host.config = {
    lumen: { "editor.tabSize": 4 },
    user: { "vsicons.associations.files": [{ icon: "js", extensions: ["mjs"] }], "[python]": { "editor.tabSize": 2 } },
  };
  const api = host.apiFor(null) as any;
  // vscode-icons reads workspace.getConfiguration()["vsicons"].associations.files.
  const root = api.workspace.getConfiguration();
  assert.deepEqual(root.vsicons.associations.files, [{ icon: "js", extensions: ["mjs"] }]);
  assert.deepEqual(root.vsicons.associations.folders, []);
  assert.equal(root.vsicons.dontShowNewVersionMessage, false);
  assert.equal(root.editor.tabSize, 4);
  assert.deepEqual(root["[python]"], { "editor.tabSize": 2 });
  assert.equal(typeof root.get, "function");
  assert.equal(root.get("vsicons.dontShowNewVersionMessage"), false);
  // The tree is a copy: changing it does not change the settings.
  root.vsicons.associations.files.push({ icon: "x" });
  assert.equal(api.workspace.getConfiguration("vsicons").associations.files.length, 1);
});
