// @ts-check
const lumen = require("lumen");

/** @param {any} context */
function activate(context) {
  const log = lumen.window.createOutputChannel("Hello Lumen", { log: true });
  log.info("Hello Lumen is active");

  context.subscriptions.push(
    lumen.commands.registerCommand("helloLumen.sayHello", async () => {
      const greeting = lumen.workspace.getConfiguration("helloLumen").get("greeting", "Hello");
      const choice = await lumen.window.showInformationMessage(`${greeting} from an extension!`, "Open Settings", "Thanks");
      if (choice === "Open Settings") await lumen.commands.executeCommand("workbench.action.openSettings");
      log.info(`sayHello → ${choice ?? "dismissed"}`);
    }),

    lumen.commands.registerTextEditorCommand("helloLumen.insertDate", (editor, edit) => {
      for (const selection of editor.selections) edit.replace(selection, new Date().toISOString().slice(0, 10));
    }),

    lumen.commands.registerCommand("helloLumen.pickColor", async () => {
      const color = await lumen.window.showQuickPick(
        [
          { label: "Red", description: "#f14c4c" },
          { label: "Green", description: "#89d185" },
          { label: "Blue", description: "#3794ff" },
        ],
        { placeHolder: "Pick a color" },
      );
      if (!color) return;
      const name = await lumen.window.showInputBox({
        prompt: `Name your ${color.label.toLowerCase()} color`,
        value: color.label,
        validateInput: (value) => (value.trim() ? null : "The name cannot be empty"),
      });
      if (name) lumen.window.showInformationMessage(`${name} = ${color.description}`);
    }),

    lumen.commands.registerCommand("helloLumen.showLog", () => log.show()),
  );

  // Word count in the status bar.
  const words = lumen.window.createStatusBarItem(lumen.StatusBarAlignment.Right, 100);
  words.command = "helloLumen.sayHello";
  words.tooltip = "Words in this document (click to say hello)";
  const updateWords = () => {
    const editor = lumen.window.activeTextEditor;
    const enabled = lumen.workspace.getConfiguration("helloLumen").get("showWordCount", true);
    if (!editor || !enabled) return words.hide();
    const count = (editor.document.getText().match(/\S+/g) ?? []).length;
    words.text = `$(pencil) ${count} words`;
    words.show();
  };
  context.subscriptions.push(
    words,
    lumen.window.onDidChangeActiveTextEditor(updateWords),
    lumen.workspace.onDidChangeTextDocument((e) => {
      if (e.document === lumen.window.activeTextEditor?.document) updateWords();
    }),
    lumen.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("helloLumen")) return;
      updateWords();
      for (const document of lumen.workspace.textDocuments) lintTodos(document);
    }),
  );
  updateWords();

  // TODO diagnostics + highlights.
  const diagnostics = lumen.languages.createDiagnosticCollection("hello-lumen");
  const highlight = lumen.window.createTextEditorDecorationType({
    backgroundColor: "rgba(204, 167, 0, 0.18)",
    border: "1px solid rgba(204, 167, 0, 0.45)",
    borderRadius: "2px",
    after: { contentText: "  ← to do", color: "#8a7a3a", fontStyle: "italic" },
  });
  /** @type {Record<string, number>} */
  const severities = {
    error: lumen.DiagnosticSeverity.Error,
    warning: lumen.DiagnosticSeverity.Warning,
    information: lumen.DiagnosticSeverity.Information,
    hint: lumen.DiagnosticSeverity.Hint,
  };
  /** @param {any} document */
  const lintTodos = (document) => {
    const severity = severities[lumen.workspace.getConfiguration("helloLumen").get("todoSeverity", "information")] ?? 2;
    const found = [];
    for (const match of document.getText().matchAll(/\bTODO\b:?/g)) {
      const range = new lumen.Range(document.positionAt(match.index), document.positionAt(match.index + match[0].length));
      const diagnostic = new lumen.Diagnostic(range, "Something is left to do here", severity);
      diagnostic.source = "hello-lumen";
      found.push(diagnostic);
    }
    diagnostics.set(document.uri, found);
    for (const editor of lumen.window.visibleTextEditors) {
      if (editor.document === document)
        editor.setDecorations(
          highlight,
          found.map((d) => d.range),
        );
    }
  };
  context.subscriptions.push(
    diagnostics,
    highlight,
    lumen.workspace.onDidOpenTextDocument(lintTodos),
    lumen.workspace.onDidChangeTextDocument((e) => lintTodos(e.document)),
    lumen.workspace.onDidCloseTextDocument((document) => diagnostics.delete(document.uri)),
    lumen.window.onDidChangeActiveTextEditor((editor) => editor && lintTodos(editor.document)),
  );
  for (const document of lumen.workspace.textDocuments) lintTodos(document);

  // Completions and hovers for Markdown and plain text.
  const selector = [{ language: "markdown" }, { language: "plaintext" }];
  context.subscriptions.push(
    lumen.languages.registerCompletionItemProvider(selector, {
      provideCompletionItems() {
        const item = new lumen.CompletionItem("Lumen", lumen.CompletionItemKind.Keyword);
        item.detail = "Hello Lumen";
        item.documentation = new lumen.MarkdownString("A **fast**, luminous code editor.");
        const signature = new lumen.CompletionItem("signature", lumen.CompletionItemKind.Snippet);
        signature.insertText = new lumen.SnippetString("— ${1:Your Name}, ${CURRENT_YEAR}");
        return [item, signature];
      },
    }),
    lumen.languages.registerHoverProvider(selector, {
      provideHover(document, position) {
        const range = document.getWordRangeAtPosition(position);
        if (!range) return;
        const word = document.getText(range);
        const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const count = (document.getText().match(new RegExp(`\\b${escaped}\\b`, "g")) ?? []).length;
        return new lumen.Hover(new lumen.MarkdownString(`**${word}** appears ${count} time(s) in this document.`), range);
      },
    }),
  );

  // A webview view in the "Hello Lumen" activity bar container.
  context.subscriptions.push(
    lumen.window.registerWebviewViewProvider("helloLumen.counter", {
      resolveWebviewView(view) {
        view.webview.options = { enableScripts: true, localResourceRoots: [lumen.Uri.joinPath(context.extensionUri, "media")] };
        view.webview.html = page(view.webview, "Counter", "Click the button: the extension counts.");
        let count = 0;
        view.webview.onDidReceiveMessage((message) => {
          if (message.type !== "increment") return;
          count++;
          view.badge = { value: count, tooltip: `${count} clicks` };
          view.webview.postMessage({ type: "count", count });
          log.info(`counter: ${count}`);
        });
      },
    }),
  );

  // A webview panel that comes back after a restart (serializer).
  const showPanel = (panel, state) => {
    panel.webview.options = { enableScripts: true, localResourceRoots: [lumen.Uri.joinPath(context.extensionUri, "media")] };
    panel.webview.html = page(panel.webview, "Preview", "This panel keeps its count across restarts (setState + serializer).", state?.count ?? 0);
    panel.webview.onDidReceiveMessage((message) => {
      if (message.type === "increment") panel.title = `Preview (${message.count})`;
    });
  };
  context.subscriptions.push(
    lumen.commands.registerCommand("helloLumen.openPanel", () => {
      const panel = lumen.window.createWebviewPanel("helloLumen.preview", "Preview", lumen.ViewColumn.Active, { enableScripts: true });
      showPanel(panel);
    }),
    lumen.window.registerWebviewPanelSerializer("helloLumen.preview", {
      async deserializeWebviewPanel(panel, state) {
        showPanel(panel, state);
      },
    }),
  );

  // An in-memory file system: hello-memfs:/scratch.md opens, edits and saves like a file.
  const files = new Map([["/scratch.md", new TextEncoder().encode("# Scratch\n\nThis file lives in an extension's memory (hello-memfs:).\n")]]);
  const changes = new lumen.EventEmitter();
  context.subscriptions.push(
    lumen.workspace.registerFileSystemProvider(
      "hello-memfs",
      {
        onDidChangeFile: changes.event,
        watch: () => new lumen.Disposable(() => {}),
        stat(uri) {
          const file = files.get(uri.path);
          if (file) return { type: lumen.FileType.File, ctime: 0, mtime: Date.now(), size: file.length };
          if (uri.path === "/") return { type: lumen.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
          throw lumen.FileSystemError.FileNotFound(uri);
        },
        readDirectory: () => [...files.keys()].map((path) => [path.slice(1), lumen.FileType.File]),
        createDirectory() {},
        readFile(uri) {
          const file = files.get(uri.path);
          if (!file) throw lumen.FileSystemError.FileNotFound(uri);
          return file;
        },
        writeFile(uri, content) {
          files.set(uri.path, content);
          changes.fire([{ type: lumen.FileChangeType.Changed, uri }]);
        },
        delete(uri) {
          files.delete(uri.path);
          changes.fire([{ type: lumen.FileChangeType.Deleted, uri }]);
        },
        rename(oldUri, newUri) {
          files.set(newUri.path, files.get(oldUri.path));
          files.delete(oldUri.path);
        },
      },
      { isCaseSensitive: true },
    ),
    lumen.commands.registerCommand("helloLumen.openScratch", async () => {
      const document = await lumen.workspace.openTextDocument(lumen.Uri.parse("hello-memfs:/scratch.md"));
      await lumen.window.showTextDocument(document);
    }),
  );

  return { greet: (/** @type {string} */ name) => `Hello, ${name}!` };
}

/** A small page: a CSP with a nonce, a stylesheet through asWebviewUri, the VS Code webview API. */
function page(webview, title, text, start = 0) {
  const nonce = Math.random().toString(36).slice(2);
  const css = webview.asWebviewUri(lumen.Uri.joinPath(lumen.Uri.file(__dirname), "media", "webview.css"));
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${css}">
</head>
<body>
  <h2>${title}</h2>
  <p class="muted">${text}</p>
  <p class="count" id="count">${start}</p>
  <button id="increment">+1</button>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = vscode.getState() ?? { count: ${start} };
    const label = document.getElementById("count");
    label.textContent = state.count;
    document.getElementById("increment").addEventListener("click", () => {
      state.count++;
      label.textContent = state.count;
      vscode.setState(state);
      vscode.postMessage({ type: "increment", count: state.count });
    });
    window.addEventListener("message", (event) => {
      if (event.data.type === "count") label.textContent = event.data.count;
    });
  </script>
</body>
</html>`;
}

function deactivate() {}

module.exports = { activate, deactivate };
