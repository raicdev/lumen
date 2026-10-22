/**
 * Case sensitivity of file systems extensions provide
 * (workspace.registerFileSystemProvider's `isCaseSensitive`, true by default).
 *
 * The host registers every provider scheme here; the window learns the same
 * schemes from the host's `fileSystems` message. A case-insensitive provider's
 * URIs that differ only in path case are the same resource, while the paths
 * handed to the provider (and shown in tabs and the explorer) keep their
 * original casing.
 */

/** Scheme (lower case) → isCaseSensitive of its provider. */
const schemes = new Map<string, boolean>();

/** The scheme of a document key (`memfs:/a.txt`), or undefined for local paths and `C:\…`. */
export function schemeOfPath(path: string): string | undefined {
  const match = /^(\w[\w+.-]+):/.exec(path);
  return match?.[1]?.toLowerCase();
}

/** A provider scheme registered either by the host or (in the window) by its `fileSystems` message. */
export function setFileSystemCaseSensitivity(scheme: string, isCaseSensitive: boolean): void {
  schemes.set(scheme.toLowerCase(), isCaseSensitive);
}

/** The host's provider list changed: replace every scheme (and its case sensitivity). */
export function setFileSystemSchemes(all: readonly string[], caseSensitive: readonly string[] = []): void {
  const sensitive = new Set(caseSensitive.map((scheme) => scheme.toLowerCase()));
  schemes.clear();
  for (const scheme of all) schemes.set(scheme.toLowerCase(), sensitive.has(scheme.toLowerCase()));
}

export function removeFileSystemScheme(scheme: string): void {
  schemes.delete(scheme.toLowerCase());
}

export function isCaseSensitiveFileSystem(scheme: string): boolean {
  return schemes.get(scheme.toLowerCase()) !== false;
}

export function isCaseInsensitiveFileSystem(scheme: string): boolean {
  return schemes.get(scheme.toLowerCase()) === false;
}

/** A provider key, lower-cased only when the scheme's provider is case-insensitive. */
export function normalizeFileSystemKey(path: string): string {
  const scheme = schemeOfPath(path);
  return scheme && isCaseInsensitiveFileSystem(scheme) ? path.toLowerCase() : path;
}

/**
 * The key the window compares open documents and tabs by: provider schemes
 * follow their isCaseSensitive; everything else keeps the window's existing
 * case-insensitive comparison (local files, untitled and content-provider tabs).
 */
export function normalizeDocumentKey(path: string): string {
  const scheme = schemeOfPath(path);
  if (scheme && schemes.has(scheme)) return isCaseInsensitiveFileSystem(scheme) ? path.toLowerCase() : path;
  return path.toLowerCase();
}

/** Whether two document keys name the same resource. */
export function sameDocumentKey(a: string, b: string): boolean {
  return a === b || normalizeDocumentKey(a) === normalizeDocumentKey(b);
}
