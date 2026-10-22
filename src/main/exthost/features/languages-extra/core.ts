import { readFile } from "node:fs/promises";
import { matchesSelector } from "../../../../shared/glob.ts";
import type { HostDocumentFilter } from "../../../../shared/extensions.ts";
import type {
  HierarchyDirection,
  HierarchyKind,
  LanguagesExtraAvailability,
  WireDocumentEdit,
  WireEvaluatable,
  WireHierarchyItem,
  WireHierarchyNode,
  WireInlineValue,
  WireTransferItem,
} from "../../../../shared/languages-extra.ts";
import type { TextRange } from "../../../../shared/types.ts";
import * as Compat from "../../compat-types.ts";
import type { ExtHostDocument } from "../../documents.ts";
import { keyOfUri, normalizeKey, uriOfKey } from "../../documents.ts";
import type { ExtensionHost } from "../../host.ts";
import * as T from "../../types.ts";
import { wireRange } from "../../wire.ts";
import { applyWorkspaceEdit, wireWorkspaceEdit } from "../../workspace-edit.ts";
import { DataTransfer, DataTransferItem, DocumentDropOrPasteEditKind } from "./classes.ts";

/**
 * The registries and operations behind the "languages-extra" area: call and
 * type hierarchies, inline values, evaluatable expressions and the document
 * drop / paste edit providers. One instance per extension host; the window
 * asks it through `onViewRequest` (see ../languages-extra.ts).
 */

export type ProviderKind = "callHierarchy" | "typeHierarchy" | "inlineValues" | "evaluatable" | "drop" | "paste";

type Provider = Record<string, ((...args: unknown[]) => unknown) | undefined>;

type Entry = {
  id: number;
  kind: ProviderKind;
  extensionId: string;
  selector: HostDocumentFilter[];
  provider: Provider;
  metadata?: { dropMimeTypes?: string[]; pasteMimeTypes?: string[]; copyMimeTypes?: string[] };
};

type HierarchyItem = Compat.CallHierarchyItem;
type KindLike = { value: string; intersects(other: unknown): boolean };
type Session = { sessionId: string; frameId: number };
type FoundEdit = { edit: any; entry: Entry };

const MAX_HANDLES = 5000;
const MAX_VALUES = 120;
const MAX_COPIES = 20;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const token = () => new T.CancellationTokenSource().token;
const asList = <V>(value: V | V[] | null | undefined): V[] => (value === null || value === undefined ? [] : Array.isArray(value) ? value : [value]);

export function mimeMatches(pattern: string, mime: string, isFile: boolean): boolean {
  const p = pattern.toLowerCase();
  if (p === "files") return isFile;
  if (p === "*" || p === "*/*") return true;
  if (p.endsWith("/*")) return mime.startsWith(p.slice(0, -1));
  return mime === p;
}

/** A provider with no mime type filter takes every transfer. */
export function acceptsTransfer(patterns: string[] | undefined, transfer: DataTransfer): boolean {
  if (!patterns?.length) return true;
  for (const [mime, item] of transfer) {
    const isFile = !!item.asFile();
    if (patterns.some((pattern) => mimeMatches(pattern, mime, isFile))) return true;
  }
  return false;
}

export class LanguagesExtra {
  readonly #host: ExtensionHost;
  readonly #entries = new Map<number, Entry>();
  #seq = 0;
  #changePosted = false;

  /** Hierarchy items, drop / paste edits and copied data the window can refer to. */
  #handleSeq = 0;
  readonly #items = new Map<number, { item: HierarchyItem; entry: Entry }>();
  readonly #owners = new WeakMap<object, Entry>();
  readonly #edits = new Map<number, { edit: any; entry: Entry; document: ExtHostDocument; rest: T.WorkspaceEdit | null }>();
  readonly #copies = new Map<number, DataTransfer>();

  constructor(host: ExtensionHost) {
    this.#host = host;
  }

  /* ── registry ───────────────────────────────────────────────────────── */

  register(kind: ProviderKind, selector: unknown, provider: object, extensionId: string, metadata?: unknown): T.Disposable {
    const id = ++this.#seq;
    const entry: Entry = {
      id,
      kind,
      extensionId,
      selector: this.#host.normalizeSelector(selector),
      provider: provider as Provider,
      metadata: metadata && typeof metadata === "object" ? (metadata as Entry["metadata"]) : undefined,
    };
    this.#entries.set(id, entry);
    // Inline values providers ask to be asked again.
    const onChange = entry.provider.onDidChangeInlineValues as ((listener: () => void) => { dispose(): unknown }) | undefined;
    const subscription =
      kind === "inlineValues" && typeof onChange === "function"
        ? onChange(() => this.#host.postFeature("languages-extra", { type: "inlineValuesChanged" }))
        : undefined;
    this.#changed();
    return new T.Disposable(() => {
      subscription?.dispose();
      this.#entries.delete(id);
      this.#changed();
    });
  }

  #changed(): void {
    if (this.#changePosted) return;
    this.#changePosted = true;
    queueMicrotask(() => {
      this.#changePosted = false;
      this.#host.postFeature("languages-extra", { type: "changed" });
    });
  }

  #matching(kind: ProviderKind, path: string, languageId: string): Entry[] {
    return [...this.#entries.values()].filter((entry) => entry.kind === kind && matchesSelector(entry.selector, path, languageId));
  }

  availability(path: string, languageId: string): LanguagesExtraAvailability {
    const has = (kind: ProviderKind) => this.#matching(kind, path, languageId);
    const mimes = (entries: Entry[], key: "dropMimeTypes" | "pasteMimeTypes") => {
      if (!entries.length) return null;
      // One provider without a filter takes everything.
      if (entries.some((entry) => !entry.metadata?.[key]?.length)) return [];
      return [...new Set(entries.flatMap((entry) => entry.metadata![key]!))];
    };
    const paste = has("paste");
    return {
      callHierarchy: has("callHierarchy").length > 0,
      typeHierarchy: has("typeHierarchy").length > 0,
      inlineValues: has("inlineValues").length > 0,
      evaluatable: has("evaluatable").length > 0,
      drop: mimes(has("drop"), "dropMimeTypes"),
      paste: mimes(paste, "pasteMimeTypes"),
      copy: paste.some((entry) => typeof entry.provider.prepareDocumentPaste === "function"),
    };
  }

  async #documentOf(path: string): Promise<ExtHostDocument | undefined> {
    const known = this.#host.document(path);
    if (known) return known;
    try {
      return await this.#host.openDocument(uriOfKey(path));
    } catch {
      return undefined;
    }
  }

  #log(message: string, entry: Entry): void {
    this.#host.log("error", message, entry.extensionId);
  }

  #trim(map: Map<number, unknown>, max: number): void {
    if (map.size > max) map.delete(map.keys().next().value!);
  }

  /* ── call / type hierarchy ──────────────────────────────────────────── */

  #remember(item: HierarchyItem, entry: Entry): WireHierarchyItem {
    this.#owners.set(item, entry);
    const handle = ++this.#handleSeq;
    this.#items.set(handle, { item, entry });
    this.#trim(this.#items, MAX_HANDLES);
    const tags = (item as { tags?: readonly number[] }).tags;
    return {
      handle,
      name: String(item.name),
      detail: item.detail ? String(item.detail) : undefined,
      kind: item.kind,
      tags: tags?.length ? [...tags] : undefined,
      path: keyOfUri(T.Uri.revive(item.uri)!),
      range: wireRange(item.range),
      selectionRange: wireRange(item.selectionRange ?? item.range),
    };
  }

  /** `prepareCallHierarchy` / `prepareTypeHierarchy` of the matching providers: the items with their provider. */
  async prepareItems(kind: HierarchyKind, document: ExtHostDocument, position: T.Position): Promise<{ item: HierarchyItem; entry: Entry }[]> {
    const method = kind === "call" ? "prepareCallHierarchy" : "prepareTypeHierarchy";
    const entries = this.#matching(kind === "call" ? "callHierarchy" : "typeHierarchy", document.key, document.languageId);
    const lists = await Promise.all(
      entries.map(async (entry) => {
        try {
          const found = asList((await entry.provider[method]?.(document.toApi(), position, token())) as HierarchyItem | HierarchyItem[] | undefined);
          return found.filter((item) => item && item.uri && item.range).map((item) => ({ item, entry }));
        } catch (error) {
          this.#log(`${method} failed: ${errorMessage(error)}`, entry);
          return [];
        }
      }),
    );
    for (const { item, entry } of lists.flat()) this.#owners.set(item, entry);
    return lists.flat();
  }

  async prepare(kind: HierarchyKind, path: string, line: number, character: number): Promise<WireHierarchyItem[]> {
    const document = await this.#documentOf(path);
    if (!document) return [];
    return (await this.prepareItems(kind, document, new T.Position(line, character))).map(({ item, entry }) => this.#remember(item, entry));
  }

  /** The provider an item came from; items an extension built itself are matched by document. */
  async #ownerOf(item: HierarchyItem, kind: HierarchyKind): Promise<Entry | undefined> {
    const known = this.#owners.get(item);
    if (known) return known;
    const uri = T.Uri.revive(item.uri);
    if (!uri) return undefined;
    const document = await this.#documentOf(keyOfUri(uri));
    const providerKind = kind === "call" ? "callHierarchy" : "typeHierarchy";
    if (document) return this.#matching(providerKind, document.key, document.languageId)[0];
    return [...this.#entries.values()].find((entry) => entry.kind === providerKind);
  }

  /** Incoming / outgoing calls, supertypes or subtypes of an item, as the API objects. */
  async childrenOf(direction: HierarchyDirection, item: HierarchyItem): Promise<{ item: HierarchyItem; fromRanges: T.Range[]; entry: Entry }[]> {
    const kind: HierarchyKind = direction === "incoming" || direction === "outgoing" ? "call" : "type";
    const entry = await this.#ownerOf(item, kind);
    if (!entry) return [];
    const method = {
      incoming: "provideCallHierarchyIncomingCalls",
      outgoing: "provideCallHierarchyOutgoingCalls",
      supertypes: "provideTypeHierarchySupertypes",
      subtypes: "provideTypeHierarchySubtypes",
    }[direction];
    try {
      const result = asList((await entry.provider[method]?.(item, token())) as unknown[] | undefined) as Record<string, unknown>[];
      const out: { item: HierarchyItem; fromRanges: T.Range[]; entry: Entry }[] = [];
      for (const value of result) {
        const target = (direction === "incoming" ? value?.from : direction === "outgoing" ? value?.to : value) as HierarchyItem | undefined;
        if (!target?.uri || !target.range) continue;
        this.#owners.set(target, entry);
        const ranges = kind === "call" ? asList(value.fromRanges as T.Range[] | undefined).map((range) => T.toRange(range)) : [];
        out.push({ item: target, fromRanges: ranges, entry });
      }
      return out;
    } catch (error) {
      this.#log(`${method} failed: ${errorMessage(error)}`, entry);
      return [];
    }
  }

  async children(direction: HierarchyDirection, handle: number): Promise<WireHierarchyNode[]> {
    const known = this.#items.get(handle);
    if (!known) throw new Error("the hierarchy item is no longer available");
    return (await this.childrenOf(direction, known.item)).map(({ item, fromRanges, entry }) => ({
      item: this.#remember(item, entry),
      fromRanges: fromRanges.map(wireRange),
    }));
  }

  /* ── debugging: inline values and evaluatable expressions ───────────── */

  async inlineValues(
    path: string,
    viewport: { startLine: number; endLine: number },
    session: Session,
    stopped: { line: number; character: number },
  ): Promise<WireInlineValue[]> {
    const document = this.#host.document(path);
    if (!document) return [];
    const entries = this.#matching("inlineValues", document.key, document.languageId);
    if (!entries.length) return [];
    const lastLine = Math.max(0, document.lineCount - 1);
    const view = new T.Range(Math.min(viewport.startLine, lastLine), 0, Math.min(viewport.endLine, lastLine), Number.MAX_SAFE_INTEGER);
    const context = { frameId: session.frameId, stoppedLocation: new T.Range(stopped.line, stopped.character, stopped.line, stopped.character) };
    const found: unknown[] = [];
    await Promise.all(
      entries.map(async (entry) => {
        try {
          found.push(...asList((await entry.provider.provideInlineValues?.(document.toApi(), view, context, token())) as unknown[] | undefined));
        } catch (error) {
          this.#log(`provideInlineValues failed: ${errorMessage(error)}`, entry);
        }
      }),
    );
    const lookup = this.#frameVariables(session);
    const out: WireInlineValue[] = [];
    const seen = new Set<string>();
    const push = (range: T.Range, text: string) => {
      const key = `${range.start.line}:${range.start.character}:${text}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ line: range.end.line, character: range.end.character, text });
    };
    await Promise.all(
      found.slice(0, MAX_VALUES).map(async (value) => {
        const entry = value as { range?: T.Range; text?: unknown; variableName?: string; caseSensitiveLookup?: boolean; expression?: string };
        if (!entry?.range) return;
        const range = T.toRange(entry.range);
        if (typeof entry.text === "string") return push(range, entry.text);
        if (value instanceof Compat.InlineValueVariableLookup || "caseSensitiveLookup" in entry) {
          const name = entry.variableName ?? document.getText(range);
          const result = await lookup(name, entry.caseSensitiveLookup !== false);
          if (result !== undefined) push(range, `${name} = ${result}`);
          return;
        }
        const expression = entry.expression ?? document.getText(range);
        const result = await this.#evaluate(session, expression, "watch");
        if (result) push(range, `${expression} = ${result.result}`);
      }),
    );
    return out.sort((a, b) => a.line - b.line || a.character - b.character);
  }

  /** Looks up a variable of the frame (locals first) by name; the scopes are read once, on first use. */
  #frameVariables(session: Session): (name: string, caseSensitive: boolean) => Promise<string | undefined> {
    let loaded: Promise<{ name: string; value: string }[]> | undefined;
    const load = () =>
      (loaded ??= (async () => {
        try {
          const scopes = (await this.#host.debug.scopes(session.sessionId, session.frameId)).filter((scope) => !scope.expensive).slice(0, 3);
          const lists = await Promise.all(scopes.map((scope) => this.#host.debug.variables(session.sessionId, scope.variablesReference).catch(() => [])));
          return lists.flat().map((variable) => ({ name: variable.name, value: variable.value }));
        } catch {
          return [];
        }
      })());
    return async (name, caseSensitive) => {
      const all = await load();
      const wanted = caseSensitive ? name : name.toLowerCase();
      return all.find((variable) => (caseSensitive ? variable.name : variable.name.toLowerCase()) === wanted)?.value;
    };
  }

  async #evaluate(session: Session, expression: string, context: "watch" | "hover") {
    try {
      return await this.#host.debug.evaluate(session.sessionId, expression, session.frameId, context);
    } catch {
      return null;
    }
  }

  /** The hover while debugging: the provider's expression (else the word under the pointer), evaluated in the frame. */
  async evaluatable(path: string, line: number, character: number, session: Session): Promise<WireEvaluatable | null> {
    const document = this.#host.document(path);
    if (!document) return null;
    const position = new T.Position(line, character);
    const entries = this.#matching("evaluatable", document.key, document.languageId);
    let range: T.Range | undefined;
    let expression: string | undefined;
    for (const entry of entries) {
      try {
        const found = (await entry.provider.provideEvaluatableExpression?.(document.toApi(), position, token())) as
          | { range?: T.Range; expression?: string }
          | undefined;
        if (!found?.range) continue;
        range = T.toRange(found.range);
        expression = found.expression ?? document.getText(range);
        break;
      } catch (error) {
        this.#log(`provideEvaluatableExpression failed: ${errorMessage(error)}`, entry);
      }
    }
    // Without a provider the word under the pointer is evaluated, like VS Code does.
    if (!range && !entries.length) {
      const text = (document.toApi() as { lineAt(line: number): { text: string } }).lineAt(line).text;
      for (const match of text.matchAll(/[\p{L}\p{N}_$]+/gu)) {
        if (match.index! <= character && character <= match.index! + match[0].length) {
          range = new T.Range(line, match.index!, line, match.index! + match[0].length);
          expression = match[0];
          break;
        }
      }
    }
    if (!range || !expression?.trim()) return null;
    const result = await this.#evaluate(session, expression, "hover");
    return result ? { range: wireRange(range), expression, result: result.result, type: result.type } : null;
  }

  /* ── drop and paste edits ───────────────────────────────────────────── */

  buildTransfer(items: WireTransferItem[]): DataTransfer {
    const transfer = new DataTransfer();
    for (const entry of items) {
      if (entry.file) {
        const { name, path, base64 } = entry.file;
        const bytes = base64 ? new Uint8Array(Buffer.from(base64, "base64")) : undefined;
        const uri = path ? T.Uri.file(path) : undefined;
        const file = { name, uri, data: async () => bytes ?? new Uint8Array(await readFile(path!)) };
        transfer.set(entry.mime, new DataTransferItem(undefined, file));
        // A dropped OS file with a known path is also a URI list (VS Code sets both), unless the window sent one.
        if (uri && !transfer.get("text/uri-list")) transfer.set("text/uri-list", new DataTransferItem(uri.toString()));
      } else transfer.set(entry.mime, new DataTransferItem(entry.value ?? ""));
    }
    return transfer;
  }

  #wireEdit(edit: any, entry: Entry, document: ExtHostDocument, resolvable: boolean): WireDocumentEdit {
    const additional = edit.additionalEdit as T.WorkspaceEdit | undefined;
    let own: WireDocumentEdit["additional"] = [];
    let rest: T.WorkspaceEdit | null = null;
    if (additional?._entries?.length) {
      const sameDocument = new T.WorkspaceEdit();
      rest = new T.WorkspaceEdit();
      for (const piece of additional._entries) {
        const isOwn = (piece.kind === "text" || piece.kind === "snippet") && normalizeKey(keyOfUri(T.Uri.revive(piece.uri)!)) === normalizeKey(document.key);
        (isOwn ? sameDocument : rest)._entries.push(piece);
      }
      own = wireWorkspaceEdit(sameDocument).find((file) => normalizeKey(file.path) === normalizeKey(document.key))?.edits ?? [];
      if (!rest._entries.length) rest = null;
    }
    const handle = ++this.#handleSeq;
    this.#edits.set(handle, { edit, entry, document, rest });
    this.#trim(this.#edits, MAX_HANDLES);
    const snippet = T.SnippetString.isSnippetString(edit.insertText);
    return {
      handle,
      title: String(edit.title ?? entry.extensionId),
      kind: edit.kind?.value || undefined,
      insertText: snippet ? edit.insertText.value : String(edit.insertText ?? ""),
      snippet,
      additional: own,
      needsResolve: resolvable && typeof entry.provider.resolveDocumentPasteEdit === "function" ? true : undefined,
    };
  }

  /** An edit that yields to the kind of another edit comes after it. */
  #order(found: FoundEdit[]): FoundEdit[] {
    const yields = ({ edit }: FoundEdit) =>
      !!edit.yieldTo?.length &&
      found.some((other) => other.edit !== edit && other.edit.kind && (edit.yieldTo as KindLike[]).some((kind) => kind.intersects(other.edit.kind)));
    return [...found.filter((item) => !yields(item)), ...found.filter(yields)];
  }

  async dropEdits(path: string, line: number, character: number, items: WireTransferItem[]): Promise<WireDocumentEdit[]> {
    const document = this.#host.document(path);
    if (!document) return [];
    const transfer = this.buildTransfer(items);
    const found: FoundEdit[] = [];
    await Promise.all(
      this.#matching("drop", document.key, document.languageId).map(async (entry) => {
        if (!acceptsTransfer(entry.metadata?.dropMimeTypes, transfer)) return;
        try {
          for (const edit of asList(
            (await entry.provider.provideDocumentDropEdits?.(document.toApi(), new T.Position(line, character), transfer, token())) as any[] | undefined,
          )) {
            if (edit && edit.insertText !== undefined) found.push({ edit, entry });
          }
        } catch (error) {
          this.#log(`provideDocumentDropEdits failed: ${errorMessage(error)}`, entry);
        }
      }),
    );
    return this.#order(found).map(({ edit, entry }) => this.#wireEdit(edit, entry, document, false));
  }

  /** Copy: providers that want to remember something about the selection fill a DataTransfer that comes back at paste time. */
  async preparePaste(path: string, ranges: TextRange[]): Promise<number | null> {
    const document = this.#host.document(path);
    if (!document) return null;
    const transfer = new DataTransfer();
    const selection = ranges.map((range) => new T.Range(range.startLine, range.startCharacter, range.endLine, range.endCharacter));
    for (const entry of this.#matching("paste", document.key, document.languageId)) {
      if (typeof entry.provider.prepareDocumentPaste !== "function") continue;
      try {
        await entry.provider.prepareDocumentPaste(document.toApi(), selection, transfer, token());
      } catch (error) {
        this.#log(`prepareDocumentPaste failed: ${errorMessage(error)}`, entry);
      }
    }
    if (![...transfer].length) return null;
    const id = ++this.#handleSeq;
    this.#copies.set(id, transfer);
    this.#trim(this.#copies, MAX_COPIES);
    return id;
  }

  async pasteEdits(
    path: string,
    ranges: TextRange[],
    items: WireTransferItem[],
    options: { copyId?: number | null; triggerKind?: number; only?: string } = {},
  ): Promise<WireDocumentEdit[]> {
    const document = this.#host.document(path);
    if (!document) return [];
    const transfer = this.buildTransfer(items);
    const copied = options.copyId ? this.#copies.get(options.copyId) : undefined;
    if (copied) for (const [mime, item] of copied) transfer.set(mime, item);
    const selection = ranges.map((range) => new T.Range(range.startLine, range.startCharacter, range.endLine, range.endCharacter));
    const only = options.only ? new DocumentDropOrPasteEditKind(options.only) : undefined;
    const context = { only, triggerKind: options.triggerKind ?? 0 };
    const found: FoundEdit[] = [];
    await Promise.all(
      this.#matching("paste", document.key, document.languageId).map(async (entry) => {
        if (!acceptsTransfer(entry.metadata?.pasteMimeTypes, transfer)) return;
        try {
          for (const edit of asList(
            (await entry.provider.provideDocumentPasteEdits?.(document.toApi(), selection, transfer, context, token())) as any[] | undefined,
          )) {
            if (!edit || edit.insertText === undefined) continue;
            if (only && edit.kind && !only.intersects(edit.kind)) continue;
            found.push({ edit, entry });
          }
        } catch (error) {
          this.#log(`provideDocumentPasteEdits failed: ${errorMessage(error)}`, entry);
        }
      }),
    );
    return this.#order(found).map(({ edit, entry }) => this.#wireEdit(edit, entry, document, true));
  }

  /** resolveDocumentPasteEdit of the provider, for the edit about to be applied. */
  async resolveEdit(handle: number): Promise<WireDocumentEdit | null> {
    const known = this.#edits.get(handle);
    if (!known) return null;
    const { edit, entry, document } = known;
    try {
      const resolved = (await entry.provider.resolveDocumentPasteEdit?.(edit, token())) as typeof edit | undefined;
      return this.#wireEdit(resolved ?? edit, entry, document, false);
    } catch (error) {
      this.#log(`resolveDocumentPasteEdit failed: ${errorMessage(error)}`, entry);
      return null;
    }
  }

  /** Called once the window applied an edit: runs the parts of its additionalEdit that are not text edits of the document itself. */
  async commitEdit(handle: number): Promise<boolean> {
    const known = this.#edits.get(handle);
    if (!known) return false;
    this.#edits.delete(handle);
    return known.rest ? applyWorkspaceEdit(this.#host, known.rest, known.entry.extensionId) : true;
  }
}

const instances = new WeakMap<ExtensionHost, LanguagesExtra>();

export function languagesExtraOf(host: ExtensionHost): LanguagesExtra {
  let instance = instances.get(host);
  if (!instance) {
    instance = new LanguagesExtra(host);
    instances.set(host, instance);
  }
  return instance;
}
