import { createHash } from "crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * Per-project UI state (editor layout, panels, terminals), stored outside the
 * project — like VS Code's workspaceStorage — in the user's app data folder:
 *   %APPDATA%\Lumen\workspaceStorage\<hash>.json
 *
 * The view sends every change; writes are debounced and flushed on exit.
 */

function storageDir(appName: string): string {
  const base =
    process.platform === "win32"
      ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support")
        : (process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  return join(base, appName, "workspaceStorage");
}

function keyOf(root: string): string {
  // Windows paths are case-insensitive; normalize separators and case.
  const normalized = root.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  return createHash("sha1")
    .update(process.platform === "win32" ? normalized.toLowerCase() : normalized)
    .digest("hex")
    .slice(0, 20);
}

export class WorkspaceStateStore {
  private dir: string;
  private pending = new Map<string, { root: string; state: unknown }>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(appName: string) {
    this.dir = storageDir(appName);
  }

  get(root: string): unknown | null {
    const key = keyOf(root);
    const queued = this.pending.get(key);
    if (queued) return queued.state;
    try {
      const file = JSON.parse(readFileSync(join(this.dir, `${key}.json`), "utf-8")) as { state?: unknown };
      return file.state ?? null;
    } catch {
      return null;
    }
  }

  set(root: string, state: unknown): void {
    this.pending.set(keyOf(root), { root, state });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 400);
  }

  /** Write everything queued now (also called when the app quits). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending.size) return;
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch {
      /* reported by the write below */
    }
    for (const [key, { root, state }] of this.pending) {
      const target = join(this.dir, `${key}.json`);
      const temp = `${target}.tmp`;
      try {
        // Write then rename, so a crash never leaves a half-written file.
        writeFileSync(temp, JSON.stringify({ root, savedAt: new Date().toISOString(), state }, null, 2), "utf-8");
        renameSync(temp, target);
      } catch (error) {
        console.warn("[workspace-state] could not save", root, error);
      }
    }
    this.pending.clear();
  }
}
