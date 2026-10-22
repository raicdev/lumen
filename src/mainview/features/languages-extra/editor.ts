import { snippet, type Completion } from "@codemirror/autocomplete";
import { EditorSelection, StateEffect, StateField, type ChangeSet, type ChangeSpec, type Extension, type Text, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, hoverTooltip, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { TextEdit, TextRange } from "../../../shared/types";
import type { WireDocumentEdit, WireEvaluatable, WireInlineValue, WireTransferItem } from "../../../shared/languages-extra";
import { FILE_DRAG_TYPE } from "../../components/EditorDropTarget";
import { debugUi, samePath } from "../../lib/debug-ui";
import { snippetToTemplate, snippetToText } from "../../lib/snippets";
import type { ViewFeatureApi } from "../types";
import { availabilityFor, clearLastEditor, mimeAccepted, onInlineValuesChange, onProvidersChange, setLastEditor } from "./shared";

/**
 * CodeMirror integrations of the "languages-extra" area: inline values and
 * the evaluatable-expression hover while debugging, and document drop / paste
 * edit providers. Every function asks the extension host through the
 * feature's requestHost (see src/main/exthost/features/languages-extra).
 */

const HOST_TIMEOUT = 1500;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

const offsetOf = (doc: Text, line: number, character: number) => {
  const target = doc.line(Math.min(Math.max(line + 1, 1), doc.lines));
  return target.from + Math.min(character, target.length);
};

const toRange = (doc: Text, from: number, to: number): TextRange => {
  const a = doc.lineAt(from);
  const b = doc.lineAt(to);
  return { startLine: a.number - 1, startCharacter: from - a.from, endLine: b.number - 1, endCharacter: to - b.from };
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the extension host did not answer in time")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/* ── inline values and evaluatable hover ────────────────────────────────── */

const setInlineValues = StateEffect.define<{ line: number; text: string }[]>();

class InlineValueWidget extends WidgetType {
  readonly text: string;
  constructor(text: string) {
    super();
    this.text = text;
  }
  eq(other: InlineValueWidget) {
    return other.text === this.text;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-inline-value";
    span.textContent = this.text;
    return span;
  }
  ignoreEvent() {
    return true;
  }
}

const inlineValueField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(setInlineValues)) continue;
      const ranges = effect.value
        .filter((entry) => entry.line < tr.state.doc.lines)
        .map((entry) => Decoration.widget({ widget: new InlineValueWidget(entry.text), side: 1 }).range(tr.state.doc.line(entry.line + 1).to));
      return Decoration.set(ranges, true);
    }
    // The values describe the paused state: an edit makes them stale.
    return tr.docChanged ? Decoration.none : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** One text per line: `a = 1, b = 2`. */
function groupByLine(values: WireInlineValue[]): { line: number; text: string }[] {
  const lines = new Map<number, string[]>();
  for (const value of values) lines.set(value.line, [...(lines.get(value.line) ?? []), value.text]);
  return [...lines].map(([line, texts]) => ({ line, text: `  ${texts.join(", ")}` }));
}

function inlineValuesPlugin(path: string, languageId: string, api: ViewFeatureApi): Extension {
  return ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | null = null;
      generation = 0;
      shown = false;
      readonly cleanups: (() => void)[];
      readonly view: EditorView;
      constructor(view: EditorView) {
        this.view = view;
        const refresh = () => this.schedule(0);
        this.cleanups = [debugUi.subscribe(refresh), onInlineValuesChange(refresh), onProvidersChange(refresh)];
        this.schedule(0);
      }
      update(update: ViewUpdate) {
        if (update.viewportChanged || update.docChanged) this.schedule(250);
      }
      schedule(delay: number) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.run(), delay);
      }
      async run() {
        this.timer = null;
        const run = ++this.generation;
        const focused = debugUi.getSnapshot().focused;
        const enabled = !!focused && samePath(focused.path, path) && !!availabilityFor(api, path, languageId)?.inlineValues;
        if (!enabled || !focused) return this.show([]);
        const { state } = this.view;
        const first = state.doc.lineAt(this.view.viewport.from).number - 1;
        const last = state.doc.lineAt(this.view.viewport.to).number - 1;
        try {
          const values = await api.requestHost<WireInlineValue[]>("inlineValues", [
            path,
            { startLine: first, endLine: last },
            { sessionId: focused.sessionId, frameId: focused.frameId },
            { line: Math.max(0, (focused.line ?? 1) - 1), character: Math.max(0, (focused.column ?? 1) - 1) },
          ]);
          if (run === this.generation) this.show(groupByLine(values));
        } catch {
          if (run === this.generation) this.show([]);
        }
      }
      show(lines: { line: number; text: string }[]) {
        if (!lines.length && !this.shown) return;
        this.shown = lines.length > 0;
        // Dispatching from inside an update is not allowed; this runs from a timer or a promise.
        this.view.dispatch({ effects: setInlineValues.of(lines) });
      }
      destroy() {
        if (this.timer) clearTimeout(this.timer);
        this.generation++;
        for (const cleanup of this.cleanups) cleanup();
      }
    },
  );
}

/** Hover over an expression while the debugger is paused: its value in the focused frame. */
function evaluateHover(path: string, api: ViewFeatureApi): Extension {
  return hoverTooltip(
    async (view, pos) => {
      const focused = debugUi.getSnapshot().focused;
      if (!focused) return null;
      const line = view.state.doc.lineAt(pos);
      let result: WireEvaluatable | null;
      try {
        result = await api.requestHost<WireEvaluatable | null>("evaluatable", [path, line.number - 1, pos - line.from, { sessionId: focused.sessionId, frameId: focused.frameId }]);
      } catch {
        return null;
      }
      if (!result) return null;
      const from = offsetOf(view.state.doc, result.range.startLine, result.range.startCharacter);
      const to = offsetOf(view.state.doc, result.range.endLine, result.range.endCharacter);
      if (pos < from || pos > to) return null;
      const shown = result;
      return {
        pos: from,
        end: to,
        above: true,
        create() {
          const dom = document.createElement("div");
          dom.className = "cm-debug-hover";
          const expression = document.createElement("span");
          expression.className = "cm-debug-hover-expression";
          expression.textContent = shown.expression.length > 80 ? `${shown.expression.slice(0, 77)}...` : shown.expression;
          const value = document.createElement("span");
          value.className = "cm-debug-hover-value";
          value.textContent = shown.result;
          dom.append(expression, " = ", value);
          if (shown.type) {
            const type = document.createElement("span");
            type.className = "cm-debug-hover-type";
            type.textContent = ` ${shown.type}`;
            dom.append(type);
          }
          return { dom };
        },
      };
    },
    { hideOnChange: true },
  );
}

/* ── applying edits ─────────────────────────────────────────────────────── */

type Span = { from: number; to: number };

/** The edit applied to the document: where it landed, and how to take it back. */
export type AppliedDocumentEdit = {
  /** Offset right after the inserted text, where the other-edits widget goes. */
  anchor: number;
  /** Undo the applied edit; false when the document changed since (nothing is done then). */
  revert(): boolean;
};

/** Insert an edit of a drop / paste provider at the ranges (a snippet gets its tab stops when there is a single range). */
export function applyDocumentEdit(view: EditorView, ranges: Span[], edit: WireDocumentEdit, userEvent: string): AppliedDocumentEdit | null {
  const doc = view.state.doc;
  const steps: { changes: ChangeSet; before: Text }[] = [];
  const record = (tr: Transaction) => {
    if (tr.docChanged) steps.push({ changes: tr.changes, before: tr.startState.doc });
  };
  const applied = (): AppliedDocumentEdit => {
    let anchor = view.state.selection.main.to;
    for (const step of steps) step.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => (anchor = Math.max(anchor, toB)));
    const after = view.state.doc;
    return {
      anchor,
      revert() {
        if (!view.state.doc.eq(after)) return false;
        for (let index = steps.length - 1; index >= 0; index--) {
          const step = steps[index]!;
          // Changes are undone newest first, so each inverse sees the document it was made for.
          view.dispatch(view.state.update({ changes: step.changes.invert(step.before), userEvent: "undo" }));
        }
        return true;
      },
    };
  };
  const additional: ChangeSpec[] = edit.additional.map((entry: TextEdit) => ({
    from: offsetOf(doc, entry.startLine, entry.startCharacter),
    to: offsetOf(doc, entry.endLine, entry.endCharacter),
    insert: entry.snippet ? snippetToText(entry.newText) : entry.newText,
  }));
  const useSnippet = edit.snippet && ranges.length === 1;
  const insert = edit.snippet && !useSnippet ? snippetToText(edit.insertText) : edit.insertText;
  if (useSnippet) {
    let { from, to } = ranges[0]!;
    if (additional.length) {
      const changes = view.state.changes(additional);
      from = changes.mapPos(from, -1);
      to = changes.mapPos(to, 1);
      const tr = view.state.update({ changes, userEvent });
      view.dispatch(tr);
      record(tr);
    }
    // snippet() only reads the state and dispatches one transaction: capture it so the edit can be reverted.
    const target = {
      get state() {
        return view.state;
      },
      dispatch(tr: Transaction) {
        view.dispatch(tr);
        record(tr);
      },
    };
    snippet(snippetToTemplate(edit.insertText))(target as unknown as EditorView, null as unknown as Completion, from, to);
    return steps.length ? applied() : null;
  }
  const main: ChangeSpec[] = ranges.map((range) => ({ from: range.from, to: range.to, insert }));
  for (const changes of [[...main, ...additional], main]) {
    try {
      const set = view.state.changes(changes);
      const tr = view.state.update({
        changes: set,
        selection: EditorSelection.create(ranges.map((range) => EditorSelection.cursor(set.mapPos(range.to, 1))), ranges.length - 1),
        scrollIntoView: true,
        userEvent,
      });
      view.dispatch(tr);
      record(tr);
      return applied();
    } catch {
      // Overlapping additional edits: retry with the main edit alone.
    }
  }
  return null;
}

/* ── post-drop / post-paste widget ──────────────────────────────────────── */

type DropPasteWidgetState = {
  /** Offset right after the inserted text. */
  pos: number;
  /** "Drop" or "Paste": titles the widget and its close button. */
  label: string;
  active: number;
  options: { title: string; detail?: string }[];
  pick: (index: number) => void;
  dismiss: () => void;
};

const setDropPasteWidget = StateEffect.define<DropPasteWidgetState | null>();

/** VS Code style widget after a drop / paste: switch to another edit the providers offered. */
class DropPasteWidget extends WidgetType {
  readonly state: DropPasteWidgetState;

  constructor(state: DropPasteWidgetState) {
    super();
    this.state = state;
  }

  eq(other: DropPasteWidget) {
    return other.state === this.state;
  }

  toDOM() {
    const dom = document.createElement("span");
    dom.className = "cm-drop-paste-widget";
    dom.setAttribute("role", "toolbar");
    dom.setAttribute("aria-label", `${this.state.label} actions`);
    this.state.options.forEach((option, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cm-drop-paste-option";
      button.textContent = option.title;
      button.title = option.detail ? `${option.title} (${option.detail})` : option.title;
      if (index === this.state.active) {
        button.classList.add("active");
        button.setAttribute("aria-pressed", "true");
      }
      // Keep the editor selection where it was when the widget appeared.
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        if (index !== this.state.active) this.state.pick(index);
      });
      dom.append(button);
    });
    const close = document.createElement("button");
    close.type = "button";
    close.className = "cm-drop-paste-close";
    close.textContent = "×";
    close.title = `Hide ${this.state.label.toLowerCase()} actions`;
    close.setAttribute("aria-label", close.title);
    close.addEventListener("mousedown", (event) => event.preventDefault());
    close.addEventListener("click", () => this.state.dismiss());
    dom.append(close);
    return dom;
  }
}

const dropPasteWidgetField = StateField.define<DropPasteWidgetState | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setDropPasteWidget)) return effect.value;
    // An edit or a moved cursor makes the offer stale.
    return tr.docChanged || tr.selection ? null : value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => (value ? Decoration.set([Decoration.widget({ widget: new DropPasteWidget(value), side: 1 }).range(Math.max(0, value.pos))]) : Decoration.none)),
});

/** The edit's own host-side leftovers (files it creates, edits of other documents) run once the window applied it. */
function commit(api: ViewFeatureApi, edit: WireDocumentEdit): void {
  void api.requestHost("commitEdit", [edit.handle]).catch(() => undefined);
}

async function resolved(api: ViewFeatureApi, edit: WireDocumentEdit): Promise<WireDocumentEdit> {
  if (!edit.needsResolve) return edit;
  return (await api.requestHost<WireDocumentEdit | null>("resolveEdit", [edit.handle]).catch(() => null)) ?? edit;
}

/* ── clipboard / drag data ──────────────────────────────────────────────── */

const pathOf = (file: File): string | undefined => (file as File & { path?: string }).path || undefined;

async function fileItem(file: File): Promise<WireTransferItem> {
  const path = pathOf(file);
  let base64: string | undefined;
  if (file.size <= MAX_FILE_BYTES) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    base64 = btoa(binary);
  }
  return { mime: file.type || "application/octet-stream", file: { name: file.name, path, base64 } };
}

const fileUri = (path: string) => `file:///${path.replace(/\\/g, "/").split("/").filter((part) => part.length > 0).map((part) => encodeURIComponent(part)).join("/")}`;

/** Strings are read synchronously (the data store is only readable during the event); files are read later. */
function stringItems(data: DataTransfer): WireTransferItem[] {
  const items: WireTransferItem[] = [];
  for (const type of Array.from(data.types)) {
    if (type === "Files") continue;
    const value = data.getData(type);
    if (type === FILE_DRAG_TYPE) {
      items.push({ mime: "text/uri-list", value: fileUri(value) });
      continue;
    }
    items.push({ mime: type.toLowerCase(), value });
  }
  return items;
}

/** Everything the drop / paste providers may look for, with a file URI for the files whose path the window knows. */
async function transferItems(data: DataTransfer): Promise<WireTransferItem[]> {
  const items = stringItems(data);
  const files = Array.from(data.files);
  if (!files.length) return items;
  const uris = files.map(pathOf).filter((path): path is string => !!path).map(fileUri);
  if (uris.length && !items.some((item) => item.mime === "text/uri-list")) items.push({ mime: "text/uri-list", value: uris.join("\r\n") });
  items.push(...(await Promise.all(files.map(fileItem))));
  return items;
}

function transferTypes(data: DataTransfer): string[] {
  const types = Array.from(data.types).map((type) => (type === FILE_DRAG_TYPE ? "text/uri-list" : type));
  const files = Array.from(data.files);
  // Browsers hide the file list while dragging, so "Files" also stands for the URI list the window adds on drop.
  if (types.includes("Files") || files.some((file) => !!pathOf(file))) types.push("text/uri-list");
  types.push(...files.map((file) => file.type || "application/octet-stream"));
  return types;
}

/* ── drop and paste ─────────────────────────────────────────────────────── */

/** More than one edit: show the widget that lets the user replace the applied one (VS Code's drop / paste widget). */
function offerEdits(api: ViewFeatureApi, view: EditorView, ranges: Span[], edits: WireDocumentEdit[], active: number, userEvent: string, appliedEdit: AppliedDocumentEdit, label: string): void {
  if (edits.length < 2) return;
  const switchTo = (index: number) => {
    if (index === active) return;
    const chosen = edits[index];
    if (!chosen) return;
    void (async () => {
      if (!appliedEdit.revert()) {
        view.dispatch({ effects: setDropPasteWidget.of(null) });
        return;
      }
      const edit = await resolved(api, chosen);
      const next = applyDocumentEdit(view, ranges, edit, userEvent);
      commit(api, edit);
      if (next) offerEdits(api, view, ranges, edits, index, userEvent, next, label);
      view.focus();
    })();
  };
  view.dispatch({
    effects: setDropPasteWidget.of({
      pos: Math.min(appliedEdit.anchor, view.state.doc.length),
      label,
      active,
      options: edits.map((edit) => ({ title: edit.title || "Edit", detail: edit.kind })),
      pick: switchTo,
      dismiss: () => view.dispatch({ effects: setDropPasteWidget.of(null) }),
    }),
  });
}

function dropAndPaste(path: string, languageId: string, api: ViewFeatureApi): Extension {
  let internalDrag = false;
  let lastCopy: { text: string; id: Promise<number | null> } | null = null;

  const insertPlain = (view: EditorView, text: string, from: number, to: number, userEvent: string) => {
    if (!text) return;
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, scrollIntoView: true, userEvent });
  };

  return EditorView.domEventHandlers({
    dragstart() {
      internalDrag = true;
      return false;
    },
    dragend() {
      internalDrag = false;
      return false;
    },
    dragover(event) {
      const accepted = availabilityFor(api, path, languageId)?.drop;
      if (!internalDrag && accepted && event.dataTransfer && mimeAccepted(accepted, transferTypes(event.dataTransfer), event.dataTransfer.files.length > 0)) event.preventDefault();
      return false;
    },
    drop(event, view) {
      const inside = internalDrag;
      internalDrag = false;
      const accepted = availabilityFor(api, path, languageId)?.drop;
      const data = event.dataTransfer;
      if (inside || !accepted || !data || !mimeAccepted(accepted, transferTypes(data), data.files.length > 0)) return false;
      event.preventDefault();
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
      const plain = data.getData("text/plain");
      const doc = view.state.doc;
      void (async () => {
        let edits: WireDocumentEdit[] = [];
        try {
          const items = await transferItems(data);
          const line = doc.lineAt(pos);
          edits = await withTimeout(api.requestHost<WireDocumentEdit[]>("dropEdits", [path, line.number - 1, pos - line.from, items]), HOST_TIMEOUT);
        } catch {
          edits = [];
        }
        // The document changed while the host was thinking: the position no longer means the same.
        const stale = view.state.doc !== doc;
        const target = stale ? view.state.selection.main.head : pos;
        if (edits[0]) {
          const edit = await resolved(api, edits[0]);
          const ranges = [{ from: target, to: target }];
          const appliedEdit = applyDocumentEdit(view, ranges, edit, "input.drop");
          commit(api, edit);
          if (appliedEdit) offerEdits(api, view, ranges, edits, 0, "input.drop", appliedEdit, "Drop");
        } else insertPlain(view, plain, target, target, "input.drop");
        view.focus();
      })();
      return true;
    },
    copy(_event, view) {
      return rememberCopy(view);
    },
    cut(_event, view) {
      return rememberCopy(view);
    },
    paste(event, view) {
      const accepted = availabilityFor(api, path, languageId)?.paste;
      const data = event.clipboardData;
      if (!accepted || !data || !mimeAccepted(accepted, transferTypes(data), data.files.length > 0)) return false;
      event.preventDefault();
      const text = data.getData("text/plain");
      const doc = view.state.doc;
      const ranges = view.state.selection.ranges.map((range) => ({ from: range.from, to: range.to }));
      void (async () => {
        let edits: WireDocumentEdit[] = [];
        try {
          const items = await transferItems(data);
          const copyId = lastCopy && lastCopy.text === text ? await lastCopy.id : null;
          edits = await withTimeout(api.requestHost<WireDocumentEdit[]>("pasteEdits", [path, ranges.map((range) => toRange(doc, range.from, range.to)), items, { copyId, triggerKind: 0 }]), HOST_TIMEOUT);
        } catch {
          edits = [];
        }
        const stale = view.state.doc !== doc;
        const target = stale ? view.state.selection.ranges.map((range) => ({ from: range.from, to: range.to })) : ranges;
        if (edits[0]) {
          const edit = await resolved(api, edits[0]);
          const appliedEdit = applyDocumentEdit(view, target, edit, "input.paste");
          commit(api, edit);
          if (appliedEdit) offerEdits(api, view, target, edits, 0, "input.paste", appliedEdit, "Paste");
        } else if (text) {
          view.dispatch({ ...view.state.replaceSelection(text), scrollIntoView: true, userEvent: "input.paste" });
        }
      })();
      return true;
    },
  });

  function rememberCopy(view: EditorView): boolean {
    if (!availabilityFor(api, path, languageId)?.copy) return false;
    const { state } = view;
    const selected = state.selection.ranges.filter((range) => !range.empty);
    if (!selected.length) return false;
    const text = selected.map((range) => state.sliceDoc(range.from, range.to)).join(state.lineBreak);
    const ranges = selected.map((range) => toRange(state.doc, range.from, range.to));
    lastCopy = { text, id: api.requestHost<number | null>("preparePaste", [path, ranges]).catch(() => null) };
    return false;
  }
}

/* ── "Paste As…" ────────────────────────────────────────────────────────── */

/** editor.action.pasteAs: ask the paste providers again with the PasteAs trigger and let the user pick an edit. */
export async function pasteAs(api: ViewFeatureApi, view: EditorView, path: string, only?: string): Promise<void> {
  const items: WireTransferItem[] = [];
  try {
    for (const entry of await navigator.clipboard.read()) {
      for (const type of entry.types) {
        const blob = await entry.getType(type);
        if (type.startsWith("text/")) items.push({ mime: type, value: await blob.text() });
        else items.push(await fileItem(new File([blob], "clipboard", { type })));
      }
    }
  } catch {
    const text = await navigator.clipboard.readText().catch(() => "");
    if (text) items.push({ mime: "text/plain", value: text });
  }
  if (!items.length) return void api.showMessage("info", "The clipboard is empty.");
  const doc = view.state.doc;
  const ranges = view.state.selection.ranges.map((range) => ({ from: range.from, to: range.to }));
  const edits = await api
    .requestHost<WireDocumentEdit[]>("pasteEdits", [path, ranges.map((range) => toRange(doc, range.from, range.to)), items, { triggerKind: 1, only }])
    .catch(() => [] as WireDocumentEdit[]);
  const plain = items.find((item) => item.mime === "text/plain")?.value;
  const choices = [...edits.map((edit) => ({ label: edit.title, detail: edit.kind })), ...(plain !== undefined ? [{ label: "Insert as plain text" }] : [])];
  if (!choices.length) return void api.showMessage("info", "No paste actions are available for the clipboard contents.");
  const picked = (await api.showQuickPick(choices, { title: "Paste As…", placeholder: "Select a paste action" }))?.[0];
  if (picked === undefined) return;
  if (view.state.doc !== doc) return;
  const chosen = edits[picked];
  if (chosen) {
    const edit = await resolved(api, chosen);
    const appliedEdit = applyDocumentEdit(view, ranges, edit, "input.paste");
    commit(api, edit);
    if (appliedEdit) offerEdits(api, view, ranges, edits, picked, "input.paste", appliedEdit, "Paste");
  } else if (plain !== undefined) applyDocumentEdit(view, ranges, { handle: 0, title: "", insertText: plain, snippet: false, additional: [] }, "input.paste");
  view.focus();
}

/* ── entry point ────────────────────────────────────────────────────────── */

/** Remembers the focused editor, so the commands (Show Call Hierarchy, Paste As) know where to act. */
function trackEditor(path: string, languageId: string): Extension {
  return ViewPlugin.fromClass(
    class {
      readonly view: EditorView;
      constructor(view: EditorView) {
        this.view = view;
        setLastEditor({ view, path, languageId });
      }
      update(update: ViewUpdate) {
        if ((update.focusChanged && update.view.hasFocus) || update.selectionSet) setLastEditor({ view: update.view, path, languageId });
      }
      destroy() {
        clearLastEditor(this.view);
      }
    },
  );
}

export function languagesExtraEditorExtensions(path: string, languageId: string, api: ViewFeatureApi): Extension[] {
  // Prefetch what the providers can do for this document.
  availabilityFor(api, path, languageId);
  return [trackEditor(path, languageId), inlineValueField, inlineValuesPlugin(path, languageId, api), evaluateHover(path, api), dropAndPaste(path, languageId, api), dropPasteWidgetField];
}
