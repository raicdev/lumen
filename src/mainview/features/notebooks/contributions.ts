/**
 * `contributes.notebooks` as the window sees it: which notebook editor (if
 * any) claims a file, and whether the file opens in it by default. VS Code's
 * `priority: "option"` contribution only adds the notebook editor to
 * "Reopen With": matching files open as text.
 *
 * Plain TypeScript without imports, so the host tests can load it directly.
 */

export type NotebookContribution = {
  type: string;
  displayName?: string;
  /** "default" (or missing) opens matching files in the notebook editor; "option" leaves them to the text editor. */
  priority?: string;
  selector?: { filenamePattern?: string }[];
};

/** Patterns of contributes.notebooks (`*`, `**`, `?`, `{a,b}`), matched against the file name or the path. */
export function globMatches(pattern: string, path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const target = pattern.includes("/") ? normalized : normalized.slice(normalized.lastIndexOf("/") + 1);
  let source = "";
  let depth = 0;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          source += "(?:.*/)?";
        } else source += ".*";
      } else source += "[^/]*";
    } else if (ch === "?") source += "[^/]";
    else if (ch === "{") {
      depth++;
      source += "(?:";
    } else if (ch === "}" && depth) {
      depth--;
      source += ")";
    } else if (ch === "," && depth) source += "|";
    else source += ch.replace(/[.+^$()|[\]\\,]/g, "\\$&");
  }
  return new RegExp(`^${pattern.includes("/") && !pattern.startsWith("**") ? "(?:.*/)?" : ""}${source}$`, "i").test(target);
}

/**
 * The contributions whose selector matches the file, in load order. `builtinType`
 * (the built-in `.ipynb` notebook) is left out: the window always opens those.
 */
export function matchingNotebooks(entries: NotebookContribution[], path: string, builtinType?: string): NotebookContribution[] {
  if (path.startsWith("untitled:")) return [];
  return entries.filter((entry) => entry.type !== builtinType && entry.selector?.some((selector) => !!selector.filenamePattern && globMatches(selector.filenamePattern, path)));
}

/** Does a matching contribution make the file open in the notebook editor by default? */
export function opensAsNotebook(entries: NotebookContribution[], path: string, builtinType?: string): boolean {
  // Like VS Code, "option" contributions are listed by Open With but never chosen on their own.
  return matchingNotebooks(entries, path, builtinType).some((entry) => entry.priority !== "option");
}
