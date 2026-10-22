/**
 * Editor tabs of the side-by-side diff editor: `diff:<json [original, modified]>`.
 * The paths are the window's document keys (`keyOfUri` on the host side).
 */

const DIFF_TAB_PREFIX = "diff:";

export function isDiffTab(path: string | null | undefined): path is string {
  return !!path && path.startsWith(DIFF_TAB_PREFIX);
}

export function diffTabPath(original: string, modified: string): string {
  return `${DIFF_TAB_PREFIX}${JSON.stringify([original, modified])}`;
}

/** The two documents a diff tab compares. */
export function parseDiffTab(tabPath: string | null | undefined): { original: string; modified: string } | null {
  if (!isDiffTab(tabPath)) return null;
  try {
    const value: unknown = JSON.parse(tabPath.slice(DIFF_TAB_PREFIX.length));
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || typeof value[1] !== "string") return null;
    return { original: value[0], modified: value[1] };
  } catch {
    return null;
  }
}
