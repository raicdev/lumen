"use strict";
// What `tsc` emits for a typical VS Code extension (CommonJS + interop helper).
var __importStar = (this && this.__importStar) || function (mod) {
  if (mod && mod.__esModule) return mod;
  var result = {};
  if (mod != null) for (var k in mod) if (k !== "default") result[k] = mod[k];
  result["default"] = mod;
  return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
const vscode = __importStar(require("vscode"));

function activate(context) {
  const output = vscode.window.createOutputChannel("Word Tools");

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand("wordTools.reverse", (editor, edit) => {
      for (const selection of editor.selections) {
        const text = editor.document.getText(selection);
        edit.replace(selection, [...text].reverse().join(""));
      }
    }),

    vscode.commands.registerCommand("wordTools.sortWords", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const caseSensitive = vscode.workspace.getConfiguration("wordTools").get("caseSensitiveSort", false);
      await editor.edit((builder) => {
        for (const selection of editor.selections) {
          const words = editor.document.getText(selection).split(/\s+/).filter(Boolean);
          words.sort((a, b) => (caseSensitive ? (a < b ? -1 : a > b ? 1 : 0) : a.localeCompare(b, undefined, { sensitivity: "base" })));
          builder.replace(selection, words.join(" "));
        }
      });
    }),

    vscode.commands.registerCommand("wordTools.count", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("Open a file to count its words.");
        return;
      }
      const text = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
      const count = (text.match(/\S+/g) || []).length;
      output.appendLine(`${vscode.workspace.asRelativePath(editor.document.uri)}: ${count} words`);
      vscode.window.showInformationMessage(`${count} words`, "Show Log").then((choice) => {
        if (choice === "Show Log") output.show(true);
      });
      return count;
    }),
  );
}
exports.activate = activate;

function deactivate() {}
exports.deactivate = deactivate;
