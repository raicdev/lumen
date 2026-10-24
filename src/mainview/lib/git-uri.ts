/**
 * Documents of a file as git has it, for the diff editor's sides:
 * `lumen-git:<ref>:<path>`. The ref is a commit (`HEAD`, a hash, `abc123^`) or
 * empty for the index. They are read-only; a file missing at that ref reads as empty.
 */

const PREFIX = "lumen-git:";

export function gitUri(path: string, ref: string): string {
  return `${PREFIX}${ref}:${path}`;
}

export function isGitUri(path: string | null | undefined): path is string {
  return !!path && path.startsWith(PREFIX);
}

export function parseGitUri(uri: string): { ref: string; path: string } | null {
  if (!isGitUri(uri)) return null;
  const rest = uri.slice(PREFIX.length);
  // Refs never contain a colon; the path may (`D:\repo\a.ts`).
  const colon = rest.indexOf(":");
  if (colon < 0) return null;
  return { ref: rest.slice(0, colon), path: rest.slice(colon + 1) };
}
