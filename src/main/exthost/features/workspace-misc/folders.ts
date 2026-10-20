import { isAbsolute, relative } from "node:path";
import * as T from "../../types.ts";

/** A workspace folder as extensions see it (vscode.WorkspaceFolder). */
export type FolderEntry = { uri: T.Uri; name: string; index: number };
export type FolderChange = { added: FolderEntry[]; removed: FolderEntry[] };
type Folder = { uri: T.Uri; name: string };

const keyOf = (uri: T.Uri) => (uri.scheme === "file" ? `file:${uri.fsPath.replace(/[/\\]+$/, "").toLowerCase()}` : uri.toString().toLowerCase());
const nameOf = (uri: T.Uri) => uri.path.split("/").filter(Boolean).pop() ?? uri.toString();

/**
 * The folder list extensions see. Lumen's window has a single root; folders an
 * extension adds with updateWorkspaceFolders are kept here (extensions see
 * them, the explorer does not), and the first entry follows the window's root.
 */
export class WorkspaceFolders {
  readonly #emitter = new T.EventEmitter<FolderChange>();
  readonly onDidChange = this.#emitter.event;
  #list: Folder[] = [];
  #windowRoot: string | null = null;

  constructor(root: string | null) {
    this.#windowRoot = root;
    if (root) {
      const uri = T.Uri.file(root);
      this.#list.push({ uri, name: nameOf(uri) });
    }
  }

  get folders(): FolderEntry[] {
    return this.#list.map((folder, index) => ({ ...folder, index }));
  }

  /** The folder containing the URI (the deepest one), if any. */
  folderOf(uri: T.Uri): FolderEntry | undefined {
    let best: FolderEntry | undefined;
    for (const folder of this.folders) {
      if (folder.uri.scheme !== uri.scheme) continue;
      let inside: boolean;
      if (uri.scheme === "file") {
        const rel = relative(folder.uri.fsPath, uri.fsPath);
        inside = !rel.startsWith("..") && !isAbsolute(rel);
      } else {
        inside = (uri.path + "/").startsWith(folder.uri.path.replace(/\/+$/, "") + "/");
      }
      if (inside && (!best || folder.uri.path.length > best.uri.path.length)) best = folder;
    }
    return best;
  }

  /** The window opened another folder (or none): the first entry follows it. */
  syncRoot(root: string | null): void {
    const previous = this.#windowRoot;
    this.#windowRoot = root;
    if (previous === root) return;
    const before = this.folders;
    if (previous) {
      const key = keyOf(T.Uri.file(previous));
      const at = this.#list.findIndex((folder) => keyOf(folder.uri) === key);
      if (at >= 0) this.#list.splice(at, 1);
    }
    if (root) {
      const uri = T.Uri.file(root);
      if (!this.#list.some((folder) => keyOf(folder.uri) === keyOf(uri))) this.#list.unshift({ uri, name: nameOf(uri) });
    }
    this.#fire(before);
  }

  /**
   * workspace.updateWorkspaceFolders. `wantedRoot` is what the window should
   * show afterwards (`undefined`: leave it alone, `null`: close the folder).
   */
  update(start: number, deleteCount: number | undefined | null, adds: { uri: T.Uri; name?: string }[]): { ok: boolean; wantedRoot?: string | null } {
    const length = this.#list.length;
    if (!Number.isInteger(start) || start < 0 || start > length) return { ok: false };
    const count = typeof deleteCount === "number" ? Math.min(Math.max(0, Math.floor(deleteCount)), length - start) : length - start;
    if (count === 0 && adds.length === 0) return { ok: false };
    const next = [...this.#list];
    next.splice(start, count);
    const seen = new Set(next.map((folder) => keyOf(folder.uri)));
    const added: Folder[] = [];
    for (const entry of adds) {
      const uri = T.Uri.revive(entry?.uri);
      if (!uri || seen.has(keyOf(uri))) return { ok: false };
      seen.add(keyOf(uri));
      added.push({ uri, name: entry.name || nameOf(uri) });
    }
    const before = this.folders;
    next.splice(start, 0, ...added);
    this.#list = next;
    this.#fire(before);
    const first = next[0];
    let wantedRoot: string | null | undefined;
    if (!first) wantedRoot = this.#windowRoot ? null : undefined;
    else if (first.uri.scheme === "file" && (!this.#windowRoot || keyOf(first.uri) !== keyOf(T.Uri.file(this.#windowRoot)))) wantedRoot = first.uri.fsPath;
    return { ok: true, wantedRoot };
  }

  #fire(before: FolderEntry[]) {
    const after = this.folders;
    const was = new Map(before.map((folder) => [keyOf(folder.uri), folder]));
    const is = new Map(after.map((folder) => [keyOf(folder.uri), folder]));
    const added = after.filter((folder) => !was.has(keyOf(folder.uri)));
    const removed = before.filter((folder) => !is.has(keyOf(folder.uri)));
    if (added.length || removed.length) this.#emitter.fire({ added, removed });
  }
}
