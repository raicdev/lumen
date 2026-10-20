import { existsSync } from "fs";
import { mkdir, rename, rm, rmdir, stat, writeFile } from "fs/promises";
import { dirname } from "path";
import type { HostFileOperation } from "../../shared/extensions.ts";
import type { FileEdits as WireFileEdits } from "../../shared/types.ts";
import { keyOfUri, normalizeKey } from "./documents.ts";
import type { ExtensionHost } from "./host.ts";
import * as T from "./types.ts";
import { wireEdit, wireRange } from "./wire.ts";
import { applyCellTextEdits, applyNotebookEdit, isNotebookCellText } from "./features/notebooks/edits.ts";

/**
 * workspace.applyEdit (also used for code actions): the entries run in order.
 * Consecutive text / snippet edits go to the view in one batch (it edits open
 * documents and writes closed files); file operations happen here, between
 * those batches, with the onWill* / onDid* file events and the open editors
 * following renamed and deleted files. The first failure stops the edit.
 */

type Entry = T.WorkspaceEditEntry;
type TextEntry = Extract<Entry, { kind: "text" | "snippet" }>;

/** Text and snippet edits grouped by file, as the view applies them. */
export function wireWorkspaceEdit(edit: T.WorkspaceEdit): WireFileEdits[] {
  return wireTextEntries((edit._entries ?? []).filter((entry): entry is TextEntry => entry.kind === "text" || entry.kind === "snippet"));
}

function wireTextEntries(entries: TextEntry[]): WireFileEdits[] {
  const files = new Map<string, WireFileEdits>();
  for (const entry of entries) {
    const path = keyOfUri(T.Uri.revive(entry.uri)!);
    const key = normalizeKey(path);
    if (!files.has(key)) files.set(key, { path, edits: [] });
    const file = files.get(key)!;
    if (entry.kind === "snippet") {
      file.edits.push({ ...wireRange(entry.edit.range), newText: entry.edit.snippet.value, snippet: true });
      continue;
    }
    if (entry.edit.newEol !== undefined) file.eol = entry.edit.newEol === T.EndOfLine.CRLF ? "CRLF" : "LF";
    // A pure setEndOfLine edit changes no text.
    const range = wireRange(entry.edit.range);
    const empty = range.startLine === range.endLine && range.startCharacter === range.endCharacter;
    if (entry.edit.newEol === undefined || entry.edit.newText || !empty) file.edits.push(wireEdit(entry.edit));
  }
  return [...files.values()];
}

/** The file system of a URI: local files, or an extension's provider. */
function fileSystemOf(host: ExtensionHost, uri: T.Uri) {
  if (uri.scheme === "file") {
    return {
      exists: async (target: T.Uri) => existsSync(target.fsPath),
      isDirectory: async (target: T.Uri) => (await stat(target.fsPath)).isDirectory(),
      write: async (target: T.Uri, content: Uint8Array) => {
        await mkdir(dirname(target.fsPath), { recursive: true });
        await writeFile(target.fsPath, content);
      },
      delete: async (target: T.Uri, recursive: boolean) => {
        if (!(await stat(target.fsPath)).isDirectory()) await rm(target.fsPath);
        else if (recursive) await rm(target.fsPath, { recursive: true });
        else await rmdir(target.fsPath);
      },
      rename: async (from: T.Uri, to: T.Uri, overwrite: boolean) => {
        if (overwrite && existsSync(to.fsPath)) await rm(to.fsPath, { recursive: true, force: true });
        await mkdir(dirname(to.fsPath), { recursive: true });
        await rename(from.fsPath, to.fsPath);
      },
    };
  }
  const provided = host.fileSystems.api();
  return {
    exists: async (target: T.Uri) => {
      try {
        await provided.stat(target);
        return true;
      } catch {
        return false;
      }
    },
    isDirectory: async (target: T.Uri) => ((await provided.stat(target)) as { type?: number }).type === T.FileType.Directory,
    write: (target: T.Uri, content: Uint8Array) => provided.writeFile(target, content),
    delete: (target: T.Uri, recursive: boolean) => provided.delete(target, { recursive }),
    rename: (from: T.Uri, to: T.Uri, overwrite: boolean) => provided.rename(from, to, { overwrite }),
  };
}

const operationPath = (uri: T.Uri) => keyOfUri(uri);

/** Fire onWill*, apply the edits its listeners asked for, run the operation, then update the editors and fire onDid*. */
async function fileOperation(host: ExtensionHost, kind: "create" | "delete" | "rename", files: HostFileOperation[], run: () => Promise<void>): Promise<void> {
  const willEdits = await host.fireWillFileOperation(kind, files);
  if (willEdits.length) await host.requestView("applyWorkspaceEdit", willEdits);
  await run();
  await host.requestView("fileOperation", kind, files);
  host.fireDidFileOperation(kind, files);
}

/** One create / delete / rename entry; false when it cannot be done (the target exists, the source is missing). */
async function applyFileEntry(host: ExtensionHost, entry: Exclude<Entry, TextEntry | { kind: "notebook" }>): Promise<boolean> {
  if (entry.kind === "create") {
    const uri = T.Uri.revive(entry.uri)!;
    const fs = fileSystemOf(host, uri);
    const options = entry.options ?? {};
    if ((await fs.exists(uri)) && !options.overwrite) return !!options.ignoreIfExists;
    const contents = options.contents instanceof Uint8Array ? options.contents : options.contents ? await options.contents.data() : new Uint8Array();
    await fileOperation(host, "create", [{ path: operationPath(uri) }], () => fs.write(uri, contents));
    return true;
  }
  if (entry.kind === "delete") {
    const uri = T.Uri.revive(entry.uri)!;
    const fs = fileSystemOf(host, uri);
    if (!(await fs.exists(uri))) return !!entry.options?.ignoreIfNotExists;
    await fileOperation(host, "delete", [{ path: operationPath(uri) }], () => fs.delete(uri, !!entry.options?.recursive));
    return true;
  }
  const from = T.Uri.revive(entry.from)!;
  const to = T.Uri.revive(entry.to)!;
  if (from.scheme !== to.scheme) throw new Error(`cannot move ${from.toString()} to another file system (${to.toString()})`);
  const fs = fileSystemOf(host, from);
  if (!(await fs.exists(from))) return false;
  // Changing only the case of a name: the "existing" target is the file itself.
  const sameFile = normalizeKey(operationPath(from)) === normalizeKey(operationPath(to));
  const overwrite = !!entry.options?.overwrite && !sameFile;
  if (!sameFile && (await fs.exists(to)) && !overwrite) return !!entry.options?.ignoreIfExists;
  await fileOperation(host, "rename", [{ oldPath: operationPath(from), newPath: operationPath(to) }], () => fs.rename(from, to, overwrite));
  return true;
}

/** Whether a text edit's file can be edited: an open document, or a file that exists. */
async function editable(host: ExtensionHost, uri: T.Uri): Promise<boolean> {
  if (uri.scheme === "untitled" || host.documentForUri(uri)) return true;
  return await fileSystemOf(host, uri).exists(uri);
}

async function applyTextEntries(host: ExtensionHost, entries: TextEntry[]): Promise<boolean> {
  for (const entry of entries) {
    const uri = T.Uri.revive(entry.uri)!;
    if (!(await editable(host, uri))) throw new Error(`cannot edit ${uri.toString()}: the file does not exist`);
  }
  const files = wireTextEntries(entries);
  if (!(await host.requestView("applyWorkspaceEdit", files))) return false;
  for (const file of files) if (file.eol) host.document(file.path)?.setEol(file.eol);
  return true;
}

/** The labels of entries that need confirmation, asked about once for the whole edit. */
async function confirmed(host: ExtensionHost, entries: Entry[]): Promise<boolean> {
  const labels = [...new Set(entries.flatMap((entry) => (entry.metadata?.needsConfirmation ? [entry.metadata.label] : [])))];
  if (!labels.length) return true;
  const choice = await host.requestView("showMessage", "warning", `Apply ${entries.length} change(s)?`, ["Apply"], { modal: true, detail: labels.join("\n") });
  return choice === 0;
}

export async function applyWorkspaceEdit(host: ExtensionHost, edit: T.WorkspaceEdit, extensionId?: string): Promise<boolean> {
  const entries = [...(edit?._entries ?? [])];
  if (!entries.length) return true;
  try {
    if (!(await confirmed(host, entries))) return false;
    let run: TextEntry[] = [];
    // The edits of each notebook cell go to the notebook together (their positions refer to the text before the edit).
    const cellEdits = new Map<string, T.TextEdit[]>();
    for (const entry of entries) if (entry.kind === "text" && isNotebookCellText(entry)) cellEdits.set(entry.uri.toString(), [...(cellEdits.get(entry.uri.toString()) ?? []), entry.edit]);
    for (const entry of entries) {
      if ((entry.kind === "text" || entry.kind === "snippet") && !isNotebookCellText(entry)) {
        run.push(entry);
        continue;
      }
      if (run.length && !(await applyTextEntries(host, run))) return false;
      run = [];
      // Notebook edits and edits of a notebook cell's text go to the notebook model.
      if (entry.kind === "notebook") {
        if (!(await applyNotebookEdit(host, entry))) return false;
        continue;
      }
      if (entry.kind === "text" || entry.kind === "snippet") {
        const key = entry.uri.toString();
        const edits = cellEdits.get(key);
        cellEdits.delete(key);
        if (entry.kind === "snippet") throw new Error("snippet edits of notebook cells are not supported");
        if (edits && !applyCellTextEdits(host, T.Uri.revive(entry.uri)!, edits)) throw new Error(`cannot edit ${key}: the notebook cell does not exist`);
        continue;
      }
      if (!(await applyFileEntry(host, entry as Exclude<Entry, TextEntry | { kind: "notebook" }>))) {
        host.log("warning", `workspace edit stopped: cannot ${entry.kind} ${entry.kind === "rename" ? entry.from.toString() : entry.uri.toString()}`, extensionId);
        return false;
      }
    }
    return run.length ? await applyTextEntries(host, run) : true;
  } catch (error) {
    host.log("error", `applyEdit failed: ${error instanceof Error ? error.message : error}`, extensionId);
    return false;
  }
}
