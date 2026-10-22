import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ExtensionHost } from "../../src/main/exthost/host.ts";
import { ExtHostDocument, normalizeKey } from "../../src/main/exthost/documents.ts";
import type { HostToView } from "../../src/shared/extensions.ts";

/**
 * Host side of the "languages-extra" area: hierarchies, inline values,
 * evaluatable expressions, drop / paste edits and their classes.
 *
 *   node --test test/features/languages-extra.test.ts
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const FILE = process.platform === "win32" ? "C:\\work\\a.ts" : "/work/a.ts";
const TEXT = "function foo() {\n  const x = 1;\n  return bar(x);\n}\nfunction bar(y) { return y; }\n";

type Api = Record<string, any>;

function startedHost(): { host: ExtensionHost; api: Api; posted: HostToView[] } {
  const host = new ExtensionHost();
  host.init = {
    extensions: [],
    config: { lumen: {}, user: {} },
    workspace: null,
    userData: mkdtempSync(join(tmpdir(), "lumen-languages-extra-")),
    appRoot: ROOT,
    appName: "Lumen",
    appVersion: "0.1.0",
    languages: [],
    webviewPort: 1,
    webviewToken: "t",
  };
  const posted: HostToView[] = [];
  host.post = (message) => void posted.push(message);
  const document = new ExtHostDocument({ path: FILE, languageId: "typescript", version: 1, text: TEXT, eol: "LF", dirty: false }, true, async () => true);
  host.documents.set(normalizeKey(FILE), document);
  return { host, api: host.apiFor(null) as Api, posted };
}

const ask = (host: ExtensionHost, method: string, ...args: unknown[]) => host.methods.feature("languages-extra", method, args) as Promise<any>;

test("classes: kinds, snippet edits, data transfers and enums", async () => {
  const { api } = startedHost();
  const Kind = api.DocumentDropOrPasteEditKind;
  assert.equal(Kind.Empty.value, "");
  assert.equal(Kind.TextUpdateImports.value, "text.updateImports");
  assert.ok(Kind.Text.contains(Kind.TextUpdateImports));
  assert.ok(!Kind.TextUpdateImports.contains(Kind.Text));
  assert.ok(Kind.TextUpdateImports.intersects(Kind.Text));
  assert.equal(Kind.Empty.append("a", "b").value, "a.b");
  assert.equal(api.DocumentPasteTriggerKind.PasteAs, 1);
  assert.equal(api.SyntaxTokenType.RegEx, 3);

  const edit = api.SnippetTextEdit.insert(new api.Position(1, 2), new api.SnippetString("a$1"));
  assert.ok(edit.range instanceof api.Range);
  assert.equal(edit.snippet.value, "a$1");

  const drop = new api.DocumentDropEdit("x", "Insert x", Kind.Text);
  assert.equal(drop.title, "Insert x");
  assert.equal(drop.kind, Kind.Text);
  const paste = new api.DocumentPasteEdit("y", "Paste y", Kind.Empty);
  assert.equal(paste.insertText, "y");

  const transfer = new api.DataTransfer();
  transfer.set("Text/Plain", new api.DataTransferItem("hello"));
  assert.equal(await transfer.get("text/plain").asString(), "hello");
  const file = new api.DataTransferItem(undefined, { name: "a.png", data: async () => new Uint8Array([1]) });
  assert.equal(file.asFile().name, "a.png");
  assert.equal(await file.asString(), "");
});

test("call and type hierarchy providers: execute commands and the window requests", async () => {
  const { host, api } = startedHost();
  const uri = api.Uri.file(FILE);
  const range = (line: number) => new api.Range(line, 0, line, 5);
  const foo = new api.CallHierarchyItem(api.SymbolKind.Function, "foo", "a.ts", uri, range(0), range(0));
  const bar = new api.CallHierarchyItem(api.SymbolKind.Function, "bar", "a.ts", uri, range(4), range(4));
  const registration = api.languages.registerCallHierarchyProvider("typescript", {
    prepareCallHierarchy: () => foo,
    provideCallHierarchyOutgoingCalls: (item: unknown) => (item === foo ? [new api.CallHierarchyOutgoingCall(bar, [range(2)])] : []),
    provideCallHierarchyIncomingCalls: (item: unknown) => (item === bar ? [new api.CallHierarchyIncomingCall(foo, [range(2)])] : []),
  });
  const base = new api.TypeHierarchyItem(api.SymbolKind.Class, "Base", "", uri, range(0), range(0));
  const derived = new api.TypeHierarchyItem(api.SymbolKind.Class, "Derived", "", uri, range(1), range(1));
  api.languages.registerTypeHierarchyProvider(
    { language: "typescript" },
    {
      prepareTypeHierarchy: () => [derived],
      provideTypeHierarchySupertypes: () => [base],
      provideTypeHierarchySubtypes: () => [],
    },
  );

  const items = await host.executeCommand("vscode.prepareCallHierarchy", [uri, new api.Position(0, 9)]);
  assert.deepEqual(items, [foo]);
  const outgoing = (await host.executeCommand("vscode.provideOutgoingCalls", [foo])) as any[];
  assert.equal(outgoing[0].to, bar);
  assert.equal(outgoing[0].fromRanges[0].start.line, 2);
  const incoming = (await host.executeCommand("vscode.provideIncomingCalls", [bar])) as any[];
  assert.equal(incoming[0].from, foo);
  assert.deepEqual(await host.executeCommand("vscode.provideSupertypes", [derived]), [base]);
  assert.deepEqual(await host.executeCommand("vscode.prepareTypeHierarchy", [uri, new api.Position(1, 0)]), [derived]);

  const availability = await ask(host, "availability", FILE, "typescript");
  assert.equal(availability.callHierarchy, true);
  assert.equal(availability.typeHierarchy, true);
  assert.equal(availability.inlineValues, false);
  assert.equal((await ask(host, "availability", FILE, "python")).callHierarchy, false);

  const [root] = await ask(host, "prepare", "call", FILE, 0, 9);
  assert.equal(root.name, "foo");
  assert.equal(normalizeKey(root.path), normalizeKey(FILE));
  const children = await ask(host, "children", "outgoing", root.handle);
  assert.equal(children[0].item.name, "bar");
  assert.equal(children[0].fromRanges[0].startLine, 2);
  const parents = await ask(host, "children", "incoming", children[0].item.handle);
  assert.equal(parents[0].item.name, "foo");
  const [derivedWire] = await ask(host, "prepare", "type", FILE, 1, 0);
  assert.equal((await ask(host, "children", "supertypes", derivedWire.handle))[0].item.name, "Base");

  registration.dispose();
  assert.equal((await ask(host, "availability", FILE, "typescript")).callHierarchy, false);
});

test("inline values and evaluatable expressions use the paused frame", async () => {
  const { host, api } = startedHost();
  const evaluated: string[] = [];
  host.debug.scopes = async () => [{ name: "Locals", variablesReference: 7, expensive: false }];
  host.debug.variables = async () => [{ name: "x", value: "1", variablesReference: 0 }];
  host.debug.evaluate = async (_session, expression) => {
    evaluated.push(expression);
    return { result: `<${expression}>`, type: "string", variablesReference: 0 };
  };
  const r = (line: number, from: number, to: number) => new api.Range(line, from, line, to);
  api.languages.registerInlineValuesProvider("typescript", {
    provideInlineValues: () => [
      new api.InlineValueText(r(0, 0, 3), "fixed"),
      new api.InlineValueVariableLookup(r(1, 8, 9), undefined, true),
      new api.InlineValueVariableLookup(r(1, 8, 9), "missing"),
      new api.InlineValueEvaluatableExpression(r(2, 9, 15), "bar(x)"),
    ],
  });
  const values = await ask(host, "inlineValues", FILE, { startLine: 0, endLine: 4 }, { sessionId: "s", frameId: 3 }, { line: 2, character: 2 });
  assert.deepEqual(
    values.map((v: any) => [v.line, v.text]),
    [
      [0, "fixed"],
      [1, "x = 1"],
      [2, "bar(x) = <bar(x)>"],
    ],
  );

  // Without an evaluatable provider the word under the pointer is evaluated.
  const word = await ask(host, "evaluatable", FILE, 2, 10, { sessionId: "s", frameId: 3 });
  assert.equal(word.expression, "bar");
  assert.equal(word.result, "<bar>");
  api.languages.registerEvaluatableExpressionProvider("typescript", { provideEvaluatableExpression: () => new api.EvaluatableExpression(r(2, 9, 15)) });
  const given = await ask(host, "evaluatable", FILE, 2, 10, { sessionId: "s", frameId: 3 });
  assert.equal(given.expression, "bar(x)");
  assert.deepEqual(given.range, { startLine: 2, startCharacter: 9, endLine: 2, endCharacter: 15 });
  assert.ok(evaluated.includes("bar(x)"));
});

test("drop edits: mime filter, kinds, snippets and additional edits", async () => {
  const { host, api } = startedHost();
  const Kind = api.DocumentDropOrPasteEditKind;
  let calls = 0;
  api.languages.registerDocumentDropEditProvider(
    "typescript",
    {
      provideDocumentDropEdits: async (_document: unknown, at: any, transfer: any) => {
        calls++;
        const text = await transfer.get("text/uri-list").asString();
        const edit = new api.DocumentDropEdit(new api.SnippetString("import ${1:x} from '" + text + "'"), "Import", Kind.Text.append("import"));
        edit.additionalEdit = new api.WorkspaceEdit();
        edit.additionalEdit.insert(api.Uri.file(FILE), new api.Position(0, 0), "// header\n");
        edit.additionalEdit.createFile(api.Uri.file(FILE + ".extra"));
        assert.equal(at.line, 1);
        return [edit];
      },
    },
    { dropMimeTypes: ["text/uri-list"] },
  );
  assert.deepEqual((await ask(host, "availability", FILE, "typescript")).drop, ["text/uri-list"]);
  assert.deepEqual(await ask(host, "dropEdits", FILE, 1, 4, [{ mime: "text/plain", value: "nope" }]), []);
  assert.equal(calls, 0);
  const edits = await ask(host, "dropEdits", FILE, 1, 4, [{ mime: "text/uri-list", value: "./b" }]);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].snippet, true);
  assert.equal(edits[0].insertText, "import ${1:x} from './b'");
  assert.equal(edits[0].kind, "text.import");
  assert.equal(edits[0].additional.length, 1);
  assert.equal(edits[0].additional[0].newText, "// header\n");
});

test("dropped files: a known path also arrives as a text/uri-list and asFile().uri", async () => {
  const { host, api } = startedHost();
  const captured: { seen?: { list: string | null; file: any } } = {};
  const record = async (_document: unknown, _at: unknown, transfer: any) => {
    const list = transfer.get("text/uri-list");
    captured.seen = { list: list ? await list.asString() : null, file: transfer.get("image/png").asFile() };
    return [new api.DocumentDropEdit("x", "Insert", api.DocumentDropOrPasteEditKind.Text)];
  };
  api.languages.registerDocumentDropEditProvider("typescript", { provideDocumentDropEdits: record }, { dropMimeTypes: ["text/uri-list"] });
  api.languages.registerDocumentDropEditProvider("typescript", { provideDocumentDropEdits: record });

  const path = FILE + ".png";
  const edits = await ask(host, "dropEdits", FILE, 0, 0, [{ mime: "image/png", file: { name: "a.png", path, base64: "AQ==" } }]);
  assert.equal(edits.length, 2);
  assert.ok(captured.seen);
  assert.equal(captured.seen!.list, api.Uri.file(path).toString());
  assert.equal(captured.seen!.file.name, "a.png");
  assert.equal(captured.seen!.file.uri.toString(), api.Uri.file(path).toString());

  // Without a known path the file has no URI and no URI list is invented.
  captured.seen = undefined;
  await ask(host, "dropEdits", FILE, 0, 0, [{ mime: "image/png", file: { name: "a.png", base64: "AQ==" } }]);
  const withoutPath = captured.seen as { list: string | null; file: any } | undefined;
  assert.ok(withoutPath);
  assert.equal(withoutPath.list, null);
  assert.equal(withoutPath.file.uri, undefined);

  // A URI list the window sent itself is not overwritten by the file's path.
  captured.seen = undefined;
  await ask(host, "dropEdits", FILE, 0, 0, [
    { mime: "text/uri-list", value: "file:///sent-by-window" },
    { mime: "image/png", file: { name: "a.png", path, base64: "AQ==" } },
  ]);
  const explicit = captured.seen as { list: string | null } | undefined;
  assert.equal(explicit?.list, "file:///sent-by-window");
});

test("paste edits: copy-time data, trigger kind, yieldTo and resolve", async () => {
  const { host, api } = startedHost();
  const Kind = api.DocumentDropOrPasteEditKind;
  const contexts: any[] = [];
  api.languages.registerDocumentPasteEditProvider(
    "typescript",
    {
      prepareDocumentPaste: async (_document: unknown, ranges: any[], transfer: any) => {
        transfer.set("application/x-demo", new api.DataTransferItem(`copied ${ranges[0].start.line}`));
      },
      provideDocumentPasteEdits: async (_document: unknown, _ranges: unknown, transfer: any, context: any) => {
        contexts.push(context);
        const marker = transfer.get("application/x-demo");
        const plain = new api.DocumentPasteEdit("plain", "Plain", Kind.Text);
        plain.yieldTo = [Kind.Empty.append("fancy")];
        const fancy = new api.DocumentPasteEdit(marker ? await marker.asString() : "fancy", "Fancy", Kind.Empty.append("fancy"));
        return [plain, fancy];
      },
      resolveDocumentPasteEdit: async (edit: any) => {
        edit.insertText = "resolved";
        return edit;
      },
    },
    { pasteMimeTypes: ["text/plain"], copyMimeTypes: ["application/x-demo"] },
  );
  const availability = await ask(host, "availability", FILE, "typescript");
  assert.deepEqual(availability.paste, ["text/plain"]);
  assert.equal(availability.copy, true);

  const range = { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 3 };
  const copyId = await ask(host, "preparePaste", FILE, [range]);
  assert.ok(copyId);
  const edits = await ask(host, "pasteEdits", FILE, [range], [{ mime: "text/plain", value: "abc" }], { copyId, triggerKind: 0 });
  assert.deepEqual(
    edits.map((e: any) => [e.title, e.insertText]),
    [
      ["Fancy", "copied 1"],
      ["Plain", "plain"],
    ],
  );
  assert.equal(contexts[0].triggerKind, 0);
  assert.equal(edits[0].needsResolve, true);
  assert.equal((await ask(host, "resolveEdit", edits[0].handle)).insertText, "resolved");

  const only = await ask(host, "pasteEdits", FILE, [range], [{ mime: "text/plain", value: "abc" }], { triggerKind: 1, only: "text" });
  assert.deepEqual(
    only.map((e: any) => e.title),
    ["Plain"],
  );
  assert.equal(contexts[1].triggerKind, 1);
  assert.equal(contexts[1].only.value, "text");
  assert.deepEqual(await ask(host, "pasteEdits", FILE, [range], [{ mime: "image/png", file: { name: "a.png", base64: "AQ==" } }]), []);
});
