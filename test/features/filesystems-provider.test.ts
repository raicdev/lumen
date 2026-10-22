import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionHost } from "../../src/main/exthost/host.ts";
import type { FileSystemProvider } from "../../src/main/exthost/filesystems.ts";
import * as T from "../../src/main/exthost/types.ts";
import type { HostToView } from "../../src/shared/extensions.ts";
import { normalizeDocumentKey, sameDocumentKey, setFileSystemSchemes } from "../../src/shared/file-systems.ts";

/** node --test test/features/filesystems-provider.test.ts */

function startedHost() {
  const host = new ExtensionHost();
  host.init = {
    extensions: [],
    config: { lumen: {}, user: {} },
    workspace: null,
    userData: mkdtempSync(join(tmpdir(), "lumen-provider-")),
    appRoot: tmpdir(),
    appName: "Lumen",
    appVersion: "0.1.0",
    languages: [],
    webviewPort: 1,
    webviewToken: "t",
  };
  const posted: HostToView[] = [];
  host.post = (message) => void posted.push(message);
  return { host, posted };
}

function provider(overrides: Partial<FileSystemProvider> = {}): FileSystemProvider {
  return {
    stat: () => ({ type: T.FileType.File, ctime: 0, mtime: 0, size: 0 }),
    readDirectory: () => [],
    createDirectory: () => undefined,
    readFile: (uri) => new TextEncoder().encode(`content of ${uri.path}`),
    writeFile: () => undefined,
    delete: () => undefined,
    rename: () => undefined,
    ...overrides,
  };
}

function api(host: ExtensionHost): Record<string, any> {
  return host.apiFor(null) as Record<string, any>;
}

test("workspace.fs.stat hands out FileStat and FilePermission.Readonly reaches the editor and explorer", async () => {
  const { host } = startedHost();
  const stat = () => ({ type: T.FileType.File, ctime: 11, mtime: 22, size: 33, permissions: 1 });
  host.fileSystems.register(
    null,
    "memfs",
    provider({
      stat,
      readDirectory: (uri) => (uri.path === "/" ? ([["ro.txt", T.FileType.File]] as never) : ([] as never)),
    }),
  );

  const fs = host.fileSystems.api();
  assert.deepEqual(await fs.stat(T.Uri.parse("memfs:/ro.txt")), { type: T.FileType.File, ctime: 11, mtime: 22, size: 33, permissions: 1 });

  const document = await host.methods.readVirtualFile("memfs:/ro.txt");
  assert.equal(document.readOnly, true);
  assert.equal(document.readOnlyMessage, "This file is read-only.");

  const listing = await host.methods.providerReadDirectory("memfs:/");
  assert.deepEqual(listing.entries, [{ name: "ro.txt", path: "memfs:/ro.txt", isDirectory: false, readOnly: true }]);

  // Missing FileStat fields default to 0, so extensions can rely on the shape.
  host.fileSystems.providers.get("memfs")!.provider.stat = () => ({});
  assert.deepEqual(await fs.stat(T.Uri.parse("memfs:/empty")), { type: 0, ctime: 0, mtime: 0, size: 0 });
});

test("workspace.fs write methods respect a read-only provider; isWritableFileSystem knows the scheme", async () => {
  const { host } = startedHost();
  let writes = 0;
  host.fileSystems.register(
    null,
    "memfs",
    provider({
      writeFile: () => void writes++,
      createDirectory: () => void writes++,
      delete: () => void writes++,
      rename: () => void writes++,
      copy: () => void writes++,
    }),
    { isReadonly: { value: "The **MemFS** demo cannot be changed" } },
  );
  const workspace = api(host).workspace;
  const fs = workspace.fs;
  const rejectsNoPermissions = (run: Promise<unknown>) =>
    assert.rejects(run, (error: unknown) => (error as T.FileSystemError).code === "NoPermissions" && (error as Error).message.includes("MemFS"));
  const file = T.Uri.parse("memfs:/a.txt");
  await rejectsNoPermissions(fs.writeFile(file, new Uint8Array()));
  await rejectsNoPermissions(fs.createDirectory(T.Uri.parse("memfs:/dir")));
  await rejectsNoPermissions(fs.delete(file, { recursive: false }));
  await rejectsNoPermissions(fs.rename(file, T.Uri.parse("memfs:/b.txt")));
  await rejectsNoPermissions(fs.copy(file, T.Uri.parse("memfs:/c.txt")));
  assert.equal(writes, 0);

  assert.equal(fs.isWritableFileSystem("memfs"), false);
  assert.equal(fs.isWritableFileSystem("file"), true, "local files are always writable");
  assert.equal(fs.isWritableFileSystem("unknown"), undefined);

  // workspace.fs.copy goes through provider.copy when the provider has it, else read + write.
  host.fileSystems.register(
    null,
    "copyfs",
    provider({
      copy: (_from, to) => {
        writes++;
        assert.equal(to.path, "/b.txt");
      },
    }),
  );
  await fs.copy(T.Uri.parse("copyfs:/a.txt"), T.Uri.parse("copyfs:/b.txt"));
  assert.equal(writes, 1);

  host.fileSystems.register(
    null,
    "plainfs",
    provider({
      stat: (uri) => ({ type: uri.path === "/dir" ? T.FileType.Directory : T.FileType.File, ctime: 0, mtime: 0, size: 0 }),
      readDirectory: (uri) =>
        (uri.path === "/dir" ? ([["a.txt", T.FileType.File]] as never) : ([] as never)),
      readFile: () => new TextEncoder().encode("hello"),
      writeFile: (_uri, content) => void assert.equal(new TextDecoder().decode(content), "hello"),
    }),
  );
  await fs.copy(T.Uri.parse("plainfs:/dir"), T.Uri.parse("plainfs:/copy"));
});

test("file system watchers hear onDidChangeFile and Lumen's own writes, for provider and plain patterns", async () => {
  const { host } = startedHost();
  const changes = new T.EventEmitter<readonly { type: number; uri: T.Uri }[]>();
  host.fileSystems.register(null, "memfs", provider({ onDidChangeFile: changes.event }));
  const workspace = api(host).workspace;

  const events: string[] = [];
  const watcher = workspace.createFileSystemWatcher(new T.RelativePattern(T.Uri.parse("memfs:/"), "**/*.txt"));
  watcher.onDidCreate((uri: T.Uri) => events.push(`create ${uri.toString()}`));
  watcher.onDidChange((uri: T.Uri) => events.push(`change ${uri.toString()}`));
  watcher.onDidDelete((uri: T.Uri) => events.push(`delete ${uri.toString()}`));

  changes.fire([{ type: T.FileChangeType.Created, uri: T.Uri.parse("memfs:/a.txt") }]);
  changes.fire([{ type: T.FileChangeType.Changed, uri: T.Uri.parse("memfs:/a.txt") }]);
  changes.fire([{ type: T.FileChangeType.Deleted, uri: T.Uri.parse("memfs:/a.txt") }]);
  changes.fire([{ type: T.FileChangeType.Changed, uri: T.Uri.parse("memfs:/notes.md") }]);
  assert.deepEqual(events, ["create memfs:/a.txt", "change memfs:/a.txt", "delete memfs:/a.txt"]);

  // Lumen's own writes fire the watchers too (workspace.fs and explorer operations).
  await workspace.fs.writeFile(T.Uri.parse("memfs:/written.txt"), new Uint8Array());
  assert.deepEqual(events.at(-1), "change memfs:/written.txt");
  assert.deepEqual(await host.methods.providerCreateFile("memfs:/created.txt", ""), { success: true });
  assert.equal(events.at(-1), "create memfs:/created.txt");
  assert.deepEqual(await host.methods.providerDelete("memfs:/created.txt"), { success: true });
  assert.equal(events.at(-1), "delete memfs:/created.txt");
  assert.deepEqual(await host.methods.providerRename("memfs:/written.txt", "memfs:/moved.txt"), { success: true });
  assert.deepEqual(events.slice(-2), ["delete memfs:/written.txt", "create memfs:/moved.txt"]);

  // A plain pattern matches provided files too (VS Code resolves it against the workspace folders).
  const plain: string[] = [];
  const plainWatcher = workspace.createFileSystemWatcher("**/*.txt");
  plainWatcher.onDidChange((uri: T.Uri) => plain.push(uri.toString()));
  changes.fire([{ type: T.FileChangeType.Changed, uri: T.Uri.parse("memfs:/dir/x.txt") }]);
  assert.deepEqual(plain, ["memfs:/dir/x.txt"]);

  watcher.dispose();
  plainWatcher.dispose();
  changes.fire([{ type: T.FileChangeType.Changed, uri: T.Uri.parse("memfs:/dir/x.txt") }]);
  assert.equal(plain.length, 1);
});

test("workspace.onWill* / onDid* fire for explorer operations on provided folders", async () => {
  const { host } = startedHost();
  host.fileSystems.register(null, "memfs", provider());
  const seen: string[] = [];
  host.onWillCreateFiles.event((event: any) => seen.push(`will create ${event.files[0].toString()}`));
  host.onDidCreateFiles.event((event: any) => seen.push(`did create ${event.files[0].toString()}`));
  host.onWillRenameFiles.event((event: any) => seen.push(`will rename ${event.files[0].oldUri.toString()} ${event.files[0].newUri.toString()}`));
  host.onDidRenameFiles.event((event: any) => seen.push(`did rename ${event.files[0].newUri.toString()}`));
  host.onWillDeleteFiles.event((event: any) => seen.push(`will delete ${event.files[0].toString()}`));
  host.onDidDeleteFiles.event((event: any) => seen.push(`did delete ${event.files[0].toString()}`));

  // What the window does around providerCreateFile / providerRename / providerDelete.
  await host.methods.willFileOperation("create", [{ path: "memfs:/new.txt" }]);
  await host.methods.providerCreateFile("memfs:/new.txt", "");
  host.handleView({ type: "didFileOperation", kind: "create", files: [{ path: "memfs:/new.txt" }] });
  await host.methods.willFileOperation("rename", [{ oldPath: "memfs:/new.txt", newPath: "memfs:/renamed.txt" }]);
  await host.methods.providerRename("memfs:/new.txt", "memfs:/renamed.txt");
  host.handleView({ type: "didFileOperation", kind: "rename", files: [{ oldPath: "memfs:/new.txt", newPath: "memfs:/renamed.txt" }] });
  await host.methods.willFileOperation("delete", [{ path: "memfs:/renamed.txt" }]);
  await host.methods.providerDelete("memfs:/renamed.txt");
  host.handleView({ type: "didFileOperation", kind: "delete", files: [{ path: "memfs:/renamed.txt" }] });

  assert.deepEqual(seen, [
    "will create memfs:/new.txt",
    "did create memfs:/new.txt",
    "will rename memfs:/new.txt memfs:/renamed.txt",
    "did rename memfs:/renamed.txt",
    "will delete memfs:/renamed.txt",
    "did delete memfs:/renamed.txt",
  ]);
});

test("FileSystemError codes are readable in explorer results, saves and listing errors", async () => {
  const { host } = startedHost();
  host.fileSystems.register(
    null,
    "memfs",
    provider({
      readDirectory: () => {
        throw T.FileSystemError.FileNotFound("memfs:/missing");
      },
      createDirectory: () => {
        throw T.FileSystemError.NoPermissions("memfs:/root");
      },
      writeFile: () => {
        throw T.FileSystemError.NoPermissions("memfs:/root");
      },
    }),
  );

  assert.deepEqual(await host.methods.providerCreateDirectory("memfs:/denied"), { success: false, error: "memfs:/root (NoPermissions)" });
  const listing = await host.methods.providerReadDirectory("memfs:/missing");
  assert.equal(listing.error, "memfs:/missing (FileNotFound)");

  await assert.rejects(host.methods.writeVirtualFile("memfs:/a.txt", "x"), /memfs:\/root \(NoPermissions\)/);
});

test("stat resolves FileType.Unknown from readDirectory for the explorer", async () => {
  const { host } = startedHost();
  host.fileSystems.register(
    null,
    "memfs",
    provider({
      stat: (uri) => ({ type: uri.path === "/dir" ? T.FileType.Directory : T.FileType.File, ctime: 0, mtime: 0, size: 0 }),
      readDirectory: (uri) =>
        (uri.path === "/" ? ([["dir", T.FileType.Unknown], ["file", T.FileType.Unknown]] as never) : ([] as never)),
    }),
  );
  const listing = await host.methods.providerReadDirectory("memfs:/");
  assert.deepEqual(
    listing.entries.map((entry: { name: string; isDirectory: boolean }) => [entry.name, entry.isDirectory]),
    [["dir", true], ["file", false]],
  );
});

test("Quick Open lists provided files and Find in Files searches and replaces through the provider", async () => {
  const { host } = startedHost();
  const files = new Map<string, string>([
    ["/a.txt", "first needle\n"],
    ["/dir/b.txt", "a needle and another needle\n"],
    ["/dir/c.md", "needle\n"],
  ]);
  const writes: string[] = [];
  host.fileSystems.register(
    null,
    "memfs",
    provider({
      readDirectory: (uri) => {
        const prefix = uri.path.endsWith("/") ? uri.path : `${uri.path}/`;
        const names = new Map<string, number>();
        for (const path of files.keys()) {
          if (!path.startsWith(prefix)) continue;
          const rest = path.slice(prefix.length);
          const name = rest.split("/")[0]!;
          names.set(name, rest.includes("/") ? T.FileType.Directory : T.FileType.File);
        }
        return [...names].map(([name, type]) => [name, type]) as never;
      },
      readFile: (uri) => new TextEncoder().encode(files.get(uri.path) ?? ""),
      writeFile: (uri, content) => {
        writes.push(uri.path);
        files.set(uri.path, new TextDecoder().decode(content));
      },
    }),
  );

  assert.deepEqual(await host.methods.providerListFiles(["memfs:/"], 100), ["memfs:/a.txt", "memfs:/dir/b.txt", "memfs:/dir/c.md"]);

  const found = await host.methods.providerSearchFiles(["memfs:/"], "needle", { maxResults: 100 });
  assert.deepEqual(
    found.matches.map((match) => [match.path, match.relativePath, match.line, match.column, match.length]),
    [
      ["memfs:/a.txt", "a.txt", 0, 6, 6],
      ["memfs:/dir/b.txt", "dir/b.txt", 0, 2, 6],
      ["memfs:/dir/b.txt", "dir/b.txt", 0, 21, 6],
      ["memfs:/dir/c.md", "dir/c.md", 0, 0, 6],
    ],
  );
  assert.equal(found.truncated, false);

  const markdown = await host.methods.providerSearchFiles(["memfs:/"], "needle", { include: "*.md", maxResults: 100 });
  assert.deepEqual(markdown.matches.map((match) => match.path), ["memfs:/dir/c.md"]);

  const replaced = await host.methods.providerReplaceFiles(["memfs:/"], "needle", "pin", {}, ["memfs:/a.txt", "memfs:/dir/b.txt"]);
  assert.deepEqual(replaced, { replacements: 3, files: 2 });
  assert.deepEqual(writes.sort(), ["/a.txt", "/dir/b.txt"]);
  assert.equal(files.get("/a.txt"), "first pin\n");
  assert.equal(files.get("/dir/c.md"), "needle\n", "paths limits the replacement");
});

test("isCaseSensitive: false providers share documents and watcher paths across path case", async () => {
  const { host } = startedHost();
  const changes = new T.EventEmitter<readonly { type: number; uri: T.Uri }[]>();
  host.fileSystems.register(null, "casefs", provider({ onDidChangeFile: changes.event }), { isCaseSensitive: false });
  host.fileSystems.register(null, "exactfs", provider(), { isCaseSensitive: true });

  const upper = await host.openDocument(T.Uri.parse("casefs:/Docs/Readme.MD"));
  assert.equal(upper.key, "casefs:/Docs/Readme.MD", "the provider sees the original casing");
  assert.equal(host.documentForUri(T.Uri.parse("casefs:/docs/readme.md")), upper);
  assert.equal(await host.openDocument(T.Uri.parse("casefs:/docs/README.md")), upper);
  assert.equal(host.documents.size, 1, "one document for every casing");

  // The default (isCaseSensitive: true) keeps paths distinct, exactly as before.
  const exact = await host.openDocument(T.Uri.parse("exactfs:/Docs/Readme.MD"));
  assert.equal(host.documentForUri(T.Uri.parse("exactfs:/docs/readme.md")), undefined);
  assert.notEqual(await host.openDocument(T.Uri.parse("exactfs:/docs/readme.md")), exact);

  const heard: string[] = [];
  const watcher = api(host).workspace.createFileSystemWatcher(new T.RelativePattern(T.Uri.parse("casefs:/Docs"), "**/*.md"));
  watcher.onDidChange((uri: T.Uri) => heard.push(uri.toString()));
  changes.fire([{ type: T.FileChangeType.Changed, uri: T.Uri.parse("casefs:/docs/READme.md") }]);
  assert.deepEqual(heard, ["casefs:/docs/READme.md"], "a case-insensitive root contains the changed path");

  const exactChanges = new T.EventEmitter<readonly { type: number; uri: T.Uri }[]>();
  host.fileSystems.register(null, "exactwatch", provider({ onDidChangeFile: exactChanges.event }), { isCaseSensitive: true });
  const exactHeard: string[] = [];
  const exactWatcher = api(host).workspace.createFileSystemWatcher(new T.RelativePattern(T.Uri.parse("exactwatch:/Docs"), "**/*.md"));
  exactWatcher.onDidChange((uri: T.Uri) => exactHeard.push(uri.toString()));
  exactChanges.fire([{ type: T.FileChangeType.Changed, uri: T.Uri.parse("exactwatch:/docs/a.md") }]);
  assert.deepEqual(exactHeard, [], "a case-sensitive provider's root does not contain another casing");

  watcher.dispose();
  exactWatcher.dispose();
});

test("case-insensitive providers resolve root-relative search paths", async () => {
  const { host } = startedHost();
  const files = new Map<string, string>([["/dir/a.txt", "a needle\n"]]);
  host.fileSystems.register(
    null,
    "searchfs",
    provider({
      readDirectory: (uri) => {
        // The provider itself treats paths case-insensitively, as a real one would.
        const path = uri.path.toLowerCase().replace(/\/+$/, "") || "/";
        const prefix = path === "/" ? "/" : `${path}/`;
        const names = new Map<string, number>();
        for (const file of files.keys()) {
          if (!file.startsWith(prefix)) continue;
          const rest = file.slice(prefix.length);
          const name = rest.split("/")[0]!;
          names.set(name, rest.includes("/") ? T.FileType.Directory : T.FileType.File);
        }
        return [...names].map(([name, type]) => [name, type]) as never;
      },
      readFile: (uri) => new TextEncoder().encode(files.get(uri.path.toLowerCase()) ?? ""),
    }),
    { isCaseSensitive: false },
  );

  assert.deepEqual(await host.methods.providerListFiles(["searchfs:/DIR"], 100), ["searchfs:/DIR/a.txt"]);
  const found = await host.methods.providerSearchFiles(["searchfs:/DIR"], "needle", { maxResults: 10 });
  assert.deepEqual(
    found.matches.map((match) => [match.path, match.relativePath]),
    [["searchfs:/DIR/a.txt", "a.txt"]],
  );
});

test("window document keys follow the provider's isCaseSensitive", () => {
  setFileSystemSchemes(["casewin", "exactwin"], ["exactwin"]);
  assert.equal(normalizeDocumentKey("casewin:/A/B.TXT"), "casewin:/a/b.txt");
  assert.ok(sameDocumentKey("casewin:/A/B.txt", "casewin:/a/b.TXT"));
  assert.equal(normalizeDocumentKey("exactwin:/A/B.TXT"), "exactwin:/A/B.TXT");
  assert.ok(!sameDocumentKey("exactwin:/A/B.txt", "exactwin:/a/b.TXT"));
  // Local files, untitled documents and content-provider tabs keep the window's case-insensitive keys.
  assert.equal(normalizeDocumentKey("C:\\Dir\\A.TXT"), "c:\\dir\\a.txt");
  assert.equal(normalizeDocumentKey("untitled:Untitled-1"), "untitled:untitled-1");
});
