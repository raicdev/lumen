/**
 * Value types of the extension API (`lumen` / `vscode` module): Uri, Position,
 * Range, … — behaviour-compatible with their VS Code counterparts, so
 * extensions written against VS Code work unchanged.
 */

/** Numeric enums as frozen objects with reverse mapping (`DiagnosticSeverity[0] === "Error"`), like TypeScript enums. */
function enumOf<T extends Record<string, number>>(values: T): Readonly<T> & Readonly<Record<number, string>> {
  const result: Record<string | number, string | number> = { ...values };
  for (const [key, value] of Object.entries(values)) result[value] = key;
  return Object.freeze(result) as Readonly<T> & Readonly<Record<number, string>>;
}

/* ── Uri ─────────────────────────────────────────────────────────────────── */

const isWindows = process.platform === "win32";
const URI_REGEX = /^(([^:/?#]+?):)?(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?/;

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Percent-encode everything but unreserved characters (and `/` in paths), like vscode-uri. */
function encode(value: string, keepSlash: boolean): string {
  let out = "";
  for (const ch of value) {
    if (/[A-Za-z0-9\-._~]/.test(ch) || (keepSlash && ch === "/")) out += ch;
    else out += encodeURIComponent(ch).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  }
  return out;
}

export type UriComponents = { scheme: string; authority?: string; path?: string; query?: string; fragment?: string };

export class Uri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;

  protected constructor(scheme: string, authority = "", path = "", query = "", fragment = "") {
    this.scheme = scheme || "file";
    this.authority = authority;
    // Paths of URIs with an authority (or file URIs) are absolute.
    this.path = (authority || this.scheme === "file") && path && !path.startsWith("/") ? `/${path}` : path || (authority ? "/" : "");
    this.query = query;
    this.fragment = fragment;
  }

  static parse(value: string, _strict = false): Uri {
    const match = URI_REGEX.exec(value);
    if (!match) return new Uri("");
    return new Uri(match[2] ?? "", decode(match[4] ?? ""), decode(match[5] ?? ""), decode(match[7] ?? ""), decode(match[9] ?? ""));
  }

  static file(path: string): Uri {
    let authority = "";
    let normalized = isWindows ? path.replace(/\\/g, "/") : path;
    // UNC: //server/share/…
    if (normalized.startsWith("//")) {
      const end = normalized.indexOf("/", 2);
      authority = end < 0 ? normalized.slice(2) : normalized.slice(2, end);
      normalized = end < 0 ? "/" : normalized.slice(end);
    }
    if (!normalized.startsWith("/")) normalized = `/${normalized}`;
    return new Uri("file", authority, normalized);
  }

  static from(components: UriComponents): Uri {
    return new Uri(components.scheme, components.authority, components.path, components.query, components.fragment);
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    const parts = [base.path, ...segments].join("/").split("/");
    const out: string[] = [];
    for (const part of parts) {
      if (part === "..") out.pop();
      else if (part && part !== ".") out.push(part);
    }
    return base.with({ path: `/${out.join("/")}` });
  }

  static isUri(thing: unknown): thing is Uri {
    if (thing instanceof Uri) return true;
    const t = thing as Partial<Uri> | null;
    return !!t && typeof t.scheme === "string" && typeof t.path === "string" && typeof t.with === "function" && typeof t.toString === "function";
  }

  /** Revive a URI that went through JSON (`toJSON`). */
  static revive(data: UriComponents | Uri | undefined | null): Uri | undefined {
    if (!data) return undefined;
    if (data instanceof Uri) return data;
    return Uri.from(data);
  }

  with(change: Partial<UriComponents>): Uri {
    const next = {
      scheme: change.scheme ?? this.scheme,
      authority: change.authority ?? this.authority,
      path: change.path ?? this.path,
      query: change.query ?? this.query,
      fragment: change.fragment ?? this.fragment,
    };
    if (
      next.scheme === this.scheme &&
      next.authority === this.authority &&
      next.path === this.path &&
      next.query === this.query &&
      next.fragment === this.fragment
    ) {
      return this;
    }
    return new Uri(next.scheme, next.authority, next.path, next.query, next.fragment);
  }

  /** The platform path of a file URI (drive letters lower-cased, like VS Code). */
  get fsPath(): string {
    let value: string;
    if (this.authority && this.path.length > 1 && this.scheme === "file") value = `//${this.authority}${this.path}`;
    else if (/^\/[a-zA-Z]:/.test(this.path)) value = this.path[1]!.toLowerCase() + this.path.slice(2);
    else value = this.path;
    return isWindows ? value.replace(/\//g, "\\") : value;
  }

  toString(skipEncoding = false): string {
    const enc = (value: string, slash: boolean) => (skipEncoding ? value : encode(value, slash));
    let out = "";
    if (this.scheme) out += `${this.scheme}:`;
    if (this.authority || this.scheme === "file") out += "//";
    // user@host:port keeps its delimiters.
    if (this.authority) out += skipEncoding ? this.authority.toLowerCase() : this.authority.toLowerCase().split(/([:@[\]])/).map((part) => (/^[:@[\]]$/.test(part) ? part : encode(part, false))).join("");
    if (this.path) {
      let path = this.path;
      const drive = /^\/([a-zA-Z]):/.exec(path) ?? /^([a-zA-Z]):/.exec(path);
      if (drive) {
        const offset = path.startsWith("/") ? 1 : 0;
        path = `${offset ? "/" : ""}${drive[1]!.toLowerCase()}:${path.slice(offset + 2)}`;
        out += skipEncoding ? path : `${offset ? "/" : ""}${drive[1]!.toLowerCase()}%3A${encode(path.slice(offset + 2), true)}`;
      } else out += enc(path, true);
    }
    if (this.query) out += `?${enc(this.query, false)}`;
    if (this.fragment) out += `#${skipEncoding ? this.fragment : encode(this.fragment, false)}`;
    return out;
  }

  toJSON(): UriComponents & { $mid: number; fsPath: string; external: string } {
    return { $mid: 1, scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment, fsPath: this.fsPath, external: this.toString() };
  }
}

/* ── positions & ranges ──────────────────────────────────────────────────── */

export class Position {
  readonly line: number;
  readonly character: number;

  constructor(line: number, character: number) {
    if (line < 0 || character < 0) throw new Error("Illegal argument: line and character must be non-negative");
    this.line = line;
    this.character = character;
  }

  static isPosition(thing: unknown): thing is Position {
    const t = thing as Position | null;
    return thing instanceof Position || (!!t && typeof t.line === "number" && typeof t.character === "number");
  }

  isBefore(other: Position): boolean {
    return this.line < other.line || (this.line === other.line && this.character < other.character);
  }
  isBeforeOrEqual(other: Position): boolean {
    return this.isBefore(other) || this.isEqual(other);
  }
  isAfter(other: Position): boolean {
    return !this.isBeforeOrEqual(other);
  }
  isAfterOrEqual(other: Position): boolean {
    return !this.isBefore(other);
  }
  isEqual(other: Position): boolean {
    return this.line === other.line && this.character === other.character;
  }
  compareTo(other: Position): number {
    return this.line - other.line || this.character - other.character;
  }
  translate(lineDelta: number | { lineDelta?: number; characterDelta?: number } = 0, characterDelta = 0): Position {
    if (typeof lineDelta === "object") return this.translate(lineDelta.lineDelta ?? 0, lineDelta.characterDelta ?? 0);
    if (!lineDelta && !characterDelta) return this;
    return new Position(this.line + lineDelta, this.character + characterDelta);
  }
  with(line: number | { line?: number; character?: number } = this.line, character = this.character): Position {
    if (typeof line === "object") return this.with(line.line ?? this.line, line.character ?? this.character);
    if (line === this.line && character === this.character) return this;
    return new Position(line, character);
  }
  toJSON() {
    return { line: this.line, character: this.character };
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;

  constructor(startOrLine: Position | number, endOrCharacter: Position | number, endLine?: number, endCharacter?: number) {
    let start: Position;
    let end: Position;
    if (typeof startOrLine === "number" && typeof endOrCharacter === "number") {
      start = new Position(startOrLine, endOrCharacter);
      end = new Position(endLine ?? startOrLine, endCharacter ?? endOrCharacter);
    } else {
      start = toPosition(startOrLine as Position);
      end = toPosition(endOrCharacter as Position);
    }
    if (start.isAfter(end)) [start, end] = [end, start];
    this.start = start;
    this.end = end;
  }

  static isRange(thing: unknown): thing is Range {
    const t = thing as Range | null;
    return thing instanceof Range || (!!t && Position.isPosition(t.start) && Position.isPosition(t.end));
  }

  get isEmpty(): boolean {
    return this.start.isEqual(this.end);
  }
  get isSingleLine(): boolean {
    return this.start.line === this.end.line;
  }
  contains(value: Position | Range): boolean {
    if (Range.isRange(value)) return this.contains(value.start) && this.contains(value.end);
    return toPosition(value).isAfterOrEqual(this.start) && toPosition(value).isBeforeOrEqual(this.end);
  }
  isEqual(other: Range): boolean {
    return this.start.isEqual(other.start) && this.end.isEqual(other.end);
  }
  intersection(other: Range): Range | undefined {
    const start = this.start.isAfter(other.start) ? this.start : other.start;
    const end = this.end.isBefore(other.end) ? this.end : other.end;
    return start.isAfter(end) ? undefined : new Range(start, end);
  }
  union(other: Range): Range {
    return new Range(this.start.isBefore(other.start) ? this.start : other.start, this.end.isAfter(other.end) ? this.end : other.end);
  }
  with(start: Position | { start?: Position; end?: Position } = this.start, end: Position = this.end): Range {
    if (!Position.isPosition(start)) return this.with(start.start ?? this.start, start.end ?? this.end);
    if (start.isEqual(this.start) && end.isEqual(this.end)) return this;
    return new Range(start, end);
  }
  toJSON() {
    return { start: this.start.toJSON(), end: this.end.toJSON() };
  }
}

function toPosition(value: Position | { line: number; character: number }): Position {
  return value instanceof Position ? value : new Position(value.line, value.character);
}

export function toRange(value: Range | { start: { line: number; character: number }; end: { line: number; character: number } }): Range {
  return value instanceof Range ? value : new Range(toPosition(value.start), toPosition(value.end));
}

export class Selection extends Range {
  readonly anchor: Position;
  readonly active: Position;

  constructor(anchorOrLine: Position | number, activeOrCharacter: Position | number, activeLine?: number, activeCharacter?: number) {
    const anchor = typeof anchorOrLine === "number" ? new Position(anchorOrLine, activeOrCharacter as number) : toPosition(anchorOrLine);
    const active =
      typeof anchorOrLine === "number" ? new Position(activeLine ?? anchorOrLine, activeCharacter ?? (activeOrCharacter as number)) : toPosition(activeOrCharacter as Position);
    super(anchor, active);
    this.anchor = anchor;
    this.active = active;
  }

  static isSelection(thing: unknown): thing is Selection {
    const t = thing as Selection | null;
    return thing instanceof Selection || (!!t && Range.isRange(t) && Position.isPosition(t.anchor) && Position.isPosition(t.active));
  }

  get isReversed(): boolean {
    return this.anchor.isAfter(this.active);
  }
}

export class Location {
  uri: Uri;
  range: Range;
  constructor(uri: Uri, rangeOrPosition: Range | Position) {
    this.uri = uri;
    this.range = Range.isRange(rangeOrPosition) ? toRange(rangeOrPosition) : new Range(rangeOrPosition, rangeOrPosition);
  }
}

/* ── diagnostics ─────────────────────────────────────────────────────────── */

export const DiagnosticSeverity = enumOf({
  Error: 0,
  Warning: 1,
  Information: 2,
  Hint: 3,
});
export type DiagnosticSeverity = number;

export const DiagnosticTag = enumOf({
  Unnecessary: 1,
  Deprecated: 2,
});
export type DiagnosticTag = number;

export class DiagnosticRelatedInformation {
  location: Location;
  message: string;
  constructor(location: Location, message: string) {
    this.location = location;
    this.message = message;
  }
}

export class Diagnostic {
  range: Range;
  message: string;
  severity: DiagnosticSeverity;
  source?: string;
  code?: string | number | { value: string | number; target: Uri };
  relatedInformation?: DiagnosticRelatedInformation[];
  tags?: DiagnosticTag[];
  constructor(range: Range, message: string, severity: DiagnosticSeverity = DiagnosticSeverity.Error) {
    this.range = range;
    this.message = message;
    this.severity = severity;
  }
}

/* ── edits ───────────────────────────────────────────────────────────────── */

export const EndOfLine = enumOf({
  LF: 1,
  CRLF: 2,
});
export type EndOfLine = number;

export class TextEdit {
  range: Range;
  newText: string;
  newEol?: EndOfLine;
  constructor(range: Range, newText: string) {
    this.range = range;
    this.newText = newText;
  }
  static replace(range: Range, newText: string) {
    return new TextEdit(range, newText);
  }
  static insert(position: Position, newText: string) {
    return new TextEdit(new Range(position, position), newText);
  }
  static delete(range: Range) {
    return new TextEdit(range, "");
  }
  static setEndOfLine(eol: EndOfLine) {
    const edit = new TextEdit(new Range(0, 0, 0, 0), "");
    edit.newEol = eol;
    return edit;
  }
  static isTextEdit(thing: unknown): thing is TextEdit {
    const t = thing as TextEdit | null;
    return thing instanceof TextEdit || (!!t && Range.isRange(t.range) && typeof t.newText === "string");
  }
}

/** WorkspaceEditEntryMetadata: shown when an edit needs confirmation. */
export type WorkspaceEditEntryMetadata = { needsConfirmation: boolean; label: string; description?: string; iconPath?: unknown };

/** A SnippetTextEdit (compat-types) as stored in a WorkspaceEdit. */
export type SnippetEdit = { range: Range; snippet: { value: string }; keepWhitespace?: boolean };

/** createFile contents: bytes, or a DataTransferFile read when the edit is applied. */
export type CreateFileContents = Uint8Array | { data(): PromiseLike<Uint8Array> };

export type WorkspaceEditEntry = { metadata?: WorkspaceEditEntryMetadata } & (
  | { kind: "text"; uri: Uri; edit: TextEdit }
  | { kind: "snippet"; uri: Uri; edit: SnippetEdit }
  | { kind: "notebook"; uri: Uri; edit: unknown }
  | { kind: "create"; uri: Uri; options?: { overwrite?: boolean; ignoreIfExists?: boolean; contents?: CreateFileContents } }
  | { kind: "delete"; uri: Uri; options?: { recursive?: boolean; ignoreIfNotExists?: boolean } }
  | { kind: "rename"; from: Uri; to: Uri; options?: { overwrite?: boolean; ignoreIfExists?: boolean } }
);

const isSnippetEdit = (thing: unknown): thing is SnippetEdit => {
  const t = thing as SnippetEdit | null;
  return !!t && typeof t === "object" && !!t.range && !!t.snippet && typeof t.snippet.value === "string";
};
const isNotebookEdit = (thing: unknown): boolean => !!thing && typeof thing === "object" && Array.isArray((thing as { newCells?: unknown }).newCells);

export class WorkspaceEdit {
  readonly _entries: WorkspaceEditEntry[] = [];

  replace(uri: Uri, range: Range, newText: string, metadata?: WorkspaceEditEntryMetadata): void {
    this._entries.push({ kind: "text", uri, edit: new TextEdit(range, newText), metadata });
  }
  insert(uri: Uri, position: Position, newText: string, metadata?: WorkspaceEditEntryMetadata): void {
    this.replace(uri, new Range(position, position), newText, metadata);
  }
  delete(uri: Uri, range: Range, metadata?: WorkspaceEditEntryMetadata): void {
    this.replace(uri, range, "", metadata);
  }
  has(uri: Uri): boolean {
    return this._entries.some((entry) => (entry.kind === "text" || entry.kind === "snippet") && entry.uri.toString() === uri.toString());
  }
  /** Replace the text, snippet and notebook edits of a resource (each item may be an [edit, metadata] pair). */
  set(uri: Uri, edits: readonly unknown[] | null | undefined): void {
    for (let i = this._entries.length - 1; i >= 0; i--) {
      const entry = this._entries[i]!;
      if ((entry.kind === "text" || entry.kind === "snippet" || entry.kind === "notebook") && entry.uri.toString() === uri.toString()) this._entries.splice(i, 1);
    }
    for (const item of edits ?? []) {
      const [edit, metadata] = Array.isArray(item) ? (item as [unknown, WorkspaceEditEntryMetadata | undefined]) : [item, undefined];
      if (TextEdit.isTextEdit(edit)) this._entries.push({ kind: "text", uri, edit, metadata });
      else if (isSnippetEdit(edit)) this._entries.push({ kind: "snippet", uri, edit, metadata });
      else if (isNotebookEdit(edit)) this._entries.push({ kind: "notebook", uri, edit, metadata });
    }
  }
  get(uri: Uri): TextEdit[] {
    return this._entries.flatMap((entry) => (entry.kind === "text" && entry.uri.toString() === uri.toString() ? [entry.edit] : []));
  }
  createFile(uri: Uri, options?: { overwrite?: boolean; ignoreIfExists?: boolean; contents?: CreateFileContents }, metadata?: WorkspaceEditEntryMetadata): void {
    this._entries.push({ kind: "create", uri, options, metadata });
  }
  deleteFile(uri: Uri, options?: { recursive?: boolean; ignoreIfNotExists?: boolean }, metadata?: WorkspaceEditEntryMetadata): void {
    this._entries.push({ kind: "delete", uri, options, metadata });
  }
  renameFile(from: Uri, to: Uri, options?: { overwrite?: boolean; ignoreIfExists?: boolean }, metadata?: WorkspaceEditEntryMetadata): void {
    this._entries.push({ kind: "rename", from, to, options, metadata });
  }
  entries(): [Uri, TextEdit[]][] {
    const map = new Map<string, [Uri, TextEdit[]]>();
    for (const entry of this._entries) {
      if (entry.kind !== "text") continue;
      const key = entry.uri.toString();
      if (!map.has(key)) map.set(key, [entry.uri, []]);
      map.get(key)![1].push(entry.edit);
    }
    return [...map.values()];
  }
  get size(): number {
    return this.entries().length;
  }
}

export class SnippetString {
  value: string;
  #tabstop = 1;
  constructor(value = "") {
    this.value = value;
  }
  static isSnippetString(thing: unknown): thing is SnippetString {
    return thing instanceof SnippetString || (!!thing && typeof (thing as SnippetString).value === "string" && typeof (thing as SnippetString).appendTabstop === "function");
  }
  static #escape(value: string) {
    return value.replace(/[$}\\]/g, "\\$&");
  }
  appendText(value: string): SnippetString {
    this.value += SnippetString.#escape(value);
    return this;
  }
  appendTabstop(number = this.#tabstop++): SnippetString {
    this.value += `$${number}`;
    return this;
  }
  appendPlaceholder(value: string | ((snippet: SnippetString) => unknown), number = this.#tabstop++): SnippetString {
    let text: string;
    if (typeof value === "function") {
      const nested = new SnippetString();
      nested.#tabstop = this.#tabstop;
      value(nested);
      this.#tabstop = nested.#tabstop;
      text = nested.value;
    } else text = SnippetString.#escape(value);
    this.value += `\${${number}:${text}}`;
    return this;
  }
  appendChoice(values: string[], number = this.#tabstop++): SnippetString {
    this.value += `\${${number}|${values.map((v) => v.replace(/[,|\\]/g, "\\$&")).join(",")}|}`;
    return this;
  }
  appendVariable(name: string, defaultValue?: string | ((snippet: SnippetString) => unknown)): SnippetString {
    if (defaultValue === undefined) this.value += `\${${name}}`;
    else if (typeof defaultValue === "function") {
      const nested = new SnippetString();
      defaultValue(nested);
      this.value += `\${${name}:${nested.value}}`;
    } else this.value += `\${${name}:${SnippetString.#escape(defaultValue)}}`;
    return this;
  }
}

export class MarkdownString {
  value: string;
  isTrusted?: boolean | { enabledCommands: readonly string[] };
  supportThemeIcons?: boolean;
  supportHtml?: boolean;
  baseUri?: Uri;
  constructor(value = "", supportThemeIcons = false) {
    this.value = value;
    this.supportThemeIcons = supportThemeIcons;
  }
  static isMarkdownString(thing: unknown): thing is MarkdownString {
    return thing instanceof MarkdownString || (!!thing && typeof (thing as MarkdownString).value === "string" && typeof (thing as MarkdownString).appendMarkdown === "function");
  }
  appendText(value: string): MarkdownString {
    this.value += value.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&").replace(/\n/g, "\n\n");
    return this;
  }
  appendMarkdown(value: string): MarkdownString {
    this.value += value;
    return this;
  }
  appendCodeblock(code: string, language = ""): MarkdownString {
    this.value += `\n\`\`\`${language}\n${code}\n\`\`\`\n`;
    return this;
  }
}

/* ── language features ───────────────────────────────────────────────────── */

export const CompletionItemKind = enumOf({
  Text: 0,
  Method: 1,
  Function: 2,
  Constructor: 3,
  Field: 4,
  Variable: 5,
  Class: 6,
  Interface: 7,
  Module: 8,
  Property: 9,
  Unit: 10,
  Value: 11,
  Enum: 12,
  Keyword: 13,
  Snippet: 14,
  Color: 15,
  File: 16,
  Reference: 17,
  Folder: 18,
  EnumMember: 19,
  Constant: 20,
  Struct: 21,
  Event: 22,
  Operator: 23,
  TypeParameter: 24,
  User: 25,
  Issue: 26,
});
export type CompletionItemKind = number;

export const CompletionItemTag = enumOf({
  Deprecated: 1,
});
export type CompletionItemTag = number;

export const CompletionTriggerKind = enumOf({
  Invoke: 0,
  TriggerCharacter: 1,
  TriggerForIncompleteCompletions: 2,
});
export type CompletionTriggerKind = number;

export type CompletionItemLabel = { label: string; detail?: string; description?: string };

export class CompletionItem {
  label: string | CompletionItemLabel;
  kind?: CompletionItemKind;
  tags?: CompletionItemTag[];
  detail?: string;
  documentation?: string | MarkdownString;
  sortText?: string;
  filterText?: string;
  preselect?: boolean;
  insertText?: string | SnippetString;
  range?: Range | { inserting: Range; replacing: Range };
  commitCharacters?: string[];
  keepWhitespace?: boolean;
  command?: Command;
  additionalTextEdits?: TextEdit[];
  constructor(label: string | CompletionItemLabel, kind?: CompletionItemKind) {
    this.label = label;
    this.kind = kind;
  }
}

export class CompletionList<T extends CompletionItem = CompletionItem> {
  isIncomplete?: boolean;
  items: T[];
  constructor(items: T[] = [], isIncomplete = false) {
    this.items = items;
    this.isIncomplete = isIncomplete;
  }
}

export type Command = { title: string; command: string; tooltip?: string; arguments?: unknown[] };

export class Hover {
  contents: (MarkdownString | string | { language: string; value: string })[];
  range?: Range;
  constructor(contents: MarkdownString | string | { language: string; value: string } | (MarkdownString | string | { language: string; value: string })[], range?: Range) {
    this.contents = Array.isArray(contents) ? contents : [contents];
    this.range = range;
  }
}

export const SymbolKind = enumOf({
  File: 0,
  Module: 1,
  Namespace: 2,
  Package: 3,
  Class: 4,
  Method: 5,
  Property: 6,
  Field: 7,
  Constructor: 8,
  Enum: 9,
  Interface: 10,
  Function: 11,
  Variable: 12,
  Constant: 13,
  String: 14,
  Number: 15,
  Boolean: 16,
  Array: 17,
  Object: 18,
  Key: 19,
  Null: 20,
  EnumMember: 21,
  Struct: 22,
  Event: 23,
  Operator: 24,
  TypeParameter: 25,
});
export type SymbolKind = number;

export const SymbolTag = enumOf({
  Deprecated: 1,
});
export type SymbolTag = number;

export class DocumentSymbol {
  name: string;
  detail: string;
  kind: SymbolKind;
  tags?: SymbolTag[];
  range: Range;
  selectionRange: Range;
  children: DocumentSymbol[] = [];
  constructor(name: string, detail: string, kind: SymbolKind, range: Range, selectionRange: Range) {
    this.name = name;
    this.detail = detail;
    this.kind = kind;
    this.range = range;
    this.selectionRange = selectionRange;
  }
}

export class SymbolInformation {
  name: string;
  kind: SymbolKind;
  containerName: string;
  location: Location;
  tags?: SymbolTag[];
  constructor(name: string, kind: SymbolKind, containerNameOrRange: string | Range, locationOrUri?: Location | Uri, containerName?: string) {
    this.name = name;
    this.kind = kind;
    if (typeof containerNameOrRange === "string") {
      this.containerName = containerNameOrRange;
      this.location = locationOrUri as Location;
    } else {
      this.containerName = containerName ?? "";
      this.location = new Location(locationOrUri as Uri, containerNameOrRange);
    }
  }
}

export class CodeActionKind {
  static readonly Empty = new CodeActionKind("");
  static readonly QuickFix = new CodeActionKind("quickfix");
  static readonly Refactor = new CodeActionKind("refactor");
  static readonly RefactorExtract = new CodeActionKind("refactor.extract");
  static readonly RefactorInline = new CodeActionKind("refactor.inline");
  static readonly RefactorMove = new CodeActionKind("refactor.move");
  static readonly RefactorRewrite = new CodeActionKind("refactor.rewrite");
  static readonly Source = new CodeActionKind("source");
  static readonly SourceOrganizeImports = new CodeActionKind("source.organizeImports");
  static readonly SourceFixAll = new CodeActionKind("source.fixAll");
  static readonly Notebook = new CodeActionKind("notebook");
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  append(part: string): CodeActionKind {
    return new CodeActionKind(this.value ? `${this.value}.${part}` : part);
  }
  intersects(other: CodeActionKind): boolean {
    return this.contains(other) || other.contains(this);
  }
  contains(other: CodeActionKind): boolean {
    return this.value === other.value || other.value.startsWith(`${this.value}.`) || this.value === "";
  }
}

export const CodeActionTriggerKind = enumOf({
  Invoke: 1,
  Automatic: 2,
});
export type CodeActionTriggerKind = number;

export class CodeAction {
  title: string;
  kind?: CodeActionKind;
  edit?: WorkspaceEdit;
  diagnostics?: Diagnostic[];
  command?: Command;
  isPreferred?: boolean;
  disabled?: { reason: string };
  constructor(title: string, kind?: CodeActionKind) {
    this.title = title;
    this.kind = kind;
  }
}

export class CodeLens {
  range: Range;
  command?: Command;
  constructor(range: Range, command?: Command) {
    this.range = range;
    this.command = command;
  }
  get isResolved() {
    return !!this.command;
  }
}

export const FoldingRangeKind = enumOf({
  Comment: 1,
  Imports: 2,
  Region: 3,
});
export type FoldingRangeKind = number;

export class FoldingRange {
  start: number;
  end: number;
  kind?: FoldingRangeKind;
  constructor(start: number, end: number, kind?: FoldingRangeKind) {
    this.start = start;
    this.end = end;
    this.kind = kind;
  }
}

export class ParameterInformation {
  label: string | [number, number];
  documentation?: string | MarkdownString;
  constructor(label: string | [number, number], documentation?: string | MarkdownString) {
    this.label = label;
    this.documentation = documentation;
  }
}

export class SignatureInformation {
  label: string;
  documentation?: string | MarkdownString;
  parameters: ParameterInformation[] = [];
  activeParameter?: number;
  constructor(label: string, documentation?: string | MarkdownString) {
    this.label = label;
    this.documentation = documentation;
  }
}

export class SignatureHelp {
  signatures: SignatureInformation[] = [];
  activeSignature = 0;
  activeParameter = 0;
}

export const SignatureHelpTriggerKind = enumOf({
  Invoke: 1,
  TriggerCharacter: 2,
  ContentChange: 3,
});
export type SignatureHelpTriggerKind = number;

export class DocumentLink {
  range: Range;
  target?: Uri;
  tooltip?: string;
  constructor(range: Range, target?: Uri) {
    this.range = range;
    this.target = target;
  }
}

export const DocumentHighlightKind = enumOf({
  Text: 0,
  Read: 1,
  Write: 2,
});
export type DocumentHighlightKind = number;

export class DocumentHighlight {
  range: Range;
  kind?: DocumentHighlightKind;
  constructor(range: Range, kind: DocumentHighlightKind = DocumentHighlightKind.Text) {
    this.range = range;
    this.kind = kind;
  }
}

export class Color {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;
  constructor(red: number, green: number, blue: number, alpha: number) {
    this.red = red;
    this.green = green;
    this.blue = blue;
    this.alpha = alpha;
  }
}

export class ColorInformation {
  range: Range;
  color: Color;
  constructor(range: Range, color: Color) {
    this.range = range;
    this.color = color;
  }
}

export class ColorPresentation {
  label: string;
  textEdit?: TextEdit;
  additionalTextEdits?: TextEdit[];
  constructor(label: string) {
    this.label = label;
  }
}

export const InlayHintKind = enumOf({
  Type: 1,
  Parameter: 2,
});
export type InlayHintKind = number;

export class InlayHintLabelPart {
  value: string;
  tooltip?: string | MarkdownString;
  location?: Location;
  command?: Command;
  constructor(value: string) {
    this.value = value;
  }
}

export class InlayHint {
  position: Position;
  label: string | InlayHintLabelPart[];
  kind?: InlayHintKind;
  tooltip?: string | MarkdownString;
  paddingLeft?: boolean;
  paddingRight?: boolean;
  textEdits?: TextEdit[];
  constructor(position: Position, label: string | InlayHintLabelPart[], kind?: InlayHintKind) {
    this.position = position;
    this.label = label;
    this.kind = kind;
  }
}

export class SemanticTokensLegend {
  readonly tokenTypes: string[];
  readonly tokenModifiers: string[];
  constructor(tokenTypes: string[], tokenModifiers: string[] = []) {
    this.tokenTypes = tokenTypes;
    this.tokenModifiers = tokenModifiers;
  }
}

export class SemanticTokens {
  readonly resultId?: string;
  readonly data: Uint32Array;
  constructor(data: Uint32Array, resultId?: string) {
    this.data = data;
    this.resultId = resultId;
  }
}

export class SemanticTokensEdit {
  readonly start: number;
  readonly deleteCount: number;
  readonly data?: Uint32Array;
  constructor(start: number, deleteCount: number, data?: Uint32Array) {
    this.start = start;
    this.deleteCount = deleteCount;
    this.data = data;
  }
}

export class SemanticTokensEdits {
  readonly resultId?: string;
  readonly edits: SemanticTokensEdit[];
  constructor(edits: SemanticTokensEdit[], resultId?: string) {
    this.edits = edits;
    this.resultId = resultId;
  }
}

export class SemanticTokensBuilder {
  #data: number[] = [];
  #prevLine = 0;
  #prevChar = 0;
  constructor(_legend?: SemanticTokensLegend) {}
  push(line: number | Range, char: number | string, length?: number | string[], tokenType?: number, tokenModifiers = 0): void {
    if (typeof line !== "number") return; // range form needs the legend; not used by Lumen
    const deltaLine = line - this.#prevLine;
    const deltaChar = deltaLine ? (char as number) : (char as number) - this.#prevChar;
    this.#data.push(deltaLine, deltaChar, length as number, tokenType ?? 0, tokenModifiers);
    this.#prevLine = line;
    this.#prevChar = char as number;
  }
  build(resultId?: string): SemanticTokens {
    return new SemanticTokens(new Uint32Array(this.#data), resultId);
  }
}

export class SelectionRange {
  range: Range;
  parent?: SelectionRange;
  constructor(range: Range, parent?: SelectionRange) {
    this.range = range;
    this.parent = parent;
  }
}

export class InlineCompletionItem {
  insertText: string | SnippetString;
  range?: Range;
  command?: Command;
  constructor(insertText: string | SnippetString, range?: Range, command?: Command) {
    this.insertText = insertText;
    this.range = range;
    this.command = command;
  }
}

export class InlineCompletionList {
  items: InlineCompletionItem[];
  commands?: Command[];
  constructor(items: InlineCompletionItem[]) {
    this.items = items;
  }
}

export const InlineCompletionTriggerKind = enumOf({
  Invoke: 0,
  Automatic: 1,
});
export type InlineCompletionTriggerKind = number;

export const IndentAction = enumOf({
  None: 0,
  Indent: 1,
  IndentOutdent: 2,
  Outdent: 3,
});
export type IndentAction = number;

export const LanguageStatusSeverity = enumOf({
  Information: 0,
  Warning: 1,
  Error: 2,
});
export type LanguageStatusSeverity = number;

/* ── workbench ───────────────────────────────────────────────────────────── */

export class ThemeColor {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
}

export class FileDecoration {
  badge?: string;
  tooltip?: string;
  color?: ThemeColor;
  propagate?: boolean;
  constructor(badge?: string, tooltip?: string, color?: ThemeColor) {
    this.badge = badge;
    this.tooltip = tooltip;
    this.color = color;
  }
  static validate(d: FileDecoration): boolean {
    if (d.badge && d.badge.length > 2) {
      throw new Error("The 'badge' property can only have 2 characters or less");
    }
    return true;
  }
}

export class ThemeIcon {
  static readonly File = new ThemeIcon("file");
  static readonly Folder = new ThemeIcon("folder");
  readonly id: string;
  readonly color?: ThemeColor;
  constructor(id: string, color?: ThemeColor) {
    this.id = id;
    this.color = color;
  }
}

export const TreeItemCollapsibleState = enumOf({
  None: 0,
  Collapsed: 1,
  Expanded: 2,
});
export type TreeItemCollapsibleState = number;

export const TreeItemCheckboxState = enumOf({
  Unchecked: 0,
  Checked: 1,
});
export type TreeItemCheckboxState = number;

export class TreeItem {
  label?: string | { label: string; highlights?: [number, number][] };
  id?: string;
  resourceUri?: Uri;
  iconPath?: unknown;
  description?: string | boolean;
  tooltip?: string | MarkdownString;
  command?: Command;
  contextValue?: string;
  collapsibleState?: TreeItemCollapsibleState;
  checkboxState?: TreeItemCheckboxState | { state: TreeItemCheckboxState; tooltip?: string };
  accessibilityInformation?: { label: string; role?: string };
  constructor(labelOrUri: string | { label: string; highlights?: [number, number][] } | Uri, collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None) {
    if (Uri.isUri(labelOrUri)) this.resourceUri = labelOrUri;
    else this.label = labelOrUri;
    this.collapsibleState = collapsibleState;
  }
}

export const StatusBarAlignment = enumOf({
  Left: 1,
  Right: 2,
});
export type StatusBarAlignment = number;

export const ViewColumn = enumOf({
  Active: -1,
  Beside: -2,
  One: 1,
  Two: 2,
  Three: 3,
  Four: 4,
  Five: 5,
  Six: 6,
  Seven: 7,
  Eight: 8,
  Nine: 9,
});
export type ViewColumn = number;

export const TextEditorRevealType = enumOf({
  Default: 0,
  InCenter: 1,
  InCenterIfOutsideViewport: 2,
  AtTop: 3,
});
export type TextEditorRevealType = number;

export const TextEditorCursorStyle = enumOf({
  Line: 1,
  Block: 2,
  Underline: 3,
  LineThin: 4,
  BlockOutline: 5,
  UnderlineThin: 6,
});
export type TextEditorCursorStyle = number;

export const TextEditorLineNumbersStyle = enumOf({
  Off: 0,
  On: 1,
  Relative: 2,
  Interval: 3,
});
export type TextEditorLineNumbersStyle = number;

export const TextEditorSelectionChangeKind = enumOf({
  Keyboard: 1,
  Mouse: 2,
  Command: 3,
});
export type TextEditorSelectionChangeKind = number;

export const DecorationRangeBehavior = enumOf({
  OpenOpen: 0,
  ClosedClosed: 1,
  OpenClosed: 2,
  ClosedOpen: 3,
});
export type DecorationRangeBehavior = number;

export const OverviewRulerLane = enumOf({
  Left: 1,
  Center: 2,
  Right: 4,
  Full: 7,
});
export type OverviewRulerLane = number;

export const ConfigurationTarget = enumOf({
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3,
});
export type ConfigurationTarget = number;

export const ProgressLocation = enumOf({
  SourceControl: 1,
  Window: 10,
  Notification: 15,
});
export type ProgressLocation = number;

export const QuickPickItemKind = enumOf({
  Separator: -1,
  Default: 0,
});
export type QuickPickItemKind = number;

export const QuickInputButtons = { Back: { iconPath: new ThemeIcon("arrow-left") } };

export const TextDocumentSaveReason = enumOf({
  Manual: 1,
  AfterDelay: 2,
  FocusOut: 3,
});
export type TextDocumentSaveReason = number;

export const TextDocumentChangeReason = enumOf({
  Undo: 1,
  Redo: 2,
});
export type TextDocumentChangeReason = number;

export const ExtensionMode = enumOf({
  Production: 1,
  Development: 2,
  Test: 3,
});
export type ExtensionMode = number;

export const ExtensionKind = enumOf({
  UI: 1,
  Workspace: 2,
});
export type ExtensionKind = number;

export const UIKind = enumOf({
  Desktop: 1,
  Web: 2,
});
export type UIKind = number;

export const LogLevel = enumOf({
  Off: 0,
  Trace: 1,
  Debug: 2,
  Info: 3,
  Warning: 4,
  Error: 5,
});
export type LogLevel = number;

export const ColorThemeKind = enumOf({
  Light: 1,
  Dark: 2,
  HighContrast: 3,
  HighContrastLight: 4,
});
export type ColorThemeKind = number;

export const EnvironmentVariableMutatorType = enumOf({
  Replace: 1,
  Append: 2,
  Prepend: 3,
});
export type EnvironmentVariableMutatorType = number;

export const TerminalExitReason = enumOf({
  Unknown: 0,
  Shutdown: 1,
  Process: 2,
  User: 3,
  Extension: 4,
});
export type TerminalExitReason = number;

export const TerminalLocation = enumOf({
  Panel: 1,
  Editor: 2,
});
export type TerminalLocation = number;

/* ── files ───────────────────────────────────────────────────────────────── */

export const FileType = enumOf({
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64,
});
export type FileType = number;

export const FileChangeType = enumOf({
  Changed: 1,
  Created: 2,
  Deleted: 3,
});
export type FileChangeType = number;

export class FileSystemError extends Error {
  readonly code: string;
  constructor(messageOrUri?: string | Uri, code = "Unknown") {
    super(Uri.isUri(messageOrUri) ? messageOrUri.toString(true) : (messageOrUri ?? "file system error"));
    this.code = code;
    this.name = code === "Unknown" ? "FileSystemError" : `${code} (FileSystemError)`;
  }
  static FileNotFound(messageOrUri?: string | Uri) {
    return new FileSystemError(messageOrUri, "FileNotFound");
  }
  static FileExists(messageOrUri?: string | Uri) {
    return new FileSystemError(messageOrUri, "FileExists");
  }
  static FileNotADirectory(messageOrUri?: string | Uri) {
    return new FileSystemError(messageOrUri, "FileNotADirectory");
  }
  static FileIsADirectory(messageOrUri?: string | Uri) {
    return new FileSystemError(messageOrUri, "FileIsADirectory");
  }
  static NoPermissions(messageOrUri?: string | Uri) {
    return new FileSystemError(messageOrUri, "NoPermissions");
  }
  static Unavailable(messageOrUri?: string | Uri) {
    return new FileSystemError(messageOrUri, "Unavailable");
  }
}

export type WorkspaceFolder = { readonly uri: Uri; readonly name: string; readonly index: number };

export class RelativePattern {
  baseUri: Uri;
  pattern: string;
  constructor(base: WorkspaceFolder | Uri | string, pattern: string) {
    this.baseUri = typeof base === "string" ? Uri.file(base) : Uri.isUri(base) ? base : base.uri;
    this.pattern = pattern;
  }
  get base(): string {
    return this.baseUri.fsPath;
  }
}

/* ── events, disposables, cancellation ───────────────────────────────────── */

export class Disposable {
  #callOnDispose: (() => unknown) | null;
  constructor(callOnDispose: () => unknown) {
    this.#callOnDispose = callOnDispose;
  }
  static from(...disposables: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => {
      for (const disposable of disposables) disposable?.dispose();
    });
  }
  dispose(): unknown {
    const call = this.#callOnDispose;
    this.#callOnDispose = null;
    return call?.();
  }
}

export type Event<T> = (listener: (e: T) => unknown, thisArgs?: unknown, disposables?: Disposable[] | { push(d: Disposable): unknown }) => Disposable;

export class EventEmitter<T> {
  #listeners = new Set<{ listener: (e: T) => unknown; thisArgs: unknown }>();
  #disposed = false;

  readonly event: Event<T> = (listener, thisArgs, disposables) => {
    const entry = { listener, thisArgs };
    if (!this.#disposed) this.#listeners.add(entry);
    const disposable = new Disposable(() => this.#listeners.delete(entry));
    if (disposables) disposables.push(disposable);
    return disposable;
  };

  fire(data: T): void {
    for (const { listener, thisArgs } of [...this.#listeners]) {
      try {
        listener.call(thisArgs, data);
      } catch (error) {
        console.error("[extension host] event listener failed:", error);
      }
    }
  }

  get hasListeners(): boolean {
    return this.#listeners.size > 0;
  }

  dispose(): void {
    this.#disposed = true;
    this.#listeners.clear();
  }
}

export const noneEvent: Event<never> = () => new Disposable(() => {});

export type CancellationToken = { isCancellationRequested: boolean; onCancellationRequested: Event<unknown> };

export class CancellationTokenSource {
  #emitter = new EventEmitter<unknown>();
  readonly token: CancellationToken;
  constructor() {
    const emitter = this.#emitter;
    this.token = { isCancellationRequested: false, onCancellationRequested: emitter.event };
  }
  cancel(): void {
    if (this.token.isCancellationRequested) return;
    this.token.isCancellationRequested = true;
    this.#emitter.fire(undefined);
  }
  dispose(): void {
    this.#emitter.dispose();
  }
}

export const CancellationTokenNone: CancellationToken = { isCancellationRequested: false, onCancellationRequested: noneEvent };

export class CancellationError extends Error {
  constructor() {
    super("Canceled");
    this.name = "Canceled";
  }
}

/* ── debugging ───────────────────────────────────────────────────────────── */

let breakpointSeq = 0;

export const DebugConfigurationProviderTriggerKind = enumOf({ Initial: 1, Dynamic: 2 });
export type DebugConfigurationProviderTriggerKind = number;

export const DebugConsoleMode = enumOf({ Separate: 0, MergeWithParent: 1 });
export type DebugConsoleMode = number;

export class Breakpoint {
  readonly id: string;
  enabled: boolean;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  constructor(enabled = true, condition?: string, hitCondition?: string, logMessage?: string, id?: string) {
    this.id = id ?? `lumen-bp-${++breakpointSeq}`;
    this.enabled = enabled;
    this.condition = condition;
    this.hitCondition = hitCondition;
    this.logMessage = logMessage;
  }
}

export class SourceBreakpoint extends Breakpoint {
  readonly location: Location;
  constructor(location: Location, enabled?: boolean, condition?: string, hitCondition?: string, logMessage?: string, id?: string) {
    super(enabled, condition, hitCondition, logMessage, id);
    this.location = location;
  }
}

export class FunctionBreakpoint extends Breakpoint {
  readonly functionName: string;
  constructor(functionName: string, enabled?: boolean, condition?: string, hitCondition?: string, logMessage?: string, id?: string) {
    super(enabled, condition, hitCondition, logMessage, id);
    this.functionName = functionName;
  }
}

/** How a debug adapter is started (spawn a process, connect, or run in-process). */
export class DebugAdapterExecutable {
  readonly command: string;
  readonly args: string[];
  readonly options?: { cwd?: string; env?: Record<string, string | undefined> };
  constructor(command: string, args: string[] = [], options?: { cwd?: string; env?: Record<string, string | undefined> }) {
    this.command = command;
    this.args = args;
    this.options = options;
  }
}

export class DebugAdapterServer {
  readonly port: number;
  readonly host?: string;
  constructor(port: number, host?: string) {
    this.port = port;
    this.host = host;
  }
}

export class DebugAdapterNamedPipeServer {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
}

/**
 * A debug adapter implemented in-process: an object with `handleMessage(message)`
 * and an `onDidSendMessage` event. Wraps the extension's implementation so the
 * host can tell an inline adapter apart from the other descriptors.
 */
export class DebugAdapterInlineImplementation {
  readonly implementation: unknown;
  constructor(implementation: unknown) {
    this.implementation = implementation;
  }
}

export class DebugThread {
  readonly id: number;
  readonly name: string;
  readonly session: unknown;
  constructor(id: number, name?: string, session?: unknown) {
    this.id = id;
    this.name = name ?? `Thread ${id}`;
    this.session = session;
  }
}

export class DebugStackFrame {
  readonly id: number;
  readonly name: string;
  readonly threadId: number;
  readonly source?: { name?: string; path?: string; sourceReference?: number };
  readonly line: number;
  readonly column: number;
  readonly session: unknown;
  constructor(threadId: number, id: number, name: string, source?: { name?: string; path?: string; sourceReference?: number }, line = 0, column = 0, session?: unknown) {
    this.threadId = threadId;
    this.id = id;
    this.name = name;
    this.source = source;
    this.line = line;
    this.column = column;
    this.session = session;
  }
}

/** A live debug session, as `vscode.debug.activeDebugSession` and the events hand it out. */
export type DebugSession = {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly configuration: Record<string, unknown>;
  readonly workspaceFolder?: WorkspaceFolder;
  readonly parentSession?: DebugSession;
  customRequest(command: string, args?: unknown): PromiseLike<unknown>;
  getDebugProtocolBreakpoint(breakpoint: Breakpoint): unknown;
};

export type DebugProtocolMessage = { seq: number; type: string; [key: string]: unknown };
