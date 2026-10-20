import type { HostDocumentFilter } from "./extensions.ts";

/**
 * Glob patterns as VS Code uses them (`**​/*.{ts,tsx}`, `src/**`, `[abc]`, `?`),
 * matched against `/`-separated paths. Shared by the extension host
 * (findFiles, watchers, document selectors) and the view (selectors).
 */

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached) return cached;
  let source = "";
  let inGroup = 0;
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches any number of folders (including none); a trailing `**` anything.
        i++;
        if (glob[i + 1] === "/") {
          i++;
          source += "(?:[^/]*/)*";
        } else source += ".*";
      } else source += "[^/]*";
    } else if (ch === "?") source += "[^/]";
    else if (ch === "{") {
      inGroup++;
      source += "(?:";
    } else if (ch === "}" && inGroup) {
      inGroup--;
      source += ")";
    } else if (ch === "," && inGroup) source += "|";
    else if (ch === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end < 0) source += "\\[";
      else {
        const body = glob.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\");
        source += `[${body}]`;
        i = end;
      }
    } else if (ch === "\\" || ch === "/") source += "/";
    else source += ch.replace(/[.+^$()|\]]/g, "\\$&");
  }
  const regex = new RegExp(`^${source}$`, "i");
  cache.set(glob, regex);
  return regex;
}

/** Match a path (absolute or relative, any separators) against a glob. */
export function matchGlob(glob: string, path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const regex = globToRegExp(glob.replace(/\\/g, "/"));
  if (regex.test(normalized)) return true;
  // Relative globs ("*.md", "src/**") also match below any folder, like VS Code's file filters.
  if (!glob.startsWith("/") && !/^[a-z]:/i.test(glob) && !glob.startsWith("**")) {
    const parts = normalized.split("/");
    for (let i = 1; i < parts.length; i++) if (regex.test(parts.slice(i).join("/"))) return true;
  }
  return false;
}

/** The scheme of a document key: file paths are `file`, `untitled:Name` is `untitled`. */
export function schemeOf(path: string): string {
  return path.startsWith("untitled:") ? "untitled" : "file";
}

/** Whether a document matches a selector (VS Code's languages.match, as a boolean). */
export function matchesSelector(selector: HostDocumentFilter[], path: string, languageId: string): boolean {
  return selector.some((filter) => {
    if (filter.language && filter.language !== "*" && filter.language !== languageId) return false;
    if (filter.scheme && filter.scheme !== "*" && filter.scheme !== schemeOf(path)) return false;
    if (filter.pattern && !matchGlob(filter.pattern, path)) return false;
    return !!(filter.language || filter.scheme || filter.pattern);
  });
}
