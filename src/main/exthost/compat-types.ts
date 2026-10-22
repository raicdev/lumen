import type { Position, Range, Uri } from "./types.ts";

/**
 * Data-only base classes and enums for VS Code features (tabs, hierarchy items,
 * data transfer, …). The feature areas in ./features extend or replace most of
 * them with real implementations; the rest carry data only. They exist because libraries
 * such as vscode-languageclient reference them while loading or use them in
 * `instanceof` checks, which would otherwise throw.
 */

function frozenEnum<T extends Record<string, number>>(values: T): Readonly<T> & Readonly<Record<number, string>> {
  const result: Record<string | number, string | number> = { ...values };
  for (const [key, value] of Object.entries(values)) result[value] = key;
  return Object.freeze(result) as Readonly<T> & Readonly<Record<number, string>>;
}

/* notebooks */

export const NotebookCellKind = frozenEnum({ Markup: 1, Code: 2 });
export const NotebookControllerAffinity = frozenEnum({ Default: 1, Preferred: 2 });

export class NotebookRange {
  readonly start: number;
  readonly end: number;
  constructor(start: number, end: number) {
    this.start = Math.min(start, end);
    this.end = Math.max(start, end);
  }
  get isEmpty() {
    return this.start === this.end;
  }
  with(change: { start?: number; end?: number }) {
    return new NotebookRange(change.start ?? this.start, change.end ?? this.end);
  }
}

export class NotebookCellData {
  kind: number;
  value: string;
  languageId: string;
  outputs?: unknown[];
  metadata?: Record<string, unknown>;
  constructor(kind: number, value: string, languageId: string) {
    this.kind = kind;
    this.value = value;
    this.languageId = languageId;
  }
}

export class NotebookData {
  cells: NotebookCellData[];
  metadata?: Record<string, unknown>;
  constructor(cells: NotebookCellData[]) {
    this.cells = cells;
  }
}

export class NotebookCellOutputItem {
  data: Uint8Array;
  mime: string;
  constructor(data: Uint8Array, mime: string) {
    this.data = data;
    this.mime = mime;
  }
  static text(value: string, mime = "text/plain") {
    return new NotebookCellOutputItem(new TextEncoder().encode(value), mime);
  }
  static json(value: unknown, mime = "application/json") {
    return NotebookCellOutputItem.text(JSON.stringify(value), mime);
  }
  static error(value: Error) {
    return NotebookCellOutputItem.json({ name: value.name, message: value.message, stack: value.stack }, "application/vnd.code.notebook.error");
  }
}

export class NotebookCellOutput {
  items: NotebookCellOutputItem[];
  metadata?: Record<string, unknown>;
  constructor(items: NotebookCellOutputItem[], metadata?: Record<string, unknown>) {
    this.items = items;
    this.metadata = metadata;
  }
}

export class NotebookEdit {
  range: NotebookRange;
  newCells: NotebookCellData[];
  constructor(range: NotebookRange, newCells: NotebookCellData[]) {
    this.range = range;
    this.newCells = newCells;
  }
  static replaceCells(range: NotebookRange, newCells: NotebookCellData[]) {
    return new NotebookEdit(range, newCells);
  }
  static insertCells(index: number, newCells: NotebookCellData[]) {
    return new NotebookEdit(new NotebookRange(index, index), newCells);
  }
  static deleteCells(range: NotebookRange) {
    return new NotebookEdit(range, []);
  }
}

/* tabs */

export class TabInputText {
  readonly uri: Uri;
  constructor(uri: Uri) {
    this.uri = uri;
  }
}
export class TabInputTextDiff {
  readonly original: Uri;
  readonly modified: Uri;
  constructor(original: Uri, modified: Uri) {
    this.original = original;
    this.modified = modified;
  }
}
export class TabInputCustom {
  readonly uri: Uri;
  readonly viewType: string;
  constructor(uri: Uri, viewType: string) {
    this.uri = uri;
    this.viewType = viewType;
  }
}
export class TabInputWebview {
  readonly viewType: string;
  constructor(viewType: string) {
    this.viewType = viewType;
  }
}
export class TabInputNotebook {
  readonly uri: Uri;
  readonly notebookType: string;
  constructor(uri: Uri, notebookType: string) {
    this.uri = uri;
    this.notebookType = notebookType;
  }
}
export class TabInputTerminal {}

/* language features Lumen does not call */

class HierarchyItem {
  kind: number;
  name: string;
  detail: string;
  uri: Uri;
  range: Range;
  selectionRange: Range;
  constructor(kind: number, name: string, detail: string, uri: Uri, range: Range, selectionRange: Range) {
    this.kind = kind;
    this.name = name;
    this.detail = detail;
    this.uri = uri;
    this.range = range;
    this.selectionRange = selectionRange;
  }
}
export class CallHierarchyItem extends HierarchyItem {}
export class TypeHierarchyItem extends HierarchyItem {}

export class CallHierarchyIncomingCall {
  from: CallHierarchyItem;
  fromRanges: Range[];
  constructor(from: CallHierarchyItem, fromRanges: Range[]) {
    this.from = from;
    this.fromRanges = fromRanges;
  }
}

export class CallHierarchyOutgoingCall {
  to: CallHierarchyItem;
  fromRanges: Range[];
  constructor(to: CallHierarchyItem, fromRanges: Range[]) {
    this.to = to;
    this.fromRanges = fromRanges;
  }
}

export class LinkedEditingRanges {
  readonly ranges: Range[];
  readonly wordPattern?: RegExp;
  constructor(ranges: Range[], wordPattern?: RegExp) {
    this.ranges = ranges;
    this.wordPattern = wordPattern;
  }
}

export class InlineValueText {
  readonly range: Range;
  readonly text: string;
  constructor(range: Range, text: string) {
    this.range = range;
    this.text = text;
  }
}

export class InlineValueVariableLookup {
  readonly range: Range;
  readonly variableName?: string;
  readonly caseSensitiveLookup: boolean;
  constructor(range: Range, variableName?: string, caseSensitiveLookup = true) {
    this.range = range;
    this.variableName = variableName;
    this.caseSensitiveLookup = caseSensitiveLookup;
  }
}

export class InlineValueEvaluatableExpression {
  readonly range: Range;
  readonly expression?: string;
  constructor(range: Range, expression?: string) {
    this.range = range;
    this.expression = expression;
  }
}

export class EvaluatableExpression extends InlineValueEvaluatableExpression {}

export class SnippetTextEdit {
  range: Range;
  snippet: { value: string };
  constructor(range: Range, snippet: { value: string }) {
    this.range = range;
    this.snippet = snippet;
  }
  static replace(range: Range, snippet: { value: string }) {
    return new SnippetTextEdit(range, snippet);
  }
  static insert(position: Position, snippet: { value: string }) {
    return new SnippetTextEdit({ start: position, end: position } as Range, snippet);
  }
}

export class DataTransferItem {
  readonly value: unknown;
  constructor(value: unknown) {
    this.value = value;
  }
  async asString() {
    return typeof this.value === "string" ? this.value : JSON.stringify(this.value);
  }
  asFile() {
    return undefined;
  }
}

export class DataTransfer {
  #items = new Map<string, DataTransferItem>();
  get(mimeType: string) {
    return this.#items.get(mimeType.toLowerCase());
  }
  set(mimeType: string, value: DataTransferItem) {
    this.#items.set(mimeType.toLowerCase(), value);
  }
  forEach(callback: (item: DataTransferItem, mimeType: string, transfer: DataTransfer) => void, thisArg?: unknown) {
    for (const [mime, item] of this.#items) callback.call(thisArg, item, mime, this);
  }
  *[Symbol.iterator]() {
    yield* this.#items;
  }
}

export class DocumentDropEdit {
  insertText: string | { value: string };
  constructor(insertText: string | { value: string }) {
    this.insertText = insertText;
  }
}

export class DocumentPasteEdit {
  insertText: string | { value: string };
  title: string;
  kind: unknown;
  constructor(insertText: string | { value: string }, title: string, kind?: unknown) {
    this.insertText = insertText;
    this.title = title;
    this.kind = kind;
  }
}

/* terminals */

export class TerminalProfile {
  options: unknown;
  constructor(options: unknown) {
    this.options = options;
  }
}

export class TerminalLink {
  startIndex: number;
  length: number;
  tooltip?: string;
  constructor(startIndex: number, length: number, tooltip?: string) {
    this.startIndex = startIndex;
    this.length = length;
    this.tooltip = tooltip;
  }
}

/* tasks */

export const TaskScope = frozenEnum({ Global: 1, Workspace: 2 });
export const TaskRevealKind = frozenEnum({ Always: 1, Silent: 2, Never: 3 });
export const TaskPanelKind = frozenEnum({ Shared: 1, Dedicated: 2, New: 3 });

export class TaskGroup {
  static readonly Clean = new TaskGroup("clean", "Clean");
  static readonly Build = new TaskGroup("build", "Build");
  static readonly Rebuild = new TaskGroup("rebuild", "Rebuild");
  static readonly Test = new TaskGroup("test", "Test");
  readonly id: string;
  readonly label: string;
  isDefault?: boolean;
  constructor(id: string, label: string) {
    this.id = id;
    this.label = label;
  }
}

export class ShellExecution {
  commandLine?: string;
  command?: string | { value: string };
  args?: (string | { value: string })[];
  options?: unknown;
  constructor(commandOrLine: string | { value: string }, argsOrOptions?: unknown, options?: unknown) {
    if (Array.isArray(argsOrOptions)) {
      this.command = commandOrLine;
      this.args = argsOrOptions as string[];
      this.options = options;
    } else {
      this.commandLine = typeof commandOrLine === "string" ? commandOrLine : commandOrLine.value;
      this.options = argsOrOptions;
    }
  }
}

export class ProcessExecution {
  process: string;
  args: string[];
  options?: unknown;
  constructor(process: string, argsOrOptions?: string[] | unknown, options?: unknown) {
    this.process = process;
    this.args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    this.options = Array.isArray(argsOrOptions) ? options : argsOrOptions;
  }
}

export class CustomExecution {
  readonly callback: unknown;
  constructor(callback: unknown) {
    this.callback = callback;
  }
}

export class Task {
  definition: unknown;
  scope: unknown;
  name: string;
  source: string;
  execution?: unknown;
  problemMatchers: string[];
  group?: TaskGroup;
  detail?: string;
  isBackground = false;
  presentationOptions: Record<string, unknown> = {};
  runOptions: Record<string, unknown> = {};
  constructor(definition: unknown, scope: unknown, name: string, source: string, execution?: unknown, problemMatchers: string | string[] = []) {
    this.definition = definition;
    this.scope = scope;
    this.name = name;
    this.source = source;
    this.execution = execution;
    this.problemMatchers = [problemMatchers].flat();
  }
}

/* comments, tests, chat */

export const CommentMode = frozenEnum({ Editing: 0, Preview: 1 });
export const CommentThreadCollapsibleState = frozenEnum({ Collapsed: 0, Expanded: 1 });
export const TestRunProfileKind = frozenEnum({ Run: 1, Debug: 2, Coverage: 3 });

export class TestTag {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
}

export class TestMessage {
  message: string | { value: string };
  constructor(message: string | { value: string }) {
    this.message = message;
  }
}

export class TestRunRequest {
  readonly include?: unknown[];
  readonly exclude?: unknown[];
  readonly profile?: unknown;
  constructor(include?: unknown[], exclude?: unknown[], profile?: unknown) {
    this.include = include;
    this.exclude = exclude;
    this.profile = profile;
  }
}

export class LanguageModelChatMessage {
  role: number;
  content: unknown;
  name?: string;
  constructor(role: number, content: unknown, name?: string) {
    this.role = role;
    this.content = content;
    this.name = name;
  }
  static User(content: unknown, name?: string) {
    return new LanguageModelChatMessage(1, content, name);
  }
  static Assistant(content: unknown, name?: string) {
    return new LanguageModelChatMessage(2, content, name);
  }
}

export class ChatResponseMarkdownPart {
  value: unknown;
  constructor(value: unknown) {
    this.value = value;
  }
}

/** Everything above, by export name. */
export const compatTypes = {
  NotebookCellKind,
  NotebookControllerAffinity,
  NotebookRange,
  NotebookCellData,
  NotebookData,
  NotebookCellOutputItem,
  NotebookCellOutput,
  NotebookEdit,
  TabInputText,
  TabInputTextDiff,
  TabInputCustom,
  TabInputWebview,
  TabInputNotebook,
  TabInputTerminal,
  CallHierarchyItem,
  TypeHierarchyItem,
  CallHierarchyIncomingCall,
  CallHierarchyOutgoingCall,
  LinkedEditingRanges,
  InlineValueText,
  InlineValueVariableLookup,
  InlineValueEvaluatableExpression,
  EvaluatableExpression,
  SnippetTextEdit,
  DataTransferItem,
  DataTransfer,
  DocumentDropEdit,
  DocumentPasteEdit,
  TerminalProfile,
  TerminalLink,
  TaskScope,
  TaskRevealKind,
  TaskPanelKind,
  TaskGroup,
  ShellExecution,
  ProcessExecution,
  CustomExecution,
  Task,
  CommentMode,
  CommentThreadCollapsibleState,
  TestRunProfileKind,
  TestTag,
  TestMessage,
  TestRunRequest,
  LanguageModelChatMessage,
  ChatResponseMarkdownPart,
};
