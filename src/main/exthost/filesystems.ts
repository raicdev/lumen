import { matchGlob } from "../../shared/glob.ts";
import type { SearchMatch } from "../../shared/types.ts";
import type { ExtensionHost, ExtensionRuntime } from "./host.ts";
import { keyOfUri, normalizeKey, uriOfKey } from "./documents.ts";
import { removeFileSystemScheme, setFileSystemCaseSensitivity } from "../../shared/file-systems.ts";
import * as T from "./types.ts";

/**
 * File systems provided by extensions (workspace.registerFileSystemProvider):
 * `workspace.fs` and text documents with their scheme go through the
 * provider, and the window can open, edit and save those documents. Workspace
 * folders of those schemes are listed in the explorer, whose file operations
 * and folder watchers go through the provider too.
 */

export type FileSystemProvider = {
  onDidChangeFile?: T.Event<readonly { type: number; uri: T.Uri }[]>;
  watch?(uri: T.Uri, options: { recursive: boolean; excludes: string[] }): T.Disposable;
  stat(uri: T.Uri): unknown;
  readDirectory(uri: T.Uri): unknown;
  createDirectory(uri: T.Uri): unknown;
  readFile(uri: T.Uri): Uint8Array | PromiseLike<Uint8Array>;
  writeFile(uri: T.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): unknown;
  delete(uri: T.Uri, options: { recursive: boolean }): unknown;
  rename(oldUri: T.Uri, newUri: T.Uri, options: { overwrite: boolean }): unknown;
  copy?(source: T.Uri, destination: T.Uri, options: { overwrite: boolean }): unknown;
};

/** FileStat as the API hands it out (missing fields default to 0, like VS Code). */
export type FileStat = { type: number; ctime: number; mtime: number; size: number; permissions?: number };

/** A row of the explorer for a provided folder (paths are the window's document keys). */
export type FileSystemEntry = { name: string; path: string; isDirectory: boolean; readOnly?: boolean };
export type FileSystemListing = { entries: FileSystemEntry[]; readOnly?: boolean; readOnlyMessage?: string; error?: string };
export type FileSystemResult = { success: boolean; error?: string };
export type FileSearchOptions = { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean; include?: string; exclude?: string; maxResults?: number };
export type FileSearchResult = { matches: SearchMatch[]; truncated: boolean };
export type FileReplaceResult = { replacements: number; files: number; error?: string };

type Entry = { provider: FileSystemProvider; isReadonly: boolean; readonlyMessage?: string; isCaseSensitive: boolean; extensionId: string };

/** FilePermission.Readonly (the enum is exported by the workspace-misc feature). */
const READONLY = 1;
/** How deep Quick Open / Find in Files walk a provided folder, and how much they look at. */
const MAX_DEPTH = 32;
const MAX_FILES = 20_000;
const MAX_SEARCH_BYTES = 5 * 1024 * 1024;

/** An explorer / save message: FileSystemError codes stay readable (`x (FileNotFound)`). */
export const messageOf = (error: unknown) => {
  if (error instanceof T.FileSystemError && error.code !== "Unknown") return `${error.message} (${error.code})`;
  return error instanceof Error ? error.message : String(error);
};

const statOf = (raw: unknown): FileStat => {
  const value = (raw ?? {}) as Partial<FileStat>;
  return {
    type: typeof value.type === "number" ? value.type : 0,
    ctime: typeof value.ctime === "number" ? value.ctime : 0,
    mtime: typeof value.mtime === "number" ? value.mtime : 0,
    size: typeof value.size === "number" ? value.size : 0,
    ...(typeof value.permissions === "number" ? { permissions: value.permissions } : {}),
  };
};

/** `**`-globs of a files.include / files.exclude field, matched like the local search does. */
function globMatcher(value: string | undefined, relative: string, name: string): boolean {
  const globs = (value ?? "")
    .split(",")
    .map((glob) => glob.trim())
    .filter(Boolean);
  if (!globs.length) return false;
  return globs.some((glob) => matchGlob(glob, relative) || matchGlob(`**/${glob}`, relative) || (!glob.includes("/") && matchGlob(glob, name)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The regular expression of a search (whole word / regex / case, like the local search). */
function searchExpression(query: string, options: FileSearchOptions): RegExp {
  let pattern = options.regex ? query : escapeRegExp(query);
  if (options.wholeWord) pattern = `\\b(?:${pattern})\\b`;
  return new RegExp(pattern, options.caseSensitive ? "g" : "gi");
}

export class FileSystems {
  readonly #host: ExtensionHost;
  readonly providers = new Map<string, Entry>();
  /** Folders the explorer shows, so they are watched while their providers live. */
  readonly #watchers = new Map<string, { scheme: string; disposable: T.Disposable }>();

  constructor(host: ExtensionHost) {
    this.#host = host;
  }

  register(
    runtime: ExtensionRuntime | null,
    scheme: string,
    provider: FileSystemProvider,
    options: { isCaseSensitive?: boolean; isReadonly?: boolean | { value: string } } = {},
  ): T.Disposable {
    if (!/^\w[\w+.-]*$/.test(scheme)) throw new Error(`the scheme '${scheme}' is not valid`);
    if (scheme === "file" || scheme === "untitled") throw new Error(`the scheme '${scheme}' is reserved`);
    if (this.providers.has(scheme)) throw new Error(`a file system provider for the scheme '${scheme}' is already registered`);
    const message = typeof options.isReadonly === "object" ? options.isReadonly?.value : undefined;
    const isCaseSensitive = options.isCaseSensitive ?? true;
    this.providers.set(scheme, {
      provider,
      isReadonly: !!options.isReadonly,
      readonlyMessage: message,
      isCaseSensitive,
      extensionId: runtime?.id ?? "unknown",
    });
    setFileSystemCaseSensitivity(scheme, isCaseSensitive);
    const subscription = provider.onDidChangeFile?.((events) => {
      const changes = [...events].flatMap((event) => {
        const uri = T.Uri.revive(event.uri);
        return uri ? [{ uri, path: keyOfUri(uri), type: Number(event.type) || T.FileChangeType.Changed }] : [];
      });
      if (!changes.length) return;
      this.#host.post({ type: "virtualFilesChanged", paths: changes.map((change) => change.path), changes: changes.map(({ path, type }) => ({ path, type })) });
      this.#host.filesChangedUris(changes);
    });
    this.#announce();
    return new T.Disposable(() => {
      if (this.providers.get(scheme)?.provider !== provider) return;
      this.providers.delete(scheme);
      removeFileSystemScheme(scheme);
      subscription?.dispose();
      this.#disposeWatchers(scheme);
      this.#announce();
    });
  }

  #announce(): void {
    const readOnly: Record<string, string | true> = {};
    const caseSensitive: string[] = [];
    let anyCaseInsensitive = false;
    for (const [scheme, entry] of this.providers) {
      if (entry.isReadonly) readOnly[scheme] = entry.readonlyMessage ?? true;
      if (entry.isCaseSensitive) caseSensitive.push(scheme);
      else anyCaseInsensitive = true;
    }
    // Without a case-insensitive provider every scheme is sensitive, the window's default.
    this.#host.post({ type: "fileSystems", schemes: [...this.providers.keys()], readOnly, ...(anyCaseInsensitive ? { caseSensitive } : {}) });
  }

  /** The provider of a scheme (activating `onFileSystem:<scheme>` extensions first). */
  async provider(scheme: string): Promise<Entry> {
    if (!this.providers.has(scheme)) await this.#host.activateByEvent(`onFileSystem:${scheme}`);
    const entry = this.providers.get(scheme);
    if (!entry) throw T.FileSystemError.Unavailable(`no file system provider for '${scheme}'`);
    return entry;
  }

  async stat(uri: T.Uri): Promise<FileStat> {
    const { provider } = await this.provider(uri.scheme);
    return statOf(await provider.stat(uri));
  }

  async readFile(uri: T.Uri): Promise<Uint8Array> {
    const { provider } = await this.provider(uri.scheme);
    return await provider.readFile(uri);
  }

  async writeFile(uri: T.Uri, content: Uint8Array): Promise<void> {
    const entry = await this.provider(uri.scheme);
    if (entry.isReadonly) throw T.FileSystemError.NoPermissions(entry.readonlyMessage ?? uri);
    let created = false;
    try {
      await entry.provider.stat(uri);
    } catch {
      created = true;
    }
    await entry.provider.writeFile(uri, content, { create: true, overwrite: true });
    // The window reloads its clean editors from the save; watchers still hear about it.
    this.#fire(uri, created ? T.FileChangeType.Created : T.FileChangeType.Changed, false);
  }

  /** The extension's message for a read-only scheme (registerFileSystemProvider's `{ value }`). */
  readOnlyMessage(scheme: string): string | undefined {
    return this.providers.get(scheme)?.readonlyMessage;
  }

  /** Children of a provided folder, folders first then by name (like the local explorer). */
  async list(uri: T.Uri): Promise<FileSystemListing> {
    try {
      const entry = await this.provider(uri.scheme);
      const listed = (await entry.provider.readDirectory(uri)) as unknown;
      const entries: FileSystemEntry[] = [];
      for (const item of Array.isArray(listed) ? listed : []) {
        if (!Array.isArray(item) || typeof item[0] !== "string") continue;
        const name = item[0];
        const child = T.Uri.joinPath(uri, name);
        let type = Number(item[1]) || 0;
        let readOnly = false;
        // VS Code asks stat for the children it shows: it resolves FileType.Unknown and
        // FilePermission.Readonly (a single read-only file). Providers may fail it.
        try {
          const stats = statOf(await entry.provider.stat(child));
          if (!(type & (T.FileType.File | T.FileType.Directory)) && stats.type) type = stats.type;
          readOnly = !!(stats.permissions && stats.permissions & READONLY);
        } catch {
          /* the type from readDirectory is enough */
        }
        entries.push({ name, path: keyOfUri(child), isDirectory: (type & T.FileType.Directory) !== 0, ...(readOnly ? { readOnly: true } : {}) });
      }
      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });
      return { entries, ...(entry.isReadonly ? { readOnly: true, readOnlyMessage: entry.readonlyMessage } : {}) };
    } catch (error) {
      return { entries: [], error: messageOf(error) };
    }
  }

  async createFile(uri: T.Uri, content = new Uint8Array()): Promise<FileSystemResult> {
    return await this.#write(uri, (provider, target) => provider.writeFile(target, content, { create: true, overwrite: false }), T.FileChangeType.Created);
  }

  async createDirectory(uri: T.Uri): Promise<FileSystemResult> {
    return await this.#write(uri, (provider, target) => provider.createDirectory(target), T.FileChangeType.Created);
  }

  async delete(uri: T.Uri): Promise<FileSystemResult> {
    return await this.#write(uri, (provider, target) => provider.delete(target, { recursive: true }), T.FileChangeType.Deleted);
  }

  async rename(from: T.Uri, to: T.Uri): Promise<FileSystemResult> {
    if (from.scheme !== to.scheme) return { success: false, error: "cannot move a file to another file system" };
    try {
      const entry = await this.provider(from.scheme);
      if (entry.isReadonly) return this.#readOnlyError(entry, from);
      await entry.provider.rename(from, to, { overwrite: false });
      this.#fire(from, T.FileChangeType.Deleted);
      this.#fire(to, T.FileChangeType.Created);
      return { success: true };
    } catch (error) {
      return { success: false, error: messageOf(error) };
    }
  }

  /** Copy for the explorer (a move is rename): provider.copy, or a read + write of every file. */
  async copy(source: T.Uri, destination: T.Uri): Promise<FileSystemResult> {
    if (source.scheme !== destination.scheme) return { success: false, error: "cannot copy a file to another file system" };
    try {
      const entry = await this.provider(source.scheme);
      if (entry.isReadonly) return this.#readOnlyError(entry, source);
      await this.#copy(entry.provider, source, destination, { overwrite: false });
      this.#fire(destination, T.FileChangeType.Created);
      return { success: true };
    } catch (error) {
      return { success: false, error: messageOf(error) };
    }
  }

  /** Watch a folder the explorer shows (recursive), so onDidChangeFile can come without polling. */
  async watch(uri: T.Uri, recursive: boolean): Promise<boolean> {
    const key = normalizeKey(uri.toString());
    if (this.#watchers.has(key)) return true;
    try {
      const entry = await this.provider(uri.scheme);
      if (!entry.provider.watch) return false;
      this.#watchers.set(key, { scheme: uri.scheme, disposable: entry.provider.watch(uri, { recursive, excludes: [] }) });
      return true;
    } catch (error) {
      this.#host.log("warning", `could not watch ${key}: ${messageOf(error)}`);
      return false;
    }
  }

  unwatch(uri: T.Uri): boolean {
    const key = normalizeKey(uri.toString());
    const watcher = this.#watchers.get(key);
    if (!watcher) return false;
    this.#watchers.delete(key);
    watcher.disposable.dispose();
    return true;
  }

  /** Files under provided roots for Quick Open (bounded depth and count). */
  async listFiles(roots: readonly string[], maxResults = MAX_FILES): Promise<string[]> {
    const files: string[] = [];
    const seen = new Set<string>();
    for (const root of roots) {
      const entry = await this.provider(uriOfKey(root).scheme).catch(() => null);
      if (!entry) continue;
      await this.#walk(
        uriOfKey(root),
        entry.provider,
        async (child, isDirectory) => {
          if (isDirectory) return;
          const path = keyOfUri(child);
          const key = normalizeKey(path);
          if (seen.has(key)) return;
          seen.add(key);
          files.push(path);
        },
        () => files.length >= maxResults,
      );
      if (files.length >= maxResults) break;
    }
    return files;
  }

  /** Find in Files for provided roots: the same query semantics as the local search. */
  async searchFiles(roots: readonly string[], query: string, options: FileSearchOptions = {}): Promise<FileSearchResult> {
    const matches: SearchMatch[] = [];
    const maxResults = options.maxResults ?? 2000;
    let truncated = false;
    let expression: RegExp;
    try {
      expression = searchExpression(query, options);
    } catch (error) {
      return { matches, truncated };
    }
    for (const root of roots) {
      const rootUri = uriOfKey(root);
      const entry = await this.provider(rootUri.scheme).catch(() => null);
      if (!entry) continue;
      await this.#walk(
        rootUri,
        entry.provider,
        async (child, isDirectory) => {
          if (truncated || isDirectory) return;
          const relative = relativeTo(rootUri, child);
          const name = relative.split("/").pop() ?? relative;
          if (globMatcher(options.exclude, relative, name)) return;
          if ((options.include ?? "").trim() && !globMatcher(options.include, relative, name)) return;
          let text: string;
          try {
            const content = await entry.provider.readFile(child);
            if (content.byteLength > MAX_SEARCH_BYTES) return;
            text = new TextDecoder().decode(content);
          } catch {
            return;
          }
          if (text.includes("\u0000")) return;
          const lines = text.replace(/\r\n?/g, "\n").split("\n");
          for (let line = 0; line < lines.length; line++) {
            expression.lastIndex = 0;
            for (let found = expression.exec(lines[line]!); found; found = expression.exec(lines[line]!)) {
              if (!found[0]) {
                expression.lastIndex++;
                continue;
              }
              matches.push({ path: keyOfUri(child), relativePath: relative, line, column: found.index, length: found[0].length, preview: lines[line]! });
              if (matches.length >= maxResults) {
                truncated = true;
                return;
              }
            }
          }
        },
        () => truncated,
      );
      if (truncated) break;
    }
    return { matches, truncated };
  }

  /** Replace in Files for provided roots (only the files in `paths`, when given). */
  async replaceFiles(
    roots: readonly string[],
    query: string,
    replacement: string,
    options: FileSearchOptions = {},
    paths?: readonly string[],
  ): Promise<FileReplaceResult> {
    const wanted = paths ? new Set(paths.map(normalizeKey)) : null;
    let replacements = 0;
    let files = 0;
    let blocked: string | undefined;
    let expression: RegExp;
    try {
      expression = searchExpression(query, options);
    } catch (error) {
      return { replacements, files, error: messageOf(error) };
    }
    for (const root of roots) {
      const rootUri = uriOfKey(root);
      const entry = await this.provider(rootUri.scheme).catch(() => null);
      if (!entry) continue;
      if (entry.isReadonly) {
        if (!wanted || [...wanted].some((path) => uriOfKey(path).scheme === rootUri.scheme))
          blocked ??= entry.readonlyMessage ?? `${rootUri.scheme} is read-only`;
        continue;
      }
      await this.#walk(
        rootUri,
        entry.provider,
        async (child, isDirectory) => {
          if (isDirectory) return;
          if (wanted && !wanted.has(normalizeKey(keyOfUri(child)))) return;
          const relative = relativeTo(rootUri, child);
          const name = relative.split("/").pop() ?? relative;
          if (globMatcher(options.exclude, relative, name)) return;
          if ((options.include ?? "").trim() && !globMatcher(options.include, relative, name)) return;
          let text: string;
          try {
            const content = await entry.provider.readFile(child);
            if (content.byteLength > MAX_SEARCH_BYTES) return;
            text = new TextDecoder().decode(content);
          } catch {
            return;
          }
          if (text.includes("\u0000")) return;
          let count = 0;
          const next = text.replace(expression, (match) => {
            count++;
            // Regular expressions expand $1, $&, … in the replacement (like the local search).
            if (!options.regex) return replacement;
            return match.replace(new RegExp(expression.source, expression.flags.replace("g", "")), replacement);
          });
          if (!count) return;
          try {
            await entry.provider.writeFile(child, new TextEncoder().encode(next), { create: false, overwrite: true });
          } catch (error) {
            return;
          }
          replacements += count;
          files++;
          this.#fire(child, T.FileChangeType.Changed);
        },
        () => false,
      );
    }
    return { replacements, files, ...(blocked && !files ? { error: blocked } : {}) };
  }

  async #write(uri: T.Uri, call: (provider: FileSystemProvider, target: T.Uri) => unknown, change: number): Promise<FileSystemResult> {
    try {
      const entry = await this.provider(uri.scheme);
      if (entry.isReadonly) return this.#readOnlyError(entry, uri);
      await call(entry.provider, uri);
      this.#fire(uri, change);
      return { success: true };
    } catch (error) {
      return { success: false, error: messageOf(error) };
    }
  }

  /** provider.copy for a folder too; without it, read + write every file (and create the folders). */
  async #copy(provider: FileSystemProvider, from: T.Uri, to: T.Uri, options: { overwrite: boolean }): Promise<void> {
    if (provider.copy) {
      await provider.copy(from, to, options);
      return;
    }
    let isDirectory = false;
    try {
      isDirectory = (statOf(await provider.stat(from)).type & T.FileType.Directory) !== 0;
    } catch {
      /* a provider without a usable stat still can read the file */
    }
    if (!isDirectory) {
      await provider.writeFile(to, await provider.readFile(from), { create: true, overwrite: options.overwrite });
      return;
    }
    await provider.createDirectory(to);
    const listed = (await provider.readDirectory(from)) as unknown;
    for (const item of Array.isArray(listed) ? listed : []) {
      if (!Array.isArray(item) || typeof item[0] !== "string") continue;
      await this.#copy(provider, T.Uri.joinPath(from, item[0]), T.Uri.joinPath(to, item[0]), options);
    }
  }

  /** Depth-first walk with a callback; `stop()` ends it (for limits). */
  async #walk(root: T.Uri, provider: FileSystemProvider, visit: (uri: T.Uri, isDirectory: boolean) => Promise<void>, stop: () => boolean): Promise<void> {
    const seen = new Set<string>();
    let visited = 0;
    const walk = async (uri: T.Uri, depth: number): Promise<void> => {
      if (stop() || visited > MAX_FILES || depth > MAX_DEPTH) return;
      const key = normalizeKey(uri.toString());
      if (seen.has(key)) return;
      seen.add(key);
      let listed: unknown;
      try {
        listed = await provider.readDirectory(uri);
      } catch {
        return;
      }
      for (const item of Array.isArray(listed) ? listed : []) {
        if (stop() || ++visited > MAX_FILES) return;
        if (!Array.isArray(item) || typeof item[0] !== "string") continue;
        const child = T.Uri.joinPath(uri, item[0]);
        const type = Number(item[1]) || 0;
        let isDirectory = (type & T.FileType.Directory) !== 0;
        // FileType.Unknown or a bare SymbolicLink: ask stat (providers may only know the kind there).
        if (!isDirectory && !(type & T.FileType.File)) {
          try {
            isDirectory = (statOf(await provider.stat(child)).type & T.FileType.Directory) !== 0;
          } catch {
            /* treat it as a file */
          }
        }
        await visit(child, isDirectory);
        if (isDirectory) await walk(child, depth + 1);
      }
    };
    await walk(root, 0);
  }

  #readOnlyError(entry: Entry, uri: T.Uri): FileSystemResult {
    const message = entry.readonlyMessage;
    return { success: false, error: message || `${uri.scheme} is read-only` };
  }

  /** Tell the window (documents / explorer) and the extension watchers about a change. */
  #fire(uri: T.Uri, type: number, notifyView = true): void {
    if (notifyView) this.#host.post({ type: "virtualFilesChanged", paths: [keyOfUri(uri)], changes: [{ path: keyOfUri(uri), type }] });
    this.#host.filesChangedUris([{ uri, type }]);
  }

  #disposeWatchers(scheme: string): void {
    for (const [key, watcher] of [...this.#watchers]) {
      if (watcher.scheme !== scheme) continue;
      this.#watchers.delete(key);
      watcher.disposable.dispose();
    }
  }

  /** workspace.fs for a provided scheme. */
  api() {
    const target = (uri: T.Uri) => T.Uri.revive(uri)!;
    const run = async <R>(uri: T.Uri, call: (provider: FileSystemProvider, target: T.Uri) => unknown): Promise<R> => {
      const revived = target(uri);
      const { provider } = await this.provider(revived.scheme);
      return (await call(provider, revived)) as R;
    };
    const writable = async (uri: T.Uri): Promise<Entry> => {
      const entry = await this.provider(uri.scheme);
      if (entry.isReadonly) throw T.FileSystemError.NoPermissions(entry.readonlyMessage ?? uri);
      return entry;
    };
    return {
      stat: async (uri: T.Uri) => statOf(await run<unknown>(uri, (provider, target) => provider.stat(target))),
      readDirectory: (uri: T.Uri) => run(uri, (provider, target) => provider.readDirectory(target)),
      createDirectory: async (uri: T.Uri) => {
        const revived = target(uri);
        const { provider } = await writable(revived);
        await provider.createDirectory(revived);
        this.#fire(revived, T.FileChangeType.Created);
      },
      readFile: (uri: T.Uri) => run<Uint8Array>(uri, (provider, target) => provider.readFile(target)),
      writeFile: async (uri: T.Uri, content: Uint8Array) => {
        const revived = target(uri);
        const { provider } = await writable(revived);
        let created = false;
        try {
          await provider.stat(revived);
        } catch {
          created = true;
        }
        await provider.writeFile(revived, content, { create: true, overwrite: true });
        this.#fire(revived, created ? T.FileChangeType.Created : T.FileChangeType.Changed);
      },
      delete: async (uri: T.Uri, options: { recursive?: boolean } = {}) => {
        const revived = target(uri);
        const { provider } = await writable(revived);
        await provider.delete(revived, { recursive: !!options.recursive });
        this.#fire(revived, T.FileChangeType.Deleted);
      },
      rename: async (source: T.Uri, destination: T.Uri, options: { overwrite?: boolean } = {}) => {
        const from = target(source);
        const to = target(destination);
        if (from.scheme !== to.scheme) throw T.FileSystemError.Unavailable("cannot move a file to another file system");
        const { provider } = await writable(from);
        await writable(to);
        await provider.rename(from, to, { overwrite: !!options.overwrite });
        this.#fire(from, T.FileChangeType.Deleted);
        this.#fire(to, T.FileChangeType.Created);
      },
      copy: async (source: T.Uri, destination: T.Uri, options: { overwrite?: boolean } = {}) => {
        const from = target(source);
        const to = target(destination);
        if (from.scheme !== to.scheme) throw T.FileSystemError.Unavailable("cannot copy a file to another file system");
        const { provider } = await writable(from);
        await writable(to);
        await this.#copy(provider, from, to, { overwrite: !!options.overwrite });
        this.#fire(to, T.FileChangeType.Created);
      },
    };
  }

  isWritable(scheme: string): boolean | undefined {
    const entry = this.providers.get(scheme);
    return entry ? !entry.isReadonly : undefined;
  }
}

/** `memfs:/a/b.txt` under root `memfs:/` → `a/b.txt` (Find in Files shows root-relative paths). */
function relativeTo(root: T.Uri, child: T.Uri): string {
  const base = keyOfUri(root);
  const path = keyOfUri(child);
  // A case-insensitive provider's root may be spelled differently from its children.
  const rootKey = normalizeKey(base);
  const pathKey = normalizeKey(path);
  if (pathKey === rootKey) return path.split("/").pop() ?? path;
  const prefix = rootKey.endsWith("/") ? rootKey : `${rootKey}/`;
  return pathKey.startsWith(prefix) ? path.slice(prefix.length) : path;
}
