import type { HostFileOperation, HostInputBox, HostQuickPick, HostSelection, ViewMethods } from "../../shared/extensions";
import type { FileEdits, TextEdit, TextRange } from "../../shared/types";
import type { EditorController } from "./editor";
import { extensionService } from "./extensions";
import { showDialog } from "./dialog";
import { notify } from "./toast";
import { dispatchHostRequest } from "../features/registry";

/**
 * The view's answers to the extension host's requests (window.show*,
 * editor edits, terminals, …), on top of what the app can do. The app passes
 * its operations in; this file only translates.
 */

export type ExtensionBridge = {
  openFile: (
    path: string,
    options: { line?: number; character?: number; end?: { line: number; character: number }; preview?: boolean; focus?: boolean; beside?: boolean },
  ) => Promise<boolean>;
  /** Open a side-by-side diff of two documents (`vscode.diff`). */
  openDiff: (
    original: string,
    modified: string,
    options: { title?: string; preview?: boolean; preserveFocus?: boolean; viewColumn?: number; selection?: TextRange },
  ) => Promise<boolean>;
  /** The editor showing a document (opening it in the active group when needed). */
  editorFor: (path: string, open: boolean) => Promise<EditorController | null>;
  saveDoc: (path: string) => Promise<boolean>;
  saveAs: (path: string, destination: string) => Promise<boolean>;
  saveAll: () => Promise<number>;
  openUntitled: (path: string, language: string, content: string) => Promise<void>;
  setDocumentLanguage: (path: string, language: string) => void;
  applyWorkspaceEdits: (edits: FileEdits[]) => Promise<number>;
  /** Run a built-in command; false when there is no such command. */
  runCommand: (command: string, args: unknown[]) => boolean;
  showQuickPick: (pick: HostQuickPick) => Promise<number[] | null>;
  showInputBox: (options: HostInputBox) => Promise<string | null>;
  createTerminal: (options: { name?: string; cwd?: string }) => string;
  showTerminal: (id: string, preserveFocus: boolean) => void;
  sendText: (id: string, text: string) => void;
  killTerminal: (id: string) => void;
  /** Close editor tabs by view path (window.tabGroups.close); true when all are gone. */
  closeTabs: (paths: string[]) => Promise<boolean>;
  /** Editors follow a file created, deleted or renamed by an extension (view paths). */
  followFileOperation: (kind: "create" | "delete" | "rename", files: HostFileOperation[]) => Promise<boolean>;
};

/** VS Code command ids Lumen spells differently. */
const COMMAND_ALIASES: Record<string, string> = {
  "workbench.action.files.saveFiles": "workbench.action.files.saveAll",
  "workbench.action.closeAllGroups": "workbench.action.closeAllEditors",
  "workbench.files.action.focusFilesExplorer": "workbench.view.explorer",
  "workbench.view.extension.explorer": "workbench.view.explorer",
  "workbench.action.output.toggleOutput": "workbench.action.output.toggleOutput",
  "workbench.panel.output.focus": "workbench.action.output.toggleOutput",
  "editor.action.formatDocument.none": "editor.action.formatDocument",
  "workbench.action.terminal.focus": "workbench.action.terminal.toggleTerminal",
  "workbench.action.problems.focus": "workbench.actions.view.problems",
  "workbench.extensions.action.showInstalledExtensions": "workbench.view.extensions",
  "workbench.view.extensions": "workbench.view.extensions",
};

const end = (range: TextRange) => ({ line: range.endLine, character: range.endCharacter });

export function createExtensionHandlers(bridge: ExtensionBridge): {
  [K in keyof ViewMethods]: (...args: Parameters<ViewMethods[K]>) => Promise<ReturnType<ViewMethods[K]>>;
} {
  const path = (raw: string) => extensionService.viewPath(raw);
  return {
    async showMessage(kind, message, items, options) {
      if (options.modal) {
        const buttons = items.map((label, index) => ({ label, role: index === 0 ? ("primary" as const) : ("default" as const), value: String(index) }));
        buttons.push({ label: "Cancel", role: "default", value: "cancel" });
        const choice = await showDialog({
          title: options.source ?? (kind === "error" ? "Error" : kind === "warning" ? "Warning" : "Information"),
          message,
          detail: options.detail,
          buttons,
          kind,
        });
        return choice === null || choice === "cancel" ? null : Number(choice);
      }
      return await notify(kind, message, items, options.source);
    },
    feature: (area, method, args) => dispatchHostRequest(area, method, args),
    showQuickPick: (pick) => bridge.showQuickPick(pick),
    showInputBox: (options) => bridge.showInputBox(options),
    async showTextDocument(target, options) {
      const selection = options.selection;
      return await bridge.openFile(path(target), {
        line: selection?.startLine,
        character: selection?.startCharacter,
        end: selection ? end(selection) : undefined,
        preview: options.preview,
        focus: !options.preserveFocus,
        beside: options.beside,
      });
    },
    openDiff: (original, modified, options) => bridge.openDiff(path(original), path(modified), options),
    async openUntitled(target, language, content) {
      await bridge.openUntitled(target, language, content);
      return true;
    },
    async setDocumentLanguage(target, language) {
      bridge.setDocumentLanguage(path(target), language);
      return true;
    },
    async editDocument(target, edits: TextEdit[]) {
      return (await bridge.applyWorkspaceEdits([{ path: path(target), edits }])) > 0;
    },
    async applyWorkspaceEdit(files) {
      const changed = await bridge.applyWorkspaceEdits(files.map((file) => ({ ...file, path: path(file.path) })));
      return changed === files.length;
    },
    fileOperation: (kind, files) =>
      bridge.followFileOperation(
        kind,
        files.map((file) => ({
          path: file.path === undefined ? undefined : path(file.path),
          oldPath: file.oldPath === undefined ? undefined : path(file.oldPath),
          newPath: file.newPath === undefined ? undefined : path(file.newPath),
        })),
      ),
    async setSelections(target, selections: HostSelection[]) {
      const editor = await bridge.editorFor(path(target), false);
      editor?.setSelections(selections);
      return !!editor;
    },
    async revealRange(target, range) {
      return await bridge.openFile(path(target), { line: range.startLine, character: range.startCharacter, focus: false });
    },
    async insertSnippet(target, snippet, ranges) {
      const editor = await bridge.editorFor(path(target), true);
      return editor ? editor.insertSnippet(snippet, ranges) : false;
    },
    saveDocument: (target) => bridge.saveDoc(path(target)),
    saveDocumentAs: (target, destination) => bridge.saveAs(path(target), extensionService.viewPath(destination)),
    async saveAll() {
      await bridge.saveAll();
      return true;
    },
    async executeCommand(command, args) {
      if (!bridge.runCommand(COMMAND_ALIASES[command] ?? command, args)) throw new Error(`command '${command}' not found`);
      return null;
    },
    async clipboardRead() {
      return await navigator.clipboard.readText().catch(() => "");
    },
    async clipboardWrite(text) {
      await navigator.clipboard.writeText(text).catch(() => {});
      return true;
    },
    async createTerminal(options) {
      return bridge.createTerminal({ name: options.name, cwd: options.cwd });
    },
    async terminalSendText(id, text, addNewLine) {
      bridge.sendText(id, addNewLine ? `${text}\r` : text);
      return true;
    },
    async terminalShow(id, preserveFocus) {
      bridge.showTerminal(id, preserveFocus);
      return true;
    },
    async terminalDispose(id) {
      bridge.killTerminal(id);
      return true;
    },
    async updateConfiguration(key, value) {
      extensionService.updateConfiguration(key, value);
      return true;
    },
    async closeTabs(paths) {
      return await bridge.closeTabs(paths.map((path) => extensionService.viewPath(path)));
    },
  };
}
