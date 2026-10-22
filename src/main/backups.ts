import { createHash } from "crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { DocumentBackup } from "../shared/types.ts";

/**
 * Backups of unsaved editors (hot exit): the view writes one while a document
 * has unsaved changes and removes it once the changes are saved or discarded,
 * so after a crash or a forced quit the next launch brings them back.
 * One JSON file per document under <user data>/Backups.
 */
export class BackupStore {
  readonly dir: string;

  constructor(userData: string) {
    this.dir = join(userData, "Backups");
  }

  #file(path: string): string {
    // Local paths are case-insensitive on Windows; untitled names and provider URIs are kept as they are.
    const key = /^[a-z]:[\\/]/i.test(path) ? path.toLowerCase() : path;
    return join(this.dir, `${createHash("sha1").update(key).digest("hex")}.json`);
  }

  write(backup: DocumentBackup): void {
    mkdirSync(this.dir, { recursive: true });
    const file = this.#file(backup.path);
    // Never a half-written backup: write beside it, then replace.
    writeFileSync(`${file}.tmp`, JSON.stringify(backup));
    renameSync(`${file}.tmp`, file);
  }

  delete(path: string): void {
    rmSync(this.#file(path), { force: true });
  }

  list(): DocumentBackup[] {
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
        const backup = JSON.parse(readFileSync(join(this.dir, name), "utf8")) as DocumentBackup;
        if (typeof backup.path === "string" && typeof backup.content === "string") backups.push(backup);
      } catch {
        /* unreadable: skip */
      }
    }
    return backups.sort((a, b) => a.time - b.time);
  }
}
