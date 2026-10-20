import { useSyncExternalStore } from "react";

/**
 * User settings (VS Code style keys), persisted in localStorage and observable
 * from React (`useSettings`) and plain code (`onSettingsChange`).
 */

export type Settings = {
  "editor.fontSize": number;
  "editor.fontFamily": string;
  "editor.tabSize": number;
  "editor.insertSpaces": boolean;
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
  /** Color theme: Lumen Dark / Lumen Light or a theme an extension contributes (its id or label). */
  "workbench.colorTheme": string;
  /** File icon theme contributed by an extension (id or label); empty = Lumen's built-in icons. */
  "workbench.iconTheme": string;
  /** Product icon theme contributed by an extension (id or label); empty = default. */
  "workbench.productIconTheme": string;
  "terminal.integrated.fontSize": number;
  /** Profile id (pwsh, powershell, cmd, gitbash, wsl, bash, …); empty = first available. */
  "terminal.integrated.defaultProfile": string;
};

export type SettingKey = keyof Settings;

export const DEFAULT_SETTINGS: Settings = {
  "editor.fontSize": 14,
  "editor.fontFamily": '"Cascadia Code", Consolas, ui-monospace, monospace',
  "editor.tabSize": 2,
  "editor.insertSpaces": true,
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
  "workbench.colorTheme": "Lumen Dark",
  "workbench.iconTheme": "",
  "workbench.productIconTheme": "",
  "terminal.integrated.fontSize": 13,
  "terminal.integrated.defaultProfile": "",
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
  { key: "editor.wordWrap", category: "Text Editor", label: "Word Wrap", description: "Controls how lines should wrap.", options: ["off", "on"] },
  { key: "editor.lineNumbers", category: "Text Editor", label: "Line Numbers", description: "Controls the display of line numbers.", options: ["on", "off"] },
  { key: "editor.renderWhitespace", category: "Text Editor", label: "Render Whitespace", description: "Controls how the editor renders whitespace characters.", options: ["none", "all"] },
  { key: "editor.minimap.enabled", category: "Text Editor", label: "Minimap", description: "Controls whether the minimap is shown." },
  { key: "editor.guides.indentation", category: "Text Editor", label: "Indentation Guides", description: "Controls whether the editor renders indent guides." },
  { key: "editor.cursorBlinking", category: "Text Editor", label: "Cursor Blinking", description: "Controls whether the cursor blinks." },
  { key: "editor.autoClosingBrackets", category: "Text Editor", label: "Auto Closing Brackets", description: "Automatically close brackets and quotes." },
  { key: "editor.renderLineHighlight", category: "Text Editor", label: "Render Line Highlight", description: "Highlight the line of the cursor." },
  { key: "editor.gitGutter", category: "Text Editor", label: "Git Change Indicators", description: "Show added / modified / deleted lines in the gutter." },
  { key: "editor.codeLens", category: "Text Editor", label: "Code Lens", description: "Show code lenses extensions provide above their line (languages.registerCodeLensProvider)." },
  { key: "editor.linkedEditing", category: "Text Editor", label: "Linked Editing", description: "Mirror edits between linked ranges, such as HTML/JSX open and close tags (languages.registerLinkedEditingRangeProvider)." },
  { key: "editor.formatOnSave", category: "Text Editor", label: "Format On Save", description: "Format a file on save (TypeScript, JavaScript, JSON)." },
  {
    key: "editor.formatOnType",
    category: "Text Editor",
    label: "Format On Type",
    description: "Format while typing, with on-type formatting providers from extensions (trigger characters such as ; or }).",
  },
  { key: "files.autoSave", category: "Files", label: "Auto Save", description: "Controls auto save of editors that have unsaved changes.", options: ["off", "afterDelay", "onFocusChange"] },
  { key: "files.autoSaveDelay", category: "Files", label: "Auto Save Delay", description: "Delay in milliseconds after which a file is saved (afterDelay).", min: 100, max: 60000 },
  { key: "files.trimTrailingWhitespace", category: "Files", label: "Trim Trailing Whitespace", description: "Trim trailing whitespace when saving a file." },
  { key: "files.insertFinalNewline", category: "Files", label: "Insert Final Newline", description: "Insert a final newline at the end of the file when saving it." },
  { key: "explorer.autoReveal", category: "Workbench", label: "Explorer: Auto Reveal", description: "Reveal and select the active file in the explorer." },
  { key: "breadcrumbs.enabled", category: "Workbench", label: "Breadcrumbs", description: "Show breadcrumbs above the editor." },
  { key: "workbench.editor.enablePreview", category: "Workbench", label: "Enable Preview Editors", description: "Single-clicked files open in a preview tab (italic) that the next file replaces." },
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
    description: "Controls whether editors open in a centered modal overlay. all: every file opens in the modal. some / off: files open in the editor area (Settings, Keyboard Shortcuts and extension details are always dialogs in Lumen).",
    options: ["off", "some", "all"],
  },
  {
    key: "workbench.colorTheme",
    category: "Workbench",
    label: "Color Theme",
    description: "The color theme of the window: Lumen Dark, Lumen Light or a theme from an extension. Also: Preferences: Color Theme (Ctrl+K Ctrl+T).",
  },
  { key: "workbench.iconTheme", category: "Workbench", label: "File Icon Theme", description: "The file icon theme from an extension (empty uses Lumen's icons). Also: Preferences: File Icon Theme." },
  { key: "workbench.productIconTheme", category: "Workbench", label: "Product Icon Theme", description: "The product icon theme from an extension (empty uses the default). Also: Preferences: Product Icon Theme." },
  { key: "workbench.statusBar.visible", category: "Workbench", label: "Status Bar", description: "Controls the visibility of the status bar." },
  { key: "workbench.activityBar.visible", category: "Workbench", label: "Activity Bar", description: "Controls the visibility of the activity bar." },
  { key: "terminal.integrated.fontSize", category: "Terminal", label: "Font Size", description: "Controls the font size of the terminal.", min: 6, max: 40 },
  {
    key: "terminal.integrated.defaultProfile",
    category: "Terminal",
    label: "Default Profile",
    description: "Shell used for new terminals: pwsh, powershell, cmd, gitbash, wsl (Windows) or bash, zsh, … Empty uses the first available. Also: Terminal: Select Default Profile.",
  },
];

const STORAGE_KEY = "lumen.settings";

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* corrupt or unavailable storage: defaults */
  }
  return { ...DEFAULT_SETTINGS };
}

let current = load();
const listeners = new Set<() => void>();

export function getSettings(): Settings {
  return current;
}

export function updateSetting<K extends SettingKey>(key: K, value: Settings[K]): void {
  if (current[key] === value) return;
  current = { ...current, [key]: value };
  try {
    // Only store what differs from the defaults, like VS Code's settings.json.
    const changed: Partial<Settings> = {};
    for (const k of Object.keys(current) as SettingKey[]) {
      if (JSON.stringify(current[k]) !== JSON.stringify(DEFAULT_SETTINGS[k])) (changed as Record<string, unknown>)[k] = current[k];
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(changed));
  } catch {
    /* ignore */
  }
  for (const listener of listeners) listener();
}

export function resetSetting(key: SettingKey): void {
  updateSetting(key, DEFAULT_SETTINGS[key]);
}

export function onSettingsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSettings(): Settings {
  return useSyncExternalStore(onSettingsChange, getSettings);
}
