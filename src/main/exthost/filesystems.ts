import type { ExtensionHost, ExtensionRuntime } from "./host.ts";
import { keyOfUri } from "./documents.ts";
import * as T from "./types.ts";

/**
 * File systems provided by extensions (workspace.registerFileSystemProvider):
 * `workspace.fs` and text documents with their scheme go through the
 * provider, and the window can open, edit and save those documents.
 */

export type FileSystemProvider = {
  onDidChangeFile?: T.Event<readonly { type: number; uri: T.Uri }[]>;
  stat(uri: T.Uri): unknown;
  readDirectory(uri: T.Uri): unknown;
  createDirectory(uri: T.Uri): unknown;
  readFile(uri: T.Uri): Uint8Array | PromiseLike<Uint8Array>;
  writeFile(uri: T.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): unknown;
  delete(uri: T.Uri, options: { recursive: boolean }): unknown;
  rename(oldUri: T.Uri, newUri: T.Uri, options: { overwrite: boolean }): unknown;
  copy?(source: T.Uri, destination: T.Uri, options: { overwrite: boolean }): unknown;
};

type Entry = { provider: FileSystemProvider; isReadonly: boolean; isCaseSensitive: boolean; extensionId: string };

export class FileSystems {
  readonly #host: ExtensionHost;
  readonly providers = new Map<string, Entry>();

  constructor(host: ExtensionHost) {
    this.#host = host;
  }

  register(
    runtime: ExtensionRuntime | null,
    scheme: string,
    provider: FileSystemProvider,
    options: { isCaseSensitive?: boolean; isReadonly?: boolean | { value: string } } = {},
  ): T.Disposable {
    if (scheme === "file" || scheme === "untitled") throw new Error(`the scheme '${scheme}' is reserved`);
    if (this.providers.has(scheme)) throw new Error(`a file system provider for the scheme '${scheme}' is already registered`);
    this.providers.set(scheme, { provider, isReadonly: !!options.isReadonly, isCaseSensitive: options.isCaseSensitive ?? true, extensionId: runtime?.id ?? "unknown" });
    const subscription = provider.onDidChangeFile?.((events) => {
      const paths = [...events].map((event) => keyOfUri(T.Uri.revive(event.uri)!));
      if (paths.length) this.#host.post({ type: "virtualFilesChanged", paths });
    });
    this.#announce();
    return new T.Disposable(() => {
      if (this.providers.get(scheme)?.provider !== provider) return;
      this.providers.delete(scheme);
      subscription?.dispose();
      this.#announce();
    });
  }

  #announce(): void {
    this.#host.post({ type: "fileSystems", schemes: [...this.providers.keys()] });
  }

  /** The provider of a scheme (activating `onFileSystem:<scheme>` extensions first). */
  async provider(scheme: string): Promise<Entry> {
    if (!this.providers.has(scheme)) await this.#host.activateByEvent(`onFileSystem:${scheme}`);
    const entry = this.providers.get(scheme);
    if (!entry) throw T.FileSystemError.Unavailable(`no file system provider for '${scheme}'`);
    return entry;
  }

  async readFile(uri: T.Uri): Promise<Uint8Array> {
    const { provider } = await this.provider(uri.scheme);
    return await provider.readFile(uri);
  }

  async writeFile(uri: T.Uri, content: Uint8Array): Promise<void> {
    const entry = await this.provider(uri.scheme);
    if (entry.isReadonly) throw T.FileSystemError.NoPermissions(uri);
    await entry.provider.writeFile(uri, content, { create: true, overwrite: true });
  }

  /** workspace.fs for a provided scheme. */
  api() {
    const run = async <R>(uri: T.Uri, call: (provider: FileSystemProvider, target: T.Uri) => unknown): Promise<R> => {
      const target = T.Uri.revive(uri)!;
      const { provider } = await this.provider(target.scheme);
      return (await call(provider, target)) as R;
    };
    return {
      stat: (uri: T.Uri) => run(uri, (provider, target) => provider.stat(target)),
      readDirectory: (uri: T.Uri) => run(uri, (provider, target) => provider.readDirectory(target)),
      createDirectory: (uri: T.Uri) => run<void>(uri, (provider, target) => provider.createDirectory(target)),
      readFile: (uri: T.Uri) => run<Uint8Array>(uri, (provider, target) => provider.readFile(target)),
      writeFile: (uri: T.Uri, content: Uint8Array) => run<void>(uri, (provider, target) => provider.writeFile(target, content, { create: true, overwrite: true })),
      delete: (uri: T.Uri, options: { recursive?: boolean } = {}) => run<void>(uri, (provider, target) => provider.delete(target, { recursive: !!options.recursive })),
      rename: (source: T.Uri, target: T.Uri, options: { overwrite?: boolean } = {}) =>
        run<void>(source, (provider, from) => provider.rename(from, T.Uri.revive(target)!, { overwrite: !!options.overwrite })),
      copy: (source: T.Uri, target: T.Uri, options: { overwrite?: boolean } = {}) =>
        run<void>(source, async (provider, from) => {
          const to = T.Uri.revive(target)!;
          if (provider.copy) return provider.copy(from, to, { overwrite: !!options.overwrite });
          await provider.writeFile(to, await provider.readFile(from), { create: true, overwrite: !!options.overwrite });
        }),
    };
  }

  isWritable(scheme: string): boolean | undefined {
    const entry = this.providers.get(scheme);
    return entry ? !entry.isReadonly : undefined;
  }
}
