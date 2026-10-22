import { watch, type FSWatcher } from "fs";
import { join, normalize } from "path";

/**
 * Recursive workspace watcher (debounced). Reports changed paths so the view
 * can refresh the explorer, reload files changed on disk and update git state.
 */

const IGNORED_SEGMENTS = new Set(["node_modules", ".lumen", "dist", "build", ".next", ".turbo", ".cache"]);

let watcher: FSWatcher | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const pending = new Set<string>();
let gitTouched = false;

export function watchWorkspace(root: string | null, onChange: (paths: string[], git: boolean) => void): void {
  watcher?.close();
  watcher = null;
  if (timer) clearTimeout(timer);
  pending.clear();
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
      } else {
        if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) return;
        pending.add(normalize(join(root, rel)));
        gitTouched = true;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const paths = [...pending];
        const git = gitTouched;
        pending.clear();
        gitTouched = false;
        onChange(paths, git);
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
