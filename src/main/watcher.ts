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

let watcher: FSWatcher | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const pending = new Set<string>();
const pendingTypes = new Set<string>();
let typesOverflow = false;
let gitTouched = false;

export function watchWorkspace(root: string | null, onChange: (change: WorkspaceChange) => void): void {
  watcher?.close();
  watcher = null;
  if (timer) clearTimeout(timer);
  pending.clear();
  pendingTypes.clear();
  typesOverflow = false;
  gitTouched = false;
  if (!root) return;

  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = String(filename).replace(/\\/g, "/");
      const segments = rel.split("/");
      if (segments[0] === ".git") {
        // Only what changes `git status`: the index, HEAD and refs.
        if (/^\.git\/(index|HEAD|refs\/)/.test(rel) && !rel.endsWith(".lock")) gitTouched = true;
        else return;
      } else if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) {
        if (!TYPE_FILE.test(rel) || CACHE_SEGMENT.test(rel) || segments[0] === ".lumen") return;
        if (pendingTypes.size < MAX_TYPE_PATHS) pendingTypes.add(normalize(join(root, rel)));
        else typesOverflow = true;
      } else {
        pending.add(normalize(join(root, rel)));
        gitTouched = true;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const change: WorkspaceChange = { paths: [...pending], git: gitTouched, typePaths: [...pendingTypes], typesOverflow };
        pending.clear();
        pendingTypes.clear();
        typesOverflow = false;
        gitTouched = false;
        onChange(change);
      }, 300);
    });
    watcher.on("error", () => {
      watcher?.close();
      watcher = null;
    });
  } catch (error) {
    console.warn("[watcher] could not watch workspace:", error);
  }
}
