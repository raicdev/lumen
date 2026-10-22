import * as Compat from "../../compat-types.ts";
import * as T from "../../types.ts";

/** Classes and enums of the "languages-extra" area: they replace the stand-ins of compat-types.ts. */

export class CallHierarchyItem extends Compat.CallHierarchyItem {
  tags?: number[];
  constructor(kind: number, name: string, detail: string, uri: T.Uri, range: T.Range, selectionRange: T.Range) {
    super(kind, name, detail, uri, range, selectionRange);
  }
}

export class TypeHierarchyItem extends Compat.TypeHierarchyItem {
  tags?: number[];
  constructor(kind: number, name: string, detail: string, uri: T.Uri, range: T.Range, selectionRange: T.Range) {
    super(kind, name, detail, uri, range, selectionRange);
  }
}

/** Hierarchical kind of a drop / paste edit (`text.updateImports`): `contains` and `intersects` follow the dotted hierarchy. */
export class DocumentDropOrPasteEditKind {
  static readonly Empty: DocumentDropOrPasteEditKind = new DocumentDropOrPasteEditKind("");
  static readonly Text: DocumentDropOrPasteEditKind = DocumentDropOrPasteEditKind.Empty.append("text");
  static readonly TextUpdateImports: DocumentDropOrPasteEditKind = DocumentDropOrPasteEditKind.Text.append("updateImports");

  readonly value: string;

  constructor(value: string) {
    this.value = String(value ?? "");
  }

  append(...parts: string[]): DocumentDropOrPasteEditKind {
    return new DocumentDropOrPasteEditKind((this.value ? [this.value, ...parts] : parts).join("."));
  }

  intersects(other: DocumentDropOrPasteEditKind): boolean {
    return this.contains(other) || other.contains(this);
  }

  contains(other: DocumentDropOrPasteEditKind): boolean {
    return this.value === other.value || other.value.startsWith(this.value + ".");
  }
}

export const DocumentPasteTriggerKind = Object.freeze({ Automatic: 0, PasteAs: 1, 0: "Automatic", 1: "PasteAs" });

export const SyntaxTokenType = Object.freeze({ Other: 0, Comment: 1, String: 2, RegEx: 3, 0: "Other", 1: "Comment", 2: "String", 3: "RegEx" });

/** A snippet edit with real Range / SnippetString values (`insert` used to build a fake range). */
export class SnippetTextEdit extends Compat.SnippetTextEdit {
  keepWhitespace?: boolean;
  constructor(range: T.Range, snippet: T.SnippetString) {
    super(range, snippet);
  }
  static replace(range: T.Range, snippet: T.SnippetString): SnippetTextEdit {
    return new SnippetTextEdit(T.toRange(range), snippet);
  }
  static insert(position: T.Position, snippet: T.SnippetString): SnippetTextEdit {
    return new SnippetTextEdit(new T.Range(position, position), snippet);
  }
  static isSnippetTextEdit(thing: unknown): thing is SnippetTextEdit {
    return thing instanceof Compat.SnippetTextEdit || (!!thing && typeof thing === "object" && "range" in thing && "snippet" in thing);
  }
}

export type DataTransferFile = { readonly name: string; readonly uri?: T.Uri; data(): PromiseLike<Uint8Array> };

export class DataTransferItem {
  readonly value: unknown;
  readonly #file: DataTransferFile | undefined;
  constructor(value: unknown, file?: DataTransferFile) {
    this.value = value;
    this.#file = file;
  }
  /** Compat items (tree view drag and drop) are items too. */
  static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Compat.DataTransferItem || Function.prototype[Symbol.hasInstance].call(DataTransferItem, value);
  }
  async asString(): Promise<string> {
    if (this.#file) return "";
    return typeof this.value === "string" ? this.value : JSON.stringify(this.value);
  }
  asFile(): DataTransferFile | undefined {
    return this.#file;
  }
}

type Item = Pick<DataTransferItem, "value" | "asString" | "asFile"> | Compat.DataTransferItem;

export class DataTransfer {
  readonly #items = new Map<string, Item>();
  /** Compat DataTransfers (tree view drag and drop) are DataTransfers too. */
  static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Compat.DataTransfer || Function.prototype[Symbol.hasInstance].call(DataTransfer, value);
  }
  get(mimeType: string): Item | undefined {
    return this.#items.get(mimeType.toLowerCase());
  }
  set(mimeType: string, value: Item): void {
    this.#items.set(mimeType.toLowerCase(), value);
  }
  forEach(callback: (item: Item, mimeType: string, transfer: DataTransfer) => void, thisArg?: unknown): void {
    for (const [mime, item] of this.#items) callback.call(thisArg, item, mime, this);
  }
  *[Symbol.iterator](): IterableIterator<[mimeType: string, item: Item]> {
    yield* this.#items;
  }
}

export class DocumentDropEdit extends Compat.DocumentDropEdit {
  title?: string;
  kind?: DocumentDropOrPasteEditKind;
  yieldTo?: readonly DocumentDropOrPasteEditKind[];
  additionalEdit?: T.WorkspaceEdit;
  constructor(insertText: string | T.SnippetString, title?: string, kind?: DocumentDropOrPasteEditKind) {
    super(insertText as string);
    this.title = title;
    this.kind = kind;
  }
}

export class DocumentPasteEdit extends Compat.DocumentPasteEdit {
  yieldTo?: readonly DocumentDropOrPasteEditKind[];
  additionalEdit?: T.WorkspaceEdit;
  constructor(insertText: string | T.SnippetString, title: string, kind: DocumentDropOrPasteEditKind) {
    super(insertText as string, title, kind);
  }
}
