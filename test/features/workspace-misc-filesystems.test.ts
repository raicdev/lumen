import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ExtensionHost } from "../../src/main/exthost/host.ts";
import type { FileSystemProvider } from "../../src/main/exthost/filesystems.ts";
import * as T from "../../src/main/exthost/types.ts";
import { workspaceMiscFeature } from "../../src/main/exthost/features/workspace-misc.ts";
import type { FeatureContext } from "../../src/main/exthost/features/contract.ts";
import type { HostToView } from "../../src/shared/extensions.ts";

/** node --test test/features/workspace-misc-filesystems.test.ts */

function startedHost(workspace: string | null = null) {
  const host = new ExtensionHost();
  host.init = {
    extensions: [],
    config: { lumen: {}, user: {} },
    workspace,
    userData: mkdtempSync(join(tmpdir(), "lumen-fs-")),
    appRoot: workspace ?? tmpdir(),
    appName: "Lumen",
    appVersion: "0.1.0",
    languages: [],
    webviewPort: 1,
    webviewToken: "t",
  };
  host.workspace = workspace;
  const posted: HostToView[] = [];
  host.post = (message) => void posted.push(message);
  return { host, posted };
}

function provider(overrides: Partial<FileSystemProvider> = {}): FileSystemProvider {
  return {
    stat: () => ({ type: 1 }),
    readDirectory: () => [],
    createDirectory: () => undefined,
    readFile: (uri) => new TextEncoder().encode(`content of ${uri.path}`),
    writeFile: () => undefined,
    delete: () => undefined,
    rename: () => undefined,
    ...overrides,
  };
}

test("provider folders list folders first then by name, with the window's document keys", async () => {
  const host = new ExtensionHost();
  host.post = () => {};
  const fs = provider({
    readDirectory: (uri) =>
      (uri.path === "/"
        ? [
            ["b.txt", 1],
            ["dir", 2],
            ["a.txt", 1],
            ["link", 2 | 64],
          ]
        : []) as never,
  });
  host.fileSystems.register(null, "memfs", fs);

  const listing = await host.methods.providerReadDirectory("memfs:/");
  assert.equal(listing.error, undefined);
  assert.deepEqual(
    listing.entries.map((entry) => [entry.name, entry.path, entry.isDirectory]),
    [
      ["dir", "memfs:/dir", true],
      ["link", "memfs:/link", true],
      ["a.txt", "memfs:/a.txt", false],
      ["b.txt", "memfs:/b.txt", false],
    ],
  );

  // Nested folders use the same virtual key the editor uses for provider documents.
  const nested = await host.methods.providerReadDirectory("memfs:/dir/");
  assert.deepEqual(nested.entries, []);
});

test("a read-only provider keeps its message for documents and the explorer", async () => {
  const { host, posted } = startedHost();
  host.fileSystems.register(null, "memfs", provider(), { isReadonly: { value: "The **MemFS** demo cannot be changed" } });

  assert.equal(host.fileSystems.isWritable("memfs"), false);
  const document = await host.methods.readVirtualFile("memfs:/notes.txt");
  assert.equal(document.content, "content of /notes.txt");
  assert.equal(document.readOnly, true);
  assert.equal(document.readOnlyMessage, "The **MemFS** demo cannot be changed");

  const listing = await host.methods.providerReadDirectory("memfs:/");
  assert.equal(listing.readOnly, true);
  assert.equal(listing.readOnlyMessage, "The **MemFS** demo cannot be changed");

  // The window learns the message with the scheme announcement.
  const announcement = posted.findLast((message) => message.type === "fileSystems");
  assert.deepEqual(announcement, { type: "fileSystems", schemes: ["memfs"], readOnly: { memfs: "The **MemFS** demo cannot be changed" } });

  // Explorer operations are refused with that message, before the provider is called.
  let writes = 0;
  host.fileSystems.providers.get("memfs")!.provider.writeFile = () => void writes++;
  assert.deepEqual(await host.methods.providerCreateFile("memfs:/new.txt", ""), { success: false, error: "The **MemFS** demo cannot be changed" });
  assert.deepEqual(await host.methods.providerDelete("memfs:/notes.txt"), { success: false, error: "The **MemFS** demo cannot be changed" });
  assert.equal(writes, 0);
});

test("explorer file operations go through the provider", async () => {
  const { host } = startedHost();
  const calls: string[] = [];
  host.fileSystems.register(
    null,
    "memfs",
    provider({
      createDirectory: (uri) => void calls.push(`mkdir ${uri.path}`),
      writeFile: (uri, content, options) => void calls.push(`write ${uri.path} ${options.create}/${options.overwrite} ${new TextDecoder().decode(content)}`),
      delete: (uri, options) => void calls.push(`delete ${uri.path} ${options.recursive}`),
      rename: (from, to, options) => void calls.push(`rename ${from.path} ${to.path} ${options.overwrite}`),
    }),
  );

  assert.deepEqual(await host.methods.providerCreateFile("memfs:/dir/new.txt", "hello"), { success: true });
  assert.deepEqual(await host.methods.providerCreateDirectory("memfs:/dir/sub"), { success: true });
  assert.deepEqual(await host.methods.providerRename("memfs:/dir/new.txt", "memfs:/dir/renamed.txt"), { success: true });
  assert.deepEqual(await host.methods.providerDelete("memfs:/dir/renamed.txt"), { success: true });
  assert.deepEqual(calls, [
    "write /dir/new.txt true/false hello",
    "mkdir /dir/sub",
    "rename /dir/new.txt /dir/renamed.txt false",
    "delete /dir/renamed.txt true",
  ]);

  // A provider error becomes the explorer's error message.
  host.fileSystems.providers.get("memfs")!.provider.createDirectory = () => {
    throw new Error("nope");
  };
  assert.deepEqual(await host.methods.providerCreateDirectory("memfs:/denied"), { success: false, error: "nope" });
});

test("shown provider roots are watched and the watchers are disposed", async () => {
  const { host } = startedHost();
  const watched: { uri: string; recursive: boolean; excludes: string[] }[] = [];
  let disposed = 0;
  const registration = host.fileSystems.register(
    null,
    "memfs",
    provider({
      watch: (uri, options) => {
        watched.push({ uri: uri.toString(), ...options });
        return new T.Disposable(() => void disposed++);
      },
    }),
  );

  assert.equal(await host.methods.providerWatch("memfs:/", true), true);
  assert.equal(await host.methods.providerWatch("memfs:/", true), true, "watching twice keeps one watcher");
  assert.deepEqual(watched, [{ uri: "memfs:/", recursive: true, excludes: [] }]);

  assert.equal(await host.methods.providerUnwatch("memfs:/"), true);
  assert.equal(await host.methods.providerUnwatch("memfs:/"), false);
  assert.equal(disposed, 1);

  // The provider going away disposes the watchers it still has.
  assert.equal(await host.methods.providerWatch("memfs:/", true), true);
  registration.dispose();
  assert.equal(disposed, 2);
  assert.equal(host.fileSystems.providers.has("memfs"), false);
});

test("providers without watch still list (no watcher is an error)", async () => {
  const { host } = startedHost();
  host.fileSystems.register(null, "memfs", provider());
  assert.equal(await host.methods.providerWatch("memfs:/", true), false);
  assert.equal(await host.methods.providerUnwatch("memfs:/"), false);
});

test("the workspace-misc feature announces extra folders for the explorer", async () => {
  const root = mkdtempSync(join(tmpdir(), "lumen-fs-root-"));
  const { host, posted } = startedHost(root);
  workspaceMiscFeature.init!(host);
  const folders = () =>
    posted.filter((message) => message.type === "feature" && message.area === "workspace-misc").map((message) => (message as { payload: any }).payload);

  assert.deepEqual(folders().at(-1), {
    type: "folders",
    folders: [{ uri: T.Uri.file(root).toString(), name: basename(root), scheme: "file", path: T.Uri.file(root).fsPath }],
  });

  const api = workspaceMiscFeature.api!({ host, runtime: null, extensionId: "test", notSupported: () => undefined } as unknown as FeatureContext) as any;
  assert.equal(api.workspace.updateWorkspaceFolders(1, 0, { uri: T.Uri.parse("memfs:/"), name: "MemFS" }), true);
  assert.deepEqual(folders().at(-1), {
    type: "folders",
    folders: [
      { uri: T.Uri.file(root).toString(), name: basename(root), scheme: "file", path: T.Uri.file(root).fsPath },
      { uri: "memfs:/", name: "MemFS", scheme: "memfs", path: "memfs:/" },
    ],
  });
});
