import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyConfigurationDefaults,
  getDefaultSettings,
  getSettings,
  getSettingsForLanguage,
  handleHostMessage,
  onSettingsChange,
  resetLanguageSetting,
  resetSetting,
  updateLanguageSetting,
  updateSetting,
} from "../../src/mainview/lib/settings.ts";

/**
 * contributes.configurationDefaults: extension defaults of the built-in settings, below user
 * settings, with language scopes (`"[python]": { "editor.tabSize": 4 }`).
 *
 *   node --test test/features/configuration-defaults.test.ts
 */

type Extension = Parameters<typeof applyConfigurationDefaults>[0][number];

function extension(id: string, configurationDefaults: Record<string, unknown>): Extension {
  return { manifest: { name: id, version: "1.0.0", contributes: { configurationDefaults } } } as unknown as Extension;
}

const KEYS = ["editor.tabSize", "editor.insertSpaces", "editor.fontSize", "files.autoSave"] as const;

/** The settings module keeps state for the window; start every test from a clean slate. */
function reset(): void {
  applyConfigurationDefaults([]);
  for (const key of KEYS) {
    resetSetting(key);
    for (const language of ["python", "javascript", "typescript"]) resetLanguageSetting(language, key);
  }
}

test("extension defaults of built-in settings apply below user settings, later extensions win", () => {
  reset();
  applyConfigurationDefaults([
    extension("a", { "editor.tabSize": 4, "files.autoSave": "afterDelay" }),
    extension("b", { "editor.tabSize": 8 }),
  ]);

  assert.equal(getDefaultSettings()["editor.tabSize"], 8);
  assert.equal(getDefaultSettings()["files.autoSave"], "afterDelay");
  assert.equal(getSettings()["editor.tabSize"], 8);
  assert.equal(getSettings()["files.autoSave"], "afterDelay");

  // User settings still win, and resetting falls back to the extension default, not Lumen's.
  updateSetting("editor.tabSize", 3);
  assert.equal(getSettings()["editor.tabSize"], 3);
  resetSetting("editor.tabSize");
  assert.equal(getSettings()["editor.tabSize"], 8);

  // Setting the extension default explicitly stores nothing (the effective default wins).
  updateSetting("editor.tabSize", 8);
  assert.equal(getSettings()["editor.tabSize"], 8);
});

test("unknown keys and values of the wrong type are ignored", () => {
  reset();
  applyConfigurationDefaults([
    extension("a", { "editor.tabSize": 4, "not.a.setting": 1 }),
    extension("b", { "editor.tabSize": "8" }),
  ]);

  assert.equal(getDefaultSettings()["editor.tabSize"], 4);
  assert.equal((getSettings() as Record<string, unknown>)["not.a.setting"], undefined);
});

test("language-specific extension defaults resolve per language and below user settings", () => {
  reset();
  applyConfigurationDefaults([
    extension("a", {
      "[python]": { "editor.tabSize": 4 },
      "[typescript][javascript]": { "editor.insertSpaces": false },
    }),
  ]);

  assert.equal(getDefaultSettings("python")["editor.tabSize"], 4);
  assert.equal(getDefaultSettings("Python")["editor.tabSize"], 4);
  assert.equal(getDefaultSettings("rust")["editor.tabSize"], 2);
  assert.equal(getSettingsForLanguage("python")["editor.tabSize"], 4);
  assert.equal(getSettingsForLanguage("javascript")["editor.insertSpaces"], false);
  assert.equal(getSettingsForLanguage("typescript")["editor.insertSpaces"], false);

  // A global user setting overrides a language default, like VS Code.
  updateSetting("editor.tabSize", 6);
  assert.equal(getSettingsForLanguage("python")["editor.tabSize"], 6);

  // A user language override overrides the global user setting.
  resetSetting("editor.tabSize");
  updateLanguageSetting("python", "editor.tabSize", 3);
  assert.equal(getSettingsForLanguage("python")["editor.tabSize"], 3);
  assert.equal(getSettings()["editor.tabSize"], 2);
  resetLanguageSetting("python", "editor.tabSize");
  assert.equal(getSettingsForLanguage("python")["editor.tabSize"], 4);
});

test("the host ready message installs configurationDefaults and listeners hear about it", () => {
  reset();
  let notified = 0;
  const unsubscribe = onSettingsChange(() => notified++);
  try {
    handleHostMessage({ type: "configuration" });
    assert.equal(getSettings()["editor.tabSize"], 2);

    handleHostMessage({ type: "ready", extensions: [extension("a", { "editor.tabSize": 4 })] });
    assert.equal(getSettings()["editor.tabSize"], 4);
    assert.ok(notified > 0);

    // A restart without that extension drops its defaults.
    handleHostMessage({ type: "ready", extensions: [] });
    assert.equal(getSettings()["editor.tabSize"], 2);
  } finally {
    unsubscribe();
  }
});
