import { watch, type FSWatcher } from "fs";
import { join, normalize } from "path";

/**
 * Recursive workspace watcher (debounced). Reports changed paths so the view
 * can refresh the explorer, reload files changed on disk and update git state.
 *
 * Changes inside the ignored folders (node_modules, build output) never reach
 * the view, but the language service needs those that change types: `npm
 * install`, or `tsc --watch` writing the .d.ts files of another package. They
 * are reported separately as `typePaths`.
 */

const IGNORED_SEGMENTS = new Set(["node_modules", ".lumen", "dist", "build", ".next", ".turbo", ".cache"]);

/** Files in ignored folders that matter to TypeScript (not caches, maps or bundles). */
const TYPE_FILE = /(\.d\.[cm]?ts|\.[cm]?tsx?|[\\/]package\.json)$/i;
/** Tool caches inside node_modules (.cache, .vite, …) change all the time and hold no types. */
const CACHE_SEGMENT = /(^|\/)node_modules\/\.(?!pnpm\/)[^/]+\//;

/** More type files than this in one batch (a big install): reported as `typesOverflow` instead. */
const MAX_TYPE_PATHS = 2000;

export type WorkspaceChange = {
  /** Changed paths outside the ignored folders. */
  paths: string[];
  /** The index, HEAD or refs of .git changed. */
  git: boolean;
  /** Type files changed inside ignored folders (node_modules, dist, …). */
  typePaths: string[];
  /** So many type files changed that they were not listed. */
  typesOverflow: boolean;
};

/** Watches one window's workspace; `watch()` again switches to another root (or none). */
export class WorkspaceWatcher {
  #watcher: FSWatcher | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #pending = new Set<string>();
  #pendingTypes = new Set<string>();
  #typesOverflow = false;
  #gitTouched = false;

  watch(root: string | null, onChange: (change: WorkspaceChange) => void): void {
    this.dispose();
    if (!root) return;

    try {
      const watcher = watch(root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const rel = String(filename).replace(/\\/g, "/");
        const segments = rel.split("/");
        if (segments[0] === ".git") {
          // Only what changes `git status`: the index, HEAD and refs.
          if (/^\.git\/(index|HEAD|refs\/)/.test(rel) && !rel.endsWith(".lock")) this.#gitTouched = true;
          else return;
        } else if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) {
          if (!TYPE_FILE.test(rel) || CACHE_SEGMENT.test(rel) || segments[0] === ".lumen") return;
          if (this.#pendingTypes.size < MAX_TYPE_PATHS) this.#pendingTypes.add(normalize(join(root, rel)));
          else this.#typesOverflow = true;
        } else {
          this.#pending.add(normalize(join(root, rel)));
          this.#gitTouched = true;
        }
        if (this.#timer) clearTimeout(this.#timer);
        this.#timer = setTimeout(() => {
          this.#timer = null;
          const change: WorkspaceChange = {
            paths: [...this.#pending],
            git: this.#gitTouched,
            typePaths: [...this.#pendingTypes],
            typesOverflow: this.#typesOverflow,
          };
          this.#reset();
          onChange(change);
        }, 300);
      });
      watcher.on("error", () => {
        watcher.close();
        if (this.#watcher === watcher) this.#watcher = null;
      });
      this.#watcher = watcher;
    } catch (error) {
      console.warn("[watcher] could not watch workspace:", error);
    }
  }

  /** Stop watching (the window closed). */
  dispose(): void {
    this.#watcher?.close();
    this.#watcher = null;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#reset();
  }

  #reset(): void {
    this.#pending.clear();
    this.#pendingTypes.clear();
    this.#typesOverflow = false;
    this.#gitTouched = false;
  }
}
