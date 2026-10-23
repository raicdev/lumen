import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { formatMessage, localizedFileNames, resolveDisplayLanguage } from "../src/shared/i18n.ts";
import { ExtensionManager, setDisplayLanguage } from "../src/main/extensions/manager.ts";
import { ExtensionHost, type ExtensionRuntime } from "../src/main/exthost/host.ts";
import type { ExtensionDescription } from "../src/shared/extensions.ts";

/**
 * Display languages: picking one, extension manifests in it (package.nls.<language>.json)
 * and vscode.l10n bundles.
 *
 *   node --test test/i18n.test.ts
 */

const ROOT = resolve(import.meta.dirname, "..");

function temp(): string {
  return mkdtempSync(join(tmpdir(), "lumen-i18n-test-"));
}

test("the display language follows the locale setting, else the system, else English", () => {
  assert.equal(resolveDisplayLanguage("auto", "ja-JP"), "ja");
  assert.equal(resolveDisplayLanguage("auto", "en-US"), "en");
  assert.equal(resolveDisplayLanguage("auto", "fr-FR"), "en");
  assert.equal(resolveDisplayLanguage("en", "ja-JP"), "en");
  assert.equal(resolveDisplayLanguage("ja", "en-US"), "ja");
  assert.equal(resolveDisplayLanguage(undefined, undefined), "en");
});

test("messages fill positional and named placeholders and keep unknown ones", () => {
  assert.equal(formatMessage("Rename “{0}” to {1}", ["a", "b"]), "Rename “a” to b");
  assert.equal(formatMessage("{count} files in {folder}", { count: 3, folder: "src" }), "3 files in src");
  assert.equal(formatMessage("{0} and {1}", ["only"]), "only and {1}");
});

test("localized files are looked up most specific first, none for English", () => {
  const name = (locale: string) => `package.nls.${locale}.json`;
  assert.deepEqual(localizedFileNames("zh-CN", name), ["package.nls.zh-cn.json", "package.nls.zh.json"]);
  assert.deepEqual(localizedFileNames("ja", name), ["package.nls.ja.json"]);
  assert.deepEqual(localizedFileNames("en", name), []);
});

test("extension manifests are read in the display language, falling back to package.nls.json", () => {
  const dir = temp();
  const source = join(dir, "source");
  mkdirSync(source);
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({
      name: "greeter",
      publisher: "lumen-test",
      version: "1.0.0",
      displayName: "%displayName%",
      contributes: { commands: [{ command: "greeter.hello", title: "%hello%", category: "%category%" }] },
    }),
  );
  writeFileSync(join(source, "package.nls.json"), JSON.stringify({ displayName: "Greeter", hello: "Say Hello", category: "Greeter" }));
  writeFileSync(join(source, "package.nls.ja.json"), JSON.stringify({ displayName: "あいさつ", hello: { message: "こんにちは", comment: ["a greeting"] } }));
  const previous = process.env.LUMEN_EXTENSIONS_DIR;
  process.env.LUMEN_EXTENSIONS_DIR = join(dir, "extensions");
  try {
    const manager = new ExtensionManager();
    manager.installFolder(source);
    const describe = () => manager.list()[0]!.manifest;
    assert.equal(describe().displayName, "Greeter");
    setDisplayLanguage("ja");
    const manifest = describe();
    assert.equal(manifest.displayName, "あいさつ");
    const [command] = (manifest.contributes?.commands ?? []) as { title: string; category: string }[];
    assert.equal(command!.title, "こんにちは");
    // Keys the translation lacks come from package.nls.json.
    assert.equal(command!.category, "Greeter");
  } finally {
    setDisplayLanguage("en");
    if (previous === undefined) delete process.env.LUMEN_EXTENSIONS_DIR;
    else process.env.LUMEN_EXTENSIONS_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vscode.l10n translates with the extension's bundle for the display language", () => {
  const dir = temp();
  try {
    mkdirSync(join(dir, "l10n"));
    writeFileSync(
      join(dir, "l10n", "bundle.l10n.ja.json"),
      JSON.stringify({ "Hello {0}": "こんにちは {0}", "Open/the verb": "開く", "{count} files": { message: "{count} 個のファイル" } }),
    );
    const apiFor = (language: string | undefined) => {
      const host = new ExtensionHost();
      host.init = {
        extensions: [],
        config: { lumen: {}, user: {} },
        workspace: null,
        userData: temp(),
        appRoot: ROOT,
        appName: "Lumen",
        appVersion: "0.1.0",
        language,
        languages: [],
        webviewPort: 1,
        webviewToken: "t",
      };
      const description = {
        id: "lumen-test.l10n",
        location: dir,
        manifest: { name: "l10n", version: "1.0.0", l10n: "./l10n" },
      } as unknown as ExtensionDescription;
      const runtime = { id: description.id, description, api: null } as unknown as ExtensionRuntime;
      return host.apiFor(runtime) as {
        env: { language: string };
        l10n: { t: (...args: unknown[]) => string; bundle?: Record<string, string>; uri?: { fsPath: string } };
      };
    };

    const ja = apiFor("ja");
    assert.equal(ja.env.language, "ja");
    assert.equal(ja.l10n.t("Hello {0}", "Lumen"), "こんにちは Lumen");
    assert.equal(ja.l10n.t({ message: "Open", comment: ["the verb"] }), "開く");
    assert.equal(ja.l10n.t("{count} files", { count: 2 }), "2 個のファイル");
    assert.equal(ja.l10n.t("Not translated {0}", 1), "Not translated 1");
    assert.equal(ja.l10n.bundle?.["Hello {0}"], "こんにちは {0}");
    assert.ok(ja.l10n.uri?.fsPath.endsWith("bundle.l10n.ja.json"));

    const en = apiFor(undefined);
    assert.equal(en.env.language, "en");
    assert.equal(en.l10n.t("Hello {0}", "Lumen"), "Hello Lumen");
    assert.equal(en.l10n.bundle, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
