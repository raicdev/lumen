import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";

/**
 * The open windows and their folders, so the next launch reopens them (after
 * a quit, a crash, or Windows ending the session), like VS Code's window
 * restore. A window the user closes while others stay open is forgotten; the
 * last one is kept. Stored in <user data>/windows.json.
 *
 * A window's id also names its hot-exit backups (see backups.ts), so a
 * reopened window gets its own unsaved editors back.
 */

export type WindowEntry = {
  id: string;
  /** The folder the window shows, or null for an empty window. */
  workspace: string | null;
};

export class WindowSessionStore {
  readonly #file: string;

  /** `name`: a development run keeps its own, so it does not take over the installed Lumen's windows. */
  constructor(userData: string, name = "windows.json") {
    this.#file = join(userData, name);
  }

  /** The windows of the last session, or null when there is no session yet (first launch, or one from before windows were saved). */
  load(): WindowEntry[] | null {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.#file, "utf8"));
    } catch {
      return null;
    }
    const windows = (raw as { windows?: unknown } | null)?.windows;
    if (!Array.isArray(windows)) return null;
    return windows.filter(
      (entry): entry is WindowEntry =>
        !!entry && typeof entry === "object" && typeof entry.id === "string" && (entry.workspace === null || typeof entry.workspace === "string"),
    );
  }

  save(windows: WindowEntry[]): void {
    try {
      mkdirSync(join(this.#file, ".."), { recursive: true });
      // Write then rename, so a crash never leaves a half-written file.
      writeFileSync(`${this.#file}.tmp`, JSON.stringify({ windows }, null, 2), "utf8");
      renameSync(`${this.#file}.tmp`, this.#file);
    } catch (error) {
      console.warn("[windows] could not save the window session:", error);
    }
  }
}
