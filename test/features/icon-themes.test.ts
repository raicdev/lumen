import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ExtensionHost } from "../../src/main/exthost/host.ts";
import { fontCharacterOf, iconIdFor, normalizeFileIconTheme, normalizeProductIconTheme } from "../../src/shared/icon-themes.ts";

/**
 * File / product icon themes: normalization and lookup (shared) and the host
 * side that reads theme files and their assets.
 *
 *   node --test test/features/icon-themes.test.ts
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const identity = (path: string) => `/ext/${path}`;

const THEME = {
  iconDefinitions: {
    _file: { iconPath: "./i/file.svg" },
    _folder: { iconPath: "./i/folder.svg" },
    _folder_open: { iconPath: "./i/folder-open.svg" },
    _ts: { iconPath: "./i/ts.svg" },
    _test: { iconPath: "./i/test.svg" },
    _light_ts: { iconPath: "./i/ts-light.svg" },
    _lock: { fontCharacter: "\\E001", fontColor: "#f00", fontId: "f" },
    _src: { iconPath: "./i/src.svg" },
    _json: { iconPath: "./i/json.svg" },
  },
  fonts: [{ id: "f", src: [{ path: "./f.woff", format: "woff" }], size: "90%" }],
  file: "_file",
  folder: "_folder",
  folderExpanded: "_folder_open",
  fileExtensions: { TS: "_ts", "test.ts": "_test" },
  fileNames: { "package-lock.json": "_lock" },
  folderNames: { src: "_src" },
  languageIds: { json: "_json" },
  light: { fileExtensions: { ts: "_light_ts" }, file: "_file" },
};

test("normalizes a file icon theme: lowercase keys, resolved paths, fonts", () => {
  const theme = normalizeFileIconTheme(THEME, identity);
  assert.equal(theme.iconDefinitions._ts!.path, "/ext/./i/ts.svg");
  assert.equal(theme.iconDefinitions._lock!.fontCharacter, "\\E001");
  assert.deepEqual(Object.keys(theme.fileExtensions!), ["ts", "test.ts"]);
  assert.equal(theme.fonts[0]!.src[0]!.path, "/ext/./f.woff");
  // Paths outside the extension are rejected by the resolver and the definition is dropped.
  const rejected = normalizeFileIconTheme(THEME, () => undefined);
  assert.equal(rejected.iconDefinitions._ts, undefined);
  assert.equal(rejected.iconDefinitions._lock!.fontId, "f");
  assert.equal(rejected.fonts.length, 0);
  assert.throws(() => normalizeFileIconTheme(null, identity));
});

test("looks up icons by file name, longest extension, language and defaults", () => {
  const theme = normalizeFileIconTheme(THEME, identity);
  const file = (name: string, languageId?: string, scheme?: "dark" | "light") => iconIdFor(theme, { kind: "file", name, languageId }, scheme);
  assert.equal(file("Package-Lock.json"), "_lock");
  assert.equal(file("a.ts"), "_ts");
  assert.equal(file("a.test.ts"), "_test");
  assert.equal(file("x.y.TS"), "_ts");
  assert.equal(file("data.json", "json"), "_json");
  assert.equal(file("README"), "_file");
  // The light section wins in light themes, and falls back to the dark one.
  assert.equal(file("a.ts", undefined, "light"), "_light_ts");
  assert.equal(file("a.test.ts", undefined, "light"), "_light_ts");
  assert.equal(file("b.json", "json", "light"), "_json");
  const folder = (name: string, expanded = false, root = false) => iconIdFor(theme, { kind: "folder", name, expanded, root });
  assert.equal(folder("src"), "_src");
  assert.equal(folder("lib"), "_folder");
  assert.equal(folder("lib", true), "_folder_open");
  assert.equal(folder("lib", true, true), "_folder_open");
  assert.equal(folder("SRC", true), "_folder_open");
});

test("font characters and product icon themes", () => {
  assert.equal(fontCharacterOf("\\E001"), "\u{E001}");
  assert.equal(fontCharacterOf("\\1f600"), "\u{1F600}");
  assert.equal(fontCharacterOf("x"), "x");
  const product = normalizeProductIconTheme(
    { fonts: [{ id: "p", src: [{ path: "p.woff2", format: "woff2" }] }], iconDefinitions: { "chevron-down": { fontCharacter: "\\e001" }, bad: {} } },
    identity,
  );
  assert.deepEqual(Object.keys(product.icons), ["chevron-down"]);
  assert.equal(product.fonts[0]!.id, "p");
});

test("the host loads theme files and serves their assets as data: URIs, only inside the extension", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lumen-icon-theme-"));
  const extension = join(dir, "ext");
  mkdirSync(join(extension, "icons"), { recursive: true });
  writeFileSync(join(extension, "icons", "a.svg"), "<svg/>");
  writeFileSync(join(dir, "secret.svg"), "<svg/>");
  writeFileSync(join(extension, "theme.json"), `// comment\n{"iconDefinitions":{"a":{"iconPath":"./icons/a.svg"},"out":{"iconPath":"../secret.svg"}},"file":"a",}`);
  const host = new ExtensionHost();
  host.init = { extensions: [], config: { lumen: {}, user: {} }, workspace: null, userData: dir, appRoot: ROOT, appName: "Lumen", appVersion: "0.1.0", languages: [], webviewPort: 1, webviewToken: "t" };
  host.post = () => undefined;
  host.runtimes.set("pub.ext", { description: { location: extension } } as never);
  const loaded = (await host.methods.feature("icon-themes", "load", ["file", "pub.ext", join(extension, "theme.json")])) as { key: string; theme: { iconDefinitions: Record<string, { path?: string }> } };
  const definitions = loaded.theme.iconDefinitions;
  assert.equal(definitions.a!.path, join(extension, "icons", "a.svg"));
  assert.equal(definitions.out, undefined);
  const assets = (await host.methods.feature("icon-themes", "assets", [loaded.key, [definitions.a!.path, join(dir, "secret.svg"), join(extension, "nope.svg")]])) as Record<string, string | null>;
  assert.equal(assets[definitions.a!.path!], `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`);
  assert.equal(assets[join(dir, "secret.svg")], null);
  assert.equal(assets[join(extension, "nope.svg")], null);
  await assert.rejects(host.methods.feature("icon-themes", "load", ["file", "pub.ext", join(dir, "secret.svg")]), /outside/);
  assert.deepEqual(await host.methods.feature("icon-themes", "assets", ["unknown", [definitions.a!.path]]), {});
});
