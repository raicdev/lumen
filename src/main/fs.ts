import { isUtf8 } from "buffer";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, renameSync, rmSync, readFileSync, type Stats } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join, basename, dirname, extname, relative } from "path";
import { encodingLabel } from "../shared/encodings.ts";
import { buildMatcher, replaceText } from "../shared/search-replace.ts";
import type { FileEntry, OpenFileResult, SearchOptions } from "../shared/types.ts";
import { decodeBytes, detectBom, encodeText, normalizeEncoding } from "./exthost/features/workspace-misc/encoding.ts";
import { detectLanguage, firstLineOf } from "./language.ts";

const IGNORE = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "artifacts",
  ".next",
  ".nuxt",
  "coverage",
  ".cache",
  ".turbo",
  "__pycache__",
  ".DS_Store",
  "Thumbs.db",
]);

/** Extensions of files that are never text: listed in Quick Open, but not opened as text or searched. */
const BINARY_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".tif",
  ".tiff",
  ".psd",
  ".mp3",
  ".wav",
  ".ogg",
  ".flac",
  ".m4a",
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
  ".zip",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".tar",
  ".jar",
  ".vsix",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".lib",
  ".a",
  ".o",
  ".obj",
  ".pdb",
  ".bin",
  ".iso",
  ".dmg",
  ".msi",
  ".node",
  ".wasm",
  ".class",
  ".pyc",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".sqlite",
  ".db",
]);

/** Text unless the extension says binary; the content check (NUL bytes) happens when the file is read. */
export function isProbablyText(filePath: string): boolean {
  return !BINARY_EXTS.has(extname(filePath).toLowerCase());
}

/** How many leading bytes the binary check looks at. */
const SNIFF_BYTES = 64 * 1024;

/** NUL bytes mean a binary file, unless it is UTF-16. */
function looksBinary(bytes: Uint8Array, encoding: string): boolean {
  return !encoding.startsWith("utf16") && bytes.subarray(0, SNIFF_BYTES).includes(0);
}

/** Valid in a Japanese encoding and containing kana: Western text decoded that way has none. */
function isJapanese(bytes: Uint8Array, label: string): boolean {
  try {
    return /[぀-ヿ]/.test(new TextDecoder(label, { fatal: true }).decode(bytes));
  } catch {
    return false;
  }
}

/** The encoding of a file: its BOM, UTF-8 when the bytes are valid UTF-8, Shift JIS / EUC-JP for Japanese text, Windows-1252 otherwise. */
export function detectEncoding(bytes: Uint8Array): string {
  const bom = detectBom(bytes);
  if (bom) return bom;
  if (isUtf8(bytes)) return "utf8";
  if (isJapanese(bytes, "shift_jis")) return "shiftjis";
  if (isJapanese(bytes, "euc-jp")) return "eucjp";
  return "windows1252";
}

/** Changes whenever the file is written: compared before a save to catch changes made by other programs. */
function fileVersion(stats: Stats): string {
  return `${stats.mtimeMs}:${stats.size}`;
}

/** A text file's content and encoding; null for binary or unreadable files. */
function readTextSync(filePath: string): { text: string; encoding: string } | null {
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch {
    return null;
  }
  const encoding = detectEncoding(bytes);
  return looksBinary(bytes, encoding) ? null : { text: decodeBytes(bytes, encoding), encoding };
}

export function readDirTree(dirPath: string, depth = 3): FileEntry[] {
  if (!existsSync(dirPath)) return [];

  let names: string[];
  try {
    names = readdirSync(dirPath);
  } catch {
    return [];
  }

  const entries: FileEntry[] = [];

  for (const name of names) {
    if (IGNORE.has(name) || name.startsWith(".")) {
      // still show .env / .gitignore style files
      if (!(name.startsWith(".env") || name === ".gitignore" || name === ".editorconfig")) {
        continue;
      }
    }

    const full = join(dirPath, name);
    let isDirectory = false;
    try {
      isDirectory = statSync(full).isDirectory();
    } catch {
      continue;
    }

    const entry: FileEntry = {
      name,
      path: full,
      isDirectory,
    };

    if (isDirectory && depth > 0) {
      entry.children = readDirTree(full, depth - 1);
    }

    entries.push(entry);
  }

  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  return entries;
}

/** Read a text file, detecting its encoding unless one is given ("Reopen with Encoding"). */
export async function readTextFile(filePath: string, encoding?: string): Promise<OpenFileResult | { error: string }> {
  try {
    if (!existsSync(filePath)) return { error: "File not found" };
    if (!isProbablyText(filePath)) return { error: "Binary or unsupported file type" };

    const stats = statSync(filePath);
    if (stats.size > 5 * 1024 * 1024) return { error: "File too large (>5MB)" };

    const bytes = await readFile(filePath);
    const chosen = normalizeEncoding(encoding) ?? detectEncoding(bytes);
    if (!encoding && looksBinary(bytes, chosen)) return { error: "Binary or unsupported file type" };
    const content = decodeBytes(bytes, chosen);
    return {
      path: filePath,
      content,
      language: detectLanguage(filePath, firstLineOf(content)),
      encoding: chosen,
      version: fileVersion(stats),
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to read file" };
  }
}

/** Encodings that hold every character, so a save never needs the round-trip check. */
const UNICODE_ENCODINGS = new Set(["utf8", "utf8bom", "utf16le", "utf16be"]);

/**
 * Write a text file in `encoding` (UTF-8 by default). With `expectedVersion`
 * the write is refused (`conflict`) when another program changed the file
 * since it was read or last saved.
 */
export async function writeTextFile(
  filePath: string,
  content: string,
  options: { encoding?: string; expectedVersion?: string } = {},
): Promise<{ success: boolean; error?: string; conflict?: boolean; version?: string }> {
  try {
    if (options.expectedVersion && existsSync(filePath) && fileVersion(statSync(filePath)) !== options.expectedVersion) {
      return { success: false, conflict: true, error: `${basename(filePath)} has been changed on disk.` };
    }
    const encoding = normalizeEncoding(options.encoding) ?? "utf8";
    const bytes = encodeText(content, encoding);
    if (!UNICODE_ENCODINGS.has(encoding) && decodeBytes(bytes, encoding) !== content) {
      return { success: false, error: `Some characters cannot be saved in ${encodingLabel(encoding)}. Use "Save with Encoding" to pick another encoding.` };
    }
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, bytes);
    return { success: true, version: fileVersion(statSync(filePath)) };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Failed to write file" };
  }
}

export async function createFile(filePath: string, content = ""): Promise<{ success: boolean; error?: string }> {
  try {
    if (existsSync(filePath)) return { success: false, error: "Path already exists" };
    const parent = filePath.replace(/[\\/][^\\/]+$/, "");
    if (parent && parent !== filePath && !existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    await writeFile(filePath, content, "utf8");
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Failed to create file" };
  }
}

export function createDirectory(dirPath: string): { success: boolean; error?: string } {
  try {
    if (existsSync(dirPath)) return { success: false, error: "Path already exists" };
    mkdirSync(dirPath, { recursive: true });
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Failed to create directory" };
  }
}

export function deletePath(targetPath: string): { success: boolean; error?: string } {
  try {
    if (!existsSync(targetPath)) return { success: false, error: "Path not found" };
    const st = statSync(targetPath);
    if (st.isDirectory()) {
      rmSync(targetPath, { recursive: true, force: true });
    } else {
      unlinkSync(targetPath);
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Failed to delete" };
  }
}

export function renamePath(oldPath: string, newPath: string): { success: boolean; error?: string } {
  try {
    if (!existsSync(oldPath)) return { success: false, error: "Source not found" };
    if (existsSync(newPath)) return { success: false, error: "Destination already exists" };
    renameSync(oldPath, newPath);
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Failed to rename" };
  }
}

export function listWorkspaceFiles(root: string, maxFiles = 2000): string[] {
  const results: string[] = [];

  function walk(dir: string) {
    if (results.length >= maxFiles) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }

    for (const name of names) {
      if (results.length >= maxFiles) return;
      if (IGNORE.has(name)) continue;
      if (name.startsWith(".") && name !== ".env" && name !== ".gitignore") continue;

      const full = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }

      if (isDir) {
        walk(full);
      } else if (isProbablyText(full)) {
        results.push(relative(root, full).replace(/\\/g, "/"));
      }
    }
  }

  if (existsSync(root)) walk(root);
  return results.sort((a, b) => a.localeCompare(b));
}

export type SearchMatch = {
  path: string;
  relativePath: string;
  line: number;
  column: number;
  length: number;
  preview: string;
};

export type SearchResult = {
  matches: SearchMatch[];
  truncated: boolean;
  filesScanned: number;
  error?: string;
};

export type TextSearchOptions = SearchOptions & {
  maxResults?: number;
  maxFileBytes?: number;
};

/** `src/**, *.ts` → one RegExp per glob, matched against `/`-separated relative paths. */
function splitTopLevel(patterns: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of patterns) {
    if (char === "{") depth++;
    else if (char === "}") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return parts;
}

function globList(patterns: string | undefined): RegExp[] {
  return splitTopLevel(patterns ?? "")
    .map((pattern) => pattern.trim().replace(/\\/g, "/"))
    .filter(Boolean)
    .map((pattern) => {
      let glob = pattern.replace(/^\.\//, "");
      if (glob.endsWith("/")) glob += "**";
      // A plain path (no wildcard) matches that file or everything in that folder.
      if (!/[*?{]/.test(glob)) glob = `${glob}{,/**}`;
      if (!glob.startsWith("**/") && !glob.startsWith("/")) glob = `**/${glob}`;
      glob = glob.replace(/^\//, "");
      let source = "";
      let depth = 0;
      for (let i = 0; i < glob.length; i++) {
        const char = glob[i]!;
        if (char === "*") {
          if (glob[i + 1] === "*") {
            // `**/` matches zero or more folders, a trailing `**` anything.
            if (glob[i + 2] === "/") {
              source += "(?:.*/)?";
              i += 2;
            } else {
              source += ".*";
              i += 1;
            }
          } else source += "[^/]*";
        } else if (char === "?") source += "[^/]";
        else if (char === "{") {
          depth++;
          source += "(?:";
        } else if (char === "}" && depth > 0) {
          depth--;
          source += ")";
        } else if (char === "," && depth > 0) source += "|";
        else source += char.replace(/[.+^$()|[\]\\]/g, "\\$&");
      }
      return new RegExp(`^${source}$`, "i");
    });
}

/** Walk the text files of a workspace, honouring the ignore list and include/exclude globs. */
function walkTextFiles(root: string, options: SearchOptions & { maxFileBytes?: number }, visit: (full: string, relativePath: string) => boolean | void): void {
  const include = globList(options.include);
  const exclude = globList(options.exclude);
  const maxFileBytes = options.maxFileBytes ?? 512 * 1024;
  let stopped = false;

  function walk(dir: string) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (stopped) return;
      if (IGNORE.has(name)) continue;
      if (name.startsWith(".") && name !== ".env" && name !== ".gitignore") continue;

      const full = join(dir, name);
      const rel = relative(root, full).replace(/\\/g, "/");
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (exclude.some((glob) => glob.test(rel))) continue;
      if (stats.isDirectory()) {
        walk(full);
        continue;
      }
      if (include.length && !include.some((glob) => glob.test(rel))) continue;
      if (!isProbablyText(full) || stats.size > maxFileBytes) continue;
      if (visit(full, rel) === false) stopped = true;
    }
  }

  walk(root);
}

/** Workspace text search (multi-file grep with VS Code's search options). */
export function searchInFiles(root: string, query: string, options: TextSearchOptions = {}): SearchResult {
  if (!query) return { matches: [], truncated: false, filesScanned: 0 };
  if (!existsSync(root)) {
    return { matches: [], truncated: false, filesScanned: 0, error: "Workspace not found" };
  }

  let matcher: RegExp;
  try {
    matcher = buildMatcher(query, options);
  } catch (error) {
    return { matches: [], truncated: false, filesScanned: 0, error: `Invalid regular expression: ${(error as Error).message}` };
  }

  const maxResults = options.maxResults ?? 200;
  const matches: SearchMatch[] = [];
  let filesScanned = 0;
  let truncated = false;

  walkTextFiles(root, options, (full, rel) => {
    filesScanned++;
    const text = readTextSync(full)?.text;
    if (text === undefined) return;

    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i]!;
      matcher.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = matcher.exec(lineText))) {
        if (match[0].length === 0) {
          matcher.lastIndex++;
          continue;
        }
        matches.push({
          path: full,
          relativePath: rel,
          line: i,
          column: match.index,
          length: match[0].length,
          preview: lineText.trimEnd().slice(0, 240),
        });
        if (matches.length >= maxResults) {
          truncated = true;
          return false;
        }
      }
    }
  });

  return { matches, truncated, filesScanned };
}

/** Replace every match of `query` in the workspace (or only in `paths`). */
export async function replaceInFiles(
  root: string,
  query: string,
  replacement: string,
  options: SearchOptions & { paths?: string[] } = {},
): Promise<{ files: number; replacements: number; failed?: string[]; error?: string }> {
  if (!query) return { files: 0, replacements: 0 };
  let matcher: RegExp;
  try {
    matcher = buildMatcher(query, options);
  } catch (error) {
    return { files: 0, replacements: 0, error: `Invalid regular expression: ${(error as Error).message}` };
  }

  const only = options.paths ? new Set(options.paths.map((path) => path.toLowerCase())) : null;
  const targets: string[] = [];
  walkTextFiles(root, options, (full) => {
    if (!only || only.has(full.toLowerCase())) targets.push(full);
  });

  let files = 0;
  let replacements = 0;
  const failed: string[] = [];
  for (const full of targets) {
    const file = readTextSync(full);
    if (!file) continue;
    const { text, count } = replaceText(file.text, matcher, replacement, !!options.regex);
    if (count === 0) continue;
    try {
      await writeFile(full, encodeText(text, file.encoding));
      files++;
      replacements += count;
    } catch {
      failed.push(full);
    }
  }
  return { files, replacements, failed };
}

/** Filter workspace file paths by name query. */
export function searchFilesByName(root: string, query: string, maxResults = 100): string[] {
  const q = query.trim().toLowerCase();
  const files = listWorkspaceFiles(root, 5000);
  if (!q) return files.slice(0, maxResults);
  return files.filter((f) => f.toLowerCase().includes(q)).slice(0, maxResults);
}
