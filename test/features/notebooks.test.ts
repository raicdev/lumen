import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ExtensionHost } from "../../src/main/exthost/host.ts";
import type { HostToView } from "../../src/shared/extensions.ts";
import type { NbWireDoc } from "../../src/shared/notebooks.ts";
import { globMatches } from "../../src/main/exthost/features/notebooks/model.ts";
import { parseIpynb, stringifyIpynb } from "../../src/main/exthost/features/notebooks/ipynb.ts";
import { reviveMenuArg } from "../../src/main/exthost/features/menus-walkthroughs.ts";
import "../../src/main/exthost/features/registry.ts";

/**
 * The notebooks area of the extension host: the .ipynb serializer, the notebook
 * model (documents, cells, edits, executions, events) and the requests of the
 * window's notebook editor.
 *
 *   node --test test/features/notebooks.test.ts
 */

const ROOT = resolve(import.meta.dirname, "../..");

const SAMPLE = {
  cells: [
    { cell_type: "markdown", id: "a", metadata: {}, source: ["# Title\n", "text"] },
    {
      cell_type: "code",
      id: "b",
      metadata: { tags: ["x"] },
      execution_count: 3,
      outputs: [
        { output_type: "stream", name: "stdout", text: ["hi\n"] },
        { output_type: "display_data", data: { "text/plain": ["<img>"], "image/png": "iVBORw0KGgo=" }, metadata: {} },
        { output_type: "error", ename: "ValueError", evalue: "bad", traceback: ["line1", "line2"] },
      ],
      source: ["print('hi')"],
    },
  ],
  metadata: { kernelspec: { name: "python3", language: "python" }, language_info: { name: "python" } },
  nbformat: 4,
  nbformat_minor: 5,
};

function startedHost(): { host: ExtensionHost; posted: HostToView[]; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "lumen-notebook-test-"));
  const host = new ExtensionHost();
  host.init = { extensions: [], config: { lumen: {}, user: {} }, workspace: null, userData: dir, appRoot: ROOT, appName: "Lumen", appVersion: "0.1.0", languages: [], webviewPort: 1, webviewToken: "t" };
  const posted: HostToView[] = [];
  host.post = (message) => void posted.push(message);
  return { host, posted, dir };
}

type Api = Record<string, any>;
const request = (host: ExtensionHost, method: string, ...args: unknown[]) => host.methods.feature("notebooks", method, args);
const tick = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
const idsOf = async (host: ExtensionHost, file: string) => ((await request(host, "open", file)) as NbWireDoc).cells.map((cell) => cell.id);

test("the .ipynb serializer keeps cells, outputs and metadata through a round trip", () => {
  const data = parseIpynb(JSON.stringify(SAMPLE));
  assert.equal(data.cells.length, 2);
  assert.equal(data.cells[0]!.kind, 1);
  assert.equal(data.cells[0]!.value, "# Title\ntext");
  assert.equal(data.cells[1]!.languageId, "python");
  assert.equal(data.cells[1]!.outputs!.length, 3);
  const out = JSON.parse(stringifyIpynb(data as never));
  assert.deepEqual(out.cells[0].source, ["# Title\n", "text"]);
  assert.equal(out.cells[1].execution_count, 3);
  assert.deepEqual(out.cells[1].metadata, { tags: ["x"] });
  assert.deepEqual(out.cells[1].outputs[0], SAMPLE.cells[1]!.outputs![0]);
  assert.equal(out.cells[1].outputs[1].data["image/png"], "iVBORw0KGgo=");
  assert.deepEqual(out.cells[1].outputs[2].traceback, ["line1", "line2"]);
  assert.equal(out.nbformat_minor, 5);
  assert.equal(out.metadata.kernelspec.name, "python3");
  assert.equal(parseIpynb("").cells.length, 0);
});

test("filename patterns of contributed notebooks", () => {
  assert.ok(globMatches("*.ipynb", "/a/b/c.ipynb"));
  assert.ok(globMatches("*.{ipynb,nb}", "C:\\a\\c.nb"));
  assert.ok(globMatches("**/notes/*.md", "/x/y/notes/a.md"));
  assert.ok(!globMatches("*.ipynb", "/a/b/c.txt"));
});

test("a notebook opens, runs through a controller, is edited by an extension and saves", async () => {
  const { host, posted, dir } = startedHost();
  const api = host.apiFor(null) as Api;
  const file = join(dir, "n.ipynb");
  writeFileSync(file, JSON.stringify(SAMPLE));
  const events: string[] = [];
  api.workspace.onDidOpenNotebookDocument(() => events.push("open"));
  api.workspace.onDidChangeNotebookDocument((e: any) => events.push(`change:${e.contentChanges.length}:${e.cellChanges.length}`));
  api.workspace.onDidSaveNotebookDocument(() => events.push("save"));

  // A controller that prints each cell's text in upper case.
  const selected: boolean[] = [];
  const controller = api.notebooks.createNotebookController("test.kernel", "jupyter-notebook", "Test kernel", async (cells: any[]) => {
    for (const cell of cells) {
      const execution = controller.createNotebookCellExecution(cell);
      execution.executionOrder = 7;
      execution.start(1000);
      await execution.replaceOutput(new api.NotebookCellOutput([api.NotebookCellOutputItem.text(cell.document.getText().toUpperCase())]));
      execution.end(true, 1500);
    }
  });
  controller.onDidChangeSelectedNotebooks((e: any) => selected.push(e.selected));

  const wire = (await request(host, "open", file)) as NbWireDoc;
  assert.equal(wire.error, undefined);
  assert.equal(wire.cells.length, 2);
  assert.equal(wire.controller?.id, "test.kernel", "the only controller is selected");
  assert.deepEqual(selected, [true]);
  assert.equal(api.workspace.notebookDocuments.length, 1);
  assert.equal(events[0], "open");
  const code = wire.cells[1]!;

  // The window edits a cell, then runs it.
  host.handleView({ type: "feature", area: "notebooks", payload: { t: "text", path: file, cell: code.id, value: "x = 1" } });
  const doc = api.workspace.notebookDocuments[0];
  assert.equal(doc.cellAt(1).document.getText(), "x = 1");
  assert.equal(doc.isDirty, true);
  await request(host, "run", file, [code.id]);
  await tick();
  assert.equal(Buffer.from(doc.cellAt(1).outputs[0].items[0].data).toString(), "X = 1");
  assert.deepEqual(doc.cellAt(1).executionSummary, { executionOrder: 7, success: true, timing: { startTime: 1000, endTime: 1500 } });
  const snapshot = posted
    .filter((message) => message.type === "feature")
    .map((message: any) => message.payload)
    .filter((payload) => payload.t === "doc")
    .pop();
  assert.equal(snapshot.doc.cells[1].outputs[0].items[0].data, "X = 1");
  assert.equal(snapshot.doc.cells[1].state, "idle");
  assert.equal(snapshot.doc.cells[1].executionOrder, 7);

  // An extension edits the notebook through a WorkspaceEdit.
  const edit = new api.WorkspaceEdit();
  edit.set(doc.uri, [
    api.NotebookEdit.insertCells(1, [new api.NotebookCellData(2, "y = 2", "python")]),
    api.NotebookEdit.updateCellMetadata(0, { custom: true }),
    api.NotebookEdit.updateNotebookMetadata({ ...doc.metadata, extra: 1 }),
  ]);
  assert.equal(await api.workspace.applyEdit(edit), true);
  assert.equal(doc.cellCount, 3);
  assert.equal(doc.cellAt(1).document.getText(), "y = 2");
  assert.deepEqual(doc.cellAt(0).metadata, { custom: true });
  assert.equal(doc.metadata.extra, 1);
  assert.ok(events.includes("change:1:0"));

  // Text edits of a cell's document (a vscode-notebook-cell: URI).
  const textEdit = new api.WorkspaceEdit();
  textEdit.replace(doc.cellAt(1).document.uri, new api.Range(0, 0, 0, 1), "z");
  assert.equal(await api.workspace.applyEdit(textEdit), true);
  assert.equal(doc.cellAt(1).document.getText(), "z = 2");

  // Structural edits of the window.
  let ids = await idsOf(host, file);
  await request(host, "move", file, ids[1], 1);
  assert.equal(doc.cellAt(2).document.getText(), "z = 2");
  ids = await idsOf(host, file);
  await request(host, "delete", file, ids[2]);
  assert.equal(doc.cellCount, 2);
  await request(host, "clearOutputs", file);
  assert.equal(doc.cellAt(1).outputs.length, 0);

  // Save writes the file through the serializer.
  assert.equal(await request(host, "save", file), true);
  assert.equal(doc.isDirty, false);
  assert.ok(events.includes("save"));
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.cells.length, 2);
  assert.equal(saved.cells[1].source.join(""), "x = 1");
  assert.equal(saved.metadata.extra, 1);
});

test("editors follow the window, and notebook edits of a notebook that cannot open fail", async () => {
  const { host, dir } = startedHost();
  const api = host.apiFor(null) as Api;
  const file = join(dir, "e.ipynb");
  writeFileSync(file, JSON.stringify(SAMPLE));
  const log: string[] = [];
  api.window.onDidChangeActiveNotebookEditor((editor: any) => log.push(`active:${editor ? "yes" : "no"}`));
  api.window.onDidChangeVisibleNotebookEditors((editors: any[]) => log.push(`visible:${editors.length}`));
  api.window.onDidChangeNotebookEditorSelection((e: any) => log.push(`selection:${e.selections[0].start}-${e.selections[0].end}`));

  assert.equal(api.window.activeNotebookEditor, undefined);
  await request(host, "open", file);
  host.handleView({ type: "feature", area: "notebooks", payload: { t: "visible", path: file, visible: true } });
  const editor = api.window.activeNotebookEditor;
  assert.ok(editor);
  assert.equal(editor.notebook.uri.fsPath.toLowerCase(), file.toLowerCase());
  assert.equal(api.window.visibleNotebookEditors.length, 1);
  host.handleView({ type: "feature", area: "notebooks", payload: { t: "selection", path: file, selections: [[1, 2]] } });
  assert.deepEqual(editor.selections.map((range: any) => [range.start, range.end]), [[1, 2]]);
  host.handleView({ type: "feature", area: "notebooks", payload: { t: "visible", path: file, visible: false } });
  assert.equal(api.window.activeNotebookEditor, undefined);
  assert.deepEqual(log, ["visible:1", "active:yes", "selection:1-2", "visible:0", "active:no"]);

  const missing = new api.WorkspaceEdit();
  missing.set(api.Uri.file(join(dir, "missing.ipynb")), [api.NotebookEdit.deleteCells(new api.NotebookRange(0, 1))]);
  assert.equal(await api.workspace.applyEdit(missing), false);
});

test("serializers and status bar item providers of extensions are used", async () => {
  const { host, dir } = startedHost();
  const api = host.apiFor(null) as Api;
  const file = join(dir, "custom.txtnb");
  writeFileSync(file, "one\ntwo");
  api.workspace.registerNotebookSerializer("jupyter-notebook", {
    deserializeNotebook: (bytes: Uint8Array) => new api.NotebookData(new TextDecoder().decode(bytes).split("\n").map((line) => new api.NotebookCellData(2, line, "plaintext"))),
    serializeNotebook: (data: any) => new TextEncoder().encode(data.cells.map((cell: any) => cell.value).join("|")),
  });
  api.notebooks.registerNotebookCellStatusBarItemProvider("jupyter-notebook", {
    provideCellStatusBarItems: (cell: any) => {
      const item = new api.NotebookCellStatusBarItem(`len ${cell.document.getText().length}`, api.NotebookCellStatusBarAlignment.Right);
      item.command = "test.cellCommand";
      return [item];
    },
  });
  const wire = (await request(host, "open", file)) as NbWireDoc;
  assert.deepEqual(wire.cells.map((cell) => cell.value), ["one", "two"]);
  await tick(300);
  const again = (await request(host, "open", file)) as NbWireDoc;
  assert.deepEqual(again.cells[0]!.status, [{ text: "len 3", alignment: "right", priority: 0, tooltip: undefined, command: { command: "test.cellCommand" } }]);
  assert.equal(await request(host, "save", file), true);
  assert.equal(readFileSync(file, "utf8"), "one|two");
});

test("Interactive Windows: interactive.open shows an in-memory notebook, its input runs as cells", async () => {
  const { host, posted } = startedHost();
  const api = host.apiFor(null) as Api;
  // The window: answers "show" by opening the notebook and showing its editor.
  let shown = "";
  host.post = (message) => {
    posted.push(message);
    if (message.type !== "request") return;
    const [area, method, args] = (message as any).args as [string, string, unknown[]];
    queueMicrotask(async () => {
      host.handleView({ type: "reply", id: (message as any).id, result: true } as never);
      if (area === "notebooks" && method === "show") {
        const path = String(args[0]);
        shown = path;
        await request(host, "open", path);
        host.handleView({ type: "feature", area: "notebooks", payload: { t: "visible", path, visible: true } });
      }
    });
  };
  const ran: string[] = [];
  const controller = api.notebooks.createNotebookController("py.kernel", "interactive", "Python", async (cells: any[]) => {
    for (const cell of cells) {
      ran.push(`${cell.document.languageId}:${cell.document.getText()}`);
      const execution = controller.createNotebookCellExecution(cell);
      execution.start();
      execution.end(true);
    }
  });
  controller.supportedLanguages = ["python"];

  const opened = (await api.commands.executeCommand("interactive.open", { preserveFocus: true }, undefined, "py.kernel", "My Window")) as any;
  assert.equal(opened.notebookUri.scheme, "untitled");
  assert.match(opened.notebookUri.path, /^\/Interactive-\d+\.interactive$/);
  assert.equal(opened.inputUri.scheme, "vscode-interactive-input");
  assert.ok(opened.notebookEditor);
  const doc = api.workspace.notebookDocuments.find((notebook: any) => notebook.notebookType === "interactive");
  assert.ok(doc);

  // The window's input box: a new code cell in the kernel's language, run at once; the window is never dirty.
  const viewPath = shown;
  assert.match(viewPath, /^lumen-interactive:/);
  assert.equal(await request(host, "interactiveExecute", viewPath, "print(1)"), true);
  await tick();
  assert.deepEqual(ran, ["python:print(1)"]);
  assert.equal(doc.cellCount, 1);
  assert.equal(doc.isDirty, false);
  // interactive/* menus get VS Code's arguments.
  assert.equal(reviveMenuArg({ $ref: { area: "notebooks", path: viewPath, cell: (await request(host, "open", viewPath) as NbWireDoc).cells[0]!.id } }, host), doc.cellAt(0));
});

test("the Notebook Variables panel lists the controller's variables and their children", async () => {
  const { host, dir } = startedHost();
  const api = host.apiFor(null) as Api;
  const file = join(dir, "v.ipynb");
  writeFileSync(file, JSON.stringify(SAMPLE));
  const controller = api.notebooks.createNotebookController("v.kernel", "jupyter-notebook", "Kernel", () => {});
  const changed = new api.EventEmitter();
  controller.variableProvider = {
    onDidChangeVariables: changed.event,
    async *provideVariables(_notebook: unknown, parent: any, kind: number, start: number) {
      if (!parent) {
        yield { variable: { name: "x", value: "1", type: "int" }, hasNamedChildren: false, indexedChildrenCount: 0 };
        yield { variable: { name: "items", value: "[...]", type: "list" }, hasNamedChildren: true, indexedChildrenCount: 3 };
        return;
      }
      if (kind === api.NotebookVariablesRequestKind.Named) yield { variable: { name: "length", value: "3" }, hasNamedChildren: false, indexedChildrenCount: 0 };
      else for (let i = start; i < 3; i++) yield { variable: { name: String(i), value: `v${i}` }, hasNamedChildren: false, indexedChildrenCount: 0 };
    },
  };
  await request(host, "open", file);
  const globals = (await request(host, "variables", file, undefined, 1, 0)) as any[];
  assert.deepEqual(globals.map((variable) => variable.name), ["x", "items"]);
  assert.equal(globals[1].indexedChildrenCount, 3);
  const named = (await request(host, "variables", file, globals[1].handle, 1, 0)) as any[];
  assert.deepEqual(named.map((variable) => variable.name), ["length"]);
  const indexed = (await request(host, "variables", file, globals[1].handle, 2, 1)) as any[];
  assert.deepEqual(indexed.map((variable) => variable.value), ["v1", "v2"]);
  // notebook/variables/context gets VS Code's variable element.
  const element = reviveMenuArg({ $ref: { area: "notebooks", path: file, variable: globals[0].handle } }, host) as any;
  assert.equal(element.name, "x");
  assert.equal(element.controllerId, "v.kernel");
  assert.equal(element.notebook.fsPath.toLowerCase(), file.toLowerCase());
});
