import { EndOfLine, Position, Range, Uri } from "./types.ts";
import type { HostContentChange, HostDocumentData } from "../../shared/extensions.ts";
import { normalizeFileSystemKey } from "../../shared/file-systems.ts";

/**
 * The extension host's copy of an open document. The view sends the text
 * when a document opens and every edit afterwards, so extensions can read it
 * synchronously (`document.getText()`, `lineAt`, …) like in VS Code.
 */

const DEFAULT_WORD = /(-?\d*\.\d\w*)|([^`~!@#$%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/g;

export type TextLine = {
  readonly lineNumber: number;
  readonly text: string;
  readonly range: Range;
  readonly rangeIncludingLineBreak: Range;
  readonly firstNonWhitespaceCharacterIndex: number;
  readonly isEmptyOrWhitespace: boolean;
};

/** A document of an extension's file system: its key is the URI itself (`memfs:/a.txt`). */
export function isVirtualKey(path: string): boolean {
  return /^\w[\w+.-]+:/.test(path) && !path.startsWith("untitled:");
}

/** `untitled:Name` → untitled URI, `scheme:…` → that URI, anything else is a file path. */
export function uriOfKey(path: string): Uri {
  if (path.startsWith("untitled:")) return Uri.from({ scheme: "untitled", path: path.slice("untitled:".length) });
  if (isVirtualKey(path)) return Uri.parse(path);
  return Uri.file(path);
}

/** The view's document key for a URI. */
export function keyOfUri(uri: Uri): string {
  if (uri.scheme === "untitled") return `untitled:${uri.path}`;
  if (uri.scheme !== "file") return uri.toString();
  return uri.fsPath;
}

/**
 * Map key: paths compare case-insensitively on Windows, and provider paths
 * follow their file system's isCaseSensitive (registerFileSystemProvider).
 */
export function normalizeKey(path: string): string {
  if (path.startsWith("untitled:") || isVirtualKey(path)) return normalizeFileSystemKey(path);
  return process.platform === "win32" ? path.replace(/\//g, "\\").toLowerCase() : path;
}

export class ExtHostDocument {
  /** The view's key (file path or `untitled:Name`). */
  key: string;
  uri: Uri;
  languageId: string;
  version: number;
  isDirty: boolean;
  isClosed = false;
  /** Opened by the view (an editor tab), not just read by an extension. */
  open: boolean;
  #eol: "LF" | "CRLF";
  #text: string;
  #lines: string[] | null = null;
  #lineStarts: number[] | null = null;
  readonly #save: (document: ExtHostDocument) => Promise<boolean>;

  constructor(data: HostDocumentData, open: boolean, save: (document: ExtHostDocument) => Promise<boolean>) {
    this.key = data.path;
    this.uri = uriOfKey(data.path);
    this.languageId = data.languageId;
    this.version = data.version;
    this.isDirty = data.dirty;
    this.#eol = data.eol;
    this.#text = data.text;
    this.open = open;
    this.#save = save;
  }

  get fileName(): string {
    return this.uri.scheme === "file" ? this.uri.fsPath : this.uri.path;
  }

  get isUntitled(): boolean {
    return this.uri.scheme === "untitled";
  }

  get eol(): EndOfLine {
    return this.#eol === "CRLF" ? EndOfLine.CRLF : EndOfLine.LF;
  }

  get encoding(): string {
    return "utf8";
  }

  get lineCount(): number {
    return this.#getLines().length;
  }

  setText(text: string, version: number): void {
    this.#text = text;
    this.version = version;
    this.#lines = null;
    this.#lineStarts = null;
  }

  /** Apply edits from the view, in order (each against the text as left by the previous one). */
  applyChanges(changes: HostContentChange[], version: number): void {
    let text = this.#text;
    for (const change of changes) {
      text = text.slice(0, change.rangeOffset) + change.text + text.slice(change.rangeOffset + change.rangeLength);
    }
    this.setText(text, version);
  }

  setEol(eol: "LF" | "CRLF") {
    this.#eol = eol;
  }

  save(): Promise<boolean> {
    return this.#save(this);
  }

  getText(range?: Range): string {
    if (!range) return this.#text;
    const r = this.validateRange(range);
    return this.#text.slice(this.offsetAt(r.start), this.offsetAt(r.end));
  }

  lineAt(lineOrPosition: number | Position): TextLine {
    const line = typeof lineOrPosition === "number" ? lineOrPosition : lineOrPosition.line;
    const lines = this.#getLines();
    if (line < 0 || line >= lines.length) throw new Error(`Illegal value for line: ${line}`);
    const text = lines[line]!;
    const firstNonWhitespace = /^\s*/.exec(text)![0].length;
    const range = new Range(line, 0, line, text.length);
    return {
      lineNumber: line,
      text,
      range,
      rangeIncludingLineBreak: line < lines.length - 1 ? new Range(line, 0, line + 1, 0) : range,
      firstNonWhitespaceCharacterIndex: firstNonWhitespace,
      isEmptyOrWhitespace: firstNonWhitespace === text.length,
    };
  }

  offsetAt(position: Position): number {
    const p = this.validatePosition(position);
    return this.#getLineStarts()[p.line]! + p.character;
  }

  positionAt(offset: number): Position {
    const clamped = Math.max(0, Math.min(Math.floor(offset), this.#text.length));
    const starts = this.#getLineStarts();
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid]! <= clamped) low = mid;
      else high = mid - 1;
    }
    const lineText = this.#getLines()[low]!;
    return new Position(low, Math.min(clamped - starts[low]!, lineText.length));
  }

  getWordRangeAtPosition(position: Position, regex?: RegExp): Range | undefined {
    const p = this.validatePosition(position);
    const text = this.#getLines()[p.line]!;
    const source = regex ?? DEFAULT_WORD;
    const pattern = new RegExp(source.source, source.flags.includes("g") ? source.flags : `${source.flags}g`);
    for (const match of text.matchAll(pattern)) {
      const start = match.index!;
      const end = start + match[0].length;
      if (start <= p.character && p.character <= end && match[0].length) return new Range(p.line, start, p.line, end);
    }
    return undefined;
  }

  validateRange(range: Range): Range {
    const start = this.validatePosition(range.start);
    const end = this.validatePosition(range.end);
    return start.isEqual(range.start) && end.isEqual(range.end) ? range : new Range(start, end);
  }

  validatePosition(position: Position): Position {
    const lines = this.#getLines();
    if (position.line < 0) return new Position(0, 0);
    if (position.line >= lines.length) return new Position(lines.length - 1, lines[lines.length - 1]!.length);
    const length = lines[position.line]!.length;
    return position.character > length ? new Position(position.line, length) : position;
  }

  /** The object handed to extensions (methods bound, read-only view of the state). */
  toApi(): Record<string, unknown> {
    return documentApi(this);
  }

  #getLines(): string[] {
    this.#lines ??= this.#text.split(/\r\n|\r|\n/);
    return this.#lines;
  }

  #getLineStarts(): number[] {
    if (this.#lineStarts) return this.#lineStarts;
    const starts = [0];
    const text = this.#text;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      if (ch === 13 /* \r */) {
        if (text.charCodeAt(i + 1) === 10) i++;
        starts.push(i + 1);
      } else if (ch === 10) starts.push(i + 1);
    }
    this.#lineStarts = starts;
    return starts;
  }
}

const apiCache = new WeakMap<ExtHostDocument, Record<string, unknown>>();

/** A stable facade per document, so extensions can compare documents with ===. */
function documentApi(doc: ExtHostDocument): Record<string, unknown> {
  const cached = apiCache.get(doc);
  if (cached) return cached;
  const facade: Record<string, unknown> = {};
  Object.defineProperties(facade, {
    uri: { get: () => doc.uri, enumerable: true },
    fileName: { get: () => doc.fileName, enumerable: true },
    isUntitled: { get: () => doc.isUntitled, enumerable: true },
    languageId: { get: () => doc.languageId, enumerable: true },
    version: { get: () => doc.version, enumerable: true },
    isDirty: { get: () => doc.isDirty, enumerable: true },
    isClosed: { get: () => doc.isClosed, enumerable: true },
    eol: { get: () => doc.eol, enumerable: true },
    encoding: { get: () => doc.encoding, enumerable: true },
    lineCount: { get: () => doc.lineCount, enumerable: true },
  });
  Object.assign(facade, {
    save: () => doc.save(),
    getText: (range?: Range) => doc.getText(range),
    lineAt: (line: number | Position) => doc.lineAt(line),
    offsetAt: (position: Position) => doc.offsetAt(position),
    positionAt: (offset: number) => doc.positionAt(offset),
    getWordRangeAtPosition: (position: Position, regex?: RegExp) => doc.getWordRangeAtPosition(position, regex),
    validateRange: (range: Range) => doc.validateRange(range),
    validatePosition: (position: Position) => doc.validatePosition(position),
  });
  apiCache.set(doc, facade);
  return facade;
}
