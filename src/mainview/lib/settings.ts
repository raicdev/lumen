import { useSyncExternalStore } from "react";
import type { ExtensionDescription } from "../../shared/extensions";
import type { LocaleSetting } from "../../shared/i18n";

/**
 * User settings (VS Code style keys), persisted in localStorage and observable
 * from React (`useSettings`) and plain code (`onSettingsChange`).
 */

export type Settings = {
  "editor.fontSize": number;
  "editor.fontFamily": string;
  "editor.tabSize": number;
  "editor.insertSpaces": boolean;
  "editor.detectIndentation": boolean;
  "editor.wordWrap": "off" | "on";
  "editor.lineNumbers": "on" | "off";
  "editor.renderWhitespace": "none" | "all";
  "editor.minimap.enabled": boolean;
  "editor.guides.indentation": boolean;
  "editor.cursorBlinking": boolean;
  "editor.autoClosingBrackets": boolean;
  "editor.renderLineHighlight": boolean;
  "editor.formatOnSave": boolean;
  /** Format while typing, through languages.registerOnTypeFormattingEditProvider (off by default, like VS Code). */
  "editor.formatOnType": boolean;
  "editor.gitGutter": boolean;
  /** Who last changed the cursor's line, after the line (git blame). */
  "git.blame.editorDecoration.enabled": boolean;
  /** Who last changed the cursor's line, in the status bar (git blame). */
  "git.blame.statusBarItem.enabled": boolean;
  /** Fetch from the remotes every few minutes, so the status bar shows incoming commits. */
  "git.autofetch": boolean;
  /** Code lenses an extension provider offers (languages.registerCodeLensProvider). */
  "editor.codeLens": boolean;
  /** Mirror linked ranges (e.g. HTML/JSX tags) while typing (languages.registerLinkedEditingRangeProvider). */
  "editor.linkedEditing": boolean;
  "files.autoSave": "off" | "afterDelay" | "onFocusChange";
  "files.autoSaveDelay": number;
  "files.trimTrailingWhitespace": boolean;
  "files.insertFinalNewline": boolean;
  "explorer.autoReveal": boolean;
  "breadcrumbs.enabled": boolean;
  "workbench.statusBar.visible": boolean;
  "workbench.activityBar.visible": boolean;
  /** Activity bar items (view ids) in the order the user dragged them to; others keep their place. */
  "workbench.activityBar.order": string[];
  /** Activity bar items (view ids) the user hid. */
  "workbench.activityBar.hidden": string[];
  /** Panel tabs (problems, output, view:…) the user hid. */
  "workbench.panel.hidden": string[];
  "workbench.editor.enablePreview": boolean;
  /** Close a split editor group when its last editor closes (false keeps the layout). */
  "workbench.editor.closeEmptyGroups": boolean;
  /** Editors in a centered modal: "all" files too; Settings, Keyboard Shortcuts and extension details always are. */
  "workbench.editor.useModal": "off" | "some" | "all";
  /** Open an extension's walkthrough when the extension is installed. */
  "workbench.welcomePage.walkthroughs.openOnInstall": boolean;
  /** Walkthrough keys the user hid from the Welcome page (`publisher.name#id`). */
  "workbench.welcomePage.hiddenCategories": string[];
  /** Color theme: Lumen Dark / Lumen Light or a theme an extension contributes (its id or label). */
  "workbench.colorTheme": string;
  /** modern: rounded floating parts (modern.css); legacy: the flat look underneath. */
  "workbench.style": "modern" | "legacy";
  /** File icon theme contributed by an extension (id or label); empty = Lumen's built-in icons. */
  "workbench.iconTheme": string;
  /** Product icon theme contributed by an extension (id or label); empty = default. */
  "workbench.productIconTheme": string;
  "terminal.integrated.fontSize": number;
  "terminal.integrated.scrollback": number;
  /** Profile id (pwsh, powershell, cmd, gitbash, wsl, bash, …); empty = first available. */
  "terminal.integrated.defaultProfile": string;
  /** default: check at startup and every few hours, download in the background; manual: Help > Check for Updates only; none: never. */
  "update.mode": "default" | "manual" | "none";
  /** stable: releases only; beta: pre-releases as well. */
  "update.channel": "stable" | "beta";
  /** Display language of the window and of extensions; auto follows the system. Applies after a reload. */
  locale: LocaleSetting;
};

export type SettingKey = keyof Settings;

export const DEFAULT_SETTINGS: Settings = {
  "editor.fontSize": 14,
  "editor.fontFamily": '"Cascadia Code", Consolas, ui-monospace, monospace',
  "editor.tabSize": 2,
  "editor.insertSpaces": true,
  "editor.detectIndentation": true,
  "editor.wordWrap": "off",
  "editor.lineNumbers": "on",
  "editor.renderWhitespace": "none",
  "editor.minimap.enabled": true,
  "editor.guides.indentation": true,
  "editor.cursorBlinking": true,
  "editor.autoClosingBrackets": true,
  "editor.renderLineHighlight": true,
  "editor.formatOnSave": false,
  "editor.formatOnType": false,
  "editor.gitGutter": true,
  "git.blame.editorDecoration.enabled": true,
  "git.blame.statusBarItem.enabled": true,
  "git.autofetch": false,
  "editor.codeLens": true,
  "editor.linkedEditing": true,
  "files.autoSave": "off",
  "files.autoSaveDelay": 1000,
  "files.trimTrailingWhitespace": false,
  "files.insertFinalNewline": false,
  "explorer.autoReveal": true,
  "breadcrumbs.enabled": true,
  "workbench.statusBar.visible": true,
  "workbench.activityBar.visible": true,
  "workbench.activityBar.order": [],
  "workbench.activityBar.hidden": [],
  "workbench.panel.hidden": [],
  "workbench.editor.enablePreview": true,
  "workbench.editor.closeEmptyGroups": false,
  "workbench.editor.useModal": "some",
  "workbench.welcomePage.walkthroughs.openOnInstall": true,
  "workbench.welcomePage.hiddenCategories": [],
  "workbench.colorTheme": "Lumen Dark",
  "workbench.style": "modern",
  "workbench.iconTheme": "",
  "workbench.productIconTheme": "",
  "terminal.integrated.fontSize": 13,
  "terminal.integrated.scrollback": 1000,
  "terminal.integrated.defaultProfile": "",
  "update.mode": "default",
  "update.channel": "stable",
  locale: "auto",
};

type SchemaEntry = {
  key: SettingKey;
  category: string;
  label: string;
  description: string;
  options?: readonly string[];
  min?: number;
  max?: number;
};

/** What the Settings editor shows, in order. */
export const SETTINGS_SCHEMA: SchemaEntry[] = [
  { key: "editor.fontSize", category: "Text Editor", label: "Font Size", description: "Controls the font size in pixels.", min: 6, max: 72 },
  { key: "editor.fontFamily", category: "Text Editor", label: "Font Family", description: "Controls the font family." },
  { key: "editor.tabSize", category: "Text Editor", label: "Tab Size", description: "The number of spaces a tab is equal to.", min: 1, max: 16 },
  { key: "editor.insertSpaces", category: "Text Editor", label: "Insert Spaces", description: "Insert spaces when pressing Tab." },
  {
    key: "editor.detectIndentation",
    category: "Text Editor",
    label: "Detect Indentation",
    description: "Edit each file with the indentation it already uses (tabs or spaces, and how many) instead of Tab Size and Insert Spaces.",
  },
  { key: "editor.wordWrap", category: "Text Editor", label: "Word Wrap", description: "Controls how lines should wrap.", options: ["off", "on"] },
  { key: "editor.lineNumbers", category: "Text Editor", label: "Line Numbers", description: "Controls the display of line numbers.", options: ["on", "off"] },
  {
    key: "editor.renderWhitespace",
    category: "Text Editor",
    label: "Render Whitespace",
    description: "Controls how the editor renders whitespace characters.",
    options: ["none", "all"],
  },
  { key: "editor.minimap.enabled", category: "Text Editor", label: "Minimap", description: "Controls whether the minimap is shown." },
  { key: "editor.guides.indentation", category: "Text Editor", label: "Indentation Guides", description: "Controls whether the editor renders indent guides." },
  { key: "editor.cursorBlinking", category: "Text Editor", label: "Cursor Blinking", description: "Controls whether the cursor blinks." },
  { key: "editor.autoClosingBrackets", category: "Text Editor", label: "Auto Closing Brackets", description: "Automatically close brackets and quotes." },
  { key: "editor.renderLineHighlight", category: "Text Editor", label: "Render Line Highlight", description: "Highlight the line of the cursor." },
  { key: "editor.gitGutter", category: "Text Editor", label: "Git Change Indicators", description: "Show added / modified / deleted lines in the gutter." },
  {
    key: "editor.codeLens",
    category: "Text Editor",
    label: "Code Lens",
    description: "Show code lenses extensions provide above their line (languages.registerCodeLensProvider).",
  },
  {
    key: "editor.linkedEditing",
    category: "Text Editor",
    label: "Linked Editing",
    description: "Mirror edits between linked ranges, such as HTML/JSX open and close tags (languages.registerLinkedEditingRangeProvider).",
  },
  { key: "editor.formatOnSave", category: "Text Editor", label: "Format On Save", description: "Format a file on save (TypeScript, JavaScript, JSON)." },
  {
    key: "editor.formatOnType",
    category: "Text Editor",
    label: "Format On Type",
    description: "Format while typing, with on-type formatting providers from extensions (trigger characters such as ; or }).",
  },
  {
    key: "files.autoSave",
    category: "Files",
    label: "Auto Save",
    description: "Controls auto save of editors that have unsaved changes.",
    options: ["off", "afterDelay", "onFocusChange"],
  },
  {
    key: "files.autoSaveDelay",
    category: "Files",
    label: "Auto Save Delay",
    description: "Delay in milliseconds after which a file is saved (afterDelay).",
    min: 100,
    max: 60000,
  },
  { key: "files.trimTrailingWhitespace", category: "Files", label: "Trim Trailing Whitespace", description: "Trim trailing whitespace when saving a file." },
  {
    key: "files.insertFinalNewline",
    category: "Files",
    label: "Insert Final Newline",
    description: "Insert a final newline at the end of the file when saving it.",
  },
  { key: "explorer.autoReveal", category: "Workbench", label: "Explorer: Auto Reveal", description: "Reveal and select the active file in the explorer." },
  { key: "breadcrumbs.enabled", category: "Workbench", label: "Breadcrumbs", description: "Show breadcrumbs above the editor." },
  {
    key: "workbench.editor.enablePreview",
    category: "Workbench",
    label: "Enable Preview Editors",
    description: "Single-clicked files open in a preview tab (italic) that the next file replaces.",
  },
  {
    key: "workbench.editor.closeEmptyGroups",
    category: "Workbench",
    label: "Close Empty Groups",
    description: "Close a split editor group when its last editor closes. When off, the layout stays as it is and the empty group waits for files.",
  },
  {
    key: "workbench.editor.useModal",
    category: "Workbench",
    label: "Use Modal",
    description:
      "Controls whether editors open in a centered modal overlay. all: every file opens in the modal. some / off: files open in the editor area (Settings, Keyboard Shortcuts and extension details are always dialogs in Lumen).",
    options: ["off", "some", "all"],
  },
  {
    key: "workbench.welcomePage.walkthroughs.openOnInstall",
    category: "Workbench",
    label: "Welcome: Walkthroughs: Open On Install",
    description: "When enabled, an extension's walkthrough will open upon install of the extension.",
  },
  {
    key: "workbench.colorTheme",
    category: "Workbench",
    label: "Color Theme",
    description: "The color theme of the window: Lumen Dark, Lumen Light or a theme from an extension. Also: Preferences: Color Theme (Ctrl+K Ctrl+T).",
  },
  {
    key: "workbench.style",
    category: "Workbench",
    label: "Style",
    description:
      "modern: the side bars, editor area and panel float as rounded cards, with softer dialogs and controls. legacy: the flat, square look. Also: View > Appearance > Modern Style.",
    options: ["modern", "legacy"],
  },
  {
    key: "workbench.iconTheme",
    category: "Workbench",
    label: "File Icon Theme",
    description: "The file icon theme from an extension (empty uses Lumen's icons). Also: Preferences: File Icon Theme.",
  },
  {
    key: "workbench.productIconTheme",
    category: "Workbench",
    label: "Product Icon Theme",
    description: "The product icon theme from an extension (empty uses the default). Also: Preferences: Product Icon Theme.",
  },
  { key: "workbench.statusBar.visible", category: "Workbench", label: "Status Bar", description: "Controls the visibility of the status bar." },
  { key: "workbench.activityBar.visible", category: "Workbench", label: "Activity Bar", description: "Controls the visibility of the activity bar." },
  {
    key: "git.blame.editorDecoration.enabled",
    category: "Source Control",
    label: "Blame: Editor Decoration",
    description: "Show who last changed the cursor's line, when and why, after the line.",
  },
  {
    key: "git.blame.statusBarItem.enabled",
    category: "Source Control",
    label: "Blame: Status Bar Item",
    description: "Show who last changed the cursor's line in the status bar.",
  },
  {
    key: "git.autofetch",
    category: "Source Control",
    label: "Autofetch",
    description: "Fetch from the remotes every 3 minutes, so the status bar shows commits to pull.",
  },
  { key: "terminal.integrated.fontSize", category: "Terminal", label: "Font Size", description: "Controls the font size of the terminal.", min: 6, max: 40 },
  {
    key: "terminal.integrated.scrollback",
    category: "Terminal",
    label: "Scrollback",
    description:
      "Lines a terminal keeps for scrolling back. Older output is kept as plain text, which uses far less memory: Terminal: Show Full History opens all of it.",
    min: 100,
    max: 100000,
  },
  {
    key: "terminal.integrated.defaultProfile",
    category: "Terminal",
    label: "Default Profile",
    description:
      "Shell used for new terminals: pwsh, powershell, cmd, gitbash, wsl (Windows) or bash, zsh, … Empty uses the first available. Also: Terminal: Select Default Profile.",
  },
  {
    key: "update.mode",
    category: "Application",
    label: "Update: Mode",
    description:
      "default: check for updates at startup and every few hours, download them in the background and ask to restart. manual: only Help > Check for Updates. none: never check.",
    options: ["default", "manual", "none"],
  },
  {
    key: "update.channel",
    category: "Application",
    label: "Update: Channel",
    description:
      "stable: update to releases only. beta: also update to beta pre-releases, which come before a release and may have bugs. Unless set, a beta build of Lumen follows the beta channel.",
    options: ["stable", "beta"],
  },
  {
    key: "locale",
    category: "Application",
    label: "Display Language",
    description:
      "The language of Lumen and of extensions that are translated. auto: the language of the system. Takes effect after the window reloads. Also: Configure Display Language.",
    options: ["auto", "en", "ja"],
  },
];

const STORAGE_KEY = "lumen.settings";
const LANGUAGE_STORAGE_KEY = "lumen.settings.languages";

type UserSettings = Partial<Settings>;
type LanguageUserSettings = Record<string, Partial<Settings>>;

/** contributes.configurationDefaults of the enabled extensions, for keys without a language. */
let contributedDefaults: Record<string, unknown> = {};
/** contributes.configurationDefaults for language scopes (`"[python]": {...}`), lower-cased language id → values. */
let contributedLanguageDefaults: Record<string, Record<string, unknown>> = {};

function matchesType(key: SettingKey, value: unknown): boolean {
  const base = DEFAULT_SETTINGS[key];
  return Array.isArray(base) ? Array.isArray(value) : typeof value === typeof base;
}

/** Applies a contribution default only when the key and its value type are settings Lumen knows. */
function assignSetting(out: Settings, key: string, value: unknown): void {
  if (!(key in DEFAULT_SETTINGS)) return;
  const setting = key as SettingKey;
  if (!matchesType(setting, value)) return;
  (out as Record<string, unknown>)[setting] = value;
}

function load(): UserSettings {
  const out: UserSettings = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return out;
    const stored = JSON.parse(raw) as Record<string, unknown>;
    for (const [key, value] of Object.entries(stored)) assignSetting(out as Settings, key, value);
  } catch {
    /* corrupt or unavailable storage: no user settings */
  }
  return out;
}

function loadLanguageSettings(): LanguageUserSettings {
  const out: LanguageUserSettings = {};
  try {
    const raw = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (!raw) return out;
    const stored = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    for (const [language, values] of Object.entries(stored)) {
      const scope: Partial<Settings> = {};
      for (const [key, value] of Object.entries(values ?? {})) assignSetting(scope as Settings, key, value);
      if (Object.keys(scope).length) out[language.toLowerCase()] = scope;
    }
  } catch {
    /* corrupt or unavailable storage: no language overrides */
  }
  return out;
}

let userSettings = load();
let languageSettings = loadLanguageSettings();

function defaultSettings(languageId?: string): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  for (const [key, value] of Object.entries(contributedDefaults)) assignSetting(out, key, value);
  if (languageId) {
    for (const [key, value] of Object.entries(contributedLanguageDefaults[languageId.toLowerCase()] ?? {})) assignSetting(out, key, value);
  }
  return out;
}

/** The defaults of the built-in settings: Lumen's own, overridden by extension configurationDefaults. */
export function getDefaultSettings(languageId?: string): Settings {
  return defaultSettings(languageId);
}

/** User settings over the defaults (VS Code: default < extension defaults < user, language-specific last). */
function resolveSettings(languageId?: string): Settings {
  const out = defaultSettings(languageId);
  Object.assign(out, userSettings);
  if (languageId) Object.assign(out, languageSettings[languageId.toLowerCase()] ?? {});
  return out;
}

function persist(key: string, value: unknown): void {
  try {
    if (value && Object.keys(value as object).length) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

let current = resolveSettings();
const listeners = new Set<() => void>();

function notify(): void {
  current = resolveSettings();
  for (const listener of listeners) listener();
}

/** Whether the user set `key` (as opposed to it having its default value). */
export function isUserSetting(key: SettingKey): boolean {
  return key in userSettings;
}

export function getSettings(): Settings {
  return current;
}

/** Settings of one language: extension defaults for `[language]`, then user overrides for it. */
export function getSettingsForLanguage(languageId: string): Settings {
  return resolveSettings(languageId);
}

/** Language ids that have extension-contributed defaults, for the Settings editor. */
export function configurationDefaultLanguages(): string[] {
  return Object.keys(contributedLanguageDefaults).sort();
}

/** Language ids the user has overrides for, for the Settings editor. */
export function configurationLanguageOverrides(): string[] {
  return Object.keys(languageSettings).sort();
}

/**
 * Reads contributes.configurationDefaults of the enabled extensions (from the host's `ready`
 * message) and makes them the defaults of the built-in settings, below the user's values.
 * Later extensions win, like the extension host's own resolution. Language defaults are merged
 * per language.
 */
export function applyConfigurationDefaults(extensions: readonly Pick<ExtensionDescription, "manifest">[]): void {
  const defaults: Record<string, unknown> = {};
  const languageDefaults: Record<string, Record<string, unknown>> = {};
  for (const extension of extensions) {
    const contributed = (extension.manifest.contributes as { configurationDefaults?: Record<string, unknown> } | undefined)?.configurationDefaults;
    if (!contributed || typeof contributed !== "object") continue;
    for (const [key, value] of Object.entries(contributed)) {
      const languages = [...key.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1].trim().toLowerCase()).filter(Boolean);
      if (languages.length) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const values: Record<string, unknown> = {};
        for (const [setting, settingValue] of Object.entries(value)) {
          // A later extension with an incompatible value must not hide an earlier valid default.
          if (setting in DEFAULT_SETTINGS && !matchesType(setting as SettingKey, settingValue)) continue;
          values[setting] = settingValue;
        }
        for (const language of languages) languageDefaults[language] = { ...languageDefaults[language], ...values };
      } else {
        if (key in DEFAULT_SETTINGS && !matchesType(key as SettingKey, value)) continue;
        defaults[key] = value;
      }
    }
  }
  if (JSON.stringify([defaults, languageDefaults]) === JSON.stringify([contributedDefaults, contributedLanguageDefaults])) return;
  contributedDefaults = defaults;
  contributedLanguageDefaults = languageDefaults;
  notify();
}

type HostMessage = { type?: string; extensions?: readonly Pick<ExtensionDescription, "manifest">[] };

/** The host's `ready` message carries the extension list, including configurationDefaults. */
export function handleHostMessage(message: HostMessage | null | undefined): void {
  if (message?.type === "ready" && Array.isArray(message.extensions)) applyConfigurationDefaults(message.extensions);
}

export function updateSetting<K extends SettingKey>(key: K, value: Settings[K]): void {
  if (JSON.stringify(current[key]) === JSON.stringify(value)) return;
  const defaults = defaultSettings();
  if (JSON.stringify(value) === JSON.stringify(defaults[key])) delete userSettings[key];
  else (userSettings as Record<string, unknown>)[key] = value;
  persist(STORAGE_KEY, userSettings);
  notify();
}

/** Sets a value in the `[language]` scope (undefined removes the override). */
export function updateLanguageSetting<K extends SettingKey>(languageId: string, key: K, value: Settings[K] | undefined): void {
  const language = languageId.toLowerCase();
  const scope = { ...languageSettings[language] };
  if (value === undefined || JSON.stringify(value) === JSON.stringify(defaultSettings(language)[key])) delete scope[key];
  else (scope as Record<string, unknown>)[key] = value;
  if (Object.keys(scope).length) languageSettings[language] = scope;
  else delete languageSettings[language];
  persist(LANGUAGE_STORAGE_KEY, languageSettings);
  notify();
}

export function resetSetting(key: SettingKey): void {
  delete userSettings[key];
  persist(STORAGE_KEY, userSettings);
  notify();
}

export function resetLanguageSetting(languageId: string, key: SettingKey): void {
  const language = languageId.toLowerCase();
  const scope = { ...languageSettings[language] };
  delete scope[key];
  if (Object.keys(scope).length) languageSettings[language] = scope;
  else delete languageSettings[language];
  persist(LANGUAGE_STORAGE_KEY, languageSettings);
  notify();
}

export function onSettingsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `next`, keeping the arrays and objects of `previous` whose value did not change (listeners compare settings by identity). */
function keepUnchanged<T extends Record<string, unknown>>(previous: T, next: T): T {
  for (const [key, value] of Object.entries(next)) {
    if (value && typeof value === "object" && JSON.stringify(value) === JSON.stringify(previous[key])) (next as Record<string, unknown>)[key] = previous[key];
  }
  return next;
}

/**
 * Another window changed the settings: every window shares this storage (one origin),
 * and the browser tells the others, so each reloads instead of writing over the
 * change with its own copy later.
 */
function reloadFromStorage(key: string | null): void {
  if (key !== null && key !== STORAGE_KEY && key !== LANGUAGE_STORAGE_KEY) return;
  userSettings = keepUnchanged(userSettings as Record<string, unknown>, load() as Record<string, unknown>) as UserSettings;
  const languages = loadLanguageSettings();
  for (const [language, scope] of Object.entries(languages)) {
    languages[language] = keepUnchanged((languageSettings[language] ?? {}) as Record<string, unknown>, scope as Record<string, unknown>) as Partial<Settings>;
  }
  languageSettings = languages;
  notify();
}

if (typeof window !== "undefined") {
  window.addEventListener("lumen:ext-host", (event) => handleHostMessage((event as CustomEvent<HostMessage>).detail));
  window.addEventListener("storage", (event) => {
    if (event.storageArea === localStorage) reloadFromStorage(event.key);
  });
}

export function useSettings(): Settings {
  return useSyncExternalStore(onSettingsChange, getSettings);
}
