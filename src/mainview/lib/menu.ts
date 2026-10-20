import { EditorView } from "@codemirror/view";
import { redo, selectAll, undo } from "@codemirror/commands";
import type { Command } from "./commands";

type Role = "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll" | "toggleFullScreen";

export type MenuItem =
  /** Runs a registered command; label, shortcut and check mark come from it. */
  | { type?: "command"; command: string; label?: string }
  /** Built-in edit behaviour that works in any focused field (editor, inputs, terminal). */
  | { type: "role"; role: Role; label: string; accelerator?: string }
  /** A contributed menu (menuBar/edit/copy) shown as a submenu; left out while no extension contributes to it. */
  | { type: "contributed"; menu: string; label: string }
  /** A fly-out of more items (one level deep). */
  | { type: "submenu"; label: string; items: MenuItem[] }
  | { type: "separator" };

export type MenuGroup = { label: string; items: MenuItem[] };

const sep: MenuItem = { type: "separator" };
const cmd = (command: string, label?: string): MenuItem => ({ command, label });
const submenu = (label: string, items: MenuItem[]): MenuItem => ({ type: "submenu", label, items });

export const APP_MENU: MenuGroup[] = [
  {
    label: "File",
    items: [
      cmd("workbench.action.files.newUntitledFile", "New Text File"),
      cmd("welcome.showNewFileEntries", "New File…"),
      cmd("explorer.newFile", "New File in Explorer…"),
      cmd("explorer.newFolder", "New Folder…"),
      sep,
      cmd("workbench.action.files.openFile", "Open File…"),
      cmd("workbench.action.files.openFolder", "Open Folder…"),
      cmd("workbench.action.openRecent", "Open Recent…"),
      sep,
      cmd("workbench.action.files.save", "Save"),
      cmd("workbench.action.files.saveAs", "Save As…"),
      cmd("workbench.action.files.saveAll", "Save All"),
      sep,
      cmd("workbench.action.toggleAutoSave", "Auto Save"),
      cmd("workbench.action.openSettings", "Preferences: Settings"),
      cmd("workbench.action.openGlobalKeybindings", "Preferences: Keyboard Shortcuts"),
      cmd("workbench.view.extensions", "Preferences: Extensions"),
      sep,
      cmd("workbench.action.files.revert", "Revert File"),
      cmd("workbench.action.closeActiveEditor", "Close Editor"),
      cmd("workbench.action.closeFolder", "Close Folder"),
      cmd("workbench.action.closeWindow", "Close Window"),
      sep,
      cmd("workbench.action.quit", "Exit"),
    ],
  },
  {
    label: "Edit",
    items: [
      { type: "role", role: "undo", label: "Undo", accelerator: "Ctrl+Z" },
      { type: "role", role: "redo", label: "Redo", accelerator: "Ctrl+Y" },
      sep,
      { type: "role", role: "cut", label: "Cut", accelerator: "Ctrl+X" },
      { type: "role", role: "copy", label: "Copy", accelerator: "Ctrl+C" },
      { type: "role", role: "paste", label: "Paste", accelerator: "Ctrl+V" },
      { type: "contributed", menu: "menuBar/edit/copy", label: "Copy As" },
      sep,
      cmd("actions.find", "Find"),
      cmd("editor.action.startFindReplaceAction", "Replace"),
      sep,
      cmd("workbench.view.search", "Find in Files"),
      cmd("workbench.action.replaceInFiles", "Replace in Files"),
      sep,
      cmd("editor.action.commentLine", "Toggle Line Comment"),
      cmd("editor.action.blockComment", "Toggle Block Comment"),
    ],
  },
  {
    label: "Selection",
    items: [
      { type: "role", role: "selectAll", label: "Select All", accelerator: "Ctrl+A" },
      cmd("editor.action.smartSelect.expand", "Expand Selection"),
      cmd("editor.action.smartSelect.shrink", "Shrink Selection"),
      sep,
      cmd("editor.action.copyLinesUpAction", "Copy Line Up"),
      cmd("editor.action.copyLinesDownAction", "Copy Line Down"),
      cmd("editor.action.moveLinesUpAction", "Move Line Up"),
      cmd("editor.action.moveLinesDownAction", "Move Line Down"),
      cmd("editor.action.duplicateSelection", "Duplicate Selection"),
      sep,
      cmd("editor.action.insertCursorAbove", "Add Cursor Above"),
      cmd("editor.action.insertCursorBelow", "Add Cursor Below"),
      cmd("editor.action.addSelectionToNextFindMatch", "Add Next Occurrence"),
      cmd("editor.action.selectHighlights", "Select All Occurrences"),
    ],
  },
  {
    label: "View",
    items: [
      cmd("workbench.action.showCommands", "Command Palette…"),
      sep,
      submenu("Appearance", [
        cmd("workbench.action.toggleFullScreen", "Full Screen"),
        cmd("workbench.action.toggleZenMode", "Zen Mode"),
        sep,
        cmd("workbench.action.toggleSidebarVisibility", "Primary Side Bar"),
        cmd("workbench.action.toggleAuxiliaryBar", "Secondary Side Bar"),
        cmd("workbench.action.toggleActivityBarVisibility", "Activity Bar"),
        cmd("workbench.action.toggleStatusbarVisibility", "Status Bar"),
        cmd("workbench.action.togglePanel", "Panel"),
        sep,
        cmd("workbench.action.positionPanelBottom", "Panel Position: Bottom"),
        cmd("workbench.action.positionPanelLeft", "Panel Position: Left"),
        cmd("workbench.action.positionPanelRight", "Panel Position: Right"),
        sep,
        cmd("editor.action.toggleMinimap", "Minimap"),
        cmd("breadcrumbs.toggle", "Breadcrumbs"),
        cmd("editor.action.toggleRenderWhitespace", "Render Whitespace"),
        sep,
        cmd("editor.action.fontZoomIn", "Zoom In (Editor Font)"),
        cmd("editor.action.fontZoomOut", "Zoom Out (Editor Font)"),
        cmd("editor.action.fontZoomReset", "Reset Zoom"),
      ]),
      submenu("Editor Layout", [
        cmd("workbench.action.splitEditor", "Split Editor Right"),
        cmd("workbench.action.splitEditorDown", "Split Editor Down"),
        cmd("workbench.action.moveEditorToNextGroup", "Move Editor into Next Group"),
        cmd("workbench.action.joinAllGroups", "Join All Editor Groups"),
        sep,
        cmd("workbench.action.evenEditorWidths", "Reset Editor Group Sizes"),
        cmd("workbench.action.toggleKeepEmptyGroups", "Keep Layout When Closing Editors"),
        cmd("workbench.action.closeGroup", "Close Editor Group"),
      ]),
      sep,
      cmd("workbench.view.explorer", "Explorer"),
      cmd("workbench.view.search", "Search"),
      cmd("workbench.view.scm", "Source Control"),
      cmd("outline.focus", "Outline"),
      cmd("workbench.view.extensions", "Extensions"),
      sep,
      cmd("workbench.actions.view.problems", "Problems"),
      cmd("workbench.action.output.toggleOutput", "Output"),
      cmd("workbench.action.terminal.toggleTerminal", "Terminal"),
      sep,
      cmd("editor.action.toggleWordWrap", "Word Wrap"),
    ],
  },
  {
    label: "Go",
    items: [
      cmd("workbench.action.navigateBack", "Back"),
      cmd("workbench.action.navigateForward", "Forward"),
      sep,
      cmd("workbench.action.quickOpen", "Go to File…"),
      cmd("workbench.action.gotoSymbol", "Go to Symbol in Editor…"),
      cmd("workbench.action.showAllSymbols", "Go to Symbol in Workspace…"),
      cmd("workbench.action.gotoLine", "Go to Line…"),
      cmd("editor.action.jumpToBracket", "Go to Bracket"),
      sep,
      cmd("editor.action.revealDefinition", "Go to Definition"),
      cmd("editor.action.goToReferences", "Go to References"),
      sep,
      cmd("editor.action.marker.nextInFiles", "Next Problem"),
      cmd("editor.action.marker.prevInFiles", "Previous Problem"),
      sep,
      cmd("workbench.action.nextEditor", "Next Editor"),
      cmd("workbench.action.previousEditor", "Previous Editor"),
    ],
  },
  {
    label: "Terminal",
    items: [
      cmd("workbench.action.terminal.new", "New Terminal"),
      cmd("workbench.action.terminal.newWithProfile", "New Terminal With Profile…"),
      cmd("workbench.action.terminal.split", "Split Terminal"),
      cmd("workbench.action.createTerminalEditor", "New Terminal in Editor Area"),
      sep,
      cmd("workbench.action.terminal.moveToEditor", "Move Terminal into Editor Area"),
      cmd("workbench.action.terminal.moveToTerminalPanel", "Move Terminal into Panel"),
      cmd("workbench.action.terminal.rename", "Rename Terminal…"),
      sep,
      cmd("workbench.action.terminal.toggleTerminal", "Toggle Terminal"),
      cmd("workbench.action.terminal.clear", "Clear Terminal"),
      cmd("workbench.action.terminal.kill", "Kill Terminal"),
      cmd("workbench.action.terminal.selectDefaultShell", "Select Default Profile…"),
    ],
  },
  {
    label: "Help",
    items: [
      cmd("workbench.action.showCommands", "Show All Commands"),
      cmd("workbench.action.openGlobalKeybindings", "Keyboard Shortcuts Reference"),
      cmd("workbench.action.openWelcome", "Welcome"),
      sep,
      cmd("workbench.action.openIssueReporter", "Report Issue…"),
      cmd("workbench.action.openProcessExplorer", "Open Process Explorer"),
      sep,
      cmd("workbench.action.showAboutDialog", "About"),
    ],
  },
];

/** The CodeMirror view that currently has focus, if any. */
function focusedEditor(): EditorView | null {
  const active = document.activeElement;
  const host = active instanceof HTMLElement ? active.closest<HTMLElement>(".cm-editor") : null;
  return host ? EditorView.findFromDOM(host) : null;
}

/** Undo / redo of an editable custom document (the webview has no CodeMirror view). */
let customEditorRoleHandler: ((role: "undo" | "redo") => boolean) | null = null;

export function setCustomEditorRoleHandler(handler: ((role: "undo" | "redo") => boolean) | null) {
  customEditorRoleHandler = handler;
}

async function runRole(role: Role) {
  const editor = focusedEditor();
  switch (role) {
    case "undo":
      if (editor) undo(editor);
      else if (customEditorRoleHandler?.("undo")) break;
      else document.execCommand("undo");
      break;
    case "redo":
      if (editor) redo(editor);
      else if (customEditorRoleHandler?.("redo")) break;
      else document.execCommand("redo");
      break;
    case "selectAll":
      if (editor) selectAll(editor);
      else document.execCommand("selectAll");
      break;
    case "cut":
    case "copy":
      document.execCommand(role);
      break;
    case "paste": {
      const text = await navigator.clipboard.readText().catch(() => "");
      if (!text) break;
      if (editor) editor.dispatch(editor.state.replaceSelection(text), { scrollIntoView: true });
      else document.execCommand("insertText", false, text);
      break;
    }
    case "toggleFullScreen":
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
      else await document.documentElement.requestFullscreen().catch(() => {});
      break;
  }
}

export function toggleFullScreen() {
  void runRole("toggleFullScreen");
}

export function runMenuItem(item: MenuItem, commands: Map<string, Command>): void {
  if (item.type === "separator" || item.type === "contributed" || item.type === "submenu") return;
  if (item.type === "role") {
    void runRole(item.role);
    return;
  }
  void commands.get(item.command)?.run();
}
