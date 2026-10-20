import type { FocusContext } from "./keybindings";

/**
 * Workbench commands: one registry drives the command palette, the menu bar,
 * keyboard shortcuts and the Keyboard Shortcuts editor (like VS Code).
 */
export type Command = {
  id: string;
  title: string;
  /** Palette prefix, e.g. "View" → "View: Toggle Minimap". */
  category?: string;
  /** `arg` is the first argument an extension (or a `command:` link) passed, if any. */
  run: (arg?: unknown) => unknown;
  /** Shows a check mark in menus. */
  checked?: () => boolean;
  /** Hidden from the palette when it returns false. */
  enabled?: () => boolean;
};

export type Keybinding = {
  key: string;
  command: string;
  /** Only active when focus is in this part of the window. */
  when?: FocusContext;
  /** A VS Code when clause (extension keybindings). */
  whenExpr?: string;
  /** Argument passed to the command (extension keybindings). */
  args?: unknown;
};

/** Commands that still fire while the terminal has focus (VS Code's commandsToSkipShell). */
export const TERMINAL_PASSTHROUGH = new Set([
  "workbench.action.showCommands",
  "workbench.action.quickOpen",
  "workbench.action.showAllSymbols",
  "workbench.action.togglePanel",
  "workbench.action.terminal.toggleTerminal",
  "workbench.action.terminal.new",
  "workbench.action.terminal.split",
  "workbench.action.terminal.focusNext",
  "workbench.action.terminal.focusPrevious",
  "workbench.action.toggleSidebarVisibility",
  "workbench.action.toggleAuxiliaryBar",
  "workbench.view.explorer",
  "workbench.view.search",
  "workbench.view.scm",
  "workbench.actions.view.problems",
  "workbench.action.nextEditor",
  "workbench.action.previousEditor",
  "workbench.action.quickOpenPreviousRecentlyUsedEditor",
  "workbench.action.openSettings",
  "workbench.action.toggleZenMode",
  "workbench.action.files.saveAll",
  "workbench.view.extensions",
  "workbench.action.output.toggleOutput",
  "workbench.action.debug.start",
  "workbench.action.debug.continue",
  "workbench.action.debug.stop",
  "workbench.action.debug.restart",
  "workbench.action.debug.pause",
  "workbench.action.debug.stepOver",
  "workbench.action.debug.stepInto",
  "workbench.action.debug.stepOut",
]);

export const DEFAULT_KEYBINDINGS: Keybinding[] = [
  { key: "Ctrl+Shift+P", command: "workbench.action.showCommands" },
  { key: "F1", command: "workbench.action.showCommands" },
  { key: "Ctrl+P", command: "workbench.action.quickOpen" },
  { key: "Ctrl+E", command: "workbench.action.quickOpen" },
  { key: "Ctrl+G", command: "workbench.action.gotoLine" },
  { key: "Ctrl+Shift+O", command: "workbench.action.gotoSymbol" },
  { key: "Ctrl+T", command: "workbench.action.showAllSymbols" },
  { key: "Ctrl+R", command: "workbench.action.openRecent" },
  { key: "Ctrl+N", command: "workbench.action.files.newUntitledFile" },
  { key: "Ctrl+O", command: "workbench.action.files.openFile" },
  { key: "Ctrl+K Ctrl+O", command: "workbench.action.files.openFolder" },
  { key: "Ctrl+S", command: "workbench.action.files.save" },
  { key: "Ctrl+Shift+S", command: "workbench.action.files.saveAs" },
  { key: "Ctrl+K S", command: "workbench.action.files.saveAll" },
  { key: "Ctrl+W", command: "workbench.action.closeActiveEditor" },
  { key: "Ctrl+F4", command: "workbench.action.closeActiveEditor" },
  { key: "Ctrl+K W", command: "workbench.action.closeEditorsInGroup" },
  { key: "Ctrl+K Ctrl+W", command: "workbench.action.closeAllEditors" },
  { key: "Ctrl+\\", command: "workbench.action.splitEditor" },
  { key: "Ctrl+K Ctrl+\\", command: "workbench.action.splitEditorDown" },
  { key: "Ctrl+Alt+Right", command: "workbench.action.moveEditorToNextGroup" },
  { key: "Ctrl+Alt+Left", command: "workbench.action.moveEditorToPreviousGroup" },
  { key: "Ctrl+1", command: "workbench.action.focusFirstEditorGroup" },
  { key: "Ctrl+2", command: "workbench.action.focusSecondEditorGroup" },
  { key: "Ctrl+3", command: "workbench.action.focusThirdEditorGroup" },
  { key: "Ctrl+4", command: "workbench.action.focusFourthEditorGroup" },
  { key: "Ctrl+K U", command: "workbench.action.closeUnmodifiedEditors" },
  { key: "Ctrl+Shift+T", command: "workbench.action.reopenClosedEditor" },
  { key: "Ctrl+Tab", command: "workbench.action.quickOpenPreviousRecentlyUsedEditor" },
  { key: "Ctrl+Shift+Tab", command: "workbench.action.quickOpenLeastRecentlyUsedEditor" },
  { key: "Ctrl+PageDown", command: "workbench.action.nextEditor" },
  { key: "Ctrl+PageUp", command: "workbench.action.previousEditor" },
  ...Array.from({ length: 9 }, (_, i) => ({ key: `Alt+${i + 1}`, command: `workbench.action.openEditorAtIndex${i + 1}` })),
  { key: "Ctrl+B", command: "workbench.action.toggleSidebarVisibility" },
  { key: "Ctrl+Alt+B", command: "workbench.action.toggleAuxiliaryBar" },
  { key: "Ctrl+J", command: "workbench.action.togglePanel" },
  { key: "Ctrl+`", command: "workbench.action.terminal.toggleTerminal" },
  { key: "Ctrl+Shift+`", command: "workbench.action.terminal.new" },
  { key: "Ctrl+Shift+5", command: "workbench.action.terminal.split", when: "terminal" },
  { key: "Ctrl+PageDown", command: "workbench.action.terminal.focusNext", when: "terminal" },
  { key: "Ctrl+PageUp", command: "workbench.action.terminal.focusPrevious", when: "terminal" },
  { key: "Ctrl+Shift+E", command: "workbench.view.explorer" },
  { key: "Ctrl+Shift+F", command: "workbench.view.search" },
  { key: "Ctrl+Shift+H", command: "workbench.action.replaceInFiles" },
  { key: "Ctrl+Shift+G", command: "workbench.view.scm" },
  { key: "Ctrl+Shift+D", command: "workbench.view.debug" },
  { key: "Ctrl+Shift+Y", command: "workbench.debug.action.toggleRepl" },
  { key: "F5", command: "workbench.action.debug.start" },
  { key: "Ctrl+F5", command: "workbench.action.debug.run" },
  { key: "Shift+F5", command: "workbench.action.debug.stop" },
  { key: "Ctrl+Shift+F5", command: "workbench.action.debug.restart" },
  { key: "F6", command: "workbench.action.debug.pause" },
  { key: "F10", command: "workbench.action.debug.stepOver" },
  { key: "F11", command: "workbench.action.debug.stepInto" },
  { key: "Shift+F11", command: "workbench.action.debug.stepOut" },
  { key: "F9", command: "editor.debug.action.toggleBreakpoint" },
  { key: "Ctrl+Shift+M", command: "workbench.actions.view.problems" },
  { key: "Ctrl+Shift+X", command: "workbench.view.extensions" },
  { key: "Ctrl+Shift+U", command: "workbench.action.output.toggleOutput" },
  { key: "Ctrl+,", command: "workbench.action.openSettings" },
  { key: "Ctrl+K Ctrl+S", command: "workbench.action.openGlobalKeybindings" },
  { key: "Ctrl+K Ctrl+T", command: "workbench.action.selectTheme" },
  { key: "Ctrl+K Z", command: "workbench.action.toggleZenMode" },
  { key: "Ctrl+K M", command: "workbench.action.editor.changeLanguageMode" },
  { key: "Alt+Left", command: "workbench.action.navigateBack" },
  { key: "Alt+Right", command: "workbench.action.navigateForward" },
  { key: "Alt+Z", command: "editor.action.toggleWordWrap" },
  { key: "F2", command: "editor.action.rename", when: "editor" },
  { key: "Shift+F12", command: "editor.action.goToReferences", when: "editor" },
  { key: "F12", command: "editor.action.revealDefinition", when: "editor" },
  { key: "Ctrl+F12", command: "editor.action.goToImplementation", when: "editor" },
  { key: "Shift+Alt+F", command: "editor.action.formatDocument", when: "editor" },
  { key: "Ctrl+Shift+Space", command: "editor.action.triggerParameterHints", when: "editor" },
  { key: "Ctrl+.", command: "editor.action.quickFix", when: "editor" },
  { key: "Ctrl+K Ctrl+0", command: "editor.foldAll", when: "editor" },
  { key: "Ctrl+K Ctrl+J", command: "editor.unfoldAll", when: "editor" },
  { key: "Ctrl+K Ctrl+X", command: "editor.action.trimTrailingWhitespace", when: "editor" },
  { key: "Ctrl+K Ctrl+C", command: "editor.action.addCommentLine", when: "editor" },
  { key: "Ctrl+K Ctrl+U", command: "editor.action.removeCommentLine", when: "editor" },
  { key: "Shift+Alt+A", command: "editor.action.blockComment", when: "editor" },
  { key: "Shift+Alt+Right", command: "editor.action.smartSelect.expand", when: "editor" },
  { key: "Shift+Alt+Left", command: "editor.action.smartSelect.shrink", when: "editor" },
  { key: "Ctrl+Alt+Up", command: "editor.action.insertCursorAbove", when: "editor" },
  { key: "Ctrl+Alt+Down", command: "editor.action.insertCursorBelow", when: "editor" },
  { key: "Ctrl+Shift+L", command: "editor.action.selectHighlights", when: "editor" },
  { key: "Ctrl+H", command: "editor.action.startFindReplaceAction", when: "editor" },
  { key: "Ctrl+Shift+\\", command: "editor.action.jumpToBracket", when: "editor" },
];

/** Resolve `Ctrl+K Ctrl+S` style bindings into a lookup keyed by the full sequence. */
export function bindingTable(bindings: Keybinding[]): Map<string, Keybinding[]> {
  const table = new Map<string, Keybinding[]>();
  for (const binding of bindings) {
    const list = table.get(binding.key) ?? [];
    list.push(binding);
    table.set(binding.key, list);
  }
  return table;
}

/** The first (primary) key shown for each command in menus and the palette. */
export function primaryKeys(bindings: Keybinding[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const binding of bindings) if (!map.has(binding.command)) map.set(binding.command, binding.key);
  return map;
}

/** Apply user overrides (commandId → key, "" = unbound) to the defaults (and extensions' bindings). */
export function effectiveKeybindings(overrides: Record<string, string>, contributed: Keybinding[] = []): Keybinding[] {
  const defaults = [...DEFAULT_KEYBINDINGS, ...contributed];
  const result = defaults.filter((binding) => !(binding.command in overrides));
  for (const [command, key] of Object.entries(overrides)) {
    if (!key) continue;
    const original = defaults.find((binding) => binding.command === command);
    result.unshift({ key, command, when: original?.when, whenExpr: original?.whenExpr, args: original?.args });
  }
  return result;
}

const RECENT_COMMANDS_KEY = "lumen.recentCommands";

export function recentCommandIds(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_COMMANDS_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

export function rememberCommand(id: string): void {
  try {
    const next = [id, ...recentCommandIds().filter((entry) => entry !== id)].slice(0, 12);
    localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

export function commandLabel(command: Command): string {
  return command.category ? `${command.category}: ${command.title}` : command.title;
}
