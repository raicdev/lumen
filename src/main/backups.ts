import { createHash } from "crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { DocumentBackup } from "../shared/types.ts";

/**
 * Backups of unsaved editors (hot exit): the view writes one while a document
 * has unsaved changes and removes it once the changes are saved or discarded,
 * so after a crash or a forced quit the next launch brings them back.
 * One JSON file per document under <user data>/Backups.
 *
 * Every backup belongs to a window (`scope`, its id in the window session), so
 * each restored window gets its own editors back, and two windows' untitled
 * editors with the same name do not overwrite each other. Backups written
 * before windows had ids carry no scope.
 */
export class BackupStore {
  readonly dir: string;

  constructor(userData: string) {
    this.dir = join(userData, "Backups");
  }

  #file(scope: string | null, path: string): string {
    // Local paths are case-insensitive on Windows; untitled names and provider URIs are kept as they are.
    const key = /^[a-z]:[\\/]/i.test(path) ? path.toLowerCase() : path;
    return join(
      this.dir,
      `${createHash("sha1")
        .update(scope === null ? key : `${scope}\0${key}`)
        .digest("hex")}.json`,
    );
  }

  write(scope: string, backup: DocumentBackup): void {
    mkdirSync(this.dir, { recursive: true });
    const file = this.#file(scope, backup.path);
    // Never a half-written backup: write beside it, then replace.
    writeFileSync(`${file}.tmp`, JSON.stringify({ ...backup, scope }));
    renameSync(`${file}.tmp`, file);
  }

  delete(scope: string, path: string, legacy = false): void {
    rmSync(this.#file(scope, path), { force: true });
    // A backup from before scopes, restored into this window.
    if (legacy) rmSync(this.#file(null, path), { force: true });
  }

  /** The window's backups; with `legacy`, also those written before backups had a window. */
  list(scope: string, legacy = false): DocumentBackup[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const backups: DocumentBackup[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const { scope: owner, ...backup } = JSON.parse(readFileSync(join(this.dir, name), "utf8")) as DocumentBackup & { scope?: unknown };
        if (owner === undefined ? !legacy : owner !== scope) continue;
        if (typeof backup.path === "string" && typeof backup.content === "string") backups.push(backup);
      } catch {
        /* unreadable: skip */
      }
    }
    return backups.sort((a, b) => a.time - b.time);
  }
}
