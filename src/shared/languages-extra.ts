import type { FileEdits, TextRange } from "./types.ts";

/** Wire types between the host and the window of the "languages-extra" area (hierarchies, inline values, drop / paste edits). */

export type HierarchyKind = "call" | "type";
export type HierarchyDirection = "incoming" | "outgoing" | "supertypes" | "subtypes";

export type WireHierarchyItem = {
  /** Host-side handle: pass it back to ask for the item's calls / types. */
  handle: number;
  name: string;
  detail?: string;
  /** vscode.SymbolKind */
  kind: number;
  tags?: number[];
  path: string;
  range: TextRange;
  selectionRange: TextRange;
};

/** One entry of a hierarchy level: the item and the ranges (in the item the node came from) where it is called. */
export type WireHierarchyNode = { item: WireHierarchyItem; fromRanges: TextRange[] };

/** What the providers registered so far can do for one document. */
export type LanguagesExtraAvailability = {
  callHierarchy: boolean;
  typeHierarchy: boolean;
  inlineValues: boolean;
  evaluatable: boolean;
  /** Drop providers: the mime types they ask for (`null` = no provider; an empty list = they take everything). */
  drop: string[] | null;
  paste: string[] | null;
  /** Some paste provider wants to see the selection at copy time. */
  copy: boolean;
};

/** A line of inline values shown at the end of the line. */
export type WireInlineValue = { line: number; character: number; text: string };

export type WireTransferItem = {
  mime: string;
  /** String data. */
  value?: string;
  /** A file: its name, and (when the window could read it) its bytes as base64. */
  file?: { name: string; path?: string; base64?: string };
};

export type WireDocumentEdit = {
  /** Handle for `edit.resolve` / `edit.commit`. */
  handle: number;
  title: string;
  kind?: string;
  insertText: string;
  snippet: boolean;
  /** Text / snippet edits of the additional edit for the document itself (same coordinates as the original document). */
  additional: FileEdits["edits"];
  /** The provider has a resolveDocumentPasteEdit that must run before the edit is applied. */
  needsResolve?: boolean;
};

export type WireEvaluatable = { range: TextRange; expression: string; result: string; type?: string };
