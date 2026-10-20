import { Prec, StateEffect, StateField, type EditorState, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type ViewUpdate } from "@codemirror/view";
import { completionStatus } from "@codemirror/autocomplete";
import type { HostInlineCompletionItem } from "../../shared/extensions";
import { extensionService } from "./extensions";

/**
 * Inline completions from extensions
 * (languages.registerInlineCompletionItemProvider): after typing pauses, the
 * first item is shown as ghost text at the cursor. Tab accepts it (replacing
 * the item's range, or inserting at the cursor) and runs its command; Escape
 * or moving the cursor dismisses it; Alt+] / Alt+[ cycle the items. Tab is
 * only taken while ghost text is visible and the completion popup is closed,
 * so indentation and completions keep working.
 */

type InlineState = {
  items: HostInlineCompletionItem[];
  index: number;
  /** The cursor offset the items were requested at. */
  pos: number;
  /** The document text at the time of the request. */
  text: string;
};

const DELAY = 300;

/** Invoke an inline completion provider (0), or ask automatically while typing (1). */
const AUTOMATIC = 1;

const setInlineCompletion = StateEffect.define<InlineState | null>();

const inlineCompletionField = StateField.define<InlineState | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setInlineCompletion)) return effect.value;
    if (!value) return null;
    // Any edit, undo or explicit cursor move makes the ghost text stale.
    if (tr.docChanged || tr.selection) return null;
    return value;
  },
});

/** Offset of a 0-based line / character in a document (clamped). */
function offset(doc: Text, line: number, character: number): number {
  const target = doc.line(Math.min(Math.max(1, line + 1), doc.lines));
  return Math.min(target.from + Math.max(0, character), target.to);
}

type Placement = { item: HostInlineCompletionItem; from: number; to: number; pos: number; ghost: string };

/** Where the active item would be inserted, and the part not typed yet. */
function placement(state: EditorState, active: InlineState): Placement | null {
  const item = active.items[active.index];
  if (!item) return null;
  const doc = state.doc;
  let from = active.pos;
  let to = active.pos;
  if (item.range) {
    const start = offset(doc, item.range.startLine, item.range.startCharacter);
    const end = offset(doc, item.range.endLine, item.range.endCharacter);
    from = Math.min(start, end);
    to = Math.max(start, end);
  }
  // Providers often repeat what is already there: only the rest is ghost text.
  const typed = active.pos >= from && active.pos <= to ? doc.sliceString(from, active.pos) : "";
  const ghost = typed && item.insertText.startsWith(typed) ? item.insertText.slice(typed.length) : item.insertText;
  return { item, from, to, pos: active.pos, ghost };
}

class GhostText extends WidgetType {
  readonly text: string;
  constructor(text: string) {
    super();
    this.text = text;
  }
  eq(other: GhostText) {
    return other.text === this.text;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-inline-completion-ghost";
    span.textContent = this.text;
    return span;
  }
  ignoreEvent() {
    return true;
  }
}

/** The visible ghost text of a state, if any (the completion popup hides it). */
function visiblePlacement(state: EditorState): Placement | null {
  const active = state.field(inlineCompletionField, false);
  if (!active || completionStatus(state) === "active") return null;
  const place = placement(state, active);
  return place && place.ghost ? place : null;
}

/** Tab: replace the item's range (or insert at the cursor) as one change. */
function accept(view: EditorView): boolean {
  const active = view.state.field(inlineCompletionField, false);
  const place = visiblePlacement(view.state);
  if (!active || !place || active.text !== view.state.doc.toString()) return false;
  const item = place.item;
  const cursor = place.from + item.insertText.length;
  view.dispatch({
    changes: { from: place.from, to: place.to, insert: item.insertText },
    selection: { anchor: cursor },
    effects: setInlineCompletion.of(null),
    userEvent: "input.complete",
  });
  if (item.command) extensionService.executeCommand(item.command.command, item.command.arguments ?? []);
  return true;
}

function dismiss(view: EditorView): boolean {
  if (!visiblePlacement(view.state)) return false;
  view.dispatch({ effects: setInlineCompletion.of(null) });
  return true;
}

/** Alt+] / Alt+[: show the next / previous item. */
function cycle(view: EditorView, delta: number): boolean {
  const active = view.state.field(inlineCompletionField, false);
  if (!active || active.items.length < 2) return false;
  if (!visiblePlacement(view.state)) return false;
  const index = (active.index + delta + active.items.length) % active.items.length;
  view.dispatch({ effects: setInlineCompletion.of({ ...active, index }) });
  return true;
}

/** The document inline completions are asked for (null when none is shown). */
export type InlineCompletionSource = () => { path: string; language: string } | null;

export function inlineCompletionExtension(source: InlineCompletionSource): Extension {
  return [
    inlineCompletionField,
    // A function of the view, so the ghost also disappears when the completion popup opens.
    EditorView.decorations.of((view) => {
      const place = visiblePlacement(view.state);
      if (!place) return Decoration.none;
      return Decoration.set([Decoration.widget({ widget: new GhostText(place.ghost), side: 1 }).range(place.pos)]);
    }),
    Prec.high(
      keymap.of([
        { key: "Tab", run: accept },
        { key: "Escape", run: dismiss },
        { key: "Alt-]", run: (view) => cycle(view, 1) },
        { key: "Alt-[", run: (view) => cycle(view, -1) },
      ]),
    ),
    ViewPlugin.fromClass(
      class {
        readonly view: EditorView;
        timer: ReturnType<typeof setTimeout> | null = null;
        /** Requests of an older sequence must not show up. */
        sequence = 0;

        constructor(view: EditorView) {
          this.view = view;
        }

        destroy() {
          if (this.timer) clearTimeout(this.timer);
          this.sequence++;
        }

        /** Forget pending work (and a request already on its way). */
        reset() {
          if (this.timer) clearTimeout(this.timer);
          this.timer = null;
          this.sequence++;
        }

        /** Ask once the user stops typing (like VS Code's inline suggest delay). */
        schedule() {
          if (this.timer) clearTimeout(this.timer);
          this.timer = setTimeout(() => {
            this.timer = null;
            void this.request();
          }, DELAY);
        }

        async request() {
          const target = source();
          const view = this.view;
          if (!target || !view.dom.isConnected) return;
          if (!extensionService.providersFor("inlineCompletion", target.path, target.language).length) return;
          const head = view.state.selection.main.head;
          const line = view.state.doc.lineAt(head);
          const text = view.state.doc.toString();
          const id = ++this.sequence;
          let items: HostInlineCompletionItem[];
          try {
            items = await extensionService.call("provideInlineCompletions", target.path, line.number - 1, head - line.from, AUTOMATIC);
          } catch {
            return;
          }
          if (this.sequence !== id || !view.dom.isConnected) return;
          if (view.state.doc.toString() !== text || view.state.selection.main.head !== head) return;
          // The completion popup has its own list; do not show ghost text under it.
          if (completionStatus(view.state) === "active") return;
          const current = source();
          if (!current || current.path !== target.path) return;
          const valid = items.filter((item) => typeof item?.insertText === "string" && item.insertText.length > 0);
          if (valid.length) view.dispatch({ effects: setInlineCompletion.of({ items: valid, index: 0, pos: head, text }) });
        }

        update(update: ViewUpdate) {
          if (completionStatus(update.state) === "active") {
            this.reset();
            return;
          }
          if (update.docChanged) {
            // Typing or deleting asks again; undo / a programmatic edit dismisses.
            if (!update.transactions.some((tr) => tr.isUserEvent("input") || tr.isUserEvent("delete"))) {
              this.reset();
              return;
            }
            this.reset();
            this.schedule();
            return;
          }
          if (update.selectionSet) this.reset();
        }
      },
    ),
  ];
}
