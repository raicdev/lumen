import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ExtensionHost } from "../../src/main/exthost/host.ts";
import * as T from "../../src/main/exthost/types.ts";
import { decodeBytes, encodeText } from "../../src/main/exthost/features/workspace-misc/encoding.ts";
import { WorkspaceFolders } from "../../src/main/exthost/features/workspace-misc/folders.ts";
import { isPortable, readValidation, workspaceMiscFeature } from "../../src/main/exthost/features/workspace-misc.ts";
import { decodeValidation, encodeValidation } from "../../src/shared/workspace-misc.ts";
import type { HostToView } from "../../src/shared/extensions.ts";

/** node --test test/features/workspace-misc.test.ts */

const ROOT = resolve(import.meta.dirname, "..", "..");

function startedHost(workspace: string | null = null) {
  const host = new ExtensionHost();
  host.init = { extensions: [], config: { lumen: {}, user: {} }, workspace, userData: mkdtempSync(join(tmpdir(), "lumen-wm-")), appRoot: ROOT, appName: "Lumen", appVersion: "0.1.0", languages: [], webviewPort: 1, webviewToken: "t" };
  host.workspace = workspace;
  const posted: HostToView[] = [];
  host.post = (message) => void posted.push(message);
  return { host, posted };
}

test("decode honors BOMs and explicit encodings", () => {
  assert.equal(decodeBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])), "hi");
  assert.equal(decodeBytes(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])), "hi");
  assert.equal(decodeBytes(new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69])), "hi");
  assert.equal(decodeBytes(new Uint8Array([0xe9]), "latin1"), "é");
  assert.equal(decodeBytes(new Uint8Array([0x80]), "windows1252"), "€");
  assert.equal(decodeBytes(new Uint8Array([0x00, 0x68]), "utf-16be"), "h");
  assert.equal(decodeBytes(new Uint8Array([0x82, 0xa0]), "shiftjis"), "あ");
  assert.throws(() => decodeBytes(new Uint8Array([1]), "nope"));
});

test("encode round-trips and writes BOMs where VS Code does", () => {
  assert.deepEqual([...encodeText("aé")], [0x61, 0xc3, 0xa9]);
  assert.deepEqual([...encodeText("a", "utf8bom")], [0xef, 0xbb, 0xbf, 0x61]);
  assert.deepEqual([...encodeText("a", "utf16le")], [0xff, 0xfe, 0x61, 0x00]);
  assert.deepEqual([...encodeText("a", "utf16be")], [0xfe, 0xff, 0x00, 0x61]);
  assert.deepEqual([...encodeText("€中", "windows1252")], [0x80, 0x3f]);
  for (const encoding of ["utf8", "utf8bom", "utf16le", "utf16be", "windows1252"]) assert.equal(decodeBytes(encodeText("héllo", encoding), encoding), "héllo");
});

test("workspace folders: add, remove, replace and events", () => {
  const folders = new WorkspaceFolders(resolve("/a/root"));
  const events: { added: string[]; removed: string[] }[] = [];
  folders.onDidChange((e) => events.push({ added: e.added.map((f) => `${f.index}:${f.name}`), removed: e.removed.map((f) => f.name) }));
  const uri = (p: string) => T.Uri.file(resolve(p));
  assert.equal(folders.update(0, 0, []).ok, false);
  assert.equal(folders.update(5, 0, [{ uri: uri("/b") }]).ok, false);
  assert.equal(folders.update(1, 0, [{ uri: uri("/b") }, { uri: uri("/b") }]).ok, false, "duplicates");
  assert.equal(folders.update(1, 0, [{ uri: uri("/a/root") }]).ok, false, "already present");
  assert.deepEqual(folders.update(1, 0, [{ uri: uri("/b"), name: "Bee" }]), { ok: true, wantedRoot: undefined });
  assert.deepEqual(folders.folders.map((f) => f.name), ["root", "Bee"]);
  assert.equal(folders.folderOf(T.Uri.file(resolve("/b/x/y")))?.name, "Bee");
  assert.equal(folders.folderOf(T.Uri.file(resolve("/c"))), undefined);
  // replacing the first folder asks the window to open the new one
  const replaced = folders.update(0, 1, [{ uri: uri("/c") }]);
  assert.equal(replaced.wantedRoot?.toLowerCase(), resolve("/c").toLowerCase());
  // the window then follows: no extra event
  const count = events.length;
  folders.syncRoot(resolve("/c"));
  assert.equal(events.length, count);
  assert.deepEqual(folders.folders.map((f) => f.name), ["c", "Bee"]);
  assert.deepEqual(events[0], { added: ["1:Bee"], removed: [] });
  // removing all closes the window's folder
  assert.equal(folders.update(0, undefined, []).wantedRoot, null);
  assert.deepEqual(folders.folders, []);
});

test("window root changes reach the folder list", () => {
  const folders = new WorkspaceFolders(null);
  const seen: number[] = [];
  folders.onDidChange((e) => seen.push(e.added.length - e.removed.length));
  folders.syncRoot(resolve("/p"));
  folders.syncRoot(resolve("/q"));
  assert.deepEqual(folders.folders.map((f) => f.name), ["q"]);
  assert.deepEqual(seen, [1, 0]);
});

test("validation severity is encoded for the window", () => {
  assert.deepEqual(readValidation({ message: "careful", severity: 2 }), { message: "careful", severity: 2 });
  assert.deepEqual(readValidation("bad"), { message: "bad", severity: 3 });
  assert.equal(readValidation(undefined), null);
  assert.equal(readValidation(""), null);
  assert.deepEqual(decodeValidation(encodeValidation("hm", 1)), { message: "hm", severity: "info" });
  assert.deepEqual(decodeValidation(encodeValidation("hm", 2)), { message: "hm", severity: "warning" });
  assert.deepEqual(decodeValidation(encodeValidation("hm", 3)), { message: "hm", severity: "error" });
  assert.equal(encodeValidation("", 2), null);
});

test("portable detection", () => {
  assert.equal(isPortable(ROOT, join(tmpdir(), "x"), { LUMEN_PORTABLE: "1" }), true);
  assert.equal(isPortable(ROOT, join(tmpdir(), "x"), {}), false);
  assert.equal(isPortable(ROOT, join(ROOT, "data"), {}), true);
});

test("the API: types, saveAs, decode/encode, updateWorkspaceFolders, URI handler, severity, FilePermission", async () => {
  await import("../../src/main/exthost/api.ts");
  await new Promise((done) => setTimeout(done, 50));
  const dir = mkdtempSync(join(tmpdir(), "lumen-wm-ws-"));
  const { host } = startedHost(dir);
  const api = host.apiFor(null) as any;
  assert.equal(api.InputBoxValidationSeverity.Warning, 2);
  assert.equal(api.QuickInputButtonLocation.Inline, 2);
  assert.equal(api.FilePermission.Readonly, 1);
  assert.equal(new api.TelemetryTrustedValue("x").value, "x");
  assert.equal(typeof api.env.isAppPortable, "boolean");

  // decode / encode
  assert.equal(await api.workspace.decode(new Uint8Array([0xff, 0xfe, 0x68, 0x00])), "h");
  assert.equal(await api.workspace.decode(new Uint8Array([0xe9]), { encoding: "iso88591" }), "é");
  host.config = { lumen: { "files.encoding": "utf16le" }, user: {} };
  assert.deepEqual([...(await api.workspace.encode("a"))], [0xff, 0xfe, 0x61, 0x00]);

  // saveAs
  host.requestMain = (async (method: string) => (method === "showSaveDialog" ? join(dir, "out.txt") : null)) as any;
  const calls: unknown[][] = [];
  host.requestView = (async (method: string, ...args: unknown[]) => {
    calls.push([method, ...args]);
    return true;
  }) as any;
  const saved = await api.workspace.saveAs(T.Uri.file(join(dir, "in.txt")));
  assert.equal(saved.fsPath.toLowerCase(), join(dir, "out.txt").toLowerCase());
  assert.deepEqual(calls[0]!.map((v) => String(v).toLowerCase()), ["savedocumentas", join(dir, "in.txt").toLowerCase(), join(dir, "out.txt").toLowerCase()]);

  // updateWorkspaceFolders
  const changes: any[] = [];
  api.workspace.onDidChangeWorkspaceFolders((e: any) => changes.push(e));
  const other = mkdtempSync(join(tmpdir(), "lumen-wm-other-"));
  assert.equal(api.workspace.updateWorkspaceFolders(1, 0, { uri: T.Uri.file(other), name: "Other" }), true);
  assert.equal(api.workspace.workspaceFolders.length, 2);
  assert.equal(api.workspace.getWorkspaceFolder(T.Uri.file(join(other, "a.txt"))).name, "Other");
  assert.equal(api.workspace.asRelativePath(join(other, "a.txt")), "Other/a.txt");
  assert.equal(changes[0].added[0].name, "Other");
  assert.equal(api.workspace.updateWorkspaceFolders(1, 0), false);

  // URI handler
  const disposable = api.window.registerUriHandler({ handleUri() {} });
  assert.throws(() => api.window.registerUriHandler({ handleUri() {} }), /already registered/);
  disposable.dispose();
  api.window.registerUriHandler({ handleUri() {} }).dispose();
  assert.equal(await host.executeCommand("lumen.handleUri", ["lumen://unknown/x"]), false);

  // input box severity
  const box = api.window.createInputBox();
  box.validationMessage = { message: "watch out", severity: api.InputBoxValidationSeverity.Warning };
  assert.deepEqual(box.validationMessage, { message: "watch out", severity: 2 });

  // FilePermission
  const file = join(dir, "ro.txt");
  writeFileSync(file, "x");
  chmodSync(file, 0o444);
  assert.equal((await api.workspace.fs.stat(T.Uri.file(file))).permissions, 1);
  assert.ok(workspaceMiscFeature.commands?.includes("lumen.handleUri"));
});
